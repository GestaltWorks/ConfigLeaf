// The executive report: one page for a CISO or a CTO with two minutes, over the rows the owner's document reads and a
// few more of the tenant's own, for a period (the last 7 days, the last 30, or every day on record) ending at an
// instant: the decision instant in sample mode, the clock live.
//
//   header         the tenant, the period and the time UTC.
//   six KPIs       settings watched; coverage (objects of the latest passing runs with an approval of record, of all of
//                  them); copies with a valid restore; drift events (findings first raised in the period); the median
//                  time from change to detection (a cause's occurred_at to the first decision on its finding at or after
//                  it, over the causes that carry one); actions by status.
//   four charts    findings per day by verb, actions per day by kind and status, failing probes per day, approvals over
//                  time (src/document/charts.ts: inline SVG, both axes named, a pattern and a name beside every fill, the
//                  data table under each).
//   incidents      every finding the period decided ESCALATE, FIX or ROLLBACK, or that an action or a ticket names, as a
//                  card: what, where, the cause's sentence, what the agent did, the ticket; the newest INCIDENTS_SHOWN.
//   sources        each source's runs in the period and how many pass the DQ gate, its last read; then one row per DQ
//                  rule of the semantic layer (src/zetaris/setup.ts DQ_RULES, in its order and on its table), each read
//                  over the tenant's rows of the period (DQ_READS); dns_inventory_current holds the Cloudflare DNS API
//                  now to the last complete DNS run, read through Zetaris live and "not read" on sql.js.
//   receipts       from the newest eval results: the receipts whose Ed25519 signature verifies (src/receipts/bundle.ts
//                  verify, what npm run receipts:verify prints), and Ultra alone beside the checks with Ultra as the
//                  falsifier, per run; the receipt ids the tenant's actions of the period name.
//   footer         the agent, the source, the policy file and version, the sponsor stack, the bundle in sample mode.
//
// Contract: readExecutive is the only part that reads, through the DataLayer the agent uses, a handful of SELECTs over
// the tenant's rows beside the owner's document's (src/document/render.ts DocumentData); executiveSections and
// renderExecutive are pure functions of what it returns. Every data string passes ctx.redactor, then the HTML escape.
// renderExecutive returns one standalone file: one inline style block, inline SVG, no script, no external resource,
// light and dark by prefers-color-scheme; in print A4 with a page break between sections and the light tokens. The
// console (src/console/) serves executiveSections inside its shell with Export PDF (window.print) and Download HTML
// (this file). Sample mode writes examples/executive.html (scripts/executive.ts, test/executive.test.ts holds it equal).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { actionOf } from "../actions/plan.ts";
import { ADOPTION_SQL, EXCEPTION_IN_FORCE } from "../data/files.ts";
import type { DataLayer } from "../data/layer.ts";
import { objects } from "../data/queries.ts";
import type { Action, FindingCause } from "../data/rows.ts";
import { BASE_CSS, MARK, PRINT_TOKENS, ROOT_CSS } from "../design/theme.ts";
import { withRestore } from "../explain/cause.ts";
import { CAUSES_SQL, causeOf } from "../explain/explain.ts";
import { DriftWorld } from "../engine/world.ts";
import { readDnsInventory, type DnsInventoryCheck } from "../loop/pass.ts";
import { CLASS_LABEL, classLabel, tail, thousands } from "../loop/present.ts";
import type { FindingSummary } from "../catalogue/select.ts";
import { shortFindingId } from "../pipeline.ts";
import { DQ_RULES } from "../zetaris/setup.ts";
import { verify } from "../receipts/bundle.ts";
import type { Tracer } from "../trace.ts";
import { CHART_CSS, barChart, dayLong, lineChart, type Fill, type Series } from "./charts.ts";
import type { DocumentData } from "./render.ts";
import { STACK_LINE, escapeHtml, tileFacts, utc } from "./report.ts";
import { KIND_WORD, STATUS_WORD, SURFACES, gateWhy, policyOf, surfaceName } from "./words.ts";

type Row = Readonly<Record<string, string>>;

export type Period = "7d" | "30d" | "all";
export const PERIODS: readonly Period[] = ["7d", "30d", "all"];
export const isPeriod = (s: unknown): s is Period => typeof s === "string" && (PERIODS as readonly string[]).includes(s);
/** A period in words, as the header and the switch write it. */
export const PERIOD_WORD: Readonly<Record<Period, string>> = { "7d": "the last 7 days", "30d": "the last 30 days", all: "every day on record" };
export const PERIOD_SHORT: Readonly<Record<Period, string>> = { "7d": "7 days", "30d": "30 days", all: "All" };
/** The file's budget with the sample data. */
export const EXECUTIVE_MAX_BYTES = 400_000;
/** Incident cards shown; the rest are counted in one line. */
export const INCIDENTS_SHOWN = 8;
/** What the agent did, lines per card. */
const DID_SHOWN = 6;
const DAY_MS = 86_400_000;
const MAX_ROWS = 100_000;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n: number, one: string, many = `${one}s`): string => `${thousands(n)} ${n === 1 ? one : many}`;
const dayOf = (iso: string): string => iso.slice(0, 10);
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
const VERB_ORDER = ["ESCALATE", "FIX", "ROLLBACK", "HOLD", "ADOPT"] as const;
const VERB_FILL: Readonly<Record<string, Fill>> = { ESCALATE: "need", FIX: "need", ROLLBACK: "ok", HOLD: "hold", ADOPT: "adopted" };
const KIND_ORDER = ["rollback_file", "revert_record", "investigate", "fix"];
const STATUS_ORDER = ["done", "unverified", "failed", "refused", "not_judged"];
const STATUS_FILL: Readonly<Record<string, Fill>> = { done: "ok", unverified: "hold", failed: "need", refused: "muted", not_judged: "adopted" };
const WRITES = ["rollback_file", "revert_record"];

/** The period's UTC days, the last one the instant's; `from` is 00:00 UTC of the first. "all" starts at the earliest row's day. */
export function periodDays(period: Period, at: string, earliest: string | null): { from: string; days: string[] } {
  const last = dayOf(at);
  const first = period === "all" ? (earliest && dayOf(earliest) < last ? dayOf(earliest) : last) : addDays(last, -(period === "7d" ? 6 : 29));
  const days: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) days.push(d);
  return { from: `${first}T00:00:00.000Z`, days };
}

/** A span of time in its largest two units: "under 1 min", "42 min", "3 h 12 min", "2 d 4 h". */
export function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "under 1 min";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}

/** The middle of a list of numbers; the mean of the two middle ones for an even count; null for none. */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---- the eval's receipts -----------------------------------------------------------------------------------------

const RUN_FILE = /^C(\d+)-run(\d+)\.json$/;

