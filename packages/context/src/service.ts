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
}

export class TeamContextService extends Service {
  static readonly inject = ["teams", "storageDomain", "secretary"];

  private domain: Domain<typeof SQUAD_TEAMS_DOMAIN> | undefined;
  /** Teams whose fold is running. A second would cover the same ground. */
  private readonly folding = new Set<string>();

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

  /** The limit `progress` compares against, for a team's coefficient. */
  limitFor(coefficient?: number): number {
    return thresholdTokensFor(coefficient);
  }

  /** Estimated tokens accumulated since the last live checkpoint. */
  accumulated(teamId: string): number {
    return accumulatedTokens(this.sinceLastCheckpoint(teamId).map((event) => ({ text: textOf(event) })));
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
      const plan = planFold(this.sinceLastCheckpoint(teamId), this.liveCheckpoint(teamId)?.text);
      if (plan === undefined) throw new Error(`团队 ${teamId} 没有可折叠的记录。`);

      const text = await this.ctx.secretary.writeCheckpoint({
        parent: team.host,
        hostGoal: team.displayName,
        previousCheckpoint: plan.previousCheckpoint,
        turns: plan.turns,
      });
      return await this.record({ teamId, text, coversUpTo: plan.coversUpTo });
    } finally {
      this.folding.delete(teamId);
    }
  }

  /** The newest checkpoint still standing, or none. */
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
    if (this.domain === undefined) throw new Error("上下文装配器尚未启动（storage domain 未打开）。");
    return this.domain.table("checkpoints");
  }
}

/** `SelectableEvent.text` is `unknown` by design — the window layer never reads it. */
const textOf = (event: SelectableEvent): string => (typeof event.text === "string" ? event.text : "");
