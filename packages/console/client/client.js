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
       * One team's consumption, in a line.
       *
       * Cache tokens are shown separately rather than summed into input.
       * Measured here: a turn whose whole prompt was 「只回答 OK」 billed 2
       * input and 83,625 of cache creation — the host's own global CLAUDE.md,
       * which every CLI seat inherits. A single "input" figure hides exactly
       * the number worth acting on.
       *
       * "尚未计量" is not "0": a backend that reported nothing and a turn that
       * cost nothing are different facts, and only one of them is good news.
       */
      function usageLine(usage) {
        if (usage === undefined || usage.turns === 0) return "用量：尚未计量";
        const parts = [
          "用量：" + usage.turns + " 轮",
          "入 " + usage.inputTokens,
          "出 " + usage.outputTokens,
          "缓存 " + (usage.cacheCreationTokens + usage.cacheReadTokens),
        ];
        if (usage.costUsd !== undefined) parts.push("$" + usage.costUsd.toFixed(4));
        return parts.join(" · ");
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
      function useSnapshot(active, nonce) {
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
        }, [active, nonce]);
        return state;
      }

      /**
       * The create form.
       *
       * Here rather than only on `/squad-new`, because reaching that command
       * needs a session, and a session needs a message that fails for want of
       * a model key. Making the first team require passing through a broken
       * step is not an onboarding path.
       *
       * Creating is allowed over the route; starting a round is not — see the
       * host side for why the line is drawn at "who can reach it" rather than
       * at the verb.
       */
      function CreateForm(props) {
        const [name, setName] = React.useState("");
        const [folder, setFolder] = React.useState("");
        const [roster, setRoster] = React.useState("");
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState(undefined);

        const field = (value, onChange, placeholder) =>
          h("input", {
            value: value,
            placeholder: placeholder,
            onChange: (event) => onChange(event.target.value),
            style: {
              width: "100%",
              boxSizing: "border-box",
              marginBottom: "6px",
              padding: "5px 7px",
              background: "#111",
              color: "#eee",
              border: "1px solid #333",
              borderRadius: "5px",
              fontSize: "12px",
            },
          });

        const submit = async () => {
          setBusy(true);
          setError(undefined);
          try {
            const response = await fetch("/api/squad/teams", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ displayName: name, projectFolder: folder, roster: roster }),
            });
            const data = await response.json();
            // The host answers 500 with `{error}`; showing it verbatim is what
            // makes 「项目文件夹要写绝对路径」 reach the person who typed one.
            if (!response.ok) throw new Error(data.error ?? "HTTP " + response.status);
            setName("");
            setFolder("");
            setRoster("");
            props.onCreated();
          } catch (failure) {
            setError(String(failure.message ?? failure));
          } finally {
            setBusy(false);
          }
        };

        return h(
          "div",
          { style: { marginTop: "12px", paddingTop: "10px", borderTop: "1px solid #333" } },
          h("div", { style: { fontWeight: 600, marginBottom: "8px" } }, "建一支团队"),
          field(name, setName, "团队名"),
          field(folder, setFolder, "项目文件夹（绝对路径）"),
          field(roster, setRoster, "甲*=架构, 乙=测试（* 是秘书）"),
          error === undefined ? null : h("div", { style: { color: "#f88", margin: "4px 0" } }, error),
          h(
            "button",
            {
              type: "button",
              disabled: busy,
              onClick: submit,
              style: {
                all: "unset",
                cursor: busy ? "default" : "pointer",
                padding: "5px 12px",
                background: busy ? "#333" : "#2a4",
                color: "#fff",
                borderRadius: "5px",
                fontSize: "12px",
              },
            },
            busy ? "建团中…" : "建团",
          ),
        );
      }

      const seatInput = {
        flex: 1,
        minWidth: 0,
        padding: "2px 6px",
        background: "#111",
        color: "#eee",
        border: "1px solid #333",
        borderRadius: "4px",
        fontSize: "11px",
      };

      /**
       * One team's roster: remove each seat, add one.
       *
       * Configuring, which the route allows — an agent that adds a seat has
       * not decided who speaks. Starting a round stays on the commands.
       */
      function SeatEditor(props) {
        const [name, setName] = React.useState("");
        const [role, setRole] = React.useState("");
        const [error, setError] = React.useState(undefined);

        const call = async (method, body) => {
          setError(undefined);
          try {
            const response = await fetch("/api/squad/seats", {
              method: method,
              headers: { "content-type": "application/json" },
              body: JSON.stringify(Object.assign({ teamId: props.teamId }, body)),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error ?? "HTTP " + response.status);
            props.onChanged();
          } catch (failure) {
            // Shown beside the thing that failed. A roster edit that silently
            // does nothing reads as a UI that ignored the click.
            setError(String(failure.message ?? failure));
          }
        };

        return h(
          "div",
          { style: { marginTop: "6px" } },
          h(
            "div",
            { style: { display: "flex", flexWrap: "wrap", gap: "4px", marginBottom: "4px" } },
            props.seats.map((seat) =>
              h(
                "button",
                {
                  key: seat.seatId,
                  type: "button",
                  title: seat.isSecretary ? "秘书，移除需要确认" : "移除这个席位",
                  onClick: () =>
                    call("DELETE", {
                      seatId: seat.seatId,
                      // The secretary takes meaning it: judgement work would
                      // otherwise keep being requested and land on a default
                      // nobody chose.
                      confirmSecretary: seat.isSecretary
                        ? window.confirm(seat.displayName + " 是秘书，确定移除？")
                        : undefined,
                    }),
                  style: {
                    all: "unset",
                    cursor: "pointer",
                    fontSize: "11px",
                    padding: "2px 6px",
                    borderRadius: "4px",
                    border: "1px solid #444",
                    opacity: 0.85,
                  },
                },
                seat.displayName + " ×",
              ),
            ),
          ),
          // Which connection a seat runs on. "（本机登录）" is the empty
          // value, not a missing one: a seat naming no connection uses the
          // host's own login, which is a real choice rather than an unset
          // field.
          props.connections.length === 0
            ? null
            : h(
                "div",
                { style: { display: "flex", flexWrap: "wrap", gap: "4px", marginBottom: "4px" } },
                props.seats.map((seat) =>
                  h(
                    "select",
                    {
                      key: seat.seatId + "-conn",
                      value: seat.connectionId ?? "",
                      onChange: (event) =>
                        call("PATCH", { seatId: seat.seatId, connectionId: event.target.value }),
                      style: Object.assign({}, seatInput, { flex: "0 1 auto" }),
                    },
                    h("option", { value: "" }, seat.displayName + "：本机登录"),
                    props.connections.map((connection) =>
                      h(
                        "option",
                        { key: connection.connectionId, value: connection.connectionId },
                        seat.displayName + "：" + connection.displayName,
                      ),
                    ),
                  ),
                ),
              ),
          h(
            "div",
            { style: { display: "flex", gap: "4px" } },
            h("input", {
              value: name,
              placeholder: "新席位名",
              onChange: (event) => setName(event.target.value),
              style: seatInput,
            }),
            h("input", {
              value: role,
              placeholder: "角色",
              onChange: (event) => setRole(event.target.value),
              style: seatInput,
            }),
            h(
              "button",
              {
                type: "button",
                onClick: async () => {
                  await call("POST", { displayName: name, role: role });
                  setName("");
                  setRole("");
                },
                style: {
                  all: "unset",
                  cursor: "pointer",
                  fontSize: "11px",
                  padding: "2px 8px",
                  borderRadius: "4px",
                  border: "1px solid #444",
                },
              },
              "+",
            ),
          ),
          error === undefined ? null : h("div", { style: { color: "#f88", marginTop: "4px" } }, error),
        );
      }

      /**
       * The connection library.
       *
       * The API key field is write-only. It posts a value and never receives
       * one — the snapshot carries `credentialConfigured`, a boolean from
       * `describe()`, so the badge can say 「已配置」 without a secret ever
       * reaching this browser. A field that showed the current key would put
       * one here for no reason anybody needs.
       */
      function Connections(props) {
        const [open, setOpen] = React.useState(false);
        const [name, setName] = React.useState("");
        const [mode, setMode] = React.useState("subscription");
        const [model, setModel] = React.useState("");
        const [endpoint, setEndpoint] = React.useState("");
        const [ref, setRef] = React.useState("");
        const [key, setKey] = React.useState("");
        const [error, setError] = React.useState(undefined);

        const call = async (method, body) => {
          setError(undefined);
          try {
            const response = await fetch("/api/squad/connections", {
              method: method,
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error ?? "HTTP " + response.status);
            props.onChanged();
            return true;
          } catch (failure) {
            // Verbatim: the host refuses 「订阅模式不使用自定义端点」 and
            // 「订阅模式下只能用自己的模型」 with reasons, and a generic
            // "save failed" would throw the reason away.
            setError(String(failure.message ?? failure));
            return false;
          }
        };

        const save = async () => {
          const ok = await call("POST", {
            connectionId: "conn-" + Date.now().toString(36),
            displayName: name,
            authMode: mode,
            backend: "claude-code",
            modelId: model === "" ? undefined : model,
            endpoint: mode === "api-key" && endpoint !== "" ? endpoint : undefined,
            credentialRef: mode === "api-key" && ref !== "" ? ref : undefined,
            credential: mode === "api-key" && key !== "" ? key : undefined,
          });
          if (!ok) return;
          setName("");
          setModel("");
          setEndpoint("");
          setRef("");
          setKey("");
        };

        return h(
          "div",
          { style: { marginTop: "12px", paddingTop: "10px", borderTop: "1px solid #333" } },
          h(
            "button",
            {
              type: "button",
              onClick: () => setOpen(!open),
              style: { all: "unset", cursor: "pointer", fontWeight: 600 },
            },
            (open ? "▾ " : "▸ ") + "连接（" + props.connections.length + "）",
          ),
          !open
            ? null
            : h(
                "div",
                { style: { marginTop: "8px" } },
                props.connections.map((connection) =>
                  h(
                    "div",
                    { key: connection.connectionId, style: { marginBottom: "6px", fontSize: "12px" } },
                    h("span", { style: { fontWeight: 600 } }, connection.displayName),
                    h(
                      "span",
                      { style: { opacity: 0.6 } },
                      " · " +
                        (connection.authMode === "subscription" ? "订阅" : "API key") +
                        (connection.modelId ? " · " + connection.modelId : "") +
                        (connection.authMode === "api-key"
                          ? connection.credentialConfigured
                            ? " · 密钥已配置"
                            : " · ⚠️ 密钥未配置"
                          : ""),
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        onClick: () => call("DELETE", { connectionId: connection.connectionId }),
                        style: { all: "unset", cursor: "pointer", marginLeft: "6px", opacity: 0.6 },
                      },
                      "×",
                    ),
                  ),
                ),
                h("input", { value: name, placeholder: "连接名", onChange: (e) => setName(e.target.value), style: seatInput }),
                h(
                  "select",
                  {
                    value: mode,
                    onChange: (e) => setMode(e.target.value),
                    style: Object.assign({}, seatInput, { marginTop: "4px" }),
                  },
                  h("option", { value: "subscription" }, "订阅（用本机 CLI 登录）"),
                  h("option", { value: "api-key" }, "API key"),
                ),
                h("input", {
                  value: model,
                  placeholder: mode === "subscription" ? "模型（只能是自家的，如 sonnet）" : "模型",
                  onChange: (e) => setModel(e.target.value),
                  style: Object.assign({}, seatInput, { marginTop: "4px" }),
                }),
                // Endpoint and key exist only in api-key mode, because in
                // subscription mode the host REFUSES them — showing fields
                // that will be rejected teaches the wrong thing.
                mode !== "api-key"
                  ? null
                  : h(
                      "div",
                      null,
                      h("input", {
                        value: endpoint,
                        placeholder: "端点（留空用默认）",
                        onChange: (e) => setEndpoint(e.target.value),
                        style: Object.assign({}, seatInput, { marginTop: "4px" }),
                      }),
                      h("input", {
                        value: ref,
                        placeholder: "凭据名，如 MY_GATEWAY_KEY",
                        onChange: (e) => setRef(e.target.value),
                        style: Object.assign({}, seatInput, { marginTop: "4px" }),
                      }),
                      h("input", {
                        value: key,
                        type: "password",
                        placeholder: "API key（只写入，永不回显）",
                        onChange: (e) => setKey(e.target.value),
                        style: Object.assign({}, seatInput, { marginTop: "4px" }),
                      }),
                    ),
                error === undefined ? null : h("div", { style: { color: "#f88", marginTop: "4px" } }, error),
                h(
                  "button",
                  {
                    type: "button",
                    onClick: save,
                    style: {
                      all: "unset",
                      cursor: "pointer",
                      marginTop: "6px",
                      padding: "4px 10px",
                      border: "1px solid #444",
                      borderRadius: "4px",
                      fontSize: "12px",
                    },
                  },
                  "保存连接",
                ),
              ),
        );
      }

      function TeamPanel() {
        const isOpen = useOpen();
        // Bumped after a create so the list refreshes at once instead of
        // waiting out the poll — a team that does not appear reads as a
        // create that failed.
        const [nonce, setNonce] = React.useState(0);
        const snapshot = useSnapshot(isOpen, nonce);
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
                      "还没有团队。到会话里敲 /squad-new 团队名 | 项目文件夹 | 甲*=角色",
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
                          team.seats
                            .map(
                              (seat) =>
                                (seat.running ? "▶ " : "") +
                                seat.displayName +
                                "（" +
                                seat.role +
                                (seat.isSecretary ? " · 秘书" : "") +
                                "）",
                            )
                            .join("、"),
                          h("br", null),
                          team.progress === undefined
                            ? null
                            : h(
                                "span",
                                { style: { color: "#7c7" } },
                                "议程：" +
                                  team.progress.phase +
                                  "（" +
                                  team.progress.phaseIndex +
                                  "/" +
                                  team.progress.phaseCount +
                                  "）",
                                h("br", null),
                              ),
                          "记录 " + team.recorded + " 条 · " + team.projectFolder,
                          h("br", null),
                          usageLine(team.usage),
                        ),
                        h(SeatEditor, {
                          teamId: team.teamId,
                          seats: team.seats,
                          connections: snapshot.data.connections,
                          onChanged: () => setNonce((value) => value + 1),
                        }),
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
          h(Connections, {
            connections: snapshot.loading || snapshot.error !== undefined ? [] : snapshot.data.connections,
            onChanged: () => setNonce((value) => value + 1),
          }),
          h(CreateForm, { onCreated: () => setNonce((value) => value + 1) }),
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
