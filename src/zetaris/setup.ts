// Idempotent Zetaris setup: the DRIFT datasource over the app Postgres, the LESSONS and RULES Lightning databases
// over files in the Zetaris filestore (the technician's memory store and the policy file, src/data/files.ts), the
// CLOUDFLARE Lightning database over the Cloudflare DNS API (one REST table per zone and page, read live), the
// drift_usl Unified Semantic Layer over the four (twenty-five tables) and six DQ rules on it. plan() lists the steps
// in the order they run, apply() runs them one at a time. uslRows() and uslMarkdown() read the layer's table off
// USL_DDL, activation() and DQ_RULES: each entity, the tables its activation SELECT reads, the catalogue tables read
// through it, its keys and its DQ rule with the rule's expression. npm run sources -- --usl prints it, and the README
// and the replay page's Sources tab carry it.
//
// The USL is what the agent reads: READ_AS names, for each of the twenty tables the catalogue reads as {{t:<table>}},
// the entity built from that table alone, and uslRelation() the relation the live engine renders it as (the entity, or a
// SELECT of the table's columns from it under the table's own names, src/data/engines/zetaris.ts). Ten entities exist
// for that alone: dns_record, inventory_asset, approved_setting, backup_snapshot, backup_item, vault_copy,
// copy_validation, referent_fingerprint, audit_event and change_window, each its table's columns, source as
// source_kind, and a key of its key columns joined by ':' where the table's key is several columns.
//
// The first fifteen tables: collection (collection_run), setting (observation; source_kind for source), referent (each
// dns_name observation joined to the records of its name), backup_copy (backup_item joined to its snapshot),
// policy (policy_rule), copy (vault_copy with its latest copy_validation and a validated flag), probe,
// disposition, action (the Actor's rows, the reason and the record among them), ticket, cause (finding_cause,
// the explainer's rows; cause_class for class), lesson (LESSONS.lesson), rule (RULES.rule), adoption (every ADOPT
// decided under an accepted exception, DRIFT.disposition LEFT JOINed to the LESSONS.lesson its reason names: the
// catalogue's ADOPTION_SQL) and dns_live (every record the DNS API returns now, CLOUDFLARE.zone_<zone id> exploded,
// LEFT JOINed to the last complete cloudflare.dns run of DRIFT.collection_run and to that run's DRIFT.dns_record row
// of the same record id). The six rules:
//   run_complete     on collection: observed_count IS NOT NULL AND expected_count IS NOT NULL AND
//                    observed_count >= expected_count AND status = 'complete'
//   copy_validated   on copy: validated = 1
//   action_verified  on action, scoped to the write paths: kind NOT IN ('rollback_file','revert_record') OR
//                    status IN ('failed','refused','not_judged') OR verification <> ''; a done or unverified write
//                    that names no verifying probe fails the rule, its status carrying what is missing
//   cause_evidenced  on cause: cause_class = 'unknown' OR evidence_ids <> '[]'; a cause of any class but unknown
//                    names at least one evidence id
//   exception_in_force on adoption: lesson_id IS NOT NULL AND lesson_kind = 'exception' AND lesson_recorded_at <=
//                    decided_at AND decided_at < lesson_expires_at; the lesson an ADOPT names was in force when it
//                    was decided
//   dns_inventory_current on dns_live: held_type <> '' AND held_type = live_type AND held_proxied = live_proxied;
//                    every record live at the provider is a record of the last complete DNS run, with the same type
//                    and proxied flag. A row that fails means the provider changed since that run: the agent's
//                    picture of the zone is stale until the next collection.
//
// Contract:
//   - The file sources: every run writes ledger.json (the store's H-MEM ledger, entry for entry), lessons.json and
//     rules.json (src/data/file-rows.ts) into FILESTORE_DIR in the driver container (src/zetaris/filestore.ts), each
//     one JSON array, and records the copy's hash in COPY_STATE_FILE (.world/filestore-copy.json); the live pass and
//     npm run answer put the files again when their hash differs from it (refreshFileTables). SHOW LIGHTNING DATABASES decides each CREATE LIGHTNING DATABASE; SHOW LIGHTNING TABLES lists
//     each database's tables with their path and format, and DESCRIBE DATASOURCE TABLE the columns of lesson and
//     rule. A table listed over another path or format, or with other columns, is dropped and created again; an
//     absent one is created. A table listed as stated is kept: it re-reads its file on every query.
//   - Re-runnable. CREATE DATASOURCE has no IF NOT EXISTS, so SHOW DATASOURCES decides it. REGISTER
//     DATASOURCE TABLES follows a create, and for an existing source runs when SHOW DATASOURCE TABLES lacks
//     a table of sql/schema.sql; REFRESH DATASOURCE TABLES runs when it lists all of them. Namespaces carry
//     IF NOT EXISTS. An error saying "already exist" is done (skipped). Any other error stops the run.
//   - The USL: SHOW NAMESPACES OR TABLES IN lightning.metastore.drift says whether drift_usl exists; LOAD
//     USL reads its model. A model whose tables or columns differ from COMPILE_USL's is stale: CHECK_USL compiles the
//     DDL without DEPLOY, which stores nothing, so a DDL the validator refuses stops the run with the deployed USL
//     intact; then REMOVE USL, then COMPILE afresh. COMPILE runs only when the USL is absent or was removed this run,
//     so an instance already holding the twenty-five tables keeps its USL and its DQ rules. The USL is derived from
//     the datasources, so a removal loses nothing.
//   - Every run re-ACTIVATEs every table (each a SELECT over DRIFT.*, LESSONS.*, RULES.* or CLOUDFLARE.* returning
//     exactly the declared columns, ints CAST; an entity READ_AS builds from one DRIFT table reads its columns bare,
//     the others wrap each NOT NULL varchar in COALESCE), then LIST DQ USL decides each rule of DQ_RULES:
//     REGISTER when the listing lacks it, UPDATE DQ ... SET NAME, EXPRESSION when it is listed with another
//     expression (whitespace aside), nothing when it is listed as stated. RUN DQ on collection, copy,
//     action, cause and adoption, the USL's table listing, a count per table and one of LESSONS.ledger.
//   - One statement per call, except CHECK_USL and COMPILE USL ... DDL: twenty-five CREATE TABLE blocks separated by
//     ';' in one request, sent with the adapter's allowMultiStatement (honoured for COMPILE USL only). The copy is the
//     one step that is no statement: docker, its trace line action observe with no engine.
//   - The CREATE DATASOURCE statement carries the Postgres password and is built in memory when it is
//     sent, nowhere else: plan() holds password "<redacted>", its trace line says only "CREATE DATASOURCE
//     DRIFT (credentials redacted)", and every error message is redact()ed and scrubbed of the literal
//     password before it is printed or traced.
//   - Zetaris reaches the Postgres at ZETARIS_PG_HOST (host[:port], 5432 when absent): measured
//     drift-pg:5432 from the driver container, 127.0.0.1:15432 from Windows. Only the user, password and
//     database come from DATABASE_URL.
//   - Admin-only statements (CREATE/REGISTER/REFRESH DATASOURCE, CREATE LIGHTNING DATABASE, FILESTORE TABLE and REST
//     TABLE, DROP LIGHTNING DATABASE TABLE, COMPILE/REMOVE/ACTIVATE USL, REGISTER/UPDATE DQ) need an admin-role key;
//     the agent's own key only SELECTs.
//   - The REST source: before the plan is built, liveZones() reads the zones the read token sees and each zone's record
//     count from the DNS API (the collector's own GETs, src/collectors/cloudflare.ts), and the plan holds one REST
//     table per zone and page of RECORDS_PER_PAGE records: zone_<zone id> for page 1, zone_<zone id>_p<n> after it. A
//     zone with no record gets no table. SHOW LIGHTNING TABLES CLOUDFLARE decides each CREATE LIGHTNING REST TABLE: a
//     table listed over its endpoint is kept, one listed over another is dropped and created again, an absent one is
//     created. The tables are not cached: a REST table fetches its endpoint on every query, and dns_live is the provider
//     now, at each read; a cached table would hold the records of the instant it was cached. A table keeps the header
//     it was created with, so after the token is rotated its tables are dropped by hand (DROP LIGHTNING DATABASE
//     TABLE CLOUDFLARE.<table>) and the next run creates them again.
//   - The CREATE LIGHTNING REST TABLE statements carry CLOUDFLARE_API_TOKEN in their Authorization header and are built
//     in memory when sent, as CREATE DATASOURCE is: plan() holds "Bearer <redacted>", each trace line reads "CREATE
//     LIGHTNING REST TABLE <table> FROM CLOUDFLARE (token redacted)", and every message is scrubbed of the literal
//     token before it is printed or traced. Zones are matched by Cloudflare's zone id and records by its record id:
//     ids are not pseudonymised, names and contents are, so no join here reads a name or a content.
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
//
// Measured live 25 Oct 2026, 22:11 to 22:28 UTC: CREATE LIGHTNING DATABASE and CREATE LIGHTNING FILESTORE TABLE ...
// FORMAT JSON OPTIONS (path "<absolute path in the driver container>") register a file table; the path is absolute
// inside the container (FILESTORE_DIR). FORMAT JSON reads the file as one document: the newline-delimited
// ledger.jsonl gave 1 row with and without multiLine "false", the same 23 entries as one JSON array 23 rows. A file
// table re-reads its file on every query (2 rows, then 23, no UNCACHE) and keeps the columns it was created with (a
// key added to the file is not resolvable after UNCACHE). SHOW LIGHTNING DATABASES lists RULES as "rules". A second
// CREATE LIGHTNING DATABASE answers 'A database named "RULES" already exists.' The DDL with lesson, rule and adoption
// compiles (COMPILE USL without DEPLOY first, which stores nothing): rule as a table name, description and provenance
// as columns pass. A LEFT JOIN of DRIFT.disposition to LESSONS.lesson with LIKE and || in its ON runs. Then the
// setup: the eleven-table USL stale ("lacks lesson, rule, adoption"), the ledger table over ledger.jsonl dropped and
// created over ledger.json, REMOVE USL, COMPILE of the fourteen, REGISTER for all five rules: 71 steps, 58 ok, 13
// skipped, 0 failed, 23.2 s; again at once, 49 ok, 22 skipped, 0 failed, 18.9 s. RUN DQ: run_complete 140 / 140 / 0,
// copy_validated 2380 / 2079 / 301, action_verified 18 / 16 / 2, cause_evidenced 5 / 5 / 0, exception_in_force on
// adoption 184 / 184 / 0 (8 recorded client-1 passes of 23 ADOPTs each), the adoption entity's lesson_id foreign key
// 184 / 184 / 0; counts lesson 23, rule 15, adoption 184, LESSONS.ledger 23.
//
// Measured live 26 Oct 2026, 03:37 to 03:48 UTC, the REST source: TEST REST REQUEST with HEADER (Authorization "Bearer
// <token>") answered 200 from the DNS API (Zetaris echoes the header as "Bearer***" and the token's last six characters,
// so the setup never runs it). CREATE LIGHTNING REST TABLE over /zones/{id}/dns_records?per_page=500&page=1 infers
// errors, messages, result (an array of structs: id, name, type, content, proxied, ttl and the rest) and result_info;
// SHOW LIGHTNING TABLES lists the endpoint as source_table and table_type rest; a second CREATE answers 'A table named
// "zone_<id>" already exists in database "CLOUDFLARE".' LATERAL VIEW explode(result) needs AS before its alias (without
// it, r.id does not resolve). The six zones the read token sees, 58 records, one page each: the union of the six tables
// LEFT JOINed to the last complete DNS run and its dns_record rows returned 58 rows, 58 current, in 2.7 to 3.9 s
// uncached, each query fetching the six endpoints again. Then the setup: the fourteen-table USL stale ("lacks
// dns_live"), CLOUDFLARE and its six tables created, REMOVE USL, COMPILE of the fifteen, REGISTER for all six rules: 90
// statements, 68 ok, 22 skipped, 0 failed, 44.4 s (the zone read before them 1.7 s); again at once, 53 ok, 37 skipped,
// 0 failed, 38.1 s. RUN DQ: run_complete 157 / 157 / 0, copy_validated 2641 / 2303 / 338, action_verified 18 / 16 / 2,
// cause_evidenced 10 / 10 / 0, exception_in_force 230 / 230 / 0, dns_inventory_current on dns_live 58 / 58 / 0 in 15.6
// s, its record_id key 58 / 58 / 0 and its run_id foreign key 58 / 58 / 0; count dns_live 58, the zones report 58.
//
// Measured live 26 Oct 2026, 06:16 to 07:07 UTC, the USL as the catalogue's one model: CHECK_USL alone compiled the
// twenty-five tables in 47 ms and stored nothing (zone, name, content, type, action and until pass the validator as
// column names; varchar(1048576) passes). Then the setup: the fifteen-table USL stale ("lacks dns_record, ..."), the
// check, REMOVE USL, COMPILE of the twenty-five, every activation accepted, the bare columns of a mirror included under
// their NOT NULL declarations, REGISTER for all six rules: 111 statements, 82 ok, 29 skipped, 0 failed, 62.0 s. RUN DQ:
// run_complete 162 / 162 / 0, copy_validated 2791 / 2791 / 0, action_verified 18 / 16 / 2, cause_evidenced 10 / 10 / 0,
// exception_in_force 230 / 230 / 0, dns_inventory_current 58 / 58 / 0. Again at once: load usl "25 tables as compiled",
// check, remove and compile skipped, 111 statements, 73 ok, 38 skipped, 0 failed, 98.6 s. The read-only pass through
// the USL equals the pass on main over the same rows: 36 findings, 36 dispositions, 549 queries, 30,125 rows; every
// one of its SELECTs reads drift_usl, none DRIFT (the schema guard's DESCRIBEs aside).

