/**
 * @squad/context — 上下文装配（`ctx.teamContext`）。四个插件里的 ②。
 *
 * It answers one question and owns it alone: what does this seat see this
 * round? A seat is a fresh process every round and knows only what it is
 * handed, so this is not a formatting concern — it is the whole of what a
 * seat can remember.
 *
 * Assembly is TWO layers, and in 1.x they disagreed. `window.ts` decides
 * WHICH recorded events travel; `timeline.ts` decides HOW they read. The
 * rendering layer ended in a catch-all that dropped unknown kinds, so the
 * checkpoint was cut out of history by the first layer and then thrown away
 * by the second — history gone, replacement gone, no error. Keeping the two
 * layers named and separate is the point, not an implementation detail.
 */
import type { Context } from "@deepseek-ai/cordis";
import { TeamContextService } from "./service.ts";

export const name = "squad-context";

/**
 * `teams` because this reads the team record and registers itself on the
 * table; `storageDomain` because checkpoints do not live in the session log
 * (see domain.ts). The arrow never runs the other way — the table must not
 * inject this service, or neither could start.
 */
export const inject = ["teams", "storageDomain"];

export function apply(ctx: Context): void {
  ctx.plugin(TeamContextService);
}

export { TeamContextService } from "./service.ts";
export type { RecordCheckpointInput } from "./service.ts";

export { SQUAD_TEAMS_DOMAIN } from "./domain.ts";
export type { CheckpointRecord } from "./domain.ts";

export { mergeCheckpoints } from "./merge.ts";
export { planFold } from "./plan.ts";
export type { FoldPlan, PlannedTurn } from "./plan.ts";
export type { MergeableCheckpoint, TranscriptEntry } from "./merge.ts";

export { selectContextEvents, QUOTED_PREFIX, CHECKPOINT_KIND, CHECKPOINT_REVOKED_KIND } from "./window.ts";
export type { SelectableEvent } from "./window.ts";

export {
  renderTimeline,
  renderTimelineEvent,
  CHECKPOINT_TIMELINE_PREFIX,
  SPEECH_KIND,
  TIMELINE_IGNORED_KINDS,
  HOST_TURN_KINDS,
} from "./timeline.ts";
