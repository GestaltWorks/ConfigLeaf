// The ledger: where the Decider's dispositions are written, one row per finding per pass (sql/schema.sql
// disposition). One interface, two backings: PgLedger writes through the Store into the app Postgres the
// live pass reads through Zetaris; MemoryLedger writes into the sql.js engine of a sample pass or a test,
// where the DataLayer reads it back as {{t:disposition}}.
//
// Contract: record() returns the rows written. Both backings are idempotent on disposition_id (rows.ts
// dispositionId over tenant, surface, host, object, setting, live value, finding, run and decided_at): recording
// the same pass twice writes 0 rows the second time, and a pass at another instant writes rows of its own; two
// different rows under one id are refused. The Store
// passes host, object_id and reason through the redactor; the sql.js backing stores what it is given.

import type { SqlJsEngine } from "./data/engines/sqljs.ts";
import type { Disposition, ReferentFingerprint } from "./data/rows.ts";
import type { Store } from "./data/store.ts";

export interface Ledger {
  record(rows: readonly Disposition[]): Promise<number>;
  /** The pass's referent_fingerprint rows (src/data/fingerprint.ts); idempotent on (obs_id, dns_run_id), returns the rows written. */
  recordFingerprints(rows: readonly ReferentFingerprint[]): Promise<number>;
}

/** The app Postgres, through the Store (ON CONFLICT (disposition_id) DO NOTHING). */
export class PgLedger implements Ledger {
  constructor(private readonly store: Store) {}

  record(rows: readonly Disposition[]): Promise<number> {
    return this.store.insertDispositions(rows);
  }

  recordFingerprints(rows: readonly ReferentFingerprint[]): Promise<number> {
    return this.store.insertReferentFingerprints(rows);
  }
}

/** The sql.js engine of the pass (SqlJsEngine.insertRows). */
export class MemoryLedger implements Ledger {
  constructor(private readonly engine: SqlJsEngine) {}

  async record(rows: readonly Disposition[]): Promise<number> {
    return this.engine.insertRows("disposition", rows);
  }

  async recordFingerprints(rows: readonly ReferentFingerprint[]): Promise<number> {
    return this.engine.insertRows("referent_fingerprint", rows);
  }
}
