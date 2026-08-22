import { describe, expect, it } from "vitest";
import { applyMention, mentionCandidates, mentionDraftAt, parseMentions } from "../src/mention.ts";

const seats = ["架构师", "架构组", "赤木晴子", "水户洋平"];

describe("@ 名单浮层", () => {
  it("刚敲下 @ 就给全部成员", () => {
    const draft = mentionDraftAt("@", 1, seats);
    expect(draft).toEqual({ at: 0, typed: "" });
    expect(mentionCandidates(draft!, seats)).toEqual(seats);
  });

  it("敲了几个字就按前缀筛，前缀匹配排前面", () => {
    const draft = mentionDraftAt("@架构", 3, seats)!;
    expect(mentionCandidates(draft, seats)).toEqual(["架构师", "架构组"]);
  });

  it("空格之后就不是在点名了", () => {
    // 越过空格人已经在写正文；这时候还弹名单，选中就会把名字塞进句子里。
    expect(mentionDraftAt("@架构师 看看这个", 9, seats)).toBeUndefined();
  });

  it("句子中间的 @ 不弹名单", () => {
    // parseMentions 只认开头的点名，所以这里选中了也不会生效——
    // 弹出来就是一个选了不算数的菜单。
    expect(mentionDraftAt("联系我 @架构", 7, seats)).toBeUndefined();
  });

  it("第二个 @ 仍然算点名", () => {
    const draft = mentionDraftAt("@架构师 @赤木", 8, seats);
    expect(draft?.typed).toBe("赤木");
  });

  it("选中后补一个空格，并把光标放在它后面", () => {
    // 没有这个空格，接着敲的字会长进名字里，parseMentions 就会报一个不存在的成员。
    const draft = mentionDraftAt("@架构", 3, seats)!;
    const applied = applyMention("@架构", 3, draft, "架构师");
    expect(applied.text).toBe("@架构师 ");
    expect(applied.caret).toBe(5);
    expect(parseMentions(applied.text, seats).named).toEqual(["架构师"]);
  });

  it("选中不吃掉光标后面已经写好的正文", () => {
    const raw = "@架看看这个";
    const draft = mentionDraftAt(raw, 2, seats)!;
    expect(applyMention(raw, 2, draft, "架构师").text).toBe("@架构师 看看这个");
  });
});
