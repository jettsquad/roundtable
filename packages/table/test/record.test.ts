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
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adoptSessionEvent } from "@deepseek-ai/dsh-session";
import { sessionMarkEvents, spokenMessage } from "../src/service.ts";

const asEvent = (data: unknown) => ({ type: "user/message", seq: 3, time: Date.now(), data }) as never;

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

/**
 * The marker events.
 *
 * `markSession` wrote `turn: 0`, meaning 「这不是真的一轮」. `turn` has no
 * such meaning: dsh's loop continues counting from it, and its persistence
 * layer refuses anything below 1 — at LOAD, so 51 sessions were written
 * cleanly and became unresumable, surfacing days later as a failed rename.
 *
 * WHAT THIS TEST CAN AND CANNOT REACH, stated because the difference is the
 * whole point of this file. `adoptSessionEvent` is dsh's in-memory validator
 * and it accepts `turn: 0` quite happily — verified below, so nobody
 * mistakes it for cover it does not give. The rule that refuses lives in
 * `migrateLegacyTurnEndEvent`, in `@deepseek-ai/dsh-session-persistence`,
 * and that function is not exported; the only public way in is a coordinator
 * that needs a real storage backend.
 *
 * So the turn number below IS a restatement of somebody else's rule — the
 * thing this file otherwise refuses to do. It is labelled as one, and it
 * names where the real rule lives, so the next person can check whether it
 * still says what we think. The shape of the message event, which dsh's
 * reachable validator does cover, is checked properly.
 */
describe("sessionMarkEvents", () => {
  const asEventOf = (type: string, data: unknown) => ({ type, seq: 3, time: Date.now(), data }) as never;

  it("每一条都能被 dsh 自己的事件校验器收下", () => {
    for (const event of sessionMarkEvents("樱木军团")) {
      expect(() => adoptSessionEvent(asEventOf(event.type, event.data)), event.type).not.toThrow();
    }
  });

  it("开一个 turn——没有 turn/start 的会话会被当成空白会话回收掉", () => {
    // Not decoration: dsh hides a session with no `turn/start` from the
    // sidebar and hands it to the next 新建会话. That is 「新建的 session 会
    // 消失」, and this event is the fix for it.
    expect(sessionMarkEvents("t").map((event) => event.type)).toEqual(["turn/start", "user/message", "turn/end"]);
  });

  it("轮次号从 1 起，永远不是 0", () => {
    // The restatement. Real rule: `migrateLegacyTurnEndEvent` refuses
    // `data.turn < 1` when a stored session is read back.
    for (const event of sessionMarkEvents("t")) {
      if (event.type === "user/message") continue;
      expect(event.data["turn"]).toBe(1);
    }
  });
});

describe("为什么这里只能复述规则", () => {
  it("dsh 的内存校验器根本不看 turn——它给不了这层保护", () => {
    // Written down rather than assumed. Had this been left out, the test
    // above would read as 「已经交给 dsh 校验过了」 while covering nothing of
    // the kind — and the next person to touch the marker would trust it.
    const zero = { type: "turn/end", seq: 5, time: Date.now(), data: { turn: 0, reason: { kind: "completed" } } };
    expect(() => adoptSessionEvent(zero as never)).not.toThrow();
  });
});

/**
 * The shim that lied.
 *
 * `LiveSession` is hand-written — the sessions service is reached through the
 * untyped `ctx.reflect.get` — so every member of it is an assumption nothing
 * checks. It declared `events`, dsh 0.1.2 removed that property, and the
 * upgrade type-checked clean while the mark threw at runtime into a catch
 * that logged through two optional chains and therefore said nothing. Every
 * new sitting came out unmarked, which reaches a person as 「点新开一场没反应」.
 *
 * Reading the source is the only check available, so that is what this does.
 */
describe("markLiveSession 读会话事件的方式", () => {
  const raw = readFileSync(new URL("../src/service.ts", import.meta.url), "utf8");
  /**
   * Comments stripped before matching.
   *
   * The first version of this test failed on the prose that explains the very
   * bug it guards — a comment naming `session.events` read as a use of it.
   * A test about what the code DOES has no business reading what it says.
   */
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("用 snapshotEvents()，不用已经不存在的 .events", () => {
    expect(source).toContain("session.snapshotEvents().some(");
    expect(source).not.toMatch(/session\.events\b/);
  });

  it("LiveSession 只声明 dsh 现在真的有的东西", () => {
    const start = source.indexOf("interface LiveSession");
    const shim = source.slice(start, source.indexOf("\n}", start));
    expect(shim).toContain("snapshotEvents()");
    expect(shim).not.toMatch(/readonly events\b/);
  });

  it("标记失败会喊出来，而不是只走可能不存在的 logger", () => {
    // The catch used to be `this.ctx.logger?.warn?.(…)` and nothing else: two
    // optional chains, so a composition with no logger printed nothing while
    // a whole feature was broken.
    const scope = source.slice(source.indexOf("没能给会话留下标记"));
    expect(scope.slice(0, 400)).toContain("console.warn");
  });
});
