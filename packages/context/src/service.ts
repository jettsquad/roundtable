/**
 * service.ts — `ctx.teamContext`: what each seat sees this round.
 *
 * The plugin injects `teams` and registers itself on the table. The arrow runs
 * one way only: the table never injects this service, because two services
 * that inject each other cannot both start. A table with nobody registered
 * hands its seats an empty window — stage 1's behaviour, still runnable.
 *
 * The team record lives in two places and this is where they are rejoined:
 * speech in the host session log, checkpoints in the `squad_teams` storage
 * domain (see domain.ts for why). The merge is deliberately confined to
 * `mergedStream` — if dsh ever opens the event registration surface, that one
 * function is what changes.
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import type { Domain } from "@deepseek-ai/dsh-storage-domain";
import { accumulatedTokens, evaluateThreshold, thresholdTokensFor, type ThresholdDecision } from "@squad/shared";
import { SQUAD_TEAMS_DOMAIN, type CheckpointRecord } from "./domain.ts";
import { mergeCheckpoints } from "./merge.ts";
import { planFold } from "./plan.ts";
import { renderTimeline } from "./timeline.ts";
import { CHECKPOINT_KIND, selectContextEvents, type SelectableEvent } from "./window.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    teamContext: TeamContextService;
  }
}

/** What the host is told when recording a checkpoint the secretary wrote. */
export interface RecordCheckpointInput {
  readonly teamId: string;
  readonly text: string;
  /** Identity of the last recorded entry this checkpoint summarises. */
  readonly coversUpTo: string;
  /**
   * Already retired when it arrived — only ever set by the 1.x migration,
   * which restores checkpoints the host had revoked. Dropping their
   * revocation would silently reinstate boundaries the host had rejected,
   * which is worse than not migrating them at all: the team would come back
   * with history cut at a point its owner had already overruled.
   */
  readonly revokedAt?: number | undefined;
}

export class TeamContextService extends Service {
  static readonly inject = ["teams", "storageDomain", "secretary"];

  private domain: Domain<typeof SQUAD_TEAMS_DOMAIN> | undefined;
  /** Teams whose fold is running. A second would cover the same ground. */
  private readonly folding = new Set<string>();
  /**
   * Artifact writes still in flight.
   *
   * `artifactWritten` returns void so the table never waits on storage, but a
   * fold that starts before the write lands reads an empty artifact list and
   * asks the secretary to index nothing — producing a checkpoint whose 產出
   * index says 「无」 while the file sits on disk. Non-blocking for the
   * writer, drained by the reader.
   */
  private artifactWrites: Promise<unknown> = Promise.resolve();

  constructor(ctx: Context) {
    super(ctx, "teamContext");
  }

