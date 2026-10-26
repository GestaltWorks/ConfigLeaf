// The executive report (src/document/executive.ts, its charts src/document/charts.ts): over sample/bundle.json with the
// committed lessons (src/document/sample.ts sampleExecutive, the path npm run report:executive in sample mode and npm
// run examples take), the committed examples/executive.html is the render byte for byte, and a second render the same;
// the CLI writes the same file. Client-1 over the last 7 days: the header (tenant, period, time UTC), the six KPIs, the
// four charts (titles, both axes named, a legend name and a pattern beside every fill, the data table beneath each),
// the one incident (the proxy_split ESCALATE, ticket #2), the sources and the six DQ rules, the receipts of the newest
// eval results; one style block, no script, no absolute URL, light and dark, A4 print with a page break between
// sections, under the budget. Lab-1: the two incidents with their actions and tickets, the actions by status. The
// redactor over every data string. The period's days, the median and the durations. Offline; nothing is written but a
// temporary file.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { DARK, LIGHT, PRINT_TOKENS } from "../src/design/theme.ts";
import { barChart, niceScale } from "../src/document/charts.ts";
import type { FindingSummary } from "../src/catalogue/select.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { fileRows } from "../src/data/file-rows.ts";
import {
  DQ_READS, EXECUTIVE_MAX_BYTES, FILE_CSS, RECEIPTS_CACHED, classOfFinding, dqRows, duration, evalReceipts, evalScans, executiveSections, median, periodDays, readExecutive, receiptsCached,
  renderExecutive, type Executive,
} from "../src/document/executive.ts";
import { renderDocument } from "../src/document/render.ts";
import { loadSamplePolicy, sampleExecutive, textSha256 } from "../src/document/sample.ts";
import { BUNDLE_REDACTOR } from "../src/explain/explain.ts";
import { CAUSES_SQL } from "../src/explain/explain.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { runPass, shortFindingId } from "../src/pipeline.ts";
import { Redactor } from "../src/redactor.ts";
import { DQ_RULES } from "../src/zetaris/setup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STORE = path.join(ROOT, "examples", "memory");
const TEXT = readFileSync(path.join(ROOT, "sample", "bundle.json"), "utf8");
const FILE = { path: "sample/bundle.json", sha256: textSha256(TEXT) };
/** One sample render: the bundle into sql.js, the pass, the explain step and the reads, 3 to 8 s alone and more in the full parallel run. */
const RENDER_MS = 120_000;

const render = (tenant: string, period: "7d" | "30d" | "all" = "7d") =>
  sampleExecutive(JSON.parse(TEXT) as Record<string, unknown>, { tenant, memory: new TechnicianMemory({ storage: "read", directory: STORE }), source: "sql.js over sample/bundle.json", period, file: FILE });
const sectionOf = (html: string, id: string): string => {
  const m = new RegExp(`<section class="ex-sec" id="${id}">[\\s\\S]*?</section>`).exec(html);
  expect(m, `no section ${id}`).not.toBeNull();
  return m![0];
};
const figureOf = (html: string, id: string): string => new RegExp(`<figure class="ex-chart" id="${id}">[\\s\\S]*?</figure>`).exec(html)![0];
const tiles = (html: string): [string, string, string][] => [...html.matchAll(/<div class="tile"><span class="k">([^<]+)<\/span><span class="v">(.*?)<\/span><p class="s">(.*?)<\/p><\/div>/g)].map((m) => [m[1], m[2], m[3]]);

let c1: { html: string; executive: Executive };
let lab: { html: string; executive: Executive };
beforeAll(async () => {
  [c1, lab] = [await render("client-1"), await render("lab-1")];
}, RENDER_MS);

