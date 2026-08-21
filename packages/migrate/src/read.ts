/**
 * read.ts — reading a 1.x team, and refusing to guess.
 *
 * Migration runs once, against data that cannot be regenerated: these are
 * real discussions the user had. So the rule throughout is that anything not
 * understood is REPORTED, never dropped and never invented. A migration that
 * silently loses a checkpoint produces a team that looks migrated and has a
 * hole in its history — and nobody will find it, because the only evidence it
 * ever existed was the thing that got lost.
 *
 * This module is pure: 1.x bytes in, a plan out. Applying the plan needs a
 * running harness, but deciding what the plan IS does not, and that is the
 * part with all the ways to be wrong.
 */

/** 1.x's on-disk layout: `<root>/teams/<teamId>/{team.json,events.log}`. */
export interface LegacyTeam {
  readonly config: unknown;
  /** One parsed JSON object per line of events.log. */
  readonly events: readonly Record<string, unknown>[];
}

/** One line of discussion, as 2.0 records it. */
export interface PlannedLine {
  readonly speaker: string;
  readonly text: string;
  /** 1.x identity, kept so checkpoint coverage can still be resolved. */
  readonly turnId: string;
}

export interface PlannedCheckpoint {
  readonly checkpointId: string;
  readonly text: string;
  readonly coversUpTo: string;
  readonly createdAt: number;
  readonly revokedAt?: number | undefined;
}

export interface MigrationPlan {
  readonly teamId: string;
  readonly displayName: string;
  readonly projectFolder: string;
  readonly hostDisplayName: string;
  readonly checkpointCoefficient?: number | undefined;
  readonly seats: readonly {
    readonly seatId: string;
    readonly displayName: string;
    readonly role: string;
    readonly systemPrompt: string;
    readonly backend: "claude-code" | "codex" | "dsh";
    readonly isSecretary?: boolean;
  }[];
  readonly lines: readonly PlannedLine[];
  readonly checkpoints: readonly PlannedCheckpoint[];
  readonly artifacts: readonly string[];
  /**
   * Everything this migration could not account for.
   *
   * Not warnings to be skimmed. A non-empty list means the plan is
   * incomplete, and the tool refuses to apply one rather than producing a
   * team whose gaps are invisible.
   */
  readonly unaccounted: readonly string[];
}

/** 1.x backends map onto 2.0 provider-backed seats one for one. */
const BACKEND: Readonly<Record<string, "claude-code" | "codex" | "dsh">> = {
  "claude-code": "claude-code",
  codex: "codex",
  "deepseek-harness": "dsh",
};

/**
 * Kinds that legitimately carry nothing to migrate: 1.x lifecycle, progress
 * and UI bookkeeping. Listed rather than ignored by default.
 */
const IGNORED_KINDS = new Set([
  "phaseStart",
  "discussionTurnStart",
  "discussionPhaseDone",
  "waitingForHost",
  "secretaryIntervention",
  "stopped",
  "error",
  "agentActivity",
  "teamAgendaDrafted",
  "teamAgendaConfirmed",
  "teamAgendaCancelled",
  "teamAgendaTerminated",
  "agendaTerminationArchiveFailed",
  "teamMembersUpdated",
]);

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const identityOf = (event: Record<string, unknown>, index: number): string => str(event["turnId"]) ?? `legacy-${index}`;

