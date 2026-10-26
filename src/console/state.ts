// The console's state: what it reads through the DataLayer the agent uses (Zetaris live, sql.js in sample mode) and
// what it holds between requests. One Console per process, one tenant.
//
// Contract:
//   - Backend: the layer the pages read through (inside a CountingEngine, so a pass's query count is known), the store
//     the actions write through (change_window rows, approved_setting rows), the redactor every page string passes, the
//     lessons, and the ledger a pass records into: a MemoryLedger over the sql.js engine in sample mode (the actions and
//     the passes live for the process), none live, where the console's pass is a dry pass that records nothing.
//     sampleBackend loads the bundle and the file tables into a fresh sql.js engine; liveBackend opens the Store on
//     DATABASE_URL, applies sql/schema.sql (CREATE TABLE IF NOT EXISTS, so change_window exists) and reads through
//     Zetaris.
//   - The snapshot is everything the pages show, read in one go and kept until an action or a pass changes the store:
//     the owner's document and report rows (src/document/render.ts renderDocument with the report's reads), the latest
//     passing run of each surface and host with its observations, the DNS records of the latest DNS run, the latest
//     approvals, the change windows, the tenant's dispositions and, per host, what a restore from its newest backup
//     would regress (the catalogue's restore_would_regress). Nothing in it is typed in.
//   - decisions(): the current decision on each finding: the console's latest pass when one ran (in sample mode it is
//     also in the ledger), else the ledger's latest disposition of each finding on the latest passing runs.
//   - settingObjects(): every object of the latest passing runs, files per host and records per zone, plus an approved
//     object a run lacks, each with its live state, approval, lock (the governing rule's lock, or the open window),
//     template (the rule's family), last change (the cause's sentence) and status from the current decisions.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { actionOf } from "../actions/plan.ts";
import { runCheck } from "../catalogue/templates.ts";
import type { FindingClass } from "../catalogue/templates.ts";
import { config } from "../config.ts";
import { CountingEngine, NO_QUERIES, type QueryTally } from "../data/engines/counting.ts";
import { SqlJsEngine } from "../data/engines/sqljs.ts";
import { ZetarisEngine } from "../data/engines/zetaris.ts";
import { fileRows } from "../data/file-rows.ts";
import { decisionInstantWith } from "../data/instant.ts";
import { DataLayer } from "../data/layer.ts";
import { APPROVED_COPIES_SQL, CHANGE_WINDOWS_SQL, DISPOSITIONS_SQL, LATEST_APPROVALS_SQL, OBSERVATIONS_SQL, RUNS_SQL, RUN_COMPLETE_SQL, objects } from "../data/queries.ts";
import type { Action, ApprovedSetting, ChangeWindow, CollectionRun, FindingCause, Observation, PolicyRule } from "../data/rows.ts";
import { Store } from "../data/store.ts";
import { renderDocument, type DocumentResult, type OpenDisposition } from "../document/render.ts";
import { TechnicianMemory } from "../engine/memory.ts";
import { DriftWorld } from "../engine/world.ts";
import { BUNDLE_REDACTOR, MemoryCauseSink, explainPass, type ExplainResult } from "../explain/explain.ts";
import { MemoryLedger, type Ledger } from "../ledger.ts";
import { dispositionIdOf, passStep, type PassStep } from "../loop/pass.ts";
import { FileTracer } from "../loop/trace.ts";
import type { Finding, Verb } from "../pipeline.ts";
import { openWindow } from "../policy/decide.ts";
import { resolvePolicy } from "../policy/resolve.ts";
import { MemoryWindows, PgWindows, WINDOW_SURFACES, type WindowStore } from "../policy/window.ts";
import { Redactor } from "../redactor.ts";
import type { Tracer } from "../trace.ts";
import type { ApprovalStore } from "../vault/approve.ts";
import { Vault } from "../vault/vault.ts";
import { datasourceLists, refreshFileTables } from "../zetaris/setup.ts";
import type { Refresh } from "../zetaris/filestore.ts";

