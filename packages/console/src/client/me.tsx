/**
 * me.tsx — what is true of the person, not of any team.
 *
 * One field today. It has a tab of its own rather than a corner of the teams
 * screen because of what it is: the criteria library, the agent library and
 * the connections are all things that outlive a roster, and a name is the
 * same kind of thing. The alternative — an input beside the 「新建团队」
 * button — would say it is a property of the team being created, which is
 * exactly the mistake the stored constant made.
 */
import { useEffect, useState } from "react";
import { api, useAction } from "./api.ts";
import { useT } from "./locale.ts";
import styles from "./panel.module.css";

export function MePage({
  hostDisplayName,
  onChanged,
}: {
  readonly hostDisplayName: string;
  readonly onChanged: () => void;
}): JSX.Element {
  const t = useT();
  const { error, run } = useAction(onChanged);
  const [draft, setDraft] = useState(hostDisplayName);
  // Re-seeded when the snapshot brings a different value — another window may
  // have changed it, and a box still showing the old text would overwrite the
  // new one on the next save.
  useEffect(() => setDraft(hostDisplayName), [hostDisplayName]);

  const dirty = draft.trim() !== hostDisplayName;
  return (
    <div>
      <div className={styles.hint}>{t("me.intro")}</div>

      <div className={styles.subhead}>{t("me.name.head")}</div>
      <div className={styles.row}>
        <input
          className={styles.input}
          value={draft}
          placeholder={t("me.name.placeholder")}
          maxLength={40}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="button"
          className={styles.button}
          disabled={!dirty}
          onClick={() => void run(() => api.saveSettings({ hostDisplayName: draft }))}
        >
          {t("me.name.save")}
        </button>
      </div>
      {/* Said where the change is made, because it is the one thing about this
          field that surprises people: renaming does not rewrite history. */}
      <div className={styles.hint}>{t("me.name.note")}</div>
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
    </div>
  );
}
