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
 * Two things carry WHO said something, and they carry different halves of it.
 * The host's own lines sit on the RIGHT, because in a room with five members
 * the one distinction that never blurs is "mine" against "theirs". Among the
 * members, sides would be meaningless — five of them, two sides — so each
 * body gets a boxed background and the NAME gets the colour. A flat run of
 * unboxed paragraphs was the thing that made a long round unreadable: the
 * text told you what was said and nothing told you where one answer ended.
 */
import { useEffect, useRef, useState } from "react";
import { MarkdownText } from "@deepseek-ai/dsh-client-ui-primitives";
import { api, type TeamSummary } from "./api.ts";
import { DraftCard } from "./draft-card.tsx";
import { toggleQuote } from "./quotes.ts";
import { useQuotes } from "./use-quotes.ts";
import styles from "./panel.module.css";

/** The colour a speaker's pill takes, from the roster. */
function tintOf(team: TeamSummary, speaker: string): string | undefined {
  if (speaker === "系统") return undefined;
  return team.seats.find((seat) => seat.displayName === speaker)?.color;
}

/**
 * The clock time a line was said.
 *
 * Time of day rather than "3 分钟前": a discussion is read after the fact as
 * often as during it, and a relative age silently keeps changing under a
 * transcript that has not. The date joins in only when the line is not from
 * today, which is when it starts to matter.
 */
function clockOf(at: number): string {
  const said = new Date(at);
  const time = said.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const sameDay =
    said.getFullYear() === today.getFullYear() &&
    said.getMonth() === today.getMonth() &&
    said.getDate() === today.getDate();
  return sameDay ? time : `${said.getMonth() + 1}/${said.getDate()} ${time}`;
}

/** Put text on the clipboard, and say whether it landed. */
function copyText(text: string): Promise<boolean> {
  // The async clipboard first, and the 2010 trick behind it. `writeText` needs
  // a permission and a user activation, and it is refused outright in some
  // embedded webviews — verified here, where it answered
  // `NotAllowedError: Write permission denied`. A copy button that works in
  // Chrome and does nothing in the app people actually run it in is exactly
  // the failure this project keeps finding, so the fallback is not optional.
  const legacy = (): boolean => {
    const carrier = document.createElement("textarea");
    carrier.value = text;
    // Off-screen but focusable: `display: none` cannot be selected, and an
    // unselectable carrier makes `execCommand` a no-op that reports success.
    carrier.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(carrier);
    carrier.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      carrier.remove();
    }
  };
  if (navigator.clipboard?.writeText === undefined) return Promise.resolve(legacy());
  return navigator.clipboard
    .writeText(text)
    .then(() => true)
    .catch(() => legacy());
}

/**
 * Copy one message.
 *
 * Its own component because it owns a moment of state: a copy that says
 * nothing is indistinguishable from a button that did nothing, and the
 * clipboard gives no other feedback.
 */
function CopyButton({ text }: { readonly text: string }): JSX.Element {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <button
      type="button"
      className={`${styles.quoteButton} ${state === "failed" ? styles.stalling : ""}`}
      title="复制这段的原文"
      onClick={() => {
        // The raw Markdown, not the rendered text: what people paste this
        // into is another Markdown box more often than not, and a copy that
        // silently flattened the tables would be worth less than the screen.
        void copyText(text).then((ok) => {
          // A failure that says nothing is a button that looks broken. Said
          // out loud, and cleared, so the next attempt starts honest.
          setState(ok ? "done" : "failed");
          setTimeout(() => setState("idle"), 1500);
        });
      }}
    >
      {state === "done" ? "已复制 ✓" : state === "failed" ? "复制失败" : "复制"}
    </button>
  );
}

/**
 * Turn one secretary reply into an agenda draft.
 *
 * Its own component for the same reason `CopyButton` is: it owns a moment of
 * state, and a button that says nothing while a model works reads as a button
 * that did nothing.
 */
function ToAgendaButton({ team, turnId }: { readonly team: TeamSummary; readonly turnId: string }): JSX.Element {
  const [state, setState] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [detail, setDetail] = useState<string | undefined>(undefined);
  return (
    <>
      <button
        type="button"
        className={`${styles.quoteButton} ${state === "failed" ? styles.stalling : ""}`}
        title="把这段安排转成结构化议程，交给你确认后才会跑"
        disabled={state === "running"}
        onClick={() => {
          setState("running");
          setDetail(undefined);
          void api
            .agendaFromReply({ teamId: team.teamId, turnId })
            .then(() => setState("done"))
            .catch((error: Error) => {
              setState("failed");
              setDetail(String(error.message));
            });
        }}
      >
        {state === "running" ? "转换中…" : state === "done" ? "已成草案 ✓" : "转成议程"}
      </button>
      {detail === undefined ? null : <span className={styles.error}>{detail}</span>}
    </>
  );
}

