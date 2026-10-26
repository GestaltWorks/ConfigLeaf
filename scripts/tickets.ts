// npm run tickets -- --tenant <id> [--dry-run] [--bundle <file>] [--schema <name>] [--verbose|--quiet] [--help]
//
// The ticket step (src/psa/step.ts) for one tenant: tickets opened, commented on and closed for the dispositions
// and actions that call for them (src/psa/index.ts, the opening rules), one GitHub issue per ticket row.
//   live         the DataLayer over ZetarisEngine for every read; the pass (src/pipeline.ts) run once more, read
//                only (no ledger, no memory, untraced), for each finding's summary, checks and exposure; the
//                ledger's dispositions and actions decide; GitHub Issues on DRIFT_TICKETS_REPO with the token
//                `gh auth token` prints, read once into memory; ticket rows through the Store (DATABASE_URL;
//                --schema for another search_path).
//   SAMPLE_MODE  sql.js over sample/bundle.json (or --bundle), the pass with a MemoryLedger at the bundle's
//                instant (src/data/instant.ts), always a dry run.
// Prints the cycle's tickets section (src/loop/present.ts): the header, the tickets row (what was sent, or "nothing
// to send" with the open count) with one line per ticket, and the done line naming the trace
// (logs/tickets_<base36 ms>.jsonl). --verbose adds the full output: one line per operation (a dry run's create with
// its title, labels and body indented below it) and the TICKETS summary line; --quiet prints the header and the done
// line. --dry-run plans and sends and writes nothing. Every printed string is redacted; everything sent passes the
// redactor and the deny-list probe first.
// Exit 0 when every operation went through (or was planned), 1 when one failed or was refused, or a read failed;
// 2 on a usage error, a blank REDACT_SALT for a write, or a blank or malformed DRIFT_TICKETS_REPO.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { config, redact } from "../src/config.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { ZetarisEngine } from "../src/data/engines/zetaris.ts";
import { decisionInstant } from "../src/data/instant.ts";
import { Store } from "../src/data/store.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { runPass } from "../src/pipeline.ts";
import { TENANT_ID, TENANT_ID_SHAPE } from "../src/policy/schema.ts";
import { MODE, Table, presentOptions, ticketsView } from "../src/loop/present.ts";
import { labelledRows } from "../src/loop/steps.ts";
import { FileTracer, LabelTracer } from "../src/loop/trace.ts";
import { GithubIssues } from "../src/psa/github.ts";
import { storeTicketRows, ticketStep } from "../src/psa/step.ts";
import { Redactor } from "../src/redactor.ts";
import { exitOnConfigError } from "../src/cli.ts";

exitOnConfigError();

const USAGE = "usage: npm run tickets -- --tenant <id> [--dry-run] [--bundle <file>] [--schema <name>] [--verbose|--quiet] [--help]";

function usage(msg: string): never {
  console.error(`tickets: ${msg}\n${USAGE}`);
  process.exit(2);
}

let args: { tenant?: string; "dry-run"?: boolean; bundle?: string; schema?: string; verbose?: boolean; quiet?: boolean; help?: boolean };
try {
  args = parseArgs({
    options: { tenant: { type: "string" }, "dry-run": { type: "boolean" }, bundle: { type: "string" }, schema: { type: "string" }, verbose: { type: "boolean" }, quiet: { type: "boolean" }, help: { type: "boolean" } },
  }).values;
} catch (e) {
  usage((e as Error).message);
}
if (args.help) {
  console.log(USAGE);
  console.log("Opens, comments on and closes PSA tickets (GitHub Issues) for the tenant's dispositions and actions. --dry-run prints the plan and sends nothing; SAMPLE_MODE=true plans over sample/bundle.json (or --bundle) and is always a dry run.");
  process.exit(0);
}
if (!args.tenant || !TENANT_ID.test(args.tenant)) usage(`--tenant is required: ${TENANT_ID_SHAPE}`);
if (args.verbose && args.quiet) usage("--verbose and --quiet exclude each other");
if (args.bundle !== undefined && !config.sampleMode) usage("--bundle needs SAMPLE_MODE=true");
const tenant = args.tenant;
const dryRun = args["dry-run"] === true || config.sampleMode;
if (!dryRun && !config.redactSalt) usage("REDACT_SALT is blank: what the step sends and stores carries the tenant's pseudonyms only under its salt (set it in .env, or run with --dry-run)");

