// Zetaris's control plane as a collected surface, zetaris.control: the layer ConfigLeaf reads through, assured the way
// it assures a host. One collection run per tenant reads the semantic layer's model, its DQ rules, the grants, the
// datasources and the server version with read-only statements, turns each object into one observation of its
// canonical JSON, and stores the run with its population asserted, so run_complete gates it like any other run and
// drift_vs_approved compares each object with its latest approval (src/pipeline.ts, unchanged).
//
// Contract:
//   - Statements (CONTROL_STATEMENTS), one per call, in this order: SHOW NAMESPACES OR TABLES IN the USL (the entity
//     listing, the population the model must hold), LOAD USL (the model as JSON), LIST DQ USL (the rules and the key
//     constraints), SHOW GRANT ON ALL, SHOW DATASOURCES, SHOW LIGHTNING DATABASES, SHOW SERVER VERSION. SHOW GRANT needs
//     an administrator or Access Control Read: when it fails, the grants are not_checked with the error as the reason,
//     left out of the population, and the run goes on. Any other statement that fails makes the run failed, with no
//     population asserted, so the DQ gate refuses it and the pass decides nothing on the surface. A stored run keeps no
//     reason; notCheckedIn reads a not_checked statement back from the run's observations (its index object, grants,
//     is absent), and npm run approve -- --surface zetaris.control warns with notCheckedWarnings.
//   - Objects (controlObjects), each { id, value } with the raw id:
//       usl/<usl>             the USL's name, namespace and entity names, sorted
//       usl/<usl>/<entity>    one entity as LOAD USL reports it (columns with types and keys, unique, foreign keys,
//                             checks, access-control annotations, the activation query), its table-level DQ
//                             annotations left out: dq/<rule> holds each rule
//       dq/<rule>             one custom rule of LIST DQ USL: name, table, type, expression (dq/<table>.<rule> when two
//                             tables carry a rule of one name); the key constraints are the entities' own
//       grants                every principal SHOW GRANT lists, as "<type> <name>", sorted
//       grant/<principal>     one principal's grants: its type and each grant's canonical identifier, privilege,
//                             grant option and grantor, sorted; the grant time is left out (a re-grant of the same
//                             privilege changes no access)
//       datasources           every datasource and Lightning database name, sorted
//       datasource/<name>     one datasource (kind jdbc) or Lightning database (kind lightning): name, description, id
//       server/version        version, build target, time, tag and hash
//   - Population: expected = the entity listing's count plus one (the usl object), plus LIST DQ's custom rules as the
//     server counts them (total), plus the principals and one when the grants were read, plus the datasources and the
//     Lightning databases as the server counts them, plus one (datasources), plus one (server/version). observed = the
//     objects built. A listed entity the model lacks, or a listing the request limit cut, leaves observed below
//     expected and the run partial.
//   - Canonical JSON (canonical): keys sorted at every depth, two-space indent, a trailing newline; arrays keep the
//     order the normaliser gives them (each sorted where the source order means nothing).
//   - Rows (controlRows): host CONTROL_HOST ("zetaris", the instance), so the pass groups the run as it groups a
//     host's; one observation per object, setting_path "definition", value_hash sha256:<hex> of the raw canonical
//     JSON (the vault's blob hash, as for a host's file), value_redacted the canonical JSON through Redactor.value,
//     object_id the raw id through Redactor.text, source "zetaris", authority live. The vault files are the raw
//     canonical JSON at <raw id>.json in the tenant's ZETARIS_REPO.
//
// Measured on Zetaris 2.4.3.1, 26 Oct 2026 with the setup's admin key: SHOW SERVER VERSION returns version |
// build_target | build_time | build_tag | build_hash; SHOW DATASOURCES name | description | id (DRIFT); SHOW LIGHTNING
// DATABASES name | description | id (CLOUDFLARE, LESSONS, rules); LIST DQ USL name | table | type | expression, 30 rows,
// the six custom rules typed "Custom Data Quality" beside the key constraints; SHOW GRANT ON ALL identifier |
// principal_name | principal_type | privilege | grant_option | grant_at | grant_by | canonical_identifier, 9 rows; LOAD
// USL one row, one column json, 33,437 characters, every table carrying name, columnSpecs, unique, foreignKeys, checks,
// ifNotExit, namespace, dqAnnotations, acAnnotations and activateQuery.

