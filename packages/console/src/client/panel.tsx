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
import { useT } from "./locale.ts";
import type { SquadKey } from "./locales.ts";
import { Agenda } from "./agenda.tsx";
import { AgentsPage } from "./agents.tsx";
import { Connections } from "./connections.tsx";
import { Discussion } from "./discussion.tsx";
import { CriteriaPage } from "./criteria.tsx";
import { CreateForm } from "./create.tsx";
import { SeatEditor } from "./seats.tsx";
import { TeamPromptsPanel } from "./team-prompts.tsx";
import { BlocksPage } from "./blocks.tsx";
import { MoveButtons, SearchBox, matches } from "./order-controls.tsx";
import { panelStore, usePanelOpen } from "./store.ts";
import { preferTeamView } from "./land-on-team.ts";
import { shellSessions } from "./team-sessions.ts";
import styles from "./panel.module.css";

/** The footer button that opens the panel. */
export function TeamButton(): JSX.Element {
  const open = usePanelOpen();
  const t = useT();
  return (
    <button type="button" className={styles.sectionToggle} onClick={() => panelStore.set(!open)}>
      {open ? t("panel.open") : t("panel.closed")}
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
type Translate = ReturnType<typeof useT>;

/**
 * The usage figures, WITHOUT the "usage:" prefix.
 *
 * `t` is a parameter because this is a plain function, not a component, and
 * hooks are only legal in components. Returning the bare figures is what
 * removed the caller that used to strip the prefix back off with
 * `.replace("用量：", "")` — a string that had to match a translation exactly,
 * which is the one thing a translation is free to change.
 */
function usageFigures(t: Translate, usage: UsageTotals | undefined): string | undefined {
  if (usage === undefined || usage.turns === 0) return undefined;
  const parts = [
    t("team.usage.turns", { n: usage.turns }),
    t("team.usage.in", { n: usage.inputTokens.toLocaleString() }),
    t("team.usage.out", { n: usage.outputTokens.toLocaleString() }),
    t("team.usage.cache", { n: (usage.cacheCreationTokens + usage.cacheReadTokens).toLocaleString() }),
  ];
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(4)}`);
  return parts.join(" · ");
}

/**
 * Update a designer team's prompts to the current seed.
 *
 * Only on a designer team, and only there because only there is the prompt
 * text part of this program rather than something the user wrote. A sitting
 * shares its base team's roster, so 「开一场新的」 carries the OLD
 * instructions forward — which is right for a team somebody configured and
 * exactly wrong for this one.
 */
function RefreshDesigner({
  team,
  onChanged,
}: {
  readonly team: TeamSummary;
  readonly onChanged: () => void;
}): JSX.Element {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <>
      <button
        type="button"
        className={styles.drop}
        title={t("team.refresh.title")}
        disabled={busy || team.busy}
        onClick={() => {
          setBusy(true);
          setError(undefined);
          void api
            .refreshDesigner({ teamId: team.teamId })
            .then((answer) => {
              setDone(answer.refreshed.length);
              onChanged();
            })
            .catch((problem: Error) => setError(problem.message))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? t("team.refresh.busy") : done === undefined ? t("team.refresh") : t("team.refresh.done", { n: done })}
      </button>
      {error === undefined ? null : <span className={styles.error}>{error}</span>}
    </>
  );
}

/**
 * Start another sitting of this team.
 *
 * There was no way to do this from inside Squad, and the way from outside did
 * not work: dsh's 「New Session」 screen is not a session yet — no id, no
 * agent — so a slash command typed there has nothing to dispatch to, and the
 * blank shell is reclaimed the moment you navigate away. In a team's folder
 * you also cannot send the first message that would make it real, because the
 * composer there belongs to the team. That is a deadlock, and this is the way
 * out of it.
 *
 * The shell resolves the session (reusing the workspace's blank one rather
 * than minting a second), the server creates the sitting and marks it — the
 * mark is what makes the session durable, so it stops disappearing — and a
 * designer team gets its five phases put back up as a draft on the way in.
 */
function NewSitting({ team, onChanged }: { readonly team: TeamSummary; readonly onChanged: () => void }): JSX.Element {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const shell = shellSessions();
  return (
    <>
      <button
        type="button"
        className={styles.drop}
        title={t("team.sitting.title")}
        disabled={busy || shell === undefined}
        onClick={() => {
          if (shell === undefined) return;
          const workspaceId = shell.workspaceIdFor(team.projectFolder);
          if (workspaceId === undefined) {
            // Says which folder it looked for, because the failure people
            // actually hit is a path that does not match — a symlink, a
            // trailing slash — not a workspace that is genuinely missing.
            setError(t("team.sitting.noWorkspace", { folder: team.projectFolder }));
            return;
          }
          setBusy(true);
          setError(undefined);
          void shell
            .connectWorkspace(workspaceId)
            .then(async (sessionId) => {
              preferTeamView(sessionId);
              // Creates the sitting AND marks the session, which is what
              // makes it survive a reload. Its id is the record the new
              // session works in from now on.
              const sitting = await api.sitting({ projectFolder: team.projectFolder, sessionId });
              if (sitting.teamId !== undefined) await api.designerAgenda({ teamId: sitting.teamId });
              shell.open(sessionId);
              onChanged();
            })
            .catch((problem: unknown) => {
              setError(problem instanceof Error ? problem.message : String(problem));
            })
            .finally(() => setBusy(false));
        }}
      >
        {busy ? t("team.sitting.busy") : t("team.sitting")}
      </button>
      {error === undefined ? null : <span className={styles.error}>{error}</span>}
    </>
  );
}

function TeamCard({
  team,
  data,
  onChanged,
  order,
  expanded,
  onToggle,
}: {
  readonly team: TeamSummary;
  readonly data: SquadSnapshot;
  readonly onChanged: () => void;
  /** Absent while a filter is on: see `MoveButtons` in the agent list. */
  readonly order?:
    { readonly index: number; readonly count: number; readonly move: (delta: number) => Promise<unknown> } | undefined;
  /**
   * Shown in full.
   *
   * `expanded`, not `open`: `open` is a global (`window.open`), so a prop by
   * that name resolves to the function wherever the destructuring misses it —
   * and the failure is `aria-expanded={ƒ}`, which types caught here only
   * because JSX attributes are typed. In plain code it would have been a
   * truthy value that is always true.
   */
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  const t = useT();
  return (
    <div className={`${styles.card} ${styles.cardTinted}`} style={{ borderLeftColor: teamTint(team.displayName) }}>
      {/* The row that is always visible. Everything on it is something you
          need in order to decide whether to open the card at all — which is
          the entire job of a collapsed row, and the reason the status badge
          lives here rather than inside. A team stopped and waiting for you
          must not be something you have to go looking for. */}
      <div className={styles.row}>
        <button
          type="button"
          className={styles.chipOpen}
          onClick={onToggle}
          aria-expanded={expanded}
          title={expanded ? t("team.collapse") : t("team.expand")}
        >
          {expanded ? "▾" : "▸"} <span className={styles.teamName}>{team.displayName}</span>
        </button>
        <span className={styles.muted}>
          {t("team.meta", {
            seats: team.seats.length,
            rows: team.recorded,
            usage: usageFigures(t, team.usage) ?? t("team.usage.none"),
          })}
        </span>
        {team.busy ? <span className={styles.badgeRun}>{t("team.badge.running")}</span> : null}
        {team.busy || team.unfinished === undefined ? null : team.unfinished.awaitingHost ? (
          <span className={styles.badgeWait}>{t("team.badge.awaiting")}</span>
        ) : (
          <span className={styles.muted}>
            {t("team.badge.agenda", { done: team.unfinished.done.length, total: team.unfinished.phases.length })}
          </span>
        )}
        {team.seats.some((seat) => seat.isSecretary) ? null : (
          <span className={styles.badgeWait}>{t("team.badge.noSecretary")}</span>
        )}
        <span className={styles.grow} />
        <span className={styles.muted}>{team.projectFolder}</span>
      </div>
      {!expanded ? null : (
        <>
          <div className={styles.row}>
            {order === undefined ? null : (
              <MoveButtons index={order.index} count={order.count} label={team.displayName} onMove={order.move} />
            )}
            {team.designer !== true ? null : <RefreshDesigner team={team} onChanged={onChanged} />}
            <NewSitting team={team} onChanged={onChanged} />
            <button
              type="button"
              className={styles.drop}
              title={t("team.disband.title")}
              onClick={() => {
                // Asked first, and the question says what survives: the record
                // this team wrote stays, because the discussion happened and a
                // checkpoint whose team is gone is still the only account of what
                // was decided.
                if (window.confirm(t("team.disband.confirm", { name: team.displayName }))) {
                  void api.disbandTeam({ teamId: team.teamId }).then(onChanged);
                }
              }}
            >
              {t("team.disband")}
            </button>
          </div>
          {team.progress === undefined ? null : (
            <div className={styles.muted}>
              {t("team.progress", {
                phase: team.progress.phase,
                index: team.progress.phaseIndex + 1,
                total: team.progress.phaseCount,
              })}
            </div>
          )}
          <SeatEditor team={team} connections={data.connections} agents={data.agents} onChanged={onChanged} />
          {/* Above the agenda and the discussion: it is the frame everything else
          in this card happens inside. */}
          <TeamPromptsPanel team={team} library={data.blocks} onChanged={onChanged} />
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
            <summary className={styles.sectionToggle}>{t("team.transcript", { n: team.recorded })}</summary>
            <Discussion team={team} onChanged={onChanged} pickerKind={data.picker} />
          </details>
          {/* The panel builds and edits teams; talking to one happens in its
              own session, in the composer at the bottom. Putting a second
              send box here is what produced two inputs with different
              destinations. */}
        </>
      )}
    </div>
  );
}

/** Where the open/closed set is remembered. */
const OPEN_KEY = "squad.panel.openTeams";

/** Enough separation that two teams next to each other never look alike. */
const TEAM_TINTS = ["#4C8DFF", "#2FB67C", "#F2A93B", "#8A6BE0", "#E5484D", "#12A5B0", "#D6409F", "#7A8A99"] as const;

/**
 * A team's colour, from its name.
 *
 * Derived rather than stored, so it is the same in every window, survives the
 * list being sorted or filtered, and costs no configuration. Derived from the
 * NAME rather than the id because the name is what a person recognises — and
 * a team rebuilt under the same name keeps the colour they learned.
 */
function teamTint(name: string): string {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 100_000;
  return TEAM_TINTS[hash % TEAM_TINTS.length] ?? TEAM_TINTS[0];
}

type Page = "teams" | "agents" | "blocks" | "connections" | "criteria";

/**
 * The tabs, as dictionary KEYS rather than text.
 *
 * The label is looked up at render so a language switch reaches this list
 * without it being rebuilt — a module-level array of translated strings would
 * be captured once, at import, in whatever language happened to be active.
 */
const TABS: readonly { readonly id: Page; readonly label: SquadKey }[] = [
  { id: "teams", label: "panel.tab.teams" },
  { id: "agents", label: "panel.tab.agents" },
  { id: "blocks", label: "panel.tab.blocks" },
  { id: "connections", label: "panel.tab.connections" },
  { id: "criteria", label: "panel.tab.criteria" },
];

export function TeamPanel(): JSX.Element | null {
  const open = usePanelOpen();
  // With the other hooks, above the `!open` return — see the note below.
  const t = useT();
  const [page, setPage] = useState<Page>("teams");
  const [nonce, setNonce] = useState(0);
  const snapshot = useSnapshot(nonce);
  const again = (): void => setNonce((value) => value + 1);
  // ABOVE the `!open` return, with every other hook. It was below it, and the
  // panel then called four hooks while closed and five while open — which
  // React refuses, so the whole component threw the moment it was opened and
  // the button in the sidebar did nothing at all. A hook after a conditional
  // return is not a smaller bug than one inside an `if`; it is the same bug.
  const [query, setQuery] = useState("");
  /**
   * Which teams are open, by hand.
   *
   * Per browser, not per team: 「我现在在看哪一支」 is a fact about this
   * window at this moment, not a property of the team — stored on the record
   * it would follow you to another machine and, worse, open cards for
   * somebody else looking at the same table.
   */
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });

  if (!open) return null;

  // Teams, not sittings. A sitting is one piece of work in a team's folder —
  // listing them here would turn 「团队」 into a list of every session anyone
  // ever opened, and the count next to it into a number of windows.
  const teams = snapshot.state === "ready" ? snapshot.data.teams.filter((team) => team.baseTeamId === undefined) : [];
  // The roster is searched too: 「哪支团队里有赤木晴子」 is how people
  // actually look for a team they set up weeks ago.
  const shownTeams = teams.filter((team) =>
    matches(
      query,
      team.displayName,
      team.projectFolder,
      ...team.seats.map((seat) => `${seat.displayName} ${seat.role}`),
    ),
  );

  const counts =
    snapshot.state === "ready"
      ? {
          teams: teams.length,
          agents: snapshot.data.agents.length,
          blocks: snapshot.data.blocks.length,
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
                {t(tab.label)}
                {counts === undefined ? "" : t("panel.count", { n: counts[tab.id] })}
              </button>
            ))}
          </div>
          <div className={styles.row}>
            {/* The badge is a button now. It used to be a sentence naming an
                obligation with nowhere to discharge it. */}
            {snapshot.state === "ready" && snapshot.data.criteria.pending > 0 ? (
              <button type="button" className={styles.close} onClick={() => setPage("criteria")}>
                {t("panel.criteria.pending", { n: snapshot.data.criteria.pending })}
              </button>
            ) : null}
            <button type="button" className={styles.close} onClick={() => panelStore.set(false)}>
              {t("panel.close")}
            </button>
          </div>
        </div>

        {snapshot.state === "loading" ? <div className={styles.muted}>{t("teams.loading")}</div> : null}
        {snapshot.state === "error" ? <div className={styles.error}>{snapshot.detail}</div> : null}
        {snapshot.state !== "ready" ? null : page === "teams" ? (
          <div>
            <SearchBox value={query} onChange={setQuery} placeholder={t("panel.search")} />
            {teams.length === 0 ? (
              <div className={styles.hint}>{t("teams.none")}</div>
            ) : shownTeams.length === 0 ? (
              <div className={styles.hint}>{t("teams.noMatch", { query })}</div>
            ) : (
              shownTeams.map((team) => (
                <TeamCard
                  key={team.teamId}
                  team={team}
                  data={snapshot.data}
                  onChanged={again}
                  // Open when you said so — or when the team needs you.
                  // Something waiting on a person must not be one click away
                  // from being seen; that is the whole reason 「等你回答」
                  // exists as a state at all. A search hit opens too: finding
                  // a team and then having to click it again is the search
                  // not finishing its job.
                  expanded={
                    opened.has(team.teamId) ||
                    team.busy ||
                    team.unfinished?.awaitingHost === true ||
                    query.trim() !== ""
                  }
                  onToggle={() =>
                    setOpened((current) => {
                      const next = new Set(current);
                      if (next.has(team.teamId)) next.delete(team.teamId);
                      else next.add(team.teamId);
                      try {
                        localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
                      } catch {
                        // Private mode, blocked storage: the panel still
                        // opens and closes, it just forgets across reloads.
                      }
                      return next;
                    })
                  }
                  order={
                    query.trim() === ""
                      ? {
                          index: teams.indexOf(team),
                          count: teams.length,
                          move: (delta: number) => api.moveTeam({ teamId: team.teamId, delta }).then(again),
                        }
                      : undefined
                  }
                />
              ))
            )}
            <CreateForm agents={snapshot.data.agents} picker={snapshot.data.picker} onCreated={again} />
          </div>
        ) : page === "agents" ? (
          <AgentsPage agents={snapshot.data.agents} connections={snapshot.data.connections} onChanged={again} />
        ) : page === "blocks" ? (
          <BlocksPage blocks={snapshot.data.blocks} onChanged={again} />
        ) : page === "criteria" ? (
          <CriteriaPage criteria={snapshot.data.criteria} onChanged={again} />
        ) : (
          <Connections connections={snapshot.data.connections} onChanged={again} />
        )}
      </div>
    </div>
  );
}
