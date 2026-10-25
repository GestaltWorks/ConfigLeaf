// The watcher: one cycle (src/loop/cycle.ts) after another on a schedule until its signal aborts, as a function with
// an injectable cycle, clock and sleep, so a test runs it with fakes. scripts/watch.ts gives it the live cycle and
// SIGINT.
//
// Contract:
//   - Cycles start every `everyMs` from the start of the previous one; a cycle that runs longer than the interval
//     is followed at once by the next. Each cycle starts after the previous one returns.
//   - One printed line per cycle: "WATCH <n> <started at>: <the cycle's CYCLE line>; next cycle at <ISO>", or
//     "...; stopping" when the signal aborted during the cycle. A cycle that throws gives its message in the line and
//     the watcher goes on to the next one.
//   - The signal ends the sleep at once and the cycle in progress runs to its end, so a write it began is recorded.
//
// Measured 24 Oct 2026: test/loop.test.ts runs four fake cycles on a fake clock: one inside the interval, an overrun,
// a throw, and the stop.

import { redact } from "../config.ts";
import type { CycleResult } from "./cycle.ts";

export interface WatchOptions {
  everyMs: number;
  cycle: (n: number) => Promise<Pick<CycleResult, "summary" | "stopped">>;
  signal: AbortSignal;
  print?: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  scrub?: (s: string) => string;
}

export interface WatchResult { cycles: number; stopped: number; threw: number }

/** setTimeout that the signal ends early. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function watch(o: WatchOptions): Promise<WatchResult> {
  const now = o.now ?? (() => new Date());
  const print = o.print ?? ((l: string) => console.log(l));
  const wait = o.sleep ?? sleep;
  const scrub = o.scrub ?? redact;
  const res: WatchResult = { cycles: 0, stopped: 0, threw: 0 };
  while (!o.signal.aborted) {
    res.cycles += 1;
    const started = now();
    let line: string;
    try {
      const c = await o.cycle(res.cycles);
      if (c.stopped) res.stopped += 1;
      line = `WATCH ${res.cycles} ${started.toISOString()}: ${c.summary}`;
    } catch (e) {
      res.threw += 1;
      line = `WATCH ${res.cycles} ${started.toISOString()}: the cycle threw: ${scrub(e instanceof Error ? e.message : String(e))}`;
    }
    if (o.signal.aborted) {
      print(`${line}; stopping`);
      break;
    }
    const next = Math.max(started.getTime() + o.everyMs, now().getTime());
    print(`${line}; next cycle at ${new Date(next).toISOString()}`);
    await wait(next - now().getTime(), o.signal);
  }
  return res;
}
