/**
 * 配置目录必须稳定。
 *
 * 这条测试守的是一个真实故障：api-key 席位每一轮都用一个新的临时
 * CLAUDE_CONFIG_DIR，而 CLI 的对话就存在配置目录下面，于是刚记下的会话在
 * 几秒后随目录一起被删；下一轮 `--resume` 拿回来的是
 * `No conversation found with session ID: <uuid>`。
 */
import { afterEach, describe, expect, it } from "vitest";
import { claudeConfigDirFor } from "../src/config-dir.ts";

const home = process.env["DSH_HOME"];
afterEach(() => {
  if (home === undefined) delete process.env["DSH_HOME"];
  else process.env["DSH_HOME"] = home;
});

describe("claudeConfigDirFor", () => {
  it("同一个连接的两轮拿到同一个目录", () => {
    const first = claudeConfigDirFor({ authMode: "api-key", connectionId: "conn-a" });
    const second = claudeConfigDirFor({ authMode: "api-key", connectionId: "conn-a" });
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("不同连接互不相干", () => {
    // 两个连接是两份凭据，它们的登录态、对话和设置都不该混在一起。
    const a = claudeConfigDirFor({ authMode: "api-key", connectionId: "conn-a" });
    const b = claudeConfigDirFor({ authMode: "api-key", connectionId: "conn-b" });
    expect(a).not.toBe(b);
  });

  it("跟着 DSH_HOME 走，不写进真正的家目录", () => {
    process.env["DSH_HOME"] = "/tmp/squad-home-test";
    expect(claudeConfigDirFor({ authMode: "api-key", connectionId: "conn-a" })).toBe(
      "/tmp/squad-home-test/squad-seat-state/claude-config/conn-a",
    );
  });

  it("订阅席位用本机的配置，不另开一份", () => {
    // 订阅模式的意思就是用这台机器上的 `claude login`。给它一个空目录，它就
    // 什么凭据都没有了。
    expect(claudeConfigDirFor({ authMode: "subscription", connectionId: "conn-a" })).toBeUndefined();
    expect(claudeConfigDirFor({})).toBeUndefined();
  });

  it("没有连接 id 就不隔离——宁可不写，也不要一个所有席位共用的目录", () => {
    expect(claudeConfigDirFor({ authMode: "api-key", connectionId: "  " })).toBeUndefined();
  });
});
