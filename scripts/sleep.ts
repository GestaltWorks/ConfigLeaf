// npm run sleep -- --preview [--at <ISO 8601 UTC>] [--memory-dir <dir>]
//
// The sleep cycle's plan for the technician's lessons (src/engine/sleep-preview.ts, the vendored H-MEM SleepCycleService):
// the records a cycle consolidates, archives and synthesizes, the lessons whose own expiry has passed, and what the lessons
// cover before and after the reference's execute() on a scratch copy. Preview only: this command changes nothing, and
// there is no execute, because a synthesized record keeps the first lesson's scope key and drops the others from recall.
//
// The store is the directory DRIFT_MEMORY_DIR names (--memory-dir for one command; examples/memory in sample mode when
// blank), opened read only. --at looks ahead to a later instant: the age and expiry rules run at that instant.
import path from "node:path";
import { parseArgs } from "node:util";
import { TechnicianMemory } from "../src/engine/memory.ts";
import { previewSleep, renderSleep } from "../src/engine/sleep-preview.ts";

const USAGE = "usage: npm run sleep -- --preview [--at <ISO 8601 UTC>] [--memory-dir <dir>]";

const { values: args } = parseArgs({ options: { preview: { type: "boolean", default: false }, at: { type: "string" }, "memory-dir": { type: "string" } } });

const fail = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};

if (!args.preview) fail(`npm run sleep previews and changes nothing; --preview is required\n${USAGE}`);
const at = args.at === undefined ? Date.now() : Date.parse(args.at);
if (Number.isNaN(at) || (args.at !== undefined && !/Z$/.test(args.at))) fail(`--at is an ISO 8601 UTC instant such as 2026-12-01T00:00:00Z, got ${JSON.stringify(args.at)}\n${USAGE}`);

const memory = new TechnicianMemory({ storage: "read", directory: args["memory-dir"], clock: () => at });
// The store as the screen names it: under the working directory, relative to it; else its last segment.
const rel = path.relative(process.cwd(), memory.directory!);
console.log(`sleep: store ${rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.replace(/\\/g, "/") : path.basename(memory.directory!)}`);
for (const line of renderSleep(previewSleep(memory))) console.log(line);
