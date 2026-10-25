// The words of a ticket: its title, its body and the comments that follow it, rendered from the pass's finding,
// the ledger's disposition, the actions that carried it out and the probes of the names its object serves.
//
// Contract: plain text in six sections, each a heading and one line per fact: What (the finding's summary and
// where it stands), Evidence (each check with its template, holds or fails and its row count; each check that
// could not run with its reason; the exposure line; each probe of the object's names with its probe id; each line
// of each action's record, under the action's id), Decision (verb, who decided, the rule and its terms, the reason,
// the expiry), Work done (each action: kind, status, hashes before and after, vault commit, verification probe ids,
// then the Actor's sentence for it), Receipts (the model receipts of those actions) and Ledger (disposition,
// finding, run and ticket ids). A disposition the explain step explained (src/explain/) adds a seventh, Why, right
// after Evidence: who or what changed the setting in one sentence (the stored summary, with ", N minutes before the
// agent restored it" once the disposition's rollback_file or revert_record wrote), then its timeline, one line per
// evidence row ("<time> UTC · <source> · <actor> · <action> · <resource>", src/explain/cause.ts timelineLine), then
// the diff in a fenced block when the cause holds one. A comment on a new action carries its Work done, its record as
// Evidence, its Why and its Receipts; a comment on a new verb its Decision and its Why; on an unverified write, it
// first states that the write completed and the verification it lacks (unverifiedComment, the same lines, follows the
// create of a change ticket). Hashes are 12 hex, commits 8. Every string here is
// redacted text from the ledger and the pass; outgoing() in src/psa/index.ts runs the redactor and the deny-list
// probe over the result before it leaves the process. A body is cut at BODY_MAX characters with a line saying so.
// Measured 24 Oct 2026: the six sections in order on the first issue the step creates over the policy fixture
// (test/psa.test.ts), and on the proxy_split body of SAMPLE_MODE=true npm run tickets -- --tenant client-1: three
// checks hold, referent_unchanged fails with 3 rows, the exposure dates from 2026-04-16, the dns, tls and http probes
// of its name are ok. Measured 25 Oct 2026 at 19:53 UTC on the lab, npm run tickets -- --tenant lab-1 --dry-run
// through Zetaris after the rollback of 19:52 UTC: the change ticket's Why reads "The file was changed at 19:48 UTC by
// user-212a17 over ssh from 198.51.100.7 (sudo tee), 4 minutes before the agent restored it.", 16 timeline lines and
// the 11-line diff (8081 to 8097).

import type { FindingSummary } from "../catalogue/select.ts";
import type { Action, Disposition, DispositionVerb, FindingCause, PolicyRule, PsaPriority } from "../data/rows.ts";
import { timelineLine, withRestore, type Evidence } from "../explain/cause.ts";
import type { ActionView, TicketFinding, TicketType } from "./index.ts";

/** GitHub refuses a body over 65,536 characters; the step stays under it. */
export const BODY_MAX = 60_000;
export const TITLE_MAX = 256;

/** One probe row as PROBES_OF_RUN_SQL returns it, the fields a ticket names. */
export interface ProbeRow { probe_id: string; kind: string; target: string; expected: string; observed: string; status: string }

/** The probes of the names a finding's object serves, in the probe run the pass read for it; run_id null when the pass held none. */
export interface ProbeEvidence { run_id: string | null; rows: readonly ProbeRow[] }

const h12 = (h: string | null): string => (h ? h.replace(/^sha256:/, "").slice(0, 12) : "none");
const c8 = (c: string | null): string => (c ? c.slice(0, 8) : "none");

/** What a title names the object by: a record's name when the finding carries it, else the object id (redacted). */
export function objectLabel(f: Pick<FindingSummary, "surface" | "object_id" | "dns_name">): string {
  return f.surface === "cloudflare.dns" && f.dns_name ? f.dns_name : f.object_id;
}

/** "<verb> <class>: <object> on <host or zone>", at most TITLE_MAX characters. */
export function ticketTitle(verb: DispositionVerb, cls: string, object: string, where: string): string {
  return `${verb} ${cls}: ${object} on ${where}`.slice(0, TITLE_MAX);
}

function cut(text: string): string {
  return text.length <= BODY_MAX ? text : `${text.slice(0, BODY_MAX)}\n\n(body cut at ${BODY_MAX} characters)`;
}

function whatLines(f: TicketFinding): string[] {
  const s = f.finding;
  return [
    "### What",
    s.summary,
    "",
    `- finding ${f.id}: ${s.class} on ${s.surface}${s.host ? ` ${s.host}` : ""}, ${s.setting_path} in ${s.object_id}, window ${s.since} to ${s.until}`,
  ];
}

