// Store: the app Postgres the collectors write through (drift-pg, registered in Zetaris as the DRIFT
// datasource, so what lands here is what the live pass reads): 127.0.0.1:15432 from Windows (DATABASE_URL),
// drift-pg:5432 from inside the Zetaris network. Measured 24 Oct 2026: a second apply of sql/schema.sql
// changed nothing.
//
// Contract:
//   - Every collected-text column (rows.ts REDACT: names, paths, values, actors; not ids, hashes,
//     enums, timestamps or setting paths) goes through the Redactor before it is sent. The collectors
//     redact first; this is the choke point, and redacting redacted text is a no-op. A field the pass
//     changes means a collector leaked: the count goes to stderr, never the value.
//   - Every *_at (and policy_rule.since) is the canonical ISO 8601 UTC millisecond form the sql.js
//     loader and the catalogue compare as text; anything else, an unknown column or a non-integer number
//     is refused before the transaction opens.
//   - One transaction per call, parameterised multi-row INSERTs of at most 1000 rows (pg binds 65535).
//   - Re-inserting the same rows is a no-op, not a duplicate and not an error: ON CONFLICT on the primary
//     key; dns_record and backup_item have no key in the DDL, so their existing keys (rows.ts KEYS) are
//     read inside the transaction and skipped. Identical duplicates in one batch collapse; two different
//     rows under one key throw. inventory_asset upserts: a newer observation moves observed_at forward
//     and takes host, kind and source with it (an address re-homed to another host is re-homed here); an
//     older one changes nothing.
//   - beginRun refuses a run_id that exists and finishRun one that is not running: a collector never
//     silently reopens a finished run.
//   - One insert method per table of the design's eight additions (policy_rule, vault_copy,
//     copy_validation, probe, disposition, action, ticket, referent_fingerprint) and of finding_cause
//     (the explain step, src/explain/), each ON CONFLICT DO NOTHING on its key. Reads: latestPassingRun
//     (the gate's definition of passing), observationsOf, dnsRecordsOf, policyRules (the tenant's and
//     every "*" rule), and rowsOf for any table by column equality; every read is one READ ONLY transaction and returns rows in natural-key order. One
//     update: updateTicket, a ticket row's external_id, url, status and action_id by ticket_id with
//     updated_at, the url redacted (the PSA step, src/psa/step.ts); ticketsOf reads one tenant's tickets; actionsOf the
//     actions that carry out a list of dispositions (src/actions/). An action row's target, reason and record go
//     through the redactor, and a record over rows.ts ACTION_RECORD_MAX (4000) characters is refused.
//   - Error text is scrubbed (connection-string password, bearer tokens) before it leaves.
//
// The bundle half (toBundle, formatBundle, writeBundle) is how recorded collections become
// sample/bundle.json: every row's REDACT columns through the Redactor once more, value_redacted over 2 kB nulled, the
// result loaded into sql.js before it is written, and the written text probed for every configured label
// (REDACT_WORDS and EXPORT_DENY_WORDS: redactor.ts countLabels); one match and nothing is written, so a
// bundle the sample loader would refuse, or one that still names the tenant, never lands.

import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { config, redact } from "../config.ts";
import { Redactor, countLabels } from "../redactor.ts";
import { SqlJsEngine } from "./engines/sqljs.ts";
import { SCHEMA_SQL } from "./schema.ts";
import {
  ACTION_RECORD_MAX, COLUMNS, KEYS, REDACT, isTimestampColumn,
  type Action, type ApprovedSetting, type AuditEvent, type BackupItem, type BackupSnapshot, type CollectionRun, type CopyValidation,
  type Disposition, type DnsRecord, type FindingCause, type InventoryAsset, type Observation, type PolicyRule, type Probe, type ReferentFingerprint,
  type Rows, type RunStatus, type TableName, type Ticket, type VaultCopy,
} from "./rows.ts";

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const MAX_ROWS = 1000;
const VALUE_MAX_BYTES = 2048;

export const TABLES = Object.keys(COLUMNS) as TableName[];
export type Tables = { [K in TableName]: Rows[K][] };
export type BundleFile = { _note: string } & Tables;

export class StoreError extends Error {
  constructor(message: string) {
    super(scrub(message));
  }
}

/** A postgres URL's password, then whatever config.redact catches. */
export function scrub(s: string): string {
  return redact(s.replace(/(postgres(?:ql)?:\/\/[^:@\s/]*:)[^@\s]*@/gi, "$1<redacted>@"));
}

