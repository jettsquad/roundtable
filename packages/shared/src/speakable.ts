/**
 * speakable.ts — turning a seat's reply into something worth hearing.
 *
 * Reading a reply aloud verbatim does not work, and the reasons are all
 * structural rather than cosmetic. A seat's answer is written to be SCANNED:
 * headings you skip past, a table you read down one column of, a code block
 * you look at only if the prose above made you care. Speech is linear — you
 * cannot skim it — so every one of those becomes a minute of listening to
 * punctuation being pronounced.
 *
 * So this is not a Markdown renderer with the tags removed. It decides what
 * survives contact with an ear: prose survives, structure is announced rather
 * than spelled out, and code is named rather than read. 「这里有一段代码」 is
 * more use than forty seconds of `const`, and the text is still on screen for
 * anyone who wants the real thing.
 */

/** What a chunk of speech is capped at. MiniMax takes 10k; short starts sooner. */
export const SPEECH_CHUNK_CHARS = 600;

/**
 * One reply, as text to be spoken.
 *
 * Order matters: fenced code goes first, before anything else can mangle the
 * text inside it, and inline formatting goes last, after the block structures
 * that would otherwise be read as literal characters.
 */
export function speakableText(markdown: string): string {
  let text = markdown;

  // Fenced code, named not read. A listener wants to know it is there.
  text = text.replace(/```[\s\S]*?```/g, "。这里有一段代码，略过。");
  // Inline code keeps its content — it is usually one identifier, and saying
  // 「反引号 seatId 反引号」 would be worse than saying `seatId`.
  text = text.replace(/`([^`\n]+)`/g, "$1");

  // Tables: announced with their size rather than read cell by cell. Reading
  // a table aloud produces a stream of words with no structure at all, which
  // is the one thing a table exists to provide.
  text = text.replace(/(?:^\|.*\|[ \t]*$\n?){2,}/gm, (block) => {
    const rows = block.trim().split("\n").length;
    // The separator row is not data, and neither is the header.
    const body = Math.max(0, rows - 2);
    return `。这里有一个表格，${body} 行，略过。\n`;
  });

  // Headings become spoken transitions. Dropping them entirely loses the
  // shape of the answer; reading the hashes is nonsense.
  text = text.replace(/^#{1,6}\s*(.+)$/gm, "。$1。");
  // Blockquote and list markers: the marker is layout, the text is content.
  text = text.replace(/^\s*>\s?/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "、");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "、");
  // Horizontal rules say nothing out loud.
  text = text.replace(/^\s*([-*_]\s*){3,}$/gm, "");

  // Links: the label is what a person would say; the URL never is.
  text = text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1");
  // Emphasis markers, once the block structures above are gone.
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*\n]+)\*/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n")
    .replace(/。{2,}/g, "。")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Split spoken text into chunks that can be synthesised one at a time.
 *
 * Chunked because the first chunk is what decides whether this feels usable:
 * a whole reply sent as one request is one wait before any sound, and a long
 * answer would be tens of seconds of silence that looks exactly like a
 * feature that does not work. It also makes 「跳过这一位」 cheap — nothing
 * further has been synthesised yet.
 *
 * Split on sentence ends rather than at a character count, because a cut
 * mid-clause is audible and sounds like a fault.
 */
export function speechChunks(text: string, maxChars = SPEECH_CHUNK_CHARS): readonly string[] {
  const clean = text.trim();
  if (clean === "") return [];
  const pieces = clean.split(/(?<=[。！？!?；;\n])/);
  const chunks: string[] = [];
  let held = "";
  for (const piece of pieces) {
    if (held !== "" && held.length + piece.length > maxChars) {
      chunks.push(held.trim());
      held = "";
    }
    // A single sentence longer than the cap is not split further: a hard cut
    // inside a clause is worse than one chunk that runs long, and the model
    // takes far more than this anyway.
    held += piece;
  }
  if (held.trim() !== "") chunks.push(held.trim());
  return chunks.filter((chunk) => chunk !== "");
}

/**
 * The credential a connection's environment carries.
 *
 * Which variable it lands in depends on the backend and, for Claude Code, on
 * the auth header — so a caller that needs the secret itself (the speech
 * route does) would otherwise have to re-derive that rule and get it wrong
 * for one of the cases.
 */
export function credentialFrom(env: Readonly<Record<string, string>>): string | undefined {
  for (const name of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "CODEX_API_KEY"]) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
}
