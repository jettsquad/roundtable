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
  AgendaVerdictRequest,
  ConnectionRequest,
  CreateTeamRequest,
  DraftAgendaRequest,
  SeatPatch,
  SeatRequest,
  SquadSnapshot,
  TeamSummary,
} from "./wire.ts";
import { parseNewTeam } from "./parse.ts";
import { tmpdir } from "node:os";
import { assertPublicHostCommand, checkAgendaAgainstRoster, type AgendaSpec } from "@squad/shared";
import {
  connectionMismatch,
  providerForSeat,
  type AgentCheckReport,
  type AgentTemplate,
  type CheckResult,
} from "@squad/shared";

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
  // Named honestly, and no longer claiming the backend has no plugin — all
  // three have one now. The usual cause is a connection whose OWN backend
  // differs from the seat's, because a provider is registered under the
  // connection's backend.
  return `没有注册「${wanted}」——多半是这个席位的连接属于另一个后端，或者连接已经删了`;
}

/**
 * How many lines of discussion travel in a snapshot.
 *
 * The panel polls; the record grows without bound. Sending all of it would
 * make looking at the roster cost more than holding the meeting.
 */
const TRANSCRIPT_TAIL = 60;

/**
 * The tail of the discussion, and how much was left out.
 *
 * The omitted COUNT rides along rather than being silently dropped: a
 * transcript that begins mid-sentence with nothing saying so reads as the
 * whole discussion, and a person then concludes the team never said the
 * thing they are looking for.
 */
function transcriptTail(events: readonly { kind: string; text: string; turnId: string }[]) {
  const spoken = events
    .filter((event) => event.kind === "user/message" && event.text !== "")
    .map((event) => {
      // `【甲】说的话` is how the record stores a speaker; split it back apart
      // so the view can style the name without re-parsing markup.
      const match = /^【([^】]+)】([\s\S]*)$/.exec(event.text);
      return {
        speaker: match?.[1] ?? "",
        text: (match?.[2] ?? event.text).trim(),
        turnId: event.turnId,
      };
    });
  return {
    transcript: spoken.slice(-TRANSCRIPT_TAIL),
    transcriptOmitted: Math.max(0, spoken.length - TRANSCRIPT_TAIL),
  };
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
      hostDisplayName: team.hostDisplayName,
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
              completedPhases: team.progress.completedPhases,
            },
          }),
      recorded: team.transcript().filter((entry) => entry.kind === "user/message" && entry.text !== "").length,
      usage: team.usage,
      ...transcriptTail(team.transcript()),
      ...(draftOf(teamId) === undefined ? {} : { draft: draftOf(teamId) }),
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
    connections: connections.map((connection) => ({
      ...connection,
      // Asked of the registry, so it cannot drift from what was actually
      // built — see `PanelConnection`.
      providerReady:
        ctx.subagents.getProvider(
          providerForSeat({ backend: connection.backend, connectionId: connection.connectionId }),
        ) !== undefined,
    })),
    agents: ctx.agentTemplates.list(),
    picker: pickerKind(ctx),
  };
}

/**
 * Drafts waiting on a host, by team.
 *
 * Held on the SERVER and not in a browser tab. The confirmation is the
 * decision this whole product exists to keep with a person, and a draft that
 * lived in one tab would vanish on a reload and be invisible to every other
 * surface — the host would end up confirming from memory.
 *
 * In memory rather than in storage, deliberately: a draft is a proposal for
 * the next few minutes, and one that outlived a restart would be confirmed
 * against a discussion that had moved on.
 */
const drafts = new Map<string, AgendaSpec>();

/**
 * Ask the secretary to turn the host's sentence into phases.
 *
 * It DRAFTS; it never executes. The table runs only what the host confirmed —
 * which is the one thing that keeps a wrong agenda costing a click instead of
 * a meeting.
 */
export async function draftAgendaFor(ctx: Context, request: DraftAgendaRequest): Promise<AgendaSpec> {
  const team = teamOf(ctx, request.teamId);
  const secretary = team.secretary;
  if (secretary === undefined) throw new Error("这支团队没有秘书，排不了议程。到面板里指一位。");
  if (request.command.trim() === "") throw new Error("先说要做什么。");
  // Refused BEFORE the model is contacted: `@` is how the host points at
  // material only they can see, and the secretary is private-blind.
  assertPublicHostCommand(request.command);

  const draft = await ctx.secretary.draftAgenda({
    parent: team.host,
    secretary,
    command: request.command,
    topic: team.displayName,
    seats: team.seats.map((seat) => ({ seatId: seat.seatId, displayName: seat.displayName })),
  });
  // Checked against the REAL roster before it is ever shown. A hallucinated
  // seat id survives parsing, and at execution a task nobody can run looks
  // exactly like a seat that had nothing to say.
  const problems = checkAgendaAgainstRoster(
    draft,
    team.seats.map((seat) => seat.seatId),
  );
  if (problems.length > 0) {
    throw new Error(problems.map((problem) => `「${problem.phase}」：${problem.detail}`).join("\n"));
  }
  drafts.set(request.teamId, draft);
  return draft;
}

