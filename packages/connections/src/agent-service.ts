/**
 * agent-service.ts — `ctx.agentTemplates`: the reusable agent library.
 *
 * The thing that makes a second team cheap. You configure 「架构」 once — its
 * backend, its connection, its standing instructions, its ceilings — and every
 * team after that picks it off a list instead of retyping it.
 *
 * Removal is a soft delete. A team built from a template holds its own copy of
 * what it needed, so a hard delete does not break the team — it breaks the
 * only screen that could explain where that seat came from. 1.x hit exactly
 * that and added `enabled` for it.
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import type { Domain } from "@deepseek-ai/dsh-storage-domain";
import { checkAgentTemplate, type AgentTemplate } from "@squad/shared";
import { SQUAD_AGENTS_DOMAIN, type AgentTemplateRecord } from "./agent-domain.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    agentTemplates: AgentTemplatesService;
  }
}

/**
 * A record as the rest of the system sees it.
 *
 * `permissionMode` is a plain string in storage — the closed lists live in
 * `@squad/shared` and a storage schema that repeated them would be a second
 * copy that drifts. It is narrowed on the way out, and `checkAgentTemplate`
 * is what refuses a mode the backend has never heard of on the way in.
 */
function templateOf(record: AgentTemplateRecord): AgentTemplate {
  return {
    templateId: record.templateId,
    displayName: record.displayName,
    role: record.role,
    systemPrompt: record.systemPrompt,
    backend: record.backend,
    connectionId: record.connectionId,
    permissionMode: record.permissionMode as AgentTemplate["permissionMode"],
    reasoningEffort: record.reasoningEffort,
    caps: record.caps,
    secretaryCandidate: record.secretaryCandidate,
    color: record.color,
    enabled: record.enabled,
  };
}

export class AgentTemplatesService extends Service {
  static readonly inject = ["storageDomain"];

  private domain: Domain<typeof SQUAD_AGENTS_DOMAIN> | undefined;

  constructor(ctx: Context) {
    super(ctx, "agentTemplates");
  }

  async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(SQUAD_AGENTS_DOMAIN);
    this.domain = domain;
    this.ctx.effect(() => async () => {
      this.domain = undefined;
      await domain.close();
    });
  }

  /** Live templates, oldest first. Soft-deleted ones are not here. */
  list(): readonly AgentTemplate[] {
    return [...this.table().entries()]
      .map(([, record]) => record)
      .filter((record) => record.enabled)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(templateOf);
  }

  /**
   * One template, live or not.
   *
   * Disabled ones are returned here on purpose: a team that names a
   * soft-deleted template still needs its name rendered, and that is the
   * whole reason the delete was soft.
   */
  get(templateId: string): AgentTemplate | undefined {
    const record = this.table().get(templateId);
    return record === undefined ? undefined : templateOf(record);
  }

  async save(template: AgentTemplate): Promise<void> {
    const problems = checkAgentTemplate(template);
    if (problems.length > 0) throw new Error(problems.map((problem) => problem.detail).join("\n"));
    const existing = this.table().get(template.templateId);
    await this.table().put(template.templateId, {
      ...template,
      createdAt: existing?.createdAt ?? Date.now(),
    });
  }

  /** Hide a template. The record stays so teams built from it stay explicable. */
  async remove(templateId: string): Promise<void> {
    const record = this.table().get(templateId);
    if (record === undefined) return;
    await this.table().put(templateId, { ...record, enabled: false });
  }

  private table() {
    if (this.domain === undefined) throw new Error("Agent 库尚未启动（storage domain 未打开）。");
    return this.domain.table("templates");
  }
}
