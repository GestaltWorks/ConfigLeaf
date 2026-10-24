// Pre-flight: GO, NO-GO, GO-IF or ESCALATE before a change is made. A technician proposes one change;
// the agent binds it to one row of the latest passing run, renders the table it would touch as a
// derived table that applies the change (overlay.ts), runs the whole pass (src/pipeline.ts) over that
// simulated world through the same DataLayer, and compares the findings with the baseline pass over
// the world as recorded. Nothing is written anywhere; the simulated world is a query.
//
//   GO        the change adds no finding (and may remove some; a value already in force changes nothing)
//   GO-IF     the change adds findings that the prerequisite catalogue clears: each prerequisite is
//             applied as a further overlay and the pass runs again, until the simulation is clean;
//             the verdict names the ordered steps. At most MAX_ITERATIONS prerequisites.
//   NO-GO     the change adds a finding no catalogue prerequisite clears
//   ESCALATE  the simulation cannot run (the proposal does not parse or bind, counted as invalid; the
//             latest run failed the DQ gate), or the loop bound is reached with findings remaining
//
// Every step is traced with agent "preflight": parse_proposal, simulate (the pass's own lines, with the
// world they ran in), overlay_delta, prerequisite, judge, decide. In sample mode, or with no Nightshift
// token, the judge is skipped and traced as such. Live, the judge's falsifier is asked in the fixed world
// (the last simulation), where the claim is false: it must return rows there (`falsifier_fires`), or it
// was vacuous and the verdict records that instead of a judgement. The target: for a GO, the first finding
// the change removes (its claim is true in the recorded world); for a GO-IF, the finding the last
// prerequisite was bound from and cleared (its claim is true in the simulation it was bound in, not in
// the recorded world, where it does not exist). The trace says which target was chosen.

import { Nightshift } from "../adapters/nightshift.ts";
import { judgeClaim, type JudgeInput, type JudgeModel, type JudgeVerdict } from "../agents/judge.ts";
import type { FindingClass } from "../catalogue/templates.ts";
import { config } from "../config.ts";
import type { DataLayer, Overlays, Params } from "../data/layer.ts";
import { listRuns, objects } from "../data/queries.ts";
import { DriftWorld } from "../engine/world.ts";
import { ReceiptStore, type ReceiptFinder } from "../gate.ts";
import { runPass, type Finding, type PassResult, type Verb } from "../pipeline.ts";
import { Tracer, type TraceEvent } from "../trace.ts";
import { dnsRecordOverlay, realIpOverlay } from "./overlay.ts";
import { PREREQUISITES, prerequisitesFor, type Prerequisite, type PrerequisiteStep } from "./prerequisites.ts";
import { bindProposal, describeBound, parseProposal, type Bound, type ProposedChange } from "./proposal.ts";

export const MAX_ITERATIONS = 3;
export const AGENT = "preflight";

export type Verdict = "GO" | "NO-GO" | "GO-IF" | "ESCALATE";

export interface FindingRef { key: string; class: FindingClass; verb: Verb; summary: string }

export interface Simulation {
  /** 0 is the proposal alone; n is after n prerequisites. */
  iteration: number;
  steps: string[];
  findings: number;
  added: FindingRef[];
  removed: FindingRef[];
}

export interface AppliedPrerequisite {
  iteration: number;
  id: string;
  params: Params;
  description: string;
  /** The added finding this step was bound from. */
  from_finding: string;
  /** Whether that finding was gone in the next simulation. */
  cleared: boolean | null;
}

export type JudgeStatus = "skipped" | "fires" | "falsifier_vacuous" | "refutes_baseline" | "not_judged" | "invalid_output";

/** Whose claim the falsifier is for: a baseline finding the change removes (GO), or the finding the last prerequisite cleared (GO-IF). */
export type JudgeTarget = "removed_by_change" | "cleared_by_prerequisite";

export interface JudgeOutcome {
  status: JudgeStatus;
  reason: string;
  /** Null when nothing was judged. */
  target: JudgeTarget | null;
  claim: string | null;
  sql: string | null;
  rows_fixed: number | null;
  /** Rows in the world where the claim holds: the recorded world for a removed finding, the simulation it was bound in for a cleared one. */
  rows_baseline: number | null;
  receipt_id: string | null;
  served_model: string | null;
}

