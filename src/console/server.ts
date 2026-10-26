// The technician's console: a local HTTP server on 127.0.0.1 written with node:http only, over the same DataLayer the
// agent uses (Zetaris live, sql.js in sample mode). Every page is HTML rendered here (src/console/pages.ts); the one
// script fetches only for the action POSTs.
//
// Contract:
//   - Binds the host given (127.0.0.1) and the port given (0 for an ephemeral one). A request whose Host header names
//     another host is refused (421), so a page of another origin cannot reach the console through DNS rebinding.
//   - GET /overview, /settings, /findings, /actions, /traces, /traces/view?f=<dir>/<file>, /sources, /policy,
//     /document, and /overview/report (the owner's report, src/document/report.ts renderReport over the snapshot's
//     rows, with its outbound links opening in the top window). / redirects to /overview. Anything else is 404.
//   - POST /do/unlock, /do/approve, /do/lock, /do/exception, /do/pass, form-encoded, at most 64 KB. Each carries the
//     process's CSRF token (refused 403 when it differs, when an Origin header names another origin, or when
//     Sec-Fetch-Site says cross-site); every action but the pass carries confirm=yes, which the page sets after its
//     own confirmation. With Accept: application/json the answer is { ok, title, lines }; without, the page named by
//     `return` rendered with the toast.
//       unlock     a change_window row on the object (src/policy/window.ts newWindow: who, 1 to 72 hours, why)
//       approve    src/vault/approve.ts approveRun on the object from the latest passing run of its surface and host,
//                  the vault commit of that run's copy named, then the open window closed; the lines the CLI prints
//       lock       the open window closed, nothing approved
//       exception  an accepted exception on a finding of the console's pass (src/engine/memory.ts recordException,
//                  scoped as npm run answer scopes it); in sample mode only when the console was started with --write
//       pass       src/console/state.ts runConsolePass at the clock: recorded in sample mode, a dry pass live; never act
//     A write invalidates the snapshot, so the next page reads the store again.
//   - Sample mode starts with the sample's own pass at its decision instant, as npm run sample decides, recorded into
//     the sql.js ledger; live mode starts its first dry pass in the background and serves the ledger until it ends.

import { randomBytes, timingSafeEqual } from "node:crypto";
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
import { REPORT_MODE, renderReport, repoTip, utc } from "../document/report.ts";
import { policyFileShown } from "../document/sample.ts";
import { MemoryError, TechnicianMemory, scopeValuesOf, type ScopeType } from "../engine/memory.ts";
import { PLAIN, Table, passView } from "../loop/present.ts";
import { WindowError, newWindow } from "../policy/window.ts";
import { DNS_FIELDS, approveRun, ApproveError, type ApprovalSelection } from "../vault/approve.ts";
import { barCounts, barHtml, actionsPage, decodeKey, documentPage, errorPage, findingsPage, overviewPage, passForm, policyPage, settingsPage, sourcesPage, traceViewPage, tracesPage, type SourceCount, type TraceEventRow, type TraceFile, type View } from "./pages.ts";
import { escapeHtml, layout, type Shell } from "./html.ts";
import {
  classesOf, decisionsOfLedger, decisionsOfPass, readSnapshot, runConsolePass, settingObjects, vaultCommitOf,
  type Backend, type PassRun, type SettingObject, type Snapshot,
} from "./state.ts";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const DEFAULT_PORT = 8090;
const BODY_MAX = 64 * 1024;
const SAMPLE_NOTE = "sample mode: changes live for this process";

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
}

export interface ConsoleServer {
  url: string;
  port: number;
  csrf: string;
  /** The pass the console holds, after any running one ends. */
  settled(): Promise<PassRun | null>;
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

  let pass: PassRun | null = null;
  let running: { startedAt: string; done: Promise<void> } | null = null;
  let snapshot: Promise<Snapshot> | null = null;
  let sources: Promise<SourceCount[]> | null = null;

  const snap = (): Promise<Snapshot> => {
    if (!snapshot) {
      const p = readSnapshot(b, classesOf(pass));
      snapshot = p;
      p.catch(() => { if (snapshot === p) snapshot = null; });
    }
    return snapshot;
  };
  const invalidate = (): void => { snapshot = null; sources = null; };

