// The eval's check step: one finding, one validated selection of checks (the class's defaults or a model's
// choice), run through the catalogue exactly as src/pipeline.ts's assess runs them, then the verb the checks
// alone give and the withdraw rule before a judge.
//
// Contract, the pass's own rules in its order: between checks the stop rule (src/stoprule.ts shouldStop)
// may skip queued checks; a tenant whose latest audit run fails the gate has every audit template recorded
// as a rejection, "audit log incomplete"; a check the guard or the engine refuses is a recorded rejection;
// every rejection of the selection itself (an unknown template, a parameter left unbound) is one too.
// The verb is ADOPT when at least one check ran, every check holds and nothing was rejected, else ESCALATE,
// with the pass's sentence: the default's verb, which src/eval/policy.ts then puts through the Decider's
// precedence (the exception, then the rule, then this verb). shouldWithdraw says whether a judge's answer can
// still move it.
//
// Measured 24 Oct 2026 on test/fixtures/recorded-bundle.json with no policy rule loaded (test/eval.test.ts): with
// the default selection this gives the pass's verb and reason on all 38 findings.

import type { RejectedCheck, ValidatedSelection, FindingSummary } from "../catalogue/select.ts";
import { runCheck, type CheckResult } from "../catalogue/templates.ts";
import { DataLayerError, type DataLayer } from "../data/layer.ts";
import { AUDIT_TEMPLATES, type CheckOutcome } from "../pipeline.ts";
import { shouldStop, shouldWithdraw, type StopPolicy, type WithdrawDecision } from "../stoprule.ts";
import type { Tracer } from "../trace.ts";

export interface Assessment {
  checks: CheckOutcome[];
  /** The rows each check returned, for the evidence a judge reads. */
  results: CheckResult[];
  rejected: RejectedCheck[];
  verb: "ADOPT" | "ESCALATE";
  why: string;
  /** Stop decisions taken between checks, and the templates they skipped. */
  earlyStops: number;
  skipped: string[];
  withdraw: WithdrawDecision;
}

const templateOf = (rj: RejectedCheck): string => String((rj.check as { template?: unknown })?.template ?? "?");

/** The checks of `selection` over `finding`, the verb they give and whether a judge can still move it. */
export async function assessChecks(
  layer: DataLayer,
  finding: FindingSummary,
  selection: ValidatedSelection,
  opts: { auditWithheld?: string; tracer?: Tracer; stopPolicy?: Omit<StopPolicy, "gatedTables"> } = {},
): Promise<Assessment> {
  const { auditWithheld: withheld, tracer } = opts;
  const checks: CheckOutcome[] = [];
  const results: CheckResult[] = [];
  const rejected: RejectedCheck[] = [...selection.rejected];
  const policy: StopPolicy = { ...opts.stopPolicy, gatedTables: withheld !== undefined ? ["audit_event"] : [] };
  const queue = [...selection.valid];
  const skipped: string[] = [];
  let earlyStops = 0;
  while (queue.length > 0) {
    const stop = shouldStop({ findingClass: finding.class, checksSoFar: checks, remaining: queue.map((q) => q.template), policy, rejected: rejected.map(templateOf) });
    if (stop.stop) {
      const out = queue.filter((q) => stop.skipped.includes(q.template));
      queue.splice(0, queue.length, ...queue.filter((q) => !stop.skipped.includes(q.template)));
      for (const q of out) {
        if (stop.kind === "gated") rejected.push({ check: q, reason: `${q.template}: audit log incomplete (${withheld})` });
        else skipped.push(q.template);
      }
      earlyStops += 1;
      continue;
    }
    const c = queue.shift()!;
    if (withheld !== undefined && AUDIT_TEMPLATES.includes(c.template)) {
      rejected.push({ check: c, reason: `${c.template}: audit log incomplete (${withheld})` });
      continue;
    }
    let r: CheckResult;
    try {
      r = await runCheck(layer, c.template, c.params, { tracer, agent: "checker" });
    } catch (err) {
      if (!(err instanceof DataLayerError)) throw err;
      rejected.push({ check: c, reason: `${c.template}: ${err.message}` });
      continue;
    }
    results.push(r);
    checks.push({ template: r.template, holds: r.holds, rowCount: r.rowCount, explanation: r.explanation });
  }
  const failing = checks.filter((c) => !c.holds).map((c) => c.template);
  const verb: "ADOPT" | "ESCALATE" = checks.length > 0 && failing.length === 0 && rejected.length === 0 ? "ADOPT" : "ESCALATE";
  const why = verb === "ADOPT"
    ? `all ${checks.length} preconditions hold; candidate pending a judge`
    : [
      failing.length ? `${failing.length} of ${checks.length} preconditions fail: ${failing.join(", ")}` : "",
      rejected.length ? `${rejected.length} check(s) could not be bound from the finding or were refused by the guard` : "",
      checks.length === 0 && rejected.length === 0 ? "no precondition ran" : "",
    ].filter(Boolean).join("; ");
  const withdraw = shouldWithdraw({ findingClass: finding.class, checks, rejected: rejected.length });
  return { checks, results, rejected, verb, why, earlyStops, skipped, withdraw };
}
