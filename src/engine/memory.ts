// Our module boundary over the vendored Meterless H-MEM reference.
//
// The conformance runner loads THIS file (HMEM_IMPL) and requires the export HMEM: a class with
// constructor({ clock }), add(), query(), feedback() and the service surface (store, ledger, sleep,
// dreaming, conflicts). We re-export the reference's implementation unchanged and add the domain layer
// the agent needs on top: TechnicianMemory, the lessons a technician teaches the agent. A lesson is
// either an answer to a question the agent asked (so the Decider does not ask it again) or an accepted
// exception for one finding class on one scope (so the Decider treats the finding as ADOPT with an
// expiry). Every lesson carries a tenant, a scope key, an expiry and provenance. Recall is by exact
// scope key, never by similarity: a lesson about one host never applies to another because the two
// embed alike. An expired lesson comes back flagged so the Decider re-raises the finding; it is never
// applied silently.
//
// The store is the reference's own: state.json and ledger.jsonl under .world/memory (gitignored with
// the rest of .world/), or in memory for tests and the sample pass. The free-text fields of a lesson
// (question, answer, reason, who taught it) go through the same redactor as collected data before they
// are stored, so a hostname typed into an answer is stored as its pseudonym. A scope key is matched
// exactly, so it cannot be rewritten: it must already be a pseudonym the findings carry (or a
// documentation name or address), which the redactor leaves unchanged; one the redactor would replace
// (a real hostname, address or mailbox) is refused before anything is stored, and never echoed.
//
// This is the agent's own memory. It is not the Nightshift runtime's injected "hmem" context, which
// the receipt gate (src/gate.ts) treats as a custody question, not as memory.

export {
  HMEM, MemoryStoreService, TrustLedgerService, MemoryMiningService, MemoryRetrievalService, ConflictDetectionService,
  SleepCycleService, DreamingService, embed, cosine, tokenize, jaccard, parseStrictJsonArray, FEEDBACK_DELTAS, DEFAULTS, clamp01, DAY_MS,
} from "../../vendor/hmem/src/index.ts";
export type {
  MemoryRecord, MemoryType, MemoryLayer, LedgerAction, LedgerEntry, QueryResult, HMEMOptions, FeedbackKind, Provenance as HmemProvenance,
} from "../../vendor/hmem/src/index.ts";

import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { HMEM, type MemoryRecord } from "../../vendor/hmem/src/index.ts";
import type { FindingSummary } from "../catalogue/select.ts";
import { FINDING_CLASSES, type FindingClass } from "../catalogue/templates.ts";
import { config, redact } from "../config.ts";
import { Redactor } from "../redactor.ts";

/** Same construction as the tracer's: the configured salt, or a fresh one per process when it is blank. */
const redactor = new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords);
const clean = (s: string): string => redactor.text(redact(s));

export const SCOPE_TYPES = ["host", "name", "address"] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

/** Who taught the lesson and when. `by` is a role or a pseudonym, never a person's name; `runId` is the pass it was taught in. */
export interface LessonProvenance { kind: string; at: string; by: string; runId?: string }

interface LessonBase {
  /** The H-MEM record id. */
  id: string;
  tenantId: string;
  /** ISO 8601 UTC, millisecond form. At or after this instant the lesson is expired and recall flags it. */
  expiresAt: string;
  recordedAt: string;
  provenance: LessonProvenance;
}
export interface AnswerLesson extends LessonBase { kind: "answer"; question: string; answer: string; scope: { type: ScopeType; key: string } }
export interface ExceptionLesson extends LessonBase { kind: "exception"; findingClass: FindingClass; scopeKey: string; reason: string }
export type Lesson = AnswerLesson | ExceptionLesson;

export interface AnswerInput { tenantId: string; question: string; answer: string; scope: { type: ScopeType; key: string }; expiresAt: string; provenance: LessonProvenance }
export interface ExceptionInput { tenantId: string; findingClass: FindingClass; scopeKey: string; reason: string; expiresAt: string; provenance: LessonProvenance }

/** The fields of a finding that recall reads. */
export type FindingScope = Pick<FindingSummary, "tenant_id" | "class" | "host" | "dns_name" | "refers_to_type" | "refers_to_id" | "resolves_to">;

