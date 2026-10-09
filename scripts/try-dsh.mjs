/**
 * try-dsh.mjs — try a different dsh build BESIDE the one in use.
 *
 *   node scripts/try-dsh.mjs <path to a built dsh checkout>
 *
 * dsh is not a tool a seat calls; it is the harness Squad runs on. Replacing
 * it in place and finding out afterwards is the wrong order — when it does
 * not fit, Squad does not start, and neither does anything that would undo
 * the upgrade. So the new build is tried from a copy of this repository,
 * against a copy of the data, with the working install untouched throughout:
 *
 *   1. copy the working tree (uncommitted adaptations included)
 *   2. link the copy to the new build
 *   3. typecheck, test, bundle the client — the bundle step compares the
 *      platform-module table with the new shell's
 *   4. check the delegation fence still names plugins that exist
 *   5. boot Squad on the new build over a COPY of the real data, and compare
 *      what came back with what is stored
 *
 * Every check runs even after one fails: the point of a trial is the whole
 * list of what needs adapting, not the first item on it.
 *
 * Nothing here switches anything. `switch-dsh.mjs` does that, and refuses
 * unless the trial it is handed passed.
 */
import { execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harnessArg = process.argv[2];
if (harnessArg === undefined) {
  console.error("用法：node scripts/try-dsh.mjs <构建好的 dsh 目录>");
  process.exit(2);
}
const harness = resolve(harnessArg);
const bin = join(harness, "apps/cli/lib/bin.js");
if (!existsSync(bin)) {
  console.error(`${harness} 还没构建：找不到 apps/cli/lib/bin.js。先在那边跑 pnpm install && npm run build。`);
  process.exit(2);
}

const version = JSON.parse(readFileSync(join(harness, "package.json"), "utf8")).version ?? "unknown";
const realHome = process.env.DSH_HOME ?? join(homedir(), ".dsh-squad-dev");
const trialRoot = join(homedir(), ".cache", "squad-dsh-trial", version);
const trialRepo = join(trialRoot, "repo");
const trialHome = join(trialRoot, "home");
const reportPath = join(trialRoot, "report.json");

/** Run one command; never throws, so every check gets its turn. */
function run(command, args, options = {}) {
  return new Promise((done) => {
    execFile(
      command,
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: options.timeoutMs ?? 15 * 60_000, cwd: options.cwd, env: options.env },
      (error, stdout, stderr) => done({ ok: error === null, output: `${stdout}${stderr}`.trim() }),
    );
  });
}

