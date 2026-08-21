/**
 * panel.tsx — the workbench.
 */
import { useState } from "react";
import type { UsageTotals } from "@squad/shared";
import { useSnapshot, type TeamSummary } from "./api.ts";
import { Connections } from "./connections.tsx";
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
    `用量：${usage.turns} 轮`,
    `入 ${usage.inputTokens}`,
    `出 ${usage.outputTokens}`,
    `缓存 ${usage.cacheCreationTokens + usage.cacheReadTokens}`,
  ];
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(4)}`);
  return parts.join(" · ");
}

function Team({ team, ...rest }: { readonly team: TeamSummary } & Omit<Parameters<typeof SeatEditor>[0], "team">) {
  return (
    <div className={styles.team}>
      <div>
        <span className={styles.teamName}>{team.displayName}</span>{" "}
        <span className={styles.muted}>{team.projectFolder}</span>
        {team.busy ? <span className={styles.muted}> · 进行中</span> : null}
      </div>
      {team.progress === undefined ? null : (
        <div className={styles.muted}>
          议程：{team.progress.phase}（{team.progress.phaseIndex + 1}/{team.progress.phaseCount}）
        </div>
      )}
      <div className={styles.muted}>
        {usageLine(team.usage)} · 记录 {team.recorded} 行
      </div>
      <SeatEditor team={team} {...rest} />
    </div>
  );
}

export function TeamPanel(): JSX.Element | null {
  const open = usePanelOpen();
  const [nonce, setNonce] = useState(0);
  const snapshot = useSnapshot(nonce);
  const again = (): void => setNonce((value) => value + 1);

  if (!open) return null;

  return (
    <div
      className={styles.overlay}
      onClick={(event) => {
        if (event.target === event.currentTarget) panelStore.set(false);
      }}
    >
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.title}>
            Squad 团队
            {snapshot.state === "ready" && snapshot.data.criteria.pending > 0 ? (
              <span className={styles.muted}> · {snapshot.data.criteria.pending} 条判据待裁定</span>
            ) : null}
          </span>
          <button type="button" className={styles.close} onClick={() => panelStore.set(false)}>
            关闭
          </button>
        </div>

        {snapshot.state === "loading" ? <div className={styles.muted}>读取中……</div> : null}
        {snapshot.state === "error" ? <div className={styles.error}>{snapshot.detail}</div> : null}
        {snapshot.state !== "ready" ? null : (
          <div>
            {snapshot.data.teams.length === 0 ? (
              <div className={styles.muted}>还没有团队。用下面的表单建一支，或者在会话里敲 /squad-new。</div>
            ) : (
              snapshot.data.teams.map((team) => (
                <Team key={team.teamId} team={team} connections={snapshot.data.connections} onChanged={again} />
              ))
            )}
            <Connections connections={snapshot.data.connections} onChanged={again} />
            <CreateForm onCreated={again} />
          </div>
        )}
      </div>
    </div>
  );
}
