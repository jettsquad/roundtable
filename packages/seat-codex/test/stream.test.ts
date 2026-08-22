import { describe, expect, it } from "vitest";
import { readCodexStream } from "../src/stream.ts";

const line = (o: unknown) => JSON.stringify(o);
const msg = (text: string) => line({ type: "item.completed", item: { type: "agent_message", text } });

describe("readCodexStream", () => {
  it("取最后一条 agent_message，不是拼起来", () => {
    // 一轮会发好几条 agent_message，只有最后一条是答复。拼起来就成了
    // 一份复述自己思考过程的回答。
    const got = readCodexStream([msg("先想想"), msg("最终答复")].join("\n"));
    expect(got.text).toBe("最终答复");
    expect(got.failed).toBe(false);
  });

  it("非 JSON 的行跳过（stderr 进度会混进来）", () => {
    expect(readCodexStream(["正在思考…", msg("答复"), ""].join("\n")).text).toBe("答复");
  });

  it("被截断的最后一行不会让整个解析炸掉", () => {
    // 进程被杀时最后一行写了一半，这是常态。
    expect(readCodexStream([msg("答复"), '{"type":"turn.comp'].join("\n")).text).toBe("答复");
  });

  it("用量来自 turn.completed，缓存单独一列", () => {
    const raw = [
      msg("答复"),
      line({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 90, output_tokens: 5 } }),
    ].join("\n");
    expect(readCodexStream(raw).usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 90,
      cacheCreationTokens: 0,
    });
  });

  it("没报用量就是没有，不是 0", () => {
    // 「报了 0」和「没报」是两件事，只有一件是好消息。
    expect(readCodexStream(msg("答复")).usage).toBeUndefined();
    expect(readCodexStream([msg("答复"), line({ type: "turn.completed" })].join("\n")).usage).toBeUndefined();
  });

  it("turn.failed 和 error 都算失败，并带上原因", () => {
    const got = readCodexStream([msg("半截"), line({ type: "turn.failed", message: "配额用完了" })].join("\n"));
    expect(got.failed).toBe(true);
    expect(got.detail).toBe("配额用完了");
  });

  it("没有答复本身就是失败", () => {
    // 空回复读起来像「这位没什么要说的」——那是唯一一种会掩盖坏掉的运行的读法。
    expect(readCodexStream("").failed).toBe(true);
    expect(readCodexStream(msg("   ")).failed).toBe(true);
  });
});
