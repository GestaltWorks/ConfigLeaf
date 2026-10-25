import { describe, expect, it } from "vitest";
import {
  AUDIT_LIMIT, Cloudflare, CloudflareError, RECORDS_PER_PAGE, RECORD_FIELDS,
  auditEventRow, auditWindow, collectCloudflare, dnsObservationRows, dnsRecordRow, isoMs, previousState, proxiedFlag, resourceIdOf,
  type CfAuditRow, type CfRecord, type CfZone,
} from "../src/collectors/cloudflare.ts";
import { AUTHORITY, REDACT, eventId, obsId, type AuditEvent, type Observation } from "../src/data/rows.ts";
import { Redactor } from "../src/redactor.ts";
import { cloudflareVaultFiles } from "../src/vault/hook.ts";
import { TOKEN, fakeApi, type FakeOptions } from "./fixtures/cloudflare/fake-api.ts";
import { CF_TOKEN, fakeCloudflare } from "./fixtures/actions/fake-cloudflare.ts";
import zonesFile from "./fixtures/cloudflare/zones.json" with { type: "json" };
import recordsFile from "./fixtures/cloudflare/records.json" with { type: "json" };
import auditFile from "./fixtures/cloudflare/audit.json" with { type: "json" };

// Fixtures are hand-written in the measured API shapes: reserved names (shop.example), documentation and
// private addresses, and the redactor test's unregistered domain to prove pseudonymisation. Nothing in
// them came from a real account.
const r = new Redactor("test-salt");
const H6 = "[0-9a-f]{6}";
const TENANT = "client-a";
const NOW = new Date("2026-10-24T05:00:00.000Z");
const ZONES = zonesFile as CfZone[];
const RECORDS = Object.fromEntries(Object.entries(recordsFile).filter(([k]) => !k.startsWith("_"))) as Record<string, CfRecord[]>;
const AUDIT = auditFile as unknown as CfAuditRow[];
const [SHOP, BLUE] = ZONES;
const ACCOUNT = SHOP.account!.id!;
const WWW = "b7e3a9f1c5d20864e1f2a3b4c5d6e7f8";
const APEX = "4d1c9b7a2e6f8035a1b2c3d4e5f60718";
const OLD = "3c3d3e3f404142434445464748494a4b";
const ctx = { tenantId: TENANT, runId: "run-test", observedAt: NOW.toISOString() };
const rec = (zone: CfZone, id: string): CfRecord => RECORDS[zone.id].find((x) => x.id === id)!;
const raw = (id: string): CfAuditRow => AUDIT.find((a) => a.id === id)!;
const events = (): AuditEvent[] => AUDIT.map((a) => auditEventRow(r, a, TENANT)).filter((e): e is AuditEvent => !!e);
const RAW_LEAK = /bluefin|ops\.lead|jmorales|100\.72\.|10\.40\.|ci deploy|Qm9n|fixture-token/;

function api(extra: Partial<FakeOptions> = {}) {
  const fake = fakeApi({ zones: ZONES, records: structuredClone(RECORDS), audit: AUDIT, now: NOW, ...extra });
  return { cf: new Cloudflare({ token: TOKEN, fetch: fake.fetch }), log: fake.log };
}

