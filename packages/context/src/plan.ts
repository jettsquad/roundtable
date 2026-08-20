/**
 * plan.ts — what one fold covers, and what it is given to work from.
 *
 * Three decisions live here, and 1.x got each of them wrong at least once:
 *
 *   The boundary is the LAST ENTRY THAT EXISTS WHEN THE FOLD STARTS, named up
 *   front. The secretary writes without stopping the team, so rounds land
 *   while it works and are recorded before the checkpoint is stored. If the
 *   window were later cut at the checkpoint's position instead, those turns —
 *   which the checkpoint never saw — would be cut away with nothing standing
 *   in for them.
 *
 *   The input is EVERYTHING SINCE THE LAST CHECKPOINT, not the window. They
 *   differ, and taking the window would feed each checkpoint the previous
 *   checkpoint's own output, compounding its losses once per fold.
 *
 *   The previous checkpoint is passed AS INPUT, not re-summarised. Settled
 *   items are inherited verbatim; re-condensing a condensed document loses a
 *   little more of it every time.
 */
import type { SelectableEvent } from "./window.ts";

/** One recorded turn, in the shape the checkpoint prompt takes. */
export interface PlannedTurn {
  readonly speaker: string;
  readonly text: string;
}

export interface FoldPlan {
  /** Identity of the last entry this fold will cover. */
  readonly coversUpTo: string;
  readonly turns: readonly PlannedTurn[];
  /** The checkpoint this one supersedes, when the team has a live one. */
  readonly previousCheckpoint?: string | undefined;
}

/**
 * Plan a fold over the entries recorded since the last live checkpoint.
 *
 * Returns `undefined` when there is nothing to fold — a team can cross the
 * threshold on a record whose entries carry no identity, and folding that
 * would store a checkpoint covering a boundary nobody can find later.
 */
export function planFold(
  pending: readonly SelectableEvent[],
  previousCheckpoint?: string | undefined,
): FoldPlan | undefined {
  const coversUpTo = lastIdentity(pending);
  if (coversUpTo === undefined) return undefined;
  return {
    coversUpTo,
    turns: pending.map(plannedTurn),
    ...(previousCheckpoint === undefined ? {} : { previousCheckpoint }),
  };
}

/** Split a recorded line back into who spoke and what they said. */
function plannedTurn(event: SelectableEvent): PlannedTurn {
  const text = typeof event.text === "string" ? event.text : "";
  const match = /^【(.+?)】([\s\S]*)$/.exec(text);
  return { speaker: match?.[1] ?? "记录", text: match?.[2] ?? text };
}

/**
 * Identity of the last entry carrying one.
 *
 * Searched from the end rather than taken from the last element: an entry
 * without an identity is not a boundary anything can be cut at, and treating
 * it as one would store a `coversUpTo` that matches nothing — which the merge
 * layer reads as a checkpoint whose coverage is missing from the log.
 */
function lastIdentity(events: readonly SelectableEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const turnId = events[index]?.turnId;
    if (typeof turnId === "string") return turnId;
  }
  return undefined;
}
