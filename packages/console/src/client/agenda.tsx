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
import { useState } from "react";
import type { TeamSummary } from "./api.ts";
import { api, useAction } from "./api.ts";
import type { AgendaNodeView } from "../wire.ts";
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
    // A server started before nodes existed sends neither field, and this
    // bundle is rebuilt under it while it runs. Read the old shape as what it
    // meant — a chain, finished up to `done` — rather than taking the whole
    // panel down on `undefined.find`.
    const nodes: readonly AgendaNodeView[] =
      team.unfinished.nodes ??
      phases.map((title, index) => ({
        id: `p${index + 1}`,
        title,
        state: index < done.length ? ("passed" as const) : ("pending" as const),
        attempts: index < done.length ? 1 : 0,
        maxAttempts: 1,
        needs: [],
        seats: [],
      }));
    const standing = team.unfinished.standing ?? (done.length >= phases.length ? "finished" : "runnable");
    const decisions = team.unfinished.decisions ?? [];
    const next = nodes.find((node) => node.state === "pending")?.title;
    const stoppedAt = done[done.length - 1];
    // Over, one way or the other: every node passed, or what is left was
    // given up on or skipped. Neither has anything to carry on with.
    const finished = standing === "finished" || standing === "ended";
    const deciding = nodes.filter((node) => node.state === "deciding");
    const dropped = nodes.filter((node) => node.state === "unresolved" || node.state === "skipped").length;
    return (
      <div className={`${styles.section} ${awaitingHost ? styles.calloutSection : ""}`}>
        {/* Two different situations wore one label. 「跑了一半断了」 asks
            whether to carry on; 「在等你回答」 says a seat put a question to
            you and the agenda stopped for it. Only the second is about
            something YOU owe — and a button reading 「继续」 beside an
            unanswered question is an invitation to skip it. */}
        <div className={styles.subhead}>
          {deciding.length > 0
            ? "议程停下来，需要你决定"
            : awaitingHost
              ? "议程停下来等你回答"
              : standing === "finished"
                ? "议程已经跑完"
                : standing === "ended"
                  ? "议程结束了，但不是全部通过"
                  : "有一份议程没跑完"}
        </div>
        <div className={styles.muted}>
          {awaitingHost && stoppedAt !== undefined ? `「${stoppedAt}」问完了，在等你的回答 · ` : ""}
          已通过 {done.length} / {phases.length} 个阶段
          {dropped === 0 ? "" : ` · 放下或跳过 ${dropped} 个`}
          {team.unfinished.proxy === true ? " · 由 Lil X 代理" : ""}
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
        {deciding.map((node) => (
          <DecisionCard key={node.id} team={team} node={node} run={run} />
        ))}
        <div className={styles.row} style={finished || deciding.length > 0 ? { display: "none" } : undefined}>
          <button
            type="button"
            className={styles.button}
            disabled={team.busy}
            onClick={() => void run(() => api.resumeAgenda({ teamId: team.teamId }))}
          >
            {awaitingHost ? "我答完了，继续" : `从「${next ?? "下一阶段"}」继续`}
          </button>
          <span className={styles.hint}>
            {awaitingHost ? "不回答直接点也行——那等于让它按自己的假设往下走。" : "已经通过的阶段不会重跑。"}
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
            {nodes.map((node, index) => (
              <li key={node.id}>
                {node.title} <span className={styles.muted}>{STATE_LABEL[node.state]}</span>
                {node.state === "pending" && node.title === next && !finished ? " ← 下一个" : ""}
                {node.state === "pending" || node.attempts === 0 ? null : (
                  <span className={styles.muted}>{` · 做了 ${node.attempts} 次`}</span>
                )}
                {node.state === "pending" && node.attempts === 0 ? null : (
                  <button
                    type="button"
                    className={styles.subtleButton}
                    disabled={team.busy}
                    title="把议程退回到这一阶段之前。之前说过的话都留着，重跑的席位看得见。"
                    onClick={() => void run(() => api.rewindAgenda({ teamId: team.teamId, phaseIndex: index }))}
                  >
                    从这里重来
                  </button>
                )}
                {node.why === undefined || node.state === "passed" ? null : (
                  <div className={styles.hint}>{node.why}</div>
                )}
                {node.check === undefined ? null : (
                  <div className={styles.hint}>
                    出口检查：<code>{node.check}</code>
                    {node.lastCheck === undefined ? "（还没跑过）" : `（上次：${checkWords(node.lastCheck)}）`}
                  </div>
                )}
              </li>
            ))}
          </ol>
          <div className={styles.hint}>
            退回只改计划，<strong>不删讨论</strong>——重跑这一阶段的席位看得见之前那一版和你反对它的理由，
            否则第二遍只会和第一遍一样。退回之后不会自己开跑，还要你点一次继续。
          </div>
        </details>
        {/* What the proxy decided while nobody was watching. On the card and
            not only in the discussion: the discussion is hours long, and
            「它替我决定了什么」 is the first thing to want on coming back. */}
        {decisions.length === 0 ? null : (
          <details className={styles.section}>
            <summary className={styles.sectionToggle}>Lil X 替你做的决定（{decisions.length}）</summary>
            <ol className={styles.planList}>
              {decisions.map((one) => (
                <li key={`${one.at}-${one.title}`}>
                  <strong>{one.title}</strong>
                  <div className={styles.hint}>问题：{one.problem}</div>
                  <div>{one.detail}</div>
                </li>
              ))}
            </ol>
          </details>
        )}
        {/* The way out. Without it a stopped agenda could only be carried on
            or wound back — the card stayed until another plan replaced it,
            which made 「这份计划不要了」 something you could not say. Kept
            apart from 「继续」 and behind a confirmation: it is the one
            action on this card that cannot be undone. */}
        <div className={styles.row}>
          <button
            type="button"
            className={styles.subtleButton}
            disabled={team.busy}
            onClick={() => {
              const asked = finished
                ? `收起这份已经${standing === "finished" ? "跑完" : "结束"}的议程？讨论记录不会动。`
                : `放弃这份议程？还有 ${phases.length - done.length} 个阶段没跑，放弃后不能再从中间继续。讨论记录不会动。`;
              if (window.confirm(asked)) void run(() => api.abandonAgenda({ teamId: team.teamId }));
            }}
          >
            {finished ? "收起这份议程" : "放弃这份议程"}
          </button>
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

const STATE_LABEL: Record<AgendaNodeView["state"], string> = {
  pending: "",
  passed: "✓ 通过",
  deciding: "⚠ 等你决定",
  unresolved: "✗ 已放下",
  skipped: "— 跳过",
};

function checkWords(check: NonNullable<AgendaNodeView["lastCheck"]>): string {
  if (check.timedOut === true) return "超时";
  if (check.exitCode === 0) return "通过";
  return check.exitCode === null ? "被中止" : `未通过，退出码 ${check.exitCode}`;
}

/**
 * A node the agenda could not get past by itself, and the four things that
 * can be done about it.
 *
 * Shows the evidence before the buttons: why it stopped, the check's own
 * output. A choice made without those is a guess, and the whole reason the
 * agenda stopped here is that guessing had stopped working.
 */
function DecisionCard({
  team,
  node,
  run,
}: {
  readonly team: TeamSummary;
  readonly node: AgendaNodeView;
  readonly run: (action: () => Promise<unknown>) => Promise<unknown>;
}): JSX.Element {
  const [instruction, setInstruction] = useState("");
  const [seatId, setSeatId] = useState(team.seats[0]?.seatId ?? "");
  const decide = (decision: Parameters<typeof api.decideNode>[0]["decision"]): void =>
    void run(() => api.decideNode({ teamId: team.teamId, nodeId: node.id, decision }));
  const said = instruction.trim();
  return (
    <div className={styles.section}>
      <div>
        <strong>「{node.title}」</strong>（{node.seats.join("、")}）
      </div>
      {node.why === undefined ? null : <div className={styles.error}>{node.why}</div>}
      {node.check === undefined ? null : (
        <div className={styles.hint}>
          出口检查：<code>{node.check}</code>
        </div>
      )}
      {node.lastCheck === undefined || node.lastCheck.tail.trim() === "" ? null : (
        <details>
          <summary className={styles.sectionToggle}>检查的输出（{checkWords(node.lastCheck)}）</summary>
          <pre className={styles.hint} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {node.lastCheck.tail}
          </pre>
        </details>
      )}
      <textarea
        className={styles.textarea}
        rows={2}
        value={instruction}
        placeholder="要交代的话（重做时可以不写；让别人清障时必须写清要他做什么）"
        onChange={(event) => setInstruction(event.target.value)}
      />
      <div className={styles.row}>
        <button
          type="button"
          className={styles.button}
          disabled={team.busy}
          onClick={() => decide({ kind: "retry", ...(said === "" ? {} : { instruction: said }) })}
        >
          重做
        </button>
        <select value={seatId} onChange={(event) => setSeatId(event.target.value)} disabled={team.busy}>
          {team.seats.map((seat) => (
            <option key={seat.seatId} value={seat.seatId}>
              {seat.displayName}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.button}
          disabled={team.busy || said === "" || seatId === ""}
          title="让这位席位先去解决障碍。他做完后，这一阶段的出口检查会再跑一遍。"
          onClick={() => decide({ kind: "assign", seatId, instruction: said })}
        >
          让他去清障
        </button>
        <button
          type="button"
          className={styles.subtleButton}
          disabled={team.busy}
          onClick={() => {
            if (window.confirm(`把「${node.title}」直接算作通过？出口检查不会再跑，后面的阶段会照常开始。`)) {
              decide({ kind: "pass" });
            }
          }}
        >
          视为通过
        </button>
        <button
          type="button"
          className={styles.subtleButton}
          disabled={team.busy}
          onClick={() => {
            if (window.confirm(`放下「${node.title}」？依赖它的阶段都会被跳过。`)) decide({ kind: "abandon" });
          }}
        >
          放下它
        </button>
      </div>
    </div>
  );
}
