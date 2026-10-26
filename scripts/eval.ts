// npm run eval -- [--set dev|heldout|all] [--configs C0,C1] [--runs <n>] [--items E01,E02] [--planted | --no-planted]
//                 [--bundle test/fixtures/recorded-bundle.json] [--tenant <id>] [--out <dir>]
//
// The eval runner of eval/PROTOCOL.md (src/eval/run.ts) over the recording the items came from, through sql.js,
// with the rules of DRIFT_POLICY_FILE (default policy/hackathon.json) for the recording's tenant loaded before its passes.
// The configurations, the run count and the verb reading come from the protocol; items from eval/items.json,
// labels from eval/labels.json, the split from the sha256 of labels.json; model calls go to Nightshift under
// the tenant's app id, every answer counted on a verified receipt. The planted claims of eval/planted.json go to
// every judging configuration unless --no-planted (with --items, only when --planted is given).
//
// Output, under eval/results/<UTC timestamp>/ or --out: <config>-run<n>.json per configuration and run (every
// item: verdict, checks run and valid, strikes, receipt ids, served models, cache statuses, latency, tokens; the
// run's counts), planted.json (each planted claim per judging run) and summary.md. Every file passes the
// deny-list probe (src/redactor.ts countLabels over REDACT_WORDS and EXPORT_DENY_WORDS) before it is written;
// one match and that file is withheld and the command exits 1. One line per configuration run on stdout; the
// trace goes to logs/eval_<timestamp>.jsonl.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../src/config.ts";
import { loadEvalSet } from "../src/eval/items.ts";
import { loadPlanted } from "../src/eval/planted.ts";
import { renderSummary } from "../src/eval/report.ts";
import { runEval, type SetChoice } from "../src/eval/run.ts";
import { LogTracer } from "../src/eval/tracer.ts";
import { countLabels } from "../src/redactor.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const list = (s: string | undefined): string[] | undefined => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

// supplementary:begin. Added 26 Oct 2026: --set supplementary (eval/supplementary/README.md, post hoc, not pre-registered)
// goes to scripts/eval-supplementary.ts before the parsing below; every line outside this block is the runner as committed
// at 40751d8 (test/supplementary.test.ts holds it to that commit's sha256).
if (arg("set") === "supplementary") process.exit(await (await import("./eval-supplementary.ts")).main(process.argv));
// supplementary:end
const set = (arg("set") ?? "all") as SetChoice;
if (!["dev", "heldout", "all"].includes(set)) {
  console.error(`--set takes dev, heldout or all, got ${set}`);
  process.exit(2);
}
const runsArg = arg("runs");
const items = list(arg("items"));
const bundlePath = arg("bundle") ?? "test/fixtures/recorded-bundle.json";
const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
const out = arg("out") ?? path.join("eval", "results", stamp);
const usePlanted = flag("no-planted") ? false : items ? flag("planted") : true;

const tracer = new LogTracer(`eval_${stamp}`);
const result = await runEval({
  protocolText: readFileSync("eval/PROTOCOL.md", "utf8"),
  evalSet: loadEvalSet(),
  bundle: JSON.parse(readFileSync(bundlePath, "utf8")),
  configs: list(arg("configs")),
  runs: runsArg ? Number(runsArg) : undefined,
  set,
  items,
  planted: usePlanted ? loadPlanted().claims : [],
  tenant: arg("tenant"),
  tracer,
  onRun: (r) => {
    const c = r.counts;
    console.log(`EVAL ${r.config.id} run ${r.run}${r.valid ? "" : ` INVALID (${r.invalid_reason})`}: ${c.scored} scored of ${c.items}, ${c.with_verdict} with a verdict, ${c.not_judged} not judged, agree ${c.agree}, disagree ${c.disagree}, unsure ${c.unsure}; checks selected ${c.checks_selected}, valid ${c.checks_valid}, ran ${c.checks_ran_unmodified}; falsifier ran ${c.falsifier_ran}, struck ${c.falsifier_struck}; ${c.calls} call(s), cache hits ${c.cache_hits}, substitutions ${c.substitutions}`);
  },
});

const words = [...new Set([...config.redactWords, ...config.exportDenyWords])];
const files: [string, string][] = [
  ...result.runs.map((r): [string, string] => [`${r.config.id}-run${r.run}.json`, JSON.stringify({
    config: r.config, run: r.run, valid: r.valid, invalid_reason: r.invalid_reason, started_at: r.started_at, finished_at: r.finished_at,
    recording: bundlePath, tenant: result.tenant, decided_at: result.decided_at, policy: result.policy, split_seed: result.split.seed, set: result.set,
    counts: r.counts, items: r.items, calls: r.calls, pass: r.pass,
  }, null, 1) + "\n"]),
  ["planted.json", JSON.stringify({ recording: bundlePath, claims: result.planted }, null, 1) + "\n"],
  ["summary.md", renderSummary(result, { recording: bundlePath, out: path.basename(out) })],
];
mkdirSync(out, { recursive: true });
let withheld = 0;
for (const [name, text] of files) {
  const hits = Object.entries(countLabels(text, words));
  if (hits.length) {
    withheld += 1;
    console.error(`EVAL ${name} withheld: the deny-list probe matched ${hits.map(([w, n]) => `label #${words.indexOf(w) + 1} x${n}`).join(", ")}`);
    continue;
  }
  writeFileSync(path.join(out, name), text);
}
const kept = files.length - withheld;
console.log(`EVAL: ${result.runs.length} configuration run(s) over ${result.itemIds.length} item(s) of the ${result.set} set under ${result.policy.file} version ${result.policy.version}; ${result.planted.length} planted judgement(s); ${kept} file(s) written to ${out}${withheld ? `, ${withheld} withheld` : ""}; deny-list probe ${withheld ? `matched in ${withheld} file(s)` : `0 matches over ${files.length} file(s)`}; trace logs/${tracer.traceId}.jsonl`);
if (withheld) process.exit(1);