describe("the executive report over sample/bundle.json", () => {
  it("is examples/executive.html, byte for byte, and a second render gives the same bytes", { timeout: RENDER_MS }, async () => {
    const committed = readFileSync(path.join(ROOT, "examples", "executive.html"), "utf8").replace(/\r\n/g, "\n");
    expect(c1.html, "examples/executive.html is stale: run npm run examples (or SAMPLE_MODE=true npm run report:executive)").toBe(committed);
    expect((await render("client-1")).html).toBe(c1.html);
  });

  // the CLI over the same bundle and store: one sample render in a child process
  it("npm run report:executive in sample mode writes the same file", { timeout: RENDER_MS }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "executive-"));
    try {
      const out = path.join(dir, "executive.html");
      const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/executive.ts", "--out", out], { cwd: ROOT, encoding: "utf8", timeout: RENDER_MS, env: { ...process.env, SAMPLE_MODE: "true", DRIFT_MEMORY_DIR: STORE } });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/^executive: \S+ written for client-1, the last 7 days to 2026-10-25T14:17:53\.416Z \(7 days\), \d+ bytes; 27 drift event\(s\), 1 incident\(s\), 0 action\(s\), coverage 101 of 116 objects; deny-list probe 0 of \d+ label\(s\)\n$/);
      expect(readFileSync(out, "utf8")).toBe(c1.html);
      const bad = spawnSync(process.execPath, ["--import", "tsx", "scripts/executive.ts", "--period", "1y"], { cwd: ROOT, encoding: "utf8", timeout: 60_000, env: { ...process.env, SAMPLE_MODE: "true" } });
      expect([bad.status, bad.stderr.split("\n")[0]]).toEqual([2, "executive: --period is 7d, 30d, all, got 1y"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the header names the tenant, the period and the time UTC; the bar links the incidents, the drift events and the actions", () => {
    expect(c1.html).toContain('<div class="ex-top"><h1>client-1 · executive report</h1>\n<p class="ex-when"><span>the last 7 days</span> <span>19 Oct 2026 to 25 Oct 2026 14:17 UTC</span></p></div>');
    expect(c1.html).toContain('<nav class="sum" aria-label="Summary"><a href="#incidents" class="need"><b>1</b> incident</a> · <a href="#summary"><b>27</b> drift events</a> · <a href="#trend"><b>0</b> actions</a></nav>');
    expect(c1.executive.days).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    expect([...c1.html.matchAll(/<h2>([^<]+)/g)].map((m) => m[1])).toEqual(["At a glance", "Findings and actions", "Probes and approvals", "Incidents of the period", "Sources and DQ gates", "Receipts"]);
  });

  it("six KPIs: settings watched, coverage, copies with a valid restore, drift events, change to detection and actions by status, from the store's rows", () => {
    expect(tiles(sectionOf(c1.html, "summary"))).toEqual([
      ["Settings watched", "1,352", "in 116 objects of the latest passing runs"],
      ["Coverage", "101 <small>of 116</small>", "objects with an approval of record, 87%"],
      ["Copies with a valid restore", "112 <small>of 112</small>", "42 ok · 70 with gaps · 0 fail"],
      ["Drift events", "27", "findings first raised in the period; 27 findings with a decision in it"],
      // the one cause of the period, the proxy_split's, has no time: the audit log holds no event for the record
      ["Change to detection", "-", "none of the period&#39;s 1 cause carries the time of the change"],
      ["Actions", "0", "done 0 · unverified 0 · failed 0 · refused 0 · not judged 0"],
    ]);
    expect(tiles(sectionOf(lab.html, "summary")).map(([k, v, s]) => [k, v, k === "Actions" ? s : ""])).toEqual([
      ["Settings watched", "23", ""], ["Coverage", "4 <small>of 7</small>", ""], ["Copies with a valid restore", "0 <small>of 5</small>", ""], ["Drift events", "4", ""], ["Change to detection", "-", ""],
      ["Actions", "10", "done 3 · unverified 1 · failed 3 · refused 3 · not judged 0"],
    ]);
  });

  it("four charts, each with its title, both axes named, a role and a title for a screen reader, a name and a pattern beside every fill, and its data beneath it", () => {
    const ids = ["ex-findings", "ex-actions", "ex-probes", "ex-approvals"];
    const titles = ["Findings per day by verb", "Actions per day by kind and status", "Failing probes per day", "Approvals over time"];
    ids.forEach((id, i) => {
      const f = figureOf(lab.html, id);
      expect(f).toContain(`<h3 id="${id}-t">${titles[i]}</h3>`);
      expect(f).toContain(`role="img" aria-labelledby="${id}-st ${id}-sd"`);
      expect(f).toContain(`<title id="${id}-st">${titles[i]}</title>`);
      expect(f).toContain('<text class="axl" x="359" y="232" text-anchor="middle">Day (UTC)</text>');
      expect(f).toMatch(/<text class="axl" transform="translate\(14 104\) rotate\(-90\)" text-anchor="middle">[A-Z][a-z ]+<\/text>/);
      expect(f).toMatch(/<ul class="legend">/);
      expect(f).toMatch(/<table class="data">/);
    });
    // the findings by verb: ESCALATE solid, then FIX, ROLLBACK and HOLD each with its own pattern over its fill; the table the same counts
    const findings = figureOf(lab.html, "ex-findings");
    expect([...findings.matchAll(/<li><svg class="sw"[^>]*>(.*?)<\/svg>([A-Z]+)<\/li>/g)].map((m) => [m[2], /fill="url\(#ex-findings-p(\d)\)"/.exec(m[1])?.[1] ?? "solid"])).toEqual([["ESCALATE", "solid"], ["FIX", "1"], ["ROLLBACK", "2"], ["HOLD", "3"]]);
    expect(findings).toContain('<thead><tr><th scope="col">Day (UTC)</th><th scope="col" class="num">ESCALATE</th><th scope="col" class="num">FIX</th><th scope="col" class="num">ROLLBACK</th><th scope="col" class="num">HOLD</th><th scope="col" class="num">Total</th></tr></thead>');
    expect(findings).toContain('<tbody><tr><th scope="row" data-label="Day (UTC)">25 Oct 2026</th><td class="num" data-label="ESCALATE">0</td><td class="num" data-label="FIX">1</td><td class="num" data-label="ROLLBACK">1</td><td class="num" data-label="HOLD">2</td><td class="num" data-label="Total"><b>4</b></td></tr></tbody>');
    expect(findings).toContain('<p class="rest">The other 6 days of the period count 0.</p>');
    // six kinds and statuses: the table one row per day and series, the day's total after them
    const actions = figureOf(lab.html, "ex-actions");
    expect([...actions.matchAll(/<td data-label="Kind and status">([^<]+)<\/td><td class="num" data-label="Actions">(\d+)<\/td>/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
      "rollback of a file, done 1", "rollback of a file, written, not verified 1", "rollback of a file, failed 3", "rollback of a file, refused, nothing written 1", "investigation, done 2", "fix, refused, nothing written 2",
    ]);
    expect(figureOf(c1.html, "ex-actions")).toContain('<p class="rest">Every day of the period counts 0 actions.</p>');
    // the failing names per day by kind beside the names probed; the approvals' line from 0 to 333 settings
    expect(figureOf(c1.html, "ex-probes")).toContain('<tr><th scope="row" data-label="Day (UTC)">25 Oct 2026</th><td class="num" data-label="dns">3</td><td class="num" data-label="http">10</td><td class="num" data-label="tls">7</td><td class="num" data-label="Total"><b>20</b></td><td class="num" data-label="Names probed">111</td></tr>');
    expect(c1.executive.charts.approvals.cumulative).toEqual([0, 0, 0, 0, 0, 333, 333]);
    expect(figureOf(c1.html, "ex-approvals")).toContain('<tr><th scope="row" data-label="Day (UTC)">24 Oct 2026</th><td class="num" data-label="Approvals recorded">333</td><td class="num" data-label="Settings with an approval"><b>333</b></td></tr>');
  });

  it("a chart's fills are the one design's tokens in light and dark: no colour in the markup", () => {
    for (const id of ["ex-findings", "ex-actions", "ex-probes", "ex-approvals"]) expect(figureOf(lab.html, id), id).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\sstyle=/i);
    expect(lab.html).toContain(`:root{${LIGHT};`);
    expect(lab.html).toContain(`@media screen and (prefers-color-scheme:dark){:root{${DARK};`);
    expect(lab.html).toContain(".f-need{fill:var(--need)}");
  });

  it("the incidents: the proxy_split ESCALATE for client-1 with its cause and ticket #2; for lab-1 the rollback and the refused fix with every action and ticket", () => {
    const inc = sectionOf(c1.html, "incidents");
    expect(inc).toContain('<h3><span class="badge v-HOLD">HOLD</span><span class="badge v-ESCALATE">ESCALATE</span>Name and its www treated differently by the proxy</h3>');
    expect(inc).toContain('<p class="where">DNS record host-524b42.quest (proxied) · zone host-4c795e.quest</p>');
    expect(inc).toContain("<dt>Cause</dt><dd>No record of who changed it: the audit log window of 18 h holds 0 events for the record.</dd>");
    expect(inc).toContain("<dt>The agent</dt><dd>The agent changed nothing: an escalation goes to a technician.</dd>");
    expect(inc).toContain('<dt>Ticket</dt><dd>#2 <span class="muted">incident, P1, open</span></dd>');
    expect(lab.executive.incidents.map((i) => [i.verbs.join(" "), i.what, i.where, i.tickets.map((x) => `${x.ref} ${x.text}`).join(", "), i.did.length])).toEqual([
      ["ROLLBACK", "drifted from the approved value", "sites-available/lab.example · host-951abf", "#4 change, P1, closed", 6],
      ["ESCALATE FIX", "drifted from the approved value", "sites-available/www.lab.test · host-951abf", "#3 incident, P1, open", 4],
    ]);
    expect(lab.executive.incidents[0].did.at(-1)).toBe("25 Oct 2026 09:53 UTC: rollback of a file, done, 1 verification probe");
    expect(lab.executive.incidentCount).toBe(2);
  });

  it("the sources with their runs of the period and the gate, then the six DQ rules of the semantic layer over the period", () => {
    const src = sectionOf(c1.html, "sources");
    expect([...src.matchAll(/<th scope="row" data-label="Source"><b>([^<]+)<\/b>/g)].map((m) => m[1])).toEqual(["DNS records", "Provider audit log", "nginx on host-4b4dc1", "nginx on host-aa516a", "Probes from outside"]);
    expect(c1.executive.dq.map((d) => d.rule)).toEqual(DQ_RULES.map((r) => r.name));
    expect(c1.executive.dq.map((d) => [d.rule, d.holds])).toEqual([["run_complete", true], ["copy_validated", true], ["action_verified", true], ["cause_evidenced", true], ["exception_in_force", true], ["dns_inventory_current", null]]);
    expect(src).toContain("61 of 61 collection runs started in the period pass");
    expect(src).toContain("23 of 23 ADOPTs under an accepted exception in the period join a lesson in force");
    // the live rule on sql.js: nothing to read, and the row says why
    expect(src).toContain('<li><span class="dq unread">not read</span> <code>dns_inventory_current</code> <span class="muted">on dns_live</span>: the rule reads the Cloudflare DNS API live through Zetaris, and the recorded bundle holds no live read</li>');
    // lab-1: one write completed with no verification probe, and no copy validated
    expect(lab.executive.dq.map((d) => [d.rule, d.holds])).toEqual([["run_complete", true], ["copy_validated", false], ["action_verified", false], ["cause_evidenced", true], ["exception_in_force", true], ["dns_inventory_current", null]]);
    expect(sectionOf(lab.html, "sources")).toContain("9 of 10 actions of the period hold it");
  });

  it("the receipts: npm run receipts:verify's count over the newest eval results, and Ultra alone beside the checks with Ultra as the falsifier, per run", () => {
    const r = evalReceipts(ROOT)!;
    expect(r).toMatchObject({ dir: "eval/results/2026-10-25T23-34-17Z", set: "dev", calls: 390, signed: 390, receipts: 384, verified: 384, withheld: 6, mismatches: 0 });
    expect(r.headline).toEqual({
      alone: { config: "C4", runs: [{ run: 1, readYes: 6, labelledNo: 9 }, { run: 2, readYes: 5, labelledNo: 9 }, { run: 3, readYes: 6, labelledNo: 9 }] },
      checks: { config: "C3", runs: [{ run: 1, readYes: 0, labelledNo: 9, struck: 9, claims: 10 }, { run: 2, readYes: 0, labelledNo: 9, struck: 8, claims: 10 }, { run: 3, readYes: 0, labelledNo: 9, struck: 8, claims: 10 }] },
    });
    const rec = sectionOf(c1.html, "receipts");
    expect(rec).toContain('<span class="k">Receipts verified</span><span class="v">384 <small>of 384</small></span>');
    expect(rec).toContain("<li><b>6, 5, 6 of 9</b>items labelled no that Ultra alone (C4) reads as yes, runs 1, 2 and 3</li>");
    expect(rec).toContain("<li><b>0, 0, 0 of 9</b>items labelled no that the checks with Ultra as the falsifier (C3) read as yes, runs 1, 2 and 3</li>");
    expect(rec).toContain("<li><b>9, 8, 8 of 10</b>planted false claims struck by C3, runs 1, 2 and 3</li>");
    expect(sectionOf(lab.html, "receipts")).toContain("The actions of lab-1 in the period name 3 receipt ids.");
  });

  it("one file: one style block, no script, no external resource, no absolute URL; print on A4 with the light tokens and a page break between sections; under the budget", () => {
    for (const x of [c1, lab]) {
      expect(x.html.split("<style>").length - 1).toBe(1);
      expect(x.html).not.toMatch(/<script|<link\b|<img\b|<iframe\b|@import|url\(\s*["']?(?:https?:)?\/\/|\son[a-z]+=/i);
      expect(x.html).not.toMatch(/https?:\/\//);
      expect(Buffer.byteLength(x.html)).toBeLessThan(EXECUTIVE_MAX_BYTES);
    }
    expect(c1.html).toContain("@page{size:A4;margin:14mm 12mm}");
    expect(c1.html).toContain(".ex-sec{break-before:page}\n.ex-sec:first-child{break-before:auto}");
    expect(c1.html).toContain(`@media print{\n:root{${PRINT_TOKENS}}`);
    expect(/<footer class="ex-foot">[\s\S]*<\/footer>/.exec(c1.html)![0]).toContain(`Rendered in sample mode from sample/bundle.json (sha256 ${FILE.sha256.slice(7, 19)}).`);
  });

  it("every data string passes the redactor: a raw host name and address in the rows come out as their pseudonyms", () => {
    const RAW_HOST = "tracker.contoso-msp.com";
    const RAW_IP = [10, 11, 12, 13].join(".");
    const redactor = new Redactor("executive-test-salt", []);
    const x: Executive = { ...lab.executive, incidents: lab.executive.incidents.map((i, n) => (n ? i : { ...i, where: `${i.where} · ${RAW_HOST}`, cause: `the origin ${RAW_IP} answered 503 for ${RAW_HOST}` })) };
    for (const html of [executiveSections(x, { redactor }), renderExecutive(x, { redactor })]) {
      expect(html).not.toContain(RAW_HOST);
      expect(html).not.toContain(RAW_IP);
      expect(html).toContain(`the origin ${redactor.text(RAW_IP)} answered 503 for ${redactor.text(RAW_HOST)}`);
    }
  });
});

describe("the review of 67cd782: the reads, the class, the cache, the file and the escaping", () => {
  it("DQ_READS reads every rule of DQ_RULES: a new rule ships with its reading or this fails", () => {
    expect(DQ_RULES.map((r) => r.name).filter((n) => !(n in DQ_READS))).toEqual([]);
    for (const row of c1.executive.dq) expect(row.text, row.rule).not.toBe("the executive report has no reading of this rule");
  });

  it("classOfFinding reads every finding the sample's pass mints back to its class, with the same functions and the tenant's records; an id it cannot read is an error, never a silent null", async () => {
    const bundle = JSON.parse(TEXT) as Record<string, unknown>;
    const engine = await SqlJsEngine.create();
    try {
      engine.loadBundle(bundle);
      loadSamplePolicy(engine, bundle);
      const pass = await runPass(new DataLayer(engine), { world: new DriftWorld("executive-classes"), memory: new TechnicianMemory({ storage: "read", directory: STORE }) });
      const records = (bundle.dns_record as { tenant_id: string; record_id: string }[]);
      expect(pass.findings.length).toBeGreaterThan(20);
      for (const f of pass.findings) {
        const ids = [...new Set(records.filter((r) => r.tenant_id === f.finding.tenant_id).map((r) => r.record_id))];
        expect(classOfFinding({ tenant_id: f.finding.tenant_id, finding_id: f.id, host: f.finding.host, object_id: f.finding.object_id, setting_path: f.finding.setting_path }, ids), f.id).toEqual({ class: f.finding.class });
      }
    } finally {
      engine.close();
    }
    const lost = classOfFinding({ tenant_id: "lab-1", finding_id: "fnd-0000000000000000", host: "host-951abf", object_id: "/etc/x", setting_path: "file" }, ["r1", "r2"]);
    expect(lost).toEqual({ error: "fnd-0000000000000000 is the id of no finding class over its disposition's columns and 2 records of lab-1" });
  });

  it("every read degrades the same way: a read that fails is named at the top, and every part that rests on it reads not read with the reason, never a count of no rows", async () => {
    const bundle = JSON.parse(TEXT) as Record<string, unknown>;
    const engine = await SqlJsEngine.create();
    try {
      engine.loadBundle(bundle);
      loadSamplePolicy(engine, bundle);
      engine.loadFileTables(fileRows({ memoryDir: STORE, policyFile: "policy/hackathon.json", redactor: BUNDLE_REDACTOR }));
      const layer = new DataLayer(engine);
      const memory = new TechnicianMemory({ storage: "read", directory: STORE });
      const at = c1.executive.at;
      const pass = await runPass(layer, { world: new DriftWorld("executive-unread"), memory, ledger: new MemoryLedger(engine), decidedAt: at });
      const classes = new Map(pass.findings.map((f) => [f.id, f.finding.class as string]));
      const doc = await renderDocument(layer, { tenant: "client-1", classes, source: "sql.js over sample/bundle.json", report: true });
      // the dispositions and probes reads fail, the causes read returns more rows than the report reads
      const run = layer.run.bind(layer);
      layer.run = ((sql, params, opts) => {
        if (sql.startsWith("SELECT disposition_id, finding_id")) return Promise.reject(new Error("connection reset\n    at Socket.read"));
        if (sql.startsWith("SELECT kind, target, status, observed_at")) return Promise.reject(new Error("probe table is not there"));
        if (sql === CAUSES_SQL) return run(sql, params, opts).then((r) => ({ ...r, total: r.rowCount + 100_000 }));
        return run(sql, params, opts);
      }) as DataLayer["run"];
      const x = await readExecutive(layer, doc.data, { tenant: "client-1", period: "7d", at, classes });
      // one stack line in the error never reaches the report: the first line only
      expect(x.unread.map((u) => u.read)).toEqual(["dispositions", "probes", "causes"]);
      expect(x.unread.slice(0, 2).map((u) => u.reason)).toEqual(["connection reset", "probe table is not there"]);
      expect(x.unread[2].reason).toMatch(/^the read returned \d+ rows, more than the 100000 the report reads$/);
      const html = renderExecutive(x, { redactor: BUNDLE_REDACTOR });
      expect(html).toContain('<p class="alert" role="alert">3 reads of this report failed, and every part that rests on one reads &quot;not read&quot;: dispositions (connection reset); probes (probe table is not there); causes (the read returned');
      const kpis = tiles(sectionOf(html, "summary"));
      expect(kpis.find(([k]) => k === "Drift events")).toEqual(["Drift events", "not read", "the dispositions read failed: connection reset"]);
      expect(kpis.find(([k]) => k === "Change to detection")![1]).toBe("not read");
      // the parts that rest on reads that held keep their numbers
      expect(kpis.find(([k]) => k === "Coverage")).toEqual(["Coverage", "101 <small>of 116</small>", "objects with an approval of record, 87%"]);
      expect(figureOf(html, "ex-findings")).toContain('<p class="alert">Not read: the dispositions read failed: connection reset.</p>');
      expect(figureOf(html, "ex-probes")).toContain('<p class="alert">Not read: the probes read failed: probe table is not there.</p>');
      expect(figureOf(html, "ex-approvals")).toContain("<table");
      expect(sectionOf(html, "incidents")).toContain('<p class="alert">Not read: the dispositions read failed: connection reset.</p>');
      expect(x.dq.find((d) => d.rule === "cause_evidenced")).toMatchObject({ holds: null });
      expect(html).toContain('<a href="#incidents" class="need">incidents not read</a> · <a href="#summary" class="need">drift events not read</a>');
      expect(html).not.toContain("Socket.read");
    } finally {
      engine.close();
    }
  });

  it("the receipts cache holds at most RECEIPTS_CACHED results bases, the least recently used dropped first", () => {
    const roots = Array.from({ length: RECEIPTS_CACHED + 3 }, () => mkdtempSync(path.join(tmpdir(), "receipts-bound-")));
    try {
      for (const r of roots) expect(evalReceipts(r)).toBeNull();
      expect(receiptsCached()).toBe(RECEIPTS_CACHED);
      // the repository's base read again is read anew once dropped, and then held
      const before = evalScans.count;
      evalReceipts(ROOT);
      evalReceipts(ROOT);
      expect(evalScans.count - before).toBeLessThanOrEqual(1);
      expect(receiptsCached()).toBe(RECEIPTS_CACHED);
    } finally {
      for (const r of roots) rmSync(r, { recursive: true, force: true });
    }
  });

  it("the file's head is one shape: the metas, the title, then one style block that is FILE_CSS and nothing else, which fileCsp hashes", () => {
    for (const x of [c1, lab]) {
      const head = /^<!doctype html>\n<html lang="en">\n<head>\n([\s\S]*?)\n<\/head>\n<body>\n/.exec(x.html);
      expect(head, "the file opens with its head").not.toBeNull();
      expect(head![1]).toBe(`<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="color-scheme" content="light dark">\n<title>${x.executive.tenant} · executive report</title>\n<style>\n${FILE_CSS}\n</style>`);
      expect(x.html.match(/<style\b/g)).toHaveLength(1);
      expect(x.html.match(/<\/style>/g)).toHaveLength(1);
    }
  });

  it("every string a chart shows passes the escape at its call site: a label, a series name and a day with markup come out as text", () => {
    const evil = '<img src=x onerror="alert(1)">&';
    const x: Executive = {
      ...lab.executive,
      charts: {
        ...lab.executive.charts,
        findings: { ...lab.executive.charts.findings, series: lab.executive.charts.findings.series.map((s) => ({ ...s, label: `${s.label} ${evil}` })) },
        actions: { ...lab.executive.charts.actions, series: lab.executive.charts.actions.series.map((s) => ({ ...s, label: evil })) },
        probes: { ...lab.executive.charts.probes, series: [{ key: evil, label: evil, fill: "need" }], values: lab.executive.charts.probes.values.map(() => [1]) },
      },
    };
    const html = executiveSections(x, { redactor: { text: (s) => s } });
    expect(html).not.toContain(evil);
    expect(html).not.toMatch(/<img|onerror="/);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;");
  });
});

describe("the period, the median and the charts' scale", () => {
  it("the last 7 or 30 UTC days ending with the instant's, or every day from the earliest row; a span in its two largest units; the middle of a list", () => {
    expect(periodDays("7d", "2026-10-25T14:17:53.416Z", null)).toEqual({ from: "2026-10-19T00:00:00.000Z", days: ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"] });
    expect(periodDays("30d", "2026-10-25T00:00:00.000Z", null).days).toHaveLength(30);
    expect(periodDays("30d", "2026-03-02T10:00:00.000Z", null).days.slice(0, 2)).toEqual(["2026-02-01", "2026-02-02"]);
    expect(periodDays("all", "2026-10-25T14:17:53.416Z", "2026-10-24T02:00:00.000Z")).toEqual({ from: "2026-10-24T00:00:00.000Z", days: ["2026-10-24", "2026-10-25"] });
    expect(periodDays("all", "2026-10-25T14:17:53.416Z", null).days).toEqual(["2026-10-25"]);
    expect([duration(20_000), duration(42 * 60_000), duration(3 * 3_600_000 + 12 * 60_000), duration(26 * 3_600_000), duration(52 * 3_600_000), duration(72 * 3_600_000)]).toEqual(["under 1 min", "42 min", "3 h 12 min", "26 h", "2 d 4 h", "3 d"]);
    expect([median([]), median([5]), median([9, 1, 5]), median([4, 1, 3, 2])]).toEqual([null, 5, 5, 2.5]);
    expect([niceScale(0), niceScale(4), niceScale(27), niceScale(333), niceScale(10)]).toEqual([{ top: 1, step: 1 }, { top: 4, step: 1 }, { top: 30, step: 10 }, { top: 400, step: 100 }, { top: 10, step: 2 }]);
  });

  it("a disposition's class from its own columns when no pass names it: the class whose finding id is the disposition's, never the reason's words", () => {
    const world = new DriftWorld("executive-test");
    const file = { tenant_id: "lab-1", host: "host-951abf", object_id: "/etc/nginx/sites-available/lab.example", setting_path: "file" };
    const idOf = (cls: string, resource: string | null): string => shortFindingId(world.findingId({ ...file, class: cls as FindingSummary["class"], resource_id: resource }));
    expect(classOfFinding({ ...file, finding_id: idOf("drift_vs_approved", null) })).toEqual({ class: "drift_vs_approved" });
    expect(classOfFinding({ ...file, finding_id: idOf("changed_since_backup", null) })).toEqual({ class: "changed_since_backup" });
    // a record finding names the record as its resource
    const record = { tenant_id: "client-1", host: null, object_id: "b0a17a719bd2118a535a763379ab7ba9", setting_path: "name" };
    expect(classOfFinding({ ...record, finding_id: shortFindingId(world.findingId({ ...record, class: "orphan_record", resource_id: record.object_id })) })).toEqual({ class: "orphan_record" });
    // another tenant's id, or an id of no class, names none: the function takes no reason to fall back on
    expect(classOfFinding({ ...file, tenant_id: "client-1", finding_id: idOf("drift_vs_approved", null) })).toHaveProperty("error");
    expect(classOfFinding({ ...file, finding_id: "fnd-0000000000000000" })).toHaveProperty("error");
    expect(classOfFinding.length).toBe(1);  // the disposition alone, the records optional: no reason to fall back on
  });

  it("the receipts are read once: a second request lists no directory, a new results directory is read at the next", () => {
    const root = mkdtempSync(path.join(tmpdir(), "receipts-"));
    try {
      const newest = evalReceipts(ROOT)!;
      cpSync(path.join(ROOT, newest.dir), path.join(root, newest.dir), { recursive: true });
      const before = evalScans.count;
      const first = evalReceipts(root);
      expect(first).toMatchObject({ dir: newest.dir, verified: newest.verified });
      expect(evalScans.count).toBe(before + 1);
      for (let i = 0; i < 5; i++) expect(evalReceipts(root)).toBe(first);
      expect(evalScans.count).toBe(before + 1);
      // an empty directory the runner is still filling sorts later: it is watched, and read once it holds its files
      const later = path.join(root, "eval", "results", "2099-01-01T00-00-00Z");
      mkdirSync(later);
      expect(evalReceipts(root)).toEqual(first);
      expect(evalScans.count).toBe(before + 2);
      expect(evalReceipts(root)).toEqual(first);
      expect(evalScans.count).toBe(before + 2);
      cpSync(path.join(ROOT, newest.dir), later, { recursive: true });
      expect(evalReceipts(root)).toMatchObject({ dir: "eval/results/2099-01-01T00-00-00Z", verified: newest.verified });
      expect(evalScans.count).toBe(before + 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("one DQ row per rule of the semantic layer, in its order and on its table; a rule the report cannot read says so", () => {
    expect(DQ_RULES.map((r) => r.name)).toEqual(["run_complete", "copy_validated", "action_verified", "cause_evidenced", "exception_in_force", "dns_inventory_current"]);
    const none = { runs: [], copies: { valid: 0, total: 0, ok: 0, gaps: 0, fail: 0, none: 0 }, actions: [], causes: [] };
    const live = dqRows({ ...none, rows: { adoptions: [], unread: {}, dns: { rule: "dns_inventory_current", live: 58, current: 57, runId: "run-1" }, dnsWhy: null } });
    expect(live.map((d) => [d.rule, d.table])).toEqual(DQ_RULES.map((r) => [r.name, r.table]));
    expect(live.at(-1)).toEqual({ rule: "dns_inventory_current", table: "dns_live", text: "57 of 58 records at the provider now match the last complete DNS run by type and proxied flag", holds: false });
    const failed = dqRows({ ...none, rows: { adoptions: null, unread: { adoptions: "no lesson table", dns: "REST table zone_x is not there", causes: "timeout" }, dns: null, dnsWhy: null } });
    expect(failed.slice(-3).map((d) => [d.rule, d.text, d.holds])).toEqual([
      ["cause_evidenced", "the causes read failed: timeout", null], ["exception_in_force", "the adoptions read failed: no lesson table", null], ["dns_inventory_current", "the dns read failed: REST table zone_x is not there", null],
    ]);
    expect(dqRows({ ...none, rows: { adoptions: [], unread: {}, dns: null, dnsWhy: null } }, [{ name: "next_rule", table: "t" }])).toEqual([{ rule: "next_rule", table: "t", text: "the executive report has no reading of this rule", holds: null }]);
  });

  it("a bar chart with no day holds no table and says so", () => {
    const html = barChart({ id: "c", title: "T", caption: "C.", y: "Findings", days: [], series: [], values: [] }, (s) => s);
    expect(html).toContain('<p class="rest">The period holds no day.</p>');
    expect(html).not.toContain("<table");
  });
});
