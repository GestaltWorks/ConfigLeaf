// Row types, one interface per table of sql/schema.sql, column for column: TEXT is string, INTEGER is
// number, a column without NOT NULL is `| null`. The collectors build these and hand them to Store.
// COLUMNS lists each table's columns in DDL order and is checked both ways at compile time against the
// interfaces (below) and at test time against sql/schema.sql (test/store.test.ts), so the three cannot drift.
//
// Ids are deterministic: the same collection yields the same ids, so a re-run of an insert is a no-op
// (ON CONFLICT DO NOTHING) instead of a duplicate. stableId is the first 16 hex (64 bits) of sha256 over
// the parts joined by U+001F, which no part contains; a null part hashes as "".

import { createHash } from "node:crypto";

/** "running" is the state between Store.beginRun and Store.finishRun; the DQ gate fails anything but "complete". */
export type RunStatus = "running" | "complete" | "partial" | "failed";

export interface CollectionRun {
  run_id: string;
  tenant_id: string;
  surface: string; // linux.etc | linux.nginx | cloudflare.dns | cloudflare.audit | inventory
  host: string | null;
  started_at: string;
  finished_at: string | null;
  expected_count: number | null;
  observed_count: number | null;
  status: RunStatus;
}

export interface Observation {
  obs_id: string;
  run_id: string;
  tenant_id: string;
  surface: string;
  host: string | null;
  object_id: string;
  setting_path: string;
  value_hash: string;
  value_redacted: string | null;
  refers_to_type: string | null;
  refers_to_id: string | null;
  observed_at: string;
  source: string; // ssh | cloudflare | backup | approved
  authority: number; // AUTHORITY
}

export interface ApprovedSetting {
  approval_id: string;
  tenant_id: string;
  surface: string;
  host: string | null;
  object_id: string;
  setting_path: string;
  value_hash: string;
  approved_at: string;
  approved_by: string | null;
  note: string | null;
}

export interface BackupSnapshot {
  snapshot_id: string;
  tenant_id: string;
  host: string;
  kind: string; // restic | etckeeper
  taken_at: string;
  source_ref: string | null;
}

export interface BackupItem {
  snapshot_id: string;
  object_id: string;
  setting_path: string;
  value_hash: string;
}

export interface DnsRecord {
  record_id: string;
  run_id: string;
  tenant_id: string;
  zone: string;
  name: string;
  type: string;
  content: string;
  ttl: number | null;
  proxied: number | null; // 0/1
  observed_at: string;
}

export interface AuditEvent {
  event_id: string;
  tenant_id: string;
  source: string; // cloudflare | etckeeper | journal
  actor: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  old_value: string | null;
  new_value: string | null;
  occurred_at: string;
}

export interface InventoryAsset {
  asset_id: string;
  tenant_id: string;
  host: string | null;
  address: string;
  kind: string | null;
  source: string;
  observed_at: string;
}

export type Criticality = "critical" | "high" | "normal" | "low";
export type OnDrift = "rollback" | "investigate" | "adopt" | "hold";
export type OnNoCopy = "investigate_ticket" | "ticket" | "adopt";
export type Alert = "always" | "on_fix" | "never";
export type PsaPriority = "P1" | "P2" | "P3" | "P4";

/** One versioned rule of the MSP's policy (src/policy/). */
export interface PolicyRule {
  rule_id: string;
  tenant_id: string; // a tenant id | * (every tenant)
  surface: string; // linux.nginx | cloudflare.dns | *
  object_glob: string;
  setting_glob: string;
  criticality: Criticality;
  lock: number; // 0/1
  on_drift: OnDrift;
  on_no_copy: OnNoCopy;
  hold_max_hours: number;
  alert: Alert;
  psa_priority: PsaPriority;
  version: number;
  author: string;
  since: string;
  note: string | null;
}

export interface VaultCopy {
  copy_id: string;
  tenant_id: string;
  surface: string; // linux.nginx | cloudflare.dns
  host: string | null;
  object_id: string;
  run_id: string;
  git_commit: string;
  blob_sha256: string; // sha256:<64 hex> of the exact bytes
  taken_at: string;
  source: string; // collector
}

export type Validator = "nginx-t" | "cf-schema";
export type ValidationResult = "ok" | "ok_with_gaps" | "fail";

export interface CopyValidation {
  validation_id: string;
  copy_id: string;
  tenant_id: string;
  validator: Validator;
  result: ValidationResult;
  missing_dependencies: string; // newline-separated; "" when none
  output_redacted: string; // first 2000 characters; "" when none
  validated_at: string;
}

export type ProbeKind = "http" | "dns" | "tls";

export interface Probe {
  probe_id: string;
  run_id: string;
  tenant_id: string;
  kind: ProbeKind;
  target: string;
  expected: string;
  observed: string;
  status: "ok" | "fail";
  latency_ms: number | null;
  observed_at: string;
}

export type DispositionVerb = "ADOPT" | "HOLD" | "ESCALATE" | "ROLLBACK" | "FIX";
export type DecidedBy = "policy" | "operator" | "judge" | "default";

