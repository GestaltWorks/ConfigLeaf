// npm run pass -- --tenant <id> [--decided-at <ISO 8601 UTC>] [--no-ledger] [--schema <name>] [--verbose|--quiet] [--help]
//
// The live pass (src/pipeline.ts, through src/loop/pass.ts) for one tenant: the DataLayer over ZetarisEngine (every
// {{t:x}} is DRIFT.x, the judged data layer), the PgLedger over the Store (DATABASE_URL; --schema for another
// search_path) for the tenant's dispositions and referent fingerprints, the technician's lessons read from the store
// DRIFT_MEMORY_DIR names (read only), the trace to logs/pass_<base36 ms>.jsonl. Prints the cycle's pass section
// (src/loop/present.ts): the header (mode "recorded", or "dry run" with --no-ledger), the pass row with its findings
// by verb, the classes and one line per ROLLBACK, FIX and ESCALATE, and the done line naming the trace. --verbose
// adds the full output: one JSON object per finding of the tenant, one DISPOSITION line per finding as the ledger
// holds it (read back through Zetaris), the PASS summary line and the trace file; --quiet prints the header and the
// done line. --decided-at dates every disposition and starts every HOLD expiry (default: the system clock).
// --no-ledger records nothing and prints the pass's own decisions.
// Exit 0 when the pass ran; 1 when a read or the ledger write failed; 2 on a usage error, SAMPLE_MODE, a blank
// ZETARIS_API_KEY, or for the ledger a blank REDACT_SALT or DATABASE_URL.
//
// Measured 24 Oct 2026 for client-1 through Zetaris: at 23:20 UTC with --no-ledger, 14 collection runs of the tenant,
// 0 failed the DQ gate, 3,186 observations, 27 findings (orphan_record 3, orphan_vhost 3, proxied_without_real_ip 20,
// proxy_split 1), HOLD 27 by policy, 443 trace lines, 34.9 s; at 23:21 UTC, the first pass with the PgLedger, the same
// findings and verbs, 27 dispositions and 315 referent fingerprints written to the app Postgres, all 27 read back
// through Zetaris, decided at 2026-10-24T23:21:06.870Z, 444 trace lines, 34.2 s.

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { config, redact } from "../src/config.ts";
import { DataLayer } from "../src/data/layer.ts";
import { ZetarisEngine } from "../src/data/engines/zetaris.ts";
import { Store } from "../src/data/store.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";
import { PgLedger } from "../src/ledger.ts";
import { passStep } from "../src/loop/pass.ts";
import { Table, passView, presentOptions } from "../src/loop/present.ts";
import { FileTracer } from "../src/loop/trace.ts";
import { TENANT } from "../src/policy/schema.ts";
import { Redactor } from "../src/redactor.ts";

const USAGE = "usage: npm run pass -- --tenant <id> [--decided-at <ISO 8601 UTC>] [--no-ledger] [--schema <name>] [--verbose|--quiet] [--help]";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;

function usage(msg: string): never {
  console.error(`pass: ${msg}\n${USAGE}`);
  process.exit(2);
}

let args: { tenant?: string; "decided-at"?: string; "no-ledger"?: boolean; schema?: string; verbose?: boolean; quiet?: boolean; help?: boolean };
try {
  args = parseArgs({
    options: { tenant: { type: "string" }, "decided-at": { type: "string" }, "no-ledger": { type: "boolean" }, schema: { type: "string" }, verbose: { type: "boolean" }, quiet: { type: "boolean" }, help: { type: "boolean" } },
  }).values;
} catch (e) {
  usage((e as Error).message);
}
if (args.help) {
  console.log(USAGE);
  console.log("Runs the live pass for one tenant through Zetaris and records its dispositions and referent fingerprints in the app Postgres (--no-ledger records nothing).");
  process.exit(0);
}
if (!args.tenant || !TENANT.test(args.tenant) || args.tenant === "*") usage("--tenant is required: a tenant id ([A-Za-z0-9._-], up to 64)");
if (args.verbose && args.quiet) usage("--verbose and --quiet exclude each other");
const decidedAt = args["decided-at"];
if (decidedAt !== undefined && (!ISO.test(decidedAt) || Number.isNaN(Date.parse(decidedAt)))) usage(`--decided-at takes an ISO 8601 UTC instant such as 2026-10-24T22:00:00.000Z, got ${decidedAt}`);
if (config.sampleMode) usage("the pass reads the live datasource through Zetaris; SAMPLE_MODE=true npm run sample is the pass over the recorded bundle");
if (!config.zetaris.apiKey) usage("ZETARIS_API_KEY is blank: the live pass reads through Zetaris");
const record = args["no-ledger"] !== true;
if (record && !config.redactSalt) usage("REDACT_SALT is blank: the ledger's rows carry the tenant's pseudonyms under its salt (or run with --no-ledger)");
if (record && !process.env.DATABASE_URL) usage("DATABASE_URL is blank: the ledger writes to the app Postgres (or run with --no-ledger)");

const tenant = args.tenant;
const redactor = new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords);
const tracer = new FileTracer(`pass_${Date.now().toString(36)}`, { model: "none" });
const trace = tracer.logFile.replace(/\\/g, "/");
const present = presentOptions(args);
const table = new Table(present, (s) => redactor.text(redact(s)));
const t0 = Date.now();
console.log(table.header({ command: "pass", tenant, at: new Date(t0), mode: record ? "recorded" : "dry run" }));
let store: Store | null = null;
try {
  store = record ? Store.fromEnv({ schema: args.schema }) : null;
  const layer = new DataLayer(new ZetarisEngine());
  const r = await passStep(layer, { tenant, ledger: store ? new PgLedger(store) : null, memory: new TechnicianMemory({ storage: "read" }), decidedAt, tracer });
  const ms = Date.now() - t0;
  if (!present.quiet) for (const l of table.row("pass", passView(r), ms)) console.log(l);
  if (present.verbose) {
    for (const l of r.lines) console.log(redactor.text(l));
    console.log(redactor.text(r.summary));
    console.log(`pass: trace ${trace} (${tracer.lines} lines), ${(ms / 1000).toFixed(1)} s`);
  }
  console.log(table.done({ ms, trace }));
} catch (e) {
  const msg = redactor.text(redact((e as Error)?.message ?? String(e)));
  const ms = Date.now() - t0;
  if (present.quiet) console.error(`pass: ${msg}`);
  else console.log(table.failed("pass", msg, ms));
  console.log(table.done({ ms, trace, stopped: { step: "pass", at: 1, of: 1 } }));
  process.exitCode = 1;
} finally {
  await store?.close();
}
