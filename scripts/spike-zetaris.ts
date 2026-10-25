// Zetaris check: Lightning SQL over REST with the configured ZETARIS_API_KEY (the tenant's key: only an admin
// can generate one, and it is tenant-scoped, not a user's). Read-only by default: SELECT 1 and SHOW
// LIGHTNING DATABASES, which is all the agent is meant to run with it. With --register it also proves
// the key can register a Lightning database, see it and drop it again; that is DDL the agent's own query
// path can never reach, and here it goes through the raw adapter, never through DataLayer.run, whose
// guard refuses it. No sample sources, no third-party demo tables.
// Needs ZETARIS_API_KEY in .env (Management > API tokens).
import { Zetaris } from "../src/adapters/zetaris.ts";
import { Tracer } from "../src/trace.ts";

const z = new Zetaris();
const tracer = new Tracer(`spike_zetaris_${Date.now().toString(36)}`);
const register = process.argv.includes("--register");
let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

const one = await z.query("SELECT 1 AS one", { agent: "spike", tracer });
check(one.rowCount === 1 && one.rows[0]?.[0] === "1" && one.columns[0] === "one", "SELECT 1 over REST", `${one.latencyMs} ms (server ${one.serverMs} ms)`);

const visible = await z.query("SHOW LIGHTNING DATABASES", { agent: "spike", tracer });
check(true, "SHOW LIGHTNING DATABASES over REST", `${visible.rowCount} database(s) visible to this key`);

if (!register) {
  console.log("SKIP  registration probe (pass --register to CREATE and DROP a probe Lightning database; needs registration rights)");
} else {
  // Registration rights: an operator's key may register sources; the agent's own key should only SELECT.
  const probe = `DRIFT_SPIKE_${Date.now().toString(36).toUpperCase()}`;
  let created = false;
  try {
    await z.query(`CREATE LIGHTNING DATABASE ${probe} DESCRIBE BY "drift-agent spike, dropped at the end"`, { agent: "spike", tracer });
    created = true;
  } catch (e) {
    check(false, "this key can register a Lightning database", String((e as Error).message).slice(0, 160));
  }
  if (created) {
    const dbs = await z.query("SHOW LIGHTNING DATABASES", { agent: "spike", tracer });
    check(dbs.rows.some((r) => r[0] === probe), "the registered database is visible to this key", `${dbs.rowCount} database(s) visible`);
    await z.query(`DROP LIGHTNING DATABASE ${probe}`, { agent: "spike", tracer });
    const after = await z.query("SHOW LIGHTNING DATABASES", { agent: "spike", tracer });
    check(!after.rows.some((r) => r[0] === probe), "and dropped again", `${after.rowCount} remain`);
  }
}

console.log(failures ? `\nSPIKE A: ${failures} FAIL` : "\nSPIKE A: PASS");
process.exit(failures ? 1 : 0);
