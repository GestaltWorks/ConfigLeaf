// approvalsFor and its helpers (src/vault/approve.ts) over the recorded bundle's own observations (the two
// hosts' nginx files) and over synthetic per-field Cloudflare observations in the shape the Cloudflare
// collector writes them (one row per record field, object_id = record id, value_hash = Redactor.fingerprint).
// The synthetic zone is the redactor test's unregistered domain, so a real-looking name typed by the operator
// is shown to reach its pseudonym before the lookup. The rows then load into sql.js, and the catalogue's
// setting_matches_approved template holds over them. With DATABASE_URL and REDACT_SALT set, the last block runs
// scripts/approve.ts itself against a throwaway schema loaded with test/fixtures/recorded-bundle.json (skipped with one line
// otherwise).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redactText } from "../src/collectors/linux.ts";
import { config } from "../src/config.ts";
import { runCheck } from "../src/catalogue/templates.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { Store } from "../src/data/store.ts";
import { AUTHORITY, approvalId, obsId, type ApprovedSetting, type DnsRecord, type Observation } from "../src/data/rows.ts";
import { Redactor } from "../src/redactor.ts";
import { DNS_FIELDS, approvalStatus, approvalsFor, approvalsToWrite, hostPath, resolveObject, resolveZone, selects } from "../src/vault/approve.ts";
import { driftVsApproved, objects } from "../src/data/queries.ts";
import bundle from "./fixtures/recorded-bundle.json" with { type: "json" };

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NOW = "2026-10-24T18:00:00.000Z";
const OBS = bundle.observation as Observation[];
const RUNS = bundle.collection_run.filter((c) => c.surface === "linux.nginx");
const hostOf = (host: string) => RUNS.find((c) => c.host === host)!;
const obsOfRun = (runId: string): Observation[] => OBS.filter((o) => o.run_id === runId);
const r = new Redactor("approve-test-salt");

describe("approvalsFor, a host's nginx files", () => {
  for (const [host, n] of [["host-4b4dc1", 17], ["host-aa516a", 26]] as const) {
    it(`host ${host}: the file setting of every object under /etc/nginx/ in its run, ${n} rows`, () => {
      const run = hostOf(host);
      const observations = obsOfRun(run.run_id);
      const rows = approvalsFor(observations, { kind: "host", host }, "operator", null, NOW);
      expect(rows).toHaveLength(n);
      const files = observations.filter((o) => o.setting_path === "file");
      expect(files.length).toBeGreaterThan(n); // the certbot renewal configs are file rows outside /etc/nginx/
      for (const a of rows) {
        const o = files.find((x) => x.object_id === a.object_id)!;
        expect(a).toEqual({
          approval_id: approvalId(o.tenant_id, o.host, o.object_id, "file", o.value_hash, NOW), tenant_id: o.tenant_id, surface: "linux.nginx", host,
          object_id: o.object_id, setting_path: "file", value_hash: o.value_hash, approved_at: NOW, approved_by: "operator", note: null,
        });
        expect(a.object_id.startsWith("/etc/nginx/")).toBe(true);
      }
      expect(rows.map((a) => a.object_id)).toEqual(rows.map((a) => a.object_id).sort());
      expect(approvalsFor(observations, { kind: "host", host: host === "host-4b4dc1" ? "host-aa516a" : "host-4b4dc1" }, "operator", null, NOW)).toEqual([]);
    });
  }

  it("one object, by redacted object id, by the real path the collector redacts, or by nothing that matches", () => {
    const run = hostOf("host-aa516a");
    const observations = obsOfRun(run.run_id);
    const id = "/etc/nginx/nginx.conf";
    expect(resolveObject(observations, "host-aa516a", id, r)).toBe(id);
    const rows = approvalsFor(observations, { kind: "object", host: "host-aa516a", object_id: id }, "user-123abc", "signed off after the change window", new Date(NOW));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ object_id: id, setting_path: "file", approved_by: "user-123abc", note: "signed off after the change window" });
    expect(rows[0].value_hash).toBe(observations.find((o) => o.object_id === id && o.setting_path === "file")!.value_hash);

    const real = "/etc/nginx/conf.d/kestrel-foods-zz9q.com.conf";
    const redacted = redactText(r, real);
    expect(redacted).toMatch(/^\/etc\/nginx\/conf\.d\/host-[0-9a-f]{6}\.com\.conf$/);
    const synthetic: Observation = { ...observations.find((o) => o.setting_path === "file")!, object_id: redacted, obs_id: obsId(run.run_id, redacted, "file") };
    expect(resolveObject([...observations, synthetic], "host-aa516a", real, r)).toBe(redacted);
    expect(resolveObject([...observations, synthetic], "host-aa516a", redacted, r)).toBe(redacted);
    expect(resolveObject(observations, "host-aa516a", real, r)).toBeNull();
    expect(resolveObject(observations, "host-4b4dc1", id, r)).toBeNull();
    expect(resolveObject(observations, "host-aa516a", `C:/Program Files/Git${id}`, r)).toBe(id);
    expect(hostPath("C:\\Program Files\\Git\\etc\\nginx\\nginx.conf")).toBe(id);
    expect(hostPath(id)).toBe(id);
    expect(hostPath("D:/elsewhere/x.conf")).toBe("D:/elsewhere/x.conf");
  });

  it("refuses a non-canonical time and a blank approver", () => {
    const observations = obsOfRun(hostOf("host-aa516a").run_id);
    expect(() => approvalsFor(observations, { kind: "host", host: "host-aa516a" }, "operator", null, "2026-10-24T18:00:00Z")).toThrow(/millisecond form/);
    expect(() => approvalsFor(observations, { kind: "host", host: "host-aa516a" }, " ", null, NOW)).toThrow(/blank/);
  });
});

