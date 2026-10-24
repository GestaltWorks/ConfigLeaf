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

// ---- the detectors: drift from approval, change since backup, FOUND-BUT-DIFFERENT ----------------------------
//
// One run each, in the portable subset and under both Zetaris measurements above: COALESCE sits in JOIN ON
// or in a correlated subquery's WHERE, every correlation sits in a subquery's WHERE, and the top-level WHERE
// holds plain column comparisons only. The pass runs them over the latest passing run of each (tenant,
// surface, host) and over the tenant's latest passing DNS run (src/pipeline.ts, the survey step). Every
// ORDER BY ends on a key, so both engines return one row order. Measured live 24 Oct 2026 on Zetaris
// 2.4.3.1 over the datasource holding sample/bundle.json (test/parity.test.ts): drift_vs_approved over
// approvals added as a derived table (1 row), changed_since_backup on both hosts (6 and 5 rows: the
// certbot renewal configs, absent from that bundle's backup_item rows, which held each newest export's
// etc/nginx members) and found_but_different (0 rows: the bundle records no fingerprint) return the
// columns, rows and totals sql.js returns.

export type DriftParams = { tenant_id: string; run_id: string };
export type BackupDiffParams = { tenant_id: string; run_id: string; host: string };
export type FoundButDifferentParams = { tenant_id: string; run_id: string; prev_run_id: string };

/**
 * drift_vs_approved: the settings of one run whose live value differs from their latest approval. A
 * setting's key is (tenant, surface, host, object_id, setting_path), host compared with NULL as a value,
 * so a record's approval (host NULL) meets the per-field observation of the DNS run that the Cloudflare
 * collector writes. The latest approval of a key is the one with no approval of the same key at a later
 * approved_at; at an equal approved_at the greater approval_id is the latest. One row per drifted setting:
 * the live hash and display value, the approved hash, when and by whom it was approved, and what the live
 * value refers to. A setting whose latest approval holds the live value gives no row, and so does a
 * setting with no approval.
 */
export const DRIFT_VS_APPROVED_SQL = `SELECT o.surface, o.host, o.object_id, o.setting_path, o.value_hash, o.value_redacted,
       a.value_hash AS approved_hash, a.approved_at, a.approved_by, o.refers_to_type, o.refers_to_id, o.observed_at
FROM {{t:observation}} o
JOIN {{t:approved_setting}} a ON a.tenant_id = o.tenant_id AND a.surface = o.surface AND a.object_id = o.object_id
  AND a.setting_path = o.setting_path AND COALESCE(a.host, '') = COALESCE(o.host, '')
WHERE o.tenant_id = {{p:tenant_id}} AND o.run_id = {{p:run_id}} AND a.value_hash <> o.value_hash
  AND NOT EXISTS (SELECT 1 FROM {{t:approved_setting}} n WHERE n.tenant_id = a.tenant_id AND n.surface = a.surface AND n.object_id = a.object_id
    AND n.setting_path = a.setting_path AND COALESCE(n.host, '') = COALESCE(a.host, '')
    AND (n.approved_at > a.approved_at OR (n.approved_at = a.approved_at AND n.approval_id > a.approval_id)))
ORDER BY o.surface, o.object_id, o.setting_path, o.obs_id`;

export function driftVsApproved(dl: DataLayer, params: DriftParams, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(DRIFT_VS_APPROVED_SQL, params, opts);
}

/**
 * changed_since_backup: the `file` settings of one nginx run of the host whose bytes the host's newest
 * backup_snapshot lacks or holds with another hash. backup_item holds every regular-file member of the
 * newest export tarball (src/collectors/linux.ts), so every file the collector fetches is compared, the
 * certbot renewal configs beside the nginx files. The newest snapshot is the one with no snapshot of the
 * same tenant and host at a later taken_at; at an equal taken_at the greater snapshot_id is the newest.
 * backup_hash is '' for a file the snapshot lacks. A host with no snapshot gives no row; backup_recent is
 * the check that says so.
 */
export const CHANGED_SINCE_BACKUP_SQL = `SELECT o.host, o.object_id, o.setting_path, o.value_hash, COALESCE(b.value_hash, '') AS backup_hash,
       s.snapshot_id, s.taken_at, o.observed_at
FROM {{t:observation}} o
JOIN {{t:backup_snapshot}} s ON s.tenant_id = o.tenant_id AND s.host = o.host
LEFT JOIN {{t:backup_item}} b ON b.snapshot_id = s.snapshot_id AND b.object_id = o.object_id AND b.setting_path = o.setting_path
WHERE o.tenant_id = {{p:tenant_id}} AND o.run_id = {{p:run_id}} AND o.host = {{p:host}} AND o.setting_path = 'file'
  AND (b.value_hash IS NULL OR b.value_hash <> o.value_hash)
  AND NOT EXISTS (SELECT 1 FROM {{t:backup_snapshot}} x WHERE x.tenant_id = s.tenant_id AND x.host = s.host
    AND (x.taken_at > s.taken_at OR (x.taken_at = s.taken_at AND x.snapshot_id > s.snapshot_id)))
ORDER BY o.object_id, o.obs_id`;

