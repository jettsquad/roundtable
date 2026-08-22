/**
 * activity.ts — what a running seat is doing RIGHT NOW.
 *
 * The seam gives no progress channel: `SubagentRun` has `result`, `dispose`
 * and nothing in between, so from the table's side a seat is a promise that
 * has not settled. That is why a running team showed no state at all — a seat
 * thinking hard and a seat wedged on an endpoint that will never answer are
 * the same unsettled promise.
 *
 * The backends, though, are OURS, and the silence watchdog already reads the
 * child's byte count on every tick. So the same tick reports it here, and the
 * table reads it when it builds a summary.
 *
 * A module-level map rather than a service, deliberately: the three backends
 * and the table are separate PLUGINS, and a service between them would make
 * the table wait for a backend to mount before it could start. A library that
 * all four import is one module instance in one process, with no ordering to
 * get wrong. What it costs is that the registry is process-wide — hence the
 * key, and hence `endActivity` in a `finally`, because a map nobody clears is
 * a map that reports a seat as working forever.
 */

/** How one seat's run is going. All times are Unix epoch milliseconds. */
export interface SeatActivity {
  /** When the child was spawned. */
  readonly startedAt: number;
  /** Bytes of stdout seen so far. Zero means it has not said a word yet. */
  readonly bytes: number;
  /** When the byte count last changed — the clock the watchdog measures. */
  readonly lastOutputAt: number;
}

const live = new Map<string, SeatActivity>();

/**
 * The address of one running seat.
 *
 * Session id AND label: the label alone is a display name, which is unique
 * within a team's roster but not across two teams working at once.
 */
export function activityKey(parentSessionId: string, label: string): string {
  return `${parentSessionId} ${label}`;
}

/** A seat has started. Resets any stale entry left by a previous round. */
export function beginActivity(key: string, at = Date.now()): void {
  live.set(key, { startedAt: at, bytes: 0, lastOutputAt: at });
}

/**
 * Report the byte count. Only a CHANGE moves the clock — that is the whole
 * definition of silence, and reporting an unchanged count as fresh output
 * would make the watchdog's judgement and this display disagree.
 */
export function reportActivity(key: string, bytes: number, at = Date.now()): void {
  const current = live.get(key);
  if (current === undefined) return;
  if (bytes <= current.bytes) return;
  live.set(key, { startedAt: current.startedAt, bytes, lastOutputAt: at });
}

/** The seat has settled, one way or another. */
export function endActivity(key: string): void {
  live.delete(key);
}

/** What this seat is doing, or nothing when it is not running. */
export function activityFor(key: string): SeatActivity | undefined {
  return live.get(key);
}

/** For tests: forget everything. Never called in production. */
export function resetActivity(): void {
  live.clear();
}
