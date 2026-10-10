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
  /**
   * What the seat's own output says it has started and not finished.
   *
   * Absent for a backend whose stream is not read for it. Empty means the
   * stream WAS read and nothing is open — a seat waiting on its model.
   */
  readonly doing?: readonly OpenCommand[] | undefined;
  /** The last thing the seat said in words, when the stream carried any. */
  readonly lastWords?: string | undefined;
  /** What was decided the last time this seat went quiet with a command open. */
  readonly verdict?: QuietVerdict | undefined;
}

/**
 * One thing a seat started and has not been told the end of.
 *
 * Read off the seat's own output, never guessed: a CLI says when it starts a
 * command and says again when the command ends, so "is anything running" is a
 * fact in the stream rather than something to infer from how long it has been
 * quiet.
 */
export interface OpenCommand {
  readonly id: string;
  /** The tool's own name — `Bash`, `command_execution`. */
  readonly tool: string;
  /** What it was asked to do, as the seat wrote it. */
  readonly command: string;
  readonly startedAt: number;
  /** Handed off so the seat could carry on; the turn still waits for it. */
  readonly background: boolean;
  /** Where the command's own output is being written, when the CLI said. */
  readonly outputFile?: string | undefined;
}

/**
 * Whether a quiet command should be left alone or shown to the host.
 *
 * `wait` restarts the clock and says why; `ask` puts the command in front of
 * the person. Neither stops anything — stopping stays the host's.
 */
export interface QuietVerdict {
  readonly verdict: "wait" | "ask";
  readonly reason: string;
  readonly at: number;
  /** `system` when nobody could be asked, so the default was taken. */
  readonly by: "secretary" | "system";
}

/** A seat that has been quiet a full window while a command is still open. */
export interface QuietCommand {
  readonly key: string;
  readonly parentSessionId: string;
  readonly label: string;
  readonly activity: SeatActivity;
  readonly quietForMs: number;
}

export type QuietListener = (quiet: QuietCommand) => void;

const live = new Map<string, SeatActivity>();
const listeners = new Set<QuietListener>();

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
  // A verdict is about one stretch of silence. Output ends that stretch, and
  // a line still saying 「秘书：在跑测试，继续等」 over a seat that is talking
  // again would be describing something that is no longer happening.
  const { verdict: _ended, ...rest } = current;
  live.set(key, { ...rest, bytes, lastOutputAt: at });
}

/** Report what the seat's stream says is open, and what it last said. */
export function reportDoing(key: string, doing: readonly OpenCommand[], lastWords?: string): void {
  const current = live.get(key);
  if (current === undefined) return;
  live.set(key, { ...current, doing, ...(lastWords === undefined ? {} : { lastWords }) });
}

/**
 * Be told when a seat goes quiet with a command still open.
 *
 * A listener, because the judgement belongs to somebody this library cannot
 * import: the secretary is a plugin, and the backends that notice the silence
 * are three others.
 *
 * @returns a function that removes the listener.
 */
export function onQuietCommand(listener: QuietListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * A seat has been quiet for a whole window, and its stream says a command is
 * still running.
 *
 * With nobody listening the answer is `ask`: a command nobody judged is shown
 * to the host rather than assumed to be fine.
 */
export function raiseQuiet(
  key: string,
  who: { readonly parentSessionId: string; readonly label: string },
  quietForMs: number,
  at = Date.now(),
): void {
  const activity = live.get(key);
  if (activity === undefined) return;
  if (listeners.size === 0) {
    setQuietVerdict(key, { verdict: "ask", reason: "没有人能替你判断这条命令该不该等。", at, by: "system" });
    return;
  }
  for (const listener of listeners) {
    try {
      listener({ key, ...who, activity, quietForMs });
    } catch {
      // One listener failing must not cost the seat its verdict from another.
    }
  }
}

/** Record what was decided about a quiet command. Ignored once the seat has settled. */
export function setQuietVerdict(key: string, verdict: QuietVerdict): void {
  const current = live.get(key);
  if (current === undefined) return;
  live.set(key, { ...current, verdict });
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
  listeners.clear();
}
