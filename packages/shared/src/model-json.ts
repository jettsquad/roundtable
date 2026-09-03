/**
 * model-json.ts — getting a JSON object out of something a model said.
 *
 * Two callers ask for the same thing from opposite sides of the plugin wall:
 * ③ the secretary parsing an agenda reply, and the console parsing a team
 * plan. They had one copy between them; a second would drift, and the two
 * halves of a drifted tolerance are 「这份好好的方案被拒了」 on one screen and
 * 「这份坏方案被收了」 on the other.
 *
 * Tolerant only up to the object boundary. The failure being avoided is a
 * perfectly good answer refused because the model wrote 「给你：」 first, or
 * wrapped it in a code fence. What is INSIDE still faces a strict schema —
 * tolerance about packaging is not tolerance about content.
 */

/**
 * Parse `text` as JSON, ignoring anything around the outermost object.
 *
 * `whenMissing` is the message for a reply with no object in it at all, so
 * each caller can say which of its own jobs failed rather than emitting a
 * generic parse error nobody can place.
 */
export function extractJsonObject(text: string, whenMissing: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) throw new Error(whenMissing);
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}
