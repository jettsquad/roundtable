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

export interface StreamOutcome {
  readonly text: string;
  /** The CLI reported an error result, or the process failed. */
  readonly failed: boolean;
  /** Present when the envelope carried one. */
  readonly subtype?: string | undefined;
}

interface StreamEvent {
  readonly type?: unknown;
  readonly subtype?: unknown;
  readonly is_error?: unknown;
  readonly result?: unknown;
  readonly message?: { readonly content?: unknown } | undefined;
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
    // No stream-json at all. Whatever came out is the answer, and an empty
    // answer is a failure rather than a silent success — a seat that returns
    // nothing and a seat that returned "" are the same to every reader
    // downstream, so they must not be the same here.
    const plain = output.trim();
    return { text: plain, failed: plain === "" };
  }

  const failed = envelope.is_error === true || envelope.subtype !== "success";
  const fromEnvelope = typeof envelope.result === "string" ? envelope.result.trim() : "";
  return {
    text: streamed !== "" ? streamed : fromEnvelope,
    failed,
    ...(typeof envelope.subtype === "string" ? { subtype: envelope.subtype } : {}),
  };
}
