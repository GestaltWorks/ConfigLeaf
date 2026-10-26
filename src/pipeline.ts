// One assurance pass: what SAMPLE_MODE runs over sample/bundle.json with no model, and what the live pass
// runs with Nemotron 3 Ultra as the falsifier judge, the judge of the eval's C3 (the checks stay the class's
// defaults; Lightning chooses checks in the eval and the Actor). Every step is
// SQL through the DataLayer, or a World Model query over what that SQL returned; nothing maps an
// input to an answer.
//
//   gate     runComplete for every collection run. A failing run is traced not_checked and feeds
//            nothing below: not the World Model, not the hero query, not a finding. The audit log has
//            no run_id on its rows (audit_event is keyed by the vendor's event id so overlapping pulls
//            dedupe), so its gate works on the checks instead: when a tenant's latest cloudflare.audit
//            run failed the gate, or the tenant has none, every catalogue template that reads
//            audit_event (actor_attributed, previous_value_recoverable, record_reverted,
//            referent_unchanged) is a recorded rejection for that tenant's findings, "audit log
//            incomplete", and each such finding escalates; a partial pull is never read as "no actor,
//            no previous state".
//   observe  every observation of a passing host-bound run goes into the World Model. A dns_name
//            referent carries a fingerprint: what the name's A and AAAA records resolved to in the
//            DNS run of the same pass, taken as the passing DNS run nearest in time and within
//            PASS_WINDOW_MS (a pass collects every surface within minutes; "latest at or before"
//            would pair a 02:01 host run with the previous day's 02:05 DNS run, and no bound would
//            pair today's host run with a three-day-old DNS run when today's failed the gate).
//   detect   the hero query over the latest run of each (tenant, surface, host) against that DNS
//            run; with none in the window the group is not_checked and the trace names the DNS run
//            that failed. A row is found_but_different when the setting's bytes are unchanged since
//            the previous passing run and the World Model says the referent's fingerprint is not;
//            dns_change otherwise (no previous run, or the bytes changed too). The finding carries
//            the DNS record its row came from, matched on content: a name with an A and an AAAA
//            record gives two rows and two findings, each naming its own record.
//   survey   the estate queries (data/queries.ts) over the same pass: once per tenant against its DNS
//            run, a proxied CNAME aliasing a direct address record (proxy_split); per host, against
//            the latest passing nginx run and that DNS run, a proxied name served by an enabled block
//            that trusts no real_ip range, or a proxied wildcard landing on a host where nothing does
//            (proxied_without_real_ip), a record landing on the host with no enabled block naming it
//            (orphan_record) and a server_name with no record and no covering wildcard (orphan_vhost).
//            A survey finding has no previous observation, so its window is the audit log's reach
//            (AUDIT_SPAN_SQL) up to the observation; its anchor is the nginx setting the row names, or
//            the DNS record itself (object_id = record id) when the finding is about the record.
//            Then, over the latest run of each (tenant, surface, host) when it passes the gate
//            and over the tenant's latest passing DNS run: every setting whose live value differs from its
//            latest approval (drift_vs_approved, window from the approval to the observation); and over
//            each such nginx run, every file the host's newest backup lacks or holds with other bytes
//            (changed_since_backup, window from the backup to the observation); and over each such run and
//            the DNS run, every approved setting whose object the run holds neither an observation nor a
//            record row of (approved_missing, APPROVED_MISSING_SQL: a deleted vhost file, a deleted record; value_hash "",
//            approved_hash the approved value, window from the approval to the run). The names an absent
//            nginx object serves are its server_name values in the latest passing run of its host that held
//            it; an absent record's name is its name in the latest passing DNS run that held it.
//   check    the default precondition policy for the class, bound from the finding and run through
//            the catalogue; a parameter the finding cannot supply, or a check the SQL guard refuses,
//            is a recorded rejection: it escalates that one finding and the pass goes on.
//   decide   src/policy/decide.ts, in precedence order: the technician's exception, then the
//            policy rule that governs the setting (policy_rule rows of the tenant and of "*", read once per
//            tenant at the start of the pass, resolved per finding by src/policy/resolve.ts), then the
//            default: every check holds and none was rejected -> ADOPT, as a candidate; anything else ->
//            ESCALATE. A rule decides ADOPT, HOLD (with an expiry), ESCALATE, ROLLBACK or FIX from the
//            finding's class, the setting's approval, the vault copies of the approved value with their
//            latest validation and the probes of the pass on the names the object serves; approved_missing
//            is weighed as drift_vs_approved is, against the live value "". A HOLD the rule gives meets the
//            latest HOLD the ledger holds on the same live value (PRIOR_HOLDS_SQL, read once per tenant
//            with rules, decided before this pass): in force, the HOLD keeps that expiry; expired, ESCALATE.
//            Then the change window: on the first drift a rule weighs, the tenant's change_window rows
//            (CHANGE_WINDOWS_SQL, read once per tenant); a window open at decided_at on the finding's object
//            turns the rule's ROLLBACK, FIX or HOLD of a drift_vs_approved, changed_since_backup or
//            approved_missing finding into a HOLD until the window ends, its disposition row carrying the
//            window_id, and the decide line names the window. A read that fails is traced not_checked and fails
//            closed: such a ROLLBACK or FIX is ESCALATE, "change windows not read: <error>; a technician
//            decides". With windowTable false (the datasource lists no change_window table) no window is read.
//            Without a governing rule the verbs and the decide line are the default's. Between checks the
//            stop rule (src/stoprule.ts) may end checking early; for a finding on a DNS record
//            the step dates its exposure (src/engine/world.ts). When the pass is given a
//            TechnicianMemory (src/engine/memory.ts) the Decider recalls the technician's lessons for the
//            finding first, by exact scope key: an accepted exception in force yields ADOPT with its expiry
//            on the finding and a trace line naming the lesson; one that has lapsed re-raises the finding
//            as ESCALATE ("exception lapsed"), whatever the checks or the policy say. The checks still run
//            and are recorded either way. Given a Ledger, the pass records one disposition per
//            finding, keyed on its live value, its run and the pass's decided_at (src/ledger.ts, rows.ts
//            dispositionId), and, in the observe step, one referent_fingerprint per dns_name
//            observation of each passing host run (src/data/fingerprint.ts). One decider line per pass
//            counts the settings a locked rule governs that have no approved value, and the verbs.
//   judge    withheld and traced skipped, "verdict cannot move", when the withdraw rule says no judge call would be
//            worth spending or an exception settled it. Otherwise, given a judge (opts.judge, live:
//            src/agents/falsifier.ts liveJudge), the eval's C3 judge: the finding's summary and evidence rows to Nemotron
//            3 Ultra through Nightshift, which writes one refuting SELECT; the guard holds it to one SELECT over known
//            tables with LIMIT capped at 50 and the DataLayer runs it, rows striking the claim. The verdict counts only on
//            a receipt the gate passes. A rule's or an exception's decision stands whatever it says; a default decision
//            takes C3's (struck: ADOPT, the claim standing: the checks' verb), except that a strike never turns ESCALATE
//            into ADOPT. A verdict that does not count leaves the decision as it was, traced "judge not counted: <reason>".
//            With no judge, skipped and traced "model: none (sample)": SAMPLE_MODE, the eval's baseline and the tests.
//
// The steps run one after another and the reads inside a step run PASS_CONCURRENCY at a time (src/config.ts, default 4;
// src/concurrency.ts): the tenants' rule reads and the gate's run_complete per run, the observe step's reads per run, the
// detectors, then each finding's check, decide and judge, its checks one after another as the stop rule needs, and the
// locked count per tenant. A task reads; what it writes (the World Model, the ledger, the pass's lists) runs in the order
// a pass one task at a time runs it, and so do its trace lines, held until every line before them is written. A read
// several findings need (a probe run's rows, a tenant's change windows, a record's exposure, a tenant's audit span, a DNS
// run's observations) runs once, its lines where the first finding in order asks for it, under that ask's agent, and each
// later ask is one line naming its own agent and the read it reused. A failure anywhere fails the pass: the dispositions go
// to the ledger only after every step, so a pass that throws records none (the observe step's referent fingerprints,
// written as it runs, are keyed, and the next pass writes none twice). The detectors read the World
// Model's fingerprints, which the decide step's exposure edges never touch, so every detector runs before the first
// finding is checked. At any PASS_CONCURRENCY the findings, dispositions, ledger rows and trace lines are those of 1,
// line for line apart from timestamps, latencies and query ids (test/concurrency.test.ts).
//
// Measured 25 Oct 2026 on sample/bundle.json with the committed lessons (examples/memory), decided at
// 2026-10-25T14:17:53.416Z, the latest lesson's instant: 27 findings, ADOPT 23 under accepted exceptions, HOLD 3,
// ESCALATE 1 (examples/document.md).
// On test/fixtures/policy-bundle.json (test/pipeline.test.ts): 11 findings, ADOPT 2, HOLD 4, ESCALATE 1, ROLLBACK 3, FIX 1; blog.conf's approved_missing is
// ROLLBACK from its copy, the HOLD in force keeps its expiry and the expired one is ESCALATE; passes over the same runs
// at later instants write 11 rows each, and the first past the kept expiry records the found_but_different ESCALATE.

