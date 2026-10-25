// The PSA side of the agent: the ticket adapter interface, the rules that say when a disposition or an action
// opens a ticket, and the plan that turns one pass into creates, comments and closes. One backend is present:
// GitHub Issues (src/psa/github.ts). The adapters for HaloPSA, ConnectWise and Autotask are absent; their field
// map is src/psa/mapping.json, which names per PSA the field each ticket column maps to (type, priority, status,
// summary, details, configuration item). src/psa/step.ts reads the step's inputs through the DataLayer and
// applies the plan; src/psa/body.ts renders the title, the body and the comments.
//
// Contract:
//   - One ticket per ticket row. ticket_id = stableId("tkt", tenant, finding_id, action_id or ""), the action
//     being the one the ticket is opened for: a ROLLBACK's rollback_file or revert_record, the latest action of
//     a FIX or an ESCALATE when the ledger holds one, "" otherwise. psa github, external_id the issue number,
//     url the issue url (stored redacted), type change | incident, priority the governing rule's psa_priority
//     (P3 when no rule governs the setting), status open | closed.
//   - ticketCall, per verb and the rule's alert: ESCALATE and FIX open an incident always; ROLLBACK opens a
//     change when alert is always or on_fix, once its action is recorded; HOLD opens an incident when alert is
//     always; ADOPT opens nothing.
//   - planTickets is pure. A finding's disposition is the ledger's row for its finding id and run (the latest by
//     decided_at, then the greater disposition_id); a finding the ledger lacks gets a skip line; a finding id is
//     planned once per pass. The ticket a planned one updates is the row
//     with its ticket_id, else the open row of the same tenant, finding and type, so a later action or a later
//     pass lands on the ticket the finding already has; a row holding an external_id is commented on or
//     closed in place, and a row without one gets its issue created.
//   - Closing: a change ticket closes with a comment once its action is done and verified (status done,
//     verification probe ids recorded) and stays open with the failure named when the action failed or was
//     refused. A ticket opened under HOLD closes with a comment when the finding's disposition is ADOPT, or
//     when a pass whose runs cover the setting raises no finding on it. On an open ticket, a new action or a
//     verb other than the one in force at its last update is one comment; anything else leaves it as it is.
//     A closed row stays closed.
//   - outgoing: every string bound for a PSA passes the tenant's redactor and then the deny-list probe
//     (redactor.ts countLabels over REDACT_WORDS and EXPORT_DENY_WORDS); one label and nothing is sent. The
//     error names the label's position in the list and the count, never the label.
//
// Measured 24 Oct 2026: SAMPLE_MODE=true npm run tickets -- --tenant client-1 over sample/bundle.json plans 1
// create of 27 findings (the proxy_split HOLD, an incident P1 under rule-8e75e1d767980665, alert always) and 26
// skips (the HOLDs under rules 11 and 15, alert never); the live dry run through Zetaris read 27 findings and 0
// dispositions in the app Postgres ledger and planned 27 skips, in 47 s. test/psa.test.ts holds the opening rules
// per verb and alert, the updates in place and the closing rules over a fake GitHub, and the step over the policy
// fixture through sql.js, a ROLLBACK's change opening only once its action is recorded.

import type { CheckOutcome } from "../pipeline.ts";
import type { FindingSummary, RejectedCheck } from "../catalogue/select.ts";
import type { ExposureLine } from "../engine/world.ts";
import { stableId, type Action, type Disposition, type DispositionVerb, type PolicyRule, type PsaPriority, type Ticket } from "../data/rows.ts";
import type { TicketPatch } from "../data/store.ts";
import { resolvePolicy } from "../policy/resolve.ts";
import { countLabels, type Redactor } from "../redactor.ts";
import { closeComment, commentBody, objectLabel, ticketBody, ticketTitle, type ProbeEvidence } from "./body.ts";

export type TicketType = Ticket["type"];
export type TicketStatus = "open" | "closed";

