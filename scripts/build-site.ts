// npm run site [-- --out docs] [-- --examples examples] [-- --allow-stale] [-- --results eval/results/<UTC stamp>]
//
// The no-install replay page for judges: docs/index.html and docs/data/*.json, which GitHub Pages serves
// from /docs on main. Built only from what the repo holds, never authored: each examples/<case>/bundle.json
// (a slice of the recorded, redacted bundle) and the findings.json the pass computed over it.
//
// A finding records, per check, the template id, the verdict, the row count and the sentence, not the SQL.
// So the build binds each check's parameters from its finding with the function the pass itself used
// (catalogue/select.ts bindParams; a check that recorded its own params, as a live selection would, keeps
// them), renders the template through DataLayer.render on a SqlJsEngine loaded with that slice, and runs it
// again. The re-run must return the recorded row count and verdict, and the template must explain itself in
// the recorded sentence, which it does only with the parameters that ran (the sentence names the window, the
// resource, the run). So the SQL on the page is the SQL that ran, and a page that would show anything else is
// refused, not published. The detector query that raised each finding (data/queries.ts) is rendered and run
// the same way and must return the finding's own row. A live judge record, when one exists, has its falsifier
// re-guarded and re-run, and its receipt id and signature status shown.
//
// Each detector query and each check also carries zetarisSql: its template and parameters rendered through a
// DataLayer over ZetarisEngine, whose qualify() names each table <ZETARIS_DATASOURCE>.<table> (DRIFT): the SQL text a
// live pass sends to Zetaris Lightning SQL. Rendering reads qualify() alone, so the build makes no network call; the
// page shows the text collapsed under the query, and the lede, the Sources tab and the footer name the datasource,
// the semantic layer and its DQ rules (src/zetaris/setup.ts) and the parity test that holds the two engines equal.
//
// Two more tabs carry markdown turned into HTML at build time (markdownToHtml, below: headings, paragraphs, bullet
// lists, tables, inline code and bold, every other character escaped): Document, the owner's document as
// `npm run document` in sample mode writes it (examples/document.md, from SQL over the recorded bundle), with its file
// hash and the decision instant its last line states; and Sources, "Where each answer comes from" as
// src/document/render.ts sourcesMarkdown() reads it off the SQL, then the semantic layer's table as
// src/zetaris/setup.ts uslMarkdown() reads it off the USL DDL, the activation SELECTs and DQ_RULES. Both are static
// HTML in index.html, so they read from file:// and with the script off.
//
// The header carries a link, Report, to the owner's report (examples/report.html, src/document/report.ts) as
// ../examples/report.html with one line saying what the file is: a fixed relative link, so the build stays the same
// whatever the report holds; it opens when the page is read from a clone of the repository.
//
// A fourth static tab, Nemotron, is built from one eval results directory (BuildOptions.resultsDir, `--results`; by
// default the lexically newest directory under eval/results that holds planted.json and C*-run*.json): the run files'
// call records grouped by configuration and role (tier and model requested, model served, signatures verified, cache
// hits, substitutions), each run's counts (Lightning's checks selected, valid and run unmodified; labelled no, read
// yes), every planted claim with its text from eval/planted.json, and every item judge with the templates Lightning
// chose. The build loads the recording the run files name into a fresh SqlJsEngine with the rows of the policy file
// they name (loadPolicyFile under a fixed salt, so every machine builds the same page), then re-guards
// (guardRefutation) and re-runs, LIMIT MAX_LIMIT, every judge SELECT recorded with a row count whose status is not
// invalid_output or not_judged. A re-run that returns the recorded count is equal; a recorded text the guard or the
// engine refuses is shown as recorded and counted apart, since the results hold each SELECT as the eval's redactor
// left it after the run. The tab shows row counts; index.json's totals carry the eval's stamp, set, calls,
// verified signatures, substitutions and the re-run tally, and the header shows the calls and the re-run tally.
//
// The header is static HTML. Its counts take each finding once, by the pass's finding id: a slice cut around one finding
// can carry another (the 16 April proxy_split sits in two slices), so a finding in two slices is one finding and two rows.
// Verbs, classes and judge models count the same way, the header names the rows the Findings tab lists over the slices
// beside the findings, and each slice keeps its own counts. Above the counts a tile sets Ultra alone (the configuration
// whose run files record direct: ultra, C4) beside the checks with Ultra as the falsifier (judge: ultra over a model's
// selection, C3), per run, from the results directory the Nemotron tab is built from: the items labelled no each reads as
// yes (counts.false_positives of counts.labelled_no), and the planted claims C3 struck in planted.json, under a caption
// naming the directory and the runs' span from their started_at and finished_at.
//
// Refuses to publish (throws, writes nothing) when a check cites a template the catalogue cannot render, or
// parameters it refuses; when a re-run differs from the record (a check's, a live judge's, or an eval judge SELECT
// that runs and returns another count, named by file, configuration, run and claim or item); when a results file
// does not parse, or its runs name different recordings; when a detector does not return its finding;
// when re-running the pass over a slice does not give its committed findings.json (the example is stale: run
// npm run examples; `--allow-stale` publishes it marked stale instead, for a deliberate look at the drift);
// when any output file holds a label of the operator's deny-list (REDACT_WORDS and EXPORT_DENY_WORDS: the
// leak test's list and its countLabels scan) or a configured ssh alias, the markdown the two tabs render and the
// strings the Nemotron tab is built from scanned as written too; when examples/document.md is missing or opens with
// no heading; when any string in the data files or the Nemotron tab
// changes under the redactor (a name, address, mail address or secret redaction would still replace, which
// holds with the deny-list blank too); or when the page and its data exceed MAX_BYTES. Every refusal names
// the file and the position in the list, never the label.
//
// The pass over each slice and the full sample pass read the technician's lessons from the store DRIFT_MEMORY_DIR
// names (BuildOptions.memoryDir; read only; examples/memory, the committed store, when it is blank) and decide at
// the bundle's instant or the latest lesson's, as npm run examples and npm run sample do, so an exception in force
// decides here as it decided there.
//
// Deterministic: no clock in the output, no machine path, so the committed docs/ is exactly the build of the
// committed examples and the committed eval results (test/site.test.ts asserts it). File hashes are over LF text,
// as git stores it.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { MAX_LIMIT, guardRefutation } from "../src/agents/judge.ts";
import { bindParams, type FindingSummary } from "../src/catalogue/select.ts";
import { renderTemplate, templateById } from "../src/catalogue/templates.ts";
import { config, memoryDir } from "../src/config.ts";
import { DataLayer, type Param, type Params } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { ZetarisEngine } from "../src/data/engines/zetaris.ts";
import { decisionInstantWith } from "../src/data/instant.ts";
import {
  HERO_SQL, ORPHAN_RECORD_SQL, ORPHAN_VHOST_SQL, PROXIED_WITHOUT_REAL_IP_SQL, PROXY_SPLIT_SQL, RUNS_SQL, WILDCARD_WITHOUT_REAL_IP_SQL, objects,
} from "../src/data/queries.ts";
import { sourceRows, sourcesMarkdown } from "../src/document/render.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { isSubstitution } from "../src/eval/models.ts";
import { runPass, type Finding } from "../src/pipeline.ts";
import { loadPolicyFile } from "../src/policy/load.ts";
import { Redactor, countLabels, describeRedactions } from "../src/redactor.ts";
import { DQ_RULES, USL_NAME, USL_TABLES, uslMarkdown } from "../src/zetaris/setup.ts";
import { FILE_DATASOURCES } from "../src/data/files.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The datasource a live pass reads through Zetaris (ZETARIS_DATASOURCE, DRIFT by default and in .env.example). */
const DATASOURCE = config.zetaris.datasource;
/** The data layer with Zetaris's table names: the SQL text a live pass sends for a template and its parameters. render() reads qualify() alone. */
const AS_ZETARIS = new DataLayer(new ZetarisEngine());
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen"];
const word = (n: number): string => NUMBER_WORDS[n] ?? String(n);

/**
 * The page and every data file together. 300,000 from 24 Oct 2026; 350,000 from 25 Oct 2026, when the Nemotron tab over
 * eval/results/2026-10-25T23-34-17Z, whose Ultra judge SELECTs run longer, took the build to 314,907 bytes.
 */
export const MAX_BYTES = 350_000;
/** The header's Report link: the owner's report (npm run examples writes it), relative to docs/ in a clone of the repository. */
export const REPORT_LINK = "../examples/report.html";
/** Rows shown per query; the count and the rows hash cover every row. */
export const MAX_ROWS = 20;
/** Characters shown per cell; a longer value is cut and marked. */
export const MAX_CELL = 240;
/** The engine keeps 1000 rows unless told otherwise; the page hashes and counts every row. */
const EVERY_ROW = 1_000_000;
/** Reading order: the real 16 April record first. Any other example follows, alphabetically. */
const ORDER = ["proxy-split", "wildcard-no-real-ip", "orphans"];
const DIR_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class SiteError extends Error {}

// ---- the records, as the pass writes them (lenient: fields another step adds later pass through) --------

const ParamValue = z.union([z.string(), z.number(), z.null()]);
const CheckRecord = z.looseObject({
  template: z.string(),
  holds: z.boolean().optional(),
  rowCount: z.number().int().nonnegative().optional(),
  explanation: z.string().optional(),
  params: z.record(z.string(), ParamValue).optional(),
});
const opt = () => z.string().nullable().optional();
const FindingRecord = z.looseObject({
  /** The pass's short stable id (fnd- plus 16 hex), what `npm run answer` takes; older records have none. */
  id: z.string().optional(),
  finding: z.looseObject({
    class: z.string(), tenant_id: z.string(), run_id: z.string(), surface: z.string(), host: z.string().nullable(),
    object_id: z.string(), setting_path: z.string(), value_hash: z.string(), value_redacted: opt(),
    refers_to_type: opt(), refers_to_id: opt(), dns_name: opt(), resolves_to: opt(), resource_id: opt(), dns_run_id: opt(),
    since: z.string(), until: z.string(), summary: z.string(),
  }),
  verb: z.string(),
  /** The Decider's disposition (src/pipeline.ts DispositionNote); older records have none. */
  disposition: z.looseObject({ verb: z.string(), reason: z.string(), expires_at: z.string().nullable(), decided_by: z.string(), rule_id: z.string().nullable() }).optional(),
  world: z.looseObject({ before: z.string().nullable(), after: z.string().nullable(), changed: z.boolean(), bytes_unchanged: z.boolean() }).optional(),
  // The exposure line ({since, days, source, still_open_in}); shown as recorded, whatever fields it grows.
  exposure: z.record(z.string(), z.unknown()).nullable().optional(),
  checks: z.array(CheckRecord),
  rejected: z.array(z.looseObject({ check: z.unknown(), reason: z.string() })).default([]),
  judge: z.union([
    z.string(),
    z.looseObject({
      status: z.string(), reason: z.string().optional(), sql: opt(), rowCount: z.number().nullable().optional(), rationale: opt(),
      receiptId: opt(), servedModel: opt(), signatureOk: z.boolean().nullable().optional(), latencyMs: z.number().optional(),
    }),
  ]),
});
type FindingRec = z.infer<typeof FindingRecord>;
type CheckRec = z.infer<typeof CheckRecord>;
type JudgeRec = FindingRec["judge"];

// ---- what the page reads ----------------------------------------------------------------------------------

