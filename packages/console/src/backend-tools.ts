/**
 * backend-tools.ts — the CLIs seats run on: which version is installed, which
 * is newest, and how this machine would upgrade one.
 *
 * Here because a seat's failure is very often not the seat's: 「The
 * 'gpt-6-sol' model is not supported」 was a Codex CLI nine releases old, and
 * nothing on any screen said so. The versions are shown where agents are
 * configured, with the one action that fixes it.
 *
 * The decisions are pure and tested; the two functions at the bottom do the
 * running. Nothing here takes a command from a request — the only input a
 * caller supplies is WHICH tool, and every argv is built from a closed table.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { BackendTool, InstallMethod, ToolStatus, UpgradeReport } from "./wire.ts";

export type { BackendTool, InstallMethod, ToolStatus, UpgradeReport };

/** What each tool is called on the command line, and where its releases are announced. */
const TOOLS: Readonly<Record<BackendTool, { readonly command: string; readonly npmPackage?: string }>> = {
  "claude-code": { command: "claude", npmPackage: "@anthropic-ai/claude-code" },
  codex: { command: "codex", npmPackage: "@openai/codex" },
  dsh: { command: "dsh" },
};

export const BACKEND_TOOLS: readonly BackendTool[] = ["claude-code", "codex", "dsh"];

/**
 * The version inside whatever a `--version` printed.
 *
 * Each CLI words it differently — `codex-cli 0.162.0`, `2.1.294 (Claude
 * Code)`, a bare `0.1.2-alpha.5` — so the first thing shaped like a version
 * is taken rather than a format being expected.
 */
export function parseVersion(output: string): string | undefined {
  return /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(output)?.[0];
}

/**
 * Order two versions: negative when `a` is older.
 *
 * Semver's rule for pre-releases, because all three tools ship them: a
 * release outranks its own pre-releases, and pre-release identifiers compare
 * field by field, numerically where both are numbers.
 */
export function compareVersions(a: string, b: string): number {
  const split = (version: string): { core: number[]; pre: string[] } => {
    const [core = "", ...rest] = version.split("-");
    const pre = rest.join("-");
    return {
      core: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
      pre: pre === "" ? [] : pre.split("."),
    };
  };
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < 3; index++) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const l = left.pre[index];
    const r = right.pre[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const bothNumbers = /^\d+$/.test(l) && /^\d+$/.test(r);
    const difference = bothNumbers ? Number(l) - Number(r) : l < r ? -1 : l > r ? 1 : 0;
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * How this tool was installed, read off where its executable really lives.
 *
 * The RESOLVED path, because the name on PATH is a symlink for every one of
 * them and says nothing: an npm global sits under `lib/node_modules`, Claude
 * Code's own installer keeps versions under `.local/share/claude`, and dsh is
 * a source checkout launched from `apps/cli`.
 */
export function installMethodOf(tool: BackendTool, resolvedPath: string): InstallMethod {
  const path = resolvedPath.replace(/\\/g, "/");
  const npmPackage = TOOLS[tool].npmPackage;
  if (npmPackage !== undefined && path.includes(`/node_modules/${npmPackage}/`)) return "npm-global";
  if (tool === "claude-code" && path.includes("/.local/share/claude/versions/")) return "native";
  if (tool === "dsh" && path.includes("/apps/cli/")) return "git-checkout";
  return "unknown";
}

/**
 * The npm prefix an npm-global install lives under, from its resolved path.
 *
 * So the upgrade goes back into the SAME tree. A machine can have several
 * npms (Homebrew's, nvm's, conda's), and upgrading through whichever one is
 * first on PATH installs a second copy that the `codex` on PATH never runs.
 */
export function npmPrefixOf(resolvedPath: string): string | undefined {
  const path = resolvedPath.replace(/\\/g, "/");
  const at = path.indexOf("/lib/node_modules/");
  return at < 0 ? undefined : path.slice(0, at);
}

/**
 * The upgrade for one tool, as argv.
 *
 * Nothing for dsh, and that is deliberate: it is the harness Squad itself
 * runs on, not a program a seat calls. Replacing it in place can leave Squad
 * unable to start — and with it the button that would undo the upgrade. It
 * is upgraded by trying the new version beside the old one first.
 *
 * Nothing for an install nobody recognised, either: a guess here would be a
 * command run against somebody's machine on a hunch.
 */
export function upgradeArgv(
  tool: BackendTool,
  method: InstallMethod,
): { readonly command: string; readonly args: readonly string[] } | undefined {
  const npmPackage = TOOLS[tool].npmPackage;
  if (method === "npm-global" && npmPackage !== undefined) {
    return { command: "npm", args: ["install", "-g", `${npmPackage}@latest`] };
  }
  if (tool === "claude-code" && method === "native") return { command: "claude", args: ["update"] };
  return undefined;
}

/** The newest `dsh-v…` tag in `git ls-remote --tags` output. */
export function newestDshTag(lsRemote: string): string | undefined {
  const versions = [...lsRemote.matchAll(/refs\/tags\/dsh-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\^\{\})?$/gm)].map(
    (match) => match[1] as string,
  );
  return versions.sort(compareVersions).at(-1);
}

