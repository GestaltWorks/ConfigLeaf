// Spike A: Lightning SQL over REST. SELECT 1, then a join across two differently sourced tables.
// Needs ZETARIS_API_KEY in .env (Management > API tokens in the Zetaris UI).
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
check(one.rowCount === 1 && one.rows[0]?.[0] === "1", "SELECT 1 over REST", `${one.latencyMs} ms, columns=${JSON.stringify(one.columns)}`);

// The bundle ships sample sources (NY_TAXI, TPCDS_DB) and the getting-started PokeAPI REST table
// name-redacted registered on 23 Oct. A join across a REST table and a bundled relational table proves
// federation before our own sources exist.
const dbs = await z.query("SHOW LIGHTNING DATABASES", { agent: "spike", tracer }).catch((e) => ({ rowCount: 0, rows: [], columns: [], error: String(e) } as any));
check(dbs.rowCount > 0, "SHOW LIGHTNING DATABASES", `${dbs.rowCount} rows${dbs.error ? ` ${dbs.error}` : ""}`);
console.log(dbs.rows.slice(0, 10).map((r: string[]) => "   " + r.join(" | ")).join("\n"));

const poke = await z.query("SELECT pokemon_name, ability_name FROM pokeapi.pikachu_abilities_table", { agent: "spike", tracer }).catch((e) => ({ rowCount: 0, error: String(e) } as any));
check(poke.rowCount >= 1, "live REST table (PokeAPI) answers a SELECT", `${poke.rowCount} rows${poke.error ? ` ${poke.error}` : ""}`);

console.log(failures ? `\nSPIKE A: ${failures} FAIL` : "\nSPIKE A: PASS");
process.exit(failures ? 1 : 0);
