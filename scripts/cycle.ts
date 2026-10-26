// npm run cycle -- --tenant <id> [--apply] [--skip collect|probe|validate|act|tickets|document]... [--tickets-dry-run] [--verbose|--quiet] [--help]
//
// One cycle of the loop for one tenant (src/loop/cycle.ts over src/loop/steps.ts liveSteps), in order:
// collect:cloudflare, collect:linux for every LINUX_HOSTS alias, probe, validate:copies for the new vault commits,
// the pass (with the PgLedger), explain (who or what changed each setting the pass moves on, from the hosts' journal,
// the Cloudflare audit log and the action ledger, src/explain/; a dry run explains too), act (dry run unless --apply),
// tickets, document (document.md at the repository root, gitignored). Each step runs the module its own command runs,
// in this process; the first failing step stops the cycle with its reason, and explain never fails it. The screen is
// one table (src/loop/present.ts) at the terminal's width (COLUMNS, else the terminal's columns less one, else 120),
// no line past it: a header, a row per step as it ends with its time on the row's first line, and under a row its
// facts one a line. Under the pass: the Zetaris queries, the DQ read, the classes, and a block for each ROLLBACK, FIX
// and ESCALATE (the verb and the class, the object, why). Under explain, whose row counts the causes by class
// ("explain   4 causes   operator 1 · agent 1 · unknown 2"): a block per cause with its sentence. Under act: a block
// per action. Under tickets: a line per operation, an opened issue's title under it. Then, after a blank line, the
// "what happened" block in a few plain sentences, each wrapped, each action's sentence followed by who or what changed
// the setting; and a done line naming the trace. --verbose adds each step's full line after its row; --quiet prints
// the header and the done line.
// The cycle's trace, every step's lines included, goes to logs/cycle_<base36 ms>.jsonl. --skip takes a comma list or
// repeats. --tickets-dry-run plans the tickets and sends nothing. --apply carries out the Actor's plan on the hosts
// and the zones.
// Exit 0 when the cycle ran to its end; 1 when a step failed; 2 on a usage error or a missing setting
// (src/loop/live.ts liveRefusal).
//
// Measured 24 Oct 2026 for client-1 with --skip collect,probe,validate (dry run): at 23:22 UTC the tickets step
// created issue #2 of DRIFT_TICKETS_REPO, an incident P1 for the proxy_split HOLD under rule 13 (alert always).
// Measured 25 Oct 2026 at 16:32 UTC for client-1 with --tickets-dry-run, off a TTY: the table in 13 lines, every
// row's time at column 90, each collect:linux row under its LINUX_HOSTS alias; collect 5.9, 3.4 and 3.5 s, probe 39
// names in 8.0 s, validate 3 copies, pass 27 findings (ADOPT 23, HOLD 3, ESCALATE 1, one ESCALATE line, the
// proxy_split hold expired 25 Oct 03:21 UTC) in 60.6 s, act nothing to do, tickets would close #5 (resolved),
// document 189 lines; done in 103.4 s, the trace logs/cycle_mvo1qgai.jsonl.
// Measured 25 Oct 2026 at 20:24 UTC on the lab (tenant lab-1, --apply --skip collect,validate --tickets-dry-run, a
// sudo tee break to 8098 collected first, run run-ea6025e231e361d0): pass 2 findings (ROLLBACK 1, HOLD 1) in 82.9 s,
// 427 queries through Zetaris; "explain   1 cause   operator 1" in 1.3 s; act rollback_file done in 3.7 s, 1 probe
// ok; and the what-happened line "A vhost file drifted from its approved copy; the agent restored it, nginx reloaded, 1
// probe passed, and a new ticket is drafted (tickets dry run). The file was changed at 20:22 UTC by user-212a17 over
// ssh from ip-391349 (sudo tee), 4 minutes before the agent restored it."; done in 98.1 s, 495 Zetaris queries, 0
// failed, the trace examples/traces/cycle_mvoa0l1i.jsonl.
// Measured 26 Oct 2026 at 01:36 and 01:38 UTC on the lab (tenant lab-1, --skip collect,validate,tickets, a dry run,
// the probe population from PROBE_TARGETS_OVERRIDE), off a TTY at COLUMNS 120 and 100: 29 and 32 lines, none past the
// width, each time at the width on its row's first line; pass 2 findings (ROLLBACK 1, HOLD 1) in 91.0 and 92.9 s, its
// ROLLBACK in three lines; explain 1 cause, operator 1, its sentence on a line of its own (two at 100); act 1 action
// planned; done in 102.7 and 104.8 s, 522 and 524 Zetaris queries, 0 failed, at 100 the trace on a second line.

import { parseArgs } from "node:util";
import { redact } from "../src/config.ts";
import { SKIPPABLE, parseSkip, type Skippable } from "../src/loop/cycle.ts";
import { liveCycle, liveRefusal, liveShared, type LiveShared } from "../src/loop/live.ts";
import { presentOptions } from "../src/loop/present.ts";
import { TENANT_ID, TENANT_ID_SHAPE } from "../src/policy/schema.ts";

const USAGE = `usage: npm run cycle -- --tenant <id> [--apply] [--skip ${SKIPPABLE.join("|")}]... [--tickets-dry-run] [--verbose|--quiet] [--help]`;

function usage(msg: string): never {
  console.error(`cycle: ${msg}\n${USAGE}`);
  process.exit(2);
}

let args: { tenant?: string; apply?: boolean; skip?: string[]; "tickets-dry-run"?: boolean; verbose?: boolean; quiet?: boolean; help?: boolean };
try {
  args = parseArgs({
    options: {
      tenant: { type: "string" }, apply: { type: "boolean" }, skip: { type: "string", multiple: true }, "tickets-dry-run": { type: "boolean" },
      verbose: { type: "boolean" }, quiet: { type: "boolean" }, help: { type: "boolean" },
    },
  }).values;
} catch (e) {
  usage((e as Error).message);
}
if (args.help) {
  console.log(USAGE);
  console.log("Runs one cycle: collect, probe, validate, pass, explain (who or what changed each setting the pass moves on), act (dry run unless --apply), tickets, document; one row per step, --verbose adds each step's full line, --quiet prints the header and the done line.");
  process.exit(0);
}
if (!args.tenant || !TENANT_ID.test(args.tenant)) usage(`--tenant is required: ${TENANT_ID_SHAPE}`);
if (args.verbose && args.quiet) usage("--verbose and --quiet exclude each other");
let skip: Set<Skippable>;
try {
  skip = parseSkip(args.skip);
} catch (e) {
  usage((e as Error).message);
}
const present = presentOptions(args);
const opts = { tenant: args.tenant, apply: args.apply === true, skip, ticketsDryRun: args["tickets-dry-run"] === true, present };
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
  if (present.verbose) console.log(`cycle: trace ${traceFile} (${traceLines} lines)`);
  process.exitCode = result.stopped ? 1 : 0;
} catch (e) {
  console.error(`cycle: ${shared.redactor.text(redact((e as Error)?.message ?? String(e)))}`);
  process.exitCode = 1;
} finally {
  await shared.store.close();
}
