/**
 * create.tsx — building a team by picking agents.
 *
 * The roster used to be typed: `甲*=架构, 乙=测试`. That is the right
 * interaction for a slash command and the wrong one here — it made a person
 * retype names that were already in the library, invent roles a second time,
 * and spell a `*` to mark a secretary the library already knew could be one.
 * Worse, a seat built that way carried no model, no permission mode and no
 * ceilings, because there was nowhere in that grammar to put them.
 *
 * Picking from the library means a seat arrives configured. The text grammar
 * stays on `/squad-new`, where typing is the point.
 */
import { useState } from "react";
import type { AgentTemplate } from "@squad/shared";
import type { PickerKind } from "./api.ts";
import { api, useAction } from "./api.ts";
import { checkTeamDraft, type DraftProblem } from "../parse.ts";
import { FolderField } from "./folder-picker.tsx";
import styles from "./panel.module.css";

interface CreateFormProps {
  readonly agents: readonly AgentTemplate[];
  readonly picker: PickerKind;
  readonly onCreated: () => void;
}

export function CreateForm({ agents, picker, onCreated }: CreateFormProps): JSX.Element {
  const [displayName, setDisplayName] = useState("");
  const [projectFolder, setProjectFolder] = useState("");
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [secretary, setSecretary] = useState<string | undefined>(undefined);
  const [problems, setProblems] = useState<readonly DraftProblem[]>([]);
  const { error, run } = useAction(onCreated);

  const complaint = (field: DraftProblem["field"]): string | undefined =>
    problems.find((problem) => problem.field === field)?.detail;

  const members = picked.map((templateId) => ({
    templateId,
    ...(templateId === secretary ? { isSecretary: true } : {}),
  }));

  const toggle = (agent: AgentTemplate): void => {
    const on = picked.includes(agent.templateId);
    setPicked(on ? picked.filter((id) => id !== agent.templateId) : [...picked, agent.templateId]);
    // Dropping the agent that was the secretary drops the designation with
    // it. Leaving it behind would mean a team submitted with a secretary who
    // is not on it, refused by a rule the person cannot see from here.
    if (on && secretary === agent.templateId) setSecretary(undefined);
    // Nobody designated yet and this one may be: designate it. The common
    // case is a two- or three-person team with exactly one candidate, and
    // making that person click twice teaches nothing.
    if (!on && secretary === undefined && agent.secretaryCandidate) setSecretary(agent.templateId);
  };

  const create = async (): Promise<void> => {
    const found = checkTeamDraft({ displayName, projectFolder, members });
    setProblems(found);
    if (found.length > 0) return;
    const ok = await run(() => api.createTeam({ displayName, projectFolder, members }));
    if (!ok) return;
    setDisplayName("");
    setProjectFolder("");
    setPicked([]);
    setSecretary(undefined);
    setProblems([]);
  };

  return (
    <div className={styles.card}>
      <div className={styles.subhead}>新建团队</div>

      <div className={styles.row}>
        <input
          className={`${styles.field} ${complaint("displayName") === undefined ? "" : styles.invalid}`}
          value={displayName}
          placeholder="团队名"
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </div>
      {complaint("displayName") === undefined ? null : <div className={styles.error}>{complaint("displayName")}</div>}

      <FolderField
        value={projectFolder}
        onChange={setProjectFolder}
        kind={picker}
        invalid={complaint("projectFolder") !== undefined}
      />
      {complaint("projectFolder") === undefined ? null : (
        <div className={styles.error}>{complaint("projectFolder")}</div>
      )}

      <div className={styles.subhead}>成员</div>
      {agents.length === 0 ? (
        <div className={styles.hint}>Agent 库是空的——先去「Agent 库」建一个，这里才有人可选。</div>
      ) : (
        <div className={`${styles.pickList} ${complaint("members") === undefined ? "" : styles.invalid}`}>
          {agents.map((agent) => {
            const on = picked.includes(agent.templateId);
            return (
              <div key={agent.templateId} className={styles.pickRow}>
                <label className={styles.check}>
                  <input type="checkbox" checked={on} onChange={() => toggle(agent)} />
                  <span className={styles.dot} style={{ background: agent.color }} />
                  <span className={styles.teamName}>{agent.displayName}</span>
                  <span className={styles.muted}>{agent.role}</span>
                </label>
                {/* The secretary is chosen among the agents the library
                    cleared for it — an agent whose instructions never
                    mentioned planning an agenda should not become the seat
                    that plans one because it was the only box on screen. */}
                {!on ? null : agent.secretaryCandidate ? (
                  <label className={styles.check}>
                    <input
                      type="radio"
                      name="squad-secretary"
                      checked={secretary === agent.templateId}
                      onChange={() => setSecretary(agent.templateId)}
                    />
                    当秘书
                  </label>
                ) : (
                  <span className={styles.muted}>不能当秘书</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {complaint("members") === undefined ? null : <div className={styles.error}>{complaint("members")}</div>}

      <div className={styles.row}>
        <button type="button" className={styles.button} onClick={() => void create()}>
          建团队
        </button>
        <span className={styles.hint}>建好之后还能从 Agent 库里继续加人。</span>
      </div>
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
    </div>
  );
}
