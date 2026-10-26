// The console's pages, rendered on the server from one View (src/console/server.ts builds it per request from the
// snapshot and the console's latest pass). Every data string passes the view's redactor before it is escaped, as the
// owner's report does; every number links to where it comes from: the findings, the document, the trace, the rule.
//
//   Work queue the landing page (/ opens it): a strip with the tenant, the last pass, the counts and Run a pass; the
//              findings that need a person as table rows (object, live against approved, why, age, status and the row
//              actions Approve, Unlock, Lock and Open); the held findings with their expiry; the adopted ones folded.
//   Object     one object on a page of its own (/object): live, approved and the template's recommendation, lock and
//              rule, last change and who made it, the restore proof, the references, the history, and the actions.
//   Overview   the owner's report (src/document/report.ts renderReport, unchanged, served at /overview/report and
//              shown in a frame), the last cycle's trace and when it ran, the decision instant.
//   Settings   every object of the latest passing runs, files per host and records per zone, one line each on a
//              wide screen (the object's name and its host or zone; the full path in the drawer): live, approved,
//              lock, template, last change, status and Approve, Unlock and Lock on the row; the ones that need
//              attention first (needs you, drifted, held, in an open window), then the rest; filters by host or
//              zone, lock and status, a search box, the columns sortable; each row opens a drawer with the object's
//              page in short (the same facts and sections as /object).
//   Findings   the current decisions by verb with their labels, reasons (every instant in them as the page formats
//              one), expiries, causes and tickets, and Record exception on each.
//   Executive  the executive report (src/document/executive.ts) for the period the switch names, with Export PDF (the
//              browser's print, the report's print stylesheet) and Download HTML (the same report as one standalone file).
//   Templates  the settings of the latest passing runs grouped by the policy rule that governs each (the rule's object
//              and setting globs, the most specific match, src/policy/resolve.ts): per template its rule, the objects
//              whose settings follow it with their counts, each one's lock under it and its status, and the deviations,
//              the objects whose findings are open under the rule; each object links to its Settings drawer.
//   Actions and tickets, Traces, Sources, and two pages the links point at: the policy rules and the document.

import type { Action, ChangeWindow, FindingCause, PolicyRule } from "../data/rows.ts";
import { PERIODS, PERIOD_SHORT, executiveSections, type Executive, type ExecutiveContext } from "../document/executive.ts";
import { untilPhrase, utc } from "../document/report.ts";
import { withRestore } from "../explain/cause.ts";
import { classLabel, findingWhere, hex8, nemotronOf, shortModel, tail, thousands } from "../loop/present.ts";
import { labelsOf } from "../psa/index.ts";
import type { Verb } from "../pipeline.ts";
import { globMatch } from "../policy/glob.ts";
import { resolvePolicy, type SettingRef } from "../policy/resolve.ts";
import { WINDOW_MAX_HOURS, WINDOW_MIN_HOURS } from "../policy/window.ts";
import { escapeHtml } from "./html.ts";
import type { PassStep } from "../loop/pass.ts";
import { STATUSES, objectKey, type ConsoleMode, type Decision, type PassRun, type SettingObject, type Snapshot, type Status } from "./state.ts";

type Row = Readonly<Record<string, string>>;

export interface TraceFile {
  /** The directory as the page names it: logs, examples/traces. */
  dir: string;
  /** The file name, <id>.jsonl. */
  name: string;
  id: string;
  /** The first event's ts; null for an empty file. */
  first: string | null;
  size: number;
  /** The viewer's parameter. */
  ref: string;
}

export interface SourceCount { datasource: string; table: string; rows: number | null; scope: "tenant" | "all"; error?: string }

export interface View {
  tenant: string;
  mode: ConsoleMode;
  now: string;
  csrf: string;
  /** Data text: redacted, then escaped. */
  t: (s: string | number | null | undefined) => string;
  snapshot: Snapshot;
  pass: PassRun | null;
  passRunning: string | null;
  decisions: Decision[];
  source: "pass" | "ledger";
  causes: ReadonlyMap<string, FindingCause>;
  objects: SettingObject[];
  memoryWritable: boolean;
  dataSource: string;
  traces: TraceFile[];
  lastCycle: TraceFile | null;
  /** The datasource the counts name: the Zetaris one live, sql.js in sample mode. */
  datasource: string;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n: number, one: string, many = `${one}s`): string => `${thousands(n)} ${n === 1 ? one : many}`;
