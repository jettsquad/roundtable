/**
 * block-domain.ts — where reusable prompt fragments are kept.
 *
 * A third domain in this plugin, for the same reason the second one is here:
 * it is a thing you configure once and then reference. A fragment outlives
 * the team that first needed it — 「产出前自查这五条」 is not a fact about
 * one roster — so it belongs beside the connections and the agents rather
 * than inside a team record.
 *
 * A team COPIES what it uses, exactly as it copies an agent template. Copying
 * is the decision that keeps a running team stable: an edit here cannot
 * change what a team already at work is being told, and a team that wants the
 * new wording asks for it. The cost is the one the agent library already
 * pays — a copy can drift — and it is paid the same way, by marking a copy
 * that differs rather than by pretending it cannot happen.
 */
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";

const promptBlockRecord = z.object({
  blockId: z.string(),
  /** Becomes a section heading in every prompt that carries it. */
  name: z.string(),
  text: z.string(),
  /** Soft delete, like a template: a fragment teams already copied stays explicable. */
  enabled: z.boolean(),
  order: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type PromptBlockRecord = z.infer<typeof promptBlockRecord>;

export const SQUAD_BLOCKS_DOMAIN = defineDomain({
  name: "squad_prompt_blocks",
  version: 1,
  tables: {
    /** blockId → the fragment. */
    blocks: domainTable<string, PromptBlockRecord>(promptBlockRecord),
  },
});
