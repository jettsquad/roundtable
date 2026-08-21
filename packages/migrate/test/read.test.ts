/**
 * Migration runs once, against data that cannot be regenerated — these are
 * real discussions somebody had. Every test here is about the same thing:
 * anything not understood is reported, never dropped and never invented.
 */
import { describe, expect, it } from "vitest";
import { planMigration, type LegacyTeam } from "../src/read.ts";

const config = {
  teamId: "t-1",
  displayName: "老团队",
  projectFolder: "/tmp/proj",
  hostDisplayName: "主持人",
  secretarySeatId: "s2",
  seats: [
    { seatId: "s1", displayName: "甲", role: "架构", backend: "claude-code", systemPrompt: "你重视可维护性。" },
    { seatId: "s2", displayName: "秘书", role: "秘书", backend: "deepseek-harness" },
  ],
};

const team = (events: Record<string, unknown>[], over: Record<string, unknown> = {}): LegacyTeam => ({
  config: { ...config, ...over },
  events,
});

describe("planMigration", () => {
  it("maps every 1.x backend onto its 2.0 provider", () => {
    const plan = planMigration(team([]));
    expect(plan.seats.map((seat) => seat.backend)).toEqual(["claude-code", "dsh"]);
  });

  it("marks the secretary seat", () => {
    expect(planMigration(team([])).seats[1]).toHaveProperty("isSecretary", true);
  });

  it("keeps host and seat turns in transcript order, named", () => {
    const plan = planMigration(
      team([
        { kind: "hostMessage", text: "开始吧", turnId: "t1" },
        { kind: "discussionTurnEnd", seatId: "s1", message: "我认为可以", turnId: "t2" },
      ]),
    );
    expect(plan.lines).toEqual([
      { speaker: "主持人", text: "开始吧", turnId: "t1" },
      { speaker: "甲", text: "我认为可以", turnId: "t2" },
    ]);
  });

  it("reports a turn from a seat the roster never listed", () => {
    // Not attributed to a name invented from the id: the discussion would
    // then carry a participant who never existed.
    const plan = planMigration(team([{ kind: "discussionTurnEnd", seatId: "ghost", message: "?", turnId: "t1" }]));
    expect(plan.lines).toEqual([]);
    expect(plan.unaccounted[0]).toContain("ghost");
  });

  it("carries a checkpoint with the coverage 1.x recorded", () => {
    const plan = planMigration(
      team([
        { kind: "hostMessage", text: "一", turnId: "t1" },
        { kind: "contextCheckpoint", checkpointId: "cp1", text: "要点", coversUpTo: "t1", ts: "2026-01-01T00:00:00Z" },
      ]),
    );
    expect(plan.checkpoints[0]).toMatchObject({ checkpointId: "cp1", coversUpTo: "t1" });
  });

  it("falls back to the checkpoint's own position when 1.x recorded no coverage", () => {
    // What 1.x did before coversUpTo existed, and correct whenever nothing
    // ran while the checkpoint was being written.
    const plan = planMigration(
      team([
        { kind: "hostMessage", text: "一", turnId: "t1" },
        { kind: "contextCheckpoint", checkpointId: "cp1", text: "要点" },
      ]),
    );
    expect(plan.checkpoints[0]?.coversUpTo).toBe("t1");
  });

  it("carries revocation across to the checkpoint it retired", () => {
    const plan = planMigration(
      team([
        { kind: "hostMessage", text: "一", turnId: "t1" },
        { kind: "contextCheckpoint", checkpointId: "cp1", text: "要点", coversUpTo: "t1" },
        { kind: "checkpointRevoked", checkpointId: "cp1" },
      ]),
    );
    expect(plan.checkpoints[0]?.revokedAt).toBeDefined();
  });

  it("reports a revocation pointing at nothing", () => {
    const plan = planMigration(team([{ kind: "checkpointRevoked", checkpointId: "gone" }]));
    expect(plan.unaccounted[0]).toContain("gone");
  });

  it("reports an event kind it was never taught, rather than skipping it", () => {
    // The whole design of this reader. The only evidence a kind mattered is
    // the thing that would be silently dropped.
    const plan = planMigration(team([{ kind: "somethingFrom1x", ts: "2026-01-01T00:00:00Z" }]));
    expect(plan.unaccounted[0]).toContain("somethingFrom1x");
  });

  it("passes over kinds that legitimately carry nothing", () => {
    const plan = planMigration(team([{ kind: "agentActivity" }, { kind: "phaseStart" }]));
    expect(plan.unaccounted).toEqual([]);
    expect(plan.lines).toEqual([]);
  });

  it("collects the files the team wrote", () => {
    const plan = planMigration(team([{ kind: "artifactWritten", path: "docs/a.md" }]));
    expect(plan.artifacts).toEqual(["docs/a.md"]);
  });

  it("refuses a team with no id or no seats", () => {
    expect(() => planMigration({ config: { seats: config.seats }, events: [] })).toThrow(/teamId/);
    expect(() => planMigration({ config: { teamId: "t" }, events: [] })).toThrow(/席位/);
  });

  it("keeps the team's own checkpoint coefficient", () => {
    expect(planMigration(team([], { checkpointCoefficient: 0.2 })).checkpointCoefficient).toBe(0.2);
  });
});
