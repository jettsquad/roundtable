/**
 * agenda.ts — the shape of a confirmed agenda.
 *
 * Here rather than in either plugin because it genuinely has two consumers,
 * which is the only thing that earns a place in this package: ③ the secretary
 * PROPOSES one from the host's instruction, ① the table EXECUTES one the host
 * confirmed. Neither may import the other, and a vocabulary both sides must
 * agree on cannot live on one side of that wall.
 *
 * Nothing here trusts the producer. An agenda arrives as JSON a model wrote,
 * so the schema is strict (unknown keys rejected, not ignored) and the roster
 * is checked separately: a task addressed to a seat that does not exist is
 * the failure this file exists to catch, because at execution time it looks
 * like a seat that simply had nothing to say.
 */
import { z } from "zod";
import { ACTION_KINDS, FEATURE_FLAGS } from "./situation.ts";

export const AgendaTaskSchema = z
  .object({
    seatId: z.string().min(1),
    instruction: z.string().min(1),
    publicContextCutoff: z.enum(["phase-start", "immediately-before-turn"]).optional(),
    /**
     * Only when the host asked for a document. The program writes the file
     * itself, so this is a path it executes rather than an instruction an
     * agent must be trusted to follow — and an invented path sends later
     * turns to a file that does not exist.
     */
    artifactPath: z.string().min(1).max(400).optional(),
  })
  .strict();

export const AgendaPhaseSchema = z
  .object({
    title: z.string().min(1),
    purpose: z.string().min(1).optional(),
    /**
     * `independent` — every seat sees the discussion as it stood when the
     * phase opened; `cumulative` — each sees the ones before it in this phase.
     */
    contextMode: z.enum(["independent", "cumulative"]),
    tasks: z.array(AgendaTaskSchema).min(1),
    /**
     * What KIND of decision this phase makes.
     *
     * Declared here because drafting a phase already is deciding what it is
     * for — the secretary is choosing that anyway, and the host sees and can
     * change it in the draft. Exactly the shape `artifactPath` already has,
     * reusing a mechanism that runs rather than inventing a second one.
     *
     * It is what lets the criteria library be consulted at the moment a phase
     * opens instead of only when someone remembers to ask. Optional: a phase
     * that declares nothing simply gets no criteria, which is the same as
     * today rather than a failure.
     */
    situation: z
      .object({
        action: z.enum(ACTION_KINDS),
        features: z.array(z.enum(FEATURE_FLAGS)).default([]),
      })
      .strict()
      .optional(),
    exit: z.enum(["after-tasks", "after-bounded-rounds", "wait-for-host"]).optional(),
    maxRounds: z.number().int().positive().optional(),
  })
  .strict();

export const AgendaSpecSchema = z
  .object({
    hostGoal: z.string().min(1).optional(),
    phases: z.array(AgendaPhaseSchema).min(1),
  })
  .strict();

export type AgendaTask = z.infer<typeof AgendaTaskSchema>;
export type AgendaPhase = z.infer<typeof AgendaPhaseSchema>;
export type AgendaSpec = z.infer<typeof AgendaSpecSchema>;

/** Structural validation only; see `checkAgendaAgainstRoster` for the rest. */
export const parseAgendaSpec = (value: unknown): AgendaSpec => AgendaSpecSchema.parse(value);

export interface AgendaProblem {
  readonly phase: string;
  readonly detail: string;
}

/**
 * The checks a schema cannot make.
 *
 * 1.x asked the model in the prompt to use only the listed seat ids and never
 * verified that it had. A hallucinated seat id survives parsing, and at
 * execution time a task nobody can run is indistinguishable from a seat that
 * had nothing to say — the whole family of failures this project keeps
 * finding. Same for a bounded-rounds phase with no bound: it parses, and then
 * repeats until something else stops it.
 */
export function checkAgendaAgainstRoster(agenda: AgendaSpec, seatIds: readonly string[]): readonly AgendaProblem[] {
  const known = new Set(seatIds);
  const problems: AgendaProblem[] = [];
  for (const phase of agenda.phases) {
    for (const task of phase.tasks) {
      if (!known.has(task.seatId)) {
        problems.push({ phase: phase.title, detail: `点名了不存在的席位「${task.seatId}」` });
      }
    }
    if (phase.exit === "after-bounded-rounds" && phase.maxRounds === undefined) {
      problems.push({ phase: phase.title, detail: "exit 是 after-bounded-rounds，却没有给 maxRounds" });
    }
    if (phase.exit !== "after-bounded-rounds" && phase.maxRounds !== undefined) {
      problems.push({ phase: phase.title, detail: "给了 maxRounds，但 exit 不是 after-bounded-rounds" });
    }
  }
  return problems;
}
