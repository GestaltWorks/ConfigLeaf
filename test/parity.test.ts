// Engine parity. The sql.js half always runs. The Zetaris half runs only with PARITY_LIVE=true and a
// configured key, and expects the registered datasource to hold exactly the rows of sample/bundle.json
// (what `npm run export:bundle` wrote from it); otherwise it is skipped (test.skipIf) and one line says so.
// Measured live 24 Oct 2026 on 2.4.3.1 after the first real collection: every case equal, columns, rows
// and totals, the survey queries' instr/substr/length/COALESCE included. Measured live again on 24 Oct
// 2026 with the three detectors among the cases, drift_vs_approved over a derived approved_setting
// (DataLayer overlays): 108 of 108 equal. Measured live 24 Oct 2026 over the export of the 19:56 UTC
// re-collection (nine runs, 2,414 observations, the policy, 333 approvals, 112 vault copies and validations,
// 111 probes), the Decider's five reads among the 66 cases: 132 of 132 equal. Measured live 24 Oct 2026 over the export
// of the 21:21 UTC collection (14 runs, 3,766 observations, 154 backup items, 224 vault copies and validations, 222
// probes), 68 cases: 136 of 136 equal.
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { DataLayer, type Overlays, type Params } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { ZetarisEngine } from "../src/data/engines/zetaris.ts";
import {
  APPROVED_COPIES_SQL, AUDIT_SPAN_SQL, CHANGED_SINCE_BACKUP_SQL, DISPOSITIONS_SQL, DRIFT_VS_APPROVED_SQL, FOUND_BUT_DIFFERENT_SQL, HERO_SQL, LATEST_APPROVALS_SQL,
  OBSERVATIONS_SQL, ORPHAN_RECORD_SQL, ORPHAN_VHOST_SQL, POLICY_RULES_SQL, PROBES_OF_RUN_SQL, PROXIED_WITHOUT_REAL_IP_SQL, PROXY_SPLIT_SQL, RESOLUTIONS_SQL,
  RUNS_SQL, RUN_COMPLETE_SQL, WILDCARD_WITHOUT_REAL_IP_SQL,
} from "../src/data/queries.ts";
import { SCHEMA_TABLES } from "../src/data/schema.ts";
import { CATALOGUE } from "../src/catalogue/templates.ts";
import bundle from "../sample/bundle.json" with { type: "json" };
import { CONFD_HOST, DNS_RUN, CONFD_RUN, QUEST_FILE, QUEST_HASH, SITES_HOST, SITES_RUN, SAMPLE, SAMPLE_ROWS, T } from "./fixtures/catalogue-params.ts";

/** NOT NULL key columns per table, so ORDER BY is total and never depends on an engine's NULL ordering. */
const ORDER: Record<string, string> = {
  collection_run: "run_id",
  observation: "obs_id",
  approved_setting: "approval_id",
  backup_snapshot: "snapshot_id",
  backup_item: "snapshot_id, object_id, setting_path",
  dns_record: "run_id, record_id",
  audit_event: "event_id",
  inventory_asset: "asset_id",
  policy_rule: "rule_id",
  vault_copy: "copy_id",
  copy_validation: "validation_id",
  probe: "probe_id",
  disposition: "disposition_id",
  action: "action_id",
  ticket: "ticket_id",
  referent_fingerprint: "obs_id, dns_run_id",
};

/**
 * The export nulls value_redacted over 2 kB (store.ts VALUE_MAX_BYTES) while the datasource keeps the
 * text, so the observation table case leaves that column out and a second case compares it on every row
 * that is not a file body (the 30 nulled rows are all `file` rows). Not `WHERE length(value_redacted) <=
 * 2048`: measured 24 Oct, a function inside a top-level WHERE on a DRIFT table is dropped at pushdown and
 * every row comes back (`WHERE length(value_redacted) > 2048` counted all 1068); the catalogue's top-level
 * predicates are plain column comparisons, and its substr/instr sit in JOIN ON and correlated subqueries,
 * which this test shows evaluate alike.
 */
