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
// probes), 68 cases: 136 of 136 equal. Measured live 25 Oct 2026 over the export that carries the 01:16 UTC cycle's
// rows, 104 cases (25 over overlays, the eval's evidence cases masked): 209 of 209 tests, 104 of 104 cases equal.
// Measured live 25 Oct 2026 over the export that carries the 03:25 UTC cycle's rows (26 runs, 7,532 observations), 107
// cases with the document's inventory read: 216 of 216 tests, 107 of 107 cases equal.
import { beforeAll, describe, expect, it } from "vitest";
import { SAMPLE_MEMORY_DIR, config } from "../src/config.ts";
import { DataLayer, type Overlays, type Params } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { ZetarisEngine } from "../src/data/engines/zetaris.ts";
import {
  APPROVED_COPIES_SQL, AUDIT_SPAN_SQL, CHANGED_SINCE_BACKUP_SQL, DISPOSITIONS_SQL, DRIFT_VS_APPROVED_SQL, FOUND_BUT_DIFFERENT_SQL, HERO_SQL, LATEST_APPROVALS_SQL,
  OBSERVATIONS_SQL, ORPHAN_RECORD_SQL, ORPHAN_VHOST_SQL, POLICY_RULES_SQL, PROBES_OF_RUN_SQL, PROXIED_WITHOUT_REAL_IP_SQL, PROXY_SPLIT_SQL, RESOLUTIONS_SQL,
  RUNS_SQL, RUN_COMPLETE_SQL, WILDCARD_WITHOUT_REAL_IP_SQL, ACTIONS_SQL,
} from "../src/data/queries.ts";
// build B, the pipeline and the owner's document: approved_missing, the prior HOLD read, the document's reads
import {
  APPROVED_MISSING_SQL, DOC_ACTIONS_SQL, DOC_COPIES_SQL, DOC_DISPOSITIONS_OF_RUN_SQL, DOC_INVENTORY_SQL, DOC_PROBES_SQL, DOC_PROBE_FAILURES_SQL, DOC_RUN_SHAPE_SQL, DOC_TICKETS_SQL,
  DOC_UNAPPROVED_SQL, DOC_ZONES_SQL, PRIOR_HOLDS_SQL,
} from "../src/data/queries.ts";
// the ticket step's reads (src/psa/step.ts) and the eval's (src/eval/queries.ts)
import { TICKETS_SQL, TICKET_ACTIONS_SQL, TICKET_ZONES_SQL } from "../src/data/queries.ts";
import { COLUMNS } from "../src/data/rows.ts";
import { SCHEMA_TABLES } from "../src/data/schema.ts";
import { fileRows } from "../src/data/file-rows.ts";
import { ADOPTION_CHECK_SQL, ADOPTION_SQL, FILE_TABLES } from "../src/data/files.ts";
import { CATALOGUE } from "../src/catalogue/templates.ts";
import { EVAL_PARITY_CASES } from "../src/eval/queries.ts";
import bundle from "../sample/bundle.json" with { type: "json" };
import { CONFD_HOST, DNS_RUN, CONFD_RUN, QUEST_FILE, QUEST_HASH, SITES_HOST, SITES_RUN, SAMPLE, SAMPLE_ROWS, T } from "./fixtures/catalogue-params.ts";
import { objects } from "../src/data/queries.ts";

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
  finding_cause: "cause_id",
  change_window: "window_id",
};
/** The action table's columns in DDL order, the head of every derived action table below. */
const ACTION_COLUMNS = COLUMNS.action.join(", ");

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

/** backup_recent with SAMPLE params over this bundle's own snapshots: the host's export tarballs taken since the window opens (each nightly export adds one). */
const RECENT_BACKUPS = bundle.backup_snapshot.filter((s) => s.tenant_id === T && s.host === SITES_HOST && s.taken_at >= "2026-10-20T00:00:00.000Z").length;

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
  disposition: `SELECT disposition_id, tenant_id, surface, host, object_id, setting_path, value_hash, verb, reason, expires_at, decided_by, rule_id, finding_id, run_id, decided_at, window_id FROM {{t:disposition}}
UNION ALL
SELECT obs_id AS disposition_id, tenant_id, surface, host, object_id, setting_path, value_hash, 'HOLD' AS verb, 'held under the catch-all rule' AS reason, '2026-10-27T08:00:00.000Z' AS expires_at,
       'policy' AS decided_by, 'rule-00000000000000c3' AS rule_id, obs_id AS finding_id, run_id, '2026-10-24T08:00:00.000Z' AS decided_at, NULL AS window_id
FROM {{t:observation}} WHERE run_id = '${SITES_RUN}' AND setting_path = 'file'`,
};
/**
 * The file tables' rows: the store DRIFT_MEMORY_DIR names and the policy file, what npm run zetaris:setup wrote into
 * the Zetaris filestore (both sides read the same files on this machine).
 */
