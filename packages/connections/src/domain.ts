/**
 * domain.ts — where connections are kept.
 *
 * Their own domain, not the team's: a connection is user-level. The same
 * gateway serves every team, and storing a copy per team would mean rotating
 * an endpoint touches each of them — with the one that was missed failing
 * weeks later for a reason nobody connects to the edit.
 *
 * The SECRET is not here. Only `credentialRef`, a name. The value lives with
 * `ctx.credentials` and is resolved per operation, which is what makes a
 * rotated key reach the very next turn and keeps this file safe to read,
 * sync, and render in a settings screen.
 */
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";

const connectionRecord = z.object({
  connectionId: z.string(),
  displayName: z.string(),
  authMode: z.enum(["subscription", "api-key"]),
  backend: z.enum(["claude-code", "codex", "dsh"]),
  modelId: z.string().optional(),
  endpoint: z.string().optional(),
  /** A NAME. Never a value. */
  credentialRef: z.string().optional(),
  createdAt: z.number(),
});

export type ConnectionRecord = z.infer<typeof connectionRecord>;

export const SQUAD_CONNECTIONS_DOMAIN = defineDomain({
  name: "squad_connections",
  version: 1,
  tables: {
    /** connectionId → the connection. */
    connections: domainTable<string, ConnectionRecord>(connectionRecord),
  },
});
