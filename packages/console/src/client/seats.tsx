/**
 * seats.tsx — the roster of one team, and what each seat runs on.
 */
import { useState } from "react";
import type { AuthMode, ConnectionView, SeatCaps } from "@squad/shared";
import { api, type SeatSummary, type TeamSummary } from "./api.ts";
import { CapsEditor } from "./caps.tsx";
import styles from "./panel.module.css";

interface SeatEditorProps {
  readonly team: TeamSummary;
  readonly connections: readonly ConnectionView[];
  readonly onChanged: () => void;
}

/**
 * The auth mode a seat actually runs under.
 *
 * A seat naming no connection runs on the host's own login, which is a
 * subscription — a real choice, not a missing value, and the caps that can
 * bind it are the subscription ones.
 */
function modeOf(seat: SeatSummary, connections: readonly ConnectionView[]): AuthMode {
  if (seat.connectionId === undefined) return "subscription";
  return connections.find((c) => c.connectionId === seat.connectionId)?.authMode ?? "subscription";
}

export function SeatEditor({ team, connections, onChanged }: SeatEditorProps): JSX.Element {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    setError(undefined);
    try {
      await work();
      onChanged();
      return true;
    } catch (failure) {
      setError(String((failure as Error).message ?? failure));
      return false;
    }
  };

  const add = async (): Promise<void> => {
    if (!(await run(() => api.addSeat({ teamId: team.teamId, displayName: name, role })))) return;
    setName("");
    setRole("");
  };

  /**
   * Removing the secretary asks first.
   *
   * Not because deleting a seat is dangerous, but because a team with no
   * secretary has no seat that can plan an agenda — it stops being able to do
   * the thing teams exist for, and nothing about the roster afterwards says
   * that is why.
   */
  const drop = (seat: SeatSummary): void => {
    if (seat.isSecretary && !window.confirm(`${seat.displayName} 是秘书，删掉之后这支团队就没法排议程了。继续？`)) {
      return;
    }
    void run(() =>
      api.removeSeat({
        teamId: team.teamId,
        seatId: seat.seatId,
        ...(seat.isSecretary ? { confirmSecretary: true } : {}),
      }),
    );
  };

  const setCaps = (seat: SeatSummary, caps: SeatCaps): void => {
    void run(() => api.patchSeat({ teamId: team.teamId, seatId: seat.seatId, caps })).then(() => setEditing(undefined));
  };

  return (
    <div>
      <div className={styles.seats}>
        {team.seats.map((seat) => (
          <span key={seat.seatId} className={`${styles.seat} ${seat.running ? styles.running : ""}`}>
            {seat.isSecretary ? "★ " : ""}
            {seat.displayName}
            <span className={styles.muted}>{seat.role}</span>
            <button
              type="button"
              className={styles.drop}
              title="上限"
              onClick={() => setEditing(editing === seat.seatId ? undefined : seat.seatId)}
            >
              ⚙
            </button>
            <button type="button" className={styles.drop} title="删除" onClick={() => drop(seat)}>
              ×
            </button>
          </span>
        ))}
      </div>

      {team.seats.map((seat) =>
        editing !== seat.seatId ? null : (
          <CapsEditor
            key={seat.seatId}
            caps={seat.caps}
            mode={modeOf(seat, connections)}
            onSave={(caps) => setCaps(seat, caps)}
          />
        ),
      )}

      {connections.length === 0 ? null : (
        <div className={styles.row}>
          {team.seats.map((seat) => (
            <select
              key={`${seat.seatId}-conn`}
              className={styles.field}
              value={seat.connectionId ?? ""}
              onChange={(event) =>
                void run(() =>
                  api.patchSeat({ teamId: team.teamId, seatId: seat.seatId, connectionId: event.target.value }),
                )
              }
            >
              <option value="">{seat.displayName}：本机登录</option>
              {connections.map((connection) => (
                <option key={connection.connectionId} value={connection.connectionId}>
                  {seat.displayName}：{connection.displayName}
                </option>
              ))}
            </select>
          ))}
        </div>
      )}

      <div className={styles.row}>
        <input
          className={styles.field}
          value={name}
          placeholder="新席位名"
          onChange={(event) => setName(event.target.value)}
        />
        <input
          className={styles.field}
          value={role}
          placeholder="角色"
          onChange={(event) => setRole(event.target.value)}
        />
        <button type="button" className={styles.button} onClick={() => void add()}>
          加席位
        </button>
      </div>
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
    </div>
  );
}
