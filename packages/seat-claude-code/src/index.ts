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
import { CLAUDE_PERMISSION_MODES, providerNameFor } from "@squad/shared";
import { DELEGATION_TOOLS, buildArgv, type PermissionMode } from "./argv.ts";
import { readStream } from "./stream.ts";

export const name = "squad-seat-claude-code";

/** `subprocess` to spawn, `subagents` to register with. */
export const inject = ["subagents", "subprocess", "seatConnections"];

export interface Config {
  /** Registry name. Distinct from the stock `claude-code` so both can coexist. */
  readonly provider?: string;
  /** Tools no seat may use, whatever the caller asks for. Empty lowers the floor. */
  readonly alwaysDeny?: readonly string[];
  readonly permissionMode?: PermissionMode;
  /** Kill a seat that has produced nothing for this long. Idle, not total. */
  readonly idleMs?: number;
  /** How long a seat may produce nothing at all before it counts as unreachable. */
  readonly firstOutputMs?: number;
  /** Watchdog poll interval. */
  readonly pollMs?: number;
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
  /**
   * How long a seat may produce NOTHING before it is treated as unreachable.
   *
   * Short, because before the first byte there is nothing to be deep about:
   * the CLI streams partial messages, so a working seat says something
   * quickly. The usual cause of total silence is an endpoint that is not
   * answering.
   */
  firstOutputMs: 90_000,
  /** How often the watchdog checks whether anything new arrived. */
  pollMs: 5_000,
  disposeGraceMs: 5_000,
};

export function apply(ctx: Context, config?: Config): void {
  ctx.plugin(FencedClaudeCodeSeats, config ?? {});
}

export class FencedClaudeCodeSeats extends Service {
  static readonly inject = ["subagents", "subprocess", "seatConnections"];

