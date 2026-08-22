import { describe, expect, it } from "vitest";
import { describeSeat, describeTeam, volume } from "../src/seat-status.ts";

const silence = { idleMs: 900_000, firstOutputMs: 120_000 };
const now = 1_000_000;

describe("席位状态判读", () => {
  it("跑不了的席位，先说跑不了", () => {
    // 阻塞压过一切：一个连接被删掉的席位就算 running，它也不在工作。
    const status = describeSeat({ running: true, blocked: "连接已删除", silence, now });
    expect(status.phase).toBe("blocked");
    expect(status.detail).toBe("连接已删除");
  });

  it("没轮到的席位是「待命」，不是没有状态", () => {
    expect(describeSeat({ running: false, silence, now }).phase).toBe("idle");
  });

  it("后端不上报进度时，如实说不知道", () => {
    // 这是整块显示存在的理由：没观察到的输出不能当成在输出。
    const status = describeSeat({ running: true, silence, now });
    expect(status.phase).toBe("starting");
    expect(status.detail).toContain("不上报进度");
  });

  it("刚起步、还没输出，算启动中", () => {
    const status = describeSeat({
      running: true,
      activity: { startedAt: now - 5_000, bytes: 0, lastOutputAt: now - 5_000 },
      silence,
      now,
    });
    expect(status.phase).toBe("starting");
    expect(status.detail).toBeUndefined();
  });

  it("一直没有第一个字，过了四成期限就开始报数", () => {
    // 报的是「还剩多久」，因为人要决定的是等还是叫停。
    const status = describeSeat({
      running: true,
      activity: { startedAt: now - 60_000, bytes: 0, lastOutputAt: now - 60_000 },
      silence,
      now,
    });
    expect(status.phase).toBe("stalling");
    expect(status.detail).toContain("1 分钟");
  });

  it("刚有输出就是正在输出", () => {
    const status = describeSeat({
      running: true,
      activity: { startedAt: now - 30_000, bytes: 4096, lastOutputAt: now - 1_000 },
      silence,
      now,
    });
    expect(status.phase).toBe("streaming");
    expect(status.detail).toContain("4.0 KB");
  });

  it("说过话但停了一阵，是思考中而不是卡死", () => {
    // 模型思考期间本来就会安静几十秒；把这段叫卡死会让真正的卡死没人信。
    const status = describeSeat({
      running: true,
      activity: { startedAt: now - 200_000, bytes: 900, lastOutputAt: now - 60_000 },
      silence,
      now,
    });
    expect(status.phase).toBe("quiet");
    expect(status.label).toContain("1 分钟");
  });

  it("静默超过阈值的四成，才升级成可能卡死", () => {
    const status = describeSeat({
      running: true,
      activity: { startedAt: now - 800_000, bytes: 900, lastOutputAt: now - 500_000 },
      silence,
      now,
    });
    expect(status.phase).toBe("stalling");
    expect(status.detail).toContain("判定卡死");
  });

  it("倒计时不会走成负数", () => {
    const status = describeSeat({
      running: true,
      activity: { startedAt: now - 2_000_000, bytes: 10, lastOutputAt: now - 2_000_000 },
      silence,
      now,
    });
    expect(status.detail).not.toContain("-");
  });

  it("字节数按人读的精度显示", () => {
    expect(volume(512)).toBe("512 字节");
    expect(volume(2048)).toBe("2.0 KB");
    expect(volume(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("整队一行", () => {
  it("没人在跑就没有这行", () => {
    expect(
      describeTeam([{ displayName: "甲", status: describeSeat({ running: false, silence, now }) }]),
    ).toBeUndefined();
  });

  it("点名到人，而不是报个数", () => {
    // 人要问的是「谁卡着」，不是「几个在跑」。
    const line = describeTeam([
      { displayName: "甲", status: describeSeat({ running: false, silence, now }) },
      {
        displayName: "乙",
        status: describeSeat({
          running: true,
          activity: { startedAt: now - 3_000, bytes: 100, lastOutputAt: now - 1_000 },
          silence,
          now,
        }),
      },
    ]);
    expect(line).toBe("乙（正在输出）");
  });

  it("跑不了的席位不算在忙", () => {
    expect(
      describeTeam([{ displayName: "甲", status: describeSeat({ running: true, blocked: "没连接", silence, now }) }]),
    ).toBeUndefined();
  });
});
