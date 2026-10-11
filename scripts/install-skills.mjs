/**
 * install-skills.mjs — put this repository's skills where every seat reads them.
 *
 *   node scripts/install-skills.mjs
 *
 * One copy, in `~/.agents/skills` (or `$DSH_AGENTS_HOME/skills`): the folder
 * dsh scans natively and Codex reads too. An isolated Claude Code seat is
 * handed the same folder as a plugin — see `seat-claude-code/src/skills-plugin.ts`.
 * A person's own Claude Code reads `~/.claude/skills`, so each skill is
 * linked there as well.
 *
 * Copied, not linked to this checkout: a seat must not lose its skills
 * because a branch was switched under it. Re-run after editing a skill.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "skills");
const agentsHome = process.env.DSH_AGENTS_HOME?.trim() || join(homedir(), ".agents");
const shared = join(agentsHome, "skills");
const claude = join(homedir(), ".claude", "skills");

mkdirSync(shared, { recursive: true });
for (const name of readdirSync(source)) {
  if (!existsSync(join(source, name, "SKILL.md"))) continue;
  const target = join(shared, name);
  rmSync(target, { recursive: true, force: true });
  cpSync(join(source, name), target, { recursive: true });
  console.log(`✓ ${name} → ${target}`);

  // A person's own Claude Code. Only a link of ours is replaced; anything
  // else by that name was put there by somebody and is left alone.
  if (!existsSync(claude)) continue;
  const link = join(claude, name);
  const there = lstatSync(link, { throwIfNoEntry: false });
  if (there !== undefined && !there.isSymbolicLink()) {
    console.warn(`  ${link} 已经存在且不是链接，没有动它。`);
    continue;
  }
  if (there !== undefined) rmSync(link);
  symlinkSync(target, link, "dir");
  console.log(`  链接到 ${link}`);
}
console.log("\ndsh 与 Codex 席位直接读取；Claude Code 席位在下次启动时读到。");
