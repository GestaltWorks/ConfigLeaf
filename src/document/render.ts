// The owner's document: one markdown page per tenant, rendered from SQL through one DataLayer, plain, present
// tense, for the MSP's owner and the client's.
//
// Contract: renderDocument(layer, { tenant, classes, source }) runs the reads below through the layer in order and
// returns the markdown and the queries it ran (each name with its runs and rows). Every number printed is a count
// of the rows those queries return at render time, or a value of one of those rows; nothing is typed in. Sections:
//   Estate         the tenant's collection runs and how many pass the DQ gate (RUNS_SQL, RUN_COMPLETE_SQL per run);
//                  the latest passing run of each surface and host with the objects and settings it observed
//                  (DOC_RUN_SHAPE_SQL); one line per host with its inventory addresses, those its latest passing run
//                  observed and the older rows the Store keeps (DOC_INVENTORY_SQL, against that run's started_at);
//                  the zones of the latest passing DNS run with their records (DOC_ZONES_SQL).
//   Copies         the vault copies at the latest commit of each repository, one per host and one for the
//                  account's records, shown per zone, with their latest validation: ok, ok_with_gaps, fail or none,
//                  and every gap named (DOC_COPIES_SQL).
//   Approvals      the objects and settings with an approval of record (LATEST_APPROVALS_SQL), and the settings of
//                  the latest passing runs that a locked rule governs with no approved value (DOC_UNAPPROVED_SQL per
//                  run, POLICY_RULES_SQL, src/policy/resolve.ts).
//   Findings open  the latest disposition of each finding on the latest passing runs (DOC_DISPOSITIONS_OF_RUN_SQL per
//                  run; every pass writes its own row): by class and verb, the drift from approved values, the HOLD
//                  expiries, then one line per finding with its reason.
//                  The ledger row carries the finding id; its class is the class the pass raises it under at render
//                  time (`classes`, from src/pipeline.ts runPass over the same layer), and a disposition whose
//                  finding that pass leaves unraised is counted apart. Then "Why": one line per open finding whose
//                  disposition the explain step explained (CAUSES_SQL, src/explain/), its cause's sentence, with ", N
//                  minutes before the agent restored it" once the disposition's rollback or revert wrote (ACTIONS_SQL,
//                  read when a cause is listed); a cause read that fails is one line saying so.
//   Where each answer comes from
//                  one row per finding class: its question, the tables its detector SQL and its default checks name
//                  as {{t:...}}, and the source each table comes from (sourceRows, below). Read off the SQL text,
//                  so it runs no query and prints no number.
//   Work          the actions by kind and status (DOC_ACTIONS_SQL) with the unverified writes counted (written,
//                  no verification probe run or read), the tickets by type and status with their urls
//                  (DOC_TICKETS_SQL).
//   Probes         the passing probe runs counted by surface, probe (the pass's, every served name) and probe.verify
//                  (the Actor's, after a write); the latest passing run of surface probe, its probes by kind and
//                  status, ok, fail and skipped (DOC_PROBES_SQL; a skipped probe did not run and counts neither way),
//                  and the failing names by kind (DOC_PROBE_FAILURES_SQL).
//   Queries        each query the document ran, its runs and the rows it returned.
//   last line      the decision instant: the latest decided_at of the open dispositions.
// Every collected text in the tables is redacted before it is stored, so the page carries pseudonyms only.
//
// The rows behind the page come back as DocumentResult.data, the input of the owner's report (src/document/report.ts,
// report.html beside document.md): every run of the tenant with its gate result, the latest runs' shapes, the copies,
// the rules, the open dispositions with their classes, the causes, the actions, the tickets and the probes. With
// `report`, the render also reads CAUSES_SQL (when a finding is open) and ACTIONS_SQL after the page is done when the
// page itself did not read them; those reads count in data.queries and leave the page's Queries section as it is.
//
// Measured 25 Oct 2026 over sample/bundle.json, its 108 ledger rows of four live passes in the ledger and the sample
// pass writing 0 (test/document.test.ts, examples/document.md): 19 runs, all passing; 2 hosts and 6 zones; 112 copies at
// the heads; 333 approvals; 0 locked settings without an approved value; 27 findings open, HOLD 27, the latest
// disposition of each on the 23:35 UTC runs; 0 actions and 1 ticket; probe runs 3 of surface probe and 0 of
// probe.verify, the latest, run-30f5647b8b9c5dff, with 20 failing probes; decided at 2026-10-25T01:45:33.962Z, the
// bundle's instant; 37 queries; 178 lines with "Where each answer comes from" (02:07 UTC). Measured 25 Oct 2026 at 03:39
// UTC over the bundle that carries the 03:25 UTC cycle's rows (135 ledger rows of five passes): 26 runs, all passing;
// inventory addresses 2 in the latest run and 0 older rows on host-4b4dc1, 5 and 3 on host-aa516a; 112 copies at the
// heads; 27 findings open, HOLD 26 and ESCALATE 1; probe runs 4 of surface probe, the latest, run-e839e796556a54c3, with
// 20 failing probes; decided at 2026-10-25T03:25:35.412Z; 46 queries; 181 lines. On 24 Oct 2026 through Zetaris over the DRIFT datasource: the same Estate,
// Copies, Approvals and Probes sections, line for line, as the render over the bundle of that day. Measured 25 Oct
// 2026 at 20:29 UTC through Zetaris for the lab (tenant lab-1, npm run document -- --tenant lab-1 --out
// logs/document-lab-1.md), after the 20:24 UTC cycle and its rollback: 146 lines, 2 findings open, 47 queries, the Why
// one line, "The file was changed at 20:22 UTC by user-212a17 over ssh from ip-391349 (sudo tee), 4 minutes before
// the agent restored it.", CAUSES_SQL 4 rows, ACTIONS_SQL 14 rows. Over sample/bundle.json, with the explain step of
// scripts/document.ts over the sample pass: the Why one line, the proxy_split ESCALATE's "No record of who changed it:
// the audit log window of 18 h holds 0 events for the record.", CAUSES_SQL 1 row, ACTIONS_SQL 0 rows; 189 lines.

