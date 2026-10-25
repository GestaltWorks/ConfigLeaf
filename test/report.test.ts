// The owner's report (src/document/report.ts): one static HTML file rendered from the rows of the owner's document.
// Over sample/bundle.json for client-1 with the committed lessons (src/document/sample.ts, the path npm run sample,
// npm run document in sample mode and npm run examples take): the committed examples/report.html is the render byte
// for byte; every section heading in order; the six tiles' numbers recomputed here from the bundle's own rows; the
// Needs-a-person card of the proxy_split ESCALATE with its cause and ticket; one Coverage row per source with its rows
// and gate result; no absolute URL but the tickets' own links and nothing loaded from outside; under the size budget.
// Over test/fixtures/policy-bundle.json with an investigation, a refused fix and a ticket added: the FIX card carries
// the explain step's cause, the served models and receipt ids of the investigation and the ticket's link; the
// redactor runs over every data string (a raw host name and a raw address come out as pseudonyms); the partial host
// run fails the gate on the first screen and in Coverage; the footer names the tip, the policy and the trace.
// Offline; nothing is written.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { DataLayer } from "../src/data/layer.ts";
import type { Action } from "../src/data/rows.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { renderDocument } from "../src/document/render.ts";
import { REPORT_MAX_BYTES, REPORT_MODE, STACK_LINE, escapeHtml, renderReport, reportPathOf, tileFacts } from "../src/document/report.ts";
import { renderSample, sampleReport, textSha256, type SampleRender } from "../src/document/sample.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { MemoryCauseSink, explainPass } from "../src/explain/explain.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { dispositionIdOf } from "../src/loop/pass.ts";
import { classLabel } from "../src/loop/present.ts";
import { runPass } from "../src/pipeline.ts";
import { Redactor } from "../src/redactor.ts";
import sample from "../sample/bundle.json" with { type: "json" };
import policyBundle from "./fixtures/policy-bundle.json" with { type: "json" };

const T = "client-1";
const A = "client-a";
const AT = "2026-10-23T03:00:00.000Z";
const STORE = fileURLToPath(new URL("../examples/memory", import.meta.url));
const SAMPLE_TEXT = readFileSync(new URL("../sample/bundle.json", import.meta.url), "utf8");
const SECTIONS = ["What happened", "Needs a person", "Held with an expiry", "Adopted under the technician's exceptions", "Actions", "Coverage, so silence is not green"];

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** One tile's key, value and sub line as the page writes them. */
const tileOf = (html: string, key: string): { v: string; s: string } => {
  const m = new RegExp(`<p class="k">${key}</p><p class="v">(.*?)</p><p class="s">(.*?)</p>`).exec(html);
  expect(m, `no tile ${key}`).not.toBeNull();
  return { v: m![1], s: m![2] };
};
const sectionOf = (html: string, id: string): string => {
  const m = new RegExp(`<section id="${id}"[^>]*>[\\s\\S]*?</section>`).exec(html);
  expect(m, `no section ${id}`).not.toBeNull();
  return m![0];
};
const cards = (html: string): string[] => [...html.matchAll(/<article class="card need-card">[\s\S]*?<\/article>/g)].map((m) => m[0]);

let s: { r: SampleRender; html: string };
beforeAll(async () => {
  const r = await renderSample(JSON.parse(SAMPLE_TEXT) as Record<string, unknown>, { tenant: T, memory: new TechnicianMemory({ storage: "read", directory: STORE }), source: "sql.js over sample/bundle.json" });
  s = { r, html: sampleReport(r.doc, r.pass.findings, { path: "sample/bundle.json", sha256: textSha256(SAMPLE_TEXT) }) };
}, 120_000);

