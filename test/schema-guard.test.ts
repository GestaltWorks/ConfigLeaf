// The source-schema guard (src/zetaris/schema-guard.ts) and the EXPLAIN reads (src/zetaris/explain.ts) over fake
// DESCRIBE and EXPLAIN answers in the shapes Zetaris 2.4.3.1 returned on 26 Oct 2026 (test/fixtures/zetaris-meta.ts),
// then the live pass step (src/loop/pass.ts) over the policy fixture under Zetaris's name: as expected it decides as
// before and its row reads "schema 20 tables as expected"; a changed backup column fails linux.nginx closed (its
// findings not checked, none of their dispositions in the ledger, the other surfaces decided), a changed observation
// column fails every surface closed, a pass whose SQL fails over the change decides nothing, and a changed REST field
// leaves the findings decided and dns_inventory_current not read. Offline.
import { describe, expect, it } from "vitest";
import type { QueryResult } from "../src/adapters/zetaris.ts";
import { CATALOGUE } from "../src/catalogue/templates.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import * as Q from "../src/data/queries.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { LoopError, passStep } from "../src/loop/pass.ts";
import { PLAIN, Table, passView } from "../src/loop/present.ts";
import { EXPLAIN_MAX, explainQuery, planLine } from "../src/zetaris/explain.ts";
import { PASS_TABLES, affectedSurfaces, driftChanges, readSchemaGuard, restChanges, schemaColumns, schemaText } from "../src/zetaris/schema-guard.ts";
import policyBundle from "./fixtures/policy-bundle.json" with { type: "json" };
import { MemTracer } from "./fixtures/mem-tracer.ts";
import { PLAN, zetarisMeta, type MetaOptions } from "./fixtures/zetaris-meta.ts";

const TENANT = "client-a";
const AT = "2026-10-23T03:00:00.000Z";
const ZONES = ["f4e22adaf388c10bfac5955e3def837b", "0b7f00fb0edfd5de3519a10c7cd2901e", "8bd90e8468c3e735d775877e781d2959", "9385dafa5cba3b30a6e25d310d64aff3", "4bd739409f266f534f4f02c014c67379", "0ae0975a3f4547cd0f88ad2f6e70cbeb"].map((z) => `zone_${z}`);
const fake = (o: MetaOptions = {}) => ({ run: async (sql: string) => { const r = zetarisMeta(sql, { zones: ZONES, ...o }); if (!r) throw new Error(`unexpected ${sql}`); return r; } });
const describeOf = (rows: string[][]): QueryResult => ({ queryId: "q", columns: ["col_name", "data_type", "comment", "description", "tags"], rows: rows.map((r) => [...r, "", "", ""]), rowCount: rows.length, total: rows.length, latencyMs: 1, raw: {} });

describe("the expected columns", () => {
  it("are sql/schema.sql's, TEXT as string and INTEGER as integer, and every table the guard reads is one the pass's SQL names", () => {
    const cols = schemaColumns();
    expect([...cols.get("collection_run")!]).toEqual([
      ["run_id", "string"], ["tenant_id", "string"], ["surface", "string"], ["host", "string"], ["started_at", "string"], ["finished_at", "string"],
      ["expected_count", "integer"], ["observed_count", "integer"], ["status", "string"],
    ]);
    const sql = [...Object.values(Q).filter((v): v is string => typeof v === "string"), ...CATALOGUE.map((t) => t.sql)].join("\n");
    for (const t of PASS_TABLES) {
      expect(cols.has(t), t).toBe(true);
      expect(sql.includes(`{{t:${t}}}`), t).toBe(true);
    }
    expect(PASS_TABLES).toHaveLength(14);
  });
});