type Row = Readonly<Record<string, string>>;
export type ConsoleMode = "sample" | "live";

/** What the console's Approve reads besides the stored approvals: the gate's latest passing run and its observations. */
export interface ApprovalSource extends ApprovalStore {
  latestPassingRun(tenant: string, surface: string, host: string | null): Promise<CollectionRun | null>;
  observationsOf(runId: string): Promise<Observation[]>;
}

export interface Backend {
  mode: ConsoleMode;
  tenant: string;
  layer: DataLayer;
  counting: CountingEngine;
  /** The sql.js engine in sample mode; null live. */
  engine: SqlJsEngine | null;
  redactor: Redactor;
  windows: WindowStore;
  approvals: ApprovalSource;
  /** Where a pass records its dispositions: the sql.js engine in sample mode; null live (a dry pass). */
  ledger: Ledger | null;
  vault: Vault | null;
  memoryDir: string;
  /** Whether Record exception may write the lesson store. */
  memoryWritable: boolean;
  /** One phrase naming what the layer reads. */
  source: string;
  bundle: { path: string; sha256: string } | null;
  /** The instant the sample's own pass decides at (the bundle's or its latest lesson's); null live. */
  sampleInstant: string | null;
  refreshFiles?: () => Promise<Refresh>;
  close(): Promise<void>;
}

const nul = (s: string | undefined): string | null => (s === undefined || s === "" ? null : s);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A collection_run row as the layer returns it, back to its type. */
const runOf = (r: Row): CollectionRun => ({
  run_id: r.run_id, tenant_id: r.tenant_id, surface: r.surface, host: nul(r.host), started_at: r.started_at, finished_at: nul(r.finished_at),
  expected_count: r.expected_count === "" ? null : Number(r.expected_count), observed_count: r.observed_count === "" ? null : Number(r.observed_count), status: r.status as CollectionRun["status"],
});

/** An observation row as the layer returns it, back to its type. */
const observationOf = (o: Row): Observation => ({
  obs_id: o.obs_id, run_id: o.run_id, tenant_id: o.tenant_id, surface: o.surface, host: nul(o.host), object_id: o.object_id, setting_path: o.setting_path,
  value_hash: o.value_hash, value_redacted: nul(o.value_redacted), refers_to_type: nul(o.refers_to_type), refers_to_id: nul(o.refers_to_id),
  observed_at: o.observed_at, source: o.source, authority: Number(o.authority),
});

const APPROVALS_OF_TENANT_SQL = `SELECT approval_id, tenant_id, surface, host, object_id, setting_path, value_hash, approved_at, approved_by, note
FROM {{t:approved_setting}}
WHERE tenant_id = {{p:tenant_id}}
ORDER BY approval_id`;

/** The approvals side of sample mode: the gate, the observations and the stored approvals read through the layer, the rows written into the sql.js engine. */
export class LayerApprovals implements ApprovalSource {
  constructor(private readonly layer: DataLayer, private readonly engine: SqlJsEngine) {}

  async latestPassingRun(tenant: string, surface: string, host: string | null): Promise<CollectionRun | null> {
    const runs = objects(await this.layer.run(RUNS_SQL, {}, { agent: "console", limit: 100_000 }))
      .filter((r) => r.tenant_id === tenant && r.surface === surface && (r.host || null) === host)
      .sort((a, b) => cmp(b.started_at, a.started_at) || cmp(b.run_id, a.run_id));
    for (const r of runs) {
      if ((await this.layer.run(RUN_COMPLETE_SQL, { run_id: r.run_id }, { agent: "console" })).total === 0) return runOf(r);
    }
    return null;
  }

  async observationsOf(runId: string): Promise<Observation[]> {
    return objects(await this.layer.run(OBSERVATIONS_SQL, { run_id: runId }, { agent: "console", limit: 100_000 })).map(observationOf);
  }

