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
import { MarkdownText } from "@deepseek-ai/dsh-client-ui-primitives";
import { api, useAction, type TeamSummary } from "./api.ts";
import styles from "./panel.module.css";

/**
 * Where the draft is drawn.
 *
 * The composer needs to point at it: a draft made by pressing 「转成议程」
 * down in the discussion appeared over a thousand pixels above, out of view,
 * and from the host's side simply did not happen. One anchor, one rendering
 * — the alternative is drawing the draft twice, which is the mistake this
 * project already made with the transcript.
 */
export const AGENDA_DRAFT_ANCHOR = "squad-agenda-draft";

/** One phase, as a person reads it. */
function Phase({
  phase,
  index,
  nameOf,
}: {
  readonly phase: AgendaSpec["phases"][number];
  readonly index: number;
  /** seatId → the name that seat goes by. */
  readonly nameOf: (seatId: string) => string;
}) {
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
          {/* The person's name, not the seat id. 「seat-2」 is ours; it means
              nothing to whoever has to decide whether this agenda is right. */}
          <div className={styles.saidWho}>{nameOf(task.seatId)}</div>
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
  const nameOf = (seatId: string): string => team.seats.find((seat) => seat.seatId === seatId)?.displayName ?? seatId;

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
      <div className={styles.section} id={AGENDA_DRAFT_ANCHOR}>
        <div className={styles.subhead}>
          秘书的议程草案 · 等你确认
          {team.draftedAt === undefined ? "" : ` · ${new Date(team.draftedAt).toLocaleString()} 拟`}
        </div>
        {/* Said when it is old. A draft is a proposal about what to do next,
            and one written before a dozen more turns of discussion may be
            answering a question the team has since moved past. Shown rather
            than discarded on the host's behalf — whether it is still right is
            exactly the judgement this confirmation exists to keep. */}
        {team.draftedAt === undefined || Date.now() - team.draftedAt < 30 * 60_000 ? null : (
          <div className={styles.hint}>这份草案是较早拟的，讨论可能已经往前走了——确认前扫一眼是不是还对得上。</div>
        )}
        {team.draft.hostGoal === undefined ? null : <div className={styles.muted}>{team.draft.hostGoal}</div>}
        {team.draft.phases.map((phase, index) => (
          <Phase key={`${phase.title}-${index}`} phase={phase} index={index} nameOf={nameOf} />
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

      <SecretaryDesk team={team} />
    </div>
  );
}

/**
 * The secretary doing a job for the host.
 *
 * 1.x had this and 2.0 did not, which is most of what 「秘书没有协调、组织
 * 其它 agent 的能力」 names: the only thing you could ask a secretary for was
 * an agenda. Everything else it is for — 总结到这里的讨论、把分歧列出来、
 * 谁还欠什么、按这些结论重排分工 — had nowhere to go.
 *
 * The answer lands HERE and not in the discussion, on purpose. A summary
 * written by the secretary and a claim made by a member are different kinds
 * of thing; recording them the same way would make the next round inherit the
 * summary as something the team said.
 */
function SecretaryDesk({ team }: { readonly team: TeamSummary }): JSX.Element | null {
  const [instruction, setInstruction] = useState("");
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const secretary = team.seats.find((seat) => seat.isSecretary);
  if (secretary === undefined) return null;

  const ask = (text: string): void => {
    setRunning(true);
    setFailure(undefined);
    setAnswer(undefined);
    void api
      .assist({ teamId: team.teamId, instruction: text })
      .then((result) => setAnswer(result.text))
      .catch((error: Error) => setFailure(String(error.message)))
      .finally(() => setRunning(false));
  };

  return (
    <div className={styles.section}>
      <div className={styles.subhead}>秘书台</div>
      <div className={styles.row}>
        <input
          className={styles.field}
          value={instruction}
          placeholder="让秘书做一件事：总结、列分歧、点出谁还欠什么…"
          disabled={running}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !running && instruction.trim() !== "") ask(instruction);
          }}
        />
        <button
          type="button"
          className={styles.button}
          disabled={running || instruction.trim() === ""}
          onClick={() => ask(instruction)}
        >
          {running ? "秘书在做…" : "交给秘书"}
        </button>
      </div>
      {/* The three jobs people actually want, as one click each. Typed out in
          full rather than abbreviated: what goes to the secretary is exactly
          what is written here, and a button whose real instruction is hidden
          is a button whose answer cannot be judged. */}
      <div className={styles.row}>
        {[
          "把到目前为止的讨论总结成要点，分成「已定」和「未定」两部分。",
          "把讨论里还没有解决的分歧列出来，每条注明是谁和谁的分歧。",
          "按目前的讨论，说明每位成员接下来该做什么，以及先后顺序。",
        ].map((preset) => (
          <button
            key={preset}
            type="button"
            className={styles.quoteChip}
            title={preset}
            disabled={running}
            onClick={() => ask(preset)}
          >
            {preset.slice(0, 10)}…
          </button>
        ))}
      </div>
      <div className={styles.hint}>
        秘书（{secretary.displayName}）只看公开讨论，看不到你的私有材料；答案只给你看，不进讨论记录。
      </div>
      {failure === undefined ? null : <div className={styles.error}>{failure}</div>}
      {answer === undefined ? null : (
        <div className={styles.card}>
          <MarkdownText text={answer} />
        </div>
      )}
    </div>
  );
}