import { createHash } from "node:crypto";
// The live judge, the eval's C3 (src/agents/falsifier.ts).
import { addToTally, judgeClause, judgeFinding, otherTenant, zeroTally, type JudgeTally, type PassJudge, type PassJudgement } from "./agents/falsifier.ts";
import { defaultChecks, type FindingSummary, type RejectedCheck } from "./catalogue/select.ts";
import { CATALOGUE, runCheck, type CheckResult, type FindingClass } from "./catalogue/templates.ts";
import { HeldTracer, OrderedTrace, SharedReads, checkLimit, closing, inOrder, type Commit, type Task } from "./concurrency.ts";
import { config } from "./config.ts";
import { fingerprintRows } from "./data/fingerprint.ts";
import { DataLayerError, type DataLayer } from "./data/layer.ts";
import {
  approvedCopies, approvedMissing, auditSpan, changeWindows, changedSinceBackup, driftVsApproved, hero, latestApprovals, listRuns, objects, observationsOf, orphanRecords, orphanVhosts,
  policyRules, priorHolds, probesOfRun, proxiedWithoutRealIp, proxySplit, resolutions, runComplete, wildcardWithoutRealIp,
} from "./data/queries.ts";
import { dispositionId, type ChangeWindow, type DecidedBy, type Disposition, type DispositionVerb, type PolicyRule } from "./data/rows.ts";
import type { ExceptionLesson, TechnicianMemory } from "./engine/memory.ts";
import { DriftWorld, recordExposure, type ExposureLine, type Observation } from "./engine/world.ts";
import type { Ledger } from "./ledger.ts";
import { mailRecords } from "./m365.ts";
// The Decider and the rule that governs a setting (src/policy/).
import {
  APPROVAL_CLASSES, NO_PROBE_RUN, WINDOW_CLASSES, decide, openWindow, production, productionText, validCopy, type ApprovedValue, type CopyCandidate, type ExceptionState, type PriorHold, type ProbeView,
} from "./policy/decide.ts";
import { resolvePolicy } from "./policy/resolve.ts";
import { PolicyRuleRow, issues } from "./policy/schema.ts";
import type { Tracer } from "./trace.ts";
// The verifier's stop rule and the withdraw rule before the judge (src/stoprule.ts).
import { VERDICT_CANNOT_MOVE, countersSummary, earlyStopSummary, shouldStop, shouldWithdraw, zeroCounters, type StopCounters, type StopPolicy } from "./stoprule.ts";

type Row = Record<string, string>;

/** The five verbs a finding ends in; the default decides ADOPT or ESCALATE, a policy rule any of the five. */
export type Verb = DispositionVerb;
export const VERBS: readonly Verb[] = ["ADOPT", "HOLD", "ESCALATE", "ROLLBACK", "FIX"];

/** What the Decider settled for the finding: the verb, one plain sentence, the expiry (every HOLD has one), who decided and under which rule. */
export interface DispositionNote {
  verb: Verb; reason: string; expires_at: string | null; decided_by: DecidedBy; rule_id: string | null;
  /** The change window whose HOLD this is (src/policy/decide.ts step 3); absent on every other disposition. */
  window_id?: string;
}

/** The detail of a decide line the default settled: the default policy in one line. */
export const DEFAULT_POLICY_DETAIL = "model: none; policy: every check holds -> ADOPT candidate, any fails or unbound -> ESCALATE, HOLD needs a judge";

/** A host run and a DNS run belong to one pass only when they started within this of each other. */
export const PASS_WINDOW_MS = 6 * 3600 * 1000;

export interface CheckOutcome { template: string; holds: boolean; rowCount: number; explanation: string }

export interface WorldView { before: string | null; after: string | null; changed: boolean; bytes_unchanged: boolean }

/** The technician's accepted exception the Decider applied (ADOPT until `expires_at`) or found lapsed (re-raised as ESCALATE). */
export interface ExceptionNote {
  /** The lesson's id in the agent's memory (scripts/answer.ts --forget takes it). */
  lesson: string;
  status: "applied" | "lapsed";
  expires_at: string;
  scope_key: string;
  reason: string;
  accepted_by: string;
  accepted_at: string;
}

export interface Finding {
  /** Stable across passes: `fnd-` plus 16 hex of the World Model's finding id (tenant, class, host, object, setting, record). What a technician names to scripts/answer.ts. */
  id: string;
  finding: FindingSummary;
  verb: Verb;
  /** The Decider's disposition: the verb above, its reason, expiry, who decided and the rule. The ledger row carries the same fields. */
  disposition: DispositionNote;
  /** FOUND-BUT-DIFFERENT as the World Model saw it: the referent's fingerprint at the previous and at the current observation. Hero findings only; a survey finding has no previous observation. */
  world?: WorldView;
  checks: CheckOutcome[];
  /** Checks that did not run: a parameter the finding could not supply, or a check the data layer refused. */
  rejected: RejectedCheck[];
  /** The live judge's verdict (src/agents/falsifier.ts): struck, held or not counted, with its SELECT, rows, receipt and model; "skipped" when no judge ran on the finding. */
  judge: "skipped" | PassJudgement;
  /** The stop rule ended checking early: why, and the templates it did not run. */
  earlyStop?: { reason: string; skipped: string[] };
  /** Why the judge call was not spent, when the withdraw rule said so. */
  judgeWithheld?: string;
  /** Since when the record this finding rests on has been in its current state (src/engine/world.ts). */
  exposure?: ExposureLine;
  /** The accepted exception that settled the verb, applied or lapsed. Absent when none applies. */
  exception?: ExceptionNote;
}

export interface MemoryCounters {
  /** Lessons the memory held when the pass ran, every tenant. */
  lessons: number;
  /** Findings adopted under an accepted exception in force. */
  applied: number;
  /** Findings re-raised because their exception had lapsed. */
  lapsed: number;
}

export interface PassResult {
  runs: number;
  gatedOut: string[];
  observed: number;
  findings: Finding[];
  /** The verifier's counters for this pass; stopCounters reads the same numbers back from the trace's stop and judge lines. */
  verifier: StopCounters;
  /** What the Decider recalled; null when the pass was given no memory. */
  memory: MemoryCounters | null;
  /** Findings per verb, every verb listed. */
  verbs: Record<Verb, number>;
  /** Settings of the pass's latest runs that a locked rule governs and that have no approved value on record. */
  locked: number;
  /** The policy_rule rows read for the pass's tenants (their own and every "*" rule), the refused ones left out. */
  rules: number;
  /** Rows the ledger wrote this pass; null when the pass was given no ledger. */
  ledger: { dispositions: number; fingerprints: number } | null;
  /** The judge's tally: findings judged, struck, held and not counted. Absent when the pass was given no judge. */
  judge?: JudgeTally;
}

const nul = (s: string): string | null => (s === "" ? null : s);
const later = (a: string, b: string): string => (a > b ? a : b);
/** The templates that consult the audit log: withheld for a tenant whose audit run failed the gate. */
export const AUDIT_TEMPLATES: readonly string[] = CATALOGUE.filter((t) => t.sql.includes("{{t:audit_event}}")).map((t) => t.id);
/** A fingerprint for a finding anchored on a DNS record rather than a stored observation: sha256 of the redacted row text, labelled as such. */
const sha256 = (s: string): string => `sha256:${createHash("sha256").update(s).digest("hex")}`;

function toObservation(o: Row, fingerprint: string | null): Observation {
  return {
    tenantId: o.tenant_id, surface: o.surface, objectId: o.object_id, settingPath: o.setting_path, valueHash: o.value_hash,
    refersTo: o.refers_to_type ? { targetType: o.refers_to_type, targetId: o.refers_to_id, fingerprint } : undefined,
    observedAt: o.observed_at, source: o.source, authority: Number(o.authority), collectionId: o.run_id,
  };
}

const sameSetting = (a: Row) => (b: Row): boolean => a.object_id === b.object_id && a.setting_path === b.setting_path;

/** The run of `surface` among `candidates` nearest in time to `r`, same tenant, within PASS_WINDOW_MS; else undefined. */
export function nearestRun(candidates: Row[], r: Row, surface: string): Row | undefined {
  const t = Date.parse(r.started_at);
  const gap = (d: Row): number => Math.abs(Date.parse(d.started_at) - t);
  const best = candidates.filter((d) => d.tenant_id === r.tenant_id && d.surface === surface).sort((a, b) => gap(a) - gap(b))[0];
  return best && gap(best) <= PASS_WINDOW_MS ? best : undefined;
}

/** The DNS run among `candidates` nearest in time to `r`, same tenant, within PASS_WINDOW_MS; else undefined. */
const nearestDns = (candidates: Row[], r: Row): Row | undefined => nearestRun(candidates, r, "cloudflare.dns");

