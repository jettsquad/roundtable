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
import { existsSync, statSync } from "node:fs";
import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import type { SubagentStartRequest } from "@deepseek-ai/dsh-subagent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm/types";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Domain } from "@deepseek-ai/dsh-storage-domain";
import { SQUAD_TABLE_DOMAIN, type TeamPersisted } from "./domain.ts";
import {
  attachmentNote,
  materialsForRound,
  checkMaterial,
  type Material,
  EMPTY_TOTALS,
  capExceeded,
  providerForSeat,
  addUsage,
  resolveArtifactPath,
  stripReasoning,
  usageOfResult,
  type AgendaSpec,
  type SeatUsage,
  type UsageTotals,
} from "@squad/shared";
import { activityFor, activityKey, type SeatActivity } from "@squad/seat-runtime";
import { outstandingWork, pausesAfter, planPhase } from "./agenda.ts";
import { baseForFolder, recordForSession, restoreOrder, unclaimed } from "./sitting.ts";
import { checkRemoval, checkRoster, placeSeat, secretaryOf } from "./roster.ts";
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
  /**
   * How many lines of discussion this seat was handed.
   *
   * Reported because "the window was empty" and "the seat ignored a full
   * window" produce the same answer and are different failures. Every probe
   * in this project that could not tell them apart wasted a debugging pass
   * on plumbing that was already correct — so the plumbing states what it
   * delivered, and reading it is no longer an inference from what a model
   * chose to say.
   */
  readonly contextLines: number;
  /**
   * What this turn consumed, when the backend reported it.
   *
   * Absent rather than zeroed when the backend said nothing: a turn that
   * reported no accounting and a turn that cost nothing are different facts.
   */
  readonly usage?: SeatUsage | undefined;
}

export interface Team {
  readonly teamId: string;
  readonly displayName: string;
  readonly projectFolder: string;
  /** What the host is called in the record — the name `recordSpoken` writes. */
  readonly hostDisplayName: string;
  readonly seats: readonly SeatSpec[];
  /** The host node's session id — the team's durable record. */
  readonly hostSessionId: string;
  /** The dsh session this view belongs to. */
  readonly sessionId: string;
  /** The team this is a sitting of, or nothing when this IS the team. */
  readonly baseTeamId: string | undefined;
  /** A round is running right now; folding waits for this to clear. */
  readonly busy: boolean;
  /** Everything this team's seats have consumed so far. */
  readonly usage: UsageTotals;
  /** The seat doing judgement work for the host, when one is designated. */
  readonly secretary: SeatSpec | undefined;
  /** Which seats are speaking right now, and what they were last asked. */
  readonly seatStates: readonly SeatState[];
  /** Where a running agenda has got to, or nothing when none is running. */
  readonly progress: AgendaProgress | undefined;
  /**
   * An agenda the secretary drafted, waiting on this host.
   *
   * On the TEAM rather than in the surface that made it: the confirmation is
   * the decision this product exists to keep with a person, and a draft that
   * lived in one browser tab — or in one process's memory — is a decision
   * that can disappear without anybody deciding it.
   */
  readonly draft: { readonly agenda: AgendaSpec; readonly at: number; readonly fromTurnId?: string } | undefined;
  /**
   * Put a draft up for confirmation, or clear the one standing.
   *
   * `fromTurnId` is the secretary reply it was converted from. Carried so the
   * draft can be shown where it came from — a plan that appears at the top of
   * the page, far from the sentence that produced it, is a plan nobody reads
   * next to the reasoning behind it.
   */
  setDraft(draft: AgendaSpec | undefined, fromTurnId?: string): void;
  /** Background material every seat reads, oldest first. */
  readonly materials: readonly Material[];
  /** Attach one document. Refused for the reasons `checkMaterial` names. */
  addMaterial(material: Material): void;
  /** Detach one. The seats stop seeing it from the next round. */
  removeMaterial(materialId: string): void;
  /**
   * Make one document travel with every round, or stop it doing so.
   *
   * For the charter a team should always have in front of it. Off by default,
   * because the common case is a document imported so one seat can read it
   * once.
   */
  setMaterialPinned(materialId: string, pinned: boolean): void;
  /**
   * Add a seat. Refused while a round is running — see `addSeat`.
   *
   * `at` puts it back at a given position instead of the end. Seat order is
   * speaking order in a round, so an edit that re-appends a seat also changes
   * who speaks first — a caller that is editing a seat in place passes its
   * old index to say the order did not change.
   */
  addSeat(seat: SeatSpec, options?: { readonly at?: number }): void;
  /** Remove a seat. The secretary needs `confirmSecretary`. */
  removeSeat(seatId: string, options?: { readonly confirmSecretary?: boolean }): void;
  /**
   * Rename the team.
   *
   * Needed because a name is chosen before the work exists: a team called
   * 「真实流程验证」 that turned into the place a real project is planned
   * cannot be fixed by deleting it — the discussion is in there.
   */
  rename(displayName: string): void;
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
  /**
   * Ask the named seats (or all of them) and return what they said.
   *
   * `materialIds` are the documents attached to THIS round. Pinned ones come
   * along regardless; nothing else does. Carrying every imported document on
   * every round is what made 「传一份文件让某个 agent 总结一次」 cost that
   * file on every later turn of every seat.
   */
  ask(
    instruction: string,
    seatIds?: readonly string[],
    quotes?: readonly { readonly speaker: string; readonly text: string }[],
    materialIds?: readonly string[],
  ): Promise<readonly SeatReply[]>;
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
   * Stop the running agenda and return the material for its hand-off.
   *
   * Material, not the document. The table knows what ran and what did not;
   * turning that into prose is judgement, and judgement is the secretary's.
   * Splitting it this way also means stopping never depends on a model being
   * reachable — the agenda halts whether or not anything is later written up.
   */
  stopAgenda(reason: string): AgendaTermination;
  /**
   * Stop whatever is running — an agenda, or a plain round.
   *
   * `undefined` when it was a round: a round has no termination document, and
   * an empty one would be a hand-off nobody wrote.
   */
  stop(reason: string): AgendaTermination | undefined;
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
  /**
   * Append one line to the team record directly.
   *
   * For replaying a history that already happened — the 1.x migration — where
   * the turns are facts to be restored rather than work to be done. A live
   * round never uses this: it goes through `ask`, which assembles windows,
   * runs seats and records what they actually said.
   *
   * `turnId` is preservable because a migrated checkpoint's `coversUpTo`
   * points at a 1.x turn id. Regenerating ids here would leave every carried
   * checkpoint covering a boundary that no longer exists, and the merge layer
   * would read them as checkpoints whose coverage is missing from the log.
   */
  recordSpoken(speaker: string, text: string, turnId?: string): void;
  dispose(): Promise<void>;
}

/** Whether one seat is speaking right now. */
export interface SeatState {
  readonly seatId: string;
  readonly displayName: string;
  readonly running: boolean;
  /** What it is answering, while it is answering. */
  readonly instruction?: string | undefined;
  /**
   * How the run is actually going, while it is going.
   *
   * `running: true` says a promise has not settled; it cannot tell a seat
   * that is thinking from one wedged against an endpoint that will never
   * answer. This is the difference: bytes produced, and when the last of them
   * arrived. Present only for a backend that reports it (all three CLI ones
   * do) and only while the child lives.
   */
  readonly activity?: SeatActivity | undefined;
}

