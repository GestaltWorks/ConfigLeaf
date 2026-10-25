// The owner's report: one static HTML file per tenant, written beside document.md, for an MSP owner or a client
// with five minutes and no context. The first screen answers whether anything is wrong and who is handling it.
//
// Contract: renderReport(data, ctx) is a pure function of the rows the owner's document is rendered from
// (src/document/render.ts DocumentResult.data, the same queries, none of its own) and of what the run knows beside
// them (ctx: the pass's findings, the cycle's act and tickets results, the mode, the trace, the tip and the policy
// file). It returns one HTML file: inline CSS, no external script, font or stylesheet, one small inline script that
// opens every collapsed list for printing; light and dark through prefers-color-scheme; readable at phone width with a
// 16 px gutter and no horizontal scroll (a table becomes one block per row under 640 px); printable. Every data string
// passes ctx.redactor before it is escaped, the tenant's redactor live and BUNDLE_REDACTOR in sample mode, so a raw
// name that reached a row comes out as its pseudonym; the caller runs the deny-list probe over the result before it
// writes the file, as it does for document.md. The only absolute URLs are the tickets' own links, as stored. Sections:
//   header       "<tenant> · configuration assurance"; the decision instant (UTC), the mode, the agent and the trace
//                id; one or two sentences on what needs a person and who handles it, and any source whose last read
//                fails the DQ gate.
//   tiles        sources read (providers and hosts of the latest passing runs), settings watched (their settings),
//                copies with a valid restore (ok or ok_with_gaps of the copies at the heads), findings open by verb,
//                actions this cycle (the actions on the open dispositions: done, refused, unverified), tickets open.
//   What happened             present.ts whatHappened over the pass's findings, the act and tickets results and the
//                             causes of the open dispositions: the sentences the cycle's terminal block prints.
//   Needs a person            one card per ESCALATE and FIX: the class in plain words, where, since when, why it is
//                             here, the cause's sentence, the evidence the finding carries, what the agent did (the
//                             act row's line for each action, served models and receipt ids included), the ticket.
//   Held with an expiry       one row per HOLD: label, where, held until, reason.
//   Adopted under the technician's exceptions   the count, each exception's reason, the findings collapsed; the
//                             adoptions under policy rules and the default after it.
//   Actions                   the tenant's actions, newest first, at most ACTIONS_SHOWN, this cycle's marked.
//   Coverage, so silence is not green   the latest run of each source with its rows, last read and gate result; the
//                             queries; the probes by kind with the failing names; the validations; the approvals and
//                             the locked settings without one; the notes (dispositions left unraised, stop-rule and
//                             judge notes the findings carry, a cause read that failed).
//   footer       the tip, the policy file and version, the sponsor stack, the trace path (or the bundle in sample mode).
//
// Measured 25 Oct 2026 over sample/bundle.json for client-1 (test/report.test.ts, examples/report.html): the six
// tiles 3 sources (1 provider, 2 hosts), 1,352 settings, 112 of 112 copies, 27 findings (ADOPT 23 · HOLD 3 ·
// ESCALATE 1), 0 actions, 1 ticket open; one card, the proxy_split ESCALATE with its cause and ticket #2; 24,941 bytes of the 300,000-byte budget, the same bytes from npm run sample, npm run document and npm run examples.

import { spawnSync } from "node:child_process";
import { actionOf } from "../actions/plan.ts";
import type { Action, PolicyRule } from "../data/rows.ts";
import { withRestore } from "../explain/cause.ts";
import {
  MODE, actionObject, classLabel, findingObject, nemotronOf, outcomeLine, reasonClauses, tail, thousands, whatHappened,
  type ActFacts, type CauseFacts, type Phrase, type TicketFacts,
} from "../loop/present.ts";
import type { Finding, Verb } from "../pipeline.ts";
import type { DocumentData, OpenDisposition } from "./render.ts";

/** The report's budget with the sample data. */
export const REPORT_MAX_BYTES = 300_000;
/** Actions the Actions table lists; the rest are counted in one line. */
export const ACTIONS_SHOWN = 40;
/** The mode the header names. */
export const REPORT_MODE = { applied: "applied", dryRun: MODE.dryRun } as const;
export type ReportMode = (typeof REPORT_MODE)[keyof typeof REPORT_MODE];
/** The sponsor stack the footer names. */
export const STACK_LINE = "Zetaris Lightning SQL over the DRIFT datasource; Meterless World Model and H-MEM; Nemotron through Nightshift, every call on a verified receipt";

export interface ReportContext {
  /** Every data string passes it before it is escaped. */
  redactor: { text(s: string): string };
  mode: ReportMode;
  /** The agent the header names; drift-agent when absent. */
  agent?: string;
  /** The run's trace; null in sample mode, where the file carries no trace of its own. */
  trace?: { id: string; path: string } | null;
  /** The repository's tip commit, when it can be read. */
  tip?: string | null;
  /** The policy file the rules were loaded from. */
  policyFile?: string | null;
  /** The pass's findings of the tenant: the evidence, the objects in plain words, the exceptions' reasons. */
  findings?: readonly Finding[];
  /** The cycle's act and tickets results, for What happened; absent outside a cycle. */
  act?: ActFacts | null;
  actSettled?: boolean;
  tickets?: TicketFacts | null;
  /** The causes the explain step found this cycle; the open dispositions' causes in data when absent. */
  causes?: readonly CauseFacts[];
  /** The queries the run sent through Zetaris; absent when the data layer is sql.js. */
  zetaris?: { datasource: string; queries: number; rows: number; failed: number } | null;
  /** In sample mode, the bundle the rows come from, named in the footer. */
  bundle?: { path: string; sha256: string } | null;
}

type Row = Readonly<Record<string, string>>;