describe("dnsRecordRow", () => {
  it("maps the proxied flag: true 1, false 0, absent null; the apex stays direct while www is proxied", () => {
    expect(dnsRecordRow(r, rec(SHOP, APEX), SHOP.name, ctx)!.proxied).toBe(0);
    expect(dnsRecordRow(r, rec(SHOP, WWW), SHOP.name, ctx)!.proxied).toBe(1);
    expect(dnsRecordRow(r, { ...rec(SHOP, APEX), proxied: undefined }, SHOP.name, ctx)!.proxied).toBeNull();
    expect([proxiedFlag(true), proxiedFlag(false), proxiedFlag("true"), proxiedFlag(1), proxiedFlag(null)]).toEqual([1, 0, null, null, null]);
  });

  it("keeps ids, types, ttl and reserved names; pseudonymises real names and private addresses; a token-shaped TXT is a secret", () => {
    expect(dnsRecordRow(r, rec(SHOP, APEX), SHOP.name, ctx)).toEqual({
      record_id: APEX, run_id: "run-test", tenant_id: TENANT, zone: "shop.example", name: "shop.example",
      type: "A", content: "203.0.113.10", ttl: 1, proxied: 0, observed_at: "2026-10-24T05:00:00.000Z",
    });
    const apex = dnsRecordRow(r, RECORDS[BLUE.id][0], BLUE.name, ctx)!;
    const www = dnsRecordRow(r, RECORDS[BLUE.id][1], BLUE.name, ctx)!;
    expect(apex.zone).toMatch(new RegExp(`^host-${H6}\\.com$`));
    expect(apex.name).toBe(apex.zone);
    expect(apex.content).toMatch(new RegExp(`^ip-${H6}$`));
    expect(www.name).toMatch(new RegExp(`^host-${H6}\\.com$`));
    expect(www.name).not.toBe(apex.name);
    expect(www.content).toBe(apex.name); // the CNAME target is the apex's pseudonym, so a join on name holds
    expect(dnsRecordRow(r, RECORDS[SHOP.id][5], SHOP.name, ctx)!.content).toBe("v=spf1 include:_spf.example.com ~all");
    expect(dnsRecordRow(r, RECORDS[SHOP.id][6], SHOP.name, ctx)!.content).toMatch(/^site-verification-token=<secret:kv:[0-9a-f]{8}>$/);
    expect(JSON.stringify(RECORDS[BLUE.id].map((x) => dnsRecordRow(r, x, BLUE.name, ctx)))).not.toMatch(RAW_LEAK);
  });

  it("a wildcard keeps its *. and the zone's pseudonym; the label after *. is not left whole", () => {
    const wild = dnsRecordRow(r, RECORDS[BLUE.id][2], BLUE.name, ctx)!;
    const apex = dnsRecordRow(r, RECORDS[BLUE.id][0], BLUE.name, ctx)!;
    expect(wild.name).toBe(`*.${apex.name}`);
    expect(wild).toMatchObject({ type: "A", content: apex.content, proxied: 1 });
    expect(dnsRecordRow(r, RECORDS[SHOP.id][2], SHOP.name, ctx)!.name).toBe("*.shop.example");
    expect(r.text(wild.name)).toBe(wild.name); // the Store's pass leaves it
  });

  it("a quoted TXT: each tag value and bare token is a value on its own, so DKIM keys and verification tokens are secrets", () => {
    const key = `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA${"zZ9q".repeat(40)}`;
    const txt = (content: string) => dnsRecordRow(r, { id: "c".repeat(32), name: "sel._domainkey.shop.example", type: "TXT", content, ttl: 1, proxied: false }, SHOP.name, ctx)!.content;
    const dkim = txt(`"v=DKIM1; k=rsa; p=${key.slice(0, 120)}" "${key.slice(120)}"`);
    expect(dkim).toMatch(/^"v=DKIM1; k=rsa; p=<secret:value:[0-9a-f]{8}>" "<secret:value:[0-9a-f]{8}>"$/);
    expect(txt(`"google-site-verification=${"Ab3_".repeat(11)}"`)).toMatch(/^"google-site-verification=<secret:value:[0-9a-f]{8}>"$/);
    expect(txt(`"${"x9Y_".repeat(10)}abc"`)).toMatch(/^"<secret:value:[0-9a-f]{8}>"$/);
    expect(txt(`"v=spf1 ip4:203.0.113.10 ip4:10.40.12.7 include:_spf.example.com ~all"`)).toMatch(new RegExp(`^"v=spf1 ip4:203\\.0\\.113\\.10 ip4:ip-${H6} include:_spf\\.example\\.com ~all"$`));
    expect(txt(`"v=DMARC1; p=reject; rua=mailto:dmarc@bluefin-logistics-zz9q.com"`)).toMatch(new RegExp(`^"v=DMARC1; p=reject; rua=mailto:mail-${H6}@domain-${H6}"$`));
    for (const v of [dkim, txt(`"MS=ms12345678"`)]) expect(r.value(v)).toBe(v); // the Store's pass changes nothing
    const body = auditEventRow(r, { ...raw("a0000002-5b2c-4d3e-8f10-000000000002"), resource: { id: "c".repeat(32), product: "dns_records", type: null, request: { name: "_verify.shop.example", type: "TXT", content: `"${"x9Y_".repeat(10)}abc"` } } }, TENANT)!;
    expect(JSON.parse(body.new_value!).content).toMatch(/^"<secret:value:[0-9a-f]{8}>"$/);
    expect(body.new_value).not.toContain("x9Y_");
  });

  it("drops a record without an id, name, type or content", () => {
    const ok = rec(SHOP, APEX);
    for (const bad of [{ ...ok, id: "" }, { ...ok, name: "" }, { ...ok, type: "" }, { ...ok, content: undefined as unknown as string }]) {
      expect(dnsRecordRow(r, bad, SHOP.name, ctx)).toBeUndefined();
    }
  });
});