describe("the guard over fake DESCRIBE answers", () => {
  it("as expected: the 14 DRIFT tables and the 6 zone tables, no change, '20 tables as expected'", async () => {
    const g = await readSchemaGuard(fake(), { datasource: "DRIFT" });
    expect(g).toEqual({ tables: 20, changes: [] });
    expect(schemaText(g)).toBe("20 tables as expected");
    expect(affectedSurfaces(g)).toEqual(new Set());
  });

  it("a DRIFT column missing or of another type is a change; a column the schema lacks is not the pass's", () => {
    const want = schemaColumns().get("observation")!;
    const rows = [...want].map(([c, t]) => [c, c === "value_hash" ? "integer" : t]).filter(([c]) => c !== "refers_to_id");
    const changes = driftChanges("observation", describeOf([...rows, ["extra_col", "string"]]), "DRIFT");
    expect(changes).toEqual([
      { datasource: "DRIFT", table: "observation", column: "value_hash", want: "string", got: "integer" },
      { datasource: "DRIFT", table: "observation", column: "refers_to_id", want: "string", got: null },
    ]);
    expect(schemaText({ tables: 20, changes })).toBe("DRIFT.observation changed: value_hash, refers_to_id");
    expect(affectedSurfaces({ tables: 20, changes })).toBe("*");
  });

  it("a backup table feeds linux.nginx alone; the DNS record, audit and inventory tables feed linux.nginx and cloudflare.dns", async () => {
    const backup = await readSchemaGuard(fake({ drift: { backup_item: { value_hash: "integer" } } }), { datasource: "DRIFT" });
    expect(schemaText(backup)).toBe("DRIFT.backup_item changed: value_hash");
    expect(affectedSurfaces(backup)).toEqual(new Set(["linux.nginx"]));
    const dns = await readSchemaGuard(fake({ drift: { dns_record: { proxied: null } } }), { datasource: "DRIFT" });
    expect(affectedSurfaces(dns)).toEqual(new Set(["linux.nginx", "cloudflare.dns"]));
  });

  it("a REST field dns_live reads that changed type or is gone is a change of its zone table; other fields are left alone", () => {
    const rest = (fields: { name: string; type: string }[]) => describeOf([["result", JSON.stringify({ type: "array", elementType: { type: "struct", fields } })]]);
    expect(restChanges("zone_a", rest([{ name: "id", type: "string" }, { name: "type", type: "string" }, { name: "proxied", type: "boolean" }, { name: "ttl", type: "string" }]))).toEqual([]);
    expect(restChanges("zone_a", rest([{ name: "id", type: "string" }, { name: "type", type: "string" }, { name: "proxied", type: "string" }]))).toEqual([
      { datasource: "CLOUDFLARE", table: "zone_a", column: "result.proxied", want: "boolean", got: "string" },
    ]);
    expect(restChanges("zone_a", describeOf([["success", "\"boolean\""]])).map((c) => c.column)).toEqual(["result"]);
    expect(restChanges("zone_a", describeOf([["result", "{\"type\":\"struct\"}"]])).map((c) => c.column)).toEqual(["result"]);
  });

  it("a DESCRIBE that fails is a change of the whole table, never thrown", async () => {
    const failing = { run: async (sql: string) => { if (sql.endsWith("DRIFT.probe")) throw new Error("Zetaris 400: Table or view not found: DRIFT.probe"); return zetarisMeta(sql, { zones: [] })!; } };
    const g = await readSchemaGuard(failing, { datasource: "DRIFT" });
    expect(g.tables).toBe(14);
    expect(g.changes).toEqual([{ datasource: "DRIFT", table: "probe", column: "*", want: "described", got: "Zetaris 400: Table or view not found: DRIFT.probe" }]);
    expect(schemaText(g)).toBe("DRIFT.probe changed: not described");
    // change_window absent from an older store is no change: the pass's window read decides what its absence means
    const older = { run: async (sql: string) => { if (sql.endsWith("DRIFT.change_window")) throw new Error("Zetaris 400: Table or view not found: DRIFT.change_window"); return zetarisMeta(sql, { zones: [] })!; } };
    expect((await readSchemaGuard(older, { datasource: "DRIFT" })).changes).toEqual([]);
    expect((await readSchemaGuard(fake({ drift: { change_window: { until: null } } }), { datasource: "DRIFT" })).changes.map((c) => `${c.table}.${c.column}`)).toEqual(["change_window.until"]);
  });
});