// ---- text -----------------------------------------------------------------------------------------------------

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number): string => String(n).padStart(2, "0");
/** 25 Oct 2026 14:17 UTC; "-" for none; the input as given when it is no instant. */
export function utc(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}
const plural = (n: number, one: string, many = `${one}s`): string => `${thousands(n)} ${n === 1 ? one : many}`;
const isAre = (n: number): string => (n === 1 ? "is" : "are");
const list = (xs: readonly string[]): string => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** One phrase of a terminal line as plain text. */
const phraseText = (p: Phrase): string => (typeof p === "string" ? p : Array.isArray(p) ? p.map((s) => (typeof s === "string" ? s : s.text)).join("") : (p as { text: string }).text);

/** The verbs as the tiles count them, in the order the owner reads them. */
const TILE_VERBS: readonly Verb[] = ["ADOPT", "HOLD", "ESCALATE", "FIX", "ROLLBACK"];
const NEEDS: readonly string[] = ["FIX", "ESCALATE"];
const KIND_WORD: Readonly<Record<string, string>> = { rollback_file: "rollback of a file", revert_record: "revert of a DNS record", investigate: "investigation", fix: "fix" };
const STATUS_WORD: Readonly<Record<string, string>> = { done: "done", unverified: "written, not verified", failed: "failed", refused: "refused, nothing written", not_judged: "not judged" };
const ADOPTED_UNDER: Readonly<Record<string, string>> = { operator: "the technician's exceptions", policy: "policy rules", default: "the default checks" };

/** Each collection surface in plain words: its name (with the host for a host surface) and what it holds. */
const SURFACES: Readonly<Record<string, { name: (host: string) => string; holds: string; rank: number }>> = {
  "cloudflare.dns": { name: () => "DNS records", holds: "the provider's records of every zone, each field as it returns it", rank: 0 },
  "cloudflare.audit": { name: () => "Provider audit log", holds: "who changed which record and when", rank: 1 },
  "linux.nginx": { name: (h) => `nginx on ${h}`, holds: "each vhost file and setting as the host answers it over SSH", rank: 2 },
  "linux.etc": { name: (h) => `/etc on ${h}`, holds: "the host's other configuration files, read over SSH", rank: 3 },
  inventory: { name: () => "Asset inventory", holds: "the hosts' addresses", rank: 4 },
  probe: { name: () => "Probes from outside", holds: "the http, dns and tls answers of every served name", rank: 5 },
  "probe.verify": { name: () => "Verification probes", holds: "the agent's probes after each write", rank: 6 },
};

// ---- the facts the sections share ----------------------------------------------------------------------------

/** A finding as the pass would carry it, from its open disposition alone: what whatHappened reads when the pass's findings are not given. */
function asFinding(d: OpenDisposition, tenant: string): Finding {
  return {
    id: d.finding_id,
    finding: {
      class: d.class as Finding["finding"]["class"], tenant_id: tenant, run_id: d.run_id, surface: d.surface, host: d.host || null, object_id: d.object_id, setting_path: d.setting_path,
      value_hash: d.value_hash, since: d.decided_at, until: d.decided_at, summary: "",
    },
    verb: d.verb as Verb,
    disposition: { verb: d.verb as Verb, reason: d.reason, expires_at: d.expires_at || null, decided_by: d.decided_by as Finding["disposition"]["decided_by"], rule_id: d.rule_id || null },
    checks: [], rejected: [], judge: "skipped",
  };
}

interface Facts {
  data: DocumentData;
  ctx: ReportContext;
  /** Data text: redacted, then escaped. */
  t: (s: string | number | null | undefined) => string;
  findingOf: (d: OpenDisposition) => Finding | undefined;
  /** The open dispositions' causes, by disposition. */
  causes: Map<string, CauseFacts>;
  actions: Action[];
  /** The actions on the open dispositions: this cycle's. */
  thisCycle: Action[];
  /** The record zone of each record copy at the heads, by object. */
  zoneOf: Map<string, string>;
  ticketsOf: (findingId: string) => Row[];
}

function factsOf(data: DocumentData, ctx: ReportContext): Facts {
  const t = (s: string | number | null | undefined): string => escapeHtml(ctx.redactor.text(s === null || s === undefined ? "" : String(s)));
  const byId = new Map((ctx.findings ?? []).map((f) => [f.id, f]));
  const openIds = new Set(data.open.map((d) => d.disposition_id));
  // the rows the page read; the explain step's own causes when the page could not read them
  const causes = new Map<string, CauseFacts>((data.causes ?? ctx.causes ?? []).filter((c) => openIds.has(c.disposition_id)).map((c) => [c.disposition_id, c]));
  const actions = (data.actions ?? []).map(actionOf).sort((a, b) => cmp(b.started_at, a.started_at) || cmp(b.action_id, a.action_id));
  const zoneOf = new Map(data.copies.filter((c) => c.zone).map((c) => [c.object_id, c.zone]));
  // a ticket's open state first, then its number
  const rank = (x: Row): number => (x.status === "open" ? 0 : 1);
  return {
    data, ctx, t, causes, actions, zoneOf,
    findingOf: (d) => byId.get(d.finding_id),
    thisCycle: actions.filter((a) => openIds.has(a.disposition_id)),
    ticketsOf: (id) => data.tickets.filter((x) => x.finding_id === id).sort((a, b) => rank(a) - rank(b) || Number(a.external_id || 0) - Number(b.external_id || 0)),
  };
}

/** Where a finding is: the object in plain words (a file as its last two segments on its host, a record by name), the setting, the zone of a record. */
function whereOf(f: Facts, d: OpenDisposition): string {
  const finding = f.findingOf(d)?.finding;
  const zone = d.surface === "cloudflare.dns" ? f.zoneOf.get(d.object_id) : undefined;
  const object = finding
    ? findingObject(finding, true)
    : d.surface === "cloudflare.dns" ? `DNS record ${d.object_id} (${d.setting_path})` : `${tail(d.object_id)}${d.setting_path && d.setting_path !== "file" ? ` (${d.setting_path})` : ""}${d.host ? ` on ${d.host}` : ""}`;
  return `${object}${zone ? `, zone ${zone}` : ""}`;
}

