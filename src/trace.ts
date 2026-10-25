// JSONL trace. One line per agent action, written to stdout and to logs/<run>.jsonl.
// This is the evidence judges read: who did what, with which model, and whether it worked.

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config, redact } from "./config.ts";
import { Redactor } from "./redactor.ts";

/**
 * Every free-text field (input_summary, output_summary, detail) goes through the same redactor as
 * collected data, so a trace line carries the pseudonyms the stored observations carry when
 * REDACT_SALT is set. With the salt blank each process draws its own: pseudonyms stay stable within
 * a run and cannot be linked across runs. The agent's own dotted vocabulary (surfaces, setting
 * paths, SQL aliases) survives the pass; see redactor.ts, pass d.
 */
const redactor = new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords);

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
  /** On every query event: the DataLayer engine that answered, Zetaris Lightning SQL (live) or sql.js (sample, tests). */
  engine?: "zetaris" | "sqljs";
  tokens_in?: number;
  tokens_out?: number;
  latency_ms?: number;
  retry_count?: number;
  status: "ok" | "failed" | "needs_revision" | "not_checked" | "skipped" | "not_judged" | "substituted";
  detail?: string;
}

export class Tracer {
  readonly traceId: string;
  private readonly file: string;
  private readonly model: string | undefined;

  /**
   * `model` is this tracer's default for model_requested, set on every event that does not name one:
   * a pass that calls no model constructs `new Tracer(id, { model: "none" })` so every line says so.
   */
  constructor(traceId = `run_${Date.now().toString(36)}`, opts: { model?: string } = {}) {
    this.traceId = traceId;
    this.model = opts.model;
    mkdirSync(config.logDir, { recursive: true });
    this.file = path.join(config.logDir, `${traceId}.jsonl`);
  }

  /** The event as it is written: timestamp, trace id, the model default, every free-text field redacted. */
  protected build(e: Omit<TraceEvent, "ts" | "trace_id">): TraceEvent {
    const full: TraceEvent = { ts: new Date().toISOString(), trace_id: this.traceId, ...e };
    if (this.model !== undefined && full.model_requested === undefined) full.model_requested = this.model;
    for (const k of ["input_summary", "output_summary", "detail"] as const) if (full[k]) full[k] = redactor.text(redact(full[k]));
    return full;
  }

  emit(e: Omit<TraceEvent, "ts" | "trace_id">): TraceEvent {
    const full = this.build(e);
    const line = JSON.stringify(full);
    appendFileSync(this.file, line + "\n");
    process.stdout.write(line + "\n");
    return full;
  }
}
