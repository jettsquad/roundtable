/**
 * agents.tsx — the Agent library.
 *
 * Modelled on 1.x's Agent 库 page, and for its reason: a form on the left, the
 * list on the right, and everything an agent needs in one place. The version
 * before this had no such place at all — adding a seat could set a name and a
 * role, so there was no moment at which you could say what model it ran on.
 *
 * Model, endpoint and key sit on THIS form even though they belong to a
 * connection, because that is the moment a person is thinking about them.
 * What gets stored is still a connection plus a reference to it: the form is
 * a convenience, not a second place where model configuration lives.
 */
import { useState } from "react";
import {
  credentialRefFor,
  defaultPermissionMode,
  meaningfulCaps,
  permissionModesFor,
  overallOf,
  REASONING_EFFORTS,
  type AgentBackend,
  type AgentTemplate,
  type AuthMode,
  type ConnectionView,
  type PermissionMode,
  type ReasoningEffort,
  type SeatCaps,
} from "@squad/shared";
import { api, useAction, type AgentCheckReport } from "./api.ts";
import { numberOrUndefined } from "./number-field.ts";
import styles from "./panel.module.css";

const BACKENDS: readonly { readonly id: AgentBackend; readonly label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "dsh", label: "DeepSeek Harness" },
];

const COLORS = ["#2e7d6b", "#3b6ea5", "#8a5cb8", "#b8783c", "#a8455a", "#4a7c3f"];

interface Draft {
  templateId: string;
  displayName: string;
  role: string;
  systemPrompt: string;
  backend: AgentBackend;
  permissionMode: PermissionMode;
  reasoningEffort: ReasoningEffort | "";
  secretaryCandidate: boolean;
  color: string;
  /** "" means the host's own login. */
  connectionId: string;
  /** Set only when building a new connection from this form. */
  authMode: AuthMode;
  modelId: string;
  endpoint: string;
  /** Only when the key already lives under a name of its own. */
  credentialRef: string;
  useExistingCredential: boolean;
  credential: string;
  maxTurns: string;
  maxTokens: string;
  maxCostUsd: string;
}

