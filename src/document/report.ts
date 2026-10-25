// The owner's report: one static HTML file per tenant, written beside document.md, for an MSP owner or a client with
// one minute. The first screen answers, in this order, whether anything is wrong, who is handling it and what changed;
// below it, what is held and until when, what is adopted, what the agent did, what it watched and where to look deeper.
// Every fact with a source in the repository links to it.
//
// Contract: renderReport(data, ctx) is a pure function of the rows the owner's document is rendered from
// (src/document/render.ts DocumentResult.data, the same queries, none of its own) and of what the run knows beside
// them (ctx: the pass's findings, the cycle's act and tickets results, the mode, the trace, the tip, the policy file
// and the links base). It returns one HTML file: inline CSS, no external script, font or stylesheet, one small inline
// script (the evidence toggles; every fold opened for printing, and closed again after); light and dark through
// prefers-color-scheme, light tokens forced in print; readable at phone width with a 16 px gutter and no horizontal
// scroll (a table becomes one block per row under 640 px). Every data string passes ctx.redactor before it is escaped,
// the tenant's redactor live and BUNDLE_REDACTOR in sample mode; the caller runs the deny-list probe over the result
// before it writes the file, as it does for document.md. The only absolute URLs are tickets' own links, and only
// when the redactor leaves the stored URL as it is and it carries no pseudonym; otherwise the number is plain text.
//
// Links are relative to the file: ctx.links, over reportLinks(ctx), which reads the mode off ctx. In sample mode
// (ctx.bundle) the file is examples/report.html beside examples/document.md, so ../docs/index.html, document.md,
// traces/<id>.jsonl, ../policy/hackathon.json, README.md; live it is report.html beside document.md at the root, so
// docs/index.html, document.md, logs/<trace>.jsonl, policy/hackathon.json. src/document/sample.ts adds the replay
// page's anchors and the latest eval summary, which only the files can say.
//
//   bar            sticky, one line that wraps on phones: "<n> need(s) you · <n> held · <n> adopted · nothing changed
//                  | <n> actions", each a link to its section, a failing source added when one fails the DQ gate; at
//                  the right the tenant (the h1), the decision instant (UTC) and the mode.
//   first screen   two columns from 900 px (2/3, 1/3). Left: Needs a person, one card per ESCALATE and FIX: the label
//                  with the verb badge, where, since when and why, the cause's sentence, then the link row (ticket,
//                  evidence toggle over the evidence, what the agent did and the cause's diff, trace, vault copy,
//                  rule or lesson, replay); then What happened, the cycle's sentences (present.ts whatHappened),
//                  STORY_SHOWN of them before a fold, each followed by its links. Right: four tiles, findings open by
//                  verb, copies with a valid restore, actions this cycle, tickets open, each a link into its section.
//   Held with an expiry        label, where, held until with "in n h" or "n h overdue" from the decision instant,
//                              the reason in few words, the rule or lesson.
//   Adopted under the technician's exceptions   the count and the exception's reason; a folded table by lesson
//                              (lesson, expiry, what, the findings' objects); the adoptions under policy rules and the
//                              default after it.
//   Actions        newest first, at most ACTIONS_SHOWN: time, action, target, status, verification, model and receipt.
//   Coverage       "3 sources read: ... · n settings watched · n queries through ..."; the latest read of each
//                  source; the probes and the validations in one line each; the gate line; the notes.
//   Look deeper    the document, the trace, the replay page, the policy file, the committed traces, the eval summary
//                  and the README, each with a few words of what it is.
//   footer         the agent and the tip, the policy file and version, the sponsor stack, the trace or the bundle.
//
// Measured 25 Oct 2026 over sample/bundle.json for client-1 (test/report.test.ts, examples/report.html): the bar
// "1 needs you · 3 held · 23 adopted · nothing changed"; one card, the proxy_split ESCALATE with its cause, ticket #2
// (plain text: the bundle's URL is pseudonymised) and the replay anchor proxy-split-1; the 3 holds in 57 h; 23
// adoptions under 15 lessons; the tiles 27 findings, 112 of 112 copies, 0 actions, 1 ticket; 30,095 bytes of the
// 300,000-byte budget, the same bytes from npm run sample, npm run document and npm run examples.

import { spawnSync } from "node:child_process";
import { actionOf } from "../actions/plan.ts";
import type { Action, FindingCause, PolicyRule } from "../data/rows.ts";
import { withRestore } from "../explain/cause.ts";
import {
  MODE, actionObject, classLabel, findingWhere, hex8, nemotronOf, outcomeLine, reasonClauses, tail, thousands, whatHappened,
  type ActFacts, type CauseFacts, type Phrase, type TicketFacts,
} from "../loop/present.ts";
import type { Finding, Verb } from "../pipeline.ts";
import type { DocumentData, OpenDisposition } from "./render.ts";

/** The report's budget with the sample data. */
export const REPORT_MAX_BYTES = 300_000;
/** Actions the Actions table lists; the rest are counted in one line. */
export const ACTIONS_SHOWN = 20;
/** Sentences of What happened before the fold. */
export const STORY_SHOWN = 3;
/** The mode the bar names. */
export const REPORT_MODE = { applied: "applied", dryRun: MODE.dryRun } as const;
export type ReportMode = (typeof REPORT_MODE)[keyof typeof REPORT_MODE];
/** The sponsor stack the footer names. */
export const STACK_LINE = "Zetaris Lightning SQL over the DRIFT datasource; Meterless World Model and H-MEM; Nemotron through Nightshift, every call on a verified receipt";
/** A ticket number whose stored URL the report does not link. */
export const TICKET_UNLINKED = "configured in the PSA";

/** Where the report's links point, each relative to the report file; null where the report has nothing to link. */
export interface ReportLinks {
  /** The replay page (docs/index.html). */
  replay: string | null;
  /** Finding id to its anchor on the replay page, for the findings the page carries. */
  replayAnchors: Readonly<Record<string, string>>;
  /** The owner's document beside the report. */
  document: string | null;
  /** This run's trace file. */
  trace: string | null;
  /** The policy file the rules were loaded from. */
  policy: string | null;
  /** The committed traces' README. */
  traces: string | null;
  /** The eval summary. */
  eval: string | null;
  /** The README beside the report (examples/README.md in sample mode, the repository's live). */
  readme: string | null;
  /** The technician's lesson store. */
  lessons: string | null;
  /** The receipts file the actions' receipt ids are in. */
  receipts: string | null;
}

export interface ReportContext {
  /** Every data string passes it before it is escaped. */
  redactor: { text(s: string): string };
  mode: ReportMode;
  /** The agent the footer names; ConfigLeaf when absent. */
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
  /** The links, over the ones reportLinks infers from the mode. */
  links?: Partial<ReportLinks>;
}

/** A path relative to the repository root as given, forward slashes; null for an absolute path or a URL. */
const relative = (p: string | null | undefined): string | null => (p && !/^(?:[A-Za-z]:)?[\\/]/.test(p) && !/^[a-z][a-z0-9+.-]*:/i.test(p) ? p.replace(/\\/g, "/") : null);