export interface EvalReceipts {
  /** The results directory as the page names it: eval/results/<stamp>. */
  dir: string;
  stamp: string;
  set: string;
  /** The Nemotron calls the run files record, and those whose receipt signature they record as verified. */
  calls: number;
  signed: number;
  /** npm run receipts:verify over the directory: receipt ids named, receipts in receipts.json, withheld, signatures verified, mismatches. */
  wanted: number;
  receipts: number;
  withheld: number;
  verified: number;
  mismatches: number;
  /** Ultra alone (direct: ultra) beside the checks with Ultra as the falsifier (judge: ultra over a model's selection), per run. */
  headline: {
    alone: { config: string; runs: { run: number; readYes: number; labelledNo: number }[] };
    checks: { config: string; runs: { run: number; readYes: number; labelledNo: number; struck: number; claims: number }[] };
  } | null;
}

/** The lexically newest directory under `base` that holds planted.json and a C*-run*.json, as the replay page picks it. */
export function newestEvalDir(base: string): string | null {
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base)
    .filter((d) => statSync(path.join(base, d)).isDirectory())
    .filter((d) => existsSync(path.join(base, d, "planted.json")) && readdirSync(path.join(base, d)).some((f) => RUN_FILE.test(f)))
    .sort();
  return dirs.length ? path.join(base, dirs[dirs.length - 1]) : null;
}

interface RunFile {
  config: { id: string; direct?: string | null; judge?: string | null; select?: { kind?: string } | null };
  run: number; set: string;
  counts: { calls: number; false_positives: number; labelled_no: number };
  calls: { signature_ok?: boolean | null }[];
}
interface PlantedFile { claims: { config: string; run: number; struck?: boolean; status?: string }[] }

/** A directory's modification time; -1 when it is not there. Adding, removing or renaming an entry moves it. */
const mtimeOf = (p: string): number => { try { return statSync(p).mtimeMs; } catch { return -1; } };

/** The last read of each results base: the directories whose modification times it rests on, and what was read. */
const receiptsCache = new Map<string, { watch: readonly (readonly [string, number])[]; value: EvalReceipts | null }>();
/** How many times evalReceipts listed a results base and read its newest directory; a request the cache answers adds none. */
export const evalScans = { count: 0 };

/**
 * The newest eval results under `root`/eval/results as the receipts section reads them; null when there are none.
 * The base is listed and the newest directory read once, then again only when a modification time it rests on moves:
 * the base's (a results directory added, removed or renamed), the newest directory's (a file in it added, removed or
 * renamed) and each later directory's, one the runner is still filling. A request the cache answers costs those stats
 * and no listing. The eval runner writes a results directory once and never edits a file in place.
 */
export function evalReceipts(root: string): EvalReceipts | null {
  const base = path.join(root, "eval", "results");
  const known = receiptsCache.get(base);
  if (known && known.watch.every(([p, m]) => mtimeOf(p) === m)) return known.value;
  evalScans.count++;
  const baseTime = mtimeOf(base);
  const dir = newestEvalDir(base);
  const later = baseTime < 0 ? [] : readdirSync(base).filter((d) => (!dir || d > path.basename(dir)) && statSync(path.join(base, d)).isDirectory()).map((d) => path.join(base, d));
  const value = dir ? readEvalDir(dir) : null;
  receiptsCache.set(base, { watch: [[base, baseTime], ...[...(dir ? [dir] : []), ...later].map((p) => [p, mtimeOf(p)] as const)], value });
  return value;
}

/** One results directory as the receipts section reads it; null when its files do not parse. */
function readEvalDir(dir: string): EvalReceipts | null {
  const stamp = path.basename(dir);
  let value: EvalReceipts | null = null;
  try {
    const runs = readdirSync(dir).filter((f) => RUN_FILE.test(f)).sort().map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as RunFile);
    const planted = JSON.parse(readFileSync(path.join(dir, "planted.json"), "utf8")) as PlantedFile;
    const v = verify(dir);
    const alone = runs.find((r) => r.config.direct === "ultra")?.config.id;
    const checked = runs.find((r) => r.config.judge === "ultra" && r.config.select?.kind === "model")?.config.id;
    const runsOf = (id: string) => runs.filter((r) => r.config.id === id).sort((a, b) => a.run - b.run).map((r) => ({ run: r.run, readYes: r.counts.false_positives, labelledNo: r.counts.labelled_no }));
    value = {
      dir: `eval/results/${stamp}`, stamp, set: runs[0]?.set ?? "",
      calls: runs.reduce((n, r) => n + r.counts.calls, 0), signed: runs.reduce((n, r) => n + r.calls.filter((c) => c.signature_ok === true).length, 0),
      wanted: v.wanted, receipts: v.receipts, withheld: v.withheld, verified: v.verified, mismatches: v.failures.length,
      headline: alone && checked ? {
        alone: { config: alone, runs: runsOf(alone) },
        checks: {
          config: checked,
          runs: runsOf(checked).map((x) => {
            const p = planted.claims.filter((c) => c.config === checked && c.run === x.run);
            return { ...x, struck: p.filter((c) => c.struck ?? c.status === "refuted").length, claims: p.length };
          }),
        },
      } : null,
    };
  } catch {
    value = null;
  }
  return value;
}

// ---- the reads ---------------------------------------------------------------------------------------------------

const DISPOSITIONS_OF_TENANT_SQL = `SELECT disposition_id, finding_id, surface, host, object_id, setting_path, verb, reason, decided_by, rule_id, decided_at
FROM {{t:disposition}}
WHERE tenant_id = {{p:tenant_id}}
ORDER BY decided_at, disposition_id`;

const PROBES_IN_PERIOD_SQL = `SELECT kind, target, status, observed_at
FROM {{t:probe}}
WHERE tenant_id = {{p:tenant_id}} AND observed_at >= {{p:from_at}} AND observed_at <= {{p:to_at}}
ORDER BY observed_at, probe_id`;

const APPROVALS_OF_TENANT_SQL = `SELECT surface, host, object_id, setting_path, approved_at
FROM {{t:approved_setting}}
WHERE tenant_id = {{p:tenant_id}}
ORDER BY approved_at, approval_id`;

const OBJECTS_OF_RUN_SQL = `SELECT DISTINCT surface, host, object_id
FROM {{t:observation}}
WHERE run_id = {{p:run_id}}`;

const RECORD_SQL = `SELECT record_id, zone, name, type, observed_at
FROM {{t:dns_record}}
WHERE tenant_id = {{p:tenant_id}} AND record_id = {{p:record_id}}
ORDER BY observed_at, run_id`;

const ADOPTIONS_IN_PERIOD_SQL = `SELECT a.decided_at AS decided_at, CASE WHEN ${EXCEPTION_IN_FORCE} THEN 1 ELSE 0 END AS in_force
FROM (${ADOPTION_SQL}) a
WHERE a.tenant_id = {{p:tenant_id}} AND a.decided_at >= {{p:from_at}} AND a.decided_at <= {{p:to_at}}`;

