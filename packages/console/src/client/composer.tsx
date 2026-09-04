/**
 * composer.tsx — the box at the bottom, sending to the team.
 *
 * There were two input boxes on one screen and no way to tell which was
 * which. The one at the bottom is dsh's, and it answers to dsh's own chat
 * agent — a model with its own API key that has nothing to do with the team.
 * So a person in a team session typed into the obvious box and nothing
 * happened, which is exactly what was reported.
 *
 * `conversation.composer` is a chain slot whose fallback is the ordinary
 * input bar, kept mounted under an election so its draft survives. Electing
 * on a team's session puts this in its place: same position, same habit, and
 * it goes to the team.
 */
import { useEffect, useRef, useState } from "react";
// dsh's own primitives, which ARE shared: `Button` and `Input` are exported
// from the platform module table. Its INPUT BAR is not — that component is
// internal to ui-conversation and wired to dsh's own send path — so the box
// below takes the bar's PLACE through the composer chain and is built from
// the same pieces the rest of the app is.
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { api, useSnapshot } from "./api.ts";
import { applyMention, mentionCandidates, mentionDraftAt, parseMentions } from "../mention.ts";
import { describeSeat } from "../seat-status.ts";
import { useSitting } from "./use-sitting.ts";
import { DRAFT_ANCHOR } from "./draft-card.tsx";
import { clearQuotes, toggleQuote } from "./quotes.ts";
import { useQuotes } from "./use-quotes.ts";
import { Dictate } from "./dictate.tsx";
import { useT } from "./locale.ts";
import styles from "./panel.module.css";

interface SquadComposerProps {
  /**
   * The workspace folder this session sits in.
   *
   * The election already decided this folder has a team; the team itself is
   * read here so its roster and running state stay live while the round goes,
   * rather than being frozen at election time.
   */
  readonly folder: string;
  /**
   * The dsh session this box belongs to.
   *
   * Selecting by folder alone is what sent a new session's messages into the
   * old session: every session in a workspace matched the same record. The
   * folder says WHICH TEAM; this says which of its sittings.
   */
  readonly sessionId: string;
}

