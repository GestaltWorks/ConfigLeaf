// The technician's console: a local HTTP server on 127.0.0.1 written with node:http only, over the same DataLayer the
// agent uses (Zetaris live, sql.js in sample mode). Every page is HTML rendered here (src/console/pages.ts); the one
// script fetches only for the action POSTs.
//
// Contract:
//   - Binds the host given (127.0.0.1) and the port given (0 for an ephemeral one). A request whose Host header names
//     another host is refused (421), so a page of another origin cannot reach the console through DNS rebinding.
//   - GET /overview, /executive?period=7d|30d|all (the executive report, src/document/executive.ts, over the period
//     ending now: the snapshot's document rows and the report's own reads), /settings, /templates, /findings, /actions,
//     /traces, /traces/view?f=<dir>/<file>, /sources, /policy, /document, /overview/report (the owner's report,
//     src/document/report.ts renderReport over the snapshot's rows, with its outbound links opening in the top window)
//     and /executive/download?period= (the executive report as one standalone file, an attachment named
//     executive-<tenant>-<period>.html by downloadName, a tenant id only, with filename and an RFC 5987 filename*; its
//     CSP the file's one style block by hash, fileCsp refusing a file with none or two). / redirects to /overview.
//     Anything else is 404. Every answer's headers come from answerHeaders: no-store, the CSP the server chose and the
//     two security headers are fixed; a route sets its content type and a download's content-disposition, nothing else.
//   - A policy whose highest version holds two rules of one family (pages.ts latestRules) is named on Templates, printed
//     once and traced once (ConsoleOptions.tracer, logs/console_*.jsonl), never tie-broken in silence.
//   - One tenant at a time: the header's switcher (POST /do/tenant) names one of the tenants the store holds runs of
//     (src/console/state.ts Backend.tenants) and every page reads that tenant's rows from then on; each tenant keeps
//     its own pass, snapshot and source counts, and its first pass runs when the switcher first names it (at the
//     sample's instant in sample mode, in the background live). A request reads the tenant it began with.
//     Every page is no-store and carries a CSP with no 'unsafe-inline': the console's pages link their stylesheet and
//     script from /assets/ (src/console/html.ts ASSETS, the path naming the content's hash, served public for a year,
//     immutable, with an ETag), and the report's one style block and two scripts carry the response's nonce.
//   - Traces: the *.jsonl files of the trace directories whose lines name the console's tenant in a command's own
//     place (traceTenants): a cycle's step lines, the live pass's file-table refresh, a receipt's app, the console's
//     pass. The viewer opens those only, and shows a ticket URL in a line as the ticket's number.
//   - POST /do/unlock, /do/approve, /do/lock, /do/exception, /do/pass, /do/tenant, form-encoded, at most 64 KB. Each
//     carries the process's CSRF token (refused 403 when it differs, when an Origin header names another origin, or
//     when Sec-Fetch-Site says cross-site); every action but the pass and the switch carries confirm=yes, which the
//     page sets after its own confirmation. With Accept: application/json the answer is { ok, title, lines }; without,
//     the page named by `return` rendered with the toast, and for a switch a 303 to that page (a page of the nav, else
//     the Overview).
//       unlock     a change_window row on the object (src/policy/window.ts newWindow: who, 1 to 72 hours, why);
//                  refused while a window is open on it, while the windows cannot be read (a window the passes cannot
//                  read holds nothing), and when the row's id is stored already (the same object at the same
//                  millisecond: a window was just opened)
//       approve    src/vault/approve.ts approveRun on the object from the latest passing run of its surface and host
//                  (by and note one line each, 1 to 200 and 0 to 500 characters), the vault commit of that run's copy
//                  named, or that the vault holds none, or that the read failed; then the open window closed; the
//                  lines the CLI prints
//       lock       the open window closed, nothing approved
//       exception  an accepted exception on a finding of the console's pass (src/engine/memory.ts recordException,
//                  scoped as npm run answer scopes it), until a date (00:00 UTC that day) or an instant in the
//                  millisecond form, nothing looser; in sample mode only when the console was started with --write
//       pass       src/console/state.ts runConsolePass at the clock: recorded in sample mode, a dry pass live; never act
//       tenant     the tenant every page reads from then on, one the store holds runs of; nothing written
//     A write invalidates every tenant's snapshot, so the next page reads the store again.
//   - Sample mode starts with the sample's own pass at its decision instant, as npm run sample decides, recorded into
//     the sql.js ledger; live mode starts its first dry pass in the background and serves the ledger until it ends.
//   - GET /api/v1 and its three endpoints (src/console/api.ts): the read-only JSON of the pages' own data, answered before the
//     page routes, after the Host rule, with the same headers; the dispatch is the only API code here.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, redact } from "../config.ts";
import type { FindingCause } from "../data/rows.ts";
import { LAYER_TABLES } from "../data/layer.ts";
import { SCHEMA_TABLES } from "../data/schema.ts";
import { FILE_DATASOURCES, FILE_TABLES } from "../data/files.ts";
import { PERIODS, evalReceipts, isPeriod, readExecutive, renderExecutive, type Executive, type ExecutiveContext, type Period } from "../document/executive.ts";
import { REPORT_MODE, renderReport, repoTip, utc } from "../document/report.ts";
import { policyFileShown } from "../document/sample.ts";
import { MemoryError, TechnicianMemory, scopeValuesOf, type ScopeType } from "../engine/memory.ts";
import { PLAIN, Table, passView } from "../loop/present.ts";
import { FileTracer, traceIdOf } from "../loop/trace.ts";
import type { Tracer } from "../trace.ts";
import { WindowError, freeText, newWindow } from "../policy/window.ts";
import { DNS_FIELDS, approveRun, ApproveError, type ApprovalSelection } from "../vault/approve.ts";
import { apiAnswer } from "./api.ts";
import {
  barCounts, barHtml, actionsPage, decodeKey, documentPage, duplicateText, errorPage, executivePage, findingsPage, latestRules, overviewPage, passForm, plainUrls, policyPage, settingsPage, sourcesPage, templatesOf,
  templatesPage, traceViewPage, tracesPage, type SourceCount, type TraceEventRow, type TraceFile, type View,
} from "./pages.ts";
import { ASSETS, escapeHtml, layout, type Asset, type Shell } from "./html.ts";
import {
  classesOf, decisionsOfLedger, decisionsOfPass, isTenantId, readSnapshot, runConsolePass, settingObjects, vaultCommitOf, withTenant,
  type Backend, type PassRun, type SettingObject, type Snapshot,
} from "./state.ts";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const DEFAULT_PORT = 8090;
const BODY_MAX = 64 * 1024;
const SAMPLE_NOTE = "sample mode: changes live for this process";
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** An instant in the canonical millisecond form that names a real time (2026-02-30 does not). */
const isoMs = (s: string): boolean => ISO_MS.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;
const STATIC = new Map<string, Asset>(Object.values(ASSETS).map((a) => [a.path, a]));

