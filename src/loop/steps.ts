// The steps of a cycle (src/loop/cycle.ts) as functions over the modules the other commands use: the collectors
// (src/collectors/), their vault hook (src/vault/hook.ts), the probe run (src/probe/run.ts), copy validation
// (src/validate/run.ts), the pass (src/loop/pass.ts), the explainer (src/explain/), the Actor (src/actions/), the
// ticket step (src/psa/step.ts) and the owner's document (src/document/render.ts). liveSteps wires them to the live
// estate; a test calls each one with fakes or over sql.js.
//
// Contract, step by step (each returns a StepReport; a step fails when the command it mirrors exits non-zero, and
// the collect steps also when a run they wrote finished other than complete, because the DQ gate holds such a run
// back from the pass that follows):
//   collect:cloudflare  collectCloudflare, then the Store writes in the order scripts/collect-cloudflare.ts makes
//                       them (beginRun with the asserted population, the rows, finishRun), the DNS run's vault hook
//                       after its rows; ok when both runs are complete and the hook committed, skipped or is off.
//                       commits: the DNS run's new vault commit.
//   collect:linux       collectHost over the alias (one SSH session with the fixed read script), storeRows, the vault
//                       hook; ok when the run is complete and the hook committed or is off. commits: the run's new
//                       commit.
//   probe               runProbes over the account's served names (PROBE_TARGETS_OVERRIDE's when it is set, a lab
//                       aid: src/probe/run.ts probePopulation) into the Store, with the names the vault's host heads
//                       serve under a wildcard record (vaultServedNames; the account's records alone when the vault is
//                       off); ok when the run is complete.
//   validate            validateCopies over every repository's head when the collect steps made a new commit, else
//                       nothing; ok when every repository validated, whatever each result.
//   pass                passStep with the PgLedger, the Zetaris copy of the lessons and the rules refreshed first when
//                       stale (refreshFileTables), and the context's judge (the eval's C3 judge, src/agents/falsifier.ts)
//                       when it has one; its row names the queries the pass sent through Zetaris, the
//                       context's query tally (LiveContext queries) read before and after it, with the datasource.
//   explain             explainPass (src/explain/explain.ts) over the pass's findings: one finding_cause row per
//                       ROLLBACK, FIX, ESCALATE and explained HOLD into the Store, a dry run included; ok always, an
//                       error shown as "not explained" on its row, so act never waits on a cause.
//   act                 act() over the dispositions of the runs the pass's findings came from, dry run unless apply;
//                       a pass with no finding for the tenant gives an empty plan without a read. ok when act returns.
//   tickets             ticketStep with the cycle's pass; a dry run has no adapter and no rows. The url stored on a
//                       ticket row and the step's trace lines pass the redactor over REDACT_WORDS and
//                       EXPORT_DENY_WORDS together (labelledRows, LabelTracer). ok when no operation failed or was
//                       refused.
//   document            renderDocument with the pass's finding classes and the report's reads, then the owner's report
//                       from the same rows (src/document/report.ts renderReport, the tenant's redactor over every data
//                       string, this cycle's act, tickets and explain results for What happened, the trace, the tip
//                       and the Zetaris tally), the deny-list probe (redactor.ts countLabels) over the page and the
//                       report, then both files, report.html beside document.md; ok when both are written.
// Every summary passes the tenant's redactor. Each step's view (src/loop/present.ts) is its row on the screen, built
// from the same results the summary is; the cycle passes every text of it through the redactor again as it prints,
// the collect:linux subject aside: the ssh alias as LINUX_HOSTS names it. act and tickets also hand the cycle their
// results (StepReport act, tickets) for its "what happened" block; act's view names each object from the pass.
//
// Tested by test/loop.test.ts: each step with fakes, and the pass, act, tickets and document steps over sql.js with
// test/fixtures/policy-bundle.json; the live cycle is measured in scripts/cycle.ts.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { act, actSummary, type ActorDeps } from "../actions/act.ts";
import type { PassJudge } from "../agents/falsifier.ts";
import { liveActorDeps } from "../actions/live.ts";
import { Cloudflare, collectCloudflare } from "../collectors/cloudflare.ts";
import { collectHost, storeRows, type CollectResult } from "../collectors/linux.ts";
import { config } from "../config.ts";
import { tallySince, type QueryTally } from "../data/engines/counting.ts";
import type { CollectionRun } from "../data/rows.ts";
import type { DataLayer } from "../data/layer.ts";
import type { Store } from "../data/store.ts";
import { renderDocument } from "../document/render.ts";
import { REPORT_MODE, renderReport, reportPathOf } from "../document/report.ts";
import type { TechnicianMemory } from "../engine/memory.ts";
import { CAUSE_CLASSES } from "../explain/cause.ts";
import { EXPLAINER, explainPass, type CauseSink } from "../explain/explain.ts";
import { PgLedger } from "../ledger.ts";
import { probePopulation, runProbes, vaultServedNames, type ProbeDeps, type ProbeSink } from "../probe/run.ts";
import type { PopulationRecord } from "../probe/rules.ts";
import { GithubIssues } from "../psa/github.ts";
import type { TicketAdapter } from "../psa/index.ts";
import { storeTicketRows, ticketStep, type TicketRows } from "../psa/step.ts";
import { Redactor, countLabels } from "../redactor.ts";
import type { Tracer } from "../trace.ts";
import { CLOUDFLARE_REPO, latestCommit, repositoryDir, vaultRepositories } from "../validate/vault.ts";
import { storeCopies, validateCopies, type CopyStore } from "../validate/run.ts";
import type { NginxRunner } from "../validate/nginx.ts";
import { vaultCloudflareRun, vaultLinuxRun, type HookResult } from "../vault/hook.ts";
import type { Vault } from "../vault/vault.ts";
import { refreshFileTables } from "../zetaris/setup.ts";
import type { CollectReport, CycleSteps, NewCommit, PassReport, StepReport } from "./cycle.ts";
import { passStep, type PassStep } from "./pass.ts";
import { actView, cloudflareView, documentView, explainView, linuxView, passView, probeView, ticketsView, validateView, type ActFacts, type CauseFacts, type TicketFacts } from "./present.ts";
import { LabelTracer } from "./trace.ts";

