// The Store against the live drift-pg, in a throwaway schema test_<random> created here and dropped in
// afterAll, so the public schema Zetaris reads as DRIFT is never touched. That half is skipped, with one
// line, without DATABASE_URL. The static half (rows.ts against sql/schema.sql, ids, the fromEnv refusal,
// error scrubbing, the bundle format and the export pass) always runs. The rows are the hand-authored
// fixture (test/fixtures/authored-bundle.json, the hero story): small, and its hero row is known.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.ts"; // loads .env into process.env
import { DataLayer } from "../src/data/layer.ts";
import { hero } from "../src/data/queries.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { SCHEMA_TABLES, TABLE_NAMES } from "../src/data/schema.ts";
import {
  COLUMNS, KEYS, REDACT, assetId, copyId, dispositionId, eventId, isTimestampColumn, obsId, probeId, ruleId, runId, snapshotId, stableId, validationId,
  type AuditEvent, type DnsRecord, type InventoryAsset, type Observation, type TableName,
} from "../src/data/rows.ts";
import { Store, TABLES, formatBundle, scrub, toBundle, writeBundle, type Tables } from "../src/data/store.ts";
import { loadPolicyFile } from "../src/policy/load.ts";
import { Redactor } from "../src/redactor.ts";
import bundle from "./fixtures/authored-bundle.json" with { type: "json" };

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SAMPLE_FILE = path.join(ROOT, "test", "fixtures", "authored-bundle.json");
const REAL_FILE = path.join(ROOT, "sample", "bundle.json");
const url = process.env.DATABASE_URL;
if (!url) console.log("store: live Postgres half skipped (set DATABASE_URL in .env to run it)");

type Rec = Record<string, unknown>;
const sample = bundle as unknown as Record<string, Rec[]>;
/** The fixture's rows of one table; a table the fixture predates (policy_rule and the other seven of the design) has none. */
const fixtureRows = (t: TableName): Rec[] => sample[t] ?? [];
const key = (t: TableName, r: Rec) => KEYS[t].map((k) => String(r[k])).join("\u001f");
const sorted = (t: TableName, rows: Rec[]) => [...rows].sort((a, b) => (key(t, a) < key(t, b) ? -1 : key(t, a) > key(t, b) ? 1 : 0));
const sampleTables = (): Tables => Object.fromEntries(TABLES.map((t) => [t, fixtureRows(t)])) as unknown as Tables;

async function heroRows(b: Readonly<Record<string, unknown>>) {
  const engine = await SqlJsEngine.create();
  engine.loadBundle(b);
  const r = await hero(new DataLayer(engine), { tenant_id: "client-a", run_id: "run-nginx-7f1c-1023", dns_run_id: "run-dns-1023" });
  engine.close();
  return r.rows;
}

