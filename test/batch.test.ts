// The observe step's set-based reads (src/data/batch.ts) against the per-run reads they replace (OBSERVATIONS_SQL,
// RESOLUTIONS_SQL): over the sample bundle and the recorded fixture every host run's observations and resolutions come back
// row for row and in the same order, at the default page and at pages small enough to cut every read many times; the SQL
// holds no OR; and the World Model's bulk ingest is idempotent. The pass over the same bundles decides as before at
// concurrency 1 and 4 (test/concurrency.test.ts, test/pipeline.test.ts).
import { describe, expect, it } from "vitest";
import { SURFACE_OBSERVATIONS_SQL, batchResolutions, batchResolutionsSql, surfaceObservations } from "../src/data/batch.ts";
import { DataLayer, type Engine } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { listRuns, objects, observationsOf, resolutions } from "../src/data/queries.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { nearestRun } from "../src/pipeline.ts";
import recorded from "./fixtures/recorded-bundle.json" with { type: "json" };
import sample from "../sample/bundle.json" with { type: "json" };

type Row = Record<string, string>;

async function open(bundle: Readonly<Record<string, unknown>>) {
  const sql = await SqlJsEngine.create();
  sql.loadBundle(bundle);
  let queries = 0;
  const counted: Engine = { name: sql.name, qualify: (t) => sql.qualify(t), run: (s, o) => { queries++; return sql.run(s, o); } };
  const layer = new DataLayer(counted);
  const runs = objects(await listRuns(layer));
  return { sql, layer, runs, hostRuns: runs.filter((r) => r.host !== ""), queries: () => queries };
}

/** The per-run reads the observe step made before: each host run's observations, and its resolutions in its nearest DNS run. */
async function perRun(layer: DataLayer, runs: Row[], hostRuns: Row[]) {
  const obs = new Map<string, Row[]>();
  const res = new Map<string, Row[]>();
  for (const r of hostRuns) {
    obs.set(r.run_id, objects(await observationsOf(layer, r.run_id, { limit: 100_000 })));
    const dns = nearestRun(runs, r, "cloudflare.dns");
    if (dns) res.set(r.run_id, objects(await resolutions(layer, { run_id: r.run_id, dns_run_id: dns.run_id }, { limit: 100_000 })));
  }
  return { obs, res };
}

/** The same through the batched reads: one read per tenant and surface, one per DNS run, at `page` rows a page. */
async function batched(layer: DataLayer, runs: Row[], hostRuns: Row[], page?: number) {
  const obs = new Map<string, Row[]>();
  for (const key of new Set(hostRuns.map((r) => `${r.tenant_id}\u001f${r.surface}`))) {
    const [tenant, surface] = key.split("\u001f");
    for (const [run, rows] of await surfaceObservations(layer, tenant, surface, {}, page)) obs.set(run, rows);
  }
  const byDns = new Map<string, string[]>();
  for (const r of hostRuns) {
    const dns = nearestRun(runs, r, "cloudflare.dns");
    if (dns) byDns.set(dns.run_id, [...(byDns.get(dns.run_id) ?? []), r.run_id]);
  }
  const res = new Map<string, Row[]>();
  for (const [dns, ids] of byDns) for (const [run, rows] of await batchResolutions(layer, ids, dns, {}, page)) res.set(run, rows);
  return { obs, res };
}

describe("the observe step's batched reads return what the per-run reads returned", () => {
  for (const [name, bundle] of [["sample/bundle.json", sample], ["the recorded fixture", recorded]] as const) {
    it(`over ${name}, every host run's observations and resolutions, row for row, in the same order`, async () => {
      const db = await open(bundle);
      const want = await perRun(db.layer, db.runs, db.hostRuns);
      const before = db.queries();
      const got = await batched(db.layer, db.runs, db.hostRuns);
      // one read per tenant and surface plus one per DNS run, where the per-run reads made two per host run
      expect(db.queries() - before).toBeLessThan(2 * db.hostRuns.length);
      for (const r of db.hostRuns) {
        expect(got.obs.get(r.run_id) ?? []).toEqual(want.obs.get(r.run_id));
        expect(got.res.get(r.run_id)).toEqual(want.res.get(r.run_id));
      }
      expect([...got.obs.values()].flat().length).toBeGreaterThan(1000);
      db.sql.close();
    });
  }

  it("at pages small enough to cut every read many times: the same rows, an obs_id's resolutions never split across two pages", async () => {
    const db = await open(recorded);
    const want = await perRun(db.layer, db.runs, db.hostRuns);
    // the most resolution rows one dns_name observation has, plus one: every page boundary falls inside a run
    const groups = [...want.res.values()].flat().reduce((m, x) => m.set(x.obs_id, (m.get(x.obs_id) ?? 0) + 1), new Map<string, number>());
    const page = Math.max(...groups.values()) + 1;
    const before = db.queries();
    const got = await batched(db.layer, db.runs, db.hostRuns, page);
    expect(db.queries() - before).toBeGreaterThan(100);
    for (const r of db.hostRuns) {
      expect(got.obs.get(r.run_id) ?? []).toEqual(want.obs.get(r.run_id));
      expect(got.res.get(r.run_id)).toEqual(want.res.get(r.run_id));
    }
    // a page that cannot hold one obs_id's rows is refused rather than cut through it
    const big = [...groups].find(([, n]) => n > 1);
    if (big) {
      const run = db.hostRuns.find((r) => want.res.get(r.run_id)?.some((x) => x.obs_id === big[0]))!;
      await expect(batchResolutions(db.layer, [run.run_id], nearestRun(db.runs, run, "cloudflare.dns")!.run_id, {}, 1)).rejects.toThrow(/one obs_id holds more than 1 rows/);
    }
    db.sql.close();
  });

  it("holds no OR, so nothing needs fencing against the Zetaris pushdown fault: equalities, AND, IN lists of literals", () => {
    for (const sql of [SURFACE_OBSERVATIONS_SQL, batchResolutionsSql(1), batchResolutionsSql(100)]) expect(sql).not.toMatch(/\bOR\b/i);
  });
});

describe("the World Model's bulk ingest", () => {
  it("observeAll records a run's observations as observe does one by one, and again changes nothing", async () => {
    const db = await open(recorded);
    const run = db.hostRuns[0];
    const rows = objects(await observationsOf(db.layer, run.run_id, { limit: 100_000 }));
    const obs = rows.map((o) => ({
      tenantId: o.tenant_id, surface: o.surface, objectId: o.object_id, settingPath: o.setting_path, valueHash: o.value_hash,
      refersTo: o.refers_to_type ? { targetType: o.refers_to_type, targetId: o.refers_to_id, fingerprint: null } : undefined,
      observedAt: o.observed_at, source: o.source, authority: Number(o.authority), collectionId: o.run_id,
    }));
    const [bulk, single] = [new DriftWorld("test_batch"), new DriftWorld("test_batch")];
    await bulk.observeAll(obs);
    for (const o of obs) await single.observe(o);
    const shape = (w: DriftWorld) => JSON.stringify(w.world.stateShape());
    const once = shape(bulk);
    expect(once).toBe(shape(single));
    await bulk.observeAll(obs);
    expect(shape(bulk)).toBe(once);
    db.sql.close();
  });
});
