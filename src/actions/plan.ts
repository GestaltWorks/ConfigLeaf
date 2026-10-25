// What the Actor shares across its kinds and prints: the disposition as the ledger returns it, the reads every
// write path makes (the setting's latest approval, the vault copies of the approved value with their latest
// validation, a run's observations, the actions already recorded), the copy a ROLLBACK may restore, the plan a
// dry run prints and the outcome an applied action leaves.
//
// Contract:
//   - A disposition comes from DISPOSITIONS_SQL (src/data/queries.ts), every value a string, "" for NULL; dispositionOf
//     gives it back its row type.
//   - resolveCopy is the Decider's own rule (src/policy/decide.ts validCopy) over the same reads (LATEST_APPROVALS_SQL,
//     APPROVED_COPIES_SQL): the newest copy that carries the approved hash and whose latest validation is ok or
//     ok_with_gaps. It stands only when its commit starts with the 8 hex the disposition's reason names ("vault commit
//     <8 hex> holds the approved copy"); a moved approval or copy is a refusal with the reason, and nothing is written.
//   - A plan is lines of redacted text: what would be written where, from which vault commit, and which checks and probes
//     follow. It carries hashes as 12 hex and commits as 8; the bytes of files and records stay in the vault.
//   - An outcome is the action row plus one plain sentence (reason) and the record: plain sentences, each tied to the
//     query id, probe id or receipt id it rests on where one exists. The row carries both, the record one sentence per
//     line and cut at rows.ts ACTION_RECORD_MAX characters, so the ticket step and the owner read them from the action
//     table; the trace and the caller get them too.
//   - A write path's status: done when the write completed and every verification probe is ok; unverified when the
//     write completed and no verification probe ran or could be read, the reason naming which; failed when the write
//     path did not complete, its read back differs, or a probe that answered fails; refused when nothing was written.
//   - priorWrites: the actions of one kind already recorded over the same target, vault commit and live value. A
//     failed one refuses the retry (left to a technician); an unverified one completed its write, so the write runs
//     again and the new action's reason names it (priorUnverified).

import type { CopyCandidate } from "../policy/decide.ts";
import { validCopy } from "../policy/decide.ts";
import type { Redactor } from "../redactor.ts";
import type { TraceEvent } from "../trace.ts";
import { ACTION_RECORD_MAX, actionId, type Action, type ActionKind, type ActionStatus, type Disposition, type DispositionVerb, type Probe, type ProbeKind } from "../data/rows.ts";

export type Row = Record<string, string>;

/** Probes of these redacted names, of these kinds, as stored rows (src/probe through a probe run); the tests hand in a fake. */
export type ProbeFn = (names: readonly string[], kinds: readonly ProbeKind[]) => Promise<Probe[]>;

/** Where the Actor's trace lines go: a Tracer, or a test's memory tracer. */
export interface Emitter { emit(e: Omit<TraceEvent, "ts" | "trace_id">): unknown }

/** One probe row as a record sentence, tied to its probe id. */
export const probeSentence = (p: Readonly<Record<"probe_id" | "kind" | "target" | "status" | "observed", string>>): string => `probe ${p.probe_id}: ${p.kind} ${p.target} ${p.status} (${p.observed})`;

const nul = (s: string | undefined): string | null => (s === undefined || s === "" ? null : s);

/** A DISPOSITIONS_SQL row back to its type. */
export function dispositionOf(r: Row): Disposition {
  return {
    disposition_id: r.disposition_id, tenant_id: r.tenant_id, surface: r.surface, host: nul(r.host), object_id: r.object_id, setting_path: r.setting_path,
    value_hash: r.value_hash, verb: r.verb as DispositionVerb, reason: r.reason, expires_at: nul(r.expires_at), decided_by: r.decided_by as Disposition["decided_by"],
    rule_id: nul(r.rule_id), finding_id: r.finding_id, run_id: r.run_id, decided_at: r.decided_at,
  };
}

