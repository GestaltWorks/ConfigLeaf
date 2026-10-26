// The technician's console (src/console/) and the change-window step of the Decider (src/policy/decide.ts). The
// server boots in sample mode on an ephemeral port twice: over sample/bundle.json for client-1 with the committed
// lessons (every page, the Settings objects and their locks, Unlock, Lock, the CSRF refusals, no external URL), and over
// test/fixtures/policy-bundle.json for client-a, the loop's fixture world, whose app.conf drifts under the locked conf.d
// rule with a valid copy (Unlock then a pass holds it instead of rolling it back, Lock and a pass roll it back again,
// Approve runs the approve module, a fake, and closes the window). Offline: no host, no Zetaris, no Postgres; the
// passes write no trace file.
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SAMPLE_MEMORY_DIR } from "../src/config.ts";
import { encodeKey } from "../src/console/pages.ts";
import { startConsole, type ConsoleServer } from "../src/console/server.ts";
import { objectKey, sampleBackend, type Backend } from "../src/console/state.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { objects, priorHolds } from "../src/data/queries.ts";
import { windowId, type ChangeWindow, type Disposition, type PolicyRule } from "../src/data/rows.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { WINDOW_CLASSES, decide, openWindow, windowOpen, windowReason, type CopyCandidate, type DecideInput } from "../src/policy/decide.ts";
import { resolvePolicy } from "../src/policy/resolve.ts";
import { MemoryWindows, WindowError, newWindow } from "../src/policy/window.ts";
import type { approveRun } from "../src/vault/approve.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SAMPLE = JSON.parse(readFileSync(path.join(ROOT, "sample", "bundle.json"), "utf8")) as Record<string, unknown>;
const POLICY = JSON.parse(readFileSync(path.join(ROOT, "test", "fixtures", "policy-bundle.json"), "utf8")) as Record<string, unknown>;
const PAGES: readonly [string, string][] = [
  ["/overview", "<h1>Overview</h1>"], ["/settings", "<h1>Settings</h1>"], ["/findings", "<h1>Findings</h1>"], ["/actions", "<h1>Actions and tickets</h1>"],
  ["/traces", "<h1>Traces</h1>"], ["/sources", "<h1>Sources</h1>"], ["/policy", "<h1>Policy</h1>"], ["/document", "<h1>The owner's document</h1>"],
];

/** A clock that starts at `iso` and moves one second each time it is read. */
const ticking = (iso: string): (() => Date) => { let t = Date.parse(iso); return () => new Date((t += 1000)); };

type Row = Record<string, unknown>;
const rowsOf = (b: Record<string, unknown>, t: string): Row[] => (b[t] ?? []) as Row[];

async function boot(bundle: Record<string, unknown>, bundlePath: string, tenant: string, at: string, approve?: typeof approveRun): Promise<{ server: ConsoleServer; backend: Backend }> {
  const backend = await sampleBackend({ tenant, bundle, bundlePath, memoryDir: SAMPLE_MEMORY_DIR, write: false });
  const server = await startConsole({
    backend, port: 0, clock: ticking(at), firstPass: "sync", tracePasses: false, print: () => undefined, approve,
    traceDirs: [{ label: "examples/traces", dir: path.join(ROOT, "examples", "traces") }],
  });
  return { server, backend };
}

const get = async (s: ConsoleServer, p: string): Promise<{ status: number; body: string }> => {
  const r = await fetch(`${s.url}${p}`);
  return { status: r.status, body: await r.text() };
};

