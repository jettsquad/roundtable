/**
 * connection.ts — what a seat runs on, and the one rule that decides how.
 *
 * Two auth modes, carried over from 1.x because they are what a person
 * actually has:
 *
 *   subscription — the human is logged into the provider's CLI on this
 *                  machine. Nothing is injected. 1.x's executor says it in
 *                  capitals: MUST NOT inject an auth token.
 *   api-key      — a credential the harness resolves per operation, with an
 *                  endpoint, which is what lets a seat point at any
 *                  compatible service rather than only the vendor's own.
 *
 * The injection rule lives HERE, in one function, with tests. It is the only
 * real difference between the two modes, and a rule about credentials that is
 * spelled out in more than one place will eventually disagree with itself —
 * in the direction where something gets sent that should not have been.
 */

export type AuthMode = "subscription" | "api-key";

/** Which CLI or channel a connection speaks through. */
export type ConnectionBackend = "claude-code" | "codex" | "dsh";

export interface SeatConnection {
  readonly connectionId: string;
  /** What a person calls it. */
  readonly displayName: string;
  readonly authMode: AuthMode;
  readonly backend: ConnectionBackend;
  readonly modelId?: string | undefined;
  /** api-key only. Empty means the backend's own default endpoint. */
  readonly endpoint?: string | undefined;
  /**
   * api-key only: the NAME of a credential, never its value.
   *
   * Resolved per operation through `ctx.credentials`, so rotating a secret
   * touches no configuration and a changed key reaches the very next turn.
   *
   * A person should almost never type this — see `credentialRefFor`. It is
   * spelled out only to reuse a secret that already exists under a known
   * name, which is the one case where inventing a fresh one would be wrong.
   */
  readonly credentialRef?: string | undefined;
}

/**
 * Model namespaces each backend's own login can serve.
 *
 * The guard exists because of a specific, confusing failure 1.x hit: a
 * subscription seat given a foreign model name has that name sent to the
 * login's own endpoint, which answers with an error about the model rather
 * than about the mismatch. The person then goes looking at the model.
 */
const OWN_NAMESPACE: Readonly<Record<ConnectionBackend, readonly string[]>> = {
  "claude-code": ["claude", "sonnet", "opus", "haiku"],
  codex: ["gpt", "o1", "o3", "o4", "codex"],
  dsh: ["deepseek"],
};

/** Whether a model name is one this backend's own login can serve. */
export function isOwnModel(backend: ConnectionBackend, modelId: string): boolean {
  const name = modelId.trim().toLowerCase();
  if (name === "") return false;
  return (OWN_NAMESPACE[backend] ?? []).some((prefix) => name.startsWith(prefix));
}

/**
 * The credential name a connection gets when nobody chose one.
 *
 * A reference is an environment-variable name — dsh brands it as a POSIX
 * shell identifier — and asking a person to invent one is asking the wrong
 * question. They have a key; the name is bookkeeping, and bookkeeping the
 * system can do for itself.
 *
 * Deriving it from the connection id also keeps two connections from landing
 * on one name by accident, which would look like a key that changed itself
 * the moment the other connection was edited.
 *
 * The `SQUAD_` prefix is not decoration: it keeps a derived name out of the
 * space where a person's own exported variables live. `ctx.credentials.set`
 * REFUSES to write while a read-only source shadows the reference, so a
 * derived name that collided with an exported `ANTHROPIC_API_KEY` would make
 * pasting a key fail, with an error about shadowing that names nothing the
 * person did.
 */
export function credentialRefFor(connectionId: string): string {
  const body = connectionId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `SQUAD_${body === "" ? "CONNECTION" : body}_KEY`;
}

export interface ConnectionProblem {
  readonly detail: string;
}

/** Check a connection before it can be saved. */
export function checkConnection(connection: SeatConnection): readonly ConnectionProblem[] {
  const problems: ConnectionProblem[] = [];
  if (connection.displayName.trim() === "") problems.push({ detail: "连接要有一个名字。" });

  if (connection.authMode === "subscription") {
    // Refused rather than ignored. A stored endpoint that never takes effect
    // is a setting the person believes is in force.
    if ((connection.endpoint ?? "").trim() !== "") {
      problems.push({ detail: "订阅模式不使用自定义端点——它用的是本机 CLI 的登录态。" });
    }
    if ((connection.credentialRef ?? "").trim() !== "") {
      problems.push({ detail: "订阅模式不使用 API key。" });
    }
    const model = (connection.modelId ?? "").trim();
    if (model !== "" && !isOwnModel(connection.backend, model)) {
      problems.push({
        detail:
          `订阅模式下只能用 ${connection.backend} 自己的模型；「${model}」会被发到登录态的端点，` +
          `报出来的错会指向模型而不是这个不匹配。`,
      });
    }
  } else {
    if ((connection.credentialRef ?? "").trim() === "") {
      problems.push({
        detail:
          "API key 模式要有一个凭据名（密钥存在宿主的凭据服务里，配置里只留名字）。" +
          "界面会自己生成一个，所以看到这句话说明是直接调的接口。",
      });
    }
  }
  return problems;
}

/**
 * The environment one connection contributes to a seat's process.
 *
 * `credential` is the RESOLVED value, passed in rather than looked up here so
 * this stays pure and testable — the one rule that decides whether a secret
 * is sent should be the easiest thing in the system to check.
 */
