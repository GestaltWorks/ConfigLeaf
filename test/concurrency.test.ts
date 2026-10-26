// The concurrent pass (src/concurrency.ts, src/pipeline.ts, PASS_CONCURRENCY): the helpers on their own (tasks four at a time
// with their commits in task order, a tracer that cannot be taken failing its task rather than hanging, held lines written in
// task order, a shared read run once with its lines where the first task in order asked); sql.js under overlapping runs,
// writes and reads interleaved four at a time, a re-entered run or write refused; the pass at concurrency 1 and 4 over the sample
// bundle with the committed lessons and over the test fixtures, with equal findings, dispositions, ledger rows, recalls and
// trace events (timestamps, latencies and query ids aside), a failing pass included; and over an engine that waits 50 ms
// before each query, the queries in flight (1, then 4) and the same queries, trace and findings at both. No assertion
// rests on wall time: a loaded runner stretches it.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HeldTracer, OrderedTrace, SharedReads, checkLimit, inOrder, type Task } from "../src/concurrency.ts";
import { parsePassConcurrency } from "../src/config.ts";
import { decisionInstantWith } from "../src/data/instant.ts";
import { DataLayer, DataLayerError, type Engine } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { DISPOSITIONS_SQL, objects } from "../src/data/queries.ts";
import type { Disposition, ReferentFingerprint } from "../src/data/rows.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { MemoryLedger, type Ledger } from "../src/ledger.ts";
import { runPass, type PassOptions } from "../src/pipeline.ts";
import type { TraceEvent } from "../src/trace.ts";
import authored from "./fixtures/authored-bundle.json" with { type: "json" };
import policyBundle from "./fixtures/policy-bundle.json" with { type: "json" };
import recorded from "./fixtures/recorded-bundle.json" with { type: "json" };
import sample from "../sample/bundle.json" with { type: "json" };
import { MemTracer } from "./fixtures/mem-tracer.ts";

type Bundle = Readonly<Record<string, unknown>>;

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The trace as compared: every event without its timestamp, latency and query id (a fresh UUID per query). */
const events = (t: MemTracer): Omit<TraceEvent, "ts" | "latency_ms" | "query_id">[] =>
  t.events.map(({ ts: _ts, latency_ms: _ms, query_id: _id, ...rest }) => rest);

/** An engine over sql.js that waits `delay` ms before each query, counts the queries in flight, and throws on the queries `fails` names. */
function slowEngine(inner: SqlJsEngine, delay: number, fails: (sql: string) => boolean = () => false) {
  const seen = { queries: 0, inFlight: 0, maxInFlight: 0 };
  const engine: Engine = {
    name: "zetaris",
    qualify: (t) => inner.qualify(t),
    run: async (sql, o) => {
      seen.queries++;
      seen.maxInFlight = Math.max(seen.maxInFlight, ++seen.inFlight);
      try {
        await tick(delay);
        // a plain Error, as a Zetaris HTTP failure is: not the DataLayerError a check records as a rejection
        if (fails(sql)) throw new Error(`planted failure: ${sql.replace(/\s+/g, " ").slice(0, 120)}`);
        return await inner.run(sql, o);
      } finally {
        seen.inFlight--;
      }
    },
  };
  return { engine, seen };
}

/** One pass over `bundle` at `concurrency`: its result, its trace, the ledger's rows in the order written, and the memory's recalls. */
async function passAt(bundle: Bundle, concurrency: number, o: { opts?: PassOptions; memory?: () => TechnicianMemory; engine?: (e: SqlJsEngine) => Engine; ledger?: (e: SqlJsEngine) => Ledger } = {}) {
  const sql = await SqlJsEngine.create();
  sql.loadBundle(bundle);
  const tracer = new MemTracer("test_concurrency", { model: "none" });
  const memory = o.memory?.();
  const layer = new DataLayer(o.engine ? o.engine(sql) : sql);
  try {
    const result = await runPass(layer, { tracer, world: new DriftWorld("test_concurrency"), memory, ledger: o.ledger ? o.ledger(sql) : new MemoryLedger(sql), concurrency, ...o.opts });
    const read = new DataLayer(sql);
    const dispositions = objects(await read.run("SELECT * FROM {{t:disposition}}", {}, { limit: 100_000 })) as unknown as Disposition[];
    const fingerprints = objects(await read.run("SELECT * FROM {{t:referent_fingerprint}}", {}, { limit: 100_000 })) as unknown as ReferentFingerprint[];
    const byId = objects(await read.run(DISPOSITIONS_SQL, {}, { limit: 100_000 }));
    const recalls = memory?.hmem.ledger.all().map(({ timestamp: _t, details, ...e }) => ({ ...e, details: { ...details, at: undefined } }));
    return { ok: true as const, result, trace: events(tracer), dispositions, fingerprints, byId, recalls };
  } catch (error) {
    return { ok: false as const, error: (error as Error).message, trace: events(tracer) };
  } finally {
    sql.close();
  }
}