const FILES = fileRows();
/** The lesson the adoption cases name: the store's first exception (mem-1 of examples/memory). */
const LESSON = FILES.lesson.find((l) => l.kind === "exception") ?? { lesson_id: "mem-0", tenant_id: T, expires_at: "2026-11-30T00:00:00.000Z" };
const ADOPTED_AT = "2026-10-26T00:00:00.000Z";
const adoptionRow = (id: string, tenant: string, verb: string, by: string, reason: string, at: string): string =>
  `SELECT '${id}' AS disposition_id, '${tenant}' AS tenant_id, 'cloudflare.dns' AS surface, NULL AS host, 'host-000000.com' AS object_id, 'proxied' AS setting_path, 'sha256:0' AS value_hash, '${verb}' AS verb, '${reason}' AS reason, NULL AS expires_at, '${by}' AS decided_by, NULL AS rule_id, 'fnd-${id}' AS finding_id, 'run-00000000000000a1' AS run_id, '${at}' AS decided_at, NULL AS window_id`;
const holds = (lesson: string): string => `accepted exception ${lesson} holds until 2026-11-30T00:00:00.000Z (parity); the checks alone would say HOLD`;
/**
 * Five ledger rows in place of the stored ones, so the case reads the same dispositions on both engines whatever the
 * datasource holds: an ADOPT under the store's lesson (in force), one naming a lesson the store lacks, one decided after
 * the lesson's expiry, one of another tenant naming the same lesson, and a HOLD by policy, which the read leaves out.
 */
const adoptionsOf = (lesson: { lesson_id: string; tenant_id: string }): Overlays => ({
  disposition: [
    `SELECT disposition_id, tenant_id, surface, host, object_id, setting_path, value_hash, verb, reason, expires_at, decided_by, rule_id, finding_id, run_id, decided_at, window_id FROM {{t:disposition}} WHERE disposition_id = ''`,
    adoptionRow("disp-adopt-in-force", lesson.tenant_id, "ADOPT", "operator", holds(lesson.lesson_id), ADOPTED_AT),
    adoptionRow("disp-adopt-no-lesson", lesson.tenant_id, "ADOPT", "operator", holds("mem-999999"), ADOPTED_AT),
    adoptionRow("disp-adopt-expired", lesson.tenant_id, "ADOPT", "operator", holds(lesson.lesson_id), "2026-12-31T00:00:00.000Z"),
    adoptionRow("disp-adopt-other-tenant", "client-z", "ADOPT", "operator", holds(lesson.lesson_id), ADOPTED_AT),
    adoptionRow("disp-hold", lesson.tenant_id, "HOLD", "policy", "held under the catch-all rule", ADOPTED_AT),
  ].join("\nUNION ALL\n"),
});
const ADOPTIONS = adoptionsOf(LESSON);
/** One rollback_file action per file of the sites host's run, and one of another tenant, which the tenant's read leaves out. */
const ACTIONS: Overlays = {
  action: `SELECT ${ACTION_COLUMNS} FROM {{t:action}}
UNION ALL
SELECT obs_id AS action_id, tenant_id, 'rollback_file' AS kind, object_id AS target, value_hash AS before_hash, value_hash AS after_hash, '5a14a89d0123456789abcdef0123456789abcdef' AS vault_commit,
       obs_id AS verification, '' AS receipts, 'done' AS status, 'restored to the approved copy' AS reason, obs_id AS record, observed_at AS started_at, observed_at AS finished_at, obs_id AS disposition_id
FROM {{t:observation}} WHERE run_id = '${SITES_RUN}' AND setting_path = 'file'
UNION ALL
SELECT 'act-00000000000000c2' AS action_id, 'client-2' AS tenant_id, 'fix' AS kind, object_id AS target, value_hash AS before_hash, value_hash AS after_hash, '' AS vault_commit,
       '' AS verification, '' AS receipts, 'refused' AS status, 'no fix is allowed without a valid copy' AS reason, '' AS record, observed_at AS started_at, observed_at AS finished_at, obs_id AS disposition_id
FROM {{t:observation}} WHERE obs_id = '${bundle.observation.find((o) => o.run_id === SITES_RUN && o.setting_path === "file")?.obs_id ?? ""}'`,
};
const copyParams =(host: string): Params => ({ tenant_id: T, surface: "linux.nginx", host, object_id: QUEST_FILE, setting_path: "file", approved_hash: QUEST_HASH });
const PROBE_RUN = bundle.collection_run.filter((r) => r.surface === "probe").map((r) => r.run_id).sort().at(-1) ?? "";
const rowsOf = (table: string): { tenant_id?: string; run_id?: string }[] => (bundle as unknown as Record<string, { tenant_id?: string; run_id?: string }[] | undefined>)[table] ?? [];

/** The file bodies the export nulled over 2 kB stay in the datasource: blank value_redacted on `file` rows on both sides, compare everything else. */
const noFileBodies = (row: string[], columns: string[]): string[] => {
  const sp = columns.indexOf("setting_path");
  const vr = columns.indexOf("value_redacted");
  return sp >= 0 && vr >= 0 && row[sp] === "file" ? row.map((v, i) => (i === vr ? "" : v)) : row;
};
/** The eval cases' EVIDENCE_SQL: the export nulls value_redacted over 2 kB, so value is blank on `file` observation rows on both sides; the bodies compare by value_hash elsewhere. */
const noEvidenceBodies = (row: string[], columns: string[]): string[] => {
  const src = columns.indexOf("source");
  const field = columns.indexOf("field");
  const value = columns.indexOf("value");
  return src >= 0 && field >= 0 && value >= 0 && row[src] === "observation" && row[field] === "file" ? row.map((v, i) => (i === value ? "" : v)) : row;
};

