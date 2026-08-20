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
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
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

console.log(`\n已链接 ${linked} 个包。Node 现在与 dsh 共用同一份框架。`);
