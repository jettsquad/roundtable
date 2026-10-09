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
import type { SubagentResult, SubagentStartRequest } from "@deepseek-ai/dsh-subagent";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Domain } from "@deepseek-ai/dsh-storage-domain";
import { SQUAD_TABLE_DOMAIN, type TeamPersisted } from "./domain.ts";
import {
  DOWNLOAD_TOOL_NAME,
  WEB_TOOLS,
  attachmentNote,
  materialsForRound,
  quotesFrom,
  checkMaterial,
  type Material,
  EMPTY_TOTALS,
  capExceeded,
  providerForSeat,
  addUsage,
  resolveArtifactPath,
  stripReasoning,
  sessionIdOfResult,
  usageOfResult,
  type AgendaSpec,
  type SeatUsage,
  type UsageTotals,
} from "@squad/shared";
import {
  EMPTY_TEAM_PROMPTS,
  blocksForSeat,
  PROJECT_MEMORY_MAX_CHARS,
  projectMemoryFile,
  projectMemoryNote,
  withProjectMemoryRules,
  type TeamPrompts,
} from "@squad/shared";
import {
  activityFor,
  activityKey,
  forgetSeatSession,
  rememberSeatSession,
  restoreSeatSessions,
  resumeWasRejected,
  seatSession,
  seatSessionId,
  snapshotSeatSessions,
  type SeatActivity,
} from "@squad/seat-runtime";
import { outstandingWork, pausesAfter, planPhase } from "./agenda.ts";
import { reopenReason } from "./reopen.ts";
import { baseForFolder, recordForSession, restoreOrder, unclaimed } from "./sitting.ts";
import { appendAudit, type AuditEntry, type AuditKind } from "./audit.ts";
import { agendaHash } from "./hash.ts";
import { checkRemoval, checkRoster, placeSeat, secretaryOf } from "./roster.ts";
import { composeSeatPrompt, type SeatSpec } from "./seat.ts";
import { newTurnId, sessionTeamLog, textOf, type TeamLog, type TranscriptEvent } from "./log.ts";

export { spokenMessage } from "./log.ts";
export type { TranscriptEvent } from "./log.ts";
import {
  excerpt,
  excludedFor,
  isOpen,
  replyTag as tagFor,
  settled,
  startable,
  type CommandSeatState,
  type CommandState,
} from "./commands.ts";

export type { CommandSeatState, CommandState } from "./commands.ts";

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
  /**
   * The team's copies of the shared prompt blocks, and how they are used.
   *
   * Copies, like the seats themselves: an edit in the library must not change
   * what a team already at work is being told. See `@squad/shared`'s
   * `prompt-blocks.ts`.
   */
  readonly prompts?: TeamPrompts | undefined;
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
  /** What the host is called in the record — the name the record is written under. */
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
  readonly draft:
    | {
        readonly agenda: AgendaSpec;
        readonly at: number;
        readonly fromTurnId?: string;
        /** One brief per labelled phase. Never a transcript line — see `setDraft`. */
        readonly criteria?: readonly string[];
      }
    | undefined;
  /**
   * The agenda the host confirmed and how far it got, when one is unfinished.
   *
   * Present after a stop, a `wait-for-host` pause, or a restart; absent once
   * the agenda ran to the end. 1.x kept this in `events.log` and replayed it;
   * 2.0 held it only in memory, so a restart mid-agenda lost the plan and
   * left a record full of instructions with nothing saying what they were
   * part of.
   */
  readonly confirmed:
    | {
        readonly agenda: AgendaSpec;
        readonly at: number;
        readonly done: readonly string[];
        /** sha256 of the canonical agenda, so what ran stays checkable. */
        readonly hash: string;
        /** Who was at the table when it was confirmed. */
        readonly roster: readonly { readonly seatId: string; readonly displayName: string; readonly role: string }[];
      }
    | undefined;
  /** This team's decisions, oldest first. Not the transcript — see `audit.ts`. */
  readonly audit: readonly AuditEntry[];
  /** The draft's identity, so a confirmation can name the one it saw. */
  readonly draftIdentity: { readonly agendaId: string; readonly revision: number } | undefined;
  /**
   * Carry on an unfinished agenda, from the phase after the last finished one.
   *
   * Never automatic — 1.x's rule and the right one: work that resumes without
   * being asked is work nobody decided to do, and a restart is exactly when
   * nobody is watching.
   */
  resumeAgenda(): Promise<AgendaOutcome>;
  /**
   * Put the agenda back to before phase `phaseIndex`, so a resume re-runs it.
   *
   * The flexibility a linear plan cannot have on its own: a problem found in
   * phase five is usually a problem MADE in phase two, and without this the
   * only repair is to confirm the whole plan again and re-run everything.
   *
   * It rewinds the PLAN, never the discussion. Nothing said is removed — the
   * re-run sees the earlier attempt and the argument against it, which is the
   * only way the second attempt can be different from the first.
   *
   * Never runs anything by itself. Same rule as `resumeAgenda`: work that
   * starts without being asked is work nobody decided to do.
   */
  rewindAgenda(phaseIndex: number): void;
  /** Where this team sits in the list, when it has been arranged. */
  readonly order: number | undefined;
  /**
   * Put a draft up for confirmation, or clear the one standing.
   *
   * `fromTurnId` is the secretary reply it was converted from. Carried so the
   * draft can be shown where it came from — a plan that appears at the top of
   * the page, far from the sentence that produced it, is a plan nobody reads
   * next to the reasoning behind it.
   */
  /**
   * @param criteria the host's own standards that bear on this plan, already
   *   selected and formatted. Shown BESIDE the draft and never recorded as a
   *   line: a transcript entry would reach every seat's next window, and
   *   criteria must not shape how a participant thinks — only how work is
   *   organised and judged.
   */
  setDraft(draft: AgendaSpec | undefined, fromTurnId?: string, criteria?: readonly string[]): void;
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
   * What is ticked for the next message.
   *
   * On the record rather than in the browser: a refresh used to discard it
   * silently, and the chips looked identical either way.
   */
  readonly selection: { readonly quoteIds: readonly string[]; readonly materialIds: readonly string[] };
  /** Tick or untick one quoted line or one document. */
  select(kind: "quote" | "material", id: string, on: boolean): void;
  /** Drop the lot. Called when the message it belongs to goes out. */
  clearSelection(): void;
  /**
   * The commands this sitting has been given, oldest first, with where each
   * one stands for every seat it named.
   *
   * Finished ones stay for a while so the line in the discussion can still
   * say how it ended; only unfinished ones survive a restart.
   */
  readonly commands: readonly CommandView[];
  /**
   * Send a command and return at once.
   *
   * It is written into the record now and each named seat takes it up as
   * soon as that seat is free: different seats work in parallel, one seat
   * works through its own commands in the order they were sent. `done`
   * settles when every named seat has answered, failed or been stopped.
   */
  submit(
    instruction: string,
    seatIds?: readonly string[],
    quotes?: readonly { readonly speaker: string; readonly text: string }[],
    materialIds?: readonly string[],
    quoteIds?: readonly string[],
  ): { readonly commandId: string; readonly done: Promise<readonly SeatReply[]> };
  /**
   * Stop one command — the seats still answering it, and the ones that had
   * not started yet. Nothing else is touched: commands queued behind it on
   * the same seat go ahead as usual.
   */
  cancel(commandId: string): void;
  /** Send an interrupted command again, as a new command. */
  resend(commandId: string): { readonly commandId: string };
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
  /** The team's prompt blocks and how they are shared out. */
  readonly prompts: TeamPrompts;
  /**
   * Replace them wholesale.
   *
   * Wholesale rather than field by field, because every caller is editing one
   * screen where the blocks, the team's selection and the sets are visible
   * together — and a partial update is how two of the three end up describing
   * a state the third never agreed to.
   *
   * Takes effect from the NEXT round: a seat mid-answer is running on the
   * text it was handed. Written on the BASE team, so every sitting shares it
   * exactly as it shares the roster.
   */
  setPrompts(prompts: TeamPrompts): void;
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
   * Stop whatever is running — an agenda, or every unfinished command.
   *
   * The panel stops one command at a time through `cancel`; this is for the
   * callers that only know "the team", such as a slash command.
   *
   * `undefined` when it was commands: a command has no termination document,
   * and an empty one would be a hand-off nobody wrote.
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
  /**
   * What this seat has spent, so far, in this sitting.
   *
   * Per seat rather than only per team, because the team total cannot answer
   * the question it provokes. Six seats behind one number, and three of them
   * on a backend that reported nothing at all, means 「哪个席位在烧钱」 had
   * no answer — and without that answer there is nothing to act on.
   *
   * Not persisted: it is rebuilt from zero on restart, exactly as the team
   * total in `record.usage` is not. Said here so a number that resets is a
   * known property rather than a bug someone rediscovers.
   */
  readonly usage?: UsageTotals | undefined;
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

/** One command, as the panel shows it under its line in the discussion. */
export interface CommandView {
  /** The turn id of the command's own line in the record. */
  readonly commandId: string;
  readonly instruction: string;
  readonly at: number;
  readonly state: CommandState;
  readonly seats: readonly {
    readonly seatId: string;
    readonly displayName: string;
    readonly state: CommandSeatState;
  }[];
  /** Why it is interrupted, when it is. */
  readonly note?: string | undefined;
  /** Stopped before any seat had started on it. */
  readonly withdrawn?: boolean | undefined;
}

