// npm run probe -- --tenant <id> [--only http|dns|tls] [--schema <name>] [--dry-run] [--help]
//
// One probe run for one tenant (src/probe/run.ts): the account's A, AAAA and CNAME names read live from
// the Cloudflare API (CLOUDFLARE_API_TOKEN, read only), wildcards left out, then an http, a dns and a tls
// probe per name from this machine, four in flight. Without --dry-run the run goes into the app Postgres
// through the Store (DATABASE_URL; --schema for another search_path): beginRun with expected_count = kinds
// x names before the first probe, the probe rows, finishRun with the rows written. --only asks one kind,
// and expected_count is the names. --dry-run prints every row as one JSON line and writes nothing.
//
// Everything printed is redacted: targets are the names' pseudonyms under REDACT_SALT, addresses ip-XXXXXX.
// The write path refuses a blank REDACT_SALT, because a per-process salt gives targets no server_name row
// shares; the dry run accepts one and says so.
// Exit 0 when the run is complete, 1 when it is partial or failed or the Store refuses, 2 on a usage
// error, a blank salt for a write, or a blank CLOUDFLARE_API_TOKEN.

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { config, redact } from "../src/config.ts";
import { Cloudflare } from "../src/collectors/cloudflare.ts";
import type { Probe, ProbeKind } from "../src/data/rows.ts";
import { Store } from "../src/data/store.ts";
import { PROBE_KINDS } from "../src/probe/rules.ts";
import { readPopulation, runProbes } from "../src/probe/run.ts";
import { Redactor } from "../src/redactor.ts";
import { Tracer } from "../src/trace.ts";

const TENANT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const USAGE = "usage: npm run probe -- --tenant <id> [--only http|dns|tls] [--schema <name>] [--dry-run] [--help]";

function die(msg: string): never {
  process.stderr.write(`${msg}\n${USAGE}\n`);
  process.exit(2);
}

let args: { tenant?: string; only?: string; schema?: string; "dry-run"?: boolean; help?: boolean };
try {
  args = parseArgs({
    options: { tenant: { type: "string" }, only: { type: "string" }, schema: { type: "string" }, "dry-run": { type: "boolean" }, help: { type: "boolean" } },
  }).values;
} catch (e) {
  die((e as Error).message);
}

if (args.help) {
  console.log(USAGE);
  console.log("Probes every A, AAAA and CNAME name of the tenant's Cloudflare account (wildcards left out) over http, dns and tls,");
  console.log("prints the rows (redacted) and writes one collection_run of surface probe and its probe rows unless --dry-run.");
  process.exit(0);
}
const tenant = args.tenant ?? die("--tenant is required");
if (!TENANT.test(tenant)) die(`--tenant must be lowercase letters, digits and dashes, got ${tenant}`);
if (args.only !== undefined && !(PROBE_KINDS as readonly string[]).includes(args.only)) die(`--only must be one of ${PROBE_KINDS.join(", ")}, got ${args.only}`);
const kinds: readonly ProbeKind[] = args.only ? [args.only as ProbeKind] : PROBE_KINDS;
const dry = args["dry-run"] === true;
if (!config.cloudflare.token) die("CLOUDFLARE_API_TOKEN is blank: the population is read live from the Cloudflare API (set it in .env)");
if (!config.redactSalt) {
  if (!dry) die("REDACT_SALT is blank: the write path needs the tenant's salt so probe targets join the server_name rows (set it in .env, or run with --dry-run)");
  process.stderr.write("warning: REDACT_SALT is blank; targets below are this process's pseudonyms only and match no stored row\n");
}

const redactor = new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords);
const tracer = new Tracer(`probe_${Date.now().toString(36)}`, { model: "none" });
const line = (p: Probe): string =>
  `  ${p.kind.padEnd(4)} ${p.status.padEnd(4)} ${p.target}  ${String(p.latency_ms ?? "-").padStart(5)} ms  observed: ${p.observed}  expected: ${p.expected}`;

let store: Store | undefined;
try {
  store = dry ? undefined : Store.fromEnv({ schema: args.schema });
  const result = await runProbes({ tenantId: tenant, population: () => readPopulation(new Cloudflare()), redactor, kinds, sink: store ?? null });
  const { run, rows } = result;
  console.log(`probe: tenant ${tenant}, ${result.names} name(s) (A, AAAA, CNAME; wildcards left out), kinds ${kinds.join(", ")}, expected_count ${run.expected_count ?? "?"}`);
  for (const p of rows) console.log(dry ? JSON.stringify(p) : line(p));
  const tally = kinds.map((k) => {
    const of = rows.filter((r) => r.kind === k);
    return `${k} ${of.filter((r) => r.status === "ok").length} ok, ${of.filter((r) => r.status === "fail").length} fail`;
  }).join("; ");
  console.log(`probe: run ${run.run_id} ${run.observed_count ?? 0}/${run.expected_count ?? "?"} ${run.status}; ${tally}`);
  for (const e of result.errors) console.log(`probe: error: ${e}`);
  console.log(dry ? `probe: dry run, nothing written (${rows.length} row(s) for probe)` : `probe: wrote collection_run ${run.run_id} and ${result.written} probe row(s)`);
  tracer.emit({
    agent: "probe", action: "observe", status: run.status === "complete" ? "ok" : "failed",
    input_summary: `probe tenant ${tenant} kinds ${kinds.join(",")}${dry ? " (dry run)" : ""}`,
    output_summary: `${run.run_id}: ${run.observed_count ?? 0}/${run.expected_count ?? "?"} ${run.status}; ${tally}`,
    detail: result.errors.join("; ") || undefined,
  });
  process.exitCode = run.status === "complete" ? 0 : 1;
} catch (e) {
  console.error(`probe: ${redactor.text(redact((e as Error)?.message ?? String(e)))}`);
  process.exitCode = 1;
} finally {
  await store?.close();
}
