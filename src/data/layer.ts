// The data layer: one SQL catalogue, two engines. Catalogue SQL names tables as {{t:name}} and
// parameters as {{p:name}}; render() turns both into engine text, because Zetaris REST takes one
// SQL string per call and binds nothing. The SQL stays in the portable subset (lowercase unquoted
// identifiers, single-quoted literals with ' doubled, no casts, no date functions, no booleans,
// one SELECT per call) so it runs unchanged on sql.js and on Spark-SQL-style Zetaris Lightning.
// Both engines return every value as a string and null as "", so a parity test can compare rows.

import type { QueryResult } from "../adapters/zetaris.ts";
import type { Tracer } from "../trace.ts";
import { TABLE_NAMES } from "./schema.ts";

export interface RunOptions { limit?: number; agent?: string; tracer?: Tracer }

export interface Engine {
  name: "sqljs" | "zetaris";
  /** Engine-specific table reference: bare name on sql.js, datasource-qualified on Zetaris. */
  qualify(table: string): string;
  run(sql: string, opts?: RunOptions): Promise<QueryResult>;
}

export type Param = string | number | null;
export type Params = Readonly<Record<string, Param>>;

export class DataLayerError extends Error {}

const FORBIDDEN = /\b(insert|update|delete|drop|create|alter|grant|pragma|attach)\b/i;

/**
 * Replace single-quoted literals ('' is an escaped quote) so a guard scans only SQL text. Shared by
 * assertSelectOnly, both engines' one-statement check and the judge's bare-table rule, so a ';' or a
 * keyword inside a rendered parameter is data everywhere.
 */
export function stripLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * Refuse anything that is not exactly one SELECT. With literals stripped: no semicolon (a second
 * statement), no double quote (identifiers are unquoted and strings single-quoted in the portable
 * subset; a "x'" token would otherwise hide a UNION and a comment from the strip while sql.js and
 * Spark run them), no comment, no DML/DDL token.
 */
export function assertSelectOnly(sql: string): void {
  const s = sql.trim();
  if (!/^select\b/i.test(s)) throw new DataLayerError("only SELECT is allowed");
  const bare = stripLiterals(s);
  if (bare.includes(";")) throw new DataLayerError("one statement per query, no semicolons");
  if (bare.includes('"')) throw new DataLayerError("double quotes are not allowed; identifiers are unquoted, strings single-quoted");
  if (/--|\/\*/.test(bare)) throw new DataLayerError("comments are not allowed");
  const m = bare.match(FORBIDDEN);
  if (m) throw new DataLayerError(`forbidden keyword: ${m[1].toUpperCase()}`);
}

/** Render one parameter as a portable SQL literal. */
export function literal(v: Param): string {
  if (v === null) return "NULL";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  throw new DataLayerError(`unsupported parameter type: ${v === undefined ? "undefined" : typeof v}`);
}

export class DataLayer {
  constructor(readonly engine: Engine, readonly tables: readonly string[] = TABLE_NAMES) {}

  /** {{t:name}} must be a known table; {{p:name}} must be present in params. Any other brace pair in the template throws; braces inside a parameter value are data. */
  render(sql: string, params: Params = {}): string {
    if (/\{\{|\}\}/.test(sql.replace(/\{\{(t|p):\w+\}\}/g, ""))) throw new DataLayerError("malformed placeholder; use {{t:table}} or {{p:param}}");
    return sql.replace(/\{\{(t|p):(\w+)\}\}/g, (_, kind: string, name: string) => {
      if (kind === "t") {
        if (!this.tables.includes(name)) throw new DataLayerError(`unknown table: ${name}`);
        return this.engine.qualify(name);
      }
      if (!Object.hasOwn(params, name)) throw new DataLayerError(`missing parameter: ${name}`);
      return literal(params[name]);
    });
  }

  async run(sql: string, params: Params = {}, opts: RunOptions = {}): Promise<QueryResult> {
    const rendered = this.render(sql, params);
    assertSelectOnly(rendered);
    return this.engine.run(rendered, opts);
  }
}
