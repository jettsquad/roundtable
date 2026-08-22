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
import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import { api, useSnapshot } from "./api.ts";
import { applyMention, mentionCandidates, mentionDraftAt, parseMentions } from "../mention.ts";
import { describeSeat } from "../seat-status.ts";
import { clearQuotes, toggleQuote } from "./quotes.ts";
import { useQuotes } from "./use-quotes.ts";
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
}

export function SquadComposer({ folder }: SquadComposerProps): JSX.Element {
  const [nonce, setNonce] = useState(0);
  const snapshot = useSnapshot(nonce);
  const onSent = (): void => setNonce((value) => value + 1);
  const current = snapshot.state === "ready" ? snapshot.data.teams.find((t) => t.projectFolder === folder) : undefined;
  const [instruction, setInstruction] = useState("");
  // Keyed by team, not by folder: the store is per team and this component is
  // mounted per session.
  const quoted = useQuotes(current?.teamId ?? "");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);
  // A wrapper, not the input itself: dsh's `Input` does not forward a ref, and
  // reaching for the element through the row we own is honest about that —
  // the alternative would be dropping the shared primitive for a bare
  // `<input>` and losing the app's own field styling on the one box people
  // type into most.
  const row = useRef<HTMLDivElement>(null);
  const boxOf = (): HTMLInputElement | null => row.current?.querySelector("input") ?? null;
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
          {snapshot.state === "loading" ? "读取团队中……" : `${folder} 的团队已经不在了。`}
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
  const draft = running ? undefined : mentionDraftAt(instruction, caret, seatNames);
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
        // The roll-call is stripped: a seat that also found 「@架构」 inside
        // its own task would be reading an address as an instruction.
        instruction: sent,
        ...(seatIds.length === 0 ? {} : { seatIds }),
      });
      // Cleared after a successful send: a quote is about the question you
      // just asked, and leaving it selected would silently attach it to the
      // next one too.
      clearQuotes(current.teamId);
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
        发给团队「{current.displayName}」{current.seats.length === 0 ? " · 还没有成员" : ""}
      </div>

      <div className={styles.row} ref={row}>
        <Input
          className={styles.grow ?? ""}
          value={instruction}
          placeholder={`跟「${current.displayName}」说点什么，@ 点名单独问某人…`}
          disabled={running}
          onChange={(event) => {
            setInstruction(event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
            setHighlight(0);
          }}
          onSelect={(event) => setCaret((event.target as HTMLInputElement).selectionStart ?? 0)}
          onKeyDown={(event) => {
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
            if (event.key === "Enter" && !running && instruction.trim() !== "") void send();
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
            ? `进行中 ${elapsed}s`
            : named.length === 0
              ? "问所有人"
              : `问 ${named.map((seat) => seat.displayName).join("、")}`}
        </Button>
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
            叫停
          </Button>
        )}
      </div>

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
          成员：{current.seats.map((seat) => seat.displayName).join("、") || "（还没有）"}
          {named.length === 0 ? " · 不点名就是问所有人" : ""}
        </span>
      </div>

      {!misnamed ? null : (
        <div className={styles.error}>
          没有叫「{mentions.unknown.join("、")}」的成员。名字打错的话这句话会发给全团，所以先改过来。
        </div>
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
      {blocked.length === 0 ? null : (
        <div className={styles.error}>
          {allBlocked ? "这一轮问不出去：" : "这几位跑不了，会被跳过："}
          {blocked.map((seat) => `${seat.displayName}（${seat.blocked}）`).join("、")}
        </div>
      )}
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
    </div>
  );
}
