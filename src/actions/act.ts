// The Actor: the pass's dispositions read from the ledger and carried out under the policy, one action per
// disposition and kind, dry-run unless told to apply.
//
// Contract:
//   - Dispositions: DISPOSITIONS_SQL through the DataLayer, the tenant's rows, scoped to the pass's run ids: the given
//     ones, else for each (surface, host) the run of its latest decided disposition (greatest decided_at, then run_id);
//     of each finding on those runs, its latest disposition (greatest decided_at, then disposition_id), because every
//     pass writes its own row (rows.ts dispositionId carries decided_at).
//   - Verbs to kinds: ROLLBACK on linux.nginx -> rollback_file (src/actions/rollback.ts); ROLLBACK on cloudflare.dns
//     -> revert_record (src/actions/revert.ts); FIX -> investigate, then fix, refused with FIX_REFUSED
//     (src/actions/investigate.ts); ESCALATE under a rule whose on_drift is investigate -> investigate. ADOPT, HOLD and
//     every other ESCALATE carry no action. `only` keeps the named kinds; fix goes with investigate.
//   - Once per disposition: action_id is rows.ts actionId(tenant, disposition, kind), and a (disposition, kind) the
//     action table holds already (ACTIONS_SQL) is skipped and counted; a re-run over the same dispositions writes 0.
//   - Dry run (the default): every action becomes a plan item (plan.ts), printed redacted, and nothing is written to a
//     host, to Cloudflare, to Nightshift or to the action table. Apply: each action runs in disposition_id order and
//     its row, reason and record included, goes to the sink as soon as it ends, so a stop mid-way keeps the record of
//     what was done; a record re-created by POST carries its approvals to its new id through the same sink.
//   - Verification probes (probeNames): one probe run of surface probe.verify per call, so the pass's own probe run,
//     surface probe, stays the one it reads for production.
//   - An outcome's status is one of rows.ts ActionStatus: done, unverified (written, and no verification probe ran or
//     could be read), failed, refused, not_judged; the summary line counts each, and an unverified one traces as
//     not_checked.
//   - Every printed line passes the tenant's redactor; one trace line per plan item and per outcome, agent "actor".
//
// Measured 24 Oct 2026 on test/fixtures/policy-bundle.json with a vault built from its file and record rows
// (test/actions.test.ts): ROLLBACK 3 (app.conf, the missing blog.conf, rec-c3's content) and FIX 1 give five actions
// (rollback_file 2, revert_record, investigate, fix), and a second run over the same ledger writes 0. Live the same day,
// as the act step of the cycles of 23:36 and 23:38 UTC (dry run through Zetaris): 27 dispositions of 3 runs in scope,
// HOLD 27, the plan empty, 0.4 s each. Measured 25 Oct 2026 over sample/bundle.json (SAMPLE_MODE=true): 81 dispositions
// of the tenant in the ledger, the bundle's rows of three live passes (the sample pass writes 0), 27 of 3 runs in scope,
// HOLD 27, the plan empty, 2.2 s; as the act step of the 01:16 UTC cycle, a dry run through Zetaris, 0 actions planned,
// the ledger at 81.

import { pseudonymHost } from "../collectors/linux.ts";
import type { JudgeModel } from "../agents/judge.ts";
import type { DataLayer } from "../data/layer.ts";
import type { SqlJsEngine } from "../data/engines/sqljs.ts";
import { DISPOSITIONS_SQL, approvedCopies, latestApprovals, objects, observationsOf, policyRules, tenantActions } from "../data/queries.ts";
import type { Action, ActionKind, ActionStatus, ApprovedSetting, Disposition, DispositionVerb } from "../data/rows.ts";
import type { ReceiptFinder } from "../gate.ts";
import type { Finding } from "../pipeline.ts";
import type { CopyCandidate } from "../policy/decide.ts";
import type { PopulationRecord } from "../probe/rules.ts";
import { runProbes, type ProbeSink } from "../probe/run.ts";
import type { Redactor } from "../redactor.ts";
import type { Tracer } from "../trace.ts";
import type { Vault } from "../vault/vault.ts";
import { FIX_REFUSED, investigate, planInvestigate } from "./investigate.ts";
import {
  actionOf, dispositionOf, formatOutcome, formatPlan, outcome, planItem, plural, targetOf,
  type ActionOutcome, type ActorReads, type Approval, type PlanItem, type ProbeFn, type Row,
} from "./plan.ts";
import { planRevert, prepareRevert, revertRecord, type RecordApi } from "./revert.ts";
import { planRollback, prepareRollback, rollbackFile } from "./rollback.ts";
import type { SshRunner } from "./ssh.ts";

