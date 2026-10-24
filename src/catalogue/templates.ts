// The precondition catalogue. Nemotron Lightning never writes SQL: it picks template ids from this
// list and fills typed parameters; the DataLayer renders and runs them; the technician reads one
// sentence per check. Each template says whether returned rows mean the precondition HOLDS or FAILS,
// so the engine can turn a row count into a verdict without asking a model. Every template is in the
// portable subset (see data/layer.ts: lowercase identifiers, single-quoted literals, no casts, no date
// functions, timestamps compared as ISO text, one SELECT) and runs on sample/bundle.json in
// test/templates.test.ts. Hash detects, the model judges meaning; the check logic lives only here.

import { z } from "zod";
import type { QueryResult } from "../adapters/zetaris.ts";
import type { DataLayer, Params, RunOptions } from "../data/layer.ts";
import { RUN_COMPLETE_SQL } from "../data/queries.ts";

/**
 * The DNS-referent classes (found_but_different, dns_change) come from the hero query; the four survey
 * classes come from the estate queries in data/queries.ts over one pass: a proxied CNAME to a direct
 * apex (proxy_split), a proxied name served by a block that trusts no real_ip range
 * (proxied_without_real_ip), a record landing on a host with no enabled block for it (orphan_record)
 * and a server_name with no record and no covering wildcard (orphan_vhost). src/pipeline.ts raises
 * changed_since_backup (a file the host's newest backup lacks or holds with other bytes) and
 * drift_vs_approved (a setting whose live value differs from its latest approval) through the detectors
 * of data/queries.ts.
 */
export const FINDING_CLASSES = [
  "found_but_different", "changed_since_backup", "drift_vs_approved", "dns_change",
  "proxy_split", "proxied_without_real_ip", "orphan_record", "orphan_vhost",
] as const;
export type FindingClass = (typeof FINDING_CLASSES)[number];

export interface Template {
  id: string;
  /** One sentence the model and the technician both read. */
  purpose: string;
  appliesTo: FindingClass[];
  /** Every parameter the SQL names, typed. Unknown keys are stripped, missing ones are an error. */
  params: z.ZodObject;
  /** Tables as {{t:name}}, parameters as {{p:name}}; no comments (the guard refuses them). */
  sql: string;
  /** Whether rows coming back mean the precondition HOLDS or FAILS. */
  rowsMean: "holds" | "fails";
  /** One plain sentence for the technician, from the bound parameters and the row count. */
  explain: (params: Params, rowCount: number) => string;
}

export class CatalogueError extends Error {
  constructor(message: string, readonly code: "unknown_template" | "bad_params") {
    super(message);
  }
}

// Parameter shapes. Ids are opaque text. Timestamps are ISO 8601 UTC and are normalised to the
// millisecond form the collectors write, so '...00Z' and '...00.000Z' compare equal as text; the
// sql.js loader refuses any stored *_at value outside that form (engines/sqljs.ts), so a parameter and
// a row never fall on different sides of a window edge over a missing '.000'.
const id = () => z.string().min(1).max(512);
const iso = () => z.iso.datetime().transform((s) => new Date(s).toISOString());
const hash = () => z.string().regex(/^(sha256:)?[0-9a-f]{64}$/, "sha256 hex, optionally prefixed sha256:");

const s = (p: Params, k: string): string => String(p[k] ?? "");
const n = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

