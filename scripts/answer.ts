// npm run answer -- --finding <id> --accept --until <ISO 8601 UTC> --reason "..." [--scope host|name|address] [--by <role>]
// npm run answer -- --finding <id> --question "..." --answer "..." [--until <ISO 8601 UTC>] [--scope host|name|address] [--by <role>]
// npm run answer -- --list [--tenant <id>]
// npm run answer -- --forget <lesson id> [--reason "..."]
// npm run answer -- --approve-dream <proposal id> [--by <role>]
//   [--supersede <lesson id>]... [--keep-both <lesson id>]...   (with --accept or --answer, to settle a conflict)
//   [--bundle sample/bundle.json] [--memory-dir <dir>]
//
// The technician teaches the agent one lesson about one finding (src/engine/memory.ts, TechnicianMemory
// over the vendored H-MEM reference). `--finding` is the id the pass prints on every finding (`fnd-` plus
// 16 hex, stable across passes); the script runs the pass over the bundle to find it, so the lesson is
// scoped to what the finding actually names, never to a typed host or name.
//
//   --accept    an accepted exception: findings of this class on this scope are ADOPT until --until, then
//               re-raised as ESCALATE ("exception lapsed"). --until is required; an exception without an
//               expiry is a permanent silence, which the agent does not record.
//   --answer    an answer to a question, on this scope, until --until (default: 30 days from now); stored
//               and listed, the pass reads exceptions only.
//   --scope     which of the finding's values the lesson keys on: its DNS name (default when it has one),
//               its host, or the address it resolves to. Exact match only; a lesson about one name never
//               applies to another.
//
// The conflict gate (src/engine/memory.ts): a lesson that contradicts a lesson in force on the same tenant and scope key
// (two exceptions for one class that expire at different instants, two different answers to one question, or a text
// conflict the reference's detector reads in the free text) is refused, naming both, and nothing is stored. Each conflict
// is settled by id, explicitly: --supersede <id> stores the new lesson and keeps the old one on record, marked superseded
// and no longer recalled; --keep-both <id> stores it beside the old one. The ledger records the conflict and who settled it,
// which `npm run why` prints.
//
// --approve-dream approves one rule proposal of `npm run dream` by its id (drm- and 12 hex). Dreaming runs again over the
// lessons as they stand, so an id from before a lesson changed is refused. The rule is recorded through the same gate as a
// lesson, as one exception for the class over the proposal's scope keys with `derivedFrom` lineage, and it supersedes the
// lessons it is derived from (kept on record, no longer recalled). The Decider recalls the rule where it recalled those
// lessons and decides the same findings the same way, since the rule states each lesson's class, reason and expiry and
// covers exactly their scope keys; `npm run why` prints "covered by rule". --supersede and --keep-both settle a conflict
// with a lesson outside the proposal. This command is the only writer of the store.
//
// Lessons live in the directory DRIFT_MEMORY_DIR names (state.json, ledger.jsonl; src/config.ts), --memory-dir
// for one command: when it is blank, .world/memory (gitignored), or examples/memory in sample mode, the committed store a clean clone
// and CI decide with. Recording and --forget write the store; --list only reads it. Free text (reason, question,
// answer, --by) goes through the redactor before it is stored; the printed lesson is the stored one.
//
// After a write to the store the live pass reads (DRIFT_MEMORY_DIR), outside sample mode and with ZETARIS_API_KEY set,
// the Zetaris copy of the lessons and the rules goes in again when its hash differs from the last copy's
// (refreshFileTables), so LESSONS.lesson holds the new lesson before the next pass; one "zetaris:" line says which.

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "../src/config.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { approveDream } from "../src/engine/dreaming.ts";
import { ConflictError, MemoryError, TechnicianMemory, describeLesson, scopeValuesOf, type ConflictResolution, type Lesson, type ScopeType } from "../src/engine/memory.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { runPass, type Finding } from "../src/pipeline.ts";
import { refreshText } from "../src/zetaris/filestore.ts";
import { refreshFileTables } from "../src/zetaris/setup.ts";

const { values: args } = parseArgs({
  options: {
    finding: { type: "string" },
    accept: { type: "boolean", default: false },
    until: { type: "string" },
    reason: { type: "string" },
    question: { type: "string" },
    answer: { type: "string" },
    scope: { type: "string" },
    by: { type: "string", default: "technician" },
    list: { type: "boolean", default: false },
    tenant: { type: "string" },
    forget: { type: "string" },
    supersede: { type: "string", multiple: true },
    "keep-both": { type: "string", multiple: true },
    "approve-dream": { type: "string" },
    bundle: { type: "string", default: "sample/bundle.json" },
    "memory-dir": { type: "string" },
  },
});

