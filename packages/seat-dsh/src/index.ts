/**
 * @squad/seat-dsh — a DeepSeek Harness seat backend.
 *
 * Registered as `dsh-sdk`, the name `providerForSeat` already asks for. Until
 * now nothing answered it: a `dsh` agent saved, rendered in the library, and
 * failed at its first round naming a provider nobody typed.
 *
 * It runs `dsh --profile headless <prompt>` — the harness's own documented
 * one-shot entry point — as a child process, exactly like the other two
 * backends. A seat is a fresh process that remembers nothing, and running it
 * in-process inside THIS harness would give it the host's own context, which
 * is the opposite of what a seat is.
 *
 * No tool fence and no persona, declared as such: the headless profile takes
 * one task and has neither argument. Squad's seats carry their standing
 * instructions inside the prompt text already.
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import { NO_START_CAPABILITIES, type SubagentProvider, type SubagentRun } from "@deepseek-ai/dsh-subagent";
// Imported for the `Context.subprocess` declaration merging it carries.
import type {} from "@deepseek-ai/dsh-subprocess";
import { providerName, type SeatConnection } from "@squad/shared";
import { runCliSeat } from "@squad/seat-runtime";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDshArgv } from "./argv.ts";
import { buildDshPatch, COMPAT_API_KEY_ENV } from "./patch.ts";
import { readDshOutput } from "./stream.ts";

export const name = "squad-seat-dsh";

export const inject = ["subagents", "subprocess", "seatConnections"];

export interface Config {
  /** Registry name. `dsh-sdk` is what `providerForSeat` asks for. */
  readonly provider?: string;
  /**
   * The executable, when `dsh` is not on PATH.
   *
   * It often is not: the harness ships a `dsh` bin but a person running it
   * as `node …/bin.js` never linked one, and then a seat fails with "command
   * not found" for a program that is plainly installed. An absolute path
   * here is the answer, and the Agent test names this setting when the
   * lookup fails.
   */
  readonly command?: string;
  /** The dsh profile a seat boots. It must answer one task and exit. */
  readonly profile?: string;
  readonly idleMs?: number;
  readonly firstOutputMs?: number;
  readonly pollMs?: number;
  readonly disposeGraceMs?: number;
  readonly env?: Record<string, string>;
}

const DEFAULTS = {
  provider: "dsh-sdk",
  command: "dsh",
  profile: "headless",
  idleMs: 600_000,
  firstOutputMs: 90_000,
  pollMs: 5_000,
  disposeGraceMs: 5_000,
};

export class SquadSeatDsh extends Service {
  static readonly inject = ["subagents", "subprocess", "seatConnections"];

  private readonly config: Config;
  private readonly perConnection = new Map<string, () => void>();

  constructor(ctx: Context, config?: Config) {
    super(ctx, "squadSeatDsh");
    this.config = config ?? {};
  }

  async [Service.init](): Promise<void> {
    this.ctx.effect(() => this.ctx.subagents.registerProvider(this.provider()));
    this.syncConnections();
    this.ctx.effect(() => this.ctx.seatConnections.watch(() => this.syncConnections()));
    this.ctx.effect(() => () => {
      for (const dispose of this.perConnection.values()) dispose();
      this.perConnection.clear();
    });
  }

  /**
   * One registration per connection.
   *
   * No permission-mode axis: the headless profile has no sandbox or approval
   * flags to vary, so registering a mode would be a name that promises
   * something the child never receives.
   */
  private syncConnections(): void {
    const base = this.config.provider ?? DEFAULTS.provider;
    const wanted = new Set<string>();
    for (const connection of this.ctx.seatConnections.list()) {
      if (connection.backend !== "dsh") continue;
      const key = providerName(base, connection.connectionId);
      wanted.add(key);
      if (this.perConnection.has(key)) continue;
      this.perConnection.set(key, this.ctx.subagents.registerProvider(this.provider(connection)));
    }
    for (const [key, dispose] of [...this.perConnection]) {
      if (wanted.has(key)) continue;
      dispose();
      this.perConnection.delete(key);
    }
  }

  private provider(connection?: SeatConnection): SubagentProvider {
    const config = this.config;
    const ctx = this.ctx;
    const base = config.provider ?? DEFAULTS.provider;
    return {
      name: providerName(base, connection?.connectionId),
      capabilities: { ...NO_START_CAPABILITIES, toolFilter: false, persona: false },
      inheritsParentContext: false,

      async start(request): Promise<SubagentRun> {
        // The connection's model and endpoint, as a one-shot profile patch.
        // dsh has no environment variable for either, so this is the only
        // way they can take effect — and without it a MiniMax key goes to
        // DeepSeek's endpoint and comes back as an invalid key.
        const patch =
          connection === undefined
            ? undefined
            : buildDshPatch({
                model: (connection.modelId ?? "").trim(),
                baseUrl: (connection.endpoint ?? "").trim(),
              });
        let patchDir: string | undefined;
        let patchPath: string | undefined;
        if (patch !== undefined) {
          patchDir = await mkdtemp(join(tmpdir(), "squad-dsh-"));
          patchPath = join(patchDir, "seat.patch.yml");
          // 0600: the file names an env var rather than carrying the secret,
          // but it still describes where this seat sends its traffic.
          await writeFile(patchPath, patch, { mode: 0o600 });
        }

        const env = {
          ...(config.env ?? {}),
          ...(connection === undefined ? {} : await ctx.seatConnections.envFor(connection.connectionId)),
        };
        // The compat provider reads its key from its own variable. Set from
        // whatever the connection resolved, so one credential serves both
        // routes and neither is left unset depending on the model's family.
        const key = env["DEEPSEEK_API_KEY"];
        if (key !== undefined) env[COMPAT_API_KEY_ENV] = key;

        return runCliSeat({
          ctx,
          who: name,
          request,
          command: config.command ?? DEFAULTS.command,
          argv: ({ prompt }) =>
            buildDshArgv({
              prompt,
              profile: config.profile ?? DEFAULTS.profile,
              ...(patchPath === undefined ? {} : { patchPath }),
            }),
          env,
          // Removed after the run either way. A patch left behind describes
          // where a seat sent its traffic, in a world-readable temp dir.
          cleanup:
            patchDir === undefined
              ? undefined
              : async () => {
                  await rm(patchDir, { recursive: true, force: true }).catch(() => undefined);
                },
          parse: readDshOutput,
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

export function apply(ctx: Context, config?: Config): void {
  ctx.plugin(SquadSeatDsh, config);
}

export { buildDshArgv } from "./argv.ts";
export { buildDshPatch, COMPAT_API_KEY_ENV, COMPAT_ROUTE, isDeepSeekModel } from "./patch.ts";
export { readDshOutput } from "./stream.ts";
