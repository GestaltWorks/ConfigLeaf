// The live pass's own statements about Zetaris's catalogue, answered as Zetaris 2.4.3.1 answered them on 26 Oct 2026,
// for a fake engine under Zetaris's name over sql.js: DESCRIBE DATASOURCE TABLE of a DRIFT table (its sql/schema.sql
// columns, TEXT as string and INTEGER as integer) or of a CLOUDFLARE zone table (result as an array of structs with id,
// type and proxied), SHOW LIGHTNING TABLES CLOUDFLARE (the zone tables given) and EXPLAIN QUERY AS (a one-row plan).
// undefined for any other statement, which the fake hands on.
import type { QueryResult } from "../../src/adapters/zetaris.ts";
import { schemaColumns } from "../../src/zetaris/schema-guard.ts";

const result = (columns: string[], rows: string[][]): QueryResult => ({ queryId: "meta", columns, rows, rowCount: rows.length, total: rows.length, latencyMs: 1, raw: {} });

export const REST_RESULT = JSON.stringify({
  type: "array", elementType: { type: "struct", fields: [
    { name: "content", type: "string", nullable: true, metadata: {} }, { name: "id", type: "string", nullable: true, metadata: {} },
    { name: "proxied", type: "boolean", nullable: true, metadata: {} }, { name: "ttl", type: "long", nullable: true, metadata: {} },
    { name: "type", type: "string", nullable: true, metadata: {} },
  ] }, containsNull: true,
});

export const PLAN = "== Parsed Logical Plan ==\n'Project ['COUNT(1) AS live]\n\n== Physical Plan ==\nAdaptiveSparkPlan isFinalPlan=false";

export interface MetaOptions {
  /** Zone tables SHOW LIGHTNING TABLES CLOUDFLARE lists. */
  zones?: readonly string[];
  /** Per DRIFT table: column -> the data_type DESCRIBE reports (null drops the column). */
  drift?: Readonly<Record<string, Readonly<Record<string, string | null>>>>;
  /** The data_type of result in every zone table. */
  rest?: string;
  /** EXPLAIN QUERY AS throws this message. */
  explainError?: string;
}

export function zetarisMeta(sql: string, o: MetaOptions = {}): QueryResult | undefined {
  const d = /^DESCRIBE DATASOURCE TABLE (\w+)\.(\w+)$/.exec(sql);
  if (d && d[1] === "CLOUDFLARE") {
    return result(["col_name", "data_type", "comment", "description", "tags"], [["errors", "{\"type\":\"array\"}", "", "", ""], ["result", o.rest ?? REST_RESULT, "", "", ""], ["success", "\"boolean\"", "", "", ""]]);
  }
  if (d) {
    const cols = schemaColumns().get(d[2]);
    if (!cols) throw new Error(`Zetaris 400: Table or view not found: ${d[1]}.${d[2]}`);
    const over = o.drift?.[d[2]] ?? {};
    const rows = [...cols].flatMap(([c, t]) => (over[c] === null ? [] : [[c, over[c] ?? t, "", "", ""]]));
    return result(["col_name", "data_type", "comment", "description", "tags"], rows);
  }
  if (sql === "SHOW LIGHTNING TABLES CLOUDFLARE") return result(["name", "source_table", "table_type"], (o.zones ?? []).map((z) => [z, "https://api.cloudflare.com/client/v4/zones/x/dns_records", "rest"]));
  if (sql.startsWith("EXPLAIN QUERY AS ")) {
    if (o.explainError) throw new Error(o.explainError);
    return result(["plan"], [[PLAN]]);
  }
  return undefined;
}
