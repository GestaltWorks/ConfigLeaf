// The explainer: the explain step's work between the pass and act. For each finding the pass explains (cause.ts
// explains) it reads the evidence through the DataLayer and the vault, classifies the cause (cause.ts
// explainFinding), writes one finding_cause row per disposition through a sink, and traces one line per cause under
// agent "explainer". No model, and nothing it does changes a disposition, a host or a zone. Act and the ticket step
// read the rows back by disposition (causesByDisposition) with their timeline (causeEvidence).
//
// Contract:
//   - Reads, once per pass and only when a finding is explained: the tenant's latest approvals (LATEST_APPROVALS_SQL),
//     its audit_event rows of source journal and cloudflare from the earliest window's start less LOGIN_MS
//     (CAUSE_EVENTS_SQL; a login can precede the window), and its action rows (ACTIONS_SQL). Per explained finding:
//     a `file` setting's approved copy (APPROVED_COPIES_SQL, the latest taken) and its live copy (the vault_copy row of
//     the finding's run, LIVE_COPY_SQL), both read from the vault (Vault.treeOf, one read per commit); any other
//     setting's approved value text (APPROVED_VALUE_SQL: the latest observation that carries the approved hash).
//   - The diff (diff.ts), every line through linux.ts redactText: a file's approved bytes against its live bytes (an
//     approved_missing file against nothing); else an approved value against the observed one; else, for a hero
//     finding, the referent's fingerprint before against now. null when there is nothing to compare: no vault, no
//     copy, no approval. A vault or SQL error on one finding leaves its diff null and is counted, never thrown.
//   - account_change values: a record finding's approved value and its observed value; a hero finding's referent
//     before and now.
//   - Writes: one row per explained disposition through the sink (Store.insertFindingCauses live, MemoryCauseSink over
//     sql.js), idempotent on cause_id (one per tenant and disposition); a dry run writes them too. With no sink,
//     nothing is written and written is null. A sink error is counted and reported, never thrown.
//   - Traces: one line per cause, agent "explainer", action "explain", status ok (not_checked for unknown), the
//     sentence as output and the window, the rows searched and the evidence ids as detail; one summary line.
//   - Live, finding_cause is read through Zetaris once the DRIFT datasource registers it (src/zetaris/setup.ts, the
//     register datasource tables step); the explain step itself reads only tables registered before it and writes
//     through the Store.
//
// Measured 25 Oct 2026. Over test/fixtures/policy-bundle.json and the Actor's fixture vault (test/explain.test.ts): 8
// causes (account_change 2, unknown 6), 8 rows written, 0 on a second run. On the lab estate, tenant lab-1, the
// journal from lab/journalctl: the dry-run cycle of 19:19 UTC after a sudo tee break to 8096 gave 1 cause,
// operator_edit, "The file was changed at 19:17 UTC by user-212a17 over ssh from 198.51.100.7 (sudo tee).", 11
// evidence rows (10 journal rows and 10 actions searched), an 11-line diff from the vault, the step 1.4 s; read back
// through Zetaris in 0.5 s; after the rollback act-efac92f99ab27ec5 (done, 19:22:08 UTC) the reader's sentence ends
// ", 4 minutes before the agent restored it."

import { actionOf } from "../actions/plan.ts";
import { redactText } from "../collectors/linux.ts";
import type { DataLayer, RunOptions } from "../data/layer.ts";
import type { SqlJsEngine } from "../data/engines/sqljs.ts";
import { approvedCopies, latestApprovals, objects, tenantActions } from "../data/queries.ts";
import { COLUMNS, type Action, type AuditEvent, type CauseClass, type FindingCause } from "../data/rows.ts";
import type { Finding } from "../pipeline.ts";
import type { Redactor } from "../redactor.ts";
import type { Tracer } from "../trace.ts";
import type { Vault, VaultTree } from "../vault/vault.ts";
import { dispositionIdOf } from "../loop/pass.ts";
import { CAUSE_CLASSES, LOGIN_MS, causeWindow, evidenceOfAction, evidenceOfEvent, explainFinding, explains, withRestore, type Evidence } from "./cause.ts";
import { unifiedDiff, valueDiff } from "./diff.ts";

