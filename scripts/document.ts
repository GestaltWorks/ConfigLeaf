// npm run document -- --tenant <id> [--bundle <file>] [--out <path>] [--help]
//
// The owner's document for one tenant (src/document/render.ts): one markdown page rendered from SQL through one
// DataLayer. Sample mode (SAMPLE_MODE=true, or --bundle): sql.js over the bundle (default sample/bundle.json); the
// pass (src/pipeline.ts) runs over it first, decided at the bundle's own instant (src/data/instant.ts) and recorded
// through a MemoryLedger into the same engine, so the page reads the dispositions that pass decided; default out
// examples/document.md. Live: the DataLayer over Zetaris, as scripts/zetaris-queries.ts builds it (every {{t:x}} is
// DRIFT.x); the dispositions are the ledger's (npm run pass writes them), and the pass runs over the same layer
// with no ledger for the class of each finding they name; default out document.md at the repository root. The pass
// runs with no technician memory, so the page depends on the rows alone.
// The page passes the deny-list probe (redactor.ts countLabels over REDACT_WORDS and EXPORT_DENY_WORDS) before it is
// written; one match and nothing is written. Prints the trace (one JSON line per step, also in logs/) and one
// summary line. Exit 0 when the page is written; 1 when a query fails or the probe refuses; 2 on a usage error.
// Measured 24 Oct 2026: over sample/bundle.json, examples/document.md, 144 lines, 27 findings open, 32 queries for the
// page after the pass's, about 2 s; live through Zetaris for client-1, 100 lines, no disposition on the latest
// passing runs, 223 queries with the pass's, 44 s, written to a path outside the repository with --out.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { config, redact } from "../src/config.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { ZetarisEngine } from "../src/data/engines/zetaris.ts";
import { decisionInstant } from "../src/data/instant.ts";
import { renderDocument } from "../src/document/render.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { runPass } from "../src/pipeline.ts";
import { TENANT } from "../src/policy/schema.ts";
import { countLabels } from "../src/redactor.ts";
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
  console.log("Renders the owner's document for one tenant from SQL: sql.js over a bundle in sample mode (SAMPLE_MODE=true or --bundle, default out examples/document.md), the Zetaris data layer live (default out document.md).");
  process.exit(0);
}
if (!args.tenant || !TENANT.test(args.tenant) || args.tenant === "*") {
  console.error(`document: --tenant is required: a tenant id ([A-Za-z0-9._-], up to 64)\n${USAGE}`);
  process.exit(2);
}
const tenant = args.tenant;
const sample = config.sampleMode || args.bundle !== undefined;
const out = path.resolve(ROOT, args.out ?? (sample ? path.join("examples", "document.md") : "document.md"));
// The pass and the reads call no model, so every trace line says so.
const tracer = new Tracer(`document_${Date.now().toString(36)}`, { model: "none" });

try {
  let layer: DataLayer;
  let source: string;
  let classes: Map<string, string>;
  if (sample) {
    const file = path.resolve(ROOT, args.bundle ?? path.join("sample", "bundle.json"));
    const bundle = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const engine = await SqlJsEngine.create();
    engine.loadBundle(bundle);
    layer = new DataLayer(engine);
    source = `sql.js over ${path.relative(ROOT, file).replace(/\\/g, "/")}`;
    const pass = await runPass(layer, { tracer, world: new DriftWorld("document"), ledger: new MemoryLedger(engine), decidedAt: decisionInstant(bundle) });
    classes = new Map(pass.findings.map((f) => [f.id, f.finding.class]));
  } else {
    layer = new DataLayer(new ZetarisEngine());
    source = `Zetaris over the ${config.zetaris.datasource} datasource`;
    const pass = await runPass(layer, { tracer, world: new DriftWorld("document") });
    classes = new Map(pass.findings.map((f) => [f.id, f.finding.class]));
  }
  const doc = await renderDocument(layer, { tenant, classes, source, tracer });
  const labels = [...config.redactWords, ...config.exportDenyWords];
  const hits = countLabels(doc.markdown, labels);
  if (Object.keys(hits).length) {
    console.error(`document: deny-list probe: ${Object.keys(hits).length} of ${labels.length} configured label(s) appear in the page; nothing written`);
    process.exit(1);
  }
  writeFileSync(out, doc.markdown);
  const rel = path.relative(ROOT, out).replace(/\\/g, "/");
  console.log(`document: ${rel} written for ${tenant}, ${doc.markdown.split("\n").length - 1} lines, ${doc.open} finding(s) open, ${doc.queries.reduce((n, c) => n + c.runs, 0)} queries; deny-list probe 0 of ${labels.length} label(s); ${doc.decidedAt ? `decided at ${doc.decidedAt}` : "no decision on the latest passing runs"}`);
} catch (e) {
  console.error(`document: ${redact((e as Error).message ?? String(e))}`);
  process.exitCode = 1;
}
