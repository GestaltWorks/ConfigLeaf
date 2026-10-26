// Bounded concurrency for the pass (src/pipeline.ts), with everything a reader can see kept in the order a pass makes it one
// task at a time: the trace, the World Model, the ledger rows, the findings and their decisions. PASS_CONCURRENCY
// (src/config.ts) is the limit; at 1 the tasks run one after another, as the pass ran before it was concurrent.
//
//   inOrder       runs a step's tasks, at most `limit` in flight, each started in task order, so whatever a task does before
//                 its first await runs in task order too. A task reads and returns its commit, what it writes; the commits run
//                 in task order and one at a time, each started once the one before it has returned, so no two commits ever
//                 interleave, and a task's tracer is closed after its commit. A task or a commit that throws stops new starts;
//                 once the tasks in flight settle, every commit before the earliest failure runs, none after it does, and that
//                 failure is thrown, where a pass one task at a time would have stopped. A failure is never absorbed: the step,
//                 and the pass with it, rejects (src/pipeline.ts writes its dispositions to the ledger only after every step).
//   closing       wraps a commit with lines held for it (a finding's exposure line): they are closed on every path out of the
//                 commit, failed when it throws, so no held tracer stays open and stops OrderedTrace.
//   HeldTracer    a task's tracer: it holds the task's lines, and the places where lines held elsewhere come out (a finding's,
//                 under the detector that found it; a shared read's), until OrderedTrace writes them.
//   OrderedTrace  writes held lines to the pass's tracer in order, each as soon as every line before it is written: a held
//                 tracer's lines up to its first place still open, all of them once it is closed. A tracer that failed is the
//                 last one written, as the sequential trace ends at its failure.
//   SharedReads   a read several tasks need (a tenant's change windows, a DNS run's observations), run once by whichever task
//                 asks first. Every task that asks marks its place, under its own agent. The read's lines come out at the first
//                 place in order, which is where a pass one task at a time reads it, under that place's agent; every later
//                 place writes one line naming its agent and the key it reused. Who is named where depends on task order alone,
//                 never on which task happened to start the read. The read must depend on its key alone, so that whichever task
//                 starts it reads the same rows.
//
// Tested by test/concurrency.test.ts: the helpers on their own, sql.js under overlapping runs and interleaved writes and
// reads, the pass at concurrency 1 and 4 over the bundles, and the queries in flight over an engine that waits before each query.

import { MAX_PASS_CONCURRENCY } from "./config.ts";
import { Tracer, type TraceEvent } from "./trace.ts";

type Line = Omit<TraceEvent, "ts" | "trace_id">;

/** What a task writes once every earlier task's commit has run: the World Model, the ledger, the pass's own lists. */
export type Commit = () => void | Promise<void>;
/** A task of a pass step: it reads, its lines into its own tracer (undefined when the pass has none), and returns its commit. */
export type Task = (tracer: HeldTracer | undefined) => Promise<Commit>;

type Settled = { ok: true; commit: Commit } | { ok: false; error: unknown };

/** The limit as PASS_CONCURRENCY states it: a whole number from 1 to MAX_PASS_CONCURRENCY. */
export function checkLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PASS_CONCURRENCY) {
    throw new RangeError(`concurrency is a whole number from 1 to ${MAX_PASS_CONCURRENCY}, got ${limit}`);
  }
  return limit;
}

/**
 * `commit` with `lines` held for it: closed on every path out of it, failed when it throws (nothing after them is written),
 * closed when it returns, however early, so the lines held there can never keep OrderedTrace waiting.
 */
export function closing(lines: HeldTracer | undefined, commit: Commit): Commit {
  return async () => {
    try {
      await commit();
    } catch (error) {
      lines?.fail();
      throw error;
    } finally {
      lines?.close();
    }
  };
}

/**
 * Run `tasks`, at most `limit` at a time, started in task order, and their commits in task order (see the header). `tracerOf(i)`
 * is task i's tracer, taken when the task starts; it is closed after the commit, or marked failed when the task or its commit throws.
 * A `tracerOf` that throws fails its task the same way.
 */