describe("inOrder: tasks at most `limit` at a time, commits in task order", () => {
  it("starts tasks in order, never runs more than the limit, and commits in order when later tasks finish first", async () => {
    const started: number[] = [];
    const committed: number[] = [];
    let now = 0;
    let max = 0;
    const tasks: Task[] = [30, 5, 20, 1, 15, 2, 8, 0].map((ms, i) => async () => {
      started.push(i);
      max = Math.max(max, ++now);
      await tick(ms);
      now--;
      return () => { committed.push(i); };
    });
    await inOrder(tasks, 3, () => undefined);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(committed).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(max).toBe(3);
    now = 0;
    max = 0;
    await inOrder(tasks, 1, () => undefined);
    expect(max).toBe(1);
  });

  it("whatever a task does before its first await runs in task order", async () => {
    const before: number[] = [];
    await inOrder([3, 0, 2, 1, 0, 4].map((ms, i): Task => async () => { before.push(i); await tick(ms); return () => {}; }), 2, () => undefined);
    expect(before).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("on a failure starts no more tasks, runs every commit before the earliest failure, waits for the tasks in flight, and throws that failure", async () => {
    const committed: number[] = [];
    const settled: number[] = [];
    // Each task waits on a gate of its own, opened below in a fixed order, so no timer on a loaded runner decides which
    // settles first; `open[i]` is set when task i starts.
    const open: ((fail: boolean) => void)[] = [];
    const tasks: Task[] = Array.from({ length: 7 }, (_, i): Task => async () => {
      const fail = await new Promise<boolean>((resolve) => { open[i] = resolve; });
      settled.push(i);
      if (fail) throw new Error(`task ${i}`);
      return () => { committed.push(i); };
    });
    let done = false;
    const run = inOrder(tasks, 3, () => undefined).finally(() => { done = true; });
    const thrown = expect(run).rejects.toThrow("task 3");
    expect(open.length).toBe(3);
    // task 1 settles, so task 3 starts; task 3 fails before tasks 0 and 2 settle
    open[1](false);
    await tick();
    open[3](true);
    await tick();
    open[0](false);
    await tick();
    // task 4, queued behind the failure, never starts; inOrder waits for task 2, still in flight
    expect(open[4]).toBeUndefined();
    expect(done).toBe(false);
    open[2](false);
    // the failure thrown is 3's, after the commits of 0, 1 and 2
    await thrown;
    expect(committed).toEqual([0, 1, 2]);
    expect(settled).toEqual([1, 3, 0, 2]);
    expect(open.length).toBe(4);
    // a commit that throws is a failure at its task
    await expect(inOrder([async () => () => { throw new Error("commit 0"); }, async () => () => { committed.push(9); }], 2, () => undefined)).rejects.toThrow("commit 0");
    expect(committed).toEqual([0, 1, 2]);
  });

  it("a tracerOf that throws fails its task: the commits before it run, no later task starts, and inOrder rejects instead of hanging", { timeout: 10_000 }, async () => {
    const started: number[] = [];
    const committed: number[] = [];
    const into = new MemTracer("test_tracer_of", {});
    const order = new OrderedTrace(into);
    const tasks: Task[] = [20, 0, 0, 0, 0].map((ms, i) => async (t) => {
      started.push(i);
      t?.emit({ agent: "t", action: "check", status: "ok", input_summary: `task ${i}` });
      await tick(ms);
      return () => { committed.push(i); };
    });
    const tracerOf = (i: number): HeldTracer => {
      if (i === 2) throw new Error("tracer 2");
      return order.next();
    };
    let timer: NodeJS.Timeout | undefined;
    const hung = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("inOrder hung")), 3_000); });
    try {
      await expect(Promise.race([inOrder(tasks, 3, tracerOf), hung])).rejects.toThrow("tracer 2");
    } finally {
      clearTimeout(timer);
    }
    expect(started).toEqual([0, 1]);
    expect(committed).toEqual([0, 1]);
    expect(into.events.map((e) => e.input_summary)).toEqual(["task 0", "task 1"]);
  });

  it("takes a whole number of at least 1, as PASS_CONCURRENCY does", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => checkLimit(bad)).toThrow(RangeError);
    await expect(inOrder([], 0, () => undefined)).rejects.toThrow(RangeError);
    expect(parsePassConcurrency("")).toBe(4);
    expect(parsePassConcurrency(" 1 ")).toBe(1);
    expect(parsePassConcurrency("8")).toBe(8);
    for (const bad of ["0", "-2", "1.5", "four", "04"]) expect(() => parsePassConcurrency(bad)).toThrow(/^PASS_CONCURRENCY: a whole number of at least 1/);
  });
});