  /**
   * Cordis runs this after construction; both resources are released through
   * `ctx.effect`, so an unmount tears them down in reverse order without a
   * separate stop hook. The domain handle is ours to close — the facility does
   * not tie it to any consumer fiber.
   */
  async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(SQUAD_TEAMS_DOMAIN);
    this.domain = domain;
    this.ctx.effect(() => async () => {
      this.domain = undefined;
      await domain.close();
    });
    const release = this.ctx.teams.useAssembler({
      windowFor: (teamId, seatId) => this.windowFor(teamId, seatId),
      roundEnded: (teamId) => this.onRoundEnded(teamId),
      artifactWritten: (teamId, path) => this.onArtifactWritten(teamId, path),
    });
    this.ctx.effect(() => release);
  }

  /**
   * The lines this seat is shown this round.
   *
   * `seatId` is accepted and currently unused: every seat sees the same
   * window. It is in the signature because per-seat windows are the point of
   * `contextMode: independent`, and changing a service's shape later is a
   * worse cost than carrying an honest parameter now.
   */
  async windowFor(teamId: string, _seatId: string): Promise<readonly string[]> {
    return renderTimeline(selectContextEvents(this.mergedStream(teamId)));
  }

  /** Store a checkpoint the secretary wrote. */
  async record(input: RecordCheckpointInput): Promise<CheckpointRecord> {
    const checkpointId = `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const record: CheckpointRecord = {
      teamId: input.teamId,
      checkpointId,
      text: input.text,
      coversUpTo: input.coversUpTo,
      createdAt: Date.now(),
      ...(input.revokedAt === undefined ? {} : { revokedAt: input.revokedAt }),
    };
    await this.checkpoints().put(checkpointId, record);
    return record;
  }

  /**
   * Retire a checkpoint the host was not happy with.
   *
   * Marked, never deleted: the window falls back to the previous checkpoint or
   * to the whole discussion, but the text stays readable. This is also what
   * makes automatic folding safe to do without asking first — a wrong fold can
   * be undone, so the machine may propose and the human still decides.
   */
  async revoke(teamId: string, checkpointId: string): Promise<void> {
    const table = this.checkpoints();
    const found = table.get(checkpointId);
    if (found === undefined || found.teamId !== teamId) {
      throw new Error(`团队 ${teamId} 下没有检查点 ${checkpointId}。`);
    }
    if (found.revokedAt !== undefined) return;
    await table.update(checkpointId, (current) => ({ ...current, revokedAt: Date.now() }));
  }

  /** How much has accumulated since the last live checkpoint, against its limit. */
  /**
   * How much has accumulated since the last live checkpoint, against its
   * limit — and, when it is over the limit and still not folding, why not.
   *
   * The two hold reasons are reported rather than hardcoded away. "Over the
   * limit and doing nothing" is a normal state (the team is mid-round, or a
   * fold is already running) and it needs to be distinguishable from the
   * trigger being broken.
   */
  progress(teamId: string, coefficient?: number): ThresholdDecision {
    const team = this.ctx.teams.get(teamId);
    return evaluateThreshold({
      contents: this.sinceLastCheckpoint(teamId).map((event) => ({ text: textOf(event) })),
      coefficient: coefficient ?? team?.checkpointCoefficient,
      checkpointInFlight: this.folding.has(teamId),
      teamBusy: team?.busy ?? false,
    });
  }

  /**
   * Whether the secretary is writing a checkpoint for this team right now.
   *
   * Asked directly rather than read off `progress().holdReason`. That field
   * has a precedence — below-threshold wins — so a MANUAL fold started under
   * the limit reported `below-threshold` while it ran, and a screen deriving
   * "is it folding" from it said no throughout. The set is the fact; the
   * decision is a summary of several facts, and summarising is where they get
   * lost.
   */
  isFolding(teamId: string): boolean {
    return this.folding.has(teamId);
  }

  /** The limit `progress` compares against, for a team's coefficient. */
  limitFor(coefficient?: number): number {
    return thresholdTokensFor(coefficient);
  }

  /** Estimated tokens accumulated since the last live checkpoint. */
  accumulated(teamId: string): number {
    return accumulatedTokens(this.sinceLastCheckpoint(teamId).map((event) => ({ text: textOf(event) })));
  }

  /**
   * Remember a file the team wrote, so the next checkpoint can index it.
   *
   * Fire-and-forget from the table's side, which means nothing is waiting to
   * hear that it failed. A lost path does not break the fold — it produces a
   * checkpoint whose index silently omits a file that exists — so the failure
   * is logged rather than swallowed.
   */
  private onArtifactWritten(teamId: string, path: string): void {
    const write = this.artifacts()
      .put(`${teamId}:${path}`, { teamId, path, writtenAt: Date.now() })
      .catch((error: unknown) => {
        this.ctx.logger.warn(
          `团队 ${teamId}：产出路径 ${path} 没记下来，下一份检查点的产出索引会漏掉它：` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      });
    // Chained, not awaited: the caller returns immediately, and a later fold
    // waits for this instead.
    this.artifactWrites = this.artifactWrites.then(() => write);
  }

  /**
   * Record a file the team wrote, when nothing is running to report it.
   *
   * The live path is the table telling the assembler as it writes. This is
   * for the 1.x migration, which is restoring files that were written long
   * ago: without it a migrated team's next checkpoint would index nothing
   * while the files sit in the project folder, and the index would be wrong
   * in the direction that looks like "there were no outputs".
   */
  async recordArtifact(teamId: string, path: string): Promise<void> {
    await this.artifacts().put(`${teamId}:${path}`, { teamId, path, writtenAt: Date.now() });
  }

  /** Files this team has written, in the order they were written. */
  artifactsOf(teamId: string): readonly string[] {
    return [...this.artifacts().entries()]
      .map(([, record]) => record)
      .filter((record) => record.teamId === teamId)
      .sort((a, b) => a.writtenAt - b.writtenAt)
      .map((record) => record.path);
  }

  /**
   * A round ended. Fold if the record has grown past this team's limit.
   *
   * Returns void and never rejects. Crossing the threshold must not make the
   * team wait — 1.x made the secretary blocking once and the team sat idle
   * watching it write — so this starts the work and returns. Which means
   * nothing is awaiting the result, and a failure here has no caller to
   * surface it: it has to report itself or vanish.
   */
  private onRoundEnded(teamId: string): void {
    void this.maybeFold(teamId).catch((error: unknown) => {
      this.ctx.logger.error(
        `团队 ${teamId}：自动折叠失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    });
  }

  /**
   * Fold when the accumulated record crosses the limit and the team is idle.
   *
   * Idle, not merely "crossed": the secretary reads the record while writing,
   * and starting mid-round would record a boundary with work still in flight.
   * Round end is that idle moment. A team that keeps talking simply crosses
   * again at the next round end.
   */
  private async maybeFold(teamId: string): Promise<void> {
    const team = this.ctx.teams.get(teamId);
    if (team === undefined) return;
    // One place decides. `evaluateThreshold` already holds for a fold in
    // flight and for a busy team, so guarding again here would put the same
    // decision in two places, where they can drift apart.
    if (!this.progress(teamId).crossed) return;
    await this.fold(teamId);
  }

  /**
   * Fold this team's discussion into a checkpoint, now.
   *
   * `coversUpTo` is taken BEFORE the secretary starts, and it names the last
   * entry that exists at this instant. The secretary writes without stopping
   * the team, so rounds can land while it works and end up recorded before
   * the checkpoint is stored — turns it never saw. Naming the boundary up
   * front means those turns travel whole instead of being cut away by a
   * document that does not mention them.
   *
   * The turns fed in are "since the last checkpoint", not "the window". Those
   * differ, and taking the window would make each checkpoint's input depend
   * on the previous checkpoint's own output — losses compounding once per
   * fold.
   */
  async fold(teamId: string): Promise<CheckpointRecord> {
    const team = this.ctx.teams.get(teamId);
    if (team === undefined) throw new Error(`没有这支团队：${teamId}。`);
    if (this.folding.has(teamId)) throw new Error(`团队 ${teamId} 正在折叠中。`);

    this.folding.add(teamId);
    try {
      // Drain first. The index may only list files that were really written,
      // and a write still in flight is a file that exists on disk and not yet
      // in the table — which would produce an index saying 「无」 next to a
      // file the team can see.
      await this.artifactWrites;
      const plan = planFold(this.sinceLastCheckpoint(teamId), this.liveCheckpoint(teamId)?.text);
      if (plan === undefined) throw new Error(`团队 ${teamId} 没有可折叠的记录。`);

      const text = await this.ctx.secretary.writeCheckpoint({
        parent: team.host,
        // The designated secretary's standing instructions AND the provider
        // it runs on. The persona was passed from the start; the provider was
        // not, so the secretary's model, connection and permission mode were
        // stored, rendered in the Agent library, and ignored — the folding
        // ran on the host's bare login instead. Configuring a secretary and
        // having the configuration do nothing is worse than not offering it.
        ...(team.secretary === undefined ? {} : { secretary: team.secretary }),
        hostGoal: team.displayName,
        previousCheckpoint: plan.previousCheckpoint,
        turns: plan.turns,
        // Supplied by the program, never left to the transcript. Without them
        // the secretary invents plausible paths for the index, and an
        // invented path is worse than an empty one: a later agent follows it
        // and finds nothing.
        artifactPaths: this.artifactsOf(teamId),
      });
      return await this.record({ teamId, text, coversUpTo: plan.coversUpTo });
    } finally {
      this.folding.delete(teamId);
    }
  }

  /** The newest checkpoint still standing, or none. */
  /**
   * The checkpoint currently standing in for the earlier discussion.
   *
   * Public because a surface has to be able to SHOW it. A fold that happens
   * invisibly is a discussion that silently stops being what the seats read —
   * and when a later answer looks wrong, nothing on screen says the record it
   * was built from had been replaced by a summary.
   */
  currentCheckpoint(teamId: string): CheckpointRecord | undefined {
    return this.liveCheckpoint(teamId);
  }

  /** Every checkpoint this team has, newest first, revoked ones included. */
  checkpointHistory(teamId: string): readonly CheckpointRecord[] {
    return [...this.checkpointsOf(teamId)].sort((a, b) => b.createdAt - a.createdAt);
  }

  private liveCheckpoint(teamId: string): CheckpointRecord | undefined {
    const live = this.checkpointsOf(teamId).filter((record) => record.revokedAt === undefined);
    return live[live.length - 1];
  }

  /** The team record as one ordered stream; the two-homes seam is `mergeCheckpoints`. */
  private mergedStream(teamId: string): readonly SelectableEvent[] {
    const team = this.ctx.teams.get(teamId);
    if (team === undefined) throw new Error(`没有这支团队：${teamId}。`);
    return mergeCheckpoints(team.transcript(), this.checkpointsOf(teamId));
  }

  /** Recorded entries after the newest live checkpoint's coverage. */
  private sinceLastCheckpoint(teamId: string): readonly SelectableEvent[] {
    const stream = this.mergedStream(teamId);
    return selectContextEvents(stream).filter((event) => event.kind !== CHECKPOINT_KIND);
  }

  private checkpointsOf(teamId: string): readonly CheckpointRecord[] {
    return [...this.checkpoints().entries()]
      .map(([, record]) => record)
      .filter((record) => record.teamId === teamId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  private checkpoints() {
    return this.open().table("checkpoints");
  }

  private artifacts() {
    return this.open().table("artifacts");
  }

  private open(): Domain<typeof SQUAD_TEAMS_DOMAIN> {
    if (this.domain === undefined) throw new Error("上下文装配器尚未启动（storage domain 未打开）。");
    return this.domain;
  }
}

/** `SelectableEvent.text` is `unknown` by design — the window layer never reads it. */
const textOf = (event: SelectableEvent): string => (typeof event.text === "string" ? event.text : "");