/** The kinds `only` names; fix follows its investigation. */
export const ONLY_KINDS = ["rollback_file", "revert_record", "investigate"] as const;
export type OnlyKind = (typeof ONLY_KINDS)[number];

/**
 * Where action rows go, and the approvals a re-created record carries (src/actions/revert.ts): the Store, or the sql.js
 * engine of a sample run or a test (MemoryActionSink).
 */
export interface ActionSink {
  insertActions(rows: readonly Action[]): Promise<number>;
  insertApproved(rows: readonly ApprovedSetting[]): Promise<number>;
}

/** The sql.js engine as an action sink: what the DataLayer over it reads back as {{t:action}} and {{t:approved_setting}}. */
export class MemoryActionSink implements ActionSink {
  constructor(private readonly engine: SqlJsEngine) {}
  async insertActions(rows: readonly Action[]): Promise<number> {
    return this.engine.insertRows("action", rows);
  }
  async insertApproved(rows: readonly ApprovedSetting[]): Promise<number> {
    return this.engine.insertRows("approved_setting", rows);
  }
}

export interface ActorDeps {
  layer: DataLayer;
  /** Null in a dry run; an apply without a sink is refused. */
  sink: ActionSink | null;
  redactor: Redactor;
  vault: Vault | null;
  aliasOf: (host: string) => string | null;
  ssh: SshRunner;
  records: RecordApi | null;
  probe: ProbeFn;
  model: JudgeModel | null;
  receipts: ReceiptFinder;
  findingOf: (d: Disposition) => Promise<Finding | null>;
  lightning: readonly string[];
  ultra: readonly string[];
  now?: () => Date;
  tracer?: Tracer;
}

export interface ActOptions {
  tenantId: string;
  apply: boolean;
  only?: readonly OnlyKind[];
  /** The pass's run ids; default the run of each (surface, host)'s latest decided disposition. */
  runIds?: readonly string[];
}

export interface ActResult {
  apply: boolean;
  /** The tenant's dispositions in the ledger. */
  ledger: number;
  scope: { runs: string[]; dispositions: number; verbs: Partial<Record<DispositionVerb, number>> };
  plan: PlanItem[];
  outcomes: ActionOutcome[];
  /** (disposition, kind) pairs the action table holds already. */
  acted: { action_id: string; kind: ActionKind; status: ActionStatus }[];
  /** Rows the sink wrote; null in a dry run. */
  written: number | null;
}

export class ActorError extends Error {}

/** The host pseudonym's ssh alias among LINUX_HOSTS (the collector's own pseudonymHost), or null. */
export function aliasFromHosts(aliases: readonly string[], redactor: Redactor): (host: string) => string | null {
  return (host) => aliases.find((a) => pseudonymHost(redactor, a) === host) ?? null;
}

/** For each (surface, host), the run of its latest decided disposition: the pass's run ids. */
export function latestRuns(ds: readonly Disposition[]): string[] {
  const best = new Map<string, Disposition>();
  for (const d of ds) {
    const k = `${d.surface}\u001f${d.host ?? ""}`;
    const b = best.get(k);
    if (!b || d.decided_at > b.decided_at || (d.decided_at === b.decided_at && d.run_id > b.run_id)) best.set(k, d);
  }
  return [...new Set([...best.values()].map((d) => d.run_id))].sort();
}

