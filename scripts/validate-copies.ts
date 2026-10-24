// npm run validate:copies -- --tenant <id> [--host <alias>] [--zone <zone>] [--commit <sha>] [--max-rounds <n>] [--schema <name>] [--dry-run] [--help]
//
// Validates one tenant's vault copies (src/validate/): the latest commit of every repository under
// <DRIFT_VAULT_DIR>/<tenant>, of the one --host or --zone selects, or --commit of that one. nginx-t for a
// host's nginx tree (nginx -t in nginx:1.27 through DRIFT_NGINX_T, placeholders for what the tree names
// outside itself before round 1, then for what each round names), cf-schema for the Cloudflare records.
// Prints one redacted line per repository (result, rounds, gap count, the gaps) and writes one
// copy_validation row per vault copy of each validated commit through the Store (DATABASE_URL; --schema
// for another search_path) unless --dry-run. A dry run reads the vault copies and the inventory when
// DATABASE_URL is set and validates either way. --max-rounds sets the nginx-t round cap (default 12,
// src/validate/nginx.ts MAX_ROUNDS).
// Exit 0 when every selected repository was validated, whatever its result; 1 when one could not be
// (nginx unavailable, git refusing, a repository missing) or the Store refused; 2 on a usage error or, for a
// write, a blank REDACT_SALT or DATABASE_URL.

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { config, redact } from "../src/config.ts";
import { Store } from "../src/data/store.ts";
import { TENANT } from "../src/policy/schema.ts";
import { Redactor } from "../src/redactor.ts";
import { MAX_ROUNDS } from "../src/validate/nginx.ts";
import { storeCopies, validateCopies } from "../src/validate/run.ts";

const USAGE = "usage: npm run validate:copies -- --tenant <id> [--host <alias>] [--zone <zone>] [--commit <sha>] [--max-rounds <n>] [--schema <name>] [--dry-run] [--help]";

let args: { tenant?: string; host?: string; zone?: string; commit?: string; "max-rounds"?: string; schema?: string; "dry-run"?: boolean; help?: boolean };
try {
  args = parseArgs({
    options: {
      tenant: { type: "string" }, host: { type: "string" }, zone: { type: "string" }, commit: { type: "string" }, "max-rounds": { type: "string" },
      schema: { type: "string" }, "dry-run": { type: "boolean" }, help: { type: "boolean" },
    },
  }).values;
} catch (e) {
  console.error(`${(e as Error).message}\n${USAGE}`);
  process.exit(2);
}

if (args.help) {
  console.log(USAGE);
  console.log("Validates the latest vault commit of each repository of the tenant (nginx -t for a host's nginx tree, cf-schema for the Cloudflare records), prints one redacted line per repository, and writes copy_validation rows unless --dry-run.");
  process.exit(0);
}
if (!args.tenant || !TENANT.test(args.tenant) || args.tenant === "*") {
  console.error(`--tenant is required: a tenant id ([A-Za-z0-9._-], up to 64)\n${USAGE}`);
  process.exit(2);
}
const maxRounds = args["max-rounds"] === undefined ? MAX_ROUNDS : Number(args["max-rounds"]);
if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 64) {
  console.error(`--max-rounds must be an integer from 1 to 64\n${USAGE}`);
  process.exit(2);
}
if (!config.vaultDir) {
  console.log("validate:copies: the vault is off (DRIFT_VAULT_DIR is blank); nothing validated");
  process.exit(0);
}
const dryRun = args["dry-run"] === true;
if (!config.redactSalt) {
  if (!dryRun) {
    console.error("REDACT_SALT is blank: the rows' paths and names would carry pseudonyms no observation carries. Set it in .env, or run with --dry-run.");
    process.exit(2);
  }
  console.error("warning: REDACT_SALT is blank; this dry run prints per-process pseudonyms");
}
if (!process.env.DATABASE_URL && !dryRun) {
  console.error("DATABASE_URL is blank: the rows go to the app Postgres. Set it in .env, or run with --dry-run.");
  process.exit(2);
}

const redactor = new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords);
let store: Store | undefined;
try {
  store = process.env.DATABASE_URL ? Store.fromEnv({ schema: args.schema }) : undefined;
  const res = await validateCopies({
    vaultDir: config.vaultDir, tenant: args.tenant, host: args.host, zone: args.zone, commit: args.commit,
    dryRun, store: store ? storeCopies(store) : null, redactor, maxRounds,
  });
  for (const l of res.lines) console.log(`validate:copies: ${l}`);
  console.log(res.written === null
    ? `validate:copies: dry run, nothing written (${res.rows.length} copy_validation row(s))`
    : `validate:copies: copy_validation ${res.written} row(s) written of ${res.rows.length}`);
  if (res.errors) process.exitCode = 1;
} catch (e) {
  console.error(`validate:copies: ${redactor.text(redact((e as Error).message ?? String(e)))}`);
  process.exitCode = 1;
} finally {
  await store?.close();
}
