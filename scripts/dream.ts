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
import { parseArgs } from "node:util";
import { badAt, parseAt, shownStore } from "../src/engine/cli.ts";
import { dreamOver, renderDream } from "../src/engine/dreaming.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";

const { values: args } = parseArgs({ options: { at: { type: "string" }, "memory-dir": { type: "string" } } });

const at = parseAt(args.at);
if (at === null) {
  console.error(badAt(args.at));
  process.exit(2);
}

const memory = new TechnicianMemory({ storage: "read", directory: args["memory-dir"], clock: () => at });
console.log(`dream: store ${shownStore(memory.directory!)}`);
for (const line of renderDream(dreamOver(memory))) console.log(line);
