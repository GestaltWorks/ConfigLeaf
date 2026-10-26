// npm run dream [-- --at <ISO 8601 UTC>] [--memory-dir <dir>]
//
// What the vendored H-MEM dreaming (src/engine/dreaming.ts) proposes over the technician's lessons in force: clusters of
// related lessons written up as an insight or an invariant, each with the lessons it derives from, what those lessons
// share, and whether its content says more than the lessons do. Proposing writes nothing. Approval is
// `npm run answer -- --approve-dream <id>`, the one writer; the approved rule carries `derivedFrom` lineage that
// `npm run why` shows.
//
// The store is the directory DRIFT_MEMORY_DIR names (--memory-dir for one command; examples/memory in sample mode when
// blank), opened read only. --at sets the instant that decides which lessons are in force.
import { parseArgs } from "node:util";
import { dreamOver, inForce, renderDream } from "../src/engine/dreaming.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";

const USAGE = "usage: npm run dream [-- --at <ISO 8601 UTC>] [--memory-dir <dir>]";

const { values: args } = parseArgs({ options: { at: { type: "string" }, "memory-dir": { type: "string" } } });

const at = args.at === undefined ? Date.now() : Date.parse(args.at);
if (Number.isNaN(at) || (args.at !== undefined && !/Z$/.test(args.at))) {
  console.error(`--at is an ISO 8601 UTC instant such as 2026-12-01T00:00:00Z, got ${JSON.stringify(args.at)}\n${USAGE}`);
  process.exit(2);
}

const memory = new TechnicianMemory({ storage: "read", directory: args["memory-dir"], clock: () => at });
console.log(`dream: store ${memory.directory}`);
for (const line of renderDream(dreamOver(memory), inForce(memory).length)) console.log(line);