describe("dnsObservationRows", () => {
  const rowsOf = (red: Redactor, zone: CfZone, x: CfRecord): Observation[] => dnsObservationRows(red, x, dnsRecordRow(red, x, zone.name, ctx)!);
  const field = (rows: Observation[], f: string): Observation => rows.find((o) => o.setting_path === f)!;

  it("five rows per record, one per field in RECORD_FIELDS order, of the record's DNS run: object_id the record id, host null, live authority", () => {
    const rows = rowsOf(r, SHOP, rec(SHOP, APEX));
    expect(RECORD_FIELDS).toEqual(["type", "name", "content", "ttl", "proxied"]);
    expect(rows.map((o) => o.setting_path)).toEqual([...RECORD_FIELDS]);
    for (const o of rows) {
      expect(o).toMatchObject({ run_id: "run-test", tenant_id: TENANT, surface: "cloudflare.dns", host: null, object_id: APEX, observed_at: NOW.toISOString(), source: "cloudflare", authority: AUTHORITY.live });
      expect(o.obs_id).toBe(obsId("run-test", APEX, o.setting_path));
    }
  });

  it("value_hash is the salted fingerprint of the value as the API sent it; value_redacted is the row's own column, ttl and proxied as integer text", () => {
    const rows = rowsOf(r, SHOP, rec(SHOP, APEX));
    expect(rows.map((o) => [o.setting_path, o.value_hash, o.value_redacted])).toEqual([
      ["type", r.fingerprint("A"), "A"],
      ["name", r.fingerprint("shop.example"), "shop.example"],
      ["content", r.fingerprint("203.0.113.10"), "203.0.113.10"],
      ["ttl", r.fingerprint("1"), "1"],
      ["proxied", r.fingerprint("0"), "0"],
    ]);
    expect(field(rowsOf(r, SHOP, rec(SHOP, WWW)), "proxied").value_redacted).toBe("1");
    // the hash is of the raw value: the pseudonym on display, the salted hash of the real name underneath
    const blue = rowsOf(r, BLUE, RECORDS[BLUE.id][0]);
    expect(field(blue, "name").value_redacted).toMatch(new RegExp(`^host-${H6}\\.com$`));
    expect(field(blue, "name").value_hash).toBe(r.fingerprint("bluefin-logistics-zz9q.com"));
    expect(field(blue, "content").value_hash).toBe(r.fingerprint("10.40.12.7"));
    // an absent ttl or proxied flag: null on display, the fingerprint of "" underneath
    const bare = rowsOf(r, SHOP, { ...rec(SHOP, APEX), ttl: undefined, proxied: undefined });
    expect([field(bare, "ttl"), field(bare, "proxied")].map((o) => [o.value_redacted, o.value_hash])).toEqual([[null, r.fingerprint("")], [null, r.fingerprint("")]]);
  });

  it("content refers to an ip for A and AAAA and to a dns_name for a CNAME, with the redacted value; nothing else refers", () => {
    const apex = rowsOf(r, SHOP, rec(SHOP, APEX));
    expect([field(apex, "content").refers_to_type, field(apex, "content").refers_to_id]).toEqual(["ip", "203.0.113.10"]);
    const www = rowsOf(r, BLUE, RECORDS[BLUE.id][1]);
    const target = dnsRecordRow(r, RECORDS[BLUE.id][0], BLUE.name, ctx)!;
    expect([field(www, "content").refers_to_type, field(www, "content").refers_to_id]).toEqual(["dns_name", target.name]);
    expect(field(rowsOf(r, BLUE, RECORDS[BLUE.id][0]), "content").refers_to_id).toBe(target.content);
    const v6 = rowsOf(r, SHOP, { id: "d".repeat(32), name: "v6.shop.example", type: "AAAA", content: "2001:db8::7", ttl: 1, proxied: false });
    expect([field(v6, "content").refers_to_type, field(v6, "content").refers_to_id]).toEqual(["ip", "2001:db8::7"]);
    for (const id of ["f0e1d2c3b4a59687f0e1d2c3b4a59687", "13579bdf2468ace013579bdf2468ace0"]) {
      expect(rowsOf(r, SHOP, rec(SHOP, id)).every((o) => o.refers_to_type === null && o.refers_to_id === null)).toBe(true);
    }
    expect([...apex, ...www].filter((o) => o.setting_path !== "content").every((o) => o.refers_to_type === null && o.refers_to_id === null)).toBe(true);
  });

  it("a TXT's content is redacted tag by tag, as dnsRecordRow does, and hashed raw, so two keys that both display as secrets keep two hashes", () => {
    const verify = field(rowsOf(r, SHOP, rec(SHOP, "0fedcba987654321fedcba9876543210")), "content");
    expect(verify.value_redacted).toMatch(/^site-verification-token=<secret:kv:[0-9a-f]{8}>$/);
    expect(verify.value_hash).toBe(r.fingerprint("site-verification-token=Qm9ndXNUb2tlbkZvclRlc3RzT25seTEyMzQ1Njc4"));
    const dkim = (key: string): CfRecord => ({ id: "c".repeat(32), name: "sel._domainkey.shop.example", type: "TXT", content: `"v=DKIM1; k=rsa; p=${key}"`, ttl: 1, proxied: false });
    const k1 = `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA${"zZ9q".repeat(30)}`;
    const k2 = `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA${"yY8p".repeat(30)}`;
    const [a, b] = [k1, k2].map((k) => field(rowsOf(r, SHOP, dkim(k)), "content"));
    expect(a.value_redacted).toBe(dnsRecordRow(r, dkim(k1), SHOP.name, ctx)!.content);
    expect(a.value_redacted).toMatch(/^"v=DKIM1; k=rsa; p=<secret:value:[0-9a-f]{8}>"$/);
    expect(a.value_hash).not.toBe(b.value_hash);
    expect(JSON.stringify([a, b])).not.toContain("zZ9q");
  });

  it("deterministic under one salt, salted by it: the same records under the same salt give the same rows, another salt gives other hashes", () => {
    const all = (red: Redactor) => ZONES.flatMap((z) => RECORDS[z.id].flatMap((x) => rowsOf(red, z, x)));
    const mine = all(r);
    expect(all(new Redactor("test-salt"))).toEqual(mine);
    const other = all(new Redactor("other-salt"));
    expect(other.every((o, i) => o.value_hash !== mine[i].value_hash)).toBe(true);
  });

  it("every row is a fixed point of the Store's redaction pass", () => {
    const all = ZONES.flatMap((z) => RECORDS[z.id].flatMap((x) => rowsOf(r, z, x)));
    expect(all).toHaveLength(50);
    for (const o of all) {
      for (const [c, how] of Object.entries(REDACT.observation) as [keyof Observation, "text" | "value"][]) {
        const v = o[c];
        if (typeof v === "string") expect(how === "value" ? r.value(v) : r.text(v), `${o.obs_id}.${c}`).toBe(v);
      }
    }
    expect(JSON.stringify(all)).not.toMatch(RAW_LEAK);
  });
});

