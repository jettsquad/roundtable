/**
 * plan-card.tsx — the secretary's team plan, and the button that builds it.
 *
 * 「秘书最后生成的东西怎么用？」 had one answer and it was a slash command
 * typed in another session. That is not an answer: the plan is the whole
 * point of the designer team, and the act it exists for — turn this into
 * real agents and a real roster — was invisible from the place the plan
 * appears.
 *
 * Rendered under the reply it came from, for the same reason the agenda draft
 * is: a roster read apart from the discussion that produced it is a roster
 * nobody can judge. The offer only appears on replies the SERVER has already
 * parsed and checked, so pressing it cannot fail for a reason that was
 * knowable beforehand.
 *
 * What it does NOT do is edit the plan. The agents it writes are ordinary
 * library entries and every one of them is editable afterwards in Agent 库 —
 * so the honest shape today is 「建出来，再改」 rather than a form that
 * pretends to be a full editor and silently drops the fields it has no input
 * for.
 */
import { useEffect, useState } from "react";
import type { TeamPlan } from "@squad/shared";
import { api, type TeamSummary } from "./api.ts";
import { FolderField } from "./folder-picker.tsx";
import styles from "./panel.module.css";

/**
 * turnId → the plan it carries, fetched once.
 *
 * Module-level because the panel polls every two seconds: a fetch keyed to
 * the component would re-run on every snapshot and a plan that never changes
 * would be requested for as long as it stays on screen.
 */
const parsed = new Map<string, TeamPlan>();
const asking = new Map<string, Promise<unknown>>();

function usePlan(teamId: string, turnId: string): TeamPlan | undefined {
  const [plan, setPlan] = useState<TeamPlan | undefined>(() => parsed.get(turnId));
  useEffect(() => {
    if (parsed.has(turnId)) {
      setPlan(parsed.get(turnId));
      return;
    }
    const running =
      asking.get(turnId) ??
      api.previewTeamPlan({ teamId, turnId }).then((answer) => {
        parsed.set(turnId, answer);
        return answer;
      });
    asking.set(turnId, running);
    let live = true;
    void running
      .then(() => {
        if (live) setPlan(parsed.get(turnId));
      })
      .catch(() => undefined)
      .finally(() => asking.delete(turnId));
    return () => {
      live = false;
    };
  }, [teamId, turnId]);
  return plan;
}

/**
 * The plan as something a person reads.
 *
 * It arrives as raw JSON in the discussion, because that is what the phase
 * asked the secretary for — and JSON is what the build button needs. But the
 * discussion is where a PERSON decides whether this roster is the one they
 * want, and a wall of escaped braces is unreadable at exactly the moment
 * reading matters most. So the message body is rendered, and the bytes stay
 * one click away for anyone who wants to check what will actually be built.
 */
export function PlanMessage({
  team,
  turnId,
  raw,
}: {
  readonly team: TeamSummary;
  readonly turnId: string;
  readonly raw: string;
}): JSX.Element {
  const plan = usePlan(team.teamId, turnId);
  if (plan === undefined) return <pre className={styles.planRaw}>{raw}</pre>;
  return (
    <div>
      <div className={styles.subhead}>{plan.teamName}</div>
      <div>{plan.goal}</div>
      <div className={styles.subhead}>成员（{plan.seats.length}）</div>
      <ul className={styles.planList}>
        {plan.seats.map((seat) => (
          <li key={seat.key}>
            <strong>{seat.displayName}</strong> · {seat.role}
            {seat.key === plan.secretaryKey ? " ★ 秘书" : ""}
            <div className={styles.hint}>{seat.rationale}</div>
            <details>
              <summary className={styles.sectionToggle}>它的提示词</summary>
              <pre className={styles.planRaw}>{seat.systemPrompt}</pre>
            </details>
          </li>
        ))}
      </ul>
      {plan.constraints.length === 0 ? null : (
        <>
          <div className={styles.subhead}>约束</div>
          <ul className={styles.planList}>
            {plan.constraints.map((one) => (
              <li key={one}>{one}</li>
            ))}
          </ul>
        </>
      )}
      {plan.risks.length === 0 ? null : (
        <>
          <div className={styles.subhead}>红队留下的风险（{plan.risks.length}）</div>
          <ul className={styles.planList}>
            {plan.risks.map((one) => (
              <li key={one}>{one}</li>
            ))}
          </ul>
        </>
      )}
      <details>
        <summary className={styles.sectionToggle}>原始 JSON（建团用的就是这一份）</summary>
        <pre className={styles.planRaw}>{raw}</pre>
      </details>
    </div>
  );
}