const columnsOf = (t: { name: string; columns: string[] }): string =>
  t.columns.filter((c) => !(t.name === "observation" && c === "value_redacted")).join(", ");

interface Case {
  name: string; sql: string; params: Params; rows?: number;
  /** Applied to both engines' rows before they are compared. */ mask?: (row: string[], columns: string[]) => string[];
  /** Derived tables in place of base tables for this case (DataLayer overlays), the same text on both engines. */ overlays?: Overlays;
}

const confd = { tenant_id: T, run_id: CONFD_RUN, dns_run_id: DNS_RUN };
const sites = { tenant_id: T, run_id: SITES_RUN, dns_run_id: DNS_RUN };

/**
 * drift_vs_approved over approvals added for the case: every `file` setting of the sites-enabled host's run
 * approved at its live hash, one vhost file at another hash, as a derived approved_setting dated after every
 * stored approval, so each added one is its setting's latest. The detector then returns that one file on both engines.
 */
const APPROVED_SITES_FILES: Overlays = {
  approved_setting: `SELECT approval_id, tenant_id, surface, host, object_id, setting_path, value_hash, approved_at, approved_by, note FROM {{t:approved_setting}}
UNION ALL
SELECT obs_id AS approval_id, tenant_id, surface, host, object_id, setting_path,
       CASE WHEN object_id = '${QUEST_FILE}' THEN 'sha256:${"0".repeat(64)}' ELSE value_hash END AS value_hash,
       '9999-12-31T23:59:59.999Z' AS approved_at, 'parity' AS approved_by, source AS note
FROM {{t:observation}} WHERE run_id = '${SITES_RUN}' AND setting_path = 'file'`,
};

/**
 * changed_since_backup on the bundle exported 24 Oct 2026 after the 21:21 UTC collection, whose backup_item holds every
 * regular member of each host's newest tarball: every fetched file of both runs equals its copy there, so 0 rows each.
 * The overlaid cases leave the backup's certbot renewal configs out, the partial inventory of the earlier exports, and
 * the detector returns those files: 6 on the conf.d host, 5 on the sites-enabled host.
 */
const BACKUP_DIFF = { confd: 0, sites: 0 };
const NO_RENEWALS: Overlays = {
  backup_item: `SELECT snapshot_id, object_id, setting_path, value_hash FROM {{t:backup_item}} WHERE object_id NOT LIKE '/etc/letsencrypt/renewal/%'`,
};

/**
 * setting_matches_approved with SAMPLE params over this bundle's own approvals: those of the QUEST file at the hash
 * its SITES_RUN observation carries (SAMPLE_ROWS holds the count on the 07:58 export, which had no approval).
 */
const QUEST_APPROVALS = (bundle.approved_setting as { tenant_id: string; host: string | null; object_id: string; setting_path: string; value_hash: string }[])
  .filter((a) => a.tenant_id === T && (a.host === SITES_HOST || a.host === null) && a.object_id === QUEST_FILE && a.setting_path === "file"
    && bundle.observation.some((o) => o.run_id === SITES_RUN && o.object_id === QUEST_FILE && o.setting_path === "file" && o.value_hash === a.value_hash)).length;

