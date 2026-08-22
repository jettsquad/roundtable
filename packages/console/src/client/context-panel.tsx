/**
 * context-panel.tsx — the checkpoint, and how close the next one is.
 *
 * Folding was working and invisible. When a discussion crosses the token
 * threshold the secretary replaces the earlier turns with a summary, and the
 * seats read that summary from then on — so a later answer can be thinner
 * than the discussion deserved and nothing on screen says the record it was
 * built from had been swapped.
 *
 * 1.x put the checkpoint in front of the host with a revoke control, and the
 * reason holds: the fold is a judgement made by a model about what mattered,
 * and the person who has to live with it should be able to read it and undo
 * it.
 */
import { useState } from "react";
import { MarkdownText } from "@deepseek-ai/dsh-client-ui-primitives";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { api, useAction, type TeamSummary } from "./api.ts";
import styles from "./panel.module.css";

export function ContextPanel({
  team,
  onChanged,
}: {
  readonly team: TeamSummary;
  readonly onChanged: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const { error, run } = useAction(onChanged);
  const { accumulated, limit, checkpoint, checkpointCount } = team.context;
  const pct = limit === 0 ? 0 : Math.min(100, Math.round((accumulated / limit) * 100));

  return (
    <div className={styles.section}>
      <div className={styles.row}>
        <button type="button" className={styles.sectionToggle} onClick={() => setOpen(!open)}>
          {open ? "▾ " : "▸ "}
          上下文
        </button>
        {/* The number people need is how close the NEXT fold is — after it
            happens is too late to have wanted it later. */}
        <span className={styles.muted}>
          {accumulated.toLocaleString()} / {limit.toLocaleString()} token（{pct}%）
          {checkpointCount === 0 ? " · 还没折叠过" : ` · 已折叠 ${checkpointCount} 次`}
        </span>
      </div>

      {!open ? null : (
        <div>
          <div className={styles.hint}>
            超过阈值时，秘书会把此前的讨论压成一份要点，之后席位读到的就是那份要点而不是原文。 也可以现在就折叠。
          </div>
          <div className={styles.row}>
            <Button
              type="button"
              disabled={team.busy}
              onClick={() => void run(() => api.fold({ teamId: team.teamId }))}
            >
              现在折叠
            </Button>
            {team.busy ? <span className={styles.hint}>这一轮还在跑，等它结束。</span> : null}
          </div>

          {checkpoint === undefined ? (
            <div className={styles.hint}>目前没有生效的检查点，席位读到的是完整原文。</div>
          ) : (
            <div className={styles.card}>
              <div className={styles.row}>
                <span className={styles.teamName}>当前检查点</span>
                <span className={styles.muted}>{new Date(checkpoint.createdAt).toLocaleString()}</span>
                <Button
                  type="button"
                  onClick={() => {
                    // Asked first, and the question says what comes back: the
                    // original turns are not gone, they were only being stood
                    // in for.
                    if (window.confirm("作废这个检查点？被它折叠掉的原文会重新进入席位的上下文。")) {
                      void run(() => api.revokeCheckpoint({ teamId: team.teamId, revokeId: checkpoint.id }));
                    }
                  }}
                >
                  作废
                </Button>
              </div>
              <div className={styles.messageBody}>
                <MarkdownText text={checkpoint.text} />
              </div>
            </div>
          )}
          {error === undefined ? null : <div className={styles.error}>{error}</div>}
        </div>
      )}
    </div>
  );
}