interface EnvNames {
  /** Where the key goes. */
  readonly token: string;
  /** Where the endpoint goes; absent when the CLI has no such variable. */
  readonly baseUrl?: string;
  /** Where the model goes; absent when the CLI takes it on the command line. */
  readonly model?: string;
}

/**
 * The environment variables each backend actually reads.
 *
 * Per backend, because they do not agree and a single set was simply wrong
 * for two of the three: every connection used to emit `ANTHROPIC_*`, so a
 * Codex seat was handed Anthropic variables it ignores and no key it reads,
 * and it would have failed as an auth error pointing at nothing.
 *
 * Codex takes its model on the COMMAND LINE (`--model`) and has no
 * base-url variable — the CLI's own config owns the provider — so those two
 * are absent here rather than invented.
 */
const ENV_NAMES: Readonly<Record<ConnectionBackend, EnvNames>> = {
  "claude-code": { token: "ANTHROPIC_AUTH_TOKEN", baseUrl: "ANTHROPIC_BASE_URL", model: "ANTHROPIC_MODEL" },
  codex: { token: "CODEX_API_KEY" },
  dsh: { token: "DEEPSEEK_API_KEY" },
};

export function envForConnection(
  connection: SeatConnection,
  credential?: string | undefined,
): Readonly<Record<string, string>> {
  const names = ENV_NAMES[connection.backend];
  if (connection.authMode === "subscription") {
    // Nothing. Not the endpoint, not a token, and the model only when the
    // login can actually serve it AND this backend takes a model from the
    // environment at all.
    const model = (connection.modelId ?? "").trim();
    if (names.model === undefined || model === "" || !isOwnModel(connection.backend, model)) return {};
    return { [names.model]: model };
  }

  const env: Record<string, string> = {};
  const endpoint = (connection.endpoint ?? "").trim();
  if (names.baseUrl !== undefined && endpoint !== "") env[names.baseUrl] = endpoint;
  if (credential !== undefined && credential !== "") env[names.token] = credential;
  const model = (connection.modelId ?? "").trim();
  // Any model name is safe here: it travels with its own endpoint and token.
  if (names.model !== undefined && model !== "") env[names.model] = model;
  return env;
}

/**
 * The model this connection wants, when the backend takes it on the command
 * line rather than from the environment.
 *
 * Returned only when it can actually be honoured: a subscription seat given a
 * foreign model has that name sent to the login's own endpoint, which answers
 * about the model rather than about the mismatch.
 */
export function modelArgumentFor(connection: SeatConnection): string | undefined {
  if (ENV_NAMES[connection.backend].model !== undefined) return undefined;
  const model = (connection.modelId ?? "").trim();
  if (model === "") return undefined;
  if (connection.authMode === "api-key") return model;
  return isOwnModel(connection.backend, model) ? model : undefined;
}

/**
 * A connection as a configuration screen may see it.
 *
 * Here rather than in the library because it crosses the wall: ④ the
 * connection library builds it, the console renders it, and neither may
 * import the other.
 *
 * There is no field for the credential VALUE and there never will be. The two
 * booleans are what `ctx.credentials.describe()` answers — configured, and
 * writable-from-here — which is the whole reason a settings screen can show a
 * badge without a secret entering the browser.
 */
export interface ConnectionView extends SeatConnection {
  readonly credentialConfigured: boolean;
  readonly credentialWritable: boolean;
}

/**
 * Spend limits for one seat.
 *
 * Which of these can bind depends on the auth mode, and showing a limit that
 * cannot take effect is worse than showing none: it is a knob a person sets
 * and then relies on.
 */
export interface SeatCaps {
  readonly maxTurns?: number | undefined;
  readonly maxCostUsd?: number | undefined;
  readonly maxTokens?: number | undefined;
}

/**
 * Which caps mean anything under this mode.
 *
 * A subscription seat bills nothing, so a cost ceiling on it can never fire —
 * turns are what bind it. 1.x learned this and wrote it down; carrying the
 * rule means a UI can grey out the field instead of accepting a number that
 * will be ignored.
 */
export function meaningfulCaps(mode: AuthMode): readonly (keyof SeatCaps)[] {
  return mode === "subscription" ? ["maxTurns", "maxTokens"] : ["maxTurns", "maxTokens", "maxCostUsd"];
}

/** Whether a cap has been exceeded, given what a seat has used. */
export function capExceeded(
  caps: SeatCaps,
  used: { readonly turns: number; readonly tokens: number; readonly costUsd?: number | undefined },
  mode: AuthMode,
): string | undefined {
  const allowed = new Set(meaningfulCaps(mode));
  if (allowed.has("maxTurns") && caps.maxTurns !== undefined && used.turns >= caps.maxTurns) {
    return `已达轮数上限（${caps.maxTurns}）。`;
  }
  if (allowed.has("maxTokens") && caps.maxTokens !== undefined && used.tokens >= caps.maxTokens) {
    return `已达 token 上限（${caps.maxTokens}）。`;
  }
  if (
    allowed.has("maxCostUsd") &&
    caps.maxCostUsd !== undefined &&
    used.costUsd !== undefined &&
    used.costUsd >= caps.maxCostUsd
  ) {
    return `已达花费上限（$${caps.maxCostUsd}）。`;
  }
  return undefined;
}
