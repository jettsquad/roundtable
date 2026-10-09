/**
 * switch-dsh.mjs — move Squad onto a dsh build that `try-dsh` passed.
 *
 *   node scripts/switch-dsh.mjs <path to the tried dsh checkout>
 *   node scripts/switch-dsh.mjs --back        # return to the previous build
 *
 * Three things point at "the dsh in use", and all three move together or the
 * machine ends up running two versions without saying so:
 *
 *   this repository's links     what the code compiles and runs against
 *   the installed profile       what `npm run ui` boots
 *   the `dsh` on PATH           what a dsh SEAT runs — a seat is a child
 *                               process started by name, not through us
 *
 * Refused unless the trial for this exact build passed, and refused while
 * Squad is running: the harness would be swapped under a live process.
 *
 * The data is copied first. A newer dsh may rewrite what it opens, and the
 * way back to the old build has to include data the old build can still read.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh-squad-dev");
const trials = join(homedir(), ".cache", "squad-dsh-trial");
const previousPath = join(trials, "previous.json");
const stampPath = join(repoRoot, ".dsh-link.json");

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const versionOf = (root) => JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "unknown";
const commitOf = (root) => {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

// ── Not under a running Squad ───────────────────────────────────────────────
const lock = join(dshHome, "squad-ui.lock");
if (existsSync(lock)) {
  const holder = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
  let alive = false;
  try {
    process.kill(holder, 0);
    alive = true;
  } catch {
    /* a stale lock from a killed process */
  }
  if (alive) fail(`Squad 正在运行（进程 ${holder}）。先在它的终端里 Ctrl-C 停掉，再切换。`);
}

const back = process.argv[2] === "--back";
let target;
let dataNote = "";

if (back) {
  if (!existsSync(previousPath)) fail("没有可回退的记录：这台机器上还没用这个脚本切换过。");
  const previous = JSON.parse(readFileSync(previousPath, "utf8"));
  target = previous.harnessRoot;
  if (!existsSync(join(target, "apps/cli/lib/bin.js"))) fail(`上一个版本的目录不在了：${target}`);
  dataNote =
    previous.dataBackup !== undefined && existsSync(previous.dataBackup)
      ? `\n数据没有动。如果旧版打不开新版写过的会话，切换前的备份在：\n  ${previous.dataBackup}\n（把它换回 ${dshHome} 即可，但切换之后的讨论会丢。）`
      : "";
} else {
  if (process.argv[2] === undefined) fail("用法：node scripts/switch-dsh.mjs <试装通过的 dsh 目录>   或   --back");
  target = resolve(process.argv[2]);
  const reportPath = join(trials, versionOf(target), "report.json");
  if (!existsSync(reportPath)) fail(`这个版本还没试装过。先跑：node scripts/try-dsh.mjs ${target}`);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (report.passed !== true) fail(`试装没有通过，不切换。报告：${reportPath}`);
  // The build that was tried, not merely the same directory: a checkout
  // pulled forward since the trial is a build nobody has tried.
  if (report.harness !== target || report.commit !== commitOf(target)) {
    fail(
      `试装通过的是 ${report.harness} @ ${report.commit}，和现在这份（@ ${commitOf(target)}）不是同一个构建。重新试装。`,
    );
  }
}

// ── Every discussion already in Squad's own file ────────────────────────────
// A dsh from 0.1.5 on cannot open a host node's old log, and Squad then gives
// the team a fresh host node — which is only safe when the discussion has
// already been copied out of that log. The copy is made the first time a team
// is opened by a build that has `storedTeamLog`, so it has to have run once on
// the dsh being left. Checked here rather than discovered afterwards, as a
// team that comes back with nothing in it.
if (!back) {
  const tablePath = join(dshHome, "storages", "squad_table.json");
  if (existsSync(tablePath)) {
    const teams = Object.keys(JSON.parse(readFileSync(tablePath, "utf8")).tables?.teams ?? {});
    const without = teams.filter((teamId) => !existsSync(join(dshHome, "squad-records", `${teamId}.jsonl`)));
    if (without.length > 0) {
      fail(
        `${without.length} / ${teams.length} 场讨论还没有搬进 Squad 自己的记录文件（例如 ${without[0]}）。\n` +
          "先在现用的 dsh 上启动一次 Squad（npm run ui），等所有团队恢复出来，再停掉它、重新切换。",
      );
    }
  }
}

const stamp = existsSync(stampPath) ? JSON.parse(readFileSync(stampPath, "utf8")) : undefined;
const current = stamp?.harnessRoot;
if (current === target) fail(`已经在用这份 dsh 了：${target}`);

console.log(`${back ? "回退" : "切换"}：${current === undefined ? "（未知）" : `${versionOf(current)}  ${current}`}`);
console.log(`   →  ${versionOf(target)}  ${target}\n`);

// ── Copy the data, and write down the way back ──────────────────────────────
if (!back) {
  const stampNow = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dataBackup = `${dshHome}.before-dsh-${versionOf(target)}-${stampNow}`;
  if (existsSync(dshHome)) {
    console.log(`备份数据 → ${dataBackup}`);
    cpSync(dshHome, dataBackup, { recursive: true, filter: (source) => !source.endsWith("squad-ui.lock") });
  }
  if (current !== undefined) {
    writeFileSync(
      previousPath,
      JSON.stringify(
        { harnessRoot: current, version: versionOf(current), commit: commitOf(current), dataBackup, at: stampNow },
        null,
        2,
      ) + "\n",
    );
  }
}

// ── 1. This repository's links ──────────────────────────────────────────────
console.log("重新链接这个仓库…");
execFileSync(process.execPath, ["scripts/link-dsh.mjs"], {
  cwd: repoRoot,
  env: { ...process.env, DSH_SOURCE: target },
  stdio: ["ignore", "ignore", "inherit"],
});

// ── 2. The installed profile ────────────────────────────────────────────────
console.log("重装 profile…");
execFileSync(process.execPath, ["scripts/install-profile.mjs"], {
  cwd: repoRoot,
  env: { ...process.env, DSH_HOME: dshHome },
  stdio: ["ignore", "ignore", "inherit"],
});

// ── 3. The `dsh` on PATH ────────────────────────────────────────────────────
// Only a link that already points into a dsh checkout is moved. Anything else
// was put there by something this script knows nothing about.
const onPath = (process.env.PATH ?? "")
  .split(":")
  .map((dir) => join(dir, "dsh"))
  .find((candidate) => lstatSync(candidate, { throwIfNoEntry: false }) !== undefined);
const newBin = join(target, "apps/cli/lib/bin.js");
if (onPath === undefined) {
  console.warn("PATH 上没有 dsh——dsh 席位会找不到它。");
} else if (lstatSync(onPath).isSymbolicLink() && readlinkSync(onPath).endsWith("/apps/cli/lib/bin.js")) {
  rmSync(onPath);
  symlinkSync(newBin, onPath);
  console.log(`dsh 命令 → ${newBin}`);
} else {
  console.warn(`${onPath} 不是指向 dsh 检出的软链，没有改它。dsh 席位仍会运行原来那一个。`);
}

console.log(`\n✓ 已${back ? "回退" : "切换"}到 dsh ${versionOf(target)}。现在启动：npm run ui`);
if (!back) console.log("新版用着有问题：node scripts/switch-dsh.mjs --back");
if (dataNote !== "") console.log(dataNote);