const results = [];
/** Record one check and say so at once — a trial that prints nothing for ten minutes reads as hung. */
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail === "" ? "" : `\n    ${detail.split("\n").join("\n    ")}`}`);
}

const tail = (text, lines = 25) => text.split("\n").slice(-lines).join("\n");

/**
 * Why records did not come back, without the noise of the shutdown.
 *
 * Stopping the trial server fails every restore still in flight with the
 * same 「inactive context」 line — dozens of them, all caused by the trial
 * ending, burying the one or two that say what actually went wrong.
 */
const restoreFailures = (log) => {
  const lines = log.split("\n").filter((line) => line.includes("没能恢复"));
  const real = lines.filter((line) => !line.includes("inactive context"));
  const reasons = new Map();
  for (const line of real) {
    const reason = line.slice(line.indexOf("：") + 1).trim();
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  return real.length === 0
    ? `没有记录到恢复失败的原因（${lines.length} 条是试装结束时被打断的）。最后的输出：\n${tail(log, 15)}`
    : [...reasons].map(([reason, count]) => `${count} 场：${reason}`).join("\n");
};

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

console.log(`试装 dsh ${version}（${harness}）`);
console.log(`现用的安装和数据都不会被改动。试装目录：${trialRoot}\n`);

// ── 1. A copy of the working tree ───────────────────────────────────────────
// rsync rather than a git worktree: adapting to a new dsh happens in the
// working tree, and a trial that only saw commits would test yesterday's code.
mkdirSync(trialRepo, { recursive: true });
const sync = await run("rsync", [
  "-a",
  "--delete",
  "--exclude=node_modules",
  "--exclude=.git",
  "--exclude=.dsh-link.json",
  "--exclude=packages/*/client",
  `${repoRoot}/`,
  `${trialRepo}/`,
]);
record("复制当前代码（含未提交的改动）", sync.ok, sync.ok ? "" : tail(sync.output));

const inRepo = { cwd: trialRepo, env: { ...process.env, DSH_SOURCE: harness, DSH_HOME: trialHome } };

// `--ignore-scripts`: the postinstall links to the dsh IN USE, which is the
// one thing this copy must not be bound to.
const install = await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], inRepo);
record("安装依赖", install.ok, install.ok ? "" : tail(install.output));

// ── 2. Link to the new build ────────────────────────────────────────────────
const link = await run(process.execPath, ["scripts/link-dsh.mjs"], inRepo);
record("链接到新版 dsh 的包", link.ok, link.ok ? "" : tail(link.output));

// ── 3. Does our code still fit ──────────────────────────────────────────────
const typecheck = await run("npm", ["run", "--silent", "typecheck"], inRepo);
record(
  "类型检查",
  typecheck.ok,
  typecheck.ok
    ? ""
    : `${typecheck.output.split("\n").filter((line) => line.includes("error TS")).length} 处类型错误：\n${tail(typecheck.output, 40)}`,
);

const test = await run("npm", ["test", "--silent"], inRepo);
const summary = test.output
  .split("\n")
  .filter((line) => /Test Files|Tests\s/.test(line))
  .join(" / ")
  .trim();
record("单元测试", test.ok, test.ok ? summary : `${summary}\n${tail(test.output, 40)}`);

const bundle = await run(process.execPath, ["scripts/build-client.mjs"], inRepo);
record("前端打包（含与新版 shell 的共享模块对照）", bundle.ok, bundle.ok ? "" : tail(bundle.output));

// ── 4. The delegation fence ─────────────────────────────────────────────────
// The fence names six plugins by id. A version that renamed one would leave
// the patch row matching nothing, and a dsh seat would spawn subagents again
// with every screen still saying it cannot.
const patchSource = readFileSync(join(trialRepo, "packages/seat-dsh/src/patch.ts"), "utf8");
const listed = /DELEGATION_PLUGINS[^=]*=\s*\[([^\]]*)\]/.exec(patchSource)?.[1] ?? "";
const plugins = [...listed.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const fenceHome = join(trialRoot, "fence-home");
const fencePatch = join(trialRoot, "fence.patch.yml");
writeFileSync(fencePatch, plugins.flatMap((id) => [`- id: ${id}`, "  disabled: true"]).join("\n") + "\n");
const fenceEnv = { ...process.env, DSH_HOME: fenceHome };
const plain = await run(process.execPath, [bin, "--profile", "headless", "--dump-config"], { env: fenceEnv });
const fenced = await run(process.execPath, [bin, "--profile", "headless", "--patch", fencePatch, "--dump-config"], {
  env: fenceEnv,
});
/** id → whether its row carries `disabled: true`, read off a dumped tree. */
const rowsOf = (dump) => {
  const rows = new Map();
  let current;
  for (const line of dump.split("\n")) {
    const id = /^- id: (.+)$/.exec(line)?.[1];
    if (id !== undefined) {
      current = id.trim();
      rows.set(current, false);
    } else if (current !== undefined && /^\s+disabled: true\s*$/.test(line)) rows.set(current, true);
  }
  return rows;
};
const before = rowsOf(plain.output);
const after = rowsOf(fenced.output);
const missing = plugins.filter((id) => !before.has(id));
const stillOn = plugins.filter((id) => before.has(id) && after.get(id) !== true);
// And the other direction: a plugin this version ADDED that spawns subagents
// would be a way round the fence that no existing row covers.
const suspicious = [...before.keys()].filter(
  (id) => /subagent|ralph|workflow|delegat|spawn/i.test(id) && id.startsWith("tool-") && !plugins.includes(id),
);
record(
  "子 agent 围栏：六个插件在新版里还在，patch 还能关掉它们",
  plain.ok &&
    fenced.ok &&
    plugins.length > 0 &&
    missing.length === 0 &&
    stillOn.length === 0 &&
    suspicious.length === 0,
  [
    !plain.ok ? `新版 headless 剖面导不出配置：\n${tail(plain.output, 10)}` : "",
    missing.length > 0 ? `新版里已经没有这些插件（可能改名了）：${missing.join("、")}` : "",
    stillOn.length > 0 ? `patch 没能关掉：${stillOn.join("、")}` : "",
    suspicious.length > 0 ? `新版多出了看起来能派生子 agent、围栏没覆盖的工具插件：${suspicious.join("、")}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n"),
);

