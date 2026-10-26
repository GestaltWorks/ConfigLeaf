// The console's read-only JSON API (src/console/api.ts) over sample/bundle.json, client-1, and the README's
// "Programmatic use" section. Each endpoint answers 200 with the shape the README shows and the data the pages show (the
// summary bar's counts, the Findings page's findings in its order, the Settings page's rows in its order, with its
// filters), on the headers of every answer; the tenant rule is the pages' (400 for a tenant the store lacks), an unknown
// path is 404 and a method but GET and HEAD 405, each JSON; every string that comes from a row passes the backend's
// redactor, the filters compare against what is sent, and a read that fails is a 500 with one scrubbed line and no stack.
// The README's snippet is run as written: runPass over the sample bundle in a child process, its printed output the
// block the README shows and its verbs the counts the API's summary gives. Offline; the passes write no trace file.
import { spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SAMPLE_MEMORY_DIR } from "../src/config.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { csp, startConsole, type ConsoleServer } from "../src/console/server.ts";
import { sampleBackend, type Backend } from "../src/console/state.ts";
import { loadSamplePolicy } from "../src/document/sample.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";
import { runPass } from "../src/pipeline.ts";
import type { Redactor } from "../src/redactor.ts";
import { BUNDLE_REDACTOR } from "../src/explain/explain.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SAMPLE = JSON.parse(readFileSync(path.join(ROOT, "sample", "bundle.json"), "utf8")) as Record<string, unknown>;
/** A server test boots a console and runs a sql.js pass over a bundle: 1 to 4 s alone, past vitest's 5 s in the full parallel run. */
const SERVER = { timeout: 30_000 };
/** The boot itself: the bundle loaded into sql.js and the sample's own pass. */
const BOOT_MS = 60_000;
const AT = "2026-10-25T15:00:00.000Z";

/** A clock that starts at `iso` and moves one second each time it is read. */
function ticking(iso: string): () => Date {
  let t = Date.parse(iso);
  return () => new Date((t += 1000));
}

async function boot(before?: (b: Backend) => void): Promise<{ server: ConsoleServer; backend: Backend }> {
  const backend = await sampleBackend({ tenant: "client-1", bundle: SAMPLE, bundlePath: "sample/bundle.json", memoryDir: SAMPLE_MEMORY_DIR, write: false });
  before?.(backend);
  const server = await startConsole({
    backend, port: 0, clock: ticking(AT), firstPass: "sync", tracePasses: false, print: () => undefined,
    traceDirs: [{ label: "examples/traces", dir: path.join(ROOT, "examples", "traces") }],
  });
  return { server, backend };
}

