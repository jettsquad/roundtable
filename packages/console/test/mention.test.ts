import { describe, expect, it } from "vitest";
import { parseMentions } from "../src/mention.ts";

const seats = ["架构", "测试员", "架构组"];

describe("parseMentions", () => {
  it("开头的 @ 是点名，中间的不是", () => {
    // 「问一下 @架构 和运维」是在说一件事，不是在点名。整串去找 @ 的解析器
    // 分不出这两种。
    expect(parseMentions("@架构 看看这个", seats)).toMatchObject({ named: ["架构"], instruction: "看看这个" });
    expect(parseMentions("问一下 @架构 和运维", seats)).toMatchObject({ named: [], unknown: [] });
  });

  it("点多个人", () => {
    const got = parseMentions("@架构 @测试员 一起看", seats);
    expect(got.named).toEqual(["架构", "测试员"]);
    expect(got.instruction).toBe("一起看");
  });

  it("最长的名字优先", () => {
    // 「@架构组」不能被读成「@架构」加一个「组」字。
    expect(parseMentions("@架构组 来", seats).named).toEqual(["架构组"]);
  });

  it("点名和正文之间的标点被吃掉", () => {
    expect(parseMentions("@架构, @测试员： 说说", seats).instruction).toBe("说说");
  });

  it("名字打错了要说出来，不能当成没点名", () => {
    // 静悄悄地发给全团，而界面上看起来是只问了一个人——这是最坏的那种失败。
    const got = parseMentions("@架构师 看看", seats);
    expect(got.unknown).toEqual(["架构师"]);
    expect(got.named).toEqual([]);
  });

  it("不点名就是全体", () => {
    expect(parseMentions("大家说说", seats)).toMatchObject({ named: [], instruction: "大家说说" });
  });

  it("同一个人点两次只算一次", () => {
    expect(parseMentions("@架构 @架构 说", seats).named).toEqual(["架构"]);
  });
});
