// npm run zetaris:setup: the idempotent Zetaris setup (src/zetaris/setup.ts) against the local bundle.
// Needs an admin-role ZETARIS_API_KEY and DATABASE_URL in .env; ZETARIS_PG_HOST (default drift-pg) is
// where the Zetaris driver container reaches that Postgres. The LESSONS and RULES files are written from
// DRIFT_MEMORY_DIR and DRIFT_POLICY_FILE into the driver container (ZETARIS_DRIVER_CONTAINER, default
// zetaris-driver-1) with docker, through wsl.exe -d ZETARIS_WSL_DISTRO (default Ubuntu-24.04) on Windows.
// Against an instance already set up every statement is ok or skipped. Exits 1 on the first step that fails
// with anything but "already exist".
// Before the first statement it applies sql/schema.sql and the Store's migrations to the app Postgres on DATABASE_URL
// (src/data/store.ts applySchema, idempotent), so DRIFT registers every table and column the schema holds: a store
// created before change_window or disposition.window_id gains them here, as the console's start line asks.
// --plan prints the ordered statements without running them; the password reads "<redacted>".
import { redact } from "../src/config.ts";
import { Store } from "../src/data/store.ts";
import { apply, envFromProcess, formatPlan, plan } from "../src/zetaris/setup.ts";
import { Tracer } from "../src/trace.ts";

try {
  if (process.argv.includes("--plan")) {
    const env = envFromProcess();
    for (const line of formatPlan(plan(env), env.datasource)) console.log(line);
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
  process.exit(r.ok ? 0 : 1);
} catch (e) {
  console.error(`ZETARIS SETUP: ${redact((e as Error).message ?? String(e))}`);
  process.exit(1);
}
