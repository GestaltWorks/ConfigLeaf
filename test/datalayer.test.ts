import { beforeAll, describe, expect, it } from "vitest";
import { DataLayer, assertSelectOnly, literal, type Engine } from "../src/data/layer.ts";
import {
  HERO_SQL, auditSpan, hero, orphanRecords, orphanVhosts, proxiedWithoutRealIp, proxySplit, runComplete, wildcardWithoutRealIp,
} from "../src/data/queries.ts";
import { SCHEMA_TABLES, TABLE_NAMES } from "../src/data/schema.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import bundle from "../sample/bundle.json" with { type: "json" };
import { APEX_NAME, APEX_RECORD, DNS_RUN, CONFD_HOST, CONFD_ORIGIN, CONFD_RUN, SITES_HOST, SITES_ORIGIN, SITES_RUN, T, WWW_NAME, WWW_RECORD } from "./fixtures/catalogue-params.ts";

type B = typeof bundle;

/** An engine that only qualifies; render() never reaches run(). */
const bare: Engine = { name: "sqljs", qualify: (t) => t, run: async () => { throw new Error("not run"); } };

async function layerOf(b: Readonly<Record<string, unknown>>): Promise<DataLayer> {
  const engine = await SqlJsEngine.create();
  engine.loadBundle(b);
  return new DataLayer(engine);
}

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

