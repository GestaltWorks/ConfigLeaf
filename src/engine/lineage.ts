// The lineage of a decision that recalled a lesson: `npm run why -- --finding <id>`.
//
// The Decider (src/pipeline.ts) recalls the technician's lessons by exact scope key and records the one that settled a
// finding on the finding itself (Finding.exception). This module follows that lesson back through the trust ledger of the
// store the pass read (the reference's append-only ledger, example 08-trust-ledger): the correction it was taught from,
// who taught it and when, the conflicts it met and who settled each, and the entries the ledger holds for it. When the
// recalled lesson is a rule approved from dreaming (src/engine/dreaming.ts), the decision is covered by that rule: the
// lineage names the rule and the lessons it is derived from, and follows the lessons that state this finding's scope key
// back to their corrections. Reading only: a store opened "read" is never written.
//
// The recall score is the reference's own hybrid ranking (MemoryRetrievalService.scoreOne) of the lesson for the query
// "<finding class> <scope key>", the two facts the Decider matched on. The Decider matches by exact scope key and gates on
// no score; the number says how the reference ranks the lesson for that query, against its retrieval threshold.
import { z } from "zod";
import type { LedgerEntry } from "../../vendor/hmem/src/index.ts";
import type { Finding } from "../pipeline.ts";
import { isRule } from "./dreaming.ts";
import { DEFAULTS, MemoryError, oneLine, scopeValuesOf, type Lesson, type ScopeType, type TechnicianMemory } from "./memory.ts";

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

/** A lesson the technician taught, and what its record says of where it came from. */
export interface Taught {
  lesson: Lesson;
  correction: { text: string; origin: string; source: string; label: string; taughtBy: string; taughtAt: string; recordedAt: string; run: string | null };
}

