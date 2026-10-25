// Idempotent Zetaris setup: the DRIFT datasource over the app Postgres, the drift_usl Unified Semantic
// Layer over it (eleven tables) and four DQ rules on it. plan() lists the statements in the order they run,
// apply() runs them one at a time. uslRows() and uslMarkdown() read the layer's table off USL_DDL, activation() and
// DQ_RULES: each entity, the DRIFT tables its activation SELECT reads, its keys and its DQ rule with the rule's
// expression. npm run sources -- --usl prints it, and the README and the replay page's Sources tab carry it.
//
// The eleven tables: collection (collection_run), setting (observation; source_kind for source), referent (each
// dns_name observation joined to the records of its name), backup_copy (backup_item joined to its snapshot),
// policy (policy_rule), copy (vault_copy with its latest copy_validation and a validated flag), probe,
// disposition, action (the Actor's rows, the reason and the record among them), ticket and cause (finding_cause,
// the explainer's rows; cause_class for class). The four rules:
//   run_complete     on collection: observed_count IS NOT NULL AND expected_count IS NOT NULL AND
//                    observed_count >= expected_count AND status = 'complete'
//   copy_validated   on copy: validated = 1
//   action_verified  on action, scoped to the write paths: kind NOT IN ('rollback_file','revert_record') OR
//                    status IN ('failed','refused','not_judged') OR verification <> ''; a done or unverified write
//                    that names no verifying probe fails the rule, its status carrying what is missing
//   cause_evidenced  on cause: cause_class = 'unknown' OR evidence_ids <> '[]'; a cause of any class but unknown
//                    names at least one evidence id
//
// Contract:
//   - Re-runnable. CREATE DATASOURCE has no IF NOT EXISTS, so SHOW DATASOURCES decides it. REGISTER
//     DATASOURCE TABLES follows a create, and for an existing source runs when SHOW DATASOURCE TABLES lacks
//     a table of sql/schema.sql; REFRESH DATASOURCE TABLES runs when it lists all of them. Namespaces carry
//     IF NOT EXISTS. An error saying "already exist" is done (skipped). Any other error stops the run.
//   - The USL: SHOW NAMESPACES OR TABLES IN lightning.metastore.drift says whether drift_usl exists; LOAD
//     USL reads its model. A model whose tables or columns differ from COMPILE_USL's is stale: REMOVE USL,
//     then COMPILE afresh. COMPILE runs only when the USL is absent or was removed this run, so an instance
//     already holding the eleven tables keeps its USL and its DQ rules. The USL is derived from the
//     datasource, so a removal loses nothing.
//   - Every run re-ACTIVATEs the eleven tables (each a SELECT over DRIFT.* returning exactly the declared
//     columns, NOT NULL varchars in COALESCE, ints CAST), then LIST DQ USL decides each rule of DQ_RULES:
//     REGISTER when the listing lacks it, UPDATE DQ ... SET NAME, EXPRESSION when it is listed with another
//     expression (whitespace aside), nothing when it is listed as stated. RUN DQ on collection, copy,
//     action and cause, the USL's table listing, a count per table.
//   - One statement per call, except COMPILE USL ... DDL: eleven CREATE TABLE blocks separated by ';' in
//     one request, sent with the adapter's allowMultiStatement (honoured for COMPILE USL only).
//   - The CREATE DATASOURCE statement carries the Postgres password and is built in memory when it is
//     sent, nowhere else: plan() holds password "<redacted>", its trace line says only "CREATE DATASOURCE
//     DRIFT (credentials redacted)", and every error message is redact()ed and scrubbed of the literal
//     password before it is printed or traced.
//   - Zetaris reaches the Postgres at ZETARIS_PG_HOST (host[:port], 5432 when absent): measured
//     drift-pg:5432 from the driver container, 127.0.0.1:15432 from Windows. Only the user, password and
//     database come from DATABASE_URL.
//   - Admin-only statements (CREATE/REGISTER/REFRESH DATASOURCE, COMPILE/REMOVE/ACTIVATE USL, REGISTER/
//     UPDATE DQ) need an admin-role key; the agent's own key only SELECTs.
//
// Measured on 2.4.3.1: the USL DDL validator rejects a column named source and a table named reference with
// a generic "Invalid DDL statement", hence source_kind and referent; class is unmeasured and the cause entity
// names it cause_class; the validator accepts lock, version, type, result
// and the table names policy, copy, probe, disposition, action and ticket (24 Oct 2026, a scratch USL in
// lightning.metastore.driftprobe, removed after). On that scratch USL, 24 Oct 2026: a custom rule survives
// REFRESH DATASOURCE TABLES and a re-ACTIVATE and is dropped by COMPILE USL IF NOT EXISTS over the existing
// USL, which re-deploys the model from the DDL; over a USL with another table set the same COMPILE replaced
// the table list and left LIST DQ USL failing ("Catn't find tables for probe"). REMOVE USL returns one row,
// removed = true, and the namespace lists no USL after it. UPDATE DQ r TABLE t SET NAME = r, EXPRESSION = e
// replaced the listed expression in place. RUN DQ TABLE returns name | table | type | total_record |
// valid_record | invalid_record, the custom rules and the key constraints as rows.
//
// Measured live 24 Oct 2026 against the configured instance: REGISTER DATASOURCE TABLES FROM DRIFT on an existing
// source registers every table it lacks (SHOW DATASOURCE TABLES: 8, then 16), and REFRESH alone registers none, so
// the plan lists the source's tables first. UPDATE DQ replaced run_complete's listed expression in place (33 ok, 9
// skipped, 9.2 s). After the export of the 23:35 UTC collection: 42 statements, 32 ok, 10 skipped, 0 failed, 9.4 s,
// every rule listed as stated; RUN DQ: run_complete on collection 19 / 19 / 0, copy_validated on copy 336 / 282 / 54,
// action_verified on action 0 / 0 / 0. The copy entity over two vault copies and three validations written for the
// measurement and deleted after: each copy carries its latest validation (ok_with_gaps over an earlier fail:
// validated 1; fail: validated 0), and RUN DQ on copy gave copy_validated 2 / 1 / 1.
//
// Measured live 25 Oct 2026, 01:16 UTC: a stale USL (columns differ in action) takes REMOVE USL, then COMPILE.
// COMPILE leaves no DQ rule registered, so LIST DQ lists none of the three, REGISTER runs for all three
// (action_verified with its scoped expression) and every UPDATE DQ step is skipped as registered this run: 42
// statements, 37 ok, 5 skipped, 0 failed, 10.0 s. UPDATE DQ remains the path when a rule is listed with another
// expression and the USL is current.
//
// Measured live 25 Oct 2026, 20:44 UTC: the ten-table USL is stale ("lacks cause"), REMOVE USL, then COMPILE of the
// eleven, cause_class accepted; the eleven activate, LIST DQ lists none of the four, REGISTER runs for all four: 47
// statements, 41 ok, 6 skipped, 0 failed, 13.0 s. RUN DQ: run_complete 135 / 135 / 0, copy_validated 2268 / 1967 /
// 301, action_verified 18 / 16 / 2, cause_evidenced on cause 4 / 4 / 0 (the four lab-1 causes, each operator_edit
// with its evidence ids), the cause entity's disposition_id foreign key 4 / 4 / 0.