export interface RowsView { columns: string[]; rows: string[][]; total: number; shown: number; cutCells: number; sha256: string }
export interface DetectionView {
  query: string; description: string; sql: string; sqlSha256: string;
  /** The same query as the live pass sends it to Zetaris: each table <datasource>.<table>. */
  zetarisSql: string;
  params: Record<string, Param>; total: number; matched: RowsView;
}
export interface CheckView {
  template: string; purpose: string; rowsMean: "holds" | "fails"; status: "ran" | "not_run";
  holds: boolean | null; rowCount: number | null; explanation: string | null;
  /** What running the rendered SQL again over the slice returned; equal to the record or the build refuses. */
  rerun: { rowCount: number; holds: boolean } | null;
  bound: "recorded with the check" | "bound from the finding";
  /** Fields the record carries beyond these (a skip reason, say), shown as recorded. */
  extra: Record<string, unknown>;
  params: Record<string, Param>; sql: string; sqlSha256: string;
  /** The same check as the live pass sends it to Zetaris: each table <datasource>.<table>. */
  zetarisSql: string;
  rows: RowsView | null;
}
export interface JudgeView {
  status: string; model: string; detail: string;
  sql: string | null; sqlSha256: string | null; rowCount: number | null; rerunRowCount: number | null;
  receiptId: string | null; signature: string | null; servedModel: string | null; rationale: string | null;
  /** Fields a live record carries beyond these (custody, latency), shown as recorded. */
  extra: Record<string, unknown>;
}
export interface FindingView {
  id: string; class: string; verb: string; claim: string; decision: string;
  fields: [string, string | null][];
  world: FindingRec["world"] | null; exposure: Record<string, unknown> | null;
  detection: DetectionView | null; checks: CheckView[]; rejected: { template: string | null; reason: string }[];
  judge: JudgeView;
  /** The same finding in the full sample pass (sample/bundle.json): same verb and check verdicts, or what differs. */
  sample: { match: "same" | "differs" | "absent"; detail: string } | null;
}
export interface ExampleView {
  dir: string; note: string; tables: Record<string, number>;
  files: { path: string; bytes: number; sha256: string }[];
  /** Re-running the pass over the slice at build time gives findings.json byte for byte. */
  reproduced: boolean;
  verbs: Record<string, number>; classes: Record<string, number>;
  findings: FindingView[];
}
export interface SampleSummary { bundle: string; sha256: string; runs: number; gatedOut: number; observed: number; findings: number; classes: Record<string, number>; verbs: Record<string, number> }
export interface SiteIndex {
  title: string;
  examples: { dir: string; file: string; findings: number; checks: number; reproduced: boolean }[];
  totals: {
    examples: number;
    /** Each finding once, by the pass's finding id; `rows` counts it once per slice that carries it, as the Findings tab lists it. Verbs, classes and judge models count by finding id too. */
    findings: number; rows: number;
    checks: number; checksRerun: number; verbs: Record<string, number>; classes: Record<string, number>; judgeModels: Record<string, number>;
    /** The eval results the Nemotron tab is built from. */
    nemotron: NemotronTotals;
  };
  sample: SampleSummary | null;
  decisionRule: string;
  limits: { maxRows: number; maxCell: number };
}

export interface BuildOptions {
  examplesDir?: string;
  outDir?: string;
  /** The full recorded bundle the sample pass reads; null skips the cross-check. */
  samplePath?: string | null;
  /** false computes and scans everything but writes nothing. */
  write?: boolean;
  /** false (default) refuses an example whose findings.json the pass over its slice does not reproduce; true publishes it, marked stale on the page. */
  allowStale?: boolean;
  /** The owner's document the Document tab shows; default examples/document.md. */
  documentPath?: string;
  /** The technician's lessons every pass of the build reads (opened read only); default DRIFT_MEMORY_DIR, the committed examples/memory when that is blank (a sample build). */
  memoryDir?: string;
  /** The eval results directory the Nemotron tab is built from; default the lexically newest under eval/results holding planted.json and C*-run*.json. */
  resultsDir?: string;
}
export interface DocumentTab { file: string; bytes: number; sha256: string; decidedAt: string | null }
export interface BuildResult { outDir: string; files: Map<string, string>; bytes: number; index: SiteIndex; scan: ScanReport; document: DocumentTab; sources: number; nemotron: NemotronView }

// ---- helpers ------------------------------------------------------------------------------------------------

const lf = (s: string): string => s.replace(/\r\n/g, "\n");
const sha = (s: string): string => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;
const tally = (xs: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
};
const rel = (p: string): string => path.relative(ROOT, p).split(path.sep).join("/");
/** A path as the page names it: relative to the repository, or the bare file name for a file outside it (no machine path). */
const shownPath = (p: string): string => (rel(p).startsWith("..") || path.isAbsolute(rel(p)) ? path.basename(p) : rel(p));

function rowsView(columns: string[], rows: string[][], total: number): RowsView {
  let cut = 0;
  const shown = rows.slice(0, MAX_ROWS).map((r) => r.map((v) => {
    if (v.length <= MAX_CELL) return v;
    cut++;
    return `${v.slice(0, MAX_CELL)}…`;
  }));
  return { columns, rows: shown, total, shown: shown.length, cutCells: cut, sha256: sha(JSON.stringify({ columns, rows })) };
}

// ---- detectors: the survey or hero query that raised a finding, and how its row is recognised ---------------

interface Detector { query: string; description: string; sql: string; params: Params; match: (row: Record<string, string>) => boolean }

function detectorFor(f: FindingRec["finding"], runs: Record<string, string>[], where: string): Detector | null {
  const base = { tenant_id: f.tenant_id, dns_run_id: f.dns_run_id ?? null };
  switch (f.class) {
    case "found_but_different":
    case "dns_change":
      return {
        query: "hero", sql: HERO_SQL, params: { ...base, run_id: f.run_id },
        description: "The cross-source hero query: a setting that refers to a DNS name whose A or AAAA record in the pass's DNS run resolves to an address the inventory does not know.",
        match: (r) => r.object_id === f.object_id && r.setting_path === f.setting_path && r.upstream_name === f.dns_name && r.resolves_to === f.resolves_to,
      };
    case "proxy_split":
      return {
        query: "proxy_split", sql: PROXY_SPLIT_SQL, params: base,
        description: "A proxied CNAME whose target in the same DNS run is a direct A or AAAA record: the address the proxy hides on one name is published on the other.",
        match: (r) => r.proxied_record_id === f.object_id && r.target_content === f.resolves_to,
      };
    case "proxied_without_real_ip": {
      const wildcard = f.setting_path === "http.real_ip";
      return {
        query: wildcard ? "wildcard_without_real_ip" : "proxied_without_real_ip", sql: wildcard ? WILDCARD_WITHOUT_REAL_IP_SQL : PROXIED_WITHOUT_REAL_IP_SQL,
        params: { ...base, run_id: f.run_id },
        description: wildcard
          ? "A proxied wildcard record landing on an inventory host where neither the http level nor any enabled server block trusts a real_ip range."
          : "A proxied record whose origin is an inventory host, served there by an enabled server block that names it and trusts no real_ip range.",
        match: (r) => r.record_id === f.resource_id && r.object_id === f.object_id && r.setting_path === f.setting_path,
      };
    }
    case "orphan_record": {
      // The finding is anchored on the DNS record (run_id is the DNS run); the host's nginx run is the pass's latest for that host.
      const nginx = runs.filter((r) => r.tenant_id === f.tenant_id && r.surface === "linux.nginx" && r.host === f.host).at(-1);
      if (!nginx) throw new SiteError(`${where}: orphan_record on ${f.host}, but the slice holds no linux.nginx run for that host`);
      return {
        query: "orphan_record", sql: ORPHAN_RECORD_SQL, params: { ...base, run_id: nginx.run_id },
        description: "A record that lands on the host of the nginx run while no enabled server block there names it: requests for it reach the default server.",
        match: (r) => r.record_id === f.object_id,
      };
    }
    case "orphan_vhost":
      return {
        query: "orphan_vhost", sql: ORPHAN_VHOST_SQL, params: { ...base, run_id: f.run_id },
        description: "A server_name with no record of that name in the DNS run and no wildcard record covering its zone.",
        match: (r) => r.object_id === f.object_id && r.setting_path === f.setting_path,
      };
    default:
      return null;
  }
}

async function detectionView(layer: DataLayer, f: FindingRec["finding"], runs: Record<string, string>[], where: string): Promise<DetectionView | null> {
  const d = detectorFor(f, runs, where);
  if (!d) return null;
  const res = await layer.run(d.sql, d.params, { limit: EVERY_ROW });
  const rows = objects(res);
  const hit = res.rows.filter((_, i) => d.match(rows[i]));
  if (!hit.length) throw new SiteError(`${where}: the ${d.query} query over the slice returns ${res.total} row(s), none of them this finding's; the page would show a claim its detector does not make`);
  const sql = layer.render(d.sql, d.params);
  return {
    query: d.query, description: d.description, sql, sqlSha256: sha(sql), zetarisSql: AS_ZETARIS.render(d.sql, d.params),
    params: { ...d.params }, total: res.total, matched: rowsView(res.columns, hit, hit.length),
  };
}

// ---- checks -------------------------------------------------------------------------------------------------

const CHECK_KEYS = new Set(["template", "holds", "rowCount", "explanation", "params"]);
const JUDGE_KEYS = new Set(["status", "reason", "sql", "rowCount", "rationale", "receiptId", "servedModel", "signatureOk"]);
/** What a record carries beyond the fields the page lays out, so a field another step adds is shown, not dropped. */
const extraOf = (o: Record<string, unknown>, known: Set<string>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([k, v]) => !known.has(k) && v !== undefined));

async function checkView(layer: DataLayer, f: FindingRec["finding"], c: CheckRec, where: string): Promise<CheckView> {
  const t = templateById(c.template);
  if (!t) throw new SiteError(`${where}: unknown template: ${c.template}; the catalogue cannot render it, so the page cannot show the SQL behind the check`);
  let rendered: ReturnType<typeof renderTemplate>;
  try {
    rendered = renderTemplate(layer, c.template, c.params ?? bindParams(t, f as FindingSummary));
  } catch (err) {
    throw new SiteError(`${where}: ${c.template} cannot be rendered from this finding: ${(err as Error).message}`);
  }
  const view: CheckView = {
    template: t.id, purpose: t.purpose, rowsMean: t.rowsMean, status: "not_run",
    holds: c.holds ?? null, rowCount: c.rowCount ?? null, explanation: c.explanation ?? null, rerun: null,
    bound: c.params ? "recorded with the check" : "bound from the finding",
    extra: extraOf(c, CHECK_KEYS),
    params: { ...rendered.params }, sql: rendered.sql, sqlSha256: sha(rendered.sql), zetarisSql: AS_ZETARIS.render(t.sql, rendered.params), rows: null,
  };
  // A check with no row count never ran (skipped with a reason, say): its SQL is shown, nothing is re-run.
  if (c.rowCount === undefined) return view;

  const res = await layer.run(t.sql, rendered.params, { limit: EVERY_ROW });
  const holds = t.rowsMean === "holds" ? res.total > 0 : res.total === 0;
  if (res.total !== c.rowCount) throw new SiteError(`${where}: ${c.template} re-run returns ${res.total} row(s), the record says ${c.rowCount}`);
  if (c.holds !== undefined && holds !== c.holds) throw new SiteError(`${where}: ${c.template} re-run ${holds ? "holds" : "fails"}, the record says it ${c.holds ? "holds" : "fails"}`);
  if (c.explanation !== undefined && t.explain(rendered.params, res.total) !== c.explanation) {
    throw new SiteError(`${where}: ${c.template} explains itself differently with the parameters bound here, so they are not the parameters that ran`);
  }
  return { ...view, status: "ran", rerun: { rowCount: res.total, holds }, rows: rowsView(res.columns, res.rows, res.total) };
}

/** The decision policy of src/pipeline.ts, as the page states it under every verb. */
export const DECISION_RULE = "The technician's accepted exception in force decides ADOPT until it expires, and a lapsed one ESCALATE. Next, the MSP's policy rule that governs the setting decides ADOPT, HOLD until an expiry, ESCALATE, ROLLBACK or FIX, and the decision names the rule and the reason. With no governing rule: every check holds and none was rejected, ADOPT, as a candidate pending a judge; any check fails or was rejected, ESCALATE.";

/** Why this verb, from the checks and rejections as recorded, and the Decider's reason when a rule or an exception decided. */
function decisionOf(rec: FindingRec): string {
  const ran = rec.checks.filter((c) => c.rowCount !== undefined);
  const failing = ran.filter((c) => c.holds === false).map((c) => c.template);
  const d = rec.disposition;
  return [
    failing.length ? `${failing.length} of ${ran.length} preconditions fail: ${failing.join(", ")}` : `${ran.length} of ${ran.length} preconditions hold`,
    rec.rejected.length ? `${rec.rejected.length} check(s) rejected` : "",
    d && d.decided_by !== "default" ? `decided by ${d.decided_by}${d.rule_id ? ` under ${d.rule_id}` : ""}: ${d.reason.replace(/\.$/, "")}` : "",
  ].filter(Boolean).join("; ");
}

// ---- judge --------------------------------------------------------------------------------------------------

