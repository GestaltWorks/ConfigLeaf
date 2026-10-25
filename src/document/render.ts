// The owner's document: one markdown page per tenant, rendered from SQL through one DataLayer, plain, present
// tense, for the MSP's owner and the client's.
//
// Contract: renderDocument(layer, { tenant, classes, source }) runs the reads below through the layer in order and
// returns the markdown and the queries it ran (each name with its runs and rows). Every number printed is a count
// of the rows those queries return at render time, or a value of one of those rows; nothing is typed in. Sections:
//   Estate         the tenant's collection runs and how many pass the DQ gate (RUNS_SQL, RUN_COMPLETE_SQL per run);
//                  the latest passing run of each surface and host with the objects and settings it observed
//                  (DOC_RUN_SHAPE_SQL); the zones of the latest passing DNS run with their records (DOC_ZONES_SQL).
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
//                  finding that pass leaves unraised is counted apart.
//   Work           the actions by kind and status (DOC_ACTIONS_SQL), the tickets by type and status with their
//                  urls (DOC_TICKETS_SQL).
//   Probes         the passing probe runs counted by surface, probe (the pass's, every served name) and probe.verify
//                  (the Actor's, after a write); the latest passing run of surface probe, its probes by kind and
//                  status (DOC_PROBES_SQL) and the failing names by kind (DOC_PROBE_FAILURES_SQL).
//   Queries        each query the document ran, its runs and the rows it returned.
//   last line      the decision instant: the latest decided_at of the open dispositions.
// Every collected text in the tables is redacted before it is stored, so the page carries pseudonyms only.
//
// Measured 25 Oct 2026 over sample/bundle.json, its 81 ledger rows of three live passes in the ledger and the sample
// pass writing 0 (test/document.test.ts, examples/document.md): 19 runs, all passing; 2 hosts and 6 zones; 112 copies at
// the heads; 333 approvals; 0 locked settings without an approved value; 27 findings open, HOLD 27, the latest
// disposition of each on the 23:35 UTC runs, the 01:16 UTC pass's; 0 actions and 1 ticket; probe runs 3 of surface probe
// and 0 of probe.verify, the latest, run-30f5647b8b9c5dff, with 20 failing probes; decided at 2026-10-25T01:16:49.394Z,
// the bundle's instant; 37 queries, 152 lines. On 24 Oct 2026 through Zetaris over the DRIFT datasource: the same Estate,
// Copies, Approvals and Probes sections, line for line, as the render over the bundle of that day.

import type { DataLayer, Params } from "../data/layer.ts";
import {
  DOC_ACTIONS_SQL, DOC_COPIES_SQL, DOC_DISPOSITIONS_OF_RUN_SQL, DOC_PROBES_SQL, DOC_PROBE_FAILURES_SQL, DOC_RUN_SHAPE_SQL, DOC_TICKETS_SQL, DOC_UNAPPROVED_SQL, DOC_ZONES_SQL,
  LATEST_APPROVALS_SQL, POLICY_RULES_SQL, RUNS_SQL, RUN_COMPLETE_SQL, objects,
} from "../data/queries.ts";
import type { PolicyRule } from "../data/rows.ts";
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
}

export interface QueryCount { name: string; runs: number; rows: number }

export interface DocumentResult {
  markdown: string;
  queries: QueryCount[];
  /** The latest decided_at of the open dispositions; null when the latest passing runs carry none. */
  decidedAt: string | null;
  /** The open findings the page lists. */
  open: number;
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
  for (const r of runs) if ((await q("RUN_COMPLETE_SQL", RUN_COMPLETE_SQL, { run_id: r.run_id })).length === 0) passing.push(r);
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
  if (observed.length) {
    const shapes: (string | number)[][] = [];
    for (const r of observed) {
      const s = (await q("DOC_RUN_SHAPE_SQL", DOC_RUN_SHAPE_SQL, { run_id: r.run_id }))[0] ?? {};
      shapes.push([r.surface, dash(r.host), r.run_id, dash(r.finished_at), s.objects ?? "0", s.settings ?? "0"]);
    }
    line(...table(["surface", "host", "latest passing run", "finished", "objects", "settings"], shapes), "");
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
    const rank = (d: Row): number => (VERBS as readonly string[]).indexOf(d.verb);
    const ordered = [...open].sort((a, b) => rank(a) - rank(b) || cmp(classOf(a), classOf(b)) || cmp(a.finding_id, b.finding_id));
    for (const d of ordered) {
      const where = d.host ? ` on ${d.host}` : "";
      line(`- ${d.finding_id} ${d.verb} ${classOf(d)}: ${d.setting_path} in ${d.object_id}${where} (${d.surface}, run ${d.run_id})${d.expires_at ? `, until ${d.expires_at}` : ""}. ${d.reason}.`);
    }
    line("");
  }
  if (unraised) line(`${plural(unraised, "disposition", "dispositions")} on these runs concern a finding the pass leaves unraised at render time.`, "");