// ---- build B, the pipeline and the owner's document: approved_missing, the prior HOLD read, the document's reads ----
type BRow = Record<string, string | number | null>;
const tbl = (t: string): BRow[] => (bundle as unknown as Record<string, BRow[] | undefined>)[t] ?? [];
const SITES_FILES = bundle.observation.filter((o) => o.run_id === SITES_RUN && o.setting_path === "file").length;
const keyOfApproval = (a: BRow): string => [a.surface, a.host ?? "", a.object_id, a.setting_path].join("\u001f");
const LATEST_APPROVAL_ROWS = tbl("approved_setting").filter((a) => a.tenant_id === T && !tbl("approved_setting").some((n) => n.tenant_id === T && keyOfApproval(n) === keyOfApproval(a)
  && (String(n.approved_at) > String(a.approved_at) || (n.approved_at === a.approved_at && String(n.approval_id) > String(a.approval_id)))));
/** The latest approvals of a surface and host whose object the run holds neither an observation nor a record row of, counted from the bundle: what APPROVED_MISSING_SQL returns. */
const missingOf = (surface: string, host: string, run: string): number =>
  LATEST_APPROVAL_ROWS.filter((a) => a.surface === surface && (a.host ?? "") === host
    && !bundle.observation.some((o) => o.run_id === run && o.object_id === a.object_id) && !bundle.dns_record.some((d) => d.run_id === run && d.record_id === a.object_id)).length;
const SITES_APPROVAL = String(tbl("approved_setting").find((a) => a.tenant_id === T && a.surface === "linux.nginx" && a.host === SITES_HOST)?.approval_id ?? "");
const RECORD_APPROVAL = String(tbl("approved_setting").find((a) => a.tenant_id === T && a.surface === "cloudflare.dns")?.approval_id ?? "");
/** Two approvals more, each a copy of a stored one on an object no run holds: a vhost file of the sites host and a record. */
const APPROVED_ABSENT: Overlays = {
  approved_setting: `SELECT approval_id, tenant_id, surface, host, object_id, setting_path, value_hash, approved_at, approved_by, note FROM {{t:approved_setting}}
UNION ALL
SELECT 'appr-parity-absent-file' AS approval_id, tenant_id, surface, host, '/etc/nginx/sites-available/parity-absent' AS object_id, setting_path, value_hash,
       '2026-10-24T23:00:00.000Z' AS approved_at, approved_by, note
FROM {{t:approved_setting}} WHERE approval_id = '${SITES_APPROVAL}'
UNION ALL
SELECT 'appr-parity-absent-record' AS approval_id, tenant_id, surface, host, 'parity-absent-record' AS object_id, setting_path, value_hash,
       '2026-10-24T23:00:00.000Z' AS approved_at, approved_by, note
FROM {{t:approved_setting}} WHERE approval_id = '${RECORD_APPROVAL}'`,
};
/** APPROVED_ABSENT with the absent record's absence approved after it (value_hash '', the Actor's carry): that key leaves approved_missing. */
const APPROVED_ABSENT_RETIRED: Overlays = {
  approved_setting: `${APPROVED_ABSENT.approved_setting}
UNION ALL
SELECT 'appr-parity-absent-record-retired' AS approval_id, tenant_id, surface, host, 'parity-absent-record' AS object_id, setting_path, '' AS value_hash,
       '2026-10-24T23:30:00.000Z' AS approved_at, approved_by, 'carried to parity-new-record by action act-parity' AS note
FROM {{t:approved_setting}} WHERE approval_id = '${RECORD_APPROVAL}'`,
};
/** Every file of the sites host's run held twice by two passes, at 08:00 and at 09:00 UTC: the later HOLD of each before the instant is the one PRIOR_HOLDS_SQL returns. */
const HELD_TWICE: Overlays = {
  disposition: `${DISPOSITIONS.disposition}
UNION ALL
SELECT object_id AS disposition_id, tenant_id, surface, host, object_id, setting_path, value_hash, 'HOLD' AS verb, 'held again under the catch-all rule' AS reason, '2026-10-27T08:00:00.000Z' AS expires_at,
       'policy' AS decided_by, 'rule-00000000000000c3' AS rule_id, obs_id AS finding_id, run_id, '2026-10-24T09:00:00.000Z' AS decided_at, NULL AS window_id
FROM {{t:observation}} WHERE run_id = '${SITES_RUN}' AND setting_path = 'file'`,
};
/** Every file of the sites host's run held by the catch-all rule at 08:00 UTC and by a change window at 09:00: the window's HOLD (window_id set) is no rule's, so the 08:00 HOLD stands. */
const HELD_BY_WINDOW: Overlays = {
  disposition: `${DISPOSITIONS.disposition}
UNION ALL
SELECT object_id AS disposition_id, tenant_id, surface, host, object_id, setting_path, value_hash, 'HOLD' AS verb, 'change window win-parity opened by tech-a until 2026-10-24T12:00:00.000Z: parity' AS reason, '2026-10-24T12:00:00.000Z' AS expires_at,
       'policy' AS decided_by, 'rule-00000000000000c3' AS rule_id, obs_id AS finding_id, run_id, '2026-10-24T09:00:00.000Z' AS decided_at, 'win-parity' AS window_id
FROM {{t:observation}} WHERE run_id = '${SITES_RUN}' AND setting_path = 'file'`,
};
/** One action per file of the sites host's run (done) and one more (failed), and one ticket per file. */
const DOC_WORK: Overlays = {
  action: `SELECT ${ACTION_COLUMNS} FROM {{t:action}}
UNION ALL
SELECT obs_id AS action_id, tenant_id, 'rollback_file' AS kind, object_id AS target, value_hash AS before_hash, value_hash AS after_hash, '5a14a89d0123456789abcdef0123456789abcdef' AS vault_commit,
       obs_id AS verification, '' AS receipts, 'done' AS status, 'restored to the approved copy' AS reason, obs_id AS record, observed_at AS started_at, observed_at AS finished_at, obs_id AS disposition_id
FROM {{t:observation}} WHERE run_id = '${SITES_RUN}' AND setting_path = 'file'
UNION ALL
SELECT 'act-parity-failed' AS action_id, tenant_id, 'rollback_file' AS kind, object_id AS target, value_hash AS before_hash, value_hash AS after_hash, '' AS vault_commit,
       '' AS verification, '' AS receipts, 'failed' AS status, 'nginx -t refused the copy' AS reason, '' AS record, observed_at AS started_at, observed_at AS finished_at, obs_id AS disposition_id
FROM {{t:observation}} WHERE obs_id = '${bundle.observation.find((o) => o.run_id === SITES_RUN && o.setting_path === "file")?.obs_id ?? ""}'`,
  ticket: `SELECT ticket_id, tenant_id, psa, external_id, url, type, priority, status, action_id, finding_id, created_at, updated_at FROM {{t:ticket}}
UNION ALL
SELECT obs_id AS ticket_id, tenant_id, 'github' AS psa, obs_id AS external_id, 'https://tickets.example.invalid/issues/1' AS url, 'change' AS type, 'P1' AS priority, 'open' AS status,
       obs_id AS action_id, obs_id AS finding_id, observed_at AS created_at, observed_at AS updated_at
FROM {{t:observation}} WHERE run_id = '${SITES_RUN}' AND setting_path = 'file'`,
};
const noDispositions = tbl("disposition").length === 0;
const headCopies = tbl("vault_copy").filter((c) => c.tenant_id === T && !tbl("vault_copy").some((x) => x.tenant_id === T && x.surface === c.surface && (x.host ?? "") === (c.host ?? "") && String(x.taken_at) > String(c.taken_at))).length;
const unapprovedOf = (run: string): number => bundle.observation.filter((o) => o.tenant_id === T && o.run_id === run
  && !tbl("approved_setting").some((a) => a.tenant_id === T && keyOfApproval(a) === keyOfApproval(o as unknown as BRow))).length;
