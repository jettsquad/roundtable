import type { Context } from "@deepseek-ai/cordis";
import { TeamsService } from "./service.ts";

export const name = "squad-table";
export const inject = ["agents", "subagents"];

export function apply(ctx: Context): void {
  ctx.plugin(TeamsService);
}

export { TeamsService } from "./service.ts";
export type { AgendaOutcome, CreateTeamInput, SeatReply, TeamAssembler, Team, TranscriptEvent } from "./service.ts";
export { planPhase, pausesAfter, roundsOf, windowPolicyOf } from "./agenda.ts";
export type { PlannedRun, WindowPolicy } from "./agenda.ts";
export { composeSeatPrompt } from "./seat.ts";
export type { SeatBackend, SeatSpec, SeatTurnInput } from "./seat.ts";
