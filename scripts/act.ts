// npm run act -- --tenant <id> [--run <pass run id>]... [--apply] [--only rollback_file,revert_record,investigate] [--schema <name>] [--verbose|--quiet] [--help]
//
// The Actor (src/actions/act.ts) over the pass's dispositions in the ledger: ROLLBACK on an nginx file -> rollback_file,
// ROLLBACK on a record field -> revert_record, FIX -> investigate then fix (refused under this policy), ESCALATE under an
// on_drift investigate rule -> investigate; once per disposition and kind. Live, the reads go through Zetaris (the
// DataLayer over ZetarisEngine, every table as DRIFT.<table>) and the vault (DRIFT_VAULT_DIR); with SAMPLE_MODE=true
// the pass runs over sample/bundle.json into an in-memory ledger first and the Actor reads that.
//
// Prints the cycle's act section (src/loop/present.ts): the header, the act row with one line per action planned or
// done, and the done line naming the trace (logs/act_<base36 ms>.jsonl). --verbose adds the full output, the plan's
// or the outcomes' lines and the summary line; --quiet prints the header and the done line.
// Dry run by default: the plan, redacted (what would be written where, from which vault commit, which checks and
// probes follow), and nothing written anywhere, the action table included. --apply performs it: the write session over
// the host's ssh alias, the Cloudflare record writes, the probes into the Store, Nemotron through Nightshift, and one
// action row per action through the Store (DATABASE_URL; --schema for another search_path). --run narrows the
// dispositions to those runs (repeatable); default: the run of each surface and host's latest decided disposition.
// Exit 0 when the Actor ran, whatever each action's status; 1 when a read or a write failed; 2 on a usage error, or for
// --apply a blank REDACT_SALT, DATABASE_URL, CLOUDFLARE_API_TOKEN or ZETARIS_API_KEY, or SAMPLE_MODE.

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { act, actLines, ONLY_KINDS, type OnlyKind } from "../src/actions/act.ts";
import { liveActorDeps } from "../src/actions/live.ts";
import { config, redact } from "../src/config.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { ZetarisEngine } from "../src/data/engines/zetaris.ts";
import { decisionInstant } from "../src/data/instant.ts";
import { Store } from "../src/data/store.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { MODE, Table, actView, presentOptions } from "../src/loop/present.ts";
import { FileTracer } from "../src/loop/trace.ts";
import { runPass } from "../src/pipeline.ts";
import { TENANT_ID, TENANT_ID_SHAPE } from "../src/policy/schema.ts";
import { Redactor } from "../src/redactor.ts";
import { Vault } from "../src/vault/vault.ts";
import { exitOnConfigError } from "../src/cli.ts";

exitOnConfigError();

const USAGE = `usage: npm run act -- --tenant <id> [--run <pass run id>]... [--apply] [--only ${ONLY_KINDS.join(",")}] [--schema <name>] [--verbose|--quiet] [--help]`;

function usage(msg: string): never {
  console.error(`act: ${msg}\n${USAGE}`);
  process.exit(2);
}

let args: { tenant?: string; run?: string[]; apply?: boolean; only?: string; schema?: string; verbose?: boolean; quiet?: boolean; help?: boolean };
try {
  args = parseArgs({
    options: {
      tenant: { type: "string" }, run: { type: "string", multiple: true }, apply: { type: "boolean" }, only: { type: "string" }, schema: { type: "string" },
      verbose: { type: "boolean" }, quiet: { type: "boolean" }, help: { type: "boolean" },
    },
  }).values;
} catch (e) {
  usage((e as Error).message);
}
if (args.help) {
  console.log(USAGE);
  console.log("Prints the Actor's plan for the pass's dispositions (dry run) or, with --apply, carries it out and records one action row per action.");
  process.exit(0);
}
if (!args.tenant || !TENANT_ID.test(args.tenant)) usage(`--tenant is required: ${TENANT_ID_SHAPE}`);
if (args.verbose && args.quiet) usage("--verbose and --quiet exclude each other");
const only = (args.only ?? "").split(",").map((s) => s.trim()).filter(Boolean);
for (const k of only) if (!(ONLY_KINDS as readonly string[]).includes(k)) usage(`--only takes ${ONLY_KINDS.join(", ")}, got ${k}`);
const apply = args.apply === true;
const tenant = args.tenant;
if (apply) {
  if (config.sampleMode) usage("--apply acts on the live estate; SAMPLE_MODE runs the dry run over the recorded bundle only");
  if (!config.redactSalt) usage("REDACT_SALT is blank: hosts and names would get pseudonyms no stored row carries");
  if (!process.env.DATABASE_URL) usage("DATABASE_URL is blank: every applied action is recorded in the action table");
  if (!config.cloudflare.token) usage("CLOUDFLARE_API_TOKEN is blank: the record writes need it, and the probes that verify every write read the served names through it");
}
if (!config.sampleMode && !config.zetaris.apiKey) usage("ZETARIS_API_KEY is blank: the live Actor reads the ledger through Zetaris (or run with SAMPLE_MODE=true)");
if (!config.redactSalt) console.error("warning: REDACT_SALT is blank; host aliases map to no stored host pseudonym in this dry run");

const redactor = new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords);
const tracer = new FileTracer(`act_${Date.now().toString(36)}`, apply ? {} : { model: "none" });
const trace = tracer.logFile.replace(/\\/g, "/");
const present = presentOptions(args);
const table = new Table(present, (s) => redactor.text(redact(s)));
const t0 = Date.now();
console.log(table.header({ command: "act", tenant, at: new Date(t0), mode: apply ? MODE.applied : config.sampleMode ? "dry run over sample/bundle.json" : MODE.dryRun }));
let store: Store | null = null;
const verbose: string[] = [];
try {
  let layer: DataLayer;
  if (config.sampleMode) {
    const { default: bundle } = await import("../sample/bundle.json", { with: { type: "json" } });
    const engine = await SqlJsEngine.create();
    engine.loadBundle(bundle);
    layer = new DataLayer(engine);
    const pass = await runPass(layer, { tracer, ledger: new MemoryLedger(engine), decidedAt: decisionInstant(bundle) });
    verbose.push(`act: sample pass over sample/bundle.json: ${pass.findings.length} finding(s), ${pass.ledger?.dispositions ?? 0} disposition(s) in the in-memory ledger`);
  } else {
    layer = new DataLayer(new ZetarisEngine());
  }
  let vault: Vault | null = null;
  try {
    vault = Vault.fromEnv({ redactor });
  } catch (e) {
    console.error(`act: vault: ${redactor.text(redact((e as Error).message))}`);
    process.exit(2);
  }
  store = apply ? Store.fromEnv({ schema: args.schema }) : null;
  const deps = liveActorDeps({ tenantId: tenant, apply, layer, store, vault, redactor, tracer });
  const res = await act({ tenantId: tenant, apply, only: only as OnlyKind[], runIds: args.run }, deps);
  const ms = Date.now() - t0;
  if (!present.quiet) for (const l of table.row("act", actView(res), ms)) console.log(l);
  if (present.verbose) for (const l of [...verbose, ...actLines(tenant, res, redactor)]) console.log(l);
  console.log(table.done({ ms, trace }));
} catch (e) {
  const msg = redactor.text(redact((e as Error)?.message ?? String(e)));
  const ms = Date.now() - t0;
  if (present.quiet) console.error(`act: ${msg}`);
  else console.log(table.failed("act", msg, ms));
  console.log(table.done({ ms, trace, stopped: { step: "act", at: 1, of: 1 } }));
  process.exitCode = 1;
} finally {
  await store?.close();
}