export interface PreflightResult {
  verdict: Verdict;
  reason: string;
  /** The proposal itself was rejected (does not parse, binds to no row or to several): counted by the eval. */
  invalid: boolean;
  proposal: unknown;
  bound: { kind: Bound["kind"]; tenant_id: string; run_id: string; change: string } | null;
  baseline: { runs: number; gated_out: string[]; observed: number; findings: number } | null;
  simulations: Simulation[];
  prerequisites: AppliedPrerequisite[];
  iterations: number;
  /** Relative to the baseline, after the last simulation. */
  removed: FindingRef[];
  added: FindingRef[];
  /** The derived tables the last simulation ran over, as templates ({{t:x}} is the base table). */
  overlays: Overlays;
  judge: JudgeOutcome;
}

export interface PreflightOptions {
  tracer?: Tracer;
  /** The pass over the world as recorded; computed when absent. */
  baseline?: PassResult;
  prerequisites?: readonly Prerequisite[];
  maxIterations?: number;
  /** "skip" (sample mode), or the judge to call; default follows config: skip in sample mode or without a Nightshift token. */
  judge?: "skip" | ((input: JudgeInput) => Promise<JudgeVerdict>);
  nightshift?: JudgeModel;
  receipts?: ReceiptFinder;
}

/** What makes two findings the same finding across worlds: class, anchor, name and record; never the verb or the checks. */
export function findingKey(f: Finding): string {
  const s = f.finding;
  return [s.class, s.tenant_id, s.host ?? "", s.object_id, s.setting_path, s.dns_name ?? "", s.resource_id ?? ""].join("|");
}

const ref = (f: Finding): FindingRef => ({ key: findingKey(f), class: f.finding.class, verb: f.verb, summary: f.finding.summary });

/** The pass's own trace lines, re-labelled: agent preflight ran them, target_agent says whose step it was, detail says in which world. */
class WorldTracer extends Tracer {
  constructor(private readonly inner: Tracer, private readonly world: string) {
    super(inner.traceId);
  }

  override emit(e: Omit<TraceEvent, "ts" | "trace_id">): TraceEvent {
    return this.inner.emit({ ...e, agent: AGENT, target_agent: e.agent, detail: `world=${this.world}${e.detail ? `; ${e.detail}` : ""}` });
  }
}

export function proposalOverlay(b: Bound): Overlays {
  if (b.kind === "dns_record") return dnsRecordOverlay({ run_id: b.run_id, record_ids: [b.record.record_id], field: b.field, to: b.to });
  return realIpOverlay({ run_id: b.run_id, object_id: b.object_id, setting_paths: b.rows.map((r) => r.setting_path), to: b.to });
}

const EVIDENCE_COLUMNS = ["class", "tenant_id", "run_id", "host", "object_id", "setting_path", "value_redacted", "dns_name", "resolves_to", "resource_id", "dns_run_id", "since", "until"] as const;

