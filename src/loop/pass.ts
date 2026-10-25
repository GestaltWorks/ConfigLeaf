// The pass as one step of the loop: src/pipeline.ts runPass for one tenant over a DataLayer, with a ledger that keeps
// the tenant's rows, and the lines scripts/pass.ts prints and the cycle traces.
//
// Contract:
//   - The tenant's collection runs are read first (RUNS_SQL); a tenant with none refuses the step (LoopError).
//   - runPass reads every run of the layer, as the sample pass does. TenantLedger hands the inner ledger the tenant's
//     rows only: its dispositions (tenant_id) and the referent fingerprints of its DNS runs (dns_run_id). The ledger's
//     own idempotency stands: a disposition_id it holds already is kept as first written.
//   - decidedAt is the given instant (ISO 8601 UTC, normalised to milliseconds) or the system clock; every disposition
//     of the pass carries it and every HOLD expiry starts from it.
//   - lines: one JSON object per finding of the tenant, then one DISPOSITION line per finding as the ledger holds it,
//     read back through the same DataLayer (DISPOSITIONS_SQL) by the disposition_id the pass wrote. The id carries the
//     pass's decided_at (rows.ts dispositionId), so a row already stored under it is an earlier pass's at the same
//     instant over the same runs, and kept counts those. With no ledger the line carries the pass's own decision,
//     marked as not recorded. summary: one line of counts.
//
// Measured 25 Oct 2026: over the Actor's fixture world (test/loop.test.ts) 12 findings, each read back under its
// disposition_id; a second pass at a later instant writes 12 rows of its own, and one at the same instant writes 0
// and counts 12 kept; the first live pass with the PgLedger is in scripts/pass.ts.

import { DISPOSITIONS_SQL, listRuns, objects } from "../data/queries.ts";
import type { DataLayer } from "../data/layer.ts";
import { dispositionId, type Disposition, type ReferentFingerprint } from "../data/rows.ts";
import type { TechnicianMemory } from "../engine/memory.ts";
import { DriftWorld } from "../engine/world.ts";
import type { Ledger } from "../ledger.ts";
import { VERBS, runPass, type Finding, type PassResult } from "../pipeline.ts";
import type { Tracer } from "../trace.ts";

export class LoopError extends Error {}

/** A ledger that passes on one tenant's dispositions and the fingerprints of that tenant's DNS runs. */
export class TenantLedger implements Ledger {
  constructor(private readonly inner: Ledger, private readonly tenant: string, private readonly dnsRuns: ReadonlySet<string>) {}

  record(rows: readonly Disposition[]): Promise<number> {
    return this.inner.record(rows.filter((r) => r.tenant_id === this.tenant));
  }

  recordFingerprints(rows: readonly ReferentFingerprint[]): Promise<number> {
    return this.inner.recordFingerprints(rows.filter((r) => this.dnsRuns.has(r.dns_run_id)));
  }
}

export interface PassStepOptions {
  tenant: string;
  /** PgLedger live, MemoryLedger over sql.js in a test; null records nothing (npm run pass -- --no-ledger). */
  ledger: Ledger | null;
  memory?: TechnicianMemory;
  /** ISO 8601 UTC; the system clock when absent. */
  decidedAt?: string;
  tracer?: Tracer;
  world?: DriftWorld;
}

export interface PassStep {
  tenant: string;
  decidedAt: string;
  pass: PassResult;
  /** The tenant's findings, in the pass's order. */
  findings: Finding[];
  /** The tenant's collection runs. */
  runs: number;
  /** Findings whose ledger row an earlier pass wrote (the same disposition_id); 0 with no ledger. */
  kept: number;
  lines: string[];
  summary: string;
}

/** The disposition_id a pass decided at `decidedAt` gives a finding (src/pipeline.ts): the ledger row it writes is keyed on it. */
export const dispositionIdOf = (f: Finding, decidedAt: string): string =>
  dispositionId(f.finding.tenant_id, f.finding.surface, f.finding.host, f.finding.object_id, f.finding.setting_path, f.finding.value_hash, f.id, f.finding.run_id, decidedAt);