import { defaultSelection, defaultSelectionFor } from "../catalogue/select.ts";
import { templateById, type FindingClass } from "../catalogue/templates.ts";
import type { DataLayer, Params } from "../data/layer.ts";
import {
  APPROVED_MISSING_SQL, CHANGED_SINCE_BACKUP_SQL, DRIFT_VS_APPROVED_SQL, HERO_SQL, ORPHAN_RECORD_SQL, ORPHAN_VHOST_SQL, PROXIED_WITHOUT_REAL_IP_SQL, PROXY_SPLIT_SQL,
  RESOLUTIONS_SQL, WILDCARD_WITHOUT_REAL_IP_SQL,
  DOC_ACTIONS_SQL, DOC_COPIES_SQL, DOC_DISPOSITIONS_OF_RUN_SQL, DOC_INVENTORY_SQL, DOC_PROBES_SQL, DOC_PROBE_FAILURES_SQL, DOC_RUN_SHAPE_SQL, DOC_TICKETS_SQL, DOC_UNAPPROVED_SQL, DOC_ZONES_SQL,
  ACTIONS_SQL, LATEST_APPROVALS_SQL, POLICY_RULES_SQL, RUNS_SQL, RUN_COMPLETE_SQL, objects,
} from "../data/queries.ts";
import type { Action, FindingCause, PolicyRule } from "../data/rows.ts";
import { withRestore } from "../explain/cause.ts";
import { CAUSES_SQL, causeOf } from "../explain/explain.ts";
import { TABLE_NAMES } from "../data/schema.ts";
import { ruleOf, VERBS } from "../pipeline.ts";
import { resolvePolicy } from "../policy/resolve.ts";
import type { Tracer } from "../trace.ts";

type Row = Record<string, string>;

export interface DocumentOptions {
  tenant: string;
  /** Finding id to the class the pass raises it under; the ledger row carries the id only. */
  classes?: ReadonlyMap<string, string>;
  /** One phrase naming the data the layer reads, for the opening line ("sql.js over sample/bundle.json"). */
  source?: string;
  tracer?: Tracer;
  /** Read the causes and the actions for the owner's report too, after the page is done (see the header). */
  report?: boolean;
}

export interface QueryCount { name: string; runs: number; rows: number }

/** One collection run of the tenant as RUNS_SQL returns it, and whether it passes the DQ gate (RUN_COMPLETE_SQL). */
export interface RunGate {
  run_id: string;
  surface: string;
  host: string;
  started_at: string;
  finished_at: string;
  expected_count: string;
  observed_count: string;
  status: string;
  passes: boolean;
}

/** An open disposition as DOC_DISPOSITIONS_OF_RUN_SQL returns it, with the class the pass raises its finding under ("-" with none). */
export type OpenDisposition = Readonly<Record<string, string>> & { class: string };

