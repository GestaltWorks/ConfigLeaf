// The cause of a finding, from rows the agent holds and nothing else (no model): who or what changed the setting,
// when and how. Pure: the rows come in (audit_event of source journal and cloudflare, the action ledger, the
// approval's instant, the finding), one FindingCause row and its evidence come out. src/explain/explain.ts gathers
// the rows through the DataLayer and the vault and writes the row; a test calls explainFinding with rows of its own.
//
// Contract:
//   - Which findings: every ROLLBACK, FIX and ESCALATE, and every HOLD of class drift_vs_approved, approved_missing,
//     dns_change or found_but_different (explains). A cause never changes a disposition.
//   - The window (causeWindow): from the approved_at of the setting's current approval, or, with none, the earlier of
//     the last observation that matched (the finding's since) and 24 h before the pass; to the pass's decided_at.
//   - The subject: a linux.* finding's file (its object_id, the redacted path a journal row's resource_id carries) on
//     its host; a cloudflare.dns finding's record (its object_id), or the record a linux finding rests on (resource_id,
//     the hero classes). A found_but_different setting is byte-identical by definition, so its subject is the record
//     alone. audit_event has no host column: a journal row names its host at the end of new_value
//     (" on host-XXXXXX", src/collectors/journal.ts), a row naming another host is not the finding's, and a row
//     naming none is matched by path alone.
//   - The rows: a write is a journal row on the file whose command is a writer (WRITE_TOOLS: tee, sed, cp, mv, the
//     editors); automation is a journal row of an AUTOMATION tool (certbot, dpkg, apt, ansible, cron) on the file or
//     naming nginx while the file sits under /etc/nginx/; an event is a cloudflare row on the record. Each in the window.
//   - The ledger match (agentActionFor): a journal write within AGENT_JOURNAL_MS (15 s) of a rollback_file on the same
//     host and file, or a cloudflare row with no actor within AGENT_AUDIT_MS (90 s) of a revert_record on the record,
//     is the agent's: "within" is from that much before the action started to that much after it finished. A refused
//     action wrote nothing and matches nothing.
//   - The classes, in order, first match wins: agent (the latest write or event is the agent's); operator_edit (the
//     latest write by a user that is not the agent's; the user's nearest earlier ssh_login within LOGIN_MS (2 h)
//     gives the source address); automation (the latest automation row); account_change (the latest event with an
//     actor); token_change (the latest event with no actor that is not the agent's); unknown (none of these).
//   - The sentence (sentence): English, present tense, one line, through the redactor; the instant as HH:MM UTC, with
//     the day when it is not the pass's day. The restore clause (", 2 minutes before the agent restored it") follows
//     a person's or a tool's change once the agent's rollback or revert of the same disposition wrote (withRestore,
//     explain.ts causeSentence): the explain step runs before act, so the stored summary has none and readers add it.
//   - Evidence: the writes, automation rows and events of the window, the login named, and the agent's actions on the
//     subject in the window, oldest first, at most EVIDENCE_MAX; evidence_ids is their ids as a JSON array.
//
// Measured 25 Oct 2026: test/explain.test.ts holds each class, the 15 s and 90 s edges and every sentence shape byte
// for byte over injected rows.

import { causeId, type Action, type AuditEvent, type CauseClass, type FindingCause } from "../data/rows.ts";
import type { Finding, Verb } from "../pipeline.ts";
import type { Redactor } from "../redactor.ts";

export const CAUSE_CLASSES: readonly CauseClass[] = ["agent", "operator_edit", "automation", "account_change", "token_change", "unknown"];
/** The verbs the explainer explains every finding of. */
export const EXPLAINED_VERBS: readonly Verb[] = ["ROLLBACK", "FIX", "ESCALATE"];
/** The classes the explainer explains a HOLD of. */
export const EXPLAINED_HOLDS: readonly string[] = ["drift_vs_approved", "approved_missing", "dns_change", "found_but_different"];

export const AGENT_JOURNAL_MS = 15_000;
export const AGENT_AUDIT_MS = 90_000;
export const LOGIN_MS = 2 * 3600_000;
export const DAY_MS = 24 * 3600_000;
export const EVIDENCE_MAX = 20;
/** The actor a cause names when the agent made the change. */
export const AGENT_ACTOR = "drift-agent";

