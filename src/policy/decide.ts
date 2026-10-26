// The Decider: one finding, the policy rule that governs its setting, and what the pass knows about the
// setting's approved value, its vault copies, production and its prior HOLD, in; one disposition out. Pure
// and deterministic: the same input gives the same verb, reason and expiry, and nothing is read or written.
//
// Contract, in precedence order:
//   1. Operator: an accepted exception in force (the technician's H-MEM lesson) gives ADOPT until the
//      lesson's expiry; a lapsed one gives ESCALATE. decided_by "operator", whatever rule matches, whatever
//      HOLD the setting had.
//   2. Policy, when a rule governs the setting (src/policy/resolve.ts); decided_by "policy", rule_id the rule.
//      on_drift escalate, first and whatever the lock or the class: ESCALATE, the reason naming the drift from the
//      approved value when there is one, and opening with the finding's own line for a NAMED_CLASSES finding (a
//      Microsoft 365 mail record: the record, the domain's pseudonym, what the zone serves); the agent changes
//      nothing (the rule zetaris.control carries, the layer the agent reads through, and the rule m365.dns carries:
//      mail DNS is never changed automatically).
//      drift_vs_approved (the live value differs from the latest approval) and approved_missing (the approved
//      object is absent from the run: a drift from the approved value to the live value ""):
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
//      A HOLD the rule gives meets the setting's prior HOLD on the same live value, when the ledger holds one
//      (the latest HOLD of the same tenant, surface, host, object_id, setting_path and value_hash decided
//      before this pass): one whose expires_at is after decided_at keeps HOLD with that expires_at and the
//      rule's own sentence built with it, "<the rule's reason, until <expires_at>>; held since <decided_at>
//      under rule <id>", so the reason names one expiry; one whose expires_at is at or before decided_at gives
//      ESCALATE, "hold under rule <id> expired <expires_at>; the finding stands". A kept HOLD carries the
//      expiry forward, so every HOLD of a live value shares the first one's expiry, and once it passes every
//      later pass on that value is ESCALATE.
//   3. Change window, the last step before the default: a technician's declared window on the finding's object
//      (sql/schema.sql change_window, opened from the console's Unlock), open at decided_at (opened_at <= decided_at
//      < until, closed_at null), on a drift class (drift_vs_approved, changed_since_backup, approved_missing). A
//      verb the rule gave of ROLLBACK, FIX or HOLD becomes HOLD until the window's until, "change window <id> opened
//      by <who> until <until>: <why>", decided_by "policy", rule_id the rule's, window_id the window's (the
//      disposition column PRIOR_HOLDS_SQL reads, so a window's HOLD neither starts nor ends a rule's expiry): the
//      agent leaves a change the technician declared alone until the window ends. The window's until replaces the
//      expiry a prior HOLD in force carried, earlier or later; an expired prior HOLD is ESCALATE and stands. ESCALATE
//      and ADOPT stand, and the probes still run. Outside a window, on another object or on any other class, nothing
//      changes. When the windows could not be read (windowError), the step fails closed: on a drift class a ROLLBACK
//      or FIX becomes ESCALATE, "change windows not read: <error>; a technician decides", so a declared change is
//      never undone on a read the pass could not make; HOLD, ADOPT and ESCALATE stand. A window never loosens an
//      exception's or a lapse's verdict (step 1 decides first), and a cause (src/explain/) never reaches here.
//   4. Default, when no rule governs the setting: the verb the checks alone give (ADOPT when every check
//      holds and none was rejected, else ESCALATE) and the checks' own sentence. decided_by "default".
//   Production is affected when a probe of the pass with status fail targets a name the object serves
//   (an nginx object's redacted server_name values in the run, a record's redacted name); answering when
//   probes of those names ran and none failed; unknown when the pass holds no probe run ("no probe run in
//   this pass"), or its probe run holds no probe of those names ("no probe in <run> targets a name it
//   serves"). Every reason says which. A probe recorded skipped did not run (the tls of a
//   PROBE_TARGETS_OVERRIDE target) and counts neither way.
//   Every reason is one plain sentence over redacted text: hashes as 12 hex, commits as 8.
//
// Measured 24 Oct 2026 on test/fixtures/policy-bundle.json (test/pipeline.test.ts): the vhost file with a
// copy validated ok is ROLLBACK, the one whose copy failed validation while a probe of its name fails is
// FIX, the one with no copy and its probes answering is HOLD for 24 hours, the .bak copy is ADOPT, the
// record whose content drifted, with a cf-schema copy validated ok, is ROLLBACK, and the approved vhost file
// absent from the latest run, with a copy validated ok, is ROLLBACK; the found_but_different finding whose
// prior HOLD runs to 2026-10-24T03:00:00.000Z keeps it, and the proxy_split whose prior HOLD expired at
// 2026-10-22T22:00:00.000Z is ESCALATE; with the probe run taken out, the two files with no valid copy are
// ESCALATE, "no probe run in this pass".

import type { FindingClass } from "../catalogue/templates.ts";
import type { ChangeWindow, DecidedBy, DispositionVerb, PolicyRule } from "../data/rows.ts";

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