const blank = (): Draft => ({
  templateId: `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  displayName: "",
  role: "",
  systemPrompt: "",
  backend: "claude-code",
  permissionMode: defaultPermissionMode("claude-code"),
  reasoningEffort: "",
  secretaryCandidate: false,
  color: COLORS[0] ?? "#2e7d6b",
  connectionId: "",
  authMode: "subscription",
  modelId: "",
  endpoint: "",
  credentialRef: "",
  useExistingCredential: false,
  credential: "",
  maxTurns: "",
  maxTokens: "",
  maxCostUsd: "",
});

/** Load an existing template back into the form. */
function draftOf(template: AgentTemplate): Draft {
  return {
    ...blank(),
    templateId: template.templateId,
    displayName: template.displayName,
    role: template.role,
    systemPrompt: template.systemPrompt,
    backend: template.backend,
    permissionMode: template.permissionMode ?? defaultPermissionMode(template.backend),
    reasoningEffort: template.reasoningEffort ?? "",
    secretaryCandidate: template.secretaryCandidate,
    color: template.color,
    connectionId: template.connectionId ?? "",
    maxTurns: template.caps?.maxTurns === undefined ? "" : String(template.caps.maxTurns),
    maxTokens: template.caps?.maxTokens === undefined ? "" : String(template.caps.maxTokens),
    maxCostUsd: template.caps?.maxCostUsd === undefined ? "" : String(template.caps.maxCostUsd),
  };
}

function capsOf(draft: Draft, mode: AuthMode): SeatCaps | undefined {
  const allowed = new Set(meaningfulCaps(mode));
  const caps: Record<string, number> = {};
  for (const [key, raw] of [
    ["maxTurns", draft.maxTurns],
    ["maxTokens", draft.maxTokens],
    ["maxCostUsd", draft.maxCostUsd],
  ] as const) {
    if (!allowed.has(key)) continue;
    const value = numberOrUndefined(raw);
    if (value !== undefined) caps[key] = value;
  }
  return Object.keys(caps).length === 0 ? undefined : (caps as SeatCaps);
}

interface AgentsPageProps {
  readonly agents: readonly AgentTemplate[];
  readonly connections: readonly ConnectionView[];
  readonly onChanged: () => void;
}

export function AgentsPage({ agents, connections, onChanged }: AgentsPageProps): JSX.Element {
  const [draft, setDraft] = useState<Draft>(blank);
  const [newConnection, setNewConnection] = useState(false);
  /**
   * Per-agent test reports. `"running"` is its own state, not a spinner over
   * a stale report — a person who clicks 测试 on an agent they just edited
   * must not read the previous run's green ticks as this one's.
   */
  const [reports, setReports] = useState<Record<string, AgentCheckReport | "running">>({});
  const { error, run } = useAction(onChanged);
  const set = (patch: Partial<Draft>): void => setDraft({ ...draft, ...patch });

  // The auth mode the caps fields must obey: a chosen connection's own, or
  // the mode being configured right here, or the host login's subscription.
  const mode: AuthMode = newConnection
    ? draft.authMode
    : draft.connectionId === ""
      ? "subscription"
      : (connections.find((c) => c.connectionId === draft.connectionId)?.authMode ?? "subscription");

  const save = async (): Promise<void> => {
    const caps = capsOf(draft, mode);
    const connectionId = newConnection ? `conn-${draft.templateId}` : draft.connectionId;
    const ok = await run(() =>
      api.saveAgent({
        templateId: draft.templateId,
        displayName: draft.displayName.trim(),
        role: draft.role.trim(),
        systemPrompt: draft.systemPrompt.trim(),
        backend: draft.backend,
        secretaryCandidate: draft.secretaryCandidate,
        color: draft.color,
        ...(connectionId === "" ? {} : { connectionId }),
        ...(draft.backend === "dsh" ? {} : { permissionMode: draft.permissionMode }),
        ...(draft.backend === "codex" && draft.reasoningEffort !== ""
          ? { reasoningEffort: draft.reasoningEffort }
          : {}),
        ...(caps === undefined ? {} : { caps }),
        ...(newConnection
          ? {
              connection: {
                connectionId,
                displayName: `${draft.displayName.trim() || "未命名"} 的连接`,
                authMode: draft.authMode,
                backend: draft.backend,
                ...(draft.modelId.trim() === "" ? {} : { modelId: draft.modelId.trim() }),
                ...(draft.authMode === "api-key" && draft.endpoint.trim() !== ""
                  ? { endpoint: draft.endpoint.trim() }
                  : {}),
                // Derived unless the person named an existing secret; see
                // `credentialRefFor`. Nobody should be asked to invent an
                // environment-variable name in order to paste a key.
                ...(draft.authMode !== "api-key"
                  ? {}
                  : {
                      credentialRef:
                        draft.useExistingCredential && draft.credentialRef.trim() !== ""
                          ? draft.credentialRef.trim()
                          : credentialRefFor(connectionId),
                    }),
                ...(draft.authMode === "api-key" && !draft.useExistingCredential && draft.credential !== ""
                  ? { credential: draft.credential }
                  : {}),
              },
            }
          : {}),
      }),
    );
    if (!ok) return;
    setDraft(blank());
    setNewConnection(false);
  };

  return (
    <div className={styles.twoColumn}>
      <div className={styles.column}>
        <div className={styles.subhead}>
          {agents.some((a) => a.templateId === draft.templateId) ? "编辑" : "新建"} Agent
        </div>

        <div className={styles.row}>
          <input
            className={styles.field}
            value={draft.displayName}
            placeholder="Agent 名字，如 架构"
            onChange={(event) => set({ displayName: event.target.value })}
          />
          <input
            className={styles.field}
            value={draft.role}
            placeholder="角色，如 系统设计"
            onChange={(event) => set({ role: event.target.value })}
          />
        </div>

        <textarea
          className={styles.textarea}
          value={draft.systemPrompt}
          rows={3}
          placeholder="提示词——这个 agent 每一轮唯一读到的常驻说明"
          onChange={(event) => set({ systemPrompt: event.target.value })}
        />

        <div className={styles.row}>
          <select
            className={styles.field}
            value={draft.backend}
            onChange={(event) => {
              const backend = event.target.value as AgentBackend;
              // The mode list changes with the backend, so the held value has
              // to change with it — otherwise the form quietly carries
              // `plan` into a Codex agent and the CLI is the one that
              // complains, one round later.
              // The chosen connection is dropped if it belonged to the old
              // backend: keeping it would carry a pairing the host refuses,
              // and the refusal would arrive at save time pointing at a field
              // the person did not touch.
              const keep = connections.find((c) => c.connectionId === draft.connectionId)?.backend === backend;
              set({
                backend,
                permissionMode: defaultPermissionMode(backend),
                reasoningEffort: "",
                ...(keep ? {} : { connectionId: "" }),
              });
            }}
          >
            {BACKENDS.map((backend) => (
              <option key={backend.id} value={backend.id}>
                {backend.label}
              </option>
            ))}
          </select>
          {draft.backend === "dsh" ? null : (
            <select
              className={styles.field}
              value={draft.permissionMode}
              onChange={(event) => set({ permissionMode: event.target.value as PermissionMode })}
            >
              {permissionModesFor(draft.backend).map((permissionMode) => (
                <option key={permissionMode} value={permissionMode}>
                  权限：{permissionMode}
                </option>
              ))}
            </select>
          )}
          {draft.backend !== "codex" ? null : (
            <select
              className={styles.field}
              value={draft.reasoningEffort}
              onChange={(event) => set({ reasoningEffort: event.target.value as ReasoningEffort | "" })}
            >
              <option value="">推理档位：默认</option>
              {REASONING_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  推理档位：{effort}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className={styles.subhead}>模型</div>
        <div className={styles.row}>
          <select
            className={styles.field}
            value={newConnection ? "__new__" : draft.connectionId}
            onChange={(event) => {
              if (event.target.value === "__new__") setNewConnection(true);
              else {
                setNewConnection(false);
                set({ connectionId: event.target.value });
              }
            }}
          >
            <option value="">本机登录（用宿主 CLI 的登录态和默认模型）</option>
            {/* Only this backend's connections. A provider is registered under
                the CONNECTION's backend, so a codex agent on a claude-code
                connection asks for a name that does not exist — and the two
                read different environment variables anyway. The host refuses
                the pairing; not offering it is what stops someone building
                it. */}
            {connections
              .filter((connection) => connection.backend === draft.backend)
              .map((connection) => (
                <option key={connection.connectionId} value={connection.connectionId}>
                  {connection.displayName}
                  {connection.modelId === undefined ? "" : ` · ${connection.modelId}`}
                </option>
              ))}
            <option value="__new__">＋ 新建一个连接…</option>
          </select>
        </div>

        {!newConnection ? null : (
          <div>
            <div className={styles.row}>
              <select
                className={styles.field}
                value={draft.authMode}
                onChange={(event) => set({ authMode: event.target.value as AuthMode })}
              >
                <option value="subscription">订阅（用本机 CLI 的登录态）</option>
                <option value="api-key">API key</option>
              </select>
              <input
                className={styles.field}
                value={draft.modelId}
                placeholder={draft.authMode === "subscription" ? "模型（只能是自家的，如 sonnet）" : "模型"}
                onChange={(event) => set({ modelId: event.target.value })}
              />
            </div>
            {draft.authMode !== "api-key" ? null : (
              <div>
                <div className={styles.row}>
                  <input
                    className={styles.field}
                    value={draft.endpoint}
                    placeholder="接口地址（留空用默认）"
                    onChange={(event) => set({ endpoint: event.target.value })}
                  />
                  {draft.useExistingCredential ? (
                    <input
                      className={styles.field}
                      value={draft.credentialRef}
                      placeholder="环境变量名，如 DEEPSEEK_API_KEY"
                      onChange={(event) => set({ credentialRef: event.target.value })}
                    />
                  ) : (
                    <input
                      className={styles.field}
                      type="password"
                      value={draft.credential}
                      placeholder="API key（只写入，永不回显）"
                      onChange={(event) => set({ credential: event.target.value })}
                    />
                  )}
                </div>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={draft.useExistingCredential}
                    onChange={(event) => set({ useExistingCredential: event.target.checked })}
                  />
                  这把 key 已经在环境变量里了
                </label>
              </div>
            )}
          </div>
        )}

        <div className={styles.subhead}>上限</div>
        <div className={styles.row}>
          <input
            className={`${styles.field} ${styles.narrow}`}
            value={draft.maxTurns}
            placeholder="轮数上限"
            onChange={(event) => set({ maxTurns: event.target.value })}
          />
          <input
            className={`${styles.field} ${styles.narrow}`}
            value={draft.maxTokens}
            placeholder="token 上限"
            onChange={(event) => set({ maxTokens: event.target.value })}
          />
          {/* Absent, not disabled: a greyed-out box still reads as "a thing
              this agent has". A subscription bills nothing, so this ceiling
              could never fire. */}
          {!meaningfulCaps(mode).includes("maxCostUsd") ? null : (
            <input
              className={`${styles.field} ${styles.narrow}`}
              value={draft.maxCostUsd}
              placeholder="花费上限 $"
              onChange={(event) => set({ maxCostUsd: event.target.value })}
            />
          )}
        </div>
        {meaningfulCaps(mode).includes("maxCostUsd") ? null : (
          <div className={styles.hint}>订阅模式不计费，所以没有花费上限。</div>
        )}

        <div className={styles.row}>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={draft.secretaryCandidate}
              onChange={(event) => set({ secretaryCandidate: event.target.checked })}
            />
            可以当秘书
          </label>
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              title="标色"
              className={`${styles.swatch} ${draft.color === color ? styles.swatchOn : ""}`}
              style={{ background: color }}
              onClick={() => set({ color })}
            />
          ))}
        </div>

        {error === undefined ? null : <div className={styles.error}>{error}</div>}
        <div className={styles.row}>
          <button type="button" className={styles.button} onClick={() => void save()}>
            保存 Agent
          </button>
          <button type="button" className={styles.button} onClick={() => setDraft(blank())}>
            清空
          </button>
        </div>
      </div>

      <div className={styles.column}>
        <div className={styles.subhead}>已有 Agent（{agents.length}）</div>
        {agents.length === 0 ? <div className={styles.hint}>还没有。左边配一个，之后每支团队都能直接选它。</div> : null}
        {agents.map((agent) => (
          <div key={agent.templateId} className={styles.card}>
            <div className={styles.row}>
              <span className={styles.dot} style={{ background: agent.color }} />
              <span className={styles.teamName}>{agent.displayName}</span>
              <span className={styles.muted}>{agent.role}</span>
              {agent.secretaryCandidate ? <span className={styles.muted}>★ 可当秘书</span> : null}
            </div>
            <div className={styles.muted}>
              {agent.backend}
              {agent.permissionMode === undefined ? "" : ` · ${agent.permissionMode}`}
              {" · "}
              {agent.connectionId === undefined
                ? "本机登录"
                : (connections.find((c) => c.connectionId === agent.connectionId)?.displayName ?? "⚠️ 连接已删除")}
            </div>
            {(() => {
              const report = reports[agent.templateId];
              if (report === undefined) return null;
              if (report === "running") return <div className={styles.hint}>测试中……</div>;
              const overall = overallOf(report);
              return (
                <div className={styles.report}>
                  <div className={overall === "fail" ? styles.error : styles.muted}>
                    {overall === "ok" ? "✅ 能用" : overall === "fail" ? "❌ 有问题" : "⚠️ 有检查没能跑，结论不完整"}
                  </div>
                  {report.checks.map((check) => (
                    <div key={check.name} className={check.outcome === "fail" ? styles.error : styles.muted}>
                      {/* 「—」是不适用，「?」是想查没查成。两者读起来必须不一样：
                          前者是答案，后者是缺口。 */}
                      {check.outcome === "ok"
                        ? "✅"
                        : check.outcome === "fail"
                          ? "❌"
                          : check.outcome === "unknown"
                            ? "❓"
                            : "—"}{" "}
                      {check.name}：{check.detail}
                    </div>
                  ))}
                </div>
              );
            })()}
            <div className={styles.row}>
              <button type="button" className={styles.button} onClick={() => setDraft(draftOf(agent))}>
                编辑
              </button>
              <button
                type="button"
                className={styles.button}
                onClick={() => {
                  setReports((current) => ({ ...current, [agent.templateId]: "running" }));
                  void api
                    .testAgent({ templateId: agent.templateId })
                    .then((report) => setReports((current) => ({ ...current, [agent.templateId]: report })))
                    .catch((failure: Error) =>
                      setReports((current) => ({
                        ...current,
                        [agent.templateId]: {
                          templateId: agent.templateId,
                          displayName: agent.displayName,
                          checks: [{ name: "测试", outcome: "fail", detail: String(failure.message) }],
                        },
                      })),
                    );
                }}
              >
                测试
              </button>
              <button
                type="button"
                className={styles.button}
                onClick={() => void run(() => api.removeAgent({ templateId: agent.templateId }))}
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
