// sql.js engine: SQLite in WebAssembly, in memory, for SAMPLE_MODE and tests. Applies sql/schema.sql,
// loads a bundle (keys = table names, values = arrays of row objects), inserts rows into one table at a
// time (insertRows: what an in-memory ledger writes through) and runs one SELECT at a time.
// Results are normalised exactly as Zetaris.normalise does: columns from the statement, every value
// String(), null -> "", integers without decimals, rowCount, total, latencyMs. A parity test
// compares the two engines row for row on that contract.
//
// Timestamps: every *_at column and policy_rule.since must hold the canonical millisecond form
// YYYY-MM-DDTHH:MM:SS.mmmZ (or NULL where the schema allows it). The loader refuses anything else, because rows compare as text and
// the catalogue normalises its parameters to that same form; a stored "...00Z" would sort after
// "...00.000Z" and fall off a window edge. The live collectors' INSERTs owe the same guarantee.

import { randomUUID } from "node:crypto";
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue, type Statement } from "sql.js";
import type { QueryResult } from "../../adapters/zetaris.ts";
import { DataLayerError, stripLiterals, type Engine, type RunOptions } from "../layer.ts";
import { KEYS, isTimestampColumn, type Rows, type TableName } from "../rows.ts";
import { SCHEMA_SQL, tableDef, type TableDef } from "../schema.ts";

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let runtime: Promise<SqlJsStatic> | undefined;
/** initSqlJs() loads the wasm once per process; every engine shares it. */
function init(): Promise<SqlJsStatic> {
  return (runtime ??= initSqlJs());
}

export type Bundle = Readonly<Record<string, unknown>>;

function toSqlValue(v: unknown, where: string): SqlValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number") return v;
  throw new DataLayerError(`${where}: unsupported value type ${typeof v}`);
}

const insertSql = (def: TableDef): string => `INSERT INTO ${def.name} (${def.columns.join(", ")}) VALUES (${def.columns.map(() => "?").join(", ")})`;

/** Each row's values in DDL column order, after the loader's checks: every key a column, every timestamp column canonical or NULL. */
function rowValues(def: TableDef, rows: readonly Record<string, unknown>[], where: string): SqlValue[][] {
  return rows.map((row) => {
    for (const k of Object.keys(row)) if (!def.columns.includes(k)) throw new DataLayerError(`${where}: unknown column ${k}`);
    for (const c of def.columns) {
      if (isTimestampColumn(c) && row[c] != null && !ISO_MS.test(String(row[c]))) {
        throw new DataLayerError(`${where}.${c}: timestamps must be ISO 8601 UTC in the millisecond form YYYY-MM-DDTHH:MM:SS.mmmZ, got ${String(row[c])}`);
      }
    }
    return def.columns.map((c) => toSqlValue(row[c], `${where}.${c}`));
  });
}

export class SqlJsEngine implements Engine {
  readonly name = "sqljs" as const;

  private constructor(private readonly db: Database) {}

  /** A fresh in-memory database with the shared schema applied. */
  static async create(): Promise<SqlJsEngine> {
    const SQL = await init();
    const db = new SQL.Database();
    db.exec(SCHEMA_SQL);
    return new SqlJsEngine(db);
  }

  qualify(table: string): string {
    return table;
  }