describe("rows.ts", () => {
  it("lists every table and column of sql/schema.sql in DDL order", () => {
    expect(TABLES).toEqual(TABLE_NAMES);
    for (const t of SCHEMA_TABLES) expect([...COLUMNS[t.name as TableName]]).toEqual(t.columns);
    for (const t of TABLES) for (const k of KEYS[t]) expect(COLUMNS[t]).toContain(k);
  });

  it("matches the sample bundle: every row carries exactly its table's columns", () => {
    for (const t of TABLES) for (const r of fixtureRows(t)) expect(Object.keys(r)).toEqual([...COLUMNS[t]]);
  });

  it("derives ids deterministically: same parts same id, any part changed or shifted a different one", () => {
    const a = obsId("run-1", "/etc/nginx/conf.d/app.conf", "server.listen");
    expect(a).toMatch(/^obs-[0-9a-f]{16}$/);
    expect(obsId("run-1", "/etc/nginx/conf.d/app.conf", "server.listen")).toBe(a);
    expect(obsId("run-2", "/etc/nginx/conf.d/app.conf", "server.listen")).not.toBe(a);
    expect(obsId("run-1", "/etc/nginx/conf.d/app.conf", "server.listen[1]")).not.toBe(a);
    expect(obsId("ab", "c", "d")).not.toBe(obsId("a", "bc", "d"));
    expect(runId("client-a", "linux.nginx", null, "2026-10-24T03:00:00.000Z")).toMatch(/^run-[0-9a-f]{16}$/);
    expect(eventId("client-a", "cloudflare", "x")).not.toBe(eventId("client-b", "cloudflare", "x"));
  });

  it("the eight tables of the design: keys, redacted columns, timestamp columns and id helpers", () => {
    expect(TABLES.slice(8)).toEqual(["policy_rule", "vault_copy", "copy_validation", "probe", "disposition", "action", "ticket", "referent_fingerprint"]);
    expect(KEYS.referent_fingerprint).toEqual(["obs_id", "dns_run_id"]);
    expect(Object.fromEntries(TABLES.slice(8).map((t) => [t, Object.keys(REDACT[t])]))).toEqual({
      policy_rule: ["object_glob", "setting_glob", "author", "note"], vault_copy: ["host", "object_id"], copy_validation: ["missing_dependencies", "output_redacted"],
      probe: ["target", "expected", "observed"], disposition: ["host", "object_id", "reason"], action: ["target"], ticket: ["url"], referent_fingerprint: [],
    });
    expect(COLUMNS.policy_rule.filter(isTimestampColumn)).toEqual(["since"]);
    expect(COLUMNS.disposition.filter(isTimestampColumn)).toEqual(["expires_at", "decided_at"]);
    expect(ruleId("*", "linux.nginx", "/etc/nginx/conf.d/*.conf", "file", 1)).toBe(stableId("rule", "*", "linux.nginx", "/etc/nginx/conf.d/*.conf", "file", "1"));
    expect(ruleId("*", "linux.nginx", "/etc/nginx/conf.d/*.conf", "file", 2)).not.toBe(ruleId("*", "linux.nginx", "/etc/nginx/conf.d/*.conf", "file", 1));
    expect(copyId("run-1", "/etc/nginx/nginx.conf")).toMatch(/^copy-[0-9a-f]{16}$/);
    expect(copyId("run-1", "/etc/nginx/nginx.conf")).toBe(stableId("copy", "run-1", "/etc/nginx/nginx.conf"));
    expect(validationId("copy-1", "nginx-t", "2026-10-24T03:00:00.000Z")).toBe(stableId("val", "copy-1", "nginx-t", "2026-10-24T03:00:00.000Z"));
    expect(probeId("run-p", "http", "host-0a1b2c.com")).toBe(stableId("probe", "run-p", "http", "host-0a1b2c.com"));
    const d = dispositionId("client-a", "linux.nginx", null, "/etc/nginx/nginx.conf", "file", `sha256:${"0".repeat(64)}`, "fnd-1", "run-1");
    expect(d).toBe(stableId("disp", "client-a", "linux.nginx", null, "/etc/nginx/nginx.conf", "file", `sha256:${"0".repeat(64)}`, "fnd-1", "run-1"));
    expect(dispositionId("client-a", "linux.nginx", null, "/etc/nginx/nginx.conf", "file", `sha256:${"1".repeat(64)}`, "fnd-1", "run-1")).not.toBe(d);
  });
});

describe("Store, no database", () => {
  it("fromEnv refuses without DATABASE_URL, and refuses a schema that is not a lowercase identifier", () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => Store.fromEnv()).toThrow(/DATABASE_URL is not set/);
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
    if (saved) expect(() => Store.fromEnv({ schema: "public; DROP" })).toThrow(/lowercase identifier/);
  });

  it("scrubs a connection-string password from error text", () => {
    const s = scrub("connect failed for postgres://drift:not-a-real-pw-7Q@127.0.0.1:15432/drift");
    expect(s).not.toContain("not-a-real-pw-7Q");
    expect(s).toContain("postgres://drift:<redacted>@127.0.0.1:15432/drift");
  });

  it("formatBundle is the house format: it reproduces the authored fixture and the exported sample/bundle.json byte for byte", () => {
    expect(formatBundle(bundle)).toBe(readFileSync(SAMPLE_FILE, "utf8").replace(/\r\n/g, "\n"));
    const real = readFileSync(REAL_FILE, "utf8").replace(/\r\n/g, "\n");
    expect(formatBundle(JSON.parse(real) as Record<string, unknown>)).toBe(real);
  });

  it("toBundle: the second redaction pass leaves the redacted sample unchanged; a value over 2 kB is nulled and its row kept", () => {
    const { bundle: out, stats } = toBundle(sampleTables(), new Redactor("test-salt"), "n");
    expect(stats.changed).toBe(0);
    expect(stats.dropped).toBe(0);
    expect(Object.keys(out)).toEqual(["_note", ...TABLE_NAMES]);
    for (const t of TABLES) expect(out[t]).toEqual(sorted(t, fixtureRows(t)));

    const big = { ...sample.observation[0], obs_id: "obs-big", value_redacted: "allow 198.51.100.0/24; ".repeat(90) } as unknown as Observation;
    const leak = { ...sample.observation[1], obs_id: "obs-leak", setting_path: "server.return", value_redacted: "proxy_pass http://app.bluefin-logistics-zz9q.com:8080" } as unknown as Observation;
    const r = toBundle({ ...sampleTables(), observation: [...(sample.observation as unknown as Observation[]), big, leak] }, new Redactor("test-salt"), "n");
    expect(r.stats.dropped).toBe(1);
    expect(r.stats.changed).toBe(1);
    expect(r.bundle.observation.find((o) => o.obs_id === "obs-big")?.value_redacted).toBeNull();
    const leaked = r.bundle.observation.find((o) => o.obs_id === "obs-leak");
    expect(leaked?.value_redacted).toMatch(/^proxy_pass http:\/\/host-[0-9a-f]{6}\.com:8080$/);
    expect(leaked?.setting_path).toBe("server.return");
  });
});

