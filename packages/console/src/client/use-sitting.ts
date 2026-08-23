/**
 * use-sitting.ts — which record this dsh session works in.
 *
 * A team's folder is a workspace and a workspace holds many sessions. Asking
 * "which team is in this folder" was the old question, and it gave every
 * session in the folder the SAME record: opening a new session showed the old
 * discussion, and anything typed there landed in the old session.
 *
 * The question now is "which sitting is this session", answered once by the
 * server — which creates one on first sight — and cached here so the two
 * surfaces that ask (the composer and the team tab) do not each create their
 * own view of the answer, and so a re-render is not a request.
 */
import { useEffect, useState } from "react";
import { api } from "./api.ts";

/** sessionId → the record it works in. */
const known = new Map<string, string>();
/** In-flight lookups, so two surfaces mounting together ask once. */
const asking = new Map<string, Promise<string | undefined>>();

function resolve(projectFolder: string, sessionId: string): Promise<string | undefined> {
  const cached = known.get(sessionId);
  if (cached !== undefined) return Promise.resolve(cached);
  const running = asking.get(sessionId);
  if (running !== undefined) return running;
  const request = api
    .sitting({ projectFolder, sessionId })
    .then((answer) => {
      if (answer.teamId !== undefined) known.set(sessionId, answer.teamId);
      return answer.teamId;
    })
    .catch(() => undefined)
    .finally(() => {
      // Cleared either way: a failed lookup must be retryable, and leaving a
      // rejected promise in the map would make one network blip permanent for
      // the life of the tab.
      asking.delete(sessionId);
    });
  asking.set(sessionId, request);
  return request;
}

/**
 * The team record for this session, or nothing while it is being decided.
 *
 * `undefined` is not "no team" — it is "not yet". Callers show the same thing
 * they show while the snapshot loads.
 */
export function useSitting(projectFolder: string, sessionId: string | undefined): string | undefined {
  const [teamId, setTeamId] = useState<string | undefined>(() =>
    sessionId === undefined ? undefined : known.get(sessionId),
  );
  useEffect(() => {
    if (sessionId === undefined) return;
    let live = true;
    void resolve(projectFolder, sessionId).then((found) => {
      if (live) setTeamId(found);
    });
    return () => {
      live = false;
    };
  }, [projectFolder, sessionId]);
  return teamId;
}

/** For a session that was disbanded: ask again next time. */
export function forgetSitting(sessionId: string): void {
  known.delete(sessionId);
}

/**
 * Claim a session for its team without waiting for anything to be rendered.
 *
 * Resolving a sitting is also what makes the session REAL to dsh: the server
 * writes a turn boundary into it, and a session without one is blank —
 * hidden from the sidebar and reused by the next 新建会话. That is the whole
 * of 「新建的 session 还是会从列表里消失，再点新建又把刚才那个恢复出来」:
 * it was never claimed, so it stayed a blank waiting to be handed out again.
 *
 * Claiming used to happen when the team view or the composer mounted, which
 * is a race with the user — open a session and click away fast enough and it
 * is still blank. This runs off the workspace list instead, so a session is
 * claimed because it EXISTS in a team's workspace, not because someone looked
 * at it.
 */
export function claimSession(projectFolder: string, sessionId: string): void {
  if (known.has(sessionId) || asking.has(sessionId)) return;
  void resolve(projectFolder, sessionId);
}