import { Zetaris, type QueryResult } from "../adapters/zetaris.ts";
import { config, redact } from "../config.ts";
import { TABLE_NAMES } from "../data/schema.ts";
import type { Tracer, TraceEvent } from "../trace.ts";

export const NAMESPACE = "lightning.metastore.drift";
export const USL_NAME = "drift_usl";
export const USL = `${NAMESPACE}.${USL_NAME}`;
const DESCRIPTION = "drift-agent app Postgres on the zetaris network";
const AGENT = "zetaris-setup";
const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;
const PG_IDENT = /^[A-Za-z0-9_-]+$/;

/**
 * The USL's eleven tables, column lines in DDL order. The first four are the collected estate; policy is
 * policy_rule; copy is vault_copy with its latest copy_validation; probe, disposition, action (reason and
 * record included) and ticket are their datasource tables; cause is finding_cause, class named cause_class.
 */
const USL_DDL = {
  collection: [
    "run_id varchar(128) NOT NULL PRIMARY KEY",
    "tenant_id varchar(64) NOT NULL",
    "surface varchar(64) NOT NULL",
    "host varchar(128)",
    "started_at varchar(40) NOT NULL",
    "expected_count int",
    "observed_count int",
    "status varchar(16) NOT NULL",
  ],
  setting: [
    "setting_id varchar(128) NOT NULL PRIMARY KEY",
    "run_id varchar(128) NOT NULL FOREIGN KEY REFERENCES collection(run_id)",
    "tenant_id varchar(64) NOT NULL",
    "host varchar(128)",
    "surface varchar(64) NOT NULL",
    "object_id varchar(512) NOT NULL",
    "setting_path varchar(512) NOT NULL",
    "value_hash varchar(80) NOT NULL",
    "refers_to_type varchar(32)",
    "refers_to_id varchar(255)",
    "observed_at varchar(40) NOT NULL",
    "source_kind varchar(32) NOT NULL",
    "authority int NOT NULL",
  ],
  referent: [
    "ref_id varchar(255) NOT NULL PRIMARY KEY",
    "setting_id varchar(128) NOT NULL FOREIGN KEY REFERENCES setting(setting_id)",
    "tenant_id varchar(64) NOT NULL",
    "target_type varchar(32) NOT NULL",
    "target_name varchar(255) NOT NULL",
    "resolves_to varchar(255) NOT NULL",
    "proxied int",
    "resolved_at varchar(40) NOT NULL",
    "dns_run_id varchar(128) NOT NULL",
  ],
  backup_copy: [
    "copy_id varchar(1024) NOT NULL PRIMARY KEY",
    "tenant_id varchar(64) NOT NULL",
    "host varchar(128) NOT NULL",
    "kind varchar(16) NOT NULL",
    "object_id varchar(512) NOT NULL",
    "setting_path varchar(512) NOT NULL",
    "value_hash varchar(80) NOT NULL",
    "taken_at varchar(40) NOT NULL",
  ],
  policy: [
    "rule_id varchar(128) NOT NULL PRIMARY KEY",
    "tenant_id varchar(64) NOT NULL",
    "surface varchar(64) NOT NULL",
    "object_glob varchar(512) NOT NULL",
    "setting_glob varchar(512) NOT NULL",
    "criticality varchar(16) NOT NULL",
    "lock int NOT NULL",
    "on_drift varchar(16) NOT NULL",
    "on_no_copy varchar(32) NOT NULL",
    "hold_max_hours int NOT NULL",
    "alert varchar(16) NOT NULL",
    "psa_priority varchar(8) NOT NULL",
    "version int NOT NULL",
    "author varchar(128) NOT NULL",
    "since varchar(40) NOT NULL",
    "note varchar(1024)",
  ],
  copy: [
    "copy_id varchar(128) NOT NULL PRIMARY KEY",
    "tenant_id varchar(64) NOT NULL",
    "surface varchar(64) NOT NULL",
    "host varchar(128)",
    "object_id varchar(512) NOT NULL",
    "run_id varchar(128) NOT NULL FOREIGN KEY REFERENCES collection(run_id)",
    "git_commit varchar(64) NOT NULL",
    "blob_sha256 varchar(80) NOT NULL",
    "taken_at varchar(40) NOT NULL",
    "source_kind varchar(32) NOT NULL",
    "validator varchar(16)",
    "result varchar(16)",
    "validated_at varchar(40)",
    "validated int NOT NULL",
  ],
  probe: [
    "probe_id varchar(128) NOT NULL PRIMARY KEY",
    "run_id varchar(128) NOT NULL FOREIGN KEY REFERENCES collection(run_id)",
    "tenant_id varchar(64) NOT NULL",
    "kind varchar(16) NOT NULL",
    "target varchar(255) NOT NULL",
    "expected varchar(512) NOT NULL",
    "observed varchar(1024) NOT NULL",
    "status varchar(16) NOT NULL",
    "latency_ms int",
    "observed_at varchar(40) NOT NULL",
  ],
  disposition: [
    "disposition_id varchar(128) NOT NULL PRIMARY KEY",
    "tenant_id varchar(64) NOT NULL",
    "surface varchar(64) NOT NULL",
    "host varchar(128)",
    "object_id varchar(512) NOT NULL",
    "setting_path varchar(512) NOT NULL",
    "value_hash varchar(80) NOT NULL",
    "verb varchar(16) NOT NULL",
    "reason varchar(1024) NOT NULL",
    "expires_at varchar(40)",
    "decided_by varchar(16) NOT NULL",
    "rule_id varchar(128)",
    "finding_id varchar(255) NOT NULL",
    "run_id varchar(128) NOT NULL FOREIGN KEY REFERENCES collection(run_id)",
    "decided_at varchar(40) NOT NULL",
  ],
  action: [
    "action_id varchar(128) NOT NULL PRIMARY KEY",
    "tenant_id varchar(64) NOT NULL",
    "kind varchar(32) NOT NULL",
    "target varchar(512) NOT NULL",
    "before_hash varchar(80)",
    "after_hash varchar(80)",
    "vault_commit varchar(64)",
    "verification varchar(2048) NOT NULL",
    "receipts varchar(2048) NOT NULL",
    "status varchar(16) NOT NULL",
    "reason varchar(1024) NOT NULL",
    "record varchar(4096) NOT NULL",
    "started_at varchar(40) NOT NULL",
    "finished_at varchar(40)",
    "disposition_id varchar(128) NOT NULL FOREIGN KEY REFERENCES disposition(disposition_id)",
  ],
  ticket: [
    "ticket_id varchar(128) NOT NULL PRIMARY KEY",
    "tenant_id varchar(64) NOT NULL",
    "psa varchar(32) NOT NULL",
    "external_id varchar(128)",
    "url varchar(512)",
    "type varchar(16) NOT NULL",
    "priority varchar(8) NOT NULL",
    "status varchar(32) NOT NULL",
    "action_id varchar(128)",
    "finding_id varchar(255) NOT NULL",
    "created_at varchar(40) NOT NULL",
    "updated_at varchar(40) NOT NULL",
  ],
  cause: [
    "cause_id varchar(128) NOT NULL PRIMARY KEY",
    "tenant_id varchar(64) NOT NULL",
    "finding_id varchar(255) NOT NULL",
    "disposition_id varchar(128) NOT NULL FOREIGN KEY REFERENCES disposition(disposition_id)",
    "cause_class varchar(32) NOT NULL",
    "actor varchar(255)",
    "mechanism varchar(64)",
    "occurred_at varchar(40)",
    "source_host varchar(128)",
    "evidence_ids varchar(2048) NOT NULL",
    "diff varchar(8192)",
    "summary varchar(1024) NOT NULL",
    "window_from varchar(40) NOT NULL",
    "window_to varchar(40) NOT NULL",
    "decided_at varchar(40) NOT NULL",
  ],
} as const;