/** The latest disposition of each finding and run (greatest decided_at, then the greater disposition_id): what the latest pass over those runs decided. */
export function latestPerFinding(ds: readonly Disposition[]): Disposition[] {
  const best = new Map<string, Disposition>();
  for (const d of ds) {
    const k = `${d.finding_id}\u001f${d.run_id}`;
    const b = best.get(k);
    if (!b || d.decided_at > b.decided_at || (d.decided_at === b.decided_at && d.disposition_id > b.disposition_id)) best.set(k, d);
  }
  return [...best.values()];
}

/** The kinds a disposition calls for under its rule's on_drift. */
export function kindsFor(d: Disposition, onDrift: string | undefined): ActionKind[] {
  if (d.verb === "ROLLBACK") return d.surface === "linux.nginx" ? ["rollback_file"] : d.surface === "cloudflare.dns" ? ["revert_record"] : [];
  if (d.verb === "FIX") return ["investigate", "fix"];
  if (d.verb === "ESCALATE" && onDrift === "investigate") return ["investigate"];
  return [];
}

/** The surface of the Actor's verification probe runs; the pass reads surface probe alone for its probe run. */
export const VERIFY_SURFACE = "probe.verify";

/** The probe function the live Actor uses: one probe run (src/probe/run.ts) of surface probe.verify over the account records whose redacted name is asked for. */
export function probeNames(opts: { tenantId: string; redactor: Redactor; population: () => Promise<readonly PopulationRecord[]>; sink: ProbeSink | null }): ProbeFn {
  return async (names, kinds) => {
    const want = new Set(names);
    const records = (await opts.population()).filter((r) => want.has(opts.redactor.text(r.name)));
    if (!records.length) return [];
    return (await runProbes({ tenantId: opts.tenantId, population: async () => records, redactor: opts.redactor, kinds, sink: opts.sink, surface: VERIFY_SURFACE })).rows;
  };
}

const STATUS_TRACE = { done: "ok", unverified: "not_checked", failed: "failed", refused: "skipped", not_judged: "not_judged" } as const satisfies Record<ActionStatus, string>;
const keyOf = (dispositionId: string, kind: ActionKind): string => `${dispositionId}\u001f${kind}`;

