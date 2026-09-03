/**
 * connections.tsx — the connection library.
 *
 * The API key field is write-only. It posts a value and never receives one:
 * the snapshot carries `credentialConfigured`, the boolean `describe()`
 * answers, so the badge can say 「已配置」 without a secret ever reaching this
 * browser. A field that showed the current key would put one here that
 * nothing here needs.
 *
 * Endpoint and key appear only under api-key mode, because under
 * subscription the host REFUSES both — 「订阅模式不使用自定义端点」. Showing a
 * field whose value will be rejected teaches that the form is unreliable.
 */
import { useState } from "react";
import {
  credentialRefFor,
  isOwnModel,
  type AuthMode,
  type ConnectionBackend,
  type SeatConnection,
} from "@squad/shared";
import type { PanelConnection } from "../wire.ts";
import { api, useAction } from "./api.ts";
import { useT } from "./locale.ts";
import styles from "./panel.module.css";

interface ConnectionsProps {
  readonly connections: readonly PanelConnection[];
  readonly onChanged: () => void;
}

export function Connections({ connections, onChanged }: ConnectionsProps): JSX.Element {
  const t = useT();
  /**
   * The connection being edited, or `undefined` for a new one.
   *
   * The list was read-only apart from delete, so fixing a typo in an endpoint
   * meant deleting the connection — which orphans every agent pointing at it
   * — and building it again under a new id. Editing keeps the id, so the
   * agents stay attached.
   */
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<AuthMode>("subscription");
  const [backend, setBackend] = useState<ConnectionBackend>("claude-code");
  const [model, setModel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [credentialRef, setCredentialRef] = useState("");
  const [key, setKey] = useState("");
  /**
   * Whether the secret already lives under a name of its own.
   *
   * Off is the ordinary case: you have a key, you paste it, and the name it
   * gets filed under is derived. On is the two cases where the name is the
   * point — the key is already an environment variable, or several
   * connections share one.
   */
  const [existing, setExisting] = useState(false);
  const { error, run } = useAction(onChanged);

  /** Load an existing connection into the form. Never its key: there is none to load. */
  const edit = (connection: PanelConnection): void => {
    setEditing(connection.connectionId);
    setName(connection.displayName);
    setBackend(connection.backend);
    setMode(connection.authMode);
    setModel(connection.modelId ?? "");
    setEndpoint(connection.endpoint ?? "");
    setCredentialRef(connection.credentialRef ?? "");
    // The key box starts empty on an edit, and an empty key box means "leave
    // the stored one alone". Prefilling it is impossible — the value never
    // comes to the browser — and showing a masked placeholder would suggest
    // it could be read back.
    setKey("");
    setExisting(false);
  };

  const clear = (): void => {
    setEditing(undefined);
    setName("");
    setModel("");
    setBackend("claude-code");
    setEndpoint("");
    setCredentialRef("");
    setKey("");
    setExisting(false);
  };

  const save = async (): Promise<void> => {
    // Keeping the id on an edit is what keeps every agent pointing at this
    // connection pointing at it afterwards.
    const connectionId = editing ?? `conn-${Date.now().toString(36)}`;
    const connection: SeatConnection & { credential?: string } = {
      connectionId,
      displayName: name,
      authMode: mode,
      backend,
      ...(model.trim() === "" ? {} : { modelId: model.trim() }),
      ...(mode === "api-key" && endpoint.trim() !== "" ? { endpoint: endpoint.trim() } : {}),
      // Derived unless the person named an existing secret. A reference is an
      // environment-variable name, and asking someone to invent one is asking
      // the wrong question: they have a key, and the filing is the system's
      // job.
      ...(mode !== "api-key"
        ? {}
        : {
            credentialRef:
              existing && credentialRef.trim() !== "" ? credentialRef.trim() : credentialRefFor(connectionId),
          }),
      ...(mode === "api-key" && !existing && key !== "" ? { credential: key } : {}),
    };
    if (!(await run(() => api.saveConnection(connection)))) return;
    clear();
  };

  return (
    <div>
      <div className={styles.hint}>{t("conn.intro")}</div>
      <div>
        {connections.map((connection) => (
          <div key={connection.connectionId} className={styles.row}>
            <span>{connection.displayName}</span>
            <span className={styles.muted}>
              {connection.backend} ·{" "}
              {connection.authMode === "subscription" ? t("conn.auth.subscription") : t("conn.auth.apiKey")}
              {connection.modelId === undefined ? "" : ` · ${connection.modelId}`}
            </span>
            {/* Honest about what is actually built. A connection on a backend
                with no seat plugin saves, renders, and then fails at the first
                round with a provider name nobody typed. */}
            {connection.providerReady ? null : <span className={styles.badgeBad}>{t("conn.unclaimed")}</span>}
            <button type="button" className={styles.button} onClick={() => edit(connection)}>
              {t("conn.edit")}
            </button>
            {connection.authMode !== "api-key" ? null : connection.credentialConfigured ? (
              <span className={styles.muted}>{t("conn.secret.set")}</span>
            ) : connection.credentialWritable ? (
              <span className={styles.badgeBad}>{t("conn.secret.unset")}</span>
            ) : (
              // `set` refuses while a read-only source shadows the name, so
              // this connection cannot be fixed from here at all — and
              // without saying so, the key box would silently keep failing.
              <span className={styles.badgeBad}>{t("conn.secret.readonly", { name: connection.credentialRef })}</span>
            )}
            <button
              type="button"
              className={styles.drop}
              title={t("conn.delete.title")}
              onClick={() => void run(() => api.removeConnection({ connectionId: connection.connectionId }))}
            >
              ×
            </button>
          </div>
        ))}

        <div className={styles.row}>
          <input
            className={styles.field}
            value={name}
            placeholder={t("conn.name.placeholder")}
            onChange={(event) => setName(event.target.value)}
          />
          <select
            className={styles.field}
            value={backend}
            onChange={(event) => setBackend(event.target.value as ConnectionBackend)}
          >
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex（ChatGPT / OpenAI）</option>
            <option value="dsh">DeepSeek Harness</option>
          </select>
          <select className={styles.field} value={mode} onChange={(event) => setMode(event.target.value as AuthMode)}>
            <option value="subscription">{t("conn.mode.subscription")}</option>
            <option value="api-key">API key</option>
          </select>
          <input
            className={styles.field}
            value={model}
            placeholder={mode === "subscription" ? t("conn.model.own", { backend }) : t("conn.model.any")}
            onChange={(event) => setModel(event.target.value)}
          />
        </div>

        {mode !== "api-key" ? null : (
          <div>
            <div className={styles.row}>
              <input
                className={styles.field}
                value={endpoint}
                placeholder={t("conn.baseUrl.placeholder")}
                onChange={(event) => setEndpoint(event.target.value)}
              />
              {existing ? (
                <input
                  className={styles.field}
                  value={credentialRef}
                  placeholder={t("conn.envName.placeholder")}
                  onChange={(event) => setCredentialRef(event.target.value)}
                />
              ) : (
                <input
                  className={styles.field}
                  type="password"
                  value={key}
                  placeholder={t("conn.key.placeholder")}
                  onChange={(event) => setKey(event.target.value)}
                />
              )}
            </div>
            <label className={styles.check}>
              <input type="checkbox" checked={existing} onChange={(event) => setExisting(event.target.checked)} />
              {t("conn.key.inEnv")}
            </label>
            <div className={styles.hint}>{existing ? t("conn.key.hint.env") : t("conn.key.hint.stored")}</div>
          </div>
        )}

        {/* Said before the save rather than after: the host refuses a foreign
            model on a subscription, and that reason is one a person can act
            on only while the field is still in front of them. */}
        {mode !== "subscription" || model.trim() === "" || isOwnModel(backend, model.trim()) ? null : (
          <div className={styles.hint}>{t("conn.model.mismatch", { model: model.trim(), backend })}</div>
        )}
        {error === undefined ? null : <div className={styles.error}>{error}</div>}
        <div className={styles.row}>
          <button type="button" className={styles.button} onClick={() => void save()}>
            {editing === undefined ? t("conn.create") : t("conn.saveEdit")}
          </button>
          {editing === undefined ? null : (
            <button type="button" className={styles.button} onClick={clear}>
              {t("conn.cancelEdit")}
            </button>
          )}
          {editing === undefined ? null : <span className={styles.hint}>{t("conn.key.keepHint")}</span>}
        </div>
      </div>
    </div>
  );
}