import { Zetaris, type QueryResult } from "../adapters/zetaris.ts";
import { API, Cloudflare, RECORDS_PER_PAGE } from "../collectors/cloudflare.ts";
import { config, redact } from "../config.ts";
import { ADOPTION_SQL, EXCEPTION_IN_FORCE, FILE_DATASOURCES, fileTableDef } from "../data/files.ts";
import type { Engine, RunOptions } from "../data/layer.ts";
import { SCHEMA_TABLES, TABLE_NAMES, tableDef, type TableDef } from "../data/schema.ts";
import type { Tracer, TraceEvent } from "../trace.ts";
import { COPY_STATE_FILE, FILESTORE_DIR, filesHash, putFiles, recordCopy, refreshFiles, type PutResult, type Refresh, type RefreshDeps } from "./filestore.ts";

export const NAMESPACE = "lightning.metastore.drift";
export const USL_NAME = "drift_usl";
export const USL = `${NAMESPACE}.${USL_NAME}`;
const DESCRIPTION = "drift-agent app Postgres on the zetaris network";
const AGENT = "zetaris-setup";
const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;
const PG_IDENT = /^[A-Za-z0-9_-]+$/;

/**
 * The USL's tables, column lines in DDL order. The first four are the collected estate; policy is
 * policy_rule; copy is vault_copy with its latest copy_validation; probe, disposition, action (reason and
 * record included) and ticket are their datasource tables; cause is finding_cause, class named cause_class;
 * lesson, rule and adoption are over the file tables; dns_live is the DNS API's records now against the last
 * complete DNS run: live_proxied and held_proxied are 1, 0, or -1 when the flag is absent, held_type '' when the
 * run lacks the record, so the rule compares NOT NULL columns. Then one table per catalogue table that none of the
 * fifteen is built from alone (READ_AS), each its table's columns, NOT NULL where sql/schema.sql says so.
 */
