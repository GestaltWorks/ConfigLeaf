// npm run policy:load -- --tenant <id> [--file <path>] [--schema <name>] [--dry-run] [--help]
//
// The MSP's policy file (--file, default DRIFT_POLICY_FILE, itself default policy/hackathon.json) into
// policy_rule. Validates the file (src/policy/schema.ts), turns it into rows for the tenant with every glob,
// the author and the note through the tenant's redactor (src/policy/load.ts), prints one line per rule,
// then writes the rows through the Store into the app Postgres (DATABASE_URL; --schema for another
// search_path) unless --dry-run. Re-loading the same file writes 0 rows: rule_id is deterministic. A file
// whose tenant is "*" gives rows for every tenant and is stored under "*".
// Exit 0 on success, 1 when the file or the Store refuses, 2 on a usage error or, for a write, a blank
// REDACT_SALT (a name typed in a glob would get a pseudonym no observation carries).

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { config, redact } from "../src/config.ts";
import { Store } from "../src/data/store.ts";
import type { PolicyRule } from "../src/data/rows.ts";
import { PolicyError, loadPolicyFile } from "../src/policy/load.ts";
import { TENANT, TENANT_ID_SHAPE } from "../src/policy/schema.ts";
import { Redactor } from "../src/redactor.ts";

const USAGE = "usage: npm run policy:load -- --tenant <id|*> [--file <path>] [--schema <name>] [--dry-run] [--help]";

let args: { tenant?: string; file?: string; schema?: string; "dry-run"?: boolean; help?: boolean };
try {
  args = parseArgs({
    options: { tenant: { type: "string" }, file: { type: "string" }, schema: { type: "string" }, "dry-run": { type: "boolean" }, help: { type: "boolean" } },
  }).values;
} catch (e) {
  console.error(`${(e as Error).message}\n${USAGE}`);
  process.exit(2);
}

if (args.help) {
  console.log(USAGE);
  console.log("Validates the policy file, prints its rules as policy_rule rows (redacted), and writes them unless --dry-run.");
  process.exit(0);
}
if (!args.tenant || !TENANT.test(args.tenant)) {
  console.error(`--tenant is required: ${TENANT_ID_SHAPE}, or *\n${USAGE}`);
  process.exit(2);
}
const dryRun = args["dry-run"] === true;
if (!config.redactSalt) {
  if (!dryRun) {
    console.error("REDACT_SALT is blank: a name typed in a glob would get a pseudonym no observation carries. Set it in .env, or run with --dry-run.");
    process.exit(2);
  }
  console.error("warning: REDACT_SALT is blank; any name in a glob gets a per-process pseudonym in this dry run");
}

const file = args.file ?? config.policyFile;
const redactor = new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords);

const line = (r: PolicyRule): string =>
  `  ${r.rule_id}  ${r.surface.padEnd(14)} ${r.object_glob.padEnd(30)} ${r.setting_glob.padEnd(18)} ${r.criticality.padEnd(8)} lock=${r.lock} on_drift=${r.on_drift.padEnd(11)} on_no_copy=${r.on_no_copy.padEnd(18)} hold=${String(r.hold_max_hours).padStart(2)}h alert=${r.alert.padEnd(6)} ${r.psa_priority}${r.note ? `  "${r.note}"` : ""}`;

let store: Store | undefined;
try {
  const { file: policy, rows, redacted } = loadPolicyFile(file, { tenant: args.tenant, redactor });
  console.log(`policy:load: ${file}: version ${policy.version} by ${redactor.text(policy.author)} since ${policy.since}, tenant ${policy.tenant}${policy.tenant === "*" ? " (every tenant)" : ""}: ${rows.length} rule(s) valid${redacted ? `; the redactor rewrote ${redacted} field(s) to their pseudonyms` : ""}`);
  for (const r of rows) console.log(line(r));
  if (dryRun) {
    console.log(`policy:load: dry run, nothing written (${rows.length} row(s) for policy_rule)`);
  } else {
    store = Store.fromEnv({ schema: args.schema });
    const n = await store.insertPolicyRules(rows);
    console.log(`policy:load: policy_rule ${n} row(s) written, ${rows.length - n} already stored`);
  }
} catch (e) {
  console.error(`policy:load: ${e instanceof PolicyError ? e.message : redact((e as Error).message ?? String(e))}`);
  process.exitCode = 1;
} finally {
  await store?.close();
}