/** The tenant's rows the report reads beside the owner's document's. */
export interface ExecutiveRows {
  dispositions: Row[];
  probes: Row[];
  approvals: Row[];
  /** Each object of the latest passing runs (the document's shapes), surface, host and object_id. */
  objects: Row[];
  causes: FindingCause[];
  /** The latest row of each DNS record an incident names. */
  records: Map<string, Row>;
  /** The ADOPTs under an exception in the period with in_force 1 or 0; null with the reason when they were not read (no lesson table). */
  adoptions: Row[] | null;
  adoptionsError: string | null;
  /** The DQ rule dns_inventory_current over the provider now (src/loop/pass.ts readDnsInventory), read on Zetaris for a tenant with a DNS run; null with the reason otherwise. */
  dns: DnsInventoryCheck | null;
  dnsWhy: string | null;
  queries: number;
}

export interface ExecutiveOptions {
  tenant: string;
  period: Period;
  /** The end of the period. */
  at: string;
  /** The finding classes a pass knows, by finding id; a disposition the map lacks reads its class off its reason. */
  classes?: ReadonlyMap<string, string>;
  receipts?: EvalReceipts | null;
  tracer?: Tracer;
}

/** The incidents' finding ids: a disposition of the period ESCALATE, FIX or ROLLBACK, an action of the period on one of its dispositions, or a ticket updated in it. */
function incidentIds(doc: DocumentData, dispositions: readonly Row[], from: string, at: string): Set<string> {
  const inPeriod = (s: string | undefined): boolean => !!s && s >= from && s <= at;
  const ids = new Set(dispositions.filter((d) => inPeriod(d.decided_at) && ["ESCALATE", "FIX", "ROLLBACK"].includes(d.verb)).map((d) => d.finding_id));
  const findingOf = new Map(dispositions.map((d) => [d.disposition_id, d.finding_id]));
  for (const a of doc.actions ?? []) if (inPeriod(a.started_at) && findingOf.has(a.disposition_id)) ids.add(findingOf.get(a.disposition_id)!);
  for (const x of doc.tickets) if (inPeriod(x.updated_at)) ids.add(x.finding_id);
  return ids;
}

/** The report's own reads over the layer, beside the document's rows. */
export async function readExecutiveRows(layer: DataLayer, doc: DocumentData, o: { tenant: string; from: string; at: string; tracer?: Tracer }): Promise<ExecutiveRows> {
  let queries = 0;
  const q = async (sql: string, params: Record<string, string>): Promise<Row[]> => {
    queries++;
    const r = await layer.run(sql, params, { tracer: o.tracer, agent: "executive", limit: MAX_ROWS });
    if (r.total > r.rowCount) throw new Error(`executive: a read returned ${r.total} rows, more than the ${MAX_ROWS} the report reads`);
    return objects(r);
  };
  const t = { tenant_id: o.tenant };
  const span = { ...t, from_at: o.from, to_at: o.at };
  const [dispositions, probes, approvals, causes] = await Promise.all([
    q(DISPOSITIONS_OF_TENANT_SQL, t), q(PROBES_IN_PERIOD_SQL, span), q(APPROVALS_OF_TENANT_SQL, t), q(CAUSES_SQL, t).then((rs) => rs.map(causeOf)),
  ]);
  const objectRows: Row[] = [];
  for (const s of doc.shapes) objectRows.push(...await q(OBJECTS_OF_RUN_SQL, { run_id: s.run_id }));
  let adoptions: Row[] | null = null;
  let adoptionsError: string | null = null;
  try {
    adoptions = await q(ADOPTIONS_IN_PERIOD_SQL, span);
  } catch (e) {
    adoptionsError = (e as Error).message.split("\n")[0].slice(0, 200);
  }
  const incidents = incidentIds(doc, dispositions, o.from, o.at);
  const recordIds = [...new Set(dispositions.filter((d) => incidents.has(d.finding_id) && d.surface === "cloudflare.dns").map((d) => d.object_id))].sort(cmp);
  const records = new Map<string, Row>();
  for (const id of recordIds) {
    const r = (await q(RECORD_SQL, { ...t, record_id: id })).at(-1);
    if (r) records.set(id, r);
  }
  // dns_inventory_current reads the Cloudflare DNS API now, through Zetaris's REST tables: nothing to read on sql.js
  let dns: DnsInventoryCheck | null = null;
  let dnsWhy: string | null = null;
  if (layer.engine.name !== "zetaris") dnsWhy = "the rule reads the Cloudflare DNS API live through Zetaris, and the recorded bundle holds no live read";
  else if (!doc.runs.some((r) => r.surface === "cloudflare.dns")) dnsWhy = `${o.tenant} has no cloudflare.dns run to hold the provider to`;
  else {
    queries++;
    dns = await readDnsInventory(layer, o.tracer);
  }
  return { dispositions, probes, approvals, objects: objectRows, causes, records, adoptions, adoptionsError, dns, dnsWhy, queries };
}

// ---- the numbers -------------------------------------------------------------------------------------------------

export interface Incident {
  finding_id: string;
  /** The verbs the period decided on it, in order, each once. */
  verbs: string[];
  /** The class in plain words; null when neither a pass nor the reason names it. */
  what: string | null;
  where: string;
  first: string;
  last: string;
  cause: string | null;
  did: string[];
  /** Each ticket: its number and its type and status. */
  tickets: { ref: string; text: string }[];
}

export interface DqRow { rule: string; table: string; text: string; holds: boolean | null }

export interface Executive {
  tenant: string;
  period: Period;
  at: string;
  from: string;
  days: string[];
  source: string | null;
  kpis: {
    settings: number;
    objects: number;
    covered: number;
    copies: { valid: number; total: number; ok: number; gaps: number; fail: number; none: number };
    driftEvents: number;
    decided: number;
    detection: { medianMs: number | null; timed: number; causes: number };
    actions: { total: number; byStatus: { status: string; n: number }[] };
  };
  charts: {
    findings: { series: Series[]; values: number[][] };
    actions: { series: Series[]; values: number[][] };
    probes: { series: Series[]; values: number[][]; probed: number[] };
    approvals: { daily: number[]; cumulative: number[] };
  };
  incidents: Incident[];
  incidentCount: number;
  sources: { name: string; holds: string; runs: number; passing: number; latest: string; last: string | null; passes: boolean; why: string | null }[];
  dq: DqRow[];
  receipts: EvalReceipts | null;
  /** The receipt ids the tenant's actions of the period name. */
  actionReceipts: number;
  policy: { version: number; rules: number } | null;
}

/** Builds a finding's World Model id (DriftWorld.findingId reads only its argument); one instance for the process. */
let idWorld: DriftWorld | null = null;

/**
 * A disposition's finding class from its own columns, for a finding no pass of this run raises. The finding id is
 * shortFindingId over the World Model's id (tenant, class, host, object, setting, record: src/engine/world.ts
 * findingId), and the disposition carries every part but the class and the record: the class is the one of
 * CLASS_LABEL whose id, with no record or with the object as the record, is the disposition's finding_id. Null when
 * none is; the reason's text is never read.
 */