export interface Toast { ok: boolean; title: string; lines: string[]; status?: number }

export interface ConsoleOptions {
  backend: Backend;
  host?: string;
  port?: number;
  /** The console's clock: windows open and passes decide at it. */
  clock?: () => Date;
  /** The sign-off Approve runs; src/vault/approve.ts approveRun unless a test gives another. */
  approve?: typeof approveRun;
  /** Where traces are listed from, in order. */
  traceDirs?: readonly { label: string; dir: string }[];
  /** "sync" runs the first pass before listening (sample mode), "background" after (live), "none" leaves it to Run a pass. */
  firstPass?: "sync" | "background" | "none";
  /** Write a trace file per pass (logs/); the tests turn it off. */
  tracePasses?: boolean;
  /** The policy file the report's footer names. */
  policyFile?: string;
  print?: (line: string) => void;
  /** Where the console's own findings go (a duplicate rule family); default a FileTracer in logs/ when tracePasses is on, else none. */
  tracer?: Tracer;
  /** The download's renderer: src/document/executive.ts renderExecutive unless a test gives another. */
  renderFile?: typeof renderExecutive;
}

export interface ConsoleServer {
  url: string;
  port: number;
  csrf: string;
  /** The pass the console holds for the tenant the pages read, after any running one ends. */
  settled(): Promise<PassRun | null>;
  /** The tenant the pages read now. */
  tenant(): string;
  close(): Promise<void>;
}

/** The sql.js engine in sample mode and Zetaris live, as the pages name them. */
const datasourceOf = (b: Backend): string => (b.mode === "sample" ? "sql.js" : "Zetaris");

