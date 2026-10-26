import { beforeAll, describe, expect, it } from "vitest";
import { dnsObservationRows } from "../src/collectors/cloudflare.ts";
import { DataLayer, assertSelectOnly, literal, type Engine } from "../src/data/layer.ts";
import { fingerprintRows, referentFingerprint } from "../src/data/fingerprint.ts";
import {
  HERO_SQL, auditSpan, changedSinceBackup, driftVsApproved, foundButDifferentSql, hero, listRuns, objects, observationsOf, orphanRecords, orphanVhosts,
  proxiedWithoutRealIp, proxySplit, resolutions, runComplete, wildcardWithoutRealIp,
} from "../src/data/queries.ts";
import { SCHEMA_TABLES, TABLE_NAMES } from "../src/data/schema.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import {
  COLUMNS, approvalId, copyId, dispositionId, probeId, ruleId, validationId,
  type Action, type ApprovedSetting, type CopyValidation, type Disposition, type Observation, type PolicyRule, type Probe, type ReferentFingerprint, type Ticket, type VaultCopy,
} from "../src/data/rows.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { PASS_WINDOW_MS, runPass } from "../src/pipeline.ts";
import { Redactor } from "../src/redactor.ts";
import bundle from "./fixtures/recorded-bundle.json" with { type: "json" };
import authored from "./fixtures/authored-bundle.json" with { type: "json" };
import {
  APEX_NAME, APEX_RECORD, DNS_RUN, CONFD_HOST, CONFD_ORIGIN, CONFD_RUN, QUEST_FILE, QUEST_HASH, SITES_HOST, SITES_ORIGIN, SITES_RUN, T, WWW_NAME, WWW_RECORD,
} from "./fixtures/catalogue-params.ts";

type B = typeof bundle;

/** An engine that only qualifies; render() never reaches run(). */
const bare: Engine = { name: "sqljs", qualify: (t) => t, run: async () => { throw new Error("not run"); } };

async function layerOf(b: Readonly<Record<string, unknown>>): Promise<DataLayer> {
  const engine = await SqlJsEngine.create();
  engine.loadBundle(b);
  return new DataLayer(engine);
}

