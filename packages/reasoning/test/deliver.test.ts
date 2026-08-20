/**
 * Delivery. The budget and the audience are the two things that keep a
 * criteria library from turning into either noise or an echo chamber, and
 * both are enforced here rather than left to whoever renders the result.
 */
import { describe, expect, it } from "vitest";
import {
  DELIVERY_LIMIT,
  buildSelectionPrompt,
  formatForSystemChannel,
  parseSelection,
  triggerMatches,
} from "../src/deliver.ts";
import type { Criterion } from "../src/criterion.ts";
import type { Situation } from "@squad/shared";

const make = (id: string, over: Partial<Criterion> = {}): Criterion => ({
  id,
  trigger: { action: ["design-mechanism"], features: ["automatic"] },
  claim: `${id} 的主张`,
  evidence: ["i-1"],
  status: "active",
  ...over,
});

const situation: Situation = {
  action: "design-mechanism",
  features: ["automatic", "invisible-result"],
};

describe("triggerMatches", () => {
  it("admits a situation carrying every required feature", () => {
    expect(triggerMatches(make("c1"), situation)).toBe(true);
  });

  it("admits a partial feature overlap, on purpose", () => {
    // Corrected against evidence: as a strict conjunction, a criterion filed
    // under {automatic, invisible-result} missed a phase labelled
    // {automatic, changes-default} — two model calls labelling the same
    // situation from a closed list, both defensibly, and disagreeing. The
    // asymmetry settles it: over-fetching is dropped by the selection step,
    // under-fetching is never seen by anything that could judge it.
    const overlapping = make("c2", {
      trigger: { action: ["design-mechanism"], features: ["automatic", "irreversible"] },
    });
    expect(triggerMatches(overlapping, situation)).toBe(true);
  });

  it("rejects a trigger sharing no feature at all with the situation", () => {
    // Coarse, not absent. Nothing in common is still nothing in common.
    const unrelated = make("c2b", {
      trigger: { action: ["design-mechanism"], features: ["benchmark-backed"] },
    });
    expect(triggerMatches(unrelated, situation)).toBe(false);
  });

  it("fires on the action alone when the trigger names no features", () => {
    const broad = make("c2c", { trigger: { action: ["design-mechanism"], features: [] } });
    expect(triggerMatches(broad, { action: "design-mechanism", features: [] })).toBe(true);
  });

  it("does not match a different action", () => {
    expect(triggerMatches(make("c3"), { ...situation, action: "produce-document" })).toBe(false);
  });

  it("never surfaces a retired criterion", () => {
    expect(triggerMatches(make("c4", { status: "retired" }), situation)).toBe(false);
  });

  it("still surfaces a suspect one", () => {
    // Suspect means "under review", not "withdrawn". Hiding it would remove
    // the thing most likely to attract the counter-example that settles it.
    expect(triggerMatches(make("c5", { status: "suspect" }), situation)).toBe(true);
  });

  it("honours a step restriction when the criterion carries one", () => {
    const stepped = make("c6", {
      trigger: { action: ["design-mechanism"], features: ["automatic"], step: ["evaluate"] },
    });
    expect(triggerMatches(stepped, situation)).toBe(false);
    expect(triggerMatches(stepped, { ...situation, step: "evaluate" })).toBe(true);
  });
});

describe("parseSelection", () => {
  const candidates = [make("c1"), make("c2"), make("c3"), make("c4")];

  it("keeps the chosen criteria in the order the model gave", () => {
    expect(parseSelection('["c3","c1"]', candidates).map((c) => c.id)).toEqual(["c3", "c1"]);
  });

  it("caps at the budget even when the model ignores it", () => {
    // A budget that depends on a model honouring it is not a budget.
    expect(parseSelection('["c1","c2","c3","c4"]', candidates)).toHaveLength(DELIVERY_LIMIT);
  });

  it("refuses an id that was never offered", () => {
    // Dropping it silently would deliver fewer criteria than intended and
    // look identical to a library that simply had nothing to say.
    expect(() => parseSelection('["c9"]', candidates)).toThrow(/c9/);
  });

  it("accepts an empty selection", () => {
    expect(parseSelection("[]", candidates)).toEqual([]);
  });
});

describe("formatForSystemChannel", () => {
  it("marks them as criteria rather than instructions", () => {
    expect(formatForSystemChannel([make("c1")])).toContain("是判据不是指令");
  });

  it("says they are in force, because the point is to be corrected", () => {
    expect(formatForSystemChannel([make("c1")])).toContain("现在生效中");
  });

  it("shows what each one grew from", () => {
    // A wrong abstraction should be obvious at a glance rather than taken on
    // the system's word.
    const text = formatForSystemChannel([make("c1", { evidence: ["i-a", "i-b"] })]);
    expect(text).toContain("2 条实例（i-a、i-b）");
  });

  it("shows the boundary when one has grown", () => {
    const text = formatForSystemChannel([make("c1", { boundary: "平凡可逆时不适用" })]);
    expect(text).toContain("边界：平凡可逆时不适用");
  });

  it("says so plainly when nothing applies", () => {
    expect(formatForSystemChannel([])).toContain("没有可用的判据");
  });
});

describe("buildSelectionPrompt", () => {
  it("tells the model to respect boundaries over claims", () => {
    const prompt = buildSelectionPrompt(situation, [make("c1", { boundary: "平凡可逆时不适用" })]);
    expect(prompt).toContain("适用边界");
    expect(prompt).toContain("平凡可逆时不适用");
  });

  it("asks for fewer rather than more", () => {
    // Over-delivering gets the whole block skipped, which is worse than
    // delivering nothing — it costs the budget AND the attention.
    expect(buildSelectionPrompt(situation, [make("c1")])).toContain("宁少勿多");
  });
});
