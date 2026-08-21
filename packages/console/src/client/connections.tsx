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
import { type AuthMode, type ConnectionView, type SeatConnection } from "@squad/shared";
import { api } from "./api.ts";
import styles from "./panel.module.css";

interface ConnectionsProps {
  readonly connections: readonly ConnectionView[];
  readonly onChanged: () => void;
}

export function Connections({ connections, onChanged }: ConnectionsProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<AuthMode>("subscription");
  const [model, setModel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [credentialRef, setCredentialRef] = useState("");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    setError(undefined);
    try {
      await work();
      onChanged();
      return true;
    } catch (failure) {
      setError(String((failure as Error).message ?? failure));
      return false;
    }
  };

  const save = async (): Promise<void> => {
    const connection: SeatConnection & { credential?: string } = {
      connectionId: `conn-${Date.now().toString(36)}`,
      displayName: name,
      authMode: mode,
      backend: "claude-code",
      ...(model.trim() === "" ? {} : { modelId: model.trim() }),
      ...(mode === "api-key" && endpoint.trim() !== "" ? { endpoint: endpoint.trim() } : {}),
      ...(mode === "api-key" && credentialRef.trim() !== "" ? { credentialRef: credentialRef.trim() } : {}),
      ...(mode === "api-key" && key !== "" ? { credential: key } : {}),
    };
    if (!(await run(() => api.saveConnection(connection)))) return;
    setName("");
    setModel("");
    setEndpoint("");
    setCredentialRef("");
    setKey("");
  };

  return (
    <div className={styles.section}>
      <button type="button" className={styles.sectionToggle} onClick={() => setOpen(!open)}>
        {open ? "▾ " : "▸ "}
        连接（{connections.length}）
      </button>
      {!open ? null : (
        <div>
          {connections.map((connection) => (
            <div key={connection.connectionId} className={styles.row}>
              <span>{connection.displayName}</span>
              <span className={styles.muted}>
                {connection.authMode === "subscription" ? "订阅" : "API key"}
                {connection.modelId === undefined ? "" : ` · ${connection.modelId}`}
              </span>
              {connection.authMode !== "api-key" ? null : connection.credentialConfigured ? (
                <span className={styles.muted}>密钥已配置</span>
              ) : (
                <span className={styles.badgeBad}>密钥未配置</span>
              )}
              <button
                type="button"
                className={styles.drop}
                title="删除这个连接"
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
              placeholder="连接名"
              onChange={(event) => setName(event.target.value)}
            />
            <select className={styles.field} value={mode} onChange={(event) => setMode(event.target.value as AuthMode)}>
              <option value="subscription">订阅（用本机 CLI 的登录态）</option>
              <option value="api-key">API key</option>
            </select>
            <input
              className={styles.field}
              value={model}
              placeholder={mode === "subscription" ? "模型（只能是自家的，如 sonnet）" : "模型"}
              onChange={(event) => setModel(event.target.value)}
            />
          </div>

          {mode !== "api-key" ? null : (
            <div className={styles.row}>
              <input
                className={styles.field}
                value={endpoint}
                placeholder="端点（留空用默认）"
                onChange={(event) => setEndpoint(event.target.value)}
              />
              <input
                className={styles.field}
                value={credentialRef}
                placeholder="凭据名，如 MY_GATEWAY_KEY"
                onChange={(event) => setCredentialRef(event.target.value)}
              />
              <input
                className={styles.field}
                type="password"
                value={key}
                placeholder="API key（只写入，永不回显）"
                onChange={(event) => setKey(event.target.value)}
              />
            </div>
          )}

          {error === undefined ? null : <div className={styles.error}>{error}</div>}
          <div className={styles.row}>
            <button type="button" className={styles.button} onClick={() => void save()}>
              保存连接
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
