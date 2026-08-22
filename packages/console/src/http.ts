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
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";

import type {
  AgentRequest,
  ConnectionRequest,
  DirectoryListing,
  CreateTeamRequest,
  SeatPatch,
  SeatRequest,
  SquadSnapshot,
  TeamSummary,
} from "./wire.ts";
import { parseNewTeam } from "./parse.ts";
// Imported for the `Context.webServer` declaration merging it carries; an
// augmentation applies only where its module is part of the compilation.
import type {} from "@deepseek-ai/dsh-host-webserver";

/** Where the browser half reads from. Prefix, so one registration serves several reads. */
export const SQUAD_API_PREFIX = "/api/squad";

/** One team, flattened for the wire. */
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
      seats: team.seats.map((seat) => {
        const state = team.seatStates.find((candidate) => candidate.seatId === seat.seatId);
        return {
          seatId: seat.seatId,
          displayName: seat.displayName,
          role: seat.role,
          isSecretary: seat.isSecretary === true,
          running: state?.running === true,
          systemPrompt: seat.systemPrompt,
          backend: seat.backend,
          ...(seat.connectionId === undefined ? {} : { connectionId: seat.connectionId }),
          ...(seat.caps === undefined ? {} : { caps: seat.caps }),
          ...(seat.permissionMode === undefined ? {} : { permissionMode: seat.permissionMode }),
          ...(seat.templateId === undefined ? {} : { templateId: seat.templateId }),
          ...(seat.color === undefined ? {} : { color: seat.color }),
        };
      }),
      ...(team.progress === undefined
        ? {}
        : {
            progress: {
              phase: team.progress.phase,
              phaseIndex: team.progress.phaseIndex,
              phaseCount: team.progress.phaseCount,
            },
          }),
      recorded: team.transcript().filter((entry) => entry.kind === "user/message" && entry.text !== "").length,
      usage: team.usage,
    });
  }
  const [active, pending, connections] = await Promise.all([
    ctx.reasoning.criteria(),
    ctx.reasoning.pending(),
    ctx.seatConnections.views(),
  ]);
  return {
    teams,
    criteria: { active: active.length, pending: pending.length },
    connections,
    agents: ctx.agentTemplates.list(),
  };
}

/**
 * Create a team from the panel.
 *
 * Reuses the command's parser rather than validating again here. The rules it
 * enforces — absolute project folder, no duplicate seat names — were written
 * against a person typing, and a second copy would drift: the surface that
 * kept the weaker rules would be the one people found first.
 */
/** The three fields the panel collects, in the grammar the command uses. */
export function commandLineFor(request: CreateTeamRequest): string {
  return [request.displayName ?? "", request.projectFolder ?? "", request.roster ?? ""].join(" | ");
}

export async function createTeamFrom(ctx: Context, raw: string): Promise<string> {
  const input = parseNewTeam(raw);
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
      ...(seat.isSecretary ? { isSecretary: true } : {}),
    })),
  });
  return team.teamId;
}

const teamOf = (ctx: Context, teamId: string) => {
  const team = ctx.teams.get(teamId);
  if (team === undefined) throw new Error(`没有这支团队：${teamId}。`);
  return team;
};

/**
 * Add a seat to a live team.
 *
 * Configuring, not behaviour: an agent that adds a seat has not decided who
 * speaks. The seat id is minted here rather than accepted from the caller —
 * a client-chosen id could collide with one already in the record, and two
 * seats sharing an id are indistinguishable in every later reading of it.
 */
