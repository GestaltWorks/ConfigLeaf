// The eval runner (eval/PROTOCOL.md is its contract; scripts/eval.ts is its command line). Over the recording
// the items came from, through one DataLayer, it runs each configuration the protocol's table defines, the
// requested number of times, on every item of the chosen set, and records per item and per call what the
// protocol counts.
//
// Contract.
//   Findings. One pass of src/pipeline.ts over the recording (no model, decided at the recording's instant)
//     raises the findings; a pass item stands for the findings src/eval/items.ts matchItem gives it, a history
//     item for the one finding src/eval/history.ts reads from the audit log. Every configuration sees the same
//     findings and the same evidence rows (src/eval/queries.ts EVIDENCE_SQL).
//   Policy (src/eval/policy.ts): before the first pass the rules of the policy file (DRIFT_POLICY_FILE, default
//     policy/hackathon.json) for the recording's tenant go into the recording, so every pass decides as SAMPLE_MODE
//     does, and every finding of C0 to C3 ends in the Decider's precedence: the technician's exception (the eval's
//     technician memory is empty), then the rule that governs the setting, then the default, which is the
//     configuration's own verb below. C4 is Ultra alone, the protocol's baseline: its verb is the model's.
//   C0-shaped (the class's default checks): each run is a fresh pass; a pass item's verdict is its finding's
//     verb as the pass decided it; a history finding's comes from the same checks through src/eval/assess.ts,
//     then the Decider with the rule that governs its record.
//   Model selection: the selecting tier's reply (src/eval/models.ts selectChecks) through validateSelection;
//     a gate refusal, a failed call or a selection with no valid check files the finding not judged; else the
//     checks run (assess.ts) and give ADOPT or ESCALATE as the pass's default does; that verb stands where the
//     default decides, and the exception's or the rule's decision where the pass took one.
//   Judge: when the checks leave the verb movable (stoprule.ts shouldWithdraw), judgeClaim at the judging tier
//     over the finding's summary and evidence rows. Refuted: the claim is struck and the configuration's own
//     verb is ADOPT, the live value standing. Stands: the checks' verb. not_judged or invalid_output: the finding
//     is filed not judged with the judge's reason. A withheld call keeps the checks' verb and is counted as an
//     early stop. The rule's decision, where one governs, stands over the configuration's own verb either way.
//   Direct (C4): one call per item with its facts and its findings' evidence rows; the verb it answers is
//     every finding's verb, a refusal files them all not judged.
//   Redaction: every string handed to a model and every string a result keeps passes the eval's redactor
//     (src/eval/models.ts evalRedactor, or EvalOptions.redactor); scripts/eval.ts's deny-list probe stays the
//     last line before a file is written.
//   An item's verdict is its findings' most severe verb (FIX, ESCALATE, ROLLBACK, HOLD, ADOPT), read yes or no
//     by the protocol's verb reading; any finding not judged files the item not judged. Planted claims go to
//     the judge of every judging configuration, once per run. A call whose verified receipt names another tier
//     than the one requested invalidates its run. Nothing is retried into a better number: the only repeat is
//     the gate's custody retry, which discards an answer filed under another request.
//
// Measured 25 Oct 2026 over test/fixtures/recorded-bundle.json under policy/hackathon.json version 2 (15 rules), C0
// in two runs (test/eval.test.ts): 38 items, 31 scored (the 7 drift_vs_approved items not raised), 31 with a verdict,
// all 40 of their findings HOLD by policy, agreement 29 of the 29 labelled yes or no (Wilson 95% 0.883 to 1.000), 0
// of 29 labelled no read yes, 0 differences between the two passes. The same C0 without the policy (24 Oct 2026):
// agreement 7 of 29, 22 of 29 labelled no read yes.