const probesOf = tbl("probe").filter((p) => p.tenant_id === T && p.run_id === PROBE_RUN);
/** The start of a host's latest complete run in the bundle: the instant the document's inventory line counts against. */
const latestStart = (host: string): string => tbl("collection_run").filter((r) => r.tenant_id === T && r.host === host && r.status === "complete").map((r) => String(r.started_at)).sort().at(-1) ?? "";
/** One more inventory row per address of the sites host, last seen on 1 Oct 2026: older rows the document counts apart. */
const OLDER_INVENTORY: Overlays = {
  inventory_asset: `SELECT asset_id, tenant_id, host, address, kind, source, observed_at FROM {{t:inventory_asset}}
UNION ALL
SELECT asset_id, tenant_id, host, address, kind, source, '2026-10-01T00:00:00.000Z' AS observed_at
FROM {{t:inventory_asset}} WHERE tenant_id = '${T}' AND host = '${SITES_HOST}'`,
};
const groupsOf = (rows: BRow[], cols: string[]): number => new Set(rows.map((r) => cols.map((c) => r[c]).join("\u001f"))).size;
const BUILD_B_CASES: Case[] = [
  { name: "approved_missing (sites host)", sql: APPROVED_MISSING_SQL, params: { tenant_id: T, surface: "linux.nginx", host: SITES_HOST, run_id: SITES_RUN }, rows: missingOf("linux.nginx", SITES_HOST, SITES_RUN) },
  { name: "approved_missing (confd host)", sql: APPROVED_MISSING_SQL, params: { tenant_id: T, surface: "linux.nginx", host: CONFD_HOST, run_id: CONFD_RUN }, rows: missingOf("linux.nginx", CONFD_HOST, CONFD_RUN) },
  { name: "approved_missing (dns, host '')", sql: APPROVED_MISSING_SQL, params: { tenant_id: T, surface: "cloudflare.dns", host: "", run_id: DNS_RUN }, rows: missingOf("cloudflare.dns", "", DNS_RUN) },
  { name: "approved_missing (sites host, a file approved that no run holds)", sql: APPROVED_MISSING_SQL, params: { tenant_id: T, surface: "linux.nginx", host: SITES_HOST, run_id: SITES_RUN }, overlays: APPROVED_ABSENT, rows: missingOf("linux.nginx", SITES_HOST, SITES_RUN) + 1 },
  { name: "approved_missing (dns, a record approved that no run holds)", sql: APPROVED_MISSING_SQL, params: { tenant_id: T, surface: "cloudflare.dns", host: "", run_id: DNS_RUN }, overlays: APPROVED_ABSENT, rows: missingOf("cloudflare.dns", "", DNS_RUN) + 1 },
  { name: "prior holds", sql: PRIOR_HOLDS_SQL, params: { tenant_id: T, decided_at: "2026-10-25T00:00:00.000Z" }, rows: noDispositions ? 0 : undefined },
  { name: "prior holds (one per sites file)", sql: PRIOR_HOLDS_SQL, params: { tenant_id: T, decided_at: "2026-10-25T00:00:00.000Z" }, overlays: DISPOSITIONS, rows: noDispositions ? SITES_FILES : undefined },
  { name: "prior holds (each sites file held twice, the later stands)", sql: PRIOR_HOLDS_SQL, params: { tenant_id: T, decided_at: "2026-10-25T00:00:00.000Z" }, overlays: HELD_TWICE, rows: noDispositions ? SITES_FILES : undefined },
  { name: "prior holds (each sites file held twice, an instant between the two: the earlier stands)", sql: PRIOR_HOLDS_SQL, params: { tenant_id: T, decided_at: "2026-10-24T08:30:00.000Z" }, overlays: HELD_TWICE, rows: noDispositions ? SITES_FILES : undefined },
  { name: "prior holds (an instant before every HOLD)", sql: PRIOR_HOLDS_SQL, params: { tenant_id: T, decided_at: "2026-10-24T07:00:00.000Z" }, overlays: HELD_TWICE, rows: noDispositions ? 0 : undefined },
  { name: "prior holds (each sites file held by the rule, then by a change window: the rule's HOLD stands)", sql: PRIOR_HOLDS_SQL, params: { tenant_id: T, decided_at: "2026-10-25T00:00:00.000Z" }, overlays: HELD_BY_WINDOW, rows: noDispositions ? SITES_FILES : undefined },
  { name: "approved_missing (dns, the absent record's absence approved after it)", sql: APPROVED_MISSING_SQL, params: { tenant_id: T, surface: "cloudflare.dns", host: "", run_id: DNS_RUN }, overlays: APPROVED_ABSENT_RETIRED, rows: missingOf("cloudflare.dns", "", DNS_RUN) },
  { name: "document: run shape", sql: DOC_RUN_SHAPE_SQL, params: { run_id: SITES_RUN }, rows: 1 },
  { name: "document: inventory of the confd host against its latest run", sql: DOC_INVENTORY_SQL, params: { tenant_id: T, host: CONFD_HOST, started_at: latestStart(CONFD_HOST) }, rows: 1 },
  { name: "document: inventory of the sites host, every address also seen on 1 Oct", sql: DOC_INVENTORY_SQL, params: { tenant_id: T, host: SITES_HOST, started_at: latestStart(SITES_HOST) }, overlays: OLDER_INVENTORY, rows: 1 },
  { name: "document: inventory of a host with no row", sql: DOC_INVENTORY_SQL, params: { tenant_id: T, host: "host-000000", started_at: latestStart(SITES_HOST) }, rows: 1 },
  { name: "document: zones", sql: DOC_ZONES_SQL, params: { tenant_id: T, dns_run_id: DNS_RUN }, rows: new Set(bundle.dns_record.filter((d) => d.run_id === DNS_RUN).map((d) => d.zone)).size },
  { name: "document: head copies", sql: DOC_COPIES_SQL, params: { tenant_id: T }, rows: headCopies },
  { name: "document: unapproved settings (sites host)", sql: DOC_UNAPPROVED_SQL, params: { tenant_id: T, run_id: SITES_RUN }, rows: unapprovedOf(SITES_RUN) },
  { name: "document: unapproved settings (dns)", sql: DOC_UNAPPROVED_SQL, params: { tenant_id: T, run_id: DNS_RUN }, rows: unapprovedOf(DNS_RUN) },
  { name: "document: dispositions of a run (one per sites file)", sql: DOC_DISPOSITIONS_OF_RUN_SQL, params: { tenant_id: T, run_id: SITES_RUN }, overlays: DISPOSITIONS, rows: noDispositions ? SITES_FILES : undefined },
  { name: "document: dispositions of a run (each sites file decided by two passes, the later stands)", sql: DOC_DISPOSITIONS_OF_RUN_SQL, params: { tenant_id: T, run_id: SITES_RUN }, overlays: HELD_TWICE, rows: noDispositions ? SITES_FILES : undefined },
  { name: "document: actions by kind and status", sql: DOC_ACTIONS_SQL, params: { tenant_id: T }, rows: groupsOf(tbl("action").filter((a) => a.tenant_id === T), ["kind", "status"]) },
  { name: "document: actions by kind and status (one per sites file, one failed)", sql: DOC_ACTIONS_SQL, params: { tenant_id: T }, overlays: DOC_WORK, rows: tbl("action").length === 0 ? 2 : undefined },
  { name: "document: tickets", sql: DOC_TICKETS_SQL, params: { tenant_id: T }, rows: tbl("ticket").filter((t) => t.tenant_id === T).length },
  { name: "document: tickets (one per sites file)", sql: DOC_TICKETS_SQL, params: { tenant_id: T }, overlays: DOC_WORK, rows: tbl("ticket").filter((t) => t.tenant_id === T).length + SITES_FILES },
  { name: "document: probes by kind and status", sql: DOC_PROBES_SQL, params: { tenant_id: T, run_id: PROBE_RUN }, rows: groupsOf(probesOf, ["kind", "status"]) },
  { name: "document: failing probes", sql: DOC_PROBE_FAILURES_SQL, params: { tenant_id: T, run_id: PROBE_RUN }, rows: probesOf.filter((p) => p.status === "fail").length },
];