/**
 * The host's verdict.
 *
 * Confirming RUNS it, and the run is not awaited here: an agenda is minutes
 * of work and the click that started it must not hang on it. Progress shows
 * in the snapshot, and 「叫停」 reaches it.
 */
export function resolveAgenda(ctx: Context, request: AgendaVerdictRequest): void {
  const team = teamOf(ctx, request.teamId);
  const held = request.agenda ?? drafts.get(request.teamId);
  if (held === undefined) throw new Error("没有待确认的议程。");
  drafts.delete(request.teamId);
  if (request.verdict === "discard") return;

  // An edited draft is re-checked. The panel lets a host retype an
  // instruction and a seat id, and the roster rule has to run on what they
  // actually confirmed rather than on what the secretary first proposed.
  const problems = checkAgendaAgainstRoster(
    held,
    team.seats.map((seat) => seat.seatId),
  );
  if (problems.length > 0) {
    throw new Error(problems.map((problem) => `「${problem.phase}」：${problem.detail}`).join("\n"));
  }
  void team.runAgenda(held).catch((error: Error) => {
    ctx.logger.warn(`议程失败：${error.message}`);
  });
}

/** The draft this team is holding, if any. */
export const draftOf = (teamId: string): AgendaSpec | undefined => drafts.get(teamId);

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
  // Refused at save, where it can still be fixed cheaply. Left to run time
  // it becomes an unregistered provider name at the first round.
  if (connectionId !== undefined && connectionId !== "") {
    const linked = ctx.seatConnections.get(connectionId);
    if (linked !== undefined) {
      const problem = connectionMismatch(request.backend, linked.backend, linked.displayName);
      if (problem !== undefined) throw new Error(problem);
    }
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
 * Run one real, tiny round through this agent's actual backend.
 *
 * It costs a model call. That is the price of an answer to "does this
 * work", and the alternative — four green ticks over a configuration that
 * cannot answer anything — already cost more.
 *
 * The parent is a throwaway host node in a temp directory, disposed
 * afterwards: a seat needs a parent agent, and borrowing a team's would
 * write the probe into that team's discussion.
 */
async function probeSeat(ctx: Context, template: AgentTemplate): Promise<CheckResult> {
  const probeId = `squad-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const deadline = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  let handle: { agent: Parameters<typeof ctx.subagents.start>[1]["parent"]; dispose(): Promise<void> } | undefined;
  try {
    handle = await ctx.agents.create({ sessionId: probeId as never, meta: { cwd: tmpdir() } });
    const run = await ctx.subagents.start(providerForSeat(template), {
      label: `${template.displayName}（测试）`,
      prompt: [{ type: "text", text: "回答两个字：收到。不要做别的事，不要读写任何文件。" }],
      parent: handle.agent,
      signal: deadline,
    });
    const result = await run.result;
    const text = textOfBlocks(result.output).trim();
    if (result.stopReason !== "completed") {
      // Our own deadline is named, because 「停在 aborted」 says nothing: it
      // reads as a cancellation somebody asked for. A CLI that handshakes and
      // then never answers is the shape a wrong-protocol endpoint has, and
      // that is worth saying out loud.
      const timedOut = deadline.aborted;
      const detail =
        text !== ""
          ? text
          : timedOut
            ? `${Math.round(PROBE_TIMEOUT_MS / 1000)} 秒内没有答复。多半是这个端点不讲 ${template.backend} 的协议——` +
              `它能连上不代表它听得懂。`
            : `停在 ${result.stopReason}，而且什么都没输出。`;
      return { name: "真的问一句", outcome: "fail", detail };
    }
    return {
      name: "真的问一句",
      outcome: "ok",
      detail: `答了：${text.slice(0, 120)}${text.length > 120 ? "…" : ""}`,
    };
  } catch (failure) {
    return {
      name: "真的问一句",
      outcome: "fail",
      detail: failure instanceof Error ? failure.message : String(failure),
    };
  } finally {
    // Disposed on every path. A probe that leaked its host node would leave a
    // session in the sidebar for every click of a test button.
    await handle?.dispose().catch(() => undefined);
  }
}

/** How long a probe may take before it is a failure in its own right. */
const PROBE_TIMEOUT_MS = 90_000;

/** The text of a subagent's output blocks. */
function textOfBlocks(blocks: readonly unknown[]): string {
  return blocks
    .map((block) => (typeof block === "object" && block !== null && "text" in block ? String(block.text) : ""))
    .join("");
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
  // Through `providerForSeat`, the same derivation the table uses when it
  // actually starts the seat. This used to hardcode claude-code and fall back
  // to a local map for the others, so the test asked whether `codex` was
  // registered while the seat would ask for `codex/<connection>` — a test
  // that passes and a round that fails, which is worse than no test.
  const wanted = providerForSeat(template);
  const registered = ctx.subagents.getProvider(wanted) !== undefined;
  const linked = template.connectionId === undefined ? undefined : ctx.seatConnections.get(template.connectionId);
  const mismatch =
    linked === undefined ? undefined : connectionMismatch(template.backend, linked.backend, linked.displayName);
  checks.push(
    registered
      ? { name: "席位后端", outcome: "ok", detail: wanted }
      : {
          name: "席位后端",
          outcome: "fail",
          // The list of every registered provider used to ride along here.
          // It is dozens of names and none of them is the answer; the answer
          // is almost always that the connection belongs to another backend,
          // which this says instead.
          detail: `没有注册「${wanted}」。${mismatch ?? "这个连接可能已经删了。"}`,
        },
  );

  // ② The CLI itself.
  const executable = EXECUTABLE_BY_BACKEND[template.backend];
  if (executable === undefined) {
    // Wanted to check and could not — evidence is missing, so `unknown`
    // rather than `skipped`. Nothing here is "not applicable": a backend with
    // no known executable is a gap in this code.
    checks.push({ name: "命令行工具", outcome: "unknown", detail: `不知道 ${template.backend} 用哪个可执行文件。` });
  } else {
    try {
      const path = await ctx.subprocess.resolveExecutable(executable, {});
      checks.push({ name: "命令行工具", outcome: "ok", detail: path });
    } catch {
      checks.push({
        name: "命令行工具",
        outcome: "fail",
        detail:
          `PATH 上找不到 ${executable}。` +
          (template.backend === "dsh"
            ? "harness 自带一个 dsh 可执行文件，但用 `node …/bin.js` 启动的人通常没有把它链到 PATH 上——" +
              "把它链上，或者在 profile 里给 squad-seat-dsh 配一个绝对路径的 command。"
            : `装好它，或者把它所在的目录加进 PATH。`),
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

  // ④ The endpoint — REACHABILITY ONLY, and labelled as such. A HEAD that
  // gets any status proves a host is there; it proves nothing about the
  // protocol it speaks. This check passed for a MiniMax gateway behind a
  // claude-code seat, which answers HTTP happily and does not speak the
  // Anthropic API at all.
  const endpoint = (connection?.endpoint ?? "").trim();
  if (endpoint === "") {
    checks.push({ name: "地址可达", outcome: "skipped", detail: "用后端默认地址。" });
  } else {
    try {
      const response = await fetch(endpoint, { method: "HEAD", signal: AbortSignal.timeout(8000) });
      checks.push({
        name: "地址可达",
        outcome: "ok",
        detail: `${endpoint} 有响应（HTTP ${response.status}）。只说明主机在，不说明它讲这个后端的协议。`,
      });
    } catch (failure) {
      checks.push({
        name: "地址可达",
        outcome: "fail",
        detail: `连不上 ${endpoint}（${failure instanceof Error ? failure.message : String(failure)}）`,
      });
    }
  }

  // ⑤ Actually ask it something.
  //
  // The four checks above are PLUMBING. They all passed for two agents that
  // could not answer a single question — one pointed at a gateway speaking
  // the wrong protocol, one holding an invalid key — because none of them
  // ever spoke to a model. A test that passes while the thing fails is worse
  // than no test, and this is the only check that can tell "configured" from
  // "works".
  //
  // Skipped rather than faked when the plumbing already failed: starting a
  // seat whose provider is not registered just reproduces the error above.
  if (!registered) {
    // Not applicable would be wrong: this is the check that matters, and it
    // did not run. `unknown` keeps the report from reading as a pass.
    checks.push({ name: "真的问一句", outcome: "unknown", detail: "席位后端没就绪，问不出去——先解决上面那条。" });
  } else {
    checks.push(await probeSeat(ctx, template));
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
        if (suffix === "/agenda/draft" && req.method === "POST") {
          const draft = await draftAgendaFor(ctx, await readJson<DraftAgendaRequest>(req));
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(draft));
          return;
        }
        if (suffix === "/agenda" && req.method === "POST") {
          resolveAgenda(ctx, await readJson<AgendaVerdictRequest>(req));
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
          teamOf(ctx, body.teamId).stop(body.reason ?? "主持人在面板上叫停。");
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
