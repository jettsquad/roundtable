/**
 * audit.tsx — what was decided about this team, and when.
 *
 * Separate from the discussion because they answer different questions. The
 * transcript is what the team SAID; this is what was decided and to what —
 * 「谁确认的、什么时候、跑的是哪一份」, which a scrolling log cannot answer
 * and a model's context should not be spent carrying.
 *
 * Collapsed by default: it is read after something has gone wrong, not
 * while things are going right.
 */
import { useState } from "react";
import type { TeamSummary } from "./api.ts";
import styles from "./panel.module.css";

const LABELS: Record<string, string> = {
  "team-created": "建队",
  "team-renamed": "改名",
  "team-disbanded": "解散",
  "seat-added": "加人",
  "seat-removed": "去人",
  "agenda-drafted": "拟草案",
  "agenda-confirmed": "确认议程",
  "agenda-resumed": "续跑",
  "agenda-paused": "议程暂停",
  "agenda-stopped": "议程叫停",
  "agenda-finished": "议程跑完",
  "agenda-discarded": "丢弃草案",
  "material-added": "导入资料",
  "material-removed": "移除资料",
  "checkpoint-folded": "折叠上下文",
  "checkpoint-revoked": "作废检查点",
};

export function AuditLog({ team }: { readonly team: TeamSummary }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (team.audit.length === 0) return null;

  return (
    <div className={styles.section}>
      <div className={styles.row}>
        <button type="button" className={styles.sectionToggle} onClick={() => setOpen(!open)}>
          {open ? "▾ " : "▸ "}
          决策记录
        </button>
        <span className={styles.muted}>{team.audit.length} 条</span>
      </div>
      {!open ? null : (
        <div>
          {/* Newest first: what went wrong went wrong recently. */}
          {[...team.audit].reverse().map((entry) => (
            <div key={`${entry.at}-${entry.kind}-${entry.detail}`} className={styles.row}>
              <span className={styles.muted}>{new Date(entry.at).toLocaleString()}</span>
              <span className={styles.pill}>{LABELS[entry.kind] ?? entry.kind}</span>
              <span>{entry.detail}</span>
              {entry.agendaHash === undefined ? null : (
                <span className={styles.muted} title="确认指纹：可以据此核对跑的是不是你确认的那一份">
                  {entry.agendaHash}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
