/**
 * log.ts — the team's record of what was said: one place to write a line, one
 * place to read them back.
 *
 * Everything else in the table goes through `TeamLog` and none of it knows
 * where the lines are kept. That is the point of this file existing. The
 * record used to be reached by calling `host.session.append` and
 * `host.session.snapshotEvents` wherever one was needed, which tied thirty
 * call sites to dsh's session log — and dsh's log format is dsh's to change:
 * 0.1.2 began demanding a `surfaceOp` on every message, and 0.1.5's format
 * migration refuses outright a log that has messages before any step, which
 * is every log a host node has ever written. A record that has to move needs
 * one door, not thirty.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm/types";
import { dshHome } from "@squad/seat-runtime";

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

/** The team's record. Append-only; nothing recorded is ever changed or removed. */
export interface TeamLog {
  /**
   * Write one line, and return its turn id.
   *
   * `turnId` is supplied when the line already has an identity — a command's
   * own id, or a migrated turn that checkpoints point at. Otherwise one is
   * minted.
   */
  append(speaker: string, text: string, turnId?: string): string;
  /**
   * Every event, in order, nothing filtered.
   *
   * Lines of discussion carry their text; anything else travels with empty
   * text so a reader still sees its KIND — one of the assembler's tables
   * exists to catch kinds that prove the host node ran a turn.
   */
  events(): readonly TranscriptEvent[];
  /** How many events there are. Zero is a sitting nobody has touched. */
  size(): number;
}

/**
 * The record kept on the host node's own dsh session.
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
export function sessionTeamLog(host: Agent): TeamLog {
  return {
    append(speaker, text, turnId) {
      const message = spokenMessage(speaker, text, turnId);
      host.session.append(
        "user/message",
        message as never,
        // `SurfaceOp` is the literal 'append', not an object. Every
        // surface-eligible event must declare how it joins the ordered surface
        // that model history is derived from.
        { surfaceOp: "append" } as never,
      );
      return message["id"] as string;
    },
    events: () => eventsOf(host),
    size: () => host.session.snapshotEvents().length,
  };
}

/** A fresh id for one line of the record. */
export function newTurnId(): string {
  return `squad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
    id: turnId ?? newTurnId(),
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
function eventsOf(host: Agent): readonly TranscriptEvent[] {
  // `snapshotEvents()`, not `.events`. 0.1.2 replaced the property with an
  // explicit range snapshot; the no-argument call is the whole log, and it is
  // frozen, which is what a reader wants anyway.
  return host.session.snapshotEvents().map((event) => {
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

/** The text of a list of content blocks, joined. */
export const textOf = (blocks: readonly ContentBlock[]): string =>
  blocks
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block && typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("")
    .trim();

// ── Squad's own copy of the record ──────────────────────────────────────────

/** The dsh event type one line of discussion is recorded as. */
const SPEECH = "user/message";

/**
 * Where one team's record is kept.
 *
 * Under dsh's home but in Squad's own folder, in Squad's own format: one
 * JSON object per line, appended and never rewritten. Not in the storage
 * domain the rest of Squad uses — that one rewrites its whole file on every
 * save, and a record grows by a line a minute for as long as a team works.
 */
export function recordPath(teamId: string): string {
  return join(dshHome(), "squad-records", `${teamId}.jsonl`);
}

/** Read a record file. Throws on a line that is not an event, naming it. */
export function readRecordFile(path: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${path} 第 ${index + 1} 行不是 JSON。`);
    }
    const event = parsed as Partial<TranscriptEvent>;
    if (
      typeof event.kind !== "string" ||
      typeof event.text !== "string" ||
      typeof event.turnId !== "string" ||
      typeof event.at !== "number"
    ) {
      throw new Error(`${path} 第 ${index + 1} 行不是一条记录。`);
    }
    events.push({ kind: event.kind, text: event.text, turnId: event.turnId, at: event.at });
  }
  return events;
}

const lineOf = (event: TranscriptEvent): string =>
  `${JSON.stringify({ turnId: event.turnId, kind: event.kind, at: event.at, text: event.text })}\n`;

/**
 * What to append to the file so it holds everything the dsh session does.
 *
 * Only lines of DISCUSSION are caught up on. A session's other events are
 * numbered rather than named (`seq-12`), and once a host node is replaced by
 * a fresh one those numbers start again — matching on them would either skip
 * a line that is new or copy one that is not.
 *
 * Pure, so the rule is tested without a disk.
 */
export function missingFromFile(
  file: readonly TranscriptEvent[],
  session: readonly TranscriptEvent[],
): readonly TranscriptEvent[] {
  const have = new Set(file.map((event) => event.turnId));
  return session.filter((event) => event.kind === SPEECH && !have.has(event.turnId));
}

