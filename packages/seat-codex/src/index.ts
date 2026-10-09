/**
 * @squad/seat-codex — a Codex seat backend.
 *
 * The reason it exists: the Agent library offered `codex` as a backend and
 * nothing registered a provider for it, so a Codex agent saved, rendered,
 * and then failed at its first round asking for a provider name nobody
 * typed. Storable, renderable, ignored — for the third time in this project,
 * and this is the fix rather than another label saying so.
 *
 * NO TOOL FILTER. `codex exec` takes no per-tool allow or deny list, so the
 * capability is declared `toolFilter: false` and the seam REJECTS a request
 * that asks for one, instead of accepting it and quietly not applying it.
 *
 * Delegation IS fenced, but not through a tool list. This used to say
 * `codex exec` had no delegation tool to deny; that stopped being true when
 * Codex's `multi_agent` feature went stable and on by default, and seats on
 * this backend could spawn subagents with nothing stopping them. The fence
 * is the feature flag, set on the command line — see `CodexArgvInput.subagents`.
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
import {
  CODEX_PERMISSION_MODES,
  liveConnection,
  modelArgumentFor,
  providerName,
  type SeatConnection,
} from "@squad/shared";
import { requestedEffort, runCliSeat, seatSessionId, SEAT_SILENCE_LIMITS } from "@squad/seat-runtime";
import { buildCodexArgv, isCodexMode } from "./argv.ts";
import { readCodexStream } from "./stream.ts";

export const name = "squad-seat-codex";

export const inject = ["subagents", "subprocess", "seatConnections"];

export interface Config {
  /** Registry name for the host's own `codex login`, with no connection. */
  readonly provider?: string;
  readonly permissionMode?: (typeof CODEX_PERMISSION_MODES)[number];
  /**
   * A fallback for agents that chose nothing. An agent's own level travels
   * on the request and wins — it used to be saved on the agent and never
   * read, so every codex seat ran on this one plugin-wide value.
   */
  readonly reasoningEffort?: string;
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
  idleMs: SEAT_SILENCE_LIMITS.idleMs,
  firstOutputMs: SEAT_SILENCE_LIMITS.firstOutputMs,
  pollMs: SEAT_SILENCE_LIMITS.pollMs,
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
    // The host's own `codex login`, nothing injected — once closed, once open,
    // because the web axis has to exist for connectionless seats too.
    // Crossed with delegation, which is argv too.
    for (const web of [false, true]) {
      for (const sub of [false, true]) {
        this.ctx.effect(() => this.ctx.subagents.registerProvider(this.provider(undefined, undefined, web, sub)));
      }
    }
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
        // Times two, for the web axis. The sandbox flag rides on argv and argv
        // attaches here, so a seat that may reach the network and one that may
        // not are two registrations — not one provider reading a request field
        // the seam does not carry.
        for (const web of [false, true]) {
          for (const sub of [false, true]) {
            const key = providerName(BASE, connection.connectionId, mode, web, false, sub);
            wanted.add(key);
            if (this.perConnection.has(key)) continue;
            this.perConnection.set(key, this.ctx.subagents.registerProvider(this.provider(connection, mode, web, sub)));
          }
        }
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

  private provider(
    registered?: SeatConnection,
    permissionMode?: string,
    webAccess = false,
    subagents = false,
  ): SubagentProvider {
    const config = this.config;
    const ctx = this.ctx;
    const limits = {
      idleMs: config.idleMs ?? DEFAULTS.idleMs,
      firstOutputMs: config.firstOutputMs ?? DEFAULTS.firstOutputMs,
      pollMs: config.pollMs ?? DEFAULTS.pollMs,
    };
    return {
      name:
        registered === undefined && permissionMode === undefined && !webAccess && !subagents
          ? (config.provider ?? DEFAULTS.provider)
          : providerName(BASE, registered?.connectionId, permissionMode, webAccess, false, subagents),
      // Declared honestly. `codex exec` has no per-tool filter and no
      // system-prompt argument, so the seam should REFUSE a request asking
      // for either rather than accept one and ignore it.
      capabilities: { ...NO_START_CAPABILITIES, toolFilter: false, persona: false, agentOptions: true },
      inheritsParentContext: false,

      async start(request): Promise<SubagentRun> {
        // As it stands now, not as it stood at registration: the model and
        // endpoint ride on argv, and an edit has to reach the next turn.
        // See `liveConnection`.
        const connection = liveConnection(registered, (id) => ctx.seatConnections.get(id));
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
              // Same as the Claude backend, and worth less here: a fresh codex
              // thread carries about 17.6k of standing prefix against
              // Claude's 93k, so resuming saves roughly a quarter as much.
              ...(() => {
                const resume = seatSessionId(request.parent.session.id, request.label);
                return resume === undefined ? {} : { resumeSessionId: resume };
              })(),
              permissionMode: mode,
              // The model rides on the command line for this backend — Codex
              // has no model environment variable — and only when it can
              // actually be honoured.
              ...(connection === undefined ? {} : { model: modelArgumentFor(connection) }),
              // The endpoint, as a one-off provider. Dropped until now, so a
              // codex connection's address was stored, shown, and ignored.
              ...(connection?.endpoint === undefined ? {} : { endpoint: connection.endpoint }),
              ...(() => {
                const effort = requestedEffort(request) ?? config.reasoningEffort;
                return effort === undefined ? {} : { reasoningEffort: effort };
              })(),
              // Opens the sandbox's way out. Closed by default, so a seat
              // without the checkbox keeps exactly the argv it had before.
              webAccess,
              subagents,
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
