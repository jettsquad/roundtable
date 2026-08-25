/**
 * draft-card.tsx — the secretary's plan, where the secretary said it.
 *
 * It used to be a block at the top of the team tab, a thousand pixels above
 * the message it came from. A plan read apart from the reasoning behind it is
 * a plan nobody can judge, which is what 「放到最上面怎么看」 means.
 *
 * And it is EDITABLE, which is what 1.x did and what a single yes/no cannot
 * do: a secretary that got three phases right and one wrong forced the host
 * to throw all four away, retype the instruction and hope. What confirmation
 * is FOR is fixing the part that is wrong — the title, who does a task, what
 * the task actually says, whether the phase repeats. A rubber stamp with two
 * buttons is not that.
 *
 * The edited agenda is what gets sent, and the server re-checks it against
 * the real roster before running a word of it — an edit that names a seat
 * that does not exist is refused the same way a hallucinated one is.
 */
import { useState } from "react";
import type { AgendaSpec } from "@squad/shared";
import { api, type TeamSummary } from "./api.ts";
import styles from "./panel.module.css";

/** Where the draft is drawn, so the composer can point at it. */
export const DRAFT_ANCHOR = "squad-agenda-draft";

/** One phase, edited in place. */
function Phase({
  phase,
  index,
  seats,
  onChange,
  onRemove,
}: {
  readonly phase: AgendaSpec["phases"][number];
  readonly index: number;
  readonly seats: TeamSummary["seats"];
  readonly onChange: (next: AgendaSpec["phases"][number]) => void;
  readonly onRemove: () => void;
}): JSX.Element {
  const tasks = phase.tasks;
  const setTask = (at: number, next: Partial<AgendaSpec["phases"][number]["tasks"][number]>): void =>
    onChange({ ...phase, tasks: tasks.map((task, index) => (index === at ? { ...task, ...next } : task)) });

  return (
    <div className={styles.card}>
      <div className={styles.row}>
        <span className={styles.muted}>阶段 {index + 1}</span>
        <input
          className={styles.grow ?? ""}
          value={phase.title}
          aria-label={`阶段 ${index + 1} 标题`}
          onChange={(event) => onChange({ ...phase, title: event.target.value })}
        />
        <button type="button" className={styles.drop} title="删掉这个阶段" onClick={onRemove}>
          删除阶段
        </button>
      </div>
      <div className={styles.row}>
        <label className={styles.muted}>
          讨论方式{" "}
          <select
            value={phase.contextMode}
            onChange={(event) =>
              onChange({ ...phase, contextMode: event.target.value as AgendaSpec["phases"][number]["contextMode"] })
            }
          >
            <option value="cumulative">累计讨论</option>
            <option value="independent">独立讨论</option>
          </select>
        </label>
        <label className={styles.muted}>
          结束条件{" "}
          <select
            value={phase.exit ?? "after-tasks"}
            onChange={(event) => {
              const exit = event.target.value as NonNullable<AgendaSpec["phases"][number]["exit"]>;
              // `maxRounds` only means something for the bounded exit, and the
              // roster check refuses the two apart — so they move together
              // rather than leaving a combination the host cannot confirm.
              onChange({
                ...phase,
                exit,
                ...(exit === "after-bounded-rounds" ? { maxRounds: phase.maxRounds ?? 2 } : { maxRounds: undefined }),
              });
            }}
          >
            <option value="after-tasks">跑完任务就结束</option>
            <option value="after-bounded-rounds">循环固定轮次</option>
            <option value="wait-for-host">停下来等我</option>
          </select>
        </label>
        {phase.exit !== "after-bounded-rounds" ? null : (
          <label className={styles.muted}>
            轮次{" "}
            <input
              type="number"
              min={1}
              max={20}
              className={styles.numberField ?? ""}
              value={phase.maxRounds ?? 2}
              onChange={(event) => onChange({ ...phase, maxRounds: Math.max(1, Number(event.target.value) || 1) })}
            />
          </label>
        )}
      </div>
      {tasks.map((task, at) => (
        <div key={`${task.seatId}-${at}`} className={styles.said}>
          <div className={styles.row}>
            <select value={task.seatId} onChange={(event) => setTask(at, { seatId: event.target.value })}>
              {seats.map((seat) => (
                <option key={seat.seatId} value={seat.seatId}>
                  {seat.displayName}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={styles.drop}
              title="删掉这条任务"
              onClick={() => onChange({ ...phase, tasks: tasks.filter((_, index) => index !== at) })}
            >
              删除
            </button>
          </div>
          <textarea
            className={styles.taskText ?? ""}
            value={task.instruction}
            aria-label={`阶段 ${index + 1} 任务 ${at + 1} 指令`}
            onChange={(event) => setTask(at, { instruction: event.target.value })}
          />
          {task.artifactPath === undefined ? null : <div className={styles.hint}>写入文件：{task.artifactPath}</div>}
        </div>
      ))}
      <div className={styles.row}>
        <button
          type="button"
          className={styles.quoteChip}
          onClick={() =>
            onChange({
              ...phase,
              tasks: [...tasks, { seatId: seats[0]?.seatId ?? "", instruction: "" }],
            })
          }
        >
          ＋加一条任务
        </button>
      </div>
    </div>
  );
}

export function DraftCard({
  team,
  onChanged,
}: {
  readonly team: TeamSummary;
  readonly onChanged: () => void;
}): JSX.Element | null {
  // Seeded from the draft and edited locally. The server keeps holding the
  // ORIGINAL until the host confirms, so closing the tab mid-edit loses the
  // edits and not the draft.
  const [edited, setEdited] = useState<AgendaSpec | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const draft = edited ?? team.draft;
  if (team.draft === undefined || draft === undefined) return null;

  const change = (next: AgendaSpec): void => setEdited(next);
  const setPhase = (at: number, next: AgendaSpec["phases"][number]): void =>
    change({ ...draft, phases: draft.phases.map((phase, index) => (index === at ? next : phase)) });

  const resolve = (verdict: "confirm" | "discard"): void => {
    setBusy(true);
    setError(undefined);
    void api
      .resolveAgenda({
        teamId: team.teamId,
        verdict,
        // What this panel was showing. If the secretary re-drafted while it
        // sat here, the confirmation is refused rather than quietly running
        // a plan nobody read.
        ...(team.draftAgendaId === undefined ? {} : { agendaId: team.draftAgendaId }),
        ...(team.draftRevision === undefined ? {} : { revision: team.draftRevision }),
        // The edited agenda travels only when it differs, so an untouched
        // draft is confirmed exactly as the secretary wrote it.
        ...(verdict === "confirm" && edited !== undefined ? { agenda: edited } : {}),
      })
      .then(onChanged)
      .catch((failure: Error) => setError(String(failure.message)))
      .finally(() => setBusy(false));
  };

  const empty = draft.phases.length === 0 || draft.phases.some((phase) => phase.tasks.length === 0);

  return (
    <div className={styles.draftCard} id={DRAFT_ANCHOR}>
      <div className={styles.row}>
        <span className={styles.subhead}>秘书的议程草案 · 可以改，改完再确认</span>
        <span className={styles.muted}>
          {team.draftedAt === undefined ? "" : new Date(team.draftedAt).toLocaleString()}
        </span>
        {edited === undefined ? null : (
          <button type="button" className={styles.quoteChip} onClick={() => setEdited(undefined)}>
            还原成秘书写的
          </button>
        )}
      </div>
      {draft.hostGoal === undefined ? null : <div className={styles.muted}>{draft.hostGoal}</div>}
      {draft.phases.map((phase, index) => (
        <Phase
          key={index}
          phase={phase}
          index={index}
          seats={team.seats}
          onChange={(next) => setPhase(index, next)}
          onRemove={() => change({ ...draft, phases: draft.phases.filter((_, at) => at !== index) })}
        />
      ))}
      <div className={styles.row}>
        <button type="button" className={styles.button} disabled={busy || empty} onClick={() => resolve("confirm")}>
          {edited === undefined ? "执行这份议程" : "按我改过的执行"}
        </button>
        <button type="button" className={styles.drop} disabled={busy} onClick={() => resolve("discard")}>
          丢弃
        </button>
        <span className={styles.hint}>
          {empty ? "有阶段一条任务都没有，先补上或者删掉这个阶段。" : "确认之后才会跑。"}
        </span>
      </div>
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
    </div>
  );
}