export const EXPLAINER = "explainer";

type Row = Record<string, string>;

/** The tenant's audit_event rows of source journal and cloudflare at or after `since`, oldest first. */
export const CAUSE_EVENTS_SQL = `SELECT event_id, tenant_id, source, actor, action, resource_type, resource_id, old_value, new_value, occurred_at
FROM {{t:audit_event}}
WHERE tenant_id = {{p:tenant_id}} AND occurred_at >= {{p:since}} AND (source = 'journal' OR source = 'cloudflare')
ORDER BY occurred_at, event_id`;

/** The vault copy of one object in one run (the live bytes of a file finding). */
export const LIVE_COPY_SQL = `SELECT copy_id, run_id, git_commit, blob_sha256, taken_at
FROM {{t:vault_copy}}
WHERE tenant_id = {{p:tenant_id}} AND run_id = {{p:run_id}} AND object_id = {{p:object_id}}
ORDER BY copy_id`;

/** The observations of one setting that carry a given value hash, latest first: the approved value as text. */
export const APPROVED_VALUE_SQL = `SELECT obs_id, value_redacted, observed_at
FROM {{t:observation}}
WHERE tenant_id = {{p:tenant_id}} AND surface = {{p:surface}} AND object_id = {{p:object_id}} AND setting_path = {{p:setting_path}} AND value_hash = {{p:value_hash}}
ORDER BY observed_at DESC, obs_id DESC`;

/** The tenant's finding_cause rows, in disposition_id order. */
export const CAUSES_SQL = `SELECT ${COLUMNS.finding_cause.join(", ")}
FROM {{t:finding_cause}}
WHERE tenant_id = {{p:tenant_id}}
ORDER BY disposition_id, cause_id`;

/** Where finding_cause rows go: the Store live, the sql.js engine of a sample run or a test. */
export interface CauseSink { insertFindingCauses(rows: readonly FindingCause[]): Promise<number> }

/** The sql.js engine as a cause sink: what the DataLayer over it reads back as {{t:finding_cause}}. */
export class MemoryCauseSink implements CauseSink {
  constructor(private readonly engine: SqlJsEngine) {}
  async insertFindingCauses(rows: readonly FindingCause[]): Promise<number> {
    return this.engine.insertRows("finding_cause", rows);
  }
}

export interface ExplainDeps {
  layer: DataLayer;
  vault: Vault | null;
  redactor: Redactor;
  /** Null writes nothing. */
  sink: CauseSink | null;
  tracer?: Tracer;
}

/** One explained finding: its cause row and the evidence rows behind it, oldest first. */
export interface ExplainedCause {
  finding_id: string;
  disposition_id: string;
  verb: Finding["verb"];
  finding_class: string;
  cause: FindingCause;
  evidence: Evidence[];
}

export interface ExplainResult {
  tenant: string;
  decidedAt: string;
  causes: ExplainedCause[];
  /** Causes per class, every class listed. */
  counts: Record<CauseClass, number>;
  /** The rows read: journal and cloudflare audit rows, ledger actions. */
  searched: { journal: number; cloudflare: number; actions: number };
  /** Rows the sink wrote; null with no sink. */
  written: number | null;
  /** What went wrong without stopping the step: a diff not read, the sink refusing. */
  errors: string[];
}

const nul = (s: string | undefined): string | null => (s === undefined || s === "" ? null : s);

/** An audit_event row as the DataLayer returns it (NULL as "") back to its type. */
export function auditOf(r: Row): AuditEvent {
  return {
    event_id: r.event_id, tenant_id: r.tenant_id, source: r.source, actor: nul(r.actor), action: r.action, resource_type: nul(r.resource_type),
    resource_id: nul(r.resource_id), old_value: nul(r.old_value), new_value: nul(r.new_value), occurred_at: r.occurred_at,
  };
}