export async function startConsole(o: ConsoleOptions): Promise<ConsoleServer> {
  const b = o.backend;
  const clock = o.clock ?? (() => new Date());
  const approve = o.approve ?? approveRun;
  const csrf = randomBytes(24).toString("base64url");
  const print = o.print ?? ((l: string) => console.log(l));
  const traceDirs = o.traceDirs ?? [{ label: "logs", dir: path.resolve("logs") }, { label: "examples/traces", dir: path.join(ROOT, "examples", "traces") }];
  const t = (s: string | number | null | undefined): string => escapeHtml(b.redactor.text(s === null || s === undefined ? "" : String(s)));
  const tip = b.mode === "live" ? repoTip(ROOT) : null;

  // One state per tenant: the console's pass, a pass running, the snapshot and the source counts. The header's switcher
  // sets `current`; a request reads the tenant it began with.
  // `first` is the tenant's first pass once one is asked for: set before any await, so two requests that name a tenant
  // at once share one pass, never two.
  interface TenantState { pass: PassRun | null; running: { startedAt: string; done: Promise<void> } | null; snapshot: Promise<Snapshot> | null; sources: Promise<SourceCount[]> | null; first: Promise<void> | null }
  const states = new Map<string, TenantState>();
  let current = b.tenant;
  const st = (tenant: string): TenantState => {
    let s = states.get(tenant);
    if (!s) states.set(tenant, (s = { pass: null, running: null, snapshot: null, sources: null, first: null }));
    return s;
  };
  const be = (tenant: string): Backend => withTenant(b, tenant);

  // the console's own trace: a duplicate rule family, once per family and process, beside the line it prints
  let ownTracer: Tracer | null = o.tracer ?? null;
  const tracer = (): Tracer | null => (ownTracer ??= o.tracePasses === false ? null : new FileTracer(traceIdOf("console"), { model: "none" }));
  const reported = new Set<string>();
  const reportDuplicates = (tenant: string, s: Snapshot): void => {
    for (const d of latestRules(s.doc.data.rules).duplicates) {
      const key = `${d.family}\u001f${d.version}\u001f${d.rule_ids.join(",")}`;
      if (reported.has(key)) continue;
      reported.add(key);
      tracer()?.emit({ agent: "console", action: "check", status: "failed", input_summary: `console policy ${tenant}`, output_summary: duplicateText(d) });
      print(`console: policy: ${b.redactor.text(duplicateText(d))}`);
    }
  };

  const snap = (tenant: string): Promise<Snapshot> => {
    const s = st(tenant);
    if (!s.snapshot) {
      const p = readSnapshot(be(tenant), classesOf(s.pass));
      s.snapshot = p;
      p.then((x) => reportDuplicates(tenant, x), () => { if (s.snapshot === p) s.snapshot = null; }).catch(() => undefined);
    }
    return s.snapshot;
  };
  // A write or a pass changes the one store every tenant reads: the "*" policy rows, the lesson store and the file
  // tables are shared, and Sources counts every row of the shared tables. No write can be shown to touch one tenant's
  // rows alone, so every tenant reads the store again; a snapshot is re-read lazily, at the next page of that tenant.
  const invalidate = (): void => { for (const s of states.values()) { s.snapshot = null; s.sources = null; } };

  const doPass = async (tenant: string, decidedAt: string): Promise<PassRun> => {
    const r = await runConsolePass(be(tenant), { decidedAt, trace: o.tracePasses !== false });
    st(tenant).pass = r;
    invalidate();
    return r;
  };
  const startPass = (tenant: string, decidedAt: string): Promise<void> => {
    const s = st(tenant);
    const startedAt = clock().toISOString();
    const done = doPass(tenant, decidedAt).then(() => undefined, (e: Error) => { print(`console: the pass of ${tenant} failed: ${b.redactor.text(redact(e.message))}`); }).finally(() => { s.running = null; });
    s.running = { startedAt, done };
    return done;
  };
  /**
   * A tenant's first pass, when the console starts and when the switcher first names it: at the sample's instant in
   * sample mode, in the background live. The guard (TenantState.first) is set synchronously, before the pass is
   * awaited, so concurrent switches to one tenant wait for the one pass; a first pass that fails clears it, and the
   * next switch tries again.
   */
  const firstPass = (tenant: string): Promise<void> => {
    const s = st(tenant);
    if (s.first) return s.first;
    const run = async (): Promise<void> => {
      if (o.firstPass === "sync") {
        const r = await doPass(tenant, b.sampleInstant ?? clock().toISOString());
        print(`console: first pass of ${tenant} decided at ${r.decidedAt}`);
      } else if (o.firstPass === "background") void startPass(tenant, clock().toISOString());
    };
    const p = run().catch((e: unknown) => { if (s.first === p) s.first = null; throw e; });
    s.first = p;
    return p;
  };

  // the console's own tenant: in sample mode its pass before listening, live a dry pass once it listens
  if (o.firstPass === "sync") await firstPass(current);

  const view = async (tenant: string): Promise<View> => {
    const s = await snap(tenant);
    const state = st(tenant);
    const pass = state.pass;
    const now = clock().toISOString();
    const decisions = pass ? decisionsOfPass(pass) : decisionsOfLedger(s.doc.data.open, s.windowHolds);
    const causes = new Map<string, FindingCause>((s.doc.data.causes ?? []).map((c) => [c.disposition_id, c]));
    for (const c of pass?.explained.causes ?? []) causes.set(c.disposition_id, c.cause);
    const traces = listTraces(traceDirs, tenant);
    return {
      tenant, mode: b.mode, now, csrf, t, snapshot: s, pass, passRunning: state.running?.startedAt ?? null, decisions, source: pass ? "pass" : "ledger", causes,
      objects: settingObjects(s, decisions, causes, tenant, now), memoryWritable: b.memoryWritable, dataSource: b.source, traces,
      lastCycle: traces.find((f) => f.id.startsWith("cycle_")) ?? null, datasource: datasourceOf(b),
    };
  };

  const modeLine = b.mode === "sample" ? `sample mode, ${b.source}; changes live for this process` : `live, ${b.source}; passes are dry`;

  const page = async (tenant: string, name: Shell["page"], title: string, render: (v: View) => { body: string; extra?: string }, extra: { toast?: Toast | null; open?: string | null; bar?: boolean; returnTo?: string } = {}): Promise<string> => {
    const v = await view(tenant);
    const r = render(v);
    const c = barCounts(v);
    return layout({
      title, page: name, tenant, tenants: b.tenants, tenantsError: b.tenantsError ?? null, returnTo: extra.returnTo ?? PAGE_PATH[name], modeLine, bar: extra.bar === false ? null : barHtml(v), csrf,
      nav: { settings: v.objects.length, findings: v.decisions.length, needs: c.needs, actions: (v.snapshot.doc.data.actions ?? []).length, traces: v.traces.length, templates: templatesOf(v).length },
      passForm: passForm(v, "side"), body: r.body, extra: r.extra, toast: extra.toast ? { ok: extra.toast.ok, title: extra.toast.title, lines: extra.toast.lines } : null, open: extra.open ?? null,
    });
  };

  /** The executive report of a tenant over a period ending now, from the snapshot's document rows and the report's own reads. */
  const executive = async (tenant: string, period: Period): Promise<{ v: View; x: Executive; ctx: ExecutiveContext }> => {
    const v = await view(tenant);
    const x = await readExecutive(b.layer, v.snapshot.doc.data, { tenant, period, at: v.now, classes: classesOf(v.pass), receipts: evalReceipts(ROOT) });
    const ids = new Set(v.decisions.map((d) => d.finding_id));
    const ctx: ExecutiveContext = { redactor: b.redactor, policyFile: o.policyFile ?? policyFileShown(), bundle: b.bundle, tip, findingHref: (id) => (ids.has(id) ? `/findings#f-${id}` : null) };
    return { v, x, ctx };
  };

  /** A route's answer: its status, its type and its body, and for a download the file name; the server sets every other header (answerHeaders). */
  const render = async (tenant: string, route: string, query: URLSearchParams, toast: Toast | null = null, nonce = ""): Promise<{ status: number; type: string; body: string; attachment?: string } | null> => {
    const html = (body: string, status = 200) => ({ status, type: "text/html; charset=utf-8", body });
    switch (route) {
      case "/overview": return html(await page(tenant, "overview", "Overview", (v) => ({ body: overviewPage(v) }), { toast, bar: false }));
      case "/overview/report": {
        const v = await view(tenant);
        const report = renderReport(v.snapshot.doc.data, {
          redactor: b.redactor, mode: REPORT_MODE.dryRun, trace: b.mode === "live" && v.lastCycle ? { id: v.lastCycle.id, path: `${v.lastCycle.dir}/${v.lastCycle.name}` } : null,
          tip, policyFile: o.policyFile ?? policyFileShown(), findings: v.pass?.step.findings ?? [], bundle: b.bundle,
          links: {
            replay: null, replayAnchors: {}, document: "/document", trace: v.lastCycle ? `/traces/view?f=${encodeURIComponent(v.lastCycle.ref)}` : null,
            policy: "/policy", traces: "/traces", eval: null, readme: null, lessons: null, receipts: null,
          },
        });
        return html(nonceReport(report, nonce));
      }
      case "/executive": {
        const period = periodOf(query);
        const { x, ctx } = await executive(tenant, period);
        return html(await page(tenant, "executive", "Executive report", () => ({ body: executivePage(x, ctx) }), { toast, returnTo: `/executive?period=${period}` }));
      }
      case "/executive/download": {
        const period = periodOf(query);
        // the file is named for the tenant: an id src/policy/schema.ts TENANT reads, or no file (state.ts tenantIds lists no other)
        let attachment: string;
        try { attachment = downloadName(tenant, period); } catch (e) {
          return html(await page(tenant, "executive", "Executive report", () => ({ body: errorPage(b.redactor.text(redact((e as Error).message))) })), 400);
        }
        const { x, ctx } = await executive(tenant, period);
        // the file and its CSP before anything is sent: a renderer that fails, or a file fileCsp refuses, is a 500 page
        try {
          const file = (o.renderFile ?? renderExecutive)(x, ctx);
          fileCsp(file);
          return { status: 200, type: "text/html; charset=utf-8", body: file, attachment };
        } catch (e) {
          print(`console: the executive report of ${tenant} was not written as a file: ${b.redactor.text(redact((e as Error)?.message ?? String(e)))}`);
          return html(await page(tenant, "executive", "Executive report", () => ({ body: errorPage(`The executive report could not be written as one file: ${b.redactor.text(redact((e as Error)?.message ?? String(e))).split("\n")[0].slice(0, 200)}. The page itself still reads it.`) })), 500);
        }
      }
      case "/templates": return html(await page(tenant, "templates", "Templates", (v) => ({ body: templatesPage(v) }), { toast }));
      case "/settings": {
        const open = query.get("open");
        let key: string | null = null;
        if (open) try { key = open; decodeKey(open); } catch { key = null; }
        return html(await page(tenant, "settings", "Settings", (v) => {
          const r = settingsPage(v, { group: query.get("group") ?? undefined, lock: query.get("lock") ?? undefined, status: query.get("status") ?? undefined, q: query.get("q") ?? undefined });
          return { body: r.body, extra: r.templates };
        }, { toast, open: key }));
      }
      case "/findings": return html(await page(tenant, "findings", "Findings", (v) => ({ body: findingsPage(v) }), { toast }));
      case "/actions": return html(await page(tenant, "actions", "Actions and tickets", (v) => ({ body: actionsPage(v) }), { toast }));
      case "/traces": return html(await page(tenant, "traces", "Traces", (v) => ({ body: tracesPage(v) }), { toast }));
      case "/traces/view": {
        const ref = query.get("f") ?? "";
        const f = listTraces(traceDirs, tenant).find((x) => x.ref === ref);
        if (!f) return html(await page(tenant, "traces", "Trace not found", () => ({ body: errorPage(`No trace ${ref} of ${tenant} in ${traceDirs.map((d) => d.label).join(" or ")}.`) })), 404);
        const dir = traceDirs.find((d) => d.label === f.dir)!;
        const { events, skipped } = readTrace(path.join(dir.dir, f.name), (s) => plainUrls(b.redactor.text(redact(s))));
        return html(await page(tenant, "traces", `Trace ${f.id}`, (v) => ({ body: traceViewPage(v, f, events, skipped) })));
      }
      case "/sources": {
        const s = st(tenant);
        s.sources ??= countSources(be(tenant));
        const counts = await s.sources;
        return html(await page(tenant, "sources", "Sources", (v) => ({ body: sourcesPage(v, counts) }), { toast }));
      }
      case "/policy": return html(await page(tenant, "policy", "Policy", (v) => ({ body: policyPage(v) })));
      case "/document": return html(await page(tenant, "document", "The owner's document", (v) => ({ body: documentPage(v) })));
      default: return null;
    }
  };

  // ---- the actions ----

  const objectOf = async (tenant: string, keyParam: string): Promise<SettingObject> => {
    let key: string;
    try { key = decodeKey(keyParam); } catch { throw new ActionError("the form names no object"); }
    const v = await view(tenant);
    const obj = v.objects.find((x) => x.key === key);
    if (!obj) throw new ActionError("the object is not in the latest passing runs of this tenant");
    return obj;
  };
  const sampleLine = (): string[] => (b.mode === "sample" ? [SAMPLE_NOTE] : []);
  const objectName = (obj: SettingObject): string => (obj.kind === "file" ? `${obj.object_id} on ${obj.host}` : `record ${obj.name}`);

  const actions: Record<string, (f: URLSearchParams, tenant: string) => Promise<Toast>> = {
    unlock: async (f, tenant) => {
      const obj = await objectOf(tenant, f.get("key") ?? "");
      if (obj.window) throw new ActionError(`a change window is open on ${objectName(obj)} until ${obj.window.until}; Lock or Approve closes it first`);
      const unread = (await snap(tenant)).windowsError;
      if (unread) throw new ActionError(`the change windows are not read (${unread.split("\n")[0].slice(0, 200)}), so the passes would not read this one either; npm run zetaris:setup registers change_window`);
      const hours = Number(f.get("hours") ?? "");
      const row = newWindow({ tenant, surface: obj.surface, host: obj.host, object_id: obj.object_id, who: f.get("who") ?? "", why: f.get("why") ?? "", hours, now: clock(), redact: (s) => b.redactor.text(redact(s)) });
      const n = await b.windows.open(row);
      invalidate();
      if (n === 0) throw new ActionError(`a change window is already open on ${objectName(obj)}, or was just opened at ${row.opened_at}: change_window ${row.window_id} is stored already, nothing written`);
      return {
        ok: true, title: `Change window open on ${obj.kind === "file" ? obj.object_id : obj.name} until ${utc(row.until)}`,
        lines: [`change_window ${row.window_id}: ${n} row written`, `opened by ${row.opened_by} at ${row.opened_at} until ${row.until}: ${row.reason}`, "the next pass holds a drift on this object that a rule would roll back, fix or hold, until the window ends", ...sampleLine()],
      };
    },
    approve: async (f, tenant) => {
      const obj = await objectOf(tenant, f.get("key") ?? "");
      const host = obj.surface === "cloudflare.dns" ? null : obj.host;
      const run = await b.approvals.latestPassingRun(tenant, obj.surface, host);
      if (!run) throw new ActionError(`no passing ${obj.surface} run for ${tenant}${host ? ` on ${host}` : ""}`);
      const observations = await b.approvals.observationsOf(run.run_id);
      let selection: ApprovalSelection;
      if (obj.kind === "file") selection = { kind: "object", host: host!, object_id: obj.object_id };
      else {
        if (!observations.some((x) => x.object_id === obj.object_id && (DNS_FIELDS as readonly string[]).includes(x.setting_path))) throw new ActionError(`record ${obj.object_id} has no field observation in run ${run.run_id}`);
        selection = { kind: "record", record_id: obj.object_id };
      }
      const by = b.redactor.text(redact(freeText("by", (f.get("by") ?? "").trim() || "operator", 200, "the person or role signing it off")));
      const noteRaw = freeText("note", f.get("note") ?? "", 500, "an optional note", true);
      let r;
      try {
        r = await approve(b.approvals, { tenant, run, observations, selection, by, note: noteRaw ? b.redactor.text(redact(noteRaw)) : null, now: clock(), dryRun: false });
      } catch (e) {
        if (e instanceof ApproveError) throw new ActionError(e.message);
        throw e;
      }
      let vault: string;
      try {
        const commit = await vaultCommitOf(b.layer, tenant, run.run_id, obj.object_id);
        vault = commit ? `approve: the approved bytes are run ${run.run_id}'s, vault commit ${commit.slice(0, 8)}` : `approve: the vault holds no copy from run ${run.run_id}`;
      } catch (e) {
        vault = `approve: the vault copy of run ${run.run_id} was not read (${b.redactor.text(redact((e as Error)?.message ?? String(e))).split("\n")[0].slice(0, 200)}); the approval stands, its vault commit unnamed`;
      }
      const lines = [...r.lines, vault];
      if (obj.window) {
        const n = await b.windows.close(obj.window.window_id, clock().toISOString());
        lines.push(`change_window ${obj.window.window_id} closed (${n} row)`);
      }
      invalidate();
      return { ok: true, title: `Approved: ${obj.kind === "file" ? obj.object_id : obj.name}`, lines: [...lines, ...sampleLine()] };
    },
    lock: async (f, tenant) => {
      const obj = await objectOf(tenant, f.get("key") ?? "");
      if (!obj.window) throw new ActionError(`no change window is open on ${objectName(obj)}`);
      const at = clock().toISOString();
      const n = await b.windows.close(obj.window.window_id, at);
      invalidate();
      return { ok: true, title: `Locked: ${obj.kind === "file" ? obj.object_id : obj.name}`, lines: [`change_window ${obj.window.window_id} closed at ${at} (${n} row); nothing approved`, "the next pass treats a drift on this object as before", ...sampleLine()] };
    },
    exception: async (f, tenant) => {
      if (!b.memoryWritable) throw new ActionError(`the store is read-only in sample mode (${path.relative(ROOT, b.memoryDir).replace(/\\/g, "/") || b.memoryDir}); start the console with --write to record into it`);
      const pass = st(tenant).pass;
      if (!pass) throw new ActionError("run a pass first: an exception is scoped on the finding as the pass raises it");
      const finding = pass.step.findings.find((x) => x.id === f.get("finding"));
      if (!finding) throw new ActionError(`no finding ${f.get("finding") ?? ""} in the console's pass`);
      const reason = (f.get("reason") ?? "").trim();
      if (!reason) throw new ActionError("reason: why the finding is accepted");
      const untilRaw = (f.get("until") ?? "").trim();
      const until = /^\d{4}-\d{2}-\d{2}$/.test(untilRaw) ? `${untilRaw}T00:00:00.000Z` : untilRaw;
      if (!isoMs(until)) throw new ActionError(`until: a date YYYY-MM-DD (the exception ends at 00:00 UTC that day) or an instant YYYY-MM-DDTHH:MM:SS.mmmZ, got ${untilRaw.slice(0, 40) || "nothing"}`);
      const scopes = scopeValuesOf(finding.finding);
      const type: ScopeType = scopes.name.length ? "name" : scopes.host.length ? "host" : "address";
      const scopeKey = scopes[type][0];
      if (!scopeKey) throw new ActionError(`finding ${finding.id} has no host, name or address to scope a lesson on`);
      const now = clock().toISOString();
      const memory = new TechnicianMemory({ storage: "local", directory: b.memoryDir });
      let lesson;
      try {
        lesson = memory.recordException({ tenantId: finding.finding.tenant_id, findingClass: finding.finding.class, scopeKey, reason, expiresAt: until, provenance: { kind: "console", at: now, by: (f.get("by") ?? "").trim() || "technician", runId: finding.finding.run_id } });
      } catch (e) {
        if (e instanceof MemoryError) throw new ActionError(e.message);
        throw e;
      }
      const affected = pass.step.findings.filter((x) => x.finding.class === finding.finding.class && Object.values(scopeValuesOf(x.finding)).flat().includes(scopeKey));
      return {
        ok: true, title: `Exception recorded on ${type} ${scopeKey}`,
        lines: [
          `recorded ${lesson.id}  exception  ${lesson.findingClass} on ${lesson.scopeKey} (${lesson.tenantId})  until ${lesson.expiresAt}  by ${lesson.provenance.by} at ${lesson.recordedAt}: ${lesson.reason}`,
          `stored in ${memory.directory}; the store holds ${memory.lessons().length} lesson(s)`,
          `on the next pass ${affected.length} finding(s) of class ${finding.finding.class} on ${type} ${scopeKey} are ADOPT under this exception until ${lesson.expiresAt}, then re-raised`,
        ],
      };
    },
    pass: async (_f, tenant) => {
      const s = st(tenant);
      if (s.running) throw new ActionError(`a pass is running since ${s.running.startedAt}`);
      const decidedAt = clock().toISOString();
      const t0 = Date.now();
      let r: PassRun | null = null;
      const done = doPass(tenant, decidedAt).then((x) => { r = x; });
      s.running = { startedAt: decidedAt, done };
      try { await done; } finally { s.running = null; }
      const p = r!;
      const lines = new Table(PLAIN, (x) => b.redactor.text(redact(x))).row("pass", passView(p.step, b.mode === "live" ? { datasource: config.zetaris.datasource, ...p.queries } : undefined), Date.now() - t0);
      return {
        ok: true, title: `${p.recorded ? "Pass" : "Dry pass"} decided at ${utc(p.decidedAt)}: ${p.step.findings.length} finding(s)`,
        lines: [...lines, `${p.queries.queries} queries through ${datasourceOf(b)}, ${p.queries.failed} failed; ${p.recorded ? "dispositions recorded in the sql.js ledger" : "nothing recorded"}; act not run`, ...(p.trace ? [`trace ${p.trace.file}`] : []), ...sampleLine()],
      };
    },
    tenant: async (f) => {
      const want = f.get("tenant") ?? "";
      if (!b.tenants.includes(want)) throw new ActionError(`the store holds no run of tenant ${want.slice(0, 64) || "(none named)"}; the switcher lists ${b.tenants.join(", ")}`);
      const first = st(want).first === null;
      await firstPass(want);
      current = want;
      return { ok: true, title: `Switched to ${want}`, lines: [`every page now reads ${want}'s rows${first && st(want).pass ? `; its first pass decided at ${utc(st(want).pass!.decidedAt)}` : ""}`] };
    },
  };

  // ---- the server ----

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      const msg = b.redactor.text(redact(e?.message ?? String(e)));
      print(`console: ${req.method} ${req.url}: ${msg}`);
      if (!res.headersSent) send(res, 500, "text/html; charset=utf-8", layoutError(msg));
      else res.end();
    });
  });
  const layoutError = (msg: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Error · ConfigLeaf console</title><link rel="stylesheet" href="${ASSETS.css.path}"></head><body><main class="wrap">${errorPage(msg)}</main></body></html>`;

  let origin = "";
  let hosts = new Set<string>();

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!hosts.has((req.headers.host ?? "").toLowerCase())) return send(res, 421, "text/plain; charset=utf-8", "the console answers on 127.0.0.1 only\n");
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const a = await apiAnswer(req.method ?? "GET", url, { tenants: b.tenants, tenant: () => current, text: (s) => b.redactor.text(s), print, view: async (tenant) => { if (st(tenant).first === null) await firstPass(tenant); return view(tenant); } });
      return send(res, a.status, "application/json; charset=utf-8", req.method === "HEAD" ? "" : a.body);
    }
    if (req.method === "GET" || req.method === "HEAD") {
      // the page's tenant: the one its URL names (every link a page renders carries it), else the default the switcher set
      const asked = url.searchParams.get("tenant");
      if (asked !== null && !b.tenants.includes(asked)) return send(res, 400, "text/html; charset=utf-8", layoutError(`No tenant ${asked.slice(0, 64)}: the store holds runs of ${b.tenants.join(", ")}.`));
      const tenant = asked ?? current;
      if (st(tenant).first === null) await firstPass(tenant);
      if (url.pathname === "/") { res.writeHead(303, { ...answerHeaders("text/plain; charset=utf-8", csp("")), location: "/overview" }); res.end(); return; }
      const a = STATIC.get(url.pathname);
      if (a) return sendAsset(req, res, a);
      const nonce = randomBytes(16).toString("base64");
      const rendered = await render(tenant, url.pathname, url.searchParams, null, nonce);
      const r = rendered && !rendered.attachment ? { ...rendered, body: tenantLinks(rendered.body, tenant) } : rendered;
      if (!r) return send(res, 404, "text/html; charset=utf-8", layoutError(`No page ${url.pathname}.`), { policy: csp(nonce) });
      // a download is the executive report as one file: its style block by hash, no nonce; every other page the nonce
      const policy = r.attachment ? fileCsp(r.body) : csp(nonce);
      return send(res, r.status, r.type, req.method === "HEAD" ? "" : r.body, { policy, route: r.attachment ? { "content-disposition": contentDisposition(r.attachment) } : {} });
    }
    if (req.method !== "POST") return send(res, 405, "text/plain; charset=utf-8", "GET and POST only\n");
    const m = url.pathname.match(/^\/do\/(unlock|approve|lock|exception|pass|tenant)$/);
    if (!m) return send(res, 404, "text/plain; charset=utf-8", "no such action\n");
    const wantsJson = (req.headers.accept ?? "").includes("application/json");
    const body = await readBody(req);
    const form = new URLSearchParams(body ?? "");
    // the tenant the action acts on: the one its form was rendered for (page_tenant), never the switcher's default; a switch names its own
    const named = form.get("page_tenant");
    const tenant = named !== null && b.tenants.includes(named) ? named : null;
    const reply = async (toast: Toast): Promise<void> => {
      const status = toast.status ?? (toast.ok ? 200 : 400);
      if (wantsJson) return send(res, status, "application/json; charset=utf-8", JSON.stringify({ ok: toast.ok, title: toast.title, lines: toast.lines }));
      const back = form.get("return") ?? "/overview";
      // a switch answers with the page it came from, read again for the new tenant: a reload then asks for nothing twice
      if (m[1] === "tenant" && toast.ok) { res.writeHead(303, { ...answerHeaders("text/plain; charset=utf-8", csp("")), location: tenantLinks(`href="${returnPathOf(back)}"`, current).slice(6, -1).replaceAll("&amp;", "&") }); res.end(); return; }
      // every action returns to the same pages a switch does (RETURN_PATHS), read again with the toast, for the tenant it acted on
      const to = new URL(returnPathOf(back), origin);
      const r = await render(tenant ?? current, to.pathname, to.searchParams, toast);
      return send(res, status, "text/html; charset=utf-8", tenantLinks(r!.body, tenant ?? current));
    };
    if (body === null) return reply({ ok: false, status: 413, title: "Refused: the form is larger than 64 KB", lines: [] });
    const refusal = csrfRefusal(req, form);
    if (refusal) return reply({ ok: false, status: 403, title: `Refused: ${refusal}`, lines: ["reload the page for a fresh form"] });
    if (m[1] !== "pass" && m[1] !== "tenant" && form.get("confirm") !== "yes") return reply({ ok: false, title: "Confirm on the page first: the action carries its confirmation", lines: [] });
    if (m[1] !== "tenant" && !tenant) return reply({ ok: false, title: `Refused: the form names ${named === null ? "no tenant" : `tenant ${named.slice(0, 64)}, which the store holds no run of`}; reload the page`, lines: [] });
    try {
      const toast = await actions[m[1]](form, tenant ?? current);
      print(`console: ${m[1]}: ${toast.title}`);
      return reply(toast);
    } catch (e) {
      if (e instanceof ActionError || e instanceof WindowError) return reply({ ok: false, title: `${cap(m[1])} refused: ${b.redactor.text(redact(e.message))}`, lines: [] });
      throw e;
    }
  }

  function csrfRefusal(req: http.IncomingMessage, form: URLSearchParams): string | null {
    const given = Buffer.from(form.get("csrf") ?? "");
    const want = Buffer.from(csrf);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return "the form's token does not match this console";
    const o2 = req.headers.origin;
    if (o2 && o2 !== "null" && !hosts.has(o2.replace(/^https?:\/\//, "").toLowerCase())) return "the request comes from another origin";
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") return "the request comes from another site";
    return null;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? DEFAULT_PORT, o.host ?? "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  origin = `http://${o.host ?? "127.0.0.1"}:${port}`;
  hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (o.firstPass === "background") await firstPass(current);

  return {
    url: origin, port, csrf,
    settled: async () => { const s = st(current); if (s.running) await s.running.done; return s.pass; },
    tenant: () => current,
    close: async () => {
      for (const s of states.values()) if (s.running) await s.running.done.catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await b.close();
    },
  };
}

