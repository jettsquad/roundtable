/**
 * stream.ts — reading a `stream-json` run back into one answer.
 *
 * Carried from 1.x, which had this right: prefer the assistant text streamed
 * during the turn over the `result` envelope's own text, because a long turn's
 * envelope can summarise while the assistant blocks carry what was actually
 * said. Fall back to the envelope when nothing streamed, and fall back again
 * to plain text when there is no envelope at all — an older CLI, or a run
 * that failed before stream-json started.
 *
 * Every fallback is a real case seen in production, which is why they are
 * ordered rather than collapsed into "take whatever is there".
 */
import type { SeatUsage } from "@squad/shared";

export type { SeatUsage };

// The shape lives in @squad/shared: the provider measures it and the table
// records it, and those two may not import each other.
export interface StreamOutcome {
  readonly text: string;
  /** The CLI reported an error result, or the process failed. */
  readonly failed: boolean;
  /** Present when the envelope carried one. */
  readonly subtype?: string | undefined;
  /**
   * What the run consumed, when the envelope carried accounting.
   *
   * Absent rather than zeroed when unknown: a turn that reported nothing and a
   * turn that genuinely cost nothing are different facts, and a total built
   * from zeroes reads as "cheap" instead of "unmeasured".
   */
  readonly usage?: SeatUsage | undefined;
}

interface StreamEvent {
  readonly type?: unknown;
  readonly subtype?: unknown;
  readonly is_error?: unknown;
  readonly result?: unknown;
  readonly message?: { readonly content?: unknown } | undefined;
  readonly usage?: unknown;
  readonly total_cost_usd?: unknown;
  readonly duration_ms?: unknown;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * Read the accounting off a result envelope.
 *
 * Field names verified against a live run rather than carried over from 1.x,
 * whose parser was written for an older CLI: the envelope now also holds
 * `modelUsage`, `iterations`, cache-creation breakdowns and timing that were
 * not there before. Only the four token counters plus cost and duration are
 * taken — the rest is real but not ours to interpret.
 */
function usageOf(envelope: StreamEvent): SeatUsage | undefined {
  const usage = envelope.usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const record = usage as Record<string, unknown>;
  return {
    inputTokens: count(record["input_tokens"]),
    outputTokens: count(record["output_tokens"]),
    cacheReadTokens: count(record["cache_read_input_tokens"]),
    cacheCreationTokens: count(record["cache_creation_input_tokens"]),
    ...(typeof envelope.total_cost_usd === "number" ? { costUsd: envelope.total_cost_usd } : {}),
    ...(typeof envelope.duration_ms === "number" ? { durationMs: envelope.duration_ms } : {}),
  };
}

const parseLines = (output: string): StreamEvent[] => {
  const events: StreamEvent[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed) as StreamEvent);
    } catch {
      // Not a stream line. An older CLI prints plain text, and the caller
      // falls back to it below rather than losing the answer.
    }
  }
  return events;
};

const textOfBlocks = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .join("\n\n");
};

/** Read the finished run. `output` is everything the child wrote to stdout. */
export function readStream(output: string): StreamOutcome {
  const events = parseLines(output);
  const envelope = [...events].reverse().find((event) => event.type === "result");

  const streamed = events
    .filter((event) => event.type === "assistant")
    .map((event) => textOfBlocks(event.message?.content))
    .filter((text) => text !== "")
    .join("\n\n");

  if (envelope === undefined) {
    // Two different situations, and treating them as one dumped a whole
    // JSONL log into the discussion as if a seat had said it.
    //
    // Events but no envelope: the CLI WAS speaking stream-json and never
    // reached its result — killed by the watchdog, or dying mid-retry. The
    // answer is whatever assistant text arrived, and nothing if none did.
    // The raw log is not an answer; it is a transcript of the machinery.
    if (events.length > 0) return { text: streamed, failed: true };

    // No events at all: not a stream-json run — an older CLI, or a failure
    // before the format started. Whatever came out is all there is, and an
    // empty answer is a failure rather than a silent success.
    const plain = output.trim();
    return { text: plain, failed: plain === "" };
  }

  const failed = envelope.is_error === true || envelope.subtype !== "success";
  const fromEnvelope = typeof envelope.result === "string" ? envelope.result.trim() : "";
  const usage = usageOf(envelope);
  return {
    text: streamed !== "" ? streamed : fromEnvelope,
    failed,
    ...(typeof envelope.subtype === "string" ? { subtype: envelope.subtype } : {}),
    // Carried even on a failed run: a turn that burned tokens and then errored
    // still cost what it cost, and dropping it would make failures look free.
    ...(usage === undefined ? {} : { usage }),
  };
}