  async rowsOf(_table: "approved_setting", where: { tenant_id: string }): Promise<ApprovedSetting[]> {
    return objects(await this.layer.run(APPROVALS_OF_TENANT_SQL, { tenant_id: where.tenant_id }, { agent: "console", limit: 100_000 })).map((a) => ({
      approval_id: a.approval_id, tenant_id: a.tenant_id, surface: a.surface, host: nul(a.host), object_id: a.object_id, setting_path: a.setting_path,
      value_hash: a.value_hash, approved_at: a.approved_at, approved_by: nul(a.approved_by), note: nul(a.note),
    }));
  }

  async insertApproved(rows: readonly ApprovedSetting[]): Promise<number> {
    return this.engine.insertRows("approved_setting", rows);
  }
}

/** sha256 of a file's text as git stores it (LF). */
const textSha256 = (text: string): string => `sha256:${createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex")}`;

/** Sample mode over one bundle: sql.js in memory, the bundle and the file tables loaded, the lessons of `memoryDir` read only. */
export async function sampleBackend(o: { tenant: string; bundle: Record<string, unknown>; bundlePath: string; memoryDir: string; write: boolean; policyFile?: string }): Promise<Backend> {
  const engine = await SqlJsEngine.create();
  engine.loadBundle(o.bundle);
  engine.loadFileTables(fileRows({ memoryDir: o.memoryDir, policyFile: o.policyFile ?? config.policyFile, redactor: BUNDLE_REDACTOR }));
  const counting = new CountingEngine(engine);
  const layer = new DataLayer(counting);
  const lessons = new TechnicianMemory({ storage: "read", directory: o.memoryDir }).lessons().map((l) => l.recordedAt);
  let sha = "";
  try { sha = textSha256(readFileSync(o.bundlePath, "utf8")); } catch { sha = textSha256(JSON.stringify(o.bundle)); }
  return {
    mode: "sample", tenant: o.tenant, layer, counting, engine, redactor: BUNDLE_REDACTOR, windows: new MemoryWindows(engine), approvals: new LayerApprovals(layer, engine),
    ledger: new MemoryLedger(engine), vault: null, memoryDir: o.memoryDir, memoryWritable: o.write,
    source: `sql.js over ${o.bundlePath.replace(/\\/g, "/")}`, bundle: { path: o.bundlePath.replace(/\\/g, "/"), sha256: sha },
    sampleInstant: new Date(decisionInstantWith(o.bundle, lessons) ?? Date.now()).toISOString(),
    close: async () => engine.close(),
  };
}

/** Why live mode cannot start, as one sentence; null when it can. */
export function liveRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!config.redactSalt) return "REDACT_SALT is blank: the console's rows carry the tenant's pseudonyms under its salt";
  if (!env.DATABASE_URL) return "DATABASE_URL is blank: the console writes change windows and approvals to the app Postgres";
  if (!config.zetaris.apiKey) return "ZETARIS_API_KEY is blank: the console reads through Zetaris";
  return null;
}

/**
 * Live mode, at start: what the console and the passes need that Zetaris does not read yet, each as a phrase. The
 * change_window table SHOW DATASOURCE TABLES lists (a listing that fails names nothing: the pages say why the windows
 * were not read), and disposition.window_id, one zero-row read. Empty when both are there; npm run zetaris:setup
 * registers the one and refreshes the other.
 */
export async function zetarisGaps(b: Pick<Backend, "counting" | "layer">, datasource: string = config.zetaris.datasource): Promise<string[]> {
  const gaps: string[] = [];
  if ((await datasourceLists(b.counting, "change_window", { agent: "console", datasource })) === false) gaps.push(`the change_window table in ${datasource}`);
  try {
    await b.layer.run("SELECT window_id FROM {{t:disposition}} WHERE disposition_id = ''", {}, { agent: "console", limit: 1 });
  } catch {
    gaps.push(`the window_id column of ${datasource}.disposition`);
  }
  return gaps;
}

