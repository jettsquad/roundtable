/**
 * seats.tsx — one team's roster, and what each seat runs on.
 */
import { useState } from "react";
import type { AgentTemplate, AuthMode, ConnectionView, SeatCaps } from "@squad/shared";
import { api, useAction, type SeatSummary, type TeamSummary } from "./api.ts";
import { CapsEditor } from "./caps.tsx";
import styles from "./panel.module.css";

interface SeatEditorProps {
  readonly team: TeamSummary;
  readonly connections: readonly ConnectionView[];
  readonly agents: readonly AgentTemplate[];
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

/** What this seat runs on, in words. */
function connectionLabel(seat: SeatSummary, connections: readonly ConnectionView[]): string {
  if (seat.connectionId === undefined) return "本机登录";
  const connection = connections.find((c) => c.connectionId === seat.connectionId);
  if (connection === undefined) return "⚠️ 连接已删除";
  const model = connection.modelId === undefined ? "" : ` · ${connection.modelId}`;
  const key = connection.authMode === "api-key" && !connection.credentialConfigured ? " · ⚠️ 密钥未配置" : "";
  return `${connection.displayName}${model}${key}`;
}

export function SeatEditor({ team, connections, agents, onChanged }: SeatEditorProps): JSX.Element {
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  const [pick, setPick] = useState("");
  const { error, run } = useAction(onChanged);

  /**
   * Removing the secretary asks first.
   *
   * Not because deleting a seat is dangerous, but because a team with no
   * secretary has no seat that can plan an agenda — it stops being able to do
   * the thing teams exist for, and the roster afterwards does not say that is
   * why.
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
    void run(() => api.patchSeat({ teamId: team.teamId, seatId: seat.seatId, caps }));
  };

  return (
    <div>
      {team.seats.map((seat) => (
        <div key={seat.seatId} className={styles.seatRow}>
          <button
            type="button"
            className={styles.seatHead}
            onClick={() => setExpanded(expanded === seat.seatId ? undefined : seat.seatId)}
          >
            <span className={styles.dot} style={{ background: seat.color ?? "#5a5a62" }} />
            <span className={seat.running ? styles.running : undefined}>
              {seat.isSecretary ? "★ " : ""}
              {seat.displayName}
            </span>
            <span className={styles.muted}>{seat.role}</span>
            <span className={styles.muted}>{connectionLabel(seat, connections)}</span>
            {seat.permissionMode === undefined ? null : <span className={styles.muted}>{seat.permissionMode}</span>}
            {/* Running is the difference between a seat that will answer and
                one that already is; it belongs on the row, not in a legend. */}
            {seat.running ? <span className={styles.badgeRun}>发言中</span> : null}
            <span className={styles.muted}>{expanded === seat.seatId ? "▾" : "▸"}</span>
          </button>

          {expanded !== seat.seatId ? null : (
            <div className={styles.seatBody}>
              <div className={styles.prompt}>{seat.systemPrompt}</div>
              <div className={styles.row}>
                <select
                  className={styles.field}
                  value={seat.connectionId ?? ""}
                  onChange={(event) =>
                    void run(() =>
                      api.patchSeat({ teamId: team.teamId, seatId: seat.seatId, connectionId: event.target.value }),
                    )
                  }
                >
                  <option value="">本机登录</option>
                  {connections.map((connection) => (
                    <option key={connection.connectionId} value={connection.connectionId}>
                      {connection.displayName}
                    </option>
                  ))}
                </select>
                <button type="button" className={styles.button} onClick={() => drop(seat)}>
                  删除席位
                </button>
              </div>
              <CapsEditor caps={seat.caps} mode={modeOf(seat, connections)} onSave={(caps) => setCaps(seat, caps)} />
            </div>
          )}
        </div>
      ))}

      <div className={styles.row}>
        <select className={styles.field} value={pick} onChange={(event) => setPick(event.target.value)}>
          <option value="">从 Agent 库里加人…</option>
          {agents.map((agent) => (
            <option key={agent.templateId} value={agent.templateId}>
              {agent.displayName} · {agent.role}
              {agent.secretaryCandidate ? " ★" : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.button}
          disabled={pick === ""}
          onClick={() => {
            const agent = agents.find((candidate) => candidate.templateId === pick);
            void run(() =>
              api.addSeat({
                teamId: team.teamId,
                templateId: pick,
                // Offered only when the library said this agent may be one,
                // and refused by the host otherwise — the checkbox is not
                // where that decision lives.
                ...(agent?.secretaryCandidate === true && team.seats.every((seat) => !seat.isSecretary)
                  ? { isSecretary: true }
                  : {}),
              }),
            ).then((ok) => {
              if (ok) setPick("");
            });
          }}
        >
          加进来
        </button>
        {agents.length === 0 ? <span className={styles.hint}>Agent 库是空的——先去「Agent 库」建一个。</span> : null}
      </div>
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
    </div>
  );
}