/** The Decider's reads (src/pipeline.ts) over the bundle's own rows and over derived rows that widen them. */
const one = `FROM {{t:collection_run}} WHERE run_id = '${DNS_RUN}'`;
/** Three more rules: a "*" rule, the tenant's own at version 2, another tenant's (which the tenant's read leaves out). */
const POLICY: Overlays = {
  policy_rule: `SELECT rule_id, tenant_id, surface, object_glob, setting_glob, criticality, lock, on_drift, on_no_copy, hold_max_hours, alert, psa_priority, version, author, since, note FROM {{t:policy_rule}}
UNION ALL
SELECT 'rule-00000000000000a1' AS rule_id, '*' AS tenant_id, 'linux.nginx' AS surface, '/etc/nginx/conf.d/*.conf' AS object_glob, 'file' AS setting_glob, 'critical' AS criticality,
       1 AS lock, 'rollback' AS on_drift, 'investigate_ticket' AS on_no_copy, 24 AS hold_max_hours, 'on_fix' AS alert, 'P1' AS psa_priority, 1 AS version, 'operator' AS author,
       '2026-10-25T00:00:00.000Z' AS since, 'a served vhost file' AS note ${one}
UNION ALL
SELECT 'rule-00000000000000b2' AS rule_id, '${T}' AS tenant_id, 'cloudflare.dns' AS surface, '*' AS object_glob, 'content' AS setting_glob, 'critical' AS criticality,
       1 AS lock, 'rollback' AS on_drift, 'investigate_ticket' AS on_no_copy, 4 AS hold_max_hours, 'always' AS alert, 'P1' AS psa_priority, 2 AS version, 'operator' AS author,
       '2026-10-25T00:00:00.000Z' AS since, 'where a name points' AS note ${one}
UNION ALL
SELECT 'rule-00000000000000c3' AS rule_id, 'client-2' AS tenant_id, '*' AS surface, '**' AS object_glob, '**' AS setting_glob, 'normal' AS criticality,
       0 AS lock, 'hold' AS on_drift, 'ticket' AS on_no_copy, 72 AS hold_max_hours, 'never' AS alert, 'P3' AS psa_priority, 1 AS version, 'operator' AS author,
       '2026-10-25T00:00:00.000Z' AS since, 'another tenant' AS note ${one}`,
};
/** Every file of the sites host's run approved twice more: at its live hash and, earlier, at another hash. */
const APPROVALS: Overlays = {
  approved_setting: `SELECT approval_id, tenant_id, surface, host, object_id, setting_path, value_hash, approved_at, approved_by, note FROM {{t:approved_setting}}
UNION ALL
SELECT obs_id AS approval_id, tenant_id, surface, host, object_id, setting_path, value_hash, observed_at AS approved_at, 'parity' AS approved_by, source AS note
FROM {{t:observation}} WHERE run_id = '${SITES_RUN}' AND setting_path = 'file'
UNION ALL
SELECT object_id AS approval_id, tenant_id, surface, host, object_id, setting_path, 'sha256:${"0".repeat(64)}' AS value_hash, '2026-01-01T00:00:00.000Z' AS approved_at, 'parity' AS approved_by, source AS note
FROM {{t:observation}} WHERE run_id = '${SITES_RUN}' AND setting_path = 'file'`,
};
/** A vault copy of every file of the sites host's run, validated twice (fail, then ok_with_gaps). */
const COPIES: Overlays = {
  vault_copy: `SELECT copy_id, tenant_id, surface, host, object_id, run_id, git_commit, blob_sha256, taken_at, source FROM {{t:vault_copy}}
UNION ALL
SELECT obs_id AS copy_id, tenant_id, surface, host, object_id, run_id, '5a14a89d0123456789abcdef0123456789abcdef' AS git_commit, value_hash AS blob_sha256, observed_at AS taken_at, 'collector' AS source
FROM {{t:observation}} WHERE run_id = '${SITES_RUN}' AND setting_path = 'file'`,
  copy_validation: `SELECT validation_id, copy_id, tenant_id, validator, result, missing_dependencies, output_redacted, validated_at FROM {{t:copy_validation}}
UNION ALL
SELECT obs_id AS validation_id, obs_id AS copy_id, tenant_id, 'nginx-t' AS validator, 'fail' AS result, '' AS missing_dependencies, 'nginx: test failed' AS output_redacted, '2026-10-24T09:00:00.000Z' AS validated_at
FROM {{t:observation}} WHERE run_id = '${SITES_RUN}' AND setting_path = 'file'
UNION ALL
SELECT object_id AS validation_id, obs_id AS copy_id, tenant_id, 'nginx-t' AS validator, 'ok_with_gaps' AS result, '/etc/letsencrypt/options-ssl-nginx.conf' AS missing_dependencies, 'nginx: test is successful' AS output_redacted, '2026-10-24T10:00:00.000Z' AS validated_at
FROM {{t:observation}} WHERE run_id = '${SITES_RUN}' AND setting_path = 'file'`,
};
/** One http probe per A record of the DNS run, in a probe run of its own. */
const PROBES: Overlays = {
  probe: `SELECT probe_id, run_id, tenant_id, kind, target, expected, observed, status, latency_ms, observed_at FROM {{t:probe}}
UNION ALL
SELECT record_id AS probe_id, 'run-00000000000000p1' AS run_id, tenant_id, 'http' AS kind, name AS target, 'answers (status below 500); cf-ray any' AS expected,
       'status 200 server=- cf-ray present' AS observed, 'ok' AS status, 10 AS latency_ms, observed_at
FROM {{t:dns_record}} WHERE run_id = '${DNS_RUN}' AND type = 'A'`,
};
/** One disposition per file of the sites host's run. */
const DISPOSITIONS: Overlays = {
  disposition: `SELECT disposition_id, tenant_id, surface, host, object_id, setting_path, value_hash, verb, reason, expires_at, decided_by, rule_id, finding_id, run_id, decided_at FROM {{t:disposition}}
UNION ALL
SELECT obs_id AS disposition_id, tenant_id, surface, host, object_id, setting_path, value_hash, 'HOLD' AS verb, 'held under the catch-all rule' AS reason, '2026-10-27T08:00:00.000Z' AS expires_at,
       'policy' AS decided_by, 'rule-00000000000000c3' AS rule_id, obs_id AS finding_id, run_id, '2026-10-24T08:00:00.000Z' AS decided_at
FROM {{t:observation}} WHERE run_id = '${SITES_RUN}' AND setting_path = 'file'`,
};
const copyParams = (host: string): Params => ({ tenant_id: T, surface: "linux.nginx", host, object_id: QUEST_FILE, setting_path: "file", approved_hash: QUEST_HASH });
const PROBE_RUN = bundle.collection_run.filter((r) => r.surface === "probe").map((r) => r.run_id).sort().at(-1) ?? "";
const rowsOf = (table: string): { tenant_id?: string; run_id?: string }[] => (bundle as unknown as Record<string, { tenant_id?: string; run_id?: string }[] | undefined>)[table] ?? [];

