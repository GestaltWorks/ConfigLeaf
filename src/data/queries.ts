// The SQL catalogue. Tables are {{t:name}}, parameters {{p:name}}; DataLayer.render fills both per
// engine. Portable subset only (see layer.ts); no comments inside the SQL text, the guard refuses them.

import type { QueryResult } from "../adapters/zetaris.ts";
import type { DataLayer, RunOptions } from "./layer.ts";

/** Rows as objects keyed by column name. Every value is a string; a NULL came back as "". */
export function objects(r: QueryResult): Record<string, string>[] {
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i] ?? ""])));
}

/**
 * The cross-source hero query: a Linux vhost proxies to a DNS name whose Cloudflare record now
 * resolves to an address the client's inventory does not know. Exists in no single table. Only A and
 * AAAA records are addresses: a TXT (SPF, DMARC, a verification token) or a CNAME on the same name is
 * not, and would otherwise be a finding on every pass. Total ORDER BY so both engines return the same
 * row order; a name with an A and an AAAA record gives one row per record.
 */
export const HERO_SQL = `SELECT o.host, o.object_id, o.setting_path, o.refers_to_id AS upstream_name,
       d.content AS resolves_to, d.observed_at AS dns_observed_at
FROM {{t:observation}} o
JOIN {{t:dns_record}} d
  ON d.tenant_id = o.tenant_id AND d.name = o.refers_to_id AND d.run_id = {{p:dns_run_id}}
  AND d.type IN ('A', 'AAAA')
LEFT JOIN {{t:inventory_asset}} i
  ON i.tenant_id = o.tenant_id AND i.address = d.content
WHERE o.tenant_id = {{p:tenant_id}} AND o.run_id = {{p:run_id}}
  AND o.refers_to_type = 'dns_name' AND i.asset_id IS NULL
ORDER BY o.host, o.object_id, o.setting_path, d.record_id, d.content`;

export type HeroParams = { tenant_id: string; run_id: string; dns_run_id: string };

export function hero(dl: DataLayer, params: HeroParams, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(HERO_SQL, params, opts);
}

/**
 * DQ gate. Rows are collection runs that FAIL it: fewer observations than the population asserted
 * before collecting, a status other than complete, no population asserted at all (a run that never
 * said what it set out to collect cannot show it collected everything), or, for a host surface
 * (linux.*), fewer observation rows actually stored than asserted, so the collector's self-reported
 * observed_count is not taken on trust. Other surfaces store their rows in other tables (dns_record,
 * audit_event, inventory_asset) and get the self-report check only. No rows for the run means it passes.
 */
export const RUN_COMPLETE_SQL = `SELECT c.run_id, c.tenant_id, c.surface, c.host, c.expected_count, c.observed_count, c.status
FROM {{t:collection_run}} c
WHERE c.run_id = {{p:run_id}}
  AND (c.observed_count < c.expected_count OR c.status <> 'complete'
    OR c.expected_count IS NULL OR c.observed_count IS NULL
    OR (c.surface LIKE 'linux.%' AND c.expected_count > (SELECT COUNT(*) FROM {{t:observation}} x WHERE x.run_id = c.run_id)))`;

export function runComplete(dl: DataLayer, runId: string, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(RUN_COMPLETE_SQL, { run_id: runId }, opts);
}

/** Every collection run, oldest first; the pass groups them by tenant, surface and host. */
export const RUNS_SQL = `SELECT run_id, tenant_id, surface, host, started_at, finished_at, expected_count, observed_count, status
FROM {{t:collection_run}}
ORDER BY started_at, run_id`;

export function listRuns(dl: DataLayer, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(RUNS_SQL, {}, opts);
}

/** Every observation of one run, in obs_id order. */
export const OBSERVATIONS_SQL = `SELECT obs_id, run_id, tenant_id, surface, host, object_id, setting_path, value_hash, value_redacted,
       refers_to_type, refers_to_id, observed_at, source, authority
FROM {{t:observation}}
WHERE run_id = {{p:run_id}}
ORDER BY obs_id`;

export function observationsOf(dl: DataLayer, runId: string, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(OBSERVATIONS_SQL, { run_id: runId }, opts);
}

/**
 * What each dns_name referent in a run resolved to in a DNS run: the fingerprint the World Model
 * stores on the referent. A and AAAA records only, so a rotated TXT token does not flip
 * found_but_different on an unchanged address. A name with several address records gives several rows.
 */
export const RESOLUTIONS_SQL = `SELECT o.obs_id, d.record_id, d.content, d.observed_at
FROM {{t:observation}} o
JOIN {{t:dns_record}} d ON d.tenant_id = o.tenant_id AND d.name = o.refers_to_id AND d.run_id = {{p:dns_run_id}}
  AND d.type IN ('A', 'AAAA')
WHERE o.run_id = {{p:run_id}} AND o.refers_to_type = 'dns_name'
ORDER BY o.obs_id, d.record_id, d.content`;

export type ResolutionParams = { run_id: string; dns_run_id: string };

export function resolutions(dl: DataLayer, params: ResolutionParams, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(RESOLUTIONS_SQL, params, opts);
}