export class ActionError extends Error {}

const cap = (s: string): string => s.replace(/^./, (c) => c.toUpperCase());

/**
 * The owner's report as the console serves it: its own style blocks (the ones in its head) and its own script (the
 * last before </body>, src/document/report.ts) carry the response's nonce, and one more script with the nonce opens
 * its outbound links in the top window. No other tag gets the nonce, so a script tag anywhere else in the page would
 * not run; a report of another shape gets none and renders unstyled.
 */
export function nonceReport(report: string, nonce: string): string {
  const head = report.indexOf("</head>");
  const own = report.lastIndexOf("<script>");
  const end = report.lastIndexOf("</body>");
  if (head < 0 || own < head || end < own) return report;
  const tag = (t: string): string => `<${t} nonce="${nonce}">`;
  const linksOnTop = `${tag("script")}for(const a of document.querySelectorAll("a[href]"))if(!a.getAttribute("href").startsWith("#"))a.target="_top"</script>\n`;
  return `${report.slice(0, head).replaceAll("<style>", tag("style"))}${report.slice(head, own)}${tag("script")}${report.slice(own + "<script>".length, end)}${linksOnTop}${report.slice(end)}`;
}

/** The CSP of every answer: the console's own stylesheet and script by path, an inline block only with the response's nonce. */
export const csp = (nonce: string): string =>
  `default-src 'none'; style-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}; img-src 'self' data:; frame-src 'self'; frame-ancestors 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'`;

