/**
 * The seed is the designer team AND a specimen of the format it produces, so
 * the first test here is the one that matters: it has to pass its own check.
 * A seed that could not be instantiated would be a designer that cannot
 * design itself.
 */
import { checkTeamPlan, parseTeamPlan, resolveOpeningAgenda } from "@squad/shared";
import { describe, expect, it } from "vitest";
import {
  TEAM_DESIGNER_PLAN,
  designerAgendaFor,
  latestPlanOf,
  planFromReply,
  planHash,
  templateIdFor,
  templatesFor,
} from "../src/team-designer.ts";

describe("TEAM_DESIGNER_PLAN", () => {
  it("parses under the same strict schema as anything a model writes", () => {
    expect(() => parseTeamPlan(TEAM_DESIGNER_PLAN)).not.toThrow();
  });

  it("passes checkTeamPlan", () => {
    expect(checkTeamPlan(TEAM_DESIGNER_PLAN)).toEqual([]);
  });

  it("keeps the two rosters blind to each other, and lets the reporter see both", () => {
    // The whole reason this is a team rather than a prompt: the architect and
    // the red team write their rosters without seeing each other. Seeing the
    // first answer turns the second into a comment on it.
    //
    // The seat that REPORTS both to the host is the exception, and it has to
    // be an explicit one: in an independent phase every run shares the
    // opening snapshot, so a summariser left on the default would be
    // describing two rosters it cannot see.
    const phase = TEAM_DESIGNER_PLAN.openingAgenda.phases[1];
    expect(phase?.contextMode).toBe("independent");
    expect(phase?.tasks.map((task) => task.seatKey)).toEqual(["architect", "redteam", "clarifier"]);
    expect(phase?.tasks[0]?.publicContextCutoff).toBeUndefined();
    expect(phase?.tasks[1]?.publicContextCutoff).toBeUndefined();
    expect(phase?.tasks[2]?.publicContextCutoff).toBe("immediately-before-turn");
  });

  it("stops for the host again once the shape of the roster is visible", () => {
    // The cheapest moment to catch 「我要的是团队主笔，这给的却是一圈辅助」.
    // Five phases later it is only fixable by throwing the plan away.
    expect(TEAM_DESIGNER_PLAN.openingAgenda.phases[1]?.exit).toBe("wait-for-host");
  });

  it("stops for the host before designing anything", () => {
    // Hours per week, existing accounts, what the host is actually good at:
    // facts no model has a route to. A team that guesses them designs for a
    // person who does not exist.
    expect(TEAM_DESIGNER_PLAN.openingAgenda.phases[0]?.exit).toBe("wait-for-host");
  });

  it("tells every seat it is designing somebody else's team", () => {
    // The worst failure this thing has had: the designer team decided it was
    // designing ITSELF — 「主笔落到哪个头上？让提示词工程兼任」. A seat's own
    // job description never says whose roster it is; with five colleagues in
    // front of it and no other roster in sight, a model maps the work onto
    // them. The frame has to be on every seat, before its job.
    for (const seat of TEAM_DESIGNER_PLAN.seats) {
      expect(seat.systemPrompt, seat.displayName).toContain("不是被设计的对象");
      expect(seat.systemPrompt, seat.displayName).toContain("全部是新造的");
    }
  });

  it("gives every seat a boundary", () => {
    // Seats without one overlap, and four overlapping seats produce four
    // copies of one answer — which reads as agreement, not as redundancy.
    for (const seat of TEAM_DESIGNER_PLAN.seats) {
      expect(seat.systemPrompt, seat.displayName).toContain("你不做什么");
    }
  });

  it("names exactly one secretary, and it is cleared to be one", () => {
    const candidates = TEAM_DESIGNER_PLAN.seats.filter((seat) => seat.secretaryCandidate);
    expect(candidates.map((seat) => seat.key)).toEqual([TEAM_DESIGNER_PLAN.secretaryKey]);
  });
});

describe("planHash", () => {
  it("ignores key order, because two spellings of one plan are one plan", () => {
    const reordered = { ...TEAM_DESIGNER_PLAN };
    expect(planHash(reordered)).toBe(planHash(TEAM_DESIGNER_PLAN));
  });

  it("changes when the plan does", () => {
    expect(planHash({ ...TEAM_DESIGNER_PLAN, teamName: "别的" })).not.toBe(planHash(TEAM_DESIGNER_PLAN));
  });
});

describe("templateIdFor", () => {
  it("suffixes rather than overwriting an id that is taken", () => {
    // The agent library is shared across teams. A template quietly edited
    // here fails somewhere else, weeks later, with nothing connecting the two.
    const id = templateIdFor("writer", "abcdef0123", (candidate) => candidate === "plan-writer-abcdef");
    expect(id).toBe("plan-writer-abcdef-2");
  });
});