/** Live mode: the Store on DATABASE_URL (the schema applied, so change_window exists), the layer over Zetaris, the tenant's redactor, the vault at DRIFT_VAULT_DIR. */
export async function liveBackend(o: { tenant: string }): Promise<Backend> {
  const refused = liveRefusal();
  if (refused) throw new Error(refused);
  const store = Store.fromEnv();
  await store.applySchema();
  const redactor = new Redactor(config.redactSalt, config.redactWords);
  const counting = new CountingEngine(new ZetarisEngine());
  return {
    mode: "live", tenant: o.tenant, layer: new DataLayer(counting), counting, engine: null, redactor, windows: new PgWindows(store), approvals: store,
    ledger: null, vault: Vault.fromEnv({ redactor }), memoryDir: config.memoryDir, memoryWritable: true,
    source: `Zetaris over the ${config.zetaris.datasource} datasource`, bundle: null, sampleInstant: null,
    refreshFiles: () => refreshFileTables(), close: () => store.close(),
  };
}

// ---- the snapshot -------------------------------------------------------------------------------------------

export interface Snapshot {
  readAt: string;
  doc: DocumentResult;
  /** The latest passing run of each surface and host the findings come from (no probe and no audit surface). */
  latest: Row[];
  /** Their observations. */
  observations: Row[];
  /** The records of the latest passing DNS run. */
  records: Row[];
  approvals: Row[];
  windows: ChangeWindow[];
  /** The tenant's window HOLDs, disposition_id to window_id (the disposition column src/policy/decide.ts step 3 sets). */
  windowHolds: Map<string, string>;
  /** Why the windows or the window HOLDs were not read (a store whose schema predates change_window, a datasource that does not list it); null when they were. */
  windowsError: string | null;
  /** The tenant's dispositions, every pass. */
  dispositions: Row[];
  /** Per host: what a restore from its newest backup would regress. */
  regress: Map<string, { explanation: string; rows: Row[] }>;
  /** Per object whose live value differs from its approval: the vault copies of the approved value with their latest validation (APPROVED_COPIES_SQL). */
  approvedCopies: Map<string, Row[]>;
  queries: QueryTally;
  ms: number;
}

const RECORDS_OF_RUN_SQL = `SELECT record_id, zone, name, type, content, ttl, proxied
FROM {{t:dns_record}}
WHERE run_id = {{p:run_id}}
ORDER BY zone, name, record_id`;

const VAULT_COPY_OF_SQL = `SELECT copy_id, git_commit, taken_at
FROM {{t:vault_copy}}
WHERE tenant_id = {{p:tenant_id}} AND run_id = {{p:run_id}} AND object_id = {{p:object_id}}
ORDER BY copy_id`;

/** The vault commit that holds an object's copy from one run; null when the vault holds none. */
export async function vaultCommitOf(layer: DataLayer, tenant: string, runId: string, objectId: string): Promise<string | null> {
  return objects(await layer.run(VAULT_COPY_OF_SQL, { tenant_id: tenant, run_id: runId, object_id: objectId }, { agent: "console", limit: 10 }))[0]?.git_commit ?? null;
}

const WINDOW_HOLDS_SQL = `SELECT disposition_id, window_id
FROM {{t:disposition}}
WHERE tenant_id = {{p:tenant_id}} AND window_id IS NOT NULL
ORDER BY disposition_id`;

const windowOf = (w: Row): ChangeWindow => ({
  window_id: w.window_id, tenant_id: w.tenant_id, surface: w.surface, host: nul(w.host), object_id: w.object_id, setting_path: w.setting_path,
  opened_by: w.opened_by, opened_at: w.opened_at, until: w.until, reason: w.reason, closed_at: nul(w.closed_at),
});

/** The surfaces whose objects the Settings page lists: the ones a window can be declared on. */
const OBJECT_SURFACES = (s: string): boolean => WINDOW_SURFACES.includes(s);

