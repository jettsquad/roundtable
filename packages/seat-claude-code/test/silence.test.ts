import { describe, expect, it } from "vitest";
import { silenceVerdict } from "../src/index.ts";

const limits = { idleMs: 600_000, firstOutputMs: 90_000 };

describe("silenceVerdict", () => {
  it("一个字都没出来时，用短的那条线", () => {
    // 之前只有一条 10 分钟的线，而且从启动开始算。一个连不上端点的席位
    // 要在那儿杵满十分钟，界面上一直是「进行中」。
    expect(silenceVerdict(0, 89_000, limits)).toBeUndefined();
    expect(silenceVerdict(0, 90_000, limits)).toBe("no-output");
  });

  it("已经出过东西的，用长的那条线", () => {
    // 一个真在干活的席位可以很久不吭声；按 90 秒杀它会丢掉工作本身。
    expect(silenceVerdict(1, 90_000, limits)).toBeUndefined();
    expect(silenceVerdict(1, 599_000, limits)).toBeUndefined();
    expect(silenceVerdict(1, 600_000, limits)).toBe("silent");
  });

  it("两种判决分得开", () => {
    // 「从没答过」和「答着答着停了」要送人去不同的地方查：前者查端点，
    // 后者查这一轮在干什么。
    expect(silenceVerdict(0, 10 ** 9, limits)).toBe("no-output");
    expect(silenceVerdict(5, 10 ** 9, limits)).toBe("silent");
  });

  it("安静时长是从最后一个字节算的，不是从启动算的", () => {
    // 这是旧版真正错的地方：它 arm 一次就不再重置，所以那条注释说的
    // 「idle 而不是 total」在代码里根本不成立。
    expect(silenceVerdict(1000, 0, limits)).toBeUndefined();
  });
});