/** An ACTIONS_SQL row back to its type. */
export function actionOf(r: Row): Action {
  return {
    action_id: r.action_id, tenant_id: r.tenant_id, kind: r.kind as ActionKind, target: r.target, before_hash: nul(r.before_hash), after_hash: nul(r.after_hash),
    vault_commit: nul(r.vault_commit), verification: r.verification, receipts: r.receipts, status: r.status as ActionStatus,
    reason: r.reason ?? "", record: r.record ?? "", started_at: r.started_at, finished_at: nul(r.finished_at), disposition_id: r.disposition_id,
  };
}

/** The record lines as the action row's record: one per line, cut at ACTION_RECORD_MAX characters. */
export const recordText = (lines: readonly string[]): string => lines.join("\n").slice(0, ACTION_RECORD_MAX);

export const h12 = (h: string | null | undefined): string => (h ? h.replace(/^sha256:/, "").slice(0, 12) : "-");
export const c8 = (c: string | null | undefined): string => (c ? c.slice(0, 8) : "-");
export const sha = (hex: string): string => (hex.startsWith("sha256:") ? hex : `sha256:${hex}`);
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The redacted setting an action is about: surface, host when there is one, object and setting path. */
export const targetOf = (d: Pick<Disposition, "surface" | "host" | "object_id" | "setting_path">): string =>
  `${d.surface} ${d.host ? `${d.host} ` : ""}${d.object_id} ${d.setting_path}`;

/** The 8 hex of the vault commit a ROLLBACK's reason names, or null. */
export function namedCommit(reason: string): string | null {
  return reason.match(/\bvault commit ([0-9a-f]{8})\b/)?.[1] ?? null;
}

/** The setting's latest approval as LATEST_APPROVALS_SQL returns it. */
export interface Approval { approval_id: string; value_hash: string; approved_at: string; approved_by: string | null }

/** The reads every kind makes, cached per Actor run (src/actions/act.ts). */
export interface ActorReads {
  approvalOf(d: Disposition): Promise<Approval | null>;
  /** The latest approval of every setting of the disposition's object (surface, host, object_id), in setting_path order. */
  approvalsOfObject(d: Disposition): Promise<(Approval & { setting_path: string })[]>;
  copiesOf(d: Disposition, approvedHash: string): Promise<CopyCandidate[]>;
  observationsOf(runId: string): Promise<Row[]>;
  /** The actions already recorded on this target, any disposition, oldest first. */
  actionsOn(target: string): Action[];
}

export interface CopyChoice { approval: Approval; copy: CopyCandidate }

/** The copy a ROLLBACK restores, by the Decider's rule, or why there is none now (see the header). */
export async function resolveCopy(d: Disposition, reads: ActorReads): Promise<CopyChoice | { refused: string }> {
  const named = namedCommit(d.reason);
  if (!named) return { refused: `disposition ${d.disposition_id} names no vault commit; a rollback restores the copy the Decider named` };
  const approval = await reads.approvalOf(d);
  if (!approval) return { refused: `the setting has no approval on record now; the Decider named commit ${named} against one` };
  const copies = await reads.copiesOf(d, approval.value_hash);
  const copy = validCopy(copies, approval.value_hash);
  if (!copy) return { refused: `no copy of approved ${h12(approval.value_hash)} validates now (${plural(copies.length, "copy", "copies")} in the vault); the Decider named commit ${named}` };
  if (!copy.git_commit.startsWith(named)) return { refused: `the valid copy of approved ${h12(approval.value_hash)} is at commit ${c8(copy.git_commit)} now; the Decider named commit ${named}` };
  return { approval, copy };
}

/** The latest failed and the latest unverified action of `kind` over the disposition's target, vault commit `commit` and live value `before`. */
export function priorWrites(reads: ActorReads, d: Disposition, kind: ActionKind, commit: string, before: string | null): { failed: Action | null; unverified: Action | null } {
  const same = reads.actionsOn(targetOf(d)).filter((a) => a.kind === kind && a.vault_commit === commit && a.before_hash === before);
  return { failed: same.filter((a) => a.status === "failed").at(-1) ?? null, unverified: same.filter((a) => a.status === "unverified").at(-1) ?? null };
}

