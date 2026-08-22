/**
 * @squad/seat-codex — a Codex seat backend.
 *
 * The reason it exists: the Agent library offered `codex` as a backend and
 * nothing registered a provider for it, so a Codex agent saved, rendered,
 * and then failed at its first round asking for a provider name nobody
 * typed. Storable, renderable, ignored — for the third time in this project,
 * and this is the fix rather than another label saying so.
 *
 * NO TOOL FENCE, and that is a fact about Codex rather than an omission.
 * `claude-code-fenced` exists because Claude Code's stock provider lets a
 * seat spawn its own subagents; `codex exec` has no delegation tool to deny.
 * The capability is declared `toolFilter: false` so the seam REJECTS a
 * request that asks for one, instead of accepting it and quietly not
 * applying it.
 *
 * Persona is likewise not supported: `codex exec` takes one prompt and has no
 * system-prompt argument. Squad's seats already carry their standing
 * instructions inside the prompt text (see `composeSeatPrompt`), so nothing
 * is lost — but declaring `persona: true` here would be a lie the seam
 * believes.
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import { NO_START_CAPABILITIES, type SubagentProvider, type SubagentRun } from "@deepseek-ai/dsh-subagent";
// Imported for the `Context.subprocess` declaration merging it carries.
import type {} from "@deepseek-ai/dsh-subprocess";
import { CODEX_PERMISSION_MODES, modelArgumentFor, providerName, type SeatConnection } from "@squad/shared";
import { runCliSeat } from "@squad/seat-runtime";
import { buildCodexArgv, isCodexMode } from "./argv.ts";
import { readCodexStream } from "./stream.ts";

export const name = "squad-seat-codex";

export const inject = ["subagents", "subprocess", "seatConnections"];

export interface Config {
  /** Registry name for the host's own `codex login`, with no connection. */
  readonly provider?: string;
  readonly permissionMode?: (typeof CODEX_PERMISSION_MODES)[number];
  readonly reasoningEffort?: "low" | "medium" | "high";
  readonly idleMs?: number;
  readonly firstOutputMs?: number;
  readonly pollMs?: number;
  readonly disposeGraceMs?: number;
  readonly env?: Record<string, string>;
}

const DEFAULTS = {
  provider: "codex",
  /** The documented safe combination, and what a person means by "let it work". */
  permissionMode: "workspace" as const,
  idleMs: 600_000,
  firstOutputMs: 90_000,
  pollMs: 5_000,
  disposeGraceMs: 5_000,
};

/** The provider name for the seat backend `providerForSeat` asks for. */
const BASE = "codex";

export class SquadSeatCodex extends Service {
  static readonly inject = ["subagents", "subprocess", "seatConnections"];

  private readonly config: Config;
  private readonly perConnection = new Map<string, () => void>();

  constructor(ctx: Context, config?: Config) {
    super(ctx, "squadSeatCodex");
    // A profile row with no `config:` hands this `undefined`, and every field
    // being optional does not make the OBJECT optional.
    this.config = config ?? {};
  }

  async [Service.init](): Promise<void> {
    // The host's own `codex login`, nothing injected.
    this.ctx.effect(() => this.ctx.subagents.registerProvider(this.provider()));
    this.syncConnections();
    this.ctx.effect(() => this.ctx.seatConnections.watch(() => this.syncConnections()));
    this.ctx.effect(() => () => {
      for (const dispose of this.perConnection.values()) dispose();
      this.perConnection.clear();
    });
  }

  /**
   * One registration per connection × permission mode.
   *
   * Same argument as the Claude backend: the seam carries no per-request
   * environment or argv, so both attach at registration and the provider NAME
   * is the only thing a request can use to select among them.
   */
  private syncConnections(): void {
    const wanted = new Set<string>();
    const modes: readonly (string | undefined)[] = [undefined, ...CODEX_PERMISSION_MODES];
    for (const connection of this.ctx.seatConnections.list()) {
      if (connection.backend !== "codex") continue;
      for (const mode of modes) {
        const key = providerName(BASE, connection.connectionId, mode);
        wanted.add(key);
        if (this.perConnection.has(key)) continue;
        this.perConnection.set(key, this.ctx.subagents.registerProvider(this.provider(connection, mode)));
      }
    }
    for (const [key, dispose] of [...this.perConnection]) {
      if (wanted.has(key)) continue;
      // Withdrawn rather than left behind: a provider for a deleted
      // connection would still start seats with an environment nobody can see.
      dispose();
      this.perConnection.delete(key);
    }
  }

  private provider(connection?: SeatConnection, permissionMode?: string): SubagentProvider {
    const config = this.config;
    const ctx = this.ctx;
    const limits = {
      idleMs: config.idleMs ?? DEFAULTS.idleMs,
      firstOutputMs: config.firstOutputMs ?? DEFAULTS.firstOutputMs,
      pollMs: config.pollMs ?? DEFAULTS.pollMs,
    };
    return {
      name:
        connection === undefined && permissionMode === undefined
          ? (config.provider ?? DEFAULTS.provider)
          : providerName(BASE, connection?.connectionId, permissionMode),
      // Declared honestly. `codex exec` has no delegation tool to deny and no
      // system-prompt argument, so the seam should REFUSE a request asking
      // for either rather than accept one and ignore it.
      capabilities: { ...NO_START_CAPABILITIES, toolFilter: false, persona: false },
      inheritsParentContext: false,

      async start(request): Promise<SubagentRun> {
        const mode = isCodexMode(permissionMode) ? permissionMode : (config.permissionMode ?? DEFAULTS.permissionMode);
        return runCliSeat({
          ctx,
          who: name,
          request,
          command: "codex",
          argv: ({ prompt, cwd }) =>
            buildCodexArgv({
              prompt,
              cwd,
              permissionMode: mode,
              // The model rides on the command line for this backend — Codex
              // has no model environment variable — and only when it can
              // actually be honoured.
              ...(connection === undefined ? {} : { model: modelArgumentFor(connection) }),
              // The endpoint, as a one-off provider. Dropped until now, so a
              // codex connection's address was stored, shown, and ignored.
              ...(connection?.endpoint === undefined ? {} : { endpoint: connection.endpoint }),
              ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
            }),
          // Resolved per start, so a rotated key reaches this turn.
          env: {
            ...(config.env ?? {}),
            ...(connection === undefined ? {} : await ctx.seatConnections.envFor(connection.connectionId)),
          },
          parse: readCodexStream,
          limits,
          disposeGraceMs: config.disposeGraceMs ?? DEFAULTS.disposeGraceMs,
        });
      },
    };
  }
}

export function apply(ctx: Context, config?: Config): void {
  ctx.plugin(SquadSeatCodex, config);
}

export { buildCodexArgv, isCodexMode } from "./argv.ts";
export type { CodexArgvInput, CodexPermissionMode } from "./argv.ts";
export { readCodexStream } from "./stream.ts";
export type { CodexOutcome } from "./stream.ts";
