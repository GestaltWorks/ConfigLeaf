// Microsoft 365 as a source: the Graph client over a fake of its two endpoints (test/fixtures/m365), the collector's
// rows and its redaction (no tenant name, tenant id or client id survives, in a row, a URL, a request log or an
// error), the detector MAIL_RECORDS_SQL over those rows and Cloudflare records of the same names, the pass that
// raises m365_mail_record, and the policy's 17th rule, which escalates it with the record and the domain named.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dnsRecordRow, type CfRecord } from "../src/collectors/cloudflare.ts";
import {
  Graph, M365Error, M365_SURFACE, MAIL_FIELDS, collectM365, expectedRecord, mailObservationRows, scrubIds, spfRequirement, survivingNames, tenantNames,
  type ExpectedRecord, type FetchLike,
} from "../src/collectors/m365.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { MAIL_RECORDS_SQL, objects } from "../src/data/queries.ts";
import { AUTHORITY, REDACT, type CollectionRun, type DnsRecord, type Observation } from "../src/data/rows.ts";
import { MAIL_ABSENT, MAIL_NOT_RECORDED, latestMailRuns, mailObject, mailRecordFindings, recordWords } from "../src/m365.ts";
import { runPass } from "../src/pipeline.ts";
import { loadPolicyFile } from "../src/policy/load.ts";
import { decide } from "../src/policy/decide.ts";
import { resolvePolicy } from "../src/policy/resolve.ts";
import { Redactor } from "../src/redactor.ts";
import { ACCESS_TOKEN, CLIENT_ID, CLIENT_SECRET, GRAPH_URL, LOGIN_URL, TENANT_ID, fakeGraph, type FakeGraphOptions } from "./fixtures/m365/fake-graph.ts";
import { MemTracer } from "./fixtures/mem-tracer.ts";
import { MAIL_DNS_RUN, mailRun, mailWorld } from "./fixtures/m365/world.ts";
import { redactedLine } from "../src/policy/decide.ts";
import { isMailRecord, MIN_CREDENTIAL } from "../src/collectors/m365.ts";

const r = new Redactor("m365-test-salt");
const H6 = "[0-9a-f]{6}";
const TENANT = "client-a";
const NOW = new Date("2026-10-26T06:00:00.000Z");
/** Every raw name of the fixture tenant and its credentials: none may reach a row, a log line or an error. */
const RAW = /contoso|fabrikam|northwind|outlook|sharepoint|lync|microsoftonline|fixture-client-secret|fixture-access-token|0000000000aa|0000000000bb/i;

function graph(o: FakeGraphOptions = {}, fetchOverride?: FetchLike) {
  const fake = fakeGraph(o);
  return { g: new Graph({ tenantId: TENANT_ID, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: fetchOverride ?? fake.fetch, loginUrl: LOGIN_URL, graphUrl: GRAPH_URL }), fake };
}
const collect = (g: Graph, red: Redactor = r) => collectM365(g, red, { tenantId: TENANT, now: () => NOW, graphTenant: TENANT_ID, graphClient: CLIENT_ID });