/** Commands that write the file they name. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["tee", "sed", "cp", "mv", "install", "rsync", "ln", "rm", "truncate", "dd", "patch", "vim", "vi", "nvim", "nano", "emacs", "ed", "sudoedit"]);
/** Tools that change configuration on their own, and what their run is. */
export const AUTOMATION: Readonly<Record<string, string>> = {
  certbot: "renewal", dpkg: "package upgrade", apt: "package upgrade", "apt-get": "package upgrade", "unattended-upgrade": "package upgrade",
  ansible: "playbook run", "ansible-playbook": "playbook run", cron: "scheduled job",
};

/** Does the explainer explain this finding? */
export const explains = (f: Pick<Finding, "verb"> & { finding: Pick<Finding["finding"], "class"> }): boolean =>
  EXPLAINED_VERBS.includes(f.verb) || (f.verb === "HOLD" && EXPLAINED_HOLDS.includes(f.finding.class));

const ms = (iso: string): number => Date.parse(iso);
const isoMs = (iso: string): string => new Date(iso).toISOString();

export interface CauseWindow { from: string; to: string }

/** The evidence window (see the header), both ends ISO 8601 UTC milliseconds. */
export function causeWindow(o: { approvedAt: string | null; lastMatched: string | null; to: string }): CauseWindow {
  const to = isoMs(o.to);
  if (o.approvedAt) return { from: isoMs(o.approvedAt), to };
  const dayBack = new Date(ms(to) - DAY_MS).toISOString();
  const last = o.lastMatched ? isoMs(o.lastMatched) : null;
  return { from: last !== null && last < dayBack ? last : dayBack, to };
}

/** What a finding's cause is looked for on: the file (a redacted path) and the record (an id), with the host of the file. */
export interface Subject { host: string | null; path: string | null; record: string | null }

export function subjectOf(s: Pick<Finding["finding"], "class" | "surface" | "host" | "object_id" | "resource_id">): Subject {
  // found_but_different is byte-identical on the host by definition: what moved is the record it rests on
  const linux = s.surface.startsWith("linux.") && s.class !== "found_but_different";
  return { host: s.host, path: linux ? s.object_id : null, record: s.surface === "cloudflare.dns" ? s.object_id : s.resource_id ?? null };
}

/** The tool a row's action names: its first word's basename ("systemctl reload nginx" -> systemctl). */
export const toolOf = (action: string): string => (action.trim().split(/\s+/)[0] ?? "").split("/").pop()!.toLowerCase();

const inWindow = (e: Pick<AuditEvent, "occurred_at">, w: CauseWindow): boolean => e.occurred_at >= w.from && e.occurred_at <= w.to;

/** The host a journal row came from: the " on <host>" its new_value ends with; null when it names none. */
export const journalHostOf = (e: Pick<AuditEvent, "source" | "new_value">): string | null =>
  e.source === "journal" && e.new_value ? e.new_value.match(/ on (host-[0-9a-f]+)$/)?.[1] ?? null : null;

/** A journal row of this host, or of no named host. */
const onHost = (e: AuditEvent, host: string | null): boolean => {
  const h = journalHostOf(e);
  return h === null || host === null || h === host;
};

export const isWrite = (e: AuditEvent, s: Subject): boolean =>
  s.path !== null && e.source === "journal" && e.resource_id === s.path && onHost(e, s.host) && WRITE_TOOLS.has(toolOf(e.action));

export function isAutomation(e: AuditEvent, s: Subject): boolean {
  if (s.path === null || e.source !== "journal" || AUTOMATION[toolOf(e.action)] === undefined || !onHost(e, s.host)) return false;
  return e.resource_id === s.path || (s.path.startsWith("/etc/nginx/") && /nginx/i.test(`${e.action} ${e.new_value ?? ""} ${e.resource_id ?? ""}`));
}

export const isEvent = (e: AuditEvent, s: Subject): boolean => s.record !== null && e.source === "cloudflare" && e.resource_id === s.record;

/** The agent's action a row is, by the ledger match (see the header), or null. */
export function agentActionFor(e: AuditEvent, actions: readonly Action[], s: Subject): Action | null {
  let kind: Action["kind"];
  let prefix: string;
  let slack: number;
  if (e.source === "journal" && s.path !== null && s.host !== null) {
    [kind, prefix, slack] = ["rollback_file", `linux.nginx ${s.host} ${s.path} `, AGENT_JOURNAL_MS];
  } else if (e.source === "cloudflare" && e.actor === null && s.record !== null) {
    [kind, prefix, slack] = ["revert_record", `cloudflare.dns ${s.record} `, AGENT_AUDIT_MS];
  } else return null;
  const t = ms(e.occurred_at);
  return actions.find((a) => a.kind === kind && a.status !== "refused" && a.target.startsWith(prefix)
    && t >= ms(a.started_at) - slack && t <= ms(a.finished_at ?? a.started_at) + slack) ?? null;
}

