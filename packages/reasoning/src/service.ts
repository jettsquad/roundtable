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
import { stripReasoning, type AgendaSpec } from "@squad/shared";
import { decideActivation, type ActivationDecision } from "./activation.ts";
import { checkAbstractness, type AbstractnessReport } from "./decontextualise.ts";
import { exportToPool, importAsCandidates, type ExportResult, type PoolEntry } from "./pool.ts";
import { healthOf, type Health } from "./usage.ts";
import type { Criterion } from "./criterion.ts";
import {
  DELIVERY_LIMIT,
  buildSelectionPrompt,
  formatForSystemChannel,
  parseSelection,
  triggerMatches,
} from "./deliver.ts";
import { buildDistilPrompt, parseDistillation, type Distillation } from "./distil.ts";
import type { Situation } from "@squad/shared";
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
  /**
   * Whether this went straight into the library or is waiting on the human,
   * and why. Always reported: a proposal that applied itself must not be
   * something the host discovers later by noticing the library changed.
   */
  readonly activation: ActivationDecision;
  readonly applied: boolean;
  /**
   * Whether the distilled claim is actually an abstract.
   *
   * §7.4's test, run where it pays: a claim that stops holding once its
   * context is stripped was never an abstract, it is an instance that got
   * mistaken for one. Reported rather than enforced — the human still rules,
   * and the useful response is a rewrite that finds the principle underneath,
   * which no check can do for them.
   */
  readonly abstractness: AbstractnessReport;
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
      // The distillation's chosen features when it gave any, and only then
      // the instance's. Copying the instance's makes the trigger exactly as
      // narrow as the single case behind it, which is how a criterion ends up
      // never being recalled — including on the very kind of decision it was
      // learned from. The step is deliberately NOT copied: a criterion learned
      // at one point in the framework is usually not confined to it, and a
      // step restriction is the narrowest possible filter.
      trigger: existing?.trigger ?? {
        action: [signal.situation.action],
        features: (distilled.triggerFeatures ?? signal.situation.features) as typeof signal.situation.features,
      },
      claim: distilled.relation === "reinforce" && existing !== undefined ? existing.claim : distilled.claim,
      ...(distilled.boundary === undefined ? {} : { boundary: distilled.boundary }),
      evidence: [...(existing?.evidence ?? []), instanceId],
      status: "active",
    };
    // Counted here rather than when the proposal is accepted: a
    // counter-example is a fact about the criterion the moment it is
    // observed, and whether the human keeps the resulting wording does not
    // change that something contradicted it. Counting only accepted ones
    // would make the third scale quietest exactly where disagreement is
    // sharpest.
    if (distilled.relation === "counter-example" && distilled.criterionId !== undefined) {
      await this.store.updateUsage(distilled.criterionId, (current) => ({
        ...current,
        counterExamples: current.counterExamples + 1,
      }));
    }

    // Only a reinforcement is ever eligible. Everything else edits what the
    // library claims, and a system approving its own edits to its scoring
    // rules is grading itself.
    const abstractness = checkAbstractness(`${proposal.claim}\n${proposal.boundary ?? ""}`, {
      names: signal.project === undefined ? [] : [signal.project],
    });

    const usage = await this.store.usage(proposal.id);
    const activation =
      distilled.relation === "reinforce"
        ? decideActivation({
            accepted: usage.accepted,
            rejected: usage.rejected,
            guardsIrreversible: proposal.trigger.features.includes("irreversible"),
          })
        : {
            auto: false,
            lowerBound: 0,
            reason: "below-confidence" as const,
            detail: `关系是「${distilled.relation}」，它改动了判据本身的表述，一律由人裁定。`,
          };

    if (activation.auto) {
      await this.store.putCriterion(proposal);
      return { instanceId, proposal, relation: distilled.relation, activation, applied: true, abstractness };
    }
    await this.store.putProposal(proposal);
    return { instanceId, proposal, relation: distilled.relation, activation, applied: false, abstractness };
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
    // The record the confidence bound is computed from. An edit counts as an
    // acceptance: the human kept the criterion and changed its wording, which
    // is agreement about the substance — counting it as a rejection would
    // make every improvement look like a failure.
    await this.store.updateUsage(id, (current) => ({
      ...current,
      accepted: current.accepted + (verdict === "accept" ? 1 : 0),
      rejected: current.rejected + (verdict === "reject" ? 1 : 0),
    }));
  }

  /** Everything currently active. */
  async criteria(): Promise<readonly Criterion[]> {
    return this.store.criteria();
  }

  /**
   * Prepare named criteria for the shared pool.
   *
   * Named, never "everything active": opting in one at a time is the whole
   * defence against averaging, and a method that took no argument would make
   * opting in the default.
   */
  async exportForPool(ids: readonly string[], names: readonly string[] = []): Promise<ExportResult> {
    const all = await this.store.criteria();
    const chosen = ids.map((id) => {
      const found = all.find((criterion) => criterion.id === id);
      if (found === undefined) throw new Error(`要导出的判据 ${id} 不在库里。`);
      return found;
    });
    return exportToPool(chosen, { names });
  }

  /**
   * Take arriving abstracts in as CANDIDATES.
   *
   * They land in `proposals/`, the same queue a locally distilled proposal
   * waits in. There is no code path from an import to an active criterion —
   * which is what makes "not a sync, not a replacement" a property of the
   * system rather than a promise in a document.
   */
  async importFromPool(entries: readonly PoolEntry[]): Promise<readonly Criterion[]> {
    const candidates = importAsCandidates(entries);
    for (const candidate of candidates) await this.store.putProposal(candidate);
    return candidates;
  }

  /**
   * The human's mark on whether a delivered criterion changed anything.
   *
   * A mark, not an inference. Whether a decision moved BECAUSE of a criterion
   * is not visible from here, and a proxy for it would produce a number that
   * looks like measurement and is not — which is worse than an empty column,
   * because an empty column asks to be filled.
   */
  async markOutcome(criterionId: string, outcome: "helpful" | "unhelpful"): Promise<void> {
    await this.store.updateUsage(criterionId, (current) => ({
      ...current,
      helpful: current.helpful + (outcome === "helpful" ? 1 : 0),
      unhelpful: current.unhelpful + (outcome === "unhelpful" ? 1 : 0),
    }));
  }

  /** Every criterion judged against the three scales. */
  async health(): Promise<readonly Health[]> {
    const all = await this.store.criteria();
    const report: Health[] = [];
    for (const criterion of all) {
      report.push(healthOf(await this.store.usage(criterion.id), criterion.evidence.length));
    }
    return report;
  }

  /**
   * Suspend criteria that the third scale has flagged, and say which.
   *
   * The design asks for this to be executed rather than merely computed: a
   * criterion with plenty of evidence and no counter-example is either solid
   * or unfalsifiable, and those look identical from outside. `suspect` still
   * surfaces in deliveries — it means "under review", not "withdrawn", and
   * hiding it would remove the thing most likely to attract the
   * counter-example that would settle it.
   */
  async review(): Promise<readonly Health[]> {
    const flagged = (await this.health()).filter((entry) => entry.verdict === "never-contradicted");
    for (const entry of flagged) {
      const criterion = (await this.store.criteria()).find((c) => c.id === entry.criterionId);
      if (criterion !== undefined && criterion.status === "active") {
        await this.store.putCriterion({ ...criterion, status: "suspect" });
      }
    }
    return flagged;
  }

  /**
   * The criteria worth surfacing for this situation. At most three.
   *
   * Two stages. A coarse trigger filter runs first — cheap, deterministic,
   * and no similarity model behind it: at one user's scale, handing the
   * survivors to a model beats any score, because a model can read
   * 「适用边界」 and a score cannot. Getting an embedding layer in early
   * would hide the actually hard problem, which is designing the trigger.
   *
   * The model then picks. It is skipped when the coarse filter already
   * returned few enough — paying for a model call to choose three out of
   * three buys nothing, and a call that cannot change the answer is a call
   * that can only fail.
   *
   * NOTHING here is handed to the table. These criteria go back to the
   * caller for the system channel; they shape how work is organised and
   * judged, never how a participant thinks. There is no path from here into
   * a seat's prompt, which is the point — a rule someone has to keep obeying
   * would not survive a year.
   */
  async locate(situation: Situation, parent?: Agent): Promise<readonly Criterion[]> {
    const candidates = (await this.store.criteria()).filter((criterion) => triggerMatches(criterion, situation));
    // Selection runs whenever there is anything to select from, not only when
    // the list is over budget. It used to be skipped for short lists on the
    // grounds that a call which cannot change the answer can only fail — true
    // while the filter was strict, false now that it deliberately over-fetches.
    // The permissive filter is only safe BECAUSE something downstream reads
    // 適用邊界 and drops what does not apply.
    if (candidates.length === 0) return [];
    if (parent === undefined) return this.recordDelivery(candidates.slice(0, DELIVERY_LIMIT));
    const reply = await this.runTask(parent, "Lil X · 精选", buildSelectionPrompt(situation, candidates));
    return this.recordDelivery(parseSelection(reply, candidates));
  }

  /**
   * Count a delivery against each criterion that was actually surfaced.
   *
   * Counted at DELIVERY, not at candidacy. "Never recalled" has to mean
   * "never put in front of anyone", or the first scale measures how the
   * filter behaves rather than whether the criterion was ever used — and the
   * filter is the thing that scale is supposed to indict.
   */
  private async recordDelivery(delivered: readonly Criterion[]): Promise<readonly Criterion[]> {
    const at = new Date().toISOString();
    for (const criterion of delivered) {
      await this.store.updateUsage(criterion.id, (current) => ({
        ...current,
        delivered: current.delivered + 1,
        lastDeliveredAt: at,
      }));
    }
    return delivered;
  }

  /**
   * One brief per phase of an agenda, for the system channel.
   *
   * Delivered when the host is looking at the DRAFT, not one phase at a time
   * as each opens. Two reasons, and neither is convenience. The table must
   * not be able to reach this service — that is what keeps criteria out of a
   * seat's prompt — so nothing inside a running agenda can ask for them. And
   * confirmation is when the host can still act: a criterion about how to
   * organise work arrives useless if it arrives after the work is organised.
   *
   * Phases that declared no situation are skipped rather than guessed at. A
   * guessed label files the delivery under a situation nobody chose, and the
   * criterion that then fires — or fails to — is unattributable.
   */
  async briefForAgenda(
    agenda: AgendaSpec,
    parent?: Agent,
  ): Promise<readonly { readonly phase: string; readonly brief: string }[]> {
    const briefs: { phase: string; brief: string }[] = [];
    for (const phase of agenda.phases) {
      if (phase.situation === undefined) continue;
      briefs.push({
        phase: phase.title,
        brief: await this.brief({ action: phase.situation.action, features: phase.situation.features }, parent),
      });
    }
    return briefs;
  }

  /**
   * What the system channel shows: the criteria, marked as criteria.
   *
   * Deliberately a separate call from `locate`, so that producing the text
   * and deciding who sees it stay apart. The caller renders this in the
   * system channel; handing the same string to a table would put it in a
   * seat's prompt, and this service holds no reference to a table that could
   * do it by accident.
   */
  async brief(situation: Situation, parent?: Agent): Promise<string> {
    return formatForSystemChannel(await this.locate(situation, parent));
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
