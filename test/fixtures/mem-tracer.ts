// A Tracer that keeps events in memory instead of writing logs/ and stdout. Events are built exactly as
// the real one writes them (model default, every free-text field redacted), so a test asserts on what a
// judge would read and the sample bundle's vocabulary is shown to survive the redactor.
import { Tracer, type TraceEvent } from "../../src/trace.ts";

export class MemTracer extends Tracer {
  events: TraceEvent[] = [];
  override emit(e: Omit<TraceEvent, "ts" | "trace_id">): TraceEvent {
    const full = this.build(e);
    this.events.push(full);
    return full;
  }
}
