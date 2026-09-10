/**
 * heartbeat.ts — the plugin that runs INSIDE a dsh seat and says it is alive.
 *
 * Loaded into the child's own plugin tree, not this one: the parent cannot
 * see whether a model is producing tokens, and the child is the only place
 * that knows. It gets there through the `--patch` overlay `seat-dsh` already
 * writes for every run (the one that tells the child which endpoint to use),
 * named by absolute path — measured to work, so no profile has to be
 * installed anywhere.
 *
 * WHY this exists rather than a longer deadline: the watchdog decides a seat
 * is gone by watching its output stop, and `dsh --profile headless` writes
 * nothing at all until the turn is over. Raising the deadline would only make
 * a person wait longer to learn nothing. This makes the silence mean what the
 * watchdog thinks it means.
 *
 * The signal is WORK, never a clock. Every line here is caused by a session
 * event — a token arriving, a tool starting, a step ending. A timer would
 * keep a wedged child alive indefinitely, which is a worse bug than the one
 * being fixed, so there is deliberately no timer in this file.
 */
import type { Context } from "@deepseek-ai/cordis";

/** Stable Cordis plugin name. */
export const name = "squad-seat-heartbeat";

/**
 * The prefix every line carries.
 *
 * Its own copy of `@squad/seat-runtime`'s `SEAT_ALIVE_PREFIX` rather than an
 * import: this module is loaded by ANOTHER process, and importing the runtime
 * package there would pull the whole subagent machinery into a seat's child
 * for one string. `heartbeat.test.ts` asserts the two are identical, so the
 * copy exists to be checked rather than trusted.
 */
const PREFIX = "[squad-alive]";

/**
 * The prefix a usage line carries.
 *
 * A second channel on the same stream, and it exists because the headless app
 * THROWS THIS AWAY: its chunk switch has `case "usage": return;`, so the
 * harness measures every call and then prints nothing. The parent had no
 * accounting for dsh seats at all — a team with one in it reported a total
 * that was quietly short, with nothing saying so.
 *
 * Its own copy of `@squad/seat-runtime`'s literal for the same reason
 * `PREFIX` is: this module runs in another process, and importing the runtime
 * there would drag the whole subagent machinery in for one string.
 */
const USAGE_PREFIX = "[squad-usage]";

/**
 * The shortest gap between two lines.
 *
 * A real model emits `assistant/chunk` tens of times a second, and stderr is
 * collected with a 256 KB cap that keeps the TAIL — so an unthrottled
 * heartbeat would evict the very failure message this stream exists to
 * carry. One line a second is far more often than the watchdog polls (2s) and
 * costs about 24 KB over a ten-minute turn.
 */
const MIN_GAP_MS = 1_000;

/** Events worth a line even when one has just gone out. */
const ALWAYS: ReadonlySet<string> = new Set([
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "tool/call",
  "tool/result",
  "llm/retry",
  "compaction/start",
]);

/**
 * Write one line per event, throttled.
 *
 * The event TYPE travels with it, because the two questions a stuck seat
 * raises are 「它还活着吗」 and 「它卡在哪一步」, and the second one is free
 * to answer here — a tail of `tool/call` lines says something a bare tick
 * cannot.
 */
export function apply(ctx: Context): void {
  let lastAt = 0;
  // RUNNING TOTALS, re-printed whole every time.
  //
  // A turn that calls tools makes several model calls and reports usage once
  // per call, so a line per event would have to be summed by the reader — and
  // the reader sees only the TAIL of a capped stderr buffer, so a summing
  // reader would silently undercount exactly the long turns that cost most.
  // Printing the total means the last line is the answer, and the last line is
  // the one truncation keeps.
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const write = (type: string): void => {
    const now = Date.now();
    if (now - lastAt < MIN_GAP_MS && !ALWAYS.has(type)) return;
    lastAt = now;
    process.stderr.write(`${PREFIX} ${new Date(now).toISOString()} ${type}\n`);
  };
  // Announced at load, so a run that dies before its first event still shows
  // that the heartbeat itself was mounted. Debugging 「没有心跳」 otherwise
  // cannot tell a silent child from a plugin that never loaded.
  write("mounted");
  (ctx as unknown as { on: (event: string, cb: (...args: unknown[]) => void, options: unknown) => void }).on(
    "session/event",
    (...args: unknown[]) => {
      const event = args[1];
      const type =
        typeof event === "object" && event !== null && "type" in event
          ? String((event as { type: unknown }).type)
          : "?";
      write(type);
      addUsage(event, total);
    },
    { global: true },
  );
}

/** One number off an unknown shape, ignoring anything that is not one. */
const numberAt = (source: unknown, key: string): number => {
  if (typeof source !== "object" || source === null || !(key in source)) return 0;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

/**
 * Add one `usage` chunk to the running total and print it.
 *
 * Reads defensively rather than by type: this file is loaded by a DIFFERENT
 * process, against whatever harness version happens to be installed there, and
 * a shape mismatch must cost the accounting rather than the turn.
 *
 * `cacheWriteTokens` lands in `cacheCreationTokens` — the two names describe
 * the same thing on either side of this boundary, and translating here is
 * cheaper than teaching the parent two vocabularies.
 */
function addUsage(event: unknown, total: Record<string, number>): void {
  if (typeof event !== "object" || event === null) return;
  const data = (event as { data?: unknown }).data;
  const chunk = typeof data === "object" && data !== null ? (data as { chunk?: unknown }).chunk : undefined;
  if (typeof chunk !== "object" || chunk === null) return;
  if ((chunk as { type?: unknown }).type !== "usage") return;
  const usage = (chunk as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return;

  total["inputTokens"] = (total["inputTokens"] ?? 0) + numberAt(usage, "inputTokens");
  total["outputTokens"] = (total["outputTokens"] ?? 0) + numberAt(usage, "outputTokens");
  total["cacheReadTokens"] = (total["cacheReadTokens"] ?? 0) + numberAt(usage, "cacheReadTokens");
  total["cacheCreationTokens"] = (total["cacheCreationTokens"] ?? 0) + numberAt(usage, "cacheWriteTokens");
  process.stderr.write(`${USAGE_PREFIX} ${JSON.stringify(total)}\n`);
}