import { createHash } from "node:crypto";
import type { QueryResult } from "../adapters/zetaris.ts";
import { redact } from "../config.ts";
import { AUTHORITY, obsId, runId, type CollectionRun, type Observation, type RunStatus } from "../data/rows.ts";
import type { RunStart } from "../data/store.ts";
import type { Redactor } from "../redactor.ts";
import type { Tracer } from "../trace.ts";
import { vaultZetarisRun, type CopyStore, type HookResult } from "../vault/hook.ts";
import type { Vault, VaultFile } from "../vault/vault.ts";
import { NAMESPACE, USL, USL_NAME } from "./setup.ts";

export const CONTROL_SURFACE = "zetaris.control";
/** The collection_run host of the surface: the Zetaris instance, so the pass groups the run as it groups a host's. */
export const CONTROL_HOST = "zetaris";
export const CONTROL_SETTING = "definition";
export const CONTROL_SOURCE = "zetaris";

export const CONTROL_STATEMENTS = {
  entities: `SHOW NAMESPACES OR TABLES IN ${USL}`,
  usl: `LOAD USL ${USL_NAME} NAMESPACE ${NAMESPACE}`,
  dq: `LIST DQ USL ${USL}`,
  grants: "SHOW GRANT ON ALL",
  datasources: "SHOW DATASOURCES",
  lightning: "SHOW LIGHTNING DATABASES",
  version: "SHOW SERVER VERSION",
} as const;
export type ControlStatement = keyof typeof CONTROL_STATEMENTS;
export const CONTROL_ORDER = Object.keys(CONTROL_STATEMENTS) as ControlStatement[];
/** The statement whose failure is not_checked; any other failing fails the run. */
export const OPTIONAL_STATEMENTS: readonly ControlStatement[] = ["grants"];
/**
 * The object each optional statement gives whenever it runs, its listing (grants, even with no principal): a complete
 * run whose observations lack it did not check the statement, the one record of a not_checked statement the Store keeps.
 */
export const STATEMENT_INDEX: Readonly<Partial<Record<ControlStatement, string>>> = { grants: "grants" };

/** The optional statements a stored zetaris.control run did not check: those whose index object (redacted as the rows carry it) its observations lack. */
export function notCheckedIn(objectIds: Iterable<string>, redactor: Pick<Redactor, "text">): ControlStatement[] {
  const ids = new Set(objectIds);
  return OPTIONAL_STATEMENTS.filter((s) => !ids.has(redactor.text(STATEMENT_INDEX[s] ?? s)));
}

/** What npm run approve -- --surface zetaris.control prints for each statement its source run did not check. */
export function notCheckedWarnings(runId: string, statements: readonly ControlStatement[]): string[] {
  return statements.map((s) => `approve: warning: ${runId} did not check ${CONTROL_STATEMENTS[s]} (refused or not run): this sign-off approves no ${s}, the ${s} approved before stay the latest approvals, and the pass escalates each of them as approved_missing`);
}
/** The rows a statement may return in one call; a listing the server counts beyond it leaves the run partial. */
export const CONTROL_LIMIT = 1000;

export type ControlAnswer = QueryResult | { error: string };
export type ControlRead = Partial<Record<ControlStatement, ControlAnswer>>;

export interface ControlObject { id: string; value: unknown }

export interface ControlSnapshot {
  objects: ControlObject[];
  /** null when a required statement failed: no population is asserted. */
  expected: number | null;
  /** The statements not checked and why (SHOW GRANT refused). */
  notChecked: { statement: ControlStatement; reason: string }[];
  /** The required statements that failed. */
  failed: { statement: ControlStatement; reason: string }[];
}

const isError = (a: ControlAnswer | undefined): a is { error: string } => a !== undefined && "error" in a;
const col = (r: QueryResult, name: string): number => r.columns.findIndex((c) => c.toLowerCase() === name);
const cell = (r: QueryResult, row: readonly string[], name: string): string => {
  const i = col(r, name);
  return i >= 0 ? row[i] ?? "" : "";
};
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every key sorted, at every depth; undefined values dropped. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => byText(a, b)).map(([k, x]) => [k, sortKeys(x)]));
  }
  return v;
}