export function classOfFinding(d: { tenant_id: string; finding_id: string; host: string | null; object_id: string; setting_path: string }): string | null {
  idWorld ??= new DriftWorld("executive-ids");
  for (const cls of Object.keys(CLASS_LABEL)) {
    for (const resource of [null, d.object_id]) {
      const id = idWorld.findingId({ tenant_id: d.tenant_id, class: cls as FindingSummary["class"], host: d.host || null, object_id: d.object_id, setting_path: d.setting_path, resource_id: resource });
      if (shortFindingId(id) === d.finding_id) return cls;
    }
  }
  return null;
}

/** What each DQ rule is read over in the report: the period's runs, copies, actions and causes, and the reads beside them. */
interface DqInput {
  runs: DocumentData["runs"];
  copies: Executive["kpis"]["copies"];
  actions: readonly Action[];
  causes: readonly FindingCause[];
  rows: Pick<ExecutiveRows, "adoptions" | "adoptionsError" | "dns" | "dnsWhy">;
}

/** Each DQ rule's reading, by its name in DQ_RULES (src/zetaris/setup.ts); a rule with none reads "not read". */
const DQ_READS: Readonly<Record<string, (x: DqInput) => Pick<DqRow, "text" | "holds">>> = {
  run_complete: ({ runs }) => ({ text: `${thousands(runs.filter((r) => r.passes).length)} of ${plural(runs.length, "collection run")} started in the period pass: the run read every object it set out to read`, holds: runs.every((r) => r.passes) }),
  copy_validated: ({ copies: c }) => ({ text: c.total ? `${thousands(c.total - c.none)} of ${plural(c.total, "vault copy", "vault copies")} at the heads validated: ${thousands(c.ok)} ok, ${thousands(c.gaps)} ok with gaps, ${thousands(c.fail)} fail` : "the vault holds no copy for the tenant", holds: c.total > 0 && c.none === 0 }),
  action_verified: ({ actions }) => {
    const verified = actions.filter((a) => !WRITES.includes(a.kind) || ["failed", "refused", "not_judged"].includes(a.status) || a.verification !== "");
    return { text: `${thousands(verified.length)} of ${plural(actions.length, "action")} of the period hold it: every completed write carries a verification probe`, holds: verified.length === actions.length };
  },
  cause_evidenced: ({ causes }) => {
    const evidenced = causes.filter((x) => x.class === "unknown" || x.evidence_ids !== "[]");
    return { text: `${thousands(evidenced.length)} of ${plural(causes.length, "cause")} of the period name their evidence or read unknown`, holds: evidenced.length === causes.length };
  },
  exception_in_force: ({ rows }) => {
    if (!rows.adoptions) return { text: rows.adoptionsError ?? "the lesson table is not there", holds: null };
    const inForce = rows.adoptions.filter((a) => a.in_force === "1").length;
    return { text: `${thousands(inForce)} of ${plural(rows.adoptions.length, "ADOPT")} under an accepted exception in the period join a lesson in force`, holds: inForce === rows.adoptions.length };
  },
  dns_inventory_current: ({ rows }) => {
    const d = rows.dns;
    if (!d) return { text: rows.dnsWhy ?? "no live read", holds: null };
    if ("error" in d) return { text: d.error.split("\n")[0].slice(0, 200), holds: null };
    return { text: `${thousands(d.current)} of ${plural(d.live, "record")} at the provider now match the last complete DNS run by type and proxied flag`, holds: d.current === d.live };
  },
};

/** One row per DQ rule of the semantic layer, in DQ_RULES's order, its table the rule's own. */
export function dqRows(x: DqInput, rules: readonly { name: string; table: string }[] = DQ_RULES): DqRow[] {
  return rules.map((r) => ({ rule: r.name, table: r.table, ...(DQ_READS[r.name]?.(x) ?? { text: "the executive report has no reading of this rule", holds: null }) }));
}

const objectKeyOf = (r: Row): string => [r.surface, r.surface === "cloudflare.dns" ? "" : (r.host ?? ""), r.object_id].join("\u001f");

