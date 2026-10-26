// The technician's console (src/console/) and the change-window step of the Decider (src/policy/decide.ts). The
// server boots in sample mode on an ephemeral port: over sample/bundle.json for client-1 with the committed lessons
// (every page, its CSP and its static parts, the Settings objects and their locks in attention order, Unlock, Lock,
// the CSRF refusals, the tenant's traces only, no external URL; Executive with its period switch, Export PDF and
// Download HTML, the download one standalone file with its style by hash; Templates, every setting under its rule,
// each object a link to its drawer), the tenant switcher over the same bundle (client-1 and lab-1: a switch answers
// 303 and every page and action reads the other tenant; a tenant the store lacks, a bad token and a return path off
// the console refused or sent to the Overview), and over test/fixtures/policy-bundle.json for
// client-a, the loop's fixture world, whose app.conf drifts under the locked conf.d rule with a valid copy (Unlock then
// a pass holds it instead of rolling it back, Lock and a pass roll it back again, Approve, a fake and the real module,
// closes the window; a window that ran out or sits on another host is left alone; a window read that fails refuses
// Unlock and escalates). The pass itself over the fixture: a failing window read escalates every drift a rule would
// roll back or fix, a datasource that lists no change_window reads none. Offline: no host, no Zetaris, no Postgres;
// the passes write no trace file.
import { createHash } from "node:crypto";
import http from "node:http";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueryResult } from "../src/adapters/zetaris.ts";
import { SAMPLE_MEMORY_DIR, config } from "../src/config.ts";
import { ASSETS, CSS, SCRIPT, tenantSwitcher } from "../src/console/html.ts";
import { duplicateText, encodeKey, latestRules, passDq, plainUrls, templatesOf, timesIn, type View } from "../src/console/pages.ts";
import {
  PAGE_PATH, RETURN_PATHS, answerHeaders, contentDisposition, csp, downloadName, fileCsp, nonceReport, returnPathOf, startConsole, type ConsoleServer,
} from "../src/console/server.ts";
import { isTenantId, objectKey, readTenants, sampleBackend, tenantIds, zetarisGaps, type Backend } from "../src/console/state.ts";
import { PERIODS, renderExecutive, type Executive, type ExecutiveContext } from "../src/document/executive.ts";
import { defaultTenant } from "../src/document/sample.ts";
import { BUNDLE_REDACTOR } from "../src/explain/explain.ts";
import { FileTracer, traceIdOf } from "../src/loop/trace.ts";
import { TENANT } from "../src/policy/schema.ts";
import { DataLayer, type Engine } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { objects, priorHolds } from "../src/data/queries.ts";
import { windowId, type ChangeWindow, type Disposition, type PolicyRule } from "../src/data/rows.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { passStep } from "../src/loop/pass.ts";
import { runPass, type Finding } from "../src/pipeline.ts";
import { WINDOW_CLASSES, decide, openWindow, windowOpen, windowReason, windowsUnreadReason, type CopyCandidate, type DecideInput } from "../src/policy/decide.ts";
import { resolvePolicy } from "../src/policy/resolve.ts";
import { MemoryWindows, WINDOW_SURFACES, WindowError, freeText, newWindow } from "../src/policy/window.ts";
import { runLine, type approveRun } from "../src/vault/approve.ts";
import { datasourceLists } from "../src/zetaris/setup.ts";
import { MemTracer } from "./fixtures/mem-tracer.ts";
import { zetarisMeta } from "./fixtures/zetaris-meta.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SAMPLE = JSON.parse(readFileSync(path.join(ROOT, "sample", "bundle.json"), "utf8")) as Record<string, unknown>;
const POLICY = JSON.parse(readFileSync(path.join(ROOT, "test", "fixtures", "policy-bundle.json"), "utf8")) as Record<string, unknown>;
const PAGES: readonly [string, string][] = [
  ["/overview", "<h1>Overview</h1>"], ["/executive", "<h1>client-1 · executive report</h1>"], ["/settings", "<h1>Settings</h1>"], ["/templates", "<h1>Templates</h1>"],
  ["/findings", "<h1>Findings</h1>"], ["/actions", "<h1>Actions and tickets</h1>"], ["/traces", "<h1>Traces</h1>"], ["/sources", "<h1>Sources</h1>"],
  ["/policy", "<h1>Policy</h1>"], ["/document", "<h1>The owner's document</h1>"],
];
/** A server test boots a console and runs a sql.js pass over a bundle: 1 to 4 s alone, past vitest's 5 s in the full parallel run. */
const SERVER = { timeout: 30_000 };
/** The boot itself: the bundle loaded into sql.js and the sample's own pass. */
const BOOT_MS = 60_000;

/** A clock that starts at `iso` and moves one second each time it is read; advance() moves it further. */
function ticking(iso: string): (() => Date) & { advance: (ms: number) => void } {
  let t = Date.parse(iso);
  return Object.assign(() => new Date((t += 1000)), { advance: (ms: number) => { t += ms; } });
}

type Row = Record<string, unknown>;
const rowsOf = (b: Record<string, unknown>, t: string): Row[] => (b[t] ?? []) as Row[];

interface Boot { bundle: Record<string, unknown>; bundlePath: string; tenant: string; at?: string; clock?: () => Date; approve?: typeof approveRun; memoryDir?: string; write?: boolean; before?: (b: Backend) => void; print?: (line: string) => void; renderFile?: typeof renderExecutive }

async function boot(o: Boot): Promise<{ server: ConsoleServer; backend: Backend }> {
  const backend = await sampleBackend({ tenant: o.tenant, bundle: o.bundle, bundlePath: o.bundlePath, memoryDir: o.memoryDir ?? SAMPLE_MEMORY_DIR, write: o.write === true });
  o.before?.(backend);
  const server = await startConsole({
    backend, port: 0, clock: o.clock ?? ticking(o.at!), firstPass: "sync", tracePasses: false, print: o.print ?? (() => undefined), approve: o.approve, renderFile: o.renderFile,
    traceDirs: [{ label: "examples/traces", dir: path.join(ROOT, "examples", "traces") }],
  });
  return { server, backend };
}

const get = async (s: ConsoleServer, p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Headers }> => {
  const r = await fetch(`${s.url}${p}`, { headers });
  return { status: r.status, body: await r.text(), headers: r.headers };
};

