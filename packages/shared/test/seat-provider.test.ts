import { describe, expect, it } from "vitest";
import {
  CLAUDE_PERMISSION_MODES,
  providerForSeat,
  providerName,
  providerNameFor,
  SEAT_PROVIDER,
} from "../src/index.ts";

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

  it("每个后端有自己的基名", () => {
    // 这条以前断言 codex 忽略连接轴——那在 codex 还没有席位插件时是对的。
    // 现在有了，它和 claude 一样按连接注册 provider。
    expect(providerForSeat({ backend: "codex", connectionId: "gw" })).toBe("codex/gw");
    expect(providerForSeat({ backend: "dsh" })).toBe("dsh-sdk");
  });

  it("没见过的后端原样返回，而不是悄悄退回默认", () => {
    // 退回 SEAT_PROVIDER 会让一个配错后端的席位跑在别人的登录态上，而且不报错。
    expect(providerForSeat({ backend: "什么" })).toBe("什么");
  });
});

describe("三个后端的 provider 名字，注册方和请求方必须一模一样", () => {
  // 这是最容易悄悄坏掉的接缝：两边各自拼字符串，对不上不是类型错误，
  // 而是一轮跑起来之后报「没有注册的 provider」，名字是谁都没敲过的。
  const cases = [
    { backend: "claude-code", base: SEAT_PROVIDER, modes: [...CLAUDE_PERMISSION_MODES] },
    { backend: "codex", base: "codex", modes: ["read-only", "workspace", "yolo"] },
  ];

  for (const { backend, base, modes } of cases) {
    it(`${backend}：连接 × 权限模式`, () => {
      for (const connectionId of [undefined, "conn-1"]) {
        for (const mode of [undefined, ...modes]) {
          const asked = providerForSeat({ backend, connectionId, permissionMode: mode });
          expect(asked).toBe(providerName(base, connectionId, mode));
        }
      }
    });
  }

  it("dsh：不带权限模式那一轴", () => {
    // headless 剖面没有 sandbox / approval 开关，名字里带上模式就是
    // 承诺一件子进程根本收不到的事。
    expect(providerForSeat({ backend: "dsh", connectionId: "c", permissionMode: "yolo" })).toBe(
      providerName("dsh-sdk", "c"),
    );
    expect(providerForSeat({ backend: "dsh" })).toBe("dsh-sdk");
  });

  it("三个后端互不重名", () => {
    const names = new Set(
      ["claude-code", "codex", "dsh"].map((backend) => providerForSeat({ backend, connectionId: "same" })),
    );
    expect(names.size).toBe(3);
  });
});