// ---- the ticket step's reads (src/psa/step.ts) and the eval's (src/eval/queries.ts) ----
const SITE_FILES = bundle.observation.filter((o) => o.run_id === SITES_RUN && o.setting_path === "file");
/** One ticket and one disposition per file of the sites host's run; one action per file of both hosts' runs, the conf.d ones with no disposition. */
const TICKET_OVERLAYS: Overlays = {
  ticket: `SELECT ticket_id, tenant_id, psa, external_id, url, type, priority, status, action_id, finding_id, created_at, updated_at FROM {{t:ticket}}
UNION ALL
SELECT obs_id AS ticket_id, tenant_id, 'github' AS psa, '7' AS external_id, 'https://host-000000.com/owner/tickets/issues/7' AS url, 'incident' AS type, 'P3' AS priority,
       'open' AS status, obs_id AS action_id, obs_id AS finding_id, observed_at AS created_at, observed_at AS updated_at
FROM {{t:observation}} WHERE run_id = '${SITES_RUN}' AND setting_path = 'file'`,
  disposition: `SELECT disposition_id, tenant_id, surface, host, object_id, setting_path, value_hash, verb, reason, expires_at, decided_by, rule_id, finding_id, run_id, decided_at, window_id FROM {{t:disposition}}
UNION ALL
SELECT obs_id AS disposition_id, tenant_id, surface, host, object_id, setting_path, value_hash, 'ROLLBACK' AS verb, 'rolled back under the file rule' AS reason, '' AS expires_at,
       'policy' AS decided_by, 'rule-00000000000000a1' AS rule_id, obs_id AS finding_id, run_id, '2026-10-24T08:00:00.000Z' AS decided_at, NULL AS window_id
FROM {{t:observation}} WHERE run_id = '${SITES_RUN}' AND setting_path = 'file'`,
  action: `SELECT ${ACTION_COLUMNS} FROM {{t:action}}
UNION ALL
SELECT obs_id AS action_id, tenant_id, 'rollback_file' AS kind, object_id AS target, value_hash AS before_hash, value_hash AS after_hash, '5a14a89d0123456789abcdef0123456789abcdef' AS vault_commit,
       'probe-0000000000000001' AS verification, '' AS receipts, 'done' AS status, 'restored to the approved copy' AS reason, 'probe probe-0000000000000001: http ok' AS record,
       observed_at AS started_at, observed_at AS finished_at, obs_id AS disposition_id
FROM {{t:observation}} WHERE setting_path = 'file' AND host IS NOT NULL AND (run_id = '${SITES_RUN}' OR run_id = '${CONFD_RUN}')`,
};
/** The ticket rows the recorded bundle holds for the tenant (the export carries what the live cycle wrote). */
const RECORDED_TICKETS = tbl("ticket").filter((t) => t.tenant_id === T);
const TICKET_CASES: Case[] = [
  { name: "tickets", sql: TICKETS_SQL, params: { tenant_id: T }, rows: RECORDED_TICKETS.length },
  { name: "tickets (one per sites file)", sql: TICKETS_SQL, params: { tenant_id: T }, overlays: TICKET_OVERLAYS, rows: RECORDED_TICKETS.length + SITE_FILES.length },
  { name: "tickets (another tenant)", sql: TICKETS_SQL, params: { tenant_id: "client-2" }, overlays: TICKET_OVERLAYS, rows: 0 },
  { name: "ticket actions", sql: TICKET_ACTIONS_SQL, params: { tenant_id: T }, rows: 0 },
  { name: "ticket actions (the conf.d actions have no disposition)", sql: TICKET_ACTIONS_SQL, params: { tenant_id: T }, overlays: TICKET_OVERLAYS, rows: SITE_FILES.length },
  { name: "ticket zones", sql: TICKET_ZONES_SQL, params: { tenant_id: T, dns_run_id: DNS_RUN }, rows: bundle.dns_record.filter((r) => r.run_id === DNS_RUN).length },
];

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
  { name: "actions", sql: ACTIONS_SQL, params: { tenant_id: T }, rows: rowsOf("action").filter((a) => a.tenant_id === T).length },
  { name: "actions (one per sites file, one of another tenant)", sql: ACTIONS_SQL, params: { tenant_id: T }, overlays: ACTIONS, rows: rowsOf("action").filter((a) => a.tenant_id === T).length + bundle.observation.filter((o) => o.run_id === SITES_RUN && o.setting_path === "file").length },
  ...BUILD_B_CASES,
  ...TICKET_CASES,
  ...EVAL_PARITY_CASES.map((c) => ({ ...c, mask: noEvidenceBodies })),
  ...CATALOGUE.map((t) => ({ name: `template ${t.id}`, sql: t.sql, params: SAMPLE[t.id], rows: t.id === "setting_matches_approved" ? QUEST_APPROVALS : t.id === "backup_recent" ? RECENT_BACKUPS : SAMPLE_ROWS[t.id] })),
  // The file tables, Zetaris's LESSONS.lesson and RULES.rule, and the cross-source read over them (src/data/files.ts).
  ...FILE_TABLES.map((t) => ({ name: `file table ${t.name}`, sql: `SELECT ${t.columns.join(", ")} FROM {{t:${t.name}}} ORDER BY ${t.columns[0]}`, params: {}, rows: FILES[t.name as keyof typeof FILES].length })),
  { name: "adoptions (five ledger rows: one in force, one naming no lesson, one after the expiry, one of another tenant, one HOLD)", sql: ADOPTION_SQL, params: {}, overlays: ADOPTIONS, rows: 4 },
  { name: "exception_in_force at one decision instant", sql: ADOPTION_CHECK_SQL, params: { decided_at: ADOPTED_AT }, overlays: ADOPTIONS, rows: 1 },
  // Every table, the eight of the design included: a bundle exported before they existed holds none of their rows, and the datasource then holds none either.
  ...SCHEMA_TABLES.map((t) => ({
    name: `table ${t.name}`,
    sql: `SELECT ${columnsOf(t)} FROM {{t:${t.name}}} ORDER BY ${ORDER[t.name]}`,
    params: {},
    rows: ((bundle as unknown as Record<string, unknown[] | undefined>)[t.name] ?? []).length,
  })),
];

