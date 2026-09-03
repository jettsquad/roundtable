/**
 * folder-picker.tsx — choosing a project folder.
 *
 * Two shapes, because dsh's `ctx.directoryPicker` seam has two and they
 * differ in interaction, not just mechanism: a `native` host opens one OS
 * chooser on its own display, and a `browse` host serves listing primitives
 * for an in-app browser — which is what a REMOTE client gets, because no OS
 * dialog can reach it.
 *
 * The first version hand-rolled a `readdir` route and always drew the in-app
 * list. That meant a machine with a real file dialog never got to use it, and
 * the clumsy path was the only one anyone saw. Which shape to draw is decided
 * from the snapshot, before the first click.
 */
import { useEffect, useState } from "react";
import { api, type DirectoryListing, type PickerKind } from "./api.ts";
import styles from "./panel.module.css";

interface BrowserProps {
  readonly value: string;
  readonly onPick: (path: string) => void;
  readonly onClose: () => void;
}

/** The in-app browser, for a host with no OS dialog to open. */
function DirectoryBrowser({ value, onPick, onClose }: BrowserProps): JSX.Element {
  const [listing, setListing] = useState<DirectoryListing | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const go = (path?: string): void => {
    setError(undefined);
    void api
      .browse(path === undefined ? {} : { path })
      .then(setListing)
      .catch((failure: Error) => setError(String(failure.message)));
  };

  // Opens where the field already points, when it points anywhere: reopening
  // at the home directory after you had navigated somewhere makes the second
  // edit as expensive as the first.
  //
  // Mount-only on purpose, and `value` is deliberately not a dependency: it is
  // read once, to decide where to open. Adding it would re-navigate on every
  // keystroke — the opposite of what this effect is for.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => go(value.trim() === "" ? undefined : value.trim()), []);

  return (
    <div className={styles.picker}>
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
      <div className={styles.crumbs}>
        {(listing?.crumbs ?? []).map((crumb) => (
          <button key={crumb.path} type="button" className={styles.crumb} onClick={() => go(crumb.path)}>
            {crumb.name}
          </button>
        ))}
      </div>
      <div className={styles.pickerList}>
        {listing === undefined ? <div className={styles.hint}>读取中……</div> : null}
        {listing?.entries.length === 0 ? <div className={styles.hint}>这里没有子文件夹。</div> : null}
        {(listing?.entries ?? []).map((entry) => (
          <button key={entry.path} type="button" className={styles.pickerRow} onClick={() => go(entry.path)}>
            {entry.name}/
          </button>
        ))}
        {/* Said out loud. A truncated listing that looked complete would send
            someone hunting for a folder the host simply did not report. */}
        {listing?.truncated === true ? <div className={styles.hint}>子文件夹太多，这里只列了一部分。</div> : null}
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
          就用 {listing?.path ?? "……"}
        </button>
        <button type="button" className={styles.button} onClick={onClose}>
          取消
        </button>
      </div>
    </div>
  );
}

/** The path, and whatever control this host can offer for changing it. */
export function FolderField({
  value,
  onChange,
  kind,
  invalid,
}: {
  readonly value: string;
  readonly onChange: (path: string) => void;
  readonly kind: PickerKind;
  readonly invalid?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const openNative = (): void => {
    setError(undefined);
    void api
      .pickDirectory()
      .then((picked) => {
        // `null` is a cancellation, not a failure. Putting a red line under a
        // decision someone meant to make is its own kind of wrong.
        if (picked.path !== null) onChange(picked.path);
      })
      .catch((failure: Error) => setError(String(failure.message)));
  };

  return (
    <div className={styles.grow}>
      <div className={styles.row}>
        <span className={`${styles.pathBox} ${invalid === true ? styles.invalid : ""}`}>
          {value === "" ? <span className={styles.muted}>还没有选项目文件夹</span> : value}
        </span>
        {kind === "none" ? (
          <span className={styles.hint}>这台宿主没有可用的文件夹选择器。</span>
        ) : (
          <button
            type="button"
            className={styles.button}
            onClick={() => (kind === "native" ? openNative() : setOpen(!open))}
          >
            {kind === "native" ? "选择文件夹…" : open ? "收起" : "选择文件夹…"}
          </button>
        )}
      </div>
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
      {kind !== "browse" || !open ? null : (
        <DirectoryBrowser
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
