// The replay page (scripts/build-site.ts): built from the three committed examples into a throwaway
// directory, it holds index.html and one data file per example; every check carries the SQL that ran,
// rendered, non-empty and re-run to the recorded count, and with it the text a live pass sends to Zetaris (the same
// SQL, each table read as its drift_usl entity), which the lede, the Sources tab and the footer name; the output passes the
// deny-list scan; a finding that cites a template the catalogue cannot render, or a count the re-run does not give, makes the build
// throw and write nothing; the page carries the owner's document (Document) and "Where each answer comes from"
// (Sources) as HTML the build renders from their markdown, escaped outside its subset; the Nemotron tab carries the
// eval results' calls, whose total is the run files' and summary.md's, and every judge SELECT recorded with a row count,
// re-run equal or counted apart as recorded text that does not run, and a results copy with one recorded count moved
// by one makes the build throw and write nothing; the header links the owner's report (../examples/report.html), a
// fixed relative link outside the tab row; the header counts each finding once by its finding id, beside the rows the
// slices list (a fixture holds one finding in two slices), and each slice keeps its own counts; above the counts a tile
// sets Ultra alone (C4) beside the checks with Ultra as the falsifier (C3), per run, from the run files and planted.json,
// under a caption naming the results directory and the runs' span; a second build is byte-identical;
// and the committed docs/ is exactly this build (rerun `npm run site` when not).
//
// The landing page, docs/site.html, comes out of the same build from scripts/site/landing.html: every token filled and
// none left, and no digit in the template's own text; no script and no URL outside the repository but its repository
// link; the README's track, first three sentences, eight places, opening bullets, policy and own words for each act, as
// written; the estate tiles and the decision bar from the owner's document; Ultra alone beside the checks with Ultra as
// the falsifier, each figure and row of dots its run's; the semantic layer as src/zetaris/setup.ts holds it; trace lines
// the replay page's redactor leaves as they are, each a line of the committed trace its caption names; the rings, the
// eval line and the receipts lines npm run receipts:verify prints; each quoted file's hash; and the page within the byte budget.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildSite, DECK_URL, escapeHtml, EXECUTIVE_LINK, formatTraceLine, headerStats, headlineTile, markdownToHtml, MAX_BYTES, nemotronView, newestResults, readTrace, renderSiteHtml, REPORT_LINK, repositoryUrl, SAMPLE_COMMAND, scanOutput, SITE_TEMPLATE, SiteError, word, type BuildResult, type ExampleView, type JudgeSelectView, type SiteInput,
} from "../scripts/build-site.ts";
import { templateById } from "../src/catalogue/templates.ts";
import { config } from "../src/config.ts";
import { FILE_DATASOURCES } from "../src/data/files.ts";
import { DataLayer, LAYER_TABLES } from "../src/data/layer.ts";
import { ZetarisEngine } from "../src/data/engines/zetaris.ts";
import { fileSourceRows, sourceRows, sourcesMarkdown } from "../src/document/render.ts";
import { VERBS } from "../src/pipeline.ts";
import { Redactor } from "../src/redactor.ts";
import { DQ_RULES, NAMESPACE, REST_DB, USL, USL_NAME, USL_TABLES, uslRelation } from "../src/zetaris/setup.ts";
import { MARK } from "../src/design/theme.ts";