export async function readSnapshot(b: Backend, classes: ReadonlyMap<string, string>): Promise<Snapshot> {
  const t0 = Date.now();
  const before = b.counting.tally();
  const q = { agent: "console", limit: 100_000 };
  const doc = await renderDocument(b.layer, { tenant: b.tenant, classes, source: b.source, report: true });
  const latestBy = new Map<string, Row>();
  const passing = new Set(doc.data.runs.filter((r) => r.passes).map((r) => r.run_id));
  const runs = objects(await b.layer.run(RUNS_SQL, {}, q)).filter((r) => r.tenant_id === b.tenant && passing.has(r.run_id) && OBJECT_SURFACES(r.surface));
  for (const r of runs) latestBy.set(`${r.surface}\u001f${r.host}`, r);
  const latest = [...latestBy.values()].sort((a, c) => cmp(a.surface, c.surface) || cmp(a.host, c.host));
  const dns = latest.find((r) => r.surface === "cloudflare.dns");
  const hosts = [...new Set(latest.filter((r) => r.host).map((r) => r.host))];
  let windowsError: string | null = null;
  let holdsError: string | null = null;
  const [observations, records, approvals, windows, windowHolds, dispositions, regress] = await Promise.all([
    Promise.all(latest.map(async (r) => objects(await b.layer.run(OBSERVATIONS_SQL, { run_id: r.run_id }, q)))).then((xs) => xs.flat()),
    dns ? b.layer.run(RECORDS_OF_RUN_SQL, { run_id: dns.run_id }, q).then(objects) : Promise.resolve([] as Row[]),
    b.layer.run(LATEST_APPROVALS_SQL, { tenant_id: b.tenant }, q).then(objects),
    b.layer.run(CHANGE_WINDOWS_SQL, { tenant_id: b.tenant }, q).then((r) => objects(r).map(windowOf)).catch((e: Error) => { windowsError = e.message; return [] as ChangeWindow[]; }),
    b.layer.run(WINDOW_HOLDS_SQL, { tenant_id: b.tenant }, q).then((r) => new Map(objects(r).map((d) => [d.disposition_id, d.window_id] as const)))
      .catch((e: Error) => { holdsError = e.message; return new Map<string, string>(); }),
    b.layer.run(DISPOSITIONS_SQL, {}, q).then((r) => objects(r).filter((d) => d.tenant_id === b.tenant)),
    Promise.all(hosts.map(async (host) => {
      const r = await runCheck(b.layer, "restore_would_regress", { tenant_id: b.tenant, host }, q);
      return [host, { explanation: r.explanation, rows: objects(r.result) }] as const;
    })).then((xs) => new Map(xs)),
  ]);
  // the restore proof of a drifted object: the copies that hold its approved value, not the live one at the vault's head
  const liveHash = new Map(observations.map((o) => [`${objectKey(o.surface, nul(o.host), o.object_id)}\u001f${o.setting_path}`, o.value_hash]));
  const drifted = approvals.filter((a) => (a.setting_path === "file" || (a.surface === "cloudflare.dns" && a.setting_path === "content"))
    && liveHash.get(`${objectKey(a.surface, nul(a.host), a.object_id)}\u001f${a.setting_path}`) !== a.value_hash);
  const approvedCopies = new Map(await Promise.all(drifted.map(async (a) => [
    objectKey(a.surface, nul(a.host), a.object_id),
    objects(await b.layer.run(APPROVED_COPIES_SQL, { tenant_id: b.tenant, surface: a.surface, host: a.host ?? "", object_id: a.object_id, setting_path: a.setting_path, approved_hash: a.value_hash }, q)),
  ] as const)));
  const after = b.counting.tally();
  return {
    readAt: new Date().toISOString(), doc, latest, observations, records, approvals, windows, windowHolds, windowsError: windowsError ?? holdsError, dispositions, regress, approvedCopies,
    queries: { queries: after.queries - before.queries, rows: after.rows - before.rows, failed: after.failed - before.failed, ms: after.ms - before.ms }, ms: Date.now() - t0,
  };
}

// ---- passes -------------------------------------------------------------------------------------------------

export interface PassRun {
  step: PassStep;
  explained: ExplainResult;
  decidedAt: string;
  ms: number;
  queries: QueryTally;
  trace: { id: string; file: string } | null;
  /** Whether the pass recorded its dispositions (sample mode) or is a dry pass (live). */
  recorded: boolean;
  startedAt: string;
}

