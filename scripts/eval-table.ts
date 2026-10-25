// npm run eval:table -- eval/results/<UTC stamp>
//
// Prints the results table of one eval results directory (src/eval/table.ts evalTable): a lead line of totals and
// median output tokens, then one row per configuration. The README carries this output under "### <set>,
// eval/results/<stamp>" in "## Evaluation", and test/eval-table.test.ts holds the two equal. Reads files only; exit 0,
// or 1 with the reason when the directory holds no run file.

import { evalTable } from "../src/eval/table.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: npm run eval:table -- eval/results/<UTC stamp>");
  process.exit(1);
}
try {
  process.stdout.write(evalTable(dir));
} catch (err) {
  console.error(`eval:table: ${(err as Error).message}`);
  process.exit(1);
}
