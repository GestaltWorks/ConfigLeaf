import { beforeAll, describe, expect, it } from "vitest";
import { DataLayer, assertSelectOnly, literal, type Engine } from "../src/data/layer.ts";
import { HERO_SQL, hero, runComplete } from "../src/data/queries.ts";
import { SCHEMA_TABLES, TABLE_NAMES } from "../src/data/schema.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import bundle from "../sample/bundle.json" with { type: "json" };

/** An engine that only qualifies; render() never reaches run(). */
const bare: Engine = { name: "sqljs", qualify: (t) => t, run: async () => { throw new Error("not run"); } };

describe("schema", () => {
  it("parses the eight tables of sql/schema.sql in DDL order", () => {
    expect(TABLE_NAMES).toEqual(["collection_run", "observation", "approved_setting", "backup_snapshot", "backup_item", "dns_record", "audit_event", "inventory_asset"]);
    expect(SCHEMA_TABLES.find((t) => t.name === "backup_item")?.columns).toEqual(["snapshot_id", "object_id", "setting_path", "value_hash"]);
    expect(SCHEMA_TABLES.find((t) => t.name === "observation")?.columns).toHaveLength(14);
  });
});

describe("render", () => {
  const dl = new DataLayer(bare);

  it("quotes strings with ' doubled, writes numbers plain and null as NULL", () => {
    expect(dl.render("SELECT 1 FROM {{t:observation}} WHERE a = {{p:s}} AND b = {{p:n}} AND c IS {{p:z}}", { s: "O'Neil", n: 42, z: null }))
      .toBe("SELECT 1 FROM observation WHERE a = 'O''Neil' AND b = 42 AND c IS NULL");
  });

  it("qualifies tables through the engine", () => {
    const q = new DataLayer({ ...bare, qualify: (t) => `DRIFT.${t}` });
    expect(q.render("SELECT 1 FROM {{t:dns_record}} d JOIN {{t:observation}} o ON 1 = 1")).toBe("SELECT 1 FROM DRIFT.dns_record d JOIN DRIFT.observation o ON 1 = 1");
  });

  it("rejects an unknown table", () => {
    expect(() => dl.render("SELECT 1 FROM {{t:users}}")).toThrow(/unknown table: users/);
  });

  it("rejects a missing parameter", () => {
    expect(() => dl.render("SELECT {{p:x}} FROM {{t:observation}}", {})).toThrow(/missing parameter: x/);
  });

  it("rejects a parameter that is not string, number or null", () => {
    expect(() => dl.render("SELECT {{p:x}}", { x: true as never })).toThrow(/unsupported parameter type: boolean/);
    expect(() => dl.render("SELECT {{p:x}}", { x: undefined as never })).toThrow(/unsupported parameter type: undefined/);
    expect(() => literal(Number.NaN)).toThrow(/unsupported parameter/);
  });

  it("rejects a malformed placeholder in the template; braces inside a parameter value are data", () => {
    expect(() => dl.render("SELECT 1 FROM {{table:observation}}")).toThrow(/malformed placeholder/);
    expect(() => dl.render("SELECT 1 FROM {{t:observation}} WHERE a = {{p:x}", { x: 1 })).toThrow(/malformed placeholder/);
    expect(dl.render("SELECT {{p:v}} FROM {{t:observation}}", { v: "{{ x }}" })).toBe("SELECT '{{ x }}' FROM observation");
  });
});

