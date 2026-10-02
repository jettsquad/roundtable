/**
 * seat-provider.ts — which subagent provider a seat runs on.
 *
 * Here because three plugins name it: ① the table runs discussion seats, ③
 * the secretary runs its text tasks, ④ Lil X runs its distillation. They may
 * not import each other, and a provider name they must agree on cannot sit on
 * one side of that wall.
 *
 * The default is the FENCED provider, not the stock one. That is the whole
 * point of having written it: the stock provider hardcodes its tool policy,
 * so a seat can spawn its own subagents — which is how a 1.x secretary that
 * did not know the roster ended up inventing a team of its own to do the
 * work. Defaulting to the unfenced one would leave every caller responsible
 * for remembering, and the one that forgets is the one that matters.
 */

/** Registry name of the seat backend, unless a caller says otherwise. */
export const SEAT_PROVIDER = "claude-code-fenced";

/** The stock provider, kept reachable for comparison and for fallback. */
export const STOCK_SEAT_PROVIDER = "claude-code";

/**
 * The provider name serving one process configuration.
 *
 * The seam carries no per-request environment and no per-request argv, so
 * both attach at REGISTRATION — and the only thing a request carries that can
 * select among registrations is the provider name. Encoding the connection
 * into it is what lets one seat use a gateway while another uses the host's
 * login; the permission mode rides the same argument one axis further,
 * because it is likewise decided when the child process is spawned.
 *
 * Without this a per-agent permission mode would be storable, renderable, and
 * ignored — a setting the person believes is in force, which is worse than
 * not offering it.
 */
export function providerNameFor(
  connectionId?: string,
  permissionMode?: string,
  hostCustomizations?: boolean,
  subagents?: boolean,
): string {
  // `webAccess` is skipped deliberately: the Claude Code backend decides the
  // web per request through `toolFilter`, so it never registers on that axis.
  return providerName(SEAT_PROVIDER, connectionId, permissionMode, false, hostCustomizations, subagents);
}

/**
 * The same composition for any backend's base name.
 *
 * Spelled once, because both halves have to agree exactly: the backend
 * registers under this name and `providerForSeat` asks for it, and a
 * disagreement is not a type error — it is a round that fails with
 * "no provider registered" naming a string nobody typed.
 */
export function providerName(
  base: string,
  connectionId?: string,
  permissionMode?: string,
  webAccess?: boolean,
  hostCustomizations?: boolean,
  subagents?: boolean,
): string {
  const withConnection = connectionId === undefined || connectionId === "" ? base : `${base}/${connectionId}`;
  const withMode =
    permissionMode === undefined || permissionMode === "" ? withConnection : `${withConnection}#${permissionMode}`;
  // A fourth axis, and only ever added when it is on: leaving the name
  // untouched for `false` keeps every existing registration and every stored
  // provider string byte-identical, so this axis cannot break a backend that
  // does not use it.
  const withWeb = webAccess === true ? `${withMode}+web` : withMode;
  // A fifth, on the same terms and for the same reason: `--safe-mode` is an
  // argv flag, argv attaches at REGISTRATION, and `agentOptions` — the only
  // per-request options bag the seam has — is a closed set (provider, model,
  // reasoning effort, output cap). So "may this seat read the host's
  // CLAUDE.md" has nowhere else to travel.
  //
  // Appended AFTER `+web` so one name has one spelling. The two never
  // co-occur today — web rides only on codex, this only on claude-code — but
  // a name that depends on argument order is a name two callers can spell
  // differently, and the failure is an unregistered provider nobody typed.
  const withHostMd = hostCustomizations === true ? `${withWeb}+hostmd` : withWeb;
  // A sixth, on the same terms: whether the seat may spawn its own subagents
  // is a delegation tool left in or taken out of the child's argv (Claude
  // Code), a feature flag on it (Codex) or plugins in its profile patch (dsh)
  // — all fixed at spawn. Last, so a name has one spelling, and only when on,
  // so every existing registration keeps its name.
  return subagents === true ? `${withHostMd}+sub` : withHostMd;
}

/** The provider names the non-claude backends ask for. */
const PROVIDER_BY_BACKEND: Readonly<Record<string, string>> = {
  // The FENCED provider, not the stock one — see the note above.
  "claude-code": SEAT_PROVIDER,
  codex: "codex",
  dsh: "dsh-sdk",
};

/**
 * Which provider one seat runs on.
 *
 * The single derivation, because it was briefly written in two places and the
 * second one was wrong by omission: `@squad/context` asked the secretary to
 * fold a discussion without passing a provider at all, so the secretary's
 * configured model, connection and permission mode were stored, rendered in
 * the Agent library, and ignored. The judgement work ran on the host's bare
 * login instead — a setting that looks like it works, which is the failure
 * this project keeps having to design against.
 */
export function providerForSeat(seat: {
  readonly backend: string;
  readonly connectionId?: string | undefined;
  readonly permissionMode?: string | undefined;
  readonly webAccess?: boolean | undefined;
  readonly hostCustomizations?: boolean | undefined;
  readonly subagents?: boolean | undefined;
}): string {
  const base = PROVIDER_BY_BACKEND[seat.backend] ?? seat.backend;
  // dsh's headless profile has no sandbox or approval flags, so a mode in
  // its provider name would promise something the child never receives.
  const mode = seat.backend === "dsh" ? undefined : seat.permissionMode;
  // Codex alone selects on the web axis. Its sandbox opens with an argv flag
  // that has to be present at spawn, and argv attaches at REGISTRATION — so
  // "may this seat reach the network" can only travel in the provider name.
  // The other two backends decide it per request (claude-code via
  // `toolFilter`) or not at all (dsh always has `curl`), and giving them the
  // suffix would split their registry for a distinction they never read.
  const web = seat.backend === "codex" ? seat.webAccess === true : false;
  // Claude Code alone selects on this axis. It is the only backend whose CLI
  // auto-loads a configuration home, and so the only one with anything to
  // turn off; asking codex or dsh for `+hostmd` would split their registry
  // for a distinction their child process never reads.
  const hostMd = seat.backend === "claude-code" ? seat.hostCustomizations === true : false;
  // Every backend selects on this one: all three can spawn subagents, and all
  // three are fenced off from it unless the agent was created allowing it.
  return providerName(base, seat.connectionId, mode, web, hostMd, seat.subagents === true);
}
