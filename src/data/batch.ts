// The observe step's reads as sets (src/pipeline.ts): every observation of a tenant's surface in one read, and what the
// dns_name referents of the host runs that share a DNS run resolved to in it, in one read per DNS run, where the pass
// once read both per run. Each read is paged with a keyset on obs_id, OBSERVATION_PAGE rows a page, so no one response
// grows with the history: a page is the rows with obs_id above the last page's last, in obs_id order, which Postgres
// answers from the primary key. The filters are equalities, AND and an IN list of literals; no OR, so nothing needs
// fencing against the Zetaris pushdown fault PR #21's fencedOr() guards.
//
// Within a run, rows come out in the order the per-run reads gave (OBSERVATIONS_SQL by obs_id, RESOLUTIONS_SQL by obs_id,
// record_id and content), so the World Model, the ledger and every finding see the same rows in the same order.

import { objects } from "./queries.ts";
import type { DataLayer, RunOptions } from "./layer.ts";

type Row = Record<string, string>;

/** Rows a page of a batched read returns at most: the engine's limit for the request. */
export const OBSERVATION_PAGE = 5000;

/** Run ids an IN list names at most; more runs take more reads. */
export const RUNS_PER_READ = 100;

/** One page of a tenant's surface: its observations past `after`, in obs_id order (the columns of OBSERVATIONS_SQL). */
export const SURFACE_OBSERVATIONS_SQL = `SELECT obs_id, run_id, tenant_id, surface, host, object_id, setting_path, value_hash, value_redacted,
       refers_to_type, refers_to_id, observed_at, source, authority
FROM {{t:observation}}
WHERE tenant_id = {{p:tenant_id}} AND surface = {{p:surface}} AND obs_id > {{p:after}}
ORDER BY obs_id`;

/** One page of what the dns_name referents of `runs` resolved to in one DNS run, past `after` (RESOLUTIONS_SQL with the run). */
export function batchResolutionsSql(runs: number): string {
  const list = Array.from({ length: runs }, (_, i) => `{{p:run_${i}}}`).join(", ");
  return `SELECT o.run_id, o.obs_id, d.record_id, d.content, d.observed_at
FROM {{t:observation}} o
JOIN {{t:dns_record}} d ON d.tenant_id = o.tenant_id AND d.name = o.refers_to_id AND d.run_id = {{p:dns_run_id}}
  AND d.type IN ('A', 'AAAA')
WHERE o.run_id IN (${list}) AND o.refers_to_type = 'dns_name' AND o.obs_id > {{p:after}}
ORDER BY o.obs_id, d.record_id, d.content`;
}

/**
 * Read every page of `sql` (its keyset parameter `after`): rows in order. A page that stops short of the rows the engine
 * counted is cut back to its last whole obs_id, and the next page starts after it, so one obs_id's rows never straddle
 * two pages.
 */
async function pages(layer: DataLayer, sql: string, params: Record<string, string>, opts: RunOptions, page: number): Promise<Row[]> {
  const out: Row[] = [];
  let after = "";
  for (;;) {
    const r = await layer.run(sql, { ...params, after }, { ...opts, limit: page });
    const rows = objects(r);
    if (r.total <= r.rowCount) {
      out.push(...rows);
      return out;
    }
    const last = rows.at(-1)?.obs_id;
    const whole = rows.filter((x) => x.obs_id !== last);
    if (!last || whole.length === 0) throw new Error(`batched read: one obs_id holds more than ${page} rows`);
    out.push(...whole);
    after = whole.at(-1)!.obs_id;
  }
}

/** Every observation of the tenant's surface, grouped by run, each run's in obs_id order. */
export async function surfaceObservations(layer: DataLayer, tenantId: string, surface: string, opts: RunOptions = {}, page = OBSERVATION_PAGE): Promise<Map<string, Row[]>> {
  const byRun = new Map<string, Row[]>();
  for (const o of await pages(layer, SURFACE_OBSERVATIONS_SQL, { tenant_id: tenantId, surface }, opts, page)) {
    const list = byRun.get(o.run_id);
    if (list) list.push(o);
    else byRun.set(o.run_id, [o]);
  }
  return byRun;
}

/** What the dns_name referents of each of `runs` resolved to in `dnsRunId`, grouped by run, rows as RESOLUTIONS_SQL gives them. */
export async function batchResolutions(layer: DataLayer, runs: readonly string[], dnsRunId: string, opts: RunOptions = {}, page = OBSERVATION_PAGE): Promise<Map<string, Row[]>> {
  const byRun = new Map<string, Row[]>(runs.map((r) => [r, []]));
  for (let i = 0; i < runs.length; i += RUNS_PER_READ) {
    const chunk = runs.slice(i, i + RUNS_PER_READ);
    const params: Record<string, string> = { dns_run_id: dnsRunId };
    chunk.forEach((r, j) => { params[`run_${j}`] = r; });
    for (const { run_id, ...row } of await pages(layer, batchResolutionsSql(chunk.length), params, opts, page)) byRun.get(run_id)?.push(row);
  }
  return byRun;
}
