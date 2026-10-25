// SAMPLE_MODE entry point: the real pass (src/pipeline.ts) over sample/bundle.json through
// DataLayer(SqlJsEngine), with no model. The DQ gate, the hero query and every precondition run as
// SQL over the bundle's rows and the World Model confirms FOUND-BUT-DIFFERENT from what it recorded;
// nothing here maps an input to a stored answer. Prints one JSON finding per line, then one disposition
// line per finding as the ledger holds it under the finding's disposition_id, then one CAUSE line per finding
// the explain step explains, then one ADOPTIONS line (the DQ rule exception_in_force over the pass's ADOPTs under an
// exception: the drift_usl.adoption SQL over the ledger and the lesson table, which sql.js holds beside the bundle as
// Zetaris holds LESSONS.lesson, with the rule table from the policy file), then one summary, then one REPORT line: the owner's report (src/document/report.ts) for
// the tenant of the bundle's latest DNS run, rendered from the owner's document's rows over the same engine after the
// explain step and written to examples/report.html once it passes the deny-list probe (src/document/sample.ts
// sampleReport: no clock, trace or tip in it, so npm run document in sample mode writes the same bytes).
//
// The explain step (src/explain/explain.ts) runs after the pass, as a cycle runs it between the pass and act: for
// each tenant of the pass's findings, from the bundle's own rows, with no vault and no model, one finding_cause row
// per explained finding into the same engine. Its evidence is the bundle's audit_event rows: the Cloudflare audit
// log's give an account_change or a token_change on the record a finding rests on; the bundle holds no journal rows,
// so a file finding's cause reads unknown with its window stated. Its redactor is BUNDLE_REDACTOR, a fixed salt over
// rows already redacted, so the CAUSE lines are the same with or without a .env.
//
// The Decider consults the technician's memory (src/engine/memory.ts, the vendored H-MEM reference in the
// directory DRIFT_MEMORY_DIR names, examples/memory, the committed store, when it is blank), opened read only: a
// lesson recorded with `npm run answer` changes the verb of the finding it scopes on the next run of this script, until it expires,
// and the store is left as it was. The pass records its dispositions and referent
// fingerprints through a MemoryLedger into the same sql.js engine, and the disposition lines are read back
// from it through the DataLayer. With no lesson recorded and no policy_rule rows in the bundle every
// disposition is the default's (decided_by default) and the verbs are ADOPT and ESCALATE. Every disposition
// is decided at the bundle's own instant (src/data/instant.ts: the later of its latest run's finish and its latest
// ledger row), or at the instant the latest lesson was taught when that is later (decisionInstantWith), so two runs
// over the same bundle and store print the same finding, disposition and summary lines; the trace lines carry their
// own timestamps and latencies.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.ts";
import { renderDocument } from "../src/document/render.ts";
import { sampleReport, textSha256 } from "../src/document/sample.ts";
import { countLabels } from "../src/redactor.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { decisionInstantWith } from "../src/data/instant.ts";
import { DISPOSITIONS_SQL, objects } from "../src/data/queries.ts";
import { lessonRows, ruleRows } from "../src/data/file-rows.ts";
import { ADOPTION_CHECK_SQL } from "../src/data/files.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { CAUSE_CLASSES } from "../src/explain/cause.ts";
import { BUNDLE_REDACTOR, MemoryCauseSink, explainTenants } from "../src/explain/explain.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { dispositionIdOf } from "../src/loop/pass.ts";
import { VERBS, runPass } from "../src/pipeline.ts";
import { Tracer } from "../src/trace.ts";
import bundle from "../sample/bundle.json" with { type: "json" };

if (!config.sampleMode) {
  console.error("sample.ts runs with SAMPLE_MODE=true only");
  process.exit(2);
}

// model: "none" stamps model_requested on every trace line of this pass, the query lines included.
const tracer = new Tracer(`sample_${Date.now().toString(36)}`, { model: "none" });
const engine = await SqlJsEngine.create();
const counts = engine.loadBundle(bundle);
tracer.emit({ agent: "collector", action: "observe", status: "ok", output_summary: `sample/bundle.json loaded into sql.js: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(", ")}`, detail: "model: none (recorded, redacted rows exported from the app Postgres; see sample/bundle.json _note)" });

const memory = new TechnicianMemory({ storage: "read" });
// The file tables Zetaris reads as LESSONS.lesson and RULES.rule, the same rows npm run zetaris:setup writes there.
const files = engine.loadFileTables({ lesson: lessonRows(memory), rule: ruleRows() });
tracer.emit({ agent: "collector", action: "observe", status: "ok", output_summary: `file tables loaded into sql.js: lesson ${files.lesson} (${config.memoryDir}), rule ${files.rule} (${config.policyFile})`, detail: "model: none" });
const layer = new DataLayer(engine);
// decidedAt: the bundle's own instant (the later of its latest run's finish and its latest ledger row), or the instant the
// latest lesson was taught when that is later, so every disposition and HOLD expiry is the same on every run with the same
// store; lessons are recalled at the memory's clock.
const decidedAt = new Date(decisionInstantWith(bundle, memory.lessons().map((l) => l.recordedAt)) ?? Date.now()).toISOString();
const pass = await runPass(layer, { tracer, world: new DriftWorld("sample"), memory, ledger: new MemoryLedger(engine), decidedAt });