import { Nightshift } from "../adapters/nightshift.ts";
import type { Evidence, JudgeModel } from "../agents/judge.ts";
import { defaultChecks, type FindingSummary } from "../catalogue/select.ts";
import { config } from "../config.ts";
import { SqlJsEngine, type Bundle } from "../data/engines/sqljs.ts";
import { decisionInstant } from "../data/instant.ts";
import { DataLayer } from "../data/layer.ts";
import { listRuns, objects, runComplete } from "../data/queries.ts";
import { DriftWorld } from "../engine/world.ts";
import { ReceiptStore, type ReceiptFinder } from "../gate.ts";
import { runPass, shortFindingId, type DispositionNote, type Finding, type Verb } from "../pipeline.ts";
import type { Redactor } from "../redactor.ts";
import type { Tracer } from "../trace.ts";
import { assessChecks } from "./assess.ts";
import { historyFinding } from "./history.ts";
import { itemKind, matchItem, type EvalSet, type Item, type LabelValue } from "./items.ts";
import { countRun, passDifferences, runDifferences } from "./measures.ts";
import { directVerdict, evalRedactor, isSubstitution, judge, Recorder, scrubber, selectChecks, type CallRecord, type ModelCallContext } from "./models.ts";
import type { PlantedClaim } from "./planted.ts";
import { plantedEvidence } from "./planted.ts";
import { decideHistory, historyPolicy, loadEvalPolicy, underPolicy, type Decided, type HistoryPolicy } from "./policy.ts";
import { readProtocol, type ConfigSpec, type Protocol } from "./protocol.ts";
import { EVIDENCE_SQL, evidenceParams } from "./queries.ts";
import { labelsSeed, splitItems, type Split } from "./split.ts";
import type { ItemOutcome, PlantedOutcome, RunResult, SetName, SubjectOutcome } from "./types.ts";

export type SetChoice = SetName | "all";

export interface ModelPorts {
  nightshift: JudgeModel;
  /** A fresh receipt finder per configuration run (ReceiptStore fetches the runtime list once per run). */
  receipts: () => ReceiptFinder;
}

export interface EvalOptions {
  protocolText: string;
  evalSet: EvalSet;
  /** The recording the items came from. */
  bundle: Bundle;
  configs?: readonly string[];
  runs?: number;
  set?: SetChoice;
  items?: readonly string[];
  /** The planted claims to hand every judge; none when absent. */
  planted?: readonly PlantedClaim[];
  models?: ModelPorts;
  tenant?: string;
  tracer?: Tracer;
  /** Called after each configuration run, for a progress line. */
  onRun?: (r: RunResult) => void;
  /** The policy file loaded into the recording before its passes; default DRIFT_POLICY_FILE. */
  policyFile?: string;
  /** What every string handed to a model and every string kept in a result passes; default evalRedactor(). */
  redactor?: Redactor;
}

export interface BaselineFinding { id: string; class: string; verb: Verb; summary: string }

export interface EvalResult {
  protocol: Protocol;
  split: Split;
  set: SetChoice;
  itemIds: string[];
  configs: ConfigSpec[];
  runs: RunResult[];
  planted: PlantedOutcome[];
  tenant: string;
  decided_at: string;
  /** The policy loaded into the recording: the file, its version, the rows it gave and inserted, the rules the pass read for the tenant. */
  policy: { file: string; version: number; rows: number; inserted: number; rules: number };
  /** Every finding the pass raises over the recording, and those no item of items.json matches. */
  baseline: { findings: BaselineFinding[]; unmatched: BaselineFinding[] };
  /** Per configuration: what two passes or two runs were compared, and their differences; null with one run of a model configuration. */
  determinism: Record<string, { compared: string; differences: string[] } | null>;
  started_at: string;
  finished_at: string;
}

interface Subject { id: string; finding: FindingSummary; evidence: Evidence }

interface Prepared {
  item: Item;
  label: LabelValue;
  set: SetName;
  kind: ItemOutcome["kind"];
  matched: ItemOutcome["matched"];
  not_raised: string | null;
  subjects: Subject[];
}

