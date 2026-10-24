// One assurance pass with no model: what SAMPLE_MODE runs over sample/bundle.json and what the live
// pass grows from (same steps, with Lightning choosing checks and Ultra judging added). Every step is
// SQL through the DataLayer, or a World Model query over what that SQL returned; nothing maps an
// input to an answer.
//
//   gate     runComplete for every collection run. A failing run is traced not_checked and feeds
//            nothing below: not the World Model, not the hero query, not a finding. The audit log has
//            no run_id on its rows (audit_event is keyed by the vendor's event id so overlapping pulls
//            dedupe), so its gate works on the checks instead: when a tenant's latest cloudflare.audit
//            run failed the gate, or the tenant has none, every catalogue template that reads
//            audit_event (actor_attributed, previous_value_recoverable, record_reverted,
//            referent_unchanged) is a recorded rejection for that tenant's findings, "audit log
//            incomplete", and each such finding escalates; a partial pull is never read as "no actor,
//            no previous state".
//   observe  every observation of a passing host-bound run goes into the World Model. A dns_name
//            referent carries a fingerprint: what the name's A and AAAA records resolved to in the
//            DNS run of the same pass, taken as the passing DNS run nearest in time and within
//            PASS_WINDOW_MS (a pass collects every surface within minutes; "latest at or before"
//            would pair a 02:01 host run with the previous day's 02:05 DNS run, and no bound would
//            pair today's host run with a three-day-old DNS run when today's failed the gate).
//   detect   the hero query over the latest run of each (tenant, surface, host) against that DNS
//            run; with none in the window the group is not_checked and the trace names the DNS run
//            that failed. A row is found_but_different when the setting's bytes are unchanged since
//            the previous passing run and the World Model says the referent's fingerprint is not;
//            dns_change otherwise (no previous run, or the bytes changed too). The finding carries
//            the DNS record its row came from, matched on content: a name with an A and an AAAA
//            record gives two rows and two findings, each naming its own record.
//   check    the default precondition policy for the class, bound from the finding and run through
//            the catalogue; a parameter the finding cannot supply, or a check the SQL guard refuses,
//            is a recorded rejection, not a guess: it escalates that one finding and the pass goes on.
//   survey   the estate queries (data/queries.ts) over the same pass: once per tenant against its DNS
//            run, a proxied CNAME aliasing a direct address record (proxy_split); per host, against
//            the latest passing nginx run and that DNS run, a proxied name served by an enabled block
//            that trusts no real_ip range, or a proxied wildcard landing on a host where nothing does
//            (proxied_without_real_ip), a record landing on the host with no enabled block naming it
//            (orphan_record) and a server_name with no record and no covering wildcard (orphan_vhost).
//            A survey finding has no previous observation, so its window is the audit log's reach
//            (AUDIT_SPAN_SQL) up to the observation; its anchor is the nginx setting the row names, or
//            the DNS record itself (object_id = record id) when the finding is about the record.
//   check    the default precondition policy for the class, bound from the finding and run through
//            the catalogue; a parameter the finding cannot supply, or a check the SQL guard refuses,
//            is a recorded rejection, not a guess: it escalates that one finding and the pass goes on.
//   decide   every check holds and none was rejected -> ADOPT, as a candidate; anything else ->
//            ESCALATE. HOLD needs a judge to bound it with an expiry, so a pass with no model never
//            issues it. [stoprule] Between checks the stop rule (src/stoprule.ts) may end checking early;
//            [exposure] for a finding on a DNS record the step dates its exposure (src/engine/world.ts).
//            [memory] When the pass is given a TechnicianMemory (src/engine/memory.ts) the Decider recalls
//            the technician's lessons for the finding first, by exact scope key: an accepted exception in
//            force yields ADOPT with its expiry on the finding and a trace line naming the lesson; one that
//            has lapsed re-raises the finding as ESCALATE ("exception lapsed"), whatever the checks say.
//            The checks still run and are recorded either way; only the verb and the judge call change.
//   judge    skipped and traced as such: model: none; [stoprule] or "verdict cannot move" when the
//            withdraw rule says no judge call would be worth spending, or when an exception settled it.

