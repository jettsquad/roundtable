/**
 * service.ts — `ctx.secretary`: the one seat allowed to do judgement work.
 *
 * Stateless by construction. Every call opens a fresh one-shot subagent and
 * throws it away, and every input the task needs is fed in by the caller —
 * a continuation checkpoint carries the previous one in its prompt rather
 * than in any memory here. Nothing accumulates, so nothing drifts between
 * calls, and two callers cannot see different secretaries.
 *
 * It has no agent of its own. dsh requires a parent Agent for every subagent
 * (cwd, lineage, authority), so the caller supplies the team's host node. The
 * secretary is therefore a task the host performs, not a member of the team
 * with standing of its own.
 *
 * Nothing here is optional-on-failure. A checkpoint becomes the basis of every
 * later round, so a malformed one does not degrade this call — it degrades
 * everything downstream, quietly. Output that does not validate is refused.
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SubagentStartRequest } from "@deepseek-ai/dsh-subagent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm/types";
import { stripReasoning } from "@squad/shared";
import type { CheckpointPromptInput } from "./checkpoint.ts";
import { writeCheckpointWith, writeTerminationWith, type TerminationInput, type TextTaskRunner } from "./tasks.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    secretary: SecretaryService;
  }
}

/** How one secretary task is run. */
export interface SecretaryRun {
  /**
   * The team's host node. Supplies cwd, lineage and authority — the secretary
   * reads and writes in the same project folder the team works in.
   */
  readonly parent: Agent;
  /**
   * dsh provider name for the secretary seat's backend. Defaults to
   * `claude-code`; a team whose secretary runs elsewhere passes its own.
   */
  readonly provider?: string;
  readonly signal?: AbortSignal;
}

export type WriteCheckpointInput = CheckpointPromptInput & SecretaryRun;

/** Everything the hand-off needs, fed in by the caller — nothing is remembered here. */
export type WriteTerminationInput = TerminationInput & SecretaryRun;

const DEFAULT_PROVIDER = "claude-code";

export class SecretaryService extends Service {
  static readonly inject = ["subagents"];

  constructor(ctx: Context) {
    super(ctx, "secretary");
  }

  async writeCheckpoint(input: WriteCheckpointInput): Promise<string> {
    return writeCheckpointWith(this.runner(input), input);
  }

  async writeTermination(input: WriteTerminationInput): Promise<string> {
    return writeTerminationWith(this.runner(input), input);
  }

  /** A runner backed by one fresh one-shot subagent per task, thrown away after. */
  private runner(run: SecretaryRun): TextTaskRunner {
    return async (label, prompt) => {
      const request: SubagentStartRequest = {
        label,
        prompt: [{ type: "text", text: prompt }],
        parent: run.parent,
        signal: run.signal ?? new AbortController().signal,
      };
      const started = await this.ctx.subagents.start(run.provider ?? DEFAULT_PROVIDER, request);
      const result = await started.result;
      return { text: stripReasoning(textOf(result.output)), stopReason: result.stopReason };
    };
  }
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
