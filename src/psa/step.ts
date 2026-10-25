// The ticket step of a cycle, as functions: readTicketInput reads what planTickets (src/psa/index.ts) needs through
// the DataLayer, applyTickets carries the plan out through a TicketAdapter and the ticket rows, ticketStep does
// both. scripts/tickets.ts and the cycle call ticketStep with the pass they ran; a test drives it with sql.js, a
// fake fetch and MemoryTicketRows.
//
// Contract:
//   - Reads, through the DataLayer and nothing else: the runs (RUNS_SQL), the policy (POLICY_RULES_SQL, rows the
//     schema refuses left out), the ledger (DISPOSITIONS_SQL), the tenant's actions (TICKET_ACTIONS_SQL) and
//     tickets (TICKETS_SQL), per finding the probes of the names its object serves in the passing probe run
//     nearest its run within PASS_WINDOW_MS (PROBES_OF_RUN_SQL; the names are a record's own, or an nginx object's
//     server_name rows in OBSERVATIONS_SQL, the pass's rule), and the zone of each record finding
//     (TICKET_ZONES_SQL). A read the row limit cuts throws; nothing is planned from part of a table.
//   - A setting is covered when the tenant's latest DNS run and, for a setting on a host, the host's latest nginx
//     run passed the pass's gate: only then does a pass without the finding resolve it.
//   - applyTickets, dry run: one "would" line per operation, a create's title, labels and body indented below
//     it; no request and no row. Otherwise, per operation: the strings through outgoing() first (a refusal
//     writes no row and sends nothing), then for a create the row (status open, no external_id), the issue,
//     and the row's external_id and redacted url; for a comment or a close the issue's status in the PSA first
//     (closed there: the row is marked closed and nothing is sent), then the comment, the close and the row.
//     One failing operation is recorded and the rest go on.
//   - One trace line per operation and one summary line, agent psa; the token never reaches either.
//
// Measured 24 Oct 2026: npm run tickets -- --tenant client-1 --dry-run read everything through Zetaris, the pass
// re-run included, in 47 s; over the policy fixture through sql.js three steps (open, act, re-run) read, plan and
// apply in under 0.4 s (test/psa.test.ts).

import type { DataLayer, RunOptions } from "../data/layer.ts";
import {
  DISPOSITIONS_SQL, listRuns, objects, observationsOf, policyRules, probesOfRun, tenantTickets, ticketActions, ticketZones,
} from "../data/queries.ts";
import type { QueryResult } from "../adapters/zetaris.ts";
import type { Disposition, DispositionVerb, PolicyRule, Ticket } from "../data/rows.ts";
import type { Store, TicketPatch } from "../data/store.ts";
import { PASS_WINDOW_MS, type PassResult } from "../pipeline.ts";
import { PolicyRuleRow } from "../policy/schema.ts";
import type { Redactor } from "../redactor.ts";
import type { Tracer } from "../trace.ts";
import type { ProbeEvidence, ProbeRow } from "./body.ts";
import {
  PsaError, opLine, outgoing, planTickets, screenDraft,
  type ActionView, type TicketAdapter, type TicketFinding, type TicketInput, type TicketOp,
} from "./index.ts";

/** Rows per read; a table past it refuses the step. */
export const READ_LIMIT = 100_000;

type Row = Record<string, string>;
const nul = (s: string | undefined): string | null => (s === undefined || s === "" ? null : s);

/** Where the step writes ticket rows: the Store live, MemoryTicketRows in tests and dry runs. */
export interface TicketRows {
  insert(rows: readonly Ticket[]): Promise<number>;
  update(ticketId: string, patch: TicketPatch): Promise<number>;
}

export function storeTicketRows(store: Pick<Store, "insertTickets" | "updateTicket">): TicketRows {
  return { insert: (rows) => store.insertTickets(rows), update: (id, patch) => store.updateTicket(id, patch) };
}

/** Ticket rows held in memory, idempotent on ticket_id as the Store is. */
export class MemoryTicketRows implements TicketRows {
  readonly rows: Ticket[];
  constructor(initial: readonly Ticket[] = []) { this.rows = initial.map((t) => ({ ...t })); }
  async insert(rows: readonly Ticket[]): Promise<number> {
    let n = 0;
    for (const r of rows) if (!this.rows.some((t) => t.ticket_id === r.ticket_id)) { this.rows.push({ ...r }); n++; }
    return n;
  }
  async update(ticketId: string, patch: TicketPatch): Promise<number> {
    const t = this.rows.find((x) => x.ticket_id === ticketId);
    if (!t) return 0;
    Object.assign(t, patch);
    return 1;
  }
}

