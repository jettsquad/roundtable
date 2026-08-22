/**
 * quotes.ts — which lines the host has pointed at.
 *
 * A module-level store for the same reason the panel's open/closed flag is
 * one: the 引用 button lives in the discussion and the tray lives in the
 * composer, and those two are rendered by different slots with no common
 * React ancestor. Passing the selection between them would mean threading it
 * through the slot boundary, which cannot be done.
 *
 * Keyed by TEAM, because two teams' sessions can be open at once and a quote
 * picked in one must not arrive in the other's next round.
 *
 * No React here on purpose: `react` is a platform module, resolvable in the
 * browser bundle and not under the test runner, so a store that imported it
 * could not be tested. The hook is a four-line wrapper in `use-quotes.ts`.
 */
const picked = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();
const EMPTY: readonly string[] = [];

function announce(): void {
  for (const listener of listeners) listener();
}

export function quotedIn(teamId: string): readonly string[] {
  return picked.get(teamId) ?? EMPTY;
}

/** Add or remove one line. Toggling is what the button does. */
export function toggleQuote(teamId: string, turnId: string): void {
  const current = quotedIn(teamId);
  const next = current.includes(turnId) ? current.filter((id) => id !== turnId) : [...current, turnId];
  picked.set(teamId, next);
  announce();
}

export function clearQuotes(teamId: string): void {
  if (quotedIn(teamId).length === 0) return;
  picked.set(teamId, EMPTY);
  announce();
}

/** Watch the selection. The hook that wraps this lives next door, in `use-quotes.ts`. */
export function watchQuotes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
