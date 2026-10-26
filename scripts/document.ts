// npm run document -- --tenant <id> [--bundle <file>] [--out <path>] [--help]
//
// The owner's document for one tenant (src/document/render.ts): one markdown page rendered from SQL through one
// DataLayer, and the owner's report beside it (src/document/report.ts, report.html), one static HTML file rendered
// from the same rows. Sample mode (SAMPLE_MODE=true, or --bundle): sql.js over the bundle (default sample/bundle.json)
// through src/document/sample.ts renderSample: the pass (src/pipeline.ts) runs over it first with the technician's
// lessons read from the store DRIFT_MEMORY_DIR names, as the live pass reads them, decided at the bundle's own instant
// or the latest lesson's when that is later (src/data/instant.ts decisionInstantWith) and recorded through a
// MemoryLedger into the same engine, so the page reads the dispositions that pass decided, then the explain step over
// that pass as npm run sample runs it (no vault, BUNDLE_REDACTOR), so the page's Why reads its causes; default out
// examples/document.md and examples/report.html, the report with no clock, trace or tip in it (sampleReport). Live:
// the DataLayer over Zetaris, as scripts/zetaris-queries.ts builds it (every {{t:x}} is DRIFT.x), counted so the
// report names the queries sent; the dispositions are the ledger's (npm run pass writes them, with the lessons), and
// the pass runs over the same layer with no ledger and no memory for the class of each finding they name; default out
// document.md and report.html at the repository root, the report through the tenant's redactor with this run's trace
// and the repository's tip.
// The page and the report pass the deny-list probe (src/document/export.ts probeExport: REDACT_WORDS, EXPORT_DENY_WORDS)
// before either is written; one match and nothing is written. Prints the trace (one JSON line per step, also in logs/)
// and one summary line. Exit 0 when both are written; 1 when a query fails or the probe refuses; 2 on a usage error.
// Measured 25 Oct 2026: over sample/bundle.json at 02:07 UTC, examples/document.md, 178 lines with "Where each answer
// comes from", 27 findings open, 37 queries for the page after the pass's, decided at 2026-10-25T01:45:33.962Z (the
// bundle's instant), 2.4 s, byte-identical on a second render; as the document step of the 01:16 UTC cycle, live
// through Zetaris, 152 lines (before that section), 27 findings open, 37 queries.
// Measured 24 Oct 2026 as the document step of the 23:36 UTC cycle, live through Zetaris for client-1: document.md at
// the repository root, 150 lines, 27 findings open, 37 queries, 6.5 s.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { config, redact } from "../src/config.ts";
import { DataLayer } from "../src/data/layer.ts";
import { CountingEngine } from "../src/data/engines/counting.ts";
import { ZetarisEngine } from "../src/data/engines/zetaris.ts";
import { renderDocument, type DocumentResult } from "../src/document/render.ts";
import { REPORT_MODE, renderReport, repoTip, reportPathOf } from "../src/document/report.ts";
import { renderSample, sampleReport, textSha256 } from "../src/document/sample.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { runPass } from "../src/pipeline.ts";
import { TENANT } from "../src/policy/schema.ts";
import { Redactor } from "../src/redactor.ts";
import { probeExport } from "../src/document/export.ts";
import { Tracer } from "../src/trace.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const USAGE = "usage: npm run document -- --tenant <id> [--bundle <file>] [--out <path>] [--help]";

let args: { tenant?: string; bundle?: string; out?: string; help?: boolean };
try {
  args = parseArgs({ options: { tenant: { type: "string" }, bundle: { type: "string" }, out: { type: "string" }, help: { type: "boolean" } } }).values;
} catch (e) {
  console.error(`document: ${(e as Error).message}\n${USAGE}`);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  console.log("Renders the owner's document for one tenant from SQL, and the owner's report (report.html) beside it from the same rows: sql.js over a bundle in sample mode (SAMPLE_MODE=true or --bundle, default out examples/document.md and examples/report.html), the Zetaris data layer live (default out document.md and report.html).");
  process.exit(0);
}
if (!args.tenant || !TENANT.test(args.tenant) || args.tenant === "*") {
  console.error(`document: --tenant is required: a tenant id ([A-Za-z0-9._-], up to 64)\n${USAGE}`);
  process.exit(2);
}
const tenant = args.tenant;
const sample = config.sampleMode || args.bundle !== undefined;
const out = path.resolve(ROOT, args.out ?? (sample ? path.join("examples", "document.md") : "document.md"));
const reportOut = reportPathOf(out);
const rel = (p: string): string => path.relative(ROOT, p).replace(/\\/g, "/");
// The pass and the reads call no model, so every trace line says so.
const tracer = new Tracer(`document_${Date.now().toString(36)}`, { model: "none" });

try {
  let doc: DocumentResult;
  let html: string;
  if (sample) {
    const file = path.resolve(ROOT, args.bundle ?? path.join("sample", "bundle.json"));
    const text = readFileSync(file, "utf8");
    const r = await renderSample(JSON.parse(text) as Record<string, unknown>, { tenant, memory: new TechnicianMemory({ storage: "read" }), source: `sql.js over ${rel(file)}`, tracer });
    doc = r.doc;
    html = sampleReport(doc, r.pass.findings, { path: rel(file), sha256: textSha256(text) });
  } else {
    const counting = new CountingEngine(new ZetarisEngine());
    const layer = new DataLayer(counting);
    const pass = await runPass(layer, { tracer, world: new DriftWorld("document") });
    doc = await renderDocument(layer, { tenant, classes: new Map(pass.findings.map((f) => [f.id, f.finding.class])), source: `Zetaris over the ${config.zetaris.datasource} datasource`, tracer, report: true });
    const sent = counting.tally();
    html = renderReport(doc.data, {
      redactor: new Redactor(config.redactSalt || "document-report", config.redactWords), mode: REPORT_MODE.dryRun,
      trace: { id: tracer.traceId, path: rel(path.resolve(ROOT, config.logDir, `${tracer.traceId}.jsonl`)) }, tip: repoTip(ROOT), policyFile: config.policyFile,
      findings: pass.findings.filter((f) => f.finding.tenant_id === tenant),
      zetaris: { datasource: config.zetaris.datasource, queries: sent.queries, rows: sent.rows, failed: sent.failed },
    });
  }
  const labelCount: number = probeExport([["page", doc.markdown], ["report", html]]);
  writeFileSync(out, doc.markdown);
  writeFileSync(reportOut, html);
  console.log(`document: ${rel(out)} written for ${tenant}, ${doc.markdown.split("\n").length - 1} lines, ${doc.open} finding(s) open, ${doc.queries.reduce((n, c) => n + c.runs, 0)} queries; ${rel(reportOut)} ${Buffer.byteLength(html)} bytes; deny-list probe 0 of ${labelCount} label(s); ${doc.decidedAt ? `decided at ${doc.decidedAt}` : "no decision on the latest passing runs"}`);
} catch (e) {
  console.error(`document: ${redact((e as Error).message ?? String(e))}`);
  process.exitCode = 1;
}
