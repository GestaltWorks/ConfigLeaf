// The shared DDL, read once from sql/schema.sql, and the table and column list parsed out of it.
// One source: the DataLayer's known-table guard, the sql.js loader's column order and the parity
// test's per-table SELECTs all derive from this file, so code and DDL cannot drift apart.

import { readFileSync } from "node:fs";

export const SCHEMA_PATH = new URL("../../sql/schema.sql", import.meta.url);
export const SCHEMA_SQL = readFileSync(SCHEMA_PATH, "utf8");

export interface TableDef { name: string; columns: string[] }

/** A table constraint line (PRIMARY KEY (a, b), UNIQUE (...), ...): it names columns, it declares none. */
const CONSTRAINT = /^(?:PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CONSTRAINT|CHECK)\b/i;

/** CREATE TABLE blocks in DDL order; a column is the first token of each body line, comments and table constraints aside. */
function parse(ddl: string): TableDef[] {
  const out: TableDef[] = [];
  for (const m of ddl.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const columns = m[2].split("\n")
      .map((l) => l.replace(/--.*$/, "").trim())
      .filter((l) => l !== "" && !CONSTRAINT.test(l))
      .map((l) => l.split(/\s+/)[0]);
    out.push({ name: m[1], columns });
  }
  return out;
}

export const SCHEMA_TABLES: readonly TableDef[] = parse(SCHEMA_SQL);
export const TABLE_NAMES: readonly string[] = SCHEMA_TABLES.map((t) => t.name);

export function tableDef(name: string): TableDef | undefined {
  return SCHEMA_TABLES.find((t) => t.name === name);
}