/** The file bodies the export nulled over 2 kB stay in the datasource: blank value_redacted on `file` rows on both sides, compare everything else. */
const noFileBodies = (row: string[], columns: string[]): string[] => {
  const sp = columns.indexOf("setting_path");
  const vr = columns.indexOf("value_redacted");
  return sp >= 0 && vr >= 0 && row[sp] === "file" ? row.map((v, i) => (i === vr ? "" : v)) : row;
};

const CASES: Case[] = [
  { name: "hero (confd host)", sql: HERO_SQL, params: confd, rows: 0 },
  { name: "hero (sites host)", sql: HERO_SQL, params: sites, rows: 0 },
  { name: "runComplete (complete host run)", sql: RUN_COMPLETE_SQL, params: { run_id: CONFD_RUN }, rows: 0 },
  { name: "runComplete (complete DNS run)", sql: RUN_COMPLETE_SQL, params: { run_id: DNS_RUN }, rows: 0 },
  { name: "runs", sql: RUNS_SQL, params: {}, rows: bundle.collection_run.length },
  { name: "observations of a run", sql: OBSERVATIONS_SQL, params: { run_id: SITES_RUN }, rows: bundle.observation.filter((o) => o.run_id === SITES_RUN).length, mask: noFileBodies },
  { name: "resolutions", sql: RESOLUTIONS_SQL, params: { run_id: SITES_RUN, dns_run_id: DNS_RUN } },
  { name: "proxy_split", sql: PROXY_SPLIT_SQL, params: { tenant_id: T, dns_run_id: DNS_RUN }, rows: 1 },
  { name: "proxied_without_real_ip (confd)", sql: PROXIED_WITHOUT_REAL_IP_SQL, params: confd, rows: 10 },
  { name: "proxied_without_real_ip (sites)", sql: PROXIED_WITHOUT_REAL_IP_SQL, params: sites, rows: 9 },
  { name: "wildcard_without_real_ip (confd)", sql: WILDCARD_WITHOUT_REAL_IP_SQL, params: confd, rows: 1 },
  { name: "wildcard_without_real_ip (sites)", sql: WILDCARD_WITHOUT_REAL_IP_SQL, params: sites, rows: 0 },
  { name: "orphan_record (confd)", sql: ORPHAN_RECORD_SQL, params: confd, rows: 1 },
  { name: "orphan_record (sites)", sql: ORPHAN_RECORD_SQL, params: sites, rows: 2 },
  { name: "orphan_vhost (confd)", sql: ORPHAN_VHOST_SQL, params: confd, rows: 0 },
  { name: "orphan_vhost (sites)", sql: ORPHAN_VHOST_SQL, params: sites, rows: 3 },
  { name: "audit span", sql: AUDIT_SPAN_SQL, params: { tenant_id: T }, rows: 1 },
  { name: "drift_vs_approved (confd)", sql: DRIFT_VS_APPROVED_SQL, params: { tenant_id: T, run_id: CONFD_RUN }, rows: 0 },
  { name: "drift_vs_approved (sites)", sql: DRIFT_VS_APPROVED_SQL, params: { tenant_id: T, run_id: SITES_RUN }, rows: 0 },
  { name: "drift_vs_approved (dns)", sql: DRIFT_VS_APPROVED_SQL, params: { tenant_id: T, run_id: DNS_RUN }, rows: 0 },
  { name: "drift_vs_approved (sites, every file approved, one at another hash)", sql: DRIFT_VS_APPROVED_SQL, params: { tenant_id: T, run_id: SITES_RUN }, rows: 1, overlays: APPROVED_SITES_FILES, mask: noFileBodies },
  { name: "changed_since_backup (confd)", sql: CHANGED_SINCE_BACKUP_SQL, params: { tenant_id: T, run_id: CONFD_RUN, host: CONFD_HOST }, rows: BACKUP_DIFF.confd },
  { name: "changed_since_backup (sites)", sql: CHANGED_SINCE_BACKUP_SQL, params: { tenant_id: T, run_id: SITES_RUN, host: SITES_HOST }, rows: BACKUP_DIFF.sites },
  { name: "changed_since_backup (confd, the backup's renewal configs left out)", sql: CHANGED_SINCE_BACKUP_SQL, params: { tenant_id: T, run_id: CONFD_RUN, host: CONFD_HOST }, overlays: NO_RENEWALS, rows: 6 },
  { name: "changed_since_backup (sites, the backup's renewal configs left out)", sql: CHANGED_SINCE_BACKUP_SQL, params: { tenant_id: T, run_id: SITES_RUN, host: SITES_HOST }, overlays: NO_RENEWALS, rows: 5 },
  { name: "found_but_different (confd)", sql: FOUND_BUT_DIFFERENT_SQL, params: { tenant_id: T, run_id: CONFD_RUN, prev_run_id: CONFD_RUN }, rows: 0 },
  { name: "found_but_different (sites)", sql: FOUND_BUT_DIFFERENT_SQL, params: { tenant_id: T, run_id: SITES_RUN, prev_run_id: SITES_RUN }, rows: 0 },
  { name: "observation values (every row but the file bodies)", sql: "SELECT obs_id, value_redacted FROM {{t:observation}} WHERE setting_path <> 'file' ORDER BY obs_id", params: {}, rows: bundle.observation.filter((o) => o.setting_path !== "file").length },
  { name: "policy rules", sql: POLICY_RULES_SQL, params: { tenant_id: T }, rows: rowsOf("policy_rule").filter((r) => r.tenant_id === T || r.tenant_id === "*").length },
  { name: "policy rules (three more: a * rule, the tenant's own, another tenant's)", sql: POLICY_RULES_SQL, params: { tenant_id: T }, overlays: POLICY, rows: rowsOf("policy_rule").filter((r) => r.tenant_id === T || r.tenant_id === "*").length + 2 },
  { name: "latest approvals", sql: LATEST_APPROVALS_SQL, params: { tenant_id: T } },
  { name: "latest approvals (every sites file approved twice more)", sql: LATEST_APPROVALS_SQL, params: { tenant_id: T }, overlays: APPROVALS },
  { name: "approved copies (sites host, quest file)", sql: APPROVED_COPIES_SQL, params: copyParams(SITES_HOST) },
  { name: "approved copies (a copy of every sites file, validated twice)", sql: APPROVED_COPIES_SQL, params: copyParams(SITES_HOST), overlays: COPIES },
  { name: "approved copies (the same copies, another host)", sql: APPROVED_COPIES_SQL, params: copyParams(CONFD_HOST), overlays: COPIES, rows: 0 },
  { name: "approved copies (the same copies, no host)", sql: APPROVED_COPIES_SQL, params: copyParams(""), overlays: COPIES, rows: 0 },
  { name: "probes of the probe run", sql: PROBES_OF_RUN_SQL, params: { tenant_id: T, run_id: PROBE_RUN }, rows: rowsOf("probe").filter((p) => p.run_id === PROBE_RUN).length },
  { name: "probes of a run (one http probe per A record)", sql: PROBES_OF_RUN_SQL, params: { tenant_id: T, run_id: "run-00000000000000p1" }, overlays: PROBES, rows: bundle.dns_record.filter((d) => d.run_id === DNS_RUN && d.type === "A").length },
  { name: "dispositions", sql: DISPOSITIONS_SQL, params: {}, rows: rowsOf("disposition").length },
  { name: "dispositions (one per sites file)", sql: DISPOSITIONS_SQL, params: {}, overlays: DISPOSITIONS, rows: rowsOf("disposition").length + bundle.observation.filter((o) => o.run_id === SITES_RUN && o.setting_path === "file").length },
  ...CATALOGUE.map((t) => ({ name: `template ${t.id}`, sql: t.sql, params: SAMPLE[t.id], rows: t.id === "setting_matches_approved" ? QUEST_APPROVALS : SAMPLE_ROWS[t.id] })),
  // Every table, the eight of the design included: a bundle exported before they existed holds none of their rows, and the datasource then holds none either.
  ...SCHEMA_TABLES.map((t) => ({
    name: `table ${t.name}`,
    sql: `SELECT ${columnsOf(t)} FROM {{t:${t.name}}} ORDER BY ${ORDER[t.name]}`,
    params: {},
    rows: ((bundle as unknown as Record<string, unknown[] | undefined>)[t.name] ?? []).length,
  })),
];

