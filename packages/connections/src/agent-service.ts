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
    voiceId: record.voiceId,
    webAccess: record.webAccess,
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

  /**
   * Live templates, in the order the library shows them.
   *
   * Arranged order wins; anything never arranged keeps falling back to when
   * it was made. The two never interleave badly because the first `move`
   * writes an order onto EVERY entry — before that they are all `undefined`,
   * after it they are all numbers.
   */
  list(): readonly AgentTemplate[] {
    return [...this.table().entries()]
      .map(([, record]) => record)
      .filter((record) => record.enabled)
      .sort(
        (a, b) =>
          (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt,
      )
      .map(templateOf);
  }

  /**
   * Move one template up or down the library.
   *
   * Rewrites the position of every live entry rather than swapping two. A
   * swap is cheaper and wrong here: the entries that have never been arranged
   * carry no position at all, so a swap between two of them changes nothing
   * anybody can see. Normalising to 0..n-1 on every move means the list is
   * always fully ordered afterwards, whatever it was before.
   */
  async move(templateId: string, delta: number): Promise<void> {
    const ordered = this.list();
    const at = ordered.findIndex((template) => template.templateId === templateId);
    if (at < 0) throw new Error(`Agent 库里没有这个模板：${templateId}。`);
    const to = at + delta;
    if (to < 0 || to >= ordered.length) return;
    const next = [...ordered];
    const [moved] = next.splice(at, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    for (const [index, template] of next.entries()) {
      const record = this.table().get(template.templateId);
      if (record === undefined || record.order === index) continue;
      await this.table().put(template.templateId, { ...record, order: index });
    }
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
      // Both are facts about the SHELF rather than the agent, and an edit
      // form does not carry them. Dropped, a saved agent would jump to the
      // end of a list somebody had arranged.
      createdAt: existing?.createdAt ?? Date.now(),
      ...((template.order ?? existing?.order) === undefined ? {} : { order: template.order ?? existing?.order }),
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
