/**
 * argv.ts — the command line one Codex seat runs on.
 *
 * `codex exec` is the documented headless entry point, and `--json` makes it
 * emit JSONL events. The exact shape is carried from 1.x, which verified it
 * against a live CLI (0.147, 2026-08) rather than from documentation:
 *
 *   codex exec --cd <dir> --json --skip-git-repo-check
 *              [--sandbox S] [-c approval_policy=P] [-c model_reasoning_effort="E"]
 *              [--model M] <PROMPT>
 *
 * Two of those were learned the hard way and are worth keeping written down.
 *
 * `--skip-git-repo-check`: without it Codex refuses to start in any directory
 * that is not in its trusted list — a fresh, non-git project folder fails with
 * "Not inside a trusted directory", which names nothing the person did. The
 * team's project folder was chosen by a human at team creation, and that
 * choice IS the authorization. The flag relaxes only that startup check;
 * sandbox and approval policy still govern what the agent may do.
 *
 * Approval policy goes through `-c approval_policy=…`, NOT `--ask-for-approval`
 * — the latter is a top-level `codex` flag and `codex exec` rejects it with
 * "unexpected argument".
 */
import { CODEX_PERMISSION_MODES, type PermissionMode } from "@squad/shared";

/** The permission modes this backend accepts. */
export type CodexPermissionMode = (typeof CODEX_PERMISSION_MODES)[number];

export function isCodexMode(mode: PermissionMode | string | undefined): mode is CodexPermissionMode {
  return CODEX_PERMISSION_MODES.includes(mode as CodexPermissionMode);
}

export interface CodexArgvInput {
  readonly prompt: string;
  /** The team's project folder. Codex is told explicitly, not just via cwd. */
  readonly cwd: string;
  readonly permissionMode?: CodexPermissionMode | undefined;
  /** Only when the connection's model can actually be honoured — see `modelArgumentFor`. */
  readonly model?: string | undefined;
  readonly reasoningEffort?: "low" | "medium" | "high" | undefined;
  /**
   * A custom endpoint, declared as a one-off provider.
   *
   * Codex has no base-url environment variable — its own config owns the
   * provider — so without this a connection's endpoint was stored, shown in
   * the library, and silently ignored, exactly as the dsh backend was doing.
   * `-c model_providers.*` is the documented override and it does take
   * effect: verified by watching the CLI reach the configured host.
   */
  readonly endpoint?: string | undefined;
  /**
   * Whether this seat may reach the network.
   *
   * Codex's sandbox is closed by default: with `--sandbox workspace-write`
   * and nothing else, `curl` inside it fails to connect at all. That default
   * is why every seat on this backend used to be told, every round, that it
   * had no way out — see `webAccessNote`.
   *
   * Squad passes the switch itself rather than relying on the host's
   * `~/.codex/config.toml`. Both routes open the same sandbox, but a machine
   * setting is invisible from here: the checkbox would mean「上网」on one
   * laptop and nothing on another, which is the class of setting-that-looks-
   * like-it-works this project keeps designing against.
   */
  readonly webAccess?: boolean | undefined;
}

/** The provider id one custom endpoint is declared under. */
export const CUSTOM_PROVIDER = "squad";

/**
 * Declare an endpoint as a provider Codex will use.
 *
 * `wire_api = "responses"` because it is the only one this CLI still accepts
 * — `"chat"` is refused outright with 「no longer supported」. That is a real
 * constraint on which gateways can back a Codex seat: one that speaks only
 * chat-completions cannot, however OpenAI-compatible it otherwise is.
 *
 * `env_key` names the variable rather than carrying the secret, so the key
 * never appears in a process's argument list — which `ps` shows to everyone.
 */
function providerArgs(endpoint: string): readonly string[] {
  return [
    "-c",
    `model_provider="${CUSTOM_PROVIDER}"`,
    "-c",
    `model_providers.${CUSTOM_PROVIDER}.name="Squad"`,
    "-c",
    `model_providers.${CUSTOM_PROVIDER}.base_url=${JSON.stringify(endpoint)}`,
    "-c",
    `model_providers.${CUSTOM_PROVIDER}.env_key="CODEX_API_KEY"`,
    "-c",
    `model_providers.${CUSTOM_PROVIDER}.wire_api="responses"`,
  ];
}

/**
 * Codex's two-axis permission model, under the names a person picked.
 *
 * `read-only` is the analogue of Claude Code's `plan`: analyse, do not edit.
 * `workspace` is the documented safe combination and the default.
 * `yolo` bypasses both axes — the docs limit it to externally hardened
 * environments, and it is offered because a person may have one, not because
 * it is a reasonable default.
 */
function permissionArgs(mode: CodexPermissionMode): readonly string[] {
  if (mode === "read-only") return ["--sandbox", "read-only", "-c", "approval_policy=never"];
  if (mode === "yolo") return ["--dangerously-bypass-approvals-and-sandbox"];
  return ["--sandbox", "workspace-write", "-c", "approval_policy=on-request"];
}

export function buildCodexArgv(input: CodexArgvInput): readonly string[] {
  const argv = ["exec", "--cd", input.cwd, "--json", "--skip-git-repo-check"];
  argv.push(...permissionArgs(input.permissionMode ?? "workspace"));
  // Both halves of "may this seat reach the web", written on EVERY run —
  // including the off case, which is the point. These same two keys can be set
  // in the host's `~/.codex/config.toml`, and a host that had turned
  // `tools.web_search` on there would hand a search tool to a seat whose
  // checkbox is unticked and whose prompt says it has none. Stating both ways
  // round makes the seat's argv the whole answer, whatever the machine says.
  const web = input.webAccess === true;
  // `read-only` has no writable sandbox for the key to configure and `yolo`
  // bypasses the sandbox altogether, so the network key is scoped to the mode
  // that actually reads it. The search tool is not sandbox-bound and applies
  // to all three.
  if (web && (input.permissionMode ?? "workspace") === "workspace") {
    argv.push("-c", "sandbox_workspace_write.network_access=true");
  }
  argv.push("-c", `tools.web_search=${web}`);
  if (input.endpoint !== undefined && input.endpoint.trim() !== "") argv.push(...providerArgs(input.endpoint.trim()));
  if (input.reasoningEffort !== undefined) argv.push("-c", `model_reasoning_effort="${input.reasoningEffort}"`);
  if (input.model !== undefined && input.model.trim() !== "") argv.push("--model", input.model.trim());
  // The prompt goes LAST and is one argument. It is user text with newlines
  // and quotes in it; anything that assembled it into a shell string would be
  // a command-injection hole with the team's own discussion as the payload.
  argv.push(input.prompt);
  return argv;
}