import { createHash } from "node:crypto";
import { defaultChecks, type FindingSummary, type RejectedCheck } from "./catalogue/select.ts";
import { CATALOGUE, runCheck, type CheckResult, type FindingClass } from "./catalogue/templates.ts";
import { DataLayerError, type DataLayer } from "./data/layer.ts";
import {
  auditSpan, hero, listRuns, objects, observationsOf, orphanRecords, orphanVhosts, proxiedWithoutRealIp, proxySplit,
  resolutions, runComplete, wildcardWithoutRealIp,
} from "./data/queries.ts";
import type { ExceptionLesson, TechnicianMemory } from "./engine/memory.ts";
import { DriftWorld, recordExposure, type ExposureLine, type ExposureMeasure, type Observation } from "./engine/world.ts";
import type { Tracer } from "./trace.ts";
// [stoprule] the verifier's stop rule and the withdraw rule before the judge (src/stoprule.ts).
import { VERDICT_CANNOT_MOVE, countersSummary, earlyStopSummary, shouldStop, shouldWithdraw, zeroCounters, type StopCounters, type StopPolicy } from "./stoprule.ts";

type Row = Record<string, string>;

export type Verb = "ADOPT" | "ESCALATE";

/** A host run and a DNS run belong to one pass only when they started within this of each other. */
export const PASS_WINDOW_MS = 6 * 3600 * 1000;

export interface CheckOutcome { template: string; holds: boolean; rowCount: number; explanation: string }

export interface WorldView { before: string | null; after: string | null; changed: boolean; bytes_unchanged: boolean }

/** [memory] The technician's accepted exception the Decider applied (ADOPT until `expires_at`) or found lapsed (re-raised as ESCALATE). */
export interface ExceptionNote {
  /** The lesson's id in the agent's memory (scripts/answer.ts --forget takes it). */
  lesson: string;
  status: "applied" | "lapsed";
  expires_at: string;
  scope_key: string;
  reason: string;
  accepted_by: string;
  accepted_at: string;
}

export interface Finding {
  /** Stable across passes: `fnd-` plus 16 hex of the World Model's finding id (tenant, class, host, object, setting, record). What a technician names to scripts/answer.ts. */
  id: string;
  finding: FindingSummary;
  verb: Verb;
  /** FOUND-BUT-DIFFERENT as the World Model saw it: the referent's fingerprint at the previous and at the current observation. Hero findings only; a survey finding has no previous observation. */
  world?: WorldView;
  checks: CheckOutcome[];
  /** Checks that did not run: a parameter the finding could not supply, or a check the data layer refused. */
  rejected: RejectedCheck[];
  judge: "skipped";
  /** [stoprule] The stop rule ended checking early: why, and the templates it did not run. */
  earlyStop?: { reason: string; skipped: string[] };
  /** [stoprule] Why the judge call was not spent, when the withdraw rule said so. */
  judgeWithheld?: string;
  /** [exposure] Since when the record this finding rests on has been in its current state (src/engine/world.ts). */
  exposure?: ExposureLine;
  /** [memory] The accepted exception that settled the verb, applied or lapsed. Absent when none applies. */
  exception?: ExceptionNote;
}

export interface MemoryCounters {
  /** Lessons the memory held when the pass ran, every tenant. */
  lessons: number;
  /** Findings adopted under an accepted exception in force. */
  applied: number;
  /** Findings re-raised because their exception had lapsed. */
  lapsed: number;
}

export interface PassResult {
  runs: number;
  gatedOut: string[];
  observed: number;
  findings: Finding[];
  /** [stoprule] The verifier's counters for this pass; stopCounters reads the same numbers back from the trace's stop and judge lines. */
  verifier: StopCounters;
  /** [memory] What the Decider recalled; null when the pass was given no memory. */
  memory: MemoryCounters | null;
}

const nul = (s: string): string | null => (s === "" ? null : s);
const later = (a: string, b: string): string => (a > b ? a : b);
/** The templates that consult the audit log: withheld for a tenant whose audit run failed the gate. */
export const AUDIT_TEMPLATES: readonly string[] = CATALOGUE.filter((t) => t.sql.includes("{{t:audit_event}}")).map((t) => t.id);
/** A fingerprint for a finding anchored on a DNS record rather than a stored observation: sha256 of the redacted row text, labelled as such. */
const sha256 = (s: string): string => `sha256:${createHash("sha256").update(s).digest("hex")}`;

function toObservation(o: Row, fingerprint: string | null): Observation {
  return {
    tenantId: o.tenant_id, surface: o.surface, objectId: o.object_id, settingPath: o.setting_path, valueHash: o.value_hash,
    refersTo: o.refers_to_type ? { targetType: o.refers_to_type, targetId: o.refers_to_id, fingerprint } : undefined,
    observedAt: o.observed_at, source: o.source, authority: Number(o.authority), collectionId: o.run_id,
  };
}

