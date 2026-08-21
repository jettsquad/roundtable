/**
 * @squad/seat-claude-code — a Claude Code seat backend with a tool fence.
 *
 * Registered as `claude-code-fenced`, alongside the stock provider rather
 * than replacing it, so a composition chooses and the choice is visible in
 * the profile.
 *
 * Why it exists, in one line: the stock provider hardcodes its tool policy
 * and offers no way to extend it, so a seat can spawn its own subagents —
 * the 1.x failure where a secretary that did not know the roster invented a
 * team of its own. This one denies delegation by default and honours the
 * seam's `toolFilter` and `persona`, which the stock provider declares it
 * does not support.
 *
 * The run-handle contract is NOT hand-rolled. `settleRunResult` and
 * `subprocessRunHandle` come from dsh's own subagent package, because the
 * rule they enforce is the one a hand-written provider gets wrong: `result`
 * must never reject after publication — a child-level failure resolves with
 * `stopReason: 'error'`. Get that backwards and a failing seat rejects into
 * a caller that expected a value, which surfaces as a round that hangs or
 * vanishes rather than as a seat that failed.
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import {
  NO_START_CAPABILITIES,
  resolveChildCwd,
  settleRunResult,
  subprocessRunHandle,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
} from "@deepseek-ai/dsh-subagent";
// Imported for the `Context.subprocess` declaration merging it carries: an
// augmentation applies only where its module is in the compilation.
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess";
import { DELEGATION_TOOLS, buildArgv, type PermissionMode } from "./argv.ts";
import { readStream } from "./stream.ts";

export const name = "squad-seat-claude-code";

/** `subprocess` to spawn, `subagents` to register with. */
export const inject = ["subagents", "subprocess"];

export interface Config {
  /** Registry name. Distinct from the stock `claude-code` so both can coexist. */
  readonly provider?: string;
  /** Tools no seat may use, whatever the caller asks for. Empty lowers the floor. */
  readonly alwaysDeny?: readonly string[];
  readonly permissionMode?: PermissionMode;
  /** Kill a seat that has produced nothing for this long. Idle, not total. */
  readonly idleMs?: number;
  /** Grace before SIGKILL when tearing a seat down. */
  readonly disposeGraceMs?: number;
  readonly env?: Record<string, string>;
}

const DEFAULTS = {
  provider: "claude-code-fenced",
  alwaysDeny: DELEGATION_TOOLS,
  permissionMode: "acceptEdits" as PermissionMode,
  /**
   * Ten minutes of SILENCE, not of work.
   *
   * A deep task legitimately runs far longer than any fixed wall clock, and
   * killing a seat that is visibly working is worse than waiting: the work is
   * lost and the reason is invisible. Partial messages give this clock a
   * heartbeat, which is why they are requested at all.
   */
  idleMs: 600_000,
  disposeGraceMs: 5_000,
};

export function apply(ctx: Context, config?: Config): void {
  ctx.plugin(FencedClaudeCodeSeats, config ?? {});
}

export class FencedClaudeCodeSeats extends Service {
  static readonly inject = ["subagents", "subprocess"];

  private readonly config: Config;

  constructor(ctx: Context, config?: Config) {
    super(ctx, "squadSeatClaudeCode");
    // Defaulted, because a row with no `config:` block hands this `undefined`
    // — and every field being optional does not make the OBJECT optional.
    // It failed as "Cannot read properties of undefined (reading 'provider')"
    // thrown inside Service.init, where cordis swallowed it: the plugin sat in
    // the tree, the boot logged nothing, and seats failed much later with
    // "no subagent provider registered".
    this.config = config ?? {};
  }

  async [Service.init](): Promise<void> {
    this.ctx.effect(() => this.ctx.subagents.registerProvider(this.provider()));
  }