describe("assertSelectOnly", () => {
  it("accepts one SELECT; DML words, semicolons and double quotes inside a literal are data", () => {
    expect(() => assertSelectOnly("SELECT 'drop create' AS w, approved_at FROM approved_setting WHERE note = 'O''Neil'")).not.toThrow();
    expect(() => assertSelectOnly("SELECT 1 FROM observation WHERE value_redacted = 'v=DMARC1; p=reject' OR note = 'say \"hi\"'")).not.toThrow();
    expect(() => assertSelectOnly(HERO_SQL.replace(/\{\{t:(\w+)\}\}/g, "$1").replace(/\{\{p:\w+\}\}/g, "'x'"))).not.toThrow();
  });

  it("rejects a second statement", () => {
    expect(() => assertSelectOnly("SELECT 1; SELECT 2")).toThrow(/semicolon/);
    expect(() => assertSelectOnly("SELECT 1;")).toThrow(/semicolon/);
  });

  it("rejects DML and DDL", () => {
    expect(() => assertSelectOnly("DELETE FROM observation")).toThrow(/only SELECT/);
    expect(() => assertSelectOnly("INSERT INTO observation (obs_id) VALUES ('x')")).toThrow(/only SELECT/);
    expect(() => assertSelectOnly("SELECT 1 FROM observation WHERE 1 = 1 UNION ALL SELECT 1 FROM observation DROP TABLE observation")).toThrow(/forbidden keyword: DROP/);
    expect(() => assertSelectOnly("SELECT 1 FROM observation WHERE x IN (SELECT 1) ATTACH DATABASE 'x' AS y")).toThrow(/forbidden keyword: ATTACH/);
  });

  it("rejects comments", () => {
    expect(() => assertSelectOnly("SELECT 1 FROM observation -- WHERE 1 = 1")).toThrow(/comment/);
    expect(() => assertSelectOnly("SELECT /* x */ 1 FROM observation")).toThrow(/comment/);
  });

  it("rejects double quotes: a \"x'\" token would hide a UNION, a comment and a bare table from the literal strip", () => {
    expect(() => assertSelectOnly(`SELECT "x'" AS a FROM observation WHERE 1 = 0 UNION ALL SELECT COUNT(*) FROM approved_setting -- '`)).toThrow(/double quotes/);
    expect(() => assertSelectOnly('SELECT "host" FROM observation')).toThrow(/double quotes/);
    expect(() => assertSelectOnly("SELECT 'x' \"y'\" FROM observation WHERE a = 'b'")).toThrow(/double quotes/);
  });
});

