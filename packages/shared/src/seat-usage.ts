/**
 * seat-usage.ts — what one seat turn consumed, and how it rides home.
 *
 * Here because it has two consumers on opposite sides of the wall: the seat
 * provider MEASURES it, the table RECORDS it. Neither may import the other.
 *
 * Cache tokens stay separate from input, and that is not tidiness. Measured
 * on this machine: a turn whose entire prompt was 「只回答 OK」 billed 2 input
 * tokens and 83,625 of cache creation — the host's own global CLAUDE.md,
 * which every CLI seat inherits. Summed into one "input" figure, a
 * three-orders-of-magnitude fact disappears into an average, and the thing a
 * person would actually want to act on is the part that vanished.
 */

export interface SeatUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /** The backend's own accounting. Absent when it reported none. */
  readonly costUsd?: number | undefined;
  readonly durationMs?: number | undefined;
}

/**
 * The key a provider attaches usage under.
 *
 * Namespaced, because the field rides on a type dsh owns. A bare `usage`
 * would collide the day dsh adds its own — and that collision is silent: two
 * writers, one key, last one wins, and the number that survives is whichever
 * ran last.
 */
export interface SeatUsageCarrier {
  readonly squadUsage?: SeatUsage | undefined;
}

/** Read the accounting off a subagent result, when the provider supplied it. */
export const usageOfResult = (result: unknown): SeatUsage | undefined =>
  typeof result === "object" && result !== null && "squadUsage" in result
    ? ((result as SeatUsageCarrier).squadUsage ?? undefined)
    : undefined;

/** Everything the counters can be added up over. */
export interface UsageTotals extends SeatUsage {
  /** Turns that reported accounting. Turns that reported none are not counted. */
  readonly turns: number;
}

export const EMPTY_TOTALS: UsageTotals = {
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/**
 * Add one turn's usage to a running total.
 *
 * `costUsd` accumulates only from turns that reported one, and stays absent
 * while none has — a total of 0 would claim the work was free, which is a
 * stronger statement than "nobody told us".
 */
export function addUsage(total: UsageTotals, usage: SeatUsage | undefined): UsageTotals {
  if (usage === undefined) return total;
  const cost = usage.costUsd === undefined ? total.costUsd : (total.costUsd ?? 0) + usage.costUsd;
  const duration = usage.durationMs === undefined ? total.durationMs : (total.durationMs ?? 0) + usage.durationMs;
  return {
    turns: total.turns + 1,
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
    cacheCreationTokens: total.cacheCreationTokens + usage.cacheCreationTokens,
    ...(cost === undefined ? {} : { costUsd: cost }),
    ...(duration === undefined ? {} : { durationMs: duration }),
  };
}