/** One pass over the backend's layer for its tenant, then the explain step over it; never act. */
export async function runConsolePass(b: Backend, o: { decidedAt: string; trace?: boolean; memory?: TechnicianMemory }): Promise<PassRun> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const tracer = o.trace === false ? undefined : new FileTracer(`${b.mode === "sample" ? "console_sample" : "console_pass"}_${Date.now().toString(36)}`, { model: "none" });
  const before = b.counting.tally();
  const memory = o.memory ?? new TechnicianMemory({ storage: "read", directory: b.memoryDir });
  // the tenant the trace is of, as a cycle's step lines name theirs: the Traces page lists a tenant's traces by it
  tracer?.emit({ agent: "loop", action: "triage", status: "ok", input_summary: `console pass ${b.tenant}`, output_summary: `${b.mode === "sample" ? "pass" : "dry pass"} decided at ${o.decidedAt}` });
  const step = await passStep(b.layer, { tenant: b.tenant, ledger: b.ledger, memory, decidedAt: o.decidedAt, tracer: tracer as Tracer | undefined, world: new DriftWorld("console"), refreshFiles: b.refreshFiles });
  const explained = await explainPass({ tenant: b.tenant, decidedAt: step.decidedAt, findings: step.findings }, {
    layer: b.layer, vault: b.vault, redactor: b.redactor, sink: b.engine ? new MemoryCauseSink(b.engine) : null, tracer,
  });
  const after = b.counting.tally();
  return {
    step, explained, decidedAt: step.decidedAt, ms: Date.now() - t0, startedAt, recorded: b.ledger !== null,
    queries: { queries: after.queries - before.queries, rows: after.rows - before.rows, failed: after.failed - before.failed, ms: after.ms - before.ms },
    trace: tracer ? { id: tracer.traceId, file: path.relative(process.cwd(), tracer.logFile).replace(/\\/g, "/") } : null,
  };
}

// ---- decisions and objects ----------------------------------------------------------------------------------

/** One current decision on one finding, from the console's pass or from the ledger. */
export interface Decision {
  finding_id: string;
  disposition_id: string;
  class: string;
  verb: Verb;
  reason: string;
  expires_at: string | null;
  decided_by: string;
  rule_id: string | null;
  /** The change window whose HOLD this is; null on every other decision. */
  window_id: string | null;
  decided_at: string;
  surface: string;
  host: string | null;
  object_id: string;
  setting_path: string;
  value_hash: string;
  /** The finding as the pass raised it; absent for a ledger row. */
  finding?: Finding;
}

export function decisionsOfPass(p: PassRun): Decision[] {
  return p.step.findings.map((f) => ({
    finding_id: f.id, disposition_id: dispositionIdOf(f, p.decidedAt), class: f.finding.class, verb: f.verb, reason: f.disposition.reason,
    expires_at: f.disposition.expires_at, decided_by: f.disposition.decided_by, rule_id: f.disposition.rule_id, window_id: f.disposition.window_id ?? null, decided_at: p.decidedAt,
    surface: f.finding.surface, host: f.finding.host, object_id: f.finding.object_id, setting_path: f.finding.setting_path, value_hash: f.finding.value_hash, finding: f,
  }));
}

/** The ledger's open dispositions as decisions, each window HOLD known by the snapshot's windowHolds. */
export function decisionsOfLedger(open: readonly OpenDisposition[], windowHolds: ReadonlyMap<string, string> = new Map()): Decision[] {
  return open.map((d) => ({
    finding_id: d.finding_id, disposition_id: d.disposition_id, class: d.class, verb: d.verb as Verb, reason: d.reason, expires_at: nul(d.expires_at),
    decided_by: d.decided_by, rule_id: nul(d.rule_id), window_id: windowHolds.get(d.disposition_id) ?? null, decided_at: d.decided_at, surface: d.surface, host: nul(d.host), object_id: d.object_id,
    setting_path: d.setting_path, value_hash: d.value_hash,
  }));
}