export interface PassOptions {
  tracer?: Tracer;
  world?: DriftWorld;
  stopPolicy?: Omit<StopPolicy, "gatedTables">;
  /** The technician's lessons the Decider consults before deciding; none when absent (tests, the eval, pre-flight). */
  memory?: TechnicianMemory;
  /** The instant lessons are recalled at (ISO 8601 UTC); the memory's clock when absent. */
  at?: string;
  /**
   * Each disposition's decided_at and the base of every HOLD expiry (ISO 8601 UTC); the system clock when absent.
   * scripts/sample.ts, scripts/examples.ts and scripts/build-site.ts pass the bundle's decisionInstant (src/data/instant.ts),
   * so two passes over the same rows give the same findings, expiries included.
   */
  decidedAt?: string;
  /** Where the pass records its dispositions and referent fingerprints; nothing is written when absent. */
  ledger?: Ledger;
  /**
   * Whether the datasource lists the change_window table. false: the caller's listing lacks it (src/loop/pass.ts asks
   * Zetaris), so no window can be open and the pass reads none, traced skipped. true or absent: the pass reads it,
   * and a read that fails escalates every drift a rule would roll back or fix.
   */
  windowTable?: boolean;
  /** How many of the pass's reads run at a time (see the header); PASS_CONCURRENCY when absent, 1 for one at a time. */
  concurrency?: number;
  /**
   * The live judge (src/agents/falsifier.ts liveJudge): the eval's C3 judge on every finding the withdraw rule leaves open.
   * Absent, the pass runs no model: what SAMPLE_MODE, the eval's baseline, the examples and the tests run.
   */
  judge?: PassJudge;
}

const h12 = (h: string): string => h.replace(/^sha256:/, "").slice(0, 12);
const earlier = (a: string, b: string): string => (a < b ? a : b);

/** A policy_rule row as the DataLayer returns it (every value a string, NULL as "") back to its type; a row the schema refuses gives the reason. */
export function ruleOf(r: Readonly<Record<string, string>>): PolicyRule | { refused: string } {
  const row = {
    rule_id: r.rule_id, tenant_id: r.tenant_id, surface: r.surface, object_glob: r.object_glob, setting_glob: r.setting_glob,
    criticality: r.criticality, lock: Number(r.lock), on_drift: r.on_drift, on_no_copy: r.on_no_copy, hold_max_hours: Number(r.hold_max_hours),
    alert: r.alert, psa_priority: r.psa_priority, version: Number(r.version), author: r.author, since: r.since, note: nul(r.note),
  };
  const p = PolicyRuleRow.safeParse(row);
  return p.success ? (p.data as PolicyRule) : { refused: issues(p.error).join("; ") };
}

/** One copy row of APPROVED_COPIES_SQL as the Decider reads it. */
const copyOf = (r: Row): CopyCandidate => ({
  copy_id: r.copy_id, run_id: r.run_id, git_commit: r.git_commit, blob_sha256: r.blob_sha256, taken_at: r.taken_at, value_hash: r.value_hash,
  validator: r.validator, result: r.result, missing_dependencies: r.missing_dependencies, validated_at: r.validated_at,
});

const NO_PROBES: ProbeView = { run_id: null, rows: [] };

/** `fnd-` plus 16 hex of sha256 over the World Model's finding id: short enough to type, stable across passes. */
export const shortFindingId = (worldFindingId: string): string => `fnd-${createHash("sha256").update(worldFindingId).digest("hex").slice(0, 16)}`;

