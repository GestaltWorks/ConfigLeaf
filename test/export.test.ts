// The export deny-list probe (src/document/export.ts) and the scripts that write a file the operator publishes: one
// probe over every text before any is written, one refusal that names the count and the text and never the label,
// and the scripts that export through it and no copy of their own. The trace id a script names its trace by carries
// its process id (src/loop/trace.ts traceIdOf). Offline; nothing is written.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExportRefused, exportLabels, probeExport } from "../src/document/export.ts";
import { traceIdOf } from "../src/loop/trace.ts";

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

  it("the operator's list is REDACT_WORDS and EXPORT_DENY_WORDS, each label once", () => {
    const list = exportLabels();
    expect(new Set(list).size).toBe(list.length);
  });

  it("the exports probe through it, and none keeps a copy of its own", () => {
    for (const f of ["scripts/examples.ts", "scripts/executive.ts", "scripts/document.ts"]) {
      const s = source(f);
      expect(s, f).toMatch(/probeExport\(\[\[/);
      expect(s, f).not.toMatch(/countLabels\(/);
      // the refusal's words are the probe's own: no script builds a deny-list message of its own
      expect(s, f).not.toMatch(/deny-list probe: \$\{/);
    }
    // examples writes the owner's report and the executive report only after both pass
    const ex = source("scripts/examples.ts").replace(/\r\n/g, "\n");
    expect(ex.indexOf('probeExport([["report", html], ["executive report", ex.html]])')).toBeLessThan(ex.indexOf('writeFileSync(path.join(args.out!, "report.html"), html)'));
  });
});

describe("a script's trace id", () => {
  it("is the prefix, the time and the process id, each in base 36: two processes in one millisecond write two files", () => {
    expect(traceIdOf("executive", 1_761_455_000_000, 4242)).toBe(`executive_${(1_761_455_000_000).toString(36)}_${(4242).toString(36)}`);
    expect(traceIdOf("executive", 1, 2)).not.toBe(traceIdOf("executive", 1, 3));
    expect(traceIdOf("executive")).toMatch(new RegExp(`^executive_[0-9a-z]+_${process.pid.toString(36)}$`));
    expect(source("scripts/executive.ts")).toContain('new FileTracer(traceIdOf("executive"), { model: "none" })');
  });
});
