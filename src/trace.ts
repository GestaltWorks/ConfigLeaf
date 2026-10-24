// JSONL trace. One line per agent action, written to stdout and to logs/<run>.jsonl.
// This is the evidence judges read: who did what, with which model, and whether it worked.

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config, redact } from "./config.ts";

export type TraceAction =
  | "observe" | "detect" | "triage" | "hypothesise" | "check" | "judge" | "decide"
  | "critique" | "revise" | "retry" | "fallback" | "escalate" | "query" | "model_call" | "spike";

export interface TraceEvent {
  ts: string;
  trace_id: string;
  agent: string;
  action: TraceAction;
  target_agent?: string;
  input_summary?: string;
  output_summary?: string;
  model_requested?: string;
  model_routed?: string;
  receipt_id?: string;
  signature_ok?: boolean;
  query_id?: string;
  tokens_in?: number;
  tokens_out?: number;
  latency_ms?: number;
  retry_count?: number;
  status: "ok" | "failed" | "needs_revision" | "not_checked" | "skipped";
  detail?: string;
}

export class Tracer {
  readonly traceId: string;
  private readonly file: string;

  constructor(traceId = `run_${Date.now().toString(36)}`) {
    this.traceId = traceId;
    mkdirSync(config.logDir, { recursive: true });
    this.file = path.join(config.logDir, `${traceId}.jsonl`);
  }

  emit(e: Omit<TraceEvent, "ts" | "trace_id">): TraceEvent {
    const full: TraceEvent = { ts: new Date().toISOString(), trace_id: this.traceId, ...e };
    if (full.detail) full.detail = redact(full.detail);
    const line = JSON.stringify(full);
    appendFileSync(this.file, line + "\n");
    process.stdout.write(line + "\n");
    return full;
  }
}