/** A ticket's number, a link to its PSA url when it has one. */
function ticketRef(f: Facts, x: Row): string {
  const n = x.external_id ? `#${x.external_id}` : x.ticket_id;
  return x.url ? `<a href="${f.t(x.url)}">${f.t(n)}</a>` : f.t(n);
}

/** A ticket's number as a link to its PSA url, with its type, priority and status. */
function ticketHtml(f: Facts, x: Row): string {
  return `${ticketRef(f, x)} <span class="muted">${f.t(`${x.type}, ${x.priority}, ${x.status}`)}</span>`;
}

/** Text in a span of class `cls`; the text alone when cls is empty. */
const marked = (cls: string, html: string): string => (cls ? `<span class="${cls}">${html}</span>` : html);

/** The first letter upper case: a class label as a heading. */
const cap = (s: string): string => s.replace(/^./, (c) => c.toUpperCase());

/** The latest run of each surface and host, whatever its gate result, in the order SURFACES gives. */
function latestRuns(data: DocumentData): DocumentData["runs"] {
  const m = new Map<string, DocumentData["runs"][number]>();
  for (const r of data.runs) m.set(`${r.surface}\u001f${r.host}`, r);
  const rank = (s: string): number => SURFACES[s]?.rank ?? 99;
  return [...m.values()].sort((a, b) => rank(a.surface) - rank(b.surface) || cmp(a.surface, b.surface) || cmp(a.host, b.host));
}

const surfaceName = (r: { surface: string; host: string }): string => SURFACES[r.surface]?.name(r.host) ?? `${r.surface}${r.host ? ` on ${r.host}` : ""}`;

/** Why a run fails the gate, in a few words. */
function gateWhy(r: DocumentData["runs"][number]): string {
  if (r.status !== "complete") return `the run is ${r.status}, ${r.observed_count || "0"} of ${r.expected_count || "?"} read`;
  if (!r.expected_count || !r.observed_count) return "the run asserted no population";
  return `${r.observed_count} of ${r.expected_count} read`;
}

/** The policy version in force (the greatest) and its rules. */
function policyOf(rules: readonly PolicyRule[]): { version: number; rules: number } | null {
  if (!rules.length) return null;
  const version = Math.max(...rules.map((r) => Number(r.version) || 0));
  return { version, rules: rules.filter((r) => Number(r.version) === version).length };
}

// ---- the sections ---------------------------------------------------------------------------------------------

function headerHtml(f: Facts): string {
  const { data, ctx, t } = f;
  const needs = data.open.filter((d) => NEEDS.includes(d.verb));
  const meta = [utc(data.decidedAt), ctx.mode, ctx.agent ?? "drift-agent", ctx.trace ? `trace ${ctx.trace.id}` : "sample mode, no trace kept with this file"];
  const lede: string[] = [];
  if (!needs.length) lede.push(`<span class="ok-lead">Nothing needs a person.</span>`);
  else {
    const withTicket = needs.flatMap((d) => {
      const x = f.ticketsOf(d.finding_id).find((k) => k.status === "open");
      return x ? [x] : [];
    });
    const refs = list(withTicket.map((x) => ticketRef(f, x)));
    const it = needs.length === 1 ? "it" : "them";
    const tickets = withTicket.length === 1 ? "ticket" : "tickets";
    const handled = withTicket.length === needs.length
      ? `${tickets} ${refs} ${isAre(withTicket.length)} open for ${it}`
      : withTicket.length ? `${tickets} ${refs} ${isAre(withTicket.length)} open for ${withTicket.length} of ${needs.length}, and the rest have no ticket yet`
      : `no ticket is open for ${it} yet`;
    lede.push(`<span class="need-lead">${plural(needs.length, "finding")} ${needs.length === 1 ? "needs" : "need"} a person</span>: ${handled}.`);
  }
  const adopted = data.open.filter((d) => d.verb === "ADOPT").length;
  const held = data.open.filter((d) => d.verb === "HOLD");
  const parts: string[] = [];
  if (adopted) parts.push(`${needs.length ? thousands(adopted) : plural(adopted, "finding")} ${isAre(adopted)} adopted`);
  if (held.length) {
    const first = held.map((d) => d.expires_at).filter(Boolean).sort(cmp)[0];
    parts.push(`${needs.length || adopted ? thousands(held.length) : plural(held.length, "finding")} ${isAre(held.length)} held${first ? `, the first until ${utc(first)}` : ""}`);
  }
  if (parts.length) lede.push(`${needs.length ? "Of the rest, " : ""}${list(parts)}.`.replace(/^./, (c) => c.toUpperCase()));
  const failing = latestRuns(data).filter((r) => !r.passes);
  if (failing.length) {
    lede.push(`<span class="need-lead">${plural(failing.length, "source")} ${failing.length === 1 ? "fails" : "fail"} the DQ gate on its last read</span>: ${failing.map((r) => `${t(surfaceName(r))} (${t(gateWhy(r))})`).join("; ")}.`);
  }
  if (!data.runs.length) lede.push("No collection run of this tenant is on record.");
  return `<header class="top">
<h1>${t(data.tenant)} · configuration assurance</h1>
<p class="meta">${meta.map((m) => `<span>${t(m)}</span>`).join(" · ")}</p>
<p class="lede">${lede.join(" ")}</p>
</header>`;
}

function tile(key: string, value: string, sub: string, cls = ""): string {
  return `<div class="tile${cls ? ` ${cls}` : ""}"><p class="k">${key}</p><p class="v">${value}</p><p class="s">${sub}</p></div>`;
}

/** The six tiles' numbers, for the page and for a test. */
export interface TileFacts {
  sources: { total: number; providers: number; hosts: number; inventory: boolean };
  settings: { settings: number; objects: number };
  copies: { valid: number; total: number; ok: number; gaps: number; fail: number; none: number };
  findings: { total: number; verbs: Partial<Record<Verb, number>> };
  actions: { total: number; done: number; refused: number; unverified: number; failed: number; notJudged: number; planned: number | null };
  tickets: { open: number; refs: string[] };
}