async function readAll(p: Promise<QueryResult>, what: string): Promise<Row[]> {
  const r = await p;
  if (r.total > r.rowCount) throw new PsaError(`${what}: the read returned ${r.rowCount} of ${r.total} rows; the ticket step plans from whole tables only`);
  return objects(r);
}

const disposition = (r: Row): Disposition => ({
  disposition_id: r.disposition_id, tenant_id: r.tenant_id, surface: r.surface, host: nul(r.host), object_id: r.object_id, setting_path: r.setting_path,
  value_hash: r.value_hash, verb: r.verb as DispositionVerb, reason: r.reason, expires_at: nul(r.expires_at), decided_by: r.decided_by as Disposition["decided_by"],
  rule_id: nul(r.rule_id), finding_id: r.finding_id, run_id: r.run_id, decided_at: r.decided_at,
});

const action = (r: Row): ActionView => ({
  action_id: r.action_id, tenant_id: r.tenant_id, kind: r.kind as ActionView["kind"], target: r.target, before_hash: nul(r.before_hash), after_hash: nul(r.after_hash),
  vault_commit: nul(r.vault_commit), verification: r.verification, receipts: r.receipts, status: r.status, reason: r.reason, record: r.record,
  started_at: r.started_at, finished_at: nul(r.finished_at), disposition_id: r.disposition_id, finding_id: r.finding_id, verb: r.verb,
});

const ticket = (r: Row): Ticket => ({
  ticket_id: r.ticket_id, tenant_id: r.tenant_id, psa: r.psa as Ticket["psa"], external_id: nul(r.external_id), url: nul(r.url), type: r.type as Ticket["type"],
  priority: r.priority as Ticket["priority"], status: r.status, action_id: nul(r.action_id), finding_id: r.finding_id, created_at: r.created_at, updated_at: r.updated_at,
});

function rule(r: Row): PolicyRule | null {
  const p = PolicyRuleRow.safeParse({
    rule_id: r.rule_id, tenant_id: r.tenant_id, surface: r.surface, object_glob: r.object_glob, setting_glob: r.setting_glob, criticality: r.criticality,
    lock: Number(r.lock), on_drift: r.on_drift, on_no_copy: r.on_no_copy, hold_max_hours: Number(r.hold_max_hours), alert: r.alert, psa_priority: r.psa_priority,
    version: Number(r.version), author: r.author, since: r.since, note: nul(r.note),
  });
  return p.success ? (p.data as PolicyRule) : null;
}

export interface ReadOptions { tenant: string; psa: Ticket["psa"]; now: string; tracer?: Tracer }

