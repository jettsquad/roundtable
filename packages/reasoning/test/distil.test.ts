/**
 * Distillation is where a standard is separated from a conclusion, and where
 * a counter-example is allowed to narrow something instead of being filed as
 * a new claim that contradicts it.
 */
import { describe, expect, it } from "vitest";
import { buildDistilPrompt, parseDistillation } from "../src/distil.ts";
import type { Criterion } from "../src/criterion.ts";

const existing: Criterion = {
  id: "c-invisible",
  trigger: { action: ["design-mechanism"], features: ["automatic", "invisible-result"] },
  claim: "不可见的自动机制，其失败模式必然是静默的。",
  evidence: ["i-0"],
  status: "active",
};

describe("buildDistilPrompt", () => {
  it("asks for the standard rather than the conclusion", () => {
    // The distinction the whole system lives or dies on: a conclusion cannot
    // transfer to another situation, a standard can.
    const prompt = buildDistilPrompt({
      situation: { action: "design-mechanism", features: ["automatic"] },
      proposed: "自动折叠不提示",
      verdict: "要告知",
      candidates: [],
    });
    expect(prompt).toContain("写**标准**，不要写**结论**");
  });

  it("shows the existing boundary of each candidate", () => {
    // Without it the model proposes a counter-example against a boundary that
    // already covers the case.
    const prompt = buildDistilPrompt({
      situation: { action: "design-mechanism", features: ["automatic"] },
      proposed: "x",
      verdict: "y",
      candidates: [{ ...existing, boundary: "平凡可逆时不适用" }],
    });
    expect(prompt).toContain("已有边界：平凡可逆时不适用");
  });
});

describe("parseDistillation", () => {
  it("reads a counter-example that narrows an existing criterion", () => {
    const result = parseDistillation(
      JSON.stringify({
        relation: "counter-example",
        criterionId: "c-invisible",
        claim: "不可见的自动机制，其失败模式必然是静默的。",
        boundary: "动作平凡可逆时不适用（例如自动格式化）。",
      }),
      [existing],
    );
    expect(result.relation).toBe("counter-example");
    expect(result.boundary).toContain("平凡可逆");
  });

  it("tolerates prose around the object", () => {
    const result = parseDistillation('好的：\n{"relation":"new","claim":"要给出迁移成本估算"}\n', []);
    expect(result.claim).toBe("要给出迁移成本估算");
  });

  it("refuses a non-new relation that names no criterion", () => {
    // Downgrading it to `new` is how a library ends up holding two claims
    // that contradict each other, with nothing recording they ever met.
    expect(() => parseDistillation('{"relation":"revise","claim":"x"}', [existing])).toThrow(/哪一条/);
  });

  it("refuses a relation naming a criterion that was not a candidate", () => {
    expect(() => parseDistillation('{"relation":"reinforce","criterionId":"c-nope","claim":"x"}', [existing])).toThrow(
      /不在候选/,
    );
  });

  it("refuses an unknown relation", () => {
    expect(() => parseDistillation('{"relation":"merge","claim":"x"}', [])).toThrow(/未知的关系/);
  });

  it("refuses a distillation with no claim", () => {
    expect(() => parseDistillation('{"relation":"new"}', [])).toThrow(/没有给出主张/);
  });
});