const SEVERITY: readonly Verb[] = ["FIX", "ESCALATE", "ROLLBACK", "HOLD", "ADOPT"];
const mostSevere = (verbs: readonly Verb[]): Verb => SEVERITY.find((v) => verbs.includes(v)) ?? "ADOPT";

type Clean = (s: string | null | undefined) => string;

async function evidenceOf(layer: DataLayer, f: FindingSummary): Promise<Evidence> {
  const r = await layer.run(EVIDENCE_SQL, evidenceParams(f), { agent: "eval", limit: 200 });
  return { columns: r.columns, rows: r.rows };
}

/** Every finding's rows, the first occurrence of each (source, row_id) kept. */
function mergeEvidence(all: readonly Evidence[]): Evidence {
  const columns = all[0]?.columns ?? [];
  const seen = new Set<string>();
  const rows: string[][] = [];
  for (const e of all) for (const r of e.rows) {
    const k = `${r[0]}\u001f${r[1]}`;
    if (!seen.has(k)) { seen.add(k); rows.push(r); }
  }
  return { columns, rows };
}

/** The tenant's latest DNS run that passes the gate, and why its audit log is withheld (the pass's rule), if it is. */
async function recordingContext(layer: DataLayer, tenant: string): Promise<{ dnsRun: string | null; auditWithheld: string | undefined }> {
  const runs = objects(await listRuns(layer, { agent: "eval" })).filter((r) => r.tenant_id === tenant);
  const passes = async (runId: string): Promise<boolean> => (await runComplete(layer, runId, { agent: "eval" })).total === 0;
  let dnsRun: string | null = null;
  for (const r of runs.filter((x) => x.surface === "cloudflare.dns")) if (await passes(r.run_id)) dnsRun = r.run_id;
  const audit = runs.filter((r) => r.surface === "cloudflare.audit").at(-1);
  const auditWithheld = !audit ? "no cloudflare.audit run for this tenant" : (await passes(audit.run_id)) ? undefined : `latest audit run ${audit.run_id} failed the DQ gate`;
  return { dnsRun, auditWithheld };
}

/** The set's item ids in items.json order, limited to `only` when given. */
function chooseItems(evalSet: EvalSet, split: Split, set: SetChoice, only: readonly string[] | undefined): string[] {
  const inSet = new Set(set === "dev" ? split.dev : set === "heldout" ? split.heldout : split.order);
  const ids = evalSet.items.map((i) => i.id).filter((id) => inSet.has(id));
  if (!only) return ids;
  for (const id of only) if (!ids.includes(id)) throw new Error(`item ${id} is outside the ${set} set (or unlabelled)`);
  return ids.filter((id) => only.includes(id));
}

