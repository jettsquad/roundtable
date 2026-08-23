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
 */
export function recordForSession<T extends SittingLike>(records: readonly T[], sessionId: string): T | undefined {
  // Falling back to the id keeps a pre-sittings record matching its own
  // original session, which is what it always served.
  return records.find((record) => record.disposed !== true && (record.sessionId ?? record.teamId) === sessionId);
}

/**
 * The team that owns a folder — a base, never a sitting.
 *
 * A sitting of a sitting would be a tree nobody asked for, and the roster
 * would then live at an arbitrary depth in it.
 */
export function baseForFolder<T extends FolderLike>(records: readonly T[], projectFolder: string): T | undefined {
  return records.find(
    (record) => record.disposed !== true && record.baseTeamId === undefined && record.projectFolder === projectFolder,
  );
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