/**
 * What else shapes a seat's window, now that seats run in parallel.
 *
 * Both exist because "everything after this seat last spoke" stopped being
 * the same thing as "everything this seat has not seen" the moment another
 * seat could answer while this one was still working.
 */
export interface WindowOptions {
  /**
   * The last record entry this seat was shown, the previous time its window
   * was taken. A continuing seat is handed what came after it — minus its
   * own lines, which its conversation already holds. Without it the tail is
   * cut at the seat's last reply, which misses whatever another seat said
   * while this one was answering.
   */
  readonly seenUpTo?: string | undefined;
  /**
   * Record entries to leave out: the command this seat is about to answer
   * (it reaches the seat as this round's instruction, and finding it again
   * in the discussion would be reading it twice) and any later command
   * still waiting for it (which it must not start answering early).
   */
  readonly exclude?: readonly string[] | undefined;
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
  /**
   * @param continuingAs the display name of a seat that is continuing its own
   *   CLI conversation, and so already holds everything up to its last reply.
   *   Absent means hand it the whole window.
   * @param options what else shapes the window now that seats run in
   *   parallel. See `WindowOptions`.
   */
  windowFor(teamId: string, seatId: string, continuingAs?: string, options?: WindowOptions): Promise<readonly string[]>;
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
  /**
   * Some seat in the round about to start will open a FRESH conversation.
   *
   * Awaited, unlike the two above, and called only while the team is idle:
   * a fresh conversation is handed the newest checkpoint plus every word
   * after it, verbatim, and this is the one chance to fold that tail first
   * so the new conversation starts small. Must not reject — a round that
   * cannot start because a summary failed loses the round to save tokens.
   */
  beforeFreshStart?(teamId: string): Promise<void>;
  /**
   * A project file has outgrown `PROJECT_MEMORY_MAX_CHARS`: return its
   * rewritten BODY, or nothing when it could not be done.
   *
   * Here rather than on the table because rewriting is judgement work and the
   * secretary is reached through this side of the seam. The table reads the
   * file, decides it is too big, and writes the answer back — the program's
   * half. Must not reject: a seat with a big file still answers.
   */
  compactProjectMemory?(teamId: string, file: string, text: string): Promise<string | undefined>;
}

export class TeamsService extends Service {
  static readonly inject = ["agents", "subagents", "seatConnections", "storageDomain"];

