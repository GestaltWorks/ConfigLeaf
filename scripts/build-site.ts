// npm run site [-- --out docs] [-- --examples examples] [-- --allow-stale]
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
// Refuses to publish (throws, writes nothing) when a check cites a template the catalogue cannot render, or
// parameters it refuses; when a re-run differs from the record; when a detector does not return its finding;
// when re-running the pass over a slice does not give its committed findings.json (the example is stale: run
// npm run examples; `--allow-stale` publishes it marked stale instead, for a deliberate look at the drift);
// when any output file holds a label of the operator's deny-list (REDACT_WORDS and EXPORT_DENY_WORDS: the
// leak test's list and its countLabels scan) or a configured ssh alias; when any string in the data files
// changes under the redactor (a name, address, mail address or secret redaction would still replace, which
// holds with the deny-list blank too); or when the page and its data exceed MAX_BYTES. Every refusal names
// the file and the position in the list, never the label.
//
// Deterministic: no clock, no machine path, so the committed docs/ is exactly the build of the committed
// examples (test/site.test.ts asserts it). File hashes are over LF text, as git stores it.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { MAX_LIMIT, guardRefutation } from "../src/agents/judge.ts";
import { bindParams, type FindingSummary } from "../src/catalogue/select.ts";
import { renderTemplate, templateById } from "../src/catalogue/templates.ts";
import { config } from "../src/config.ts";
import { DataLayer, type Param, type Params } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { decisionInstant } from "../src/data/instant.ts";
import {
  HERO_SQL, ORPHAN_RECORD_SQL, ORPHAN_VHOST_SQL, PROXIED_WITHOUT_REAL_IP_SQL, PROXY_SPLIT_SQL, RUNS_SQL, WILDCARD_WITHOUT_REAL_IP_SQL, objects,
} from "../src/data/queries.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { runPass, type Finding } from "../src/pipeline.ts";
import { Redactor, countLabels, describeRedactions } from "../src/redactor.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The page and every data file together. */
export const MAX_BYTES = 300_000;
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
  // The exposure line (plan addendum item 4: {since, days, source, still_open_in}); shown as recorded, whatever fields it grows.
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
export interface DetectionView { query: string; description: string; sql: string; sqlSha256: string; params: Record<string, Param>; total: number; matched: RowsView }
export interface CheckView {
  template: string; purpose: string; rowsMean: "holds" | "fails"; status: "ran" | "not_run";
  holds: boolean | null; rowCount: number | null; explanation: string | null;
  /** What running the rendered SQL again over the slice returned; equal to the record or the build refuses. */
  rerun: { rowCount: number; holds: boolean } | null;
  bound: "recorded with the check" | "bound from the finding";
  /** Fields the record carries beyond these (a skip reason, say), shown as recorded. */
  extra: Record<string, unknown>;
  params: Record<string, Param>; sql: string; sqlSha256: string; rows: RowsView | null;
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
  totals: { examples: number; findings: number; checks: number; checksRerun: number; verbs: Record<string, number>; classes: Record<string, number>; judgeModels: Record<string, number> };
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
}
export interface BuildResult { outDir: string; files: Map<string, string>; bytes: number; index: SiteIndex; scan: ScanReport }

// ---- helpers ------------------------------------------------------------------------------------------------

const lf = (s: string): string => s.replace(/\r\n/g, "\n");
const sha = (s: string): string => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;
const tally = (xs: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
};
const rel = (p: string): string => path.relative(ROOT, p).split(path.sep).join("/");

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
  return { query: d.query, description: d.description, sql: layer.render(d.sql, d.params), sqlSha256: sha(layer.render(d.sql, d.params)), params: { ...d.params }, total: res.total, matched: rowsView(res.columns, hit, hit.length) };
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
    params: { ...rendered.params }, sql: rendered.sql, sqlSha256: sha(rendered.sql), rows: null,
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
        ? "No model ran in this pass, so the judge step is traced as skipped (model: none). A live pass sends the claim and its rows to Nemotron Ultra for one SELECT that returns rows only if the claim is false, runs it through the same guard and data layer, and keeps the verdict only when the signed receipt names an Ultra."
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