/** A finding_cause row as the DataLayer returns it back to its type. */
export function causeOf(r: Row): FindingCause {
  return {
    cause_id: r.cause_id, tenant_id: r.tenant_id, finding_id: r.finding_id, disposition_id: r.disposition_id, class: r.class as CauseClass,
    actor: nul(r.actor), mechanism: nul(r.mechanism), occurred_at: nul(r.occurred_at), source_host: nul(r.source_host), evidence_ids: r.evidence_ids || "[]",
    diff: nul(r.diff), summary: r.summary, window_from: r.window_from, window_to: r.window_to, decided_at: r.decided_at,
  };
}

const keyOf = (surface: string, host: string | null, objectId: string, settingPath: string): string => [surface, host ?? "", objectId, settingPath].join("\u001f");
const c8 = (c: string): string => c.slice(0, 8);

/** The causes of a pass's explained findings (see the header); each disposition id is the one the pass gave its finding. */
export async function explainPass(pass: { tenant: string; decidedAt: string; findings: readonly Finding[] }, deps: ExplainDeps): Promise<ExplainResult> {
  const { layer, redactor, tracer } = deps;
  const tenant = pass.tenant;
  const decidedAt = new Date(pass.decidedAt).toISOString();
  const counts = Object.fromEntries(CAUSE_CLASSES.map((c) => [c, 0])) as Record<CauseClass, number>;
  const errors: string[] = [];
  const targets = pass.findings.filter((f) => f.finding.tenant_id === tenant && explains(f));
  if (!targets.length) {
    tracer?.emit({ agent: EXPLAINER, action: "explain", status: "ok", input_summary: `explain ${tenant}`, output_summary: `explain: the pass moved on no finding of tenant ${tenant}; nothing to explain`, detail: "model: none" });
    return { tenant, decidedAt, causes: [], counts, searched: { journal: 0, cloudflare: 0, actions: 0 }, written: deps.sink ? 0 : null, errors };
  }
  const q: RunOptions = { tracer, agent: EXPLAINER, limit: 100_000 };

  const approvals = new Map(objects(await latestApprovals(layer, tenant, q)).map((a) => [keyOf(a.surface, nul(a.host), a.object_id, a.setting_path), a]));
  const approvalOf = (f: Finding): Row | undefined => approvals.get(keyOf(f.finding.surface, f.finding.host, f.finding.object_id, f.finding.setting_path));
  const windows = targets.map((f) => causeWindow({ approvedAt: approvalOf(f)?.approved_at ?? null, lastMatched: f.finding.since, to: decidedAt }));
  const since = new Date(Math.min(...windows.map((w) => Date.parse(w.from))) - LOGIN_MS).toISOString();
  const events = objects(await layer.run(CAUSE_EVENTS_SQL, { tenant_id: tenant, since }, q)).map(auditOf);
  const actions = objects(await tenantActions(layer, tenant, q)).map(actionOf);

  // the vault trees each diff reads, one read per commit
  const trees = new Map<string, VaultTree>();
  const fileText = (copy: Row, objectId: string): string | null => {
    if (!deps.vault) return null;
    let tree = trees.get(copy.git_commit);
    if (!tree) {
      tree = deps.vault.treeOf({ tenant_id: tenant, git_commit: copy.git_commit });
      trees.set(copy.git_commit, tree);
    }
    const real = Object.entries(tree.paths).find(([, id]) => id === objectId)?.[0];
    const bytes = real === undefined ? undefined : tree.files.get(real.replace(/^\/+/, ""));
    return bytes === undefined ? null : bytes.toString("utf8");
  };
  const line = (s: string): string => redactText(redactor, s);

  const approvedText = async (f: Finding, hash: string): Promise<string | null> => {
    const s = f.finding;
    const rows = objects(await layer.run(APPROVED_VALUE_SQL, { tenant_id: tenant, surface: s.surface, object_id: s.object_id, setting_path: s.setting_path, value_hash: hash }, { ...q, limit: 1 }));
    return rows.length ? rows[0].value_redacted : null;
  };

  type Values = { from: string | null; to: string | null };
  /** A file setting's diff: its approved copy against its live copy (nothing, for an approved_missing file); null without both. */
  const fileDiff = async (f: Finding, approval: Row): Promise<string | null> => {
    const s = f.finding;
    if (!deps.vault) return null;
    const approved = objects(await approvedCopies(layer, { tenant_id: tenant, surface: s.surface, host: s.host ?? "", object_id: s.object_id, setting_path: "file", approved_hash: approval.value_hash }, q)).at(-1);
    const a = approved ? fileText(approved, s.object_id) : null;
    if (!approved || a === null) return null;
    const missing = s.class === "approved_missing" || s.value_hash === "";
    const live = missing ? undefined : objects(await layer.run(LIVE_COPY_SQL, { tenant_id: tenant, run_id: s.run_id, object_id: s.object_id }, q))[0];
    const b = live ? fileText(live, s.object_id) : missing ? "" : null;
    if (b === null) return null;
    return unifiedDiff(a, b, { from: `approved ${c8(approved.git_commit)}`, to: live ? `live ${c8(live.git_commit)}` : "live (absent)", line });
  };
  /** The diff and the record's values before and after (see the header). */
  const facts = async (f: Finding): Promise<{ diff: string | null; values: Values }> => {
    const s = f.finding;
    const approval = approvalOf(f);
    const hero: Values | null = f.world && f.world.before !== f.world.after ? { from: f.world.before, to: f.world.after ?? s.resolves_to ?? null } : null;
    const observed = s.class === "approved_missing" ? null : s.value_redacted ?? null;
    if (s.setting_path === "file" && s.surface.startsWith("linux.")) return { diff: approval ? await fileDiff(f, approval) : null, values: hero ?? { from: null, to: null } };
    const approved = approval && approval.value_hash !== s.value_hash ? await approvedText(f, approval.value_hash) : null;
    const values: Values = hero ?? (s.surface === "cloudflare.dns" ? { from: approved, to: observed } : { from: null, to: null });
    if (approved !== null) return { diff: valueDiff(s.setting_path, approved, observed, { from: "approved", to: "live", line }), values };
    if (hero) return { diff: valueDiff(s.dns_name ?? "referent", hero.from, hero.to, { from: "before", to: "now", line }), values };
    return { diff: null, values };
  };

  const causes: ExplainedCause[] = [];
  for (const f of targets) {
    let got: Awaited<ReturnType<typeof facts>> = { diff: null, values: { from: null, to: null } };
    try {
      got = await facts(f);
    } catch (e) {
      errors.push(`${f.id}: the diff was not read (${redactor.text((e as Error).message)})`);
    }
    const dispositionId = dispositionIdOf(f, decidedAt);
    const c = explainFinding({
      tenantId: tenant, finding: f, dispositionId, decidedAt, approvedAt: approvalOf(f)?.approved_at ?? null, lastMatched: f.finding.since,
      events, actions, diff: got.diff, values: got.values, redactor,
    });
    counts[c.row.class]++;
    causes.push({ finding_id: f.id, disposition_id: dispositionId, verb: f.verb, finding_class: f.finding.class, cause: c.row, evidence: c.evidence });
    tracer?.emit({
      agent: EXPLAINER, action: "explain", status: c.row.class === "unknown" ? "not_checked" : "ok",
      input_summary: `explain ${f.id} ${f.verb} ${f.finding.class} ${f.finding.surface} ${f.finding.host ? `${f.finding.host} ` : ""}${f.finding.object_id} ${f.finding.setting_path}`,
      output_summary: `${c.row.class}: ${c.row.summary}`,
      detail: `window ${c.row.window_from} to ${c.row.window_to}; ${c.searched.journal} journal and ${c.searched.cloudflare} cloudflare row(s) in the window, `
        + `${c.searched.writes} write(s) to the file, ${c.searched.events} event(s) for the record, ${actions.length} action(s) in the ledger; `
        + `evidence ${JSON.parse(c.row.evidence_ids).join(", ") || "none"}; diff ${c.row.diff ? `${c.row.diff.split("\n").length} lines` : "none"}; model: none`,
    });
  }

  let written: number | null = null;
  if (deps.sink) {
    try {
      written = await deps.sink.insertFindingCauses(causes.map((c) => c.cause));
    } catch (e) {
      written = 0;
      errors.push(`finding_cause not written: ${redactor.text((e as Error).message)}`);
    }
  }
  const searched = { journal: events.filter((e) => e.source === "journal").length, cloudflare: events.filter((e) => e.source === "cloudflare").length, actions: actions.length };
  tracer?.emit({
    agent: EXPLAINER, action: "explain", status: errors.length ? "needs_revision" : "ok", input_summary: `explain ${tenant}`,
    output_summary: `explain: ${causes.length} cause(s) (${CAUSE_CLASSES.filter((k) => counts[k]).map((k) => `${k} ${counts[k]}`).join(", ")}); finding_cause ${written ?? "not"} written`,
    detail: `${searched.journal} journal and ${searched.cloudflare} cloudflare row(s) since ${since}, ${searched.actions} action(s); ${errors.length ? errors.join("; ") : "no error"}; model: none`,
  });
  return { tenant, decidedAt, causes, counts, searched, written, errors };
}