/** The user's nearest ssh_login to the host at or before `at`, no more than LOGIN_MS before it, or null. */
export function loginBefore(events: readonly AuditEvent[], actor: string | null, at: string, host: string | null = null): AuditEvent | null {
  if (actor === null) return null;
  const t = ms(at);
  let best: AuditEvent | null = null;
  for (const e of events) {
    if (e.source !== "journal" || e.action !== "ssh_login" || e.actor !== actor || !onHost(e, host)) continue;
    const u = ms(e.occurred_at);
    if (u > t || t - u > LOGIN_MS) continue;
    if (!best || e.occurred_at > best.occurred_at || (e.occurred_at === best.occurred_at && e.event_id > best.event_id)) best = e;
  }
  return best;
}

/** One row of a cause's timeline: an audit_event row or an action of the ledger. */
export interface Evidence {
  id: string;
  at: string;
  source: "journal" | "cloudflare" | "ledger";
  actor: string | null;
  action: string;
  resource: string | null;
}

/** The object an action's target names: "<surface> [<host>] <object> <setting>" -> the object. */
export function actionObject(target: string): string {
  const w = target.split(" ");
  return w[0] === "cloudflare.dns" ? w[1] ?? target : w[2] ?? target;
}

export function evidenceOfEvent(e: AuditEvent): Evidence {
  const resource = e.resource_id ?? (e.action === "ssh_login" && e.old_value ? `from ${e.old_value}` : null);
  return { id: e.event_id, at: e.occurred_at, source: e.source === "cloudflare" ? "cloudflare" : "journal", actor: e.actor, action: e.action, resource };
}

export function evidenceOfAction(a: Action): Evidence {
  return { id: a.action_id, at: a.started_at, source: "ledger", actor: AGENT_ACTOR, action: `${a.kind} ${a.status}`, resource: actionObject(a.target) };
}

/** One timeline line: "2026-10-25 15:52:07 UTC · journal · user-3f2a1c · tee · /etc/nginx/conf.d/x.conf". */
export const timelineLine = (e: Evidence): string =>
  [`${e.at.slice(0, 19).replace("T", " ")} UTC`, e.source, e.actor ?? "-", e.action, e.resource ?? "-"].join(" · ");

// ---- the sentence ---------------------------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** "at 15:52 UTC", and " on 24 Oct" after it when the instant is not on the day of `today`. */
export function at(iso: string, today: string): string {
  const d = new Date(iso);
  const day = iso.slice(0, 10) === today.slice(0, 10) ? "" : ` on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return `at ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC${day}`;
}

/** A window's length: "24 h", or minutes under an hour. */
export function span(w: CauseWindow): string {
  const d = Math.max(0, ms(w.to) - ms(w.from));
  return d >= 3600_000 ? `${Math.round(d / 3600_000)} h` : `${Math.max(1, Math.round(d / 60_000))} min`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The facts a cause's sentence is built from. */
export interface SentenceFacts {
  class: CauseClass;
  /** What changed: the file or the record. */
  noun: "file" | "record";
  occurredAt: string | null;
  actor: string | null;
  /** The command for operator_edit (tee), the tool for automation (certbot), the action kind for agent. */
  tool: string | null;
  /** The ssh login's source address for operator_edit. */
  from: string | null;
  /** account_change: the value before and after, as the redactor leaves them. */
  values?: { from: string | null; to: string | null };
  /** The record's event was a delete. */
  deleted?: boolean;
  window: CauseWindow;
  /** unknown: what the window holds, and which of the two the finding has. */
  counts?: { writes: number; events: number; file: boolean; record: boolean };
}

/** The cause's sentence (see the header), the day named against the window's end; not yet through the redactor. */
export function sentence(f: SentenceFacts): string {
  const when = f.occurredAt ? at(f.occurredAt, f.window.to) : "";
  switch (f.class) {
    case "operator_edit":
      return `The file was changed ${when} by ${f.actor}${f.from ? ` over ssh from ${f.from}` : ""} (sudo ${f.tool}).`;
    case "agent":
      return `The last change to the ${f.noun} is the agent's own ${f.tool === "revert_record" ? "revert" : "rollback"} ${when}.`;
    case "automation":
      return `The ${f.noun} was changed ${when} by ${f.tool} (${AUTOMATION[f.tool ?? ""] ?? "automation"}).`;
    case "account_change": {
      const v = f.values;
      const values = f.deleted || !v?.to ? "" : v.from ? `, from ${v.from} to ${v.to}` : `, to ${v.to}`;
      return `The record was ${f.deleted ? "deleted" : "changed"} ${when} by a named account (${f.actor})${values}.`;
    }
    case "token_change":
      return `The record was ${f.deleted ? "deleted" : "changed"} ${when} through an API token.`;
    case "unknown": {
      const c = f.counts ?? { writes: 0, events: 0, file: true, record: false };
      const w = span(f.window);
      const file = `the journal window of ${w} holds ${plural(c.writes, "write")} to the file`;
      if (c.file && c.record) return `No record of who changed it: ${file} and the audit log holds ${plural(c.events, "event")} for the record.`;
      if (c.record) return `No record of who changed it: the audit log window of ${w} holds ${plural(c.events, "event")} for the record.`;
      return `No record of who changed it: ${file}.`;
    }
  }
}

