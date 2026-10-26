// The Zetaris setup with no live call: plan() order and texts (the copy into the filestore, the LESSONS and RULES
// Lightning databases and their file tables, the CLOUDFLARE REST tables one per zone and page, fifteen USL tables, each
// activation returning exactly its declared columns, the adoption entity across DRIFT and LESSONS, dns_live across
// CLOUDFLARE and DRIFT, six DQ rules), the semantic layer's table uslRows() and uslMarkdown() read off the
// DDL, the activation SELECTs and DQ_RULES, staleness() of a USL model, exception_in_force and dns_inventory_current on
// plain columns, the docker command line of the copy, the password and the Cloudflare token kept out of every
// string that is printed, traced or redact()ed, apply() over a scripted client and a recorded copy (an instance already set up,
// the four-table USL of 24 Oct, the eleven-table USL of 25 Oct with a stale ledger table, the fourteen-table USL with no
// CLOUDFLARE database, a REST table over another endpoint, an error echoing the token, the zones read first, a file table with other
// columns, a failed copy, a rule listed with another expression, a fresh instance, one that fails), the copy's
// freshness (the hash a copy records, refreshFileTables over a fake put), and the adapter's allowMultiStatement and redaction against a stubbed fetch, and the engine every query trace event
// names (zetaris or sqljs).
// The env is stubbed before config loads, so the real .env key and DATABASE_URL never enter this file.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "../src/adapters/zetaris.ts";

const PW = "pw-Zx9q-not-real-41";
const DB_URL = `postgresql://drift:${PW}@127.0.0.1:15432/drift`;
/** The Cloudflare read token, as a test value: the REST tables' Authorization header carries it. */
const TOKEN = "cfTk_not-real_0123456789abcdefghijKLMN";
vi.stubEnv("ZETARIS_API_KEY", "test-key-not-real");
vi.stubEnv("DATABASE_URL", DB_URL);
vi.stubEnv("ZETARIS_PG_HOST", "drift-pg");
vi.stubEnv("ZETARIS_DATASOURCE", "DRIFT");
vi.stubEnv("CLOUDFLARE_API_TOKEN", TOKEN);
const { redact } = await import("../src/config.ts");
const { Zetaris, ZetarisError } = await import("../src/adapters/zetaris.ts");
const { stripLiterals } = await import("../src/data/layer.ts");
const setup = await import("../src/zetaris/setup.ts");
const { TABLE_NAMES } = await import("../src/data/schema.ts");
const { ADOPTION_SQL, fileTableDef } = await import("../src/data/files.ts");
const { COPY_STATE_FILE, dockerArgv, filesHash, putFiles, readCopyState } = await import("../src/zetaris/filestore.ts");
const { MemTracer } = await import("./fixtures/mem-tracer.ts");

afterAll(() => vi.unstubAllEnvs());

/** Three zones: one of 600 records (two pages of 500), one of 3, one with none (no table). */
const ZA = "0123456789abcdef0123456789abcdef";
const ZB = "fedcba9876543210fedcba9876543210";
const ZC = "00000000000000000000000000000000";
const ZONES = [{ id: ZA, records: 600 }, { id: ZB, records: 3 }, { id: ZC, records: 0 }];
const API = "https://api.cloudflare.com/client/v4";
const REST: [string, string][] = [
  [`zone_${ZA}`, `${API}/zones/${ZA}/dns_records?per_page=500&page=1`],
  [`zone_${ZA}_p2`, `${API}/zones/${ZA}/dns_records?per_page=500&page=2`],
  [`zone_${ZB}`, `${API}/zones/${ZB}/dns_records?per_page=500&page=1`],
];
const ENV = { databaseUrl: DB_URL, pgHost: "drift-pg", datasource: "DRIFT", cloudflareToken: TOKEN, zones: ZONES };
const USL = "lightning.metastore.drift.drift_usl";
const CREATE_PRINTED = `CREATE DATASOURCE DRIFT DESCRIBE BY "drift-agent app Postgres on the zetaris network" OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://drift-pg:5432/drift", username "drift", password "<redacted>", schema "public", fetchsize "1000")`;
const restPrinted = (table: string, endpoint: string) => `CREATE LIGHTNING REST TABLE ${table} FROM CLOUDFLARE REQUEST (endpoint "${endpoint}", method "GET", http_encoding "URLENCODED", response_type "JSON", insecure_ssl "false") HEADER (Authorization "Bearer <redacted>") BODY ()`;
const step = (name: string, steps = setup.plan(ENV)) => steps.find((s) => s.name === name)!;

const ELEVEN = ["collection", "setting", "referent", "backup_copy", "policy", "copy", "probe", "disposition", "action", "ticket", "cause"];
/** The eleven over DRIFT, then the two file tables and the cross-source join. */
const FOURTEEN = [...ELEVEN, "lesson", "rule", "adoption"];
/** Then the live records across CLOUDFLARE and DRIFT. */
const FIFTEEN = [...FOURTEEN, "dns_live"];
const RULES = ["run_complete", "copy_validated", "action_verified", "cause_evidenced", "exception_in_force", "dns_inventory_current"];
/** exception_in_force: the ADOPT names a lesson the store holds, an exception, taught at or before the decision and expiring after it. */
const EXCEPTION_IN_FORCE_EXPR = "lesson_id IS NOT NULL AND lesson_kind = 'exception' AND lesson_recorded_at <= decided_at AND decided_at < lesson_expires_at";
/** dns_inventory_current: the last complete DNS run holds the live record, with its type and proxied flag. */
const DNS_EXPR = "held_type <> '' AND held_type = live_type AND held_proxied = live_proxied";
const DIR = "/home/zetaris/customer-data/shared/drift-agent";
/** The file sources' steps, between the DRIFT registration and the namespaces. */
const FILE_STEPS: [string, string][] = [
  ["copy files to the filestore", ""],
  ["show lightning databases", ""],
  ["create lightning database LESSONS", "lightning_db_absent"],
  ["create lightning database RULES", "lightning_db_absent"],
  ["list LESSONS tables", ""],
  ["list RULES tables", ""],
  ["drop LESSONS.ledger", "file_table_stale"],
  ["create LESSONS.ledger", "file_table_absent"],
  ["describe LESSONS.lesson", "file_table_listed"],
  ["drop LESSONS.lesson", "file_table_stale"],
  ["create LESSONS.lesson", "file_table_absent"],
  ["describe RULES.rule", "file_table_listed"],
  ["drop RULES.rule", "file_table_stale"],
  ["create RULES.rule", "file_table_absent"],
];
/** The REST source's steps, after the file sources: the database, its listing, then each table's DROP and CREATE. */
const REST_STEPS: [string, string][] = [
  ["create lightning database CLOUDFLARE", "lightning_db_absent"],
  ["list CLOUDFLARE tables", ""],
  ...REST.flatMap(([t]): [string, string][] => [[`drop CLOUDFLARE.${t}`, "rest_table_stale"], [`create CLOUDFLARE.${t}`, "rest_table_absent"]]),
];
const RUN_COMPLETE_EXPR = "observed_count IS NOT NULL AND expected_count IS NOT NULL AND observed_count >= expected_count AND status = 'complete'";
/** action_verified, scoped to the write paths. */
const ACTION_VERIFIED_EXPR = "kind NOT IN ('rollback_file','revert_record') OR status IN ('failed','refused','not_judged') OR verification <> ''";
/** cause_evidenced: a cause of any class but unknown names at least one evidence id. */
const CAUSE_EVIDENCED_EXPR = "cause_class = 'unknown' OR evidence_ids <> '[]'";
/** The cause entity's DDL block as COMPILE_USL carries it. */
const CAUSE_DDL = `CREATE TABLE cause (
  cause_id varchar(128) NOT NULL PRIMARY KEY,
  tenant_id varchar(64) NOT NULL,
  finding_id varchar(255) NOT NULL,
  disposition_id varchar(128) NOT NULL FOREIGN KEY REFERENCES disposition(disposition_id),
  cause_class varchar(32) NOT NULL,
  actor varchar(255),
  mechanism varchar(64),
  occurred_at varchar(40),
  source_host varchar(128),
  evidence_ids varchar(2048) NOT NULL,
  diff varchar(8192),
  summary varchar(1024) NOT NULL,
  window_from varchar(40) NOT NULL,
  window_to varchar(40) NOT NULL,
  decided_at varchar(40) NOT NULL
)`;

/** The SELECT list's output names of an ACTIVATE statement: parenthesised groups removed, then the last word of each item. */
function activatedColumns(sql: string): string[] {
  let s = sql.slice(sql.indexOf(" AS SELECT ") + " AS SELECT ".length);
  for (let prev = ""; prev !== s;) { prev = s; s = s.replace(/\([^()]*\)/g, ""); }
  return s.slice(0, s.indexOf(" FROM ")).split(",").map((item) => item.trim().split(/\s+/).at(-1)!.split(".").at(-1)!);
}