describe("auditEventRow", () => {
  it("an update: the vendor id hashed into event_id, the actor a pseudonym and never the email, the record id, the redacted body", () => {
    const e = auditEventRow(r, raw("a0000002-5b2c-4d3e-8f10-000000000002"), TENANT)!;
    expect(e.event_id).toBe(eventId(TENANT, "cloudflare", "a0000002-5b2c-4d3e-8f10-000000000002"));
    expect(e).toMatchObject({ tenant_id: TENANT, source: "cloudflare", action: "update", resource_type: "dns_records/", resource_id: WWW, old_value: null, occurred_at: "2026-04-16T21:11:15.000Z" });
    expect(e.actor).toMatch(new RegExp(`^mail-${H6}@domain-${H6}$`));
    expect(e.actor).toBe(r.text("ops.lead@bluefin-logistics-zz9q.com"));
    expect(JSON.parse(e.new_value!)).toEqual({ name: "www.shop.example", type: "CNAME", content: "parking.example.net", proxied: false, comment: "", tags: [] });
    const blue = auditEventRow(r, raw("a0000006-5b2c-4d3e-8f10-000000000006"), TENANT)!;
    const body = JSON.parse(blue.new_value!);
    expect(body.name).toMatch(new RegExp(`^host-${H6}\\.com$`));
    expect(body.proxied).toBe(true);
    expect(blue.new_value).not.toMatch(RAW_LEAK);
  });

  it("a system create is about value.id, not its own resource.id; a create through a token has no record id and no actor", () => {
    const sys = raw("a0000001-5b2c-4d3e-8f10-000000000001");
    expect(sys.resource!.id).not.toBe(WWW);
    expect(resourceIdOf(sys.resource)).toBe(WWW);
    const e = auditEventRow(r, sys, TENANT)!;
    expect(e).toMatchObject({ action: "create", resource_type: "dns/record", resource_id: WWW, actor: null, occurred_at: "2026-03-20T01:29:03.000Z" });
    expect(JSON.parse(e.new_value!)).toMatchObject({ id: WWW, proxied: false, content: "parking.example.net" });
    const tok = auditEventRow(r, raw("a000000a-5b2c-4d3e-8f10-00000000000a"), TENANT)!;
    expect(tok).toMatchObject({ action: "create", resource_type: "dns_records/", resource_id: null, actor: null });
    expect(JSON.parse(tok.new_value!)).toEqual({ name: "*.shop.example", type: "A", content: "203.0.113.10", proxied: false });
  });

  it("a delete: the removed record goes to old_value and new_value is null; a bodiless API delete has neither", () => {
    const sys = auditEventRow(r, raw("a0000008-5b2c-4d3e-8f10-000000000008"), TENANT)!;
    expect(sys).toMatchObject({ action: "delete", resource_id: OLD, new_value: null, occurred_at: "2026-06-01T10:00:00.200Z" });
    expect(JSON.parse(sys.old_value!)).toMatchObject({ id: OLD, name: "old.shop.example", type: "A" });
    expect(JSON.parse(sys.old_value!).content).toMatch(new RegExp(`^ip-${H6}$`));
    const api = auditEventRow(r, raw("a0000007-5b2c-4d3e-8f10-000000000007"), TENANT)!;
    expect(api).toMatchObject({ action: "delete", resource_type: "dns_records/", resource_id: OLD, old_value: null, new_value: null, actor: null });
  });

  it("resource_type keeps Cloudflare's enums whole; text() would have read explorer.datasets as a host", () => {
    expect(auditEventRow(r, raw("a000000c-5b2c-4d3e-8f10-00000000000c"), TENANT)!.resource_type).toBe("logs/explorer.datasets");
    expect(r.text("logs/explorer.datasets")).not.toBe("logs/explorer.datasets");
    expect(auditEventRow(r, raw("a0000009-5b2c-4d3e-8f10-000000000009"), TENANT)!.resource_type).toBe("certificates/certificate_pack");
    expect(auditEventRow(r, raw("a0000005-5b2c-4d3e-8f10-000000000005"), TENANT)!.resource_type).toBe("account/settings");
    expect(auditEventRow(r, raw("a000000d-5b2c-4d3e-8f10-00000000000d"), TENANT)!.resource_type).toBe("zones/");
    expect(auditEventRow(r, { ...raw("a000000d-5b2c-4d3e-8f10-00000000000d"), resource: { product: "", type: null } }, TENANT)!.resource_type).toBeNull();
  });

  it("normalises 0 to 3 fractional digits to the millisecond form; drops a row without id, type or a parseable time", () => {
    expect(["2026-03-20T01:29:03Z", "2026-04-16T21:12:47.5Z", "2026-10-23T08:00:00.41Z", "2026-10-24T04:20:07.416Z"].map(isoMs))
      .toEqual(["2026-03-20T01:29:03.000Z", "2026-04-16T21:12:47.500Z", "2026-10-23T08:00:00.410Z", "2026-10-24T04:20:07.416Z"]);
    expect(isoMs("2026-04-16")).toBeUndefined();
    expect(isoMs("yesterday")).toBeUndefined();
    const ok = raw("a0000002-5b2c-4d3e-8f10-000000000002");
    for (const bad of [{ ...ok, id: undefined }, { ...ok, action: { ...ok.action, type: undefined } }, { ...ok, action: { ...ok.action, time: "16 Apr 2026" } }, { ...ok, action: undefined }]) {
      expect(auditEventRow(r, bad, TENANT)).toBeUndefined();
    }
  });

  it("every row is a fixed point of the Store's redaction pass, and no email, address or token name survives anywhere", () => {
    const all = events();
    expect(all).toHaveLength(AUDIT.length);
    for (const e of all) {
      for (const [c, how] of Object.entries(REDACT.audit_event) as [keyof AuditEvent, "text" | "value"][]) {
        const v = e[c];
        if (typeof v === "string") expect(how === "value" ? r.value(v) : r.text(v), `${e.event_id}.${c}`).toBe(v);
      }
    }
    expect(JSON.stringify(all)).not.toMatch(RAW_LEAK);
    const certHosts = JSON.parse(all.find((e) => e.resource_type === "certificates/certificate_pack")!.new_value!).hosts;
    expect(certHosts[0]).toMatch(new RegExp(`^host-${H6}\\.com$`));
    expect(certHosts[1]).toMatch(new RegExp(`^\\*\\.host-${H6}\\.com$`));
  });
});

