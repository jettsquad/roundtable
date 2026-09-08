/**
 * 蒸馏跑在哪个模型上。
 *
 * 这几条锁的是回落顺序。它之前只有一个默认值 SEAT_PROVIDER，而且没有任何
 * profile 配过 Config.provider——也就是说，写你判据库的那个模型，实际上是
 * 「某个席位碰巧配成什么」。判据库是用户级资产，这个选择该由「我」页定。
 */
import { describe, expect, it } from "vitest";
import { SEAT_PROVIDER, providerForSeat } from "@squad/shared";

/** service.ts 里 distilProvider() 的解析规则。 */
const resolve = (input: {
  configProvider?: string;
  chosenId?: string;
  known?: { connectionId: string; backend: "claude-code" | "codex" | "dsh" };
}): string => {
  if (input.configProvider !== undefined && input.configProvider !== "") return input.configProvider;
  if (input.chosenId === undefined) return SEAT_PROVIDER;
  if (input.known === undefined || input.known.connectionId !== input.chosenId) return SEAT_PROVIDER;
  return providerForSeat({ backend: input.known.backend, connectionId: input.chosenId });
};

describe("蒸馏用哪个 provider", () => {
  it("没选过就用宿主自己的登录", () => {
    expect(resolve({})).toBe(SEAT_PROVIDER);
  });

  it("选了就用那个连接的 provider", () => {
    expect(resolve({ chosenId: "c1", known: { connectionId: "c1", backend: "claude-code" } })).toBe(
      providerForSeat({ backend: "claude-code", connectionId: "c1" }),
    );
  });

  it("连接被删了就回落，不是报错", () => {
    // 丢一个连接该丢掉的是模型选择，不该是「记下刚才发生了什么」这个能力。
    expect(resolve({ chosenId: "gone" })).toBe(SEAT_PROVIDER);
  });

  it("profile 显式配了 provider 就压过一切", () => {
    // 这个口子本来就在，保留它：部署方要钉死一个模型时不该被界面覆盖。
    expect(resolve({ configProvider: "pinned", chosenId: "c1" })).toBe("pinned");
  });
});
