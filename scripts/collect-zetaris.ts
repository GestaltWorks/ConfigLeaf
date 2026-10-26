// npm run collect:zetaris -- --tenant <id> [--dry-run] [--help]
//
// Zetaris's control plane as one collection run of the surface zetaris.control (src/zetaris/control.ts): LOAD USL,
// LIST DQ USL, SHOW GRANT ON ALL (not_checked with the reason when the key may not run it), SHOW DATASOURCES, SHOW
// LIGHTNING DATABASES and SHOW SERVER VERSION, read only, each object one observation of its canonical JSON, redacted.
// Without --dry-run the run goes into the app Postgres through the Store as a host's run does (beginRun with the
// population asserted, the observations, finishRun), then the vault hook commits a complete run to
// <DRIFT_VAULT_DIR>/<tenant>/zetaris. Prints the run's line, one line per object kind and the vault's summary; the trace
// goes to stdout as the collect scripts write it. npm run zetaris:setup runs the same collection at its end.
// Exit 0 when the run is complete, 1 when it is not or a write failed, 2 on a usage error, a blank ZETARIS_API_KEY or,
// for a write, a blank REDACT_SALT.

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { Zetaris } from "../src/adapters/zetaris.ts";
import { config, redact } from "../src/config.ts";
import { Store } from "../src/data/store.ts";
import { Redactor } from "../src/redactor.ts";
import { Tracer } from "../src/trace.ts";
import { hookSummary } from "../src/vault/hook.ts";
import { Vault } from "../src/vault/vault.ts";
import { collectControl, controlText, storeControl } from "../src/zetaris/control.ts";

const TENANT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const USAGE = "usage: npm run collect:zetaris -- --tenant <id> [--dry-run] [--help]";

function die(msg: string): never {
  process.stderr.write(`collect:zetaris: ${msg}\n${USAGE}\n`);
  process.exit(2);
}

let args: { tenant?: string; "dry-run"?: boolean; help?: boolean };
try {
  args = parseArgs({ options: { tenant: { type: "string" }, "dry-run": { type: "boolean" }, help: { type: "boolean" } } }).values;
} catch (e) {
  die((e as Error).message);
}
if (args.help) {
  console.log(USAGE);
  console.log("Reads Zetaris's semantic layer, DQ rules, grants, datasources and server version as one zetaris.control run and stores it (--dry-run prints it and writes nothing).");
  process.exit(0);
}
const tenant = args.tenant ?? die("--tenant is required");
if (!TENANT.test(tenant)) die(`--tenant must be lowercase letters, digits and dashes, got ${tenant}`);
const dry = args["dry-run"] === true;
if (!config.zetaris.apiKey) die("ZETARIS_API_KEY is blank: the control plane is read through Zetaris");
if (!dry && !config.redactSalt) die("REDACT_SALT is blank: the write path needs the tenant's salt so pseudonyms join across runs (set it in .env)");

const redactor = new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords);
let vault: Vault | null = null;
if (!dry) {
  try {
    vault = Vault.fromEnv({ redactor });
  } catch (e) {
    die(`vault: ${redactor.text(redact((e as Error).message))}`);
  }
}
const tracer = new Tracer(`collect_zetaris_${Date.now().toString(36)}`, { model: "none" });
let ok = false;
try {
  const c = await collectControl(new Zetaris(), redactor, { tenantId: tenant, tracer });
  console.log(`zetaris.control ${controlText(c)}`);
  for (const o of c.observations) console.log(`  ${o.object_id}  ${o.value_hash.slice(0, 19)}`);
  ok = c.run.status === "complete";
  if (!dry) {
    const store = Store.fromEnv();
    try {
      const r = await storeControl(c, store, vault, { redactor, tracer });
      console.log(`wrote zetaris.control ${c.run.run_id}: ${r.written} new observation row(s) of ${c.observations.length}, status ${c.run.status}`);
      console.log(`vault: ${JSON.stringify(hookSummary(r.hook))}`);
      if (r.hook.status === "failed") ok = false;
    } finally {
      await store.close();
    }
  } else {
    console.log("dry run: nothing written");
  }
} catch (e) {
  console.error(`collect:zetaris: ${redactor.text(redact((e as Error)?.message ?? String(e)))}`);
  ok = false;
}
process.exitCode = ok ? 0 : 1;
