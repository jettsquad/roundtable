/**
 * index.tsx — Squad's browser half.
 *
 * Both slots are `list` and `scope: 'root'`. Root-scoped matters: the
 * conversation slots are session-scoped, and a session needs a configured
 * model. A management surface you cannot open until you already have an API
 * key is not a management surface — it is the screen you needed in order to
 * enter the key.
 */
import type { Context } from "@deepseek-ai/cordis";
// Type-only, and load-bearing: `ctx.slots` is a declaration merge onto the
// client Context published by the runtime's client half. Without this import
// the property does not exist as far as the checker is concerned — which is
// how the hand-written version got away with never being typechecked at all.
// Erased at build, so it crosses no module edge.
import type {} from "@deepseek-ai/dsh-client-runtime/client";
// The two slot owners, also type-only. A slot name is a legal argument only
// once the package that declares it has merged it into `SlotMap`.
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
// Declares `conversation.view` — the keyed slot Chat and Trajectory are tabs
// in, and therefore where a team view belongs.
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import { TeamButton, TeamPanel } from "./panel.tsx";
import { SquadComposer } from "./composer.tsx";
import { api } from "./api.ts";
import { setTeamFolders, teamFolders, watchTeamFolders } from "./team-sessions.ts";
import { preferTeamView } from "./land-on-team.ts";
import { claimSession } from "./use-sitting.ts";
import { TeamView } from "./team-view.tsx";

/**
 * `workspaces` as well as `slots`: the team view resolves WHICH team a
 * session belongs to through its workspace, and the client context refuses a
 * property that was not declared — the slot crashed with
 * `cannot get property "workspaces" without inject`, which the tab surfaced
 * as an empty pane.
 */
export const inject = ["slots", "workspaces", "sessions"];

