// The Decider: one finding, the policy rule that governs its setting, and what the pass knows about the
// setting's approved value, its vault copies and production, in; one disposition out. Pure and
// deterministic: the same input gives the same verb, reason and expiry, and nothing is read or written.
//
// Contract, in precedence order:
//   1. Operator: an accepted exception in force (the technician's H-MEM lesson) gives ADOPT until the
//      lesson's expiry; a lapsed one gives ESCALATE. decided_by "operator", whatever rule matches.
//   2. Policy, when a rule governs the setting (src/policy/resolve.ts); decided_by "policy", rule_id the rule.
//      drift_vs_approved (the live value differs from the latest approval):
//        lock 1 or on_drift rollback:
//          a valid copy of the approved value (a vault copy whose blob_sha256, or whose run's observation of
//          the setting, carries the approved hash, and whose latest validation is ok or ok_with_gaps) -> ROLLBACK;
//          no valid copy, production affected -> on_no_copy: investigate_ticket FIX, ticket ESCALATE, adopt ADOPT;
//          no valid copy, production unknown -> ESCALATE, the reason naming why production is unknown;
//          no valid copy, production answering -> HOLD until decided_at + hold_max_hours.
//        on_drift investigate -> FIX when production is affected, else ESCALATE.
//        on_drift hold -> HOLD with the expiry. on_drift adopt -> ADOPT.
//      every other class: adopt ADOPT; hold HOLD with the expiry; investigate FIX when production is
//      affected, else ESCALATE; rollback HOLD with the expiry: the rule restores a setting to its approved
//      value, and the finding concerns the setting's relation to another setting while its own value stands.
//   3. Default, when no rule governs the setting: the verb the checks alone give (ADOPT when every check
//      holds and none was rejected, else ESCALATE) and the checks' own sentence. decided_by "default".
//   Production is affected when a probe of the pass with status fail targets a name the object serves
//   (an nginx object's redacted server_name values in the run, a record's redacted name); answering when
//   probes of those names ran and none failed; unknown when the pass holds no probe run ("no probe run in
//   this pass"), or its probe run holds no probe of those names ("no probe in <run> targets a name it
//   serves"). Every reason says which.
//   Every reason is one plain sentence over redacted text: hashes as 12 hex, commits as 8.
//
// Measured 24 Oct 2026 on test/fixtures/policy-bundle.json (test/pipeline.test.ts): the vhost file with a
// copy validated ok is ROLLBACK, the one whose copy failed validation while a probe of its name fails is
// FIX, the one with no copy and its probes answering is HOLD for 24 hours, the .bak copy is ADOPT, and the
// record whose content drifted, with a cf-schema copy validated ok, is ROLLBACK; with the probe run taken
// out, the two files with no valid copy are ESCALATE, "no probe run in this pass".

import type { FindingClass } from "../catalogue/templates.ts";
import type { DecidedBy, DispositionVerb, PolicyRule } from "../data/rows.ts";

/** The verb the checks alone give, as the pass computed it before any policy. */
export type ChecksVerb = "ADOPT" | "ESCALATE";

/** The technician's exception for the finding, as the pass recalled it from memory. */
export type ExceptionState =
  | { state: "none" }
  | { state: "applied" | "lapsed"; lesson: string; expires_at: string; reason: string };

/** The latest approval of the setting. */
export interface ApprovedValue { value_hash: string; approved_at: string; approved_by: string | null }

/**
 * One vault copy of the object, with its latest validation. value_hash is the copy's run's observation of
 * the setting ("" when the run has none); result is "" when the copy has no validation.
 */
export interface CopyCandidate {
  copy_id: string;
  run_id: string;
  git_commit: string;
  blob_sha256: string;
  taken_at: string;
  value_hash: string;
  validator: string;
  result: string;
  missing_dependencies: string;
  validated_at: string;
}

/** The probe rows of the pass: run_id null when the pass holds no probe run. */
export interface ProbeView { run_id: string | null; rows: readonly { kind: string; target: string; status: string }[] }