/** The canonical JSON of a value: keys sorted at every depth, two-space indent, a trailing newline. */
export function canonical(v: unknown): string {
  return `${JSON.stringify(sortKeys(v), null, 2)}\n`;
}

export const sha256 = (s: string | Uint8Array): string => `sha256:${createHash("sha256").update(s).digest("hex")}`;

/** Run each statement once, in order; a failure is kept as its message (the caller's redaction applies), never thrown. */
export async function readControl(client: { query(sql: string, o?: { limit?: number; tracer?: Tracer; agent?: string; timeoutMs?: number }): Promise<QueryResult> }, opts: { tracer?: Tracer; agent?: string } = {}): Promise<ControlRead> {
  const out: ControlRead = {};
  for (const k of CONTROL_ORDER) {
    try {
      out[k] = await client.query(CONTROL_STATEMENTS[k], { limit: CONTROL_LIMIT, tracer: opts.tracer, agent: opts.agent ?? "collector", timeoutMs: 120_000 });
    } catch (e) {
      out[k] = { error: ((e as Error).message ?? String(e)).slice(0, 300) };
    }
  }
  return out;
}

/** The entity spec as an object of the surface: the table as LOAD USL reports it, its table-level DQ annotations left out. */
function entityValue(t: Record<string, unknown>): unknown {
  const { dqAnnotations: _dq, ifNotExit: _ine, ...rest } = t;
  return rest;
}

/** The objects of one read and the population it asserts (see the header). Pure. */
export function controlObjects(read: ControlRead): ControlSnapshot {
  const objects: ControlObject[] = [];
  const notChecked: ControlSnapshot["notChecked"] = [];
  const failed: ControlSnapshot["failed"] = [];
  for (const k of CONTROL_ORDER) {
    const a = read[k];
    const reason = a === undefined ? "not run" : isError(a) ? a.error : null;
    if (reason === null) continue;
    (OPTIONAL_STATEMENTS.includes(k) ? notChecked : failed).push({ statement: k, reason });
  }
  let expected = 0;

  // The semantic layer: the listing asserts the entities, the model gives them.
  const listing = read.entities;
  const usl = read.usl;
  if (!isError(listing) && listing && !isError(usl) && usl) {
    const n = col(listing, "name");
    const t = col(listing, "type");
    const listed = listing.rows.filter((r) => t < 0 || (r[t] ?? "").toLowerCase() === "table").map((r) => r[n >= 0 ? n : 0]);
    expected += listed.length + 1 + (listing.total - listing.rowCount);
    let model: { name?: unknown; namespace?: unknown; tables?: Record<string, unknown>[] } = {};
    try {
      model = JSON.parse(usl.rows[0]?.[0] ?? "");
    } catch {
      failed.push({ statement: "usl", reason: "LOAD USL returned no model that parses" });
    }
    const tables = (model.tables ?? []).filter((x) => listed.includes(String(x.name)));
    const name = String(model.name ?? USL_NAME);
    if (model.tables) {
      objects.push({ id: `usl/${name}`, value: { name, namespace: model.namespace ?? null, tables: (model.tables ?? []).map((x) => String(x.name)).sort(byText) } });
      for (const x of [...tables].sort((a, b) => byText(String(a.name), String(b.name)))) objects.push({ id: `usl/${name}/${String(x.name)}`, value: entityValue(x) });
    }
  }

  // The DQ rules: the custom ones; the key constraints are the entities' own.
  const dq = read.dq;
  if (!isError(dq) && dq) {
    const custom = dq.rows.filter((r) => cell(dq, r, "type") === "Custom Data Quality");
    expected += custom.length + (dq.total - dq.rowCount);
    const names = custom.map((r) => cell(dq, r, "name"));
    for (const r of custom) {
      const name = cell(dq, r, "name");
      const table = cell(dq, r, "table");
      const id = names.filter((x) => x === name).length > 1 ? `dq/${table}.${name}` : `dq/${name}`;
      objects.push({ id, value: { name, table, type: cell(dq, r, "type"), expression: cell(dq, r, "expression") } });
    }
  }

  // The grants, by principal.
  const g = read.grants;
  if (!isError(g) && g) {
    const by = new Map<string, { type: string; privileges: Record<string, string>[] }>();
    for (const r of g.rows) {
      const p = cell(g, r, "principal_name");
      const e = by.get(p) ?? { type: cell(g, r, "principal_type"), privileges: [] };
      e.privileges.push({ identifier: cell(g, r, "canonical_identifier") || cell(g, r, "identifier"), privilege: cell(g, r, "privilege"), grant_option: cell(g, r, "grant_option"), grant_by: cell(g, r, "grant_by") });
      by.set(p, e);
    }
    const principals = [...by.keys()].sort(byText);
    expected += principals.length + 1 + (g.total - g.rowCount);
    objects.push({ id: "grants", value: { principals: principals.map((p) => `${by.get(p)!.type} ${p}`) } });
    for (const p of principals) {
      const e = by.get(p)!;
      const key = (x: Record<string, string>): string => [x.identifier, x.privilege, x.grant_option, x.grant_by].join("\u001f");
      objects.push({ id: `grant/${p}`, value: { principal: p, type: e.type, privileges: [...e.privileges].sort((a, b) => byText(key(a), key(b))) } });
    }
  }

  // The datasources and the Lightning databases.
  const ds = read.datasources;
  const lt = read.lightning;
  if (!isError(ds) && ds && !isError(lt) && lt) {
    const rows = [
      ...ds.rows.map((r) => ({ kind: "jdbc", name: cell(ds, r, "name"), description: cell(ds, r, "description"), id: cell(ds, r, "id") })),
      ...lt.rows.map((r) => ({ kind: "lightning", name: cell(lt, r, "name"), description: cell(lt, r, "description"), id: cell(lt, r, "id") })),
    ].sort((a, b) => byText(a.name, b.name));
    expected += ds.total + lt.total + 1;
    objects.push({ id: "datasources", value: { names: rows.map((r) => r.name) } });
    for (const r of rows) objects.push({ id: `datasource/${r.name}`, value: r });
  }

  // The server.
  const v = read.version;
  if (!isError(v) && v && v.rows[0]) {
    expected += 1;
    const r = v.rows[0];
    objects.push({ id: "server/version", value: Object.fromEntries(v.columns.map((c, i) => [c, r[i] ?? ""])) });
  }

  return { objects, expected: failed.length ? null : expected, notChecked, failed };
}