export function tileFacts(data: DocumentData, ctx: Pick<ReportContext, "act"> = {}): TileFacts {
  const providers = new Set(data.shapes.filter((s) => !s.host && s.surface !== "inventory").map((s) => s.surface.split(".")[0])).size;
  const hosts = new Set(data.shapes.filter((s) => s.host).map((s) => s.host)).size;
  const inventory = data.shapes.some((s) => s.surface === "inventory");
  const n = (r: string): number => data.copies.filter((c) => c.result === r).length;
  const verbs: Partial<Record<Verb, number>> = {};
  for (const v of TILE_VERBS) {
    const k = data.open.filter((d) => d.verb === v).length;
    if (k) verbs[v] = k;
  }
  const openIds = new Set(data.open.map((d) => d.disposition_id));
  const mine = (data.actions ?? []).filter((a) => openIds.has(a.disposition_id));
  const st = (s: string): number => mine.filter((a) => a.status === s).length;
  const open = data.tickets.filter((x) => x.status === "open");
  return {
    sources: { total: providers + hosts + (inventory ? 1 : 0), providers, hosts, inventory },
    settings: { settings: data.shapes.reduce((k, s) => k + s.settings, 0), objects: data.shapes.reduce((k, s) => k + s.objects, 0) },
    copies: { valid: n("ok") + n("ok_with_gaps"), total: data.copies.length, ok: n("ok"), gaps: n("ok_with_gaps"), fail: n("fail"), none: n("") },
    findings: { total: data.open.length, verbs },
    actions: { total: mine.length, done: st("done"), refused: st("refused"), unverified: st("unverified"), failed: st("failed"), notJudged: st("not_judged"), planned: ctx.act && !ctx.act.apply ? ctx.act.plan.length : null },
    tickets: { open: open.length, refs: open.map((x) => (x.external_id ? `#${x.external_id}` : x.ticket_id)) },
  };
}

function tilesHtml(f: Facts): string {
  const { t } = f;
  const k = tileFacts(f.data, f.ctx);
  const src = [`${plural(k.sources.providers, "provider")}`, `${plural(k.sources.hosts, "host")}`, ...(k.sources.inventory ? ["1 inventory"] : [])].join(", ");
  const verbSpan = (v: Verb): string => marked(NEEDS.includes(v) ? "need" : v === "ADOPT" ? "adopted" : "", `${v} ${thousands(k.findings.verbs[v]!)}`);
  const verbs = TILE_VERBS.filter((v) => k.findings.verbs[v]).map(verbSpan).join(" · ") || "none open";
  const a = k.actions;
  const actionSub = [`done ${a.done}`, `refused ${a.refused}`, `unverified ${a.unverified}`, ...(a.failed ? [`failed ${a.failed}`] : []), ...(a.notJudged ? [`not judged ${a.notJudged}`] : [])].join(" · ")
    + (a.planned !== null ? `<br>dry run: ${plural(a.planned, "action")} planned` : "");
  const needs = (k.findings.verbs.ESCALATE ?? 0) + (k.findings.verbs.FIX ?? 0);
  return `<section class="tiles" aria-label="At a glance">
${tile("Sources read", thousands(k.sources.total), src)}
${tile("Settings watched", thousands(k.settings.settings), `${plural(k.settings.objects, "object")} in the latest runs`)}
${tile("Copies with a valid restore", `${thousands(k.copies.valid)} <small>of ${thousands(k.copies.total)}</small>`, k.copies.total ? `ok ${k.copies.ok} · with gaps ${k.copies.gaps} · fail ${k.copies.fail}${k.copies.none ? ` · not validated ${k.copies.none}` : ""}` : "no copy in the vault", k.copies.fail || k.copies.none ? "warn" : "")}
${tile("Findings open", thousands(k.findings.total), verbs, needs ? "has-need" : "")}
${tile("Actions this cycle", thousands(a.total), actionSub)}
${tile("Tickets open", thousands(k.tickets.open), k.tickets.open ? t(k.tickets.refs.slice(0, 6).join(", ") + (k.tickets.refs.length > 6 ? ", ..." : "")) : "none open")}
</section>`;
}

function storyHtml(f: Facts): string {
  const { data, ctx, t } = f;
  const findings = ctx.findings ? [...ctx.findings] : data.open.map((d) => asFinding(d, data.tenant));
  const causes: CauseFacts[] = ctx.causes ? [...ctx.causes] : [...f.causes.values()];
  const story = whatHappened({ pass: { findings, decidedAt: data.decidedAt ?? undefined }, act: ctx.act ?? null, actSettled: ctx.actSettled ?? false, tickets: ctx.tickets ?? null, causes });
  const lines = story.length ? story : [data.open.length ? "The latest runs carry the findings below." : "The latest passing runs carry no open finding."];
  return `<section id="what-happened">
<h2>What happened</h2>
${lines.map((s) => `<p class="story">${t(s)}</p>`).join("\n")}
</section>`;
}

/** What the agent did on one disposition: the act row's line for each action, the receipts it names. */
function didLines(f: Facts, d: OpenDisposition, finding: Finding | undefined): string[] {
  const own = f.actions.filter((a) => a.disposition_id === d.disposition_id).sort((a, b) => cmp(a.started_at, b.started_at) || cmp(a.action_id, b.action_id));
  const outcomes = own.map((a) => ({ action: a, reason: a.reason, record: a.record.split("\n").filter(Boolean) }));
  const pass = finding ? { findings: [finding] } : undefined;
  const lines = outcomes.map((o) => {
    const l = outcomeLine(o, outcomes, pass);
    const text = [l.label === undefined ? "" : phraseText(l.label), ...l.parts.map(phraseText)].filter(Boolean).join(" · ");
    const receipts = o.action.receipts.split(",").map((s) => s.trim()).filter(Boolean).filter((r) => !text.includes(r));
    return `${utc(o.action.started_at)}: ${text}${receipts.length ? ` · receipts ${receipts.join(", ")}` : ""}`;
  });
  if (lines.length) return lines;
  const planned = f.ctx.act && !f.ctx.act.apply ? f.ctx.act.plan.filter((p) => p.disposition_id === d.disposition_id) : [];
  if (planned.length) return [`Dry run: ${list(planned.map((p) => KIND_WORD[p.kind] ?? p.kind))} planned for a run with --apply; nothing written.`];
  return [d.verb === "ESCALATE" ? "The agent changed nothing: an escalation goes to a technician." : "No action is recorded for this decision."];
}