const post = async (s: ConsoleServer, action: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<{ status: number; json: { ok: boolean; title: string; lines: string[] } }> => {
  const r = await fetch(`${s.url}/do/${action}`, { method: "POST", body: new URLSearchParams({ csrf: s.csrf, confirm: "yes", ...fields }), headers: { accept: "application/json", ...headers } });
  return { status: r.status, json: await r.json() as { ok: boolean; title: string; lines: string[] } };
};

/** The Settings rows in page order: each one's key, lock, status, tier and text. */
function settingRows(html: string): { key: string; lock: string; status: string; tier: string; text: string }[] {
  return [...html.matchAll(/<tr data-open="[^"]+" data-key="([^"]+)"[^>]*data-lock="([^"]+)" data-status="([^"]+)" data-tier="(\d)"[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => ({ key: Buffer.from(m[1], "base64url").toString("utf8"), lock: m[2], status: m[3], tier: m[4], text: m[5] }));
}

/** The layer's run with the reads whose SQL matches answered by `answer` instead: a failure, or rows of its own. */
function intercept(layer: DataLayer, match: (sql: string) => boolean, answer: () => Promise<QueryResult>): void {
  const run = layer.run.bind(layer);
  layer.run = ((sql, params, opts) => (match(sql) ? answer() : run(sql, params, opts))) as DataLayer["run"];
}
const result = (columns: string[], rows: string[][]): QueryResult => ({ queryId: "q", columns, rows, rowCount: rows.length, total: rows.length, latencyMs: 0, raw: null });
const WINDOWS_READ = (sql: string): boolean => sql.includes("{{t:change_window}}");
/** The console's read of the vault commit of one run's copy (src/console/state.ts vaultCommitOf), and no other vault read. */
const VAULT_COPY_READ = (sql: string): boolean => sql.startsWith("SELECT copy_id, git_commit, taken_at\nFROM {{t:vault_copy}}");

describe("the console over sample/bundle.json, client-1", SERVER, () => {
  let server: ConsoleServer;
  beforeAll(async () => { ({ server } = await boot({ bundle: SAMPLE, bundlePath: "sample/bundle.json", tenant: "client-1", at: "2026-10-25T15:00:00.000Z" })); }, BOOT_MS);
  afterAll(async () => { await server?.close(); });

  it("binds 127.0.0.1 on the port it was given, 0 for an ephemeral one, and redirects / to the Overview", async () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await fetch(`${server.url}/`, { redirect: "manual" });
    expect([r.status, r.headers.get("location")]).toEqual([303, "/overview"]);
    // the redirect carries the fixed headers every answer does
    expect([r.headers.get("content-security-policy"), r.headers.get("x-content-type-options"), r.headers.get("referrer-policy"), r.headers.get("cache-control")]).toEqual([csp(""), "nosniff", "no-referrer", "no-store"]);
  });

  it("every page answers 200 with its heading, the nav and the summary bar; the report renders inside the Overview", async () => {
    for (const [p, h] of PAGES) {
      const r = await get(server, p);
      expect(r.status, p).toBe(200);
      expect(r.body, p).toContain(h);
      expect(r.body, p).toContain('<nav class="side" aria-label="Sections">');
      if (p !== "/overview") expect(r.body, p).toMatch(/<a href="\/findings#needs" class="need"><b>1<\/b> needs you<\/a>/);
    }
    const report = await get(server, "/overview/report");
    expect(report.status).toBe(200);
    expect(report.body).toContain("client-1 · configuration assurance");
    expect(report.body).toMatch(/<b>1<\/b> needs you/);
    expect((await get(server, "/overview")).body).toContain('<iframe class="report" src="/overview/report"');
    const traces = await get(server, "/traces");
    const ref = traces.body.match(/href="\/traces\/view\?f=([^"]+)"/)![1];
    const view = await get(server, `/traces/view?f=${ref}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatch(/<h1>Trace (?:act|cycle)_\w+<\/h1>/);
    expect(view.body).toContain('<select id="agent">');
    expect((await get(server, "/traces/view?f=..%2F..%2Fpackage.json")).status).toBe(404);
    expect((await get(server, "/nowhere")).status).toBe(404);
  });

  it("every answer's CSP holds no 'unsafe-inline': the pages link one stylesheet and one script from /assets/, the report's inline blocks carry the response's nonce", async () => {
    for (const p of [...PAGES.map(([x]) => x), "/nowhere"]) {
      const r = await get(server, p);
      const policy = r.headers.get("content-security-policy") ?? "";
      expect(policy, p).not.toContain("unsafe-inline");
      expect(policy, p).toMatch(/^default-src 'none'; style-src 'self' 'nonce-[A-Za-z0-9+/=]+'; script-src 'self' 'nonce-[A-Za-z0-9+/=]+';/);
      expect(r.headers.get("cache-control"), p).toBe("no-store");
      // no inline style or script and no style attribute: everything the page styles or runs comes from the two paths
      expect(r.body.match(/<style\b|<script(?![^>]*\bsrc=)|\sstyle=|\son[a-z]+=/gi), p).toBeNull();
      if (p !== "/nowhere") {
        expect(r.body, p).toContain(`<link rel="stylesheet" href="${ASSETS.css.path}">`);
        expect(r.body, p).toContain(`<script src="${ASSETS.js.path}"></script>`);
      }
    }
    const a = await get(server, "/overview/report");
    const b = await get(server, "/overview/report");
    const nonce = (a.headers.get("content-security-policy") ?? "").match(/'nonce-([^']+)'/)![1];
    expect(nonce).not.toBe((b.headers.get("content-security-policy") ?? "").match(/'nonce-([^']+)'/)![1]);
    const tags = [...a.body.matchAll(/<(style|script)\b[^>]*>/g)].map((m) => m[0]);
    expect(tags.length).toBeGreaterThanOrEqual(3);
    for (const t of tags) expect(t).toBe(`<${t.startsWith("<style") ? "style" : "script"} nonce="${nonce}">`);
    // only the report's own blocks get the nonce: its head's styles and its last script; any other tag stays without
    const page = "<head><style>a{}</style><noscript><style>b{}</style></noscript></head><body><p><script>other()</script></p><script>own()</script>\n</body>";
    expect(nonceReport(page, "N")).toBe(`<head><style nonce="N">a{}</style><noscript><style nonce="N">b{}</style></noscript></head><body><p><script>other()</script></p><script nonce="N">own()</script>\n<script nonce="N">for(const a of document.querySelectorAll("a[href]"))if(!a.getAttribute("href").startsWith("#"))a.target="_top"</script>\n</body>`);
    expect(nonceReport("<p>no head</p>", "N")).toBe("<p>no head</p>");
  });

  it("the stylesheet and the script are served from paths that name their hash, cached a year and immutable, 304 on their ETag", async () => {
    expect(ASSETS.css.path).toMatch(/^\/assets\/console\.[0-9a-f]{16}\.css$/);
    expect(ASSETS.js.path).toMatch(/^\/assets\/console\.[0-9a-f]{16}\.js$/);
    for (const [asset, body, type] of [[ASSETS.css, CSS, "text/css; charset=utf-8"], [ASSETS.js, SCRIPT, "text/javascript; charset=utf-8"]] as const) {
      const r = await get(server, asset.path);
      expect([r.status, r.headers.get("content-type"), r.headers.get("cache-control"), r.headers.get("etag")]).toEqual([200, type, "public, max-age=31536000, immutable", asset.etag]);
      expect(r.body).toBe(body);
      // the assets' headers come from answerHeaders too: the CSP and the two security headers on the asset and its 304
      expect([r.headers.get("content-security-policy"), r.headers.get("x-content-type-options"), r.headers.get("referrer-policy")]).toEqual([csp(""), "nosniff", "no-referrer"]);
      const again = await get(server, asset.path, { "if-none-match": asset.etag });
      expect([again.status, again.headers.get("x-content-type-options"), again.headers.get("etag")]).toEqual([304, "nosniff", asset.etag]);
    }
    expect((await get(server, "/assets/console.0000000000000000.css")).status).toBe(404);
  });

  it("Settings lists every file of each host's latest run and every record of the latest DNS run, each lock from the policy rule that governs it", async () => {
    const runs = rowsOf(SAMPLE, "collection_run").filter((r) => r.tenant_id === "client-1");
    const latest = (surface: string, host: unknown): Row => runs.filter((r) => r.surface === surface && r.host === host && r.status === "complete").sort((a, b) => String(a.started_at) < String(b.started_at) ? -1 : 1).at(-1)!;
    const obs = rowsOf(SAMPLE, "observation");
    const hosts = [...new Set(runs.filter((r) => r.surface === "linux.nginx").map((r) => r.host))];
    const files = hosts.flatMap((h) => obs.filter((o) => o.run_id === latest("linux.nginx", h).run_id && o.setting_path === "file").map((o) => objectKey("linux.nginx", String(h), String(o.object_id))));
    const dns = latest("cloudflare.dns", null);
    const records = [...new Set(obs.filter((o) => o.run_id === dns.run_id).map((o) => objectKey("cloudflare.dns", null, String(o.object_id))))];
    const rows = settingRows((await get(server, "/settings")).body);
    expect(rows.map((r) => r.key).sort()).toEqual([...files, ...records].sort());
    expect([files.length, records.length]).toEqual([54, 58]);
    const rules = rowsOf(SAMPLE, "policy_rule") as unknown as PolicyRule[];
    for (const r of rows) {
      const [surface, , object] = r.key.split("\u001f");
      const rule = resolvePolicy(rules, { tenant_id: "client-1", surface, object_id: object, setting_path: surface === "cloudflare.dns" ? "content" : "file" });
      expect(r.lock, r.key).toBe(rule?.lock === 1 ? "locked" : "open");
      expect(r.text, r.key).toContain(rule?.lock === 1 ? ">locked by rule<" : rule ? ">open by rule<" : ">open, no rule<");
    }
    const nginxConf = rows.filter((r) => r.key.endsWith("\u001f/etc/nginx/nginx.conf"));
    expect(nginxConf.map((r) => r.lock)).toEqual(["locked", "locked"]);
    expect(rows.filter((r) => r.lock === "locked").length).toBe(79);
    expect(rows.filter((r) => r.lock === "window")).toEqual([]);
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(["in order", "adopted", "held", "with a technician"]));
  });

  it("Settings: one line an object, its name and its host or zone, the full path in the drawer; attention first: with a technician, drifted, held, an open window, then the rest", async () => {
    const html = (await get(server, "/settings")).body;
    const rows = settingRows(html);
    const rank = (r: { status: string; lock: string }): number => Math.min(...[["with a technician", "drifted", "held"].indexOf(r.status)].filter((i) => i >= 0), r.lock === "window" ? 3 : 4);
    const ranks = rows.map(rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(rows[0].status).toBe("with a technician");
    expect(rows.filter((r) => r.tier === "0").map((r) => r.status).every((s) => ["with a technician", "drifted", "held"].includes(s))).toBe(true);
    expect(html.match(/<tr class="grp" data-tier="\d"><td colspan="7">[^<]+<\/td><\/tr>/g)).toEqual([
      `<tr class="grp" data-tier="0"><td colspan="7">Needs attention: with a technician, drifted, held or in an open window · ${rows.filter((r) => r.tier === "0").length} objects</td></tr>`,
      `<tr class="grp" data-tier="1"><td colspan="7">Everything else · ${rows.filter((r) => r.tier === "1").length} objects</td></tr>`,
    ]);
    // no second line in any cell: the date, the criticality and the path live in the drawer and the titles
    for (const r of rows) expect(r.text, r.key).not.toMatch(/class="q"|class="p"/);
    const conf = rows.find((r) => r.key.endsWith("\u001f/etc/nginx/nginx.conf"))!;
    const host = conf.key.split("\u001f")[1];
    expect(conf.text).toContain(`<span class="on">nginx/nginx.conf</span> <span class="oh">${host}</span>`);
    expect(conf.text).toContain(`title="/etc/nginx/nginx.conf on ${host}"`);
    expect(html).toContain('<h2 id="dr-title">/etc/nginx/nginx.conf</h2>');
    // one line between 6 px paddings and a 1 px rule, no wrapping: Chromium measures 36 px a row
    expect(CSS).toContain("table.set td{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:21px;vertical-align:middle;padding-top:6px;padding-bottom:6px}");
  });

  it("the summary bar shows 0 windows open in the muted colour, 1 window open in the window's", async () => {
    expect((await get(server, "/findings")).body).toContain('<a href="/settings?lock=window" class="zero"><b>0</b> windows open</a>');
    expect(CSS).toContain(".sum .zero{color:var(--muted)}");
  });

  it("Unlock writes a change window and the row reads open until its end; Lock closes it and the row reads locked again", async () => {
    const before = settingRows((await get(server, "/settings")).body).find((r) => r.key.endsWith("\u001f/etc/nginx/nginx.conf"))!;
    const u = await post(server, "unlock", { key: encodeKey(before.key), who: "tech-a", hours: "2", why: "a planned upstream change" });
    expect(u.status).toBe(200);
    expect(u.json.ok).toBe(true);
    expect(u.json.title).toMatch(/^Change window open on \/etc\/nginx\/nginx\.conf until 25 Oct 2026 17:00 UTC$/);
    expect(u.json.lines[0]).toMatch(/^change_window win-[0-9a-f]{16}: 1 row written$/);
    expect(u.json.lines).toContain("sample mode: changes live for this process");
    const open = settingRows((await get(server, "/settings")).body).find((r) => r.key === before.key)!;
    expect([open.lock, open.tier]).toEqual(["window", "0"]);
    expect(open.text).toContain(">open until 25 Oct 17:00 UTC<");
    expect(open.text).toContain("open until 25 Oct 2026 17:00 UTC\">");
    expect((await get(server, "/settings")).body).toMatch(/<a href="\/settings\?lock=window" class="window"><b>1<\/b> window open<\/a>/);
    // a second Unlock on the same object is refused while the window is open
    const again = await post(server, "unlock", { key: encodeKey(before.key), who: "tech-a", hours: "2", why: "again" });
    expect([again.status, again.json.ok]).toEqual([400, false]);
    expect(again.json.title).toMatch(/^Unlock refused: a change window is open on \/etc\/nginx\/nginx\.conf on host-\w+ until /);
    // out of range
    const other = settingRows((await get(server, "/settings")).body).find((r) => r.key.endsWith("\u001f/etc/nginx/mime.types"))!;
    expect((await post(server, "unlock", { key: encodeKey(other.key), who: "tech-a", hours: "73", why: "too long" })).json.title).toBe("Unlock refused: until: a whole number of hours from 1 to 72");
    const l = await post(server, "lock", { key: encodeKey(before.key) });
    expect(l.json.ok).toBe(true);
    expect(l.json.lines[0]).toMatch(/^change_window win-[0-9a-f]{16} closed at 2026-10-25T15:00:\d\d\.000Z \(1 row\); nothing approved$/);
    const locked = settingRows((await get(server, "/settings")).body).find((r) => r.key === before.key)!;
    expect([locked.lock, locked.text.includes(">locked by rule<")]).toEqual(["locked", true]);
    expect((await post(server, "lock", { key: encodeKey(before.key) })).json.title).toMatch(/^Lock refused: no change window is open on /);
  });

  it("Unlock refuses a who or why too long or with a control character, and the page escapes what it stores", async () => {
    const rows = settingRows((await get(server, "/settings")).body);
    const key = encodeKey(rows.find((r) => r.key.endsWith("\u001f/etc/nginx/mime.types"))!.key);
    const refused = async (who: string, why: string): Promise<string> => {
      const r = await post(server, "unlock", { key, who, why, hours: "1" });
      expect([r.status, r.json.ok]).toEqual([400, false]);
      return r.json.title;
    };
    expect(await refused("x".repeat(201), "why")).toBe("Unlock refused: who: 1 to 200 characters, the person or role opening the window");
    expect(await refused("tech-a", "y".repeat(501))).toBe("Unlock refused: why: 1 to 500 characters, the change the window is for");
    expect(await refused("tech-a", "line one\nline two")).toBe("Unlock refused: why: one line of text with no control character, the change the window is for");
    expect(await refused("tech\u001b[31m-a", "why")).toBe("Unlock refused: who: one line of text with no control character, the person or role opening the window");
    expect(await refused("tech-a\u0000", "why")).toMatch(/^Unlock refused: who: one line of text with no control character/);
    const ok = await post(server, "unlock", { key, who: `<b>tech</b> & "a"`, why: "<script>alert(1)</script>", hours: "1" });
    expect(ok.json.ok).toBe(true);
    const html = (await get(server, "/settings")).body;
    expect(html).toContain("&lt;b&gt;tech&lt;/b&gt; &amp; &quot;a&quot;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect((await post(server, "lock", { key })).json.ok).toBe(true);
  });

  it("refuses a POST without the form's token, from another origin, cross-site or to another Host, and an action without its confirmation", async () => {
    const r = await fetch(`${server.url}/do/pass`, { method: "POST", body: new URLSearchParams({ csrf: "nope" }), headers: { accept: "application/json" } });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { title: string }).title).toBe("Refused: the form's token does not match this console");
    expect((await post(server, "pass", {}, { origin: "http://elsewhere.example" })).status).toBe(403);
    expect((await post(server, "pass", {}, { "sec-fetch-site": "cross-site" })).json.title).toBe("Refused: the request comes from another site");
    const noConfirm = await fetch(`${server.url}/do/lock`, { method: "POST", body: new URLSearchParams({ csrf: server.csrf, key: "x" }), headers: { accept: "application/json" } });
    expect(((await noConfirm.json()) as { title: string }).title).toBe("Confirm on the page first: the action carries its confirmation");
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${server.url}/overview`, { headers: { host: "rebound.example:80" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it("Record exception says the store is read-only in sample mode without --write", async () => {
    const findings = (await get(server, "/findings")).body;
    const id = findings.match(/name="finding" value="(fnd-[0-9a-f]{16})"/)![1];
    const r = await post(server, "exception", { finding: id, until: "2026-11-30", reason: "known", by: "technician" });
    expect(r.json.ok).toBe(false);
    expect(r.json.title).toMatch(/^Exception refused: the store is read-only in sample mode \(examples\/memory\); start the console with --write to record into it$/);
  });

  it("Findings: every reason shows its instants as the page formats a time, none in the ISO form", async () => {
    const findings = (await get(server, "/findings")).body;
    const why = [...findings.matchAll(/<p class="why">([^<]*)<\/p>/g)].map((m) => m[1]);
    expect(why.length).toBeGreaterThan(0);
    for (const w of why) expect(w).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(why.some((w) => /\b\d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2} UTC\b/.test(w))).toBe(true);
    expect(timesIn("hold until 2026-10-23T07:00:03.000Z; since 2026-10-22T07:00Z")).toBe("hold until 23 Oct 2026 07:00 UTC; since 22 Oct 2026 07:00 UTC");
  });

  it("Traces lists the tenant's traces only, those whose cycle, pass or receipts name it; another tenant's is not found; a ticket URL reads as its number", async () => {
    const list = (await get(server, "/traces")).body;
    const ids = [...list.matchAll(/href="\/traces\/view\?f=examples%2Ftraces%2F([\w.]+)\.jsonl"/g)].map((m) => m[1]);
    expect(ids.sort()).toEqual(["cycle_mvo2bil0", "cycle_mvo5600q"]);
    expect((await get(server, "/traces/view?f=examples%2Ftraces%2Fcycle_mvoa0l1i.jsonl")).status).toBe(404);
    expect((await get(server, "/traces/view?f=examples%2Ftraces%2Fact_mvnn2tja.jsonl")).status).toBe(404);
    const raw = readFileSync(path.join(ROOT, "examples", "traces", "cycle_mvo2bil0.jsonl"), "utf8");
    const ticket = raw.match(/https?:\/\/[^\s"]+\/issues\/(\d+)/)!;
    const view = (await get(server, "/traces/view?f=examples%2Ftraces%2Fcycle_mvo2bil0.jsonl")).body;
    expect(view).not.toContain(ticket[0]);
    expect(view).toContain(`#${ticket[1]}`);
    expect(plainUrls("issue https://host-28ea31.com/word-861e90/drift-tickets/issues/7 opened; see https://host-1a2b3c.com/x and https://example.org/docs"))
      .toBe("issue #7 opened; see (a pseudonymised URL) and https://example.org/docs");
  });

  it("the nav names Executive and Templates beside the other pages, Executive right after the Overview", async () => {
    const html = (await get(server, "/templates")).body;
    const nav = [...html.matchAll(/<li><a href="(\/[a-z]+)"(?: aria-current="page")?>([^<]+)/g)].map((m) => [m[1], m[2]]);
    expect(nav).toEqual([["/overview", "Overview"], ["/executive", "Executive"], ["/settings", "Settings"], ["/templates", "Templates"], ["/findings", "Findings"], ["/actions", "Actions and tickets"], ["/traces", "Traces"], ["/sources", "Sources"]]);
    expect(html).toContain('<li><a href="/templates" aria-current="page">Templates');
  });

  it("Executive: the period switch, Export PDF (shown by the script, which prints) and Download HTML over the report's sections, the tenant, the period and the time UTC in its header", async () => {
    const html = (await get(server, "/executive?period=30d")).body;
    expect(html).toContain('<nav class="seg" aria-label="Period"><a href="/executive?period=7d">7 days</a><a href="/executive?period=30d" aria-current="page">30 days</a><a href="/executive?period=all">All</a></nav>');
    expect(html).toContain('<button type="button" class="btn" data-print hidden>Export PDF</button><a class="btn" href="/executive/download?period=30d" download>Download HTML</a>');
    expect(SCRIPT).toContain("window.print()");
    expect(html).toMatch(/<p class="ex-when"><span>the last 30 days<\/span> <span>26 Sep 2026 to 25 Oct 2026 15:0\d UTC<\/span><\/p>/);
    expect([...html.matchAll(/<div class="tile"><span class="k">([^<]+)<\/span>/g)].map((m) => m[1])).toEqual(["Settings watched", "Coverage", "Copies with a valid restore", "Drift events", "Change to detection", "Actions", "Receipts verified"]);
    expect([...html.matchAll(/<figure class="ex-chart" id="([a-z-]+)">/g)].map((m) => m[1])).toEqual(["ex-findings", "ex-actions", "ex-probes", "ex-approvals"]);
    // the incident links its entry on Findings: the proxy_split ESCALATE, ticket #2
    expect(html).toMatch(/<a href="\/findings#f-fnd-b4a40091cdb4f906" class="mono">fnd-b4a40091cdb4f906<\/a>/);
    // a period the switch does not name reads as the last 7 days
    expect((await get(server, "/executive?period=1y")).body).toContain('<a href="/executive?period=7d" aria-current="page">7 days</a>');
    // print: the shell left out, the light tokens, A4 with a page break between sections
    expect(CSS).toContain(".side,.bar,.skip,.toasts,.drawer,.scrim,.ex-tools{display:none!important}");
    expect(CSS).toContain("@page{size:A4;margin:14mm 12mm}");
    expect(CSS).toContain(".ex-sec{break-before:page}");
  });

  it("Download HTML is the executive report as one file: an attachment named for the tenant and the period, its one style block by hash in the CSP, no script, nothing from outside", async () => {
    const r = await get(server, "/executive/download?period=all");
    expect(r.status).toBe(200);
    // filename for every client and the RFC 5987 filename* beside it
    expect(r.headers.get("content-disposition")).toBe(`attachment; filename="executive-client-1-all.html"; filename*=UTF-8''executive-client-1-all.html`);
    const style = /<style>([\s\S]*?)<\/style>/.exec(r.body)![1];
    expect(r.headers.get("content-security-policy")).toBe(`default-src 'none'; style-src 'sha256-${createHash("sha256").update(style).digest("base64")}'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`);
    expect(fileCsp(r.body)).toBe(r.headers.get("content-security-policy"));
    // the fixed headers stand on the download too: no route's own headers set or replace them
    expect([r.headers.get("x-content-type-options"), r.headers.get("referrer-policy"), r.headers.get("cache-control"), r.headers.get("content-type")]).toEqual(["nosniff", "no-referrer", "no-store", "text/html; charset=utf-8"]);
    // a HEAD carries the same CSP, read off the file it would send
    const head = await fetch(`${server.url}/executive/download?period=all`, { method: "HEAD" });
    expect(head.headers.get("content-security-policy")).toBe(r.headers.get("content-security-policy"));
    expect(r.body.match(/<script|<link\b|<img\b|<iframe\b|@import|url\(\s*["']?https?:/gi)).toBeNull();
    expect(r.body.split("<style>").length - 1).toBe(1);
    expect(r.body).toContain("<h1>client-1 · executive report</h1>");
    expect(r.body).toContain("<span>every day on record</span>");
  });

  it("Sources names dns_inventory_current beside exception_in_force under the DQ results, each as the console's last pass read it", async () => {
    const html = (await get(server, "/sources")).body;
    const dq = /<h2>DQ results<\/h2>\n<ul>([\s\S]*?)<\/ul>\n<p class="muted">/.exec(html)![1];
    expect([...dq.matchAll(/<li><b>([a-z_ ]+)<\/b>/g)].map((m) => m[1])).toEqual(["run_complete", "copy validation", "exception_in_force", "dns_inventory_current"]);
    expect(dq).toContain(`<li><b>dns_inventory_current</b> on <code>drift_usl.dns_live</code>, read by the console's last pass: <span class="muted">not read: the pass reads it on Zetaris, and sample mode reads sql.js</span>.</li>`);
  });

  it("Templates: every setting of the latest passing runs under the rule that governs it, the deviations the objects with findings open under the rule, each object a link to its Settings drawer", async () => {
    const html = (await get(server, "/templates")).body;
    const cards = [...html.matchAll(/<details class="card tpl" id="tpl-([^"]+)"[^>]*>\n<summary><span class="tpl-name">([^<]+)<\/span> <span class="b (?:locked|open)">[^<]+<\/span> <span class="tpl-n">([\d,]+) settings? in (\d+) objects? · <span[^>]*>(\d+) deviations?<\/span><\/span><\/summary>([\s\S]*?)<\/details>/g)]
      .map((m) => ({ id: m[1], name: m[2], settings: Number(m[3].replace(/,/g, "")), objects: Number(m[4]), deviations: Number(m[5]), body: m[6] }));
    // the rules in force, the 17 of version 2 of policy/hackathon.json (the sample loads the shipped file before its passes), each once: the settings no rule governs would be a card of their own
    expect(cards).toHaveLength(17);
    expect(cards.reduce((n, c) => n + c.settings, 0)).toBe(1352);
    // zetaris.control and m365.dns, the rules main added since the recording, govern no setting of the sample's runs: their cards say so
    expect(cards.find((c) => c.name === "every m365.dns setting")).toMatchObject({ settings: 0, objects: 0, deviations: 0 });
    expect(cards.find((c) => c.id === "rule-8bcb3a03ffcee62e")).toMatchObject({ name: "every zetaris.control setting", settings: 0, objects: 0, deviations: 0 });
    expect(html).not.toContain('class="alert" role="alert"');
    expect(cards[0]).toMatchObject({ name: "everything else (catch-all)", deviations: 3 });
    const proxied = cards.find((c) => c.name === "* · proxied")!;
    expect(proxied).toMatchObject({ id: "rule-8e75e1d767980665", settings: 58, objects: 58, deviations: 1 });
    expect(proxied.body).toContain('<span class="b locked">locked by rule</span>');
    // every row's object opens its drawer on Settings
    const settings = settingRows((await get(server, "/settings")).body).map((r) => r.key);
    const links = [...html.matchAll(/<a href="\/settings\?open=([^"]+)">/g)].map((m) => Buffer.from(decodeURIComponent(m[1]), "base64url").toString("utf8"));
    expect(links.length).toBeGreaterThan(112);
    for (const k of links) expect(settings, k).toContain(k);
    const open = (await get(server, `/settings?open=${encodeURIComponent(encodeKey(settings[0]))}`)).body;
    expect(open).toContain(`<body data-open="${encodeKey(settings[0])}">`);
  });

  it("no page names an external URL: no script, style, font, frame or form outside the console, and no absolute URL in the page text", async () => {
    for (const p of [...PAGES.map(([x]) => x), "/overview/report", "/traces/view?f=examples%2Ftraces%2Fcycle_mvo2bil0.jsonl"]) {
      const body = (await get(server, p)).body;
      expect(body.match(/(?:src|href|action)\s*=\s*["']?(?:https?:)?\/\//gi), p).toBeNull();
      // the one stylesheet and the one script a page links are the console's own, from /assets/
      expect([...body.matchAll(/<link\b[^>]*>|<script\s+src="[^"]*"/gi)].map((m) => m[0]).filter((t) => !t.includes('"/assets/console.')), p).toEqual([]);
      expect(body.match(/@import|url\(\s*["']?https?:/gi), p).toBeNull();
      expect(body.match(/https?:\/\/[^\s"'<]+/g), p).toBeNull();
    }
  });
});

describe("the tenant switcher over sample/bundle.json: client-1 and lab-1", SERVER, () => {
  let server: ConsoleServer;
  let backend: Backend;
  beforeAll(async () => { ({ server, backend } = await boot({ bundle: SAMPLE, bundlePath: "sample/bundle.json", tenant: "client-1", at: "2026-10-25T15:00:00.000Z" })); }, BOOT_MS);
  afterAll(async () => { await server?.close(); });
  const tenantPost = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${server.url}/do/tenant`, { method: "POST", redirect: "manual", body: new URLSearchParams({ csrf: server.csrf, ...fields }), headers });

  it("lists tenant ids only, once each and sorted: never \"*\", nothing a header or a file name could not carry", () => {
    expect(tenantIds(["lab-1", "client-1", "lab-1", "*", "bad\"id", "two words", "x\r\ny", "", "a".repeat(65)])).toEqual(["client-1", "lab-1"]);
  });

  it("lists the bundle's tenants on every page; a switch answers 303 to the page it came from, and every page reads lab-1 from then on, its first pass run at the sample's instant", async () => {
    expect(backend.tenants).toEqual(["client-1", "lab-1"]);
    for (const [p] of PAGES) expect((await get(server, p)).body, p).toContain('<select id="tenant-pick" name="tenant" data-autosubmit><option value="client-1" selected>client-1</option><option value="lab-1">lab-1</option></select>');
    expect((await get(server, "/executive?period=all")).body).toContain('<input type="hidden" name="return" value="/executive?period=all">');
    const r = await tenantPost({ tenant: "lab-1", return: "/executive?period=all" });
    expect([r.status, r.headers.get("location")]).toEqual([303, "/executive?period=all"]);
    expect(server.tenant()).toBe("lab-1");
    for (const [p] of PAGES) expect((await get(server, p)).body, p).toContain('<option value="lab-1" selected>lab-1</option>');
    expect((await get(server, "/settings")).body).toContain("Every object the estate holds for lab-1: 5 files on 1 host and 0 records in 0 zones");
    expect((await get(server, "/overview/report")).body).toContain("lab-1 · configuration assurance");
    const ex = (await get(server, "/executive")).body;
    expect(ex).toContain("<h1>lab-1 · executive report</h1>");
    expect(ex).toContain('<h2>Incidents of the period<span class="cnt">2</span></h2>');
    expect(ex).toMatch(/#3 <span class="muted">incident, P1, open<\/span>/);
    expect(ex).toMatch(/#4 <span class="muted">change, P1, closed<\/span>/);
    expect((await server.settled())!.decidedAt).toBe("2026-10-25T14:17:53.416Z");
    expect((await get(server, "/traces")).body).toContain("cycle_mvoa0l1i");
  });

  it("an action after the switch is the new tenant's: Unlock on lab-1 writes a change_window row of lab-1", async () => {
    const row = settingRows((await get(server, "/settings")).body).find((x) => x.key.endsWith("\u001f/etc/nginx/sites-available/lab.example"))!;
    const u = await post(server, "unlock", { key: encodeKey(row.key), who: "tech-l", hours: "1", why: "the lab's change" });
    expect(u.json.ok).toBe(true);
    const rows = objects(await backend.layer.run("SELECT tenant_id, host FROM {{t:change_window}} WHERE object_id = {{p:o}}", { o: "/etc/nginx/sites-available/lab.example" }));
    expect(rows).toEqual([{ tenant_id: "lab-1", host: "host-951abf" }]);
    expect((await post(server, "lock", { key: encodeKey(row.key) })).json.ok).toBe(true);
  });

  it("refuses a tenant the store holds no run of and a form without the console's token; a return path off the console's pages goes to the Overview", async () => {
    const nope = await tenantPost({ tenant: "nope" }, { accept: "application/json" });
    expect(nope.status).toBe(400);
    expect(((await nope.json()) as { title: string }).title).toBe("Tenant refused: the store holds no run of tenant nope; the switcher lists client-1, lab-1");
    const bad = await fetch(`${server.url}/do/tenant`, { method: "POST", body: new URLSearchParams({ csrf: "x", tenant: "client-1" }), headers: { accept: "application/json" } });
    expect(bad.status).toBe(403);
    expect(server.tenant()).toBe("lab-1");
    for (const back of ["https://elsewhere.example/", "//elsewhere.example", "/traces/view?f=..%2F..%2Fpackage.json", "/executive?period=1y"]) {
      const r = await tenantPost({ tenant: "lab-1", return: back });
      expect([r.status, r.headers.get("location")], back).toEqual([303, "/overview"]);
    }
  });

  it("switching back reads client-1 again with the pass it had", async () => {
    const r = await tenantPost({ tenant: "client-1", return: "/findings" }, { accept: "application/json" });
    expect(((await r.json()) as { ok: boolean; title: string })).toMatchObject({ ok: true, title: "Switched to client-1" });
    expect(server.tenant()).toBe("client-1");
    const findings = (await get(server, "/findings")).body;
    expect(findings).toMatch(/<a href="\/findings#needs" class="need"><b>1<\/b> needs you<\/a>/);
    expect(findings).toContain('<option value="client-1" selected>client-1</option>');
  });
});

describe("the download's name, an answer's headers, the switch's return paths and the tenant ids", () => {
  it("names the file for a tenant id only, with filename and an RFC 5987 filename*: a tenant with a quote and CRLF names no file and no header", () => {
    expect(downloadName("client-1", "7d")).toBe("executive-client-1-7d.html");
    expect(contentDisposition(downloadName("lab-1", "all"))).toBe(`attachment; filename="executive-lab-1-all.html"; filename*=UTF-8''executive-lab-1-all.html`);
    const evil = 'client-1"\r\nSet-Cookie: x=1';
    expect(() => downloadName(evil, "7d")).toThrow('No download: the tenant "client-1\\"\\r\\nSet-Cookie: x=1" is not a tenant id');
    for (const t of ["*", "", "a b", "x\ny", "-lead", "a".repeat(65)]) expect(() => downloadName(t, "all"), JSON.stringify(t)).toThrow(/is not a tenant id/);
    // the header builder takes only a name downloadName gives
    for (const n of ['a"b.html', "a\r\nb.html", "a b.html", "ü.html"]) expect(() => contentDisposition(n), JSON.stringify(n)).toThrow(/downloadName/);
  });

  it("the tenant pattern is anchored at both ends, with no multiline flag: a newline, a quote or a space before or after an id refuses it", () => {
    expect(TENANT.source.startsWith("^")).toBe(true);
    expect(TENANT.source.endsWith("$")).toBe(true);
    expect(TENANT.flags).not.toMatch(/[mgy]/);
    for (const ok of ["client-1", "lab-1", "a", "A.b_c-9", "a".repeat(64)]) expect(isTenantId(ok), ok).toBe(true);
    for (const bad of ["client-1\n", "\nclient-1", "x client-1", "client-1 x", 'client-1"', "client-1\r\nX: 1", "*", "a".repeat(65), "-x", ".x", 7, null]) expect(isTenantId(bad), JSON.stringify(bad)).toBe(false);
  });

  it("a route sets its content type and content-disposition only: any other header is refused, and the fixed ones are always the server's", () => {
    expect(answerHeaders("text/html; charset=utf-8", "default-src 'none'", { "content-disposition": "attachment" })).toEqual({
      "content-disposition": "attachment", "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    });
    for (const k of ["content-security-policy", "x-content-type-options", "referrer-policy", "cache-control", "Content-Type", "set-cookie", "location"]) {
      expect(() => answerHeaders("text/plain", "p", { [k]: "x" }), k).toThrow(`a route sets its content type and content-disposition only, not ${k}`);
    }
  });

  it("fileCsp hashes the file's one style block, and throws on a file with none, two, or one left open", () => {
    const one = "<style>a{}</style><p></p>";
    expect(fileCsp(one)).toBe(`default-src 'none'; style-src 'sha256-${createHash("sha256").update("a{}").digest("base64")}'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`);
    expect(() => fileCsp("<p>no style</p>")).toThrow("fileCsp: the executive report holds one style block, this file opens 0 and closes 0");
    expect(() => fileCsp("<style>a{}</style><p></p><style>b{}</style>")).toThrow("this file opens 2 and closes 2");
    expect(() => fileCsp('<style>a{}</style><style media="print">b{}</style>')).toThrow("this file opens 2 and closes 1");
    expect(() => fileCsp("<style>a{}")).toThrow("this file opens 1 and closes 0");
  });

  it("the switch's return paths are read off PAGE_PATH and the periods: every page of the nav and the executive report's three, nothing else", () => {
    expect([...RETURN_PATHS]).toEqual([...Object.values(PAGE_PATH), ...PERIODS.map((p) => `/executive?period=${p}`)]);
    expect(Object.keys(PAGE_PATH).sort()).toEqual(["actions", "document", "executive", "findings", "overview", "policy", "settings", "sources", "templates", "traces"]);
    for (const p of RETURN_PATHS) expect(returnPathOf(p)).toBe(p);
    for (const p of [null, "", "/executive?period=1y", "//elsewhere.example", "/overview/", "/traces/view?f=x", "https://elsewhere.example/", "/Overview"]) expect(returnPathOf(p), String(p)).toBe("/overview");
  });

  it("a live tenants read that fails is not swallowed: the started tenant alone, the reason redacted to one line, one failed trace line", async () => {
    const failing = { run: async () => { throw new Error("connection refused to host-0f1e2d\nat Socket.connect"); } } as unknown as DataLayer;
    const tracer = new MemTracer("tenants_test", { model: "none" });
    const r = await readTenants(failing, "client-1", { text: (s) => s.replace("host-0f1e2d", "a host") }, tracer);
    expect(r).toEqual({ tenants: ["client-1"], error: "connection refused to a host" });
    expect(tracer.events.map((e) => [e.agent, e.action, e.status, e.input_summary, e.output_summary])).toEqual([["console", "detect", "failed", "console tenants client-1", "the store's tenants were not read; the switcher lists client-1 alone"]]);
    // a read that answers: tenant ids only, the started one among them, once each
    const answering = { run: async () => result(["tenant_id"], [["lab-1"], ["*"], ['x"y'], ["client-1"], ["lab-1"]]) } as unknown as DataLayer;
    expect(await readTenants(answering, "client-2", { text: (s) => s }, tracer)).toEqual({ tenants: ["client-1", "client-2", "lab-1"], error: null });
    expect(tracer.events).toHaveLength(1);
  });

  it("the degraded switcher says the list was not read, why, and that it lists the started tenant alone", () => {
    const shell = { tenant: "client-1", csrf: "c", returnTo: "/overview" };
    expect(tenantSwitcher({ ...shell, tenants: ["client-1"], tenantsError: "connection <refused>" })).toBe(`<b>client-1</b><span class="tsw-err" role="status">The store's tenants were not read: connection &lt;refused&gt;. The switcher lists client-1 alone.</span>`);
    expect(tenantSwitcher({ ...shell, tenants: ["client-1"], tenantsError: null })).toBe("<b>client-1</b>");
    expect(CSS).toContain(".tsw-err{");
  });

  it("the rules in force: a family with two rules at its highest version is a duplicate, named, never tie-broken in silence", () => {
    const rules = (SAMPLE.policy_rule as PolicyRule[]).map((r) => ({ ...r }));
    expect(latestRules(rules).duplicates).toEqual([]);
    const v2 = rules.find((r) => Number(r.version) === 2 && r.surface === "cloudflare.dns" && r.setting_glob === "proxied")!;
    const twin = { ...v2, rule_id: "rule-00000000000000d0" };
    const { rules: inForce, duplicates } = latestRules([...rules, twin]);
    expect(duplicates).toEqual([{ family: "* · cloudflare.dns · * · proxied", version: 2, rule_ids: ["rule-00000000000000d0", v2.rule_id] }]);
    expect(inForce.map((r) => r.rule_id)).not.toContain(v2.rule_id);
    expect(duplicateText(duplicates[0])).toBe(`rule family * · cloudflare.dns · * · proxied has 2 rules at version 2 (rule-00000000000000d0, ${v2.rule_id}): the policy names no one rule in force, and the resolver picks by rule id`);
    // a later version of the family settles it
    expect(latestRules([...rules, twin, { ...v2, rule_id: "rule-000000000000000v3", version: 3 }]).duplicates).toEqual([]);
  });

  it("templatesOf resolves the policy once per scope: each distinct surface, object and setting once, the candidates once per object, whatever the rows", () => {
    const rules = (SAMPLE.policy_rule as PolicyRule[]).map((r) => ({ ...r }));
    const obs = (host: string, object_id: string, setting_path: string) => ({ surface: "linux.nginx", host, object_id, setting_path });
    // two hosts hold the same file and settings: six rows, three scopes
    const observations = ["host-a", "host-b"].flatMap((h) => [obs(h, "/etc/nginx/nginx.conf", "file"), obs(h, "/etc/nginx/nginx.conf", "http.real_ip"), obs(h, "/etc/nginx/conf.d/app.conf", "file")]);
    const v = { tenant: "client-1", objects: [], decisions: [], snapshot: { observations, doc: { data: { rules } } } } as unknown as View;
    const calls: string[] = [];
    const counting = (rs: readonly PolicyRule[], s: Parameters<typeof resolvePolicy>[1]): PolicyRule | null => { calls.push(`${s.object_id} ${s.setting_path}`); return resolvePolicy(rs, s); };
    const counted = templatesOf(v, counting);
    expect(calls).toEqual(["/etc/nginx/nginx.conf file", "/etc/nginx/nginx.conf http.real_ip", "/etc/nginx/conf.d/app.conf file"]);
    // the same templates as resolving every row over every rule
    const each = (rs: readonly PolicyRule[], s: Parameters<typeof resolvePolicy>[1]): PolicyRule | null => resolvePolicy(rules, s);
    expect(counted).toEqual(templatesOf(v, each));
    expect(counted.filter((t) => t.settings).map((t) => [t.rule?.object_glob, t.settings])).toEqual([["/etc/nginx/nginx.conf", 2], ["/etc/nginx/conf.d/*.conf", 2], ["**", 2]]);
  });

  it("the two DQ rules a pass reads on Zetaris, side by side: exception_in_force and dns_inventory_current, each read, failed or not read and why", () => {
    expect(passDq(null, "sample", "client-1").map((x) => [x.rule, x.entity, x.text, x.holds])).toEqual([
      ["exception_in_force", "drift_usl.adoption", "no pass from this console yet", null], ["dns_inventory_current", "drift_usl.dns_live", "no pass from this console yet", null],
    ]);
    expect(passDq({}, "sample", "client-1").map((x) => x.text)).toEqual(["not read: the pass reads it on Zetaris, and sample mode reads sql.js", "not read: the pass reads it on Zetaris, and sample mode reads sql.js"]);
    expect(passDq({}, "live", "lab-1").map((x) => x.text)).toEqual(["not read: the pass did not read it", "not read: lab-1 has no cloudflare.dns run to hold the provider to"]);
    const live = passDq({ adoptions: { rule: "exception_in_force", of: "pass", decidedAt: "2026-10-26T00:00:00.000Z", adoptions: 23, inForce: 23 }, dns: { rule: "dns_inventory_current", live: 58, current: 57, runId: "run-1" } }, "live", "client-1");
    expect(live.map((x) => [x.text, x.holds])).toEqual([["23 of 23 adoptions in force", true], ["57 of 58 live records at the provider match the last complete DNS run: the provider changed since that run", false]]);
    expect(passDq({ dns: { rule: "dns_inventory_current", error: "zone_x is not there" } }, "live", "client-1")[1]).toMatchObject({ text: "not read: zone_x is not there", holds: null });
  });
});

describe("the review of 67cd782: one first pass, a download that fails cleanly, every action's return, the tenants error end to end", SERVER, () => {
  let server: ConsoleServer;
  const lines: string[] = [];
  // the file of the last 30 days has two style blocks, every day on record's renderer throws: the 7 days' is the real one
  const renderFile = ((x: Executive, ctx: ExecutiveContext): string => {
    if (x.period === "30d") return renderExecutive(x, ctx).replace("</style>", "</style><style>p{}</style>");
    if (x.period === "all") throw new Error("the renderer broke\n    at renderExecutive (executive.ts:1:1)");
    return renderExecutive(x, ctx);
  }) as typeof renderExecutive;
  beforeAll(async () => { ({ server } = await boot({ bundle: SAMPLE, bundlePath: "sample/bundle.json", tenant: "client-1", at: "2026-10-25T15:00:00.000Z", print: (l) => lines.push(l), renderFile })); }, BOOT_MS);
  afterAll(async () => { await server?.close(); });
  const tenantPost = (tenant: string) => fetch(`${server.url}/do/tenant`, { method: "POST", body: new URLSearchParams({ csrf: server.csrf, tenant }), headers: { accept: "application/json" } });

  it("two switches to a tenant not yet seen, at once, run one first pass, and both answer once it ends", async () => {
    expect(lines.filter((l) => l.startsWith("console: first pass of "))).toEqual(["console: first pass of client-1 decided at 2026-10-25T14:17:53.416Z"]);
    const [a, b] = await Promise.all([tenantPost("lab-1"), tenantPost("lab-1")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(lines.filter((l) => l.startsWith("console: first pass of lab-1"))).toHaveLength(1);
    // a third switch, after it, runs none
    await tenantPost("client-1");
    await tenantPost("lab-1");
    expect(lines.filter((l) => l.startsWith("console: first pass of "))).toHaveLength(2);
    await tenantPost("client-1");
  });

  it("a download whose file fails: a renderer that throws, or a file with two style blocks, is the console's 500 page with the fixed headers, and the console answers on", async () => {
    for (const period of ["30d", "all"]) {
      const r = await get(server, `/executive/download?period=${period}`);
      expect(r.status, period).toBe(500);
      expect(r.headers.get("content-disposition"), period).toBeNull();
      expect([r.headers.get("x-content-type-options"), r.headers.get("referrer-policy"), r.headers.get("cache-control")], period).toEqual(["nosniff", "no-referrer", "no-store"]);
      expect(r.headers.get("content-security-policy"), period).toMatch(/^default-src 'none'; style-src 'self' 'nonce-/);
      expect(r.body, period).toContain("<h1>The console could not render this page</h1>");
      expect(r.body, period).toContain("The executive report could not be written as one file: ");
      expect(r.body, period).not.toContain("executive.ts:1:1");
    }
    expect((await get(server, "/executive/download?period=30d")).body).toContain("fileCsp: the executive report holds one style block, this file opens 2 and closes 2");
    expect(lines.filter((l) => l.startsWith("console: the executive report of client-1 was not written as a file"))).toHaveLength(3);
    // the page and the good file still answer
    expect((await get(server, "/executive/download?period=7d")).status).toBe(200);
    expect((await get(server, "/executive?period=all")).status).toBe(200);
  });

  it("every action returns to the pages a switch returns to: a refused action from Templates or the executive report answers that page with its toast", async () => {
    const form = (ret: string) => fetch(`${server.url}/do/lock`, { method: "POST", body: new URLSearchParams({ csrf: server.csrf, confirm: "yes", key: "", return: ret }) });
    const templates = await (await form("/templates")).text();
    expect(templates).toContain("<h1>Templates</h1>");
    expect(templates).toContain("Lock refused: the object is not in the latest passing runs of this tenant");
    expect(await (await form("/executive?period=30d")).text()).toContain('<a href="/executive?period=30d" aria-current="page">30 days</a>');
    for (const back of ["https://elsewhere.example/", "/traces/view?f=..%2F..%2Fpackage.json", "/executive?period=1y"]) expect(await (await form(back)).text(), back).toContain("<h1>Overview</h1>");
  });

  it("a tenants read that fails reaches the page as plain text escaped once: no stack, no connection string, no password", async () => {
    const failing = { run: async () => { throw new Error('connect ECONNREFUSED postgres://drift:s3cret-pass@db.internal:5432/drift?password=hunter2 <b>"x"</b> & more\n    at TCPConnectWrap.afterConnect (net.js:1:1)'); } } as unknown as DataLayer;
    const { error } = await readTenants(failing, "client-1", BUNDLE_REDACTOR);
    expect(error).not.toMatch(/s3cret-pass|hunter2|TCPConnectWrap|net\.js/);
    expect(error).toContain("<redacted>");
    const html = tenantSwitcher({ tenant: "client-1", tenants: ["client-1"], csrf: "c", returnTo: "/overview", tenantsError: error });
    // escaped once: the markup is text, and no entity is escaped twice
    expect(html).toContain("&lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; more");
    expect(html).not.toMatch(/&amp;(?:lt|gt|quot|amp);/);
    expect(html).not.toContain('<b>"x"</b>');
  });

  it("the live start's tracer is the caller's: a FileTracer writes logs/<id>.jsonl at its first line only, so a start that reads the tenants leaves no file", async () => {
    const id = traceIdOf("console_start_test");
    const fileOf = path.join(config.logDir, `${id}.jsonl`);
    const answering = { run: async () => result(["tenant_id"], [["client-1"]]) } as unknown as DataLayer;
    await readTenants(answering, "client-1", BUNDLE_REDACTOR, new FileTracer(id, { model: "none" }));
    expect(existsSync(fileOf)).toBe(false);
    const failing = { run: async () => { throw new Error("timeout"); } } as unknown as DataLayer;
    try {
      await readTenants(failing, "client-1", BUNDLE_REDACTOR, new FileTracer(id, { model: "none" }));
      const lines = readFileSync(fileOf, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { status: string; input_summary: string });
      expect(lines.map((l) => [l.status, l.input_summary])).toEqual([["failed", "console tenants client-1"]]);
    } finally {
      rmSync(fileOf, { force: true });
    }
    expect(readFileSync(path.join(ROOT, "src", "console", "state.ts"), "utf8")).toMatch(/export async function liveBackend\(o: \{ tenant: string; tracer: Tracer \}\)/);
  });
});

describe("the sample's default tenant", () => {
  it("is the tenant of the latest cloudflare.dns run whose tenant id and instant are well formed; null when none is", () => {
    const run = (tenant_id: unknown, started_at: unknown, surface = "cloudflare.dns") => ({ tenant_id, surface, started_at });
    expect(defaultTenant(SAMPLE.collection_run as Row[])).toBe("client-1");
    expect(defaultTenant([run("a-1", "2026-10-25T10:00:00.000Z"), run("b-1", "2026-10-25T11:00:00.000Z"), run("c-1", "2026-10-25T12:00:00.000Z", "linux.nginx")])).toBe("b-1");
    // a malformed instant or tenant id does not count, whatever it sorts as
    expect(defaultTenant([run("a-1", "2026-10-25T10:00:00.000Z"), run("z-1", "9999"), run("z-2", "2026-10-25T23:00:00Z"), run('x"y', "2026-10-25T23:00:00.000Z"), run("*", "2026-10-25T23:00:00.000Z"), run(7, "2026-10-25T23:00:00.000Z")])).toBe("a-1");
    expect(defaultTenant([run("a-1", "2026-02-30T10:00:00.000Z")])).toBeNull();
    expect(defaultTenant([])).toBeNull();
  });
});

describe("the console over a policy with a duplicate rule family and a tenants read that failed", SERVER, () => {
  let server: ConsoleServer;
  const lines: string[] = [];
  const tracer = new MemTracer("console_dup_test", { model: "none" });
  // a second zetaris.control rule at version 2 beside the shipped file's: no setting of the sample falls under it, so no finding moves
  const twin = { ...(SAMPLE.policy_rule as Row[])[0], rule_id: "rule-00000000000000d0", surface: "zetaris.control", object_glob: "**", setting_glob: "**", version: 2 };
  beforeAll(async () => {
    const bundle = { ...SAMPLE, policy_rule: [...(SAMPLE.policy_rule as Row[]), twin] };
    const backend = await sampleBackend({ tenant: "client-1", bundle, bundlePath: "sample/bundle.json", memoryDir: SAMPLE_MEMORY_DIR, write: false });
    server = await startConsole({
      backend: { ...backend, tenantsError: "the tenants read timed out" }, port: 0, clock: ticking("2026-10-25T15:00:00.000Z"), firstPass: "sync", tracePasses: false, tracer,
      print: (l) => lines.push(l), traceDirs: [{ label: "examples/traces", dir: path.join(ROOT, "examples", "traces") }],
    });
  }, BOOT_MS);
  afterAll(async () => { await server?.close(); });

  it("Templates names the duplicate as an alert, the console prints it and traces it once, however many pages are read", async () => {
    const html = (await get(server, "/templates")).body;
    expect(html).toContain('<div class="alert" role="alert"><b>1 rule family of the policy has more than one rule at the highest version</b><ul><li>rule family * · zetaris.control · ** · ** has 2 rules at version 2 (rule-00000000000000d0, rule-8bcb3a03ffcee62e): the policy names no one rule in force, and the resolver picks by rule id</li></ul></div>');
    await get(server, "/settings");
    await post(server, "pass", {});
    await get(server, "/templates");
    const traced = tracer.events.filter((e) => e.input_summary === "console policy client-1");
    expect(traced.map((e) => [e.agent, e.action, e.status])).toEqual([["console", "check", "failed"]]);
    expect(traced[0].output_summary).toContain("rule family * · zetaris.control · ** · ** has 2 rules at version 2");
    expect(lines.filter((l) => l.startsWith("console: policy: "))).toHaveLength(1);
  });

  it("every page shows the degraded switcher: the tenant read failed, the reason, the started tenant alone", async () => {
    for (const [p] of PAGES) expect((await get(server, p)).body, p).toContain(`<span class="tsw-err" role="status">The store's tenants were not read: the tenants read timed out. The switcher lists client-1 alone.</span>`);
  });
});

describe("the console's exception form under --write, sample mode", SERVER, () => {
  let server: ConsoleServer;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "console-memory-"));
    cpSync(SAMPLE_MEMORY_DIR, dir, { recursive: true });
    ({ server } = await boot({ bundle: SAMPLE, bundlePath: "sample/bundle.json", tenant: "client-1", at: "2026-10-25T15:00:00.000Z", memoryDir: dir, write: true }));
  }, BOOT_MS);
  afterAll(async () => { await server?.close(); rmSync(dir, { recursive: true, force: true }); });

  it("until is a date (00:00 UTC that day) or an instant in the millisecond form, nothing looser", async () => {
    const id = (await get(server, "/findings")).body.match(/name="finding" value="(fnd-[0-9a-f]{16})"/)![1];
    const exception = (until: string) => post(server, "exception", { finding: id, until, reason: "a vendor file, known", by: "technician" });
    for (const until of ["2026-11-31", "2026-02-30", "2026-11-30T00:00:00Z", "2026-11-30T00:00:00.000+01:00", "30 Nov 2026", "soon", ""]) {
      const r = await exception(until);
      expect([r.status, r.json.ok], until).toEqual([400, false]);
      expect(r.json.title, until).toMatch(/^Exception refused: until: a date YYYY-MM-DD \(the exception ends at 00:00 UTC that day\) or an instant YYYY-MM-DDTHH:MM:SS\.mmmZ, got /);
    }
    const day = await exception("2026-11-30");
    expect(day.json.ok).toBe(true);
    expect(day.json.lines[0]).toMatch(/ until 2026-11-30T00:00:00\.000Z /);
    const instant = await exception("2026-12-01T09:30:00.000Z");
    expect(instant.json.ok).toBe(true);
    expect(instant.json.lines[0]).toMatch(/ until 2026-12-01T09:30:00\.000Z /);
  });
});

describe("the console over the loop's fixture world, client-a: a change window holds the drift the locked rule would roll back", SERVER, () => {
  const APP = "/etc/nginx/conf.d/app.conf";
  const BLOG = "/etc/nginx/conf.d/blog.conf";
  const HOST = "host-7f1c";
  const key = encodeKey(objectKey("linux.nginx", HOST, APP));
  const calls: Parameters<typeof approveRun>[1][] = [];
  const fakeApprove: typeof approveRun = async (_store, o) => {
    calls.push(o);
    return { lines: [`approve: fake sign-off of ${o.selection.kind} ${"object_id" in o.selection ? o.selection.object_id : ""} from ${o.run.run_id}`], rows: [], states: [], written: 1 };
  };
  let server: ConsoleServer;
  let backend: Backend;
  beforeAll(async () => { ({ server, backend } = await boot({ bundle: POLICY, bundlePath: "test/fixtures/policy-bundle.json", tenant: "client-a", at: "2026-10-23T04:00:00.000Z", approve: fakeApprove })); }, BOOT_MS);
  afterAll(async () => { await server?.close(); });

  const decisionOn = async (cls: string, object: string) => (await server.settled())!.step.findings.find((f) => f.finding.class === cls && f.finding.object_id === object && f.finding.setting_path === "file")!;

  it("Unlock on app.conf, then a pass: the drift is HOLD until the window ends under the window's reason, decided by policy under the conf.d rule, its window_id set; blog.conf, another object, is still rolled back", async () => {
    const first = await decisionOn("drift_vs_approved", APP);
    expect(first.verb).toBe("ROLLBACK");
    const rule = first.disposition.rule_id;
    const u = await post(server, "unlock", { key, who: "tech-b", hours: "3", why: "moving the upstream" });
    expect(u.json.ok).toBe(true);
    const row = settingRows((await get(server, "/settings")).body).find((r) => r.key === objectKey("linux.nginx", HOST, APP))!;
    expect(row.lock).toBe("window");
    const p = await post(server, "pass", {});
    expect(p.json.ok).toBe(true);
    expect(p.json.lines[0]).toMatch(/^ {2}pass {6}11 findings {3}ROLLBACK 2 · FIX 1 · ADOPT 2 · HOLD 5 · ESCALATE 1/);
    const held = await decisionOn("drift_vs_approved", APP);
    expect(held.verb).toBe("HOLD");
    expect(held.disposition).toMatchObject({ decided_by: "policy", rule_id: rule, window_id: expect.stringMatching(/^win-[0-9a-f]{16}$/) });
    expect(held.disposition.reason).toMatch(/^change window win-[0-9a-f]{16} opened by tech-b until 2026-10-23T07:00:0\d\.000Z: moving the upstream$/);
    expect(held.disposition.expires_at).toMatch(/^2026-10-23T07:00:0\d\.000Z$/);
    expect((await decisionOn("changed_since_backup", APP)).disposition.reason).toBe(held.disposition.reason);
    expect((await decisionOn("approved_missing", BLOG)).verb).toBe("ROLLBACK");
    expect((await decisionOn("approved_missing", BLOG)).disposition.window_id).toBeUndefined();
    // the ledger row carries the window_id, the column PRIOR_HOLDS_SQL reads
    const stored = objects(await backend.layer.run("SELECT verb, window_id FROM {{t:disposition}} WHERE object_id = {{p:o}} AND window_id IS NOT NULL", { o: APP }));
    expect(stored.map((d) => [d.verb, d.window_id])).toEqual([["HOLD", held.disposition.window_id], ["HOLD", held.disposition.window_id]]);
    const findings = (await get(server, "/findings")).body;
    expect(findings).toContain('<span class="verb v-HOLD w">HOLD</span>');
    expect(findings).toContain("opened by tech-b until 23 Oct 2026 07:00 UTC: moving the upstream");
  });

  it("Lock closes the window: the next pass rolls app.conf back again", async () => {
    expect((await post(server, "lock", { key })).json.ok).toBe(true);
    expect((await post(server, "pass", {})).json.ok).toBe(true);
    expect((await decisionOn("drift_vs_approved", APP)).verb).toBe("ROLLBACK");
    expect(settingRows((await get(server, "/settings")).body).find((r) => r.key === objectKey("linux.nginx", HOST, APP))!.lock).toBe("locked");
  });

  it("Approve runs the approve module on the object from its host's latest passing run, prints its lines and closes the open window", async () => {
    expect((await post(server, "unlock", { key, who: "tech-b", hours: "1", why: "signing it off" })).json.ok).toBe(true);
    const a = await post(server, "approve", { key, by: "tech-b", note: "" });
    expect(a.json.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tenant: "client-a", selection: { kind: "object", host: HOST, object_id: APP }, by: "tech-b", note: null, dryRun: false });
    expect(calls[0].run.run_id).toBe("run-nginx-7f1c-1023");
    expect(calls[0].observations.some((o) => o.object_id === APP && o.setting_path === "file")).toBe(true);
    expect(a.json.lines[0]).toBe("approve: fake sign-off of object /etc/nginx/conf.d/app.conf from run-nginx-7f1c-1023");
    expect(a.json.lines).toContainEqual(expect.stringMatching(/^approve: the approved bytes are run run-nginx-7f1c-1023's, vault commit [0-9a-f]{8}$/));
    expect(a.json.lines).toContainEqual(expect.stringMatching(/^change_window win-[0-9a-f]{16} closed \(1 row\)$/));
    expect(settingRows((await get(server, "/settings")).body).find((r) => r.key === objectKey("linux.nginx", HOST, APP))!.lock).toBe("locked");
  });

  it("Approve tells a vault that holds no copy of the run from a vault read that failed, and refuses a by or note it cannot store", async () => {
    const run = backend.layer.run.bind(backend.layer);
    try {
      intercept(backend.layer, VAULT_COPY_READ, async () => result(["copy_id", "git_commit", "taken_at"], []));
      expect((await post(server, "approve", { key, by: "tech-b" })).json.lines).toContain("approve: the vault holds no copy from run run-nginx-7f1c-1023");
      backend.layer.run = run;
      intercept(backend.layer, VAULT_COPY_READ, () => Promise.reject(new Error("engine down\nat line 2")));
      const failed = await post(server, "approve", { key, by: "tech-b" });
      expect(failed.json.ok).toBe(true);
      expect(failed.json.lines).toContain("approve: the vault copy of run run-nginx-7f1c-1023 was not read (engine down); the approval stands, its vault commit unnamed");
      expect(failed.json.lines.some((l) => l.includes("holds no copy"))).toBe(false);
    } finally {
      backend.layer.run = run;
    }
    expect((await post(server, "approve", { key, by: "b".repeat(201) })).json.title).toBe("Approve refused: by: 1 to 200 characters, the person or role signing it off");
    expect((await post(server, "approve", { key, by: "tech-b", note: "one\ntwo" })).json.title).toBe("Approve refused: note: one line of text with no control character, an optional note");
    expect((await post(server, "approve", { key, by: "   " })).json.ok).toBe(true);
    expect(calls.at(-1)!.by).toBe("operator");
    expect(calls).toHaveLength(4);
  });
});

describe("the console's Approve with the real approve module, sample mode", SERVER, () => {
  const APP = "/etc/nginx/conf.d/app.conf";
  const SHOP = "/etc/nginx/conf.d/shop.conf";
  const HOST = "host-7f1c";

  it("closes the window actually open on app.conf, writes the live value as the approved one, and the next pass finds no drift there", async () => {
    const { server, backend } = await boot({ bundle: POLICY, bundlePath: "test/fixtures/policy-bundle.json", tenant: "client-a", at: "2026-10-23T04:00:00.000Z" });
    try {
      const key = encodeKey(objectKey("linux.nginx", HOST, APP));
      expect((await post(server, "unlock", { key, who: "tech-c", hours: "2", why: "the new upstream" })).json.ok).toBe(true);
      const [open] = objects(await backend.layer.run("SELECT window_id, closed_at FROM {{t:change_window}} WHERE object_id = {{p:o}}", { o: APP }));
      expect(open.closed_at).toBe("");
      const a = await post(server, "approve", { key, by: "tech-c" });
      expect(a.json.ok).toBe(true);
      expect(a.json.lines[0]).toMatch(/^approve: linux\.nginx run run-nginx-7f1c-1023 on host-7f1c, started 2026-10-23T\S+, \d+\/\d+ complete: 1 setting\(s\) selected \(object\), approved_by tech-c$/);
      expect(a.json.lines).toContainEqual(expect.stringMatching(/^ {2}replaces {3}appr-[0-9a-f]{16} {2}linux\.nginx {4}host-7f1c {3}\/etc\/nginx\/conf\.d\/app\.conf {2}file {2}sha256:/));
      expect(a.json.lines).toContain("approve: approved_setting 1 row(s) written, 0 current and skipped");
      expect(a.json.lines).toContain(`change_window ${open.window_id} closed (1 row)`);
      const [closed] = objects(await backend.layer.run("SELECT closed_at FROM {{t:change_window}} WHERE window_id = {{p:w}}", { w: open.window_id }));
      expect(closed.closed_at).toMatch(/^2026-10-23T04:00:\d\d\.000Z$/);
      expect(settingRows((await get(server, "/settings")).body).find((r) => r.key === objectKey("linux.nginx", HOST, APP))!.lock).toBe("locked");
      expect((await post(server, "pass", {})).json.ok).toBe(true);
      const p = (await server.settled())!;
      expect(p.step.findings.filter((f) => f.finding.class === "drift_vs_approved" && f.finding.object_id === APP)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("a window that ran out and one on another host are not the object's: Approve closes neither, and both rows stay as they were", async () => {
    const clock = ticking("2026-10-23T04:00:00.000Z");
    const { server, backend } = await boot({ bundle: POLICY, bundlePath: "test/fixtures/policy-bundle.json", tenant: "client-a", clock });
    try {
      const key = encodeKey(objectKey("linux.nginx", HOST, SHOP));
      expect((await post(server, "unlock", { key, who: "tech-c", hours: "1", why: "a short change" })).json.ok).toBe(true);
      // another host's window on the same path, as a store written elsewhere holds it
      const elsewhere = newWindow({ tenant: "client-a", surface: "linux.nginx", host: "host-2b9e", object_id: SHOP, who: "tech-d", why: "the other host", hours: 6, now: new Date("2026-10-23T04:00:00.000Z"), redact: (s) => s });
      expect(await backend.windows.open(elsewhere)).toBe(1);
      clock.advance(2 * 3_600_000);
      const html = (await get(server, "/settings")).body;
      const row = settingRows(html).find((r) => r.key === objectKey("linux.nginx", HOST, SHOP))!;
      expect(row.lock).not.toBe("window");
      expect(html).toContain(" (ran out) · tech-c");
      const a = await post(server, "approve", { key, by: "tech-c" });
      expect(a.json.ok).toBe(true);
      expect(a.json.lines.some((l) => l.startsWith("change_window "))).toBe(false);
      const rows = objects(await backend.layer.run("SELECT host, closed_at FROM {{t:change_window}} WHERE object_id = {{p:o}} ORDER BY host", { o: SHOP }));
      expect(rows).toEqual([{ host: "host-2b9e", closed_at: "" }, { host: HOST, closed_at: "" }]);
    } finally {
      await server.close();
    }
  });

  it("a second Unlock at the same millisecond on the same object writes nothing and says a window is already open or was just opened", async () => {
    const at = new Date("2026-10-23T04:00:00.000Z");
    const { server } = await boot({ bundle: POLICY, bundlePath: "test/fixtures/policy-bundle.json", tenant: "client-a", clock: () => at });
    try {
      const key = encodeKey(objectKey("linux.nginx", HOST, APP));
      const first = await post(server, "unlock", { key, who: "tech-c", hours: "2", why: "the first" });
      expect(first.json.ok).toBe(true);
      expect((await post(server, "lock", { key })).json.ok).toBe(true);
      const second = await post(server, "unlock", { key, who: "tech-c", hours: "2", why: "the second" });
      expect([second.status, second.json.ok]).toEqual([400, false]);
      expect(second.json.title).toBe(`Unlock refused: a change window is already open on ${APP} on ${HOST}, or was just opened at 2026-10-23T04:00:00.000Z: change_window ${first.json.lines[0].split(" ")[1].replace(/:$/, "")} is stored already, nothing written`);
    } finally {
      await server.close();
    }
  });
});

describe("the console when the change windows cannot be read", SERVER, () => {
  it("Settings says why, Unlock is refused, and the first pass escalates the drift the rule would roll back", async () => {
    const { server } = await boot({
      bundle: POLICY, bundlePath: "test/fixtures/policy-bundle.json", tenant: "client-a", at: "2026-10-23T04:00:00.000Z",
      before: (b) => intercept(b.layer, WINDOWS_READ, () => Promise.reject(new Error("no such table: change_window"))),
    });
    try {
      const html = (await get(server, "/settings")).body;
      expect(html).toContain('<p class="alert">The change windows were not read: no such table: change_window. Unlock is refused until they are');
      const key = encodeKey(objectKey("linux.nginx", "host-7f1c", "/etc/nginx/conf.d/app.conf"));
      const u = await post(server, "unlock", { key, who: "tech-a", hours: "1", why: "x" });
      expect(u.json.title).toBe("Unlock refused: the change windows are not read (no such table: change_window), so the passes would not read this one either; npm run zetaris:setup registers change_window");
      const app = (await server.settled())!.step.findings.find((f) => f.finding.class === "drift_vs_approved" && f.finding.object_id === "/etc/nginx/conf.d/app.conf")!;
      expect([app.verb, app.disposition.reason]).toEqual(["ESCALATE", "change windows not read: no such table: change_window; a technician decides"]);
    } finally {
      await server.close();
    }
  });
});

// ---- the pass's change-window read over the fixture world ---------------------------------------------------------

describe("the pass and the change windows, over test/fixtures/policy-bundle.json", () => {
  const AT = "2026-10-23T04:00:00.000Z";
  const APP = "/etc/nginx/conf.d/app.conf";
  const HOST = "host-7f1c";
  let engine: SqlJsEngine;
  let plain: Finding[];
  beforeAll(async () => {
    engine = await SqlJsEngine.create();
    engine.loadBundle(POLICY);
    plain = (await runPass(new DataLayer(engine), { decidedAt: AT })).findings;
  }, BOOT_MS);
  afterAll(() => engine?.close());

  /** The engine with every change_window read failing as a store without the table fails. */
  const failingWindows = (message: string, name: Engine["name"] = "sqljs", show?: () => Promise<QueryResult>): Engine & { sent: string[] } => {
    const sent: string[] = [];
    return {
      name, sent, qualify: (t) => engine.qualify(t),
      run: (sql, o) => {
        // the live pass's schema guard and EXPLAIN reads, answered as Zetaris answers them (test/fixtures/zetaris-meta.ts)
        const meta = name === "zetaris" ? zetarisMeta(sql) : undefined;
        if (meta) return Promise.resolve(meta);
        sent.push(sql);
        if (sql.startsWith("SHOW DATASOURCE TABLES")) return show ? show() : Promise.reject(new Error("not a statement sql.js runs"));
        return /\bchange_window\b/.test(sql) ? Promise.reject(new Error(message)) : engine.run(sql, o);
      },
    };
  };
  const key = (f: Finding): string => `${f.finding.class} ${f.finding.object_id} ${f.finding.setting_path}`;
  const writes = (f: Finding): boolean => WINDOW_CLASSES.includes(f.finding.class) && (f.verb === "ROLLBACK" || f.verb === "FIX");

  it("a window read that fails fails closed: every drift a rule would roll back or fix is ESCALATE with the error; HOLD, ADOPT and ESCALATE stand; traced not_checked once", async () => {
    expect(plain.filter(writes).length).toBeGreaterThanOrEqual(2);
    expect(plain.some((f) => WINDOW_CLASSES.includes(f.finding.class) && f.verb === "HOLD")).toBe(true);
    const tracer = new MemTracer("t_windows_unread", { model: "none" });
    const failed = (await runPass(new DataLayer(failingWindows("no such table: change_window\nnear line 1")), { decidedAt: AT, tracer })).findings;
    expect(failed.map(key)).toEqual(plain.map(key));
    failed.forEach((f, i) => {
      const before = plain[i];
      if (writes(before)) {
        expect(f.disposition, key(f)).toEqual({ verb: "ESCALATE", reason: windowsUnreadReason("no such table: change_window"), expires_at: null, decided_by: before.disposition.decided_by, rule_id: before.disposition.rule_id });
      } else {
        expect(f.disposition, key(f)).toEqual(before.disposition);
      }
    });
    expect(failed.find((f) => f.finding.class === "drift_vs_approved" && f.finding.object_id === APP)!.disposition.reason).toBe("change windows not read: no such table: change_window; a technician decides");
    const marks = tracer.events.filter((e) => e.input_summary === "change_window client-a");
    expect(marks.map((e) => [e.status, e.output_summary])).toEqual([["not_checked", "change windows of client-a not read: a drift a rule would roll back or fix is ESCALATE this pass"]]);
  });

  it("with windowTable false no window is read and the pass decides as with no window, traced skipped", async () => {
    const tracer = new MemTracer("t_windows_absent", { model: "none" });
    const failing = failingWindows("never sent");
    const r = (await runPass(new DataLayer(failing), { decidedAt: AT, tracer, windowTable: false })).findings;
    expect(r.map((f) => [key(f), f.disposition])).toEqual(plain.map((f) => [key(f), f.disposition]));
    expect(failing.sent.some((s) => s.includes("change_window"))).toBe(false);
    expect(tracer.events.filter((e) => e.input_summary === "change_window client-a").map((e) => e.status)).toEqual(["skipped"]);
  });

  it("over Zetaris passStep asks SHOW DATASOURCE TABLES first: a listing without change_window reads none, one with it reads it, a listing that fails reads it anyway", async () => {
    const appVerb = (s: Awaited<ReturnType<typeof passStep>>): string => s.findings.find((f) => f.finding.class === "drift_vs_approved" && f.finding.object_id === APP)!.verb;
    const listing = (...tables: string[]) => async () => result(["name"], tables.map((t) => [t]));
    const without = failingWindows("no such table: change_window", "zetaris", listing("observation", "disposition"));
    expect(appVerb(await passStep(new DataLayer(without), { tenant: "client-a", ledger: null, decidedAt: AT }))).toBe("ROLLBACK");
    expect(without.sent.filter((s) => s.startsWith("SHOW"))).toEqual(["SHOW DATASOURCE TABLES DRIFT"]);
    expect(without.sent.some((s) => s.includes("change_window"))).toBe(false);
    const listed = failingWindows("no such table: change_window", "zetaris", listing("observation", "change_window"));
    expect(appVerb(await passStep(new DataLayer(listed), { tenant: "client-a", ledger: null, decidedAt: AT }))).toBe("ESCALATE");
    const unlisted = failingWindows("no such table: change_window", "zetaris", () => Promise.reject(new Error("403 forbidden")));
    expect(appVerb(await passStep(new DataLayer(unlisted), { tenant: "client-a", ledger: null, decidedAt: AT }))).toBe("ESCALATE");
  });

  it("a window that ran out, one not open yet, one closed and one on another host hold nothing; an open one on the object holds it", async () => {
    const base = { tenant_id: "client-a", surface: "linux.nginx", host: HOST, object_id: APP, setting_path: "*", opened_by: "tech-a", reason: "a change" };
    const w = (id: string, over: Partial<ChangeWindow>): ChangeWindow => ({ ...base, window_id: id, opened_at: "2026-10-23T03:00:00.000Z", until: "2026-10-23T06:00:00.000Z", closed_at: null, ...over });
    const local = await SqlJsEngine.create();
    try {
      local.loadBundle(POLICY);
      local.insertRows("change_window", [
        w("win-ran-out", { opened_at: "2026-10-23T01:00:00.000Z", until: "2026-10-23T04:00:00.000Z" }),
        w("win-later", { opened_at: "2026-10-23T04:00:00.001Z" }),
        w("win-closed", { closed_at: "2026-10-23T03:30:00.000Z" }),
        w("win-other-host", { host: "host-2b9e" }),
      ]);
      const app = async () => (await runPass(new DataLayer(local), { decidedAt: AT })).findings.find((f) => f.finding.class === "drift_vs_approved" && f.finding.object_id === APP)!;
      expect((await app()).disposition).toEqual(plain.find((f) => f.finding.class === "drift_vs_approved" && f.finding.object_id === APP)!.disposition);
      local.insertRows("change_window", [w("win-open", {})]);
      expect((await app()).disposition).toMatchObject({ verb: "HOLD", window_id: "win-open", expires_at: "2026-10-23T06:00:00.000Z" });
    } finally {
      local.close();
    }
  });
});

describe("the readiness checks: SHOW DATASOURCE TABLES and the console's start", () => {
  const listing = (columns: string[], rows: string[][]): Pick<Engine, "run"> & { sent: string[] } => {
    const sent: string[] = [];
    return { sent, run: async (sql) => { sent.push(sql); return result(columns, rows); } };
  };

  it("datasourceLists reads the name column, else the first cell, in any case; a statement that fails is null", async () => {
    const e = listing(["name"], [["observation"], ["change_window"]]);
    expect(await datasourceLists(e, "change_window", { datasource: "DRIFT" })).toBe(true);
    expect(e.sent).toEqual(["SHOW DATASOURCE TABLES DRIFT"]);
    expect(await datasourceLists(listing(["name"], [["observation"]]), "change_window", { datasource: "DRIFT" })).toBe(false);
    expect(await datasourceLists(listing(["database", "name"], [["DRIFT", "CHANGE_WINDOW"]]), "change_window", { datasource: "DRIFT" })).toBe(true);
    expect(await datasourceLists(listing(["tableName"], [["change_window"]]), "change_window", { datasource: "DRIFT" })).toBe(true);
    expect(await datasourceLists({ run: () => Promise.reject(new Error("403")) }, "change_window", { datasource: "DRIFT" })).toBeNull();
    expect(await datasourceLists(listing(["name"], []), "change_window", { datasource: "DRIFT; DROP" })).toBeNull();
  });

  it("zetarisGaps names the change_window table a listing lacks and a disposition.window_id that does not read; none when both are there", async () => {
    const ok = { counting: listing(["name"], [["change_window"]]), layer: { run: async () => result(["window_id"], []) } };
    expect(await zetarisGaps(ok as unknown as Backend, "DRIFT")).toEqual([]);
    const gaps = { counting: listing(["name"], [["observation"]]), layer: { run: () => Promise.reject(new Error("column window_id not found")) } };
    expect(await zetarisGaps(gaps as unknown as Backend, "DRIFT")).toEqual(["the change_window table in DRIFT", "the window_id column of DRIFT.disposition"]);
  });
});

// ---- the Decider's change-window step, pure ------------------------------------------------------------------------

describe("decide: the change window, the last step before the default", () => {
  const AT = "2026-10-24T12:00:00.000Z";
  const HASH = `sha256:${"a1b2c3d4e5f6".repeat(5)}a1b2`;
  const rule = (over: Partial<PolicyRule> = {}): PolicyRule => ({
    rule_id: "rule-00000000000000a1", tenant_id: "*", surface: "linux.nginx", object_glob: "/etc/nginx/conf.d/*.conf", setting_glob: "file", criticality: "critical",
    lock: 1, on_drift: "rollback", on_no_copy: "investigate_ticket", hold_max_hours: 24, alert: "on_fix", psa_priority: "P1", version: 2, author: "operator", since: "2026-10-25T00:00:00.000Z", note: null, ...over,
  });
  const copy: CopyCandidate = {
    copy_id: "copy-1", run_id: "run-1020", git_commit: "5a14a89d0123456789abcdef0123456789abcdef", blob_sha256: HASH, taken_at: "2026-10-20T02:01:00.000Z",
    value_hash: HASH, validator: "nginx-t", result: "ok", missing_dependencies: "", validated_at: "2026-10-21T04:00:00.000Z",
  };
  const win = (over: Partial<ChangeWindow> = {}): ChangeWindow => ({
    window_id: "win-0000000000000001", tenant_id: "client-a", surface: "linux.nginx", host: "host-7f1c", object_id: "/etc/nginx/conf.d/app.conf", setting_path: "*",
    opened_by: "tech-a", opened_at: "2026-10-24T11:00:00.000Z", until: "2026-10-24T14:00:00.000Z", reason: "moving the upstream", closed_at: null, ...over,
  });
  const ANSWERING = { run_id: "run-probe", rows: [{ kind: "http", target: "shop.example.invalid", status: "ok" }] };
  const FAILING = { run_id: "run-probe", rows: [{ kind: "http", target: "shop.example.invalid", status: "fail" }] };
  const input = (over: Partial<DecideInput> = {}): DecideInput => ({
    finding: { class: "drift_vs_approved" }, rule: rule(), exception: { state: "none" }, checks: { verb: "ESCALATE", why: "1 of 4 preconditions fail: setting_matches_approved" },
    approved: { value_hash: HASH, approved_at: "2026-10-19T09:00:00.000Z", approved_by: "tech-4e" }, copies: [copy], probes: ANSWERING, serves: ["shop.example.invalid"], decidedAt: AT, ...over,
  });
  const HELD = { verb: "HOLD", reason: "change window win-0000000000000001 opened by tech-a until 2026-10-24T14:00:00.000Z: moving the upstream", expires_at: "2026-10-24T14:00:00.000Z", decided_by: "policy", rule_id: "rule-00000000000000a1", window_id: "win-0000000000000001" };

  it("inside a window a ROLLBACK the locked rule gives is held until the window ends, under the window's reason, decided by policy under the rule, the window's id on it", () => {
    expect(decide(input()).verb).toBe("ROLLBACK");
    expect(decide(input({ window: win() }))).toEqual(HELD);
    expect(windowReason(win())).toBe(HELD.reason);
  });

  it("a FIX and a rule's own HOLD are held under the window too; on changed_since_backup and approved_missing as on drift_vs_approved", () => {
    expect(decide(input({ copies: [], probes: FAILING })).verb).toBe("FIX");
    expect(decide(input({ copies: [], probes: FAILING, window: win() }))).toEqual(HELD);
    expect(decide(input({ copies: [] })).verb).toBe("HOLD");
    expect(decide(input({ copies: [], window: win() }))).toEqual(HELD);
    expect(decide(input({ finding: { class: "changed_since_backup" }, approved: null, window: win() }))).toEqual(HELD);
    expect(decide(input({ finding: { class: "approved_missing" }, window: win() }))).toEqual(HELD);
    expect(WINDOW_CLASSES).toEqual(["drift_vs_approved", "changed_since_backup", "approved_missing"]);
  });

  it("ESCALATE and ADOPT stand inside a window, and so do the exception and the default", () => {
    const unknown = decide(input({ copies: [], probes: { run_id: null, rows: [] }, window: win() }));
    expect(unknown.verb).toBe("ESCALATE");
    expect(unknown.reason).toContain("no probe run in this pass");
    expect(decide(input({ rule: rule({ lock: 0, on_drift: "adopt" }), window: win() })).verb).toBe("ADOPT");
    expect(decide(input({ window: win(), exception: { state: "applied", lesson: "mem-1", expires_at: "2026-11-30T00:00:00.000Z", reason: "vendor file" } })).decided_by).toBe("operator");
    expect(decide(input({ rule: null, window: win() }))).toEqual({ verb: "ESCALATE", reason: "1 of 4 preconditions fail: setting_matches_approved", expires_at: null, decided_by: "default", rule_id: null });
  });

  it("outside a window nothing changes: after it ends, before it opens, closed early, or on another class", () => {
    const rollback = decide(input());
    expect(decide(input({ window: win(), decidedAt: "2026-10-24T14:00:00.000Z" }))).toEqual(decide(input({ decidedAt: "2026-10-24T14:00:00.000Z" })));
    expect(decide(input({ window: win({ opened_at: "2026-10-24T12:00:00.001Z" }) }))).toEqual(rollback);
    expect(decide(input({ window: win({ closed_at: "2026-10-24T11:30:00.000Z" }) }))).toEqual(rollback);
    expect(decide(input({ finding: { class: "orphan_vhost" }, approved: null, rule: rule({ lock: 0, on_drift: "hold", setting_glob: "**" }), window: win() })).reason).toMatch(/^rule rule-00000000000000a1 \(critical\) holds this orphan_vhost finding until /);
    expect([windowOpen(win(), "2026-10-24T11:00:00.000Z"), windowOpen(win(), "2026-10-24T13:59:59.999Z"), windowOpen(win(), "2026-10-24T14:00:00.000Z"), windowOpen(win({ closed_at: AT }), AT)]).toEqual([true, true, false, false]);
  });

  it("with the windows unread a ROLLBACK or FIX on a drift class is ESCALATE with the error; HOLD, ADOPT, ESCALATE and the other classes stand", () => {
    const unread = { windowError: "no such table: change_window" };
    const escalated = { verb: "ESCALATE", reason: "change windows not read: no such table: change_window; a technician decides", expires_at: null, decided_by: "policy", rule_id: "rule-00000000000000a1" };
    expect(decide(input(unread))).toEqual(escalated);
    expect(decide(input({ ...unread, copies: [], probes: FAILING }))).toEqual(escalated);
    expect(decide(input({ ...unread, finding: { class: "approved_missing" } }))).toEqual(escalated);
    // a changed_since_backup with no approval is the rule's HOLD: it stands
    expect(decide(input({ finding: { class: "changed_since_backup" }, approved: null })).verb).toBe("HOLD");
    expect(decide(input({ ...unread, finding: { class: "changed_since_backup" }, approved: null }))).toEqual(decide(input({ finding: { class: "changed_since_backup" }, approved: null })));
    // the unread error wins over a window the caller still passed: nothing is held on a read the pass could not make
    expect(decide(input({ ...unread, window: win() }))).toEqual(escalated);
    expect(decide(input({ ...unread, copies: [] }))).toEqual(decide(input({ copies: [] })));
    expect(decide(input({ ...unread, rule: rule({ lock: 0, on_drift: "adopt" }) }))).toEqual(decide(input({ rule: rule({ lock: 0, on_drift: "adopt" }) })));
    expect(decide(input({ ...unread, copies: [], probes: { run_id: null, rows: [] } }))).toEqual(decide(input({ copies: [], probes: { run_id: null, rows: [] } })));
    const orphan = input({ finding: { class: "orphan_vhost" }, approved: null, rule: rule({ setting_glob: "**" }) });
    expect(decide({ ...orphan, ...unread })).toEqual(decide(orphan));
  });

  it("the window's until replaces the expiry a prior HOLD in force carried, earlier or later; an expired prior HOLD stays ESCALATE; after the window the rule's own expiry is back", () => {
    const hold = (over: Partial<DecideInput> = {}): DecideInput => input({ copies: [], ...over });
    const later = { decided_at: "2026-10-24T08:00:00.000Z", expires_at: "2026-10-25T08:00:00.000Z", rule_id: "rule-00000000000000a1" };
    const sooner = { ...later, expires_at: "2026-10-24T13:00:00.000Z" };
    const expired = { ...later, expires_at: "2026-10-24T11:00:00.000Z" };
    expect(decide(hold({ priorHold: later })).expires_at).toBe(later.expires_at);
    expect(decide(hold({ priorHold: later, window: win() }))).toMatchObject({ verb: "HOLD", expires_at: "2026-10-24T14:00:00.000Z", window_id: "win-0000000000000001" });
    expect(decide(hold({ priorHold: sooner })).expires_at).toBe(sooner.expires_at);
    expect(decide(hold({ priorHold: sooner, window: win() }))).toMatchObject({ verb: "HOLD", expires_at: "2026-10-24T14:00:00.000Z" });
    expect(decide(hold({ priorHold: expired })).verb).toBe("ESCALATE");
    expect(decide(hold({ priorHold: expired, window: win() }))).toEqual(decide(hold({ priorHold: expired })));
    const after = "2026-10-24T15:00:00.000Z";
    expect(decide(hold({ priorHold: later, window: win(), decidedAt: after }))).toEqual(decide(hold({ priorHold: later, decidedAt: after })));
    expect(decide(hold({ priorHold: later, window: win(), decidedAt: after })).expires_at).toBe(later.expires_at);
  });

  it("openWindow matches the window's tenant, surface, host and object, every setting under *: another object, host or tenant has none; one that ran out is none", () => {
    const s = { tenant_id: "client-a", surface: "linux.nginx", host: "host-7f1c", object_id: "/etc/nginx/conf.d/app.conf", setting_path: "file" };
    const w = win();
    expect(openWindow([w], s, AT)).toBe(w);
    expect(openWindow([w], { ...s, object_id: "/etc/nginx/conf.d/shop.conf" }, AT)).toBeNull();
    expect(openWindow([w], { ...s, host: "host-2b9e" }, AT)).toBeNull();
    expect(openWindow([w], { ...s, tenant_id: "client-b" }, AT)).toBeNull();
    expect(openWindow([win({ setting_path: "file" })], { ...s, setting_path: "server.listen" }, AT)).toBeNull();
    expect(openWindow([win({ until: "2026-10-24T12:00:00.000Z" })], s, AT)).toBeNull();
    const later = win({ window_id: "win-0000000000000002", opened_at: "2026-10-24T11:30:00.000Z" });
    expect(openWindow([w, later], s, AT)).toBe(later);
    expect(openWindow([win({ surface: "cloudflare.dns", host: null, object_id: "rec-1" })], { ...s, surface: "cloudflare.dns", host: null, object_id: "rec-1", setting_path: "content" }, AT)?.object_id).toBe("rec-1");
  });

  it("two windows of different scopes on one object: each setting gets the latest opened of those that cover it, * covering every setting", () => {
    const s = { tenant_id: "client-a", surface: "linux.nginx", host: "host-7f1c", object_id: "/etc/nginx/conf.d/app.conf", setting_path: "file" };
    const all = win({ window_id: "win-all", setting_path: "*", opened_at: "2026-10-24T11:00:00.000Z" });
    const file = win({ window_id: "win-file", setting_path: "file", opened_at: "2026-10-24T11:30:00.000Z" });
    expect(openWindow([all, file], s, AT)?.window_id).toBe("win-file");
    expect(openWindow([all, file], { ...s, setting_path: "server.listen" }, AT)?.window_id).toBe("win-all");
    const allLater = win({ window_id: "win-all-later", setting_path: "*", opened_at: "2026-10-24T11:45:00.000Z" });
    expect(openWindow([all, file, allLater], s, AT)?.window_id).toBe("win-all-later");
    // the narrower one closed: the wider one covers the setting again
    expect(openWindow([all, win({ ...file, closed_at: "2026-10-24T11:40:00.000Z" })], s, AT)?.window_id).toBe("win-all");
    expect(decide(input({ window: openWindow([all, file], s, AT) })).window_id).toBe("win-file");
  });

  it("newWindow: who and why through the redactor, one line each, 1 to 72 whole hours, a known surface, setting *, the id from its parts; MemoryWindows opens and closes it on sql.js", async () => {
    const now = new Date("2026-10-24T11:00:00.000Z");
    const w = newWindow({ tenant: "client-a", surface: "linux.nginx", host: "host-7f1c", object_id: "/etc/nginx/conf.d/app.conf", who: " tech-a ", why: "x", hours: 72, now, redact: (s) => s.toUpperCase() });
    expect(w).toEqual({
      window_id: windowId("client-a", "linux.nginx", "host-7f1c", "/etc/nginx/conf.d/app.conf", "*", "2026-10-24T11:00:00.000Z"), tenant_id: "client-a", surface: "linux.nginx", host: "host-7f1c",
      object_id: "/etc/nginx/conf.d/app.conf", setting_path: "*", opened_by: "TECH-A", opened_at: "2026-10-24T11:00:00.000Z", until: "2026-10-27T11:00:00.000Z", reason: "X", closed_at: null,
    });
    const make = (over: { who?: string; why?: string; hours?: number; surface?: string }) => () => newWindow({ tenant: "t", surface: "linux.nginx", host: null, object_id: "o", who: "a", why: "b", hours: 1, now, redact: (s) => s, ...over });
    for (const hours of [0, 73, 1.5, Number.NaN]) expect(make({ hours })).toThrow(WindowError);
    expect(make({ who: " " })).toThrow(/^who: 1 to 200 characters/);
    expect(make({ who: "a".repeat(201) })).toThrow(/^who: 1 to 200 characters/);
    expect(make({ why: "b".repeat(501) })).toThrow(/^why: 1 to 500 characters/);
    expect(make({ who: "a\tb" })).toThrow(/^who: one line of text with no control character/);
    expect(make({ why: "b\u0085c" })).toThrow(/^why: one line of text with no control character/);
    expect(make({ surface: "linux.sshd" })).toThrow("surface: a window is declared on linux.nginx, linux.etc, cloudflare.dns, got linux.sshd");
    expect(make({ who: "a".repeat(200), why: "b".repeat(500) })().opened_by).toHaveLength(200);
    expect(WINDOW_SURFACES).toEqual(["linux.nginx", "linux.etc", "cloudflare.dns"]);
    expect(freeText("note", "", 500, "an optional note", true)).toBe("");
    const engine = await SqlJsEngine.create();
    const store = new MemoryWindows(engine);
    expect(await store.open(w)).toBe(1);
    expect(await store.open(w)).toBe(0);
    expect(await store.close(w.window_id, "2026-10-24T12:00:00.000Z")).toBe(1);
    expect(await store.close(w.window_id, "2026-10-24T12:30:00.000Z")).toBe(0);
    const back = objects(await new DataLayer(engine).run("SELECT window_id, until, closed_at FROM {{t:change_window}}"));
    expect(back).toEqual([{ window_id: w.window_id, until: "2026-10-27T11:00:00.000Z", closed_at: "2026-10-24T12:00:00.000Z" }]);
    engine.close();
  });

  it("change_window refuses an until not after opened_at, a closed_at before it and an unknown surface; the object index exists", async () => {
    const engine = await SqlJsEngine.create();
    try {
      const ok = win();
      expect(engine.insertRows("change_window", [ok])).toBe(1);
      expect(() => engine.insertRows("change_window", [win({ window_id: "w2", until: ok.opened_at })])).toThrow(/CHECK constraint failed: change_window_span/);
      expect(() => engine.insertRows("change_window", [win({ window_id: "w3", closed_at: "2026-10-24T10:59:59.999Z" })])).toThrow(/CHECK constraint failed: change_window_closed/);
      expect(() => engine.insertRows("change_window", [win({ window_id: "w4", surface: "linux.sshd" })])).toThrow(/CHECK constraint failed: change_window_surface/);
      expect(engine.closeChangeWindow(ok.window_id, ok.opened_at)).toBe(1);
      const index = objects(await new DataLayer(engine).run("SELECT window_id FROM {{t:change_window}} WHERE tenant_id = 'client-a' AND surface = 'linux.nginx' AND host = 'host-7f1c' AND object_id = '/etc/nginx/conf.d/app.conf'"));
      expect(index).toHaveLength(1);
    } finally {
      engine.close();
    }
  });

  it("PRIOR_HOLDS_SQL leaves a window's HOLD out by its window_id, whatever its reason says: a window neither starts nor ends a rule's expiry", async () => {
    const engine = await SqlJsEngine.create();
    const base = { tenant_id: "client-a", surface: "linux.nginx", host: "host-7f1c", object_id: "/etc/nginx/conf.d/app.conf", setting_path: "file", value_hash: HASH, finding_id: "fnd-1", run_id: "run-1" };
    const rows: Disposition[] = [
      { ...base, disposition_id: "disp-1", verb: "HOLD", reason: "rule r holds it", expires_at: "2026-10-25T10:00:00.000Z", decided_by: "policy", rule_id: "rule-1", decided_at: "2026-10-24T09:00:00.000Z" },
      { ...base, disposition_id: "disp-2", verb: "HOLD", reason: HELD.reason, expires_at: "2026-10-24T14:00:00.000Z", decided_by: "policy", rule_id: "rule-1", decided_at: "2026-10-24T11:00:00.000Z", window_id: HELD.window_id },
    ];
    await new MemoryLedger(engine).record(rows);
    const holds = async () => objects(await priorHolds(new DataLayer(engine), { tenant_id: "client-a", decided_at: AT })).map((h) => [h.disposition_id, h.expires_at]);
    expect(await holds()).toEqual([["disp-1", "2026-10-25T10:00:00.000Z"]]);
    // a rule's own HOLD whose sentence happens to begin as a window's is a rule's HOLD: the column decides, not the text
    await new MemoryLedger(engine).record([{ ...base, disposition_id: "disp-3", verb: "HOLD", reason: "change window text in a rule's own sentence", expires_at: "2026-10-25T10:00:00.000Z", decided_by: "policy", rule_id: "rule-1", decided_at: "2026-10-24T10:00:00.000Z", window_id: null }]);
    expect(await holds()).toEqual([["disp-3", "2026-10-25T10:00:00.000Z"]]);
    engine.close();
  });
});

describe("runLine", () => {
  const run = { run_id: "run-1", tenant_id: "client-a", surface: "linux.nginx", host: "host-7f1c", started_at: "2026-10-23T02:01:00.000Z", finished_at: null, status: "running" as const };
  it("names the counts it has and never prints null", () => {
    expect(runLine({ ...run, observed_count: 12, expected_count: 12, status: "complete" })).toBe("linux.nginx run run-1 on host-7f1c, started 2026-10-23T02:01:00.000Z, 12/12 complete");
    expect(runLine({ ...run, observed_count: null, expected_count: null })).toBe("linux.nginx run run-1 on host-7f1c, started 2026-10-23T02:01:00.000Z, no counts, running");
    expect(runLine({ ...run, observed_count: 3, expected_count: null })).toBe("linux.nginx run run-1 on host-7f1c, started 2026-10-23T02:01:00.000Z, 3/? running");
    expect(runLine({ ...run, observed_count: null, expected_count: 12 })).not.toContain("null");
  });
});
