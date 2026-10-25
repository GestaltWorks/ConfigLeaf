// The verifier's stop rule, and the withdraw rule before the judge. Code only, no model.
//
// Between checks the pass asks shouldStop whether the verb can still move. Under the pass's decision
// policy (every check holds and none was rejected: ADOPT, as a candidate; anything else: ESCALATE),
// ESCALATE is absorbing: once a required check fails or a check could not be run, no remaining check
// can bring ADOPT back. That alone does not make a remaining check worthless. A check that cannot move
// the verb can still change what the technician does next (whom to ask, whether a revert is on record,
// what else points at the target), so a settled verdict skips only the remaining checks whose
// informs_next_action is false, each traced "skipped" with "verdict settled by X; informs_next_action=false".
// Two cases skip more:
//   basis   the check that settled the verdict is run_complete: the run did not collect the population it
//           asserted, so no other check over it is a safe basis for anything. Every remaining check goes.
//   gated   every remaining check reads a table whose collection run is gated out this pass (the audit
//           log, when the tenant's latest audit run failed the DQ gate). None of them can run; they are
//           recorded at once as not checked, which escalates the finding exactly as each would have one
//           by one. The finding carries every one as a rejection.
// A check that could still move ADOPT/ESCALATE is never skipped: while every check so far holds and none
// was rejected, shouldStop says no.
//
// shouldWithdraw runs before the judge. When the verb is ESCALATE whatever the judge answers (a check
// not checked, run_complete failing, no check run, a proposal that did not bind), the judge call is not
// spent: "verdict cannot move". When a check that holds contradicts the detector's own claim
// (referent_unchanged on a found_but_different, record_reverted on a change), the claim is withdrawn
// before the judge: "claim withdrawn by its own checks". Neither changes the verb; the decision policy
// still computes it from the checks, so a withdrawal never skips a check that could have escalated.
//
// The counters the eval reads (early_stop, checks_skipped, checks_gated, withdrawn_judge) are in the
// trace: one checker line per stop (output_summary "early_stop <kind>: ..."), one judge line per withheld
// judge call, one decider summary line per pass (input_summary "stop rule"). The lines use the agents the
// trace already has, so a reader keyed on agent names sees no new one. stopCounters reads the counters
// back from the stop and judge lines of any trace, a logs/<run>.jsonl as well as a test's MemTracer.

import { CATALOGUE, type CheckResult, type FindingClass } from "./catalogue/templates.ts";
import type { TraceEvent } from "./trace.ts";

/**
 * Does a template's result change what the technician does next once the verb is settled? Set by hand,
 * per template, by the operator; a template missing here counts as true. Every template is true until
 * the operator marks one false: a skipped check that would have informed the ticket is a cost the stop
 * rule must not impose on its own say-so. With this table the settled-verdict rule skips nothing on the
 * recorded bundle; test/stoprule.test.ts measures what marking templates false would skip there, and
 * that it flips no verb.
 */
export const INFORMS_NEXT_ACTION: Readonly<Record<string, boolean>> = {
  run_complete: true, // an incomplete run sends the technician to re-collect, not to fix
  host_in_inventory: true, // the client's address or someone else's: a config fix or a security escalation
  dns_target_in_inventory: true, // the same question for every address the name resolves to
  change_in_last_backup: true, // whether a restore would undo the change
  actor_attributed: true, // whom to ask
  previous_value_recoverable: true, // whether a revert is on record
  restore_would_regress: true, // whether a restore is a safe remediation
  referent_unchanged: true, // whether to look at the DNS side or the host side
  setting_matches_approved: true, // whether the escalation is about a sanctioned value
  other_settings_reference: true, // the blast radius of the fix
  record_reverted: true, // whether the change is already undone
  backup_recent: true, // whether a restore is available at all
};

/** The settling check that makes every other check moot: the run itself is not a safe basis. */
export const BASIS_CHECK = "run_complete";

/** A check that, when it HOLDS, contradicts the detector's own claim for the class. */
export const CONTRADICTS: Readonly<Partial<Record<FindingClass, readonly string[]>>> = {
  found_but_different: ["referent_unchanged", "record_reverted"],
  dns_change: ["record_reverted"],
};

