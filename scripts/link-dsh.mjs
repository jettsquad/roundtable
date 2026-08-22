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
const farmRoot = join(homedir(), ".dsh", "profiles", "node_modules");
const farm = join(farmRoot, "@deepseek-ai");

/** Only what our plugins import directly. Add here, never guess at runtime. */
const NEEDED = [
  "cordis",
  "dsh-agent",
  "dsh-subagent",
  "dsh-llm",
  "dsh-session",
  "dsh-storage",
  "dsh-storage-domain",
  "dsh-commands",
  "dsh-subprocess",
  "dsh-host-webserver",
  "dsh-credentials",
  // The directory-picker seam. Linked for its `ctx.directoryPicker`
  // declaration merge: the host resolves native-vs-browse at boot and the
  // console asks rather than assuming, so a machine with a real OS file
  // dialog actually gets one.
  "dsh-host-directory-picker",
  // Browser half. Linked for TYPES, not for bundling: `ctx.slots` on the
  // client Context is a declaration merge that only exists if this package is
  // resolvable, and the bundle keeps it external because it is a platform
  // module the shell already holds.
  "dsh-client-ui-slots",
  "dsh-client-runtime",
  // The two slot OWNERS. A slot name is only a legal argument if the package
  // that declares it has merged it into `SlotMap`; without these,
  // `ctx.slots.register({ name: "shell.overlay" })` does not type-check —
  // which is the check the hand-written bundle never got, because nothing
  // type-checked it at all.
  "dsh-client-ui-sidebar",
  "dsh-client-ui-layout",
  // Declares `conversation.view` — the keyed slot Chat and Trajectory are
  // tabs in, and therefore where a team view belongs.
  "dsh-client-ui-conversation",
  // Shared UI primitives — a platform module, so the bundle keeps it external
  // and the shell's own instance is used. This is the part of dsh's composer
  // that IS reusable; the input bar itself is not exported.
  "dsh-client-ui-primitives",
];

/**
 * Unscoped packages needing the same treatment.
 *
 * zod is here for the same reason cordis is, and the failure is worse because
 * it looks like a type error rather than a wiring one: a domain spec's schemas
 * are validated by the copy `dsh-storage-domain` imports, and zod checks
 * schema identity with its own brand symbols. Two physical copies and every
 * schema we hand it is "not a zod schema" — from a file that imports zod and
 * type-checks clean.
 */
const NEEDED_UNSCOPED = ["zod"];

if (!existsSync(farm)) {
  console.error(
    `找不到 DSH 的包农场：${farm}\n` +
      `先跑一次 dsh（例如 \`dsh --profile headless --dump-config\`）让它初始化 profile，再重试。`,
  );
  process.exit(1);
}

const modules = join(repoRoot, "node_modules");
const scope = join(modules, "@deepseek-ai");
mkdirSync(scope, { recursive: true });

const targets = [
  ...NEEDED.map((name) => ({ name: `@deepseek-ai/${name}`, source: join(farm, name), link: join(scope, name) })),
  ...NEEDED_UNSCOPED.map((name) => ({ name, source: join(farmRoot, name), link: join(modules, name) })),
];

let linked = 0;
for (const { name, source, link } of targets) {
  if (!existsSync(source)) {
    console.error(`农场里没有 ${name}：${source}`);
    process.exit(1);
  }
  // Resolve through the farm's own symlink so both paths share one realpath.
  const target = lstatSync(source).isSymbolicLink() ? readlinkSync(source) : source;
  if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link, "dir");
  console.log(`✓ ${name} → ${target}`);
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
