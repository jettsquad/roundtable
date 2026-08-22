/**
 * panel.tsx — the workbench.
 *
 * Three pages behind one button, the way 1.x split its window: teams, the
 * Agent library, and connections. One scrolling column holding all three was
 * what shipped first, and the complaint it earned was exactly right — the
 * thing you were looking for was never the thing on screen.
 */
import { useState } from "react";
import type { UsageTotals } from "@squad/shared";
import { api, useSnapshot, type SquadSnapshot, type TeamSummary } from "./api.ts";
import { Agenda } from "./agenda.tsx";
import { AgentsPage } from "./agents.tsx";
import { Connections } from "./connections.tsx";
import { Discussion } from "./discussion.tsx";
import { CriteriaPage } from "./criteria.tsx";
import { CreateForm } from "./create.tsx";
import { SeatEditor } from "./seats.tsx";
import { panelStore, usePanelOpen } from "./store.ts";
import styles from "./panel.module.css";

/** The footer button that opens the panel. */
export function TeamButton(): JSX.Element {
  const open = usePanelOpen();
  return (
    <button type="button" className={styles.sectionToggle} onClick={() => panelStore.set(!open)}>
      {open ? "团队 ▾" : "团队 ▸"}
    </button>
  );
}

/**
 * One team's consumption, in a line.
 *
 * Cache tokens are shown separately rather than summed into input. Measured
 * here: a turn whose whole prompt was 「只回答 OK」 billed 2 input tokens and
 * 83,625 of cache creation — the host's own global CLAUDE.md, which every CLI
 * seat inherits. A single "input" figure hides exactly the number worth
 * acting on.
 *
 * 「尚未计量」 is not 「0」: a backend that reported nothing and a turn that
 * cost nothing are different facts, and only one of them is good news.
 */
