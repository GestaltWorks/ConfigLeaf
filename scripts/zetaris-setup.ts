// npm run zetaris:setup [-- --plan] [-- --tenant <id>]...: the idempotent Zetaris setup (src/zetaris/setup.ts) against the local bundle.
// Needs an admin-role ZETARIS_API_KEY and DATABASE_URL in .env; ZETARIS_PG_HOST (default drift-pg) is
// where the Zetaris driver container reaches that Postgres. The LESSONS and RULES files are written from
// DRIFT_MEMORY_DIR and DRIFT_POLICY_FILE into the driver container (ZETARIS_DRIVER_CONTAINER, default
// zetaris-driver-1) with docker, through wsl.exe -d ZETARIS_WSL_DISTRO (default Ubuntu-24.04) on Windows.
// CLOUDFLARE_API_TOKEN, the read token, goes into the Authorization header of the CLOUDFLARE REST tables; the zones it
// sees are read from the DNS API first (GETs only).
// Against an instance already set up every statement is ok or skipped. Exits 1 on the first step that fails
// with anything but "already exist".
// Before the first statement it applies sql/schema.sql and the Store's migrations to the app Postgres on DATABASE_URL
// (src/data/store.ts applySchema, idempotent), so DRIFT registers every table and column the schema holds: a store
// created before change_window or disposition.window_id gains them here, as the console's start line asks.
// After the last statement it collects Zetaris's control plane (src/zetaris/control.ts, what npm run collect:zetaris
// runs) for each tenant --tenant names, or, with none, for each tenant the app Postgres holds a cloudflare.dns or a
// zetaris.control run of: one zetaris.control run each, stored and committed to the vault, one line each. A run
// other than complete exits 1.
// --plan prints the ordered statements without running them (the zones are still read); the password and the token
// read "<redacted>".
import { parseArgs } from "node:util";
import { Zetaris } from "../src/adapters/zetaris.ts";
import { config, redact } from "../src/config.ts";
import { Store } from "../src/data/store.ts";
import { Redactor } from "../src/redactor.ts";
import { hookSummary } from "../src/vault/hook.ts";
import { Vault } from "../src/vault/vault.ts";
import { CONTROL_SURFACE, collectControl, controlText, storeControl } from "../src/zetaris/control.ts";
import { apply, envFromProcess, formatPlan, liveZones, plan } from "../src/zetaris/setup.ts";
import { Tracer } from "../src/trace.ts";

try {
  const { values: args } = parseArgs({ options: { plan: { type: "boolean" }, tenant: { type: "string", multiple: true } } });
  // Live only: with what it needs unset (no .env), one plain line naming it, exit 2. --plan reads the zones and builds the datasource, no more.
  const needs = ([["ZETARIS_API_KEY", config.zetaris.apiKey], ["DATABASE_URL", process.env.DATABASE_URL ?? ""], ["CLOUDFLARE_API_TOKEN", config.cloudflare.token], ["REDACT_SALT", config.redactSalt]] as const)
    .filter(([name, value]) => !value && !(args.plan && (name === "ZETARIS_API_KEY" || name === "REDACT_SALT"))).map(([name]) => name);
  if (needs.length) {
    console.error(`ZETARIS SETUP: live only; it needs ${needs.join(", ")} set (see .env.example)`);
    process.exit(2);
  }
  if (args.plan) {
    const env = envFromProcess();
    for (const line of formatPlan(plan({ ...env, zones: await liveZones(env.cloudflareToken) }), env.datasource)) console.log(line);
    process.exit(0);
  }
  const store = Store.fromEnv();
  try {
    await store.applySchema();
  } finally {
    await store.close();
  }
  console.log("ZETARIS SETUP: sql/schema.sql and the Store's migrations applied to the app Postgres");
  const tracer = new Tracer(`zetaris_setup_${Date.now().toString(36)}`, { model: "none" });
  const r = await apply({ tracer });
  if (!r.ok) process.exit(1);

  // The control plane, collected once the layer is as the setup states it.
  if (!config.redactSalt) throw new Error("REDACT_SALT is blank: the zetaris.control run carries the tenant's pseudonyms under its salt");
  const redactor = new Redactor(config.redactSalt, config.redactWords);
  const vault = Vault.fromEnv({ redactor });
  const rows = Store.fromEnv();
  let complete = true;
  try {
    const tenants = args.tenant?.length ? args.tenant : [...new Set([
      ...(await rows.rowsOf("collection_run", { surface: "cloudflare.dns" })), ...(await rows.rowsOf("collection_run", { surface: CONTROL_SURFACE })),
    ].map((x) => x.tenant_id))].sort();
    if (!tenants.length) console.log(`ZETARIS SETUP: no tenant holds a cloudflare.dns or ${CONTROL_SURFACE} run; npm run collect:zetaris -- --tenant <id> collects one`);
    for (const tenant of tenants) {
      const t0 = Date.now();
      const c = await collectControl(new Zetaris(), redactor, { tenantId: tenant, tracer });
      const w = await storeControl(c, rows, vault, { redactor, tracer });
      const h = hookSummary(w.hook);
      const status = c.run.status === "complete" && w.hook.status !== "failed" ? "ok" : "failed";
      if (status === "failed") complete = false;
      console.log(`${status.padEnd(7)} ${`collect ${CONTROL_SURFACE} ${tenant}`.padEnd(44)} ${controlText(c)}; ${w.written} observation row(s) written; vault ${h.status}${h.commit ? ` ${String(h.commit).slice(0, 12)}` : ""}  (${Date.now() - t0} ms)`);
    }
  } finally {
    await rows.close();
  }
  process.exit(complete ? 0 : 1);
} catch (e) {
  console.error(`ZETARIS SETUP: ${redact((e as Error).message ?? String(e))}`);
  process.exit(1);
}
