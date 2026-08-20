/**
 * tasks.ts — what the secretary writes, and what it refuses.
 *
 * Separated from the service so the refusals are testable without a harness.
 * They are the part worth testing: the prompt builders already have their own
 * tests, and the service around this is a thin adapter that hands a subagent
 * some text. What matters is what happens when the answer comes back wrong,
 * and that is exactly the path an integration test exercises least.
 */
import { buildCheckpointPrompt, validateCheckpoint, type CheckpointPromptInput } from "./checkpoint.ts";
import { buildTeamAgendaTerminationPrompt, validateTeamAgendaTerminationSummary } from "./termination.ts";

/** What one finished text task produced. */
export interface TextTaskResult {
  readonly text: string;
  /** dsh's stop reason; only `completed` is an answer. */
  readonly stopReason: string;
}

/** Runs one self-contained text task and returns its result. */
export type TextTaskRunner = (label: string, prompt: string) => Promise<TextTaskResult>;

/** Everything the hand-off document needs. */
export interface TerminationInput {
  readonly objective: string;
  readonly reason: string;
  readonly completed: readonly string[];
  readonly remaining: readonly string[];
  readonly artifacts: readonly string[];
  readonly discussion: readonly string[];
}

/**
 * Write the context checkpoint that stands in for the discussion it folds.
 *
 * Refused unless all four headings are present. A checkpoint missing
 * 「未决分歧」 does not read as broken — it reads as a team that agreed, and
 * every later round inherits a consensus that never happened.
 */
export async function writeCheckpointWith(run: TextTaskRunner, input: CheckpointPromptInput): Promise<string> {
  const text = await settled(run, "秘书 · 检查点", buildCheckpointPrompt(input));
  const check = validateCheckpoint(text);
  if (!check.ok) {
    throw new Error(
      `秘书写出的检查点缺少标题：${check.missing.join("、")}。` +
        `检查点是后续每一轮的历史，残缺的那一节会被当成「这方面没有内容」，而不是「这里丢了」。`,
    );
  }
  return text;
}

/**
 * Write the hand-off for an agenda that was stopped early.
 *
 * Same refusal, same reason: a hand-off with a hole reads as complete to
 * whoever picks it up, and starts them in the wrong place.
 */
export async function writeTerminationWith(run: TextTaskRunner, input: TerminationInput): Promise<string> {
  const text = await settled(run, "秘书 · 中止交接", buildTeamAgendaTerminationPrompt(input));
  const check = validateTeamAgendaTerminationSummary(text);
  if (!check.ok) {
    throw new Error(
      `秘书写出的中止交接文档缺少标题：${check.missing.join("、")}。` +
        `交接文档缺一节，接手的人会当成那一节本来就没有内容，从错的地方开始。`,
    );
  }
  return text;
}

/**
 * Run a task and accept only a completed one.
 *
 * A stop reason other than `completed` is an error, not a short answer.
 * `max-tokens` is the dangerous one: it returns real text that simply stops
 * partway, so it can pass heading validation and still end mid-sentence.
 */
async function settled(run: TextTaskRunner, label: string, prompt: string): Promise<string> {
  const result = await run(label, prompt);
  if (result.stopReason !== "completed") {
    throw new Error(`秘书任务「${label}」未完成（${result.stopReason}），产出不予采用。`);
  }
  return result.text;
}
