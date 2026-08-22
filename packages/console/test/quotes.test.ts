import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearQuotes, quotedIn, toggleQuote } from "../src/client/quotes.ts";

beforeEach(() => {
  clearQuotes("a");
  clearQuotes("b");
});

describe("引用选择", () => {
  it("按一下选中，再按一下取消", () => {
    toggleQuote("a", "t1");
    expect(quotedIn("a")).toEqual(["t1"]);
    toggleQuote("a", "t1");
    expect(quotedIn("a")).toEqual([]);
  });

  it("保持点选的顺序", () => {
    // 引用会按这个顺序进提示词；乱序会让「先看这条再看那条」变成别的意思。
    toggleQuote("a", "t2");
    toggleQuote("a", "t1");
    expect(quotedIn("a")).toEqual(["t2", "t1"]);
  });

  it("按团队分开", () => {
    // 两支团队的会话可以同时开着；在一支里点的引用不能跑到另一支的下一轮里。
    toggleQuote("a", "t1");
    expect(quotedIn("b")).toEqual([]);
  });

  it("清空只清这一支", () => {
    toggleQuote("a", "t1");
    toggleQuote("b", "t9");
    clearQuotes("a");
    expect(quotedIn("a")).toEqual([]);
    expect(quotedIn("b")).toEqual(["t9"]);
  });

  it("没得清的时候不通知", () => {
    // 轮询每两秒跑一次；每次都通知会把正在打的字连输入框一起重建。
    const heard = vi.fn();
    clearQuotes("a");
    expect(heard).not.toHaveBeenCalled();
  });
});
