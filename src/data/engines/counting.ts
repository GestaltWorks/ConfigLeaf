// Counting engine: an Engine that passes every call to the engine it wraps and keeps a tally of them. It keeps the
// inner engine's name and table naming, so the SQL it carries is the inner engine's SQL, character for character.
// Each run counts one query; a run that returns adds its rows (result.rowCount) and its latency (result.latencyMs);
// a run that throws counts one failure and its elapsed time, then rethrows the same error. The live cycle wraps
// ZetarisEngine in one (src/loop/live.ts), and the cycle's screen reads the tally: the Lightning SQL queries the
// pass sent, and those the cycle sent in all.
//
// Measured 25 Oct 2026: test/loop.test.ts counts runs that return and runs that throw over sql.js.

import type { QueryResult } from "../../adapters/zetaris.ts";
import type { Engine, RunOptions } from "../layer.ts";

/** What an engine carried: queries sent (failed ones included), rows returned, queries failed, milliseconds summed. */
export interface QueryTally { queries: number; rows: number; failed: number; ms: number }

export const NO_QUERIES: QueryTally = { queries: 0, rows: 0, failed: 0, ms: 0 };

/** The queries between two readings of one tally: `after` less `before`. */
export const tallySince = (before: QueryTally, after: QueryTally): QueryTally => ({
  queries: after.queries - before.queries, rows: after.rows - before.rows, failed: after.failed - before.failed, ms: after.ms - before.ms,
});

export class CountingEngine implements Engine {
  readonly name: Engine["name"];
  private t: QueryTally = { ...NO_QUERIES };

  constructor(readonly inner: Engine) {
    this.name = inner.name;
  }

  qualify(table: string): string {
    return this.inner.qualify(table);
  }

  async run(sql: string, opts?: RunOptions): Promise<QueryResult> {
    const t0 = Date.now();
    this.t.queries++;
    try {
      const r = await this.inner.run(sql, opts);
      this.t.rows += r.rowCount;
      this.t.ms += r.latencyMs;
      return r;
    } catch (err) {
      this.t.failed++;
      this.t.ms += Date.now() - t0;
      throw err;
    }
  }

  /** The tally so far, as a copy. */
  tally(): QueryTally {
    return { ...this.t };
  }
}
