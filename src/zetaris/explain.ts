// The plan Zetaris makes of the pass's cross-source queries: EXPLAIN QUERY AS <select> (administrators only, per the
// Lightning SQL reference) of the hero join over the tenant's latest nginx run and DNS run, and of the dns_live read,
// once per live pass (src/loop/pass.ts).
//
// Contract:
//   - One EXPLAIN QUERY AS per query through the engine given (a CountingEngine counts it), then one trace line: agent
//     zetaris, action explain, status ok, input "EXPLAIN QUERY AS <name>", output the plan's first line, detail the plan's
//     text through the trace's redactor (TRACE_REDACTOR: REDACT_SALT, one instance for the process, so the plan and every
//     other trace line share one salt) and cut to EXPLAIN_MAX (4,000) characters. A statement that fails (a key
//     that may not run it, a query Zetaris refuses) is traced not_checked with the error as the reason, never thrown.
//   - planText joins the plan's rows, one cell a line; firstLine is its first line with text.
//
// Measured on Zetaris 2.4.3.1, 26 Oct 2026 with the setup's admin key: EXPLAIN QUERY AS SELECT COUNT(*) FROM
// drift_usl.dns_live returns one row, one column plan, the parsed, analysed and optimised logical plans and the
// physical plan, its first line "== Parsed Logical Plan ==", in 2.7 s.

import type { QueryResult } from "../adapters/zetaris.ts";
import { redact } from "../config.ts";
import { assertSelectOnly, type Engine, type RunOptions } from "../data/layer.ts";
import { TRACE_REDACTOR, type Tracer } from "../trace.ts";

export const EXPLAIN_MAX = 4000;

/** The trace's own redactor (src/trace.ts): REDACT_SALT, the salt the stored rows carry, so a plan names the pseudonyms every other line names. */
const redactor = TRACE_REDACTOR;

export type PlanRead =
  | { query: string; status: "ok"; firstLine: string; chars: number; ms: number }
  | { query: string; status: "not_checked"; reason: string };

/** The plan's rows as text, one cell a line. */
export function planText(r: QueryResult): string {
  return r.rows.map((row) => row.join("\n")).join("\n");
}

/** The first line with text. */
export const firstLine = (s: string): string => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";

/** EXPLAIN QUERY AS one select, traced once (see the header). */
export async function explainQuery(engine: Pick<Engine, "run">, query: string, select: string, opts: { tracer?: Tracer } & RunOptions = {}): Promise<PlanRead> {
  const t0 = Date.now();
  try {
    assertSelectOnly(select);
    const r = await engine.run(`EXPLAIN QUERY AS ${select}`, { limit: 10, tracer: opts.tracer, agent: "zetaris" });
    const text = redactor.text(redact(planText(r))).slice(0, EXPLAIN_MAX);
    const first = firstLine(text);
    const ms = Date.now() - t0;
    opts.tracer?.emit({ agent: "zetaris", action: "explain", status: "ok", input_summary: `EXPLAIN QUERY AS ${query}`, output_summary: first, detail: text, latency_ms: ms });
    return { query, status: "ok", firstLine: first, chars: text.length, ms };
  } catch (e) {
    const reason = redactor.text(redact((e as Error).message ?? String(e))).slice(0, 300);
    opts.tracer?.emit({ agent: "zetaris", action: "explain", status: "not_checked", input_summary: `EXPLAIN QUERY AS ${query}`, output_summary: `not checked: ${reason}`, latency_ms: Date.now() - t0 });
    return { query, status: "not_checked", reason };
  }
}

/** "EXPLAIN hero: == Parsed Logical Plan ==" or "EXPLAIN hero not checked: <why>". */
export function planLine(p: PlanRead): string {
  return p.status === "ok" ? `EXPLAIN ${p.query}: ${p.firstLine} (${p.chars} characters traced)` : `EXPLAIN ${p.query} not checked: ${p.reason}`;
}
