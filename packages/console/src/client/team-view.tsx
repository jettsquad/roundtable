/**
 * team-view.tsx — the team, as a view inside the session.
 *
 * This is the structural correction. 1.x's team workbench WAS the main area:
 * the discussion, the roster with live status, the agenda, and the box you
 * type into, all in one place. 2.0 put it in a floating overlay, and left the
 * main area showing dsh's own chat — which answers to a model, needs its own
 * API key, and has nothing to do with the team. So "I can't send messages"
 * was exactly right: the box in the middle of the screen was never wired to
 * the team at all.
 *
 * `conversation.view` is a KEYED slot — it is how Chat and Trajectory are
 * tabs — so a team gets its own tab next to them, on the sessions that belong
 * to a team's workspace.
 */

import type { UsageTotals } from "@squad/shared";
import { useState } from "react";
import { useSnapshot, type SquadSnapshot, type TeamSummary } from "./api.ts";
import { Agenda } from "./agenda.tsx";
import { Discussion } from "./discussion.tsx";
import styles from "./panel.module.css";

/** One team's consumption, in a line. See `panel.tsx` for why cache is separate. */
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

/**
 * What the team is doing right now, in one sentence.
 *
 * Carried over from 1.x, which said 「空闲：没有成员在执行，等待你的指令」
 * rather than showing nothing. A surface that is silent while idle and silent
 * while stuck looks the same in both states, and only one of them is fine.
 */
function statusLine(team: TeamSummary): string {
  const speaking = team.seats.filter((seat) => seat.running);
  if (speaking.length > 0) return `工作中：${speaking.map((seat) => seat.displayName).join("、")} 正在发言。`;
  if (team.progress !== undefined) {
    return `议程进行中：${team.progress.phase}（第 ${team.progress.phaseIndex + 1}/${team.progress.phaseCount} 阶段）。`;
  }
  if (team.busy) return "工作中……";
  return "空闲：没有成员在执行，等待你的指令。";
}

function Roster({ team, data }: { readonly team: TeamSummary; readonly data: SquadSnapshot }): JSX.Element {
  return (
    <div className={styles.rosterStrip}>
      {team.seats.map((seat) => (
        <span key={seat.seatId} className={`${styles.seat} ${seat.running ? styles.running : ""}`}>
          <span className={styles.dot} style={{ background: seat.color ?? "#5a5a62" }} />
          {seat.isSecretary ? "★ " : ""}
          {seat.displayName}
          <span className={styles.muted}>{seat.role}</span>
          {/* Which model, on the roster itself. 1.x showed it here too: the
              first question about a surprising answer is who said it and on
              what. */}
          {/* The connection's NAME, not its id. The id is ours; the name is
              what the person typed, and it is the only one of the two they
              can recognise. */}
          <span className={styles.muted}>
            {seat.connectionId === undefined
              ? "本机登录"
              : (data.connections.find((c) => c.connectionId === seat.connectionId)?.displayName ?? "⚠️ 连接已删除")}
            {seat.permissionMode === undefined ? "" : ` · ${seat.permissionMode}`}
          </span>
          {seat.running ? <span className={styles.badgeRun}>发言中</span> : null}
          {seat.blocked === undefined ? null : <span className={styles.badgeBad}>⚠️ {seat.blocked}</span>}
        </span>
      ))}
    </div>
  );
}

/**
 * The team owning this session's directory, if any.
 *
 * Matched on the project folder, which the team stores canonicalised for
 * exactly this comparison — the workspace registry resolves symlinks, so a
 * team holding `/tmp/x` could never match a session in `/private/tmp/x`.
 */
function teamForCwd(data: SquadSnapshot, cwd: string | undefined): TeamSummary | undefined {
  if (cwd === undefined || cwd === "") return undefined;
  return data.teams.find((team) => team.projectFolder === cwd);
}

export function TeamView({ folderOf }: { readonly folderOf: () => string | undefined }): JSX.Element {
  const cwd = folderOf();
  const [nonce, setNonce] = useState(0);
  const snapshot = useSnapshot(nonce);

  if (snapshot.state === "loading") return <div className={styles.viewPad}>读取中……</div>;
  if (snapshot.state === "error") return <div className={styles.viewPad}>{snapshot.detail}</div>;

  const team = teamForCwd(snapshot.data, cwd);
  if (team === undefined) {
    return (
      <div className={styles.viewPad}>
        <div className={styles.hint}>
          这个会话所在的目录（{cwd ?? "未知"}）还没有团队。到左下角的「团队」面板里建一支，项目文件夹选这里。
        </div>
      </div>
    );
  }

  return (
    <div className={styles.viewPad}>
      <div className={styles.row}>
        <span className={styles.teamName}>{team.displayName}</span>
        <span className={styles.muted}>{team.projectFolder}</span>
      </div>
      <div className={styles.muted}>{statusLine(team)}</div>
      <div className={styles.muted}>
        {usageLine(team.usage)} · 记录 {team.recorded} 行
        {team.seats.some((seat) => seat.isSecretary) ? "" : " · ⚠️ 没有秘书，排不了议程"}
      </div>

      <Roster team={team} data={snapshot.data} />
      {/* The agenda lives here as well as in the panel: this is where the
          work happens, and a plan you must leave the room to confirm is a
          plan you confirm without looking at the discussion it came from. */}
      <Agenda team={team} onChanged={() => setNonce((value) => value + 1)} />
      <Discussion team={team} autoScroll />
      {/* No input box here. There is exactly one on the screen and it is the
          one at the bottom, in the place people already type — see
          `composer.tsx`. Two boxes with different destinations is what made
          this unusable. */}
    </div>
  );
}
