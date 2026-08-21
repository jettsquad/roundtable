/**
 * argv.ts — the command line, and the fence the stock provider cannot build.
 *
 * The reason this package exists. `@deepseek-ai/dsh-subagent-claude-code`
 * hardcodes `disallowedTools: ['AskUserQuestion']` and exposes no way to add
 * to it: its config carries `env` and `disposeGraceMs` and nothing else. So a
 * secretary asked to draft an agenda can spawn its own subagents to do the
 * work instead — which is exactly what happened in 1.x, where a secretary
 * that did not know the roster invented a team of its own.
 *
 * 1.x's executor does not fix that either. It builds
 *
 *     claude -p <prompt> --output-format stream-json --verbose
 *            --include-partial-messages --permission-mode <mode>
 *
 * with no tool restriction at all — it is the cause, not the cure. What IS
 * worth carrying from it is everything else: stream-json for real activity,
 * partial messages so a long silence is distinguishable from a wedged
 * process, and the permission-mode mapping.
 *
 * Verified before building on it: `claude -p … --disallowed-tools Task`
 * answers "当前环境没有可供派生子 agent 执行一次性任务的 Task 工具，所以我
 * 直接用只读命令完成了这个任务". Structurally blocked, not asked nicely.
 */

/** Which tools a seat may see. Mirrors dsh's `ToolRestriction`. */
export interface ToolFence {
  /** Only these stay visible. */
  readonly allow?: readonly string[] | undefined;
  /** These are removed. */
  readonly deny?: readonly string[] | undefined;
}

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface ArgvInput {
  readonly prompt: string;
  readonly toolFilter?: ToolFence | undefined;
  /** Appended to the CLI's own system prompt, not replacing it. */
  readonly persona?: string | undefined;
  readonly model?: string | undefined;
  readonly permissionMode?: PermissionMode | undefined;
  /**
   * Tools no seat may ever use, whatever the caller asked for.
   *
   * Delegation is the one that matters: a seat that spawns its own helpers
   * turns one accountable participant into an unlogged crowd, and nothing
   * downstream can tell the difference — the reply looks the same. This is a
   * floor rather than a default, so a caller cannot remove it by supplying
   * its own filter and forgetting.
   */
  readonly alwaysDeny?: readonly string[] | undefined;
}

/** Delegation tools, denied to every seat unless the composition says otherwise. */
export const DELEGATION_TOOLS: readonly string[] = ["Task", "Agent"];

/**
 * Build the argv for one seat turn.
 *
 * `allow` and `deny` both travel when both are given: the CLI applies allow as
 * a whitelist and deny on top, so a floor denial still holds inside an
 * allow-list a caller wrote without thinking about delegation.
 */
export function buildArgv(input: ArgvInput): readonly string[] {
  const argv = [
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    // Without partial messages the CLI emits nothing while the model thinks,
    // so a long reasoning block is indistinguishable from a wedged process and
    // an idle clock kills a seat that is working.
    "--include-partial-messages",
  ];

  const mode = input.permissionMode ?? "acceptEdits";
  if (mode === "bypassPermissions") argv.push("--dangerously-skip-permissions");
  else argv.push("--permission-mode", mode);

  if (input.model !== undefined && input.model !== "") argv.push("--model", input.model);
  if (input.persona !== undefined && input.persona.trim() !== "") {
    argv.push("--append-system-prompt", input.persona);
  }

  const allow = input.toolFilter?.allow ?? [];
  if (allow.length > 0) argv.push("--allowed-tools", ...allow);

  const deny = [...new Set([...(input.alwaysDeny ?? DELEGATION_TOOLS), ...(input.toolFilter?.deny ?? [])])];
  if (deny.length > 0) argv.push("--disallowed-tools", ...deny);

  return argv;
}
