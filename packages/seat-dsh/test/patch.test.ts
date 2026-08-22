import { describe, expect, it } from "vitest";
import { buildDshPatch, COMPAT_API_KEY_ENV, COMPAT_ROUTE, isDeepSeekModel } from "../src/patch.ts";

describe("buildDshPatch", () => {
  it("没配模型就不写 patch", () => {
    // profile 自己的设置就是答案；再写一遍就是同一个决定有了第二个住处。
    expect(buildDshPatch({ model: "", baseUrl: "https://x" })).toBeUndefined();
    expect(buildDshPatch({ model: "   ", baseUrl: "" })).toBeUndefined();
  });

  it("非 DeepSeek 的模型走兼容 provider，并且带上端点", () => {
    // 这就是那个 bug：不写 patch 的话，MiniMax 的 key 会被发去 DeepSeek 的
    // 官方端点，然后报「key 无效」——怪罪的是 key，而请求根本发错了公司。
    const patch = buildDshPatch({ model: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/v1" })!;
    expect(patch).toContain(COMPAT_ROUTE);
    expect(patch).toContain('baseURL: "https://api.minimaxi.com/v1"');
    expect(patch).toContain('- id: "MiniMax-M3"');
    expect(patch).toContain("llm-pi-ai");
  });

  it("DeepSeek 的模型走它自己的 provider", () => {
    const patch = buildDshPatch({ model: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com/v1" })!;
    expect(patch).toContain("provider: deepseek-official");
    expect(patch).toContain("llm-deepseek");
    expect(patch).not.toContain(COMPAT_ROUTE);
  });

  it("DeepSeek 模型没给端点就不覆盖端点", () => {
    const patch = buildDshPatch({ model: "deepseek-chat", baseUrl: "" })!;
    expect(patch).not.toContain("llm-deepseek");
    expect(patch).toContain('model: "deepseek-chat"');
  });

  it("密钥永远不进 patch 文件，只进变量名", () => {
    // patch 是磁盘上的文件，写进去的密钥会活得比这一次运行更久。
    const patch = buildDshPatch({ model: "MiniMax-M3", baseUrl: "https://x" })!;
    expect(patch).toContain(`apiKeyEnv: ${COMPAT_API_KEY_ENV}`);
    expect(patch).not.toMatch(/sk-|apiKey:\s*"/);
  });
});

describe("isDeepSeekModel", () => {
  it("按前缀分流，大小写不敏感", () => {
    expect(isDeepSeekModel("deepseek-chat")).toBe(true);
    expect(isDeepSeekModel("DeepSeek-V4")).toBe(true);
    expect(isDeepSeekModel("MiniMax-M3")).toBe(false);
    expect(isDeepSeekModel("")).toBe(false);
  });
});
