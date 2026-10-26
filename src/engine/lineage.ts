// The lineage of a decision that recalled a lesson: `npm run why -- --finding <id>`.
//
// The Decider (src/pipeline.ts) recalls the technician's lessons by exact scope key and records the one that settled a
// finding on the finding itself (Finding.exception). This module follows that lesson back through the trust ledger of the
// store the pass read (the reference's append-only ledger, example 08-trust-ledger): the correction it was taught from,
// who taught it and when, the conflicts it met and who settled each, the rules approved from it (dreaming's derivedFrom
// lineage), and the entries the ledger holds for it. Reading only: a store opened "read" is never written.
//
// The recall score is the reference's own hybrid ranking (MemoryRetrievalService.scoreOne) of the lesson for the query
// "<finding class> <scope key>", the two facts the Decider matched on. The Decider matches by exact scope key and gates on
// no score; the number says how the reference ranks the lesson for that query, against its retrieval threshold.
import type { LedgerEntry } from "../../vendor/hmem/src/index.ts";
import type { Finding } from "../pipeline.ts";
import { rulesFrom, type Rule } from "./dreaming.ts";
import { DEFAULTS, scopeValuesOf, type Lesson, type ScopeType, type TechnicianMemory } from "./memory.ts";

export interface ConflictMet {
  id: string;
  /** The other lesson. */
  other: string;
  /** "new": this lesson was recorded against a held one; "held": a later lesson was recorded against this one. */
  side: "new" | "held";
  reason: string;
  confidence: number;
  detectedAt: string;
  resolution: null | { strategy: string; by: string; at: string; winner: string | null };
}

export interface LessonLineage {
  lesson: Lesson;
  status: "applied" | "lapsed";
  correction: { text: string; origin: string; source: string; label: string; taughtBy: string; taughtAt: string; recordedAt: string; run: string | null };
  matched: { type: ScopeType; key: string };
  score: { value: number; query: string; threshold: number };
  conflicts: ConflictMet[];
  rules: Rule[];
  history: LedgerEntry[];
}