describe("held lines and shared reads: written in the order of a pass one task at a time", () => {
  const lines = (t: MemTracer) => t.events.map((e) => e.input_summary);

  it("writes each task's lines in task order as soon as every earlier one is written, a held child at its place, nothing after a failed tracer", async () => {
    const into = new MemTracer("test_held", {});
    const order = new OrderedTrace(into);
    const [a, b, c] = [order.next(), order.next(), order.next()];
    const line = (t: HeldTracer, s: string) => t.emit({ agent: "t", action: "check", status: "ok", input_summary: s });
    line(b, "b1");
    b.close();
    expect(lines(into)).toEqual([]);
    line(a, "a1");
    const child = a.hold();
    line(a, "a2");
    a.close();
    expect(lines(into)).toEqual(["a1"]);
    line(child, "a-child");
    child.close();
    expect(lines(into)).toEqual(["a1", "a-child", "a2", "b1"]);
    const d = order.next();
    line(c, "c1");
    line(d, "d1");
    d.close();
    c.fail();
    expect(lines(into)).toEqual(["a1", "a-child", "a2", "b1", "c1"]);
  });

  it("runs a shared read once, writes its lines at the first place in task order (here the earlier task asked second), and nothing at the later places", async () => {
    const into = new MemTracer("test_shared", {});
    const order = new OrderedTrace(into);
    const shared = new SharedReads(order);
    let reads = 0;
    const read = async (t: HeldTracer | undefined) => {
      reads++;
      t?.emit({ agent: "t", action: "query", status: "ok", input_summary: "the shared read" });
      await tick(5);
      return 42;
    };
    const [first, second] = [order.next(), order.next()];
    second.emit({ agent: "t", action: "check", status: "ok", input_summary: "second asks" });
    const asked = shared.read("k", second, read);
    first.emit({ agent: "t", action: "check", status: "ok", input_summary: "first asks" });
    expect(await Promise.all([shared.read("k", first, read), asked])).toEqual([42, 42]);
    second.close();
    first.close();
    expect(reads).toBe(1);
    expect(lines(into)).toEqual(["first asks", "the shared read", "second asks"]);
  });
});

