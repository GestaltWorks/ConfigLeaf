// The Microsoft 365 detector of the pass (src/pipeline.ts): the records Microsoft 365 requires for each verified
// domain's mail, the latest m365.dns run of a tenant (src/collectors/m365.ts), against what the DNS run of the same
// pass serves (data/queries.ts MAIL_RECORDS_SQL). Mail routing is one setting split across two systems, and this is
// where the two meet.
//
// Contract:
//   - latestMailRuns: the latest m365.dns run of each tenant, in the runs' order. A run that failed the DQ gate is
//     traced not_checked and raises nothing; so is one with no passing DNS run of the same pass (the pass's rule: the
//     nearest cloudflare.dns run within PASS_WINDOW_MS), because what Cloudflare serves is then not known.
//   - One finding per required record the DNS run's zones lack (missing) or serve otherwise (different), class
//     m365_mail_record, on the record's content row of the Microsoft 365 run: object_id <domain>/<TYPE>/<label>,
//     setting_path content, value_hash the required value's, refers_to and dns_name the record's name, resource_id
//     and resolves_to the first served record of the name and type (null when missing). Its line names the record,
//     the domain's pseudonym, what Microsoft 365 requires and what the zone serves; the policy's escalation opens
//     with it (src/policy/decide.ts NAMED_CLASSES). Its window is the tenant's audit reach (AUDIT_SPAN_SQL), else
//     the DNS run's start, to the later of the two runs.
//   - One detect line per run counts the domains, the required records, those of domains that are zones of the DNS
//     run, and of those the ones served as required, missing and different: the comparison's whole result, a match
//     included, so a pass where every record matches says so.
//
// Measured 26 Oct 2026 over test/fixtures/m365 (test/m365.test.ts): two domains compared, 6 required records, 2
// served as required, 1 missing (contoso's autodiscover CNAME) and 3 different (fabrikam's MX, its SPF without the
// include, its autodiscover CNAME proxied). test/parity.test.ts holds Zetaris to sql.js on MAIL_RECORDS_SQL.

import { M365_SURFACE } from "./collectors/m365.ts";
import type { FindingSummary } from "./catalogue/select.ts";
import type { DataLayer, RunOptions } from "./data/layer.ts";
import { AUDIT_SPAN_SQL, DOC_ZONES_SQL, mailRecordDrift, objects, observationsOf } from "./data/queries.ts";

type Row = Record<string, string>;

/** The run a tenant's mail records are compared from, whether it passed the gate, and the DNS run of its pass. */
export interface MailCheck { run: Row; gated: boolean; dns: Row | undefined }

/** The comparison's counts for one run, as its detect line says them. */
export interface MailTally { domains: number; records: number; inZones: number; matched: number; missing: number; different: number }

/** What the pass says, in one trace line, of the tenants with no Microsoft 365 run. */
export const MAIL_ABSENT = "the mail records Microsoft 365 requires are not compared (npm run collect:m365 reads them live)";
/** What sample mode says, in one line, when the recorded bundle holds no Microsoft 365 run. */
export const MAIL_NOT_RECORDED = "Microsoft 365 is not in the recorded bundle: npm run collect:m365 reads its mail records live";

/**
 * Every tenant of the runs, in tenant order: the findings of its latest m365.dns run against the DNS run of its pass
 * (`at` says whether that run passed the gate and which DNS run is of its pass). The tenants with no Microsoft 365
 * run are named in one skipped line for the pass, MAIL_ABSENT: Microsoft 365 is an optional source, absent until
 * npm run collect:m365 has run for the tenant.
 */
export async function mailRecords(layer: DataLayer, runs: readonly Row[], at: (run: Row) => Omit<MailCheck, "run">, opts: RunOptions = {}): Promise<FindingSummary[]> {
  const latest = new Map(latestMailRuns(runs).map((r) => [r.tenant_id, r]));
  const out: FindingSummary[] = [];
  const absent: string[] = [];
  for (const tenant of [...new Set(runs.map((r) => r.tenant_id))].sort()) {
    const run = latest.get(tenant);
    if (run) out.push(...await mailRecordFindings(layer, { run, ...at(run) }, opts));
    else absent.push(tenant);
  }
  if (absent.length) {
    opts.tracer?.emit({ agent: "detector", action: "detect", status: "skipped", input_summary: M365_SURFACE, output_summary: `${M365_SURFACE}: no Microsoft 365 run for ${absent.join(", ")}: ${MAIL_ABSENT}`, detail: "model: none" });
  }
  return out;
}

/** The latest m365.dns run of each tenant, in the order the runs came (oldest first). */
export function latestMailRuns(runs: readonly Row[]): Row[] {
  const latest = new Map<string, Row>();
  for (const r of runs) if (r.surface === M365_SURFACE) latest.set(r.tenant_id, r);
  return [...latest.values()];
}

/** <domain>/<TYPE>/<label> back into its parts; the label keeps any "#n" a second record of one key carries. */
export function mailObject(objectId: string): { domain: string; type: string; label: string } {
  const [domain, type, ...label] = objectId.split("/");
  return { domain, type, label: label.join("/") };
}