/**
 * Where a running agenda has got to.
 *
 * Reported while it runs, not only afterwards. An agenda that takes minutes
 * and says nothing until it finishes is indistinguishable from one that hung,
 * and the difference matters most exactly when someone is deciding whether to
 * stop it.
 */
export interface AgendaProgress {
  readonly phase: string;
  /** 1-based, so it reads the way a person counts. */
  readonly phaseIndex: number;
  readonly phaseCount: number;
  readonly completedPhases: number;
}

/** One recorded event of a team, in the flat shape assembly reads. */
export interface TranscriptEvent {
  /** The dsh event type verbatim — `user/message`, `turn/start`, … */
  readonly kind: string;
  /** Text carried by the event, or empty for the ones that carry none. */
  readonly text: string;
  /** Stable identity of this entry, used to cut windows at a checkpoint. */
  readonly turnId: string;
  /**
   * When the log recorded it, in Unix epoch milliseconds.
   *
   * From the session event's own `time`, not stamped on read: a transcript
   * restored from disk must show when a thing was SAID, not when the page
   * was opened.
   */
  readonly at: number;
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

export class TeamsService extends Service {
  static readonly inject = ["agents", "subagents", "seatConnections", "storageDomain"];

  private readonly teams = new Map<string, TeamRecord>();
  private assembler: TeamAssembler | undefined;
  private domain: Domain<typeof SQUAD_TABLE_DOMAIN> | undefined;
  /** Serialises writes so two edits in one tick cannot lose one another. */
  private writes: Promise<void> = Promise.resolve();

  constructor(ctx: Context) {
    super(ctx, "teams");
  }

  /**
   * Open the store and put every saved team back.
   *
   * The host node is RESUMED, not created: its session id is the team id, and
   * resuming loads the persisted log — so the discussion comes back with the
   * team rather than the team coming back mute.
   *
   * A team that cannot be restored is reported and skipped, never dropped
   * silently. Its folder is still in the sidebar either way, and a workspace
   * whose team quietly failed to load is indistinguishable from one that
   * never had a team — which is precisely the confusion this whole section
   * exists to end.
   */
  async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(SQUAD_TABLE_DOMAIN);
    this.domain = domain;
    this.ctx.effect(() => async () => {
      this.domain = undefined;
      await domain.close();
    });

