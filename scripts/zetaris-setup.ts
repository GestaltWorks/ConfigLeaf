// npm run zetaris:setup: the idempotent Zetaris setup (src/zetaris/setup.ts) against the local bundle.
// Needs an admin-role ZETARIS_API_KEY and DATABASE_URL in .env; ZETARIS_PG_HOST (default drift-pg) is
// where the Zetaris driver container reaches that Postgres. Against an instance already set up every
// statement is ok or skipped. Exits 1 on the first statement that fails with anything but "already exist".
// --plan prints the ordered statements without running them; the password reads "<redacted>".
import { redact } from "../src/config.ts";
import { apply, envFromProcess, formatPlan, plan } from "../src/zetaris/setup.ts";
import { Tracer } from "../src/trace.ts";

try {
  if (process.argv.includes("--plan")) {
    const env = envFromProcess();
    for (const line of formatPlan(plan(env), env.datasource)) console.log(line);
    process.exit(0);
  }
  const tracer = new Tracer(`zetaris_setup_${Date.now().toString(36)}`, { model: "none" });
  const r = await apply({ tracer });
  process.exit(r.ok ? 0 : 1);
} catch (e) {
  console.error(`ZETARIS SETUP: ${redact((e as Error).message ?? String(e))}`);
  process.exit(1);
}
