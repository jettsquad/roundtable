import { describe, expect, it } from "vitest";
import { numberOrUndefined } from "../src/client/number-field.ts";

describe("numberOrUndefined", () => {
  it("空字段是「没有上限」，不是 0", () => {
    // Number("") === 0. 折在一起的话，一个没填的上限就变成「第一轮之前就停」。
    expect(numberOrUndefined("")).toBeUndefined();
    expect(numberOrUndefined("   ")).toBeUndefined();
  });

  it("0 就是 0", () => {
    expect(numberOrUndefined("0")).toBe(0);
  });

  it("读得出小数和整数", () => {
    expect(numberOrUndefined("6")).toBe(6);
    expect(numberOrUndefined(" 1.25 ")).toBe(1.25);
  });

  it("读不出来的当没填，不当 NaN", () => {
    // NaN 会被 JSON.stringify 成 null，然后在宿主那边变成一个谁也没设过的上限。
    expect(numberOrUndefined("abc")).toBeUndefined();
    expect(numberOrUndefined("-3")).toBeUndefined();
    expect(numberOrUndefined("Infinity")).toBeUndefined();
  });
});
