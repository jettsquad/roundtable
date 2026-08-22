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
import { credentialRefFor, type AuthMode, type ConnectionView, type SeatConnection } from "@squad/shared";
import { api, useAction } from "./api.ts";
import styles from "./panel.module.css";

interface ConnectionsProps {
  readonly connections: readonly ConnectionView[];
  readonly onChanged: () => void;
}

export function Connections({ connections, onChanged }: ConnectionsProps): JSX.Element {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<AuthMode>("subscription");
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

  const save = async (): Promise<void> => {
    const connectionId = `conn-${Date.now().toString(36)}`;
    const connection: SeatConnection & { credential?: string } = {
      connectionId,
      displayName: name,
      authMode: mode,
      backend: "claude-code",
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
    setName("");
    setModel("");
    setEndpoint("");
    setCredentialRef("");
    setKey("");
    setExisting(false);
  };

  return (
    <div>
      <div className={styles.hint}>
        一个连接就是一套模型配置：订阅走本机 CLI 的登录态，API key 走你自己的网关。多个 Agent
        可以共用同一个连接——换网关只改一处。
      </div>
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
            ) : connection.credentialWritable ? (
              <span className={styles.badgeBad}>密钥未配置</span>
            ) : (
              // `set` refuses while a read-only source shadows the name, so
              // this connection cannot be fixed from here at all — and
              // without saying so, the key box would silently keep failing.
              <span className={styles.badgeBad}>密钥名「{connection.credentialRef}」被只读来源占了，这里改不了</span>
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
          <div>
            <div className={styles.row}>
              <input
                className={styles.field}
                value={endpoint}
                placeholder="接口地址（留空用默认）"
                onChange={(event) => setEndpoint(event.target.value)}
              />
              {existing ? (
                <input
                  className={styles.field}
                  value={credentialRef}
                  placeholder="环境变量名，如 DEEPSEEK_API_KEY"
                  onChange={(event) => setCredentialRef(event.target.value)}
                />
              ) : (
                <input
                  className={styles.field}
                  type="password"
                  value={key}
                  placeholder="API key（只写入，永不回显）"
                  onChange={(event) => setKey(event.target.value)}
                />
              )}
            </div>
            <label className={styles.check}>
              <input type="checkbox" checked={existing} onChange={(event) => setExisting(event.target.checked)} />
              这把 key 已经在环境变量里了
            </label>
            <div className={styles.hint}>
              {existing
                ? "填变量名，不填值——每次启动子进程时按这个名字去取，所以你在别处换了 key，下一轮就生效。"
                : "key 存进宿主的凭据服务，配置里只留一个名字。填过之后不会再显示出来。"}
            </div>
          </div>
        )}

        {error === undefined ? null : <div className={styles.error}>{error}</div>}
        <div className={styles.row}>
          <button type="button" className={styles.button} onClick={() => void save()}>
            保存连接
          </button>
        </div>
      </div>
    </div>
  );
}
