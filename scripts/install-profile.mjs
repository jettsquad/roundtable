/**
 * install-profile.mjs — put the squad profile into the Harness home.
 *
 * A profile is how dsh composes an application: a package.json naming the
 * bundles it stacks and the out-of-tree plugins it installs, plus a patch file
 * that inserts our rows on top. Development uses a separate DSH_HOME by
 * default so experiments cannot touch the sessions of a daily-driver dsh.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh-squad-dev");
const target = join(dshHome, "profiles", "squad");

mkdirSync(target, { recursive: true });
copyFileSync(join(repoRoot, "profile", "package.json"), join(target, "package.json"));
copyFileSync(join(repoRoot, "profile", "cordis.patch.yml"), join(target, "cordis.patch.yml"));

// The profile root is always an empty entry list; the tree is composed as
// patch layers over it. Written only when absent so a user edit survives.
const root = join(target, "cordis.yml");
if (!existsSync(root)) writeFileSync(root, "[]\n");

// Dependencies resolve from the installed profile, not from this repository:
// the plugin rows are bare package names, and Node walks up from where the
// profile actually lives.
console.log("安装 profile 依赖…");
execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund"], { cwd: target, stdio: "inherit" });

console.log(`✓ profile 已装到 ${target}`);
console.log(`\n运行：DSH_HOME=${dshHome} dsh --profile squad --dump-config`);
