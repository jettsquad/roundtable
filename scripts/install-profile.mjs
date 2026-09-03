/**
 * install-profile.mjs — put a development profile into the Harness home.
 *
 * This is the DEVELOPMENT path, and it exists because publishing is not a
 * development loop: `dsh plugin add` installs built artifacts, so every edit
 * would need a rebuild and a reinstall before it could be seen. Here the
 * profile depends on the workspace packages directly, and Node runs their
 * `.ts` because the entries are symlinks whose realpath lands back in this
 * repository — the one condition publishing removes.
 *
 * Both files are GENERATED, and the patch is generated from the bundle's:
 * two hand-maintained copies of the same plugin tree drift, and the drift
 * shows up as "it works when I run it, it breaks when they install it".
 * Users never come here — they run `dsh plugin --profile web add
 * @jettsquad/roundtable`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh-squad-dev");
const target = join(dshHome, "profiles", "squad");

/**
 * The published package name, and the workspace packages it is built from.
 *
 * The bundle addresses one package by subpath; development addresses the
 * workspace packages by their own names. Mapping one to the other is the only
 * difference between the two trees, so it is written once, here.
 */
const PACKAGE = "@jettsquad/roundtable";
const devName = (row) => (row === PACKAGE ? "@squad/console" : `@squad/${row.slice(PACKAGE.length + 1)}`);

/** Where dsh is installed, per the binding `link-dsh` wrote down. */
function harnessRoot() {
  const stamp = join(repoRoot, ".dsh-link.json");
  if (existsSync(stamp)) {
    const { harnessRoot: root } = JSON.parse(readFileSync(stamp, "utf8"));
    if (typeof root === "string" && existsSync(root)) return root;
  }
  const fallback = join(homedir(), ".local/share/roundtable/deepseek-harness");
  if (existsSync(fallback)) return fallback;
  throw new Error("找不到 dsh 安装位置。先跑一次 `npm run link-dsh`。");
}

const patch = readFileSync(join(repoRoot, "bundle", "cordis.patch.yml"), "utf8");
const rows = [...patch.matchAll(/name:\s*'(@jettsquad\/[^']+)'/g)].map((match) => match[1]);
if (rows.length === 0) throw new Error("bundle/cordis.patch.yml 里没有 @squad 行——生成不出开发态的 patch。");

// Rewrite the rows, and say in the file itself that editing it is pointless.
const devPatch =
  "# 生成文件，别改。来源：bundle/cordis.patch.yml，由 scripts/install-profile.mjs 改写。\n" +
  "# 要改插件树，改那一份——它同时是发布出去的那一份。\n" +
  patch.replace(/name:\s*'(@jettsquad\/[^']+)'/g, (_, row) => `name: '${devName(row)}'`);

/**
 * The workspace packages this profile installs.
 *
 * `file:` links to absolute paths on THIS machine, which is why this file is
 * generated rather than committed: a checked-in copy would carry one
 * developer's directory layout into everyone else's checkout.
 */
const packages = [...new Set(rows.map(devName))].sort();
const dependencies = Object.fromEntries([
  // The Claude Code subagent provider ships with neither dsh-base nor
  // dsh-web-app, so it is installed explicitly — from the harness this
  // checkout is linked to, not from npm, so the version cannot drift from the
  // runtime hosting it.
  ["@deepseek-ai/dsh-subagent-claude-code", `file:${join(harnessRoot(), "packages/subagent/subagent-claude-code")}`],
  ...packages.map((name) => [name, `file:${join(repoRoot, "packages", name.slice("@squad/".length))}`]),
  // seat-runtime and shared are imported by the plugins above rather than
  // mounted as rows, so they are dependencies without being in the patch.
  ["@squad/seat-runtime", `file:${join(repoRoot, "packages/seat-runtime")}`],
  ["@squad/shared", `file:${join(repoRoot, "packages/shared")}`],
]);

const manifest = {
  name: "dsh-profile-squad",
  private: true,
  dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
};

mkdirSync(target, { recursive: true });
writeFileSync(join(target, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(join(target, "cordis.patch.yml"), devPatch);

// The profile root is always an empty entry list; the tree is composed as
// patch layers over it. Written only when absent so a user edit survives.
const root = join(target, "cordis.yml");
if (!existsSync(root)) writeFileSync(root, "[]\n");

console.log(`插件行 ${rows.length} 条，工作区包 ${packages.length} 个，dsh @ ${harnessRoot()}`);
console.log("安装 profile 依赖…");
execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund"], { cwd: target, stdio: "inherit" });

console.log(`✓ profile 已装到 ${target}`);
console.log(`\n运行：npm run ui`);