/** Zetaris's text with each relation it reads a table as put back as the table's name: the text sql.js runs. */
function asTables(sql: string): string {
  let s = sql;
  for (const t of LAYER_TABLES) {
    for (const fence of [true, false]) {
      const rel = uslRelation(t, { fence })!;
      s = rel.startsWith("(") ? s.split(`${rel} ${t}`).join(t).split(rel).join(t) : s.replace(new RegExp(`${rel.replaceAll(".", "\\.")}(?!\\w)`, "g"), t);
    }
  }
  return s;
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLES = path.join(ROOT, "examples");
/** The committed technician's lessons the committed examples and docs/ were built with (DRIFT_MEMORY_DIR=examples/memory). */
const STORE = path.join(EXAMPLES, "memory");
const tmp = mkdtempSync(path.join(os.tmpdir(), "drift-site-"));
const WORDS = [...new Set([...config.redactWords, ...config.exportDenyWords])];
/** ZETARIS_DATASOURCE: DRIFT, the default and .env.example's. */
const DS = config.zetaris.datasource;
/**
 * The two development runs of 25 Oct 2026, the values the Nemotron tab's tests hold to whichever stamp is newest: the
 * run under Nightshift's shared memory scope (09:25 UTC) and the run under per-call scope (23:34 UTC).
 */
const DEV = path.join(ROOT, "eval", "results", "2026-10-25T09-25-44Z");
const ISOLATED = path.join(ROOT, "eval", "results", "2026-10-25T23-34-17Z");
/** Element text as the Nemotron tab writes it: &, < and > escaped. */
const text = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let built: BuildResult;
const example = (dir: string): ExampleView => JSON.parse(built.files.get(`data/${dir}.json`)!) as ExampleView;
/** One tab's static HTML in the page: its section, whole. */
function panel(id: string): string {
  const m = new RegExp(`<section class="panel" id="${id}">[\\s\\S]*?</section>`).exec(built.files.get("index.html")!);
  expect(m, `the page has no ${id} tab`).not.toBeNull();
  return m![0];
}
const count = (s: string, tag: string): number => s.split(tag).length - 1;
/** Every judge record of the Nemotron tab: the planted claims', then the item judges'. */
const judgesOf = (v: BuildResult["nemotron"]): JudgeSelectView[] => [...v.claims.flatMap((c) => c.judges), ...v.items];
/** The calls column of summary.md's "Counts per configuration and run" table, summed over its rows. */
function summaryCalls(dir: string): number {
  const md = readFileSync(path.join(dir, "summary.md"), "utf8").replace(/\r\n/g, "\n");
  const rows = md.split("## Counts per configuration and run")[1].split("\n## ")[0].split("\n").filter((l) => l.startsWith("|"));
  const cells = (l: string): string[] => l.split("|").map((c) => c.trim());
  const at = cells(rows[0]).indexOf("calls");
  expect(at).toBeGreaterThan(0);
  return rows.slice(2).reduce((n, l) => n + Number(cells(l)[at]), 0);
}

beforeAll(async () => {
  built = await buildSite({ examplesDir: EXAMPLES, outDir: path.join(tmp, "out"), memoryDir: STORE });
}, 120_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A copy of one committed example whose findings.json is changed by `edit`. */
function brokenExamples(name: string, edit: (findings: Record<string, any>[]) => void): string {
  const dir = path.join(tmp, name);
  cpSync(path.join(EXAMPLES, "proxy-split"), path.join(dir, "proxy-split"), { recursive: true });
  const file = path.join(dir, "proxy-split", "findings.json");
  const findings = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>[];
  edit(findings);
  writeFileSync(file, `${JSON.stringify(findings, null, 2)}\n`);
  return dir;
}

describe("the replay page", () => {
  it("builds the three examples into index.html, site.html, .nojekyll and one data file each, written to the output directory", () => {
    expect([...built.files.keys()].sort()).toEqual([".nojekyll", "data/index.json", "data/orphans.json", "data/proxy-split.json", "data/wildcard-no-real-ip.json", "index.html", "site.html"]);
    for (const name of built.files.keys()) expect(existsSync(path.join(tmp, "out", name))).toBe(true);
    expect(built.index.examples.map((e) => [e.dir, e.findings])).toEqual([["proxy-split", 1], ["wildcard-no-real-ip", 1], ["orphans", 7]]);
    // an exception in force gives ADOPT until its expiry: the wildcard and the three orphan vhosts the operator's lessons
    // scope are ADOPT; the three orphan records stay HOLD and the proxy_split ESCALATE, by policy. The proxy_split sits in
    // two slices: 8 findings by finding id, 9 rows over the 3 slices
    expect(built.index.totals).toMatchObject({
      examples: 3, findings: 8, rows: 9, verbs: { ADOPT: 4, HOLD: 3, ESCALATE: 1 },
      classes: { proxy_split: 1, proxied_without_real_ip: 1, orphan_record: 3, orphan_vhost: 3 }, judgeModels: { none: 8 },
    });
    expect(built.index.sample?.verbs).toEqual({ ADOPT: 23, HOLD: 3, ESCALATE: 1 });
    expect(built.index.examples.every((e) => e.reproduced)).toBe(true);
  });

  it("names the product ConfigLeaf in the title, the description and the heading", () => {
    const html = built.files.get("index.html")!;
    expect(built.index.title).toBe("ConfigLeaf replay");
    expect(html).toContain("<title>ConfigLeaf replay</title>");
    expect(html).toContain('content="Every finding of the ConfigLeaf pass over recorded, redacted real collections');
    expect(html).toContain("<h1>ConfigLeaf: every finding, with the SQL behind it</h1>");
  });

  it("every check carries its rendered SQL, non-empty with no placeholder left, re-run over the slice to the recorded count and verdict", () => {
    let checks = 0;
    for (const e of built.index.examples) {
      for (const f of example(e.dir).findings) {
        expect(f.checks.length).toBeGreaterThan(0);
        for (const c of f.checks) {
          checks++;
          expect(c.sql.trim().length).toBeGreaterThan(0);
          expect(c.sql).toMatch(/^SELECT\b/);
          expect(c.sql).not.toMatch(/\{\{|\}\}/);
          expect(c.sqlSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
          expect(c.status).toBe("ran");
          expect(c.rerun).toEqual({ rowCount: c.rowCount, holds: c.holds });
          expect(c.rows?.total).toBe(c.rowCount);
        }
        expect(f.detection?.sql).toMatch(/^SELECT\b/);
        expect(f.detection?.matched.total).toBeGreaterThan(0);
        expect(f.judge).toMatchObject({ status: "skipped", model: "none" });
        expect(f.judge.detail).toContain("Nemotron runs in the Actor's investigation and in the eval; the Nemotron tab re-runs every SELECT its judge wrote there.");
      }
    }
    // proxy-split 4, wildcard-no-real-ip 4 (its slice carries the audit run, so the two audit checks run and fail instead of being withheld), orphans 25
    expect(checks).toBe(33);
    expect(built.index.totals.checksRerun).toBe(checks);
  });

  it("every detector query and check carries the text the live pass sends to Zetaris: the shown SQL with each table read as its drift_usl entity", () => {
    const zetaris = new DataLayer(new ZetarisEngine());
    let queries = 0;
    for (const e of built.index.examples) {
      for (const f of example(e.dir).findings) {
        for (const q of [f.detection!, ...f.checks]) {
          queries++;
          expect(q.zetarisSql).toContain(`FROM ${USL}.`);
          expect(q.zetarisSql).not.toContain(`${DS}.`);
          expect(asTables(q.zetarisSql)).toBe(q.sql);
        }
        for (const c of f.checks) {
          const t = templateById(c.template)!;
          expect(c.zetarisSql).toBe(zetaris.render(t.sql, c.params));
          // one entity per {{t:table}} of the template
          expect(c.zetarisSql.split(`${USL}.`).length - 1).toBe([...t.sql.matchAll(/\{\{t:\w+\}\}/g)].length);
        }
        expect(f.judge).not.toHaveProperty("zetarisSql");
      }
    }
    expect(queries).toBe(9 + 33);
  });

  it("names Zetaris where the page opens, in the Sources tab and in the footer: the datasource, the semantic layer and its DQ rules, the parity test", () => {
    const html = built.files.get("index.html")!;
    const lede = /<p class="lede">([\s\S]*?)<\/p>/.exec(html)![1];
    for (const s of ["Zetaris Lightning SQL", `<code>${DS}</code> datasource`, "beside the technician's memory store, the policy file and the Cloudflare DNS API, which it reads live", `<code>${USL_NAME}</code> semantic layer`, "six DQ rules over the four", "<code>test/parity.test.ts</code>"]) expect(lede).toContain(s);
    const src = panel("sources");
    expect(src).toContain(`Zetaris Lightning SQL over the <code>${USL_NAME}</code> semantic layer, each table read as the entity built from it, <code>${NAMESPACE}.${USL_NAME}.&lt;entity&gt;</code>, over the <code>${DS}</code> datasource`);
    expect(src).toContain(`Beside it Zetaris reads the technician's memory store as <code>LESSONS</code> and the policy file as <code>RULES</code>, both files in its filestore, and the Cloudflare DNS API as <code>${REST_DB}</code>, a REST datasource it fetches at each query.`);
    expect(src).toContain(`holds ${word(USL_TABLES.length)} entities (${USL_TABLES.map((t) => `<code>${t}</code>`).join(", ")})`);
    expect(src).toContain(`six DQ rules (${DQ_RULES.map((r) => `<code>${r.name}</code> on <code>${r.table}</code>`).join(", ")})`);
    expect(/<footer>[\s\S]*?<\/footer>/.exec(html)![0]).toContain(`each table read as its Zetaris semantic-layer entity (<code>${NAMESPACE}.${USL_NAME}.&lt;entity&gt;</code>) as the text a live pass sends`);
    expect(html).not.toContain(`${DS}.&lt;table&gt;`);
    expect(html).toContain('"as the live pass sends it to Zetaris"');
  });

  it("shows the real 16 April record: proxy_split, ESCALATE once its HOLD under the policy expired, referent_unchanged fails on its three pieces of evidence, exposed since the 21:12:47 proxied=true body, 191 days", () => {
    const [f] = example("proxy-split").findings;
    expect([f.class, f.verb]).toEqual(["proxy_split", "ESCALATE"]);
    const ru = f.checks.find((c) => c.template === "referent_unchanged")!;
    expect([ru.holds, ru.rowCount, ru.rows?.rows.length]).toEqual([false, 3, 3]);
    expect(ru.sql).toContain("FROM dns_record a");
    expect(f.sample?.match).toBe("same");
    // the slice's DNS run is the latest DNS collection of the recorded bundle (25 Oct 2026, 13:53 UTC), 191 whole days after the body
    const slice = JSON.parse(readFileSync(path.join(EXAMPLES, "proxy-split", "bundle.json"), "utf8")) as { collection_run: { run_id: string; surface: string; started_at: string }[] };
    const dnsRun = slice.collection_run.filter((r) => r.surface === "cloudflare.dns").sort((a, b) => (a.started_at < b.started_at ? -1 : 1)).at(-1)!.run_id;
    expect(f.exposure).toEqual({ since: "2026-04-16T21:12:47.270Z", days: 191, bound: "exact", source: "audit:evt-05fa48325110cdcb", still_open_in: dnsRun });
    expect(f.fields.find((p) => p[0] === "finding id")?.[1]).toMatch(/^fnd-[0-9a-f]{16}$/);
  });

  it("every example finding is the same finding in the full sample pass, verb and check verdicts alike", () => {
    for (const e of built.index.examples) for (const f of example(e.dir).findings) expect(f.sample?.match, `${f.id}: ${f.sample?.detail}`).toBe("same");
  });

  it("is one file with inline CSS and script: no framework, no CDN, no external font, nothing fetched but data/", () => {
    const html = built.files.get("index.html")!;
    expect(html).toMatch(/<style>[\s\S]+<\/style>/);
    expect(html).toMatch(/<script>[\s\S]+<\/script>/);
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|<img|<iframe|@import|url\(/i);
    // the script and the styles name no host but localhost (the file:// hint); the document's ticket url is text in a list item
    const code = [...html.matchAll(/<(script|style)>([\s\S]*?)<\/\1>/g)].map((m) => m[2]).join("\n");
    expect(code).not.toMatch(/https?:\/\/(?!localhost)/);
    // the tile's caption and the header's two Nemotron counts link to the tab, then the Report and Executive report
    // links to the two reports in the repository, then the four tabs: one link to each report, no second nav
    expect([...html.matchAll(/\b(?:href|src|action)="([^"]*)"/g)].map((m) => m[1])).toEqual(["#nemotron", "#nemotron", "#nemotron", REPORT_LINK, EXECUTIVE_LINK, "#findings", "#document", "#sources", "#nemotron"]);
    expect([...html.matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['"data/index.json"', "e.file"]);
  });

  it("links the owner's report from the header, ../examples/report.html with one line saying what it is, outside the tab row the script drives", () => {
    const html = built.files.get("index.html")!;
    const header = /<header>[\s\S]*?<\/header>/.exec(html)![0];
    expect(REPORT_LINK).toBe("../examples/report.html");
    expect(existsSync(path.join(ROOT, "docs", REPORT_LINK))).toBe(true);
    expect(header).toContain(`<p class="report"><a href="${REPORT_LINK}">Report</a><br><span class="meta">The owner's report, <code>examples/report.html</code>: one HTML file over the same recorded bundle as the Document tab, opened from a clone of the repository.</span></p>`);
    // the executive report beside it, examples/executive.html, the same way
    expect(EXECUTIVE_LINK).toBe("../examples/executive.html");
    expect(existsSync(path.join(ROOT, "docs", EXECUTIVE_LINK))).toBe(true);
    expect(header).toContain(`<p class="report"><a href="${EXECUTIVE_LINK}">Executive report</a><br><span class="meta">The executive report, <code>examples/executive.html</code>: `);
    const nav = /<nav class="tabs"[\s\S]*?<\/nav>/.exec(header)![0];
    expect(nav).not.toContain(REPORT_LINK);
    expect(nav).not.toContain(EXECUTIVE_LINK);
    // the one design's leaf mark beside the heading; the tabs are the page's one nav
    expect(header).toContain(`<div class="brand">${MARK}<h1>ConfigLeaf: every finding, with the SQL behind it</h1></div>`);
    expect(html.match(/<nav\b[^>]*>/g)).toEqual(['<nav class="tabs" aria-label="Page sections">']);
  });

  it("the page's style block reads one set of tokens, the theme's, and sets no selector twice outside its media blocks", () => {
    const css = /<style>([\s\S]*?)<\/style>/.exec(built.files.get("index.html")!)![1];
    expect(css).not.toMatch(/var\(--(?:code|chip|bad|bad-bg|warn|warn-bg|accent)\)/);
    expect(css).not.toMatch(/--(?:code|chip|bad|warn|accent):/);
    const top = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    const count = new Map<string, number>();
    for (const m of top.matchAll(/([^{}]+)\{[^{}]*\}/g)) for (const sel of m[1].split(",").map((x) => x.trim()).filter(Boolean)) count.set(sel, (count.get(sel) ?? 0) + 1);
    expect([...count].filter(([, n]) => n > 1)).toEqual([]);
  });

  it("the header counts each finding once by its finding id, beside the 9 rows over 3 slices, as static HTML; each slice keeps its own counts", () => {
    const html = built.files.get("index.html")!;
    const header = /<header>[\s\S]*?<\/header>/.exec(html)![0];
    const stats = /<ul class="stats" id="stats">[\s\S]*?<\/ul>/.exec(header)![0];
    const t = built.index.totals.nemotron;
    expect(stats.split("\n").slice(1, 5)).toEqual([
      "<li><b>8</b>findings, 9 rows over 3 slices</li>",
      "<li><b>1 ESCALATE, 4 ADOPT, 3 HOLD</b>verbs</li>",
      "<li><b>33 / 33</b>checks re-run over the slices at build, counts equal</li>",
      "<li><b>4</b>finding classes</li>",
    ]);
    expect(stats).toBe(headerStats(built.index.totals));
    expect(stats).toContain(`Nemotron calls in eval ${t.stamp}`);
    expect(header).not.toMatch(/\b9 findings\b|\b2 ESCALATE\b/);
    // the slice view: the proxy_split finding in the proxy-split slice and again in the orphans slice, each slice's own counts as before
    const id = (dir: string): string[] => example(dir).findings.map((f) => f.fields.find(([k]) => k === "finding id")![1]!);
    expect(id("orphans")).toContain(id("proxy-split")[0]);
    expect(example("proxy-split")).toMatchObject({ verbs: { ESCALATE: 1 }, classes: { proxy_split: 1 } });
    expect(example("orphans")).toMatchObject({ verbs: { ESCALATE: 1, HOLD: 3, ADOPT: 3 }, classes: { proxy_split: 1, orphan_record: 3, orphan_vhost: 3 } });
    expect(built.index.examples.reduce((n, e) => n + e.findings, 0)).toBe(built.index.totals.rows);
    // the Findings tab's filter line counts rows over the slices
    expect(html).toContain('n + " of " + plural(all, "row") + " over " + plural(slices.length, "slice") + " shown"');
  });

  it("one finding in two slices counts once in the header and once in each slice; read with two verbs it counts under each", async () => {
    const dir = path.join(tmp, "two-slices");
    for (const d of ["proxy-split", "proxy-split-again"]) cpSync(path.join(EXAMPLES, "proxy-split"), path.join(dir, d), { recursive: true });
    const twice = await buildSite({ examplesDir: dir, outDir: path.join(tmp, "two-slices-out"), samplePath: null, memoryDir: STORE });
    expect(twice.index.examples.map((e) => [e.dir, e.findings])).toEqual([["proxy-split", 1], ["proxy-split-again", 1]]);
    expect(twice.index.totals).toMatchObject({ examples: 2, findings: 1, rows: 2, checks: 8, verbs: { ESCALATE: 1 }, classes: { proxy_split: 1 }, judgeModels: { none: 1 } });
    for (const d of ["proxy-split", "proxy-split-again"]) expect(JSON.parse(twice.files.get(`data/${d}.json`)!)).toMatchObject({ verbs: { ESCALATE: 1 }, classes: { proxy_split: 1 } });
    const html = twice.files.get("index.html")!;
    expect(html).toContain("<li><b>1</b>finding, 2 rows over 2 slices</li>");
    expect(html).toContain("<li><b>1 ESCALATE</b>verbs</li>");

    // the second slice's record read as ADOPT (stale, published with --allow-stale): one finding, counted under each verb
    const file = path.join(dir, "proxy-split-again", "findings.json");
    const findings = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>[];
    findings[0].verb = "ADOPT";
    writeFileSync(file, `${JSON.stringify(findings, null, 2)}\n`);
    const two = await buildSite({ examplesDir: dir, write: false, samplePath: null, memoryDir: STORE, allowStale: true });
    expect(two.index.totals).toMatchObject({ findings: 1, rows: 2, verbs: { ESCALATE: 1, ADOPT: 1 }, classes: { proxy_split: 1 } });
  }, 120_000);

  it("opens with the tile, above the counts and the tabs: Ultra alone (C4) beside the checks with Ultra as the falsifier (C3), per run, over the run under per-call scope, 25 to 26 Oct 2026", async () => {
    const v = built.nemotron.totals.stamp === path.basename(ISOLATED) ? built.nemotron : await nemotronView(ISOLATED);
    // the numbers as the run files and planted.json hold them
    const counts = (c: string, r: number): { false_positives: number; labelled_no: number } =>
      (JSON.parse(readFileSync(path.join(ISOLATED, `${c}-run${r}.json`), "utf8")) as { counts: { false_positives: number; labelled_no: number } }).counts;
    const planted = (JSON.parse(readFileSync(path.join(ISOLATED, "planted.json"), "utf8")) as { claims: { config: string; run: number; struck: boolean }[] }).claims;
    for (const r of [1, 2, 3]) {
      expect(v.headline!.alone.runs[r - 1]).toEqual({ run: r, valid: true, readYes: counts("C4", r).false_positives, labelledNo: counts("C4", r).labelled_no });
      const p = planted.filter((c) => c.config === "C3" && c.run === r);
      expect(v.headline!.checks.runs[r - 1]).toEqual({ run: r, valid: true, readYes: counts("C3", r).false_positives, labelledNo: counts("C3", r).labelled_no, struck: p.filter((c) => c.struck).length, claims: p.length });
    }
    expect(v.headline).toEqual({
      alone: { config: "C4", runs: [{ run: 1, valid: true, readYes: 6, labelledNo: 9 }, { run: 2, valid: true, readYes: 5, labelledNo: 9 }, { run: 3, valid: true, readYes: 6, labelledNo: 9 }] },
      checks: {
        config: "C3",
        runs: [{ run: 1, valid: true, readYes: 0, labelledNo: 9, struck: 9, claims: 10 }, { run: 2, valid: true, readYes: 0, labelledNo: 9, struck: 8, claims: 10 }, { run: 3, valid: true, readYes: 0, labelledNo: 9, struck: 8, claims: 10 }],
      },
      started: "2026-10-25T23:34:17.784Z", finished: "2026-10-26T00:18:13.152Z",
    });
    expect(headlineTile(v)).toBe([
      '<div class="headline">',
      "<h2>Ultra alone vs the checks with Ultra as the falsifier</h2>",
      '<ul class="stats">',
      "<li><b>6, 5, 6 of 9</b>items labelled no that Ultra alone (C4) reads as yes, runs 1, 2 and 3</li>",
      "<li><b>0, 0, 0 of 9</b>items labelled no that the checks with Ultra as the falsifier (C3) read as yes, runs 1, 2 and 3</li>",
      "<li><b>9, 8, 8 of 10</b>planted false claims struck by C3, runs 1, 2 and 3</li>",
      "</ul>",
      '<p class="meta">From <a href="#nemotron"><code>eval/results/2026-10-25T23-34-17Z</code></a>, the dev set, 25 Oct 2026 23:34 UTC to 26 Oct 2026 00:18 UTC.</p>',
      "</div>",
    ].join("\n"));
    // in the page: static, in the header after the lede and before the counts, the Report link and the tabs
    const html = built.files.get("index.html")!;
    const header = /<header>[\s\S]*?<\/header>/.exec(html)![0];
    const at = header.indexOf(headlineTile(built.nemotron));
    expect(at).toBeGreaterThan(header.indexOf('<p class="lede">'));
    expect(at).toBeLessThan(header.indexOf('<ul class="stats" id="stats">'));
    expect(header.indexOf('<ul class="stats" id="stats">')).toBeLessThan(header.indexOf('<nav class="tabs"'));
    // the tile's colours are the page's tokens
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1].split("\n").filter((l) => l.startsWith(".headline"));
    expect(css.length).toBeGreaterThan(0);
    for (const rule of css) expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    // the Nemotron tab holds the same counts per run
    const nm = panel("nemotron");
    if (built.nemotron.headline) for (const r of built.nemotron.headline.alone.runs) expect(nm).toContain(`<tr><td>${built.nemotron.headline.alone.config}</td><td>${r.run}</td>`);
  });

  it("carries the owner's document as the Document tab: every heading, table row and list item of examples/document.md, and the line on where it comes from with its decision instant", () => {
    const doc = panel("document");
    const md = readFileSync(path.join(EXAMPLES, "document.md"), "utf8").replace(/\r\n/g, "\n");
    const headings = [...md.matchAll(/^(#{1,6}) (.+)$/gm)].map((m) => `<h${m[1].length + 1}>${escapeHtml(m[2])}</h${m[1].length + 1}>`);
    expect(headings).toContain("<h2>Configuration document: client-1</h2>");
    expect(headings).toContain("<h3>Findings open</h3>");
    for (const h of headings) expect(doc).toContain(h);
    const lines = md.split("\n");
    expect(count(doc, "<tr>")).toBe(lines.filter((l) => /^\|(?!---)/.test(l)).length);
    expect(count(doc, "<li>")).toBe(lines.filter((l) => l.startsWith("- ")).length);
    const instant = /^Decided at (\S+)\.$/m.exec(md)![1];
    expect(doc).toContain(`Rendered from SQL over the recorded bundle at the decision instant it states, <code>${instant}</code>.`);
    expect(built.document).toMatchObject({ file: "examples/document.md", bytes: Buffer.byteLength(md), decidedAt: instant });
    expect(doc).toContain(`examples/document.md ${built.document.sha256} (${built.document.bytes} bytes, LF)`);
  });

  it("carries Where each answer comes from as the Sources tab: one table row per finding class and one line per source, as sourcesMarkdown() reads them off the SQL", () => {
    const src = panel("sources");
    const code = (s: string): string => `<code>${s}</code>`;
    const rows = sourceRows();
    expect(rows.map((r) => r.cls)).toEqual(["proxy_split", "proxied_without_real_ip", "orphan_record", "orphan_vhost", "changed_since_backup", "drift_vs_approved", "approved_missing", "found_but_different", "dns_change"]);
    for (const r of rows) expect(src).toContain(`<tr><td>${code(r.cls)}</td><td>${escapeHtml(r.question)}</td><td>${r.tables.map(code).join(", ")}</td><td>${r.sources.join(", ")}</td></tr>`);
    // the class table and the file sources' table, then the semantic layer's: each a header row and a row per class, source or entity
    const [classes, usl] = src.split("<h3>The semantic layer in Zetaris</h3>");
    expect(count(classes, "<tr>")).toBe(rows.length + 1 + fileSourceRows().length + 1);
    for (const f of fileSourceRows()) expect(classes).toContain(`<td>${f.rows}</td>`);
    expect(classes).toContain("<td><code>LESSONS.lesson</code>, <code>LESSONS.ledger</code></td>");
    expect(count(usl, "<tr>")).toBe(USL_TABLES.length + 1);
    expect(src).toContain("<li>live state (<code>observation</code>): each setting as the live host answers it over SSH");
    expect(count(src, "<li>")).toBe(sourcesMarkdown().split("\n").filter((l) => l.startsWith("- ")).length);
    expect(src).toContain(markdownToHtml(sourcesMarkdown(), 1));
    expect(built.sources).toBe(rows.length);
  });

  it("carries the Nemotron tab: every call of the newest eval run files, its total theirs and summary.md's calls column, linked from the header", () => {
    const nm = panel("nemotron");
    const dir = path.join(ROOT, built.nemotron.dir);
    expect(path.resolve(dir)).toBe(path.resolve(newestResults(path.join(ROOT, "eval", "results"))!));
    const files = readdirSync(dir).filter((f) => /^C\d+-run\d+\.json$/.test(f));
    const runs = files.map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { counts: { calls: number }; calls: { signature_ok: boolean | null }[] });
    const calls = runs.reduce((n, r) => n + r.counts.calls, 0);
    expect(runs.reduce((n, r) => n + r.calls.length, 0)).toBe(calls);
    expect(summaryCalls(dir)).toBe(calls);
    const t = built.index.totals.nemotron;
    expect(t).toEqual(built.nemotron.totals);
    expect(t.calls).toBe(calls);
    expect(t.signatureVerified).toBe(runs.reduce((n, r) => n + r.calls.filter((c) => c.signature_ok === true).length, 0));
    expect(built.nemotron.served.reduce((n, e) => n + e.calls, 0)).toBe(calls);
    expect(nm).toContain(`<tr><td><b>all</b></td><td></td><td></td><td></td><td></td><td></td><td><b>${calls}</b></td><td><b>${t.signatureVerified}</b></td>`);
    expect(built.nemotron.runs).toHaveLength(files.length);
    expect(nm).toContain(`from <code>${built.nemotron.dir}</code>, the <code>${t.set}</code> set`);
    // the nav names the tab, and the header's two stats link to it: the calls, and the judge SELECTs re-run
    const html = built.files.get("index.html")!;
    expect(html).toContain('<a href="#nemotron">Nemotron</a>');
    expect(html).toContain(`<li><b><a href="#nemotron">${calls}</a></b>Nemotron calls in eval ${t.stamp}, ${t.signatureVerified} receipts verified</li>`);
    expect(html).toContain(`<li><b><a href="#nemotron">${t.rerunEqual} / ${t.judgeSelects}</a></b>Nemotron judge SELECTs re-run at build, counts equal${t.notRunnable ? `; ${t.notRunnable} recorded text does not run` : ""}</li>`);
    expect(html).not.toContain("judge model in these runs");
  });

  it("re-runs every judge SELECT recorded with a row count over the recording: equal, or its recorded text counted apart when it does not run; every SELECT in the tab", () => {
    const nm = panel("nemotron");
    const t = built.nemotron.totals;
    const all = judgesOf(built.nemotron);
    const tried = all.filter((j) => j.rerun !== "not_run");
    expect(t.judgeSelects).toBe(tried.length);
    expect(t.rerunEqual + t.notRunnable).toBe(t.judgeSelects);
    for (const j of tried) {
      expect(j.sql).not.toBeNull();
      expect(j.rowsRecorded).not.toBeNull();
      if (j.rerun === "equal") expect(j.rowsAtBuild).toBe(j.rowsRecorded);
      else expect(j.why).toMatch(/^the (guard|engine) refuses it: /);
    }
    for (const j of all.filter((x) => x.rerun === "not_run")) expect(j.sql === null || j.rowsRecorded === null || ["invalid_output", "not_judged"].includes(j.status)).toBe(true);
    for (const j of all) if (j.sql) expect(nm).toContain(`<pre>${text(j.sql)}</pre>`);
  });

  it("over the development run under per-call scope, 25 Oct 2026 23:34 UTC: 390 calls, 390 receipts verified, 0 substitutions; 134 judge SELECTs, 130 re-run equal, the recorded text of 4 does not run", async () => {
    const v = built.nemotron.totals.stamp === path.basename(ISOLATED) ? built.nemotron : await nemotronView(ISOLATED);
    expect(v.totals).toEqual({ stamp: "2026-10-25T23-34-17Z", set: "dev", calls: 390, signatureVerified: 390, cacheHits: 0, substitutions: 0, judgeSelects: 134, rerunEqual: 130, notRunnable: 4 });
    expect(v.claims.map((c) => c.id)).toEqual(["P01", "P02", "P03", "P04", "P05", "P06", "P07", "P08", "P09", "P10"]);
    const tried = judgesOf(v).filter((j) => j.rerun !== "not_run");
    // 50 planted (60 claims, 10 of Lightning's replies invalid output), 54 C3 item judges, 30 C2 item judges
    expect([tried.filter((j) => j.claim).length, tried.filter((j) => j.item && j.config === "C3").length, tried.filter((j) => j.item && j.config === "C2").length]).toEqual([50, 54, 30]);
    // the eval's redactor wrote a pseudonym over column operands such as agg.cnt, and the engine reads the pseudonym's
    // fragment as an unrecognized token; the reason keeps the parts the redactor leaves as they are together, so the
    // token, which the redactor would read as a key's value after "token: ", stays out and the SQL shows it in place
    const off = judgesOf(v).filter((j) => j.rerun === "does_not_run");
    expect(off.map((j) => `${j.config}/${j.run}/${j.claim ?? j.item}`)).toEqual(["C3/1/P09", "C3/1/E24", "C3/3/E17", "C3/3/E24"]);
    for (const j of off) expect(j).toMatchObject({ status: "stands", rowsRecorded: 0, rowsAtBuild: null, why: "the engine refuses it: sqljs: unrecognized token" });
    expect(off.find((j) => j.item === "E24")!.sql).toContain("host-10d1f4.cnt != 2");
  });

  it("over the development run under the shared scope, 25 Oct 2026 09:25 UTC: 389 calls, 383 receipts verified, 0 substitutions; 162 judge SELECTs, 161 re-run equal, the recorded text of 1 does not run", async () => {
    const v = built.nemotron.totals.stamp === path.basename(DEV) ? built.nemotron : await nemotronView(DEV);
    expect(v.totals).toEqual({ stamp: "2026-10-25T09-25-44Z", set: "dev", calls: 389, signatureVerified: 383, cacheHits: 0, substitutions: 0, judgeSelects: 162, rerunEqual: 161, notRunnable: 1 });
    expect(v.claims.map((c) => c.id)).toEqual(["P01", "P02", "P03", "P04", "P05", "P06", "P07", "P08", "P09", "P10"]);
    const tried = judgesOf(v).filter((j) => j.rerun !== "not_run");
    // 59 planted (60 claims, one reply held no JSON), 55 C3 item judges, 48 C2 item judges
    expect([tried.filter((j) => j.claim).length, tried.filter((j) => j.item && j.config === "C3").length, tried.filter((j) => j.item && j.config === "C2").length]).toEqual([59, 55, 48]);
    // the results hold the SELECT as the eval's redactor left it after the run: the alias bs2 of "bs2.host" reads as a
    // host name to it; the recorded status and rows are what the SELECT returned, and the reason leaves the operand out
    const off = judgesOf(v).filter((j) => j.rerun === "does_not_run");
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({ config: "C2", run: 2, claim: "P10", status: "refuted", rowsRecorded: 1, rowsAtBuild: null, why: "the engine refuses it: sqljs: no such column" });
    expect(off[0].sql).toContain("host-b6a1ec.host = 'host-aa516a'");
  });

  it("a results copy with one recorded row count moved by one makes the build throw and write nothing, a planted claim's or an item judge's", async () => {
    const results = path.join(tmp, "results-wrong", path.basename(DEV));
    const copy = (): void => {
      mkdirSync(results, { recursive: true });
      for (const f of readdirSync(DEV).filter((x) => /^C\d+-run\d+\.json$|^planted\.json$/.test(x))) cpSync(path.join(DEV, f), path.join(results, f));
    };
    copy();
    const plantedFile = path.join(results, "planted.json");
    const planted = JSON.parse(readFileSync(plantedFile, "utf8")) as { claims: { config: string; run: number; id: string; rows: number }[] };
    planted.claims.find((c) => c.config === "C3" && c.run === 1 && c.id === "P01")!.rows += 1;
    writeFileSync(plantedFile, JSON.stringify(planted, null, 1));
    const dir = brokenExamples("results-wrong-examples", () => {});
    const out = path.join(tmp, "results-wrong-out");
    const build = (): Promise<BuildResult> => buildSite({ examplesDir: dir, outDir: out, samplePath: null, resultsDir: results });
    await expect(build()).rejects.toThrow(SiteError);
    await expect(build()).rejects.toThrow(/2026-10-25T09-25-44Z\/planted\.json C3 run 1 claim P01: the judge's SELECT re-run over the recording returns 1 row\(s\), the record says 2/);
    expect(existsSync(out)).toBe(false);

    copy();
    const runFile = path.join(results, "C3-run1.json");
    const run = JSON.parse(readFileSync(runFile, "utf8")) as { items: { id: string; subjects: { finding_id: string; judge: { rows?: number | null } | null }[] }[] };
    const item = run.items.find((i) => i.subjects.some((s) => typeof s.judge?.rows === "number"))!;
    const subject = item.subjects.find((s) => typeof s.judge?.rows === "number")!;
    const recorded = subject.judge!.rows as number;
    subject.judge!.rows = recorded + 1;
    writeFileSync(runFile, JSON.stringify(run, null, 1));
    await expect(build()).rejects.toThrow(new RegExp(`C3-run1\\.json C3 run 1 item ${item.id} finding ${subject.finding_id}: the judge's SELECT re-run over the recording returns ${recorded} row\\(s\\), the record says ${recorded + 1}`));
    expect(existsSync(out)).toBe(false);
  }, 120_000);

  it("the markdown renderer writes its subset only: headings, paragraphs, lists, tables, inline code and bold, every other character escaped", () => {
    const md = [
      "# Title <b>x</b>",
      "",
      "A <script>alert(1)</script> & \"q\" 'a' [link](https://x.invalid) **bold** `a<b>|c` *em*",
      "continued",
      "",
      "- item `x`",
      "  more",
      "- two",
      "",
      "| a | b |",
      "|---|---|",
      "| `p\\|q` | <img src=x onerror=alert(1)> |",
    ].join("\n");
    expect(markdownToHtml(md, 1)).toBe([
      "<h2>Title &lt;b&gt;x&lt;/b&gt;</h2>",
      "<p>A &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot; &#39;a&#39; [link](https://x.invalid) <b>bold</b> <code>a&lt;b&gt;|c</code> *em* continued</p>",
      "<ul>", "<li>item <code>x</code> more</li>", "<li>two</li>", "</ul>",
      '<div class="scroll"><table>', '<thead><tr><th scope="col">a</th><th scope="col">b</th></tr></thead>', "<tbody>",
      "<tr><td><code>p|q</code></td><td>&lt;img src=x onerror=alert(1)&gt;</td></tr>", "</tbody>", "</table></div>", "",
    ].join("\n"));
  });

  it(`stays under ${MAX_BYTES} bytes, the page, the landing page and the data together, the whole document in the page`, () => {
    expect(built.files.has("site.html")).toBe(true);
    expect(built.bytes).toBeLessThan(MAX_BYTES);
    expect(built.bytes).toBe([...built.files.values()].reduce((n, s) => n + Buffer.byteLength(s), 0));
    expect(Buffer.byteLength(built.files.get("index.html")!)).toBeGreaterThan(built.document.bytes);
  });

  it("a second build is byte-identical, page and data alike", async () => {
    const again = await buildSite({ examplesDir: EXAMPLES, write: false, memoryDir: STORE });
    expect([...again.files.keys()]).toEqual([...built.files.keys()]);
    for (const [name, text] of built.files) expect(again.files.get(name), name).toBe(text);
  }, 120_000);

  it("the output passes the deny-list scan (the leak test's labels, the ssh aliases, the redactor over every data string), the tabs' markdown and the Nemotron tab's strings read as written", () => {
    if (!WORDS.length) console.log("site: deny-list labels blank; the label half of the scan is empty, the redactor half runs");
    const report = scanOutput(built.files);
    expect(report.labels).toBe(WORDS.length);
    expect(report.leaves).toBeGreaterThan(1000);
    // the document, sourcesMarkdown(), uslMarkdown() and the Nemotron tab's strings; the tab's strings through the redactor too
    expect(built.scan.shown).toBe(4);
    expect(built.scan.leaves).toBeGreaterThan(report.leaves);
  });

  it("the scan refuses a Nemotron tab string the redactor would still replace, by its path, never the value", () => {
    const planted = [10, 11, 12, 13].join(".");
    expect(() => scanOutput(new Map(), new Map(), new Map([["results (the Nemotron tab)", { items: [{ sql: `SELECT '${planted}'` }] }]])))
      .toThrow(/results \(the Nemotron tab\) \$\.items\[0\]\.sql: the redactor still replaces 1 ip/);
  });

  it.skipIf(!WORDS.length)("the scan refuses a configured label in the markdown a tab renders, by the text's name and the label's position, never the label", () => {
    const shown = new Map([["examples/document.md (the Document tab)", `x ${WORDS[0]} y`]]);
    expect(() => scanOutput(new Map(), shown)).toThrow(/examples\/document\.md \(the Document tab\): label #1 x1/);
  });

  it("a missing owner's document, or one with no heading, makes the build throw and write nothing", async () => {
    const dir = brokenExamples("no-document", () => {});
    const out = path.join(tmp, "no-document-out");
    await expect(buildSite({ examplesDir: dir, outDir: out, samplePath: null, documentPath: path.join(tmp, "absent.md") })).rejects.toThrow(/refusing to publish: absent\.md is missing/);
    writeFileSync(path.join(tmp, "flat.md"), "No heading here.\n");
    await expect(buildSite({ examplesDir: dir, outDir: out, samplePath: null, documentPath: path.join(tmp, "flat.md") })).rejects.toThrow(/flat\.md opens with no heading/);
    expect(existsSync(out)).toBe(false);
  });

  it("the scan refuses an address the redactor would still replace, naming the JSON path and never the value", () => {
    const planted = [10, 11, 12, 13].join(".");
    const files = new Map([["data/x.json", JSON.stringify({ rows: [["ok", `origin ${planted}`]] })]]);
    expect(() => scanOutput(files)).toThrow(SiteError);
    expect(() => scanOutput(files)).toThrow(/data\/x\.json \$\.rows\[0\]\[1\]: the redactor still replaces 1 ip/);
    try { scanOutput(files); } catch (err) { expect((err as Error).message).not.toContain(planted); }
  });

  it.skipIf(!WORDS.length)("the scan refuses a configured label in the page, by its position in the list, never the label", () => {
    const files = new Map([["index.html", `<p>x ${WORDS[0]} y</p>`]]);
    expect(() => scanOutput(files)).toThrow(/index\.html: label #1 x1/);
    try { scanOutput(files); } catch (err) { expect((err as Error).message.toLowerCase()).not.toContain(WORDS[0].toLowerCase()); }
  });

  it("a finding that cites an unknown template makes the build throw and writes nothing", async () => {
    const dir = brokenExamples("unknown-template", (fs) => { fs[0].checks[1].template = "no_such_template"; });
    const out = path.join(tmp, "unknown-out");
    await expect(buildSite({ examplesDir: dir, outDir: out, samplePath: null })).rejects.toThrow(/unknown template: no_such_template/);
    expect(existsSync(out)).toBe(false);
  });

  it("a recorded row count the re-run does not give makes the build throw", async () => {
    const dir = brokenExamples("wrong-count", (fs) => { fs[0].checks[3].rowCount = 2; });
    await expect(buildSite({ examplesDir: dir, outDir: path.join(tmp, "wrong-out"), samplePath: null })).rejects.toThrow(/referent_unchanged re-run returns 3 row\(s\), the record says 2/);
  });

  it("an example the pass does not reproduce is refused by name (run npm run examples); --allow-stale publishes it marked stale instead", async () => {
    const dir = brokenExamples("stale", (fs) => { fs[0].verb = "ADOPT"; });              // the checks still re-run to their counts; only the record as a whole differs
    const out = path.join(tmp, "stale-out");
    await expect(buildSite({ examplesDir: dir, outDir: out, samplePath: null })).rejects.toThrow(SiteError);
    await expect(buildSite({ examplesDir: dir, outDir: out, samplePath: null })).rejects.toThrow(/refusing to publish: examples\/proxy-split\/findings\.json is stale: re-running the pass over the slice does not give the committed findings; run npm run examples/);
    expect(existsSync(out)).toBe(false);
    const allowed = await buildSite({ examplesDir: dir, outDir: out, samplePath: null, allowStale: true });
    expect(allowed.index.examples.map((e) => [e.dir, e.reproduced])).toEqual([["proxy-split", false]]);
    expect(existsSync(path.join(out, "index.html"))).toBe(true);
  });

  it("a sentence the bound parameters do not reproduce makes the build throw: the SQL shown would not be the SQL that ran", async () => {
    const dir = brokenExamples("wrong-window", (fs) => { fs[0].finding.until = "2026-10-24T08:30:00.000Z"; });
    await expect(buildSite({ examplesDir: dir, outDir: path.join(tmp, "window-out"), samplePath: null })).rejects.toThrow(/explains itself differently/);
  });

  it("the committed docs/ is this build of the committed examples (run npm run site when it is not)", () => {
    for (const [name, text] of built.files) {
      const file = path.join(ROOT, "docs", name);
      expect(existsSync(file), `docs/${name} is missing: run npm run site`).toBe(true);
      expect(readFileSync(file, "utf8").replace(/\r\n/g, "\n"), `docs/${name} is stale: run npm run site`).toBe(text);
    }
  });
});

describe("the landing page, docs/site.html", () => {
  const site = (): string => built.files.get("site.html")!;
  const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
  /** Text as written before the build escaped it: inline code as the README's backticks, every other tag dropped. */
  const plain = (s: string): string => s.replace(/<\/?code>/g, "`").replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ENTITY[e]);
  const readmeRaw = (): string => readFileSync(path.join(ROOT, "README.md"), "utf8").replace(/\r\n/g, "\n");
  /** The README's paragraphs, each on one line, joined: the text the page quotes from. */
  const readme = (): string => readmeRaw().split(/\n[ \t]*\n/).map((p) => p.replace(/\s+/g, " ").trim()).join("\n");
  const doc = (): string => readFileSync(path.join(EXAMPLES, "document.md"), "utf8").replace(/\r\n/g, "\n");
  const input = (): SiteInput => ({
    index: built.index, nemotron: built.nemotron, resultsDir: path.join(ROOT, built.nemotron.dir),
    documentText: doc(), documentFile: "examples/document.md", sampleLine: null,
  });
  /** The HTML of one section of the page, by id. */
  const section = (id: string): string => {
    const m = new RegExp(`<section class="band" id="${id}">[\\s\\S]*?</section>`).exec(site());
    expect(m, `the page has no #${id} section`).not.toBeNull();
    return m![0];
  };
  const all = (html: string, re: RegExp): string[] => [...html.matchAll(re)].map((m) => m[1]);
  const sha = (s: string): string => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;

  it("is built with the replay page from scripts/site/landing.html, every token the template holds filled and none left", () => {
    const template = readFileSync(SITE_TEMPLATE, "utf8");
    const tokens = [...new Set([...template.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]))];
    expect(tokens.sort()).toEqual(Object.keys(built.site.tokens).sort());
    expect(site()).not.toMatch(/\{\{/);
    expect(existsSync(path.join(ROOT, "scripts", "site", "selectors.ts.txt"))).toBe(false);
  });

  it("types no figure: the template's own text, outside its styles, its icon and its tags, holds no digit, so every number on the page comes from a token", () => {
    const text = readFileSync(SITE_TEMPLATE, "utf8").replace(/<style>[\s\S]*?<\/style>/, "").replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").replace(/\{\{[A-Z0-9_]+\}\}/g, "");
    expect(text).not.toMatch(/\d/);
  });

  it("holds no script and fetches nothing: no CDN, font, stylesheet or image, and no URL outside the repository but the repository link", () => {
    const html = site();
    const repo = repositoryUrl();
    expect(html).not.toMatch(/<script|<link|<img|<iframe|<object|<embed|<video|<audio|@import|@font-face|\bsrc=|url\((?!#)/i);
    const external = [...html.matchAll(/(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s"'<>]+/gi)].map((m) => plain(m[0]));
    expect(external).toEqual([DECK_URL, repo ?? ""].filter((u) => /^https?:\/\//.test(u)));
    // every link: the replay page, the owner's report, an anchor this page holds, or the deck and repository links when set
    const ids = new Set(all(html, /\bid="([^"]+)"/g));
    for (const href of all(html, /\b(?:href|src|action)="([^"]*)"/g).map(plain)) {
      if (href.startsWith("#")) expect(ids.has(href.slice(1)), href).toBe(true);
      else expect(["index.html", "index.html#sources", REPORT_LINK, EXECUTIVE_LINK, ...(DECK_URL ? [DECK_URL] : []), ...(repo ? [repo] : [])], href).toContain(href);
    }
    // the pages nav links the executive report beside the owner's report
    expect(/<nav class="pages" aria-label="Pages">[\s\S]*?<\/nav>/.exec(html)![0]).toContain(`<a href="${REPORT_LINK}">Owner's report</a>\n<a href="${EXECUTIVE_LINK}">Executive report</a>`);
    // DECK_URL is empty and package.json names no repository: both links are left out, their template lines with them
    expect(html.includes(">Deck</a>")).toBe(DECK_URL !== "");
    expect(html.includes(">Repository</a>")).toBe(repo !== null);
    expect([built.site.tokens.DECK_HREF === null, built.site.tokens.REPO_HREF === null]).toEqual([DECK_URL === "", repo === null]);
  });

  it("reads the repository link off package.json's repository field, a URL or the GitHub shorthand, as an https link; no field, no link", () => {
    const pkg = (name: string, repository?: unknown): string => {
      const file = path.join(tmp, `package-${name}.json`);
      writeFileSync(file, JSON.stringify(repository === undefined ? { name: "drift-agent" } : { name: "drift-agent", repository }));
      return file;
    };
    expect(repositoryUrl(pkg("none"))).toBeNull();
    expect(repositoryUrl(pkg("object", { type: "git", url: "git+https://github.com/o/r.git" }))).toBe("https://github.com/o/r");
    expect(repositoryUrl(pkg("string", "https://github.com/o/r"))).toBe("https://github.com/o/r");
    expect(repositoryUrl(pkg("shorthand", "github:o/r"))).toBe("https://github.com/o/r");
    expect(repositoryUrl(pkg("ssh", "git@github.com:o/r.git"))).toBeNull();
  });

  it("opens with the README's track and its first three sentences, as written", () => {
    const html = site();
    expect(readme()).toContain(plain(/<p class="eyebrow">([\s\S]*?)<\/p>/.exec(html)![1]));
    expect(plain(/<p class="eyebrow">([\s\S]*?)<\/p>/.exec(html)![1])).toMatch(/^GenAI Works Open Agent Hackathon 2026, Track 1 \(Solving Fragmented Intelligence\)$/);
    const h1 = plain(/<h1>([\s\S]*?)<\/h1>/.exec(html)![1]);
    const lede = plain(/<p class="lede">([\s\S]*?)<\/p>/.exec(html)![1]);
    const third = plain(/<p class="sub">([\s\S]*?)<\/p>/.exec(section("sources"))![1]);
    const first = readme().split("\n").find((p) => !p.startsWith("#"))!;
    expect(first.startsWith(`${h1} ${lede} ${third}`)).toBe(true);
    expect([h1, lede, third].every((s) => /[^.]\.$/.test(s))).toBe(true);
    expect(h1).toMatch(/^ConfigLeaf, package `drift-agent`, /);
    expect(html).toContain('<h1><span class="grad">ConfigLeaf</span>, package <code>drift-agent</code>, ');
    expect(/<meta name="description" content="([^"]*)">/.exec(html)![1]).toBe(escapeHtml(`${h1} ${lede}`.replace(/`/g, "")));
  });

  it("fills the estate tiles from the owner's document", () => {
    const tiles = [...site().matchAll(/<div class="tile"><b>([^<]*)<\/b><span>([^<]*)<\/span><\/div>/g)].map((m) => [plain(m[1]), plain(m[2])]);
    const md = doc();
    const runs = /^(\d+) collection runs on record, (\d+) passing the DQ gate\. (\d+ hosts) and (\d+ zones) in the latest passing runs\./m.exec(md)!;
    const open = /^(\d+) findings are open on the latest passing runs: (.+)\.$/m.exec(md)!;
    expect(tiles).toEqual([
      [`${runs[2]} / ${runs[1]}`, "collection runs pass the DQ gate"],
      [/^(\d+) settings have an approval of record/m.exec(md)![1], "settings with an approval of record"],
      [/^(\d+) vault copies at the latest commit of each repository, each with its latest validation/m.exec(md)![1], "vault copies, each with its latest validation"],
      [open[1], `findings open: ${open[2]}`],
    ]);
    expect(plain(/<p class="cap">([\s\S]*?)<\/p>/.exec(site())![1])).toBe(`From the owner's document, \`examples/document.md\`, tenant \`client-1\`: ${runs[3]} and ${runs[4]} in the latest passing runs, decided at ${built.document.decidedAt}.`);
  });

  it("sets Ultra alone beside the checks with Ultra as the falsifier, per run, from the Nemotron tab's headline: each figure and each row of dots its run's", () => {
    const h = built.nemotron.headline!;
    expect(h).not.toBeNull();
    const nm = section("nemotron");
    const sides = all(nm, /<article class="side [^"]*">([\s\S]*?)<\/article>/g);
    expect(sides).toHaveLength(2);
    const bigs = sides.map((s) => all(s, /<p class="big">([^<]*)<\/p>/g));
    const per = (xs: [number, number][]): string => (xs.every(([, d]) => d === xs[0][1]) ? `${xs.map(([k]) => k).join(", ")} of ${xs[0][1]}` : xs.map(([k, d]) => `${k} of ${d}`).join(", "));
    expect(bigs).toEqual([
      [per(h.alone.runs.map((r) => [r.readYes, r.labelledNo]))],
      [per(h.checks.runs.map((r) => [r.readYes, r.labelledNo])), per(h.checks.runs.map((r) => [r.struck, r.claims]))],
    ]);
    // one row of dots per run: as many filled as the run's count, as many in all as its total
    const rows = sides.flatMap((s) => all(s, /<p><span>run \d+<\/span>((?:<[bi]><\/[bi]>)*) \d+ of \d+<\/p>/g));
    const want = [...h.alone.runs.map((r) => [r.readYes, r.labelledNo]), ...h.checks.runs.map((r) => [r.readYes, r.labelledNo]), ...h.checks.runs.map((r) => [r.struck, r.claims])];
    expect(rows.map((r) => [r.split("<b>").length - 1, r.split("<b>").length - 1 + r.split("<i>").length - 1])).toEqual(want);
    expect(sides[0]).toContain(`${h.alone.config} · `);
    expect(sides[1]).toContain(`${h.checks.config} · `);
    expect(nm).toContain(`<code>${built.nemotron.dir}</code>, the <code>${built.nemotron.totals.set}</code> set`);
    expect(site()).toContain('<a href="#nemotron">Nemotron</a>');
  });

  it("reads the README's eight places into one Zetaris layer and out to the five verbs its third sentence names, in its order", () => {
    const src = section("sources");
    const items = [...src.matchAll(/<li><b>([\s\S]*?)<\/b>(?:<span>([\s\S]*?)<\/span>)?<\/li>/g)].map((m) => (m[2] ? `${plain(m[1])} (${plain(m[2])})` : plain(m[1])));
    expect(items).toHaveLength(8);
    const title = `The ${word(items.length)} places`;
    expect(src).toContain(`<h2>${title}, read as one</h2>`);
    expect(readme().split("\n")).toContain(`${title}: ${items.slice(0, -1).join(", ")}, and ${items.at(-1)}.`);
    const hub = /<div class="hub-card">([\s\S]*?)<\/div>/.exec(src)![1];
    expect(hub).toBe(`<small>Zetaris</small><b>${USL_NAME}</b><span>${DS} · ${FILE_DATASOURCES.lesson} · ${FILE_DATASOURCES.rule} · ${REST_DB}</span><span>${word(USL_TABLES.length)} entities · ${word(DQ_RULES.length)} DQ rules</span>`);
    const out = all(src, /<li class="v-(\w+)">/g);
    expect([...out].sort()).toEqual([...VERBS].sort());
    const third = plain(/<p class="sub">([\s\S]*?)<\/p>/.exec(src)![1]);
    expect(out.map((v) => third.indexOf(v))).toEqual(out.map((v) => third.indexOf(v)).sort((a, b) => a - b));
    expect(src).toContain('<li class="v-HOLD"><b>HOLD</b>with an expiry</li>');
  });

  it("carries the README's opening bullets as the stack: each lead and its words, the link to the README's own section left out", () => {
    const lines = readmeRaw().split("\n");
    const bullets = lines.slice(0, lines.findIndex((l) => l.startsWith("## "))).flatMap((l) => {
      const m = /^- \*\*(.+?)\*\*: (.+)$/.exec(l);
      return m ? [[m[1], m[2].replace(/\s*\(\[[^\]]*\]\(#[^)]*\)\)(?=\.?$)/, "")]] : [];
    });
    expect(bullets.map((b) => b[0])).toEqual(["Zetaris", "Meterless", "NVIDIA Nemotron"]);
    const stack = section("stack");
    expect(stack).toContain("<h2>Zetaris, Meterless and NVIDIA Nemotron</h2>");
    const cards = [...stack.matchAll(/<article class="card"><h3>([\s\S]*?)<\/h3><p>([\s\S]*?)<\/p><\/article>/g)].map((m) => [plain(m[1]), plain(m[2])]);
    expect(cards).toEqual(bullets.map(([lead, text]) => [lead, `${text[0].toUpperCase()}${text.slice(1)}`]));
  });

  it("lays out the semantic layer as src/zetaris/setup.ts holds it: each entity once, in the lane of its datasource, with its DQ rule", () => {
    const layer = section("layer");
    const lanes = all(layer, /<div class="lane">([\s\S]*?)<\/ul><\/div>/g);
    expect(lanes.map((l) => /<b>(\w+)<\/b>/.exec(l)![1])).toEqual([DS, FILE_DATASOURCES.lesson, FILE_DATASOURCES.rule, REST_DB]);
    const entities = lanes.flatMap((l) => all(l, /<li><code>(\w+)<\/code>/g));
    expect([...entities].sort()).toEqual([...USL_TABLES].sort());
    for (const r of DQ_RULES) expect(layer).toMatch(new RegExp(`<li><code>${r.table}</code>[^<]*<br><em>${r.name}</em></li>`));
    expect(all(layer, /<em>(\w+)<\/em>/g)).toHaveLength(DQ_RULES.length);
    expect(plain(/<p class="sub">([\s\S]*?)<\/p>/.exec(layer)![1])).toBe(`\`${USL_NAME}\` in \`lightning.metastore.drift\` holds ${word(USL_TABLES.length)} entities over four datasources, each built from the tables its activation SELECT reads, and ${word(DQ_RULES.length)} DQ rules.`);
  });

  it("decides under the README's policy, its bullets as written, beside the findings open by verb in the owner's document", () => {
    const decide = section("decide");
    const lines = readmeRaw().split("\n");
    const from = lines.indexOf("## Policy");
    const bullets = lines.slice(from + 1, lines.findIndex((l, i) => i > from && l.startsWith("## "))).flatMap((l) => {
      const m = /^- ([A-Z]+(?:(?:, | or )[A-Z]+)*): (.+)$/.exec(l);
      return m ? [[m[1], m[2]]] : [];
    });
    const cards = [...decide.matchAll(/<article class="vcard v-\w+"><h3>([\s\S]*?)<\/h3><p>([\s\S]*?)<\/p><\/article>/g)].map((m) => [plain(m[1]), plain(m[2])]);
    expect(cards).toEqual(bullets.map(([lead, text]) => [lead, `${text[0].toUpperCase()}${text.slice(1)}`]));
    const open = /^(\d+) findings are open on the latest passing runs: (.+)\.$/m.exec(doc())!;
    const verbs = [...open[2].matchAll(/([A-Z]+) (\d+)/g)].map((m) => [m[1], m[2]]);
    expect([...decide.matchAll(/<span class="v-(\w+)" style="flex:(\d+)"><\/span>/g)].map((m) => [m[1], m[2]])).toEqual(verbs);
    expect(all(decide, /<li class="v-\w+">([^<]*)<\/li>/g)).toEqual(verbs.map(([v, n]) => `${v} ${n}`));
  });

  it("tells each act in the README's own words, dated by the README's times, act two the provider's revert of a record with FOUND-BUT-DIFFERENT on two rows", () => {
    const text = readme();
    const acts = section("acts");
    const cards = [...acts.matchAll(/<div class="act-time">([^<]*)<span>(\w+)<\/span><\/div><article class="act-card"><h3>[^<]*<\/h3><p>([\s\S]*?)<\/p>/g)].map((m) => ({ time: m[1], where: m[2], text: plain(m[3]) }));
    expect(cards.map((c) => c.where)).toEqual(["production", "production", "production", "lab"]);
    for (const c of cards) {
      expect(c.text).toContain(`at ${c.time}`);
      for (const s of c.text.split(/(?<=[.!?]["')]*) (?=[A-Z])/)) {
        const forms = [s, s.replace(/\.$/, "")].flatMap((x) => [x, `${x[0].toLowerCase()}${x.slice(1)}`]);
        expect(forms.some((x) => text.includes(x)), s).toBe(true);
      }
    }
    expect(cards[1].text).toContain("2 `found_but_different` findings");
    expect(cards[1].text).toContain("`revert_record` through the provider");
    expect(cards[1].text).toContain("with the provider confirming the value");
    expect(cards[1].text).not.toMatch(/restor/i);
    expect(acts).toContain('<span class="kind">rollback_file</span>');
    // the title's days: the README's sentence on act one and the three traces
    expect([...new Set(built.site.traces.flatMap((t) => readTrace(t.file).map((e) => e.ts.slice(0, 10))))]).toEqual(["2026-10-25"]);
    expect(text).toContain("all on 25 Oct 2026 in the operator's rehearsal");
    expect(acts).toContain("<h2>The production estate and the lab chain, 25 Oct 2026</h2>");
  });

  it("quotes trace lines the replay page's redactor leaves as they are, each a line of the committed trace its caption names, counted against it", () => {
    const figures = [...section("acts").matchAll(/<figure class="trace"><figcaption><span>([^<]*)<\/span><span>([^<]*)<\/span><\/figcaption><pre>([\s\S]*?)<\/pre><\/figure>/g)];
    expect(figures.map((m) => m[1])).toEqual(["examples/traces/cycle_mvo2bil0.jsonl", "examples/traces/cycle_mvo5600q.jsonl", "examples/traces/cycle_mvoa0l1i.jsonl"]);
    const blocks = figures.map((m) => plain(m[3]).split("\n"));
    expect(built.site.traces.map((t) => t.lines)).toEqual(blocks);
    expect(built.site.traces.map((t) => t.file)).toEqual(figures.map((m) => m[1]));
    const salted = new Redactor(randomBytes(16).toString("hex"), config.redactWords);
    const fixed = new Redactor("site-build", []);
    for (const [i, m] of figures.entries()) {
      const events = readTrace(m[1]);
      const ts = events.map((e) => e.ts).sort();
      expect(plain(m[2])).toBe(`${blocks[i].length} of ${events.length.toLocaleString("en-US")} lines · ${ts[0].slice(11, 19)} to ${ts.at(-1)!.slice(11, 19)} UTC`);
      const printed = new Set(events.map((e) => formatTraceLine(e, (s) => s)));
      for (const line of blocks[i]) {
        expect(printed.has(line), `${m[1]}: ${line}`).toBe(true);
        expect(salted.text(line), `${m[1]}: a line the redactor changes`).toBe(line);
        expect(fixed.text(line)).toBe(line);
      }
    }
    const [two, three, lab] = blocks;
    expect(two.filter((l) => /^detector\/detect · ok · .* · found_but_different: /.test(l))).toHaveLength(2);
    expect(two.at(-1)).toMatch(/^actor\/revise · ok · revert_record cloudflare\.dns .* · done: /);
    expect(three.map((l) => l.split(" · ").slice(0, 2).join(" · "))).toEqual(["actor/check · ok", "actor/escalate · skipped"]);
    expect(three[1]).toContain("refused: no fix is allowed without a valid copy");
    expect(lab.every((l) => l.startsWith("explainer/explain · ok · "))).toBe(true);
  });

  it("proves it with the rings, the eval line and the receipts lines npm run receipts:verify prints for the results directory the Nemotron tab is built from", () => {
    const proof = section("proof");
    const t = built.index.totals;
    const nm = built.nemotron.totals;
    const dir = built.nemotron.dir;
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/receipts-verify.ts", dir], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    const printed = r.stdout.trim().split("\n");
    const counts = /receipts: [\d,]+ receipt ids, ([\d,]+) in receipts\.json, ([\d,]+) withheld; ([\d,]+) of [\d,]+ signatures verified/.exec(printed.join("\n"))!;
    expect(all(proof, /<b>([^<]*)<\/b><figcaption>/g)).toEqual([`${t.checksRerun} / ${t.checks}`, `${nm.rerunEqual} / ${nm.judgeSelects}`, `${nm.signatureVerified} / ${nm.calls}`, `${counts[3]} / ${counts[1]}`]);
    const line = plain(/<p class="evalline">([\s\S]*?)<\/p>/.exec(proof)![1]);
    for (const s of [`The \`${nm.set}\` set`, `(\`${dir}\`)`, `${built.nemotron.runs.length} configuration runs`, `${nm.calls} Nemotron calls, ${nm.signatureVerified} with a verified receipt, ${nm.substitutions} substitutions`, `of the ${nm.judgeSelects} judge SELECTs recorded with a row count, ${nm.rerunEqual} re-run at build`]) expect(line).toContain(s);
    const consoles = [...proof.matchAll(/<pre>\$ ([^\n]*)\n<span class="out">([\s\S]*?)<\/span><\/pre>/g)].map((m) => [plain(m[1]), plain(m[2])]);
    expect(consoles.map((c) => c[0])).toEqual([`npm run receipts:verify -- ${dir}`, SAMPLE_COMMAND]);
    const shown = consoles[0][1].split("\n");
    expect(shown.filter((l) => l !== "…")).toEqual([printed.find((l) => / receipt ids, /.test(l)), printed.at(-1)]);
    expect(shown.at(-1)).toMatch(/^receipts: OK, \d+ signatures verified, 0 mismatches$/);
    // the sample: the summary line --json prints, from the build's own pass over sample/bundle.json, cut to its counts and verbs
    const s = built.index.sample!;
    expect(s.gatedOut).toBe(0);
    const verbs = VERBS.filter((v) => s.verbs[v]).map((v) => `${v} ${s.verbs[v]}`).join(", ");
    expect(SAMPLE_COMMAND).toBe("SAMPLE_MODE=true npm run sample -- --json");
    expect(consoles[1][1]).toBe(`SAMPLE: ${s.runs} collection runs, 0 failed the DQ gate (none), ${s.observed} observations in the World Model, ${s.findings} finding(s): …; verbs: ${verbs}; …`);
  }, 60_000);

  it("names each file it reads, with the hash of each file it quotes", () => {
    const rows = [...section("provenance").matchAll(/<li><code>([^<]*)<\/code><span>[^<]*<\/span><small>([^<]*)<\/small><\/li>/g)].map((m) => [m[1], plain(m[2])]);
    expect(rows.map((r) => r[0])).toEqual(["README.md", "examples/document.md", "src/zetaris/setup.ts", ...built.site.traces.map((t) => t.file), built.nemotron.dir, "sample/bundle.json", "data/index.json"]);
    for (const [file, meta] of rows) {
      const shown = /^(sha256:[0-9a-f]+)…/.exec(meta)?.[1];
      if (!shown) continue;
      const full = file === "sample/bundle.json" ? built.index.sample!.sha256 : sha(readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n"));
      expect(full.startsWith(shown), file).toBe(true);
    }
    expect(rows.filter((r) => r[1].startsWith("sha256:")).map((r) => r[0])).toEqual(["examples/document.md", ...built.site.traces.map((t) => t.file), "sample/bundle.json"]);
  });

  it("refuses a results directory whose receipts npm run receipts:verify would fail: a receipt's signature changed in a copy", () => {
    const dir = path.join(tmp, "receipts-tampered", path.basename(built.nemotron.dir));
    mkdirSync(dir, { recursive: true });
    const from = path.join(ROOT, built.nemotron.dir);
    for (const f of readdirSync(from).filter((x) => /^C\d+-run\d+\.json$|^planted\.json$|^receipts(-withheld)?\.json$/.test(x))) cpSync(path.join(from, f), path.join(dir, f));
    const file = path.join(dir, "receipts.json");
    const receipts = JSON.parse(readFileSync(file, "utf8")) as { sig_b64: string }[];
    receipts[0].sig_b64 = `${receipts[0].sig_b64[0] === "A" ? "B" : "A"}${receipts[0].sig_b64.slice(1)}`;
    writeFileSync(file, JSON.stringify(receipts));
    expect(() => renderSiteHtml({ ...input(), resultsDir: dir })).toThrow(/refusing to publish: npm run receipts:verify -- \S+ finds \d+ mismatch(es)?; the landing page states the verdict it prints/);
  }, 60_000);

  it("refuses a template token it does not fill and a token it fills that the template lacks; a source the build lacks leaves out what it would fill", () => {
    const template = readFileSync(SITE_TEMPLATE, "utf8");
    expect(() => renderSiteHtml(input(), template.replace("</main>", "{{NO_SUCH_TOKEN}}</main>"))).toThrow(SiteError);
    expect(() => renderSiteHtml(input(), template.replace("</main>", "{{NO_SUCH_TOKEN}}</main>"))).toThrow(/scripts\/site\/landing\.html holds the token \{\{NO_SUCH_TOKEN\}\}, which the build does not fill/);
    expect(() => renderSiteHtml(input(), template.replace("{{TILES_HTML}}", ""))).toThrow(/the build fills \{\{TILES_HTML\}\}, which scripts\/site\/landing\.html does not hold/);
    // no sample pass and no receipts.json: the two commands and the receipts ring are left out, and nothing else changes
    const bare = renderSiteHtml({ ...input(), resultsDir: tmp }, template);
    expect(bare.html).not.toMatch(/npm run sample|npm run receipts:verify|signature verifies offline/);
    expect(bare.html).not.toMatch(/\{\{/);
    // the provenance row of the results directory names receipts.json only when it is there
    expect(bare.html).toContain(`${built.nemotron.runs.length} run files, planted.json</small>`);
    const strip = (h: string): string => h.replace(/<div class="rings">[\s\S]*?<\/div>\n<p class="evalline">/, "").replace(/<div class="consoles">[\s\S]*?<\/div><\/section>/, "").replace("planted.json, receipts.json</small>", "planted.json</small>");
    expect(strip(bare.html)).toBe(strip(site()));
  });
});