/** The classes a restore clause follows: a person's or a tool's change. */
const RESTORED: ReadonlySet<CauseClass> = new Set(["operator_edit", "automation", "account_change", "token_change"]);

/** ", 2 minutes before the agent restored it": the time from the change to the restore, "under a minute", whole minutes under two hours, then hours. */
export function restoreClause(occurredAt: string, restoredAt: string): string {
  const d = ms(restoredAt) - ms(occurredAt);
  const m = Math.round(d / 60_000);
  const lead = d < 60_000 ? "under a minute" : m < 120 ? plural(m, "minute") : plural(Math.round(m / 60), "hour");
  return `, ${lead} before the agent restored it`;
}

/** The action that restored the disposition's setting after the change: a rollback_file or revert_record that wrote (done or unverified), the earliest. */
export function restoringAction<A extends Pick<Action, "disposition_id" | "kind" | "status" | "started_at">>(c: Pick<FindingCause, "disposition_id" | "occurred_at">, actions: readonly A[]): A | null {
  if (!c.occurred_at) return null;
  const xs = actions.filter((a) => a.disposition_id === c.disposition_id && (a.kind === "rollback_file" || a.kind === "revert_record")
    && (a.status === "done" || a.status === "unverified") && a.started_at >= c.occurred_at!);
  return xs.sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0))[0] ?? null;
}

/**
 * The stored summary with the restore clause when the agent restored the setting (restoringAction); the summary as
 * stored otherwise, and for the agent's own change and an unknown one.
 */
export function withRestore(c: Pick<FindingCause, "class" | "summary" | "disposition_id" | "occurred_at">, actions: readonly Pick<Action, "disposition_id" | "kind" | "status" | "started_at">[] = []): string {
  const a = RESTORED.has(c.class) ? restoringAction(c, actions) : null;
  if (!a || !c.occurred_at || !c.summary.endsWith(".")) return c.summary;
  return `${c.summary.slice(0, -1)}${restoreClause(c.occurred_at, a.started_at)}.`;
}

// ---- the classifier -------------------------------------------------------------------------------------------

export interface CauseInput {
  tenantId: string;
  finding: Pick<Finding, "id" | "verb"> & { finding: Pick<Finding["finding"], "class" | "surface" | "host" | "object_id" | "setting_path" | "resource_id"> };
  dispositionId: string;
  /** The pass's decided_at: the window's end and the row's decided_at. */
  decidedAt: string;
  /** approved_at of the setting's current approval; null when it has none. */
  approvedAt: string | null;
  /** The last observation that matched: the finding's since. */
  lastMatched: string | null;
  /** The tenant's audit_event rows (any source, any time: the window is applied here). */
  events: readonly AuditEvent[];
  /** The tenant's action rows. */
  actions: readonly Action[];
  /** The diff, redacted, or null. */
  diff: string | null;
  /** The record's value before and after, as the redactor leaves them (account_change). */
  values?: { from: string | null; to: string | null };
  redactor: Redactor;
}

export interface Cause {
  row: FindingCause;
  evidence: Evidence[];
  subject: Subject;
  /** What the window held: journal and cloudflare rows of the tenant, writes to the file, events for the record. */
  searched: { journal: number; cloudflare: number; writes: number; events: number };
}

const byTime = <T extends { occurred_at: string; event_id: string }>(a: T, b: T): number =>
  a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;

