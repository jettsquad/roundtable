/**
 * project-memory.ts — the file each backend reads as project context.
 *
 * Every CLI has one and they are all different: Claude Code reads
 * `CLAUDE.md`, Codex reads `AGENTS.md`. They are not interchangeable and do
 * not need to be — each seat reads its own, and nothing has to know about
 * anyone else's.
 *
 * What belongs in one is what is true of the PROJECT: what it is for, how it
 * is laid out, the conventions and vocabulary it uses. Not a seat's persona
 * and not a way of working — those are the agent's own standing instructions,
 * which Squad already owns and which would drift here into something no
 * screen in Squad can show.
 *
 * The list is deliberately partial. `dsh` has no such convention, and giving
 * it one Squad invented would be a file nothing reads.
 */
import type { AgentBackend } from "./agent-template.ts";

const BY_BACKEND: Readonly<Partial<Record<AgentBackend, string>>> = {
  "claude-code": "CLAUDE.md",
  codex: "AGENTS.md",
};

/** The project file this backend reads, when it has such a convention. */
export function projectMemoryFile(backend: AgentBackend): string | undefined {
  return BY_BACKEND[backend];
}

/**
 * What a seat is told when its project file is missing.
 *
 * Written as the FIRST thing to do and then get on with the question, rather
 * than as a separate errand: a seat that spends its whole turn on
 * housekeeping has not answered, and the round it was part of has a hole in
 * it that reads as the seat having nothing to say.
 *
 * 「不要修改已有的」 is the other half. A seat editing this file is editing
 * its own next prompt, which is the one thing the whole design refuses to let
 * a machine do unsupervised — the same rule that keeps criteria in
 * `proposals/` until a person rules on them.
 */
export function projectMemoryNote(file: string): readonly string[] {
  return [
    `## 这个项目还没有 ${file}`,
    `先花一点时间建立 \`${file}\`：写这个项目是干什么的、目录怎么组织、有哪些约定和术语。` +
      `只写项目本身的事实，不要写你自己的角色或工作方式——那些由团队给你。`,
    "写完就继续回答下面的问题，不要把这一轮全用在这件事上。",
  ];
}
