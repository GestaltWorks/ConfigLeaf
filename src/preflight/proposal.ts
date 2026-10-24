// A proposed change, typed. A technician (or a model, in live mode) says what they are about to do;
// the pre-flight binds it to one row of the latest passing run or rejects it, and the rejection is
// counted (the eval reads `invalid`). Nothing here reads a model: a proposal that does not parse or
// does not bind is a measurement, not a guess.
//
//   dns_record      one Cloudflare record, by record_id or by name + type, in the tenant's latest
//                   passing cloudflare.dns run; field proxied (0/1) or content (a name or address)
//   vhost_real_ip   one nginx object (a vhost file, or nginx.conf for the http level) on one host, in
//                   that host's latest passing linux.nginx run; field real_ip, to the collector's shape
//                   trusted:<n> header:<h> scope:<server|http>, or a bare range count, or absent

import { z } from "zod";
import type { DataLayer, RunOptions } from "../data/layer.ts";
import { objects } from "../data/queries.ts";
import { CLOUDFLARE_IPV4_RANGES, REAL_IP_VALUE, realIpRows, realIpValue } from "./overlay.ts";

const text = (max: number) => z.string().min(1).max(max);

export const ProposedChange = z.object({
  kind: z.enum(["dns_record", "vhost_real_ip"]),
  target: z.object({
    record_id: text(64).optional(),
    name: text(253).optional(),
    type: text(16).optional(),
    host: text(253).optional(),
    object_id: text(512).optional(),
  }),
  field: z.enum(["proxied", "content", "real_ip"]),
  to: z.union([z.string().max(1024), z.number()]),
  /** When the technician means to make the change; carried into the verdict, not used by the simulation, which runs over the world as last collected. */
  when: z.iso.datetime().optional(),
  note: z.string().max(1000).optional(),
}).superRefine((p, ctx) => {
  const add = (message: string, path: string[] = []) => ctx.addIssue({ code: "custom", message, path });
  if (p.kind === "dns_record") {
    if (p.field === "real_ip") add("a dns_record change sets proxied or content", ["field"]);
    if (!p.target.record_id && !(p.target.name && p.target.type)) add("a dns_record target is a record_id, or a name and a type", ["target"]);
    if (p.field === "proxied" && !["0", "1"].includes(String(p.to))) add("proxied is 0 or 1", ["to"]);
    if (p.field === "content" && (typeof p.to !== "string" || !p.to.trim())) add("content is a non-empty string", ["to"]);
  } else {
    if (p.field !== "real_ip") add("a vhost_real_ip change sets real_ip", ["field"]);
    if (!p.target.host || !p.target.object_id) add("a vhost_real_ip target is a host and an object_id", ["target"]);
    if (typeof p.to === "string" ? !(REAL_IP_VALUE.test(p.to) || p.to === "absent") : !(Number.isInteger(p.to) && p.to >= 0 && p.to <= 999)) {
      add("real_ip is trusted:<n> header:<h> scope:<server|http>, absent, or a range count", ["to"]);
    }
  }
});
export type ProposedChange = z.infer<typeof ProposedChange>;

export type Parsed = { ok: true; proposal: ProposedChange } | { ok: false; reason: string };

/** Never throws; the reason is one line a trace can carry. */
export function parseProposal(raw: unknown): Parsed {
  const r = ProposedChange.safeParse(raw);
  if (r.success) return { ok: true, proposal: r.data };
  return { ok: false, reason: r.error.issues.map((i) => `${i.path.map(String).join(".") || "proposal"}: ${i.message}`).join("; ") };
}

type Row = Record<string, string>;

export type Bound =
  | { kind: "dns_record"; tenant_id: string; run_id: string; record: Row; field: "proxied" | "content"; from: string; to: string | number }
  | { kind: "vhost_real_ip"; tenant_id: string; run_id: string; host: string; object_id: string; rows: Row[]; to: string };

export type Binding = { ok: true; bound: Bound } | { ok: false; reason: string; /** True when the proposal itself is at fault (counted); false when the world cannot be simulated (a gated run). */ invalid: boolean };

const BY_ID_SQL = `SELECT record_id, run_id, tenant_id, zone, name, type, content, ttl, proxied, observed_at
FROM {{t:dns_record}}
WHERE run_id = {{p:run_id}} AND record_id = {{p:record_id}}
ORDER BY record_id`;

const BY_NAME_SQL = `SELECT record_id, run_id, tenant_id, zone, name, type, content, ttl, proxied, observed_at
FROM {{t:dns_record}}
WHERE run_id = {{p:run_id}} AND name = {{p:name}} AND type = {{p:type}}
ORDER BY record_id`;