const post = async (s: ConsoleServer, action: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<{ status: number; json: { ok: boolean; title: string; lines: string[] } }> => {
  const r = await fetch(`${s.url}/do/${action}`, { method: "POST", body: new URLSearchParams({ csrf: s.csrf, confirm: "yes", ...fields }), headers: { accept: "application/json", ...headers } });
  return { status: r.status, json: await r.json() as { ok: boolean; title: string; lines: string[] } };
};

/** The Settings rows: each one's key, its text and its lock. */
function settingRows(html: string): { key: string; lock: string; status: string; text: string }[] {
  return [...html.matchAll(/<tr data-open="[^"]+" data-key="([^"]+)"[^>]*data-lock="([^"]+)" data-status="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => ({ key: Buffer.from(m[1], "base64url").toString("utf8"), lock: m[2], status: m[3], text: m[4] }));
}

describe("the console over sample/bundle.json, client-1", () => {
  let server: ConsoleServer;
  beforeAll(async () => { ({ server } = await boot(SAMPLE, "sample/bundle.json", "client-1", "2026-10-25T15:00:00.000Z")); }, 60_000);
  afterAll(async () => { await server?.close(); });

  it("binds 127.0.0.1 on the port it was given, 0 for an ephemeral one, and redirects / to the Overview", async () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await fetch(`${server.url}/`, { redirect: "manual" });
    expect([r.status, r.headers.get("location")]).toEqual([303, "/overview"]);
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

  it("Unlock writes a change window and the row reads open until its end; Lock closes it and the row reads locked again", async () => {
    const before = settingRows((await get(server, "/settings")).body).find((r) => r.key.endsWith("\u001f/etc/nginx/nginx.conf"))!;
    const u = await post(server, "unlock", { key: encodeKey(before.key), who: "tech-a", hours: "2", why: "a planned upstream change" });
    expect(u.status).toBe(200);
    expect(u.json.ok).toBe(true);
    expect(u.json.title).toMatch(/^Change window open on \/etc\/nginx\/nginx\.conf until 25 Oct 2026 17:00 UTC$/);
    expect(u.json.lines[0]).toMatch(/^change_window win-[0-9a-f]{16}: 1 row written$/);
    expect(u.json.lines).toContain("sample mode: changes live for this process");
    const open = settingRows((await get(server, "/settings")).body).find((r) => r.key === before.key)!;
    expect(open.lock).toBe("window");
    expect(open.text).toContain(">open until 25 Oct 2026 17:00 UTC<");
    expect((await get(server, "/settings")).body).toMatch(/<b>1<\/b> window open<\/a>/);
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

  it("no page names an external URL: no script, style, font, frame or form outside the console, and no absolute URL in the page text", async () => {
    for (const p of [...PAGES.map(([x]) => x), "/overview/report"]) {
      const body = (await get(server, p)).body;
      expect(body.match(/(?:src|href|action)\s*=\s*["']?(?:https?:)?\/\//gi), p).toBeNull();
      expect(body.match(/<link\b|<script\s+src|@import|url\(\s*["']?https?:/gi), p).toBeNull();
      expect(body.match(/https?:\/\/[^\s"'<]+/g), p).toBeNull();
    }
  });
});

describe("the console over the loop's fixture world, client-a: a change window holds the drift the locked rule would roll back", () => {
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
  beforeAll(async () => { ({ server } = await boot(POLICY, "test/fixtures/policy-bundle.json", "client-a", "2026-10-23T04:00:00.000Z", fakeApprove)); }, 60_000);
  afterAll(async () => { await server?.close(); });

  const decisionOn = async (cls: string, object: string) => (await server.settled())!.step.findings.find((f) => f.finding.class === cls && f.finding.object_id === object && f.finding.setting_path === "file")!;

  it("Unlock on app.conf, then a pass: the drift is HOLD until the window ends under the window's reason, decided by policy under the conf.d rule; blog.conf, another object, is still rolled back", async () => {
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
    expect(held.disposition).toMatchObject({ decided_by: "policy", rule_id: rule });
    expect(held.disposition.reason).toMatch(/^change window win-[0-9a-f]{16} opened by tech-b until 2026-10-23T07:00:0\d\.000Z: moving the upstream$/);
    expect(held.disposition.expires_at).toMatch(/^2026-10-23T07:00:0\d\.000Z$/);
    expect((await decisionOn("changed_since_backup", APP)).disposition.reason).toBe(held.disposition.reason);
    expect((await decisionOn("approved_missing", BLOG)).verb).toBe("ROLLBACK");
    const findings = (await get(server, "/findings")).body;
    expect(findings).toContain('<span class="verb v-HOLD w">HOLD</span>');
    expect(findings).toContain("opened by tech-b until 2026-10-23T07:00:0");
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
});

describe("the console's Approve with the real approve module, sample mode", () => {
  it("writes the live value as the approved one into the sql.js store, so the next pass finds no drift on app.conf", async () => {
    const { server } = await boot(POLICY, "test/fixtures/policy-bundle.json", "client-a", "2026-10-23T04:00:00.000Z");
    try {
      const key = encodeKey(objectKey("linux.nginx", "host-7f1c", "/etc/nginx/conf.d/app.conf"));
      const a = await post(server, "approve", { key, by: "tech-c" });
      expect(a.json.ok).toBe(true);
      expect(a.json.lines[0]).toMatch(/^approve: linux\.nginx run run-nginx-7f1c-1023 on host-7f1c, started 2026-10-23T\S+, \d+\/\d+ complete: 1 setting\(s\) selected \(object\), approved_by tech-c$/);
      expect(a.json.lines).toContainEqual(expect.stringMatching(/^ {2}replaces {3}appr-[0-9a-f]{16} {2}linux\.nginx {4}host-7f1c {3}\/etc\/nginx\/conf\.d\/app\.conf {2}file {2}sha256:/));
      expect(a.json.lines).toContain("approve: approved_setting 1 row(s) written, 0 current and skipped");
      expect((await post(server, "pass", {})).json.ok).toBe(true);
      const p = (await server.settled())!;
      expect(p.step.findings.filter((f) => f.finding.class === "drift_vs_approved" && f.finding.object_id === "/etc/nginx/conf.d/app.conf")).toEqual([]);
    } finally {
      await server.close();
    }
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
  const HELD = { verb: "HOLD", reason: "change window win-0000000000000001 opened by tech-a until 2026-10-24T14:00:00.000Z: moving the upstream", expires_at: "2026-10-24T14:00:00.000Z", decided_by: "policy", rule_id: "rule-00000000000000a1" };

  it("inside a window a ROLLBACK the locked rule gives is held until the window ends, under the window's reason, decided by policy under the rule", () => {
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

  it("openWindow matches the window's tenant, surface, host and object, every setting under *: another object, host or tenant has none", () => {
    const s = { tenant_id: "client-a", surface: "linux.nginx", host: "host-7f1c", object_id: "/etc/nginx/conf.d/app.conf", setting_path: "file" };
    const w = win();
    expect(openWindow([w], s, AT)).toBe(w);
    expect(openWindow([w], { ...s, object_id: "/etc/nginx/conf.d/shop.conf" }, AT)).toBeNull();
    expect(openWindow([w], { ...s, host: "host-2b9e" }, AT)).toBeNull();
    expect(openWindow([w], { ...s, tenant_id: "client-b" }, AT)).toBeNull();
    expect(openWindow([win({ setting_path: "file" })], { ...s, setting_path: "server.listen" }, AT)).toBeNull();
    const later = win({ window_id: "win-0000000000000002", opened_at: "2026-10-24T11:30:00.000Z" });
    expect(openWindow([w, later], s, AT)).toBe(later);
    expect(openWindow([win({ surface: "cloudflare.dns", host: null, object_id: "rec-1" })], { ...s, surface: "cloudflare.dns", host: null, object_id: "rec-1", setting_path: "content" }, AT)?.object_id).toBe("rec-1");
  });

  it("newWindow: who and why through the redactor, 1 to 72 whole hours, setting *, the id from its parts; MemoryWindows opens and closes it on sql.js", async () => {
    const now = new Date("2026-10-24T11:00:00.000Z");
    const w = newWindow({ tenant: "client-a", surface: "linux.nginx", host: "host-7f1c", object_id: "/etc/nginx/conf.d/app.conf", who: " tech-a ", why: "x", hours: 72, now, redact: (s) => s.toUpperCase() });
    expect(w).toEqual({
      window_id: windowId("client-a", "linux.nginx", "host-7f1c", "/etc/nginx/conf.d/app.conf", "*", "2026-10-24T11:00:00.000Z"), tenant_id: "client-a", surface: "linux.nginx", host: "host-7f1c",
      object_id: "/etc/nginx/conf.d/app.conf", setting_path: "*", opened_by: "TECH-A", opened_at: "2026-10-24T11:00:00.000Z", until: "2026-10-27T11:00:00.000Z", reason: "X", closed_at: null,
    });
    for (const hours of [0, 73, 1.5, Number.NaN]) expect(() => newWindow({ tenant: "t", surface: "s", host: null, object_id: "o", who: "a", why: "b", hours, now, redact: (s) => s })).toThrow(WindowError);
    expect(() => newWindow({ tenant: "t", surface: "s", host: null, object_id: "o", who: " ", why: "b", hours: 1, now, redact: (s) => s })).toThrow(/^who: /);
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

  it("PRIOR_HOLDS_SQL leaves a window's HOLD out: a window neither starts nor ends a rule's expiry", async () => {
    const engine = await SqlJsEngine.create();
    const base = { tenant_id: "client-a", surface: "linux.nginx", host: "host-7f1c", object_id: "/etc/nginx/conf.d/app.conf", setting_path: "file", value_hash: HASH, finding_id: "fnd-1", run_id: "run-1" };
    const rows: Disposition[] = [
      { ...base, disposition_id: "disp-1", verb: "HOLD", reason: "rule r holds it", expires_at: "2026-10-25T10:00:00.000Z", decided_by: "policy", rule_id: "rule-1", decided_at: "2026-10-24T10:00:00.000Z" },
      { ...base, disposition_id: "disp-2", verb: "HOLD", reason: HELD.reason, expires_at: "2026-10-24T14:00:00.000Z", decided_by: "policy", rule_id: "rule-1", decided_at: "2026-10-24T11:00:00.000Z" },
    ];
    await new MemoryLedger(engine).record(rows);
    const holds = objects(await priorHolds(new DataLayer(engine), { tenant_id: "client-a", decided_at: AT }));
    expect(holds.map((h) => [h.disposition_id, h.expires_at])).toEqual([["disp-1", "2026-10-25T10:00:00.000Z"]]);
    engine.close();
  });
});
