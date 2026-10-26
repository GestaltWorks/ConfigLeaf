// The shipped policy in the eval. eval/PROTOCOL.md defines C0 as what SAMPLE_MODE runs, and SAMPLE_MODE decides
// under the policy file, so the runner loads that file into the recording before any pass and every finding of C0
// to C3 is decided as the shipped pass decides it: the technician's exception, then the rule, then the default.
//
// Contract.
//   loadEvalPolicy: the file (DRIFT_POLICY_FILE unless the caller names one) through src/policy/load.ts for the
//     recording's tenant, under the redactor npm run policy:load uses (REDACT_SALT, REDACT_WORDS; a blank salt takes a
//     fixed eval salt, and a glob of paths and wildcards comes back unchanged under any salt), its rows inserted into
//     the sql.js engine before the first pass (a row already stored is kept); then the rules the pass reads for the
//     tenant (its own and every "*" rule, as src/pipeline.ts reads them). Returns the file, its version, the rules
//     read and the rows inserted.
//   underPolicy: a pass finding, decided by the pass under the rules: when the exception or a rule decided it
//     (decided_by operator or policy), that decision stands, since src/policy/decide.ts settles both steps before it
//     reads the checks; when the default decided it, the configuration's own verb and sentence stand.
//   decideHistory: a finding the runner reads from the audit log, outside the pass's findings, through src/policy/decide.ts
//     with the rule that governs its record (src/policy/resolve.ts), the exception state none (the eval's technician
//     memory is empty), approval null (dns_change sits outside the approval classes), the latest HOLD the ledger holds
//     on its live value (PRIOR_HOLDS_SQL) and production from the probes of the tenant's passing probe run nearest its
//     DNS run.
//   Both name what the configuration alone says after the exception's or the rule's sentence: "; this configuration
//   alone says <verb>: <its sentence>".
// C4 is Ultra alone, the protocol's baseline: its verb is the model's.
//
// Measured 25 Oct 2026 on test/fixtures/recorded-bundle.json with policy/hackathon.json version 2 (test/eval.test.ts):
// 15 rules inserted, 15 read for client-1; the 38 findings of the pass and the 14 history findings all HOLD by policy,
// under the catch-all rule (* ** **), the real_ip rule, and the record content and proxied rules.

import type { FindingSummary } from "../catalogue/select.ts";
import { config } from "../config.ts";
import type { SqlJsEngine } from "../data/engines/sqljs.ts";
import type { DataLayer } from "../data/layer.ts";
import { listRuns, objects, policyRules, priorHolds, probesOfRun, runComplete } from "../data/queries.ts";
import type { DecidedBy, PolicyRule } from "../data/rows.ts";
import { nearestRun, ruleOf, type DispositionNote, type Verb } from "../pipeline.ts";
import { decide, type PriorHold, type ProbeView } from "../policy/decide.ts";
import { loadPolicyFile } from "../policy/load.ts";
import { resolvePolicy } from "../policy/resolve.ts";
import { Redactor } from "../redactor.ts";

export interface EvalPolicy {
  /** The policy file loaded, as named. */
  file: string;
  version: number;
  tenant: string;
  /** Rows the file gave, and of those the rows inserted (0 when the recording already held them). */
  rows: number;
  inserted: number;
  /** The rules the pass reads for the tenant once the file is in: its own and every "*" rule, the refused ones left out. */
  rules: PolicyRule[];
}

/** A verb with who decided it and under which rule. */
export interface Decided { verb: Verb; reason: string; decided_by: DecidedBy; rule_id: string | null }

const opts = { agent: "eval" } as const;

/** The policy file into the recording, before any pass. */
export async function loadEvalPolicy(engine: SqlJsEngine, layer: DataLayer, file: string, tenant: string): Promise<EvalPolicy> {
  const loaded = loadPolicyFile(file, { tenant, redactor: new Redactor(config.redactSalt || "eval-runner", config.redactWords) });
  const inserted = engine.insertRows("policy_rule", loaded.rows);
  const rules = objects(await policyRules(layer, tenant, opts)).map(ruleOf).filter((r): r is PolicyRule => !("refused" in r));
  return { file, version: loaded.file.version, tenant, rows: loaded.rows.length, inserted, rules };
}

