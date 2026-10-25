// The Zetaris setup with no live call: plan() order and texts (ten USL tables, each activation returning
// exactly its declared columns, three DQ rules), the semantic layer's table uslRows() and uslMarkdown() read off the
// DDL, the activation SELECTs and DQ_RULES, staleness() of a USL model, the password kept out of every
// string that is printed, traced or redact()ed, apply() over a scripted client (an instance already set up,
// the four-table USL of 24 Oct, a rule listed with another expression, a fresh instance, one that fails),
// and the adapter's allowMultiStatement and redaction against a stubbed fetch, and the engine every query trace event
// names (zetaris or sqljs).
// The env is stubbed before config loads, so the real .env key and DATABASE_URL never enter this file.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "../src/adapters/zetaris.ts";

const PW = "pw-Zx9q-not-real-41";
const DB_URL = `postgresql://drift:${PW}@127.0.0.1:15432/drift`;
vi.stubEnv("ZETARIS_API_KEY", "test-key-not-real");
vi.stubEnv("DATABASE_URL", DB_URL);
vi.stubEnv("ZETARIS_PG_HOST", "drift-pg");
vi.stubEnv("ZETARIS_DATASOURCE", "DRIFT");
const { redact } = await import("../src/config.ts");
const { Zetaris, ZetarisError } = await import("../src/adapters/zetaris.ts");
const { stripLiterals } = await import("../src/data/layer.ts");
const setup = await import("../src/zetaris/setup.ts");
const { TABLE_NAMES } = await import("../src/data/schema.ts");
const { MemTracer } = await import("./fixtures/mem-tracer.ts");

afterAll(() => vi.unstubAllEnvs());

const ENV = { databaseUrl: DB_URL, pgHost: "drift-pg", datasource: "DRIFT" };
const USL = "lightning.metastore.drift.drift_usl";
const CREATE_PRINTED = `CREATE DATASOURCE DRIFT DESCRIBE BY "drift-agent app Postgres on the zetaris network" OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://drift-pg:5432/drift", username "drift", password "<redacted>", schema "public", fetchsize "1000")`;
const step = (name: string, steps = setup.plan(ENV)) => steps.find((s) => s.name === name)!;

