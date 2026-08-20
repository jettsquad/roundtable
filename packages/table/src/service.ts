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
import type { ContentBlock } from "@deepseek-ai/dsh-llm/types";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveArtifactPath, stripReasoning, type AgendaSpec } from "@squad/shared";
import { pausesAfter, planPhase } from "./agenda.ts";
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
  /**
   * Multiplier on the 1M-token base that sets when the record is folded.
   *
   * A base rather than a per-model lookup: no API reports a model's context
   * window, a built-in table goes stale, and one team's seats may sit on
   * different models — so it would have to be filled in more than once and
   * again on every model change. Asked once, as a coefficient.
   */
  readonly checkpointCoefficient?: number | undefined;
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
  /** A round is running right now; folding waits for this to clear. */
  readonly busy: boolean;
  /** The team's checkpoint coefficient, if it set one. */
  readonly checkpointCoefficient?: number | undefined;
  /**
   * The host node itself.
   *
   * Exposed because dsh requires a parent Agent for every subagent, and the
   * secretary has none of its own — a caller asking it to fold this team's
   * discussion passes this. Handing it out is not handing out permission to
   * run turns on it: the host node is an anchor, and `@squad/context`'s
   * assembler throws if it ever finds turn events in this log.
   */
  readonly host: Agent;
  /** Ask the named seats (or all of them) and return what they said. */
  ask(instruction: string, seatIds?: readonly string[]): Promise<readonly SeatReply[]>;
  /**
   * Run an agenda the host has already confirmed.
   *
   * Confirmed, not drafted: the table executes and never proposes. The
   * secretary drafts, the host decides, and this runs what they decided —
   * which is what keeps a wrong agenda costing a click instead of an
   * afternoon.
   */
  runAgenda(agenda: AgendaSpec): Promise<AgendaOutcome>;
  /**
   * The team record, flattened — every event, in order, nothing filtered.
   *
   * Faithful on purpose. It is tempting to drop the events a seat obviously
   * should not read, but the assembler's whole guarantee is that every kind
   * lands in one of its three tables, and one of those tables exists to catch
   * the host node having run a turn. Filtering here would hide exactly the
   * events that prove the invariant was broken, and the component built to
   * notice would be the one component that never sees them.
   */
  transcript(): readonly TranscriptEvent[];
  dispose(): Promise<void>;
}

/** One recorded event of a team, in the flat shape assembly reads. */
export interface TranscriptEvent {
  /** The dsh event type verbatim — `user/message`, `turn/start`, … */
  readonly kind: string;
  /** Text carried by the event, or empty for the ones that carry none. */
  readonly text: string;
  /** Stable identity of this entry, used to cut windows at a checkpoint. */
  readonly turnId: string;
}

/**
 * The collaborator that decides what seats see, and folds the record when it
 * grows too large.
 *
 * Registered by `@squad/context`; absent until it mounts. The dependency runs
 * one way only — context injects `teams`, never the reverse — because two
 * services that inject each other cannot both start. A table with nobody
 * registered hands its seats an empty window, which is exactly stage 1's
 * behaviour and is why stage 1 still runs.
 *
 * A cordis event would have done this too, but the event's type would have to
 * be declared in one plugin and consumed in another that is forbidden to
 * import it. A registered object keeps the seam typed on one side.
 */
export interface TeamAssembler {
  /** The lines this seat is shown this round. */
  windowFor(teamId: string, seatId: string): Promise<readonly string[]>;
  /**
   * A round just finished and this team is idle.
   *
   * Returns `void`, not a promise: folding must never make the team wait, and
   * a signature with nothing to await makes that structural rather than a
   * comment. Whatever it starts, it owns — including reporting its own
   * failures, because nobody here is listening for them.
   */
  roundEnded(teamId: string): void;
  /**
   * A file was just written, project-relative.
   *
   * Reported so the next checkpoint's index can list paths that really exist.
   * `void` for the same reason as `roundEnded`: bookkeeping must not make the
   * team wait, and the registrant owns reporting its own failures.
   */
  artifactWritten(teamId: string, path: string): void;
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
  private assembler: TeamAssembler | undefined;

