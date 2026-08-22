/**
 * use-quotes.ts — the React face of the quote store.
 *
 * Separate from `quotes.ts` because `react` is a platform module: resolvable
 * in the browser bundle, absent under the test runner. Keeping the store
 * React-free is what lets its behaviour be tested at all.
 */
import { useSyncExternalStore } from "react";
import { quotedIn, watchQuotes } from "./quotes.ts";

/** The current selection for one team. */
export function useQuotes(teamId: string): readonly string[] {
  return useSyncExternalStore(
    watchQuotes,
    () => quotedIn(teamId),
    () => quotedIn(teamId),
  );
}
