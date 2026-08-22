import { describe, expect, it } from "vitest";
import { overallOf, type AgentCheckReport, type CheckResult } from "../src/index.ts";

const report = (...checks: CheckResult[]): AgentCheckReport => ({
  templateId: "a",
  displayName: "甲",
  checks,
});
const check = (outcome: CheckResult["outcome"]): CheckResult => ({ name: "n", outcome, detail: "d" });

describe("overallOf", () => {
  it("全过才是过", () => {
    expect(overallOf(report(check("ok"), check("ok")))).toBe("ok");
  });

  it("有一项失败就是失败", () => {
    expect(overallOf(report(check("ok"), check("fail"), check("skipped")))).toBe("fail");
  });

  it("跳过不算过", () => {
    // 这是这个函数存在的全部理由：没跑成的检查和跑过了的检查，在一个绿勾里
    // 长得一模一样，而只有一个是证据。
    expect(overallOf(report(check("ok"), check("skipped")))).toBe("incomplete");
    expect(overallOf(report(check("skipped")))).not.toBe("ok");
  });

  it("一项都没有也不算过", () => {
    // 空报告和全跳过是同一句话：没有取到任何证据。这里给 "ok" 就等于
    // 一次什么都没检查的检查，报了个通过。
    expect(overallOf(report())).toBe("incomplete");
  });
});