    // Mark a team's sessions AT CREATION, which is the only moment that
    // reaches the client's mirror.
    //
    // `session/created` fires during publication, before the summary that the
    // sidebar mirrors is built — so the session is already non-blank when the
    // client first hears of it. Marking any later is invisible: the row shows
    // until you click away, disappears, comes back on reload, and is reused
    // by the next 新建会话 as if it had never existed.
    //
    // Wrapped, because a throw here VETOES the session. Nothing about a
    // sidebar label is worth refusing to create somebody's session over.
    this.ctx.on(
      "session/created" as never,
      ((session: LiveSession) => {
        try {
          // Our own host nodes are sessions too, and they are not places a
          // person works. They are named by us, which is how they are told
          // apart from a session dsh opened for the user.
          if (session.id.startsWith("team-") || session.id.startsWith("sit-")) return;
          const cwd = session.header.cwd;
          if (cwd === undefined) return;
          const base = baseForFolder(
            [...this.teams.values()].map((record) => ({ ...record, projectFolder: record.input.projectFolder })),
            cwd,
          );
          if (base === undefined) return;
          this.markLiveSession(session, base.input.displayName);
        } catch (error) {
          this.ctx.logger.warn(`标记会话失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }) as never,
    );

    // Restoring happens AFTER init returns, not inside it.
    //
    // `Service.init` is on the boot path, and boot asserts that every entry
    // activated within a deadline. Each saved record costs an
    // `agents.resume`, so a table with a handful of sittings took longer than
    // that window — `teams` had not published yet, and the whole tree failed
    // with 「@squad/context: pending (waiting for service: teams)」, naming
    // everything except the cause. Nothing about restoring a team belongs on
    // the critical path of the process starting.
    //
    // What this costs: for a moment after boot, a team exists on disk and not
    // in `get()`. Every surface polls, so it appears; and a team that is
    // slow to come back is visibly absent rather than invisibly blocking.
    void this.restoreAll(domain).catch((error: unknown) => {
      this.ctx.logger.warn(`恢复团队时出错：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Bring every saved team back, one at a time, off the boot path. */
  private async restoreAll(domain: Domain<typeof SQUAD_TABLE_DOMAIN>): Promise<void> {
    // Bases first, then sittings. A sitting shares its base's roster BY
    // REFERENCE, so restoring one before its base has nothing to point at —
    // and the map's iteration order is insertion order on disk, which says
    // nothing about which is which.
    const saved = [...domain.table("teams").entries()].map(([, row]) => row);
    for (const row of restoreOrder(saved)) {
      try {
        // Bounded. `agents.resume` reads a session log, and one that never
        // settles takes the whole boot with it: `Service.init` never returns,
        // the service never publishes, and every plugin that injects `teams`
        // sits pending behind an error that names none of this. It happened
        // here — a table with five saved records simply stopped starting.
        //
        // A team that cannot be restored is reported and skipped, which is
        // what the comment above always claimed; a hang is the one failure
        // that claim did not actually cover.
        await withTimeout(this.restore(row), RESTORE_TIMEOUT_MS, `恢复超时（${RESTORE_TIMEOUT_MS / 1000} 秒）`);
      } catch (error) {
        this.ctx.logger.warn(
          `团队「${row.displayName}」没能恢复：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** Rebuild one saved team, log and all. */
  private async restore(saved: TeamPersisted): Promise<void> {
    const handle = await this.ctx.agents.resume({ resumeSessionId: saved.teamId as never });
    // A sitting takes its base's LIVE objects. Rebuilding them from its own
    // saved copy would give one team two rosters that drift apart the moment
    // a member is added in the other session.
    const base = saved.baseTeamId === undefined ? undefined : this.teams.get(saved.baseTeamId);
    if (saved.baseTeamId !== undefined && base === undefined) {
      throw new Error(`这场会话的团队 ${saved.baseTeamId} 不在了。`);
    }
    const input: CreateTeamInput = base?.input ?? {
      displayName: saved.displayName,
      projectFolder: saved.projectFolder,
      hostDisplayName: saved.hostDisplayName,
      seats: saved.seats as unknown as readonly SeatSpec[],
      ...(saved.checkpointCoefficient === undefined ? {} : { checkpointCoefficient: saved.checkpointCoefficient }),
    };
    this.teams.set(saved.teamId, {
      teamId: saved.teamId,
      sessionId: saved.sessionId ?? saved.teamId,
      baseTeamId: saved.baseTeamId,
      input,
      handle,
      roundsInFlight: 0,
      running: undefined,
      roundAbort: undefined,
      artifacts: [],
      // Carried across the restart: it is the user's money, and a total that
      // resets to zero only ever says "cheap".
      usage: saved.usage ?? EMPTY_TOTALS,
      perSeat: new Map(),
      authModes: new Map(),
      seats: base?.seats ?? [...input.seats],
      speaking: new Map(),
      draft:
        saved.draft === undefined
          ? undefined
          : {
              agenda: saved.draft,
              at: saved.draftedAt ?? Date.now(),
              ...(saved.draftFromTurnId === undefined ? {} : { fromTurnId: saved.draftFromTurnId }),
            },
      // The base's own array when this is a sitting: material is the team's,
      // and copying it would let one session's import be invisible in another.
      materials: base?.materials ?? [...(saved.materials ?? [])],
      disposed: false,
    });
  }

  /**
   * Write one team down.
   *
   * Chained rather than awaited by callers: a seat edit and a round's usage
   * update can land in the same tick, and two read-modify-writes racing on
   * one key lose whichever finished first.
   */
  private persist(record: TeamRecord): void {
    const table = this.domain?.table("teams");
    if (table === undefined) return;
    const existing = table.get(record.teamId);
    const row: TeamPersisted = {
      teamId: record.teamId,
      ...(record.sessionId === record.teamId ? {} : { sessionId: record.sessionId }),
      ...(record.baseTeamId === undefined ? {} : { baseTeamId: record.baseTeamId }),
      displayName: record.input.displayName,
      projectFolder: record.input.projectFolder,
      hostDisplayName: record.input.hostDisplayName,
      ...(record.input.checkpointCoefficient === undefined
        ? {}
        : { checkpointCoefficient: record.input.checkpointCoefficient }),
      seats: record.seats as unknown as TeamPersisted["seats"],
      usage: record.usage,
      ...(record.draft === undefined
        ? {}
        : {
            draft: record.draft.agenda,
            draftedAt: record.draft.at,
            ...(record.draft.fromTurnId === undefined ? {} : { draftFromTurnId: record.draft.fromTurnId }),
          }),
      ...(record.materials.length === 0 ? {} : { materials: record.materials }),
      createdAt: existing?.createdAt ?? Date.now(),
    };
    this.writes = this.writes.then(async () => {
      await table.put(record.teamId, row);
    });
  }

  private forget(teamId: string): void {
    const table = this.domain?.table("teams");
    if (table === undefined) return;
    this.writes = this.writes.then(async () => {
      await table.delete(teamId);
    });
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
    const problems = checkRoster(input.seats);
    if (problems.length > 0) throw new Error(problems.map((problem) => problem.detail).join("\n"));

    // The project folder has to EXIST. Every seat runs with it as its working
    // directory, so a folder that is not there means every round of this
    // team's life fails at process spawn — and the error names a directory,
    // not the team that was built on it. Checked here rather than left to the
    // workspace registry, because a composition without one would otherwise
    // skip the check entirely.
    if (!existsSync(input.projectFolder) || !statSync(input.projectFolder).isDirectory()) {
      throw new Error(`项目文件夹不存在，或者不是个目录：${input.projectFolder}`);
    }
    const teamId = `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // The team's folder becomes a workspace, named after the team.
    //
    // A team IS a place you work — a directory plus everything done in it —
    // which is what a dsh workspace already is. Registering it here rather
    // than in a surface means every team gets one however it was created, and
    // the sidebar stops being a list that does not know teams exist.
    //
    // Registration also CANONICALISES the folder: `create` resolves symlinks
    // and `..`, and on macOS `/tmp/x` is really `/private/tmp/x`. Workspace
    // membership is decided by comparing a session's cwd against that
    // canonical path, so a team whose own folder stayed uncanonical could
    // never have a session accepted into its own workspace. The team keeps
    // the canonical spelling from here on.
    const projectFolder = (await this.registerWorkspace(input.projectFolder, input.displayName)) ?? input.projectFolder;

    // The host node. Its cwd is the team's project folder, which every seat
    // inherits — one team, one working directory.
    const handle = await this.ctx.agents.create({
      sessionId: teamId as never,
      meta: { cwd: projectFolder },
    });

    const record: TeamRecord = {
      teamId,
      sessionId: teamId,
      baseTeamId: undefined,
      input: { ...input, projectFolder },
      handle,
      roundsInFlight: 0,
      running: undefined,
      roundAbort: undefined,
      artifacts: [],
      usage: EMPTY_TOTALS,
      perSeat: new Map(),
      authModes: new Map(),
      seats: [...input.seats],
      speaking: new Map(),
      draft: undefined,
      materials: [],
      disposed: false,
    };
    this.teams.set(teamId, record);
    this.persist(record);
    return this.viewOf(record);
  }

  /**
   * Put this team's folder in the workspace registry, and answer its
   * canonical path.
   *
   * `ctx.reflect.get` rather than an `inject` entry: the registry is an app
   * layer service, and a composition without it — the smoke profile stacks
   * `dsh-base` alone — would leave this plugin WAITING for a dependency that
   * is never coming. A team that cannot be listed in a sidebar is a smaller
   * problem than a table that never starts.
   *
   * A failure is reported and swallowed for the same reason: the sidebar is
   * not what a team is for, and refusing to create one because it could not
   * be filed would be the tail wagging the dog.
   */
  private async registerWorkspace(path: string, title: string): Promise<string | undefined> {
    const registry = this.ctx.reflect.get("workspaceRegistry") as
      { create(path: string, title?: string): Promise<{ path: string }> } | undefined;
    if (registry === undefined) return undefined;
    try {
      return (await registry.create(path, title)).path;
    } catch (error) {
      // Warned, not thrown, and named: a folder that does not exist is the
      // usual cause and the person who typed it needs to hear so.
      this.ctx.logger?.warn?.(
        `团队「${title}」没能登记成 workspace：${error instanceof Error ? error.message : error}`,
      );
      return undefined;
    }
  }

  get(teamId: string): Team | undefined {
    const record = this.teams.get(teamId);
    return record === undefined || record.disposed ? undefined : this.viewOf(record);
  }

  /**
   * The team record that serves one dsh session — creating it if this is the
   * first time that session has been used.
   *
   * A team's folder is a workspace and a workspace holds many sessions. Until
   * this existed, every session in the folder pointed at the SAME record: a
   * new session opened onto the old discussion, and whatever you typed in it
   * appeared over in the old one. That is not a second view of one meeting,
   * it is two doors into the same room, and the sidebar promised otherwise.
   *
   * What a sitting shares with its team is the ROSTER, the folder and the
   * name. What it does not share is the discussion, the context, the
   * checkpoints and the usage — so the seats arrive with no memory of the
   * other session, which is exactly what 「重新听我的命令开始新的工作」 means.
   */
  async sittingFor(input: { readonly projectFolder: string; readonly sessionId: string }): Promise<Team | undefined> {
    const records = [...this.teams.values()];
    const existing = recordForSession(records, input.sessionId);
    if (existing !== undefined) {
      // Marked here too. The session may be one dsh reused after discarding
      // its events, and an unmarked session disappears on reload whether or
      // not we have a record for it.
      this.markSession(input.sessionId, existing.input.displayName);
      return this.viewOf(existing);
    }

    // The base is found by FOLDER, the same comparison the surfaces make.
    const base = baseForFolder(
      records.map((record) => ({ ...record, projectFolder: record.input.projectFolder })),
      input.projectFolder,
    );
    if (base === undefined) return undefined;
    // The first session in the workspace adopts the team itself. See
    // `unclaimed`: a team is created before anyone sits down at it, and
    // starting a second empty sitting next to its own discussion would hide
    // that discussion from the only place people look for it.
    const owner = this.teams.get(base.teamId);
    if (owner !== undefined && unclaimed(owner)) {
      owner.sessionId = input.sessionId;
      this.persist(owner);
      this.markSession(input.sessionId, owner.input.displayName);
      return this.viewOf(owner);
    }

    const sittingId = `sit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // Its own host node, with its own session log. That log IS the fresh
    // discussion — nothing carries over, because nothing is shared to carry.
    const handle = await this.ctx.agents.create({
      sessionId: sittingId as never,
      meta: { cwd: base.input.projectFolder },
    });
    const record: TeamRecord = {
      teamId: sittingId,
      sessionId: input.sessionId,
      baseTeamId: base.teamId,
      // The base's own objects, on purpose. See `TeamRecord.baseTeamId`.
      input: base.input,
      handle,
      roundsInFlight: 0,
      running: undefined,
      roundAbort: undefined,
      artifacts: [],
      // Usage starts at zero and stays this sitting's own: a new piece of
      // work has its own cost, and rolling it into the team's total would
      // make every per-session number unanswerable.
      usage: EMPTY_TOTALS,
      perSeat: new Map(),
      authModes: new Map(),
      seats: base.seats,
      speaking: new Map(),
      draft: undefined,
      materials: base.materials,
      disposed: false,
    };
    this.teams.set(sittingId, record);
    this.persist(record);
    this.markSession(input.sessionId, base.input.displayName);
    return this.viewOf(record);
  }

  /**
   * Put one line into the dsh session, so it survives being closed.
   *
   * A session with no events is not shown in the sidebar. Ours never got any:
   * the team's discussion lives in the sitting's own host log, on purpose, so
   * the chat model does not read a meeting it was not in. The result was a
   * session that worked perfectly until you reloaded, and then was simply not
   * there — with its sitting still on disk and no longer reachable from
   * anywhere. That is the report 「并且删除新 session」.
   *
   * So: exactly one line, and one that earns its place by saying where the
   * discussion is. It does become part of what dsh's own chat agent would
   * read in this session, which is the honest cost of the session being real
   * — and one sentence of explanation is a defensible thing for it to find.
   *
   * Best-effort: a session that is not live right now cannot be marked, and
   * refusing to open a sitting over a sidebar label would be the tail wagging
   * the dog.
   */
  private markSession(sessionId: string, teamName: string): void {
    // `ctx.reflect.get` rather than an `inject` entry, for the same reason
    // the workspace registry uses it: injecting a service this plugin can
    // work without means WAITING for it forever in a composition that does
    // not provide it at this scope. Listing `sessions` in `inject` did
    // exactly that — the table never started, and everything that injects
    // `teams` sat pending behind it with no error naming the cause.
    const sessions = this.ctx.reflect.get("sessions") as { get(id: string): LiveSession | undefined } | undefined;
    const session = sessions?.get(sessionId);
    if (session !== undefined) this.markLiveSession(session, teamName);
  }

  /**
   * Write the marker into a session that is already in hand.
   *
   * Separate from `markSession` because the ONE moment that matters is
   * `session/created`, where the session object exists and the store does not
   * hold it yet. Marking later worked on disk and did not work on screen: the
   * client mirrors a session's `blank` bit from the summary it received when
   * the session appeared, and an append made afterwards never updated that
   * mirror — so the row vanished the moment you clicked another session, came
   * back on reload, and got handed out again by the next 新建会话.
   */
  private markLiveSession(session: LiveSession, teamName: string): void {
    try {
      // Decided from the SESSION's own state, not from "we just made a
      // record". The first version marked only on creation, and dsh reuses an
      // unused session when you click 新建会话 — so the second time round the
      // sitting already existed, no mark was written, and the session went on
      // vanishing exactly as before. Asking whether this session already has
      // a message is the question that actually matters, and it makes the
      // call idempotent from every path.
      // dsh's own rule, read from its source rather than guessed: a session
      // with no `turn/start` is BLANK — hidden from the list and reusable by
      // the next 新建会话. A `user/message` does not count, which is why the
      // first version of this mark did not stop the session from vanishing.
      const used = session.events.some((event) => event.type === "turn/start");
      if (used) return;
      // Plain, with no 【speaker】 wrapper. The sidebar titles a session after
      // its first message, so this line IS the name of the session from now
      // on — 「【系统】这个会话在团队…」 read like a log entry where a name
      // belongs.
      // A turn, opened and closed around one message. The turn boundary is
      // what makes the session real to dsh; the message is what makes it
      // legible to a person, and the sidebar titles the session from it.
      //
      // Claiming a turn ran is a claim, and it is a true one from where the
      // person stands: this session is where their team works. What it is
      // NOT is a dsh model loop, so nothing here pretends an assistant
      // answered — the turn opens, one user line is recorded, and it closes
      // as completed.
      session.append("turn/start", { turn: 0 } as never);
      session.append(
        "user/message",
        {
          id: `squad-mark-${Date.now().toString(36)}`,
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: `团队「${teamName}」的新一场工作。讨论在「团队」标签页。` }],
        } as never,
        { surfaceOp: "append" } as never,
      );
      session.append("turn/end", { turn: 0, reason: { kind: "completed" } } as never);
    } catch (error) {
      this.ctx.logger?.warn?.(`没能给会话留下标记：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Every sitting of one team, base excluded. */
  private sittingsOf(teamId: string): readonly TeamRecord[] {
    return [...this.teams.values()].filter((record) => record.baseTeamId === teamId);
  }

  /** The base of whatever record this is — itself, when it is one. */
  private baseOf(record: TeamRecord): TeamRecord {
    return record.baseTeamId === undefined ? record : (this.teams.get(record.baseTeamId) ?? record);
  }

  /**
   * A team and every sitting of it.
   *
   * Anything shared — the name, the folder, the roster — has to be written
   * down for all of them. They hold the same objects in memory, so a change
   * is instantly visible everywhere; only the DISK would disagree, and it is
   * the disk that decides what exists after a restart.
   */
  private family(record: TeamRecord): readonly TeamRecord[] {
    const base = this.baseOf(record);
    return [base, ...this.sittingsOf(base.teamId)];
  }

  /** Write the team and all its sittings down. */
  private persistFamily(record: TeamRecord): void {
    for (const member of this.family(record)) this.persist(member);
  }

  list(): readonly string[] {
    return [...this.teams.values()].filter((r) => !r.disposed).map((r) => r.teamId);
  }

  private viewOf(record: TeamRecord): Team {
    return {
      teamId: record.teamId,
      displayName: record.input.displayName,
      projectFolder: record.input.projectFolder,
      hostDisplayName: record.input.hostDisplayName,
      seats: record.seats,
      hostSessionId: String(record.handle.agent.session.id),
      sessionId: record.sessionId,
      baseTeamId: record.baseTeamId,
      host: record.handle.agent,
      // Read through the record, not captured: a view handed out before a
      // round started must not keep reporting the team as idle.
      get busy() {
        return record.roundsInFlight > 0;
      },
      // Read through the record, not captured: a view handed out before a
      // round must not keep reporting the total as it was then.
      get usage() {
        return record.usage;
      },
      get secretary() {
        return secretaryOf(record.seats);
      },
      get seatStates() {
        const session = String(record.handle.agent.session.id);
        return record.seats.map((seat) => {
          const instruction = record.speaking.get(seat.seatId);
          if (instruction === undefined) return { seatId: seat.seatId, displayName: seat.displayName, running: false };
          // Addressed by the same label the request carried — `runSeat` sends
          // `label: seat.displayName` — so this asks the backend what it is
          // doing rather than guessing from what we asked it to do.
          const activity = activityFor(activityKey(session, seat.displayName));
          return {
            seatId: seat.seatId,
            displayName: seat.displayName,
            running: true,
            instruction,
            ...(activity === undefined ? {} : { activity }),
          };
        });
      },
      get progress() {
        return record.running === undefined ? undefined : record.running.progress;
      },
      get draft() {
        return record.draft;
      },
      setDraft: (draft, fromTurnId) => {
        record.draft =
          draft === undefined
            ? undefined
            : { agenda: draft, at: Date.now(), ...(fromTurnId === undefined ? {} : { fromTurnId }) };
        this.persist(record);
      },
      get materials() {
        return record.materials;
      },
      addMaterial: (material) => {
        const problem = checkMaterial(material, record.materials);
        if (problem !== undefined) throw new Error(problem.detail);
        // In place: sittings hold the same array, and replacing it would give
        // the team two lists that drift apart.
        record.materials.push(material);
        this.persistFamily(record);
      },
      setMaterialPinned: (materialId, pinned) => {
        const at = record.materials.findIndex((material) => material.materialId === materialId);
        if (at < 0) throw new Error("没有这份资料。");
        const current = record.materials[at] as Material;
        // In place: sittings share the array, and replacing it would give the
        // team two lists that drift apart.
        record.materials.splice(at, 1, { ...current, pinned });
        this.persistFamily(record);
      },
      removeMaterial: (materialId) => {
        const at = record.materials.findIndex((material) => material.materialId === materialId);
        if (at < 0) throw new Error("没有这份资料。");
        record.materials.splice(at, 1);
        this.persistFamily(record);
      },
      addSeat: (seat, options) => this.addSeat(record, seat, options),
      removeSeat: (seatId, options) => this.removeSeat(record, seatId, options),
      rename: (displayName) => this.rename(record, displayName),
      checkpointCoefficient: record.input.checkpointCoefficient,
      ask: (instruction, seatIds, quotes, materialIds) => this.ask(record, instruction, seatIds, quotes, materialIds),
      transcript: () => transcriptOf(record.handle.agent),
      recordSpoken: (speaker, text, turnId) => recordSpoken(record.handle.agent, speaker, text, turnId),
      runAgenda: (agenda) => this.runAgenda(record, agenda),
      stopAgenda: (reason) => this.stopAgenda(record, reason),
      stop: (reason) => this.stop(record, reason),
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
    quotes?: readonly { readonly speaker: string; readonly text: string }[],
    materialIds?: readonly string[],
  ): Promise<readonly SeatReply[]> {
    if (record.disposed) throw new Error("团队已销毁。");
    // One round at a time. Two rounds on one table interleave their
    // instructions and replies into a single log — the record then shows two
    // 「主持人」 lines in a row with nobody having answered either — and the
    // second round's abort controller replaces the first's, so 「叫停」 stops
    // only whichever started last. `runAgenda` had this guard from the start;
    // a plain round never did.
    if (record.running !== undefined) throw new Error("这支团队正在跑议程，等它结束或者叫停。");
    if (record.roundsInFlight > 0) throw new Error("上一轮还没结束。等它答完，或者按「叫停」。");
    const seats =
      seatIds === undefined || seatIds.length === 0
        ? record.seats
        : record.seats.filter((seat) => seatIds.includes(seat.seatId));
    if (seats.length === 0) throw new Error("点名的席位都不在这支团队里。");

    const host = record.handle.agent;

    // Windows are taken BEFORE the instruction is recorded. The instruction
    // reaches a seat as 「本轮指令」; a seat that then also finds the same
    // sentence inside the carried discussion is reading it twice and has to
    // guess which copy it is answering. The snapshot is also what
    // `contextMode: independent` means — every seat sees the discussion as it
    // stood when the round opened, not as the seats ahead of it left it.
    // (Cumulative mode will need this taken per seat, mid-loop, instead.)
    this.refreshAuthModes(record);
    const windows = new Map<string, WindowAttempt>();
    for (const seat of seats) {
      windows.set(seat.seatId, await this.contextFor(record.teamId, seat.seatId));
    }

    // Decided once for the whole round, so every seat in it sees the same
    // documents — a round where the first seat read the spec and the second
    // did not would produce two answers nobody can compare.
    const materials = materialsForRound(record.materials, materialIds);
    const note = attachmentNote(materials);
    recordSpoken(host, record.input.hostDisplayName, note === undefined ? instruction : `${instruction}\n${note}`);

    const replies: SeatReply[] = [];
    // A plain round is cancellable too. It was not: `stop` only reached a
    // running AGENDA, so 「叫停」 during an ordinary round threw 「这支团队现在
    // 没有在跑议程」 — and the button swallowed it, which is why it looked
    // like nothing happened at all.
    const abort = new AbortController();
    record.roundAbort = abort;
    record.roundsInFlight += 1;
    try {
      for (const seat of seats) {
        if (abort.signal.aborted) break;
        const window = windows.get(seat.seatId) ?? { lines: [] };
        replies.push(await this.runSeat(record, host, seat, instruction, window, abort.signal, quotes, materials));
      }
    } finally {
      record.roundsInFlight -= 1;
      record.roundAbort = undefined;
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
    if (record.running !== undefined) throw new Error("这支团队已经在跑一个议程了。");
    const host = record.handle.agent;
    const replies: SeatReply[] = [];
    const artifacts: string[] = [];
    let pausedAfter: string | undefined;

    const running: RunningAgenda = {
      agenda,
      abort: new AbortController(),
      completedPhases: [],
      completedTasks: [],
      reason: undefined,
      progress: {
        phase: agenda.phases[0]?.title ?? "",
        phaseIndex: 1,
        phaseCount: agenda.phases.length,
        completedPhases: 0,
      },
    };
    record.running = running;
    this.refreshAuthModes(record);
    record.roundsInFlight += 1;
    try {
      for (const [phaseIndex, phase] of agenda.phases.entries()) {
        running.progress = {
          phase: phase.title,
          phaseIndex: phaseIndex + 1,
          phaseCount: agenda.phases.length,
          completedPhases: running.completedPhases.length,
        };
        // Taken once, before anything in the phase speaks. Every
        // `phase-start` run in this phase is handed this same snapshot, so
        // independence is a fact of what exists rather than a rule someone
        // has to keep obeying.
        //
        // Only for the seats that will actually be handed it. A phase where
        // every run takes a fresh window used to assemble an opening snapshot
        // per seat and then discard all of them — work whose only visible
        // effect was making the logs of a cumulative phase look like an
        // independent one.
        const runs = planPhase(phase);
        const opening = new Map<string, WindowAttempt>();
        for (const run of runs) {
          if (run.window === "phase-start" && !opening.has(run.task.seatId)) {
            opening.set(run.task.seatId, await this.contextFor(record.teamId, run.task.seatId));
          }
        }

        for (const run of runs) {
          // Checked between runs, so a stop lands at a task boundary rather
          // than halfway through one. The seat already running when the host
          // stopped is cancelled through the same signal.
          if (running.abort.signal.aborted) break;
          const seat = record.seats.find((candidate) => candidate.seatId === run.task.seatId);
          if (seat === undefined) {
            // Vetting refuses this before confirmation, so reaching it means
            // the roster changed underneath a confirmed agenda. Recorded as a
            // failure rather than skipped: a task nobody ran and a seat with
            // nothing to say are the same silence.
            const text = `⚠️ 议程点名了不在名册上的席位「${run.task.seatId}」，本条未执行。`;
            recordSpoken(host, "系统", text);
            replies.push({
              seatId: run.task.seatId,
              displayName: run.task.seatId,
              text,
              failed: true,
              contextLines: 0,
            });
            continue;
          }

          const window =
            run.window === "phase-start"
              ? (opening.get(seat.seatId) ?? { lines: [] })
              : await this.contextFor(record.teamId, seat.seatId);

          recordSpoken(host, record.input.hostDisplayName, `（${phase.title}）${run.task.instruction}`);
          const reply = await this.runSeat(record, host, seat, run.task.instruction, window, running.abort.signal);
          replies.push(reply);
          if (!reply.failed) running.completedTasks.push(run.task.instruction);

          const path = resolveArtifactPath(
            run.task.artifactPath === undefined ? undefined : { path: run.task.artifactPath },
            { seatId: seat.seatId, phaseId: `${phase.title}-${run.round}` },
            phase.tasks.filter((candidate) => candidate.artifactPath === run.task.artifactPath).length,
          );
          if (path !== undefined && !reply.failed) {
            await this.writeArtifact(record, path, reply.text);
            artifacts.push(path);
            record.artifacts.push(path);
          }
        }

        if (running.abort.signal.aborted) break;
        // Counted complete only after every run in it finished. A phase the
        // stop cut through is not done, and calling it done would put its
        // unfinished tasks in neither list.
        running.completedPhases.push(phase.title);

        if (pausesAfter(phase)) {
          pausedAfter = phase.title;
          break;
        }
      }
    } finally {
      record.roundsInFlight -= 1;
      record.running = undefined;
    }

    this.signalRoundEnded(record);
    return {
      replies,
      ...(running.reason === undefined ? {} : { stoppedBecause: running.reason }),
      phasesRun: running.completedPhases,
      artifacts,
      ...(pausedAfter === undefined ? {} : { pausedAfter }),
    };
  }

  /**
   * Stop the running agenda.
   *
   * Synchronous and side-effect-light on purpose: it aborts and reports, and
   * nothing about stopping waits on a model. The running loop notices the
   * abort between runs, and any seat mid-answer is cancelled through the same
   * signal rather than being left to finish into a discussion nobody is
   * having any more.
   */
  /**
   * Stop whatever this team is doing.
   *
   * An agenda when one is running, otherwise the round in flight. Two things
   * can be stopped and only one of them could be, which made the button a
   * coin flip: during an agenda it worked, during an ordinary round it threw.
   *
   * Returns `undefined` when a plain round was stopped — there is no
   * termination document for a round, and inventing an empty one would put a
   * hand-off in the record that nobody wrote.
   */
  private stop(record: TeamRecord, reason: string): AgendaTermination | undefined {
    if (record.running !== undefined) return this.stopAgenda(record, reason);
    const abort = record.roundAbort;
    if (abort === undefined) throw new Error("这支团队现在没有在跑任何东西。");
    abort.abort(new Error(`已叫停：${reason}`));
    recordSpoken(record.handle.agent, "系统", `⏹ 主持人叫停了这一轮：${reason}`);
    return undefined;
  }

  private stopAgenda(record: TeamRecord, reason: string): AgendaTermination {
    const running = record.running;
    if (running === undefined) throw new Error("这支团队现在没有在跑议程。");
    running.reason = reason;
    running.abort.abort(new Error(`议程已中止：${reason}`));

    return {
      objective: running.agenda.hostGoal ?? record.input.displayName,
      reason,
      completed: [...running.completedTasks],
      remaining: outstandingWork(running.agenda, running.completedPhases, running.completedTasks),
      artifacts: [...record.artifacts],
      discussion: transcriptOf(record.handle.agent)
        .filter((entry) => entry.kind === "user/message" && entry.text.length > 0)
        .map((entry) => entry.text),
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
   * Add a seat.
   *
   * Refused while a round is running: the windows for that round were already
   * taken, so a seat arriving mid-round would either be skipped (looking like
   * it had nothing to say) or handed a window nobody else got. Neither is a
   * state worth being able to reach.
   */
  private addSeat(record: TeamRecord, seat: SeatSpec, options?: { readonly at?: number }): void {
    if (record.disposed) throw new Error("团队已销毁。");
    if (record.roundsInFlight > 0) throw new Error("这一轮还在跑，等它结束再改名册。");
    const problems = checkRoster([...record.seats, seat]);
    if (problems.length > 0) throw new Error(problems.map((problem) => problem.detail).join("\n"));
    record.seats.splice(0, record.seats.length, ...placeSeat(record.seats, seat, options?.at));
    // The whole family: the array is shared, so every sitting already sees
    // the new member — but each one owns a row on disk, and a row that still
    // lists the old roster is what a restart would believe.
    this.persistFamily(record);
  }

  /**
   * Remove a seat.
   *
   * The seat's past words STAY in the record. A discussion it took part in
   * happened, and rewriting history to match the current roster would leave
   * later readers — the assembler and the secretary among them — reading a
   * conversation with a participant edited out of it.
   */
  private removeSeat(record: TeamRecord, seatId: string, options: { readonly confirmSecretary?: boolean } = {}): void {
    if (record.disposed) throw new Error("团队已销毁。");
    if (record.roundsInFlight > 0) throw new Error("这一轮还在跑，等它结束再改名册。");
    const problems = checkRemoval(record.seats, seatId, {
      ...(options.confirmSecretary === undefined ? {} : { allowSecretary: options.confirmSecretary }),
    });
    if (problems.length > 0) throw new Error(problems.map((problem) => problem.detail).join("\n"));
    record.seats.splice(
      record.seats.findIndex((seat) => seat.seatId === seatId),
      1,
    );
    this.persistFamily(record);
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

  /**
   * Note each seat's auth mode before the round starts.
   *
   * Read once here rather than per turn: which caps can bind is decided by
   * it, and that decision sits on the path a turn takes — a lookup there
   * would put the connection library between a person's instruction and the
   * seat answering it.
   *
   * A seat naming no connection runs on the host's own CLI login, which is a
   * subscription: it bills nothing, so cost ceilings do not apply to it.
   */
  private refreshAuthModes(record: TeamRecord): void {
    for (const seat of record.seats) {
      const connectionId = (seat.connectionId ?? "").trim();
      const connection = connectionId === "" ? undefined : this.ctx.seatConnections.get(connectionId);
      record.authModes.set(seat.seatId, connection?.authMode ?? "subscription");
    }
  }

  /**
   * Which provider serves this seat.
   *
   * A seat naming a connection goes to that connection's provider; one that
   * names none goes to the default, which injects nothing and uses the host's
   * own login.
   */
  private providerFor(seat: SeatSpec): string {
    // Delegated, so the table and `@squad/context` cannot disagree about
    // which provider a seat runs on — they did, and the secretary's whole
    // model configuration was silently ignored as a result.
    return providerForSeat(seat);
  }

  private async runSeat(
    record: TeamRecord,
    host: Agent,
    seat: SeatSpec,
    instruction: string,
    window: WindowAttempt,
    signal?: AbortSignal,
    quotes?: readonly { readonly speaker: string; readonly text: string }[],
    materials: readonly Material[] = [],
  ): Promise<SeatReply> {
    const provider = this.providerFor(seat);
    try {
      // Rethrown inside the try, so a broken assembler becomes a visible
      // failed seat instead of a silently empty window. A seat handed nothing
      // answers confidently from nothing, which reads exactly like a seat that
      // was given the discussion and ignored it — the failure has to be louder
      // than its symptom.
      if (window.error !== undefined) throw window.error;
      // Marked before the child starts and cleared in `finally`, so a seat
      // that throws does not stay "speaking" forever — a stuck indicator is
      // worse than none, because it is a claim.
      // Checked BEFORE the child starts. Checking afterwards would report a
      // limit as reached by the very turn that spent past it — which is the
      // one turn a limit exists to prevent.
      const reached = capReached(record, seat);
      if (reached !== undefined) {
        const text = `⚠️ ${seat.displayName} ${reached}`;
        recordSpoken(host, "系统", text);
        return {
          seatId: seat.seatId,
          displayName: seat.displayName,
          text,
          failed: true,
          contextLines: 0,
        };
      }
      record.speaking.set(seat.seatId, instruction);
      const lines = window.lines ?? [];
      const prompt = composeSeatPrompt({
        seat,
        instruction,
        context: lines,
        // Only what this round attached, plus anything pinned. Carrying every
        // imported document on every turn is what made importing one file so a
        // seat could summarise it once cost that file on every later turn of
        // every seat.
        ...(materials.length === 0 ? {} : { materials }),
        ...(quotes === undefined || quotes.length === 0 ? {} : { quotes }),
      });
      const request: SubagentStartRequest = {
        label: seat.displayName,
        prompt: [{ type: "text", text: prompt }],
        parent: host,
        // The agenda's signal when there is one, so stopping actually reaches
        // the running process instead of leaving it to finish into a
        // discussion nobody is having any more.
        signal: signal ?? new AbortController().signal,
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
      // Counted before the reply is returned, and counted on failures too:
      // a turn that burned tokens and then errored still cost what it cost.
      const usage = usageOfResult(result);
      record.usage = addUsage(record.usage, usage);
      record.perSeat.set(seat.seatId, addUsage(record.perSeat.get(seat.seatId) ?? EMPTY_TOTALS, usage));
      // Written after every turn, not at shutdown: a crash between the spend
      // and the save loses exactly the number that says what was spent.
      this.persist(record);
      // A cancelled seat SAYS it was cancelled. Stopping a round left it
      // returning empty text with `failed`, which reads as "the model had
      // nothing to say" — the one reading that sends a person to look at the
      // prompt for a decision they made themselves.
      const stopped = signal?.aborted === true && text.trim() === "";
      const answer = stopped ? `⏹ ${seat.displayName} 被叫停，这一轮没有答复。` : text;
      if (stopped) recordSpoken(host, "系统", answer);
      return {
        seatId: seat.seatId,
        displayName: seat.displayName,
        text: answer,
        failed,
        contextLines: lines.length,
        ...(usage === undefined ? {} : { usage }),
      };
    } catch (error) {
      // A seat that could not run is reported, never silently skipped: a round
      // that quietly loses a member looks exactly like one where the member had
      // nothing to say.
      const detail = error instanceof Error ? error.message : String(error);
      const text = `⚠️ 该席位未能执行：${detail}`;
      recordSpoken(host, seat.displayName, text);
      return {
        seatId: seat.seatId,
        displayName: seat.displayName,
        text,
        failed: true,
        contextLines: window.lines?.length ?? 0,
      };
    } finally {
      // Cleared on every path. A seat left marked as speaking is a claim, and
      // a stuck claim is worse than no indicator: it says work is happening.
      record.speaking.delete(seat.seatId);
    }
  }

  /**
   * Rename the team, and its workspace with it.
   *
   * Both, because they are one thing to a person: the sidebar entry and the
   * team header showing different names would be two objects where there is
   * one. The workspace is renamed through the registry when there is one —
   * a composition without it simply keeps the team's own name.
   */
  private rename(record: TeamRecord, displayName: string): void {
    const name = displayName.trim();
    if (name === "") throw new Error("团队要有一个名字。");
    // Assigned to every member, not just this one. `input` is shared by
    // REFERENCE, and replacing the object on one record would leave the
    // others pointing at the old name — a team renamed in one session and
    // still called the old thing in the next.
    const next = { ...this.baseOf(record).input, displayName: name };
    for (const member of this.family(record)) member.input = next;
    this.persistFamily(record);
    const registry = this.ctx.reflect.get("workspaceRegistry") as
      { list(): readonly { path: string; setTitle(title: string): Promise<void> }[] } | undefined;
    const workspace = registry?.list().find((entry) => entry.path === record.input.projectFolder);
    void workspace?.setTitle(name).catch((error: Error) => {
      // Warned, not thrown: the team is renamed either way, and failing the
      // rename over a sidebar label would be the tail wagging the dog.
      this.ctx.logger.warn(`workspace 改名失败：${error.message}`);
    });
  }

  /**
   * Take a team away, and its sittings with it.
   *
   * A sitting cannot outlive its base: it holds the base's roster object and
   * its own `input`, so a surviving orphan would be a team whose members can
   * no longer be edited and whose name can no longer be changed — visible in
   * the workspace, and unfixable. Disbanding the base is the person saying
   * they are done with this team, not with one of its windows.
   *
   * Disbanding a SITTING takes only that sitting: that is closing one piece
   * of work, and the team is what it always was.
   */
  private async dispose(record: TeamRecord): Promise<void> {
    if (record.disposed) return;
    record.disposed = true;
    await record.handle.dispose();
    this.teams.delete(record.teamId);
    this.forget(record.teamId);
    if (record.baseTeamId !== undefined) return;
    for (const sitting of this.sittingsOf(record.teamId)) await this.dispose(sitting);
  }
}

/** What one confirmed agenda did. */
export interface AgendaOutcome {
  readonly replies: readonly SeatReply[];
  /**
   * Phases that finished in full, in order.
   *
   * Finished, not entered. A stop lands inside a phase, and reporting that
   * phase as run would tell the caller work happened that did not — while its
   * unfinished tasks sit in the termination's `remaining` list, so the same
   * phase would read as both done and outstanding.
   */
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
  /**
   * Set when the host stopped the agenda. Distinct from `pausedAfter`: a
   * pause is the agenda doing what it said it would, a stop is the agenda not
   * finishing — and a caller that cannot tell them apart will treat an
   * interrupted run as a completed one.
   */
  readonly stoppedBecause?: string;
}

/**
 * Everything a hand-off document needs, gathered by whoever knows it.
 *
 * `remaining` is the part that matters. A hand-off listing what was done but
 * not what was left reads as complete to whoever picks the work up, and
 * starts them in the wrong place — which is the failure the secretary's
 * validation refuses on the writing side and this gathers on the reading one.
 */
export interface AgendaTermination {
  readonly objective: string;
  readonly reason: string;
  readonly completed: readonly string[];
  readonly remaining: readonly string[];
  readonly artifacts: readonly string[];
  readonly discussion: readonly string[];
}

/** One seat's window for a round, or the failure that stopped it being built. */
interface WindowAttempt {
  readonly lines?: readonly string[];
  readonly error?: Error;
}

interface TeamRecord {
  readonly teamId: string;
  /**
   * The dsh session this record serves.
   *
   * For a base team this is its own id — the host node's session IS the
   * team's record. For a sitting it is the session the person opened in the
   * workspace, which is what makes 「新建会话」 mean a new piece of work
   * rather than a second window onto the old one.
   *
   * Mutable for exactly one transition: a team created before anyone sat down
   * at it borrows its own id, and the first session to arrive claims it. See
   * `unclaimed`. Assigned IN PLACE rather than by rebuilding the record —
   * views handed out earlier close over the object, and a replacement would
   * leave them reading a stale `roundsInFlight`.
   */
  sessionId: string;
  /**
   * The team this is a sitting of, or nothing when this IS the team.
   *
   * A sitting shares `input` and `seats` BY REFERENCE with its base — the
   * same objects, not copies — so renaming the team or adding a member
   * reaches every sitting at once. Copying them would have made a roster edit
   * apply to whichever session happened to be open, which is the same class
   * of bug as a setting that saves and is never applied.
   */
  readonly baseTeamId: string | undefined;
  /** Mutable: a team can be renamed, and the record is what gets persisted. */
  input: CreateTeamInput;
  readonly handle: AgentHandle;
  /** Rounds currently running. Folding starts only at zero. */
  roundsInFlight: number;
  /** Set while an agenda is running; aborting it is how the host stops one. */
  running: RunningAgenda | undefined;
  /**
   * Set while a plain round is running.
   *
   * Separate from `running` because a round is not an agenda: it has no
   * phases, no completion account and no termination document. Both are
   * stoppable and only the agenda used to be, which made 「叫停」 work or throw
   * depending on which one you happened to be in.
   */
  roundAbort: AbortController | undefined;
  /** Project-relative paths this team has written, in order. */
  readonly artifacts: string[];
  /** Everything this team's seats have consumed. */
  usage: UsageTotals;
  /** seatId → what that seat alone has consumed. Caps bind per seat. */
  readonly perSeat: Map<string, UsageTotals>;
  /**
   * seatId → the auth mode of its connection.
   *
   * Cached at round start rather than looked up mid-turn: the connection
   * library is async and this decision sits on the path that must not wait.
   * A seat with no connection is a subscription — the host's own login.
   */
  readonly authModes: Map<string, "subscription" | "api-key">;
  /**
   * The roster, mutable.
   *
   * Held apart from `input.seats` because a team's membership changes and its
   * creation request does not — reading the roster off the original request
   * would make an added seat invisible to everything that consults it.
   */
  readonly seats: SeatSpec[];
  /** seatId → what it is answering right now. */
  readonly speaking: Map<string, string>;
  /** An agenda waiting on the host, and when it was drafted. */
  draft: { readonly agenda: AgendaSpec; readonly at: number; readonly fromTurnId?: string } | undefined;
  /**
   * Background material every seat reads.
   *
   * On the record and not on the sitting: a document is something the TEAM
   * knows, and a spec imported in one session that the same people could not
   * see in the next would be a team with two different memories.
   */
  materials: Material[];
  disposed: boolean;
}

/** The little of a dsh session this plugin touches. */
interface LiveSession {
  readonly header: { readonly cwd?: string };
  readonly id: string;
  readonly events: readonly { readonly type: string }[];
  append(type: string, data: unknown, options?: unknown): void;
}

/** The agenda currently executing, and the handle that stops it. */
interface RunningAgenda {
  readonly agenda: AgendaSpec;
  readonly abort: AbortController;
  /** Phase titles finished in full. */
  readonly completedPhases: string[];
  /** Task instructions that actually ran and produced an answer. */
  readonly completedTasks: string[];
  reason: string | undefined;
  progress: AgendaProgress;
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
function recordSpoken(host: Agent, speaker: string, text: string, turnId?: string): void {
  host.session.append(
    "user/message",
    spokenMessage(speaker, text, turnId) as never,
    // `SurfaceOp` is the literal 'append', not an object. Every
    // surface-eligible event must declare how it joins the ordered surface
    // that model history is derived from.
    { surfaceOp: "append" } as never,
  );
}

/**
 * One line of the team record, in the shape storage requires.
 *
 * Exported so a test can hand it to dsh's own `adoptSessionEvent` — the
 * function whose validator rejected the earlier shape. Restating the
 * requirement in an assertion would have been worth nothing here: the reason
 * the bug survived is that this package's writer and reader agreed with each
 * other and neither agreed with storage.
 */
export function spokenMessage(speaker: string, text: string, turnId?: string): Record<string, unknown> {
  return {
    // For `user/message` the event's data IS the message — `data.id`,
    // `data.role`, `data.source`, `data.content` — not `data.message.*`.
    // The nested shape was written here first and read back by this
    // package's own transcript reader, so both halves agreed and the record
    // looked correct for weeks. It was only unreadable from STORAGE:
    // reloading threw "lacks an identified message", which nothing in
    // process ever did, because nothing in process ever reloaded.
    //
    // (`assistant/message` and `tool/result` DO nest under `.message`.
    // `user/message` is the exception, and copying its neighbours is what
    // produced the bug.)
    id: turnId ?? `squad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    // `host` is not a legal source kind — the map is user/plugin/model/tool.
    // `user` is the truthful one: every line here is input arriving at the
    // host's session from outside any model, and who said it is already in
    // the text.
    source: { kind: "user" },
    content: [{ type: "text", text: `【${speaker}】${text}` }],
  };
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
    // Flat, matching what `recordSpoken` writes and what the persistence layer
    // requires. Reading `.message` here is what let the wrong write shape go
    // unnoticed: the reader agreed with the writer, and neither agreed with
    // storage.
    const data = event.data as { id?: unknown; content?: unknown } | undefined;
    const content = Array.isArray(data?.content) ? (data.content as ContentBlock[]) : undefined;
    return {
      kind: event.type,
      text: content === undefined ? "" : textOf(content),
      // The message id when there is one; otherwise the sequence number, which
      // is contiguous and unique by the log's own contract.
      turnId: typeof data?.id === "string" ? data.id : `seq-${event.seq}`,
      at: event.time,
    };
  });
}

/**
 * Whether this seat has reached a limit it was given.
 *
 * Which limits can bind depends on the connection's auth mode: a subscription
 * seat bills nothing, so only turns and tokens constrain it. Enforcing a cost
 * ceiling there would stop a seat for a reason that cannot be true.
 *
 * The mode is read from the seat's connection when it names one; a seat with
 * no connection runs on the host's own login, which is a subscription.
 */
function capReached(record: TeamRecord, seat: SeatSpec): string | undefined {
  const caps = seat.caps;
  if (caps === undefined) return undefined;
  const used = record.perSeat.get(seat.seatId) ?? EMPTY_TOTALS;
  return capExceeded(
    caps,
    {
      turns: used.turns,
      // Cache tokens count: they are billed, and a limit that ignored them
      // would let a seat spend six figures while reporting four.
      tokens: used.inputTokens + used.outputTokens + used.cacheReadTokens + used.cacheCreationTokens,
      ...(used.costUsd === undefined ? {} : { costUsd: used.costUsd }),
    },
    record.authModes.get(seat.seatId) ?? "subscription",
  );
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

/** How long one team may take to come back before it is skipped. */
const RESTORE_TIMEOUT_MS = 20_000;

/**
 * Reject if a promise has not settled in time.
 *
 * The timer is unref'd so a pending restore cannot hold the process open, and
 * the original promise is left to finish or not — there is nothing to cancel
 * and nobody waiting on it any more.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, detail: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(detail)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
