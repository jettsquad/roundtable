/**
 * @squad/connections — the reusable configuration library.
 *
 * Two services from one plugin: `ctx.seatConnections` (what a seat runs on)
 * and `ctx.agentTemplates` (reusable agents). One plugin rather than two
 * because a template references a connection: split apart they would be two
 * packages that always change in the same commit, with a wall between them
 * that only makes the change harder.
 *
 * Its own plugin because it has three consumers that may not import one
 * another: ① the table resolves a seat's connection, the seat backend applies
 * its environment, and the console edits it.
 *
 * It never holds a secret. Configuration carries a credential NAME; the value
 * lives with `ctx.credentials` and is resolved per operation.
 */
import type { Context } from "@deepseek-ai/cordis";
import { AgentTemplatesService } from "./agent-service.ts";
import { PromptBlocksService } from "./block-service.ts";
import { SeatConnectionsService } from "./service.ts";

export const name = "squad-connections";

export const inject = ["storageDomain", "credentials"];

export function apply(ctx: Context): void {
  ctx.plugin(SeatConnectionsService);
  ctx.plugin(AgentTemplatesService);
  ctx.plugin(PromptBlocksService);
}

export { SeatConnectionsService } from "./service.ts";

export { AgentTemplatesService } from "./agent-service.ts";

export { PromptBlocksService } from "./block-service.ts";
export type { LibraryBlock } from "./block-service.ts";

export { SQUAD_CONNECTIONS_DOMAIN } from "./domain.ts";
export type { ConnectionRecord } from "./domain.ts";
export { SQUAD_AGENTS_DOMAIN } from "./agent-domain.ts";
export { SQUAD_BLOCKS_DOMAIN } from "./block-domain.ts";
export type { PromptBlockRecord } from "./block-domain.ts";
export type { AgentTemplateRecord } from "./agent-domain.ts";