export async function runPreflight(raw: unknown, layer: DataLayer, opts: PreflightOptions = {}): Promise<PreflightResult> {
  const { tracer } = opts;
  const catalogue = opts.prerequisites ?? PREREQUISITES;
  const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
  const skipped: JudgeOutcome = { status: "skipped", reason: "", target: null, claim: null, sql: null, rows_fixed: null, rows_baseline: null, receipt_id: null, served_model: null };
  const base = (over: Partial<PreflightResult>): PreflightResult => ({
    verdict: "ESCALATE", reason: "", invalid: false, proposal: raw, bound: null, baseline: null, simulations: [], prerequisites: [], iterations: 0,
    removed: [], added: [], overlays: {}, judge: { ...skipped, reason: "no verdict to judge" }, ...over,
  });
  const escalate = (reason: string, over: Partial<PreflightResult>): PreflightResult => {
    tracer?.emit({ agent: AGENT, action: "escalate", status: "failed", output_summary: `ESCALATE: ${reason}` });
    return base({ verdict: "ESCALATE", reason, ...over });
  };

  // parse
  const parsed = parseProposal(raw);
  if (!parsed.ok) {
    tracer?.emit({ agent: AGENT, action: "triage", status: "failed", input_summary: "parse_proposal", output_summary: `rejected: ${parsed.reason}`, detail: "typed proposal required (zod ProposedChange); counted as invalid" });
    return escalate(`proposal rejected: ${parsed.reason}`, { invalid: true });
  }
  const proposal: ProposedChange = parsed.proposal;
  tracer?.emit({ agent: AGENT, action: "triage", status: "ok", input_summary: "parse_proposal", output_summary: `${proposal.kind}: set ${proposal.field} to ${JSON.stringify(proposal.to)} on ${JSON.stringify(proposal.target)}`, detail: proposal.when ? `when ${proposal.when}; simulated over the world as last collected` : "simulated over the world as last collected" });

  // baseline: the pass over the world as recorded
  const baseline = opts.baseline ?? await runPass(layer, { tracer: tracer && new WorldTracer(tracer, "baseline"), world: new DriftWorld("preflight_baseline") });
  const baseKeys = new Map(baseline.findings.map((f) => [findingKey(f), f]));
  const baselineSummary = { runs: baseline.runs, gated_out: baseline.gatedOut, observed: baseline.observed, findings: baseline.findings.length };
  tracer?.emit({ agent: AGENT, action: "detect", status: "ok", input_summary: "simulate baseline", output_summary: `baseline: ${baseline.findings.length} finding(s) over ${baseline.runs} run(s), ${baseline.gatedOut.length} gated out, ${baseline.observed} observations`, detail: "world=baseline; the pass over the rows as recorded, no overlay" });

  // bind
  const runs = objects(await listRuns(layer, { tracer, agent: AGENT }));
  const binding = await bindProposal(layer, proposal, runs, new Set(baseline.gatedOut), { tracer, agent: AGENT });
  if (!binding.ok) {
    tracer?.emit({ agent: AGENT, action: "triage", status: "failed", input_summary: "bind_proposal", output_summary: `rejected: ${binding.reason}`, detail: binding.invalid ? "counted as invalid" : "the world cannot be simulated; the proposal is not at fault" });
    return escalate(binding.reason, { invalid: binding.invalid, baseline: baselineSummary, proposal });
  }
  const bound = binding.bound;
  const change = describeBound(bound);
  tracer?.emit({ agent: AGENT, action: "triage", status: "ok", input_summary: "bind_proposal", output_summary: `bound: ${change}` });
  const noop = bound.kind === "dns_record" ? String(bound.from) === String(bound.to) : bound.rows.every((r) => r.value_redacted === bound.to);
  let overlays = proposalOverlay(bound);
  const rowsChanged = bound.kind === "dns_record" ? 1 : bound.rows.length;
  tracer?.emit({ agent: AGENT, action: "observe", status: "ok", input_summary: "overlay_delta", output_summary: `${rowsChanged} row(s) of ${Object.keys(overlays).join(", ")} differ from the recorded world${noop ? " in no column: the proposed value is already the recorded one" : ""}`, detail: Object.values(overlays).join(" | ").slice(0, 600) });

  // simulate, iterate
  const simulations: Simulation[] = [];
  const prerequisites: AppliedPrerequisite[] = [];
  /** Per prerequisite, the finding it was bound from and the simulated layer that finding was true in. */
  const boundFrom: { finding: Finding; layer: DataLayer; iteration: number }[] = [];
  const applied = new Set<string>();
  const steps: string[] = [];
  let iteration = 0;
  let verdict: Verdict = "ESCALATE";
  let reason = "";
  let last: { result: PassResult; layer: DataLayer; added: Finding[]; removed: Finding[] } | undefined;

  while (true) {
    const simLayer = layer.withOverlays(overlays);
    const result = await runPass(simLayer, { tracer: tracer && new WorldTracer(tracer, `simulated#${iteration}`), world: new DriftWorld(`preflight_sim_${iteration}`) });
    const simKeys = new Map(result.findings.map((f) => [findingKey(f), f]));
    const added = result.findings.filter((f) => !baseKeys.has(findingKey(f)));
    const removed = baseline.findings.filter((f) => !simKeys.has(findingKey(f)));
    simulations.push({ iteration, steps: [...steps], findings: result.findings.length, added: added.map(ref), removed: removed.map(ref) });
    last = { result, layer: simLayer, added, removed };
    const previous = prerequisites.at(-1);
    if (previous && previous.iteration === iteration) previous.cleared = !simKeys.has(previous.from_finding);
    tracer?.emit({
      agent: AGENT, action: "detect", status: "ok", input_summary: `simulate iteration ${iteration}${steps.length ? ` after ${steps.join(", ")}` : ""}`,
      output_summary: `simulated#${iteration}: ${result.findings.length} finding(s); ${added.length} added, ${removed.length} removed against the baseline`,
      detail: `world=simulated#${iteration}; added: ${added.map((f) => f.finding.class).join(", ") || "none"}; removed: ${removed.map((f) => f.finding.class).join(", ") || "none"}`,
    });
    if (result.gatedOut.length !== baseline.gatedOut.length) {
      verdict = "ESCALATE";
      reason = `the simulated world gates ${result.gatedOut.length} run(s) where the baseline gates ${baseline.gatedOut.length}; the overlay changed what the DQ gate sees`;
      break;
    }
    if (added.length === 0) {
      verdict = steps.length ? "GO-IF" : "GO";
      reason = steps.length
        ? `the change adds ${simulations[0].added.length} finding(s) that ${steps.length} prerequisite(s) clear: ${prerequisites.map((p, i) => `${i + 1}. ${p.description}`).join("; ")}`
        : noop ? `the proposed value is already the recorded one; the change alters no finding (${baseline.findings.length} before and after)`
        : `the change removes ${removed.length} finding(s) and adds none`;
      break;
    }
    // a prerequisite for the first added finding the catalogue can clear
    let step: PrerequisiteStep | null = null;
    let from: Finding | null = null;
    let blocker: { finding: Finding; why: string } | null = null;
    for (const f of added) {
      const entries = prerequisitesFor(f.finding.class, catalogue);
      if (!entries.length) { blocker = { finding: f, why: "no catalogue prerequisite clears this class" }; break; }
      for (const e of entries) {
        const s = await e.bind(f.finding, simLayer, { tracer, agent: AGENT });
        if (s && !applied.has(s.key)) { step = s; from = f; break; }
      }
      if (step) break;
      blocker = { finding: f, why: `${entries.map((e) => e.id).join(", ")} ${applied.size ? "already applied or " : ""}cannot be bound from this finding` };
      break;
    }
    if (!step || !from) {
      verdict = "NO-GO";
      reason = `the change adds ${added.length} finding(s); ${blocker!.finding.finding.class} (${blocker!.finding.finding.summary}) stays: ${blocker!.why}`;
      tracer?.emit({ agent: AGENT, action: "hypothesise", status: "failed", input_summary: `prerequisite for ${blocker!.finding.finding.class}`, output_summary: blocker!.why, detail: blocker!.finding.finding.summary.slice(0, 300) });
      break;
    }
    if (iteration >= maxIterations) {
      verdict = "ESCALATE";
      reason = `${added.length} finding(s) remain after ${maxIterations} prerequisite iteration(s); the loop bound is reached`;
      break;
    }
    boundFrom.push({ finding: from, layer: simLayer, iteration });
    iteration++;
    applied.add(step.key);
    steps.push(step.id);
    overlays = step.apply(overlays);
    prerequisites.push({ iteration, id: step.id, params: step.params, description: step.description, from_finding: findingKey(from), cleared: null });
    tracer?.emit({ agent: AGENT, action: "hypothesise", status: "ok", input_summary: `prerequisite ${iteration}: ${step.id}`, output_summary: `from_failed: ${from.finding.class} ${from.finding.setting_path} in ${from.finding.object_id}; adds: ${step.description}`, detail: `overlay on ${Object.keys(overlays).join(", ")}; model: none (catalogue order)` });
  }

  const final = last!;
  // The judge's target. GO-IF: the finding the last prerequisite was bound from, which the final simulation no
  // longer holds (added is empty), true in the simulation it was bound in. GO: the first baseline finding the
  // change removes, true in the recorded world. Never a removed baseline finding for a GO-IF, which would judge
  // a claim the prerequisite did not touch.
  const cleared = boundFrom.at(-1);
  const target: JudgeTargetWorld | null = verdict === "GO-IF" && cleared
    ? { kind: "cleared_by_prerequisite", finding: cleared.finding, trueWorld: cleared.layer, trueWorldName: `simulated#${cleared.iteration}, the simulation it was bound in`, chosen: `the finding prerequisite ${cleared.iteration + 1} (${steps.at(-1)}) was bound from and cleared` }
    : verdict === "GO"
    ? { kind: "removed_by_change", finding: final.removed[0], trueWorld: layer, trueWorldName: "the recorded one", chosen: "the first finding the change removes" }
    : null;
  const judge = target
    ? await judgeInFixedWorld(target, final.layer, opts)
    : { ...skipped, reason: `verdict ${verdict}: nothing cleared to falsify` };
  if (judge.status === "skipped") tracer?.emit({ agent: AGENT, action: "judge", status: "skipped", input_summary: judge.claim?.slice(0, 160) ?? "no claim", output_summary: target ? `target: ${target.chosen}` : "target: none", detail: judge.reason });

  tracer?.emit({
    agent: AGENT, action: "decide", status: verdict === "ESCALATE" ? "failed" : "ok", input_summary: change,
    output_summary: `${verdict}: ${reason}`, detail: `iterations ${iteration}; simulations ${simulations.length}; judge ${judge.status}; nothing written`,
  });
  return base({
    verdict, reason, proposal, bound: { kind: bound.kind, tenant_id: bound.tenant_id, run_id: bound.run_id, change }, baseline: baselineSummary,
    simulations, prerequisites, iterations: iteration, removed: final.removed.map(ref), added: final.added.map(ref), overlays, judge,
  });
}

