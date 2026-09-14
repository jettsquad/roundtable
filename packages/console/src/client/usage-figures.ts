/**
 * usage-figures.ts — one place that decides how spend reads.
 *
 * Two screens were formatting this independently and drifting: the panel and
 * the session's team tab both built the same list, so a change to what the
 * columns MEAN had to be made twice or the two would disagree about the same
 * team.
 *
 * The columns are ordered by what they cost, because that ordering is the
 * whole point of splitting them. The old display said 「入 N · 缓存 M」, which
 * added a cache CREATION — dearer than plain input — to a cache READ, which
 * is about a tenth of it. A 3.6M total is cheap when almost all of it is
 * reads and expensive when it is creations, and one number could not say
 * which.
 *
 * It is also the only reading that answers 「会话续接生效了吗」: a resumed turn
 * creates almost nothing and reads almost everything. Measured on this
 * machine — a fresh Claude session creates 65,897 and reads 26,552; the same
 * conversation resumed creates 62 and reads 92,449.
 */
import type { UsageTotals } from "@squad/shared";

/** The translate function both screens already hold. */
type Translate = (key: never, params?: Record<string, string | number>) => string;

/**
 * One team's or one seat's spend, as ordered parts.
 *
 * Returns `undefined` when nothing was ever measured, which is not the same
 * as zero: a backend that reports no accounting and a turn that genuinely
 * cost nothing must not read alike.
 */
export function usageParts(t: Translate, usage: UsageTotals | undefined): readonly string[] | undefined {
  if (usage === undefined || usage.turns === 0) return undefined;
  const parts = [
    t("team.usage.turns" as never, { n: usage.turns }),
    t("team.usage.fresh" as never, { n: usage.inputTokens.toLocaleString() }),
    t("team.usage.cacheWrite" as never, { n: usage.cacheCreationTokens.toLocaleString() }),
    t("team.usage.cacheRead" as never, { n: usage.cacheReadTokens.toLocaleString() }),
    t("team.usage.out" as never, { n: usage.outputTokens.toLocaleString() }),
  ];
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(4)}`);
  return parts;
}

/**
 * The share of input that came from cache, as a whole percent.
 *
 * `undefined` when there was no input to take a share of — printing 「0%」 for
 * a team that has not run reads as a cache that is failing.
 */
export function cacheHitPercent(usage: UsageTotals | undefined): number | undefined {
  if (usage === undefined) return undefined;
  const total = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  if (total === 0) return undefined;
  return Math.round((usage.cacheReadTokens / total) * 100);
}
