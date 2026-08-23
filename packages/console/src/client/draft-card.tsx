/**
 * draft-card.tsx — the secretary's plan, where the secretary said it.
 *
 * It used to be a block at the top of the team tab, a thousand pixels above
 * the message it came from. A plan read apart from the reasoning behind it is
 * a plan nobody can judge, which is what 「放到最上面怎么看」 means.
 *
 * Phases are chosen ONE BY ONE. All-or-nothing was the wrong shape and for a
 * specific reason: a secretary that got three phases right and one wrong
 * forced the host to throw away the three, retype the instruction, and hope.
 * What confirmation is FOR is deciding which parts are right — a single
 * yes/no is a rubber stamp with extra steps.
 */
import { useState } from "react";
import type { AgendaSpec } from "@squad/shared";
import { api, type TeamSummary } from "./api.ts";
import styles from "./panel.module.css";

/** Where the draft is drawn, so the composer can point at it. */
export const DRAFT_ANCHOR = "squad-agenda-draft";

/** One phase, as a person reads it before saying yes to it. */
function Phase({
  phase,
  index,
  nameOf,
  chosen,
  toggle,
}: {
  readonly phase: AgendaSpec["phases"][number];
  readonly index: number;
  readonly nameOf: (seatId: string) => string;
  readonly chosen: boolean;
  readonly toggle: () => void;
}): JSX.Element {
  return (
    <div className={`${styles.card} ${chosen ? "" : styles.phaseOff}`}>
      <label className={styles.row}>
        <input type="checkbox" checked={chosen} onChange={toggle} />
        <span className={styles.teamName}>
          {index + 1}. {phase.title}
        </span>
        <span className={styles.muted}>
          {phase.contextMode === "cumulative" ? "累积上下文" : "独立上下文"}
          {phase.exit === undefined ? "" : ` · ${phase.exit}`}
          {phase.maxRounds === undefined ? "" : ` · 最多 ${phase.maxRounds} 轮`}
        </span>
      </label>
      {phase.purpose === undefined ? null : <div className={styles.muted}>{phase.purpose}</div>}
      {phase.tasks.map((task, taskIndex) => (
        <div key={`${task.seatId}-${taskIndex}`} className={styles.said}>
          {/* The person's name, not the seat id. 「seat-2」 is ours; it means
              nothing to whoever has to decide whether this is right. */}
          <div className={styles.saidWho}>{nameOf(task.seatId)}</div>
          <div className={styles.saidText}>{task.instruction}</div>
          {task.artifactPath === undefined ? null : <div className={styles.hint}>写入文件：{task.artifactPath}</div>}
        </div>
      ))}
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
  const draft = team.draft;
  // Indices rather than titles: two phases may share a title, and the choice
  // has to survive that.
  const [dropped, setDropped] = useState<readonly number[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  if (draft === undefined) return null;

  const nameOf = (seatId: string): string => team.seats.find((seat) => seat.seatId === seatId)?.displayName ?? seatId;
  const kept = draft.phases.filter((_, index) => !dropped.includes(index));

  const resolve = (verdict: "confirm" | "discard"): void => {
    setBusy(true);
    setError(undefined);
    void api
      .resolveAgenda({
        teamId: team.teamId,
        verdict,
        // Only the chosen phases travel. The server re-checks whatever it is
        // given against the real roster, so an edited agenda is validated the
        // same way the original was.
        ...(verdict === "confirm" && kept.length !== draft.phases.length ? { agenda: { ...draft, phases: kept } } : {}),
      })
      .then(onChanged)
      .catch((failure: Error) => setError(String(failure.message)))
      .finally(() => setBusy(false));
  };

  return (
    <div className={styles.draftCard} id={DRAFT_ANCHOR}>
      <div className={styles.row}>
        <span className={styles.subhead}>秘书的议程草案 · 等你确认</span>
        <span className={styles.muted}>
          {team.draftedAt === undefined ? "" : new Date(team.draftedAt).toLocaleString()}
        </span>
      </div>
      {draft.hostGoal === undefined ? null : <div className={styles.muted}>{draft.hostGoal}</div>}
      {draft.phases.map((phase, index) => (
        <Phase
          key={`${phase.title}-${index}`}
          phase={phase}
          index={index}
          nameOf={nameOf}
          chosen={!dropped.includes(index)}
          toggle={() =>
            setDropped((current) =>
              current.includes(index) ? current.filter((one) => one !== index) : [...current, index],
            )
          }
        />
      ))}
      <div className={styles.row}>
        <button
          type="button"
          className={styles.button}
          disabled={busy || kept.length === 0}
          onClick={() => resolve("confirm")}
        >
          {kept.length === draft.phases.length ? "执行这份议程" : `只执行选中的 ${kept.length} 个阶段`}
        </button>
        <button type="button" className={styles.drop} disabled={busy} onClick={() => resolve("discard")}>
          丢弃
        </button>
        {/* Said plainly: nothing has run yet. A draft that looked like it might
            already be executing would make the button a formality. */}
        <span className={styles.hint}>{kept.length === 0 ? "一个阶段都没选，那就等于丢弃。" : "确认之后才会跑。"}</span>
      </div>
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
    </div>
  );
}