/** The rows the page is rendered from, as the queries returned them; the owner's report renders from the same. */
export interface DocumentData {
  tenant: string;
  /** The phrase naming the data the layer reads; null when none was given. */
  source: string | null;
  /** Every collection run of the tenant, in started_at order, each with its gate result. */
  runs: RunGate[];
  /** The latest passing run of each surface and host the findings come from, with the objects and settings it observed. */
  shapes: { surface: string; host: string; run_id: string; finished_at: string; objects: number; settings: number }[];
  /** The hosts of those runs, in code-unit order. */
  hosts: string[];
  /** Per host: the inventory addresses its latest passing run observed and the older rows the Store keeps. */
  inventory: { host: string; latest: number; older: number }[];
  /** The zones of the latest passing DNS run (zone, records, proxied, direct). */
  zones: Readonly<Record<string, string>>[];
  /** The vault copies at each repository's latest commit with their latest validation (DOC_COPIES_SQL). */
  copies: Readonly<Record<string, string>>[];
  /** Settings with an approval of record. */
  approvals: number;
  /** The policy rules that can govern the tenant's settings, every version, as ruleOf reads them. */
  rules: PolicyRule[];
  /** The settings of the latest passing runs that a locked rule governs with no approved value. */
  locked: { surface: string; host: string; object_id: string; setting_path: string; rule_id: string }[];
  /** The open dispositions in the page's order: by verb, class, finding. */
  open: OpenDisposition[];
  /** Dispositions on the latest passing runs whose finding the pass leaves unraised at render time. */
  unraised: number;
  decidedAt: string | null;
  /** The tenant's finding_cause rows; null when they were not read. */
  causes: FindingCause[] | null;
  /** Why the causes were not read, when the read failed. */
  causesError: string | null;
  /** The tenant's actions (ACTIONS_SQL); null when they were not read. */
  actions: Readonly<Record<string, string>>[] | null;
  /** The tenant's actions by kind and status (DOC_ACTIONS_SQL). */
  actionCounts: Readonly<Record<string, string>>[];
  /** Every ticket of the tenant (DOC_TICKETS_SQL). */
  tickets: Readonly<Record<string, string>>[];
  probes: {
    /** Passing runs of surface probe and of probe.verify. */
    probeRuns: number;
    verifyRuns: number;
    /** The latest passing run of surface probe; null with none. */
    run: { run_id: string; finished_at: string } | null;
    /** Its probes by kind and status (kind, status, n), and its failing probes (kind, target, probe_id). */
    byKind: Readonly<Record<string, string>>[];
    failing: Readonly<Record<string, string>>[];
  };
  /** Every query run for the page and, with `report`, for the report. */
  queries: QueryCount[];
}

export interface DocumentResult {
  markdown: string;
  queries: QueryCount[];
  /** The latest decided_at of the open dispositions; null when the latest passing runs carry none. */
  decidedAt: string | null;
  /** The open findings the page lists. */
  open: number;
  /** The rows the page is rendered from. */
  data: DocumentData;
}

/** Rows a document read returns at most; a read that returns more fails rather than print a cut number. */
const MAX_ROWS = 100_000;
/** The pass's probe run of every served name, and the Actor's verification after a write (src/probe/run.ts, src/actions/act.ts). */
const PROBE_SURFACE = "probe";
const VERIFY_SURFACE = "probe.verify";
const SURFACES_WITH_FINDINGS = (surface: string): boolean => surface !== PROBE_SURFACE && surface !== VERIFY_SURFACE && surface !== "cloudflare.audit";
const h8 = (h: string): string => h.replace(/^sha256:/, "").slice(0, 8);
const dash = (s: string | undefined | null): string => (s ? s : "-");
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/** A markdown table cell: pipes and line breaks escaped. */
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const table = (head: readonly string[], rows: readonly (readonly (string | number)[])[]): string[] => [
  `| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map((v) => cell(String(v))).join(" | ")} |`),
];

