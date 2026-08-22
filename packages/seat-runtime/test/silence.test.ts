import { describe, expect, it } from "vitest";
import { SEAT_SILENCE_LIMITS, silenceMessage, silenceVerdict } from "../src/silence.ts";

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
    // 「一个字都没输出」多半是端点错了，「说到一半停了」是另一回事——
    // 两种情况人要去查的地方不一样，所以文案不能共用。
    expect(silenceMessage("no-output", limits)).toMatch(/连不上/);
    expect(silenceMessage("no-output", limits)).toMatch(/2 分钟/);
    expect(silenceMessage("silent", limits)).toMatch(/10 分钟/);
    expect(silenceMessage("silent", limits)).not.toMatch(/连不上/);
  });

  it("卡死那条要说清判据是静默，不是耗时", () => {
    // 不写这句，人会以为「跑得久就会被杀」，于是不敢派长任务。
    expect(silenceMessage("silent", limits)).toMatch(/有输出.*就重新计时/);
  });
});

describe("SEAT_SILENCE_LIMITS", () => {
  it("静默阈值就是 1.x 的十五分钟", () => {
    // 1.x 的四个执行器各写了一遍 900_000，恰好一致但没有任何东西保证它们一致。
    // 这里是唯一的一份，这条测试是把它钉住的那颗钉子。
    expect(SEAT_SILENCE_LIMITS.idleMs).toBe(900_000);
  });

  it("首字期限远短于静默期限", () => {
    // 一个字都没出来，多半是端点连不上；让人等十五分钟去证明一件连接测试
    // 一秒就能证明的事，是把耐心花在没有信息量的地方。
    expect(SEAT_SILENCE_LIMITS.firstOutputMs).toBeLessThan(SEAT_SILENCE_LIMITS.idleMs / 2);
  });

  it("首字期限要给冷启动留出成倍的余量", () => {
    // 实测：dsh 席位一轮的首字用了约 100 秒（profile 启动 + 首个 token）。
    // 期限压到那个数字附近，迟早会杀掉一个正在正常工作的席位——
    // 而一个乱叫的看门狗，会在它真正叫对的那天被忽略。
    expect(SEAT_SILENCE_LIMITS.firstOutputMs).toBeGreaterThanOrEqual(100_000 * 2.5);
  });
});
