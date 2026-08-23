/**
 * domain.ts — where teams are kept.
 *
 * They were not kept anywhere. A team lived in an in-memory Map, so every
 * restart threw away every team — while its WORKSPACE survived, because the
 * workspace registry is durable. The result was the worst possible shape:
 * the folder stays in the sidebar, the team tab says 「这个目录还没有团队」,
 * and the composer falls back to dsh's own. Nothing looked broken; the team
 * had simply evaporated.
 *
 * It went unnoticed for as long as it did because every check recreated its
 * team through the API first. Testing the code instead of the product hides
 * exactly this class of bug.
 *
 * The DISCUSSION was never the problem: it lives in the host node's session
 * log, which dsh persists. What was missing is the record that says a team
 * exists, which folder it works in, and who sits at it — enough to `resume`
 * the host node and put the roster back around it.
 */
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { AgendaSpecSchema } from "@squad/shared";
import { z } from "zod";

const capsRecord = z.object({
  maxTurns: z.number().optional(),
  maxCostUsd: z.number().optional(),
  maxTokens: z.number().optional(),
});

const seatRecord = z.object({
  seatId: z.string(),
  displayName: z.string(),
  role: z.string(),
  systemPrompt: z.string(),
  backend: z.enum(["claude-code", "codex", "dsh"]),
  isSecretary: z.boolean().optional(),
  connectionId: z.string().optional(),
  caps: capsRecord.optional(),
  permissionMode: z.string().optional(),
  templateId: z.string().optional(),
  color: z.string().optional(),
});

const teamRecord = z.object({
  teamId: z.string(),
  /**
   * The dsh session this record answers in.
   *
   * A team's folder is a workspace, and a workspace holds MANY sessions.
   * Without this field every session in the folder wrote into one record —
   * so opening a new session showed the old discussion, and anything typed
   * there landed in the old session. Absent on rows written before sittings
   * existed, where the record's own id was its session.
   */
  sessionId: z.string().optional(),
  /**
   * The team this is a sitting of, when it is one.
   *
   * A sitting has its own discussion, its own context and its own usage, and
   * shares the ROSTER with its base — the same people, starting again with no
   * memory of the other session. Absent on a base team.
   */
  baseTeamId: z.string().optional(),
  displayName: z.string(),
  projectFolder: z.string(),
  hostDisplayName: z.string(),
  checkpointCoefficient: z.number().optional(),
  seats: z.array(seatRecord),
  /**
   * What this team has spent, carried across restarts.
   *
   * Kept because it is the user's money. A total that resets to zero on
   * restart is not a total — it is a number that only ever says "cheap".
   */
  usage: z
    .object({
      turns: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheReadTokens: z.number(),
      cacheCreationTokens: z.number(),
      costUsd: z.number().optional(),
    })
    .optional(),
  /**
   * An agenda the secretary drafted, waiting on the host.
   *
   * Kept on disk, which reverses an earlier decision. The argument for memory
   * only was that a draft outliving a restart would be confirmed against a
   * discussion that had moved on — but a discussion does not move while the
   * process is down, so the risk it named cannot actually arise that way.
   * What did happen is the real cost: a decision waiting on a person vanished
   * without trace, and 「生成的议程草案我也看不到」 is what that looks like
   * from outside.
   *
   * `draftedAt` travels with it so a stale draft can SAY it is old rather
   * than being silently discarded on the host's behalf.
   */
  draft: AgendaSpecSchema.optional(),
  draftedAt: z.number().optional(),
  createdAt: z.number(),
});

export type TeamPersisted = z.infer<typeof teamRecord>;

export const SQUAD_TABLE_DOMAIN = defineDomain({
  name: "squad_table",
  version: 1,
  tables: {
    /** teamId → the team. */
    teams: domainTable<string, TeamPersisted>(teamRecord),
  },
});
