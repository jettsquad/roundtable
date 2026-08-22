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
import { TeamView } from "./team-view.tsx";

/**
 * `workspaces` as well as `slots`: the team view resolves WHICH team a
 * session belongs to through its workspace, and the client context refuses a
 * property that was not declared — the slot crashed with
 * `cannot get property "workspaces" without inject`, which the tab surfaced
 * as an empty pane.
 */
export const inject = ["slots", "workspaces"];

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
        }),
      },
      TeamView,
    ),
  );
}
