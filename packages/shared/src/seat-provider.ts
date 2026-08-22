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
export function providerNameFor(connectionId?: string, permissionMode?: string): string {
  const base = connectionId === undefined || connectionId === "" ? SEAT_PROVIDER : `${SEAT_PROVIDER}/${connectionId}`;
  return permissionMode === undefined || permissionMode === "" ? base : `${base}#${permissionMode}`;
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
}): string {
  if (seat.backend !== "claude-code") return PROVIDER_BY_BACKEND[seat.backend] ?? seat.backend;
  return providerNameFor(seat.connectionId, seat.permissionMode);
}
