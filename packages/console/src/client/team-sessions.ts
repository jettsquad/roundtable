/**
 * team-sessions.ts — which sessions belong to a team, kept where a chain
 * selector can read it synchronously.
 *
 * The composer takeover hangs on one question asked at election time: is this
 * session a team's? `ChainSelect` is handed only the owner props — a
 * conversation snapshot with no workspace in it — and is documented as pure,
 * so the answer cannot be fetched there.
 *
 * So it is cached here instead: the set of folders that have a team, refreshed
 * by the same poll the panel already runs. The deviation from "pure" is a
 * synchronous read of this cache, and it is made safe by re-registering the
 * chain entry whenever the set actually changes — a re-registration
 * re-dispatches the chain, so an election can never be left stale by a team
 * appearing or being disbanded.
 */

let folders: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

/** The project folders that currently have a team. */
export function teamFolders(): ReadonlySet<string> {
  return folders;
}

/**
 * Replace the set, and announce only a real change.
 *
 * Compared rather than assigned blindly: the poll runs every two seconds and
 * re-registering the composer chain on each tick would tear the input down
 * mid-sentence.
 */
export function setTeamFolders(next: readonly string[]): void {
  const candidate = new Set(next);
  if (candidate.size === folders.size && [...candidate].every((path) => folders.has(path))) return;
  folders = candidate;
  for (const listener of listeners) listener();
}

/** Watch for a team appearing or being disbanded. */
export function watchTeamFolders(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The two shell services the panel needs to open a session, kept here for the
 * same reason the folder set is: the panel is rendered into a slot and never
 * receives `ctx`.
 *
 * Set once from `apply`. Absent in tests and in any composition that did not
 * mount them, which is why every caller checks.
 */
export interface ShellSessions {
  /** Reuse this workspace's blank session, or mint one. Returns its id. */
  connectWorkspace(workspaceId: string): Promise<string>;
  /** Navigate to a session. */
  open(sessionId: string): void;
  /** The workspace whose folder this is, if the shell knows one. */
  workspaceIdFor(folder: string): string | undefined;
}

let shell: ShellSessions | undefined;

export function setShellSessions(next: ShellSessions): void {
  shell = next;
}

export function shellSessions(): ShellSessions | undefined {
  return shell;
}