export type Status = "in order" | "drifted" | "held" | "with a technician" | "adopted";
export const STATUSES: readonly Status[] = ["with a technician", "drifted", "held", "adopted", "in order"];
const STATUS_OF: Readonly<Record<Verb, Status>> = { ESCALATE: "with a technician", FIX: "with a technician", ROLLBACK: "drifted", HOLD: "held", ADOPT: "adopted" };
export type Lock = "locked" | "open" | "window";

export interface SettingObject {
  /** surface, host and object, one string: the form's key. */
  key: string;
  kind: "file" | "record";
  surface: string;
  host: string | null;
  object_id: string;
  /** The host a file is on, or the zone a record is in. */
  group: string;
  /** A file's path; a record's name. */
  name: string;
  /** The setting the lock, the approval and the template are read for: file, or a record's content. */
  main: string;
  live: { hash: string | null; text: string; absent: boolean };
  approved: { value_hash: string; approved_at: string; approved_by: string } | null;
  /** Some approved setting of the object differs from its live value, or is absent from the run. */
  differs: boolean;
  rule: PolicyRule | null;
  lock: Lock;
  window: ChangeWindow | null;
  windows: ChangeWindow[];
  decisions: Decision[];
  status: Status;
  cause: FindingCause | null;
  copies: Row[];
  /** The object's settings that name something else: setting, type, id, and what a DNS name resolves to in the latest DNS run. */
  references: { setting: string; type: string; id: string; resolves: string[] }[];
  actions: Action[];
  /** The run the live state comes from. */
  run_id: string | null;
}

export const objectKey = (surface: string, host: string | null, objectId: string): string => [surface, surface === "cloudflare.dns" ? "" : (host ?? ""), objectId].join("\u001f");

