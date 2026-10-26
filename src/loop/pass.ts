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
//   - On Zetaris, after the Decider and the ledger write, one SELECT over drift_usl.adoption (adoptionCheckSql) reads
//     the DQ rule exception_in_force for the tenant's ADOPTs under an exception: those decided at this pass's instant
//     when it recorded them, else the latest recorded pass's. Read only; a failed read is carried, never thrown, and
//     the Decider's own recall from the store is what decided. The summary and the pass row's Zetaris line carry it.
//     On sql.js nothing is read.
//   - Live, before anything else, refreshFiles puts the lessons and the rules into the Zetaris filestore again when
//     their hash differs from the last copy's, so the DQ read joins the lessons the Decider recalls (a lesson npm run
//     answer recorded since the last copy included). Its outcome is one trace line and one clause of the summary; a
//     failed refresh is carried, never thrown.
//   - On Zetaris, when the tenant has a cloudflare.dns run, beside the adoption read: one SELECT over drift_usl.dns_live
//     (dnsInventorySql) reads the DQ rule dns_inventory_current, every record the DNS API returns now (Zetaris fetches
//     the CLOUDFLARE REST tables at the query) against the last complete DNS run. Read only; a failed read is carried,
//     never thrown. A record that fails means the provider changed since that run, so the pass's picture of the zone is
//     stale. The summary and the pass row's Zetaris line carry it. On sql.js nothing is read (sample mode has no live
//     source).
//   - On Zetaris the change windows are read only when SHOW DATASOURCE TABLES lists change_window (src/zetaris/setup.ts
//     datasourceLists, one statement through the layer's engine): a listing without it means no window can be open,
//     and the pass reads none (runPass windowTable false); a listing that fails reads the table anyway, and a read
//     that fails escalates every drift a rule would roll back or fix. On sql.js the table is always there.
//   - Live, after the refresh and before any other read: the source-schema guard (src/zetaris/schema-guard.ts), one
//     DESCRIBE DATASOURCE TABLE per DRIFT table the pass reads and per CLOUDFLARE REST table, one trace line, and the
//     pass row's "schema" line: "<n> tables as expected", or "<ds>.<table> changed: <column>" in red. A DRIFT column the
//     pass reads that is missing or has changed type fails the pass closed on the surfaces that read it
//     (guardGate, every fail-closed decision on the guard's read in one place): their dispositions go to no ledger,
//     each of their findings is one NOT CHECKED line and one trace line with the reason, and the step returns them as
//     notChecked beside the findings it decided; on every surface ("*") the adoption read is not made either. When the
//     pass's own SQL fails over the changed table, the step refuses (LoopError, the schema reason first) and decides
//     nothing. A CLOUDFLARE change, or a DRIFT change that reaches cloudflare.dns, leaves the dns_inventory_current read
//     not made, its reason a schema line naming exactly those changes; a CLOUDFLARE change alone leaves the findings as
//     they are.
//   - Live, last: EXPLAIN QUERY AS of the hero join over the tenant's latest nginx and DNS runs and of the dns_live
//     read (src/zetaris/explain.ts), each traced once (agent zetaris, action explain, the plan redacted and cut to 4,000
//     characters; not_checked when the key may not run it), each one EXPLAIN line under --verbose with the plan's first
//     line.
//
// Measured 25 Oct 2026: over the Actor's fixture world (test/loop.test.ts) 12 findings, each read back under its
// disposition_id; a second pass at a later instant writes 12 rows of its own, and one at the same instant writes 0
// and counts 12 kept; the first live pass with the PgLedger is in scripts/pass.ts.

import { EXCEPTION_IN_FORCE } from "../data/files.ts";
import { DISPOSITIONS_SQL, HERO_SQL, listRuns, objects } from "../data/queries.ts";
import { assertSelectOnly, literal, type DataLayer } from "../data/layer.ts";
import { dispositionId, type Disposition, type ReferentFingerprint } from "../data/rows.ts";
import type { TechnicianMemory } from "../engine/memory.ts";
import { DriftWorld } from "../engine/world.ts";
import type { Ledger } from "../ledger.ts";
import { VERBS, runPass, type Finding, type PassResult } from "../pipeline.ts";
import type { Tracer } from "../trace.ts";
import { explainQuery, planLine, type PlanRead } from "../zetaris/explain.ts";
import { refreshText, type Refresh } from "../zetaris/filestore.ts";
import { guardGate, readSchemaGuard, schemaText, type SchemaGuard } from "../zetaris/schema-guard.ts";
import { DNS_INVENTORY_CURRENT, USL, datasourceLists } from "../zetaris/setup.ts";

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
  /**
   * Live: the Zetaris copy of the lessons and the rules, put again when the store or the policy file changed since the
   * last copy (src/zetaris/setup.ts refreshFileTables). Runs first, before the Decider and its DQ read.
   */
  refreshFiles?: () => Promise<Refresh>;
}