for (const f of pass.findings) console.log(JSON.stringify(f));
// The ledger's rows, read back through the DataLayer, in the order of the findings they decide: each the row under
// the disposition_id the pass gives the finding (src/loop/pass.ts dispositionIdOf, keyed on decidedAt), which a recorded
// pass over the same runs at the same instant may have written first.
const ledger = new Map(objects(await layer.run(DISPOSITIONS_SQL, {}, { limit: 100_000 })).map((d) => [d.disposition_id, d]));
for (const f of pass.findings) {
  const d = ledger.get(dispositionIdOf(f, decidedAt));
  console.log(d
    ? `DISPOSITION ${d.finding_id} ${d.verb} by ${d.decided_by}${d.rule_id ? ` under ${d.rule_id}` : ""} expires ${d.expires_at || "-"}: ${d.reason}`
    : `DISPOSITION ${f.id} absent from the ledger`);
}
// The explain step over the pass (see the header): one CAUSE line per explained finding, in the pass's order per tenant.
const explained = await explainTenants({ decidedAt, findings: pass.findings }, { layer, vault: null, redactor: BUNDLE_REDACTOR, sink: new MemoryCauseSink(engine), tracer });
const causes = explained.flatMap((r) => r.causes);
for (const c of causes) console.log(`CAUSE ${c.finding_id} ${c.verb} ${c.finding_class} ${c.cause.class}: ${c.cause.summary}`);
const causeTally = CAUSE_CLASSES.map((k) => [k, causes.filter((c) => c.cause.class === k).length] as const).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
const causeErrors = explained.flatMap((r) => r.errors);
const explain = `; explain: ${causes.length} cause(s) (${causeTally}), finding_cause ${explained.reduce((n, r) => n + (r.written ?? 0), 0)} written${causeErrors.length ? `, ${causeErrors.length} error(s): ${causeErrors.join("; ")}` : ""}`;
const described = pass.findings.map((f) => {
  const fails = f.checks.filter((c) => !c.holds).map((c) => c.template);
  const exception = f.exception ? ` [exception ${f.exception.lesson} ${f.exception.status === "applied" ? `until ${f.exception.expires_at}` : `lapsed ${f.exception.expires_at}`}]` : "";
  return `${f.id} ${f.finding.class} ${f.finding.host ?? f.finding.surface} ${f.finding.object_id} ${f.finding.setting_path} -> ${f.verb} (${f.checks.length - fails.length}/${f.checks.length} preconditions hold${fails.length ? `, fails: ${fails.join(", ")}` : ""})${exception}`;
});
const mem = pass.memory ? `; memory: ${pass.memory.lessons} lesson(s), ${pass.memory.applied} exception(s) applied, ${pass.memory.lapsed} lapsed` : "";
const verbs = VERBS.filter((v) => pass.verbs[v] > 0).map((v) => `${v} ${pass.verbs[v]}`).join(", ") || "none";
const recorded = pass.ledger ? `; ledger: ${pass.ledger.dispositions} disposition(s), ${pass.ledger.fingerprints} referent fingerprint(s)` : "";
// exception_in_force over this pass's ADOPTs, the drift_usl.adoption SQL on sql.js: the ledger joined to the lessons.
const adoption = objects(await layer.run(ADOPTION_CHECK_SQL, { decided_at: decidedAt }, { tracer, agent: "sample" }))[0];
console.log(`ADOPTIONS: ${adoption.adoptions} ADOPT decided under an accepted exception, ${adoption.in_force} joined to a lesson in force at the decision instant (exception_in_force over the disposition and lesson tables)`);
console.log(`SAMPLE: ${pass.runs} collection runs, ${pass.gatedOut.length} failed the DQ gate (${pass.gatedOut.join(", ") || "none"}), ${pass.observed} observations in the World Model, ${pass.findings.length} finding(s): ${described.join("; ") || "none"}; judge skipped (model: none)${mem}; verbs: ${verbs}; policy rules ${pass.rules}, locked settings without an approved value ${pass.locked}${recorded}${explain}`);

// The owner's report for the tenant of the bundle's latest DNS run (client-1), from the page's rows over this engine.
const reportTenant = [...bundle.collection_run].filter((r) => r.surface === "cloudflare.dns").sort((a, b) => (a.started_at < b.started_at ? -1 : 1)).at(-1)?.tenant_id;
if (reportTenant) {
  const doc = await renderDocument(layer, { tenant: reportTenant, classes: new Map(pass.findings.map((f) => [f.id, f.finding.class])), source: "sql.js over sample/bundle.json", tracer, report: true });
  const html = sampleReport(doc, pass.findings, { path: "sample/bundle.json", sha256: textSha256(readFileSync(new URL("../sample/bundle.json", import.meta.url), "utf8")) });
  const labels = [...config.redactWords, ...config.exportDenyWords];
  const hits = Object.keys(countLabels(html, labels)).length;
  if (hits) {
    console.error(`REPORT: deny-list probe: ${hits} of ${labels.length} configured label(s) appear in the report; examples/report.html not written`);
    process.exitCode = 1;
  } else {
    writeFileSync(fileURLToPath(new URL("../examples/report.html", import.meta.url)), html);
    console.log(`REPORT: examples/report.html written for ${reportTenant}, ${Buffer.byteLength(html)} bytes, ${doc.open} finding(s) open, decided at ${doc.decidedAt ?? "none"}; deny-list probe 0 of ${labels.length} label(s)`);
  }
}