interface Answer { status: number; json: any; text: string; headers: Headers }
/** A request to the API: the status, the body as JSON (null when it is not), as text, and the headers. */
async function api(s: ConsoleServer, p: string, init: RequestInit = {}): Promise<Answer> {
  const r = await fetch(`${s.url}${p}`, init);
  const text = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON: the test says so */ }
  return { status: r.status, json, text, headers: r.headers };
}
const page = async (s: ConsoleServer, p: string): Promise<string> => (await (await fetch(`${s.url}${p}`)).text()).replace(/(?:\?|&amp;)tenant=[A-Za-z0-9._-]+(?=["#])/g, "");
const unescape = (h: string): string => h.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");

/** The Settings rows in page order, each one's key, group, lock and status read off its own <tr> tag in any attribute order. */
const settingRows = (html: string): { key: string; group: string; lock: string; status: string }[] =>
  [...html.matchAll(/<tr\b[^>]*\bdata-open="[^"]+"[^>]*>/g)].map((m) => {
    const attr = (name: string): string => unescape(m[0].match(new RegExp(`\\bdata-${name}="([^"]*)"`))?.[1] ?? "");
    return { key: attr("key"), group: attr("group"), lock: attr("lock"), status: attr("status") };
  });

const ENDPOINTS = ["/api/v1", "/api/v1/summary", "/api/v1/findings", "/api/v1/settings"];

describe("the console's JSON API over sample/bundle.json, client-1", SERVER, () => {
  let server: ConsoleServer;
  beforeAll(async () => { ({ server } = await boot()); }, BOOT_MS);
  afterAll(async () => { await server?.close(); });

  it("every endpoint answers 200 JSON on the headers of every answer: no-store, the CSP, nosniff, no referrer; HEAD the same with no body", async () => {
    for (const p of ENDPOINTS) {
      const r = await api(server, p);
      expect(r.status, p).toBe(200);
      expect(r.json, p).not.toBeNull();
      expect(r.headers.get("content-type"), p).toBe("application/json; charset=utf-8");
      expect([r.headers.get("content-security-policy"), r.headers.get("x-content-type-options"), r.headers.get("referrer-policy"), r.headers.get("cache-control")], p).toEqual([csp(""), "nosniff", "no-referrer", "no-store"]);
      const head = await api(server, p, { method: "HEAD" });
      expect([head.status, head.text, head.headers.get("content-type")], p).toEqual([200, "", "application/json; charset=utf-8"]);
    }
  });

  it("GET /api/v1 indexes the three endpoints and the four JSON-capable actions, one line each, with the tenants the store holds", async () => {
    const { json } = await api(server, "/api/v1");
    expect([json.version, json.read_only, json.tenant, json.tenants]).toEqual(["v1", true, "client-1", ["client-1", "lab-1"]]);
    expect(json.endpoints.map((e: { method: string; path: string }) => `${e.method} ${e.path}`)).toEqual(ENDPOINTS.map((p) => `GET ${p}`));
    expect(json.actions.map((a: { method: string; path: string }) => `${a.method} ${a.path}`)).toEqual(["POST /do/lock", "POST /do/unlock", "POST /do/approve", "POST /do/pass"]);
    for (const e of [...json.endpoints, ...json.actions] as { description: string }[]) expect(e.description).toMatch(/^[^\n]{10,}$/);
    // every action takes the tenant its form was rendered for
    for (const a of json.actions as { form: string[] }[]) expect(a.form).toContain("page_tenant");
    // the trailing slash names the same endpoint
    expect((await api(server, "/api/v1/")).json.name).toBe(json.name);
  });

  it("GET /api/v1/summary gives the counts of the summary bar, the instant of the decisions, the last cycle and the source", async () => {
    const { json } = await api(server, "/api/v1/summary");
    expect([json.tenant, json.source, json.decided_at]).toEqual(["client-1", "sample", "2026-10-25T14:17:53.416Z"]);
    expect(json.counts).toEqual({ findings_open: 27, ESCALATE: 1, FIX: 0, ROLLBACK: 0, HOLD: 3, ADOPT: 23, locked: 79, windows_open: 0, objects: 112 });
    expect(Object.values(json.counts).slice(1, 6).reduce((a: number, b) => a + (b as number), 0)).toBe(json.counts.findings_open);
    expect(json.last_cycle).toEqual({ id: expect.stringMatching(/^cycle_/), at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), trace: expect.stringMatching(/^examples\/traces\/cycle_.+\.jsonl$/) });
    // the console's nav counts the same findings and objects
    const html = await page(server, "/settings");
    expect([...(await page(server, "/findings")).matchAll(/<article class="item" id="f-/g)].length).toBe(json.counts.findings_open);
    expect(settingRows(html)).toHaveLength(json.counts.objects);
    expect(settingRows(html).filter((r) => r.lock === "locked")).toHaveLength(json.counts.locked);
  });

  it("GET /api/v1/findings lists every finding the Findings page lists, in its order, with the verb, class, reason, object, rule and expiry it shows", async () => {
    const { json } = await api(server, "/api/v1/findings");
    const html = await page(server, "/findings");
    const ids = [...html.matchAll(/<article class="item" id="f-([^"]+)">/g)].map((m) => m[1]);
    expect(json.count).toBe(27);
    expect(json.findings.map((f: { id: string }) => f.id)).toEqual(ids);
    json.findings.forEach((f: any) => {
      expect(Object.keys(f), f.id).toEqual(["id", "class", "class_label", "verb", "status", "reason", "object", "rule_id", "expires_at"]);
      expect(f.id, f.id).toMatch(/^fnd-[0-9a-f]{16}$/);
      expect(f.reason, f.id).not.toMatch(/\n/);
      expect(f.status, f.id).toBe({ ESCALATE: "with a technician", FIX: "with a technician", ROLLBACK: "drifted", HOLD: "held", ADOPT: "adopted" }[f.verb as string]);
      // the page shows the class label, where the finding is and its rule, and links the object by the same key
      for (const shown of [f.class_label, f.object.where, ...(f.rule_id ? [f.rule_id] : [])]) expect(unescape(html), `${f.id} ${shown}`).toContain(shown);
      expect(html, f.id).toContain(`/settings?open=${encodeURIComponent(f.object.key)}`);
      // a HOLD has its expiry, an ADOPT under an exception has the exception's, an ESCALATE none
      if (f.verb === "HOLD") expect(f.expires_at, f.id).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      if (f.verb === "ESCALATE") expect(f.expires_at, f.id).toBeNull();
    });
    // the verbs, in the page's sections: a person, then restore, held, adopted
    expect(json.findings.map((f: { verb: string }) => f.verb)).toEqual(["ESCALATE", "HOLD", "HOLD", "HOLD", ...Array(23).fill("ADOPT")]);
    expect(json.findings.find((f: { verb: string }) => f.verb === "ESCALATE")).toMatchObject({ class: "proxy_split", status: "with a technician", rule_id: expect.stringMatching(/^rule-/), expires_at: null });
  });

  it("GET /api/v1/settings lists every object the Settings page lists, in its order, each key the page's own, with its live and approved value, lock, rule and status", async () => {
    const { json } = await api(server, "/api/v1/settings");
    const rows = settingRows(await page(server, "/settings"));
    expect([json.tenant, json.count, json.total, json.windows_error, json.filter]).toEqual(["client-1", 112, 112, null, { group: null, lock: null, status: null, q: null }]);
    expect(json.objects.map((o: { key: string }) => o.key)).toEqual(rows.map((r) => r.key));
    expect(json.objects.map((o: any) => [o.group, o.lock, o.status])).toEqual(rows.map((r) => [r.group, r.lock, r.status]));
    for (const o of json.objects) {
      expect(Object.keys(o), o.id).toEqual(["key", "id", "name", "kind", "surface", "group", "host", "zone", "live", "approved", "differs", "lock", "rule", "window", "status"]);
      expect(o.kind === "file" ? [o.host, o.zone] : [o.host, o.zone === o.group.replace(/^zone /, "")], o.id).toEqual(o.kind === "file" ? [o.group, null] : [null, true]);
      expect(o.live.absent ? o.live.value : o.live.value.length, o.id).toBeTruthy();
      expect(["locked", "open", "window"]).toContain(o.lock);
      expect(o.lock === "locked" ? o.rule?.locked : true, o.id).toBe(true);
    }
    // a file: its live value is the 12 characters of its hash the page shows; a record's is its type, content and proxying
    const file = json.objects.find((o: { kind: string; approved: unknown }) => o.kind === "file" && o.approved);
    expect(file.live.value).toBe(file.live.hash.replace(/^sha256:/, "").slice(0, 12));
    expect(file.approved).toEqual({ hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), at: expect.stringMatching(/^\d{4}-/), by: expect.any(String) });
    expect(json.objects.find((o: { kind: string }) => o.kind === "record").live.value).toMatch(/^(A|AAAA|CNAME|TXT|MX|NS|CAA|SRV)\b/);
    expect(json.objects[0]).toMatchObject({ status: "with a technician", kind: "record", lock: "locked", rule: { id: expect.stringMatching(/^rule-/), template: expect.any(String), criticality: expect.any(String), locked: true }, window: null });
  });

  it("the Settings filters group, lock, status and q narrow the list as the page's do, and an empty one narrows nothing; a lock or a status the page lacks is 400", async () => {
    const all = (await api(server, "/api/v1/settings")).json.objects as { key: string; group: string; lock: string; status: string; id: string; name: string; rule: { id: string } | null }[];
    const rows = settingRows(await page(server, "/settings"));
    const keysOf = async (q: string): Promise<string[]> => (await api(server, `/api/v1/settings?${q}`)).json.objects.map((o: { key: string }) => o.key);
    for (const lock of ["locked", "open", "window"]) expect(await keysOf(`lock=${lock}`), lock).toEqual(rows.filter((r) => r.lock === lock).map((r) => r.key));
    for (const status of ["with a technician", "drifted", "held", "adopted", "in order"]) expect(await keysOf(`status=${encodeURIComponent(status)}`), status).toEqual(rows.filter((r) => r.status === status).map((r) => r.key));
    const group = all.find((o) => o.group.startsWith("zone "))!.group;
    expect(await keysOf(`group=${encodeURIComponent(group)}`)).toEqual(rows.filter((r) => r.group === group).map((r) => r.key));
    expect(await keysOf(`group=${encodeURIComponent(group)}&lock=locked&status=in%20order`)).toEqual(rows.filter((r) => r.group === group && r.lock === "locked" && r.status === "in order").map((r) => r.key));
    // q: a path, a name or a rule's id, in any case, as the page's search box reads them
    const mime = all.find((o) => o.id === "/etc/nginx/mime.types")!;
    expect(await keysOf("q=MIME.types")).toContain(mime.key);
    expect((await keysOf("q=MIME.types")).length).toBeLessThan(all.length);
    expect(await keysOf(`q=${encodeURIComponent(mime.rule!.id)}`)).toEqual(all.filter((o) => o.rule?.id === mime.rule!.id).map((o) => o.key));
    expect(await keysOf("q=catch-all")).toEqual((await keysOf("q=everything%20else")));
    expect(await keysOf("q=no-such-setting-anywhere")).toEqual([]);
    const none = (await api(server, "/api/v1/settings?q=no-such-setting-anywhere")).json;
    expect([none.count, none.total, none.objects]).toEqual([0, 112, []]);
    // an empty parameter is none, and an unknown one is ignored, as on the pages
    expect(await keysOf("lock=&status=&group=&q=&nothing=1")).toEqual(all.map((o) => o.key));
    for (const bad of ["lock=bolted", "status=fine"]) {
      const r = await api(server, `/api/v1/settings?${bad}`);
      expect([r.status, r.json.error, r.json.message]).toEqual([400, "bad_filter", expect.stringContaining(bad.split("=")[0])]);
    }
  });

  it("a tenant is named as on the pages: ?tenant= one the store holds reads that tenant's rows, one it lacks is a 400 JSON on every endpoint", async () => {
    const lab = (await api(server, "/api/v1/summary?tenant=lab-1")).json;
    expect([lab.tenant, lab.counts.findings_open, lab.counts.objects]).toEqual(["lab-1", 0, 5]);
    expect((await api(server, "/api/v1/findings?tenant=lab-1")).json).toMatchObject({ tenant: "lab-1", count: 0, findings: [] });
    expect((await api(server, "/api/v1/settings?tenant=lab-1")).json).toMatchObject({ tenant: "lab-1", count: 5, total: 5 });
    expect((await api(server, "/api/v1?tenant=lab-1")).json.tenant).toBe("lab-1");
    // a request reads the tenant it names; the console's own is unchanged
    expect(server.tenant()).toBe("client-1");
    expect((await api(server, "/api/v1/summary")).json.tenant).toBe("client-1");
    for (const p of ENDPOINTS) for (const t of ["nope", "", "*", "client-1%0Aevil", "lab-1 "]) {
      const r = await api(server, `${p}?tenant=${encodeURIComponent(t)}`);
      expect([r.status, r.json?.status, r.json?.error], `${p} ${JSON.stringify(t)}`).toEqual([400, 400, "unknown_tenant"]);
      expect(r.json.message).toContain("the store holds runs of client-1, lab-1");
      expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(r.headers.get("content-security-policy")).toBe(csp(""));
    }
  });

  it("an unknown path under /api/ is a 404 JSON, the version and the root included; a trailing slash is the same endpoint", async () => {
    for (const p of ["/api", "/api/", "/api/v2/summary", "/api/v1/nope", "/api/v1/summary/extra", "/api/v1/findings.json", "/api/v1/../v2", "/api/%00", "/api/v1/settings/0"]) {
      const r = await api(server, p);
      expect([r.status, r.json?.status, r.json?.error], p).toEqual([404, 404, "not_found"]);
      expect(r.json.message, p).toContain("GET /api/v1 lists them");
      expect(r.text, p).not.toMatch(/\bat \S+ \(|node_modules|\.ts:\d+/);
      expect(r.headers.get("content-type"), p).toBe("application/json; charset=utf-8");
    }
    expect((await api(server, "/api/v1/summary/")).status).toBe(200);
    // a path that merely starts with api is a page, not the API
    expect((await fetch(`${server.url}/apiary`)).headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("any method but GET and HEAD is a 405 JSON that names the two, writes nothing and reads nothing: no action runs, no pass starts", async () => {
    const before = (await api(server, "/api/v1/summary")).text;
    for (const p of ENDPOINTS) for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const r = await api(server, p, { method, ...(method === "POST" || method === "PUT" || method === "PATCH" ? { body: new URLSearchParams({ csrf: server.csrf, confirm: "yes", page_tenant: "client-1" }), headers: { accept: "application/json" } } : {}) });
      expect([r.status, r.json?.status, r.json?.error, r.json?.allow], `${method} ${p}`).toEqual([405, 405, "method_not_allowed", ["GET", "HEAD"]]);
      expect(r.headers.get("content-type"), `${method} ${p}`).toBe("application/json; charset=utf-8");
    }
    // a 405 is answered for an unknown path too, before the path is read, and for an unknown tenant before the tenant is
    expect((await api(server, "/api/v1/nope", { method: "POST" })).status).toBe(405);
    expect((await api(server, "/api/v1/summary?tenant=nope", { method: "POST" })).status).toBe(405);
    expect((await api(server, "/api/v1/summary")).text).toBe(before);
  });

  it("answers on the console's Host rule: another Host is refused with the 421 every page gets, and the API sets no CORS header", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${server.url}/api/v1/summary`, { headers: { host: "rebound.example:80" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(421);
    const r = await fetch(`${server.url}/api/v1/findings`, { headers: { origin: "http://elsewhere.example" } });
    expect(r.status).toBe(200);
    expect([...r.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
  });

  it("the `key` of an object is the key the actions take: Lock names the object of the key it was given", async () => {
    const o = (await api(server, "/api/v1/settings?q=mime.types")).json.objects[0];
    const r = await fetch(`${server.url}/do/lock`, { method: "POST", body: new URLSearchParams({ csrf: server.csrf, confirm: "yes", page_tenant: "client-1", key: o.key }), headers: { accept: "application/json" } });
    const j = await r.json() as { ok: boolean; title: string };
    expect([r.status, j.ok]).toEqual([400, false]);
    expect(j.title).toBe("Lock refused: no change window is open on /etc/nginx/mime.types on " + o.host);
    // and one that names no object is refused as the page's form is
    const bad = await fetch(`${server.url}/do/lock`, { method: "POST", body: new URLSearchParams({ csrf: server.csrf, confirm: "yes", page_tenant: "client-1", key: "bm9wZQ" }), headers: { accept: "application/json" } });
    expect(((await bad.json()) as { title: string }).title).toBe("Lock refused: the object is not in the latest passing runs of this tenant");
  });
});

describe("the API's redaction: every string from a row passes the backend's redactor, the filters compare against what is sent", SERVER, () => {
  let server: ConsoleServer;
  /** The sample's pseudonyms are host-XXXXXX; this redactor turns every one of them into REDACTED-XXXXXX, as a salt that changed would. */
  const swap = (s: string): string => s.replaceAll("host-", "REDACTED-");
  beforeAll(async () => {
    ({ server } = await boot((b) => { b.redactor = Object.assign(Object.create(BUNDLE_REDACTOR) as Redactor, { text: (s: string) => swap(BUNDLE_REDACTOR.text(s)) }); }));
  }, BOOT_MS);
  afterAll(async () => { await server?.close(); });

  /** Every string value of a payload, the `key`s (opaque, the forms' own) left out. */
  const strings = (x: unknown, name = ""): string[] => (typeof x === "string" ? (name === "key" ? [] : [x]) : Array.isArray(x) ? x.flatMap((y) => strings(y, name)) : x && typeof x === "object" ? Object.entries(x).flatMap(([k, y]) => strings(y, k)) : []);

  it("no endpoint sends a string the redactor would change, and the pages' own text is redacted the same way", async () => {
    for (const p of ["/api/v1/summary", "/api/v1/findings", "/api/v1/settings"]) {
      const r = await api(server, p);
      const all = strings(r.json);
      expect(all.length, p).toBeGreaterThan(5);
      expect(all.filter((s) => s.includes("host-")), p).toEqual([]);
      expect(all.every((s) => swap(s) === s), p).toBe(true);
    }
    const f = (await api(server, "/api/v1/findings")).json.findings as { object: { where: string; host: string | null } }[];
    expect(f.some((x) => x.object.where.includes("REDACTED-"))).toBe(true);
    const o = (await api(server, "/api/v1/settings")).json.objects as { name: string; group: string; zone: string | null; host: string | null }[];
    expect(o.some((x) => x.name.startsWith("REDACTED-") && x.group.includes("REDACTED-"))).toBe(true);
    // the page shows the same redacted text for the same object
    expect(await page(server, "/settings")).toContain(`<span class="on">${o.find((x) => x.name.startsWith("REDACTED-"))!.name}</span>`);
    // an error that echoes the request is redacted too
    expect((await api(server, "/api/v1/nope-host-123456")).json.message).toBe("No endpoint /api/v1/nope-REDACTED-123456: GET /api/v1 lists them.");
    expect((await api(server, "/api/v1/summary?tenant=host-123456")).json.message).toContain("No tenant REDACTED-123456");
  });

  it("q and group match the redacted text: the original word finds nothing, so a filter cannot tell what a redaction replaced", async () => {
    expect((await api(server, "/api/v1/settings?q=host-")).json.objects).toEqual([]);
    expect((await api(server, "/api/v1/settings?q=redacted-")).json.count).toBeGreaterThan(50);
    const group = ((await api(server, "/api/v1/settings")).json.objects as { group: string }[]).find((o) => o.group.startsWith("zone "))!.group;
    expect(group).toContain("REDACTED-");
    expect((await api(server, `/api/v1/settings?group=${encodeURIComponent(group)}`)).json.count).toBeGreaterThan(0);
    expect((await api(server, `/api/v1/settings?group=${encodeURIComponent(group.replace("REDACTED-", "host-"))}`)).json.count).toBe(0);
  });
});

describe("the API's failure: a read that fails is a 500 with one line, scrubbed, and no stack", SERVER, () => {
  let server: ConsoleServer;
  const printed: string[] = [];
  beforeAll(async () => {
    const backend = await sampleBackend({ tenant: "client-1", bundle: SAMPLE, bundlePath: "sample/bundle.json", memoryDir: SAMPLE_MEMORY_DIR, write: false });
    server = await startConsole({ backend, port: 0, clock: ticking(AT), firstPass: "sync", tracePasses: false, print: (l) => printed.push(l), traceDirs: [] });
    // the next read of the snapshot fails, with a connection string in the message and a stack behind it
    const run = backend.layer.run.bind(backend.layer);
    backend.layer.run = ((sql: string, params: never, opts: never) => (sql.includes("{{t:collection_run}}") && sql.includes("ORDER BY") && !sql.includes("DISTINCT")
      ? Promise.reject(new Error("connect failed: postgres://app:hunter2@db.internal:5432/drift\n    at Socket.connect (node:net:1:1)\n    at /srv/drift/node_modules/pg/lib/x.ts:9:9"))
      : run(sql, params, opts))) as typeof backend.layer.run;
  }, BOOT_MS);
  afterAll(async () => { await server?.close(); });

  it("answers 500 JSON with the message's first line, the password scrubbed, and the console answers on", async () => {
    const r = await api(server, "/api/v1/findings");
    expect([r.status, r.json?.status, r.json?.error]).toEqual([500, 500, "internal_error"]);
    expect(r.json.message).toBe("connect failed: postgres://app:<redacted>@db.internal:5432/drift");
    expect(r.text).not.toMatch(/hunter2|\bat \S+|node_modules|\.ts:\d+/);
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(printed.some((l) => l.includes("GET /api/v1/findings") && l.includes("<redacted>") && !l.includes("hunter2"))).toBe(true);
    // the index reads nothing, so it still answers; the endpoint that reads says 500 again
    expect((await api(server, "/api/v1")).status).toBe(200);
    expect((await api(server, "/api/v1/summary")).status).toBe(500);
  });
});

describe("the README's Programmatic use section", () => {
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8").replace(/\r\n/g, "\n");
  const section = readme.slice(readme.indexOf("\n## Programmatic use\n"), readme.indexOf("\n## Why it changed\n"));
  const block = (lang: string, n = 0): string => [...section.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g"))][n][1];

  it("is one section that shows runPass over the sample bundle and three curl examples against /api/v1", () => {
    expect(readme.match(/^## Programmatic use$/gm)).toHaveLength(1);
    expect(section).toContain("`runPass(layer, opts)` in `src/pipeline.ts`");
    expect(block("bash")).toMatch(/curl -s http:\/\/127\.0\.0\.1:8090\/api\/v1\/summary/);
    expect(block("bash").match(/^curl /gm)).toHaveLength(3);
    expect(section).toMatch(/hosted\s+demo console serves the same endpoints over the recorded estate/);
    expect(section.match(/```json\n/g)).toHaveLength(3);
  });

  it("the snippet runs as written, `npx tsx pass.ts` from the repository root: it prints the block the README shows, and its verbs are the counts the API's summary gives", { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "readme-snippet-"));
    try {
      // saved as pass.ts in the root, the imports read ./src/...; saved elsewhere, as the same files by their URL
      const file = path.join(dir, "pass.mts");
      // a judge's shell: no SAMPLE_MODE and no memory directory, the snippet names its own
      const { SAMPLE_MODE: _s, DRIFT_MEMORY_DIR: _m, ...env } = process.env;
      writeFileSync(file, block("ts").replaceAll('"./src/', `"${pathToFileURL(path.join(ROOT, "src")).href}/`));
      const run = spawnSync(process.execPath, ["--import", "tsx", file], { cwd: ROOT, encoding: "utf8", timeout: 100_000, env });
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(block("text"));
      expect(run.stdout.split("\n")[0]).toBe("{ ADOPT: 23, HOLD: 3, ESCALATE: 1, ROLLBACK: 0, FIX: 0 }");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the snippet's logic in this process: runPass over the sample bundle decides the findings the console's summary counts and its findings endpoint lists, and each curl output the README shows is the API's own", { timeout: 120_000 }, async () => {
    const bundle = JSON.parse(readFileSync(path.join(ROOT, "sample", "bundle.json"), "utf8")) as Record<string, unknown>;
    const engine = await SqlJsEngine.create();
    try {
      engine.loadBundle(bundle);
      loadSamplePolicy(engine, bundle);
      const memory = new TechnicianMemory({ storage: "read", directory: path.join(ROOT, "examples", "memory") });
      const decidedAt = "2026-10-25T14:17:53.416Z";
      const pass = await runPass(new DataLayer(engine), { memory, decidedAt, at: decidedAt });
      expect(pass.verbs).toEqual({ ADOPT: 23, HOLD: 3, ESCALATE: 1, ROLLBACK: 0, FIX: 0 });
      expect(pass.findings).toHaveLength(27);
      const { server } = await boot();
      try {
        // each curl's output as the README shows it: the API's answer, its first N lines when the command cuts it with head, then "..."
        const curls = [...block("bash").matchAll(/^curl -s '?http:\/\/127\.0\.0\.1:8090(\/api\/v1[^' ]*)'?(?: \| head -n (\d+))?$/gm)];
        expect(curls).toHaveLength(3);
        for (const [i, [, p, n]] of curls.entries()) {
          const text = (await api(server, p)).text;
          const shown = n ? `${text.split("\n").slice(0, Number(n)).join("\n")}\n` : text;
          expect(block("json", i).replace(/\n *\.\.\.\n$/, "\n"), p).toBe(shown);
          expect(block("json", i).endsWith("...\n"), p).toBe(Boolean(n));
        }
        const counts = (await api(server, "/api/v1/summary")).json.counts;
        expect([counts.ADOPT, counts.HOLD, counts.ESCALATE, counts.ROLLBACK, counts.FIX]).toEqual([pass.verbs.ADOPT, pass.verbs.HOLD, pass.verbs.ESCALATE, pass.verbs.ROLLBACK, pass.verbs.FIX]);
        const listed = (await api(server, "/api/v1/findings")).json.findings as { id: string; verb: string; class: string; object: { id: string }; rule_id: string | null }[];
        expect(listed.map((f) => f.id).sort()).toEqual(pass.findings.map((f) => f.id).sort());
        for (const f of pass.findings.filter((x) => x.verb !== "ADOPT")) expect(listed.find((l) => l.id === f.id), f.id).toMatchObject({ verb: f.verb, class: f.finding.class, object: { id: f.finding.object_id }, rule_id: f.disposition.rule_id });
      } finally {
        await server.close();
      }
    } finally {
      engine.close();
    }
  });
});
