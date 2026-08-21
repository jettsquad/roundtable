/**
 * client.js — the smallest possible Squad browser half, written by hand.
 *
 * Deliberately NOT built. The unknown being probed is whether an out-of-repo
 * package can be discovered, loaded, and register into a slot at all; a build
 * pipeline is a separate, well-understood problem. Mixing the two would mean a
 * failure could be either, and neither would be ruled out.
 *
 * The output contract is copied from DSH's own client preset
 * (`packages/client/tsdown.client.ts`): a CJS factory handed to the loader,
 * with externals resolved through the injected `require` against the frozen
 * platform module table — react, react/jsx-runtime, react-dom,
 * @deepseek-ai/cordis, ui-slots, web-react, ui-primitives, ui-attachment,
 * schema-form. Anything outside that table cannot be required at runtime,
 * which is why this file imports nothing else.
 *
 * Replace with a real build (esbuild or tsdown) once the chain is proven.
 */
window.__ModuleLoader__.load({
  id: "@squad/console",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;

    /** Client-side services this half needs. */
    exports.inject = ["slots"];

    /**
     * The probe surface: a footer button that opens a panel.
     *
     * Both slots are `list` and `scope: 'root'` — root-scoped matters, because
     * the conversation slots are session-scoped and a session needs a
     * configured model. A management surface that cannot open until you have
     * an API key is not a management surface.
     */
    /**
     * A two-line observable, because the button and the panel live in
     * different slots and cannot share React state.
     *
     * The first version of this probe tried to hijack the panel's setState
     * from the button's render — it toggled the label and never opened the
     * panel, which is what a shared-state assumption looks like when the two
     * components have no common ancestor. DSH's slots have a real store
     * mechanism (`defineStore` in the register options); this is the
     * hand-written stand-in, and the note is here so the real one replaces it
     * rather than inheriting this.
     */
    let open = false;
    const listeners = new Set();
    const store = {
      get: () => open,
      set: (value) => {
        open = value;
        for (const listener of listeners) listener();
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const useOpen = () => React.useSyncExternalStore(store.subscribe, store.get);

    exports.apply = function apply(ctx) {
      function TeamButton() {
        const isOpen = useOpen();
        return h(
          "button",
          {
            type: "button",
            onClick: () => store.set(!isOpen),
            style: { all: "unset", cursor: "pointer", padding: "6px 10px", fontSize: "13px" },
          },
          isOpen ? "团队 ▾" : "团队 ▸",
        );
      }

      function TeamPanel() {
        if (!useOpen()) return null;
        return h(
          "div",
          {
            style: {
              position: "fixed",
              right: "24px",
              bottom: "24px",
              width: "320px",
              padding: "16px",
              borderRadius: "10px",
              background: "#1b1b1f",
              color: "#eee",
              border: "1px solid #333",
              fontSize: "13px",
              zIndex: 60,
            },
          },
          h("div", { style: { fontWeight: 600, marginBottom: "8px" } }, "Squad 工作台"),
          h(
            "div",
            { style: { opacity: 0.7, lineHeight: 1.6 } },
            "探针：客户端插件链路已通——被发现、被加载、注册进了两个 slot、渲染出来了。",
          ),
        );
      }

      // `inject` waits for the slot to be declared before registering; both of
      // these are `list` and `scope: 'root'`, so neither needs a session — and
      // therefore neither needs a configured model.
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register({ name: "sidebar.footer.action", id: "squad-teams", order: 10 }, TeamButton),
      );
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({ name: "shell.overlay", id: "squad-workbench" }, TeamPanel),
      );
    };

    return module.exports;
  },
});
