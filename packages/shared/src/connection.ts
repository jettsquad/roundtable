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
      problems.push({ detail: "API key 模式要指定一个凭据引用。" });
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
export function envForConnection(
  connection: SeatConnection,
  credential?: string | undefined,
): Readonly<Record<string, string>> {
  if (connection.authMode === "subscription") {
    // Nothing. Not the endpoint, not a token, and the model only when the
    // login can actually serve it.
    const model = (connection.modelId ?? "").trim();
    return model !== "" && isOwnModel(connection.backend, model) ? { ANTHROPIC_MODEL: model } : {};
  }

  const env: Record<string, string> = {};
  const endpoint = (connection.endpoint ?? "").trim();
  if (endpoint !== "") env["ANTHROPIC_BASE_URL"] = endpoint;
  if (credential !== undefined && credential !== "") env["ANTHROPIC_AUTH_TOKEN"] = credential;
  const model = (connection.modelId ?? "").trim();
  // Any model name is safe here: it travels with its own endpoint and token.
  if (model !== "") env["ANTHROPIC_MODEL"] = model;
  return env;
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
