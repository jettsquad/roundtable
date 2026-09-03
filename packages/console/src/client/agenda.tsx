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
    const { phases, done, awaitingHost, awaitingFrom } = team.unfinished;
    const next = phases[done.length];
    const stoppedAt = done[done.length - 1];
    const finished = done.length >= phases.length;
    return (
      <div className={`${styles.section} ${awaitingHost ? styles.calloutSection : ""}`}>
        {/* Two different situations wore one label. 「跑了一半断了」 asks
            whether to carry on; 「在等你回答」 says a seat put a question to
            you and the agenda stopped for it. Only the second is about
            something YOU owe — and a button reading 「继续」 beside an
            unanswered question is an invitation to skip it. */}
        <div className={styles.subhead}>
          {awaitingHost ? "议程停下来等你回答" : finished ? "议程已经跑完" : "有一份议程没跑完"}
        </div>
        <div className={styles.muted}>
          {awaitingHost && stoppedAt !== undefined ? `「${stoppedAt}」问完了，在等你的回答 · ` : ""}
          已完成 {done.length} / {phases.length} 个阶段
          {next === undefined ? "" : ` · 下一个是「${next}」`}
          {` · 确认指纹 ${team.unfinished.hash}`}
        </div>
        {!awaitingHost ? null : (
          <div className={styles.hint}>
            在下面的输入框里回答，
            <strong>开头一定要点名 {awaitingFrom.map((name) => `@${name}`).join(" ")}</strong>
            ——不点名就是对全体发言，还没轮到的席位会各自开工，把讨论搅乱。
            <br />
            答完再点继续；现在点，后面每一个阶段都建立在没有答案的猜测上。
          </div>
        )}
        {/* Execution reads the CURRENT roster, on purpose — a member added
            mid-agenda should be usable. This is what stops that being
            invisible: the plan was approved for a different table. */}
        {team.unfinished.rosterDrift.length === 0 ? null : (
          <div className={styles.error}>
            名册和你确认时不一样了：{team.unfinished.rosterDrift.join("、")}。续跑会按现在的名册来。
          </div>
        )}
        <div className={styles.row} style={finished ? { display: "none" } : undefined}>
          <button
            type="button"
            className={styles.button}
            disabled={team.busy}
            onClick={() => void run(() => api.resumeAgenda({ teamId: team.teamId }))}
          >
            {awaitingHost ? "我答完了，继续" : `从「${next ?? "下一阶段"}」继续`}
          </button>
          <span className={styles.hint}>
            {awaitingHost ? "不回答直接点也行——那等于让它按自己的假设往下走。" : "已经跑完的阶段不会重跑。"}
          </span>
        </div>
        {/* Every phase, with the way back to it.
            A linear plan cannot be flexible on its own, and the problem you
            find in phase five was usually MADE in phase two — so without
            this the only repair is confirming the whole plan again and
            re-running everything to fix one thing. */}
        <details className={styles.section}>
          <summary className={styles.sectionToggle}>阶段（{phases.length}）· 可以退回到其中任意一个重跑</summary>
          <ol className={styles.planList}>
            {phases.map((title, index) => (
              <li key={title}>
                {title}
                {index < done.length ? " ✓" : ""}
                {index === done.length && !finished ? " ← 下一个" : ""}
                {index >= done.length ? null : (
                  <button
                    type="button"
                    className={styles.quoteButton}
                    disabled={team.busy}
                    title="把议程退回到这一阶段之前。之前说过的话都留着，重跑的席位看得见。"
                    onClick={() => void run(() => api.rewindAgenda({ teamId: team.teamId, phaseIndex: index }))}
                  >
                    从这里重来
                  </button>
                )}
              </li>
            ))}
          </ol>
          <div className={styles.hint}>
            退回只改计划，<strong>不删讨论</strong>——重跑这一阶段的席位看得见之前那一版和你反对它的理由，
            否则第二遍只会和第一遍一样。退回之后不会自己开跑，还要你点一次继续。
          </div>
        </details>
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
