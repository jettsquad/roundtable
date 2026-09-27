import { describe, expect, it } from "vitest";
import { appleScriptString, bannerFor, previewOf, PresenceTracker, type FinishedRound } from "../src/notify.ts";

const round: FinishedRound = {
  teamName: "评审组",
  kind: "round",
  stopped: false,
  answered: 2,
  failed: 0,
  last: { speaker: "架构", text: "## 结论\n**建议**采用方案 B，见 [文档](http://x)" },
  moreQueued: false,
  waitingForHost: false,
};

describe("bannerFor", () => {
  it("names the team and previews the last answer without Markdown", () => {
    const banner = bannerFor(round);
    expect(banner?.title).toBe("评审组");
    expect(banner?.body).toContain("这一轮完成了");
    expect(banner?.body).toContain("架构：结论 建议采用方案 B，见 文档");
  });
  it("stays quiet when a queued round is already starting", () => {
    expect(bannerFor({ ...round, moreQueued: true })).toBeUndefined();
  });
  it("says so when everyone failed, was stopped, or is waiting for the host", () => {
    expect(bannerFor({ ...round, failed: 2 })?.body).toContain("都没答上来");
    expect(bannerFor({ ...round, stopped: true })?.body).toContain("叫停");
    expect(bannerFor({ ...round, kind: "agenda", waitingForHost: true })?.body).toContain("等你");
  });
});

describe("previewOf", () => {
  it("truncates long replies", () => {
    expect(previewOf("字".repeat(300)).length).toBeLessThanOrEqual(91);
  });
});

describe("appleScriptString", () => {
  it("cannot be broken out of by quotes, backslashes or newlines", () => {
    expect(appleScriptString('a"b\\c\nd')).toBe('"a\\"b\\\\c d"');
  });
});

describe("PresenceTracker", () => {
  it("is focused only while a fresh report says so", () => {
    const tracker = new PresenceTracker();
    expect(tracker.isFocused(0)).toBe(false);
    tracker.report(true, 1000);
    expect(tracker.isFocused(2000)).toBe(true);
    expect(tracker.isFocused(1000 + 31_000)).toBe(false);
    tracker.report(false, 3000);
    expect(tracker.isFocused(3001)).toBe(false);
  });
});