describe("sql.js under overlapping runs", () => {
  it("runs each statement whole from prepare to free, so overlapping runs on one engine return what one at a time returns", async () => {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(recorded);
    const sqls = ["SELECT run_id, surface FROM collection_run ORDER BY run_id", "SELECT COUNT(*) AS n FROM observation", "SELECT record_id, name FROM dns_record ORDER BY run_id, record_id"];
    const each: string[][][] = [];
    for (const s of sqls) each.push((await engine.run(s, { limit: 100_000 })).rows);
    const overlapping = await Promise.all(Array.from({ length: 30 }, (_, i) => engine.run(sqls[i % 3], { limit: 100_000 })));
    overlapping.forEach((r, i) => expect(r.rows).toEqual(each[i % 3]));
    engine.close();
  });

  it("interleaves writes and reads on one engine four at a time, as the pass does: each task reads its own writes, the commits' writes land in task order", async () => {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(recorded);
    await engine.run("CREATE TABLE scratch (i INTEGER PRIMARY KEY, tag TEXT)");
    await engine.run("CREATE TABLE commits (seq INTEGER PRIMARY KEY AUTOINCREMENT, i INTEGER)");
    const runs = (await engine.run("SELECT COUNT(*) AS n FROM collection_run")).rows;
    let inFlight = 0;
    let maxInFlight = 0;
    const tasks: Task[] = Array.from({ length: 40 }, (_, i): Task => async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await engine.run(`INSERT INTO scratch (i, tag) VALUES (${i}, 'w${i}')`);
      await tick(i % 4);
      const own = (await engine.run(`SELECT i, tag FROM scratch WHERE i = ${i}`)).rows;
      // every task started before this one wrote first, so at least i + 1 rows stand
      const seen = Number((await engine.run("SELECT COUNT(*) AS n FROM scratch")).rows[0][0]);
      await engine.run(`UPDATE scratch SET tag = 'u${i}' WHERE i = ${i}`);
      await tick((7 * i) % 3);
      const updated = (await engine.run(`SELECT tag FROM scratch WHERE i = ${i}`)).rows;
      // a read of the bundle's own rows between the writes returns what it returns alone
      const bundle = (await engine.run("SELECT COUNT(*) AS n FROM collection_run")).rows;
      inFlight--;
      expect(own).toEqual([[String(i), `w${i}`]]);
      expect(seen).toBeGreaterThanOrEqual(i + 1);
      expect(updated).toEqual([[`u${i}`]]);
      expect(bundle).toEqual(runs);
      return async () => { await engine.run(`INSERT INTO commits (i) VALUES (${i})`); };
    });
    await inOrder(tasks, 4, () => undefined);
    expect(maxInFlight).toBe(4);
    expect((await engine.run("SELECT i, tag FROM scratch ORDER BY i", { limit: 100 })).rows).toEqual(Array.from({ length: 40 }, (_, i) => [String(i), `u${i}`]));
    expect((await engine.run("SELECT i FROM commits ORDER BY seq", { limit: 100 })).rows).toEqual(Array.from({ length: 40 }, (_, i) => [String(i)]));
    engine.close();
  });

  it("refuses a statement or a write that arrives while a statement is open, loudly, and runs the next one once it is freed", async () => {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(recorded);
    // a tracer that queries and writes the same engine from inside emit, which run calls with its statement still open
    class Reentrant extends MemTracer {
      inner: Promise<unknown> | undefined;
      write: unknown;
      override emit(e: Omit<TraceEvent, "ts" | "trace_id">): TraceEvent {
        this.inner ??= engine.run("SELECT 1 AS n");
        try { engine.insertRows("referent_fingerprint", []); } catch (err) { this.write ??= err; }
        return super.emit(e);
      }
    }
    const tracer = new Reentrant("test_reentry", {});
    expect((await engine.run("SELECT COUNT(*) AS n FROM collection_run", { tracer })).rowCount).toBe(1);
    await expect(tracer.inner).rejects.toThrow(/^sqljs: a statement started while another statement was running on this engine/);
    expect(String(tracer.write)).toContain("sqljs: a write to referent_fingerprint started while another statement was running on this engine");
    // a plain Error, not the DataLayerError a check records as a rejection: the pass fails rather than carrying on
    await expect(tracer.inner).rejects.not.toBeInstanceOf(DataLayerError);
    expect((await engine.run("SELECT 1 AS n")).rows).toEqual([["1"]]);
    expect(engine.insertRows("referent_fingerprint", [])).toBe(0);
    // a statement that fails frees the engine too
    await expect(engine.run("SELECT nope FROM nowhere")).rejects.toThrow(DataLayerError);
    expect((await engine.run("SELECT 2 AS n")).rows).toEqual([["2"]]);
    engine.close();
  });
});