const runLine = (r: Pick<CollectionRun, "run_id" | "observed_count" | "expected_count" | "status">): string => `${r.run_id} ${r.observed_count ?? 0}/${r.expected_count ?? "?"} ${r.status}`;

/** A hook result in a few words, and its new commit. */
function hookText(h: HookResult): { text: string; commits: NewCommit[] } {
  if (h.status === "committed") {
    const c = h.commit;
    return {
      text: `vault ${c.reused ? "commit of an earlier write" : "committed"} ${c.commit.slice(0, 12)} (${c.files} files, ${c.added} added, ${c.modified} modified, ${c.removed} removed; vault_copy ${h.written} written)`,
      commits: c.reused ? [] : [{ repo: c.repo, commit: c.commit }],
    };
  }
  if (h.status === "skipped") return { text: `vault: ${h.reason}`, commits: [] };
  if (h.status === "failed") return { text: `vault failed: ${h.error}`, commits: [] };
  return { text: "vault off (DRIFT_VAULT_DIR is blank)", commits: [] };
}

export type CloudflareStore = Pick<Store, "beginRun" | "finishRun" | "insertDnsRecords" | "insertObservations" | "insertAuditEvents" | "insertVaultCopies">;

/** collect:cloudflare: the DNS records and the account audit log into the Store, the DNS run into the vault. */
export async function collectCloudflareStep(o: { tenant: string; cf: Cloudflare; redactor: Redactor; store: CloudflareStore; vault: Vault | null; tracer?: Tracer; now?: () => Date }): Promise<CollectReport> {
  const c = await collectCloudflare(o.cf, o.redactor, { tenantId: o.tenant, now: o.now });
  let hook: HookResult = { status: "off" };
  const writes: [CollectionRun, () => Promise<void>][] = [
    [c.dnsRun, async () => { await o.store.insertDnsRecords(c.records); await o.store.insertObservations(c.observations); }],
    [c.auditRun, async () => { await o.store.insertAuditEvents(c.events); }],
  ];
  for (const [run, write] of writes) {
    await o.store.beginRun(run);
    try {
      await write();
    } catch (e) {
      await o.store.finishRun(run.run_id, 0, "failed").catch(() => undefined);
      throw e;
    }
    await o.store.finishRun(run.run_id, run.observed_count ?? 0, run.status === "running" ? "failed" : run.status, run.finished_at ?? undefined);
    if (run === c.dnsRun) hook = await vaultCloudflareRun(o.vault, o.store, c, c.rawRecords, { redactor: o.redactor, tracer: o.tracer });
  }
  const v = hookText(hook);
  const complete = c.dnsRun.status === "complete" && c.auditRun.status === "complete";
  const summary = o.redactor.text(`collect:cloudflare: dns ${runLine(c.dnsRun)} (${c.zones.length} zones, ${c.records.length} records), audit ${runLine(c.auditRun)}; ${v.text}`);
  const reason = !complete
    ? o.redactor.text(`a Cloudflare run finished other than complete (dns ${c.dnsRun.status}, audit ${c.auditRun.status})${c.errors.length ? `: ${c.errors.join("; ")}` : ""}`)
    : hook.status === "failed" ? o.redactor.text(v.text) : undefined;
  const view = cloudflareView({ records: c.records.length, zones: c.zones.length, audit: c.auditRun.observed_count ?? c.events.length, hook });
  return { ok: reason === undefined, summary, reason, commits: v.commits, detail: c.errors, view };
}

