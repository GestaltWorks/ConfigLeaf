// The loop's tracer: a Tracer (src/trace.ts) whose events go to logs/<trace id>.jsonl only, so a pass, a cycle or a
// watch prints its own lines on stdout and keeps the trace in the file.
//
// Contract: every event is built as src/trace.ts builds it (timestamp, trace id, the model default, every free-text
// field through the redactor) and appended as one JSON line to `logFile`; `lines` counts the lines written.
// LabelTracer hands each event to another tracer with its free-text fields through a given redactor first: the
// tickets step's tracer, whose redactor pseudonymises the EXPORT_DENY_WORDS labels as well (src/loop/steps.ts).

import { appendFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import type { Redactor } from "../redactor.ts";
import { Tracer, type TraceEvent } from "../trace.ts";

export class LabelTracer extends Tracer {
  constructor(private readonly inner: Tracer, private readonly labels: Redactor) {
    super(inner.traceId);
  }

  override emit(e: Omit<TraceEvent, "ts" | "trace_id">): TraceEvent {
    const r = (s: string | undefined): string | undefined => (s ? this.labels.text(s) : s);
    return this.inner.emit({ ...e, input_summary: r(e.input_summary), output_summary: r(e.output_summary), detail: r(e.detail) });
  }
}

export class FileTracer extends Tracer {
  readonly logFile = path.join(config.logDir, `${this.traceId}.jsonl`);
  lines = 0;

  override emit(e: Omit<TraceEvent, "ts" | "trace_id">): TraceEvent {
    const full = this.build(e);
    appendFileSync(this.logFile, `${JSON.stringify(full)}\n`);
    this.lines += 1;
    return full;
  }
}
