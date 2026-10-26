// npm run preflight -- --proposal <file> [--bundle sample/bundle.json] [--out <file>] [--quiet] [--live]
// Pre-flight one proposed change (src/preflight): bind it to the latest passing run, simulate it as a
// derived table over the same rows, run the whole pass in that world, compare with the baseline, and
// answer GO, NO-GO, GO-IF or ESCALATE. Prints the verdict as JSON and one markdown paragraph. Nothing
// is written to any table; the trace goes to logs/<id>.jsonl (and stdout, unless --quiet).
//
// Default: sql.js over --bundle (sample/bundle.json: the recorded, redacted rows), judge skipped, every
// trace line model_requested: none. --live: the Zetaris engine over the registered datasource, and the
// judge's falsifier in the fixed world when a Nightshift token is configured and SAMPLE_MODE is not set.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "../src/config.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { ZetarisEngine } from "../src/data/engines/zetaris.ts";
import { describeVerdict, runPreflight } from "../src/preflight/run.ts";
import { Tracer, type TraceEvent } from "../src/trace.ts";
import { exitOnConfigError } from "../src/cli.ts";

exitOnConfigError();

const { values: args } = parseArgs({
  options: {
    proposal: { type: "string" },
    bundle: { type: "string", default: "sample/bundle.json" },
    out: { type: "string" },
    quiet: { type: "boolean", default: false },
    live: { type: "boolean", default: false },
  },
});

if (!args.proposal) {
  console.error("usage: npx tsx scripts/preflight.ts --proposal <file> [--bundle sample/bundle.json] [--out <file>] [--quiet] [--live]");
  process.exit(2);
}

/** The real Tracer minus stdout: the file still gets every line. */
class FileTracer extends Tracer {
  private readonly path: string;
  constructor(traceId: string, opts: { model?: string }) {
    super(traceId, opts);
    mkdirSync(config.logDir, { recursive: true });
    this.path = path.join(config.logDir, `${traceId}.jsonl`);
  }
  override emit(e: Omit<TraceEvent, "ts" | "trace_id">): TraceEvent {
    const full = this.build(e);
    appendFileSync(this.path, `${JSON.stringify(full)}\n`);
    return full;
  }
}

const live = args.live && !config.sampleMode;
const judged = live && config.nightshift.token !== "";
const traceId = `preflight_${Date.now().toString(36)}`;
const tracer = args.quiet ? new FileTracer(traceId, judged ? {} : { model: "none" }) : new Tracer(traceId, judged ? {} : { model: "none" });

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(args.proposal, "utf8"));
} catch (err) {
  // An unreadable or non-JSON file is a rejected proposal, not a crash: the verdict says so and it is counted.
  raw = { _error: `cannot read ${args.proposal}: ${(err as Error).message}` };
}

let layer: DataLayer;
let engine: SqlJsEngine | undefined;
if (live) {
  layer = new DataLayer(new ZetarisEngine());
  tracer.emit({ agent: "preflight", action: "observe", status: "ok", output_summary: `live: Zetaris datasource ${config.zetaris.datasource}; judge ${judged ? "on" : "off (no Nightshift token)"}` });
} else {
  engine = await SqlJsEngine.create();
  const counts = engine.loadBundle(JSON.parse(readFileSync(args.bundle, "utf8")));
  layer = new DataLayer(engine);
  tracer.emit({ agent: "preflight", action: "observe", status: "ok", output_summary: `${args.bundle} loaded into sql.js: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(", ")}`, detail: "model: none (recorded, redacted rows); judge skipped" });
}

const t0 = Date.now();
const result = await runPreflight(raw, layer, { tracer, judge: judged ? undefined : "skip" });
const elapsed = Date.now() - t0;
engine?.close();

const json = JSON.stringify({ ...result, trace_id: traceId, elapsed_ms: elapsed }, null, 2);
if (args.out) {
  mkdirSync(path.dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${json}\n`);
}
console.log(json);
console.log("");
console.log(describeVerdict(result));