const TEN = ["collection", "setting", "referent", "backup_copy", "policy", "copy", "probe", "disposition", "action", "ticket"];
const RULES = ["run_complete", "copy_validated", "action_verified"];
const RUN_COMPLETE_EXPR = "observed_count IS NOT NULL AND expected_count IS NOT NULL AND observed_count >= expected_count AND status = 'complete'";
/** action_verified, scoped to the write paths. */
const ACTION_VERIFIED_EXPR = "kind NOT IN ('rollback_file','revert_record') OR status IN ('failed','refused','not_judged') OR verification <> ''";

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
      ["namespace lightning.metastore", ""],
      ["namespace lightning.metastore.drift", ""],
      ["list lightning.metastore.drift", ""],
      ["load usl drift_usl", "usl_present"],
      ["remove usl drift_usl", "usl_stale"],
      ["compile usl drift_usl", "usl_absent"],
      ...TEN.map((t) => [`activate ${t}`, ""]),
      ["list dq rules", ""],
      ...RULES.flatMap((r) => [[`register dq ${r}`, "dq_rule_absent"], [`update dq ${r}`, "dq_rule_differs"]]),
      ["run dq collection", ""],
      ["run dq copy", ""],
      ["run dq action", ""],
      ["show lightning.metastore.drift.drift_usl", ""],
      ...TEN.map((t) => [`count ${t}`, ""]),
    ]);
    expect(steps).toHaveLength(42);
    expect(setup.USL_TABLES).toEqual(TEN);
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
    expect(steps.filter((s) => s.secret).map((s) => s.name)).toEqual(["create datasource DRIFT"]);
  });

  it("namespaces, the USL probes and REMOVE, then the ten-table USL DDL in one request with the renamed reserved words", () => {
    expect(step("namespace lightning.metastore", steps).sql).toBe("CREATE NAMESPACE IF NOT EXISTS lightning.metastore");
    expect(step("namespace lightning.metastore.drift", steps).sql).toBe("CREATE NAMESPACE IF NOT EXISTS lightning.metastore.drift");
    expect(step("list lightning.metastore.drift", steps).sql).toBe("SHOW NAMESPACES OR TABLES IN lightning.metastore.drift");
    expect(step("load usl drift_usl", steps).sql).toBe("LOAD USL drift_usl NAMESPACE lightning.metastore.drift");
    expect(step("remove usl drift_usl", steps).sql).toBe("REMOVE USL drift_usl NAMESPACE lightning.metastore.drift");
    const ddl = step("compile usl drift_usl", steps);
    expect(ddl.multi).toBe(true);
    expect(ddl.sql).toBe(setup.COMPILE_USL);
    expect(ddl.sql.startsWith("COMPILE USL IF NOT EXISTS drift_usl DEPLOY NAMESPACE lightning.metastore.drift DDL\nCREATE TABLE collection (\n")).toBe(true);
    expect([...ddl.sql.matchAll(/^CREATE TABLE (\w+) \($/gm)].map((m) => m[1])).toEqual(TEN);
    expect(ddl.sql.match(/\);\nCREATE TABLE /g)).toHaveLength(9);
    expect(ddl.sql).toContain("  run_id varchar(128) NOT NULL FOREIGN KEY REFERENCES collection(run_id),");
    expect(ddl.sql).toContain("  setting_id varchar(128) NOT NULL FOREIGN KEY REFERENCES setting(setting_id),");
    expect(ddl.sql).toContain("  disposition_id varchar(128) NOT NULL FOREIGN KEY REFERENCES disposition(disposition_id)\n);");
    expect(ddl.sql).toContain("  source_kind varchar(32) NOT NULL,");
    expect(ddl.sql).toContain("  lock int NOT NULL,");
    expect(ddl.sql).toContain("  validated int NOT NULL\n)");
    expect(ddl.sql).not.toMatch(/^\s+source varchar/m);
    expect(ddl.sql).not.toMatch(/CREATE TABLE reference\b/);
    expect(ddl.sql.endsWith("  updated_at varchar(40) NOT NULL\n)")).toBe(true);
    // USL_COLUMNS is read off the same DDL lines
    for (const t of TEN) {
      const block = ddl.sql.slice(ddl.sql.indexOf(`CREATE TABLE ${t} (\n`)).split("\n)")[0].split("\n").slice(1);
      expect(block.map((l) => l.trim().split(" ")[0]), t).toEqual([...setup.USL_COLUMNS[t as keyof typeof setup.USL_COLUMNS]]);
    }
  });

  it("activates each of the ten tables over the datasource, returning exactly the declared columns", () => {
    for (const t of TEN) {
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
  });

  it("then the DQ rules (register or update), RUN DQ on collection, copy and action, the USL's table listing and a count per table", () => {
    expect(step("list dq rules", steps).sql).toBe(`LIST DQ USL ${USL}`);
    expect(setup.DQ_RULES.map((r) => [r.name, r.table, r.expression])).toEqual([
      ["run_complete", "collection", RUN_COMPLETE_EXPR],
      ["copy_validated", "copy", "validated = 1"],
      ["action_verified", "action", ACTION_VERIFIED_EXPR],
    ]);
    expect(step("register dq run_complete", steps).sql).toBe(`REGISTER DQ run_complete TABLE ${USL}.collection AS ${RUN_COMPLETE_EXPR}`);
    expect(step("update dq run_complete", steps).sql).toBe(`UPDATE DQ run_complete TABLE ${USL}.collection SET NAME = run_complete, EXPRESSION = ${RUN_COMPLETE_EXPR}`);
    expect(step("register dq copy_validated", steps).sql).toBe(`REGISTER DQ copy_validated TABLE ${USL}.copy AS validated = 1`);
    expect(step("register dq action_verified", steps).sql).toBe(`REGISTER DQ action_verified TABLE ${USL}.action AS ${ACTION_VERIFIED_EXPR}`);
    expect(step("update dq action_verified", steps).sql).toBe(`UPDATE DQ action_verified TABLE ${USL}.action SET NAME = action_verified, EXPRESSION = ${ACTION_VERIFIED_EXPR}`);
    for (const t of ["collection", "copy", "action"]) expect(step(`run dq ${t}`, steps)).toMatchObject({ sql: `RUN DQ TABLE ${USL}.${t}`, dqTable: t, show: true });
    expect(step("show lightning.metastore.drift.drift_usl", steps).sql).toBe(`SHOW NAMESPACES OR TABLES IN ${USL}`);
    for (const t of TEN) expect(step(`count ${t}`, steps).sql).toBe(`SELECT COUNT(*) AS n FROM ${USL}.${t}`);
  });

  it("one statement per call except the COMPILE, no trailing semicolon, no double-quoted identifier in SQL text", () => {
    for (const s of steps) {
      expect(s.sql.trimEnd().endsWith(";")).toBe(false);
      if (!s.multi) expect(stripLiterals(s.sql)).not.toContain(";");
    }
    expect(steps.filter((s) => s.multi).map((s) => s.name)).toEqual(["compile usl drift_usl"]);
    for (const s of steps.filter((x) => /^(?:activate|count|register dq|update dq)/.test(x.name))) expect(stripLiterals(s.sql)).not.toContain('"');
  });

  it("staleness(): LOAD USL's model against the ten tables and their columns", () => {
    const model = (tables: Record<string, readonly string[]>) => ({ queryId: "q", columns: ["json"], rows: [[JSON.stringify({ tables: Object.entries(tables).map(([name, cols]) => ({ name, columnSpecs: cols.map((c) => ({ name: c })) })) })]], rowCount: 1, total: 1, latencyMs: 1, raw: {} });
    const current = { ...setup.USL_COLUMNS };
    expect(setup.staleness(model(current))).toBeNull();
    const { policy: _p, copy: _c, probe: _r, disposition: _d, action: _a, ticket: _t, ...four } = current;
    expect(setup.staleness(model(four))).toBe("4 table(s); lacks policy, copy, probe, disposition, action, ticket");
    expect(setup.staleness(model({ ...current, extra: ["x"] }))).toBe("11 table(s); holds extra beyond the 10");
    expect(setup.staleness(model({ ...current, policy: current.policy.filter((c) => c !== "note") }))).toBe("10 table(s); columns differ in policy");
    expect(setup.staleness({ ...model(current), rows: [["not json"]] })).toBe("LOAD USL returned no model that parses");
    expect(setup.staleness({ ...model(current), rows: [] })).toBe("LOAD USL returned no model that parses");
  });

  it("reaches the Postgres at ZETARIS_PG_HOST, not DATABASE_URL's host and port; a port in it wins; the datasource name qualifies every table", () => {
    const s = setup.plan({ ...ENV, pgHost: "pg.zetaris.test:6543", datasource: "DRIFT2" });
    expect(step("create datasource DRIFT2", s).sql).toContain('jdbcurl "jdbc:postgresql://pg.zetaris.test:6543/drift"');
    expect(step("activate collection", s).sql).toContain("FROM DRIFT2.collection_run");
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

  it("one row per entity in USL_TABLES order, each built from the DRIFT tables its activation SELECT reads, every one in sql/schema.sql", () => {
    expect(rows.map((r) => r.entity)).toEqual(TEN);
    expect(Object.fromEntries(rows.map((r) => [r.entity, r.builtFrom]))).toEqual({
      collection: ["collection_run"], setting: ["observation"], referent: ["observation", "dns_record"],
      backup_copy: ["backup_item", "backup_snapshot"], policy: ["policy_rule"], copy: ["vault_copy", "copy_validation"],
      probe: ["probe"], disposition: ["disposition"], action: ["action"], ticket: ["ticket"],
    });
    for (const r of rows) for (const t of r.builtFrom) expect(TABLE_NAMES, `${r.entity} reads ${t}`).toContain(t);
    // the exported activation() is the one plan() sends
    for (const t of TEN) expect(step(`activate ${t}`).sql).toBe(`ACTIVATE USL TABLE ${USL}.${t} AS ${setup.activation(t as never, "DRIFT")}`);
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
        expect(TEN, `${r.entity}.${f.column}`).toContain(entity);
        expect(setup.USL_COLUMNS[entity as never], `${r.entity}.${f.column}`).toContain(column);
        expect(setup.USL_COLUMNS[r.entity]).toContain(f.column);
      }
    }
    expect(rows.find((r) => r.entity === "action")!.foreignKeys).toEqual([{ column: "disposition_id", references: "disposition(disposition_id)" }]);
  });

  it("three entities carry a DQ rule, each the rule of DQ_RULES byte for byte; the markdown prints each expression in inline code, one table row per entity, no number measured and no date", () => {
    const ruled = rows.filter((r) => r.rule);
    expect(ruled.map((r) => [r.entity, r.rule!.name])).toEqual([["collection", "run_complete"], ["copy", "copy_validated"], ["action", "action_verified"]]);
    for (const r of ruled) expect(r.rule!.expression).toBe(setup.DQ_RULES.find((d) => d.name === r.rule!.name)!.expression);
    expect(ruled.map((r) => r.rule!.expression)).toEqual([RUN_COMPLETE_EXPR, "validated = 1", ACTION_VERIFIED_EXPR]);
    const md = setup.uslMarkdown();
    const table = md.split("\n").filter((l) => l.startsWith("|"));
    expect(table).toHaveLength(2 + TEN.length);
    expect(table[0]).toBe("| entity | built from | key | DQ rule | expression |");
    for (const [i, r] of rows.entries()) {
      expect(table[i + 2].startsWith(`| \`${r.entity}\` |`), r.entity).toBe(true);
      if (r.rule) expect(table[i + 2].endsWith(`| \`${r.rule.name}\` | \`${r.rule.expression}\` |`), r.entity).toBe(true);
      else expect(table[i + 2].endsWith("|  |  |"), r.entity).toBe(true);
    }
    expect(md).toContain("`drift_usl` in `lightning.metastore.drift`");
    expect(md).not.toMatch(/\b20\d\d\b|\bOct\b|\d+ of \d+/);
    expect(md.endsWith("|\n")).toBe(true);
  });
});