function wrap(e: unknown): StoreError {
  if (e instanceof StoreError) return e;
  const code = (e as { code?: string }).code;
  return new StoreError(`postgres${code ? ` ${code}` : ""}: ${(e as Error).message}`);
}

/** Per table; null = no key in the DDL, existing keys are read first and skipped. */
const CONFLICT: { [K in TableName]: string | null } = {
  collection_run: "ON CONFLICT (run_id) DO NOTHING",
  observation: "ON CONFLICT (obs_id) DO NOTHING",
  approved_setting: "ON CONFLICT (approval_id) DO NOTHING",
  backup_snapshot: "ON CONFLICT (snapshot_id) DO NOTHING",
  backup_item: null,
  dns_record: null,
  audit_event: "ON CONFLICT (event_id) DO NOTHING",
  inventory_asset: `ON CONFLICT (asset_id) DO UPDATE SET observed_at = EXCLUDED.observed_at, host = EXCLUDED.host, kind = EXCLUDED.kind, source = EXCLUDED.source WHERE EXCLUDED.observed_at > inventory_asset.observed_at COLLATE "C"`,
  policy_rule: "ON CONFLICT (rule_id) DO NOTHING",
  vault_copy: "ON CONFLICT (copy_id) DO NOTHING",
  copy_validation: "ON CONFLICT (validation_id) DO NOTHING",
  probe: "ON CONFLICT (probe_id) DO NOTHING",
  disposition: "ON CONFLICT (disposition_id) DO NOTHING",
  action: "ON CONFLICT (action_id) DO NOTHING",
  ticket: "ON CONFLICT (ticket_id) DO NOTHING",
  referent_fingerprint: "ON CONFLICT (obs_id, dns_run_id) DO NOTHING",
  finding_cause: "ON CONFLICT (cause_id) DO NOTHING",
};

type Row = Record<string, string | number | null>;

const keyOf = (table: TableName, r: Record<string, unknown>): string => KEYS[table].map((k) => String(r[k])).join("\u001f");