describe("previousState", () => {
  it("is the latest earlier create or update on the record: the 21:11 body before the 21:12 proxied flip", () => {
    const all = events();
    const at = (t: string) => previousState(all, WWW, t);
    expect(at("2026-04-16T21:12:47.500Z")?.event_id).toBe(eventId(TENANT, "cloudflare", "a0000002-5b2c-4d3e-8f10-000000000002"));
    expect(JSON.parse(at("2026-04-16T21:12:47.500Z")!.new_value!).proxied).toBe(false);
    expect(JSON.parse(at("2026-04-16T21:47:29.040Z")!.new_value!)).toMatchObject({ content: "parking.example.net", proxied: true });
    expect(JSON.parse(at("2026-10-24T00:00:00.000Z")!.new_value!)).toMatchObject({ content: "shop.example", proxied: true });
    expect(at("2026-04-16T21:12:47Z")?.event_id).toBe(eventId(TENANT, "cloudflare", "a0000002-5b2c-4d3e-8f10-000000000002")); // before is normalised first
    expect(at("2026-04-16T21:11:15.000Z")?.event_id).toBe(eventId(TENANT, "cloudflare", "a0000001-5b2c-4d3e-8f10-000000000001")); // the system create, by value.id
    expect(at("2026-03-20T01:29:03.000Z")).toBeUndefined(); // nothing strictly earlier
  });

  it("ignores deletes, views and other records; ties on time go to the larger event_id", () => {
    const all = events();
    expect(previousState(all, OLD, "2026-12-31T00:00:00.000Z")).toBeUndefined(); // only deletes touch it
    expect(previousState(all, "no-such-record", "2026-12-31T00:00:00.000Z")).toBeUndefined();
    const base: AuditEvent = { event_id: "evt-a", tenant_id: TENANT, source: "cloudflare", actor: null, action: "update", resource_type: "dns_records/", resource_id: APEX, old_value: null, new_value: "{}", occurred_at: "2026-05-01T00:00:00.000Z" };
    const tie = [base, { ...base, event_id: "evt-b" }, { ...base, event_id: "evt-c", action: "view" }, { ...base, event_id: "evt-d", action: "delete" }];
    expect(previousState(tie, APEX, "2026-06-01T00:00:00.000Z")?.event_id).toBe("evt-b");
  });
});

