/**
 * timeline.ts — turning selected events into the lines a seat reads.
 *
 * The second of assembly's two layers. `window.ts` decided WHICH events
 * travel; this decides HOW they read. In 1.x the two layers kept separate
 * event lists and disagreed: this one ended in a catch-all that returned
 * nothing for any kind it had not been taught, and the context checkpoint
 * fell through it. The window had correctly cut history off at the
 * checkpoint, and then the checkpoint itself never reached the model.
 * History gone, replacement gone, no error anywhere.
 *
 * So there is no catch-all. Every kind is in exactly one of three tables,
 * and a kind in none of them throws at the moment it is introduced.
 *
 *   RENDERED   — the discussion, and the checkpoint standing in for the
 *                part of it that was folded away.
 *   IGNORED    — bookkeeping that legitimately sits on a host session and
 *                carries nothing a seat should read.
 *   FORBIDDEN  — proof that the host node ran an LLM turn.
 *
 * That third table is the part 1.x had no equivalent of. The host node is an
 * anchor and never a decider; if its model ever takes a turn, an LLM is
 * chairing the meeting, which is the one thing this product must not be. A
 * turn leaves `turn/start`, `assistant/message` and their relatives in the
 * log. Filing those under IGNORED would make the assembler the one component
 * that saw the violation and said nothing — the same silent-drop failure as
 * 1.x, one level up. They throw instead.
 */
import { stripReasoning } from "@squad/shared";
import { CHECKPOINT_KIND, type SelectableEvent } from "./window.ts";

/** The dsh event type the table writes one line of the discussion as. */
export const SPEECH_KIND = "user/message";

/**
 * Says what the checkpoint is, in the prompt itself. Without this line a
 * checkpoint reads as somebody's opinion; with it, a seat knows the earlier
 * detail still exists and can be asked for.
 */
export const CHECKPOINT_TIMELINE_PREFIX =
  "【上下文检查点】以下是此前讨论的要点。需要原文时，可以请主持人引用相应发言。";

/**
 * Kinds that legitimately appear on a host session and carry nothing a seat
 * should read: lifecycle, titling, request bookkeeping, and the control
 * events whose whole effect is on assembly rather than on content.
 *
 * `checkpointRevoked` is here because the window layer has already consumed
 * it: by the time an event list reaches this layer, a revoked checkpoint is
 * gone and the marker itself has no reader.
 */
export const TIMELINE_IGNORED_KINDS: ReadonlySet<string> = new Set([
  "agent-preset/selected",
  "agent/inbox/spliced",
  "approval/asked",
  "approval/decided",
  "approval/policy",
  "checkpointRevoked",
  "command/done",
  "command/run",
  "compaction/end",
  "compaction/prune",
  "compaction/start",
  "compaction/summary",
  "feedback/record",
  "goal/change",
  "hook/invoked",
  "hook/result",
  "llm/retry",
  "llm/retry-started",
  "permission/preset",
  "plan/mode",
  "request/context",
  "request/header",
  "sandbox/mode",
  "schedule/change",
  "session/end-seed",
  "session/title",
  "session/title-llm-request",
  "subagent/descriptor",
  "todo/write",
  "web/deepseek-search-llm-request",
]);

/**
 * Kinds a host node's log must never contain, because only a turn produces
 * them. Their presence is not a rendering question — it means the anchor
 * spoke.
 */
export const HOST_TURN_KINDS: ReadonlySet<string> = new Set([
  "assistant/chunk",
  "assistant/message",
  "step/end",
  "step/start",
  "tool-workflow/agent-end",
  "tool-workflow/agent-start",
  "tool-workflow/run-end",
  "tool-workflow/run-start",
  "tool/call",
  "tool/code-dispatch",
  "tool/code-dispatch-start",
  "tool/result",
  "turn/end",
  "turn/start",
]);

const asString = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);

/**
 * Render one selected event, or `undefined` when the kind is deliberately not
 * shown. Throws on a host-turn kind, and on a kind in none of the tables.
 */
export const renderTimelineEvent = (event: SelectableEvent): string | undefined => {
  switch (event.kind) {
    case SPEECH_KIND:
      // Stripped again here, not only where the reply was produced: the log
      // keeps what was recorded, and turns recorded before replies were
      // cleaned would otherwise go on feeding their reasoning to a seat.
      return stripReasoning(asString(event.text ?? event.message, ""));
    case CHECKPOINT_KIND:
      return `${CHECKPOINT_TIMELINE_PREFIX}\n\n${asString(event.text ?? event.message, "")}`;
    default:
      if (TIMELINE_IGNORED_KINDS.has(event.kind)) return undefined;
      if (HOST_TURN_KINDS.has(event.kind)) {
        throw new Error(
          `装配层在主持人日志里看到了「${event.kind}」——只有跑过一个回合才会留下它。` +
            `主持人节点是锚点不是决策者，它一旦跑回合就是让 LLM 当主持人。` +
            `检查是谁唤醒了它（followup() 会，session.append() 不会）。`,
        );
      }
      throw new Error(
        `装配层遇到未知事件类型「${event.kind}」。` +
          `请把它加入 TIMELINE_IGNORED_KINDS、HOST_TURN_KINDS，或为它写一个渲染分支——` +
          `静默丢弃会让席位看不见本该看见的内容，而且不报错。`,
      );
  }
};

/** Render a whole window in transcript order, dropping only the ignored kinds. */
export const renderTimeline = (events: readonly SelectableEvent[]): readonly string[] =>
  events.flatMap((event) => {
    const line = renderTimelineEvent(event);
    return line === undefined ? [] : [line];
  });
