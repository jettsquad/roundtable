/**
 * create.tsx — building a team.
 */
import { useState } from "react";
import { api, useAction } from "./api.ts";
import { checkTeamFields, type FieldProblem } from "../parse.ts";
import { FolderField } from "./folder-picker.tsx";
import styles from "./panel.module.css";

export function CreateForm({ onCreated }: { readonly onCreated: () => void }): JSX.Element {
  const [displayName, setDisplayName] = useState("");
  const [projectFolder, setProjectFolder] = useState("");
  const [roster, setRoster] = useState("");
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);
  const { error, run } = useAction(onCreated);

  const complaint = (field: FieldProblem["field"]): string | undefined =>
    problems.find((problem) => problem.field === field)?.detail;

  const create = async (): Promise<void> => {
    // Checked field by field before posting. The route still refuses — the
    // host is the authority — but its refusal is the slash command's usage
    // line, which is right for the command and wrong under three empty boxes.
    const found = checkTeamFields({ displayName, projectFolder, roster });
    setProblems(found);
    if (found.length > 0) return;
    const ok = await run(() => api.createTeam({ displayName, projectFolder, roster }));
    if (!ok) return;
    setDisplayName("");
    setProjectFolder("");
    setRoster("");
  };

  return (
    <div className={styles.card}>
      <div className={styles.subhead}>新建团队</div>
      <div className={styles.row}>
        <input
          className={`${styles.field} ${complaint("displayName") === undefined ? "" : styles.invalid}`}
          value={displayName}
          placeholder="团队名"
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </div>
      {complaint("displayName") === undefined ? null : <div className={styles.error}>{complaint("displayName")}</div>}

      <FolderField
        value={projectFolder}
        onChange={setProjectFolder}
        invalid={complaint("projectFolder") !== undefined}
      />
      {complaint("projectFolder") === undefined ? null : (
        <div className={styles.error}>{complaint("projectFolder")}</div>
      )}

      <div className={styles.row}>
        <input
          className={`${styles.field} ${complaint("roster") === undefined ? "" : styles.invalid}`}
          value={roster}
          placeholder="甲*=架构, 乙=测试"
          onChange={(event) => setRoster(event.target.value)}
        />
        <button type="button" className={styles.button} onClick={() => void create()}>
          建团队
        </button>
      </div>
      {complaint("roster") === undefined ? null : <div className={styles.error}>{complaint("roster")}</div>}
      <div className={styles.hint}>
        名字后面加 * 就是秘书——只有秘书能排议程，不指一个的话这支团队开不了会。建好之后可以从 Agent 库里加人。
      </div>
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
    </div>
  );
}
