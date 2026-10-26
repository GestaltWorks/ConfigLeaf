// Where the Scout guard meets a prompt: the helpers every prompt builder calls on the text it is about to send to a
// model (src/agents/judge.ts judgeClaim, src/actions/investigate.ts, src/eval/models.ts). Each one asks decide()
// (src/guard/scout.ts) about the raw input and the snippets of one prompt, in the spec's order, and acts on the answer.
//
// Contract:
//   - A text the guard blocks is replaced by WITHHELD before the prompt is built, so the model never reads one byte of
//     it. A text the guard flags for review goes through unchanged. Rules still decide every verb; the guard only
//     withholds text.
//   - Every block and every review leaves one trace line, agent as given, action "guard": the prompt it was bound for,
//     the class, the rule id, the text's source label and line number. The line never carries the text. An allow leaves
//     no line.
//   - A GuardNote is the same facts for a caller that records them: noteLine() is the sentence the action record and
//     so the ticket's Evidence section carry ("guard blocked indirect_injection in finding.value_redacted line 3 ...").
//   - The claim a judge is asked to refute is the raw input of its prompt. When the guard blocks it, there is nothing
//     left to judge: guardJudgePrompt says so and judgeClaim files not_judged without a call, and decide() has not
//     scanned the cells, as the spec's order has it. The evidence cells and the finding's fields are snippets: a
//     blocked one is withheld and the call goes out without it.

import type { Evidence } from "../agents/judge.ts";
import type { TraceEvent } from "../trace.ts";
import { decide, type Pass, type Snippet, type TextDecision, type ThreatClass } from "./scout.ts";

/** What a withheld text becomes in the prompt. */
export const WITHHELD = "[withheld by the Scout guard]";

/** Where the guard's trace lines go: a Tracer, or a test's memory tracer. */
export interface GuardTracer { emit(e: Omit<TraceEvent, "ts" | "trace_id">): unknown }

export interface GuardOptions {
  tracer?: GuardTracer;
  /** The trace line's agent. */
  agent: string;
  /** Which prompt the text was bound for, in a few words ("Lightning selection", "Ultra judge"). */
  prompt: string;
}

/** What the guard found in one text: facts only, never the text. */
export interface GuardNote {
  prompt: string;
  source: string;
  class: ThreatClass;
  rule: string;
  level: "review" | "block";
  line: number;
  reason: string;
}

/** One sentence for an action record: the note and what became of the text. */
export function noteLine(n: GuardNote): string {
  return n.level === "block"
    ? `guard blocked ${n.class} in ${n.source} line ${n.line} (${n.prompt}): ${n.reason}; the text was withheld from the model and the rules decide`
    : `guard flagged ${n.class} in ${n.source} line ${n.line} (${n.prompt}) for review: ${n.reason}; the text went to the model`;
}

/** The note for one decision, its trace line written; null when the guard has nothing to say. */
function note(d: TextDecision, o: GuardOptions): GuardNote | null {
  const h = d.hits[0];
  if (!h) return null;
  const n: GuardNote = { prompt: o.prompt, source: d.source, class: h.class, rule: h.rule, level: h.level, line: h.line, reason: h.reason };
  o.tracer?.emit({
    agent: o.agent, action: "guard", status: n.level === "block" ? "failed" : "needs_revision",
    input_summary: `${n.prompt}: ${n.source}`,
    output_summary: `${n.level} ${n.class} at ${n.source} line ${n.line}`,
    detail: `${d.hits.map((x) => x.rule).join(", ")}: ${n.reason}; ${n.level === "block" ? "the text was withheld from the model" : "the text went to the model"}; the text is not recorded`,
  });
  return n;
}

/** One text through the guard: the text to send and the note, null when the guard has nothing to say. */
export function guardText(text: string, source: string, pass: Pass, o: GuardOptions): { text: string; note: GuardNote | null } {
  const d = decide(pass === "input" ? { prompt: { source, text } } : { snippets: [{ source, text }] });
  const t = pass === "input" ? d.input! : d.snippets[0];
  return { text: t.level === "block" ? WITHHELD : text, note: note(t, o) };
}

/** A finding's string fields, each a snippet named finding.<field>; the finding to send and the notes. */
export function guardFinding<T extends object>(finding: T, o: GuardOptions): { finding: T; notes: GuardNote[] } {
  const fields = Object.entries(finding).filter((e): e is [string, string] => typeof e[1] === "string");
  const d = decide({ snippets: fields.map(([k, v]) => ({ source: `finding.${k}`, text: v })) });
  const out = { ...finding } as Record<string, unknown>;
  const notes: GuardNote[] = [];
  fields.forEach(([k], i) => {
    const t = d.snippets[i];
    if (t.level === "block") out[k] = WITHHELD;
    const n = note(t, o);
    if (n) notes.push(n);
  });
  return { finding: out as T, notes };
}

export interface GuardedJudgePrompt {
  claim: string;
  evidence: Evidence;
  /** The guard blocked the claim: no prompt is built and no model is called. */
  claimBlocked: boolean;
  notes: GuardNote[];
}

/**
 * The claim a judge refutes (raw input) and the first `shown` evidence rows (snippets, one cell at a time), the rows the
 * prompt carries. Rows past `shown` never reach the model and are not read.
 */
export function guardJudgePrompt(claim: string, evidence: Evidence, shown: number, o: GuardOptions): GuardedJudgePrompt {
  const cells: { r: number; i: number; snippet: Snippet }[] = [];
  evidence.rows.slice(0, shown).forEach((row, r) => row.forEach((cell, i) => {
    if (typeof cell === "string") cells.push({ r, i, snippet: { source: `evidence row ${r + 1} ${evidence.columns[i] ?? `column ${i + 1}`}`, text: cell } });
  }));
  const d = decide({ prompt: { source: "claim", text: claim }, snippets: cells.map((c) => c.snippet) });
  const notes: GuardNote[] = [];
  const claimNote = note(d.input!, o);
  if (claimNote) notes.push(claimNote);
  if (d.input!.level === "block") return { claim: WITHHELD, evidence, claimBlocked: true, notes };
  const rows = evidence.rows.map((row) => [...row]);
  cells.forEach((c, k) => {
    const t = d.snippets[k];
    if (t.level === "block") rows[c.r][c.i] = WITHHELD;
    const n = note(t, o);
    if (n) notes.push(n);
  });
  return { claim, evidence: { columns: evidence.columns, rows }, claimBlocked: false, notes };
}
