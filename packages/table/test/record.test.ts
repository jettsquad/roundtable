/**
 * The team record has to survive being written down.
 *
 * This is checked against dsh's OWN validator rather than against a
 * restatement of its rules, because a restatement would not have caught the
 * bug it exists for. `recordSpoken` wrote the message nested under `.message`
 * and `transcriptOf` read it back from `.message`; writer and reader agreed
 * perfectly, every in-process check passed, and the record was simply
 * unloadable from storage. It surfaced only when a session was opened in the
 * web UI: "session event at seq 3 lacks an identified message".
 *
 * A test can only find that class of bug by asking something outside this
 * package whether the bytes are acceptable.
 */
import { describe, expect, it } from "vitest";
import { adoptSessionEvent } from "@deepseek-ai/dsh-session";
import { spokenMessage } from "../src/service.ts";

const asEvent = (data: unknown) =>
  ({ type: "user/message", seq: 3, time: Date.now(), data }) as never;

describe("spokenMessage", () => {
  it("is accepted by the harness's own event validator", () => {
    expect(() => adoptSessionEvent(asEvent(spokenMessage("甲", "我认为可以")))).not.toThrow();
  });

  it("keeps a restored turn id, which migrated checkpoints point at", () => {
    expect(spokenMessage("甲", "x", "legacy-t2")["id"]).toBe("legacy-t2");
  });

  it("mints an id when none is supplied, since storage requires one", () => {
    expect(typeof spokenMessage("甲", "x")["id"]).toBe("string");
  });

  it("carries the speaker in the text, where a reader can see it", () => {
    expect(JSON.stringify(spokenMessage("乙", "反对"))).toContain("【乙】反对");
  });
});

describe("the shape that broke", () => {
  it("is rejected by the same validator — so this test is not vacuous", () => {
    // Exactly what was written before: the message nested one level down.
    const nested = { message: { id: "m1", source: { kind: "host" }, content: [{ type: "text", text: "x" }] } };
    expect(() => adoptSessionEvent(asEvent(nested))).toThrow(/identified message/);
  });

  it("rejects a message with no role, which the old shape also lacked", () => {
    const roleless = { id: "m1", source: { kind: "user" }, content: [{ type: "text", text: "x" }] };
    expect(() => adoptSessionEvent(asEvent(roleless))).toThrow(/role/);
  });
});