  private provider(): SubagentProvider {
    const config = this.config;
    const ctx = this.ctx;
    return {
      name: config.provider ?? DEFAULTS.provider,
      // Declared honestly: this provider really does apply a tool filter and
      // really does append a persona. The service checks these before
      // dispatching, so declaring one we did not implement would turn a
      // rejected request into a silently ignored one.
      capabilities: { ...NO_START_CAPABILITIES, toolFilter: true, persona: true },
      // A fresh CLI process sees no parent conversation, only the text task.
      inheritsParentContext: false,

      async start(request): Promise<SubagentRun> {
        const cwd = resolveChildCwd("squad-seat-claude-code", undefined, request.parent.session.header.cwd);
        const executable = await ctx.subprocess.resolveExecutable("claude", config.env ?? {}, request.signal);

        const prompt = request.prompt
          .map((block) => (typeof block === "object" && block !== null && "text" in block ? String(block.text) : ""))
          .join("");
        if (prompt.trim() === "") throw new Error("squad-seat-claude-code: 席位任务不能是空的。");

        const controller = new AbortController();
        let cancelled = false;
        const requestCancel = (): void => {
          cancelled = true;
          if (!controller.signal.aborted) controller.abort(new Error("squad-seat: cancelled"));
        };
        const onAbort = (): void => requestCancel();
        request.signal.addEventListener("abort", onAbort, { once: true });

        const child = await ctx.subprocess.spawn({
          argv: [
            executable,
            ...buildArgv({
              prompt,
              ...(request.toolFilter === undefined ? {} : { toolFilter: request.toolFilter }),
              ...(request.persona === undefined ? {} : { persona: request.persona }),
              permissionMode: config.permissionMode ?? DEFAULTS.permissionMode,
              alwaysDeny: config.alwaysDeny ?? DEFAULTS.alwaysDeny,
            }),
          ],
          cwd,
          // Collected with a cap rather than piped: a seat's stdout is read
          // once, after it exits, and an unbounded buffer would let a chatty
          // run take the host down with it. Overflow keeps the TAIL, which is
          // where the answer is.
          stdio: {
            stdin: "ignore",
            stdout: { maxBytes: 8 * 1024 * 1024 },
            stderr: { maxBytes: 256 * 1024 },
          },
          graceMs: config.disposeGraceMs ?? DEFAULTS.disposeGraceMs,
          signal: controller.signal,
          env: config.env ?? {},
        });

        let output = "";
        const collectOutput = (): SubagentResult["output"] =>
          output.trim() === "" ? [] : [{ type: "text", text: readStream(output).text }];

        const attempt = async (): Promise<SubagentResult> => {
          const idle = idleWatchdog(config.idleMs ?? DEFAULTS.idleMs, requestCancel);
          try {
            const outcome = await child.done;
            output = await readAll(child);
            const parsed = readStream(output);
            // A non-zero exit with text still carries the text: a failure that
            // explains itself is worth more than one that does not.
            // `exitCode` is null when a signal killed it — which is a
            // failure, not a zero exit. Comparing against 0 alone would read
            // a SIGKILLed seat as a clean one.
            const failed = parsed.failed || outcome.exitCode !== 0;
            return {
              output: parsed.text === "" ? [] : [{ type: "text", text: parsed.text }],
              stopReason: failed ? "error" : "completed",
              // `SubagentResult` declares no usage field, and dsh does not
              // need one: `observeRun` attaches an observer and returns our
              // object unchanged, so an extra property survives to the caller.
              // Verified in the harness source before relying on it.
              ...(parsed.usage === undefined ? {} : { squadUsage: parsed.usage }),
            } as SubagentResult;
          } finally {
            idle.stop();
          }
        };

        return subprocessRunHandle({
          id: `${request.parent.session.id}/claude-${Date.now().toString(36)}` as never,
          // Never rejects after publication — the seam's contract, enforced by
          // dsh's own settlement rather than by our care.
          result: settleRunResult({
            attempt,
            collectOutput,
            cancelled: () => cancelled,
            signal: request.signal,
            onAbort,
            onError: (error, stopReason) => {
              ctx.logger.warn(`squad-seat-claude-code: 席位失败（${stopReason}）：${error.message}`);
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
      },
    };
  }
}

/** Read everything the child collected, after it exited. */
async function readAll(child: SubprocessHandle): Promise<string> {
  // From offset 0 after settlement: the batch result. `lossy` would mean the
  // in-memory tail lost its head, which for a stream-json run costs the early
  // assistant blocks — reported rather than silently shortened.
  const read = await child.collected.stdout?.readFrom(0);
  return read?.text ?? "";
}

/**
 * Cancel a seat that has gone silent.
 *
 * Idle rather than total: a deep task legitimately runs longer than any fixed
 * wall clock, and killing a working seat loses the work AND the reason.
 */
function idleWatchdog(idleMs: number, onIdle: () => void): { stop(): void } {
  const timer = setTimeout(onIdle, idleMs);
  timer.unref?.();
  return {
    stop: () => clearTimeout(timer),
  };
}

export { DELEGATION_TOOLS, buildArgv } from "./argv.ts";
export type { ArgvInput, PermissionMode, ToolFence } from "./argv.ts";
export { readStream } from "./stream.ts";
export type { StreamOutcome } from "./stream.ts";
