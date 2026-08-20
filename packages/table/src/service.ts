/**
 * service.ts — the table: a team, its host node, and its seats.
 *
 * The table is the plugin the host acts through. It creates the host node,
 * decides who speaks and in what order, and carries each seat's reply back
 * into the host's session so the team has one record of the discussion.
 *
 * Two rules hold the design together:
 *
 *   The host node is an anchor, never a decider. dsh requires a parent Agent
 *   for every subagent — it supplies cwd, lineage and authority — and that is
 *   all this one does. If its model ever chose who speaks, an LLM would be
 *   chairing the meeting, which is the one thing this product is not.
 *
 *   Seats have no channel to each other. A seat sees another seat's words only
 *   because the table put them in its prompt. Independent rounds are therefore
 *   a fact of the topology rather than a promise made in a system prompt.
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import type { SubagentStartRequest } from "@deepseek-ai/dsh-subagent";
import type { ContentBlock, UserMessage } from "@deepseek-ai/dsh-llm/types";
import { stripReasoning } from "@squad/shared";
import { composeSeatPrompt, type SeatSpec } from "./seat.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    teams: TeamsService;
  }
}

export interface CreateTeamInput {
  readonly displayName: string;
  /** Absolute path. Becomes the host node's session cwd, and every seat's. */
  readonly projectFolder: string;
  readonly hostDisplayName: string;
  readonly seats: readonly SeatSpec[];
}

export interface SeatReply {
  readonly seatId: string;
  readonly displayName: string;
  readonly text: string;
  readonly failed: boolean;
}

export interface Team {
  readonly teamId: string;
  readonly displayName: string;
  readonly projectFolder: string;
  readonly seats: readonly SeatSpec[];
  /** The host node's session id — the team's durable record. */
  readonly hostSessionId: string;
  /** Ask the named seats (or all of them) and return what they said. */
  ask(instruction: string, seatIds?: readonly string[]): Promise<readonly SeatReply[]>;
  dispose(): Promise<void>;
}

/** The provider name each backend is registered under in dsh. */
const PROVIDER_BY_BACKEND: Record<SeatSpec["backend"], string> = {
  "claude-code": "claude-code",
  codex: "codex",
  dsh: "dsh-sdk",
};

export class TeamsService extends Service {
  static readonly inject = ["agents", "subagents"];

  private readonly teams = new Map<string, TeamRecord>();

  constructor(ctx: Context) {
    super(ctx, "teams");
  }

  async create(input: CreateTeamInput): Promise<Team> {
    if (input.seats.length === 0) throw new Error("一支团队至少要有一个席位。");
    const teamId = `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // The host node. Its cwd is the team's project folder, which every seat
    // inherits — one team, one working directory.
    const handle = await this.ctx.agents.create({
      sessionId: teamId as never,
      meta: { cwd: input.projectFolder },
    });

    const record: TeamRecord = { teamId, input, handle, disposed: false };
    this.teams.set(teamId, record);
    return this.viewOf(record);
  }

  get(teamId: string): Team | undefined {
    const record = this.teams.get(teamId);
    return record === undefined || record.disposed ? undefined : this.viewOf(record);
  }

  list(): readonly string[] {
    return [...this.teams.values()].filter((r) => !r.disposed).map((r) => r.teamId);
  }

  private viewOf(record: TeamRecord): Team {
    return {
      teamId: record.teamId,
      displayName: record.input.displayName,
      projectFolder: record.input.projectFolder,
      seats: record.input.seats,
      hostSessionId: String(record.handle.agent.session.id),
      ask: (instruction, seatIds) => this.ask(record, instruction, seatIds),
      dispose: () => this.dispose(record),
    };
  }

  /**
   * One round.
   *
   * The instruction lands in the host's session first, so the record shows what
   * was asked even if every seat then fails. Each seat runs as a one-shot
   * subagent — a fresh process that keeps nothing — and its reply is injected
   * back into the host session, which is what makes the discussion durable
   * rather than a runtime detail nobody wrote down.
   */
  private async ask(
    record: TeamRecord,
    instruction: string,
    seatIds?: readonly string[],
  ): Promise<readonly SeatReply[]> {
    if (record.disposed) throw new Error("团队已销毁。");
    const seats =
      seatIds === undefined || seatIds.length === 0
        ? record.input.seats
        : record.input.seats.filter((seat) => seatIds.includes(seat.seatId));
    if (seats.length === 0) throw new Error("点名的席位都不在这支团队里。");

    const host = record.handle.agent;
    host.followup(userMessage(`【${record.input.hostDisplayName}】${instruction}`));

    const replies: SeatReply[] = [];
    for (const seat of seats) {
      replies.push(await this.runSeat(host, seat, instruction));
    }
    return replies;
  }

  private async runSeat(host: Agent, seat: SeatSpec, instruction: string): Promise<SeatReply> {
    const provider = PROVIDER_BY_BACKEND[seat.backend];
    const prompt = composeSeatPrompt({ seat, instruction, context: [] });
    try {
      const request: SubagentStartRequest = {
        label: seat.displayName,
        prompt: [{ type: "text", text: prompt }],
        parent: host,
        signal: new AbortController().signal,
      };
      const run = await this.ctx.subagents.start(provider, request);
      const result = await run.result;
      const text = stripReasoning(textOf(result.output));
      // Only `completed` is an answer. `aborted`, `error`, `max-tokens` and
      // `refusal` all leave the seat without one, and each has to be visible —
      // a round that quietly drops a member reads exactly like a round where
      // that member had nothing to say.
      const failed = result.stopReason !== "completed";
      // Injected rather than appended: the reply becomes model-visible context
      // for later rounds, and doing it through the inbox means the host's log
      // records that it arrived.
      host.inject(userMessage(`【${seat.displayName}】${text}`));
      return { seatId: seat.seatId, displayName: seat.displayName, text, failed };
    } catch (error) {
      // A seat that could not run is reported, never silently skipped: a round
      // that quietly loses a member looks exactly like one where the member had
      // nothing to say.
      const detail = error instanceof Error ? error.message : String(error);
      const text = `⚠️ 该席位未能执行：${detail}`;
      host.inject(userMessage(`【${seat.displayName}】${text}`));
      return { seatId: seat.seatId, displayName: seat.displayName, text, failed: true };
    }
  }

  private async dispose(record: TeamRecord): Promise<void> {
    if (record.disposed) return;
    record.disposed = true;
    await record.handle.dispose();
    this.teams.delete(record.teamId);
  }
}

interface TeamRecord {
  readonly teamId: string;
  readonly input: CreateTeamInput;
  readonly handle: AgentHandle;
  disposed: boolean;
}

const userMessage = (text: string): UserMessage =>
  ({
    id: `squad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    source: { kind: "host" },
    content: [{ type: "text", text }],
  }) as unknown as UserMessage;

const textOf = (blocks: readonly ContentBlock[]): string =>
  blocks
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block && typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("")
    .trim();
