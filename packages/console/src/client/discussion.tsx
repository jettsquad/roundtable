/**
 * discussion.tsx — the team's conversation, rendered the way Chat renders one.
 *
 * It used to appear TWICE on one screen: once as the transcript and again as
 * the composer's list of the last round's replies. Two boxes showing the same
 * sentences is not two views, it is one view drawn twice — so the replies
 * came out of the composer and this is the only place a discussion is shown.
 *
 * `MarkdownText` is dsh's own renderer, the one Chat uses: GFM tables, fenced
 * code, KaTeX. Seats reply in Markdown — tables of workflow steps, headings,
 * file names in backticks — and rendering that as preformatted text was the
 * difference between a discussion you can read and a wall of pipes.
 *
 * The layout follows 1.x rather than a chat's left/right bubbles: a coloured
 * speaker pill above the body, every message the same shape. With five
 * participants, alternating sides means nothing — the NAME is what tells you
 * who spoke, so it is what gets the colour.
 */
import { useEffect, useRef } from "react";
import { MarkdownText } from "@deepseek-ai/dsh-client-ui-primitives";
import type { TeamSummary } from "./api.ts";
import { toggleQuote } from "./quotes.ts";
import { useQuotes } from "./use-quotes.ts";
import styles from "./panel.module.css";

/** The colour a speaker's pill takes, from the roster. */
function tintOf(team: TeamSummary, speaker: string): string | undefined {
  if (speaker === "系统") return undefined;
  return team.seats.find((seat) => seat.displayName === speaker)?.color;
}

export function Discussion({
  team,
  autoScroll = false,
}: {
  readonly team: TeamSummary;
  /** Follow the newest message. On in the working view, off in the panel. */
  readonly autoScroll?: boolean;
}): JSX.Element {
  const end = useRef<HTMLDivElement>(null);
  const quoted = useQuotes(team.teamId);
  const count = team.transcript.length;
  useEffect(() => {
    if (autoScroll) end.current?.scrollIntoView({ block: "end" });
  }, [autoScroll, count]);

  if (count === 0) {
    return <div className={styles.hint}>还没有讨论。在下面说一句，团队就开始了。</div>;
  }

  return (
    <div className={styles.thread}>
      {/* Said out loud: a discussion that begins mid-sentence with nothing
          saying so reads as the whole of it. */}
      {team.transcriptOmitted === 0 ? null : (
        <div className={styles.hint}>前面还有 {team.transcriptOmitted} 条，这里只显示最近的。</div>
      )}
      {team.transcript.map((line) => {
        const tint = tintOf(team, line.speaker);
        const host = line.speaker === team.hostDisplayName;
        return (
          <article key={line.turnId} className={styles.message}>
            <div className={styles.messageHead}>
              <span
                className={`${styles.speaker} ${host ? styles.speakerHost : ""}`}
                style={tint === undefined ? undefined : { background: tint, color: "#fff" }}
              >
                {line.speaker}
              </span>
              {/* Pointing at a line is how you say "this is what I mean" without
                  retyping it. The quote travels as an ID and is resolved from
                  the record when the round starts — see `quotesFrom`. */}
              <button
                type="button"
                className={`${styles.quoteButton} ${quoted.includes(line.turnId) ? styles.quoted : ""}`}
                onClick={() => toggleQuote(team.teamId, line.turnId)}
              >
                {quoted.includes(line.turnId) ? "已引用 ✓" : "引用"}
              </button>
            </div>
            <div className={styles.messageBody}>
              <MarkdownText text={line.text} />
            </div>
          </article>
        );
      })}
      {/* The composer floats over this view, so the thread needs room under
          its last message — otherwise the newest lines, the ones you just
          caused, sit behind the box you typed into. Measured against the
          composer rather than guessed: a fixed padding on the container was
          not enough once a reply grew. */}
      <div ref={end} className={styles.threadTail} />
    </div>
  );
}