const SECURITY = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } as const;

/**
 * A page's links carry its tenant: every href, action and src to a console path (not an asset) gains tenant=<id>, so a
 * tab keeps reading the tenant it rendered for whatever another tab switches to; a tenant id needs no escaping.
 */
export function tenantLinks(html: string, tenant: string): string {
  return html.replace(/\b(href|action|src)="(\/(?!assets\/)[^"#]*)(#[^"]*)?"/g, (_m, attr: string, p: string, hash: string | undefined) =>
    `${attr}="${p}${p.includes("?") ? "&amp;" : "?"}tenant=${encodeURIComponent(tenant)}${hash ?? ""}"`);
}

/** The headers a route may set on its answer besides its type: the attachment of a download, and nothing else. */
export type RouteHeaders = { "content-disposition"?: string };
const ROUTE_HEADERS: ReadonlySet<string> = new Set(["content-disposition"]);

/**
 * The headers of one answer. The server sets the fixed ones: no-store, the CSP it chose for the answer, and the two
 * security headers. A route sets its content type (an argument of its own) and, for a download, content-disposition;
 * any other name it gives is refused with an error, so no route can set, replace or drop a fixed header.
 */
export function answerHeaders(type: string, policy: string, route: Readonly<Record<string, string>> = {}, server: { cache?: string; etag?: string } = {}): Record<string, string> {
  const other = Object.keys(route).filter((k) => !ROUTE_HEADERS.has(k.toLowerCase()));
  if (other.length) throw new Error(`a route sets its content type and content-disposition only, not ${other.join(", ")}`);
  // `server` is the server's own: the assets' year-long cache and their ETag (sendAsset); a route never passes it
  return { ...route, "content-type": type, "cache-control": server.cache ?? "no-store", ...(server.etag ? { etag: server.etag } : {}), "content-security-policy": policy, ...SECURITY };
}

