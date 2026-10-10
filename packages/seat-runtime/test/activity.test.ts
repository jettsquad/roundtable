import { beforeEach, describe, expect, it } from "vitest";
import {
  activityFor,
  activityKey,
  beginActivity,
  endActivity,
  onQuietCommand,
  raiseQuiet,
  reportActivity,
  reportDoing,
  resetActivity,
  setQuietVerdict,
  type QuietCommand,
} from "../src/activity.ts";

beforeEach(resetActivity);

describe("席位活动登记", () => {
  it("没登记就查不到，而不是编一个出来", () => {
    expect(activityFor(activityKey("s1", "甲"))).toBeUndefined();
  });

  it("开始时就有条目，哪怕还没有任何输出", () => {
    // 「已派发但还没出字」本身就是一个要给人看的状态；等到有输出才登记，
    // 最需要状态的那一段恰好什么都不显示。
    const key = activityKey("s1", "甲");
    beginActivity(key, 1000);
    expect(activityFor(key)).toEqual({ startedAt: 1000, bytes: 0, lastOutputAt: 1000 });
  });

  it("字节数变了才推进时钟", () => {
    // 静默的定义就是「字节数没变」。把没变也算成新输出，看门狗会杀，
    // 屏幕却一直显示「正在输出」——两边对同一件事给出相反的说法。
    const key = activityKey("s1", "甲");
    beginActivity(key, 1000);
    reportActivity(key, 500, 2000);
    reportActivity(key, 500, 9000);
    expect(activityFor(key)).toEqual({ startedAt: 1000, bytes: 500, lastOutputAt: 2000 });
  });

  it("字节数回退不算输出", () => {
    const key = activityKey("s1", "甲");
    beginActivity(key, 1000);
    reportActivity(key, 500, 2000);
    reportActivity(key, 100, 3000);
    expect(activityFor(key)?.bytes).toBe(500);
  });

  it("跑完就清掉", () => {
    // 没人清的条目会一直报「这个席位在工作」——那比什么都不显示更糟，
    // 因为它是一个断言。
    const key = activityKey("s1", "甲");
    beginActivity(key, 1000);
    endActivity(key);
    expect(activityFor(key)).toBeUndefined();
  });

  it("对没登记的席位上报不会凭空造出条目", () => {
    // 上一轮结束后迟到的一次 tick 不该把席位复活。
    const key = activityKey("s1", "甲");
    reportActivity(key, 900, 5000);
    expect(activityFor(key)).toBeUndefined();
  });

  it("同名席位分属两支团队，互不干扰", () => {
    // 名字在一支团队的名册里唯一，跨团队不唯一——所以键里带会话 id。
    beginActivity(activityKey("s1", "甲"), 1000);
    beginActivity(activityKey("s2", "甲"), 2000);
    reportActivity(activityKey("s1", "甲"), 10, 1500);
    expect(activityFor(activityKey("s2", "甲"))?.bytes).toBe(0);
  });

  it("重新开始会清掉上一轮的残留", () => {
    const key = activityKey("s1", "甲");
    beginActivity(key, 1000);
    reportActivity(key, 800, 1500);
    beginActivity(key, 9000);
    expect(activityFor(key)).toEqual({ startedAt: 9000, bytes: 0, lastOutputAt: 9000 });
  });
});

describe("席位在跑什么", () => {
  const who = { parentSessionId: "s1", label: "甲" };
  const command = { id: "b1", tool: "Bash", command: "pytest -q", startedAt: 1000, background: true };

  it("记下输出流里还没结束的命令，和它说的最后一句话", () => {
    const key = activityKey("s1", "甲");
    beginActivity(key, 1000);
    reportDoing(key, [command], "等测试跑完。");
    expect(activityFor(key)).toMatchObject({ doing: [command], lastWords: "等测试跑完。" });
  });

  it("没人能判断时，结论是请主持人看，而不是默认没事", () => {
    const key = activityKey("s1", "甲");
    beginActivity(key, 1000);
    raiseQuiet(key, who, 900_000, 5000);
    expect(activityFor(key)?.verdict).toMatchObject({ verdict: "ask", by: "system", at: 5000 });
  });

  it("有人听时，把席位、命令和安静了多久交给他，由他来写结论", () => {
    const key = activityKey("s1", "甲");
    beginActivity(key, 1000);
    reportDoing(key, [command]);
    const heard: QuietCommand[] = [];
    const stop = onQuietCommand((quiet) => heard.push(quiet));
    raiseQuiet(key, who, 900_000);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ key, parentSessionId: "s1", label: "甲", quietForMs: 900_000 });
    expect(heard[0]?.activity.doing).toEqual([command]);
    // 结论由听的人写；登记处自己不替他下。
    expect(activityFor(key)?.verdict).toBeUndefined();
    setQuietVerdict(key, { verdict: "wait", reason: "在跑测试。", at: 6000, by: "secretary" });
    expect(activityFor(key)?.verdict?.verdict).toBe("wait");

    stop();
    raiseQuiet(key, who, 900_000);
    expect(heard).toHaveLength(1);
  });

  it("一个听的人出错，不影响另一个", () => {
    const key = activityKey("s1", "甲");
    beginActivity(key, 1000);
    let reached = false;
    onQuietCommand(() => {
      throw new Error("boom");
    });
    onQuietCommand(() => {
      reached = true;
    });
    expect(() => raiseQuiet(key, who, 900_000)).not.toThrow();
    expect(reached).toBe(true);
  });

  it("又有输出了，上一段沉默的结论就不再挂着", () => {
    // 结论说的是那一段沉默。席位已经重新开口，屏幕上还写着
    // 「秘书：继续等」，就是在描述一件已经结束的事。
    const key = activityKey("s1", "甲");
    beginActivity(key, 1000);
    reportActivity(key, 10, 1100);
    setQuietVerdict(key, { verdict: "wait", reason: "在跑测试。", at: 2000, by: "secretary" });
    reportActivity(key, 10, 3000);
    expect(activityFor(key)?.verdict).toBeDefined();
    reportActivity(key, 11, 4000);
    expect(activityFor(key)?.verdict).toBeUndefined();
  });

  it("席位已经结束后才来的结论，不会让它复活", () => {
    const key = activityKey("s1", "甲");
    beginActivity(key, 1000);
    endActivity(key);
    setQuietVerdict(key, { verdict: "ask", reason: "x", at: 1, by: "system" });
    raiseQuiet(key, who, 900_000);
    expect(activityFor(key)).toBeUndefined();
  });
});
