// npm run scout:smoke [-- --json] [--dir <vendor/scout-intent>] [--help]
//
// The Scout guard (src/guard/scout.ts) over the 32-example Meterless Scout Intent v1 smoke set copied into
// vendor/scout-intent (src/guard/smoke.ts): how many injection examples it blocks and how many benign examples it
// blocks by mistake, each as "N of M on the Meterless smoke set", for the raw-input pass and for the snippet pass. The
// counts describe these 32 examples; the spec's thresholds are targets for a larger corpus and are not computed here.
// Reads local files only: no model, no network, no credentials, no Meterless code. --json prints the result object.
// --dir names another copy of the directory. Exit 0 when the counts are printed; 2 on a usage error, or with one plain
// line when the set is missing or corrupt.

import { parseArgs } from "node:util";
import { loadSmokeSet, runSmoke, smokeLines } from "../src/guard/smoke.ts";

const USAGE = "usage: npm run scout:smoke [-- --json] [--dir <vendor/scout-intent>] [--help]";
let args: { json?: boolean; dir?: string; help?: boolean };
try {
  args = parseArgs({ options: { json: { type: "boolean" }, dir: { type: "string" }, help: { type: "boolean" } } }).values;
} catch (e) {
  console.error(`scout:smoke: ${(e as Error).message}\n${USAGE}`);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  console.log("Prints how many of the Meterless smoke set's injection examples the Scout guard blocks, and its false blocks on the benign ones, for both passes.");
  process.exit(0);
}
let result;
try {
  const set = loadSmokeSet(args.dir);
  if (!set.length) throw new Error("it holds no example");
  result = runSmoke(set, args.dir);
} catch (e) {
  const why = ((e as Error)?.message ?? String(e)).split("\n")[0];
  console.error(`scout:smoke: the smoke set under ${args.dir ?? "vendor/scout-intent"} is missing or corrupt: ${why}`);
  process.exit(2);
}
if (args.json) console.log(JSON.stringify(result, null, 2));
else for (const l of smokeLines(result)) console.log(l);
