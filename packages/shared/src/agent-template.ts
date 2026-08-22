/**
 * agent-template.ts — a reusable agent, configured once.
 *
 * Carried over from 1.x, where the Agent library was the thing that made a
 * second team cheap: you configure a 「架构」 once — its backend, its model, its
 * standing instructions, its ceilings — and every team after that picks it off
 * a list. 2.0 briefly did without one, and the cost showed up immediately in
 * the console: adding a seat could set a name and a role and nothing else, so
 * there was no way to say what model it ran on at the moment you were creating
 * it.
 *
 * What is NOT here is the model connection. A template REFERENCES one by id,
 * exactly as a seat does, because a gateway is shared by many agents and
 * copying its endpoint into each of them means rotating it touches every copy
 * — and the copy that was missed fails weeks later for a reason nobody
 * connects to the edit. That was already the argument for `SeatConnection`;
 * it does not become a different argument one layer up.
 */
import type { SeatCaps } from "./connection.ts";

/** Which CLI runs this agent. Provider names are fixed by dsh. */
export type AgentBackend = "claude-code" | "codex" | "dsh";

/**
 * How much the CLI may do without asking.
 *
 * Two closed lists rather than one union of everything, because the two
 * backends do not have the same axes: Claude Code has a permission mode,
 * Codex has a sandbox level. A single flat list would let a person pick
 * `plan` for a Codex agent, which that CLI has never heard of, and the error
 * would arrive from the child process at the first round.
 */
export const CLAUDE_PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;
export const CODEX_PERMISSION_MODES = ["read-only", "workspace", "yolo"] as const;
export type PermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number] | (typeof CODEX_PERMISSION_MODES)[number];

/** The permission modes this backend actually accepts. */
export function permissionModesFor(backend: AgentBackend): readonly PermissionMode[] {
  return backend === "codex" ? CODEX_PERMISSION_MODES : CLAUDE_PERMISSION_MODES;
}

/** What a backend gets when nobody chose. */
export function defaultPermissionMode(backend: AgentBackend): PermissionMode {
  return backend === "codex" ? "workspace" : "acceptEdits";
}

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface AgentTemplate {
  readonly templateId: string;
  readonly displayName: string;
  readonly role: string;
  /** Standing instructions. Travels inside the prompt; see `SeatSpec`. */
  readonly systemPrompt: string;
  readonly backend: AgentBackend;
  /** Which connection supplies the model. Absent means the host's own login. */
  readonly connectionId?: string | undefined;
  readonly permissionMode?: PermissionMode | undefined;
  /** Codex only. */
  readonly reasoningEffort?: ReasoningEffort | undefined;
  readonly caps?: SeatCaps | undefined;
  /** Whether this agent may be a team's secretary. */
  readonly secretaryCandidate: boolean;
  /** A tint, so a roster of six is readable at a glance. */
  readonly color: string;
  /**
   * Soft delete.
   *
   * A template a team was built from is not removed outright: the team holds
   * a copy of what it needed, but the library entry is what tells a person
   * where that seat came from. 1.x learned this — a hard delete left teams
   * referring to an agent that no screen could explain.
   */
  readonly enabled: boolean;
}

export interface AgentTemplateProblem {
  readonly field: string;
  readonly detail: string;
}

/**
 * Check a template before it is saved.
 *
 * Field-tagged, so a form can put each complaint under the input that caused
 * it. A single joined sentence is what the console shipped first, and it read
 * as a wall of text next to three empty boxes.
 */
export function checkAgentTemplate(template: AgentTemplate): readonly AgentTemplateProblem[] {
  const problems: AgentTemplateProblem[] = [];
  if (template.displayName.trim() === "") problems.push({ field: "displayName", detail: "要有一个名字。" });
  if (template.role.trim() === "") problems.push({ field: "role", detail: "要写清楚这个 agent 的角色。" });
  if (template.systemPrompt.trim() === "") {
    problems.push({ field: "systemPrompt", detail: "要有提示词——它是这个 agent 每一轮唯一读到的常驻说明。" });
  }
  if (
    template.permissionMode !== undefined &&
    !permissionModesFor(template.backend).includes(template.permissionMode)
  ) {
    problems.push({
      field: "permissionMode",
      detail: `${template.backend} 没有「${template.permissionMode}」这个权限模式——它会被原样交给子进程，报错来自 CLI 而不是这里。`,
    });
  }
  if (template.reasoningEffort !== undefined && template.backend !== "codex") {
    problems.push({ field: "reasoningEffort", detail: "推理档位只有 codex 有。" });
  }
  return problems;
}