const live = process.env.PARITY_LIVE === "true" && config.zetaris.apiKey !== "";
/**
 * The row limit of every case, above the largest table of the bundle (17,364 observation rows on 25 Oct 2026), so both
 * engines return and count every row: measured 25 Oct 2026, Zetaris's `total` stops at the request limit.
 */
const EVERY_ROW = 100_000;
if (!live) console.log("parity: live Zetaris half skipped (set PARITY_LIVE=true and ZETARIS_API_KEY to run it)");

describe("engine parity", () => {
  let sqljs: DataLayer;
  const zetaris = live ? new DataLayer(new ZetarisEngine()) : undefined;

  beforeAll(async () => {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(bundle);
    engine.loadFileTables(FILES);
    sqljs = new DataLayer(engine);
  });

  const on = (l: DataLayer, c: Case): DataLayer => (c.overlays ? l.withOverlays(c.overlays) : l);

  for (const c of CASES) {
    it(`sqljs: ${c.name}`, async () => {
      const r = await on(sqljs, c).run(c.sql, c.params, { limit: EVERY_ROW });
      expect(r.columns.length).toBeGreaterThan(0);
      expect(r.rows.every((row) => row.length === r.columns.length && row.every((v) => typeof v === "string"))).toBe(true);
      if (c.rows !== undefined) expect(r.rowCount).toBe(c.rows);
    });

    it.skipIf(!live)(`zetaris = sqljs: ${c.name}`, { timeout: 60_000 }, async () => {
      const [a, b] = await Promise.all([on(sqljs, c).run(c.sql, c.params, { limit: EVERY_ROW }), on(zetaris!, c).run(c.sql, c.params, { agent: "parity", limit: EVERY_ROW })]);
      expect(b.columns).toEqual(a.columns);
      const mask = c.mask ?? ((row: string[]) => row);
      expect(b.rows.map((r) => mask(r, b.columns))).toEqual(a.rows.map((r) => mask(r, a.columns)));
      expect(b.total).toBe(a.total);
    });
  }
});