async function judgeView(layer: DataLayer, j: JudgeRec, where: string): Promise<JudgeView> {
  const empty = { sql: null, sqlSha256: null, rowCount: null, rerunRowCount: null, receiptId: null, signature: null, servedModel: null, rationale: null, extra: {} };
  if (typeof j === "string") {
    return {
      ...empty, status: j, model: "none",
      detail: j === "skipped"
        ? "No model ran in this pass, so the judge step is traced as skipped (model: none). Nemotron runs in the Actor's investigation and in the eval; the Nemotron tab re-runs every SELECT its judge wrote there."
        : `judge: ${j}`,
    };
  }
  let sql: string | null = null;
  let rerun: number | null = null;
  if (j.sql) {
    let guarded: string | null = null;
    try {
      guarded = guardRefutation(j.sql, layer.tables);
    } catch {
      guarded = null; // the model's text, refused by the guard (invalid_output): shown as text, never run
    }
    if (guarded) {
      sql = layer.render(guarded);
      if (typeof j.rowCount === "number") {
        rerun = (await layer.run(guarded, {}, { limit: MAX_LIMIT })).rowCount;
        if (rerun !== j.rowCount) throw new SiteError(`${where}: the judge's falsifier re-run returns ${rerun} row(s), the record says ${j.rowCount}`);
      }
    } else sql = j.sql;
  }
  const sig = typeof j.signatureOk === "boolean" ? j.signatureOk : null;
  const signature = sig === true ? "verified"
    : sig === false ? "does not verify"
    : j.status === "stands" || j.status === "refuted" ? "verified (a verdict is kept only after the receipt gate verified the signature)"
    : /signature does not verify/.test(j.reason ?? "") ? "does not verify"
    : j.receiptId ? "not verified" : "no receipt";
  return {
    status: j.status, model: j.servedModel ?? "unknown", detail: j.reason ?? "",
    sql, sqlSha256: sql ? sha(sql) : null, rowCount: j.rowCount ?? null, rerunRowCount: rerun,
    receiptId: j.receiptId ?? null, signature, servedModel: j.servedModel ?? null, rationale: j.rationale ?? null,
    extra: extraOf(j, JUDGE_KEYS),
  };
}

// ---- the full sample pass, for the cross-check ---------------------------------------------------------------

const keyOf = (f: { class: string; host: string | null; object_id: string; setting_path: string; resource_id?: string | null }): string =>
  [f.class, f.host ?? "", f.object_id, f.setting_path, f.resource_id ?? ""].join("|");

async function passOver(bundle: unknown, world: string, memory: TechnicianMemory): Promise<{ pass: Awaited<ReturnType<typeof runPass>>; counts: Record<string, number> }> {
  const engine = await SqlJsEngine.create();
  try {
    const counts = engine.loadBundle(bundle as Record<string, unknown>);
    // decidedAt: the bundle's own instant, or the latest lesson's when that is later (src/data/instant.ts), so a HOLD's expiry is the same on every build
    const decidedAt = decisionInstantWith(bundle, memory.lessons().map((l) => l.recordedAt));
    return { pass: await runPass(new DataLayer(engine), { world: new DriftWorld(world), memory, decidedAt }), counts };
  } finally {
    engine.close();
  }
}

function sampleMatch(rec: FindingRec, full: Map<string, Finding>): FindingView["sample"] {
  const f = full.get(keyOf(rec.finding));
  if (!f) return { match: "absent", detail: "The full sample pass raises no finding on this setting." };
  const verdicts = (cs: { template: string; holds?: boolean }[], rejected: number): string =>
    [cs.map((c) => `${c.template} ${c.holds ? "holds" : "fails"}`).join(", "), rejected ? `${rejected} rejected` : ""].filter(Boolean).join("; ");
  const survey = !["found_but_different", "dns_change"].includes(rec.finding.class);
  const span = f.finding.since === rec.finding.since ? ""
    : ` Its window opens at ${f.finding.since} there and at ${rec.finding.since} here${survey ? ": a survey finding's window starts where the bundle's audit log begins, or at its DNS run when the bundle holds no audit log" : ""}.`;
  if (f.verb === rec.verb && verdicts(f.checks, f.rejected.length) === verdicts(rec.checks, rec.rejected.length)) {
    return { match: "same", detail: `The full sample pass raises the same finding with the same verb (${f.verb}) and the same check verdicts.${span}` };
  }
  return { match: "differs", detail: `The full sample pass raises this finding as ${f.verb} (${verdicts(f.checks, f.rejected.length)}); this slice gives ${rec.verb} (${verdicts(rec.checks, rec.rejected.length)}).${span}` };
}

// ---- one example -----------------------------------------------------------------------------------------------

async function exampleView(dir: string, examplesDir: string, full: Map<string, Finding> | null, memory: TechnicianMemory): Promise<ExampleView> {
  const bundlePath = path.join(examplesDir, dir, "bundle.json");
  const findingsPath = path.join(examplesDir, dir, "findings.json");
  const bundleText = lf(readFileSync(bundlePath, "utf8"));
  const findingsText = lf(readFileSync(findingsPath, "utf8"));
  const bundle = JSON.parse(bundleText) as Record<string, unknown>;
  const parsed = z.array(FindingRecord).safeParse(JSON.parse(findingsText));
  if (!parsed.success) throw new SiteError(`examples/${dir}/findings.json is not a list of findings: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const recs = parsed.data;

  const engine = await SqlJsEngine.create();
  let findings: FindingView[];
  let tables: Record<string, number>;
  try {
    tables = engine.loadBundle(bundle);
    const layer = new DataLayer(engine);
    const runs = objects(await layer.run(RUNS_SQL, {}, { limit: EVERY_ROW }));
    findings = [];
    for (const [i, rec] of recs.entries()) {
      const where = `examples/${dir}/findings.json finding #${i + 1} (${rec.finding.class})`;
      const checks: CheckView[] = [];
      for (const [k, c] of rec.checks.entries()) checks.push(await checkView(layer, rec.finding, c, `${where} check #${k + 1}`));
      const f = rec.finding;
      findings.push({
        id: `${dir}-${i + 1}`, class: f.class, verb: rec.verb, claim: f.summary, decision: decisionOf(rec),
        fields: [
          ["finding id", rec.id ?? null],
          ["tenant", f.tenant_id], ["surface", f.surface], ["host", f.host], ["object", f.object_id], ["setting", f.setting_path],
          ["DNS name", f.dns_name ?? null], ["refers to", f.refers_to_id ?? null], ["resolves to", f.resolves_to ?? null],
          ["record (audit resource)", f.resource_id ?? null], ["collection run", f.run_id], ["DNS run", f.dns_run_id ?? null],
          ["window", `${f.since} to ${f.until}`], ["value_hash", f.value_hash], ["value (redacted)", f.value_redacted ?? null],
        ],
        world: rec.world ?? null, exposure: rec.exposure ?? null,
        detection: await detectionView(layer, f, runs, where),
        checks,
        rejected: rec.rejected.map((r) => {
          const id = (r.check as { template?: unknown } | null)?.template;
          const template = typeof id === "string" ? id : null;
          return { template, reason: template && r.reason.startsWith(`${template}: `) ? r.reason.slice(template.length + 2) : r.reason };
        }),
        judge: await judgeView(layer, rec.judge, where),
        sample: full ? sampleMatch(rec, full) : null,
      });
    }
  } finally {
    engine.close();
  }

  const again = await passOver(bundle, `site_${dir}`, memory);
  const reproduced = `${JSON.stringify(again.pass.findings, null, 2)}\n` === findingsText;
  return {
    dir, note: typeof bundle._note === "string" ? bundle._note : "", tables: Object.fromEntries(Object.entries(tables).filter(([, n]) => n > 0)),
    files: [
      { path: `examples/${dir}/bundle.json`, bytes: Buffer.byteLength(bundleText), sha256: sha(bundleText) },
      { path: `examples/${dir}/findings.json`, bytes: Buffer.byteLength(findingsText), sha256: sha(findingsText) },
    ],
    reproduced, verbs: tally(recs.map((r) => r.verb)), classes: tally(recs.map((r) => r.finding.class)), findings,
  };
}

// ---- the Nemotron tab: one eval results directory, every judge SELECT re-run over the recording ---------------------

/** A run file's name: C<config number>-run<run number>.json. */
const RUN_FILE = /^C(\d+)-run(\d+)\.json$/;
/** Which text the redactor would rewrite; a fixed salt and no labels, so the answer is the same on every machine. */
const AS_IS = new Redactor("site-build", []);

// The results as src/eval/run.ts writes them (lenient: a field a later runner adds passes through).
const EvalCall = z.looseObject({
  kind: z.string(), requested_tier: z.enum(["lightning", "ultra"]), model_requested: z.string(),
  served_model: z.string().nullable(), served_tier: z.enum(["lightning", "ultra", "unknown"]), receipt_id: z.string().nullable(),
  signature_ok: z.boolean().nullable(), cache_status: z.string().nullable(),
});
const EvalJudge = z.looseObject({
  status: z.string(), sql: opt(), rows: z.number().int().nonnegative().nullable().optional(), receipt_id: opt(), served_model: opt(),
});
const EvalRun = z.looseObject({
  config: z.looseObject({
    id: z.string(), select: z.looseObject({ kind: z.string() }).nullable().optional(), judge: z.string().nullable().optional(), direct: z.string().nullable().optional(),
  }),
  run: z.number().int().positive(), valid: z.boolean(), recording: z.string(), tenant: z.string(), set: z.string(),
  started_at: z.string().nullable().optional(), finished_at: z.string().nullable().optional(),
  policy: z.looseObject({ file: z.string() }).nullable().optional(),
  counts: z.looseObject({
    calls: z.number().int(), checks_selected: z.number().int(), checks_valid: z.number().int(), checks_ran_unmodified: z.number().int(),
    false_positives: z.number().int(), labelled_no: z.number().int(),
  }),
  items: z.array(z.looseObject({
    id: z.string(),
    subjects: z.array(z.looseObject({
      finding_id: z.string(),
      checks: z.array(z.looseObject({ template: z.string() })).default([]),
      judge: z.union([EvalJudge, z.looseObject({ withheld: z.string() }), z.null()]).optional(),
    })).default([]),
  })),
  calls: z.array(EvalCall),
});
const EvalPlanted = z.looseObject({
  recording: z.string(),
  claims: z.array(EvalJudge.extend({ config: z.string(), run: z.number().int().positive(), judge_tier: z.string(), id: z.string(), kind: z.string(), struck: z.boolean().optional() })),
});
const PlantedText = z.looseObject({ claims: z.array(z.looseObject({ id: z.string(), kind: z.string(), claim: z.string() })) });

/** One judge record of the eval, a planted claim's or an item finding's: its SELECT as recorded and what it returns at build. */
export interface JudgeSelectView {
  config: string; run: number;
  /** The planted claim's id; null for an item judge. */
  claim: string | null;
  /** The item and its finding; null for a planted claim. */
  item: string | null; finding: string | null;
  /** An item judge's checks: the templates Lightning chose that ran for the finding. */
  templates: string[] | null;
  /** The judge's tier as the run requested it (a planted claim's record names it). */
  tier: string | null;
  status: string; rowsRecorded: number | null;
  /** equal: re-run to the recorded count; does_not_run: the recorded text, refused by the guard or the engine; not_run: no SELECT with a row count to re-run. */
  rerun: "equal" | "does_not_run" | "not_run";
  rowsAtBuild: number | null; why: string | null;
  receiptId: string | null; servedModel: string | null; sql: string | null;
}
export interface NemotronTotals {
  stamp: string; set: string; calls: number; signatureVerified: number; cacheHits: number; substitutions: number;
  /** Judge SELECTs recorded with a row count, of them those re-run equal and those whose recorded text does not run. */
  judgeSelects: number; rerunEqual: number; notRunnable: number;
}
export interface NemotronView {
  dir: string; recording: string; policy: string | null; tenant: string;
  totals: NemotronTotals;
  /** The calls per configuration, role, tier and model requested, and model served. */
  served: { config: string; role: string; tierRequested: string; modelRequested: string; modelServed: string | null; tierServed: string; calls: number; signatureVerified: number; cacheHits: number; substitutions: number }[];
  runs: { config: string; run: number; valid: boolean; selects: boolean; calls: number; checksSelected: number; checksValid: number; ranUnmodified: number; falsePositives: number; labelledNo: number }[];
  claims: { id: string; kind: string; claim: string | null; judges: JudgeSelectView[] }[];
  items: JudgeSelectView[];
  /** The header's tile; null when the run files hold no configuration with direct: ultra or none with judge: ultra over a model's selection. */
  headline: Headline | null;
}
/** One run of a headline configuration: the items labelled no whose verdict reads yes, of the items labelled no. */
export interface HeadlineRun { run: number; valid: boolean; readYes: number; labelledNo: number }
export interface Headline {
  /** Ultra alone: the configuration whose run files record direct: ultra (C4). */
  alone: { config: string; runs: HeadlineRun[] };
  /** The checks with Ultra as the falsifier: judge: ultra over a model's selection (C3); per run also the planted claims struck, of those planted. */
  checks: { config: string; runs: (HeadlineRun & { struck: number; claims: number })[] };
  /** The earliest started_at and the latest finished_at over every run file. */
  started: string | null; finished: string | null;
}

/** The lexically newest directory under `base` that holds planted.json and a C*-run*.json; null when none does. */
export function newestResults(base: string): string | null {
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base)
    .filter((d) => statSync(path.join(base, d)).isDirectory())
    .filter((d) => existsSync(path.join(base, d, "planted.json")) && readdirSync(path.join(base, d)).some((f) => RUN_FILE.test(f)))
    .sort();
  return dirs.length ? path.join(base, dirs[dirs.length - 1]) : null;
}