export function changedSinceBackup(dl: DataLayer, params: BackupDiffParams, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(CHANGED_SINCE_BACKUP_SQL, params, opts);
}

/**
 * FOUND-BUT-DIFFERENT as one comparison: a dns_name setting of run_id whose value_hash equals its
 * observation in prev_run_id (the previous passing run of the same tenant, surface and host) while the
 * fingerprint of the name it refers to differs between the two observations. The fingerprints are
 * referent_fingerprint rows, which the pass writes (src/data/fingerprint.ts): each observation's is its
 * row against the latest DNS run it was fingerprinted against (greatest resolved_at, then the greater
 * dns_run_id). An observation with no fingerprint row gives no row. Measured 24 Oct 2026 on
 * test/fixtures/authored-bundle.json: the one setting DriftWorld.foundButDifferent flags and the pass
 * reports as found_but_different (test/datalayer.test.ts).
 */
export const FOUND_BUT_DIFFERENT_SQL = `SELECT o.host, o.object_id, o.setting_path, o.value_hash, o.refers_to_id AS name,
       p.obs_id AS prev_obs_id, pf.dns_run_id AS prev_dns_run_id, pf.fingerprint AS before_fingerprint, p.observed_at AS prev_observed_at,
       o.obs_id, f.dns_run_id, f.fingerprint AS after_fingerprint, o.observed_at
FROM {{t:observation}} o
JOIN {{t:observation}} p ON p.tenant_id = o.tenant_id AND p.run_id = {{p:prev_run_id}} AND p.surface = o.surface
  AND p.object_id = o.object_id AND p.setting_path = o.setting_path AND p.value_hash = o.value_hash
JOIN {{t:referent_fingerprint}} f ON f.obs_id = o.obs_id
JOIN {{t:referent_fingerprint}} pf ON pf.obs_id = p.obs_id AND pf.fingerprint <> f.fingerprint
WHERE o.tenant_id = {{p:tenant_id}} AND o.run_id = {{p:run_id}} AND o.refers_to_type = 'dns_name'
  AND NOT EXISTS (SELECT 1 FROM {{t:referent_fingerprint}} x WHERE x.obs_id = f.obs_id
    AND (x.resolved_at > f.resolved_at OR (x.resolved_at = f.resolved_at AND x.dns_run_id > f.dns_run_id)))
  AND NOT EXISTS (SELECT 1 FROM {{t:referent_fingerprint}} y WHERE y.obs_id = pf.obs_id
    AND (y.resolved_at > pf.resolved_at OR (y.resolved_at = pf.resolved_at AND y.dns_run_id > pf.dns_run_id)))
ORDER BY o.host, o.object_id, o.setting_path, o.obs_id`;

export function foundButDifferentSql(dl: DataLayer, params: FoundButDifferentParams, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(FOUND_BUT_DIFFERENT_SQL, params, opts);
}

// ---- the Decider's reads: the policy, the approvals, the vault copies, the probes ----------------------------
//
// What src/pipeline.ts reads before src/policy/decide.ts decides. Plain column comparisons in every top-level
// WHERE, COALESCE only inside a correlated subquery's WHERE, every ORDER BY ending on a key. Measured 24 Oct
// 2026 on test/fixtures/policy-bundle.json through sql.js (test/pipeline.test.ts): the 11 hackathon rules, the
// latest approval of each of the 8 approved settings, one copy of each drifted file's approved bytes with its
// latest validation (app.conf ok, shop.conf fail, api.conf none) and the record's cf-schema copy, the six probes.
// Measured live 24 Oct 2026 on Zetaris 2.4.3.1 over the datasource holding sample/bundle.json, each query over the
// bundle and over derived tables (DataLayer overlays) that give it rows (policy rules of "*", of the tenant and of
// another tenant; every sites-host file approved twice; a copy of each with a failed then a passing validation;
// one probe per A record; one disposition per file): 12 of 12 cases return the columns, rows and totals sql.js returns.

/** The policy rules that can govern the tenant's settings: its own and every "*" rule, in rule_id order. */
export const POLICY_RULES_SQL = `SELECT rule_id, tenant_id, surface, object_glob, setting_glob, criticality, lock, on_drift, on_no_copy, hold_max_hours,
       alert, psa_priority, version, author, since, note
FROM {{t:policy_rule}}
WHERE tenant_id = {{p:tenant_id}} OR tenant_id = '*'
ORDER BY rule_id`;