/** Each line of each action's record, under the action's id: the checks, verdicts and probes it ran. */
function recordLines(actions: readonly ActionView[]): string[] {
  return actions.flatMap((a) => a.record.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => `- action ${a.action_id} (${a.kind}): ${l}`));
}

function evidenceLines(f: TicketFinding, probes: ProbeEvidence, actions: readonly ActionView[]): string[] {
  const out = ["### Evidence"];
  for (const c of f.checks) out.push(`- check ${c.template}: ${c.holds ? "holds" : "fails"}, ${c.rowCount} row(s). ${c.explanation}`);
  for (const r of f.rejected) out.push(`- check not run: ${r.reason}`);
  if (!f.checks.length && !f.rejected.length) out.push("- checks: none ran");
  const e = f.exposure;
  out.push(e
    ? `- exposure: in this state since ${e.since}, ${e.bound === "exact" ? "" : "at least "}${e.days} day(s), still so in DNS run ${e.still_open_in}; source ${e.source}`
    : "- exposure: the pass dated none for this finding");
  if (probes.run_id === null) out.push("- probes: no probe run in this pass");
  else if (!probes.rows.length) out.push(`- probes: no probe in ${probes.run_id} targets a name the object serves`);
  else for (const p of probes.rows) out.push(`- probe ${p.probe_id} ${p.kind} ${p.target}: ${p.status}; observed ${p.observed}; expected ${p.expected}`);
  out.push(...recordLines(actions));
  return out;
}

function ruleText(rule: PolicyRule | null): string {
  return rule
    ? `rule ${rule.rule_id} (${rule.surface} ${rule.object_glob} ${rule.setting_glob} v${rule.version}: ${rule.criticality}, lock ${rule.lock}, on_drift ${rule.on_drift}, alert ${rule.alert}, ${rule.psa_priority})`
    : "no rule (the default policy)";
}

function decisionLines(d: Disposition, rule: PolicyRule | null, ticket?: { type: TicketType; priority: PsaPriority }): string[] {
  const under = d.rule_id
    ? (rule?.rule_id === d.rule_id ? ruleText(rule) : `rule ${d.rule_id}`)
    : rule ? `${ruleText(rule)}, the rule that governs the setting` : ruleText(null);
  return [
    "### Decision",
    `- ${d.verb} by ${d.decided_by}, decided ${d.decided_at}, under ${under}`,
    `- reason: ${d.reason}`,
    `- expires: ${d.expires_at ?? "none"}`,
    ...(ticket ? [`- ticket: ${ticket.type} ${ticket.priority}`] : []),
  ];
}

/** A disposition's cause as the ticket step reads it back (src/explain/explain.ts causesByDisposition, causeEvidence): the row and its timeline, oldest first. */
export interface TicketCause { cause: FindingCause; evidence: readonly Evidence[] }

/** Why: the cause's sentence, with the restore clause once one of `actions` restored the setting; the timeline; the diff, fenced. */
export function whyLines(why: TicketCause, actions: readonly ActionView[]): string[] {
  const wrote = actions.map((a) => ({ disposition_id: a.disposition_id, kind: a.kind, status: a.status as Action["status"], started_at: a.started_at }));
  const out = ["### Why", withRestore(why.cause, wrote)];
  if (why.evidence.length) out.push("", ...why.evidence.map((e) => `- ${timelineLine(e)}`));
  if (why.cause.diff) out.push("", "```diff", why.cause.diff.replace(/\n+$/, ""), "```");
  return out;
}

/** One action as one line: kind, status, times, hashes, commit, verification. */
export function actionLine(a: ActionView): string {
  return `- action ${a.action_id}: ${a.kind} ${a.status}, started ${a.started_at}, finished ${a.finished_at ?? "running"}; before ${h12(a.before_hash)}, after ${h12(a.after_hash)}; vault commit ${c8(a.vault_commit)}; verification ${a.verification.trim() || "none"}; target ${a.target}`;
}

function workLines(d: Disposition, actions: readonly ActionView[]): string[] {
  return ["### Work done", ...(actions.length ? actions.flatMap((a) => [actionLine(a), ...(a.reason.trim() ? [`  - ${a.reason.trim()}`] : [])]) : [`- no action is recorded for disposition ${d.disposition_id}`])];
}

function receiptLines(actions: readonly ActionView[]): string[] {
  const ids = [...new Set(actions.flatMap((a) => a.receipts.split(",").map((s) => s.trim()).filter(Boolean)))];
  return ["### Receipts", `- ${ids.length ? ids.join(", ") : "none"}`];
}

