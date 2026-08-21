/**
 * smoke.mjs — run the whole thing once, end to end, against real models.
 *
 * This is the only way to drive Squad 2.0 today. The profile stacks
 * `dsh-base` alone, which has no app layer: `ctx.teams` exists and works, and
 * nothing exposes it as a command a person can type. Every verification so
 * far has gone through the smoke plugin, which is a script, not a UI.
 *
 * Takes several minutes and makes a dozen real model calls.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const harness = join(homedir(), ".local/share/roundtable/deepseek-harness/apps/cli/lib/bin.js");
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh-squad-dev");
const projectFolder = process.env.SQUAD_SMOKE_FOLDER ?? "/tmp/squad-smoke";

if (!existsSync(harness)) {
  console.error(`找不到 DSH：${harness}`);
  process.exit(1);
}

mkdirSync(projectFolder, { recursive: true });
if (!existsSync(join(projectFolder, "README.md"))) {
  writeFileSync(join(projectFolder, "README.md"), "# smoke\n一次性验证用的空项目。\n", "utf8");
}

const patch = join(dshHome, "smoke.patch.yml");
writeFileSync(
  patch,
  `- insert:\n    - id: squad-smoke\n      name: '@squad/smoke'\n      config:\n        projectFolder: ${projectFolder}\n        instruction: 用一句话说明这个目录里有什么文件。不要改任何文件。\n`,
  "utf8",
);

console.log(`DSH_HOME = ${dshHome}`);
console.log(`项目文件夹 = ${projectFolder}`);
console.log("开始（要跑几分钟，会真的调用模型）…\n");

const child = spawn(process.execPath, [harness, "--profile", "squad", "--patch", patch, "--help"], {
  cwd: projectFolder,
  env: { ...process.env, DSH_HOME: dshHome },
  stdio: ["ignore", "pipe", "pipe"],
});

// The harness has no app layer, so it never exits on its own; the run is over
// when the smoke plugin says so.
const watch = (stream) => {
  stream.on("data", (chunk) => {
    const text = String(chunk);
    process.stdout.write(text);
    if (text.includes("全部检查跑完")) setTimeout(() => child.kill("SIGTERM"), 500);
  });
};
watch(child.stdout);
watch(child.stderr);
child.on("exit", () => process.exit(0));
