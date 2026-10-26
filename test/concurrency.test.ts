// The concurrent pass (src/concurrency.ts, src/pipeline.ts, PASS_CONCURRENCY): the helpers on their own (tasks four at a time
// with their commits in task order and never two at once, a tracer that cannot be taken failing its task rather than hanging,
// held lines closed on every path out of a commit and written in task order, a shared read run once with its lines where the
// first task in order asked and a line for each later ask, the limit from 1 to 16); sql.js under overlapping runs, writes and
// reads interleaved four at a time, a re-entered run or write refused; the pass at concurrency 1 and 4 over the sample bundle
// with the committed lessons and over the test fixtures, with equal findings, dispositions, ledger rows, recalls and trace
// events (timestamps, latencies and query ids aside); failing passes, one commit failing among many with nothing reaching the
// ledger, and a pass a detector aborted followed by one that decides as if it had not; and over an engine that waits before
// each query, the queries in flight (1, then 4) and the same queries, trace and findings at both. No assertion rests on wall
// time: a loaded runner stretches it.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HeldTracer, OrderedTrace, SharedReads, checkLimit, closing, inOrder, type Task } from "../src/concurrency.ts";
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
import { mailWorld } from "./fixtures/m365/world.ts";

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

  it("runs the commits strictly one at a time and in task order, a later commit waiting on an earlier one that awaits even when every task is done", async () => {
    const log: string[] = [];
    let inCommit = 0;
    let maxInCommit = 0;
    // Each task waits on a gate of its own; every commit awaits twice in its body, and commit 0 also waits on `hold`, opened
    // only once every task has settled, so the later commits are ready the whole time commit 0 is suspended.
    const open: (() => void)[] = [];
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const tasks: Task[] = Array.from({ length: 6 }, (_, i): Task => async () => {
      await new Promise<void>((resolve) => { open[i] = resolve; });
      return async () => {
        maxInCommit = Math.max(maxInCommit, ++inCommit);
        log.push(`start ${i}`);
        if (i === 0) await hold;
        await tick();
        await Promise.resolve();
        log.push(`end ${i}`);
        inCommit--;
      };
    });
    const run = inOrder(tasks, 6, () => undefined);
    // the tasks settle last first
    for (let i = 5; i >= 0; i--) {
      open[i]();
      await tick();
    }
    await tick();
    expect(log).toEqual(["start 0"]);
    release();
    await run;
    expect(log).toEqual(Array.from({ length: 6 }, (_, i) => [`start ${i}`, `end ${i}`]).flat());
    expect(maxInCommit).toBe(1);
  });

  it("takes a whole number from 1 to 16, as PASS_CONCURRENCY does, and says why above it", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 17, 64]) expect(() => checkLimit(bad)).toThrow(RangeError);
    expect(checkLimit(16)).toBe(16);
    expect(() => checkLimit(17)).toThrow("concurrency is a whole number from 1 to 16, got 17");
    await expect(inOrder([], 0, () => undefined)).rejects.toThrow(RangeError);
    expect(parsePassConcurrency("")).toBe(4);
    expect(parsePassConcurrency(" 1 ")).toBe(1);
    expect(parsePassConcurrency("8")).toBe(8);
    expect(parsePassConcurrency("16")).toBe(16);
    for (const bad of ["0", "-2", "1.5", "four", "04"]) expect(() => parsePassConcurrency(bad)).toThrow(/^PASS_CONCURRENCY: a whole number of at least 1/);
    expect(() => parsePassConcurrency("17")).toThrow("PASS_CONCURRENCY: at most 16, got 17; each read in flight is one more query against the datasource at once");
    expect(() => parsePassConcurrency("1000")).toThrow(/^PASS_CONCURRENCY: at most 16, got 1000/);
  });
});

describe("an invalid PASS_CONCURRENCY at startup", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  // the environment a judge's clean clone has: none of the operator's own variables
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DRIFT|ZETARIS|METERLESS|M365)_/.test(k)));

  it("exits 2 with one plain line on stderr, never a stack trace, before the script does anything", { timeout: 60_000 }, () => {
    for (const [value, line] of [
      ["17", "PASS_CONCURRENCY: at most 16, got 17; each read in flight is one more query against the datasource at once"],
      ["0", "PASS_CONCURRENCY: a whole number of at least 1, got \"0\""],
      ["four", "PASS_CONCURRENCY: a whole number of at least 1, got \"four\""],
    ]) {
      const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/sample.ts"], { cwd: ROOT, encoding: "utf8", timeout: 50_000, env: { ...clean, SAMPLE_MODE: "true", PASS_CONCURRENCY: value } });
      expect(r.status).toBe(2);
      expect(r.stderr).toBe(`${line}\n`);
      expect(r.stdout).toBe("");
    }
  });
});

