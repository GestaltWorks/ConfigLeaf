// The watcher: one cycle (src/loop/cycle.ts) after another on a schedule until its signal aborts, as a function with
// an injectable cycle, clock and sleep, so a test runs it with fakes. scripts/watch.ts gives it the live cycle and
// SIGINT.
//
// Contract:
//   - Cycles start every `everyMs` from the start of the previous one; a cycle that runs longer than the interval
//     is followed at once by the next. Each cycle starts after the previous one returns.
//   - Each cycle prints its own table (src/loop/present.ts, its header numbered by the caller); after it the watcher
//     prints one line, "next cycle <n+1> at <YYYY-MM-DD HH:MM> UTC", or "stopping after cycle <n>" when the signal
//     aborted during the cycle, and a blank line before the next cycle's header. A cycle that throws gives its message
//     in one red row, "cycle failed the cycle threw: <message>", and the watcher goes on to the next one. --verbose
//     adds after that line the full one: "WATCH <n> <started at>: <the cycle's CYCLE line>; next cycle at <ISO>" (or
//     "; stopping").
//   - The signal ends the sleep at once and the cycle in progress runs to its end, so a write it began is recorded.
//
// Measured 24 Oct 2026: test/loop.test.ts runs four fake cycles on a fake clock: one inside the interval, an overrun,
// a throw, and the stop.

import { redact } from "../config.ts";
import type { CycleResult } from "./cycle.ts";
import { PLAIN, Table, utcMinute, type PresentOptions } from "./present.ts";

export interface WatchOptions {
  everyMs: number;
  cycle: (n: number) => Promise<Pick<CycleResult, "summary" | "stopped">>;
  signal: AbortSignal;
  print?: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  scrub?: (s: string) => string;
  present?: PresentOptions;
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
  const present = o.present ?? PLAIN;
  const table = new Table(present, scrub);
  const res: WatchResult = { cycles: 0, stopped: 0, threw: 0 };
  while (!o.signal.aborted) {
    res.cycles += 1;
    if (res.cycles > 1) print("");
    const started = now();
    let line: string;
    try {
      const c = await o.cycle(res.cycles);
      if (c.stopped) res.stopped += 1;
      line = `WATCH ${res.cycles} ${started.toISOString()}: ${c.summary}`;
    } catch (e) {
      res.threw += 1;
      const msg = scrub(e instanceof Error ? e.message : String(e));
      line = `WATCH ${res.cycles} ${started.toISOString()}: the cycle threw: ${msg}`;
      print(table.failed("cycle", `the cycle threw: ${msg}`, null));
    }
    if (o.signal.aborted) {
      print(`stopping after cycle ${res.cycles}`);
      if (present.verbose) print(`${line}; stopping`);
      break;
    }
    const next = Math.max(started.getTime() + o.everyMs, now().getTime());
    print(`next cycle ${res.cycles + 1} at ${utcMinute(new Date(next))}`);
    if (present.verbose) print(`${line}; next cycle at ${new Date(next).toISOString()}`);
    await wait(next - now().getTime(), o.signal);
  }
  return res;
}