/** Everything planTickets reads, for one tenant and the pass that just ran. */
export async function readTicketInput(layer: DataLayer, pass: Pick<PassResult, "findings" | "gatedOut">, opts: ReadOptions): Promise<TicketInput> {
  const { tenant } = opts;
  const run: RunOptions = { tracer: opts.tracer, agent: "psa", limit: READ_LIMIT };
  const runs = (await readAll(listRuns(layer, run), "collection_run")).filter((r) => r.tenant_id === tenant);
  const gated = new Set(pass.gatedOut);
  const latest = new Map<string, Row>();
  for (const r of runs) latest.set(`${r.surface}|${r.host}`, r);
  const passing = (key: string): boolean => { const r = latest.get(key); return r !== undefined && !gated.has(r.run_id); };

  const rules = (await readAll(policyRules(layer, tenant, run), "policy_rule")).map(rule).filter((r): r is PolicyRule => r !== null);
  const dispositions = (await readAll(layer.run(DISPOSITIONS_SQL, {}, run), "disposition")).filter((r) => r.tenant_id === tenant).map(disposition);
  const actions = (await readAll(ticketActions(layer, tenant, run), "action")).map(action);
  const tickets = (await readAll(tenantTickets(layer, tenant, run), "ticket")).map(ticket);
  const findings: TicketFinding[] = pass.findings.filter((f) => f.finding.tenant_id === tenant);

  // the probes of the names each finding's object serves, in the passing probe run nearest its run (the pass's rule)
  const probeRuns = runs.filter((r) => r.surface === "probe" && !gated.has(r.run_id));
  const probeRows = new Map<string, ProbeRow[]>();
  const obsRows = new Map<string, Row[]>();
  const zoneRows = new Map<string, Map<string, string>>();
  const probes = new Map<string, ProbeEvidence>();
  const zones = new Map<string, string>();
  for (const f of findings) {
    const own = runs.find((r) => r.run_id === f.finding.run_id);
    const t = own ? Date.parse(own.started_at) : NaN;
    const near = own ? probeRuns.map((r) => ({ r, gap: Math.abs(Date.parse(r.started_at) - t) })).filter((x) => x.gap <= PASS_WINDOW_MS).sort((a, b) => a.gap - b.gap)[0]?.r : undefined;
    if (!near) probes.set(f.id, { run_id: null, rows: [] });
    else {
      if (!probeRows.has(near.run_id)) {
        probeRows.set(near.run_id, (await readAll(probesOfRun(layer, { tenant_id: tenant, run_id: near.run_id }, run), "probe")).map((p) => ({
          probe_id: p.probe_id, kind: p.kind, target: p.target, expected: p.expected, observed: p.observed, status: p.status,
        })));
      }
      let names: string[];
      if (f.finding.surface === "cloudflare.dns") names = f.finding.dns_name ? [f.finding.dns_name] : [];
      else {
        if (!obsRows.has(f.finding.run_id)) obsRows.set(f.finding.run_id, await readAll(observationsOf(layer, f.finding.run_id, run), "observation"));
        names = obsRows.get(f.finding.run_id)!.filter((o) => o.object_id === f.finding.object_id && o.refers_to_type === "dns_name" && o.setting_path.includes(".server_name[")).map((o) => o.refers_to_id);
      }
      const served = new Set(names);
      probes.set(f.id, { run_id: near.run_id, rows: probeRows.get(near.run_id)!.filter((p) => served.has(p.target)) });
    }
    if (f.finding.surface === "cloudflare.dns") {
      const dnsRun = f.finding.run_id;
      if (!zoneRows.has(dnsRun)) zoneRows.set(dnsRun, new Map((await readAll(ticketZones(layer, { tenant_id: tenant, dns_run_id: dnsRun }, run), "dns_record")).map((z) => [z.record_id, z.zone])));
      const zone = zoneRows.get(dnsRun)!.get(f.finding.resource_id ?? f.finding.object_id);
      if (zone) zones.set(f.id, zone);
    }
  }

  const passRuns = [...latest.values()].filter((r) => !gated.has(r.run_id)).map((r) => r.run_id).sort();
  return {
    tenant, psa: opts.psa, now: opts.now, findings, dispositions, actions, tickets, rules, probes, zones, passRuns,
    covered: (d) => passing("cloudflare.dns|") && (d.host === null || passing(`linux.nginx|${d.host}`)),
  };
}

export type OutcomeStatus = "planned" | "created" | "commented" | "closed" | "synced" | "skipped" | "refused" | "failed";
export interface TicketOutcome { op: TicketOp["op"]; ticket_id: string | null; external_id: string | null; status: OutcomeStatus; line: string }

export interface ApplyOptions {
  dryRun: boolean;
  redactor: Redactor;
  deny: readonly string[];
  now?: () => string;
  tracer?: Tracer;
  print?: (line: string) => void;
}

const indent = (s: string): string => s.split("\n").map((l) => `    ${l}`).join("\n");

