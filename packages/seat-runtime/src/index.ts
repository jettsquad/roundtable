/**
 * @squad/seat-runtime — running one CLI seat, once, for any backend.
 *
 * A LIBRARY, not a plugin. It registers no service and provides nothing to a
 * context; it is the shared body of the three seat backends (Claude Code,
 * Codex, DSH), which differ only in which executable they run, which
 * arguments they build, and how they read the output back.
 *
 * Extracted because the parts they DON'T differ in are the parts that are
 * easy to get subtly wrong and hard to notice: the run-handle contract
 * (`result` must never reject after publication), cancellation reaching the
 * child, the silence watchdog, and reading collected output once after exit.
 * Three copies of that would drift, and the copy that drifted would be the
 * one nobody was looking at.
 */
import {
  resolveChildCwd,
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
} from "@deepseek-ai/dsh-subagent";
// Imported for the `Context.subprocess` declaration merging it carries.
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess";
import type { Context } from "@deepseek-ai/cordis";
import type { SeatUsage } from "@squad/shared";
import { silenceMessage, watchSilence, type SilenceLimits } from "./silence.ts";

export { silenceVerdict, watchSilence, silenceMessage } from "./silence.ts";
export type { SilenceLimits, SilenceReason } from "./silence.ts";

/** What a backend's parser makes of one run's output. */
export interface SeatOutcome {
  readonly text: string;
  readonly failed: boolean;
  /** What the backend's own parser knows about the failure, when it knows anything. */
  readonly detail?: string | undefined;
  readonly usage?: SeatUsage | undefined;
}

export interface SeatRunSpec {
  readonly ctx: Context;
  /** Plugin name, for messages that must say who refused. */
  readonly who: string;
  readonly request: SubagentStartRequest;
  /** The command to find on PATH. */
  readonly command: string;
  /** Built from the prompt and the seat's configuration. */
  readonly argv: (input: { readonly prompt: string; readonly cwd: string }) => readonly string[];
  /** Environment contributed on top of the host's, resolved per start. */
  readonly env: Record<string, string>;
  readonly parse: (raw: string) => SeatOutcome;
  readonly limits: SilenceLimits;
  readonly disposeGraceMs: number;
  /**
   * Run after the child settles, whatever happened.
   *
   * For temporary files a backend had to write to configure the run: leaving
   * one behind means a description of where a seat sends its traffic sits in
   * a shared temp directory until something else cleans it.
   */
  readonly cleanup?: (() => Promise<void>) | undefined;
}

/** The text blocks of a start request, joined. */
function promptOf(request: SubagentStartRequest): string {
  return request.prompt
    .map((block) => (typeof block === "object" && block !== null && "text" in block ? String(block.text) : ""))
    .join("");
}

/** Read everything the child collected, after it exited. */
async function readAll(child: SubprocessHandle): Promise<string> {
  // From offset 0 after settlement: the batch result. `lossy` would mean the
  // in-memory tail lost its head, which costs the early output — reported by
  // the parser rather than silently shortened.
  const read = await child.collected.stdout?.readFrom(0);
  return read?.text ?? "";
}

/** The last few lines a CLI wrote to stderr. */
async function readStderrTail(child: SubprocessHandle, lines = 8): Promise<string> {
  const read = await child.collected.stderr?.readFrom(0);
  const text = (read?.text ?? "").trim();
  if (text === "") return "";
  return text.split("\n").slice(-lines).join("\n");
}

/**
 * What a failed run should say, when the answer itself is empty.
 *
 * Every CLI writes its refusals to STDERR and its answers to stdout, and this
 * only ever read stdout — so a seat that failed before producing a word came
 * back as an empty reply with a red 「失败」 and nothing else. The reason was
 * sitting in a buffer we already collected and never opened:
 *
 *   dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route …
 *
 * Exit code included because a CLI can also die silently, and "exited 1 with
 * no output" is still more than nothing.
 */
export function failureText(input: {
  readonly detail?: string | undefined;
  readonly stderr: string;
  readonly exitCode: number | null;
}): string {
  const parts: string[] = [];
  if (input.detail !== undefined && input.detail.trim() !== "") parts.push(input.detail.trim());
  // Trimmed here as well as at the read: this is exported, and a caller that
  // passes whitespace should get the exit code rather than a blank line
  // dressed up as an explanation.
  if (input.stderr.trim() !== "") parts.push(input.stderr.trim());
  if (parts.length === 0) {
    parts.push(
      input.exitCode === null
        ? "这个席位被信号杀掉了，没有任何输出。"
        : `这个席位以退出码 ${input.exitCode} 结束，stdout 和 stderr 都是空的。`,
    );
  }
  return `⚠️ 该席位没有给出答复：\n${parts.join("\n")}`;
}