/** What a backend creates: the title, the body and the labels, each already through outgoing(). */
export interface IssueDraft { title: string; body: string; labels: readonly string[] }
export interface IssueRef { external_id: string; url: string }

/** One PSA backend: GitHub Issues today (src/psa/github.ts). */
export interface TicketAdapter {
  readonly psa: Ticket["psa"];
  create(draft: IssueDraft): Promise<IssueRef>;
  comment(externalId: string, body: string): Promise<void>;
  close(externalId: string): Promise<void>;
  status(externalId: string): Promise<TicketStatus>;
}

/** The priority a ticket gets when no rule governs its setting. */
export const DEFAULT_PRIORITY: PsaPriority = "P3";

export class PsaError extends Error {}

/**
 * One string bound for a PSA: through the redactor, then the deny-list probe. Returns the redacted text; throws
 * PsaError naming the labels' positions in `deny` and their counts, and `what` the string was.
 */
export function outgoing(redactor: Redactor, deny: readonly string[], text: string, what: string): string {
  const red = redactor.text(text);
  const hits = countLabels(red, deny);
  if (Object.keys(hits).length) {
    const where = Object.entries(hits).map(([w, n]) => `#${deny.indexOf(w) + 1} x${n}`).join(", ");
    throw new PsaError(`deny-list probe: ${Object.keys(hits).length} of ${deny.length} label(s) appear in the ${what} (${where}); nothing sent`);
  }
  return red;
}

/** A draft through outgoing(), title, body and every label. */
export function screenDraft(redactor: Redactor, deny: readonly string[], d: IssueDraft): IssueDraft {
  return {
    title: outgoing(redactor, deny, d.title, "title"),
    body: outgoing(redactor, deny, d.body, "body"),
    labels: d.labels.map((l) => outgoing(redactor, deny, l, "labels")),
  };
}

export interface TicketCall { open: boolean; type: TicketType | null; priority: PsaPriority; why: string }

/** Whether a disposition of `verb` under `rule` opens a ticket, of which type and priority, and why, in one sentence. */
export function ticketCall(verb: DispositionVerb, rule: Pick<PolicyRule, "rule_id" | "alert" | "psa_priority"> | null): TicketCall {
  const priority = rule?.psa_priority ?? DEFAULT_PRIORITY;
  const under = rule ? `rule ${rule.rule_id} alerts ${rule.alert}` : "no rule governs the setting";
  if (verb === "ESCALATE" || verb === "FIX") return { open: true, type: "incident", priority, why: `${verb} opens an incident; ${under}` };
  if (verb === "ROLLBACK") {
    return rule && (rule.alert === "always" || rule.alert === "on_fix")
      ? { open: true, type: "change", priority, why: `ROLLBACK opens a change because ${under}` }
      : { open: false, type: null, priority, why: `ROLLBACK opens a change on alert always or on_fix; ${under}` };
  }
  if (verb === "HOLD") {
    return rule?.alert === "always"
      ? { open: true, type: "incident", priority, why: `HOLD opens an incident because ${under}` }
      : { open: false, type: null, priority, why: `HOLD opens an incident on alert always; ${under}` };
  }
  return { open: false, type: null, priority, why: "ADOPT opens no ticket" };
}

/** The labels of an issue: drift-agent, its type, its priority, the finding's class and the verb it opened under. */
export function labelsOf(type: TicketType, priority: PsaPriority, cls: string, verb: DispositionVerb): string[] {
  return ["drift-agent", `type:${type}`, priority, `class:${cls}`, `verb:${verb}`];
}

/** Every label the step may use besides class:<class> and verb:<verb>, created on first use. */
export const FIXED_LABELS: readonly string[] = ["drift-agent", "type:change", "type:incident", "P1", "P2", "P3", "P4"];

export const ticketId = (tenant: string, findingId: string, actionId: string | null): string => stableId("tkt", tenant, findingId, actionId ?? "");

