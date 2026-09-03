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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Launch the harness this checkout is LINKED to, not whichever one sits at
 * the conventional path.
 *
 * Those were the same thing until an upgrade was tried from a second
 * checkout — and then the two split without a word: the repository compiled,
 * tested and bundled against the new harness while this script kept starting
 * the old one. Nothing reports that; you find out when a call the new version
 * introduced is missing at runtime, from a stack that names neither version.
 *
 * `link-dsh` already writes the binding down. Read it.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const stampPath = join(repoRoot, ".dsh-link.json");
const stamp = existsSync(stampPath) ? JSON.parse(readFileSync(stampPath, "utf8")) : undefined;
const harnessRoot =
  process.env.DSH_SOURCE ?? stamp?.harnessRoot ?? join(homedir(), ".local/share/roundtable/deepseek-harness");
const harness = join(harnessRoot, "apps/cli/lib/bin.js");
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh-squad-dev");

if (!existsSync(harness)) {
  console.error(
    `找不到 DSH：${harness}\n` +
      (stamp === undefined
        ? "先跑 npm install（会自动 link-dsh）。"
        : `（这是 .dsh-link.json 记的 harnessRoot。它没构建过的话，先在那边跑一次 pnpm run build。）`),
  );
  process.exit(1);
}
if (!existsSync(join(dshHome, "profiles", "squad"))) {
  console.error(`profile 还没装到 ${dshHome}。先跑：npm run install-profile`);
  process.exit(1);
}

console.log(`DSH   = ${harnessRoot}${stamp?.commit === undefined ? "" : ` @ ${stamp.commit}`}`);
console.log(`DSH_HOME = ${dshHome}`);
console.log("启动中……地址会打印在下面。Ctrl-C 停止。\n");
console.log("首次打开会要一个 DeepSeek API key —— 那是 DSH 自己的宿主会话要用的。");
console.log("席位跑的是你本机的 Claude Code 登录，与它无关。");
console.log("配好之后新建一个会话，命令面板里就能用 /squad-new 等九条命令。\n");

/**
 * The port, and why it is a flag rather than a patch line.
 *
 * The profile's `webserver` row already reads `ctx.webStartup.port ?? 3080`,
 * and `web-startup` publishes what `--port` named. Pinning the port by
 * replacing that row's config instead would take the flag out of play — the
 * override would win over an explicit `--port` on the command line, which is
 * the opposite of what a flag is for.
 */
const port = process.env.SQUAD_PORT ?? "9527";

const child = spawn(process.execPath, [harness, "--profile", "squad", "--port", port], {
  env: { ...process.env, DSH_HOME: dshHome },
  stdio: "inherit",
});
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", (code) => process.exit(code ?? 0));