describe("EXPLAIN QUERY AS", () => {
  it("traces the plan once, its first line as output and its text cut to 4,000 characters; a refusal is not_checked, never thrown", async () => {
    const long = { run: async () => ({ queryId: "q", columns: ["plan"], rows: [[`== Parsed Logical Plan ==\n${"x".repeat(10_000)}`]], rowCount: 1, total: 1, latencyMs: 1, raw: {} }) };
    const tracer = new MemTracer("explain_test", { model: "none" });
    const p = await explainQuery(long, "hero", "SELECT 1 AS a", { tracer });
    expect(p).toMatchObject({ query: "hero", status: "ok", firstLine: "== Parsed Logical Plan ==", chars: EXPLAIN_MAX });
    expect(planLine(p)).toBe("EXPLAIN hero: == Parsed Logical Plan == (4000 characters traced)");
    const line = tracer.events.find((e) => e.action === "explain")!;
    expect(line).toMatchObject({ agent: "zetaris", action: "explain", status: "ok", input_summary: "EXPLAIN QUERY AS hero", output_summary: "== Parsed Logical Plan ==" });
    expect(line.detail!.length).toBe(EXPLAIN_MAX);
    const refused = await explainQuery(fake({ explainError: "Zetaris 403: EXPLAIN QUERY is for administrators" }), "dns_live", "SELECT 1 AS a", { tracer });
    expect(refused).toEqual({ query: "dns_live", status: "not_checked", reason: "Zetaris 403: EXPLAIN QUERY is for administrators" });
    expect(tracer.events.filter((e) => e.action === "explain").map((e) => e.status)).toEqual(["ok", "not_checked"]);
    expect((await explainQuery(fake(), "bad", "DELETE FROM x")).status).toBe("not_checked");
  });
});

