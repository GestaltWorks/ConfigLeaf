// Engine parity. The sql.js half always runs. The Zetaris half runs only with PARITY_LIVE=true and a
// configured key, and expects the registered datasource to hold exactly the rows of sample/bundle.json
// (what `npm run export:bundle` wrote from it); otherwise it is skipped (test.skipIf) and one line says so.
// Measured live 24 Oct 2026 on 2.4.3.1 after the first real collection: every case equal, columns, rows
// and totals, the survey queries' instr/substr/length/COALESCE included.
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { DataLayer, type Params } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { ZetarisEngine } from "../src/data/engines/zetaris.ts";
import {
  AUDIT_SPAN_SQL, HERO_SQL, OBSERVATIONS_SQL, ORPHAN_RECORD_SQL, ORPHAN_VHOST_SQL, PROXIED_WITHOUT_REAL_IP_SQL, PROXY_SPLIT_SQL,
  RESOLUTIONS_SQL, RUNS_SQL, RUN_COMPLETE_SQL, WILDCARD_WITHOUT_REAL_IP_SQL,
} from "../src/data/queries.ts";
import { SCHEMA_TABLES } from "../src/data/schema.ts";
import { CATALOGUE } from "../src/catalogue/templates.ts";
import bundle from "../sample/bundle.json" with { type: "json" };
import { DNS_RUN, CONFD_RUN, SITES_RUN, SAMPLE, SAMPLE_ROWS, T } from "./fixtures/catalogue-params.ts";

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

/**
 * The export nulls value_redacted over 2 kB (store.ts VALUE_MAX_BYTES) while the datasource keeps the
 * text, so the observation table case leaves that column out and a second case compares it on every row
 * that is not a file body (the 30 nulled rows are all `file` rows). Not `WHERE length(value_redacted) <=
 * 2048`: measured 24 Oct, a function inside a top-level WHERE on a DRIFT table is dropped at pushdown and
 * every row comes back (`WHERE length(value_redacted) > 2048` counted all 1068); the catalogue's top-level
 * predicates are plain column comparisons, and its substr/instr sit in JOIN ON and correlated subqueries,
 * which this test shows evaluate alike.
 */
const columnsOf = (t: { name: string; columns: string[] }): string =>
  t.columns.filter((c) => !(t.name === "observation" && c === "value_redacted")).join(", ");

interface Case { name: string; sql: string; params: Params; rows?: number; /** Applied to both engines' rows before they are compared. */ mask?: (row: string[], columns: string[]) => string[] }

const confd = { tenant_id: T, run_id: CONFD_RUN, dns_run_id: DNS_RUN };
const sites = { tenant_id: T, run_id: SITES_RUN, dns_run_id: DNS_RUN };

/** The file bodies the export nulled over 2 kB stay in the datasource: blank value_redacted on `file` rows on both sides, compare everything else. */
const noFileBodies = (row: string[], columns: string[]): string[] => {
  const sp = columns.indexOf("setting_path");
  const vr = columns.indexOf("value_redacted");
  return sp >= 0 && vr >= 0 && row[sp] === "file" ? row.map((v, i) => (i === vr ? "" : v)) : row;
};

const CASES: Case[] = [
  { name: "hero (confd host)", sql: HERO_SQL, params: confd, rows: 0 },
  { name: "hero (sites host)", sql: HERO_SQL, params: sites, rows: 0 },
  { name: "runComplete (complete host run)", sql: RUN_COMPLETE_SQL, params: { run_id: CONFD_RUN }, rows: 0 },
  { name: "runComplete (complete DNS run)", sql: RUN_COMPLETE_SQL, params: { run_id: DNS_RUN }, rows: 0 },
  { name: "runs", sql: RUNS_SQL, params: {}, rows: bundle.collection_run.length },
  { name: "observations of a run", sql: OBSERVATIONS_SQL, params: { run_id: SITES_RUN }, rows: bundle.observation.filter((o) => o.run_id === SITES_RUN).length, mask: noFileBodies },
  { name: "resolutions", sql: RESOLUTIONS_SQL, params: { run_id: SITES_RUN, dns_run_id: DNS_RUN } },
  { name: "proxy_split", sql: PROXY_SPLIT_SQL, params: { tenant_id: T, dns_run_id: DNS_RUN }, rows: 1 },
  { name: "proxied_without_real_ip (confd)", sql: PROXIED_WITHOUT_REAL_IP_SQL, params: confd, rows: 10 },
  { name: "proxied_without_real_ip (sites)", sql: PROXIED_WITHOUT_REAL_IP_SQL, params: sites, rows: 9 },
  { name: "wildcard_without_real_ip (confd)", sql: WILDCARD_WITHOUT_REAL_IP_SQL, params: confd, rows: 1 },
  { name: "wildcard_without_real_ip (sites)", sql: WILDCARD_WITHOUT_REAL_IP_SQL, params: sites, rows: 0 },
  { name: "orphan_record (confd)", sql: ORPHAN_RECORD_SQL, params: confd, rows: 1 },
  { name: "orphan_record (sites)", sql: ORPHAN_RECORD_SQL, params: sites, rows: 2 },
  { name: "orphan_vhost (confd)", sql: ORPHAN_VHOST_SQL, params: confd, rows: 0 },
  { name: "orphan_vhost (sites)", sql: ORPHAN_VHOST_SQL, params: sites, rows: 3 },
  { name: "audit span", sql: AUDIT_SPAN_SQL, params: { tenant_id: T }, rows: 1 },
  { name: "observation values (every row but the file bodies)", sql: "SELECT obs_id, value_redacted FROM {{t:observation}} WHERE setting_path <> 'file' ORDER BY obs_id", params: {}, rows: bundle.observation.filter((o) => o.setting_path !== "file").length },
  ...CATALOGUE.map((t) => ({ name: `template ${t.id}`, sql: t.sql, params: SAMPLE[t.id], rows: SAMPLE_ROWS[t.id] })),
  ...SCHEMA_TABLES.map((t) => ({
    name: `table ${t.name}`,
    sql: `SELECT ${columnsOf(t)} FROM {{t:${t.name}}} ORDER BY ${ORDER[t.name]}`,
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
      const r = await sqljs.run(c.sql, c.params, { limit: 2000 });
      expect(r.columns.length).toBeGreaterThan(0);
      expect(r.rows.every((row) => row.length === r.columns.length && row.every((v) => typeof v === "string"))).toBe(true);
      if (c.rows !== undefined) expect(r.rowCount).toBe(c.rows);
    });

    it.skipIf(!live)(`zetaris = sqljs: ${c.name}`, { timeout: 60_000 }, async () => {
      const [a, b] = await Promise.all([sqljs.run(c.sql, c.params, { limit: 2000 }), zetaris!.run(c.sql, c.params, { agent: "parity", limit: 2000 })]);
      expect(b.columns).toEqual(a.columns);
      const mask = c.mask ?? ((row: string[]) => row);
      expect(b.rows.map((r) => mask(r, b.columns))).toEqual(a.rows.map((r) => mask(r, a.columns)));
      expect(b.total).toBe(a.total);
    });
  }
});
