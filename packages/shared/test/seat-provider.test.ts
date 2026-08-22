import { describe, expect, it } from "vitest";
import { CLAUDE_PERMISSION_MODES, providerNameFor, SEAT_PROVIDER } from "../src/index.ts";

describe("providerNameFor", () => {
  it("什么都不给就是默认 provider", () => {
    // 这一条是承重的：seat-claude-code 用 `this.provider()`（两个参数都不传）
    // 注册那个默认的宿主登录态 provider。名字对不上，带连接的席位能跑、
    // 不带连接的席位报「没有注册的 provider」。
    expect(providerNameFor()).toBe(SEAT_PROVIDER);
    expect(providerNameFor("")).toBe(SEAT_PROVIDER);
  });

  it("连接和权限模式各占一个轴", () => {
    expect(providerNameFor("gw")).toBe(`${SEAT_PROVIDER}/gw`);
    expect(providerNameFor(undefined, "plan")).toBe(`${SEAT_PROVIDER}#plan`);
    expect(providerNameFor("gw", "plan")).toBe(`${SEAT_PROVIDER}/gw#plan`);
  });

  it("不同的组合互不重名", () => {
    // 重名就意味着一个席位拿到另一个席位的环境或者权限模式，而且不会报错。
    const names = new Set<string>();
    for (const connection of [undefined, "gw", "login"]) {
      for (const mode of [undefined, ...CLAUDE_PERMISSION_MODES]) {
        names.add(providerNameFor(connection, mode));
      }
    }
    expect(names.size).toBe(3 * (CLAUDE_PERMISSION_MODES.length + 1));
  });
});