export type Collect = (alias: string, opts: { tenantId: string; redactor: Redactor; tracer?: Tracer }) => Promise<CollectResult>;
export type StoreRows = (store: Store, rows: CollectResult["rows"]) => Promise<Record<string, number>>;

/** collect:linux <alias>: one host's read session into the Store, its run into the vault. */
export async function collectLinuxStep(alias: string, o: { tenant: string; redactor: Redactor; store: Store; vault: Vault | null; tracer?: Tracer; collect?: Collect; storeRows?: StoreRows }): Promise<CollectReport> {
  const res = await (o.collect ?? collectHost)(alias, { tenantId: o.tenant, redactor: o.redactor, tracer: o.tracer });
  const written = await (o.storeRows ?? storeRows)(o.store, res.rows);
  const hook = await vaultLinuxRun(o.vault, o.store, res, { tenantId: o.tenant, alias, redactor: o.redactor, tracer: o.tracer });
  const v = hookText(hook);
  const run = res.summary.run;
  const summary = o.redactor.text(`collect:linux ${alias}: ${res.summary.host} run ${runLine(run)}, ${written.observation ?? 0} observation(s) written of ${res.rows.observation.length}, ${res.summary.servers.length} server blocks, ${res.rows.backup_item.length} backup items; ${v.text}`);
  const reason = run.status !== "complete"
    ? o.redactor.text(`run ${run.run_id} of ${alias} is ${run.status}${res.summary.not_readable.length ? ` (not readable: ${res.summary.not_readable.join(", ")})` : ""}`)
    : hook.status === "failed" ? o.redactor.text(v.text) : undefined;
  const view = linuxView(alias, { files: run.observed_count ?? 0, blocks: res.summary.servers.length, settings: written.observation ?? 0, hook });
  return { ok: reason === undefined, summary, reason, commits: v.commits, view };
}