function ledgerLines(d: Disposition, ticketId: string): string[] {
  return ["### Ledger", `- disposition ${d.disposition_id}`, `- finding ${d.finding_id}`, `- run ${d.run_id}`, `- ticket ${ticketId}`];
}

export interface BodyParts {
  finding: TicketFinding;
  disposition: Disposition;
  rule: PolicyRule | null;
  actions: readonly ActionView[];
  probes: ProbeEvidence;
  /** The disposition's cause; absent or null when the explain step left none. */
  why?: TicketCause | null;
}

/** The body of a new ticket: the six sections, with Why after Evidence when the disposition has a cause. */
export function ticketBody(p: BodyParts & { ticketId: string; type: TicketType; priority: PsaPriority }): string {
  return cut([
    ...whatLines(p.finding), "",
    ...evidenceLines(p.finding, p.probes, p.actions), "",
    ...(p.why ? [...whyLines(p.why, p.actions), ""] : []),
    ...decisionLines(p.disposition, p.rule, { type: p.type, priority: p.priority }), "",
    ...workLines(p.disposition, p.actions), "",
    ...receiptLines(p.actions), "",
    ...ledgerLines(p.disposition, p.ticketId),
  ].join("\n"));
}

/** What an unverified write's comment states: the write completed, the verification it lacks, and what closes the ticket. */
function unverifiedLines(a: ActionView): string[] {
  return [
    `Action ${a.action_id} (${a.kind}) completed its write: after ${h12(a.after_hash)}, the approved copy at vault commit ${c8(a.vault_commit)}. It is unverified: ${a.reason.trim() || "no verification probe ran"}.`,
    "",
    "The ticket stays open until a pass whose runs cover the setting raises no finding on it, which closes it with that fact.",
  ];
}

/** The comment a change ticket takes after its create when its action is unverified: the write completed, the verification missing, the ledger. */
export function unverifiedComment(p: { disposition: Disposition; action: ActionView; ticketId: string }): string {
  return cut([...unverifiedLines(p.action), "", ...ledgerLines(p.disposition, p.ticketId)].join("\n"));
}

/** A comment on an open ticket: the new verb with its decision, the new action with its receipts (an unverified write saying so), the cause, the ledger. */
export function commentBody(p: BodyParts & { ticketId: string; previousVerb: string | null; action: ActionView | null }): string {
  const lines = [`Update from the pass decided ${p.disposition.decided_at}.`];
  const why = p.why ? ["", ...whyLines(p.why, p.actions)] : [];
  if (p.previousVerb) lines.push("", `The decision moved from ${p.previousVerb} to ${p.disposition.verb}.`, "", ...decisionLines(p.disposition, p.rule));
  if (p.action && p.action.status === "unverified") lines.push("", ...unverifiedLines(p.action));
  if (p.action) {
    const evidence = recordLines([p.action]);
    lines.push("", ...workLines(p.disposition, [p.action]), ...(evidence.length ? ["", "### Evidence", ...evidence] : []), ...why, "", ...receiptLines([p.action]));
  } else lines.push(...why);
  lines.push("", ...ledgerLines(p.disposition, p.ticketId));
  return cut(lines.join("\n"));
}

export interface CloseParts { disposition: Disposition; ticketId: string; action?: ActionView | null; runs?: readonly string[] }

/**
 * The comment a ticket closes with: a rollback done and verified, a hold adopted, or a setting the latest pass resolves;
 * resolved with an action, the unverified write whose setting the pass finds at its approved value.
 */
export function closeComment(kind: "rollback" | "adopted" | "resolved", p: CloseParts): string {
  const d = p.disposition;
  const runs = (p.runs ?? []).join(", ") || "none";
  const head = kind === "rollback"
    ? [`The rollback is done and verified by probes ${p.action?.verification ?? ""}; closing.`, "", ...workLines(d, p.action ? [p.action] : []), "", ...receiptLines(p.action ? [p.action] : [])]
    : kind === "adopted"
      ? [`The hold is adopted: ${d.reason}; closing.`]
      : p.action
        ? [`Resolved: the pass over run(s) ${runs} raises no finding on this setting, so it holds its approved value; action ${p.action.action_id} (${p.action.kind}) wrote it and ended unverified, and its write stands; its last disposition is ${d.verb} ${d.disposition_id}, decided ${d.decided_at}; closing.`, "", ...workLines(d, [p.action])]
        : [`Resolved: the pass over run(s) ${runs} raises no finding on this setting; its last disposition is ${d.verb} ${d.disposition_id}, decided ${d.decided_at}; closing.`];
  return cut([...head, "", ...ledgerLines(d, p.ticketId)].join("\n"));
}