  const doPass = async (decidedAt: string): Promise<PassRun> => {
    const r = await runConsolePass(b, { decidedAt, trace: o.tracePasses !== false });
    pass = r;
    invalidate();
    return r;
  };
  const startPass = (decidedAt: string): Promise<void> => {
    const startedAt = clock().toISOString();
    const done = doPass(decidedAt).then(() => undefined, (e: Error) => { print(`console: the pass failed: ${b.redactor.text(redact(e.message))}`); }).finally(() => { running = null; });
    running = { startedAt, done };
    return done;
  };

  if (o.firstPass === "sync") await doPass(b.sampleInstant ?? clock().toISOString());

  const view = async (): Promise<View> => {
    const s = await snap();
    const now = clock().toISOString();
    const decisions = pass ? decisionsOfPass(pass) : decisionsOfLedger(s.doc.data.open);
    const causes = new Map<string, FindingCause>((s.doc.data.causes ?? []).map((c) => [c.disposition_id, c]));
    for (const c of pass?.explained.causes ?? []) causes.set(c.disposition_id, c.cause);
    const traces = listTraces(traceDirs);
    return {
      tenant: b.tenant, mode: b.mode, now, csrf, t, snapshot: s, pass, passRunning: running?.startedAt ?? null, decisions, source: pass ? "pass" : "ledger", causes,
      objects: settingObjects(s, decisions, causes, b.tenant, now), memoryWritable: b.memoryWritable, dataSource: b.source, traces,
      lastCycle: traces.find((f) => f.id.startsWith("cycle_")) ?? null, datasource: datasourceOf(b),
    };
  };

  const modeLine = b.mode === "sample" ? `sample mode, ${b.source}; changes live for this process` : `live, ${b.source}; passes are dry`;

  const page = async (name: Shell["page"], title: string, render: (v: View) => { body: string; extra?: string }, extra: { toast?: Toast | null; open?: string | null; bar?: boolean } = {}): Promise<string> => {
    const v = await view();
    const r = render(v);
    const c = barCounts(v);
    return layout({
      title, page: name, tenant: b.tenant, modeLine, bar: extra.bar === false ? null : barHtml(v), csrf,
      nav: { settings: v.objects.length, findings: v.decisions.length, needs: c.needs, actions: (v.snapshot.doc.data.actions ?? []).length, traces: v.traces.length },
      passForm: passForm(v, "side"), body: r.body, extra: r.extra, toast: extra.toast ? { ok: extra.toast.ok, title: extra.toast.title, lines: extra.toast.lines } : null, open: extra.open ?? null,
    });
  };

