/**
 * service.ts — `ctx.reasoning`: capture, distil, and wait for the human.
 *
 * User-level, not team-level. It deliberately does NOT inject `teams`: a
 * criteria library belongs to the person, not to any table, and injecting a
 * team would make it possible to write one that only exists inside a project
 * — which is the opposite of an asset you can take with you.
 *
 * Capture is limited to signals the program can identify with zero
 * ambiguity — the human overruled a machine proposal. Mining criteria out of
 * ordinary conversation is explicitly not done: it is noisy, and worse, it
 * harvests CONCLUSIONS ("he picked Postgres") rather than STANDARDS ("he
 * requires a migration-cost estimate before accepting a choice"). That
 * distinction is the whole system's life or death, so the intake stays narrow
 * until the narrow part works.
 *
 * Nothing here activates a criterion on its own. The system would be editing
 * its own scoring rules, and a system that approves its own scoring changes
 * is grading itself. Everything lands in `proposals/` and waits.
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SubagentStartRequest } from "@deepseek-ai/dsh-subagent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm/types";
import { stripReasoning } from "@squad/shared";
import type { Criterion } from "./criterion.ts";
import { buildDistilPrompt, parseDistillation, type Distillation } from "./distil.ts";
import type { Situation } from "./situation.ts";
import { ReasoningStore } from "./store.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    reasoning: ReasoningService;
  }
}

export interface Config {
  /** The library directory. One user, one directory, physically. */
  readonly root: string;
  /** dsh provider name for the distilling model. */
  readonly provider?: string;
}

/** The three signals worth learning from. Only the first is wired. */
export type SignalKind = "veto" | "gate-failure" | "explicit-mark";

export interface LearningSignal {
  readonly kind: SignalKind;
  readonly situation: Situation;
  /** What the machine proposed. */
  readonly proposed: string;
  /** What the human made of it — the moment a standard becomes visible. */
  readonly verdict: string;
  readonly reason?: string | undefined;
  readonly project?: string | undefined;
  /** Parent agent for the distilling task; supplies cwd and lineage. */
  readonly parent: Agent;
}

export interface CaptureResult {
  readonly instanceId: string;
  readonly proposal: Criterion;
  readonly relation: Distillation["relation"];
}

export type Verdict = "accept" | "reject";

export class ReasoningService extends Service {
  static readonly inject = ["subagents"];

  private readonly store: ReasoningStore;
  private readonly config: Config;

  constructor(ctx: Context, config: Config) {
    super(ctx, "reasoning");
    // Written out rather than declared as a constructor parameter property:
    // dsh runs our .ts directly through Node's strip-only type removal, which
    // rejects that syntax. It type-checks and it unit-tests; it only fails at
    // boot, so lint bans it now.
    this.config = config;
    this.store = new ReasoningStore(config.root);
  }

  async [Service.init](): Promise<void> {
    await this.store.init();
  }

  /**
   * Record what just happened and draft a proposal from it.
   *
   * The instance is written FIRST, before the model is asked anything. The
   * occurrence is a fact and the distillation is an opinion about it; if the
   * model call fails, the fact must still be on disk. Writing it afterwards
   * would lose exactly the cases where the system was least sure what to make
   * of them, which are the ones worth having.
   */
  async capture(signal: LearningSignal): Promise<CaptureResult> {
    const instanceId = `i-${stamp()}`;
    await this.store.putInstance({
      id: instanceId,
      situation: signal.situation,
      proposed: signal.proposed,
      verdict: signal.verdict,
      ...(signal.reason === undefined ? {} : { reason: signal.reason }),
      ...(signal.project === undefined ? {} : { project: signal.project }),
      at: new Date().toISOString(),
    });

    const candidates = await this.candidatesFor(signal.situation);
    const reply = await this.runTask(
      signal.parent,
      "Lil X · 提炼",
      buildDistilPrompt({
        situation: signal.situation,
        proposed: signal.proposed,
        verdict: signal.verdict,
        ...(signal.reason === undefined ? {} : { reason: signal.reason }),
        candidates,
      }),
    );
    const distilled = parseDistillation(reply, candidates);

    // Reinforce and revise inherit the existing criterion's evidence so the
    // scale of confidence keeps counting; a proposal that reset it would make
    // a long-supported criterion look new every time it was touched.
    const existing =
      distilled.criterionId === undefined
        ? undefined
        : candidates.find((candidate) => candidate.id === distilled.criterionId);
    const proposal: Criterion = {
      id: existing?.id ?? `c-${stamp()}`,
      trigger: existing?.trigger ?? {
        action: [signal.situation.action],
        features: signal.situation.features,
        ...(signal.situation.step === undefined ? {} : { step: [signal.situation.step] }),
      },
      claim: distilled.relation === "reinforce" && existing !== undefined ? existing.claim : distilled.claim,
      ...(distilled.boundary === undefined ? {} : { boundary: distilled.boundary }),
      evidence: [...(existing?.evidence ?? []), instanceId],
      status: "active",
    };
    await this.store.putProposal(proposal);
    return { instanceId, proposal, relation: distilled.relation };
  }

  /** Proposals waiting on the human. */
  async pending(): Promise<readonly Criterion[]> {
    return this.store.proposals();
  }

  /**
   * The human's ruling.
   *
   * `edited` exists because the most common useful outcome is neither yes nor
   * no — it is "nearly, but the claim is broader than I meant". Forcing that
   * into a reject loses the instance's evidence along with the wording.
   */
  async resolve(id: string, verdict: Verdict, edited?: Criterion): Promise<void> {
    const proposal = (await this.store.proposals()).find((candidate) => candidate.id === id);
    if (proposal === undefined) throw new Error(`没有待裁定的提议 ${id}。`);
    if (verdict === "accept") await this.store.putCriterion(edited ?? proposal);
    await this.store.dropProposal(id);
  }

  /** Everything currently active. */
  async criteria(): Promise<readonly Criterion[]> {
    return this.store.criteria();
  }

  /**
   * Coarse filter: criteria whose trigger this situation satisfies.
   *
   * Cheap and deterministic, and deliberately no similarity model behind it.
   * At one user's scale, handing the survivors to a model beats any
   * similarity score, because a model can read 「适用边界」 and a score
   * cannot. Get it right before getting it fast — an embedding layer added
   * now would hide the actually hard problem, which is designing the trigger.
   */
  private async candidatesFor(situation: Situation): Promise<readonly Criterion[]> {
    const held = new Set(situation.features);
    return (await this.store.criteria()).filter(
      (criterion) =>
        criterion.status !== "retired" &&
        criterion.trigger.action.includes(situation.action) &&
        criterion.trigger.features.every((feature) => held.has(feature)),
    );
  }

  private async runTask(parent: Agent, label: string, prompt: string): Promise<string> {
    const request: SubagentStartRequest = {
      label,
      prompt: [{ type: "text", text: prompt }],
      parent,
      signal: new AbortController().signal,
    };
    const started = await this.ctx.subagents.start(this.config.provider ?? "claude-code", request);
    const result = await started.result;
    if (result.stopReason !== "completed") {
      throw new Error(`提炼任务未完成（${result.stopReason}），不采用。`);
    }
    return stripReasoning(textOf(result.output));
  }
}

const stamp = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const textOf = (blocks: readonly ContentBlock[]): string =>
  blocks
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block && typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("")
    .trim();