// ---- reading causes back: act and the ticket step ------------------------------------------------------------

/** The tenant's causes by disposition_id; only the given dispositions' when `dispositionIds` is given. */
export async function causesByDisposition(layer: DataLayer, tenantId: string, dispositionIds?: readonly string[], opts: RunOptions = {}): Promise<Map<string, FindingCause>> {
  const want = dispositionIds ? new Set(dispositionIds) : null;
  const rows = objects(await layer.run(CAUSES_SQL, { tenant_id: tenantId }, { limit: 100_000, ...opts })).map(causeOf);
  return new Map(rows.filter((c) => !want || want.has(c.disposition_id)).map((c) => [c.disposition_id, c]));
}

/** Each cause's evidence rows by cause_id, in evidence_ids order, read back from audit_event and the action ledger; an id no longer held is left out. */
export async function causeEvidence(layer: DataLayer, tenantId: string, causes: readonly FindingCause[], opts: RunOptions = {}): Promise<Map<string, Evidence[]>> {
  const ids = causes.map((c) => JSON.parse(c.evidence_ids) as string[]);
  const out = new Map<string, Evidence[]>(causes.map((c) => [c.cause_id, []]));
  if (!ids.some((x) => x.length)) return out;
  const q = { limit: 100_000, ...opts };
  const since = new Date(Math.min(...causes.map((c) => Date.parse(c.window_from))) - LOGIN_MS).toISOString();
  const byId = new Map<string, Evidence>();
  for (const e of objects(await layer.run(CAUSE_EVENTS_SQL, { tenant_id: tenantId, since }, q)).map(auditOf)) byId.set(e.event_id, evidenceOfEvent(e));
  for (const a of objects(await tenantActions(layer, tenantId, q)).map(actionOf)) byId.set(a.action_id, evidenceOfAction(a));
  causes.forEach((c, k) => out.set(c.cause_id, ids[k].flatMap((id) => byId.get(id) ?? [])));
  return out;
}

/** A cause's sentence as a reader shows it: the stored summary, with the restore clause once the agent's action on its disposition wrote (cause.ts withRestore). */
export function causeSentence(c: FindingCause, actions: readonly Pick<Action, "disposition_id" | "kind" | "status" | "started_at">[] = []): string {
  return withRestore(c, actions);
}