/** A finding as the pass reports it (src/pipeline.ts Finding), the fields a ticket reads. */
export interface TicketFinding {
  id: string;
  finding: FindingSummary;
  checks: readonly CheckOutcome[];
  rejected: readonly Pick<RejectedCheck, "reason">[];
  exposure?: ExposureLine;
}

/** An action row as TICKET_ACTIONS_SQL returns it: the action, the finding and the verb of its disposition. status is the Actor's (done, failed, refused, not_judged). */
export interface ActionView extends Omit<Action, "status"> { status: string; finding_id: string; verb: string }

export interface TicketInput {
  tenant: string;
  psa: Ticket["psa"];
  /** The step's instant, ISO 8601 UTC in the millisecond form: created_at and updated_at of what it writes. */
  now: string;
  /** The current pass's findings of the tenant, in the pass's order. */
  findings: readonly TicketFinding[];
  /** The ledger's dispositions of the tenant, every pass. */
  dispositions: readonly Disposition[];
  actions: readonly ActionView[];
  tickets: readonly Ticket[];
  rules: readonly PolicyRule[];
  /** Per finding id: the probes of the names its object serves, in the probe run the pass read for it. */
  probes: ReadonlyMap<string, ProbeEvidence>;
  /** Per finding id of a cloudflare.dns finding: the zone of its record. */
  zones: ReadonlyMap<string, string>;
  /** True when the current pass's latest runs for the disposition's setting passed the gate, so the setting's absence from the pass means it is resolved. */
  covered(d: Disposition): boolean;
  /** The current pass's latest passing run ids, named in a resolved comment. */
  passRuns: readonly string[];
}

export type TicketOp =
  | { op: "create"; ticket: Ticket; draft: IssueDraft; existing: boolean; close: string | null; reason: string }
  | { op: "comment"; ticket: Ticket; body: string; patch: TicketPatch; reason: string }
  | { op: "close"; ticket: Ticket; body: string; reason: string }
  | { op: "skip"; finding_id: string; reason: string };

const byTime = <T extends { decided_at: string; disposition_id: string }>(a: T, b: T): number =>
  a.decided_at === b.decided_at ? (a.disposition_id < b.disposition_id ? -1 : a.disposition_id > b.disposition_id ? 1 : 0) : a.decided_at < b.decided_at ? -1 : 1;

/** The latest disposition of a finding decided at or before `at`; null when there is none. */
export function verbAt(dispositions: readonly Disposition[], findingId: string, at: string): Disposition | null {
  return dispositions.filter((d) => d.finding_id === findingId && d.decided_at <= at).sort(byTime).at(-1) ?? null;
}

const ROLLBACK_KINDS: readonly string[] = ["rollback_file", "revert_record"];

/** The action a ticket is opened for: a ROLLBACK's latest rollback_file or revert_record; the latest action of a FIX or an ESCALATE; none for a HOLD. */
export function carryingAction(verb: DispositionVerb, actions: readonly ActionView[]): ActionView | null {
  if (verb === "ROLLBACK") return actions.filter((a) => ROLLBACK_KINDS.includes(a.kind)).at(-1) ?? null;
  if (verb === "FIX" || verb === "ESCALATE") return actions.at(-1) ?? null;
  return null;
}

/** Done and verified: status done with the verifying probe ids recorded. */
export const verified = (a: ActionView): boolean => a.status === "done" && a.verification.trim() !== "";

