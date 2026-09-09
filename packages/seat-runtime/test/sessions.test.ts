/**
 * 席位的 CLI 会话记账。
 *
 * 这里的每一条都对应一个会真的咬人的场景：会话串味、失败之后永久卡死、
 * 折叠之后席位拿着被替换掉的历史继续答。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetSeatSession,
  forgetSeatSessions,
  rememberSeatSession,
  resetSeatSessions,
  seatSessionId,
} from "../src/sessions.ts";

describe("席位会话记账", () => {
  beforeEach(() => resetSeatSessions());

  it("同一个 agent 在两个团队里是两段对话", () => {
    // 樱木同时坐在两支团队里，两边的历史绝不能串。键是（父会话，席位名）。
    rememberSeatSession("team-a", "樱木", "sess-a");
    rememberSeatSession("team-b", "樱木", "sess-b");
    expect(seatSessionId("team-a", "樱木")).toBe("sess-a");
    expect(seatSessionId("team-b", "樱木")).toBe("sess-b");
  });

  it("没记过就是没有，不是空字符串", () => {
    // 调用方靠 undefined 决定「这是首轮，发全量窗口」。
    expect(seatSessionId("team-a", "樱木")).toBeUndefined();
  });

  it("没有 label 的请求不参与记账", () => {
    // 未命名的运行没有地址，硬记会把两个不同的东西挤到同一个键上。
    rememberSeatSession("team-a", undefined, "sess-x");
    expect(seatSessionId("team-a", undefined)).toBeUndefined();
  });

  it("忘掉一个不影响同团队的其他席位", () => {
    rememberSeatSession("team-a", "樱木", "sess-1");
    rememberSeatSession("team-a", "流川", "sess-2");
    forgetSeatSession("team-a", "樱木");
    expect(seatSessionId("team-a", "樱木")).toBeUndefined();
    expect(seatSessionId("team-a", "流川")).toBe("sess-2");
  });

  it("折叠清掉这个团队的全部，别的团队不动", () => {
    // 检查点替换了 Squad 发出去的历史，但 CLI 手里那份没法叫它忘掉——只能
    // 把整段对话丢掉。丢的范围必须精确到这一个父会话。
    rememberSeatSession("team-a", "樱木", "s1");
    rememberSeatSession("team-a", "流川", "s2");
    rememberSeatSession("team-b", "樱木", "s3");
    forgetSeatSessions("team-a");
    expect(seatSessionId("team-a", "樱木")).toBeUndefined();
    expect(seatSessionId("team-a", "流川")).toBeUndefined();
    expect(seatSessionId("team-b", "樱木")).toBe("s3");
  });

  it("前缀相近的父会话不会被误清", () => {
    // `team-a` 和 `team-a2` 只差一个字符，按裸前缀匹配会把后者一起清掉。
    rememberSeatSession("team-a", "甲", "s1");
    rememberSeatSession("team-a2", "甲", "s2");
    forgetSeatSessions("team-a");
    expect(seatSessionId("team-a2", "甲")).toBe("s2");
  });
});
