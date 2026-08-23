/**
 * @squad/secretary — 秘书（`ctx.secretary`）。四个插件里的 ③。
 *
 * The one seat allowed to do judgement work for the host: it reads the
 * discussion and writes the documents the rest of the system then treats as
 * fact — the context checkpoint every later round inherits, and the hand-off
 * an interrupted agenda leaves behind.
 *
 * Which is why nothing here accepts partial output. These documents are read
 * by machines and by whoever picks the work up next, and a missing section
 * does not announce itself as missing; it reads as a section with nothing in
 * it. A checkpoint without 「未决分歧」 reads as a team that agreed.
 */
import type { Context } from "@deepseek-ai/cordis";
import { SecretaryService } from "./service.ts";

export const name = "squad-secretary";

/** Only `subagents`: the secretary is stateless and holds no team state. */
export const inject = ["subagents"];

export function apply(ctx: Context): void {
  ctx.plugin(SecretaryService);
}

export { SecretaryService } from "./service.ts";
export {
  agendaFromReplyWith,
  assistWith,
  draftAgendaWith,
  writeCheckpointWith,
  writeTerminationWith,
} from "./tasks.ts";
export type { TerminationInput, TextTaskResult, TextTaskRunner } from "./tasks.ts";
export type { DraftAgendaInput, SecretaryRun, WriteCheckpointInput, WriteTerminationInput } from "./service.ts";
export { assertPublicHostCommand, buildAgendaPrompt, extractJson, parseAgendaReply } from "./agenda.ts";
export { buildAssistPrompt, validateAssist } from "./assist.ts";
export type { AssistInput, AssistLine } from "./assist.ts";
export type { AgendaDraftInput, RosterSeat } from "./agenda.ts";

export {
  CHECKPOINT_HEADINGS,
  CHECKPOINT_HEADING_LIST,
  buildCheckpointPrompt,
  validateCheckpoint,
} from "./checkpoint.ts";
export type { CheckpointPromptInput, CheckpointSourceTurn, CheckpointValidation } from "./checkpoint.ts";

export {
  TERMINATION_SUMMARY_HEADINGS,
  buildTeamAgendaTerminationPrompt,
  validateTeamAgendaTerminationSummary,
} from "./termination.ts";
