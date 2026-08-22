/**
 * folder-picker.tsx — choosing a project folder without typing a path.
 *
 * 1.x opened Electron's native dialog. A web app has none, and the text box
 * that replaced it asks a person to type an absolute path from memory —
 * which they mistype, and the team is then built against a folder that does
 * not exist or, worse, one that does and is the wrong one.
 *
 * So: a small browser over the host's own directory listing. Names only, no
 * files, no contents. It starts at the home directory and walks down; the
 * current path is always visible and always the thing that gets used, so
 * there is no gap between what is shown and what is chosen.
 */
import { useEffect, useState } from "react";
import { api, type DirectoryListing } from "./api.ts";
import styles from "./panel.module.css";

interface FolderPickerProps {
  readonly value: string;
  readonly onPick: (path: string) => void;
  readonly onClose: () => void;
}

export function FolderPicker({ value, onPick, onClose }: FolderPickerProps): JSX.Element {
  const [listing, setListing] = useState<DirectoryListing | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const go = (path?: string, child?: string): void => {
    setError(undefined);
    void api
      .browse({ ...(path === undefined ? {} : { path }), ...(child === undefined ? {} : { child }) })
      .then(setListing)
      .catch((failure: Error) => setError(String(failure.message)));
  };

  // Opens where the field already points, when it points anywhere: reopening
  // a picker at the home directory after you had already navigated somewhere
  // makes the second edit as expensive as the first.
  useEffect(() => go(value.trim() === "" ? undefined : value.trim()), []);

  return (
    <div className={styles.picker}>
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
      <div className={styles.pickerPath}>{listing?.path ?? "读取中……"}</div>
      <div className={styles.pickerList}>
        {listing?.parent === undefined ? null : (
          <button type="button" className={styles.pickerRow} onClick={() => go(listing.parent)}>
            ../
          </button>
        )}
        {listing?.directories.length === 0 ? <div className={styles.hint}>这里没有子文件夹。</div> : null}
        {(listing?.directories ?? []).map((name) => (
          <button key={name} type="button" className={styles.pickerRow} onClick={() => go(listing?.path, name)}>
            {name}/
          </button>
        ))}
      </div>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.button}
          disabled={listing === undefined}
          onClick={() => {
            if (listing !== undefined) onPick(listing.path);
          }}
        >
          就用这个
        </button>
        <button type="button" className={styles.button} onClick={onClose}>
          取消
        </button>
      </div>
    </div>
  );
}

/** A read-only path display with a button that opens the picker. */
export function FolderField({
  value,
  onChange,
  invalid,
}: {
  readonly value: string;
  readonly onChange: (path: string) => void;
  readonly invalid?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.grow}>
      <div className={styles.row}>
        <span className={`${styles.pathBox} ${invalid === true ? styles.invalid : ""}`}>
          {value === "" ? <span className={styles.muted}>还没有选项目文件夹</span> : value}
        </span>
        <button type="button" className={styles.button} onClick={() => setOpen(!open)}>
          {open ? "收起" : "选文件夹…"}
        </button>
      </div>
      {!open ? null : (
        <FolderPicker
          value={value}
          onClose={() => setOpen(false)}
          onPick={(path) => {
            onChange(path);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
