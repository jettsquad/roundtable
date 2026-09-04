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
  webAccess: z.boolean().optional(),
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
  /**
   * Background material the host imported, extracted to plain text.
   *
   * Stored with the team because it is part of what the team knows — a folder
   * of files beside the record would drift from it, and a restart would leave
   * seats reading a document the panel no longer lists.
   */
  materials: z
    .array(
      z.object({
        materialId: z.string(),
        name: z.string(),
        text: z.string(),
        addedAt: z.number(),
        /** Carried into every round without being attached. Off by default. */
        pinned: z.boolean().optional(),
      }),
    )
    .optional(),
  /**
   * The agenda the host confirmed, and how far it got.
   *
   * 1.x wrote the whole IR into `events.log` as `teamAgendaConfirmed` and
   * replayed it on start, so a crash mid-agenda left the plan intact and the
   * team idle. 2.0 held it only in memory: a restart lost the plan, lost
   * which phase it was in, and left a record full of instructions with
   * nothing saying what they had been part of.
   *
   * Cleared when the agenda finishes. While it stands, a restart can offer to
   * carry on from `completedPhases.length` — never automatically, which is
   * 1.x's rule and the right one: work that resumes without being asked is
   * work nobody decided to do.
   */
  confirmed: AgendaSpecSchema.optional(),
  confirmedAt: z.number().optional(),
  /** Phase titles that finished, in order. Where a resume starts from. */
  confirmedDone: z.array(z.string()).optional(),
  /**
   * sha256 of the canonical confirmed agenda.
   *
   * So 「跑的是不是我确认的那份」 stays answerable after everyone has
   * forgotten. Not a security boundary — the host may edit freely — an audit
   * fact.
   */
  confirmedHash: z.string().optional(),
  /**
   * Who was at the table when it was confirmed.
   *
   * 1.x carried `scope.participantSnapshot` for this. Execution reads the
   * CURRENT roster, which is right — a member added mid-agenda should be
   * usable — but then 「你确认时的那队人」 and 「实际跑的那队人」 can differ
   * with nothing saying so. This is the thing that says so.
   */
  confirmedRoster: z.array(z.object({ seatId: z.string(), displayName: z.string(), role: z.string() })).optional(),
  /** Stable across edits and re-drafts; what a confirmation names. */
  draftAgendaId: z.string().optional(),
  /** Bumped whenever a new draft replaces the standing one. */
  draftRevision: z.number().optional(),
  /** The team's audit log, oldest first, bounded. */
  audit: z
    .array(
      z.object({
        at: z.number(),
        kind: z.string(),
        detail: z.string(),
        agendaHash: z.string().optional(),
      }),
    )
    .optional(),
  draft: AgendaSpecSchema.optional(),
  draftedAt: z.number().optional(),
  /** The secretary turn this draft was converted from, when it came from one. */
  draftFromTurnId: z.string().optional(),
  /**
   * What the host has ticked for the NEXT message: quoted lines, attached
   * documents.
   *
   * On the record rather than in the browser, and that is the whole point.
   * Both lived in client memory — quotes in a module store, attachments in a
   * component's `useState` — so a refresh silently discarded work: you pick
   * four documents, reload for any reason, and the next question goes out
   * carrying none of them while the chips look the same as ever.
   *
   * It belongs to the SITTING, not to the window: two tabs open on one
   * discussion are looking at one table, and a document ticked in either is
   * ticked. Cleared when the message it belongs to is sent.
   *
   * Optional, and old rows without it parse unchanged — which is why the
   * domain version does not move. A version bump is a refusal to open data
   * written by the previous one.
   */
  selection: z
    .object({
      quoteIds: z.array(z.string()).optional(),
      materialIds: z.array(z.string()).optional(),
    })
    .optional(),
  /**
   * Where this team sits in the list, when somebody has said.
   *
   * Absent means 「从没排过」, and that is not the same as first: a list that
   * has never been arranged falls back to the order teams were made in, which
   * is what it always showed. The first move writes one onto every team.
   */
  order: z.number().optional(),
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
