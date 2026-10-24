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

// ---- the estate survey ---------------------------------------------------------------------------------
//
// Cross-source checks over the latest nginx run of one host and the DNS run of the same pass, written
// against the collectors' setting paths: a server block is server[<first name>:<port>], its names are
// .server_name[<name>] rows (refers_to dns_name) with a .server_name[<name>].zone sibling, and every
// block has an .enabled and a .real_ip row. The block key of a name row is its setting_path up to
// ".server_name[" (instr/substr, both engines), and a sibling is the row whose path is that key plus
// its own tail, so the join never relies on string concatenation. A CNAME is followed one level to an
// A or AAAA record in the same run; "origin" is the address a name finally lands on, matched against
// the inventory, which the Linux collector fills with each host's global addresses. Pseudonyms join
// because every collector redacts with the tenant's salt. Measured on Zetaris 2.4.3.1 (Spark SQL): a
// subquery may reference the outer query in its WHERE only, never in a JOIN ... ON inside it
// (UNSUPPORTED_SUBQUERY_EXPRESSION_CATEGORY.CORRELATED_REFERENCE), so every correlation below sits in
// the subquery's WHERE; instr, substr, length and COALESCE run unchanged on both engines.

/** The block key of a server_name observation `n`: its setting_path up to ".server_name[". */
const KEY_OF_NAME = (n: string): string => `substr(${n}.setting_path, 1, instr(${n}.setting_path, '.server_name[') - 1)`;
/** The block key of a .enabled or .real_ip observation `x` (both tails are 8 characters). */
const KEY_OF_TAIL8 = (x: string): string => `substr(${x}.setting_path, 1, length(${x}.setting_path) - 8)`;
/** Join the enabled sibling of name row `n` as `e`. */
const ENABLED_OF = (n: string, e: string): string =>
  `JOIN {{t:observation}} ${e} ON ${e}.run_id = ${n}.run_id AND ${e}.object_id = ${n}.object_id AND ${e}.setting_path LIKE '%.enabled' AND ${KEY_OF_TAIL8(e)} = ${KEY_OF_NAME(n)}`;
/** A CNAME `d` followed one level to the address record `t` of the same run; NULL for anything else. */
const CNAME_TARGET = (d: string, t: string): string =>
  `LEFT JOIN {{t:dns_record}} ${t} ON ${t}.tenant_id = ${d}.tenant_id AND ${t}.run_id = ${d}.run_id AND ${d}.type = 'CNAME' AND ${t}.name = ${d}.content AND ${t}.type IN ('A', 'AAAA')`;

export type SurveyParams = { tenant_id: string; run_id: string; dns_run_id: string };
export type DnsSurveyParams = { tenant_id: string; dns_run_id: string };

/**
 * A proxied CNAME whose target in the same zone is a direct A or AAAA record: visitors to one name go
 * through Cloudflare, visitors to the other reach the origin, so the origin address the proxy hides is
 * published next door. The real case: www.<zone> proxied, the apex it aliases direct.
 */
export const PROXY_SPLIT_SQL = `SELECT c.zone, c.name AS proxied_name, c.record_id AS proxied_record_id, a.name AS target_name, a.type AS target_type,
       a.content AS target_content, a.record_id AS target_record_id, c.observed_at
FROM {{t:dns_record}} c
JOIN {{t:dns_record}} a ON a.tenant_id = c.tenant_id AND a.run_id = c.run_id AND a.name = c.content AND a.type IN ('A', 'AAAA') AND a.proxied = 0
WHERE c.tenant_id = {{p:tenant_id}} AND c.run_id = {{p:dns_run_id}} AND c.type = 'CNAME' AND c.proxied = 1
ORDER BY c.zone, c.name, c.record_id, a.record_id`;

export function proxySplit(dl: DataLayer, params: DnsSurveyParams, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(PROXY_SPLIT_SQL, params, opts);
}

/**
 * A proxied record (A, AAAA, or a CNAME one level from one) whose origin is a host in the inventory,
 * served there by an enabled server block that names it and trusts no real_ip range: the block logs,
 * rate-limits and allow-lists Cloudflare's addresses, not the visitor's. One row per record and block.
 */