function needCard(f: Facts, d: OpenDisposition): string {
  const { t } = f;
  const finding = f.findingOf(d);
  const did = didLines(f, d, finding);
  const own = f.actions.filter((a) => a.disposition_id === d.disposition_id);
  const state = d.verb === "FIX"
    ? own.some((a) => a.kind === "fix" && a.status === "done") ? "Fixed" : "To fix · with a technician"
    : "Escalated · with a technician";
  const e = finding?.exposure;
  const since = e ? `${utc(e.since)}, ${e.bound === "exact" ? "" : "at least "}${plural(e.days, "day")}` : null;
  const cause = f.causes.get(d.disposition_id);
  const evidence = finding
    ? [finding.finding.summary, ...finding.checks.filter((c) => !c.holds).map((c) => c.explanation), ...finding.rejected.map((r) => `A check did not run: ${r.reason}`)].filter(Boolean)
    : [];
  const tickets = f.ticketsOf(d.finding_id);
  const rows: [string, string][] = [
    since ? ["In this state since", t(since)] : ["Decided", t(utc(d.decided_at))],
    ["Why it is here", t(reasonClauses(d.reason).join(", "))],
    ["Cause", cause ? t(withRestore(cause, f.actions)) : `<span class="muted">${f.data.causesError ? `not read: ${t(f.data.causesError)}` : "no cause recorded for this decision"}</span>`],
    ...(evidence.length ? [["Evidence", evidence.length === 1 ? t(evidence[0]) : `<ul>${evidence.map((s) => `<li>${t(s)}</li>`).join("")}</ul>`] as [string, string]] : []),
    ["What the agent did", did.length === 1 ? t(did[0]) : `<ul>${did.map((s) => `<li>${t(s)}</li>`).join("")}</ul>`],
    ["Ticket", tickets.length ? tickets.map((x) => ticketHtml(f, x)).join("<br>") : `<span class="muted">no ticket for this finding</span>`],
  ];
  return `<article class="card need-card">
<p class="state">${state}</p>
<h3>${t(cap(classLabel(d.class)))}</h3>
<p class="where">${t(whereOf(f, d))}</p>
<dl>
${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("\n")}
</dl>
<p class="fid">${t(`finding ${d.finding_id} · ${d.verb} by ${d.decided_by}${d.rule_id ? ` under ${d.rule_id}` : ""} · decided ${utc(d.decided_at)}`)}</p>
</article>`;
}

function needsHtml(f: Facts): string {
  const needs = f.data.open.filter((d) => NEEDS.includes(d.verb));
  return `<section id="needs" class="needs">
<h2>Needs a person</h2>
${needs.length ? needs.map((d) => needCard(f, d)).join("\n") : `<p class="muted">Nothing needs a person: no finding is escalated or waiting on a fix.</p>`}
</section>`;
}

/** A table: a header row, each cell labelled for the narrow layout. */
function tableHtml(head: readonly string[], rows: readonly (readonly string[])[], cls = ""): string {
  return `<table${cls ? ` class="${cls}"` : ""}>
<thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead>
<tbody>
${rows.map((r) => `<tr>${r.map((c, i) => `<td data-label="${head[i]}">${c}</td>`).join("")}</tr>`).join("\n")}
</tbody>
</table>`;
}

function heldHtml(f: Facts): string {
  const { t } = f;
  const held = f.data.open.filter((d) => d.verb === "HOLD").sort((a, b) => cmp(a.expires_at, b.expires_at) || cmp(a.finding_id, b.finding_id));
  return `<section id="held">
<h2>Held with an expiry</h2>
${held.length
    ? `<p>${plural(held.length, "finding")} ${isAre(held.length)} held. At its expiry a held finding becomes an escalation unless a pass finds the setting at its approved value.</p>\n${tableHtml(["Label", "Where", "Held until", "Reason"], held.map((d) => [t(classLabel(d.class)), t(whereOf(f, d)), t(utc(d.expires_at)), `<span class="reason">${t(d.reason)}</span>`]))}`
    : `<p class="muted">No finding is held.</p>`}
</section>`;
}

/** An exception's reason: the lesson's own, from the pass, else read off the disposition's reason. */
function exceptionReason(f: Facts, d: OpenDisposition): string {
  const own = f.findingOf(d)?.exception?.reason;
  if (own) return own;
  return d.reason.match(/^accepted exception \S+ holds until \S+ \((.*)\); the checks alone/)?.[1] ?? d.reason;
}