/** The clause a reason carries for an unverified action that wrote the same copy over the same live value before; "" when there is none. */
export const priorUnverified = (a: Pick<Action, "action_id" | "started_at" | "finished_at"> | null): string =>
  a ? `; action ${a.action_id} wrote the same copy over the same live value at ${a.finished_at ?? a.started_at} and ended unverified` : "";

/** The gap count of a copy's latest validation, as the Decider counts it. */
export const gaps = (c: Pick<CopyCandidate, "missing_dependencies">): number => c.missing_dependencies.split("\n").filter((s) => s.trim() !== "").length;

/** One action a dry run would take. */
export interface PlanItem {
  action_id: string;
  kind: ActionKind;
  disposition_id: string;
  /** Redacted lines: the target, what would be written where from which commit, what follows. */
  lines: string[];
  /** Set when --apply would refuse it, with the reason. */
  refused?: string;
}

export function planItem(d: Disposition, kind: ActionKind, lines: string[], refused?: string): PlanItem {
  return { action_id: actionId(d.tenant_id, d.disposition_id, kind), kind, disposition_id: d.disposition_id, lines, ...(refused ? { refused } : {}) };
}

/** What one applied action leaves: the row, one sentence, and the record of what ran. */
export interface ActionOutcome {
  action: Action;
  reason: string;
  record: string[];
}

export interface OutcomeFields {
  status: ActionStatus;
  reason: string;
  record?: string[];
  before_hash?: string | null;
  after_hash?: string | null;
  vault_commit?: string | null;
  verification?: readonly string[];
  receipts?: readonly string[];
  started_at: string;
  finished_at: string;
}

export function outcome(d: Disposition, kind: ActionKind, f: OutcomeFields): ActionOutcome {
  return {
    action: {
      action_id: actionId(d.tenant_id, d.disposition_id, kind), tenant_id: d.tenant_id, kind, target: targetOf(d),
      before_hash: f.before_hash ?? null, after_hash: f.after_hash ?? null, vault_commit: f.vault_commit ?? null,
      verification: [...new Set(f.verification ?? [])].join(","), receipts: [...new Set(f.receipts ?? [])].join(","),
      status: f.status, reason: f.reason, record: recordText(f.record ?? []), started_at: f.started_at, finished_at: f.finished_at, disposition_id: d.disposition_id,
    },
    reason: f.reason,
    record: f.record ?? [],
  };
}

/** A plan as printed: one block per item, every line through the redactor. */
export function formatPlan(items: readonly PlanItem[], redactor: Redactor): string[] {
  const out: string[] = [];
  for (const p of items) {
    out.push(redactor.text(`${p.kind} ${p.action_id} for disposition ${p.disposition_id}${p.refused ? ` (refused on --apply: ${p.refused})` : ""}`));
    for (const l of p.lines) out.push(`  ${redactor.text(l)}`);
  }
  return out;
}

/** An outcome as printed: the status line, the reason, then the record, every line through the redactor. */
export function formatOutcome(o: ActionOutcome, redactor: Redactor): string[] {
  const a = o.action;
  const head = `${a.kind} ${a.action_id} ${a.status}: ${o.reason}`;
  const facts = [
    a.before_hash || a.after_hash ? `before ${h12(a.before_hash)}, after ${h12(a.after_hash)}` : "",
    a.vault_commit ? `vault commit ${c8(a.vault_commit)}` : "",
    a.verification ? `verification ${a.verification}` : "",
    a.receipts ? `receipts ${a.receipts}` : "",
  ].filter(Boolean).join("; ");
  return [head, ...(facts ? [`  ${facts}`] : []), ...o.record.map((l) => `  ${l}`)].map((l) => redactor.text(l));
}
