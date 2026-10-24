// The Zetaris setup with no live call: plan() order and texts, the password kept out of every string that
// is printed, traced or redact()ed, apply() over a scripted client (an instance already set up, a fresh
// one, one that fails), and the adapter's allowMultiStatement and redaction against a stubbed fetch.
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
const { MemTracer } = await import("./fixtures/mem-tracer.ts");

afterAll(() => vi.unstubAllEnvs());

const ENV = { databaseUrl: DB_URL, pgHost: "drift-pg", datasource: "DRIFT" };
const USL = "lightning.metastore.drift.drift_usl";
const CREATE_PRINTED = `CREATE DATASOURCE DRIFT DESCRIBE BY "drift-agent app Postgres on the zetaris network" OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://drift-pg:5432/drift", username "drift", password "<redacted>", schema "public", fetchsize "1000")`;
const step = (name: string, steps = setup.plan(ENV)) => steps.find((s) => s.name === name)!;

describe("plan()", () => {
  const steps = setup.plan(ENV);

  it("orders the statements as they ran live, each gated step on its condition", () => {
    expect(steps.map((s) => [s.name, s.when ?? ""])).toEqual([
      ["show datasources", ""],
      ["create datasource DRIFT", "datasource_absent"],
      ["register datasource tables", "datasource_absent"],
      ["refresh datasource tables", "datasource_present"],
      ["namespace lightning.metastore", ""],
      ["namespace lightning.metastore.drift", ""],
      ["compile usl drift_usl", ""],
      ["activate collection", ""],
      ["activate setting", ""],
      ["activate referent", ""],
      ["activate backup_copy", ""],
      ["list dq rules", ""],
      ["register dq run_complete", "dq_rule_absent"],
      ["run dq collection", ""],
      ["show lightning.metastore.drift", ""],
      ["count collection", ""],
      ["count setting", ""],
      ["count referent", ""],
      ["count backup_copy", ""],
    ]);
  });

  it("datasource: CREATE from DATABASE_URL with the host replaced, built in memory; register; refresh", () => {
    const create = step("create datasource DRIFT", steps);
    expect(create.sql).toBe(CREATE_PRINTED);
    expect(create.secret!()).toBe(CREATE_PRINTED.replace("<redacted>", PW));
    expect(create.traceAs).toBe("CREATE DATASOURCE DRIFT (credentials redacted)");
    expect(step("show datasources", steps).sql).toBe("SHOW DATASOURCES");
    expect(step("register datasource tables", steps).sql).toBe("REGISTER DATASOURCE TABLES FROM DRIFT");
    expect(step("refresh datasource tables", steps).sql).toBe("REFRESH DATASOURCE TABLES FROM DRIFT");
    expect(steps.filter((s) => s.secret).map((s) => s.name)).toEqual(["create datasource DRIFT"]);
  });

  it("namespaces, then the four-table USL DDL in one request with the renamed reserved words", () => {
    expect(step("namespace lightning.metastore", steps).sql).toBe("CREATE NAMESPACE IF NOT EXISTS lightning.metastore");
    expect(step("namespace lightning.metastore.drift", steps).sql).toBe("CREATE NAMESPACE IF NOT EXISTS lightning.metastore.drift");
    const ddl = step("compile usl drift_usl", steps);
    expect(ddl.multi).toBe(true);
    expect(ddl.sql.startsWith("COMPILE USL IF NOT EXISTS drift_usl DEPLOY NAMESPACE lightning.metastore.drift DDL\nCREATE TABLE collection (\n")).toBe(true);
    expect([...ddl.sql.matchAll(/^CREATE TABLE (\w+) \($/gm)].map((m) => m[1])).toEqual(["collection", "setting", "referent", "backup_copy"]);
    expect(ddl.sql.match(/\);\nCREATE TABLE /g)).toHaveLength(3);
    expect(ddl.sql).toContain("  run_id varchar(128) NOT NULL FOREIGN KEY REFERENCES collection(run_id),");
    expect(ddl.sql).toContain("  setting_id varchar(128) NOT NULL FOREIGN KEY REFERENCES setting(setting_id),");
    expect(ddl.sql).toContain("  source_kind varchar(32) NOT NULL,");
    expect(ddl.sql).not.toMatch(/^\s+source varchar/m);
    expect(ddl.sql).not.toMatch(/CREATE TABLE reference\b/);
    expect(ddl.sql.endsWith("  taken_at varchar(40) NOT NULL\n)")).toBe(true);
  });

  it("activates each USL table over the datasource, then the DQ rule, RUN DQ, the namespace listing and a count per table", () => {
    for (const t of ["collection", "setting", "referent", "backup_copy"]) expect(step(`activate ${t}`, steps).sql.startsWith(`ACTIVATE USL TABLE ${USL}.${t} AS SELECT `)).toBe(true);
    expect(step("activate collection", steps).sql).toMatch(/CAST\(expected_count AS INT\) AS expected_count, .* FROM DRIFT\.collection_run$/);
    expect(step("activate setting", steps).sql).toMatch(/COALESCE\(source, ''\) AS source_kind, CAST\(COALESCE\(authority, 0\) AS INT\) AS authority FROM DRIFT\.observation$/);
    expect(step("activate referent", steps).sql).toMatch(/FROM DRIFT\.observation o JOIN DRIFT\.dns_record d ON d\.tenant_id = o\.tenant_id AND d\.name = o\.refers_to_id WHERE o\.refers_to_type = 'dns_name'$/);
    expect(step("activate backup_copy", steps).sql).toMatch(/FROM DRIFT\.backup_item b JOIN DRIFT\.backup_snapshot s ON s\.snapshot_id = b\.snapshot_id$/);
    expect(step("list dq rules", steps).sql).toBe(`LIST DQ USL ${USL}`);
    expect(step("register dq run_complete", steps).sql).toBe(`REGISTER DQ run_complete TABLE ${USL}.collection AS observed_count >= expected_count AND status = 'complete'`);
    expect(step("run dq collection", steps).sql).toBe(`RUN DQ TABLE ${USL}.collection`);
    expect(step("show lightning.metastore.drift", steps).sql).toBe("SHOW NAMESPACES OR TABLES IN lightning.metastore.drift");
    for (const t of ["collection", "setting", "referent", "backup_copy"]) expect(step(`count ${t}`, steps).sql).toBe(`SELECT COUNT(*) AS n FROM ${USL}.${t}`);
  });

  it("one statement per call except the COMPILE, no trailing semicolon, no double-quoted identifier in SQL text", () => {
    for (const s of steps) {
      expect(s.sql.trimEnd().endsWith(";")).toBe(false);
      if (!s.multi) expect(stripLiterals(s.sql)).not.toContain(";");
    }
    expect(steps.filter((s) => s.multi).map((s) => s.name)).toEqual(["compile usl drift_usl"]);
    for (const s of steps.filter((x) => /^(?:activate|count|register dq)/.test(x.name))) expect(stripLiterals(s.sql)).not.toContain('"');
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

const DQ_ROWS = [["run_complete", `${USL}.collection`, "custom", "12", "11", "1"], ["run_id", `${USL}.collection`, "primary_key", "12", "12", "0"]];

/** The instance as it stands after tonight's live run: DRIFT registered, the USL activated, run_complete registered. */
function configured(sql: string): QueryResult | Error {
  if (sql === "SHOW DATASOURCES") return result(["name", "description"], [["DRIFT", "drift-agent app Postgres on the zetaris network"]]);
  if (sql.startsWith("COMPILE USL")) return result(["json"], [['{"name":"drift_usl","tables":4}']]);
  if (sql.startsWith("ACTIVATE")) return result(["result"], [["registered"]]);
  if (sql.startsWith("LIST DQ USL")) return result(["name", "table", "type", "expression"], [["run_complete", `${USL}.collection`, "custom", "observed_count >= expected_count AND status = 'complete'"], ["run_id", `${USL}.collection`, "primary_key", ""]]);
  if (sql.startsWith("RUN DQ")) return result(["name", "table", "type", "total_record", "valid_record", "invalid_record"], DQ_ROWS);
  if (sql.startsWith("SHOW NAMESPACES")) return result(["name", "type", "id", "tables", "activated"], [["drift_usl", "usl", "929", "4", ""]]);
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

describe("apply()", () => {
  it("against an instance already set up: a no-op success, every step ok or skipped, RUN DQ printed", async () => {
    const { r, client, tracer, out, status } = await run(configured);
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(19);
    expect(Object.entries(status).filter(([, s]) => s === "skipped").map(([n]) => n)).toEqual(["create datasource DRIFT", "register datasource tables", "register dq run_complete"]);
    expect(r.results.every((x) => x.status === "ok" || x.status === "skipped")).toBe(true);
    expect(client.calls.map((c) => c.sql)).not.toContainEqual(expect.stringMatching(/^(?:CREATE DATASOURCE|REGISTER DATASOURCE|REGISTER DQ)/));
    expect(client.calls.filter((c) => c.opts.allowMultiStatement).map((c) => c.sql.slice(0, 11))).toEqual(["COMPILE USL"]);
    expect(r.dq?.rows).toEqual(DQ_ROWS);
    expect(out).toContain("     name | table | type | total_record | valid_record | invalid_record");
    expect(out).toContain(`     run_complete | ${USL}.collection | custom | 12 | 11 | 1`);
    expect(out.find((l) => l.includes("01 show datasources"))).toMatch(/^ok\s+01 show datasources\s+1 row, DRIFT listed {2}\(\d+ ms\)$/);
    expect(out.find((l) => l.includes("02 create datasource DRIFT"))).toMatch(/^skipped 02 create datasource DRIFT\s+DRIFT exists$/);
    expect(out.find((l) => l.includes("12 list dq rules"))).toMatch(/^ok\s+12 list dq rules\s+2 rows, run_complete listed {2}\(\d+ ms\)$/);
    expect(out.find((l) => l.includes("16 count collection"))).toMatch(/^ok\s+16 count collection\s+= 12 {2}\(\d+ ms\)$/);
    expect(out.at(-1)).toMatch(/^ZETARIS SETUP: 19 statements, 16 ok, 3 skipped, 0 failed, \d+\.\d s$/);
    expect(tracer.events).toHaveLength(19);
    expect(tracer.events.every((e) => e.agent === "zetaris-setup" && e.action === "query" && e.model_requested === "none")).toBe(true);
    expect(tracer.events[1]).toMatchObject({ status: "skipped", input_summary: "CREATE DATASOURCE DRIFT (credentials redacted)", output_summary: "DRIFT exists" });
  });

  it("against a fresh instance: CREATE sent with the password, REGISTER after it, REFRESH skipped, 'already exists' is skipped, the rule registered", async () => {
    const { r, client, tracer, out, status } = await run((sql) => {
      if (sql === "SHOW DATASOURCES") return result(["name", "description"], []);
      if (sql.startsWith("COMPILE USL")) return new ZetarisError("Zetaris 500: USL drift_usl already exists in lightning.metastore.drift", 500);
      if (sql.startsWith("LIST DQ USL")) return result(["name", "table", "type", "expression"], [["run_id", `${USL}.collection`, "primary_key", ""]]);
      return configured(sql);
    });
    expect(r.ok).toBe(true);
    const create = client.calls.filter((c) => c.sql.startsWith("CREATE DATASOURCE"));
    expect(create).toHaveLength(1);
    expect(create[0].sql).toBe(CREATE_PRINTED.replace("<redacted>", PW));
    expect(status).toMatchObject({ "create datasource DRIFT": "ok", "register datasource tables": "ok", "refresh datasource tables": "skipped", "compile usl drift_usl": "skipped", "register dq run_complete": "ok" });
    expect(client.calls.map((c) => c.sql)).toContain(`REGISTER DQ run_complete TABLE ${USL}.collection AS observed_count >= expected_count AND status = 'complete'`);
    expect(tracer.events[1]).toMatchObject({ status: "ok", input_summary: "CREATE DATASOURCE DRIFT (credentials redacted)" });
    expect(JSON.stringify(tracer.events)).not.toContain(PW);
    expect(out.join("\n")).not.toContain(PW);
  });

  it("CREATE answering 'already exists' means the datasource existed: REGISTER skipped, REFRESH run", async () => {
    const { r, status } = await run((sql) => {
      if (sql === "SHOW DATASOURCES") return result(["name"], []);
      if (sql.startsWith("CREATE DATASOURCE")) return new Error("Datasource DRIFT already exists");
      return configured(sql);
    });
    expect(r.ok).toBe(true);
    expect(status).toMatchObject({ "create datasource DRIFT": "skipped", "register datasource tables": "skipped", "refresh datasource tables": "ok" });
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
});