/** The cause of one finding from the rows given (see the header). */
export function explainFinding(i: CauseInput): Cause {
  const s = subjectOf(i.finding.finding);
  const window = causeWindow({ approvedAt: i.approvedAt, lastMatched: i.lastMatched, to: i.decidedAt });
  const inW = i.events.filter((e) => inWindow(e, window));
  const writes = inW.filter((e) => isWrite(e, s)).sort(byTime);
  const automation = inW.filter((e) => isAutomation(e, s)).sort(byTime);
  const events = inW.filter((e) => isEvent(e, s)).sort(byTime);
  const agentOf = (e: AuditEvent): Action | null => agentActionFor(e, i.actions, s);

  type Pick_ = { class: CauseClass; event: AuditEvent | null; action: Action | null; login: AuditEvent | null };
  const choose = (): Pick_ => {
    const last = [...writes, ...events].sort(byTime).at(-1);
    const own = last ? agentOf(last) : null;
    if (last && own) return { class: "agent", event: last, action: own, login: null };
    const write = writes.filter((e) => !agentOf(e)).at(-1);
    if (write) return { class: "operator_edit", event: write, action: null, login: loginBefore(i.events, write.actor, write.occurred_at, s.host) };
    const auto = automation.at(-1);
    if (auto) return { class: "automation", event: auto, action: null, login: null };
    const named = events.filter((e) => e.actor !== null).at(-1);
    if (named) return { class: "account_change", event: named, action: null, login: null };
    const token = events.filter((e) => e.actor === null && !agentOf(e)).at(-1);
    if (token) return { class: "token_change", event: token, action: null, login: null };
    return { class: "unknown", event: null, action: null, login: null };
  };
  const c = choose();
  const e = c.event;

  const noun: "file" | "record" = e ? (e.source === "cloudflare" ? "record" : "file") : s.path !== null ? "file" : "record";
  const tool = c.class === "agent" ? c.action!.kind : e ? toolOf(e.action) : null;
  const actor = c.class === "agent" ? AGENT_ACTOR : c.class === "operator_edit" || c.class === "account_change" ? e!.actor : c.class === "automation" ? tool : null;
  const mechanism = c.class === "operator_edit" ? `sudo ${tool}` : c.class === "automation" ? AUTOMATION[tool!] : c.class === "account_change" ? "dashboard or API"
    : c.class === "token_change" ? "API token" : c.class === "agent" ? c.action!.kind : null;
  const source = c.login?.old_value ?? null;
  const text = sentence({
    class: c.class, noun, occurredAt: e?.occurred_at ?? null, actor, tool, from: source, values: i.values, deleted: e?.source === "cloudflare" && e.action === "delete", window,
    counts: { writes: writes.length, events: events.length, file: s.path !== null, record: s.record !== null },
  });

  // evidence: what bears on the subject in the window, the login named and the agent's actions on it
  const onSubject = (a: Action): boolean => a.kind !== "investigate" && a.started_at >= window.from && a.started_at <= window.to
    && ((s.path !== null && s.host !== null && a.target.startsWith(`linux.nginx ${s.host} ${s.path} `)) || (s.record !== null && a.target.startsWith(`cloudflare.dns ${s.record} `)));
  const required: Evidence[] = [
    ...(e ? [evidenceOfEvent(e)] : []), ...(c.login ? [evidenceOfEvent(c.login)] : []), ...(c.action ? [evidenceOfAction(c.action)] : []),
  ];
  const seen = new Set(required.map((x) => x.id));
  const rest: Evidence[] = [];
  for (const x of [...writes, ...automation, ...events].map(evidenceOfEvent).concat(i.actions.filter(onSubject).map(evidenceOfAction))) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    rest.push(x);
  }
  const order = (a: Evidence, b: Evidence): number => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  rest.sort(order);
  const evidence = [...required, ...rest.slice(Math.max(0, rest.length - Math.max(0, EVIDENCE_MAX - required.length)))].sort(order);

  const red = (v: string | null): string | null => (v === null ? null : i.redactor.text(v));
  const row: FindingCause = {
    cause_id: causeId(i.tenantId, i.dispositionId), tenant_id: i.tenantId, finding_id: i.finding.id, disposition_id: i.dispositionId, class: c.class,
    actor: red(actor), mechanism: red(mechanism), occurred_at: e ? isoMs(e.occurred_at) : null, source_host: red(source),
    evidence_ids: JSON.stringify(evidence.map((x) => x.id)), diff: i.diff, summary: i.redactor.text(text),
    window_from: window.from, window_to: window.to, decided_at: window.to,
  };
  return { row, evidence, subject: s, searched: { journal: inW.filter((x) => x.source === "journal").length, cloudflare: inW.filter((x) => x.source === "cloudflare").length, writes: writes.length, events: events.length } };
}