/** probe: http, dns and tls on every served name of the account, one probe run into the Store. */
export async function probeStep(o: { tenant: string; redactor: Redactor; sink: ProbeSink; population: () => Promise<readonly PopulationRecord[]>; deps?: Partial<ProbeDeps> }): Promise<StepReport> {
  const r = await runProbes({ tenantId: o.tenant, population: o.population, redactor: o.redactor, sink: o.sink, deps: o.deps });
  const tally = (["http", "dns", "tls"] as const).map((k) => {
    const of = r.rows.filter((p) => p.kind === k);
    const skipped = of.filter((p) => p.status === "skipped").length;
    return `${k} ${of.filter((p) => p.status === "ok").length} ok, ${of.filter((p) => p.status === "fail").length} fail${skipped ? `, ${skipped} skipped` : ""}`;
  }).join("; ");
  const summary = o.redactor.text(`probe: run ${runLine(r.run)}, ${r.names} name(s); ${tally}; ${r.written} probe row(s) written`);
  const ok = r.run.status === "complete";
  return { ok, summary, reason: ok ? undefined : o.redactor.text(`probe run ${r.run.run_id} is ${r.run.status}${r.errors.length ? `: ${r.errors.slice(0, 5).join("; ")}` : ""}`), detail: r.errors, view: probeView({ names: r.names, rows: r.rows }) };
}

/** validate: nginx-t and cf-schema over every repository's head, when this cycle committed. */
export async function validateStep(commits: readonly NewCommit[], o: { tenant: string; vaultDir: string; store: CopyStore | null; redactor: Redactor; runner?: NginxRunner; validatedAt?: string }): Promise<StepReport> {
  if (!commits.length || !o.vaultDir) return { ok: true, summary: "validate:copies: no new vault commit this cycle; nothing validated", view: validateView(null) };
  const res = await validateCopies({ vaultDir: o.vaultDir, tenant: o.tenant, dryRun: false, store: o.store, redactor: o.redactor, runner: o.runner, validatedAt: o.validatedAt });
  const repos = vaultRepositories(o.vaultDir, o.tenant);
  const heads = [...repos.hosts, ...(repos.cloudflare ? [CLOUDFLARE_REPO] : [])].map((n) => latestCommit(repositoryDir(o.vaultDir, o.tenant, n)));
  const fresh = new Set(commits.map((c) => c.commit));
  const results = [...res.rows.reduce((m, r) => m.set(`${r.validator} ${r.result}`, (m.get(`${r.validator} ${r.result}`) ?? 0) + 1), new Map<string, number>())]
    .sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(", ") || "no rows";
  const summary = o.redactor.text(`validate:copies: ${heads.length} repositories at their heads, ${heads.filter((h) => h !== null && fresh.has(h)).length} of them this cycle's commits; copy_validation ${res.written ?? 0} row(s) written of ${res.rows.length} (${results}); ${res.errors} repositories not validated`);
  // nginx-t validates a host repository's tree as one: its result once per repository, from the repository's line
  const nginx = res.lines.map((l) => l.match(/: nginx-t (ok_with_gaps|ok|fail),/)?.[1]).filter((r): r is string => r !== undefined);
  const view = validateView({ heads: heads.length, nginx, rows: res.rows, errors: res.errors });
  return { ok: res.errors === 0, summary, reason: res.errors ? o.redactor.text(res.lines.filter((l) => /validation stopped|no vault repository/.test(l)).join("; ")) : undefined, detail: res.lines, view };
}

/**
 * explain: who or what changed each setting the pass moves on, from the evidence the agent holds (src/explain/), one
 * finding_cause row per explained disposition through `sink`; a dry run computes and stores them too. Never fails the
 * cycle: an error reads "not explained" on the row and act runs as before, because a cause changes no disposition.
 */
