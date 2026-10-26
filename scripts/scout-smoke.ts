// npm run scout:smoke [-- --json] [--help]
//
// The Scout guard (src/guard/scout.ts) over the 32-example Meterless Scout Intent v1 smoke set copied into
// vendor/scout-intent (src/guard/smoke.ts): how many injection examples it blocks and how many benign examples it
// blocks by mistake, each as "N of M on the Meterless smoke set". The counts describe these 32 examples; the spec's
// thresholds are targets for a larger corpus and are not computed here. Reads local files only: no model, no network,
// no credentials, no Meterless code. --json prints the result object. Exit 0.

import { parseArgs } from "node:util";
import { loadSmokeSet, runSmoke, smokeLines } from "../src/guard/smoke.ts";

const USAGE = "usage: npm run scout:smoke [-- --json] [--help]";
let args: { json?: boolean; help?: boolean };
try {
  args = parseArgs({ options: { json: { type: "boolean" }, help: { type: "boolean" } } }).values;
} catch (e) {
  console.error(`scout:smoke: ${(e as Error).message}\n${USAGE}`);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  console.log("Prints how many of the Meterless smoke set's injection examples the Scout guard blocks, and its false blocks on the benign ones.");
  process.exit(0);
}
const result = runSmoke(loadSmokeSet());
if (args.json) console.log(JSON.stringify(result, null, 2));
else for (const l of smokeLines(result)) console.log(l);