/** One answer, its headers from answerHeaders: the CSP the server chose (csp("") unless given) and a route's own content-disposition. */
function send(res: http.ServerResponse, status: number, type: string, body: string, o: { policy?: string; route?: RouteHeaders } = {}): void {
  res.writeHead(status, answerHeaders(type, o.policy ?? csp(""), o.route ?? {}));
  res.end(body);
}

/** Where each page's switch returns. */
export const PAGE_PATH: Readonly<Record<Shell["page"], string>> = {
  overview: "/overview", executive: "/executive", settings: "/settings", templates: "/templates", findings: "/findings", actions: "/actions",
  traces: "/traces", sources: "/sources", policy: "/policy", document: "/document",
};
/** The paths a switch may return to, read off PAGE_PATH and the periods: a page of the nav, the executive report with its period; nothing else. */
export const RETURN_PATHS: ReadonlySet<string> = new Set([...Object.values(PAGE_PATH), ...PERIODS.map((p) => `/executive?period=${p}`)]);
/** Where a switch answers: the page it came from when RETURN_PATHS holds it, else the Overview. */
export const returnPathOf = (back: string | null): string => (back !== null && RETURN_PATHS.has(back) ? back : "/overview");
/** The period a request names; the last 7 days for none or another. */
const periodOf = (q: URLSearchParams): Period => { const p = q.get("period"); return isPeriod(p) ? p : "7d"; };