export async function act(opts: ActOptions, deps: ActorDeps): Promise<ActResult> {
  const { layer, tracer, redactor } = deps;
  const now = deps.now ?? (() => new Date());
  if (opts.apply && !deps.sink) throw new ActorError("--apply records every action; it needs the action table (a sink)");
  const q = { tracer, agent: "actor", limit: 100_000 };

  const ledger = objects(await layer.run(DISPOSITIONS_SQL, {}, q)).map(dispositionOf).filter((d) => d.tenant_id === opts.tenantId);
  const runs = opts.runIds?.length ? [...new Set(opts.runIds)].sort() : latestRuns(ledger);
  const scope = latestPerFinding(ledger.filter((d) => runs.includes(d.run_id))).sort((a, b) => (a.disposition_id < b.disposition_id ? -1 : 1));
  const verbs: Partial<Record<DispositionVerb, number>> = {};
  for (const d of scope) verbs[d.verb] = (verbs[d.verb] ?? 0) + 1;

  const onDrift = new Map(objects(await policyRules(layer, opts.tenantId, q)).map((r) => [r.rule_id, r.on_drift]));
  const recorded = objects(await tenantActions(layer, opts.tenantId, q)).map(actionOf);
  const done = new Map(recorded.map((a) => [keyOf(a.disposition_id, a.kind), a]));

  // The reads every kind makes, cached for this run.
  let approvalRows: Row[] | null = null;
  let approvals: Map<string, Approval> | null = null;
  const approvalOfRow = (a: Row): Approval => ({ approval_id: a.approval_id, value_hash: a.value_hash, approved_at: a.approved_at, approved_by: a.approved_by || null });
  const latest = async (): Promise<Row[]> => (approvalRows ??= objects(await latestApprovals(layer, opts.tenantId, q)));
  const obs = new Map<string, Row[]>();
  const reads: ActorReads = {
    approvalOf: async (d) => {
      approvals ??= new Map((await latest()).map((a) => [[a.surface, a.host, a.object_id, a.setting_path].join("\u001f"), approvalOfRow(a)]));
      return approvals.get([d.surface, d.host ?? "", d.object_id, d.setting_path].join("\u001f")) ?? null;
    },
    approvalsOfObject: async (d) => (await latest())
      .filter((a) => a.surface === d.surface && a.host === (d.host ?? "") && a.object_id === d.object_id)
      .map((a) => ({ ...approvalOfRow(a), setting_path: a.setting_path }))
      .sort((a, b) => (a.setting_path < b.setting_path ? -1 : a.setting_path > b.setting_path ? 1 : 0)),
    copiesOf: async (d, approvedHash) => objects(await approvedCopies(layer, {
      tenant_id: d.tenant_id, surface: d.surface, host: d.host ?? "", object_id: d.object_id, setting_path: d.setting_path, approved_hash: approvedHash,
    }, q)).map((r): CopyCandidate => ({
      copy_id: r.copy_id, run_id: r.run_id, git_commit: r.git_commit, blob_sha256: r.blob_sha256, taken_at: r.taken_at, value_hash: r.value_hash,
      validator: r.validator, result: r.result, missing_dependencies: r.missing_dependencies, validated_at: r.validated_at,
    })),
    observationsOf: async (runId) => {
      if (!obs.has(runId)) obs.set(runId, objects(await observationsOf(layer, runId, q)));
      return obs.get(runId)!;
    },
    actionsOn: (target) => recorded.filter((a) => a.target === target).sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0)),
  };
  const kindDeps = { reads, vault: deps.vault, aliasOf: deps.aliasOf, ssh: deps.ssh, records: deps.records, probe: deps.probe, approvals: opts.apply ? deps.sink : null, redactor, now, tracer };
  const invDeps = { layer, reads, findingOf: deps.findingOf, model: deps.model, receipts: deps.receipts, lightning: deps.lightning, ultra: deps.ultra, redactor, now, tracer };

  const plan: PlanItem[] = [];
  const outcomes: ActionOutcome[] = [];
  const acted: ActResult["acted"] = [];
  let written: number | null = opts.apply ? 0 : null;
  const keep = (k: ActionKind): boolean => !opts.only?.length || opts.only.includes((k === "fix" ? "investigate" : k) as OnlyKind);

  const record = async (o: ActionOutcome): Promise<void> => {
    outcomes.push(o);
    recorded.push(o.action);
    tracer?.emit({
      agent: "actor", action: o.action.kind === "investigate" ? "check" : o.action.kind === "fix" ? "escalate" : "revise", status: STATUS_TRACE[o.action.status],
      input_summary: `${o.action.kind} ${o.action.target}`, output_summary: `${o.action.status}: ${o.reason}`, detail: o.record.join("; ").slice(0, 4000) || undefined,
      receipt_id: o.action.receipts.split(",").at(-1) || undefined,
    });
    written = (written ?? 0) + await deps.sink!.insertActions([o.action]);
  };

  for (const d of scope) {
    for (const kind of kindsFor(d, d.rule_id ? onDrift.get(d.rule_id) : undefined).filter(keep)) {
      const prior = done.get(keyOf(d.disposition_id, kind));
      if (prior) {
        acted.push({ action_id: prior.action_id, kind, status: prior.status });
        continue;
      }
      if (kind === "rollback_file" || kind === "revert_record") {
        const prep = kind === "rollback_file" ? await prepareRollback(d, kindDeps) : await prepareRevert(d, kindDeps);
        if ("refused" in prep) {
          if (!opts.apply) plan.push(planItem(d, kind, [`target ${targetOf(d)}, ${d.verb} under ${d.rule_id ?? "no rule"}`], prep.refused));
          else {
            const at = now().toISOString();
            await record(outcome(d, kind, { status: "refused", reason: redactor.text(prep.refused), started_at: at, finished_at: at }));
          }
        } else if ("alias" in prep) {
          if (!opts.apply) plan.push(planItem(d, kind, planRollback(d, prep)));
          else await record(await rollbackFile(d, prep, kindDeps));
        } else {
          if (!opts.apply) plan.push(planItem(d, kind, planRevert(d, prep)));
          else await record(await revertRecord(d, prep, kindDeps));
        }
        continue;
      }
      if (kind === "investigate") {
        if (!opts.apply) plan.push(planItem(d, kind, planInvestigate(d, deps)));
        else await record(await investigate(d, invDeps));
        continue;
      }
      // kind fix: after its investigation, refused under this policy.
      if (!opts.apply) plan.push(planItem(d, kind, [`after the investigation: ${FIX_REFUSED}; the ticket stays open`], FIX_REFUSED));
      else {
        const at = now().toISOString();
        await record(outcome(d, "fix", { status: "refused", reason: FIX_REFUSED, started_at: at, finished_at: at }));
      }
    }
  }
  for (const p of plan) {
    tracer?.emit({ agent: "actor", action: "triage", status: p.refused ? "skipped" : "ok", input_summary: `plan ${p.kind} ${p.action_id}`, output_summary: p.lines[0], detail: p.refused ?? p.lines.slice(1).join("; ") });
  }
  return { apply: opts.apply, ledger: ledger.length, scope: { runs, dispositions: scope.length, verbs }, plan, outcomes, acted, written };
}