const sameSetting = (a: Row) => (b: Row): boolean => a.object_id === b.object_id && a.setting_path === b.setting_path;

/** The DNS run among `candidates` nearest in time to `r`, same tenant, within PASS_WINDOW_MS; else undefined. */
function nearestDns(candidates: Row[], r: Row): Row | undefined {
  const t = Date.parse(r.started_at);
  const gap = (d: Row): number => Math.abs(Date.parse(d.started_at) - t);
  const best = candidates.filter((d) => d.tenant_id === r.tenant_id && d.surface === "cloudflare.dns").sort((a, b) => gap(a) - gap(b))[0];
  return best && gap(best) <= PASS_WINDOW_MS ? best : undefined;
}

export interface PassOptions {
  tracer?: Tracer;
  world?: DriftWorld;
  stopPolicy?: Omit<StopPolicy, "gatedTables">;
  /** [memory] The technician's lessons the Decider consults before deciding; none when absent (tests, the examples, the site build). */
  memory?: TechnicianMemory;
  /** [memory] The instant lessons are recalled at (ISO 8601 UTC); the memory's clock when absent. */
  at?: string;
}

/** `fnd-` plus 16 hex of sha256 over the World Model's finding id: short enough to type, stable across passes. */
export const shortFindingId = (worldFindingId: string): string => `fnd-${createHash("sha256").update(worldFindingId).digest("hex").slice(0, 16)}`;

