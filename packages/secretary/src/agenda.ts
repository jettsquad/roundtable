/**
 * agenda.ts — turning a host's sentence into a structured agenda.
 *
 * The secretary proposes; it never schedules. What comes back is a draft the
 * host confirms, which is why nothing here starts anything — the whole point
 * of the machine-proposes/human-decides split is that a wrong agenda costs a
 * confirmation click rather than a team's afternoon.
 *
 * The model's reply is JSON it wrote, so it is treated as hostile input all
 * the way through: prose around the object is tolerated, the schema is
 * strict, and the roster check runs afterwards because the shape being legal
 * says nothing about the seats being real.
 */
// Re-exported so existing importers keep working; the RULE lives in shared
// because it is about the host's own sentence, not about this service — and
// the console needs it too, on the other side of the plugin wall.
import { assertPublicHostCommand } from "@squad/shared";

export { assertPublicHostCommand };
import {
  ACTION_KINDS,
  FEATURE_FLAGS,
  checkAgendaAgainstRoster,
  extractJsonObject,
  parseAgendaSpec,
  type AgendaSpec,
} from "@squad/shared";

/** One seat as the drafting prompt needs to see it. */
export interface RosterSeat {
  readonly seatId: string;
  readonly displayName: string;
}

export interface AgendaDraftInput {
  /** The host's own words. */
  readonly command: string;
  readonly topic: string;
  readonly seats: readonly RosterSeat[];
}

/** Build the drafting instruction. English on purpose: it asks for JSON, and the schema names are English. */
export function buildAgendaPrompt(input: AgendaDraftInput): string {
  const roster = input.seats.map((seat) => `${seat.seatId} (${seat.displayName})`).join(", ");
  return [
    "You are a meeting secretary. Convert the host's instruction into a JSON team agenda.",
    "Reply with ONLY a JSON object (no prose, no code fence) matching exactly this shape:",
    '{"hostGoal"?: string, "phases": [{"title": string, "purpose"?: string, "contextMode": "independent"|"cumulative", "situation"?: {"action": string, "features": string[]}, "tasks": [{"seatId": string, "instruction": string, "publicContextCutoff"?: "phase-start"|"immediately-before-turn", "artifactPath"?: string}], "exit"?: "after-tasks"|"after-bounded-rounds"|"wait-for-host", "maxRounds"?: number}]}',
    'Rules: use only the seatIds listed below; every phase needs at least one task; a phase that repeats rounds uses exit "after-bounded-rounds" WITH a positive integer maxRounds, and no other phase may set maxRounds.',
    'Set "artifactPath" ONLY when the host explicitly asks for that task\'s answer to be written to a file, and only with a path they actually name (relative to the project folder, e.g. "docs/review.md"). Never invent one: the app writes the file itself, so a made-up path sends later turns to a file that does not exist. Omit it otherwise.',
    'Set "contextMode" to "independent" when the host wants each member to answer without seeing the others (e.g. 各自独立评审); otherwise "cumulative".',
    // Labelling the phase is not extra work asked of the model — deciding
    // what a phase is FOR is what drafting it already consists of. Naming it
    // is what lets the host's own criteria be consulted when the phase opens,
    // instead of only when somebody remembers to ask.
    `Set "situation" to describe what KIND of decision the phase makes. "action" is exactly one of: ${ACTION_KINDS.join(", ")}. "features" are properties of the thing being decided about, zero or more of: ${FEATURE_FLAGS.join(", ")}. Both lists are CLOSED — never invent a value; omit "situation" entirely if none of them fit.`,
    `Seats (use these exact seatIds): ${roster}.`,
    `Topic: ${input.topic}`,
    `Host instruction: ${input.command}`,
  ].join("\n");
}

/**
 * Pull the JSON object out of a reply that may carry stray prose.
 *
 * The rule itself lives in `@squad/shared` because the console needs the same
 * tolerance for team plans, on the other side of the plugin wall. What stays
 * here is the message: 「秘书没有返回 JSON」 says which job failed, which a
 * generic parse error cannot.
 */
export function extractJson(text: string): unknown {
  return extractJsonObject(text, "秘书没有返回 JSON 对象，无法解析成议程。");
}

/**
 * Parse and vet a drafting reply.
 *
 * Roster problems are refused rather than reported alongside a usable draft:
 * a draft the host can confirm is a draft the table will run, and a task
 * addressed to a seat that does not exist reads at execution time as a seat
 * that had nothing to say.
 */
export function parseAgendaReply(text: string, seats: readonly RosterSeat[]): AgendaSpec {
  const agenda = parseAgendaSpec(extractJson(text));
  const problems = checkAgendaAgainstRoster(
    agenda,
    seats.map((seat) => seat.seatId),
  );
  if (problems.length > 0) {
    throw new Error(
      `秘书拟的议程有问题，未采用：\n${problems.map((p) => `- 阶段「${p.phase}」：${p.detail}`).join("\n")}`,
    );
  }
  return agenda;
}