export interface Recall {
  /** Lessons in force at `at`: an answer the Decider need not ask again; an exception it may treat as ADOPT with that lesson's expiry. */
  applicable: Lesson[];
  /** Lessons whose expiry has passed. Returned so the Decider re-raises the finding; never applied. */
  expired: Lesson[];
  /** The instant the recall was evaluated at. */
  at: string;
}

export class MemoryError extends Error {}

export interface TechnicianMemoryOptions {
  /** "memory" (default) keeps nothing on disk; "local" persists under <directory>/.world/memory. */
  storage?: "memory" | "local";
  directory?: string;
  /** Milliseconds since the epoch, like the reference's; injectable for tests. */
  clock?: () => number;
  /** The actor the H-MEM ledger records on every write and read. */
  actor?: string;
}

// Validation. Timestamps are ISO 8601 UTC and are normalised to the millisecond form so they compare as text.
const iso = z.iso.datetime().transform((s) => new Date(s).toISOString());
const key = z.string().min(1).max(253).regex(/^\S+$/, "a scope key is one token with no whitespace");
/** A scope key the redactor leaves unchanged: a pseudonym, or a documentation name or address. The message never carries the key. */
const scopeKey = key.refine((k) => redactor.text(k) === k, "a scope key must be a pseudonym the findings carry, or a documentation name or address; the redactor would replace this one, so it is a real name, address or mailbox and is refused");
const text = z.string().trim().min(1).max(2000);
const Prov = z.object({ kind: z.string().trim().min(1).max(64), at: iso, by: z.string().trim().min(1).max(128), runId: z.string().min(1).max(128).optional() });
const expiresAfterTaught = (v: { expiresAt: string; provenance: { at: string } }): boolean => v.expiresAt > v.provenance.at;
const EXPIRY_MSG = { message: "expiresAt must be after provenance.at: a lesson cannot expire before it was taught", path: ["expiresAt"] };
const AnswerSchema = z.object({ tenantId: key, question: text, answer: text, scope: z.object({ type: z.enum(SCOPE_TYPES), key: scopeKey }), expiresAt: iso, provenance: Prov }).refine(expiresAfterTaught, EXPIRY_MSG);
const ExceptionSchema = z.object({ tenantId: key, findingClass: z.enum(FINDING_CLASSES), scopeKey, reason: text, expiresAt: iso, provenance: Prov }).refine(expiresAfterTaught, EXPIRY_MSG);

function parse<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  throw new MemoryError(`${what} refused: ${r.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`);
}

// The structured fields of a lesson ride on the H-MEM record as prefixed tags, so a reload from state.json
// rebuilds every lesson exactly; the record's content is the readable sentence. No prefix is a prefix of
// another, and the one tag the reference adds on its own ("review", on wrong feedback) carries no colon.
const TAG = {
  kind: "lesson:", tenant: "tenant:", scopeType: "scope_type:", scopeKey: "scope_key:", cls: "class:", expires: "expires:", recorded: "recorded:",
  question: "question:", answer: "answer:", reason: "reason:", provKind: "prov_kind:", provAt: "prov_at:", provBy: "prov_by:", provRun: "prov_run:",
} as const;
const tagOf = (tags: readonly string[], prefix: string): string | undefined => {
  const t = tags.find((x) => x.startsWith(prefix));
  return t === undefined ? undefined : t.slice(prefix.length);
};

/** A lesson from its H-MEM record, or null for a record that is not one of ours or lacks a field. */
export function lessonOf(r: MemoryRecord): Lesson | null {
  const kind = tagOf(r.tags, TAG.kind);
  if (kind !== "answer" && kind !== "exception") return null;
  const tenantId = tagOf(r.tags, TAG.tenant), expiresAt = tagOf(r.tags, TAG.expires), recordedAt = tagOf(r.tags, TAG.recorded);
  const pk = tagOf(r.tags, TAG.provKind), pa = tagOf(r.tags, TAG.provAt), pb = tagOf(r.tags, TAG.provBy), pr = tagOf(r.tags, TAG.provRun);
  if (!tenantId || !expiresAt || !recordedAt || !pk || !pa || !pb) return null;
  const base = { id: r.id, tenantId, expiresAt, recordedAt, provenance: { kind: pk, at: pa, by: pb, ...(pr ? { runId: pr } : {}) } };
  if (kind === "answer") {
    const type = tagOf(r.tags, TAG.scopeType), k = tagOf(r.tags, TAG.scopeKey), question = tagOf(r.tags, TAG.question), answer = tagOf(r.tags, TAG.answer);
    if (!type || !k || question === undefined || answer === undefined || !(SCOPE_TYPES as readonly string[]).includes(type)) return null;
    return { ...base, kind, question, answer, scope: { type: type as ScopeType, key: k } };
  }
  const cls = tagOf(r.tags, TAG.cls), scopeKey = tagOf(r.tags, TAG.scopeKey), reason = tagOf(r.tags, TAG.reason);
  if (!cls || !scopeKey || reason === undefined || !(FINDING_CLASSES as readonly string[]).includes(cls)) return null;
  return { ...base, kind, findingClass: cls as FindingClass, scopeKey, reason };
}