export async function explainStep(layer: DataLayer, pass: PassStep, o: { sink: CauseSink | null; vault: Vault | null; redactor: Redactor; tracer?: Tracer }): Promise<StepReport> {
  try {
    const r = await explainPass(pass, { layer, vault: o.vault, redactor: o.redactor, sink: o.sink, tracer: o.tracer });
    const classes = CAUSE_CLASSES.filter((k) => r.counts[k]).map((k) => `${k} ${r.counts[k]}`).join(", ") || "none";
    const written = r.written === null ? "no sink, nothing written" : `finding_cause ${r.written} row(s) written`;
    const summary = o.redactor.text(`explain: tenant ${pass.tenant}, ${r.causes.length} cause(s) (${classes}); searched ${r.searched.journal} journal and ${r.searched.cloudflare} cloudflare row(s) and ${r.searched.actions} ledger action(s); ${written}${r.errors.length ? `; ${r.errors.length} error(s): ${r.errors.join("; ")}` : ""}`);
    return { ok: true, summary, detail: r.causes.map((c) => `${c.finding_id} ${c.verb} ${c.cause.class}: ${c.cause.summary}`), view: explainView({ causes: r.causes.map((c) => c.cause) }), explain: r };
  } catch (e) {
    const why = o.redactor.text(e instanceof Error ? e.message : String(e));
    o.tracer?.emit({ agent: EXPLAINER, action: "explain", status: "failed", input_summary: `explain ${pass.tenant}`, output_summary: `explain: not explained: ${why}`, detail: "model: none" });
    return { ok: true, summary: `explain: tenant ${pass.tenant}, not explained (${why}); act runs as before`, view: explainView({ causes: [], stopped: why }) };
  }
}

/** act: the Actor over the dispositions of the pass's runs. */
export async function actStep(pass: PassStep, o: { apply: boolean; deps: ActorDeps; redactor: Redactor }): Promise<StepReport> {
  const runIds = [...new Set(pass.findings.map((f) => f.finding.run_id))].sort();
  if (!runIds.length) {
    const none = { apply: o.apply, plan: [], outcomes: [], acted: [] };
    return { ok: true, summary: `act: ${o.apply ? "applied" : "dry run"}: the pass raised no finding for tenant ${pass.tenant}; 0 actions planned`, view: actView(none), act: none };
  }
  const res = await act({ tenantId: pass.tenant, apply: o.apply, runIds }, o.deps);
  const verbs = Object.entries(res.scope.verbs).map(([v, n]) => `${v} ${n}`).join(", ") || "none";
  return { ok: true, summary: o.redactor.text(`${actSummary(res)}; scope ${res.scope.dispositions} disposition(s) of ${res.scope.runs.length} run(s) (${verbs}), ledger ${res.ledger} of the tenant`), view: actView(res, pass), act: res };
}

/**
 * The ticket rows with every stored url through `labels` first. The PSA's url names the tickets repository, and its
 * owner can be an EXPORT_DENY_WORDS label, which the tenant's redactor leaves in place (it pseudonymises REDACT_WORDS);
 * the url then goes to the row as the pseudonym pass e gives the label.
 */
export function labelledRows(rows: TicketRows, labels: Redactor): TicketRows {
  return { insert: (xs) => rows.insert(xs.map((t) => (t.url ? { ...t, url: labels.text(t.url) } : t))), update: (id, p) => rows.update(id, p.url ? { ...p, url: labels.text(p.url) } : p) };
}

/**
 * tickets: the PSA step for the cycle's pass. `labels`, the redactor over REDACT_WORDS and EXPORT_DENY_WORDS together,
 * takes the stored urls (labelledRows) and the step's trace lines; what is sent passes the step's own redactor and
 * deny-list probe (src/psa/index.ts outgoing).
 */
export async function ticketsStep(layer: DataLayer, pass: PassStep, o: { adapter: () => TicketAdapter | null; rows: TicketRows | null; dryRun: boolean; redactor: Redactor; labels: Redactor; deny: readonly string[]; tracer?: Tracer; now?: () => string }): Promise<StepReport> {
  const adapter = o.dryRun ? null : o.adapter();
  const rows = o.dryRun || !o.rows ? null : labelledRows(o.rows, o.labels);
  const tracer = o.tracer ? new LabelTracer(o.tracer, o.labels) : undefined;
  // each operation's line goes to the trace (one line per operation); stdout carries the step's summary
  const r = await ticketStep(layer, pass.pass, adapter, rows, { tenant: pass.tenant, dryRun: o.dryRun, redactor: o.redactor, deny: o.deny, tracer, now: o.now, print: () => undefined });
  const bad = r.outcomes.filter((x) => x.status === "failed" || x.status === "refused");
  return { ok: bad.length === 0, summary: o.labels.text(r.summary), reason: bad.length ? o.labels.text(bad.map((x) => x.line).join("; ")) : undefined, view: ticketsView(r, o.dryRun), tickets: r };
}