export type UslTable = keyof typeof USL_DDL;
export const USL_TABLES = Object.keys(USL_DDL) as UslTable[];

/** Each USL table's column names in DDL order: what LOAD USL must report for the USL to be current. */
export const USL_COLUMNS: Readonly<Record<UslTable, readonly string[]>> = Object.fromEntries(
  USL_TABLES.map((t) => [t, USL_DDL[t].map((l) => l.split(" ")[0])]),
) as unknown as Record<UslTable, readonly string[]>;

/** Each CREATE TABLE starts on its own line; the whole block is one request. */
export const COMPILE_USL = `COMPILE USL IF NOT EXISTS ${USL_NAME} DEPLOY NAMESPACE ${NAMESPACE} DDL\n${USL_TABLES.map((t) => `CREATE TABLE ${t} (\n${USL_DDL[t].map((l) => `  ${l}`).join(",\n")}\n)`).join(";\n")}`;

export interface DqRule { name: string; table: UslTable; expression: string }

/**
 * The DQ rules. run_complete states RUN_COMPLETE_SQL's self-report half (src/data/queries.ts): both counts
 * present, the observed count at least the asserted one, status complete, so a run that never asserted
 * its population fails here as it fails the pass's gate. copy_validated: the copy's latest validation is
 * ok or ok_with_gaps. action_verified, scoped to the write paths: a done rollback_file or revert_record
 * names the probes that verified it; an investigation and a fix pass it whatever they carry. A write that
 * completed with no verification probe run or read carries status unverified, never done, so the rule's
 * status <> 'done' arm passes its row: the status itself records the missing verification, and a done row
 * with no probe id stays the one row the rule fails. cause_evidenced: a cause of any class but unknown names at
 * least one audit_event or action id; evidence_ids is a JSON array as text, '[]' when it names none, so the rule
 * compares plain columns.
 */
export const DQ_RULES: readonly DqRule[] = [
  { name: "run_complete", table: "collection", expression: "observed_count IS NOT NULL AND expected_count IS NOT NULL AND observed_count >= expected_count AND status = 'complete'" },
  { name: "copy_validated", table: "copy", expression: "validated = 1" },
  { name: "action_verified", table: "action", expression: "kind NOT IN ('rollback_file','revert_record') OR status IN ('failed','refused','not_judged') OR verification <> ''" },
  { name: "cause_evidenced", table: "cause", expression: "cause_class = 'unknown' OR evidence_ids <> '[]'" },
];
/** The tables RUN DQ runs on, one statement each. */
export const DQ_TABLES: readonly UslTable[] = ["collection", "copy", "action", "cause"];
export const DQ_RULE = "run_complete";

