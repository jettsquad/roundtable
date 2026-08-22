/**
 * seat-status.ts — turning a seat's numbers into a sentence a person can act on.
 *
 * A pure function, on purpose. "Is this agent working?" is a JUDGEMENT, and
 * the judgement is the part that was missing — `running: true` is a fact
 * about a promise, equally true of a model composing a long answer and of a
 * CLI pointed at an endpoint that will never reply. Everything below decides
 * between those two from the bytes, and being pure is what lets that decision
 * be tested instead of eyeballed in a browser.
 *
 * The thresholds arrive as data rather than being written here, because the
 * runtime owns them: a screen that names a number the watchdog does not use
 * is worse than one that names none.
 */

/** What a seat is doing, coarsely enough to colour. */
export type SeatPhase =
  /** Cannot run at all — misconfigured, no connection, over a cap. */
  | "blocked"
  /** Not in this round. */
  | "idle"
  /** Started, nothing back yet, still well within the deadline. */
  | "starting"
  /** Producing output right now. */
  | "streaming"
  /** Has spoken, but nothing recently. Normal for a model that is thinking. */
  | "quiet"
  /** Silent long enough that it is probably not coming back. */
  | "stalling";

export interface SeatStatus {
  readonly phase: SeatPhase;
  /** Short enough for a badge. */
  readonly label: string;
  /** The line under it, when there is more to say. */
  readonly detail?: string | undefined;
}

/** How long output may pause before it is worth mentioning, in ms. */
const QUIET_AFTER_MS = 12_000;

/** Fraction of a deadline after which the countdown is said out loud. */
const WARN_AT = 0.4;

function seconds(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  return total % 60 === 0 ? `${minutes} 分钟` : `${minutes} 分 ${total % 60} 秒`;
}

/** Bytes, at the precision a person reads rather than the one a machine stores. */
export function volume(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface SeatStatusInput {
  readonly running: boolean;
  /** Why it cannot run, when it cannot. */
  readonly blocked?: string | undefined;
  readonly activity?: { readonly startedAt: number; readonly bytes: number; readonly lastOutputAt: number } | undefined;
  /** The runtime's own thresholds. */
  readonly silence: { readonly idleMs: number; readonly firstOutputMs: number };
  readonly now: number;
}

/**
 * What to show for one seat.
 *
 * Ordered by what overrides what: a blocked seat is blocked whatever else is
 * true, and a seat that is not running has no activity worth describing even
 * if a stale entry says otherwise.
 */
export function describeSeat(input: SeatStatusInput): SeatStatus {
  if (input.blocked !== undefined) return { phase: "blocked", label: "跑不了", detail: input.blocked };
  if (!input.running) return { phase: "idle", label: "待命" };

  const activity = input.activity;
  if (activity === undefined) {
    // Running, but the backend reports no progress. Said plainly rather than
    // dressed up as streaming: claiming output that was never observed is the
    // exact failure this whole display exists to end.
    return { phase: "starting", label: "已派发", detail: "这个后端不上报进度，只能看到它还没结束。" };
  }

  const waited = input.now - activity.startedAt;
  if (activity.bytes === 0) {
    const left = input.silence.firstOutputMs - waited;
    return {
      phase: waited >= input.silence.firstOutputMs * WARN_AT ? "stalling" : "starting",
      label: `启动中 ${seconds(waited)}`,
      detail:
        waited >= input.silence.firstOutputMs * WARN_AT
          ? `一个字都还没输出，再过${seconds(Math.max(0, left))}就按连不上处理。`
          : undefined,
    };
  }

  const quiet = input.now - activity.lastOutputAt;
  if (quiet < QUIET_AFTER_MS) {
    return { phase: "streaming", label: "正在输出", detail: `已产出 ${volume(activity.bytes)}` };
  }
  const left = input.silence.idleMs - quiet;
  return {
    phase: quiet >= input.silence.idleMs * WARN_AT ? "stalling" : "quiet",
    label: `思考中 ${seconds(quiet)}`,
    detail: `已产出 ${volume(activity.bytes)}，${seconds(quiet)}没有新输出；再静默${seconds(Math.max(0, left))}会判定卡死。`,
  };
}

/** One line for the whole team, for the strip above the composer. */
export function describeTeam(
  seats: readonly { readonly displayName: string; readonly status: SeatStatus }[],
): string | undefined {
  const busy = seats.filter((seat) => seat.status.phase !== "idle" && seat.status.phase !== "blocked");
  if (busy.length === 0) return undefined;
  // Named individually rather than counted: "3 个席位在跑" is a number, and
  // the question people actually have is which one is holding things up.
  return busy.map((seat) => `${seat.displayName}（${seat.status.label}）`).join("，");
}
