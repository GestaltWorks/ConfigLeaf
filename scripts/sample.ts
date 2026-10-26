// SAMPLE_MODE=true npm run sample [-- --verbose|--quiet|--json] [--help]
//
// SAMPLE_MODE entry point: the real pass (src/pipeline.ts) over sample/bundle.json through DataLayer(SqlJsEngine), with
// no model. The DQ gate, the hero query and every precondition run as SQL over the bundle's rows and the World Model
// confirms FOUND-BUT-DIFFERENT from what it recorded; nothing here maps an input to a stored answer.
//
// The screen is the cycle's table (src/loop/present.ts): the header "ConfigLeaf · sample · tenant <id> · <time> ·
// recorded estate, no credentials", then one row per stage. load: the bundle, its runs and rows, and the file tables
// (the lesson and rule rows sql.js holds beside the bundle as Zetaris holds LESSONS.lesson and RULES.rule). gate: the
// runs that pass the DQ gate. observe: the observations in the World Model. detect: the findings by class in plain
// words, and one line saying Microsoft 365 is not in the recorded bundle (npm run collect:m365 reads it live). decide: the verbs and the decision instant; under it the technician's memory, the findings decided under
// policy rules, the DQ rule exception_in_force over the pass's ADOPTs under an exception (the drift_usl.adoption SQL
// over the ledger and the lesson table, with the rule table from the policy file), the dispositions the ledger wrote
// and those read back from it under each finding's disposition_id, and one line per ROLLBACK, FIX and ESCALATE.
// explain: the causes by class, one line
// per cause. document and report: examples/document.md and examples/report.html, the owner's document and report
// (src/document/report.ts) for the tenant of the bundle's latest DNS run, rendered from the document's rows over the
// same engine after the explain step, each written once both pass the deny-list probe and only when its bytes differ
// from the file on disk (src/document/sample.ts sampleReport: no clock, trace or tip in it, so npm run document in
// sample mode writes the same bytes). judge: skipped, no model in sample mode. Then the "what happened" block the
// cycle prints (whatHappened), and a done line naming the trace.
//
// The trace goes to logs/sample_<base36 ms>.jsonl; its last event carries the SAMPLE summary line (every finding with
// its verb and preconditions, the memory, the verbs, the policy rules, the ledger and the explain step). --verbose
// prints the trace lines on stdout as they are written and, after the rows they belong to, one JSON object per
// finding, one DISPOSITION line per finding as the ledger holds it, the ADOPTIONS, DNS INVENTORY, CAUSE and REPORT
// lines (DNS INVENTORY: the DQ rule dns_inventory_current is not read, since it reads the DNS API live through Zetaris
// and the bundle holds no live source); --quiet prints the header and the done line; --json prints the SAMPLE summary
// line alone, for a script that reads it.
// Exit 0 when the pass ran and both files passed the probe; 1 when the probe refused or a step threw; 2 on a usage
// error or without SAMPLE_MODE=true.
//
// The explain step (src/explain/explain.ts) runs after the pass, as a cycle runs it between the pass and act: for
// each tenant of the pass's findings, from the bundle's own rows, with no vault and no model, one finding_cause row
// per explained finding into the same engine. Its evidence is the bundle's audit_event rows: the Cloudflare audit
// log's give an account_change or a token_change on the record a finding rests on; the bundle holds no journal rows,
// so a file finding's cause reads unknown with its window stated. Its redactor is BUNDLE_REDACTOR, a fixed salt over
// rows already redacted, so the causes are the same with or without a .env.
//
// The Decider consults the technician's memory (src/engine/memory.ts, the vendored H-MEM reference in the
// directory DRIFT_MEMORY_DIR names, examples/memory, the committed store, when it is blank), opened read only: a
// lesson recorded with `npm run answer` changes the verb of the finding it scopes on the next run of this script, until it expires,
// and the store is left as it was. The pass records its dispositions and referent
// fingerprints through a MemoryLedger into the same sql.js engine, and the dispositions are read back
// from it through the DataLayer. With no lesson recorded and no policy_rule rows in the bundle every
// disposition is the default's (decided_by default) and the verbs are ADOPT and ESCALATE. Every disposition
// is decided at the bundle's own instant (src/data/instant.ts: the later of its latest run's finish and its latest
// ledger row), or at the instant the latest lesson was taught when that is later (decisionInstantWith), so two runs
// over the same bundle and store print the same rows; the header's minute, the done line's time and the trace id
// change, and the trace lines carry their own timestamps and latencies.
//
// Measured 26 Oct 2026 over sample/bundle.json with examples/memory: 30 lines on stdout off a TTY, none of them a
// trace line, byte-identical over two runs outside the header's minute, the done line's time and the trace id, and
// the same with every .env value blanked but the deny-list count (0 of 0 labels); the trace's 754 lines in logs/ (806
// before the observe step read its runs as sets, 792 before each later ask of a shared read had its line, 26 Oct), the
// SAMPLE line its last, and the --json line byte-identical to the summary line the command printed on 25 Oct.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { config, redact } from "../src/config.ts";
import { renderDocument } from "../src/document/render.ts";
import { exportLabels, labelsIn } from "../src/document/export.ts";
import { loadSamplePolicy, policyFileShown, sampleReport, textSha256 } from "../src/document/sample.ts";
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
import { MAIL_NOT_RECORDED } from "../src/m365.ts";
import { M365_SURFACE } from "../src/collectors/m365.ts";
import { dispositionIdOf } from "../src/loop/pass.ts";
import {
  SAMPLE_HEADER_MODE, Table, causesView, count, decideView, detectView, fileView, gateView, judgeSkippedView, loadView, observeView, presentOptions, whatHappened,
  type StepView,
} from "../src/loop/present.ts";
import { FileTracer } from "../src/loop/trace.ts";
import { VERBS, runPass } from "../src/pipeline.ts";
import { Tracer } from "../src/trace.ts";
import { REST_DB } from "../src/zetaris/setup.ts";
import bundle from "../sample/bundle.json" with { type: "json" };
import { exitOnConfigError } from "../src/cli.ts";

