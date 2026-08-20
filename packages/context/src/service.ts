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
  static readonly inject = ["teams", "storageDomain"];

  private domain: Domain<typeof SQUAD_TEAMS_DOMAIN> | undefined;

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
    const release = this.ctx.teams.useContextSource((teamId, seatId) => this.windowFor(teamId, seatId));
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
  progress(teamId: string, coefficient?: number): ThresholdDecision {
    const contents = this.sinceLastCheckpoint(teamId).map((event) => ({ text: textOf(event) }));
    return evaluateThreshold({
      contents,
      coefficient,
      checkpointInFlight: false,
      teamBusy: false,
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
