/**
 * @squad/reasoning — Lil X（`ctx.reasoning`）。四个插件里的 ④。
 *
 * The user's own criteria library: what they judge by, learned from the
 * moments they overruled the machine. It is user-level, not team-level —
 * `inject` deliberately omits `teams`, because a library that could only be
 * written from inside a project is the opposite of something you can take
 * with you.
 *
 * The write path is here: capture an occurrence, distil a proposal, wait for
 * the human. The read path — locating criteria by situation and delivering
 * them to the host and secretary but NEVER to discussion seats — comes next.
 */
import type { Context } from "@deepseek-ai/cordis";
import { ReasoningService, type Config } from "./service.ts";

export const name = "squad-reasoning";

/**
 * `subagents` for the distilling task and nothing else.
 *
 * Not `teams`: this belongs to the person, and nothing here should be able to
 * reach into a table. Not `secretary` either — the criteria library is ④'s,
 * both boundary tables say so, and the prompt that distils a criterion is a
 * decision about criteria.
 */
export const inject = ["subagents"];

export function apply(ctx: Context, config: Config): void {
  ctx.plugin(ReasoningService, config);
}

export { ReasoningService } from "./service.ts";
export type { CaptureResult, Config, LearningSignal, SignalKind, Verdict } from "./service.ts";

export { ReasoningStore, CRITERIA_DIR, INSTANCES_DIR, PROPOSALS_DIR } from "./store.ts";
export { criterionFromMarkdown, criterionToMarkdown, instanceToMarkdown } from "./criterion.ts";
export type { Criterion, CriterionStatus, Instance, Trigger } from "./criterion.ts";

export { buildDistilPrompt, parseDistillation } from "./distil.ts";
export type { DistilInput, Distillation, Relation } from "./distil.ts";

export {
  ACTION_KINDS,
  ACTION_KIND_LABELS,
  FEATURE_FLAGS,
  FEATURE_FLAG_LABELS,
  FRAMEWORK_STEPS,
  isActionKind,
  isFeatureFlag,
  isFrameworkStep,
  parseSituation,
} from "./situation.ts";
export type { ActionKind, FeatureFlag, FrameworkStep, Situation } from "./situation.ts";
