// npm run collect:linux -- --host <alias> --tenant <id> [--dry-run] [--out <file>]
//
// One read-only SSH session to one of the operator's hosts (LINUX_HOSTS in .env: alias=export dir; the
// collector reaches nothing else), the fixed read script on stdin, rows built with everything redacted
// first. --dry-run prints the summary and the
// redacted rows as JSON and writes nothing; --out writes the same rows (bundle-shaped, redacted) to a
// file. Without --dry-run the rows go to the app Postgres through src/data/store.ts (DATABASE_URL), as
// one run: beginRun with the asserted population, the inserts, finishRun with what was observed. A blank
// REDACT_SALT gives per-process pseudonyms that no other collector's rows can join, so a write is refused
// (exit 2); the Store's own refusals (no DATABASE_URL, a run id it already holds) end the run with exit 1.
// After the Store writes, the vault hook (src/vault/hook.ts): a complete run's fetched files become one commit
// in <DRIFT_VAULT_DIR>/<tenant>/<alias> and its vault_copy rows go through the Store; one trace line says what
// happened ("vault off" when DRIFT_VAULT_DIR is blank). A DRIFT_VAULT_DIR the vault refuses ends the script
// before the SSH session (exit 2); a hook that fails after the run is stored ends it with exit 1. The dry run
// and --out print the redacted half only (linux.ts printable): rows and summary.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { config, redact } from "../src/config.ts";
import { HOSTS, collectHost, printable, storeRows } from "../src/collectors/linux.ts";
import { Store } from "../src/data/store.ts";
import { TENANT_ID, TENANT_ID_SHAPE } from "../src/policy/schema.ts";
import { Redactor } from "../src/redactor.ts";
import { Tracer } from "../src/trace.ts";
import { hookSummary, vaultLinuxRun } from "../src/vault/hook.ts";
import { Vault } from "../src/vault/vault.ts";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (name: string): boolean => argv.includes(name);

const alias = arg("--host");
const tenant = arg("--tenant");
const dryRun = flag("--dry-run");
const out = arg("--out");

if (!alias || !tenant || flag("--help")) {
  console.error(`usage: npm run collect:linux -- --host <${Object.keys(HOSTS).join("|") || "alias"}> --tenant <id> [--dry-run] [--out <file>]`);
  process.exit(2);
}
if (!TENANT_ID.test(tenant)) {
  console.error(`--tenant must be ${TENANT_ID_SHAPE}, got ${tenant}`);
  process.exit(2);
}
if (!Object.keys(HOSTS).length) {
  console.error("LINUX_HOSTS is blank: set it in .env (alias=export dir, comma-separated); the collector reaches only the aliases listed there");
  process.exit(2);
}
if (!HOSTS[alias]) {
  console.error(`unknown host alias ${alias}; the collector reaches only: ${Object.keys(HOSTS).join(", ")}`);
  process.exit(2);
}
if (!config.redactSalt) {
  if (!dryRun) {
    console.error("REDACT_SALT is blank: rows would carry pseudonyms no other collector can join. Set it in .env, or run with --dry-run.");
    process.exit(2);
  }
  console.error("warning: REDACT_SALT is blank; pseudonyms in this dry run are per-process and will not match another run or the trace");
}

const redactor = new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords);
const tracer = new Tracer(`collect_linux_${Date.now().toString(36)}`, { model: "none" });

let vault: Vault | null = null;
if (!dryRun) {
  try {
    vault = Vault.fromEnv({ redactor });
  } catch (err) {
    console.error(`vault: ${redactor.text(redact((err as Error).message))}`);
    process.exit(2);
  }
}

try {
  const res = await collectHost(alias, { tenantId: tenant, redactor, tracer });
  const { summary, rows } = printable(res);
  if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
  if (dryRun) {
    console.log(JSON.stringify({ dry_run: true, summary, rows }, null, 2));
    process.exit(0);
  }
  const store = Store.fromEnv();
  try {
    const written = await storeRows(store, res.rows);
    tracer.emit({ agent: "collector.linux", action: "observe", status: "ok", output_summary: `stored ${Object.entries(written).map(([t, n]) => `${t} ${n}`).join(", ")} for run ${res.summary.run.run_id}` });
    const hook = await vaultLinuxRun(vault, store, res, { tenantId: tenant, alias, redactor, tracer });
    if (hook.status === "failed") process.exitCode = 1;
    console.log(JSON.stringify({ written, vault: hookSummary(hook), summary }, null, 2));
  } finally {
    await store.close();
  }
} catch (err) {
  const msg = redactor.text(redact((err as Error).message));
  tracer.emit({ agent: "collector.linux", action: "observe", status: "failed", detail: msg });
  console.error(msg);
  process.exit(1);
}