  // ---- Work ----
  const actions = await q("DOC_ACTIONS_SQL", DOC_ACTIONS_SQL, { tenant_id: tenant });
  const tickets = await q("DOC_TICKETS_SQL", DOC_TICKETS_SQL, { tenant_id: tenant });
  line("## Work", "");
  if (!actions.length) line(`No action is recorded for ${tenant}.`, "");
  else line("Actions by kind and status:", "", ...table(["kind", "status", "actions"], actions.map((a) => [a.kind, a.status, a.n])), "");
  if (!tickets.length) line(`No ticket is recorded for ${tenant}.`, "");
  else {
    line("Tickets by type and status:", "", ...table(["type", "status", "tickets"], groupBy(tickets, (t) => `${t.type}\u001f${t.status}`).map(([, rows]) => [rows[0].type, rows[0].status, rows.length])), "");
    line(...tickets.map((t) => `- ${t.type} ${t.priority} ${t.status}: ${dash(t.url)} (${t.psa}${t.external_id ? ` #${t.external_id}` : ""}, finding ${t.finding_id})`), "");
  }

  // ---- Probes ----
  line("## Probes", "");
  const ofSurface = (s: string): number => passing.filter((r) => r.surface === s).length;
  line(`Probe runs passing the DQ gate: ${ofSurface(PROBE_SURFACE)} of surface ${PROBE_SURFACE}, every served name probed for the pass, and ${ofSurface(VERIFY_SURFACE)} of surface ${VERIFY_SURFACE}, the Actor's probes after a write.`, "");
  if (!probeRun) line(`No probe run of ${tenant} passes the DQ gate.`, "");
  else {
    const byKind = await q("DOC_PROBES_SQL", DOC_PROBES_SQL, { tenant_id: tenant, run_id: probeRun.run_id });
    const failing = await q("DOC_PROBE_FAILURES_SQL", DOC_PROBE_FAILURES_SQL, { tenant_id: tenant, run_id: probeRun.run_id });
    const kinds = [...new Set(byKind.map((k) => k.kind))].sort(cmp);
    const num = (kind: string, status: string): string => byKind.find((k) => k.kind === kind && k.status === status)?.n ?? "0";
    line(`Probe run ${probeRun.run_id} (surface ${PROBE_SURFACE}), finished ${dash(probeRun.finished_at)}: ${plural(failing.length, "probe fails", "probes fail")}.`, "");
    line(...table(["kind", "ok", "fail"], kinds.map((k) => [k, num(k, "ok"), num(k, "fail")])), "");
    if (failing.length) line("The failing names:", "", ...groupBy(failing, (f) => f.kind).map(([kind, rows]) => `- ${kind}: ${[...new Set(rows.map((f) => f.target))].sort(cmp).join(", ")}`), "");
  }

  // ---- Queries and the closing line ----
  const ran = [...counts.values()];
  line("## Queries", "");
  line(...ran.map((c) => `- ${c.name}: ${plural(c.runs, "run", "runs")}, ${plural(c.rows, "row", "rows")}`), "");
  line(decidedAt ? `Decided at ${decidedAt}.` : `No decision of ${tenant} is on the latest passing runs.`);
  return { markdown: `${out.join("\n")}\n`, queries: ran, decidedAt, open: open.length };
}
