/**
 * api.ts — the browser's half of `/api/squad`.
 *
 * Types come from `wire.ts`, the module both halves import, so the panel and
 * the route cannot disagree about a field name without the build saying so.
 */
import { useEffect, useState } from "react";
import type { AgentCheckReport, AgentTemplate, SeatCaps, SeatConnection } from "@squad/shared";
import type { AgentRequest, DirectoryListing, NativePickResult, PickerKind, SquadSnapshot } from "../wire.ts";

export type { AgentCheckReport, AgentTemplate, DirectoryListing, PickerKind, SquadSnapshot };
export type TeamSummary = SquadSnapshot["teams"][number];
export type SeatSummary = TeamSummary["seats"][number];

const PREFIX = "/api/squad";

/**
 * Call the host, and surface its refusal verbatim.
 *
 * The host refuses with reasons — 「订阅模式不使用自定义端点」, 「只能有一位秘书」
 * — and those sentences are the entire value of the refusal. A generic
 * 「保存失败」 would throw away the only part that says what to do next.
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
  createTeam: (body: {
    displayName: string;
    projectFolder: string;
    members: readonly { templateId: string; isSecretary?: boolean }[];
  }): Promise<{ teamId: string }> => call("/teams", "POST", body),
  addSeat: (body: {
    teamId: string;
    templateId?: string;
    displayName?: string;
    role?: string;
    isSecretary?: boolean;
  }): Promise<unknown> => call("/seats", "POST", body),
  removeSeat: (body: { teamId: string; seatId: string; confirmSecretary?: boolean }): Promise<unknown> =>
    call("/seats", "DELETE", body),
  patchSeat: (body: { teamId: string; seatId: string; connectionId?: string; caps?: SeatCaps }): Promise<unknown> =>
    call("/seats", "PATCH", body),
  saveConnection: (body: SeatConnection & { credential?: string }): Promise<unknown> =>
    call("/connections", "POST", body),
  removeConnection: (body: { connectionId: string }): Promise<unknown> => call("/connections", "DELETE", body),
  saveAgent: (body: AgentRequest): Promise<unknown> => call("/agents", "POST", body),
  removeAgent: (body: { templateId: string }): Promise<unknown> => call("/agents", "DELETE", body),
  testAgent: (body: { templateId: string }): Promise<AgentCheckReport> => call("/agents/test", "POST", body),
  resolveCriterion: (body: { id: string; verdict: "accept" | "reject" }): Promise<unknown> =>
    call("/criteria", "POST", body),
  browse: (body: { path?: string }): Promise<DirectoryListing> => call("/browse", "POST", body),
  pickDirectory: (): Promise<NativePickResult> => call("/pick", "POST", {}),
  disbandTeam: (body: { teamId: string }): Promise<unknown> => call("/teams", "DELETE", body),
  renameTeam: (body: { teamId: string; displayName: string }): Promise<unknown> => call("/teams/rename", "POST", body),
  fold: (body: { teamId: string }): Promise<unknown> => call("/checkpoint", "POST", body),
  revokeCheckpoint: (body: { teamId: string; revokeId: string }): Promise<unknown> => call("/checkpoint", "POST", body),
  /**
   * Upload one document's bytes.
   *
   * The name and team ride in the query and the body is the file, untouched.
   * Base64 in a JSON envelope would cost a third more transfer and a full
   * re-encode at both ends for nothing.
   */
  addMaterial: async (teamId: string, name: string, bytes: ArrayBuffer): Promise<void> => {
    const url = `${PREFIX}/materials?teamId=${encodeURIComponent(teamId)}&name=${encodeURIComponent(name)}`;
    const response = await fetch(url, { method: "POST", body: bytes });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
      throw new Error(detail.error ?? "导入失败。");
    }
  },
  removeMaterial: (body: { teamId: string; materialId: string }): Promise<{ ok: true }> =>
    call("/materials", "DELETE", body),
  /** Carry on an agenda that was stopped, paused, or cut short by a restart. */
  resumeAgenda: (body: { teamId: string }): Promise<{ ok: true }> => call("/agenda/resume", "POST", body),
  /** Point a seat at an agent in the library and take its settings. */
  relinkSeat: (body: { teamId: string; seatId: string; templateId: string }): Promise<{ ok: true }> =>
    call("/seats/relink", "POST", body),
  pinMaterial: (body: { teamId: string; materialId: string; pinned: boolean }): Promise<{ ok: true }> =>
    call("/materials", "PATCH", body),
  /** Ask the secretary to do one job. The answer is a draft, not a turn. */
  assist: (body: { teamId: string; instruction: string }): Promise<{ text: string }> =>
    call("/secretary/assist", "POST", body),
  /** Re-express one of the secretary's own replies as a structured agenda. */
  agendaFromReply: (body: { teamId: string; turnId: string }): Promise<unknown> =>
    call("/agenda/from-reply", "POST", body),
  /** The record this session should use, created on first sight. */
  sitting: (body: { projectFolder: string; sessionId: string }): Promise<{ teamId?: string }> =>
    call("/sitting", "POST", body),
  say: (body: {
    teamId: string;
    instruction: string;
    seatIds?: readonly string[];
    quoteIds?: readonly string[];
    materialIds?: readonly string[];
  }): Promise<{ replies: readonly SeatReply[] }> => call("/say", "POST", body),
  stop: (body: { teamId: string; reason?: string }): Promise<unknown> => call("/stop", "POST", body),
  draftAgenda: (body: { teamId: string; command: string }): Promise<unknown> => call("/agenda/draft", "POST", body),
  resolveAgenda: (body: { teamId: string; verdict: "confirm" | "discard" }): Promise<unknown> =>
    call("/agenda", "POST", body),
};

export type Snapshot =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly detail: string }
  | { readonly state: "ready"; readonly data: SquadSnapshot };

/**
 * Poll the snapshot.
 *
 * Polling rather than a subscription because there is no event stream for
 * this yet, and a panel showing a stale roster after an edit is worse than
 * one costing a request every two seconds. `nonce` is how a mutation says
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

/**
 * Run a mutation, keeping its refusal for display.
 *
 * Every form in this panel needs the same three things — clear the old error,
 * re-read on success, keep the reason on failure — and each one having its
 * own copy is how one of them ends up swallowing the message.
 */
export function useAction(onChanged: () => void): {
  readonly error: string | undefined;
  readonly setError: (value: string | undefined) => void;
  readonly run: (work: () => Promise<unknown>) => Promise<boolean>;
} {
  const [error, setError] = useState<string | undefined>(undefined);
  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    setError(undefined);
    try {
      await work();
      onChanged();
      return true;
    } catch (failure) {
      setError(String((failure as Error).message ?? failure));
      return false;
    }
  };
  return { error, setError, run };
}

/** What one seat said in a round. */
export interface SeatReply {
  readonly seatId: string;
  readonly displayName: string;
  readonly text: string;
  readonly failed: boolean;
  /**
   * How many lines of discussion this seat was handed.
   *
   * Shown because "the window was empty" and "the seat ignored a full window"
   * produce the same answer and are different failures.
   */
  readonly contextLines: number;
}