  constructor(ctx: Context) {
    super(ctx, "teams");
  }

  /**
   * Register the assembler that decides what each seat sees.
   *
   * Returns its disposer; the registrant owns the lifetime (typically its own
   * `ctx.effect`). A second registration while one is live throws rather than
   * replacing it: two assemblers silently taking turns would make what a seat
   * saw depend on mount order, and nothing in the record would say so.
   */
  useAssembler(assembler: TeamAssembler): () => void {
    if (this.assembler !== undefined) {
      throw new Error("已经有一个上下文装配器注册在这张桌子上了。");
    }
    this.assembler = assembler;
    return () => {
      if (this.assembler === assembler) this.assembler = undefined;
    };
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

    const record: TeamRecord = { teamId, input, handle, roundsInFlight: 0, disposed: false };
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
      host: record.handle.agent,
      // Read through the record, not captured: a view handed out before a
      // round started must not keep reporting the team as idle.
      get busy() {
        return record.roundsInFlight > 0;
      },
      checkpointCoefficient: record.input.checkpointCoefficient,
      ask: (instruction, seatIds) => this.ask(record, instruction, seatIds),
      transcript: () => transcriptOf(record.handle.agent),
      runAgenda: (agenda) => this.runAgenda(record, agenda),
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

    // Windows are taken BEFORE the instruction is recorded. The instruction
    // reaches a seat as 「本轮指令」; a seat that then also finds the same
    // sentence inside the carried discussion is reading it twice and has to
    // guess which copy it is answering. The snapshot is also what
    // `contextMode: independent` means — every seat sees the discussion as it
    // stood when the round opened, not as the seats ahead of it left it.
    // (Cumulative mode will need this taken per seat, mid-loop, instead.)
    const windows = new Map<string, WindowAttempt>();
    for (const seat of seats) {
      windows.set(seat.seatId, await this.contextFor(record.teamId, seat.seatId));
    }

    recordSpoken(host, record.input.hostDisplayName, instruction);

    const replies: SeatReply[] = [];
    record.roundsInFlight += 1;
    try {
      for (const seat of seats) {
        const window = windows.get(seat.seatId) ?? { lines: [] };
        replies.push(await this.runSeat(record, host, seat, instruction, window));
      }
    } finally {
      record.roundsInFlight -= 1;
    }

    // Signalled AFTER the count drops, so an assembler that asks whether the
    // team is busy gets the answer this round's end actually created. And
    // signalled outside the caller's await path — the round is already
    // finished; whatever this starts must not make anyone wait for it.
    this.signalRoundEnded(record);
    return replies;
  }