describe("the report over sample/bundle.json for client-1", () => {
  it("is examples/report.html, byte for byte, and a second render gives the same bytes", { timeout: 120_000 }, async () => {
    const committed = readFileSync(new URL("../examples/report.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(s.html, "examples/report.html is stale: run SAMPLE_MODE=true npm run sample (or npm run examples) with DRIFT_MEMORY_DIR=examples/memory").toBe(committed);
    const again = await renderSample(JSON.parse(SAMPLE_TEXT) as Record<string, unknown>, { tenant: T, memory: new TechnicianMemory({ storage: "read", directory: STORE }), source: "sql.js over sample/bundle.json" });
    expect(sampleReport(again.doc, again.pass.findings, { path: "sample/bundle.json", sha256: textSha256(SAMPLE_TEXT) })).toBe(s.html);
    // the page the same render gives is examples/document.md: the report's reads leave the page's Queries as they are
    expect(s.r.doc.markdown).toBe(readFileSync(new URL("../examples/document.md", import.meta.url), "utf8").replace(/\r\n/g, "\n"));
  });

  it("opens with the tenant, the decision instant, the mode and the agent, then every section in order", () => {
    expect(s.html).toContain("<h1>client-1 · configuration assurance</h1>");
    expect(s.html).toContain(`<p class="meta"><span>25 Oct 2026 14:17 UTC</span> · <span>${REPORT_MODE.dryRun}</span> · <span>drift-agent</span> · <span>sample mode, no trace kept with this file</span></p>`);
    expect(s.r.doc.decidedAt).toBe("2026-10-25T14:17:53.416Z");
    expect([...s.html.matchAll(/<h2>(.*?)<\/h2>/g)].map((m) => m[1].replace(/&#39;/g, "'"))).toEqual(SECTIONS);
    // the first screen: what needs a person and the ticket that holds it
    const lede = /<p class="lede">([\s\S]*?)<\/p>/.exec(s.html)![1];
    expect(lede).toContain('<span class="need-lead">1 finding needs a person</span>: ticket <a href="https://host-28ea31.com/word-861e90/drift-tickets/issues/2">#2</a> is open for it.');
    expect(lede).toContain("Of the rest, 23 are adopted and 3 are held, the first until 27 Oct 2026 23:21 UTC.");
  });

  it("the six tiles carry the bundle's numbers", () => {
    const runs = sample.collection_run.filter((r) => r.tenant_id === T);
    const latest = (surface: string, host: string | null) => runs.filter((r) => r.surface === surface && r.host === host).sort((a, b) => cmp(a.started_at, b.started_at)).at(-1)!;
    const read = [latest("cloudflare.dns", null), latest("linux.nginx", "host-4b4dc1"), latest("linux.nginx", "host-aa516a")];
    const obs = sample.observation.filter((o) => read.some((r) => r.run_id === o.run_id));
    const objects = read.reduce((n, r) => n + new Set(obs.filter((o) => o.run_id === r.run_id).map((o) => o.object_id)).size, 0);
    // the copies at each repository's latest commit, each with its latest validation
    const copies = sample.vault_copy.filter((c) => c.tenant_id === T);
    const repo = (c: { surface: string; host: string | null }) => `${c.surface}|${c.host ?? ""}`;
    const heads = copies.filter((c) => !copies.some((x) => repo(x) === repo(c) && x.taken_at > c.taken_at));
    const resultOf = (id: string) => sample.copy_validation.filter((v) => v.copy_id === id).sort((a, b) => cmp(a.validated_at, b.validated_at) || cmp(a.validation_id, b.validation_id)).at(-1)?.result ?? "";
    const valid = heads.filter((c) => ["ok", "ok_with_gaps"].includes(resultOf(c.copy_id))).length;
    const mine = s.r.pass.findings.filter((f) => f.finding.tenant_id === T);
    const verbs = Object.fromEntries((["ADOPT", "HOLD", "ESCALATE", "FIX", "ROLLBACK"] as const).map((v) => [v, mine.filter((f) => f.verb === v).length]).filter(([, n]) => n));
    const open = sample.ticket.filter((x) => x.tenant_id === T && x.status === "open");
    expect([verbs, open.map((x) => x.external_id)]).toEqual([{ ADOPT: 23, HOLD: 3, ESCALATE: 1 }, ["2"]]);
    expect(tileFacts(s.r.doc.data)).toEqual({
      sources: { total: 3, providers: 1, hosts: 2, inventory: false },
      settings: { settings: obs.length, objects },
      copies: { valid, total: heads.length, ok: heads.filter((c) => resultOf(c.copy_id) === "ok").length, gaps: heads.filter((c) => resultOf(c.copy_id) === "ok_with_gaps").length, fail: 0, none: 0 },
      findings: { total: mine.length, verbs },
      actions: { total: 0, done: 0, refused: 0, unverified: 0, failed: 0, notJudged: 0, planned: null },
      tickets: { open: 1, refs: ["#2"] },
    });
    const n = (k: number): string => k.toLocaleString("en-US");
    expect(tileOf(s.html, "Sources read")).toEqual({ v: "3", s: "1 provider, 2 hosts" });
    expect(tileOf(s.html, "Settings watched")).toEqual({ v: n(obs.length), s: `${objects} objects in the latest runs` });
    expect(tileOf(s.html, "Copies with a valid restore").v).toBe(`${valid} <small>of ${heads.length}</small>`);
    expect(tileOf(s.html, "Findings open")).toEqual({ v: "27", s: '<span class="adopted">ADOPT 23</span> · HOLD 3 · <span class="need">ESCALATE 1</span>' });
    expect(tileOf(s.html, "Actions this cycle")).toEqual({ v: "0", s: "done 0 · refused 0 · unverified 0" });
    expect(tileOf(s.html, "Tickets open")).toEqual({ v: "1", s: "#2" });
  });

  it("What happened is the cycle's sentences over the pass, the escalation with its cause", () => {
    const story = sectionOf(s.html, "what-happened");
    const cause = s.r.explained.flatMap((e) => e.causes).find((c) => c.cause.tenant_id === T)!.cause.summary;
    expect(story).toContain(`<p class="story">1 finding is with a technician: ${classLabel("proxy_split")} at host-524b42.quest. ${cause}</p>`);
    expect(story).toContain("<p class=\"story\">23 findings are adopted under the technician&#39;s exceptions; 3 are held with an expiry.</p>");
  });

  it("Needs a person: one card, the proxy_split ESCALATE, with where, since when, its cause, its evidence and ticket #2", () => {
    const [card, ...rest] = cards(s.html);
    expect(rest).toEqual([]);
    const f = s.r.pass.findings.find((x) => x.finding.tenant_id === T && x.verb === "ESCALATE")!;
    expect(card).toContain("<p class=\"state\">Escalated · with a technician</p>");
    expect(card).toContain("<h3>Name and its www treated differently by the proxy</h3>");
    expect(card).toContain("<p class=\"where\">DNS record host-524b42.quest (proxied), zone host-4c795e.quest</p>");
    expect(card).toContain("<dt>In this state since</dt><dd>16 Apr 2026 21:12 UTC, 191 days</dd>");
    expect(card).toContain("<dt>Why it is here</dt><dd>the hold ran out at 25 Oct 03:21 UTC, a technician owns it</dd>");
    expect(card).toContain("<dt>Cause</dt><dd>No record of who changed it: the audit log window of 18 h holds 0 events for the record.</dd>");
    expect(card).toContain(`<li>${escapeHtml(f.finding.summary)}</li>`);
    expect(card).toContain(`<li>${escapeHtml(f.checks.find((c) => !c.holds)!.explanation)}</li>`);
    expect(card).toContain('<dt>Ticket</dt><dd><a href="https://host-28ea31.com/word-861e90/drift-tickets/issues/2">#2</a> <span class="muted">incident, P1, open</span></dd>');
  });

  it("Held and Adopted: the three orphan records until their expiry, the 23 adoptions with the exception's reason", () => {
    const held = sectionOf(s.html, "held");
    expect(held.split("<tr>").length - 1).toBe(4);
    expect(held.split("<td data-label=\"Held until\">27 Oct 2026 23:21 UTC</td>").length - 1).toBe(3);
    const adopted = sectionOf(s.html, "adopted");
    expect(adopted).toContain("<p>23 findings are adopted under the technician&#39;s exceptions, each until the exception's expiry.</p>");
    const reasons = new Set(s.r.pass.findings.filter((f) => f.finding.tenant_id === T && f.exception).map((f) => f.exception!.reason));
    for (const r of reasons) expect(adopted).toContain(`<blockquote>${escapeHtml(r)}</blockquote>`);
    expect(adopted).toContain("<details><summary>The 23 findings</summary>");
    expect(sectionOf(s.html, "actions")).toContain("No action is recorded for client-1.");
  });

  it("Coverage: the latest read of each source with its rows, last read and gate result, the queries, probes and validations", () => {
    const cov = sectionOf(s.html, "coverage");
    const runs = sample.collection_run.filter((r) => r.tenant_id === T);
    const latest = new Map<string, (typeof runs)[number]>();
    for (const r of [...runs].sort((a, b) => cmp(a.started_at, b.started_at))) latest.set(`${r.surface}|${r.host ?? ""}`, r);
    const names: Record<string, string> = { "cloudflare.dns": "DNS records", "cloudflare.audit": "Provider audit log", probe: "Probes from outside" };
    const rows = [...cov.matchAll(/<tr><td data-label="Source">(.*?)<\/td>.*?<td data-label="Rows">(.*?)<\/td><td data-label="Last read">(.*?)<\/td><td data-label="DQ gate">(.*?)<\/td><\/tr>/g)].map((m) => m.slice(1));
    expect(rows).toHaveLength(latest.size);
    for (const r of latest.values()) {
      const name = r.host ? `nginx on ${r.host}` : names[r.surface];
      expect(rows.find((x) => x[0] === name), name).toEqual([name, `${r.observed_count} of ${r.expected_count}`, expect.stringMatching(/^25 Oct 2026 13:5\d UTC$/), '<span class="pass">passes</span>']);
    }
    expect(cov).toContain(`${runs.length} collection runs on record, ${runs.length} passing the DQ gate.`);
    expect(cov).toContain(`The reads behind this page: ${s.r.doc.data.queries.reduce((n, q) => n + q.runs, 0)} queries`);
    expect(cov).toContain("20 probes fail.");
    expect(cov).toContain('<td data-label="Kind">http</td><td data-label="Ok">27</td><td data-label="Failing"><span class="fail">10</span></td>');
    expect(cov).toContain("112 copies at the vault's heads: 42 ok, 70 ok with gaps, 0 fail.");
    expect(cov).toContain("333 settings have an approval of record; 0 locked settings have no approved value.");
  });

  it("the footer names the policy, the stack and the bundle; no absolute URL but the ticket links; nothing loaded from outside; under the budget", () => {
    const foot = /<footer>[\s\S]*<\/footer>/.exec(s.html)![0];
    expect(foot).toContain("Policy policy/hackathon.json, version 2 (15 rules).");
    expect(foot).toContain(`${STACK_LINE}.`);
    expect(foot).toContain(`Rendered in sample mode from sample/bundle.json (sha256 ${textSha256(SAMPLE_TEXT).slice(7, 19)})`);
    const tickets = sample.ticket.filter((x) => x.tenant_id === T).map((x) => x.url);
    const urls = [...s.html.matchAll(/https?:\/\/[^\s"<>]+/g)].map((m) => m[0]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(tickets, u).toContain(u);
    expect([...s.html.matchAll(/\b(?:href|src|action)="([^"]*)"/g)].map((m) => m[1]).every((u) => tickets.includes(u))).toBe(true);
    expect(s.html).not.toMatch(/<script[^>]+src=|<link\b|<img\b|<iframe\b|@import|url\(/i);
    expect(s.html.split("<script>").length - 1).toBe(1);
    expect(s.html).toMatch(/@media \(prefers-color-scheme:dark\)/);
    expect(s.html).toMatch(/@media print/);
    expect(Buffer.byteLength(s.html)).toBeLessThan(REPORT_MAX_BYTES);
  });
});

describe("the report over test/fixtures/policy-bundle.json with an investigation, a refused fix and a ticket", () => {
  const SALT = "report-test-salt";
  const RAW_HOST = "tracker.contoso-msp.com";
  const RAW_IP = [10, 11, 12, 13].join(".");

  async function fixture() {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(policyBundle);
    const layer = new DataLayer(engine);
    const pass = await runPass(layer, { world: new DriftWorld("test_report"), ledger: new MemoryLedger(engine), decidedAt: AT });
    const redactor = new Redactor(SALT, []);
    const explained = await explainPass({ tenant: A, decidedAt: AT, findings: pass.findings }, { layer, vault: null, redactor, sink: new MemoryCauseSink(engine) });
    const fix = pass.findings.find((f) => f.verb === "FIX")!;
    const disp = dispositionIdOf(fix, AT);
    const target = `linux.nginx ${fix.finding.host} ${fix.finding.object_id} file`;
    const record = [
      `finding ${fix.id} (${fix.finding.class}): the live value drifted from the approved one`,
      "Lightning selection (receipt rcpt_req_report01, openrouter/nvidia/nemotron-3.5-lightning, cache miss, route openrouter/nvidia/nemotron-3.5-lightning): 2 valid checks: run_complete, setting_matches_approved",
      "check run_complete (query q-1): holds, 0 rows: the run collected everything it set out to collect.",
      "judge stands (receipt rcpt_req_report02, openrouter/nvidia/nemotron-3-ultra-550b-a55b:free, cache miss, route openrouter/nvidia/nemotron-3-ultra-550b-a55b:free): the refuting SELECT returned no rows, 0 rows",
    ].join("\n");
    const act = (id: string, kind: Action["kind"], status: Action["status"], reason: string, extra: Partial<Action> = {}): Action => ({
      action_id: id, tenant_id: A, kind, target, before_hash: null, after_hash: null, vault_commit: null, verification: "", receipts: "", status, reason, record: "",
      started_at: "2026-10-23T03:05:00.000Z", finished_at: "2026-10-23T03:05:04.000Z", disposition_id: disp, ...extra,
    });
    engine.insertRows("action", [
      act("act-report-000001", "investigate", "done", "investigated: 2 checks ran (2 hold, 0 fail); the judge's verdict counted: stands", { receipts: "rcpt_req_report01,rcpt_req_report02", record, started_at: "2026-10-23T03:04:00.000Z" }),
      act("act-report-000002", "fix", "refused", `no fix is allowed without a valid copy; origin ${RAW_IP} answered 503`),
    ]);
    engine.insertRows("ticket", [{
      ticket_id: "tkt-report00000001", tenant_id: A, psa: "github", external_id: "7", url: `https://${RAW_HOST}/issues/7`, type: "incident", priority: "P1", status: "open",
      action_id: "act-report-000002", finding_id: fix.id, created_at: "2026-10-23T03:06:00.000Z", updated_at: "2026-10-23T03:06:00.000Z",
    }]);
    const doc = await renderDocument(layer, { tenant: A, classes: new Map(pass.findings.map((f) => [f.id, f.finding.class])), report: true });
    const html = renderReport(doc.data, {
      redactor, mode: REPORT_MODE.applied, trace: { id: "report_test", path: "logs/report_test.jsonl" }, tip: "0123456789ab", policyFile: "policy/hackathon.json", findings: pass.findings,
    });
    engine.close();
    return { pass, explained, fix, disp, doc, html, redactor };
  }

  it("the FIX card carries the explain step's cause, the investigation's served models and receipt ids, and the ticket's link", async () => {
    const { explained, fix, disp, html, redactor } = await fixture();
    const card = cards(html).find((c) => c.includes(fix.id))!;
    expect(card).toBeDefined();
    const cause = explained.causes.find((c) => c.disposition_id === disp)!.cause.summary;
    expect(cause).toMatch(/^No record of who changed it: /);
    expect(card).toContain(`<dt>Cause</dt><dd>${escapeHtml(cause)}</dd>`);
    expect(card).toContain("<p class=\"state\">To fix · with a technician</p>");
    expect(card).toContain("Lightning picked 2 checks · nemotron-3.5-lightning on rcpt_req_report01");
    expect(card).toContain("nemotron-3-ultra-550b-a55b on rcpt_req_report02");
    expect(card).toContain(`<a href="https://${redactor.text(RAW_HOST)}/issues/7">#7</a>`);
    // the Actions table names both calls with their receipts, this cycle's actions marked
    const actions = sectionOf(html, "actions");
    expect(actions).toContain("Lightning nemotron-3.5-lightning on rcpt_req_report01; Ultra nemotron-3-ultra-550b-a55b on rcpt_req_report02");
    expect(actions.split('<span class="tag">this cycle</span>').length - 1).toBe(2);
    expect(tileOf(html, "Actions this cycle")).toEqual({ v: "2", s: "done 1 · refused 1 · unverified 0" });
  });

  it("every data string passes the redactor: a raw host name and a raw address come out as their pseudonyms", async () => {
    const { html, redactor } = await fixture();
    expect(html).not.toContain(RAW_HOST);
    expect(html).not.toContain(RAW_IP);
    expect(redactor.text(RAW_HOST)).toMatch(/^host-[0-9a-f]{6}\.com$/);
    expect(html).toContain(redactor.text(RAW_HOST));
    expect(html).toContain(`origin ${redactor.text(RAW_IP)} answered 503`);
  });

  it("a source whose last read fails the gate shows on the first screen and in Coverage; the footer names the tip, the policy and the trace", async () => {
    const { html, doc } = await fixture();
    const partial = doc.data.runs.filter((r) => r.host === "host-2b9e").at(-1)!;
    expect(partial.passes).toBe(false);
    const why = `the run is ${partial.status}, ${partial.observed_count} of ${partial.expected_count} read`;
    expect(/<p class="lede">([\s\S]*?)<\/p>/.exec(html)![1]).toContain(`<span class="need-lead">1 source fails the DQ gate on its last read</span>: nginx on host-2b9e (${why}).`);
    expect(sectionOf(html, "coverage")).toContain(`<td data-label="DQ gate"><span class="fail">fails: ${why}</span></td>`);
    expect(html).toContain("<span>applied</span> · <span>drift-agent</span> · <span>trace report_test</span>");
    const foot = /<footer>[\s\S]*<\/footer>/.exec(html)![0];
    expect(foot).toContain("<p>Tip 0123456789ab.</p>");
    expect(foot).toMatch(/<p>Policy policy\/hackathon\.json, version \d+ \(\d+ rules?\)\.<\/p>/);
    expect(foot).toContain("<p>Trace logs/report_test.jsonl.</p>");
  });

  it("a tenant with no rows gets a report that says so", async () => {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(policyBundle);
    const doc = await renderDocument(new DataLayer(engine), { tenant: "client-z", report: true });
    const html = renderReport(doc.data, { redactor: new Redactor(SALT, []), mode: REPORT_MODE.dryRun });
    engine.close();
    expect(html).toContain('<span class="ok-lead">Nothing needs a person.</span>');
    expect(html).toContain("No collection run of this tenant is on record.");
    expect(html).toContain("No action is recorded for client-z.");
    expect(html).toContain("No probe run of client-z passes the DQ gate");
    expect(html).toContain("The vault holds no copy for client-z");
    expect([...html.matchAll(/<h2>(.*?)<\/h2>/g)].map((m) => m[1].replace(/&#39;/g, "'"))).toEqual(SECTIONS);
  });
});

describe("reportPathOf", () => {
  it("puts report.html beside the document, keeping a suffix the document's name carries", () => {
    expect(reportPathOf("document.md")).toBe("report.html");
    expect(reportPathOf("/repo/examples/document.md")).toBe("/repo/examples/report.html");
    expect(reportPathOf("D:\\repo\\logs\\document-lab-1.md")).toBe("D:\\repo\\logs\\report-lab-1.html");
    expect(reportPathOf("logs/owner.md")).toBe("logs/owner.html");
  });
});