const USL_DDL = {
  collection: [
    "run_id varchar(128) NOT NULL PRIMARY KEY",
    "tenant_id varchar(64) NOT NULL",
    "surface varchar(64) NOT NULL",
    "host varchar(128)",
    "started_at varchar(40) NOT NULL",
    "finished_at varchar(40)",
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
    "value_redacted varchar(1048576)",
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
  // Before disposition, whose window_id references it: every foreign key in the DDL names a table above it.
  change_window: [
    "window_id varchar(128) NOT NULL PRIMARY KEY",
    "tenant_id varchar(64) NOT NULL",
    "surface varchar(64) NOT NULL",
    "host varchar(128)",
    "object_id varchar(512) NOT NULL",
    "setting_path varchar(512) NOT NULL",
    "opened_by varchar(255) NOT NULL",
    "opened_at varchar(40) NOT NULL",
    "until varchar(40) NOT NULL",
    "reason varchar(1024) NOT NULL",
    "closed_at varchar(40)",
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
    "window_id varchar(128) FOREIGN KEY REFERENCES change_window(window_id)",
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
  lesson: [
    "lesson_id varchar(64) NOT NULL PRIMARY KEY",
    "tenant_id varchar(64) NOT NULL",
    "kind varchar(16) NOT NULL",
    "finding_class varchar(64)",
    "scope_key varchar(255) NOT NULL",
    "reason varchar(2048) NOT NULL",
    "recorded_at varchar(40) NOT NULL",
    "expires_at varchar(40) NOT NULL",
    "provenance varchar(512) NOT NULL",
  ],
  rule: [
    "rule_id varchar(128) NOT NULL PRIMARY KEY",
    "tenant_id varchar(64) NOT NULL",
    "version int NOT NULL",
    "surface varchar(64) NOT NULL",
    "object_glob varchar(512) NOT NULL",
    "setting_glob varchar(512) NOT NULL",
    "criticality varchar(16) NOT NULL",
    "locked int NOT NULL",
    "on_drift varchar(16) NOT NULL",
    "on_no_copy varchar(32) NOT NULL",
    "hold_hours int NOT NULL",
    "alert varchar(16) NOT NULL",
    "psa_priority varchar(8) NOT NULL",
    "description varchar(1024)",
  ],
  adoption: [
    "disposition_id varchar(128) NOT NULL PRIMARY KEY",
    "tenant_id varchar(64) NOT NULL",
    "finding_id varchar(255) NOT NULL",
    "decided_at varchar(40) NOT NULL",
    "lesson_id varchar(64) FOREIGN KEY REFERENCES lesson(lesson_id)",
    "lesson_kind varchar(16)",
    "lesson_recorded_at varchar(40)",
    "lesson_expires_at varchar(40)",
  ],
  dns_live: [
    "record_id varchar(64) NOT NULL PRIMARY KEY",
    "tenant_id varchar(64) NOT NULL",
    "zone_id varchar(64) NOT NULL",
    "live_type varchar(16) NOT NULL",
    "live_proxied int NOT NULL",
    "run_id varchar(128) FOREIGN KEY REFERENCES collection(run_id)",
    "run_started_at varchar(40)",
    "held_type varchar(16) NOT NULL",
    "held_proxied int NOT NULL",
  ],
  dns_record: [
    "dns_record_id varchar(1024) NOT NULL PRIMARY KEY",
    "record_id varchar(64) NOT NULL",
    "run_id varchar(128) NOT NULL FOREIGN KEY REFERENCES collection(run_id)",
    "tenant_id varchar(64) NOT NULL",
    "zone varchar(255) NOT NULL",
    "name varchar(255) NOT NULL",
    "type varchar(16) NOT NULL",
    "content varchar(65535) NOT NULL",
    "ttl int",
    "proxied int",
    "observed_at varchar(40) NOT NULL",
  ],
  inventory_asset: [
    "asset_id varchar(128) NOT NULL PRIMARY KEY",
    "tenant_id varchar(64) NOT NULL",
    "host varchar(128)",
    "address varchar(255) NOT NULL",
    "kind varchar(32)",
    "source_kind varchar(255) NOT NULL",
    "observed_at varchar(40) NOT NULL",
  ],
  approved_setting: [
    "approval_id varchar(128) NOT NULL PRIMARY KEY",
    "tenant_id varchar(64) NOT NULL",
    "surface varchar(64) NOT NULL",
    "host varchar(128)",
    "object_id varchar(512) NOT NULL",
    "setting_path varchar(512) NOT NULL",
    "value_hash varchar(80) NOT NULL",
    "approved_at varchar(40) NOT NULL",
    "approved_by varchar(255)",
    "note varchar(2048)",
  ],
  backup_snapshot: [
    "snapshot_id varchar(128) NOT NULL PRIMARY KEY",
    "tenant_id varchar(64) NOT NULL",
    "host varchar(128) NOT NULL",
    "kind varchar(16) NOT NULL",
    "taken_at varchar(40) NOT NULL",
    "source_ref varchar(1024)",
  ],
  backup_item: [
    "item_id varchar(4096) NOT NULL PRIMARY KEY",
    "snapshot_id varchar(128) NOT NULL FOREIGN KEY REFERENCES backup_snapshot(snapshot_id)",
    "object_id varchar(512) NOT NULL",
    "setting_path varchar(512) NOT NULL",
    "value_hash varchar(80) NOT NULL",
  ],
  vault_copy: [
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
  ],
  copy_validation: [
    "validation_id varchar(255) NOT NULL PRIMARY KEY",
    "copy_id varchar(128) NOT NULL FOREIGN KEY REFERENCES vault_copy(copy_id)",
    "tenant_id varchar(64) NOT NULL",
    "validator varchar(16) NOT NULL",
    "result varchar(16) NOT NULL",
    "missing_dependencies varchar(8192) NOT NULL",
    "output_redacted varchar(8192) NOT NULL",
    "validated_at varchar(40) NOT NULL",
  ],
  referent_fingerprint: [
    "fingerprint_id varchar(1024) NOT NULL PRIMARY KEY",
    "obs_id varchar(128) NOT NULL FOREIGN KEY REFERENCES setting(setting_id)",
    "dns_run_id varchar(128) NOT NULL",
    "fingerprint varchar(8192) NOT NULL",
    "resolved_at varchar(40) NOT NULL",
  ],
  audit_event: [
    "event_id varchar(128) NOT NULL PRIMARY KEY",
    "tenant_id varchar(64) NOT NULL",
    "source_kind varchar(32) NOT NULL",
    "actor varchar(255)",
    "action varchar(64) NOT NULL",
    "resource_type varchar(64)",
    "resource_id varchar(255)",
    "old_value varchar(65535)",
    "new_value varchar(65535)",
    "occurred_at varchar(40) NOT NULL",
  ],
} as const;

export type UslTable = keyof typeof USL_DDL;
export const USL_TABLES = Object.keys(USL_DDL) as UslTable[];

/** Each USL table's column names in DDL order: what LOAD USL must report for the USL to be current. */
export const USL_COLUMNS: Readonly<Record<UslTable, readonly string[]>> = Object.fromEntries(
  USL_TABLES.map((t) => [t, USL_DDL[t].map((l) => l.split(" ")[0])]),
) as unknown as Record<UslTable, readonly string[]>;

/** The DDL blocks: each CREATE TABLE starts on its own line, separated by ';'. */
const USL_DDL_TEXT = USL_TABLES.map((t) => `CREATE TABLE ${t} (\n${USL_DDL[t].map((l) => `  ${l}`).join(",\n")}\n)`).join(";\n");

/** The whole block is one request. */
export const COMPILE_USL = `COMPILE USL IF NOT EXISTS ${USL_NAME} DEPLOY NAMESPACE ${NAMESPACE} DDL\n${USL_DDL_TEXT}`;

/**
 * The same DDL without DEPLOY: Zetaris compiles it, returns the model as JSON and stores nothing (SQL reference 13.1).
 * The setup sends it before REMOVE USL, so a DDL the validator refuses stops the run while the deployed USL still stands.
 */
export const CHECK_USL = `COMPILE USL ${USL_NAME} NAMESPACE ${NAMESPACE} DDL\n${USL_DDL_TEXT}`;

/**
 * How a catalogue table is read on Zetaris: through `entity`, the USL table built from it alone (READ_AS). `renames`
 * gives the entity's name for each column it names otherwise: the DDL validator refuses a column named source (and
 * class is renamed with it), and setting keeps the key name it had before the catalogue read it. `key` is the key the
 * entity adds to a table whose key is several columns: those columns joined by ':'.
 */
export interface ReadAs {
  entity: UslTable;
  renames?: Readonly<Record<string, string>>;
  key?: { column: string; of: readonly string[] };
}

/**
 * Every table the catalogue names as {{t:<table>}} (sql/schema.sql's eighteen and the file tables lesson and rule), and
 * the entity it is read through. Each entity here holds every column of its table, so any SQL in the portable subset
 * reads it as it reads the table: src/data/engines/zetaris.ts renders {{t:<table>}} as uslRelation(<table>).
 */
export const READ_AS: Readonly<Record<string, ReadAs>> = {
  collection_run: { entity: "collection" },
  observation: { entity: "setting", renames: { obs_id: "setting_id", source: "source_kind" } },
  approved_setting: { entity: "approved_setting" },
  backup_snapshot: { entity: "backup_snapshot" },
  backup_item: { entity: "backup_item", key: { column: "item_id", of: ["snapshot_id", "object_id", "setting_path"] } },
  dns_record: { entity: "dns_record", key: { column: "dns_record_id", of: ["run_id", "record_id"] } },
  audit_event: { entity: "audit_event", renames: { source: "source_kind" } },
  inventory_asset: { entity: "inventory_asset", renames: { source: "source_kind" } },
  policy_rule: { entity: "policy" },
  vault_copy: { entity: "vault_copy", renames: { source: "source_kind" } },
  copy_validation: { entity: "copy_validation" },
  probe: { entity: "probe" },
  disposition: { entity: "disposition" },
  action: { entity: "action" },
  ticket: { entity: "ticket" },
  referent_fingerprint: { entity: "referent_fingerprint", key: { column: "fingerprint_id", of: ["obs_id", "dns_run_id"] } },
  finding_cause: { entity: "cause", renames: { class: "cause_class" } },
  change_window: { entity: "change_window" },
  lesson: { entity: "lesson" },
  rule: { entity: "rule" },
};

/** A catalogue table's columns in DDL order: sql/schema.sql's, or the file table's (src/data/files.ts). */
const tableColumns = (table: string): readonly string[] | undefined => (tableDef(table) ?? fileTableDef(table))?.columns;

/** The table each entity of READ_AS is built from, by entity. */
const BUILT_FROM: ReadonlyMap<string, string> = new Map(Object.entries(READ_AS).map(([table, r]) => [r.entity, table]));

/** The catalogue tables read through an entity, in READ_AS order: one, or none for an entity built from several (referent, copy, ...). */
export function readsOf(entity: UslTable): string[] {
  return Object.entries(READ_AS).filter(([, r]) => r.entity === entity).map(([table]) => table);
}

/**
 * The invariant mirror() rests on, across USL_DDL, READ_AS and sql/schema.sql: for each entity built from one DRIFT table,
 * its columns are the table's columns (renamed as READ_AS says) and the key it adds, the added key is NOT NULL PRIMARY KEY,
 * and every other column is NOT NULL in the DDL exactly when sql/schema.sql declares it NOT NULL or a key. One line per
 * breach; empty when the files agree. `ddl` and `tables`: USL_DDL and sql/schema.sql's tables, or others in a test.
 */
export function mirrorMismatches(ddl: Readonly<Record<string, readonly string[]>> = USL_DDL, tables: readonly TableDef[] = SCHEMA_TABLES): string[] {
  const out: string[] = [];
  for (const [table, r] of Object.entries(READ_AS)) {
    const def = tables.find((t) => t.name === table);
    if (!def) continue;
    const declared = new Map((ddl[r.entity] ?? []).map((l) => [l.split(" ")[0], l]));
    const named = def.columns.map((c) => r.renames?.[c] ?? c);
    const want = [...named, ...(r.key ? [r.key.column] : [])];
    for (const c of want.filter((x) => !declared.has(x))) out.push(`${r.entity} lacks ${c} of ${table}`);
    for (const c of [...declared.keys()].filter((x) => !want.includes(x))) out.push(`${r.entity}.${c} is no column of ${table}`);
    if (r.key && !/ NOT NULL PRIMARY KEY\b/.test(declared.get(r.key.column) ?? "")) out.push(`${r.entity}.${r.key.column} is not NOT NULL PRIMARY KEY`);
    for (const [i, c] of def.columns.entries()) {
      const line = declared.get(named[i]);
      if (line === undefined) continue;
      const [inDdl, inSchema] = [line.includes(" NOT NULL"), (def.notNull ?? []).includes(c)];
      if (inDdl !== inSchema) out.push(`${r.entity}.${named[i]} is ${inDdl ? "NOT NULL" : "nullable"} in USL_DDL, ${inSchema ? "NOT NULL" : "nullable"} in sql/schema.sql`);
    }
  }
  return out;
}

/**
 * The LIMIT of a fenced read (src/data/engines/zetaris.ts fencedOr). Spark's optimizer pushes no Filter below a Limit, since
 * that would change which rows the limit keeps, so a predicate over `(SELECT ... FROM <entity> LIMIT n) t` stays above
 * the scan and USLTableScan never compiles it. n is the largest INT (Spark's LIMIT takes an INT expression), so it bounds
 * no table; a Limit with no row count known below it is not removed. Measured live 26 Oct 2026 on 2.4.3.1 by EXPLAIN QUERY
 * AS: the optimized plan keeps the Filter above GlobalLimit and LocalLimit, and the scan reads the pruned columns with no
 * pushed filter; the OR shapes that came back wrong pushed return what DRIFT returns fenced. Rests on optimizer behaviour,
 * so the live parity cases that hold an OR over one table (approved_missing over host '', other_settings_reference) are
 * its regression check on an upgrade.
 */
export const FENCE_LIMIT = 2_147_483_647;

/**
 * A key of several columns as one text: each column with % written %25 and : written %3A, then joined by ':'. No column
 * value holds a ':' once escaped, so two different rows never share a key (a setting_path such as server[a:443] would).
 */
export function joinedKey(columns: readonly string[]): string {
  return `CONCAT(${columns.map((c) => `REPLACE(REPLACE(${c}, '%', '%25'), ':', '%3A')`).join(", ':', ")})`;
}

/** Why READ_AS entry `r` cannot read `table` as `columns`, or null: a rename of a column the table lacks, or a column the entity lacks. */
function misread(table: string, r: ReadAs, columns: readonly string[]): string | null {
  const entity = (USL_COLUMNS as Readonly<Record<string, readonly string[] | undefined>>)[r.entity];
  if (!entity) return `READ_AS reads ${table} through ${r.entity}, which USL_DDL lacks`;
  const stray = Object.keys(r.renames ?? {}).filter((c) => !columns.includes(c));
  if (stray.length) return `READ_AS renames ${stray.join(", ")} of ${table}, which ${table} lacks`;
  const lacking = columns.map((c) => r.renames?.[c] ?? c).filter((c) => !entity.includes(c));
  return lacking.length ? `${r.entity} lacks ${lacking.join(", ")}, which reading ${table} needs` : null;
}

/**
 * The relation {{t:<table>}} names on Zetaris: the entity's qualified name when it holds the table's columns under
 * their own names in their order; otherwise a SELECT of the table's columns from the entity, each renamed one AS its
 * table name, so the catalogue's one SQL text reads either engine (DataLayer.render gives it the query's alias, as it
 * does an overlay). `fence`: always that SELECT, with LIMIT FENCE_LIMIT, so Spark evaluates every filter above the
 * scan and pushes none into it (src/data/engines/zetaris.ts says when). undefined for a table READ_AS lacks. Throws
 * SetupError when the entry and the DDL disagree: a renamed column the table lacks, or a column the entity lacks.
 * `read`: READ_AS, or another mapping in a test.
 */
export function uslRelation(table: string, opts: { fence?: boolean } = {}, read: Readonly<Record<string, ReadAs>> = READ_AS): string | undefined {
  const r = Object.hasOwn(read, table) ? read[table] : undefined;
  const columns = tableColumns(table);
  if (!r || !columns) return undefined;
  const why = misread(table, r, columns);
  if (why) throw new SetupError(why);
  const entity = `${USL}.${r.entity}`;
  if (!opts.fence && columns.join(",") === USL_COLUMNS[r.entity].join(",")) return entity;
  const named = columns.map((c) => r.renames?.[c] ?? c);
  return `(SELECT ${columns.map((c, i) => (named[i] === c ? c : `${named[i]} AS ${c}`)).join(", ")} FROM ${entity}${opts.fence ? ` LIMIT ${FENCE_LIMIT}` : ""})`;
}

/**
 * The activation of an entity READ_AS builds from one DRIFT table: each declared column from the table's column of
 * that name (or the one it renames), bare, so a predicate on it reaches the datasource as it is written; an int CAST to
 * INT; the added key joinedKey() of its columns. A column the DDL declares NOT NULL is NOT NULL in sql/schema.sql, so
 * no COALESCE is needed to meet the declaration: mirrorMismatches() holds the two files to that, and the tests to it.
 */
function mirror(entity: UslTable, ds: string): string {
  const table = BUILT_FROM.get(entity);
  if (!table) throw new SetupError(`no activation for ${entity}: READ_AS builds no entity of that name`);
  const r = READ_AS[table];
  const back = new Map(Object.entries(r.renames ?? {}).map(([c, e]) => [e, c]));
  const cols = (USL_DDL[entity] as readonly string[]).map((line) => {
    const [name, type] = line.split(" ");
    if (r.key?.column === name) return `${joinedKey(r.key.of)} AS ${name}`;
    const expr = type === "int" ? `CAST(${back.get(name) ?? name} AS INT)` : (back.get(name) ?? name);
    return expr === name ? name : `${expr} AS ${name}`;
  });
  return `SELECT ${cols.join(", ")} FROM ${ds}.${table}`;
}

export interface DqRule { name: string; table: UslTable; expression: string }

/**
 * dns_inventory_current over plain columns: the last complete DNS run holds the record (held_type is '' when it does
 * not), with the type and the proxied flag the DNS API returns now. The pass reads the same text (src/loop/pass.ts).
 */
export const DNS_INVENTORY_CURRENT = "held_type <> '' AND held_type = live_type AND held_proxied = live_proxied";

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
 * compares plain columns. exception_in_force (src/data/files.ts EXCEPTION_IN_FORCE): every ADOPT decided under an
 * accepted exception joins, across DRIFT and LESSONS, to a lesson that was in force at the decision instant.
 * dns_inventory_current (DNS_INVENTORY_CURRENT): every record the DNS API returns now, joined across CLOUDFLARE and
 * DRIFT on Cloudflare's record id, is a record of the last complete DNS run with the same type and proxied flag.
 */
export const DQ_RULES: readonly DqRule[] = [
  { name: "run_complete", table: "collection", expression: "observed_count IS NOT NULL AND expected_count IS NOT NULL AND observed_count >= expected_count AND status = 'complete'" },
  { name: "copy_validated", table: "copy", expression: "validated = 1" },
  { name: "action_verified", table: "action", expression: "kind NOT IN ('rollback_file','revert_record') OR status IN ('failed','refused','not_judged') OR verification <> ''" },
  { name: "cause_evidenced", table: "cause", expression: "cause_class = 'unknown' OR evidence_ids <> '[]'" },
  { name: "exception_in_force", table: "adoption", expression: EXCEPTION_IN_FORCE },
  { name: "dns_inventory_current", table: "dns_live", expression: DNS_INVENTORY_CURRENT },
];
/** The tables RUN DQ runs on, one statement each. */
export const DQ_TABLES: readonly UslTable[] = ["collection", "copy", "action", "cause", "adoption", "dns_live"];
export const DQ_RULE = "run_complete";

/** How an entity's rows are formed from its tables, for each entity whose rows are other than one table's rows under its own column names. */
const USL_FORMED: Partial<Record<UslTable, string>> = {
  setting: "`obs_id` as `setting_id`, `source` as `source_kind`",
  referent: "each `observation` whose `refers_to_type` is `dns_name`, joined to the `dns_record` rows of its tenant whose `name` is its `refers_to_id`, the join the hero query makes for FOUND-BUT-DIFFERENT",
  backup_copy: "each `backup_item` joined to its `backup_snapshot`",
  copy: "each `vault_copy` with its latest `copy_validation` (by `validated_at`, then `validation_id`); `validated` is 1 when that result is ok or ok_with_gaps",
  cause: "`class` as `cause_class`",
  lesson: "one row per lesson of the technician's memory store, the Meterless H-MEM store the Decider recalls from, as `lessons.json` in the Zetaris filestore",
  rule: "one row per rule of the policy file, as `rules.json` in the Zetaris filestore; `lock` as `locked`, `hold_max_hours` as `hold_hours`, `note` as `description`",
  adoption: "each `disposition` decided ADOPT by the operator, under an accepted exception, LEFT JOINed across the two datasources to the `LESSONS.lesson` row its reason names, on the tenant and the lesson id",
  dns_live: "each record the DNS API returns at the query, the `result` array of every `CLOUDFLARE.zone_<zone id>` REST table exploded (one table per zone and page), LEFT JOINed across the datasources to the last complete `cloudflare.dns` run of `collection_run` and to that run's `dns_record` row of the same Cloudflare record id; ids are joined on, never a name or a content",
  dns_record: "`dns_record_id` is `run_id` and `record_id` joined by `:` (a `:` in a value escaped), a Cloudflare record id being unique within one DNS run only",
  inventory_asset: "`source` as `source_kind`",
  backup_item: "`item_id` is `snapshot_id`, `object_id` and `setting_path` joined by `:` (a `:` in a value escaped)",
  vault_copy: "`source` as `source_kind`",
  referent_fingerprint: "`fingerprint_id` is `obs_id` and `dns_run_id` joined by `:` (a `:` in a value escaped)",
  audit_event: "`source` as `source_kind`",
};

// ---- the REST source: the Cloudflare DNS API as the CLOUDFLARE Lightning database ---------------------------------

/** The Lightning database the DNS API is registered as, and its description (DESCRIBE BY takes letters, digits, spaces and _ . - , only). */
export const REST_DB = "CLOUDFLARE";
export const REST_DB_DESCRIBE = "Cloudflare DNS API, the records of each zone live at the provider";
const ZONE_ID = /^[0-9a-f]{32}$/;

/** A zone the read token sees, by Cloudflare's zone id, and the records the API reports for it. */
export interface LiveZone { id: string; records: number }

/** One REST table: a page of one zone's records. */
export interface RestTable { table: string; zoneId: string; page: number; endpoint: string }

/** One table per zone and page of RECORDS_PER_PAGE records, in zone order; none for a zone with no record. Throws on a zone id that is not 32 hex digits. */
export function restTables(zones: readonly LiveZone[]): RestTable[] {
  return zones.flatMap((z) => {
    if (!ZONE_ID.test(z.id)) throw new SetupError(`a Cloudflare zone id is 32 hex digits, got ${JSON.stringify(z.id)}`);
    if (!Number.isInteger(z.records) || z.records < 0) throw new SetupError(`zone ${z.id}: the record count must be a whole number, got ${z.records}`);
    const pages = Math.ceil(z.records / RECORDS_PER_PAGE);
    return Array.from({ length: pages }, (_, i) => ({
      table: i === 0 ? `zone_${z.id}` : `zone_${z.id}_p${i + 1}`, zoneId: z.id, page: i + 1,
      endpoint: `${API}/zones/${z.id}/dns_records?per_page=${RECORDS_PER_PAGE}&page=${i + 1}`,
    }));
  });
}

/** The zones the token sees and their record counts, read from the DNS API (GET /zones, then per_page=1 per zone, as the collector asserts its population). */
export async function liveZones(token: string = config.cloudflare.token): Promise<LiveZone[]> {
  const cf = new Cloudflare({ token });
  const out: LiveZone[] = [];
  for (const z of await cf.listZones()) out.push({ id: z.id, records: await cf.countRecords(z.id) });
  return out;
}

/** The REST table the docs name for every zone: uslRows() reads dns_live's activation over it. */
const DOC_REST: readonly RestTable[] = [{ table: "zone_<zone id>", zoneId: "<zone id>", page: 1, endpoint: "" }];

function createRestTable(t: RestTable, token: string): string {
  return `CREATE LIGHTNING REST TABLE ${t.table} FROM ${REST_DB} REQUEST (endpoint "${t.endpoint}", method "GET", http_encoding "URLENCODED", response_type "JSON", insecure_ssl "false") HEADER (Authorization "Bearer ${token}") BODY ()`;
}

/** A file table of the setup: its Lightning database, its name there, the file in FILESTORE_DIR it reads and, when the setup holds it to them, its columns. */
export interface FileSource { db: string; table: string; file: string; columns?: readonly string[] }

/**
 * The Lightning databases (Zetaris's file sources) and their tables. LESSONS: the technician's memory store, its
 * lessons (the `lesson` entity) and its H-MEM ledger as the store wrote it; RULES: the policy file.
 */
export const LIGHTNING_DBS: readonly { name: string; describe: string }[] = [
  { name: FILE_DATASOURCES.lesson, describe: "drift-agent technician memory store, the Meterless H-MEM lessons and ledger" },
  { name: FILE_DATASOURCES.rule, describe: "drift-agent policy file, one row per rule" },
];
export const FILE_SOURCES: readonly FileSource[] = [
  { db: FILE_DATASOURCES.lesson, table: "ledger", file: "ledger.json" },
  { db: FILE_DATASOURCES.lesson, table: "lesson", file: "lessons.json", columns: fileTableDef("lesson")!.columns },
  { db: FILE_DATASOURCES.rule, table: "rule", file: "rules.json", columns: fileTableDef("rule")!.columns },
];
const pathOf = (f: FileSource): string => `${FILESTORE_DIR}/${f.file}`;
const keyOf = (f: FileSource): string => `${f.db}.${f.table}`;

export interface UslRow {
  entity: UslTable;
  /** The tables its activation SELECT reads, each once, in first-appearance order: a DRIFT table by its name, a file table as <database>.<table>. */
  builtFrom: string[];
  /** How its rows are formed from those tables; empty when each row is one row of its one table. */
  formed: string;
  /** The catalogue tables read through it on Zetaris (READ_AS): {{t:<table>}} names it. Empty for an entity the catalogue does not read. */
  reads: string[];
  /** The PRIMARY KEY column of USL_DDL. */
  primaryKey: string;
  /** Each FOREIGN KEY of USL_DDL: the column and the entity(column) it references. */
  foreignKeys: { column: string; references: string }[];
  /** The DQ rule registered on the entity, when one is. */
  rule?: DqRule;
}

/** A table an activation names: DRIFT.<table>, LESSONS.<table>, RULES.<table> or CLOUDFLARE.<table> (zone_<zone id> in the docs). */
const SOURCE_TABLE = new RegExp(`\\b(DRIFT|${[...LIGHTNING_DBS.map((d) => d.name), REST_DB].join("|")})\\.(\\w+(?:<[^>]*>)?)`, "g");

/** One row per USL entity, in DDL order, read off USL_DDL, activation() over the DRIFT datasource (and DOC_REST) and DQ_RULES. */
export function uslRows(): UslRow[] {
  return USL_TABLES.map((entity) => {
    const lines = USL_DDL[entity] as readonly string[];
    const name = (l: string): string => l.split(" ")[0];
    return {
      entity,
      builtFrom: [...new Set([...activation(entity, "DRIFT", DOC_REST).matchAll(SOURCE_TABLE)].map((m) => (m[1] === "DRIFT" ? m[2] : `${m[1]}.${m[2]}`)))],
      formed: USL_FORMED[entity] ?? "",
      reads: readsOf(entity),
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
    r.reads.map(code).join(", "),
    [code(r.primaryKey), ...r.foreignKeys.map((f) => `${code(f.column)} references ${code(f.references)}`)].join("; "),
    r.rule ? code(r.rule.name) : "",
    r.rule ? code(r.rule.expression) : "",
  ];
  const read = Object.keys(READ_AS).length;
  return [
    `${code(USL_NAME)} in ${code(NAMESPACE)} is the semantic layer over four datasources: ${code("DRIFT")}, the app Postgres; ${code(FILE_DATASOURCES.lesson)}, the technician's memory store; ${code(FILE_DATASOURCES.rule)}, the policy file; ${code(REST_DB)}, the Cloudflare DNS API, which Zetaris reads itself at each query. It holds ${rows.length} entities, each activated as one SELECT over the tables it is built from (${code("activation()")} in ${code("src/zetaris/setup.ts")}), a table of ${code("DRIFT")} by its name and a file or REST table as ${code("<datasource>.<table>")}, and ${DQ_RULES.length} DQ rules, each an expression RUN DQ tests on every row of its entity. Every catalogue query reads through it: on Zetaris each of the ${read} tables the SQL names is read as the entity whose row lists it under "catalogue table", with each of the table's columns under the table's own name (${code("READ_AS")} and ${code("uslRelation()")} in ${code("src/zetaris/setup.ts")}), so the detectors, the hero query and the Decider's reads run over this one model and join through its keys.`,
    "",
    "| entity | built from | catalogue table | key | DQ rule | expression |",
    "|---|---|---|---|---|---|",
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
  /** CLOUDFLARE_API_TOKEN, the read token the REST tables send in their Authorization header. */
  cloudflareToken: string;
  /** The zones the token sees (liveZones()); plan() needs them, apply() reads them when absent. */
  zones?: readonly LiveZone[];
}

export function envFromProcess(): SetupEnv {
  return { databaseUrl: process.env.DATABASE_URL ?? "", pgHost: config.zetaris.pgHost, datasource: config.zetaris.datasource, cloudflareToken: config.cloudflare.token };
}

/** The token, checked: set, and with no quote, backslash or whitespace (it goes into a double-quoted option value). Messages never carry it. */
function restToken(env: SetupEnv): string {
  const t = env.cloudflareToken ?? "";
  if (!t) throw new SetupError("CLOUDFLARE_API_TOKEN is not set: the CLOUDFLARE REST tables send it to the DNS API");
  if (/["\\\s]/.test(t)) throw new SetupError("CLOUDFLARE_API_TOKEN holds a double quote, backslash or whitespace; it goes into a double-quoted Zetaris option value");
  return t;
}

/**
 * Run a step only in this state. datasource_absent / datasource_present: SHOW DATASOURCES listed the
 * source or not. tables_missing: the source was created this run, or SHOW DATASOURCE TABLES lacks a table
 * of sql/schema.sql. tables_registered: the source existed and lists every one. usl_present: the namespace
 * lists drift_usl. usl_stale: LOAD USL reports other tables or columns than COMPILE_USL. usl_absent: no
 * drift_usl at the start, or removed this run. dq_rule_absent / dq_rule_differs: LIST DQ USL does not list
 * step.rule, or lists it with another expression. rest_table_stale / rest_table_absent: SHOW LIGHTNING TABLES
 * CLOUDFLARE lists step.rest over another endpoint, or does not list it (or it was dropped this run).
 */
export type When =
  | "datasource_absent" | "datasource_present" | "tables_missing" | "tables_registered"
  | "lightning_db_absent" | "file_table_listed" | "file_table_stale" | "file_table_absent"
  | "rest_table_stale" | "rest_table_absent"
  | "usl_present" | "usl_stale" | "usl_absent" | "dq_rule_absent" | "dq_rule_differs";

export interface Step {
  name: string;
  /** The statement as printed. For CREATE DATASOURCE the password is "<redacted>", for CREATE LIGHTNING REST TABLE the token. */
  sql: string;
  /** The statement as sent, built in memory when it runs: CREATE DATASOURCE and each CREATE LIGHTNING REST TABLE. */
  secret?: () => string;
  /** The trace line's input_summary instead of sql, for a statement that carries credentials. */
  traceAs?: string;
  when?: When;
  /** The DQ rule a dq_rule_* condition is about. */
  rule?: DqRule;
  /** The Lightning database a lightning_db_absent condition or a file_tables probe is about. */
  db?: string;
  /** The file table a file_table_* condition or a file_columns probe is about. */
  file?: FileSource;
  /** The REST table a rest_table_* condition is about. */
  rest?: RestTable;
  /** Not a statement: put the files into the filestore (ApplyDeps.put), then go on. */
  copy?: true;
  /** What the result tells the steps after it. */
  probe?: "datasources" | "datasource_tables" | "lightning_dbs" | "file_tables" | "file_columns" | "rest_tables" | "usl" | "usl_model" | "dq_rules";
  /** A count step's expected rows: what the zones reported, printed beside the count. */
  expect?: number;
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

/**
 * The last complete DNS run: the cloudflare.dns run run_complete passes with the greatest started_at, then the greater
 * run_id. run_complete's own expression over the run and over each later candidate, so "complete" is the rule's.
 */
function lastCompleteDnsRun(ds: string): string {
  const complete = (a: string): string => DQ_RULES.find((r) => r.name === "run_complete")!.expression.replace(/\b(observed_count|expected_count|status)\b/g, `${a}.$1`);
  return `SELECT c.run_id, c.tenant_id, c.started_at FROM ${ds}.collection_run c WHERE c.surface = 'cloudflare.dns' AND ${complete("c")} AND NOT EXISTS (SELECT 1 FROM ${ds}.collection_run w WHERE w.surface = 'cloudflare.dns' AND ${complete("w")} AND (w.started_at > c.started_at OR (w.started_at = c.started_at AND w.run_id > c.run_id)))`;
}

/**
 * The activation query per USL table: exactly the declared columns, ints CAST. An entity READ_AS builds from one DRIFT
 * table is that table's columns, bare (mirror()); the file tables' entities and the entities built from several tables
 * wrap each NOT NULL varchar in COALESCE. dns_live reads the REST tables given.
 */
export function activation(table: UslTable, ds: string, rest: readonly RestTable[] = []): string {
  switch (table) {
    case "referent":
      return `SELECT ${joinedKey(["o.obs_id", "d.record_id", "d.run_id"])} AS ref_id, COALESCE(o.obs_id, '') AS setting_id, COALESCE(o.tenant_id, '') AS tenant_id, COALESCE(o.refers_to_type, '') AS target_type, COALESCE(o.refers_to_id, '') AS target_name, COALESCE(d.content, '') AS resolves_to, CAST(d.proxied AS INT) AS proxied, COALESCE(d.observed_at, '') AS resolved_at, COALESCE(d.run_id, '') AS dns_run_id FROM ${ds}.observation o JOIN ${ds}.dns_record d ON d.tenant_id = o.tenant_id AND d.name = o.refers_to_id WHERE o.refers_to_type = 'dns_name'`;
    case "backup_copy":
      return `SELECT ${joinedKey(["b.snapshot_id", "b.object_id", "b.setting_path"])} AS copy_id, COALESCE(s.tenant_id, '') AS tenant_id, COALESCE(s.host, '') AS host, COALESCE(s.kind, '') AS kind, COALESCE(b.object_id, '') AS object_id, COALESCE(b.setting_path, '') AS setting_path, COALESCE(b.value_hash, '') AS value_hash, COALESCE(s.taken_at, '') AS taken_at FROM ${ds}.backup_item b JOIN ${ds}.backup_snapshot s ON s.snapshot_id = b.snapshot_id`;
    case "copy":
      // The latest validation per copy (latest validated_at, then validation_id): the correlation sits in the subquery's WHERE.
      return `SELECT COALESCE(c.copy_id, '') AS copy_id, COALESCE(c.tenant_id, '') AS tenant_id, COALESCE(c.surface, '') AS surface, c.host, COALESCE(c.object_id, '') AS object_id, COALESCE(c.run_id, '') AS run_id, COALESCE(c.git_commit, '') AS git_commit, COALESCE(c.blob_sha256, '') AS blob_sha256, COALESCE(c.taken_at, '') AS taken_at, COALESCE(c.source, '') AS source_kind, l.validator, l.result, l.validated_at, CAST(CASE WHEN l.result IN ('ok', 'ok_with_gaps') THEN 1 ELSE 0 END AS INT) AS validated FROM ${ds}.vault_copy c LEFT JOIN (SELECT v.copy_id, v.validator, v.result, v.validated_at FROM ${ds}.copy_validation v WHERE NOT EXISTS (SELECT 1 FROM ${ds}.copy_validation w WHERE w.copy_id = v.copy_id AND (w.validated_at > v.validated_at OR (w.validated_at = v.validated_at AND w.validation_id > v.validation_id)))) l ON l.copy_id = c.copy_id`;
    case "lesson":
      return `SELECT ${keep("lesson_id tenant_id kind ?finding_class scope_key reason recorded_at expires_at provenance")} FROM ${FILE_DATASOURCES.lesson}.lesson`;
    case "rule":
      return `SELECT ${keep("rule_id tenant_id")}, CAST(COALESCE(version, 0) AS INT) AS version, ${keep("surface object_glob setting_glob criticality")}, CAST(COALESCE(locked, 0) AS INT) AS locked, ${keep("on_drift on_no_copy")}, CAST(COALESCE(hold_hours, 0) AS INT) AS hold_hours, ${keep("alert psa_priority ?description")} FROM ${FILE_DATASOURCES.rule}.rule`;
    case "adoption":
      // The catalogue's own SQL (src/data/files.ts), one line, its tables named as Zetaris names them: the cross-source join.
      return squash(ADOPTION_SQL.replace("{{t:disposition}}", `${ds}.disposition`).replace("{{t:lesson}}", `${FILE_DATASOURCES.lesson}.lesson`));
    case "dns_live": {
      // Each REST table's result array, one row per record; the zone id is a literal (32 hex digits, or the docs' placeholder).
      if (!rest.length) throw new SetupError("dns_live reads at least one CLOUDFLARE REST table: the token sees no zone with a record");
      const live = rest.map((t) => `SELECT r.id AS record_id, '${t.zoneId}' AS zone_id, r.type AS type, r.proxied AS proxied FROM ${REST_DB}.${t.table} LATERAL VIEW explode(result) AS r`).join(" UNION ALL ");
      return `SELECT COALESCE(l.record_id, '') AS record_id, COALESCE(k.tenant_id, '') AS tenant_id, COALESCE(l.zone_id, '') AS zone_id, COALESCE(l.type, '') AS live_type, CAST(CASE WHEN l.proxied THEN 1 WHEN NOT l.proxied THEN 0 ELSE -1 END AS INT) AS live_proxied, k.run_id AS run_id, k.started_at AS run_started_at, COALESCE(d.type, '') AS held_type, CAST(COALESCE(d.proxied, -1) AS INT) AS held_proxied FROM (${live}) l LEFT JOIN (${lastCompleteDnsRun(ds)}) k ON 1 = 1 LEFT JOIN ${ds}.dns_record d ON d.run_id = k.run_id AND d.record_id = l.record_id`;
    }
    default:
      return mirror(table, ds);
  }
}

/**
 * The ordered statements. Throws SetupError when DATABASE_URL or ZETARIS_PG_HOST cannot build the datasource, when
 * CLOUDFLARE_API_TOKEN is blank or unquotable, or when env.zones is absent (liveZones() reads it) or holds no record.
 */
export function plan(env: SetupEnv = envFromProcess()): Step[] {
  const ds = env.datasource;
  if (!IDENT.test(ds)) throw new SetupError("ZETARIS_DATASOURCE must be an unquoted identifier");
  const t = pgTarget(env);
  const token = restToken(env);
  if (!env.zones) throw new SetupError("the Cloudflare zones are not read: liveZones() reads them before the plan is built");
  const rest = restTables(env.zones);
  const records = env.zones.reduce((n, z) => n + z.records, 0);
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
    {
      name: "copy files to the filestore", copy: true,
      sql: `docker exec -i <driver container> sh -c 'cat > ${FILESTORE_DIR}/<file>' for ${FILE_SOURCES.map((f) => f.file).join(", ")} (written from DRIFT_MEMORY_DIR and DRIFT_POLICY_FILE)`,
    },
    { name: "show lightning databases", sql: "SHOW LIGHTNING DATABASES", probe: "lightning_dbs" },
    ...LIGHTNING_DBS.map((d): Step => ({ name: `create lightning database ${d.name}`, sql: `CREATE LIGHTNING DATABASE ${d.name} DESCRIBE BY "${d.describe}"`, when: "lightning_db_absent", db: d.name })),
    ...LIGHTNING_DBS.map((d): Step => ({ name: `list ${d.name} tables`, sql: `SHOW LIGHTNING TABLES ${d.name}`, probe: "file_tables", db: d.name })),
    ...FILE_SOURCES.flatMap((f): Step[] => [
      ...(f.columns ? [{ name: `describe ${keyOf(f)}`, sql: `DESCRIBE DATASOURCE TABLE ${keyOf(f)}`, when: "file_table_listed", probe: "file_columns", file: f } satisfies Step] : []),
      { name: `drop ${keyOf(f)}`, sql: `DROP LIGHTNING DATABASE TABLE ${keyOf(f)}`, when: "file_table_stale", file: f },
      { name: `create ${keyOf(f)}`, sql: `CREATE LIGHTNING FILESTORE TABLE ${f.table} FROM ${f.db} FORMAT JSON OPTIONS (path "${pathOf(f)}")`, when: "file_table_absent", file: f },
    ]),
    { name: `create lightning database ${REST_DB}`, sql: `CREATE LIGHTNING DATABASE ${REST_DB} DESCRIBE BY "${REST_DB_DESCRIBE}"`, when: "lightning_db_absent", db: REST_DB },
    { name: `list ${REST_DB} tables`, sql: `SHOW LIGHTNING TABLES ${REST_DB}`, probe: "rest_tables", db: REST_DB },
    ...rest.flatMap((r): Step[] => [
      { name: `drop ${REST_DB}.${r.table}`, sql: `DROP LIGHTNING DATABASE TABLE ${REST_DB}.${r.table}`, when: "rest_table_stale", rest: r },
      {
        name: `create ${REST_DB}.${r.table}`, sql: createRestTable(r, "<redacted>"), secret: () => createRestTable(r, token),
        traceAs: `CREATE LIGHTNING REST TABLE ${r.table} FROM ${REST_DB} (token redacted)`, when: "rest_table_absent", rest: r,
      },
    ]),
    { name: "namespace lightning.metastore", sql: "CREATE NAMESPACE IF NOT EXISTS lightning.metastore" },
    { name: `namespace ${NAMESPACE}`, sql: `CREATE NAMESPACE IF NOT EXISTS ${NAMESPACE}` },
    { name: `list ${NAMESPACE}`, sql: `SHOW NAMESPACES OR TABLES IN ${NAMESPACE}`, probe: "usl" },
    { name: `load usl ${USL_NAME}`, sql: `LOAD USL ${USL_NAME} NAMESPACE ${NAMESPACE}`, when: "usl_present", probe: "usl_model" },
    { name: `check usl ${USL_NAME}`, sql: CHECK_USL, when: "usl_stale", multi: true, timeoutMs: 120_000 },
    { name: `remove usl ${USL_NAME}`, sql: `REMOVE USL ${USL_NAME} NAMESPACE ${NAMESPACE}`, when: "usl_stale", removesUsl: true },
    { name: `compile usl ${USL_NAME}`, sql: COMPILE_USL, when: "usl_absent", multi: true, timeoutMs: 120_000 },
    ...USL_TABLES.map((tb): Step => ({ name: `activate ${tb}`, sql: `ACTIVATE USL TABLE ${USL}.${tb} AS ${activation(tb, ds, rest)}`, timeoutMs: 120_000 })),
    { name: "list dq rules", sql: `LIST DQ USL ${USL}`, probe: "dq_rules" },
    ...DQ_RULES.flatMap((r): Step[] => [
      { name: `register dq ${r.name}`, sql: `REGISTER DQ ${r.name} TABLE ${dqTable(r)} AS ${r.expression}`, when: "dq_rule_absent", rule: r },
      { name: `update dq ${r.name}`, sql: `UPDATE DQ ${r.name} TABLE ${dqTable(r)} SET NAME = ${r.name}, EXPRESSION = ${r.expression}`, when: "dq_rule_differs", rule: r },
    ]),
    ...DQ_TABLES.map((tb): Step => ({ name: `run dq ${tb}`, sql: `RUN DQ TABLE ${USL}.${tb}`, show: true, dqTable: tb, timeoutMs: 150_000 })),
    { name: `show ${USL}`, sql: `SHOW NAMESPACES OR TABLES IN ${USL}`, show: true },
    ...USL_TABLES.map((tb): Step => ({ name: `count ${tb}`, sql: `SELECT COUNT(*) AS n FROM ${USL}.${tb}`, ...(tb === "dns_live" ? { expect: records } : {}) })),
    ...FILE_SOURCES.filter((f) => !f.columns).map((f): Step => ({ name: `count ${keyOf(f)}`, sql: `SELECT COUNT(*) AS n FROM ${keyOf(f)}` })),
  ];
}

const WHEN_TEXT: Record<When, (ds: string, s: Step) => string> = {
  datasource_absent: (ds) => `only when ${ds} is absent`,
  datasource_present: (ds) => `only when ${ds} already existed`,
  tables_missing: (ds) => `only when ${ds} was created this run or lacks a table of sql/schema.sql`,
  tables_registered: (ds) => `only when ${ds} already existed and lists every table of sql/schema.sql`,
  lightning_db_absent: (_ds, s) => `only when SHOW LIGHTNING DATABASES lacks ${s.db}`,
  file_table_listed: (_ds, s) => `only when ${s.file?.db} lists ${s.file?.table}`,
  file_table_stale: (_ds, s) => `only when ${s.file?.db} lists ${s.file?.table} over another path or format${s.file?.columns ? ", or with other columns" : ""}`,
  file_table_absent: (_ds, s) => `only when ${s.file?.db} lacks ${s.file?.table} or it was dropped this run`,
  rest_table_stale: (_ds, s) => `only when ${REST_DB} lists ${s.rest?.table} over another endpoint`,
  rest_table_absent: (_ds, s) => `only when ${REST_DB} lacks ${s.rest?.table} or it was dropped this run`,
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
  /** The files of FILE_SOURCES, by file name, as JSON text (default: filestoreFiles() over DRIFT_MEMORY_DIR and DRIFT_POLICY_FILE). */
  files?: () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  /** Puts the files into FILESTORE_DIR (default: src/zetaris/filestore.ts putFiles, docker through wsl.exe on Windows). */
  put?: (files: Readonly<Record<string, string>>) => PutResult[];
  /** Where the copy's hash is recorded for the live pass's freshness check: COPY_STATE_FILE with the real put; with `put` given, nowhere unless named. */
  copyState?: string | null;
  /** The zones the token sees, when env carries none (default: liveZones(), the DNS API's GETs). */
  zones?: (token: string) => Promise<readonly LiveZone[]>;
}

/**
 * The files the file tables read, each one JSON array (FORMAT JSON reads a file as one document): lessons.json and
 * rules.json from src/data/file-rows.ts, ledger.json the store's H-MEM ledger entry for entry. Refuses a store with no
 * lesson and a policy with no rule: Zetaris infers a file table's columns from its rows when it is created.
 */
export async function filestoreFiles(): Promise<Record<string, string>> {
  const { fileRows, ledgerEntries } = await import("../data/file-rows.ts");
  const rows = fileRows();
  if (!rows.lesson.length) throw new SetupError(`the memory store at ${config.memoryDir} holds no lesson; Zetaris infers the columns of LESSONS.lesson from its rows, so the setup needs one (npm run answer records one)`);
  if (!rows.rule.length) throw new SetupError(`the policy file ${config.policyFile} holds no rule`);
  return { "ledger.json": JSON.stringify(ledgerEntries()), "lessons.json": JSON.stringify(rows.lesson), "rules.json": JSON.stringify(rows.rule) };
}

/**
 * The live pass's and npm run answer's refresh of the file tables: filestoreFiles over DRIFT_MEMORY_DIR and
 * DRIFT_POLICY_FILE, put when their hash differs from the one the last copy recorded (src/zetaris/filestore.ts
 * refreshFiles). A failure is returned, never thrown.
 */
export function refreshFileTables(deps: Partial<RefreshDeps> = {}): Promise<Refresh> {
  return refreshFiles({ files: filestoreFiles, ...deps });
}

const col = (r: QueryResult, name: string): number => r.columns.findIndex((c) => c.toLowerCase() === name);
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Whether SHOW DATASOURCE TABLES <datasource> lists `table`, read as the setup's own probe reads the listing (the name
 * column, else the first cell, any case): true or false, or null when the statement fails (a key without the right to
 * list, an instance that does not answer), so a caller that must not skip the table reads it and meets the failure
 * there. One statement through the engine given (a CountingEngine counts it, the tracer traces it). The live pass asks
 * before it reads change_window (src/loop/pass.ts), the console at start (src/console/state.ts zetarisGaps).
 */
export async function datasourceLists(engine: Pick<Engine, "run">, table: string, opts: RunOptions & { datasource?: string } = {}): Promise<boolean | null> {
  const { datasource = config.zetaris.datasource, ...run } = opts;
  if (!IDENT.test(datasource)) return null;
  let r: QueryResult;
  try {
    r = await engine.run(`SHOW DATASOURCE TABLES ${datasource}`, run);
  } catch {
    return null;
  }
  const i = col(r, "name");
  return r.rows.some((row) => (i >= 0 ? row[i] : row[0])?.toLowerCase() === table.toLowerCase());
}

/** Does SHOW NAMESPACES OR TABLES IN the namespace list the USL? Matches the name column when there is one, else any cell. */
function listsUsl(r: QueryResult): boolean {
  const i = col(r, "name");
  return r.rows.some((row) => (i >= 0 ? row[i] === USL_NAME : row.includes(USL_NAME)));
}

/** A column spec of LOAD USL's model, as measured 26 Oct 2026 (the zetaris.control run records it): a key column carries primaryKey, a foreign key foreignKey with the referenced table's qualified name and column. */
interface ColumnSpec { name?: unknown; primaryKey?: unknown; foreignKey?: { refTable?: unknown; refColumns?: unknown } }

/** Each table's keys as USL_DDL declares them, in column order: "<column> pk" and "<column> > <entity>(<column>)". */
export const USL_KEYS: Readonly<Record<UslTable, string>> = Object.fromEntries(USL_TABLES.map((t) => [t, (USL_DDL[t] as readonly string[]).flatMap((l) => {
  const name = l.split(" ")[0];
  const fk = / FOREIGN KEY REFERENCES (\w+)\((\w+)\)/.exec(l);
  return [...(l.includes(" PRIMARY KEY") ? [`${name} pk`] : []), ...(fk ? [`${name} > ${fk[1]}(${fk[2]})`] : [])];
}).join("; ")])) as Record<UslTable, string>;

/** A model table's keys in USL_KEYS's form. */
function modelKeys(specs: readonly ColumnSpec[]): string {
  return specs.flatMap((c) => {
    const ref = c.foreignKey ? `${String([c.foreignKey.refTable].flat()[0] ?? "").split(".").at(-1)}(${[c.foreignKey.refColumns].flat().join(",")})` : "";
    return [...(c.primaryKey ? [`${String(c.name)} pk`] : []), ...(ref ? [`${String(c.name)} > ${ref}`] : [])];
  }).join("; ");
}

/**
 * LOAD USL's model against COMPILE_USL: the reason it is stale, or null when its tables and their columns
 * are exactly USL_COLUMNS and their keys USL_KEYS. A model that fails to parse is stale.
 */
export function staleness(r: QueryResult): string | null {
  let model: { tables?: { name?: unknown; columnSpecs?: ColumnSpec[] }[] };
  try {
    model = JSON.parse(r.rows[0]?.[0] ?? "");
  } catch {
    return "LOAD USL returned no model that parses";
  }
  const tables = new Map((model.tables ?? []).map((t) => [String(t.name), t.columnSpecs ?? []]));
  const have = new Map([...tables].map(([t, specs]) => [t, specs.map((c) => String(c.name))]));
  const want = USL_TABLES;
  const missing = want.filter((t) => !have.has(t));
  const extra = [...have.keys()].filter((t) => !(want as string[]).includes(t)).sort();
  const changed = want.filter((t) => have.has(t) && have.get(t)!.join(",") !== USL_COLUMNS[t].join(","));
  const rekeyed = want.filter((t) => have.has(t) && !changed.includes(t) && modelKeys(tables.get(t)!) !== USL_KEYS[t]);
  const parts = [
    missing.length ? `lacks ${missing.join(", ")}` : "",
    extra.length ? `holds ${extra.join(", ")} beyond the ${want.length}` : "",
    changed.length ? `columns differ in ${changed.join(", ")}` : "",
    rekeyed.length ? `keys differ in ${rekeyed.join(", ")}` : "",
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
  const given = deps.env ?? envFromProcess();
  const client = deps.client ?? new Zetaris();
  const out = deps.out ?? ((l: string) => console.log(l));
  const { password } = pgTarget(given);
  const token = restToken(given);
  const scrub = (s: string, secret: string) => (secret.length >= 4 ? s.split(secret).join("<redacted>") : s);
  const clean = (s: string) => scrub(scrub(redact(s), password), token).slice(0, 400);
  const t0 = Date.now();
  // The zones first: the REST tables of the plan are one per zone and page the DNS API reports now.
  let env = given;
  if (!given.zones) {
    try {
      env = { ...given, zones: await (deps.zones ?? liveZones)(token) };
    } catch (e) {
      const msg = clean((e as Error).message ?? String(e));
      deps.tracer?.emit({ agent: AGENT, action: "observe", status: "failed", input_summary: "Cloudflare GET /zones and each zone's record count", detail: msg });
      out(`ZETARIS SETUP FAILED reading the Cloudflare zones after ${Date.now() - t0} ms: ${msg}`);
      return { ok: false, results: [], dqRuns: {}, error: msg, ms: Date.now() - t0 };
    }
    const n = env.zones!.reduce((a, z) => a + z.records, 0);
    const note = `${env.zones!.length} zone(s) the token sees, ${n} record(s), ${restTables(env.zones!).length} REST table(s) of ${RECORDS_PER_PAGE} records a page`;
    deps.tracer?.emit({ agent: AGENT, action: "observe", status: "ok", input_summary: "Cloudflare GET /zones and each zone's record count", output_summary: note, latency_ms: Date.now() - t0 });
    out(`${"ok".padEnd(7)} ${"00 read the Cloudflare zones".padEnd(44)} ${note}  (${Date.now() - t0} ms)`);
  }
  const steps = plan(env);
  const state = {
    datasourceExisted: false, missingTables: null as string[] | null, uslPresent: false, uslStale: null as string | null, rules: null as Map<string, string> | null,
    /** SHOW LIGHTNING DATABASES, names upper-cased: it listed RULES as "rules" (25 Oct 2026). */
    lightningDbs: new Set<string>(),
    /** SHOW LIGHTNING TABLES per database: each table's path and format. */
    fileTables: new Map<string, { path: string; format: string }>(),
    /** Why a listed file table is to be dropped and created again. */
    fileStale: new Map<string, string>(),
    dropped: new Set<string>(),
    /** SHOW LIGHTNING TABLES CLOUDFLARE: each REST table's endpoint, by table name. */
    restTables: new Map<string, string>(),
    restDropped: new Set<string>(),
  };
  const results: StepResult[] = [];
  const dqRuns: Partial<Record<UslTable, QueryResult>> = {};
  const restStale = (r: RestTable): boolean => state.restTables.has(r.table) && state.restTables.get(r.table) !== r.endpoint;

  const listed = (r: DqRule): string | undefined => state.rules?.get(`${r.name}@${r.table}`) ?? state.rules?.get(r.name);
  const gate = (s: Step): string | false => {
    switch (s.when) {
      case "datasource_absent": return state.datasourceExisted && `${env.datasource} exists`;
      case "datasource_present": return !state.datasourceExisted && `${env.datasource} created this run`;
      case "tables_missing": return state.datasourceExisted && state.missingTables !== null && state.missingTables.length === 0 && `every table of sql/schema.sql is registered`;
      case "tables_registered":
        return !state.datasourceExisted ? `${env.datasource} created this run`
          : (state.missingTables === null || state.missingTables.length > 0) && `registered this run`;
      case "lightning_db_absent": return state.lightningDbs.has(s.db!.toUpperCase()) && `${s.db} exists`;
      case "file_table_listed": return !state.fileTables.has(keyOf(s.file!)) && `${s.file!.db} lacks ${s.file!.table}`;
      case "file_table_stale": return !state.fileStale.has(keyOf(s.file!)) && (state.fileTables.has(keyOf(s.file!)) ? `${keyOf(s.file!)} listed as stated` : `${s.file!.db} lacks ${s.file!.table}`);
      case "file_table_absent": return state.fileTables.has(keyOf(s.file!)) && !state.dropped.has(keyOf(s.file!)) && `${keyOf(s.file!)} listed as stated`;
      case "rest_table_stale": return !restStale(s.rest!) && (state.restTables.has(s.rest!.table) ? `${REST_DB}.${s.rest!.table} listed over its endpoint` : `${REST_DB} lacks ${s.rest!.table}`);
      case "rest_table_absent": return state.restTables.has(s.rest!.table) && !state.restDropped.has(s.rest!.table) && `${REST_DB}.${s.rest!.table} listed over its endpoint`;
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
    if (s.copy) {
      try {
        const files = await (deps.files ?? filestoreFiles)();
        const put = (deps.put ?? ((f) => putFiles(f)))(files);
        // The hash of this copy, so the live pass puts the files again only when the store or the policy file changes.
        const stateFile = deps.copyState !== undefined ? deps.copyState : deps.put ? null : COPY_STATE_FILE;
        if (stateFile) recordCopy({ hash: filesHash(files), at: new Date().toISOString(), files: put }, stateFile);
        // Not a query: the trace line reads the sources and names no engine, so a tally of Zetaris queries leaves it out.
        record(i, s, { name: s.name, status: "ok", note: put.map((p) => `${p.path.slice(p.path.lastIndexOf("/") + 1)} ${p.bytes} bytes`).join(", "), ms: Date.now() - s0 }, { action: "observe", engine: undefined });
        continue;
      } catch (e) {
        const msg = clean((e as Error).message ?? String(e));
        record(i, s, { name: s.name, status: "failed", note: msg, ms: Date.now() - s0 }, { action: "observe", engine: undefined, detail: msg });
        const ms = Date.now() - t0;
        out(`ZETARIS SETUP FAILED at ${String(i + 1).padStart(2, "0")} ${s.name} after ${ms} ms: ${msg}`);
        return { ok: false, results, dq: dqRuns.collection, dqRuns, error: msg, ms };
      }
    }
    try {
      const r = await client.query(s.secret ? s.secret() : s.sql, { limit: 200, timeoutMs: s.timeoutMs ?? 60_000, ...(s.multi ? { allowMultiStatement: true } : {}) });
      let note = rowsNote(r);
      if (s.expect !== undefined) note += `, the zones report ${s.expect}`;
      if (s.probe === "lightning_dbs") {
        const n = col(r, "name");
        state.lightningDbs = new Set(r.rows.map((row) => (n >= 0 ? row[n] : row[0]).toUpperCase()));
        note += `, ${[...LIGHTNING_DBS.map((d) => d.name), REST_DB].map((d) => `${d} ${state.lightningDbs.has(d.toUpperCase()) ? "listed" : "not listed"}`).join(", ")}`;
      }
      if (s.probe === "rest_tables") {
        const [n, p] = [col(r, "name"), col(r, "source_table")];
        for (const row of r.rows) state.restTables.set(row[n >= 0 ? n : 0], p >= 0 ? row[p] : "");
        const planned = steps.filter((x) => x.when === "rest_table_absent").map((x) => x.rest!);
        const listedAs = planned.filter((x) => state.restTables.get(x.table) === x.endpoint).length;
        const stale = planned.filter(restStale).length;
        note += `, ${listedAs} of ${planned.length} REST tables listed over their endpoint${stale ? `, ${stale} over another` : ""}`;
      }
      if (s.when === "rest_table_stale" && s.rest) state.restDropped.add(s.rest.table);
      if (s.probe === "file_tables") {
        const [n, p, f] = [col(r, "name"), col(r, "source_table"), col(r, "format")];
        const say: string[] = [];
        for (const fs of FILE_SOURCES.filter((x) => x.db === s.db)) {
          const row = r.rows.find((x) => x[n >= 0 ? n : 0] === fs.table);
          if (!row) { say.push(`${fs.table} not listed`); continue; }
          const listed = { path: p >= 0 ? row[p] : "", format: f >= 0 ? row[f].toLowerCase() : "" };
          state.fileTables.set(keyOf(fs), listed);
          if (listed.path !== pathOf(fs) || listed.format !== "json") state.fileStale.set(keyOf(fs), `listed over ${listed.path} as ${listed.format}`);
          say.push(`${fs.table} ${state.fileStale.has(keyOf(fs)) ? state.fileStale.get(keyOf(fs)) : "listed"}`);
        }
        note += `, ${say.join(", ")}`;
      }
      if (s.probe === "file_columns" && s.file?.columns) {
        const n = col(r, "col_name");
        const have = new Set(r.rows.map((row) => row[n >= 0 ? n : 0]));
        const lacks = s.file.columns.filter((c) => !have.has(c));
        const extra = [...have].filter((c) => !s.file!.columns!.includes(c)).sort();
        if (lacks.length || extra.length) {
          const why = [lacks.length ? `lacks ${lacks.join(", ")}` : "", extra.length ? `holds ${extra.join(", ")}` : ""].filter(Boolean).join("; ");
          state.fileStale.set(keyOf(s.file), state.fileStale.has(keyOf(s.file)) ? `${state.fileStale.get(keyOf(s.file))}; ${why}` : why);
        }
        note += `, ${state.fileStale.has(keyOf(s.file)) ? `stale: ${state.fileStale.get(keyOf(s.file))}` : `the ${s.file.columns.length} columns`}`;
      }
      if (s.when === "file_table_stale" && s.file) state.dropped.add(keyOf(s.file));
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
