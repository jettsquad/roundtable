/**
 * home.ts — where a seat backend may keep state that must outlive one turn.
 *
 * Almost nothing qualifies. A seat is a process that remembers nothing, and
 * the state it leaves behind is state the next turn can be surprised by. The
 * exception is what a CLI keeps for its OWN continuity: a conversation the
 * next turn means to resume has to still be there when that turn starts, and
 * a CLI stores its conversations under its configuration home.
 *
 * Under the harness home rather than the OS temp directory, because those two
 * differ in exactly the property this needs: `$TMPDIR` is swept by the system
 * on a schedule nobody here controls, and the harness home is the place this
 * installation already keeps its sessions, storage and credentials.
 *
 * `$DSH_HOME` is read the way dsh reads it — blank counts as unset, `~` is
 * expanded — so a Squad running against a test home puts its seat state there
 * too instead of writing into the real one.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DSH_HOME_ENV = "DSH_HOME";

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/** The harness home this Squad is running against. */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[DSH_HOME_ENV];
  const selected = configured !== undefined && configured.trim() !== "" ? configured.trim() : join(homedir(), ".dsh");
  return resolve(expandHome(selected));
}

/**
 * A directory for seat state that has to survive between turns.
 *
 * Namespaced under `squad-seat-state` so everything of this kind sits in one
 * place a person can delete wholesale — which is the recovery for any CLI
 * whose own store has gone bad, and which must not take the harness's
 * sessions with it.
 */
export function seatStateDir(...segments: string[]): string {
  return join(dshHome(), "squad-seat-state", ...segments);
}
