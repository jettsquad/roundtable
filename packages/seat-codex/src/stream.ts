/**
 * stream.ts — reading `codex exec --json` back into one answer.
 *
 * The CLI emits JSONL: `thread.started`, `turn.started`, `item.completed`,
 * `turn.completed`, `turn.failed`, `error`. The agent's answer is the text of
 * the LAST `item.completed` whose item is an `agent_message`; accounting rides
 * on `turn.completed`.
 *
 * Last rather than concatenated, because a turn emits several agent messages
 * as it works and only the final one is the answer. Concatenating them
 * produces a reply that restates its own thinking — which is exactly the
 * failure `stripReasoning` exists to undo on the other backend.
 */
import type { SeatUsage } from "@squad/shared";

export interface CodexOutcome {
  readonly text: string;
  /** The CLI reported a failure, or nothing usable arrived. */
  readonly failed: boolean;
  /** The reason, when the CLI gave one. */
  readonly detail?: string | undefined;
  /**
   * What the turn consumed, when `turn.completed` carried it.
   *
   * Absent rather than zeroed: a turn that reported nothing and a turn that
   * cost nothing are different facts.
   */
  readonly usage?: SeatUsage | undefined;
}

interface CodexEvent {
  readonly type?: unknown;
  readonly item?: { readonly type?: unknown; readonly text?: unknown } | undefined;
  readonly usage?:
    | {
        readonly input_tokens?: unknown;
        readonly cached_input_tokens?: unknown;
        readonly output_tokens?: unknown;
      }
    | undefined;
  readonly message?: unknown;
  readonly error?: unknown;
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Parse the JSONL, skipping lines that are not JSON — stderr progress can interleave. */
function eventsOf(raw: string): readonly CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (text === "" || !text.startsWith("{")) continue;
    try {
      events.push(JSON.parse(text) as CodexEvent);
    } catch {
      // A truncated final line is normal when a run is killed mid-write.
      // Skipping it loses nothing the earlier events did not already carry.
    }
  }
  return events;
}

export function readCodexStream(raw: string): CodexOutcome {
  const events = eventsOf(raw);

  let text = "";
  for (const event of events) {
    if (event.type !== "item.completed") continue;
    const item = event.item;
    if (item?.type !== "agent_message" || typeof item.text !== "string") continue;
    text = item.text;
  }

  let usage: SeatUsage | undefined;
  for (const event of events) {
    if (event.type !== "turn.completed" || event.usage === undefined) continue;
    const input = count(event.usage.input_tokens);
    const cached = count(event.usage.cached_input_tokens);
    const output = count(event.usage.output_tokens);
    if (input === undefined && cached === undefined && output === undefined) continue;
    usage = {
      inputTokens: input ?? 0,
      outputTokens: output ?? 0,
      // Codex reports cached input as a subset of a read, not a creation.
      // Kept in its own column rather than folded into input: the whole
      // reason cache is tracked separately is that it is the number worth
      // acting on.
      cacheReadTokens: cached ?? 0,
      cacheCreationTokens: 0,
    };
  }

  const failure = events.find((event) => event.type === "turn.failed" || event.type === "error");
  const detail =
    failure === undefined
      ? undefined
      : typeof failure.message === "string"
        ? failure.message
        : typeof failure.error === "string"
          ? failure.error
          : "codex 报告了一个失败，但没有给出原因。";

  return {
    text,
    // No answer is a failure even without an error event: a seat that returns
    // nothing reads as a member with nothing to say, and that is the one
    // reading that hides a broken run.
    failed: failure !== undefined || text.trim() === "",
    ...(detail === undefined ? {} : { detail }),
    ...(usage === undefined ? {} : { usage }),
  };
}