  private readonly config: Config;
  /** connectionId → its provider registration disposer. */
  private readonly perConnection = new Map<string, () => void>();

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
    // The unconfigured default: the host's own CLI login, nothing injected.
    this.ctx.effect(() => this.ctx.subagents.registerProvider(this.provider()));
    // …and the same login under each permission mode, for a seat that picked
    // a mode but no connection. Without these that seat asks for
    // `claude-code-fenced#acceptEdits`, which nothing registered — and the
    // failure arrives at the first round as an unregistered provider name
    // nobody typed.
    for (const mode of CLAUDE_PERMISSION_MODES) {
      this.ctx.effect(() => this.ctx.subagents.registerProvider(this.provider(undefined, mode)));
    }
    this.syncConnections();
    this.ctx.effect(() => this.ctx.seatConnections.watch(() => this.syncConnections()));
    this.ctx.effect(() => () => {
      for (const dispose of this.perConnection.values()) dispose();
      this.perConnection.clear();
    });
  }

  /**
   * Keep one provider registration per connection.
   *
   * The seam has no per-request environment, so a seat's credentials cannot
   * ride along with its turn — the registration is the only place they can
   * attach. Naming each provider after its connection turns "which
   * credentials" into "which provider", which the request already carries.
   *
   * The environment itself is still resolved per START, not baked in here: a
   * rotated key has to reach the next turn, not the next restart.
   */
  private syncConnections(): void {
    const wanted = new Set<string>();
    // Connections × permission modes. The mode is spelled into the provider
    // name for the same reason the connection is — both are decided when the
    // child is spawned, and the request carries nothing else that could
    // select among registrations. The cross product is bounded because the
    // mode list is closed; the `undefined` entry is the seat that made no
    // choice, which must keep the plain per-connection name a seat saved
    // before modes existed still asks for.
    const combinations: readonly (string | undefined)[] = [undefined, ...CLAUDE_PERMISSION_MODES];
    for (const connection of this.ctx.seatConnections.list()) {
      if (connection.backend !== "claude-code") continue;
      for (const mode of combinations) {
        const key = providerNameFor(connection.connectionId, mode);
        wanted.add(key);
        if (this.perConnection.has(key)) continue;
        this.perConnection.set(key, this.ctx.subagents.registerProvider(this.provider(connection.connectionId, mode)));
      }
    }
    for (const [connectionId, dispose] of [...this.perConnection]) {
      if (wanted.has(connectionId)) continue;
      // Withdrawn rather than left behind: a provider for a deleted
      // connection would still start seats, using an environment nobody can
      // see any more.
      dispose();
      this.perConnection.delete(connectionId);
    }
  }

  private provider(connectionId?: string, permissionMode?: string): SubagentProvider {
    const config = this.config;
    const ctx = this.ctx;
    return {
      name:
        connectionId === undefined && permissionMode === undefined
          ? (config.provider ?? DEFAULTS.provider)
          : providerNameFor(connectionId, permissionMode),
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
              // The registration's mode wins over the plugin default: it is
              // the one the person picked for this agent.
              permissionMode:
                (permissionMode as typeof DEFAULTS.permissionMode | undefined) ??
                config.permissionMode ??
                DEFAULTS.permissionMode,
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
          // Resolved per start, so a rotated key reaches this turn.
          env: {
            ...(config.env ?? {}),
            ...(connectionId === undefined ? {} : await ctx.seatConnections.envFor(connectionId)),
          },
        });

        let output = "";
        const collectOutput = (): SubagentResult["output"] =>
          output.trim() === "" ? [] : [{ type: "text", text: readStream(output).text }];

        const attempt = async (): Promise<SubagentResult> => {
          let silence: "silent" | "no-output" | undefined;
          const idle = idleWatchdog(
            async () => (await child.collected.stdout?.readFrom(0))?.nextOffset ?? 0,
            {
              idleMs: config.idleMs ?? DEFAULTS.idleMs,
              firstOutputMs: config.firstOutputMs ?? DEFAULTS.firstOutputMs,
              pollMs: config.pollMs ?? DEFAULTS.pollMs,
            },
            (reason) => {
              silence = reason;
              requestCancel();
            },
          );
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
            // A seat killed by the watchdog explains itself. Without this the
            // caller sees an empty answer and a non-zero exit, which reads as
            // "the model said nothing" — and the person goes looking at the
            // prompt instead of at the endpoint.
            const text =
              silence === "no-output"
                ? `这个席位 ${Math.round((config.firstOutputMs ?? DEFAULTS.firstOutputMs) / 1000)} 秒内一个字都没输出，` +
                  `按连不上处理。多半是它的连接端点没有响应——到 Agent 库点「测试」看接口地址那一项。`
                : silence === "silent"
                  ? `这个席位停了 ${Math.round((config.idleMs ?? DEFAULTS.idleMs) / 1000)} 秒没有新输出，已经中止。`
                  : parsed.text;
            return {
              output: text === "" ? [] : [{ type: "text", text }],
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
 * Whether a stretch of silence has become a verdict, and which one.
 *
 * Pure, and separate, because this is the judgement the previous watchdog
 * got wrong: it had one deadline where there are two, and it counted from
 * the start where it should count from the last byte.
 *
 * @param bytesSeen - total output bytes so far; zero means nothing has ever arrived.
 * @param quietFor - milliseconds since the byte count last changed.
 */
export function silenceVerdict(
  bytesSeen: number,
  quietFor: number,
  limits: { readonly idleMs: number; readonly firstOutputMs: number },
): "silent" | "no-output" | undefined {
  // Before the first byte there is nothing to be deep about, so the shorter
  // deadline applies — and the verdict names the difference, because "never
  // answered" and "stopped answering" send a person to different places.
  if (bytesSeen === 0) return quietFor >= limits.firstOutputMs ? "no-output" : undefined;
  return quietFor >= limits.idleMs ? "silent" : undefined;
}

/**
 * Cancel a seat that has gone SILENT — not one that is merely slow.
 *
 * The distinction is the whole point, and the previous version claimed it
 * without having it: one `setTimeout` armed at start and never reset, which
 * is a TOTAL deadline wearing an idle deadline's comment. It killed a
 * genuinely long task at ten minutes with work in flight, and it made a seat
 * that could not reach its endpoint sit there for the same ten minutes
 * saying nothing — which is what a person sees as 「进行中」 forever.
 *
 * Now it watches the stream. Bytes arriving reset the clock; silence does
 * not. A CLI streaming partial messages is never quiet for long, so real
 * silence means the far end is gone.
 *
 * `firstOutputMs` is separate and shorter: before ANY byte has arrived there
 * is nothing to be deep about. An endpoint that does not answer is the
 * common cause, and ten minutes is a cruel way to learn it.
 */
function idleWatchdog(
  read: () => Promise<number>,
  options: { readonly idleMs: number; readonly firstOutputMs: number; readonly pollMs: number },
  onIdle: (reason: "silent" | "no-output") => void,
): { stop(): void } {
  let seen = 0;
  let lastChange = Date.now();
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const bytes = await read().catch(() => seen);
    if (bytes > seen) {
      seen = bytes;
      lastChange = Date.now();
    }
    const verdict = silenceVerdict(seen, Date.now() - lastChange, options);
    if (verdict !== undefined) {
      stopped = true;
      onIdle(verdict);
      return;
    }
    const timer = setTimeout(() => void tick(), options.pollMs);
    timer.unref?.();
  };

  const first = setTimeout(() => void tick(), options.pollMs);
  first.unref?.();
  return {
    stop: () => {
      stopped = true;
    },
  };
}

export { DELEGATION_TOOLS, buildArgv } from "./argv.ts";
export type { ArgvInput, PermissionMode, ToolFence } from "./argv.ts";
export { readStream } from "./stream.ts";
export type { StreamOutcome } from "./stream.ts";
