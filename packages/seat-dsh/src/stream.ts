/**
 * stream.ts — reading a headless DSH run back into one answer.
 *
 * `dsh --profile headless` prints the final assistant message as PLAIN TEXT
 * and exits. There is no envelope, no JSONL, and therefore no accounting —
 * which is reported as absent rather than as zero. A turn that reported
 * nothing and a turn that cost nothing are different facts, and only one of
 * them is good news.
 */
import { stripReasoning } from "@squad/shared";
import type { SeatOutcome } from "@squad/seat-runtime";

export function readDshOutput(raw: string): SeatOutcome {
  // Reasoning is stripped for the same reason it is on the Claude backend:
  // a reply that is visibly the model thinking aloud reads as an answer to
  // everyone downstream, including the next round's carried discussion.
  const text = stripReasoning(raw).trim();
  return {
    text,
    // No answer is a failure. A seat that returns nothing reads as a member
    // with nothing to say, which is the one reading that hides a broken run.
    failed: text === "",
  };
}