export function SquadComposer({ folder, sessionId }: SquadComposerProps): JSX.Element {
  const t = useT();
  const [nonce, setNonce] = useState(0);
  const snapshot = useSnapshot(nonce);
  const onSent = (): void => setNonce((value) => value + 1);
  const sittingId = useSitting(folder, sessionId);
  const current =
    snapshot.state === "ready" && sittingId !== undefined
      ? snapshot.data.teams.find((team) => team.teamId === sittingId)
      : undefined;
  const [instruction, setInstruction] = useState("");
  // Keyed by team, not by folder: the store is per team and this component is
  // mounted per session.
  const quoted = useQuotes(current?.teamId ?? "");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [importing, setImporting] = useState<string | undefined>(undefined);
  // With the other hooks, above every early return. It sat next to the send
  // handler — which is below the 「这个 folder 没有团队」 branch — so the
  // component rendered a different number of hooks depending on whether the
  // team had loaded yet, and React tore the whole composer out. That is why
  // the box vanished entirely rather than merely missing a button.
  const filePicker = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // Which documents ride along with THIS message. Empty by default: importing
  // a file so one seat can summarise it must not cost that file on every
  // later turn of every seat.
  const [attached, setAttached] = useState<readonly string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  // A wrapper, not the input itself: dsh's `Input` does not forward a ref, and
  // reaching for the element through the row we own is honest about that —
  // the alternative would be dropping the shared primitive for a bare
  // `<input>` and losing the app's own field styling on the one box people
  // type into most.
  const row = useRef<HTMLDivElement>(null);
  // The textarea, not the file input that also lives in this row. Selecting
  // by tag alone used to be unambiguous and is not any more — and the wrong
  // element would take the caret restore silently.
  const boxOf = (): HTMLTextAreaElement | null => box.current;

  /**
   * Fit the box to its text, up to the ceiling in the stylesheet.
   *
   * Measured rather than counted: a line that WRAPPED and a newline that was
   * typed both make the box taller, and counting "\n" would only notice the
   * second. `height: auto` first, so shrinking works too — without it the box
   * only ever grows, and deleting three paragraphs leaves three paragraphs of
   * empty space.
   */
  const grow = (node: HTMLTextAreaElement): void => {
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  };

  // Once after mount, and again whenever the text is replaced from outside —
  // a send clears it, a refusal puts it back.
  useEffect(() => {
    const node = box.current;
    if (node !== null) grow(node);
  }, [instruction]);
  // Where the caret is, tracked because the `@` list is decided by what sits
  // to the LEFT of it — reading the whole value would offer names for an `@`
  // the person has already moved past.
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  // A clock of its own, so the live status ticks between polls. Without it a
  // seat's 「思考中 12 秒」 freezes until the next fetch and reads like a
  // seat that stopped.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (current === undefined) {
    return (
      <div className={styles.composerBox}>
        <span className={styles.muted}>
          {snapshot.state === "loading" || sittingId === undefined
            ? t("composer.loading")
            : t("composer.gone", { folder })}
        </span>
      </div>
    );
  }

  // Who this sentence is addressed to, read out of the sentence itself.
  const mentions = parseMentions(
    instruction,
    current.seats.map((seat) => seat.displayName),
  );
  const named = current.seats.filter((seat) => mentions.named.includes(seat.displayName));
  const asked = named.length === 0 ? current.seats : named;
  const blocked = asked.filter((seat) => seat.blocked !== undefined);
  const allBlocked = asked.length > 0 && blocked.length === asked.length;
  const seatNames = current.seats.map((seat) => seat.displayName);
  // The `@` being typed right now, and the names worth offering for it. Both
  // decided against the real roster — a list built from shape alone would
  // offer names for 「联系我 @公司邮箱」.
  // Offered while a round runs, too. Writing the next question is the natural
  // thing to do WHILE the answers come in, and a box that refuses to be typed
  // in takes the thought with it: only SENDING has to wait, and the send
  // button says so on its face.
  const draft = mentionDraftAt(instruction, caret);
  const candidates = draft === undefined ? [] : mentionCandidates(draft, seatNames);
  const pick = (name: string): void => {
    if (draft === undefined) return;
    const applied = applyMention(instruction, caret, draft, name);
    setInstruction(applied.text);
    setCaret(applied.caret);
    setHighlight(0);
    // Put the caret back where the completion left it. React restores the
    // value but not the selection, so without this every pick sends the
    // cursor to the end and the next `@` lands in the wrong place.
    requestAnimationFrame(() => {
      const box = boxOf();
      box?.focus();
      box?.setSelectionRange(applied.caret, applied.caret);
    });
  };

  // A misspelled name is refused rather than quietly widened to everyone:
  // the box would read as though it were aimed at one person while the
  // question went to the whole team.
  const misnamed = mentions.unknown.length > 0;

  // Recomputed every second by the tick above, so these are live rather than
  // frozen at the last poll.
  const now = Date.now();
  const statuses = current.seats
    .map((seat) => ({
      seatId: seat.seatId,
      displayName: seat.displayName,
      color: seat.color,
      status: describeSeat({
        running: seat.running,
        blocked: seat.blocked,
        activity: seat.activity,
        silence: current.silence,
        now,
      }),
    }))
    .filter((entry) => entry.status.phase !== "idle");
  // The one line worth reading when something is wrong: the detail of the
  // seat that is closest to being given up on.
  const worry = statuses.find((entry) => entry.status.phase === "stalling")?.status.detail;

  const importFiles = async (files: FileList): Promise<void> => {
    setError(undefined);
    // One at a time, reporting per file: someone who picked four documents
    // and got one refusal needs to know which one.
    for (const file of Array.from(files)) {
      setImporting(file.name);
      try {
        await api.addMaterial(current.teamId, file.name, await file.arrayBuffer());
      } catch (failure) {
        setError(String((failure as Error).message));
      }
    }
    setImporting(undefined);
    onSent();
  };

  /** How many documents this message will actually carry. */
  const carried = current?.materials.filter((m) => m.pinned || attached.includes(m.materialId)).length ?? 0;

  const send = async (): Promise<void> => {
    setError(undefined);
    setRunning(true);
    // Text left sitting in the box after it was sent is text you send again,
    // which is how one question became four identical ones in the record.
    const sent = mentions.instruction;
    const seatIds = named.map((seat) => seat.seatId);
    setInstruction("");
    try {
      await api.say({
        teamId: current.teamId,
        ...(quoted.length === 0 ? {} : { quoteIds: quoted }),
        ...(attached.length === 0 ? {} : { materialIds: attached }),
        // The roll-call is stripped: a seat that also found 「@架构」 inside
        // its own task would be reading an address as an instruction.
        instruction: sent,
        ...(seatIds.length === 0 ? {} : { seatIds }),
      });
      // Cleared after a successful send: a quote is about the question you
      // just asked, and leaving it selected would silently attach it to the
      // next one too.
      clearQuotes(current.teamId);
      // Cleared for the same reason quotes are: an attachment is about the
      // question you just asked, and leaving it on would silently bill it to
      // the next one too.
      setAttached([]);
      // The answers land in the discussion, which is the ONE place a
      // conversation is shown. Repeating them here is what put the same
      // sentences on the screen twice.
      onSent();
    } catch (failure) {
      // Put the text back when it did not go out, so a refusal does not also
      // cost the sentence.
      setInstruction(sent);
      setError(String((failure as Error).message ?? failure));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={styles.composerBox}>
      <div className={styles.composerWho}>
        {t("composer.head", { name: current.displayName })}
        {current.seats.length === 0 ? t("composer.head.noSeats") : ""}
      </div>

      <div className={styles.row} ref={row}>
        {/* A textarea, not a one-line input. An instruction to a team is often
            several sentences, and a box that scrolls sideways hides the middle
            of what you are about to send. It grows with the text up to a
            ceiling and then scrolls, so the composer never eats the
            discussion. */}
        <textarea
          className={`${styles.grow ?? ""} ${styles.composerInput ?? ""}`}
          value={instruction}
          rows={1}
          placeholder={t("composer.placeholder", { name: current.displayName })}
          ref={box}
          onChange={(event) => {
            setInstruction(event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
            setHighlight(0);
            // Resized on every change, not in a ref callback: a ref callback
            // runs at mount and never again, so the box would have stayed one
            // line high no matter how much was typed into it.
            grow(event.target);
          }}
          onSelect={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={(event) => {
            // ⌘↵ / Ctrl+↵ sends, always — including while the name list is
            // open, because at that point you have finished the sentence and
            // the list is just in the way.
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (!running && instruction.trim() !== "") void send();
              return;
            }
            // While the list is open it owns the arrow keys and Enter. Letting
            // Enter fall through would send the message the moment someone
            // tried to choose a name, which is the one keystroke they meant
            // for the list.
            if (candidates.length > 0) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : candidates.length - 1;
                setHighlight((value) => (value + step) % candidates.length);
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                pick(candidates[highlight] ?? candidates[0] ?? "");
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                // Closed by moving the caret out of the draft rather than by a
                // flag: one source of truth for "is the list open".
                setCaret(instruction.length);
                return;
              }
            }
            // Plain ↵ is a newline now, so nothing more to do: the textarea's
            // own default inserts it.
          }}
        />
        {candidates.length === 0 ? null : (
          <div className={styles.mentionList}>
            {candidates.map((name, index) => {
              const seat = current.seats.find((candidate) => candidate.displayName === name);
              return (
                <button
                  key={name}
                  type="button"
                  className={`${styles.mentionItem} ${index === highlight ? styles.mentionOn : ""}`}
                  // `onMouseDown` rather than `onClick`: a click would blur the
                  // input first, the caret would move, and the draft this pick
                  // depends on would be gone before it ran.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(name);
                  }}
                >
                  <span className={styles.dot} style={{ background: seat?.color ?? "#5a5a62" }} />
                  {seat?.isSecretary === true ? "★ " : ""}
                  {name}
                  <span className={styles.muted}>{seat?.role ?? ""}</span>
                </button>
              );
            })}
          </div>
        )}
        <Button
          type="button"
          variant="primary"
          disabled={
            running || mentions.instruction.trim() === "" || current.seats.length === 0 || allBlocked || misnamed
          }
          onClick={() => void send()}
        >
          {running
            ? t("composer.running", { seconds: elapsed })
            : named.length === 0
              ? t("composer.askAll")
              : t("composer.askSome", { names: named.map((seat) => seat.displayName).join("、") })}
        </Button>
        {/* Next to the send button, because importing a document is part of
            saying what you want the team to work on. It sat at the top of the
            tab, which is 「放到最上面怎么用」. */}
        {/* A real <label>, not a button that calls `.click()` on a hidden
            input. Programmatic clicks on a `display: none` input are refused
            outright by some embedded webviews, and the failure is silent —
            the picker simply never opens, which is 「只有按钮，但是添加不了
            文档」. A label opens it through the browser's own path, with no
            script involved. */}
        {/* Beside the send button, because dictating IS how you fill the box
            — and what it produces has to be reviewable in the same place
            before it costs a round. */}
        <Dictate
          onText={(text) => setInstruction((current) => (current.trim() === "" ? text : `${current} ${text}`))}
        />
        <label className={styles.button} title={t("composer.materials.title")}>
          {importing === undefined
            ? current.materials.length === 0
              ? t("composer.materials")
              : t("composer.materials.count", { n: current.materials.length })
            : t("composer.materials.importing", { name: importing })}
          <input
            ref={filePicker}
            type="file"
            multiple
            accept=".pdf,.docx,.md,.markdown,.txt,.text,.csv,.json,.yaml,.yml"
            className={styles.hiddenFile ?? ""}
            onChange={(event) => {
              const files = event.target.files;
              if (files !== null && files.length > 0) void importFiles(files);
              // Cleared so picking the SAME file again still fires a change:
              // re-importing a document you have just edited is normal.
              event.target.value = "";
            }}
          />
        </label>
        {/* Summarising is a thing you decide while reading the conversation,
            so it belongs where the conversation is. It lived at the top of
            the tab, which is why it kept reading as 「没有实现」. */}
        <button
          type="button"
          className={styles.button}
          title={t("composer.context.title", {
            used: current.context.accumulated.toLocaleString(),
            limit: current.context.limit.toLocaleString(),
          })}
          disabled={current.busy || current.context.folding}
          onClick={() => {
            setError(undefined);
            void api
              .fold({ teamId: current.teamId })
              .then(onSent)
              .catch((failure: Error) => setError(String(failure.message)));
          }}
        >
          {current.context.folding ? t("composer.summarising") : t("composer.summarise")}
        </button>
        {!current.busy ? null : (
          <Button
            type="button"
            onClick={() =>
              // The refusal is shown. It used to be dropped on the floor,
              // which is what made the button look dead.
              void api
                .stop({ teamId: current.teamId })
                .then(onSent)
                .catch((failure: Error) => setError(String(failure.message)))
            }
          >
            {t("composer.stop")}
          </Button>
        )}
      </div>

      {/* The documents this message carries, chosen before it is sent.
          1.x inferred this from the wording — 「参考资料」 turned materials
          on — and that misses both ways: 「按这份规格评审一下」 sends
          nothing while looking like it should, and 「写一份 document 出来」
          resends everything. What travels is visible here instead. */}
      {current.materials.length === 0 ? null : (
        <div className={styles.row}>
          <span className={styles.hint}>
            {/* Says how many are ACTUALLY carried. The label used to read
                「本轮带上：」 above a row of chips that were merely available,
                so a full row read as a full attachment. */}
            {carried === 0 ? t("composer.carry") : t("composer.carry.some", { n: carried })}
          </span>
          {current.materials.map((material) => {
            const on = material.pinned || attached.includes(material.materialId);
            return (
              <button
                key={material.materialId}
                type="button"
                className={`${styles.quoteChip} ${on ? styles.quoted : styles.chipIdle}`}
                title={
                  material.pinned
                    ? "常驻资料，每轮都带（在团队页可以取消常驻）"
                    : `${material.chars.toLocaleString()} 字 · 只带这一轮`
                }
                disabled={material.pinned}
                onClick={() =>
                  setAttached((current) =>
                    current.includes(material.materialId)
                      ? current.filter((one) => one !== material.materialId)
                      : [...current, material.materialId],
                  )
                }
              >
                {material.pinned ? "📌 " : on ? "✓ " : ""}
                {material.name}
              </button>
            );
          })}
        </div>
      )}

      {/* The draft itself is drawn in the discussion, under the reply it came
          from. This only says one exists and takes you there — drawing it
          twice is the mistake this project already made with the transcript. */}
      {current.draft === undefined ? null : (
        <div className={styles.draftBanner}>
          <span>秘书的议程草案等你确认 · {current.draft.phases.length} 个阶段</span>
          <button
            type="button"
            className={styles.quoteChip}
            onClick={() => document.getElementById(DRAFT_ANCHOR)?.scrollIntoView({ block: "center" })}
          >
            去看
          </button>
        </div>
      )}

      {quoted.length === 0 ? null : (
        <div className={styles.row}>
          <span className={styles.hint}>已引用 {quoted.length} 段（在讨论之外额外强调）：</span>
          {quoted.map((turnId) => {
            const line = current.transcript.find((entry) => entry.turnId === turnId);
            return (
              <button
                key={turnId}
                type="button"
                className={styles.quoteChip}
                title="取消引用"
                onClick={() => toggleQuote(current.teamId, turnId)}
              >
                {(line?.speaker ?? "?") + "：" + (line?.text ?? "").slice(0, 14)}… ×
              </button>
            );
          })}
          <button type="button" className={styles.drop} onClick={() => clearQuotes(current.teamId)}>
            全部取消
          </button>
        </div>
      )}

      <div className={styles.row}>
        <span className={styles.hint}>
          {t("composer.members", {
            names: current.seats.map((seat) => seat.displayName).join("、") || t("composer.members.none"),
          })}
          {named.length === 0 ? t("composer.members.hint") : ""}
        </span>
      </div>

      {!misnamed ? null : (
        <div className={styles.error}>{t("composer.unknownMention", { names: mentions.unknown.join("、") })}</div>
      )}

      {/* What every seat is doing, while it is doing it.
          This used to be a single guess — 「等了 45 秒，多半连不上」 — which was
          a rule of thumb standing in for the numbers we actually have. Now each
          seat reports its own bytes and its own silence, so the screen says
          which one is quiet and how long the runtime will still wait. */}
      {statuses.length === 0 ? null : (
        <div className={styles.statusStrip}>
          {statuses.map((entry) => (
            <span key={entry.seatId} className={`${styles.statusChip} ${styles[entry.status.phase] ?? ""}`}>
              <span className={styles.dot} style={{ background: entry.color ?? "#5a5a62" }} />
              {entry.displayName} · {entry.status.label}
            </span>
          ))}
        </div>
      )}
      {worry === undefined ? null : <div className={styles.hint}>{worry}</div>}
      {/* Why the send button is refusing, said where a person looks after
          pressing ⌘↵ and getting nothing. The button's own label reads
          「进行中 62s」, which explains it only if you were looking at the
          button — and you were looking at the box you just typed into. */}
      {!running ? null : <div className={styles.hint}>{t("composer.writeWhileRunning")}</div>}
      {blocked.length === 0 ? null : (
        <div className={styles.error}>
          {allBlocked ? t("composer.allBlocked") : t("composer.someBlocked")}
          {blocked.map((seat) => `${seat.displayName}（${seat.blocked}）`).join("、")}
        </div>
      )}
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
    </div>
  );
}