describe("plan()", () => {
  const steps = setup.plan(ENV);

  it("orders the statements, each gated step on its condition", () => {
    expect(steps.map((s) => [s.name, s.when ?? ""])).toEqual([
      ["show datasources", ""],
      ["create datasource DRIFT", "datasource_absent"],
      ["list datasource tables", "datasource_present"],
      ["register datasource tables", "tables_missing"],
      ["refresh datasource tables", "tables_registered"],
      ...FILE_STEPS,
      ...REST_STEPS,
      ["namespace lightning.metastore", ""],
      ["namespace lightning.metastore.drift", ""],
      ["list lightning.metastore.drift", ""],
      ["load usl drift_usl", "usl_present"],
      ["remove usl drift_usl", "usl_stale"],
      ["compile usl drift_usl", "usl_absent"],
      ...FIFTEEN.map((t) => [`activate ${t}`, ""]),
      ["list dq rules", ""],
      ...RULES.flatMap((r) => [[`register dq ${r}`, "dq_rule_absent"], [`update dq ${r}`, "dq_rule_differs"]]),
      ["run dq collection", ""],
      ["run dq copy", ""],
      ["run dq action", ""],
      ["run dq cause", ""],
      ["run dq adoption", ""],
      ["run dq dns_live", ""],
      ["show lightning.metastore.drift.drift_usl", ""],
      ...FIFTEEN.map((t) => [`count ${t}`, ""]),
      ["count LESSONS.ledger", ""],
    ]);
    expect(steps).toHaveLength(84);
    expect(setup.USL_TABLES).toEqual(FIFTEEN);
  });

  it("the REST source: one table per zone and page of 500 records, none for an empty zone; each CREATE printed with the token redacted and built with it in memory; the count of dns_live states what the zones report", () => {
    expect(setup.restTables(ZONES).map((t) => [t.table, t.endpoint])).toEqual(REST);
    expect(setup.REST_DB_DESCRIBE).toMatch(/^[A-Za-z0-9 _.,-]+$/);
    expect(step("create lightning database CLOUDFLARE", steps)).toMatchObject({ sql: 'CREATE LIGHTNING DATABASE CLOUDFLARE DESCRIBE BY "Cloudflare DNS API, the records of each zone live at the provider"', db: "CLOUDFLARE" });
    expect(step("list CLOUDFLARE tables", steps)).toMatchObject({ sql: "SHOW LIGHTNING TABLES CLOUDFLARE", probe: "rest_tables" });
    for (const [t, endpoint] of REST) {
      const create = step(`create CLOUDFLARE.${t}`, steps);
      expect(create.sql).toBe(restPrinted(t, endpoint));
      expect(create.secret!()).toBe(restPrinted(t, endpoint).replace("<redacted>", TOKEN));
      expect(create.traceAs).toBe(`CREATE LIGHTNING REST TABLE ${t} FROM CLOUDFLARE (token redacted)`);
      expect(step(`drop CLOUDFLARE.${t}`, steps).sql).toBe(`DROP LIGHTNING DATABASE TABLE CLOUDFLARE.${t}`);
    }
    expect(steps.filter((s) => s.secret).map((s) => s.name)).toEqual(["create datasource DRIFT", ...REST.map(([t]) => `create CLOUDFLARE.${t}`)]);
    expect(step("count dns_live", steps)).toMatchObject({ sql: `SELECT COUNT(*) AS n FROM ${USL}.dns_live`, expect: 603 });
    const printed = setup.formatPlan(steps, "DRIFT").join("\n");
    expect(printed).toContain(`21 list CLOUDFLARE tables\n     SHOW LIGHTNING TABLES CLOUDFLARE\n22 drop CLOUDFLARE.zone_${ZA}  (only when CLOUDFLARE lists zone_${ZA} over another endpoint)`);
    expect(printed).toContain(`23 create CLOUDFLARE.zone_${ZA}  (only when CLOUDFLARE lacks zone_${ZA} or it was dropped this run)\n     ${restPrinted(`zone_${ZA}`, REST[0][1])}`);
    expect(printed).not.toContain(TOKEN);
    expect(JSON.stringify(steps)).not.toContain(TOKEN);
  });

  it("refuses a REST source it cannot build: no token, a token that would break its quotes, zones not read, a zone id that is not 32 hex digits, no zone with a record; the token never in the message", () => {
    const bad: [Partial<typeof ENV>, RegExp][] = [
      [{ cloudflareToken: "" }, /CLOUDFLARE_API_TOKEN is not set/],
      [{ cloudflareToken: `a"${TOKEN}` }, /double quote, backslash or whitespace/],
      [{ cloudflareToken: `${TOKEN} x` }, /double quote, backslash or whitespace/],
      [{ zones: undefined }, /zones are not read/],
      [{ zones: [{ id: `${ZA.slice(1)}'`, records: 1 }] }, /32 hex digits/],
      [{ zones: [{ id: ZA, records: 1.5 }] }, /whole number/],
      [{ zones: [{ id: ZC, records: 0 }] }, /no zone with a record/],
    ];
    for (const [patch, why] of bad) {
      let msg = "";
      try { setup.plan({ ...ENV, ...patch }); } catch (e) { msg = (e as Error).message; }
      expect(msg, String(why)).toMatch(why);
      expect(msg).not.toContain(TOKEN);
    }
  });

  it("the file sources: the copy into the filestore, then the two Lightning databases and each table's DESCRIBE, DROP and CREATE over its JSON file", () => {
    const copy = step("copy files to the filestore", steps);
    expect(copy.copy).toBe(true);
    expect(copy.sql).toBe(`docker exec -i <driver container> sh -c 'cat > ${DIR}/<file>' for ledger.json, lessons.json, rules.json (written from DRIFT_MEMORY_DIR and DRIFT_POLICY_FILE)`);
    expect(step("show lightning databases", steps)).toMatchObject({ sql: "SHOW LIGHTNING DATABASES", probe: "lightning_dbs" });
    expect(step("create lightning database LESSONS", steps)).toMatchObject({ sql: 'CREATE LIGHTNING DATABASE LESSONS DESCRIBE BY "drift-agent technician memory store, the Meterless H-MEM lessons and ledger"', db: "LESSONS" });
    expect(step("create lightning database RULES", steps)).toMatchObject({ sql: 'CREATE LIGHTNING DATABASE RULES DESCRIBE BY "drift-agent policy file, one row per rule"', db: "RULES" });
    // DESCRIBE BY takes letters, digits, spaces and _ . - , only
    for (const d of setup.LIGHTNING_DBS) expect(d.describe).toMatch(/^[A-Za-z0-9 _.,-]+$/);
    expect(step("list LESSONS tables", steps)).toMatchObject({ sql: "SHOW LIGHTNING TABLES LESSONS", probe: "file_tables" });
    expect(step("list RULES tables", steps)).toMatchObject({ sql: "SHOW LIGHTNING TABLES RULES", probe: "file_tables" });
    expect(step("create LESSONS.ledger", steps).sql).toBe(`CREATE LIGHTNING FILESTORE TABLE ledger FROM LESSONS FORMAT JSON OPTIONS (path "${DIR}/ledger.json")`);
    expect(step("create LESSONS.lesson", steps).sql).toBe(`CREATE LIGHTNING FILESTORE TABLE lesson FROM LESSONS FORMAT JSON OPTIONS (path "${DIR}/lessons.json")`);
    expect(step("create RULES.rule", steps).sql).toBe(`CREATE LIGHTNING FILESTORE TABLE rule FROM RULES FORMAT JSON OPTIONS (path "${DIR}/rules.json")`);
    expect(step("drop LESSONS.lesson", steps).sql).toBe("DROP LIGHTNING DATABASE TABLE LESSONS.lesson");
    expect(step("describe RULES.rule", steps)).toMatchObject({ sql: "DESCRIBE DATASOURCE TABLE RULES.rule", probe: "file_columns" });
    // the ledger is the store's own entries, so its columns are the H-MEM ledger's and no DESCRIBE holds them
    expect(steps.some((s) => s.name === "describe LESSONS.ledger")).toBe(false);
    expect(step("count LESSONS.ledger", steps).sql).toBe("SELECT COUNT(*) AS n FROM LESSONS.ledger");
    const printed = setup.formatPlan(steps, "DRIFT").join("\n");
    expect(printed).toContain("06 copy files to the filestore\n");
    expect(printed).toContain("15 drop LESSONS.lesson  (only when LESSONS lists lesson over another path or format, or with other columns)");
    expect(printed).toContain("16 create LESSONS.lesson  (only when LESSONS lacks lesson or it was dropped this run)");
  });

  it("datasource: CREATE from DATABASE_URL with the host replaced, built in memory; list its tables; register; refresh", () => {
    const create = step("create datasource DRIFT", steps);
    expect(create.sql).toBe(CREATE_PRINTED);
    expect(create.secret!()).toBe(CREATE_PRINTED.replace("<redacted>", PW));
    expect(create.traceAs).toBe("CREATE DATASOURCE DRIFT (credentials redacted)");
    expect(step("show datasources", steps).sql).toBe("SHOW DATASOURCES");
    expect(step("list datasource tables", steps).sql).toBe("SHOW DATASOURCE TABLES DRIFT");
    expect(step("register datasource tables", steps).sql).toBe("REGISTER DATASOURCE TABLES FROM DRIFT");
    expect(step("refresh datasource tables", steps).sql).toBe("REFRESH DATASOURCE TABLES FROM DRIFT");
    // the only other statements built in memory are the REST tables' CREATEs, which carry the token
    expect(steps.filter((s) => s.secret && !s.name.startsWith("create CLOUDFLARE.")).map((s) => s.name)).toEqual(["create datasource DRIFT"]);
  });

  it("namespaces, the USL probes and REMOVE, then the fifteen-table USL DDL in one request with the renamed reserved words", () => {
    expect(step("namespace lightning.metastore", steps).sql).toBe("CREATE NAMESPACE IF NOT EXISTS lightning.metastore");
    expect(step("namespace lightning.metastore.drift", steps).sql).toBe("CREATE NAMESPACE IF NOT EXISTS lightning.metastore.drift");
    expect(step("list lightning.metastore.drift", steps).sql).toBe("SHOW NAMESPACES OR TABLES IN lightning.metastore.drift");
    expect(step("load usl drift_usl", steps).sql).toBe("LOAD USL drift_usl NAMESPACE lightning.metastore.drift");
    expect(step("remove usl drift_usl", steps).sql).toBe("REMOVE USL drift_usl NAMESPACE lightning.metastore.drift");
    const ddl = step("compile usl drift_usl", steps);
    expect(ddl.multi).toBe(true);
    expect(ddl.sql).toBe(setup.COMPILE_USL);
    expect(ddl.sql.startsWith("COMPILE USL IF NOT EXISTS drift_usl DEPLOY NAMESPACE lightning.metastore.drift DDL\nCREATE TABLE collection (\n")).toBe(true);
    expect([...ddl.sql.matchAll(/^CREATE TABLE (\w+) \($/gm)].map((m) => m[1])).toEqual(FIFTEEN);
    expect(ddl.sql.match(/\);\nCREATE TABLE /g)).toHaveLength(14);
    expect(ddl.sql).toContain("  run_id varchar(128) NOT NULL FOREIGN KEY REFERENCES collection(run_id),");
    expect(ddl.sql).toContain("  setting_id varchar(128) NOT NULL FOREIGN KEY REFERENCES setting(setting_id),");
    expect(ddl.sql).toContain("  disposition_id varchar(128) NOT NULL FOREIGN KEY REFERENCES disposition(disposition_id)\n);");
    expect(ddl.sql).toContain("  source_kind varchar(32) NOT NULL,");
    expect(ddl.sql).toContain("  lock int NOT NULL,");
    expect(ddl.sql).toContain("  validated int NOT NULL\n)");
    expect(ddl.sql).not.toMatch(/^\s+source varchar/m);
    expect(ddl.sql).not.toMatch(/CREATE TABLE reference\b/);
    // cause, the eleventh, after ticket: finding_cause with class as cause_class, its disposition a foreign key as action's is
    expect(ddl.sql).toContain(`  updated_at varchar(40) NOT NULL\n);\n${CAUSE_DDL};\nCREATE TABLE lesson (\n`);
    expect(ddl.sql).not.toMatch(/^\s+class varchar/m);
    // then the file tables and the join; adoption last, its lesson a foreign key into lesson (measured 25 Oct 2026: rule,
    // description and provenance pass the validator)
    expect(ddl.sql).toContain("CREATE TABLE rule (\n  rule_id varchar(128) NOT NULL PRIMARY KEY,");
    expect(ddl.sql).toContain("  locked int NOT NULL,");
    expect(ddl.sql).toContain("  description varchar(1024)\n);\nCREATE TABLE adoption (\n");
    expect(ddl.sql).toContain("  lesson_id varchar(64) FOREIGN KEY REFERENCES lesson(lesson_id),\n  lesson_kind varchar(16),\n  lesson_recorded_at varchar(40),\n  lesson_expires_at varchar(40)\n);\nCREATE TABLE dns_live (\n");
    // dns_live last: the record id the key, its run a foreign key into collection, the flags and the held type NOT NULL
    expect(ddl.sql.endsWith("CREATE TABLE dns_live (\n  record_id varchar(64) NOT NULL PRIMARY KEY,\n  tenant_id varchar(64) NOT NULL,\n  zone_id varchar(64) NOT NULL,\n  live_type varchar(16) NOT NULL,\n  live_proxied int NOT NULL,\n  run_id varchar(128) FOREIGN KEY REFERENCES collection(run_id),\n  run_started_at varchar(40),\n  held_type varchar(16) NOT NULL,\n  held_proxied int NOT NULL\n)")).toBe(true);
    // the file tables' USL columns are the columns the setup writes and sql.js holds
    expect([...setup.USL_COLUMNS.lesson]).toEqual(fileTableDef("lesson")!.columns);
    expect([...setup.USL_COLUMNS.rule]).toEqual(fileTableDef("rule")!.columns);
    // USL_COLUMNS is read off the same DDL lines
    for (const t of FIFTEEN) {
      const block = ddl.sql.slice(ddl.sql.indexOf(`CREATE TABLE ${t} (\n`)).split("\n)")[0].split("\n").slice(1);
      expect(block.map((l) => l.trim().split(" ")[0]), t).toEqual([...setup.USL_COLUMNS[t as keyof typeof setup.USL_COLUMNS]]);
    }
  });

  it("activates each of the fifteen tables over its datasource, returning exactly the declared columns", () => {
    for (const t of FIFTEEN) {
      const s = step(`activate ${t}`, steps).sql;
      expect(s.startsWith(`ACTIVATE USL TABLE ${USL}.${t} AS SELECT `)).toBe(true);
      expect(activatedColumns(s), t).toEqual([...setup.USL_COLUMNS[t as keyof typeof setup.USL_COLUMNS]]);
    }
    expect(step("activate collection", steps).sql).toMatch(/CAST\(expected_count AS INT\) AS expected_count, .* FROM DRIFT\.collection_run$/);
    expect(step("activate setting", steps).sql).toMatch(/COALESCE\(source, ''\) AS source_kind, CAST\(COALESCE\(authority, 0\) AS INT\) AS authority FROM DRIFT\.observation$/);
    expect(step("activate referent", steps).sql).toMatch(/FROM DRIFT\.observation o JOIN DRIFT\.dns_record d ON d\.tenant_id = o\.tenant_id AND d\.name = o\.refers_to_id WHERE o\.refers_to_type = 'dns_name'$/);
    expect(step("activate backup_copy", steps).sql).toMatch(/FROM DRIFT\.backup_item b JOIN DRIFT\.backup_snapshot s ON s\.snapshot_id = b\.snapshot_id$/);
    expect(step("activate policy", steps).sql).toMatch(/CAST\(COALESCE\(lock, 0\) AS INT\) AS lock, .* note FROM DRIFT\.policy_rule$/);
    const copy = step("activate copy", steps).sql;
    expect(copy).toContain("COALESCE(c.source, '') AS source_kind");
    expect(copy).toContain("CAST(CASE WHEN l.result IN ('ok', 'ok_with_gaps') THEN 1 ELSE 0 END AS INT) AS validated");
    expect(copy).toMatch(/FROM DRIFT\.vault_copy c LEFT JOIN \(SELECT v\.copy_id, v\.validator, v\.result, v\.validated_at FROM DRIFT\.copy_validation v WHERE NOT EXISTS \(SELECT 1 FROM DRIFT\.copy_validation w WHERE w\.copy_id = v\.copy_id AND .*\)\) l ON l\.copy_id = c\.copy_id$/);
    expect(step("activate probe", steps).sql).toMatch(/CAST\(latency_ms AS INT\) AS latency_ms, COALESCE\(observed_at, ''\) AS observed_at FROM DRIFT\.probe$/);
    expect(step("activate disposition", steps).sql).toMatch(/COALESCE\(reason, ''\) AS reason, expires_at, COALESCE\(decided_by, ''\) AS decided_by, rule_id, .* FROM DRIFT\.disposition$/);
    expect(step("activate action", steps).sql).toMatch(/COALESCE\(verification, ''\) AS verification, COALESCE\(receipts, ''\) AS receipts, COALESCE\(status, ''\) AS status, COALESCE\(reason, ''\) AS reason, COALESCE\(record, ''\) AS record, .* FROM DRIFT\.action$/);
    expect(step("activate ticket", steps).sql).toMatch(/external_id, url, COALESCE\(type, ''\) AS type, .* FROM DRIFT\.ticket$/);
    // cause: each NOT NULL column in COALESCE, class read as cause_class, the nullable ones bare
    expect(step("activate cause", steps).sql).toBe(`ACTIVATE USL TABLE ${USL}.cause AS SELECT COALESCE(cause_id, '') AS cause_id, COALESCE(tenant_id, '') AS tenant_id, COALESCE(finding_id, '') AS finding_id, COALESCE(disposition_id, '') AS disposition_id, COALESCE(class, '') AS cause_class, actor, mechanism, occurred_at, source_host, COALESCE(evidence_ids, '') AS evidence_ids, diff, COALESCE(summary, '') AS summary, COALESCE(window_from, '') AS window_from, COALESCE(window_to, '') AS window_to, COALESCE(decided_at, '') AS decided_at FROM DRIFT.finding_cause`);
    // the file tables: lesson and rule over their Lightning databases; adoption is the catalogue's ADOPTION_SQL on one line, DRIFT x LESSONS
    expect(step("activate lesson", steps).sql).toBe(`ACTIVATE USL TABLE ${USL}.lesson AS SELECT COALESCE(lesson_id, '') AS lesson_id, COALESCE(tenant_id, '') AS tenant_id, COALESCE(kind, '') AS kind, finding_class, COALESCE(scope_key, '') AS scope_key, COALESCE(reason, '') AS reason, COALESCE(recorded_at, '') AS recorded_at, COALESCE(expires_at, '') AS expires_at, COALESCE(provenance, '') AS provenance FROM LESSONS.lesson`);
    expect(step("activate rule", steps).sql).toMatch(/CAST\(COALESCE\(version, 0\) AS INT\) AS version, .* CAST\(COALESCE\(locked, 0\) AS INT\) AS locked, .* CAST\(COALESCE\(hold_hours, 0\) AS INT\) AS hold_hours, .* description FROM RULES\.rule$/);
    const adoption = setup.activation("adoption", "DRIFT");
    expect(adoption).toBe(ADOPTION_SQL.replace("{{t:disposition}}", "DRIFT.disposition").replace("{{t:lesson}}", "LESSONS.lesson").replace(/\s+/g, " ").trim());
    expect(adoption).toContain("FROM DRIFT.disposition d LEFT JOIN LESSONS.lesson l ON l.tenant_id = d.tenant_id AND d.reason LIKE 'accepted exception ' || l.lesson_id || ' holds until %' WHERE d.decided_by = 'operator' AND d.verb = 'ADOPT'");
    // the top-level WHERE compares plain columns (a function there is dropped at pushdown, measured 24 Oct)
    expect(adoption.slice(adoption.indexOf(" WHERE "))).not.toMatch(/\w\s*\(/);
    expect(setup.activation("adoption", "DRIFT2")).toContain("FROM DRIFT2.disposition d LEFT JOIN LESSONS.lesson l");
    // the CAST list: each entity's int columns of the DDL, each out of a CAST AS INT, and no other column; cause has none
    const casts: Record<string, string[]> = {};
    const ints: Record<string, string[]> = {};
    for (const t of FIFTEEN) {
      casts[t] = [...step(`activate ${t}`, steps).sql.matchAll(/ AS INT\) AS (\w+)/g)].map((m) => m[1]);
      const block = setup.COMPILE_USL.slice(setup.COMPILE_USL.indexOf(`CREATE TABLE ${t} (\n`)).split("\n)")[0];
      ints[t] = [...block.matchAll(/^ {2}(\w+) int\b/gm)].map((m) => m[1]);
    }
    expect(casts).toEqual(ints);
    expect(casts).toMatchObject({ collection: ["expected_count", "observed_count"], policy: ["lock", "hold_max_hours", "version"], copy: ["validated"], cause: [], lesson: [], rule: ["version", "locked", "hold_hours"], adoption: [], dns_live: ["live_proxied", "held_proxied"] });
  });

  it("activates dns_live over every REST table and DRIFT in one SELECT: each table's result exploded, the last complete DNS run by run_complete's own expression, its dns_record joined on the record id; no name or content read", () => {
    const sql = step("activate dns_live", steps).sql;
    expect(sql).toBe(`ACTIVATE USL TABLE ${USL}.dns_live AS ${setup.activation("dns_live", "DRIFT", setup.restTables(ZONES))}`);
    const live = REST.map(([t], i) => `SELECT r.id AS record_id, '${i < 2 ? ZA : ZB}' AS zone_id, r.type AS type, r.proxied AS proxied FROM CLOUDFLARE.${t} LATERAL VIEW explode(result) AS r`).join(" UNION ALL ");
    expect(sql).toContain(`FROM (${live}) l LEFT JOIN (`);
    expect(sql).not.toContain(ZC);
    // the run: cloudflare.dns, run_complete's predicate over it, and no later run that passes it (ties to the greater run_id)
    const complete = (a: string) => RUN_COMPLETE_EXPR.replace(/\b(observed_count|expected_count|status)\b/g, `${a}.$1`);
    expect(sql).toContain(`(SELECT c.run_id, c.tenant_id, c.started_at FROM DRIFT.collection_run c WHERE c.surface = 'cloudflare.dns' AND ${complete("c")} AND NOT EXISTS (SELECT 1 FROM DRIFT.collection_run w WHERE w.surface = 'cloudflare.dns' AND ${complete("w")} AND (w.started_at > c.started_at OR (w.started_at = c.started_at AND w.run_id > c.run_id)))) k ON 1 = 1`);
    expect(sql.endsWith("LEFT JOIN DRIFT.dns_record d ON d.run_id = k.run_id AND d.record_id = l.record_id")).toBe(true);
    // the flags 1, 0 or -1 when absent, the held type '' when the run lacks the record: every column the rule reads is NOT NULL
    expect(sql).toContain("CAST(CASE WHEN l.proxied THEN 1 WHEN NOT l.proxied THEN 0 ELSE -1 END AS INT) AS live_proxied");
    expect(sql).toContain("COALESCE(d.type, '') AS held_type, CAST(COALESCE(d.proxied, -1) AS INT) AS held_proxied");
    // ids are joined on; names and contents are pseudonymised in DRIFT and never read here
    expect(sql).not.toMatch(/\.(name|content)\b/);
    expect(setup.activation("dns_live", "DRIFT2", setup.restTables(ZONES))).toContain("FROM DRIFT2.collection_run c WHERE");
    expect(() => setup.activation("dns_live", "DRIFT")).toThrow(/at least one CLOUDFLARE REST table/);
  });

  it("then the DQ rules (register or update), RUN DQ on collection, copy, action, cause, adoption and dns_live, the USL's table listing and a count per table", () => {
    expect(step("list dq rules", steps).sql).toBe(`LIST DQ USL ${USL}`);
    expect(setup.DQ_RULES.map((r) => [r.name, r.table, r.expression])).toEqual([
      ["run_complete", "collection", RUN_COMPLETE_EXPR],
      ["copy_validated", "copy", "validated = 1"],
      ["action_verified", "action", ACTION_VERIFIED_EXPR],
      ["cause_evidenced", "cause", CAUSE_EVIDENCED_EXPR],
      ["exception_in_force", "adoption", EXCEPTION_IN_FORCE_EXPR],
      ["dns_inventory_current", "dns_live", DNS_EXPR],
    ]);
    expect(step("register dq dns_inventory_current", steps).sql).toBe(`REGISTER DQ dns_inventory_current TABLE ${USL}.dns_live AS ${DNS_EXPR}`);
    expect(step("update dq dns_inventory_current", steps).sql).toBe(`UPDATE DQ dns_inventory_current TABLE ${USL}.dns_live SET NAME = dns_inventory_current, EXPRESSION = ${DNS_EXPR}`);
    expect(step("register dq exception_in_force", steps).sql).toBe(`REGISTER DQ exception_in_force TABLE ${USL}.adoption AS ${EXCEPTION_IN_FORCE_EXPR}`);
    expect(step("update dq exception_in_force", steps).sql).toBe(`UPDATE DQ exception_in_force TABLE ${USL}.adoption SET NAME = exception_in_force, EXPRESSION = ${EXCEPTION_IN_FORCE_EXPR}`);
    expect(step("register dq run_complete", steps).sql).toBe(`REGISTER DQ run_complete TABLE ${USL}.collection AS ${RUN_COMPLETE_EXPR}`);
    expect(step("update dq run_complete", steps).sql).toBe(`UPDATE DQ run_complete TABLE ${USL}.collection SET NAME = run_complete, EXPRESSION = ${RUN_COMPLETE_EXPR}`);
    expect(step("register dq copy_validated", steps).sql).toBe(`REGISTER DQ copy_validated TABLE ${USL}.copy AS validated = 1`);
    expect(step("register dq action_verified", steps).sql).toBe(`REGISTER DQ action_verified TABLE ${USL}.action AS ${ACTION_VERIFIED_EXPR}`);
    expect(step("update dq action_verified", steps).sql).toBe(`UPDATE DQ action_verified TABLE ${USL}.action SET NAME = action_verified, EXPRESSION = ${ACTION_VERIFIED_EXPR}`);
    expect(step("register dq cause_evidenced", steps).sql).toBe(`REGISTER DQ cause_evidenced TABLE ${USL}.cause AS cause_class = 'unknown' OR evidence_ids <> '[]'`);
    expect(step("update dq cause_evidenced", steps).sql).toBe(`UPDATE DQ cause_evidenced TABLE ${USL}.cause SET NAME = cause_evidenced, EXPRESSION = ${CAUSE_EVIDENCED_EXPR}`);
    for (const t of ["collection", "copy", "action", "cause", "adoption", "dns_live"]) expect(step(`run dq ${t}`, steps)).toMatchObject({ sql: `RUN DQ TABLE ${USL}.${t}`, dqTable: t, show: true });
    expect(step("show lightning.metastore.drift.drift_usl", steps).sql).toBe(`SHOW NAMESPACES OR TABLES IN ${USL}`);
    for (const t of FIFTEEN) expect(step(`count ${t}`, steps).sql).toBe(`SELECT COUNT(*) AS n FROM ${USL}.${t}`);
  });

  it("one statement per call except the COMPILE, no trailing semicolon, no double-quoted identifier in SQL text", () => {
    for (const s of steps) {
      expect(s.sql.trimEnd().endsWith(";")).toBe(false);
      if (!s.multi) expect(stripLiterals(s.sql)).not.toContain(";");
    }
    expect(steps.filter((s) => s.multi).map((s) => s.name)).toEqual(["compile usl drift_usl"]);
    for (const s of steps.filter((x) => /^(?:activate|count|register dq|update dq)/.test(x.name))) expect(stripLiterals(s.sql)).not.toContain('"');
  });

  it("staleness(): LOAD USL's model against the fifteen tables and their columns", () => {
    const model = (tables: Record<string, readonly string[]>) => ({ queryId: "q", columns: ["json"], rows: [[JSON.stringify({ tables: Object.entries(tables).map(([name, cols]) => ({ name, columnSpecs: cols.map((c) => ({ name: c })) })) })]], rowCount: 1, total: 1, latencyMs: 1, raw: {} });
    const current = { ...setup.USL_COLUMNS };
    const only = (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, current[n as keyof typeof current]]));
    expect(setup.staleness(model(current))).toBeNull();
    expect(setup.staleness(model(only(ELEVEN.slice(0, 4))))).toBe("4 table(s); lacks policy, copy, probe, disposition, action, ticket, cause, lesson, rule, adoption, dns_live");
    // the eleven-table USL of 25 Oct, 20:44 UTC: what the live run of 22:27 UTC removed and compiled again
    expect(setup.staleness(model(only(ELEVEN)))).toBe("11 table(s); lacks lesson, rule, adoption, dns_live");
    // the fourteen-table USL of 25 Oct, 22:27 UTC: what the live run of 26 Oct, 03:47 UTC removed and compiled again
    expect(setup.staleness(model(only(FOURTEEN)))).toBe("14 table(s); lacks dns_live");
    const { cause: _k2, ...fourteen } = current;
    expect(setup.staleness(model(fourteen))).toBe("14 table(s); lacks cause");
    expect(setup.staleness(model({ ...current, extra: ["x"] }))).toBe("16 table(s); holds extra beyond the 15");
    expect(setup.staleness(model({ ...current, policy: current.policy.filter((c) => c !== "note") }))).toBe("15 table(s); columns differ in policy");
    expect(setup.staleness(model({ ...current, cause: current.cause.map((c) => (c === "cause_class" ? "class" : c)) }))).toBe("15 table(s); columns differ in cause");
    expect(setup.staleness({ ...model(current), rows: [["not json"]] })).toBe("LOAD USL returned no model that parses");
    expect(setup.staleness({ ...model(current), rows: [] })).toBe("LOAD USL returned no model that parses");
  });

  it("reaches the Postgres at ZETARIS_PG_HOST, not DATABASE_URL's host and port; a port in it wins; the datasource name qualifies every table", () => {
    const s = setup.plan({ ...ENV, pgHost: "pg.zetaris.test:6543", datasource: "DRIFT2" });
    expect(step("create datasource DRIFT2", s).sql).toContain('jdbcurl "jdbc:postgresql://pg.zetaris.test:6543/drift"');
    expect(step("activate collection", s).sql).toContain("FROM DRIFT2.collection_run");
    expect(step("activate lesson", s).sql).toContain("FROM LESSONS.lesson");
    expect(step("register datasource tables", s).sql).toBe("REGISTER DATASOURCE TABLES FROM DRIFT2");
    for (const x of s) expect(x.sql).not.toMatch(/127\.0\.0\.1|15432/);
  });

  it("refuses what it cannot build, and says why without the URL or the password", () => {
    const bad: [Partial<typeof ENV>, RegExp][] = [
      [{ databaseUrl: "" }, /DATABASE_URL is not set/],
      [{ databaseUrl: `drift ${PW}` }, /not a URL/],
      [{ databaseUrl: `mysql://drift:${PW}@h/drift` }, /postgres/],
      [{ databaseUrl: "postgresql://drift@h/drift" }, /a user, a password and a database/],
      [{ databaseUrl: `postgresql://drift:${encodeURIComponent(`a"${PW}`)}@h/drift` }, /double quote/],
      [{ pgHost: "drift-pg; DROP" }, /ZETARIS_PG_HOST/],
      [{ datasource: "DRIFT; DROP" }, /ZETARIS_DATASOURCE/],
    ];
    for (const [patch, why] of bad) {
      let msg = "";
      try { setup.plan({ ...ENV, ...patch }); } catch (e) { msg = (e as Error).message; }
      expect(msg).toMatch(why);
      expect(msg).not.toContain(PW);
    }
  });
});