export function executiveOf(doc: DocumentData, rows: ExecutiveRows, o: ExecutiveOptions): Executive {
  const at = o.at;
  const earliest = [
    rows.dispositions[0]?.decided_at, (doc.actions ?? []).map((a) => a.started_at).sort(cmp)[0], rows.probes[0]?.observed_at, rows.approvals[0]?.approved_at,
    doc.runs.map((r) => r.started_at).sort(cmp)[0],
  ].filter((s): s is string => !!s && s <= at).sort(cmp)[0] ?? null;
  const { from, days } = periodDays(o.period, at, earliest);
  const inPeriod = (s: string | null | undefined): boolean => !!s && s >= from && s <= at;
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const tiles = tileFacts(doc);

  // findings: each finding of a day by its last verb that day
  const disp = rows.dispositions.filter((d) => inPeriod(d.decided_at));
  const firstOf = new Map<string, string>();
  for (const d of rows.dispositions) if (!firstOf.has(d.finding_id)) firstOf.set(d.finding_id, d.decided_at);
  const lastOfDay = new Map<string, Row>();
  for (const d of disp) lastOfDay.set(`${dayOf(d.decided_at)}\u001f${d.finding_id}`, d);
  const verbs = VERB_ORDER.filter((v) => disp.some((d) => d.verb === v));
  const findingSeries: Series[] = verbs.map((v) => ({ key: v, label: v, fill: VERB_FILL[v] }));
  const findingValues = days.map(() => verbs.map(() => 0));
  for (const d of lastOfDay.values()) {
    const i = dayIndex.get(dayOf(d.decided_at));
    const j = (verbs as readonly string[]).indexOf(d.verb);
    if (i !== undefined && j >= 0) findingValues[i][j]++;
  }

  // actions: by kind and status
  const actions: Action[] = (doc.actions ?? []).map(actionOf).filter((a) => inPeriod(a.started_at)).sort((a, b) => cmp(a.started_at, b.started_at) || cmp(a.action_id, b.action_id));
  const rank = (xs: readonly string[], x: string): number => (xs.includes(x) ? xs.indexOf(x) : xs.length);
  const combos = [...new Set(actions.map((a) => `${a.kind}\u001f${a.status}`))].map((k) => k.split("\u001f") as [string, string])
    .sort((a, b) => rank(KIND_ORDER, a[0]) - rank(KIND_ORDER, b[0]) || cmp(a[0], b[0]) || rank(STATUS_ORDER, a[1]) - rank(STATUS_ORDER, b[1]) || cmp(a[1], b[1]));
  const actionSeries: Series[] = combos.map(([k, s]) => ({ key: `${k} ${s}`, label: `${KIND_WORD[k] ?? k}, ${STATUS_WORD[s] ?? s}`, fill: STATUS_FILL[s] ?? "muted" }));
  const actionValues = days.map(() => combos.map(() => 0));
  for (const a of actions) {
    const i = dayIndex.get(dayOf(a.started_at));
    const j = combos.findIndex(([k, s]) => k === a.kind && s === a.status);
    if (i !== undefined && j >= 0) actionValues[i][j]++;
  }

  // failing probes: each kind and name that failed at least once that day; beside it the names probed that day
  const probes = rows.probes.filter((p) => inPeriod(p.observed_at));
  const kinds = [...new Set(probes.filter((p) => p.status === "fail").map((p) => p.kind))].sort(cmp);
  const failed = days.map(() => kinds.map(() => new Set<string>()));
  const probedSets = days.map(() => new Set<string>());
  for (const p of probes) {
    const i = dayIndex.get(dayOf(p.observed_at));
    if (i === undefined) continue;
    probedSets[i].add(`${p.kind}\u001f${p.target}`);
    if (p.status === "fail") failed[i][kinds.indexOf(p.kind)].add(p.target);
  }

  // approvals: the settings with an approval of record at the end of each day, and the approvals recorded that day
  const firstApproval = new Map<string, string>();
  for (const a of rows.approvals) {
    const k = `${objectKeyOf(a)}\u001f${a.setting_path}`;
    if (!firstApproval.has(k) || a.approved_at < firstApproval.get(k)!) firstApproval.set(k, a.approved_at);
  }
  const firsts = [...firstApproval.values()].filter((s) => s <= at).sort(cmp);
  const cumulative = days.map((d) => firsts.filter((s) => dayOf(s) <= d).length);
  const daily = days.map((d) => rows.approvals.filter((a) => a.approved_at <= at && dayOf(a.approved_at) === d).length);

  // coverage: the objects of the latest passing runs with an approval of record
  const objectsSeen = new Set(rows.objects.map(objectKeyOf));
  const approved = new Set(rows.approvals.map(objectKeyOf));
  const covered = [...objectsSeen].filter((k) => approved.has(k)).length;

  // change to detection: each cause with the time of the change, to the first decision on its finding at or after it
  const periodFindings = new Set(disp.map((d) => d.finding_id));
  const causes = rows.causes.filter((c) => periodFindings.has(c.finding_id) && inPeriod(c.decided_at));
  const byFinding = new Map<string, string[]>();
  for (const d of rows.dispositions) byFinding.set(d.finding_id, [...(byFinding.get(d.finding_id) ?? []), d.decided_at]);
  const lags = causes.flatMap((c) => {
    if (!c.occurred_at) return [];
    const seen = (byFinding.get(c.finding_id) ?? []).filter((s) => s >= c.occurred_at!).sort(cmp)[0] ?? c.decided_at;
    const lag = Date.parse(seen) - Date.parse(c.occurred_at);
    return Number.isFinite(lag) && lag >= 0 ? [lag] : [];
  });

  // incidents
  const ids = incidentIds(doc, rows.dispositions, from, at);
  const allActions = (doc.actions ?? []).map(actionOf);
  const incidents: Incident[] = [...ids].map((id) => {
    const mine = disp.filter((d) => d.finding_id === id);
    const all = rows.dispositions.filter((d) => d.finding_id === id);
    const last = (mine.length ? mine : all).at(-1)!;
    const dispIds = new Set(all.map((d) => d.disposition_id));
    const own = allActions.filter((a) => dispIds.has(a.disposition_id) && inPeriod(a.started_at)).sort((a, b) => cmp(a.started_at, b.started_at) || cmp(a.action_id, b.action_id));
    const cls = o.classes?.get(id) ?? classOfFinding({ tenant_id: o.tenant, finding_id: id, host: last.host || null, object_id: last.object_id, setting_path: last.setting_path });
    const record = last.surface === "cloudflare.dns" ? rows.records.get(last.object_id) : undefined;
    const setting = last.setting_path && last.setting_path !== "file" ? ` (${last.setting_path})` : "";
    const where = last.surface === "cloudflare.dns"
      ? `DNS record ${record?.name ?? last.object_id}${setting}${record?.zone ? ` · zone ${record.zone}` : ""}`
      : `${tail(last.object_id)}${setting}${last.host ? ` · ${last.host}` : ""}`;
    const cause = rows.causes.filter((c) => c.finding_id === id).sort((a, b) => cmp(a.decided_at, b.decided_at) || cmp(a.cause_id, b.cause_id)).at(-1);
    const did = own.map((a) => {
      const probes = a.verification.split(",").filter(Boolean).length;
      const receipts = a.receipts.split(",").filter(Boolean).length;
      return `${utc(a.started_at)}: ${KIND_WORD[a.kind] ?? a.kind}, ${STATUS_WORD[a.status] ?? a.status}${probes ? `, ${plural(probes, "verification probe")}` : ""}${receipts ? `, ${plural(receipts, "receipt")}` : ""}`;
    });
    const verbsSeen = [...new Set((mine.length ? mine : [last]).map((d) => d.verb))];
    const shown = did.length > DID_SHOWN ? [...did.slice(0, DID_SHOWN - 1), `and ${did.length - DID_SHOWN + 1} more actions`] : did;
    return {
      finding_id: id, verbs: verbsSeen, what: cls ? classLabel(cls) : null, where, first: (mine[0] ?? last).decided_at, last: last.decided_at,
      cause: cause ? withRestore(cause, allActions) : null,
      did: shown.length ? shown : [verbsSeen.includes("ESCALATE") && !verbsSeen.some((v) => v === "ROLLBACK" || v === "FIX") ? "The agent changed nothing: an escalation goes to a technician." : "No action of the period is recorded for it."],
      tickets: doc.tickets.filter((x) => x.finding_id === id).sort((a, b) => Number(a.external_id || 0) - Number(b.external_id || 0)).map((x) => ({ ref: x.external_id ? `#${x.external_id}` : x.ticket_id, text: `${x.type}, ${x.priority}, ${x.status}` })),
    };
  }).sort((a, b) => cmp(b.last, a.last) || cmp(a.finding_id, b.finding_id));

  // sources: each surface and host, its runs of the period and its latest run
  const bySource = new Map<string, DocumentData["runs"]>();
  for (const r of doc.runs) bySource.set(`${r.surface}\u001f${r.host}`, [...(bySource.get(`${r.surface}\u001f${r.host}`) ?? []), r]);
  const srank = (s: string): number => SURFACES[s]?.rank ?? 99;
  const sources = [...bySource.values()].map((rs) => {
    const latest = rs.at(-1)!;
    const period = rs.filter((r) => inPeriod(r.started_at));
    return {
      name: surfaceName(latest), holds: SURFACES[latest.surface]?.holds ?? "", runs: period.length, passing: period.filter((r) => r.passes).length,
      latest: `${thousands(Number(latest.observed_count) || 0)} of ${latest.expected_count ? thousands(Number(latest.expected_count)) : "?"}`, last: latest.finished_at || null,
      passes: latest.passes, why: latest.passes ? null : gateWhy(latest), surface: latest.surface, host: latest.host,
    };
  }).sort((a, b) => srank(a.surface) - srank(b.surface) || cmp(a.surface, b.surface) || cmp(a.host, b.host)).map(({ surface: _s, host: _h, ...rest }) => rest);

  // every DQ rule of the semantic layer, in its order, each read over the tenant's rows of the period (DQ_READS)
  const dq = dqRows({ runs: doc.runs.filter((r) => inPeriod(r.started_at)), copies: tiles.copies, actions, causes, rows });

  const byStatus = STATUS_ORDER.map((s) => ({ status: s, n: actions.filter((a) => a.status === s).length }));
  return {
    tenant: o.tenant, period: o.period, at, from, days, source: doc.source,
    kpis: {
      settings: tiles.settings.settings, objects: objectsSeen.size, covered, copies: tiles.copies,
      driftEvents: [...periodFindings].filter((id) => inPeriod(firstOf.get(id))).length, decided: periodFindings.size,
      detection: { medianMs: median(lags), timed: lags.length, causes: causes.length },
      actions: { total: actions.length, byStatus },
    },
    charts: {
      findings: { series: findingSeries, values: findingValues },
      actions: { series: actionSeries, values: actionValues },
      probes: { series: kinds.map((k, i) => ({ key: k, label: k, fill: (["need", "hold", "locked", "adopted"] as const)[i % 4] })), values: failed.map((r) => r.map((s) => s.size)), probed: probedSets.map((s) => s.size) },
      approvals: { daily, cumulative },
    },
    incidents: incidents.slice(0, INCIDENTS_SHOWN), incidentCount: incidents.length, sources, dq,
    receipts: o.receipts ?? null,
    actionReceipts: new Set(actions.flatMap((a) => a.receipts.split(",").map((s) => s.trim()).filter(Boolean))).size,
    policy: policyOf(doc.rules),
  };
}