describe("catalogue queries on the recorded bundle (sql.js)", () => {
  let dl: DataLayer;
  let counts: Record<string, number>;
  const confd = { tenant_id: T, run_id: CONFD_RUN, dns_run_id: DNS_RUN };
  const sites = { tenant_id: T, run_id: SITES_RUN, dns_run_id: DNS_RUN };

  beforeAll(async () => {
    const engine = await SqlJsEngine.create();
    counts = engine.loadBundle(bundle);
    dl = new DataLayer(engine);
  });

  it("loads every table in the bundle: four runs, two hosts, one DNS run, one audit run", () => {
    expect(Object.keys(counts).sort()).toEqual([...TABLE_NAMES].sort());
    expect(counts.observation).toBe(bundle.observation.length);
    expect([...bundle.collection_run].sort((a, b) => (a.started_at < b.started_at ? -1 : 1)).map((r) => [r.surface, r.host, r.status])).toEqual([
      ["cloudflare.dns", null, "complete"], ["cloudflare.audit", null, "complete"], ["linux.nginx", CONFD_HOST, "complete"], ["linux.nginx", SITES_HOST, "complete"],
    ]);
  });

  it("hero: nothing on the recorded estate, because every address record of a name a vhost serves lands on an inventory host", async () => {
    for (const p of [confd, sites]) {
      const r = await hero(dl, p);
      expect(r.columns).toEqual(["host", "object_id", "setting_path", "upstream_name", "resolves_to", "dns_observed_at"]);
      expect(r.rows).toEqual([]);
      expect(r.total).toBe(0);
    }
  });

  it("hero: an address record moved off the inventory is found, once per server block that names it, and the result comes from the rows", async () => {
    const b = structuredClone(bundle) as B;
    b.dns_record.push({ record_id: "rec-moved", run_id: DNS_RUN, tenant_id: T, zone: "host-4c795e.quest", name: WWW_NAME, type: "A", content: "203.0.113.9", ttl: 300, proxied: 0, observed_at: "2026-10-24T07:58:55.125Z" });
    const r = await hero(await layerOf(b), sites);
    expect(r.rows).toEqual([
      [SITES_HOST, "/etc/nginx/sites-available/host-4c795e.quest", `server[${APEX_NAME}:443].server_name[${WWW_NAME}]`, WWW_NAME, "203.0.113.9", "2026-10-24T07:58:55.125Z"],
      [SITES_HOST, "/etc/nginx/sites-available/host-4c795e.quest", `server[${APEX_NAME}:80].server_name[${WWW_NAME}]`, WWW_NAME, "203.0.113.9", "2026-10-24T07:58:55.125Z"],
    ]);
    // the same record back on the inventory host: nothing
    b.dns_record.find((d) => d.record_id === "rec-moved")!.content = SITES_ORIGIN;
    expect((await hero(await layerOf(b), sites)).rows).toEqual([]);
  });

  it("runComplete: no rows for the four complete runs; a run short of its population, or never asserting one, fails", async () => {
    for (const r of bundle.collection_run) expect((await runComplete(dl, r.run_id)).rows, r.run_id).toEqual([]);
    const b = structuredClone(bundle) as B;
    const run = b.collection_run.find((r) => r.run_id === SITES_RUN)!;
    run.observed_count = 13;
    run.status = "partial";
    expect((await runComplete(await layerOf(b), SITES_RUN)).rows).toEqual([[SITES_RUN, T, "linux.nginx", SITES_HOST, "14", "13", "partial"]]);
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
    const agg = await dl.run("SELECT COUNT(*) AS n, MAX(ttl) AS t, MIN(proxied) AS p, SUM(proxied) AS s FROM {{t:dns_record}}");
    expect(agg.columns).toEqual(["n", "t", "p", "s"]);
    expect(agg.rows).toEqual([[String(bundle.dns_record.length), String(Math.max(...bundle.dns_record.map((d) => d.ttl ?? 0))), "0", String(bundle.dns_record.filter((d) => d.proxied === 1).length)]]);
    expect(agg.rows[0]).toEqual(["58", "3600", "0", "24"]);
    const nul = await dl.run("SELECT host, finished_at FROM {{t:collection_run}} WHERE run_id = {{p:r}}", { r: DNS_RUN });
    expect(nul.rows).toEqual([["", bundle.collection_run.find((r) => r.run_id === DNS_RUN)!.finished_at]]);
  });

  it("limit binds rows but total still counts", async () => {
    const r = await dl.run("SELECT obs_id FROM {{t:observation}} ORDER BY obs_id", {}, { limit: 2 });
    expect(r.rows).toEqual(bundle.observation.map((o) => o.obs_id).sort().slice(0, 2).map((id) => [id]));
    expect(r.rowCount).toBe(2);
    expect(r.total).toBe(bundle.observation.length);
  });

  it("a parameter carrying a second statement is rendered as one literal: it runs as data, returns no rows and drops nothing", async () => {
    const r = await dl.run("SELECT 1 FROM {{t:observation}} WHERE host = {{p:h}}", { h: "x'; DROP TABLE observation; --" });
    expect(r.rows).toEqual([]);
    expect((await dl.run("SELECT COUNT(*) AS n FROM {{t:observation}}")).rows).toEqual([[String(bundle.observation.length)]]);
    // a ';' inside a value (a DMARC TXT) is data too, so one odd parameter no longer aborts a pass
    expect((await dl.run("SELECT COUNT(*) AS n FROM {{t:observation}} WHERE value_redacted <> {{p:v}}", { v: "v=DMARC1; p=reject" })).rows)
      .toEqual([[String(bundle.observation.filter((o) => o.value_redacted !== null).length)]]);
  });

  it("engine refuses a second statement and an unknown bundle table; a ';' inside a literal runs", async () => {
    await expect(dl.engine.run("SELECT 1; SELECT 2")).rejects.toThrow(/one statement/);
    expect((await dl.engine.run("SELECT 'a; b' AS s")).rows).toEqual([["a; b"]]);
    const fresh = await SqlJsEngine.create();
    expect(() => fresh.loadBundle({ users: [] })).toThrow(/not a schema table: users/);
    expect(() => fresh.loadBundle({ backup_item: [{ snapshot_id: "s", nope: 1 }] })).toThrow(/unknown column nope/);
  });

  describe("the estate survey", () => {
    it("proxy_split: the one proxied CNAME whose target is a direct address record; proxying the apex too, or un-proxying the CNAME, ends it", async () => {
      const r = await proxySplit(dl, { tenant_id: T, dns_run_id: DNS_RUN });
      expect(r.columns).toEqual(["zone", "proxied_name", "proxied_record_id", "target_name", "target_type", "target_content", "target_record_id", "observed_at"]);
      expect(r.rows).toEqual([["host-4c795e.quest", WWW_NAME, WWW_RECORD, APEX_NAME, "A", SITES_ORIGIN, APEX_RECORD, "2026-10-24T07:58:55.125Z"]]);
      const proxiedApex = structuredClone(bundle) as B;
      proxiedApex.dns_record.find((d) => d.record_id === APEX_RECORD)!.proxied = 1;
      expect((await proxySplit(await layerOf(proxiedApex), { tenant_id: T, dns_run_id: DNS_RUN })).rows).toEqual([]);
      const directWww = structuredClone(bundle) as B;
      directWww.dns_record.find((d) => d.record_id === WWW_RECORD)!.proxied = 0;
      expect((await proxySplit(await layerOf(directWww), { tenant_id: T, dns_run_id: DNS_RUN })).rows).toEqual([]);
    });

    it("proxied_without_real_ip: proxied names, a CNAME followed one level, matched to the enabled block that serves them; the one block with set_real_ip_from is not among them", async () => {
      const e = await proxiedWithoutRealIp(dl, confd);
      expect(e.columns).toEqual(["record_id", "zone", "name", "type", "origin", "host", "obs_id", "object_id", "setting_path", "value_hash", "value_redacted", "observed_at", "dns_observed_at"]);
      expect(e.rowCount).toBe(10);
      expect(new Set(e.rows.map((r) => r[4]))).toEqual(new Set([CONFD_ORIGIN]));
      expect(e.rows.every((r) => r[10] === "absent" && r[5] === CONFD_HOST && r[8].endsWith(".real_ip"))).toBe(true);
      const f = await proxiedWithoutRealIp(dl, sites);
      expect(f.rowCount).toBe(9);
      expect(f.rows.filter((r) => r[2] === WWW_NAME).map((r) => [r[3], r[4], r[8]])).toEqual([
        ["CNAME", SITES_ORIGIN, `server[${APEX_NAME}:443].real_ip`],
        ["CNAME", SITES_ORIGIN, `server[${APEX_NAME}:80].real_ip`],
      ]);
      // the apex of the .com zone is proxied and served by the block that trusts 22 ranges: only its :80 block, which trusts none, is listed
      expect(f.rows.filter((r) => r[2] === "host-525a57.com").map((r) => r[8])).toEqual(["server[host-525a57.com:80].real_ip"]);
      expect(bundle.observation.find((o) => o.run_id === SITES_RUN && o.object_id === "/etc/nginx/sites-available/host-525a57.com" && o.setting_path === "server[host-525a57.com:443].real_ip")?.value_redacted).toBe("trusted:22 header:CF-Connecting-IP scope:server");
      // give the www block a list and it drops out
      const trusted = structuredClone(bundle) as B;
      for (const o of trusted.observation) if (o.setting_path === `server[${APEX_NAME}:443].real_ip`) o.value_redacted = "trusted:22 header:CF-Connecting-IP scope:server";
      expect((await proxiedWithoutRealIp(await layerOf(trusted), sites)).rows.filter((r) => r[2] === WWW_NAME).map((r) => r[8])).toEqual([`server[${APEX_NAME}:80].real_ip`]);
    });

    it("wildcard_without_real_ip: the proxied wildcard lands on the host whose http level and every enabled block trust nothing; an http-level list ends it", async () => {
      const e = await wildcardWithoutRealIp(dl, confd);
      expect(e.rows.map((r) => [r[2], r[4], r[5], r[7], r[8], r[10]])).toEqual([["*.host-503b27.ai", CONFD_ORIGIN, CONFD_HOST, "/etc/nginx/nginx.conf", "http.real_ip", "absent"]]);
      expect((await wildcardWithoutRealIp(dl, sites)).rows).toEqual([]);
      const httpList = structuredClone(bundle) as B;
      for (const o of httpList.observation) if (o.run_id === CONFD_RUN && o.setting_path === "http.real_ip") o.value_redacted = "trusted:22 header:CF-Connecting-IP scope:http";
      expect((await wildcardWithoutRealIp(await layerOf(httpList), confd)).rows).toEqual([]);
    });

    it("orphan_record: three records land on a host with no enabled block naming them, one per zone case the survey predicted; an enabled block for the name ends it", async () => {
      const e = await orphanRecords(dl, confd);
      expect(e.columns).toEqual(["record_id", "zone", "name", "type", "content", "origin", "proxied", "host", "observed_at"]);
      expect(e.rows.map((r) => [r[2], r[3], r[6], r[7]])).toEqual([["host-3fef97.club", "A", "0", CONFD_HOST]]);
      const f = await orphanRecords(dl, sites);
      expect(f.rows.map((r) => [r[2], r[3], r[6], r[7]])).toEqual([["host-50b116.com", "A", "1", SITES_HOST], ["host-c10fff.com", "A", "1", SITES_HOST]]);
      // the same block exists in the live file and in its .bak and .ready copies: the name must be added to the enabled one
      const served = structuredClone(bundle) as B;
      const enabled = served.observation.find((o) => o.run_id === CONFD_RUN && o.setting_path === "server[host-c9c1ae.club:443].enabled" && o.value_redacted === "1")!;
      const block = served.observation.find((o) => o.run_id === CONFD_RUN && o.object_id === enabled.object_id && o.setting_path === "server[host-c9c1ae.club:443].server_name[host-c9c1ae.club]")!;
      served.observation.push({ ...block, obs_id: "obs-added", setting_path: "server[host-c9c1ae.club:443].server_name[host-3fef97.club]", value_redacted: "host-3fef97.club", refers_to_id: "host-3fef97.club" } as never);
      expect((await orphanRecords(await layerOf(served), confd)).rows).toEqual([]);
    });

    it("orphan_vhost: one file on disk and one enabled vhost with two names have no record; a wildcard over the name's zone covers it", async () => {
      expect((await orphanVhosts(dl, confd)).rows).toEqual([]);
      const f = await orphanVhosts(dl, sites);
      expect(f.columns).toEqual(["obs_id", "host", "object_id", "setting_path", "server_name", "enabled", "value_hash", "observed_at"]);
      expect(f.rows.map((r) => [r[2], r[4], r[5]])).toEqual([
        ["/etc/nginx/sites-available/host-085e02.com", "host-085e02.com", "0"],
        ["/etc/nginx/sites-available/host-9ac4f1.com", "host-89f6e7.com", "1"],
        ["/etc/nginx/sites-available/host-9ac4f1.com", "host-9ac4f1.com", "1"],
      ]);
      // the .bak copy of the enabled file names the same two: it is not a second finding
      expect(bundle.observation.some((o) => o.object_id.startsWith("/etc/nginx/sites-available/host-9ac4f1.com.bak") && o.refers_to_id === "host-9ac4f1.com")).toBe(true);
      // a wildcard record over the zone the vhost's .zone sibling names covers both names
      const zone = bundle.observation.find((o) => o.run_id === SITES_RUN && o.setting_path === "server[host-9ac4f1.com:443].server_name[host-9ac4f1.com].zone")!.value_redacted!;
      expect(zone).toMatch(/^host-[0-9a-f]{6}\.com$/);
      const covered = structuredClone(bundle) as B;
      covered.dns_record.push({ record_id: "rec-wild", run_id: DNS_RUN, tenant_id: T, zone, name: `*.${zone}`, type: "A", content: SITES_ORIGIN, ttl: 1, proxied: 0, observed_at: "2026-10-24T07:58:55.125Z" });
      expect((await orphanVhosts(await layerOf(covered), sites)).rows.map((r) => r[4])).toEqual(["host-085e02.com"]);
      // the confd vhosts under the proxied wildcard's zone are covered the same way: that is why confd lists none
      expect(bundle.observation.filter((o) => o.run_id === CONFD_RUN && o.setting_path.endsWith("].zone") && o.value_redacted === "host-503b27.ai").length).toBeGreaterThan(0);
    });

    it("an AAAA record lands on an inventory host too: with the host's IPv6 address in the inventory, a record no enabled block names is an orphan; without it the record lands nowhere", async () => {
      const v6 = "2001:db8::6"; // a documentation address passes the redactor, as a stored inventory address would
      const b = structuredClone(bundle) as B;
      b.dns_record.push({ record_id: "rec-v6", run_id: DNS_RUN, tenant_id: T, zone: "host-525a57.com", name: "host-000006.com", type: "AAAA", content: v6, ttl: 300, proxied: 0, observed_at: "2026-10-24T07:58:55.125Z" });
      const before = (await orphanRecords(await layerOf(b), sites)).rows.map((r) => r[2]);
      expect(before).not.toContain("host-000006.com");
      b.inventory_asset.push({ asset_id: "asset-v6", tenant_id: T, host: SITES_HOST, address: v6, kind: "vps", source: "ssh", observed_at: "2026-10-24T07:59:23.713Z" });
      const after = await orphanRecords(await layerOf(b), sites);
      expect(after.rows.filter((r) => r[2] === "host-000006.com").map((r) => [r[3], r[4], r[5], r[7]])).toEqual([["AAAA", v6, v6, SITES_HOST]]);
      expect(after.rows.length).toBe(before.length + 1);
    });

    it("audit span: the log's reach for the tenant", async () => {
      const r = await auditSpan(dl, T);
      expect(r.columns).toEqual(["first_at", "last_at", "n"]);
      expect(r.rows).toEqual([["2026-03-20T01:29:03.000Z", bundle.audit_event.map((e) => e.occurred_at).sort().at(-1)!, String(bundle.audit_event.length)]]);
    });
  });
});