export async function runPass(layer: DataLayer, opts: PassOptions = {}): Promise<PassResult> {
  const { tracer, memory } = opts;
  const world = opts.world ?? new DriftWorld("pass");
  const findings: Finding[] = [];
  // [stoprule] counters for the pass; [exposure] one measurement per (tenant, DNS run, record, field); [memory] what was recalled.
  const verifier = zeroCounters();
  const exposureCache = new Map<string, ExposureMeasure>();
  const recalled: MemoryCounters | null = memory ? { lessons: memory.lessons().length, applied: 0, lapsed: 0 } : null;

  /** Why the tenant's audit log may not be consulted this pass, or null when its latest audit run passed the gate. Filled by the gate step. */
  const auditWithheld = new Map<string, string>();

  /** check, decide, judge for one finding, whatever produced it; appends to findings. */
  const assess = async (finding: FindingSummary, view: WorldView | undefined): Promise<void> => {
    const cls = finding.class;
    const setting = `${finding.setting_path} in ${finding.object_id}${finding.host ? ` on ${finding.host}` : ""}`;
    const selection = defaultChecks(finding);
    const checks: CheckOutcome[] = [];
    const rejected: RejectedCheck[] = [...selection.rejected];
    const withheld = auditWithheld.get(finding.tenant_id);
    // [stoprule] Between checks the stop rule says whether the verb can still move. A settled verdict skips
    // the queued checks that do not inform the next action (traced "skipped" with the reason); when every
    // queued check reads the withheld audit log they are recorded at once as not checked (they escalate).
    const stopPolicy: StopPolicy = { ...opts.stopPolicy, gatedTables: withheld !== undefined ? ["audit_event"] : [] };
    let earlyStop: { reason: string; skipped: string[] } | undefined;
    const queue = [...selection.valid];
    while (queue.length > 0) {
      const stop = shouldStop({
        findingClass: cls, checksSoFar: checks, remaining: queue.map((q) => q.template), policy: stopPolicy,
        rejected: rejected.map((rj) => String((rj.check as { template?: unknown })?.template ?? "?")),
      });
      if (stop.stop) {
        const out = queue.filter((q) => stop.skipped.includes(q.template));
        queue.splice(0, queue.length, ...queue.filter((q) => !stop.skipped.includes(q.template)));
        for (const q of out) {
          if (stop.kind === "gated") rejected.push({ check: q, reason: `${q.template}: audit log incomplete (${withheld})` });
          else tracer?.emit({ agent: "checker", action: "check", status: "skipped", input_summary: `${q.template} ${JSON.stringify(q.params)}`.slice(0, 200), detail: stop.reason });
        }
        verifier.early_stop += 1;
        if (stop.kind === "gated") verifier.checks_gated += out.length;
        else verifier.checks_skipped += out.length;
        earlyStop = { reason: earlyStop ? `${earlyStop.reason}; ${stop.reason}` : stop.reason, skipped: [...(earlyStop?.skipped ?? []), ...out.map((q) => q.template)] };
        tracer?.emit({ agent: "checker", action: "check", status: "skipped", input_summary: `${cls} ${setting}`, output_summary: earlyStopSummary(stop.kind, out.map((q) => q.template)), detail: stop.reason });
        continue;
      }
      const c = queue.shift()!;
      if (withheld !== undefined && AUDIT_TEMPLATES.includes(c.template)) {
        rejected.push({ check: c, reason: `${c.template}: audit log incomplete (${withheld})` });
        continue;
      }
      let r: CheckResult;
      try {
        r = await runCheck(layer, c.template, c.params, { tracer, agent: "checker" });
      } catch (err) {
        // The guard or the engine refused this one check: record it, escalate this finding, keep the pass going.
        if (!(err instanceof DataLayerError)) throw err;
        rejected.push({ check: c, reason: `${c.template}: ${err.message}` });
        continue;
      }
      checks.push({ template: r.template, holds: r.holds, rowCount: r.rowCount, explanation: r.explanation });
      tracer?.emit({
        agent: "checker", action: "check", status: r.holds ? "ok" : "failed",
        input_summary: `${r.template} ${JSON.stringify(c.params)}`.slice(0, 200),
        output_summary: `${r.template}: ${r.holds ? "holds" : "fails"} (${r.rowCount} rows)`, detail: r.explanation,
      });
    }
    for (const rj of rejected) {
      tracer?.emit({ agent: "checker", action: "check", status: "not_checked", input_summary: String((rj.check as { template?: unknown })?.template ?? "?"), detail: rj.reason });
    }

    const failing = checks.filter((c) => !c.holds).map((c) => c.template);
    const policyVerb: Verb = checks.length > 0 && failing.length === 0 && rejected.length === 0 ? "ADOPT" : "ESCALATE";
    const policyWhy = policyVerb === "ADOPT"
      ? `all ${checks.length} preconditions hold; candidate pending a judge`
      : [
        failing.length ? `${failing.length} of ${checks.length} preconditions fail: ${failing.join(", ")}` : "",
        rejected.length ? `${rejected.length} check(s) could not be bound from the finding or were refused by the guard` : "",
        checks.length === 0 && rejected.length === 0 ? "no precondition ran" : "",
      ].filter(Boolean).join("; ");

    // [memory] recall before deciding, by exact scope key (same tenant, same class, the finding's host, name or
    // address). An exception in force settles ADOPT with its expiry; a lapsed one, with none in force, re-raises
    // the finding as ESCALATE however the checks came out. Answers (kind "answer") are the Decider's helper for a
    // question it has not yet learned to ask; the pass asks none today, so they are counted and left alone.
    const recall = memory?.recall(finding, opts.at);
    const applied = recall?.applicable.find((l): l is ExceptionLesson => l.kind === "exception") ?? null;
    const lapsed = applied ? null : (recall?.expired.filter((l): l is ExceptionLesson => l.kind === "exception").at(-1) ?? null);
    const lesson = applied ?? lapsed;
    const verb: Verb = applied ? "ADOPT" : lapsed ? "ESCALATE" : policyVerb;
    const why = applied
      ? `accepted exception ${applied.id} holds until ${applied.expiresAt} (${applied.reason}); the checks alone would say ${policyVerb}`
      : lapsed
        ? `exception lapsed: ${lapsed.id} expired ${lapsed.expiresAt}; re-raised to the technician, the checks alone would say ${policyVerb}`
        : policyWhy;
    if (applied && recalled) recalled.applied += 1;
    if (lapsed && recalled) recalled.lapsed += 1;
    if (applied) {
      tracer?.emit({
        agent: "decider", action: "triage", status: "ok", input_summary: `memory ${cls} ${setting}`,
        output_summary: `exception ${applied.id} accepted by ${applied.provenance.by} until ${applied.expiresAt}: ADOPT`,
        detail: `lesson ${applied.id} on ${applied.scopeKey} (${applied.findingClass}), recorded ${applied.recordedAt}: ${applied.reason}; model: none`,
      });
    }
    if (lapsed) {
      tracer?.emit({
        agent: "decider", action: "escalate", status: "ok", input_summary: `memory ${cls} ${setting}`,
        output_summary: `exception ${lapsed.id} lapsed ${lapsed.expiresAt}: re-raised as ESCALATE`,
        detail: `lesson ${lapsed.id} on ${lapsed.scopeKey} (${lapsed.findingClass}), accepted by ${lapsed.provenance.by} ${lapsed.recordedAt}: ${lapsed.reason}; the exception is not applied; model: none`,
      });
    }
    tracer?.emit({
      agent: "decider", action: "decide", status: "ok", input_summary: `${cls} ${setting}`, output_summary: `${verb}: ${why}`,
      detail: "model: none; policy: every check holds -> ADOPT candidate, any fails or unbound -> ESCALATE, HOLD needs a judge"
        + (earlyStop ? `; earlyStop: true (${earlyStop.reason})` : "") // [stoprule] the decide step receives { earlyStop, reason }
        + (lesson ? `; exception: ${lesson.id} ${applied ? "applied" : "lapsed"}` : ""), // [memory] and the lesson that settled it
    });
    // [exposure] the decide step records the exposure line: SQL dates it, the World Model keeps it as an open edge.
    const exposure = await recordExposure(layer, world, finding, { tracer, cache: exposureCache });
    // [stoprule] withdraw before the judge: no judge call is spent on a verdict that cannot move or a claim its own checks contradict;
    // [memory] nor on a verdict the technician's exception settled, in force or lapsed.
    const withdraw = applied
      ? { withdraw: true, reason: `${VERDICT_CANNOT_MOVE}: accepted exception ${applied.id} holds until ${applied.expiresAt}; the technician's acceptance, not a judge, settles it` }
      : lapsed
        ? { withdraw: true, reason: `${VERDICT_CANNOT_MOVE}: exception ${lapsed.id} lapsed ${lapsed.expiresAt}; the finding goes back to the technician whatever a judge answers` }
        : shouldWithdraw({ findingClass: cls, checks, rejected: rejected.length });
    if (withdraw.withdraw) verifier.withdrawn_judge += 1;
    if (withdraw.contradictedBy) {
      tracer?.emit({ agent: "checker", action: "critique", target_agent: "detector", status: "ok", input_summary: `${cls} ${setting}`, output_summary: withdraw.reason, detail: "model: none" });
      tracer?.emit({ agent: "detector", action: "revise", status: "ok", input_summary: `${cls} ${setting}`, output_summary: "finding withdrawn before judge", detail: withdraw.reason });
    }
    tracer?.emit({ agent: "judge", action: "judge", status: "skipped", input_summary: finding.summary.slice(0, 160), detail: withdraw.withdraw ? withdraw.reason : "model: none (sample)" });
    const exception: ExceptionNote | undefined = lesson
      ? { lesson: lesson.id, status: applied ? "applied" : "lapsed", expires_at: lesson.expiresAt, scope_key: lesson.scopeKey, reason: lesson.reason, accepted_by: lesson.provenance.by, accepted_at: lesson.recordedAt }
      : undefined;
    findings.push({
      id: shortFindingId(world.findingId(finding)),
      finding, verb, ...(view ? { world: view } : {}), checks, rejected, judge: "skipped",
      ...(earlyStop ? { earlyStop } : {}), ...(withdraw.withdraw ? { judgeWithheld: withdraw.reason } : {}), ...(exposure ? { exposure } : {}),
      ...(exception ? { exception } : {}),
    });
  };

  const runs = objects(await listRuns(layer, { tracer, agent: "observer" }));

  // gate
  const gatedOut = new Set<string>();
  for (const r of runs) {
    const g = await runComplete(layer, r.run_id, { tracer, agent: "observer" });
    if (g.total > 0) gatedOut.add(r.run_id);
    tracer?.emit({
      agent: "observer", action: "check", status: g.total > 0 ? "not_checked" : "ok",
      input_summary: `run_complete ${r.run_id}`,
      output_summary: `${r.surface}${r.host ? ` ${r.host}` : ""}: ${r.observed_count}/${r.expected_count} ${r.status}`,
      detail: g.total > 0 ? `run ${r.run_id} fails the DQ gate; its observations feed no finding` : undefined,
    });
  }
  const passing = runs.filter((r) => !gatedOut.has(r.run_id));
  // The audit surface's gate: audit_event rows carry no run_id, so a failing audit run withholds the audit templates per tenant.
  for (const tenant of new Set(runs.map((r) => r.tenant_id))) {
    const latestAudit = runs.filter((r) => r.tenant_id === tenant && r.surface === "cloudflare.audit").at(-1);
    const why = !latestAudit ? "no cloudflare.audit run for this tenant" : gatedOut.has(latestAudit.run_id) ? `latest audit run ${latestAudit.run_id} failed the DQ gate` : null;
    if (why === null) continue;
    auditWithheld.set(tenant, why);
    tracer?.emit({
      agent: "observer", action: "check", status: "not_checked", input_summary: `audit_event ${tenant}`,
      output_summary: `audit log withheld for ${tenant}: ${why}`, detail: `${AUDIT_TEMPLATES.join(", ")} are rejected for every finding of this tenant this pass`,
    });
  }
  const dnsFor = (r: Row): Row | undefined => nearestDns(passing, r);
  const gatedDnsFor = (r: Row): Row | undefined => nearestDns(runs.filter((x) => gatedOut.has(x.run_id)), r);

  // observe
  const obsByRun = new Map<string, Row[]>();
  const resByRun = new Map<string, Row[]>();
  let observed = 0;
  for (const r of passing.filter((x) => x.host !== "")) {
    const obs = objects(await observationsOf(layer, r.run_id, { tracer, agent: "observer" }));
    const dns = dnsFor(r);
    const res = dns ? objects(await resolutions(layer, { run_id: r.run_id, dns_run_id: dns.run_id }, { tracer, agent: "observer" })) : [];
    obsByRun.set(r.run_id, obs);
    resByRun.set(r.run_id, res);
    const fp = new Map<string, string[]>();
    for (const x of res) fp.set(x.obs_id, [...(fp.get(x.obs_id) ?? []), x.content]);
    for (const o of obs) await world.observe(toObservation(o, fp.get(o.obs_id)?.sort().join(",") ?? null));
    observed += obs.length;
    tracer?.emit({
      agent: "observer", action: "observe", status: "ok", input_summary: r.run_id,
      output_summary: `${obs.length} observations recorded, ${fp.size} with a resolved referent${dns ? ` (DNS run ${dns.run_id})` : " (no DNS run of this pass passed the gate)"}`,
      detail: "model: none",
    });
  }

  // detect, check, decide
  const groups = new Map<string, Row[]>();
  for (const r of runs.filter((x) => x.host !== "")) {
    const k = `${r.tenant_id}|${r.surface}|${r.host}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const group of groups.values()) {
    const latest = group[group.length - 1];
    const where = `${latest.surface} ${latest.host}`;
    if (gatedOut.has(latest.run_id)) {
      tracer?.emit({ agent: "detector", action: "detect", status: "not_checked", input_summary: where, output_summary: `latest run ${latest.run_id} failed the DQ gate; not checked this pass` });
      continue;
    }
    const dns = dnsFor(latest);
    if (!dns) {
      const gated = gatedDnsFor(latest);
      tracer?.emit({
        agent: "detector", action: "detect", status: "not_checked", input_summary: where,
        output_summary: gated
          ? `no DNS run of this pass passed the gate (${gated.run_id} failed); the hero query has nothing to join`
          : "no DNS run of this pass for this tenant; the hero query has nothing to join",
      });
      continue;
    }
    const previous = group.filter((r) => !gatedOut.has(r.run_id) && r.run_id !== latest.run_id).at(-1);
    const rows = objects(await hero(layer, { tenant_id: latest.tenant_id, run_id: latest.run_id, dns_run_id: dns.run_id }, { tracer, agent: "detector" }));
    tracer?.emit({
      agent: "detector", action: "detect", status: "ok", input_summary: `hero ${latest.run_id} x ${dns.run_id}`,
      output_summary: `${where}: ${rows.length} setting(s) point at a name resolving outside the inventory`, detail: "model: none",
    });

    for (const row of rows) {
      const cur = obsByRun.get(latest.run_id)?.find(sameSetting(row));
      if (!cur) throw new Error(`hero row for ${row.object_id} ${row.setting_path} has no observation in ${latest.run_id}`);
      const prev = previous ? obsByRun.get(previous.run_id)?.find(sameSetting(row)) : undefined;
      const sid = world.settingId({ tenantId: cur.tenant_id, surface: cur.surface, objectId: cur.object_id, settingPath: cur.setting_path });
      const fbd = prev ? world.foundButDifferent(sid, prev.observed_at, cur.observed_at) : { changed: false, before: null, after: world.fingerprintNow(sid) };
      const bytesUnchanged = prev !== undefined && prev.value_hash === cur.value_hash;
      const cls: FindingClass = bytesUnchanged && fbd.changed ? "found_but_different" : "dns_change";
      const since = prev?.observed_at ?? latest.started_at;
      const until = row.dns_observed_at > cur.observed_at ? row.dns_observed_at : cur.observed_at;
      // The record this row came from: RESOLUTIONS_SQL returns one row per record, so match on content, not only on the observation.
      const record = resByRun.get(latest.run_id)?.find((x) => x.obs_id === cur.obs_id && x.content === row.resolves_to);
      const setting = `${cur.setting_path} in ${cur.object_id} on ${cur.host}`;
      const summary = cls === "found_but_different"
        ? `${setting} is byte-identical since ${since}; ${row.upstream_name} resolved to ${fbd.before} then and to ${row.resolves_to} now, an address not in the inventory`
        : `${setting} points at ${row.upstream_name}, which resolves to ${row.resolves_to}, an address not in the inventory`;
      const finding: FindingSummary = {
        class: cls, tenant_id: cur.tenant_id, run_id: cur.run_id, surface: cur.surface, host: nul(cur.host),
        object_id: cur.object_id, setting_path: cur.setting_path, value_hash: cur.value_hash, value_redacted: nul(cur.value_redacted),
        refers_to_type: nul(cur.refers_to_type), refers_to_id: nul(cur.refers_to_id),
        dns_name: row.upstream_name, resolves_to: row.resolves_to, resource_id: record?.record_id ?? null, dns_run_id: dns.run_id,
        since, until, summary,
      };
      tracer?.emit({
        agent: "detector", action: "detect", status: "ok", input_summary: setting, output_summary: `${cls}: ${summary}`,
        detail: `fingerprint ${fbd.before ?? "unknown"} -> ${fbd.after ?? "unknown"}; bytes ${bytesUnchanged ? "unchanged" : prev ? "changed" : "no previous passing run"} (model: none)`,
      });
      await assess(finding, { before: fbd.before, after: fbd.after, changed: fbd.changed, bytes_unchanged: bytesUnchanged });
    }
  }

  // survey
  const spans = new Map<string, string | null>();
  const auditReach = async (tenant: string): Promise<string | null> => {
    if (!spans.has(tenant)) spans.set(tenant, nul(objects(await auditSpan(layer, tenant, { tracer, agent: "detector" }))[0]?.first_at ?? ""));
    return spans.get(tenant) ?? null;
  };
  const surveyOpts = { tracer, agent: "detector" };

  const latestDns = new Map<string, Row>();
  for (const d of passing.filter((r) => r.surface === "cloudflare.dns")) latestDns.set(d.tenant_id, d);
  for (const [tenant, dns] of latestDns) {
    const rows = objects(await proxySplit(layer, { tenant_id: tenant, dns_run_id: dns.run_id }, surveyOpts));
    tracer?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `proxy_split ${dns.run_id}`, output_summary: `cloudflare.dns: ${rows.length} proxied CNAME(s) alias a direct address record`, detail: "model: none" });
    for (const row of rows) {
      const summary = `${row.proxied_name} is proxied and aliases ${row.target_name}, whose ${row.target_type} record is direct to ${row.target_content}: the origin the proxy hides is published on the name it points at`;
      tracer?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `proxied record ${row.proxied_record_id}`, output_summary: `proxy_split: ${summary}`, detail: "model: none" });
      await assess({
        class: "proxy_split", tenant_id: tenant, run_id: dns.run_id, surface: "cloudflare.dns", host: null,
        object_id: row.proxied_record_id, setting_path: "proxied", value_hash: sha256("1"), value_redacted: "1",
        refers_to_type: "dns_name", refers_to_id: row.target_name, dns_name: row.proxied_name, resolves_to: row.target_content,
        resource_id: row.proxied_record_id, dns_run_id: dns.run_id, since: (await auditReach(tenant)) ?? dns.started_at, until: row.observed_at, summary,
      }, undefined);
    }
  }

  for (const group of groups.values()) {
    const latest = group[group.length - 1];
    if (latest.surface !== "linux.nginx" || gatedOut.has(latest.run_id)) continue;
    const dns = dnsFor(latest);
    if (!dns) continue;
    const params = { tenant_id: latest.tenant_id, run_id: latest.run_id, dns_run_id: dns.run_id };
    const since = (await auditReach(latest.tenant_id)) ?? dns.started_at;
    const where = `${latest.surface} ${latest.host}`;

    const blocks = objects(await proxiedWithoutRealIp(layer, params, surveyOpts));
    const wild = objects(await wildcardWithoutRealIp(layer, params, surveyOpts));
    tracer?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `proxied_without_real_ip ${latest.run_id} x ${dns.run_id}`, output_summary: `${where}: ${blocks.length} proxied name(s) served by a block that trusts no real_ip range, ${wild.length} proxied wildcard(s) landing where nothing does`, detail: "model: none" });
    for (const row of [...blocks, ...wild]) {
      const wildcard = row.setting_path === "http.real_ip";
      const summary = wildcard
        ? `${row.name} is proxied through Cloudflare to ${row.origin}, and no server block on ${row.host} trusts a Cloudflare range (${row.setting_path} in ${row.object_id} is absent): every name under the wildcard sees Cloudflare's addresses as its visitors`
        : `${row.name} is proxied through Cloudflare to ${row.origin}, and ${row.setting_path} in ${row.object_id} on ${row.host} is absent: the block that serves it sees Cloudflare's addresses as its visitors`;
      tracer?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `${row.setting_path} in ${row.object_id} on ${row.host}`, output_summary: `proxied_without_real_ip: ${summary}`, detail: "model: none" });
      await assess({
        class: "proxied_without_real_ip", tenant_id: latest.tenant_id, run_id: latest.run_id, surface: latest.surface, host: row.host,
        object_id: row.object_id, setting_path: row.setting_path, value_hash: row.value_hash, value_redacted: row.value_redacted,
        refers_to_type: "dns_name", refers_to_id: row.name, dns_name: row.name, resolves_to: row.origin, resource_id: row.record_id, dns_run_id: dns.run_id,
        since, until: later(row.observed_at, row.dns_observed_at), summary,
      }, undefined);
    }

    const records = objects(await orphanRecords(layer, params, surveyOpts));
    tracer?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `orphan_record ${latest.run_id} x ${dns.run_id}`, output_summary: `${where}: ${records.length} record(s) land here with no enabled server block naming them`, detail: "model: none" });
    for (const row of records) {
      const summary = `${row.name} (${row.type}, ${row.proxied === "1" ? "proxied" : "direct"}) lands on ${row.origin}, ${row.host}, where no enabled server block names it: requests for it reach the default server`;
      tracer?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `record ${row.record_id}`, output_summary: `orphan_record: ${summary}`, detail: "model: none" });
      await assess({
        class: "orphan_record", tenant_id: latest.tenant_id, run_id: dns.run_id, surface: "cloudflare.dns", host: row.host,
        object_id: row.record_id, setting_path: "name", value_hash: sha256(`${row.type} ${row.name} ${row.content}`), value_redacted: row.name,
        refers_to_type: "dns_name", refers_to_id: row.name, dns_name: row.name, resolves_to: row.origin, resource_id: row.record_id, dns_run_id: dns.run_id,
        since, until: later(row.observed_at, latest.started_at), summary,
      }, undefined);
    }

    const vhosts = objects(await orphanVhosts(layer, params, surveyOpts));
    tracer?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `orphan_vhost ${latest.run_id} x ${dns.run_id}`, output_summary: `${where}: ${vhosts.length} server_name(s) with no record and no covering wildcard`, detail: "model: none" });
    for (const row of vhosts) {
      const summary = `${row.server_name} is a server_name in ${row.object_id} on ${row.host} (${row.enabled === "1" ? "enabled" : "on disk, not enabled"}) with no record of that name in the collected zones and no wildcard covering its zone`;
      tracer?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `${row.setting_path} in ${row.object_id} on ${row.host}`, output_summary: `orphan_vhost: ${summary}`, detail: "model: none" });
      await assess({
        class: "orphan_vhost", tenant_id: latest.tenant_id, run_id: latest.run_id, surface: latest.surface, host: row.host,
        object_id: row.object_id, setting_path: row.setting_path, value_hash: row.value_hash, value_redacted: row.server_name,
        refers_to_type: "dns_name", refers_to_id: row.server_name, dns_name: row.server_name, resolves_to: null, resource_id: null, dns_run_id: dns.run_id,
        since, until: later(row.observed_at, dns.started_at), summary,
      }, undefined);
    }
  }

  // [stoprule] one summary line per pass; stopCounters reads the same numbers back from the stop and judge lines.
  tracer?.emit({ agent: "decider", action: "triage", status: "ok", input_summary: "stop rule", output_summary: countersSummary(verifier), detail: "model: none" });
  // [memory] one summary line per pass when a memory was consulted: what it held and what the Decider did with it.
  if (recalled) {
    tracer?.emit({
      agent: "decider", action: "triage", status: "ok", input_summary: "memory",
      output_summary: `lessons ${recalled.lessons}, exceptions applied ${recalled.applied}, lapsed ${recalled.lapsed}`,
      detail: `${memory!.directory ? "local store" : "in-memory store"}; recall by exact scope key, never by similarity; model: none`,
    });
  }
  return { runs: runs.length, gatedOut: [...gatedOut], observed, findings, verifier, memory: recalled };
}