/**
 * The DQ rule exception_in_force over the tenant's adoptions as Zetaris reads them (drift_usl.adoption: DRIFT's
 * dispositions joined to LESSONS's lessons). `of` "pass": the ADOPTs this pass recorded, decided at its instant;
 * "recorded": a pass with no ledger recorded none, so the latest pass that did, decided at `decidedAt`.
 */
export type AdoptionCheck =
  | { rule: "exception_in_force"; of: "pass" | "recorded"; decidedAt: string | null; adoptions: number; inForce: number }
  | { rule: "exception_in_force"; error: string };

/** The USL entity the pass reads the rule over. */
export const ADOPTION_ENTITY = `${USL}.adoption`;

/**
 * One SELECT over drift_usl.adoption: per decision instant of the tenant, the ADOPTs under an exception and those for
 * which the rule's expression holds; the instant given, or the latest when none is. The expression is the registered
 * rule's own text (EXCEPTION_IN_FORCE), so Zetaris tests the same predicate RUN DQ tests, on this pass's rows only.
 */
export function adoptionCheckSql(tenant: string, decidedAt: string | null): string {
  return `SELECT decided_at, COUNT(*) AS adoptions, SUM(CASE WHEN ${EXCEPTION_IN_FORCE} THEN 1 ELSE 0 END) AS in_force FROM ${ADOPTION_ENTITY} WHERE tenant_id = ${literal(tenant)}${decidedAt === null ? "" : ` AND decided_at = ${literal(decidedAt)}`} GROUP BY decided_at ORDER BY decided_at DESC LIMIT 1`;
}

/** Read the check through the layer's engine (Zetaris only; the USL lives there). A failed read is returned, never thrown: the Decider has decided by then. */
export async function readAdoptionCheck(layer: DataLayer, tenant: string, decidedAt: string | null, tracer?: Tracer): Promise<AdoptionCheck> {
  const sql = adoptionCheckSql(tenant, decidedAt);
  try {
    assertSelectOnly(sql);
    const r = await layer.engine.run(sql, { tracer, agent: "loop", limit: 1 });
    const row = objects(r)[0];
    const n = (v: string | undefined): number => (v ? Number(v) : 0);
    return { rule: "exception_in_force", of: decidedAt === null ? "recorded" : "pass", decidedAt: row?.decided_at || decidedAt, adoptions: n(row?.adoptions), inForce: n(row?.in_force) };
  } catch (e) {
    return { rule: "exception_in_force", error: ((e as Error).message ?? String(e)).slice(0, 300) };
  }
}

/**
 * The DQ rule dns_inventory_current over drift_usl.dns_live: `live` the records the DNS API returns now, `current` those
 * the last complete DNS run holds with the same type and proxied flag, `runId` that run (null when there is none).
 */
export type DnsInventoryCheck =
  | { rule: "dns_inventory_current"; live: number; current: number; runId: string | null }
  | { rule: "dns_inventory_current"; error: string };

/** The USL entity the pass reads the rule over. */
export const DNS_ENTITY = `${USL}.dns_live`;

/** One SELECT over drift_usl.dns_live: the live records and those for which the registered rule's own text holds. */
export function dnsInventorySql(): string {
  return `SELECT COUNT(*) AS live, SUM(CASE WHEN ${DNS_INVENTORY_CURRENT} THEN 1 ELSE 0 END) AS current, MAX(run_id) AS run_id FROM ${DNS_ENTITY}`;
}

/** Read the check through the layer's engine (Zetaris only: the REST tables and the USL live there). A failed read is returned, never thrown. */
export async function readDnsInventory(layer: DataLayer, tracer?: Tracer): Promise<DnsInventoryCheck> {
  const sql = dnsInventorySql();
  try {
    assertSelectOnly(sql);
    const r = await layer.engine.run(sql, { tracer, agent: "loop", limit: 1 });
    const row = objects(r)[0];
    const n = (v: string | undefined): number => (v ? Number(v) : 0);
    return { rule: "dns_inventory_current", live: n(row?.live), current: n(row?.current), runId: row?.run_id || null };
  } catch (e) {
    return { rule: "dns_inventory_current", error: ((e as Error).message ?? String(e)).slice(0, 300) };
  }
}

/** "DQ dns_inventory_current 58 of 58 live records", or "... not read: <why>". */
export function dnsInventoryText(d: DnsInventoryCheck): string {
  if ("error" in d) return `DQ ${d.rule} not read: ${d.error}`;
  return `DQ ${d.rule} ${d.current} of ${d.live} live record${d.live === 1 ? "" : "s"}`;
}