/** A results file through its schema; a refusal names the file and the first fields that fail. */
function readResults<T>(schema: z.ZodType<T>, file: string, shown: string): T {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new SiteError(`refusing to publish: ${shown} is missing or is not JSON`);
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new SiteError(`refusing to publish: ${shown} is not an eval results file: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return r.data;
}

type EvalJudgeRec = z.infer<typeof EvalJudge>;

/**
 * One judge record against the recording. A record with a SELECT and a row count, whose status is not invalid_output
 * or not_judged, is re-guarded and re-run at LIMIT MAX_LIMIT: the recorded count is equal, any other count refuses the
 * build, and a text the guard or the engine refuses is shown as recorded with the reason. Any other record is shown as recorded.
 */
async function judgeSelect(layer: DataLayer, at: Omit<JudgeSelectView, "status" | "rowsRecorded" | "rerun" | "rowsAtBuild" | "why" | "receiptId" | "servedModel" | "sql">, j: EvalJudgeRec, where: string): Promise<JudgeSelectView> {
  const sql = j.sql ?? null;
  const rows = typeof j.rows === "number" ? j.rows : null;
  const shown = { ...at, status: j.status, rowsRecorded: rows, receiptId: j.receipt_id ?? null, servedModel: j.served_model ?? null, sql };
  if (sql === null || rows === null || j.status === "invalid_output" || j.status === "not_judged") return { ...shown, rerun: "not_run", rowsAtBuild: null, why: null };
  // A refusal's message, each ": " part kept while the redactor leaves the parts kept so far as they are: an operand
  // such as "b6a1ec.host" reads as a name to it, and `unrecognized token: "10d1f4"` (a pseudonym's fragment) as a
  // key and its value; the SQL beside the reason shows the operand in place.
  const reason = (err: unknown): string => (err as Error).message.split(": ").reduce<string[]>((kept, part) => {
    const next = [...kept, part].join(": ");
    return AS_IS.text(next) === next ? [...kept, part] : kept;
  }, []).join(": ");
  let guarded: string;
  try {
    guarded = guardRefutation(sql, layer.tables);
  } catch (err) {
    return { ...shown, rerun: "does_not_run", rowsAtBuild: null, why: `the guard refuses it: ${reason(err)}` };
  }
  let got: number;
  try {
    got = (await layer.run(guarded, {}, { limit: MAX_LIMIT })).rowCount;
  } catch (err) {
    return { ...shown, rerun: "does_not_run", rowsAtBuild: null, why: `the engine refuses it: ${reason(err)}` };
  }
  if (got !== rows) throw new SiteError(`refusing to publish: ${where}: the judge's SELECT re-run over the recording returns ${got} row(s), the record says ${rows}`);
  return { ...shown, rerun: "equal", rowsAtBuild: got, why: null };
}

/** The Nemotron tab's content from one results directory, every judge SELECT re-run over the recording the runs name. */
export async function nemotronView(dir: string): Promise<NemotronView> {
  const shown = shownPath(dir);
  const names = readdirSync(dir).flatMap((f) => {
    const m = RUN_FILE.exec(f);
    return m ? [{ file: f, config: Number(m[1]), run: Number(m[2]) }] : [];
  }).sort((a, b) => a.config - b.config || a.run - b.run);
  if (!names.length) throw new SiteError(`refusing to publish: ${shown} holds no C*-run*.json`);
  const runs = names.map((n) => ({ file: n.file, r: readResults(EvalRun, path.join(dir, n.file), `${shown}/${n.file}`) }));
  const planted = readResults(EvalPlanted, path.join(dir, "planted.json"), `${shown}/planted.json`);
  const text = readResults(PlantedText, path.join(ROOT, "eval", "planted.json"), "eval/planted.json");

  const first = runs[0].r;
  const policy = first.policy?.file ?? null;
  for (const { file, r } of runs) {
    if (r.recording !== first.recording || r.tenant !== first.tenant || r.set !== first.set || (r.policy?.file ?? null) !== policy) {
      throw new SiteError(`refusing to publish: ${shown}/${file} names another recording, tenant, set or policy file than ${runs[0].file}; one results directory holds one eval`);
    }
    if (r.counts.calls !== r.calls.length) throw new SiteError(`refusing to publish: ${shown}/${file} counts ${r.counts.calls} call(s) and holds ${r.calls.length} call record(s)`);
  }
  if (planted.recording !== first.recording) throw new SiteError(`refusing to publish: ${shown}/planted.json names another recording than its run files`);

  const engine = await SqlJsEngine.create();
  try {
    engine.loadBundle(JSON.parse(readFileSync(path.resolve(ROOT, first.recording), "utf8")) as Record<string, unknown>);
    if (policy) {
      // The policy rows as src/eval/policy.ts inserts them, under a fixed salt: every machine and CI builds the same page.
      try {
        engine.insertRows("policy_rule", loadPolicyFile(path.resolve(ROOT, policy), { tenant: first.tenant, redactor: new Redactor("eval-runner", []) }).rows);
      } catch (err) {
        throw new SiteError(`refusing to publish: ${policy}, the policy file the runs name, does not load: ${(err as Error).message}`);
      }
    }
    const layer = new DataLayer(engine);

    const ids = [...new Set([...text.claims.map((c) => c.id), ...planted.claims.map((c) => c.id)])];
    const claims: NemotronView["claims"] = [];
    for (const id of ids) {
      const recs = planted.claims.filter((c) => c.id === id);
      if (!recs.length) continue;
      const judges: JudgeSelectView[] = [];
      for (const c of recs) {
        judges.push(await judgeSelect(layer, { config: c.config, run: c.run, claim: c.id, item: null, finding: null, templates: null, tier: c.judge_tier }, c, `${shown}/planted.json ${c.config} run ${c.run} claim ${c.id}`));
      }
      const t = text.claims.find((c) => c.id === id);
      claims.push({ id, kind: t?.kind ?? recs[0].kind, claim: t?.claim ?? null, judges });
    }

    const items: JudgeSelectView[] = [];
    for (const { file, r } of runs) {
      for (const i of r.items) {
        for (const s of i.subjects) {
          if (!s.judge || !("status" in s.judge)) continue;
          items.push(await judgeSelect(layer, {
            config: r.config.id, run: r.run, claim: null, item: i.id, finding: s.finding_id, templates: s.checks.map((c) => c.template), tier: null,
          }, s.judge as EvalJudgeRec, `${shown}/${file} ${r.config.id} run ${r.run} item ${i.id} finding ${s.finding_id}`));
        }
      }
    }

    const served = new Map<string, NemotronView["served"][number]>();
    for (const { r } of runs) {
      for (const c of r.calls) {
        const k = [r.config.id, c.kind, c.requested_tier, c.model_requested, c.served_model ?? "", c.served_tier].join("\u001f");
        const e = served.get(k) ?? { config: r.config.id, role: c.kind, tierRequested: c.requested_tier, modelRequested: c.model_requested, modelServed: c.served_model, tierServed: c.served_tier, calls: 0, signatureVerified: 0, cacheHits: 0, substitutions: 0 };
        e.calls++;
        if (c.signature_ok === true) e.signatureVerified++;
        if (c.cache_status === "hit") e.cacheHits++;
        if (isSubstitution(c)) e.substitutions++;
        served.set(k, e);
      }
    }
    const rows = [...served.values()];
    const judged = [...claims.flatMap((c) => c.judges), ...items].filter((j) => j.rerun !== "not_run");
    const stamp = path.basename(dir);

    const alone = runs.find(({ r }) => r.config.direct === "ultra")?.r.config.id;
    const checked = runs.find(({ r }) => r.config.judge === "ultra" && r.config.select?.kind === "model")?.r.config.id;
    const runsOf = (id: string): HeadlineRun[] => runs.filter(({ r }) => r.config.id === id)
      .map(({ r }) => ({ run: r.run, valid: r.valid, readYes: r.counts.false_positives, labelledNo: r.counts.labelled_no }));
    const instants = (xs: (string | null | undefined)[]): string[] => xs.filter((s): s is string => typeof s === "string" && !Number.isNaN(Date.parse(s))).sort();
    const headline: Headline | null = alone && checked ? {
      alone: { config: alone, runs: runsOf(alone) },
      checks: {
        config: checked,
        runs: runsOf(checked).map((x) => {
          const p = planted.claims.filter((c) => c.config === checked && c.run === x.run);
          return { ...x, struck: p.filter((c) => c.struck ?? c.status === "refuted").length, claims: p.length };
        }),
      },
      started: instants(runs.map(({ r }) => r.started_at))[0] ?? null,
      finished: instants(runs.map(({ r }) => r.finished_at)).at(-1) ?? null,
    } : null;
    return {
      dir: shown, recording: first.recording, policy, tenant: first.tenant,
      totals: {
        stamp, set: first.set,
        calls: runs.reduce((n, x) => n + x.r.counts.calls, 0),
        signatureVerified: rows.reduce((n, e) => n + e.signatureVerified, 0),
        cacheHits: rows.reduce((n, e) => n + e.cacheHits, 0),
        substitutions: rows.reduce((n, e) => n + e.substitutions, 0),
        judgeSelects: judged.length, rerunEqual: judged.filter((j) => j.rerun === "equal").length, notRunnable: judged.filter((j) => j.rerun === "does_not_run").length,
      },
      served: rows,
      runs: runs.map(({ r }) => ({
        config: r.config.id, run: r.run, valid: r.valid, selects: r.config.select?.kind === "model", calls: r.counts.calls,
        checksSelected: r.counts.checks_selected, checksValid: r.counts.checks_valid, ranUnmodified: r.counts.checks_ran_unmodified,
        falsePositives: r.counts.false_positives, labelledNo: r.counts.labelled_no,
      })),
      claims, items, headline,
    };
  } finally {
    engine.close();
  }
}

/** Element text: the three characters markup reads in text, escaped (quotes matter in attributes, and the tab's one attribute is a rowspan it counts). */
const escapeText = (s: string): string => s.replace(/[&<>]/g, (c) => ESC[c]);
const td = (v: string | number | null): string => `<td>${v === null ? "-" : escapeText(String(v))}</td>`;
const tableOf = (cols: string[], rows: string[]): string =>
  `<div class="scroll"><table>\n<thead><tr>${cols.map((c) => `<th scope="col">${escapeText(c)}</th>`).join("")}</tr></thead>\n<tbody>\n${rows.join("\n")}\n</tbody>\n</table></div>`;

/**
 * The judge records of one claim or one item finding as table rows, `lead` giving each row's first cells. From the
 * status on: status, rows recorded, rows at build, receipt, served model and the SELECT, collapsed; a SELECT a row of
 * the same claim or finding above already shows, character for character, is named by that row ("as C3 run 1").
 */
function judgeRows(group: JudgeSelectView[], lead: (j: JudgeSelectView) => string): string[] {
  const first = new Map<string, string>();
  return group.map((j) => {
    const atBuild = j.rerun === "equal" ? td(j.rowsAtBuild) : j.rerun === "does_not_run" ? td(`does not run: ${j.why}`) : td(null);
    const seen = j.sql === null ? undefined : first.get(j.sql);
    if (j.sql !== null && seen === undefined) first.set(j.sql, `${j.config} run ${j.run}`);
    const sql = j.sql === null ? td(null) : seen ? td(`as ${seen}`) : `<td><details><summary>SQL</summary><pre>${escapeText(j.sql)}</pre></details></td>`;
    return `<tr>${lead(j)}${td(j.status)}${td(j.rowsRecorded)}${atBuild}${td(j.receiptId)}${td(j.servedModel)}${sql}</tr>`;
  });
}

/** Item judges grouped by item and finding, in the order the runs first name them; each group in run order. */
function byFinding(items: JudgeSelectView[]): JudgeSelectView[][] {
  const groups = new Map<string, JudgeSelectView[]>();
  for (const j of items) {
    const k = `${j.item}\u001f${j.finding}`;
    groups.set(k, [...(groups.get(k) ?? []), j]);
  }
  return [...groups.values()];
}

/** The Nemotron tab: static HTML from the results, readable over file:// and with the script off. */
export function nemotronPanel(v: NemotronView): string {
  const t = v.totals;
  const code = (s: string): string => `<code>${escapeText(s)}</code>`;
  const total = v.served.reduce((a, e) => ({ calls: a.calls + e.calls, verified: a.verified + e.signatureVerified, hits: a.hits + e.cacheHits, subs: a.subs + e.substitutions }), { calls: 0, verified: 0, hits: 0, subs: 0 });
  const judgeHead = ["status", "rows recorded", "rows at build", "receipt", "served model", "SELECT"];
  return `<section class="panel" id="nemotron"><div class="wrap md">
<h2>Nemotron in the eval</h2>
<p class="meta">Built by <code>npm run site</code> from ${code(v.dir)}, the ${code(t.set)} set over ${code(v.recording)} for tenant ${code(v.tenant)}: the call records of each run file, the planted claims of its <code>planted.json</code> with their text from <code>eval/planted.json</code>, and the item judges. <code>summary.md</code> there holds every measure of the run.</p>
<p>Lightning returns template ids and parameters from the catalogue, and the catalogue renders the SQL of each check. The judge writes one SELECT that returns rows when the claim is false: Lightning in C2, Ultra in C3. The guard holds it to one SELECT over known tables with LIMIT capped at ${MAX_LIMIT}, and the DataLayer runs it. This build loads ${code(v.recording)} into sql.js${v.policy ? ` with the rules of ${code(v.policy)}` : ""}, as the eval did, then re-guards and re-runs every judge SELECT recorded with a row count: <b>${t.rerunEqual} of ${t.judgeSelects}</b> return the recorded count${t.notRunnable ? `, and the recorded text of ${t.notRunnable} does not run` : ""}. A SELECT that runs and returns another count stops the build. Rows show as counts.</p>
${t.notRunnable ? `<p class="meta">The results hold each SELECT as the eval's redactor left it after the run, and the recorded status and row count are what the SELECT returned when the eval ran it. A recorded text that does not run is shown as recorded, with the reason the guard or the engine gives.</p>\n` : ""}<h3>Calls, requested and served</h3>
<p class="meta">Every call record of every run: the tier and model it requested, the model its receipt names, and the receipts whose Ed25519 signature verifies. A served tier other than the one requested is a substitution and invalidates its run.</p>
${tableOf(["config", "role", "tier requested", "model requested", "model served", "tier served", "calls", "signature verified", "cache hits", "substitutions"], [
  ...v.served.map((e) => `<tr>${td(e.config)}${td(e.role)}${td(e.tierRequested)}${td(e.modelRequested)}${td(e.modelServed)}${td(e.tierServed)}${td(e.calls)}${td(e.signatureVerified)}${td(e.cacheHits)}${td(e.substitutions)}</tr>`),
  `<tr><td><b>all</b></td><td></td><td></td><td></td><td></td><td></td><td><b>${total.calls}</b></td><td><b>${total.verified}</b></td><td><b>${total.hits}</b></td><td><b>${total.subs}</b></td></tr>`,
])}
<h3>Each run</h3>
<p class="meta">Lightning's selection in the configurations where a model selects the checks: the checks it selected, those valid against the catalogue and those that ran as selected. Labelled no, read yes: the items labelled no whose verdict reads yes (ESCALATE or FIX).</p>
${tableOf(["config", "run", "valid run", "calls", "checks selected", "valid", "ran unmodified", "labelled no, read yes"], v.runs.map((r) =>
  `<tr>${td(r.config)}${td(r.run)}${td(r.valid ? "yes" : "no")}${td(r.calls)}${td(r.selects ? r.checksSelected : null)}${td(r.selects ? r.checksValid : null)}${td(r.selects ? r.ranUnmodified : null)}${td(`${r.falsePositives} / ${r.labelledNo}`)}</tr>`))}
<h3>Planted false claims</h3>
<p class="meta">Each claim is false against the rows of the recording. The judge of each judging configuration receives every claim once per run, and a SELECT that returns rows strikes it.</p>
${v.claims.map((c) => `<h4>${escapeText(c.id)}: ${escapeText(c.kind)}</h4>
${c.claim ? `<p>${escapeText(c.claim)}</p>\n` : ""}${tableOf(["config", "run", "judge", ...judgeHead], judgeRows(c.judges, (j) => `${td(j.config)}${td(j.run)}${td(j.tier)}`))}`).join("\n")}
<h3>Item judges</h3>
<p class="meta">Each finding a judge took, with the checks Lightning chose for it that ran, the judge's status and its SELECT.</p>
${tableOf(["item", "finding", "config", "run", "Lightning's checks", ...judgeHead], byFinding(v.items).flatMap((g) => judgeRows(g, (j) =>
  `${j === g[0] ? `<td rowspan="${g.length}">${escapeText(j.item ?? "-")}</td><td rowspan="${g.length}">${escapeText(j.finding ?? "-")}</td>` : ""}${td(j.config)}${td(j.run)}${td(j.templates?.join(", ") ?? null)}`)))}
</div></section>`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** An instant as the page dates it: 25 Oct 2026 23:34 UTC. */
const dated = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${d.toISOString().slice(11, 16)} UTC`;
};

/**
 * The header's tile: Ultra alone beside the checks with Ultra as the falsifier, per run, numbers as the run files and
 * planted.json record them, and one caption naming the results directory and the runs' span. Empty when the results hold no such pair.
 */
export function headlineTile(v: NemotronView): string {
  const h = v.headline;
  if (!h) return "";
  const runsText = (xs: { run: number }[]): string => {
    const ns = xs.map((x) => x.run);
    return ns.length === 1 ? `run ${ns[0]}` : `runs ${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`;
  };
  // "6, 5, 6 of 9" when every run has the same total, else each run's own
  const perRun = (xs: [number, number][]): string =>
    !xs.length ? "-" : xs.every(([, d]) => d === xs[0][1]) ? `${xs.map(([k]) => k).join(", ")} of ${xs[0][1]}` : xs.map(([k, d]) => `${k} of ${d}`).join(", ");
  const li = (b: string, label: string): string => `<li><b>${escapeText(b)}</b>${escapeText(label)}</li>`;
  const invalid = [h.alone, h.checks].flatMap((c) => c.runs.filter((r) => !r.valid).map((r) => `${c.config} run ${r.run}`));
  const span = h.started && h.finished ? `, ${dated(h.started)} to ${dated(h.finished)}` : "";
  return `<div class="headline">
<h2>Ultra alone vs the checks with Ultra as the falsifier</h2>
<ul class="stats">
${li(perRun(h.alone.runs.map((r) => [r.readYes, r.labelledNo])), `items labelled no that Ultra alone (${h.alone.config}) reads as yes, ${runsText(h.alone.runs)}`)}
${li(perRun(h.checks.runs.map((r) => [r.readYes, r.labelledNo])), `items labelled no that the checks with Ultra as the falsifier (${h.checks.config}) read as yes, ${runsText(h.checks.runs)}`)}
${li(perRun(h.checks.runs.map((r) => [r.struck, r.claims])), `planted false claims struck by ${h.checks.config}, ${runsText(h.checks.runs)}`)}
</ul>
<p class="meta">From <a href="#nemotron"><code>${escapeText(v.dir)}</code></a>, the ${escapeText(v.totals.set)} set${span}.${invalid.length ? ` Not valid: ${invalid.join(", ")}.` : ""}</p>
</div>`;
}

/**
 * The header's counts, static: the findings by finding id beside the rows the slices list, the verbs by finding id, the
 * checks re-run over the slices, the classes, and the eval's Nemotron calls and judge SELECTs re-run, both linked to the tab.
 */
export function headerStats(t: SiteIndex["totals"]): string {
  const n = t.nemotron;
  const plural = (k: number, w: string): string => `${k} ${w}${k === 1 ? "" : "s"}`;
  const li = (b: string, label: string): string => `<li><b>${b}</b>${escapeText(label)}</li>`;
  return `<ul class="stats" id="stats">
${li(String(t.findings), `${t.findings === 1 ? "finding" : "findings"}, ${plural(t.rows, "row")} over ${plural(t.examples, "slice")}`)}
${li(escapeText(Object.entries(t.verbs).map(([k, x]) => `${x} ${k}`).join(", ")), "verbs")}
${li(`${t.checksRerun} / ${t.checks}`, "checks re-run over the slices at build, counts equal")}
${li(String(Object.keys(t.classes).length), "finding classes")}
${li(`<a href="#nemotron">${n.calls}</a>`, `Nemotron calls in eval ${n.stamp}, ${n.signatureVerified} receipts verified`)}
${li(`<a href="#nemotron">${n.rerunEqual} / ${n.judgeSelects}</a>`, `Nemotron judge SELECTs re-run at build, counts equal${n.notRunnable ? `; ${n.notRunnable} recorded text does not run` : ""}`)}
</ul>`;
}

/** Every string leaf of a value, in order: the text the deny-list scan reads for the Nemotron tab. */
const leavesOf = (v: unknown): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(leavesOf) : v && typeof v === "object" ? Object.values(v).flatMap(leavesOf) : [];

// ---- the deny-list scan ---------------------------------------------------------------------------------------

export interface ScanReport { files: number; shown: number; labels: number; aliases: number; leaves: number; skipped: string | null }

/**
 * The leak test's scan over the output, refusing on any hit: the operator's labels (REDACT_WORDS and
 * EXPORT_DENY_WORDS, countLabels as test/leak.test.ts runs it) and the configured ssh aliases, over every
 * file and over each markdown text the page renders (`shown`), as written, so an HTML escape cannot hide
 * a label; then every string leaf of every JSON file through the redactor under a fresh salt, which must
 * leave it unchanged: a real name, address, mail address or secret would be replaced. The page's script
 * and its two markdown tabs carry dotted identifiers (a file name, the probe.verify surface) that read as
 * names to the hostname pass, so the redactor half runs over the data files only; the owner's document
 * passed npm run document's own label probe before it was written. `walked` names values whose every string
 * leaf goes through the redactor too: the strings the Nemotron tab is built from, which the page carries as HTML.
 * Hits name the file, the JSON path and the label's position in the list, never the label or the value.
 */
export function scanOutput(files: Map<string, string>, shown: Map<string, string> = new Map(), walked: Map<string, unknown> = new Map()): ScanReport {
  const words = [...new Set([...config.redactWords, ...config.exportDenyWords])];
  const aliases = Object.keys(config.linuxHosts);
  const hits: string[] = [];
  for (const [name, text] of [...files, ...shown]) {
    for (const [w, n] of Object.entries(countLabels(text, words))) hits.push(`${name}: label #${words.indexOf(w) + 1} x${n}`);
    for (const [a, n] of Object.entries(countLabels(text, aliases))) hits.push(`${name}: ssh alias #${aliases.indexOf(a) + 1} x${n}`);
  }
  const redactor = new Redactor(randomBytes(16).toString("hex"), config.redactWords);
  let leaves = 0;
  const walk = (name: string, v: unknown, at: string): void => {
    if (typeof v === "string") {
      leaves++;
      const out = redactor.text(v);
      if (out !== v) hits.push(`${name} ${at}: the redactor still replaces ${Object.entries(describeRedactions(v, out)).map(([k, n]) => `${n} ${k}`).join(", ") || "text"}`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(name, x, `${at}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(name, x, `${at}.${k}`);
  };
  for (const [name, text] of files) if (name.endsWith(".json")) walk(name, JSON.parse(text), "$");
  for (const [name, v] of walked) walk(name, v, "$");
  if (hits.length) throw new SiteError(`refusing to publish: ${hits.length} deny-list hit(s): ${hits.slice(0, 12).join("; ")}${hits.length > 12 ? "; ..." : ""}`);
  return {
    files: files.size, shown: shown.size, labels: words.length, aliases: aliases.length, leaves,
    skipped: words.length ? null : "REDACT_WORDS and EXPORT_DENY_WORDS are blank: the label half of the scan had nothing to look for; the redactor half ran",
  };
}

// ---- markdown: the subset the owner's document and the sources section use, turned into HTML at build time ---------

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Text as HTML: every character markup could read, escaped. */
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]);

const HEADING = /^(#{1,6})[ \t]+(.*\S)[ \t]*$/;
const ITEM = /^[-*+][ \t]+(.*)$/;
const ROW = /^[ \t]*\|.*\|[ \t]*$/;
const RULE_ROW = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/;

/** One run of text: `code` and **bold**; every other character escaped, an unpaired backtick or ** shown as typed. */
function inline(s: string): string {
  return s.split(/(`[^`]+`)/).map((part, i) => (i % 2
    ? `<code>${escapeHtml(part.slice(1, -1))}</code>`
    : escapeHtml(part).replace(/\*\*(?=\S)(.+?)\*\*/g, "<b>$1</b>"))).join("");
}

/** A table row's cells: the outer pipes dropped, split on each pipe not escaped, `\|` read as a pipe. */
const cellsOf = (row: string): string[] =>
  row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

/**
 * Markdown to HTML, the subset npm run document and npm run sources write: ATX headings (`shift` levels down, so a
 * document's # sits under the page's h1), paragraphs, bullet lists (an indented line continues its item), pipe tables
 * with a --- rule under the header row, inline code and bold. Every other character is escaped, so the output holds no
 * tag, attribute or link the renderer did not write. Same input, same bytes.
 */
export function markdownToHtml(md: string, shift = 0): string {
  const lines = lf(md).split("\n");
  const tableAt = (i: number): boolean => ROW.test(lines[i]) && RULE_ROW.test(lines[i + 1] ?? "");
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    const heading = HEADING.exec(lines[i]);
    if (!lines[i].trim()) i++;
    else if (heading) {
      const n = Math.min(6, heading[1].length + shift);
      out.push(`<h${n}>${inline(heading[2])}</h${n}>`);
      i++;
    } else if (tableAt(i)) {
      const head = cellsOf(lines[i]);
      const body: string[][] = [];
      for (i += 2; i < lines.length && ROW.test(lines[i]); i++) body.push(cellsOf(lines[i]));
      out.push(`<div class="scroll"><table>\n<thead><tr>${head.map((c) => `<th scope="col">${inline(c)}</th>`).join("")}</tr></thead>\n<tbody>\n${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("\n")}\n</tbody>\n</table></div>`);
    } else if (ITEM.test(lines[i])) {
      const items: string[] = [];
      for (; i < lines.length; i++) {
        const item = ITEM.exec(lines[i]);
        if (item) items.push(item[1]);
        else if (/^[ \t]+\S/.test(lines[i])) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
      }
      out.push(`<ul>\n${items.map((x) => `<li>${inline(x)}</li>`).join("\n")}\n</ul>`);
    } else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !(para.length && (HEADING.test(lines[i]) || ITEM.test(lines[i]) || tableAt(i))); i++) para.push(lines[i].trim());
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
  }
  return `${out.join("\n")}\n`;
}

/** The Document tab: the document's title, the line on where it comes from, its file hash, then the rest of it. */
function documentPanel(text: string, file: string): { html: string; decidedAt: string | null } {
  const [first, ...rest] = text.split("\n");
  const title = HEADING.exec(first);
  if (!title) throw new SiteError(`refusing to publish: ${file} opens with no heading; the Document tab shows the owner's document as npm run document writes it`);
  const decidedAt = /^Decided at (\S+)\.$/m.exec(text)?.[1] ?? null;
  return {
    decidedAt,
    html: `<section class="panel" id="document"><div class="wrap md">
<h2>${inline(title[2])}</h2>
<p class="meta">Rendered from SQL over the recorded bundle at the decision instant it states${decidedAt ? `, <code>${escapeHtml(decidedAt)}</code>` : ""}. <code>npm run document</code> in sample mode writes it to <code>${escapeHtml(file)}</code>, and this tab is that markdown as HTML.</p>
<div class="hashes">${escapeHtml(`${file} ${sha(text)} (${Buffer.byteLength(text)} bytes, LF)`)}</div>
${markdownToHtml(rest.join("\n"), 1)}</div></section>`,
  };
}

/** The Sources tab: "Where each answer comes from", read off the SQL by sourcesMarkdown(), then the semantic layer's table by uslMarkdown(). */
function sourcesPanel(md: string, usl: string): string {
  return `<section class="panel" id="sources"><div class="wrap md">
<h2>Where each answer comes from</h2>
<p class="meta">Read off the SQL at build time by <code>sourcesMarkdown()</code> in <code>src/document/render.ts</code>: the section the owner's document and the README carry under this heading, and the table <code>npm run sources</code> prints.</p>
${zetarisParagraph()}
${markdownToHtml(md, 1)}<h3>The semantic layer in Zetaris</h3>
<p class="meta">Read off the USL DDL, the activation SELECTs and the DQ rules at build time by <code>uslMarkdown()</code> in <code>src/zetaris/setup.ts</code>: the table the README carries under "The semantic layer" and <code>npm run sources -- --usl</code> prints.</p>
${markdownToHtml(usl, 1)}</div></section>`;
}

/** The Sources tab's paragraph on Zetaris: the datasource, the semantic layer's entities and DQ rules (src/zetaris/setup.ts), the parity test. */
function zetarisParagraph(): string {
  const code = (s: string): string => `<code>${escapeHtml(s)}</code>`;
  const rules = DQ_RULES.map((r) => `${code(r.name)} on ${code(r.table)}`).join(", ");
  return `<p>In a live pass every detector and check query runs as Zetaris Lightning SQL over the ${code(DATASOURCE)} datasource, the app Postgres registered in Zetaris, each table named ${code(`${DATASOURCE}.<table>`)}. Beside it Zetaris reads the technician's memory store as ${code(FILE_DATASOURCES.lesson)} and the policy file as ${code(FILE_DATASOURCES.rule)}, both files in its filestore. Over the three, the ${code(USL_NAME)} semantic layer holds ${word(USL_TABLES.length)} entities (${USL_TABLES.map(code).join(", ")}) and ${word(DQ_RULES.length)} DQ rules (${rules}). On this page the same SQL runs on sql.js over the recorded rows, and each query on the Findings tab carries the text the live pass sends to Zetaris, rendered at build time. <code>test/parity.test.ts</code> holds the two engines to the same columns, rows and totals; the README's "What it proves" table gives its last measured count.</p>`;
}

// ---- the build --------------------------------------------------------------------------------------------------

/** The key the header counts a finding by: the pass's finding id, or the row's own id for an older record that has none. */
const findingKey = (f: FindingView): string => f.fields.find(([k]) => k === "finding id")?.[1] ?? f.id;

function exampleDirs(examplesDir: string): string[] {
  const dirs = readdirSync(examplesDir)
    .filter((d) => statSync(path.join(examplesDir, d)).isDirectory())
    .filter((d) => existsSync(path.join(examplesDir, d, "findings.json")) && existsSync(path.join(examplesDir, d, "bundle.json")));
  for (const d of dirs) if (!DIR_NAME.test(d)) throw new SiteError(`example directory name ${JSON.stringify(d)} is not [a-z0-9-]; it becomes a published file name`);
  const rank = (d: string): number => (ORDER.includes(d) ? ORDER.indexOf(d) : ORDER.length);
  return dirs.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export async function buildSite(opts: BuildOptions = {}): Promise<BuildResult> {
  const examplesDir = opts.examplesDir ?? path.join(ROOT, "examples");
  const outDir = opts.outDir ?? path.join(ROOT, "docs");
  const samplePath = opts.samplePath === undefined ? path.join(ROOT, "sample", "bundle.json") : opts.samplePath;

  const dirs = exampleDirs(examplesDir);
  if (!dirs.length) throw new SiteError(`no example under ${examplesDir} has both bundle.json and findings.json`);
  const memory = new TechnicianMemory({ storage: "read", directory: opts.memoryDir ?? memoryDir(undefined, true) });

  let sample: SampleSummary | null = null;
  let full: Map<string, Finding> | null = null;
  if (samplePath) {
    const text = lf(readFileSync(samplePath, "utf8"));
    const { pass } = await passOver(JSON.parse(text), "site_sample", memory);
    full = new Map(pass.findings.map((f) => [keyOf(f.finding), f]));
    sample = {
      bundle: shownPath(samplePath), sha256: sha(text), runs: pass.runs, gatedOut: pass.gatedOut.length, observed: pass.observed, findings: pass.findings.length,
      classes: tally(pass.findings.map((f) => f.finding.class)), verbs: tally(pass.findings.map((f) => f.verb)),
    };
  }

  const examples: ExampleView[] = [];
  for (const d of dirs) examples.push(await exampleView(d, examplesDir, full, memory));
  const stale = examples.filter((e) => !e.reproduced).map((e) => `examples/${e.dir}/findings.json`);
  if (stale.length && !opts.allowStale) {
    throw new SiteError(`refusing to publish: ${stale.join(", ")} ${stale.length === 1 ? "is" : "are"} stale: re-running the pass over the slice does not give the committed findings; run npm run examples, then npm run site (or pass --allow-stale to publish the page marked stale)`);
  }

  const resultsDir = opts.resultsDir ?? newestResults(path.join(ROOT, "eval", "results"));
  if (!resultsDir) throw new SiteError("refusing to publish: no directory under eval/results holds planted.json and a C*-run*.json; the Nemotron tab is built from one (npm run eval writes it, --results names it)");
  const nemotron = await nemotronView(resultsDir);

  const all = examples.flatMap((e) => e.findings);
  const checks = all.flatMap((f) => f.checks);
  // Each finding once, by its finding id: the same finding in two slices is one finding and two rows. A finding that
  // reads two verbs in two slices counts under each (one per finding id and verb), so no slice's reading is dropped.
  const once = (pick: (f: FindingView) => string): Record<string, number> =>
    tally([...new Map(all.map((f) => [`${findingKey(f)}\u001f${pick(f)}`, pick(f)])).values()]);
  const index: SiteIndex = {
    title: "ConfigLeaf replay",
    examples: examples.map((e) => ({ dir: e.dir, file: `data/${e.dir}.json`, findings: e.findings.length, checks: e.findings.reduce((n, f) => n + f.checks.length, 0), reproduced: e.reproduced })),
    totals: {
      examples: examples.length, findings: new Set(all.map(findingKey)).size, rows: all.length, checks: checks.length, checksRerun: checks.filter((c) => c.status === "ran").length,
      verbs: once((f) => f.verb), classes: once((f) => f.class), judgeModels: once((f) => f.judge.model),
      nemotron: nemotron.totals,
    },
    sample,
    decisionRule: DECISION_RULE,
    limits: { maxRows: MAX_ROWS, maxCell: MAX_CELL },
  };

  const documentPath = opts.documentPath ?? path.join(ROOT, "examples", "document.md");
  const docFile = shownPath(documentPath);
  if (!existsSync(documentPath)) throw new SiteError(`refusing to publish: ${docFile} is missing; SAMPLE_MODE=true npm run document -- --tenant <id> writes it`);
  const docText = lf(readFileSync(documentPath, "utf8"));
  const doc = documentPanel(docText, docFile);
  const sourcesText = sourcesMarkdown();
  const uslText = uslMarkdown();

  const files = new Map<string, string>();
  files.set("index.html", page(headlineTile(nemotron), headerStats(index.totals), doc.html, sourcesPanel(sourcesText, uslText), nemotronPanel(nemotron)));
  files.set(".nojekyll", "");
  files.set("data/index.json", `${JSON.stringify(index, null, 2)}\n`);
  for (const e of examples) files.set(`data/${e.dir}.json`, `${JSON.stringify(e, null, 1)}\n`);

  const nemotronName = `${nemotron.dir} (the Nemotron tab)`;
  const scan = scanOutput(
    files,
    new Map([[`${docFile} (the Document tab)`, docText], ["sourcesMarkdown() (the Sources tab)", sourcesText], ["uslMarkdown() (the Sources tab)", uslText], [nemotronName, leavesOf(nemotron).join("\n")]]),
    new Map([[nemotronName, nemotron]]),
  );
  const bytes = [...files.values()].reduce((n, s) => n + Buffer.byteLength(s), 0);
  if (bytes > MAX_BYTES) throw new SiteError(`refusing to publish: the page and its data are ${bytes} bytes, over the ${MAX_BYTES}-byte budget`);

  if (opts.write !== false) {
    mkdirSync(path.join(outDir, "data"), { recursive: true });
    for (const name of readdirSync(path.join(outDir, "data"))) {
      if (name.endsWith(".json") && !files.has(`data/${name}`)) rmSync(path.join(outDir, "data", name));
    }
    for (const [name, text] of files) writeFileSync(path.join(outDir, name), text);
  }
  return {
    outDir, files, bytes, index, scan,
    document: { file: docFile, bytes: Buffer.byteLength(docText), sha256: sha(docText), decidedAt: doc.decidedAt },
    sources: sourceRows().length,
    nemotron,
  };
}

// ---- the page: one file, inline CSS and script, no framework, no CDN, no external font -------------------------
// Four tabs: Findings (the script renders data/), Document, Sources and Nemotron (static HTML, built above). The script
// shows the tab the address names (#document, #sources, #nemotron; any other address is Findings); with the script off
// every tab shows. The header, its tile and its counts included, is static HTML too.

const page = (headline: string, stats: string, documentTab: string, sourcesTab: string, nemotronTab: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ConfigLeaf replay</title>
<meta name="description" content="Every finding of the ConfigLeaf pass over recorded, redacted real collections, with the SQL that ran, the rows it returned, the hashes and the judge step.">
<style>
:root{--bg:#f8f7f4;--fg:#1c1d1f;--muted:#5b5f65;--line:#dcd8cf;--card:#fff;--code:#f1efea;--accent:#1f55c0;--ok:#1b6a39;--ok-bg:#e1f1e6;--bad:#a12a1c;--bad-bg:#f7e2dd;--warn:#7f5300;--warn-bg:#f8ecd2;--chip:#ebe8e1;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
@media (prefers-color-scheme:dark){:root{--bg:#131416;--fg:#e7e5e0;--muted:#a19f99;--line:#2e3034;--card:#1a1b1e;--code:#212327;--accent:#93b2ff;--ok:#82d49e;--ok-bg:#1b3124;--bad:#ff9d8c;--bad-bg:#3a1f1b;--warn:#f0c46e;--warn-bg:#382c13;--chip:#26282c}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:anywhere}
pre,table{overflow-wrap:normal}
.wrap{max-width:1100px;margin:0 auto;padding:0 16px}
a{color:var(--accent)}
header{padding:36px 0 12px;border-bottom:1px solid var(--line)}
h1{font-size:1.7rem;line-height:1.2;margin:0 0 8px;letter-spacing:-.015em}
h2{font-size:1.25rem;margin:40px 0 6px;letter-spacing:-.01em}
h3{font-size:1rem;margin:0}
h4{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:22px 0 8px}
p{margin:6px 0 10px;max-width:78ch}
.lede{color:var(--muted);font-size:1.02rem}
code,.mono{font-family:var(--mono);font-size:.88em}
pre{background:var(--code);border-radius:6px;padding:10px 12px;margin:6px 0;overflow:auto;max-height:440px;font:12.5px/1.5 var(--mono);white-space:pre;tab-size:2}
.stats{display:flex;flex-wrap:wrap;gap:8px 22px;margin:14px 0 4px;padding:0;list-style:none}
.stats b{font-size:1.25rem;display:block;line-height:1.2}
.stats li{color:var(--muted);font-size:.85rem}
.stats li b{color:var(--fg)}
.headline{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px 8px;margin:16px 0 4px;max-width:86ch}
.headline h2{font-size:1rem;margin:0}
.headline .stats{margin:8px 0 6px;gap:10px 22px}
.headline .stats li{flex:1 1 13rem;max-width:21rem}
.controls{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 0;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
.controls label{font-size:.85rem;color:var(--muted)}
select,button{font:inherit;font-size:.85rem;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:5px 9px}
button{cursor:pointer}
button:hover,select:hover{border-color:var(--muted)}
.meta{font-size:.82rem;color:var(--muted);margin:4px 0}
.meta code{word-break:break-all}
details.finding{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:10px 0}
details.finding[open]{box-shadow:0 1px 0 var(--line)}
details.finding>summary{cursor:pointer;padding:12px 14px;list-style:none;display:flex;gap:10px;align-items:baseline}
details.finding>summary::-webkit-details-marker{display:none}
details.finding>summary::before{content:"\\25B8";color:var(--muted);flex:none;transition:transform .15s}
details.finding[open]>summary::before{transform:rotate(90deg)}
.sumtext{min-width:0;flex:1}
.claim{display:block;margin-top:3px}
.where{display:block;font-size:.8rem;color:var(--muted);font-family:var(--mono);word-break:break-all;margin-top:2px}
.body{padding:0 14px 16px 14px;border-top:1px solid var(--line)}
.tag{display:inline-block;font:600 11px/1 var(--mono);padding:4px 7px;border-radius:4px;letter-spacing:.03em;vertical-align:1px;margin-right:6px}
.v-ESCALATE{background:var(--warn-bg);color:var(--warn)}
.v-ADOPT{background:var(--ok-bg);color:var(--ok)}
.v-HOLD{background:var(--chip);color:var(--fg)}
.cls{background:var(--chip);color:var(--fg);font-weight:500}
.ok{color:var(--ok)}
.warnc{color:var(--warn)}
.t-holds{background:var(--ok-bg);color:var(--ok)}
.t-fails{background:var(--bad-bg);color:var(--bad)}
.t-other{background:var(--chip);color:var(--muted)}
dl.fields{display:grid;grid-template-columns:max-content 1fr;gap:3px 14px;margin:8px 0;font-size:.85rem}
dl.fields dt{color:var(--muted)}
dl.fields dd{margin:0;font-family:var(--mono);font-size:.82rem;word-break:break-all}
.check{border-left:3px solid var(--line);padding:2px 0 6px 12px;margin:14px 0}
.check.c-holds{border-left-color:var(--ok)}
.check.c-fails{border-left-color:var(--bad)}
.check h3{font-family:var(--mono);font-size:.92rem;font-weight:600}
.purpose{color:var(--muted);font-size:.85rem;margin:2px 0 6px}
.sentence{margin:4px 0 6px}
.scroll{overflow-x:auto;margin:6px 0;border:1px solid var(--line);border-radius:6px}
table{border-collapse:collapse;font:12px/1.4 var(--mono);width:max-content;min-width:100%}
th,td{padding:4px 8px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
th{background:var(--code);font-weight:600;position:sticky;top:0}
td{white-space:pre-wrap;word-break:break-word;max-width:46ch}
tr:last-child td{border-bottom:0}
.hashes{font:11.5px/1.5 var(--mono);color:var(--muted);word-break:break-all}
.note{background:var(--code);border-radius:6px;padding:10px 12px;font-size:.88rem}
.empty{color:var(--muted);font-size:.85rem;font-style:italic}
.error{background:var(--bad-bg);color:var(--bad);padding:12px 14px;border-radius:6px}
footer{margin:48px 0 0;padding:22px 0 40px;border-top:1px solid var(--line);color:var(--muted);font-size:.88rem}
footer p{max-width:86ch}
[hidden]{display:none!important}
.report{margin:14px 0 0}
.report a{font-weight:600}
.tabs{display:flex;flex-wrap:wrap;gap:2px;margin:18px 0 -13px;position:relative}
.tabs a{padding:7px 14px;border:1px solid transparent;border-bottom:0;border-radius:6px 6px 0 0;color:var(--muted);text-decoration:none;font-size:.92rem;font-weight:500}
.tabs a:hover{color:var(--fg)}
.tabs a[aria-current]{background:var(--bg);border-color:var(--line);color:var(--fg);font-weight:600}
.md h3{font-size:1.06rem;margin:30px 0 6px}
.md ul{margin:6px 0 12px;padding-left:20px}
.md li{margin:4px 0;max-width:110ch}
.md .scroll{width:max-content;max-width:100%}
.md>.meta{max-width:86ch}
td details summary{cursor:pointer;color:var(--accent)}
td pre{white-space:pre-wrap;word-break:break-word;margin:4px 0 0;min-width:36ch;font-size:11.5px}
@media (max-width:640px){body{font-size:14.5px}h1{font-size:1.4rem}.controls{position:static}dl.fields{grid-template-columns:1fr}dl.fields dt{margin-top:6px}details.finding>summary{padding:12px 10px}.body{padding:0 10px 14px}}
</style>
</head>
<body>
<header><div class="wrap">
<h1>ConfigLeaf: every finding, with the SQL behind it</h1>
<p class="lede">A config-drift assurance pass for MSP technicians, replayed from recorded collections. Open a finding to see the detector query that raised it, each precondition check with the SQL that ran, the rows it returned and the hashes, and the judge step. The Document tab holds the owner's document over the full recorded bundle, the Sources tab names the tables and the source behind each finding class, and the Nemotron tab holds the eval's Nemotron calls with every SELECT its judges wrote, re-run at build. In a live pass the same detector and check SQL runs as Zetaris Lightning SQL over the <code>${escapeHtml(DATASOURCE)}</code> datasource, beside the technician's memory store and the policy file, with the <code>${escapeHtml(USL_NAME)}</code> semantic layer and its ${word(DQ_RULES.length)} DQ rules over the three; on this page it runs on sql.js over the recorded rows, and <code>test/parity.test.ts</code> holds the two engines to the same columns, rows and totals.</p>
${headline}
${stats}
<p class="report"><a href="${REPORT_LINK}">Report</a><br><span class="meta">The owner's report, <code>examples/report.html</code>: one HTML file over the same recorded bundle as the Document tab, opened from a clone of the repository.</span></p>
<nav class="tabs" aria-label="Page sections"><a href="#findings">Findings</a><a href="#document">Document</a><a href="#sources">Sources</a><a href="#nemotron">Nemotron</a></nav>
</div></header>
<main>
<div class="panel" id="findings">
<div class="controls"><div class="wrap" style="display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;width:100%">
<label>Class <select id="f-class"><option value="">all</option></select></label>
<label>Verb <select id="f-verb"><option value="">all</option></select></label>
<button type="button" id="open-all">Open all</button>
<button type="button" id="close-all">Close all</button>
<span class="meta" id="shown"></span>
</div></div>
<div class="wrap" id="app"><p class="empty">Loading data/index.json ...</p>
<noscript><p class="error">This tab renders the files in data/ with a short script. Without it, read data/index.json and the per-example files beside it directly; the Document, Sources and Nemotron tabs below read as they are.</p></noscript>
</div>
</div>
${documentTab}
${sourcesTab}
${nemotronTab}
</main>
<footer><div class="wrap">
<p><b>What this page is.</b> A replay of recorded, redacted real collections taken on 24 Oct 2026 from two production Linux hosts (nginx, over SSH with a fixed script of reads; the key is the operator's, so the read-only property is the script's) and six Cloudflare DNS zones with their audit log. Every name, address, host and actor is a pseudonym keyed by the tenant's salt, and every value hash an HMAC under it; the salt is withheld, so a guess at a real name cannot be confirmed against this page. Nothing is authored: each example is a slice of <code>sample/bundle.json</code> cut by <code>scripts/examples.ts</code>, and each finding is what the pass (<code>src/pipeline.ts</code>) computed over its slice with no model.</p>
<p><b>How it was built.</b> <code>npm run site</code> binds every check's parameters from its finding the way the pass does, renders the catalogue template through the data layer on sql.js, and once more with Zetaris's table names (<code>${escapeHtml(DATASOURCE)}.&lt;table&gt;</code>) as the text a live pass sends, shown under each query; it runs the sql.js text again over the slice and refuses to publish unless the row count, the verdict and the sentence equal the record; the detector query must return the finding's own row. It also refuses on any template it cannot render, and on any string that matches the operator's deny-list or that the redactor would still replace. A table shows at most ${MAX_ROWS} rows and ${MAX_CELL} characters per cell; the row count and the row hash cover every row and every character. The Document and Sources tabs are markdown turned into HTML at build time, every character outside headings, paragraphs, lists, tables, inline code and bold escaped: <code>examples/document.md</code> as <code>npm run document</code> wrote it, and the section <code>sourcesMarkdown()</code> reads off the SQL; the deny-list scan reads both as written. The Nemotron tab is static HTML from one eval results directory, the newest under <code>eval/results</code> unless <code>--results</code> names another: the build loads the recording and the policy rows its runs name into sql.js, re-guards and re-runs every judge SELECT recorded with a row count, and refuses to publish when one that runs returns another count; every string the tab is built from passes the deny-list scan and the redactor.</p>
<p><b>Reproduce it.</b> In a clone of the repository, with nothing but Node 22 and <code>npm install</code>: <code>SAMPLE_MODE=true npm run sample</code> reproduces the findings from the repo (the full bundle, no credentials, no model); <code>npm run examples</code> recuts these slices and recomputes their findings; <code>npm run site</code> rebuilds this page.</p>
<p id="sample-line"></p>
</div></footer>
<script>
(() => {
  "use strict";
  const h = (tag, props, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v; else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  };
  const code = (s) => h("code", null, s);
  const count = (o) => Object.entries(o || {}).map(([k, n]) => n + " " + k).join(", ");
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");

  function table(rv) {
    if (!rv || rv.total === 0) return h("p", { class: "empty" }, "no rows");
    const wrap = h("div", { class: "scroll" }, h("table", null,
      h("thead", null, h("tr", null, rv.columns.map((c) => h("th", { scope: "col" }, c)))),
      h("tbody", null, rv.rows.map((r) => h("tr", null, r.map((v) => h("td", null, v === "" ? "\\u2205" : v)))))));
    const notes = [];
    if (rv.shown < rv.total) notes.push("showing " + rv.shown + " of " + rv.total + " rows");
    if (rv.cutCells) notes.push(plural(rv.cutCells, "cell") + " cut at " + LIMITS.maxCell + " characters");
    return [wrap, notes.length ? h("p", { class: "meta" }, notes.join("; ")) : null];
  }
  const hashes = (pairs) => h("div", { class: "hashes" }, pairs.filter((p) => p[1]).map(([k, v]) => h("div", null, k + " " + v)));
  const params = (p) => Object.entries(p).map(([k, v]) => k + " = " + (v === null ? "NULL" : JSON.stringify(v))).join("\\n");
  const asZetaris = (sql) => sql ? h("details", null, h("summary", { class: "meta" }, "as the live pass sends it to Zetaris"), h("pre", null, sql)) : null;
  const extras = (o) => Object.keys(o || {}).length
    ? h("dl", { class: "fields" }, Object.entries(o).map(([k, v]) => [h("dt", null, k), h("dd", null, typeof v === "string" ? v : JSON.stringify(v))]))
    : null;

  function check(c) {
    const verdict = c.status !== "ran" ? "t-other" : c.holds ? "t-holds" : "t-fails";
    const label = c.status !== "ran" ? "NOT RUN" : c.holds ? "HOLDS" : "FAILS";
    return h("div", { class: "check " + (c.status === "ran" ? (c.holds ? "c-holds" : "c-fails") : "") },
      h("h3", null, h("span", { class: "tag " + verdict }, label), c.template),
      h("p", { class: "purpose" }, c.purpose, " Rows mean the precondition ", h("b", null, c.rowsMean), "."),
      c.explanation ? h("p", { class: "sentence" }, c.explanation) : null,
      h("p", { class: "meta" }, c.status === "ran"
        ? ["rows: ", h("b", null, String(c.rowCount)), " recorded, ", h("b", null, String(c.rerun.rowCount)), " on re-run at build; parameters ", c.bound]
        : ["not run in the recorded pass; parameters ", c.bound]),
      extras(c.extra),
      h("pre", null, c.sql),
      h("details", null, h("summary", { class: "meta" }, "parameters"), h("pre", null, params(c.params))),
      asZetaris(c.zetarisSql),
      c.status === "ran" ? table(c.rows) : null,
      hashes([["sql", c.sqlSha256], ["rows", c.rows && c.rows.sha256]]));
  }

  function judge(j) {
    const kids = [h("p", null, h("span", { class: "tag t-other" }, j.status.toUpperCase()), "model: ", code(j.model))];
    if (j.detail) kids.push(h("p", { class: "meta" }, j.detail));
    if (j.receiptId || j.signature) kids.push(h("dl", { class: "fields" },
      h("dt", null, "receipt"), h("dd", null, j.receiptId || "none"),
      h("dt", null, "signature"), h("dd", null, j.signature || "n/a"),
      h("dt", null, "served model"), h("dd", null, j.servedModel || "unknown")));
    if (j.sql) kids.push(h("p", { class: "meta" }, "falsifier: rows ", String(j.rowCount), " recorded", j.rerunRowCount == null ? "" : ", " + j.rerunRowCount + " on re-run at build"), h("pre", null, j.sql));
    if (j.rationale) kids.push(h("p", { class: "sentence" }, j.rationale));
    kids.push(extras(j.extra));
    if (j.sqlSha256) kids.push(hashes([["sql", j.sqlSha256]]));
    return kids;
  }

  function exposure(x) {
    if (!x) return null;
    const bits = [];
    for (const k of ["line", "sentence"]) if (typeof x[k] === "string") bits.push(x[k]);
    if (x.since) bits.push("since " + x.since);
    if (x.days != null) bits.push("about " + x.days + " days");
    if (x.source) bits.push("source " + x.source);
    if (x.still_open_in) bits.push("still open in " + x.still_open_in);
    return [h("h4", null, "Exposure"), h("p", { class: "note" }, bits.join("; ") || JSON.stringify(x))];
  }

  function finding(f) {
    const host = f.fields.find((p) => p[0] === "host")[1];
    const obj = f.fields.find((p) => p[0] === "object")[1];
    const setting = f.fields.find((p) => p[0] === "setting")[1];
    const d = f.detection;
    return h("details", { class: "finding", id: f.id, "data-class": f.class, "data-verb": f.verb },
      h("summary", null, h("span", { class: "sumtext" },
        h("span", { class: "tag v-" + f.verb }, f.verb), h("span", { class: "tag cls" }, f.class),
        h("span", { class: "claim" }, f.claim),
        h("span", { class: "where" }, (host ? host + "  " : "") + obj + "  " + setting))),
      h("div", { class: "body" },
        h("h4", null, "Finding"),
        h("dl", { class: "fields" }, f.fields.filter((p) => p[1] != null && p[1] !== "").map(([k, v]) => [h("dt", null, k), h("dd", null, v)])),
        f.world ? h("p", { class: "meta" }, "World Model: referent fingerprint " + (f.world.before || "unknown") + " then, " + (f.world.after || "unknown") + " now; bytes " + (f.world.bytes_unchanged ? "unchanged" : "changed or no previous run")) : null,
        exposure(f.exposure),
        h("h4", null, "Detected by"),
        d ? [h("p", null, code(d.query), " ", d.description), h("pre", null, d.sql), asZetaris(d.zetarisSql),
          h("p", { class: "meta" }, "over this slice it returns " + plural(d.total, "row") + "; the one this finding came from:"),
          table(d.matched), hashes([["sql", d.sqlSha256], ["row", d.matched.sha256]])]
          : h("p", { class: "empty" }, "no detector query is mapped for this class"),
        h("h4", null, "Preconditions"),
        f.checks.map(check),
        f.rejected.length ? [h("h4", null, "Rejected checks (not run)"), h("ul", null, f.rejected.map((r) => h("li", null, r.template ? [code(r.template), ": "] : "", r.reason)))] : null,
        h("h4", null, "Decision"),
        h("p", null, h("span", { class: "tag v-" + f.verb }, f.verb), f.decision, "."),
        h("p", { class: "meta" }, RULE),
        h("h4", null, "Judge"),
        judge(f.judge),
        f.sample ? [h("h4", null, "Full sample pass"), h("p", { class: "meta " + (f.sample.match === "same" ? "ok" : "warnc") }, f.sample.detail)] : null,
        h("p", { class: "meta" }, h("a", { href: "#" + f.id }, "link to this finding"))));
  }

  function example(e) {
    return h("section", { id: "ex-" + e.dir },
      h("h2", null, e.dir),
      h("p", { class: "note" }, e.note),
      h("p", { class: "meta" }, "rows in the slice: " + count(e.tables)),
      h("p", { class: "meta" }, "findings: " + count(e.classes) + "; " + count(e.verbs) + ". Re-running the pass over this slice at build time " + (e.reproduced ? "gives findings.json byte for byte." : "does NOT give findings.json: the committed example is stale.")),
      hashes(e.files.map((x) => [x.path, x.sha256 + " (" + x.bytes + " bytes, LF)"])),
      e.findings.map(finding));
  }

  let LIMITS = { maxCell: 240 }, RULE = "";
  function filter() {
    const cls = document.getElementById("f-class").value, verb = document.getElementById("f-verb").value;
    let n = 0, all = 0;
    for (const el of document.querySelectorAll("details.finding")) {
      const show = (!cls || el.dataset.class === cls) && (!verb || el.dataset.verb === verb);
      el.hidden = !show; all++; if (show) n++;
    }
    const slices = document.querySelectorAll("#app > section");
    for (const s of slices) s.hidden = !s.querySelector("details.finding:not([hidden])");
    document.getElementById("shown").textContent = n + " of " + plural(all, "row") + " over " + plural(slices.length, "slice") + " shown";
  }
  function options(sel, values) { for (const v of values) sel.append(h("option", { value: v }, v)); sel.addEventListener("change", filter); }

  async function main() {
    const app = document.getElementById("app");
    let index, examples;
    try {
      index = await (await fetch("data/index.json")).json();
      examples = await Promise.all(index.examples.map((e) => fetch(e.file).then((r) => r.json())));
    } catch (err) {
      app.replaceChildren(h("p", { class: "error" }, "This page reads data/index.json and the example files beside it, which a browser will not load from file://. Serve the docs folder over HTTP (for example python -m http.server -d docs, then open http://localhost:8000/), or open the published page."));
      return;
    }
    LIMITS = index.limits;
    RULE = index.decisionRule;
    const t = index.totals;
    options(document.getElementById("f-class"), Object.keys(t.classes));
    options(document.getElementById("f-verb"), Object.keys(t.verbs));
    app.replaceChildren(...examples.map(example));
    if (index.sample) {
      const s = index.sample;
      document.getElementById("sample-line").textContent = "The full sample pass over " + s.bundle + " (" + s.sha256 + "), run at build time: " + s.runs + " collection runs, " + s.gatedOut + " gated out, " + s.observed + " observations, " + s.findings + " findings (" + count(s.classes) + "; " + count(s.verbs) + "). The examples above are slices of it.";
    }
    document.getElementById("open-all").onclick = () => document.querySelectorAll("details.finding:not([hidden])").forEach((d) => (d.open = true));
    document.getElementById("close-all").onclick = () => document.querySelectorAll("details.finding").forEach((d) => (d.open = false));
    filter();
    const target = location.hash && document.getElementById(location.hash.slice(1));
    if (target && target.tagName === "DETAILS") { target.open = true; target.scrollIntoView(); }
  }

  const tabs = [...document.querySelectorAll(".tabs a")];
  function showTab() {
    const on = tabs.find((a) => a.getAttribute("href") === location.hash) || tabs[0];
    for (const a of tabs) {
      document.getElementById(a.getAttribute("href").slice(1)).hidden = a !== on;
      if (a === on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    }
  }
  for (const a of tabs) a.addEventListener("click", (e) => {
    e.preventDefault();
    if (location.hash !== a.getAttribute("href")) history.pushState(null, "", a.getAttribute("href"));
    showTab();
  });
  addEventListener("popstate", showTab);
  addEventListener("hashchange", showTab);
  showTab();
  main();
})();
</script>
</body>
</html>
`;

// ---- CLI --------------------------------------------------------------------------------------------------------

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() : "";
if (invoked === import.meta.url.toLowerCase()) {
  const { values: args } = parseArgs({ options: { out: { type: "string" }, examples: { type: "string" }, "allow-stale": { type: "boolean" }, results: { type: "string" } } });
  try {
    const r = await buildSite({
      outDir: args.out ? path.resolve(args.out) : undefined, examplesDir: args.examples ? path.resolve(args.examples) : undefined, allowStale: args["allow-stale"] === true,
      resultsDir: args.results ? path.resolve(args.results) : undefined,
    });
    for (const e of r.index.examples) console.log(`${e.dir}: ${e.findings} finding(s), ${e.checks} check(s) rendered and re-run, counts equal; pass over the slice ${e.reproduced ? "reproduces" : "DOES NOT reproduce"} findings.json`);
    const t = r.index.totals;
    console.log(`header: ${t.findings} finding(s) by finding id (${Object.entries(t.verbs).map(([k, n]) => `${k} ${n}`).join(", ")}), ${t.rows} row(s) over ${t.examples} slice(s)`);
    const h = r.nemotron.headline;
    if (h) {
      const runs = (xs: [number, number][]): string => xs.map(([k, d]) => `${k}/${d}`).join(" ");
      console.log(`tile: labelled no, read yes: ${h.alone.config} ${runs(h.alone.runs.map((x) => [x.readYes, x.labelledNo]))}, ${h.checks.config} ${runs(h.checks.runs.map((x) => [x.readYes, x.labelledNo]))}; planted claims struck by ${h.checks.config} ${runs(h.checks.runs.map((x) => [x.struck, x.claims]))}`);
    } else console.log("tile: none; the results hold no configuration with direct: ultra beside one with judge: ultra over a model's selection");
    const s = r.index.sample;
    if (s) console.log(`sample: ${s.runs} runs, ${s.observed} observations, ${s.findings} findings (${Object.entries(s.classes).map(([k, n]) => `${k} ${n}`).join(", ")})`);
    const n = r.nemotron.totals;
    console.log(`nemotron: ${n.stamp} ${n.set}: ${n.calls} calls, ${n.signatureVerified} receipts verified, ${n.substitutions} substitutions; ${n.judgeSelects} judge SELECTs, ${n.rerunEqual} re-run equal, ${n.notRunnable} recorded text does not run`);
    console.log(`tabs: Findings; Document (${r.document.file}, ${r.document.bytes} bytes, decided at ${r.document.decidedAt ?? "no instant stated"}); Sources (${r.sources} finding classes); Nemotron (${r.nemotron.dir}, ${r.nemotron.claims.length} planted claims, ${r.nemotron.items.length} item judges)`);
    console.log(`scan: ${r.scan.files} files and ${r.scan.shown} rendered markdown text(s), ${r.scan.labels} deny-list label(s), ${r.scan.aliases} ssh alias(es), ${r.scan.leaves} data and Nemotron tab strings through the redactor unchanged${r.scan.skipped ? ` (${r.scan.skipped})` : ""}`);
    for (const [name, text] of r.files) console.log(`  ${rel(path.join(r.outDir, name))} ${Buffer.byteLength(text)} bytes`);
    console.log(`site: ${r.bytes} bytes in ${r.files.size} files (budget ${MAX_BYTES}) -> ${rel(r.outDir) || "."}`);
    if (r.index.examples.some((e) => !e.reproduced)) console.log("warning: published with --allow-stale; at least one example is stale and the page says so. Run npm run examples, then npm run site");
  } catch (err) {
    console.error(`site: ${(err as Error).message}`);
    process.exit(1);
  }
}