export const PROXIED_WITHOUT_REAL_IP_SQL = `SELECT d.record_id, d.zone, d.name, d.type, COALESCE(t.content, d.content) AS origin, n.host,
       r.obs_id, r.object_id, r.setting_path, r.value_hash, r.value_redacted, r.observed_at, d.observed_at AS dns_observed_at
FROM {{t:dns_record}} d
${CNAME_TARGET("d", "t")}
JOIN {{t:inventory_asset}} i ON i.tenant_id = d.tenant_id AND i.address = COALESCE(t.content, d.content)
JOIN {{t:observation}} n ON n.tenant_id = d.tenant_id AND n.run_id = {{p:run_id}} AND n.host = i.host AND n.refers_to_type = 'dns_name' AND n.refers_to_id = d.name
  AND n.setting_path LIKE '%.server_name[%'
${ENABLED_OF("n", "e")} AND e.value_redacted = '1'
JOIN {{t:observation}} r ON r.run_id = n.run_id AND r.object_id = n.object_id AND r.setting_path LIKE '%.real_ip' AND r.value_redacted = 'absent'
  AND ${KEY_OF_TAIL8("r")} = ${KEY_OF_NAME("n")}
WHERE d.tenant_id = {{p:tenant_id}} AND d.run_id = {{p:dns_run_id}} AND d.type IN ('A', 'AAAA', 'CNAME') AND d.proxied = 1
ORDER BY d.name, d.record_id, r.object_id, r.setting_path`;

export function proxiedWithoutRealIp(dl: DataLayer, params: SurveyParams, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(PROXIED_WITHOUT_REAL_IP_SQL, params, opts);
}

/**
 * A proxied wildcard record pointing at an inventory host where nothing trusts a real_ip range: not
 * the http level (http.real_ip on nginx.conf is absent) and no enabled block. A wildcard covers names
 * the pseudonyms cannot match to a block, so the check is host-wide; a wildcard that is itself a
 * server_name is handled block by block above and left out here.
 */
export const WILDCARD_WITHOUT_REAL_IP_SQL = `SELECT d.record_id, d.zone, d.name, d.type, d.content AS origin, i.host,
       h.obs_id, h.object_id, h.setting_path, h.value_hash, h.value_redacted, h.observed_at, d.observed_at AS dns_observed_at
FROM {{t:dns_record}} d
JOIN {{t:inventory_asset}} i ON i.tenant_id = d.tenant_id AND i.address = d.content
JOIN {{t:observation}} h ON h.tenant_id = d.tenant_id AND h.run_id = {{p:run_id}} AND h.host = i.host AND h.setting_path = 'http.real_ip' AND h.value_redacted = 'absent'
WHERE d.tenant_id = {{p:tenant_id}} AND d.run_id = {{p:dns_run_id}} AND d.type IN ('A', 'AAAA') AND d.proxied = 1 AND d.name LIKE '*.%'
  AND NOT EXISTS (SELECT 1 FROM {{t:observation}} n WHERE n.run_id = h.run_id AND n.refers_to_type = 'dns_name' AND n.refers_to_id = d.name)
  AND NOT EXISTS (SELECT 1 FROM {{t:observation}} r JOIN {{t:observation}} e ON e.run_id = r.run_id AND e.object_id = r.object_id AND e.setting_path LIKE '%.enabled' AND ${KEY_OF_TAIL8("e")} = ${KEY_OF_TAIL8("r")}
    WHERE r.run_id = h.run_id AND r.setting_path LIKE '%.real_ip' AND r.setting_path <> 'http.real_ip' AND r.value_redacted <> 'absent' AND e.value_redacted = '1')
ORDER BY d.name, d.record_id, h.object_id`;

export function wildcardWithoutRealIp(dl: DataLayer, params: SurveyParams, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(WILDCARD_WITHOUT_REAL_IP_SQL, params, opts);
}

/**
 * A record (A, AAAA, or a CNAME one level from one) that lands on the host of the given run while no
 * enabled server block there names it: traffic for the name reaches nginx's default server. Wildcards
 * are left out, a wildcard is matched by no single server_name by design.
 */