describe("approvalsFor, Cloudflare records", () => {
  const TENANT = "client-a";
  const RUN = "run-dns-approve";
  const AT = "2026-10-24T07:58:55.125Z";
  const zoneA = "shop.example";
  const zoneB = "kestrel-foods-zz9q.com";
  const records: { id: string; zone: string; name: string; type: string; content: string; ttl: number; proxied: boolean }[] = [
    { id: "4d1c9b7a2e6f8035a1b2c3d4e5f60718", zone: zoneA, name: "shop.example", type: "A", content: "203.0.113.10", ttl: 1, proxied: false },
    { id: "b7e3a9f1c5d20864e1f2a3b4c5d6e7f8", zone: zoneA, name: "www.shop.example", type: "CNAME", content: "shop.example", ttl: 1, proxied: true },
    { id: "c0ffee00c0ffee00c0ffee00c0ffee00", zone: zoneB, name: zoneB, type: "A", content: "198.51.100.25", ttl: 300, proxied: true },
  ];
  /** One observation per record field, as the Cloudflare collector writes them. */
  const observations: Observation[] = records.flatMap((d) => DNS_FIELDS.map((field): Observation => {
    const value = String(d[field]);
    return {
      obs_id: obsId(RUN, d.id, field), run_id: RUN, tenant_id: TENANT, surface: "cloudflare.dns", host: null, object_id: d.id, setting_path: field,
      value_hash: r.fingerprint(value), value_redacted: r.value(value), refers_to_type: null, refers_to_id: null, observed_at: AT, source: "cloudflare", authority: AUTHORITY.live,
    };
  }));
  const dnsRows: DnsRecord[] = records.map((d) => ({
    record_id: d.id, run_id: RUN, tenant_id: TENANT, zone: r.text(d.zone), name: r.text(d.name), type: d.type, content: r.value(d.content), ttl: d.ttl, proxied: d.proxied ? 1 : 0, observed_at: AT,
  }));
  const other: Observation = { ...observations[0], obs_id: "obs-other", setting_path: "comment" };

  it("one record: its five fields", () => {
    const rows = approvalsFor([...observations, other], { kind: "record", record_id: records[1].id }, "operator", null, NOW);
    expect(rows.map((a) => a.setting_path)).toEqual(["content", "name", "proxied", "ttl", "type"]);
    expect(rows.every((a) => a.object_id === records[1].id && a.host === null && a.surface === "cloudflare.dns")).toBe(true);
    expect(rows.map((a) => a.value_hash)).toEqual(rows.map((a) => observations.find((o) => o.object_id === a.object_id && o.setting_path === a.setting_path)!.value_hash));
  });

  it("a zone by its real or redacted name: every field of its records; the account: every field of every record", () => {
    const real = resolveZone(dnsRows, zoneB, r);
    expect(real).toEqual([records[2].id]);
    expect(resolveZone(dnsRows, r.text(zoneB), r)).toEqual(real);
    expect(resolveZone(dnsRows, `${zoneB.toUpperCase()}.`, r)).toEqual(real);
    expect(resolveZone(dnsRows, zoneA, r)).toEqual([records[0].id, records[1].id]);
    expect(resolveZone(dnsRows, "nothing.example", r)).toEqual([]);
    expect(approvalsFor(observations, { kind: "zone", record_ids: resolveZone(dnsRows, zoneA, r) }, "operator", null, NOW)).toHaveLength(10);
    const all = approvalsFor([...observations, other, ...OBS.slice(0, 50)], { kind: "account" }, "operator", null, NOW);
    expect(all).toHaveLength(records.length * DNS_FIELDS.length);
    expect(new Set(all.map((a) => a.approval_id)).size).toBe(all.length);
    expect(selects({ kind: "account" }, other)).toBe(false);
  });
});