// The blocks below load sample/bundle.json into sql.js each time: a few seconds alone, more under the full suite.
describe("the ticket step's reads over sample/bundle.json, on sql.js: the rows in key order, with the columns the step reads", { timeout: 30_000 }, () => {
  it("TICKETS_SQL, TICKET_ACTIONS_SQL (the reason and the record included) and TICKET_ZONES_SQL", async () => {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(bundle);
    const sqljs = new DataLayer(engine);
    expect(bundle.observation.some((o) => o.run_id === CONFD_RUN && o.setting_path === "file")).toBe(true);
    const t = objects(await sqljs.withOverlays(TICKET_OVERLAYS).run(TICKETS_SQL, { tenant_id: T }, { limit: 10_000 }));
    expect(t.map((r) => r.ticket_id)).toEqual([...SITE_FILES.map((o) => o.obs_id), ...RECORDED_TICKETS.map((r) => String(r.ticket_id))].sort());
    expect(t[0]).toEqual({
      ticket_id: t[0].ticket_id, tenant_id: T, psa: "github", external_id: "7", url: "https://host-000000.com/owner/tickets/issues/7", type: "incident", priority: "P3",
      status: "open", action_id: t[0].ticket_id, finding_id: t[0].ticket_id, created_at: t[0].created_at, updated_at: t[0].created_at,
    });
    const a = objects(await sqljs.withOverlays(TICKET_OVERLAYS).run(TICKET_ACTIONS_SQL, { tenant_id: T }, { limit: 10_000 }));
    expect(a.map((r) => r.finding_id)).toEqual(SITE_FILES.map((o) => o.obs_id).sort());
    expect(new Set(a.map((r) => `${r.kind} ${r.status} ${r.verb} ${r.verification} | ${r.reason} | ${r.record}`))).toEqual(new Set(["rollback_file done ROLLBACK probe-0000000000000001 | restored to the approved copy | probe probe-0000000000000001: http ok"]));
    const z = objects(await sqljs.run(TICKET_ZONES_SQL, { tenant_id: T, dns_run_id: DNS_RUN }, { limit: 10_000 }));
    expect(z.map((r) => r.record_id)).toEqual(bundle.dns_record.filter((r) => r.run_id === DNS_RUN).map((r) => r.record_id).sort());
    expect(z.every((r) => /^host-[0-9a-f]{6}\.[a-z]+$/.test(r.zone))).toBe(true);
    engine.close();
  });
});

