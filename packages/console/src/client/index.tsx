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
import { TeamButton, TeamPanel } from "./panel.tsx";

export const inject = ["slots"];

export function apply(ctx: Context): void {
  // `inject` waits for the slot to be declared before registering.
  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register({ name: "sidebar.footer.action", id: "squad-teams", order: 10 }, TeamButton),
  );
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register({ name: "shell.overlay", id: "squad-workbench" }, TeamPanel),
  );
}