export interface Lineage {
  finding: { id: string; class: string; where: string; summary: string };
  decision: { verb: string; reason: string; expiresAt: string | null; decidedBy: string; ruleId: string | null };
  /** Null when no lesson, in force or lapsed, settled the decision. */
  lesson: LessonLineage | null;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const SCOPE_ORDER: ScopeType[] = ["name", "host", "address"];

function conflictsOf(memory: TechnicianMemory, id: string): ConflictMet[] {
  const entries = memory.ledgerEntries();
  const met: ConflictMet[] = [];
  for (const e of entries) {
    if (e.action !== "conflict_detected") continue;
    const d = (e.details ?? {}) as { conflictId?: string; with?: string; reason?: string; confidence?: number };
    const side = e.memoryId === id ? "new" : d.with === id ? "held" : null;
    if (!side || !d.conflictId) continue;
    const r = entries.find((x) => x.action === "conflict_resolved" && (x.details as { conflictId?: string } | undefined)?.conflictId === d.conflictId);
    const rd = (r?.details ?? {}) as { strategy?: string; winner?: string };
    met.push({
      id: d.conflictId, other: side === "new" ? d.with ?? "?" : e.memoryId, side, reason: d.reason ?? "", confidence: d.confidence ?? 0, detectedAt: iso(e.timestamp),
      resolution: r ? { strategy: rd.strategy ?? "?", by: r.actor, at: iso(r.timestamp), winner: rd.winner ?? null } : null,
    });
  }
  return met;
}

/** The lineage of one finding of a pass that was given `memory`. */
export function lineageOf(memory: TechnicianMemory, found: Finding): Lineage {
  const f = found.finding;
  const base = {
    finding: { id: found.id, class: f.class, where: [f.host ?? f.surface, f.object_id, f.setting_path].filter(Boolean).join(" "), summary: f.summary },
    decision: { verb: found.verb, reason: found.disposition.reason, expiresAt: found.disposition.expires_at, decidedBy: found.disposition.decided_by, ruleId: found.disposition.rule_id },
  };
  const note = found.exception;
  const lesson = note ? memory.lesson(note.lesson) : null;
  const record = lesson ? memory.hmem.store.get(lesson.id) : undefined;
  if (!note || !lesson || !record) return { ...base, lesson: null };
  const key = lesson.kind === "exception" ? lesson.scopeKey : lesson.scope.key;
  const values = scopeValuesOf(f);
  const query = `${f.class} ${key}`;
  return {
    ...base,
    lesson: {
      lesson,
      status: note.status,
      correction: {
        text: lesson.kind === "exception" ? lesson.reason : `Q ${lesson.question} A ${lesson.answer}`,
        origin: record.provenance.origin, source: record.source, label: record.provenance.label,
        taughtBy: lesson.provenance.by, taughtAt: lesson.provenance.at, recordedAt: lesson.recordedAt, run: lesson.provenance.runId ?? null,
      },
      matched: { type: SCOPE_ORDER.find((t) => values[t].includes(key)) ?? "name", key },
      score: { value: memory.hmem.retrieval.scoreOne(record, query), query, threshold: DEFAULTS.retrievalThreshold },
      conflicts: conflictsOf(memory, lesson.id),
      rules: rulesFrom(memory, lesson.id),
      // Its own entries, and the resolutions logged under a lesson it superseded (the reference logs conflict_resolved under the loser).
      history: memory.ledgerEntries().filter((e) => e.memoryId === lesson.id || (e.action === "conflict_resolved" && (e.details as { winner?: string } | undefined)?.winner === lesson.id)),
    },
  };
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function entryLine(e: LedgerEntry): string {
  const d = (e.details ?? {}) as Record<string, unknown>;
  const note = e.action === "conflict_detected" ? ` with ${String(d.with)}`
    : e.action === "conflict_resolved" ? ` ${String(d.strategy)}${d.winner ? `, winner ${String(d.winner)}` : d.with ? ` with ${String(d.with)}` : ""}`
      : e.action === "dream_approved" ? ` proposal ${String(d.proposalId)}`
        : "";
  return `${iso(e.timestamp)}  ${e.action}${note}  by ${e.actor}`;
}

/** The lineage as the command prints it. */
export function renderLineage(l: Lineage): string[] {
  const out = [
    `why ${l.finding.id}`,
    `  finding     ${l.finding.class}: ${clip(l.finding.where, 150)}`,
    `  decision    ${l.decision.verb}${l.decision.expiresAt ? ` until ${l.decision.expiresAt}` : ""}, decided by ${l.decision.decidedBy}${l.decision.ruleId ? ` under ${l.decision.ruleId}` : ""}`,
    `  because     ${clip(l.decision.reason, 220)}`,
  ];
  const x = l.lesson;
  if (!x) {
    out.push("  lesson      none recalled: no exception of this class on this finding's host, name or address, in force or lapsed, settled it");
    return out;
  }
  const s = x.lesson;
  out.push(`  lesson      ${s.id}, ${s.kind === "exception" ? `exception for ${s.findingClass}` : "answer"} on ${x.matched.key} (${s.tenantId}), ${x.status === "applied" ? `in force until ${s.expiresAt}` : `lapsed ${s.expiresAt}, so the finding is re-raised`}`);
  out.push(`  correction  ${JSON.stringify(x.correction.text)}`);
  out.push(`              taught by ${x.correction.taughtBy} at ${x.correction.taughtAt}${x.correction.run ? ` in pass ${x.correction.run}` : ""}, recorded ${x.correction.recordedAt}; H-MEM origin ${x.correction.origin}, source ${x.correction.source}`);
  out.push(`  recall      the finding's ${x.matched.type} ${x.matched.key} is the lesson's scope key, same tenant, same class: an exact match`);
  out.push(`              score ${x.score.value.toFixed(2)} for "${x.score.query}" in the reference's hybrid ranking (retrieval threshold ${x.score.threshold}); the Decider gates on the exact match and on no score`);
  if (!x.conflicts.length) out.push("  conflicts   none met");
  for (const c of x.conflicts) {
    out.push(`  conflict    ${c.id}: ${c.side === "new" ? "recorded against" : "a later lesson recorded against this one,"} ${c.other}, detected ${c.detectedAt}: ${clip(c.reason, 200)}`);
    out.push(c.resolution
      ? `              settled ${c.resolution.strategy}${c.resolution.winner ? ` (winner ${c.resolution.winner})` : ""} by ${c.resolution.by} at ${c.resolution.at}`
      : "              not settled");
  }
  if (!x.rules.length) out.push("  rules       none approved from this lesson");
  for (const r of x.rules) out.push(`  rule        ${r.id} (${r.type}, proposal ${r.proposalId}) approved by ${r.approvedBy} at ${r.approvedAt}, derived from ${r.derivedFrom.length} lesson(s): ${clip(r.derivedFrom.join(" "), 120)}`);
  out.push(`  ledger      ${x.history.length} entr${x.history.length === 1 ? "y" : "ies"} for ${s.id}`);
  for (const e of x.history) out.push(`              ${entryLine(e)}`);
  return out;
}
