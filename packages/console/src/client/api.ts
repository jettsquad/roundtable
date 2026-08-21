/**
 * api.ts — the browser's half of `/api/squad`.
 *
 * The snapshot type is imported from the route that produces it, type-only,
 * so the two halves cannot disagree about a field name without the build
 * saying so. Type imports are erased, so this crosses no runtime edge.
 */
import { useEffect, useState } from "react";
import type { SeatCaps, SeatConnection } from "@squad/shared";
import type { SquadSnapshot } from "../wire.ts";

export type { SquadSnapshot };
export type TeamSummary = SquadSnapshot["teams"][number];
export type SeatSummary = TeamSummary["seats"][number];

const PREFIX = "/api/squad";

/**
 * Call the host, and surface its refusal verbatim.
 *
 * The host refuses with reasons — 「订阅模式不使用自定义端点」, 「只能有一位秘书」
 * — and those sentences are the entire value of the refusal. A generic
 * "保存失败" would throw away the only part that tells the person what to do.
 */
async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(PREFIX + path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const detail = typeof data === "object" && data !== null && "error" in data ? String(data.error) : undefined;
    throw new Error(detail ?? `HTTP ${response.status}`);
  }
  return data as T;
}

export const api = {
  snapshot: (): Promise<SquadSnapshot> => call<SquadSnapshot>("/teams", "GET"),
  createTeam: (body: { displayName: string; projectFolder: string; roster: string }): Promise<{ teamId: string }> =>
    call("/teams", "POST", body),
  addSeat: (body: { teamId: string; displayName: string; role: string; isSecretary?: boolean }): Promise<unknown> =>
    call("/seats", "POST", body),
  removeSeat: (body: { teamId: string; seatId: string; confirmSecretary?: boolean }): Promise<unknown> =>
    call("/seats", "DELETE", body),
  patchSeat: (body: { teamId: string; seatId: string; connectionId?: string; caps?: SeatCaps }): Promise<unknown> =>
    call("/seats", "PATCH", body),
  saveConnection: (body: SeatConnection & { credential?: string }): Promise<unknown> =>
    call("/connections", "POST", body),
  removeConnection: (body: { connectionId: string }): Promise<unknown> => call("/connections", "DELETE", body),
};

export type Snapshot =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly detail: string }
  | { readonly state: "ready"; readonly data: SquadSnapshot };

/**
 * Poll the snapshot.
 *
 * Polling rather than a subscription because there is no event stream for
 * this yet, and a panel that shows a stale roster after an edit is worse than
 * one that costs a request every two seconds. `nonce` is how a mutation says
 * "read again now" instead of waiting out the interval.
 */
export function useSnapshot(nonce: number): Snapshot {
  const [snapshot, setSnapshot] = useState<Snapshot>({ state: "loading" });
  useEffect(() => {
    let live = true;
    const read = async (): Promise<void> => {
      try {
        const data = await api.snapshot();
        if (live) setSnapshot({ state: "ready", data });
      } catch (failure) {
        if (live) setSnapshot({ state: "error", detail: String((failure as Error).message ?? failure) });
      }
    };
    void read();
    const timer = setInterval(() => void read(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [nonce]);
  return snapshot;
}
