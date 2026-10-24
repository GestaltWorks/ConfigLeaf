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

export interface Rows {
  collection_run: CollectionRun;
  observation: Observation;
  approved_setting: ApprovedSetting;
  backup_snapshot: BackupSnapshot;
  backup_item: BackupItem;
  dns_record: DnsRecord;
  audit_event: AuditEvent;
  inventory_asset: InventoryAsset;
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
} as const satisfies { [K in TableName]: readonly (keyof Rows[K])[] };

/** Compile-time: an interface column missing from COLUMNS makes this `never` and the line below a type error. */
type Unlisted = { [K in TableName]: Exclude<keyof Rows[K], (typeof COLUMNS)[K][number]> }[TableName];
const _everyColumnListed: [Unlisted] extends [never] ? true : never = true;
void _everyColumnListed;

/**
 * Natural key per table: the primary key where the DDL has one; for dns_record and backup_item, which
 * have none, the tuple that is unique within a run or a snapshot. Store dedupes and checks idempotency on it.
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
} as const satisfies { [K in TableName]: readonly (keyof Rows[K])[] };

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

export const approvalId = (tenantId: string, host: string | null, objectId: string, settingPath: string, valueHash: string): string =>
  stableId("appr", tenantId, host, objectId, settingPath, valueHash);