describe("uslRows() and uslMarkdown(): the semantic layer's table", () => {
  const rows = setup.uslRows();

  it("one row per entity in USL_TABLES order, each built from the tables its activation SELECT reads: DRIFT's by name, every one in sql/schema.sql; a file or REST table as <database>.<table>", () => {
    expect(rows.map((r) => r.entity)).toEqual(FIFTEEN);
    expect(Object.fromEntries(rows.map((r) => [r.entity, r.builtFrom]))).toEqual({
      collection: ["collection_run"], setting: ["observation"], referent: ["observation", "dns_record"],
      backup_copy: ["backup_item", "backup_snapshot"], policy: ["policy_rule"], copy: ["vault_copy", "copy_validation"],
      probe: ["probe"], disposition: ["disposition"], action: ["action"], ticket: ["ticket"], cause: ["finding_cause"],
      lesson: ["LESSONS.lesson"], rule: ["RULES.rule"], adoption: ["disposition", "LESSONS.lesson"],
      dns_live: ["CLOUDFLARE.zone_<zone id>", "collection_run", "dns_record"],
    });
    const files = [...setup.FILE_SOURCES.map((f) => `${f.db}.${f.table}`), "CLOUDFLARE.zone_<zone id>"];
    for (const r of rows) for (const t of r.builtFrom) expect(t.includes(".") ? files : TABLE_NAMES, `${r.entity} reads ${t}`).toContain(t);
    // the exported activation() is the one plan() sends
    for (const t of FIFTEEN) expect(step(`activate ${t}`).sql).toBe(`ACTIVATE USL TABLE ${USL}.${t} AS ${setup.activation(t as never, "DRIFT", setup.restTables(ZONES))}`);
  });

  it("an entity over more than one table says how its rows are formed, naming each table; referent is the setting-to-record join of the hero query", () => {
    for (const r of rows.filter((x) => x.builtFrom.length > 1)) for (const t of r.builtFrom) expect(r.formed, r.entity).toContain(`\`${t}\``);
    const referent = rows.find((r) => r.entity === "referent")!;
    expect(referent.builtFrom).toEqual(["observation", "dns_record"]);
    expect(setup.activation("referent", "DRIFT")).toContain("JOIN DRIFT.dns_record d ON d.tenant_id = o.tenant_id AND d.name = o.refers_to_id WHERE o.refers_to_type = 'dns_name'");
    expect(referent.formed).toContain("FOUND-BUT-DIFFERENT");
  });

  it("each key is the DDL's: one primary key column per entity, each foreign key naming a column of another entity", () => {
    for (const r of rows) {
      expect(setup.USL_COLUMNS[r.entity][0], r.entity).toBe(r.primaryKey);
      expect(setup.COMPILE_USL).toContain(`  ${r.primaryKey} varchar(`);
      for (const f of r.foreignKeys) {
        const [, entity, column] = /^(\w+)\((\w+)\)$/.exec(f.references)!;
        expect(FIFTEEN, `${r.entity}.${f.column}`).toContain(entity);
        expect(setup.USL_COLUMNS[entity as never], `${r.entity}.${f.column}`).toContain(column);
        expect(setup.USL_COLUMNS[r.entity]).toContain(f.column);
      }
    }
    expect(rows.find((r) => r.entity === "action")!.foreignKeys).toEqual([{ column: "disposition_id", references: "disposition(disposition_id)" }]);
    expect(rows.find((r) => r.entity === "cause")).toMatchObject({ primaryKey: "cause_id", foreignKeys: [{ column: "disposition_id", references: "disposition(disposition_id)" }], formed: "`class` as `cause_class`" });
    // the key across the two datasources: an adoption's lesson is a LESSONS row
    expect(rows.find((r) => r.entity === "adoption")).toMatchObject({ primaryKey: "disposition_id", foreignKeys: [{ column: "lesson_id", references: "lesson(lesson_id)" }] });
    // and the live records' run is a collection row
    expect(rows.find((r) => r.entity === "dns_live")).toMatchObject({ primaryKey: "record_id", foreignKeys: [{ column: "run_id", references: "collection(run_id)" }] });
  });

  it("six entities carry a DQ rule, each the rule of DQ_RULES byte for byte; the markdown prints each expression in inline code, one table row per entity, no number measured and no date", () => {
    const ruled = rows.filter((r) => r.rule);
    expect(ruled.map((r) => [r.entity, r.rule!.name])).toEqual([["collection", "run_complete"], ["copy", "copy_validated"], ["action", "action_verified"], ["cause", "cause_evidenced"], ["adoption", "exception_in_force"], ["dns_live", "dns_inventory_current"]]);
    for (const r of ruled) expect(r.rule!.expression).toBe(setup.DQ_RULES.find((d) => d.name === r.rule!.name)!.expression);
    expect(ruled.map((r) => r.rule!.expression)).toEqual([RUN_COMPLETE_EXPR, "validated = 1", ACTION_VERIFIED_EXPR, CAUSE_EVIDENCED_EXPR, EXCEPTION_IN_FORCE_EXPR, DNS_EXPR]);
    const md = setup.uslMarkdown();
    const table = md.split("\n").filter((l) => l.startsWith("|"));
    expect(table).toHaveLength(2 + FIFTEEN.length);
    expect(table[0]).toBe("| entity | built from | key | DQ rule | expression |");
    for (const [i, r] of rows.entries()) {
      expect(table[i + 2].startsWith(`| \`${r.entity}\` |`), r.entity).toBe(true);
      if (r.rule) expect(table[i + 2].endsWith(`| \`${r.rule.name}\` | \`${r.rule.expression}\` |`), r.entity).toBe(true);
      else expect(table[i + 2].endsWith("|  |  |"), r.entity).toBe(true);
    }
    expect(md).toContain("`drift_usl` in `lightning.metastore.drift`");
    expect(md).toContain("over four datasources: `DRIFT`, the app Postgres; `LESSONS`, the technician's memory store; `RULES`, the policy file; `CLOUDFLARE`, the Cloudflare DNS API, which Zetaris reads itself at each query.");
    expect(md).toContain("It holds 15 entities, ");
    expect(md).toContain(", and 6 DQ rules, ");
    expect(md).not.toMatch(/\b20\d\d\b|\bOct\b|\d+ of \d+/);
    expect(md.endsWith("|\n")).toBe(true);
  });
});

