// Which Nemotron routes does Nightshift expose, and via which providers? Read-only.
import { Nightshift } from "../src/adapters/nightshift.ts";

const ns = new Nightshift();
const ids = await ns.models();
const nemotron = ids.filter((m) => /nemotron/i.test(m));
console.log(`${ids.length} model ids; ${nemotron.length} mention nemotron:`);
for (const m of nemotron) console.log("  " + m);
const providers = new Set(ids.map((m) => m.split("/")[0]));
console.log("provider prefixes:", [...providers].sort().join(", "));