describe("approvalStatus and the stored rows", () => {
  const run = hostOf("host-aa516a");
  const observations = obsOfRun(run.run_id);
  const id = "/etc/nginx/nginx.conf";
  const sel = { kind: "object", host: "host-aa516a", object_id: id } as const;

  it("new, current, replaces and superseded against the approvals already stored; approvalsToWrite keeps every state but current", () => {
    const [first] = approvalsFor(observations, sel, "operator", null, "2026-10-24T10:00:00.000Z");
    expect(approvalStatus([first], [])).toEqual(["new"]);
    expect(approvalStatus([first], [first])).toEqual(["current"]);
    const A = `sha256:${"a".repeat(64)}`;
    const other: ApprovedSetting = { ...first, value_hash: A, approval_id: approvalId(first.tenant_id, first.host, id, "file", A, "2026-10-24T12:00:00.000Z"), approved_at: "2026-10-24T12:00:00.000Z" };
    expect(approvalStatus([first], [other])).toEqual(["replaces"]);
    expect(approvalStatus([first], [first, other])).toEqual(["superseded"]);
    expect(approvalStatus([first], [{ ...other, approved_at: "2026-10-24T09:00:00.000Z" }, first])).toEqual(["current"]);
    // the same value approved again later is the latest's value: current, whatever its own id and time
    const [again] = approvalsFor(observations, sel, "operator", null, "2026-10-24T14:00:00.000Z");
    expect(again.approval_id).not.toBe(first.approval_id);
    expect(approvalStatus([again], [first])).toEqual(["current"]);
    expect(approvalsToWrite([again], ["current"])).toEqual([]);
    // the re-approval of the earlier value after the other one: superseded, written, and then the latest
    expect(approvalStatus([again], [first, other])).toEqual(["superseded"]);
    expect(approvalsToWrite([again], approvalStatus([again], [first, other]))).toEqual([again]);
    expect(approvalStatus([again], [first, other, again])).toEqual(["current"]);
    expect(() => approvalsToWrite([first, again], ["new"])).toThrow(/2 row\(s\) and 1 state/);
  });

  it("approvalId carries approved_at: the same value approved at two instants is two ids", () => {
    const o = observations.find((x) => x.object_id === id && x.setting_path === "file")!;
    const at1 = approvalId(o.tenant_id, o.host, id, "file", o.value_hash, "2026-10-24T10:00:00.000Z");
    expect(at1).toMatch(/^appr-[0-9a-f]{16}$/);
    expect(approvalId(o.tenant_id, o.host, id, "file", o.value_hash, "2026-10-24T10:00:00.000Z")).toBe(at1);
    expect(approvalId(o.tenant_id, o.host, id, "file", o.value_hash, "2026-10-24T11:00:00.000Z")).not.toBe(at1);
  });

  it("over sql.js: a re-run over the unchanged estate writes 0 rows, and a re-approval of an earlier value lands and ends the drift", async () => {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(bundle);
    const dl = new DataLayer(engine);
    const stored = async (): Promise<ApprovedSetting[]> => objects(await dl.run("SELECT approval_id, tenant_id, surface, host, object_id, setting_path, value_hash, approved_at, approved_by, note FROM {{t:approved_setting}} ORDER BY approved_at, approval_id", {}, { limit: 100_000 }))
      .map((a) => ({ approval_id: a.approval_id, tenant_id: a.tenant_id, surface: a.surface, host: a.host || null, object_id: a.object_id, setting_path: a.setting_path, value_hash: a.value_hash, approved_at: a.approved_at, approved_by: a.approved_by || null, note: a.note || null }));
    const write = async (rows: ApprovedSetting[]): Promise<number> => engine.insertRows("approved_setting", approvalsToWrite(rows, approvalStatus(rows, await stored())));
    const baseline = approvalsFor(observations, { kind: "host", host: "host-aa516a" }, "operator", null, "2026-10-24T10:00:00.000Z");
    expect(await write(baseline)).toBe(baseline.length);
    // the same estate an hour later: every row current, nothing written
    expect(await write(approvalsFor(observations, { kind: "host", host: "host-aa516a" }, "operator", null, "2026-10-24T11:00:00.000Z"))).toBe(0);
    // another value of nginx.conf approved at noon: the live file now drifts from its latest approval
    const A = `sha256:${"a".repeat(64)}`;
    const [base] = baseline.filter((a) => a.object_id === id);
    expect(engine.insertRows("approved_setting", [{ ...base, value_hash: A, approved_at: "2026-10-24T12:00:00.000Z", approval_id: approvalId(base.tenant_id, base.host, id, "file", A, "2026-10-24T12:00:00.000Z") }])).toBe(1);
    const drifted = async () => objects(await driftVsApproved(dl, { tenant_id: run.tenant_id, run_id: run.run_id })).map((r) => r.object_id);
    expect(await drifted()).toEqual([id]);
    // the technician re-approves the live (earlier) value at 13:00: superseded, written, the latest again
    const re = approvalsFor(observations, sel, "operator", null, "2026-10-24T13:00:00.000Z");
    expect(approvalStatus(re, await stored())).toEqual(["superseded"]);
    expect(await write(re)).toBe(1);
    expect(await drifted()).toEqual([]);
    expect((await stored()).filter((a) => a.object_id === id).map((a) => [a.approved_at, a.value_hash === A])).toEqual([
      ["2026-10-24T10:00:00.000Z", false], ["2026-10-24T12:00:00.000Z", true], ["2026-10-24T13:00:00.000Z", false],
    ]);
    engine.close();
  });

  it("the rows load into sql.js, a second load writes nothing, and setting_matches_approved holds over them", async () => {
    const rows = approvalsFor(observations, { kind: "host", host: "host-aa516a" }, "operator", null, NOW);
    const engine = await SqlJsEngine.create();
    engine.loadBundle(bundle);
    expect(engine.insertRows("approved_setting", rows)).toBe(rows.length);
    expect(engine.insertRows("approved_setting", approvalsFor(observations, { kind: "host", host: "host-aa516a" }, "operator", null, NOW))).toBe(0);
    const res = await runCheck(new DataLayer(engine), "setting_matches_approved", { tenant_id: run.tenant_id, host: "host-aa516a", object_id: id, setting_path: "file", run_id: run.run_id });
    expect(res.rowCount).toBe(1);
    expect(res.holds).toBe(true);
    engine.close();
  });
});