export function apply(ctx: Context): void {
  // `inject` waits for the slot to be declared before registering.
  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register({ name: "sidebar.footer.action", id: "squad-teams", order: 10 }, TeamButton),
  );
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register({ name: "shell.overlay", id: "squad-workbench" }, TeamPanel),
  );

  /**
   * The team, as a tab beside Chat and Trajectory.
   *
   * `conversation.view` is a KEYED slot — that is what makes Chat and
   * Trajectory tabs — so this is the seam a third view belongs in. The
   * overlay panel stays for the things that are not about one team:
   * building teams, the agent library, connections, criteria.
   *
   * The session's working directory decides WHICH team: a team registers
   * its folder as the workspace, so every session in that workspace is a
   * session of that team.
   */
  /**
   * Keep the team-folder cache fresh.
   *
   * The composer chain's election reads it synchronously, and a team that was
   * just created has to take over its sessions without a reload. Two seconds
   * is the same cadence the panel already polls at; the cache only announces
   * a real change, so this does not re-register anything on a quiet tick.
   */
  const poll = setInterval(() => {
    void api
      .snapshot()
      .then((snapshot) => {
        const folders = snapshot.teams.map((team) => team.projectFolder);
        setTeamFolders(folders);
        // Seed the landing tab for every session in a team's workspace,
        // including ones nobody has opened yet. dsh's chat store rehydrates
        // its persisted value when the session is first rendered, so writing
        // it before that is the only moment that decides where 新建会话
        // lands — see `land-on-team.ts`.
        const teamFolders = new Set(folders);
        for (const workspace of ctx.workspaces.list.getSnapshot().items) {
          if (!teamFolders.has(workspace.path)) continue;
          for (const sessionId of workspace.sessionIds) {
            preferTeamView(sessionId);
            // Claimed here, not when something renders. See `claimSession`:
            // an unclaimed session stays blank, which means dsh hides it and
            // hands it out again on the next 新建会话.
            claimSession(workspace.path, sessionId);
          }
        }
      })
      .catch(() => undefined);
  }, 2000);
  ctx.effect(() => () => clearInterval(poll));

  /**
   * Seed the landing tab the moment the workspace list learns of a session.
   *
   * The poll alone is two seconds behind, and 新建会话 creates a session and
   * opens it in one breath — the store rehydrates on first render, so two
   * seconds late is too late for the one session that matters. This fires on
   * the same update that puts the new session in the sidebar.
   */
  /**
   * The same seeding, driven by the SESSIONS list as well.
   *
   * Two subscriptions rather than one because they update on different
   * frames, and the race that matters is narrow: dsh's chat store reads its
   * persisted view when the session is first rendered, so a preference
   * written after that first render only takes effect the next time the
   * session is opened. Whichever list hears about the session first wins.
   */
  ctx.effect(() =>
    ctx.sessions.list.subscribe(() => {
      const folders = teamFolders();
      for (const workspace of ctx.workspaces.list.getSnapshot().items) {
        if (!folders.has(workspace.path)) continue;
        for (const sessionId of workspace.sessionIds) preferTeamView(sessionId);
      }
    }),
  );

  ctx.effect(() =>
    ctx.workspaces.list.subscribe(() => {
      const folders = teamFolders();
      for (const workspace of ctx.workspaces.list.getSnapshot().items) {
        if (!folders.has(workspace.path)) continue;
        for (const sessionId of workspace.sessionIds) {
          preferTeamView(sessionId);
          claimSession(workspace.path, sessionId);
        }
      }
    }),
  );

  /** The workspace folder one session sits in, or undefined. */
  const folderOfSession = (sessionId: string): string | undefined =>
    ctx.workspaces.list.getSnapshot().items.find((workspace) => workspace.sessionIds.includes(sessionId))?.path;

  /**
   * Take over the composer on a team's sessions.
   *
   * `conversation.composer` is a chain whose fallback is dsh's own input bar,
   * held mounted under an election so its draft survives. Electing here means
   * the box in the usual place goes to the team — which is the whole point:
   * two input boxes on one screen, one of them wired to something else
   * entirely, is not a design anybody can use.
   *
   * Re-registered whenever the set of team folders changes, because the
   * election is computed from that set and a chain only re-dispatches when
   * its entries change. Without this a team created just now would not take
   * over until something else forced a re-render.
   */
  const registerComposer = (): (() => void) =>
    ctx.slots.register(
      {
        name: "conversation.composer",
        // Below dsh's own approval and read-only claims: an approval prompt
        // or an unavailable parent has to win over a team's input box.
        priority: -20,
        select: (owner: { session: { sessionId: string } | undefined }) => {
          const sessionId = owner.session?.sessionId;
          if (sessionId === undefined) return null;
          const folder = folderOfSession(sessionId);
          // The SESSION travels with the folder. A team's workspace holds
          // many sessions and each is its own sitting; without this the box
          // would elect correctly and then write into whichever record the
          // folder happened to point at.
          return folder !== undefined && teamFolders().has(folder) ? { folder, sessionId } : null;
        },
      },
      ({ matched }: { matched: { folder: string; sessionId: string } }) => (
        <SquadComposer folder={matched.folder} sessionId={matched.sessionId} />
      ),
    );
  ctx.slots.inject("conversation.composer", () => {
    let dispose = registerComposer();
    const stop = watchTeamFolders(() => {
      dispose();
      dispose = registerComposer();
    });
    return () => {
      stop();
      dispose();
    };
  });

  ctx.slots.inject("conversation.view", () =>
    ctx.slots.register(
      {
        name: "conversation.view",
        id: "squad-team",
        order: 20,
        label: () => "团队",
        // The session's workspace decides which team. Read from the
        // workspace list rather than the session's own cwd: the registry
        // canonicalises paths, and a team stores the canonical spelling
        // for exactly this comparison.
        inject: (sessionId: string) => ({
          folderOf: (): string | undefined =>
            ctx.workspaces.list.getSnapshot().items.find((workspace) => workspace.sessionIds.includes(sessionId))?.path,
          // Which session, not only which folder: the tab shows one sitting's
          // discussion, and a folder alone cannot say which.
          sessionId,
        }),
      },
      TeamView,
    ),
  );
}
