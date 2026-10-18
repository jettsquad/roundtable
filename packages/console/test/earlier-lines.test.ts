import { describe, expect, it } from "vitest";
import { earlierLines, spokenLines, transcriptTail } from "../src/http.ts";

const events = Array.from({ length: 130 }, (_, index) => ({
  kind: "user/message",
  text: `【甲】第 ${index} 句`,
  turnId: `t${index}`,
  at: index,
}));

describe("看更早的消息", () => {
  it("快照只带最近 60 条，并说前面还有多少", () => {
    const tail = transcriptTail(events);
    expect(tail.transcript).toHaveLength(60);
    expect(tail.transcriptOmitted).toBe(70);
    expect(tail.transcript[0]?.turnId).toBe("t70");
  });

  it("按屏幕上最早那条的 turnId 往前取，新消息来了也不错位", () => {
    const first = earlierLines(events, "t70");
    expect(first.lines).toHaveLength(70);
    expect(first.lines[0]?.turnId).toBe("t0");
    expect(first.lines.at(-1)?.turnId).toBe("t69");
    expect(first.remaining).toBe(0);
    // 又来了新消息：以 turnId 定位，取到的还是同样的那一段。
    const later = [...events, { kind: "user/message", text: "【甲】新的", turnId: "t999", at: 999 }];
    expect(earlierLines(later, "t70").lines.map((line) => line.turnId)).toEqual(first.lines.map((line) => line.turnId));
  });

  it("一次最多一页，剩下的告诉你还有多少", () => {
    const page = earlierLines(events, "t120", 50);
    expect(page.lines.map((line) => line.turnId)[0]).toBe("t70");
    expect(page.lines).toHaveLength(50);
    expect(page.remaining).toBe(70);
    // 一次最多 500 条，要得再多也不超。
    expect(earlierLines(events, "t129", 100000).lines.length).toBeLessThanOrEqual(129);
  });

  it("找不到那条就什么也不返回，不乱给", () => {
    expect(earlierLines(events, "没有这条")).toEqual({ lines: [], remaining: 0 });
  });

  it("只算有人说过的话，不算系统记号", () => {
    const mixed = [
      { kind: "sandbox/mode", text: "", turnId: "s1", at: 0 },
      { kind: "user/message", text: "【甲】一", turnId: "a", at: 1 },
      { kind: "user/message", text: "【乙】二", turnId: "b", at: 2 },
    ];
    expect(spokenLines(mixed).map((line) => line.turnId)).toEqual(["a", "b"]);
    expect(earlierLines(mixed, "b").lines.map((line) => line.turnId)).toEqual(["a"]);
  });
});
