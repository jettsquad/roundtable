/**
 * land-on-team.ts — opening a team's session on the team, not on Chat.
 *
 * dsh picks the active conversation view per session, and the default is
 * hard-coded: `resolveActiveView` reads the session's stored `view` and falls
 * back to the id `chat`. There is no registration option for "be the default"
 * and no public setter, so a brand-new session in a team's workspace opens on
 * dsh's own chat — which in a team session is an empty page, because our
 * composer has replaced the input bar and nothing can be sent to that agent.
 * 「新建 session 看不到对话」 is exactly that.
 *
 * What the framework does expose is where the choice lives: the per-session
 * chat store persists to `localStorage` under `dsh.conversation.chat.<id>`.
 * Writing a preference there is the same act as the person clicking the tab
 * themselves — it is UI state, not data — so this seeds it for sessions that
 * belong to a team and have no preference of their own.
 *
 * It never OVERRIDES a choice. Someone who deliberately switched to Chat or
 * Trajectory in a team session has said what they want, and a plugin that
 * kept dragging them back would be worse than the problem it fixes.
 */

/** The view id our team tab registers under. */
export const TEAM_VIEW_ID = "squad-team";

const KEY_PREFIX = "dsh.conversation.chat.";

/** The shape dsh's chat store persists. Only `view` is ours to touch. */
interface ChatStoreShape {
  selection: unknown;
  draft: unknown;
  view: string | null;
  inspect: unknown;
}

/**
 * Make this session open on the team tab, unless it already has a preference.
 *
 * @returns whether anything was written — for tests, and so a caller can tell
 *   a fresh seed from a session that had already chosen.
 */
export function preferTeamView(sessionId: string): boolean {
  if (typeof localStorage === "undefined") return false;
  const key = KEY_PREFIX + sessionId;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      // The store rehydrates from this at creation, so a session we have not
      // met yet lands on the team tab the first time it is opened.
      localStorage.setItem(
        key,
        JSON.stringify({ selection: null, draft: "", view: TEAM_VIEW_ID, inspect: null } satisfies ChatStoreShape),
      );
      return true;
    }
    const stored = JSON.parse(raw) as Partial<ChatStoreShape>;
    // `null` means "never chose". Anything else — including "chat" — is a
    // decision, and decisions are left alone.
    if (stored.view != null) return false;
    localStorage.setItem(key, JSON.stringify({ ...stored, view: TEAM_VIEW_ID }));
    return true;
  } catch {
    // Quota, private mode, a corrupt entry: the tab simply opens where dsh
    // would have opened it. Not worth failing a session over.
    return false;
  }
}
