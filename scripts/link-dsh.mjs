/**
 * link-dsh.mjs — point this repository at the harness's own framework copy.
 *
 * Node caches modules by REALPATH. If this repository resolved its own
 * physical copy of cordis while the profile resolved the harness's, the
 * process would hold two service registries and two `Symbol.for` identities,
 * and every symptom would point somewhere other than the cause.
 *
 * The profile's node_modules entries are already symlinks into the harness
 * build, so linking to the same targets makes both paths share one realpath
 * and Node loads the framework once.
 *
 * Re-run after reinstalling or rebuilding dsh.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the profile farm points; the harness install is the single source. */
const farm = join(homedir(), ".dsh", "profiles", "node_modules", "@deepseek-ai");

/** Only what our plugins import directly. Add here, never guess at runtime. */
const NEEDED = ["cordis", "dsh-agent", "dsh-subagent", "dsh-llm", "dsh-session"];

if (!existsSync(farm)) {
  console.error(
    `找不到 DSH 的包农场：${farm}\n` +
      `先跑一次 dsh（例如 \`dsh --profile headless --dump-config\`）让它初始化 profile，再重试。`,
  );
  process.exit(1);
}

const scope = join(repoRoot, "node_modules", "@deepseek-ai");
mkdirSync(scope, { recursive: true });

let linked = 0;
for (const name of NEEDED) {
  const source = join(farm, name);
  if (!existsSync(source)) {
    console.error(`农场里没有 ${name}：${source}`);
    process.exit(1);
  }
  // Resolve through the farm's own symlink so both paths share one realpath.
  const target = lstatSync(source).isSymbolicLink() ? readlinkSync(source) : source;
  const link = join(scope, name);
  if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link, "dir");
  console.log(`✓ @deepseek-ai/${name} → ${target}`);
  linked += 1;
}

// The lockfile is not tracked — every dependency here is a `file:` link to an
// absolute path on this machine — so nothing else records WHICH harness build
// this repository is bound to. Write it down: a silent swap underneath us would
// otherwise show up as behaviour that no diff explains.
// Ask git for the root rather than counting `..` segments: the vendored copy
// sits at a depth that changes with how the harness was installed.
const linkTarget = readlinkSync(join(farm, "cordis"));
const gitIn = (args) =>
  execFileSync("git", ["-C", linkTarget, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
let harnessRoot = linkTarget;
let identity = "(unknown)";
try {
  harnessRoot = gitIn(["rev-parse", "--show-toplevel"]);
  identity = gitIn(["rev-parse", "--short", "HEAD"]);
} catch {
  /* a harness installed without git history still links fine */
}

const stampPath = join(repoRoot, ".dsh-link.json");
const stamp = { harnessRoot, commit: identity, packages: NEEDED, linkedAt: new Date().toISOString() };
const previous = existsSync(stampPath) ? JSON.parse(readFileSync(stampPath, "utf8")) : undefined;
if (previous !== undefined && previous.commit !== identity) {
  console.warn(
    `\n⚠ dsh 构建已变化：${previous.commit} → ${identity}\n` + `  行为若与预期不符，先看这一行。重跑测试确认。`,
  );
}
writeFileSync(stampPath, JSON.stringify(stamp, null, 2) + "\n");

console.log(`\n已链接 ${linked} 个包（dsh @ ${identity}）。Node 现在与 dsh 共用同一份框架。`);
