// npm run dream [-- --at <ISO 8601 UTC>] [--memory-dir <dir>]
//
// What the vendored H-MEM dreaming (src/engine/dreaming.ts) proposes over the technician's lessons in force. The reference
// clusters related lessons; each cluster becomes rule proposals from what its lessons share: the tenant, the class, the
// reason and the expiry. A proposal reads "ADOPT <class> on these scope keys, for this reason, until this expiry, derived
// from these lessons", with the lessons approval supersedes and the statement that decisions stay the same. A cluster, or
// part of one, whose lessons share no class, reason and expiry yields no proposal, and the output says why. Proposing
// writes nothing. Approval is `npm run answer -- --approve-dream <id>`, the one writer; `npm run why` then prints
// "covered by rule" for the findings the rule covers.
//
// The store is the directory DRIFT_MEMORY_DIR names (--memory-dir for one command; examples/memory in sample mode when
// blank), opened read only. --at sets the instant that decides which lessons are in force.
import path from "node:path";
import { parseArgs } from "node:util";
import { dreamOver, renderDream } from "../src/engine/dreaming.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";

const USAGE = "usage: npm run dream [-- --at <ISO 8601 UTC>] [--memory-dir <dir>]";

const { values: args } = parseArgs({ options: { at: { type: "string" }, "memory-dir": { type: "string" } } });

const at = args.at === undefined ? Date.now() : Date.parse(args.at);
if (Number.isNaN(at) || (args.at !== undefined && !/Z$/.test(args.at))) {
  console.error(`--at is an ISO 8601 UTC instant such as 2026-12-01T00:00:00Z, got ${JSON.stringify(args.at)}\n${USAGE}`);
  process.exit(2);
}

const memory = new TechnicianMemory({ storage: "read", directory: args["memory-dir"], clock: () => at });
// The store as the screen names it: under the working directory, relative to it; else its last segment.
const rel = path.relative(process.cwd(), memory.directory!);
console.log(`dream: store ${rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.replace(/\\/g, "/") : path.basename(memory.directory!)}`);
for (const line of renderDream(dreamOver(memory))) console.log(line);
