// The eval runner's SQL: the reads that turn a history item into a finding and the evidence rows a judge
// or the C4 baseline is handed. Portable subset (src/data/layer.ts): {{t:}} tables, {{p:}} parameters,
// one SELECT, plain column comparisons in every top-level WHERE, total ORDER BY.
//
// Contract.
//   AUDIT_OF_RESOURCE_SQL  every audit event of one resource of the tenant other than a read ('view'), in
//                          occurred_at then event_id order: a record's change sequence.
//   DELETES_IN_WINDOW_SQL  every 'delete' event of the tenant with since <= occurred_at < until, in the same
//                          order: the deletions of one day.
//   EVIDENCE_SQL           the rows a finding rests on, as one table of text columns (source, row_id, object,
//                          field, value, detail, at): the observation of its setting in its run, its record in
//                          the DNS run, the record's audit events and the host's backup items of the setting.
//                          A parameter the finding lacks is bound as '' and its branch returns nothing.
// EVAL_PARITY_CASES holds one case per query over the rows of sample/bundle.json, for test/parity.test.ts.
//
// Measured 24 Oct 2026 on test/fixtures/recorded-bundle.json (test/eval.test.ts): the proxied www record's
// audit sequence is 3 updates on 2026-04-16; 2026-10-11 holds 8 deletions; the evidence of the proxy_split
// finding is 4 rows (its record and its 3 audit updates), of a changed_since_backup finding 1 (its file).

import type { FindingSummary } from "../catalogue/select.ts";
import type { Params } from "../data/layer.ts";

export const AUDIT_OF_RESOURCE_SQL = `SELECT event_id, actor, action, resource_type, resource_id, old_value, new_value, occurred_at
FROM {{t:audit_event}}
WHERE tenant_id = {{p:tenant_id}} AND resource_id = {{p:resource_id}} AND action <> 'view'
ORDER BY occurred_at, event_id`;

export const DELETES_IN_WINDOW_SQL = `SELECT event_id, actor, action, resource_type, resource_id, old_value, new_value, occurred_at
FROM {{t:audit_event}}
WHERE tenant_id = {{p:tenant_id}} AND action = 'delete' AND occurred_at >= {{p:since}} AND occurred_at < {{p:until}}
ORDER BY occurred_at, event_id`;

export const EVIDENCE_SQL = `SELECT 'observation' AS source, o.obs_id AS row_id, o.object_id AS object, o.setting_path AS field, o.value_redacted AS value, o.value_hash AS detail, o.observed_at AS at
FROM {{t:observation}} o
WHERE o.tenant_id = {{p:tenant_id}} AND o.run_id = {{p:run_id}} AND o.object_id = {{p:object_id}} AND o.setting_path = {{p:setting_path}}
UNION ALL
SELECT 'dns_record' AS source, d.record_id AS row_id, d.name AS object, d.type AS field, d.content AS value, CASE WHEN d.proxied = 1 THEN 'proxied' ELSE 'direct' END AS detail, d.observed_at AS at
FROM {{t:dns_record}} d
WHERE d.tenant_id = {{p:tenant_id}} AND d.run_id = {{p:dns_run_id}} AND d.record_id = {{p:resource_id}}
UNION ALL
SELECT 'audit_event' AS source, e.event_id AS row_id, e.resource_id AS object, e.action AS field, e.new_value AS value, e.old_value AS detail, e.occurred_at AS at
FROM {{t:audit_event}} e
WHERE e.tenant_id = {{p:tenant_id}} AND e.resource_id = {{p:resource_id}} AND e.action <> 'view'
UNION ALL
SELECT 'backup_item' AS source, b.snapshot_id AS row_id, b.object_id AS object, b.setting_path AS field, b.value_hash AS value, s.kind AS detail, s.taken_at AS at
FROM {{t:backup_item}} b
JOIN {{t:backup_snapshot}} s ON s.snapshot_id = b.snapshot_id
WHERE s.tenant_id = {{p:tenant_id}} AND s.host = {{p:host}} AND b.object_id = {{p:object_id}} AND b.setting_path = {{p:setting_path}}
ORDER BY source, at, row_id`;

/** EVIDENCE_SQL's parameters read off a finding; a field the finding lacks binds as ''. */
export function evidenceParams(f: FindingSummary): Params {
  return {
    tenant_id: f.tenant_id, run_id: f.run_id, object_id: f.object_id, setting_path: f.setting_path,
    dns_run_id: f.dns_run_id ?? "", resource_id: f.resource_id ?? "", host: f.host ?? "",
  };
}

const T = "client-1";
const DNS_RUN = "run-f9470e2f5f175899";
const WWW_RECORD = "bce1ca2bb7caa2de9b6823d5f6ecd3f2";
const QUEST_FILE = "/etc/nginx/sites-available/host-4c795e.quest";
const SITES_HOST = "host-4b4dc1";

/** One parity case per eval query over sample/bundle.json: the shape test/parity.test.ts's CASES take. */
export const EVAL_PARITY_CASES: readonly { name: string; sql: string; params: Params }[] = [
  { name: "eval: audit sequence of the proxied www record", sql: AUDIT_OF_RESOURCE_SQL, params: { tenant_id: T, resource_id: WWW_RECORD } },
  { name: "eval: deletions of 2026-10-11", sql: DELETES_IN_WINDOW_SQL, params: { tenant_id: T, since: "2026-10-11T00:00:00.000Z", until: "2026-10-12T00:00:00.000Z" } },
  {
    name: "eval: evidence of the proxied www record",
    sql: EVIDENCE_SQL,
    params: { tenant_id: T, run_id: DNS_RUN, object_id: WWW_RECORD, setting_path: "proxied", dns_run_id: DNS_RUN, resource_id: WWW_RECORD, host: "" },
  },
  {
    name: "eval: evidence of the sites host's quest file",
    sql: EVIDENCE_SQL,
    params: { tenant_id: T, run_id: "run-15638d43819ba756", object_id: QUEST_FILE, setting_path: "file", dns_run_id: DNS_RUN, resource_id: "", host: SITES_HOST },
  },
];
