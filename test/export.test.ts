// The export deny-list probe (src/document/export.ts) and the scripts that write a file the operator publishes: one
// probe over every text before any is written, one refusal that names the count and the text and never the label,
// and the scripts that export through it and no copy of their own. The trace id a script names its trace by carries
// its process id (src/loop/trace.ts traceIdOf). Offline; nothing is written.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExportRefused, exportLabels, labelForms, labelsIn, probeExport } from "../src/document/export.ts";
import { countLabels } from "../src/redactor.ts";
import { traceIdOf } from "../src/loop/trace.ts";
import { FACTS_END, FACTS_START, examplesFacts } from "../scripts/examples.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = (f: string): string => readFileSync(path.join(ROOT, f), "utf8");

describe("the export deny-list probe", () => {
  // labels made up for the test, not the operator's list
  const labels = ["acme-internal", "Contoso Ltd"];

  it("passes clean texts and returns the number of labels probed", () => {
    expect(probeExport([["page", "every host is a pseudonym"], ["report", "<p>host-0a1b2c</p>"]], labels)).toBe(2);
    expect(probeExport([], labels)).toBe(2);
  });

  it("refuses the export on the first text that holds a label: the count and the text named, the label never", () => {
    const run = (): number => probeExport([["page", "clean"], ["report", "<p>ACME-INTERNAL and Contoso Ltd</p>"], ["executive report", "acme-internal"]], labels);
    expect(run).toThrow(ExportRefused);
    expect(run).toThrow("deny-list probe: 2 of 2 configured label(s) appear in the report; nothing written");
    try { run(); } catch (e) {
      expect((e as Error).message).not.toMatch(/acme|contoso/i);
      expect((e as Error).name).toBe("ExportRefused");
    }
  });

  it("the operator's list is REDACT_WORDS and EXPORT_DENY_WORDS, trimmed, each label once, a blank one dropped", () => {
    const list = exportLabels();
    expect(new Set(list).size).toBe(list.length);
    expect(list.every((l) => l.length > 0 && l === l.trim())).toBe(true);
    expect(exportLabels(["", "  ", "\t", "acme-internal", " acme-internal ", "Contoso Ltd"])).toEqual(["acme-internal", "Contoso Ltd"]);
    // a list of blanks probes nothing and refuses nothing: no blank label matches every text
    expect(probeExport([["report", "anything at all"]], ["", " "])).toBe(0);
  });

  it("matches as countLabels defines a match: case folded, standing on its own; a near miss or a label inside a longer word is no match", () => {
    const one = (text: string, label: string): number => labelsIn(text, [label]);
    // case: any case is the label
    expect([one("ACME-INTERNAL", "acme-internal"), one("Acme-Internal", "acme-internal"), one("contoso ltd", "Contoso Ltd")]).toEqual([1, 1, 1]);
    // standing on its own: punctuation, markup and line ends around it still count
    expect([one("(acme-internal)", "acme-internal"), one("<b>acme-internal</b>", "acme-internal"), one("x\nacme-internal\n", "acme-internal")]).toEqual([1, 1, 1]);
    // a substring of a longer word, or a near miss, is not the label
    expect([one("acme-internals", "acme-internal"), one("xacme-internal", "acme-internal"), one("acme-intern", "acme-internal"), one("acme internal", "acme-internal")]).toEqual([0, 0, 0, 0]);
    // the same rule countLabels applies to the plain form
    expect(Object.keys(countLabels("acme-internals", ["acme-internal"]))).toEqual([]);
    expect(Object.keys(countLabels("ACME-internal", ["acme-internal"]))).toEqual(["acme-internal"]);
  });

  it("finds a label as an export carries it: HTML-escaped as the reports escape a string, or URL-encoded in a link", () => {
    expect(labelForms("Smith & Sons")).toEqual(["Smith & Sons", "Smith &amp; Sons", "Smith%20%26%20Sons"]);
    expect(labelForms("acme-internal")).toEqual(["acme-internal"]);
    const run = (text: string, label: string) => () => probeExport([["report", text]], [label]);
    expect(run("<p>Smith &amp; Sons</p>", "Smith & Sons")).toThrow(ExportRefused);
    expect(run("<p>O&#39;Brien Hosting</p>", "O'Brien Hosting")).toThrow(ExportRefused);
    expect(run('<a href="https://x.example/?q=Contoso%20Ltd">x</a>', "Contoso Ltd")).toThrow(ExportRefused);
    expect(run("<p>&lt;acme&gt;</p>", "<acme>")).toThrow(ExportRefused);
    // one label in two forms is one label
    expect(run("Smith & Sons and Smith &amp; Sons", "Smith & Sons")).toThrow("deny-list probe: 1 of 1 configured label(s) appear in the report; nothing written");
  });

  it("the exports probe through it, and none keeps a copy of its own", () => {
    for (const f of ["scripts/examples.ts", "scripts/executive.ts", "scripts/document.ts"]) {
      const s = source(f);
      // the probe's result is the count of labels probed, named as one, and the line prints that count
      expect(s, f).toMatch(/const labelCount: number = probeExport\(\[\[/);
      expect(s, f).toContain("deny-list probe 0 of ${labelCount} label(s)");
      expect(s, f).not.toMatch(/countLabels\(/);
      // the refusal's words are the probe's own: no script builds a deny-list message of its own
      expect(s, f).not.toMatch(/deny-list probe: \$\{/);
    }
    // examples writes the owner's report and the executive report only after both pass
    const ex = source("scripts/examples.ts").replace(/\r\n/g, "\n");
    expect(ex.indexOf('probeExport([["report", html], ["executive report", ex.html]])')).toBeLessThan(ex.indexOf('writeFileSync(path.join(args.out!, "report.html"), html)'));
  });
});

describe("examples/README.md", () => {
  it("names every count and size in the table npm run examples writes, equal to the files on disk; its prose holds none", () => {
    const readme = source("examples/README.md").replace(/\r\n/g, "\n");
    const a = readme.indexOf(FACTS_START);
    const b = readme.indexOf(FACTS_END);
    expect(a).toBeGreaterThan(0);
    expect(readme.slice(a + FACTS_START.length + 1, b - 1), "examples/README.md's table is stale: run npm run examples").toBe(examplesFacts(path.join(ROOT, "examples")));
    // the prose around the table: no byte count, line count or rule count kept by hand
    const prose = readme.slice(0, a) + readme.slice(b);
    expect(prose).not.toMatch(/\d[\d,]*\s+(?:bytes|lines|rules|rows|lessons|findings|exceptions|queries)\b/);
  });
});

describe("a script's trace id", () => {
  it("is the prefix, the time, the process id and a per-process count, each in base 36: two processes, or two calls, in one millisecond write two files", () => {
    expect(traceIdOf("executive", 1_761_455_000_000, 4242)).toMatch(new RegExp(`^executive_${(1_761_455_000_000).toString(36)}_${(4242).toString(36)}_[0-9a-z]+$`));
    expect(traceIdOf("executive", 1, 2).replace(/_[0-9a-z]+$/, "")).not.toBe(traceIdOf("executive", 1, 3).replace(/_[0-9a-z]+$/, ""));
    // the same prefix, millisecond and process: the count tells them apart
    const ids = Array.from({ length: 50 }, () => traceIdOf("executive", 1_761_455_000_000, 4242));
    expect(new Set(ids).size).toBe(50);
    expect(traceIdOf("executive")).toMatch(new RegExp(`^executive_[0-9a-z]+_${process.pid.toString(36)}_[0-9a-z]+$`));
    expect(source("scripts/executive.ts")).toContain('new FileTracer(traceIdOf("executive"), { model: "none" })');
  });
});