export function PlanCard({
  team,
  turnId,
  pickerKind,
}: {
  readonly team: TeamSummary;
  readonly turnId: string;
  readonly pickerKind: "native" | "browse" | "none";
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const plan = usePlan(team.teamId, turnId);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [built, setBuilt] = useState<{ teamId: string; templateIds: readonly string[] } | undefined>(undefined);

  if (built !== undefined) {
    return (
      <div className={styles.calloutSection}>
        <div className={styles.subhead}>已经按这份方案建好了</div>
        <div className={styles.muted}>
          新团队 {built.teamId} · Agent 库新增 {built.templateIds.length} 个
        </div>
        <div className={styles.hint}>
          首场议程在新团队那边等你确认。每个 agent 的提示词都可以在「Agent 库」里改——改动只影响之后新建的团队。
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <div className={styles.row}>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            setOpen(true);
            setError(undefined);
          }}
        >
          按这份方案建团
        </button>
        <span className={styles.hint}>会在 Agent 库里建出这些成员，再用它们组一支新团队。</span>
      </div>
    );
  }

  return (
    <div className={styles.calloutSection}>
      <div className={styles.subhead}>{plan === undefined ? "读取方案中…" : `建「${plan.teamName}」`}</div>
      {plan === undefined ? null : (
        <>
          {/* The roster is NOT repeated here — it is the message directly
              above, rendered. A card that restates what you just read is a
              second copy to keep in sync and a screenful to scroll past. */}
          <div className={styles.muted}>
            {plan.seats.length} 个席位 · 秘书是
            {plan.seats.find((seat) => seat.key === plan.secretaryKey)?.displayName ?? plan.secretaryKey}
          </div>
          {/* An EMPTY folder, deliberately: a team's folder is its workspace,
              and two teams sharing one leaves a new session in it unable to
              say which team it belongs to. The server refuses an occupied
              folder by name, so a wrong guess here is caught rather than
              silently accepted — but it should not be guessed for you. */}
          <div className={styles.subhead}>新团队的项目文件夹</div>
          <FolderField value={folder} onChange={setFolder} kind={pickerKind} invalid={folder.trim() === ""} />
          <div className={styles.hint}>要一个还没有团队住在里面的空文件夹——它会成为这支团队在侧边栏里的家。</div>
        </>
      )}
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
      <div className={styles.row}>
        <button
          type="button"
          className={styles.button}
          disabled={busy || plan === undefined || folder.trim() === ""}
          onClick={() => {
            setBusy(true);
            setError(undefined);
            void api
              .buildTeamPlan({ teamId: team.teamId, turnId, projectFolder: folder.trim() })
              .then(setBuilt)
              .catch((problem: Error) => setError(problem.message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "建团中…" : "确认，建这支团队"}
        </button>
        <button type="button" className={styles.button} disabled={busy} onClick={() => setOpen(false)}>
          先不建
        </button>
      </div>
    </div>
  );
}

/**
 * Ask for the plan again, saying what was wrong with the last one.
 *
 * The correction loop, and it has to be a control rather than a sentence
 * typed at the secretary: that seat is under standing orders never to invent
 * the schema, so 「重出一份」 in the discussion is refused for want of a
 * shape. This carries the shape.
 *
 * Placed at the end of the thread, where you are once you have finished
 * reading the plan you did not like. The note is optional — 「按讨论重出」 is
 * a real request when the discussion already says what changed.
 */
export function RedraftPlan({ team, onChanged }: { readonly team: TeamSummary; readonly onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  if (team.designer !== true || team.progress !== undefined) return null;

  if (!open) {
    return (
      <div className={styles.row}>
        <button type="button" className={styles.button} onClick={() => setOpen(true)}>
          方案不对，让秘书重出一份
        </button>
        <span className={styles.hint}>先在下面的输入框里跟成员说清哪里不对，再点这里收口。</span>
      </div>
    );
  }

  return (
    <div className={styles.calloutSection}>
      <div className={styles.subhead}>让组队秘书重出一份方案</div>
      <div className={styles.hint}>
        它会读上面的整段讨论。这里写的是<strong>本次要改的重点</strong>，没点到的部分它会原样保留——
        留空也行，那就按讨论里已经达成的结论重出。
      </div>
      <textarea
        className={styles.textarea}
        rows={3}
        value={note}
        placeholder="例如：我要的是团队主笔，成品由席位产出，我只做判断和拍板；现在这版还是我写、他们改。"
        onChange={(event) => setNote(event.target.value)}
      />
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
      <div className={styles.row}>
        <button
          type="button"
          className={styles.button}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(undefined);
            void api
              .redraftTeamPlan({ teamId: team.teamId, note })
              .then(() => {
                setOpen(false);
                setNote("");
                onChanged();
              })
              .catch((problem: Error) => setError(problem.message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "已经交给秘书…" : "重出一份"}
        </button>
        <button type="button" className={styles.button} disabled={busy} onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
    </div>
  );
}

/**
 * A plan that was refused, and the way to get another one.
 *
 * The refusal is shown in full. It is written to be acted on — 「点名了不存在
 * 的席位 key『kickoff-brief』」 says exactly what the secretary got wrong —
 * and hiding it behind 「方案有问题」 would throw away the only part that
 * tells anyone what to do next.
 */
export function PlanRefused({
  team,
  detail,
  onChanged,
}: {
  readonly team: TeamSummary;
  readonly detail: string;
  readonly onChanged: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <div className={styles.calloutSection}>
      <div className={styles.subhead}>这份方案还不能落地，所以没有建团按钮</div>
      <pre className={styles.planRaw}>{detail}</pre>
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
      <div className={styles.row}>
        <button
          type="button"
          className={styles.button}
          disabled={busy || sent}
          onClick={() => {
            setBusy(true);
            setError(undefined);
            void api
              .redraftTeamPlan({ teamId: team.teamId, note: `上一版被拒收，原因如下，请照着改：\n${detail}` })
              .then(() => {
                setSent(true);
                onChanged();
              })
              .catch((problem: Error) => setError(problem.message))
              .finally(() => setBusy(false));
          }}
        >
          {sent ? "已交给秘书重出" : busy ? "发送中…" : "把这些问题发回给秘书，重出一份"}
        </button>
        <span className={styles.hint}>它会读上面的讨论，只改这里点到的地方。</span>
      </div>
    </div>
  );
}