const salt = config.redactSalt || randomBytes(16).toString("hex");
const redactor = new Redactor(salt, config.redactWords);
const deny = [...new Set([...config.redactWords, ...config.exportDenyWords])];
// the cycle's tickets step does the same (src/loop/steps.ts): the PSA's url names the tickets repository, whose owner
// can be an EXPORT_DENY_WORDS label, so the stored urls, the trace lines and stdout go through REDACT_WORDS and
// EXPORT_DENY_WORDS together
const labels = new Redactor(salt, deny);
const fileTracer = new FileTracer(`tickets_${Date.now().toString(36)}`, { model: "none" });
const trace = fileTracer.logFile.replace(/\\/g, "/");
const tracer = new LabelTracer(fileTracer, labels);
const present = presentOptions(args);
const table = new Table(present, (s) => labels.text(redact(s)));
// each operation's line (a dry run's bodies included) is the verbose output, printed after the step's row
const opLines: string[] = [];
const print = (l: string): void => { if (present.verbose) opLines.push(labels.text(l)); };
const t0 = Date.now();
console.log(table.header({ command: "tickets", tenant, at: new Date(t0), mode: dryRun ? (config.sampleMode ? `dry run over ${args.bundle ?? "sample/bundle.json"}` : MODE.dryRun) : MODE.applied }));

let store: Store | undefined;
let engine: SqlJsEngine | undefined;
try {
  let layer: DataLayer;
  let pass;
  if (config.sampleMode) {
    const file = args.bundle ?? "sample/bundle.json";
    const bundle = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    engine = await SqlJsEngine.create();
    engine.loadBundle(bundle);
    layer = new DataLayer(engine);
    pass = await runPass(layer, { world: new DriftWorld("tickets"), ledger: new MemoryLedger(engine), decidedAt: decisionInstant(bundle) });
    tracer.emit({ agent: "psa", action: "observe", status: "ok", input_summary: `tickets ${tenant} sample`, output_summary: `the pass over ${file}: ${pass.findings.length} finding(s), ledger ${pass.ledger?.dispositions ?? 0} disposition(s)`, detail: "model: none (sample mode: sql.js, a MemoryLedger, always a dry run)" });
  } else {
    layer = new DataLayer(new ZetarisEngine());
    pass = await runPass(layer, { world: new DriftWorld("tickets") });
    tracer.emit({ agent: "psa", action: "observe", status: "ok", input_summary: `tickets ${tenant} live`, output_summary: `the pass re-run read only for the evidence: ${pass.findings.length} finding(s), ${pass.gatedOut.length} run(s) gated out`, detail: "model: none (no ledger, no memory; the ledger's dispositions decide)" });
  }
  const adapter = dryRun ? null : new GithubIssues({ redactor, deny });
  if (!dryRun) store = Store.fromEnv({ schema: args.schema });
  const result = await ticketStep(layer, pass, adapter, store ? labelledRows(storeTicketRows(store), labels) : null, { tenant, dryRun, redactor, deny, tracer, print });
  const ms = Date.now() - t0;
  if (!present.quiet) for (const l of table.row("tickets", ticketsView(result, dryRun), ms)) console.log(l);
  if (present.verbose) for (const l of [...opLines, labels.text(result.summary)]) console.log(l);
  const bad = result.outcomes.some((o) => o.status === "failed" || o.status === "refused");
  console.log(table.done({ ms, trace, ...(bad ? { stopped: { step: "tickets", at: 1, of: 1 } } : {}) }));
  process.exitCode = bad ? 1 : 0;
} catch (e) {
  const msg = labels.text(redact((e as Error)?.message ?? String(e)));
  const ms = Date.now() - t0;
  if (present.quiet) console.error(`tickets: ${msg}`);
  else console.log(table.failed("tickets", msg, ms));
  console.log(table.done({ ms, trace, stopped: { step: "tickets", at: 1, of: 1 } }));
  process.exitCode = /DRIFT_TICKETS_REPO/.test(msg) ? 2 : 1;
} finally {
  engine?.close();
  await store?.close();
}
