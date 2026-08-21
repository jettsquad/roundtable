/**
 * create.tsx — building a team.
 */
import { useState } from "react";
import { api } from "./api.ts";
import styles from "./panel.module.css";

export function CreateForm({ onCreated }: { readonly onCreated: () => void }): JSX.Element {
  const [displayName, setDisplayName] = useState("");
  const [projectFolder, setProjectFolder] = useState("");
  const [roster, setRoster] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const create = async (): Promise<void> => {
    setError(undefined);
    try {
      await api.createTeam({ displayName, projectFolder, roster });
      setDisplayName("");
      setProjectFolder("");
      setRoster("");
      onCreated();
    } catch (failure) {
      setError(String((failure as Error).message ?? failure));
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.row}>
        <input
          className={styles.field}
          value={displayName}
          placeholder="团队名"
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <input
          className={styles.field}
          value={projectFolder}
          placeholder="项目文件夹（绝对路径）"
          onChange={(event) => setProjectFolder(event.target.value)}
        />
      </div>
      <div className={styles.row}>
        <input
          className={styles.field}
          value={roster}
          placeholder="甲*=架构, 乙=测试"
          onChange={(event) => setRoster(event.target.value)}
        />
        <button type="button" className={styles.button} onClick={() => void create()}>
          建团队
        </button>
      </div>
      <div className={styles.hint}>名字后面加 * 就是秘书——只有秘书能排议程，不指一个的话这支团队开不了会。</div>
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
    </div>
  );
}