describe("the document's inventory read over sample/bundle.json, on sql.js: the counts the Estate line prints", { timeout: 30_000 }, () => {
  it("DOC_INVENTORY_SQL: the rows a host's latest run saw, the older rows kept, and zero for a host with none", async () => {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(bundle);
    const sqljs = new DataLayer(engine);
    const read = async (host: string, overlays?: Overlays) => objects(await (overlays ? sqljs.withOverlays(overlays) : sqljs).run(DOC_INVENTORY_SQL, { tenant_id: T, host, started_at: latestStart(host) }, { limit: 10 }))[0];
    const assets = (host: string) => tbl("inventory_asset").filter((a) => a.tenant_id === T && a.host === host);
    for (const host of [CONFD_HOST, SITES_HOST]) {
      const older = assets(host).filter((a) => String(a.observed_at) < latestStart(host)).length;
      expect(await read(host)).toEqual({ latest: String(assets(host).length - older), older: String(older) });
    }
    const sitesOlder = assets(SITES_HOST).filter((a) => String(a.observed_at) < latestStart(SITES_HOST)).length;
    expect(await read(SITES_HOST, OLDER_INVENTORY)).toEqual({ latest: String(assets(SITES_HOST).length - sitesOlder), older: String(sitesOlder + assets(SITES_HOST).length) });
    expect(await read("host-000000")).toEqual({ latest: "", older: "" });
    engine.close();
  });
});

describe("the prior HOLD read over sample/bundle.json, on sql.js: a change window's HOLD is no rule's", { timeout: 30_000 }, () => {
  it("PRIOR_HOLDS_SQL over the rule's HOLDs and a later window HOLD of each sites file returns what it returns over the rule's alone", async () => {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(bundle);
    const sqljs = new DataLayer(engine);
    const read = async (overlays: Overlays) => objects(await sqljs.withOverlays(overlays).run(PRIOR_HOLDS_SQL, { tenant_id: T, decided_at: "2026-10-25T00:00:00.000Z" }, { limit: EVERY_ROW }));
    const ruleOnly = await read(DISPOSITIONS);
    expect(ruleOnly.filter((h) => h.decided_at === "2026-10-24T08:00:00.000Z")).toHaveLength(SITES_FILES);
    expect(await read(HELD_BY_WINDOW)).toEqual(ruleOnly);
    // the same rows HELD_TWICE holds again by the rule, at 09:00: those are a rule's, so they stand in place of the 08:00 ones
    expect((await read(HELD_TWICE)).filter((h) => h.decided_at === "2026-10-24T09:00:00.000Z")).toHaveLength(SITES_FILES);
    engine.close();
  });
});

describe("the file tables over the committed store and policy, on sql.js: exception_in_force at one decision instant", { timeout: 30_000 }, () => {
  it("the ADOPT under a lesson in force joins it; one naming no lesson, one after the expiry and one of another tenant do not; the HOLD is left out", async () => {
    const files = fileRows({ memoryDir: SAMPLE_MEMORY_DIR, policyFile: "policy/hackathon.json" });
    expect(files.lesson).toHaveLength(23);
    expect(files.rule).toHaveLength(15);
    const lesson = files.lesson[0];
    expect(lesson).toMatchObject({ lesson_id: "mem-1", tenant_id: "client-1", kind: "exception", finding_class: "proxied_without_real_ip", expires_at: "2026-11-30T00:00:00.000Z" });
    const engine = await SqlJsEngine.create();
    engine.loadBundle(bundle);
    expect(engine.loadFileTables(files)).toEqual({ lesson: 23, rule: 15 });
    const layer = new DataLayer(engine).withOverlays(adoptionsOf(lesson));
    const rows = objects(await layer.run(`${ADOPTION_SQL} ORDER BY disposition_id`, {}));
    expect(rows.map((r) => [r.disposition_id, r.lesson_id, r.lesson_expires_at])).toEqual([
      ["disp-adopt-expired", "mem-1", "2026-11-30T00:00:00.000Z"],
      ["disp-adopt-in-force", "mem-1", "2026-11-30T00:00:00.000Z"],
      ["disp-adopt-no-lesson", "", ""],
      ["disp-adopt-other-tenant", "", ""],
    ]);
    expect(objects(await layer.run(ADOPTION_CHECK_SQL, { decided_at: ADOPTED_AT }))).toEqual([{ adoptions: "3", in_force: "1" }]);
    expect(objects(await layer.run(ADOPTION_CHECK_SQL, { decided_at: "2026-12-31T00:00:00.000Z" }))).toEqual([{ adoptions: "1", in_force: "0" }]);
    expect(objects(await layer.run(ADOPTION_CHECK_SQL, { decided_at: "2027-01-01T00:00:00.000Z" }))).toEqual([{ adoptions: "0", in_force: "0" }]);
    engine.close();
  });
});
