// The owner's report (src/document/report.ts): one static HTML file rendered from the rows of the owner's document.
// Over sample/bundle.json for client-1 with the committed lessons (src/document/sample.ts, the path npm run sample,
// npm run document in sample mode and npm run examples take): the committed examples/report.html is the render byte
// for byte; the sticky bar's text and its anchors; the four tiles and where each links; the Needs-a-person card of
// the proxy_split ESCALATE, its four lines and its link row (ticket #2 plain, its stored URL pseudonymised; the
// evidence toggle; the rule in the policy file; the replay anchor); What happened with its links; the held table's
// "in n h" and "n h overdue" from the decision instant; the adoptions by lesson; Coverage's first line; the Look
// deeper list, every relative link a file in the repository; the print block's light text tokens; no absolute URL;
// under the size budget. Over test/fixtures/policy-bundle.json with an investigation, a refused fix and two tickets
// added: the FIX card with the explain step's cause, the trace, the rule and the ticket whose URL passes the redactor
// as a link (the other plain); the served models and receipt ids; the redactor over every data string; the partial
// host run failing the gate on the first screen and in Coverage; the live links; the Actions table's cap.
// Offline; nothing is written.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { DataLayer } from "../src/data/layer.ts";
import type { Action, Ticket } from "../src/data/rows.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { renderDocument } from "../src/document/render.ts";
import {
  ACTIONS_SHOWN, REPORT_MAX_BYTES, REPORT_MODE, STACK_LINE, STORY_SHOWN, TICKET_UNLINKED, escapeHtml, renderReport, reportLinks, reportPathOf, tileFacts, untilPhrase,
} from "../src/document/report.ts";
import { renderSample, replayLinks, sampleReport, textSha256, type SampleRender } from "../src/document/sample.ts";
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
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STORE = fileURLToPath(new URL("../examples/memory", import.meta.url));
const SAMPLE_TEXT = readFileSync(new URL("../sample/bundle.json", import.meta.url), "utf8");
const SECTIONS = ["Needs a person", "What happened", "Held with an expiry", "Adopted under the technician's exceptions", "Actions", "Coverage", "Look deeper"];

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const text = (html: string): string => html.replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const hrefs = (html: string): string[] => [...html.matchAll(/\bhref="([^"]*)"/g)].map((m) => m[1]);
const headings = (html: string): string[] => [...html.matchAll(/<h2>(.*?)<\/h2>/g)].map((m) => m[1].replace(/&#39;/g, "'"));
const barOf = (html: string): string => /<nav class="sum" aria-label="Summary">([\s\S]*?)<\/nav>/.exec(html)![1];
/** One tile as the page writes it: where it links, its key, value and sub line. */
const tileOf = (html: string, key: string): { href: string; v: string; s: string } => {
  const m = new RegExp(`<div class="tile[^"]*"><a class="tl" href="([^"]*)"><span class="k">${key}</span><span class="v">(.*?)</span></a><p class="s">(.*?)</p></div>`).exec(html);
  expect(m, `no tile ${key}`).not.toBeNull();
  return { href: m![1], v: m![2], s: m![3] };
};
const sectionOf = (html: string, id: string): string => {
  const m = new RegExp(`<section id="${id}"[^>]*>[\\s\\S]*?</section>`).exec(html);
  expect(m, `no section ${id}`).not.toBeNull();
  return m![0];
};
const cards = (html: string): string[] => [...html.matchAll(/<article class="card"[\s\S]*?<\/article>/g)].map((m) => m[0]);
/** A card's lines before its link row, and the link row. */
const cardParts = (card: string): { lines: string[]; links: string } => {
  const head = card.slice(card.indexOf("<h3>"), card.indexOf('<p class="links">'));
  return { lines: [...head.matchAll(/<(h3|p)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[0]), links: /<p class="links">([\s\S]*?)<\/p>/.exec(card)![1] };
};
const printBlock = (html: string): string => /@media print\{([\s\S]*?)\n\}/.exec(html)![1];
const rowsOf = (section: string): string[] => [...section.matchAll(/<tr[^>]*><td[\s\S]*?<\/tr>/g)].map((m) => m[0]);

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

  it("the sticky bar: what needs a person, what is held and adopted, what changed, each a link to its section; the tenant, the instant and the mode", () => {
    const bar = barOf(s.html);
    expect(text(bar)).toBe("1 needs you · 3 held · 23 adopted · nothing changed");
    expect(hrefs(bar)).toEqual(["#needs", "#held", "#adopted", "#actions"]);
    for (const h of hrefs(bar)) expect(s.html).toContain(`id="${h.slice(1)}"`);
    expect(bar).toContain('<a href="#needs" class="need"><b>1</b> needs you</a>');
    expect(s.html).toContain(`<div class="who"><h1>client-1 · configuration assurance</h1><span>25 Oct 2026 14:17 UTC</span><span>${REPORT_MODE.dryRun}</span></div>`);
    expect(s.r.doc.decidedAt).toBe("2026-10-25T14:17:53.416Z");
    expect(s.html).toMatch(/\.bar\{position:sticky;top:0;/);
    expect(headings(s.html)).toEqual(SECTIONS);
    // the first screen: Needs a person and What happened in the left column, the tiles in the right, before Held
    const first = s.html.slice(s.html.indexOf('<div class="first">'), s.html.indexOf('<section id="held">'));
    expect(first.indexOf('<section id="needs">')).toBeLessThan(first.indexOf('<section id="what-happened">'));
    expect(first.indexOf('<section id="what-happened">')).toBeLessThan(first.indexOf('<aside class="tiles"'));
  });

  it("the four tiles carry the bundle's numbers and link into their sections; sources and settings open Coverage", () => {
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
    const ok = heads.filter((c) => resultOf(c.copy_id) === "ok").length;
    const gaps = heads.filter((c) => resultOf(c.copy_id) === "ok_with_gaps").length;
    const mine = s.r.pass.findings.filter((f) => f.finding.tenant_id === T);
    const verbs = Object.fromEntries((["ADOPT", "HOLD", "ESCALATE", "FIX", "ROLLBACK"] as const).map((v) => [v, mine.filter((f) => f.verb === v).length]).filter(([, n]) => n));
    const open = sample.ticket.filter((x) => x.tenant_id === T && x.status === "open");
    expect([verbs, open.map((x) => x.external_id)]).toEqual([{ ADOPT: 23, HOLD: 3, ESCALATE: 1 }, ["2"]]);
    expect(tileFacts(s.r.doc.data)).toEqual({
      sources: { total: 3, providers: 1, hosts: 2, inventory: false },
      settings: { settings: obs.length, objects },
      copies: { valid, total: heads.length, ok, gaps, fail: 0, none: 0 },
      findings: { total: mine.length, verbs },
      actions: { total: 0, done: 0, refused: 0, unverified: 0, failed: 0, notJudged: 0, planned: null },
      tickets: { open: 1, refs: ["#2"] },
    });
    expect([...s.html.matchAll(/<span class="k">(.*?)<\/span>/g)].map((m) => m[1])).toEqual(["Findings open", "Copies with a valid restore", "Actions this cycle", "Tickets open"]);
    expect(tileOf(s.html, "Findings open")).toEqual({ href: "#needs", v: "27", s: '<a class="v-ESCALATE" href="#needs">ESCALATE 1</a> · <a class="v-HOLD" href="#held">HOLD 3</a> · <a class="v-ADOPT" href="#adopted">ADOPT 23</a>' });
    expect(tileOf(s.html, "Copies with a valid restore")).toEqual({ href: "#validation", v: `${valid} <small>of ${heads.length}</small>`, s: `${ok} ok · ${gaps} with gaps · 0 fail` });
    expect(tileOf(s.html, "Actions this cycle")).toEqual({ href: "#actions", v: "0", s: "done 0 · refused 0 · unverified 0" });
    // the bundle's ticket URL is pseudonymised: the number is plain text
    expect(tileOf(s.html, "Tickets open")).toEqual({ href: "#needs", v: "1", s: `<span class="tk" title="${TICKET_UNLINKED}">#2</span>` });
    for (const id of ["needs", "validation", "actions", "held", "adopted"]) expect(s.html).toContain(`id="${id}"`);
  });

  it("Needs a person: the proxy_split ESCALATE in four lines, then ticket #2, the evidence toggle, the vault copy, the rule and the replay anchor", () => {
    const [card, ...rest] = cards(s.html);
    expect(rest).toEqual([]);
    const f = s.r.pass.findings.find((x) => x.finding.tenant_id === T && x.verb === "ESCALATE")!;
    const cause = s.r.explained.flatMap((e) => e.causes).find((c) => c.cause.tenant_id === T)!.cause.summary;
    expect(card).toMatch(new RegExp(`^<article class="card" id="${f.id}">`));
    const { lines, links } = cardParts(card);
    expect(lines).toEqual([
      '<h3><span class="badge v-ESCALATE">ESCALATE</span>Name and its www treated differently by the proxy</h3>',
      '<p class="where">DNS record host-524b42.quest (proxied) · zone host-4c795e.quest</p>',
      '<p class="when">since 16 Apr 2026 (191 days) · the hold ran out at 25 Oct 03:21 UTC</p>',
      `<p class="cause">${cause}</p>`,
    ]);
    expect(cause).toBe("No record of who changed it: the audit log window of 18 h holds 0 events for the record.");
    const copy = s.r.doc.data.copies.find((c) => c.object_id === s.r.doc.data.open.find((d) => d.verb === "ESCALATE")!.object_id)!;
    expect(links.split("\n")).toEqual([
      `<span>ticket <span class="tk" title="${TICKET_UNLINKED}">#2</span></span>`,
      `<button type="button" class="tog" data-fold="ev-${f.id}" aria-controls="ev-${f.id}" aria-expanded="false">evidence</button>`,
      `<span title="vault commit ${copy.git_commit}, taken 25 Oct 2026 13:53 UTC, validated ${copy.result}">vault copy ${copy.git_commit.slice(0, 8)}</span>`,
      '<span><a href="../policy/hackathon.json#rule-8e75e1d767980665" title="cloudflare.dns * proxied: critical, lock 1, on drift rollback, hold 4 h">rule-8e75e1d767980665</a></span>',
      '<a href="../docs/index.html#proxy-split-1">replay</a>',
    ]);
    // sample mode keeps no trace, so the row names none; the toggle opens the fold: the evidence, what the agent did, the ticket
    expect(links).not.toContain("trace");
    const fold = new RegExp(`<div class="fold" id="ev-${f.id}" hidden>([\\s\\S]*?)</div>`).exec(card)![1];
    expect(fold).toContain(`<li>${escapeHtml(f.finding.summary)}</li>`);
    expect(fold).toContain(`<li>${escapeHtml(f.checks.find((c) => !c.holds)!.explanation)}</li>`);
    expect(fold).toContain("<li>The agent changed nothing: an escalation goes to a technician.</li>");
    expect(fold).toContain(`<li><span class="tk" title="${TICKET_UNLINKED}">#2</span> incident, P1, open</li>`);
    // the replay page carries the finding under that anchor
    expect(replayLinks().replayAnchors[f.id]).toBe("proxy-split-1");
    expect(readFileSync(path.join(ROOT, "docs", "data", "proxy-split.json"), "utf8")).toContain('"id": "proxy-split-1"');
  });

  it("What happened: the cycle's sentences, at most STORY_SHOWN before a fold, each with the card, the ticket, the source or the section it names", () => {
    const story = sectionOf(s.html, "what-happened");
    const shown = /<ul class="stories">([\s\S]*?)<\/ul>/.exec(story)![1];
    expect(shown.split("<li>").length - 1).toBeLessThanOrEqual(STORY_SHOWN);
    const cause = s.r.explained.flatMap((e) => e.causes).find((c) => c.cause.tenant_id === T)!.cause.summary;
    expect(story).toContain(`<li><p class="story">1 finding is with a technician: ${classLabel("proxy_split")} at host-524b42.quest. ${cause}</p> <span class="go"><span class="nw"><a href="#fnd-b4a40091cdb4f906">finding</a></span> · <span class="nw">ticket <span class="tk" title="${TICKET_UNLINKED}">#2</span></span> · <span class="nw"><a href="#src-cloudflare-dns">DNS records</a></span></span></li>`);
    expect(story).toContain('<li><p class="story">23 findings are adopted under the technician&#39;s exceptions; 3 are held with an expiry.</p> <span class="go"><span class="nw"><a href="#adopted">adopted</a></span> · <span class="nw"><a href="#held">held</a></span></span></li>');
    for (const h of hrefs(story)) expect(s.html, h).toContain(`id="${h.slice(1)}"`);
  });

  it("Held: the three orphan records until 27 Oct 23:21 UTC, in 57 h from the decision instant, under the catch-all rule; overdue once the instant passes the expiry", () => {
    const held = sectionOf(s.html, "held");
    const rows = rowsOf(held);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).toContain('<td data-label="Held until"><span class="nw">27 Oct 2026 23:21 UTC</span> <span class="rel">in 57 h</span></td>');
      expect(r).toContain('<td data-label="Reason"><span title="rule rule-b8d9962485c3ced4 (normal) holds this orphan_record finding until 2026-10-27T23:21:06.870Z; held since 2026-10-25T13:54:08.785Z under rule rule-b8d9962485c3ced4">normal rule, holds up to 72 h</span></td>');
      expect(r).toContain('<td data-label="Under"><a href="../policy/hackathon.json#rule-b8d9962485c3ced4"');
      expect(r).toMatch(/<td data-label="Label"><a href="\.\.\/docs\/index\.html#orphans-\d">DNS record with no site behind it<\/a><\/td>/);
    }
    // the same rows at a later instant: 03:30 UTC on 28 Oct is 4 h past 23:21 UTC on 27 Oct
    const later = renderReport({ ...s.r.doc.data, decidedAt: "2026-10-28T03:30:00.000Z" }, { redactor: new Redactor("x", []), mode: REPORT_MODE.dryRun, bundle: { path: "sample/bundle.json", sha256: "sha256:0" } });
    expect(rowsOf(sectionOf(later, "held")).every((r) => r.includes('<span class="rel late">4 h overdue</span>'))).toBe(true);
    expect([untilPhrase("2026-10-27T23:21:06.870Z", "2026-10-25T14:17:53.416Z"), untilPhrase("2026-10-25T14:30:00Z", "2026-10-25T14:17:53Z"), untilPhrase("2026-10-25T14:00:00Z", "2026-10-25T14:17:53Z"), untilPhrase("", "2026-10-25T14:17:53Z")])
      .toEqual(["in 57 h", "in under 1 h", "under 1 h overdue", null]);
  });

  it("Adopted: the 23 under the technician's exceptions with the exception's reason, then a folded table by lesson with each lesson's objects", () => {
    const adopted = sectionOf(s.html, "adopted");
    const mine = s.r.pass.findings.filter((f) => f.finding.tenant_id === T && f.verb === "ADOPT");
    const reasons = [...new Set(mine.map((f) => f.exception!.reason))];
    expect(reasons).toHaveLength(1);
    expect(adopted).toContain(`<p>23 findings are adopted under the technician&#39;s exceptions, each until its exception&#39;s expiry: <q>${escapeHtml(reasons[0])}</q></p>`);
    const lessons = new Map<string, string[]>();
    for (const f of mine) lessons.set(f.exception!.lesson, [...(lessons.get(f.exception!.lesson) ?? []), f.id]);
    expect(adopted).toContain(`<details><summary>The 23 findings by lesson, ${lessons.size} lessons</summary>`);
    const rows = rowsOf(adopted);
    expect(rows).toHaveLength(lessons.size);
    const order = rows.map((r) => /<td data-label="Lesson"><a href="memory\/state\.json">(mem-\d+)<\/a><\/td>/.exec(r)![1]);
    expect(order).toEqual([...lessons.keys()].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4))));
    for (const r of rows) expect(r).toContain('<td data-label="Expires"><span class="nw">30 Nov 2026 00:00 UTC</span></td>');
    // a lesson over two settings of one file names the file once; the wildcard's finding links its replay anchor
    const two = [...lessons].find(([, ids]) => ids.length === 2)!;
    expect(rows[order.indexOf(two[0])]).toMatch(/ \(2 settings\)<\/td><\/tr>$/);
    expect(adopted).toContain('<a href="../docs/index.html#wildcard-no-real-ip-1">nginx/nginx.conf on host-aa516a</a>');
    expect(sectionOf(s.html, "actions")).toContain("No action is recorded for client-1.");
  });

  it("Coverage: sources, settings and queries in its first line, then the latest read of each source, the probes, the copies and the gate line", () => {
    const cov = sectionOf(s.html, "coverage");
    const queries = s.r.doc.data.queries.reduce((n, q) => n + q.runs, 0);
    const settings = tileFacts(s.r.doc.data).settings.settings;
    expect(settings).toBe(1352);
    expect(cov).toContain(`<p class="lead">3 sources read: 1 provider, 2 hosts · 1,352 settings watched · <a href="document.md#queries">${queries} queries</a> through sql.js over sample/bundle.json, 0 failed</p>`);
    const runs = sample.collection_run.filter((r) => r.tenant_id === T);
    const latest = new Map<string, (typeof runs)[number]>();
    for (const r of [...runs].sort((a, b) => cmp(a.started_at, b.started_at))) latest.set(`${r.surface}|${r.host ?? ""}`, r);
    const names: Record<string, string> = { "cloudflare.dns": "DNS records", "cloudflare.audit": "Provider audit log", probe: "Probes from outside" };
    const rows = [...cov.matchAll(/<tr id="(src-[a-z0-9-]+)"><td data-label="Source"><b>(.*?)<\/b>.*?<td data-label="Rows"><span class="nw">(.*?)<\/span><\/td><td data-label="Last read"><span class="nw">(.*?)<\/span><\/td><td data-label="DQ gate">(.*?)<\/td><\/tr>/g)].map((m) => m.slice(1));
    expect(rows).toHaveLength(latest.size);
    const n = (k: number | null): string => (k ?? 0).toLocaleString("en-US");
    for (const r of latest.values()) {
      const name = r.host ? `nginx on ${r.host}` : names[r.surface];
      expect(rows.find((x) => x[1] === name), name).toEqual([expect.stringMatching(/^src-/), name, `${n(r.observed_count)} of ${n(r.expected_count)}`, expect.stringMatching(/^25 Oct 2026 13:5\d UTC$/), '<span class="pass">passes</span>']);
    }
    expect(cov).toContain(`<p class="gate"><span class="pass">Every run passes the DQ gate</span>: ${runs.length} of ${runs.length}.</p>`);
    expect(cov).toContain('<p id="probes"><a href="document.md#probes">Probes</a> at 25 Oct 2026 13:54 UTC: <span class="fail">20 of 111 fail</span> (dns 3, http 10, tls 7); 11 probe runs and 0 verification runs pass the gate.</p>');
    expect(cov).toContain('<p id="validation"><a href="document.md#copies">Copies</a>: 112 at the vault\'s heads, 42 ok, 70 ok with gaps, 0 fail.');
    expect(cov).toContain('<a href="document.md#approvals">333 settings</a> have an approval of record; 0 locked settings have no approved value.');
  });

  it("Look deeper links the document, the replay page, the policy, the traces, the eval summary and the README; every relative link names a file in the repository", () => {
    const deeper = sectionOf(s.html, "deeper");
    const stamp = JSON.parse(readFileSync(path.join(ROOT, "docs", "data", "index.json"), "utf8")).totals.nemotron.stamp as string;
    expect(hrefs(deeper)).toEqual(["document.md", "../docs/index.html", "../policy/hackathon.json", "traces/README.md", `../eval/results/${stamp}/summary.md`, "README.md"]);
    expect(deeper).toContain('<li><span class="muted">The trace</span> <span class="what">none in sample mode: this file keeps no trace</span></li>');
    expect([...deeper.matchAll(/<li>[\s\S]*?<\/li>/g)]).toHaveLength(7);
    // the committed file sits in examples/: each link resolves there, its fragment aside
    for (const h of new Set(hrefs(s.html).filter((x) => !x.startsWith("#")))) expect(existsSync(path.join(ROOT, "examples", h.split("#")[0])), h).toBe(true);
    for (const h of hrefs(s.html).filter((x) => x.startsWith("#"))) expect(s.html, h).toContain(`id="${h.slice(1)}"`);
  });

  it("prints with light tokens, text included, the bar in place and every fold open; one inline script; no absolute URL, nothing loaded from outside; under the budget", () => {
    const print = printBlock(s.html);
    // print: a white page and white cards over the light tokens of :root; the dark ones apply on a screen only, never in print
    for (const token of ["color-scheme:light", "--bg:#fff", "--card:#fff"]) expect(print, token).toContain(token);
    for (const token of ["--fg:#1d1e20", "--muted:#62666d", "--need:#b3361d", "--hold:#835700", "--adopted:#6c7178", "--ok:#2f6b45"]) expect(s.html, token).toContain(token);
    expect(s.html).toContain("@media screen and (prefers-color-scheme:dark){:root{");
    expect(s.html).not.toMatch(/@media \(prefers-color-scheme:dark\)/);
    expect(print).toContain(".bar{position:static}");
    expect(print).toContain(".fold[hidden]{display:block}");
    expect(s.html).toMatch(/@media screen and \(prefers-color-scheme:dark\)\{:root\{--bg:#141517;--fg:#e8e6e1;/);
    // the bundle's only URL, the ticket's, is pseudonymised: the page carries no absolute URL at all
    expect(sample.ticket.filter((x) => x.tenant_id === T).every((x) => /host-[0-9a-f]{6}/.test(x.url ?? ""))).toBe(true);
    expect(s.html).not.toMatch(/https?:\/\//);
    expect(hrefs(s.html).every((h) => !/^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith("//"))).toBe(true);
    expect(s.html).not.toMatch(/<script[^>]+src=|<link\b|<img\b|<iframe\b|@import|url\(/i);
    expect(s.html.split("<script>").length - 1).toBe(1);
    expect(s.html).toContain("<noscript><style>.fold[hidden]{display:block}.tog{display:none}</style></noscript>");
    expect(Buffer.byteLength(s.html)).toBeLessThan(REPORT_MAX_BYTES);
    const foot = /<footer>[\s\S]*<\/footer>/.exec(s.html)![0];
    expect(foot).toContain("<p>Report by ConfigLeaf.</p>");
    // the 16 rules of version 2: the sample loads the shipped file, zetaris.control with them, before its passes
    expect(foot).toContain("Policy policy/hackathon.json, version 2 (16 rules).");
    expect(foot).toContain(`${STACK_LINE}.`);
    expect(foot).toContain(`Rendered in sample mode from sample/bundle.json (sha256 ${textSha256(SAMPLE_TEXT).slice(7, 19)})`);
  });
});

describe("the report over test/fixtures/policy-bundle.json with an investigation, a refused fix and two tickets", () => {
  const SALT = "report-test-salt";
  const RAW_HOST = "tracker.contoso-msp.com";
  const RAW_IP = [10, 11, 12, 13].join(".");
  const PSA = "https://psa.example.com/issues/7";

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
      act("act-report-000002", "fix", "refused", `no fix is allowed without a valid copy; origin ${RAW_IP} answered 503 for ${RAW_HOST}`),
    ]);
    const ticket = (n: string, url: string, status: string): Ticket => ({
      ticket_id: `tkt-report0000000${n}`, tenant_id: A, psa: "github", external_id: n, url, type: "incident", priority: "P1", status,
      action_id: "act-report-000002", finding_id: fix.id, created_at: "2026-10-23T03:06:00.000Z", updated_at: "2026-10-23T03:06:00.000Z",
    });
    engine.insertRows("ticket", [ticket("7", PSA, "open"), ticket("6", `https://${RAW_HOST}/issues/6`, "closed")]);
    const doc = await renderDocument(layer, { tenant: A, classes: new Map(pass.findings.map((f) => [f.id, f.finding.class])), report: true });
    const ctx = { redactor, mode: REPORT_MODE.applied, trace: { id: "report_test", path: "logs/report_test.jsonl" }, tip: "0123456789ab", policyFile: "policy/hackathon.json", findings: pass.findings };
    const html = renderReport(doc.data, ctx);
    engine.close();
    return { pass, explained, fix, disp, doc, html, redactor, ctx };
  }

  it("the FIX card: its cause, the trace, the rule; the ticket whose URL the redactor leaves as it is is a link, the other plain; the fold names the served models and receipt ids", async () => {
    const { explained, fix, disp, html, redactor } = await fixture();
    const card = cards(html).find((c) => c.includes(`id="${fix.id}"`))!;
    expect(card).toBeDefined();
    const cause = explained.causes.find((c) => c.disposition_id === disp)!.cause.summary;
    expect(cause).toMatch(/^No record of who changed it: /);
    const { lines, links } = cardParts(card);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^<h3><span class="badge v-FIX">FIX<\/span>/);
    expect(lines[3]).toBe(`<p class="cause">${escapeHtml(cause)}</p>`);
    expect(links).toContain(`<span>ticket <a href="${PSA}">#7</a>, <span class="tk" title="${TICKET_UNLINKED}">#6</span></span>`);
    expect(links).toContain(`aria-controls="ev-${fix.id}" aria-expanded="false">evidence</button>`);
    expect(links).toContain('<a href="logs/report_test.jsonl">trace</a>');
    expect(links).toContain(`<a href="policy/hackathon.json#${fix.disposition.rule_id}"`);
    // no anchor on the replay page for a live finding: the row names no replay
    expect(links).not.toContain("replay");
    expect(card).toContain("Lightning picked 2 checks · nemotron-3.5-lightning on rcpt_req_report01");
    expect(card).toContain("nemotron-3-ultra-550b-a55b on rcpt_req_report02");
    // neither the raw host nor its pseudonym is a link anywhere
    expect(html).not.toContain(`href="https://${redactor.text(RAW_HOST)}`);
    expect([...html.matchAll(/https?:\/\/[^\s"<>]+/g)].map((m) => m[0])).toEqual(expect.arrayContaining([PSA]));
    expect([...new Set([...html.matchAll(/https?:\/\/[^\s"<>]+/g)].map((m) => m[0]))]).toEqual([PSA]);
    // the Actions table names both calls with their receipts, this cycle's actions marked
    const actions = sectionOf(html, "actions");
    expect(actions).toContain("Lightning nemotron-3.5-lightning on rcpt_req_report01; Ultra nemotron-3-ultra-550b-a55b on rcpt_req_report02");
    expect(actions.split('<span class="tag">this cycle</span>').length - 1).toBe(2);
    expect(tileOf(html, "Actions this cycle")).toEqual({ href: "#actions", v: "2", s: "done 1 · refused 1 · unverified 0" });
    expect(text(barOf(html))).toMatch(/^\d+ needs? you · \d+ held · \d+ adopted · 2 actions · 1 source fails the gate$/);
  });

  it("receipt ids link to the receipts file a caller names; the links default to the live layout beside document.md", async () => {
    const { doc, html, ctx } = await fixture();
    expect(reportLinks(ctx)).toEqual({
      replay: "docs/index.html", replayAnchors: {}, document: "document.md", trace: "logs/report_test.jsonl", policy: "policy/hackathon.json",
      traces: "examples/traces/README.md", eval: "README.md#evaluation", readme: "README.md", lessons: null, receipts: null,
    });
    expect(hrefs(sectionOf(html, "deeper"))).toEqual(["document.md", "logs/report_test.jsonl", "docs/index.html", "policy/hackathon.json", "examples/traces/README.md", "README.md#evaluation", "README.md"]);
    const named = renderReport(doc.data, { ...ctx, links: { receipts: "lab/receipts.json" } });
    expect(sectionOf(named, "actions")).toContain('Lightning nemotron-3.5-lightning on <a href="lab/receipts.json">rcpt_req_report01</a>; Ultra nemotron-3-ultra-550b-a55b on <a href="lab/receipts.json">rcpt_req_report02</a>');
    // an absolute policy path is no link
    expect(reportLinks({ policyFile: "D:\\policy\\x.json", trace: null }).policy).toBeNull();
  });

  it("every data string passes the redactor: a raw host name and a raw address come out as their pseudonyms", async () => {
    const { html, redactor } = await fixture();
    expect(html).not.toContain(RAW_HOST);
    expect(html).not.toContain(RAW_IP);
    expect(redactor.text(RAW_HOST)).toMatch(/^host-[0-9a-f]{6}\.com$/);
    expect(html).toContain(`origin ${redactor.text(RAW_IP)} answered 503 for ${redactor.text(RAW_HOST)}`);
  });

  it("a source whose last read fails the gate shows in the bar, on the first screen and in Coverage; the footer names the tip, the policy and the trace", async () => {
    const { html, doc } = await fixture();
    const partial = doc.data.runs.filter((r) => r.host === "host-2b9e").at(-1)!;
    expect(partial.passes).toBe(false);
    const why = `the run is ${partial.status}, ${partial.observed_count} of ${partial.expected_count} read`;
    expect(barOf(html)).toContain('<a href="#coverage" class="need"><b>1</b> source fails the gate</a>');
    expect(sectionOf(html, "needs")).toContain(`<p class="alert"><b>1 source fails the DQ gate on its last read</b>: nginx on host-2b9e (${why}). <a href="#coverage">Coverage</a></p>`);
    const cov = sectionOf(html, "coverage");
    expect(cov).toContain(`<td data-label="DQ gate"><span class="fail">fails: ${why}</span></td>`);
    const bad = doc.data.runs.filter((r) => !r.passes);
    expect(cov).toContain(`<p class="gate"><span class="fail">${bad.length} of ${doc.data.runs.length} runs fail the DQ gate</span>: `);
    expect(cov).toContain(`nginx on host-2b9e at `);
    expect(html).toContain('<div class="who"><h1>client-a · configuration assurance</h1><span>23 Oct 2026 03:00 UTC</span><span>applied</span></div>');
    const foot = /<footer>[\s\S]*<\/footer>/.exec(html)![0];
    expect(foot).toContain("<p>Report by ConfigLeaf at tip 0123456789ab.</p>");
    expect(foot).toMatch(/<p>Policy policy\/hackathon\.json, version \d+ \(\d+ rules?\)\.<\/p>/);
    expect(foot).toContain("<p>Trace logs/report_test.jsonl.</p>");
  });

  it("the Actions table lists the newest ACTIONS_SHOWN and counts the rest, with the document and the trace for them", async () => {
    const { doc, ctx } = await fixture();
    const base = doc.data.actions![0];
    const many = Array.from({ length: 25 }, (_, i) => ({ ...base, action_id: `act-report-1${String(i).padStart(5, "0")}`, started_at: `2026-10-22T${String(i % 24).padStart(2, "0")}:00:00.000Z`, disposition_id: "disp-elsewhere" }));
    const html = renderReport({ ...doc.data, actions: [...doc.data.actions!, ...many] }, ctx);
    const actions = sectionOf(html, "actions");
    const total = doc.data.actions!.length + many.length;
    expect(rowsOf(actions)).toHaveLength(ACTIONS_SHOWN);
    expect(ACTIONS_SHOWN).toBe(20);
    expect(actions).toContain(`<p class="muted">20 of ${total} actions shown. The <a href="document.md">document</a> counts all of them by kind and status, and the <a href="logs/report_test.jsonl">trace</a> lists this run's.</p>`);
    // newest first: this cycle's two actions of 23 Oct lead
    expect(rowsOf(actions).slice(0, 2).every((r) => r.includes('<span class="tag">this cycle</span>'))).toBe(true);
    expect(actions).toContain(`${total} actions recorded for client-a, newest first; 2 actions on this cycle&#39;s decisions.`);
  });

  it("a tenant with no rows gets a report that says so", async () => {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(policyBundle);
    const doc = await renderDocument(new DataLayer(engine), { tenant: "client-z", report: true });
    const html = renderReport(doc.data, { redactor: new Redactor(SALT, []), mode: REPORT_MODE.dryRun });
    engine.close();
    expect(text(barOf(html))).toBe("0 need you · 0 held · 0 adopted · nothing changed");
    expect(html).toContain('<p class="alert">No collection run of this tenant is on record: nothing is watched.</p>');
    expect(html).toContain("No action is recorded for client-z.");
    expect(html).toContain("No probe run of client-z passes the DQ gate");
    expect(html).toContain("The vault holds no copy for client-z");
    expect(html).toContain('<p class="gate fail">No collection run of client-z is on record.</p>');
    expect(headings(html)).toEqual(SECTIONS);
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
