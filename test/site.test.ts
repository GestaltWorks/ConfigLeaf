// The replay page (scripts/build-site.ts): built from the three committed examples into a throwaway
// directory, it holds index.html and one data file per example; every check carries the SQL that ran,
// rendered, non-empty and re-run to the recorded count; the output passes the deny-list scan; a finding
// that cites a template the catalogue cannot render, or a count the re-run does not give, makes the build
// throw and write nothing; and the committed docs/ is exactly this build (rerun `npm run site` when not).
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_BYTES, SiteError, buildSite, scanOutput, type BuildResult, type ExampleView } from "../scripts/build-site.ts";
import { config } from "../src/config.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLES = path.join(ROOT, "examples");
const tmp = mkdtempSync(path.join(os.tmpdir(), "drift-site-"));
const WORDS = [...new Set([...config.redactWords, ...config.exportDenyWords])];

let built: BuildResult;
const example = (dir: string): ExampleView => JSON.parse(built.files.get(`data/${dir}.json`)!) as ExampleView;

beforeAll(async () => {
  built = await buildSite({ examplesDir: EXAMPLES, outDir: path.join(tmp, "out") });
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
    expect(built.index.totals).toMatchObject({ examples: 3, findings: 9, verbs: { HOLD: 7, ESCALATE: 2 } });
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
      }
    }
    // proxy-split 4, wildcard-no-real-ip 4 (its slice carries the audit run, so the two audit checks run and fail instead of being withheld), orphans 25
    expect(checks).toBe(33);
    expect(built.index.totals.checksRerun).toBe(checks);
  });

  it("shows the real 16 April record: proxy_split, ESCALATE once its HOLD under the policy expired, referent_unchanged fails on its three pieces of evidence, exposed since the 21:12:47 proxied=true body, 191 days", () => {
    const [f] = example("proxy-split").findings;
    expect([f.class, f.verb]).toEqual(["proxy_split", "ESCALATE"]);
    const ru = f.checks.find((c) => c.template === "referent_unchanged")!;
    expect([ru.holds, ru.rowCount, ru.rows?.rows.length]).toEqual([false, 3, 3]);
    expect(ru.sql).toContain("FROM dns_record a");
    expect(f.sample?.match).toBe("same");
    // the slice's DNS run is the latest DNS collection of the recorded bundle (24 Oct 2026), 191 whole days after the body
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
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import|url\(/i);
    expect(html).not.toMatch(/https?:\/\/(?!localhost)/);
    expect([...html.matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['"data/index.json"', "e.file"]);
  });

  it(`stays under ${MAX_BYTES} bytes, page and data together`, () => {
    expect(built.bytes).toBeLessThan(MAX_BYTES);
    expect(built.bytes).toBe([...built.files.values()].reduce((n, s) => n + Buffer.byteLength(s), 0));
  });

  it("the output passes the deny-list scan (the leak test's labels, the ssh aliases, the redactor over every data string)", () => {
    if (!WORDS.length) console.log("site: deny-list labels blank; the label half of the scan is empty, the redactor half runs");
    const report = scanOutput(built.files);
    expect(report.labels).toBe(WORDS.length);
    expect(report.leaves).toBeGreaterThan(1000);
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
