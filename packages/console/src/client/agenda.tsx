/**
 * agenda.tsx — the secretary drafts, the host decides, the table executes.
 *
 * The three-step shape is the product's central rule made visible, not a
 * workflow nicety: a model may PROPOSE a plan and may never start one. The
 * draft sits here until a person confirms it, which is what makes a wrong
 * agenda cost a click instead of a meeting.
 *
 * The service layer for all of this has existed since stage 3 — drafting,
 * roster checking, phase execution, termination — with no surface at all. So
 * this is the last of it becoming reachable.
 */
import { useState } from "react";
import type { AgendaSpec } from "@squad/shared";
import { api, useAction, type TeamSummary } from "./api.ts";
import styles from "./panel.module.css";

/** One phase, as a person reads it. */
function Phase({ phase, index }: { readonly phase: AgendaSpec["phases"][number]; readonly index: number }) {
  return (
    <div className={styles.card}>
      <div className={styles.row}>
        <span className={styles.teamName}>
          {index + 1}. {phase.title}
        </span>
        <span className={styles.muted}>
          {phase.contextMode === "cumulative" ? "累积上下文" : "独立上下文"}
          {phase.exit === undefined ? "" : ` · ${phase.exit}`}
          {phase.maxRounds === undefined ? "" : ` · 最多 ${phase.maxRounds} 轮`}
        </span>
      </div>
      {phase.purpose === undefined ? null : <div className={styles.muted}>{phase.purpose}</div>}
      {phase.tasks.map((task, taskIndex) => (
        <div key={`${task.seatId}-${taskIndex}`} className={styles.said}>
          <div className={styles.saidWho}>{task.seatId}</div>
          <div className={styles.saidText}>{task.instruction}</div>
          {/* The path the PROGRAM will write, shown because it is a promise
              the run keeps rather than an instruction an agent might follow. */}
          {task.artifactPath === undefined ? null : <div className={styles.hint}>写入文件：{task.artifactPath}</div>}
        </div>
      ))}
    </div>
  );
}

export function Agenda({
  team,
  onChanged,
}: {
  readonly team: TeamSummary;
  readonly onChanged: () => void;
}): JSX.Element {
  const [command, setCommand] = useState("");
  const [drafting, setDrafting] = useState(false);
  const { error, setError, run } = useAction(onChanged);

  const secretary = team.seats.find((seat) => seat.isSecretary);

  // Running: progress, and the only control that matters is stopping it.
  if (team.progress !== undefined) {
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

  // Waiting on the host. This is the decision the product exists to keep.
  if (team.draft !== undefined) {
    return (
      <div className={styles.section}>
        <div className={styles.subhead}>秘书的议程草案 · 等你确认</div>
        {team.draft.hostGoal === undefined ? null : <div className={styles.muted}>{team.draft.hostGoal}</div>}
        {team.draft.phases.map((phase, index) => (
          <Phase key={`${phase.title}-${index}`} phase={phase} index={index} />
        ))}
        <div className={styles.row}>
          <button
            type="button"
            className={styles.button}
            onClick={() => void run(() => api.resolveAgenda({ teamId: team.teamId, verdict: "confirm" }))}
          >
            确认并执行
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => void run(() => api.resolveAgenda({ teamId: team.teamId, verdict: "discard" }))}
          >
            丢弃草案
          </button>
          {/* Said plainly: nothing has run yet. A draft that looked like it
              might already be executing would make the confirm button a
              formality instead of a decision. */}
          <span className={styles.hint}>还没有任何人开始执行。确认之后才会跑。</span>
        </div>
        {error === undefined ? null : <div className={styles.error}>{error}</div>}
      </div>
    );
  }

  return (
    <div className={styles.section}>
      <div className={styles.subhead}>议程</div>
      {secretary === undefined ? (
        <div className={styles.hint}>这支团队没有秘书，排不了议程——只有秘书能拟草案。</div>
      ) : (
        <div>
          <div className={styles.row}>
            <input
              className={styles.field}
              value={command}
              placeholder="要团队做什么？秘书会拆成阶段，交给你确认"
              disabled={drafting}
              onChange={(event) => setCommand(event.target.value)}
            />
            <button
              type="button"
              className={styles.button}
              disabled={drafting || command.trim() === ""}
              onClick={() => {
                setDrafting(true);
                setError(undefined);
                void api
                  .draftAgenda({ teamId: team.teamId, command })
                  .then(() => {
                    setCommand("");
                    onChanged();
                  })
                  .catch((failure: Error) => setError(String(failure.message)))
                  .finally(() => setDrafting(false));
              }}
            >
              {drafting ? "秘书在拟…" : "让秘书拟议程"}
            </button>
          </div>
          <div className={styles.hint}>
            秘书（{secretary.displayName}）只拟不跑。指令里不要用 @ 引用私有材料——秘书看不到，会被拒。
          </div>
        </div>
      )}
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
    </div>
  );
}
