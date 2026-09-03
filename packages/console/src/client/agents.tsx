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
import { useEffect, useState } from "react";
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
import { MoveButtons, SearchBox, matches } from "./order-controls.tsx";
import { MINIMAX_VOICES, defaultVoiceFor, voiceLabel, voicesFor, voicesOf } from "@squad/shared";
import { speech } from "./speech.ts";
import { useT } from "./locale.ts";
import styles from "./panel.module.css";

const BACKENDS: readonly { readonly id: AgentBackend; readonly label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "dsh", label: "DeepSeek Harness" },
];

/**
 * The colours a seat can wear.
 *
 * Ten, because six ran out — a team of seven had two members sharing a
 * colour, which is worse than no colour at all: the pill is what tells you
 * who spoke, and two identical pills say the wrong thing rather than nothing.
 *
 * Chosen to stay apart at pill size on a dark ground: no two neighbours in
 * hue, and the two blues and two greens are separated by lightness as well as
 * hue so they do not read the same in a thumbnail.
 */
const COLORS = [
  "#2e7d6b", // teal
  "#3b6ea5", // steel blue
  "#8a5cb8", // violet
  "#b8783c", // amber
  "#a8455a", // crimson
  "#4a7c3f", // moss
  "#2f8fa8", // cyan
  "#9c6b2f", // bronze
  "#6a5acd", // indigo
  "#b05a8f", // magenta
];

interface Draft {
  templateId: string;
  displayName: string;
  role: string;
  systemPrompt: string;
  backend: AgentBackend;
  permissionMode: PermissionMode;
  reasoningEffort: ReasoningEffort | "";
  secretaryCandidate: boolean;
  webAccess: boolean;
  color: string;
  voiceId: string;
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
  webAccess: false,
  color: COLORS[0] ?? "#2e7d6b",
  voiceId: "",
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
    webAccess: template.webAccess === true,
    color: template.color,
    voiceId: template.voiceId ?? "",
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
  const t = useT();
  const [draft, setDraft] = useState<Draft>(blank);
  const [newConnection, setNewConnection] = useState(false);
  /**
   * Per-agent test reports. `"running"` is its own state, not a spinner over
   * a stale report — a person who clicks 测试 on an agent they just edited
   * must not read the previous run's green ticks as this one's.
   */
  const [reports, setReports] = useState<Record<string, AgentCheckReport | "running">>({});
  const [query, setQuery] = useState("");
  // Searched over the prompt too: 「哪个 agent 里写了红队」 is a real way to
  // look for one, and the name alone often does not say.
  const shown = agents.filter((agent) =>
    matches(query, agent.displayName, agent.role, agent.backend, agent.systemPrompt, agent.templateId),
  );
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
        webAccess: draft.webAccess,
        color: draft.color,
        // Trimmed, and an all-whitespace value counts as unset: the picker
        // uses a single space as its 「自己填一个」 sentinel, and saving that
        // as a voice id would send a space to MiniMax on the first round.
        ...(draft.voiceId.trim() === "" ? {} : { voiceId: draft.voiceId.trim() }),
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
                displayName: t("agent.connectionFor", { name: draft.displayName.trim() || t("agent.unnamed") }),
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
      <div className={`${styles.column} ${styles.columnSticky}`}>
        <div className={styles.subhead}>
          {t("agent.formHead", {
            verb: agents.some((a) => a.templateId === draft.templateId) ? t("agent.edit") : t("agent.new"),
          })}
        </div>

        <div className={styles.row}>
          <input
            className={styles.field}
            value={draft.displayName}
            placeholder={t("agent.name.placeholder")}
            onChange={(event) => set({ displayName: event.target.value })}
          />
          <input
            className={styles.field}
            value={draft.role}
            placeholder={t("agent.role.placeholder")}
            onChange={(event) => set({ role: event.target.value })}
          />
        </div>