interface JudgeTargetWorld {
  kind: JudgeTarget;
  /** Undefined only for a GO that removes nothing (a no-op change). */
  finding: Finding | undefined;
  /** The layer in which the finding's claim is true: the recorded world, or the simulation it was bound in. */
  trueWorld: DataLayer;
  trueWorldName: string;
  /** For the trace: which target was chosen and why. */
  chosen: string;
}

/**
 * Live only: ask the judge for the falsifier of the target finding, in the fixed world (the last overlaid
 * layer), where the detector's claim is false. Rows there mean the falsifier fires; none means it was
 * vacuous. The same SQL is then run in the world where the claim is true (the recorded world for a finding
 * the change removes, the simulation it was bound in for one a prerequisite cleared), where a sound
 * falsifier returns nothing. In sample mode, or without a Nightshift token, skipped and traced.
 */
async function judgeInFixedWorld(target: JudgeTargetWorld, fixed: DataLayer, opts: PreflightOptions): Promise<JudgeOutcome> {
  const { tracer } = opts;
  const { finding: removed, trueWorld, trueWorldName, chosen } = target;
  const none = { sql: null, rows_fixed: null, rows_baseline: null, receipt_id: null, served_model: null };
  const judge = opts.judge ?? (config.sampleMode || !config.nightshift.token ? "skip" : judgeClaim);
  if (!removed) return { status: "skipped", reason: "the change removes no finding; there is no claim whose falsifier could fire", target: null, claim: null, ...none };
  const claim = removed.finding.summary;
  if (judge === "skip") return { status: "skipped", reason: config.sampleMode ? "model: none (sample)" : "model: none (no Nightshift token)", target: target.kind, claim, ...none };

  tracer?.emit({ agent: AGENT, action: "judge", status: "ok", input_summary: claim.slice(0, 160), output_summary: `target: ${chosen}`, detail: `claim false in the fixed world (the last simulation), true in ${trueWorldName}; the falsifier is asked in the fixed world and re-run in the other` });
  const row = EVIDENCE_COLUMNS.map((c) => String((removed.finding as unknown as Record<string, unknown>)[c] ?? ""));
  // The call goes out under the tenant's app id, so the receipt must pass custody (src/gate.ts) as well as the tier gate.
  const verdict = await judge({
    claim, evidenceRows: { columns: [...EVIDENCE_COLUMNS], rows: [row] }, layer: fixed, tracer, tenantId: removed.finding.tenant_id,
    nightshift: opts.nightshift ?? new Nightshift(), receipts: opts.receipts ?? new ReceiptStore(),
  });
  const ids = { target: target.kind, receipt_id: verdict.receiptId, served_model: verdict.servedModel };
  if (verdict.status === "not_judged" || verdict.status === "invalid_output") {
    tracer?.emit({ agent: AGENT, action: "critique", status: verdict.status === "not_judged" ? "not_judged" : "failed", input_summary: claim.slice(0, 160), output_summary: `falsifier_fires: unknown (${verdict.status})`, detail: verdict.reason });
    return { status: verdict.status, reason: verdict.reason, claim, sql: verdict.sql, rows_fixed: null, rows_baseline: null, ...ids };
  }
  const rowsFixed = verdict.rowCount ?? 0;
  const rowsBaseline = (await trueWorld.run(verdict.sql!, {}, { agent: AGENT, tracer, limit: 50 })).rowCount;
  const status: JudgeStatus = rowsFixed === 0 ? "falsifier_vacuous" : rowsBaseline > 0 ? "refutes_baseline" : "fires";
  const reason = status === "fires" ? `the falsifier returns ${rowsFixed} row(s) in the fixed world and none in ${trueWorldName}`
    : status === "falsifier_vacuous" ? "the falsifier returns no rows in the fixed world, where the claim is false; it would not have caught the fix either"
    : `the falsifier returns ${rowsFixed} row(s) in the fixed world and ${rowsBaseline} in ${trueWorldName}: it refutes the detector's claim where the detector made it`;
  tracer?.emit({ agent: AGENT, action: "critique", status: status === "fires" ? "ok" : "failed", model_routed: verdict.servedModel ?? undefined, receipt_id: verdict.receiptId ?? undefined, input_summary: claim.slice(0, 160), output_summary: `falsifier_fires: ${rowsFixed > 0}`, detail: `target: ${chosen}; ${reason}` });
  return { status, reason, claim, sql: verdict.sql, rows_fixed: rowsFixed, rows_baseline: rowsBaseline, ...ids };
}