/** Carry the plan out: dry run prints it; otherwise every operation in order through the adapter and the rows. */
export async function applyTickets(ops: readonly TicketOp[], adapter: TicketAdapter | null, rows: TicketRows | null, opts: ApplyOptions): Promise<TicketOutcome[]> {
  const now = opts.now ?? (() => new Date().toISOString());
  const print = opts.print ?? ((l: string) => console.log(l));
  const red = (s: string): string => opts.redactor.text(s);
  const out: TicketOutcome[] = [];
  const done = (op: TicketOp, status: OutcomeStatus, line: string, ext: string | null = op.op === "skip" ? null : op.ticket.external_id): void => {
    const ticketId = op.op === "skip" ? null : op.ticket.ticket_id;
    out.push({ op: op.op, ticket_id: ticketId, external_id: ext, status, line: red(line) });
    print(red(line));
    opts.tracer?.emit({
      agent: "psa", action: "triage", status: status === "failed" || status === "refused" ? "failed" : status === "skipped" || status === "planned" ? "skipped" : "ok",
      input_summary: `${op.op}${ticketId ? ` ${ticketId}` : ""}`, output_summary: line.slice(0, 400), detail: "model: none",
    });
  };

  for (const op of ops) {
    const line = opLine(op);
    if (op.op === "skip") { done(op, "skipped", line); continue; }
    if (opts.dryRun || !adapter || !rows) {
      done(op, "planned", `would ${line}`);
      if (op.op === "create") print(indent(red(`title: ${op.draft.title}\nlabels: ${op.draft.labels.join(", ")}\n\n${op.draft.body}${op.close ? `\n\n(then a closing comment)\n${op.close}` : ""}`)));
      else print(indent(red(op.body)));
      continue;
    }
    try {
      if (op.op === "create") {
        const draft = screenDraft(opts.redactor, opts.deny, op.draft);
        const closing = op.close === null ? null : outgoing(opts.redactor, opts.deny, op.close, "comment");
        if (!op.existing) await rows.insert([op.ticket]);
        const ref = await adapter.create(draft);
        await rows.update(op.ticket.ticket_id, { external_id: ref.external_id, url: red(ref.url), updated_at: now() });
        if (closing !== null) {
          await adapter.comment(ref.external_id, closing);
          await adapter.close(ref.external_id);
          await rows.update(op.ticket.ticket_id, { status: "closed", updated_at: now() });
        }
        done(op, closing === null ? "created" : "closed", `${closing === null ? "created" : "created and closed"} #${ref.external_id} ${red(ref.url)}: ${line}`, ref.external_id);
        continue;
      }
      const ext = op.ticket.external_id!;
      const body = outgoing(opts.redactor, opts.deny, op.body, "comment");
      if (await adapter.status(ext) === "closed") {
        await rows.update(op.ticket.ticket_id, { status: "closed", updated_at: now() });
        done(op, "synced", `#${ext} is closed in the PSA; ticket ${op.ticket.ticket_id} marked closed, nothing sent (${line})`);
        continue;
      }
      await adapter.comment(ext, body);
      if (op.op === "close") {
        await adapter.close(ext);
        await rows.update(op.ticket.ticket_id, { status: "closed", updated_at: now() });
        done(op, "closed", `closed #${ext}: ${line}`);
      } else {
        await rows.update(op.ticket.ticket_id, op.patch);
        done(op, "commented", `commented #${ext}: ${line}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      done(op, /deny-list probe/.test(msg) ? "refused" : "failed", `${/deny-list probe/.test(msg) ? "refused" : "failed"}: ${line}: ${msg}`);
    }
  }
  return out;
}

export interface StepOptions extends ApplyOptions { tenant: string; psa?: Ticket["psa"] }
export interface StepResult { ops: TicketOp[]; outcomes: TicketOutcome[]; summary: string }

/** Read, plan, apply, and one summary line. */
export async function ticketStep(layer: DataLayer, pass: Pick<PassResult, "findings" | "gatedOut">, adapter: TicketAdapter | null, rows: TicketRows | null, opts: StepOptions): Promise<StepResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const input = await readTicketInput(layer, pass, { tenant: opts.tenant, psa: opts.psa ?? adapter?.psa ?? "github", now: now(), tracer: opts.tracer });
  const ops = planTickets(input);
  const outcomes = await applyTickets(ops, adapter, rows, { ...opts, now });
  const count = (f: (o: TicketOutcome) => boolean): number => outcomes.filter(f).length;
  const plan = (["create", "comment", "close", "skip"] as const).map((k) => `${k} ${ops.filter((o) => o.op === k).length}`).join(", ");
  const did = (["created", "commented", "closed", "synced", "refused", "failed"] as const).map((s) => `${s} ${count((o) => o.status === s)}`).join(", ");
  const dry = opts.dryRun || !adapter || !rows;
  const summary = `TICKETS: tenant ${opts.tenant}, ${input.findings.length} finding(s), ${input.dispositions.length} disposition(s) and ${input.actions.length} action(s) in the ledger, `
    + `${input.tickets.length} ticket row(s) before; plan: ${plan}; ${dry ? "dry run, nothing sent or written" : did}`;
  opts.tracer?.emit({ agent: "psa", action: "triage", status: count((o) => o.status === "failed" || o.status === "refused") ? "failed" : "ok", input_summary: `tickets ${opts.tenant}`, output_summary: summary, detail: "model: none" });
  return { ops, outcomes, summary: opts.redactor.text(summary) };
}
