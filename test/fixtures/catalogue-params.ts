// Sample parameters per catalogue template, all taken from sample/bundle.json, and the row count each
// returns there. Shared by the template tests and the engine parity test, so the live Zetaris half
// covers every template's SQL (UNION ALL, non-equi self-joins, CASE, correlated NOT EXISTS).
import type { Params } from "../../src/data/layer.ts";

export const T = "client-a";
export const HASH_PW_NO = "sha256:a40f0855ae03c0fd9af19e96febe3185157acb415ff3f61683e5e0b7a6bf294c";
export const HASH_PW_YES = "sha256:5664774c114b847f734518d5282c366536e28757b489ce9ce343d40bcdea5e05";

export const SAMPLE: Record<string, Params> = {
  host_in_inventory: { tenant_id: T, address: "198.51.100.10" },
  dns_target_in_inventory: { tenant_id: T, name: "app.example.invalid", dns_run_id: "run-dns-1023" },
  change_in_last_backup: { tenant_id: T, host: "host-7f1c", object_id: "/etc/ssh/sshd_config", setting_path: "PasswordAuthentication", value_hash: HASH_PW_NO },
  actor_attributed: { tenant_id: T, resource_id: "rec-a1", since: "2026-10-20T02:05:00.000Z", until: "2026-10-23T02:05:00.000Z" },
  previous_value_recoverable: { tenant_id: T, resource_id: "rec-a1" },
  restore_would_regress: { tenant_id: T, host: "host-7f1c" },
  referent_unchanged: { tenant_id: T, name: "app.example.invalid", since: "2026-10-20T00:00:00.000Z", until: "2026-10-23T23:59:59.000Z" },
  run_complete: { run_id: "run-nginx-2b9e-1023" },
  setting_matches_approved: { tenant_id: T, host: "host-7f1c", object_id: "/etc/ssh/sshd_config", setting_path: "PasswordAuthentication", run_id: "run-etc-7f1c-1023" },
  other_settings_reference: { tenant_id: T, refers_to_id: "app.example.invalid", run_id: "run-nginx-7f1c-1023", object_id: "/etc/nginx/conf.d/app.conf", setting_path: "server.location./.proxy_pass" },
  record_reverted: { tenant_id: T, resource_id: "rec-a1", since: "2026-10-20T00:00:00.000Z" },
  backup_recent: { tenant_id: T, host: "host-7f1c", since: "2026-10-20T00:00:00.000Z" },
};

/** Rows each template returns on the bundle with SAMPLE params (measured on sql.js, 23 Oct). */
export const SAMPLE_ROWS: Record<string, number> = {
  host_in_inventory: 1,
  dns_target_in_inventory: 1,
  change_in_last_backup: 0,
  actor_attributed: 1,
  previous_value_recoverable: 1,
  restore_would_regress: 1,
  referent_unchanged: 2,
  run_complete: 1,
  setting_matches_approved: 1,
  other_settings_reference: 0,
  record_reverted: 0,
  backup_recent: 2,
};
