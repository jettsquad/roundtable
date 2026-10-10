/**
 * doing.ts — what a Codex seat has started and not finished.
 *
 * `codex exec --json` brackets each thing it does: `item.started` when it
 * begins and `item.completed`, with the same id, when it ends. Captured from
 * a live run (0.162), where a command the model chose to leave running showed
 * up exactly like any other — an item that had started and not completed:
 *
 *   {"type":"item.started","item":{"id":"item_2","type":"command_execution",
 *     "command":"/bin/zsh -lc 'sleep 4 && echo fg-done'","status":"in_progress"}}
 *   {"type":"item.completed","item":{"id":"item_2", … "exit_code":0}}
 *
 * So there is no separate background case to handle here, unlike the Claude
 * backend: an open item is an open item.
 */
import { jsonLineFeeder, shownCommand, type OpenCommand, type StreamTracker } from "@squad/seat-runtime";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Items that are the model speaking or thinking, not something it is waiting on. */
const NOT_WORK = new Set(["agent_message", "reasoning"]);

/** `/bin/zsh -lc '…'` is how the CLI runs everything; the part inside is what was asked. */
function unwrapped(command: string): string {
  return /^\S*sh -lc (['"])([\s\S]*)\1$/.exec(command.trim())?.[2] ?? command;
}

export function codexTracker(): StreamTracker {
  const open = new Map<string, OpenCommand>();
  let lastWords: string | undefined;

  const feed = jsonLineFeeder((event, at) => {
    const item = event["item"];
    if (typeof item !== "object" || item === null) return;
    const fields = item as Record<string, unknown>;
    const id = text(fields["id"]);
    const kind = text(fields["type"]);
    if (event["type"] === "item.completed") {
      open.delete(id);
      if (kind === "agent_message" && text(fields["text"]).trim() !== "") lastWords = text(fields["text"]).trim();
      return;
    }
    if (event["type"] !== "item.started" || id === "" || NOT_WORK.has(kind)) return;
    const command = text(fields["command"]);
    open.set(id, {
      id,
      tool: kind,
      command: shownCommand(command === "" ? kind : unwrapped(command)),
      startedAt: at,
      background: false,
    });
  });

  return { feed, open: () => [...open.values()], lastWords: () => lastWords };
}