export function policyRules(dl: DataLayer, tenantId: string, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(POLICY_RULES_SQL, { tenant_id: tenantId }, opts);
}

/**
 * The latest approval of every setting key of the tenant (surface, host with NULL as a value, object_id,
 * setting_path), by the rule DRIFT_VS_APPROVED_SQL uses: no approval of the same key at a later approved_at,
 * and at an equal approved_at the greater approval_id. In approval_id order.
 */
export const LATEST_APPROVALS_SQL = `SELECT a.approval_id, a.surface, a.host, a.object_id, a.setting_path, a.value_hash, a.approved_at, a.approved_by
FROM {{t:approved_setting}} a
WHERE a.tenant_id = {{p:tenant_id}}
  AND NOT EXISTS (SELECT 1 FROM {{t:approved_setting}} n WHERE n.tenant_id = a.tenant_id AND n.surface = a.surface AND n.object_id = a.object_id
    AND n.setting_path = a.setting_path AND COALESCE(n.host, '') = COALESCE(a.host, '')
    AND (n.approved_at > a.approved_at OR (n.approved_at = a.approved_at AND n.approval_id > a.approval_id)))
ORDER BY a.approval_id`;

export function latestApprovals(dl: DataLayer, tenantId: string, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(LATEST_APPROVALS_SQL, { tenant_id: tenantId }, opts);
}

export type ApprovedCopyParams = { tenant_id: string; surface: string; host: string; object_id: string; setting_path: string; approved_hash: string };

/**
 * The vault copies of one object that hold an approved value, each with its latest validation (the greatest
 * validated_at, then the greater validation_id; every column of it "" when the copy has no validation).
 * A copy holds the approved value when its blob_sha256 is the approved hash (a file's exact bytes) or when
 * its run's observation of the setting carries the approved hash (a record field, whose copy is the record's
 * JSON). host is '' for an object with no host. In taken_at, then copy_id order.
 */
export const APPROVED_COPIES_SQL = `SELECT v.copy_id, v.run_id, v.git_commit, v.blob_sha256, v.taken_at, o.value_hash,
       c.validation_id, c.validator, c.result, c.missing_dependencies, c.validated_at
FROM {{t:vault_copy}} v
LEFT JOIN {{t:observation}} o ON o.tenant_id = v.tenant_id AND o.run_id = v.run_id AND o.object_id = v.object_id AND o.setting_path = {{p:setting_path}}
LEFT JOIN {{t:copy_validation}} c ON c.copy_id = v.copy_id
WHERE v.tenant_id = {{p:tenant_id}} AND v.surface = {{p:surface}} AND v.object_id = {{p:object_id}}
  AND (v.host = {{p:host}} OR (v.host IS NULL AND {{p:host}} = ''))
  AND (v.blob_sha256 = {{p:approved_hash}} OR o.value_hash = {{p:approved_hash}})
  AND NOT EXISTS (SELECT 1 FROM {{t:copy_validation}} x WHERE x.copy_id = v.copy_id
    AND (x.validated_at > c.validated_at OR (x.validated_at = c.validated_at AND x.validation_id > c.validation_id)))
ORDER BY v.taken_at, v.copy_id`;

export function approvedCopies(dl: DataLayer, params: ApprovedCopyParams, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(APPROVED_COPIES_SQL, params, opts);
}

/** Every probe row of one probe run of the tenant, in probe_id order. */
export const PROBES_OF_RUN_SQL = `SELECT probe_id, run_id, kind, target, expected, observed, status, latency_ms, observed_at
FROM {{t:probe}}
WHERE tenant_id = {{p:tenant_id}} AND run_id = {{p:run_id}}
ORDER BY probe_id`;

export function probesOfRun(dl: DataLayer, params: { tenant_id: string; run_id: string }, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(PROBES_OF_RUN_SQL, params, opts);
}

/** Every disposition the ledger holds, in disposition_id order. */
export const DISPOSITIONS_SQL = `SELECT disposition_id, tenant_id, surface, host, object_id, setting_path, value_hash, verb, reason, expires_at,
       decided_by, rule_id, finding_id, run_id, decided_at
FROM {{t:disposition}}
ORDER BY disposition_id`;

/** How far back the tenant's audit log reaches: the window a survey finding, which has no previous observation, is checked over. */
export const AUDIT_SPAN_SQL = `SELECT MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at, COUNT(*) AS n
FROM {{t:audit_event}}
WHERE tenant_id = {{p:tenant_id}}`;

export function auditSpan(dl: DataLayer, tenantId: string, opts?: RunOptions): Promise<QueryResult> {
  return dl.run(AUDIT_SPAN_SQL, { tenant_id: tenantId }, opts);
}
