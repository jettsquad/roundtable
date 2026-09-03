/**
 * order-controls.tsx — moving one row up or down, and finding one in a long list.
 *
 * Buttons rather than drag-and-drop, deliberately. A drag needs pointer
 * capture, an insertion indicator, autoscroll and a touch story; two arrows
 * need none of that and answer the actual complaint — 「常用的那个沉在第 17
 * 位」 — the same way. Drag can come later, on top of the same persisted
 * `order`.
 *
 * The order lives on the record, not in the browser: a list whose arrangement
 * resets on reload is a list nobody bothers to arrange.
 */
import { useState } from "react";
import styles from "./panel.module.css";

export function MoveButtons({
  index,
  count,
  onMove,
  label,
}: {
  readonly index: number;
  readonly count: number;
  readonly onMove: (delta: number) => Promise<unknown>;
  /** What is being moved, for the tooltip: 「上移 赤木晴子」. */
  readonly label: string;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const move = (delta: number): void => {
    setBusy(true);
    void onMove(delta).finally(() => setBusy(false));
  };
  return (
    <>
      <button
        type="button"
        className={styles.nudge}
        title={`上移 ${label}`}
        disabled={busy || index === 0}
        onClick={() => move(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        className={styles.nudge}
        title={`下移 ${label}`}
        disabled={busy || index >= count - 1}
        onClick={() => move(1)}
      >
        ↓
      </button>
    </>
  );
}

/**
 * A filter box, and the matcher that goes with it.
 *
 * Case-insensitive substring over whatever fields the caller thinks identify
 * a row. Not fuzzy: a fuzzy match on a 17-item list mostly produces surprises,
 * and 「搜不到」 on a list you can see is worse than scrolling it.
 */
export function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly placeholder: string;
}): JSX.Element {
  return (
    <input
      className={styles.search}
      type="search"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** Whether any of `fields` contains `query`. An empty query matches everything. */
export function matches(query: string, ...fields: readonly (string | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return fields.some((field) => (field ?? "").toLowerCase().includes(needle));
}