describe("auditWindow", () => {
  it("defaults to 18 months back plus one day, before tomorrow: the edge the API accepted on 24 Oct 2026", () => {
    expect(auditWindow(NOW)).toEqual({ since: "2025-04-25", before: "2026-10-25", clamped: false });
  });

  it("clamps an older since up to the retention and keeps a newer one", () => {
    expect(auditWindow(NOW, "2025-04-01")).toEqual({ since: "2025-04-25", before: "2026-10-25", clamped: true });
    expect(auditWindow(NOW, "2026-04-16")).toEqual({ since: "2026-04-16", before: "2026-10-25", clamped: false });
    expect(auditWindow(NOW, "2026-10-24")).toEqual({ since: "2026-10-24", before: "2026-10-25", clamped: false });
  });

  it("refuses a malformed or impossible date, and a since that is not before before", () => {
    for (const bad of ["16/04/2026", "2026-4-16", "2026-02-30", "2026-04-16T00:00:00Z", ""]) expect(() => auditWindow(NOW, bad)).toThrow(CloudflareError);
    expect(() => auditWindow(NOW, "2026-10-25")).toThrow(/not before/);
  });

  it("month ends roll forward, so the edge never falls outside the retention", () => {
    expect(auditWindow(new Date("2026-08-31T12:00:00.000Z")).since).toBe("2025-03-04");
    expect(auditWindow(new Date("2027-03-31T12:00:00.000Z")).since).toBe("2025-10-02");
  });
});

describe("Cloudflare client", () => {
  it("walks dns_records pages 1..total_pages at per_page 500 when the server caps the page size", async () => {
    const { cf, log } = api({ recordsCap: 3 });
    const got = await cf.listRecords(SHOP.id);
    expect(got.map((x) => x.id)).toEqual(RECORDS[SHOP.id].map((x) => x.id));
    expect(log).toEqual([1, 2, 3].map((p) => `/zones/${SHOP.id}/dns_records?per_page=${RECORDS_PER_PAGE}&page=${p}`));
    expect(cf.requests).toEqual(log.map((l) => l));
  });

  it("countRecords reads the population from a one-row page", async () => {
    const { cf, log } = api({ recordsCap: 3 });
    expect(await cf.countRecords(SHOP.id)).toBe(7);
    expect(log).toEqual([`/zones/${SHOP.id}/dns_records?per_page=1&page=1`]);
  });

  it("follows the audit cursor at limit 1000 until it is absent; reported sums the per-page counts", async () => {
    const { cf, log } = api({ auditCap: 4 });
    const { rows, reported } = await cf.listAuditLog(ACCOUNT, "2025-04-25", "2026-10-25");
    expect(rows.map((x) => x.id).sort()).toEqual(AUDIT.map((x) => x.id).sort());
    expect(reported).toBe(AUDIT.length);
    expect(log).toHaveLength(Math.ceil(AUDIT.length / 4));
    for (const l of log) expect(l).toContain(`/accounts/${ACCOUNT}/logs/audit?since=2025-04-25&before=2026-10-25&limit=${AUDIT_LIMIT}&direction=asc`);
    expect(log[0]).not.toContain("cursor=");
    for (const l of log.slice(1)) expect(l).toMatch(/&cursor=[A-Za-z0-9_-]+$/);
  });

  it("refuses a repeated cursor instead of looping", async () => {
    const { cf, log } = api({ auditCap: 4, repeatCursor: true });
    await expect(cf.listAuditLog(ACCOUNT, "2025-04-25", "2026-10-25")).rejects.toThrow(/cursor repeated/);
    expect(log).toHaveLength(2);
  });

  it("an API error carries the status and Cloudflare's message, never the token; no token means no request", async () => {
    const { cf } = api({ fail: { "/zones": 403 } });
    const err = await cf.listZones().catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareError);
    expect(err.status).toBe(403);
    expect(err.message).toBe("Cloudflare 403 GET /zones: 10000: Authentication error");
    const refused = await api({ auditCap: 4 }).cf.listAuditLog(ACCOUNT, "2025-04-23", "2026-10-25").catch((e) => e);
    expect(refused.message).toMatch(/^Cloudflare 400 .*Audit Logs expire after 18 months/);
    const fake = fakeApi({ zones: ZONES, records: RECORDS, audit: AUDIT });
    const none = new Cloudflare({ token: "", fetch: fake.fetch });
    await expect(none.listZones()).rejects.toThrow(/CLOUDFLARE_API_TOKEN is not set/);
    expect(fake.log).toEqual([]);
    const wrong = await new Cloudflare({ token: "wrong-token-value-1234567890", fetch: fake.fetch }).listZones().catch((e) => e);
    expect(wrong.message).not.toContain("wrong-token");
  });
});

