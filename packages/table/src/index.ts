import type { Context } from "@deepseek-ai/cordis";
import { TeamsService } from "./service.ts";

export const name = "squad-table";
export const inject = ["agents", "subagents", "seatConnections", "sessions"];

export function apply(ctx: Context): void {
  ctx.plugin(TeamsService);
}

export { TeamsService, spokenMessage } from "./service.ts";
export type {
  AgendaOutcome,
  AgendaTermination,
  CreateTeamInput,
  SeatReply,
  TeamAssembler,
  Team,
  TranscriptEvent,
} from "./service.ts";
export { outstandingWork, planPhase, pausesAfter, roundsOf, windowPolicyOf } from "./agenda.ts";
export type { PlannedRun, WindowPolicy } from "./agenda.ts";
export { composeSeatPrompt } from "./seat.ts";
export type { SeatBackend, SeatSpec, SeatTurnInput } from "./seat.ts";
