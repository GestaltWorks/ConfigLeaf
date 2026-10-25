// The replay page (scripts/build-site.ts): built from the three committed examples into a throwaway
// directory, it holds index.html and one data file per example; every check carries the SQL that ran,
// rendered, non-empty and re-run to the recorded count, and with it the text a live pass sends to Zetaris (the same
// SQL, each table <datasource>.<table>), which the lede, the Sources tab and the footer name; the output passes the
// deny-list scan; a finding that cites a template the catalogue cannot render, or a count the re-run does not give, makes the build
// throw and write nothing; the page carries the owner's document (Document) and "Where each answer comes from"
// (Sources) as HTML the build renders from their markdown, escaped outside its subset; the Nemotron tab carries the
// eval results' calls, whose total is the run files' and summary.md's, and every judge SELECT recorded with a row count,
// re-run equal or counted apart as recorded text that does not run, and a results copy with one recorded count moved
// by one makes the build throw and write nothing; the header links the owner's report (../examples/report.html), a
// fixed relative link outside the tab row; a second build is byte-identical;
// and the committed docs/ is exactly this build (rerun `npm run site` when not).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_BYTES, REPORT_LINK, SiteError, buildSite, escapeHtml, markdownToHtml, nemotronView, newestResults, scanOutput, type BuildResult, type ExampleView, type JudgeSelectView } from "../scripts/build-site.ts";
import { templateById } from "../src/catalogue/templates.ts";
import { config } from "../src/config.ts";
import { DataLayer } from "../src/data/layer.ts";
import { ZetarisEngine } from "../src/data/engines/zetaris.ts";
import { sourceRows, sourcesMarkdown } from "../src/document/render.ts";
import { DQ_RULES, USL_NAME, USL_TABLES } from "../src/zetaris/setup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLES = path.join(ROOT, "examples");
/** The committed technician's lessons the committed examples and docs/ were built with (DRIFT_MEMORY_DIR=examples/memory). */
const STORE = path.join(EXAMPLES, "memory");
const tmp = mkdtempSync(path.join(os.tmpdir(), "drift-site-"));
const WORDS = [...new Set([...config.redactWords, ...config.exportDenyWords])];
/** ZETARIS_DATASOURCE: DRIFT, the default and .env.example's. */
const DS = config.zetaris.datasource;
/** The development run of 25 Oct 2026, the values the Nemotron tab's tests hold to whichever stamp is newest. */
const DEV = path.join(ROOT, "eval", "results", "2026-10-25T09-25-44Z");
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
  it("builds the three examples into index.html, .nojekyll and one data file each, written to the output directory", () => {
    expect([...built.files.keys()].sort()).toEqual([".nojekyll", "data/index.json", "data/orphans.json", "data/proxy-split.json", "data/wildcard-no-real-ip.json", "index.html"]);
    for (const name of built.files.keys()) expect(existsSync(path.join(tmp, "out", name))).toBe(true);
    expect(built.index.examples.map((e) => [e.dir, e.findings])).toEqual([["proxy-split", 1], ["wildcard-no-real-ip", 1], ["orphans", 7]]);
    // an exception in force gives ADOPT until its expiry: the wildcard and the three orphan vhosts the operator's lessons
    // scope are ADOPT; the three orphan records stay HOLD and the proxy_split, in two slices, ESCALATE, by policy
    expect(built.index.totals).toMatchObject({ examples: 3, findings: 9, verbs: { ADOPT: 4, HOLD: 3, ESCALATE: 2 } });
    expect(built.index.sample?.verbs).toEqual({ ADOPT: 23, HOLD: 3, ESCALATE: 1 });
    expect(built.index.examples.every((e) => e.reproduced)).toBe(true);
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

  it("every detector query and check carries the text the live pass sends to Zetaris: the shown SQL with each table named <datasource>.<table>", () => {
    const zetaris = new DataLayer(new ZetarisEngine());
    let queries = 0;
    for (const e of built.index.examples) {
      for (const f of example(e.dir).findings) {
        for (const q of [f.detection!, ...f.checks]) {
          queries++;
          expect(q.zetarisSql).toMatch(new RegExp(`\\bFROM ${DS}\\.\\w+`));
          expect(q.zetarisSql.replaceAll(`${DS}.`, "")).toBe(q.sql);
        }
        for (const c of f.checks) {
          const t = templateById(c.template)!;
          expect(c.zetarisSql).toBe(zetaris.render(t.sql, c.params));
          // one qualified name per {{t:table}} of the template
          expect(c.zetarisSql.split(`${DS}.`).length - 1).toBe([...t.sql.matchAll(/\{\{t:\w+\}\}/g)].length);
        }
        expect(f.judge).not.toHaveProperty("zetarisSql");
      }
    }
    expect(queries).toBe(9 + 33);
  });

  it("names Zetaris where the page opens, in the Sources tab and in the footer: the datasource, the semantic layer and its DQ rules, the parity test", () => {
    const html = built.files.get("index.html")!;
    const lede = /<p class="lede">([\s\S]*?)<\/p>/.exec(html)![1];
    for (const s of ["Zetaris Lightning SQL", `<code>${DS}</code> datasource`, `<code>${USL_NAME}</code> semantic layer`, "four DQ rules", "<code>test/parity.test.ts</code>"]) expect(lede).toContain(s);
    const src = panel("sources");
    expect(src).toContain(`Zetaris Lightning SQL over the <code>${DS}</code> datasource`);
    expect(src).toContain(`holds eleven entities (${USL_TABLES.map((t) => `<code>${t}</code>`).join(", ")})`);
    expect(src).toContain(`four DQ rules (${DQ_RULES.map((r) => `<code>${r.name}</code> on <code>${r.table}</code>`).join(", ")})`);
    expect(/<footer>[\s\S]*?<\/footer>/.exec(html)![0]).toContain(`<code>${DS}.&lt;table&gt;</code>`);
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
    // the header's Report link to the owner's report in the repository, then the four tabs
    expect([...html.matchAll(/\b(?:href|src|action)="([^"]*)"/g)].map((m) => m[1])).toEqual([REPORT_LINK, "#findings", "#document", "#sources", "#nemotron"]);
    expect([...html.matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['"data/index.json"', "e.file"]);
  });

  it("links the owner's report from the header, ../examples/report.html with one line saying what it is, outside the tab row the script drives", () => {
    const html = built.files.get("index.html")!;
    const header = /<header>[\s\S]*?<\/header>/.exec(html)![0];
    expect(REPORT_LINK).toBe("../examples/report.html");
    expect(existsSync(path.join(ROOT, "docs", REPORT_LINK))).toBe(true);
    expect(header).toContain(`<p class="report"><a href="${REPORT_LINK}">Report</a><br><span class="meta">The owner's report, <code>examples/report.html</code>: one HTML file over the same recorded bundle as the Document tab, opened from a clone of the repository.</span></p>`);
    const nav = /<nav class="tabs"[\s\S]*?<\/nav>/.exec(header)![0];
    expect(nav).not.toContain(REPORT_LINK);
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
    // the class table, then the semantic layer's: each a header row and a row per class or entity
    const [classes, usl] = src.split("<h3>The semantic layer in Zetaris</h3>");
    expect(count(classes, "<tr>")).toBe(rows.length + 1);
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
    expect(html).toContain('h("a", { href: "#nemotron" }, String(t.nemotron.calls))');
    expect(html).toContain('h("a", { href: "#nemotron" }, t.nemotron.rerunEqual + " / " + t.nemotron.judgeSelects)');
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

  it("over the development run of 25 Oct 2026: 389 calls, 383 receipts verified, 0 substitutions; 162 judge SELECTs, 161 re-run equal, the recorded text of 1 does not run", async () => {
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

  it(`stays under ${MAX_BYTES} bytes, page and data together, the whole document in the page`, () => {
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
