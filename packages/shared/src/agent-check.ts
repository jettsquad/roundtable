/**
 * agent-check.ts — what a configuration test can honestly report.
 *
 * Four separate answers rather than one verdict, because they fail for
 * unrelated reasons and each one has a different fix: the CLI is not
 * installed, the seat backend for that CLI was never built, the key is
 * missing, the endpoint is unreachable. A single 「测试失败」 sends a person
 * looking in the wrong place three times out of four.
 *
 * Every check reports `skipped` as its own outcome, never as a pass. A check
 * that could not run and a check that passed look identical in a green tick,
 * and only one of them is evidence.
 */

export type CheckOutcome = "ok" | "fail" | "skipped";

export interface CheckResult {
  readonly name: string;
  readonly outcome: CheckOutcome;
  readonly detail: string;
}

export interface AgentCheckReport {
  readonly templateId: string;
  readonly displayName: string;
  readonly checks: readonly CheckResult[];
}

/**
 * The overall reading of a report.
 *
 * `fail` if anything failed. Otherwise `incomplete` while anything was
 * skipped — NOT `ok`. Reporting a partly-run test as a pass is how a person
 * concludes an agent works when the only thing that was actually checked is
 * that its name is not empty.
 */
export function overallOf(report: AgentCheckReport): "ok" | "fail" | "incomplete" {
  // A report with nothing in it is the same claim as a report of skips: no
  // evidence was gathered. `ok` here would be a test that checked nothing
  // and passed.
  if (report.checks.length === 0) return "incomplete";
  if (report.checks.some((check) => check.outcome === "fail")) return "fail";
  if (report.checks.some((check) => check.outcome === "skipped")) return "incomplete";
  return "ok";
}