/** How an entity's rows are formed from its tables, for each entity whose rows are other than one table's rows under its own column names. */
const USL_FORMED: Partial<Record<UslTable, string>> = {
  setting: "`obs_id` as `setting_id`, `source` as `source_kind`",
  referent: "each `observation` whose `refers_to_type` is `dns_name`, joined to the `dns_record` rows of its tenant whose `name` is its `refers_to_id`, the join the hero query makes for FOUND-BUT-DIFFERENT",
  backup_copy: "each `backup_item` joined to its `backup_snapshot`",
  copy: "each `vault_copy` with its latest `copy_validation` (by `validated_at`, then `validation_id`); `validated` is 1 when that result is ok or ok_with_gaps",
  cause: "`class` as `cause_class`",
};

export interface UslRow {
  entity: UslTable;
  /** The DRIFT tables its activation SELECT reads, each once, in first-appearance order. */
  builtFrom: string[];
  /** How its rows are formed from those tables; empty when each row is one row of its one table. */
  formed: string;
  /** The PRIMARY KEY column of USL_DDL. */
  primaryKey: string;
  /** Each FOREIGN KEY of USL_DDL: the column and the entity(column) it references. */
  foreignKeys: { column: string; references: string }[];
  /** The DQ rule registered on the entity, when one is. */
  rule?: DqRule;
}

/** One row per USL entity, in DDL order, read off USL_DDL, activation() over the DRIFT datasource and DQ_RULES. */
export function uslRows(): UslRow[] {
  return USL_TABLES.map((entity) => {
    const lines = USL_DDL[entity] as readonly string[];
    const name = (l: string): string => l.split(" ")[0];
    return {
      entity,
      builtFrom: [...new Set([...activation(entity, "DRIFT").matchAll(/\bDRIFT\.(\w+)/g)].map((m) => m[1]))],
      formed: USL_FORMED[entity] ?? "",
      primaryKey: name(lines.find((l) => l.includes(" PRIMARY KEY"))!),
      foreignKeys: lines.flatMap((l) => {
        const fk = / FOREIGN KEY REFERENCES (\w+\(\w+\))/.exec(l);
        return fk ? [{ column: name(l), references: fk[1] }] : [];
      }),
      rule: DQ_RULES.find((r) => r.table === entity),
    };
  });
}

/** The semantic layer as markdown: one sentence, then the table. What npm run sources -- --usl prints and the README carries under "The semantic layer". */
export function uslMarkdown(): string {
  const code = (s: string): string => `\`${s}\``;
  const rows = uslRows();
  const cells = (r: UslRow): string[] => [
    code(r.entity),
    [r.builtFrom.map(code).join(", "), r.formed].filter(Boolean).join(": "),
    [code(r.primaryKey), ...r.foreignKeys.map((f) => `${code(f.column)} references ${code(f.references)}`)].join("; "),
    r.rule ? code(r.rule.name) : "",
    r.rule ? code(r.rule.expression) : "",
  ];
  return [
    `${code(USL_NAME)} in ${code(NAMESPACE)} is the semantic layer over the ${code("DRIFT")} datasource: ${rows.length} entities, each activated as one SELECT over the tables it is built from (${code("activation()")} in ${code("src/zetaris/setup.ts")}), and ${DQ_RULES.length} DQ rules, each an expression RUN DQ tests on every row of its entity.`,
    "",
    "| entity | built from | key | DQ rule | expression |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${cells(r).join(" | ")} |`),
    "",
  ].join("\n");
}

export class SetupError extends Error {
  constructor(message: string) { super(redact(message)); }
}

export interface SetupEnv {
  /** postgresql://user:password@host:port/db as the app reaches it; only user, password and db are used. */
  databaseUrl: string;
  /** host[:port] as the Zetaris driver container reaches the same Postgres. */
  pgHost: string;
  datasource: string;
}

export function envFromProcess(): SetupEnv {
  return { databaseUrl: process.env.DATABASE_URL ?? "", pgHost: config.zetaris.pgHost, datasource: config.zetaris.datasource };
}

/**
 * Run a step only in this state. datasource_absent / datasource_present: SHOW DATASOURCES listed the
 * source or not. tables_missing: the source was created this run, or SHOW DATASOURCE TABLES lacks a table
 * of sql/schema.sql. tables_registered: the source existed and lists every one. usl_present: the namespace
 * lists drift_usl. usl_stale: LOAD USL reports other tables or columns than COMPILE_USL. usl_absent: no
 * drift_usl at the start, or removed this run. dq_rule_absent / dq_rule_differs: LIST DQ USL does not list
 * step.rule, or lists it with another expression.
 */
export type When =
  | "datasource_absent" | "datasource_present" | "tables_missing" | "tables_registered"
  | "usl_present" | "usl_stale" | "usl_absent" | "dq_rule_absent" | "dq_rule_differs";

export interface Step {
  name: string;
  /** The statement as printed. For CREATE DATASOURCE the password is "<redacted>". */
  sql: string;
  /** The statement as sent, built in memory when it runs. Only CREATE DATASOURCE has one. */
  secret?: () => string;
  /** The trace line's input_summary instead of sql, for a statement that carries credentials. */
  traceAs?: string;
  when?: When;
  /** The DQ rule a dq_rule_* condition is about. */
  rule?: DqRule;
  /** What the result tells the steps after it. */
  probe?: "datasources" | "datasource_tables" | "usl" | "usl_model" | "dq_rules";
  /** An "already exist" error from this step means the datasource existed. */
  marksDatasource?: true;
  /** A success from this step means the USL is gone (REMOVE USL). */
  removesUsl?: true;
  multi?: true;
  /** Print the result rows. */
  show?: true;
  /** A RUN DQ step: its rows go to ApplyResult.dqRuns under this table. */
  dqTable?: UslTable;
  timeoutMs?: number;
}

