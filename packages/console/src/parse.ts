/**
 * parse.ts — the grammar a person types.
 *
 * Slash commands are the only way to drive a team, and they are deliberately
 * NOT tools an agent calls. A model that chose which seats to ask would be
 * chairing the meeting, which is the one thing this product must not be. A
 * command runs because a person typed it; the registry never submits it to
 * the model, and the result is rendered by the UI without entering model
 * history. The invariant that the host node runs no turns is worth nothing if
 * the surface above it puts an LLM back in the chair.
 *
 * Pure, and tested, because this reads human input: a grammar that silently
 * mis-parses produces a team with the wrong seats and says nothing.
 */

export interface SeatDraft {
  readonly seatId: string;
  readonly displayName: string;
  readonly role: string;
}

export interface NewTeamInput {
  readonly displayName: string;
  readonly projectFolder: string;
  readonly seats: readonly SeatDraft[];
}

/**
 * `名称 | 项目文件夹 | 甲=架构, 乙=测试`
 *
 * Pipes rather than positional whitespace, because a project folder can
 * contain spaces and a role certainly can. Roles are optional; the name alone
 * is a seat.
 */
export function parseNewTeam(raw: string): NewTeamInput {
  const parts = raw.split("|").map((part) => part.trim());
  const [displayName = "", projectFolder = "", roster = ""] = parts;
  if (parts.length < 3 || displayName === "" || projectFolder === "" || roster === "") {
    throw new Error("用法：/squad-new 团队名 | 项目文件夹 | 甲=角色, 乙=角色");
  }
  if (!projectFolder.startsWith("/")) {
    // Relative paths would resolve against whatever the harness's cwd happens
    // to be, which is not where the person thinks they are.
    throw new Error(`项目文件夹要写绝对路径：「${projectFolder}」不是。`);
  }

  const seats: SeatDraft[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of roster
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .entries()) {
    const [name = "", role = ""] = entry.split(/[=＝:：]/).map((s) => s.trim());
    if (name === "") throw new Error(`第 ${index + 1} 个席位没有名字。`);
    if (seen.has(name)) throw new Error(`席位名「${name}」重复了——同名席位在记录里分不开。`);
    seen.add(name);
    seats.push({ seatId: `seat-${index + 1}`, displayName: name, role: role === "" ? "通用" : role });
  }
  if (seats.length === 0) throw new Error("至少要有一个席位。");
  return { displayName, projectFolder, seats };
}

/** `甲,乙: 指令` — an optional roll-call before the instruction. */
export interface SayInput {
  readonly instruction: string;
  /** Display names the host called on; empty means everyone. */
  readonly named: readonly string[];
}

/**
 * Read an optional roll-call off the front of an instruction.
 *
 * Decided against the ACTUAL roster, not by the shape of the text. Guessing
 * from shape was tried and fails on ordinary sentences: 「结论：我们用
 * Postgres」 has a short, space-free prefix and reads exactly like a
 * roll-call, so the first clause vanished and the instruction was addressed
 * to a seat named 结论. Whether a word is a seat's name is a fact this
 * console already has; there is no reason to infer it.
 */
export function parseSay(raw: string, seatNames: readonly string[] = []): SayInput {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("用法：/squad-say 指令   或   /squad-say 甲,乙: 指令");

  const at = trimmed.search(/[:：]/);
  if (at > 0) {
    const names = trimmed
      .slice(0, at)
      .split(/[,，、]/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    const rest = trimmed.slice(at + 1).trim();
    if (rest !== "" && names.length > 0 && names.every((name) => seatNames.includes(name))) {
      return { instruction: rest, named: names };
    }
  }
  return { instruction: trimmed, named: [] };
}