function adoptedHtml(f: Facts): string {
  const { t } = f;
  const adopted = f.data.open.filter((d) => d.verb === "ADOPT");
  if (!adopted.length) return `<section id="adopted">\n<h2>Adopted under the technician's exceptions</h2>\n<p class="muted">No finding is adopted.</p>\n</section>`;
  const groups = ["operator", "policy", "default", ...new Set(adopted.map((d) => d.decided_by))].filter((v, i, xs) => xs.indexOf(v) === i)
    .map((by) => [by, adopted.filter((d) => d.decided_by === by)] as const).filter(([, xs]) => xs.length);
  const item = (d: OpenDisposition): string => `<li><b>${t(classLabel(d.class))}</b> · ${t(whereOf(f, d))}${d.expires_at ? ` <span class="muted">until ${t(utc(d.expires_at))}</span>` : ""}</li>`;
  const body = groups.map(([by, xs]) => {
    const under = ADOPTED_UNDER[by] ?? by;
    const head = by === "operator" ? "" : `<h3>Adopted under ${t(under)}</h3>\n`;
    const reasons = by === "operator" ? [...new Set(xs.map((d) => exceptionReason(f, d)))] : [];
    return `${head}<p>${plural(xs.length, "finding")} ${isAre(xs.length)} adopted under ${t(under)}${by === "operator" ? ", each until the exception's expiry" : ""}.</p>
${reasons.map((r) => `<blockquote>${t(r)}</blockquote>`).join("\n")}
<details><summary>The ${plural(xs.length, "finding")}</summary>
<ul class="plain">${xs.map(item).join("")}</ul>
</details>`;
  }).join("\n");
  const none = groups.some(([by]) => by === "operator") ? "" : `<p class="muted">No finding is adopted under the technician's exceptions.</p>\n`;
  return `<section id="adopted" class="adopted">\n<h2>Adopted under the technician's exceptions</h2>\n${none}${body}\n</section>`;
}

/** The served models and receipt ids an action names. */
function receiptsOf(a: Action): string {
  if (a.kind === "investigate") {
    const n = nemotronOf(a.record.split("\n"));
    const parts = [...(n.lightning ? [`Lightning ${n.lightning.model} on ${n.lightning.receipt}`] : []), ...(n.judge ? [`Ultra ${n.judge.model} on ${n.judge.receipt}`] : [])];
    const rest = a.receipts.split(",").map((s) => s.trim()).filter((r) => r && !parts.some((p) => p.includes(r)));
    return [...parts, ...rest].join("; ") || "-";
  }
  return a.receipts.split(",").map((s) => s.trim()).filter(Boolean).join(", ") || "-";
}

function actionsHtml(f: Facts): string {
  const { t, data } = f;
  if (data.actions === null) return `<section id="actions">\n<h2>Actions</h2>\n<p class="muted">The actions were not read for this report.</p>\n</section>`;
  if (!f.actions.length) return `<section id="actions">\n<h2>Actions</h2>\n<p class="muted">No action is recorded for ${t(data.tenant)}.</p>\n</section>`;
  const mine = new Set(f.thisCycle.map((a) => a.action_id));
  const findings = f.ctx.findings ? { findings: [...f.ctx.findings] } : undefined;
  const shown = f.actions.slice(0, ACTIONS_SHOWN);
  const rows = shown.map((a) => [
    `${t(utc(a.started_at))}${mine.has(a.action_id) ? `<br><span class="tag">this cycle</span>` : ""}`,
    t(KIND_WORD[a.kind] ?? a.kind),
    t(actionObject(a, findings)),
    `<span class="st-${t(a.status)}">${t(STATUS_WORD[a.status] ?? a.status)}</span>`,
    t(a.status === "done" && a.verification ? `verified by ${a.verification.split(",").filter(Boolean).join(", ")}; ${a.reason}` : a.reason || "-"),
    t(receiptsOf(a)),
  ]);
  const more = f.actions.length - shown.length;
  return `<section id="actions">
<h2>Actions</h2>
<p>${plural(f.actions.length, "action")} recorded for ${t(data.tenant)}, newest first; ${plural(f.thisCycle.length, "action")} on this cycle's decisions.</p>
${tableHtml(["Time (UTC)", "Action", "Target", "Status", "Verification or reason", "Receipts and served models"], rows)}
${more > 0 ? `<p class="muted">${plural(more, "earlier action")} ${isAre(more)} in the ledger and in the owner's document.</p>` : ""}
</section>`;
}

function coverageHtml(f: Facts): string {
  const { t, data, ctx } = f;
  const latest = latestRuns(data);
  const passing = data.runs.filter((r) => r.passes).length;
  const sourceRows = latest.map((r) => [
    t(surfaceName(r)),
    t(SURFACES[r.surface]?.holds ?? "-"),
    t(`${r.observed_count || "0"} of ${r.expected_count || "?"}`),
    t(utc(r.finished_at)),
    r.passes ? `<span class="pass">passes</span>` : `<span class="fail">fails: ${t(gateWhy(r))}</span>`,
  ]);
  const total = data.queries.reduce((n, q) => n + q.runs, 0);
  const rows = data.queries.reduce((n, q) => n + q.rows, 0);
  const z = ctx.zetaris;
  const queryLine = z
    ? `Zetaris Lightning SQL over the ${t(z.datasource)} datasource: ${thousands(z.queries)} queries, ${thousands(z.rows)} rows, ${marked(z.failed ? "fail" : "", `${thousands(z.failed)} failed`)}, this run; the report's own reads are ${thousands(total)} of them.`
    : `The reads behind this page: ${thousands(total)} queries, ${thousands(rows)} rows, through ${t(data.source ?? "the data layer")}. A live cycle sends the same SQL as Zetaris Lightning SQL over the DRIFT datasource.`;
  const p = data.probes;
  const kinds = [...new Set(p.byKind.map((k) => k.kind))].sort(cmp);
  const num = (kind: string, status: string): string => p.byKind.find((k) => k.kind === kind && k.status === status)?.n ?? "0";
  const failingBy = [...new Set(p.failing.map((x) => x.kind))].sort(cmp).map((kind) => `${t(kind)}: ${t([...new Set(p.failing.filter((x) => x.kind === kind).map((x) => x.target))].sort(cmp).join(", "))}`);
  const probes = p.run
    ? `<p>The latest probe run finished ${t(utc(p.run.finished_at))}: ${plural(p.failing.length, "probe")} ${p.failing.length === 1 ? "fails" : "fail"}. ${plural(p.probeRuns, "probe run")} and ${plural(p.verifyRuns, "verification run")} pass the DQ gate.</p>
${tableHtml(["Kind", "Ok", "Failing", "Skipped"], kinds.map((k) => [t(k), num(k, "ok"), num(k, "fail") === "0" ? "0" : `<span class="fail">${num(k, "fail")}</span>`, num(k, "skipped")]), "narrow")}
${failingBy.length ? `<details><summary>The failing names</summary>\n<ul class="plain">${failingBy.map((s) => `<li>${s}</li>`).join("")}</ul>\n</details>` : ""}`
    : `<p class="fail">No probe run of ${t(data.tenant)} passes the DQ gate: what the sites answer from outside is unknown.</p>`;
  const n = (r: string): number => data.copies.filter((c) => c.result === r).length;
  const gaps = [...new Set(data.copies.flatMap((c) => (c.missing_dependencies ?? "").split("\n").map((s) => s.trim()).filter(Boolean)))].sort(cmp);
  const validation = data.copies.length
    ? `<p>${plural(data.copies.length, "copy", "copies")} at the vault's heads: ${n("ok")} ok, ${n("ok_with_gaps")} ok with gaps, ${marked(n("fail") ? "fail" : "", `${n("fail")} fail`)}${n("") ? `, <span class="fail">${n("")} not validated</span>` : ""}. A copy with gaps restores once the ${plural(gaps.length, "dependency", "dependencies")} the validations name ${gaps.length === 1 ? "is" : "are"} in place.</p>
${gaps.length ? `<details><summary>The ${plural(gaps.length, "gap")}</summary>\n<ul class="plain">${gaps.map((g) => `<li>${t(g)}</li>`).join("")}</ul>\n</details>` : ""}`
    : `<p class="fail">The vault holds no copy for ${t(data.tenant)}: no restore is known to be possible.</p>`;
  const notes: string[] = [];
  notes.push(`${plural(data.approvals, "setting has", "settings have")} an approval of record; ${plural(data.locked.length, "locked setting")} ${data.locked.length === 1 ? "has" : "have"} no approved value${data.locked.length ? `: ${data.locked.map((l) => t(`${l.setting_path} in ${tail(l.object_id)}${l.host ? ` on ${l.host}` : ""}`)).join("; ")}` : ""}.`);
  if (data.unraised) notes.push(`${plural(data.unraised, "disposition")} on the latest runs ${data.unraised === 1 ? "concerns" : "concern"} a finding the pass no longer raises.`);
  const stops = (ctx.findings ?? []).filter((fd) => fd.earlyStop).map((fd) => `${fd.id}: the stop rule ended checking early (${fd.earlyStop!.reason}); not run: ${fd.earlyStop!.skipped.join(", ") || "none"}.`);
  const withheld = (ctx.findings ?? []).filter((fd) => fd.judgeWithheld).map((fd) => `${fd.id}: ${fd.judgeWithheld}.`);
  const noted = (n: number, what: string, lines: readonly string[]): string =>
    `${plural(n, "finding")} ${what}.<details><summary>Each one</summary><ul class="plain">${lines.map((l) => `<li>${t(l)}</li>`).join("")}</ul></details>`;
  if (stops.length) notes.push(noted(stops.length, `${stops.length === 1 ? "has" : "have"} its checking ended early by the stop rule`, stops));
  if (withheld.length) notes.push(noted(withheld.length, `${withheld.length === 1 ? "carries" : "carry"} no judge call, withheld by the stop rule`, withheld));
  if (data.causesError) notes.push(`The causes were not read: ${t(data.causesError)}.`);
  return `<section id="coverage">
<h2>Coverage, so silence is not green</h2>
<p>${plural(data.runs.length, "collection run")} on record, ${thousands(passing)} passing the DQ gate. The latest read of each source:</p>
${tableHtml(["Source", "What it holds", "Rows", "Last read", "DQ gate"], sourceRows)}
<h3>Queries</h3>
<p>${queryLine}</p>
<h3>Probes</h3>
${probes}
<h3>Validation</h3>
${validation}
<h3>Notes</h3>
<ul>${notes.map((s) => `<li>${s}</li>`).join("")}</ul>
</section>`;
}

