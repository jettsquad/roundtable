import { describe, expect, it } from "vitest";
import { driftBetween } from "../src/roster-drift.ts";

const a = { seatId: "s1", displayName: "水户洋平" };
const b = { seatId: "s2", displayName: "赤木晴子" };
const c = { seatId: "s3", displayName: "野间忠一郎" };

describe("名册漂移", () => {
  it("没变就没有话说", () => {
    expect(driftBetween([a, b], [a, b])).toEqual([]);
  });

  it("走了的人点名说", () => {
    // 「名册变了」没法行动，「野间忠一郎 已不在」可以。
    expect(driftBetween([a, b, c], [a, b])).toEqual(["野间忠一郎 已不在"]);
  });

  it("后加入的也说", () => {
    expect(driftBetween([a], [a, c])).toEqual(["野间忠一郎 是后来加入的"]);
  });

  it("改名不算漂移", () => {
    // 同一把椅子换了个称呼，报成「走了又来了」是在制造噪音。
    expect(driftBetween([a], [{ seatId: "s1", displayName: "洋平" }])).toEqual([]);
  });

  it("同名不同席位算两个人", () => {
    // 显示名可以重复，seatId 不会。按名字比会把两个人看成一个。
    expect(driftBetween([{ seatId: "s1", displayName: "甲" }], [{ seatId: "s9", displayName: "甲" }])).toEqual([
      "甲 已不在",
      "甲 是后来加入的",
    ]);
  });
});
