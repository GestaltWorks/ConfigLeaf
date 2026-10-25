// The ledger over sql.js: a disposition recorded through MemoryLedger is a row of the disposition table the
// DataLayer reads as {{t:disposition}}, on the recorded bundle with its disposition table emptied; recording is
// idempotent on disposition_id.
// PgLedger is the same contract through Store.insertDispositions (test/store.test.ts, live half).
import { beforeAll, describe, expect, it } from "vitest";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { COLUMNS, dispositionId, type Disposition } from "../src/data/rows.ts";
import { MemoryLedger, PgLedger, type Ledger } from "../src/ledger.ts";
import bundle from "../sample/bundle.json" with { type: "json" };
import { CONFD_HOST, CONFD_RUN, T } from "./fixtures/catalogue-params.ts";

const OBJECT = "/etc/nginx/conf.d/host-503b27.ai.conf";
const SETTING = "server[host-503b27.ai:443].real_ip";
const live = bundle.observation.find((o) => o.run_id === CONFD_RUN && o.object_id === OBJECT && o.setting_path === SETTING)!;

const disposition = (over: Partial<Disposition> = {}): Disposition => {
  const d: Disposition = {
    disposition_id: "", tenant_id: T, surface: "linux.nginx", host: CONFD_HOST, object_id: OBJECT, setting_path: SETTING, value_hash: live.value_hash,
    verb: "HOLD", reason: "The block trusts no real_ip range; held for 72 hours under the real_ip rule.", expires_at: "2026-10-27T07:59:00.000Z",
    decided_by: "policy", rule_id: "rule-e611622049c91a41", finding_id: "fnd-45d5f3f4a2eb0b2e", run_id: CONFD_RUN, decided_at: "2026-10-24T07:59:00.000Z", ...over,
  };
  return { ...d, disposition_id: dispositionId(d.tenant_id, d.surface, d.host, d.object_id, d.setting_path, d.value_hash, d.finding_id, d.run_id) };
};

describe("MemoryLedger (sql.js)", () => {
  let engine: SqlJsEngine;
  let dl: DataLayer;
  let ledger: Ledger;

  beforeAll(async () => {
    engine = await SqlJsEngine.create();
    // the recorded rows with an empty disposition table: the ledger's own rows are the ones these cases count
    engine.loadBundle({ ...bundle, disposition: [] });
    dl = new DataLayer(engine);
    ledger = new MemoryLedger(engine);
  });

  it("a recorded disposition is readable through the DataLayer as {{t:disposition}}, every column as stored", async () => {
    expect(live).toBeDefined();
    const d = disposition();
    expect(d.disposition_id).toMatch(/^disp-[0-9a-f]{16}$/);
    expect(await ledger.record([d])).toBe(1);
    const r = await dl.run(`SELECT ${COLUMNS.disposition.join(", ")} FROM {{t:disposition}} WHERE finding_id = {{p:f}} ORDER BY disposition_id`, { f: d.finding_id });
    expect(r.columns).toEqual([...COLUMNS.disposition]);
    expect(r.rows).toEqual([[d.disposition_id, T, "linux.nginx", CONFD_HOST, OBJECT, SETTING, live.value_hash, "HOLD", d.reason, "2026-10-27T07:59:00.000Z", "policy", "rule-e611622049c91a41", "fnd-45d5f3f4a2eb0b2e", CONFD_RUN, "2026-10-24T07:59:00.000Z"]]);
  });

  it("joins the observation it decides on: the live value_hash of the setting in the run", async () => {
    const r = await dl.run(`SELECT d.verb, o.obs_id FROM {{t:disposition}} d JOIN {{t:observation}} o ON o.run_id = d.run_id AND o.object_id = d.object_id AND o.setting_path = d.setting_path AND o.value_hash = d.value_hash ORDER BY d.disposition_id`);
    expect(r.rows).toEqual([["HOLD", live.obs_id]]);
  });

  it("is idempotent on disposition_id: the same pass recorded again writes 0; a new value of the setting is a new decision; two rows under one id are refused", async () => {
    expect(await ledger.record([disposition()])).toBe(0);
    const changed = disposition({ value_hash: `sha256:${"b".repeat(64)}`, verb: "ESCALATE", expires_at: null, reason: "The value changed since the last decision." });
    expect(changed.disposition_id).not.toBe(disposition().disposition_id);
    expect(await ledger.record([changed, changed])).toBe(1);
    await expect(ledger.record([disposition({ verb: "ADOPT" }), disposition({ verb: "ESCALATE" })])).rejects.toThrow(/two different rows share the key/);
    const n = await dl.run("SELECT COUNT(*) AS n FROM {{t:disposition}}");
    expect(n.rows).toEqual([["2"]]);
  });

  it("refuses a timestamp outside the millisecond form and a column the table does not have", async () => {
    await expect(ledger.record([disposition({ decided_at: "2026-10-24T07:59:00Z", finding_id: "fnd-x" })])).rejects.toThrow(/disposition\.decided_at: timestamps must be/);
    await expect(ledger.record([{ ...disposition({ finding_id: "fnd-y" }), bogus: 1 } as never])).rejects.toThrow(/disposition: unknown column bogus/);
  });
});

describe("PgLedger", () => {
  it("writes through Store.insertDispositions and returns its count", async () => {
    const seen: Disposition[][] = [];
    const store = { insertDispositions: async (rows: readonly Disposition[]) => { seen.push([...rows]); return rows.length; } };
    const ledger = new PgLedger(store as never);
    expect(await ledger.record([disposition()])).toBe(1);
    expect(seen).toEqual([[disposition()]]);
  });
});
