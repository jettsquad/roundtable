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
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm/types";

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
