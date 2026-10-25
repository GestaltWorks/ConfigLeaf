// What one collector pass hands to the store: the row types of src/data/rows.ts (one interface per table of
// sql/schema.sql, column for column) in the bundle's shape (keys = table names, arrays of row objects), so
// the same object loads into SqlJsEngine.loadBundle for a test and goes to Store for a live run. A type
// alias, not an interface, so it is assignable to the sql.js loader's Bundle. Timestamps are the canonical
// millisecond form both loaders enforce; nullable columns are `| null`, never undefined, so JSON round-trips
// keep every column. audit_event holds the host journal's rows (src/collectors/journal.ts), source journal.

export type {
  CollectionRun as CollectionRunRow,
  Observation as ObservationRow,
  BackupSnapshot as BackupSnapshotRow,
  BackupItem as BackupItemRow,
  InventoryAsset as InventoryAssetRow,
  AuditEvent as AuditEventRow,
} from "../data/rows.ts";
import type { AuditEvent, BackupItem, BackupSnapshot, CollectionRun, InventoryAsset, Observation } from "../data/rows.ts";

export type CollectedRows = {
  collection_run: CollectionRun[];
  observation: Observation[];
  inventory_asset: InventoryAsset[];
  backup_snapshot: BackupSnapshot[];
  backup_item: BackupItem[];
  audit_event: AuditEvent[];
};

export const EMPTY_ROWS = (): CollectedRows => ({ collection_run: [], observation: [], inventory_asset: [], backup_snapshot: [], backup_item: [], audit_event: [] });