/** What the cycle hands the document step for the owner's report: the act, tickets and explain results of this cycle. */
export interface ReportFacts { act: ActFacts | null; actSettled: boolean; tickets: TicketFacts | null; causes: readonly CauseFacts[] }

export interface DocumentStepOptions {
  out: string;
  root: string;
  deny: readonly string[];
  source: string;
  tracer?: Tracer;
  /** The owner's report beside the page (src/document/report.ts): its redactor, mode and run facts. Absent, the report is written with the redactor below and no run facts. */
  report?: {
    redactor: Redactor;
    apply: boolean;
    trace?: { id: string; path: string } | null;
    tip?: string | null;
    policyFile?: string | null;
    /** The queries the cycle's DataLayer has sent through Zetaris so far. */
    queries?: () => QueryTally;
    datasource?: string;
  };
}

/**
 * document: the owner's page from SQL and the owner's report from the same rows (report.html beside the page,
 * src/document/report.ts reportPathOf), both through the deny-list probe, then both files; one match and neither is
 * written. `facts` carries this cycle's act, tickets and explain results for the report's What happened.
 */
export async function documentStep(layer: DataLayer, pass: PassStep, o: DocumentStepOptions, facts?: ReportFacts): Promise<StepReport> {
  const doc = await renderDocument(layer, { tenant: pass.tenant, classes: new Map(pass.pass.findings.map((f) => [f.id, f.finding.class])), source: o.source, tracer: o.tracer, report: true });
  const r = o.report;
  const tally = r?.queries?.();
  const html = renderReport(doc.data, {
    redactor: r?.redactor ?? new Redactor(config.redactSalt || "document-report", config.redactWords),
    mode: r?.apply ? REPORT_MODE.applied : REPORT_MODE.dryRun,
    trace: r?.trace ?? null, tip: r?.tip ?? null, policyFile: r?.policyFile ?? null,
    findings: pass.findings, act: facts?.act ?? null, actSettled: facts?.actSettled ?? false, tickets: facts?.tickets ?? null, causes: facts?.causes,
    zetaris: tally ? { datasource: r?.datasource ?? config.zetaris.datasource, queries: tally.queries, rows: tally.rows, failed: tally.failed } : null,
  });
  const reportOut = reportPathOf(o.out);
  const hits = Object.keys(countLabels(doc.markdown, o.deny)).length;
  const reportHits = Object.keys(countLabels(html, o.deny)).length;
  const rel = path.relative(o.root, o.out).replace(/\\/g, "/");
  const reportRel = path.relative(o.root, reportOut).replace(/\\/g, "/");
  if (hits) return { ok: false, summary: `document: deny-list probe: ${hits} of ${o.deny.length} configured label(s) appear in the page; nothing written`, reason: `the deny-list probe matched ${hits} label(s) in the page` };
  if (reportHits) return { ok: false, summary: `document: deny-list probe: ${reportHits} of ${o.deny.length} configured label(s) appear in the report; nothing written`, reason: `the deny-list probe matched ${reportHits} label(s) in the report` };
  writeFileSync(o.out, doc.markdown);
  writeFileSync(reportOut, html);
  const queries = doc.queries.reduce((n, c) => n + c.runs, 0);
  return {
    ok: true,
    view: documentView({ file: rel, lines: doc.markdown.split("\n").length - 1, report: path.basename(reportOut) }),
    summary: `document: ${rel} and ${reportRel} written for ${pass.tenant}, ${doc.markdown.split("\n").length - 1} lines, ${doc.open} finding(s) open, ${queries} queries; deny-list probe 0 of ${o.deny.length} label(s); ${doc.decidedAt ? `decided at ${doc.decidedAt}` : "no decision on the latest passing runs"}`,
  };
}

