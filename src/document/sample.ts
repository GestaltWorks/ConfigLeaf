// The owner's document and report in sample mode: the pass over a recorded bundle on sql.js, with the technician's
// lessons, decided at the bundle's instant or the latest lesson's (src/data/instant.ts decisionInstantWith) and
// recorded through a MemoryLedger into the same engine; then the explain step over that pass with no vault and
// BUNDLE_REDACTOR, as scripts/sample.ts runs it; then the page (src/document/render.ts) with the report's reads, and
// the report (src/document/report.ts). scripts/document.ts under SAMPLE_MODE, scripts/examples.ts and the report's
// test render through here, so examples/document.md and examples/report.html come from one sequence.
//
// The report in sample mode is a function of the bundle and the store alone: no clock, no trace id, no tip, the
// fixed BUNDLE_REDACTOR, so a second render is byte-identical with or without a .env. Measured 25 Oct 2026 over
// sample/bundle.json for client-1 with examples/memory: examples/report.html, 24,941 bytes, a second render the same (test/report.test.ts).

import { createHash } from "node:crypto";
import { config } from "../config.ts";
import { DataLayer } from "../data/layer.ts";
import { SqlJsEngine } from "../data/engines/sqljs.ts";
import { decisionInstantWith } from "../data/instant.ts";
import type { TechnicianMemory } from "../engine/memory.ts";
import { DriftWorld } from "../engine/world.ts";
import { BUNDLE_REDACTOR, MemoryCauseSink, explainTenants, type ExplainResult } from "../explain/explain.ts";
import { MemoryLedger } from "../ledger.ts";
import { runPass, type Finding, type PassResult } from "../pipeline.ts";
import type { Tracer } from "../trace.ts";
import { renderDocument, type DocumentResult } from "./render.ts";
import { REPORT_MODE, renderReport } from "./report.ts";

export interface SampleRender {
  doc: DocumentResult;
  pass: PassResult;
  decidedAt: string;
  explained: ExplainResult[];
}

/** The pass, the explain step and the page with the report's reads, over one bundle for one tenant. */
export async function renderSample(bundle: Record<string, unknown>, o: { tenant: string; memory: TechnicianMemory; source: string; tracer?: Tracer; world?: string }): Promise<SampleRender> {
  const engine = await SqlJsEngine.create();
  try {
    engine.loadBundle(bundle);
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

/** The report in sample mode: the page's rows and the pass's findings of the tenant, BUNDLE_REDACTOR, no trace, no tip. */
export function sampleReport(doc: DocumentResult, findings: readonly Finding[], bundle: { path: string; sha256: string }): string {
  return renderReport(doc.data, {
    redactor: BUNDLE_REDACTOR, mode: REPORT_MODE.dryRun, trace: null, tip: null, policyFile: policyFileShown(),
    findings: findings.filter((f) => f.finding.tenant_id === doc.data.tenant), bundle,
  });
}