/** A pass finding: the exception's or the rule's decision when the pass took one, else the configuration's own verb. */
export function underPolicy(pass: DispositionNote | undefined, own: { verb: Verb; reason: string }): Decided {
  if (!pass || pass.decided_by === "default") return { ...own, decided_by: "default", rule_id: null };
  return { verb: pass.verb, reason: `${pass.reason}; this configuration alone says ${own.verb}: ${own.reason}`, decided_by: pass.decided_by, rule_id: pass.rule_id };
}

export interface HistoryPolicy {
  rules: readonly PolicyRule[];
  decidedAt: string;
  /** The ledger's latest HOLD per live value of the tenant, decided before decidedAt. */
  holds: Map<string, PriorHold>;
  /** The tenant's runs that pass the gate. */
  passing: Record<string, string>[];
}

const holdKey = (x: { surface: string; host: string | null; object_id: string; setting_path: string; value_hash: string }): string =>
  [x.surface, x.host ?? "", x.object_id, x.setting_path, x.value_hash].join("\u001f");

/** What decideHistory reads once per recording: the prior HOLDs and the passing runs, for the tenant. */
export async function historyPolicy(layer: DataLayer, policy: EvalPolicy, decidedAt: string): Promise<HistoryPolicy> {
  const holds = new Map<string, PriorHold>();
  for (const h of objects(await priorHolds(layer, { tenant_id: policy.tenant, decided_at: decidedAt }, { ...opts, limit: 100_000 }))) {
    const key = holdKey({ surface: h.surface, host: h.host || null, object_id: h.object_id, setting_path: h.setting_path, value_hash: h.value_hash });
    if (h.expires_at) holds.set(key, { decided_at: h.decided_at, expires_at: h.expires_at, rule_id: h.rule_id || null });
  }
  const passing: Record<string, string>[] = [];
  for (const r of objects(await listRuns(layer, opts)).filter((x) => x.tenant_id === policy.tenant)) {
    if ((await runComplete(layer, r.run_id, opts)).total === 0) passing.push(r);
  }
  return { rules: policy.rules, decidedAt, holds, passing };
}

/** A history finding through the Decider, as the pass decides a finding on a DNS record. */
export async function decideHistory(layer: DataLayer, hp: HistoryPolicy, finding: FindingSummary, own: { verb: "ADOPT" | "ESCALATE"; why: string }): Promise<Decided> {
  const rule = resolvePolicy(hp.rules, finding);
  if (!rule) return { verb: own.verb, reason: own.why, decided_by: "default", rule_id: null };
  const run = hp.passing.find((r) => r.run_id === finding.run_id);
  const probeRun = run ? nearestRun(hp.passing, run, "probe") : undefined;
  const probes: ProbeView = probeRun
    ? { run_id: probeRun.run_id, rows: objects(await probesOfRun(layer, { tenant_id: finding.tenant_id, run_id: probeRun.run_id }, opts)).map((p) => ({ kind: p.kind, target: p.target, status: p.status })) }
    : { run_id: null, rows: [] };
  const d = decide({
    finding: { class: finding.class, object_id: finding.object_id }, rule, exception: { state: "none" }, checks: own, approved: null, copies: [], probes,
    serves: finding.dns_name ? [finding.dns_name] : [], decidedAt: hp.decidedAt, priorHold: hp.holds.get(holdKey(finding)) ?? null,
  });
  return { verb: d.verb, reason: d.decided_by === "default" ? d.reason : `${d.reason}; this configuration alone says ${own.verb}: ${own.why}`, decided_by: d.decided_by, rule_id: d.rule_id };
}