/** The latest run per tenant (or per host) of a surface, and whether it passed the gate. */
function latestRuns(runs: Row[], gatedOut: ReadonlySet<string>, surface: string, host?: string): { passing: Row[]; gated: Row[] } {
  const latest = new Map<string, Row>();
  for (const r of runs) if (r.surface === surface && (host === undefined || r.host === host)) latest.set(`${r.tenant_id}|${r.host}`, r);
  const all = [...latest.values()];
  return { passing: all.filter((r) => !gatedOut.has(r.run_id)), gated: all.filter((r) => gatedOut.has(r.run_id)) };
}

/**
 * Bind a parsed proposal to one row (dns_record) or one object (vhost_real_ip) of the latest passing
 * run. `runs` and `gatedOut` come from the baseline pass, so the gate is applied once. Exactly one
 * match binds; none or several is invalid; a latest run that failed the gate cannot be simulated against.
 */
export async function bindProposal(layer: DataLayer, p: ProposedChange, runs: Row[], gatedOut: ReadonlySet<string>, opts: RunOptions = {}): Promise<Binding> {
  if (p.kind === "dns_record") {
    const { passing, gated } = latestRuns(runs, gatedOut, "cloudflare.dns");
    if (!passing.length) {
      return { ok: false, invalid: false, reason: gated.length ? `the latest cloudflare.dns run (${gated.map((r) => r.run_id).join(", ")}) failed the DQ gate; nothing to simulate against` : "no cloudflare.dns run to simulate against" };
    }
    const matches: Row[] = [];
    for (const run of passing) {
      const rows = p.target.record_id
        ? objects(await layer.run(BY_ID_SQL, { run_id: run.run_id, record_id: p.target.record_id }, opts))
        : objects(await layer.run(BY_NAME_SQL, { run_id: run.run_id, name: p.target.name!, type: p.target.type! }, opts));
      matches.push(...rows);
    }
    const what = p.target.record_id ? `record_id ${p.target.record_id}` : `${p.target.type} record named ${p.target.name}`;
    if (matches.length === 0) return { ok: false, invalid: true, reason: `no dns_record with ${what} in the latest passing DNS run (${passing.map((r) => r.run_id).join(", ")})` };
    if (matches.length > 1) return { ok: false, invalid: true, reason: `${matches.length} dns_record rows match ${what} in the latest passing DNS run; a proposal binds to one` };
    const record = matches[0];
    const field = p.field as "proxied" | "content";
    const to = field === "proxied" ? Number(p.to) : String(p.to);
    return { ok: true, bound: { kind: "dns_record", tenant_id: record.tenant_id, run_id: record.run_id, record, field, from: record[field], to } };
  }

  const host = p.target.host!;
  const { passing, gated } = latestRuns(runs, gatedOut, "linux.nginx", host);
  if (!passing.length) {
    if (gated.length) return { ok: false, invalid: false, reason: `the latest linux.nginx run of ${host} (${gated.map((r) => r.run_id).join(", ")}) failed the DQ gate; nothing to simulate against` };
    return { ok: false, invalid: true, reason: `no linux.nginx run for host ${host}` };
  }
  if (passing.length > 1) return { ok: false, invalid: true, reason: `${passing.length} tenants have a host named ${host}; a proposal binds to one` };
  const run = passing[0];
  const rows = await realIpRows(layer, { run_id: run.run_id, host, object_id: p.target.object_id! }, opts);
  if (!rows.length) return { ok: false, invalid: true, reason: `no real_ip observation of ${p.target.object_id} on ${host} in run ${run.run_id}` };
  const scope: "server" | "http" = rows.every((r) => r.setting_path === "http.real_ip") ? "http" : "server";
  const to = typeof p.to === "number" ? realIpValue(p.to, scope) : p.to;
  return { ok: true, bound: { kind: "vhost_real_ip", tenant_id: run.tenant_id, run_id: run.run_id, host, object_id: p.target.object_id!, rows, to } };
}

/** The bare range count a proposal may give in place of the full value. */
export const DEFAULT_RANGES = CLOUDFLARE_IPV4_RANGES;

/** One line naming what a bound proposal changes, from -> to, for the trace and the verdict. */
export function describeBound(b: Bound): string {
  if (b.kind === "dns_record") {
    return `${b.field} of dns_record ${b.record.record_id} (${b.record.name}, ${b.record.type}, zone ${b.record.zone}) in run ${b.run_id}: ${b.from === "" ? "NULL" : b.from} -> ${b.to}`;
  }
  return `real_ip of ${b.object_id} on ${b.host} in run ${b.run_id}: ${b.rows.map((r) => `${r.setting_path} ${r.value_redacted || "NULL"}`).join(", ")} -> ${b.to}`;
}