export const ORPHAN_RECORD_SQL = `SELECT d.record_id, d.zone, d.name, d.type, d.content, COALESCE(t.content, d.content) AS origin, d.proxied, i.host, d.observed_at
FROM {{t:dns_record}} d
${CNAME_TARGET("d", "t")}
JOIN {{t:inventory_asset}} i ON i.tenant_id = d.tenant_id AND i.address = COALESCE(t.content, d.content)
JOIN {{t:collection_run}} c ON c.run_id = {{p:run_id}} AND c.host = i.host
WHERE d.tenant_id = {{p:tenant_id}} AND d.run_id = {{p:dns_run_id}} AND d.type IN ('A', 'AAAA', 'CNAME') AND d.name NOT LIKE '*.%'
  AND NOT EXISTS (SELECT 1 FROM {{t:observation}} n ${ENABLED_OF("n", "e")}
    WHERE n.run_id = c.run_id AND n.refers_to_type = 'dns_name' AND n.refers_to_id = d.name AND n.setting_path LIKE '%.server_name[%' AND e.value_redacted = '1')
ORDER BY d.name, d.record_id`;

export function orphanRecords(dl: DataLayer, params: SurveyParams, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(ORPHAN_RECORD_SQL, params, opts);
}

/**
 * A server_name in the run with no record of that name in the DNS run and no wildcard record covering
 * its zone (the .zone sibling, matched to a '*.<zone>' record). One row per file and name: the lowest
 * setting path of the blocks that carry it. A name in a file on disk but not enabled (a .bak, an
 * unlinked site) counts only when no enabled block in the run names it: the live copy is the finding,
 * the backup copy repeats it.
 */
export const ORPHAN_VHOST_SQL = `SELECT n.obs_id, n.host, n.object_id, n.setting_path, n.refers_to_id AS server_name, e.value_redacted AS enabled, n.value_hash, n.observed_at
FROM {{t:observation}} n
${ENABLED_OF("n", "e")}
WHERE n.tenant_id = {{p:tenant_id}} AND n.run_id = {{p:run_id}} AND n.refers_to_type = 'dns_name' AND n.setting_path LIKE '%.server_name[%'
  AND NOT EXISTS (SELECT 1 FROM {{t:dns_record}} d WHERE d.tenant_id = n.tenant_id AND d.run_id = {{p:dns_run_id}} AND d.name = n.refers_to_id)
  AND (e.value_redacted = '1' OR NOT EXISTS (SELECT 1 FROM {{t:observation}} n2 ${ENABLED_OF("n2", "e2")}
    WHERE n2.run_id = n.run_id AND n2.refers_to_type = 'dns_name' AND n2.refers_to_id = n.refers_to_id AND n2.setting_path LIKE '%.server_name[%' AND e2.value_redacted = '1'))
  AND NOT EXISTS (SELECT 1 FROM {{t:dns_record}} w JOIN {{t:observation}} z ON z.setting_path LIKE '%.zone' AND substr(w.name, 3) = z.value_redacted
    WHERE w.tenant_id = n.tenant_id AND w.run_id = {{p:dns_run_id}} AND w.name LIKE '*.%'
    AND z.run_id = n.run_id AND z.object_id = n.object_id AND substr(z.setting_path, 1, length(z.setting_path) - 5) = n.setting_path)
  AND NOT EXISTS (SELECT 1 FROM {{t:observation}} m WHERE m.run_id = n.run_id AND m.object_id = n.object_id AND m.refers_to_type = 'dns_name' AND m.refers_to_id = n.refers_to_id AND m.setting_path < n.setting_path)
ORDER BY n.host, n.object_id, n.refers_to_id, n.setting_path`;

export function orphanVhosts(dl: DataLayer, params: SurveyParams, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(ORPHAN_VHOST_SQL, params, opts);
}

/** How far back the tenant's audit log reaches: the window a survey finding, which has no previous observation, is checked over. */
export const AUDIT_SPAN_SQL = `SELECT MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at, COUNT(*) AS n
FROM {{t:audit_event}}
WHERE tenant_id = {{p:tenant_id}}`;

export function auditSpan(dl: DataLayer, tenantId: string, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(AUDIT_SPAN_SQL, { tenant_id: tenantId }, opts);
}