describe("cause_evidenced", () => {
  it("compares plain columns only (no function call, which pushdown can drop) and passes unknown and every cause that names an evidence id", async () => {
    expect(CAUSE_EVIDENCED_EXPR).not.toMatch(/\w\s*\(/);
    for (const c of setup.USL_COLUMNS.cause) if (CAUSE_EVIDENCED_EXPR.includes(c)) expect(["cause_class", "evidence_ids"]).toContain(c);
    const { SqlJsEngine } = await import("../src/data/engines/sqljs.ts");
    const lite = await SqlJsEngine.create();
    const rows = [["unknown", "[]", "1"], ["unknown", '["evt-1"]', "1"], ["operator_edit", '["evt-1","act-2"]', "1"], ["operator_edit", "[]", "0"], ["agent", "[]", "0"], ["account_change", '["evt-3"]', "1"]];
    const values = rows.map(([k, e]) => `SELECT '${k}' AS cause_class, '${e}' AS evidence_ids`).join(" UNION ALL ");
    const r = await lite.run(`SELECT cause_class, evidence_ids, CASE WHEN ${CAUSE_EVIDENCED_EXPR} THEN '1' ELSE '0' END AS valid FROM (${values}) c`);
    expect(r.rows).toEqual(rows);
    lite.close();
  });
});

describe("exception_in_force", () => {
  it("compares plain columns only (no function call, which pushdown can drop): in force when the lesson is held, an exception, taught by the decision and expiring after it", async () => {
    expect(EXCEPTION_IN_FORCE_EXPR).not.toMatch(/\w\s*\(/);
    for (const c of setup.USL_COLUMNS.adoption) if (EXCEPTION_IN_FORCE_EXPR.includes(c)) expect(["lesson_id", "lesson_kind", "lesson_recorded_at", "decided_at", "lesson_expires_at"]).toContain(c);
    const { SqlJsEngine } = await import("../src/data/engines/sqljs.ts");
    const lite = await SqlJsEngine.create();
    const T0 = "2026-10-25T14:17:01.545Z", AT = "2026-10-25T21:12:42.005Z", EXP = "2026-11-30T00:00:00.000Z";
    const rows: [string | null, string | null, string | null, string, string | null, string][] = [
      ["mem-1", "exception", T0, AT, EXP, "1"],
      [null, null, null, AT, null, "0"], // the reason names a lesson the store lacks
      ["mem-1", "exception", T0, EXP, EXP, "0"], // decided at the expiry: lapsed
      ["mem-1", "exception", T0, "2026-12-01T00:00:00.000Z", EXP, "0"],
      ["mem-1", "exception", AT, T0, EXP, "0"], // decided before the lesson was taught
      ["mem-1", "exception", AT, AT, EXP, "1"], // taught at the decision instant
      ["mem-2", "answer", T0, AT, EXP, "0"],
    ];
    const lit = (v: string | null) => (v === null ? "NULL" : `'${v}'`);
    const values = rows.map(([id, k, rec, at, exp]) => `SELECT ${lit(id)} AS lesson_id, ${lit(k)} AS lesson_kind, ${lit(rec)} AS lesson_recorded_at, '${at}' AS decided_at, ${lit(exp)} AS lesson_expires_at`).join(" UNION ALL ");
    const r = await lite.run(`SELECT CASE WHEN ${EXCEPTION_IN_FORCE_EXPR} THEN '1' ELSE '0' END AS valid FROM (${values}) a`);
    expect(r.rows.map((x) => x[0])).toEqual(rows.map((x) => x[5]));
    lite.close();
  });
});

describe("dns_inventory_current", () => {
  it("compares plain columns only (no function call, which pushdown can drop): holds when the last complete DNS run has the record with the type and proxied flag the DNS API returns now", async () => {
    expect(DNS_EXPR).not.toMatch(/\w\s*\(/);
    expect(setup.DNS_INVENTORY_CURRENT).toBe(DNS_EXPR);
    for (const c of setup.USL_COLUMNS.dns_live) if (DNS_EXPR.includes(c)) expect(["live_type", "live_proxied", "held_type", "held_proxied"]).toContain(c);
    const { SqlJsEngine } = await import("../src/data/engines/sqljs.ts");
    const lite = await SqlJsEngine.create();
    // live_type, live_proxied, held_type, held_proxied (as the activation forms them), valid
    const rows: [string, number, string, number, string][] = [
      ["A", 1, "A", 1, "1"],
      ["CNAME", 0, "CNAME", 0, "1"],
      ["TXT", -1, "TXT", -1, "1"], // the flag absent on both sides
      ["A", 1, "", -1, "0"], // created at the provider since the run
      ["A", 1, "CNAME", 1, "0"], // the type changed
      ["A", 0, "A", 1, "0"], // proxied turned off
      ["A", 1, "A", -1, "0"], // the run held no flag
    ];
    const values = rows.map(([lt, lp, ht, hp]) => `SELECT '${lt}' AS live_type, ${lp} AS live_proxied, '${ht}' AS held_type, ${hp} AS held_proxied`).join(" UNION ALL ");
    const r = await lite.run(`SELECT CASE WHEN ${DNS_EXPR} THEN '1' ELSE '0' END AS valid FROM (${values}) d`);
    expect(r.rows.map((x) => x[0])).toEqual(rows.map((x) => x[4]));
    lite.close();
  });
});

describe("the filestore copy", () => {
  it("runs docker through wsl.exe -e on Windows (argv as given, no bash) and docker itself elsewhere", () => {
    const t = { container: "zetaris-driver-1", distro: "Ubuntu-24.04" };
    expect(dockerArgv(["exec", "-i", "c", "sh", "-c", "cat > /x"], t, "win32")).toEqual(["wsl.exe", "-d", "Ubuntu-24.04", "-e", "docker", "exec", "-i", "c", "sh", "-c", "cat > /x"]);
    expect(dockerArgv(["ps"], t, "linux")).toEqual(["docker", "ps"]);
  });

  it("refuses a file name, a container or a distribution outside the plain set before docker starts", () => {
    const t = { container: "zetaris-driver-1", distro: "Ubuntu-24.04" };
    expect(() => putFiles({ "../x.json": "[]" }, t)).toThrow(/file name/);
    expect(() => putFiles({ "a.json; rm -rf /": "[]" }, t)).toThrow(/file name/);
    expect(() => putFiles({ "a.json": "[]" }, { ...t, container: "c; rm" })).toThrow(/ZETARIS_DRIVER_CONTAINER/);
    expect(() => putFiles({ "a.json": "[]" }, { ...t, distro: "U b" })).toThrow(/ZETARIS_WSL_DISTRO/);
  });
});

describe("the password and the token never appear", () => {
  it("in plan() output, serialised or printed by --plan, from an explicit env or the process env", () => {
    expect(setup.envFromProcess().cloudflareToken).toBe(TOKEN);
    for (const steps of [setup.plan(ENV), setup.plan({ ...setup.envFromProcess(), zones: ZONES })]) {
      for (const secret of [PW, TOKEN]) expect(JSON.stringify(steps)).not.toContain(secret);
      const printed = setup.formatPlan(steps, "DRIFT").join("\n");
      for (const secret of [PW, TOKEN]) expect(printed).not.toContain(secret);
      expect(printed).toContain('password "<redacted>"');
      expect(printed).toContain('HEADER (Authorization "Bearer <redacted>") BODY ()');
      expect(printed).toContain("02 create datasource DRIFT  (only when DRIFT is absent)");
    }
  });

  it("in redact()ed strings: the token after Bearer, as a REST table's header carries it", () => {
    const stmt = step(`create CLOUDFLARE.zone_${ZB}`).secret!();
    expect(stmt).toContain(TOKEN);
    expect(redact(stmt)).toBe(restPrinted(`zone_${ZB}`, REST[2][1]));
    expect(redact(`Zetaris 400: request failed with header Authorization: Bearer ${TOKEN}`)).not.toContain(TOKEN.slice(0, 8));
  });

  it("in redact()ed strings: the option form, cut mid-value, JSON, single quotes, key=value, URL userinfo, an escaped quote", () => {
    const stmt = step("create datasource DRIFT").secret!();
    const cases = [
      stmt,
      stmt.slice(0, stmt.indexOf(PW) + 6),
      `Zetaris 500: {"message":"cannot connect","password": "${PW}"}`,
      `options (password '${PW}')`,
      `jdbc:postgresql://drift-pg:5432/drift?user=drift&password=${PW}&ssl=false`,
      `connect ${DB_URL} failed`,
      `password "a\\"${PW}"`,
    ];
    for (const c of cases) {
      expect(c).toContain(PW.slice(0, 6));
      const r = redact(c);
      expect(r).not.toContain(PW.slice(0, 6));
      expect(redact(r)).toBe(r);
    }
    expect(redact(stmt)).toBe(CREATE_PRINTED);
    for (const kept of ["PasswordAuthentication no", "password authentication failed for user drift", 'jdbcurl "jdbc:postgresql://drift-pg:5432/drift"']) expect(redact(kept)).toBe(kept);
  });
});

function result(columns: string[], rows: string[][]): QueryResult {
  return { queryId: `q-${columns.join("-")}`, columns, rows, rowCount: rows.length, total: rows.length, latencyMs: 1, raw: {} };
}

/** A client that answers from a function of the SQL and records every call. */
class Scripted {
  calls: { sql: string; opts: { allowMultiStatement?: boolean } }[] = [];
  constructor(private readonly answer: (sql: string) => QueryResult | Error) {}
  async query(sql: string, opts: { allowMultiStatement?: boolean } = {}): Promise<QueryResult> {
    this.calls.push({ sql, opts });
    const a = this.answer(sql);
    if (a instanceof Error) throw a;
    return a;
  }
}

const DQ_COLS = ["name", "table", "type", "total_record", "valid_record", "invalid_record"];
const DQ_ROWS = [["run_complete", "collection", "Custom Data Quality", "4", "4", "0"], ["run_id", "collection", "Primary Key Constraint", "4", "4", "0"]];
const DQ_COPY_ROWS = [["copy_validated", "copy", "Custom Data Quality", "0", "0", "0"], ["copy_id", "copy", "Primary Key Constraint", "0", "0", "0"]];
const LIST_COLS = ["name", "table", "type", "expression"];
const CONSTRAINTS = [["run_id", "collection", "Primary key constraints", ""], ["copy_id", "copy", "Primary key constraints", ""], ["action_id", "action", "Primary key constraints", ""]];
const STATED = setup.DQ_RULES.map((r) => [r.name, r.table, "Custom Data Quality", r.expression]);
const SCHEMA_TABLES_LISTED = TABLE_NAMES.map((t) => [t, "Table", t, "", "", "", "840", "1"]);
const model = (tables: Record<string, readonly string[]>) => result(["json"], [[JSON.stringify({ name: "drift_usl", tables: Object.entries(tables).map(([name, cols]) => ({ name, columnSpecs: cols.map((c) => ({ name: c })) })) })]]);
const CURRENT_MODEL = { ...setup.USL_COLUMNS };
const FOUR_TABLE_MODEL = { collection: setup.USL_COLUMNS.collection, setting: setup.USL_COLUMNS.setting, referent: setup.USL_COLUMNS.referent, backup_copy: setup.USL_COLUMNS.backup_copy };
const ELEVEN_TABLE_MODEL = Object.fromEntries(ELEVEN.map((t) => [t, setup.USL_COLUMNS[t as keyof typeof setup.USL_COLUMNS]]));
/** SHOW LIGHTNING DATABASES as measured 25 Oct 2026: RULES comes back lower-cased; CLOUDFLARE as measured 26 Oct 2026. */
const LIGHTNING_DBS_LISTED = [["LESSONS", "drift-agent technician memory store, the Meterless H-MEM lessons and ledger", "3966"], ["rules", "drift-agent policy file, one row per rule", "4010"], ["CLOUDFLARE", "Cloudflare DNS API, the records of each zone live at the provider", "5480"]];
const LT_COLS = ["name", "materialized_table", "source_table", "table_type", "format", "id"];
const lightningTables = (rows: [string, string][]) => result(LT_COLS, rows.map(([name, file], i) => [name, "", `${DIR}/${file}`, "filestore", "json", String(3967 + i)]));
/** SHOW LIGHTNING TABLES CLOUDFLARE as measured 26 Oct 2026: the endpoint as source_table, table_type rest, no format. */
const restTablesListed = (rows: readonly [string, string][]) => result(LT_COLS, rows.map(([name, endpoint], i) => [name, "", endpoint, "rest", "", String(5481 + i)]));
/** DESCRIBE DATASOURCE TABLE of a JSON file table: its columns as Spark infers them, sorted by name. */
const described = (cols: readonly string[]) => result(["col_name", "data_type", "comment", "description", "tags"], [...cols].sort().map((c) => [c, '"string"', "", "", ""]));
const FILES = { "ledger.json": '[{"memoryId":"mem-1"}]', "lessons.json": '[{"lesson_id":"mem-1"}]', "rules.json": '[{"rule_id":"rule-1"}]' };

/** The instance as it stands after the live run of 26 Oct, 03:47 UTC: DRIFT with every schema table, LESSONS and RULES with their tables over the filestore, CLOUDFLARE with a REST table per zone and page, the fifteen-table USL, the six rules as stated. */
function configured(sql: string): QueryResult | Error {
  if (sql === "SHOW DATASOURCES") return result(["name", "description"], [["DRIFT", "drift-agent app Postgres on the zetaris network"]]);
  if (sql === "SHOW DATASOURCE TABLES DRIFT") return result(["name", "relation", "source_table", "partition clause", "description", "materialized table", "datasource_id", "relation_id"], SCHEMA_TABLES_LISTED);
  if (sql === "SHOW LIGHTNING DATABASES") return result(["name", "description", "id"], LIGHTNING_DBS_LISTED);
  if (sql === "SHOW LIGHTNING TABLES LESSONS") return lightningTables([["ledger", "ledger.json"], ["lesson", "lessons.json"]]);
  if (sql === "SHOW LIGHTNING TABLES RULES") return lightningTables([["rule", "rules.json"]]);
  if (sql === "SHOW LIGHTNING TABLES CLOUDFLARE") return restTablesListed(REST);
  if (sql === "DESCRIBE DATASOURCE TABLE LESSONS.lesson") return described(fileTableDef("lesson")!.columns);
  if (sql === "DESCRIBE DATASOURCE TABLE RULES.rule") return described(fileTableDef("rule")!.columns);
  if (sql === "SHOW NAMESPACES OR TABLES IN lightning.metastore.drift") return result(["name", "type", "usl_id", "count", "activated"], [["drift_usl", "usl", "3954", "15", ""]]);
  if (sql === `SHOW NAMESPACES OR TABLES IN ${USL}`) return result(["name", "type", "usl_id", "count", "activated"], FIFTEEN.map((t) => [t, "table", "", "0", "true"]));
  if (sql.startsWith("LOAD USL")) return model(CURRENT_MODEL);
  if (sql.startsWith("REMOVE USL")) return result(["removed"], [["true"]]);
  if (sql.startsWith("COMPILE USL")) return result(["json"], [['{"name":"drift_usl"}']]);
  if (sql.startsWith("ACTIVATE")) return result(["registered"], [['{"name":"x"}']]);
  if (sql.startsWith("LIST DQ USL")) return result(LIST_COLS, [...CONSTRAINTS, ...STATED]);
  if (sql === `RUN DQ TABLE ${USL}.collection`) return result(DQ_COLS, DQ_ROWS);
  if (sql.startsWith("RUN DQ")) return result(DQ_COLS, DQ_COPY_ROWS);
  if (sql.startsWith("SELECT COUNT(*)")) return result(["n"], [["12"]]);
  return result([], []);
}

/** The files are fixed and the copy recorded: no docker, no store and no policy file is read. */
async function run(answer: (sql: string) => QueryResult | Error, put?: (files: Readonly<Record<string, string>>) => { path: string; bytes: number }[]) {
  const client = new Scripted(answer);
  const tracer = new MemTracer("t_setup", { model: "none" });
  const out: string[] = [];
  const puts: Readonly<Record<string, string>>[] = [];
  const r = await setup.apply({
    client, tracer, out: (l) => out.push(l), env: ENV, files: () => FILES,
    put: put ?? ((files) => { puts.push(files); return Object.entries(files).map(([n, t]) => ({ path: `${DIR}/${n}`, bytes: Buffer.byteLength(t) })); }),
  });
  return { r, client, tracer, out, puts, status: Object.fromEntries(r.results.map((x) => [x.name, x.status])) };
}
const FILE_SKIPS = ["drop LESSONS.ledger", "create LESSONS.ledger", "drop LESSONS.lesson", "create LESSONS.lesson", "drop RULES.rule", "create RULES.rule"];
const REST_SKIPS = ["create lightning database CLOUDFLARE", ...REST.flatMap(([t]) => [`drop CLOUDFLARE.${t}`, `create CLOUDFLARE.${t}`])];

const skippedOf = (status: Record<string, string>) => Object.entries(status).filter(([, s]) => s === "skipped").map(([n]) => n);
const sent = (client: Scripted, re: RegExp) => client.calls.map((c) => c.sql).filter((s) => re.test(s));

describe("apply()", () => {
  it("against an instance already set up: the files copied again, a no-op otherwise, the file and REST tables, the USL and its rules kept, RUN DQ printed for six tables", async () => {
    const { r, client, tracer, out, puts, status } = await run(configured);
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(84);
    expect(skippedOf(status)).toEqual([
      "create datasource DRIFT", "register datasource tables", "create lightning database LESSONS", "create lightning database RULES", ...FILE_SKIPS, ...REST_SKIPS,
      "remove usl drift_usl", "compile usl drift_usl", ...RULES.flatMap((n) => [`register dq ${n}`, `update dq ${n}`]),
    ]);
    expect(r.results.every((x) => x.status === "ok" || x.status === "skipped")).toBe(true);
    expect(sent(client, /^(?:CREATE DATASOURCE|REGISTER DATASOURCE|CREATE LIGHTNING|DROP LIGHTNING|REMOVE USL|COMPILE USL|REGISTER DQ|UPDATE DQ)/)).toEqual([]);
    expect(client.calls.filter((c) => c.opts.allowMultiStatement)).toEqual([]);
    expect(sent(client, /^ACTIVATE/)).toHaveLength(15);
    // every run writes the three files: a file table re-reads its file on every query (measured 25 Oct 2026)
    expect(puts).toEqual([FILES]);
    expect(r.dq?.rows).toEqual(DQ_ROWS);
    expect(Object.keys(r.dqRuns)).toEqual(["collection", "copy", "action", "cause", "adoption", "dns_live"]);
    expect(out).toContain("     name | table | type | total_record | valid_record | invalid_record");
    expect(out).toContain("     run_complete | collection | Custom Data Quality | 4 | 4 | 0");
    expect(out.find((l) => l.includes("01 show datasources"))).toMatch(/^ok\s+01 show datasources\s+1 row, DRIFT listed {2}\(\d+ ms\)$/);
    expect(out.find((l) => l.includes("02 create datasource DRIFT"))).toMatch(/^skipped 02 create datasource DRIFT\s+DRIFT exists$/);
    expect(out.find((l) => l.includes("03 list datasource tables"))).toMatch(new RegExp(`^ok\\s+03 list datasource tables\\s+${TABLE_NAMES.length} rows, all ${TABLE_NAMES.length} schema tables registered {2}\\(\\d+ ms\\)$`));
    expect(out.find((l) => l.includes("06 copy files"))).toMatch(/^ok\s+06 copy files to the filestore\s+ledger\.json 22 bytes, lessons\.json 23 bytes, rules\.json 22 bytes {2}\(\d+ ms\)$/);
    expect(out.find((l) => l.includes("07 show lightning databases"))).toMatch(/^ok\s+07 show lightning databases\s+3 rows, LESSONS listed, RULES listed, CLOUDFLARE listed {2}\(\d+ ms\)$/);
    expect(out.find((l) => l.includes("08 create lightning database LESSONS"))).toMatch(/^skipped 08 create lightning database LESSONS\s+LESSONS exists$/);
    expect(out.find((l) => l.includes("10 list LESSONS tables"))).toMatch(/^ok\s+10 list LESSONS tables\s+2 rows, ledger listed, lesson listed {2}\(\d+ ms\)$/);
    expect(out.find((l) => l.includes("14 describe LESSONS.lesson"))).toMatch(/^ok\s+14 describe LESSONS\.lesson\s+9 rows, the 9 columns {2}\(\d+ ms\)$/);
    expect(out.find((l) => l.includes("16 create LESSONS.lesson"))).toMatch(/^skipped 16 create LESSONS\.lesson\s+LESSONS\.lesson listed as stated$/);
    expect(out.find((l) => l.includes("21 list CLOUDFLARE tables"))).toMatch(/^ok\s+21 list CLOUDFLARE tables\s+3 rows, 3 of 3 REST tables listed over their endpoint {2}\(\d+ ms\)$/);
    expect(out.find((l) => l.includes(`23 create CLOUDFLARE.zone_${ZA}`))).toBe(`skipped 23 create CLOUDFLARE.zone_${ZA} CLOUDFLARE.zone_${ZA} listed over its endpoint`);
    expect(out.find((l) => l.includes("31 load usl drift_usl"))).toMatch(/^ok\s+31 load usl drift_usl\s+15 tables as compiled {2}\(\d+ ms\)$/);
    expect(out.find((l) => l.includes("32 remove usl"))).toMatch(/^skipped 32 remove usl drift_usl\s+drift_usl holds the 15 tables as compiled$/);
    expect(out.find((l) => l.includes("49 list dq rules"))).toMatch(/^ok\s+49 list dq rules\s+9 rows, run_complete listed, copy_validated listed, action_verified listed, cause_evidenced listed, exception_in_force listed, dns_inventory_current listed {2}\(\d+ ms\)$/);
    expect(out.find((l) => l.includes("51 update dq run_complete"))).toMatch(/^skipped 51 update dq run_complete\s+run_complete listed as stated$/);
    expect(out.find((l) => l.includes("59 update dq exception_in_force"))).toMatch(/^skipped 59 update dq exception_in_force\s+exception_in_force listed as stated$/);
    expect(out.find((l) => l.includes("61 update dq dns_inventory_current"))).toMatch(/^skipped 61 update dq dns_inventory_current\s+dns_inventory_current listed as stated$/);
    expect(out.find((l) => l.includes("69 count collection"))).toMatch(/^ok\s+69 count collection\s+= 12 {2}\(\d+ ms\)$/);
    expect(out.find((l) => l.includes("83 count dns_live"))).toMatch(/^ok\s+83 count dns_live\s+= 12, the zones report 603 {2}\(\d+ ms\)$/);
    expect(out.find((l) => l.includes("84 count LESSONS.ledger"))).toMatch(/^ok\s+84 count LESSONS\.ledger\s+= 12 {2}\(\d+ ms\)$/);
    // the live re-run of 26 Oct 2026, 03:48 UTC over six zones: 90 steps, 53 ok, 37 skipped, 0 failed, 38.1 s; here three REST tables
    expect(out.at(-1)).toMatch(/^ZETARIS SETUP: 84 statements, 53 ok, 31 skipped, 0 failed, \d+\.\d s$/);
    // env carries the zones, so no zone read: one trace line per statement
    expect(out.some((l) => l.includes("00 read the Cloudflare zones"))).toBe(false);
    expect(tracer.events).toHaveLength(84);
    // every statement is a query on zetaris; the copy reads the sources and names no engine
    const copyAt = r.results.findIndex((x) => x.name === "copy files to the filestore");
    expect(tracer.events[copyAt]).toMatchObject({ agent: "zetaris-setup", action: "observe", status: "ok", input_summary: expect.stringContaining("docker exec -i") });
    expect(tracer.events[copyAt].engine).toBeUndefined();
    expect(tracer.events.filter((_, i) => i !== copyAt).every((e) => e.agent === "zetaris-setup" && e.action === "query" && e.engine === "zetaris" && e.model_requested === "none")).toBe(true);
    expect(tracer.events[1]).toMatchObject({ status: "skipped", input_summary: "CREATE DATASOURCE DRIFT (credentials redacted)", output_summary: "DRIFT exists" });
  });

  it("against the four-table USL and the eight-table datasource of 24 Oct: REGISTER the new tables, REMOVE USL, COMPILE the fifteen, register the six rules", async () => {
    const { r, client, status, out } = await run((sql) => {
      if (sql === "SHOW DATASOURCE TABLES DRIFT") return result(["name"], SCHEMA_TABLES_LISTED.slice(0, 8).map((row) => [row[0]]));
      if (sql.startsWith("LOAD USL")) return model(FOUR_TABLE_MODEL);
      if (sql.startsWith("LIST DQ USL")) return result(LIST_COLS, CONSTRAINTS);
      return configured(sql);
    });
    expect(r.ok).toBe(true);
    expect(status).toMatchObject({
      "list datasource tables": "ok", "register datasource tables": "ok", "refresh datasource tables": "skipped",
      "load usl drift_usl": "ok", "remove usl drift_usl": "ok", "compile usl drift_usl": "ok",
      "register dq run_complete": "ok", "update dq run_complete": "skipped", "register dq copy_validated": "ok", "register dq action_verified": "ok",
      "register dq cause_evidenced": "ok", "update dq cause_evidenced": "skipped",
    });
    expect(out.find((l) => l.includes("03 list datasource tables"))).toContain(`${TABLE_NAMES.length - 8} of ${TABLE_NAMES.length} schema tables unregistered: ${TABLE_NAMES.slice(8).join(", ")}`);
    expect(out.find((l) => l.includes("31 load usl drift_usl"))).toContain("stale: 4 table(s); lacks policy, copy, probe, disposition, action, ticket, cause, lesson, rule, adoption, dns_live");
    const order = client.calls.map((c) => c.sql.split(/\s+/).slice(0, 2).join(" "));
    expect(order.indexOf("REMOVE USL")).toBeLessThan(order.indexOf("COMPILE USL"));
    expect(order.indexOf("COMPILE USL")).toBeLessThan(order.indexOf("ACTIVATE USL"));
    expect(client.calls.filter((c) => c.opts.allowMultiStatement).map((c) => c.sql)).toEqual([setup.COMPILE_USL]);
    expect(sent(client, /^REGISTER DQ/)).toEqual(setup.DQ_RULES.map((d) => `REGISTER DQ ${d.name} TABLE ${USL}.${d.table} AS ${d.expression}`));
    expect(out.at(-1)).toMatch(/^ZETARIS SETUP: 84 statements, 61 ok, 23 skipped, 0 failed/);
  });

  it("against the fourteen-table USL of 25 Oct, 22:27 UTC and no CLOUDFLARE database: create it and its REST tables with the token, REMOVE USL, COMPILE the fifteen, register all six, as the live run of 26 Oct, 03:47 UTC did", async () => {
    const fourteen = Object.fromEntries(FOURTEEN.map((t) => [t, setup.USL_COLUMNS[t as keyof typeof setup.USL_COLUMNS]]));
    const { r, client, tracer, out, status } = await run((sql) => {
      if (sql === "SHOW LIGHTNING DATABASES") return result(["name", "description", "id"], LIGHTNING_DBS_LISTED.slice(0, 2));
      if (sql === "SHOW LIGHTNING TABLES CLOUDFLARE") return result(LT_COLS, []);
      if (sql.startsWith("LOAD USL")) return model(fourteen);
      if (sql.startsWith("LIST DQ USL")) return result(LIST_COLS, CONSTRAINTS);
      return configured(sql);
    });
    expect(r.ok).toBe(true);
    expect(out.find((l) => l.includes("07 show lightning databases"))).toContain("2 rows, LESSONS listed, RULES listed, CLOUDFLARE not listed");
    expect(out.find((l) => l.includes("21 list CLOUDFLARE tables"))).toContain("0 rows, 0 of 3 REST tables listed over their endpoint");
    expect(out.find((l) => l.includes("31 load usl drift_usl"))).toContain("stale: 14 table(s); lacks dns_live");
    expect(status).toMatchObject({
      "create lightning database CLOUDFLARE": "ok", "remove usl drift_usl": "ok", "compile usl drift_usl": "ok", "activate dns_live": "ok",
      "register dq dns_inventory_current": "ok", "update dq dns_inventory_current": "skipped", "run dq dns_live": "ok",
    });
    for (const [t] of REST) expect(status).toMatchObject({ [`drop CLOUDFLARE.${t}`]: "skipped", [`create CLOUDFLARE.${t}`]: "ok" });
    // the token goes to Zetaris in the CREATE, and nowhere else: not in what is printed, not in the trace
    expect(sent(client, /^CREATE LIGHTNING/)).toEqual([
      'CREATE LIGHTNING DATABASE CLOUDFLARE DESCRIBE BY "Cloudflare DNS API, the records of each zone live at the provider"',
      ...REST.map(([t, e]) => restPrinted(t, e).replace("<redacted>", TOKEN)),
    ]);
    expect(tracer.events.filter((e) => e.input_summary?.startsWith("CREATE LIGHTNING REST TABLE")).map((e) => e.input_summary)).toEqual(REST.map(([t]) => `CREATE LIGHTNING REST TABLE ${t} FROM CLOUDFLARE (token redacted)`));
    expect(JSON.stringify(tracer.events)).not.toContain(TOKEN);
    expect(out.join("\n")).not.toContain(TOKEN);
    expect(sent(client, /^REGISTER DQ dns_inventory_current/)).toEqual([`REGISTER DQ dns_inventory_current TABLE ${USL}.dns_live AS ${DNS_EXPR}`]);
    // the live run of 26 Oct 2026, 03:47 UTC over six zones: 90 steps, 68 ok, 22 skipped, 0 failed, 44.4 s; here three REST tables
    expect(out.at(-1)).toMatch(/^ZETARIS SETUP: 84 statements, 65 ok, 19 skipped, 0 failed/);
  });

  it("a REST table listed over another endpoint is dropped and created again; the others are kept", async () => {
    const { r, client, status, out } = await run((sql) => {
      if (sql === "SHOW LIGHTNING TABLES CLOUDFLARE") return restTablesListed([[REST[0][0], REST[0][1].replace("per_page=500", "per_page=100")], REST[1], REST[2]]);
      return configured(sql);
    });
    expect(r.ok).toBe(true);
    expect(out.find((l) => l.includes("21 list CLOUDFLARE tables"))).toContain("3 rows, 2 of 3 REST tables listed over their endpoint, 1 over another");
    expect(status).toMatchObject({ [`drop CLOUDFLARE.${REST[0][0]}`]: "ok", [`create CLOUDFLARE.${REST[0][0]}`]: "ok", [`drop CLOUDFLARE.${REST[1][0]}`]: "skipped", [`create CLOUDFLARE.${REST[1][0]}`]: "skipped" });
    expect(sent(client, /^(?:DROP|CREATE) LIGHTNING/)).toEqual([`DROP LIGHTNING DATABASE TABLE CLOUDFLARE.${REST[0][0]}`, restPrinted(REST[0][0], REST[0][1]).replace("<redacted>", TOKEN)]);
  });

  it("an error that echoes the token is scrubbed of it everywhere it is written", async () => {
    const { r, tracer, out } = await run((sql) => {
      if (sql === "SHOW LIGHTNING TABLES CLOUDFLARE") return result(LT_COLS, []);
      if (sql.startsWith("CREATE LIGHTNING REST TABLE")) return new Error(`REST API call failed: 403 for ${sql}; token=${TOKEN}`);
      return configured(sql);
    });
    expect(r.ok).toBe(false);
    expect(r.results.at(-1)).toMatchObject({ name: `create CLOUDFLARE.zone_${ZA}`, status: "failed" });
    expect(r.error).toContain("REST API call failed: 403");
    expect(r.error).not.toContain(TOKEN);
    expect(tracer.events.at(-1)).toMatchObject({ status: "failed", input_summary: `CREATE LIGHTNING REST TABLE zone_${ZA} FROM CLOUDFLARE (token redacted)` });
    expect(JSON.stringify(tracer.events)).not.toContain(TOKEN);
    expect(out.join("\n")).not.toContain(TOKEN);
  });

  it("with no zones in env, reads them first (one line 00 and one trace line), then plans one REST table per zone and page; a failed read stops before any statement", async () => {
    const client = new Scripted(configured);
    const out: string[] = [];
    const tracer = new MemTracer("t_zones", { model: "none" });
    const asked: string[] = [];
    const { zones: _z, ...noZones } = ENV;
    const r = await setup.apply({ client, tracer, out: (l) => out.push(l), env: noZones, files: () => FILES, put: (f) => Object.entries(f).map(([n, t]) => ({ path: `${DIR}/${n}`, bytes: Buffer.byteLength(t) })), zones: async (token) => { asked.push(token); return ZONES; } });
    expect(r.ok).toBe(true);
    expect(asked).toEqual([TOKEN]);
    expect(out[0]).toMatch(/^ok {6}00 read the Cloudflare zones {17}3 zone\(s\) the token sees, 603 record\(s\), 3 REST table\(s\) of 500 records a page {2}\(\d+ ms\)$/);
    expect(tracer.events[0]).toMatchObject({ agent: "zetaris-setup", action: "observe", status: "ok", input_summary: "Cloudflare GET /zones and each zone's record count" });
    expect(tracer.events[0].engine).toBeUndefined();
    expect(r.results).toHaveLength(84);

    const failed = new Scripted(configured);
    const lines: string[] = [];
    const f = await setup.apply({ client: failed, out: (l) => lines.push(l), env: noZones, files: () => FILES, put: () => [], zones: async () => { throw new Error(`Cloudflare 403 GET /zones: 9109: Invalid access token (Bearer ${TOKEN})`); } });
    expect(f.ok).toBe(false);
    expect(failed.calls).toEqual([]);
    expect(lines.at(-1)).toMatch(/^ZETARIS SETUP FAILED reading the Cloudflare zones after \d+ ms: Cloudflare 403 GET \/zones: 9109: Invalid access token \(Bearer <redacted>\)$/);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("against the eleven-table USL of 25 Oct, 20:44 UTC, the ledger table over its newline-delimited file: DROP and CREATE the ledger, REMOVE USL, COMPILE the fifteen, register all six, as the live run of 25 Oct, 22:27 UTC did for its fourteen", async () => {
    const { r, client, status, out } = await run((sql) => {
      if (sql === "SHOW LIGHTNING TABLES LESSONS") return lightningTables([["ledger", "ledger.jsonl"], ["lesson", "lessons.json"]]);
      if (sql.startsWith("LOAD USL")) return model(ELEVEN_TABLE_MODEL);
      // COMPILE leaves no custom rule registered (measured 25 Oct, 01:16, 20:44 and 22:27 UTC)
      if (sql.startsWith("LIST DQ USL")) return result(LIST_COLS, CONSTRAINTS);
      return configured(sql);
    });
    expect(r.ok).toBe(true);
    expect(out.find((l) => l.includes("10 list LESSONS tables"))).toContain(`2 rows, ledger listed over ${DIR}/ledger.jsonl as json, lesson listed`);
    expect(out.find((l) => l.includes("31 load usl drift_usl"))).toContain("stale: 11 table(s); lacks lesson, rule, adoption, dns_live");
    expect(status).toMatchObject({
      "drop LESSONS.ledger": "ok", "create LESSONS.ledger": "ok", "drop LESSONS.lesson": "skipped", "create LESSONS.lesson": "skipped",
      "remove usl drift_usl": "ok", "compile usl drift_usl": "ok", "activate adoption": "ok", "register dq exception_in_force": "ok", "update dq exception_in_force": "skipped", "run dq adoption": "ok",
    });
    const order = client.calls.map((c) => c.sql);
    expect(order.indexOf("DROP LIGHTNING DATABASE TABLE LESSONS.ledger")).toBeLessThan(order.indexOf(`CREATE LIGHTNING FILESTORE TABLE ledger FROM LESSONS FORMAT JSON OPTIONS (path "${DIR}/ledger.json")`));
    expect(sent(client, /^REGISTER DQ/)).toEqual(setup.DQ_RULES.map((d) => `REGISTER DQ ${d.name} TABLE ${USL}.${d.table} AS ${d.expression}`));
    expect(sent(client, /^REGISTER DQ exception_in_force/)).toEqual([`REGISTER DQ exception_in_force TABLE ${USL}.adoption AS ${EXCEPTION_IN_FORCE_EXPR}`]);
    expect(out.at(-1)).toMatch(/^ZETARIS SETUP: 84 statements, 63 ok, 21 skipped, 0 failed/);
  });

  it("a file table with other columns than the setup writes is dropped and created again; one listed as stated is kept", async () => {
    const { r, client, status, out } = await run((sql) => {
      if (sql === "DESCRIBE DATASOURCE TABLE LESSONS.lesson") return described([...fileTableDef("lesson")!.columns.filter((c) => c !== "provenance"), "extra"]);
      return configured(sql);
    });
    expect(r.ok).toBe(true);
    expect(out.find((l) => l.includes("14 describe LESSONS.lesson"))).toContain("9 rows, stale: lacks provenance; holds extra");
    expect(status).toMatchObject({ "drop LESSONS.lesson": "ok", "create LESSONS.lesson": "ok", "drop RULES.rule": "skipped", "create RULES.rule": "skipped", "drop LESSONS.ledger": "skipped" });
    expect(sent(client, /^(?:DROP|CREATE) LIGHTNING/)).toEqual(["DROP LIGHTNING DATABASE TABLE LESSONS.lesson", `CREATE LIGHTNING FILESTORE TABLE lesson FROM LESSONS FORMAT JSON OPTIONS (path "${DIR}/lessons.json")`]);
  });

  it("a copy that fails stops the run before any file table is touched, its message on the step", async () => {
    const { r, client, out } = await run(configured, () => { throw new Error("docker exec zetaris-driver-1 failed for /x (exit 1): No such container: zetaris-driver-1"); });
    expect(r.ok).toBe(false);
    expect(r.results.at(-1)).toMatchObject({ name: "copy files to the filestore", status: "failed" });
    expect(out.at(-1)).toMatch(/^ZETARIS SETUP FAILED at 06 copy files to the filestore after \d+ ms: docker exec zetaris-driver-1 failed/);
    expect(sent(client, /LIGHTNING/)).toEqual([]);
  });

  it("a rule listed with another expression is updated in place with the stated one; the others stay", async () => {
    const { r, client, status } = await run((sql) => {
      if (sql.startsWith("LIST DQ USL")) return result(LIST_COLS, [...CONSTRAINTS, ["run_complete", "collection", "Custom Data Quality", "observed_count >= expected_count AND status = 'complete'"], ...STATED.slice(1)]);
      return configured(sql);
    });
    expect(r.ok).toBe(true);
    expect(status).toMatchObject({ "register dq run_complete": "skipped", "update dq run_complete": "ok", "update dq copy_validated": "skipped", "update dq action_verified": "skipped", "update dq cause_evidenced": "skipped" });
    expect(sent(client, /^(?:REGISTER|UPDATE) DQ/)).toEqual([`UPDATE DQ run_complete TABLE ${USL}.collection SET NAME = run_complete, EXPRESSION = ${RUN_COMPLETE_EXPR}`]);
    // whitespace alone is no difference
    const spaced = await run((sql) => (sql.startsWith("LIST DQ USL") ? result(LIST_COLS, STATED.map((row) => [row[0], row[1], row[2], `  ${row[3].replaceAll(" ", "   ")} `])) : configured(sql)));
    expect(sent(spaced.client, /^(?:REGISTER|UPDATE) DQ/)).toEqual([]);
  });

  it("against the USL whose action entity lacks reason and record, and action_verified as first registered: REMOVE USL, COMPILE the fourteen, UPDATE action_verified to the write paths' scope", async () => {
    const before = { ...CURRENT_MODEL, action: setup.USL_COLUMNS.action.filter((c) => c !== "reason" && c !== "record") };
    const { r, client, status, out } = await run((sql) => {
      if (sql.startsWith("LOAD USL")) return model(before);
      if (sql.startsWith("LIST DQ USL")) return result(LIST_COLS, [...CONSTRAINTS, ...STATED.slice(0, 2), ["action_verified", "action", "Custom Data Quality", "status <> 'done' OR verification <> ''"], ...STATED.slice(3)]);
      return configured(sql);
    });
    expect(r.ok).toBe(true);
    expect(out.find((l) => l.includes("31 load usl drift_usl"))).toContain("stale: 15 table(s); columns differ in action");
    expect(status).toMatchObject({ "remove usl drift_usl": "ok", "compile usl drift_usl": "ok", "update dq run_complete": "skipped", "update dq action_verified": "ok" });
    expect(sent(client, /^(?:REGISTER|UPDATE) DQ/)).toEqual([`UPDATE DQ action_verified TABLE ${USL}.action SET NAME = action_verified, EXPRESSION = ${ACTION_VERIFIED_EXPR}`]);
  });

  it("against a fresh instance: CREATE sent with the password, REGISTER after it, REFRESH skipped; no USL: COMPILE, and 'already exists' from it is skipped; the rules registered", async () => {
    const { r, client, tracer, out, status } = await run((sql) => {
      if (sql === "SHOW DATASOURCES") return result(["name", "description"], []);
      if (sql === "SHOW LIGHTNING DATABASES") return result(["name", "description", "id"], []);
      if (sql.startsWith("SHOW LIGHTNING TABLES")) return result(LT_COLS, []);
      if (sql === "SHOW NAMESPACES OR TABLES IN lightning.metastore.drift") return result(["name", "type", "usl_id", "count", "activated"], []);
      if (sql.startsWith("COMPILE USL")) return new ZetarisError("Zetaris 500: USL drift_usl already exists in lightning.metastore.drift", 500);
      if (sql.startsWith("LIST DQ USL")) return result(LIST_COLS, CONSTRAINTS);
      return configured(sql);
    });
    expect(r.ok).toBe(true);
    const create = client.calls.filter((c) => c.sql.startsWith("CREATE DATASOURCE"));
    expect(create).toHaveLength(1);
    expect(create[0].sql).toBe(CREATE_PRINTED.replace("<redacted>", PW));
    expect(status).toMatchObject({
      "create datasource DRIFT": "ok", "list datasource tables": "skipped", "register datasource tables": "ok", "refresh datasource tables": "skipped",
      "load usl drift_usl": "skipped", "remove usl drift_usl": "skipped", "compile usl drift_usl": "skipped", "register dq run_complete": "ok",
    });
    expect(r.results.find((x) => x.name === "compile usl drift_usl")?.note).toBe("already exists");
    // the file sources: both databases created, each table created over its file, nothing to describe or drop
    expect(status).toMatchObject({
      "create lightning database LESSONS": "ok", "create lightning database RULES": "ok", "describe LESSONS.lesson": "skipped", "drop LESSONS.lesson": "skipped",
      "create LESSONS.ledger": "ok", "create LESSONS.lesson": "ok", "create RULES.rule": "ok",
    });
    expect(sent(client, /^CREATE LIGHTNING/)).toEqual([
      'CREATE LIGHTNING DATABASE LESSONS DESCRIBE BY "drift-agent technician memory store, the Meterless H-MEM lessons and ledger"',
      'CREATE LIGHTNING DATABASE RULES DESCRIBE BY "drift-agent policy file, one row per rule"',
      ...setup.FILE_SOURCES.map((f) => `CREATE LIGHTNING FILESTORE TABLE ${f.table} FROM ${f.db} FORMAT JSON OPTIONS (path "${DIR}/${f.file}")`),
      'CREATE LIGHTNING DATABASE CLOUDFLARE DESCRIBE BY "Cloudflare DNS API, the records of each zone live at the provider"',
      ...REST.map(([t, e]) => restPrinted(t, e).replace("<redacted>", TOKEN)),
    ]);
    expect(client.calls.map((c) => c.sql)).toContain(`REGISTER DQ run_complete TABLE ${USL}.collection AS ${RUN_COMPLETE_EXPR}`);
    expect(tracer.events[1]).toMatchObject({ status: "ok", input_summary: "CREATE DATASOURCE DRIFT (credentials redacted)" });
    for (const secret of [PW, TOKEN]) {
      expect(JSON.stringify(tracer.events)).not.toContain(secret);
      expect(out.join("\n")).not.toContain(secret);
    }
  });

  it("CREATE answering 'already exists' means the datasource existed: its tables listed, REGISTER skipped when all are there, REFRESH run", async () => {
    const { r, status } = await run((sql) => {
      if (sql === "SHOW DATASOURCES") return result(["name"], []);
      if (sql.startsWith("CREATE DATASOURCE")) return new Error("Datasource DRIFT already exists");
      return configured(sql);
    });
    expect(r.ok).toBe(true);
    expect(status).toMatchObject({ "create datasource DRIFT": "skipped", "list datasource tables": "ok", "register datasource tables": "skipped", "refresh datasource tables": "ok" });
  });

  it("stops on any other error, with the message redacted and scrubbed of the literal password, everywhere it is written", async () => {
    const { r, client, tracer, out } = await run((sql) => {
      if (sql === "SHOW DATASOURCES") return result(["name"], []);
      if (sql.startsWith("CREATE DATASOURCE")) return new Error(`connection refused while running ${sql}; credential was ${PW}`);
      return configured(sql);
    });
    expect(r.ok).toBe(false);
    expect(client.calls).toHaveLength(2);
    expect(r.error).toContain('password "<redacted>"');
    expect(r.error).not.toContain(PW);
    expect(r.results.at(-1)).toMatchObject({ name: "create datasource DRIFT", status: "failed" });
    expect(out.at(-1)).toMatch(/^ZETARIS SETUP FAILED at 02 create datasource DRIFT after \d+ ms: connection refused/);
    expect(tracer.events.at(-1)).toMatchObject({ status: "failed", input_summary: "CREATE DATASOURCE DRIFT (credentials redacted)" });
    expect(JSON.stringify(tracer.events)).not.toContain(PW);
    expect(out.join("\n")).not.toContain(PW);
  });
});

describe("Zetaris adapter", () => {
  afterEach(() => vi.unstubAllGlobals());
  const ok = () => vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ headers: ["json"], data: [["{}"]], total: 1, timeUsed: 5 }), { status: 200 }));

  it("refuses allowMultiStatement for any statement that does not start with COMPILE USL, before sending it", async () => {
    const fetch = ok();
    vi.stubGlobal("fetch", fetch);
    const z = new Zetaris();
    for (const sql of ["SELECT 1; SELECT 2", "SELECT 1", "CREATE NAMESPACE IF NOT EXISTS a; DROP NAMESPACE a", "/* COMPILE USL */ SELECT 1; SELECT 2", "SELECT 'COMPILE USL'; DROP DATASOURCE DRIFT"]) {
      await expect(z.query(sql, { allowMultiStatement: true })).rejects.toThrow(/honoured only for COMPILE USL/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses the COMPILE block as two statements without the flag, and sends it as one request with it", async () => {
    const fetch = ok();
    vi.stubGlobal("fetch", fetch);
    const z = new Zetaris();
    await expect(z.query(setup.COMPILE_USL)).rejects.toThrow(/one statement per call/);
    expect(fetch).not.toHaveBeenCalled();
    const r = await z.query(setup.COMPILE_USL, { allowMultiStatement: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetch.mock.calls[0][1].body));
    expect(body.sql).toBe(setup.COMPILE_USL);
    expect(body.source).toBe("SqlEditor");
    expect(r.rows).toEqual([["{}"]]);
  });

  it("redacts the password in its error message and in its trace lines, a slice cut mid-value included", async () => {
    const stmt = step("create datasource DRIFT").secret!();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: `could not connect: ${stmt}` }), { status: 500 })));
    const tracer = new MemTracer("t_adapter");
    const z = new Zetaris();
    const err = (await z.query(stmt, { tracer }).then(() => undefined, (e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(ZetarisError);
    expect(err.message).toContain('password "<redacted>"');
    expect(err.message).not.toContain(PW);
    vi.stubGlobal("fetch", ok());
    const long = `CREATE DATASOURCE D DESCRIBE BY "${"d".repeat(100)}" OPTIONS (password "${PW}")`;
    expect(long.indexOf(PW)).toBeLessThan(160);
    expect(long.indexOf(PW) + PW.length).toBeGreaterThan(160);
    await z.query(long, { tracer });
    expect(tracer.events.map((e) => e.status)).toEqual(["failed", "ok"]);
    expect(JSON.stringify(tracer.events)).not.toContain(PW.slice(0, 6));
  });

  it("every query trace event names the engine that answered: zetaris through ZetarisEngine, sqljs through SqlJsEngine, failed queries included", async () => {
    const { DataLayer } = await import("../src/data/layer.ts");
    const { ZetarisEngine } = await import("../src/data/engines/zetaris.ts");
    const { SqlJsEngine } = await import("../src/data/engines/sqljs.ts");
    const { CountingEngine } = await import("../src/data/engines/counting.ts");
    const sql = "SELECT run_id FROM {{t:collection_run}} WHERE tenant_id = {{p:t}}";
    const tracer = new MemTracer("t_engine", { model: "none" });
    vi.stubGlobal("fetch", ok());
    await new DataLayer(new CountingEngine(new ZetarisEngine())).run(sql, { t: "client-a" }, { tracer, agent: "pass" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "table not found" }), { status: 400 })));
    await expect(new DataLayer(new ZetarisEngine()).run(sql, { t: "client-a" }, { tracer })).rejects.toThrow(ZetarisError);
    const lite = await SqlJsEngine.create();
    await new DataLayer(new CountingEngine(lite)).run(sql, { t: "client-a" }, { tracer, agent: "pass" });
    await expect(lite.run("SELECT nope FROM collection_run", { tracer })).rejects.toThrow(/sqljs/);
    expect(tracer.events.map((e) => [e.action, e.engine, e.status])).toEqual([
      ["query", "zetaris", "ok"], ["query", "zetaris", "failed"], ["query", "sqljs", "ok"], ["query", "sqljs", "failed"],
    ]);
    expect(tracer.events[0].input_summary).toContain("DRIFT.collection_run");
    expect(tracer.events[2].input_summary).toContain("FROM collection_run WHERE");
  });
});

