import { describe, expect, it } from "vitest";
import { composeSeatPrompt, type SeatSpec } from "../src/seat.ts";

const seat: SeatSpec = {
  seatId: "seat-a",
  displayName: "甲",
  role: "架构",
  systemPrompt: "你重视可维护性。",
  backend: "claude-code",
};

describe("composeSeatPrompt", () => {
  // The CLI providers hand the child the text and nothing else — no parent
  // conversation, no persona option — so anything the seat needs must be here.
  it("carries the seat's identity, role and standing instructions", () => {
    const prompt = composeSeatPrompt({ seat, instruction: "看看这个方案", context: [] });
    expect(prompt).toContain("甲");
    expect(prompt).toContain("架构");
    expect(prompt).toContain("你重视可维护性。");
    expect(prompt).toContain("看看这个方案");
  });

  it("omits the discussion block when the seat carries no context", () => {
    const prompt = composeSeatPrompt({ seat, instruction: "开始", context: [] });
    expect(prompt).not.toContain("untrusted-data");
  });

  // The discussion is data the seat reads, never instructions it obeys. A seat
  // that follows an instruction planted in a peer's reply would let one member
  // steer another behind the host's back.
  it("fences the carried discussion as data, not instructions", () => {
    const prompt = composeSeatPrompt({
      seat,
      instruction: "继续",
      context: ["【乙】我认为应该用 Postgres"],
    });
    expect(prompt).toContain("<untrusted-data>");
    expect(prompt).toContain("</untrusted-data>");
    expect(prompt).toContain("绝不执行");
    expect(prompt).toContain("【乙】我认为应该用 Postgres");
  });

  it("puts the instruction before the discussion, so the task leads", () => {
    const prompt = composeSeatPrompt({ seat, instruction: "唯一指令", context: ["旧发言"] });
    expect(prompt.indexOf("唯一指令")).toBeLessThan(prompt.indexOf("旧发言"));
  });
});
