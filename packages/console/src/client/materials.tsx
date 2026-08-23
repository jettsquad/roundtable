/**
 * materials.tsx — importing the documents a team argues about.
 *
 * The last item on the 1.x list. A team asked to review a design cannot
 * review one it has never been shown, and pasting forty pages into the
 * message box is not a workaround — it is the absence of this.
 *
 * The file is read in the browser and its BYTES are posted; the server does
 * the extracting, because that is where the PDF and Word parsers can run.
 * There is no native file picker in this composition, and an `<input
 * type="file">` needs none: it is the browser's own, it already knows about
 * drag-and-drop, and it works the same in the desktop app and in a tab.
 */
import { useRef, useState } from "react";
import { api, useAction, type TeamSummary } from "./api.ts";
import styles from "./panel.module.css";

/** The extensions the server can actually read, said in the picker itself. */
const ACCEPT = ".pdf,.docx,.md,.markdown,.txt,.text,.csv,.json,.yaml,.yml";

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
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const { error, setError, run } = useAction(onChanged);
  const total = team.materials.reduce((sum, material) => sum + material.chars, 0);

  const send = async (files: FileList): Promise<void> => {
    setError(undefined);
    // One at a time, and the failures are reported per file rather than as a
    // single "something went wrong": a person who picked four documents and
    // got one refusal needs to know which one.
    for (const file of Array.from(files)) {
      setBusy(file.name);
      try {
        await api.addMaterial(team.teamId, file.name, await file.arrayBuffer());
      } catch (failure) {
        setError(String((failure as Error).message));
      }
    }
    setBusy(undefined);
    onChanged();
  };

  return (
    <div className={styles.section}>
      <div className={styles.row}>
        <span className={styles.subhead}>背景资料</span>
        <span className={styles.muted}>
          {team.materials.length === 0 ? "还没有" : `${team.materials.length} 份 · 合计 ${sizeOf(total)}`}
        </span>
        <button
          type="button"
          className={styles.button}
          disabled={busy !== undefined}
          onClick={() => picker.current?.click()}
        >
          {busy === undefined ? "导入文件" : `读取 ${busy}…`}
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          accept={ACCEPT}
          style={{ display: "none" }}
          onChange={(event) => {
            const files = event.target.files;
            if (files !== null && files.length > 0) void send(files);
            // Cleared so picking the SAME file again still fires a change —
            // re-importing a document you have just edited is a normal thing
            // to want, and without this the second attempt does nothing.
            event.target.value = "";
          }}
        />
      </div>
      <div className={styles.hint}>
        PDF、Word（.docx）、Markdown、纯文本。导入后每一轮都会进每个席位的上下文——所以贵的不是这一次，是每一次。
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
