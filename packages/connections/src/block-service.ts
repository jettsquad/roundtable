/**
 * block-service.ts — `ctx.promptBlocks`: the reusable prompt fragments.
 *
 * The middle tier of a seat's prompt, kept where it can outlive one team.
 * See `block-domain.ts` for why a team copies rather than references, and
 * `@squad/shared`'s `prompt-blocks.ts` for what a copy is then used for.
 *
 * Removal is a soft delete, for the reason the agent library learned: a team
 * already carrying a copy is not broken by a hard delete — what breaks is the
 * only screen that could say where that paragraph came from.
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import type { Domain } from "@deepseek-ai/dsh-storage-domain";
import type { PromptBlock } from "@squad/shared";
import { SQUAD_BLOCKS_DOMAIN, type PromptBlockRecord } from "./block-domain.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    promptBlocks: PromptBlocksService;
  }
}

/** A library entry, with the bookkeeping the rest of the system does not need. */
export interface LibraryBlock extends PromptBlock {
  readonly updatedAt: number;
}

const blockOf = (record: PromptBlockRecord): LibraryBlock => ({
  blockId: record.blockId,
  name: record.name,
  text: record.text,
  updatedAt: record.updatedAt,
});

export class PromptBlocksService extends Service {
  static readonly inject = ["storageDomain"];

  private domain: Domain<typeof SQUAD_BLOCKS_DOMAIN> | undefined;

  constructor(ctx: Context) {
    super(ctx, "promptBlocks");
  }

  async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(SQUAD_BLOCKS_DOMAIN);
    this.domain = domain;
    this.ctx.effect(() => async () => {
      this.domain = undefined;
      await domain.close();
    });
  }

  /** Live fragments, in library order. */
  list(): readonly LibraryBlock[] {
    return [...this.table().entries()]
      .map(([, record]) => record)
      .filter((record) => record.enabled)
      .sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt))
      .map(blockOf);
  }

  /**
   * One fragment, live or not.
   *
   * Disabled ones come back on purpose: a team holding a copy still needs its
   * name rendered, and that is the whole reason the delete was soft.
   */
  get(blockId: string): LibraryBlock | undefined {
    const record = this.table().get(blockId);
    return record === undefined ? undefined : blockOf(record);
  }

  async save(block: PromptBlock): Promise<void> {
    if (block.name.trim() === "") throw new Error("片段要有名字——它会成为提示词里的小标题。");
    if (block.text.trim() === "") throw new Error("片段正文是空的，挂给谁都不会有效果。");
    const existing = this.table().get(block.blockId);
    await this.table().put(block.blockId, {
      blockId: block.blockId,
      name: block.name.trim(),
      text: block.text,
      enabled: true,
      ...(existing?.order === undefined ? {} : { order: existing.order }),
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
  }

  /** Hide one. Teams that copied it keep working and keep saying where it came from. */
  async remove(blockId: string): Promise<void> {
    const record = this.table().get(blockId);
    if (record === undefined) return;
    await this.table().put(blockId, { ...record, enabled: false, updatedAt: Date.now() });
  }

  /** Rewrite the library order in one go, so a drag cannot half-apply. */
  async reorder(blockIds: readonly string[]): Promise<void> {
    for (const [index, blockId] of blockIds.entries()) {
      const record = this.table().get(blockId);
      if (record === undefined) continue;
      await this.table().put(blockId, { ...record, order: index });
    }
  }

  private table() {
    if (this.domain === undefined) throw new Error("片段库尚未启动（storage domain 未打开）。");
    return this.domain.table("blocks");
  }
}
