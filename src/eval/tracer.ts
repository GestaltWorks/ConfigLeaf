// The eval's tracer: every event built as src/trace.ts builds it (redacted, timestamped) and appended to
// logs/<trace id>.jsonl, with stdout left to the runner's own lines; and logLine, one plain line appended to
// logs/<name>.log, for a live run's per-call evidence.

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { Tracer, type TraceEvent } from "../trace.ts";

export class LogTracer extends Tracer {
  readonly logFile = path.join(config.logDir, `${this.traceId}.jsonl`);

  override emit(e: Omit<TraceEvent, "ts" | "trace_id">): TraceEvent {
    const full = this.build(e);
    appendFileSync(this.logFile, JSON.stringify(full) + "\n");
    return full;
  }
}

/** Append one line to logs/<name>.log and return the file's path. */
export function logLine(name: string, line: string): string {
  mkdirSync(config.logDir, { recursive: true });
  const file = path.join(config.logDir, `${name}.log`);
  appendFileSync(file, line + "\n");
  return file;
}