export async function runPass(layer: DataLayer, opts: PassOptions = {}): Promise<PassResult> {
  const { tracer, memory } = opts;
  const world = opts.world ?? new DriftWorld("pass");
  const findings: Finding[] = [];
  // Counters for the pass (sums, so the tasks add to them in any order); what was recalled.
  const verifier = zeroCounters();
  const recalled: MemoryCounters | null = memory ? { lessons: memory.lessons().length, applied: 0, lapsed: 0 } : null;
  // The judge's tally, added to at each finding's commit; none when the pass runs no model.
  const judged: JudgeTally | undefined = opts.judge ? zeroTally(opts.judge) : undefined;
  // Every disposition of the pass carries one decided_at; the rows go to the ledger at the end.
  const decidedAt = new Date(opts.decidedAt ?? Date.now()).toISOString();
  const dispositions: Disposition[] = [];
  let fingerprints = 0;

  // The reads of a step run `concurrency` at a time, their writes and trace lines in task order (src/concurrency.ts): each task
  // a tracer of its own, its lines after every earlier task's. Between steps every held line is written, so the pass's own
  // lines there go to the tracer as they are. A read several tasks need runs once, through `shared`.
  const concurrency = checkLimit(opts.concurrency ?? config.passConcurrency);
  const order = tracer ? new OrderedTrace(tracer) : undefined;
  const shared = new SharedReads(order);
  const inTurn = (tasks: readonly Task[], tracerOf: (i: number) => HeldTracer | undefined = () => order?.next()): Promise<void> =>
    inOrder(tasks, concurrency, tracerOf);

  /** Why the tenant's audit log may not be consulted this pass, or null when its latest audit run passed the gate. Filled by the gate step. */
  const auditWithheld = new Map<string, string>();

  // The tenant's rules (read below, once per tenant), the probe rows of each probe run (read on first use), and the
  // observations of each passing run the pass loaded; the Decider's inputs come from these and from one copy query per drift.
  const rulesByTenant = new Map<string, PolicyRule[]>();
  const obsByRun = new Map<string, Row[]>();
  let runs: Row[] = [];
  let passingRuns: Row[] = [];

  /** The passing probe run of the tenant nearest in time to the finding's run, within PASS_WINDOW_MS, with its rows; run_id null when there is none. */
  const probesFor = async (finding: FindingSummary, t: HeldTracer | undefined): Promise<ProbeView> => {
    const own = runs.find((r) => r.run_id === finding.run_id);
    const run = own ? nearestRun(passingRuns, own, "probe") : undefined;
    if (!run) return NO_PROBES;
    // the probe run is the finding's tenant's, so its run id alone names the read
    const rows = await shared.read(`probe ${run.run_id}`, t, "decider", async (lines) =>
      objects(await probesOfRun(layer, { tenant_id: finding.tenant_id, run_id: run.run_id }, { tracer: lines, agent: "decider" })).map((p) => ({ kind: p.kind, target: p.target, status: p.status })));
    return { run_id: run.run_id, rows };
  };

  /**
   * The redacted names the finding's object serves: a record's own name, or an nginx object's server_name values in the run;
   * for an approved_missing object, absent from its run, the values in the latest passing run of its host that held it.
   */
  const servedNames = (finding: FindingSummary): string[] => {
    if (finding.surface === "cloudflare.dns") return finding.dns_name ? [finding.dns_name] : [];
    const namesIn = (obs: readonly Row[]): string[] =>
      [...new Set(obs.filter((o) => o.object_id === finding.object_id && o.refers_to_type === "dns_name" && o.setting_path.includes(".server_name[")).map((o) => o.refers_to_id))].sort();
    if (finding.class !== "approved_missing") return namesIn(obsByRun.get(finding.run_id) ?? []);
    const held = passingRuns
      .filter((r) => r.tenant_id === finding.tenant_id && r.surface === finding.surface && r.host === (finding.host ?? ""))
      .map((r) => obsByRun.get(r.run_id) ?? [])
      .filter((obs) => obs.some((o) => o.object_id === finding.object_id))
      .at(-1);
    return held ? namesIn(held) : [];
  };

  // The latest HOLD of each live value of the tenant's settings decided before this pass (PRIOR_HOLDS_SQL), read once
  // per tenant with rules: a HOLD comes from a rule only. Keyed on surface, host, object, setting and live value.
  const holdsByTenant = new Map<string, Map<string, PriorHold>>();
  const holdKey = (x: { surface: string; host: string | null; object_id: string; setting_path: string; value_hash: string }): string =>
    [x.surface, x.host ?? "", x.object_id, x.setting_path, x.value_hash].join("\u001f");

  // The tenant's change windows (CHANGE_WINDOWS_SQL), read once per tenant on the first drift a rule weighs: a window
  // holds drift_vs_approved, changed_since_backup and approved_missing only. A read that fails (a store whose schema
  // predates change_window, a datasource that does not list it, a failed query) is traced not_checked and fails
  // closed: the error goes to the Decider, which escalates every such drift a rule would roll back or fix this pass
  // (src/policy/decide.ts step 3). With opts.windowTable false no window can be open, and none is read.
  const windowsFor = (tenant: string, t: HeldTracer | undefined): Promise<{ rows: ChangeWindow[]; error: string | null }> =>
    shared.read(`change_window ${tenant}`, t, "decider", async (lines) => {
      if (opts.windowTable === false) {
        lines?.emit({ agent: "decider", action: "check", status: "skipped", input_summary: `change_window ${tenant}`, output_summary: "the datasource lists no change_window table: no window is open; npm run zetaris:setup registers it" });
        return { rows: [], error: null };
      }
      try {
        return {
          error: null,
          rows: objects(await changeWindows(layer, tenant, { tracer: lines, agent: "decider", limit: 100_000 })).map((w) => ({
            window_id: w.window_id, tenant_id: w.tenant_id, surface: w.surface, host: nul(w.host), object_id: w.object_id, setting_path: w.setting_path,
            opened_by: w.opened_by, opened_at: w.opened_at, until: w.until, reason: w.reason, closed_at: nul(w.closed_at),
          })),
        };
      } catch (err) {
        const error = (((err as Error)?.message ?? String(err)).split("\n")[0] || "the read failed").slice(0, 200);
        lines?.emit({ agent: "decider", action: "check", status: "not_checked", input_summary: `change_window ${tenant}`, output_summary: `change windows of ${tenant} not read: a drift a rule would roll back or fix is ESCALATE this pass`, detail: (err as Error)?.message ?? String(err) });
        return { rows: [], error };
      }
    });

  /**
   * check, decide, judge for one finding, whatever produced it, its lines into `t`; returns the commit that appends it to findings and
   * its disposition, and stores its exposure edge. `approved` is the setting's latest approval, which a drift_vs_approved and an
   * approved_missing row carry.
   */
  const assess = async (finding: FindingSummary, view: WorldView | undefined, approved: ApprovedValue | null, t: HeldTracer | undefined): Promise<Commit> => {
    // Recalled before the first await: the findings' tasks start in finding order, so the memory's ledger logs the recalls
    // in the order a pass one finding at a time makes them.
    const recall = memory?.recall(finding, opts.at);
    const cls = finding.class;
    const setting = `${finding.setting_path} in ${finding.object_id}${finding.host ? ` on ${finding.host}` : ""}`;
    const selection = defaultChecks(finding);
    const checks: CheckOutcome[] = [];
    const rejected: RejectedCheck[] = [...selection.rejected];
    const withheld = auditWithheld.get(finding.tenant_id);
    // Between checks the stop rule says whether the verb can still move. A settled verdict skips
    // the queued checks that do not inform the next action (traced "skipped" with the reason); when every
    // queued check reads the withheld audit log they are recorded at once as not checked (they escalate).
    const stopPolicy: StopPolicy = { ...opts.stopPolicy, gatedTables: withheld !== undefined ? ["audit_event"] : [] };
    let earlyStop: { reason: string; skipped: string[] } | undefined;
    const queue = [...selection.valid];
    while (queue.length > 0) {
      const stop = shouldStop({
        findingClass: cls, checksSoFar: checks, remaining: queue.map((q) => q.template), policy: stopPolicy,
        rejected: rejected.map((rj) => String((rj.check as { template?: unknown })?.template ?? "?")),
      });
      if (stop.stop) {
        const out = queue.filter((q) => stop.skipped.includes(q.template));
        queue.splice(0, queue.length, ...queue.filter((q) => !stop.skipped.includes(q.template)));
        for (const q of out) {
          if (stop.kind === "gated") rejected.push({ check: q, reason: `${q.template}: audit log incomplete (${withheld})` });
          else t?.emit({ agent: "checker", action: "check", status: "skipped", input_summary: `${q.template} ${JSON.stringify(q.params)}`.slice(0, 200), detail: stop.reason });
        }
        verifier.early_stop += 1;
        if (stop.kind === "gated") verifier.checks_gated += out.length;
        else verifier.checks_skipped += out.length;
        earlyStop = { reason: earlyStop ? `${earlyStop.reason}; ${stop.reason}` : stop.reason, skipped: [...(earlyStop?.skipped ?? []), ...out.map((q) => q.template)] };
        t?.emit({ agent: "checker", action: "check", status: "skipped", input_summary: `${cls} ${setting}`, output_summary: earlyStopSummary(stop.kind, out.map((q) => q.template)), detail: stop.reason });
        continue;
      }
      const c = queue.shift()!;
      if (withheld !== undefined && AUDIT_TEMPLATES.includes(c.template)) {
        rejected.push({ check: c, reason: `${c.template}: audit log incomplete (${withheld})` });
        continue;
      }
      let r: CheckResult;
      try {
        r = await runCheck(layer, c.template, c.params, { tracer: t, agent: "checker" });
      } catch (err) {
        // The guard or the engine refused this one check: record it, escalate this finding, keep the pass going.
        if (!(err instanceof DataLayerError)) throw err;
        rejected.push({ check: c, reason: `${c.template}: ${err.message}` });
        continue;
      }
      checks.push({ template: r.template, holds: r.holds, rowCount: r.rowCount, explanation: r.explanation });
      t?.emit({
        agent: "checker", action: "check", status: r.holds ? "ok" : "failed",
        input_summary: `${r.template} ${JSON.stringify(c.params)}`.slice(0, 200),
        output_summary: `${r.template}: ${r.holds ? "holds" : "fails"} (${r.rowCount} rows)`, detail: r.explanation,
      });
    }
    for (const rj of rejected) {
      t?.emit({ agent: "checker", action: "check", status: "not_checked", input_summary: String((rj.check as { template?: unknown })?.template ?? "?"), detail: rj.reason });
    }

    const failing = checks.filter((c) => !c.holds).map((c) => c.template);
    const policyVerb: "ADOPT" | "ESCALATE" = checks.length > 0 && failing.length === 0 && rejected.length === 0 ? "ADOPT" : "ESCALATE";
    const policyWhy = policyVerb === "ADOPT"
      ? `all ${checks.length} preconditions hold; candidate pending a judge`
      : [
        failing.length ? `${failing.length} of ${checks.length} preconditions fail: ${failing.join(", ")}` : "",
        rejected.length ? `${rejected.length} check(s) could not be bound from the finding or were refused by the guard` : "",
        checks.length === 0 && rejected.length === 0 ? "no precondition ran" : "",
      ].filter(Boolean).join("; ");

    // Recall before deciding, by exact scope key (same tenant, same class, the finding's host, name or
    // address). An exception in force settles ADOPT with its expiry; a lapsed one, with none in force, re-raises
    // the finding as ESCALATE however the checks came out. Answers (kind "answer") are stored and counted; the pass
    // reads exceptions only.
    const applied = recall?.applicable.find((l): l is ExceptionLesson => l.kind === "exception") ?? null;
    const lapsed = applied ? null : (recall?.expired.filter((l): l is ExceptionLesson => l.kind === "exception").at(-1) ?? null);
    const lesson = applied ?? lapsed;
    // The rule that governs the setting, and what the Decider needs to weigh it: the vault copies of the approved
    // value (a drift under a locked or rollback rule), the probes of the pass, the names the object serves. No rule, or an
    // exception that settles it, and nothing more is read.
    const rule = resolvePolicy(rulesByTenant.get(finding.tenant_id) ?? [], finding);
    const exceptionState: ExceptionState = applied
      ? { state: "applied", lesson: applied.id, expires_at: applied.expiresAt, reason: applied.reason }
      : lapsed ? { state: "lapsed", lesson: lapsed.id, expires_at: lapsed.expiresAt, reason: lapsed.reason } : { state: "none" };
    const weigh = rule !== null && lesson === null;
    const copies = weigh && APPROVAL_CLASSES.includes(cls) && approved && (rule.lock === 1 || rule.on_drift === "rollback")
      ? objects(await approvedCopies(layer, {
        tenant_id: finding.tenant_id, surface: finding.surface, host: finding.host ?? "", object_id: finding.object_id, setting_path: finding.setting_path, approved_hash: approved.value_hash,
      }, { tracer: t, agent: "decider" })).map(copyOf)
      : [];
    const probes = weigh ? await probesFor(finding, t) : NO_PROBES;
    const serves = weigh ? servedNames(finding) : [];
    const priorHold = weigh ? (holdsByTenant.get(finding.tenant_id)?.get(holdKey(finding)) ?? null) : null;
    const windows = weigh && WINDOW_CLASSES.includes(cls) ? await windowsFor(finding.tenant_id, t) : null;
    const window = windows ? openWindow(windows.rows, finding, decidedAt) : null;
    const windowError = windows?.error ?? null;
    const decision = decide({ finding, rule, exception: exceptionState, checks: { verb: policyVerb, why: policyWhy }, approved, copies, probes, serves, decidedAt, priorHold, window, windowError });
    const verb: Verb = decision.verb;
    const why = decision.reason;
    if (applied && recalled) recalled.applied += 1;
    if (lapsed && recalled) recalled.lapsed += 1;
    if (applied) {
      t?.emit({
        agent: "decider", action: "triage", status: "ok", input_summary: `memory ${cls} ${setting}`,
        output_summary: `exception ${applied.id} accepted by ${applied.provenance.by} until ${applied.expiresAt}: ADOPT`,
        detail: `lesson ${applied.id} on ${applied.scopeKey} (${applied.findingClass}), recorded ${applied.recordedAt}: ${applied.reason}; model: none`,
      });
    }
    if (lapsed) {
      t?.emit({
        agent: "decider", action: "escalate", status: "ok", input_summary: `memory ${cls} ${setting}`,
        output_summary: `exception ${lapsed.id} lapsed ${lapsed.expiresAt}: re-raised as ESCALATE`,
        detail: `lesson ${lapsed.id} on ${lapsed.scopeKey} (${lapsed.findingClass}), accepted by ${lapsed.provenance.by} ${lapsed.recordedAt}: ${lapsed.reason}; the exception is not applied; model: none`,
      });
    }
    // A rule's decide line names the rule, what the checks alone say, production and the copy weighed; the default's is the default policy.
    const prod = weigh ? production(probes, serves) : null;
    const copy = approved ? validCopy(copies, approved.value_hash) : null;
    const basis = weigh && rule
      ? `model: none; policy: ${rule.rule_id} (${rule.surface} ${rule.object_glob} ${rule.setting_glob} v${rule.version}: ${rule.criticality}, lock ${rule.lock}, on_drift ${rule.on_drift}, on_no_copy ${rule.on_no_copy}, hold ${rule.hold_max_hours} h); `
        + `the checks alone say ${policyVerb}; ${productionText(prod!)}`
        + (approved ? `; approved ${h12(approved.value_hash)}, ${copies.length} copy row(s), ${copy ? `valid copy ${copy.copy_id} at ${copy.git_commit.slice(0, 8)}` : "no valid copy"}` : "")
        + (priorHold ? `; prior HOLD since ${priorHold.decided_at} until ${priorHold.expires_at}` : "")
        + (window ? `; change window ${window.window_id} open from ${window.opened_at} until ${window.until}` : "")
        + (windowError ? `; change windows not read: ${windowError}` : "")
      : DEFAULT_POLICY_DETAIL;
    t?.emit({
      agent: "decider", action: "decide", status: "ok", input_summary: `${cls} ${setting}`, output_summary: `${verb}: ${why}`,
      detail: basis
        + (earlyStop ? `; earlyStop: true (${earlyStop.reason})` : "") // The decide step receives { earlyStop, reason }
        + (lesson ? `; exception: ${lesson.id} ${applied ? "applied" : "lapsed"}` : "") // and the lesson that settled it
        + (lesson && rule ? `; policy: ${rule.rule_id} governs the setting, the exception decides` : ""),
    });
    // The decide step records the exposure line: SQL dates it, once per record and field, the World Model keeps it as an
    // open edge, stored at the commit. Its lines are held at this place: the ok line is traced only once the commit has
    // stored the edge, and a store that throws traces a failed line there and nothing after it. The held lines are closed on
    // every path: by the commit (closing, src/concurrency.ts) once it is handed back, or here when anything throws before.
    const edgeLines = t?.hold();
    let storeEdge: (() => Promise<void>) | undefined;
    try {
      const exposure = await recordExposure(layer, world, finding, {
        tracer: edgeLines, cache: (key, measure) => shared.read(`exposure ${key}`, edgeLines, "decider", measure), defer: (store) => { storeEdge = store; },
      });
      // Withdraw before the judge: no judge call is spent on a verdict that cannot move or a claim its own checks contradict;
      // nor on a verdict the technician's exception settled, in force or lapsed.
      const withdraw = applied
        ? { withdraw: true, reason: `${VERDICT_CANNOT_MOVE}: accepted exception ${applied.id} holds until ${applied.expiresAt}; the technician's acceptance, not a judge, settles it` }
        : lapsed
          ? { withdraw: true, reason: `${VERDICT_CANNOT_MOVE}: exception ${lapsed.id} lapsed ${lapsed.expiresAt}; the finding goes back to the technician whatever a judge answers` }
          : shouldWithdraw({ findingClass: cls, checks, rejected: rejected.length });
      if (withdraw.withdraw) verifier.withdrawn_judge += 1;
      if (withdraw.contradictedBy) {
        t?.emit({ agent: "checker", action: "critique", target_agent: "detector", status: "ok", input_summary: `${cls} ${setting}`, output_summary: withdraw.reason, detail: "model: none" });
        t?.emit({ agent: "detector", action: "revise", status: "ok", input_summary: `${cls} ${setting}`, output_summary: "finding withdrawn before judge", detail: withdraw.reason });
      }
      const decided: DispositionNote = {
        verb, reason: why, expires_at: decision.expires_at, decided_by: decision.decided_by, rule_id: decision.rule_id, ...(decision.window_id ? { window_id: decision.window_id } : {}),
      };
      // The judge: live, the eval's C3 judge on a finding of the judge's tenant the withdraw rule leaves open
      // (src/agents/falsifier.ts). Its lines, the evidence read, the model call, the gate and the refuting SELECT, then one
      // judge line, go where the skipped line goes. A rule's or an exception's decision stands; a default one takes C3's
      // verdict, a strike never turning ESCALATE into ADOPT; a verdict that does not count leaves the decision as it is.
      let disposition = decided;
      let judgement: PassJudgement | undefined;
      const judge = opts.judge;
      const mine = judge !== undefined && (judge.tenant === undefined || judge.tenant === finding.tenant_id);
      if (judge && mine && !withdraw.withdraw) ({ disposition, judgement } = await judgeFinding(layer, finding, decided, judge, t));
      else {
        const skipped = withdraw.withdraw ? withdraw.reason : judge?.tenant !== undefined && !mine ? otherTenant(finding.tenant_id, judge.tenant) : "model: none (sample)";
        t?.emit({ agent: "judge", action: "judge", status: "skipped", input_summary: finding.summary.slice(0, 160), detail: skipped });
      }
      const exception: ExceptionNote | undefined = lesson
        ? { lesson: lesson.id, status: applied ? "applied" : "lapsed", expires_at: lesson.expiresAt, scope_key: lesson.scopeKey, reason: lesson.reason, accepted_by: lesson.provenance.by, accepted_at: lesson.recordedAt }
        : undefined;
      const id = shortFindingId(world.findingId(finding));
      // One row per finding per pass, about the live value the decision is about.
      const row: Disposition = {
        disposition_id: dispositionId(finding.tenant_id, finding.surface, finding.host, finding.object_id, finding.setting_path, finding.value_hash, id, finding.run_id, decidedAt),
        tenant_id: finding.tenant_id, surface: finding.surface, host: finding.host, object_id: finding.object_id, setting_path: finding.setting_path,
        value_hash: finding.value_hash, ...disposition, finding_id: id, run_id: finding.run_id, decided_at: decidedAt,
      };
      const assessed: Finding = {
        id,
        finding, verb: disposition.verb, disposition, ...(view ? { world: view } : {}), checks, rejected, judge: judgement ?? "skipped",
        ...(earlyStop ? { earlyStop } : {}), ...(withdraw.withdraw ? { judgeWithheld: withdraw.reason } : {}), ...(exposure ? { exposure } : {}),
        ...(exception ? { exception } : {}),
      };
      return closing(edgeLines, async () => {
        await storeEdge?.();
        dispositions.push(row);
        findings.push(assessed);
        if (judged && judgement) addToTally(judged, judgement);
      });
    } catch (e) {
      edgeLines?.close();
      throw e;
    }
  };

  runs = objects(await listRuns(layer, { tracer, agent: "observer" }));

  // The tenant's rules and every "*" rule, once per tenant, at the start of the pass; a row the policy schema refuses is
  // left out and traced, so only rules the schema accepts decide. The gate's read per run goes in the same step: neither
  // depends on the other.
  let rulesRead = 0;
  const readRules = (tenant: string): Task => async (t) => {
    const kept: PolicyRule[] = [];
    for (const row of objects(await policyRules(layer, tenant, { tracer: t, agent: "decider" }))) {
      const rule = ruleOf(row);
      if ("refused" in rule) {
        t?.emit({ agent: "decider", action: "check", status: "not_checked", input_summary: `policy_rule ${row.rule_id}`, output_summary: `policy rule ${row.rule_id} refused for ${tenant}; left out of this pass`, detail: rule.refused });
        continue;
      }
      kept.push(rule);
    }
    const holds = new Map<string, PriorHold>();
    if (kept.length) {
      for (const h of objects(await priorHolds(layer, { tenant_id: tenant, decided_at: decidedAt }, { tracer: t, agent: "decider", limit: 100_000 }))) {
        const key = holdKey({ surface: h.surface, host: nul(h.host), object_id: h.object_id, setting_path: h.setting_path, value_hash: h.value_hash });
        if (h.expires_at) holds.set(key, { decided_at: h.decided_at, expires_at: h.expires_at, rule_id: nul(h.rule_id) });
      }
    }
    return () => {
      rulesByTenant.set(tenant, kept);
      rulesRead += kept.length;
      if (kept.length) holdsByTenant.set(tenant, holds);
    };
  };

  // gate
  const gatedOut = new Set<string>();
  const gate = (r: Row): Task => async (t) => {
    const g = await runComplete(layer, r.run_id, { tracer: t, agent: "observer" });
    t?.emit({
      agent: "observer", action: "check", status: g.total > 0 ? "not_checked" : "ok",
      input_summary: `run_complete ${r.run_id}`,
      output_summary: `${r.surface}${r.host ? ` ${r.host}` : ""}: ${r.observed_count}/${r.expected_count} ${r.status}`,
      detail: g.total > 0 ? `run ${r.run_id} fails the DQ gate; its observations feed no finding` : undefined,
    });
    return () => {
      if (g.total > 0) gatedOut.add(r.run_id);
    };
  };
  await inTurn([...[...new Set(runs.map((r) => r.tenant_id))].sort().map(readRules), ...runs.map(gate)]);
  const passing = runs.filter((r) => !gatedOut.has(r.run_id));
  passingRuns = passing;
  // The audit surface's gate: audit_event rows carry no run_id, so a failing audit run withholds the audit templates per tenant.
  for (const tenant of new Set(runs.map((r) => r.tenant_id))) {
    const latestAudit = runs.filter((r) => r.tenant_id === tenant && r.surface === "cloudflare.audit").at(-1);
    const why = !latestAudit ? "no cloudflare.audit run for this tenant" : gatedOut.has(latestAudit.run_id) ? `latest audit run ${latestAudit.run_id} failed the DQ gate` : null;
    if (why === null) continue;
    auditWithheld.set(tenant, why);
    tracer?.emit({
      agent: "observer", action: "check", status: "not_checked", input_summary: `audit_event ${tenant}`,
      output_summary: `audit log withheld for ${tenant}: ${why}`, detail: `${AUDIT_TEMPLATES.join(", ")} are rejected for every finding of this tenant this pass`,
    });
  }
  const dnsFor = (r: Row): Row | undefined => nearestDns(passing, r);
  const gatedDnsFor = (r: Row): Row | undefined => nearestDns(runs.filter((x) => gatedOut.has(x.run_id)), r);

  // observe: each run's reads a task, its observations into the World Model and its fingerprints into the ledger in run order
  const resByRun = new Map<string, Row[]>();
  let observed = 0;
  await inTurn(passing.filter((x) => x.host !== "").map((r): Task => async (t) => {
    const obs = objects(await observationsOf(layer, r.run_id, { tracer: t, agent: "observer" }));
    const dns = dnsFor(r);
    const res = dns ? objects(await resolutions(layer, { run_id: r.run_id, dns_run_id: dns.run_id }, { tracer: t, agent: "observer" })) : [];
    return async () => {
      obsByRun.set(r.run_id, obs);
      resByRun.set(r.run_id, res);
      const fp = new Map<string, string[]>();
      for (const x of res) fp.set(x.obs_id, [...(fp.get(x.obs_id) ?? []), x.content]);
      for (const o of obs) await world.observe(toObservation(o, fp.get(o.obs_id)?.sort().join(",") ?? null));
      // The same fingerprints as rows: what each dns_name setting of the run resolved to in its DNS run.
      if (opts.ledger && dns) fingerprints += await opts.ledger.recordFingerprints(fingerprintRows(obs, res, dns));
      observed += obs.length;
      t?.emit({
        agent: "observer", action: "observe", status: "ok", input_summary: r.run_id,
        output_summary: `${obs.length} observations recorded, ${fp.size} with a resolved referent${dns ? ` (DNS run ${dns.run_id})` : " (no DNS run of this pass passed the gate)"}`,
        detail: "model: none",
      });
    };
  }));

  // detect: every detector a task, in the order a pass one task at a time runs them (the hero query per host group, the survey,
  // the drift and backup detectors). A detector reports each finding it makes: the finding's lines take their place among the
  // detector's, and it is checked, decided and judged in the step after, in the order reported.
  type Reported = { finding: FindingSummary; view: WorldView | undefined; approved: ApprovedValue | null; lines: HeldTracer | undefined };
  type Report = (finding: FindingSummary, view?: WorldView, approved?: ApprovedValue) => void;
  const detectors: ((t: HeldTracer | undefined, report: Report) => Promise<void>)[] = [];

  const groups = new Map<string, Row[]>();
  for (const r of runs.filter((x) => x.host !== "")) {
    const k = `${r.tenant_id}|${r.surface}|${r.host}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const group of groups.values()) detectors.push(async (t, report) => {
    const latest = group[group.length - 1];
    const where = `${latest.surface} ${latest.host}`;
    if (gatedOut.has(latest.run_id)) {
      t?.emit({ agent: "detector", action: "detect", status: "not_checked", input_summary: where, output_summary: `latest run ${latest.run_id} failed the DQ gate; not checked this pass` });
      return;
    }
    const dns = dnsFor(latest);
    if (!dns) {
      const gated = gatedDnsFor(latest);
      t?.emit({
        agent: "detector", action: "detect", status: "not_checked", input_summary: where,
        output_summary: gated
          ? `no DNS run of this pass passed the gate (${gated.run_id} failed); the hero query has nothing to join`
          : "no DNS run of this pass for this tenant; the hero query has nothing to join",
      });
      return;
    }
    const previous = group.filter((r) => !gatedOut.has(r.run_id) && r.run_id !== latest.run_id).at(-1);
    const rows = objects(await hero(layer, { tenant_id: latest.tenant_id, run_id: latest.run_id, dns_run_id: dns.run_id }, { tracer: t, agent: "detector" }));
    t?.emit({
      agent: "detector", action: "detect", status: "ok", input_summary: `hero ${latest.run_id} x ${dns.run_id}`,
      output_summary: `${where}: ${rows.length} setting(s) point at a name resolving outside the inventory`, detail: "model: none",
    });

    for (const row of rows) {
      const cur = obsByRun.get(latest.run_id)?.find(sameSetting(row));
      if (!cur) throw new Error(`hero row for ${row.object_id} ${row.setting_path} has no observation in ${latest.run_id}`);
      const prev = previous ? obsByRun.get(previous.run_id)?.find(sameSetting(row)) : undefined;
      const sid = world.settingId({ tenantId: cur.tenant_id, surface: cur.surface, objectId: cur.object_id, settingPath: cur.setting_path });
      const fbd = prev ? world.foundButDifferent(sid, prev.observed_at, cur.observed_at) : { changed: false, before: null, after: world.fingerprintNow(sid) };
      const bytesUnchanged = prev !== undefined && prev.value_hash === cur.value_hash;
      const cls: FindingClass = bytesUnchanged && fbd.changed ? "found_but_different" : "dns_change";
      const since = prev?.observed_at ?? latest.started_at;
      const until = row.dns_observed_at > cur.observed_at ? row.dns_observed_at : cur.observed_at;
      // The record this row came from: RESOLUTIONS_SQL returns one row per record, so match on content, not only on the observation.
      const record = resByRun.get(latest.run_id)?.find((x) => x.obs_id === cur.obs_id && x.content === row.resolves_to);
      const setting = `${cur.setting_path} in ${cur.object_id} on ${cur.host}`;
      const summary = cls === "found_but_different"
        ? `${setting} is byte-identical since ${since}; ${row.upstream_name} resolved to ${fbd.before} then and to ${row.resolves_to} now, an address not in the inventory`
        : `${setting} points at ${row.upstream_name}, which resolves to ${row.resolves_to}, an address not in the inventory`;
      const finding: FindingSummary = {
        class: cls, tenant_id: cur.tenant_id, run_id: cur.run_id, surface: cur.surface, host: nul(cur.host),
        object_id: cur.object_id, setting_path: cur.setting_path, value_hash: cur.value_hash, value_redacted: nul(cur.value_redacted),
        refers_to_type: nul(cur.refers_to_type), refers_to_id: nul(cur.refers_to_id),
        dns_name: row.upstream_name, resolves_to: row.resolves_to, resource_id: record?.record_id ?? null, dns_run_id: dns.run_id,
        since, until, summary,
      };
      t?.emit({
        agent: "detector", action: "detect", status: "ok", input_summary: setting, output_summary: `${cls}: ${summary}`,
        detail: `fingerprint ${fbd.before ?? "unknown"} -> ${fbd.after ?? "unknown"}; bytes ${bytesUnchanged ? "unchanged" : prev ? "changed" : "no previous passing run"} (model: none)`,
      });
      report(finding, { before: fbd.before, after: fbd.after, changed: fbd.changed, bytes_unchanged: bytesUnchanged });
    }
  });

  // survey
  const auditReach = (tenant: string, t: HeldTracer | undefined): Promise<string | null> =>
    shared.read(`audit_span ${tenant}`, t, "detector", async (lines) => nul(objects(await auditSpan(layer, tenant, { tracer: lines, agent: "detector" }))[0]?.first_at ?? ""));
  const surveyOpts = (t: HeldTracer | undefined) => ({ tracer: t, agent: "detector" });

  const latestDns = new Map<string, Row>();
  for (const d of passing.filter((r) => r.surface === "cloudflare.dns")) latestDns.set(d.tenant_id, d);
  for (const [tenant, dns] of latestDns) detectors.push(async (t, report) => {
    const rows = objects(await proxySplit(layer, { tenant_id: tenant, dns_run_id: dns.run_id }, surveyOpts(t)));
    t?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `proxy_split ${dns.run_id}`, output_summary: `cloudflare.dns: ${rows.length} proxied CNAME(s) alias a direct address record`, detail: "model: none" });
    for (const row of rows) {
      const summary = `${row.proxied_name} is proxied and aliases ${row.target_name}, whose ${row.target_type} record is direct to ${row.target_content}: the origin the proxy hides is published on the name it points at`;
      t?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `proxied record ${row.proxied_record_id}`, output_summary: `proxy_split: ${summary}`, detail: "model: none" });
      report({
        class: "proxy_split", tenant_id: tenant, run_id: dns.run_id, surface: "cloudflare.dns", host: null,
        object_id: row.proxied_record_id, setting_path: "proxied", value_hash: sha256("1"), value_redacted: "1",
        refers_to_type: "dns_name", refers_to_id: row.target_name, dns_name: row.proxied_name, resolves_to: row.target_content,
        resource_id: row.proxied_record_id, dns_run_id: dns.run_id, since: (await auditReach(tenant, t)) ?? dns.started_at, until: row.observed_at, summary,
      });
    }
  });

  for (const group of groups.values()) {
    const latest = group[group.length - 1];
    if (latest.surface !== "linux.nginx" || gatedOut.has(latest.run_id)) continue;
    const dns = dnsFor(latest);
    if (!dns) continue;
    detectors.push((t, report) => surveyHost(latest, dns, t, report));
  }
  /** The survey of one nginx host group's latest run against its DNS run: proxied_without_real_ip, orphan_record, orphan_vhost. */
  const surveyHost = async (latest: Row, dns: Row, t: HeldTracer | undefined, report: Report): Promise<void> => {
    const params = { tenant_id: latest.tenant_id, run_id: latest.run_id, dns_run_id: dns.run_id };
    const since = (await auditReach(latest.tenant_id, t)) ?? dns.started_at;
    const where = `${latest.surface} ${latest.host}`;

    const blocks = objects(await proxiedWithoutRealIp(layer, params, surveyOpts(t)));
    const wild = objects(await wildcardWithoutRealIp(layer, params, surveyOpts(t)));
    t?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `proxied_without_real_ip ${latest.run_id} x ${dns.run_id}`, output_summary: `${where}: ${blocks.length} proxied name(s) served by a block that trusts no real_ip range, ${wild.length} proxied wildcard(s) landing where nothing does`, detail: "model: none" });
    for (const row of [...blocks, ...wild]) {
      const wildcard = row.setting_path === "http.real_ip";
      const summary = wildcard
        ? `${row.name} is proxied through Cloudflare to ${row.origin}, and no server block on ${row.host} trusts a Cloudflare range (${row.setting_path} in ${row.object_id} is absent): every name under the wildcard sees Cloudflare's addresses as its visitors`
        : `${row.name} is proxied through Cloudflare to ${row.origin}, and ${row.setting_path} in ${row.object_id} on ${row.host} is absent: the block that serves it sees Cloudflare's addresses as its visitors`;
      t?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `${row.setting_path} in ${row.object_id} on ${row.host}`, output_summary: `proxied_without_real_ip: ${summary}`, detail: "model: none" });
      report({
        class: "proxied_without_real_ip", tenant_id: latest.tenant_id, run_id: latest.run_id, surface: latest.surface, host: row.host,
        object_id: row.object_id, setting_path: row.setting_path, value_hash: row.value_hash, value_redacted: row.value_redacted,
        refers_to_type: "dns_name", refers_to_id: row.name, dns_name: row.name, resolves_to: row.origin, resource_id: row.record_id, dns_run_id: dns.run_id,
        since, until: later(row.observed_at, row.dns_observed_at), summary,
      });
    }

    const records = objects(await orphanRecords(layer, params, surveyOpts(t)));
    t?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `orphan_record ${latest.run_id} x ${dns.run_id}`, output_summary: `${where}: ${records.length} record(s) land here with no enabled server block naming them`, detail: "model: none" });
    for (const row of records) {
      const summary = `${row.name} (${row.type}, ${row.proxied === "1" ? "proxied" : "direct"}) lands on ${row.origin}, ${row.host}, where no enabled server block names it: requests for it reach the default server`;
      t?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `record ${row.record_id}`, output_summary: `orphan_record: ${summary}`, detail: "model: none" });
      report({
        class: "orphan_record", tenant_id: latest.tenant_id, run_id: dns.run_id, surface: "cloudflare.dns", host: row.host,
        object_id: row.record_id, setting_path: "name", value_hash: sha256(`${row.type} ${row.name} ${row.content}`), value_redacted: row.name,
        refers_to_type: "dns_name", refers_to_id: row.name, dns_name: row.name, resolves_to: row.origin, resource_id: row.record_id, dns_run_id: dns.run_id,
        since, until: later(row.observed_at, latest.started_at), summary,
      });
    }

    const vhosts = objects(await orphanVhosts(layer, params, surveyOpts(t)));
    t?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `orphan_vhost ${latest.run_id} x ${dns.run_id}`, output_summary: `${where}: ${vhosts.length} server_name(s) with no record and no covering wildcard`, detail: "model: none" });
    for (const row of vhosts) {
      const summary = `${row.server_name} is a server_name in ${row.object_id} on ${row.host} (${row.enabled === "1" ? "enabled" : "on disk, not enabled"}) with no record of that name in the collected zones and no wildcard covering its zone`;
      t?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `${row.setting_path} in ${row.object_id} on ${row.host}`, output_summary: `orphan_vhost: ${summary}`, detail: "model: none" });
      report({
        class: "orphan_vhost", tenant_id: latest.tenant_id, run_id: latest.run_id, surface: latest.surface, host: row.host,
        object_id: row.object_id, setting_path: row.setting_path, value_hash: row.value_hash, value_redacted: row.server_name,
        refers_to_type: "dns_name", refers_to_id: row.server_name, dns_name: row.server_name, resolves_to: null, resource_id: null, dns_run_id: dns.run_id,
        since, until: later(row.observed_at, dns.started_at), summary,
      });
    }
  };

  // Drift from the latest approval and change since the newest backup, over the latest run of each (tenant,
  // surface, host) that passed the gate, then drift over each tenant's latest passing DNS run (one observation per record field).
  // A DNS run's observations, read once: the detectors ask as agent detector and the locked count, a step later, as decider.
  // The read's lines name the agent of the first ask in task order, and each later ask is one line naming its own agent
  // (src/concurrency.ts SharedReads), whichever task happened to start the read.
  const dnsObservations = (runId: string, agent: string, t: HeldTracer | undefined): Promise<Row[]> =>
    shared.read(`observations ${runId}`, t, agent, async (lines) => objects(await observationsOf(layer, runId, { tracer: lines, agent })));
  const driftFinding = (row: Row, run: Row, dnsRunId: string | null, recordName: string | null): FindingSummary => {
    const isRecord = row.surface === "cloudflare.dns";
    const what = isRecord ? `${row.setting_path} of record ${row.object_id}${recordName ? ` (${recordName})` : ""}` : `${row.setting_path} in ${row.object_id}${row.host ? ` on ${row.host}` : ""}`;
    const shown = row.setting_path !== "file" && row.value_redacted && row.value_redacted.length <= 80 ? `${row.value_redacted} (${h12(row.value_hash)})` : h12(row.value_hash);
    const summary = `${what} is ${shown}, and its latest approval, ${row.approved_at}${row.approved_by ? ` by ${row.approved_by}` : ""}, is ${h12(row.approved_hash)}: the live value drifted from the approved one`;
    return {
      class: "drift_vs_approved", tenant_id: run.tenant_id, run_id: run.run_id, surface: row.surface, host: nul(row.host),
      object_id: row.object_id, setting_path: row.setting_path, value_hash: row.value_hash,
      // a file's value is its body: the hash names it, so the finding carries no copy of the text
      value_redacted: row.setting_path === "file" ? null : nul(row.value_redacted),
      refers_to_type: nul(row.refers_to_type), refers_to_id: nul(row.refers_to_id),
      dns_name: isRecord ? recordName : null,
      resolves_to: isRecord && row.setting_path === "content" && row.refers_to_type === "ip" ? row.refers_to_id : null,
      resource_id: isRecord ? row.object_id : null, dns_run_id: isRecord ? run.run_id : dnsRunId,
      since: earlier(row.approved_at, row.observed_at), until: row.observed_at, summary,
    };
  };
  const approvalOf = (row: Row): ApprovedValue => ({ value_hash: row.approved_hash, approved_at: row.approved_at, approved_by: nul(row.approved_by) });
  /** An approved_missing finding: one row of APPROVED_MISSING_SQL against `run`, the latest passing run of its surface and host. */
  const missingFinding = (row: Row, run: Row, dnsRunId: string | null, recordName: string | null): FindingSummary => {
    const isRecord = row.surface === "cloudflare.dns";
    const summary = `${row.setting_path} in ${row.object_id}${row.host ? ` on ${row.host}` : ""} is approved as ${h12(row.approved_hash)} and absent from run ${run.run_id}`;
    return {
      class: "approved_missing", tenant_id: run.tenant_id, run_id: run.run_id, surface: row.surface, host: nul(row.host),
      object_id: row.object_id, setting_path: row.setting_path, value_hash: "", approved_hash: row.approved_hash, value_redacted: null,
      refers_to_type: null, refers_to_id: null, dns_name: isRecord ? recordName : null, resolves_to: null,
      resource_id: isRecord ? row.object_id : null, dns_run_id: isRecord ? run.run_id : dnsRunId,
      since: earlier(row.approved_at, run.started_at), until: run.finished_at || run.started_at, summary,
    };
  };
  /** The approved settings whose object `run` lacks (APPROVED_MISSING_SQL), traced, each reported to be checked and decided. */
  const detectMissing = async (run: Row, surface: string, host: string, where: string, dnsRunId: string | null, t: HeldTracer | undefined, report: Report): Promise<void> => {
    const rows = objects(await approvedMissing(layer, { tenant_id: run.tenant_id, surface, host, run_id: run.run_id }, surveyOpts(t)));
    t?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `approved_missing ${run.run_id}`, output_summary: `${where}: ${rows.length} approved setting(s) whose object the run lacks`, detail: "model: none" });
    for (const row of rows) {
      const name = surface === "cloudflare.dns" ? await lastRecordName(run, row.object_id, t) : null;
      const finding = missingFinding(row, run, dnsRunId, name);
      t?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `${row.setting_path} in ${row.object_id}${row.host ? ` on ${row.host}` : ""}`, output_summary: `approved_missing: ${finding.summary}`, detail: "model: none" });
      report(finding, undefined, approvalOf(row));
    }
  };
  /** A record's redacted name in the latest passing DNS run of the tenant before `run` that held it; null when none did. */
  const lastRecordName = async (run: Row, recordId: string, t: HeldTracer | undefined): Promise<string | null> => {
    const before = passing.filter((r) => r.tenant_id === run.tenant_id && r.surface === "cloudflare.dns" && r.run_id !== run.run_id && r.started_at <= run.started_at);
    for (const r of before.reverse()) {
      const name = (await dnsObservations(r.run_id, "detector", t)).find((o) => o.object_id === recordId && o.setting_path === "name");
      if (name) return name.value_redacted || null;
    }
    return null;
  };

  for (const group of groups.values()) {
    const latest = group[group.length - 1];
    if (gatedOut.has(latest.run_id)) continue;
    detectors.push((t, report) => detectDrift(latest, t, report));
  }
  /** Drift from the latest approval, approved settings missing, and on nginx change since the newest backup, over one host group's latest run. */
  const detectDrift = async (latest: Row, t: HeldTracer | undefined, report: Report): Promise<void> => {
    const dns = dnsFor(latest);
    const where = `${latest.surface} ${latest.host}`;
    const drift = objects(await driftVsApproved(layer, { tenant_id: latest.tenant_id, run_id: latest.run_id }, surveyOpts(t)));
    t?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `drift_vs_approved ${latest.run_id}`, output_summary: `${where}: ${drift.length} setting(s) drifted from their latest approval`, detail: "model: none" });
    for (const row of drift) {
      const finding = driftFinding(row, latest, dns?.run_id ?? null, null);
      t?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `${row.setting_path} in ${row.object_id} on ${row.host}`, output_summary: `drift_vs_approved: ${finding.summary}`, detail: "model: none" });
      report(finding, undefined, approvalOf(row));
    }
    await detectMissing(latest, latest.surface, latest.host, where, dns?.run_id ?? null, t, report);
    if (latest.surface !== "linux.nginx") return;
    const backup = objects(await changedSinceBackup(layer, { tenant_id: latest.tenant_id, run_id: latest.run_id, host: latest.host }, surveyOpts(t)));
    t?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `changed_since_backup ${latest.run_id}`, output_summary: `${where}: ${backup.length} file(s) the host's newest backup lacks or holds with other bytes`, detail: "model: none" });
    for (const row of backup) {
      const summary = row.backup_hash === ""
        ? `${row.object_id} on ${row.host} is absent from the host's newest backup (${row.snapshot_id}, taken ${row.taken_at}): a restore from that backup holds no copy of this file`
        : `${row.object_id} on ${row.host} is ${h12(row.value_hash)} and its copy in the host's newest backup (${row.snapshot_id}, taken ${row.taken_at}) is ${h12(row.backup_hash)}: the live file and the backup copy differ`;
      t?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `${row.setting_path} in ${row.object_id} on ${row.host}`, output_summary: `changed_since_backup: ${summary}`, detail: "model: none" });
      report({
        class: "changed_since_backup", tenant_id: latest.tenant_id, run_id: latest.run_id, surface: latest.surface, host: row.host,
        object_id: row.object_id, setting_path: row.setting_path, value_hash: row.value_hash, value_redacted: null,
        refers_to_type: null, refers_to_id: null, dns_name: null, resolves_to: null, resource_id: null, dns_run_id: dns?.run_id ?? null,
        since: earlier(row.taken_at, row.observed_at), until: row.observed_at, summary,
      });
    }
  };

  for (const [tenant, dns] of latestDns) detectors.push(async (t, report) => {
    const drift = objects(await driftVsApproved(layer, { tenant_id: tenant, run_id: dns.run_id }, surveyOpts(t)));
    t?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `drift_vs_approved ${dns.run_id}`, output_summary: `cloudflare.dns: ${drift.length} record field(s) drifted from their latest approval`, detail: "model: none" });
    if (drift.length) {
      const names = new Map((await dnsObservations(dns.run_id, "detector", t)).filter((o) => o.setting_path === "name").map((o) => [o.object_id, o.value_redacted]));
      for (const row of drift) {
        const finding = driftFinding(row, dns, dns.run_id, names.get(row.object_id) || null);
        t?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `${row.setting_path} of record ${row.object_id}`, output_summary: `drift_vs_approved: ${finding.summary}`, detail: "model: none" });
        report(finding, undefined, approvalOf(row));
      }
    }
    await detectMissing(dns, "cloudflare.dns", "", "cloudflare.dns", dns.run_id, t, report);
  });

  // The mail records Microsoft 365 requires, the latest m365.dns run of each tenant, against what the DNS run of its pass serves (src/m365.ts).
  detectors.push(async (t, report) => {
    for (const f of await mailRecords(layer, runs, (r) => ({ gated: gatedOut.has(r.run_id), dns: dnsFor(r) }), surveyOpts(t))) report(f);
  });

  // The detectors' step. On a detector's failure the findings reported before it are still checked and decided, as a pass
  // one task at a time had done by then, and the detector's error is thrown after them.
  const reported: Reported[][] = detectors.map(() => []);
  let failedAt = detectors.length;
  const detected = await inTurn(detectors.map((detect, d): Task => async (t) => {
    try {
      await detect(t, (finding, view, approved) => reported[d].push({ finding, view, approved: approved ?? null, lines: t?.hold() }));
    } catch (err) {
      failedAt = Math.min(failedAt, d);
      throw err;
    }
    return () => {};
  })).then(() => null, (error: unknown) => ({ error }));

  // check, decide, judge: every finding a task, its lines where its detector reported it, its commit in the order reported.
  const queue = reported.slice(0, failedAt + 1).flat();
  await inTurn(queue.map((q): Task => (t) => assess(q.finding, q.view, q.approved, t)), (i) => queue[i].lines);
  if (detected) throw detected.error;

  // The settings of the pass's latest passing runs that a locked rule governs and that have no approved value on
  // record: what a locked rule has nothing to roll back to. Counted, one line per pass, no finding.
  let locked = 0;
  const keyOf = (o: Row): string => [o.surface, o.host, o.object_id, o.setting_path].join("\u001f");
  await inTurn([...rulesByTenant].filter(([, rules]) => rules.some((r) => r.lock === 1)).map(([tenant, rules]): Task => async (t) => {
    const approvals = new Set(objects(await latestApprovals(layer, tenant, { tracer: t, agent: "decider" })).map(keyOf));
    const settings: Row[] = [];
    for (const group of groups.values()) {
      const latest = group[group.length - 1];
      if (latest.tenant_id === tenant && !gatedOut.has(latest.run_id)) settings.push(...(obsByRun.get(latest.run_id) ?? []));
    }
    const dns = latestDns.get(tenant);
    if (dns) settings.push(...await dnsObservations(dns.run_id, "decider", t));
    let unapproved = 0;
    for (const o of settings) {
      const rule = resolvePolicy(rules, { tenant_id: o.tenant_id, surface: o.surface, object_id: o.object_id, setting_path: o.setting_path });
      if (rule?.lock === 1 && !approvals.has(keyOf(o))) unapproved += 1;
    }
    return () => {
      locked += unapproved;
    };
  }));

  // One disposition per finding of the pass.
  const written = opts.ledger ? await opts.ledger.record(dispositions) : null;
  const verbs = Object.fromEntries(VERBS.map((v) => [v, findings.filter((f) => f.verb === v).length])) as Record<Verb, number>;
  const decidedBy = (d: DecidedBy): number => findings.filter((f) => f.disposition.decided_by === d).length;
  const probeRuns = passing.filter((r) => r.surface === "probe").map((r) => r.run_id);

  // One summary line per pass; stopCounters reads the same numbers back from the stop and judge lines.
  tracer?.emit({ agent: "decider", action: "triage", status: "ok", input_summary: "stop rule", output_summary: countersSummary(verifier), detail: "model: none" });
  // One summary line per pass when a memory was consulted: what it held and what the Decider did with it.
  if (recalled) {
    tracer?.emit({
      agent: "decider", action: "triage", status: "ok", input_summary: "memory",
      output_summary: `lessons ${recalled.lessons}, exceptions applied ${recalled.applied}, lapsed ${recalled.lapsed}`,
      detail: `${memory!.directory ? "local store" : "in-memory store"}; recall by exact scope key, never by similarity; model: none`,
    });
  }
  // One line per pass: what the locked rules have no approved value for, the verbs, who decided, the probes and the ledger.
  tracer?.emit({
    agent: "decider", action: "triage", status: "ok", input_summary: "policy",
    output_summary: `locked settings without an approved value: ${locked}`,
    detail: `${rulesRead} policy rule(s) read; verbs ${VERBS.filter((v) => verbs[v] > 0).map((v) => `${v} ${verbs[v]}`).join(", ") || "none"}; `
      + `decided by policy ${decidedBy("policy")}, operator ${decidedBy("operator")}, default ${decidedBy("default")}; `
      + `${probeRuns.length ? `probe run(s) ${probeRuns.join(", ")}` : NO_PROBE_RUN}; `
      + `${written === null ? "no ledger" : `ledger: ${written} disposition(s) and ${fingerprints} referent fingerprint(s) written`}; ${judged ? judgeClause(judged) : "model: none"}`,
  });
  return {
    runs: runs.length, gatedOut: [...gatedOut], observed, findings, verifier, memory: recalled,
    verbs, locked, rules: rulesRead, ledger: written === null ? null : { dispositions: written, fingerprints }, ...(judged ? { judge: judged } : {}),
  };
}