/** Put a status together from what was found. Pure, so the wording is tested. */
export function describeTool(found: {
  readonly tool: BackendTool;
  readonly resolvedPath?: string | undefined;
  readonly installed?: string | undefined;
  readonly latest?: string | undefined;
}): ToolStatus {
  const { tool, resolvedPath, installed, latest } = found;
  const command = TOOLS[tool].command;
  if (resolvedPath === undefined) {
    return { tool, command, outdated: false, method: "unknown", canUpgrade: false, problem: `没有找到 ${command}。` };
  }
  const method = installMethodOf(tool, resolvedPath);
  const plan = upgradeArgv(tool, method);
  const outdated = installed !== undefined && latest !== undefined && compareVersions(installed, latest) < 0;
  const problem =
    installed === undefined
      ? `${command} --version 没有返回版本号，它可能装坏了。`
      : latest === undefined
        ? "查不到最新版本（网络不通或源不可达）。"
        : tool === "dsh" && outdated
          ? "dsh 是 Squad 运行的底座，不能直接覆盖升级：要先把新版放在旁边验证通过，再切换过去。"
          : outdated && plan === undefined
            ? `认不出 ${command} 是怎么安装的，请按你当初的安装方式手动升级。`
            : undefined;
  return {
    tool,
    command,
    ...(installed === undefined ? {} : { installed }),
    ...(latest === undefined ? {} : { latest }),
    outdated,
    method,
    ...(plan === undefined ? {} : { upgradeCommand: [plan.command, ...plan.args].join(" ") }),
    // A broken install may be repaired by the same command, so the button is
    // offered for one that will not report a version as well as an old one.
    canUpgrade: plan !== undefined && (outdated || installed === undefined),
    ...(problem === undefined ? {} : { problem }),
  };
}

// ── Running things ─────────────────────────────────────────────────────────

interface Ran {
  readonly ok: boolean;
  readonly output: string;
}

function run(command: string, args: readonly string[], timeoutMs: number): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, output: `${String(stdout)}${String(stderr)}`.trim() });
    });
  });
}

