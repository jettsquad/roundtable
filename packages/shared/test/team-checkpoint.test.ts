/**
 * The checkpoint is what every later turn sees instead of the discussion
 * itself, so its shape is load-bearing: a heading the assembler cannot find
 * is context silently lost, and a disagreement flattened into consensus is
 * a minority position deleted with no trace.
 */

import { describe, expect, it } from "vitest";
import {
  buildCheckpointPrompt,
  validateCheckpoint,
  CHECKPOINT_HEADINGS,
  CHECKPOINT_HEADING_LIST,
} from "../src/team-checkpoint.ts";

const turns = [
  { speaker: "水户洋平", text: "契约层有三处不一致" },
  { speaker: "野间忠一郎", text: "性能没问题，但缺回滚方案" },
];

describe("buildCheckpointPrompt", () => {
  it("asks for all four headings", () => {
    const prompt = buildCheckpointPrompt({ hostGoal: "评审技术方案", turns });
    for (const heading of CHECKPOINT_HEADING_LIST) expect(prompt).toContain(heading);
  });

  it("carries the discussion and who said what", () => {
    const prompt = buildCheckpointPrompt({ hostGoal: "评审技术方案", turns });
    expect(prompt).toContain("水户洋平");
    expect(prompt).toContain("契约层有三处不一致");
  });

  it("tells a first checkpoint nothing about continuation", () => {
    const prompt = buildCheckpointPrompt({ hostGoal: "评审", turns });
    expect(prompt).not.toContain("接续");
    expect(prompt).not.toContain("上一份检查点");
  });

  it("hands a continuation the previous checkpoint as input, not as raw material", () => {
    // Re-summarising a summary compounds its losses; settled items are
    // inherited rather than re-derived.
    const prompt = buildCheckpointPrompt({
      hostGoal: "评审",
      previousCheckpoint: `${CHECKPOINT_HEADINGS.settled}\n- 采用方案B`,
      turns,
    });
    expect(prompt).toContain("采用方案B");
    expect(prompt).toContain("直接继承");
  });

  it("instructs a continuation to re-adjudicate open disagreements", () => {
    // Append-only would leave settled arguments listed forever until the
    // section stopped being believed.
    const prompt = buildCheckpointPrompt({ hostGoal: "评审", previousCheckpoint: "旧检查点", turns });
    expect(prompt).toContain("逐条重新裁定");
  });

  it("forbids flattening disagreement into consensus", () => {
    expect(buildCheckpointPrompt({ hostGoal: "评审", turns })).toContain("不要把分歧写成共识");
  });

  it("still produces a usable prompt when nothing new was said", () => {
    const prompt = buildCheckpointPrompt({ hostGoal: "评审", previousCheckpoint: "旧检查点", turns: [] });
    expect(prompt).toContain("（无新增讨论）");
  });
});

describe("validateCheckpoint", () => {
  const complete = [
    `${CHECKPOINT_HEADINGS.goal}\n完成技术方案评审`,
    `${CHECKPOINT_HEADINGS.settled}\n- 采用方案B`,
    `${CHECKPOINT_HEADINGS.open}\n- 回滚策略：水户主张灰度，野间主张全量`,
    `${CHECKPOINT_HEADINGS.index}\n- review-A.md：契约层问题清单`,
  ].join("\n\n");

  it("accepts a checkpoint carrying every heading", () => {
    expect(validateCheckpoint(complete)).toEqual({ ok: true });
  });

  it("names what is missing rather than accepting a degraded checkpoint", () => {
    // This document becomes the basis of every later turn — accepting a
    // malformed one degrades everything downstream, invisibly.
    const withoutOpen = complete.replace(`${CHECKPOINT_HEADINGS.open}\n- 回滚策略：水户主张灰度，野间主张全量`, "");
    const result = validateCheckpoint(withoutOpen);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.missing).toEqual([CHECKPOINT_HEADINGS.open]);
  });

  it("reports every missing heading at once", () => {
    const result = validateCheckpoint("秘书随口写的一段话");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.missing).toEqual(CHECKPOINT_HEADING_LIST);
  });
});
