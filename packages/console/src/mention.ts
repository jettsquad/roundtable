/**
 * mention.ts — pointing at seats by name inside the instruction.
 *
 * 1.x wrote `@高宫望 …` and this project shipped a row of checkboxes instead.
 * The checkboxes are worse for a specific reason: naming someone is part of
 * what you are saying, and splitting it into a separate control means the
 * sentence and its audience are edited in two places and can disagree — you
 * rewrite the question and the ticks stay where they were.
 *
 * Decided against the ACTUAL roster, never by shape. `@` is an ordinary
 * character in prose, and 「联系我 @公司邮箱」 is not a roll-call.
 */

export interface Mentions {
  /** The instruction with the leading roll-call removed. */
  readonly instruction: string;
  /** Display names that were called on. Empty means everyone. */
  readonly named: readonly string[];
  /** `@` tokens that match no seat, in the order they appeared. */
  readonly unknown: readonly string[];
}

/**
 * Read `@name` tokens off an instruction.
 *
 * Only leading mentions count. An `@` in the middle of a sentence is part of
 * the sentence: 「问一下 @架构 和运维」 addresses one seat and mentions another
 * as a topic, and a parser that hunted the whole string could not tell those
 * apart.
 */
export function parseMentions(raw: string, seatNames: readonly string[]): Mentions {
  const named: string[] = [];
  const unknown: string[] = [];
  let rest = raw.trimStart();

  /** Punctuation between one mention and the next, or before the instruction. */
  const eatSeparators = (): void => {
    rest = rest.replace(/^[,，、:：]+\s*/, "").trimStart();
  };

  for (;;) {
    if (!rest.startsWith("@")) break;
    // A seat name only matches up to a BOUNDARY. Without that, `@架构师`
    // matches the seat 架构 and leaves 「师 看看」 as the instruction — the
    // question goes to the wrong person and the leftover character rides
    // along inside it.
    const match = seatNames
      .filter((name) => {
        if (!rest.startsWith(`@${name}`)) return false;
        const after = rest.charAt(name.length + 1);
        return after === "" || /[\s,，、:：]/.test(after);
      })
      // Longest first, so 「@架构组」 is not read as 「@架构」 plus a stray 组.
      .sort((a, b) => b.length - a.length)[0];
    if (match !== undefined) {
      if (!named.includes(match)) named.push(match);
      rest = rest.slice(match.length + 1).trimStart();
      eatSeparators();
      continue;
    }
    // An `@` that starts the text but names nobody: reported, not silently
    // treated as prose. A misspelled name would otherwise send the question
    // to the whole team while looking like it was aimed at one person.
    const token = /^@([^\s,，、:：]+)/.exec(rest);
    if (token?.[1] === undefined) break;
    unknown.push(token[1]);
    rest = rest.slice(token[0].length).trimStart();
    eatSeparators();
  }
  return { instruction: rest, named, unknown };
}

/** An `@` the person is in the middle of typing, and what they have typed. */
export interface MentionDraft {
  /** Index of the `@` itself. */
  readonly at: number;
  /** What follows it, up to the caret. Empty right after typing `@`. */
  readonly typed: string;
}

/**
 * The `@` being typed at the caret, if any — what a name list should offer for.
 *
 * Bounded by the same rule `parseMentions` enforces: only the leading
 * roll-call counts, so the list appears exactly where a pick would actually
 * do something. Offering names for an `@` in the middle of a sentence would
 * be a menu whose choices are then read as prose.
 */
export function mentionDraftAt(raw: string, caret: number, seatNames: readonly string[]): MentionDraft | undefined {
  const head = raw.slice(0, caret);
  const at = head.lastIndexOf("@");
  if (at < 0) return undefined;
  const typed = head.slice(at + 1);
  // A space ends a mention: past it the person is writing the instruction.
  if (/[\s]/.test(typed)) return undefined;
  // Everything before this `@` must itself be a completed roll-call, or the
  // `@` is inside the sentence rather than in front of it.
  const before = raw.slice(0, at);
  if (before.trim() !== "" && parseMentions(before, seatNames).instruction.trim() !== "") return undefined;
  return { at, typed };
}

/**
 * The names worth offering for a draft, best match first.
 *
 * Prefix matches before contained ones, so typing the start of a name puts it
 * at the top where Enter will take it.
 */
export function mentionCandidates(draft: MentionDraft, seatNames: readonly string[]): readonly string[] {
  const typed = draft.typed.toLowerCase();
  if (typed === "") return seatNames;
  const prefix = seatNames.filter((name) => name.toLowerCase().startsWith(typed));
  const rest = seatNames.filter((name) => !prefix.includes(name) && name.toLowerCase().includes(typed));
  return [...prefix, ...rest];
}

/**
 * Put a chosen name into the text, and say where the caret goes.
 *
 * A trailing space is part of the completion: without it the next character
 * typed extends the name, and `parseMentions` then reports a seat nobody has.
 */
export function applyMention(
  raw: string,
  caret: number,
  draft: MentionDraft,
  name: string,
): { readonly text: string; readonly caret: number } {
  const inserted = `@${name} `;
  const text = raw.slice(0, draft.at) + inserted + raw.slice(caret);
  return { text, caret: draft.at + inserted.length };
}