export const CATALOGUE: readonly Template[] = [
  {
    id: "host_in_inventory",
    purpose: "The address is a known asset in the client's inventory.",
    appliesTo: ["dns_change", "found_but_different", "proxied_without_real_ip", "orphan_record"],
    params: z.object({ tenant_id: id(), address: z.string().min(1).max(255) }),
    sql: `SELECT asset_id, host, address, kind, source, observed_at
FROM {{t:inventory_asset}}
WHERE tenant_id = {{p:tenant_id}} AND address = {{p:address}}
ORDER BY asset_id`,
    rowsMean: "holds",
    explain: (p, c) => c > 0
      ? `${s(p, "address")} is in the inventory (${n(c, "asset")}).`
      : `${s(p, "address")} is not in the inventory; nothing the client owns is recorded at that address.`,
  },
  {
    id: "dns_target_in_inventory",
    purpose: "Every address (A or AAAA record) the DNS name resolves to in the given DNS run is a known inventory asset; rows are the address records that resolve outside it.",
    appliesTo: ["found_but_different", "dns_change"],
    params: z.object({ tenant_id: id(), name: z.string().min(1).max(253), dns_run_id: id() }),
    sql: `SELECT d.record_id, d.name, d.type, d.content, d.observed_at
FROM {{t:dns_record}} d
LEFT JOIN {{t:inventory_asset}} i ON i.tenant_id = d.tenant_id AND i.address = d.content
WHERE d.tenant_id = {{p:tenant_id}} AND d.name = {{p:name}} AND d.run_id = {{p:dns_run_id}}
  AND d.type IN ('A', 'AAAA')
  AND i.asset_id IS NULL
ORDER BY d.record_id, d.content`,
    rowsMean: "fails",
    explain: (p, c) => c > 0
      ? `${s(p, "name")} resolves to ${n(c, "address")} the inventory does not know.`
      : `No record of ${s(p, "name")} in run ${s(p, "dns_run_id")} resolves outside the inventory.`,
  },
  {
    id: "change_in_last_backup",
    purpose: "The host's most recent backup already holds the live value of this setting; no rows also when the host has no backup at all (pair with backup_recent).",
    appliesTo: ["changed_since_backup", "drift_vs_approved"],
    params: z.object({ tenant_id: id(), host: id(), object_id: id(), setting_path: id(), value_hash: hash() }),
    sql: `SELECT s.snapshot_id, s.kind, s.taken_at, b.value_hash
FROM {{t:backup_snapshot}} s
JOIN {{t:backup_item}} b ON b.snapshot_id = s.snapshot_id
WHERE s.tenant_id = {{p:tenant_id}} AND s.host = {{p:host}}
  AND b.object_id = {{p:object_id}} AND b.setting_path = {{p:setting_path}} AND b.value_hash = {{p:value_hash}}
  AND NOT EXISTS (SELECT 1 FROM {{t:backup_snapshot}} x WHERE x.tenant_id = s.tenant_id AND x.host = s.host AND x.taken_at > s.taken_at)
ORDER BY s.snapshot_id`,
    rowsMean: "holds",
    explain: (p, c) => c > 0
      ? `The latest backup of ${s(p, "host")} already holds the live value of ${s(p, "object_id")} ${s(p, "setting_path")}.`
      : `The latest backup of ${s(p, "host")} does not hold the live value of ${s(p, "object_id")} ${s(p, "setting_path")}, so a restore would undo it.`,
  },
  {
    id: "actor_attributed",
    purpose: "An audit event with a named actor touched the resource inside the window.",
    appliesTo: ["dns_change", "found_but_different", "changed_since_backup", "drift_vs_approved", "proxy_split", "proxied_without_real_ip", "orphan_record"],
    params: z.object({ tenant_id: id(), resource_id: id(), since: iso(), until: iso() }),
    sql: `SELECT event_id, source, actor, action, old_value, new_value, occurred_at
FROM {{t:audit_event}}
WHERE tenant_id = {{p:tenant_id}} AND resource_id = {{p:resource_id}}
  AND occurred_at >= {{p:since}} AND occurred_at <= {{p:until}}
  AND actor IS NOT NULL AND actor <> ''
ORDER BY occurred_at, event_id`,
    rowsMean: "holds",
    explain: (p, c) => c > 0
      ? `${n(c, "audit event")} with a named actor touched ${s(p, "resource_id")} between ${s(p, "since")} and ${s(p, "until")}.`
      : `No audit event names who changed ${s(p, "resource_id")} between ${s(p, "since")} and ${s(p, "until")}.`,
  },
  {
    id: "previous_value_recoverable",
    purpose: "The value the resource had before its latest audit event is on record: either that event carries old_value, or an earlier create or update on the same resource carries the body that was in force (Cloudflare logs no old values; the previous state is the latest earlier body).",
    appliesTo: ["dns_change", "found_but_different", "drift_vs_approved", "proxy_split", "proxied_without_real_ip", "orphan_record"],
    params: z.object({ tenant_id: id(), resource_id: id() }),
    sql: `SELECT e.event_id, e.source, e.action, e.old_value AS previous_value, e.occurred_at AS recorded_at, 'old_value' AS evidence
FROM {{t:audit_event}} e
WHERE e.tenant_id = {{p:tenant_id}} AND e.resource_id = {{p:resource_id}}
  AND e.old_value IS NOT NULL AND e.old_value <> ''
  AND NOT EXISTS (SELECT 1 FROM {{t:audit_event}} x WHERE x.tenant_id = e.tenant_id AND x.resource_id = e.resource_id AND x.occurred_at > e.occurred_at)
UNION ALL
SELECT p.event_id, p.source, p.action, p.new_value AS previous_value, p.occurred_at AS recorded_at, 'earlier_event' AS evidence
FROM {{t:audit_event}} e
JOIN {{t:audit_event}} p ON p.tenant_id = e.tenant_id AND p.resource_id = e.resource_id AND p.occurred_at < e.occurred_at
  AND p.action IN ('create', 'update') AND p.new_value IS NOT NULL AND p.new_value <> ''
WHERE e.tenant_id = {{p:tenant_id}} AND e.resource_id = {{p:resource_id}}
  AND NOT EXISTS (SELECT 1 FROM {{t:audit_event}} x WHERE x.tenant_id = e.tenant_id AND x.resource_id = e.resource_id AND x.occurred_at > e.occurred_at)
  AND NOT EXISTS (SELECT 1 FROM {{t:audit_event}} y WHERE y.tenant_id = e.tenant_id AND y.resource_id = e.resource_id AND y.action IN ('create', 'update')
    AND y.new_value IS NOT NULL AND y.new_value <> '' AND y.occurred_at < e.occurred_at AND y.occurred_at > p.occurred_at)
ORDER BY evidence, event_id`,
    rowsMean: "holds",
    explain: (p, c) => c > 0
      ? `The audit log records the state ${s(p, "resource_id")} had before its latest change.`
      : `The audit log does not record what ${s(p, "resource_id")} was before its latest change.`,
  },
  {
    id: "restore_would_regress",
    purpose: "A restore from the host's latest backup would keep every approved setting; rows are approvals newer than that backup whose value the backup lacks or differs from.",
    appliesTo: ["drift_vs_approved", "changed_since_backup"],
    params: z.object({ tenant_id: id(), host: id() }),
    sql: `SELECT a.approval_id, a.object_id, a.setting_path, a.approved_at, a.approved_by,
       s.snapshot_id AS latest_snapshot_id, s.taken_at AS latest_backup_at,
       CASE WHEN b.value_hash IS NULL THEN 'absent' ELSE 'different' END AS backup_state
FROM {{t:approved_setting}} a
JOIN {{t:backup_snapshot}} s ON s.tenant_id = a.tenant_id AND s.host = a.host
LEFT JOIN {{t:backup_item}} b ON b.snapshot_id = s.snapshot_id AND b.object_id = a.object_id AND b.setting_path = a.setting_path
WHERE a.tenant_id = {{p:tenant_id}} AND a.host = {{p:host}}
  AND a.approved_at > s.taken_at
  AND (b.value_hash IS NULL OR b.value_hash <> a.value_hash)
  AND NOT EXISTS (SELECT 1 FROM {{t:backup_snapshot}} x WHERE x.tenant_id = s.tenant_id AND x.host = s.host AND x.taken_at > s.taken_at)
ORDER BY a.approved_at, a.approval_id`,
    rowsMean: "fails",
    explain: (p, c) => c > 0
      ? `Restoring ${s(p, "host")} from its latest backup would regress ${n(c, "approved setting")} approved after that backup was taken.`
      : `Restoring ${s(p, "host")} from its latest backup would regress no approved setting.`,
  },
  {
    id: "referent_unchanged",
    purpose: "Nothing the name resolves to changed inside the window; rows are the evidence of change, from consecutive DNS observations and from audit events on its records.",
    appliesTo: ["found_but_different", "dns_change", "proxy_split"],
    params: z.object({ tenant_id: id(), name: z.string().min(1).max(253), since: iso(), until: iso() }),
    sql: `SELECT 'dns_record' AS evidence, a.record_id AS resource_id, a.content AS old_value, b.content AS new_value, b.observed_at AS seen_at
FROM {{t:dns_record}} a
JOIN {{t:dns_record}} b ON b.tenant_id = a.tenant_id AND b.record_id = a.record_id AND b.observed_at > a.observed_at AND b.content <> a.content
WHERE a.tenant_id = {{p:tenant_id}} AND a.name = {{p:name}} AND b.name = {{p:name}}
  AND a.observed_at >= {{p:since}} AND b.observed_at <= {{p:until}}
  AND NOT EXISTS (SELECT 1 FROM {{t:dns_record}} m WHERE m.tenant_id = a.tenant_id AND m.record_id = a.record_id AND m.observed_at > a.observed_at AND m.observed_at < b.observed_at)
UNION ALL
SELECT 'audit_event' AS evidence, e.resource_id, e.old_value, e.new_value, e.occurred_at AS seen_at
FROM {{t:audit_event}} e
WHERE e.tenant_id = {{p:tenant_id}} AND e.occurred_at >= {{p:since}} AND e.occurred_at <= {{p:until}}
  AND e.resource_id IN (SELECT d.record_id FROM {{t:dns_record}} d WHERE d.tenant_id = {{p:tenant_id}} AND d.name = {{p:name}})
ORDER BY seen_at, evidence, resource_id`,
    rowsMean: "fails",
    explain: (p, c) => c > 0
      ? `${s(p, "name")} changed between ${s(p, "since")} and ${s(p, "until")} (${n(c, "piece")} of evidence).`
      : `Nothing recorded shows ${s(p, "name")} changing between ${s(p, "since")} and ${s(p, "until")}.`,
  },
  {
    id: "run_complete",
    purpose: "The collection run observed the whole population it asserted before collecting and finished complete; rows are the run failing that gate.",
    appliesTo: [...FINDING_CLASSES],
    params: z.object({ run_id: id() }),
    sql: RUN_COMPLETE_SQL,
    rowsMean: "fails",
    explain: (p, c) => c > 0
      ? `Run ${s(p, "run_id")} did not collect everything it set out to collect, so its observations are not a safe basis.`
      : `Run ${s(p, "run_id")} collected everything it set out to collect.`,
  },
  {
    id: "setting_matches_approved",
    purpose: "The setting's live value in the run equals an approved value for it (host-specific or tenant-wide).",
    appliesTo: ["drift_vs_approved", "changed_since_backup"],
    params: z.object({ tenant_id: id(), host: id(), object_id: id(), setting_path: id(), run_id: id() }),
    sql: `SELECT o.obs_id, o.value_hash, a.approval_id, a.approved_at, a.approved_by
FROM {{t:observation}} o
JOIN {{t:approved_setting}} a ON a.tenant_id = o.tenant_id AND a.object_id = o.object_id AND a.setting_path = o.setting_path
  AND a.value_hash = o.value_hash AND (a.host = o.host OR a.host IS NULL)
WHERE o.tenant_id = {{p:tenant_id}} AND o.host = {{p:host}} AND o.object_id = {{p:object_id}}
  AND o.setting_path = {{p:setting_path}} AND o.run_id = {{p:run_id}}
ORDER BY a.approved_at, a.approval_id`,
    rowsMean: "holds",
    explain: (p, c) => c > 0
      ? `${s(p, "object_id")} ${s(p, "setting_path")} on ${s(p, "host")} matches an approved value.`
      : `${s(p, "object_id")} ${s(p, "setting_path")} on ${s(p, "host")} matches no approved value.`,
  },
  {
    id: "other_settings_reference",
    purpose: "Blast radius: no other setting in the same collection run points at the same target; rows are the other settings that do.",
    appliesTo: ["found_but_different", "dns_change", "orphan_vhost"],
    params: z.object({ tenant_id: id(), refers_to_id: id(), run_id: id(), object_id: id(), setting_path: id() }),
    sql: `SELECT o.host, o.surface, o.object_id, o.setting_path, o.refers_to_type, o.observed_at
FROM {{t:observation}} o
WHERE o.tenant_id = {{p:tenant_id}} AND o.run_id = {{p:run_id}} AND o.refers_to_id = {{p:refers_to_id}}
  AND NOT (o.object_id = {{p:object_id}} AND o.setting_path = {{p:setting_path}})
ORDER BY o.object_id, o.setting_path`,
    rowsMean: "fails",
    explain: (p, c) => c > 0
      ? `${n(c, "other setting")} in run ${s(p, "run_id")} also point at ${s(p, "refers_to_id")}.`
      : `No other setting in run ${s(p, "run_id")} points at ${s(p, "refers_to_id")}.`,
  },
  {
    id: "record_reverted",
    purpose: "A later audit event put the resource back to the state an earlier event (at or after since) replaced: the change's old_value reappears as a later new_value, or, in a log without old values, a later create or update carries the body that was in force before the change.",
    appliesTo: ["dns_change", "found_but_different", "proxy_split"],
    params: z.object({ tenant_id: id(), resource_id: id(), since: iso() }),
    sql: `SELECT e1.event_id AS change_event_id, e1.occurred_at AS changed_at, e1.old_value AS previous_value, e1.new_value AS changed_value,
       e2.event_id AS revert_event_id, e2.actor AS reverted_by, e2.occurred_at AS reverted_at
FROM {{t:audit_event}} e1
JOIN {{t:audit_event}} e2 ON e2.tenant_id = e1.tenant_id AND e2.resource_id = e1.resource_id
  AND e2.occurred_at > e1.occurred_at AND e2.new_value = e1.old_value
WHERE e1.tenant_id = {{p:tenant_id}} AND e1.resource_id = {{p:resource_id}} AND e1.occurred_at >= {{p:since}}
  AND e1.old_value IS NOT NULL AND e1.old_value <> ''
UNION ALL
SELECT e2.event_id AS change_event_id, e2.occurred_at AS changed_at, e1.new_value AS previous_value, e2.new_value AS changed_value,
       e3.event_id AS revert_event_id, e3.actor AS reverted_by, e3.occurred_at AS reverted_at
FROM {{t:audit_event}} e1
JOIN {{t:audit_event}} e2 ON e2.tenant_id = e1.tenant_id AND e2.resource_id = e1.resource_id AND e2.occurred_at > e1.occurred_at
  AND e2.action IN ('create', 'update') AND e2.new_value IS NOT NULL AND e2.new_value <> '' AND e2.new_value <> e1.new_value
JOIN {{t:audit_event}} e3 ON e3.tenant_id = e2.tenant_id AND e3.resource_id = e2.resource_id AND e3.occurred_at > e2.occurred_at
  AND e3.action IN ('create', 'update') AND e3.new_value = e1.new_value
WHERE e1.tenant_id = {{p:tenant_id}} AND e1.resource_id = {{p:resource_id}} AND e2.occurred_at >= {{p:since}}
  AND e1.action IN ('create', 'update') AND e1.new_value IS NOT NULL AND e1.new_value <> ''
  AND NOT EXISTS (SELECT 1 FROM {{t:audit_event}} y WHERE y.tenant_id = e1.tenant_id AND y.resource_id = e1.resource_id AND y.action IN ('create', 'update')
    AND y.new_value IS NOT NULL AND y.new_value <> '' AND y.occurred_at > e1.occurred_at AND y.occurred_at < e2.occurred_at)
ORDER BY reverted_at, revert_event_id, change_event_id`,
    rowsMean: "holds",
    explain: (p, c) => c > 0
      ? `${s(p, "resource_id")} was put back to its earlier value after ${s(p, "since")}.`
      : `${s(p, "resource_id")} has not been put back since ${s(p, "since")}; the change is still live.`,
  },
  {
    id: "backup_recent",
    purpose: "A backup snapshot of the host exists taken at or after the given time; without one, changed-since-backup has no baseline.",
    appliesTo: ["changed_since_backup", "drift_vs_approved", "orphan_vhost"],
    params: z.object({ tenant_id: id(), host: id(), since: iso() }),
    sql: `SELECT snapshot_id, kind, taken_at, source_ref
FROM {{t:backup_snapshot}}
WHERE tenant_id = {{p:tenant_id}} AND host = {{p:host}} AND taken_at >= {{p:since}}
ORDER BY taken_at, snapshot_id`,
    rowsMean: "holds",
    explain: (p, c) => c > 0
      ? `${s(p, "host")} has ${n(c, "backup snapshot")} taken since ${s(p, "since")}.`
      : `${s(p, "host")} has no backup snapshot since ${s(p, "since")}.`,
  },
];

