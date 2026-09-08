/**
 * 每个后端读自己的项目文件，互不相干——claude 不会去读 codex 的 AGENTS.md。
 * 这几条锁的是那个映射，以及缺失时给席位的那段话里两个不能丢的意思。
 */
import { describe, expect, it } from "vitest";
import { projectMemoryFile, projectMemoryNote } from "../src/project-memory.ts";

describe("projectMemoryFile", () => {
  it("各读各的", () => {
    expect(projectMemoryFile("claude-code")).toBe("CLAUDE.md");
    expect(projectMemoryFile("codex")).toBe("AGENTS.md");
  });

  it("没有这个约定的后端不硬造一个", () => {
    // 造一个只有 Squad 自己知道的文件名，等于建了一个没人读的文件。
    expect(projectMemoryFile("dsh")).toBeUndefined();
  });
});

describe("projectMemoryNote", () => {
  it("说清写什么，也说清不写什么", () => {
    const note = projectMemoryNote("CLAUDE.md").join("\n");
    expect(note).toContain("CLAUDE.md");
    expect(note).toContain("目录");
    // 角色和工作方式由团队给，写进项目文件就会漂成 Squad 里看不见的东西。
    expect(note).toContain("不要写你自己的角色");
  });

  it("要求顺手做完，不要占满这一轮", () => {
    // 一个整轮都在做杂务的席位等于没发言，那一轮会留一个看起来像「它没话说」的洞。
    expect(projectMemoryNote("AGENTS.md").join("\n")).toContain("不要把这一轮全用在这件事上");
  });
});