export interface Disposition {
  disposition_id: string;
  tenant_id: string;
  surface: string;
  host: string | null;
  object_id: string;
  setting_path: string;
  value_hash: string;
  verb: DispositionVerb;
  reason: string;
  expires_at: string | null; // set on every HOLD
  decided_by: DecidedBy;
  rule_id: string | null;
  finding_id: string;
  run_id: string;
  decided_at: string;
}

export interface Action {
  action_id: string;
  tenant_id: string;
  kind: "rollback_file" | "revert_record" | "fix" | "investigate";
  target: string;
  before_hash: string | null;
  after_hash: string | null;
  vault_commit: string | null;
  verification: string; // probe ids, comma-separated; "" when none
  receipts: string; // receipt ids, comma-separated; "" when none
  status: "done" | "failed" | "refused";
  started_at: string;
  finished_at: string | null;
  disposition_id: string;
}

export interface Ticket {
  ticket_id: string;
  tenant_id: string;
  psa: "github" | "halo" | "connectwise" | "autotask" | "jira";
  external_id: string | null;
  url: string | null;
  type: "change" | "incident";
  priority: PsaPriority;
  status: string;
  action_id: string | null;
  finding_id: string;
  created_at: string;
  updated_at: string;
}

export interface ReferentFingerprint {
  obs_id: string;
  dns_run_id: string;
  fingerprint: string; // sorted A and AAAA contents joined by ","; "" when the name has none
  resolved_at: string;
}

export interface Rows {
  collection_run: CollectionRun;
  observation: Observation;
  approved_setting: ApprovedSetting;
  backup_snapshot: BackupSnapshot;
  backup_item: BackupItem;
  dns_record: DnsRecord;
  audit_event: AuditEvent;
  inventory_asset: InventoryAsset;
  policy_rule: PolicyRule;
  vault_copy: VaultCopy;
  copy_validation: CopyValidation;
  probe: Probe;
  disposition: Disposition;
  action: Action;
  ticket: Ticket;
  referent_fingerprint: ReferentFingerprint;
}

export type TableName = keyof Rows;

export const COLUMNS = {
  collection_run: ["run_id", "tenant_id", "surface", "host", "started_at", "finished_at", "expected_count", "observed_count", "status"],
  observation: ["obs_id", "run_id", "tenant_id", "surface", "host", "object_id", "setting_path", "value_hash", "value_redacted", "refers_to_type", "refers_to_id", "observed_at", "source", "authority"],
  approved_setting: ["approval_id", "tenant_id", "surface", "host", "object_id", "setting_path", "value_hash", "approved_at", "approved_by", "note"],
  backup_snapshot: ["snapshot_id", "tenant_id", "host", "kind", "taken_at", "source_ref"],
  backup_item: ["snapshot_id", "object_id", "setting_path", "value_hash"],
  dns_record: ["record_id", "run_id", "tenant_id", "zone", "name", "type", "content", "ttl", "proxied", "observed_at"],
  audit_event: ["event_id", "tenant_id", "source", "actor", "action", "resource_type", "resource_id", "old_value", "new_value", "occurred_at"],
  inventory_asset: ["asset_id", "tenant_id", "host", "address", "kind", "source", "observed_at"],
  policy_rule: ["rule_id", "tenant_id", "surface", "object_glob", "setting_glob", "criticality", "lock", "on_drift", "on_no_copy", "hold_max_hours", "alert", "psa_priority", "version", "author", "since", "note"],
  vault_copy: ["copy_id", "tenant_id", "surface", "host", "object_id", "run_id", "git_commit", "blob_sha256", "taken_at", "source"],
  copy_validation: ["validation_id", "copy_id", "tenant_id", "validator", "result", "missing_dependencies", "output_redacted", "validated_at"],
  probe: ["probe_id", "run_id", "tenant_id", "kind", "target", "expected", "observed", "status", "latency_ms", "observed_at"],
  disposition: ["disposition_id", "tenant_id", "surface", "host", "object_id", "setting_path", "value_hash", "verb", "reason", "expires_at", "decided_by", "rule_id", "finding_id", "run_id", "decided_at"],
  action: ["action_id", "tenant_id", "kind", "target", "before_hash", "after_hash", "vault_commit", "verification", "receipts", "status", "started_at", "finished_at", "disposition_id"],
  ticket: ["ticket_id", "tenant_id", "psa", "external_id", "url", "type", "priority", "status", "action_id", "finding_id", "created_at", "updated_at"],
  referent_fingerprint: ["obs_id", "dns_run_id", "fingerprint", "resolved_at"],
} as const satisfies { [K in TableName]: readonly (keyof Rows[K])[] };

/** Compile-time: an interface column missing from COLUMNS makes this `never` and the line below a type error. */
type Unlisted = { [K in TableName]: Exclude<keyof Rows[K], (typeof COLUMNS)[K][number]> }[TableName];
const _everyColumnListed: [Unlisted] extends [never] ? true : never = true;
void _everyColumnListed;

/**
 * Natural key per table: the primary key where the DDL has one (referent_fingerprint's is the pair
 * obs_id, dns_run_id); for dns_record and backup_item, which have none, the tuple that is unique within a
 * run or a snapshot. Store and SqlJsEngine.insertRows dedupe and check idempotency on it.
 */
