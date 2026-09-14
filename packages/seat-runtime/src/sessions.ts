/**
 * sessions.ts — which CLI conversation each seat is currently in.
 *
 * A side channel, and it exists because the seam has no room for this. A
 * provider's `start` receives a `SubagentStartRequest` whose fields are fixed
 * by dsh — label, prompt, parent, signal, tool filter, persona — and none of
 * them can carry "continue conversation X". Smuggling one through as an extra
 * property would depend on the request object surviving unchanged all the way
 * to the provider, which is not something the seam promises.
 *
 * So the table writes here and the backends read here, keyed by the two things
 * a provider CAN see: the parent session and the seat's label. That pair is
 * also exactly the isolation wanted — the same agent sitting in two teams, or
 * in two sittings of one team, is two conversations, and neither can be handed
 * the other's history.
 *
 * Module state and plain functions, following `activity.ts` next door: the
 * writer and the readers are in different packages that must not import each
 * other, and both already depend on this one.
 *
 * DELIBERATELY NOT PERSISTED. A restart loses the mapping, and the cost of
 * that is one un-resumed turn per seat before it rebuilds itself. Persisting
 * would mean holding ids for conversations the CLI may have cleaned up in the
 * meantime, and a stale id is worse than none: it fails at spawn time naming a
 * uuid nobody recognises.
 */

const ids = new Map<string, string>();

const keyOf = (parentSessionId: string, label: string): string => `${parentSessionId} ${label}`;

/** The conversation this seat is already in, if any. */
export function seatSessionId(parentSessionId: string, label: string | undefined): string | undefined {
  if (label === undefined || label === "") return undefined;
  return ids.get(keyOf(parentSessionId, label));
}

export function rememberSeatSession(parentSessionId: string, label: string | undefined, id: string): void {
  if (label === undefined || label === "" || id === "") return;
  ids.set(keyOf(parentSessionId, label), id);
}

/**
 * Drop one seat's conversation.
 *
 * Called when a resumed turn FAILED. An id the CLI no longer knows makes every
 * later turn fail the same way, and the error names a uuid the person has
 * never seen — so the recovery has to be automatic: forget it, and the next
 * turn opens a fresh conversation with the full window.
 */
export function forgetSeatSession(parentSessionId: string, label: string | undefined): void {
  if (label === undefined || label === "") return;
  ids.delete(keyOf(parentSessionId, label));
}

/**
 * Did this turn fail BECAUSE the conversation it was told to continue is gone?
 *
 * The test is that the failure names the id we passed. Every CLI phrases this
 * differently — `claude` says "No conversation found with session ID: <uuid>"
 * and exits 1 before it calls a model — but all of them have to say WHICH
 * conversation, and none of them mentions an id nobody supplied. So this
 * recognises the one failure a retry can actually cure, without a table of
 * per-CLI error strings that goes stale the next time one is reworded.
 *
 * Deliberately narrow. A seat that failed for any other reason must NOT be
 * run again: the commonest of those is a watchdog kill after a long silence,
 * and retrying that costs the silence a second time.
 */
export function resumeWasRejected(resumeSessionId: string | undefined, failureText: string): boolean {
  if (resumeSessionId === undefined || resumeSessionId === "") return false;
  return failureText.includes(resumeSessionId);
}

/**
 * Drop every seat's conversation under one parent.
 *
 * This is what a FOLD does. The secretary's checkpoint replaces the history
 * Squad hands out, but a CLI holding its own copy cannot be told to forget —
 * so the conversation itself is discarded and the next turn starts from the
 * checkpoint. It costs one un-resumed turn per seat, at the one moment where
 * the history was going to change out from under them anyway.
 */
export function forgetSeatSessions(parentSessionId: string): void {
  const prefix = `${parentSessionId} `;
  for (const key of [...ids.keys()]) {
    if (key.startsWith(prefix)) ids.delete(key);
  }
}

/** For tests, which must not inherit another case's conversations. */
export function resetSeatSessions(): void {
  ids.clear();
}
