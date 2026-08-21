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
 * The provider name serving one connection.
 *
 * The seam carries no per-request environment, so credentials attach at
 * registration — and the only thing a request carries that can select among
 * registrations is the provider name. Encoding the connection into it is what
 * lets one seat use a gateway while another uses the host's login.
 */
export const providerNameFor = (connectionId: string): string => `${SEAT_PROVIDER}/${connectionId}`;
