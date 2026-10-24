// One assurance pass with no model: what SAMPLE_MODE runs over sample/bundle.json and what the live
// pass grows from (same steps, with Lightning choosing checks and Ultra judging added). Every step is
// SQL through the DataLayer, or a World Model query over what that SQL returned; nothing maps an
// input to an answer.
//
//   gate     runComplete for every collection run. A failing run is traced not_checked and feeds
//            nothing below: not the World Model, not the hero query, not a finding.
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
//   decide   every check holds and none was rejected -> ADOPT, as a candidate; anything else ->
//            ESCALATE. HOLD needs a judge to bound it with an expiry, so a pass with no model never
//            issues it.
//   judge    skipped and traced as such: model: none.

import { defaultChecks, type FindingSummary, type RejectedCheck } from "./catalogue/select.ts";
import { runCheck, type CheckResult, type FindingClass } from "./catalogue/templates.ts";
import { DataLayerError, type DataLayer } from "./data/layer.ts";
import { hero, listRuns, objects, observationsOf, resolutions, runComplete } from "./data/queries.ts";
import { DriftWorld, type Observation } from "./engine/world.ts";
import type { Tracer } from "./trace.ts";

type Row = Record<string, string>;

export type Verb = "ADOPT" | "ESCALATE";

/** A host run and a DNS run belong to one pass only when they started within this of each other. */
export const PASS_WINDOW_MS = 6 * 3600 * 1000;

export interface CheckOutcome { template: string; holds: boolean; rowCount: number; explanation: string }

export interface Finding {
  finding: FindingSummary;
  verb: Verb;
  /** FOUND-BUT-DIFFERENT as the World Model saw it: the referent's fingerprint at the previous and at the current observation. */
  world: { before: string | null; after: string | null; changed: boolean; bytes_unchanged: boolean };
  checks: CheckOutcome[];
  /** Checks that did not run: a parameter the finding could not supply, or a check the data layer refused. */
  rejected: RejectedCheck[];
  judge: "skipped";
}

export interface PassResult {
  runs: number;
  gatedOut: string[];
  observed: number;
  findings: Finding[];
}

const nul = (s: string): string | null => (s === "" ? null : s);

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

export async function runPass(layer: DataLayer, opts: { tracer?: Tracer; world?: DriftWorld } = {}): Promise<PassResult> {
  const { tracer } = opts;
  const world = opts.world ?? new DriftWorld("pass");
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
  const findings: Finding[] = [];
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

      const selection = defaultChecks(finding);
      const checks: CheckOutcome[] = [];
      const rejected: RejectedCheck[] = [...selection.rejected];
      for (const c of selection.valid) {
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
      const verb: Verb = checks.length > 0 && failing.length === 0 && rejected.length === 0 ? "ADOPT" : "ESCALATE";
      const why = verb === "ADOPT"
        ? `all ${checks.length} preconditions hold; candidate pending a judge`
        : [
          failing.length ? `${failing.length} of ${checks.length} preconditions fail: ${failing.join(", ")}` : "",
          rejected.length ? `${rejected.length} check(s) could not be bound from the finding or were refused by the guard` : "",
          checks.length === 0 && rejected.length === 0 ? "no precondition ran" : "",
        ].filter(Boolean).join("; ");
      tracer?.emit({
        agent: "decider", action: "decide", status: "ok", input_summary: `${cls} ${setting}`, output_summary: `${verb}: ${why}`,
        detail: "model: none; policy: every check holds -> ADOPT candidate, any fails or unbound -> ESCALATE, HOLD needs a judge",
      });
      tracer?.emit({ agent: "judge", action: "judge", status: "skipped", input_summary: summary.slice(0, 160), detail: "model: none (sample)" });
      findings.push({ finding, verb, world: { before: fbd.before, after: fbd.after, changed: fbd.changed, bytes_unchanged: bytesUnchanged }, checks, rejected, judge: "skipped" });
    }
  }
  return { runs: runs.length, gatedOut: [...gatedOut], observed, findings };
}