export interface DecideInput {
  finding: { class: FindingClass };
  rule: PolicyRule | null;
  exception: ExceptionState;
  checks: { verb: ChecksVerb; why: string };
  /** The setting's latest approval; set for a drift_vs_approved finding. */
  approved: ApprovedValue | null;
  copies: readonly CopyCandidate[];
  probes: ProbeView;
  /** The redacted names the object serves. */
  serves: readonly string[];
  /** ISO 8601 UTC, the millisecond form. */
  decidedAt: string;
}

export interface Decision {
  verb: DispositionVerb;
  reason: string;
  expires_at: string | null;
  decided_by: DecidedBy;
  rule_id: string | null;
}

export type Production =
  | { state: "affected"; run_id: string; failing: string[] }
  | { state: "answering"; run_id: string; ok: number }
  | { state: "unknown"; run_id: string | null; why: string };

/** "no probe run in this pass": the sentence the Decider says when production cannot be read. */
export const NO_PROBE_RUN = "no probe run in this pass";

const VALID: readonly string[] = ["ok", "ok_with_gaps"];
const hex = (h: string, n: number): string => h.replace(/^sha256:/, "").slice(0, n);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** decided_at plus the rule's hours, ISO 8601 UTC in the millisecond form. */
export function holdUntil(decidedAt: string, hours: number): string {
  return new Date(Date.parse(decidedAt) + hours * 3_600_000).toISOString();
}

/** The gaps a validation recorded: its newline-separated missing dependencies, blanks left out. */
export function gapCount(c: Pick<CopyCandidate, "missing_dependencies">): number {
  return c.missing_dependencies.split("\n").filter((s) => s.trim() !== "").length;
}

/** The newest copy (by taken_at, then copy_id) that carries the approved hash and whose latest validation passed; null when none. */
export function validCopy(copies: readonly CopyCandidate[], approvedHash: string): CopyCandidate | null {
  const ok = copies
    .filter((c) => (c.blob_sha256 === approvedHash || c.value_hash === approvedHash) && VALID.includes(c.result))
    .sort((a, b) => (a.taken_at === b.taken_at ? (a.copy_id < b.copy_id ? -1 : 1) : a.taken_at < b.taken_at ? -1 : 1));
  return ok.at(-1) ?? null;
}

/** What the pass's probes say about the names the object serves. */
export function production(probes: ProbeView, serves: readonly string[]): Production {
  if (probes.run_id === null) return { state: "unknown", run_id: null, why: NO_PROBE_RUN };
  const names = new Set(serves);
  const mine = probes.rows.filter((p) => names.has(p.target));
  const failing = mine.filter((p) => p.status !== "ok").map((p) => `${p.kind} ${p.target}`);
  if (failing.length) return { state: "affected", run_id: probes.run_id, failing };
  if (mine.length) return { state: "answering", run_id: probes.run_id, ok: mine.length };
  return { state: "unknown", run_id: probes.run_id, why: `no probe in ${probes.run_id} targets a name it serves` };
}

/** Production as a clause of a reason. */
export function productionText(p: Production): string {
  if (p.state === "affected") return `production affected (${plural(p.failing.length, "failing probe", "failing probes")} in ${p.run_id}: ${p.failing.slice(0, 3).join(", ")}${p.failing.length > 3 ? ", ..." : ""})`;
  if (p.state === "answering") return `production answering (${plural(p.ok, "probe", "probes")} of its names ok in ${p.run_id})`;
  return p.why;
}

function copyText(copies: readonly CopyCandidate[]): string {
  if (!copies.length) return "no valid copy (none in the vault)";
  const results = [...new Set(copies.map((c) => c.result || "unvalidated"))].sort().join(", ");
  return `no valid copy (${plural(copies.length, "copy", "copies")} in the vault, latest validation ${results})`;
}