  /**
   * What this seat sees this round, or nothing when no assembler is mounted.
   *
   * A failure is CARRIED rather than thrown: the windows are taken before the
   * round is recorded, so throwing here would abandon the round before
   * anything about it reached the log — a round that never happened, with no
   * trace of why. Carried, it surfaces inside the seat's own failure boundary
   * and lands in the record as that seat failing, which is both true and
   * findable.
   */
  private async contextFor(teamId: string, seatId: string): Promise<WindowAttempt> {
    if (this.assembler === undefined) return { lines: [] };
    try {
      return { lines: await this.assembler.windowFor(teamId, seatId) };
    } catch (error) {
      return { error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  /**
   * Run a confirmed agenda, phase by phase.
   *
   * The whole agenda counts as one stretch of work: `roundsInFlight` is held
   * for its duration, so an automatic fold cannot start between two phases
   * and record a boundary in the middle of something the host asked for as a
   * unit. The round-end signal fires once, at the end.
   */
  private async runAgenda(record: TeamRecord, agenda: AgendaSpec): Promise<AgendaOutcome> {
    if (record.disposed) throw new Error("团队已销毁。");
    const host = record.handle.agent;
    const replies: SeatReply[] = [];
    const phasesRun: string[] = [];
    const artifacts: string[] = [];
    let pausedAfter: string | undefined;

    record.roundsInFlight += 1;
    try {
      for (const phase of agenda.phases) {
        phasesRun.push(phase.title);
        // Taken once, before anything in the phase speaks. Every
        // `phase-start` run in this phase is handed this same snapshot, so
        // independence is a fact of what exists rather than a rule someone
        // has to keep obeying.
        const opening = new Map<string, WindowAttempt>();
        for (const task of phase.tasks) {
          if (!opening.has(task.seatId)) {
            opening.set(task.seatId, await this.contextFor(record.teamId, task.seatId));
          }
        }

        for (const run of planPhase(phase)) {
          const seat = record.input.seats.find((candidate) => candidate.seatId === run.task.seatId);
          if (seat === undefined) {
            // Vetting refuses this before confirmation, so reaching it means
            // the roster changed underneath a confirmed agenda. Recorded as a
            // failure rather than skipped: a task nobody ran and a seat with
            // nothing to say are the same silence.
            const text = `⚠️ 议程点名了不在名册上的席位「${run.task.seatId}」，本条未执行。`;
            recordSpoken(host, "系统", text);
            replies.push({ seatId: run.task.seatId, displayName: run.task.seatId, text, failed: true });
            continue;
          }

          const window =
            run.window === "phase-start"
              ? (opening.get(seat.seatId) ?? { lines: [] })
              : await this.contextFor(record.teamId, seat.seatId);

          recordSpoken(host, record.input.hostDisplayName, `（${phase.title}）${run.task.instruction}`);
          const reply = await this.runSeat(record, host, seat, run.task.instruction, window);
          replies.push(reply);

          const path = resolveArtifactPath(
            run.task.artifactPath === undefined ? undefined : { path: run.task.artifactPath },
            { seatId: seat.seatId, phaseId: `${phase.title}-${run.round}` },
            phase.tasks.filter((candidate) => candidate.artifactPath === run.task.artifactPath).length,
          );
          if (path !== undefined && !reply.failed) {
            await this.writeArtifact(record, path, reply.text);
            artifacts.push(path);
          }
        }

        if (pausesAfter(phase)) {
          pausedAfter = phase.title;
          break;
        }
      }
    } finally {
      record.roundsInFlight -= 1;
    }

    this.signalRoundEnded(record);
    return {
      replies,
      phasesRun,
      artifacts,
      ...(pausedAfter === undefined ? {} : { pausedAfter }),
    };
  }

  /**
   * Write one seat's answer to the file the host asked for.
   *
   * The program writes it, not the agent. A path an agent was merely told to
   * write to is a path it may or may not have written to, and the checkpoint's
   * index would then point at files that sometimes exist.
   */
  private async writeArtifact(record: TeamRecord, relative: string, text: string): Promise<void> {
    const absolute = join(record.input.projectFolder, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, text, "utf8");
    recordSpoken(record.handle.agent, "系统", `已写入 ${relative}`);
    // Told to the assembler as data, not left to be parsed back out of that
    // line. A checkpoint index rebuilt by reading the transcript would depend
    // on the wording of a log message never meant to be an interface.
    if (this.assembler !== undefined) {
      try {
        this.assembler.artifactWritten(record.teamId, relative);
      } catch (error) {
        this.ctx.logger.warn(
          `团队 ${record.teamId}：装配器的 artifactWritten 抛错：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Tell the assembler a round ended.
   *
   * A throwing assembler must not take the round's replies with it: the work
   * is done and recorded by this point, and losing it to a bookkeeping
   * failure would be the round disappearing for a reason unrelated to the
   * round. Reported, not propagated.
   */
  private signalRoundEnded(record: TeamRecord): void {
    if (this.assembler === undefined || record.disposed) return;
    try {
      this.assembler.roundEnded(record.teamId);
    } catch (error) {
      this.ctx.logger.warn(
        `团队 ${record.teamId}：装配器的 roundEnded 抛错：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async runSeat(
    record: TeamRecord,
    host: Agent,
    seat: SeatSpec,
    instruction: string,
    window: WindowAttempt,
  ): Promise<SeatReply> {
    const provider = PROVIDER_BY_BACKEND[seat.backend];
    try {
      // Rethrown inside the try, so a broken assembler becomes a visible
      // failed seat instead of a silently empty window. A seat handed nothing
      // answers confidently from nothing, which reads exactly like a seat that
      // was given the discussion and ignored it — the failure has to be louder
      // than its symptom.
      if (window.error !== undefined) throw window.error;
      const prompt = composeSeatPrompt({ seat, instruction, context: window.lines ?? [] });
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
      recordSpoken(host, seat.displayName, text);
      return { seatId: seat.seatId, displayName: seat.displayName, text, failed };
    } catch (error) {
      // A seat that could not run is reported, never silently skipped: a round
      // that quietly loses a member looks exactly like one where the member had
      // nothing to say.
      const detail = error instanceof Error ? error.message : String(error);
      const text = `⚠️ 该席位未能执行：${detail}`;
      recordSpoken(host, seat.displayName, text);
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

/** What one confirmed agenda did. */
export interface AgendaOutcome {
  readonly replies: readonly SeatReply[];
  /** Phases actually run, in order. A pause leaves the rest untouched. */
  readonly phasesRun: readonly string[];
  /**
   * Set when a phase handed control back to the host. The remaining phases
   * were NOT run — reported rather than silently skipped, because an agenda
   * that stopped early and an agenda that finished look identical from the
   * outside otherwise.
   */
  readonly pausedAfter?: string;
  /** Files written, project-relative. */
  readonly artifacts: readonly string[];
}

/** One seat's window for a round, or the failure that stopped it being built. */
interface WindowAttempt {
  readonly lines?: readonly string[];
  readonly error?: Error;
}

interface TeamRecord {
  readonly teamId: string;
  readonly input: CreateTeamInput;
  readonly handle: AgentHandle;
  /** Rounds currently running. Folding starts only at zero. */
  roundsInFlight: number;
  disposed: boolean;
}

/**
 * Write one line of the discussion into the team record.
 *
 * Appended to the host's log, never sent through its inbox. The inbox is how
 * an agent is given work: `followup` wakes it into a turn — which would put an
 * LLM in the chair — and `inject` parks the text until some later message
 * wakes it, so the record would lag the discussion and lose its tail entirely
 * when a team goes quiet. Both were tried; both were wrong.
 *
 * The host node runs no turns. Its log is the team's transcript, and what a
 * seat is shown next round is assembled from that log rather than from
 * anything queued on an agent.
 */
function recordSpoken(host: Agent, speaker: string, text: string): void {
  host.session.append(
    "user/message",
    {
      message: {
        id: `squad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        source: { kind: "host" },
        content: [{ type: "text", text: `【${speaker}】${text}` }],
      },
    } as never,
    // `SurfaceOp` is the literal 'append', not an object. Every
    // surface-eligible event must declare how it joins the ordered surface
    // that model history is derived from.
    { surfaceOp: "append" } as never,
  );
}

/**
 * Flatten the host session log into the shape assembly reads.
 *
 * Every event, in order. `user/message` carries the discussion and gets its
 * text; everything else travels with empty text so the assembler still sees
 * the kind — which is the point, because one of its tables exists to catch
 * kinds that prove the host node ran a turn.
 */
function transcriptOf(host: Agent): readonly TranscriptEvent[] {
  return host.session.events.map((event) => {
    const data = event.data as { message?: { id?: unknown; content?: unknown } } | undefined;
    const message = data?.message;
    const content = Array.isArray(message?.content) ? (message.content as ContentBlock[]) : undefined;
    return {
      kind: event.type,
      text: content === undefined ? "" : textOf(content),
      // The message id when there is one; otherwise the sequence number, which
      // is contiguous and unique by the log's own contract.
      turnId: typeof message?.id === "string" ? message.id : `seq-${event.seq}`,
    };
  });
}

const textOf = (blocks: readonly ContentBlock[]): string =>
  blocks
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block && typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("")
    .trim();