// ── 5. Boot, over a copy of the real data ───────────────────────────────────
// A COPY: a new dsh may migrate what it opens, and a session log rewritten
// by a version that is then not adopted is a log the old version may refuse.
let stored;
if (existsSync(realHome)) {
  rmSync(trialHome, { recursive: true, force: true });
  cpSync(realHome, trialHome, {
    recursive: true,
    // The profile is reinstalled against the new build below; the lock would
    // make the trial think the real Squad is itself.
    filter: (source) => !source.startsWith(join(realHome, "profiles")) && !source.endsWith("squad-ui.lock"),
  });
  try {
    const table = JSON.parse(readFileSync(join(trialHome, "storages", "squad_table.json"), "utf8"));
    stored = Object.keys(table.tables?.teams ?? {}).length;
  } catch {
    stored = undefined;
  }
  record("复制真实数据供试启动用", true, stored === undefined ? "（没读到已存的团队数）" : `已存 ${stored} 场讨论`);
} else {
  mkdirSync(trialHome, { recursive: true });
  record("复制真实数据供试启动用", true, `${realHome} 不存在，用空目录`);
}

const profile = await run(process.execPath, ["scripts/install-profile.mjs"], inRepo);
record("在试装目录里安装 Squad 的 profile", profile.ok, profile.ok ? "" : tail(profile.output));

let booted = false;
let restored;
let bootLog = "";
if (profile.ok) {
  const port = await freePort();
  const child = spawn(process.execPath, [bin, "--profile", "squad", "--port", String(port), "--no-open"], {
    cwd: trialRepo,
    env: { ...process.env, DSH_HOME: trialHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => (bootLog += String(chunk)));
  child.stderr.on("data", (chunk) => (bootLog += String(chunk)));
  let exited = false;
  child.on("exit", () => (exited = true));
  // Restoring is off the boot path and, with real data, one `agents.resume`
  // per stored record — minutes, not seconds. Waited for until everything is
  // back; given up on only after a full minute with nothing new, because a
  // single slow record must not be read as the rest having failed.
  const deadline = Date.now() + 8 * 60_000;
  let lastGrowth = Date.now();
  while (Date.now() < deadline && !exited) {
    await new Promise((wait) => setTimeout(wait, 2000));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/squad/teams`, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) continue;
      const body = await response.json();
      if (!Array.isArray(body.teams)) continue;
      booted = true;
      if (body.teams.length !== restored) lastGrowth = Date.now();
      restored = body.teams.length;
      if (stored === undefined || restored >= stored) break;
      if (Date.now() - lastGrowth > 60_000) break;
    } catch {
      /* not up yet */
    }
  }
  child.kill("SIGTERM");
  await new Promise((wait) => setTimeout(wait, 1500));
  if (!exited) child.kill("SIGKILL");
}
record("Squad 在新版 dsh 上启动，接口有应答", booted, booted ? "" : tail(bootLog, 30));
if (booted && stored !== undefined) {
  record(
    "真实数据的副本全部恢复",
    restored === stored,
    restored === stored
      ? `${restored} / ${stored} 场`
      : `只恢复了 ${restored} / ${stored} 场。\n${restoreFailures(bootLog)}`,
  );
}

// The copy of the data has served its purpose. It holds everything the real
// home does, and a second copy of that has no business outliving the trial.
rmSync(trialHome, { recursive: true, force: true });
rmSync(fenceHome, { recursive: true, force: true });

// ── The verdict ─────────────────────────────────────────────────────────────
const passed = results.every((result) => result.ok);
const commit = (await run("git", ["-C", harness, "rev-parse", "--short", "HEAD"])).output.split("\n")[0] ?? "";
writeFileSync(
  reportPath,
  JSON.stringify({ harness, version, commit, passed, at: new Date().toISOString(), results }, null, 2) + "\n",
);
const failed = results.filter((result) => !result.ok);
console.log(
  passed
    ? `\n全部通过。dsh ${version} 可以切换：node scripts/switch-dsh.mjs ${harness}`
    : `\n${failed.length} 项没过：${failed.map((result) => result.name).join("；")}\n现用的 dsh 没有动。先把这几项适配好，再试一次。`,
);
console.log(`报告：${reportPath}`);
process.exit(passed ? 0 : 1);