export async function runEval(opts: EvalOptions): Promise<EvalResult> {
  const started_at = new Date().toISOString();
  const protocol = readProtocol(opts.protocolText);
  const configs = opts.configs
    ? opts.configs.map((id) => protocol.configs.find((c) => c.id === id) ?? (() => { throw new Error(`configuration ${id} is absent from the protocol's table (${protocol.configs.map((c) => c.id).join(", ")})`); })())
    : protocol.configs;
  const ordered = protocol.configs.filter((c) => configs.includes(c));
  const runs = opts.runs ?? protocol.runs;
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`runs must be a positive integer, got ${runs}`);
  const { evalSet, tracer } = opts;
  const split = splitItems(evalSet.labels.map((l) => l.id), labelsSeed(evalSet.labelsText));
  const set = opts.set ?? "all";
  const itemIds = chooseItems(evalSet, split, set, opts.items);

  const redactor = opts.redactor ?? evalRedactor();
  const clean = scrubber(redactor);
  const engine = await SqlJsEngine.create();
  engine.loadBundle(opts.bundle);
  const layer = new DataLayer(engine);
  const decided_at = decisionInstant(opts.bundle) ?? started_at;
  const tenants = [...new Set(((opts.bundle as { collection_run?: { tenant_id: string }[] }).collection_run ?? []).map((r) => r.tenant_id))];
  const tenant = opts.tenant ?? (tenants.length === 1 ? tenants[0] : "");
  if (!tenant) throw new Error(`the recording holds ${tenants.length} tenants; name one with --tenant`);
  // The shipped policy into the recording before any pass, so every pass decides as SAMPLE_MODE does.
  const policy = await loadEvalPolicy(engine, layer, opts.policyFile ?? config.policyFile, tenant);

  // The findings, once, model-free; every configuration sees these.
  const base = await runPass(layer, { tracer, world: new DriftWorld("eval_baseline"), decidedAt: decided_at });
  const raised = base.findings.map((f) => ({ id: f.id, finding: f.finding }));
  const decidedByPass = new Map(base.findings.map((f) => [f.id, f.disposition]));
  const hp = await historyPolicy(layer, policy, decided_at);
  const ctx = await recordingContext(layer, tenant);
  const world = new DriftWorld("eval_history");
  const labelOf = new Map(evalSet.labels.map((l) => [l.id, l.needs_human]));
  const setOf = (id: string): SetName => (split.dev.includes(id) ? "dev" : "heldout");

  const prepared: Prepared[] = [];
  const matchedAnywhere = new Set<string>();
  for (const item of evalSet.items) {
    const kind = itemKind(item);
    const inRun = itemIds.includes(item.id);
    if (kind === "pass") {
      const m = matchItem(item, raised);
      if (m.kind === "findings") for (const f of m.findings) matchedAnywhere.add(f.id);
      if (!inRun) continue;
      const subjects = m.kind === "findings" ? await Promise.all(m.findings.map(async (f) => ({ id: f.id, finding: f.finding, evidence: await evidenceOf(layer, f.finding) }))) : [];
      prepared.push({ item, label: labelOf.get(item.id)!, set: setOf(item.id), kind, matched: m.kind === "findings" ? { via: m.via, findings: m.findings.map((f) => f.id) } : null, not_raised: m.kind === "not_raised" ? m.reason : null, subjects });
      continue;
    }
    if (!inRun) continue;
    if (kind === "history") {
      const h = ctx.dnsRun === null
        ? { kind: "not_raised" as const, reason: "no DNS run of the recording passes the gate" }
        : await historyFinding(layer, { tenant_id: tenant, dns_run_id: ctx.dnsRun }, item, { agent: "eval" });
      if (h.kind === "finding") {
        const id = shortFindingId(world.findingId(h.finding));
        prepared.push({ item, label: labelOf.get(item.id)!, set: setOf(item.id), kind, matched: { via: "history", findings: [id] }, not_raised: null, subjects: [{ id, finding: h.finding, evidence: await evidenceOf(layer, h.finding) }] });
      } else {
        prepared.push({ item, label: labelOf.get(item.id)!, set: setOf(item.id), kind, matched: null, not_raised: h.reason, subjects: [] });
      }
      continue;
    }
    prepared.push({ item, label: labelOf.get(item.id)!, set: setOf(item.id), kind, matched: null, not_raised: `class ${item.class} has no assessment path in the runner`, subjects: [] });
  }

  const models = opts.models ?? (() => { const ns = new Nightshift(); return { nightshift: ns, receipts: () => new ReceiptStore(ns) }; })();
  const results: RunResult[] = [];
  const planted: PlantedOutcome[] = [];
  const extraPass: Record<string, RunResult["pass"]> = {};

  for (const spec of ordered) {
    for (let run = 1; run <= runs; run++) {
      const r = await runConfiguration(spec, run, { layer, prepared, protocol, tenant, decided_at, auditWithheld: ctx.auditWithheld, tracer, models, planted: opts.planted ?? [], plantedOut: planted, redactor, clean, hp, decidedByPass });
      results.push(r);
      opts.onRun?.(r);
    }
    if (spec.select.kind === "default" && runs < 2) {
      const again = await runPass(layer, { tracer, world: new DriftWorld(`eval_${spec.id}_determinism`), decidedAt: decided_at });
      extraPass[spec.id] = again.findings.map((f) => ({ id: f.id, class: f.finding.class, verb: f.verb, reason: clean(f.disposition.reason) }));
    }
  }

  const determinism: EvalResult["determinism"] = {};
  for (const spec of ordered) {
    const mine = results.filter((r) => r.config.id === spec.id);
    if (spec.select.kind === "default") {
      const second = mine[1]?.pass ?? extraPass[spec.id] ?? [];
      determinism[spec.id] = { compared: mine[1] ? "the passes of runs 1 and 2" : "the pass of run 1 and one more pass", differences: passDifferences(mine[0].pass ?? [], second) };
    } else {
      determinism[spec.id] = mine.length >= 2 ? { compared: "runs 1 and 2, item by item", differences: runDifferences(mine[0], mine[1]) } : null;
    }
  }

  const baseFinding = (f: Finding): BaselineFinding => ({ id: f.id, class: f.finding.class, verb: f.verb, summary: clean(f.finding.summary) });
  return {
    protocol, split, set, itemIds, configs: ordered, runs: results, planted, tenant, decided_at,
    policy: { file: policy.file, version: policy.version, rows: policy.rows, inserted: policy.inserted, rules: policy.rules.length },
    baseline: { findings: base.findings.map(baseFinding), unmatched: base.findings.filter((f) => !matchedAnywhere.has(f.id)).map(baseFinding) },
    determinism, started_at, finished_at: new Date().toISOString(),
  };
}