export function decide(input: DecideInput): Decision {
  const { rule, exception: ex, checks } = input;
  if (ex.state === "applied") {
    return {
      verb: "ADOPT", decided_by: "operator", rule_id: null, expires_at: ex.expires_at,
      reason: `accepted exception ${ex.lesson} holds until ${ex.expires_at} (${ex.reason}); the checks alone would say ${checks.verb}`,
    };
  }
  if (ex.state === "lapsed") {
    return {
      verb: "ESCALATE", decided_by: "operator", rule_id: null, expires_at: null,
      reason: `exception lapsed: ${ex.lesson} expired ${ex.expires_at}; re-raised to the technician, the checks alone would say ${checks.verb}`,
    };
  }
  if (!rule) return { verb: checks.verb, reason: checks.why, expires_at: null, decided_by: "default", rule_id: null };

  const by = (verb: DispositionVerb, reason: string, expires_at: string | null = null): Decision => ({ verb, reason, expires_at, decided_by: "policy", rule_id: rule.rule_id });
  const until = holdUntil(input.decidedAt, rule.hold_max_hours);
  const prod = production(input.probes, input.serves);
  const id = rule.rule_id;
  const cls = input.finding.class;

  if (cls === "drift_vs_approved" && input.approved) {
    const a12 = hex(input.approved.value_hash, 12);
    if (rule.lock === 1 || rule.on_drift === "rollback") {
      const copy = validCopy(input.copies, input.approved.value_hash);
      if (copy) {
        return by("ROLLBACK", `live value drifted from approved ${a12}; vault commit ${hex(copy.git_commit, 8)} holds the approved copy, validated ${copy.result} with ${plural(gapCount(copy), "gap", "gaps")}, so rule ${id} rolls it back to that copy`);
      }
      const candidates = input.copies.filter((c) => c.blob_sha256 === input.approved!.value_hash || c.value_hash === input.approved!.value_hash);
      const lead = `live value drifted from approved ${a12} with ${copyText(candidates)} and ${productionText(prod)}`;
      if (prod.state === "affected") {
        if (rule.on_no_copy === "investigate_ticket") return by("FIX", `${lead}, so rule ${id} investigates, fixes where allowed, documents and opens a ticket`);
        if (rule.on_no_copy === "ticket") return by("ESCALATE", `${lead}, so rule ${id} opens a ticket for a technician`);
        return by("ADOPT", `${lead}, so rule ${id} adopts the live value`);
      }
      if (prod.state === "unknown") return by("ESCALATE", `${lead}, so production is unknown and rule ${id} sends it to a technician`);
      return by("HOLD", `${lead}, so rule ${id} holds it until ${until}`, until);
    }
    if (rule.on_drift === "investigate") {
      return prod.state === "affected"
        ? by("FIX", `live value drifted from approved ${a12} with ${productionText(prod)}, so rule ${id} investigates and fixes where allowed`)
        : by("ESCALATE", `live value drifted from approved ${a12} with ${productionText(prod)}, so rule ${id} sends it to a technician`);
    }
    if (rule.on_drift === "hold") return by("HOLD", `live value drifted from approved ${a12}; rule ${id} holds it until ${until}`, until);
    return by("ADOPT", `live value drifted from approved ${a12}; rule ${id} (${rule.criticality}) adopts the live value`);
  }

  if (rule.on_drift === "adopt") return by("ADOPT", `rule ${id} (${rule.criticality}) adopts this ${cls} finding`);
  if (rule.on_drift === "hold") return by("HOLD", `rule ${id} (${rule.criticality}) holds this ${cls} finding until ${until}`, until);
  if (rule.on_drift === "investigate") {
    return prod.state === "affected"
      ? by("FIX", `rule ${id} investigates this ${cls} finding with ${productionText(prod)} and fixes where allowed`)
      : by("ESCALATE", `rule ${id} investigates this ${cls} finding with ${productionText(prod)}, so it goes to a technician`);
  }
  return by("HOLD", `rule ${id} restores a setting to its approved value; this ${cls} finding concerns the setting's relation to another setting while its own value stands, so it is held until ${until}`, until);
}
