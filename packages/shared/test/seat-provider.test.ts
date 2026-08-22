import { describe, expect, it } from "vitest";
import { CLAUDE_PERMISSION_MODES, providerForSeat, providerNameFor, SEAT_PROVIDER } from "../src/index.ts";

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

describe("providerForSeat", () => {
  it("claude-code 席位带上连接和权限模式", () => {
    expect(providerForSeat({ backend: "claude-code" })).toBe(SEAT_PROVIDER);
    expect(providerForSeat({ backend: "claude-code", connectionId: "gw", permissionMode: "plan" })).toBe(
      `${SEAT_PROVIDER}/gw#plan`,
    );
  });

  it("非 claude 后端走它自己的 provider，不带连接轴", () => {
    // 它们的席位插件还没写；名字对不对至少要能一眼看出来。
    expect(providerForSeat({ backend: "codex", connectionId: "gw" })).toBe("codex");
    expect(providerForSeat({ backend: "dsh" })).toBe("dsh-sdk");
  });

  it("没见过的后端原样返回，而不是悄悄退回默认", () => {
    // 退回 SEAT_PROVIDER 会让一个配错后端的席位跑在别人的登录态上，而且不报错。
    expect(providerForSeat({ backend: "什么" })).toBe("什么");
  });
});