const timeOf = (event: Record<string, unknown>): number => {
  const parsed = Date.parse(str(event["ts"]) ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Build the plan for one 1.x team.
 *
 * Seat resolution is by id against the config, so a reply from a seat the
 * config never listed is reported rather than attributed to a name invented
 * from the id.
 */
export function planMigration(team: LegacyTeam): MigrationPlan {
  const config = team.config as Record<string, unknown>;
  const unaccounted: string[] = [];

  const teamId = str(config["teamId"]);
  if (teamId === undefined) throw new Error("team.json 里没有 teamId，无法迁移。");

  const rawSeats = Array.isArray(config["seats"]) ? (config["seats"] as Record<string, unknown>[]) : [];
  if (rawSeats.length === 0) throw new Error(`团队 ${teamId} 的 team.json 里没有席位。`);

  const secretarySeatId = str(config["secretarySeatId"]);
  const seats = rawSeats.map((seat) => {
    const seatId = str(seat["seatId"]) ?? "";
    const legacyBackend = str(seat["backend"]) ?? "";
    const backend = BACKEND[legacyBackend];
    if (backend === undefined) {
      unaccounted.push(`席位 ${seatId} 的后端「${legacyBackend}」在 2.0 里没有对应项`);
    }
    return {
      seatId,
      displayName: str(seat["displayName"]) ?? seatId,
      role: str(seat["role"]) ?? "",
      // 1.x allowed a seat with no system prompt; 2.0 requires one, and an
      // empty string is honest about there having been nothing there.
      systemPrompt: str(seat["systemPrompt"]) ?? "",
      backend: backend ?? "claude-code",
      ...(secretarySeatId !== undefined && seatId === secretarySeatId ? { isSecretary: true } : {}),
    };
  });

  const nameOf = new Map(seats.map((seat) => [seat.seatId, seat.displayName]));
  const hostDisplayName = str(config["hostDisplayName"]) ?? "主持人";

  const lines: PlannedLine[] = [];
  const checkpoints: PlannedCheckpoint[] = [];
  const revoked = new Set<string>();
  const artifacts: string[] = [];

  // Dispatched by an explicit table, like the timeline renderer's, and for
  // the same reason: every kind is either handled, listed as carrying
  // nothing, or reported. A catch-all would drop the kinds this was never
  // taught about, and the evidence they mattered is exactly what would go.
  for (const [index, event] of team.events.entries()) {
    const kind = str(event["kind"]);
    if (kind === undefined) {
      unaccounted.push(`第 ${index + 1} 条事件没有 kind`);
      continue;
    }
    if (kind === "hostMessage") {
      lines.push({ speaker: hostDisplayName, text: str(event["text"]) ?? "", turnId: identityOf(event, index) });
      continue;
    }
    if (kind === "discussionTurnEnd") {
      const seatId = str(event["seatId"]) ?? "";
      const speaker = nameOf.get(seatId);
      if (speaker === undefined) {
        unaccounted.push(`第 ${index + 1} 条发言来自名册上没有的席位「${seatId}」`);
        continue;
      }
      lines.push({ speaker, text: str(event["message"]) ?? "", turnId: identityOf(event, index) });
      continue;
    }
    if (kind === "contextCheckpoint") {
      const checkpointId = str(event["checkpointId"]) ?? `legacy-cp-${index}`;
      // Cut at coversUpTo when 1.x recorded one; otherwise at this event's own
      // position, which is what 1.x did before that field existed and is
      // correct whenever nothing ran while the checkpoint was being written.
      const coversUpTo = str(event["coversUpTo"]) ?? lines[lines.length - 1]?.turnId;
      if (coversUpTo === undefined) {
        unaccounted.push(`检查点 ${checkpointId} 之前没有任何发言，无法确定它覆盖到哪`);
        continue;
      }
      checkpoints.push({ checkpointId, text: str(event["text"]) ?? "", coversUpTo, createdAt: timeOf(event) });
      continue;
    }
    if (kind === "checkpointRevoked") {
      const checkpointId = str(event["checkpointId"]);
      if (checkpointId === undefined) {
        unaccounted.push(`第 ${index + 1} 条作废事件没有 checkpointId`);
        continue;
      }
      revoked.add(checkpointId);
      continue;
    }
    if (kind === "artifactWritten") {
      const path = str(event["path"]);
      if (path === undefined) {
        unaccounted.push(`第 ${index + 1} 条落盘事件没有 path`);
        continue;
      }
      artifacts.push(path);
      continue;
    }
    if (IGNORED_KINDS.has(kind)) continue;
    // No catch-all. A kind this was never taught about is reported, because
    // the only evidence it mattered is the thing that would be dropped.
    unaccounted.push(`第 ${index + 1} 条事件的类型「${kind}」不认识`);
  }

  const withRevocation = checkpoints.map((checkpoint) =>
    revoked.has(checkpoint.checkpointId) ? { ...checkpoint, revokedAt: checkpoint.createdAt } : checkpoint,
  );
  for (const id of revoked) {
    if (!checkpoints.some((checkpoint) => checkpoint.checkpointId === id)) {
      unaccounted.push(`作废了一个不存在的检查点 ${id}`);
    }
  }

  const coefficient = config["checkpointCoefficient"];
  return {
    teamId,
    displayName: str(config["displayName"]) ?? teamId,
    projectFolder: str(config["projectFolder"]) ?? "",
    hostDisplayName,
    ...(typeof coefficient === "number" ? { checkpointCoefficient: coefficient } : {}),
    seats,
    lines,
    checkpoints: withRevocation,
    artifacts,
    unaccounted,
  };
}