function footerHtml(f: Facts): string {
  const { t, data, ctx } = f;
  const policy = policyOf(data.rules);
  const lines = [
    ...(ctx.tip ? [`Tip ${t(ctx.tip)}.`] : []),
    policy ? `Policy ${t(ctx.policyFile ?? "file not named")}, version ${policy.version} (${plural(policy.rules, "rule")}).` : "No policy rule governs this tenant: the default decides.",
    `${STACK_LINE}.`,
    ctx.trace ? `Trace ${t(ctx.trace.path)}.` : ctx.bundle ? `Rendered in sample mode from ${t(ctx.bundle.path)} (sha256 ${t(ctx.bundle.sha256.replace(/^sha256:/, "").slice(0, 12))}); the run's trace stays in logs/.` : "No trace is kept with this file.",
  ];
  return `<footer>\n${lines.map((l) => `<p>${l}</p>`).join("\n")}\n</footer>`;
}

// ---- the page ---------------------------------------------------------------------------------------------------

const CSS = `:root{--bg:#fbfaf7;--fg:#1d1e20;--muted:#62666d;--line:#dedad2;--card:#ffffff;--soft:#f2f0eb;--need:#b3361d;--need-bg:#fbebe6;--adopted:#7b8087;--ok:#2f6b45}
@media (prefers-color-scheme:dark){:root{--bg:#141517;--fg:#e8e6e1;--muted:#a3a19b;--line:#33353a;--card:#1b1c1f;--soft:#222428;--need:#ff8e74;--need-bg:#3a201a;--adopted:#8e9198;--ok:#8fd1a6}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:anywhere}
main{max-width:980px;margin:0 auto;padding:0 16px 48px}
a{color:inherit;text-decoration-thickness:1px;text-underline-offset:2px}
h1{font-size:1.75rem;line-height:1.2;margin:0 0 6px;letter-spacing:-.01em}
h2{font-size:1.25rem;margin:44px 0 12px;border-top:1px solid var(--line);padding-top:20px}
h3{font-size:1.02rem;margin:22px 0 6px}
p{margin:8px 0;max-width:72ch}
ul{margin:8px 0;padding-left:20px}
li{margin:4px 0}
small{font-size:.6em;color:var(--muted);font-weight:500}
.top{padding:40px 0 8px}
.meta{color:var(--muted);font-size:.9rem;margin:0 0 14px}
.meta span{white-space:nowrap}
.lede{font-size:1.12rem;line-height:1.55;max-width:66ch}
.need-lead{color:var(--need);font-weight:650}
.ok-lead{color:var(--ok);font-weight:650}
.muted{color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin:22px 0 4px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.tile .k{margin:0;font-size:.78rem;color:var(--muted);line-height:1.3}
.tile .v{margin:4px 0 2px;font-size:1.7rem;font-weight:650;line-height:1.15;font-variant-numeric:tabular-nums}
.tile .s{margin:0;font-size:.8rem;color:var(--muted);line-height:1.4}
.tile.has-need{border-color:var(--need)}
.tile.warn .v{color:var(--need)}
.tile .need{color:var(--need);font-weight:650}
.tile .adopted{color:var(--adopted)}
.story{margin:6px 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:14px 0;break-inside:avoid}
.need-card{border-left:4px solid var(--need)}
.state{margin:0;font-size:.8rem;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--need)}
.card h3{margin:4px 0 2px;font-size:1.15rem}
.where{margin:0 0 10px;color:var(--muted);font-size:.92rem}
dl{display:grid;grid-template-columns:11em 1fr;gap:6px 16px;margin:10px 0 6px}
dt{color:var(--muted);font-size:.9rem}
dd{margin:0}
dd ul{margin:0;padding-left:18px}
.fid{margin:10px 0 0;font-size:.78rem;color:var(--muted)}
.adopted h3,.adopted blockquote{color:var(--adopted)}
blockquote{margin:10px 0;padding:6px 0 6px 14px;border-left:3px solid var(--adopted);color:var(--adopted);max-width:68ch}
details{margin:8px 0}
summary{cursor:pointer;color:var(--muted)}
ul.plain{list-style:none;padding:0}
ul.plain li{padding:4px 0;border-bottom:1px solid var(--line)}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:.9rem}
table.narrow{width:auto;min-width:50%}
th,td{text-align:left;vertical-align:top;padding:7px 10px;border-bottom:1px solid var(--line);overflow-wrap:break-word}
td[data-label^="Time"],td[data-label="Held until"],td[data-label="Last read"],td[data-label="Rows"]{white-space:nowrap}
th{font-size:.78rem;font-weight:600;color:var(--muted);background:var(--soft)}
.reason{color:var(--muted);font-size:.86rem}
.tag{display:inline-block;font-size:.72rem;padding:1px 6px;border-radius:4px;background:var(--soft);color:var(--muted)}
.fail,.st-failed{color:var(--need);font-weight:600}
.pass,.st-done{color:var(--ok)}
.st-refused,.st-unverified,.st-not_judged{color:var(--muted)}
footer{margin:48px 0 0;padding:18px 0 0;border-top:1px solid var(--line);color:var(--muted);font-size:.86rem}
footer p{margin:4px 0;max-width:none}
@media (max-width:860px){.tiles{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:640px){
body{font-size:15.5px}
.top{padding-top:24px}
h1{font-size:1.4rem}
.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}
dl{grid-template-columns:1fr;gap:2px}
dt{margin-top:8px}
table,thead,tbody,tr,td{display:block;width:100%}
table.narrow{min-width:0}
thead{display:none}
tr{border:1px solid var(--line);border-radius:8px;margin:0 0 10px;padding:6px 10px;background:var(--card)}
td{border:0;padding:3px 0}
td::before{content:attr(data-label);display:block;font-size:.74rem;color:var(--muted)}
}
@media print{
:root{--bg:#fff;--card:#fff;--soft:#f3f3f3}
body{font-size:11pt}
main{max-width:none;padding:0}
h2{break-after:avoid}
tr,.tile{break-inside:avoid}
summary{display:none}
a{text-decoration:none}
}`;

