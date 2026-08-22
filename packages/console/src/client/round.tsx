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
import { useState } from "react";
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
  const [replies, setReplies] = useState<readonly SeatReply[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

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
          disabled={running || instruction.trim() === "" || team.seats.length === 0}
          onClick={() => void ask()}
        >
          {running ? "进行中…" : picked.length === 0 ? "问所有人" : `问 ${picked.length} 位`}
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
