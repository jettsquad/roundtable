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

      /**
       * Read the host's snapshot.
       *
       * Plain fetch, not a Typert Remote: the Remote path generates its
       * artifacts inside the harness repository and the client facade mounts
       * only the contributions that application selected, so an out-of-repo
       * package has no seat there. `ctx.webServer.register` is open by
       * contract; this is the other side of it.
       */
      function useSnapshot(active) {
        const [state, setState] = React.useState({ loading: true });
        React.useEffect(() => {
          if (!active) return undefined;
          let alive = true;
          const read = async () => {
            try {
              const response = await fetch("/api/squad/teams", { headers: { accept: "application/json" } });
              if (!response.ok) throw new Error("HTTP " + response.status);
              const data = await response.json();
              if (alive) setState({ loading: false, data: data });
            } catch (error) {
              // Shown, not swallowed: a panel that renders an empty team list
              // when the read failed says "you have no teams", which is a
              // different and wrong statement.
              if (alive) setState({ loading: false, error: String(error) });
            }
          };
          void read();
          const timer = setInterval(read, 3000);
          return () => {
            alive = false;
            clearInterval(timer);
          };
        }, [active]);
        return state;
      }

      function TeamPanel() {
        const isOpen = useOpen();
        const snapshot = useSnapshot(isOpen);
        if (!isOpen) return null;

        const body = snapshot.error !== undefined
          ? h("div", { style: { color: "#f88" } }, "读不到数据：" + snapshot.error)
          : snapshot.loading
            ? h("div", { style: { opacity: 0.6 } }, "读取中…")
            : h(
                "div",
                null,
                snapshot.data.teams.length === 0
                  ? h(
                      "div",
                      { style: { opacity: 0.6, lineHeight: 1.6 } },
                      "还没有团队。到会话里敲 /squad-new 团队名 | 项目文件夹 | 甲=角色",
                    )
                  : snapshot.data.teams.map((team) =>
                      h(
                        "div",
                        { key: team.teamId, style: { marginBottom: "10px" } },
                        h(
                          "div",
                          { style: { fontWeight: 600 } },
                          team.displayName,
                          team.busy ? h("span", { style: { color: "#7c7", marginLeft: "6px" } }, "● 进行中") : null,
                        ),
                        h(
                          "div",
                          { style: { opacity: 0.65, fontSize: "12px", lineHeight: 1.6 } },
                          team.seats.map((seat) => seat.displayName + "（" + seat.role + "）").join("、"),
                          h("br", null),
                          "记录 " + team.recorded + " 条 · " + team.projectFolder,
                        ),
                      ),
                    ),
                h(
                  "div",
                  { style: { marginTop: "12px", paddingTop: "10px", borderTop: "1px solid #333", opacity: 0.75 } },
                  "判据：已生效 " + snapshot.data.criteria.active + " 条，待裁定 " + snapshot.data.criteria.pending + " 条",
                ),
              );

        return h(
          "div",
          {
            style: {
              position: "fixed",
              right: "24px",
              bottom: "24px",
              width: "340px",
              maxHeight: "60vh",
              overflowY: "auto",
              padding: "16px",
              borderRadius: "10px",
              background: "#1b1b1f",
              color: "#eee",
              border: "1px solid #333",
              fontSize: "13px",
              zIndex: 60,
            },
          },
          h("div", { style: { fontWeight: 600, marginBottom: "10px" } }, "Squad 工作台"),
          body,
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