describe("the pass at concurrency 1 and 4: every finding, disposition, ledger row, recall and trace line the same", () => {
  const STORE = fileURLToPath(new URL("../examples/memory", import.meta.url));

  // Two passes over the sample bundle, about 5 s each alone, longer under the full suite.
  it("over sample/bundle.json with the committed lessons, as SAMPLE_MODE=true npm run sample runs it", { timeout: 120_000 }, async () => {
    const memory = () => new TechnicianMemory({ storage: "read", directory: STORE });
    const decidedAt = decisionInstantWith(sample, memory().lessons().map((l) => l.recordedAt))!;
    const [one, four] = [await passAt(sample, 1, { memory, opts: { decidedAt } }), await passAt(sample, 4, { memory, opts: { decidedAt } })];
    if (!one.ok || !four.ok) throw new Error("a sample pass failed");
    expect(one.result.verbs).toEqual({ ADOPT: 23, HOLD: 3, ESCALATE: 1, ROLLBACK: 0, FIX: 0 });
    expect(four.result).toEqual(one.result);
    expect(four.result.findings.map((f) => f.disposition)).toEqual(one.result.findings.map((f) => f.disposition));
    // the bundle's own ledger rows and the 27 of this pass, in the order written
    expect(four.result.ledger?.dispositions).toBe(27);
    expect(four.dispositions).toEqual(one.dispositions);
    expect(four.byId).toEqual(one.byId);
    expect(four.fingerprints).toEqual(one.fingerprints);
    // one "read" per lesson a finding's recall matched, logged in finding order
    expect(four.recalls?.filter((e) => e.action === "read").length).toBeGreaterThanOrEqual(23);
    expect(four.recalls).toEqual(one.recalls);
    expect(four.trace.length).toBe(one.trace.length);
    expect(four.trace).toEqual(one.trace);
  });

  const AT = "2026-10-23T03:00:00.000Z";
  const cases: [string, Bundle, PassOptions][] = [
    ["the authored fixture", authored, { decidedAt: AT }],
    ["the recorded fixture", recorded, { decidedAt: AT }],
    ["the policy fixture, every verb, the HOLDs of an earlier pass and the change windows read", policyBundle, { decidedAt: AT, at: AT }],
    ["the policy fixture with no change_window table listed", policyBundle, { decidedAt: AT, windowTable: false }],
  ];
  for (const [name, bundle, opts] of cases) {
    it(`over ${name}`, async () => {
      const [one, four] = [await passAt(bundle, 1, { opts }), await passAt(bundle, 4, { opts })];
      if (!one.ok || !four.ok) throw new Error(`a pass over ${name} failed`);
      expect(one.result.findings.length).toBeGreaterThan(0);
      expect(four.result).toEqual(one.result);
      expect(four.dispositions).toEqual(one.dispositions);
      expect(four.fingerprints).toEqual(one.fingerprints);
      expect(four.trace).toEqual(one.trace);
    });
  }

  it("over the policy fixture with a change_window read that fails: the one not_checked line, where the first finding that weighs a window asks", async () => {
    const failing = (e: SqlJsEngine): Engine => ({ name: e.name, qualify: (t) => e.qualify(t), run: async (sql, o) => { if (sql.includes("FROM change_window")) throw new DataLayerError("no such table: change_window"); return e.run(sql, o); } });
    const opts = { decidedAt: AT };
    const [one, four] = [await passAt(policyBundle, 1, { opts, engine: failing }), await passAt(policyBundle, 4, { opts, engine: failing })];
    if (!one.ok || !four.ok) throw new Error("a pass failed");
    expect(one.trace.filter((e) => e.input_summary === "change_window client-a").map((e) => e.status)).toEqual(["not_checked"]);
    expect(four.result).toEqual(one.result);
    expect(four.trace).toEqual(one.trace);
  });

  const failures: [string, (sql: string) => boolean, ((e: SqlJsEngine) => Ledger) | undefined][] = [
    // actor_attributed on one record, which several findings check: the first of them in order fails
    ["a check's query", (sql) => sql.startsWith("SELECT event_id, source, actor, action") && sql.includes("resource_id = '82de28f7baf86a005babc"), undefined],
    ["a detector's query", (sql) => sql.startsWith("SELECT n.obs_id, n.host, n.object_id, n.setting_path, n.refers_to_id"), undefined],
    // the second query of an exposure measurement, a read several findings share: the record's row came back, the first event fails
    ["an exposure query", (sql) => sql.startsWith("SELECT e.event_id, e.action, e.actor, e.occurred_at,"), undefined],
    // run_complete of the second host run: the gate asks first, before any finding's check does
    ["the gate's query of one run", (sql) => sql.startsWith("SELECT c.run_id") && sql.includes("WHERE c.run_id = 'run-67f4d6923cb4838d'"), undefined],
    ["the ledger's second referent fingerprint write, a commit", () => false, (e) => {
      const inner = new MemoryLedger(e);
      let writes = 0;
      return { record: (rows) => inner.record(rows), recordFingerprints: async (rows) => { if (++writes === 2) throw new Error("planted ledger failure"); return inner.recordFingerprints(rows); } };
    }],
  ];
  for (const [name, fails, ledger] of failures) {
    it(`a pass that fails at ${name} throws the same error at 1 and 4, its trace the same up to the failure and nothing after`, async () => {
      const at = async (c: number) => passAt(recorded, c, { engine: (e) => slowEngine(e, 0, fails).engine, ledger, opts: { decidedAt: AT } });
      const [one, four] = [await at(1), await at(4)];
      if (one.ok || four.ok) throw new Error(`the planted failure at ${name} did not fail the pass`);
      expect(four.error).toBe(one.error);
      expect(one.trace.length).toBeGreaterThan(0);
      expect(four.trace).toEqual(one.trace);
    });
  }

  it("a pass whose third World Model exposure write throws, a commit: an ok line for each of the two edges stored, none for the third, its failed line last, the same at 1 and 4", async () => {
    class FailingWorld extends DriftWorld {
      private stores = 0;
      override async exposure(...args: Parameters<DriftWorld["exposure"]>) {
        if (++this.stores === 3) throw new Error("planted World Model failure");
        return super.exposure(...args);
      }
    }
    const at = async (c: number) => passAt(recorded, c, { engine: (e) => slowEngine(e, 0).engine, opts: { decidedAt: AT, world: new FailingWorld("test_concurrency_edge") } });
    const [one, four] = [await at(1), await at(4)];
    if (one.ok || four.ok) throw new Error("the planted World Model failure did not fail the pass");
    expect(one.error).toBe("planted World Model failure");
    expect(four.error).toBe(one.error);
    const exposure = one.trace.filter((e) => e.action === "triage" && e.input_summary?.startsWith("exposure "));
    expect(exposure.filter((e) => e.status === "ok")).toHaveLength(2);
    expect(exposure.filter((e) => e.status === "failed")).toHaveLength(1);
    expect(one.trace.at(-1)).toMatchObject({ agent: "decider", status: "failed", output_summary: "exposure edge not stored: planted World Model failure" });
    expect(four.trace).toEqual(one.trace);
  });
});

