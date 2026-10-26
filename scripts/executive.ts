// npm run report:executive -- [--tenant <id>] [--period 7d|30d|all] [--out <file>] [--bundle <file>] [--help]
//
// The executive report (src/document/executive.ts) as one standalone HTML file: inline CSS and SVG, no script,
// nothing loaded from outside, for a CISO or a CTO to read, print to PDF or forward.
//
//   sample mode   SAMPLE_MODE=true or --bundle: sql.js over the bundle (default sample/bundle.json) with the file tables,
//                 the lessons of DRIFT_MEMORY_DIR (examples/memory when blank) read only, the pass and the explain step
//                 recorded into the same engine (src/document/sample.ts sampleExecutive), the period ending at the
//                 decision instant, BUNDLE_REDACTOR; the tenant --tenant, else the tenant of the bundle's latest DNS run;
//                 out --out, else examples/executive.html, the committed file (client-1, the last 7 days), which
//                 test/executive.test.ts holds equal to this render.
//   live          the Zetaris data layer for --tenant (required), a pass that records nothing for the classes, the
//                 period ending now, the tenant's redactor; out --out, else executive.html at the repository root.
//
// The file passes the deny-list probe (REDACT_WORDS and EXPORT_DENY_WORDS) before it is written, and stays under
// EXECUTIVE_MAX_BYTES. Prints one line naming the file, its bytes, the period and its counts.
// Exit 2 on a usage error or live without REDACT_SALT or ZETARIS_API_KEY; 1 when the probe refuses or a step fails.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { config, redact } from "../src/config.ts";
import { CountingEngine } from "../src/data/engines/counting.ts";
import { ZetarisEngine } from "../src/data/engines/zetaris.ts";
import { DataLayer } from "../src/data/layer.ts";
import { EXECUTIVE_MAX_BYTES, PERIODS, PERIOD_WORD, evalReceipts, isPeriod, readExecutive, renderExecutive, type Executive } from "../src/document/executive.ts";
import { renderDocument } from "../src/document/render.ts";
import { repoTip } from "../src/document/report.ts";
import { sampleExecutive, textSha256 } from "../src/document/sample.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { runPass } from "../src/pipeline.ts";
import { TENANT } from "../src/policy/schema.ts";
import { Redactor, countLabels } from "../src/redactor.ts";
import { FileTracer } from "../src/loop/trace.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const USAGE = "usage: npm run report:executive -- [--tenant <id>] [--period 7d|30d|all] [--out <file>] [--bundle <file>] [--help]";

function usage(msg: string): never {
  console.error(`executive: ${msg}\n${USAGE}`);
  process.exit(2);
}

let args: { tenant?: string; period?: string; out?: string; bundle?: string; help?: boolean };
try {
  args = parseArgs({ options: { tenant: { type: "string" }, period: { type: "string" }, out: { type: "string" }, bundle: { type: "string" }, help: { type: "boolean" } } }).values;
} catch (e) {
  usage((e as Error).message);
}
if (args.help) {
  console.log(USAGE);
  console.log("Writes the executive report for one tenant as a standalone HTML file: six KPIs, four charts with their data, the incidents of the period, the sources and DQ gates, and the receipts. SAMPLE_MODE=true (or --bundle) reads the recorded bundle on sql.js and writes examples/executive.html by default.");
  process.exit(0);
}
const period = args.period ?? "7d";
if (!isPeriod(period)) usage(`--period is ${PERIODS.join(", ")}, got ${period}`);
if (args.tenant !== undefined && (!TENANT.test(args.tenant) || args.tenant === "*")) usage(`a tenant id is [A-Za-z0-9._-], up to 64, got ${args.tenant}`);
const sample = config.sampleMode || args.bundle !== undefined;
const rel = (p: string): string => path.relative(ROOT, p).replace(/\\/g, "/");
// the trace goes to logs/ only, one line per query, as the sample pass writes it
const tracer = new FileTracer(`executive_${Date.now().toString(36)}`, { model: "none" });

try {
  let html: string;
  let x: Executive;
  let tenant: string;
  let out: string;
  if (sample) {
    const file = path.resolve(ROOT, args.bundle ?? path.join("sample", "bundle.json"));
    const text = readFileSync(file, "utf8");
    const bundle = JSON.parse(text) as Record<string, unknown>;
    const runs = (bundle.collection_run ?? []) as { tenant_id: string; surface: string; started_at: string }[];
    tenant = args.tenant ?? [...runs].filter((r) => r.surface === "cloudflare.dns").sort((a, b) => (a.started_at < b.started_at ? -1 : 1)).at(-1)?.tenant_id ?? "";
    if (!tenant) usage(`${rel(file)} holds no DNS run, so no default tenant: --tenant names one`);
    if (!runs.some((r) => r.tenant_id === tenant)) usage(`${rel(file)} holds no run of tenant ${tenant}`);
    out = path.resolve(ROOT, args.out ?? path.join("examples", "executive.html"));
    ({ html, executive: x } = await sampleExecutive(bundle, { tenant, memory: new TechnicianMemory({ storage: "read" }), source: `sql.js over ${rel(file)}`, period, file: { path: rel(file), sha256: textSha256(text) }, tracer }));
  } else {
    if (!args.tenant) usage("live mode needs --tenant <id>");
    if (!config.redactSalt) usage("REDACT_SALT is blank: the report's rows carry the tenant's pseudonyms under its salt");
    if (!config.zetaris.apiKey) usage("ZETARIS_API_KEY is blank: the report reads through Zetaris");
    tenant = args.tenant;
    out = path.resolve(ROOT, args.out ?? "executive.html");
    const layer = new DataLayer(new CountingEngine(new ZetarisEngine()));
    const pass = await runPass(layer, { tracer, world: new DriftWorld("executive") });
    const classes = new Map(pass.findings.map((f) => [f.id, f.finding.class]));
    const doc = await renderDocument(layer, { tenant, classes, source: `Zetaris over the ${config.zetaris.datasource} datasource`, tracer, report: true });
    x = await readExecutive(layer, doc.data, { tenant, period, at: new Date().toISOString(), classes, receipts: evalReceipts(ROOT), tracer });
    html = renderExecutive(x, { redactor: new Redactor(config.redactSalt, config.redactWords), policyFile: config.policyFile, tip: repoTip(ROOT) });
  }
  const labels = [...config.redactWords, ...config.exportDenyWords];
  const hits = Object.keys(countLabels(html, labels)).length;
  if (hits) {
    console.error(`executive: deny-list probe: ${hits} of ${labels.length} configured label(s) appear in the report; nothing written`);
    process.exit(1);
  }
  const bytes = Buffer.byteLength(html);
  if (bytes > EXECUTIVE_MAX_BYTES) {
    console.error(`executive: the report is ${bytes} bytes, over the ${EXECUTIVE_MAX_BYTES}-byte budget; nothing written`);
    process.exit(1);
  }
  writeFileSync(out, html);
  const k = x.kpis;
  console.log(`executive: ${rel(out)} written for ${tenant}, ${PERIOD_WORD[period]} to ${x.at} (${x.days.length} days), ${bytes} bytes; ${k.driftEvents} drift event(s), ${x.incidentCount} incident(s), ${k.actions.total} action(s), coverage ${k.covered} of ${k.objects} objects; deny-list probe 0 of ${labels.length} label(s)`);
} catch (e) {
  console.error(`executive: ${redact((e as Error).message ?? String(e))}`);
  process.exitCode = 1;
}
