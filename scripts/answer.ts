// npm run answer -- --finding <id> --accept --until <ISO 8601 UTC> --reason "..." [--scope host|name|address] [--by <role>]
// npm run answer -- --finding <id> --question "..." --answer "..." [--until <ISO 8601 UTC>] [--scope host|name|address] [--by <role>]
// npm run answer -- --list [--tenant <id>]
// npm run answer -- --forget <lesson id> [--reason "..."]
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
//   --answer    an answer to a question the agent would otherwise ask, on this scope, until --until
//               (default: 30 days from now).
//   --scope     which of the finding's values the lesson keys on: its DNS name (default when it has one),
//               its host, or the address it resolves to. Exact match only; a lesson about one name never
//               applies to another.
//
// Lessons live in the directory DRIFT_MEMORY_DIR names (state.json, ledger.jsonl; src/config.ts), --memory-dir
// for one command: when it is blank, .world/memory (gitignored), or examples/memory in sample mode, the committed store a clean clone
// and CI decide with. Recording and --forget write the store; --list only reads it. Free text (reason, question,
// answer, --by) goes through the redactor before it is stored; the printed lesson is the stored one.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { MemoryError, TechnicianMemory, scopeValuesOf, type Lesson, type ScopeType } from "../src/engine/memory.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { runPass, type Finding } from "../src/pipeline.ts";

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
  "  options: --bundle sample/bundle.json  --memory-dir <dir>   (the store's directory; DRIFT_MEMORY_DIR by default; blank: .world/memory, examples/memory in sample mode)",
].join("\n");

const fail = (msg: string, code = 2): never => {
  console.error(msg);
  process.exit(code);
};

const memory = new TechnicianMemory({ storage: args.list ? "read" : "local", directory: args["memory-dir"] });
const where = memory.directory!;

const describe = (l: Lesson): string => l.kind === "exception"
  ? `${l.id}  exception  ${l.findingClass} on ${l.scopeKey} (${l.tenantId})  until ${l.expiresAt}  by ${l.provenance.by} at ${l.recordedAt}: ${l.reason}`
  : `${l.id}  answer     ${l.scope.type} ${l.scope.key} (${l.tenantId})  until ${l.expiresAt}  by ${l.provenance.by} at ${l.recordedAt}: Q ${l.question} A ${l.answer}`;

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
    ? memory.recordException({ tenantId: f.tenant_id, findingClass: f.class, scopeKey: key!, reason: args.reason!, expiresAt: until, provenance })
    : memory.recordAnswer({ tenantId: f.tenant_id, question: args.question!, answer: args.answer!, scope: { type, key: key! }, expiresAt: until, provenance });
  console.log(JSON.stringify(lesson, null, 2));
  console.log("");
  console.log(`recorded ${describe(lesson)}`);
  console.log(`stored in ${where}; the store holds ${memory.lessons().length} lesson(s)`);
  if (lesson.kind === "exception") {
    const affected = pass.findings.filter((x) => x.finding.tenant_id === f.tenant_id && x.finding.class === f.class && Object.values(scopeValuesOf(x.finding)).flat().includes(key!));
    console.log(`on the next pass ${affected.length} finding(s) of class ${f.class} on ${type} ${key} are ADOPT under this exception until ${lesson.expiresAt}, then re-raised: ${affected.map((x) => `${x.id} (${x.verb} today)`).join(", ")}`);
  } else {
    console.log(`the Decider will not ask "${lesson.question}" again on ${type} ${key} until ${lesson.expiresAt}`);
  }
} catch (err) {
  if (err instanceof MemoryError) fail(err.message, 1);
  throw err;
}