describe("collectCloudflare", () => {
  it("one pass: every zone counted before any record row, both runs complete, nothing raw in what it returns", async () => {
    const { cf, log } = api({ recordsCap: 3, auditCap: 4 });
    const c = await collectCloudflare(cf, r, { tenantId: TENANT, now: () => NOW });
    expect(c.errors).toEqual([]);
    expect(c.dnsRun).toMatchObject({ tenant_id: TENANT, surface: "cloudflare.dns", host: null, started_at: NOW.toISOString(), expected_count: 10, observed_count: 10, status: "complete" });
    expect(c.auditRun).toMatchObject({ surface: "cloudflare.audit", expected_count: AUDIT.length, observed_count: AUDIT.length, status: "complete" });
    expect(c.dnsRun.run_id).toMatch(/^run-[0-9a-f]{16}$/);
    expect(c.dnsRun.run_id).not.toBe(c.auditRun.run_id);
    const lastCount = log.map((l) => l.includes("per_page=1&")).lastIndexOf(true);
    const firstRows = log.findIndex((l) => l.includes(`per_page=${RECORDS_PER_PAGE}&`));
    expect(lastCount).toBeGreaterThan(0);
    expect(lastCount).toBeLessThan(firstRows);
    expect(c.zones).toEqual([
      { zone: "shop.example", expected: 7, observed: 7 },
      { zone: r.text("bluefin-logistics-zz9q.com"), expected: 3, observed: 3 },
    ]);
    expect(c.records.every((d) => d.run_id === c.dnsRun.run_id && d.observed_at === NOW.toISOString())).toBe(true);
    expect(c.records.find((d) => d.record_id === WWW)!.proxied).toBe(1);
    expect(c.records.find((d) => d.record_id === APEX)!.proxied).toBe(0);
    expect(c.window).toEqual({ since: "2025-04-25", before: "2026-10-25", clamped: false });
    expect(c.events.map((e) => e.occurred_at)).toEqual([...c.events.map((e) => e.occurred_at)].sort());
    expect(c.eventZone.get(eventId(TENANT, "cloudflare", "a0000009-5b2c-4d3e-8f10-000000000009"))).toBe(r.text("bluefin-logistics-zz9q.com"));
    expect(c.eventZone.get(eventId(TENANT, "cloudflare", "a0000008-5b2c-4d3e-8f10-000000000008"))).toBe("shop.example");
    expect(c.eventZone.get(eventId(TENANT, "cloudflare", "a000000d-5b2c-4d3e-8f10-00000000000d"))).toBeNull();
    const { rawRecords, ...redacted } = c;
    expect(JSON.stringify({ ...redacted, eventZone: [...c.eventZone] })).not.toMatch(RAW_LEAK);
    // rawRecords is the one raw field: every zone's records as the API sent them, under the zone's real name, for the vault
    expect(rawRecords).toEqual(ZONES.map((z) => ({ zoneId: z.id, zone: z.name, records: RECORDS[z.id] })));
    expect(JSON.stringify(rawRecords)).toMatch(RAW_LEAK);
  });

  it("the DNS run's observations: five per record, all of the DNS run, while expected_count and observed_count count records", async () => {
    const c = await collectCloudflare(api({ recordsCap: 3 }).cf, r, { tenantId: TENANT, now: () => NOW });
    expect(c.observations).toHaveLength(5 * c.records.length);
    expect(c.observations).toHaveLength(50);
    expect([c.dnsRun.expected_count, c.dnsRun.observed_count]).toEqual([10, 10]);
    expect(new Set(c.observations.map((o) => o.obs_id)).size).toBe(50);
    expect(c.observations.every((o) => o.run_id === c.dnsRun.run_id && o.surface === "cloudflare.dns" && o.host === null && o.observed_at === c.dnsRun.started_at)).toBe(true);
    // per record, the fields in order, and each display value is the stored dns_record column as text
    for (const d of c.records) {
      const mine = c.observations.filter((o) => o.object_id === d.record_id);
      expect(mine.map((o) => o.setting_path), d.record_id).toEqual([...RECORD_FIELDS]);
      expect(mine.map((o) => o.value_redacted), d.record_id).toEqual([d.type, d.name, d.content, d.ttl === null ? null : String(d.ttl), d.proxied === null ? null : String(d.proxied)]);
    }
    expect(c.observations.filter((o) => o.setting_path === "proxied").map((o) => o.value_redacted).sort()).toEqual([..."0000001111"]);
    // a second pass over the same records under the same salt gives the same rows
    expect((await collectCloudflare(api().cf, new Redactor("test-salt"), { tenantId: TENANT, now: () => NOW })).observations).toEqual(c.observations);
  });

  it("the vault hook takes rawRecords straight from the collection: one file per stored record", async () => {
    const c = await collectCloudflare(api({ recordsCap: 3 }).cf, r, { tenantId: TENANT, now: () => NOW });
    const files = cloudflareVaultFiles(c, c.rawRecords, r);
    expect(files.map((f) => f.objectId).sort()).toEqual(c.records.map((d) => d.record_id).sort());
    expect(files.find((f) => f.objectId === APEX)!.path).toBe(`${SHOP.name}/${APEX}.json`);
  });

  it("a population that moves between the count and the fetch is partial, not complete", async () => {
    let moved = false;
    const { cf } = api({
      recordsCap: 3,
      onRecordsPage: (zoneId, page, rows) => {
        if (moved || zoneId !== SHOP.id || page !== 1) return;
        moved = true;
        rows.push({ id: "99999999999999999999999999999999", name: "new.shop.example", type: "A", content: "203.0.113.99", ttl: 1, proxied: false });
      },
    });
    const c = await collectCloudflare(cf, r, { tenantId: TENANT, now: () => NOW });
    expect(c.dnsRun).toMatchObject({ expected_count: 10, observed_count: 11, status: "partial" });
    expect(c.zones[0]).toEqual({ zone: "shop.example", expected: 7, observed: 8 });
    expect(c.observations).toHaveLength(55);
  });

  it("a since older than the retention is clamped, so the API that refuses it still answers", async () => {
    const { cf, log } = api();
    const c = await collectCloudflare(cf, r, { tenantId: TENANT, since: "2024-01-01", now: () => NOW });
    expect(c.window).toEqual({ since: "2025-04-25", before: "2026-10-25", clamped: true });
    expect(c.auditRun.status).toBe("complete");
    expect(log.find((l) => l.includes("/logs/audit"))).toContain("since=2025-04-25&");
  });

  it("an audit failure fails that run only, with a redacted error; a dns failure before the count leaves expected_count null", async () => {
    const audit = await collectCloudflare(api({ fail: { "/accounts/": 403 } }).cf, r, { tenantId: TENANT, now: () => NOW });
    expect(audit.dnsRun.status).toBe("complete");
    expect(audit.auditRun).toMatchObject({ expected_count: null, observed_count: 0, status: "failed" });
    expect(audit.errors).toEqual([`cloudflare.audit: Cloudflare 403 GET /accounts/${ACCOUNT}/logs/audit: 10000: Authentication error`]);
    const dns = await collectCloudflare(api({ fail: { [`/zones/${BLUE.id}/`]: 403 } }).cf, r, { tenantId: TENANT, now: () => NOW });
    expect(dns.dnsRun).toMatchObject({ expected_count: null, observed_count: 0, status: "failed" });
    expect([dns.records, dns.observations, dns.rawRecords]).toEqual([[], [], []]);
    expect(dns.auditRun.status).toBe("complete");
  });
});