/**
 * The scope values a finding offers, per scope type: its host, the DNS name in play (the finding's
 * dns_name, and its referent when that is a dns_name), and the address it resolves to. All pseudonyms.
 */
export function scopeValuesOf(f: Pick<FindingScope, "host" | "dns_name" | "refers_to_type" | "refers_to_id" | "resolves_to">): Record<ScopeType, string[]> {
  const name = new Set<string>();
  if (f.dns_name) name.add(f.dns_name);
  if (f.refers_to_id && (f.refers_to_type ?? "dns_name") === "dns_name") name.add(f.refers_to_id);
  return { host: f.host ? [f.host] : [], name: [...name], address: f.resolves_to ? [f.resolves_to] : [] };
}

const byRecorded = (a: Lesson, b: Lesson): number => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id);
const normQuestion = (q: string): string => q.toLowerCase().replace(/\s+/g, " ").trim();

export class TechnicianMemory {
  readonly hmem: HMEM;
  /** Where state.json and ledger.jsonl live, or null in memory. */
  readonly directory: string | null;
  private readonly clock: () => number;
  private readonly actor: string;
  private readonly index = new Map<string, Lesson>();

  constructor(opts: TechnicianMemoryOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    this.actor = opts.actor ?? "technician-memory";
    this.directory = opts.storage === "local" ? path.join(opts.directory ?? process.cwd(), ".world", "memory") : null;
    this.hmem = new HMEM({ clock: this.clock, persistDir: this.directory ?? undefined, actor: this.actor });
    for (const r of this.hmem.store.all()) {
      const l = lessonOf(r);
      if (l) this.index.set(l.id, l);
    }
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  private provTags(p: LessonProvenance, by: string): string[] {
    return [`${TAG.provKind}${p.kind}`, `${TAG.provAt}${p.at}`, `${TAG.provBy}${by}`, ...(p.runId ? [`${TAG.provRun}${p.runId}`] : [])];
  }

  /** (a) A question the agent asked and the technician answered, on one scope of the tenant's estate, until it expires. */
  recordAnswer(input: AnswerInput): AnswerLesson {
    const v = parse(AnswerSchema, input, "answer");
    const recordedAt = this.nowIso();
    const question = clean(v.question), answer = clean(v.answer), by = clean(v.provenance.by);
    const rec = this.hmem.add({
      content: `Technician answer on ${v.scope.type} ${v.scope.key} (${v.tenantId}): Q ${question} A ${answer}; until ${v.expiresAt}`,
      type: "factual", layer: "long_term", confidence: 1,
      tags: [
        `${TAG.kind}answer`, `${TAG.tenant}${v.tenantId}`, `${TAG.scopeType}${v.scope.type}`, `${TAG.scopeKey}${v.scope.key}`,
        `${TAG.expires}${v.expiresAt}`, `${TAG.recorded}${recordedAt}`, `${TAG.question}${question}`, `${TAG.answer}${answer}`,
        ...this.provTags(v.provenance, by),
      ],
      source: `technician:${v.provenance.kind}`,
      provenance: { origin: "manual", learnedAt: Date.parse(v.provenance.at), label: `answer taught by ${by}`, ...(v.provenance.runId ? { refs: [v.provenance.runId] } : {}) },
      chatId: v.tenantId,
    });
    const lesson = lessonOf(rec);
    if (!lesson || lesson.kind !== "answer") throw new MemoryError(`answer ${rec.id} did not round-trip through the store`);
    this.index.set(lesson.id, lesson);
    return lesson;
  }

  /** (b) An exception the technician accepted: findings of this class on this scope are ADOPT until the expiry, then re-raised. */
  recordException(input: ExceptionInput): ExceptionLesson {
    const v = parse(ExceptionSchema, input, "exception");
    const recordedAt = this.nowIso();
    const reason = clean(v.reason), by = clean(v.provenance.by);
    const rec = this.hmem.add({
      content: `Accepted exception for ${v.findingClass} on ${v.scopeKey} (${v.tenantId}) until ${v.expiresAt}: ${reason}`,
      type: "preference", layer: "long_term", confidence: 1,
      tags: [
        `${TAG.kind}exception`, `${TAG.tenant}${v.tenantId}`, `${TAG.cls}${v.findingClass}`, `${TAG.scopeKey}${v.scopeKey}`,
        `${TAG.expires}${v.expiresAt}`, `${TAG.recorded}${recordedAt}`, `${TAG.reason}${reason}`,
        ...this.provTags(v.provenance, by),
      ],
      source: `technician:${v.provenance.kind}`,
      provenance: { origin: "user_correction", learnedAt: Date.parse(v.provenance.at), label: `exception accepted by ${by}`, ...(v.provenance.runId ? { refs: [v.provenance.runId] } : {}) },
      chatId: v.tenantId,
    });
    const lesson = lessonOf(rec);
    if (!lesson || lesson.kind !== "exception") throw new MemoryError(`exception ${rec.id} did not round-trip through the store`);
    this.index.set(lesson.id, lesson);
    return lesson;
  }

  /**
   * The lessons that apply to this finding: same tenant, and an exception of the finding's class whose
   * scope key is one of the finding's scope values, or an answer whose scope value the finding carries.
   * Split by expiry at `at` (now by default; an expiry exactly at `at` has lapsed). Each hit is a
   * "read" in the H-MEM ledger, flagged expired or not.
   */
  recall(finding: FindingScope, at?: string): Recall {
    const now = at === undefined ? this.nowIso() : parse(iso, at, "recall at");
    const scopes = scopeValuesOf(finding);
    const every = new Set([...scopes.host, ...scopes.name, ...scopes.address]);
    const applicable: Lesson[] = [];
    const expired: Lesson[] = [];
    for (const l of [...this.index.values()].sort(byRecorded)) {
      if (l.tenantId !== finding.tenant_id) continue;
      const applies = l.kind === "exception" ? l.findingClass === finding.class && every.has(l.scopeKey) : scopes[l.scope.type].includes(l.scope.key);
      if (!applies) continue;
      const lapsed = l.expiresAt <= now;
      (lapsed ? expired : applicable).push(l);
      this.hmem.ledger.log(l.id, "read", this.actor, { details: { finding_class: finding.class, tenant_id: finding.tenant_id, at: now, expired: lapsed } });
    }
    return { applicable, expired, at: now };
  }

  /** The answer in force for this question on the finding's scope (same text, case and spacing aside), or null: the Decider must ask. */
  answered(finding: FindingScope, question: string, at?: string): AnswerLesson | null {
    const q = normQuestion(clean(question));
    const hit = this.recall(finding, at).applicable.find((l): l is AnswerLesson => l.kind === "answer" && normQuestion(l.question) === q);
    return hit ?? null;
  }

  /** The exception in force for this finding, or null. A lapsed exception is in recall().expired and the finding is to be re-raised. */
  exceptionFor(finding: FindingScope, at?: string): ExceptionLesson | null {
    const hit = this.recall(finding, at).applicable.find((l): l is ExceptionLesson => l.kind === "exception");
    return hit ?? null;
  }

  /** Every lesson, oldest first, optionally one tenant's. */
  lessons(tenantId?: string): Lesson[] {
    return [...this.index.values()].filter((l) => tenantId === undefined || l.tenantId === tenantId).sort(byRecorded);
  }

  /** One lesson by id, or null. */
  lesson(id: string): Lesson | null {
    return this.index.get(id) ?? null;
  }

  /**
   * Withdraw a lesson: the record leaves the store (the reference logs a "delete" in the ledger with the
   * record's previous state and the reason, so the withdrawal is itself on record) and the Decider stops
   * consulting it. Returns the lesson withdrawn, or null when no lesson has that id.
   */
  forget(id: string, reason: string): Lesson | null {
    const l = this.index.get(id);
    if (!l) return null;
    this.hmem.store.delete(id, clean(parse(text, reason, "forget reason")));
    this.index.delete(id);
    return l;
  }
}
