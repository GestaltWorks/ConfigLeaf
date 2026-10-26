// npm run sleep -- --preview [--at <ISO 8601 UTC>] [--memory-dir <dir>]
//
// The sleep cycle's plan for the technician's lessons (src/engine/sleep-preview.ts, the vendored H-MEM SleepCycleService):
// the records a cycle consolidates, archives and synthesizes, the lessons whose own expiry has passed, and what the lessons
// cover before and after the reference's execute() on a scratch copy. Preview only: this command changes nothing, and
// there is no execute, because a synthesized record keeps the first lesson's scope key and drops the others from recall.
//
// The store is the directory DRIFT_MEMORY_DIR names (--memory-dir for one command; examples/memory in sample mode when
// blank), opened read only. --at looks ahead to a later instant: the age and expiry rules run at that instant.
import { parseArgs } from "node:util";
import { badAt, parseAt, shownStore } from "../src/engine/cli.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";
import { previewSleep, renderSleep } from "../src/engine/sleep-preview.ts";

const USAGE = "usage: npm run sleep -- --preview [--at <ISO 8601 UTC>] [--memory-dir <dir>]";

const { values: args } = parseArgs({ options: { preview: { type: "boolean", default: false }, at: { type: "string" }, "memory-dir": { type: "string" } } });

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

if (!args.preview) fail(`npm run sleep previews and changes nothing; --preview is required\n${USAGE}`);
const at = parseAt(args.at);
if (at === null) fail(badAt(args.at));

const memory = new TechnicianMemory({ storage: "read", directory: args["memory-dir"], clock: () => at });
console.log(`sleep: store ${shownStore(memory.directory!)}`);
for (const line of renderSleep(previewSleep(memory))) console.log(line);
