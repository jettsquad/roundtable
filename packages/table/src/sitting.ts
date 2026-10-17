/**
 * sitting.ts — which record serves which session.
 *
 * A team's folder is a workspace, and a workspace holds many sessions. For a
 * while every session in the folder resolved to the same record, so opening a
 * new session showed the old discussion and anything typed in it landed in
 * the old session. A sitting is the fix: one record per session, sharing the
 * team's roster and folder, owning its own discussion, context and usage.
 *
 * The three decisions that follow are pure so they can be tested without a
 * context, a storage domain or an agent runtime — the service around them
 * needs all three, which is exactly why the rules kept living where nothing
 * could check them.
 */

/** The little that these rules need to know about a record. */
export interface SittingLike {
  readonly teamId: string;
  /**
   * Absent on rows written before sittings existed, where the record's own id
   * was its session. Accepted rather than required so `restoreOrder` can be
   * handed a saved row directly — the shape on disk is the shape with the
   * gaps in it.
   */
  readonly sessionId?: string | undefined;
  readonly baseTeamId?: string | undefined;
  readonly disposed?: boolean;
}

/** A record plus the folder it works in. */
export interface FolderLike extends SittingLike {
  readonly projectFolder: string;
}

/**
 * The record that serves one dsh session, if one already does.
 *
 * By session id and nothing else. Matching on folder is what produced the
 * bug: two sessions in one workspace both matched, and the first won.
 *
 * When SEVERAL records claim the same session, the one with the most in it
 * wins, and the first only breaks a tie. Duplicates exist on disk: three
 * concurrent first visits each passed the "is there one yet?" check before any
 * of them registered, and made a sitting apiece. Taking the first match then
 * meant whichever came first in the file was shown — an empty one, with the
 * real discussion sitting unseen in its twin. Weighing is what lets those
 * already-written duplicates resolve to the discussion without editing data.
 */
export function recordForSession<T extends SittingLike>(
  records: readonly T[],
  sessionId: string,
  weigh: (record: T) => number = () => 0,
): T | undefined {
  // Falling back to the id keeps a pre-sittings record matching its own
  // original session, which is what it always served.
  let best: T | undefined;
  let bestWeight = -1;
  for (const record of records) {
    if (record.disposed === true || (record.sessionId ?? record.teamId) !== sessionId) continue;
    const weight = weigh(record);
    if (weight > bestWeight) {
      best = record;
      bestWeight = weight;
    }
  }
  return best;
}

/**
 * The teams that work in a folder — bases only, never a sitting.
 *
 * A sitting of a sitting would be a tree nobody asked for, and the roster
 * would then live at an arbitrary depth in it. More than one is possible: the
 * folder is a workspace, and nothing used to stop two teams being made on it.
 */
export function basesForFolder<T extends FolderLike>(records: readonly T[], projectFolder: string): readonly T[] {
  return records.filter(
    (record) => record.disposed !== true && record.baseTeamId === undefined && record.projectFolder === projectFolder,
  );
}

/** Which team a session belongs to, or why that cannot be said. */
export type BaseResolution<T> =
  | { readonly kind: "found"; readonly base: T }
  /** Nobody works in this folder. */
  | { readonly kind: "none" }
  /** The caller named a team that is not here, or is in another folder. */
  | { readonly kind: "missing"; readonly teamId: string }
  /** Several teams share the folder and nothing says which one this is. */
  | { readonly kind: "ambiguous"; readonly candidates: readonly T[] };

/**
 * The team a session belongs to.
 *
 * By TEAM ID when the caller knows it — a session opened from a team's own
 * card — because a team is not a folder. Matching on the folder alone gave
 * every team in a shared folder the roster of the OLDEST one: a team made
 * later, under any name, showed the members of the first.
 *
 * By folder only when nobody said which team. One team in the folder is then
 * unambiguous. With several, a team that has never been opened is adopted by
 * the first session to arrive, exactly as a lone team is (see `unclaimed`);
 * otherwise the answer is "ambiguous", not the first of them.
 */
export function resolveBase<T extends FolderLike>(
  records: readonly T[],
  input: { readonly projectFolder: string; readonly teamId?: string | undefined },
): BaseResolution<T> {
  if (input.teamId !== undefined) {
    const named = records.find((record) => record.teamId === input.teamId && record.disposed !== true);
    const base = named?.baseTeamId === undefined ? named : records.find((record) => record.teamId === named.baseTeamId);
    if (base === undefined || base.disposed === true || base.projectFolder !== input.projectFolder) {
      return { kind: "missing", teamId: input.teamId };
    }
    return { kind: "found", base };
  }
  const bases = basesForFolder(records, input.projectFolder);
  const [only] = bases;
  if (only === undefined) return { kind: "none" };
  if (bases.length === 1) return { kind: "found", base: only };
  const fresh = bases.filter(unclaimed);
  const [adopted] = fresh;
  if (adopted !== undefined && fresh.length === 1) return { kind: "found", base: adopted };
  return { kind: "ambiguous", candidates: bases };
}

/**
 * Saved rows in the order they can be restored.
 *
 * Bases first: a sitting takes its base's live roster and name objects by
 * reference, so restoring one before its base has nothing to point at. Disk
 * order is insertion order, which says nothing about which is which.
 *
 * Stable within each group, so two teams restore in the order they were made.
 */
export function restoreOrder<T extends SittingLike>(rows: readonly T[]): readonly T[] {
  return [...rows.filter((row) => row.baseTeamId === undefined), ...rows.filter((row) => row.baseTeamId !== undefined)];
}

/**
 * Whether this team has never been opened in a real session.
 *
 * A team is created before anyone sits down at it, and its record borrows its
 * own id as a session id because there is no session yet. The FIRST session
 * to arrive in the workspace is that team's first sitting — it should adopt
 * the record rather than start a second, empty one beside it.
 *
 * Without this rule the team's own discussion becomes unreachable from the
 * workspace: every session, including the one someone had been working in all
 * along, gets a fresh sitting, and the history is still there but nowhere a
 * person would look. It is the same record, so nothing is lost — which is
 * exactly why losing sight of it would be so hard to diagnose.
 */
export function unclaimed(record: SittingLike): boolean {
  return record.baseTeamId === undefined && (record.sessionId ?? record.teamId) === record.teamId;
}

/**
 * The id for a team's next host node, when its current one cannot be opened.
 *
 * Keeps the team id as its prefix: Squad tells its own host nodes from a
 * person's sessions by the `team-` / `sit-` they start with, and a host node
 * mistaken for a person's session would be marked and shown in the sidebar.
 * Numbered, so a second replacement does not collide with the first.
 */
export function nextHostId(teamId: string, currentHostId: string): string {
  const generation = /-h(\d+)$/.exec(currentHostId.slice(teamId.length))?.[1];
  return `${teamId}-h${generation === undefined ? 2 : Number(generation) + 1}`;
}