/**
 * Start one CLI seat and hand back its run handle.
 *
 * The run-handle contract is NOT hand-rolled: `settleRunResult` and
 * `subprocessRunHandle` come from dsh's own package, because the rule they
 * enforce is the one a hand-written provider gets wrong — `result` must never
 * reject after publication; a child-level failure RESOLVES with
 * `stopReason: "error"`. Backwards, a failing seat rejects into a caller that
 * expected a value, and the round hangs or vanishes instead of reporting a
 * seat that failed.
 */
export async function runCliSeat(spec: SeatRunSpec): Promise<SubagentRun> {
  const { ctx, request, limits } = spec;
  const cwd = resolveChildCwd(spec.who, undefined, request.parent.session.header.cwd);
  const executable = await ctx.subprocess.resolveExecutable(spec.command, spec.env, request.signal);

  const prompt = promptOf(request);
  if (prompt.trim() === "") throw new Error(`${spec.who}: 席位任务不能是空的。`);

  const controller = new AbortController();
  let cancelled = false;
  const requestCancel = (): void => {
    cancelled = true;
    if (!controller.signal.aborted) controller.abort(new Error(`${spec.who}: cancelled`));
  };
  const onAbort = (): void => requestCancel();
  request.signal.addEventListener("abort", onAbort, { once: true });

  const child = await ctx.subprocess.spawn({
    argv: [executable, ...spec.argv({ prompt, cwd })],
    cwd,
    // Collected with a cap rather than piped: a seat's stdout is read once,
    // after it exits, and an unbounded buffer would let a chatty run take the
    // host down with it. Overflow keeps the TAIL, which is where the answer is.
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: 8 * 1024 * 1024 },
      stderr: { maxBytes: 256 * 1024 },
    },
    graceMs: spec.disposeGraceMs,
    signal: controller.signal,
    env: spec.env,
  });

  let output = "";
  const collectOutput = (): SubagentResult["output"] =>
    output.trim() === "" ? [] : [{ type: "text", text: spec.parse(output).text }];

  const attempt = async (): Promise<SubagentResult> => {
    let silence: "silent" | "no-output" | undefined;
    const watch = watchSilence(
      async () => (await child.collected.stdout?.readFrom(0))?.nextOffset ?? 0,
      limits,
      (reason) => {
        silence = reason;
        requestCancel();
      },
    );
    try {
      const outcome = await child.done;
      output = await readAll(child);
      const parsed = spec.parse(output);
      // A non-zero exit with text still carries the text: a failure that
      // explains itself is worth more than one that does not. `exitCode` is
      // null when a signal killed it — comparing against 0 alone would read a
      // SIGKILLed seat as a clean one.
      const failed = parsed.failed || outcome.exitCode !== 0;
      // A seat killed by the watchdog explains itself; a seat that failed
      // without producing an answer explains itself from stderr. Without
      // either, the caller sees an empty reply with a red 「失败」 and the
      // person cannot tell "never got the message" from "could not answer"
      // from "was never configured".
      const text =
        silence !== undefined
          ? silenceMessage(silence, limits)
          : failed && parsed.text.trim() === ""
            ? failureText({
                detail: parsed.detail,
                stderr: await readStderrTail(child),
                exitCode: outcome.exitCode,
              })
            : parsed.text;
      return {
        output: text === "" ? [] : [{ type: "text", text }],
        stopReason: failed ? "error" : "completed",
        // `SubagentResult` declares no usage field, and dsh does not need
        // one: `observeRun` attaches an observer and returns our object
        // unchanged, so an extra property survives to the caller. Verified in
        // the harness source before relying on it.
        ...(parsed.usage === undefined ? {} : { squadUsage: parsed.usage }),
      } as SubagentResult;
    } finally {
      watch.stop();
      await spec.cleanup?.().catch(() => undefined);
    }
  };

  return subprocessRunHandle({
    id: `${request.parent.session.id}/${spec.command}-${Date.now().toString(36)}` as never,
    result: settleRunResult({
      attempt,
      collectOutput,
      cancelled: () => cancelled,
      signal: request.signal,
      onAbort,
      onError: (error, stopReason) => {
        ctx.logger.warn(`${spec.who}: 席位失败（${stopReason}）：${error.message}`);
      },
    }),
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: async () => {
      child.terminate();
      await child.done.catch(() => undefined);
    },
  });
}
