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
import { CONNECTION_KEY, remembered, speech, SPEED_KEY } from "./speech.ts";
import type { SquadSnapshot } from "./api.ts";
import { useT } from "./locale.ts";
import styles from "./panel.module.css";

const remember = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* see `remembered` */
  }
};

export function ListenBar({ connections }: { readonly connections: SquadSnapshot["connections"] }): JSX.Element {
  const t = useT();
  const [connectionId, setConnectionId] = useState(() => remembered(CONNECTION_KEY, ""));
  const [speed, setSpeed] = useState(() => Number(remembered(SPEED_KEY, "1")) || 1);

  useEffect(() => speech.configure(connectionId, speed), [connectionId, speed]);

  return (
    <details className={styles.section}>
      <summary className={styles.sectionToggle}>
        {t("listen.head")}
        {connectionId === "" ? t("listen.head.unset") : ""}
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
          <option value="">{t("listen.pick")}</option>
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
      <div className={styles.hint}>{t("listen.hint")}</div>
    </details>
  );
}