const count = <T>(xs: readonly T[], f: (x: T) => boolean): number => xs.filter(f).length;

/** The printed result: the plan or the outcomes, then the summary line. Every line through the redactor. */
export function actLines(tenantId: string, res: ActResult, redactor: Redactor): string[] {
  const out: string[] = [];
  const verbs = Object.entries(res.scope.verbs).map(([v, n]) => `${v} ${n}`).join(", ") || "none";
  out.push(`act: tenant ${tenantId}, ${res.apply ? "applied" : "dry run (nothing written; --apply performs it)"}: ledger ${plural(res.ledger, "disposition")} of the tenant; scope ${plural(res.scope.dispositions, "disposition")} of ${plural(res.scope.runs.length, "run")} (${verbs})`);
  if (res.apply) for (const o of res.outcomes) out.push(...formatOutcome(o, redactor));
  else out.push(...formatPlan(res.plan, redactor));
  const items = res.apply ? res.outcomes.length : res.plan.length;
  if (items === 0) out.push(`act: the plan is empty: no disposition in scope calls for an action (ROLLBACK, FIX, or ESCALATE under an on_drift investigate rule)${res.acted.length ? `, beyond the ${plural(res.acted.length, "action")} already recorded` : ""}`);
  out.push(actSummary(res));
  return out.map((l) => redactor.text(l));
}

/** One line: what was planned or done, by kind and status, and the rows written. */
export function actSummary(res: ActResult): string {
  const kinds = (xs: readonly { kind: ActionKind }[]) => (["rollback_file", "revert_record", "investigate", "fix"] as const).map((k) => `${k} ${count(xs, (x) => x.kind === k)}`).join(", ");
  if (!res.apply) {
    return `act: dry run: ${plural(res.plan.length, "action")} planned (${kinds(res.plan)}), ${count(res.plan, (p) => !!p.refused)} of them refused on --apply; ${res.acted.length} already recorded; 0 action rows written`;
  }
  const by = (s: ActionStatus) => count(res.outcomes, (o) => o.action.status === s);
  return `act: applied: ${plural(res.outcomes.length, "action")} (${kinds(res.outcomes.map((o) => o.action))}): done ${by("done")}, unverified ${by("unverified")}, failed ${by("failed")}, refused ${by("refused")}, not_judged ${by("not_judged")}; ${res.acted.length} already recorded; ${res.written ?? 0} action rows written`;
}
