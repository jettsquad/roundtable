import type { Context } from "@deepseek-ai/cordis";
import { TeamsService } from "./service.ts";

export const name = "squad-table";
export const inject = ["agents", "subagents"];

export function apply(ctx: Context): void {
  ctx.plugin(TeamsService);
}

export { TeamsService } from "./service.ts";
export type { CreateTeamInput, SeatReply, Team } from "./service.ts";
export { composeSeatPrompt } from "./seat.ts";
export type { SeatBackend, SeatSpec, SeatTurnInput } from "./seat.ts";