exitOnConfigError();

const USAGE = "usage: SAMPLE_MODE=true npm run sample [-- --verbose|--quiet|--json] [--help]";

function usage(msg: string): never {
  console.error(`sample: ${msg}\n${USAGE}`);
  process.exit(2);
}

let args: { verbose?: boolean; quiet?: boolean; json?: boolean; help?: boolean };
try {
  args = parseArgs({ options: { verbose: { type: "boolean" }, quiet: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" } } }).values;
} catch (e) {
  usage((e as Error).message);
}
if (args.help) {
  console.log(USAGE);
  console.log("Runs the whole pass over sample/bundle.json with no credentials and no model: one row per stage, what happened, and a done line naming the trace in logs/. --verbose adds the trace lines and each finding's JSON and ledger line; --quiet prints the header and the done line; --json prints the SAMPLE summary line alone.");
  process.exit(0);
}
if ([args.verbose, args.quiet, args.json].filter(Boolean).length > 1) usage("--verbose, --quiet and --json exclude each other");
if (!config.sampleMode) usage("sample.ts runs with SAMPLE_MODE=true only");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = "sample/bundle.json";
const DOCUMENT = "examples/document.md";
const REPORT = "examples/report.html";
/** A file or directory as the screen names it: under the repository, relative to its root; else its last segment. */
const shown = (p: string): string => {
  const r = path.relative(ROOT, path.resolve(p));
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? r.replace(/\\/g, "/") : path.basename(p);
};
/** Write `text` to the repository file `rel` when the file on disk holds other bytes; true when it wrote. */
function writeChanged(rel: string, text: string): boolean {
  const file = path.join(ROOT, rel);
  if (existsSync(file) && readFileSync(file).equals(Buffer.from(text))) return false;
  writeFileSync(file, text);
  return true;
}

const t0 = Date.now();
// model: "none" stamps model_requested on every trace line of this pass, the query lines included. Off --verbose the
// trace goes to its file only.
const traceId = `sample_${t0.toString(36)}`;
const tracer = args.verbose ? new Tracer(traceId, { model: "none" }) : new FileTracer(traceId, { model: "none" });
const trace = path.join(config.logDir, `${traceId}.jsonl`).replace(/\\/g, "/");
const present = presentOptions(args);
const table = new Table(present, redact);
/** A line of the table: off under --json. */
const say = (l: string): void => {
  if (!args.json) console.log(l);
};
/** A stage's row and the lines under it: off under --quiet and --json. */
const row = (step: string, view: StepView): void => {
  if (!present.quiet) for (const l of table.row(step, view, null)) say(l);
};
/** An old full line: under --verbose only. */
const full = (l: string): void => {
  if (present.verbose) console.log(l);
};

// The owner's report is for the tenant of the bundle's latest DNS run (client-1); the header names it.
const reportTenant = [...bundle.collection_run].filter((r) => r.surface === "cloudflare.dns").sort((a, b) => (a.started_at < b.started_at ? -1 : 1)).at(-1)?.tenant_id;
const tenants = [...new Set(bundle.collection_run.map((r) => r.tenant_id))];
say(table.header({ command: "sample", tenant: reportTenant ?? tenants.join(", "), at: new Date(t0), mode: SAMPLE_HEADER_MODE }));

try {
  const engine = await SqlJsEngine.create();
  const counts = engine.loadBundle(bundle);
  // the shipped policy for the recording's tenants before any pass, as the eval runner loads it (src/document/sample.ts)
  loadSamplePolicy(engine, bundle as unknown as Record<string, unknown>);
  tracer.emit({ agent: "collector", action: "observe", status: "ok", output_summary: `${BUNDLE} loaded into sql.js: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(", ")}`, detail: "model: none (recorded, redacted rows exported from the app Postgres; see sample/bundle.json _note)" });
  const memory = new TechnicianMemory({ storage: "read" });
  // The file tables Zetaris reads as LESSONS.lesson and RULES.rule, the same rows npm run zetaris:setup writes there.
  const files = engine.loadFileTables({ lesson: lessonRows(memory), rule: ruleRows() });
  tracer.emit({ agent: "collector", action: "observe", status: "ok", output_summary: `file tables loaded into sql.js: lesson ${files.lesson} (${config.memoryDir}), rule ${files.rule} (${config.policyFile})`, detail: "model: none" });
  row("load", loadView({ file: BUNDLE, counts, tenants: tenants.length, lessons: { rows: files.lesson ?? 0, from: shown(config.memoryDir) }, rules: { rows: files.rule ?? 0, from: policyFileShown() } }));

  const layer = new DataLayer(engine);
  // decidedAt: the bundle's own instant (the later of its latest run's finish and its latest ledger row), or the instant the
  // latest lesson was taught when that is later, so every disposition and HOLD expiry is the same on every run with the same
  // store; lessons are recalled at the memory's clock.
  const decidedAt = new Date(decisionInstantWith(bundle, memory.lessons().map((l) => l.recordedAt)) ?? Date.now()).toISOString();
  const pass = await runPass(layer, { tracer, world: new DriftWorld("sample"), memory, ledger: new MemoryLedger(engine), decidedAt });
  row("gate", gateView(pass));
  row("observe", observeView(pass.observed));
  // The recorded bundle holds no Microsoft 365 run; the detect row says so in one line rather than leave it unsaid.
  row("detect", detectView(pass.findings, bundle.collection_run.some((r) => r.surface === M365_SURFACE) ? [] : [MAIL_NOT_RECORDED]));

  // The ledger's rows, read back through the DataLayer, in the order of the findings they decide: each the row under
  // the disposition_id the pass gives the finding (src/loop/pass.ts dispositionIdOf, keyed on decidedAt), which a recorded
  // pass over the same runs at the same instant may have written first.
  const ledger = new Map(objects(await layer.run(DISPOSITIONS_SQL, {}, { limit: 100_000 })).map((d) => [d.disposition_id, d]));
  const dispositionLines = pass.findings.map((f) => {
    const d = ledger.get(dispositionIdOf(f, decidedAt));
    return d
      ? `DISPOSITION ${d.finding_id} ${d.verb} by ${d.decided_by}${d.rule_id ? ` under ${d.rule_id}` : ""} expires ${d.expires_at || "-"}: ${d.reason}`
      : `DISPOSITION ${f.id} absent from the ledger`;
  });
  const readBack = pass.findings.filter((f) => ledger.has(dispositionIdOf(f, decidedAt))).length;
  // exception_in_force over this pass's ADOPTs, the drift_usl.adoption SQL on sql.js: the ledger joined to the lessons.
  const adoption = objects(await layer.run(ADOPTION_CHECK_SQL, { decided_at: decidedAt }, { tracer, agent: "sample" }))[0];
  row("decide", decideView({
    findings: pass.findings, decidedAt, memory: pass.memory,
    adoptions: adoption ? { adoptions: Number(adoption.adoptions), inForce: Number(adoption.in_force) } : null,
    ledger: pass.ledger ? { dispositions: pass.ledger.dispositions, readBack } : null,
  }));
  for (const f of pass.findings) full(JSON.stringify(f));
  for (const l of dispositionLines) full(l);
  if (adoption) full(`ADOPTIONS: ${adoption.adoptions} ADOPT decided under an accepted exception, ${adoption.in_force} joined to a lesson in force at the decision instant (exception_in_force over the disposition and lesson tables)`);
  // dns_inventory_current reads the DNS API now, through Zetaris's REST datasource; the bundle is a recording, with no live source.
  full(`DNS INVENTORY: DQ dns_inventory_current not read in sample mode: drift_usl.dns_live reads the Cloudflare DNS API live through the Zetaris REST datasource ${REST_DB}, and sample/bundle.json holds no live source`);

  // The explain step over the pass (see the header): one cause per explained finding, in the pass's order per tenant.
  const explained = await explainTenants({ decidedAt, findings: pass.findings }, { layer, vault: null, redactor: BUNDLE_REDACTOR, sink: new MemoryCauseSink(engine), tracer });
  const causes = explained.flatMap((r) => r.causes);
  const causeErrors = explained.flatMap((r) => r.errors);
  row("explain", causesView(causes, pass.findings, causeErrors));
  for (const c of causes) full(`CAUSE ${c.finding_id} ${c.verb} ${c.finding_class} ${c.cause.class}: ${c.cause.summary}`);

  // The SAMPLE summary line: the trace's last event, and stdout under --json.
  const causeTally = CAUSE_CLASSES.map((k) => [k, causes.filter((c) => c.cause.class === k).length] as const).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
  const explain = `; explain: ${causes.length} cause(s) (${causeTally}), finding_cause ${explained.reduce((n, r) => n + (r.written ?? 0), 0)} written${causeErrors.length ? `, ${causeErrors.length} error(s): ${causeErrors.join("; ")}` : ""}`;
  const described = pass.findings.map((f) => {
    const fails = f.checks.filter((c) => !c.holds).map((c) => c.template);
    const exception = f.exception ? ` [exception ${f.exception.lesson} ${f.exception.status === "applied" ? `until ${f.exception.expires_at}` : `lapsed ${f.exception.expires_at}`}]` : "";
    return `${f.id} ${f.finding.class} ${f.finding.host ?? f.finding.surface} ${f.finding.object_id} ${f.finding.setting_path} -> ${f.verb} (${f.checks.length - fails.length}/${f.checks.length} preconditions hold${fails.length ? `, fails: ${fails.join(", ")}` : ""})${exception}`;
  });
  const mem = pass.memory ? `; memory: ${pass.memory.lessons} lesson(s), ${pass.memory.applied} exception(s) applied, ${pass.memory.lapsed} lapsed` : "";
  const verbs = VERBS.filter((v) => pass.verbs[v] > 0).map((v) => `${v} ${pass.verbs[v]}`).join(", ") || "none";
  const recorded = pass.ledger ? `; ledger: ${pass.ledger.dispositions} disposition(s), ${pass.ledger.fingerprints} referent fingerprint(s)` : "";
  const summary = `SAMPLE: ${pass.runs} collection runs, ${pass.gatedOut.length} failed the DQ gate (${pass.gatedOut.join(", ") || "none"}), ${pass.observed} observations in the World Model, ${pass.findings.length} finding(s): ${described.join("; ") || "none"}; judge skipped (model: none)${mem}; verbs: ${verbs}; policy rules ${pass.rules}, locked settings without an approved value ${pass.locked}${recorded}${explain}`;

  // The owner's document and report for the tenant of the bundle's latest DNS run, from the document's rows over this engine.
  let stopped: { step: string; at: number; of: number } | undefined;
  if (reportTenant) {
    const doc = await renderDocument(layer, { tenant: reportTenant, classes: new Map(pass.findings.map((f) => [f.id, f.finding.class])), source: `sql.js over ${BUNDLE}`, tracer, report: true });
    const html = sampleReport(doc, pass.findings, { path: BUNDLE, sha256: textSha256(readFileSync(path.join(ROOT, BUNDLE), "utf8")) });
    const labels = exportLabels();
    const hits = { document: labelsIn(doc.markdown, labels), report: labelsIn(html, labels) };
    const refused = (["document", "report"] as const).find((k) => hits[k] > 0);
    if (refused) {
      const why = `deny-list probe: ${hits[refused]} of ${count(labels.length, "configured label")} appear in the ${refused === "document" ? "page" : "report"}; ${DOCUMENT} and ${REPORT} not written`;
      if (present.quiet || args.json) console.error(`sample: ${why}`);
      else say(table.failed(refused, why, null));
      stopped = { step: refused, at: refused === "document" ? 7 : 8, of: 9 };
      process.exitCode = 1;
    } else {
      const docWritten = writeChanged(DOCUMENT, doc.markdown);
      const htmlWritten = writeChanged(REPORT, html);
      row("document", fileView({ file: DOCUMENT, bytes: Buffer.byteLength(doc.markdown), facts: [count(doc.markdown.split("\n").length - 1, "line")], written: docWritten }));
      row("report", fileView({
        file: REPORT, bytes: Buffer.byteLength(html), facts: [count(doc.open, "finding") + " open"], written: htmlWritten,
        sub: [{ parts: [`both files pass the deny-list probe: 0 of ${count(labels.length, "configured label")}`] }],
      }));
      full(`REPORT: ${REPORT} ${htmlWritten ? "written" : "unchanged"} for ${reportTenant}, ${Buffer.byteLength(html)} bytes, ${doc.open} finding(s) open, decided at ${doc.decidedAt ?? "none"}; deny-list probe 0 of ${labels.length} label(s)`);
    }
  }
  tracer.emit({ agent: "sample", action: "triage", status: stopped ? "failed" : "ok", input_summary: `sample over ${BUNDLE}`, output_summary: summary, latency_ms: Date.now() - t0 });
  if (!stopped) row("judge", judgeSkippedView());

  // What happened, as the cycle prints it: act does not run in sample mode, so nothing on an estate moves.
  if (!present.quiet) {
    const story = whatHappened({ pass: { findings: pass.findings, decidedAt }, act: null, actSettled: true, tickets: null, causes: causes.map((c) => c.cause) });
    for (const l of table.story(story)) say(l);
  }
  say(table.done({ ms: Date.now() - t0, trace, stopped }));
  if (args.json) console.log(summary);
  engine.close();
} catch (e) {
  const msg = redact((e as Error)?.message ?? String(e));
  console.error(`sample: ${msg}`);
  say(table.done({ ms: Date.now() - t0, trace, stopped: { step: "sample", at: 1, of: 1 } }));
  process.exitCode = 1;
}
