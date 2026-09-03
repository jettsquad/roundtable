/**
 * listen.tsx — where the two things speech needs are chosen.
 *
 * Only two: which connection pays for synthesis, and how fast to read. There
 * is no on/off switch any more — playing is a control on each message, where
 * you are when you decide you would rather hear the rest than read it.
 *
 * Per-browser, because it spends the host's quota: a setting stored on the
 * team would mean one person's choice silently billing every other tab that
 * has that team open.
 */
import { useEffect, useState } from "react";
import { speech } from "./speech.ts";
import type { SquadSnapshot } from "./api.ts";
import styles from "./panel.module.css";

const CONNECTION_KEY = "squad.listen.connection";
const SPEED_KEY = "squad.listen.speed";

const remembered = (key: string, fallback: string): string => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    // Private mode, blocked storage: the control still works, it just does
    // not remember. Not worth failing a page over.
    return fallback;
  }
};

const remember = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* see `remembered` */
  }
};

export function ListenBar({ connections }: { readonly connections: SquadSnapshot["connections"] }): JSX.Element {
  const [connectionId, setConnectionId] = useState(() => remembered(CONNECTION_KEY, ""));
  const [speed, setSpeed] = useState(() => Number(remembered(SPEED_KEY, "1")) || 1);

  useEffect(() => speech.configure(connectionId, speed), [connectionId, speed]);

  return (
    <details className={styles.section}>
      <summary className={styles.sectionToggle}>
        朗读设置{connectionId === "" ? "（还没选连接，播放键点不动）" : ""}
      </summary>
      <div className={styles.row}>
        <select
          className={styles.field}
          value={connectionId}
          onChange={(event) => {
            setConnectionId(event.target.value);
            remember(CONNECTION_KEY, event.target.value);
          }}
        >
          <option value="">用哪个连接合成…</option>
          {connections.map((connection) => (
            <option key={connection.connectionId} value={connection.connectionId}>
              {connection.displayName}
            </option>
          ))}
        </select>
        <select
          className={styles.field}
          value={String(speed)}
          onChange={(event) => {
            setSpeed(Number(event.target.value));
            remember(SPEED_KEY, event.target.value);
          }}
        >
          {[0.8, 1, 1.25, 1.5, 2].map((value) => (
            <option key={value} value={value}>
              {value}×
            </option>
          ))}
        </select>
      </div>
      <div className={styles.hint}>
        选好之后，每条发言下面的 ▶ 就能单独播放那一条。代码块和表格会念成一句「略过」，不会逐字念。
      </div>
    </details>
  );
}
