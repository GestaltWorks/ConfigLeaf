// The derived tables a pre-flight runs the pass over. A proposed change is never written: the table it
// would touch is rendered, for one simulation, as a SELECT over the base table in which the touched
// column is a CASE on the bound row(s). DataLayer.render puts that SELECT where {{t:<table>}} stands,
// on sql.js and on Zetaris alike, and the guard sees the final text. No row is added, so no row can
// leak into a real pass: the simulated world is a query, and the base rows are what they were.
//
// Two overlays, each over the columns of its table in DDL order (data/schema.ts), so a `d.content` or
// `n.value_redacted` in the catalogue reads the simulated value and every other column passes through:
//   dns_record    one field (proxied or content) of one or more records in one run
//   observation   the value_redacted (and value_hash) of named real_ip rows of one object in one run,
//                 the shape the nginx collector writes: trusted:<n> header:<h> scope:<server|http>
// Overlays compose: a second change on the same table reads the first overlay's SELECT as its base.

import { createHash } from "node:crypto";
import { DataLayerError, literal, type DataLayer, type Overlays, type Param, type RunOptions } from "../data/layer.ts";
import { objects } from "../data/queries.ts";
import { tableDef } from "../data/schema.ts";

/** Cloudflare publishes 15 IPv4 ranges; a proposal that gives a count and no header gets this shape. */
export const CLOUDFLARE_IPV4_RANGES = 15;
export const REAL_IP_HEADER = "CF-Connecting-IP";
export const REAL_IP_VALUE = /^trusted:\d{1,3} header:[A-Za-z0-9-]{1,64} scope:(server|http)$/;

export const realIpValue = (ranges: number, scope: "server" | "http"): string => `trusted:${ranges} header:${REAL_IP_HEADER} scope:${scope}`;

/** The value_hash a simulated value carries: labelled, salt-free, never equal to a collected one. */
export const simulatedHash = (value: string): string => `sha256:${createHash("sha256").update(`preflight:${value}`).digest("hex")}`;

const inList = (values: readonly string[]): string => values.map((v) => literal(v)).join(", ");

/**
 * One SELECT over `from` returning every column of `table` in DDL order, with `overrides` (column ->
 * expression) in place of the plain column, aliased back to the column name.
 */
export function derivedTable(table: string, overrides: Readonly<Record<string, string>>, from = `{{t:${table}}}`): string {
  const def = tableDef(table);
  if (!def) throw new DataLayerError(`unknown table: ${table}`);
  for (const c of Object.keys(overrides)) if (!def.columns.includes(c)) throw new DataLayerError(`${table} has no column ${c}`);
  const cols = def.columns.map((c) => (overrides[c] !== undefined ? `${overrides[c]} AS ${c}` : c));
  return `SELECT ${cols.join(", ")} FROM ${from}`;
}

/** Put `body` in place of `table` in `current`; an existing overlay on that table becomes the body's base. */
function compose(current: Overlays, table: string, build: (from: string) => string): Overlays {
  const inner = current[table];
  return { ...current, [table]: build(inner === undefined ? `{{t:${table}}}` : `(${inner}) base`) };
}

export interface DnsRecordChange {
  run_id: string;
  record_ids: readonly string[];
  field: "proxied" | "content";
  to: Param;
}

/** dns_record with `field` set to `to` on the named records of one run; every other row and column as recorded. */
export function dnsRecordOverlay(change: DnsRecordChange, current: Overlays = {}): Overlays {
  if (!change.record_ids.length) throw new DataLayerError("dns_record overlay needs at least one record_id");
  const when = `record_id IN (${inList(change.record_ids)}) AND run_id = ${literal(change.run_id)}`;
  const value = change.field === "proxied" ? literal(Number(change.to)) : literal(String(change.to));
  return compose(current, "dns_record", (from) => derivedTable("dns_record", { [change.field]: `CASE WHEN ${when} THEN ${value} ELSE ${change.field} END` }, from));
}

export interface RealIpChange {
  run_id: string;
  object_id: string;
  setting_paths: readonly string[];
  to: string;
}

/** observation with the named real_ip rows of one object in one run reading `to`, value_hash marked as simulated. */
export function realIpOverlay(change: RealIpChange, current: Overlays = {}): Overlays {
  if (!change.setting_paths.length) throw new DataLayerError("real_ip overlay needs at least one setting_path");
  const when = `run_id = ${literal(change.run_id)} AND object_id = ${literal(change.object_id)} AND setting_path IN (${inList(change.setting_paths)})`;
  return compose(current, "observation", (from) => derivedTable("observation", {
    value_hash: `CASE WHEN ${when} THEN ${literal(simulatedHash(change.to))} ELSE value_hash END`,
    value_redacted: `CASE WHEN ${when} THEN ${literal(change.to)} ELSE value_redacted END`,
  }, from));
}

/** The real_ip rows of one object in one run (server[...].real_ip per block, http.real_ip on the entry file), as the current layer sees them. */
export const REAL_IP_ROWS_SQL = `SELECT obs_id, setting_path, value_hash, value_redacted
FROM {{t:observation}}
WHERE run_id = {{p:run_id}} AND host = {{p:host}} AND object_id = {{p:object_id}} AND setting_path LIKE '%.real_ip'
ORDER BY setting_path`;

export async function realIpRows(layer: DataLayer, params: { run_id: string; host: string; object_id: string }, opts?: RunOptions): Promise<Record<string, string>[]> {
  return objects(await layer.run(REAL_IP_ROWS_SQL, params, opts));
}