export interface ControlCollection {
  run: CollectionRun;
  observations: Observation[];
  /** The raw canonical JSON of each object, at <raw id>.json, for the vault. */
  files: VaultFile[];
  snapshot: ControlSnapshot;
}

/** The run, its observations and its vault files for one snapshot (see the header). startedAt and finishedAt: ISO 8601 UTC, milliseconds. */
export function controlRows(snapshot: ControlSnapshot, redactor: Redactor, ctx: { tenantId: string; startedAt: string; finishedAt: string }): ControlCollection {
  const run_id = runId(ctx.tenantId, CONTROL_SURFACE, CONTROL_HOST, ctx.startedAt);
  const observations: Observation[] = [];
  const files: VaultFile[] = [];
  for (const o of snapshot.objects) {
    const text = canonical(o.value);
    const object_id = redactor.text(o.id);
    observations.push({
      obs_id: obsId(run_id, object_id, CONTROL_SETTING), run_id, tenant_id: ctx.tenantId, surface: CONTROL_SURFACE, host: CONTROL_HOST,
      object_id, setting_path: CONTROL_SETTING, value_hash: sha256(text), value_redacted: redactor.value(text),
      refers_to_type: null, refers_to_id: null, observed_at: ctx.startedAt, source: CONTROL_SOURCE, authority: AUTHORITY.live,
    });
    files.push({ path: `${o.id}.json`, objectId: object_id, bytes: Buffer.from(text, "utf8") });
  }
  const ids = new Set(observations.map((o) => o.object_id));
  if (ids.size !== observations.length) throw new Error(`zetaris.control: two objects share one redacted id (${observations.length} objects, ${ids.size} ids)`);
  const status: RunStatus = snapshot.expected === null ? "failed" : observations.length >= snapshot.expected ? "complete" : "partial";
  const run: CollectionRun = {
    run_id, tenant_id: ctx.tenantId, surface: CONTROL_SURFACE, host: CONTROL_HOST, started_at: ctx.startedAt, finished_at: ctx.finishedAt,
    expected_count: snapshot.expected, observed_count: observations.length, status,
  };
  return { run, observations, files, snapshot };
}