/** How the file and the dsh session compare, for one team. */
export interface RecordCheck {
  /** Lines of discussion in Squad's own file. */
  readonly lines: number;
  /** Lines of discussion in the dsh session, when it could be read. */
  readonly sessionLines: number;
  /** Session lines the file does not have. Should always be empty. */
  readonly missing: readonly string[];
  /** Lines both have whose text differs. Should always be empty. */
  readonly different: readonly string[];
  /** Which one the team is reading from right now. */
  readonly source: "file" | "session";
  /** Why it fell back to the session, when it did. */
  readonly problem?: string | undefined;
}

/** Compare the two copies. Pure. */
export function compareRecords(
  file: readonly TranscriptEvent[],
  session: readonly TranscriptEvent[],
): Pick<RecordCheck, "lines" | "sessionLines" | "missing" | "different"> {
  const byId = new Map(file.filter((event) => event.kind === SPEECH).map((event) => [event.turnId, event.text]));
  const spoken = session.filter((event) => event.kind === SPEECH);
  return {
    lines: byId.size,
    sessionLines: spoken.length,
    missing: spoken.filter((event) => !byId.has(event.turnId)).map((event) => event.turnId),
    different: spoken
      .filter((event) => byId.has(event.turnId) && byId.get(event.turnId) !== event.text)
      .map((event) => event.turnId),
  };
}

/** A `TeamLog` that can also say how its two copies compare. */
export interface StoredTeamLog extends TeamLog {
  check(): RecordCheck;
}

/**
 * The team's record, kept in Squad's own file — with the dsh session still
 * written alongside.
 *
 * The FILE is what is read. It is filled from the session the first time a
 * team is opened under this code, every event in order, so a checkpoint that
 * names the entry it covers up to still finds it; after that each line goes
 * to both. Writing the session as well costs nothing today and is what lets
 * the previous build be gone back to with nothing missing.
 *
 * Why the record moved at all: a dsh session is an agent's conversation, and
 * dsh keeps changing what one must look like. A host node is not an agent,
 * and its log has broken dsh's expectations twice. Squad's record should not
 * be something a dsh upgrade can make unreadable.
 *
 * Anything going wrong with the file falls back to the session and SAYS so —
 * `check().problem` — because a team that silently read a stale copy would
 * look fine and be missing its newest lines.
 */
export function storedTeamLog(host: Agent, path: string, report: (message: string) => void): StoredTeamLog {
  const session = sessionTeamLog(host);
  let events: TranscriptEvent[] | undefined;
  let problem: string | undefined;
  try {
    if (existsSync(path)) {
      events = readRecordFile(path);
      // Lines the session got that the file did not: a build from before this
      // file existed ran in between, or the process died between the two writes.
      const behind = missingFromFile(events, session.events());
      if (behind.length > 0) {
        appendFileSync(path, behind.map(lineOf).join(""), "utf8");
        events.push(...behind);
      }
    } else {
      // The first time. Written beside the final name and renamed into place,
      // so a crash halfway leaves no file — which is tried again — rather
      // than half of one, which would be taken for the whole record.
      const all = [...session.events()];
      mkdirSync(dirname(path), { recursive: true });
      const partial = `${path}.partial`;
      writeFileSync(partial, all.map(lineOf).join(""), "utf8");
      renameSync(partial, path);
      events = all;
    }
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
    report(`讨论记录文件 ${path} 用不了，这一场改从 dsh 会话读：${problem}`);
    events = undefined;
  }

  return {
    append(speaker, text, turnId) {
      let id = turnId ?? newTurnId();
      // The session first, and not fatally: it is the copy that keeps the
      // previous build usable, not the one this build reads.
      try {
        id = session.append(speaker, text, id);
      } catch (error) {
        if (events === undefined) throw error;
        report(`这条发言没能写进 dsh 会话（记录文件里有）：${error instanceof Error ? error.message : String(error)}`);
      }
      if (events !== undefined) {
        // Trimmed, as the session's own reader trims — the two copies are
        // compared line for line, and trailing whitespace is not a difference.
        const event: TranscriptEvent = {
          kind: SPEECH,
          text: `【${speaker}】${text}`.trim(),
          turnId: id,
          at: Date.now(),
        };
        try {
          appendFileSync(path, lineOf(event), "utf8");
          events.push(event);
        } catch (error) {
          // The session has the line; read from there from now on rather
          // than from a file that is now one line short.
          problem = error instanceof Error ? error.message : String(error);
          report(`讨论记录文件 ${path} 写不进去，这一场改从 dsh 会话读：${problem}`);
          events = undefined;
        }
      }
      return id;
    },
    events: () => events ?? session.events(),
    size: () => (events ?? session.events()).length,
    check() {
      const compared = compareRecords(events ?? [], session.events());
      return {
        ...compared,
        source: events === undefined ? "session" : "file",
        ...(problem === undefined ? {} : { problem }),
      };
    },
  };
}