/** One markdown paragraph a technician reads. */
export function describeVerdict(r: PreflightResult): string {
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
  const byClass = (fs: FindingRef[]) => {
    const m = new Map<string, number>();
    for (const f of fs) m.set(f.class, (m.get(f.class) ?? 0) + 1);
    return [...m].map(([c, k]) => (k === 1 ? `\`${c}\`` : `\`${c}\` x${k}`)).join(", ");
  };
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const head = `**${r.verdict}**`;
  if (!r.bound) return `${head}: ${cap(r.reason)}.${r.invalid ? " The proposal is counted as invalid." : ""} Nothing was simulated and nothing was written.`;
  const what = r.bound.change;
  const world = r.baseline ? `the recorded pass (${n(r.baseline.runs, "run")}, ${r.baseline.gated_out.length} gated out, ${r.baseline.observed} observations, ${n(r.baseline.findings, "finding")})` : "the recorded pass";
  const tables = Object.keys(r.overlays).map((t) => `\`${t}\``).join(" and ");
  const first = r.simulations[0];
  const delta = `${r.removed.length ? `removes ${n(r.removed.length, "finding")} (${byClass(r.removed)})` : "removes none"} and ${r.added.length ? `leaves ${n(r.added.length, "finding")} added (${byClass(r.added)})` : r.verdict === "GO-IF" && first ? `adds ${n(first.added.length, "finding")} (${byClass(first.added)}) that the prerequisites clear` : "adds none"}`;
  const why = r.verdict === "GO-IF" ? `Prerequisites, in order: ${r.prerequisites.map((p, i) => `(${i + 1}) ${p.description}${p.cleared === false ? " [did not clear]" : ""}`).join("; ")}.`
    : r.verdict === "GO" && r.removed.length ? ""
    : `${cap(r.reason)}.`;
  const trueWorld = r.judge.target === "cleared_by_prerequisite" ? "the simulation the cleared finding was bound in" : "the recorded one";
  const judge = r.judge.status === "skipped" ? `Judge skipped (${r.judge.reason}).`
    : r.judge.status === "fires" ? `The judge's falsifier fired in the fixed world (${r.judge.rows_fixed} rows) and not in ${trueWorld}; receipt ${r.judge.receipt_id ?? "none"}, served ${r.judge.served_model ?? "unknown"}.`
    : `Judge: ${r.judge.status} (${r.judge.reason}).`;
  return [`${head}: ${what}.`, `Simulated over ${world} with ${tables} rendered as a derived table that applies the change (${n(r.simulations.length, "simulation")}, ${n(r.iterations, "prerequisite iteration")}): the change ${delta}.`, why, judge, "Nothing was written; the recorded rows are unchanged."].filter(Boolean).join(" ");
}