/** Code-unit order on the natural key, so an export is byte-stable whatever the database collation. */
function byKey(table: TableName): (a: Row, b: Row) => number {
  return (a, b) => {
    const x = keyOf(table, a);
    const y = keyOf(table, b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
}

/** A row's collected-text columns (rows.ts REDACT) through the redactor, in place; returns how many changed. */
function redactRow(redactor: Redactor, table: TableName, row: Row): number {
  let changed = 0;
  for (const [c, how] of Object.entries(REDACT[table]) as [string, "text" | "value"][]) {
    const v = row[c];
    if (typeof v !== "string") continue;
    const red = how === "value" ? redactor.value(v) : redactor.text(v);
    if (red !== v) {
      row[c] = red;
      changed++;
    }
  }
  return changed;
}

/** The ticket columns updateTicket sets; updated_at is set on every update. */
export const TICKET_MUTABLE = ["external_id", "url", "status", "action_id", "updated_at"] as const;
export type TicketPatch = Partial<Pick<Ticket, "external_id" | "url" | "status" | "action_id">> & Pick<Ticket, "updated_at">;

/** What beginRun takes: a run before it collects. finished_at, observed_count and status are ignored if present. */
export type RunStart = Omit<CollectionRun, "finished_at" | "observed_count" | "status"> & Partial<Pick<CollectionRun, "finished_at" | "observed_count" | "status">>;

export class Store {
  constructor(private readonly pool: pg.Pool, private readonly redactor: Redactor) {
    pool.on("error", (e) => process.stderr.write(`store: idle client error: ${scrub(e.message)}\n`));
  }

  /**
   * A pool on DATABASE_URL. `schema` sets search_path for every connection (the tests' throwaway
   * schema); default is the URL's own (public). The salt is REDACT_SALT, else a per-process random one,
   * as in trace.ts: rows the collectors redacted are unchanged either way.
   */
  static fromEnv(opts: { schema?: string } = {}): Store {
    const url = process.env.DATABASE_URL;
    if (!url) throw new StoreError("DATABASE_URL is not set; the store writes to the app Postgres (drift-pg, see .env)");
    if (opts.schema !== undefined && !SCHEMA_NAME.test(opts.schema)) throw new StoreError(`schema must be a lowercase identifier: ${opts.schema}`);
    const pool = new pg.Pool({ connectionString: url, ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {}) });
    return new Store(pool, new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords));
  }

  /** sql/schema.sql, every CREATE TABLE IF NOT EXISTS, in one simple-protocol call. */
  async applySchema(): Promise<void> {
    await this.tx((c) => c.query(SCHEMA_SQL));
  }

  async beginRun(run: RunStart): Promise<void> {
    const [row] = this.prepare("collection_run", [{ ...run, finished_at: null, observed_count: null, status: "running" }]);
    await this.tx(async (c) => {
      try {
        await this.insert(c, "collection_run", [row], "");
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new StoreError(`collection_run: run ${run.run_id} already exists`);
        throw e;
      }
    });
  }

  async finishRun(runId: string, observedCount: number, status: Exclude<RunStatus, "running">, finishedAt = new Date().toISOString()): Promise<void> {
    if (!["complete", "partial", "failed"].includes(status)) throw new StoreError(`finishRun: status must be complete, partial or failed, got ${status}`);
    if (!Number.isInteger(observedCount) || observedCount < 0) throw new StoreError(`finishRun: observedCount must be a non-negative integer, got ${observedCount}`);
    if (!ISO_MS.test(finishedAt)) throw new StoreError(`finishRun: finishedAt must be YYYY-MM-DDTHH:MM:SS.mmmZ, got ${finishedAt}`);
    const n = await this.tx(async (c) => (await c.query(
      "UPDATE collection_run SET finished_at = $2, observed_count = $3, status = $4 WHERE run_id = $1 AND status = 'running'",
      [runId, finishedAt, observedCount, status],
    )).rowCount ?? 0);
    if (n === 0) throw new StoreError(`collection_run: run ${runId} is not running (unknown, or already finished)`);
  }

  /** Each returns the rows written: inserted, or for inventory inserted or moved forward. 0 on a re-insert. */
  insertObservations(rows: readonly Observation[]): Promise<number> { return this.write("observation", rows); }
  insertDnsRecords(rows: readonly DnsRecord[]): Promise<number> { return this.write("dns_record", rows); }
  insertAuditEvents(rows: readonly AuditEvent[]): Promise<number> { return this.write("audit_event", rows); }
  upsertInventory(rows: readonly InventoryAsset[]): Promise<number> { return this.write("inventory_asset", rows); }
  insertBackupSnapshot(row: BackupSnapshot): Promise<number> { return this.write("backup_snapshot", [row]); }
  insertBackupItems(rows: readonly BackupItem[]): Promise<number> { return this.write("backup_item", rows); }
  insertApproved(rows: readonly ApprovedSetting[]): Promise<number> { return this.write("approved_setting", rows); }
  insertPolicyRules(rows: readonly PolicyRule[]): Promise<number> { return this.write("policy_rule", rows); }
  insertVaultCopies(rows: readonly VaultCopy[]): Promise<number> { return this.write("vault_copy", rows); }
  insertCopyValidations(rows: readonly CopyValidation[]): Promise<number> { return this.write("copy_validation", rows); }
  insertProbes(rows: readonly Probe[]): Promise<number> { return this.write("probe", rows); }
  insertDispositions(rows: readonly Disposition[]): Promise<number> { return this.write("disposition", rows); }
  insertActions(rows: readonly Action[]): Promise<number> { return this.write("action", rows); }

  /** The action rows that carry out these dispositions, in action_id order; [] for an empty list. */
  async actionsOf(dispositionIds: readonly string[]): Promise<Action[]> {
    if (!dispositionIds.length) return [];
    const rows = await this.query<Row>(`SELECT ${COLUMNS.action.join(", ")} FROM action WHERE disposition_id = ANY($1)`, [[...new Set(dispositionIds)]]);
    return rows.sort(byKey("action")) as unknown as Action[];
  }
  insertTickets(rows: readonly Ticket[]): Promise<number> { return this.write("ticket", rows); }
  insertReferentFingerprints(rows: readonly ReferentFingerprint[]): Promise<number> { return this.write("referent_fingerprint", rows); }
  insertFindingCauses(rows: readonly FindingCause[]): Promise<number> { return this.write("finding_cause", rows); }

  /**
   * One ticket row's mutable columns by ticket_id: external_id, url, status and action_id as the patch names
   * them, and updated_at always. The url goes through the redactor as on insert; updated_at must be the
   * canonical millisecond form. Returns the rows changed: 1, or 0 for a ticket_id the table lacks.
   */
  async updateTicket(ticketId: string, patch: TicketPatch): Promise<number> {
    const sets: [string, string | null][] = [];
    for (const [c, v] of Object.entries(patch)) {
      if (!(TICKET_MUTABLE as readonly string[]).includes(c)) throw new StoreError(`ticket: column ${c} is not updatable`);
      if (v !== null && typeof v !== "string") throw new StoreError(`ticket.${c}: unsupported value type ${typeof v}`);
      sets.push([c, c === "url" && typeof v === "string" ? this.redactor.text(v) : v]);
    }
    if (!ISO_MS.test(patch.updated_at)) throw new StoreError(`ticket.updated_at: timestamps must be ISO 8601 UTC in the millisecond form YYYY-MM-DDTHH:MM:SS.mmmZ, got ${patch.updated_at}`);
    const params: (string | null)[] = [ticketId];
    const assign = sets.map(([c, v]) => `${c} = $${params.push(v)}`).join(", ");
    return this.tx(async (c) => (await c.query(`UPDATE ticket SET ${assign} WHERE ticket_id = $1`, params)).rowCount ?? 0);
  }

  /** Every ticket row of one tenant, in ticket_id order. */
  ticketsOf(tenantId: string): Promise<Ticket[]> { return this.rowsOf("ticket", { tenant_id: tenantId }); }

  /**
   * The tenant's latest run of one surface (and host; null for an account surface) that passes the DQ
   * gate as RUN_COMPLETE_SQL states it: status complete, both counts present, observed_count >=
   * expected_count, and for a linux.* surface at least expected_count observation rows stored. Latest by
   * started_at, then run_id. null when no run passes.
   */
  async latestPassingRun(tenantId: string, surface: string, host: string | null): Promise<CollectionRun | null> {
    const params: string[] = [tenantId, surface];
    const hostCond = host === null ? "c.host IS NULL" : `c.host = $${params.push(host)}`;
    const rows = await this.query<CollectionRun>(
      `SELECT ${COLUMNS.collection_run.map((c) => `c.${c}`).join(", ")} FROM collection_run c
       WHERE c.tenant_id = $1 AND c.surface = $2 AND ${hostCond}
         AND c.status = 'complete' AND c.expected_count IS NOT NULL AND c.observed_count IS NOT NULL AND c.observed_count >= c.expected_count
         AND (c.surface NOT LIKE 'linux.%' OR c.expected_count <= (SELECT COUNT(*) FROM observation x WHERE x.run_id = c.run_id))
       ORDER BY c.started_at COLLATE "C" DESC, c.run_id COLLATE "C" DESC LIMIT 1`,
      params,
    );
    return rows[0] ?? null;
  }

  /** Every observation of one run, in obs_id order. */
  observationsOf(runId: string): Promise<Observation[]> { return this.rowsOf("observation", { run_id: runId }); }

  /** Every DNS record of one DNS run, in record_id order. */
  dnsRecordsOf(runId: string): Promise<DnsRecord[]> { return this.rowsOf("dns_record", { run_id: runId }); }

  /** The policy rules that can apply to the tenant: its own and every "*" rule, in rule_id order. */
  policyRules(tenantId: string): Promise<PolicyRule[]> {
    return this.query<PolicyRule>(`SELECT ${COLUMNS.policy_rule.join(", ")} FROM policy_rule WHERE tenant_id = $1 OR tenant_id = '*' ORDER BY rule_id COLLATE "C"`, [tenantId]);
  }

  /**
   * Rows of one table whose columns equal `where` (a null value matches NULL), every column in DDL order,
   * in code-unit order of the natural key. An unknown column is refused.
   */
  async rowsOf<K extends TableName>(table: K, where: Partial<Record<(typeof COLUMNS)[K][number], string | number | null>> = {}): Promise<Rows[K][]> {
    const cols = COLUMNS[table] as readonly string[];
    const params: (string | number)[] = [];
    const conds = Object.entries(where).map(([c, v]) => {
      if (!cols.includes(c)) throw new StoreError(`${table}: unknown column ${c}`);
      return v === null ? `${c} IS NULL` : `${c} = $${params.push(v as string | number)}`;
    });
    const rows = await this.query<Row>(`SELECT ${cols.join(", ")} FROM ${table}${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""}`, params);
    return rows.sort(byKey(table)) as unknown as Rows[K][];
  }

  /**
   * Every table of a bundle (sample/bundle.json shape: "_" keys are notes) in one transaction, with the
   * same validation, redaction and idempotency as the typed inserts; collection_run rows go in as
   * recorded. Returns rows written per table.
   */
  async loadBundle(bundle: Readonly<Record<string, unknown>>): Promise<Record<string, number>> {
    const batches: [TableName, Row[]][] = [];
    for (const [key, rows] of Object.entries(bundle)) {
      if (key.startsWith("_")) continue;
      if (!(TABLES as string[]).includes(key)) throw new StoreError(`bundle key is not a schema table: ${key}`);
      if (!Array.isArray(rows)) throw new StoreError(`bundle.${key} must be an array of rows`);
      batches.push([key as TableName, this.prepare(key as TableName, rows as Rows[TableName][])]);
    }
    return this.tx(async (c) => {
      const out: Record<string, number> = {};
      for (const [t, rows] of batches) out[t] = await this.insert(c, t, rows);
      return out;
    });
  }

  /** Every table, one REPEATABLE READ snapshot, rows in code-unit order of their natural key. */
  async readAll(): Promise<Tables> {
    return this.tx(async (c) => {
      const out: Record<string, Row[]> = {};
      for (const t of TABLES) out[t] = (await c.query<Row>(`SELECT ${COLUMNS[t].join(", ")} FROM ${t}`)).rows.sort(byKey(t));
      return out as unknown as Tables;
    }, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  }

  close(): Promise<void> {
    return this.pool.end();
  }

  /** One read-only SELECT, its rows as objects. */
  private async query<T extends object>(sql: string, params: readonly (string | number | readonly string[])[]): Promise<T[]> {
    return this.tx(async (c) => (await c.query<T & pg.QueryResultRow>(sql, [...params])).rows, "BEGIN READ ONLY");
  }

  private async write<K extends TableName>(table: K, rows: readonly Rows[K][]): Promise<number> {
    const prepared = this.prepare(table, rows);
    return prepared.length ? this.tx((c) => this.insert(c, table, prepared)) : 0;
  }

  /** Validate, redact, collapse identical duplicates; throw on anything the DDL or the text comparisons would not survive. */
  private prepare(table: TableName, rows: readonly object[]): Row[] {
    const cols = COLUMNS[table] as readonly string[];
    const out = new Map<string, Row>();
    let changed = 0;
    for (const input of rows) {
      const r = input as Record<string, unknown>;
      for (const k of Object.keys(r)) if (!cols.includes(k)) throw new StoreError(`${table}: unknown column ${k}`);
      const row: Row = {};
      for (const c of cols) {
        const v = r[c] ?? null;
        if (v !== null && typeof v !== "string" && typeof v !== "number") throw new StoreError(`${table}.${c}: unsupported value type ${typeof v}`);
        if (typeof v === "number" && !Number.isInteger(v)) throw new StoreError(`${table}.${c}: INTEGER column, got ${v}`);
        if (isTimestampColumn(c) && v !== null && !ISO_MS.test(String(v))) throw new StoreError(`${table}.${c}: timestamps must be ISO 8601 UTC in the millisecond form YYYY-MM-DDTHH:MM:SS.mmmZ, got ${String(v)}`);
        row[c] = v;
      }
      changed += redactRow(this.redactor, table, row);
      if (table === "action" && typeof row.record === "string" && row.record.length > ACTION_RECORD_MAX) throw new StoreError(`action.record: at most ${ACTION_RECORD_MAX} characters, got ${row.record.length}`);
      const key = keyOf(table, row);
      const seen = out.get(key);
      if (seen && JSON.stringify(seen) !== JSON.stringify(row)) throw new StoreError(`${table}: two different rows share the key ${key.replaceAll("\u001f", " / ")}`);
      out.set(key, row);
    }
    if (changed) process.stderr.write(`store: the redactor changed ${changed} field(s) of ${table} before insert; a collector stored unredacted text\n`);
    return [...out.values()];
  }

  private async insert(c: pg.PoolClient, table: TableName, rows: Row[], conflict = CONFLICT[table]): Promise<number> {
    const todo = conflict === null ? await this.unseen(c, table, rows) : rows;
    const cols = COLUMNS[table];
    const per = Math.min(MAX_ROWS, Math.floor(65535 / cols.length));
    let n = 0;
    for (let i = 0; i < todo.length; i += per) {
      const values: (string | number | null)[] = [];
      const tuples = todo.slice(i, i + per).map((r) => `(${cols.map((col) => `$${values.push(r[col])}`).join(", ")})`);
      const res = await c.query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES ${tuples.join(", ")}${conflict ? ` ${conflict}` : ""}`, values);
      n += res.rowCount ?? 0;
    }
    return n;
  }

  /** For a table without a key in the DDL: the rows whose natural key is not stored yet. */
  private async unseen(c: pg.PoolClient, table: TableName, rows: Row[]): Promise<Row[]> {
    const keys = KEYS[table];
    const firsts = [...new Set(rows.map((r) => String(r[keys[0]])))];
    const res = await c.query<Row>(`SELECT ${keys.join(", ")} FROM ${table} WHERE ${keys[0]} = ANY($1)`, [firsts]);
    const stored = new Set(res.rows.map((r) => keyOf(table, r)));
    return rows.filter((r) => !stored.has(keyOf(table, r)));
  }

  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>, begin = "BEGIN"): Promise<T> {
    let c: pg.PoolClient;
    try {
      c = await this.pool.connect();
    } catch (e) {
      throw wrap(e);
    }
    try {
      await c.query(begin);
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw wrap(e);
    } finally {
      c.release();
    }
  }
}

export interface BundleStats {
  counts: Record<TableName, number>;
  /** String fields the second redaction pass changed; anything above 0 means something upstream leaked. */
  changed: number;
  /** value_redacted fields over 2 kB, nulled. */
  dropped: number;
}

/** Tables -> the bundle shape: "_note", then every table in DDL order, rows in key order, columns in DDL order. */
export function toBundle(tables: Tables, redactor: Redactor, note: string): { bundle: BundleFile; stats: BundleStats } {
  const stats: BundleStats = { counts: {} as Record<TableName, number>, changed: 0, dropped: 0 };
  const bundle: Record<string, unknown> = { _note: note };
  for (const t of TABLES) {
    const rows = ((tables[t] ?? []) as unknown as Row[]).map((input) => {
      const row: Row = Object.fromEntries(COLUMNS[t].map((c) => [c, input[c] ?? null]));
      stats.changed += redactRow(redactor, t, row);
      if (typeof row.value_redacted === "string" && Buffer.byteLength(row.value_redacted, "utf8") > VALUE_MAX_BYTES) {
        row.value_redacted = null;
        stats.dropped++;
      }
      return row;
    }).sort(byKey(t));
    bundle[t] = rows;
    stats.counts[t] = rows.length;
  }
  return { bundle: bundle as BundleFile, stats };
}

/** The house format of sample/bundle.json: two-space keys, one row per line, LF, trailing newline. */
export function formatBundle(bundle: Readonly<Record<string, unknown>>): string {
  const field = ([k, v]: [string, unknown]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  const parts = Object.entries(bundle).map(([k, v]) => {
    if (!Array.isArray(v)) return `  ${field([k, v])}`;
    if (!v.length) return `  ${JSON.stringify(k)}: []`;
    return `  ${JSON.stringify(k)}: [\n${v.map((r: object) => `    { ${Object.entries(r).map(field).join(", ")} }`).join(",\n")}\n  ]`;
  });
  return `{\n${parts.join(",\n")}\n}\n`;
}

/**
 * Read, re-redact, check that sql.js loads it, probe the text for the labels in `deny` (positions in the
 * list and counts in the error, never the labels), then write atomically (temp file and rename).
 */
export async function writeBundle(store: Store, out: string, opts: { redactor: Redactor; note: string; deny?: readonly string[] }): Promise<BundleStats> {
  const { bundle, stats } = toBundle(await store.readAll(), opts.redactor, opts.note);
  const engine = await SqlJsEngine.create();
  try {
    engine.loadBundle(bundle);
  } finally {
    engine.close();
  }
  const text = formatBundle(bundle);
  const deny = opts.deny ?? [];
  const hits = countLabels(text, deny);
  if (Object.keys(hits).length) {
    const where = Object.entries(hits).map(([w, n]) => `#${deny.indexOf(w) + 1} x${n}`).join(", ");
    throw new StoreError(`leak probe: ${Object.keys(hits).length} of ${deny.length} deny-list label(s) still appear in the export (${where}); nothing written`);
  }
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, out);
  return stats;
}
