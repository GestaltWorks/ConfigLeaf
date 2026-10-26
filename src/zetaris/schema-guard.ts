// The source-schema guard a live pass runs before it reads anything (src/loop/pass.ts): the columns Zetaris reports for
// every DRIFT table under the drift_usl entities the pass reads and for every CLOUDFLARE REST table, against the columns
// the pass expects. A column the pass reads that is missing or has changed type makes the pass fail closed on what reads it.
//
// Contract:
//   - Tables: PASS_TABLES of DRIFT (the fourteen the pass's SQL reads, src/data/queries.ts and the catalogue, each
//     through the drift_usl entity built from it alone: src/zetaris/setup.ts READ_AS; an entity's activation reads its
//     table's columns, so the guard describes the table), each
//     DESCRIBE DATASOURCE TABLE DRIFT.<table>; then SHOW LIGHTNING TABLES CLOUDFLARE and DESCRIBE DATASOURCE TABLE
//     CLOUDFLARE.<table> for each REST table it lists. One statement per call through the engine given, so a
//     CountingEngine counts them and the tracer traces them.
//   - Expected, DRIFT: every column of the table in sql/schema.sql with its type as DESCRIBE prints it (TEXT string,
//     INTEGER integer, measured on 2.4.3.1, 26 Oct 2026). A column DESCRIBE lacks is missing; one of another type has
//     changed type; a column the schema lacks is not the pass's and is left alone.
//   - Expected, CLOUDFLARE: the column result, an array of structs whose fields id and type are strings and proxied a
//     boolean, the three fields dns_live reads (src/zetaris/setup.ts activation); every other field and column is left
//     alone.
//   - A DESCRIBE that fails is a change of the whole table (column "*", the error as what DESCRIBE gave), and so is a
//     CLOUDFLARE listing that fails; nothing is thrown. change_window aside (OPTIONAL_TABLES): a store created before
//     it lacks it, and the pass's window read already decides what its absence means.
//   - affectedSurfaces: the surfaces whose findings read a changed DRIFT table. backup_snapshot and backup_item feed
//     linux.nginx alone; dns_record, audit_event and inventory_asset feed linux.nginx and cloudflare.dns; every other
//     table (the runs, the observations, the approvals, the policy, the vault copies, the probes, the ledger, the
//     change windows) feeds every surface's decision, so a change there affects them all ("*").
//   - schemaText: "20 tables as expected", or "<ds>.<table> changed: <column>[, <column>]" per changed table, joined
//     by "; ".
//
// Measured on Zetaris 2.4.3.1, 26 Oct 2026: DESCRIBE DATASOURCE TABLE returns col_name | data_type | comment |
// description | tags; DRIFT.collection_run lists its nine columns, run_id string and expected_count integer; a CLOUDFLARE
// zone table lists errors, messages, result, result_info and success, result as
// {"type":"array","elementType":{"type":"struct","fields":[...]}} with id and type string and proxied boolean.

import type { QueryResult } from "../adapters/zetaris.ts";
import { config } from "../config.ts";
import type { Engine, RunOptions } from "../data/layer.ts";
import { SCHEMA_SQL } from "../data/schema.ts";
import { REST_DB } from "./setup.ts";

/** The DRIFT tables the pass's SQL reads. */
export const PASS_TABLES = [
  "collection_run", "observation", "approved_setting", "backup_snapshot", "backup_item", "dns_record", "audit_event", "inventory_asset",
  "policy_rule", "vault_copy", "copy_validation", "probe", "disposition", "change_window",
] as const;

/**
 * A DRIFT table a store may lack: change_window, which a store created before it lacks until npm run zetaris:setup
 * registers it. A DESCRIBE of it that fails is no change; the pass reads no window when SHOW DATASOURCE TABLES lacks it
 * and fails its drifts closed when the read fails. A change_window described with other columns is a change.
 */
export const OPTIONAL_TABLES: readonly string[] = ["change_window"];

/** The REST fields dns_live reads from each CLOUDFLARE table's result array, and their types. */
export const REST_FIELDS: Readonly<Record<string, string>> = { id: "string", type: "string", proxied: "boolean" };

const SQL_TYPE: Readonly<Record<string, string>> = { TEXT: "string", INTEGER: "integer" };

/** Each table's columns as sql/schema.sql declares them, with the type DESCRIBE prints for it. */
export function schemaColumns(ddl: string = SCHEMA_SQL): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const m of ddl.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const cols = new Map<string, string>();
    for (const raw of m[2].split("\n")) {
      const l = raw.replace(/--.*$/, "").trim();
      if (!l || /^(?:PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CONSTRAINT|CHECK)\b/i.test(l)) continue;
      const [name, type] = l.split(/\s+/);
      cols.set(name, SQL_TYPE[type.replace(/,$/, "").toUpperCase()] ?? type.toLowerCase());
    }
    out.set(m[1], cols);
  }
  return out;
}

export interface SchemaChange {
  datasource: string;
  table: string;
  /** The column the pass reads ("result.proxied" for a REST field), or "*" when the table could not be described. */
  column: string;
  want: string;
  /** What DESCRIBE reports; null when the column is missing. */
  got: string | null;
}

export interface SchemaGuard {
  /** Tables described. */
  tables: number;
  changes: SchemaChange[];
}