/** The latest HOLD the ledger holds on the setting's live value, decided before this pass (PRIOR_HOLDS_SQL). */
export interface PriorHold { decided_at: string; expires_at: string; rule_id: string | null }

export interface DecideInput {
  /** The finding's class, and its one redacted line, which an escalation of a NAMED_CLASSES finding opens with. */
  finding: { class: FindingClass; summary?: string };
  rule: PolicyRule | null;
  exception: ExceptionState;
  checks: { verb: ChecksVerb; why: string };
  /** The setting's latest approval; set for a drift_vs_approved and an approved_missing finding. */
  approved: ApprovedValue | null;
  copies: readonly CopyCandidate[];
  probes: ProbeView;
  /** The redacted names the object serves. */
  serves: readonly string[];
  /** ISO 8601 UTC, the millisecond form. */
  decidedAt: string;
  /** The setting's prior HOLD on the same live value; null or absent when the ledger holds none. */
  priorHold?: PriorHold | null;
  /** The change window on the finding's object (openWindow); null or absent when none is declared. */
  window?: WindowView | null;
  /** Why the tenant's change windows were not read this pass; null or absent when they were, or when the datasource lists no change_window table. */
  windowError?: string | null;
}

/** A change window as the Decider reads it (sql/schema.sql change_window). */
export type WindowView = Pick<ChangeWindow, "window_id" | "opened_by" | "opened_at" | "until" | "reason" | "closed_at">;

/** The classes a change window holds: a setting's own value moved from its approval, its backup or its object. */
export const WINDOW_CLASSES: readonly FindingClass[] = ["drift_vs_approved", "changed_since_backup", "approved_missing"];
/** The verbs that would write to the host or the zone: with the windows unread they go to a technician. */
const WINDOW_WRITES: readonly DispositionVerb[] = ["ROLLBACK", "FIX"];
/** The verbs a window turns into its HOLD: the writing ones, and a rule's own HOLD. */
const WINDOW_HELD: readonly DispositionVerb[] = [...WINDOW_WRITES, "HOLD"];
/** How every window HOLD's sentence starts. The HOLD itself is known by its window_id, never by this text. */
export const WINDOW_REASON = "change window ";

/** Open at `at`: opened_at <= at < until, and not closed. */
export function windowOpen(w: WindowView, at: string): boolean {
  const t = Date.parse(at);
  return w.closed_at === null && Date.parse(w.opened_at) <= t && t < Date.parse(w.until);
}

/** The window that covers a setting at `at`: same tenant, surface, host and object, setting "*" or its own; the latest opened when several are. */
export function openWindow<W extends ChangeWindow>(windows: readonly W[], s: { tenant_id: string; surface: string; host: string | null; object_id: string; setting_path: string }, at: string): W | null {
  const mine = windows.filter((w) => w.tenant_id === s.tenant_id && w.surface === s.surface && (w.host ?? "") === (s.host ?? "") && w.object_id === s.object_id
    && (w.setting_path === "*" || w.setting_path === s.setting_path) && windowOpen(w, at));
  return mine.sort((a, b) => (a.opened_at < b.opened_at ? -1 : a.opened_at > b.opened_at ? 1 : a.window_id < b.window_id ? -1 : 1)).at(-1) ?? null;
}

/** The sentence of a window's HOLD. */
export const windowReason = (w: WindowView): string => `${WINDOW_REASON}${w.window_id} opened by ${w.opened_by} until ${w.until}: ${w.reason}`;

/** The sentence of a writing verb the pass could not weigh against the windows. */
export const windowsUnreadReason = (error: string): string => `change windows not read: ${error}; a technician decides`;

/** Step 3: the rule's verb inside an open window on a drift class, and with the windows unread (see the header). */
function inWindow(input: DecideInput, d: Decision): Decision {
  if (!WINDOW_CLASSES.includes(input.finding.class)) return d;
  if (input.windowError) {
    return WINDOW_WRITES.includes(d.verb) ? { verb: "ESCALATE", reason: windowsUnreadReason(input.windowError), expires_at: null, decided_by: d.decided_by, rule_id: d.rule_id } : d;
  }
  const w = input.window;
  if (!w || !windowOpen(w, input.decidedAt) || !WINDOW_HELD.includes(d.verb)) return d;
  return { verb: "HOLD", reason: windowReason(w), expires_at: new Date(w.until).toISOString(), decided_by: "policy", rule_id: d.rule_id, window_id: w.window_id };
}

export interface Decision {
  verb: DispositionVerb;
  reason: string;
  expires_at: string | null;
  decided_by: DecidedBy;
  rule_id: string | null;
  /** The change window whose HOLD this is (step 3); absent on every other decision. */
  window_id?: string;
}

export type Production =
  | { state: "affected"; run_id: string; failing: string[] }
  | { state: "answering"; run_id: string; ok: number }
  | { state: "unknown"; run_id: string | null; why: string };

/** "no probe run in this pass": the sentence the Decider says when production cannot be read. */
export const NO_PROBE_RUN = "no probe run in this pass";

