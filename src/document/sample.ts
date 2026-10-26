// The owner's document and report in sample mode: the pass over a recorded bundle on sql.js, with the technician's
// lessons, decided at the bundle's instant or the latest lesson's (src/data/instant.ts decisionInstantWith) and
// recorded through a MemoryLedger into the same engine; then the explain step over that pass with no vault and
// BUNDLE_REDACTOR, as scripts/sample.ts runs it; then the page (src/document/render.ts) with the report's reads, and
// the report (src/document/report.ts). scripts/document.ts under SAMPLE_MODE, scripts/examples.ts and the report's
// test render through here, so examples/document.md and examples/report.html come from one sequence.
//
// The report in sample mode is a function of the bundle, the store and the replay page's committed data alone: no
// clock, no trace id, no tip, the fixed BUNDLE_REDACTOR, so a second render is byte-identical with or without a .env.
// docs/data (npm run site) gives the two links only the files can say: the replay page's anchor of each finding it
// carries, and the eval run its Nemotron tab shows, whose summary the report links. Measured 25 Oct 2026 over
// sample/bundle.json for client-1 with examples/memory: examples/report.html, a second render the same (test/report.test.ts).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.ts";
import { DataLayer } from "../data/layer.ts";
import { SqlJsEngine } from "../data/engines/sqljs.ts";
import { fileRows } from "../data/file-rows.ts";
import { decisionInstantWith } from "../data/instant.ts";
import type { TechnicianMemory } from "../engine/memory.ts";
import { DriftWorld } from "../engine/world.ts";
import { BUNDLE_REDACTOR, MemoryCauseSink, explainTenants, type ExplainResult } from "../explain/explain.ts";
import { MemoryLedger } from "../ledger.ts";
import { runPass, type Finding, type PassResult } from "../pipeline.ts";
import { loadPolicyFile } from "../policy/load.ts";
import { TENANT } from "../policy/schema.ts";
import type { Tracer } from "../trace.ts";
import { evalReceipts, readExecutive, renderExecutive, type Executive, type Period } from "./executive.ts";
import { renderDocument, type DocumentResult } from "./render.ts";
import { REPORT_MODE, renderReport, type ReportLinks } from "./report.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface SampleRender {
  doc: DocumentResult;
  pass: PassResult;
  decidedAt: string;
  explained: ExplainResult[];
}

/**
 * The shipped policy file's rules (DRIFT_POLICY_FILE, default policy/hackathon.json) into a sample engine before its
 * passes, for each tenant the recording holds runs of, as the eval runner loads them (src/eval/policy.ts
 * loadEvalPolicy), under BUNDLE_REDACTOR so every machine loads the same rows. A rule the recording holds already
 * stays as recorded; a rule the file added since the recording goes in (zetaris.control, the 16th rule of version 2,
 * from 26 Oct 2026). Returns the rows inserted. Every sample setup path calls it: renderSample, sampleExecutive, the
 * console's sampleBackend, npm run sample, the example slices and the replay page's cross-check pass.
 */
export function loadSamplePolicy(engine: SqlJsEngine, bundle: Record<string, unknown>, file: string = config.policyFile): number {
  const tenants = [...new Set(((bundle.collection_run ?? []) as { tenant_id?: unknown }[]).map((r) => r.tenant_id).filter((t): t is string => typeof t === "string" && t !== "*"))].sort();
  let inserted = 0;
  for (const tenant of tenants) inserted += engine.insertRows("policy_rule", loadPolicyFile(path.resolve(ROOT, file), { tenant, redactor: BUNDLE_REDACTOR }).rows);
  return inserted;
}

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The tenant a sample render defaults to: the tenant of the bundle's latest cloudflare.dns run. Only a run whose
 * tenant_id is a tenant id (src/policy/schema.ts TENANT, never "*") and whose started_at is an instant in the
 * millisecond form counts, so the order compares like with like whatever a --bundle holds; null when no run does.
 */
export function defaultTenant(runs: readonly { tenant_id?: unknown; surface?: unknown; started_at?: unknown }[]): string | null {
  const ok = runs.filter((r): r is { tenant_id: string; surface: string; started_at: string } =>
    typeof r.tenant_id === "string" && r.tenant_id !== "*" && TENANT.test(r.tenant_id) && r.surface === "cloudflare.dns"
    && typeof r.started_at === "string" && ISO_MS.test(r.started_at) && new Date(r.started_at).toISOString() === r.started_at);
  return [...ok].sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0)).at(-1)?.tenant_id ?? null;
}

/** The pass, the explain step and the page with the report's reads, over one bundle for one tenant. */
export async function renderSample(bundle: Record<string, unknown>, o: { tenant: string; memory: TechnicianMemory; source: string; tracer?: Tracer; world?: string }): Promise<SampleRender> {
  const engine = await SqlJsEngine.create();
  try {
    engine.loadBundle(bundle);
    loadSamplePolicy(engine, bundle);
    const layer = new DataLayer(engine);
    const decidedAt = new Date(decisionInstantWith(bundle, o.memory.lessons().map((l) => l.recordedAt)) ?? Date.now()).toISOString();
    const pass = await runPass(layer, { tracer: o.tracer, world: new DriftWorld(o.world ?? "document"), memory: o.memory, ledger: new MemoryLedger(engine), decidedAt });
    const explained = await explainTenants({ decidedAt, findings: pass.findings }, { layer, vault: null, redactor: BUNDLE_REDACTOR, sink: new MemoryCauseSink(engine), tracer: o.tracer });
    const doc = await renderDocument(layer, { tenant: o.tenant, classes: new Map(pass.findings.map((f) => [f.id, f.finding.class])), source: o.source, tracer: o.tracer, report: true });
    return { doc, pass, decidedAt, explained };
  } finally {
    engine.close();
  }
}

