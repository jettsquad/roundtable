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
 * What may cross this route, and what may not, is decided by WHO CAN REACH
 * IT — not by the verb. A slash command cannot be invoked by a model: the
 * registry never submits one, so a person typed it by construction. An HTTP
 * route on localhost is reachable by anything with a shell, including an
 * agent holding a Bash tool.
 *
 * So the line is:
 *
 *   CREATING and CONFIGURING — a team, its seats, later its connections —
 *   crosses. An agent that creates a team has not become the host.
 *
 *   The team's BEHAVIOUR — starting a round, stopping an agenda, folding —
 *   does not. Those stay on the commands. A route that could start a round
 *   would let a model decide who speaks, which is the one thing this product
 *   must not be, arriving by the back door after the front one was shut.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { UsageTotals } from "@squad/shared";
import { parseNewTeam } from "./parse.ts";
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
  /** What this team's seats have consumed, when any backend reported it. */
  readonly usage: UsageTotals;
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
      usage: team.usage,
    });
  }
  const [active, pending] = await Promise.all([ctx.reasoning.criteria(), ctx.reasoning.pending()]);
  return { teams, criteria: { active: active.length, pending: pending.length } };
}

/** What the panel posts to create a team. */
export interface CreateTeamRequest {
  readonly displayName: string;
  readonly projectFolder: string;
  /** Same one-line grammar the `/squad-new` command takes. */
  readonly roster: string;
}

/**
 * Create a team from the panel.
 *
 * Reuses the command's parser rather than validating again here. The rules it
 * enforces — absolute project folder, no duplicate seat names — were written
 * against a person typing, and a second copy would drift: the surface that
 * kept the weaker rules would be the one people found first.
 */
export async function createTeamFrom(ctx: Context, request: CreateTeamRequest): Promise<string> {
  const input = parseNewTeam(
    [request.displayName ?? "", request.projectFolder ?? "", request.roster ?? ""].join(" | "),
  );
  const team = await ctx.teams.create({
    displayName: input.displayName,
    projectFolder: input.projectFolder,
    hostDisplayName: "主持人",
    seats: input.seats.map((seat) => ({
      seatId: seat.seatId,
      displayName: seat.displayName,
      role: seat.role,
      systemPrompt: `你的角色是${seat.role}。回答简明，有依据。`,
      backend: "claude-code" as const,
    })),
  });
  return team.teamId;
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
        if (req.method === "POST") {
          const created = await createTeamFrom(ctx, await readJson(req));
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ teamId: created }));
          return;
        }
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

/**
 * Read a JSON request body.
 *
 * Bounded, because this route is reachable by anything on localhost and an
 * unbounded read is a way to take the host down with a single POST.
 */
async function readJson(req: IncomingMessage): Promise<CreateTeamRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("请求体过大。");
    chunks.push(chunk as Buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("请求体不是 JSON 对象。");
  return parsed as CreateTeamRequest;
}
