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

import type {
  AgentRequest,
  CriterionVerdictRequest,
  CriterionView,
  NativePickResult,
  PickerKind,
  DirectoryListing as WireDirectoryListing,
  TeamMember,
  ConnectionRequest,
  CreateTeamRequest,
  SeatPatch,
  SeatRequest,
  SquadSnapshot,
  TeamSummary,
} from "./wire.ts";
import { parseNewTeam } from "./parse.ts";
import { providerForSeat, providerNameFor, type AgentCheckReport, type CheckResult } from "@squad/shared";

/** Providers the non-claude backends would ask for, if their plugins existed. */
const PROVIDER_BY_BACKEND_NAME: Readonly<Record<string, string>> = { codex: "codex", dsh: "dsh-sdk" };
// Imported for the `Context.webServer` declaration merging it carries; an
// augmentation applies only where its module is part of the compilation.
import type {} from "@deepseek-ai/dsh-host-webserver";
// Same reason: `ctx.directoryPicker` is a declaration merge.
import type { DirectoryPicker } from "@deepseek-ai/dsh-host-directory-picker";

/** Where the browser half reads from. Prefix, so one registration serves several reads. */
export const SQUAD_API_PREFIX = "/api/squad";

/** One team, flattened for the wire. */
/**
 * Flatten one criterion for the panel.
 *
 * `evidence` becomes a count rather than the ids: the ids point at instances,
 * which are the user's own occurrences with project detail in them and never
 * leave the machine. A panel showing them would be the first thing to carry
 * one across that boundary.
 */
function criterionView(
  criterion: {
    readonly id: string;
    readonly claim: string;
    readonly boundary?: string | undefined;
    readonly status: "active" | "suspect" | "retired";
    readonly evidence: readonly string[];
    readonly trigger: {
      readonly action: readonly string[];
      readonly features: readonly string[];
      readonly step?: readonly string[] | undefined;
    };
  },
  health?: { readonly verdict: string; readonly detail: string },
): CriterionView {
  return {
    id: criterion.id,
    claim: criterion.claim,
    ...(criterion.boundary === undefined ? {} : { boundary: criterion.boundary }),
    status: criterion.status,
    evidence: criterion.evidence.length,
    trigger: {
      action: criterion.trigger.action,
      features: criterion.trigger.features,
      ...(criterion.trigger.step === undefined ? {} : { step: criterion.trigger.step }),
    },
    ...(health === undefined ? {} : { health: { verdict: health.verdict, detail: health.detail } }),
  };
}

/**
 * Why a seat cannot run, when it cannot.
 *
 * Asked of the registry, so this cannot drift from what was actually built:
 * a seat on a backend with no plugin fails the instant the round starts,
 * having sent nothing, and reporting a provider name afterwards is the worst
 * moment to learn it. The check lives here rather than in the table because
 * only the console can act on the answer — the table's job is to run the
 * round, not to shop for a provider.
 */