/** The record in words: the MX record, the SPF record, the autodiscover CNAME, the DKIM CNAME selector1._domainkey. */
export function recordWords(type: string, label: string): string {
  const at = label === "@" ? "" : ` ${label}`;
  if (type === "MX") return `the MX record${at}`;
  if (type === "TXT") return `the SPF record${at}`;
  if (/^selector\d+\._domainkey(?:#\d+)?$/.test(label)) return `the DKIM CNAME ${label}`;
  return label === "@" ? "the CNAME" : `the ${label} CNAME`;
}

const later = (a: string, b: string): string => (a > b ? a : b);
const shown = (s: Row): string => `${s.served.length > 120 ? `${s.served.slice(0, 117)}...` : s.served}${s.proxied === "1" ? " (proxied)" : ""}`;

/** The finding's one line from the rows MAIL_RECORDS_SQL gave for one required record. */
export function mailSummary(rows: readonly Row[]): string {
  const first = rows[0];
  const { type, label } = mailObject(first.object_id);
  const need = type === "TXT" ? `an SPF record carrying ${first.expected}` : `${type} ${first.expected}`;
  const head = `${recordWords(type, label)} of ${first.domain}`;
  return first.state === "missing"
    ? `${head} is missing from Cloudflare: Microsoft 365 requires ${need} at ${first.name}`
    : `${head} is different in Cloudflare: Microsoft 365 requires ${need} at ${first.name}, and the zone serves ${rows.map(shown).join(", ")}`;
}

/**
 * The findings of one tenant's latest Microsoft 365 run against the DNS run of its pass, with one detect line for the
 * comparison and one per finding. Nothing is written.
 */
export async function mailRecordFindings(layer: DataLayer, at: MailCheck, opts: RunOptions = {}): Promise<FindingSummary[]> {
  const { run, dns } = at;
  const tracer = opts.tracer;
  const where = `${M365_SURFACE} ${run.tenant_id}`;
  if (at.gated) {
    tracer?.emit({ agent: "detector", action: "detect", status: "not_checked", input_summary: where, output_summary: `latest run ${run.run_id} failed the DQ gate; the mail records Microsoft 365 requires are not checked this pass` });
    return [];
  }
  if (!dns) {
    tracer?.emit({ agent: "detector", action: "detect", status: "not_checked", input_summary: where, output_summary: `no DNS run of this pass passed the gate; what Cloudflare serves is not known, so ${run.run_id} is not checked` });
    return [];
  }
  const params = { tenant_id: run.tenant_id, run_id: run.run_id, dns_run_id: dns.run_id };
  const rows = objects(await mailRecordDrift(layer, params, opts));
  const obs = objects(await observationsOf(layer, run.run_id, opts));
  const zones = new Set(objects(await layer.run(DOC_ZONES_SQL, { tenant_id: run.tenant_id, dns_run_id: dns.run_id }, opts)).map((z) => z.zone));
  const domainOf = new Map(obs.filter((o) => o.setting_path === "domain").map((o) => [o.object_id, o.value_redacted]));
  const required = obs.filter((o) => o.setting_path === "content");
  const byRecord = new Map<string, Row[]>();
  for (const r of rows) byRecord.set(r.obs_id, [...(byRecord.get(r.obs_id) ?? []), r]);
  const groups = [...byRecord.values()];
  const missing = groups.filter((g) => g[0].state === "missing").length;
  const tally: MailTally = {
    domains: new Set(domainOf.values()).size, records: required.length,
    inZones: required.filter((o) => zones.has(domainOf.get(o.object_id) ?? "")).length, matched: 0, missing, different: groups.length - missing,
  };
  tally.matched = tally.inZones - groups.length;
  tracer?.emit({
    agent: "detector", action: "detect", status: "ok", input_summary: `m365_mail_record ${run.run_id} x ${dns.run_id}`,
    output_summary: `${M365_SURFACE}: ${tally.records} record(s) Microsoft 365 requires for ${tally.domains} domain(s), ${tally.inZones} in the zones of the DNS run: `
      + `${tally.matched} served as required, ${tally.missing} missing, ${tally.different} different`,
    detail: `${tally.records - tally.inZones} record(s) of domains outside the collected zones are not Cloudflare's to serve; model: none`,
  });
  if (!groups.length) return [];
  const span = objects(await layer.run(AUDIT_SPAN_SQL, { tenant_id: run.tenant_id }, opts))[0]?.first_at || "";
  const since = span || dns.started_at;
  return groups.map((g) => {
    const first = g[0];
    const summary = mailSummary(g);
    const served = first.state === "different" ? first : null;
    tracer?.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `${first.setting_path ?? "content"} of ${first.object_id}`, output_summary: `m365_mail_record: ${summary}`, detail: "model: none" });
    return {
      class: "m365_mail_record", tenant_id: run.tenant_id, run_id: run.run_id, surface: M365_SURFACE, host: null,
      object_id: first.object_id, setting_path: "content", value_hash: first.value_hash, value_redacted: first.expected || null,
      refers_to_type: "dns_name", refers_to_id: first.name, dns_name: first.name, resolves_to: served ? served.served : null, resource_id: served ? served.record_id : null,
      dns_run_id: dns.run_id, since: since < first.observed_at ? since : first.observed_at, until: later(later(run.started_at, dns.started_at), served?.dns_observed_at ?? ""), summary,
    };
  });
}