/** Group rows by a key, keys in code-unit order. */
function groupBy<T>(rows: readonly T[], key: (r: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return [...m.entries()].sort(([a], [b]) => cmp(a, b));
}

// ---- Where each answer comes from -------------------------------------------------------------------------------
//
// For each finding class the pass raises: the tables its detector SQL names as {{t:...}} (src/data/queries.ts) and
// the tables its default checks name (DEFAULT_CHECKS and the record lists in src/catalogue/select.ts, each template's
// sql in src/catalogue/templates.ts), and the source each table's rows come from. Read off the SQL text when the
// section renders, so a changed query changes the row. The README carries the same section (npm run sources), and
// test/document.test.ts holds the two equal.

/** Where each table's rows come from, in the order the section lists the sources. */
const SOURCES: readonly { name: string; tables: readonly string[]; holds: string }[] = [
  { name: "live state", tables: ["observation"], holds: "each setting as the live host answers it over SSH, and each record field as the DNS provider returns it" },
  { name: "export", tables: ["backup_snapshot", "backup_item"], holds: "the nightly export tarball of each host and every regular member of the newest" },
  { name: "documentation of record", tables: ["approved_setting"], holds: "the values a technician approved; IT Glue and Hudu map here" },
  { name: "DNS", tables: ["dns_record"], holds: "the DNS provider's records, Cloudflare's in this slice" },
  { name: "audit log", tables: ["audit_event"], holds: "the provider's audit log, who changed which resource and when; and each host's journal of the last 24 h, the sudo commands that touch nginx and the logins, every login name pseudonymised" },
  { name: "inventory", tables: ["inventory_asset"], holds: "the hosts' addresses" },
  { name: "probes", tables: ["probe"], holds: "what the sites answer from outside" },
  { name: "vault", tables: ["vault_copy", "copy_validation"], holds: "the agent's copy of each object and its validations" },
  { name: "policy", tables: ["policy_rule"], holds: "the MSP's policy" },
  { name: "ledger", tables: ["disposition"], holds: "the agent's decision on each finding" },
  { name: "populations", tables: ["collection_run"], holds: "each source's own population, asserted before a row is read, and each run's status" },
];

/**
 * Each class the pass raises (src/pipeline.ts), its question as DESIGN.md section 2 words it, and the SQL that raises
 * it. The hero classes are the hero query's rows, found_but_different where the setting's bytes are unchanged and the
 * fingerprint RESOLUTIONS_SQL gives the World Model is not, dns_change for every other row.
 */
const RAISED: readonly { cls: FindingClass; question: string; sql: readonly string[] }[] = [
  { cls: "proxy_split", question: "Is it fully configured?", sql: [PROXY_SPLIT_SQL] },
  { cls: "proxied_without_real_ip", question: "Is it fully configured?", sql: [PROXIED_WITHOUT_REAL_IP_SQL, WILDCARD_WITHOUT_REAL_IP_SQL] },
  { cls: "orphan_record", question: "Does a configuration exist for everything that should?", sql: [ORPHAN_RECORD_SQL] },
  { cls: "orphan_vhost", question: "Does a configuration exist for everything that should?", sql: [ORPHAN_VHOST_SQL] },
  { cls: "changed_since_backup", question: "Has it changed since the copy?", sql: [CHANGED_SINCE_BACKUP_SQL] },
  { cls: "drift_vs_approved", question: "Has it changed since the copy?", sql: [DRIFT_VS_APPROVED_SQL] },
  { cls: "approved_missing", question: "Does a configuration exist for everything that should?", sql: [APPROVED_MISSING_SQL] },
  { cls: "found_but_different", question: "Is it FOUND-BUT-DIFFERENT?", sql: [HERO_SQL, RESOLUTIONS_SQL] },
  { cls: "dns_change", question: "Is it FOUND-BUT-DIFFERENT?", sql: [HERO_SQL, RESOLUTIONS_SQL] },
];

export interface SourceRow {
  cls: FindingClass;
  question: string;
  /** The default checks of the class, its record list's included, in list order. */
  checks: string[];
  /** Every table the detector SQL and the checks name, in sql/schema.sql order; a name outside the schema last. */
  tables: string[];
  /** The source of each of those tables, in SOURCES order. */
  sources: string[];
}

/** The tables one SQL text names as {{t:name}}, each once, in first-appearance order. */
export function tablesOf(sql: string): string[] {
  return [...new Set([...sql.matchAll(/\{\{t:(\w+)\}\}/g)].map((m) => m[1]))];
}

/** The source a table's rows come from; undefined for a table the section maps to none. */
export function sourceOf(table: string): string | undefined {
  return SOURCES.find((s) => s.tables.includes(table))?.name;
}

/** One row per class the pass raises, read off the SQL and the default checks. */
export function sourceRows(): SourceRow[] {
  const rank = (t: string): number => (TABLE_NAMES.includes(t) ? TABLE_NAMES.indexOf(t) : TABLE_NAMES.length);
  return RAISED.map(({ cls, question, sql }) => {
    const checks = [...new Set([...defaultSelection(cls), ...defaultSelectionFor({ class: cls, host: null })])];
    const texts = [...sql, ...checks.map((id) => {
      const t = templateById(id);
      if (!t) throw new Error(`sources: ${cls} names the unknown template ${id}`);
      return t.sql;
    })];
    const tables = [...new Set(texts.flatMap(tablesOf))].sort((a, b) => rank(a) - rank(b) || cmp(a, b));
    const sources = SOURCES.filter((s) => s.tables.some((t) => tables.includes(t))).map((s) => s.name);
    return { cls, question, checks, tables, sources };
  });
}

/** The section's body: one sentence, the table, and the sources it names. */
function sourceLines(): string[] {
  const rows = sourceRows();
  const code = (s: string): string => `\`${s}\``;
  return [
    "Each finding class answers its question by joining the tables its detector query and its default checks name, and each table holds the rows of one source. The rows are read off the SQL in `src/data/queries.ts` and `src/catalogue/templates.ts` and the default checks in `src/catalogue/select.ts`.",
    "",
    ...table(["class", "question", "tables", "sources"], rows.map((r) => [code(r.cls), r.question, r.tables.map(code).join(", "), r.sources.join(", ")])),
    "",
    "The sources:",
    "",
    ...SOURCES.filter((s) => rows.some((r) => r.sources.includes(s.name))).map((s) => `- ${s.name} (${s.tables.map(code).join(", ")}): ${s.holds}.`),
  ];
}

/** The section's body as markdown: what npm run sources prints and the README carries under its heading. */
export function sourcesMarkdown(): string {
  return `${sourceLines().join("\n")}\n`;
}

export async function renderDocument(layer: DataLayer, opts: DocumentOptions): Promise<DocumentResult> {
  const { tenant, classes } = opts;
  const counts = new Map<string, QueryCount>();
  const q = async (name: string, sql: string, params: Params = {}): Promise<Row[]> => {
    const r = await layer.run(sql, params, { tracer: opts.tracer, agent: "documenter", limit: MAX_ROWS });
    if (r.total > r.rowCount) throw new Error(`document: ${name} returned ${r.total} rows, more than the ${MAX_ROWS} a document reads`);
    const c = counts.get(name) ?? { name, runs: 0, rows: 0 };
    counts.set(name, { name, runs: c.runs + 1, rows: c.rows + r.total });
    return objects(r);
  };
  const out: string[] = [];
  const line = (...xs: string[]): void => { out.push(...xs); };

  // ---- the runs and the gate ----
  const runs = (await q("RUNS_SQL", RUNS_SQL)).filter((r) => r.tenant_id === tenant);
  const passing: Row[] = [];
  const gates: RunGate[] = [];
  for (const r of runs) {
    const passes = (await q("RUN_COMPLETE_SQL", RUN_COMPLETE_SQL, { run_id: r.run_id })).length === 0;
    if (passes) passing.push(r);
    gates.push({ run_id: r.run_id, surface: r.surface, host: r.host, started_at: r.started_at, finished_at: r.finished_at, expected_count: r.expected_count, observed_count: r.observed_count, status: r.status, passes });
  }
  // RUNS_SQL is in started_at order, so the last passing run of each surface and host is its latest
  const latestOf = new Map<string, Row>();
  for (const r of passing) latestOf.set(`${r.surface}\u001f${r.host}`, r);
  const latest = [...latestOf.values()].sort((a, b) => cmp(a.surface, b.surface) || cmp(a.host, b.host));
  const observed = latest.filter((r) => SURFACES_WITH_FINDINGS(r.surface));
  const dnsRun = latest.find((r) => r.surface === "cloudflare.dns");
  const probeRun = latest.find((r) => r.surface === PROBE_SURFACE);

  line(`# Configuration document: ${tenant}`, "");
  line(`What the agent holds for ${tenant}, read through one data layer${opts.source ? ` (${opts.source})` : ""} when this page is rendered. Every number is a count of the rows, or a value of a row, that the queries listed at the end return.`, "");

  // ---- Estate ----
  const hosts = [...new Set(observed.filter((r) => r.host !== "").map((r) => r.host))].sort(cmp);
  const zones = dnsRun ? await q("DOC_ZONES_SQL", DOC_ZONES_SQL, { tenant_id: tenant, dns_run_id: dnsRun.run_id }) : [];
  line("## Estate", "");
  line(`${plural(runs.length, "collection run", "collection runs")} on record, ${passing.length} passing the DQ gate. ${plural(hosts.length, "host", "hosts")} and ${plural(zones.length, "zone", "zones")} in the latest passing runs.`, "");
  const shapeRows: DocumentData["shapes"] = [];
  if (observed.length) {
    const shapes: (string | number)[][] = [];
    for (const r of observed) {
      const s = (await q("DOC_RUN_SHAPE_SQL", DOC_RUN_SHAPE_SQL, { run_id: r.run_id }))[0] ?? {};
      shapes.push([r.surface, dash(r.host), r.run_id, dash(r.finished_at), s.objects ?? "0", s.settings ?? "0"]);
      shapeRows.push({ surface: r.surface, host: r.host, run_id: r.run_id, finished_at: r.finished_at, objects: Number(s.objects || 0), settings: Number(s.settings || 0) });
    }
    line(...table(["surface", "host", "latest passing run", "finished", "objects", "settings"], shapes), "");
  }
  const inventoryRows: DocumentData["inventory"] = [];
  if (hosts.length) {
    const inventory: string[] = [];
    for (const host of hosts) {
      // the host's latest passing run: observed is one row per surface and host, so the greatest started_at of the host's
      const started = observed.filter((r) => r.host === host).map((r) => r.started_at).sort(cmp).at(-1)!;
      const n = (await q("DOC_INVENTORY_SQL", DOC_INVENTORY_SQL, { tenant_id: tenant, host, started_at: started }))[0] ?? {};
      const older = Number(n.older || 0);
      inventory.push(`- inventory addresses on ${host}: ${Number(n.latest || 0)} in the latest run, ${plural(older, "older row", "older rows")} kept`);
      inventoryRows.push({ host, latest: Number(n.latest || 0), older });
    }
    line(...inventory, "");
  }
  if (zones.length) line(...table(["zone", "records", "proxied", "direct"], zones.map((z) => [z.zone, z.records, z.proxied, z.direct])), "");

  // ---- Copies ----
  const copies = await q("DOC_COPIES_SQL", DOC_COPIES_SQL, { tenant_id: tenant });
  line("## Copies", "");
  if (!copies.length) line(`The vault holds no copy for ${tenant}.`, "");
  else {
    const repoOf = (c: Row): string => (c.surface === "cloudflare.dns" ? `records, zone ${dash(c.zone)}` : `${dash(c.host)} (${c.surface})`);
    const repos = groupBy(copies, repoOf);
    line(`${plural(copies.length, "vault copy", "vault copies")} at the latest commit of each repository, each with its latest validation:`, "");
    const n = (rows: Row[], result: string): number => rows.filter((c) => c.result === result).length;
    line(...table(["repository", "commit", "copies", "ok", "ok_with_gaps", "fail", "not validated"],
      repos.map(([repo, rows]) => [repo, [...new Set(rows.map((c) => h8(c.git_commit)))].sort(cmp).join(", "), rows.length, n(rows, "ok"), n(rows, "ok_with_gaps"), n(rows, "fail"), n(rows, "")])), "");
    const gapLines: string[] = [];
    for (const [repo, rows] of repos) {
      const gaps = [...new Set(rows.flatMap((c) => c.missing_dependencies.split("\n").map((s) => s.trim()).filter(Boolean)))].sort(cmp);
      if (gaps.length) gapLines.push(`- ${repo}: ${plural(gaps.length, "gap", "gaps")}: ${gaps.join(", ")}`);
    }
    if (gapLines.length) line("The gaps the validations name, each a dependency a restore needs from outside the vault:", "", ...gapLines, "");
    else line("The validations name no gap.", "");
  }

  // ---- Approvals ----
  const approvals = await q("LATEST_APPROVALS_SQL", LATEST_APPROVALS_SQL, { tenant_id: tenant });
  const rules: PolicyRule[] = [];
  for (const row of await q("POLICY_RULES_SQL", POLICY_RULES_SQL, { tenant_id: tenant })) {
    const r = ruleOf(row);
    if (!("refused" in r)) rules.push(r);
  }
  line("## Approvals", "");
  if (!approvals.length) line(`No setting of ${tenant} has an approval of record.`, "");
  else {
    const scopes = groupBy(approvals, (a) => `${a.surface}\u001f${a.host}`);
    line(`${plural(approvals.length, "setting has", "settings have")} an approval of record, the latest of each:`, "");
    line(...table(["surface", "host", "objects approved", "settings approved"],
      scopes.map(([, rows]) => [rows[0].surface, dash(rows[0].host), new Set(rows.map((a) => a.object_id)).size, rows.length])), "");
  }
  const locked: { row: Row; rule: PolicyRule }[] = [];
  if (rules.some((r) => r.lock === 1)) {
    for (const run of observed) {
      for (const o of await q("DOC_UNAPPROVED_SQL", DOC_UNAPPROVED_SQL, { tenant_id: tenant, run_id: run.run_id })) {
        const rule = resolvePolicy(rules, { tenant_id: tenant, surface: o.surface, object_id: o.object_id, setting_path: o.setting_path });
        if (rule?.lock === 1) locked.push({ row: o, rule });
      }
    }
  }
  line(`Locked settings without an approved value: ${locked.length}.`, "");
  if (locked.length) line(...locked.map(({ row, rule }) => `- ${row.setting_path} in ${row.object_id}${row.host ? ` on ${row.host}` : ""} (${row.surface}), locked by ${rule.rule_id}`), "");

  // ---- Findings open ----
  const dispositions: Row[] = [];
  for (const run of observed) dispositions.push(...await q("DOC_DISPOSITIONS_OF_RUN_SQL", DOC_DISPOSITIONS_OF_RUN_SQL, { tenant_id: tenant, run_id: run.run_id }));
  const open = classes ? dispositions.filter((d) => classes.has(d.finding_id)) : dispositions;
  const unraised = dispositions.length - open.length;
  const classOf = (d: Row): string => classes?.get(d.finding_id) ?? "-";
  const decidedAt = open.map((d) => d.decided_at).sort(cmp).at(-1) ?? null;
  // the causes and the actions as read, for the report (DocumentResult.data); null until read
  let causesRead: FindingCause[] | null = null;
  let causesError: string | null = null;
  let actionsRead: Row[] | null = null;
  const readCauses = async (): Promise<FindingCause[]> => {
    try {
      return (causesRead = (await q("CAUSES_SQL", CAUSES_SQL, { tenant_id: tenant })).map(causeOf));
    } catch (e) {
      causesError = (e instanceof Error ? e.message : String(e)).split("\n")[0];
      throw e;
    }
  };
  const readActions = async (): Promise<Row[]> => (actionsRead = await q("ACTIONS_SQL", ACTIONS_SQL, { tenant_id: tenant }));
  /** "Why": each open finding's cause, in the order the findings are listed. */
  const whyLines = async (listed: readonly Row[]): Promise<string[]> => {
    const head = ["### Why", ""];
    let causes;
    try {
      causes = new Map((await readCauses()).map((c) => [c.disposition_id, c]));
    } catch (e) {
      return [...head, `The causes are not read: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}.`];
    }
    const shown = listed.flatMap((d) => (causes.has(d.disposition_id) ? [{ d, c: causes.get(d.disposition_id)! }] : []));
    if (!shown.length) return [...head, "No open finding carries a cause: the explain step of a cycle records one for each finding it explains."];
    const wrote = (await readActions()).map((a) => ({ disposition_id: a.disposition_id, kind: a.kind as Action["kind"], status: a.status as Action["status"], started_at: a.started_at }));
    return [
      ...head,
      `Who or what changed each setting, from the hosts' journal, the provider's audit log and the agent's own actions (${plural(shown.length, "finding", "findings")}):`,
      "",
      ...shown.map(({ d, c }) => `- ${d.finding_id} ${d.verb} ${classOf(d)}: ${withRestore(c, wrote)}`),
    ];
  };
  const rank = (d: Row): number => (VERBS as readonly string[]).indexOf(d.verb);
  const ordered = [...open].sort((a, b) => rank(a) - rank(b) || cmp(classOf(a), classOf(b)) || cmp(a.finding_id, b.finding_id));
  line("## Findings open", "");
  if (!open.length) line(`The latest passing runs carry no open finding for ${tenant}.`, "");
  else {
    const verbsSeen = VERBS.filter((v) => open.some((d) => d.verb === v));
    line(`${plural(open.length, "finding is", "findings are")} open on the latest passing runs: ${verbsSeen.map((v) => `${v} ${open.filter((d) => d.verb === v).length}`).join(", ")}.`, "");
    const byClass = groupBy(open, classOf);
    line(...table(["class", ...verbsSeen, "total"], byClass.map(([cls, rows]) => [cls, ...verbsSeen.map((v) => rows.filter((d) => d.verb === v).length), rows.length])), "");
    const drifted = open.filter((d) => classOf(d) === "drift_vs_approved").length;
    const missing = open.filter((d) => classOf(d) === "approved_missing").length;
    line(`Drift from the approved values: ${drifted === 1 ? "1 setting differs from its" : `${drifted} settings differ from their`} latest approval (drift_vs_approved), ${missing === 1 ? "1 approved setting is absent from its" : `${missing} approved settings are absent from their`} run (approved_missing).`, "");
    const holds = groupBy(open.filter((d) => d.verb === "HOLD"), (d) => d.expires_at);
    if (holds.length) line("The HOLDs expire:", "", ...holds.map(([at, rows]) => `- ${dash(at)}: ${rows.length} (${groupBy(rows, classOf).map(([cls, xs]) => `${cls} ${xs.length}`).join(", ")})`), "");
    line("Each open finding, by verb and class, with the reason its disposition records:", "");
    for (const d of ordered) {
      const where = d.host ? ` on ${d.host}` : "";
      line(`- ${d.finding_id} ${d.verb} ${classOf(d)}: ${d.setting_path} in ${d.object_id}${where} (${d.surface}, run ${d.run_id})${d.expires_at ? `, until ${d.expires_at}` : ""}. ${d.reason}.`);
    }
    line("");
    line(...await whyLines(ordered), "");
  }
  if (unraised) line(`${plural(unraised, "disposition", "dispositions")} on these runs concern a finding the pass leaves unraised at render time.`, "");

  // ---- Where each answer comes from: read off the SQL text, no query run ----
  line("## Where each answer comes from", "", ...sourceLines(), "");

  // ---- Work ----
  const actions = await q("DOC_ACTIONS_SQL", DOC_ACTIONS_SQL, { tenant_id: tenant });
  const tickets = await q("DOC_TICKETS_SQL", DOC_TICKETS_SQL, { tenant_id: tenant });
  line("## Work", "");
  if (!actions.length) line(`No action is recorded for ${tenant}.`, "");
  else {
    line("Actions by kind and status:", "", ...table(["kind", "status", "actions"], actions.map((a) => [a.kind, a.status, a.n])), "");
    const unverified = actions.filter((a) => a.status === "unverified").reduce((n, a) => n + Number(a.n), 0);
    line(`Unverified writes: ${unverified}, each completed with no verification probe run or read; the change ticket of such a write stays open until a pass finds its setting at the approved value.`, "");
  }
  if (!tickets.length) line(`No ticket is recorded for ${tenant}.`, "");
  else {
    line("Tickets by type and status:", "", ...table(["type", "status", "tickets"], groupBy(tickets, (t) => `${t.type}\u001f${t.status}`).map(([, rows]) => [rows[0].type, rows[0].status, rows.length])), "");
    line(...tickets.map((t) => `- ${t.type} ${t.priority} ${t.status}: ${dash(t.url)} (${t.psa}${t.external_id ? ` #${t.external_id}` : ""}, finding ${t.finding_id})`), "");
  }

  // ---- Probes ----
  line("## Probes", "");
  const ofSurface = (s: string): number => passing.filter((r) => r.surface === s).length;
  line(`Probe runs passing the DQ gate: ${ofSurface(PROBE_SURFACE)} of surface ${PROBE_SURFACE}, every served name probed for the pass, and ${ofSurface(VERIFY_SURFACE)} of surface ${VERIFY_SURFACE}, the Actor's probes after a write.`, "");
  let byKind: Row[] = [];
  let failing: Row[] = [];
  if (!probeRun) line(`No probe run of ${tenant} passes the DQ gate.`, "");
  else {
    byKind = await q("DOC_PROBES_SQL", DOC_PROBES_SQL, { tenant_id: tenant, run_id: probeRun.run_id });
    failing = await q("DOC_PROBE_FAILURES_SQL", DOC_PROBE_FAILURES_SQL, { tenant_id: tenant, run_id: probeRun.run_id });
    const kinds = [...new Set(byKind.map((k) => k.kind))].sort(cmp);
    const num = (kind: string, status: string): string => byKind.find((k) => k.kind === kind && k.status === status)?.n ?? "0";
    line(`Probe run ${probeRun.run_id} (surface ${PROBE_SURFACE}), finished ${dash(probeRun.finished_at)}: ${plural(failing.length, "probe fails", "probes fail")}.`, "");
    line(...table(["kind", "ok", "fail", "skipped"], kinds.map((k) => [k, num(k, "ok"), num(k, "fail"), num(k, "skipped")])), "");
    if (failing.length) line("The failing names:", "", ...groupBy(failing, (f) => f.kind).map(([kind, rows]) => `- ${kind}: ${[...new Set(rows.map((f) => f.target))].sort(cmp).join(", ")}`), "");
  }

  // ---- Queries and the closing line ----
  const ran = [...counts.values()];
  line("## Queries", "");
  line(...ran.map((c) => `- ${c.name}: ${plural(c.runs, "run", "runs")}, ${plural(c.rows, "row", "rows")}`), "");
  line(decidedAt ? `Decided at ${decidedAt}.` : `No decision of ${tenant} is on the latest passing runs.`);

  // ---- the report's reads, after the page: counted in data.queries, not in the page's Queries ----
  if (opts.report) {
    if (open.length && causesRead === null && causesError === null) await readCauses().catch(() => undefined);
    if (actionsRead === null) await readActions();
  }
  const data: DocumentData = {
    tenant, source: opts.source ?? null, runs: gates, shapes: shapeRows, hosts, inventory: inventoryRows, zones, copies, approvals: approvals.length, rules,
    locked: locked.map(({ row, rule }) => ({ surface: row.surface, host: row.host, object_id: row.object_id, setting_path: row.setting_path, rule_id: rule.rule_id })),
    open: ordered.map((d) => ({ ...d, class: classOf(d) })), unraised, decidedAt, causes: causesRead, causesError, actions: actionsRead, actionCounts: actions, tickets,
    probes: { probeRuns: ofSurface(PROBE_SURFACE), verifyRuns: ofSurface(VERIFY_SURFACE), run: probeRun ? { run_id: probeRun.run_id, finished_at: probeRun.finished_at } : null, byKind, failing },
    queries: [...counts.values()],
  };
  return { markdown: `${out.join("\n")}\n`, queries: ran, decidedAt, open: open.length, data };
}