export function Discussion({
  team,
  autoScroll = false,
  onChanged,
}: {
  readonly team: TeamSummary;
  /** Follow the newest message. On in the working view, off in the panel. */
  readonly autoScroll?: boolean;
  /** Called after the host resolves a draft rendered inside the thread. */
  readonly onChanged?: () => void;
}): JSX.Element {
  const end = useRef<HTMLDivElement>(null);
  const start = useRef<HTMLDivElement>(null);
  const quoted = useQuotes(team.teamId);
  const secretaryNames = team.seats.filter((seat) => seat.isSecretary).map((seat) => seat.displayName);
  const count = team.transcript.length;
  useEffect(() => {
    if (autoScroll) end.current?.scrollIntoView({ block: "end" });
  }, [autoScroll, count]);

  if (count === 0) {
    return <div className={styles.hint}>还没有讨论。在下面说一句，团队就开始了。</div>;
  }

  return (
    <div className={styles.thread}>
      {/* Sentinels, not a scroll-container hunt. The thread lives inside dsh's
          own scrollport, which this plugin does not own and should not go
          looking for by class name — `scrollIntoView` asks the browser to
          bring an element into view whatever is scrolling, and keeps working
          if that layout ever changes.

          No `behavior: "smooth"`, and not as a style choice: in dsh's
          scrollport a smooth request moves nothing at all — measured, the
          element stayed at the same offset while the default jumped it into
          view. A control that animates nowhere reads exactly like a dead
          button. */}
      <div ref={start} />
      {/* Said out loud: a discussion that begins mid-sentence with nothing
          saying so reads as the whole of it. */}
      {team.transcriptOmitted === 0 ? null : (
        <div className={styles.hint}>前面还有 {team.transcriptOmitted} 条，这里只显示最近的。</div>
      )}
      {team.transcript.map((line) => {
        const tint = tintOf(team, line.speaker);
        const host = line.speaker === team.hostDisplayName;
        const picked = quoted.includes(line.turnId);
        return (
          <article key={line.turnId} className={`${styles.message} ${host ? styles.messageMine : ""}`}>
            <div className={styles.messageHead}>
              <span
                className={`${styles.speaker} ${host ? styles.speakerHost : ""}`}
                style={tint === undefined ? undefined : { background: tint, color: "#fff" }}
              >
                {line.speaker}
              </span>
              <span className={styles.clock}>{clockOf(line.at)}</span>
              {/* Pointing at a line is how you say "this is what I mean"
                  without retyping it. The quote travels as an ID and is
                  resolved from the record when the round starts — see
                  `quotesFrom`. */}
              <button
                type="button"
                className={`${styles.quoteButton} ${picked ? styles.quoted : ""}`}
                title="下一轮特别强调这一段"
                onClick={() => toggleQuote(team.teamId, line.turnId)}
              >
                {picked ? "已引用 ✓" : "引用"}
              </button>
              <CopyButton text={line.text} />
              {/* Only on the secretary's own lines. This is 1.x's move and the
                  one that makes a secretary an organiser rather than a
                  note-taker: ask it in the DISCUSSION how the work should be
                  divided, argue with the answer in prose, and only then turn
                  that prose into phases. Offering it on anyone's reply would
                  let a member schedule the team while the confirmation said
                  the secretary had. */}
              {!secretaryNames.includes(line.speaker) ? null : <ToAgendaButton team={team} turnId={line.turnId} />}
            </div>
            <div
              className={`${styles.messageBody} ${host ? styles.bodyMine : styles.bodyTheirs}`}
              style={tint === undefined || host ? undefined : { borderLeftColor: tint }}
            >
              <MarkdownText text={line.text} />
            </div>
            {/* The plan, directly under the sentence it was made from. */}
            {team.draftFromTurnId === line.turnId ? (
              <DraftCard team={team} onChanged={onChanged ?? (() => undefined)} />
            ) : null}
          </article>
        );
      })}
      {/* A draft with no source turn — one asked for directly rather than
          converted from a reply — goes at the end, which is where the
          conversation currently is. */}
      {team.draft !== undefined && team.draftFromTurnId === undefined ? (
        <DraftCard team={team} onChanged={onChanged ?? (() => undefined)} />
      ) : null}
      {/* The composer floats over this view, so the thread needs room under
          its last message — otherwise the newest lines, the ones you just
          caused, sit behind the box you typed into. Measured against the
          composer rather than guessed: a fixed padding on the container was
          not enough once a reply grew. */}
      <div ref={end} className={styles.threadTail} />

      {/* Only once there is enough to scroll through. Two buttons floating
          over a three-line discussion are furniture. */}
      {count < 4 ? null : (
        <div className={styles.scrollNav}>
          <button
            type="button"
            className={styles.scrollButton}
            title="回到最上面"
            aria-label="回到最上面"
            onClick={() => start.current?.scrollIntoView({ block: "start" })}
          >
            ↑
          </button>
          <button
            type="button"
            className={styles.scrollButton}
            title="到最下面"
            aria-label="到最下面"
            onClick={() => end.current?.scrollIntoView({ block: "end" })}
          >
            ↓
          </button>
        </div>
      )}
    </div>
  );
}
