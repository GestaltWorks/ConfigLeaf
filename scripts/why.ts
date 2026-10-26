// npm run why -- --finding <id> [--at <ISO 8601 UTC>] [--bundle sample/bundle.json] [--memory-dir <dir>]
//
// Why a finding was decided as it was, when a lesson of the technician's settled it: the trust-ledger lineage of that
// lesson (src/engine/lineage.ts). It prints the decision, the lesson that settled it (an exception in force, or one that
// lapsed and re-raised the finding), the correction the lesson was taught from and by whom, when and in which pass, the
// recall (an exact scope-key match, with the reference's hybrid score for it), any conflict the lesson met with who settled
// it and when, the rules approved from it by `npm run dream` and `npm run answer -- --approve-dream`, and the ledger's
// entries for it. A finding no lesson settled prints its decision and says so.
//
// `--finding` is the id the pass prints on every finding (`fnd-` plus 16 hex, stable across passes). The pass runs as
// scripts/sample.ts runs it, over the bundle with the lessons in the directory DRIFT_MEMORY_DIR names (--memory-dir for one
// command; examples/memory in sample mode when blank), at the same decision instant, so the verb printed is the verb the
// sample shows. The store is opened read only and nothing is written.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { lessonRows, ruleRows } from "../src/data/file-rows.ts";
import { decisionInstantWith } from "../src/data/instant.ts";
import { lineageOf, renderLineage } from "../src/engine/lineage.ts";
import { MemoryError, TechnicianMemory } from "../src/engine/memory.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { runPass } from "../src/pipeline.ts";

const USAGE = "usage: npm run why -- --finding <id> [--at <ISO 8601 UTC>] [--bundle sample/bundle.json] [--memory-dir <dir>]";

const { values: args } = parseArgs({
  options: { finding: { type: "string" }, at: { type: "string" }, bundle: { type: "string", default: "sample/bundle.json" }, "memory-dir": { type: "string" } },
});

const fail = (msg: string, code = 2): never => {
  console.error(msg);
  process.exit(code);
};

if (!args.finding) fail(USAGE);
// --at is the instant the lessons are recalled at (an expiry at or before it has lapsed); the clock when absent.
const at = args.at === undefined ? Date.now() : Date.parse(args.at);
if (Number.isNaN(at) || (args.at !== undefined && !/Z$/.test(args.at))) fail(`--at is an ISO 8601 UTC instant such as 2026-10-26T12:00:00Z, got ${JSON.stringify(args.at)}\n${USAGE}`);

try {
  const memory = new TechnicianMemory({ storage: "read", directory: args["memory-dir"], clock: () => at });
  const bundle = JSON.parse(readFileSync(args.bundle!, "utf8"));
  const engine = await SqlJsEngine.create();
  engine.loadBundle(bundle);
  engine.loadFileTables({ lesson: lessonRows(memory), rule: ruleRows() });
  const decidedAt = new Date(decisionInstantWith(bundle, memory.lessons().map((l) => l.recordedAt)) ?? Date.now()).toISOString();
  const pass = await runPass(new DataLayer(engine), { world: new DriftWorld("why"), memory, at: new Date(at).toISOString(), ledger: new MemoryLedger(engine), decidedAt });
  engine.close();
  const found = pass.findings.find((f) => f.id === args.finding);
  if (!found) {
    fail(`no finding ${args.finding} in the pass over ${args.bundle} (${pass.findings.length} findings). Their ids:\n${pass.findings.map((f) => `  ${f.id}  ${f.finding.class}  ${f.verb}  ${f.finding.host ?? f.finding.surface}  ${f.finding.object_id}  ${f.finding.setting_path}`).join("\n")}`, 1);
  }
  for (const line of renderLineage(lineageOf(memory, found!))) console.log(line);
} catch (err) {
  if (err instanceof MemoryError) fail(err.message, 1);
  throw err;
}