function blockedReason(
  ctx: Context,
  seat: { backend: string; connectionId?: string | undefined; permissionMode?: string | undefined },
) {
  const wanted = providerForSeat(seat);
  if (ctx.subagents.getProvider(wanted) !== undefined) return undefined;
  return seat.backend === "claude-code" ? `连接不在了（要的是 ${wanted}）` : `Squad 还没有 ${seat.backend} 的席位插件`;
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
          ...(blockedReason(ctx, seat) === undefined ? {} : { blocked: blockedReason(ctx, seat) }),
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
  const [active, pending, connections, health] = await Promise.all([
    ctx.reasoning.criteria(),
    ctx.reasoning.pending(),
    ctx.seatConnections.views(),
    // Health is per criterion and read from disk, so it is fetched once for
    // the whole snapshot rather than per row.
    ctx.reasoning.health(),
  ]);
  const healthById = new Map(health.map((entry) => [entry.criterionId, entry]));
  return {
    teams,
    criteria: {
      active: active.length,
      pending: pending.length,
      proposals: pending.map((criterion) => criterionView(criterion)),
      live: active.map((criterion) => criterionView(criterion, healthById.get(criterion.id))),
    },
    connections,
    agents: ctx.agentTemplates.list(),
    picker: pickerKind(ctx),
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

/**
 * Create a team from agents picked off the library.
 *
 * The panel's path. It does not go through the text grammar, because there is
 * nothing to parse: each member is already a configured agent, and the seat
 * it becomes carries that configuration — backend, connection, permission
 * mode, ceilings — instead of a name and a guessed system prompt.
 *
 * `checkRoster` is still the authority on the result, reached through
 * `teams.create`. The checks here are the ones that can say something more
 * useful before that: which template is missing, and which agent the library
 * never cleared to be a secretary.
 */
export async function createTeamWithMembers(
  ctx: Context,
  input: { readonly displayName: string; readonly projectFolder: string; readonly members: readonly TeamMember[] },
): Promise<string> {
  if (input.displayName.trim() === "") throw new Error("给团队起个名字。");
  if (!input.projectFolder.trim().startsWith("/")) {
    throw new Error(`项目文件夹要写绝对路径：「${input.projectFolder}」不是。`);
  }
  if (input.members.length === 0) throw new Error("至少要选一个 Agent。");

  const seats = input.members.map((member, index) => {
    const template = ctx.agentTemplates.get(member.templateId);
    if (template === undefined) throw new Error(`Agent 库里没有这个模板：${member.templateId}。`);
    if (member.isSecretary === true && !template.secretaryCandidate) {
      throw new Error(`「${template.displayName}」在 Agent 库里没有勾选「可以当秘书」。`);
    }
    return {
      seatId: `seat-${index + 1}`,
      displayName: template.displayName,
      role: template.role,
      systemPrompt: template.systemPrompt,
      backend: template.backend,
      templateId: template.templateId,
      color: template.color,
      ...(member.isSecretary === true ? { isSecretary: true } : {}),
      ...(template.connectionId === undefined ? {} : { connectionId: template.connectionId }),
      ...(template.permissionMode === undefined ? {} : { permissionMode: template.permissionMode }),
      ...(template.caps === undefined ? {} : { caps: template.caps }),
    };
  });

  const team = await ctx.teams.create({
    displayName: input.displayName.trim(),
    projectFolder: input.projectFolder.trim(),
    hostDisplayName: "主持人",
    seats,
  });
  return team.teamId;
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

/** Which CLI each backend needs on PATH. */
const EXECUTABLE_BY_BACKEND: Readonly<Record<string, string>> = {
  "claude-code": "claude",
  codex: "codex",
  dsh: "dsh",
};

/**
 * Test one agent's configuration.
 *
 * Four independent answers rather than one verdict, because they fail for
 * unrelated reasons and each has a different fix. A skipped check is reported
 * as skipped and never folded into a pass — see `overallOf`.
 *
 * Nothing here starts a model turn. A test that spent tokens would be a test
 * people stop running.
 */
export async function checkAgent(ctx: Context, templateId: string): Promise<AgentCheckReport> {
  const template = ctx.agentTemplates.get(templateId);
  if (template === undefined) throw new Error(`Agent 库里没有这个模板：${templateId}。`);
  const checks: CheckResult[] = [];

  // ① A seat backend for this CLI. Today only claude-code has one, and an
  // agent on any other backend fails at its FIRST ROUND with "no subagent
  // provider registered" — a message naming a provider the person never
  // typed. Saying it here is the difference between a configuration you can
  // fix and a meeting that dies halfway through.
  const provider = providerNameFor(
    template.backend === "claude-code" ? (template.connectionId ?? "") : "",
    template.backend === "claude-code" ? template.permissionMode : undefined,
  );
  const wanted =
    template.backend === "claude-code" ? provider : (PROVIDER_BY_BACKEND_NAME[template.backend] ?? template.backend);
  const registered = ctx.subagents.getProvider(wanted) !== undefined;
  checks.push(
    registered
      ? { name: "席位后端", outcome: "ok", detail: wanted }
      : {
          name: "席位后端",
          outcome: "fail",
          detail:
            `没有注册「${wanted}」。` +
            (template.backend === "claude-code"
              ? "通常是这个连接刚被删掉了。"
              : `Squad 目前只做了 claude-code 的席位插件，${template.backend} 的还没有——这个 agent 一开会就会失败。` +
                `已注册的有：${ctx.subagents.list().join("、")}`),
        },
  );

  // ② The CLI itself.
  const executable = EXECUTABLE_BY_BACKEND[template.backend];
  if (executable === undefined) {
    checks.push({ name: "命令行工具", outcome: "skipped", detail: `不知道 ${template.backend} 用哪个可执行文件。` });
  } else {
    try {
      const path = await ctx.subprocess.resolveExecutable(executable, {});
      checks.push({ name: "命令行工具", outcome: "ok", detail: path });
    } catch (failure) {
      checks.push({
        name: "命令行工具",
        outcome: "fail",
        detail: `PATH 上找不到 ${executable}（${failure instanceof Error ? failure.message : String(failure)}）。`,
      });
    }
  }

  // ③ The credential, when the connection needs one.
  const connection = template.connectionId === undefined ? undefined : ctx.seatConnections.get(template.connectionId);
  if (template.connectionId === undefined) {
    checks.push({ name: "密钥", outcome: "skipped", detail: "用本机登录态，不需要密钥。" });
  } else if (connection === undefined) {
    checks.push({ name: "密钥", outcome: "fail", detail: `连接 ${template.connectionId} 不存在了。` });
  } else if (connection.authMode === "subscription") {
    checks.push({ name: "密钥", outcome: "skipped", detail: "订阅模式用本机登录态，不需要密钥。" });
  } else {
    const views = await ctx.seatConnections.views();
    const view = views.find((candidate) => candidate.connectionId === connection.connectionId);
    checks.push(
      view?.credentialConfigured === true
        ? { name: "密钥", outcome: "ok", detail: `已配置（${connection.credentialRef}）` }
        : { name: "密钥", outcome: "fail", detail: `「${connection.credentialRef}」还没有值。` },
    );
  }

  // ④ The endpoint. Reachability only — a HEAD that expects no particular
  // status, because an auth error from the right host still proves the host
  // is there, and a test that demanded 200 would fail on every gateway that
  // refuses unauthenticated probes.
  const endpoint = (connection?.endpoint ?? "").trim();
  if (endpoint === "") {
    checks.push({ name: "接口地址", outcome: "skipped", detail: "用后端默认地址。" });
  } else {
    try {
      const response = await fetch(endpoint, { method: "HEAD", signal: AbortSignal.timeout(5000) });
      checks.push({ name: "接口地址", outcome: "ok", detail: `${endpoint} 有响应（HTTP ${response.status}）` });
    } catch (failure) {
      checks.push({
        name: "接口地址",
        outcome: "fail",
        detail: `连不上 ${endpoint}（${failure instanceof Error ? failure.message : String(failure)}）`,
      });
    }
  }

  return { templateId, displayName: template.displayName, checks };
}

/**
 * The picker service, or `undefined` where none is mounted.
 *
 * `ctx.get` rather than an `inject` entry, deliberately. Injecting it would
 * make the console WAIT for a service a composition may never provide —
 * cordis holds the fiber until a declared dependency appears — so a missing
 * FILE DIALOG would silently take the whole team surface down with it.
 * `ctx.get` answers `undefined`, and the form then says the host has no
 * picker instead of drawing a button that cannot work.
 */
function picker(ctx: Context): DirectoryPicker | undefined {
  return ctx.reflect.get("directoryPicker") as DirectoryPicker | undefined;
}

/**
 * How this host lets a person choose a folder.
 *
 * Asked rather than assumed. dsh resolves the interaction at boot — an OS
 * chooser when the host has a display, listing primitives when it does not,
 * because no dialog can reach a remote browser — and exposes it as a
 * discriminated capability. The first version of this route hand-rolled
 * `readdir`, which meant a machine with a real file dialog never got to use
 * it, and the in-app list was the only thing anyone ever saw.
 */
export function pickerKind(ctx: Context): PickerKind {
  const capability = picker(ctx)?.capability();
  if (capability === undefined) return "none";
  return capability.kind === "native" || capability.kind === "browse" ? capability.kind : "none";
}

/**
 * Open the host's OS directory chooser.
 *
 * `null` is a cancellation, not a failure — a person who closed the dialog
 * made a choice, and reporting it as an error would put a red line under a
 * decision they meant.
 */
export async function pickDirectoryNatively(ctx: Context, signal?: AbortSignal): Promise<NativePickResult> {
  const capability = picker(ctx)?.capability();
  if (capability?.kind !== "native") throw new Error("这台宿主没有原生的文件夹对话框。");
  const path = await capability.pick(signal ?? new AbortController().signal);
  return { path };
}

/** List one directory level through the browse backend. */
export async function browseDirectory(ctx: Context, target?: string): Promise<WireDirectoryListing> {
  const capability = picker(ctx)?.capability();
  if (capability?.kind !== "browse") throw new Error("这台宿主不提供目录浏览。");
  const listing = await capability.list(
    target === undefined || target.trim() === "" ? undefined : target.trim(),
    new AbortController().signal,
  );
  return {
    kind: "browse",
    path: listing.path,
    home: listing.home,
    crumbs: listing.crumbs,
    // Hidden rows are dropped here rather than at the seam: the backend
    // reports the flag and leaves the policy to the client, and a project
    // folder is essentially never a dot-directory.
    entries: listing.entries.filter((entry) => !entry.hidden),
    truncated: listing.truncated,
  };
}

/**
 * Disband a team.
 *
 * The record it wrote stays: the discussion happened, and a checkpoint whose
 * team is gone is still the only account of what was decided. What ends is
 * the live table — its host node, its seats, its in-flight rounds.
 */
export async function disbandTeam(ctx: Context, teamId: string): Promise<void> {
  await teamOf(ctx, teamId).dispose();
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
        if (suffix === "/agents/test" && req.method === "POST") {
          const body = await readJson<{ templateId: string }>(req);
          const report = await checkAgent(ctx, body.templateId);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(report));
          return;
        }
        if (suffix === "/criteria" && req.method === "POST") {
          const body = await readJson<CriterionVerdictRequest>(req);
          await ctx.reasoning.resolve(body.id, body.verdict);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (suffix === "/browse" && req.method === "POST") {
          const body = await readJson<{ path?: string }>(req);
          const listing = await browseDirectory(ctx, body.path);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(listing));
          return;
        }
        if (suffix === "/pick" && req.method === "POST") {
          const picked = await pickDirectoryNatively(ctx);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(picked));
          return;
        }
        if (suffix === "/teams" && req.method === "DELETE") {
          await disbandTeam(ctx, (await readJson<{ teamId: string }>(req)).teamId);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (suffix === "/say" && req.method === "POST") {
          // A round costs real model calls, so it is a deliberate act — but a
          // person clicking a button in the panel is exactly as much a person
          // as one typing a slash command. The invariant this product keeps
          // is that no MODEL takes the chair, not that only typing counts.
          const body = await readJson<{ teamId: string; instruction: string; seatIds?: readonly string[] }>(req);
          const team = teamOf(ctx, body.teamId);
          if (body.instruction.trim() === "") throw new Error("指令是空的。");
          const replies = await team.ask(body.instruction.trim(), body.seatIds);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ replies: replies.map((reply) => ({ ...reply })) }));
          return;
        }
        if (suffix === "/stop" && req.method === "POST") {
          const body = await readJson<{ teamId: string; reason?: string }>(req);
          await teamOf(ctx, body.teamId).stopAgenda(body.reason ?? "主持人在面板上叫停。");
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true }));
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
          const body = await readJson<CreateTeamRequest>(req);
          // `members` wins when both arrive: it carries configuration, the
          // text grammar carries only names.
          const created =
            body.members === undefined
              ? await createTeamFrom(ctx, commandLineFor(body))
              : await createTeamWithMembers(ctx, {
                  displayName: body.displayName ?? "",
                  projectFolder: body.projectFolder ?? "",
                  members: body.members,
                });
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