const col = (r: QueryResult, name: string): number => r.columns.findIndex((c) => c.toLowerCase() === name);

/** DESCRIBE's rows as column -> data_type. */
function described(r: QueryResult): Map<string, string> {
  const [n, t] = [col(r, "col_name"), col(r, "data_type")];
  return new Map(r.rows.map((row) => [row[n >= 0 ? n : 0], (row[t >= 0 ? t : 1] ?? "").trim()]));
}

/** A DRIFT table's changes: each schema column DESCRIBE lacks or types otherwise. */
export function driftChanges(table: string, r: QueryResult, ds: string = config.zetaris.datasource, want = schemaColumns().get(table)): SchemaChange[] {
  if (!want) return [];
  const have = described(r);
  return [...want].flatMap(([column, type]) => {
    const got = have.get(column);
    return got !== undefined && got.toLowerCase() === type ? [] : [{ datasource: ds, table, column, want: type, got: got ?? null }];
  });
}

/** A REST table's changes: result missing or not an array of structs, or a field dns_live reads missing or of another type. */
export function restChanges(table: string, r: QueryResult): SchemaChange[] {
  const result = described(r).get("result");
  const at = (column: string, want: string, got: string | null): SchemaChange => ({ datasource: REST_DB, table, column, want, got });
  if (result === undefined) return [at("result", "array<struct>", null)];
  let t: { type?: string; elementType?: { type?: string; fields?: { name?: string; type?: unknown }[] } };
  try {
    t = JSON.parse(result);
  } catch {
    return [at("result", "array<struct>", result.slice(0, 80))];
  }
  if (t.type !== "array" || t.elementType?.type !== "struct") return [at("result", "array<struct>", result.slice(0, 80))];
  const fields = new Map((t.elementType.fields ?? []).map((f) => [String(f.name), typeof f.type === "string" ? f.type : JSON.stringify(f.type)]));
  return Object.entries(REST_FIELDS).flatMap(([name, want]) => {
    const got = fields.get(name);
    return got === want ? [] : [at(`result.${name}`, want, got ?? null)];
  });
}

/** Describe every guarded table through the engine (see the header). Never throws: a statement that fails is a change of its table. */
export async function readSchemaGuard(engine: Pick<Engine, "run">, opts: RunOptions & { datasource?: string } = {}): Promise<SchemaGuard> {
  const { datasource = config.zetaris.datasource, ...run } = opts;
  const changes: SchemaChange[] = [];
  let tables = 0;
  const failed = (ds: string, table: string, e: unknown): SchemaChange => ({ datasource: ds, table, column: "*", want: "described", got: ((e as Error).message ?? String(e)).slice(0, 200) });
  for (const table of PASS_TABLES) {
    tables++;
    try {
      changes.push(...driftChanges(table, await engine.run(`DESCRIBE DATASOURCE TABLE ${datasource}.${table}`, run), datasource));
    } catch (e) {
      // change_window may be absent from an older store: the pass's own window read decides then (src/loop/pass.ts).
      if (!OPTIONAL_TABLES.includes(table)) changes.push(failed(datasource, table, e));
    }
  }
  let rest: string[] = [];
  try {
    const r = await engine.run(`SHOW LIGHTNING TABLES ${REST_DB}`, run);
    const n = col(r, "name");
    rest = r.rows.map((row) => row[n >= 0 ? n : 0]).filter((x) => /^zone_[0-9a-f]{32}(?:_p\d+)?$/.test(x)).sort();
  } catch (e) {
    changes.push(failed(REST_DB, "*", e));
  }
  for (const table of rest) {
    tables++;
    try {
      changes.push(...restChanges(table, await engine.run(`DESCRIBE DATASOURCE TABLE ${REST_DB}.${table}`, run)));
    } catch (e) {
      changes.push(failed(REST_DB, table, e));
    }
  }
  return { tables, changes };
}

/** The surfaces whose decisions read a DRIFT table (see the header). */
const FEEDS: Readonly<Record<string, readonly string[]>> = {
  backup_snapshot: ["linux.nginx"], backup_item: ["linux.nginx"],
  dns_record: ["linux.nginx", "cloudflare.dns"], audit_event: ["linux.nginx", "cloudflare.dns"], inventory_asset: ["linux.nginx", "cloudflare.dns"],
};

/** The surfaces a guard's DRIFT changes affect: "*" for every surface, else the set; empty when DRIFT is as expected. */
export function affectedSurfaces(g: SchemaGuard): "*" | Set<string> {
  const drift = g.changes.filter((c) => c.datasource !== REST_DB);
  if (drift.some((c) => !FEEDS[c.table])) return "*";
  return new Set(drift.flatMap((c) => FEEDS[c.table]));
}

/** "20 tables as expected", or each changed table with its columns. */
export function schemaText(g: SchemaGuard, only?: (c: SchemaChange) => boolean): string {
  const changes = only ? g.changes.filter(only) : g.changes;
  if (!changes.length) return `${g.tables} table${g.tables === 1 ? "" : "s"} as expected`;
  const by = new Map<string, string[]>();
  for (const c of changes) by.set(`${c.datasource}.${c.table}`, [...(by.get(`${c.datasource}.${c.table}`) ?? []), c.column === "*" ? "not described" : c.column]);
  return [...by].map(([t, cols]) => `${t} changed: ${cols.join(", ")}`).join("; ");
}
