/**
 * ui.mjs — open the Squad UI.
 *
 * Boots the `squad` profile with its web app and prints the address. The
 * process stays in the foreground: the harness has no exit condition of its
 * own, so Ctrl-C is how you stop it.
 *
 * What you get is DeepSeek Harness's own interface with Squad's slash
 * commands registered into it. The commands are the whole surface — there is
 * no Squad-specific screen — and that is deliberate: a command runs because a
 * person typed it, and never reaches the model, so nothing above the table can
 * quietly put an LLM in the host's chair.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const harness = join(homedir(), ".local/share/roundtable/deepseek-harness/apps/cli/lib/bin.js");
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh-squad-dev");

if (!existsSync(harness)) {
  console.error(`找不到 DSH：${harness}`);
  process.exit(1);
}
if (!existsSync(join(dshHome, "profiles", "squad"))) {
  console.error(`profile 还没装到 ${dshHome}。先跑：npm run install-profile`);
  process.exit(1);
}

console.log(`DSH_HOME = ${dshHome}`);
console.log("启动中……地址会打印在下面。Ctrl-C 停止。\n");
console.log("首次打开会要一个 DeepSeek API key —— 那是 DSH 自己的宿主会话要用的。");
console.log("席位跑的是你本机的 Claude Code 登录，与它无关。");
console.log("配好之后新建一个会话，命令面板里就能用 /squad-new 等九条命令。\n");

const child = spawn(process.execPath, [harness, "--profile", "squad"], {
  env: { ...process.env, DSH_HOME: dshHome },
  stdio: "inherit",
});
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", (code) => process.exit(code ?? 0));