const USAGE = [
  "usage:",
  '  npm run answer -- --finding <id> --accept --until <ISO 8601 UTC> --reason "..." [--scope host|name|address] [--by <role>]',
  '  npm run answer -- --finding <id> --question "..." --answer "..." [--until <ISO 8601 UTC>] [--scope host|name|address] [--by <role>]',
  "  npm run answer -- --list [--tenant <id>]",
  '  npm run answer -- --forget <lesson id> [--reason "..."]',
  "  npm run answer -- --approve-dream <proposal id> [--by <role>]   (proposal ids: npm run dream)",
  "  a recorded lesson that contradicts one in force is refused; settle each conflict by id: --supersede <lesson id> or --keep-both <lesson id> (repeat the flag per lesson)",
  "  options: --bundle sample/bundle.json  --memory-dir <dir>   (the store's directory; DRIFT_MEMORY_DIR by default; blank: .world/memory, examples/memory in sample mode)",
].join("\n");

const fail = (msg: string, code = 2): never => {
  console.error(msg);
  process.exit(code);
};

const memory = new TechnicianMemory({ storage: args.list ? "read" : "local", directory: args["memory-dir"], gate: true });
const where = memory.directory!;

/** After a write: the Zetaris copy of the store the live pass reads, put again when stale. */
async function refreshZetaris(): Promise<void> {
  if (config.sampleMode || !config.zetaris.apiKey || path.resolve(where) !== path.resolve(config.memoryDir)) return;
  const r = await refreshFileTables();
  console.log(`zetaris: ${refreshText(r)}${r.status === "failed" ? "; the next live pass or npm run zetaris:setup puts them" : ""}`);
}

const describe = describeLesson;

const resolutions: ConflictResolution[] = [
  ...(args.supersede ?? []).map((id): ConflictResolution => ({ with: id, strategy: "supersede" })),
  ...(args["keep-both"] ?? []).map((id): ConflictResolution => ({ with: id, strategy: "keep_both" })),
];

/** The gate's refusal: both sides named, the way to settle each by id, exit 1; nothing was stored. */
function refuseConflict(err: ConflictError, what: string, on = ""): never {
  console.error(`refused: this ${what} contradicts ${err.conflicts.length} lesson(s) in force${on ? ` ${on}` : ""}; nothing is stored`);
  for (const c of err.conflicts) {
    console.error(`  held  ${describe(c.with)}`);
    console.error(`        ${c.reason}`);
  }
  console.error(`  new   ${err.candidate}`);
  console.error("settle each conflict by id and run the command again:");
  for (const c of err.conflicts) {
    console.error(`  --supersede ${c.with.id}    the new ${what} replaces ${c.with.id}, which stays on record, marked superseded, and is no longer recalled`);
    console.error(`  --keep-both ${c.with.id}    both stay in force`);
  }
  process.exit(1);
}

if (args.list) {
  const lessons = memory.lessons(args.tenant);
  console.log(`${lessons.length} lesson(s) in ${where}${args.tenant ? ` for ${args.tenant}` : ""}`);
  for (const l of lessons) console.log(`  ${describe(l)}`);
  process.exit(0);
}

if (args.forget) {
  const l = memory.forget(args.forget, args.reason ?? "withdrawn by the technician");
  if (!l) fail(`no lesson ${args.forget} in ${where}`, 1);
  console.log(`forgot ${describe(l!)}`);
  console.log(`the store now holds ${memory.lessons().length} lesson(s); the withdrawal is in the ledger (${where})`);
  await refreshZetaris();
  process.exit(0);
}

if (args["approve-dream"]) {
  try {
    const rule = approveDream(memory, args["approve-dream"], args.by!, resolutions);
    console.log(`approved ${rule.proposalId} as ${rule.id}: ADOPT ${rule.findingClass} on ${rule.scopeKeys.length} scope(s), tenant ${rule.tenantId}, until ${rule.expiresAt}, derived from ${rule.derivedFrom.length} lesson(s): ${rule.derivedFrom.join(" ")}`);
    console.log(`superseded ${rule.derivedFrom.length} lesson(s): kept on record and no longer recalled; the rule decides the same findings the same way`);
    for (const r of resolutions) console.log(`settled ${r.with}: ${r.strategy === "supersede" ? `superseded by ${rule.id}, kept on record and no longer recalled` : `kept beside ${rule.id}, both in force`}`);
    console.log(`approved by ${rule.provenance.by} at ${rule.recordedAt}; stored in ${where}; npm run why -- --finding <id> shows "covered by rule ${rule.id}"`);
  } catch (err) {
    if (err instanceof ConflictError) refuseConflict(err, "rule");
    if (err instanceof MemoryError) fail(err.message, 1);
    throw err;
  }
  await refreshZetaris();
  process.exit(0);
}