function usageLine(usage: UsageTotals | undefined): string {
  if (usage === undefined || usage.turns === 0) return "用量：尚未计量";
  const parts = [
    `${usage.turns} 轮`,
    `入 ${usage.inputTokens.toLocaleString()}`,
    `出 ${usage.outputTokens.toLocaleString()}`,
    `缓存 ${(usage.cacheCreationTokens + usage.cacheReadTokens).toLocaleString()}`,
  ];
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(4)}`);
  return `用量：${parts.join(" · ")}`;
}

function TeamCard({
  team,
  data,
  onChanged,
}: {
  readonly team: TeamSummary;
  readonly data: SquadSnapshot;
  readonly onChanged: () => void;
}): JSX.Element {
  return (
    <div className={styles.card}>
      <div className={styles.row}>
        <span className={styles.teamName}>{team.displayName}</span>
        <span className={styles.muted}>{team.projectFolder}</span>
        {team.busy ? <span className={styles.badgeRun}>进行中</span> : null}
        <button
          type="button"
          className={styles.drop}
          title="解散这支团队"
          onClick={() => {
            // Asked first, and the question says what survives: the record
            // this team wrote stays, because the discussion happened and a
            // checkpoint whose team is gone is still the only account of what
            // was decided.
            if (window.confirm(`解散「${team.displayName}」？已经写下的记录会留着，但这张桌子就没了。`)) {
              void api.disbandTeam({ teamId: team.teamId }).then(onChanged);
            }
          }}
        >
          解散
        </button>
      </div>
      {team.progress === undefined ? null : (
        <div className={styles.muted}>
          议程：{team.progress.phase}（{team.progress.phaseIndex + 1}/{team.progress.phaseCount}）
        </div>
      )}
      <div className={styles.muted}>
        {usageLine(team.usage)} · 记录 {team.recorded} 行 · {team.seats.length} 个席位
        {team.seats.some((seat) => seat.isSecretary) ? "" : " · ⚠️ 没有秘书，排不了议程"}
      </div>
      <SeatEditor team={team} connections={data.connections} agents={data.agents} onChanged={onChanged} />
      {/* The discussion, here as well as in the session's 团队 tab.
          That tab only exists once the SESSION has content of its own, and a
          fresh session in a team's workspace has none — so you could talk to
          the team and never see a word of what it said back. */}
      <Agenda team={team} onChanged={onChanged} />
      {/* The discussion, here as well as in the session's 团队 tab. That tab
          only exists once the SESSION has content of its own, and a fresh
          session in a team's workspace has none — so you could talk to the
          team and never see a word of what it said back. */}
      <details>
        <summary className={styles.sectionToggle}>讨论记录（{team.recorded} 行）</summary>
        <Discussion team={team} />
      </details>
      {/* The panel builds and edits teams; talking to one happens in its own
          session, in the composer at the bottom. Putting a second send box
          here is what produced two inputs with different destinations. */}
    </div>
  );
}

type Page = "teams" | "agents" | "connections" | "criteria";

const TABS: readonly { readonly id: Page; readonly label: string }[] = [
  { id: "teams", label: "团队" },
  { id: "agents", label: "Agent 库" },
  { id: "connections", label: "连接" },
  { id: "criteria", label: "判据" },
];

export function TeamPanel(): JSX.Element | null {
  const open = usePanelOpen();
  const [page, setPage] = useState<Page>("teams");
  const [nonce, setNonce] = useState(0);
  const snapshot = useSnapshot(nonce);
  const again = (): void => setNonce((value) => value + 1);

  if (!open) return null;

  const counts =
    snapshot.state === "ready"
      ? {
          teams: snapshot.data.teams.length,
          agents: snapshot.data.agents.length,
          connections: snapshot.data.connections.length,
          criteria: snapshot.data.criteria.live.length + snapshot.data.criteria.proposals.length,
        }
      : undefined;

  return (
    <div
      className={styles.overlay}
      onClick={(event) => {
        if (event.target === event.currentTarget) panelStore.set(false);
      }}
    >
      <div className={styles.panel}>
        <div className={styles.header}>
          <div className={styles.tabs}>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`${styles.tab} ${page === tab.id ? styles.tabOn : ""}`}
                onClick={() => setPage(tab.id)}
              >
                {tab.label}
                {counts === undefined ? "" : `（${counts[tab.id]}）`}
              </button>
            ))}
          </div>
          <div className={styles.row}>
            {/* The badge is a button now. It used to be a sentence naming an
                obligation with nowhere to discharge it. */}
            {snapshot.state === "ready" && snapshot.data.criteria.pending > 0 ? (
              <button type="button" className={styles.close} onClick={() => setPage("criteria")}>
                {snapshot.data.criteria.pending} 条判据待裁定 →
              </button>
            ) : null}
            <button type="button" className={styles.close} onClick={() => panelStore.set(false)}>
              关闭
            </button>
          </div>
        </div>

        {snapshot.state === "loading" ? <div className={styles.muted}>读取中……</div> : null}
        {snapshot.state === "error" ? <div className={styles.error}>{snapshot.detail}</div> : null}
        {snapshot.state !== "ready" ? null : page === "teams" ? (
          <div>
            {snapshot.data.teams.length === 0 ? (
              <div className={styles.hint}>还没有团队。用下面的表单建一支，或者在会话里敲 /squad-new。</div>
            ) : (
              snapshot.data.teams.map((team) => (
                <TeamCard key={team.teamId} team={team} data={snapshot.data} onChanged={again} />
              ))
            )}
            <CreateForm agents={snapshot.data.agents} picker={snapshot.data.picker} onCreated={again} />
          </div>
        ) : page === "agents" ? (
          <AgentsPage agents={snapshot.data.agents} connections={snapshot.data.connections} onChanged={again} />
        ) : page === "criteria" ? (
          <CriteriaPage criteria={snapshot.data.criteria} onChanged={again} />
        ) : (
          <Connections connections={snapshot.data.connections} onChanged={again} />
        )}
      </div>
    </div>
  );
}