describe("the Graph client", () => {
  it("buys one client-credentials token for the Graph scope and sends it with every GET; follows the domains' nextLink", async () => {
    const { g, fake } = graph();
    const domains = await g.listDomains();
    expect(domains.map((d) => d.id)).toEqual(["contoso.com", "contoso.onmicrosoft.com", "fabrikam.com", "northwind.com"]);
    await g.serviceRecords("contoso.com");
    expect(fake.log.filter((l) => l.startsWith("POST "))).toHaveLength(1);
    const form = new URLSearchParams(fake.bodies[0]);
    expect(Object.fromEntries(form)).toEqual({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
    expect(fake.log).toEqual([
      `POST ${LOGIN_URL}/${TENANT_ID}/oauth2/v2.0/token`, `GET ${GRAPH_URL}/domains`, `GET ${GRAPH_URL}/domains?$skiptoken=1`, `GET ${GRAPH_URL}/domains/contoso.com/serviceConfigurationRecords`,
    ]);
  });

  it("logs each request as a method and a path template: no tenant id, client id, domain name, form body or token", async () => {
    const { g } = graph();
    await collect(g);
    expect(g.requests).toEqual([
      "POST /{tenant}/oauth2/v2.0/token", "GET /domains", "GET /domains (page 2)",
      "GET /domains/{id}/serviceConfigurationRecords", "GET /domains/{id}/serviceConfigurationRecords",
    ]);
    expect(g.requests.join("\n")).not.toMatch(RAW);
  });

  it("follows no nextLink outside the Graph base it was given, so the token goes nowhere else", async () => {
    const { g, fake } = graph({ nextLink: "https://graph.attacker.test/v1.0/domains?$skiptoken=1" });
    await expect(g.listDomains()).rejects.toThrow(/a nextLink outside https:\/\/graph\.test\/v1\.0 is not followed/);
    expect(fake.log.some((l) => l.includes("attacker"))).toBe(false);
  });

  it("refuses to ask for a token with a key blank, and makes no request", async () => {
    const fake = fakeGraph();
    for (const blank of [{ tenantId: "" }, { clientId: "" }, { clientSecret: "" }]) {
      const g = new Graph({ tenantId: TENANT_ID, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: fake.fetch, loginUrl: LOGIN_URL, graphUrl: GRAPH_URL, ...blank });
      await expect(g.listDomains()).rejects.toThrow("M365_TENANT_ID, M365_CLIENT_ID and M365_CLIENT_SECRET must all be set");
    }
    expect(fake.log).toEqual([]);
  });
});

describe("the tenant id and the client id never reach an error, a URL or a trace", () => {
  /** An error's message, or "" when the promise resolved. */
  const message = async (p: Promise<unknown>): Promise<string> => p.then(() => "", (e: Error) => e.message);

  it("a refused token keeps the error and the AADSTS code alone: not the description that names the app, the URL or the secret", async () => {
    const { g } = graph({ tokenAnswer: { status: 401, body: { error: "invalid_client", error_description: `AADSTS7000215: Invalid client secret provided for app '${CLIENT_ID}' in tenant '${TENANT_ID}'.`, error_codes: [7000215] } } });
    const m = await message(g.listDomains());
    expect(m).toBe("M365 token 401: invalid_client (AADSTS7000215)");
    const { g: tenantless } = graph({ tokenAnswer: { status: 400, body: { error: "invalid_request", error_description: `AADSTS90002: Tenant '${TENANT_ID}' not found.`, error_codes: [90002] } } });
    expect(await message(tenantless.listDomains())).toBe("M365 token 400: invalid_request (AADSTS90002)");
  });

  it("a request that throws with the token URL in its message (network, timeout) has the tenant id scrubbed, raw, upper case and URL-encoded", async () => {
    for (const url of [`${LOGIN_URL}/${TENANT_ID}/oauth2/v2.0/token`, `${LOGIN_URL}/${TENANT_ID.toUpperCase()}/oauth2/v2.0/token`, `${LOGIN_URL}/${encodeURIComponent(`{${TENANT_ID}}`)}/oauth2`]) {
      const throwing: FetchLike = async () => { throw Object.assign(new TypeError(`fetch failed: ${url}`), { cause: { message: `connect ETIMEDOUT for client ${CLIENT_ID}` } }); };
      const { g } = graph({}, throwing);
      const m = await message(g.listDomains());
      expect(m).toMatch(/^M365 token request failed: fetch failed: https:\/\/login\.test\/(?:<tenant>|%7B<tenant>%7D)/);
      expect(m).not.toMatch(RAW);
      expect(m.toLowerCase()).not.toContain(TENANT_ID.slice(0, 8));
    }
  });

  it("a Graph error that names the tenant id or the client id has both scrubbed, and so does a GET that throws", async () => {
    const { g } = graph({ failing: { "contoso.com": { status: 403, body: { error: { code: "Authorization_RequestDenied", message: `Insufficient privileges for app ${CLIENT_ID} in tenant ${TENANT_ID}.` } } } } });
    await g.listDomains();
    const m = await message(g.serviceRecords("contoso.com"));
    expect(m).toBe("Graph 403 GET /domains/{id}/serviceConfigurationRecords: Authorization_RequestDenied: Insufficient privileges for app <client> in tenant <tenant>.");
    const fake = fakeGraph();
    let calls = 0;
    const flaky: FetchLike = async (url, init) => (++calls === 1 ? fake.fetch(url, init) : Promise.reject(new Error(`socket hang up ${url}?tenant=${TENANT_ID}`)));
    const { g: g2 } = graph({}, flaky);
    expect(await message(g2.listDomains())).toBe("Graph GET /domains failed: socket hang up https://graph.test/v1.0/domains?tenant=<tenant>");
  });

  it("the collector's errors and its trace-bound counts carry neither id: a failed run says what failed with both scrubbed", async () => {
    const { g } = graph({ failing: { "fabrikam.com": { status: 503, body: { error: { code: "serviceNotAvailable", message: `tenant ${TENANT_ID} app ${CLIENT_ID}` } } } } });
    const c = await collect(g);
    expect(c.run.status).toBe("partial");
    expect(c.errors).toEqual(["m365.dns: Graph 503 GET /domains/{id}/serviceConfigurationRecords: serviceNotAvailable: tenant <tenant> app <client>"]);
    expect(JSON.stringify([c.run, c.counts, c.errors, c.observations])).not.toMatch(RAW);
  });

  it("scrubIds replaces each value, case aside, raw and URL-encoded, and leaves short values alone", () => {
    expect(scrubIds("a ABCD-1234 b abcd-1234 c %7Bx%7D", [["abcd-1234", "<t>"], ["{x}", "<y>"], ["ab", "<z>"]])).toBe("a <t> b <t> c %7Bx%7D");
    expect(scrubIds("a %7Babcd%7D", [["{abcd}", "<t>"]])).toBe("a <t>");
  });
});

describe("collectM365 over the fixture tenant", () => {
  it("compares the verified domains outside onmicrosoft.com and keeps their mail records: the MX, the SPF TXT and the autodiscover CNAME", async () => {
    const c = await collect(graph().g);
    expect(c.counts).toEqual({ domains: 4, verified: 3, initial: 1, inScope: 2, listed: 15, mail: 6, other: 9, byType: { MX: 2, TXT: 2, CNAME: 2 } });
    expect(c.run).toMatchObject({ tenant_id: TENANT, surface: M365_SURFACE, host: null, expected_count: 6, observed_count: 6, status: "complete", started_at: NOW.toISOString() });
    expect(c.errors).toEqual([]);
    expect(c.survivors).toBe(0);
    expect(c.observations).toHaveLength(24);
  });

  it("four rows per record in MAIL_FIELDS order under <domain>/<TYPE>/<label>; the name refers to the dns_name Cloudflare's row carries; the SPF row holds the include", async () => {
    const c = await collect(graph().g);
    const objects = [...new Set(c.observations.map((o) => o.object_id))];
    expect(objects).toHaveLength(6);
    for (const id of objects) expect(id).toMatch(new RegExp(`^host-${H6}\\.com/(?:MX/@|TXT/@|CNAME/autodiscover)$`));
    for (const id of objects) expect(c.observations.filter((o) => o.object_id === id).map((o) => o.setting_path)).toEqual([...MAIL_FIELDS]);
    for (const o of c.observations) expect(o).toMatchObject({ run_id: c.run.run_id, tenant_id: TENANT, surface: M365_SURFACE, host: null, source: "m365", authority: AUTHORITY.live, observed_at: NOW.toISOString() });
    const field = (id: string, s: string): Observation => c.observations.find((o) => o.object_id === id && o.setting_path === s)!;
    const txt = objects.find((o) => o.includes("/TXT/"))!;
    expect(field(txt, "content").value_redacted).toMatch(new RegExp(`^include:host-${H6}\\.com$`));
    expect(field(txt, "content").value_hash).toBe(r.fingerprint("v=spf1 include:spf.protection.outlook.com -all"));
    expect(field(txt, "type").value_redacted).toBe("TXT");
    const name = field(txt, "name");
    expect(name).toMatchObject({ refers_to_type: "dns_name", refers_to_id: name.value_redacted });
    // the apex record's name and its domain are one pseudonym, the zone's
    expect(name.value_redacted).toBe(field(txt, "domain").value_redacted);
    expect(txt.startsWith(`${name.value_redacted}/`)).toBe(true);
  });

  it("redacts with the Cloudflare collector's calls: under one salt the name, the MX host and the SPF include are the pseudonyms dns_record carries", async () => {
    const c = await collect(graph().g);
    const ctx = { tenantId: TENANT, runId: "run-cf", observedAt: NOW.toISOString() };
    const cf = (rec: Omit<CfRecord, "id">): DnsRecord => dnsRecordRow(r, { id: "rec", ...rec }, "contoso.com", ctx)!;
    const mx = cf({ name: "contoso.com", type: "MX", content: "contoso-com.mail.protection.outlook.com" });
    const spf = cf({ name: "contoso.com", type: "TXT", content: '"v=spf1 include:spf.protection.outlook.com -all"' });
    const auto = cf({ name: "autodiscover.contoso.com", type: "CNAME", content: "autodiscover.outlook.com" });
    const of = (type: string, s: string) => c.observations.find((o) => o.object_id === `${mx.zone}/${type}/${type === "CNAME" ? "autodiscover" : "@"}` && o.setting_path === s)!;
    expect(of("MX", "name").refers_to_id).toBe(mx.name);
    expect(of("MX", "content").value_redacted).toBe(mx.content);
    expect(spf.content).toContain(of("TXT", "content").value_redacted!);
    expect(of("CNAME", "name").refers_to_id).toBe(auto.name);
    expect(of("CNAME", "content").value_redacted).toBe(auto.content);
  });

  it("no tenant name survives: the rows hold no raw name, the probe counts none, and the Store's own pass changes nothing", async () => {
    const c = await collect(graph().g);
    expect(JSON.stringify(c.observations)).not.toMatch(RAW);
    expect(survivingNames(c.observations, tenantNames(["contoso.com", "contoso.onmicrosoft.com", "fabrikam.com", "northwind.com"], TENANT_ID))).toBe(0);
    for (const o of c.observations) {
      for (const [col, how] of Object.entries(REDACT.observation)) {
        const v = (o as unknown as Record<string, string | null>)[col];
        if (v !== null) expect(how === "value" ? r.value(v) : r.text(v), `${o.setting_path} ${col}`).toBe(v);
      }
    }
  });

  it("a redactor that let a name through keeps no row: the run fails, and its one error counts the names without naming them", async () => {
    class Leaky extends Redactor {
      override text(s: string): string { return s; }
      override value(s: string): string { return s; }
    }
    const c = await collect(graph().g, new Leaky("x"));
    expect(c.observations).toEqual([]);
    expect(c.run).toMatchObject({ status: "failed", observed_count: 0, expected_count: 6 });
    expect(c.survivors).toBeGreaterThan(0);
    expect(c.errors).toEqual([`m365.dns: ${c.survivors} tenant name(s) stood alone after redaction; no row is kept`]);
  });

  it("a mail TXT that is no SPF record, or a record without its value, leaves the run partial and says why without a name", async () => {
    const { RECORDS } = await import("./fixtures/m365/fake-graph.ts");
    const records = structuredClone(RECORDS);
    records["contoso.com"][1].text = "MS=ms12345678";
    delete records["fabrikam.com"][0].mailExchange;
    const c = await collect(graph({ records }).g);
    expect(c.run).toMatchObject({ status: "partial", expected_count: 6, observed_count: 4 });
    expect(c.errors).toEqual([
      "m365.dns: a mail TXT record that is no SPF record (this surface keeps the SPF record alone)",
      "m365.dns: a MX record without its value",
    ]);
  });

  it("tenantNames lists each domain, its dashed form, its registrable label, the initial domain's labels and the tenant id; never Microsoft's own words", () => {
    expect(tenantNames(["Contoso.com", "contoso.onmicrosoft.com", "shop.fabrikam.co.uk", "mail.com"], TENANT_ID.toUpperCase())).toEqual([
      TENANT_ID, "contoso", "contoso-com", "contoso-onmicrosoft-com", "contoso.com", "contoso.onmicrosoft.com", "fabrikam", "mail-com", "mail.com", "shop-fabrikam-co-uk", "shop.fabrikam.co.uk",
    ].sort());
    expect(spfRequirement("v=spf1 include:spf.protection.outlook.com -all")).toBe("include:spf.protection.outlook.com");
    expect(spfRequirement("v=spf1 ip4:192.0.2.1 include:a.example ~all")).toBe("ip4:192.0.2.1 include:a.example");
  });
});

describe("the redactor's Microsoft 365 rule (pass d)", () => {
  it("every label before .onmicrosoft.com is tenant-XXXXXX; a DKIM target keeps its selector prefix, _domainkey and the suffix; a fixed point", () => {
    const old = r.value("selector1-contoso-com._domainkey.contoso.onmicrosoft.com");
    expect(old).toMatch(new RegExp(`^selector1-tenant-${H6}\\._domainkey\\.tenant-${H6}\\.onmicrosoft\\.com$`));
    const partition = r.value("Selector2-Contoso-COM._domainkey.CONTOSO.y-v1.dkim.mail.microsoft");
    expect(partition).toMatch(new RegExp(`^selector2-tenant-${H6}\\._domainkey\\.tenant-${H6}\\.y-v1\\.dkim\\.mail\\.microsoft$`));
    expect(partition.split(".")[2]).toBe(old.split(".")[2]);
    expect(r.text("the initial domain contoso.onmicrosoft.com, and *.contoso.onmicrosoft.com")).toMatch(new RegExp(`^the initial domain tenant-${H6}\\.onmicrosoft\\.com, and \\*\\.tenant-${H6}\\.onmicrosoft\\.com$`));
    for (const s of [old, partition, "selector1-tenant-abcdef._domainkey.tenant-123456.onmicrosoft.com"]) expect(r.text(r.value(s))).toBe(s);
    expect(new Redactor("another-salt").value("contoso.onmicrosoft.com")).not.toBe(r.value("contoso.onmicrosoft.com"));
  });

  it("a DKIM CNAME, were Graph to list one, joins Cloudflare's record of it: one pseudonym for the target on both sides", () => {
    const e = expectedRecord("contoso.com", { label: "selector1._domainkey.contoso.com", recordType: "CName", supportedService: "Email", canonicalName: "selector1-contoso-com._domainkey.contoso.onmicrosoft.com" }) as ExpectedRecord;
    const rows = mailObservationRows(r, e, { tenantId: TENANT, runId: "run-m", observedAt: NOW.toISOString() });
    const cf = dnsRecordRow(r, { id: "rec", name: "selector1._domainkey.contoso.com", type: "CNAME", content: "selector1-contoso-com._domainkey.contoso.onmicrosoft.com" }, "contoso.com", { tenantId: TENANT, runId: "run-cf", observedAt: NOW.toISOString() })!;
    expect(rows[0].object_id).toBe(`${cf.zone}/CNAME/selector1._domainkey`);
    expect(rows[3].value_redacted).toBe(cf.content);
    expect(rows[2].refers_to_id).toBe(cf.name);
    expect(recordWords("CNAME", "selector1._domainkey")).toBe("the DKIM CNAME selector1._domainkey");
  });
});

// ---- the detector, over sql.js -------------------------------------------------------------------------------------

const DNS_RUN = MAIL_DNS_RUN;
const at = NOW.toISOString();
const run = mailRun;

async function world(opts: { zones?: string[]; policy?: boolean } = {}) {
  const w = await mailWorld(opts);
  const engine = await SqlJsEngine.create();
  engine.loadBundle(w.bundle);
  return { layer: new DataLayer(engine), c: w.c, dns: w.dns };
}

describe("MAIL_RECORDS_SQL and mailRecordFindings", () => {
  it("returns each required record the zone lacks or serves otherwise: contoso's autodiscover missing; fabrikam's MX, SPF and proxied autodiscover different", async () => {
    const { layer, c } = await world();
    const rows = objects(await layer.run(MAIL_RECORDS_SQL, { tenant_id: TENANT, run_id: c.run.run_id, dns_run_id: DNS_RUN }));
    const named = rows.map((x) => [mailObject(x.object_id).type, mailObject(x.object_id).label, x.state, x.record_id, x.proxied]);
    expect(named.filter((n) => n[2] === "missing")).toEqual([["CNAME", "autodiscover", "missing", "", ""]]);
    expect(named.filter((n) => n[2] === "different").sort()).toEqual([["CNAME", "autodiscover", "different", "f3", "1"], ["MX", "@", "different", "f1", "0"], ["TXT", "@", "different", "f2", ""]].sort());
    expect(rows.map((x) => x.domain).every((d) => new RegExp(`^host-${H6}\\.com$`).test(d))).toBe(true);
  });

  it("one finding per record, its line naming the record, the domain, what Microsoft 365 requires and what the zone serves; one detect line with the whole tally", async () => {
    const { layer, c } = await world();
    const tracer = new MemTracer("t_m365", { model: "none" });
    const fs = await mailRecordFindings(layer, { run: c.run as unknown as Record<string, string>, gated: false, dns: { run_id: DNS_RUN, started_at: at, tenant_id: TENANT } }, { tracer, agent: "detector" });
    expect(fs).toHaveLength(4);
    const tally = tracer.events.find((e) => e.input_summary?.startsWith("m365_mail_record "))!;
    expect(tally.output_summary).toBe("m365.dns: 6 record(s) Microsoft 365 requires for 2 domain(s), 6 in the zones of the DNS run: 2 served as required, 1 missing, 3 different");
    for (const f of fs) expect(f).toMatchObject({ class: "m365_mail_record", surface: M365_SURFACE, host: null, setting_path: "content", run_id: c.run.run_id, dns_run_id: DNS_RUN, refers_to_type: "dns_name" });
    const missing = fs.find((f) => f.summary.includes("missing"))!;
    expect(missing.summary).toMatch(new RegExp(`^the autodiscover CNAME of host-${H6}\\.com is missing from Cloudflare: Microsoft 365 requires CNAME host-${H6}\\.com at host-${H6}\\.com$`));
    expect(missing.resource_id).toBeNull();
    const proxied = fs.find((f) => f.object_id.endsWith("/CNAME/autodiscover") && f.summary.includes("different"))!;
    expect(proxied.summary).toMatch(/and the zone serves host-[0-9a-f]{6}\.com \(proxied\)$/);
    expect(proxied.resource_id).toBe("f3");
    const spf = fs.find((f) => f.object_id.endsWith("/TXT/@"))!;
    expect(spf.summary).toMatch(new RegExp(`^the SPF record of host-${H6}\\.com is different in Cloudflare: Microsoft 365 requires an SPF record carrying include:host-${H6}\\.com at host-${H6}\\.com, and the zone serves "v=spf1 include:_spf\\.mailer\\.example ~all"$`));
    expect(JSON.stringify(fs)).not.toMatch(RAW);
  });

  it("a domain that is no zone of the DNS run is not Cloudflare's to serve: no finding, and the tally says so", async () => {
    const { layer, c } = await world({ zones: ["contoso.com"] });
    const tracer = new MemTracer("t_m365_zone", { model: "none" });
    const fs = await mailRecordFindings(layer, { run: c.run as unknown as Record<string, string>, gated: false, dns: { run_id: DNS_RUN, started_at: at, tenant_id: TENANT } }, { tracer });
    expect(fs.map((f) => mailObject(f.object_id).label)).toEqual(["autodiscover"]);
    const tally = tracer.events.find((e) => e.input_summary?.startsWith("m365_mail_record "))!;
    expect(tally.output_summary).toContain("6 record(s) Microsoft 365 requires for 2 domain(s), 3 in the zones of the DNS run: 2 served as required, 1 missing, 0 different");
    expect(tally.detail).toBe("3 record(s) of domains outside the collected zones are not Cloudflare's to serve; model: none");
  });

  it("when every record is served as required it says so, a real result and no finding", async () => {
    const { layer, c } = await world({ zones: ["contoso.com"] });
    const engine = layer.engine as SqlJsEngine;
    engine.insertRows("dns_record", [dnsRecordRow(r, { id: "c5", name: "autodiscover.contoso.com", type: "CNAME", content: "autodiscover.outlook.com", proxied: false }, "contoso.com", { tenantId: TENANT, runId: DNS_RUN, observedAt: at })!]);
    const tracer = new MemTracer("t_m365_match", { model: "none" });
    const fs = await mailRecordFindings(layer, { run: c.run as unknown as Record<string, string>, gated: false, dns: { run_id: DNS_RUN, started_at: at, tenant_id: TENANT } }, { tracer });
    expect(fs).toEqual([]);
    expect(tracer.events.at(-1)!.output_summary).toContain("3 in the zones of the DNS run: 3 served as required, 0 missing, 0 different");
  });

  it("a run that failed the gate, or one with no DNS run of its pass, is traced not checked and raises nothing", async () => {
    const { layer, c } = await world();
    const tracer = new MemTracer("t_m365_gate", { model: "none" });
    const runRow = c.run as unknown as Record<string, string>;
    expect(await mailRecordFindings(layer, { run: runRow, gated: true, dns: undefined }, { tracer })).toEqual([]);
    expect(await mailRecordFindings(layer, { run: runRow, gated: false, dns: undefined }, { tracer })).toEqual([]);
    expect(tracer.events.map((e) => e.status)).toEqual(["not_checked", "not_checked"]);
    expect(latestMailRuns([{ tenant_id: "a", surface: M365_SURFACE, run_id: "1" }, { tenant_id: "a", surface: M365_SURFACE, run_id: "2" }, { tenant_id: "b", surface: "cloudflare.dns", run_id: "3" }]).map((x) => x.run_id)).toEqual(["2"]);
  });
});

describe("the pass and the policy's 17th rule", () => {
  it("the pass raises m365_mail_record; the m365.dns rule escalates each one, its reason naming the record and the domain's pseudonym", async () => {
    const { layer } = await world({ policy: true });
    const tracer = new MemTracer("t_m365_pass", { model: "none" });
    const pass = await runPass(layer, { tracer, decidedAt: "2026-10-26T06:30:00.000Z" });
    const mail = pass.findings.filter((f) => f.finding.class === "m365_mail_record");
    expect(mail).toHaveLength(4);
    const rule = loadPolicyFile("policy/hackathon.json", { tenant: TENANT, redactor: r }).rows.find((x) => x.surface === M365_SURFACE)!;
    expect(rule).toMatchObject({ on_drift: "escalate", lock: 0, criticality: "high", psa_priority: "P2", alert: "always" });
    for (const f of mail) {
      expect(f.verb).toBe("ESCALATE");
      expect(f.disposition).toMatchObject({ decided_by: "policy", rule_id: rule.rule_id, expires_at: null });
      expect(f.disposition.reason).toBe(`${f.finding.summary}; rule ${rule.rule_id} (high) sends it to a technician and the agent changes nothing`);
      expect(f.disposition.reason).toContain(mailObject(f.finding.object_id).domain);
      expect(f.checks.map((c) => c.template)).toEqual(["run_complete", "referent_unchanged"]);
    }
    expect(pass.findings.filter((f) => f.finding.class !== "m365_mail_record")).toEqual([]);
  });

  it("the Decider: the m365.dns rule governs every setting of the surface, and its escalation opens with the finding's line", () => {
    const rules = loadPolicyFile("policy/hackathon.json", { tenant: TENANT, redactor: r }).rows;
    const rule = resolvePolicy(rules, { tenant_id: TENANT, surface: M365_SURFACE, object_id: "host-abcdef.com/MX/@", setting_path: "content" })!;
    expect(rule.surface).toBe(M365_SURFACE);
    const d = decide({
      finding: { class: "m365_mail_record", summary: "the MX record of host-abcdef.com is missing from Cloudflare: Microsoft 365 requires MX host-123456.com at host-abcdef.com" },
      rule, exception: { state: "none" }, checks: { verb: "ADOPT", why: "all 2 preconditions hold" }, approved: null, copies: [], probes: { run_id: null, rows: [] }, serves: [], decidedAt: at,
    });
    expect(d).toEqual({
      verb: "ESCALATE", decided_by: "policy", rule_id: rule.rule_id, expires_at: null,
      reason: `the MX record of host-abcdef.com is missing from Cloudflare: Microsoft 365 requires MX host-123456.com at host-abcdef.com; rule ${rule.rule_id} (high) sends it to a technician and the agent changes nothing`,
    });
  });

  it("with Microsoft 365 absent the pass runs and says so in one line; sample mode says it in one line of its own", async () => {
    const empty = await SqlJsEngine.create();
    empty.loadBundle({ collection_run: [run(DNS_RUN, "cloudflare.dns", 0)] });
    const tracer = new MemTracer("t_m365_absent", { model: "none" });
    const pass = await runPass(new DataLayer(empty), { tracer });
    expect(pass.findings).toEqual([]);
    const lines = tracer.events.filter((e) => e.input_summary?.startsWith(M365_SURFACE));
    expect(lines.map((e) => [e.status, e.output_summary])).toEqual([["skipped", `m365.dns: no Microsoft 365 run for ${TENANT}: ${MAIL_ABSENT}`]]);
    expect(MAIL_NOT_RECORDED).toBe("Microsoft 365 is not in the recorded bundle: npm run collect:m365 reads its mail records live");
    const sample = JSON.parse(readFileSync(new URL("../sample/bundle.json", import.meta.url), "utf8")) as { collection_run: { surface: string }[] };
    expect(sample.collection_run.some((x) => x.surface === M365_SURFACE)).toBe(false);
  });
});

// ---- the review's fixes (PR #19): the CNAME value field, the guard on the reason, wildcards, edge cases ----------

describe("the review's edge cases", () => {
  const ctx = { tenantId: TENANT, runId: "run-edge", observedAt: NOW.toISOString() };

  it("a CNAME's value is canonicalName, as Graph sends it; a CNAME carrying nameTarget alone (an SRV field) has no value and says so", () => {
    const rec = { label: "autodiscover.contoso.com", recordType: "CName", supportedService: "Email", nameTarget: "autodiscover.outlook.com" };
    expect(isMailRecord(rec)).toBe(true);
    expect(expectedRecord("contoso.com", rec)).toBe("a CNAME record without its value");
    expect(expectedRecord("contoso.com", { ...rec, canonicalName: "autodiscover.outlook.com" })).toMatchObject({ type: "CNAME", relative: "autodiscover", value: "autodiscover.outlook.com" });
  });

  it("malformed or empty fields: each refused with its reason, names normalised, an empty listing a complete run of 0", async () => {
    const e = (rec: Record<string, unknown>) => expectedRecord("contoso.com", { supportedService: "Email", ...rec } as never);
    expect(e({ recordType: "Mx", mailExchange: "x.example" })).toBe("a MX record without a label");
    expect(e({ recordType: "Mx", label: "", mailExchange: "x.example" })).toBe("a MX record without a label");
    expect(e({ recordType: "Mx", label: "contoso.com", mailExchange: "   " })).toBe("a MX record without its value");
    expect(e({ recordType: "Txt", label: "contoso.com", text: 42 })).toBe("a TXT record without its value");
    expect(e({ recordType: "Txt", label: "contoso.com", text: "v=spf1 -all" })).toBe("an SPF record that names no mechanism");
    expect(e({ recordType: "Srv", label: "contoso.com" })).toBe("a record of a type this surface does not keep");
    expect(e({ recordType: "CNAME", label: "AutoDiscover.Contoso.COM.", canonicalName: "AutoDiscover.Outlook.com." })).toMatchObject({ type: "CNAME", label: "autodiscover.contoso.com", relative: "autodiscover", value: "autodiscover.outlook.com" });
    expect(isMailRecord({ recordType: "Mx", supportedService: "email" })).toBe(false);
    const records = { "contoso.com": [], "fabrikam.com": [], "contoso.onmicrosoft.com": [], "northwind.com": [] };
    const c = await collect(graph({ records, domains: [[{ id: "" }, { id: "contoso.com", isVerified: true }]] as never }).g);
    expect(c.run).toMatchObject({ status: "complete", expected_count: 0, observed_count: 0 });
    expect(c.counts).toMatchObject({ domains: 1, verified: 1, inScope: 1, listed: 0, mail: 0 });
  });

  it("decide() opens an escalation with the finding's line only when the line is redacted text; with none, or a raw one, it says the finding stands", () => {
    const rule = resolvePolicy(loadPolicyFile("policy/hackathon.json", { tenant: TENANT, redactor: r }).rows, { tenant_id: TENANT, surface: M365_SURFACE, object_id: "host-abcdef.com/MX/@", setting_path: "content" })!;
    const reason = (summary?: string) => decide({
      finding: { class: "m365_mail_record", ...(summary === undefined ? {} : { summary }) }, rule, exception: { state: "none" }, checks: { verb: "ESCALATE", why: "x" },
      approved: null, copies: [], probes: { run_id: null, rows: [] }, serves: [], decidedAt: NOW.toISOString(),
    }).reason;
    const tail = `; rule ${rule.rule_id} (high) sends it to a technician and the agent changes nothing`;
    expect(reason()).toBe(`this m365_mail_record finding stands${tail}`);
    expect(reason("the MX record of contoso.com is missing from Cloudflare")).toBe(`this m365_mail_record finding stands (its line is not redacted text and is left out)${tail}`);
    expect(reason("mail for ops@contoso.com bounces at 198.18.0.7")).not.toMatch(/contoso|198\.18/);
    const line = `the MX record of ${r.text("contoso.com")} is missing from Cloudflare: Microsoft 365 requires MX ${r.text("contoso-com.mail.protection.outlook.com")}`;
    expect(redactedLine(line)).toBe(line);
    expect(reason(line)).toBe(`${line}${tail}`);
    expect([redactedLine(undefined), redactedLine(""), redactedLine("host contoso.com")]).toEqual([null, null, null]);
  });

  it("a wildcard under onmicrosoft.com: the star stays, the label takes the pseudonym the bare name takes, once, on either collector's path", () => {
    const bare = r.text("contoso.onmicrosoft.com");
    const star = r.text("*.contoso.onmicrosoft.com");
    expect(star).toBe(`*.${bare}`);
    expect(r.text(star)).toBe(star);
    const sel = r.text("*.selector1-contoso-com._domainkey.contoso.onmicrosoft.com");
    expect(sel.startsWith("*.selector1-tenant-")).toBe(true);
    expect(sel.endsWith(`._domainkey.${bare}`)).toBe(true);
    expect(sel).toMatch(new RegExp(String.raw`^\*\.selector1-tenant-[0-9a-f]{6}\._domainkey\.tenant-[0-9a-f]{6}\.onmicrosoft\.com$`));
    const cf = dnsRecordRow(r, { id: "w", name: "*.contoso.onmicrosoft.com", type: "CNAME", content: "contoso.onmicrosoft.com" }, "contoso.onmicrosoft.com", ctx)!;
    expect([cf.name, cf.content, cf.zone]).toEqual([star, bare, bare]);
  });

  it("an empty served value stays empty on the finding (resolves_to \"\"), never read as absent", async () => {
    const { layer, c } = await world({ zones: ["contoso.com"] });
    (layer.engine as SqlJsEngine).insertRows("dns_record", [{ ...dnsRecordRow(r, { id: "c9", name: "autodiscover.contoso.com", type: "CNAME", content: "x.example" }, "contoso.com", { tenantId: TENANT, runId: DNS_RUN, observedAt: NOW.toISOString() })!, content: "" }]);
    const fs = await mailRecordFindings(layer, { run: c.run as unknown as Record<string, string>, gated: false, dns: { run_id: DNS_RUN, started_at: NOW.toISOString(), tenant_id: TENANT } });
    expect(fs.map((f) => [f.summary.includes("different"), f.resolves_to, f.resource_id])).toEqual([[true, "", "c9"]]);
  });

  it("scrubIds takes the longest value first, so an id inside another leaves no fragment; a credential too short to scrub is refused before any request", async () => {
    expect(scrubIds("tenant abcdefgh-1234 and client efgh", [["efgh", "<client>"], ["abcdefgh-1234", "<tenant>"]])).toBe("tenant <tenant> and client <client>");
    const fake = fakeGraph();
    for (const short of [{ clientSecret: "x".repeat(MIN_CREDENTIAL - 1) }, { clientId: "abc" }, { tenantId: "abc" }]) {
      const g = new Graph({ tenantId: TENANT_ID, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: fake.fetch, loginUrl: LOGIN_URL, graphUrl: GRAPH_URL, ...short });
      await expect(g.listDomains()).rejects.toThrow(/one is shorter, so it looks cut/);
    }
    expect(fake.log).toEqual([]);
  });
});