/** Opens every collapsed list for printing, and closes the ones it opened afterwards. */
const SCRIPT = `addEventListener("beforeprint",()=>{for(const d of document.querySelectorAll("details:not([open])")){d.open=true;d.dataset.printed="1"}});addEventListener("afterprint",()=>{for(const d of document.querySelectorAll("details[data-printed]")){d.open=false;delete d.dataset.printed}});`;

/** The owner's report as one HTML file. */
export function renderReport(data: DocumentData, ctx: ReportContext): string {
  const f = factsOf(data, ctx);
  const title = `${ctx.redactor.text(data.tenant)} · configuration assurance`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>
${CSS}
</style>
</head>
<body>
<main>
${headerHtml(f)}
${tilesHtml(f)}
${storyHtml(f)}
${needsHtml(f)}
${heldHtml(f)}
${adoptedHtml(f)}
${actionsHtml(f)}
${coverageHtml(f)}
${footerHtml(f)}
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** The repository's tip commit, 12 hex, for the footer of a live report; null outside a git checkout or without git. */
export function repoTip(root: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8", timeout: 10_000, windowsHide: true });
  const tip = r.status === 0 ? r.stdout.trim() : "";
  return /^[0-9a-f]{7,40}$/.test(tip) ? tip : null;
}

/** report.html beside document.md: the document's file name with "document" read as "report" and .md as .html. */
export function reportPathOf(documentPath: string): string {
  const dir = documentPath.slice(0, Math.max(documentPath.lastIndexOf("/"), documentPath.lastIndexOf("\\")) + 1);
  const base = documentPath.slice(dir.length);
  const named = base.replace(/^document/, "report").replace(/\.md$/i, ".html");
  return `${dir}${named === base ? `${base}.report.html` : named.endsWith(".html") ? named : `${named}.html`}`;
}