interface PgTarget { user: string; password: string; db: string; host: string; port: string }

/** Parse DATABASE_URL and ZETARIS_PG_HOST. Messages never carry the URL. */
function pgTarget(env: SetupEnv): PgTarget {
  if (!env.databaseUrl) throw new SetupError("DATABASE_URL is not set");
  let u: URL;
  try { u = new URL(env.databaseUrl); } catch { throw new SetupError("DATABASE_URL is not a URL"); }
  if (!/^postgres(?:ql)?:$/.test(u.protocol)) throw new SetupError("DATABASE_URL must be postgres:// or postgresql://");
  let user: string, password: string, db: string;
  try {
    [user, password, db] = [u.username, u.password, u.pathname.replace(/^\//, "")].map(decodeURIComponent);
  } catch { throw new SetupError("DATABASE_URL has a malformed percent-escape"); }
  if (!user || !password || !db) throw new SetupError("DATABASE_URL must carry a user, a password and a database");
  if (!PG_IDENT.test(user) || !PG_IDENT.test(db)) throw new SetupError("DATABASE_URL user and database must be [A-Za-z0-9_-]");
  // Zetaris option values are double-quoted; how it escapes a quote inside one is unmeasured, so such a password is refused.
  if (/["\\\r\n]/.test(password)) throw new SetupError("the DATABASE_URL password holds a double quote, backslash or newline; Zetaris option values are double-quoted and their escaping is unmeasured");
  const m = env.pgHost.match(/^([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d{1,5}))?$/);
  if (!m) throw new SetupError("ZETARIS_PG_HOST must be host or host:port");
  return { user, password, db, host: m[1], port: m[2] ?? "5432" };
}

function createDatasource(ds: string, t: PgTarget, password: string): string {
  return `CREATE DATASOURCE ${ds} DESCRIBE BY "${DESCRIPTION}" OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://${t.host}:${t.port}/${t.db}", username "${t.user}", password "${password}", schema "public", fetchsize "1000")`;
}

/** COALESCE(c, '') AS c for each NOT NULL varchar, the bare column for a nullable one. */
const keep = (cols: string): string => cols.split(/\s+/).filter(Boolean).map((c) => (c.startsWith("?") ? c.slice(1) : `COALESCE(${c}, '') AS ${c}`)).join(", ");

/** The activation query per USL table: exactly the declared columns, NOT NULL varchars wrapped in COALESCE, ints CAST. */
export function activation(table: UslTable, ds: string): string {
  switch (table) {
    case "collection":
      return `SELECT COALESCE(run_id, '') AS run_id, COALESCE(tenant_id, '') AS tenant_id, COALESCE(surface, '') AS surface, host, COALESCE(started_at, '') AS started_at, CAST(expected_count AS INT) AS expected_count, CAST(observed_count AS INT) AS observed_count, COALESCE(status, '') AS status FROM ${ds}.collection_run`;
    case "setting":
      return `SELECT COALESCE(obs_id, '') AS setting_id, COALESCE(run_id, '') AS run_id, COALESCE(tenant_id, '') AS tenant_id, host, COALESCE(surface, '') AS surface, COALESCE(object_id, '') AS object_id, COALESCE(setting_path, '') AS setting_path, COALESCE(value_hash, '') AS value_hash, refers_to_type, refers_to_id, COALESCE(observed_at, '') AS observed_at, COALESCE(source, '') AS source_kind, CAST(COALESCE(authority, 0) AS INT) AS authority FROM ${ds}.observation`;
    case "referent":
      return `SELECT CONCAT(o.obs_id, ':', d.record_id, ':', d.run_id) AS ref_id, COALESCE(o.obs_id, '') AS setting_id, COALESCE(o.tenant_id, '') AS tenant_id, COALESCE(o.refers_to_type, '') AS target_type, COALESCE(o.refers_to_id, '') AS target_name, COALESCE(d.content, '') AS resolves_to, CAST(d.proxied AS INT) AS proxied, COALESCE(d.observed_at, '') AS resolved_at, COALESCE(d.run_id, '') AS dns_run_id FROM ${ds}.observation o JOIN ${ds}.dns_record d ON d.tenant_id = o.tenant_id AND d.name = o.refers_to_id WHERE o.refers_to_type = 'dns_name'`;
    case "backup_copy":
      return `SELECT CONCAT(b.snapshot_id, ':', b.object_id, ':', b.setting_path) AS copy_id, COALESCE(s.tenant_id, '') AS tenant_id, COALESCE(s.host, '') AS host, COALESCE(s.kind, '') AS kind, COALESCE(b.object_id, '') AS object_id, COALESCE(b.setting_path, '') AS setting_path, COALESCE(b.value_hash, '') AS value_hash, COALESCE(s.taken_at, '') AS taken_at FROM ${ds}.backup_item b JOIN ${ds}.backup_snapshot s ON s.snapshot_id = b.snapshot_id`;
    case "policy":
      return `SELECT ${keep("rule_id tenant_id surface object_glob setting_glob criticality")}, CAST(COALESCE(lock, 0) AS INT) AS lock, ${keep("on_drift on_no_copy")}, CAST(COALESCE(hold_max_hours, 0) AS INT) AS hold_max_hours, ${keep("alert psa_priority")}, CAST(COALESCE(version, 0) AS INT) AS version, ${keep("author since ?note")} FROM ${ds}.policy_rule`;
    case "copy":
      // The latest validation per copy (latest validated_at, then validation_id): the correlation sits in the subquery's WHERE.
      return `SELECT COALESCE(c.copy_id, '') AS copy_id, COALESCE(c.tenant_id, '') AS tenant_id, COALESCE(c.surface, '') AS surface, c.host, COALESCE(c.object_id, '') AS object_id, COALESCE(c.run_id, '') AS run_id, COALESCE(c.git_commit, '') AS git_commit, COALESCE(c.blob_sha256, '') AS blob_sha256, COALESCE(c.taken_at, '') AS taken_at, COALESCE(c.source, '') AS source_kind, l.validator, l.result, l.validated_at, CAST(CASE WHEN l.result IN ('ok', 'ok_with_gaps') THEN 1 ELSE 0 END AS INT) AS validated FROM ${ds}.vault_copy c LEFT JOIN (SELECT v.copy_id, v.validator, v.result, v.validated_at FROM ${ds}.copy_validation v WHERE NOT EXISTS (SELECT 1 FROM ${ds}.copy_validation w WHERE w.copy_id = v.copy_id AND (w.validated_at > v.validated_at OR (w.validated_at = v.validated_at AND w.validation_id > v.validation_id)))) l ON l.copy_id = c.copy_id`;
    case "probe":
      return `SELECT ${keep("probe_id run_id tenant_id kind target expected observed status")}, CAST(latency_ms AS INT) AS latency_ms, ${keep("observed_at")} FROM ${ds}.probe`;
    case "disposition":
      return `SELECT ${keep("disposition_id tenant_id surface ?host object_id setting_path value_hash verb reason ?expires_at decided_by ?rule_id finding_id run_id decided_at")} FROM ${ds}.disposition`;
    case "action":
      return `SELECT ${keep("action_id tenant_id kind target ?before_hash ?after_hash ?vault_commit verification receipts status reason record started_at ?finished_at disposition_id")} FROM ${ds}.action`;
    case "ticket":
      return `SELECT ${keep("ticket_id tenant_id psa ?external_id ?url type priority status ?action_id finding_id created_at updated_at")} FROM ${ds}.ticket`;
    case "cause":
      return `SELECT ${keep("cause_id tenant_id finding_id disposition_id")}, COALESCE(class, '') AS cause_class, ${keep("?actor ?mechanism ?occurred_at ?source_host evidence_ids ?diff summary window_from window_to decided_at")} FROM ${ds}.finding_cause`;
  }
}

/** The ordered statements. Throws SetupError when DATABASE_URL or ZETARIS_PG_HOST cannot build the datasource. */
export function plan(env: SetupEnv = envFromProcess()): Step[] {
  const ds = env.datasource;
  if (!IDENT.test(ds)) throw new SetupError("ZETARIS_DATASOURCE must be an unquoted identifier");
  const t = pgTarget(env);
  const dqTable = (r: DqRule) => `${USL}.${r.table}`;
  return [
    { name: "show datasources", sql: "SHOW DATASOURCES", probe: "datasources" },
    {
      name: `create datasource ${ds}`, sql: createDatasource(ds, t, "<redacted>"), secret: () => createDatasource(ds, t, t.password),
      traceAs: `CREATE DATASOURCE ${ds} (credentials redacted)`, when: "datasource_absent", marksDatasource: true,
    },
    { name: "list datasource tables", sql: `SHOW DATASOURCE TABLES ${ds}`, when: "datasource_present", probe: "datasource_tables" },
    { name: "register datasource tables", sql: `REGISTER DATASOURCE TABLES FROM ${ds}`, when: "tables_missing" },
    { name: "refresh datasource tables", sql: `REFRESH DATASOURCE TABLES FROM ${ds}`, when: "tables_registered" },
    { name: "namespace lightning.metastore", sql: "CREATE NAMESPACE IF NOT EXISTS lightning.metastore" },
    { name: `namespace ${NAMESPACE}`, sql: `CREATE NAMESPACE IF NOT EXISTS ${NAMESPACE}` },
    { name: `list ${NAMESPACE}`, sql: `SHOW NAMESPACES OR TABLES IN ${NAMESPACE}`, probe: "usl" },
    { name: `load usl ${USL_NAME}`, sql: `LOAD USL ${USL_NAME} NAMESPACE ${NAMESPACE}`, when: "usl_present", probe: "usl_model" },
    { name: `remove usl ${USL_NAME}`, sql: `REMOVE USL ${USL_NAME} NAMESPACE ${NAMESPACE}`, when: "usl_stale", removesUsl: true },
    { name: `compile usl ${USL_NAME}`, sql: COMPILE_USL, when: "usl_absent", multi: true, timeoutMs: 120_000 },
    ...USL_TABLES.map((tb): Step => ({ name: `activate ${tb}`, sql: `ACTIVATE USL TABLE ${USL}.${tb} AS ${activation(tb, ds)}`, timeoutMs: 120_000 })),
    { name: "list dq rules", sql: `LIST DQ USL ${USL}`, probe: "dq_rules" },
    ...DQ_RULES.flatMap((r): Step[] => [
      { name: `register dq ${r.name}`, sql: `REGISTER DQ ${r.name} TABLE ${dqTable(r)} AS ${r.expression}`, when: "dq_rule_absent", rule: r },
      { name: `update dq ${r.name}`, sql: `UPDATE DQ ${r.name} TABLE ${dqTable(r)} SET NAME = ${r.name}, EXPRESSION = ${r.expression}`, when: "dq_rule_differs", rule: r },
    ]),
    ...DQ_TABLES.map((tb): Step => ({ name: `run dq ${tb}`, sql: `RUN DQ TABLE ${USL}.${tb}`, show: true, dqTable: tb, timeoutMs: 150_000 })),
    { name: `show ${USL}`, sql: `SHOW NAMESPACES OR TABLES IN ${USL}`, show: true },
    ...USL_TABLES.map((tb): Step => ({ name: `count ${tb}`, sql: `SELECT COUNT(*) AS n FROM ${USL}.${tb}` })),
  ];
}

const WHEN_TEXT: Record<When, (ds: string, s: Step) => string> = {
  datasource_absent: (ds) => `only when ${ds} is absent`,
  datasource_present: (ds) => `only when ${ds} already existed`,
  tables_missing: (ds) => `only when ${ds} was created this run or lacks a table of sql/schema.sql`,
  tables_registered: (ds) => `only when ${ds} already existed and lists every table of sql/schema.sql`,
  usl_present: () => `only when ${NAMESPACE} lists ${USL_NAME}`,
  usl_stale: () => `only when ${USL_NAME}'s tables or columns differ from the ${USL_TABLES.length} below`,
  usl_absent: () => `only when ${USL_NAME} is absent or was removed this run`,
  dq_rule_absent: (_ds, s) => `only when LIST DQ USL lacks ${s.rule?.name}`,
  dq_rule_differs: (_ds, s) => `only when LIST DQ USL lists ${s.rule?.name} with another expression`,
};

/** The plan as printed by --plan: number, name, condition, then the statement indented. No password: sql holds "<redacted>". */
export function formatPlan(steps: Step[], ds: string = config.zetaris.datasource): string[] {
  const lines: string[] = [];
  for (const [i, s] of steps.entries()) {
    const notes = [s.when && WHEN_TEXT[s.when](ds, s), s.multi && "one request"].filter(Boolean);
    lines.push(`${String(i + 1).padStart(2, "0")} ${s.name}${notes.length ? `  (${notes.join("; ")})` : ""}`);
    for (const l of s.sql.split("\n")) lines.push(`     ${l}`);
  }
  return lines.map(redact);
}

export interface StepResult {
  name: string;
  status: "ok" | "skipped" | "failed";
  note: string;
  ms?: number;
  result?: QueryResult;
}

export interface ApplyResult {
  ok: boolean;
  results: StepResult[];
  /** RUN DQ on collection. */
  dq?: QueryResult;
  /** RUN DQ per table it ran on. */
  dqRuns: Partial<Record<UslTable, QueryResult>>;
  error?: string;
  ms: number;
}

export interface ApplyDeps {
  client?: Pick<Zetaris, "query">;
  tracer?: Tracer;
  out?: (line: string) => void;
  env?: SetupEnv;
}

const col = (r: QueryResult, name: string): number => r.columns.findIndex((c) => c.toLowerCase() === name);
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Does SHOW NAMESPACES OR TABLES IN the namespace list the USL? Matches the name column when there is one, else any cell. */
function listsUsl(r: QueryResult): boolean {
  const i = col(r, "name");
  return r.rows.some((row) => (i >= 0 ? row[i] === USL_NAME : row.includes(USL_NAME)));
}

/**
 * LOAD USL's model against COMPILE_USL: the reason it is stale, or null when its tables and their columns
 * are exactly USL_COLUMNS. A model that fails to parse is stale.
 */
export function staleness(r: QueryResult): string | null {
  let model: { tables?: { name?: unknown; columnSpecs?: { name?: unknown }[] }[] };
  try {
    model = JSON.parse(r.rows[0]?.[0] ?? "");
  } catch {
    return "LOAD USL returned no model that parses";
  }
  const have = new Map((model.tables ?? []).map((t) => [String(t.name), (t.columnSpecs ?? []).map((c) => String(c.name))]));
  const want = USL_TABLES;
  const missing = want.filter((t) => !have.has(t));
  const extra = [...have.keys()].filter((t) => !(want as string[]).includes(t)).sort();
  const changed = want.filter((t) => have.has(t) && have.get(t)!.join(",") !== USL_COLUMNS[t].join(","));
  const parts = [
    missing.length ? `lacks ${missing.join(", ")}` : "",
    extra.length ? `holds ${extra.join(", ")} beyond the ${want.length}` : "",
    changed.length ? `columns differ in ${changed.join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? `${have.size} table(s); ${parts.join("; ")}` : null;
}

/** The custom rules LIST DQ USL lists: rule name and table -> expression. Without a table column, the name alone keys it. */
function listedRules(r: QueryResult): Map<string, string> {
  const [n, t, e] = [col(r, "name"), col(r, "table"), col(r, "expression")];
  const out = new Map<string, string>();
  for (const row of r.rows) {
    const name = n >= 0 ? row[n] : undefined;
    if (!name || !DQ_RULES.some((d) => d.name === name)) continue;
    out.set(t >= 0 ? `${name}@${row[t]}` : name, e >= 0 ? row[e] : "");
  }
  return out;
}

function rowsNote(r: QueryResult): string {
  const one = r.rowCount === 1 && r.columns.length === 1 ? r.rows[0][0] : undefined;
  return one !== undefined && one.length <= 40 && !one.includes("\n") ? `= ${one}` : `${r.rowCount} row${r.rowCount === 1 ? "" : "s"}`;
}

function table(r: QueryResult): string[] {
  return [r.columns.join(" | "), ...r.rows.map((row) => row.join(" | "))].map((l) => `     ${l}`);
}

/**
 * Run the plan one statement at a time. Prints one line per statement (status, number, name, note,
 * latency), the rows of each RUN DQ and of the USL's table listing, and a closing summary; emits one trace
 * line per statement, ok, skipped or failed. Stops at the first error that is not "already exist".
 */
export async function apply(deps: ApplyDeps = {}): Promise<ApplyResult> {
  const env = deps.env ?? envFromProcess();
  const client = deps.client ?? new Zetaris();
  const out = deps.out ?? ((l: string) => console.log(l));
  const steps = plan(env);
  const { password } = pgTarget(env);
  const clean = (s: string) => (password.length >= 4 ? redact(s).split(password).join("<redacted>") : redact(s)).slice(0, 400);
  const state = { datasourceExisted: false, missingTables: null as string[] | null, uslPresent: false, uslStale: null as string | null, rules: null as Map<string, string> | null };
  const results: StepResult[] = [];
  const dqRuns: Partial<Record<UslTable, QueryResult>> = {};
  const t0 = Date.now();

  const listed = (r: DqRule): string | undefined => state.rules?.get(`${r.name}@${r.table}`) ?? state.rules?.get(r.name);
  const gate = (s: Step): string | false => {
    switch (s.when) {
      case "datasource_absent": return state.datasourceExisted && `${env.datasource} exists`;
      case "datasource_present": return !state.datasourceExisted && `${env.datasource} created this run`;
      case "tables_missing": return state.datasourceExisted && state.missingTables !== null && state.missingTables.length === 0 && `every table of sql/schema.sql is registered`;
      case "tables_registered":
        return !state.datasourceExisted ? `${env.datasource} created this run`
          : (state.missingTables === null || state.missingTables.length > 0) && `registered this run`;
      case "usl_present": return !state.uslPresent && `${USL_NAME} is absent`;
      case "usl_stale": return state.uslStale === null && (state.uslPresent ? `${USL_NAME} holds the ${USL_TABLES.length} tables as compiled` : `${USL_NAME} is absent`);
      case "usl_absent": return state.uslPresent && `${USL_NAME} holds the ${USL_TABLES.length} tables as compiled`;
      case "dq_rule_absent": return listed(s.rule!) !== undefined && `${s.rule!.name} already registered`;
      case "dq_rule_differs": {
        const e = listed(s.rule!);
        return (e === undefined ? `${s.rule!.name} registered this run` : squash(e) === squash(s.rule!.expression) && `${s.rule!.name} listed as stated`);
      }
      default: return false;
    }
  };

  const record = (i: number, s: Step, res: StepResult, ev: Partial<Omit<TraceEvent, "ts" | "trace_id">> = {}) => {
    results.push(res);
    deps.tracer?.emit({ agent: AGENT, action: "query", engine: "zetaris", status: res.status, input_summary: (s.traceAs ?? s.sql).slice(0, 160), output_summary: res.status === "failed" ? undefined : res.note, latency_ms: res.ms, ...ev });
    const label = `${String(i + 1).padStart(2, "0")} ${s.name}`;
    out(`${res.status.padEnd(7)} ${label.padEnd(44)} ${res.note}${res.ms !== undefined ? `  (${res.ms} ms)` : ""}`);
  };

  for (const [i, s] of steps.entries()) {
    const gated = gate(s);
    if (gated) {
      record(i, s, { name: s.name, status: "skipped", note: gated });
      continue;
    }
    const s0 = Date.now();
    try {
      const r = await client.query(s.secret ? s.secret() : s.sql, { limit: 200, timeoutMs: s.timeoutMs ?? 60_000, ...(s.multi ? { allowMultiStatement: true } : {}) });
      let note = rowsNote(r);
      if (s.probe === "datasources") {
        state.datasourceExisted = r.rows.some((row) => row.some((v) => v.toUpperCase() === env.datasource.toUpperCase()));
        note += `, ${env.datasource} ${state.datasourceExisted ? "listed" : "not listed"}`;
      }
      if (s.probe === "datasource_tables") {
        const i = col(r, "name");
        const listedTables = new Set(r.rows.map((row) => (i >= 0 ? row[i] : row[0])));
        state.missingTables = TABLE_NAMES.filter((t) => !listedTables.has(t));
        note += state.missingTables.length ? `, ${state.missingTables.length} of ${TABLE_NAMES.length} schema tables unregistered: ${state.missingTables.join(", ")}` : `, all ${TABLE_NAMES.length} schema tables registered`;
      }
      if (s.probe === "usl") {
        state.uslPresent = listsUsl(r);
        note += `, ${USL_NAME} ${state.uslPresent ? "listed" : "not listed"}`;
      }
      if (s.probe === "usl_model") {
        state.uslStale = staleness(r);
        note = state.uslStale === null ? `${USL_TABLES.length} tables as compiled` : `stale: ${state.uslStale}`;
      }
      if (s.removesUsl) {
        state.uslPresent = false;
        state.rules = null;
      }
      if (s.probe === "dq_rules") {
        state.rules = listedRules(r);
        const say = DQ_RULES.map((d) => {
          const e = listed(d);
          return `${d.name} ${e === undefined ? "not listed" : squash(e) === squash(d.expression) ? "listed" : "listed with another expression"}`;
        });
        note += `, ${say.join(", ")}`;
      }
      if (s.dqTable) dqRuns[s.dqTable] = r;
      record(i, s, { name: s.name, status: "ok", note, ms: Date.now() - s0, result: r }, { query_id: r.queryId });
      if (s.show) for (const l of table(r)) out(l);
    } catch (e) {
      const msg = clean((e as Error).message ?? String(e));
      if (/already exist/i.test(msg)) {
        if (s.marksDatasource) state.datasourceExisted = true;
        record(i, s, { name: s.name, status: "skipped", note: "already exists", ms: Date.now() - s0 }, { detail: msg });
        continue;
      }
      record(i, s, { name: s.name, status: "failed", note: msg, ms: Date.now() - s0 }, { detail: msg });
      const ms = Date.now() - t0;
      out(`ZETARIS SETUP FAILED at ${String(i + 1).padStart(2, "0")} ${s.name} after ${ms} ms: ${msg}`);
      return { ok: false, results, dq: dqRuns.collection, dqRuns, error: msg, ms };
    }
  }

  const ms = Date.now() - t0;
  const n = (st: StepResult["status"]) => results.filter((r) => r.status === st).length;
  out(`ZETARIS SETUP: ${results.length} statements, ${n("ok")} ok, ${n("skipped")} skipped, 0 failed, ${(ms / 1000).toFixed(1)} s`);
  return { ok: true, results, dq: dqRuns.collection, dqRuns, ms };
}
