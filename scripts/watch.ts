// npm run watch -- --tenant <id> --every <minutes> [--apply] [--skip collect|probe|validate|act|tickets|document]... [--tickets-dry-run] [--verbose|--quiet] [--help]
//
// The watcher (src/loop/watch.ts): one live cycle (src/loop/live.ts, the cycle npm run cycle runs) every <minutes>
// from the start of the last, until SIGINT. Each cycle prints the cycle's table (src/loop/present.ts) under its own
// header, "drift-agent · cycle <n> · tenant <id> · <time> UTC · watch every <minutes> min", then the time of the next
// cycle; each cycle writes its own trace to logs/cycle_<base36 ms>.jsonl, which its done line names. --verbose and
// --quiet are the cycle's. The first SIGINT ends the wait at once, or lets the cycle in progress run to its end; a
// second one exits at once with status 130. --every takes a whole number of minutes, 1 to 1440. The flags after it
// are the cycle's.
// Exit 0 after a SIGINT; 2 on a usage error or a missing setting (src/loop/live.ts liveRefusal).
//
// Measured 24 Oct 2026: test/loop.test.ts runs the loop over fake cycles; the live watcher is the operator's.

import { parseArgs } from "node:util";
import { redact } from "../src/config.ts";
import { SKIPPABLE, parseSkip, type Skippable } from "../src/loop/cycle.ts";
import { liveCycle, liveRefusal, liveShared, type LiveShared } from "../src/loop/live.ts";
import { presentOptions } from "../src/loop/present.ts";
import { watch } from "../src/loop/watch.ts";
import { TENANT } from "../src/policy/schema.ts";

const USAGE = `usage: npm run watch -- --tenant <id> --every <minutes> [--apply] [--skip ${SKIPPABLE.join("|")}]... [--tickets-dry-run] [--verbose|--quiet] [--help]`;

function usage(msg: string): never {
  console.error(`watch: ${msg}\n${USAGE}`);
  process.exit(2);
}

let args: { tenant?: string; every?: string; apply?: boolean; skip?: string[]; "tickets-dry-run"?: boolean; verbose?: boolean; quiet?: boolean; help?: boolean };
try {
  args = parseArgs({
    options: {
      tenant: { type: "string" }, every: { type: "string" }, apply: { type: "boolean" }, skip: { type: "string", multiple: true }, "tickets-dry-run": { type: "boolean" },
      verbose: { type: "boolean" }, quiet: { type: "boolean" }, help: { type: "boolean" },
    },
  }).values;
} catch (e) {
  usage((e as Error).message);
}
if (args.help) {
  console.log(USAGE);
  console.log("Runs the cycle every <minutes> until SIGINT, each cycle's table under its own numbered header.");
  process.exit(0);
}
if (!args.tenant || !TENANT.test(args.tenant) || args.tenant === "*") usage("--tenant is required: a tenant id ([A-Za-z0-9._-], up to 64)");
const every = Number(args.every);
if (!/^\d+$/.test(args.every ?? "") || every < 1 || every > 1440) usage("--every takes a whole number of minutes from 1 to 1440");
if (args.verbose && args.quiet) usage("--verbose and --quiet exclude each other");
let skip: Set<Skippable>;
try {
  skip = parseSkip(args.skip);
} catch (e) {
  usage((e as Error).message);
}
const present = presentOptions(args);
const apply = args.apply === true;
const opts = { tenant: args.tenant, apply, skip, ticketsDryRun: args["tickets-dry-run"] === true, present };
const refusal = liveRefusal(opts);
if (refusal) usage(refusal);

let shared: LiveShared;
try {
  shared = liveShared();
} catch (e) {
  usage(redact((e as Error).message));
}

const stop = new AbortController();
process.on("SIGINT", () => {
  if (stop.signal.aborted) process.exit(130);
  console.log("SIGINT · stopping after the cycle in progress · a second SIGINT exits at once");
  stop.abort();
});

const mode = `watch every ${every} min${apply ? ", applied" : ""}`;
try {
  const res = await watch({
    everyMs: every * 60_000, signal: stop.signal, scrub: (s) => shared.redactor.text(redact(s)), present,
    cycle: async (n) => {
      const { result, traceFile } = await liveCycle({ ...opts, header: { command: `cycle ${n}`, mode } }, shared);
      return { ...result, summary: `${result.summary}; trace ${traceFile}` };
    },
  });
  console.log(`watch · ${res.cycles} ${res.cycles === 1 ? "cycle" : "cycles"} · ${res.stopped} stopped at a failing step · ${res.threw} threw`);
} finally {
  await shared.store.close();
}