export interface LessonLineage {
  /** The lesson or rule the Decider recalled, with the scope key the finding matched. */
  lesson: Lesson;
  status: "applied" | "lapsed";
  matched: { type: ScopeType; key: string };
  score: { value: number; query: string; threshold: number };
  /** Set when the recalled lesson is a rule: the decision is covered by it. */
  rule: null | { id: string; proposalId: string; derivedFrom: string[]; approvedBy: string; approvedAt: string };
  /** The lessons that state this finding's scope key: the recalled lesson itself, or for a rule the lessons it is derived from on that key. */
  taught: Taught[];
  conflicts: ConflictMet[];
  /** The recalled lesson's own ledger entries, and the resolutions logged under a lesson it superseded. */
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

// The details the ledger holds for the entries this module reads, as TechnicianMemory writes them. A ledger entry of one of these
// actions whose details do not match is corrupt or from another schema: reading it fails loudly, naming the entry, and nothing
// is guessed.
const DETECTED = z.object({ conflictId: z.string().min(1), with: z.string().min(1), reason: z.string(), confidence: z.number() });
const RESOLVED = z.object({ conflictId: z.string().min(1), strategy: z.enum(["supersede", "keep_both"]), winner: z.string().min(1).optional(), with: z.string().min(1).optional() });
const APPROVED = z.object({ proposalId: z.string().min(1), derivedFrom: z.array(z.string()) });

function detailsOf<T extends z.ZodType>(schema: T, e: LedgerEntry): z.infer<T> {
  const r = schema.safeParse(e.details);
  if (r.success) return r.data;
  throw new MemoryError(`the ledger entry ${e.action} for ${e.memoryId} at ${iso(e.timestamp)} has malformed details: ${r.error.issues.map((i) => `${i.path.join(".") || "details"} ${i.message}`).join("; ")}`);
}

/** The winner a conflict_resolved entry names, if any. */
const winnerOf = (e: LedgerEntry): string | undefined => (e.action === "conflict_resolved" ? detailsOf(RESOLVED, e).winner : undefined);

function conflictsOf(memory: TechnicianMemory, id: string): ConflictMet[] {
  const entries = memory.ledgerEntries();
  const resolved = new Map<string, { entry: LedgerEntry; details: z.infer<typeof RESOLVED> }>();
  for (const e of entries) if (e.action === "conflict_resolved") resolved.set(detailsOf(RESOLVED, e).conflictId, { entry: e, details: detailsOf(RESOLVED, e) });
  const met: ConflictMet[] = [];
  for (const e of entries) {
    if (e.action !== "conflict_detected") continue;
    const d = detailsOf(DETECTED, e);
    const side = e.memoryId === id ? "new" : d.with === id ? "held" : null;
    if (!side) continue;
    const r = resolved.get(d.conflictId);
    met.push({
      id: d.conflictId, other: side === "new" ? d.with : e.memoryId, side, reason: d.reason, confidence: d.confidence, detectedAt: iso(e.timestamp),
      resolution: r ? { strategy: r.details.strategy, by: r.entry.actor, at: iso(r.entry.timestamp), winner: r.details.winner ?? null } : null,
    });
  }
  return met;
}

function taughtOf(memory: TechnicianMemory, lesson: Lesson): Taught {
  const record = memory.hmem.store.get(lesson.id);
  return {
    lesson,
    correction: {
      text: lesson.kind === "exception" ? lesson.reason : `Q ${lesson.question} A ${lesson.answer}`,
      origin: record?.provenance.origin ?? "?", source: record?.source ?? "?", label: record?.provenance.label ?? "",
      taughtBy: lesson.provenance.by, taughtAt: lesson.provenance.at, recordedAt: lesson.recordedAt, run: lesson.provenance.runId ?? null,
    },
  };
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
  const key = note.scope_key;
  const values = scopeValuesOf(f);
  const query = `${f.class} ${key}`;
  const rule = isRule(lesson) ? lesson : null;
  const taught = (rule ? rule.derivedFrom.map((id) => memory.lesson(id)).filter((l): l is Lesson => l !== null && l.kind === "exception" && l.scopeKey === key) : [lesson]).map((l) => taughtOf(memory, l));
  const conflicts = new Map<string, ConflictMet>();
  for (const l of [lesson, ...taught.map((t) => t.lesson)]) for (const c of conflictsOf(memory, l.id)) conflicts.set(c.id, c);
  return {
    ...base,
    lesson: {
      lesson,
      status: note.status,
      matched: { type: SCOPE_ORDER.find((t) => values[t].includes(key)) ?? "name", key },
      score: { value: memory.hmem.retrieval.scoreOne(record, query), query, threshold: DEFAULTS.retrievalThreshold },
      rule: rule ? { id: rule.id, proposalId: rule.proposalId ?? "", derivedFrom: rule.derivedFrom, approvedBy: rule.provenance.by, approvedAt: rule.recordedAt } : null,
      taught,
      conflicts: [...conflicts.values()],
      // Its own entries, and the resolutions logged under a lesson it superseded (the reference logs conflict_resolved under the loser).
      history: memory.ledgerEntries().filter((e) => e.memoryId === lesson.id || winnerOf(e) === lesson.id),
    },
  };
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ids = (xs: readonly string[], n = 8): string => (xs.length <= n ? xs.join(" ") : `${xs.slice(0, n).join(" ")} … +${xs.length - n} more`);

function entryLine(e: LedgerEntry): string {
  let note = "";
  if (e.action === "conflict_detected") note = ` with ${detailsOf(DETECTED, e).with}`;
  else if (e.action === "conflict_resolved") {
    const d = detailsOf(RESOLVED, e);
    note = ` ${d.strategy}${d.winner ? `, winner ${d.winner}` : d.with ? ` with ${d.with}` : ""}`;
  } else if (e.action === "dream_approved") {
    const d = detailsOf(APPROVED, e);
    note = ` proposal ${d.proposalId}, derived from ${d.derivedFrom.length} lesson(s)`;
  }
  return `${iso(e.timestamp)}  ${e.action}${note}  by ${e.actor}`;
}

/** The lineage as the command prints it. */
export function renderLineage(l: Lineage): string[] {
  const out = [
    `why ${l.finding.id}`,
    `  finding     ${l.finding.class}: ${clip(l.finding.where, 150)}`,
    `  decision    ${l.decision.verb}${l.decision.expiresAt ? ` until ${l.decision.expiresAt}` : ""}, decided by ${l.decision.decidedBy}${l.decision.ruleId ? ` under ${l.decision.ruleId}` : ""}`,
    `  because     ${clip(oneLine(l.decision.reason), 220)}`,
  ];
  const x = l.lesson;
  if (!x) {
    out.push("  lesson      none recalled: no exception of this class on this finding's host, name or address, in force or lapsed, settled it");
    return out;
  }
  const s = x.lesson;
  const when = x.status === "applied" ? `in force until ${s.expiresAt}` : `lapsed ${s.expiresAt}, so the finding is re-raised`;
  if (x.rule) {
    out.push(`  covered by  rule ${x.rule.id}, derived from ${x.rule.derivedFrom.length} lessons: ADOPT ${(s as { findingClass: string }).findingClass} on ${(s as { scopeKeys?: string[] }).scopeKeys?.length ?? 0} scope(s), ${when}`);
    out.push(`              approved by ${x.rule.approvedBy} at ${x.rule.approvedAt} from proposal ${x.rule.proposalId}; derivedFrom ${ids(x.rule.derivedFrom, 10)}`);
  } else {
    out.push(`  lesson      ${s.id}, ${s.kind === "exception" ? `exception for ${s.findingClass}` : "answer"} on ${x.matched.key} (${s.tenantId}), ${when}`);
  }
  for (const [i, t] of x.taught.entries()) {
    const c = t.correction;
    out.push(`  ${i === 0 ? "correction " : "           "} ${x.rule ? `${t.lesson.id}: ` : ""}${JSON.stringify(c.text)}`);
    out.push(`              taught by ${c.taughtBy} at ${c.taughtAt}${c.run ? ` in pass ${c.run}` : ""}, recorded ${c.recordedAt}; H-MEM origin ${c.origin}, source ${c.source}${t.lesson.supersededBy ? `; superseded by ${t.lesson.supersededBy}` : ""}`);
  }
  out.push(`  recall      the finding's ${x.matched.type} ${x.matched.key} is ${x.rule ? "one of the rule's scope keys" : "the lesson's scope key"}, same tenant, same class: an exact match`);
  out.push(`              score ${x.score.value.toFixed(2)} for "${x.score.query}" in the reference's hybrid ranking (retrieval threshold ${x.score.threshold}); the Decider gates on the exact match and on no score`);
  if (!x.conflicts.length) out.push("  conflicts   none met");
  for (const c of x.conflicts) {
    out.push(`  conflict    ${c.id}: ${c.side === "new" ? "recorded against" : "a later lesson recorded against this one,"} ${c.other}, detected ${c.detectedAt}: ${clip(c.reason, 200)}`);
    out.push(c.resolution
      ? `              settled ${c.resolution.strategy}${c.resolution.winner ? ` (winner ${c.resolution.winner})` : ""} by ${c.resolution.by} at ${c.resolution.at}`
      : "              not settled");
  }
  if (!x.rule) out.push("  rule        no approved rule covers this lesson");
  out.push(`  ledger      ${x.history.length} entr${x.history.length === 1 ? "y" : "ies"} for ${s.id}`);
  for (const e of x.history) out.push(`              ${entryLine(e)}`);
  return out;
}