const tally = (xs: readonly string[]): string =>
  [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(", ") || "none";

export async function passStep(layer: DataLayer, opts: PassStepOptions): Promise<PassStep> {
  const { tenant, tracer } = opts;
  const runs = objects(await listRuns(layer, { tracer, agent: "loop" })).filter((r) => r.tenant_id === tenant);
  if (!runs.length) throw new LoopError(`the datasource holds no collection run of tenant ${tenant}`);
  const dnsRuns = new Set(runs.filter((r) => r.surface === "cloudflare.dns").map((r) => r.run_id));
  const decidedAt = new Date(opts.decidedAt ?? Date.now()).toISOString();
  const ledger = opts.ledger ? new TenantLedger(opts.ledger, tenant, dnsRuns) : undefined;
  const pass = await runPass(layer, { tracer, world: opts.world ?? new DriftWorld("pass"), memory: opts.memory, ledger, decidedAt });
  const findings = pass.findings.filter((f) => f.finding.tenant_id === tenant);

  const stored = ledger ? new Map(objects(await layer.run(DISPOSITIONS_SQL, {}, { tracer, agent: "loop", limit: 100_000 })).map((d) => [d.disposition_id, d])) : null;
  let kept = 0;
  const lines = findings.map((f) => JSON.stringify(f));
  for (const f of findings) {
    const own = f.disposition;
    if (!stored) {
      lines.push(`DISPOSITION ${f.id} ${own.verb} by ${own.decided_by}${own.rule_id ? ` under ${own.rule_id}` : ""} expires ${own.expires_at || "-"}: ${own.reason} (not recorded: no ledger)`);
      continue;
    }
    const d = stored.get(dispositionIdOf(f, decidedAt));
    if (!d) {
      lines.push(`DISPOSITION ${f.id} absent from the ledger`);
      continue;
    }
    lines.push(`DISPOSITION ${d.finding_id} ${d.verb} by ${d.decided_by}${d.rule_id ? ` under ${d.rule_id}` : ""} expires ${d.expires_at || "-"}: ${d.reason}`);
  }
  // The rows stored under this pass's ids beyond the ones it wrote are an earlier pass's at the same instant over the same runs.
  if (stored && pass.ledger) kept = Math.max(0, findings.length - pass.ledger.dispositions);

  const tenantRuns = new Set(runs.map((r) => r.run_id));
  const gated = pass.gatedOut.filter((r) => tenantRuns.has(r));
  const verbs = VERBS.map((v) => [v, findings.filter((f) => f.verb === v).length] as const).filter(([, n]) => n > 0).map(([v, n]) => `${v} ${n}`).join(", ") || "none";
  const by = tally(findings.map((f) => f.disposition.decided_by));
  const mem = pass.memory ? `memory: ${pass.memory.lessons} lesson(s), ${pass.memory.applied} exception(s) applied, ${pass.memory.lapsed} lapsed` : "memory: none consulted";
  const recorded = pass.ledger
    ? `ledger: ${pass.ledger.dispositions} disposition(s) and ${pass.ledger.fingerprints} referent fingerprint(s) written, ${kept} finding(s) on rows an earlier pass wrote`
    : "ledger: none, nothing recorded";
  const summary = `PASS: tenant ${tenant}, decided at ${decidedAt}: ${runs.length} collection run(s) of the tenant, ${gated.length} failed the DQ gate (${gated.join(", ") || "none"}), `
    + `${pass.observed} observations in the World Model, ${findings.length} finding(s) (${tally(findings.map((f) => f.finding.class))}); verbs: ${verbs}; decided by ${by}; `
    + `judge skipped (model: none); ${mem}; policy rules ${pass.rules}, locked settings without an approved value ${pass.locked}; ${recorded}`;
  tracer?.emit({ agent: "loop", action: "triage", status: "ok", input_summary: `pass ${tenant}`, output_summary: summary.slice(0, 1000), detail: "model: none" });
  return { tenant, decidedAt, pass, findings, runs: runs.length, kept, lines, summary };
}
