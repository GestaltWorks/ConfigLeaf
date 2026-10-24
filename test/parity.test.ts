// Engine parity. The sql.js half always runs. The Zetaris half runs only with PARITY_LIVE=true and a
// configured key, and expects the registered datasource to hold exactly the rows of sample/bundle.json;
// otherwise it is skipped (test.skipIf) and one line says so.
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { DataLayer, type Params } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { ZetarisEngine } from "../src/data/engines/zetaris.ts";
import { HERO_SQL, OBSERVATIONS_SQL, RESOLUTIONS_SQL, RUNS_SQL, RUN_COMPLETE_SQL } from "../src/data/queries.ts";
import { SCHEMA_TABLES } from "../src/data/schema.ts";
import { CATALOGUE } from "../src/catalogue/templates.ts";
import bundle from "../sample/bundle.json" with { type: "json" };
import { SAMPLE, SAMPLE_ROWS } from "./fixtures/catalogue-params.ts";

/** NOT NULL key columns per table, so ORDER BY is total and never depends on an engine's NULL ordering. */
const ORDER: Record<string, string> = {
  collection_run: "run_id",
  observation: "obs_id",
  approved_setting: "approval_id",
  backup_snapshot: "snapshot_id",
  backup_item: "snapshot_id, object_id, setting_path",
  dns_record: "run_id, record_id",
  audit_event: "event_id",
  inventory_asset: "asset_id",
};

interface Case { name: string; sql: string; params: Params; rows?: number }

const CASES: Case[] = [
  { name: "hero", sql: HERO_SQL, params: { tenant_id: "client-a", run_id: "run-nginx-7f1c-1023", dns_run_id: "run-dns-1023" }, rows: 1 },
  { name: "runComplete (partial run)", sql: RUN_COMPLETE_SQL, params: { run_id: "run-nginx-2b9e-1023" }, rows: 1 },
  { name: "runComplete (complete run)", sql: RUN_COMPLETE_SQL, params: { run_id: "run-dns-1023" }, rows: 0 },
  { name: "runs", sql: RUNS_SQL, params: {}, rows: bundle.collection_run.length },
  { name: "observations of a run", sql: OBSERVATIONS_SQL, params: { run_id: "run-nginx-7f1c-1023" }, rows: 2 },
  { name: "resolutions", sql: RESOLUTIONS_SQL, params: { run_id: "run-nginx-7f1c-1023", dns_run_id: "run-dns-1023" }, rows: 1 },
  ...CATALOGUE.map((t) => ({ name: `template ${t.id}`, sql: t.sql, params: SAMPLE[t.id], rows: SAMPLE_ROWS[t.id] })),
  ...SCHEMA_TABLES.map((t) => ({
    name: `table ${t.name}`,
    sql: `SELECT ${t.columns.join(", ")} FROM {{t:${t.name}}} ORDER BY ${ORDER[t.name]}`,
    params: {},
    rows: (bundle as unknown as Record<string, unknown[]>)[t.name].length,
  })),
];

const live = process.env.PARITY_LIVE === "true" && config.zetaris.apiKey !== "";
if (!live) console.log("parity: live Zetaris half skipped (set PARITY_LIVE=true and ZETARIS_API_KEY to run it)");

describe("engine parity", () => {
  let sqljs: DataLayer;
  const zetaris = live ? new DataLayer(new ZetarisEngine()) : undefined;

  beforeAll(async () => {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(bundle);
    sqljs = new DataLayer(engine);
  });

  for (const c of CASES) {
    it(`sqljs: ${c.name}`, async () => {
      const r = await sqljs.run(c.sql, c.params);
      expect(r.columns.length).toBeGreaterThan(0);
      expect(r.rows.every((row) => row.length === r.columns.length && row.every((v) => typeof v === "string"))).toBe(true);
      if (c.rows !== undefined) expect(r.rowCount).toBe(c.rows);
    });

    it.skipIf(!live)(`zetaris = sqljs: ${c.name}`, async () => {
      const [a, b] = await Promise.all([sqljs.run(c.sql, c.params), zetaris!.run(c.sql, c.params, { agent: "parity" })]);
      expect(b.columns).toEqual(a.columns);
      expect(b.rows).toEqual(a.rows);
      expect(b.total).toBe(a.total);
    });
  }
});
