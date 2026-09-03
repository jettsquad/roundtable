/**
 * agent-domain.ts — where reusable agents are kept.
 *
 * Its own domain alongside `squad_connections`, and in the same plugin,
 * because the two are one concern: the things you configure once and then
 * reference. A template names a connection, so they version together — split
 * across two plugins they would be two packages that always change in the
 * same commit, with a wall between them that only makes the change harder.
 */
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";

const capsRecord = z.object({
  maxTurns: z.number().optional(),
  maxCostUsd: z.number().optional(),
  maxTokens: z.number().optional(),
});

const agentTemplateRecord = z.object({
  templateId: z.string(),
  displayName: z.string(),
  role: z.string(),
  systemPrompt: z.string(),
  backend: z.enum(["claude-code", "codex", "dsh"]),
  connectionId: z.string().optional(),
  permissionMode: z.string().optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  caps: capsRecord.optional(),
  secretaryCandidate: z.boolean(),
  color: z.string(),
  /** MiniMax voice id for reading this agent's replies aloud. */
  voiceId: z.string().optional(),
  /** Pre-approve the web tools for this agent. Claude Code only. */
  webAccess: z.boolean().optional(),
  /** Soft delete: a disabled template is hidden, not gone. */
  enabled: z.boolean(),
  /**
   * Where this sits in the library, when somebody has said.
   *
   * Absent on every row written before ordering existed, and absent is not
   * zero: a library that has never been reordered falls back to creation
   * order, which is what it always showed. The first move assigns one to
   * every entry, so the two schemes never have to be mixed.
   */
  order: z.number().optional(),
  createdAt: z.number(),
});

export type AgentTemplateRecord = z.infer<typeof agentTemplateRecord>;

export const SQUAD_AGENTS_DOMAIN = defineDomain({
  name: "squad_agent_templates",
  version: 1,
  tables: {
    /** templateId → the template. */
    templates: domainTable<string, AgentTemplateRecord>(agentTemplateRecord),
  },
});