describe("the pass over an engine that waits 50 ms before each query", () => {
  // Two passes over the recorded fixture at 50 ms a query: about 11 s at concurrency 1 and 3 s at 4 on an idle machine. The
  // durations are printed, never asserted: the queries in flight and the order of what the pass writes are.
  it("runs one query at a time at 1 and four at a time at 4, the same queries, the same trace in the same order, the same findings", { timeout: 120_000 }, async () => {
    const at = async (concurrency: number) => {
      const sql = await SqlJsEngine.create();
      sql.loadBundle(recorded);
      const { engine, seen } = slowEngine(sql, 50);
      const sqls: string[] = [];
      const counted: Engine = { ...engine, run: (s, o) => { sqls.push(s); return engine.run(s, o); } };
      const tracer = new MemTracer("test_concurrency_slow", { model: "none" });
      const t0 = performance.now();
      const result = await runPass(new DataLayer(counted), { tracer, world: new DriftWorld("test_concurrency_slow"), ledger: new MemoryLedger(sql), decidedAt: "2026-10-26T00:00:00.000Z", concurrency });
      const ms = performance.now() - t0;
      sql.close();
      return { ms, seen, sqls, trace: events(tracer), result };
    };
    const one = await at(1);
    const four = await at(4);
    expect(one.seen.maxInFlight).toBe(1);
    expect(four.seen.maxInFlight).toBe(4);
    expect(four.seen.queries).toBe(one.seen.queries);
    // the same statements, each as often; at 4 they start in another order, and the trace still comes out in the order of 1
    expect([...four.sqls].sort()).toEqual([...one.sqls].sort());
    expect(four.sqls).not.toEqual(one.sqls);
    expect(four.trace).toEqual(one.trace);
    expect(four.result.findings.map((f) => f.id)).toEqual(one.result.findings.map((f) => f.id));
    expect(four.result).toEqual(one.result);
    console.log(`50 ms a query: ${one.seen.queries} queries, ${Math.round(one.ms)} ms at 1, ${Math.round(four.ms)} ms at 4, ${(one.ms / four.ms).toFixed(2)}x`);
  });
});
