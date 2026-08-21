/**
 * Reading a finished run. Every fallback here is a real case, which is why
 * they are ordered rather than collapsed into "take whatever is there".
 */
import { describe, expect, it } from "vitest";
import { readStream } from "../src/stream.ts";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const assistant = (text: string) => line({ type: "assistant", message: { content: [{ type: "text", text }] } });
const result = (over: Record<string, unknown> = {}) =>
  line({ type: "result", subtype: "success", is_error: false, result: "信封里的文本", ...over });

describe("readStream", () => {
  it("prefers what was streamed over the envelope's summary", () => {
    // A long turn's envelope can summarise while the assistant blocks carry
    // what was actually said.
    expect(readStream(assistant("真正说的话") + result()).text).toBe("真正说的话");
  });

  it("falls back to the envelope when nothing streamed", () => {
    expect(readStream(result()).text).toBe("信封里的文本");
  });

  it("joins several assistant blocks in order", () => {
    expect(readStream(assistant("第一段") + assistant("第二段") + result()).text).toBe("第一段\n\n第二段");
  });

  it("reports an error envelope as failed while keeping the text", () => {
    // The text still travels: a failed run that explains itself is worth more
    // than a failed run that does not.
    const outcome = readStream(assistant("我做不了") + result({ is_error: true, subtype: "error_during_execution" }));
    expect(outcome.failed).toBe(true);
    expect(outcome.text).toBe("我做不了");
    expect(outcome.subtype).toBe("error_during_execution");
  });

  it("treats a non-success subtype as failed even without is_error", () => {
    expect(readStream(result({ subtype: "error_max_turns", is_error: false }).valueOf()).failed).toBe(true);
  });

  it("falls back to plain text when there is no envelope at all", () => {
    // An older CLI, or a run that died before stream-json began.
    expect(readStream("就是一句普通输出")).toEqual({ text: "就是一句普通输出", failed: false });
  });

  it("treats no output at all as a failure", () => {
    // A seat that returns nothing and a seat that returned "" read the same
    // to everything downstream, so they must not read the same here.
    expect(readStream("   ")).toEqual({ text: "", failed: true });
  });

  it("survives a malformed line among good ones", () => {
    expect(readStream("{not json\n" + assistant("还在") + result()).text).toBe("还在");
  });
});