if (!args.finding) fail(USAGE);
if (args.accept === Boolean(args.answer)) fail(`one of --accept or --answer is required\n${USAGE}`);
if (args.accept && !args.until) fail("--accept needs --until <ISO 8601 UTC>: an exception without an expiry is not recorded");
if (args.accept && !args.reason) fail('--accept needs --reason "..."');
if (args.answer && !args.question) fail('--answer needs --question "..."');

// Find the finding: the pass over the bundle, no trace, no memory (the lesson is about the finding as detected).
const engine = await SqlJsEngine.create();
engine.loadBundle(JSON.parse(readFileSync(args.bundle, "utf8")));
const pass = await runPass(new DataLayer(engine), { world: new DriftWorld("answer") });
engine.close();
const finding: Finding | undefined = pass.findings.find((f) => f.id === args.finding);
if (!finding) {
  fail(`no finding ${args.finding} in the pass over ${args.bundle} (${pass.findings.length} findings). Their ids:\n${pass.findings.map((f) => `  ${f.id}  ${f.finding.class}  ${f.finding.host ?? f.finding.surface}  ${f.finding.object_id}  ${f.finding.setting_path}`).join("\n")}`, 1);
}
const f = finding!.finding;
const scopes = scopeValuesOf(f);
const type: ScopeType = (args.scope as ScopeType | undefined) ?? (scopes.name.length ? "name" : scopes.host.length ? "host" : "address");
if (!["host", "name", "address"].includes(type)) fail(`--scope is host, name or address, not ${JSON.stringify(args.scope)}`);
const key = scopes[type][0];
if (!key) fail(`finding ${finding!.id} has no ${type} to scope a lesson on (host ${scopes.host[0] ?? "none"}, name ${scopes.name[0] ?? "none"}, address ${scopes.address[0] ?? "none"})`, 1);

const now = new Date().toISOString();
const provenance = { kind: "cli", at: now, by: args.by!, runId: f.run_id };
const until = args.until ?? new Date(Date.parse(now) + 30 * 86_400_000).toISOString();

try {
  const lesson: Lesson = args.accept
    ? memory.recordException({ tenantId: f.tenant_id, findingClass: f.class, scopeKey: key!, reason: args.reason!, expiresAt: until, provenance, resolutions })
    : memory.recordAnswer({ tenantId: f.tenant_id, question: args.question!, answer: args.answer!, scope: { type, key: key! }, expiresAt: until, provenance, resolutions });
  console.log(JSON.stringify(lesson, null, 2));
  console.log("");
  console.log(`recorded ${describe(lesson)}`);
  for (const r of resolutions) console.log(`settled ${r.with}: ${r.strategy === "supersede" ? `superseded by ${lesson.id}, kept on record and no longer recalled` : `kept beside ${lesson.id}, both in force`}; the ledger holds conflict_detected and conflict_resolved by ${lesson.provenance.by}`);
  console.log(`stored in ${where}; the store holds ${memory.lessons().length} lesson(s)`);
  if (lesson.kind === "exception") {
    const affected = pass.findings.filter((x) => x.finding.tenant_id === f.tenant_id && x.finding.class === f.class && Object.values(scopeValuesOf(x.finding)).flat().includes(key!));
    console.log(`on the next pass ${affected.length} finding(s) of class ${f.class} on ${type} ${key} are ADOPT under this exception until ${lesson.expiresAt}, then re-raised: ${affected.map((x) => `${x.id} (${x.verb} today)`).join(", ")}`);
  } else {
    console.log(`the Decider will not ask "${lesson.question}" again on ${type} ${key} until ${lesson.expiresAt}`);
  }
} catch (err) {
  if (err instanceof ConflictError) refuseConflict(err, "lesson", `on ${key} (${f.tenant_id})`);
  if (err instanceof MemoryError) fail(err.message, 1);
  throw err;
}
await refreshZetaris();