/** The classes the Decider weighs against the setting's approved value and its vault copies. */
export const APPROVAL_CLASSES: readonly FindingClass[] = ["drift_vs_approved", "approved_missing"];

/**
 * The classes whose escalation opens with the finding's own line: a Microsoft 365 mail record, whose line names the
 * record, the domain's pseudonym and what the zone serves, so the technician reads what to fix in the reason itself.
 */
export const NAMED_CLASSES: readonly FindingClass[] = ["m365_mail_record"];

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
  const mine = probes.rows.filter((p) => names.has(p.target) && p.status !== "skipped");
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

/**
 * A HOLD the rule gave, against the setting's prior HOLD on the same live value. A prior HOLD in force keeps its
 * expiry: the rule's sentence is built again with that expiry, so the reason names one date.
 */
function againstPriorHold(input: DecideInput, rule: PolicyRule, d: Decision): Decision {
  const prior = input.priorHold;
  if (d.verb !== "HOLD" || !prior) return d;
  const id = prior.rule_id ?? d.rule_id;
  if (Date.parse(prior.expires_at) > Date.parse(input.decidedAt)) {
    const kept = byRule(input, rule, prior.expires_at);
    return { ...kept, expires_at: prior.expires_at, reason: `${kept.reason}; held since ${prior.decided_at} under rule ${id}` };
  }
  return { ...d, verb: "ESCALATE", expires_at: null, reason: `hold under rule ${id} expired ${prior.expires_at}; the finding stands` };
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
  return inWindow(input, againstPriorHold(input, rule, byRule(input, rule)));
}

/**
 * Step 2 of the contract before the prior HOLD is weighed: the verb the rule gives. until is the expiry a HOLD
 * names and carries: decided_at plus the rule's hours, or the kept expiry of a prior HOLD in force.
 */
function byRule(input: DecideInput, rule: PolicyRule, until = holdUntil(input.decidedAt, rule.hold_max_hours)): Decision {
  const by = (verb: DispositionVerb, reason: string, expires_at: string | null = null): Decision => ({ verb, reason, expires_at, decided_by: "policy", rule_id: rule.rule_id });
  const prod = production(input.probes, input.serves);
  const id = rule.rule_id;
  const cls = input.finding.class;

  // escalate: a technician decides every finding the rule governs; the agent changes nothing, whatever the lock.
  if (rule.on_drift === "escalate") {
    const what = APPROVAL_CLASSES.includes(cls) && input.approved
      ? (cls === "approved_missing" ? `approved ${hex(input.approved.value_hash, 12)} is absent from the run` : `live value drifted from approved ${hex(input.approved.value_hash, 12)}`)
      : NAMED_CLASSES.includes(cls) && input.finding.summary ? input.finding.summary : `this ${cls} finding stands`;
    return by("ESCALATE", `${what}; rule ${id} (${rule.criticality}) sends it to a technician and the agent changes nothing`);
  }

  if (APPROVAL_CLASSES.includes(cls) && input.approved) {
    const approvedHash = input.approved.value_hash;
    const a12 = hex(approvedHash, 12);
    const missing = cls === "approved_missing";
    // what the setting is against its approval, and what restoring or adopting it does
    const state = missing ? `approved ${a12} is absent from the run` : `live value drifted from approved ${a12}`;
    const restores = missing ? "restores it from that copy" : "rolls it back to that copy";
    const adopts = missing ? "adopts its absence" : "adopts the live value";
    if (rule.lock === 1 || rule.on_drift === "rollback") {
      const copy = validCopy(input.copies, approvedHash);
      if (copy) {
        return by("ROLLBACK", `${state}; vault commit ${hex(copy.git_commit, 8)} holds the approved copy, validated ${copy.result} with ${plural(gapCount(copy), "gap", "gaps")}, so rule ${id} ${restores}`);
      }
      const candidates = input.copies.filter((c) => c.blob_sha256 === approvedHash || c.value_hash === approvedHash);
      const lead = `${state} with ${copyText(candidates)} and ${productionText(prod)}`;
      if (prod.state === "affected") {
        if (rule.on_no_copy === "investigate_ticket") return by("FIX", `${lead}, so rule ${id} investigates, fixes where allowed, documents and opens a ticket`);
        if (rule.on_no_copy === "ticket") return by("ESCALATE", `${lead}, so rule ${id} opens a ticket for a technician`);
        return by("ADOPT", `${lead}, so rule ${id} ${adopts}`);
      }
      if (prod.state === "unknown") return by("ESCALATE", `${lead}, so production is unknown and rule ${id} sends it to a technician`);
      return by("HOLD", `${lead}, so rule ${id} holds it until ${until}`, until);
    }
    if (rule.on_drift === "investigate") {
      return prod.state === "affected"
        ? by("FIX", `${state} with ${productionText(prod)}, so rule ${id} investigates and fixes where allowed`)
        : by("ESCALATE", `${state} with ${productionText(prod)}, so rule ${id} sends it to a technician`);
    }
    if (rule.on_drift === "hold") return by("HOLD", `${state}; rule ${id} holds it until ${until}`, until);
    return by("ADOPT", `${state}; rule ${id} (${rule.criticality}) ${adopts}`);
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
