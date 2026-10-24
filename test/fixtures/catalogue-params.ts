// Sample parameters per catalogue template, all taken from sample/bundle.json (the recorded, redacted
// collection of 24 Oct 2026: one tenant, two hosts, one Cloudflare account), and the row count each
// returns there. Shared by the template tests and the engine parity test, so the live Zetaris half covers
// every template's SQL (UNION ALL, non-equi self-joins, CASE, correlated NOT EXISTS) over the same rows.
//
// The ids are the deterministic ones the collectors wrote (rows.ts stableId over tenant, surface, host and
// start time), so they change only when the bundle is re-recorded (last: 24 Oct 07:58 UTC, after the
// collector fixes of that night); the names are pseudonyms under the tenant's salt and did not change.
// The two hosts are named by their layout here, confd and sites, never by the operator's aliases. WWW is
// the proxied CNAME record whose April 2026 flips the audit log holds.
import type { Params } from "../../src/data/layer.ts";

export const T = "client-1";
export const DNS_RUN = "run-f9470e2f5f175899";
export const AUDIT_RUN = "run-507c9939230e60a4";
/** The conf.d host: 24 vhost files, the proxied wildcard lands here. */
export const CONFD_RUN = "run-67f4d6923cb4838d";
export const CONFD_HOST = "host-aa516a";
/** The sites-enabled host: 14 vhost files, the one block with set_real_ip_from. */
export const SITES_RUN = "run-15638d43819ba756";
export const SITES_HOST = "host-4b4dc1";
/** www.<zone> (host-524b42.quest): proxied CNAME to the direct apex host-4c795e.quest; three updates on 2026-04-16. */
export const WWW_RECORD = "bce1ca2bb7caa2de9b6823d5f6ecd3f2";
export const WWW_NAME = "host-524b42.quest";
export const APEX_NAME = "host-4c795e.quest";
export const APEX_RECORD = "f32e72c0d010752462567852ca872d12";
/** The sites-enabled host's vhost file that serves apex and www, and its live bytes' hash (a `file` row: plain sha256, so it compares with the export copy), which the latest export tarball also holds. */
export const QUEST_FILE = "/etc/nginx/sites-available/host-4c795e.quest";
export const QUEST_HASH = "sha256:fa428e0f6c3c93a7b22c4f1fe0299ff675ab6500c412fcc6916d18007eaf4711";
export const SITES_ORIGIN = "ip-6fb86d";
export const CONFD_ORIGIN = "ip-6b6bba";

export const SAMPLE: Record<string, Params> = {
  host_in_inventory: { tenant_id: T, address: SITES_ORIGIN },
  dns_target_in_inventory: { tenant_id: T, name: APEX_NAME, dns_run_id: DNS_RUN },
  change_in_last_backup: { tenant_id: T, host: SITES_HOST, object_id: QUEST_FILE, setting_path: "file", value_hash: QUEST_HASH },
  actor_attributed: { tenant_id: T, resource_id: WWW_RECORD, since: "2026-04-16T00:00:00.000Z", until: "2026-04-17T00:00:00.000Z" },
  previous_value_recoverable: { tenant_id: T, resource_id: WWW_RECORD },
  restore_would_regress: { tenant_id: T, host: SITES_HOST },
  referent_unchanged: { tenant_id: T, name: WWW_NAME, since: "2026-04-01T00:00:00.000Z", until: "2026-05-01T00:00:00.000Z" },
  run_complete: { run_id: CONFD_RUN },
  setting_matches_approved: { tenant_id: T, host: SITES_HOST, object_id: QUEST_FILE, setting_path: "file", run_id: SITES_RUN },
  other_settings_reference: { tenant_id: T, refers_to_id: WWW_NAME, run_id: SITES_RUN, object_id: QUEST_FILE, setting_path: `server[${APEX_NAME}:443].server_name[${WWW_NAME}]` },
  record_reverted: { tenant_id: T, resource_id: WWW_RECORD, since: "2026-04-01T00:00:00.000Z" },
  backup_recent: { tenant_id: T, host: SITES_HOST, since: "2026-10-20T00:00:00.000Z" },
};

/** Rows each template returns with SAMPLE params on test/fixtures/recorded-bundle.json, the 07:58 UTC export these ids come from (measured on sql.js, 24 Oct). */
export const SAMPLE_ROWS: Record<string, number> = {
  host_in_inventory: 1,
  dns_target_in_inventory: 0,
  change_in_last_backup: 1,
  actor_attributed: 2,
  previous_value_recoverable: 1,
  restore_would_regress: 0,
  referent_unchanged: 3,
  run_complete: 0,
  setting_matches_approved: 0,
  other_settings_reference: 1,
  record_reverted: 0,
  backup_recent: 5,
};
