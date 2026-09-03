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
import styles from "./panel.module.css";

const blank = (): PromptBlock => ({ blockId: "", name: "", text: "" });

export function BlocksPage({
  blocks,
  onChanged,
}: {
  readonly blocks: readonly PromptBlock[];
  readonly onChanged: () => void;
}): JSX.Element {
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
        <div className={styles.subhead}>{editing ? "编辑片段" : "新建片段"}</div>
        <input
          className={styles.field}
          placeholder="名字，比如「完整工作方法」"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        {/* Said here rather than in a tooltip: the name is not a label, it
            becomes a heading inside every prompt that carries this block, and
            somebody choosing 「abc」 should know that before they save it. */}
        <div className={styles.hint}>名字会成为提示词里的小标题——席位读到的就是它。</div>
        <textarea
          className={styles.textarea}
          rows={12}
          placeholder={"写这一段的正文。\n对哪几个席位成立由团队那边决定，这里只管内容。"}
          value={draft.text}
          onChange={(event) => setDraft({ ...draft, text: event.target.value })}
        />
        {error === undefined ? null : <div className={styles.error}>{error}</div>}
        <div className={styles.row}>
          <button type="button" className={styles.button} onClick={save}>
            {editing ? "保存" : "建这段"}
          </button>
          <button type="button" className={styles.button} onClick={() => setDraft(blank())}>
            清空
          </button>
        </div>
        <div className={styles.hint}>
          改这里只影响之后新建的团队。已经建好的团队各拿着自己的副本，要它们更新，到那支团队里点刷新。
        </div>
      </div>

      <div className={styles.column}>
        <div className={styles.subhead}>已有片段（{blocks.length}）</div>
        {blocks.length === 0 ? (
          <div className={styles.hint}>还没有。左边写一段，之后每支团队都能直接挂上它。</div>
        ) : null}
        {blocks.map((block) => (
          <div key={block.blockId} className={styles.card}>
            <div className={styles.row}>
              <span className={styles.teamName}>{block.name}</span>
              <span className={styles.muted}>{block.text.trim().length} 字</span>
            </div>
            <div className={styles.muted}>{block.text.trim().slice(0, 90)}…</div>
            <div className={styles.row}>
              <button type="button" className={styles.button} onClick={() => setDraft(block)}>
                编辑
              </button>
              <button
                type="button"
                className={styles.button}
                onClick={() => {
                  // Asked first, and the question says what survives: teams
                  // that already copied this go on working, which is the
                  // whole reason the delete is soft.
                  if (window.confirm(`删掉「${block.name}」？已经用它的团队不受影响，但库里就没有了。`)) {
                    void api.removeBlock({ blockId: block.blockId }).then(onChanged);
                  }
                }}
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