describe("closing: the lines held for a commit are closed on every path out of it", () => {
  const lines = (t: MemTracer) => t.events.map((e) => e.input_summary);
  const line = (t: HeldTracer | undefined, s: string) => t?.emit({ agent: "t", action: "check", status: "ok", input_summary: s });
  /** Three tasks, each holding lines for its commit at a place among its own, as a finding holds its exposure line; `wrap1` false leaves task 1's commit unwrapped. */
  const tasks = (commit1: (held: HeldTracer | undefined) => Promise<void>, wrap1 = true): Task[] => [0, 1, 2].map((i): Task => async (t) => {
    line(t, `task ${i}`);
    const held = t?.hold();
    line(t, `task ${i} after`);
    const commit = async () => (i === 1 ? commit1(held) : void line(held, `task ${i} held`));
    return i === 1 && !wrap1 ? commit : closing(held, commit);
  });

  it("a commit that returns early, never touching its held lines, closes them: the order goes on to every later line", async () => {
    const into = new MemTracer("test_closing_early", {});
    const order = new OrderedTrace(into);
    await inOrder(tasks(async () => {}), 3, () => order.next());
    expect(lines(into)).toEqual(["task 0", "task 0 held", "task 0 after", "task 1", "task 1 after", "task 2", "task 2 held", "task 2 after"]);
  });

  it("a commit that throws fails them: the lines held so far come out, nothing after them, and the error is thrown", async () => {
    const into = new MemTracer("test_closing_throw", {});
    const order = new OrderedTrace(into);
    await expect(inOrder(tasks(async (held) => { line(held, "task 1 held"); throw new Error("commit 1"); }), 3, () => order.next())).rejects.toThrow("commit 1");
    expect(lines(into)).toEqual(["task 0", "task 0 held", "task 0 after", "task 1", "task 1 held"]);
  });

  it("the case it exists for: the same early return without closing leaves the held lines open, and nothing after them is ever written", async () => {
    const into = new MemTracer("test_closing_none", {});
    const order = new OrderedTrace(into);
    await inOrder(tasks(async () => {}, false), 3, () => order.next());
    expect(lines(into)).toEqual(["task 0", "task 0 held", "task 0 after", "task 1"]);
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

  /**
   * Two tasks ask one shared read, the earlier in task order as decider, the later as detector; `laterAsksFirst` says which
   * starts it. The read's own line is emitted under the agent of whichever task started it.
   */
  async function sharedPass(laterAsksFirst: boolean) {
    const into = new MemTracer("test_shared", {});
    const order = new OrderedTrace(into);
    const shared = new SharedReads(order);
    let reads = 0;
    const read = (agent: string) => async (t: HeldTracer | undefined) => {
      reads++;
      t?.emit({ agent, action: "query", status: "ok", input_summary: "the shared read" });
      await tick(5);
      return 42;
    };
    const [first, second] = [order.next(), order.next()];
    const askFirst = () => {
      first.emit({ agent: "t", action: "check", status: "ok", input_summary: "first asks" });
      return [shared.read("k", first, "decider", read("decider")), shared.read("k", first, "decider", read("decider"))];
    };
    const askSecond = () => {
      second.emit({ agent: "t", action: "check", status: "ok", input_summary: "second asks" });
      return [shared.read("k", second, "detector", read("detector"))];
    };
    const asked = laterAsksFirst ? [...askSecond(), ...askFirst()] : [...askFirst(), ...askSecond()];
    expect(await Promise.all(asked)).toEqual([42, 42, 42]);
    second.close();
    first.close();
    return { reads, lines: into.events.map((e) => [e.agent, e.input_summary, e.status, e.output_summary ?? null]) };
  }

  it("runs a shared read once, its lines at the first place in task order under that task's agent, one reuse line per later task, whichever task started it", async () => {
    const earlierFirst = await sharedPass(false);
    const laterFirst = await sharedPass(true);
    expect(earlierFirst.reads).toBe(1);
    expect(laterFirst.reads).toBe(1);
    expect(earlierFirst.lines).toEqual([
      ["t", "first asks", "ok", null],
      // the read's line names the first asker in task order; the first task's second ask marks no second place
      ["decider", "the shared read", "ok", null],
      ["t", "second asks", "ok", null],
      ["detector", "reused k", "skipped", "shared read: run once this pass, where decider first asked"],
    ]);
    // the later task started the read, its line emitted as detector: the trace names the same agents in the same places
    expect(laterFirst.lines).toEqual(earlierFirst.lines);
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

  // Slow by nature: two whole passes over the sample bundle, each one CPU-bound in the World Model's 14,174 observations, about
  // 5 s alone and longer under the full suite. Nothing in it waits to be cut: the property is the full sample pass at 1 and 4.
  it("(slow: two whole sample passes, about 10 s) over sample/bundle.json with the committed lessons, as SAMPLE_MODE=true npm run sample runs it", { timeout: 120_000 }, async () => {
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

  it("over the Microsoft 365 fixture under the policy: the mail records detector's four ESCALATEs and its lines, the same at 1 and 4", async () => {
    const { bundle } = await mailWorld({ policy: true });
    const opts = { decidedAt: AT };
    const [one, four] = [await passAt(bundle, 1, { opts }), await passAt(bundle, 4, { opts })];
    if (!one.ok || !four.ok) throw new Error("a pass over the Microsoft 365 fixture failed");
    expect(one.result.findings.map((f) => [f.finding.class, f.verb])).toEqual(Array(4).fill(["m365_mail_record", "ESCALATE"]));
    expect(four.result).toEqual(one.result);
    expect(four.dispositions).toEqual(one.dispositions);
    expect(four.trace).toEqual(one.trace);
    expect(one.trace.filter((e) => e.action === "detect" && e.input_summary?.startsWith("m365_mail_record ")).length).toBe(1);
  });

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

  /** The ledger's rows as stored, each table sorted, so two ledgers compare whatever order they were written in. */
  const ledgerRows = async (sql: SqlJsEngine) => {
    const read = new DataLayer(sql);
    const all = async (t: string) => objects(await read.run(`SELECT * FROM {{t:${t}}}`, {}, { limit: 100_000 })).map((r) => JSON.stringify(r)).sort();
    return { dispositions: await all("disposition"), fingerprints: await all("referent_fingerprint") };
  };
  /** One pass over the recorded fixture into its own sql.js ledger: the error it threw (null if none), its trace, the ledger before and after. */
  const passInto = async (c: number, world: DriftWorld) => {
    const sql = await SqlJsEngine.create();
    sql.loadBundle(recorded);
    const before = await ledgerRows(sql);
    const tracer = new MemTracer("test_concurrency_commit", { model: "none" });
    const error = await runPass(new DataLayer(sql), { tracer, world, ledger: new MemoryLedger(sql), decidedAt: AT, concurrency: c }).then(() => null, (e: Error) => e.message);
    const after = await ledgerRows(sql);
    sql.close();
    return { error, trace: events(tracer), before, after };
  };
  const isOkExposure = (e: ReturnType<typeof events>[number]) => e.action === "triage" && e.status === "ok" && !!e.input_summary?.startsWith("exposure ");

  it("one commit that fails among many (the third exposure edge's store): the pass rejects, the ledger gets no disposition, the trace is the clean pass's up to it and stops at its failed line, the same at 1 and 4", async () => {
    class FailingWorld extends DriftWorld {
      private stores = 0;
      override async exposure(...args: Parameters<DriftWorld["exposure"]>) {
        if (++this.stores === 3) throw new Error("planted World Model failure");
        return super.exposure(...args);
      }
    }
    const clean = await passInto(1, new DriftWorld("test_concurrency_clean"));
    expect(clean.error).toBeNull();
    // the clean pass writes its dispositions; the third ok exposure line is where the failing pass's commit fails
    expect(clean.after.dispositions.length).toBeGreaterThan(clean.before.dispositions.length);
    const third = clean.trace.findIndex((e, i) => isOkExposure(e) && clean.trace.slice(0, i).filter(isOkExposure).length === 2);
    for (const c of [1, 4]) {
      const failed = await passInto(c, new FailingWorld("test_concurrency_edge"));
      // loudly: the pass rejects with the commit's error, nothing absorbs it
      expect(failed.error).toBe("planted World Model failure");
      // nothing partial in the ledger: the dispositions are written after every step, so none of this pass's is
      expect(failed.after.dispositions).toEqual(failed.before.dispositions);
      // the observe step had finished before the failure: its referent fingerprints are all there, as the clean pass wrote them
      expect(failed.after.fingerprints).toEqual(clean.after.fingerprints);
      // every line before the failure is the clean pass's, the failed line stands where its ok line would, and nothing comes
      // after it: no later finding's line, no pass summary
      expect(failed.trace.length).toBe(third + 1);
      expect(failed.trace.slice(0, third)).toEqual(clean.trace.slice(0, third));
      expect(failed.trace[third]).toMatchObject({ agent: "decider", status: "failed", input_summary: clean.trace[third].input_summary, output_summary: "exposure edge not stored: planted World Model failure" });
      expect(failed.trace.filter(isOkExposure)).toHaveLength(2);
      expect(failed.trace.some((e) => e.input_summary === "policy" || e.input_summary === "stop rule")).toBe(false);
    }
  });

  it("after a pass a detector aborts partway, the next pass over the same World Model and ledger decides as a pass with no abort, and leaves the same World Model and ledger", async () => {
    const detectorFails = (s: string) => s.startsWith("SELECT n.obs_id, n.host, n.object_id, n.setting_path, n.refers_to_id");
    const shape = (w: DriftWorld) => {
      const s = w.world.stateShape() as Record<string, { id?: string }[]>;
      return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, [...v].map((x) => JSON.stringify(x)).sort()]));
    };
    // the policy line counts the rows written, and the abort wrote the observe step's fingerprints already
    const decisions = (t: ReturnType<typeof events>) => t.map((e) => (e.input_summary === "policy" ? { ...e, detail: undefined } : e));
    const passOver = async (sql: SqlJsEngine, world: DriftWorld, c: number, fails: () => boolean) => {
      const tracer = new MemTracer("test_concurrency_abort", { model: "none" });
      const layer = new DataLayer(slowEngine(sql, 0, (s) => fails() && detectorFails(s)).engine);
      const result = await runPass(layer, { tracer, world, ledger: new MemoryLedger(sql), decidedAt: AT, concurrency: c }).catch((e: Error) => e);
      return { result, trace: events(tracer) };
    };
    for (const c of [1, 4]) {
      const sql = await SqlJsEngine.create();
      sql.loadBundle(recorded);
      const world = new DriftWorld("test_concurrency_abort");
      const before = await ledgerRows(sql);
      let failing = true;
      const aborted = await passOver(sql, world, c, () => failing);
      expect(aborted.result).toBeInstanceOf(Error);
      // what the abort leaves behind: findings checked, decided and judged, exposure edges stored, no disposition recorded
      expect(aborted.trace.filter((e) => e.action === "judge").length).toBeGreaterThan(0);
      expect(aborted.trace.filter(isOkExposure).length).toBeGreaterThan(0);
      expect((await ledgerRows(sql)).dispositions).toEqual(before.dispositions);
      failing = false;
      const again = await passOver(sql, world, c, () => false);

      const cleanSql = await SqlJsEngine.create();
      cleanSql.loadBundle(recorded);
      const cleanWorld = new DriftWorld("test_concurrency_abort");
      const clean = await passOver(cleanSql, cleanWorld, c, () => false);
      if (again.result instanceof Error || clean.result instanceof Error) throw new Error("a pass after the abort failed");
      expect({ ...again.result, ledger: null }).toEqual({ ...clean.result, ledger: null });
      expect(again.result.ledger).toEqual({ dispositions: clean.result.ledger!.dispositions, fingerprints: 0 });
      expect(decisions(again.trace)).toEqual(decisions(clean.trace));
      expect(await ledgerRows(sql)).toEqual(await ledgerRows(cleanSql));
      expect(shape(world)).toEqual(shape(cleanWorld));
      sql.close();
      cleanSql.close();
    }
  });

  it("every finding's lines come out, its judge line and its exposure line, so no held tracer stayed open, at 1 and 4", async () => {
    for (const c of [1, 4]) {
      const r = await passAt(recorded, c, { opts: { decidedAt: AT } });
      if (!r.ok) throw new Error("the pass failed");
      const exposure = r.trace.filter((e) => e.action === "triage" && e.input_summary?.startsWith("exposure "));
      expect(r.trace.filter((e) => e.action === "judge")).toHaveLength(r.result.findings.length);
      expect(exposure.filter((e) => e.status === "ok")).toHaveLength(r.result.findings.filter((f) => f.exposure).length);
      // a finding on a record whose exposure the log cannot date stores nothing: its held lines close with the commit all the same
      expect(exposure.filter((e) => e.status === "not_checked").length).toBeGreaterThan(0);
      expect(r.trace.at(-1)).toMatchObject({ input_summary: "policy" });
    }
  });
});

describe("the pass over an engine that waits before each query", () => {
  // A wait of 5 ms is enough: every query yields to the event loop, so the tasks of a step overlap, and the properties
  // asserted (the queries in flight, the statements, the trace's order) hold at any wait; no duration is asserted.
  it("runs one query at a time at 1 and four at a time at 4, the same queries, the same trace in the same order, the same findings", async () => {
    const at = async (concurrency: number) => {
      const sql = await SqlJsEngine.create();
      sql.loadBundle(recorded);
      const { engine, seen } = slowEngine(sql, 5);
      const sqls: string[] = [];
      const counted: Engine = { ...engine, run: (s, o) => { sqls.push(s); return engine.run(s, o); } };
      const tracer = new MemTracer("test_concurrency_slow", { model: "none" });
      const result = await runPass(new DataLayer(counted), { tracer, world: new DriftWorld("test_concurrency_slow"), ledger: new MemoryLedger(sql), decidedAt: "2026-10-26T00:00:00.000Z", concurrency });
      sql.close();
      return { seen, sqls, trace: events(tracer), result };
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
  });
});