/** The tables a template reads, from its {{t:}} references. Unknown template: none. */
export function tablesOf(template: string): string[] {
  const t = CATALOGUE.find((x) => x.id === template);
  return t ? [...new Set([...t.sql.matchAll(/\{\{t:(\w+)\}\}/g)].map((m) => m[1]))] : [];
}

export type CheckSoFar = Pick<CheckResult, "template" | "holds">;

export interface StopPolicy {
  /** false turns the rule off: every check runs (the eval's full run, for the flips audit). Default true. */
  enabled?: boolean;
  /** Templates whose failure forces ESCALATE. Default: every check (the pass's decide rule). */
  required?: readonly string[];
  /** Per template; default INFORMS_NEXT_ACTION, and a template missing from the table counts as true. */
  informsNextAction?: Readonly<Record<string, boolean>>;
  /** Tables whose collection run is gated out this pass, e.g. audit_event when the latest audit run failed the DQ gate. */
  gatedTables?: readonly string[];
}

export interface StopState {
  findingClass: FindingClass;
  checksSoFar: readonly CheckSoFar[];
  /** Template ids still queued, in order. */
  remaining: readonly string[];
  policy: StopPolicy;
  /** Templates recorded as not checked so far (unbound, refused, withheld); any one settles the verdict at ESCALATE. */
  rejected?: readonly string[];
}

export type StopKind = "none" | "settled" | "basis" | "gated";

export interface StopDecision {
  stop: boolean;
  reason: string;
  /** The remaining templates not to run. A gated skip is recorded as not checked by the caller. */
  skipped: string[];
  kind: StopKind;
}

const go = (reason: string): StopDecision => ({ stop: false, reason, skipped: [], kind: "none" });

/** Whether the pass should stop checking this finding, and which queued checks it skips. Deterministic. */
export function shouldStop(state: StopState): StopDecision {
  const { checksSoFar, remaining, policy } = state;
  if (policy.enabled === false) return go("stop rule disabled");
  if (remaining.length === 0) return go("no check remains");

  const gated = new Set(policy.gatedTables ?? []);
  if (gated.size > 0) {
    const reads = remaining.map((t) => tablesOf(t).filter((x) => gated.has(x)));
    if (reads.every((g) => g.length > 0)) {
      const tables = [...new Set(reads.flat())].sort().join(", ");
      return { stop: true, reason: `every remaining check reads ${tables}, whose collection run is gated out this pass`, skipped: [...remaining], kind: "gated" };
    }
  }

  if (checksSoFar.some((c) => c.template === BASIS_CHECK && !c.holds)) {
    return { stop: true, reason: `verdict settled by ${BASIS_CHECK}; informs_next_action=false: the run is not a safe basis for any other check`, skipped: [...remaining], kind: "basis" };
  }

  const isRequired = (t: string): boolean => policy.required === undefined || policy.required.includes(t);
  const failed = checksSoFar.find((c) => !c.holds && isRequired(c.template))?.template;
  const notChecked = state.rejected?.[0];
  const settledBy = failed ?? (notChecked !== undefined ? `${notChecked} (not checked)` : undefined);
  if (settledBy === undefined) return go("verdict open: a remaining check could still move ADOPT to ESCALATE");

  const table = policy.informsNextAction ?? INFORMS_NEXT_ACTION;
  const skipped = remaining.filter((t) => table[t] === false);
  if (skipped.length === 0) return go(`verdict settled by ${settledBy}; every remaining check informs the next action`);
  return { stop: true, reason: `verdict settled by ${settledBy}; informs_next_action=false`, skipped, kind: "settled" };
}

export interface WithdrawState {
  findingClass: FindingClass;
  checks: readonly CheckSoFar[];
  /** How many checks were recorded as not checked (unbound, refused, withheld, gated). */
  rejected: number;
  /** Pre-flight: the proposal did not bind to a record. */
  proposalInvalid?: boolean;
}

