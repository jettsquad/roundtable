/**
 * domain.ts — where Squad's own team-level records live.
 *
 * NOT the host session log. dsh's persistence read path refuses any event type
 * outside `KNOWN_SESSION_EVENT_TYPES` that is not marked `ignorable`, and
 * out-of-repo plugin events are outside it by construction — the registration
 * surface for them is deferred until such a consumer exists, and we are that
 * consumer. Writing `squad/checkpoint` into the log makes the whole team
 * record unreadable on reload; marking it `ignorable` makes the checkpoint
 * vanish on reload, which is 1.x's silent-drop bug reincarnated one layer
 * down. So the log keeps dsh's own vocabulary and this holds the rest.
 *
 * See the technical design §5 for the decision and its cost.
 */
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";

/**
 * One folded stretch of discussion.
 *
 * `coversUpTo` is the identity of the last turn the checkpoint actually
 * summarised, and the window is cut there rather than at the checkpoint's own
 * position: the secretary writes without stopping the team, so turns keep
 * landing while it works and are recorded before it finishes. Cutting at its
 * position would drop turns it never covered, with nothing standing in for
 * them.
 *
 * Revocation is a field, not a deletion. The host can retire a checkpoint they
 * were not happy with, and the window falls back to the previous one (or to
 * the whole discussion) — but the text stays readable, because a record that
 * can be deleted is a record that can be lost silently.
 */
const checkpointRecord = z.object({
  teamId: z.string(),
  checkpointId: z.string(),
  /** The checkpoint body, as the secretary wrote it. */
  text: z.string(),
  /** Identity of the last turn this checkpoint summarised. */
  coversUpTo: z.string(),
  createdAt: z.number(),
  /** Set when the host retires it; the row is never removed. */
  revokedAt: z.number().optional(),
});

export type CheckpointRecord = z.infer<typeof checkpointRecord>;

/**
 * One file this team actually wrote.
 *
 * Recorded because the checkpoint's 「产出索引」 may only list paths the
 * program really produced. Given nothing, the secretary has only the
 * transcript to go on and will invent plausible paths — and an invented path
 * is worse than no index at all, because a later agent follows it and finds
 * nothing.
 *
 * Durable rather than in-memory for the same reason: a fold after a restart
 * would otherwise write an index that says 「无」 while the files sit on disk.
 */
const artifactRecord = z.object({
  teamId: z.string(),
  /** Project-relative, as the table resolved and wrote it. */
  path: z.string(),
  writtenAt: z.number(),
});

export type ArtifactRecord = z.infer<typeof artifactRecord>;

/**
 * The domain name is `squad_teams`, not `squad.teams` as the technical design
 * first wrote it: a domain name doubles as the backend unit name and must
 * match `UNIT_NAME_RE` (`^[a-z][a-z0-9_]*$`), which a dot fails. Caught at
 * module load rather than at first write, because `defineDomain` validates
 * eagerly.
 */
export const SQUAD_TEAMS_DOMAIN = defineDomain({
  name: "squad_teams",
  // 2: gained the `artifacts` table. A medium stamped with another version is
  // rejected at open rather than read loosely, so a stale dev store fails
  // loudly instead of serving a half-shape.
  version: 2,
  tables: {
    /** checkpointId → the folded stretch it stands for. */
    checkpoints: domainTable<string, CheckpointRecord>(checkpointRecord),
    /** `teamId:path` → one file the team wrote. */
    artifacts: domainTable<string, ArtifactRecord>(artifactRecord),
  },
});
