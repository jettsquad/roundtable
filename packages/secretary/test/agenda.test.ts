/**
 * Drafting an agenda from a sentence. The model's reply is treated as hostile
 * input the whole way: tolerated around the edges, strict inside, and vetted
 * against the roster afterwards because a legal shape says nothing about the
 * seats being real.
 */
import { describe, expect, it } from "vitest";
import {
  assertPublicHostCommand,
  buildAgendaPrompt,
  extractJson,
  parseAgendaReply,
  type RosterSeat,
} from "../src/agenda.ts";
import { draftAgendaWith, type TextTaskRunner } from "../src/tasks.ts";

const seats: readonly RosterSeat[] = [
  { seatId: "seat-a", displayName: "甲" },
  { seatId: "seat-b", displayName: "乙" },
];

const wellFormed = JSON.stringify({
  phases: [{ title: "评审", contextMode: "independent", tasks: [{ seatId: "seat-a", instruction: "看设计" }] }],
});

const answering =
  (text: string, stopReason = "completed"): TextTaskRunner =>
  async () => ({ text, stopReason });

describe("assertPublicHostCommand", () => {
  it("refuses a command that points at private material", () => {
    // The secretary is private-blind. Passed through, an @ reference either
    // leaks or — worse, because it is silent — produces an agenda built
    // around something the secretary could not read and guessed at.
    expect(() => assertPublicHostCommand("请让 @密件 里的人先说")).toThrow(/@ 引用/);
  });

  it("accepts an ordinary instruction", () => {
    expect(() => assertPublicHostCommand("让两位各自独立评审这份设计")).not.toThrow();
  });

  it("accepts an email-looking token that is not a reference", () => {
    expect(() => assertPublicHostCommand("参考 a@b.com 的意见")).not.toThrow();
  });
});

describe("extractJson", () => {
  it("reads a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("reads an object the model wrapped in prose", () => {
    // The failure being avoided: a perfectly good agenda rejected because the
    // model said "Here you go:" first.
    expect(extractJson('好的，这是议程：\n{"a":1}\n希望有用')).toEqual({ a: 1 });
  });

  it("refuses a reply with no object at all", () => {
    expect(() => extractJson("我没法拟这个议程")).toThrow(/没有返回 JSON/);
  });
});

describe("parseAgendaReply", () => {
  it("accepts a well-formed agenda naming real seats", () => {
    expect(parseAgendaReply(wellFormed, seats).phases[0]?.title).toBe("评审");
  });

  it("refuses an agenda naming a seat that does not exist", () => {
    // Refused, not returned with a warning: a draft the host can confirm is a
    // draft the table will run.
    const invented = wellFormed.replace("seat-a", "seat-z");
    expect(() => parseAgendaReply(invented, seats)).toThrow(/seat-z/);
  });
});

describe("draftAgendaWith", () => {
  it("checks for private material before contacting the secretary", async () => {
    // Order matters: a check on the way back would already have sent it.
    let called = false;
    const runner: TextTaskRunner = async () => {
      called = true;
      return { text: wellFormed, stopReason: "completed" };
    };
    await expect(draftAgendaWith(runner, { command: "问问 @密件", topic: "T", seats })).rejects.toThrow(/@ 引用/);
    expect(called).toBe(false);
  });

  it("returns the parsed agenda for an ordinary command", async () => {
    const agenda = await draftAgendaWith(answering(wellFormed), {
      command: "让甲评审设计",
      topic: "设计评审",
      seats,
    });
    expect(agenda.phases).toHaveLength(1);
  });

  it("refuses a draft that did not run to completion", async () => {
    await expect(
      draftAgendaWith(answering(wellFormed, "max-tokens"), { command: "让甲评审", topic: "T", seats }),
    ).rejects.toThrow(/max-tokens/);
  });
});

describe("buildAgendaPrompt", () => {
  it("lists the exact seat ids the model may use", () => {
    const prompt = buildAgendaPrompt({ command: "评审", topic: "设计", seats });
    expect(prompt).toContain("seat-a (甲), seat-b (乙)");
  });
});