export interface PassStep {
  tenant: string;
  decidedAt: string;
  pass: PassResult;
  /** Read after the Decider when the layer runs on Zetaris; absent on sql.js. */
  adoptions?: AdoptionCheck;
  /** Read beside it when the layer runs on Zetaris and the tenant has a DNS run; absent otherwise. */
  dns?: DnsInventoryCheck;
  /** The refresh of the file tables' copy, when the caller gave one. */
  files?: Refresh;
  /** The tenant's findings, in the pass's order: those the pass decided. */
  findings: Finding[];
  /** Live: the source-schema guard's read (src/zetaris/schema-guard.ts); absent on sql.js. */
  schema?: SchemaGuard;
  /** Live: the tenant's findings on a surface the guard failed closed, decided nothing and recorded nothing. */
  notChecked?: Finding[];
  /** Live: EXPLAIN QUERY AS of the hero join and the dns_live read. */
  plans?: PlanRead[];
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

/** "DQ exception_in_force 23 of 23 adoptions", "... of the pass recorded at <instant>", or "... not read: <why>". */
export function adoptionText(a: AdoptionCheck): string {
  if ("error" in a) return `DQ ${a.rule} not read: ${a.error}`;
  const of = a.of === "recorded" ? (a.decidedAt ? ` of the pass recorded at ${a.decidedAt}` : " (no pass recorded one)") : "";
  return `DQ ${a.rule} ${a.inForce} of ${a.adoptions} adoption${a.adoptions === 1 ? "" : "s"}${of}`;
}

const tally = (xs: readonly string[]): string =>
  [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(", ") || "none";

export async function passStep(layer: DataLayer, opts: PassStepOptions): Promise<PassStep> {
  const { tenant, tracer } = opts;
  // First: the copy drift_usl.adoption joins (LESSONS.lesson), current with the store the Decider recalls from.
  const files = opts.refreshFiles ? await opts.refreshFiles() : undefined;
  if (files) {
    tracer?.emit({
      agent: "loop", action: "observe", status: files.status === "failed" ? "failed" : files.status === "current" ? "skipped" : "ok",
      input_summary: `file tables ${tenant}`, output_summary: refreshText(files), latency_ms: files.ms,
    });
  }
  const live = layer.engine.name === "zetaris";
  // Live, before any other read: the columns Zetaris reports against the ones the pass reads.
  const schema = live ? await readSchemaGuard(layer.engine, { tracer, agent: "loop" }) : undefined;
  if (schema) {
    tracer?.emit({ agent: "loop", action: "check", status: schema.changes.length ? "not_checked" : "ok", input_summary: `schema ${tenant}`, output_summary: `schema: ${schemaText(schema)}` });
  }
  const gate = guardGate(schema);
  const { affected, isAffected, driftWhy } = gate;
  const failsClosed = affected === "*" || affected.size > 0;
  const refuse = (e: unknown): never => {
    throw new LoopError(`decided nothing: ${driftWhy}; the pass's SQL failed over it: ${((e as Error).message ?? String(e)).slice(0, 300)}`);
  };

  let runs: Record<string, string>[];
  try {
    runs = objects(await listRuns(layer, { tracer, agent: "loop" })).filter((r) => r.tenant_id === tenant);
  } catch (e) {
    if (failsClosed) refuse(e);
    throw e;
  }
  if (!runs.length) throw new LoopError(`the datasource holds no collection run of tenant ${tenant}`);
  const dnsRuns = new Set(runs.filter((r) => r.surface === "cloudflare.dns").map((r) => r.run_id));
  const decidedAt = new Date(opts.decidedAt ?? Date.now()).toISOString();
  const tenantLedger = opts.ledger ? new TenantLedger(opts.ledger, tenant, dnsRuns) : undefined;
  // Fail closed: the affected surfaces' dispositions go to no ledger.
  const ledger: Ledger | undefined = tenantLedger && failsClosed
    ? { record: (rows) => tenantLedger.record(rows.filter((r) => !isAffected(r.surface))), recordFingerprints: (rows) => tenantLedger.recordFingerprints(rows) }
    : tenantLedger;
  const windowTable = live ? (await datasourceLists(layer.engine, "change_window", { tracer, agent: "loop" })) !== false : true;
  let pass: PassResult;
  try {
    pass = await runPass(layer, { tracer, world: opts.world ?? new DriftWorld("pass"), memory: opts.memory, ledger, decidedAt, windowTable });
  } catch (e) {
    if (failsClosed) refuse(e);
    throw e;
  }
  const mine = pass.findings.filter((f) => f.finding.tenant_id === tenant);
  const findings = mine.filter((f) => !isAffected(f.finding.surface));
  const notChecked = mine.filter((f) => isAffected(f.finding.surface));
  for (const f of notChecked) {
    tracer?.emit({ agent: "loop", action: "check", status: "not_checked", input_summary: `finding ${f.id} ${f.finding.class} ${f.finding.surface}`, output_summary: `not checked: ${driftWhy}; nothing decided or recorded` });
  }

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
  for (const f of notChecked) lines.push(`NOT CHECKED ${f.id} ${f.finding.class} ${f.finding.surface}${f.finding.host ? ` ${f.finding.host}` : ""} ${f.finding.object_id} ${f.finding.setting_path}: ${driftWhy}; nothing decided or recorded`);
  // The rows stored under this pass's ids beyond the ones it wrote are an earlier pass's at the same instant over the same runs.
  if (stored && pass.ledger) kept = Math.max(0, findings.length - pass.ledger.dispositions);

  // After the Decider, read only: the rule exception_in_force over this pass's adoptions as Zetaris joins them across
  // DRIFT and LESSONS; with no ledger the pass recorded none, so the latest recorded pass's. Not read when the guard
  // failed every surface closed.
  const adoptions: AdoptionCheck | undefined = !live ? undefined
    : gate.adoptionWhy ? { rule: "exception_in_force", error: gate.adoptionWhy }
    : await readAdoptionCheck(layer, tenant, ledger ? decidedAt : null, tracer);
  // Read only, beside it: the records the DNS API returns now against the last complete DNS run, joined in Zetaris; not
  // read when the guard found a REST table changed or a DRIFT change that reaches the DNS surface (guardGate).
  const dns: DnsInventoryCheck | undefined = !live || !dnsRuns.size ? undefined
    : gate.dnsWhy ? { rule: "dns_inventory_current", error: gate.dnsWhy }
    : await readDnsInventory(layer, tracer);

  // Live, last: Zetaris's plan of the cross-source queries, traced once each.
  const plans: PlanRead[] = [];
  if (live) {
    const latestOf = (surface: string): Record<string, string> | undefined => runs.filter((r) => r.surface === surface).sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0)).at(-1);
    const nginx = latestOf("linux.nginx");
    const dnsRun = latestOf("cloudflare.dns");
    if (nginx && dnsRun) plans.push(await explainQuery(layer.engine, "hero", layer.render(HERO_SQL, { tenant_id: tenant, run_id: nginx.run_id, dns_run_id: dnsRun.run_id }), { tracer }));
    if (dnsRuns.size) plans.push(await explainQuery(layer.engine, "dns_live", dnsInventorySql(), { tracer }));
    for (const p of plans) lines.push(planLine(p));
  }