/** Find an executable on PATH, the way a shell would. */
function onPath(command: string): string | undefined {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function resolved(command: string): Promise<string | undefined> {
  const found = onPath(command);
  if (found === undefined) return undefined;
  try {
    return await realpath(found);
  } catch {
    return undefined;
  }
}

async function installedVersion(command: string): Promise<{ version?: string; output: string }> {
  const ran = await run(command, ["--version"], 20_000);
  const version = ran.ok ? parseVersion(ran.output) : undefined;
  return { ...(version === undefined ? {} : { version }), output: ran.output };
}

async function latestVersion(tool: BackendTool, resolvedPath: string | undefined): Promise<string | undefined> {
  const npmPackage = TOOLS[tool].npmPackage;
  try {
    if (npmPackage !== undefined) {
      const response = await fetch(`https://registry.npmjs.org/${npmPackage}/latest`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { version?: unknown };
      return typeof body.version === "string" ? body.version : undefined;
    }
    if (resolvedPath === undefined) return undefined;
    // dsh is a checkout; its own remote is where its releases are tagged.
    const tags = await run("git", ["-C", dirname(resolvedPath), "ls-remote", "--tags", "origin"], 20_000);
    return tags.ok ? newestDshTag(tags.output) : undefined;
  } catch {
    return undefined;
  }
}

/** What is installed, what is newest, and how this machine would upgrade it. */
export async function inspectTool(tool: BackendTool): Promise<ToolStatus> {
  const command = TOOLS[tool].command;
  const resolvedPath = await resolved(command);
  const [installed, latest] = await Promise.all([
    resolvedPath === undefined
      ? Promise.resolve({ output: "" } as { version?: string; output: string })
      : installedVersion(command),
    latestVersion(tool, resolvedPath),
  ]);
  return describeTool({ tool, resolvedPath, installed: installed.version, latest });
}

/** One upgrade at a time: two npm installs into one tree corrupt it. */
let upgrading = false;

/**
 * Upgrade one tool, then prove it still runs.
 *
 * `--version` afterwards is the test, not the installer's exit code. npm
 * reported success on a Codex upgrade that left the CLI unable to start: its
 * platform binary is an OPTIONAL dependency, the copy in npm's cache was
 * damaged, and a failed optional dependency is skipped in silence. So when an
 * npm upgrade leaves a tool that will not run, it is done once more against
 * an empty cache — which is what repaired it by hand.
 */
export async function upgradeTool(tool: BackendTool): Promise<UpgradeReport> {
  if (upgrading) throw new Error("已经有一个升级在进行，等它结束。");
  upgrading = true;
  const log: string[] = [];
  try {
    const command = TOOLS[tool].command;
    const resolvedPath = await resolved(command);
    if (resolvedPath === undefined) throw new Error(`没有找到 ${command}。`);
    const method = installMethodOf(tool, resolvedPath);
    const plan = upgradeArgv(tool, method);
    if (plan === undefined) {
      throw new Error(
        tool === "dsh"
          ? "dsh 不在这里升级：它是 Squad 运行的底座，要先在旁边验证新版。"
          : `认不出 ${command} 是怎么安装的，没法替你升级。`,
      );
    }
    const before = (await installedVersion(command)).version;

    // The npm that owns this install, not whichever is first on PATH.
    const prefix = method === "npm-global" ? npmPrefixOf(resolvedPath) : undefined;
    const ownNpm = prefix === undefined ? undefined : join(prefix, "bin", "npm");
    const program = plan.command === "npm" && ownNpm !== undefined && existsSync(ownNpm) ? ownNpm : plan.command;

    const attempt = async (extra: readonly string[]): Promise<string | undefined> => {
      const ran = await run(program, [...plan.args, ...extra], 10 * 60_000);
      log.push(`$ ${[plan.command, ...plan.args, ...extra].join(" ")}`, ran.output);
      const after = await installedVersion(command);
      if (after.version === undefined) log.push(`$ ${command} --version`, after.output);
      return after.version;
    };

    let after = await attempt([]);
    if (after === undefined && method === "npm-global") {
      const cache = await mkdtemp(join(tmpdir(), "squad-npm-cache-"));
      try {
        log.push("升级后运行不起来，换一个空缓存重装一次。");
        after = await attempt(["--cache", cache]);
      } finally {
        await rm(cache, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    return {
      tool,
      ok: after !== undefined,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      log: log.filter((line) => line !== "").join("\n"),
    };
  } finally {
    upgrading = false;
  }
}