describe("the copy's freshness (src/zetaris/filestore.ts refreshFiles)", () => {
  const T = { container: "zetaris-driver-1", distro: "Ubuntu-24.04" };
  const fakePut = (files: Readonly<Record<string, string>>) => Object.entries(files).map(([n, t]) => ({ path: `${DIR}/${n}`, bytes: Buffer.byteLength(t) }));

  it("filesHash covers the container, the directory and each file's name and text, in name order", () => {
    const h = filesHash({ "a.json": "[1]", "b.json": "[2]" }, T);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(filesHash({ "b.json": "[2]", "a.json": "[1]" }, T)).toBe(h);
    expect(filesHash({ "a.json": "[1]", "b.json": "[3]" }, T)).not.toBe(h);
    expect(filesHash({ "a.json": "[1]", "c.json": "[2]" }, T)).not.toBe(h);
    expect(filesHash({ "a.json": "[1]", "b.json": "[2]" }, { ...T, container: "zetaris-driver-2" })).not.toBe(h);
  });

  it("apply() records the copy's hash where copyState names it; refreshFileTables over the same files then puts nothing, and over a changed store puts them and records the new hash", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "drift-copy-"));
    try {
      const stateFile = path.join(dir, "filestore-copy.json");
      const r = await setup.apply({ client: new Scripted(configured), out: () => {}, env: ENV, files: () => FILES, put: fakePut, copyState: stateFile });
      expect(r.ok).toBe(true);
      const state = readCopyState(stateFile)!;
      expect(state.hash).toBe(filesHash(FILES));
      expect(state.files).toEqual(fakePut(FILES));
      expect(Number.isNaN(Date.parse(state.at))).toBe(false);

      const puts: Readonly<Record<string, string>>[] = [];
      const put = (f: Readonly<Record<string, string>>) => (puts.push(f), fakePut(f));
      expect(await setup.refreshFileTables({ files: () => FILES, put, stateFile })).toMatchObject({ status: "current", hash: state.hash });
      expect(puts).toEqual([]);

      // npm run answer recorded a lesson: the hash differs, so the files go in again and the new hash is recorded
      const taught = { ...FILES, "lessons.json": '[{"lesson_id":"mem-1"},{"lesson_id":"mem-2"}]' };
      const refreshed = await setup.refreshFileTables({ files: () => taught, put, stateFile });
      expect(refreshed).toMatchObject({ status: "refreshed", hash: filesHash(taught), previous: state.hash, put: fakePut(taught) });
      expect(puts).toEqual([taught]);
      expect(readCopyState(stateFile)?.hash).toBe(filesHash(taught));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failed put is returned, never thrown, and records nothing, so the next refresh puts again; no state file reads as never copied", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "drift-copy-"));
    try {
      const stateFile = path.join(dir, "filestore-copy.json");
      const failed = await setup.refreshFileTables({ files: () => FILES, put: () => { throw new Error("docker could not start for x: spawn wsl.exe ENOENT"); }, stateFile });
      expect(failed).toMatchObject({ status: "failed", error: "docker could not start for x: spawn wsl.exe ENOENT" });
      expect(existsSync(stateFile)).toBe(false);
      expect(await setup.refreshFileTables({ files: () => FILES, put: fakePut, stateFile })).toMatchObject({ status: "refreshed", previous: null });
      // a store the files cannot be built from fails the same way
      const unbuilt = await setup.refreshFileTables({ files: () => { throw new Error("the memory store holds no lesson"); }, put: fakePut, stateFile });
      expect(unbuilt).toMatchObject({ status: "failed", error: "the memory store holds no lesson" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with a fake put and no copyState named, apply() leaves the live pass's state file as it was", async () => {
    const before = existsSync(COPY_STATE_FILE) ? readFileSync(COPY_STATE_FILE, "utf8") : null;
    expect(path.basename(COPY_STATE_FILE)).toBe("filestore-copy.json");
    expect(path.basename(path.dirname(COPY_STATE_FILE))).toBe(".world");
    await run(configured);
    expect(existsSync(COPY_STATE_FILE) ? readFileSync(COPY_STATE_FILE, "utf8") : null).toBe(before);
  });
});