describe("the password never appears", () => {
  it("in plan() output, serialised or printed by --plan, from an explicit env or the process env", () => {
    for (const steps of [setup.plan(ENV), setup.plan()]) {
      expect(JSON.stringify(steps)).not.toContain(PW);
      const printed = setup.formatPlan(steps, "DRIFT").join("\n");
      expect(printed).not.toContain(PW);
      expect(printed).toContain('password "<redacted>"');
      expect(printed).toContain("02 create datasource DRIFT  (only when DRIFT is absent)");
    }
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

/** The instance as it stands after the live runs of 24 Oct: DRIFT with all 16 tables, the ten-table USL, the three rules as stated. */
function configured(sql: string): QueryResult | Error {
  if (sql === "SHOW DATASOURCES") return result(["name", "description"], [["DRIFT", "drift-agent app Postgres on the zetaris network"]]);
  if (sql === "SHOW DATASOURCE TABLES DRIFT") return result(["name", "relation", "source_table", "partition clause", "description", "materialized table", "datasource_id", "relation_id"], SCHEMA_TABLES_LISTED);
  if (sql === "SHOW NAMESPACES OR TABLES IN lightning.metastore.drift") return result(["name", "type", "usl_id", "count", "activated"], [["drift_usl", "usl", "1105", "10", ""]]);
  if (sql === `SHOW NAMESPACES OR TABLES IN ${USL}`) return result(["name", "type", "usl_id", "count", "activated"], TEN.map((t) => [t, "table", "", "0", "true"]));
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

async function run(answer: (sql: string) => QueryResult | Error) {
  const client = new Scripted(answer);
  const tracer = new MemTracer("t_setup", { model: "none" });
  const out: string[] = [];
  const r = await setup.apply({ client, tracer, out: (l) => out.push(l), env: ENV });
  return { r, client, tracer, out, status: Object.fromEntries(r.results.map((x) => [x.name, x.status])) };
}

const skippedOf = (status: Record<string, string>) => Object.entries(status).filter(([, s]) => s === "skipped").map(([n]) => n);
const sent = (client: Scripted, re: RegExp) => client.calls.map((c) => c.sql).filter((s) => re.test(s));

describe("apply()", () => {
  it("against an instance already set up: a no-op success, the USL and its rules kept, RUN DQ printed for three tables", async () => {
    const { r, client, tracer, out, status } = await run(configured);
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(42);
    expect(skippedOf(status)).toEqual([
      "create datasource DRIFT", "register datasource tables", "remove usl drift_usl", "compile usl drift_usl",
      ...RULES.flatMap((n) => [`register dq ${n}`, `update dq ${n}`]),
    ]);
    expect(r.results.every((x) => x.status === "ok" || x.status === "skipped")).toBe(true);
    expect(sent(client, /^(?:CREATE DATASOURCE|REGISTER DATASOURCE|REMOVE USL|COMPILE USL|REGISTER DQ|UPDATE DQ)/)).toEqual([]);
    expect(client.calls.filter((c) => c.opts.allowMultiStatement)).toEqual([]);
    expect(sent(client, /^ACTIVATE/)).toHaveLength(10);
    expect(r.dq?.rows).toEqual(DQ_ROWS);
    expect(Object.keys(r.dqRuns)).toEqual(["collection", "copy", "action"]);
    expect(out).toContain("     name | table | type | total_record | valid_record | invalid_record");
    expect(out).toContain("     run_complete | collection | Custom Data Quality | 4 | 4 | 0");
    expect(out.find((l) => l.includes("01 show datasources"))).toMatch(/^ok\s+01 show datasources\s+1 row, DRIFT listed {2}\(\d+ ms\)$/);
    expect(out.find((l) => l.includes("02 create datasource DRIFT"))).toMatch(/^skipped 02 create datasource DRIFT\s+DRIFT exists$/);
    expect(out.find((l) => l.includes("03 list datasource tables"))).toMatch(new RegExp(`^ok\\s+03 list datasource tables\\s+${TABLE_NAMES.length} rows, all ${TABLE_NAMES.length} schema tables registered {2}\\(\\d+ ms\\)$`));
    expect(out.find((l) => l.includes("09 load usl drift_usl"))).toMatch(/^ok\s+09 load usl drift_usl\s+10 tables as compiled {2}\(\d+ ms\)$/);
    expect(out.find((l) => l.includes("10 remove usl"))).toMatch(/^skipped 10 remove usl drift_usl\s+drift_usl holds the 10 tables as compiled$/);
    expect(out.find((l) => l.includes("22 list dq rules"))).toMatch(/^ok\s+22 list dq rules\s+6 rows, run_complete listed, copy_validated listed, action_verified listed {2}\(\d+ ms\)$/);
    expect(out.find((l) => l.includes("24 update dq run_complete"))).toMatch(/^skipped 24 update dq run_complete\s+run_complete listed as stated$/);
    expect(out.find((l) => l.includes("33 count collection"))).toMatch(/^ok\s+33 count collection\s+= 12 {2}\(\d+ ms\)$/);
    expect(out.at(-1)).toMatch(/^ZETARIS SETUP: 42 statements, 32 ok, 10 skipped, 0 failed, \d+\.\d s$/);
    expect(tracer.events).toHaveLength(42);
    expect(tracer.events.every((e) => e.agent === "zetaris-setup" && e.action === "query" && e.engine === "zetaris" && e.model_requested === "none")).toBe(true);
    expect(tracer.events[1]).toMatchObject({ status: "skipped", input_summary: "CREATE DATASOURCE DRIFT (credentials redacted)", output_summary: "DRIFT exists" });
  });

  it("against the four-table USL and the eight-table datasource of 24 Oct: REGISTER the new tables, REMOVE USL, COMPILE the ten, register the three rules", async () => {
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
    });
    expect(out.find((l) => l.includes("03 list datasource tables"))).toContain(`${TABLE_NAMES.length - 8} of ${TABLE_NAMES.length} schema tables unregistered: ${TABLE_NAMES.slice(8).join(", ")}`);
    expect(out.find((l) => l.includes("09 load usl drift_usl"))).toContain("stale: 4 table(s); lacks policy, copy, probe, disposition, action, ticket");
    const order = client.calls.map((c) => c.sql.split(/\s+/).slice(0, 2).join(" "));
    expect(order.indexOf("REMOVE USL")).toBeLessThan(order.indexOf("COMPILE USL"));
    expect(order.indexOf("COMPILE USL")).toBeLessThan(order.indexOf("ACTIVATE USL"));
    expect(client.calls.filter((c) => c.opts.allowMultiStatement).map((c) => c.sql)).toEqual([setup.COMPILE_USL]);
    expect(sent(client, /^REGISTER DQ/)).toEqual(setup.DQ_RULES.map((d) => `REGISTER DQ ${d.name} TABLE ${USL}.${d.table} AS ${d.expression}`));
    expect(out.at(-1)).toMatch(/^ZETARIS SETUP: 42 statements, 37 ok, 5 skipped, 0 failed/);
  });

  it("a rule listed with another expression is updated in place with the stated one; the others stay", async () => {
    const { r, client, status } = await run((sql) => {
      if (sql.startsWith("LIST DQ USL")) return result(LIST_COLS, [...CONSTRAINTS, ["run_complete", "collection", "Custom Data Quality", "observed_count >= expected_count AND status = 'complete'"], ...STATED.slice(1)]);
      return configured(sql);
    });
    expect(r.ok).toBe(true);
    expect(status).toMatchObject({ "register dq run_complete": "skipped", "update dq run_complete": "ok", "update dq copy_validated": "skipped", "update dq action_verified": "skipped" });
    expect(sent(client, /^(?:REGISTER|UPDATE) DQ/)).toEqual([`UPDATE DQ run_complete TABLE ${USL}.collection SET NAME = run_complete, EXPRESSION = ${RUN_COMPLETE_EXPR}`]);
    // whitespace alone is no difference
    const spaced = await run((sql) => (sql.startsWith("LIST DQ USL") ? result(LIST_COLS, STATED.map((row) => [row[0], row[1], row[2], `  ${row[3].replaceAll(" ", "   ")} `])) : configured(sql)));
    expect(sent(spaced.client, /^(?:REGISTER|UPDATE) DQ/)).toEqual([]);
  });

  it("against the USL whose action entity lacks reason and record, and action_verified as first registered: REMOVE USL, COMPILE the ten, UPDATE action_verified to the write paths' scope", async () => {
    const before = { ...CURRENT_MODEL, action: setup.USL_COLUMNS.action.filter((c) => c !== "reason" && c !== "record") };
    const { r, client, status, out } = await run((sql) => {
      if (sql.startsWith("LOAD USL")) return model(before);
      if (sql.startsWith("LIST DQ USL")) return result(LIST_COLS, [...CONSTRAINTS, ...STATED.slice(0, 2), ["action_verified", "action", "Custom Data Quality", "status <> 'done' OR verification <> ''"]]);
      return configured(sql);
    });
    expect(r.ok).toBe(true);
    expect(out.find((l) => l.includes("09 load usl drift_usl"))).toContain("stale: 10 table(s); columns differ in action");
    expect(status).toMatchObject({ "remove usl drift_usl": "ok", "compile usl drift_usl": "ok", "update dq run_complete": "skipped", "update dq action_verified": "ok" });
    expect(sent(client, /^(?:REGISTER|UPDATE) DQ/)).toEqual([`UPDATE DQ action_verified TABLE ${USL}.action SET NAME = action_verified, EXPRESSION = ${ACTION_VERIFIED_EXPR}`]);
  });

  it("against a fresh instance: CREATE sent with the password, REGISTER after it, REFRESH skipped; no USL: COMPILE, and 'already exists' from it is skipped; the rules registered", async () => {
    const { r, client, tracer, out, status } = await run((sql) => {
      if (sql === "SHOW DATASOURCES") return result(["name", "description"], []);
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
    expect(client.calls.map((c) => c.sql)).toContain(`REGISTER DQ run_complete TABLE ${USL}.collection AS ${RUN_COMPLETE_EXPR}`);
    expect(tracer.events[1]).toMatchObject({ status: "ok", input_summary: "CREATE DATASOURCE DRIFT (credentials redacted)" });
    expect(JSON.stringify(tracer.events)).not.toContain(PW);
    expect(out.join("\n")).not.toContain(PW);
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
