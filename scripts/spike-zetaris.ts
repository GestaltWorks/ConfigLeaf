// Spike A: Lightning SQL over REST with the agent's own key. Proves: SELECT 1, that this user can
// register a Lightning database and see it, and that it is dropped again. No sample sources, no
// third-party demo tables. Needs ZETARIS_API_KEY in .env (Management > API tokens).
import { Zetaris } from "../src/adapters/zetaris.ts";
import { Tracer } from "../src/trace.ts";

const z = new Zetaris();
const tracer = new Tracer(`spike_zetaris_${Date.now().toString(36)}`);
let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

const one = await z.query("SELECT 1 AS one", { agent: "spike", tracer });
check(one.rowCount === 1 && one.rows[0]?.[0] === "1" && one.columns[0] === "one", "SELECT 1 over REST", `${one.latencyMs} ms (server ${one.serverMs} ms)`);

// Registration rights: the agent registers its own sources, so its key must be allowed to CREATE.
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

console.log(failures ? `\nSPIKE A: ${failures} FAIL` : "\nSPIKE A: PASS");
process.exit(failures ? 1 : 0);