const url = process.env.DATABASE_URL;
const live = !!url && !!config.redactSalt;
if (!live) console.log("approve: live Postgres half skipped (set DATABASE_URL and REDACT_SALT in .env to run it)");

describe.skipIf(!live)("npm run approve (the script itself), live drift-pg (throwaway schema loaded with test/fixtures/recorded-bundle.json)", () => {
  const schema = `test_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let store: Store;
  const approve = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/approve.ts", "--tenant", "client-1", "--schema", schema, ...args], { cwd: ROOT, encoding: "utf8", timeout: 60_000, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    store = Store.fromEnv({ schema });
    await store.applySchema();
    await store.loadBundle(bundle);
  }, 60_000);

  afterAll(async () => {
    await store?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("a host's nginx files: 17 rows written, then 0 written and 17 current; a dry run of one object writes nothing", async () => {
    const first = approve("--host", "host-4b4dc1", "--by", "tech", "--note", "baseline");
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("approve: new 17, replaces 0, current 0, superseded 0");
    expect(first.stdout).toContain("approve: approved_setting 17 row(s) written, 0 current and skipped");
    const second = approve("--host", "host-4b4dc1", "--all");
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("approve: new 0, replaces 0, current 17, superseded 0");
    expect(second.stdout).toContain("approve: approved_setting 0 row(s) written, 17 current and skipped");
    const dry = approve("--host", "host-aa516a", "--object", "/etc/nginx/nginx.conf", "--dry-run");
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("approve: dry run, nothing written (1 row(s) for approved_setting, 0 current)");
    const stored = await store.rowsOf("approved_setting", { tenant_id: "client-1" });
    expect(stored).toHaveLength(17);
    expect(stored.every((a) => a.host === "host-4b4dc1" && a.approved_by === "tech" && a.note === "baseline")).toBe(true);
    expect(approve("--zone", "x").status).toBe(1);
    expect(approve("--host", "host-4b4dc1", "--zone", "x").status).toBe(2);
  }, 120_000);
});