describe("schema", () => {
  it("parses the eighteen tables of sql/schema.sql in DDL order; a table constraint line declares no column", () => {
    expect(TABLE_NAMES).toEqual([
      "collection_run", "observation", "approved_setting", "backup_snapshot", "backup_item", "dns_record", "audit_event", "inventory_asset",
      "policy_rule", "vault_copy", "copy_validation", "probe", "disposition", "action", "ticket", "referent_fingerprint", "finding_cause", "change_window",
    ]);
    expect(SCHEMA_TABLES.find((t) => t.name === "backup_item")?.columns).toEqual(["snapshot_id", "object_id", "setting_path", "value_hash"]);
    expect(SCHEMA_TABLES.find((t) => t.name === "observation")?.columns).toHaveLength(14);
    expect(SCHEMA_TABLES.find((t) => t.name === "referent_fingerprint")?.columns).toEqual(["obs_id", "dns_run_id", "fingerprint", "resolved_at"]);
    expect(SCHEMA_TABLES.find((t) => t.name === "policy_rule")?.columns).toEqual([
      "rule_id", "tenant_id", "surface", "object_glob", "setting_glob", "criticality", "lock", "on_drift", "on_no_copy", "hold_max_hours", "alert", "psa_priority", "version", "author", "since", "note",
    ]);
    expect(SCHEMA_TABLES.map((t) => t.columns.length)).toEqual([9, 14, 10, 6, 4, 10, 10, 7, 16, 10, 8, 10, 15, 15, 12, 4, 15, 11]);
    expect(SCHEMA_TABLES.flatMap((t) => t.columns).filter((c) => /^[A-Z]/.test(c))).toEqual([]);
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
    // the recorded bundle predates the eight tables of the design and carries the first eight only
    expect(Object.keys(counts)).toEqual(TABLE_NAMES.slice(0, 8));
    expect(TABLE_NAMES.slice(8).filter((t) => t in bundle)).toEqual([]);
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

describe("the eight tables of the design on sql.js: insertRows, then every column back in key order", () => {
  const H = (c: string) => `sha256:${c.repeat(64)}`;
  const rule: PolicyRule = {
    rule_id: ruleId("*", "linux.nginx", "/etc/nginx/conf.d/*.conf", "file", 1), tenant_id: "*", surface: "linux.nginx", object_glob: "/etc/nginx/conf.d/*.conf", setting_glob: "file",
    criticality: "critical", lock: 1, on_drift: "rollback", on_no_copy: "investigate_ticket", hold_max_hours: 24, alert: "on_fix", psa_priority: "P1", version: 1, author: "operator",
    since: "2026-10-25T00:00:00.000Z", note: null,
  };
  const copy: VaultCopy = { copy_id: copyId(CONFD_RUN, "/etc/nginx/nginx.conf"), tenant_id: T, surface: "linux.nginx", host: CONFD_HOST, object_id: "/etc/nginx/nginx.conf", run_id: CONFD_RUN, git_commit: "0123abcd", blob_sha256: H("c"), taken_at: "2026-10-24T07:59:30.000Z", source: "collector" };
  const val: CopyValidation = { validation_id: validationId(copy.copy_id, "nginx-t", "2026-10-24T08:10:00.000Z"), copy_id: copy.copy_id, tenant_id: T, validator: "nginx-t", result: "ok_with_gaps", missing_dependencies: "/etc/letsencrypt/options-ssl-nginx.conf", output_redacted: "", validated_at: "2026-10-24T08:10:00.000Z" };
  const probe: Probe = { probe_id: probeId("run-probe-1", "dns", WWW_NAME), run_id: "run-probe-1", tenant_id: T, kind: "dns", target: WWW_NAME, expected: "neither resolver returns the origin", observed: "1.1.1.1: ip-aaaaaa; 8.8.8.8: ip-aaaaaa", status: "ok", latency_ms: null, observed_at: "2026-10-24T08:11:00.000Z" };
  const disp: Disposition = {
    disposition_id: dispositionId(T, "linux.nginx", CONFD_HOST, "/etc/nginx/nginx.conf", "file", H("c"), "fnd-1", CONFD_RUN, "2026-10-24T08:12:00.000Z"), tenant_id: T, surface: "linux.nginx", host: CONFD_HOST, object_id: "/etc/nginx/nginx.conf",
    setting_path: "file", value_hash: H("c"), verb: "ADOPT", reason: "No approved value is on record.", expires_at: null, decided_by: "default", rule_id: null, finding_id: "fnd-1", run_id: CONFD_RUN, decided_at: "2026-10-24T08:12:00.000Z",
  };
  const action: Action = { action_id: "act-1", tenant_id: T, kind: "rollback_file", target: "/etc/nginx/nginx.conf", before_hash: H("d"), after_hash: H("c"), vault_commit: "0123abcd", verification: `${probe.probe_id}`, receipts: "", status: "done", reason: "restored to the approved copy at vault commit 0123abcd", record: `probe ${probe.probe_id}: dns ${WWW_NAME} ok`, started_at: "2026-10-24T08:13:00.000Z", finished_at: "2026-10-24T08:13:05.000Z", disposition_id: disp.disposition_id };
  const ticket: Ticket = { ticket_id: "tkt-1", tenant_id: T, psa: "github", external_id: "12", url: null, type: "change", priority: "P1", status: "closed", action_id: action.action_id, finding_id: "fnd-1", created_at: "2026-10-24T08:14:00.000Z", updated_at: "2026-10-24T08:15:00.000Z" };
  const fps: ReferentFingerprint[] = [
    { obs_id: "obs-b", dns_run_id: DNS_RUN, fingerprint: "", resolved_at: "2026-10-24T07:58:55.125Z" },
    { obs_id: "obs-a", dns_run_id: DNS_RUN, fingerprint: `${CONFD_ORIGIN},${SITES_ORIGIN}`, resolved_at: "2026-10-24T07:58:55.125Z" },
  ];
  const ROWS = { policy_rule: [rule], vault_copy: [copy], copy_validation: [val], probe: [probe], disposition: [disp], action: [action], ticket: [ticket], referent_fingerprint: fps } as const;
  const KEY: Record<keyof typeof ROWS, string> = {
    policy_rule: "rule_id", vault_copy: "copy_id", copy_validation: "validation_id", probe: "probe_id", disposition: "disposition_id", action: "action_id", ticket: "ticket_id", referent_fingerprint: "obs_id, dns_run_id",
  };
  const asText = (r: object): string[] => Object.values(r).map((v) => (v === null ? "" : String(v)));
  let engine: SqlJsEngine;
  let dl: DataLayer;

  beforeAll(async () => {
    engine = await SqlJsEngine.create();
    engine.loadBundle(bundle);
    dl = new DataLayer(engine);
  });

  it("every new table is empty on the recorded bundle", async () => {
    for (const t of Object.keys(ROWS)) expect((await dl.run(`SELECT COUNT(*) AS n FROM {{t:${t}}}`)).rows, t).toEqual([["0"]]);
  });

  it("insertRows writes each table in DDL column order and the DataLayer reads every column back, as strings, NULL as ''", async () => {
    for (const [t, rows] of Object.entries(ROWS) as [keyof typeof ROWS, readonly object[]][]) {
      expect(engine.insertRows(t, rows as never), t).toBe(rows.length);
      const r = await dl.run(`SELECT ${COLUMNS[t].join(", ")} FROM {{t:${t}}} ORDER BY ${KEY[t]}`);
      expect(r.columns, t).toEqual([...COLUMNS[t]]);
      const expected = [...rows].map(asText).sort((a, b) => (a.join("\u001f") < b.join("\u001f") ? -1 : 1));
      expect(r.rows, t).toEqual(expected);
    }
    expect((await dl.run("SELECT obs_id, fingerprint FROM {{t:referent_fingerprint}} ORDER BY obs_id, dns_run_id")).rows).toEqual([["obs-a", `${CONFD_ORIGIN},${SITES_ORIGIN}`], ["obs-b", ""]]);
    // the vault copy joins the observation run it was committed in, and the validation joins its copy
    const j = await dl.run("SELECT c.copy_id, v.result, r.surface FROM {{t:vault_copy}} c JOIN {{t:copy_validation}} v ON v.copy_id = c.copy_id JOIN {{t:collection_run}} r ON r.run_id = c.run_id ORDER BY c.copy_id");
    expect(j.rows).toEqual([[copy.copy_id, "ok_with_gaps", "linux.nginx"]]);
  });

  it("insertRows is idempotent on the natural key, refuses two different rows under one key, an unknown table, an unknown column and a non-canonical timestamp, and writes nothing from a refused call", async () => {
    for (const [t, rows] of Object.entries(ROWS) as [keyof typeof ROWS, readonly object[]][]) expect(engine.insertRows(t, rows as never), t).toBe(0);
    expect(engine.insertRows("referent_fingerprint", [{ ...fps[0], dns_run_id: "run-other" }, { ...fps[0], dns_run_id: "run-other" }])).toBe(1);
    expect(() => engine.insertRows("referent_fingerprint", [{ ...fps[0], obs_id: "obs-c" }, { ...fps[0], obs_id: "obs-c", fingerprint: "x" }])).toThrow(/two different rows share the key obs-c \/ /);
    expect(() => engine.insertRows("users" as never, [])).toThrow(/unknown table: users/);
    expect(() => engine.insertRows("ticket", [{ ...ticket, ticket_id: "tkt-2", bogus: 1 } as never])).toThrow(/ticket: unknown column bogus/);
    expect(() => engine.insertRows("policy_rule", [{ ...rule, rule_id: "rule-2", since: "2026-10-25T00:00:00Z" }])).toThrow(/policy_rule\.since: timestamps must be ISO 8601 UTC/);
    // a constraint failure inside the transaction rolls the whole call back
    expect(() => engine.insertRows("probe", [{ ...probe, probe_id: "probe-new" }, { ...probe, probe_id: "probe-null", target: null as never }])).toThrow(/sqljs: /);
    expect((await dl.run("SELECT COUNT(*) AS n FROM {{t:probe}}")).rows).toEqual([["1"]]);
    expect((await dl.run("SELECT COUNT(*) AS n FROM {{t:referent_fingerprint}}")).rows).toEqual([["3"]]);
  });

  it("loadBundle takes a bundle with the new table keys as well as one without them", async () => {
    const fresh = await SqlJsEngine.create();
    expect(fresh.loadBundle({ _note: "n", collection_run: [], policy_rule: [rule], referent_fingerprint: fps })).toEqual({ collection_run: 0, policy_rule: 1, referent_fingerprint: 2 });
    expect(() => fresh.loadBundle({ policy_rule: [{ ...rule, rule_id: "rule-3", since: "2026-10-25" }] })).toThrow(/bundle\.policy_rule\.since: timestamps must be/);
    const l = new DataLayer(fresh);
    expect((await l.run("SELECT rule_id, lock, since FROM {{t:policy_rule}} ORDER BY rule_id")).rows).toEqual([[rule.rule_id, "1", "2026-10-25T00:00:00.000Z"]]);
    fresh.close();
  });
});

describe("the detectors on sql.js: drift_vs_approved, changed_since_backup, found_but_different", () => {
  type Row = Record<string, string>;
  const fresh = async (b: Readonly<Record<string, unknown>>): Promise<{ engine: SqlJsEngine; dl: DataLayer }> => {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(b);
    return { engine, dl: new DataLayer(engine) };
  };
  const obsOf = (run: string, object: string, setting: string) => bundle.observation.find((o) => o.run_id === run && o.object_id === object && o.setting_path === setting)!;
  const H = (c: string) => `sha256:${c.repeat(64)}`;
  const approval = (o: Pick<Observation, "tenant_id" | "surface" | "host" | "object_id" | "setting_path">, value_hash: string, approved_at: string, by = "operator"): ApprovedSetting => ({
    approval_id: approvalId(o.tenant_id, o.host, o.object_id, o.setting_path, value_hash, approved_at), tenant_id: o.tenant_id, surface: o.surface, host: o.host,
    object_id: o.object_id, setting_path: o.setting_path, value_hash, approved_at, approved_by: by, note: null,
  });

  describe("drift_vs_approved", () => {
    const quest = obsOf(SITES_RUN, QUEST_FILE, "file");
    const sites = { tenant_id: T, run_id: SITES_RUN };

    it("the recorded bundle holds no approval, so no run drifts", async () => {
      const { dl } = await fresh(bundle);
      for (const run_id of [CONFD_RUN, SITES_RUN, DNS_RUN]) {
        const r = await driftVsApproved(dl, { tenant_id: T, run_id });
        expect(r.columns).toEqual(["surface", "host", "object_id", "setting_path", "value_hash", "value_redacted", "approved_hash", "approved_at", "approved_by", "refers_to_type", "refers_to_id", "observed_at"]);
        expect(r.rows, run_id).toEqual([]);
      }
    });

    it("an approval equal to the live hash gives no row; one with another hash gives exactly that setting", async () => {
      expect(quest.value_hash).toBe(QUEST_HASH);
      const same = await fresh(bundle);
      same.engine.insertRows("approved_setting", [approval(quest, QUEST_HASH, "2026-10-24T09:00:00.000Z")]);
      expect((await driftVsApproved(same.dl, sites)).rows).toEqual([]);
      const other = await fresh(bundle);
      other.engine.insertRows("approved_setting", [approval(quest, H("a"), "2026-10-24T09:00:00.000Z", "tech-1")]);
      expect((await driftVsApproved(other.dl, sites)).rows).toEqual([
        ["linux.nginx", SITES_HOST, QUEST_FILE, "file", QUEST_HASH, quest.value_redacted ?? "", H("a"), "2026-10-24T09:00:00.000Z", "tech-1", "", "", quest.observed_at],
      ]);
      // the other host's run carries no observation of that object, and the approval names this host only
      expect((await driftVsApproved(other.dl, { tenant_id: T, run_id: CONFD_RUN })).rows).toEqual([]);
    });

    it("only the latest approval of a setting counts: a newer equal one over an older different one gives no row, the reverse gives the newer hash", async () => {
      const healed = await fresh(bundle);
      healed.engine.insertRows("approved_setting", [approval(quest, H("a"), "2026-10-20T09:00:00.000Z"), approval(quest, QUEST_HASH, "2026-10-24T09:00:00.000Z")]);
      expect((await driftVsApproved(healed.dl, sites)).rows).toEqual([]);
      const moved = await fresh(bundle);
      moved.engine.insertRows("approved_setting", [approval(quest, QUEST_HASH, "2026-10-20T09:00:00.000Z"), approval(quest, H("b"), "2026-10-24T09:00:00.000Z")]);
      expect((await driftVsApproved(moved.dl, sites)).rows.map((r) => [r[3], r[6], r[7]])).toEqual([["file", H("b"), "2026-10-24T09:00:00.000Z"]]);
      // two approvals at one instant: the greater approval_id is the latest, so the answer is one row or none, never two
      const tie = await fresh(bundle);
      const [x, y] = [approval(quest, H("c"), "2026-10-24T09:00:00.000Z"), approval(quest, H("d"), "2026-10-24T09:00:00.000Z")].sort((a, b) => (a.approval_id < b.approval_id ? -1 : 1));
      tie.engine.insertRows("approved_setting", [x, y]);
      expect((await driftVsApproved(tie.dl, sites)).rows.map((r) => r[6])).toEqual([y.value_hash]);
    });

    it("one query for every surface: a DNS record's per-field approvals (host NULL) meet the DNS run's per-field observations", async () => {
      const red = new Redactor("test-salt");
      const dnsObs = bundle.dns_record.filter((d) => d.run_id === DNS_RUN).flatMap((d) =>
        dnsObservationRows(red, { id: d.record_id, name: d.name, type: d.type, content: d.content, ttl: d.ttl ?? undefined, proxied: d.proxied === null ? undefined : d.proxied === 1 }, d));
      expect(dnsObs).toHaveLength(5 * 58);
      const www = (f: string) => dnsObs.find((o) => o.object_id === WWW_RECORD && o.setting_path === f)!;
      const b = structuredClone(bundle) as B;
      const { engine, dl } = await fresh(b);
      engine.insertRows("observation", dnsObs);
      engine.insertRows("approved_setting", [
        ...["type", "name", "ttl"].map((f) => approval(www(f), www(f).value_hash, "2026-10-24T09:00:00.000Z")),
        approval(www("content"), red.fingerprint("host-000000.quest"), "2026-10-24T09:00:00.000Z"),
        approval(www("proxied"), red.fingerprint("0"), "2026-10-24T09:00:00.000Z"),
      ]);
      expect((await driftVsApproved(dl, { tenant_id: T, run_id: DNS_RUN })).rows).toEqual([
        ["cloudflare.dns", "", WWW_RECORD, "content", www("content").value_hash, APEX_NAME, red.fingerprint("host-000000.quest"), "2026-10-24T09:00:00.000Z", "operator", "dns_name", APEX_NAME, "2026-10-24T07:58:55.125Z"],
        ["cloudflare.dns", "", WWW_RECORD, "proxied", red.fingerprint("1"), "1", red.fingerprint("0"), "2026-10-24T09:00:00.000Z", "operator", "", "", "2026-10-24T07:58:55.125Z"],
      ]);
      // the host runs are untouched by DNS approvals
      expect((await driftVsApproved(dl, sites)).rows).toEqual([]);
    });
  });

  describe("changed_since_backup", () => {
    const newest = (host: string) => [...bundle.backup_snapshot].filter((s) => s.host === host).sort((a, b) => (a.taken_at < b.taken_at ? 1 : -1))[0];
    const fileRows = (run: string) => bundle.observation.filter((o) => o.run_id === run && o.setting_path === "file");
    const confd = { tenant_id: T, run_id: CONFD_RUN, host: CONFD_HOST };
    const sites = { tenant_id: T, run_id: SITES_RUN, host: SITES_HOST };

    it("the recorded estate: every nginx file equals the newest export's copy; the certbot renewal configs are absent from the newest export (6 on the conf.d host, 5 on the sites-enabled host)", async () => {
      const { dl } = await fresh(bundle);
      for (const [p, run, absent, same] of [[confd, CONFD_RUN, 6, 26], [sites, SITES_RUN, 5, 17]] as const) {
        const r = await changedSinceBackup(dl, p);
        expect(r.columns).toEqual(["host", "object_id", "setting_path", "value_hash", "backup_hash", "snapshot_id", "taken_at", "observed_at"]);
        const rows = objects(r);
        expect(rows, p.host).toHaveLength(absent);
        expect(rows.every((x) => x.backup_hash === "" && x.object_id.startsWith("/etc/letsencrypt/renewal/") && x.setting_path === "file" && x.host === p.host)).toBe(true);
        expect(new Set(rows.map((x) => `${x.snapshot_id} ${x.taken_at}`))).toEqual(new Set([`${newest(p.host).snapshot_id} ${newest(p.host).taken_at}`]));
        expect(fileRows(run).length - rows.length).toBe(same);
        expect(fileRows(run).filter((o) => o.object_id.startsWith("/etc/nginx/"))).toHaveLength(same);
      }
      expect(newest(CONFD_HOST).taken_at).toBe("2026-10-24T03:40:41.921Z");
      expect(newest(SITES_HOST).taken_at).toBe("2026-10-24T03:40:03.985Z");
    });

    it("a copy with other bytes is a row with the copy's hash, a missing copy a row with backup_hash ''", async () => {
      const snap = newest(SITES_HOST).snapshot_id;
      const differ = structuredClone(bundle) as B;
      differ.backup_item.find((i) => i.snapshot_id === snap && i.object_id === QUEST_FILE)!.value_hash = H("e");
      const d = objects(await changedSinceBackup((await fresh(differ)).dl, sites));
      expect(d).toHaveLength(6);
      expect(d.filter((x) => x.object_id === QUEST_FILE).map((x) => [x.value_hash, x.backup_hash])).toEqual([[QUEST_HASH, H("e")]]);
      const missing = structuredClone(bundle) as B;
      missing.backup_item = missing.backup_item.filter((i) => !(i.snapshot_id === snap && i.object_id === QUEST_FILE));
      expect(objects(await changedSinceBackup((await fresh(missing)).dl, sites)).filter((x) => x.object_id === QUEST_FILE).map((x) => x.backup_hash)).toEqual([""]);
    });

    it("the newest snapshot alone is read, ties on taken_at going to the greater snapshot_id; a host without a snapshot gives no row", async () => {
      const tie = structuredClone(bundle) as B;
      tie.backup_snapshot.push({ ...newest(SITES_HOST), snapshot_id: "snap-ffffffffffffffff" });
      const t = objects(await changedSinceBackup((await fresh(tie)).dl, sites));
      expect(t).toHaveLength(fileRows(SITES_RUN).length);
      expect(new Set(t.map((x) => `${x.snapshot_id} ${x.backup_hash}`))).toEqual(new Set(["snap-ffffffffffffffff "]));
      const none = structuredClone(bundle) as B;
      none.backup_snapshot = none.backup_snapshot.filter((s) => s.host !== SITES_HOST);
      expect((await changedSinceBackup((await fresh(none)).dl, sites)).rows).toEqual([]);
      expect((await changedSinceBackup((await fresh(none)).dl, confd)).rows).toHaveLength(6);
    });
  });

  describe("fingerprintRows", () => {
    const run = { run_id: "run-dns-x", started_at: "2026-10-24T02:05:00.000Z" };

    it("one row per dns_name observation in obs_id order: the contents sorted in code-unit order and joined by ','; '' for a name with none", () => {
      const obs = [{ obs_id: "obs-b", refers_to_type: "dns_name" }, { obs_id: "obs-a", refers_to_type: "dns_name" }, { obs_id: "obs-c", refers_to_type: "ip" }, { obs_id: "obs-d", refers_to_type: null }];
      const res = [{ obs_id: "obs-a", content: "ip-bbbbbb" }, { obs_id: "obs-a", content: "2001:db8::1" }, { obs_id: "obs-a", content: "ip-aaaaaa" }];
      expect(fingerprintRows(obs, res, run)).toEqual([
        { obs_id: "obs-a", dns_run_id: "run-dns-x", fingerprint: "2001:db8::1,ip-aaaaaa,ip-bbbbbb", resolved_at: "2026-10-24T02:05:00.000Z" },
        { obs_id: "obs-b", dns_run_id: "run-dns-x", fingerprint: "", resolved_at: "2026-10-24T02:05:00.000Z" },
      ]);
      expect(referentFingerprint(["ip-b", "ip-a"])).toBe(["ip-b", "ip-a"].sort().join(","));
    });

    it("refuses a resolution of an observation it was not given", () => {
      expect(() => fingerprintRows([{ obs_id: "obs-a", refers_to_type: "dns_name" }], [{ obs_id: "obs-z", content: "ip-aaaaaa" }], run)).toThrow(/obs-z/);
      expect(() => fingerprintRows([{ obs_id: "obs-c", refers_to_type: "ip" }], [{ obs_id: "obs-c", content: "ip-aaaaaa" }], run)).toThrow(/obs-c/);
    });
  });

  describe("found_but_different over referent_fingerprint, against the World Model", () => {
    /** The pass's own pairing (src/pipeline.ts nearestDns): the passing DNS run of the tenant nearest in time, within PASS_WINDOW_MS. */
    const nearestDns = (passing: Row[], r: Row): Row | undefined => {
      const gap = (d: Row) => Math.abs(Date.parse(d.started_at) - Date.parse(r.started_at));
      const best = passing.filter((d) => d.tenant_id === r.tenant_id && d.surface === "cloudflare.dns").sort((a, b) => gap(a) - gap(b))[0];
      return best && gap(best) <= PASS_WINDOW_MS ? best : undefined;
    };

    /** The pass over the bundle with its World Model kept, referent_fingerprint written from the same rows, and each group's (latest, previous) passing runs. */
    async function fingerprinted(b: Readonly<Record<string, unknown>>) {
      const { engine, dl } = await fresh(b);
      const world = new DriftWorld("fbd");
      const pass = await runPass(dl, { world });
      const runs = objects(await listRuns(dl));
      const passing: Row[] = [];
      for (const r of runs) if ((await runComplete(dl, r.run_id)).total === 0) passing.push(r);
      const ok = new Set(passing.map((r) => r.run_id));
      const written: ReferentFingerprint[] = [];
      const obsByRun = new Map<string, Row[]>();
      for (const r of passing.filter((x) => x.host !== "")) {
        obsByRun.set(r.run_id, objects(await observationsOf(dl, r.run_id)));
        const dns = nearestDns(passing, r);
        if (!dns) continue;
        const rows = fingerprintRows(obsByRun.get(r.run_id)!, objects(await resolutions(dl, { run_id: r.run_id, dns_run_id: dns.run_id })), dns);
        engine.insertRows("referent_fingerprint", rows);
        written.push(...rows);
      }
      const groups = new Map<string, Row[]>();
      for (const r of runs.filter((x) => x.host !== "")) groups.set(`${r.tenant_id}|${r.surface}|${r.host}`, [...(groups.get(`${r.tenant_id}|${r.surface}|${r.host}`) ?? []), r]);
      const pairs: { latest: Row; prev: Row }[] = [];
      for (const g of groups.values()) {
        const latest = g[g.length - 1];
        const prev = g.filter((r) => ok.has(r.run_id) && r.run_id !== latest.run_id).at(-1);
        if (ok.has(latest.run_id) && prev) pairs.push({ latest, prev });
      }
      const sid = (o: Row) => world.settingId({ tenantId: o.tenant_id, surface: o.surface, objectId: o.object_id, settingPath: o.setting_path });
      /** What DriftWorld.foundButDifferent flags: every dns_name setting of a latest run whose bytes equal the previous run's. */
      const flagged: string[][] = [];
      const sql: string[][] = [];
      const sqlRows: string[][] = [];
      for (const { latest, prev } of pairs) {
        for (const cur of obsByRun.get(latest.run_id)!.filter((o) => o.refers_to_type === "dns_name")) {
          const p = obsByRun.get(prev.run_id)!.find((o) => o.object_id === cur.object_id && o.setting_path === cur.setting_path);
          if (p && p.value_hash === cur.value_hash && world.foundButDifferent(sid(cur), p.observed_at, cur.observed_at).changed) flagged.push([cur.host, cur.object_id, cur.setting_path]);
        }
        const r = await foundButDifferentSql(dl, { tenant_id: latest.tenant_id, run_id: latest.run_id, prev_run_id: prev.run_id });
        sqlRows.push(...r.rows);
        sql.push(...objects(r).map((x) => [x.host, x.object_id, x.setting_path]));
      }
      const hero = pass.findings.filter((f) => f.finding.class === "found_but_different").map((f) => [f.finding.host ?? "", f.finding.object_id, f.finding.setting_path]);
      return { engine, dl, world, pairs, written, obsByRun, sid, flagged, sql, sqlRows, hero };
    }

    it("the fingerprint each row carries is the one the pass stored on the referent in the World Model", async () => {
      const f = await fingerprinted(authored);
      expect(f.written.map((w) => [w.obs_id, w.dns_run_id, w.fingerprint])).toEqual([
        ["obs-0001", "run-dns-1020", "198.51.100.10"],
        ["obs-0003", "run-dns-1023", "203.0.113.77"],
      ]);
      for (const w of f.written) {
        const o = [...f.obsByRun.values()].flat().find((x) => x.obs_id === w.obs_id)!;
        expect(f.world.fingerprintAt(f.sid(o), o.observed_at) ?? "", w.obs_id).toBe(w.fingerprint);
      }
    });

    it("on the authored fixture the SQL returns exactly the settings DriftWorld.foundButDifferent flags, and the pass reports them as found_but_different", async () => {
      const f = await fingerprinted(authored);
      expect(f.pairs.map((p) => [p.latest.run_id, p.prev.run_id])).toEqual([["run-etc-7f1c-1023", "run-etc-7f1c-1020"], ["run-nginx-7f1c-1023", "run-nginx-7f1c-1020"]]);
      expect(f.flagged).toEqual([["host-7f1c", "/etc/nginx/conf.d/app.conf", "server.location./.proxy_pass"]]);
      expect(f.sql).toEqual(f.flagged);
      expect(f.hero).toEqual(f.flagged);
      const hash = authored.observation.find((o) => o.obs_id === "obs-0003")!.value_hash;
      expect(f.sqlRows).toEqual([[
        "host-7f1c", "/etc/nginx/conf.d/app.conf", "server.location./.proxy_pass", hash, "app.example.invalid",
        "obs-0001", "run-dns-1020", "198.51.100.10", "2026-10-20T02:01:01.000Z", "obs-0003", "run-dns-1023", "203.0.113.77", "2026-10-23T02:01:01.000Z",
      ]]);
    });

    it("the record back at its old address, or bytes that changed, and both sides agree there is nothing", async () => {
      const back = structuredClone(authored);
      back.dns_record.find((d) => d.run_id === "run-dns-1023" && d.record_id === "rec-a1")!.content = "198.51.100.10";
      const b = await fingerprinted(back);
      expect([b.flagged, b.sql, b.hero]).toEqual([[], [], []]);
      const edited = structuredClone(authored);
      edited.observation.find((o) => o.obs_id === "obs-0003")!.value_hash = H("f");
      const e = await fingerprinted(edited);
      expect([e.flagged, e.sql, e.hero]).toEqual([[], [], []]);
    });

    it("each observation's fingerprint is its row against the latest DNS run it was fingerprinted against", async () => {
      const f = await fingerprinted(authored);
      const params = { tenant_id: "client-a", run_id: "run-nginx-7f1c-1023", prev_run_id: "run-nginx-7f1c-1020" };
      // an older row for the current observation that equals the previous fingerprint changes nothing
      f.engine.insertRows("referent_fingerprint", [{ obs_id: "obs-0003", dns_run_id: "run-dns-1020", fingerprint: "198.51.100.10", resolved_at: "2026-10-20T02:05:00.000Z" }]);
      expect(objects(await foundButDifferentSql(f.dl, params)).map((x) => [x.dns_run_id, x.after_fingerprint])).toEqual([["run-dns-1023", "203.0.113.77"]]);
      // a later one does: the name resolves as it did before, so the setting is no longer found-but-different
      f.engine.insertRows("referent_fingerprint", [{ obs_id: "obs-0003", dns_run_id: "run-dns-1024", fingerprint: "198.51.100.10", resolved_at: "2026-10-24T02:05:00.000Z" }]);
      expect((await foundButDifferentSql(f.dl, params)).rows).toEqual([]);
    });

    it("the recorded bundle holds no referent_fingerprint row and one run per host, so nothing is found-but-different there", async () => {
      const { dl } = await fresh(bundle);
      for (const run_id of [CONFD_RUN, SITES_RUN]) expect((await foundButDifferentSql(dl, { tenant_id: T, run_id, prev_run_id: run_id })).rows).toEqual([]);
    });
  });
});
