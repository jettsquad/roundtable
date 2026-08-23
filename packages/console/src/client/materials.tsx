/**
 * materials.tsx — importing the documents a team argues about.
 *
 * The last item on the 1.x list. A team asked to review a design cannot
 * review one it has never been shown, and pasting forty pages into the
 * message box is not a workaround — it is the absence of this.
 *
 * The IMPORT control is not here — it sits beside the send button, because
 * attaching a document is part of saying what you want the team to work on.
 * What is left here is the list: what the team is carrying, how big it is,
 * and how to take one away. That is status, and status belongs with the rest
 * of the team's status.
 */
import { api, useAction, type TeamSummary } from "./api.ts";
import styles from "./panel.module.css";

function sizeOf(chars: number): string {
  return chars < 1000 ? `${chars} 字` : `${(chars / 1000).toFixed(1)}k 字`;
}

export function Materials({
  team,
  onChanged,
}: {
  readonly team: TeamSummary;
  readonly onChanged: () => void;
}): JSX.Element {
  const { error, run } = useAction(onChanged);
  const total = team.materials.reduce((sum, material) => sum + material.chars, 0);

  return (
    <div className={styles.section}>
      <div className={styles.row}>
        <span className={styles.subhead}>背景资料</span>
        <span className={styles.muted}>
          {team.materials.length === 0 ? "还没有" : `${team.materials.length} 份 · 合计 ${sizeOf(total)}`}
        </span>
        <span className={styles.hint}>用输入框旁边的「＋资料」导入</span>
      </div>

      {team.materials.map((material) => (
        <div key={material.materialId} className={styles.row}>
          <span className={styles.pill}>{material.name}</span>
          <span className={styles.muted}>
            {sizeOf(material.chars)} · {new Date(material.addedAt).toLocaleString()}
          </span>
          <button
            type="button"
            className={styles.drop}
            onClick={() => {
              // Asked first, and the question says what happens: the seats
              // stop seeing it, which is a change to what the team knows.
              if (window.confirm(`移掉「${material.name}」？之后席位就看不到它了。`)) {
                void run(() => api.removeMaterial({ teamId: team.teamId, materialId: material.materialId }));
              }
            }}
          >
            移除
          </button>
        </div>
      ))}
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
    </div>
  );
}