interface RunContext {
  layer: DataLayer;
  prepared: readonly Prepared[];
  protocol: Protocol;
  tenant: string;
  decided_at: string;
  auditWithheld: string | undefined;
  tracer?: Tracer;
  models: ModelPorts;
  planted: readonly PlantedClaim[];
  plantedOut: PlantedOutcome[];
  redactor: Redactor;
  clean: Clean;
  /** The Decider's reads for history findings, once per recording. */
  hp: HistoryPolicy;
  /** The baseline pass's decision per finding id, under the policy. */
  decidedByPass: Map<string, DispositionNote>;
}

const emptySubject = (s: Subject, clean: Clean): Omit<SubjectOutcome, "verb" | "reason" | "not_judged"> => ({
  finding_id: s.id, class: s.finding.class, summary: clean(s.finding.summary), decided_by: null, rule_id: null, checks: [], rejected: [], selection: null, ran_unmodified: 0, early_stops: 0, judge: null,
});

async function runConfiguration(spec: ConfigSpec, run: number, rc: RunContext): Promise<RunResult> {
  const started_at = new Date().toISOString();
  const { clean } = rc;
  const usesModel = spec.select.kind === "model" || spec.judge !== null || spec.direct !== null;
  const recorder = usesModel ? new Recorder(rc.models.nightshift, rc.models.receipts(), rc.redactor) : null;
  const mctx = (item: string): ModelCallContext => ({ recorder: recorder!, tenantId: rc.tenant, item, tracer: rc.tracer, redactor: rc.redactor });

  let pass: RunResult["pass"] = null;
  let byId = new Map<string, Finding>();
  if (spec.select.kind === "default") {
    const p = await runPass(rc.layer, { tracer: rc.tracer, world: new DriftWorld(`eval_${spec.id}_${run}`), decidedAt: rc.decided_at });
    pass = p.findings.map((f) => ({ id: f.id, class: f.finding.class, verb: f.verb, reason: clean(f.disposition.reason) }));
    byId = new Map(p.findings.map((f) => [f.id, f]));
  }

  /** The configuration's own verb through the Decider's precedence: the pass's exception or rule for a pass finding, the rule of its record for a history finding. */
  const decided = async (prep: Prepared, s: Subject, own: { verb: "ADOPT" | "ESCALATE"; reason: string }): Promise<Pick<SubjectOutcome, "verb" | "reason" | "decided_by" | "rule_id" | "not_judged">> => {
    const d: Decided = prep.kind === "pass" ? underPolicy(rc.decidedByPass.get(s.id), own) : await decideHistory(rc.layer, rc.hp, s.finding, { verb: own.verb, why: own.reason });
    return { verb: d.verb, reason: clean(d.reason), decided_by: d.decided_by, rule_id: d.rule_id, not_judged: null };
  };

  const subjectOutcome = async (prep: Prepared, s: Subject): Promise<SubjectOutcome> => {
    const shell = emptySubject(s, clean);
    if (spec.select.kind === "default") {
      if (prep.kind === "pass") {
        const f = byId.get(s.id);
        if (!f) return { ...shell, verb: null, reason: "", not_judged: `finding ${s.id} is absent from this run's pass` };
        return {
          ...shell, verb: f.verb, reason: clean(f.disposition.reason), decided_by: f.disposition.decided_by, rule_id: f.disposition.rule_id, not_judged: null,
          checks: f.checks.map((c) => ({ template: c.template, holds: c.holds, rows: c.rowCount })), rejected: f.rejected.map((r) => clean(r.reason)), early_stops: f.earlyStop ? 1 : 0,
        };
      }
      const a = await assessChecks(rc.layer, s.finding, defaultChecks(s.finding), { auditWithheld: rc.auditWithheld, tracer: rc.tracer });
      return {
        ...shell, ...(await decided(prep, s, { verb: a.verb, reason: a.why })),
        checks: a.checks.map((c) => ({ template: c.template, holds: c.holds, rows: c.rowCount })), rejected: a.rejected.map((r) => clean(r.reason)), early_stops: a.earlyStops,
      };
    }
    if (spec.select.kind !== "model") return { ...shell, verb: null, reason: "", not_judged: "the configuration chooses no checks" };
    const sel = await selectChecks(mctx(prep.item.id), s.finding, s.id, spec.select.tier);
    if (!sel.ok) return { ...shell, verb: null, reason: "", not_judged: `selection: ${clean(sel.reason)}` };
    const v = sel.value;
    const selection = { selected: v.valid.length + v.rejected.length, valid: v.valid.length, invalid: v.rejected.map((r) => clean(r.reason)), other: v.other ? clean(v.other) : null };
    if (!v.valid.length) return { ...shell, selection, verb: null, reason: "", not_judged: `invalid output: the selection holds no valid check (${selection.invalid.join("; ") || "no check chosen"})` };
    const a = await assessChecks(rc.layer, s.finding, v, { auditWithheld: rc.auditWithheld, tracer: rc.tracer });
    const checked = { ...shell, selection, checks: a.checks.map((c) => ({ template: c.template, holds: c.holds, rows: c.rowCount })), rejected: a.rejected.map((r) => clean(r.reason)), ran_unmodified: a.checks.length, early_stops: a.earlyStops };
    if (spec.judge === null) return { ...checked, ...(await decided(prep, s, { verb: a.verb, reason: a.why })) };
    if (a.withdraw.withdraw) return { ...checked, ...(await decided(prep, s, { verb: a.verb, reason: a.why })), judge: { withheld: clean(a.withdraw.reason) } };
    const { verdict } = await judge(mctx(prep.item.id), rc.layer, s.finding.summary, s.evidence, s.id, spec.judge);
    const judged = {
      status: verdict.status, reason: clean(verdict.reason), sql: verdict.sql ? clean(verdict.sql) : null, rows: verdict.rowCount, receipt_id: verdict.receiptId,
      served_model: verdict.servedModel ? clean(verdict.servedModel) : null, attempts: verdict.attempts ?? null, cache_status: verdict.custody?.cacheStatus ?? null,
      route: verdict.route ? clean(verdict.route) : null, route_attempts: verdict.routeAttempts ?? null,
    };
    if (verdict.status === "refuted") return { ...checked, judge: judged, ...(await decided(prep, s, { verb: "ADOPT", reason: `the judge struck the claim: ${judged.reason}` })) };
    if (verdict.status === "stands") return { ...checked, judge: judged, ...(await decided(prep, s, { verb: a.verb, reason: `${a.why}; the claim stands: ${judged.reason}` })) };
    return { ...checked, judge: judged, verb: null, reason: "", not_judged: `judge ${verdict.status}: ${judged.reason}` };
  };

  const items: ItemOutcome[] = [];
  for (const prep of rc.prepared) {
    const shell = {
      id: prep.item.id, class: prep.item.class, set: prep.set, label: prep.label, kind: prep.kind, matched: prep.matched, not_raised: prep.not_raised === null ? null : clean(prep.not_raised),
    };
    if (prep.not_raised !== null) {
      items.push({ ...shell, verdict: null, reading: null, agree: null, not_judged: null, subjects: [], direct: null, strikes: 0 });
      continue;
    }
    let subjects: SubjectOutcome[];
    let direct: ItemOutcome["direct"] = null;
    if (spec.direct !== null) {
      const r = await directVerdict(mctx(prep.item.id), prep.item.class, prep.item.facts, mergeEvidence(prep.subjects.map((s) => s.evidence)), spec.direct);
      direct = r.ok ? { verb: r.value.verb, reason: clean(r.value.reason) } : null;
      subjects = prep.subjects.map((s) => ({ ...emptySubject(s, clean), verb: direct?.verb ?? null, reason: direct?.reason ?? "", not_judged: r.ok ? null : `direct: ${clean(r.reason)}` }));
    } else {
      subjects = [];
      for (const s of prep.subjects) subjects.push(await subjectOutcome(prep, s));
    }
    const open = subjects.filter((s) => s.verb === null);
    const verdict = subjects.length && !open.length ? mostSevere(subjects.map((s) => s.verb!)) : null;
    const reasons = [...new Set(open.map((s) => s.not_judged ?? "not judged"))];
    const not_judged = verdict !== null ? null : subjects.length === 1 ? reasons[0] : `${open.length} of ${subjects.length} findings not judged: ${reasons.join(" | ")}`;
    const reading = verdict === null ? null : rc.protocol.reads.yes.includes(verdict) ? "yes" : rc.protocol.reads.no.includes(verdict) ? "no" : null;
    const agree = reading === null || prep.label === "unsure" ? null : reading === prep.label;
    const strikes = subjects.filter((s) => s.judge !== null && "status" in s.judge && s.judge.status === "refuted").length;
    items.push({ ...shell, verdict, reading, agree, not_judged, subjects, direct, strikes });
  }

  if (spec.judge !== null && recorder) {
    for (const c of rc.planted) {
      const evidence = await plantedEvidence(rc.layer, c);
      const { verdict, calls } = await judge(mctx(c.id), rc.layer, c.claim, evidence, null, spec.judge);
      rc.plantedOut.push({
        config: spec.id, run, judge_tier: spec.judge, id: c.id, kind: c.kind, status: verdict.status, struck: verdict.status === "refuted", reason: clean(verdict.reason),
        sql: verdict.sql ? clean(verdict.sql) : null, rows: verdict.rowCount, receipt_id: verdict.receiptId, served_model: verdict.servedModel ? clean(verdict.servedModel) : null,
        route: verdict.route ? clean(verdict.route) : null, cache_status: verdict.custody?.cacheStatus ?? null, calls,
      });
    }
  }

  const calls: CallRecord[] = recorder?.calls ?? [];
  const subs = calls.filter(isSubstitution);
  return {
    config: spec, run, started_at, finished_at: new Date().toISOString(),
    valid: subs.length === 0,
    invalid_reason: subs.length ? `substitution: ${subs.length} call(s) served ${[...new Set(subs.map((c) => `${c.served_model} (${c.served_tier}) for ${c.requested_tier}`))].join(", ")}` : null,
    items, calls, counts: countRun(items, calls, isSubstitution), pass,
  };
}