const live = process.env.PARITY_LIVE === "true" && config.zetaris.apiKey !== "";
if (!live) console.log("parity: live Zetaris half skipped (set PARITY_LIVE=true and ZETARIS_API_KEY to run it)");

describe("engine parity", () => {
  let sqljs: DataLayer;
  const zetaris = live ? new DataLayer(new ZetarisEngine()) : undefined;

  beforeAll(async () => {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(bundle);
    sqljs = new DataLayer(engine);
  });

  const on = (l: DataLayer, c: Case): DataLayer => (c.overlays ? l.withOverlays(c.overlays) : l);

  for (const c of CASES) {
    it(`sqljs: ${c.name}`, async () => {
      const r = await on(sqljs, c).run(c.sql, c.params, { limit: 10_000 });
      expect(r.columns.length).toBeGreaterThan(0);
      expect(r.rows.every((row) => row.length === r.columns.length && row.every((v) => typeof v === "string"))).toBe(true);
      if (c.rows !== undefined) expect(r.rowCount).toBe(c.rows);
    });

    it.skipIf(!live)(`zetaris = sqljs: ${c.name}`, { timeout: 60_000 }, async () => {
      const [a, b] = await Promise.all([on(sqljs, c).run(c.sql, c.params, { limit: 10_000 }), on(zetaris!, c).run(c.sql, c.params, { agent: "parity", limit: 10_000 })]);
      expect(b.columns).toEqual(a.columns);
      const mask = c.mask ?? ((row: string[]) => row);
      expect(b.rows.map((r) => mask(r, b.columns))).toEqual(a.rows.map((r) => mask(r, a.columns)));
      expect(b.total).toBe(a.total);
    });
  }
});
