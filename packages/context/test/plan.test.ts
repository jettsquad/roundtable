/**
 * The three decisions a fold makes, each of which 1.x got wrong at least once.
 * They are quiet failures: every one of them produces a checkpoint that looks
 * fine and costs the team something it cannot see it has lost.
 */
import { describe, expect, it } from "vitest";
import { planFold } from "../src/plan.ts";
import { SPEECH_KIND } from "../src/timeline.ts";
import type { SelectableEvent } from "../src/window.ts";

const said = (turnId: string, speaker: string, text: string): SelectableEvent => ({
  kind: SPEECH_KIND,
  text: `【${speaker}】${text}`,
  turnId,
});

describe("planFold", () => {
  it("covers up to the last entry that exists when the fold starts", () => {
    // Named up front, because the secretary writes without stopping the team:
    // rounds land while it works and are recorded before the checkpoint is
    // stored. Cutting at the checkpoint's own position later would drop turns
    // it never saw, with nothing standing in for them.
    const plan = planFold([said("t1", "甲", "一"), said("t2", "乙", "二"), said("t3", "甲", "三")]);
    expect(plan?.coversUpTo).toBe("t3");
  });

  it("takes every pending entry as input, not just the last round", () => {
    const plan = planFold([said("t1", "甲", "一"), said("t2", "乙", "二")]);
    expect(plan?.turns).toEqual([
      { speaker: "甲", text: "一" },
      { speaker: "乙", text: "二" },
    ]);
  });

  it("passes the previous checkpoint through as input rather than as material", () => {
    // Settled items are inherited verbatim. Re-condensing a condensed
    // document loses a little more of it on every fold.
    const plan = planFold([said("t1", "甲", "一")], "## 已定事项\n上一份的结论");
    expect(plan?.previousCheckpoint).toBe("## 已定事项\n上一份的结论");
  });

  it("omits the previous checkpoint entirely for a first fold", () => {
    // Omitted, not undefined-valued: the prompt builder branches on absence,
    // and a present-but-empty field would send continuation instructions with
    // nothing to continue from.
    expect(planFold([said("t1", "甲", "一")])).not.toHaveProperty("previousCheckpoint");
  });

  it("refuses to plan a fold over a record with no identifiable boundary", () => {
    // A checkpoint whose coversUpTo matches nothing reads, later, as a
    // checkpoint whose coverage is missing from the log.
    expect(planFold([{ kind: SPEECH_KIND, text: "没有身份的一条" }])).toBeUndefined();
    expect(planFold([])).toBeUndefined();
  });

  it("finds the boundary even when the newest entries carry no identity", () => {
    const plan = planFold([said("t1", "甲", "一"), { kind: "session/title", text: "" }]);
    expect(plan?.coversUpTo).toBe("t1");
  });

  it("keeps a line that was never prefixed with a speaker", () => {
    // Dropped instead, the checkpoint would silently lose whatever it was.
    const plan = planFold([{ kind: SPEECH_KIND, text: "没有前缀的一句", turnId: "t1" }]);
    expect(plan?.turns).toEqual([{ speaker: "记录", text: "没有前缀的一句" }]);
  });
});