/** The links the mode implies: examples/report.html in sample mode (ctx.bundle), report.html at the root live. */
export function reportLinks(ctx: Pick<ReportContext, "bundle" | "trace" | "policyFile">): ReportLinks {
  const policy = relative(ctx.policyFile);
  if (ctx.bundle) {
    return {
      replay: "../docs/index.html", replayAnchors: {}, document: "document.md", trace: ctx.trace ? `traces/${ctx.trace.id}.jsonl` : null,
      policy: policy ? `../${policy}` : null, traces: "traces/README.md", eval: null, readme: "README.md", lessons: "memory/state.json", receipts: null,
    };
  }
  return {
    replay: "docs/index.html", replayAnchors: {}, document: "document.md", trace: relative(ctx.trace?.path), policy,
    traces: "examples/traces/README.md", eval: "README.md#evaluation", readme: "README.md", lessons: null, receipts: null,
  };
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
/** 25 Oct 2026; the input as given when it is no instant. */
function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
/** How far an expiry is from the decision instant, in whole hours: "in 57 h", "4 h overdue"; under an hour, "in under 1 h" or "under 1 h overdue". */
export function untilPhrase(expiresAt: string | null | undefined, at: string | null | undefined): string | null {
  const e = expiresAt ? Date.parse(expiresAt) : NaN;
  const n = at ? Date.parse(at) : NaN;
  if (Number.isNaN(e) || Number.isNaN(n)) return null;
  const h = Math.floor(Math.abs(e - n) / 3_600_000);
  if (e >= n) return h < 1 ? "in under 1 h" : `in ${thousands(h)} h`;
  return h < 1 ? "under 1 h overdue" : `${thousands(h)} h overdue`;
}
const plural = (n: number, one: string, many = `${one}s`): string => `${thousands(n)} ${n === 1 ? one : many}`;
const isAre = (n: number): string => (n === 1 ? "is" : "are");
const list = (xs: readonly string[]): string => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** One phrase of a terminal line as plain text. */
const phraseText = (p: Phrase): string => (typeof p === "string" ? p : Array.isArray(p) ? p.map((s) => (typeof s === "string" ? s : s.text)).join("") : (p as { text: string }).text);
/** The first letter upper case: a class label as a heading. */
const cap = (s: string): string => s.replace(/^./, (c) => c.toUpperCase());
/** A link; the text alone when there is nowhere to point. `href` is escaped here, `html` is already HTML. */
const link = (href: string | null | undefined, html: string, title?: string): string =>
  href ? `<a href="${escapeHtml(href)}"${title ? ` title="${title}"` : ""}>${html}</a>` : title ? `<span title="${title}">${html}</span>` : html;
/** Text in a span of class `cls`; the text alone when cls is empty. */
const marked = (cls: string, html: string): string => (cls ? `<span class="${cls}">${html}</span>` : html);
/** An id fragment from data: letters, digits and dashes. */
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The verbs in the order the owner reads them: what needs a person first. */
const VERB_ORDER: readonly Verb[] = ["ESCALATE", "FIX", "ROLLBACK", "HOLD", "ADOPT"];
/** The section each verb's findings are in. */
const VERB_SECTION: Readonly<Record<Verb, string>> = { ESCALATE: "#needs", FIX: "#needs", ROLLBACK: "#actions", HOLD: "#held", ADOPT: "#adopted" };
const NEEDS: readonly string[] = ["FIX", "ESCALATE"];
const KIND_WORD: Readonly<Record<string, string>> = { rollback_file: "rollback of a file", revert_record: "revert of a DNS record", investigate: "investigation", fix: "fix" };
const STATUS_WORD: Readonly<Record<string, string>> = { done: "done", unverified: "written, not verified", failed: "failed", refused: "refused, nothing written", not_judged: "not judged" };
const ADOPTED_UNDER: Readonly<Record<string, string>> = { operator: "the technician's exceptions", policy: "policy rules", default: "the default checks" };
/** A pseudonym the redactor writes: a URL that carries one points nowhere real. */
const PSEUDONYM = /\b(?:host|ip|word|mail|user|domain)-[0-9a-f]{6}\b/;

/** Each collection surface in plain words: its name (with the host for a host surface) and what it holds. */
const SURFACES: Readonly<Record<string, { name: (host: string) => string; holds: string; rank: number }>> = {
  "cloudflare.dns": { name: () => "DNS records", holds: "every zone's records, each field as the provider returns it", rank: 0 },
  "cloudflare.audit": { name: () => "Provider audit log", holds: "who changed which record and when", rank: 1 },
  "linux.nginx": { name: (h) => `nginx on ${h}`, holds: "each vhost file and setting, read over SSH", rank: 2 },
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
  links: ReportLinks;
  /** Data text: redacted, then escaped. */
  t: (s: string | number | null | undefined) => string;
  findingOf: (d: OpenDisposition) => Finding | undefined;
  /** The open dispositions' causes, by disposition. */
  causes: Map<string, CauseFacts>;
  /** The stored cause rows, by disposition: the diff. */
  causeRows: Map<string, FindingCause>;
  actions: Action[];
  /** The actions on the open dispositions: this cycle's. */
  thisCycle: Action[];
  /** The record zone of each record copy at the heads, by object. */
  zoneOf: Map<string, string>;
  ticketsOf: (findingId: string) => Row[];
  /** The latest version of each policy rule, by id. */
  ruleOf: Map<string, PolicyRule>;
}

function factsOf(data: DocumentData, ctx: ReportContext): Facts {
  const t = (s: string | number | null | undefined): string => escapeHtml(ctx.redactor.text(s === null || s === undefined ? "" : String(s)));
  const byId = new Map((ctx.findings ?? []).map((f) => [f.id, f]));
  const openIds = new Set(data.open.map((d) => d.disposition_id));
  // the rows the page read; the explain step's own causes when the page could not read them
  const causes = new Map<string, CauseFacts>((data.causes ?? ctx.causes ?? []).filter((c) => openIds.has(c.disposition_id)).map((c) => [c.disposition_id, c]));
  const causeRows = new Map((data.causes ?? []).map((c) => [c.disposition_id, c]));
  const actions = (data.actions ?? []).map(actionOf).sort((a, b) => cmp(b.started_at, a.started_at) || cmp(b.action_id, a.action_id));
  const zoneOf = new Map(data.copies.filter((c) => c.zone).map((c) => [c.object_id, c.zone]));
  const ruleOf = new Map<string, PolicyRule>();
  for (const r of data.rules) if (!ruleOf.has(r.rule_id) || Number(ruleOf.get(r.rule_id)!.version) < Number(r.version)) ruleOf.set(r.rule_id, r);
  // a ticket's open state first, then its number
  const rank = (x: Row): number => (x.status === "open" ? 0 : 1);
  return {
    data, ctx, t, causes, causeRows, actions, zoneOf, ruleOf,
    links: { ...reportLinks(ctx), ...ctx.links },
    findingOf: (d) => byId.get(d.finding_id),
    thisCycle: actions.filter((a) => openIds.has(a.disposition_id)),
    ticketsOf: (id) => data.tickets.filter((x) => x.finding_id === id).sort((a, b) => rank(a) - rank(b) || Number(a.external_id || 0) - Number(b.external_id || 0)),
  };
}

/** Where a finding is, in two parts: the object in plain words with its setting, and its host or its record's zone. */
function placeOf(f: Facts, d: OpenDisposition): { object: string; at: string } {
  const finding = f.findingOf(d)?.finding;
  if (d.surface === "cloudflare.dns") {
    const zone = f.zoneOf.get(d.object_id);
    return { object: `DNS record ${finding?.dns_name || d.object_id}${d.setting_path ? ` (${d.setting_path})` : ""}`, at: zone ? `zone ${zone}` : "" };
  }
  const setting = d.setting_path && d.setting_path !== "file" ? ` (${d.setting_path})` : "";
  return { object: `${tail(d.object_id)}${setting}`, at: d.host || finding?.host || "" };
}
const whereText = (p: { object: string; at: string }): string => (p.at ? `${p.object} · ${p.at}` : p.object);

/** A finding's object without its setting, for a list: a record by name, a file on its host. */
function objectOf(f: Facts, d: OpenDisposition): string {
  if (d.surface === "cloudflare.dns") return `DNS record ${f.findingOf(d)?.finding.dns_name || d.object_id}`;
  return `${tail(d.object_id)}${d.host ? ` on ${d.host}` : ""}`;
}

/** The replay page at the finding's anchor, when the page carries the finding. */
function replayOf(f: Facts, findingId: string): string | null {
  const anchor = f.links.replayAnchors[findingId];
  return f.links.replay && anchor ? `${f.links.replay}#${anchor}` : null;
}

/** A ticket's number: a link to its PSA url when the redactor leaves the url as it is and it names no pseudonym; else plain, titled. */
function ticketRef(f: Facts, x: Row): string {
  const n = f.t(x.external_id ? `#${x.external_id}` : x.ticket_id);
  const url = x.url ?? "";
  const intact = /^https?:\/\//i.test(url) && f.ctx.redactor.text(url) === url && !PSEUDONYM.test(url);
  return intact ? `<a href="${escapeHtml(url)}">${n}</a>` : `<span class="tk" title="${TICKET_UNLINKED}">${n}</span>`;
}

/** A policy rule's id as a link into the policy file, the rule in a few words as its title. */
function ruleRef(f: Facts, id: string): string {
  const r = f.ruleOf.get(id);
  const title = r ? f.t(`${r.surface} ${r.object_glob} ${r.setting_glob}: ${r.criticality}, lock ${r.lock}, on drift ${r.on_drift}, hold ${r.hold_max_hours} h`) : undefined;
  return link(f.links.policy ? `${f.links.policy}#${id}` : null, f.t(id), title);
}

/** A lesson's id as a link to the technician's lesson store. */
const lessonRef = (f: Facts, id: string): string => link(f.links.lessons, f.t(id));

/** The lesson an adoption or a lapse rests on: the pass's, else read off the disposition's reason. */
function lessonOf(f: Facts, d: OpenDisposition): string | null {
  return f.findingOf(d)?.exception?.lesson ?? d.reason.match(/accepted exception (\S+) (?:holds|lapsed)/)?.[1] ?? d.reason.match(/exception lapsed: (\S+) expired/)?.[1] ?? null;
}

/** Who decided, as a link: the rule, the lesson, or the default. */
function underRef(f: Facts, d: OpenDisposition): string {
  if (d.rule_id) return ruleRef(f, d.rule_id);
  const lesson = lessonOf(f, d);
  if (lesson) return lessonRef(f, lesson);
  return f.t(d.decided_by === "default" ? "the default checks" : d.decided_by);
}

/** The latest run of each surface and host, whatever its gate result, in the order SURFACES gives. */
function latestRuns(data: DocumentData): DocumentData["runs"] {
  const m = new Map<string, DocumentData["runs"][number]>();
  for (const r of data.runs) m.set(`${r.surface}\u001f${r.host}`, r);
  const rank = (s: string): number => SURFACES[s]?.rank ?? 99;
  return [...m.values()].sort((a, b) => rank(a.surface) - rank(b.surface) || cmp(a.surface, b.surface) || cmp(a.host, b.host));
}

const surfaceName = (r: { surface: string; host: string }): string => SURFACES[r.surface]?.name(r.host) ?? `${r.surface}${r.host ? ` on ${r.host}` : ""}`;
/** The id of a source's row in Coverage. */
const sourceId = (f: Facts, surface: string, host: string): string => `src-${slug(surface)}${host ? `-${slug(f.ctx.redactor.text(host))}` : ""}`;
/** The Coverage row a disposition's rows come from: the DNS records for a record, the host's nginx for a file. */
const sourceOf = (d: OpenDisposition): { surface: string; host: string } => (d.surface.startsWith("cloudflare.") ? { surface: d.surface, host: "" } : { surface: d.surface, host: d.host });

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

/** Why a finding needs a person, in its few words: the Decider's reason without the owner. */
const shortWhy = (reason: string): string => reasonClauses(reason).join(", ").replace(/, a technician owns it$/, "");

/** Why a finding is held, in its few words; the Decider's own sentence is the cell's title. */
function heldWhy(f: Facts, d: OpenDisposition): string {
  const r = d.rule_id ? f.ruleOf.get(d.rule_id) : undefined;
  const rule = r ? `${r.criticality} rule, holds up to ${r.hold_max_hours} h` : "";
  const drift = d.reason.match(/^(.*?)(?:,| with| and|;) (?:so )?rule \S+ holds it until/)?.[1];
  if (drift) return `${drift}${rule ? `; ${rule}` : ""}`;
  if (/concerns the setting's relation to another setting/.test(d.reason)) return `a relation between settings, not a value${rule ? `; ${rule}` : ""}`;
  if (/^rule \S+ \(\w+\) holds this \w+ finding until/.test(d.reason) && rule) return rule;
  return reasonClauses(d.reason).join(", ");
}

// ---- the bar --------------------------------------------------------------------------------------------------

function barHtml(f: Facts): string {
  const { data, t } = f;
  const n = (v: string): number => data.open.filter((d) => d.verb === v).length;
  const needs = n("FIX") + n("ESCALATE");
  const acts = f.thisCycle.length;
  const failing = latestRuns(data).filter((r) => !r.passes).length;
  const items = [
    `<a href="#needs"${needs ? ' class="need"' : ""}><b>${thousands(needs)}</b> ${needs === 1 ? "needs" : "need"} you</a>`,
    `<a href="#held"><b>${thousands(n("HOLD"))}</b> held</a>`,
    `<a href="#adopted"><b>${thousands(n("ADOPT"))}</b> adopted</a>`,
    acts ? `<a href="#actions"><b>${thousands(acts)}</b> ${acts === 1 ? "action" : "actions"}</a>` : `<a href="#actions">nothing changed</a>`,
    ...(failing ? [`<a href="#coverage" class="need"><b>${thousands(failing)}</b> ${failing === 1 ? "source fails" : "sources fail"} the gate</a>`] : []),
  ];
  return `<header class="bar"><div class="bar-in">
<nav class="sum" aria-label="Summary">${items.join(" · ")}</nav>
<div class="who"><h1>${t(data.tenant)} · configuration assurance</h1><span>${t(utc(data.decidedAt))}</span><span>${t(f.ctx.mode)}</span></div>
</div></header>`;
}

// ---- Needs a person --------------------------------------------------------------------------------------------

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

/** The vault copy at the head for a disposition's object, when the vault holds one. */
function copyOf(f: Facts, d: OpenDisposition): Row | undefined {
  return f.data.copies.find((c) => c.object_id === d.object_id && c.surface === d.surface && (d.surface === "cloudflare.dns" || (c.host || "") === (d.host || "")));
}

const ul = (f: Facts, xs: readonly string[]): string => `<ul>${xs.map((s) => `<li>${f.t(s)}</li>`).join("")}</ul>`;

function needCard(f: Facts, d: OpenDisposition): string {
  const { t } = f;
  const finding = f.findingOf(d);
  const id = t(d.finding_id);
  const e = finding?.exposure;
  const since = e ? `since ${day(e.since)} (${e.bound === "exact" ? "" : "at least "}${plural(e.days, "day")})` : `decided ${day(d.decided_at)}`;
  const cause = f.causes.get(d.disposition_id);
  const causeLine = cause ? t(withRestore(cause, f.actions))
    : `<span class="muted">${f.data.causesError ? `The cause was not read: ${t(f.data.causesError)}.` : "No cause is recorded for this decision."}</span>`;
  const tickets = f.ticketsOf(d.finding_id);
  const copy = copyOf(f, d);
  const replay = replayOf(f, d.finding_id);
  const linkRow = [
    tickets.length ? `<span>ticket ${tickets.map((x) => ticketRef(f, x)).join(", ")}</span>` : `<span class="muted">no ticket</span>`,
    `<button type="button" class="tog" data-fold="ev-${id}" aria-controls="ev-${id}" aria-expanded="false">evidence</button>`,
    ...(f.links.trace ? [link(f.links.trace, "trace")] : []),
    ...(copy?.git_commit ? [`<span title="${t(`vault commit ${copy.git_commit}, taken ${utc(copy.taken_at)}, validated ${copy.result || "not yet"}`)}">vault copy ${t(hex8(copy.git_commit))}</span>`] : []),
    `<span>${d.rule_id ? ruleRef(f, d.rule_id) : lessonOf(f, d) ? `lesson ${lessonRef(f, lessonOf(f, d)!)}` : t(`decided by ${d.decided_by}`)}</span>`,
    ...(replay ? [link(replay, "replay")] : []),
  ];
  const evidence = finding
    ? [finding.finding.summary, ...finding.checks.filter((c) => !c.holds).map((c) => c.explanation), ...finding.rejected.map((r) => `A check did not run: ${r.reason}`)].filter(Boolean)
    : [];
  const diff = f.causeRows.get(d.disposition_id)?.diff;
  const fold = [
    ...(evidence.length ? [`<p class="fh">Evidence</p>${ul(f, evidence)}`] : [`<p class="fh">Evidence</p><p class="muted">The pass's findings were not given to this report.</p>`]),
    `<p class="fh">What the agent did</p>${ul(f, didLines(f, d, finding))}`,
    ...(diff ? [`<p class="fh">Diff</p><pre>${t(diff)}</pre>`] : []),
    ...(tickets.length ? [`<p class="fh">Tickets</p><ul>${tickets.map((x) => `<li>${ticketRef(f, x)} ${t(`${x.type}, ${x.priority}, ${x.status}`)}</li>`).join("")}</ul>`] : []),
    `<p class="fid">${t(`finding ${d.finding_id} · ${d.verb} by ${d.decided_by}${d.rule_id ? ` under ${d.rule_id}` : ""} · decided ${utc(d.decided_at)}`)}</p>`,
  ];
  return `<article class="card" id="${id}">
<h3><span class="badge v-${t(d.verb)}">${t(d.verb)}</span>${t(cap(classLabel(d.class)))}</h3>
<p class="where">${t(whereText(placeOf(f, d)))}</p>
<p class="when">${t(`${since} · ${shortWhy(d.reason)}`)}</p>
<p class="cause">${causeLine}</p>
<p class="links">${linkRow.join("\n")}</p>
<div class="fold" id="ev-${id}" hidden>
${fold.join("\n")}
</div>
</article>`;
}

function needsHtml(f: Facts): string {
  const { t } = f;
  const needs = f.data.open.filter((d) => NEEDS.includes(d.verb));
  const failing = latestRuns(f.data).filter((r) => !r.passes);
  const gate = failing.length
    ? `<p class="alert"><b>${plural(failing.length, "source")} ${failing.length === 1 ? "fails" : "fail"} the DQ gate on its last read</b>: ${failing.map((r) => `${t(surfaceName(r))} (${t(gateWhy(r))})`).join("; ")}. <a href="#coverage">Coverage</a></p>\n`
    : "";
  const none = !f.data.runs.length ? `<p class="alert">No collection run of this tenant is on record: nothing is watched.</p>` : `<p class="calm">Nothing needs a person: no finding is escalated or waiting on a fix.</p>`;
  return `<section id="needs">
<h2>Needs a person</h2>
${gate}${needs.length ? needs.map((d) => needCard(f, d)).join("\n") : none}
</section>`;
}

// ---- What happened ---------------------------------------------------------------------------------------------

/** The links one of the cycle's sentences names: the cards, tickets and sources of the findings it tells, its sections. */
function storyLinks(f: Facts, s: string): string {
  const out = new Map<string, string>();
  const add = (key: string, html: string): void => { if (!out.has(key)) out.set(key, html); };
  const tech = /with a technician/.test(s);
  const cards: string[] = [];
  for (const d of f.data.open.filter((x) => NEEDS.includes(x.verb))) {
    const finding = f.findingOf(d);
    const where = finding ? findingWhere(finding.finding, false) : d.object_id;
    if (!s.includes(where) && !(tech && d.verb === "ESCALATE")) continue;
    cards.push(d.finding_id);
    add(`card ${d.finding_id}`, "");
    for (const x of f.ticketsOf(d.finding_id).filter((k) => k.status === "open")) add(`ticket ${x.ticket_id}`, `ticket ${ticketRef(f, x)}`);
    const src = sourceOf(d);
    add(`src ${src.surface} ${src.host}`, `<a href="#${sourceId(f, src.surface, src.host)}">${f.t(surfaceName(src))}</a>`);
  }
  cards.forEach((id, i) => out.set(`card ${id}`, `<a href="#${f.t(id)}">${cards.length === 1 ? "finding" : `finding ${i + 1}`}</a>`));
  for (const m of s.matchAll(/#(\d+)/g)) {
    const x = f.data.tickets.find((k) => k.external_id === m[1]);
    if (x) add(`ticket ${x.ticket_id}`, `ticket ${ticketRef(f, x)}`);
  }
  for (const h of f.data.hosts) if (h && s.includes(h)) add(`src linux.nginx ${h}`, `<a href="#${sourceId(f, "linux.nginx", h)}">${f.t(surfaceName({ surface: "linux.nginx", host: h }))}</a>`);
  if (/\badopted\b/.test(s)) add("adopted", `<a href="#adopted">adopted</a>`);
  if (/\bheld\b/.test(s)) add("held", `<a href="#held">held</a>`);
  if (/Nothing changed|--apply|\bthe agent\b|restor|investigat|actions? (?:is|are) listed/.test(s)) add("actions", `<a href="#actions">actions</a>`);
  const items = [...out.values()].filter(Boolean);
  return items.length ? ` <span class="go">${items.map((x) => `<span class="nw">${x}</span>`).join(" · ")}</span>` : "";
}

function storyHtml(f: Facts): string {
  const { data, ctx, t } = f;
  const findings = ctx.findings ? [...ctx.findings] : data.open.map((d) => asFinding(d, data.tenant));
  const causes: CauseFacts[] = ctx.causes ? [...ctx.causes] : [...f.causes.values()];
  const story = whatHappened({ pass: { findings, decidedAt: data.decidedAt ?? undefined }, act: ctx.act ?? null, actSettled: ctx.actSettled ?? false, tickets: ctx.tickets ?? null, causes });
  const lines = story.length ? story : [data.open.length ? "The latest runs carry the findings below." : "The latest passing runs carry no open finding."];
  const item = (s: string): string => `<li><p class="story">${t(s)}</p>${storyLinks(f, s)}</li>`;
  const rest = lines.slice(STORY_SHOWN);
  return `<section id="what-happened">
<h2>What happened</h2>
<ul class="stories">
${lines.slice(0, STORY_SHOWN).map(item).join("\n")}
</ul>${rest.length ? `\n<details><summary>${plural(rest.length, "more sentence")}</summary>\n<ul class="stories">\n${rest.map(item).join("\n")}\n</ul>\n</details>` : ""}
</section>`;
}

// ---- tiles -----------------------------------------------------------------------------------------------------

/** The six tiles' numbers, for the page and for a test: the first screen shows four, Coverage's first line the sources and settings. */
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
  for (const v of ["ADOPT", "HOLD", "ESCALATE", "FIX", "ROLLBACK"] as const) {
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

function tile(href: string, key: string, value: string, sub: string, cls = ""): string {
  return `<div class="tile${cls ? ` ${cls}` : ""}"><a class="tl" href="${href}"><span class="k">${key}</span><span class="v">${value}</span></a><p class="s">${sub}</p></div>`;
}

function tilesHtml(f: Facts): string {
  const k = tileFacts(f.data, f.ctx);
  const verbs = VERB_ORDER.filter((v) => k.findings.verbs[v]).map((v) => `<a class="v-${v}" href="${VERB_SECTION[v]}">${v} ${thousands(k.findings.verbs[v]!)}</a>`).join(" · ") || "none open";
  const a = k.actions;
  const actionSub = [`done ${a.done}`, `refused ${a.refused}`, `unverified ${a.unverified}`, ...(a.failed ? [`failed ${a.failed}`] : []), ...(a.notJudged ? [`not judged ${a.notJudged}`] : [])].join(" · ")
    + (a.planned !== null ? `<br>dry run: ${plural(a.planned, "action")} planned` : "");
  const needs = (k.findings.verbs.ESCALATE ?? 0) + (k.findings.verbs.FIX ?? 0);
  const c = k.copies;
  const open = f.data.tickets.filter((x) => x.status === "open");
  return `<aside class="tiles" aria-label="At a glance">
${tile("#needs", "Findings open", thousands(k.findings.total), verbs, needs ? "has-need" : "")}
${tile("#validation", "Copies with a valid restore", `${thousands(c.valid)} <small>of ${thousands(c.total)}</small>`, c.total ? `${c.ok} ok · ${c.gaps} with gaps · ${c.fail} fail${c.none ? ` · ${c.none} not validated` : ""}` : "no copy in the vault", c.fail || c.none || !c.total ? "warn" : "")}
${tile("#actions", "Actions this cycle", thousands(a.total), actionSub)}
${tile("#needs", "Tickets open", thousands(k.tickets.open), open.length ? open.slice(0, 6).map((x) => ticketRef(f, x)).join(", ") + (open.length > 6 ? ", ..." : "") : "none open")}
</aside>`;
}

// ---- Held, Adopted ---------------------------------------------------------------------------------------------

/** A table: a header row, each cell labelled for the narrow layout. */
function tableHtml(head: readonly string[], rows: readonly (readonly string[])[], cls = "", rowIds: readonly string[] = []): string {
  return `<table${cls ? ` class="${cls}"` : ""}>
<thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead>
<tbody>
${rows.map((r, i) => `<tr${rowIds[i] ? ` id="${rowIds[i]}"` : ""}>${r.map((c, j) => `<td data-label="${head[j]}">${c}</td>`).join("")}</tr>`).join("\n")}
</tbody>
</table>`;
}

function heldHtml(f: Facts): string {
  const { t } = f;
  const held = f.data.open.filter((d) => d.verb === "HOLD").sort((a, b) => cmp(a.expires_at, b.expires_at) || cmp(a.finding_id, b.finding_id));
  if (!held.length) return `<section id="held">\n<h2>Held with an expiry</h2>\n<p class="muted">No finding is held.</p>\n</section>`;
  const rows = held.map((d) => {
    const rel = untilPhrase(d.expires_at, f.data.decidedAt);
    return [
      link(replayOf(f, d.finding_id), t(cap(classLabel(d.class)))),
      t(whereText(placeOf(f, d))),
      `<span class="nw">${t(utc(d.expires_at))}</span>${rel ? ` <span class="rel${/overdue/.test(rel) ? " late" : ""}">${t(rel)}</span>` : ""}`,
      `<span title="${t(d.reason)}">${t(heldWhy(f, d))}</span>`,
      underRef(f, d),
    ];
  });
  return `<section id="held">
<h2>Held with an expiry</h2>
<p>${plural(held.length, "finding")} ${isAre(held.length)} held. At its expiry a held finding becomes an escalation unless a pass finds the setting at its approved value.</p>
${tableHtml(["Label", "Where", "Held until", "Reason", "Under"], rows)}
</section>`;
}

/** An exception's reason: the lesson's own, from the pass, else read off the disposition's reason. */
function exceptionReason(f: Facts, d: OpenDisposition): string {
  const own = f.findingOf(d)?.exception?.reason;
  if (own) return own;
  return d.reason.match(/^accepted exception \S+ holds until \S+ \((.*)\); the checks alone/)?.[1] ?? d.reason;
}

/** The findings of one group as a comma list of their objects, a repeated object counted once with its settings. */
function objectList(f: Facts, xs: readonly OpenDisposition[]): string {
  const m = new Map<string, OpenDisposition[]>();
  for (const d of xs) m.set(objectOf(f, d), [...(m.get(objectOf(f, d)) ?? []), d]);
  return [...m].map(([o, ds]) => {
    const text = f.t(`${o}${ds.length > 1 ? ` (${ds.length} settings)` : ""}`);
    const replay = ds.map((d) => replayOf(f, d.finding_id)).find(Boolean);
    return link(replay, text);
  }).join(", ");
}

const labels = (xs: readonly OpenDisposition[]): string => [...new Set(xs.map((d) => classLabel(d.class)))].join("; ");

function adoptedHtml(f: Facts): string {
  const { t } = f;
  const adopted = f.data.open.filter((d) => d.verb === "ADOPT");
  const head = `<section id="adopted">\n<h2>Adopted under the technician's exceptions</h2>`;
  if (!adopted.length) return `${head}\n<p class="muted">No finding is adopted.</p>\n</section>`;
  const parts: string[] = [];
  const operator = adopted.filter((d) => d.decided_by === "operator");
  if (operator.length) {
    const reasons = [...new Set(operator.map((d) => exceptionReason(f, d)))];
    const byLesson = new Map<string, OpenDisposition[]>();
    for (const d of operator) { const k = lessonOf(f, d) ?? "-"; byLesson.set(k, [...(byLesson.get(k) ?? []), d]); }
    const lessons = [...byLesson].sort(([a], [b]) => (Number(a.replace(/\D/g, "")) || 0) - (Number(b.replace(/\D/g, "")) || 0) || cmp(a, b));
    const lead = `${plural(operator.length, "finding")} ${isAre(operator.length)} adopted under the technician's exceptions, each until its exception's expiry`;
    parts.push(reasons.length === 1
      ? `<p>${t(lead)}: <q>${t(reasons[0])}</q></p>`
      : `<p>${t(lead)}, under ${plural(reasons.length, "reason")}:</p>\n<ul>${reasons.map((r) => `<li><q>${t(r)}</q></li>`).join("")}</ul>`);
    const expiry = (xs: readonly OpenDisposition[]): string => t([...new Set(xs.map((d) => utc(f.findingOf(d)?.exception?.expires_at ?? d.expires_at)))].join(", "));
    parts.push(`<details><summary>The ${plural(operator.length, "finding")} by lesson, ${plural(lessons.length, "lesson")}</summary>
${tableHtml(["Lesson", "Expires", "What", "Findings"], lessons.map(([id, xs]) => [id === "-" ? "-" : lessonRef(f, id), `<span class="nw">${expiry(xs)}</span>`, t(labels(xs)), objectList(f, xs)]), "dense")}
</details>`);
  } else parts.push(`<p class="muted">No finding is adopted under the technician's exceptions.</p>`);
  const policy = adopted.filter((d) => d.decided_by === "policy");
  if (policy.length) {
    const byRule = new Map<string, OpenDisposition[]>();
    for (const d of policy) byRule.set(d.rule_id, [...(byRule.get(d.rule_id) ?? []), d]);
    parts.push(`<p>${t(`${plural(policy.length, "finding")} ${isAre(policy.length)} adopted under policy rules.`)}</p>
<details><summary>The ${plural(policy.length, "finding")} by rule</summary>
${tableHtml(["Rule", "What", "Findings"], [...byRule].sort(([a], [b]) => cmp(a, b)).map(([id, xs]) => [id ? ruleRef(f, id) : "-", t(labels(xs)), objectList(f, xs)]), "dense")}
</details>`);
  }
  const rest = adopted.filter((d) => d.decided_by !== "operator" && d.decided_by !== "policy");
  for (const by of [...new Set(rest.map((d) => d.decided_by))]) {
    const xs = rest.filter((d) => d.decided_by === by);
    parts.push(`<p>${t(`${plural(xs.length, "finding")} ${isAre(xs.length)} adopted under ${ADOPTED_UNDER[by] ?? by}: every check holds.`)}</p>
<details><summary>The ${plural(xs.length, "finding")}</summary>
<p>${t(labels(xs))}: ${objectList(f, xs)}</p>
</details>`);
  }
  return `${head}\n${parts.join("\n")}\n</section>`;
}

// ---- Actions ---------------------------------------------------------------------------------------------------

/** A receipt id as a link to the receipts file, when the links name one. */
const receiptRef = (f: Facts, id: string): string => link(f.links.receipts, f.t(id));

/** The served models and receipt ids an action names. */
function receiptsOf(f: Facts, a: Action): string {
  const ids = a.receipts.split(",").map((s) => s.trim()).filter(Boolean);
  if (a.kind === "investigate") {
    const n = nemotronOf(a.record.split("\n"));
    const parts = [
      ...(n.lightning ? [`Lightning ${f.t(n.lightning.model)} on ${receiptRef(f, n.lightning.receipt)}`] : []),
      ...(n.judge ? [`Ultra ${f.t(n.judge.model)} on ${receiptRef(f, n.judge.receipt)}`] : []),
    ];
    const named = [n.lightning?.receipt, n.judge?.receipt].filter(Boolean);
    const rest = ids.filter((r) => !named.includes(r)).map((r) => receiptRef(f, r));
    return [...parts, ...rest].join("; ") || "-";
  }
  return ids.map((r) => receiptRef(f, r)).join(", ") || "-";
}

function actionsHtml(f: Facts): string {
  const { t, data } = f;
  const head = `<section id="actions">\n<h2>Actions</h2>`;
  if (data.actions === null) return `${head}\n<p class="muted">The actions were not read for this report.</p>\n</section>`;
  if (!f.actions.length) return `${head}\n<p class="muted">No action is recorded for ${t(data.tenant)}.</p>\n</section>`;
  const mine = new Set(f.thisCycle.map((a) => a.action_id));
  const findings = f.ctx.findings ? { findings: [...f.ctx.findings] } : undefined;
  const shown = f.actions.slice(0, ACTIONS_SHOWN);
  const rows = shown.map((a) => [
    `<span class="nw">${t(utc(a.started_at))}</span>${mine.has(a.action_id) ? ` <span class="tag">this cycle</span>` : ""}`,
    t(KIND_WORD[a.kind] ?? a.kind),
    t(actionObject(a, findings)),
    `<span class="st-${t(a.status)}">${t(STATUS_WORD[a.status] ?? a.status)}</span>`,
    t(a.status === "done" && a.verification ? `verified by ${a.verification.split(",").filter(Boolean).join(", ")}; ${a.reason}` : a.reason || "-"),
    receiptsOf(f, a),
  ]);
  const more = f.actions.length - shown.length;
  const rest = more > 0
    ? `<p class="muted">${t(`${thousands(shown.length)} of ${plural(f.actions.length, "action")} shown.`)} The ${link(f.links.document, "document")} counts all of them by kind and status${f.links.trace ? `, and the ${link(f.links.trace, "trace")} lists this run's` : ""}.</p>`
    : "";
  return `${head}
<p>${t(`${plural(f.actions.length, "action")} recorded for ${data.tenant}, newest first; ${plural(f.thisCycle.length, "action")} on this cycle's decisions.`)}</p>
${tableHtml(["Time (UTC)", "Action", "Target", "Status", "Verification", "Model and receipt"], rows)}
${rest}
</section>`;
}

// ---- Coverage --------------------------------------------------------------------------------------------------

function coverageHtml(f: Facts): string {
  const { t, data, ctx } = f;
  const doc = (anchor: string, html: string): string => link(f.links.document ? `${f.links.document}#${anchor}` : null, html);
  const k = tileFacts(data, ctx);
  const src = [plural(k.sources.providers, "provider"), plural(k.sources.hosts, "host"), ...(k.sources.inventory ? ["1 inventory"] : [])].join(", ");
  const total = data.queries.reduce((n, q) => n + q.runs, 0);
  const z = ctx.zetaris;
  const queries = z
    ? `${doc("queries", `${thousands(z.queries)} queries`)} through Zetaris, ${marked(z.failed ? "fail" : "", `${thousands(z.failed)} failed`)}`
    : `${doc("queries", `${thousands(total)} queries`)} through ${t(data.source ?? "the data layer")}, 0 failed`;
  const first = `<p class="lead">${plural(k.sources.total, "source")} read: ${t(src)} · ${thousands(k.settings.settings)} settings watched · ${queries}</p>`;
  const latest = latestRuns(data);
  const sourceRows = latest.map((r) => [
    `<b>${t(surfaceName(r))}</b> <span class="muted">${t(SURFACES[r.surface]?.holds ?? "")}</span>`,
    `<span class="nw">${t(`${thousands(Number(r.observed_count) || 0)} of ${r.expected_count ? thousands(Number(r.expected_count)) : "?"}`)}</span>`,
    `<span class="nw">${t(utc(r.finished_at))}</span>`,
    r.passes ? `<span class="pass">passes</span>` : `<span class="fail">fails: ${t(gateWhy(r))}</span>`,
  ]);
  const p = data.probes;
  const kinds = [...new Set(p.byKind.map((x) => x.kind))].sort(cmp);
  const num = (kind: string, status: string): number => Number(p.byKind.find((x) => x.kind === kind && x.status === status)?.n ?? 0);
  const probed = p.byKind.reduce((n, x) => n + Number(x.n), 0);
  const failingBy = [...new Set(p.failing.map((x) => x.kind))].sort(cmp).map((kind) => `${t(kind)}: ${t([...new Set(p.failing.filter((x) => x.kind === kind).map((x) => x.target))].sort(cmp).join(", "))}`);
  const probes = p.run
    ? `<p id="probes">${doc("probes", "Probes")} at ${t(utc(p.run.finished_at))}: ${marked(p.failing.length ? "fail" : "", `${thousands(p.failing.length)} of ${thousands(probed)} fail`)} (${kinds.map((x) => t(`${x} ${num(x, "fail")}`)).join(", ")}${kinds.some((x) => num(x, "skipped")) ? `; ${thousands(kinds.reduce((n, x) => n + num(x, "skipped"), 0))} skipped` : ""}); ${plural(p.probeRuns, "probe run")} and ${plural(p.verifyRuns, "verification run")} pass the gate.</p>
${failingBy.length ? `<details><summary>The failing names</summary>\n<ul class="plain">${failingBy.map((s) => `<li>${s}</li>`).join("")}</ul>\n</details>` : ""}`
    : `<p id="probes" class="fail">No probe run of ${t(data.tenant)} passes the DQ gate: what the sites answer from outside is unknown.</p>`;
  const n = (r: string): number => data.copies.filter((c) => c.result === r).length;
  const gaps = [...new Set(data.copies.flatMap((c) => (c.missing_dependencies ?? "").split("\n").map((s) => s.trim()).filter(Boolean)))].sort(cmp);
  const validation = data.copies.length
    ? `<p id="validation">${doc("copies", "Copies")}: ${thousands(data.copies.length)} at the vault's heads, ${n("ok")} ok, ${n("ok_with_gaps")} ok with gaps, ${marked(n("fail") ? "fail" : "", `${n("fail")} fail`)}${n("") ? `, <span class="fail">${n("")} not validated</span>` : ""}.${gaps.length ? ` A copy with gaps restores once the ${plural(gaps.length, "dependency", "dependencies")} its validation names ${gaps.length === 1 ? "is" : "are"} in place.` : ""}</p>
${gaps.length ? `<details><summary>The ${plural(gaps.length, "gap")}</summary>\n<ul class="plain">${gaps.map((g) => `<li>${t(g)}</li>`).join("")}</ul>\n</details>` : ""}`
    : `<p id="validation" class="fail">The vault holds no copy for ${t(data.tenant)}: no restore is known to be possible.</p>`;
  const bad = data.runs.filter((r) => !r.passes);
  const gate = !data.runs.length ? `<p class="gate fail">No collection run of ${t(data.tenant)} is on record.</p>`
    : !bad.length ? `<p class="gate"><span class="pass">Every run passes the DQ gate</span>: ${thousands(data.runs.length)} of ${thousands(data.runs.length)}.</p>`
    : `<p class="gate"><span class="fail">${thousands(bad.length)} of ${plural(data.runs.length, "run")} fail the DQ gate</span>: ${bad.slice(0, 5).map((r) => `${t(surfaceName(r))} at ${t(utc(r.started_at))} (${t(gateWhy(r))})`).join("; ")}${bad.length > 5 ? `; ${thousands(bad.length - 5)} more` : ""}.</p>`;
  const notes: string[] = [];
  notes.push(`${doc("approvals", plural(data.approvals, "setting"))} ${data.approvals === 1 ? "has" : "have"} an approval of record; ${plural(data.locked.length, "locked setting")} ${data.locked.length === 1 ? "has" : "have"} no approved value${data.locked.length ? `: ${data.locked.map((l) => t(`${l.setting_path} in ${tail(l.object_id)}${l.host ? ` on ${l.host}` : ""}`)).join("; ")}` : ""}.`);
  if (data.unraised) notes.push(`${plural(data.unraised, "disposition")} on the latest runs ${data.unraised === 1 ? "concerns" : "concern"} a finding the pass no longer raises.`);
  const stops = (ctx.findings ?? []).filter((fd) => fd.earlyStop).map((fd) => `${fd.id}: the stop rule ended checking early (${fd.earlyStop!.reason}); not run: ${fd.earlyStop!.skipped.join(", ") || "none"}.`);
  const withheld = (ctx.findings ?? []).filter((fd) => fd.judgeWithheld).map((fd) => `${fd.id}: ${fd.judgeWithheld}.`);
  const noted = (count: number, what: string, lines: readonly string[]): string =>
    `${plural(count, "finding")} ${what}.<details><summary>Each one</summary><ul class="plain">${lines.map((l) => `<li>${t(l)}</li>`).join("")}</ul></details>`;
  if (stops.length) notes.push(noted(stops.length, `${stops.length === 1 ? "has" : "have"} its checking ended early by the stop rule`, stops));
  if (withheld.length) notes.push(noted(withheld.length, `${withheld.length === 1 ? "carries" : "carry"} no judge call, withheld by the stop rule`, withheld));
  if (data.causesError) notes.push(`The causes were not read: ${t(data.causesError)}.`);
  return `<section id="coverage">
<h2>Coverage</h2>
${first}
${tableHtml(["Source", "Rows", "Last read", "DQ gate"], sourceRows, "dense", latest.map((r) => sourceId(f, r.surface, r.host)))}
${probes}
${validation}
${gate}
<ul class="notes">${notes.map((s) => `<li>${s}</li>`).join("")}</ul>
</section>`;
}

// ---- Look deeper, footer ---------------------------------------------------------------------------------------

function deeperHtml(f: Facts): string {
  const L = f.links;
  const sample = Boolean(f.ctx.bundle);
  const items: [string | null, string, string][] = [
    [L.document, "The owner's document", "the same rows as markdown tables"],
    [L.trace, "The trace", L.trace ? "one JSON line per agent action" : "none in sample mode: this file keeps no trace"],
    [L.replay, "The replay page", "every check re-run with its SQL"],
    [L.policy, "The policy file", "the rules that set each verb"],
    [L.traces, "The committed traces", "recorded cycles, every agent action"],
    [L.eval, "The eval summary", "Nemotron configurations scored against labels"],
    [L.readme, sample ? "The examples README" : "The README", sample ? "how each example is cut" : "what the agent does and how"],
  ];
  return `<section id="deeper">
<h2>Look deeper</h2>
<ul class="deeper">
${items.map(([href, name, what]) => `<li>${href ? link(href, name) : `<span class="muted">${name}</span>`} <span class="what">${what}</span></li>`).join("\n")}
</ul>
</section>`;
}

function footerHtml(f: Facts): string {
  const { t, data, ctx } = f;
  const policy = policyOf(data.rules);
  const lines = [
    `Report by ${t(ctx.agent ?? "ConfigLeaf")}${ctx.tip ? ` at tip ${t(ctx.tip)}` : ""}.`,
    policy ? `Policy ${t(ctx.policyFile ?? "file not named")}, version ${policy.version} (${plural(policy.rules, "rule")}).` : "No policy rule governs this tenant: the default decides.",
    `${STACK_LINE}.`,
    ctx.trace ? `Trace ${t(ctx.trace.path)}.` : ctx.bundle ? `Rendered in sample mode from ${t(ctx.bundle.path)} (sha256 ${t(ctx.bundle.sha256.replace(/^sha256:/, "").slice(0, 12))}); the run's trace stays in logs/.` : "No trace is kept with this file.",
  ];
  return `<footer>\n${lines.map((l) => `<p>${l}</p>`).join("\n")}\n</footer>`;
}

// ---- the page ---------------------------------------------------------------------------------------------------

const LIGHT = "--bg:#fbfaf7;--fg:#1d1e20;--muted:#62666d;--line:#dedad2;--card:#ffffff;--soft:#f2f0eb;--need:#b3361d;--need-bg:#fbebe6;--hold:#835700;--hold-bg:#f8ecd2;--adopted:#6c7178;--ok:#2f6b45";
const DARK = "--bg:#141517;--fg:#e8e6e1;--muted:#a3a19b;--line:#33353a;--card:#1b1c1f;--soft:#222428;--need:#ff8e74;--need-bg:#3a201a;--hold:#f0c46e;--hold-bg:#382c13;--adopted:#9a9da3;--ok:#8fd1a6";

const CSS = `:root{${LIGHT}}
@media (prefers-color-scheme:dark){:root{${DARK}}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-top:64px}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:anywhere}
a{color:inherit;text-decoration-thickness:1px;text-underline-offset:2px}
a:hover{text-decoration-thickness:2px}
h2{font-size:18px;line-height:1.3;margin:0 0 10px}
h3{font-size:15px;line-height:1.35;margin:0}
p{margin:4px 0}
ul{margin:4px 0;padding-left:20px}
li{margin:2px 0}
small{font-size:.5em;color:var(--muted);font-weight:500}
.muted{color:var(--muted)}
.bar{position:sticky;top:0;z-index:10;background:var(--bg);border-bottom:1px solid var(--line);font-size:15px}
.bar-in{max-width:1100px;margin:0 auto;padding:10px 16px;display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:2px 24px}
.sum{font-size:18px;font-weight:600;line-height:1.3}
.sum a{text-decoration:none;white-space:nowrap}
.sum a:hover{text-decoration:underline}
.sum b{font-variant-numeric:tabular-nums}
.sum .need{color:var(--need)}
.who{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 12px;font-size:12.5px;color:var(--muted)}
.who h1{font-size:12.5px;font-weight:600;margin:0;color:var(--fg)}
main{max-width:1100px;margin:0 auto;padding:20px 16px 8px}
main section{margin:0 0 28px}
.first{display:grid;grid-template-columns:minmax(0,1fr);gap:0 28px}
@media (min-width:900px){.first{grid-template-columns:minmax(0,2fr) minmax(0,1fr)}}
.tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;align-content:start;margin:0 0 28px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:20px}
.tile .tl{display:block;text-decoration:none}
.tile .tl:hover .k{text-decoration:underline}
.tile .k{display:block;font-size:12.5px;line-height:1.3;color:var(--muted)}
.tile .v{display:block;font-size:28px;font-weight:650;line-height:1.15;margin:4px 0 2px;font-variant-numeric:tabular-nums}
.tile .s{margin:0;font-size:12.5px;color:var(--muted)}
.tile.has-need{border-color:var(--need)}
.tile.warn .v{color:var(--need)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin:0 0 10px;break-inside:avoid}
.card .where,.card .when{color:var(--muted)}
.links{display:flex;flex-wrap:wrap;gap:2px 16px;margin:8px 0 0;font-size:13.5px}
.tog{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px}
.tog[aria-expanded="true"]{font-weight:600}
.tk{text-decoration:underline dotted;text-underline-offset:2px;cursor:help}
.badge{display:inline-block;vertical-align:1px;font-size:11px;font-weight:700;letter-spacing:.04em;line-height:1.6;padding:0 6px;border-radius:4px;margin-right:8px}
.v-ESCALATE,.v-FIX{color:var(--need)}
.v-HOLD{color:var(--hold)}
.v-ADOPT{color:var(--adopted)}
.v-ROLLBACK{color:var(--ok)}
.badge.v-ESCALATE,.badge.v-FIX{background:var(--need-bg)}
.badge.v-HOLD{background:var(--hold-bg)}
.badge.v-ROLLBACK,.badge.v-ADOPT{background:var(--soft)}
.fold{margin:10px 0 0;padding:8px 0 0;border-top:1px solid var(--line);font-size:13.5px}
.fold .fh{font-weight:600;margin:8px 0 2px}
.fid{margin:8px 0 0;font-size:12px;color:var(--muted)}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--soft);padding:8px;border-radius:6px;margin:4px 0}
.alert{border:1px solid var(--need);border-radius:8px;padding:10px 12px;margin:0 0 10px;color:var(--need);background:var(--need-bg)}
.calm{color:var(--ok);font-weight:600}
.stories{list-style:none;padding:0;margin:0}
.stories li{margin:0 0 8px}
.story{display:inline;margin:0}
.go{font-size:13px;color:var(--muted);margin-left:4px}
details{margin:6px 0}
summary{cursor:pointer;color:var(--muted)}
ul.plain{list-style:none;padding:0}
ul.plain li{padding:3px 0;border-bottom:1px solid var(--line)}
table{border-collapse:collapse;width:100%;margin:6px 0;font-size:13.5px}
th,td{text-align:left;vertical-align:top;padding:5px 8px;border-bottom:1px solid var(--line);overflow-wrap:break-word}
td[data-label="Under"],td[data-label="Lesson"],td[data-label="Rule"]{white-space:nowrap}
th{font-size:12px;font-weight:600;color:var(--muted);background:var(--soft)}
.nw{white-space:nowrap}
.rel{font-size:12px;color:var(--muted);white-space:nowrap}
.rel.late{color:var(--need);font-weight:600}
.tag{display:inline-block;font-size:11px;padding:0 6px;border-radius:4px;background:var(--soft);color:var(--muted)}
.fail,.st-failed{color:var(--need);font-weight:600}
.pass,.st-done{color:var(--ok)}
.st-refused,.st-unverified,.st-not_judged{color:var(--muted)}
.lead{font-weight:600}
.notes{color:var(--muted);font-size:13.5px}
.deeper{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:6px 24px}
.deeper .what{display:block;font-size:13px;color:var(--muted)}
footer{max-width:1100px;margin:0 auto;padding:14px 16px 32px;border-top:1px solid var(--line);color:var(--muted);font-size:12.5px}
footer p{margin:2px 0}
@media (max-width:640px){
html{scroll-padding-top:120px}
body{font-size:16px}
.sum{font-size:17px}
.tile{padding:16px}
.links{font-size:14.5px}
table,thead,tbody,tr,td{display:block;width:100%}
thead{display:none}
tr{border:1px solid var(--line);border-radius:8px;margin:0 0 8px;padding:6px 10px;background:var(--card)}
td{border:0;padding:2px 0}
td::before{content:attr(data-label);display:block;font-size:12px;color:var(--muted)}
}
@media print{
:root{color-scheme:light;${LIGHT};--bg:#fff;--card:#fff;--soft:#f3f3f3}
html{scroll-padding-top:0}
body{font-size:10.5pt}
.bar{position:static}
main{max-width:none;padding:12px 0 0}
.first{grid-template-columns:minmax(0,2fr) minmax(0,1fr)}
.fold[hidden]{display:block}
.tog{text-decoration:none}
h2{break-after:avoid}
tr,.tile,.card{break-inside:avoid}
summary{display:none}
a{text-decoration:none}
}`;

/** Shown without the script: every fold open, no toggle. */
const NOSCRIPT = `.fold[hidden]{display:block}.tog{display:none}`;

/** The evidence toggles; for printing every fold and every collapsed list opened, and closed again afterwards. */
const SCRIPT = `document.addEventListener("click",(e)=>{const b=e.target.closest("[data-fold]");const d=b&&document.getElementById(b.dataset.fold);if(!d)return;d.hidden=!d.hidden;b.setAttribute("aria-expanded",String(!d.hidden))});addEventListener("beforeprint",()=>{for(const d of document.querySelectorAll("details:not([open]),.fold[hidden]")){if(d.tagName==="DETAILS")d.open=true;else d.hidden=false;d.dataset.printed="1"}});addEventListener("afterprint",()=>{for(const d of document.querySelectorAll("[data-printed]")){if(d.tagName==="DETAILS")d.open=false;else d.hidden=true;delete d.dataset.printed}});`;

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
<noscript><style>${NOSCRIPT}</style></noscript>
</head>
<body>
${barHtml(f)}
<main>
<div class="first">
<div class="col">
${needsHtml(f)}
${storyHtml(f)}
</div>
${tilesHtml(f)}
</div>
${heldHtml(f)}
${adoptedHtml(f)}
${actionsHtml(f)}
${coverageHtml(f)}
${deeperHtml(f)}
</main>
${footerHtml(f)}
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