export const KEYS = {
  collection_run: ["run_id"],
  observation: ["obs_id"],
  approved_setting: ["approval_id"],
  backup_snapshot: ["snapshot_id"],
  backup_item: ["snapshot_id", "object_id", "setting_path"],
  dns_record: ["run_id", "record_id"],
  audit_event: ["event_id"],
  inventory_asset: ["asset_id"],
  policy_rule: ["rule_id"],
  vault_copy: ["copy_id"],
  copy_validation: ["validation_id"],
  probe: ["probe_id"],
  disposition: ["disposition_id"],
  action: ["action_id"],
  ticket: ["ticket_id"],
  referent_fingerprint: ["obs_id", "dns_run_id"],
} as const satisfies { [K in TableName]: readonly (keyof Rows[K])[] };

/** A timestamp column: every *_at, and policy_rule.since. Both loaders hold these to the canonical millisecond form. */
export const isTimestampColumn = (column: string): boolean => column.endsWith("_at") || column === "since";

/**
 * The columns that carry collected text, and how the Redactor reads each: "value" is one setting value
 * (Redactor.value: a bare token-shaped value is a secret), "text" a name, path or free text. Ids, keys,
 * hashes, enums, timestamps and setting paths are the agent's own vocabulary and are left alone: the
 * redactor reads a dotted tail outside its VOCAB as a host (server.return -> host-XXXXXX.return), and a
 * record id or restic id would turn into a secret under value(). Store and the bundle export both use it.
 */
export const REDACT = {
  collection_run: { host: "text" },
  observation: { host: "text", object_id: "text", value_redacted: "value", refers_to_id: "text" },
  approved_setting: { host: "text", object_id: "text", approved_by: "text", note: "text" },
  backup_snapshot: { host: "text" },
  backup_item: { object_id: "text" },
  dns_record: { zone: "text", name: "text", content: "value" },
  audit_event: { actor: "text", resource_id: "text", old_value: "value", new_value: "value" },
  inventory_asset: { host: "text", address: "text", source: "text" },
  policy_rule: { object_glob: "text", setting_glob: "text", author: "text", note: "text" },
  vault_copy: { host: "text", object_id: "text" },
  copy_validation: { missing_dependencies: "text", output_redacted: "text" },
  probe: { target: "text", expected: "text", observed: "text" },
  disposition: { host: "text", object_id: "text", reason: "text" },
  action: { target: "text" },
  ticket: { url: "text" },
  referent_fingerprint: {},
} as const satisfies { [K in TableName]: Partial<Record<keyof Rows[K], "text" | "value">> };

export const AUTHORITY = { live: 100, backup: 40, approved: 20 } as const;

export function stableId(prefix: string, ...parts: readonly (string | null)[]): string {
  const h = createHash("sha256").update(parts.map((p) => p ?? "").join("\u001f")).digest("hex");
  return `${prefix}-${h.slice(0, 16)}`;
}

/** One setting in one object in one run. The collector owes a setting_path unique within the object (server[1].listen[0]), or two settings share an id. */
export const obsId = (runId: string, objectId: string, settingPath: string): string => stableId("obs", runId, objectId, settingPath);

export const runId = (tenantId: string, surface: string, host: string | null, startedAt: string): string => stableId("run", tenantId, surface, host, startedAt);

/** The vendor's own event id (Cloudflare audit id, etckeeper commit), so overlapping audit pulls dedupe. */
export const eventId = (tenantId: string, source: string, vendorId: string): string => stableId("evt", tenantId, source, vendorId);

export const assetId = (tenantId: string, address: string): string => stableId("asset", tenantId, address);

export const snapshotId = (tenantId: string, host: string, kind: string, sourceRef: string): string => stableId("snap", tenantId, host, kind, sourceRef);

/** One sign-off of one value of one setting at one instant: a re-approval of an earlier value is a row of its own, the latest by approved_at. */
export const approvalId = (tenantId: string, host: string | null, objectId: string, settingPath: string, valueHash: string, approvedAt: string): string =>
  stableId("appr", tenantId, host, objectId, settingPath, valueHash, approvedAt);

/** One version of one policy family; the globs are the stored (redacted) text. */
export const ruleId = (tenantId: string, surface: string, objectGlob: string, settingGlob: string, version: number): string =>
  stableId("rule", tenantId, surface, objectGlob, settingGlob, String(version));

/** One object in one collection run the vault committed. */
export const copyId = (runId: string, objectId: string): string => stableId("copy", runId, objectId);

export const validationId = (copyIdValue: string, validator: string, validatedAt: string): string => stableId("val", copyIdValue, validator, validatedAt);

export const probeId = (runId: string, kind: string, target: string): string => stableId("probe", runId, kind, target);

/** One decision about one live value of one setting, for one finding, in one run. */
export const dispositionId = (
  tenantId: string, surface: string, host: string | null, objectId: string, settingPath: string, valueHash: string, findingId: string, runId: string,
): string => stableId("disp", tenantId, surface, host, objectId, settingPath, valueHash, findingId, runId);
