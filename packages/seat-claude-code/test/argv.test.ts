/**
 * The fence is the reason this package exists, so it is tested as a floor
 * rather than as a default: a caller that supplies its own filter and forgets
 * about delegation must still not be able to open that door.
 */
import { describe, expect, it } from "vitest";
import { DELEGATION_TOOLS, buildArgv } from "../src/argv.ts";

const flagValues = (argv: readonly string[], flag: string): string[] => {
  const at = argv.indexOf(flag);
  if (at < 0) return [];
  const values: string[] = [];
  for (let index = at + 1; index < argv.length && !argv[index]!.startsWith("--"); index++) {
    values.push(argv[index]!);
  }
  return values;
};

describe("buildArgv", () => {
  it("denies delegation by default", () => {
    // 1.x's executor passed no tool restriction at all, which is why a
    // secretary there could invent a team of its own to do the work.
    expect(flagValues(buildArgv({ prompt: "x" }), "--disallowed-tools")).toEqual([...DELEGATION_TOOLS]);
  });

  it("keeps the delegation denial when the caller supplies its own denials", () => {
    const argv = buildArgv({ prompt: "x", toolFilter: { deny: ["Bash"] } });
    expect(flagValues(argv, "--disallowed-tools")).toEqual([...DELEGATION_TOOLS, "Bash"]);
  });

  it("keeps the delegation denial even inside an allow-list", () => {
    // The dangerous case: an allow-list reads like a complete statement of
    // what is permitted, so a caller writing one has no reason to think about
    // what they are NOT excluding.
    const argv = buildArgv({ prompt: "x", toolFilter: { allow: ["Read", "Task"] } });
    expect(flagValues(argv, "--allowed-tools")).toEqual(["Read", "Task"]);
    expect(flagValues(argv, "--disallowed-tools")).toContain("Task");
  });

  it("lets a composition lower the floor deliberately", () => {
    // Explicit and awkward on purpose. Removing the fence should look like a
    // decision in the config, not like an omission.
    expect(flagValues(buildArgv({ prompt: "x", alwaysDeny: [] }), "--disallowed-tools")).toEqual([]);
  });

  it("does not repeat a tool named in both places", () => {
    const argv = buildArgv({ prompt: "x", toolFilter: { deny: ["Task"] } });
    expect(flagValues(argv, "--disallowed-tools").filter((tool) => tool === "Task")).toHaveLength(1);
  });
});

describe("the rest of the command line", () => {
  it("asks for stream-json and partial messages", () => {
    // Partial messages are why an idle clock can tell a thinking seat from a
    // wedged one.
    const argv = buildArgv({ prompt: "x" });
    expect(argv).toContain("--include-partial-messages");
    expect(argv.slice(argv.indexOf("--output-format"))[1]).toBe("stream-json");
  });

  it("maps bypassPermissions onto the CLI's own flag", () => {
    const argv = buildArgv({ prompt: "x", permissionMode: "bypassPermissions" });
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--permission-mode");
  });

  it("passes persona as an APPEND, never a replacement", () => {
    // Replacing the CLI's system prompt would take its tool descriptions with
    // it, and a seat that cannot describe its own tools uses them badly.
    const argv = buildArgv({ prompt: "x", persona: "你重视可维护性。" });
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toBe("你重视可维护性。");
  });

  it("selects a model when one is given, and says nothing when not", () => {
    expect(buildArgv({ prompt: "x", model: "claude-opus-4" })).toContain("--model");
    expect(buildArgv({ prompt: "x" })).not.toContain("--model");
  });

  it("ignores a blank persona rather than passing an empty flag", () => {
    expect(buildArgv({ prompt: "x", persona: "   " })).not.toContain("--append-system-prompt");
  });
});