  const render = async (route: string, query: URLSearchParams, toast: Toast | null = null): Promise<{ status: number; type: string; body: string } | null> => {
    const html = (body: string, status = 200) => ({ status, type: "text/html; charset=utf-8", body });
    switch (route) {
      case "/overview": return html(await page("overview", "Overview", (v) => ({ body: overviewPage(v) }), { toast, bar: false }));
      case "/overview/report": {
        const v = await view();
        const report = renderReport(v.snapshot.doc.data, {
          redactor: b.redactor, mode: REPORT_MODE.dryRun, trace: b.mode === "live" && v.lastCycle ? { id: v.lastCycle.id, path: `${v.lastCycle.dir}/${v.lastCycle.name}` } : null,
          tip, policyFile: o.policyFile ?? policyFileShown(), findings: pass?.step.findings ?? [], bundle: b.bundle,
          links: {
            replay: null, replayAnchors: {}, document: "/document", trace: v.lastCycle ? `/traces/view?f=${encodeURIComponent(v.lastCycle.ref)}` : null,
            policy: "/policy", traces: "/traces", eval: null, readme: null, lessons: null, receipts: null,
          },
        });
        return html(report.replace("</body>", `<script>for(const a of document.querySelectorAll("a[href]"))if(!a.getAttribute("href").startsWith("#"))a.target="_top"</script>\n</body>`));
      }
      case "/settings": {
        const open = query.get("open");
        let key: string | null = null;
        if (open) try { key = open; decodeKey(open); } catch { key = null; }
        return html(await page("settings", "Settings", (v) => {
          const r = settingsPage(v, { group: query.get("group") ?? undefined, lock: query.get("lock") ?? undefined, status: query.get("status") ?? undefined, q: query.get("q") ?? undefined });
          return { body: r.body, extra: r.templates };
        }, { toast, open: key }));
      }
      case "/findings": return html(await page("findings", "Findings", (v) => ({ body: findingsPage(v) }), { toast }));
      case "/actions": return html(await page("actions", "Actions and tickets", (v) => ({ body: actionsPage(v) }), { toast }));
      case "/traces": return html(await page("traces", "Traces", (v) => ({ body: tracesPage(v) }), { toast }));
      case "/traces/view": {
        const ref = query.get("f") ?? "";
        const f = listTraces(traceDirs).find((x) => x.ref === ref);
        if (!f) return html(await page("traces", "Trace not found", () => ({ body: errorPage(`No trace ${ref} in ${traceDirs.map((d) => d.label).join(" or ")}.`) })), 404);
        const dir = traceDirs.find((d) => d.label === f.dir)!;
        const { events, skipped } = readTrace(path.join(dir.dir, f.name), (s) => b.redactor.text(redact(s)));
        return html(await page("traces", `Trace ${f.id}`, (v) => ({ body: traceViewPage(v, f, events, skipped) })));
      }
      case "/sources": {
        sources ??= countSources(b);
        const counts = await sources;
        return html(await page("sources", "Sources", (v) => ({ body: sourcesPage(v, counts) }), { toast }));
      }
      case "/policy": return html(await page("policy", "Policy", (v) => ({ body: policyPage(v) })));
      case "/document": return html(await page("document", "The owner's document", (v) => ({ body: documentPage(v) })));
      default: return null;
    }
  };

  // ---- the actions ----

  const objectOf = async (keyParam: string): Promise<SettingObject> => {
    let key: string;
    try { key = decodeKey(keyParam); } catch { throw new ActionError("the form names no object"); }
    const v = await view();
    const obj = v.objects.find((x) => x.key === key);
    if (!obj) throw new ActionError("the object is not in the latest passing runs of this tenant");
    return obj;
  };
  const sampleLine = (): string[] => (b.mode === "sample" ? [SAMPLE_NOTE] : []);
  const objectName = (obj: SettingObject): string => (obj.kind === "file" ? `${obj.object_id} on ${obj.host}` : `record ${obj.name}`);