/** The downloaded executive report's file name, executive-<tenant>-<period>.html; an error when the tenant is not an id TENANT reads. */
export function downloadName(tenant: string, period: Period): string {
  if (!isTenantId(tenant)) throw new Error(`No download: the tenant ${JSON.stringify(tenant.slice(0, 64))} is not a tenant id ([A-Za-z0-9._-], up to 64), so no file is named for it.`);
  return `executive-${tenant}-${period}.html`;
}

/** RFC 5987 ext-value characters: what encodeURIComponent leaves, less ' ( ) *. */
const rfc5987 = (s: string): string => encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** An attachment's header: filename for every client, and filename* (RFC 6266 and 5987, UTF-8) beside it; the name is a downloadName. */
export function contentDisposition(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("an attachment is named by downloadName: [A-Za-z0-9._-] only");
  return `attachment; filename="${name}"; filename*=UTF-8''${rfc5987(name)}`;
}

/**
 * The CSP of the downloaded executive report: its one style block by hash, nothing else; no script runs in it. A file
 * with no style block or more than one is not the report renderExecutive writes: an error, never a guessed policy.
 */
export function fileCsp(file: string): string {
  const opened = (file.match(/<style\b/gi) ?? []).length;
  const blocks = [...file.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  if (opened !== 1 || blocks.length !== 1) throw new Error(`fileCsp: the executive report holds one style block, this file opens ${opened} and closes ${blocks.length}`);
  return `default-src 'none'; style-src 'sha256-${createHash("sha256").update(blocks[0][1]).digest("base64")}'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`;
}

/** A static part of the shell: its path names its hash, so it is cached for a year and never revalidated; an If-None-Match on its ETag is 304. */
function sendAsset(req: http.IncomingMessage, res: http.ServerResponse, a: Asset): void {
  const head = answerHeaders(a.type, csp(""), {}, { cache: "public, max-age=31536000, immutable", etag: a.etag });
  if (req.headers["if-none-match"] === a.etag) { res.writeHead(304, head); res.end(); return; }
  res.writeHead(200, { ...head, "content-length": Buffer.byteLength(a.body) });
  res.end(req.method === "HEAD" ? "" : a.body);
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => { size += c.length; if (size > BODY_MAX) over = true; else chunks.push(c); });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---- traces ----

const TRACE_NAME = /^[A-Za-z0-9._-]+\.jsonl$/;

/**
 * Where a trace names a tenant as the command's own: a cycle's step and summary lines ("cycle <tenant> [1/9] ...",
 * src/loop/cycle.ts), a pass's summary line and the live pass's file-table refresh ("pass <tenant>", "file tables
 * <tenant>", src/loop/pass.ts), a receipt's app ("... under app drift-agent-<tenant>") and the console's own pass
 * ("console pass <tenant>", src/console/state.ts). A tenant id in a query or a check's parameters is no mark: a pass
 * reads every tenant's runs.
 */
const TENANT_MARK = /"input_summary":"(?:cycle|pass|file tables|console pass) ([A-Za-z0-9._-]{1,64})(?: \[|")|under app drift-agent-([A-Za-z0-9._-]{1,64})"/g;
const marks = new Map<string, { stamp: string; tenants: ReadonlySet<string> }>();