/** The reads, then the numbers: what the page and the file render from. */
export async function readExecutive(layer: DataLayer, doc: DocumentData, o: ExecutiveOptions): Promise<Executive & { queries: number }> {
  const rows = await readExecutiveRows(layer, doc, { tenant: o.tenant, from: o.period === "all" ? "" : periodDays(o.period, o.at, null).from, at: o.at, tracer: o.tracer });
  return { ...executiveOf(doc, rows, o), queries: rows.queries };
}

// ---- the page ----------------------------------------------------------------------------------------------------

export interface ExecutiveContext {
  /** Every data string passes it before it is escaped. */
  redactor: { text(s: string): string };
  agent?: string;
  /** The policy file the rules were loaded from, as the footer names it. */
  policyFile?: string | null;
  /** In sample mode, the bundle the rows come from. */
  bundle?: { path: string; sha256: string } | null;
  /** The repository's tip commit, live. */
  tip?: string | null;
  /** Where a finding id links in the console (its Findings entry); none in the file. */
  findingHref?: (findingId: string) => string | null;
}

const tileHtml = (k: string, v: string, s: string): string => `<div class="tile"><span class="k">${k}</span><span class="v">${v}</span><p class="s">${s}</p></div>`;

function kpisHtml(x: Executive, t: (s: string | number) => string): string {
  const k = x.kpis;
  const pct = (a: number, b: number): string => (b ? `${Math.round((a / b) * 100)}%` : "-");
  const d = k.detection;
  const c = k.copies;
  /** A tile: its key and sub line as text, its value as HTML (a count, or a count and its total). */
  const tile = (key: string, v: string, sub: string): string => tileHtml(t(key), v, t(sub));
  const of = (a: number, b: number): string => `${thousands(a)} <small>of ${thousands(b)}</small>`;
  return `<div class="ex-kpis">
${tile("Settings watched", thousands(k.settings), `in ${plural(k.objects, "object")} of the latest passing runs`)}
${tile("Coverage", of(k.covered, k.objects), `objects with an approval of record, ${pct(k.covered, k.objects)}`)}
${tile("Copies with a valid restore", of(c.valid, c.total), c.total ? `${thousands(c.ok)} ok · ${thousands(c.gaps)} with gaps · ${thousands(c.fail)} fail${c.none ? ` · ${thousands(c.none)} not validated` : ""}` : "no copy in the vault")}
${tile("Drift events", thousands(k.driftEvents), `findings first raised in the period; ${plural(k.decided, "finding")} with a decision in it`)}
${tile("Change to detection", d.medianMs === null ? "-" : t(duration(d.medianMs)), !d.causes
    ? "no cause of the period is recorded: the explain step records one for each finding it explains"
    : d.medianMs === null
      ? `none of the period's ${plural(d.causes, "cause")} carries the time of the change`
      : `median over ${plural(d.timed, "cause")} with the time of the change, of ${plural(d.causes, "cause")} in the period`)}
${tile("Actions", thousands(k.actions.total), k.actions.byStatus.map((s) => `${s.status.replace(/_/g, " ")} ${thousands(s.n)}`).join(" · "))}
</div>`;
}

function chartsHtml(x: Executive, t: (s: string | number) => string): [string, string] {
  const ts = (s: string): string => t(s);
  const ch = x.charts;
  const first = [
    barChart({ id: "ex-findings", title: "Findings per day by verb", caption: "Each finding with a decision that day, by its last verb of the day.", y: "Findings", days: x.days, series: ch.findings.series, values: ch.findings.values, seriesHead: "Verb" }, ts),
    barChart({ id: "ex-actions", title: "Actions per day by kind and status", caption: "Each action the Actor recorded that day, by kind and status.", y: "Actions", days: x.days, series: ch.actions.series, values: ch.actions.values, seriesHead: "Kind and status" }, ts),
  ];
  const second = [
    barChart({ id: "ex-probes", title: "Failing probes per day", caption: "Each name that failed a probe of a kind at least once that day, by kind.", y: "Failing names", days: x.days, series: ch.probes.series, values: ch.probes.values, extra: { label: "Names probed", values: ch.probes.probed }, seriesHead: "Kind" }, ts),
    lineChart({ id: "ex-approvals", title: "Approvals over time", caption: "Settings with an approval of record at the end of each day.", y: "Settings approved", days: x.days, values: ch.approvals.cumulative, daily: { label: "Approvals recorded", values: ch.approvals.daily }, label: "Settings with an approval", none: "approval" }, ts),
  ];
  const pair = (xs: string[]): string => `<div class="ex-grid">${xs.map((c) => `<div class="card">${c}</div>`).join("\n")}</div>`;
  return [pair(first), pair(second)];
}

function incidentsHtml(x: Executive, t: (s: string | number) => string, ctx: ExecutiveContext): string {
  if (!x.incidents.length) return `<p class="calm">No finding of the period was escalated, rolled back or set for a fix, and no action or ticket names one.</p>`;
  const cards = x.incidents.map((i) => {
    const href = ctx.findingHref?.(i.finding_id) ?? null;
    const id = href ? `<a href="${escapeHtml(href)}" class="mono">${t(i.finding_id)}</a>` : `<span class="mono">${t(i.finding_id)}</span>`;
    return `<article class="card ex-inc">
