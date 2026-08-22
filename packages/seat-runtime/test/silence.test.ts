import { describe, expect, it } from "vitest";
import { silenceMessage, silenceVerdict } from "../src/silence.ts";

const limits = { idleMs: 600_000, firstOutputMs: 90_000 };

describe("silenceVerdict", () => {
  it("一个字都没出来时，用短的那条线", () => {
    expect(silenceVerdict(0, 89_000, limits)).toBeUndefined();
    expect(silenceVerdict(0, 90_000, limits)).toBe("no-output");
  });

  it("已经出过东西的，用长的那条线", () => {
    expect(silenceVerdict(1, 90_000, limits)).toBeUndefined();
    expect(silenceVerdict(1, 600_000, limits)).toBe("silent");
  });

  it("两种判决分得开", () => {
    // 「从没答过」查端点，「答着停了」查这一轮——两个不同的地方。
    expect(silenceVerdict(0, 10 ** 9, limits)).toBe("no-output");
    expect(silenceVerdict(5, 10 ** 9, limits)).toBe("silent");
  });

  it("安静时长从最后一个字节算起", () => {
    expect(silenceVerdict(1000, 0, limits)).toBeUndefined();
  });
});

describe("silenceMessage", () => {
  it("两条消息把人送去不同的地方", () => {
    expect(silenceMessage("no-output", limits)).toMatch(/连不上/);
    expect(silenceMessage("no-output", limits)).toMatch(/90 秒/);
    expect(silenceMessage("silent", limits)).toMatch(/600 秒/);
    expect(silenceMessage("silent", limits)).not.toMatch(/连不上/);
  });
});