  /**
   * Insert every table present in the bundle. Keys starting with "_" are notes and skipped; any other
   * key must be a schema table, every row key a column of it, and every timestamp canonical (see the
   * header). A bundle carries any subset of the schema's tables: one exported before policy_rule and the
   * other tables of the design existed loads as it did. Returns rows inserted per table present.
   */
  loadBundle(bundle: Bundle): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [key, rows] of Object.entries(bundle)) {
      if (key.startsWith("_")) continue;
      const def = tableDef(key);
      if (!def) throw new DataLayerError(`bundle key is not a schema table: ${key}`);
      if (!Array.isArray(rows)) throw new DataLayerError(`bundle.${key} must be an array of rows`);
      const values = rowValues(def, rows as Record<string, unknown>[], `bundle.${key}`);
      const stmt = this.db.prepare(insertSql(def));
      try {
        for (const v of values) stmt.run(v);
      } finally {
        stmt.free();
      }
      counts[key] = rows.length;
    }
    return counts;
  }

  /**
   * Insert rows into one schema table, columns in the same DDL order loadBundle uses, with the same
   * checks (every key a column, every timestamp canonical), in one transaction. Idempotent on the natural
   * key (rows.ts KEYS), as Store's inserts are: a row whose key is stored already is skipped, identical
   * duplicates in one call collapse, two different rows under one key are refused. An unknown table is
   * refused. Returns the rows inserted.
   */
  insertRows<K extends TableName>(table: K, rows: readonly Rows[K][]): number {
    const def = tableDef(table);
    if (!def || !Object.hasOwn(KEYS, table)) throw new DataLayerError(`unknown table: ${String(table)}`);
    if (!Array.isArray(rows)) throw new DataLayerError(`${table}: rows must be an array`);
    const keys = KEYS[table] as readonly string[];
    const batch = new Map<string, { row: Record<string, unknown>; values: SqlValue[] }>();
    const values = rowValues(def, rows as unknown as Record<string, unknown>[], table);
    for (const [i, v] of values.entries()) {
      const row = rows[i] as unknown as Record<string, unknown>;
      const key = keys.map((k) => String(row[k] ?? "")).join("\u001f");
      const seen = batch.get(key);
      if (seen && JSON.stringify(seen.values) !== JSON.stringify(v)) throw new DataLayerError(`${table}: two different rows share the key ${key.replaceAll("\u001f", " / ")}`);
      batch.set(key, { row, values: v });
    }
    const exists = this.db.prepare(`SELECT 1 FROM ${def.name} WHERE ${keys.map((k) => `${k} = ?`).join(" AND ")}`);
    const insert = this.db.prepare(insertSql(def));
    let n = 0;
    this.db.exec("BEGIN");
    try {
      for (const { row, values: v } of batch.values()) {
        exists.bind(keys.map((k) => toSqlValue(row[k], `${table}.${k}`)));
        const stored = exists.step();
        exists.reset();
        if (stored) continue;
        insert.run(v);
        n++;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err instanceof DataLayerError ? err : new DataLayerError(`sqljs: ${(err as Error).message}`);
    } finally {
      exists.free();
      insert.free();
    }
    return n;
  }

  /** Run exactly one statement. Same refusal as the Zetaris adapter: a trailing semicolon is stripped, a second statement is refused; a ';' inside a literal is data. */
  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    const clean = sql.trim().replace(/;+\s*$/, "");
    if (/;\s*\S/.test(stripLiterals(clean))) throw new DataLayerError("one statement per call");
    const queryId = randomUUID();
    const limit = opts.limit ?? 1000;
    const t0 = Date.now();
    let stmt: Statement | undefined;
    try {
      stmt = this.db.prepare(clean);
      const columns = stmt.getColumnNames();
      const rows: string[][] = [];
      let total = 0;
      while (stmt.step()) {
        if (total++ < limit) rows.push(stmt.get().map((v) => (v === null ? "" : String(v))));
      }
      const latencyMs = Date.now() - t0;
      const result: QueryResult = { queryId, columns, rows, rowCount: rows.length, total, latencyMs, raw: { engine: "sqljs", sql: clean } };
      opts.tracer?.emit({ agent: opts.agent ?? "sqljs", action: "query", engine: this.name, query_id: queryId, status: "ok", latency_ms: latencyMs, output_summary: `${result.rowCount} rows`, input_summary: clean.slice(0, 160) });
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      opts.tracer?.emit({ agent: opts.agent ?? "sqljs", action: "query", engine: this.name, query_id: queryId, status: "failed", latency_ms: Date.now() - t0, detail: msg });
      throw err instanceof DataLayerError ? err : new DataLayerError(`sqljs: ${msg}`);
    } finally {
      stmt?.free();
    }
  }

  close(): void {
    this.db.close();
  }
}