export async function inOrder(tasks: readonly Task[], limit: number, tracerOf: (i: number) => HeldTracer | undefined): Promise<void> {
  checkLimit(limit);
  const tracers: (HeldTracer | undefined)[] = [];
  const settle: ((s: Settled) => void)[] = [];
  const settled = tasks.map((_, i) => new Promise<Settled>((resolve) => { settle[i] = resolve; }));
  let next = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped && next < tasks.length) {
      const i = next++;
      // Taking the tracer is part of the task: one that throws fails task i, so settled[i] always resolves.
      try {
        settle[i]({ ok: true, commit: await tasks[i]((tracers[i] = tracerOf(i))) });
      } catch (error) {
        stopped = true;
        settle[i]({ ok: false, error });
        tracers[i]?.fail();
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  try {
    for (let i = 0; i < tasks.length; i++) {
      const s = await settled[i];
      if (!s.ok) throw s.error;
      try {
        await s.commit();
      } catch (error) {
        tracers[i]?.fail();
        throw error;
      }
      tracers[i]?.close();
      // A commit can be long on the CPU (a run's thousands of observations into the World Model) and runs as one chain of
      // promise callbacks; yielding here lets the replies of the reads in flight land and the next reads start meanwhile.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    stopped = true;
    await Promise.all(workers);
  }
}

/**
 * Where a task asked for a shared read (SharedReads): the first such place in order writes the read's lines under its own
 * agent; every later one writes one line naming its agent and the read it reused.
 */
export class ReadPlace {
  constructor(private readonly lines: HeldTracer, private readonly key: string, readonly agent: string, private readonly claim: { first: ReadPlace | null }) {}

  writeTo(into: Tracer): "done" | "open" | "end" {
    this.claim.first ??= this;
    if (this.claim.first === this) return this.lines.writeTo(into, this.agent);
    into.emit({ agent: this.agent, action: "query", status: "skipped", input_summary: `reused ${this.key}`, output_summary: `shared read: run once this pass, where ${this.claim.first.agent} first asked` });
    return "done";
  }
}

/** A task's tracer: its lines are held, in the order emitted, until OrderedTrace writes them (see the header). */
export class HeldTracer extends Tracer {
  private readonly held: (Line | HeldTracer | ReadPlace)[] = [];
  private written = 0;
  private closed = false;
  private failed = false;

  constructor(private readonly order: OrderedTrace) {
    super(order.into.traceId);
  }

  /** Hold the line; the pass's tracer builds and writes it in its turn. What this returns is the line as held, not as written. */
  override emit(e: Line): TraceEvent {
    this.held.push(e);
    return { ts: new Date().toISOString(), trace_id: this.traceId, ...e };
  }

  /** A held tracer whose lines come out here, after the lines held so far: a finding's, under the detector that found it. */
  hold(): HeldTracer {
    const h = new HeldTracer(this.order);
    this.held.push(h);
    return h;
  }

  /** A shared read's place: its lines come out here when it is the first place in order, else one line saying it was reused. */
  place(p: ReadPlace): void {
    this.held.push(p);
  }

  /** Nothing more is held here: what the order allows is written. */
  close(): void {
    this.closed = true;
    this.order.write();
  }

  /** The task failed: what is held here is written in its turn, and nothing after it. */
  fail(): void {
    this.failed = true;
    this.close();
  }

  /**
   * Write what is held, in order, into `into`, down to the first tracer still open; "end" after a failed one. `agent`, for a
   * shared read's lines, names the agent of the first place in order on each of them.
   */
  writeTo(into: Tracer, agent?: string): "done" | "open" | "end" {
    for (; this.written < this.held.length; this.written++) {
      const x = this.held[this.written];
      if (x instanceof HeldTracer || x instanceof ReadPlace) {
        const r = x instanceof HeldTracer ? x.writeTo(into, agent) : x.writeTo(into);
        if (r !== "done") return r;
      } else into.emit(agent === undefined ? x : { ...x, agent });
    }
    return !this.closed ? "open" : this.failed ? "end" : "done";
  }
}

/** The pass's tracer behind the held ones: lines written in task order, nothing after a failed task's. */
export class OrderedTrace {
  private readonly root: HeldTracer;
  private ended = false;

  constructor(readonly into: Tracer) {
    this.root = new HeldTracer(this);
  }

  /** A task's tracer: its lines come out after those of every tracer taken before it. */
  next(): HeldTracer {
    return this.root.hold();
  }

  /** A tracer placed nowhere yet: a shared read's, its lines out where the first task in order places it. */
  apart(): HeldTracer {
    return new HeldTracer(this);
  }

  write(): void {
    if (!this.ended && this.root.writeTo(this.into) === "end") this.ended = true;
  }
}

/** Reads shared by the tasks of a pass, each run once per key (see the header). */
export class SharedReads {
  private readonly reads = new Map<string, { value: Promise<unknown>; lines: HeldTracer | undefined; claim: { first: ReadPlace | null }; askers: Set<HeldTracer> }>();

  constructor(private readonly order: OrderedTrace | undefined) {}

  /**
   * `read`'s value for `key`, run by the first task to ask; `tracer` is the asking task's, undefined only when the pass has none,
   * and `agent` the agent it asks as. A task that asks again for the same key marks no second place.
   */
  read<V>(key: string, tracer: HeldTracer | undefined, agent: string, read: (tracer: HeldTracer | undefined) => Promise<V>): Promise<V> {
    let r = this.reads.get(key);
    if (r === undefined) {
      const lines = this.order?.apart();
      r = { lines, value: (async () => read(lines))().finally(() => lines?.close()), claim: { first: null }, askers: new Set() };
      this.reads.set(key, r);
    }
    if (r.lines && tracer && !r.askers.has(tracer)) {
      r.askers.add(tracer);
      tracer.place(new ReadPlace(r.lines, key, agent, r.claim));
    }
    return r.value as Promise<V>;
  }
}