type Client = Parameters<typeof readControl>[0];

/**
 * One collection: the statements read, the objects built, the rows and the vault files for the tenant. Every failure
 * reason passes the tenant's redactor and config.redact before it is kept. One trace line, agent collector, action
 * observe: ok for a complete run, failed otherwise, the run's line as output.
 */
export async function collectControl(client: Client, redactor: Redactor, opts: { tenantId: string; now?: () => Date; tracer?: Tracer }): Promise<ControlCollection> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const read = await readControl(client, { tracer: opts.tracer, agent: "collector" });
  for (const k of CONTROL_ORDER) {
    const a = read[k];
    if (a && "error" in a) read[k] = { error: redactor.text(redact(a.error)) };
  }
  const c = controlRows(controlObjects(read), redactor, { tenantId: opts.tenantId, startedAt, finishedAt: now().toISOString() });
  opts.tracer?.emit({
    agent: "collector", action: "observe", status: c.run.status === "complete" ? "ok" : "failed",
    input_summary: `${CONTROL_SURFACE} tenant ${opts.tenantId}`, output_summary: controlText(c),
    detail: c.snapshot.notChecked.length ? `not_checked: ${c.snapshot.notChecked.map((x) => `${CONTROL_STATEMENTS[x.statement]} (${x.reason})`).join("; ")}` : undefined,
  });
  return c;
}

/** What storeControl writes through: the Store, live. */
export interface ControlStore extends CopyStore {
  beginRun(run: RunStart): Promise<void>;
  insertObservations(rows: readonly Observation[]): Promise<number>;
  finishRun(runId: string, observedCount: number, status: Exclude<RunStatus, "running">, finishedAt?: string): Promise<void>;
}

/**
 * The run as a host's is stored: beginRun with the population asserted, the observations, finishRun with what was
 * observed (a write that throws finishes the run failed and rethrows), then the vault hook: a complete run is one commit
 * in <DRIFT_VAULT_DIR>/<tenant>/zetaris and its vault_copy rows.
 */
export async function storeControl(c: ControlCollection, store: ControlStore, vault: Vault | null, opts: { redactor: Redactor; tracer?: Tracer }): Promise<{ written: number; hook: HookResult }> {
  const { finished_at: _f, observed_count: _o, status: _s, ...start } = c.run;
  await store.beginRun(start);
  let written: number;
  try {
    written = await store.insertObservations(c.observations);
  } catch (e) {
    await store.finishRun(c.run.run_id, 0, "failed").catch(() => undefined);
    throw e;
  }
  await store.finishRun(c.run.run_id, c.run.observed_count ?? 0, c.run.status === "running" ? "failed" : c.run.status, c.run.finished_at ?? undefined);
  const hook = await vaultZetarisRun(vault, store, c.run, c.files, { redactor: opts.redactor, tracer: opts.tracer });
  return { written, hook };
}

/** The run's one line: "run-… 52/52 complete: usl 16, dq 6, grants 2, datasources 5, server 1; grants not_checked: <why>". */
export function controlText(c: Pick<ControlCollection, "run" | "observations" | "snapshot">, scrub: (s: string) => string = (s) => s): string {
  const kinds = new Map<string, number>();
  for (const o of c.snapshot.objects) {
    const k = o.id.startsWith("grant") ? "grants" : o.id.startsWith("datasource") ? "datasources" : o.id.split("/")[0];
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  const r = c.run;
  return scrub([
    `${r.run_id} ${r.observed_count}/${r.expected_count ?? "?"} ${r.status}: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(", ") || "no object"}`,
    ...c.snapshot.notChecked.map((x) => `${x.statement} not_checked: ${x.reason}`),
    ...c.snapshot.failed.map((x) => `${x.statement} failed: ${x.reason}`),
  ].join("; "));
}