  private readonly teams = new Map<string, TeamRecord>();
  private assembler: TeamAssembler | undefined;
  /** sessionId → the lookup in flight for it. See `sittingFor`. */
  private readonly sittingLookups = new Map<string, Promise<Team | undefined>>();
  /** path → the rewrite in flight for it. See `compacted`. */
  private readonly compactions = new Map<string, Promise<string>>();
  private readonly roundEndedListeners = new Set<(event: RoundEndedEvent) => void>();
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
        // On `console` as well as the logger, and the reason is the same one
        // that cost an afternoon elsewhere in this file: `ctx.logger.warn`
        // printed NOTHING in the composition this actually runs in. A team
        // that fails to restore is skipped — which is right — but skipped
        // silently it presents as 「重启之后之前的对话丢了一些」, with the
        // record still on disk and no way for a person to learn why.
        const detail = error instanceof Error ? error.message : String(error);
        const line = `团队「${row.displayName}」（${row.teamId}）没能恢复，这一场不会出现在列表里：${detail}`;
        this.ctx.logger.warn(line);
        console.warn(`[squad] ${line}`);
      }
    }
  }

  /** Rebuild one saved team, log and all. */
  private async restore(saved: TeamPersisted): Promise<void> {
    const handle = await this.ctx.agents.resume({ resumeSessionId: saved.teamId as never });
    // Rehydrates the module-level map `seatSessionId` reads — empty on every
    // fresh process — so the FIRST turn after a restart still resumes each
    // seat's own conversation rather than opening a new one. A row naming a
    // conversation the CLI has since dropped costs no more than that already
    // did: `resumeWasRejected` catches it and the turn retries fresh.
    if (saved.seatSessions !== undefined) restoreSeatSessions(handle.agent.session.id, saved.seatSessions);
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
      ...(saved.order === undefined ? {} : { order: saved.order }),
      input,
      handle,
      log: sessionTeamLog(handle.agent),
      roundsInFlight: 0,
      running: undefined,
      agendaWaiting: false,
      idleWaiters: [],
      preparing: false,
      commands: [],
      commandSeq: 0,
      seatBusy: new Set(),
      seenUpTo: new Map(),
      handed: new Map(),
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
              // Rows written before identity existed get one now, so a
              // restored draft can still be named by a confirmation.
              agendaId: saved.draftAgendaId ?? `ag-${saved.teamId}`,
              revision: saved.draftRevision ?? 1,
            },
      // Its own, always — including for a sitting.
      //
      // This used to take the base's live array, on the reasoning that
      // material belongs to the TEAM. It does not. A team is a roster; a
      // sitting is one piece of work, and the documents you hand it are part
      // of that work. Sharing the array meant a file imported while
      // discussing one problem appeared in the discussion of another, with
      // no way to tell the two apart — which is what a person hit.
      //
      // The roster still IS shared (`seats`/`input` below), and that is the
      // distinction: adding a member changes who the team is, and adding a
      // document changes what this conversation is about.
      materials: [...(saved.materials ?? [])],
      selection: {
        quoteIds: [...(saved.selection?.quoteIds ?? [])],
        materialIds: [...(saved.selection?.materialIds ?? [])],
      },
      confirmed:
        saved.confirmed === undefined
          ? undefined
          : {
              agenda: saved.confirmed,
              at: saved.confirmedAt ?? Date.now(),
              done: [...(saved.confirmedDone ?? [])],
              // Recomputed rather than trusted when the row predates hashing:
              // a stored hash that no longer matches its agenda would be a
              // lie, and an absent one is merely a gap.
              hash: saved.confirmedHash ?? agendaHash(saved.confirmed),
              roster: saved.confirmedRoster ?? [],
            },
      audit: (saved.audit ?? []) as readonly AuditEntry[],
      disposed: false,
    });
    const record = this.teams.get(saved.teamId);
    if (record !== undefined) this.restoreCommands(record, saved);
  }

  /**
   * Bring back the commands that had not finished, as interrupted.
   *
   * Never resumed by themselves: the process died under them, nobody is
   * watching a restart, and work that starts without being asked is work
   * nobody decided to do. The line under each says so and offers to resend.
   *
   * A row from before commands existed carries one waiting message instead.
   * That message was never written into the record — the old queue wrote a
   * line only when it went out — so it is written now, or there would be
   * nothing in the discussion to hang the resend on.
   */
  private restoreCommands(record: TeamRecord, saved: TeamPersisted): void {
    const rows = [...(saved.commands ?? [])];
    if (saved.queued !== undefined) {
      const commandId = newTurnId();
      record.log.append(record.input.hostDisplayName, saved.queued.instruction, commandId);
      rows.push({
        commandId,
        instruction: saved.queued.instruction,
        seatIds: saved.queued.seatIds ?? record.seats.map((seat) => seat.seatId),
        quoteIds: saved.queued.quoteIds,
        materialIds: saved.queued.materialIds,
        at: saved.queued.at,
      });
    }
    for (const row of rows) {
      const command = this.newCommand(record, {
        commandId: row.commandId,
        instruction: row.instruction,
        seatIds: row.seatIds,
        quotes: [],
        quoteIds: row.quoteIds,
        materialIds: row.materialIds,
        at: row.at,
      });
      command.state = "interrupted";
      command.note = row.note ?? "上一次这个进程停了，这条没有执行完。";
      for (const seatId of command.seatIds) command.seats.set(seatId, "stopped");
      command.settle([]);
      record.commands.push(command);
    }
    if (saved.queued !== undefined) this.persist(record);
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
      ...(record.order === undefined ? {} : { order: record.order }),
      // So a restart resumes each seat's own conversation instead of paying
      // full system-prompt cache creation again for every one of them. See
      // `TeamPersisted.seatSessions`.
      ...((): { seatSessions?: TeamPersisted["seatSessions"] } => {
        const sessions = snapshotSeatSessions(record.handle.agent.session.id);
        return Object.keys(sessions).length === 0 ? {} : { seatSessions: sessions };
      })(),
      ...(record.draft === undefined
        ? {}
        : {
            draft: record.draft.agenda,
            draftedAt: record.draft.at,
            ...(record.draft.fromTurnId === undefined ? {} : { draftFromTurnId: record.draft.fromTurnId }),
          }),
      ...(record.materials.length === 0 ? {} : { materials: record.materials }),
      // Written only when something is ticked, so an untouched record keeps
      // the shape it had before this field existed.
      ...(record.selection.quoteIds.length === 0 && record.selection.materialIds.length === 0
        ? {}
        : { selection: { quoteIds: record.selection.quoteIds, materialIds: record.selection.materialIds } }),
      // Only the unfinished ones, and only what it takes to send them again.
      // Written only when there are some, so a quiet record keeps the shape
      // it had before this field existed.
      ...((): { commands?: TeamPersisted["commands"] } => {
        const open = record.commands.filter((command) => isOpen(command) || command.state === "interrupted");
        if (open.length === 0) return {};
        return {
          commands: open.map((command) => ({
            commandId: command.commandId,
            instruction: command.instruction,
            seatIds: [...command.seatIds],
            quoteIds: [...command.quoteIds],
            materialIds: [...command.materialIds],
            at: command.at,
            ...(command.note === undefined ? {} : { note: command.note }),
          })),
        };
      })(),
      ...(record.confirmed === undefined
        ? {}
        : {
            confirmed: record.confirmed.agenda,
            confirmedAt: record.confirmed.at,
            confirmedDone: record.confirmed.done,
            confirmedHash: record.confirmed.hash,
            confirmedRoster: record.confirmed.roster as { seatId: string; displayName: string; role: string }[],
          }),
      ...(record.draft === undefined
        ? {}
        : { draftAgendaId: record.draft.agendaId, draftRevision: record.draft.revision }),
      ...(record.audit.length === 0 ? {} : { audit: record.audit as TeamPersisted["audit"] }),
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

  /**
   * Hear about every round and agenda that finishes. Returns the disposer.
   *
   * A listener that throws is logged and skipped: a notification that failed
   * must never be the reason a round's replies do not reach the person.
   */
  onRoundEnded(listener: (event: RoundEndedEvent) => void): () => void {
    this.roundEndedListeners.add(listener);
    return () => {
      this.roundEndedListeners.delete(listener);
    };
  }

  private emitRoundEnded(
    record: TeamRecord,
    kind: RoundEndedEvent["kind"],
    replies: readonly SeatReply[],
    stopped: boolean,
    waitingForHost: boolean,
  ): void {
    if (record.disposed || this.roundEndedListeners.size === 0) return;
    const good = [...replies].reverse().find((reply) => !reply.failed && reply.text.trim() !== "");
    const event: RoundEndedEvent = {
      teamId: record.teamId,
      teamName: record.input.displayName,
      kind,
      stopped,
      answered: replies.length,
      failed: replies.filter((reply) => reply.failed).length,
      ...(good === undefined ? {} : { last: { speaker: good.displayName, text: good.text } }),
      // Another command still running or waiting is not a stopping point.
      moreQueued: record.commands.some(isOpen),
      waitingForHost,
    };
    for (const listener of this.roundEndedListeners) {
      try {
        listener(event);
      } catch (error) {
        this.ctx.logger.warn(`round-ended 监听器抛错：${error instanceof Error ? error.message : String(error)}`);
      }
    }
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
      log: sessionTeamLog(handle.agent),
      roundsInFlight: 0,
      running: undefined,
      agendaWaiting: false,
      idleWaiters: [],
      preparing: false,
      commands: [],
      commandSeq: 0,
      seatBusy: new Set(),
      seenUpTo: new Map(),
      handed: new Map(),
      artifacts: [],
      usage: EMPTY_TOTALS,
      perSeat: new Map(),
      authModes: new Map(),
      seats: [...input.seats],
      speaking: new Map(),
      draft: undefined,
      confirmed: undefined,
      audit: [],
      materials: [],
      selection: { quoteIds: [], materialIds: [] },
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
    // One lookup per session at a time. The body awaits (creating the host
    // node) BETWEEN checking for a sitting and registering the new one, so
    // three callers arriving together each found none and each made one — the
    // duplicate sittings that hid a discussion behind an empty twin. Later
    // callers wait for the first and then find its record.
    const running = this.sittingLookups.get(input.sessionId);
    if (running !== undefined) return running;
    const lookup = this.findOrCreateSitting(input).finally(() => {
      this.sittingLookups.delete(input.sessionId);
    });
    this.sittingLookups.set(input.sessionId, lookup);
    return lookup;
  }

  private async findOrCreateSitting(input: {
    readonly projectFolder: string;
    readonly sessionId: string;
  }): Promise<Team | undefined> {
    const records = [...this.teams.values()];
    const existing = recordForSession(records, input.sessionId, (record) => record.log.size());
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
      log: sessionTeamLog(handle.agent),
      roundsInFlight: 0,
      running: undefined,
      agendaWaiting: false,
      idleWaiters: [],
      preparing: false,
      commands: [],
      commandSeq: 0,
      seatBusy: new Set(),
      seenUpTo: new Map(),
      handed: new Map(),
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
      confirmed: undefined,
      audit: [],
      // Empty, not the base's list: a new sitting is a new piece of work.
      // Copying the base's documents in would put someone else's reading
      // material into a discussion that never asked for it.
      materials: [],
      selection: { quoteIds: [], materialIds: [] },
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
      const used = session.snapshotEvents().some((event) => event.type === "turn/start");
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
      // Turn ONE, and the number is not free.
      //
      // `turn` is a COUNTER, not a marker: dsh's loop takes the last
      // `turn/start` in the log and adds one, from a base of zero. So the
      // only correct value here is 1 — and it is correct only because of the
      // `used` guard above, which returns before this line whenever the
      // session already has a turn. Widen that guard and this constant
      // becomes a duplicate turn number.
      //
      // It was 0, meaning 「这不是真的一轮」 — a meaning `turn` does not
      // have. dsh's persistence validator refuses any stored `turn/end`
      // below 1, and refuses it at LOAD: the marker wrote cleanly, sat on
      // disk, and made the session unresumable and unrenamable weeks later.
      // 51 sessions were written that way before a rename hit one.
      //
      // Nothing warned at write time because these go through `as never`.
      // The cast gets us past a type we cannot reach — and past every rule
      // that came with it.
      for (const event of sessionMarkEvents(teamName)) {
        // `surfaceOp` on the message only: it is the one event of the three
        // that joins the ordered surface model history is derived from.
        if (event.type === "user/message") {
          session.append(event.type as never, event.data as never, { surfaceOp: "append" } as never);
        } else {
          session.append(event.type as never, event.data as never);
        }
      }
    } catch (error) {
      // Loud, and on `console` as well as the logger.
      //
      // This catch hid a whole feature. `session.events` stopped existing in
      // dsh 0.1.2, the read threw, and every new sitting came out unmarked —
      // a blank session dsh hands back to the next 新建会话 — while the only
      // trace was `ctx.logger?.warn?.()`, whose two optional chains mean it
      // prints nothing at all when no logger is mounted. The symptom reached
      // a person as 「点新开一场没反应」; nothing reached the terminal.
      //
      // Still caught, because failing to mark must not fail the sitting: the
      // session and the record are real, and the mark is what makes it
      // legible. But silence is not the price of that.
      const detail = error instanceof Error ? error.message : String(error);
      const line = `没能给会话留下标记（这一场仍然建好了，只是在侧边栏里不会显示成团队会话）：${detail}`;
      this.ctx.logger?.warn?.(line);
      console.warn(`[squad] ${line}`);
    }
  }

  /**
   * Write one line into this team's audit.
   *
   * Not into the transcript: the transcript is what the team SAID and what
   * the seats read, and filling it with bookkeeping would spend a model's
   * window on our own record-keeping. The two answer different questions.
   *
   * Does not persist by itself — every caller is already writing the record
   * for the change this line describes, and two writes would race.
   */
  private note(record: TeamRecord, kind: AuditKind, detail: string, hash?: string): void {
    record.audit = appendAudit(record.audit, {
      at: Date.now(),
      kind,
      detail,
      ...(hash === undefined ? {} : { agendaHash: hash }),
    });
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

  /**
   * Every live team, in the order the list shows them.
   *
   * Arranged order wins; anything never arranged keeps the order it was made
   * in. They never interleave badly because `move` writes a position onto
   * every team at once — before the first move they are all absent, after it
   * they are all numbers.
   */
  list(): readonly string[] {
    const live = [...this.teams.values()].filter((r) => !r.disposed);
    return live
      .map((record, index) => ({ record, index }))
      .sort(
        (a, b) =>
          (a.record.order ?? Number.MAX_SAFE_INTEGER) - (b.record.order ?? Number.MAX_SAFE_INTEGER) ||
          a.index - b.index,
      )
      .map(({ record }) => record.teamId);
  }

  /**
   * Move one team up or down the list.
   *
   * Positions are rewritten for everyone rather than swapped between two,
   * because a swap between two teams that have never been arranged changes
   * nothing anybody can see — neither of them has a position to swap. Only
   * BASE teams are arranged: a sitting belongs to its team and appears under
   * it, so giving one its own place in the list would let a session outrank
   * the team it is a session of.
   */
  async move(teamId: string, delta: number): Promise<void> {
    const ordered = this.list()
      .map((id) => this.teams.get(id))
      .filter((record): record is TeamRecord => record !== undefined && record.baseTeamId === undefined);
    const at = ordered.findIndex((record) => record.teamId === teamId);
    if (at < 0) throw new Error(`没有这支团队：${teamId}。`);
    const to = at + delta;
    if (to < 0 || to >= ordered.length) return;
    const next = [...ordered];
    const [moved] = next.splice(at, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    for (const [index, record] of next.entries()) {
      if (record.order === index) continue;
      record.order = index;
      this.persist(record);
    }
    await Promise.resolve();
  }

  private viewOf(record: TeamRecord): Team {
    // An arrow, not an alias of `this`: inside a getter in the literal below,
    // `this` is the view being built rather than the service that owns the
    // records — while an arrow declared here keeps the service's.
    const baseRecord = (): TeamRecord => this.baseOf(record);
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
          // Attached to BOTH branches: a seat that is idle is exactly the one
          // whose spend you are reading, and leaving it off the idle branch
          // would show a number only while it was too busy to look at.
          const spent = record.perSeat.get(seat.seatId);
          const usage = spent === undefined || spent.turns === 0 ? {} : { usage: spent };
          if (instruction === undefined) {
            return { seatId: seat.seatId, displayName: seat.displayName, running: false, ...usage };
          }
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
            ...usage,
          };
        });
      },
      get progress() {
        return record.running === undefined ? undefined : record.running.progress;
      },
      get draft() {
        return record.draft;
      },
      get confirmed() {
        return record.confirmed;
      },
      get audit() {
        return record.audit;
      },
      get draftIdentity() {
        return record.draft === undefined
          ? undefined
          : { agendaId: record.draft.agendaId, revision: record.draft.revision };
      },
      get prompts() {
        return baseRecord().input.prompts ?? EMPTY_TEAM_PROMPTS;
      },
      setPrompts: (prompts: TeamPrompts) => {
        // Written on the BASE, and read from it — a sitting shares its team's
        // roster and must share its shared prompts too, or one session's
        // seats work to different standing instructions than another's.
        const base = baseRecord();
        base.input = { ...base.input, prompts };
        this.note(
          base,
          "team-renamed",
          `改了共用提示词：${prompts.teamBlockIds.length} 段全员、${prompts.sets.length} 个集合、共 ${prompts.blocks.length} 段片段。`,
        );
        this.persist(base);
      },
      resumeAgenda: () => {
        const held = record.confirmed;
        if (held === undefined) throw new Error("没有未跑完的议程。");
        // A finished agenda is now kept rather than cleared, so 「跑完了」 has
        // to be refused here instead of being implied by an absence.
        if (held.done.length >= held.agenda.phases.length) {
          throw new Error("这份议程已经跑完了。要重跑某个阶段，用「从这里重来」。");
        }
        return this.runAgenda(record, held.agenda, held.done.length);
      },
      get order() {
        return record.order;
      },
      rewindAgenda: (phaseIndex: number) => {
        const held = record.confirmed;
        if (held === undefined) throw new Error("这支团队没有确认过的议程，无处可回。");
        if (record.running !== undefined) throw new Error("议程正在跑，先叫停再回退。");
        if (phaseIndex < 0 || phaseIndex >= held.agenda.phases.length) {
          throw new Error(`没有第 ${phaseIndex + 1} 个阶段。`);
        }
        const title = held.agenda.phases[phaseIndex]?.title ?? "";
        record.confirmed = { ...held, done: held.done.slice(0, phaseIndex) };
        this.note(record, "agenda-rewound", `退回到第 ${phaseIndex + 1} 阶段「${title}」，等主持人续跑。`, held.hash);
        // Said in the record, because the discussion is NOT rewound and the
        // next reader has to know why the same phase appears twice. Deleting
        // the earlier attempt was the alternative and it is worse: what was
        // said was said, the correction only makes sense next to it, and a
        // re-run that cannot see the criticism repeats the mistake.
        record.log.append(
          "系统",
          `⏪ 主持人把议程退回到第 ${phaseIndex + 1} 阶段「${title}」。` +
            `之前说过的话都留着——重跑这一阶段的席位看得见它们，包括为什么要重来。`,
        );
        this.persist(record);
      },
      setDraft: (draft, fromTurnId, criteria) => {
        if (draft === undefined) {
          record.draft = undefined;
        } else {
          // The id is the TEAM's plan identity and survives re-drafts; the
          // revision counts them. A confirmation names both, so a stale tab
          // cannot run a plan that has since been replaced.
          record.draft = {
            agenda: draft,
            at: Date.now(),
            ...(fromTurnId === undefined ? {} : { fromTurnId }),
            ...(criteria === undefined || criteria.length === 0 ? {} : { criteria }),
            agendaId: record.draft?.agendaId ?? `ag-${record.teamId}`,
            revision: (record.draft?.revision ?? 0) + 1,
          };
          this.note(
            record,
            "agenda-drafted",
            `秘书拟了第 ${record.draft.revision} 版草案，${draft.phases.length} 个阶段。`,
            agendaHash(draft),
          );
        }
        this.persist(record);
      },
      get materials() {
        return record.materials;
      },
      addMaterial: (material) => {
        const problem = checkMaterial(material, record.materials);
        if (problem !== undefined) throw new Error(problem.detail);
        // This record's own list. Sittings each hold their own now, so there
        // is no family to keep in step — only this one to save.
        record.materials.push(material);
        this.persist(record);
      },
      setMaterialPinned: (materialId, pinned) => {
        const at = record.materials.findIndex((material) => material.materialId === materialId);
        if (at < 0) throw new Error("没有这份资料。");
        const current = record.materials[at] as Material;
        record.materials.splice(at, 1, { ...current, pinned });
        this.persist(record);
      },
      removeMaterial: (materialId) => {
        const at = record.materials.findIndex((material) => material.materialId === materialId);
        if (at < 0) throw new Error("没有这份资料。");
        record.materials.splice(at, 1);
        // Untick it as it goes. A selection naming a document that no longer
        // exists would be carried into the next round as a silent nothing —
        // and `materialsForRound` would drop it without saying so.
        record.selection.materialIds = record.selection.materialIds.filter((id) => id !== materialId);
        this.persist(record);
      },
      get selection() {
        return { quoteIds: [...record.selection.quoteIds], materialIds: [...record.selection.materialIds] };
      },
      /**
       * Tick or untick one line / one document for the NEXT message.
       *
       * A toggle rather than a whole-list write: two surfaces touch this — the
       * 引用 button lives in the discussion, the material chips in the
       * composer — and a last-writer-wins list would let one of them erase
       * what the other just did.
       */
      select: (kind, id, on) => {
        const list = kind === "quote" ? record.selection.quoteIds : record.selection.materialIds;
        const at = list.indexOf(id);
        if (on && at < 0) list.push(id);
        if (!on && at >= 0) list.splice(at, 1);
        this.persist(record);
      },
      clearSelection: () => {
        record.selection.quoteIds = [];
        record.selection.materialIds = [];
        this.persist(record);
      },
      get commands() {
        return record.commands.map((command) => viewOfCommand(record, command));
      },
      submit: (instruction, seatIds, quotes, materialIds, quoteIds) =>
        this.submit(record, instruction, seatIds, quotes, materialIds, quoteIds),
      cancel: (commandId) => this.cancel(record, commandId),
      resend: (commandId) => this.resend(record, commandId),
      addSeat: (seat, options) => this.addSeat(record, seat, options),
      removeSeat: (seatId, options) => this.removeSeat(record, seatId, options),
      rename: (displayName) => this.rename(record, displayName),
      checkpointCoefficient: record.input.checkpointCoefficient,
      ask: (instruction, seatIds, quotes, materialIds) =>
        this.submit(record, instruction, seatIds, quotes, materialIds).done,
      transcript: () => record.log.events(),
      recordSpoken: (speaker, text, turnId) => record.log.append(speaker, text, turnId),
      runAgenda: (agenda) => this.runAgenda(record, agenda),
      stopAgenda: (reason) => this.stopAgenda(record, reason),
      stop: (reason) => this.stop(record, reason),
      dispose: () => this.dispose(record),
    };
  }

  /**
   * Send one command.
   *
   * The instruction lands in the host's session first — at once, even when
   * every seat it names is busy — so the record shows what was asked even if
   * every seat then fails, and the panel has a line to hang the command's
   * status on. Each seat runs as a one-shot subagent and its reply is injected
   * back into the host session, which is what makes the discussion durable
   * rather than a runtime detail nobody wrote down.
   *
   * Nothing here waits for a seat. Different seats take the command up in
   * parallel; a seat already answering something takes it up when it is free
   * (see `pump`). It used to be one round per table: a second message waited
   * for every seat of the first, even a seat it never named.
   */
  private submit(
    record: TeamRecord,
    instruction: string,
    seatIds?: readonly string[],
    quotes?: readonly { readonly speaker: string; readonly text: string }[],
    materialIds?: readonly string[],
    quoteIds?: readonly string[],
  ): { readonly commandId: string; readonly done: Promise<readonly SeatReply[]> } {
    if (record.disposed) throw new Error("团队已销毁。");
    const seats =
      seatIds === undefined || seatIds.length === 0
        ? record.seats
        : record.seats.filter((seat) => seatIds.includes(seat.seatId));
    if (seats.length === 0) throw new Error("点名的席位都不在这支团队里。");

    // Decided once for the whole command, so every seat in it sees the same
    // documents — a command where the first seat read the spec and the second
    // did not would produce two answers nobody can compare.
    const materials = materialsForRound(record.materials, materialIds);
    const note = attachmentNote(materials);
    const commandId = newTurnId();
    record.log.append(
      record.input.hostDisplayName,
      note === undefined ? instruction : `${instruction}\n${note}`,
      commandId,
    );
    const command = this.newCommand(record, {
      commandId,
      instruction,
      seatIds: seats.map((seat) => seat.seatId),
      quotes: quotes ?? [],
      quoteIds: quoteIds ?? [],
      materialIds: materialIds ?? [],
      at: Date.now(),
      materials,
    });
    record.commands.push(command);
    this.persist(record);
    this.pump(record);
    return { commandId, done: command.done };
  }

  private newCommand(
    record: TeamRecord,
    input: {
      readonly commandId: string;
      readonly instruction: string;
      readonly seatIds: readonly string[];
      readonly quotes: readonly { readonly speaker: string; readonly text: string }[];
      readonly quoteIds: readonly string[];
      readonly materialIds: readonly string[];
      readonly at: number;
      readonly materials?: readonly Material[];
    },
  ): Command {
    let settle: (replies: readonly SeatReply[]) => void = () => undefined;
    const done = new Promise<readonly SeatReply[]>((resolve) => {
      settle = resolve;
    });
    record.commandSeq += 1;
    return {
      commandId: input.commandId,
      seq: record.commandSeq,
      instruction: input.instruction,
      at: input.at,
      seatIds: [...input.seatIds],
      names: new Map(
        input.seatIds.map((seatId) => [
          seatId,
          record.seats.find((seat) => seat.seatId === seatId)?.displayName ?? seatId,
        ]),
      ),
      quotes: input.quotes,
      quoteIds: [...input.quoteIds],
      materialIds: [...input.materialIds],
      materials: input.materials ?? materialsForRound(record.materials, input.materialIds),
      abort: new AbortController(),
      seats: new Map(input.seatIds.map((seatId) => [seatId, "queued" as CommandSeatState])),
      replies: [],
      state: "queued",
      settle,
      done,
    };
  }

  /**
   * Start every seat turn that can start now.
   *
   * A seat takes the oldest command still waiting for it, and only when it is
   * not already answering one: its CLI conversation is continued turn after
   * turn, and two turns resuming the same conversation at once would each
   * miss the other, with only one of them remembered afterwards. Different
   * seats are independent and run side by side.
   *
   * Nothing starts while an agenda runs or is waiting to — it would never get
   * the table — or while a fold is preparing fresh conversations.
   *
   * @param folded the fold for this batch already ran (or was tried), so it
   *   is not tried again — a fold that failed would otherwise retry forever.
   */
  private pump(record: TeamRecord, folded = false): void {
    if (record.disposed || record.running !== undefined || record.agendaWaiting || record.preparing) return;
    const batch: { readonly command: Command; readonly seat: SeatSpec }[] = [];
    for (const turn of startable(record.commands, record.seatBusy)) {
      const command = record.commands.find((candidate) => candidate.commandId === turn.commandId);
      if (command === undefined) continue;
      const seat = record.seats.find((candidate) => candidate.seatId === turn.seatId);
      if (seat === undefined) {
        this.seatGone(record, command, turn.seatId);
        continue;
      }
      batch.push({ command, seat });
    }
    if (batch.length === 0) return;

    // A fold discards every seat's conversation, so it may only run while
    // nothing is running — and it is the one chance to make a fresh
    // conversation start small. Everything in the batch waits for it.
    const host = record.handle.agent;
    const seats = batch.map((entry) => entry.seat);
    this.dropStaleSessions(record, host, seats);
    const fresh = seats.some((seat) => seatSessionId(host.session.id, seat.displayName) === undefined);
    if (!folded && fresh && record.roundsInFlight === 0 && this.assembler?.beforeFreshStart !== undefined) {
      record.preparing = true;
      void this.prepareFreshStarts(record, host, seats).finally(() => {
        record.preparing = false;
        this.pump(record, true);
      });
      return;
    }
    for (const { command, seat } of batch) this.launch(record, command, seat);
  }

  /** A seat named by a command left the roster before its turn came. */
  private seatGone(record: TeamRecord, command: Command, seatId: string): void {
    const displayName = command.names.get(seatId) ?? seatId;
    const text = `⚠️ ${displayName} 已经不在团队里，这条命令没有交给它。`;
    record.log.append("系统", text);
    command.seats.set(seatId, "failed");
    command.replies.push({ seatId, displayName, text, failed: true, contextLines: 0 });
    this.finishIfDone(record, command);
  }

  /** Mark one seat turn started — synchronously, so no second pump can take the seat. */
  private launch(record: TeamRecord, command: Command, seat: SeatSpec): void {
    record.seatBusy.add(seat.seatId);
    command.seats.set(seat.seatId, "running");
    if (command.state === "queued") command.state = "running";
    record.roundsInFlight += 1;
    void this.runTurn(record, command, seat);
  }

  private async runTurn(record: TeamRecord, command: Command, seat: SeatSpec): Promise<void> {
    const host = record.handle.agent;
    let reply: SeatReply;
    try {
      this.refreshAuthModes(record);
      const window = await this.windowForSeat(record, host, seat, command.commandId);
      reply = await this.runSeat(
        record,
        host,
        seat,
        command.instruction,
        window,
        command.abort.signal,
        command.quotes,
        command.materials,
        command,
      );
    } catch (error) {
      // `runSeat` reports its own failures; this is whatever broke before it
      // ran. Reported the same way, because a seat that quietly drops out of
      // a command looks exactly like one that had nothing to say.
      const text = `⚠️ 该席位未能执行：${error instanceof Error ? error.message : String(error)}`;
      record.log.append(seat.displayName, `${replyTag(record, command)}${text}`);
      reply = { seatId: seat.seatId, displayName: seat.displayName, text, failed: true, contextLines: 0 };
    } finally {
      record.seatBusy.delete(seat.seatId);
      record.roundsInFlight -= 1;
    }
    command.replies.push(reply);
    command.seats.set(
      seat.seatId,
      command.abort.signal.aborted && reply.failed ? "stopped" : reply.failed ? "failed" : "answered",
    );
    this.finishIfDone(record, command);
    if (record.roundsInFlight === 0) {
      for (const waiter of record.idleWaiters.splice(0)) waiter();
    }
    this.pump(record);
  }

  /**
   * Close a command once no seat in it is waiting or running.
   *
   * The round-end signal goes out only when the whole team has gone quiet:
   * the assembler folds on it, and a fold with a seat still running would
   * record a boundary in the middle of that seat's work.
   */
  private finishIfDone(record: TeamRecord, command: Command): void {
    if (!isOpen(command) || !settled(command.seats)) return;
    const stopped = command.abort.signal.aborted;
    command.state = stopped ? "stopped" : "done";
    // In the order the seats were named, not the order they happened to finish.
    const replies = command.seatIds.flatMap((seatId) => command.replies.filter((reply) => reply.seatId === seatId));
    command.settle(replies);
    this.trimCommands(record);
    this.persist(record);
    if (record.roundsInFlight === 0) this.signalRoundEnded(record);
    this.emitRoundEnded(record, "round", replies, stopped, false);
  }

  /** Keep every unfinished command and a bounded tail of finished ones. */
  private trimCommands(record: TeamRecord): void {
    const finished = record.commands.filter((command) => command.state === "done" || command.state === "stopped");
    if (finished.length <= FINISHED_COMMANDS_KEPT) return;
    const drop = new Set(finished.slice(0, finished.length - FINISHED_COMMANDS_KEPT));
    // Reassigned, never spliced: a pump may be iterating the old array.
    record.commands = record.commands.filter((command) => !drop.has(command));
  }

  /**
   * Stop one command.
   *
   * The seats answering it are cancelled through its own signal; the seats
   * that had not started never will. Every other command — including ones
   * waiting behind it on the same seat — goes ahead: a stop says this command
   * was wrong, and says nothing about the next one.
   */
  private cancel(record: TeamRecord, commandId: string): void {
    const command = record.commands.find((candidate) => candidate.commandId === commandId);
    if (command === undefined) throw new Error("没有这条命令。");
    if (!isOpen(command)) throw new Error("这条命令已经结束了。");
    let started = false;
    for (const [seatId, state] of command.seats) {
      if (state === "queued") command.seats.set(seatId, "stopped");
      else started = true;
    }
    command.abort.abort(new Error("已叫停"));
    if (!started) command.withdrawn = true;
    record.log.append(
      "系统",
      started
        ? `⏹ 主持人叫停了「${excerpt(command.instruction)}」`
        : `↩ 主持人撤回了「${excerpt(command.instruction)}」`,
    );
    // Ends here when nothing was running; otherwise the running seats end it
    // as they stop.
    this.finishIfDone(record, command);
    this.persist(record);
  }

  /** Send an interrupted command again. The old entry gives way to the new one. */
  private resend(record: TeamRecord, commandId: string): { readonly commandId: string } {
    const command = record.commands.find((candidate) => candidate.commandId === commandId);
    if (command === undefined || command.state !== "interrupted") {
      throw new Error("只有没执行完的命令可以重发。");
    }
    const seatIds = command.seatIds.filter((seatId) => record.seats.some((seat) => seat.seatId === seatId));
    if (seatIds.length === 0) throw new Error("这条命令点名的席位都已经不在团队里了。");
    const quotes = quotesFrom(record.log.events(), command.quoteIds);
    record.commands = record.commands.filter((candidate) => candidate !== command);
    const sent = this.submit(record, command.instruction, seatIds, quotes, command.materialIds, command.quoteIds);
    return { commandId: sent.commandId };
  }

  /**
   * Drop the conversations that are no longer worth continuing, then — when
   * anyone in this round will start fresh — let the assembler fold first.
   *
   * Decided by the program, before the windows are taken, because the window
   * a seat gets depends on it: a continuing seat is handed only what it has
   * not seen, a fresh one the checkpoint and everything after it. See
   * `reopen.ts` for the two lines and the measurements behind them.
   */
  private async prepareFreshStarts(record: TeamRecord, host: Agent, seats: readonly SeatSpec[]): Promise<void> {
    this.dropStaleSessions(record, host, seats);
    if (this.assembler?.beforeFreshStart === undefined) return;
    if (seats.every((seat) => seatSessionId(host.session.id, seat.displayName) !== undefined)) return;
    try {
      await this.assembler.beforeFreshStart(record.teamId);
    } catch (error) {
      // The contract says it never rejects; if it does anyway, the round
      // still runs — on a longer window, which is the cost of the failure.
      this.ctx.logger.warn(
        `团队 ${record.teamId}：新开对话前的折叠失败，这一轮按原窗口进行：` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private dropStaleSessions(record: TeamRecord, host: Agent, seats: readonly SeatSpec[]): void {
    const now = Date.now();
    for (const seat of seats) {
      const reason = reopenReason(seatSession(host.session.id, seat.displayName), now);
      if (reason === undefined) continue;
      forgetSeatSession(host.session.id, seat.displayName);
      this.ctx.logger.info(`团队 ${record.teamId}：${seat.displayName} 这一轮新开对话（${reason}）。`);
    }
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
  /**
   * The window this seat should get, trimmed when it is continuing.
   *
   * A seat with a live CLI conversation already holds everything up to its own
   * last reply; sending it again would put the same text in the prompt twice —
   * once in the conversation the CLI remembers, once in the window assembled
   * here — and the overlap grows every round.
   *
   * The check is on the conversation, not on the seat: an id dropped after a
   * failed resume means the next turn opens a fresh conversation, and a fresh
   * conversation must be handed everything.
   */
  private async windowForSeat(
    record: TeamRecord,
    host: Agent,
    seat: SeatSpec,
    answering?: string,
  ): Promise<WindowAttempt> {
    const continuing = seatSessionId(host.session.id, seat.displayName) !== undefined;
    // Left out: the command being answered, and every later one still waiting
    // for this seat. See `WindowOptions.exclude`.
    const exclude = [...excludedFor(record.commands, seat.seatId, answering)];
    const handed = record.handed.get(seat.seatId);
    if (continuing && handed !== undefined) exclude.push(handed);
    const seenUpTo = continuing ? record.seenUpTo.get(seat.seatId) : undefined;
    // Taken BEFORE the window, which the assembler builds from the record as
    // it stands at the call: anything landing after this is what the next
    // continuing turn is handed.
    const last = record.log.events().at(-1)?.turnId;
    const attempt = await this.contextFor(record.teamId, seat.seatId, continuing ? seat.displayName : undefined, {
      ...(seenUpTo === undefined ? {} : { seenUpTo }),
      ...(exclude.length === 0 ? {} : { exclude }),
    });
    if (last !== undefined) record.seenUpTo.set(seat.seatId, last);
    return attempt;
  }

  private async contextFor(
    teamId: string,
    seatId: string,
    continuingAs?: string,
    options?: WindowOptions,
  ): Promise<WindowAttempt> {
    if (this.assembler === undefined) return { lines: [] };
    try {
      return { lines: await this.assembler.windowFor(teamId, seatId, continuingAs, options) };
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
  private async runAgenda(record: TeamRecord, agenda: AgendaSpec, startFrom = 0): Promise<AgendaOutcome> {
    if (record.disposed) throw new Error("团队已销毁。");
    if (record.running !== undefined) throw new Error("这支团队已经在跑一个议程了。");
    // Commands still running finish first; nothing new starts meanwhile
    // (`pump` holds off while `agendaWaiting`), or the agenda might never get
    // the table. They are not stopped: the person sent them, and confirming a
    // plan is not taking them back.
    if (record.roundsInFlight > 0) {
      if (record.agendaWaiting) throw new Error("已经有一个议程在等手上的命令答完了。");
      record.agendaWaiting = true;
      try {
        await new Promise<void>((resolve) => record.idleWaiters.push(resolve));
      } finally {
        record.agendaWaiting = false;
      }
      if (record.disposed) throw new Error("团队已销毁。");
      if (record.running !== undefined) throw new Error("这支团队已经在跑一个议程了。");
    }
    // Written down BEFORE the first phase runs. A crash between confirmation
    // and the first turn used to leave nothing at all — no plan, no record
    // that one was confirmed.
    const hash = agendaHash(agenda);
    record.confirmed = {
      agenda,
      at: record.confirmed?.at ?? Date.now(),
      done: [...agenda.phases.slice(0, startFrom).map((phase) => phase.title)],
      hash,
      // Who was at the table at confirmation. Execution reads the CURRENT
      // roster on purpose — a member added mid-agenda should be usable — so
      // this is what lets a later reader see that the two differed.
      roster: record.seats.map((seat) => ({
        seatId: seat.seatId,
        displayName: seat.displayName,
        role: seat.role,
      })),
    };
    this.note(
      record,
      startFrom > 0 ? "agenda-resumed" : "agenda-confirmed",
      startFrom > 0
        ? `从第 ${startFrom + 1} 阶段续跑，共 ${agenda.phases.length} 个阶段。`
        : `主持人确认了议程，共 ${agenda.phases.length} 个阶段，名册 ${record.seats.length} 人。`,
      hash,
    );
    this.persist(record);
    const host = record.handle.agent;
    if (startFrom > 0) {
      // Said in the record, because the record is about to look odd: only
      // FINISHED phases are skipped, so a phase cut off halfway runs again
      // from the top and its instruction appears twice. That is the right
      // trade — we cannot know whether the interrupted seat's work landed —
      // but an unexplained duplicate reads like a bug.
      record.log.append(
        "系统",
        `▶ 从第 ${startFrom + 1} 阶段「${agenda.phases[startFrom]?.title ?? ""}」继续。` +
          `已跑完的阶段不重跑；上次中断在半途的那个阶段会从头再来一遍。`,
      );
    }
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
    // Before `roundsInFlight` goes up: the fold this may run needs the team
    // idle, and between phases it never is again until the agenda ends.
    await this.prepareFreshStarts(record, record.handle.agent, record.seats);
    record.roundsInFlight += 1;
    try {
      for (const [phaseIndex, phase] of agenda.phases.entries()) {
        // Phases already finished in an earlier run of this agenda are
        // skipped, not re-run. Re-running them would bill the work twice and
        // put a second copy of every answer in the record.
        if (phaseIndex < startFrom) continue;
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
        // A long agenda can outgrow a conversation or outlast the cache
        // between phases too. No fold here — the team is mid-agenda — so a
        // seat dropped now reopens on the checkpoint and the tail as they are.
        this.dropStaleSessions(record, host, record.seats);
        const opening = new Map<string, WindowAttempt>();
        for (const run of runs) {
          if (run.window === "phase-start" && !opening.has(run.task.seatId)) {
            const seat = record.seats.find((candidate) => candidate.seatId === run.task.seatId);
            opening.set(
              run.task.seatId,
              seat === undefined
                ? await this.contextFor(record.teamId, run.task.seatId)
                : await this.windowForSeat(record, host, seat),
            );
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
            record.log.append("系统", text);
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
              : await this.windowForSeat(record, host, seat);

          const instructionId = newTurnId();
          record.log.append(record.input.hostDisplayName, `（${phase.title}）${run.task.instruction}`, instructionId);
          record.handed.set(seat.seatId, instructionId);
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
        // Recorded as it goes, so an interruption knows where it stopped.
        record.confirmed = {
          ...(record.confirmed ?? { agenda, at: Date.now(), hash, roster: [] }),
          agenda,
          done: [...agenda.phases.slice(0, phaseIndex + 1).map((one) => one.title)],
        };
        this.persist(record);

        if (pausesAfter(phase)) {
          pausedAfter = phase.title;
          break;
        }
      }
    } finally {
      record.roundsInFlight -= 1;
      record.running = undefined;
      // Finished means finished: nothing left to carry on from. A stop or a
      // pause keeps the record, which is what makes 「继续」 possible.
      const finished =
        !running.abort.signal.aborted &&
        pausedAfter === undefined &&
        running.completedPhases.length >= agenda.phases.length - startFrom;
      this.note(
        record,
        finished ? "agenda-finished" : running.abort.signal.aborted ? "agenda-stopped" : "agenda-paused",
        finished
          ? `议程跑完，共 ${running.completedPhases.length} 个阶段。`
          : running.abort.signal.aborted
            ? `议程被叫停，已完成 ${running.completedPhases.length} 个阶段。`
            : `议程停在「${pausedAfter ?? ""}」之后，等主持人。`,
        hash,
      );
      // KEPT after it finishes, where it used to be cleared.
      //
      // Clearing was right while the only question a finished agenda could
      // answer was 「要不要续跑」 — there is nothing to continue. But the
      // question that actually comes up is 「第三阶段漏了一件事，能不能从那
      // 里再来一遍」, and answering it needs the phase list and how far it
      // got. Thrown away, the only way back was to re-confirm the whole plan
      // and re-run five phases to fix one.
      //
      // `done.length === phases.length` is what "finished" now looks like in
      // the record, and every reader that offers 「继续」 checks it.
      if (finished && record.confirmed !== undefined) {
        record.confirmed = { ...record.confirmed, done: agenda.phases.map((phase) => phase.title) };
      }
      this.persist(record);
    }

    this.signalRoundEnded(record);
    this.emitRoundEnded(record, "agenda", replies, running.reason !== undefined, pausedAfter !== undefined);
    // The reason an agenda holds the count for its whole run: a command sent
    // during phase two waits for phase five, not for phase two. It goes out
    // now however the agenda ended — a stop says the agenda was wrong, not
    // the commands sent while it ran.
    this.pump(record);
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
   * An agenda when one is running, otherwise every unfinished command. The
   * panel stops commands one at a time through `cancel`; this is for callers
   * that only know the team.
   *
   * Returns `undefined` when commands were stopped — there is no termination
   * document for a command, and inventing an empty one would put a hand-off
   * in the record that nobody wrote.
   */
  private stop(record: TeamRecord, reason: string): AgendaTermination | undefined {
    if (record.running !== undefined) return this.stopAgenda(record, reason);
    const open = record.commands.filter(isOpen);
    if (open.length === 0) throw new Error("这支团队现在没有在跑任何东西。");
    for (const command of open) this.cancel(record, command.commandId);
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
      discussion: record.log
        .events()
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
    record.log.append("系统", `已写入 ${relative}`);
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

  /**
   * This seat's project file: its CONTENTS when it exists, an errand when it
   * does not.
   *
   * Squad reads it now. It used to arrive on its own — every CLI discovers
   * its own file in the cwd — and that route was given up deliberately: the
   * switch that stops `claude` reading the project's `CLAUDE.md` is the same
   * one that stops it reading the host's 141,709-character framework, and
   * only one of those is worth 66k of cache creation on every cold start.
   * See `ArgvInput.hostCustomizations`.
   *
   * Handing it over ourselves is not merely a replacement. It is visible on
   * screen, it is the same path for a backend whose CLI has no such
   * convention, and it is sent once per conversation rather than rebuilt into
   * every system prompt.
   *
   * Checked per turn rather than remembered, because the folder is the
   * person's and they may delete it, and a remembered "already done" would
   * leave the next seat reading a file that is not there.
   *
   * A backend with no such convention, or a folder that cannot be read at
   * all, produces nothing: this is a convenience, and it must never be the
   * reason a round fails. That includes an unreadable or undecodable file —
   * a seat with no project notes answers; a round that threw does not.
   */
  private async projectMemoryFor(
    record: TeamRecord,
    seat: SeatSpec,
  ): Promise<
    | { readonly kind: "missing"; readonly forSeat: string; readonly notice: string }
    | { readonly kind: "present"; readonly file: string; readonly text: string }
    | undefined
  > {
    const file = projectMemoryFile(seat.backend);
    const folder = record.input.projectFolder;
    if (file === undefined || folder === undefined || folder.trim() === "") return undefined;
    const path = join(folder, file);
    try {
      await stat(path);
    } catch {
      return {
        kind: "missing",
        forSeat: projectMemoryNote(file).join("\n"),
        notice: `${seat.displayName} 发现这个项目还没有 ${file}，这一轮会先把它建起来。之后要改，请你自己改。`,
      };
    }
    try {
      const text = await readFile(path, "utf8");
      if (text.trim() === "") return undefined;
      return { kind: "present", file, text: await this.compacted(record, path, file, text) };
    } catch {
      // It is there and we cannot read it. Saying nothing is right: the seat
      // loses a convenience, and the alternative — failing the round — loses
      // the answer.
      return undefined;
    }
  }

  /**
   * The project file, shrunk back under its limit first when it has outgrown it.
   *
   * Done, not reported. Telling the person the file is too big hands them a
   * job they would only give back to a Claude — so the secretary rewrites it,
   * the program puts the rules back on top and writes it into the project.
   * The project's own history keeps the old version, which is the undo.
   *
   * One rewrite per file at a time: the seats of a round read it one after
   * another, and the second must wait for the first rewrite rather than start
   * its own.
   */
  private async compacted(record: TeamRecord, path: string, file: string, text: string): Promise<string> {
    if (text.length <= PROJECT_MEMORY_MAX_CHARS) return text;
    const compact = this.assembler?.compactProjectMemory;
    if (compact === undefined) return text;
    const running = this.compactions.get(path);
    if (running !== undefined) return running;
    const work = (async (): Promise<string> => {
      const body = await compact(record.teamId, file, text);
      if (body === undefined) return text;
      const next = withProjectMemoryRules(body);
      await writeFile(path, next, "utf8");
      this.ctx.logger.info(`团队 ${record.teamId}：${file} 从 ${text.length} 字符精简到 ${next.length} 字符。`);
      return next;
    })();
    this.compactions.set(path, work);
    try {
      return await work;
    } catch (error) {
      this.ctx.logger.warn(
        `团队 ${record.teamId}：精简 ${file} 失败，这一轮照原文发：${error instanceof Error ? error.message : String(error)}`,
      );
      return text;
    } finally {
      this.compactions.delete(path);
    }
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
    command?: Command,
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
        record.log.append("系统", text);
        return {
          seatId: seat.seatId,
          displayName: seat.displayName,
          text,
          failed: true,
          contextLines: 0,
        };
      }
      record.speaking.set(seat.seatId, instruction);
      // Announced, not done quietly. Creating a file in the person's project
      // folder is an automatic action with an invisible result, and the one
      // criterion this library already holds says such a thing must say what
      // it did. Said ONCE — the check is re-run every turn, but the file
      // exists after the first one, so the notice cannot repeat.
      const memory = await this.projectMemoryFor(record, seat);
      if (memory?.kind === "missing") {
        record.log.append("系统", memory.notice);
      }
      // Sent only when this seat is opening a FRESH conversation. A resumed
      // one is still carrying the copy it was handed, and re-sending it would
      // pay for the project's notes again every single turn — which is the
      // exact waste this whole change exists to stop.
      const continuing = seatSessionId(host.session.id, seat.displayName) !== undefined;
      const projectMemory = memory?.kind === "present" && !continuing ? memory : undefined;
      let lines = window.lines ?? [];
      const compose = (context: readonly string[]): string =>
        composeSeatPrompt({
          seat,
          instruction: memory?.kind === "missing" ? `${memory.forSeat}\n\n${instruction}` : instruction,
          context,
          ...(projectMemory === undefined
            ? {}
            : { projectMemory: { file: projectMemory.file, text: projectMemory.text } }),
          // The live roster, read at turn time: a member added mid-discussion
          // should be someone the next round can hand work to.
          roster: record.seats,
          hostDisplayName: record.input.hostDisplayName,
          // From the BASE team: a sitting is another piece of the same team's
          // work, and its seats read the same shared blocks.
          blocks: blocksForSeat(this.baseOf(record).input.prompts ?? EMPTY_TEAM_PROMPTS, seat.seatId),
          // Only what this round attached, plus anything pinned. Carrying every
          // imported document on every turn is what made importing one file so a
          // seat could summarise it once cost that file on every later turn of
          // every seat.
          ...(materials.length === 0 ? {} : { materials }),
          ...(quotes === undefined || quotes.length === 0 ? {} : { quotes }),
        });
      const requestFor = (prompt: string): SubagentStartRequest => ({
        label: seat.displayName,
        prompt: [{ type: "text", text: prompt }],
        parent: host,
        // On the seam's own field; each backend translates it. Only when
        // chosen, so a seat on 「默认」 sends exactly the request it always did.
        ...(seat.reasoningEffort === undefined
          ? {}
          : { agentOptions: { reasoningEffort: seat.reasoningEffort as never } }),
        // Pre-approve the web tools when this seat is allowed the web, and
        // ONLY for the backend that declares the capability. The seam refuses
        // a request carrying something the provider does not support rather
        // than accepting it and quietly dropping it — which is right, and
        // which means sending this to codex or dsh would fail the round
        // instead of being ignored.
        ...(seat.webAccess === true && seat.backend === "claude-code"
          ? { toolFilter: { allow: [...WEB_TOOLS, DOWNLOAD_TOOL_NAME] } }
          : {}),
        // The agenda's signal when there is one, so stopping actually reaches
        // the running process instead of leaving it to finish into a
        // discussion nobody is having any more.
        signal: signal ?? new AbortController().signal,
      });
      const runOnce = async (prompt: string): Promise<SubagentResult> => {
        const run = await this.ctx.subagents.start(provider, requestFor(prompt));
        return run.result;
      };
      // Read BEFORE the turn: the provider resolves the same id when it builds
      // its command line, and if the CLI rejects it this is what says which id
      // to stop trusting.
      const resumeId = seatSessionId(host.session.id, seat.displayName);
      let result = await runOnce(compose(lines));
      // A conversation the CLI no longer has is the one failure that is cured
      // by running again, so it is cured HERE rather than shown to the person.
      // Left to the next turn it costs them a round and an error naming a uuid
      // they never chose — which is what it did: `No conversation found with
      // session ID: <uuid>`, on a seat that had answered minutes earlier.
      //
      // The window is rebuilt, not reused. A continuing seat is handed only
      // what it has not already got, because the rest is in the conversation
      // the CLI holds; once that conversation is gone, sending the trimmed
      // window would hand a fresh seat a discussion with its middle missing.
      if (result.stopReason !== "completed" && resumeWasRejected(resumeId, textOf(result.output))) {
        forgetSeatSession(host.session.id, seat.displayName);
        const reopened = await this.windowForSeat(record, host, seat);
        // Only when the window came back. A rebuild that fails leaves the
        // original failure standing, which is still the honest report.
        if (reopened.error === undefined) {
          this.ctx.logger.info(`${seat.displayName}：CLI 不认这个对话（${resumeId}），已丢弃并重开一次。`);
          lines = reopened.lines ?? [];
          // The rejected attempt is not counted. It never reached a model —
          // the CLI exits at startup, before the first request — so charging
          // it a turn would spend the seat's cap on something that did not
          // happen.
          result = await runOnce(compose(lines));
        }
      }
      const text = stripReasoning(textOf(result.output));
      // Only `completed` is an answer. `aborted`, `error`, `max-tokens` and
      // `refusal` all leave the seat without one, and each has to be visible —
      // a round that quietly drops a member reads exactly like a round where
      // that member had nothing to say.
      const failed = result.stopReason !== "completed";
      // The conversation this turn ran in, so the next one can continue it
      // instead of paying for the standing prefix again.
      //
      // A FAILED turn drops it instead — the backstop for every failure the
      // retry above does not recognise. An id kept after a failure would make
      // every later turn of this seat fail the same way; forgetting one that
      // was fine costs a single un-resumed turn.
      const cliSession = sessionIdOfResult(result);
      const usage = usageOfResult(result);
      if (failed) {
        forgetSeatSession(host.session.id, seat.displayName);
      } else if (cliSession !== undefined) {
        // With when it was used and how big it got: the two facts the next
        // turn needs to decide whether continuing is still the cheap path.
        rememberSeatSession(host.session.id, seat.displayName, cliSession, {
          usedAt: Date.now(),
          contextTokens: usage?.contextTokens,
        });
      }
      record.log.append(seat.displayName, `${replyTag(record, command)}${text}`);
      // Counted before the reply is returned, and counted on failures too:
      // a turn that burned tokens and then errored still cost what it cost.
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
      if (stopped) record.log.append("系统", answer);
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
      record.log.append(seat.displayName, `${replyTag(record, command)}${text}`);
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
    for (const command of record.commands) command.abort.abort(new Error("团队已销毁。"));
    await record.handle.dispose();
    this.teams.delete(record.teamId);
    this.forget(record.teamId);
    if (record.baseTeamId !== undefined) return;
    for (const sitting of this.sittingsOf(record.teamId)) await this.dispose(sitting);
  }
}

/**
 * A round or agenda has just finished — the moment a person who looked away
 * wants to be told. Data only: what to do about it (a banner, a sound) is the
 * listener's business, and the table has no business knowing there is a screen.
 */
export interface RoundEndedEvent {
  readonly teamId: string;
  readonly teamName: string;
  readonly kind: "round" | "agenda";
  /** Cut short by 「叫停」 or an abort, rather than finished. */
  readonly stopped: boolean;
  /** How many seats answered, and how many of those answers were failures. */
  readonly answered: number;
  readonly failed: number;
  /** The last seat that answered properly, for a preview line. */
  readonly last?: { readonly speaker: string; readonly text: string };
  /** Another round is already queued and starting — this is not a stopping point. */
  readonly moreQueued: boolean;
  /** An agenda handed control back to the host and is waiting for them. */
  readonly waitingForHost: boolean;
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
  /** What was said. The only way anything here reads or writes the record. */
  readonly log: TeamLog;
  /**
   * Seat turns currently running, plus one for a running agenda. Folding
   * starts only at zero.
   */
  roundsInFlight: number;
  /** Set while an agenda is running; aborting it is how the host stops one. */
  running: RunningAgenda | undefined;
  /**
   * An agenda was confirmed while commands were still running, and is waiting
   * for them to finish. No new seat turn starts meanwhile, or it would never
   * get its turn.
   */
  agendaWaiting: boolean;
  /** Called, and emptied, the moment `roundsInFlight` drops to zero. */
  idleWaiters: (() => void)[];
  /**
   * A fold is running before a batch of seat turns starts. Nothing else
   * starts meanwhile: the fold discards every seat's conversation, and a
   * seat already running would come back holding the history it replaced.
   */
  preparing: boolean;
  /** Commands, oldest first. Unfinished ones plus a bounded tail of finished. */
  commands: Command[];
  /**
   * Bumped for every command sent. A reply is tagged with the command it
   * answers when a later command was sent in between.
   */
  commandSeq: number;
  /** Seats answering a command right now. A seat takes one at a time. */
  readonly seatBusy: Set<string>;
  /**
   * seatId → the last record entry that seat's window was taken against.
   *
   * Not persisted: after a restart a continuing seat falls back to "after its
   * last reply", which is what it got before seats ran in parallel.
   */
  readonly seenUpTo: Map<string, string>;
  /**
   * seatId → the agenda instruction it was last handed, which an agenda
   * writes AFTER taking the window — so it sits past `seenUpTo` and would be
   * handed again as discussion on the seat's next continuing turn.
   */
  readonly handed: Map<string, string>;
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
  draft:
    | {
        readonly agenda: AgendaSpec;
        readonly at: number;
        readonly fromTurnId?: string;
        readonly agendaId: string;
        readonly revision: number;
      }
    | undefined;
  /**
   * The agenda the host CONFIRMED, and the phases that finished.
   *
   * Persisted, unlike `running`, which is the live loop's own bookkeeping and
   * dies with the process. Without this a restart during an agenda lost the
   * plan entirely: the record kept the instructions it had issued and nothing
   * said what they were part of or where it had got to.
   */
  confirmed:
    | {
        readonly agenda: AgendaSpec;
        readonly at: number;
        done: string[];
        readonly hash: string;
        readonly roster: readonly { readonly seatId: string; readonly displayName: string; readonly role: string }[];
      }
    | undefined;
  /** This team's audit log, oldest first and bounded. */
  audit: readonly AuditEntry[];
  /**
   * Background material every seat reads.
   *
   * On the record and not on the sitting: a document is something the TEAM
   * knows, and a spec imported in one session that the same people could not
   * see in the next would be a team with two different memories.
   */
  materials: Material[];
  /** What the host has ticked for the next message. See the schema. */
  selection: { quoteIds: string[]; materialIds: string[] };
  /** Where it sits in the list, once somebody has arranged one. */
  order?: number | undefined;
  disposed: boolean;
}

/** The little of a dsh session this plugin touches. */
/**
 * The part of dsh's Session this file uses.
 *
 * Hand-written because the service is reached through `ctx.reflect.get`,
 * which is untyped — and that is exactly what made this shim dangerous. It
 * declared `events`, dsh 0.1.2 removed that property, and tsc had nothing to
 * compare against: the upgrade type-checked clean while `markLiveSession`
 * threw at runtime into a swallowed catch, leaving every new sitting
 * unmarked. A structural type of somebody else's object is a claim, and this
 * one went on being believed after it stopped being true.
 *
 * Keep it minimal for that reason: every member here is an assumption that
 * nothing will check.
 */
interface LiveSession {
  readonly header: { readonly cwd?: string };
  readonly id: string;
  /** 0.1.2 replaced the `events` property with this explicit snapshot. */
  snapshotEvents(): readonly { readonly type: string }[];
  append(type: string, data: unknown, options?: unknown): void;
}

/**
 * One command, and the bookkeeping that runs it.
 *
 * Everything the message carried is frozen here at send time — who was
 * named, which quotes and documents were ticked — because those belong to
 * the message, not to the moment a busy seat gets round to it.
 */
interface Command {
  readonly commandId: string;
  readonly seq: number;
  readonly instruction: string;
  readonly at: number;
  /** In roster order at send time. */
  readonly seatIds: readonly string[];
  /** seatId → its display name when the command was sent. */
  readonly names: ReadonlyMap<string, string>;
  readonly quotes: readonly { readonly speaker: string; readonly text: string }[];
  readonly quoteIds: readonly string[];
  readonly materialIds: readonly string[];
  readonly materials: readonly Material[];
  readonly abort: AbortController;
  readonly seats: Map<string, CommandSeatState>;
  readonly replies: SeatReply[];
  state: CommandState;
  note?: string | undefined;
  /** Stopped before any seat started on it. */
  withdrawn?: boolean | undefined;
  readonly settle: (replies: readonly SeatReply[]) => void;
  readonly done: Promise<readonly SeatReply[]>;
}

/** How many finished commands a sitting keeps for the panel to label. */
const FINISHED_COMMANDS_KEPT = 200;

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
 * The three events that make a session real to dsh.
 *
 * Extracted from `markSession` so a test can hand them to dsh's OWN
 * validator. That is the only kind of test that catches what happened here:
 * `turn: 0` was written for weeks, every in-process check passed, and the
 * refusal came from storage — at LOAD, days later, as a failed rename.
 *
 * Same lesson `spokenMessage` already carries, and the reason this exists is
 * that the earlier fix covered the discussion events and left these three
 * beside them, unchecked.
 */
export function sessionMarkEvents(
  teamName: string,
  now = Date.now(),
): readonly { readonly type: string; readonly data: Record<string, unknown> }[] {
  return [
    // Turn ONE. `turn` is a counter dsh continues from, not a slot for a
    // sentinel, and its persistence layer refuses anything below 1.
    { type: "turn/start", data: { turn: 1 } },
    {
      type: "user/message",
      data: {
        id: `squad-mark-${now.toString(36)}`,
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: `团队「${teamName}」的新一场工作。讨论在「团队」标签页。` }],
      },
    },
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ];
}

/** The tag naming the command a reply answers, when one is needed. See `commands.ts`. */
function replyTag(record: TeamRecord, command: Command | undefined): string {
  return command === undefined ? "" : tagFor(command, record.commandSeq);
}

function viewOfCommand(record: TeamRecord, command: Command): CommandView {
  return {
    commandId: command.commandId,
    instruction: command.instruction,
    at: command.at,
    state: command.state,
    seats: command.seatIds.map((seatId) => ({
      seatId,
      // The current name when the seat is still here: a renamed seat is the
      // same member, and the old name would point at nobody on screen.
      displayName:
        record.seats.find((seat) => seat.seatId === seatId)?.displayName ?? command.names.get(seatId) ?? seatId,
      state: command.seats.get(seatId) ?? "queued",
    })),
    ...(command.note === undefined ? {} : { note: command.note }),
    ...(command.withdrawn === true ? { withdrawn: true } : {}),
  };
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
