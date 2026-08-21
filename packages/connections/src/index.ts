/**
 * @squad/connections — `ctx.seatConnections`: the seat connection library.
 *
 * Its own plugin because it has three consumers that may not import one
 * another: ① the table resolves a seat's connection, the seat backend applies
 * its environment, and the console edits it.
 *
 * It never holds a secret. Configuration carries a credential NAME; the value
 * lives with `ctx.credentials` and is resolved per operation.
 */
import type { Context } from "@deepseek-ai/cordis";
import { SeatConnectionsService } from "./service.ts";

export const name = "squad-connections";

export const inject = ["storageDomain", "credentials"];

export function apply(ctx: Context): void {
  ctx.plugin(SeatConnectionsService);
}

export { SeatConnectionsService } from "./service.ts";
export type { ConnectionView } from "./service.ts";
export { SQUAD_CONNECTIONS_DOMAIN } from "./domain.ts";
export type { ConnectionRecord } from "./domain.ts";
