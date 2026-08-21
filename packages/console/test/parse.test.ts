/**
 * This reads what a person typed. A grammar that silently mis-parses builds a
 * team with the wrong seats, or sends an instruction to nobody, and says
 * nothing either way.
 */
import { describe, expect, it } from "vitest";
import { parseNewTeam, parseSay } from "../src/parse.ts";

describe("parseNewTeam", () => {
  it("reads a name, a folder and a roster", () => {
    const input = parseNewTeam("评审组 | /Users/me/proj | 甲=架构, 乙=测试");
    expect(input.displayName).toBe("评审组");
    expect(input.projectFolder).toBe("/Users/me/proj");
    expect(input.seats).toEqual([
      { seatId: "seat-1", displayName: "甲", role: "架构" },
      { seatId: "seat-2", displayName: "乙", role: "测试" },
    ]);
  });

  it("allows spaces in the folder and the role", () => {
    // Pipes rather than positional whitespace, because both of these
    // legitimately contain spaces.
    const input = parseNewTeam("组 | /Users/me/my proj | 甲=后端 与 数据");
    expect(input.projectFolder).toBe("/Users/me/my proj");
    expect(input.seats[0]?.role).toBe("后端 与 数据");
  });

  it("defaults a role rather than leaving it blank", () => {
    expect(parseNewTeam("组 | /p | 甲").seats[0]?.role).toBe("通用");
  });

  it("accepts full-width separators", () => {
    // The person typing this is writing Chinese; their comma is ，
    expect(parseNewTeam("组 | /p | 甲：架构，乙：测试").seats).toHaveLength(2);
  });

  it("refuses a relative folder", () => {
    // It would resolve against whatever the harness's cwd happens to be,
    // which is not where the person thinks they are.
    expect(() => parseNewTeam("组 | proj | 甲")).toThrow(/绝对路径/);
  });

  it("refuses duplicate seat names", () => {
    // Two seats called 甲 are indistinguishable in the record afterwards.
    expect(() => parseNewTeam("组 | /p | 甲, 甲")).toThrow(/重复/);
  });

  it("explains the usage when a section is missing", () => {
    expect(() => parseNewTeam("组 | /p")).toThrow(/用法/);
  });
});

describe("parseSay", () => {
  const roster = ["甲", "乙"];

  it("takes a plain instruction as addressed to everyone", () => {
    expect(parseSay("看一下这个设计", roster)).toEqual({ instruction: "看一下这个设计", named: [] });
  });

  it("reads a roll-call before the instruction", () => {
    expect(parseSay("甲,乙: 各自评审", roster)).toEqual({ instruction: "各自评审", named: ["甲", "乙"] });
  });

  it("does not mistake an ordinary colon for a roll-call", () => {
    // Decided against the roster, not by shape. Shape was tried: 「结论」 is
    // short and space-free and read exactly like a name, so the first clause
    // vanished and the instruction went to a seat that does not exist.
    expect(parseSay("结论：我们用 Postgres，请评估迁移成本", roster)).toEqual({
      instruction: "结论：我们用 Postgres，请评估迁移成本",
      named: [],
    });
  });

  it("treats a partly-unknown roll-call as prose rather than dropping the unknown name", () => {
    // Silently addressing only 甲 would look like 丙 had nothing to say.
    expect(parseSay("甲,丙: 评审", roster).named).toEqual([]);
  });

  it("addresses everyone when no team is selected", () => {
    expect(parseSay("甲: 评审").named).toEqual([]);
  });

  it("refuses an empty instruction", () => {
    expect(() => parseSay("   ", roster)).toThrow(/用法/);
  });
});