describe("catalogue queries on the sample bundle (sql.js)", () => {
  let dl: DataLayer;
  let counts: Record<string, number>;

  beforeAll(async () => {
    const engine = await SqlJsEngine.create();
    counts = engine.loadBundle(bundle);
    dl = new DataLayer(engine);
  });

  it("loads every table in the bundle", () => {
    expect(Object.keys(counts).sort()).toEqual([...TABLE_NAMES].sort());
    expect(counts.observation).toBe(bundle.observation.length);
  });

  it("hero: exactly the one vhost whose upstream now resolves outside the inventory", async () => {
    const r = await hero(dl, { tenant_id: "client-a", run_id: "run-nginx-7f1c-1023", dns_run_id: "run-dns-1023" });
    expect(r.columns).toEqual(["host", "object_id", "setting_path", "upstream_name", "resolves_to", "dns_observed_at"]);
    expect(r.rows).toEqual([["host-7f1c", "/etc/nginx/conf.d/app.conf", "server.location./.proxy_pass", "app.example.invalid", "203.0.113.77", "2026-10-23T02:05:00.000Z"]]);
    expect(r.rowCount).toBe(1);
    expect(r.total).toBe(1);
  });

  it("hero: nothing at the earlier DNS run, when the record still pointed at an inventory host", async () => {
    const r = await hero(dl, { tenant_id: "client-a", run_id: "run-nginx-7f1c-1020", dns_run_id: "run-dns-1020" });
    expect(r.rows).toEqual([]);
    expect(r.columns).toHaveLength(6);
  });

  it("runComplete: no rows for a complete run, one for the partial run", async () => {
    expect((await runComplete(dl, "run-nginx-7f1c-1023")).rows).toEqual([]);
    const bad = await runComplete(dl, "run-nginx-2b9e-1023");
    expect(bad.rows).toEqual([["run-nginx-2b9e-1023", "client-a", "linux.nginx", "host-2b9e", "3", "2", "partial"]]);
  });

  it("runComplete: a run that never asserted its population fails the gate, and so does a host run whose stored rows fall short of its own count", async () => {
    const fresh = await SqlJsEngine.create();
    fresh.loadBundle({
      collection_run: [
        { run_id: "r-null", tenant_id: "t", surface: "linux.etc", started_at: "2026-10-23T00:00:00.000Z", status: "complete" },
        { run_id: "r-short", tenant_id: "t", surface: "linux.etc", host: "h", started_at: "2026-10-23T00:00:00.000Z", expected_count: 2, observed_count: 2, status: "complete" },
        { run_id: "r-dns", tenant_id: "t", surface: "cloudflare.dns", started_at: "2026-10-23T00:00:00.000Z", expected_count: 2, observed_count: 2, status: "complete" },
      ],
    });
    const l = new DataLayer(fresh);
    expect((await runComplete(l, "r-null")).rows).toEqual([["r-null", "t", "linux.etc", "", "", "", "complete"]]);
    // reports 2 observed, stored 0: the self-report is not taken on trust
    expect((await runComplete(l, "r-short")).rows).toEqual([["r-short", "t", "linux.etc", "h", "2", "2", "complete"]]);
    // a DNS run's rows live in dns_record, so the stored-count condition is host surfaces only
    expect((await runComplete(l, "r-dns")).rows).toEqual([]);
  });

  it("loadBundle refuses a timestamp outside the canonical millisecond form; NULL stays allowed where the schema allows it", async () => {
    const fresh = await SqlJsEngine.create();
    expect(() => fresh.loadBundle({ collection_run: [{ run_id: "r", tenant_id: "t", surface: "linux.etc", started_at: "2026-10-23T00:00:00Z", status: "complete" }] })).toThrow(/collection_run\.started_at: timestamps must be .* got 2026-10-23T00:00:00Z/);
    expect(fresh.loadBundle({ collection_run: [{ run_id: "r", tenant_id: "t", surface: "linux.etc", started_at: "2026-10-23T00:00:00.000Z", finished_at: null, status: "complete" }] })).toEqual({ collection_run: 1 });
  });

  it("normalises like Zetaris: strings only, null -> '', integers without decimals", async () => {
    const agg = await dl.run("SELECT COUNT(*) AS n, MAX(ttl) AS t, MIN(proxied) AS p FROM {{t:dns_record}}");
    expect(agg.columns).toEqual(["n", "t", "p"]);
    expect(agg.rows).toEqual([["6", "3600", "0"]]);
    const nul = await dl.run("SELECT host, finished_at FROM {{t:collection_run}} WHERE run_id = {{p:r}}", { r: "run-dns-1023" });
    expect(nul.rows).toEqual([["", "2026-10-23T02:05:01.000Z"]]);
  });

  it("limit binds rows but total still counts", async () => {
    const r = await dl.run("SELECT obs_id FROM {{t:observation}} ORDER BY obs_id", {}, { limit: 2 });
    expect(r.rows).toEqual([["obs-0001"], ["obs-0002"]]);
    expect(r.rowCount).toBe(2);
    expect(r.total).toBe(bundle.observation.length);
  });

  it("a parameter carrying a second statement is rendered as one literal: it runs as data, returns no rows and drops nothing", async () => {
    const r = await dl.run("SELECT 1 FROM {{t:observation}} WHERE host = {{p:h}}", { h: "x'; DROP TABLE observation; --" });
    expect(r.rows).toEqual([]);
    expect((await dl.run("SELECT COUNT(*) AS n FROM {{t:observation}}")).rows).toEqual([[String(bundle.observation.length)]]);
    // a ';' inside a value (a DMARC TXT) is data too, so one odd parameter no longer aborts a pass
    expect((await dl.run("SELECT COUNT(*) AS n FROM {{t:observation}} WHERE value_redacted <> {{p:v}}", { v: "v=DMARC1; p=reject" })).rows).toEqual([[String(bundle.observation.length)]]);
  });

  it("engine refuses a second statement and an unknown bundle table; a ';' inside a literal runs", async () => {
    await expect(dl.engine.run("SELECT 1; SELECT 2")).rejects.toThrow(/one statement/);
    expect((await dl.engine.run("SELECT 'a; b' AS s")).rows).toEqual([["a; b"]]);
    const fresh = await SqlJsEngine.create();
    expect(() => fresh.loadBundle({ users: [] })).toThrow(/not a schema table: users/);
    expect(() => fresh.loadBundle({ backup_item: [{ snapshot_id: "s", nope: 1 }] })).toThrow(/unknown column nope/);
  });
});