describe("templatesFor", () => {
  const templates = templatesFor(TEAM_DESIGNER_PLAN, () => false);

  it("mints one live template per seat, in roster order", () => {
    expect(templates).toHaveLength(TEAM_DESIGNER_PLAN.seats.length);
    expect(templates.map((t) => t.displayName)).toEqual(TEAM_DESIGNER_PLAN.seats.map((s) => s.displayName));
    expect(templates.every((t) => t.enabled)).toBe(true);
  });

  it("never mints the same id twice inside one plan", () => {
    expect(new Set(templates.map((t) => t.templateId)).size).toBe(templates.length);
  });

  it("clears the planned secretary to be one", () => {
    const secretary = templates[TEAM_DESIGNER_PLAN.seats.findIndex((s) => s.key === TEAM_DESIGNER_PLAN.secretaryKey)];
    expect(secretary?.secretaryCandidate).toBe(true);
  });
});

describe("resolveOpeningAgenda over the seed", () => {
  it("addresses every task to a real seat once the team exists", () => {
    const map = new Map(TEAM_DESIGNER_PLAN.seats.map((seat, index) => [seat.key, `seat-${index + 1}`]));
    const agenda = resolveOpeningAgenda(TEAM_DESIGNER_PLAN, map);
    const addressed = agenda.phases.flatMap((phase) => phase.tasks.map((task) => task.seatId));
    expect(addressed.every((seatId) => /^seat-\d+$/.test(seatId))).toBe(true);
  });
});

describe("planFromReply", () => {
  const wire = JSON.stringify(TEAM_DESIGNER_PLAN);

  it("reads a plan the secretary wrapped in prose and a code fence", () => {
    // The failure being avoided is a perfectly good plan refused because the
    // model said 「给你：」 first.
    expect(planFromReply("给你：\n```json\n" + wire + "\n```\n就这些。").teamName).toBe(TEAM_DESIGNER_PLAN.teamName);
  });

  it("refuses a reply with no object in it", () => {
    expect(() => planFromReply("我觉得应该找四个人，一个选题一个写作。")).toThrow(/没有 JSON 对象/);
  });

  it("refuses a plan that parses but cannot be built", () => {
    // The whole point of checking here: otherwise the host confirms a roster
    // and finds out at the moment the templates are already half-written.
    const orphaned = { ...TEAM_DESIGNER_PLAN, secretaryKey: "nobody" };
    expect(() => planFromReply(JSON.stringify(orphaned))).toThrow(/secretaryKey/);
  });
});

describe("latestPlanOf", () => {
  const line = (speaker: string, text: string, turnId: string) => ({
    kind: "user/message",
    text: `【${speaker}】${text}`,
    turnId,
    at: 0,
  });

  it("takes the secretary's most recent readable plan", () => {
    const plan = latestPlanOf({
      secretary: { displayName: "组队秘书" },
      transcript: () => [
        line("组队秘书", JSON.stringify({ ...TEAM_DESIGNER_PLAN, teamName: "旧的" }), "t1"),
        line("红队", "我反对。", "t2"),
        line("组队秘书", JSON.stringify({ ...TEAM_DESIGNER_PLAN, teamName: "新的" }), "t3"),
      ],
    });
    expect(plan.plan.teamName).toBe("新的");
    expect(plan.turnId).toBe("t3");
  });

  it("ignores a plan written by somebody who is not the secretary", () => {
    // Any seat can be asked to propose a division of labour. Building a team
    // out of one of those would let a member staff the next team while the
    // confirmation said the secretary had.
    expect(() =>
      latestPlanOf({
        secretary: { displayName: "组队秘书" },
        transcript: () => [line("红队", JSON.stringify(TEAM_DESIGNER_PLAN), "t1")],
      }),
    ).toThrow(/还没有给出过团队方案/);
  });

  it("says what was wrong when the secretary did speak but the plan will not build", () => {
    // 「没找到方案」 on its own reads as 「秘书还没说过」, and the truth is
    // usually 「说过，但差一样东西」.
    expect(() =>
      latestPlanOf({
        secretary: { displayName: "组队秘书" },
        transcript: () => [line("组队秘书", JSON.stringify({ ...TEAM_DESIGNER_PLAN, secretaryKey: "nobody" }), "t1")],
      }),
    ).toThrow(/secretaryKey/);
  });
});

describe("designerAgendaFor", () => {
  const roster = TEAM_DESIGNER_PLAN.seats.map((seat, index) => ({
    seatId: `seat-${index + 1}`,
    displayName: seat.displayName,
    templateId: `plan-${seat.key}-abc123`,
  }));

  it("addresses the five phases to an existing table", () => {
    // A sitting starts with no draft on purpose. The five phases are not a
    // decision somebody has to make again, though — they are the same
    // every time.
    const agenda = designerAgendaFor({ seats: roster });
    expect(agenda.phases).toHaveLength(TEAM_DESIGNER_PLAN.openingAgenda.phases.length);
    expect(agenda.phases[1]?.tasks.map((t) => t.seatId)).toEqual(["seat-2", "seat-4", "seat-1"]);
  });

  it("falls back to the display name when the template is gone", () => {
    const agenda = designerAgendaFor({ seats: roster.map(({ seatId, displayName }) => ({ seatId, displayName })) });
    expect(agenda.phases[0]?.tasks[0]?.seatId).toBe("seat-1");
  });

  it("refuses a table that is missing one of the five", () => {
    // Four phases that run and one that does not would look like it worked.
    expect(() => designerAgendaFor({ seats: roster.slice(0, 4) })).toThrow(/组队秘书/);
  });
});