        <textarea
          className={styles.textarea}
          value={draft.systemPrompt}
          rows={3}
          placeholder={t("agent.prompt.placeholder")}
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
                  {t("agent.permission", { mode: permissionMode })}
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
              <option value="">{t("agent.effort.default")}</option>
              {REASONING_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {t("agent.effort", { effort })}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className={styles.subhead}>{t("agent.model")}</div>
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
            <option value="">{t("agent.localLogin")}</option>
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
            <option value="__new__">{t("agent.newConnection")}</option>
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
                <option value="subscription">{t("conn.mode.subscription")}</option>
                <option value="api-key">API key</option>
              </select>
              <input
                className={styles.field}
                value={draft.modelId}
                placeholder={draft.authMode === "subscription" ? t("agent.model.own") : t("conn.model.any")}
                onChange={(event) => set({ modelId: event.target.value })}
              />
            </div>
            {draft.authMode !== "api-key" ? null : (
              <div>
                <div className={styles.row}>
                  <input
                    className={styles.field}
                    value={draft.endpoint}
                    placeholder={t("conn.baseUrl.placeholder")}
                    onChange={(event) => set({ endpoint: event.target.value })}
                  />
                  {draft.useExistingCredential ? (
                    <input
                      className={styles.field}
                      value={draft.credentialRef}
                      placeholder={t("conn.envName.placeholder")}
                      onChange={(event) => set({ credentialRef: event.target.value })}
                    />
                  ) : (
                    <input
                      className={styles.field}
                      type="password"
                      value={draft.credential}
                      placeholder={t("conn.key.placeholder")}
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
                  {t("conn.key.inEnv")}
                </label>
              </div>
            )}
          </div>
        )}

        <div className={styles.subhead}>{t("agent.caps")}</div>
        <div className={styles.row}>
          <input
            className={`${styles.field} ${styles.narrow}`}
            value={draft.maxTurns}
            placeholder={t("caps.maxTurns")}
            onChange={(event) => set({ maxTurns: event.target.value })}
          />
          <input
            className={`${styles.field} ${styles.narrow}`}
            value={draft.maxTokens}
            placeholder={t("caps.maxTokens")}
            onChange={(event) => set({ maxTokens: event.target.value })}
          />
          {/* Absent, not disabled: a greyed-out box still reads as "a thing
              this agent has". A subscription bills nothing, so this ceiling
              could never fire. */}
          {!meaningfulCaps(mode).includes("maxCostUsd") ? null : (
            <input
              className={`${styles.field} ${styles.narrow}`}
              value={draft.maxCostUsd}
              placeholder={t("caps.maxCostUsd")}
              onChange={(event) => set({ maxCostUsd: event.target.value })}
            />
          )}
        </div>
        {meaningfulCaps(mode).includes("maxCostUsd") ? null : (
          <div className={styles.hint}>{t("caps.subscription")}</div>
        )}

        <div className={styles.row}>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={draft.secretaryCandidate}
              onChange={(event) => set({ secretaryCandidate: event.target.checked })}
            />
            {t("agent.canSecretary")}
          </label>
          {/* What this backend can actually do about the web, said where the
              choice is made. Every seat gets this in its prompt automatically
              — injected at turn time rather than written into the standing
              instructions, so switching the backend cannot leave a sentence
              behind that is quietly no longer true. */}
          <div className={styles.hint}>
            {draft.backend === "dsh"
              ? t("agent.web.codeBash")
              : draft.backend === "codex"
                ? t("agent.web.sandboxed")
                : draft.webAccess
                  ? t("agent.web.fetch")
                  : t("agent.web.off")}
          </div>

          {/* Only for Claude Code, and that is a fact about the backends
              rather than a gap. Measured on all three: `acceptEdits` there
              auto-approves file edits and nothing else, so WebFetch and even
              `curl` come back 「requires approval」 — with nobody to approve,
              in a headless run. dsh reaches the web through bash already, and
              codex's workspace mode has its own web tool. */}
          {draft.backend !== "claude-code" ? null : (
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={draft.webAccess}
                onChange={(event) => set({ webAccess: event.target.checked })}
              />
              {t("agent.allowWeb")}
            </label>
          )}
          {/* Beside the colour, because it is the same kind of thing: how you
              tell this member from the others. The default is derived from
              the name, so a roster is followable by ear before anyone
              configures anything — this is for when two seats collide, or
              when a voice simply does not suit the role. */}
          <div className={styles.subhead}>{t("agent.voice")}</div>
          <div className={styles.row}>
            {/* A list AND a box. The list is every system voice; the box is
                for the ones no list can have — a voice you cloned, whose id
                you chose yourself, or a MiniMax voice added after this build.
                The id is passed through untouched all the way to synthesis,
                so anything MiniMax accepts works here; a list-only control
                would be the one thing standing between the two. */}
            <select
              className={styles.field}
              value={known.has(draft.voiceId) || draft.voiceId === "" ? draft.voiceId : CUSTOM}
              onChange={(event) => set({ voiceId: event.target.value === CUSTOM ? " " : event.target.value })}
            >
              <option value="">
                {t("agent.voice.auto", { voice: voiceLabel(defaultVoiceFor(draft.displayName || t("agent.unnamed"))) })}
              </option>
              {/* Grouped by language rather than listed flat: a seat that
                  writes English is picked from a list where every second
                  entry would otherwise be unusable for it. Nothing is
                  filtered out — MiniMax will read either language in either
                  voice, it just sounds wrong. */}
              {/* Grouped, because fifty in one flat list is a list nobody
                  reads to the end. Nothing is hidden — MiniMax will read
                  either language in any of these — the groups only put the
                  ones a working roster wants where they are found first. */}
              {(
                [
                  [t("agent.voice.zh"), "zh", "plain"],
                  [t("agent.voice.zhCharacter"), "zh", "character"],
                  ["English", "en", "plain"],
                  ["English · character", "en", "character"],
                ] as const
              ).map(([label, language, kind]) => {
                const voices = voicesOf(language, kind);
                return voices.length === 0 ? null : (
                  <optgroup key={label} label={label}>
                    {voices.map((voice) => (
                      <option key={voice.voiceId} value={voice.voiceId}>
                        {voice.label}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
              <option value={CUSTOM}>{t("agent.voice.custom")}</option>
            </select>
            <VoicePreview
              voiceId={
                draft.voiceId.trim() === ""
                  ? defaultVoiceFor(draft.displayName || t("agent.unnamed"))
                  : draft.voiceId.trim()
              }
              name={draft.displayName === "" ? t("agent.voice.thisSeat") : draft.displayName}
            />
          </div>
          {known.has(draft.voiceId) || draft.voiceId === "" ? null : (
            <>
              <input
                className={styles.field}
                placeholder={t("agent.voice.custom.placeholder")}
                value={draft.voiceId.trim()}
                onChange={(event) => set({ voiceId: event.target.value })}
              />
              <div className={styles.hint}>{t("agent.voice.custom.hint")}</div>
            </>
          )}
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              title={t("agent.color.title")}
              className={`${styles.swatch} ${draft.color === color ? styles.swatchOn : ""}`}
              style={{ background: color }}
              onClick={() => set({ color })}
            />
          ))}
        </div>

        {error === undefined ? null : <div className={styles.error}>{error}</div>}
        <div className={styles.row}>
          <button type="button" className={styles.button} onClick={() => void save()}>
            {t("agent.save")}
          </button>
          <button type="button" className={styles.button} onClick={() => setDraft(blank())}>
            {t("agent.clear")}
          </button>
        </div>
      </div>

      <div className={styles.column}>
        <div className={styles.subhead}>
          {t("agent.list.head", { n: query.trim() === "" ? agents.length : `${shown.length} / ${agents.length}` })}
        </div>
        <SearchBox value={query} onChange={setQuery} placeholder={t("agent.search.placeholder")} />
        {agents.length === 0 ? <div className={styles.hint}>{t("agent.list.none")}</div> : null}
        {agents.length > 0 && shown.length === 0 ? (
          <div className={styles.hint}>{t("agent.list.noMatch", { query })}</div>
        ) : null}
        {shown.map((agent) => (
          <div key={agent.templateId} className={styles.card}>
            <div className={styles.row}>
              <span className={styles.dot} style={{ background: agent.color }} />
              <span className={styles.teamName}>{agent.displayName}</span>
              <span className={styles.muted}>{agent.role}</span>
              {agent.secretaryCandidate ? <span className={styles.muted}>{t("agent.secretaryBadge")}</span> : null}
              {/* Hidden while filtering: the arrows move a row one place in the
                  REAL list, and next to a filtered view they would appear to
                  do nothing — the neighbour they swap with is not on screen. */}
              {query.trim() !== "" ? null : (
                <MoveButtons
                  index={agents.indexOf(agent)}
                  count={agents.length}
                  label={agent.displayName}
                  onMove={(delta) => api.moveAgent({ templateId: agent.templateId, delta }).then(onChanged)}
                />
              )}
            </div>
            <div className={styles.muted}>
              {agent.backend}
              {agent.permissionMode === undefined ? "" : ` · ${agent.permissionMode}`}
              {" · "}
              {agent.connectionId === undefined
                ? t("agent.localLogin")
                : (connections.find((c) => c.connectionId === agent.connectionId)?.displayName ??
                  t("agent.connection.gone"))}
            </div>
            {(() => {
              const report = reports[agent.templateId];
              if (report === undefined) return null;
              if (report === "running") return <div className={styles.hint}>{t("agent.test.running")}</div>;
              const overall = overallOf(report);
              return (
                <div className={styles.report}>
                  <div className={overall === "fail" ? styles.error : styles.muted}>
                    {overall === "ok"
                      ? t("agent.test.ok")
                      : overall === "fail"
                        ? t("agent.test.fail")
                        : t("agent.test.partial")}
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
                {t("agent.edit")}
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
                          checks: [{ name: t("agent.test"), outcome: "fail", detail: String(failure.message) }],
                        },
                      })),
                    );
                }}
              >
                {t("agent.test")}
              </button>
              <button
                type="button"
                className={styles.button}
                onClick={() => void run(() => api.removeAgent({ templateId: agent.templateId }))}
              >
                {t("agent.delete")}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Hear a voice before assigning it.
 *
 * Picking from a list of names — 「温润男声」, 「阅历姐姐」 — is picking
 * blind: the labels describe a register, not a sound, and two of them can be
 * near-identical in a way no word conveys. One sentence is enough to know,
 * and it costs a fraction of one reply's worth of quota.
 */
/** The sentinel the picker uses to mean 「不在这张单子上」. A space, so it is
 *  not empty (empty means 「自动分配」) and cannot collide with a real id. */
const CUSTOM = " ";

/** Every id the list offers, for telling a listed voice from a typed one. */
const known = new Set(MINIMAX_VOICES.map((voice) => voice.voiceId));

/** English voices whose id does not start with `English`. */
const ENGLISH_ONLY = new Set(voicesFor("en").map((voice) => voice.voiceId));

function VoicePreview({ voiceId, name }: { readonly voiceId: string; readonly name: string }): JSX.Element {
  const t = useT();
  const [state, setState] = useState(speech.state());
  useEffect(() => speech.subscribe(setState), []);
  const playing = state.turnId === `preview-${voiceId}`;
  return (
    <button
      type="button"
      className={styles.button}
      disabled={!speech.ready}
      title={speech.ready ? t("agent.preview.ready") : t("agent.preview.blocked")}
      onClick={() =>
        void speech.play({
          turnId: `preview-${voiceId}`,
          speaker: name,
          text:
            voiceId.startsWith("English") || ENGLISH_ONLY.has(voiceId)
              ? "This is my voice. I will sound like this whenever I speak."
              : t("agent.preview.line"),
          voiceId,
        })
      }
    >
      {playing ? t("agent.preview.stop") : t("agent.preview.play")}
    </button>
  );
}
