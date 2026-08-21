/**
 * caps.tsx — spend limits for one seat.
 *
 * Which limits can bind depends on the auth mode, and this asks
 * `meaningfulCaps` — the SAME function the host checks with — rather than
 * restating the rule. That is the whole reason this file is TypeScript
 * compiled against `@squad/shared` instead of hand-written JavaScript: a
 * second copy of "a subscription seat bills nothing, so a cost ceiling can
 * never fire" would eventually disagree with the first, and it would
 * disagree in the direction where a person sets a ceiling and relies on it.
 *
 * A cap that cannot bind is not rendered at all rather than rendered
 * disabled. A greyed-out field still reads as "a thing this seat has"; an
 * absent one reads as what it is.
 */
import { useState } from "react";
import { meaningfulCaps, type AuthMode, type SeatCaps } from "@squad/shared";
import { numberOrUndefined } from "./number-field.ts";
import styles from "./panel.module.css";

const LABELS: Readonly<Record<keyof SeatCaps, string>> = {
  maxTurns: "轮数上限",
  maxCostUsd: "花费上限 $",
  maxTokens: "token 上限",
};

interface CapsEditorProps {
  readonly caps: SeatCaps | undefined;
  readonly mode: AuthMode;
  readonly onSave: (caps: SeatCaps) => void;
}

export function CapsEditor({ caps, mode, onSave }: CapsEditorProps): JSX.Element {
  const allowed = meaningfulCaps(mode);
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(allowed.map((key) => [key, caps?.[key] === undefined ? "" : String(caps[key])])),
  );

  const save = (): void => {
    const next: Record<string, number> = {};
    for (const key of allowed) {
      const value = numberOrUndefined(draft[key] ?? "");
      if (value !== undefined) next[key] = value;
    }
    onSave(next as SeatCaps);
  };

  return (
    <div className={styles.row}>
      {allowed.map((key) => (
        <input
          key={key}
          className={`${styles.field} ${styles.narrow}`}
          value={draft[key] ?? ""}
          inputMode="decimal"
          placeholder={LABELS[key]}
          onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
        />
      ))}
      <button type="button" className={styles.button} onClick={save}>
        存上限
      </button>
      {mode === "subscription" ? <span className={styles.hint}>订阅模式不计费，所以没有花费上限。</span> : null}
    </div>
  );
}