export function settingObjects(s: Snapshot, decisions: readonly Decision[], causes: ReadonlyMap<string, FindingCause>, tenant: string, now: string): SettingObject[] {
  const rules = s.doc.data.rules;
  const approvalsBy = new Map<string, Row[]>();
  for (const a of s.approvals) {
    const k = objectKey(a.surface, nul(a.host), a.object_id);
    approvalsBy.set(k, [...(approvalsBy.get(k) ?? []), a]);
  }
  const obsBy = new Map<string, Row[]>();
  for (const o of s.observations) {
    const k = objectKey(o.surface, nul(o.host), o.object_id);
    obsBy.set(k, [...(obsBy.get(k) ?? []), o]);
  }
  const decisionsBy = new Map<string, Decision[]>();
  for (const d of decisions) {
    const k = objectKey(d.surface, d.host, d.object_id);
    decisionsBy.set(k, [...(decisionsBy.get(k) ?? []), d]);
  }
  const recordOf = new Map(s.records.map((r) => [r.record_id, r]));
  const objectOfDisposition = new Map(s.dispositions.map((d) => [d.disposition_id, objectKey(d.surface, nul(d.host), d.object_id)]));
  const actionsBy = new Map<string, Action[]>();
  for (const a of (s.doc.data.actions ?? []).map(actionOf)) {
    const k = objectOfDisposition.get(a.disposition_id);
    if (k) actionsBy.set(k, [...(actionsBy.get(k) ?? []), a]);
  }
  const copiesBy = new Map<string, Row[]>();
  for (const c of s.doc.data.copies) {
    const k = objectKey(c.surface, nul(c.host), c.object_id);
    copiesBy.set(k, [...(copiesBy.get(k) ?? []), c]);
  }

  // every file object of a host run and every record of the DNS run, then an object a decision names that no run holds
  const keys = new Map<string, { surface: string; host: string | null; object_id: string; kind: "file" | "record" }>();
  for (const o of s.observations) {
    if (o.surface === "cloudflare.dns") keys.set(objectKey(o.surface, null, o.object_id), { surface: o.surface, host: null, object_id: o.object_id, kind: "record" });
    else if (o.setting_path === "file") keys.set(objectKey(o.surface, nul(o.host), o.object_id), { surface: o.surface, host: nul(o.host), object_id: o.object_id, kind: "file" });
  }
  for (const d of decisions) {
    const k = objectKey(d.surface, d.host, d.object_id);
    if (!keys.has(k)) keys.set(k, { surface: d.surface, host: d.surface === "cloudflare.dns" ? null : d.host, object_id: d.object_id, kind: d.surface === "cloudflare.dns" ? "record" : "file" });
  }

  const out: SettingObject[] = [];
  for (const [key, o] of keys) {
    const obs = obsBy.get(key) ?? [];
    const field = (p: string): Row | undefined => obs.find((x) => x.setting_path === p);
    const record = o.kind === "record" ? recordOf.get(o.object_id) : undefined;
    const main = o.kind === "file" ? "file" : "content";
    const mainObs = field(main);
    const approvals = approvalsBy.get(key) ?? [];
    const mainApproval = approvals.find((a) => a.setting_path === main) ?? null;
    const differs = approvals.some((a) => field(a.setting_path)?.value_hash !== a.value_hash);
    const rule = resolvePolicy(rules, { tenant_id: tenant, surface: o.surface, object_id: o.object_id, setting_path: main });
    const windows = s.windows.filter((w) => objectKey(w.surface, w.host, w.object_id) === key);
    const window = openWindow(windows, { tenant_id: tenant, surface: o.surface, host: o.host, object_id: o.object_id, setting_path: main }, now);
    const mine = decisionsBy.get(key) ?? [];
    const status = STATUSES.find((st) => mine.some((d) => STATUS_OF[d.verb] === st)) ?? "in order";
    const withCause = mine.map((d) => causes.get(d.disposition_id)).filter((c): c is FindingCause => Boolean(c));
    const fieldText = (p: string): string => field(p)?.value_redacted ?? "";
    const live = o.kind === "file"
      ? { hash: mainObs?.value_hash ?? null, text: mainObs ? mainObs.value_hash.replace(/^sha256:/, "").slice(0, 12) : "absent", absent: !mainObs }
      : { hash: mainObs?.value_hash ?? null, text: obs.length ? [fieldText("type"), fieldText("content"), fieldText("proxied") === "1" ? "proxied" : fieldText("proxied") === "0" ? "direct" : ""].filter(Boolean).join(" ") : "absent", absent: !obs.length };
    const references = obs.filter((x) => x.refers_to_type && x.refers_to_id && x.setting_path !== "file").map((x) => ({
      setting: x.setting_path, type: x.refers_to_type, id: x.refers_to_id,
      resolves: x.refers_to_type === "dns_name" ? s.records.filter((r) => r.name === x.refers_to_id).map((r) => `${r.type} ${r.content}${r.proxied === "1" ? " proxied" : ""}`) : [],
    }));
    out.push({
      key, kind: o.kind, surface: o.surface, host: o.host, object_id: o.object_id,
      group: o.kind === "file" ? (o.host ?? "-") : `zone ${record?.zone || "unknown"}`,
      name: o.kind === "file" ? o.object_id : (record ? `${record.name} (${record.type})` : fieldText("name") || o.object_id),
      main, live, approved: mainApproval ? { value_hash: mainApproval.value_hash, approved_at: mainApproval.approved_at, approved_by: mainApproval.approved_by } : null,
      differs: differs || (live.absent && approvals.length > 0), rule, lock: window ? "window" : rule?.lock === 1 ? "locked" : "open", window, windows, decisions: mine, status,
      cause: withCause.at(-1) ?? null, copies: s.approvedCopies.get(key) ?? copiesBy.get(key) ?? [], references, actions: (actionsBy.get(key) ?? []).sort((a, c) => cmp(c.started_at, a.started_at)),
      run_id: mainObs?.run_id ?? obs[0]?.run_id ?? null,
    });
  }
  return out.sort((a, c) => cmp(a.kind === "file" ? "0" : "1", c.kind === "file" ? "0" : "1") || cmp(a.group, c.group) || cmp(a.name, c.name));
}

/** The class a finding id carries in the console's pass, for the document's classes map. */
export const classesOf = (p: PassRun | null): Map<string, FindingClass> => new Map((p?.step.findings ?? []).map((f) => [f.id, f.finding.class]));

export const NO_TALLY = NO_QUERIES;
