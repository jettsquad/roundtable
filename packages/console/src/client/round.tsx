/**
 * round.tsx — asking a team something, and reading what it said.
 *
 * The panel could build a team and then had nowhere to go: rounds lived only
 * on `/squad-say`, behind a chat that needs a configured model. The reason
 * given for that was that a command is something a PERSON typed — but a
 * person clicking a button here is exactly as much a person. The invariant
 * this product actually keeps is that no MODEL takes the chair, and a button
 * does not put one there.
 *
 * A round costs real model calls, so the control says so and stays disabled
 * while one is running: two rounds started by accident is money, and the
 * second one reads a discussion the first has not finished writing.
 */
import { useEffect, useState } from "react";
import { api, type SeatReply, type TeamSummary } from "./api.ts";
import styles from "./panel.module.css";

export function RoundBox({
  team,
  onChanged,
}: {
  readonly team: TeamSummary;
  readonly onChanged: () => void;
}): JSX.Element {
  const [instruction, setInstruction] = useState("");
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [running, setRunning] = useState(false);
  /**
   * How long this round has been going.
   *
   * Shown because 「进行中」 alone is a black hole: a seat working and a seat
   * hung on an endpoint that will never answer look identical, and the person
   * has no way to tell how long they have been waiting. The seat backend
   * gives up on its own — this is what makes the wait legible until it does.
   */
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const [replies, setReplies] = useState<readonly SeatReply[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  // Seats that cannot run at all. A round containing only these sends
  // nothing and comes back as failures — which the panel used to let you
  // start, and then explained afterwards with a provider name you never
  // typed.
  const asked = picked.length === 0 ? team.seats : team.seats.filter((seat) => picked.includes(seat.seatId));
  const blocked = asked.filter((seat) => seat.blocked !== undefined);
  const allBlocked = asked.length > 0 && blocked.length === asked.length;

  const ask = async (): Promise<void> => {
    setError(undefined);
    setRunning(true);
    // Cleared before the run, not after. A stale set of replies sitting under
    // a running round reads as this round's answer.
    setReplies(undefined);
    try {
      const result = await api.say({
        teamId: team.teamId,
        instruction,
        ...(picked.length === 0 ? {} : { seatIds: picked }),
      });
      setReplies(result.replies);
      setInstruction("");
      onChanged();
    } catch (failure) {
      setError(String((failure as Error).message ?? failure));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={styles.round}>
      <div className={styles.row}>
        <input
          className={styles.field}
          value={instruction}
          placeholder="跟这支团队说点什么…"
          disabled={running}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !running && instruction.trim() !== "") void ask();
          }}
        />
        <button
          type="button"
          className={styles.button}
          disabled={running || instruction.trim() === "" || team.seats.length === 0 || allBlocked}
          onClick={() => void ask()}
        >
          {running ? `进行中 ${elapsed}s` : picked.length === 0 ? "问所有人" : `问 ${picked.length} 位`}
        </button>
        {!team.busy ? null : (
          <button
            type="button"
            className={styles.button}
            onClick={() => void api.stop({ teamId: team.teamId }).then(onChanged)}
          >
            叫停
          </button>
        )}
      </div>

      {/* Point at seats to ask only them. Nothing selected means everyone,
          which is what a table does by default. */}
      <div className={styles.row}>
        {team.seats.map((seat) => (
          <label key={seat.seatId} className={styles.check}>
            <input
              type="checkbox"
              checked={picked.includes(seat.seatId)}
              disabled={running}
              onChange={() =>
                setPicked(
                  picked.includes(seat.seatId) ? picked.filter((id) => id !== seat.seatId) : [...picked, seat.seatId],
                )
              }
            />
            {seat.displayName}
          </label>
        ))}
      </div>

      {/* Said while it is still happening, not after. A seat that has produced
          nothing for this long is usually pointed at an endpoint that is not
          answering — and the backend is about to say so itself. */}
      {!running || elapsed < 45 ? null : (
        <div className={styles.hint}>
          已经等了 {elapsed} 秒还没有回复。如果是新配的连接，多半是接口地址连不上——到 Agent
          库点「测试」看那一项。席位自己也会超时中止。
        </div>
      )}
      {blocked.length === 0 ? null : (
        <div className={styles.error}>
          {allBlocked ? "这一轮问不出去：" : "这几位跑不了，会被跳过："}
          {blocked.map((seat) => `${seat.displayName}（${seat.blocked}）`).join("、")}
        </div>
      )}
      {error === undefined ? null : <div className={styles.error}>{error}</div>}

      {(replies ?? []).map((reply) => (
        <div key={reply.seatId} className={styles.reply}>
          <div className={styles.row}>
            <span className={styles.teamName}>{reply.displayName}</span>
            {reply.failed ? <span className={styles.badgeBad}>失败</span> : null}
            {/* "The window was empty" and "the seat ignored a full window"
                produce the same answer and are different failures. */}
            <span className={styles.muted}>带了 {reply.contextLines} 行讨论</span>
          </div>
          <div className={styles.replyText}>{reply.text}</div>
        </div>
      ))}
    </div>
  );
}
