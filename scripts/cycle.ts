// npm run cycle -- --tenant <id> [--apply] [--skip collect|probe|validate|act|tickets|document]... [--tickets-dry-run] [--help]
//
// One cycle of the loop for one tenant (src/loop/cycle.ts over src/loop/steps.ts liveSteps), in order:
// collect:cloudflare, collect:linux for every LINUX_HOSTS alias, probe, validate:copies for the new vault commits,
// the pass (with the PgLedger), act (dry run unless --apply), tickets, document (document.md at the repository root,
// gitignored). Each step runs the module its own command runs, in this process; each prints one summary line; the
// first failing step stops the cycle with its reason. The cycle's trace, every step's lines included, goes to
// logs/cycle_<base36 ms>.jsonl. --skip takes a comma list or repeats. --tickets-dry-run plans the tickets and sends
// nothing. --apply carries out the Actor's plan on the hosts and the zones.
// Exit 0 when the cycle ran to its end; 1 when a step failed; 2 on a usage error or a missing setting
// (src/loop/live.ts liveRefusal).
//
// Measured 24 Oct 2026 for client-1 with --skip collect,probe,validate (dry run): at 23:22 UTC the tickets step
// created issue #2 of DRIFT_TICKETS_REPO, an incident P1 for the proxy_split HOLD under rule 13 (alert always). At
// 23:26 UTC: pass 34.3 s (27 findings, HOLD 27; 0 dispositions written, the 27 rows of the 23:21 UTC pass kept on the
// same runs), act 0.4 s (27 dispositions of 3 runs in scope, 0 actions planned), tickets 1.2 s (1 ticket row before;
// plan create 0, comment 0, close 0, skip 27), document 5.7 s (document.md, 150 lines, 27 findings open, 32 queries,
// deny-list probe 0 of 27 labels); the cycle 41.6 s, 526 trace lines.

import { parseArgs } from "node:util";
import { redact } from "../src/config.ts";
import { SKIPPABLE, parseSkip, type Skippable } from "../src/loop/cycle.ts";
import { liveCycle, liveRefusal, liveShared, type LiveShared } from "../src/loop/live.ts";
import { TENANT } from "../src/policy/schema.ts";

const USAGE = `usage: npm run cycle -- --tenant <id> [--apply] [--skip ${SKIPPABLE.join("|")}]... [--tickets-dry-run] [--help]`;

function usage(msg: string): never {
  console.error(`cycle: ${msg}\n${USAGE}`);
  process.exit(2);
}

let args: { tenant?: string; apply?: boolean; skip?: string[]; "tickets-dry-run"?: boolean; help?: boolean };
try {
  args = parseArgs({ options: { tenant: { type: "string" }, apply: { type: "boolean" }, skip: { type: "string", multiple: true }, "tickets-dry-run": { type: "boolean" }, help: { type: "boolean" } } }).values;
} catch (e) {
  usage((e as Error).message);
}
if (args.help) {
  console.log(USAGE);
  console.log("Runs one cycle: collect, probe, validate, pass, act (dry run unless --apply), tickets, document; one summary line per step.");
  process.exit(0);
}
if (!args.tenant || !TENANT.test(args.tenant) || args.tenant === "*") usage("--tenant is required: a tenant id ([A-Za-z0-9._-], up to 64)");
let skip: Set<Skippable>;
try {
  skip = parseSkip(args.skip);
} catch (e) {
  usage((e as Error).message);
}
const opts = { tenant: args.tenant, apply: args.apply === true, skip, ticketsDryRun: args["tickets-dry-run"] === true };
const refusal = liveRefusal(opts);
if (refusal) usage(refusal);

let shared: LiveShared;
try {
  shared = liveShared();
} catch (e) {
  usage(redact((e as Error).message));
}
try {
  const { result, traceFile, traceLines } = await liveCycle(opts, shared);
  console.log(`cycle: trace ${traceFile} (${traceLines} lines)`);
  process.exitCode = result.stopped ? 1 : 0;
} catch (e) {
  console.error(`cycle: ${shared.redactor.text(redact((e as Error)?.message ?? String(e)))}`);
  process.exitCode = 1;
} finally {
  await shared.store.close();
}