/** The plan for one pass: creates, comments, closes and skips, in the pass's finding order, then the open tickets of findings the pass no longer raises. */
export function planTickets(input: TicketInput): TicketOp[] {
  const ops: TicketOp[] = [];
  const open = (t: Ticket): boolean => t.status === "open";
  const ofFinding = (id: string): Ticket[] => input.tickets.filter((t) => t.tenant_id === input.tenant && t.finding_id === id);
  const actionsOf = (d: Disposition): ActionView[] => input.actions.filter((a) => a.disposition_id === d.disposition_id);
  const seen = new Set<string>();
  const ruleOf = (d: Disposition, f: TicketFinding): PolicyRule | null =>
    (d.rule_id ? input.rules.find((r) => r.rule_id === d.rule_id) : undefined) ?? resolvePolicy(input.rules, f.finding);

  for (const f of input.findings) {
    if (f.finding.tenant_id !== input.tenant || seen.has(f.id)) continue;
    seen.add(f.id);
    const d = input.dispositions.filter((x) => x.tenant_id === input.tenant && x.finding_id === f.id && x.run_id === f.finding.run_id).sort(byTime).at(-1);
    if (!d) {
      ops.push({ op: "skip", finding_id: f.id, reason: `finding ${f.id} has no disposition in the ledger for run ${f.finding.run_id}; the pass that raised it recorded none` });
      continue;
    }
    const rule = ruleOf(d, f);
    const call = ticketCall(d.verb, rule);
    const acts = actionsOf(d);
    const carry = carryingAction(d.verb, acts);
    const id = ticketId(input.tenant, f.id, carry?.action_id ?? null);
    const tickets = ofFinding(f.id);
    const byId = tickets.find((t) => t.ticket_id === id);
    const current = byId && open(byId)
      ? byId
      : tickets.filter((t) => open(t) && (call.type === null || t.type === call.type)).sort((a, b) => (a.created_at < b.created_at ? -1 : 1)).at(-1);
    const probes = input.probes.get(f.id) ?? { run_id: null, rows: [] };
    const where = f.finding.host ?? input.zones.get(f.id) ?? "the account";
    const parts = { finding: f, disposition: d, rule, actions: acts, probes };

    if (!current) {
      if (byId) {
        ops.push({ op: "skip", finding_id: f.id, reason: `ticket ${byId.ticket_id} for finding ${f.id} is closed; it stays closed (${call.why})` });
        continue;
      }
      if (!call.open || !call.type) {
        ops.push({ op: "skip", finding_id: f.id, reason: `${d.verb} ${f.finding.class}: ${call.why}` });
        continue;
      }
      if (d.verb === "ROLLBACK" && !carry) {
        ops.push({ op: "skip", finding_id: f.id, reason: `ROLLBACK ${f.finding.class}: the change ticket opens once the Actor records its rollback; the ledger holds no action for ${d.disposition_id}` });
        continue;
      }
      const ticket: Ticket = {
        ticket_id: id, tenant_id: input.tenant, psa: input.psa, external_id: null, url: null, type: call.type, priority: call.priority, status: "open",
        action_id: carry?.action_id ?? null, finding_id: f.id, created_at: input.now, updated_at: input.now,
      };
      const draft: IssueDraft = {
        title: ticketTitle(d.verb, f.finding.class, objectLabel(f.finding), where),
        body: ticketBody({ ...parts, ticketId: id, type: call.type, priority: call.priority }),
        labels: labelsOf(call.type, call.priority, f.finding.class, d.verb),
      };
      const closing = call.type === "change" && carry && verified(carry) ? closeComment("rollback", { disposition: d, action: carry, ticketId: id }) : null;
      ops.push({ op: "create", ticket, draft, existing: false, close: closing, reason: call.why });
      continue;
    }

    // An open ticket the finding already has: its issue first when the row has none, then a close, a comment or nothing.
    if (current.external_id === null) {
      const type = current.type;
      ops.push({
        op: "create", ticket: current, existing: true, close: null, reason: `ticket ${current.ticket_id} is recorded with no issue; its issue is created`,
        draft: {
          title: ticketTitle(d.verb, f.finding.class, objectLabel(f.finding), where),
          body: ticketBody({ ...parts, ticketId: current.ticket_id, type, priority: current.priority }),
          labels: labelsOf(type, current.priority, f.finding.class, d.verb),
        },
      });
      continue;
    }
    const openedUnder = verbAt(input.dispositions, f.id, current.created_at)?.verb ?? null;
    const lastVerb = verbAt(input.dispositions, f.id, current.updated_at)?.verb ?? null;
    if (current.type === "change" && carry && verified(carry)) {
      ops.push({ op: "close", ticket: current, body: closeComment("rollback", { disposition: d, action: carry, ticketId: current.ticket_id }), reason: `action ${carry.action_id} is done and verified` });
      continue;
    }
    if (openedUnder === "HOLD" && d.verb === "ADOPT") {
      ops.push({ op: "close", ticket: current, body: closeComment("adopted", { disposition: d, ticketId: current.ticket_id }), reason: `the hold is adopted by ${d.disposition_id}` });
      continue;
    }
    const newAction = carry !== null && carry.action_id !== current.action_id;
    const newVerb = lastVerb !== null && lastVerb !== d.verb;
    if (newAction || newVerb) {
      ops.push({
        op: "comment", ticket: current,
        body: commentBody({ ...parts, ticketId: current.ticket_id, previousVerb: newVerb ? lastVerb : null, action: newAction ? carry : null }),
        patch: { ...(newAction ? { action_id: carry!.action_id } : {}), updated_at: input.now },
        reason: [newAction ? `new action ${carry!.action_id}` : "", newVerb ? `verb ${lastVerb} to ${d.verb}` : ""].filter(Boolean).join(", "),
      });
      continue;
    }
    ops.push({ op: "skip", finding_id: f.id, reason: `ticket ${current.ticket_id} (#${current.external_id}) is current: ${d.verb}, no new action` });
  }

  // Open tickets of findings the current pass no longer raises: a ticket opened under HOLD closes when the pass covers the setting.
  for (const t of [...input.tickets].filter((x) => x.tenant_id === input.tenant && open(x) && !seen.has(x.finding_id)).sort((a, b) => (a.ticket_id < b.ticket_id ? -1 : 1))) {
    const last = input.dispositions.filter((d) => d.finding_id === t.finding_id).sort(byTime).at(-1);
    const openedUnder = verbAt(input.dispositions, t.finding_id, t.created_at)?.verb ?? null;
    if (!last) {
      ops.push({ op: "skip", finding_id: t.finding_id, reason: `ticket ${t.ticket_id}: the ledger holds no disposition for finding ${t.finding_id}` });
    } else if (openedUnder !== "HOLD") {
      ops.push({ op: "skip", finding_id: t.finding_id, reason: `ticket ${t.ticket_id}: finding ${t.finding_id} is absent from this pass; the ticket, opened under ${openedUnder ?? "an earlier pass"}, stays with the technician` });
    } else if (!t.external_id) {
      ops.push({ op: "skip", finding_id: t.finding_id, reason: `ticket ${t.ticket_id}: finding ${t.finding_id} is absent from this pass and the ticket has no issue to close` });
    } else if (!input.covered(last)) {
      ops.push({ op: "skip", finding_id: t.finding_id, reason: `ticket ${t.ticket_id}: finding ${t.finding_id} is absent from this pass, whose runs for its setting failed the gate; the ticket stays open` });
    } else {
      ops.push({ op: "close", ticket: t, body: closeComment("resolved", { disposition: last, runs: input.passRuns, ticketId: t.ticket_id }), reason: `finding ${t.finding_id} is resolved in the pass over ${input.passRuns.join(", ")}` });
    }
  }
  return ops;
}

/** One plan line, redacted by the caller: what would be or was done. */
export function opLine(op: TicketOp): string {
  if (op.op === "skip") return `skip ${op.finding_id}: ${op.reason}`;
  const t = op.ticket;
  const ref = t.external_id ? `#${t.external_id}` : "new issue";
  if (op.op === "create") return `create ${t.type} ${t.priority} ${t.ticket_id} (${op.existing ? "recorded row" : "new row"}) for ${t.finding_id}: ${op.draft.title}${op.close ? "; then close with a comment" : ""} (${op.reason})`;
  if (op.op === "comment") return `comment ${t.ticket_id} ${ref} for ${t.finding_id}: ${op.reason}`;
  return `close ${t.ticket_id} ${ref} for ${t.finding_id}: ${op.reason}`;
}