const h12 = (h: string | null | undefined): string => (h ? h.replace(/^sha256:/, "").slice(0, 12) : "-");
const PSEUDONYM = /\b(?:host|ip|word|mail|user|domain)-[0-9a-f]{6}\b/;
/** A PSA ticket's URL (GitHub issue or pull request) as its number; any other absolute URL that carries a pseudonym points nowhere real, so it is named so, as the document page names it. */
export const plainUrls = (s: string): string => s.replace(/https?:\/\/[^\s"'<>|)]+/g, (u) => {
  const ticket = u.match(/\/(?:issues|pull)\/(\d+)(?:[/?#]|$)/);
  return ticket ? `#${ticket[1]}` : PSEUDONYM.test(u) ? "(a pseudonymised URL)" : u;
});
export const encodeKey = (key: string): string => Buffer.from(key, "utf8").toString("base64url");
export const decodeKey = (s: string): string => Buffer.from(s, "base64url").toString("utf8");
const NEEDS: readonly Verb[] = ["ESCALATE", "FIX"];

/** A rule's id as a link into the policy page. */
const ruleLink = (v: View, id: string | null | undefined): string => (id ? `<a href="/policy#${escapeHtml(id)}">${v.t(id)}</a>` : "");

/** A ticket's number: a link when its stored URL survives the redactor and names no pseudonym, else the number alone. */
function ticketRef(v: View, x: Row): string {
  const n = v.t(x.external_id ? `#${x.external_id}` : x.ticket_id);
  const url = x.url ?? "";
  const intact = /^https?:\/\//i.test(url) && v.t(url) === escapeHtml(url) && !PSEUDONYM.test(url);
  return intact ? `<a href="${escapeHtml(url)}" rel="noreferrer">${n}</a>` : `<span title="the stored URL is pseudonymised; the number is the ticket's in the PSA">${n}</span>`;
}

const ticketsOf = (v: View, findingId: string): Row[] => v.snapshot.doc.data.tickets.filter((x) => x.finding_id === findingId);

/** Where a decision's finding is, in plain words. */
function whereOf(v: View, d: Decision): string {
  if (d.finding) return findingWhere(d.finding.finding, true);
  if (d.surface === "cloudflare.dns") {
    const r = v.snapshot.records.find((x) => x.record_id === d.object_id);
    return `${r?.name ?? d.object_id}${d.setting_path ? ` ${d.setting_path}` : ""}`;
  }
  return `${tail(d.object_id)}${d.setting_path && d.setting_path !== "file" ? ` ${d.setting_path}` : ""}${d.host ? ` on ${d.host}` : ""}`;
}

/** A window's HOLD, known by the window_id its disposition carries. */
const isWindowHold = (d: Pick<Decision, "verb" | "window_id">): boolean => d.verb === "HOLD" && d.window_id !== null;
const verbBadge = (v: View, d: Pick<Decision, "verb" | "window_id">): string => `<span class="verb v-${v.t(d.verb)}${isWindowHold(d) ? " w" : ""}">${v.t(d.verb)}</span>`;

const INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z\b/g;
/** A Decider sentence with every ISO 8601 UTC instant in it as the page shows a time (25 Oct 2026 17:00 UTC). */
export const timesIn = (text: string): string => text.replace(INSTANT, (iso) => utc(iso));

// ---- the shared pieces ----------------------------------------------------------------------------------------

export interface BarCounts { needs: number; held: number; adopted: number; restoring: number; locked: number; windows: number }

export function barCounts(v: Pick<View, "decisions" | "objects">): BarCounts {
  const n = (verbs: readonly Verb[]): number => v.decisions.filter((d) => verbs.includes(d.verb)).length;
  return {
    needs: n(NEEDS), held: n(["HOLD"]), adopted: n(["ADOPT"]), restoring: n(["ROLLBACK"]),
    locked: v.objects.filter((o) => o.lock === "locked").length, windows: v.objects.filter((o) => o.lock === "window").length,
  };
}

/** The sticky summary bar: what needs a person, what is held and adopted, what is locked, which windows are open. */
export function barHtml(v: View): string {
  const c = barCounts(v);
  const dot = `<span class="dot"> · </span>`;
  const items = [
    `<a href="/findings#needs"${c.needs ? ' class="need"' : ""}><b>${thousands(c.needs)}</b> ${c.needs === 1 ? "needs" : "need"} you</a>`,
    ...(c.restoring ? [`<a href="/findings#restore"><b>${thousands(c.restoring)}</b> to restore</a>`] : []),
    `<a href="/findings#held"><b>${thousands(c.held)}</b> held</a>`,
    `<a href="/findings#adopted" class="adopted"><b>${thousands(c.adopted)}</b> adopted</a>`,
    `<a href="/settings?lock=locked" class="locked"><b>${thousands(c.locked)}</b> locked</a>`,
    `<a href="/settings?lock=window" class="${c.windows ? "window" : "zero"}"><b>${thousands(c.windows)}</b> ${c.windows === 1 ? "window" : "windows"} open</a>`,
  ];
  const decided = v.source === "pass" && v.pass ? v.pass.decidedAt : v.snapshot.doc.data.decidedAt;
  return `<header class="bar"><div class="bar-in">
<nav class="sum" aria-label="Summary">${items.join(dot)}</nav>
<div class="who"><span><b>${v.t(v.tenant)}</b></span><span>${v.source === "pass" ? (v.pass?.recorded ? "pass" : "dry pass") : "ledger"} decided ${v.t(utc(decided))}</span><span>${v.mode === "sample" ? "sample mode" : "live"}</span></div>
</div></header>`;
}

/** The work queue's strip: the tenant, the pass its rows come from, the counts as links to their sections and Run a pass. */
export function stripHtml(v: View): string {
  const c = barCounts(v);
  const stat = (href: string, n: number, label: string, cls: string): string => `<a href="${href}" class="stat ${cls}"><b>${thousands(n)}</b><span>${label}</span></a>`;
  const decided = v.source === "pass" && v.pass ? v.pass.decidedAt : v.snapshot.doc.data.decidedAt;
  return `<header class="bar strip"><div class="bar-in strip-in">
<div class="strip-id"><b>${v.t(v.tenant)}</b><span>${v.mode === "sample" ? "sample mode" : "live"} · ${v.source === "pass" ? (v.pass?.recorded ? "pass" : "dry pass") : "ledger"} decided ${v.t(utc(decided))}</span></div>
<nav class="stats" aria-label="Summary">${[
    stat("#needs", c.needs, c.needs === 1 ? "needs you" : "need you", c.needs ? "need" : "zero"),
    ...(c.restoring ? [stat("#restore", c.restoring, "to restore", "drifted")] : []),
    stat("#held", c.held, "held", "held"),
    stat("#adopted", c.adopted, "adopted", "adopted"),
    stat("/settings?lock=locked", c.locked, "locked", "locked"),
    ...(c.windows ? [stat("/settings?lock=window", c.windows, c.windows === 1 ? "window open" : "windows open", "window")] : []),
  ].join("")}</nav>
${passForm(v, "strip")}
</div></header>`;
}

/** The "Run a pass" form: the pass over the store, never act. The strip's returns to the work queue, the others to Findings. */
export function passForm(v: Pick<View, "csrf" | "mode" | "passRunning" | "tenant">, where: "side" | "page" | "strip"): string {
  const label = v.mode === "sample" ? "Run a pass" : "Run a dry pass";
  const hint = v.mode === "sample" ? "over sql.js, recorded in memory" : "through Zetaris, nothing recorded";
  if (v.passRunning) return `<p class="busy">A pass is running since ${escapeHtml(utc(v.passRunning))}.</p>`;
  const cls = where === "page" ? "" : where === "strip" ? ' class="strip-pass"' : ' class="side-pass"';
  return `<form method="post" action="/do/pass" data-action="pass"${cls}>
<input type="hidden" name="csrf" value="${escapeHtml(v.csrf)}"><input type="hidden" name="page_tenant" value="${escapeHtml(v.tenant)}"><input type="hidden" name="return" value="${where === "strip" ? "/work" : "/findings"}">
<button type="submit" class="btn${where === "side" ? " full" : " primary"}">${label}</button>
<p class="busy" data-busy="Running the pass" hidden>Running the pass</p>
${where === "page" ? `<p class="busy">${hint}; the console never runs act</p>` : ""}
</form>`;
}

/** A form's hidden fields: the console's token, the tenant the page was rendered for (the action acts on it alone), then its own. */
const hidden = (v: View, fields: Record<string, string>): string =>
  [`<input type="hidden" name="csrf" value="${escapeHtml(v.csrf)}">`, `<input type="hidden" name="page_tenant" value="${escapeHtml(v.tenant)}">`, ...Object.entries(fields).map(([k, x]) => `<input type="hidden" name="${k}" value="${escapeHtml(x)}">`)].join("");

const confirmBlock = (text: string, yes: string): string =>
  `<div class="confirm" hidden><p data-summary>${text}</p><div class="act"><button type="submit" class="btn primary" data-yes>${yes}</button><button type="button" class="btn" data-no>Cancel</button></div></div>`;

/** A page's helper text: one or two short lines; whatever more a reader may need sits behind a collapsed fold. */
const ledeHtml = (short: string, more = ""): string =>
  `<p class="lede">${short}</p>${more ? `<details class="fold more"><summary>About this page</summary><div class="more-body">${more}</div></details>` : ""}`;

// ---- Overview ---------------------------------------------------------------------------------------------------

export function overviewPage(v: View): string {
  const d = v.snapshot.doc.data;
  const cycle = v.lastCycle;
  const facts = [
    `<span>Last cycle: ${cycle ? `<a href="/traces/view?f=${encodeURIComponent(cycle.ref)}"><b>${v.t(cycle.id)}</b></a> at ${v.t(utc(cycle.first))}` : "none in logs/ or examples/traces/"}</span>`,
    `<span>Report decided at <b>${v.t(utc(d.decidedAt))}</b>, from the ledger</span>`,
    `<span>${v.pass ? `This console's ${v.pass.recorded ? "pass" : "dry pass"}: <a href="/findings">${v.t(utc(v.pass.decidedAt))}</a>${v.pass.trace ? `, trace <a href="/traces/view?f=${encodeURIComponent(`logs/${v.pass.trace.id}.jsonl`)}">${v.t(v.pass.trace.id)}</a>` : ""}` : v.passRunning ? `A pass is running since ${v.t(utc(v.passRunning))}` : "No pass from this console yet"}</span>`,
    `<span>Read through ${v.t(v.dataSource)} at ${v.t(utc(v.snapshot.readAt))}, <a href="/document#queries">${plural(v.snapshot.queries.queries, "query", "queries")}</a></span>`,
  ];
  return `<div class="head"><div><h1>Overview</h1>
${ledeHtml(`The owner's report for ${v.t(v.tenant)}, rendered from the store when this page loaded.`, `<div class="facts">${facts.join("\n")}</div>`)}</div></div>
<iframe class="report" src="/overview/report" title="The owner's report for ${v.t(v.tenant)}"></iframe>`;
}

// ---- Settings ---------------------------------------------------------------------------------------------------

const STATUS_CLASS: Readonly<Record<Status, string>> = { "with a technician": "need", drifted: "drifted", held: "held", adopted: "adopted", "in order": "ok" };
/** What a status reads as on the page; the status itself (the filter values, data-status) keeps its name. */
const STATUS_LABEL: Readonly<Record<Status, string>> = { "with a technician": "needs you", drifted: "drifted", held: "held", adopted: "adopted", "in order": "in order" };
const statusBadge = (s: Status): string => `<span class="b ${STATUS_CLASS[s]}">${STATUS_LABEL[s]}</span>`;

/** A window's end in a row: day, month and time; a window lasts 72 hours at most, and the drawer names the year. */
const shortUtc = (iso: string): string => utc(iso).replace(/ \d{4} /, " ");

function lockBadge(v: View, o: SettingObject): string {
  if (o.window) return `<span class="b window" title="${v.t(`change window ${o.window.window_id} opened by ${o.window.opened_by}, open until ${utc(o.window.until)}`)}">open until ${v.t(shortUtc(o.window.until))}</span>`;
  if (o.lock === "locked") return `<span class="b locked">locked by rule</span>`;
  return `<span class="b open">${o.rule ? "open by rule" : "open, no rule"}</span>`;
}

/**
 * A rule as a template's name: its object and setting globs. A ** · ** rule on every surface is the catch-all; one on
 * a single surface (zetaris.control) is every setting of that surface, not a second catch-all.
 */
const template = (r: PolicyRule | null): string => (!r ? "none" : r.object_glob === "**" && r.setting_glob === "**" ? (r.surface === "*" ? "everything else (catch-all)" : `every ${r.surface} setting`) : `${r.object_glob} · ${r.setting_glob}`);

/** One line: the file's name or the record's, then its host or zone; the full path or the record id in the drawer. */
function objectName(v: View, o: SettingObject): string {
  const where = o.kind === "file" ? (o.host ?? "-") : o.group.replace(/^zone /, "");
  return `<span class="on">${v.t(o.kind === "file" ? tail(o.object_id) : o.name)}</span> <span class="oh">${v.t(where)}</span>`;
}

function approvedCell(v: View, o: SettingObject): string {
  if (!o.approved) return `<span class="muted">no</span>`;
  return o.differs ? `<b>differs from live</b>` : "yes";
}

/** Attention first: with a technician, drifted, held, in an open window; then the rest. */
const ATTENTION: readonly Status[] = ["with a technician", "drifted", "held"];
const tierOf = (o: SettingObject): number => Math.min(...[ATTENTION.indexOf(o.status)].filter((i) => i >= 0), o.lock === "window" ? ATTENTION.length : ATTENTION.length + 1);

function causeText(v: View, c: FindingCause | null, actions: readonly Action[]): string {
  return c ? v.t(withRestore(c, actions)) : `<span class="muted">no record</span>`;
}

export function settingsPage(v: View, filter: { group?: string; lock?: string; status?: string; q?: string }): { body: string; templates: string } {
  const files = v.objects.filter((o) => o.kind === "file");
  const records = v.objects.filter((o) => o.kind === "record");
  const hosts = [...new Set(files.map((o) => o.group))];
  const zones = [...new Set(records.map((o) => o.group))];
  const groups = [...hosts, ...zones];
  const opt = (value: string, label: string, sel?: string): string => `<option value="${escapeHtml(value)}"${sel === value ? " selected" : ""}>${label}</option>`;
  const actions = (v.snapshot.doc.data.actions ?? []) as unknown as Action[];
  const filters = `<div class="filters" role="search">
<label>Host or zone<select data-filter="group">${opt("", "every host and zone", filter.group)}${groups.map((g) => opt(g, v.t(g), filter.group)).join("")}</select></label>
<label>Lock<select data-filter="lock">${opt("", "any lock", filter.lock)}${opt("locked", "locked by rule", filter.lock)}${opt("open", "open by rule", filter.lock)}${opt("window", "open window", filter.lock)}</select></label>
<label>Status<select data-filter="status">${opt("", "any status", filter.status)}${STATUSES.map((s) => opt(s, STATUS_LABEL[s], filter.status)).join("")}</select></label>
<label>Search<input id="q" type="search" placeholder="path, name, rule" value="${escapeHtml(filter.q ?? "")}" autocomplete="off"></label>
<span class="count" id="count" aria-live="polite">${plural(v.objects.length, "object")}</span>
</div>`;
  const rowsHtml: string[] = [];
  const templates: string[] = [];
  // the objects in their tiers, each tier in the estate's order (files before records, by host or zone, then name)
  const tiers = [[0, 1, 2, 3], [4]].map((ts) => v.objects.filter((o) => ts.includes(tierOf(o))).sort((a, c) => tierOf(a) - tierOf(c)));
  const heads = ["Needs attention: needs you, drifted, held or in an open window", "Everything else"];
  let i = 0;
  tiers.forEach((mine, t) => {
    if (!mine.length) return;
    rowsHtml.push(`<tr class="grp" data-tier="${t}"><td colspan="8">${heads[t]} · ${plural(mine.length, "object")}</td></tr>`);
    for (const o of mine) {
      const id = `o${i++}`;
      const text = [o.object_id, o.name, o.group, o.rule?.rule_id ?? "", template(o.rule), STATUS_LABEL[o.status], o.status, o.live.text].join(" ").toLowerCase();
      const full = o.kind === "file" ? `${o.object_id} on ${o.host ?? "-"}` : `${o.name}, record ${o.object_id} in ${o.group}`;
      rowsHtml.push(`<tr data-open="${id}" data-key="${escapeHtml(encodeKey(o.key))}" tabindex="0" data-group="${v.t(o.group)}" data-lock="${o.lock}" data-status="${o.status}" data-tier="${t}" data-text="${v.t(text)}" aria-label="${v.t(`${o.name}: ${STATUS_LABEL[o.status]}, ${o.lock === "window" ? "open window" : o.lock}`)}">
<td data-label="Object" title="${v.t(full)}">${objectName(v, o)}</td>
<td data-label="Live"><code>${v.t(o.live.text)}</code></td>
<td data-label="Approved">${approvedCell(v, o)}</td>
<td data-label="Lock">${lockBadge(v, o)}</td>
<td data-label="Template" class="hide-m">${o.rule ? `<a href="/policy#${escapeHtml(o.rule.rule_id)}" title="${v.t(`${o.rule.rule_id}, ${o.rule.criticality}`)}">${v.t(template(o.rule))}</a>` : `<span class="muted">none</span>`}</td>
<td data-label="Last change" class="hide-m"${o.cause ? ` title="${causeText(v, o.cause, actions)}"` : ""}>${causeText(v, o.cause, actions)}</td>
<td data-label="Status">${statusBadge(o.status)}</td>
<td data-label="Actions" class="acts-c"><div class="acts">${actionSet(v, o, "/settings", id, true)}<a class="btn sm" href="${objectHref(o)}" title="Open ${v.t(o.name)} on a page of its own">Open</a></div></td>
</tr>`);
      templates.push(drawerTemplate(v, o, id, actions));
    }
  });
  const windowsNote = v.snapshot.windowsError ? `<p class="alert">The change windows were not read: ${v.t(v.snapshot.windowsError)}. Unlock is refused until they are. The console applies sql/schema.sql live; npm run zetaris:setup registers change_window in Zetaris and refreshes the disposition table.</p>` : "";
  const sortable = (label: string, cls = ""): string => `<th scope="col" data-sort${cls ? ` class="${cls}"` : ""}>${label}</th>`;
  const body = `<div class="head"><div><h1>Settings</h1>
${ledeHtml(`${plural(v.objects.length, "object")} for ${v.t(v.tenant)}: ${plural(files.length, "file")} on ${plural(hosts.length, "host")}, ${plural(records.length, "record")} in ${plural(zones.length, "zone")}. Select a row for its detail.`,
    `<p>From the latest passing runs (<a href="/document#estate">document</a>), the ones that need attention first. The lock is the governing rule's (<a href="/policy">policy</a>); a change window opens it until the time it names. Approve makes the live value the approved one, Unlock opens a window, Lock closes it. A row opens a drawer with its full path and detail, Open a page of its own.</p>`)}</div></div>
${windowsNote}${filters}
<div class="tbl flush"><table class="set rt">
<colgroup><col class="w-obj"><col class="w-live"><col class="w-appr"><col class="w-lock"><col class="w-tpl hide-m"><col class="w-last hide-m"><col class="w-st"><col class="w-act"></colgroup>
<thead><tr>${sortable("Object")}${sortable("Live")}${sortable("Approved")}${sortable("Lock")}${sortable("Template", "hide-m")}${sortable("Last change", "hide-m")}${sortable("Status")}<th scope="col">Actions</th></tr></thead>
<tbody>
${rowsHtml.join("\n")}
</tbody>
</table></div>`;
  return { body, templates: templates.join("\n") };
}

/** A unified diff with its removed and added lines marked. */
function diffHtml(v: View, diff: string): string {
  return `<pre class="diff">${diff.split("\n").map((l) => {
    const cls = l.startsWith("---") || l.startsWith("+++") ? "hunk" : l.startsWith("@@") ? "hunk" : l.startsWith("-") ? "del" : l.startsWith("+") ? "add" : "";
    return cls ? `<span class="${cls}">${v.t(l)}</span>` : v.t(l);
  }).join("\n")}</pre>`;
}

function liveVsApproved(v: View, o: SettingObject): string {
  if (o.kind === "record") {
    const obs = v.snapshot.observations.filter((x) => x.surface === o.surface && x.object_id === o.object_id);
    const approved = v.snapshot.approvals.filter((a) => a.surface === o.surface && a.object_id === o.object_id);
    const fields = [...new Set([...obs.map((x) => x.setting_path), ...approved.map((a) => a.setting_path)])].sort(cmp);
    if (!fields.length) return `<p class="muted">The latest DNS run holds no field of this record.</p>`;
    return `<table class="rt"><thead><tr><th scope="col">Field</th><th scope="col">Live</th><th scope="col">Approved</th></tr></thead><tbody>${fields.map((f) => {
      const live = obs.find((x) => x.setting_path === f);
      const a = approved.find((x) => x.setting_path === f);
      const same = a && live && a.value_hash === live.value_hash;
      return `<tr><td data-label="Field"><code>${v.t(f)}</code></td><td data-label="Live">${live ? `<code>${v.t(live.value_redacted || h12(live.value_hash))}</code>` : `<span class="muted">absent</span>`}</td><td data-label="Approved">${a ? (same ? `the same, ${v.t(utc(a.approved_at))}` : `<b>${v.t(h12(a.value_hash))}</b>, ${v.t(utc(a.approved_at))}`) : `<span class="muted">no approval</span>`}</td></tr>`;
    }).join("")}</tbody></table>${o.cause?.diff ? diffHtml(v, o.cause.diff) : ""}`;
  }
  if (!o.approved) return `<p>No approval of record: the documentation of record holds no approved value for this file. Live ${o.live.absent ? "absent" : `<code>${v.t(h12(o.live.hash))}</code>`}.</p>`;
  const who = `approved ${v.t(utc(o.approved.approved_at))}${o.approved.approved_by ? ` by ${v.t(o.approved.approved_by)}` : ""}`;
  if (o.live.absent) return `<p><b>The latest run does not hold this file.</b> Approved <code>${v.t(h12(o.approved.value_hash))}</code>, ${who}.</p>`;
  if (!o.differs) return `<p>Live matches the approved value <code>${v.t(h12(o.approved.value_hash))}</code>, ${who}.</p>`;
  const diff = o.cause?.diff;
  return `<p><b>Live differs.</b> Approved <code>${v.t(h12(o.approved.value_hash))}</code>, ${who}; live <code>${v.t(h12(o.live.hash))}</code>.</p>
${diff ? diffHtml(v, diff) : `<p class="muted">${o.cause
    ? v.mode === "sample" ? "The explain step read no bytes to compare: sample mode reads no vault, so the hashes stand for the diff." : "The explain step found no vault copy of both sides, so the hashes stand for the diff."
    : "The vault diff comes with the cause the explain step writes when a pass moves on this file; until then the hashes stand for it."}</p>`}`;
}

function restoreProof(v: View, o: SettingObject): string {
  if (!o.copies.length) return `<p class="muted">The vault holds no copy of ${o.differs ? "the approved value of " : ""}this object: no restore is known to be possible.</p>`;
  const item = (c: Row): string => {
    const gaps = (c.missing_dependencies ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
    const val = c.result ? `${v.t(c.validator)} ${v.t(c.result)}, ${plural(gaps.length, "gap")}, validated ${v.t(utc(c.validated_at))}` : "not validated";
    return `<li>vault commit <code>${v.t(hex8(c.git_commit))}</code> taken ${v.t(utc(c.taken_at))} · ${val}${gaps.length ? `<details class="fold"><summary>the ${plural(gaps.length, "gap")} its validation names</summary><span class="rc">${v.t(gaps.join(", "))}</span></details>` : ""}</li>`;
  };
  if (!o.differs) return `<p>The copy at the vault's head:</p><ul class="hist">${o.copies.map(item).join("")}</ul>`;
  // the copy a rollback would restore: the newest copy of the approved bytes whose latest validation passed (decide.ts validCopy)
  const valid = o.copies.filter((c) => c.result === "ok" || c.result === "ok_with_gaps").at(-1);
  const rest = o.copies.filter((c) => c !== valid);
  return `${valid ? `<p>The copy a rollback restores, the newest valid copy of the approved bytes:</p><ul class="hist">${item(valid)}</ul>` : `<p><b>No copy of the approved bytes passed validation:</b> a rollback has nothing to restore from.</p>`}
${rest.length ? `<details class="fold"><summary>${plural(rest.length, "other copy", "other copies")} of the approved bytes, ${rest.filter((c) => !c.result).length} not validated</summary><ul class="hist">${rest.map(item).join("")}</ul></details>` : ""}`;
}

function regressHtml(v: View, o: SettingObject): string {
  if (o.kind === "record") return `<p class="muted">A record restores from its vault JSON through the provider; no host backup applies.</p>`;
  const r = o.host ? v.snapshot.regress.get(o.host) : undefined;
  if (!r) return `<p class="muted">No backup of this host is on record.</p>`;
  const mine = r.rows.filter((x) => x.object_id === o.object_id);
  if (!mine.length) return `<p>A restore of ${v.t(o.host)} from its newest backup keeps this file's approved value. <span class="muted">For the host: ${v.t(r.explanation)}</span></p>`;
  return `<p><b>A restore from the newest backup would regress this file:</b></p><ul class="hist">${mine.map((x) => `<li>the backup ${v.t(x.latest_snapshot_id)}, taken ${v.t(utc(x.latest_backup_at))}, holds ${x.backup_state === "absent" ? "no copy of it" : "other bytes"} than the approval of ${v.t(utc(x.approved_at))}${x.approved_by ? ` by ${v.t(x.approved_by)}` : ""}</li>`).join("")}</ul>`;
}

function referencesHtml(v: View, o: SettingObject): string {
  if (!o.references.length) return `<p class="muted">No setting of this object names another object.</p>`;
  return `<ul class="hist">${o.references.map((r) => `<li><code>${v.t(r.setting)}</code> names ${v.t(r.type)} <b>${v.t(r.id)}</b>${r.resolves.length ? `<span class="rc">resolves in the latest DNS run to ${v.t(r.resolves.join(", "))}</span>` : r.type === "dns_name" ? `<span class="rc">no record of that name in the latest DNS run</span>` : ""}</li>`).join("")}</ul>`;
}

function decisionsHtml(v: View, o: SettingObject): string {
  if (!o.decisions.length) return `<p class="muted">No finding on this object: the latest pass found it in order.</p>`;
  return `<ul class="hist">${o.decisions.map((d) => `<li>${verbBadge(v, d)}${v.t(classLabel(d.class))} · <code>${v.t(d.setting_path)}</code><span class="rc">${v.t(timesIn(d.reason))}</span><span class="rc">${d.expires_at ? `until ${v.t(utc(d.expires_at))} · ` : ""}decided ${v.t(utc(d.decided_at))} by ${v.t(d.decided_by)}${d.rule_id ? ` under ${ruleLink(v, d.rule_id)}` : ""} · <a href="/findings#f-${v.t(d.finding_id)}">${v.t(d.finding_id)}</a></span></li>`).join("")}</ul>`;
}

/** The served models and receipt ids an action names. */
function receiptsOf(v: View, a: Action): string {
  const ids = a.receipts.split(",").map((s) => s.trim()).filter(Boolean);
  if (a.kind === "investigate") {
    const n = nemotronOf(a.record.split("\n"));
    const parts = [...(n.lightning ? [`Lightning ${v.t(n.lightning.model)} on ${v.t(n.lightning.receipt)}`] : []), ...(n.judge ? [`Ultra ${v.t(n.judge.model)} on ${v.t(n.judge.receipt)}`] : [])];
    const named = [n.lightning?.receipt, n.judge?.receipt];
    return [...parts, ...ids.filter((r) => !named.includes(r)).map((r) => v.t(r))].join("; ") || "-";
  }
  return ids.map((r) => v.t(r)).join(", ") || "-";
}

function actionsHistory(v: View, o: SettingObject): string {
  if (!o.actions.length) return `<p class="muted">The agent took no action on this object.</p>`;
  return `<ul class="hist">${o.actions.map((a) => `<li><b>${v.t(a.kind)}</b> ${v.t(a.status)} · ${v.t(utc(a.started_at))}<span class="rc">${v.t(a.reason || "-")}</span><span class="rc">verification ${v.t(a.verification || "none")} · receipts ${receiptsOf(v, a)} · ${v.t(a.action_id)}</span></li>`).join("")}</ul>`;
}

function windowsHtml(v: View, o: SettingObject): string {
  const w = o.window;
  const open = w
    ? `<p><span class="b window">open until ${v.t(utc(w.until))}</span> ${v.t(untilPhrase(w.until, v.now) ?? "")}</p><dl class="kv"><dt>Opened by</dt><dd>${v.t(w.opened_by)}</dd><dt>Opened</dt><dd>${v.t(utc(w.opened_at))}</dd><dt>Why</dt><dd>${v.t(w.reason)}</dd><dt>Window</dt><dd><code>${v.t(w.window_id)}</code></dd></dl><p class="muted">Inside the window a drift on this object that a rule would roll back, fix or hold is held until the window ends; Approve or Lock ends it now.</p>`
    : `<p class="muted">No change window is open on this object${o.lock === "locked" ? ": a drift is rolled back at the next cycle under the rule" : ""}.</p>`;
  const past = o.windows.filter((x) => x !== w);
  return `${open}${past.length ? `<details class="fold"><summary>${plural(past.length, "earlier window")}</summary><ul class="hist">${past.map((x: ChangeWindow) => `<li>${v.t(utc(x.opened_at))} to ${v.t(utc(x.closed_at ?? x.until))}${x.closed_at ? " (closed)" : Date.parse(x.until) <= Date.parse(v.now) ? " (ran out)" : " (not yet open)"} · ${v.t(x.opened_by)}<span class="rc">${v.t(x.reason)}</span></li>`).join("")}</ul></details>` : ""}`;
}

const objectHref = (o: SettingObject): string => `/object?key=${encodeURIComponent(encodeKey(o.key))}`;

/**
 * An object's three actions as buttons: Approve, Unlock and Lock, each opening a small form of its own (a native
 * popover, which the top layer keeps from being clipped by a table). The form's submit names confirm=yes, so the
 * popover is the on-page confirmation and an action works with the script (one fetch POST, a toast) and without it
 * (the server renders the page with the toast). A button an object cannot take is disabled and says why. `forms`
 * false renders the buttons alone, aimed at the popovers another part of the same page holds under `uid` (the drawer
 * of a Settings row).
 */
function actionSet(v: View, o: SettingObject, ret: string, uid: string, forms: boolean): string {
  const key = encodeKey(o.key);
  const name = v.t(o.kind === "file" ? o.object_id : o.name);
  const sample = v.mode === "sample" ? " Sample mode: changes live for this process." : "";
  // the title names the object, so a row's button says which object it acts on to a screen reader as well
  const trigger = (act: string, label: string, cls: string, title: string): string => `<button type="button" class="btn sm ${cls}" popovertarget="p-${act}-${uid}" title="${title} ${name}">${label}</button>`;
  const off = (label: string, why: string): string => `<button type="button" class="btn sm" disabled title="${label}: ${escapeHtml(why)}">${label}</button>`;
  const pop = (act: string, title: string, intro: string, fields: string, go: string, cls: string): string => !forms ? "" : `<div id="p-${act}-${uid}" popover class="pop" role="dialog" aria-labelledby="p-${act}-${uid}-h"><form method="post" action="/do/${act}" data-action="${act}">
${hidden(v, { key, return: ret })}
<h3 id="p-${act}-${uid}-h">${title}</h3><p class="pop-o">${name}</p><p class="pop-i">${intro}</p>
${fields}<div class="act"><button type="submit" name="confirm" value="yes" class="btn ${cls}"${fields ? "" : " autofocus"}>${go}</button><button type="button" class="btn" popovertarget="p-${act}-${uid}" popovertargetaction="hide">Cancel</button></div>
</form></div>`;
  const approve = o.live.absent ? off("Approve", "the latest run does not hold this object, so there is no live value to approve")
    : trigger("approve", "Approve", "approve", "Approve the live value of") + pop("approve", "Approve the live value",
      `${o.differs ? "Live differs from the approval." : o.approved ? "Live is approved already: a re-run writes nothing." : "No approval of record yet."} It becomes the approved value, from the latest passing run and its vault copy${o.window ? ", and the open window closes" : ""}.${sample}`,
      `<label for="r-by-${uid}">By</label><input id="r-by-${uid}" name="by" maxlength="200" autocomplete="off" value="operator" autofocus>
<label for="r-note-${uid}">Note</label><input id="r-note-${uid}" name="note" maxlength="500" autocomplete="off" placeholder="optional">
`, "Approve", "primary");
  const unlock = o.window ? off("Unlock", `a change window is open until ${utc(o.window.until)}; Lock or Approve closes it first`)
    : trigger("unlock", "Unlock", "window", "Open a change window on") + pop("unlock", "Unlock: open a change window",
      `The next pass holds a drift on it instead of restoring it, until the window ends.${sample}`,
      `<label for="r-who-${uid}">Who</label><input id="r-who-${uid}" name="who" required maxlength="200" autocomplete="off" placeholder="the person or role making the change" autofocus>
<label for="r-h-${uid}">Hours</label><input id="r-h-${uid}" name="hours" type="number" required min="${WINDOW_MIN_HOURS}" max="${WINDOW_MAX_HOURS}" step="1" value="4" inputmode="numeric">
<label for="r-why-${uid}">Why</label><input id="r-why-${uid}" name="why" required maxlength="500" autocomplete="off" placeholder="the change the window is for">
`, "Open the window", "window");
  const lock = !o.window ? off("Lock", "no change window is open on this object: it is locked by its rule already, or the rule leaves it open")
    : trigger("lock", "Lock", "lock", "Close the change window on") + pop("lock", "Lock: close the window",
      `Closes the change window without approving. The next pass treats a drift on it as before.${sample}`, "", "Close the window", "lock");
  return `${approve}${unlock}${lock}`;
}

/** An object's facts at a glance: live, approved, the template's recommendation, the lock and its rule, the last change and who made it. */
function objectSummary(v: View, o: SettingObject, actions: readonly Action[]): string {
  const r = o.rule;
  const live = o.live.absent ? `<span class="muted">absent from the latest run</span>` : `<code>${v.t(o.live.text)}</code>`;
  const approved = !o.approved ? `<span class="muted">no approval of record</span>`
    : `<code>${v.t(h12(o.approved.value_hash))}</code> ${o.differs ? `<span class="b need">differs from live</span>` : `<span class="b ok">matches live</span>`}<span class="rc">approved ${v.t(utc(o.approved.approved_at))}${o.approved.approved_by ? ` by ${v.t(o.approved.approved_by)}` : ""}</span>`;
  const recommended = r
    ? `<a href="/policy#${escapeHtml(r.rule_id)}">${v.t(template(r))}</a><span class="rc">on drift ${v.t(r.on_drift)}; no copy ${v.t(r.on_no_copy)}; hold up to ${v.t(r.hold_max_hours)} h; alert ${v.t(r.alert)}, ${v.t(r.psa_priority)}</span>`
    : `<span class="muted">no rule governs it: the default checks decide</span>`;
  const verdicts = o.decisions.length
    ? o.decisions.map((d) => `${decisionChip(d)} ${v.t(classLabel(d.class))}<span class="rc">${v.t(timesIn(d.reason))}</span>`).join("")
    : `<span class="muted">no finding: the latest pass found it in order</span>`;
  const c = o.cause;
  const changedBy = c ? `${c.actor ? v.t(c.actor) : `<span class="muted">not recorded</span>`}${c.mechanism ? ` via ${v.t(c.mechanism)}` : ""}${c.occurred_at ? `, ${v.t(utc(c.occurred_at))}` : ""}` : `<span class="muted">no record</span>`;
  return `<dl class="kv glance">
<dt>Live</dt><dd>${live}</dd>
<dt>Approved</dt><dd>${approved}</dd>
<dt>Recommended (template)</dt><dd>${recommended}</dd>
<dt>Lock</dt><dd>${lockBadge(v, o)}${r ? ` <a class="pill" href="/policy#${escapeHtml(r.rule_id)}">${v.t(r.rule_id)}</a> <span class="muted">${v.t(r.criticality)}</span>` : ""}</dd>
<dt>Verdict</dt><dd>${verdicts}</dd>
<dt>Last change</dt><dd>${causeText(v, c, actions)}</dd>
<dt>Changed by</dt><dd>${changedBy}</dd>
</dl>`;
}

/** The sections an object's page and its drawer share, after the facts and the actions. */
function detailSections(v: View, o: SettingObject): string {
  return `<h3>Live against approved</h3>${liveVsApproved(v, o)}
<h3>Restore proof</h3>${restoreProof(v, o)}
<h3>What a restore would regress</h3>${regressHtml(v, o)}
<h3>References</h3>${referencesHtml(v, o)}
<h3>Decisions</h3>${decisionsHtml(v, o)}
<h3>Action history</h3>${actionsHistory(v, o)}
<h3>Change window</h3>${windowsHtml(v, o)}`;
}

const objectKicker = (o: SettingObject): string => (o.kind === "file" ? `file on ${o.host ?? "-"} · ${o.surface}` : `record in ${o.group.replace(/^zone /, "zone ")} · ${o.surface}`);

/** One object's detail in the drawer a Settings row opens: its actions are buttons aimed at the popovers of the row. */
function drawerTemplate(v: View, o: SettingObject, id: string, actions: readonly Action[]): string {
  return `<template id="t-${id}" data-key="${escapeHtml(encodeKey(o.key))}">
<div class="dr-head"><div><p class="kicker">${v.t(objectKicker(o))}</p><h2 id="dr-title">${v.t(o.kind === "file" ? o.object_id : o.name)}</h2><p class="badges">${statusBadge(o.status)} ${lockBadge(v, o)}${o.rule ? ` <a class="pill" href="/policy#${escapeHtml(o.rule.rule_id)}">${v.t(o.rule.rule_id)}</a>` : ""}</p></div><span class="dr-tools"><a class="btn" href="${objectHref(o)}">Open page</a><button type="button" class="btn x" data-close>Close</button></span></div>
<div class="dr-body">
${objectSummary(v, o, actions)}
<div class="wf"><h3>Change it</h3><div class="acts">${actionSet(v, o, "/settings", id, false)}</div></div>
${detailSections(v, o)}
</div>
</template>`;
}

/** An object on a page of its own: the facts, the actions, then the sections the drawer holds. */
export function objectPage(v: View, o: SettingObject): { body: string } {
  const actions = (v.snapshot.doc.data.actions ?? []) as unknown as Action[];
  return {
    body: `<p class="crumb"><a href="/work">Work queue</a> <span aria-hidden="true">›</span> <a href="/settings">Settings</a></p>
<div class="head obj-head"><div><p class="kicker">${v.t(objectKicker(o))}</p><h1 class="oname">${v.t(o.kind === "file" ? o.object_id : o.name)}</h1><p class="badges">${statusBadge(o.status)} ${lockBadge(v, o)}</p></div>
<div class="acts">${actionSet(v, o, "/settings", "obj", true)}</div></div>
<div class="detail">
${objectSummary(v, o, actions)}
${detailSections(v, o)}
</div>`,
  };
}

// ---- Work queue -------------------------------------------------------------------------------------------------

/** A decision's status chip: a verb the technician owes (needs you), the agent's restore (drifted), a hold, an adoption. */
function decisionChip(d: Pick<Decision, "verb" | "window_id">): string {
  if (NEEDS.includes(d.verb)) return `<span class="b need">needs you</span>`;
  if (d.verb === "ROLLBACK") return `<span class="b drifted">drifted</span>`;
  if (d.verb === "HOLD") return isWindowHold(d) ? `<span class="b window">held · window</span>` : `<span class="b held">held</span>`;
  return `<span class="b adopted">adopted</span>`;
}

/** A span of time in the page's words: "under 1 h", "5 h", "3 d". */
function spanText(ms: number): string {
  const h = Math.floor(Math.max(0, ms) / 3_600_000);
  return h < 1 ? "under 1 h" : h < 48 ? `${thousands(h)} h` : `${thousands(Math.floor(h / 24))} d`;
}

/**
 * Since when each current finding has been raised without a break, in ms: walking back over the instants the tenant's
 * passes decided at (every disposition's decided_at and the decisions shown; every finding of one pass carries its
 * pass's instant), the earliest of the run of consecutive passes that raised it, ending at its current decision. A pass
 * that raised nothing for the tenant leaves no row, so it cannot break a run. NaN when the decision names no instant.
 */
function openSince(v: View): Map<string, number> {
  const instants = new Set<number>();
  const raised = new Map<string, Set<number>>();
  const add = (id: string, at: string | null | undefined): void => {
    const ms = at ? Date.parse(at) : NaN;
    if (Number.isNaN(ms)) return;
    instants.add(ms);
    const mine = raised.get(id) ?? new Set<number>();
    raised.set(id, mine.add(ms));
  };
  for (const x of v.snapshot.dispositions) add(x.finding_id, x.decided_at);
  for (const d of v.decisions) add(d.finding_id, d.decided_at);
  const newestFirst = [...instants].sort((a, b) => b - a);
  const out = new Map<string, number>();
  for (const d of v.decisions) {
    const now = Date.parse(d.decided_at);
    const mine = raised.get(d.finding_id);
    let since = now;
    if (mine && !Number.isNaN(now)) for (let i = newestFirst.indexOf(now) + 1; i < newestFirst.length && mine.has(newestFirst[i]); i++) since = newestFirst[i];
    out.set(d.finding_id, since);
  }
  return out;
}

/** The live and the approved value of an object as a row shows them, as Settings does: a file's hash or a record's content; the approved one as the same hash, or none, or the live one. */
function valuePair(o: SettingObject): { live: string; approved: string; differs: boolean; none: boolean } {
  return { live: o.live.text, approved: !o.approved ? "none" : o.differs ? h12(o.approved.value_hash) : "same as live", differs: Boolean(o.approved) && o.differs, none: !o.approved };
}

/** One row of a work table: the object, live against approved, why (the rule), the age or the expiry, the status, the actions. */
function queueRow(v: View, d: Decision, o: SettingObject | undefined, uid: string, withActions: boolean, since: number | null): string {
  const pair = o ? valuePair(o) : null;
  const object = o ? `${objectName(v, o)}${d.setting_path && d.setting_path !== o.main ? `<span class="q">${v.t(d.setting_path)}</span>` : ""}` : `<span class="on">${v.t(whereOf(v, d))}</span>`;
  // a table of findings that wait on a person shows how long they have; a table of held or adopted ones when they end
  const rel = d.expires_at ? untilPhrase(d.expires_at, v.now) : null;
  const when = since !== null
    ? Number.isNaN(since) ? `<span class="muted">-</span>` : `<span class="nw" title="raised by every pass since ${v.t(utc(new Date(since).toISOString()))}">${spanText(Date.parse(v.now) - since)}</span><span class="q">since ${v.t(shortUtc(new Date(since).toISOString()))}</span>`
    : d.expires_at ? `<span>${v.t(shortUtc(d.expires_at))}</span><span class="q${rel && /overdue/.test(rel) ? " late" : ""}">${v.t(rel ?? "")}</span>` : `<span class="muted">no expiry</span>`;
  const why = `<span class="cls">${v.t(classLabel(d.class))}</span><span class="rs" title="${v.t(timesIn(d.reason))}">${v.t(timesIn(d.reason))}</span><span class="q">${d.rule_id ? `rule ${ruleLink(v, d.rule_id)}` : `decided by ${v.t(d.decided_by)}`}</span>`;
  const status = `${decisionChip(d)}${o && o.lock !== "open" ? lockBadge(v, o) : ""}`;
  const actions = withActions && o ? `<div class="acts">${actionSet(v, o, "/work", uid, true)}<a class="btn sm" href="${objectHref(o)}" title="Open the object's page">Open</a></div>` : o ? `<a class="btn sm" href="${objectHref(o)}">Open</a>` : "";
  return `<tr id="w-${v.t(d.finding_id)}">
<td data-label="Object" title="${v.t(whereOf(v, d))}">${object}</td>
${withActions ? `<td data-label="Live">${pair ? `<code>${v.t(pair.live)}</code>` : ""}</td>
<td data-label="Approved">${pair ? (pair.none || pair.approved === "same as live" ? `<span class="muted">${v.t(pair.approved)}</span>` : `<code class="${pair.differs ? "chg" : ""}">${v.t(pair.approved)}</code>`) : ""}</td>` : ""}
<td data-label="Why">${why}</td>
<td data-label="${since !== null ? "Age" : "Expires"}">${when}</td>
<td data-label="Status" class="st">${status}</td>
<td data-label="Actions" class="acts-c">${actions}</td>
</tr>`;
}

/** The work queue: what needs a person, what is held, what the agent restores, what is adopted. */
export function workPage(v: View): { body: string } {
  const byKey = new Map(v.objects.map((o) => [o.key, o]));
  const objectOf = (d: Decision): SettingObject | undefined => byKey.get(objectKey(d.surface, d.host, d.object_id));
  const pick = (verbs: readonly Verb[]): Decision[] => v.decisions.filter((d) => verbs.includes(d.verb));
  const since = openSince(v);
  const ms = (x: number | undefined): number => (x === undefined || Number.isNaN(x) ? Infinity : x);
  const at = (iso: string | null): number => ms(iso ? Date.parse(iso) : undefined);
  const oldest = (a: Decision, b: Decision): number => ms(since.get(a.finding_id)) - ms(since.get(b.finding_id)) || cmp(a.class, b.class) || cmp(a.finding_id, b.finding_id);
  const soonest = (a: Decision, b: Decision): number => at(a.expires_at) - at(b.expires_at) || cmp(a.class, b.class) || cmp(a.finding_id, b.finding_id);
  let n = 0;
  const table = (ds: Decision[], withActions: boolean, when: "Age" | "Expires"): string => {
    const head = (label: string): string => `<th scope="col">${label}</th>`;
    return `<div class="tbl flush"><table class="wq rt${withActions ? "" : " lean"}">
<thead><tr>${head("Object")}${withActions ? `${head("Live")}${head("Approved")}` : ""}${head("Why")}${head(when)}${head("Status")}${head(withActions ? "Actions" : "Detail")}</tr></thead>
<tbody>
${ds.map((d) => queueRow(v, d, objectOf(d), `q${n++}`, withActions, when === "Age" ? since.get(d.finding_id) ?? NaN : null)).join("\n")}
</tbody>
</table></div>`;
  };
  const section = (id: string, title: string, ds: Decision[], empty: string, body: () => string): string =>
    `<section id="${id}"><h2>${title}<span class="cnt">${thousands(ds.length)}</span></h2>${ds.length ? body() : `<p class="muted">${empty}</p>`}</section>`;
  const needs = pick(NEEDS).sort(oldest);
  const restore = pick(["ROLLBACK"]).sort(oldest);
  const held = pick(["HOLD"]).sort(soonest);
  const adopted = pick(["ADOPT"]).sort(soonest);
  return { body: `<div class="head"><div><h1>Work queue</h1>
${ledeHtml("What needs a person first, then what is held. Approve accepts the live value, Unlock opens a change window, Lock closes it.",
    `<p>The rows are the current decisions of ${v.t(v.tenant)}: ${v.source === "pass" ? "from the pass this console ran" : "from the ledger"}, each with the Decider's own reason. Approve makes the live value the approved one; a drift is then no drift. Unlock holds a drift on the object until the window ends instead of restoring it; Lock ends the window. Open shows the object with its restore proof and history. Record exception is on <a href="/findings">Findings</a>.</p>`)}</div></div>
${needs.length ? "" : `<p class="calm">Nothing needs you: no finding is escalated or waiting on a fix.</p>`}
${section("needs", "Needs you", needs, "No finding is escalated or waiting on a fix.", () => table(needs, true, "Age"))}
${restore.length ? section("restore", "The agent restores at the next act", restore, "", () => table(restore, true, "Age")) : ""}
${section("held", "Held", held, "No finding is held.", () => table(held, true, "Expires"))}
${section("adopted", "Adopted", adopted, "No finding is adopted.", () => `<details class="fold"><summary>${plural(adopted.length, "finding")} adopted under exceptions</summary>${table(adopted, false, "Expires")}</details>`)}` };
}

// ---- Executive --------------------------------------------------------------------------------------------------

/** The executive report inside the shell: the period switch, Export PDF (shown by the script, which prints) and Download HTML, then the report's sections. */
export function executivePage(x: Executive, ctx: ExecutiveContext): string {
  const tools = `<div class="ex-tools">
<nav class="seg" aria-label="Period">${PERIODS.map((p) => `<a href="/executive?period=${p}"${p === x.period ? ' aria-current="page"' : ""}>${PERIOD_SHORT[p]}</a>`).join("")}</nav>
<span class="ex-act"><button type="button" class="btn" data-print hidden>Export PDF</button><a class="btn" href="/executive/download?period=${x.period}" download>Download HTML</a></span>
</div>`;
  return `${tools}
${executiveSections(x, ctx)}`;
}

// ---- Templates --------------------------------------------------------------------------------------------------

/** One template: a policy rule (null for the settings no rule governs), the objects whose settings follow it, and its deviations. */
export interface Template {
  rule: PolicyRule | null;
  objects: { key: string; object: SettingObject | null; name: string; where: string; settings: number; open: Decision[] }[];
  settings: number;
  /** Objects whose findings are open under the rule. */
  deviations: number;
}

/** Two or more rules of one family (tenant, surface, object and setting globs) at its highest version: a policy-authoring fault. */
export interface DuplicateRule { family: string; version: number; rule_ids: string[] }

/**
 * The rules in force: of each family (tenant, surface, object and setting globs) the highest version, as
 * src/policy/resolve.ts weighs them. A family whose highest version holds more than one rule is not tie-broken here:
 * it is a duplicate, reported on the Templates page and in the console's trace (src/console/server.ts). The rule the
 * resolver picks of it still governs its settings; no empty template is added for it.
 */
export function latestRules(rules: readonly PolicyRule[]): { rules: PolicyRule[]; duplicates: DuplicateRule[] } {
  const byFamily = new Map<string, PolicyRule[]>();
  for (const r of rules) {
    const f = [r.tenant_id, r.surface, r.object_glob, r.setting_glob].join(" · ");
    const top = byFamily.get(f);
    if (!top || Number(r.version) > Number(top[0].version)) byFamily.set(f, [r]);
    else if (Number(r.version) === Number(top[0].version) && !top.some((x) => x.rule_id === r.rule_id)) top.push(r);
  }
  const latest: PolicyRule[] = [];
  const duplicates: DuplicateRule[] = [];
  for (const [family, top] of byFamily) {
    if (top.length === 1) latest.push(top[0]);
    else duplicates.push({ family, version: Number(top[0].version), rule_ids: top.map((r) => r.rule_id).sort(cmp) });
  }
  return { rules: latest, duplicates: duplicates.sort((a, b) => cmp(a.family, b.family)) };
}

/** A duplicate in one sentence, for the page and the trace. */
export const duplicateText = (d: DuplicateRule): string => `rule family ${d.family} has ${d.rule_ids.length} rules at version ${d.version} (${d.rule_ids.join(", ")}): the policy names no one rule in force, and the resolver picks by rule id`;

/** The resolver templatesOf calls: src/policy/resolve.ts resolvePolicy, or a test's counting one. */
type Resolve = (rules: readonly PolicyRule[], setting: SettingRef) => PolicyRule | null;

/**
 * The templates of the tenant: every setting of the latest passing runs under the rule that governs it, every open
 * finding under the rule it was decided by. The rules are resolved once per scope, not once per row: the candidate
 * rules once per object (its tenant, surface and object glob), then each distinct setting of it once, so a setting
 * the latest runs of two hosts both hold is resolved once.
 */
export function templatesOf(v: View, resolve: Resolve = resolvePolicy): Template[] {
  const { rules, duplicates } = latestRules(v.snapshot.doc.data.rules);
  const all = v.snapshot.doc.data.rules;
  const forObject = new Map<string, PolicyRule[]>();
  const resolved = new Map<string, PolicyRule | null>();
  const governing = (surface: string, objectId: string, settingPath: string): PolicyRule | null => {
    const scope = `${surface}\u001f${objectId}`;
    let candidates = forObject.get(scope);
    if (!candidates) forObject.set(scope, (candidates = all.filter((r) => (r.tenant_id === v.tenant || r.tenant_id === "*") && (r.surface === surface || r.surface === "*") && globMatch(r.object_glob, objectId))));
    const key = `${scope}\u001f${settingPath}`;
    if (!resolved.has(key)) resolved.set(key, resolve(candidates, { tenant_id: v.tenant, surface, object_id: objectId, setting_path: settingPath }));
    return resolved.get(key)!;
  };
  const objectsBy = new Map(v.objects.map((o) => [o.key, o]));
  const groups = new Map<string, Map<string, Template["objects"][number]>>();
  const row = (ruleId: string, key: string, fallback: { surface: string; host: string | null; object_id: string }): Template["objects"][number] => {
    const g = groups.get(ruleId) ?? new Map<string, Template["objects"][number]>();
    groups.set(ruleId, g);
    let r = g.get(key);
    if (!r) {
      const o = objectsBy.get(key) ?? null;
      const where = o ? (o.kind === "file" ? (o.host ?? "-") : o.group.replace(/^zone /, "")) : (fallback.host ?? "-");
      g.set(key, (r = { key, object: o, name: o ? (o.kind === "file" ? tail(o.object_id) : o.name) : tail(fallback.object_id), where, settings: 0, open: [] }));
    }
    return r;
  };
  for (const x of v.snapshot.observations) {
    const host = x.host || null;
    const rule = governing(x.surface, x.object_id, x.setting_path);
    row(rule?.rule_id ?? "", objectKey(x.surface, host, x.object_id), { surface: x.surface, host, object_id: x.object_id }).settings++;
  }
  for (const d of v.decisions) if (d.rule_id) row(d.rule_id, objectKey(d.surface, d.host, d.object_id), d).open.push(d);
  // the rules in force by id, a duplicate's among them: the one the resolver picks governs its settings
  const byId = new Map([...rules, ...all.filter((r) => duplicates.some((d) => d.rule_ids.includes(r.rule_id)))].map((r) => [r.rule_id, r]));
  const out: Template[] = [...groups].map(([id, g]) => {
    const objects = [...g.values()].sort((a, b) => (b.open.length ? 1 : 0) - (a.open.length ? 1 : 0) || cmp(a.where, b.where) || cmp(a.name, b.name));
    return { rule: byId.get(id) ?? null, objects, settings: objects.reduce((n, o) => n + o.settings, 0), deviations: objects.filter((o) => o.open.length).length };
  });
  // the rules no setting follows, so the page names every rule
  for (const r of rules) if (!groups.has(r.rule_id)) out.push({ rule: r, objects: [], settings: 0, deviations: 0 });
  const crit = ["critical", "high", "normal", "low"];
  return out.sort((a, b) => b.deviations - a.deviations || b.settings - a.settings || crit.indexOf(a.rule?.criticality ?? "") - crit.indexOf(b.rule?.criticality ?? "") || cmp(a.rule?.rule_id ?? "~", b.rule?.rule_id ?? "~"));
}

/** An object's lock under one template: the open window on it, else the rule's lock. */
function lockUnder(v: View, o: SettingObject | null, rule: PolicyRule | null): string {
  if (o?.window) return `<span class="b window" title="${v.t(`change window ${o.window.window_id} opened by ${o.window.opened_by}, open until ${utc(o.window.until)}`)}">open until ${v.t(shortUtc(o.window.until))}</span>`;
  if (!rule) return `<span class="b open">open, no rule</span>`;
  return Number(rule.lock) === 1 ? `<span class="b locked">locked by rule</span>` : `<span class="b open">open by rule</span>`;
}

export function templatesPage(v: View): string {
  const ts = templatesOf(v);
  const cards = ts.map((x, i) => {
    const r = x.rule;
    const name = r ? v.t(template(r)) : "No rule";
    const rows = x.objects.map((o) => {
      const link = o.object ? `<a href="/settings?open=${encodeURIComponent(encodeKey(o.object.key))}">${v.t(o.name)}</a>` : v.t(o.name);
      return `<tr><td data-label="Object"><span class="on">${link}</span> <span class="oh">${v.t(o.where)}</span></td><td data-label="Settings" class="num">${thousands(o.settings)}</td><td data-label="Lock">${lockUnder(v, o.object, r)}</td><td data-label="Status">${o.object ? statusBadge(o.object.status) : `<span class="muted">not in Settings</span>`}</td><td data-label="Open under the rule">${o.open.length ? o.open.map((d) => `<a href="/findings#f-${v.t(d.finding_id)}">${verbBadge(v, d)}</a>`).join("") : `<span class="muted">none</span>`}</td></tr>`;
    });
    const facts = r
      ? `<p class="tpl-rule"><a href="/policy#${escapeHtml(r.rule_id)}"><code>${v.t(r.rule_id)}</code></a> · ${v.t(r.surface)} · ${v.t(r.criticality)} · on drift ${v.t(r.on_drift)}, no copy ${v.t(r.on_no_copy)} · hold ${v.t(r.hold_max_hours)} h · alert ${v.t(r.alert)}, ${v.t(r.psa_priority)}${r.note ? ` · <span class="muted">${v.t(r.note)}</span>` : ""}</p>`
      : `<p class="tpl-rule muted">The settings no policy rule governs: the default checks decide them.</p>`;
    const lock = r ? (Number(r.lock) === 1 ? `<span class="b locked">locked</span>` : `<span class="b open">open</span>`) : `<span class="b open">no rule</span>`;
    return `<details class="card tpl" id="tpl-${r ? escapeHtml(r.rule_id) : "none"}"${x.deviations || i === 0 ? " open" : ""}>
<summary><span class="tpl-name">${name}</span> ${lock} <span class="tpl-n">${plural(x.settings, "setting")} in ${plural(x.objects.length, "object")} · <span${x.deviations ? ' class="need"' : ""}>${plural(x.deviations, "deviation")}</span></span></summary>
${facts}
${rows.length ? `<div class="tbl"><table class="rt tpl-t"><thead><tr><th scope="col">Object</th><th scope="col" class="num">Settings</th><th scope="col">Lock</th><th scope="col">Status</th><th scope="col">Open under the rule</th></tr></thead><tbody>${rows.join("\n")}</tbody></table></div>` : `<p class="muted">No setting of the latest passing runs follows this rule.</p>`}
</details>`;
  });
  const settings = ts.reduce((n, x) => n + x.settings, 0);
  const { duplicates } = latestRules(v.snapshot.doc.data.rules);
  const dup = duplicates.length
    ? `<div class="alert" role="alert"><b>${plural(duplicates.length, "rule family", "rule families")} of the policy ${duplicates.length === 1 ? "has" : "have"} more than one rule at the highest version</b><ul>${duplicates.map((d) => `<li>${v.t(duplicateText(d))}</li>`).join("")}</ul></div>\n`
    : "";
  return `<div class="head"><div><h1>Templates</h1>
${ledeHtml(`The ${plural(settings, "setting")} of ${v.t(v.tenant)}'s latest passing runs, grouped by the policy rule that governs each.`,
    `<p>The policy_rule rows the store holds, loaded from the policy file; the most specific match governs, as on the <a href="/policy">policy</a> page. Per template: its rule, the objects whose settings follow it, each one's lock under it and its status, and the deviations, the objects whose findings are open under the rule. Select an object for its Settings drawer.</p>`)}</div></div>
${dup}<div class="tpls">
${cards.join("\n")}
</div>`;
}

// ---- Findings ---------------------------------------------------------------------------------------------------

function exceptionForm(v: View, d: Decision): string {
  const until = new Date(Date.parse(v.now) + 30 * 86_400_000).toISOString().slice(0, 10);
  const note = v.memoryWritable ? "" : `<p class="busy">The store is read-only in sample mode: start the console with --write to record into it.</p>`;
  return `<details class="exc"><summary class="btn">Record exception</summary>
<form method="post" action="/do/exception" data-action="exception" data-summary="Record an accepted exception for this ${v.t(classLabel(d.class))} finding? Findings of this class on its scope are ADOPT until the date you gave, then re-raised.">
${hidden(v, { finding: d.finding_id, return: "/findings" })}
<label for="e-u-${v.t(d.finding_id)}">Until (UTC)</label><input id="e-u-${v.t(d.finding_id)}" name="until" type="date" required value="${until}">
<label for="e-r-${v.t(d.finding_id)}">Reason</label><input id="e-r-${v.t(d.finding_id)}" name="reason" required maxlength="500" autocomplete="off" placeholder="why the finding is accepted">
<label for="e-b-${v.t(d.finding_id)}">By</label><input id="e-b-${v.t(d.finding_id)}" name="by" maxlength="128" autocomplete="off" value="technician">
${note}<div class="act"><button type="submit" class="btn">Record</button></div>
${confirmBlock("", "Record the exception")}
</form></details>`;
}

function findingItem(v: View, d: Decision): string {
  const cause = v.causes.get(d.disposition_id);
  const tickets = ticketsOf(v, d.finding_id);
  const rel = d.expires_at ? untilPhrase(d.expires_at, v.now) : null;
  const key = encodeKey([d.surface, d.surface === "cloudflare.dns" ? "" : (d.host ?? ""), d.object_id].join("\u001f"));
  const meta = [
    ...(d.expires_at ? [`until ${v.t(utc(d.expires_at))}${rel ? ` (${v.t(rel)})` : ""}`] : []),
    `decided ${v.t(utc(d.decided_at))} by ${v.t(d.decided_by)}${d.rule_id ? ` under ${ruleLink(v, d.rule_id)}` : ""}`,
    tickets.length ? `ticket ${tickets.map((x) => ticketRef(v, x)).join(", ")}` : "no ticket",
    `<a href="/settings?open=${encodeURIComponent(key)}">the object</a>`,
    `<span class="mono">${v.t(d.finding_id)}</span>`,
  ];
  return `<article class="item" id="f-${v.t(d.finding_id)}">
<div><p class="what">${verbBadge(v, d)}${v.t(classLabel(d.class))}</p>
<p class="where">${v.t(whereOf(v, d))}</p>
<p class="why">${v.t(timesIn(d.reason))}</p>
${cause ? `<p class="cause"><b>Why it changed:</b> ${v.t(withRestore(cause, (v.snapshot.doc.data.actions ?? []) as unknown as Action[]))}</p>` : ""}
<p class="meta">${meta.join(" · ")}</p></div>
<div>${d.verb === "ADOPT" && d.decided_by === "operator" ? "" : exceptionForm(v, d)}</div>
</article>`;
}

export function findingsPage(v: View): string {
  const by = (verbs: readonly Verb[]): Decision[] => v.decisions.filter((d) => verbs.includes(d.verb)).sort((a, b) => cmp(a.verb, b.verb) || cmp(a.class, b.class) || cmp(a.finding_id, b.finding_id));
  const section = (id: string, title: string, ds: Decision[], empty: string, fold = false): string => {
    const items = ds.map((d) => findingItem(v, d)).join("\n");
    const cls = id === "needs" ? "list needs" : "list";
    const list = !ds.length ? `<p class="muted">${empty}</p>` : fold && ds.length > 6 ? `<details class="fold"><summary>${plural(ds.length, "finding")}</summary><div class="${cls}">${items}</div></details>` : `<div class="${cls}">${items}</div>`;
    return `<section id="${id}"><h2>${title}<span class="cnt">${thousands(ds.length)}</span></h2>${list}</section>`;
  };
  const p = v.pass;
  const lead = v.source === "pass" && p
    ? `From the ${p.recorded ? "pass" : "dry pass"} this console ran, decided at ${v.t(utc(p.decidedAt))}.`
    : `From the ledger, decided at ${v.t(utc(v.snapshot.doc.data.decidedAt))}${v.passRunning ? `; a pass is running since ${v.t(utc(v.passRunning))}` : ""}.`;
  const how = v.source === "pass" && p
    ? `<p>The pass took ${(p.ms / 1000).toFixed(1)} s over ${plural(p.queries.queries, "query", "queries")} through ${v.t(v.datasource)}${p.recorded ? ", recorded in the ledger" : ", nothing recorded"}${p.trace ? `; <a href="/traces/view?f=${encodeURIComponent(`logs/${p.trace.id}.jsonl`)}">trace ${v.t(p.trace.id)}</a>` : ""}. Every disposition's reason is the Decider's own sentence (<a href="/policy">policy</a>, <a href="/document#findings-open">document</a>).</p>`
    : `<p>The latest disposition of each finding on the latest passing runs. Every disposition's reason is the Decider's own sentence (<a href="/policy">policy</a>, <a href="/document#findings-open">document</a>).</p>`;
  const needs = by(NEEDS);
  return `<div class="head"><div><h1>Findings</h1>${ledeHtml(lead, how)}</div>
${passForm(v, "page")}</div>
${needs.length ? "" : `<p class="calm">Nothing needs a person: no finding is escalated or waiting on a fix.</p>`}
${section("needs", "Needs a person", needs, "No finding is escalated or waiting on a fix.")}
${section("restore", "The agent restores at the next act", by(["ROLLBACK"]), "No finding is set to be rolled back.")}
${section("held", "Held with an expiry", by(["HOLD"]), "No finding is held.")}
${section("adopted", "Adopted", by(["ADOPT"]), "No finding is adopted.", true)}`;
}

// ---- Actions and tickets ------------------------------------------------------------------------------------------

export function actionsPage(v: View): string {
  const actions = ((v.snapshot.doc.data.actions ?? []) as unknown as Action[]).slice().sort((a, b) => cmp(b.started_at, a.started_at) || cmp(b.action_id, a.action_id));
  const tickets = v.snapshot.doc.data.tickets.slice().sort((a, b) => cmp(b.updated_at, a.updated_at));
  const classOf = (findingId: string): string => v.decisions.find((d) => d.finding_id === findingId)?.class ?? "-";
  const verbOf = (x: Row): Verb => {
    const a = x.action_id ? actions.find((y) => y.action_id === x.action_id) : undefined;
    const disp = v.snapshot.dispositions.filter((d) => d.finding_id === x.finding_id && (!a || d.disposition_id === a.disposition_id)).sort((p, q) => cmp(p.decided_at, q.decided_at));
    return (disp.at(-1)?.verb ?? v.decisions.find((d) => d.finding_id === x.finding_id)?.verb ?? "ESCALATE") as Verb;
  };
  const aRows = actions.map((a) => `<tr><td data-label="Time (UTC)" class="nw">${v.t(utc(a.started_at))}</td><td data-label="Action"><b>${v.t(a.kind)}</b><span class="q">${v.t(a.action_id)}</span></td><td data-label="Target"><code>${v.t(a.target)}</code></td><td data-label="Status">${v.t(a.status)}</td><td data-label="Verification">${v.t(a.verification || "none")}</td><td data-label="Models and receipts">${receiptsOf(v, a)}</td><td data-label="Reason">${v.t(a.reason || "-")}</td></tr>`);
  const tRows = tickets.map((x) => `<tr><td data-label="Ticket">${ticketRef(v, x)}<span class="q">${v.t(x.psa)}</span></td><td data-label="Type">${v.t(x.type)}</td><td data-label="Priority">${v.t(x.priority)}</td><td data-label="Status">${v.t(x.status)}</td><td data-label="Labels">${labelsOf(x.type as "change" | "incident", x.priority as "P1", classOf(x.finding_id), verbOf(x)).map((l) => `<span class="pill">${v.t(l)}</span>`).join(" ")}</td><td data-label="Finding"><a href="/findings#f-${v.t(x.finding_id)}" class="mono">${v.t(x.finding_id)}</a></td><td data-label="Updated" class="nw">${v.t(utc(x.updated_at))}</td></tr>`);
  return `<div class="head"><div><h1>Actions and tickets</h1>${ledeHtml(`The action ledger and the tickets of ${v.t(v.tenant)}, newest first.`, `<p>What the Actor did behind --apply, how it was verified, which models served it and on which receipts; then the tickets the ticket step opened (<a href="/document#work">document</a>).</p>`)}</div></div>
<h2>Actions<span class="cnt">${thousands(actions.length)}</span></h2>
${actions.length ? `<div class="tbl"><table class="rt"><thead><tr><th scope="col">Time (UTC)</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Status</th><th scope="col">Verification</th><th scope="col">Models and receipts</th><th scope="col">Reason</th></tr></thead><tbody>${aRows.join("\n")}</tbody></table></div>` : `<p class="muted">No action is recorded for ${v.t(v.tenant)}.</p>`}
<h2>Tickets<span class="cnt">${thousands(tickets.length)}</span></h2>
${tickets.length ? `<div class="tbl"><table class="rt"><thead><tr><th scope="col">Ticket</th><th scope="col">Type</th><th scope="col">Priority</th><th scope="col">Status</th><th scope="col">Labels</th><th scope="col">Finding</th><th scope="col">Updated</th></tr></thead><tbody>${tRows.join("\n")}</tbody></table></div>` : `<p class="muted">No ticket is recorded for ${v.t(v.tenant)}.</p>`}`;
}

// ---- Traces -------------------------------------------------------------------------------------------------------

export function tracesPage(v: View): string {
  const rows = v.traces.map((f) => `<tr><td data-label="Trace"><a href="/traces/view?f=${encodeURIComponent(f.ref)}" class="mono">${v.t(f.id)}</a></td><td data-label="Where">${v.t(f.dir)}</td><td data-label="First event" class="nw">${v.t(utc(f.first))}</td><td data-label="Size" class="num">${thousands(Math.round(f.size / 1024))} KB</td></tr>`);
  return `<div class="head"><div><h1>Traces</h1>${ledeHtml(`The traces of ${v.t(v.tenant)}, newest first; each opens as a table with a filter by agent.`, `<p>One JSON line per agent action, read from disk: the run traces in logs/ (gitignored) and the committed traces in examples/traces/, the ones whose cycle, pass or receipts name the tenant.</p>`)}</div></div>
${rows.length ? `<div class="tbl"><table class="rt"><thead><tr><th scope="col">Trace</th><th scope="col">Where</th><th scope="col">First event</th><th scope="col" class="num">Size</th></tr></thead><tbody>${rows.join("\n")}</tbody></table></div>` : `<p class="muted">No trace of ${v.t(v.tenant)} in logs/ or examples/traces/.</p>`}`;
}

export interface TraceEventRow { ts: string; agent: string; action: string; status: string; summary: string; input: string; detail: string }

export function traceViewPage(v: View, f: TraceFile, events: readonly TraceEventRow[], skipped: number): string {
  const agents = [...new Set(events.map((e) => e.agent))].sort(cmp);
  const rows = events.map((e) => `<tr data-agent="${v.t(e.agent)}"><td data-label="Time" class="nw mono">${v.t(e.ts.slice(11, 23))}</td><td data-label="Agent">${v.t(e.agent)}</td><td data-label="Action">${v.t(e.action)}</td><td data-label="Status">${v.t(e.status)}</td><td data-label="Summary">${v.t(e.summary)}${e.input && e.input !== e.summary ? `<span class="q">${v.t(e.input)}</span>` : ""}${e.detail ? `<span class="q">${v.t(e.detail.slice(0, 400))}</span>` : ""}</td></tr>`);
  return `<div class="head"><div><h1>Trace ${v.t(f.id)}</h1>${ledeHtml(`${v.t(f.dir)}/${v.t(f.name)}, ${plural(events.length, "event")} from ${v.t(utc(events[0]?.ts))} to ${v.t(utc(events.at(-1)?.ts))}${skipped ? `, ${plural(skipped, "line")} that did not parse left out` : ""}. <a href="/traces">All traces</a>`, `<p>Every free-text field passes the redactor as the trace did when it was written, and a ticket's URL reads as its number.</p>`)}</div></div>
<div class="filters"><label>Agent<select id="agent"><option value="">every agent</option>${agents.map((a) => `<option value="${v.t(a)}">${v.t(a)} (${events.filter((e) => e.agent === a).length})</option>`).join("")}</select></label><span class="count" id="tcount">${plural(events.length, "event")}</span></div>
<div class="tbl"><table class="rt"><thead><tr><th scope="col">Time (UTC)</th><th scope="col">Agent</th><th scope="col">Action</th><th scope="col">Status</th><th scope="col">Summary</th></tr></thead><tbody>
${rows.join("\n")}
</tbody></table></div>`;
}

// ---- Sources ------------------------------------------------------------------------------------------------------

/**
 * The two DQ rules a pass reads on Zetaris (src/loop/pass.ts), side by side: exception_in_force over
 * drift_usl.adoption and dns_inventory_current over drift_usl.dns_live, each as the console's last pass read it, or
 * why it did not. On sql.js the pass reads neither: sample mode has no USL and no live source.
 */
export function passDq(step: Pick<PassStep, "adoptions" | "dns"> | null, mode: ConsoleMode, tenant: string): { rule: string; entity: string; text: string; holds: boolean | null }[] {
  const why = (live: string): string => (!step ? "no pass from this console yet" : mode === "sample" ? "not read: the pass reads it on Zetaris, and sample mode reads sql.js" : `not read: ${live}`);
  const a = step?.adoptions;
  const d = step?.dns;
  return [
    {
      rule: "exception_in_force", entity: "drift_usl.adoption",
      ...(!a ? { text: why("the pass did not read it"), holds: null } : "error" in a ? { text: `not read: ${a.error}`, holds: null } : { text: `${a.inForce} of ${a.adoptions} adoptions in force`, holds: a.inForce === a.adoptions }),
    },
    {
      rule: "dns_inventory_current", entity: "drift_usl.dns_live",
      ...(!d ? { text: why(`${tenant} has no cloudflare.dns run to hold the provider to`), holds: null }
        : "error" in d ? { text: `not read: ${d.error}`, holds: null }
        : { text: `${d.current} of ${d.live} live record${d.live === 1 ? "" : "s"} at the provider match the last complete DNS run${d.current < d.live ? ": the provider changed since that run" : ""}`, holds: d.current === d.live }),
    },
  ];
}

export function sourcesPage(v: View, counts: readonly SourceCount[]): string {
  const d = v.snapshot.doc.data;
  const bySurface = new Map<string, { runs: number; pass: number }>();
  for (const r of d.runs) {
    const k = `${r.surface}${r.host ? ` ${r.host}` : ""}`;
    const c = bySurface.get(k) ?? { runs: 0, pass: 0 };
    bySurface.set(k, { runs: c.runs + 1, pass: c.pass + (r.passes ? 1 : 0) });
  }
  const groups = [...new Set(counts.map((c) => c.datasource))];
  const rows = groups.flatMap((g) => counts.filter((c) => c.datasource === g).map((c, i) => `<tr><td data-label="Datasource">${i === 0 ? `<b>${v.t(g)}</b>` : ""}</td><td data-label="Table"><code>${v.t(c.table)}</code></td><td data-label="Rows" class="num">${c.rows === null ? `<span class="muted" title="${v.t(c.error ?? "")}">not read</span>` : thousands(c.rows)}</td><td data-label="Counted">${c.scope === "tenant" ? `${v.t(v.tenant)}'s rows` : "every row"}</td></tr>`));
  const n = (r: string): number => d.copies.filter((c) => c.result === r).length;
  const p = v.pass;
  const dq = [
    `<li><b>run_complete</b> (the DQ gate, <code>RUN_COMPLETE_SQL</code>): ${thousands(d.runs.filter((r) => r.passes).length)} of ${plural(d.runs.length, "run")} of ${v.t(v.tenant)} pass.<ul>${[...bySurface].map(([k, c]) => `<li>${v.t(k)}: ${c.pass} of ${c.runs}</li>`).join("")}</ul></li>`,
    `<li><b>copy validation</b>: ${thousands(d.copies.length)} copies at the vault's heads, ${n("ok")} ok, ${n("ok_with_gaps")} ok with gaps, ${n("fail")} fail, ${n("")} not validated (<a href="/document#copies">document</a>).</li>`,
    ...passDq(p?.step ?? null, v.mode, v.tenant).map((x) => `<li><b>${x.rule}</b> on <code>${x.entity}</code>, read by the console's last pass: <span class="${x.holds === null ? "muted" : x.holds ? "ok" : "need"}">${v.t(x.text)}</span>.</li>`),
  ];
  const last = p
    ? `The console's last ${p.recorded ? "pass" : "dry pass"}, decided at ${v.t(utc(p.decidedAt))}: <b>${plural(p.queries.queries, "query", "queries")}</b> through ${v.t(v.datasource)}, ${thousands(p.queries.rows)} rows, ${thousands(p.queries.failed)} failed, ${(p.ms / 1000).toFixed(1)} s${p.trace ? ` (<a href="/traces/view?f=${encodeURIComponent(`logs/${p.trace.id}.jsonl`)}">trace</a>)` : ""}.`
    : v.passRunning ? `A pass is running since ${v.t(utc(v.passRunning))}.` : "No pass from this console yet: Run a pass counts its queries.";
  return `<div class="head"><div><h1>Sources</h1>${ledeHtml(`What the console and the agent read for ${v.t(v.tenant)}, and what each source holds.`, `<p>${v.mode === "live" ? "The app Postgres as the DRIFT datasource, and the technician's memory store and the policy file as LESSONS and RULES, all through Zetaris" : "The recorded bundle and the committed lesson store and policy file, loaded into sql.js"} (<a href="/document#where-each-answer-comes-from">where each answer comes from</a>).</p>`)}</div></div>
<p class="note">${last}</p>
<h2>Tables</h2>
<div class="tbl"><table class="rt"><thead><tr><th scope="col">Datasource</th><th scope="col">Table</th><th scope="col" class="num">Rows</th><th scope="col">Counted</th></tr></thead><tbody>${rows.join("\n")}</tbody></table></div>
<h2>DQ results</h2>
<ul>${dq.join("\n")}</ul>
<p class="muted">This page's snapshot took ${plural(v.snapshot.queries.queries, "query", "queries")} (${v.snapshot.queries.failed} failed) in ${(v.snapshot.ms / 1000).toFixed(1)} s.</p>`;
}

// ---- Policy and the document --------------------------------------------------------------------------------------

export function policyPage(v: View): string {
  const latest = new Map<string, PolicyRule>();
  for (const r of v.snapshot.doc.data.rules) if (!latest.has(r.rule_id) || Number(latest.get(r.rule_id)!.version) < Number(r.version)) latest.set(r.rule_id, r);
  const rules = [...latest.values()].sort((a, b) => Number(b.version) - Number(a.version) || cmp(a.surface, b.surface) || cmp(a.object_glob, b.object_glob));
  const rows = rules.map((r) => `<tr id="${escapeHtml(r.rule_id)}"><td data-label="Rule"><code>${v.t(r.rule_id)}</code><span class="q">version ${v.t(r.version)}</span></td><td data-label="Surface">${v.t(r.surface)}</td><td data-label="Object · setting"><code>${v.t(r.object_glob)}</code> · <code>${v.t(r.setting_glob)}</code></td><td data-label="Lock">${Number(r.lock) === 1 ? `<span class="b locked">locked</span>` : `<span class="b open">open</span>`}</td><td data-label="On drift">${v.t(r.on_drift)}<span class="q">no copy: ${v.t(r.on_no_copy)}</span></td><td data-label="Hold" class="num">${v.t(r.hold_max_hours)} h</td><td data-label="Alert">${v.t(r.alert)} · ${v.t(r.psa_priority)}</td><td data-label="Note">${v.t(r.note ?? "")}</td></tr>`);
  return `<div class="head"><div><h1>Policy</h1>${ledeHtml(`The rules that can govern ${v.t(v.tenant)}'s settings; the most specific match governs.`, `<p>As the policy_rule rows hold them (src/policy/resolve.ts). A locked rule rolls a drift back at the next cycle; a change window holds it instead until the window ends.</p>`)}</div></div>
<div class="tbl"><table class="rt"><thead><tr><th scope="col">Rule</th><th scope="col">Surface</th><th scope="col">Object · setting</th><th scope="col">Lock</th><th scope="col">On drift</th><th scope="col" class="num">Hold</th><th scope="col">Alert</th><th scope="col">Note</th></tr></thead><tbody>${rows.join("\n")}</tbody></table></div>`;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function documentPage(v: View): string {
  // a URL that carries a pseudonym points nowhere real: the page says so, as the report shows such a ticket by its number
  const md = v.snapshot.doc.markdown.replace(/https?:\/\/[^\s|)]+/g, (u) => (PSEUDONYM.test(u) ? "(a pseudonymised URL)" : u));
  const parts = md.split(/\n(?=## )/);
  const html = parts.map((p, i) => {
    const m = p.match(/^## (.+)\n?([\s\S]*)$/);
    if (!m) return i === 0 ? `<pre>${v.t(p.replace(/^# .*\n/, ""))}</pre>` : `<pre>${v.t(p)}</pre>`;
    return `<h2 id="${slug(m[1])}">${v.t(m[1])}</h2><pre>${v.t(m[2].trim())}</pre>`;
  }).join("\n");
  return `<div class="head"><div><h1>The owner's document</h1>${ledeHtml(`One page for ${v.t(v.tenant)}, rendered from SQL when this snapshot was read.`, `<p>Every number is a count of the rows its queries return (src/document/render.ts).</p>`)}</div></div>
${html}`;
}

export function errorPage(message: string): string {
  return `<h1>The console could not render this page</h1><p class="alert">${escapeHtml(message)}</p><p><a href="/work">Work queue</a></p>`;
}
