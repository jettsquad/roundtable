import { describe, expect, it } from "vitest";
import { buildCodexArgv, isCodexMode } from "../src/argv.ts";

const base = { prompt: "做点事", cwd: "/p" };

describe("buildCodexArgv", () => {
  it("headless 入口 + 目录 + JSONL", () => {
    const argv = buildCodexArgv(base);
    expect(argv.slice(0, 5)).toEqual(["exec", "--cd", "/p", "--json", "--skip-git-repo-check"]);
  });

  it("--skip-git-repo-check 永远在", () => {
    // 没有它，codex 在任何不在信任列表里的目录都拒绝启动，报的是
    // 「Not inside a trusted directory」——跟人做过的事对不上。
    for (const mode of ["read-only", "workspace", "yolo"] as const) {
      expect(buildCodexArgv({ ...base, permissionMode: mode })).toContain("--skip-git-repo-check");
    }
  });

  it("权限走 -c approval_policy，不走 --ask-for-approval", () => {
    // 后者是顶层 flag，`codex exec` 会以 unexpected argument 拒掉。
    const argv = buildCodexArgv({ ...base, permissionMode: "read-only" });
    expect(argv).toContain("-c");
    expect(argv).toContain("approval_policy=never");
    expect(argv).not.toContain("--ask-for-approval");
  });

  it("三种模式各不相同", () => {
    expect(buildCodexArgv({ ...base, permissionMode: "read-only" })).toContain("read-only");
    expect(buildCodexArgv({ ...base, permissionMode: "workspace" })).toContain("workspace-write");
    expect(buildCodexArgv({ ...base, permissionMode: "yolo" })).toContain("--dangerously-bypass-approvals-and-sandbox");
    // yolo 绕开两个轴，所以不该再带 sandbox。
    expect(buildCodexArgv({ ...base, permissionMode: "yolo" })).not.toContain("--sandbox");
  });

  it("不给模式就是 workspace", () => {
    expect(buildCodexArgv(base)).toContain("workspace-write");
  });

  it("提示词是最后一个、且是一个参数", () => {
    // 它是带换行和引号的用户文本。拼成 shell 字符串就是一个以团队讨论
    // 为载荷的命令注入洞。
    const argv = buildCodexArgv({ ...base, prompt: '第一行\n第二行 "引号"' });
    expect(argv[argv.length - 1]).toBe('第一行\n第二行 "引号"');
    expect(argv.filter((a) => a.includes("第二行"))).toHaveLength(1);
  });

  it("模型和推理档位只在给了的时候出现", () => {
    expect(buildCodexArgv(base)).not.toContain("--model");
    expect(buildCodexArgv({ ...base, model: "gpt-5" })).toContain("gpt-5");
    expect(buildCodexArgv({ ...base, model: "   " })).not.toContain("--model");
    expect(buildCodexArgv({ ...base, reasoningEffort: "high" })).toContain('model_reasoning_effort="high"');
  });
});

describe("isCodexMode", () => {
  it("认自己的三个，不认 claude 的", () => {
    // 表单里换后端时若没重置，plan 会原样交给子进程，报错来自 CLI。
    expect(isCodexMode("workspace")).toBe(true);
    expect(isCodexMode("plan")).toBe(false);
    expect(isCodexMode(undefined)).toBe(false);
  });
});

describe("自定义端点", () => {
  it("没给端点就不声明 provider", () => {
    // 订阅席位用 CLI 自己的登录态和 provider；多声明一个就是覆盖掉它。
    expect(buildCodexArgv(base).join(" ")).not.toContain("model_providers");
  });

  it("给了端点就声明成一次性的 provider", () => {
    // 这是那个 bug：codex 没有 base-url 环境变量，不声明的话连接上的地址
    // 存得下、库里画得出、然后被忽略——和 dsh 那次一模一样。
    const argv = buildCodexArgv({ ...base, endpoint: "https://api.example.com/v1" });
    expect(argv).toContain('model_provider="squad"');
    expect(argv).toContain('model_providers.squad.base_url="https://api.example.com/v1"');
  });

  it("密钥只给变量名，不给值", () => {
    // 参数列表 ps 谁都看得见。
    const argv = buildCodexArgv({ ...base, endpoint: "https://x" });
    expect(argv).toContain('model_providers.squad.env_key="CODEX_API_KEY"');
    expect(argv.join(" ")).not.toMatch(/sk-|secret/);
  });

  it("wire_api 只能是 responses", () => {
    // 这个 CLI 已经明确拒绝 "chat"（no longer supported）。这是对「哪些网关
    // 能给 codex 席位用」的真实约束：只讲 chat-completions 的不行。
    expect(buildCodexArgv({ ...base, endpoint: "https://x" })).toContain('model_providers.squad.wire_api="responses"');
  });

  it("空白端点当没给", () => {
    expect(buildCodexArgv({ ...base, endpoint: "   " }).join(" ")).not.toContain("model_providers");
  });
});
