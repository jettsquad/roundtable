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
import { useEffect, useState } from "react";
import { api, useSnapshot, type SeatReply } from "./api.ts";
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
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [running, setRunning] = useState(false);
  const [replies, setReplies] = useState<readonly SeatReply[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);

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

  const asked = picked.length === 0 ? current.seats : current.seats.filter((seat) => picked.includes(seat.seatId));
  const blocked = asked.filter((seat) => seat.blocked !== undefined);
  const allBlocked = asked.length > 0 && blocked.length === asked.length;

  const send = async (): Promise<void> => {
    setError(undefined);
    setRunning(true);
    // Cleared before the run: a stale set of replies under a running round
    // reads as this round's answer.
    setReplies(undefined);
    try {
      const result = await api.say({
        teamId: current.teamId,
        instruction,
        ...(picked.length === 0 ? {} : { seatIds: picked }),
      });
      setReplies(result.replies);
      setInstruction("");
      onSent();
    } catch (failure) {
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

      {(replies ?? []).map((reply) => (
        <div key={reply.seatId} className={styles.reply}>
          <div className={styles.row}>
            <span className={styles.teamName}>{reply.displayName}</span>
            {reply.failed ? <span className={styles.badgeBad}>失败</span> : null}
            <span className={styles.muted}>带了 {reply.contextLines} 行讨论</span>
          </div>
          <div className={styles.replyText}>{reply.text}</div>
        </div>
      ))}

      <div className={styles.row}>
        <input
          className={styles.field}
          value={instruction}
          placeholder={`跟「${current.displayName}」说点什么…`}
          disabled={running}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !running && instruction.trim() !== "") void send();
          }}
        />
        <button
          type="button"
          className={styles.button}
          disabled={running || instruction.trim() === "" || current.seats.length === 0 || allBlocked}
          onClick={() => void send()}
        >
          {running ? `进行中 ${elapsed}s` : picked.length === 0 ? "问所有人" : `问 ${picked.length} 位`}
        </button>
        {!current.busy ? null : (
          <button
            type="button"
            className={styles.button}
            onClick={() => void api.stop({ teamId: current.teamId }).then(onSent)}
          >
            叫停
          </button>
        )}
      </div>

      <div className={styles.row}>
        {current.seats.map((seat) => (
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

      {/* Said while it is still happening. A seat working and a seat hung on
          an endpoint that will never answer look identical from here. */}
      {!running || elapsed < 45 ? null : (
        <div className={styles.hint}>
          已经等了 {elapsed} 秒还没有回复。多半是这个席位的接口地址连不上——到 Agent 库点「测试」看那一项。
        </div>
      )}
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