describe.skipIf(!url)("Store, live drift-pg (throwaway schema)", () => {
  const schema = `test_${randomBytes(4).toString("hex")}`;
  const dir = mkdtempSync(path.join(tmpdir(), "drift-store-"));
  let admin: pg.Pool;
  let store: Store;
  const count = async (t: TableName, where = "TRUE"): Promise<number> => Number((await admin.query(`SELECT COUNT(*) AS n FROM ${schema}.${t} WHERE ${where}`)).rows[0].n);

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    store = Store.fromEnv({ schema });
    await store.applySchema();
  });

  afterAll(async () => {
    await store?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applySchema creates the sixteen tables in the throwaway schema, and a second apply changes nothing", async () => {
    await store.applySchema();
    const r = await admin.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name", [schema]);
    expect(r.rows.map((x) => x.table_name).sort()).toEqual([...TABLE_NAMES].sort());
    expect(r.rows).toHaveLength(16);
  });

  it("loadBundle writes every sample row once; a second load writes nothing, raises nothing and duplicates nothing", async () => {
    const first = await store.loadBundle(bundle);
    for (const t of TABLES) expect(first[t] ?? 0).toBe(fixtureRows(t).length);
    const second = await store.loadBundle(bundle);
    for (const t of TABLES) expect(second[t] ?? 0).toBe(0);
    for (const t of TABLES) expect(await count(t)).toBe(fixtureRows(t).length);
  });

  it("readAll returns every row as stored: strings, integers as numbers, NULL as null", async () => {
    const tables = await store.readAll();
    for (const t of TABLES) expect(tables[t]).toEqual(sorted(t, fixtureRows(t)));
  });

  it("writeBundle writes the bundle shape the sample loader takes, and the hero query finds the same row on it", async () => {
    const out = path.join(dir, "bundle.json");
    const stats = await writeBundle(store, out, { redactor: new Redactor("test-salt"), note: "test export" });
    expect(stats.changed).toBe(0);
    expect(stats.dropped).toBe(0);
    for (const t of TABLES) expect(stats.counts[t]).toBe(fixtureRows(t).length);
    const written = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(["_note", ...TABLE_NAMES]);
    expect(written._note).toBe("test export");
    for (const t of TABLES) for (const r of written[t] as Rec[]) expect(Object.keys(r)).toEqual([...COLUMNS[t]]);
    expect(await heroRows(written)).toEqual(await heroRows(bundle));
    expect((await heroRows(written)).length).toBe(1);
  });

  it("npm run export:bundle (the script itself) writes the same file and prints row counts", () => {
    const a = path.join(dir, "bundle.json");
    const b = path.join(dir, "cli.json");
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/export-bundle.ts", "--schema", schema, "--out", b, "--note", "test export"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    expect(r.stderr).not.toMatch(/export failed/);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`export: collection_run ${sample.collection_run.length}, observation ${sample.observation.length},`);
    expect(r.stdout).toContain("second redaction pass changed 0 field(s); 0 value_redacted over 2 kB nulled");
    expect(readFileSync(b, "utf8")).toBe(readFileSync(a, "utf8"));
  }, 60_000);

  const T = "client-t";
  const started = "2026-10-24T03:00:00.000Z";
  const run = runId(T, "linux.nginx", "host-t1", started);

  it("beginRun inserts the run as running, uncounted and unfinished; finishRun completes it exactly once", async () => {
    await store.beginRun({ run_id: run, tenant_id: T, surface: "linux.nginx", host: "host-t1", started_at: started, expected_count: 2 });
    const q = () => admin.query(`SELECT status, finished_at, expected_count, observed_count FROM ${schema}.collection_run WHERE run_id = $1`, [run]);
    expect((await q()).rows).toEqual([{ status: "running", finished_at: null, expected_count: 2, observed_count: null }]);
    await expect(store.beginRun({ run_id: run, tenant_id: T, surface: "linux.nginx", host: "host-t1", started_at: started, expected_count: 2 })).rejects.toThrow(/already exists/);
    await store.finishRun(run, 2, "complete", "2026-10-24T03:00:05.000Z");
    expect((await q()).rows).toEqual([{ status: "complete", finished_at: "2026-10-24T03:00:05.000Z", expected_count: 2, observed_count: 2 }]);
    await expect(store.finishRun(run, 2, "complete")).rejects.toThrow(/not running/);
    await expect(store.finishRun("run-unknown", 0, "failed")).rejects.toThrow(/not running/);
    await expect(store.beginRun({ run_id: "run-badts", tenant_id: T, surface: "linux.nginx", host: null, started_at: "2026-10-24T03:00:00Z", expected_count: 1 })).rejects.toThrow(/millisecond form/);
    expect(await count("collection_run", `tenant_id = '${T}'`)).toBe(1);
  });

  it("typed inserts are idempotent: a re-insert writes 0 rows, raises nothing, duplicates nothing", async () => {
    const obs = (setting: string, value: string): Observation => ({
      obs_id: obsId(run, "/etc/nginx/conf.d/t.conf", setting), run_id: run, tenant_id: T, surface: "linux.nginx", host: "host-t1",
      object_id: "/etc/nginx/conf.d/t.conf", setting_path: setting, value_hash: `sha256:${createHash("sha256").update(value).digest("hex")}`, value_redacted: value,
      refers_to_type: null, refers_to_id: null, observed_at: "2026-10-24T03:00:01.000Z", source: "ssh", authority: 100,
    });
    const o = [obs("server.listen", "443 ssl"), obs("server.server_name", "t.example.invalid")];
    expect(await store.insertObservations(o)).toBe(2);
    expect(await store.insertObservations(o)).toBe(0);
    expect(await count("observation", `run_id = '${run}'`)).toBe(2);

    // dns_record has no key in the DDL: the store reads (run_id, record_id) first
    const dnsRun = runId(T, "cloudflare.dns", null, started);
    const rec = (id: string, content: string): DnsRecord => ({ record_id: id, run_id: dnsRun, tenant_id: T, zone: "example.invalid", name: "t.example.invalid", type: "A", content, ttl: 300, proxied: 1, observed_at: "2026-10-24T03:01:00.000Z" });
    expect(await store.insertDnsRecords([rec("r1", "198.51.100.20"), rec("r2", "198.51.100.21"), rec("r2", "198.51.100.21")])).toBe(2);
    expect(await store.insertDnsRecords([rec("r1", "198.51.100.20"), rec("r2", "198.51.100.21")])).toBe(0);
    await expect(store.insertDnsRecords([rec("r3", "198.51.100.22"), rec("r3", "198.51.100.23")])).rejects.toThrow(/two different rows share the key/);
    expect(await count("dns_record", `run_id = '${dnsRun}'`)).toBe(2);

    const ev: AuditEvent = { event_id: eventId(T, "cloudflare", "vendor-1"), tenant_id: T, source: "cloudflare", actor: "user-0a1b2c", action: "rec_set", resource_type: "dns_record", resource_id: "r1", old_value: "198.51.100.19", new_value: "198.51.100.20", occurred_at: "2026-10-24T02:00:00.000Z" };
    expect(await store.insertAuditEvents([ev])).toBe(1);
    expect(await store.insertAuditEvents([ev])).toBe(0);

    const asset = (observed_at: string, host = "host-t1"): InventoryAsset => ({ asset_id: assetId(T, "198.51.100.20"), tenant_id: T, host, address: "198.51.100.20", kind: "vps", source: "inventory.csv", observed_at });
    expect(await store.upsertInventory([asset("2026-10-24T03:02:00.000Z")])).toBe(1);
    expect(await store.upsertInventory([asset("2026-10-24T03:02:00.000Z")])).toBe(0);
    expect(await store.upsertInventory([asset("2026-10-23T03:02:00.000Z", "host-older")])).toBe(0); // older: observed_at never moves back, nor does the host
    expect(await store.upsertInventory([asset("2026-10-25T03:02:00.000Z")])).toBe(1);
    expect((await admin.query(`SELECT observed_at, host FROM ${schema}.inventory_asset WHERE tenant_id = $1`, [T])).rows).toEqual([{ observed_at: "2026-10-25T03:02:00.000Z", host: "host-t1" }]);
    // the address re-homed to another host: a newer observation moves the host with the time
    expect(await store.upsertInventory([asset("2026-10-26T03:02:00.000Z", "host-t2")])).toBe(1);
    expect((await admin.query(`SELECT observed_at, host FROM ${schema}.inventory_asset WHERE tenant_id = $1`, [T])).rows).toEqual([{ observed_at: "2026-10-26T03:02:00.000Z", host: "host-t2" }]);

    const snap = snapshotId(T, "host-t1", "etckeeper", "abc1234");
    expect(await store.insertBackupSnapshot({ snapshot_id: snap, tenant_id: T, host: "host-t1", kind: "etckeeper", taken_at: "2026-10-24T01:00:00.000Z", source_ref: "abc1234" })).toBe(1);
    expect(await store.insertBackupSnapshot({ snapshot_id: snap, tenant_id: T, host: "host-t1", kind: "etckeeper", taken_at: "2026-10-24T01:00:00.000Z", source_ref: "abc1234" })).toBe(0);
    const items = o.map((x) => ({ snapshot_id: snap, object_id: x.object_id, setting_path: x.setting_path, value_hash: x.value_hash }));
    expect(await store.insertBackupItems(items)).toBe(2);
    expect(await store.insertBackupItems(items)).toBe(0);
    expect(await count("backup_item", `snapshot_id = '${snap}'`)).toBe(2);

    const appr = { approval_id: "appr-t1", tenant_id: T, surface: "linux.nginx", host: "host-t1", object_id: o[0].object_id, setting_path: o[0].setting_path, value_hash: o[0].value_hash, approved_at: "2026-10-24T00:00:00.000Z", approved_by: null, note: null };
    expect(await store.insertApproved([appr])).toBe(1);
    expect(await store.insertApproved([appr])).toBe(0);
    await expect(store.insertApproved([{ ...appr, approval_id: "appr-t2", bogus: 1 } as never])).rejects.toThrow(/unknown column bogus/);
  });

  it("redacts the collected text a collector forgot to; leaves setting paths, ids and hashes as written", async () => {
    const leaked: Observation = {
      obs_id: obsId(run, "/etc/nginx/conf.d/t.conf", "server.location./.proxy_pass"), run_id: run, tenant_id: T, surface: "linux.nginx", host: "host-t1",
      object_id: "/etc/nginx/conf.d/t.conf", setting_path: "server.location./.proxy_pass", value_hash: `sha256:${"1".repeat(64)}`,
      value_redacted: "http://app.bluefin-logistics-zz9q.com:8080 via 10.40.12.7", refers_to_type: "dns_name", refers_to_id: "app.bluefin-logistics-zz9q.com",
      observed_at: "2026-10-24T03:00:01.000Z", source: "ssh", authority: 100,
    };
    // server.return ends in a directive outside the redactor's VOCAB: in free text it would read as a host
    const kept: Observation = { ...leaked, obs_id: obsId(run, "/etc/nginx/conf.d/t.conf", "server.return"), setting_path: "server.return", value_redacted: "301 https://t.example.invalid$request_uri", refers_to_type: null, refers_to_id: null };
    expect(await store.insertObservations([leaked, kept])).toBe(2);
    const r = (await admin.query(`SELECT value_redacted, refers_to_id FROM ${schema}.observation WHERE obs_id = $1`, [leaked.obs_id])).rows[0];
    expect(r.value_redacted).toMatch(/^http:\/\/host-[0-9a-f]{6}\.com:8080 via ip-[0-9a-f]{6}$/);
    expect(r.refers_to_id).toMatch(/^host-[0-9a-f]{6}\.com$/);
    expect(JSON.stringify(r)).not.toMatch(/bluefin|10\.40\.12\.7/);
    const k = (await admin.query(`SELECT obs_id, setting_path, value_hash, value_redacted FROM ${schema}.observation WHERE obs_id = $1`, [kept.obs_id])).rows[0];
    expect(k).toEqual({ obs_id: kept.obs_id, setting_path: "server.return", value_hash: kept.value_hash, value_redacted: kept.value_redacted });
  });

  it("an export refuses a bundle in which a deny-list label still stands alone, names its position and count, not the label, and writes nothing", async () => {
    const out = path.join(dir, "denied.json");
    // 'app' stands alone in the authored fixture's object ids (/etc/nginx/conf.d/app.conf); 'zzzz-not-there' does not
    await expect(writeBundle(store, out, { redactor: new Redactor("test-salt"), note: "n", deny: ["zzzz-not-there", "app"] })).rejects.toThrow(/leak probe: 1 of 2 deny-list label\(s\) still appear in the export \(#2 x\d+\); nothing written/);
    expect(existsSync(out)).toBe(false);
    try { await writeBundle(store, out, { redactor: new Redactor("test-salt"), note: "n", deny: ["app"] }); } catch (e) { expect((e as Error).message).not.toMatch(/\bapp\b/); }
    const stats = await writeBundle(store, out, { redactor: new Redactor("test-salt"), note: "n", deny: ["zzzz-not-there"] });
    expect(stats.counts.observation).toBeGreaterThan(0);
    expect(existsSync(out)).toBe(true);
  });

  it("an export nulls a value_redacted over 2 kB and keeps its row", async () => {
    const big: Observation = {
      obs_id: obsId(run, "/etc/nginx/conf.d/t.conf", "server.big"), run_id: run, tenant_id: T, surface: "linux.nginx", host: "host-t1",
      object_id: "/etc/nginx/conf.d/t.conf", setting_path: "server.big", value_hash: `sha256:${"2".repeat(64)}`, value_redacted: "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; ".repeat(50),
      refers_to_type: null, refers_to_id: null, observed_at: "2026-10-24T03:00:01.000Z", source: "ssh", authority: 100,
    };
    expect(await store.insertObservations([big])).toBe(1);
    const out = path.join(dir, "big.json");
    const stats = await writeBundle(store, out, { redactor: new Redactor("test-salt"), note: "n" });
    expect(stats.dropped).toBe(1);
    expect(stats.changed).toBe(0); // the store already redacted the leaked row; the second pass finds nothing
    const written = JSON.parse(readFileSync(out, "utf8")) as { observation: Observation[] };
    expect(written.observation.find((x) => x.obs_id === big.obs_id)?.value_redacted).toBeNull();
    expect(written.observation.find((x) => x.setting_path === "server.return")?.value_redacted).toBe("301 https://t.example.invalid$request_uri");
    expect(written.observation).toHaveLength(sample.observation.length + 5);
  });

  // ---- the eight tables of the design and the read helpers -------------------------------------------------

  const A = "client-a";
  const H = (c: string) => `sha256:${c.repeat(64)}`;

  it.skipIf(!config.redactSalt)("npm run policy:load (the script itself) writes the committed policy once: 15 rows, then 0", () => {
    const load = () => spawnSync(process.execPath, ["--import", "tsx", "scripts/policy-load.ts", "--schema", schema, "--tenant", A], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    const first = load();
    expect(first.stderr).not.toMatch(/policy:load:/);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("policy:load: policy/hackathon.json: version 2 by operator since 2026-10-25T00:00:00.000Z, tenant * (every tenant): 15 rule(s) valid");
    expect(first.stdout).toContain("policy:load: policy_rule 15 row(s) written, 0 already stored");
    const second = load();
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("policy:load: policy_rule 0 row(s) written, 15 already stored");
    const dry = spawnSync(process.execPath, ["--import", "tsx", "scripts/policy-load.ts", "--tenant", A, "--dry-run"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("policy:load: dry run, nothing written (15 row(s) for policy_rule)");
    const usage = spawnSync(process.execPath, ["--import", "tsx", "scripts/policy-load.ts"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toMatch(/--tenant is required/);
  }, 120_000);

  it("the eight new tables: each insert writes once, a re-insert writes 0, collected text is redacted, a non-canonical since is refused", async () => {
    const { rows: rules } = loadPolicyFile(path.join(ROOT, "policy", "hackathon.json"), { tenant: A, redactor: new Redactor(config.redactSalt || "test-salt", config.redactWords) });
    const before = await count("policy_rule");
    expect(await store.insertPolicyRules(rules)).toBe(15 - before);
    expect(await store.insertPolicyRules(rules)).toBe(0);
    expect(await count("policy_rule")).toBe(15);
    await expect(store.insertPolicyRules([{ ...rules[0], rule_id: "rule-0000000000000000", since: "2026-10-25T00:00:00Z" }])).rejects.toThrow(/policy_rule\.since: timestamps must be/);

    const run = "run-nginx-7f1c-1023";
    const copy = { copy_id: copyId(run, "/etc/nginx/conf.d/app.conf"), tenant_id: A, surface: "linux.nginx", host: "host-7f1c", object_id: "/etc/nginx/conf.d/app.conf", run_id: run, git_commit: "0123abcd", blob_sha256: H("c"), taken_at: "2026-10-23T02:01:03.000Z", source: "collector" };
    expect(await store.insertVaultCopies([copy])).toBe(1);
    expect(await store.insertVaultCopies([copy])).toBe(0);
    const val = { validation_id: validationId(copy.copy_id, "nginx-t", "2026-10-23T02:02:00.000Z"), copy_id: copy.copy_id, tenant_id: A, validator: "nginx-t" as const, result: "ok_with_gaps" as const, missing_dependencies: "/etc/letsencrypt/options-ssl-nginx.conf", output_redacted: "nginx: configuration file /etc/nginx/nginx.conf test is successful", validated_at: "2026-10-23T02:02:00.000Z" };
    expect(await store.insertCopyValidations([val])).toBe(1);
    expect(await store.insertCopyValidations([val])).toBe(0);
    const probeRun = runId(A, "probe", null, "2026-10-23T02:20:00.000Z");
    const probe = { probe_id: probeId(probeRun, "http", "app.bluefin-logistics-zz9q.com"), run_id: probeRun, tenant_id: A, kind: "http" as const, target: "app.bluefin-logistics-zz9q.com", expected: "answers (status below 500); cf-ray present", observed: "status 200 server=cloudflare cf-ray present", status: "ok" as const, latency_ms: 84, observed_at: "2026-10-23T02:20:01.000Z" };
    expect(await store.insertProbes([probe])).toBe(1);
    expect(await store.insertProbes([probe])).toBe(0);
    const disp = {
      disposition_id: dispositionId(A, "linux.nginx", "host-7f1c", "/etc/nginx/conf.d/app.conf", "file", H("d"), "fnd-0000000000000001", run), tenant_id: A, surface: "linux.nginx", host: "host-7f1c",
      object_id: "/etc/nginx/conf.d/app.conf", setting_path: "file", value_hash: H("d"), verb: "HOLD" as const, reason: "The vhost serving app.bluefin-logistics-zz9q.com drifted with no valid copy; held for 24 hours.",
      expires_at: "2026-10-24T02:21:00.000Z", decided_by: "policy" as const, rule_id: rules[0].rule_id, finding_id: "fnd-0000000000000001", run_id: run, decided_at: "2026-10-23T02:21:00.000Z",
    };
    expect(await store.insertDispositions([disp])).toBe(1);
    expect(await store.insertDispositions([disp])).toBe(0);
    const action = { action_id: "act-0000000000000001", tenant_id: A, kind: "investigate" as const, target: "/etc/nginx/conf.d/app.conf", before_hash: H("d"), after_hash: null, vault_commit: null, verification: "", receipts: "", status: "refused" as const, started_at: "2026-10-23T02:22:00.000Z", finished_at: null, disposition_id: disp.disposition_id };
    expect(await store.insertActions([action])).toBe(1);
    expect(await store.insertActions([action])).toBe(0);
    const ticket = { ticket_id: "tkt-0000000000000001", tenant_id: A, psa: "github" as const, external_id: null, url: null, type: "change" as const, priority: "P1" as const, status: "open", action_id: action.action_id, finding_id: disp.finding_id, created_at: "2026-10-23T02:23:00.000Z", updated_at: "2026-10-23T02:23:00.000Z" };
    expect(await store.insertTickets([ticket])).toBe(1);
    expect(await store.insertTickets([ticket])).toBe(0);
    const fp = { obs_id: "obs-a", dns_run_id: "run-dns-1023", fingerprint: "203.0.113.77", resolved_at: "2026-10-23T02:05:00.000Z" };
    expect(await store.insertReferentFingerprints([fp, { ...fp, dns_run_id: "run-dns-1020", fingerprint: "198.51.100.10" }])).toBe(2);
    expect(await store.insertReferentFingerprints([fp])).toBe(0);
    await expect(store.insertReferentFingerprints([{ ...fp, obs_id: "obs-b" }, { ...fp, obs_id: "obs-b", fingerprint: "203.0.113.78" }])).rejects.toThrow(/two different rows share the key obs-b \/ run-dns-1023/);
    for (const t of ["vault_copy", "copy_validation", "probe", "disposition", "action", "ticket"] as TableName[]) expect(await count(t), t).toBe(1);
    expect(await count("referent_fingerprint")).toBe(2);

    const stored = await store.rowsOf("disposition", { finding_id: "fnd-0000000000000001" });
    expect(stored).toHaveLength(1);
    expect(stored[0].reason).toMatch(/^The vhost serving host-[0-9a-f]{6}\.com drifted with no valid copy; held for 24 hours\.$/);
    expect((await store.rowsOf("probe", { run_id: probeRun }))[0].target).toMatch(/^host-[0-9a-f]{6}\.com$/);
    expect(JSON.stringify(await store.rowsOf("probe"))).not.toContain("bluefin");
    expect(await store.rowsOf("vault_copy", { run_id: run })).toEqual([copy]);
    expect(await store.rowsOf("copy_validation", { copy_id: copy.copy_id })).toEqual([val]);
    expect(await store.rowsOf("action", { vault_commit: null })).toEqual([action]);
    expect(await store.rowsOf("referent_fingerprint", { obs_id: "obs-a" })).toEqual([{ ...fp, dns_run_id: "run-dns-1020", fingerprint: "198.51.100.10" }, fp]);
    await expect(store.rowsOf("ticket", { bogus: 1 } as never)).rejects.toThrow(/ticket: unknown column bogus/);
  });

  it("latestPassingRun follows the gate: complete, both counts present and met, and for a host surface the rows stored; latest by started_at", async () => {
    expect((await store.latestPassingRun(A, "linux.nginx", "host-7f1c"))?.run_id).toBe("run-nginx-7f1c-1023");
    // the latest run of this host is partial: the one before it passes
    expect((await store.latestPassingRun(A, "linux.nginx", "host-2b9e"))?.run_id).toBe("run-nginx-2b9e-1020");
    expect(await store.latestPassingRun(A, "cloudflare.dns", null)).toEqual(fixtureRows("collection_run").find((r) => r.run_id === "run-dns-1023"));
    expect(await store.latestPassingRun(A, "linux.nginx", null)).toBeNull();
    expect(await store.latestPassingRun("client-z", "cloudflare.dns", null)).toBeNull();
    // a later run that reports complete but stored fewer rows than it asserted does not pass
    const short = runId(A, "linux.nginx", "host-7f1c", "2026-10-25T02:01:00.000Z");
    await store.beginRun({ run_id: short, tenant_id: A, surface: "linux.nginx", host: "host-7f1c", started_at: "2026-10-25T02:01:00.000Z", expected_count: 2 });
    await store.finishRun(short, 2, "complete", "2026-10-25T02:01:02.000Z");
    expect((await store.latestPassingRun(A, "linux.nginx", "host-7f1c"))?.run_id).toBe("run-nginx-7f1c-1023");
    // a later DNS run that never asserted its population does not pass either
    const unasserted = runId(A, "cloudflare.dns", null, "2026-10-25T02:05:00.000Z");
    await store.beginRun({ run_id: unasserted, tenant_id: A, surface: "cloudflare.dns", host: null, started_at: "2026-10-25T02:05:00.000Z", expected_count: null });
    await store.finishRun(unasserted, 3, "complete", "2026-10-25T02:05:01.000Z");
    expect((await store.latestPassingRun(A, "cloudflare.dns", null))?.run_id).toBe("run-dns-1023");
  });

  it("observationsOf, dnsRecordsOf and policyRules read back what the fixture and the loader wrote, in key order", async () => {
    expect(await store.observationsOf("run-nginx-7f1c-1023")).toEqual(sorted("observation", fixtureRows("observation").filter((o) => o.run_id === "run-nginx-7f1c-1023")));
    expect(await store.dnsRecordsOf("run-dns-1023")).toEqual(sorted("dns_record", fixtureRows("dns_record").filter((d) => d.run_id === "run-dns-1023")));
    expect(await store.observationsOf("run-unknown")).toEqual([]);
    const shared = await store.policyRules(A);
    expect(shared).toHaveLength(15);
    expect(shared.every((r) => r.tenant_id === "*")).toBe(true);
    expect(shared.map((r) => r.rule_id)).toEqual([...shared.map((r) => r.rule_id)].sort());
    const own = { ...shared[0], tenant_id: A, rule_id: ruleId(A, shared[0].surface, shared[0].object_glob, shared[0].setting_glob, 1) };
    const other = { ...shared[0], tenant_id: "client-b", rule_id: ruleId("client-b", shared[0].surface, shared[0].object_glob, shared[0].setting_glob, 1) };
    expect(await store.insertPolicyRules([own, other])).toBe(2);
    expect((await store.policyRules(A)).map((r) => r.tenant_id).sort()).toEqual([...Array(15).fill("*"), A]);
    expect((await store.policyRules("client-b")).filter((r) => r.tenant_id !== "*").map((r) => r.rule_id)).toEqual([other.rule_id]);
  });
});
