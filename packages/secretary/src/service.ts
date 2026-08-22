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
import { providerForSeat, SEAT_PROVIDER, stripReasoning } from "@squad/shared";
import type { CheckpointPromptInput } from "./checkpoint.ts";
import type { AgendaSpec } from "@squad/shared";
import type { AgendaDraftInput } from "./agenda.ts";
import {
  draftAgendaWith,
  writeCheckpointWith,
  writeTerminationWith,
  type TerminationInput,
  type TextTaskRunner,
} from "./tasks.ts";

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
   * The designated secretary seat, whole.
   *
   * ONE field rather than a persona and a provider, because passing them
   * separately is how this broke: `@squad/context` passed the persona and
   * forgot the provider, so the secretary's model, connection and permission
   * mode were stored, rendered in the Agent library, and ignored — the
   * folding ran on the host's bare login. Two derived fields can be
   * half-supplied; one object cannot.
   *
   * The standing instructions travel as `persona`, which the fenced provider
   * appends to the CLI's own system prompt rather than replacing it. This is
   * what makes `isSecretary` mean something: designating a seat changes both
   * who does the judgement work and what it is done under.
   */
  readonly secretary?: SecretarySeat | undefined;
  /**
   * dsh provider name, for a caller with no designated seat.
   *
   * Ignored when `secretary` is given — that seat's own provider wins, and a
   * caller supplying both is asking for the seat it named.
   */
  readonly provider?: string;
  readonly signal?: AbortSignal;
}

/** What the secretary needs to know about the seat doing the work. */
export interface SecretarySeat {
  readonly systemPrompt: string;
  readonly backend: string;
  readonly connectionId?: string | undefined;
  readonly permissionMode?: string | undefined;
}

export type WriteCheckpointInput = CheckpointPromptInput & SecretaryRun;

export type DraftAgendaInput = AgendaDraftInput & SecretaryRun;

/** Everything the hand-off needs, fed in by the caller — nothing is remembered here. */
export type WriteTerminationInput = TerminationInput & SecretaryRun;

// Fenced by default: the secretary is exactly where 1.x went wrong, drafting
// an agenda by spawning its own agents instead of naming the seats it had.
const DEFAULT_PROVIDER = SEAT_PROVIDER;

export class SecretaryService extends Service {
  static readonly inject = ["subagents"];

  constructor(ctx: Context) {
    super(ctx, "secretary");
  }

  async draftAgenda(input: DraftAgendaInput): Promise<AgendaSpec> {
    return draftAgendaWith(this.runner(input), input);
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
        ...(run.secretary === undefined || run.secretary.systemPrompt.trim() === ""
          ? {}
          : { persona: run.secretary.systemPrompt }),
      };
      // The named seat's own provider wins. Derived here, from the seat, so
      // no caller can supply the standing instructions without the model they
      // are meant to run under.
      const provider =
        run.secretary === undefined ? (run.provider ?? DEFAULT_PROVIDER) : providerForSeat(run.secretary);
      const started = await this.ctx.subagents.start(provider, request);
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