describe("the live pass step under the guard, over the policy fixture", () => {
  /** sql.js under Zetaris's name: the catalogue statements answered by the meta fake, the DQ reads by fixed rows, every SELECT by sql.js. */
  async function live(o: MetaOptions & { failOn?: string } = {}) {
    const own = await SqlJsEngine.create();
    own.loadBundle(structuredClone(policyBundle) as Parameters<SqlJsEngine["loadBundle"]>[0]);
    const dq = { queryId: "q", columns: ["decided_at", "adoptions", "in_force", "live", "current", "run_id"], rows: [[AT, "0", "0", "3", "3", "run-x"]], rowCount: 1, total: 1, latencyMs: 1, raw: {} };
    const engine = {
      name: "zetaris" as const, qualify: (t: string) => own.qualify(t),
      run: async (sql: string, opts?: Parameters<SqlJsEngine["run"]>[1]) => {
        const m = zetarisMeta(sql, { zones: ZONES, ...o });
        if (m) return m;
        if (sql.includes("drift_usl.")) return dq;
        if (o.failOn && sql.includes(o.failOn)) throw new Error(`Zetaris 400: cannot resolve ${o.failOn}.value_hash`);
        return own.run(sql, opts);
      },
    };
    return { own, layer: new DataLayer(engine) };
  }
  const rowOf = (r: Awaited<ReturnType<typeof passStep>>) => new Table({ ...PLAIN, width: 200 }).row("pass", passView(r, { datasource: "DRIFT", queries: 1, rows: 1, failed: 0 }), null);

  it("as expected: decided as on sql.js, the row's schema line '20 tables as expected', both plans traced once", async () => {
    const { own, layer } = await live();
    const tracer = new MemTracer("guard_test", { model: "none" });
    const r = await passStep(layer, { tenant: TENANT, ledger: null, decidedAt: AT, world: new DriftWorld("guard_test"), tracer });
    const lite = await passStep(new DataLayer(own), { tenant: TENANT, ledger: null, decidedAt: AT, world: new DriftWorld("guard_test") });
    expect(r.findings.map((f) => [f.id, f.verb])).toEqual(lite.findings.map((f) => [f.id, f.verb]));
    expect(r.notChecked).toEqual([]);
    expect(lite.schema).toBeUndefined();
    expect(rowOf(r)[2]).toBe("            schema    20 tables as expected");
    expect(r.summary).toContain("; schema: 20 tables as expected; EXPLAIN hero ok, EXPLAIN dns_live ok");
    expect(r.plans?.map((p) => p.status)).toEqual(["ok", "ok"]);
    expect(r.lines.filter((l) => l.startsWith("EXPLAIN "))).toEqual(["EXPLAIN hero: == Parsed Logical Plan == (" + PLAN.length + " characters traced)", "EXPLAIN dns_live: == Parsed Logical Plan == (" + PLAN.length + " characters traced)"]);
    expect(tracer.events.filter((e) => e.action === "explain").map((e) => e.input_summary)).toEqual(["EXPLAIN QUERY AS hero", "EXPLAIN QUERY AS dns_live"]);
    expect(tracer.events.filter((e) => e.input_summary === `schema ${TENANT}`).map((e) => [e.status, e.output_summary])).toEqual([["ok", "schema: 20 tables as expected"]]);
    own.close();
  });

  it("a changed backup column fails linux.nginx closed: its findings not checked and kept from the ledger, the DNS findings decided and recorded", async () => {
    const { own, layer } = await live({ drift: { backup_item: { value_hash: "integer" } } });
    const tracer = new MemTracer("guard_test", { model: "none" });
    const r = await passStep(layer, { tenant: TENANT, ledger: new MemoryLedger(own), decidedAt: AT, world: new DriftWorld("guard_test"), tracer });
    expect(r.notChecked!.length).toBeGreaterThan(0);
    expect(r.notChecked!.every((f) => f.finding.surface === "linux.nginx")).toBe(true);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings.every((f) => f.finding.surface !== "linux.nginx")).toBe(true);
    const stored = Q.objects(await new DataLayer(own).run(Q.DISPOSITIONS_SQL, {}, { limit: 100_000 })).filter((d) => d.decided_at === AT);
    expect(stored.map((d) => d.surface).sort()).toEqual(r.findings.map((f) => f.finding.surface).sort());
    expect(r.lines.filter((l) => l.startsWith("NOT CHECKED ")).length).toBe(r.notChecked!.length);
    expect(r.lines.find((l) => l.startsWith("NOT CHECKED "))).toMatch(/: schema: DRIFT\.backup_item changed: value_hash; nothing decided or recorded$/);
    expect(tracer.events.filter((e) => e.action === "check" && e.status === "not_checked" && e.input_summary?.startsWith("finding "))).toHaveLength(r.notChecked!.length);
    const row = rowOf(r);
    expect(row[2]).toBe("            schema    DRIFT.backup_item changed: value_hash");
    expect(row[3]).toBe(`                      ${r.notChecked!.length} findings not checked on linux.nginx: nothing decided or recorded`);
    own.close();
  });

  it("a changed observation column fails every surface closed: nothing decided, nothing recorded, the adoption read not made", async () => {
    const { own, layer } = await live({ drift: { observation: { value_hash: "integer" } } });
    const r = await passStep(layer, { tenant: TENANT, ledger: new MemoryLedger(own), decidedAt: AT, world: new DriftWorld("guard_test") });
    expect(r.findings).toEqual([]);
    expect(r.notChecked!.length).toBe(11);
    expect(Q.objects(await new DataLayer(own).run(Q.DISPOSITIONS_SQL, {}, { limit: 100_000 })).filter((d) => d.decided_at === AT)).toEqual([]);
    expect(r.adoptions).toEqual({ rule: "exception_in_force", error: "schema: DRIFT.observation changed: value_hash" });
    expect(r.dns).toEqual({ rule: "dns_inventory_current", error: "schema: DRIFT.observation changed: value_hash" });
    own.close();
  });

  it("when the pass's SQL fails over the changed table, the step decides nothing and says why, the schema first", async () => {
    const { own, layer } = await live({ drift: { backup_item: { value_hash: null } }, failOn: "backup_item" });
    await expect(passStep(layer, { tenant: TENANT, ledger: new MemoryLedger(own), decidedAt: AT, world: new DriftWorld("guard_test") }))
      .rejects.toThrow(new LoopError("decided nothing: schema: DRIFT.backup_item changed: value_hash; the pass's SQL failed over it: Zetaris 400: cannot resolve backup_item.value_hash"));
    expect(Q.objects(await new DataLayer(own).run(Q.DISPOSITIONS_SQL, {}, { limit: 100_000 })).filter((d) => d.decided_at === AT)).toEqual([]);
    own.close();
  });

  it("a changed REST field leaves every finding decided and dns_inventory_current not read, the schema line naming the zone table", async () => {
    const { own, layer } = await live({ rest: JSON.stringify({ type: "array", elementType: { type: "struct", fields: [{ name: "id", type: "string" }, { name: "type", type: "string" }] } }) });
    const r = await passStep(layer, { tenant: TENANT, ledger: null, decidedAt: AT, world: new DriftWorld("guard_test") });
    expect(r.notChecked).toEqual([]);
    expect(r.findings.length).toBe(11);
    expect(r.dns).toEqual({ rule: "dns_inventory_current", error: `schema: ${[...ZONES].sort().map((z) => `CLOUDFLARE.${z} changed: result.proxied`).join("; ")}` });
    expect(rowOf(r)[2]).toMatch(/^ {12}schema {4}CLOUDFLARE\.zone_0ae0975a3f4547cd0f88ad2f6e70cbeb changed: result\.proxied;/);
    own.close();
  });
});