  const actions: Record<string, (f: URLSearchParams) => Promise<Toast>> = {
    unlock: async (f) => {
      const obj = await objectOf(f.get("key") ?? "");
      if (obj.window) throw new ActionError(`a change window is open on ${objectName(obj)} until ${obj.window.until}; Lock or Approve closes it first`);
      const hours = Number(f.get("hours") ?? "");
      const row = newWindow({ tenant: b.tenant, surface: obj.surface, host: obj.host, object_id: obj.object_id, who: f.get("who") ?? "", why: f.get("why") ?? "", hours, now: clock(), redact: (s) => b.redactor.text(redact(s)) });
      const n = await b.windows.open(row);
      invalidate();
      return {
        ok: true, title: `Change window open on ${obj.kind === "file" ? obj.object_id : obj.name} until ${utc(row.until)}`,
        lines: [`change_window ${row.window_id}: ${n} row written`, `opened by ${row.opened_by} at ${row.opened_at} until ${row.until}: ${row.reason}`, "the next pass holds a drift on this object that a rule would roll back, fix or hold, until the window ends", ...sampleLine()],
      };
    },
    approve: async (f) => {
      const obj = await objectOf(f.get("key") ?? "");
      const host = obj.surface === "cloudflare.dns" ? null : obj.host;
      const run = await b.approvals.latestPassingRun(b.tenant, obj.surface, host);
      if (!run) throw new ActionError(`no passing ${obj.surface} run for ${b.tenant}${host ? ` on ${host}` : ""}`);
      const observations = await b.approvals.observationsOf(run.run_id);
      let selection: ApprovalSelection;
      if (obj.kind === "file") selection = { kind: "object", host: host!, object_id: obj.object_id };
      else {
        if (!observations.some((x) => x.object_id === obj.object_id && (DNS_FIELDS as readonly string[]).includes(x.setting_path))) throw new ActionError(`record ${obj.object_id} has no field observation in run ${run.run_id}`);
        selection = { kind: "record", record_id: obj.object_id };
      }
      const by = b.redactor.text(redact((f.get("by") ?? "").trim() || "operator"));
      const noteRaw = (f.get("note") ?? "").trim();
      let r;
      try {
        r = await approve(b.approvals, { tenant: b.tenant, run, observations, selection, by, note: noteRaw ? b.redactor.text(redact(noteRaw)) : null, now: clock(), dryRun: false });
      } catch (e) {
        if (e instanceof ApproveError) throw new ActionError(e.message);
        throw e;
      }
      const commit = await vaultCommitOf(b.layer, b.tenant, run.run_id, obj.object_id).catch(() => null);
      const lines = [...r.lines, commit ? `approve: the approved bytes are run ${run.run_id}'s, vault commit ${commit.slice(0, 8)}` : `approve: the vault holds no copy from run ${run.run_id}`];
      if (obj.window) {
        const n = await b.windows.close(obj.window.window_id, clock().toISOString());
        lines.push(`change_window ${obj.window.window_id} closed (${n} row)`);
      }
      invalidate();
      return { ok: true, title: `Approved: ${obj.kind === "file" ? obj.object_id : obj.name}`, lines: [...lines, ...sampleLine()] };
    },
    lock: async (f) => {
      const obj = await objectOf(f.get("key") ?? "");
      if (!obj.window) throw new ActionError(`no change window is open on ${objectName(obj)}`);
      const at = clock().toISOString();
      const n = await b.windows.close(obj.window.window_id, at);
      invalidate();
      return { ok: true, title: `Locked: ${obj.kind === "file" ? obj.object_id : obj.name}`, lines: [`change_window ${obj.window.window_id} closed at ${at} (${n} row); nothing approved`, "the next pass treats a drift on this object as before", ...sampleLine()] };
    },
    exception: async (f) => {
      if (!b.memoryWritable) throw new ActionError(`the store is read-only in sample mode (${path.relative(ROOT, b.memoryDir).replace(/\\/g, "/") || b.memoryDir}); start the console with --write to record into it`);
      if (!pass) throw new ActionError("run a pass first: an exception is scoped on the finding as the pass raises it");
      const finding = pass.step.findings.find((x) => x.id === f.get("finding"));
      if (!finding) throw new ActionError(`no finding ${f.get("finding") ?? ""} in the console's pass`);
      const reason = (f.get("reason") ?? "").trim();
      if (!reason) throw new ActionError("reason: why the finding is accepted");
      const untilRaw = (f.get("until") ?? "").trim();
      const until = /^\d{4}-\d{2}-\d{2}$/.test(untilRaw) ? `${untilRaw}T00:00:00.000Z` : untilRaw;
      if (Number.isNaN(Date.parse(until))) throw new ActionError("until: a date, the day the exception ends (UTC)");
      const scopes = scopeValuesOf(finding.finding);
      const type: ScopeType = scopes.name.length ? "name" : scopes.host.length ? "host" : "address";
      const scopeKey = scopes[type][0];
      if (!scopeKey) throw new ActionError(`finding ${finding.id} has no host, name or address to scope a lesson on`);
      const now = clock().toISOString();
      const memory = new TechnicianMemory({ storage: "local", directory: b.memoryDir });
      let lesson;
      try {
        lesson = memory.recordException({ tenantId: finding.finding.tenant_id, findingClass: finding.finding.class, scopeKey, reason, expiresAt: new Date(until).toISOString(), provenance: { kind: "console", at: now, by: (f.get("by") ?? "").trim() || "technician", runId: finding.finding.run_id } });
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
    pass: async () => {
      if (running) throw new ActionError(`a pass is running since ${running.startedAt}`);
      const decidedAt = clock().toISOString();
      const t0 = Date.now();
      let r: PassRun | null = null;
      const done = doPass(decidedAt).then((x) => { r = x; });
      running = { startedAt: decidedAt, done };
      try { await done; } finally { running = null; }
      const p = r!;
      const lines = new Table(PLAIN, (s) => b.redactor.text(redact(s))).row("pass", passView(p.step, b.mode === "live" ? { datasource: config.zetaris.datasource, ...p.queries } : undefined), Date.now() - t0);
      return {
        ok: true, title: `${p.recorded ? "Pass" : "Dry pass"} decided at ${utc(p.decidedAt)}: ${p.step.findings.length} finding(s)`,
        lines: [...lines, `${p.queries.queries} queries through ${datasourceOf(b)}, ${p.queries.failed} failed; ${p.recorded ? "dispositions recorded in the sql.js ledger" : "nothing recorded"}; act not run`, ...(p.trace ? [`trace ${p.trace.file}`] : []), ...sampleLine()],
      };
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
  const layoutError = (msg: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Error · ConfigLeaf console</title></head><body style="font:15px/1.4 system-ui,sans-serif;margin:24px">${errorPage(msg)}</body></html>`;

  let origin = "";
  let hosts = new Set<string>();

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!hosts.has((req.headers.host ?? "").toLowerCase())) return send(res, 421, "text/plain; charset=utf-8", "the console answers on 127.0.0.1 only\n");
    const url = new URL(req.url ?? "/", origin);
    if (req.method === "GET" || req.method === "HEAD") {
      if (url.pathname === "/") { res.writeHead(303, { location: "/overview" }); res.end(); return; }
      const r = await render(url.pathname, url.searchParams);
      if (!r) return send(res, 404, "text/html; charset=utf-8", layoutError(`No page ${url.pathname}.`));
      return send(res, r.status, r.type, req.method === "HEAD" ? "" : r.body);
    }
    if (req.method !== "POST") return send(res, 405, "text/plain; charset=utf-8", "GET and POST only\n");
    const m = url.pathname.match(/^\/do\/(unlock|approve|lock|exception|pass)$/);
    if (!m) return send(res, 404, "text/plain; charset=utf-8", "no such action\n");
    const wantsJson = (req.headers.accept ?? "").includes("application/json");
    const body = await readBody(req);
    const form = new URLSearchParams(body ?? "");
    const reply = async (toast: Toast): Promise<void> => {
      const status = toast.status ?? (toast.ok ? 200 : 400);
      if (wantsJson) return send(res, status, "application/json; charset=utf-8", JSON.stringify({ ok: toast.ok, title: toast.title, lines: toast.lines }));
      const back = form.get("return") ?? "/overview";
      const r = await render(["/settings", "/findings", "/overview"].includes(back) ? back : "/overview", new URLSearchParams(), toast);
      return send(res, status, "text/html; charset=utf-8", r!.body);
    };
    if (body === null) return reply({ ok: false, status: 413, title: "Refused: the form is larger than 64 KB", lines: [] });
    const refusal = csrfRefusal(req, form);
    if (refusal) return reply({ ok: false, status: 403, title: `Refused: ${refusal}`, lines: ["reload the page for a fresh form"] });
    if (m[1] !== "pass" && form.get("confirm") !== "yes") return reply({ ok: false, title: "Confirm on the page first: the action carries its confirmation", lines: [] });
    try {
      const toast = await actions[m[1]](form);
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
  if (o.firstPass === "background") void startPass(clock().toISOString());

  return {
    url: origin, port, csrf,
    settled: async () => { if (running) await running.done; return pass; },
    close: async () => {
      if (running) await running.done.catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await b.close();
    },
  };
}

export class ActionError extends Error {}

const cap = (s: string): string => s.replace(/^./, (c) => c.toUpperCase());

function send(res: http.ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; frame-ancestors 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'",
  });
  res.end(body);
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

/** The *.jsonl files of each directory, newest first event first. */
export function listTraces(dirs: readonly { label: string; dir: string }[]): TraceFile[] {
  const out: TraceFile[] = [];
  for (const d of dirs) {
    if (!existsSync(d.dir)) continue;
    for (const name of readdirSync(d.dir)) {
      if (!TRACE_NAME.test(name)) continue;
      const file = path.join(d.dir, name);
      const st = statSync(file);
      if (!st.isFile()) continue;
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