export interface WithdrawDecision {
  withdraw: boolean;
  reason: string;
  /** The check whose holding contradicted the claim, when that is the reason. */
  contradictedBy?: string;
}

export const VERDICT_CANNOT_MOVE = "verdict cannot move";
export const CLAIM_WITHDRAWN = "claim withdrawn by its own checks";

/** Before the judge: is its call worth spending? Deterministic; the verb itself is not changed here. */
export function shouldWithdraw(s: WithdrawState): WithdrawDecision {
  if (s.proposalInvalid) return { withdraw: true, reason: `${VERDICT_CANNOT_MOVE}: the proposal did not bind to a record, so the finding escalates whatever the judge answers` };
  if (s.rejected > 0) return { withdraw: true, reason: `${VERDICT_CANNOT_MOVE}: ${s.rejected} check(s) not checked; a judge cannot supply missing evidence, so the finding escalates whatever it answers` };
  if (s.checks.some((c) => c.template === BASIS_CHECK && !c.holds)) return { withdraw: true, reason: `${VERDICT_CANNOT_MOVE}: ${BASIS_CHECK} fails, so the rows a judge would read are not a safe basis` };
  if (s.checks.length === 0) return { withdraw: true, reason: `${VERDICT_CANNOT_MOVE}: no precondition ran` };
  const contra = (CONTRADICTS[s.findingClass] ?? []).find((t) => s.checks.some((c) => c.template === t && c.holds));
  if (contra !== undefined) return { withdraw: true, reason: `${CLAIM_WITHDRAWN}: ${contra} holds on a ${s.findingClass}`, contradictedBy: contra };
  return { withdraw: false, reason: "the judge's answer can still move the verb" };
}

export interface StopCounters {
  /** Stop decisions taken (one checker "early_stop" line each). */
  early_stop: number;
  /** Checks skipped because the verdict was settled (each traced status "skipped"); no SQL ran for them. */
  checks_skipped: number;
  /** Checks recorded at once as not checked because every remaining check read a gated source. */
  checks_gated: number;
  /** Judge calls not spent: verdict cannot move, or claim withdrawn by its own checks. */
  withdrawn_judge: number;
}

export const zeroCounters = (): StopCounters => ({ early_stop: 0, checks_skipped: 0, checks_gated: 0, withdrawn_judge: 0 });

/** The output_summary of a stop line (agent checker, action check, status skipped); stopCounters parses exactly this shape back. */
export function earlyStopSummary(kind: StopKind, skipped: readonly string[]): string {
  return `early_stop ${kind}: ${skipped.length} check(s) ${kind === "gated" ? "not checked" : "skipped"}: ${skipped.join(", ")}`;
}

/** The output_summary of the pass's summary line (agent decider, action triage, input_summary "stop rule"). */
export function countersSummary(c: StopCounters): string {
  return `early_stop ${c.early_stop}, checks_skipped ${c.checks_skipped}, checks_gated ${c.checks_gated}, withdrawn_judge ${c.withdrawn_judge}`;
}

const STOP_LINE = /^early_stop (settled|basis|gated): (\d+) check\(s\)/;

/** The counters, read back from a trace's stop and judge lines (not from its summary line, so a partial trace still counts). */
export function stopCounters(events: readonly Pick<TraceEvent, "agent" | "action" | "status" | "output_summary" | "detail">[]): StopCounters {
  const c = zeroCounters();
  for (const e of events) {
    if (e.agent === "checker" && e.action === "check" && e.status === "skipped") {
      const m = STOP_LINE.exec(e.output_summary ?? "");
      if (!m) continue;
      c.early_stop += 1;
      if (m[1] === "gated") c.checks_gated += Number(m[2]);
      else c.checks_skipped += Number(m[2]);
    } else if (e.agent === "judge" && e.action === "judge" && e.status === "skipped"
      && (e.detail?.startsWith(VERDICT_CANNOT_MOVE) || e.detail?.startsWith(CLAIM_WITHDRAWN))) {
      c.withdrawn_judge += 1;
    }
  }
  return c;
}
