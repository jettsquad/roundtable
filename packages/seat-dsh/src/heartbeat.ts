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
    },
    { global: true },
  );
}