  const tenantRuns = new Set(runs.map((r) => r.run_id));
  const gated = pass.gatedOut.filter((r) => tenantRuns.has(r));
  const verbs = VERBS.map((v) => [v, findings.filter((f) => f.verb === v).length] as const).filter(([, n]) => n > 0).map(([v, n]) => `${v} ${n}`).join(", ") || "none";
  const by = tally(findings.map((f) => f.disposition.decided_by));
  const mem = pass.memory ? `memory: ${pass.memory.lessons} lesson(s), ${pass.memory.applied} exception(s) applied, ${pass.memory.lapsed} lapsed` : "memory: none consulted";
  const recorded = pass.ledger
    ? `ledger: ${pass.ledger.dispositions} disposition(s) and ${pass.ledger.fingerprints} referent fingerprint(s) written, ${kept} finding(s) on rows an earlier pass wrote`
    : "ledger: none, nothing recorded";
  const dq = `${files ? `; ${refreshText(files)}` : ""}${adoptions ? `; ${adoptionText(adoptions)}` : ""}${dns ? `; ${dnsInventoryText(dns)}` : ""}`;
  const guard = schema ? `; schema: ${schemaText(schema)}${notChecked.length ? `, ${notChecked.length} finding(s) not checked` : ""}` : "";
  const explained = plans.length ? `; ${plans.map((p) => `EXPLAIN ${p.query} ${p.status}`).join(", ")}` : "";
  const summary = `PASS: tenant ${tenant}, decided at ${decidedAt}: ${runs.length} collection run(s) of the tenant, ${gated.length} failed the DQ gate (${gated.join(", ") || "none"}), `
    + `${pass.observed} observations in the World Model, ${findings.length} finding(s) (${tally(findings.map((f) => f.finding.class))}); verbs: ${verbs}; decided by ${by}; `
    + `judge skipped (model: none); ${mem}; policy rules ${pass.rules}, locked settings without an approved value ${pass.locked}; ${recorded}${dq}${guard}${explained}`;
  tracer?.emit({ agent: "loop", action: "triage", status: "ok", input_summary: `pass ${tenant}`, output_summary: summary.slice(0, 1000), detail: "model: none" });
  return {
    tenant, decidedAt, pass, findings, runs: runs.length, kept, lines, summary, ...(adoptions ? { adoptions } : {}), ...(dns ? { dns } : {}), ...(files ? { files } : {}),
    ...(schema ? { schema, notChecked } : {}), ...(live ? { plans } : {}),
  };
}
