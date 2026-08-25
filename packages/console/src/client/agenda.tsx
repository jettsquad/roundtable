/**
 * agenda.tsx — a running agenda, and the control that stops it.
 *
 * This file used to hold three more things, and all three were the same
 * mistake: a control panel where a conversation belongs.
 *
 *  - A box to type an instruction for the secretary to turn into an agenda.
 *  - A 秘书台 with its own input and preset buttons.
 *  - The draft itself, rendered at the top of the tab.
 *
 * The message box already does the first two. The secretary is a SEAT: you
 * write 「@赤木晴子 安排一下接下来的活」 in the same box you use for everyone
 * else, it answers in the discussion where the whole team can read and argue
 * with it, and the 「转成议程」 button on that reply turns the prose into
 * phases. A second input that quietly does the same thing through a different
 * path is not a shortcut — it is a second way to be somewhere else.
 *
 * The draft moved to `draft-card.tsx`, rendered under the reply it came from.
 *
 * What is left here is the one thing that is genuinely not a message: an
 * agenda that is currently RUNNING, and the button that ends it.
 */
import type { TeamSummary } from "./api.ts";
import { api, useAction } from "./api.ts";
import styles from "./panel.module.css";

export function Agenda({
  team,
  onChanged,
}: {
  readonly team: TeamSummary;
  readonly onChanged: () => void;
}): JSX.Element | null {
  const { error, run } = useAction(onChanged);

  // An agenda that was confirmed and did not finish. Offered, never resumed
  // on its own: a restart is exactly when nobody is watching.
  if (team.progress === undefined && team.unfinished !== undefined) {
    const { phases, done } = team.unfinished;
    const next = phases[done.length];
    return (
      <div className={styles.section}>
        <div className={styles.subhead}>有一份议程没跑完</div>
        <div className={styles.muted}>
          已完成 {done.length} / {phases.length} 个阶段
          {next === undefined ? "" : ` · 下一个是「${next}」`}
        </div>
        <div className={styles.row}>
          <button
            type="button"
            className={styles.button}
            disabled={team.busy}
            onClick={() => void run(() => api.resumeAgenda({ teamId: team.teamId }))}
          >
            从「{next ?? "下一阶段"}」继续
          </button>
          <span className={styles.hint}>已经跑完的阶段不会重跑。</span>
        </div>
        {error === undefined ? null : <div className={styles.error}>{error}</div>}
      </div>
    );
  }

  if (team.progress === undefined) return null;

  const { phase, phaseIndex, phaseCount, completedPhases } = team.progress;
  return (
    <div className={styles.section}>
      <div className={styles.subhead}>议程进行中</div>
      <div className={styles.muted}>
        第 {phaseIndex} / {phaseCount} 阶段：{phase} · 已完成 {completedPhases} 个
      </div>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.button}
          onClick={() => void run(() => api.stop({ teamId: team.teamId, reason: "主持人在面板上结束了议程。" }))}
        >
          结束议程
        </button>
        <span className={styles.hint}>结束会让秘书写一份中止交接，团队保留。</span>
      </div>
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
    </div>
  );
}