async function passOver(bundle: unknown, world: string): Promise<{ pass: Awaited<ReturnType<typeof runPass>>; counts: Record<string, number> }> {
  const engine = await SqlJsEngine.create();
  try {
    const counts = engine.loadBundle(bundle as Record<string, unknown>);
    // decidedAt: the bundle's own instant (src/data/instant.ts), so a HOLD's expiry is the same on every build
    return { pass: await runPass(new DataLayer(engine), { world: new DriftWorld(world), decidedAt: decisionInstant(bundle) }), counts };
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

async function exampleView(dir: string, examplesDir: string, full: Map<string, Finding> | null): Promise<ExampleView> {
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

  const again = await passOver(bundle, `site_${dir}`);
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

// ---- the deny-list scan ---------------------------------------------------------------------------------------

export interface ScanReport { files: number; labels: number; aliases: number; leaves: number; skipped: string | null }

/**
 * The leak test's scan over the output, refusing on any hit: the operator's labels (REDACT_WORDS and
 * EXPORT_DENY_WORDS, countLabels as test/leak.test.ts runs it) and the configured ssh aliases, over every
 * file; then every string leaf of every JSON file through the redactor under a fresh salt, which must
 * leave it unchanged: a real name, address, mail address or secret would be replaced. The page itself
 * carries no data (it fetches the JSON), and its script's dotted identifiers read as names to the
 * hostname pass, so the redactor half runs over the data files only. Hits name the file, the JSON path
 * and the label's position in the list, never the label or the value.
 */
export function scanOutput(files: Map<string, string>): ScanReport {
  const words = [...new Set([...config.redactWords, ...config.exportDenyWords])];
  const aliases = Object.keys(config.linuxHosts);
  const hits: string[] = [];
  for (const [name, text] of files) {
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
  if (hits.length) throw new SiteError(`refusing to publish: ${hits.length} deny-list hit(s): ${hits.slice(0, 12).join("; ")}${hits.length > 12 ? "; ..." : ""}`);
  return {
    files: files.size, labels: words.length, aliases: aliases.length, leaves,
    skipped: words.length ? null : "REDACT_WORDS and EXPORT_DENY_WORDS are blank: the label half of the scan had nothing to look for; the redactor half ran",
  };
}

// ---- the build --------------------------------------------------------------------------------------------------

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

  let sample: SampleSummary | null = null;
  let full: Map<string, Finding> | null = null;
  if (samplePath) {
    const text = lf(readFileSync(samplePath, "utf8"));
    const { pass } = await passOver(JSON.parse(text), "site_sample");
    full = new Map(pass.findings.map((f) => [keyOf(f.finding), f]));
    sample = {
      bundle: rel(samplePath).startsWith("..") || path.isAbsolute(rel(samplePath)) ? path.basename(samplePath) : rel(samplePath), sha256: sha(text), runs: pass.runs, gatedOut: pass.gatedOut.length, observed: pass.observed, findings: pass.findings.length,
      classes: tally(pass.findings.map((f) => f.finding.class)), verbs: tally(pass.findings.map((f) => f.verb)),
    };
  }

  const examples: ExampleView[] = [];
  for (const d of dirs) examples.push(await exampleView(d, examplesDir, full));
  const stale = examples.filter((e) => !e.reproduced).map((e) => `examples/${e.dir}/findings.json`);
  if (stale.length && !opts.allowStale) {
    throw new SiteError(`refusing to publish: ${stale.join(", ")} ${stale.length === 1 ? "is" : "are"} stale: re-running the pass over the slice does not give the committed findings; run npm run examples, then npm run site (or pass --allow-stale to publish the page marked stale)`);
  }

  const all = examples.flatMap((e) => e.findings);
  const checks = all.flatMap((f) => f.checks);
  const index: SiteIndex = {
    title: "drift-agent replay",
    examples: examples.map((e) => ({ dir: e.dir, file: `data/${e.dir}.json`, findings: e.findings.length, checks: e.findings.reduce((n, f) => n + f.checks.length, 0), reproduced: e.reproduced })),
    totals: {
      examples: examples.length, findings: all.length, checks: checks.length, checksRerun: checks.filter((c) => c.status === "ran").length,
      verbs: tally(all.map((f) => f.verb)), classes: tally(all.map((f) => f.class)), judgeModels: tally(all.map((f) => f.judge.model)),
    },
    sample,
    decisionRule: DECISION_RULE,
    limits: { maxRows: MAX_ROWS, maxCell: MAX_CELL },
  };

  const files = new Map<string, string>();
  files.set("index.html", PAGE);
  files.set(".nojekyll", "");
  files.set("data/index.json", `${JSON.stringify(index, null, 2)}\n`);
  for (const e of examples) files.set(`data/${e.dir}.json`, `${JSON.stringify(e, null, 1)}\n`);

  const scan = scanOutput(files);
  const bytes = [...files.values()].reduce((n, s) => n + Buffer.byteLength(s), 0);
  if (bytes > MAX_BYTES) throw new SiteError(`refusing to publish: the page and its data are ${bytes} bytes, over the ${MAX_BYTES}-byte budget`);

  if (opts.write !== false) {
    mkdirSync(path.join(outDir, "data"), { recursive: true });
    for (const name of readdirSync(path.join(outDir, "data"))) {
      if (name.endsWith(".json") && !files.has(`data/${name}`)) rmSync(path.join(outDir, "data", name));
    }
    for (const [name, text] of files) writeFileSync(path.join(outDir, name), text);
  }
  return { outDir, files, bytes, index, scan };
}

// ---- the page: one file, inline CSS and script, no framework, no CDN, no external font -------------------------

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>drift-agent replay</title>
<meta name="description" content="Every finding of the drift-agent pass over recorded, redacted real collections, with the SQL that ran, the rows it returned, the hashes and the judge step.">
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
@media (max-width:640px){body{font-size:14.5px}h1{font-size:1.4rem}.controls{position:static}dl.fields{grid-template-columns:1fr}dl.fields dt{margin-top:6px}details.finding>summary{padding:12px 10px}.body{padding:0 10px 14px}}
</style>
</head>
<body>
<header><div class="wrap">
<h1>drift-agent: every finding, with the SQL behind it</h1>
<p class="lede">A config-drift assurance pass for MSP technicians, replayed from recorded collections. Open a finding to see the detector query that raised it, each precondition check with the SQL that ran, the rows it returned and the hashes, and the judge step.</p>
<ul class="stats" id="stats"></ul>
</div></header>
<div class="controls"><div class="wrap" style="display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;width:100%">
<label>Class <select id="f-class"><option value="">all</option></select></label>
<label>Verb <select id="f-verb"><option value="">all</option></select></label>
<button type="button" id="open-all">Open all</button>
<button type="button" id="close-all">Close all</button>
<span class="meta" id="shown"></span>
</div></div>
<main class="wrap" id="app"><p class="empty">Loading data/index.json ...</p>
<noscript><p class="error">This page renders the files in data/ with a short script. Without it, read data/index.json and the per-example files beside it directly.</p></noscript>
</main>
<footer><div class="wrap">
<p><b>What this page is.</b> A replay of recorded, redacted real collections taken on 24 Oct 2026 from two production Linux hosts (nginx, over SSH with a fixed script of reads; the key is the operator's, so the read-only property is the script's) and six Cloudflare DNS zones with their audit log. Every name, address, host and actor is a pseudonym keyed by the tenant's salt, and every value hash an HMAC under it; the salt is withheld, so a guess at a real name cannot be confirmed against this page. Nothing is authored: each example is a slice of <code>sample/bundle.json</code> cut by <code>scripts/examples.ts</code>, and each finding is what the pass (<code>src/pipeline.ts</code>) computed over its slice with no model.</p>
<p><b>How it was built.</b> <code>npm run site</code> binds every check's parameters from its finding the way the pass does, renders the catalogue template through the data layer on sql.js, runs it again over the slice and refuses to publish unless the row count, the verdict and the sentence equal the record; the detector query must return the finding's own row. It also refuses on any template it cannot render, and on any string that matches the operator's deny-list or that the redactor would still replace. A table shows at most ${MAX_ROWS} rows and ${MAX_CELL} characters per cell; the row count and the row hash cover every row and every character.</p>
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
        d ? [h("p", null, code(d.query), " ", d.description), h("pre", null, d.sql),
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
    for (const s of document.querySelectorAll("main section")) s.hidden = !s.querySelector("details.finding:not([hidden])");
    document.getElementById("shown").textContent = n + " of " + all + " findings shown";
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
    document.getElementById("stats").replaceChildren(
      h("li", null, h("b", null, String(t.findings)), "findings in " + plural(t.examples, "example")),
      h("li", null, h("b", null, count(t.verbs)), "verbs"),
      h("li", null, h("b", null, t.checksRerun + " / " + t.checks), "checks re-run at build, counts equal"),
      h("li", null, h("b", null, Object.keys(t.classes).length), "finding classes"),
      h("li", null, h("b", null, Object.keys(t.judgeModels).join(", ")), "judge model in these runs"));
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
  main();
})();
</script>
</body>
</html>
`;

// ---- CLI --------------------------------------------------------------------------------------------------------

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() : "";
if (invoked === import.meta.url.toLowerCase()) {
  const { values: args } = parseArgs({ options: { out: { type: "string" }, examples: { type: "string" }, "allow-stale": { type: "boolean" } } });
  try {
    const r = await buildSite({ outDir: args.out ? path.resolve(args.out) : undefined, examplesDir: args.examples ? path.resolve(args.examples) : undefined, allowStale: args["allow-stale"] === true });
    for (const e of r.index.examples) console.log(`${e.dir}: ${e.findings} finding(s), ${e.checks} check(s) rendered and re-run, counts equal; pass over the slice ${e.reproduced ? "reproduces" : "DOES NOT reproduce"} findings.json`);
    const s = r.index.sample;
    if (s) console.log(`sample: ${s.runs} runs, ${s.observed} observations, ${s.findings} findings (${Object.entries(s.classes).map(([k, n]) => `${k} ${n}`).join(", ")})`);
    console.log(`scan: ${r.scan.files} files, ${r.scan.labels} deny-list label(s), ${r.scan.aliases} ssh alias(es), ${r.scan.leaves} JSON strings through the redactor unchanged${r.scan.skipped ? ` (${r.scan.skipped})` : ""}`);
    for (const [name, text] of r.files) console.log(`  ${rel(path.join(r.outDir, name))} ${Buffer.byteLength(text)} bytes`);
    console.log(`site: ${r.bytes} bytes in ${r.files.size} files (budget ${MAX_BYTES}) -> ${rel(r.outDir) || "."}`);
    if (r.index.examples.some((e) => !e.reproduced)) console.log("warning: published with --allow-stale; at least one example is stale and the page says so. Run npm run examples, then npm run site");
  } catch (err) {
    console.error(`site: ${(err as Error).message}`);
    process.exit(1);
  }
}
