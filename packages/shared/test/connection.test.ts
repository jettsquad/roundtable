/**
 * The injection rule is the only real difference between the two auth modes,
 * and the direction it fails in is "something was sent that should not have
 * been". So it lives in one function and is checked from both sides.
 */
import { describe, expect, it } from "vitest";
import {
  capExceeded,
  checkConnection,
  envForConnection,
  isOwnModel,
  meaningfulCaps,
  type SeatConnection,
} from "../src/connection.ts";

const subscription = (over: Partial<SeatConnection> = {}): SeatConnection => ({
  connectionId: "c1",
  displayName: "本机登录",
  authMode: "subscription",
  backend: "claude-code",
  ...over,
});

const apiKey = (over: Partial<SeatConnection> = {}): SeatConnection => ({
  connectionId: "c2",
  displayName: "自建网关",
  authMode: "api-key",
  backend: "claude-code",
  endpoint: "https://gateway.example/v1",
  credentialRef: "GATEWAY_KEY",
  modelId: "deepseek-chat",
  ...over,
});

describe("envForConnection · subscription", () => {
  it("injects nothing at all by default", () => {
    // 1.x's executor says it in capitals: MUST NOT inject an auth token. The
    // seat uses the human's own CLI login, and anything injected would
    // silently authenticate as something else.
    expect(envForConnection(subscription(), "a-secret")).toEqual({});
  });

  it("never sends a token even when one is available", () => {
    expect(envForConnection(subscription({ modelId: "sonnet" }), "a-secret")).toEqual({
      ANTHROPIC_MODEL: "sonnet",
    });
  });

  it("passes a model the login can actually serve", () => {
    expect(envForConnection(subscription({ modelId: "opus" }))).toHaveProperty("ANTHROPIC_MODEL", "opus");
  });

  it("withholds a foreign model rather than letting it 404 confusingly", () => {
    // Sent to the login's own endpoint, a foreign name comes back as an error
    // about the model — and the person goes looking at the model.
    expect(envForConnection(subscription({ modelId: "deepseek-chat" }))).toEqual({});
  });
});

describe("envForConnection · api-key", () => {
  it("sends endpoint, token and model together", () => {
    expect(envForConnection(apiKey(), "sk-live")).toEqual({
      ANTHROPIC_BASE_URL: "https://gateway.example/v1",
      ANTHROPIC_AUTH_TOKEN: "sk-live",
      ANTHROPIC_MODEL: "deepseek-chat",
    });
  });

  it("accepts any model name, because it travels with its own endpoint", () => {
    // The namespace guard is a subscription-mode concern only.
    expect(envForConnection(apiKey({ modelId: "whatever-v9" }), "sk")).toHaveProperty("ANTHROPIC_MODEL", "whatever-v9");
  });

  it("omits the token when the credential could not be resolved", () => {
    // Rather than sending an empty one, which authenticates as nobody and
    // fails with a message about the request instead of about the key.
    expect(envForConnection(apiKey(), undefined)).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });
});

describe("checkConnection", () => {
  it("accepts both ordinary shapes", () => {
    expect(checkConnection(subscription())).toEqual([]);
    expect(checkConnection(apiKey())).toEqual([]);
  });

  it("refuses an endpoint on a subscription rather than ignoring it", () => {
    // A stored setting that never takes effect is one the person believes is
    // in force.
    expect(checkConnection(subscription({ endpoint: "https://x" }))[0]?.detail).toMatch(/不使用自定义端点/);
  });

  it("refuses a foreign model on a subscription, and says why", () => {
    const problems = checkConnection(subscription({ modelId: "deepseek-chat" }));
    expect(problems[0]?.detail).toMatch(/报出来的错会指向模型/);
  });

  it("requires a credential reference in api-key mode", () => {
    expect(checkConnection(apiKey({ credentialRef: "" }))[0]?.detail).toMatch(/凭据引用/);
  });
});

describe("isOwnModel", () => {
  it("knows each backend's own families", () => {
    expect(isOwnModel("claude-code", "sonnet")).toBe(true);
    expect(isOwnModel("codex", "gpt-5")).toBe(true);
    expect(isOwnModel("dsh", "deepseek-chat")).toBe(true);
    expect(isOwnModel("claude-code", "gpt-5")).toBe(false);
  });
});

describe("caps", () => {
  it("drops the cost ceiling for a subscription seat", () => {
    // It bills nothing, so a cost cap can never fire. Offering the field
    // would be offering a knob a person sets and then relies on.
    expect(meaningfulCaps("subscription")).not.toContain("maxCostUsd");
    expect(meaningfulCaps("api-key")).toContain("maxCostUsd");
  });

  it("binds a subscription seat by turns", () => {
    expect(capExceeded({ maxTurns: 3 }, { turns: 3, tokens: 0 }, "subscription")).toMatch(/轮数上限/);
  });

  it("ignores a cost cap set on a subscription seat", () => {
    // Stored but inert; reporting it as exceeded would stop a seat for a
    // reason that cannot be true.
    expect(capExceeded({ maxCostUsd: 1 }, { turns: 0, tokens: 0, costUsd: 99 }, "subscription")).toBeUndefined();
  });

  it("binds an api-key seat by cost", () => {
    expect(capExceeded({ maxCostUsd: 1 }, { turns: 0, tokens: 0, costUsd: 1.5 }, "api-key")).toMatch(/花费上限/);
  });

  it("says nothing when nothing is capped", () => {
    expect(capExceeded({}, { turns: 999, tokens: 999_999, costUsd: 99 }, "api-key")).toBeUndefined();
  });
});