export function addSeatFrom(ctx: Context, request: SeatRequest): void {
  const team = teamOf(ctx, request.teamId);
  const seatId = `seat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const templateId = (request.templateId ?? "").trim();
  if (templateId !== "") {
    const template = ctx.agentTemplates.get(templateId);
    if (template === undefined) throw new Error(`Agent 库里没有这个模板：${templateId}。`);
    // The template's own answer to "may this be a secretary" is a refusal,
    // not a default that gets overwritten: an agent whose instructions never
    // mentioned planning an agenda should not become the seat that plans one
    // because a checkbox was ticked on the other screen.
    if (request.isSecretary === true && !template.secretaryCandidate) {
      throw new Error(`「${template.displayName}」在 Agent 库里没有勾选「可以当秘书」。`);
    }
    team.addSeat({
      seatId,
      displayName: template.displayName,
      role: template.role,
      systemPrompt: template.systemPrompt,
      backend: template.backend,
      templateId: template.templateId,
      color: template.color,
      ...(request.isSecretary === true ? { isSecretary: true } : {}),
      ...(template.connectionId === undefined ? {} : { connectionId: template.connectionId }),
      ...(template.permissionMode === undefined ? {} : { permissionMode: template.permissionMode }),
      ...(template.caps === undefined ? {} : { caps: template.caps }),
    });
    return;
  }

  const role = (request.role ?? "").trim() === "" ? "通用" : (request.role as string).trim();
  team.addSeat({
    seatId,
    displayName: (request.displayName ?? "").trim(),
    role,
    systemPrompt: `你的角色是${role}。回答简明，有依据。`,
    backend: "claude-code",
    ...(request.isSecretary === true ? { isSecretary: true } : {}),
  });
}

/**
 * Save an agent template, and the connection it was configured with.
 *
 * The connection comes first: a template that named a connection which the
 * next statement failed to create would point at nothing, and the failure
 * would surface at the first round as a missing provider.
 */
export async function saveAgentFrom(ctx: Context, request: AgentRequest): Promise<void> {
  let connectionId = request.connectionId;
  if (request.connection !== undefined) {
    const { credential, ...connection } = request.connection;
    await ctx.seatConnections.save(connection);
    if (credential !== undefined && credential !== "") {
      await ctx.seatConnections.setCredential(connection.connectionId, credential);
    }
    connectionId = connection.connectionId;
  }
  await ctx.agentTemplates.save({
    templateId: request.templateId,
    displayName: request.displayName,
    role: request.role,
    systemPrompt: request.systemPrompt,
    backend: request.backend,
    secretaryCandidate: request.secretaryCandidate,
    color: request.color,
    enabled: true,
    ...(connectionId === undefined || connectionId === "" ? {} : { connectionId }),
    ...(request.permissionMode === undefined ? {} : { permissionMode: request.permissionMode }),
    ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    ...(request.caps === undefined ? {} : { caps: request.caps }),
  });
}

/**
 * List the directories under one path, for the folder picker.
 *
 * A browser has no native folder dialog, and a text box asking for an
 * absolute path is a text box people mistype. This is the smallest thing that
 * replaces it: names of direct child directories, nothing else — no files, no
 * sizes, no contents. Read-only by construction, and the server it rides on
 * is the local one the person already has open.
 *
 * Unreadable children are skipped rather than failing the listing: a home
 * directory usually contains something the user cannot stat, and refusing to
 * show the other forty entries because of it helps nobody.
 */
export async function browseDirectory(target?: string): Promise<DirectoryListing> {
  const path = target === undefined || target.trim() === "" ? homedir() : resolve(target.trim());
  if (!isAbsolute(path)) throw new Error(`要绝对路径：「${path}」不是。`);
  const entries = await readdir(path, { withFileTypes: true }).catch((failure: NodeJS.ErrnoException) => {
    throw new Error(`读不了这个目录：${path}（${failure.code ?? failure.message}）`);
  });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const parent = dirname(path);
  return { path, directories, ...(parent === path ? {} : { parent }) };
}

/** Join a browsed directory with a child name, without letting `..` through. */
export function childPath(path: string, name: string): string {
  if (name.includes("/") || name === "..") throw new Error(`不是一个目录名：「${name}」。`);
  return join(path, name);
}

/** Remove a seat. Its past words stay in the record — the discussion happened. */
export function removeSeatFrom(ctx: Context, request: SeatRequest): void {
  teamOf(ctx, request.teamId).removeSeat(request.seatId ?? "", {
    ...(request.confirmSecretary === undefined ? {} : { confirmSecretary: request.confirmSecretary }),
  });
}

/**
 * Change one seat in place.
 *
 * Implemented as remove-then-add on the live roster so the roster rules run
 * again: a patch that could bypass them would be the surface with the weaker
 * checks, and that is the one people reach for.
 */
export function patchSeat(ctx: Context, patch: SeatPatch): void {
  const team = teamOf(ctx, patch.teamId);
  const seat = team.seats.find((candidate) => candidate.seatId === patch.seatId);
  if (seat === undefined) throw new Error(`这支团队里没有席位 ${patch.seatId}。`);
  // A connection that does not exist is accepted by the roster — it is just a
  // string — and then fails at start time as "no subagent provider registered
  // for claude-code-fenced:nope", a message that names a provider id nobody
  // typed, minutes after the click that caused it. Checked here, where the id
  // came from.
  if (patch.connectionId !== undefined && patch.connectionId !== "") {
    if (ctx.seatConnections.get(patch.connectionId) === undefined) {
      throw new Error(`没有这个连接：${patch.connectionId}。`);
    }
  }
  const next = {
    ...seat,
    ...(patch.connectionId === undefined
      ? {}
      : patch.connectionId === ""
        ? { connectionId: undefined }
        : { connectionId: patch.connectionId }),
    ...(patch.caps === undefined ? {} : { caps: patch.caps }),
  };
  // Remove-then-add so the roster rules run again on the result; `at` keeps
  // the seat where it was, because roster order is the order seats speak in
  // and changing a connection is not a decision about who goes first.
  const at = team.seats.findIndex((candidate) => candidate.seatId === patch.seatId);
  team.removeSeat(seat.seatId, { confirmSecretary: true });
  team.addSeat(next, { at });
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
        // Dispatched on the path suffix; the route is a prefix registration,
        // so one entry serves the whole surface.
        const suffix = (req.url ?? "").split("?")[0]?.slice(SQUAD_API_PREFIX.length) ?? "";
        if (suffix === "/connections") {
          if (req.method === "POST") {
            const body = await readJson<ConnectionRequest>(req);
            // A credential value may arrive with the connection, and it is
            // stored through the credential service and then dropped — it is
            // never written into the connection record, which is the whole
            // reason that record is safe to read and render.
            const { credential, ...connection } = body;
            await ctx.seatConnections.save(connection);
            if (credential !== undefined && credential !== "") {
              await ctx.seatConnections.setCredential(connection.connectionId, credential);
            }
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (req.method === "DELETE") {
            await ctx.seatConnections.remove((await readJson<{ connectionId: string }>(req)).connectionId);
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
        }
        if (suffix === "/agents") {
          if (req.method === "POST") {
            await saveAgentFrom(ctx, await readJson<AgentRequest>(req));
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (req.method === "DELETE") {
            await ctx.agentTemplates.remove((await readJson<{ templateId: string }>(req)).templateId);
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
        }
        if (suffix === "/browse" && req.method === "POST") {
          const body = await readJson<{ path?: string; child?: string }>(req);
          const base = body.path === undefined || body.path === "" ? undefined : body.path;
          const target = body.child === undefined || body.child === "" ? base : childPath(base ?? "", body.child);
          const listing = await browseDirectory(target);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(listing));
          return;
        }
        if (suffix === "/seats" && req.method === "PATCH") {
          const body = await readJson<SeatPatch>(req);
          patchSeat(ctx, body);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (suffix === "/seats" && (req.method === "POST" || req.method === "DELETE")) {
          const body = await readJson<SeatRequest>(req);
          if (req.method === "POST") addSeatFrom(ctx, body);
          else removeSeatFrom(ctx, body);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "POST") {
          const created = await createTeamFrom(ctx, commandLineFor(await readJson<CreateTeamRequest>(req)));
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
async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("请求体过大。");
    chunks.push(chunk as Buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("请求体不是 JSON 对象。");
  return parsed as T;
}

export type { ConnectionRequest, CreateTeamRequest, SeatPatch, SeatRequest, SquadSnapshot, TeamSummary };
