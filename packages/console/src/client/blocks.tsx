/**
 * blocks.tsx — the prompt fragment library.
 *
 * User-level, beside the agents and the connections, because a fragment
 * outlives the team that first needed it: 「产出前自查这五条」 is not a fact
 * about one roster. A team COPIES what it uses, so editing here changes what
 * the NEXT team gets and leaves running teams alone — the same bargain the
 * agent library makes, and the same one it has to keep saying out loud.
 */
import { useState } from "react";
import type { PromptBlock } from "@squad/shared";
import { api } from "./api.ts";
import { useT } from "./locale.ts";
import styles from "./panel.module.css";

const blank = (): PromptBlock => ({ blockId: "", name: "", text: "" });

export function BlocksPage({
  blocks,
  onChanged,
}: {
  readonly blocks: readonly PromptBlock[];
  readonly onChanged: () => void;
}): JSX.Element {
  const t = useT();
  const [draft, setDraft] = useState<PromptBlock>(blank());
  const [error, setError] = useState<string | undefined>(undefined);
  const editing = blocks.some((block) => block.blockId === draft.blockId);

  const save = (): void => {
    setError(undefined);
    const blockId = draft.blockId === "" ? `blk-${Date.now().toString(36)}` : draft.blockId;
    void api
      .saveBlock({ ...draft, blockId })
      .then(() => {
        setDraft(blank());
        onChanged();
      })
      .catch((problem: Error) => setError(problem.message));
  };

  return (
    <div className={styles.twoColumn}>
      <div className={`${styles.column} ${styles.columnSticky}`}>
        <div className={styles.subhead}>{editing ? t("blocks.edit") : t("blocks.new")}</div>
        <input
          className={styles.field}
          placeholder={t("blocks.name.placeholder")}
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        {/* Said here rather than in a tooltip: the name is not a label, it
            becomes a heading inside every prompt that carries this block, and
            somebody choosing 「abc」 should know that before they save it. */}
        <div className={styles.hint}>{t("blocks.name.hint")}</div>
        <textarea
          className={styles.textarea}
          rows={12}
          placeholder={t("blocks.text.placeholder")}
          value={draft.text}
          onChange={(event) => setDraft({ ...draft, text: event.target.value })}
        />
        {error === undefined ? null : <div className={styles.error}>{error}</div>}
        <div className={styles.row}>
          <button type="button" className={styles.button} onClick={save}>
            {editing ? t("blocks.save") : t("blocks.create")}
          </button>
          <button type="button" className={styles.button} onClick={() => setDraft(blank())}>
            {t("blocks.clear")}
          </button>
        </div>
        <div className={styles.hint}>{t("blocks.copy.hint")}</div>
      </div>

      <div className={styles.column}>
        <div className={styles.subhead}>{t("blocks.list.head", { n: blocks.length })}</div>
        {blocks.length === 0 ? <div className={styles.hint}>{t("blocks.list.none")}</div> : null}
        {blocks.map((block) => (
          <div key={block.blockId} className={styles.card}>
            <div className={styles.row}>
              <span className={styles.teamName}>{block.name}</span>
              <span className={styles.muted}>{t("blocks.chars", { n: block.text.trim().length })}</span>
            </div>
            <div className={styles.muted}>{block.text.trim().slice(0, 90)}…</div>
            <div className={styles.row}>
              <button type="button" className={styles.button} onClick={() => setDraft(block)}>
                {t("blocks.editAction")}
              </button>
              <button
                type="button"
                className={styles.button}
                onClick={() => {
                  // Asked first, and the question says what survives: teams
                  // that already copied this go on working, which is the
                  // whole reason the delete is soft.
                  if (window.confirm(t("blocks.delete.confirm", { name: block.name }))) {
                    void api.removeBlock({ blockId: block.blockId }).then(onChanged);
                  }
                }}
              >
                {t("blocks.delete")}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