export interface LiveContext {
  tenant: string;
  apply: boolean;
  /** The tickets step plans and sends nothing. */
  ticketsDryRun: boolean;
  redactor: Redactor;
  /** The redactor over REDACT_WORDS and EXPORT_DENY_WORDS together: the tickets step's stored urls and trace lines. */
  labels: Redactor;
  deny: readonly string[];
  store: Store;
  vault: Vault | null;
  vaultDir: string;
  /** The DataLayer over ZetarisEngine: every read of the pass, the Actor, the ticket step and the document. */
  layer: DataLayer;
  tracer: Tracer;
  memory?: TechnicianMemory;
  /** The pass's judge (src/agents/falsifier.ts liveJudge): the eval's C3 judge on every finding the withdraw rule leaves open; absent, the pass runs no model. */
  judge?: PassJudge | null;
  /** The layer's query tally so far (src/data/engines/counting.ts); the pass row names the queries the pass sent when given. */
  queries?: () => QueryTally;
  /** The document's path, and the root it is shown relative to; the report goes beside it. */
  out: string;
  root: string;
  source: string;
  /** The cycle's trace file, relative to root, as the report's footer names it. */
  traceFile?: string;
  /** The repository's tip commit, when it can be read. */
  tip?: string | null;
}

/** The live steps: the operator's hosts and zones, the app Postgres, the vault, Zetaris, Nightshift on --apply, GitHub Issues. */
export function liveSteps(ctx: LiveContext): CycleSteps {
  const { tenant, redactor, store, vault, layer, tracer } = ctx;
  return {
    collectCloudflare: () => collectCloudflareStep({ tenant, cf: new Cloudflare(), redactor, store, vault, tracer }),
    collectLinux: (alias) => collectLinuxStep(alias, { tenant, redactor, store, vault, tracer }),
    probe: () => {
      const cf = new Cloudflare();
      // the names the hosts serve (the vault's host heads) bring in the names a wildcard record covers
      const served = vault ? () => vaultServedNames(vault, tenant) : undefined;
      return probeStep({ tenant, redactor, sink: store, population: probePopulation({ source: () => cf, served, tracer, agent: "probe" }) });
    },
    validate: (commits) => validateStep(commits, { tenant, vaultDir: ctx.vaultDir, store: storeCopies(store), redactor }),
    pass: async (): Promise<PassReport> => {
      const before = ctx.queries?.();
      const r = await passStep(layer, { tenant, ledger: new PgLedger(store), memory: ctx.memory, tracer, refreshFiles: () => refreshFileTables(), ...(ctx.judge ? { judge: ctx.judge } : {}) });
      const sent = before && ctx.queries ? { datasource: config.zetaris.datasource, ...tallySince(before, ctx.queries()) } : undefined;
      return { ok: true, summary: redactor.text(r.summary), pass: r, view: passView(r, sent) };
    },
    explain: (pass) => explainStep(layer, pass, { sink: store, vault, redactor, tracer }),
    act: (pass) => {
      const deps = liveActorDeps({ tenantId: tenant, apply: ctx.apply, layer, store, vault, redactor, tracer });
      const byId = new Map(pass.findings.map((f) => [f.id, f]));
      return actStep(pass, { apply: ctx.apply, redactor, deps: { ...deps, findingOf: async (d) => byId.get(d.finding_id) ?? null } });
    },
    tickets: (pass) => ticketsStep(layer, pass, {
      adapter: () => new GithubIssues({ redactor, deny: ctx.deny }), rows: storeTicketRows(store), dryRun: ctx.ticketsDryRun, redactor, labels: ctx.labels, deny: ctx.deny, tracer,
    }),
    document: (pass, facts) => documentStep(layer, pass, {
      out: ctx.out, root: ctx.root, deny: ctx.deny, source: ctx.source, tracer,
      report: {
        redactor, apply: ctx.apply, trace: ctx.traceFile ? { id: tracer.traceId, path: ctx.traceFile } : null, tip: ctx.tip ?? null, policyFile: config.policyFile,
        queries: ctx.queries, datasource: config.zetaris.datasource,
      },
    }, facts),
  };
}
