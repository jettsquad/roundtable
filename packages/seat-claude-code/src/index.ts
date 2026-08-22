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
import { NO_START_CAPABILITIES, type SubagentProvider, type SubagentRun } from "@deepseek-ai/dsh-subagent";
// Imported for the `Context.subprocess` declaration merging it carries: an
// augmentation applies only where its module is in the compilation.
import type {} from "@deepseek-ai/dsh-subprocess";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliSeat, SEAT_SILENCE_LIMITS } from "@squad/seat-runtime";
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
  idleMs: SEAT_SILENCE_LIMITS.idleMs,
  firstOutputMs: SEAT_SILENCE_LIMITS.firstOutputMs,
  /** How often the watchdog checks whether anything new arrived. */
  pollMs: SEAT_SILENCE_LIMITS.pollMs,
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
        const connectionEnv = connectionId === undefined ? {} : await ctx.seatConnections.envFor(connectionId);
        const connection = connectionId === undefined ? undefined : ctx.seatConnections.get(connectionId);

        // An api-key seat gets its OWN config directory.
        //
        // Without one the host's `claude login` WINS: the CLI prefers its
        // stored subscription over `ANTHROPIC_API_KEY`, so it sent an
        // Anthropic OAuth token to the connection's gateway, got 401, and
        // retried ten times with growing backoff — which from outside looks
        // like a seat that hangs for minutes and then says nothing. The
        // connection's key was stored, rendered in the library, and ignored.
        //
        // Proven rather than guessed: the same key, endpoint and model
        // answered in 11 seconds the moment `CLAUDE_CONFIG_DIR` pointed
        // somewhere empty, and failed with `authentication_failed` without it.
        //
        // Subscription seats keep the host's config — using that login IS
        // what subscription mode means.
        let configDir: string | undefined;
        if (connection?.authMode === "api-key") {
          configDir = await mkdtemp(join(tmpdir(), "squad-claude-"));
        }

        return runCliSeat({
          ctx,
          who: name,
          request,
          command: "claude",
          argv: ({ prompt }) =>
            buildArgv({
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
          // Resolved per start, so a rotated key reaches this turn.
          env: {
            ...(config.env ?? {}),
            ...connectionEnv,
            ...(configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir }),
          },
          // Removed afterwards. A seat is a process that remembers nothing;
          // a config directory left behind is state it would remember.
          ...(configDir === undefined
            ? {}
            : {
                cleanup: async () => {
                  await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
                },
              }),
          parse: readStream,
          limits: {
            idleMs: config.idleMs ?? DEFAULTS.idleMs,
            firstOutputMs: config.firstOutputMs ?? DEFAULTS.firstOutputMs,
            pollMs: config.pollMs ?? DEFAULTS.pollMs,
          },
          disposeGraceMs: config.disposeGraceMs ?? DEFAULTS.disposeGraceMs,
        });
      },
    };
  }
}

export { DELEGATION_TOOLS, buildArgv } from "./argv.ts";
export type { ArgvInput, PermissionMode, ToolFence } from "./argv.ts";
export { readStream } from "./stream.ts";
export type { StreamOutcome } from "./stream.ts";
