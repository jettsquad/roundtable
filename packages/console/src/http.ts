/**
 * http.ts — how the browser half gets real data.
 *
 * A plain HTTP route, not a Typert Remote. The Remote path is the one DSH's
 * own UI uses, and it is closed to us: `/remote` artifacts are GENERATED at
 * build time from source types inside the harness repository, and the client
 * facade mounts only "the contributions selected by this application" — today
 * Goal and the plugin inventory. An out-of-repo package has no seat there.
 *
 * `ctx.webServer.register` is open by contract: any plugin adds a named
 * exact/prefix route and gets a disposer back. What we give up is what the
 * gateway would have given: shared types across the wire, tracing, and
 * cancellation. We own this contract instead, on both sides, and it is small
 * enough that owning it is cheaper than not having data at all.
 *
 * Read-only, deliberately. Every mutation stays on the slash commands, where
 * a person typed it — a route that could start a round would put the team's
 * behaviour behind an HTTP call with no human in it.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
// Imported for the `Context.webServer` declaration merging it carries; an
// augmentation applies only where its module is part of the compilation.
import type {} from "@deepseek-ai/dsh-host-webserver";

/** Where the browser half reads from. Prefix, so one registration serves several reads. */
export const SQUAD_API_PREFIX = "/api/squad";

/** One team, flattened for the wire. */
export interface TeamSummary {
  readonly teamId: string;
  readonly displayName: string;
  readonly projectFolder: string;
  readonly busy: boolean;
  readonly seats: readonly { readonly seatId: string; readonly displayName: string; readonly role: string }[];
  /** Lines of recorded discussion. */
  readonly recorded: number;
}

export interface SquadSnapshot {
  readonly teams: readonly TeamSummary[];
  /** Lil X: how many criteria are live, and how many wait on a human. */
  readonly criteria: { readonly active: number; readonly pending: number };
}

/** Build the snapshot the panel renders. Pure read; nothing here starts anything. */
export async function snapshotOf(ctx: Context): Promise<SquadSnapshot> {
  const teams: TeamSummary[] = [];
  for (const teamId of ctx.teams.list()) {
    const team = ctx.teams.get(teamId);
    if (team === undefined) continue;
    teams.push({
      teamId,
      displayName: team.displayName,
      projectFolder: team.projectFolder,
      busy: team.busy,
      seats: team.seats.map((seat) => ({
        seatId: seat.seatId,
        displayName: seat.displayName,
        role: seat.role,
      })),
      recorded: team.transcript().filter((entry) => entry.kind === "user/message" && entry.text !== "").length,
    });
  }
  const [active, pending] = await Promise.all([ctx.reasoning.criteria(), ctx.reasoning.pending()]);
  return { teams, criteria: { active: active.length, pending: pending.length } };
}

/**
 * Register the read route.
 *
 * A handler that throws must answer rather than hang: the webserver turns an
 * unhandled throw into a 400 and a warning, but the panel would show nothing
 * and say nothing. An explicit 500 with the message is what makes a broken
 * read debuggable from the browser.
 */
export function registerSquadApi(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: "prefix",
    path: SQUAD_API_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const snapshot = await snapshotOf(ctx);
        const body = JSON.stringify(snapshot);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          // The panel polls; a cached snapshot would look like a frozen team.
          "cache-control": "no-store",
        });
        res.end(body);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: detail }));
      }
    },
  });
}