<h3>${i.verbs.map((v) => `<span class="badge v-${t(v)}">${t(v)}</span>`).join("")}${t(i.what ? i.what.replace(/^./, (c) => c.toUpperCase()) : "A finding")}</h3>
<p class="where">${t(i.where)}</p>
<dl class="ex-kv">
<dt>Cause</dt><dd>${i.cause ? t(i.cause) : `<span class="muted">No cause is recorded for it.</span>`}</dd>
<dt>The agent</dt><dd>${i.did.length > 1 ? `<ul>${i.did.map((l) => `<li>${t(l)}</li>`).join("")}</ul>` : t(i.did[0])}</dd>
<dt>Ticket</dt><dd>${i.tickets.length ? i.tickets.map((k) => `${t(k.ref)} <span class="muted">${t(k.text)}</span>`).join(", ") : `<span class="muted">none</span>`}</dd>
</dl>
<p class="fid">${t(`decided ${i.first === i.last ? utc(i.last) : `${utc(i.first)} to ${utc(i.last)}`}`)} · ${id}</p>
</article>`;
  });
  const more = x.incidentCount - x.incidents.length;
  return `<div class="ex-incs">
${cards.join("\n")}
</div>${more > 0 ? `\n<p class="muted">${t(`${thousands(x.incidents.length)} of ${plural(x.incidentCount, "incident")} shown, the newest first.`)}</p>` : ""}`;
}

function sourcesHtml(x: Executive, t: (s: string | number) => string): string {
  const rows = x.sources.map((s) => `<tr><th scope="row" data-label="Source"><b>${t(s.name)}</b> <span class="muted">${t(s.holds)}</span></th><td class="num" data-label="Runs in the period">${thousands(s.runs)}</td><td class="num" data-label="Pass the gate">${thousands(s.passing)}</td><td data-label="Latest run"><span class="nw">${t(s.latest)}</span>, <span class="nw">${t(utc(s.last))}</span></td><td data-label="DQ gate">${s.passes ? `<span class="pass">passes</span>` : `<span class="fail">fails: ${t(s.why ?? "")}</span>`}</td></tr>`);
  const dq = x.dq.map((d) => `<li><span class="dq ${d.holds === null ? "unread" : d.holds ? "pass" : "fail"}">${d.holds === null ? "not read" : d.holds ? "holds" : "fails"}</span> <code>${t(d.rule)}</code> <span class="muted">on ${t(d.table)}</span>: ${t(d.text)}</li>`);
  return `${x.sources.length ? `<table class="data ex-src"><thead><tr><th scope="col">Source</th><th scope="col" class="num">Runs in the period</th><th scope="col" class="num">Pass the gate</th><th scope="col">Latest run</th><th scope="col">DQ gate</th></tr></thead><tbody>${rows.join("")}</tbody></table>` : `<p class="alert">No collection run of this tenant is on record: nothing is watched.</p>`}
<h3>DQ rules over the period</h3>
<ul class="ex-dq">${dq.join("")}</ul>`;
}

function receiptsHtml(x: Executive, t: (s: string | number) => string): string {
  const r = x.receipts;
  const mine = `<p>${t(`The actions of ${x.tenant} in the period name ${plural(x.actionReceipts, "receipt id")}.`)}</p>`;
  if (!r) return `<p class="muted">No eval results are in eval/results.</p>\n${mine}`;
  const perRun = (xs: [number, number][]): string => (!xs.length ? "-" : xs.every(([, d]) => d === xs[0][1]) ? `${xs.map(([k]) => k).join(", ")} of ${xs[0][1]}` : xs.map(([k, d]) => `${k} of ${d}`).join(", "));
  const runs = (xs: { run: number }[]): string => (xs.length === 1 ? `run ${xs[0].run}` : `runs ${xs.slice(0, -1).map((z) => z.run).join(", ")} and ${xs.at(-1)!.run}`);
  const h = r.headline;
  return `<div class="ex-receipts">
<div class="tile"><span class="k">Receipts verified</span><span class="v">${thousands(r.verified)} <small>of ${thousands(r.receipts)}</small></span><p class="s">${t(`Ed25519 signatures in ${r.dir}, ${plural(r.withheld, "receipt")} withheld, ${plural(r.mismatches, "mismatch", "mismatches")}; ${thousands(r.signed)} of ${plural(r.calls, "Nemotron call")} record a verified signature`)}</p></div>
${h ? `<div class="card ex-head-line"><h3>Ultra alone vs the checks with Ultra as the falsifier</h3>
<ul class="ex-stats">
<li><b>${t(perRun(h.alone.runs.map((z) => [z.readYes, z.labelledNo])))}</b>${t(`items labelled no that Ultra alone (${h.alone.config}) reads as yes, ${runs(h.alone.runs)}`)}</li>
<li><b>${t(perRun(h.checks.runs.map((z) => [z.readYes, z.labelledNo])))}</b>${t(`items labelled no that the checks with Ultra as the falsifier (${h.checks.config}) read as yes, ${runs(h.checks.runs)}`)}</li>
<li><b>${t(perRun(h.checks.runs.map((z) => [z.struck, z.claims])))}</b>${t(`planted false claims struck by ${h.checks.config}, ${runs(h.checks.runs)}`)}</li>
</ul>
<p class="cap">${t(`From ${r.dir}, the ${r.set} set.`)}</p></div>` : ""}
</div>
${mine}`;
}

function footerHtml(x: Executive, t: (s: string | number) => string, ctx: ExecutiveContext): string {
  const lines = [
    `Executive report by ${t(ctx.agent ?? "ConfigLeaf")}${ctx.tip ? ` at tip ${t(ctx.tip)}` : ""} for ${t(x.tenant)}, ${t(PERIOD_WORD[x.period])} to ${t(utc(x.at))}${x.source ? `, read through ${t(x.source)}` : ""}.`,
    x.policy ? `Policy ${t(ctx.policyFile ?? "file not named")}, version ${x.policy.version} (${plural(x.policy.rules, "rule")}).` : "No policy rule governs this tenant: the default decides.",
    `${STACK_LINE}.`,
    ...(ctx.bundle ? [`Rendered in sample mode from ${t(ctx.bundle.path)} (sha256 ${t(ctx.bundle.sha256.replace(/^sha256:/, "").slice(0, 12))}).`] : []),
  ];
  return `<footer class="ex-foot">\n${lines.map((l) => `<p>${l}</p>`).join("\n")}\n</footer>`;
}

/** The report's sections: the header, the KPIs, the charts, the incidents, the sources, the receipts and the footer. */
export function executiveSections(x: Executive, ctx: ExecutiveContext): string {
  const t = (s: string | number): string => escapeHtml(ctx.redactor.text(String(s)));
  const [charts1, charts2] = chartsHtml(x, t);
  const first = x.days[0] ?? dayOf(x.at);
  return `<div class="ex">