describe("Cloudflare record writes (patchRecord, createRecord)", () => {
  const mail: CfRecord = { id: "rec-c3", name: "mail.example.invalid", type: "A", content: "198.51.100.11", ttl: 3600, proxied: false };
  const writer = (opts: { failWrites?: boolean } = {}) => {
    const fake = fakeCloudflare([{ id: "zone-0001", name: "example.invalid" }], { "zone-0001": [mail] }, { ...opts, nextId: "rec-new-0001" });
    return { fake, cf: new Cloudflare({ token: CF_TOKEN, fetch: fake.fetch }) };
  };

  it("patchRecord PATCHes the record with type, name, content, ttl and proxied as JSON and returns the record as the API holds it", async () => {
    const { fake, cf } = writer();
    const got = await cf.patchRecord("zone-0001", "rec-c3", { type: "A", name: "mail.example.invalid", content: "198.51.100.12", ttl: 3600, proxied: false });
    expect(got).toEqual({ ...mail, content: "198.51.100.12" });
    expect(fake.log).toEqual([{ method: "PATCH", path: "/zones/zone-0001/dns_records/rec-c3", body: { type: "A", name: "mail.example.invalid", content: "198.51.100.12", ttl: 3600, proxied: false } }]);
    expect(cf.requests).toEqual(["PATCH /zones/zone-0001/dns_records/rec-c3"]);
  });

  it("createRecord POSTs the fields and returns the record with the id Cloudflare gave it; a body without ttl and proxied sends neither", async () => {
    const { fake, cf } = writer();
    const got = await cf.createRecord("zone-0001", { type: "CNAME", name: "www.example.invalid", content: "mail.example.invalid" });
    expect(got).toEqual({ id: "rec-new-0001", type: "CNAME", name: "www.example.invalid", content: "mail.example.invalid" });
    expect(fake.log).toEqual([{ method: "POST", path: "/zones/zone-0001/dns_records", body: { type: "CNAME", name: "www.example.invalid", content: "mail.example.invalid" } }]);
  });

  it("a body of another shape is refused before any request; an API refusal carries the method, the path and Cloudflare's message, never the token", async () => {
    const { fake, cf } = writer();
    await expect(cf.patchRecord("zone-0001", "rec-c3", { type: "A", name: "mail.example.invalid", content: "" })).rejects.toThrow(/content must be a non-empty string/);
    await expect(cf.createRecord("zone-0001", { type: "A", name: "x.example.invalid", content: "198.51.100.1", ttl: 0 })).rejects.toThrow(/ttl must be a positive integer/);
    await expect(cf.createRecord("zone-0001", { type: "A", name: "x.example.invalid", content: "198.51.100.1", proxied: "true" as unknown as boolean })).rejects.toThrow(/proxied must be true or false/);
    expect(fake.log).toEqual([]);
    const refused = writer({ failWrites: true });
    const err = await refused.cf.patchRecord("zone-0001", "rec-c3", { type: "A", name: "mail.example.invalid", content: "198.51.100.12" }).catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareError);
    expect([err.status, err.message]).toEqual([403, "Cloudflare 403 PATCH /zones/zone-0001/dns_records/rec-c3: 10000: Authentication error"]);
    expect(err.message).not.toContain(CF_TOKEN);
    const none = new Cloudflare({ token: "", fetch: refused.fake.fetch });
    await expect(none.createRecord("zone-0001", { type: "A", name: "x.example.invalid", content: "198.51.100.1" })).rejects.toThrow(/CLOUDFLARE_API_TOKEN is not set/);
    expect(refused.fake.log).toHaveLength(1);
  });
});