export const TEMPLATE_IDS: readonly string[] = CATALOGUE.map((t) => t.id);

export function templateById(id: string): Template | undefined {
  return CATALOGUE.find((t) => t.id === id);
}

/** The parameter names a template declares, in declaration order. */
export function paramNames(t: Template): string[] {
  return Object.keys(t.params.shape);
}

/** Validate raw parameters against the template's shape. Never throws; the reason is one line. */
export function validateParams(t: Template, raw: unknown): { ok: true; params: Params } | { ok: false; reason: string } {
  const r = t.params.safeParse(raw ?? {});
  if (r.success) return { ok: true, params: r.data as Params };
  const reason = r.error.issues.map((i) => `${i.path.map(String).join(".") || "params"}: ${i.message}`).join("; ");
  return { ok: false, reason };
}

/** Render one template for the layer's engine. Throws CatalogueError on an unknown id or bad params. */
export function renderTemplate(layer: DataLayer, id: string, rawParams: unknown): { template: Template; sql: string; params: Params } {
  const template = templateById(id);
  if (!template) throw new CatalogueError(`unknown template: ${id}`, "unknown_template");
  const v = validateParams(template, rawParams);
  if (!v.ok) throw new CatalogueError(`${id}: ${v.reason}`, "bad_params");
  return { template, sql: layer.render(template.sql, v.params), params: v.params };
}

export interface CheckResult {
  template: string;
  params: Params;
  /** Rows the engine counted (past any limit). */
  rowCount: number;
  /** The verdict: rows and rowsMean folded together. */
  holds: boolean;
  explanation: string;
  result: QueryResult;
}

/** Validate, render, guard and run one check; the layer's run() does the SELECT-only guard. */
export async function runCheck(layer: DataLayer, id: string, rawParams: unknown, opts: RunOptions = {}): Promise<CheckResult> {
  const { template, params } = renderTemplate(layer, id, rawParams);
  const result = await layer.run(template.sql, params, { agent: "check", ...opts });
  const rowCount = result.total;
  const holds = template.rowsMean === "holds" ? rowCount > 0 : rowCount === 0;
  return { template: template.id, params, rowCount, holds, explanation: template.explain(params, rowCount), result };
}