<section class="ex-sec" id="summary">
<div class="ex-top"><h1>${t(x.tenant)} · executive report</h1>
<p class="ex-when"><span>${t(PERIOD_WORD[x.period])}</span> <span>${t(dayLong(first))} to ${t(utc(x.at))}</span></p></div>
<h2>At a glance</h2>
${kpisHtml(x, t)}
</section>
<section class="ex-sec" id="trend">
<h2>Findings and actions</h2>
${charts1}
</section>
<section class="ex-sec" id="health">
<h2>Probes and approvals</h2>
${charts2}
</section>
<section class="ex-sec" id="incidents">
<h2>Incidents of the period<span class="cnt">${thousands(x.incidentCount)}</span></h2>
${incidentsHtml(x, t, ctx)}
</section>
<section class="ex-sec" id="sources">
<h2>Sources and DQ gates</h2>
${sourcesHtml(x, t)}
</section>
<section class="ex-sec" id="receipts">
<h2>Receipts</h2>
${receiptsHtml(x, t)}
${footerHtml(x, t, ctx)}
</section>
</div>`;
}

/** The executive report's rules: its grid, its cards and tables, and print on A4 with a page break between sections. */
export const EXECUTIVE_CSS = `${CHART_CSS}
.ex{max-width:1200px}
.ex-sec{margin:0 0 30px}
.ex-sec>h2{margin:24px 0 10px}
.ex-sec>h2 .cnt{font-weight:500;color:var(--muted);font-size:14px;margin-left:6px}
.ex-top{margin:4px 0 6px}
.ex-top h1{margin:0}
.ex-when{display:flex;flex-wrap:wrap;gap:0 14px;color:var(--muted);font-size:var(--t-s);margin:2px 0 0}
.ex-when span:first-child{color:var(--fg);font-weight:600}
.ex-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.tile .v small{font-size:.5em;color:var(--muted);font-weight:500}
.ex-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.ex-incs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.ex-inc h3{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 0}
.ex-inc .where{color:var(--muted);margin:2px 0 6px}
.ex-inc .fid{margin:8px 0 0;font-size:var(--t-xs);color:var(--muted)}
.badge{display:inline-block;vertical-align:1px;font-size:11px;font-weight:700;letter-spacing:.04em;line-height:1.6;padding:0 6px;border-radius:4px;margin-right:6px;background:var(--soft)}
.badge.v-ESCALATE,.badge.v-FIX{color:var(--need);background:var(--need-bg)}
.badge.v-HOLD{color:var(--hold);background:var(--hold-bg)}
.badge.v-ROLLBACK{color:var(--ok);background:var(--ok-bg)}
.badge.v-ADOPT{color:var(--adopted)}
.ex-kv{display:grid;grid-template-columns:7em minmax(0,1fr);gap:4px 12px;margin:0;font-size:var(--t-s)}
.ex-kv dt{color:var(--muted)}
.ex-kv dd{margin:0}
.ex-kv ul{margin:0;padding-left:16px}
table.data.ex-src tbody th{white-space:normal}
.ex-dq{list-style:none;padding:0;margin:6px 0;font-size:var(--t-s)}
.ex-dq li{padding:5px 0;border-bottom:1px solid var(--line)}
.dq{display:inline-block;min-width:5.5em;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.pass,.dq.pass{color:var(--ok)}
.fail,.dq.fail{color:var(--need);font-weight:600}
.dq.unread{color:var(--muted)}
.ex-receipts{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:10px;align-items:start}
.ex-stats{list-style:none;padding:0;margin:8px 0 4px;display:grid;gap:6px}
.ex-stats b{display:block;font-size:var(--t-l);font-variant-numeric:tabular-nums}
.ex-stats li{color:var(--muted);font-size:var(--t-s)}
.ex-stats li b{color:var(--fg)}
.ex-head-line .cap{color:var(--muted);font-size:var(--t-xs);margin:4px 0 0}
.ex-foot{margin:22px 0 0;padding:12px 0 0;border-top:1px solid var(--line);color:var(--muted);font-size:12.5px}
.ex-foot p{margin:2px 0}
@media (max-width:900px){.ex-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.ex-grid,.ex-incs,.ex-receipts{grid-template-columns:1fr}}
@media (max-width:560px){.ex-kpis{grid-template-columns:1fr}.ex-kv{grid-template-columns:1fr}.ex-kv dt{margin-top:4px}}
@page{size:A4;margin:14mm 12mm}
@media print{
.ex-sec{break-before:page}
.ex-sec:first-child{break-before:auto}
.ex-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.ex-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}
.ex-incs{grid-template-columns:repeat(2,minmax(0,1fr))}
.card,.tile,.ex-chart,tr{break-inside:avoid}
h2,h3{break-after:avoid}
.chart{max-height:none}
}`;

/** Only the standalone file's: the page around the sections and its print block. */
const FILE_CSS = `${ROOT_CSS}
${BASE_CSS}
body{--page:1200px}
html{scroll-padding-top:64px}
main.ex-page{max-width:1200px;margin:0 auto;padding:16px 24px 32px}
${EXECUTIVE_CSS}
@media (max-width:640px){main.ex-page{padding:12px 16px 24px}.bar-in{padding:10px 16px}body{font-size:16px}}
@media print{
:root{${PRINT_TOKENS}}
html{scroll-padding-top:0}
body{font-size:10pt}
.bar{display:none}
main.ex-page{max-width:none;padding:0}
details>summary{display:none}
a{text-decoration:none}
}`;

/** The executive report as one standalone file: one inline style block, inline SVG, no script, nothing loaded from outside. */
export function renderExecutive(x: Executive, ctx: ExecutiveContext): string {
  const t = (s: string | number): string => escapeHtml(ctx.redactor.text(String(s)));
  const sum = [
    `<a href="#incidents"${x.incidentCount ? ' class="need"' : ""}><b>${thousands(x.incidentCount)}</b> ${x.incidentCount === 1 ? "incident" : "incidents"}</a>`,
    `<a href="#summary"><b>${thousands(x.kpis.driftEvents)}</b> drift ${x.kpis.driftEvents === 1 ? "event" : "events"}</a>`,
    `<a href="#trend"><b>${thousands(x.kpis.actions.total)}</b> ${x.kpis.actions.total === 1 ? "action" : "actions"}</a>`,
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${t(`${x.tenant} · executive report`)}</title>
<style>
${FILE_CSS}
</style>
</head>
<body>
<header class="bar"><div class="bar-in">
${MARK}
<nav class="sum" aria-label="Summary">${sum.join(" · ")}</nav>
<div class="who"><span><b>${t(x.tenant)}</b></span><span>${t(PERIOD_WORD[x.period])}</span><span>${t(utc(x.at))}</span></div>
</div></header>
<main class="ex-page">
${executiveSections(x, ctx)}
</main>
</body>
</html>
`;
}