/** The tenants a trace file names as its command's own (TENANT_MARK), read once per size and modification time. */
export function traceTenants(file: string): ReadonlySet<string> {
  let stamp = "";
  try { const st = statSync(file); stamp = `${st.size}:${st.mtimeMs}`; } catch { return new Set(); }
  const known = marks.get(file);
  if (known?.stamp === stamp) return known.tenants;
  const tenants = new Set<string>();
  try { for (const m of readFileSync(file, "utf8").matchAll(TENANT_MARK)) tenants.add(m[1] ?? m[2]); } catch { /* unreadable: no tenant */ }
  marks.set(file, { stamp, tenants });
  return tenants;
}

/** The *.jsonl files of each directory, newest first event first; with a tenant, only the files that name it as their command's own (traceTenants). */
export function listTraces(dirs: readonly { label: string; dir: string }[], tenant?: string): TraceFile[] {
  const out: TraceFile[] = [];
  for (const d of dirs) {
    if (!existsSync(d.dir)) continue;
    for (const name of readdirSync(d.dir)) {
      if (!TRACE_NAME.test(name)) continue;
      const file = path.join(d.dir, name);
      const st = statSync(file);
      if (!st.isFile()) continue;
      if (tenant !== undefined && !traceTenants(file).has(tenant)) continue;
      let first: string | null = null;
      try {
        const fd = openSync(file, "r");
        const buf = Buffer.alloc(4096);
        const n = readSync(fd, buf, 0, buf.length, 0);
        closeSync(fd);
        const line = buf.subarray(0, n).toString("utf8").split("\n")[0];
        first = line ? (JSON.parse(line) as { ts?: string }).ts ?? null : null;
      } catch { first = null; }
      out.push({ dir: d.label, name, id: name.replace(/\.jsonl$/, ""), first, size: st.size, ref: `${d.label}/${name}` });
    }
  }
  return out.sort((a, b) => ((b.first ?? "") < (a.first ?? "") ? -1 : (b.first ?? "") > (a.first ?? "") ? 1 : a.ref < b.ref ? -1 : 1));
}

/** A trace's events, every free-text field through `clean`, as the viewer shows them; lines that do not parse are counted. */
export function readTrace(file: string, clean: (s: string) => string): { events: TraceEventRow[]; skipped: number } {
  const events: TraceEventRow[] = [];
  let skipped = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      const s = (k: string): string => (typeof e[k] === "string" ? clean(e[k] as string) : "");
      events.push({ ts: typeof e.ts === "string" ? e.ts : "", agent: s("agent"), action: s("action"), status: s("status"), summary: s("output_summary") || s("input_summary"), input: s("input_summary"), detail: s("detail") });
    } catch { skipped++; }
  }
  return { events, skipped };
}

// ---- sources ----

/** The rows of each table the layer knows, the tenant's where the table has a tenant_id (every row of the two policy tables, whose rules are "*"); a count that fails is carried, not thrown. */
export async function countSources(b: Backend): Promise<SourceCount[]> {
  const defs = new Map<string, readonly string[]>([...SCHEMA_TABLES, ...FILE_TABLES].map((d) => [d.name, d.columns]));
  const files = FILE_DATASOURCES as Readonly<Record<string, string>>;
  const ds = (table: string): string => (b.mode === "sample" ? `sql.js (${files[table] ?? "the bundle"})` : files[table] ?? `${config.zetaris.datasource} (the app Postgres)`);
  return Promise.all(LAYER_TABLES.map(async (table): Promise<SourceCount> => {
    const tenant = (defs.get(table) ?? []).includes("tenant_id") && table !== "rule" && table !== "policy_rule";
    const sql = `SELECT COUNT(*) AS n FROM {{t:${table}}}${tenant ? " WHERE tenant_id = {{p:tenant_id}}" : ""}`;
    try {
      const r = await b.layer.run(sql, tenant ? { tenant_id: b.tenant } : {}, { agent: "console", limit: 1 });
      return { datasource: ds(table), table, rows: Number(r.rows[0]?.[0] ?? 0), scope: tenant ? "tenant" : "all" };
    } catch (e) {
      return { datasource: ds(table), table, rows: null, scope: tenant ? "tenant" : "all", error: b.redactor.text(redact((e as Error).message)).slice(0, 300) };
    }
  }));
}