/** sha256 of a file's text as git stores it (LF). */
export const textSha256 = (text: string): string => `sha256:${createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex")}`;

/** The policy file as the footer names it: a path inside the repository as configured, else its last segment. */
export const policyFileShown = (file: string = config.policyFile): string => (/^(?:[A-Za-z]:)?[\\/]/.test(file) ? file.split(/[\\/]/).at(-1)! : file.replace(/\\/g, "/"));

/**
 * What the replay page's data says for the report's links, relative to examples/: each finding's anchor on the page
 * (the first example that carries it, in the page's order) and the summary of the eval run its Nemotron tab shows.
 * No anchors and no eval link when docs/data is missing or unreadable: the links then point at the page alone.
 */
export function replayLinks(root: string = ROOT): Pick<ReportLinks, "replayAnchors" | "eval"> {
  const replayAnchors: Record<string, string> = {};
  let evalSummary: string | null = null;
  try {
    const index = JSON.parse(readFileSync(path.join(root, "docs", "data", "index.json"), "utf8")) as { examples?: { file: string }[]; totals?: { nemotron?: { stamp?: string } } };
    for (const e of index.examples ?? []) {
      const ex = JSON.parse(readFileSync(path.join(root, "docs", e.file), "utf8")) as { findings?: { id: string; fields?: [string, unknown][] }[] };
      for (const f of ex.findings ?? []) {
        const id = f.fields?.find(([k]) => k === "finding id")?.[1];
        if (typeof id === "string" && !(id in replayAnchors)) replayAnchors[id] = f.id;
      }
    }
    const stamp = index.totals?.nemotron?.stamp;
    if (stamp && /^[\w.-]+$/.test(stamp) && existsSync(path.join(root, "eval", "results", stamp, "summary.md"))) evalSummary = `../eval/results/${stamp}/summary.md`;
  } catch {
    // no replay data: the report links the page without an anchor and names no eval summary
  }
  return { replayAnchors, eval: evalSummary };
}

/** The report in sample mode: the page's rows and the pass's findings of the tenant, BUNDLE_REDACTOR, no trace, no tip, the replay page's links. */
export function sampleReport(doc: DocumentResult, findings: readonly Finding[], bundle: { path: string; sha256: string }): string {
  return renderReport(doc.data, {
    redactor: BUNDLE_REDACTOR, mode: REPORT_MODE.dryRun, trace: null, tip: null, policyFile: policyFileShown(),
    findings: findings.filter((f) => f.finding.tenant_id === doc.data.tenant), bundle, links: replayLinks(),
  });
}

/**
 * The executive report in sample mode (src/document/executive.ts): the same pass, explain step and document reads as
 * renderSample, with the file tables loaded beside the bundle as sql.js holds them for Zetaris's LESSONS and RULES (so
 * the exception_in_force rule reads), over the period ending at the decision instant, BUNDLE_REDACTOR, the newest
 * eval results; no clock, trace or tip, so a second render is byte-identical. scripts/executive.ts in sample mode,
 * scripts/examples.ts and the test render through here, so examples/executive.html comes from one sequence.
 */
export async function sampleExecutive(bundle: Record<string, unknown>, o: { tenant: string; memory: TechnicianMemory; source: string; period: Period; file: { path: string; sha256: string }; tracer?: Tracer }): Promise<{ html: string; executive: Executive }> {
  const engine = await SqlJsEngine.create();
  try {
    engine.loadBundle(bundle);
    loadSamplePolicy(engine, bundle);
    engine.loadFileTables(fileRows({ memoryDir: o.memory.directory ?? undefined, policyFile: config.policyFile, redactor: BUNDLE_REDACTOR }));
    const layer = new DataLayer(engine);
    const decidedAt = new Date(decisionInstantWith(bundle, o.memory.lessons().map((l) => l.recordedAt)) ?? Date.now()).toISOString();
    const pass = await runPass(layer, { tracer: o.tracer, world: new DriftWorld("executive"), memory: o.memory, ledger: new MemoryLedger(engine), decidedAt });
    await explainTenants({ decidedAt, findings: pass.findings }, { layer, vault: null, redactor: BUNDLE_REDACTOR, sink: new MemoryCauseSink(engine), tracer: o.tracer });
    const classes = new Map(pass.findings.map((f) => [f.id, f.finding.class]));
    const doc = await renderDocument(layer, { tenant: o.tenant, classes, source: o.source, tracer: o.tracer, report: true });
    const executive = await readExecutive(layer, doc.data, { tenant: o.tenant, period: o.period, at: decidedAt, classes, receipts: evalReceipts(ROOT), tracer: o.tracer });
    return { executive, html: renderExecutive(executive, { redactor: BUNDLE_REDACTOR, policyFile: policyFileShown(), bundle: o.file }) };
  } finally {
    engine.close();
  }
}
