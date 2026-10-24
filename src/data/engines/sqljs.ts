// sql.js engine: SQLite in WebAssembly, in memory, for SAMPLE_MODE and tests. Applies sql/schema.sql,
// loads a bundle (keys = table names, values = arrays of row objects) and runs one SELECT at a time.
// Results are normalised exactly as Zetaris.normalise does: columns from the statement, every value
// String(), null -> "", integers without decimals, rowCount, total, latencyMs. A parity test
// compares the two engines row for row on that contract.
//
// Timestamps: every *_at column must hold the canonical millisecond form YYYY-MM-DDTHH:MM:SS.mmmZ (or
// NULL where the schema allows it). The loader refuses anything else, because rows compare as text and
// the catalogue normalises its parameters to that same form; a stored "...00Z" would sort after
// "...00.000Z" and fall off a window edge. The live collectors' INSERTs owe the same guarantee.

import { randomUUID } from "node:crypto";
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue, type Statement } from "sql.js";
import type { QueryResult } from "../../adapters/zetaris.ts";
import { DataLayerError, stripLiterals, type Engine, type RunOptions } from "../layer.ts";
import { SCHEMA_SQL, tableDef } from "../schema.ts";

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
   * key must be a schema table, every row key a column of it, and every *_at value canonical (see the
   * header). Returns rows inserted per table.
   */
  loadBundle(bundle: Bundle): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [key, rows] of Object.entries(bundle)) {
      if (key.startsWith("_")) continue;
      const def = tableDef(key);
      if (!def) throw new DataLayerError(`bundle key is not a schema table: ${key}`);
      if (!Array.isArray(rows)) throw new DataLayerError(`bundle.${key} must be an array of rows`);
      const stmt = this.db.prepare(`INSERT INTO ${def.name} (${def.columns.join(", ")}) VALUES (${def.columns.map(() => "?").join(", ")})`);
      try {
        for (const row of rows as Record<string, unknown>[]) {
          for (const k of Object.keys(row)) if (!def.columns.includes(k)) throw new DataLayerError(`bundle.${key}: unknown column ${k}`);
          for (const c of def.columns) {
            if (c.endsWith("_at") && row[c] != null && !ISO_MS.test(String(row[c]))) {
              throw new DataLayerError(`bundle.${key}.${c}: timestamps must be ISO 8601 UTC in the millisecond form YYYY-MM-DDTHH:MM:SS.mmmZ, got ${String(row[c])}`);
            }
          }
          stmt.run(def.columns.map((c) => toSqlValue(row[c], `bundle.${key}.${c}`)));
        }
      } finally {
        stmt.free();
      }
      counts[key] = rows.length;
    }
    return counts;
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
      opts.tracer?.emit({ agent: opts.agent ?? "sqljs", action: "query", query_id: queryId, status: "ok", latency_ms: latencyMs, output_summary: `${result.rowCount} rows`, input_summary: clean.slice(0, 160) });
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      opts.tracer?.emit({ agent: opts.agent ?? "sqljs", action: "query", query_id: queryId, status: "failed", latency_ms: Date.now() - t0, detail: msg });
      throw err instanceof DataLayerError ? err : new DataLayerError(`sqljs: ${msg}`);
    } finally {
      stmt?.free();
    }
  }

  close(): void {
    this.db.close();
  }
}
