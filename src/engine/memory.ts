// Our module boundary over the vendored Meterless H-MEM reference.
//
// The conformance runner loads THIS file (HMEM_IMPL) and requires the export HMEM: a class with
// constructor({ clock }), add(), query(), feedback() and the service surface (store, ledger, sleep,
// dreaming, conflicts). We re-export the reference's implementation unchanged and add the domain layer
// the agent needs on top: TechnicianMemory, the lessons a technician teaches the agent. A lesson is
// either an accepted exception for one finding class on one scope (the Decider treats the finding as
// ADOPT until its expiry) or an answer to a question on one scope, stored and listed; the pass reads
// exceptions only. Every lesson carries a tenant, a scope key, an expiry and provenance. Recall is by exact
// scope key, never by similarity: a lesson about one host never applies to another because the two
// embed alike. An expired lesson comes back flagged so the Decider re-raises the finding; it is never
// applied silently.
//
// The store is the reference's own: state.json and ledger.jsonl in the directory DRIFT_MEMORY_DIR names
// (src/config.ts; .world/memory by default, gitignored with the rest of .world/), or in memory for tests.
// `npm run answer` opens it "local", reading and writing. Every pass opens it "read": the lessons as the
// technician left them, loaded once, with the pass's recalls logged in the process's own H-MEM ledger and
// nothing written back, so a committed store (examples/memory) stays byte for byte as committed and a
// clean clone decides with the same lessons. The free-text fields of a lesson
// (question, answer, reason, who taught it) go through the same redactor as collected data before they
// are stored, so a hostname typed into an answer is stored as its pseudonym. A scope key is matched
// exactly, so it cannot be rewritten: it must already be a pseudonym the findings carry (or a
// documentation name or address), which the redactor leaves unchanged; one the redactor would replace
// (a real hostname, address or mailbox) is refused before anything is stored, and never echoed.
//
// The conflict gate. A lesson is the technician's word, so the technician settles every contradiction (the reference
// auto-resolves from a decision confidence of 0.70; this module leaves the resolution to a person). Before a lesson is
// stored it is set against the lessons in force on the same tenant and scope key: two exceptions for one class
// that expire at different instants, two different answers to one question, and the reference's own detector
// (ConflictDetectionService, over the free text of lessons on the same topic) refuse it, naming both. The
// technician settles each conflict by id: `supersede` stores the new lesson and keeps the old one, marked
// supersededBy and no longer recalled (the reference's rule: kept and penalised, never deleted), or `keep_both`
// stores it beside the old one. Either way the ledger records conflict_detected and conflict_resolved with the
// technician as actor, which `npm run why` reads back. The gate is on for a store opened with `gate: true`, as
// `npm run answer` opens it; a store opened without records as it always has, and recall skips a superseded lesson
// whichever way the store is opened.
//
// A rule (recordRule, src/engine/dreaming.ts) is an exception for one class over one or more scope keys, approved from the
// reference's dreaming in place of the lessons it is derived from. It is stored as an exception lesson with `scopeKeys` and
// `derivedFrom` lineage, behind the same gate, and it supersedes those lessons. Recall hands the Decider the rule with
// `scopeKey` set to the key the finding matched, so the pipeline reads it as it reads a lesson: same verb, same expiry.
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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { HMEM, type LedgerEntry, type MemoryRecord } from "../../vendor/hmem/src/index.ts";
import { snapshot } from "../../vendor/hmem/src/memoryStore.ts";
import type { FindingSummary } from "../catalogue/select.ts";
import { FINDING_CLASSES, type FindingClass } from "../catalogue/templates.ts";
import { config, redact } from "../config.ts";
import { Redactor } from "../redactor.ts";

/** Same construction as the tracer's: the configured salt, or a fresh one per process when it is blank. */
const redactor = new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords);
const clean = (s: string): string => redactor.text(redact(s));
/** Free text as a lesson stores it: through the same redactor as collected data. For a field a caller writes beside a lesson, such as who approved a rule. */
export const cleanFree = clean;

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
  /** The lesson that replaced this one when a conflict was settled with `supersede`. A superseded lesson is kept on record and never recalled. */
  supersededBy?: string;
  /** Every lesson this one replaced when a conflict was settled with `supersede`; the reference's own `supersedes` field holds the first. */
  supersedes?: string[];
}
export interface AnswerLesson extends LessonBase { kind: "answer"; question: string; answer: string; scope: { type: ScopeType; key: string } }
export interface ExceptionLesson extends LessonBase {
  kind: "exception";
  findingClass: FindingClass;
  scopeKey: string;
  reason: string;
  /**
   * A rule (npm run answer -- --approve-dream) is an exception for one class over one or more scope keys, in place of the
   * lessons it was derived from. `scopeKeys` is every key it covers, sorted, and `scopeKey` is the first; recall hands the
   * Decider the rule with `scopeKey` set to the key the finding matched. Absent on a lesson the technician taught.
   */
  scopeKeys?: string[];
  /** The lessons the rule was derived from: the lineage `npm run why` shows. Those lessons are superseded by the rule. */
  derivedFrom?: string[];
  /** The dreaming proposal (drm-...) the rule was approved from. */
  proposalId?: string;
}
export type Lesson = AnswerLesson | ExceptionLesson;

/** How the technician settles one conflict the gate found: the new lesson replaces `with` (kept, marked superseded), or both stay in force. */
export interface ConflictResolution { with: string; strategy: "supersede" | "keep_both" }
export interface AnswerInput { tenantId: string; question: string; answer: string; scope: { type: ScopeType; key: string }; expiresAt: string; provenance: LessonProvenance; resolutions?: ConflictResolution[] }
export interface ExceptionInput { tenantId: string; findingClass: FindingClass; scopeKey: string; reason: string; expiresAt: string; provenance: LessonProvenance; resolutions?: ConflictResolution[] }

/** A rule approved from dreaming (TechnicianMemory.recordRule): the keys and the reason and expiry are the ones the `derivedFrom` lessons state. */
export interface RuleInput { tenantId: string; findingClass: FindingClass; scopeKeys: string[]; reason: string; expiresAt: string; provenance: LessonProvenance; derivedFrom: string[]; proposalId: string; resolutions?: ConflictResolution[] }

/** A lesson in force that the one being recorded contradicts, and why. */
export interface LessonConflict {
  with: Lesson;
  reason: string;
  /** 1 for a disagreement the gate reads off the fields; the reference detector's own confidence for a text conflict. */
  confidence: number;
}

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

/** The gate refused a lesson: it contradicts lessons in force that the technician has not settled by id. Names both sides. */
export class ConflictError extends MemoryError {
  constructor(message: string, readonly conflicts: readonly LessonConflict[], /** The refused lesson, in one line. */ readonly candidate: string) {
    super(message);
  }
}

/** Free text on one line: a newline in a reason, question or answer prints as \n, so one lesson stays one line of output. */
export const oneLine = (s: string): string => s.replace(/\r\n|\r|\n/g, "\\n");

/** The ids the supersede resolutions name, in order. */
const supersededIds = (resolutions: readonly ConflictResolution[]): string[] => resolutions.filter((r) => r.strategy === "supersede").map((r) => r.with);

/** One lesson in one line: id, kind, what it covers, until when, who taught it and when, and what it says. */
export function describeLesson(l: Lesson): string {
  const head = l.kind === "exception" && l.scopeKeys
    ? `${l.id}  rule       ${l.findingClass} on ${l.scopeKeys.length} scope key(s) (${l.tenantId})`
    : l.kind === "exception"
      ? `${l.id}  exception  ${l.findingClass} on ${l.scopeKey} (${l.tenantId})`
      : `${l.id}  answer     ${l.scope.type} ${l.scope.key} (${l.tenantId})`;
  const said = oneLine(l.kind === "exception" ? l.reason : `Q ${l.question} A ${l.answer}`);
  const lineage = l.kind === "exception" && l.derivedFrom ? `  derived from ${l.derivedFrom.length} lesson(s)` : "";
  return `${head}  until ${l.expiresAt}  by ${l.provenance.by} at ${l.recordedAt}${lineage}${l.supersededBy ? `  superseded by ${l.supersededBy}` : ""}: ${said}`;
}

export interface TechnicianMemoryOptions {
  /**
   * "memory" (default) keeps nothing on disk. "local" reads and writes the store in `directory` (npm run answer).
   * "read" loads the store in `directory` as it stands (none when state.json is absent) and writes nothing back:
   * recalls are logged in this process's H-MEM ledger only, and recording or withdrawing a lesson is refused.
   */
  storage?: "memory" | "local" | "read";
  /** The store's own directory (state.json, ledger.jsonl), resolved against the working directory; DRIFT_MEMORY_DIR when absent. */
  directory?: string;
  /** Milliseconds since the epoch, like the reference's; injectable for tests. */
  clock?: () => number;
  /** The actor the H-MEM ledger records on every write and read. */
  actor?: string;
  /** The conflict gate: a lesson that contradicts one in force on the same tenant and scope key is refused unless the technician settles each conflict by id (resolutions). Off by default. */
  gate?: boolean;
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
const RuleSchema = z.object({
  tenantId: key, findingClass: z.enum(FINDING_CLASSES), scopeKeys: z.array(scopeKey).min(1).max(500), reason: text, expiresAt: iso, provenance: Prov,
  derivedFrom: z.array(z.string().min(1).max(64)).min(2).max(500), proposalId: z.string().regex(/^drm-[0-9a-f]{12}$/),
}).refine(expiresAfterTaught, EXPIRY_MSG);

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
  // A rule: every scope key it covers (space-joined; a key is one token) and the proposal it was approved from. "scope_key:" is not a prefix of "scope_keys:".
  scopeKeys: "scope_keys:", proposal: "dream_id:",
  // One tag per lesson a record superseded.
  supersedes: "supersedes:",
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
  const replaced = r.tags.filter((t) => t.startsWith(TAG.supersedes)).map((t) => t.slice(TAG.supersedes.length));
  const base = {
    id: r.id, tenantId, expiresAt, recordedAt, provenance: { kind: pk, at: pa, by: pb, ...(pr ? { runId: pr } : {}) },
    ...(r.supersededBy ? { supersededBy: r.supersededBy } : {}), ...(replaced.length ? { supersedes: replaced } : {}),
  };
  if (kind === "answer") {
    const type = tagOf(r.tags, TAG.scopeType), k = tagOf(r.tags, TAG.scopeKey), question = tagOf(r.tags, TAG.question), answer = tagOf(r.tags, TAG.answer);
    if (!type || !k || question === undefined || answer === undefined || !(SCOPE_TYPES as readonly string[]).includes(type)) return null;
    return { ...base, kind, question, answer, scope: { type: type as ScopeType, key: k } };
  }
  const cls = tagOf(r.tags, TAG.cls), scopeKey = tagOf(r.tags, TAG.scopeKey), reason = tagOf(r.tags, TAG.reason);
  if (!cls || !scopeKey || reason === undefined || !(FINDING_CLASSES as readonly string[]).includes(cls)) return null;
  const keys = tagOf(r.tags, TAG.scopeKeys), proposal = tagOf(r.tags, TAG.proposal);
  const rule = keys && r.derivedFrom?.length ? { scopeKeys: keys.split(" "), derivedFrom: [...r.derivedFrom], ...(proposal ? { proposalId: proposal } : {}) } : {};
  return { ...base, kind, findingClass: cls as FindingClass, scopeKey, reason, ...rule };
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

/** What the conflict gate compares: a lesson as it would be stored, the free text already redacted. `text` is the part the reference's detector reads. */
type Claim =
  | { kind: "exception"; tenantId: string; keys: string[]; findingClass: FindingClass; expiresAt: string; text: string }
  | { kind: "answer"; tenantId: string; key: string; scopeType: ScopeType; question: string; answer: string; expiresAt: string; text: string };

const claimOf = (l: Lesson): Claim => l.kind === "exception"
  ? { kind: "exception", tenantId: l.tenantId, keys: l.scopeKeys ?? [l.scopeKey], findingClass: l.findingClass, expiresAt: l.expiresAt, text: l.reason }
  : { kind: "answer", tenantId: l.tenantId, key: l.scope.key, scopeType: l.scope.type, question: l.question, answer: l.answer, expiresAt: l.expiresAt, text: `Q ${l.question} A ${l.answer}` };

/** The key two exception claims share, or undefined. */
const sharedKey = (a: Claim & { kind: "exception" }, b: Claim & { kind: "exception" }): string | undefined => a.keys.find((k) => b.keys.includes(k));

/** The same scope key: an exception's class and a key in common (recall matches the key on any of a finding's host, name or address), an answer's key and scope type. */
const sameScope = (a: Claim, b: Claim): boolean => a.kind === "exception" && b.kind === "exception"
  ? a.findingClass === b.findingClass && sharedKey(a, b) !== undefined
  : a.kind === "answer" && b.kind === "answer" && a.scopeType === b.scopeType && a.key === b.key;

/** A disagreement the two claims state in their fields, or null. `held` is in force already; `fresh` is the one being recorded. */
function disagreement(held: Claim, fresh: Claim): string | null {
  if (held.kind === "exception" && fresh.kind === "exception") {
    return held.findingClass === fresh.findingClass && held.expiresAt !== fresh.expiresAt
      ? `both accept ${fresh.findingClass} on ${sharedKey(held, fresh) ?? fresh.keys[0]} and expire at different instants (${held.expiresAt} and ${fresh.expiresAt})`
      : null;
  }
  if (held.kind === "answer" && fresh.kind === "answer") {
    return normQuestion(held.question) === normQuestion(fresh.question) && normQuestion(held.answer) !== normQuestion(fresh.answer)
      ? `both answer "${oneLine(fresh.question)}" on ${fresh.key} and the answers differ`
      : null;
  }
  return null;
}

export class TechnicianMemory {
  readonly hmem: HMEM;
  /** Where state.json and ledger.jsonl live (absolute), or null in memory. */
  readonly directory: string | null;
  /** True when opened "read": the store on disk is never written. */
  readonly readOnly: boolean;
  private readonly clock: () => number;
  private readonly actor: string;
  private readonly gated: boolean;
  private readonly index = new Map<string, Lesson>();
  private persisted: LedgerEntry[] | null = null;

  constructor(opts: TechnicianMemoryOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    this.actor = opts.actor ?? "technician-memory";
    this.gated = opts.gate ?? false;
    const storage = opts.storage ?? "memory";
    this.directory = storage === "memory" ? null : path.resolve(opts.directory ?? config.memoryDir);
    this.readOnly = storage === "read";
    this.hmem = new HMEM({ clock: this.clock, persistDir: storage === "local" ? this.directory! : undefined, actor: this.actor });
    if (this.readOnly) {
      // The reference's own state file, restored into an in-memory store: nothing below writes to the directory.
      const file = path.join(this.directory!, "state.json");
      if (existsSync(file)) {
        let saved: { seq: number; records: MemoryRecord[] };
        try {
          saved = JSON.parse(readFileSync(file, "utf8")) as { seq: number; records: MemoryRecord[] };
        } catch (err) {
          throw new MemoryError(`the store at ${this.directory} does not parse: ${(err as Error).message}`);
        }
        this.hmem.store.restoreAll(saved.records ?? [], saved.seq ?? 0);
      }
    }
    for (const r of this.hmem.store.all()) {
      const l = lessonOf(r);
      if (l) this.index.set(l.id, l);
    }
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  /** Refuses a write to a store opened "read". */
  private writable(what: string): void {
    if (this.readOnly) throw new MemoryError(`${what} refused: the store at ${this.directory} is open read-only; npm run answer records and withdraws lessons`);
  }

  private provTags(p: LessonProvenance, by: string): string[] {
    return [`${TAG.provKind}${p.kind}`, `${TAG.provAt}${p.at}`, `${TAG.provBy}${by}`, ...(p.runId ? [`${TAG.provRun}${p.runId}`] : [])];
  }

  /**
   * The conflict gate (a store opened with `gate: true`): lessons in force (not lapsed, not superseded) on the claim's
   * tenant and scope key, of its kind and, for an exception, its class, set against it. A disagreement in the fields (two
   * expiries for one exception, two answers to one question) or one the reference's ConflictDetectionService reads in the
   * free text (opposing phrases, diverging numbers) is a conflict. Returns the conflicts when the technician has settled
   * every one by id; throws ConflictError, naming both sides, when one is open, and MemoryError when a resolution names a
   * lesson that is not in conflict.
   */
  private gate(fresh: Claim, resolutions: readonly ConflictResolution[], except: ReadonlySet<string> = new Set()): LessonConflict[] {
    // One resolution per lesson: two for the same id, whether alike or contradictory, are refused before anything is read.
    const named = new Map<string, string>();
    for (const r of resolutions) {
      const prior = named.get(r.with);
      if (prior !== undefined) throw new MemoryError(`resolution refused: ${r.with} is named twice${prior === r.strategy ? "" : `, as ${prior} and as ${r.strategy}`}; settle each lesson once`);
      named.set(r.with, r.strategy);
    }
    if (!this.gated) {
      if (resolutions.length) throw new MemoryError("resolution refused: this store is open without the conflict gate, so there is nothing to settle");
      return [];
    }
    const now = this.nowIso();
    // `except` holds the lessons a rule is derived from: the rule replaces them, so they are no conflict for it.
    const held = this.lessons(fresh.tenantId).filter((l) => !l.supersededBy && !except.has(l.id) && l.expiresAt > now && sameScope(claimOf(l), fresh));
    // The reference's detector, over a scratch store holding the lessons' free text and the new one's: nothing here is written.
    const scratch = new HMEM({ clock: this.clock });
    const peerOf = new Map(held.map((l) => [scratch.add({ content: claimOf(l).text, source: "gate:held" }).id, l.id]));
    const added = scratch.add({ content: fresh.text, source: "gate:new" });
    const seen = new Map<string, { reason: string; confidence: number }>();
    for (const c of scratch.conflicts.scan()) {
      const other = c.memoryA === added.id ? c.memoryB : c.memoryB === added.id ? c.memoryA : null;
      if (other && peerOf.has(other)) seen.set(peerOf.get(other)!, { reason: c.reason, confidence: c.confidence });
    }
    const conflicts: LessonConflict[] = [];
    for (const l of held) {
      const fields = disagreement(claimOf(l), fresh);
      const text = seen.get(l.id);
      if (!fields && !text) continue;
      conflicts.push({
        with: l,
        reason: [fields, text ? `the reference detector reads ${text.reason} (confidence ${text.confidence.toFixed(2)})` : null].filter(Boolean).join("; "),
        confidence: fields ? 1 : text!.confidence,
      });
    }
    for (const r of resolutions) {
      if (!conflicts.some((c) => c.with.id === r.with)) {
        throw new MemoryError(`resolution refused: ${r.with} does not conflict with this lesson${conflicts.length ? ` (it conflicts with ${conflicts.map((c) => c.with.id).join(", ")})` : " (nothing in force conflicts with it)"}`);
      }
    }
    const open = conflicts.filter((c) => !resolutions.some((r) => r.with === c.with.id));
    if (open.length) {
      const fresher = fresh.kind === "exception"
        ? `${fresh.keys.length > 1 ? "rule" : "exception"} for ${fresh.findingClass} on ${fresh.keys.length > 3 ? `${fresh.keys.slice(0, 3).join(" ")} … +${fresh.keys.length - 3} more` : fresh.keys.join(" ")} (${fresh.tenantId}) until ${fresh.expiresAt}: ${oneLine(fresh.text)}`
        : `answer on ${fresh.key} (${fresh.tenantId}) until ${fresh.expiresAt}: ${oneLine(fresh.text)}`;
      throw new ConflictError(
        `lesson refused: it contradicts ${open.length === 1 ? "a lesson" : `${open.length} lessons`} in force on the same scope key. New: ${fresher}. Held: ${open.map((c) => `${describeLesson(c.with)} (${c.reason})`).join(" | ")}. `
        + `Settle each by id: supersede (the new lesson replaces it; it stays on record, marked superseded, and is no longer recalled) or keep_both.`,
        open, fresher,
      );
    }
    return conflicts;
  }

  /** After the new lesson is stored: the ledger's conflict_detected and conflict_resolved, the actor the technician; a superseded lesson is marked and kept. The caller persists, once. */
  private settle(winner: Lesson, conflicts: readonly LessonConflict[], resolutions: readonly ConflictResolution[], by: string): void {
    for (const c of conflicts) {
      const strategy = resolutions.find((r) => r.with === c.with.id)!.strategy;
      const conflictId = `conflict-${winner.id}-${c.with.id}`;
      const seen = { conflictId, reason: c.reason, confidence: Number(c.confidence.toFixed(3)) };
      // Both lessons carry the whole trail, so `npm run why` and history() show it from either side: the new lesson was recorded
      // against the held one ("new"), the held one had a later lesson recorded against it ("held"), whichever way it is settled.
      this.hmem.ledger.log(winner.id, "conflict_detected", by, { details: { ...seen, with: c.with.id, side: "new" } });
      this.hmem.ledger.log(c.with.id, "conflict_detected", by, { details: { ...seen, with: winner.id, side: "held" } });
      if (strategy === "supersede") {
        const loser = this.hmem.store.get(c.with.id)!;
        const previousState = snapshot(loser);
        loser.supersededBy = winner.id; // kept and penalised, never deleted (the reference's rule)
        this.hmem.ledger.log(loser.id, "conflict_resolved", by, { previousState, newState: snapshot(loser), details: { conflictId, strategy, winner: winner.id, with: winner.id } });
        this.hmem.ledger.log(winner.id, "conflict_resolved", by, { details: { conflictId, strategy, winner: winner.id, with: loser.id } });
        this.index.set(loser.id, { ...c.with, supersededBy: winner.id });
      } else {
        this.hmem.ledger.log(winner.id, "conflict_resolved", by, { details: { conflictId, strategy, with: c.with.id } });
        this.hmem.ledger.log(c.with.id, "conflict_resolved", by, { details: { conflictId, strategy, with: winner.id } });
      }
    }
  }

  /** (a) An answer to a question, on one scope of the tenant's estate, until it expires; stored and listed. */
  recordAnswer(input: AnswerInput): AnswerLesson {
    this.writable("answer");
    const v = parse(AnswerSchema, input, "answer");
    const recordedAt = this.nowIso();
    const question = clean(v.question), answer = clean(v.answer), by = clean(v.provenance.by);
    const resolutions = input.resolutions ?? [];
    const conflicts = this.gate({ kind: "answer", tenantId: v.tenantId, key: v.scope.key, scopeType: v.scope.type, question, answer, expiresAt: v.expiresAt, text: `Q ${question} A ${answer}` }, resolutions);
    const rec = this.hmem.add({
      content: `Technician answer on ${v.scope.type} ${v.scope.key} (${v.tenantId}): Q ${question} A ${answer}; until ${v.expiresAt}`,
      type: "factual", layer: "long_term", confidence: 1,
      tags: [
        `${TAG.kind}answer`, `${TAG.tenant}${v.tenantId}`, `${TAG.scopeType}${v.scope.type}`, `${TAG.scopeKey}${v.scope.key}`,
        `${TAG.expires}${v.expiresAt}`, `${TAG.recorded}${recordedAt}`, `${TAG.question}${question}`, `${TAG.answer}${answer}`,
        ...this.provTags(v.provenance, by),
        ...supersededIds(resolutions).map((id) => `${TAG.supersedes}${id}`),
      ],
      source: `technician:${v.provenance.kind}`,
      provenance: { origin: "manual", learnedAt: Date.parse(v.provenance.at), label: `answer taught by ${by}`, ...(v.provenance.runId ? { refs: [v.provenance.runId] } : {}) },
      chatId: v.tenantId,
      supersedes: supersededIds(resolutions)[0],
    });
    const lesson = lessonOf(rec);
    if (!lesson || lesson.kind !== "answer") throw new MemoryError(`answer ${rec.id} did not round-trip through the store`);
    this.index.set(lesson.id, lesson);
    this.settle(lesson, conflicts, resolutions, by);
    if (conflicts.length) this.hmem.store.persist();
    return lesson;
  }

  /** (b) An exception the technician accepted: findings of this class on this scope are ADOPT until the expiry, then re-raised. */
  recordException(input: ExceptionInput): ExceptionLesson {
    this.writable("exception");
    const v = parse(ExceptionSchema, input, "exception");
    const recordedAt = this.nowIso();
    const reason = clean(v.reason), by = clean(v.provenance.by);
    const resolutions = input.resolutions ?? [];
    const conflicts = this.gate({ kind: "exception", tenantId: v.tenantId, keys: [v.scopeKey], findingClass: v.findingClass, expiresAt: v.expiresAt, text: reason }, resolutions);
    const rec = this.hmem.add({
      content: `Accepted exception for ${v.findingClass} on ${v.scopeKey} (${v.tenantId}) until ${v.expiresAt}: ${reason}`,
      type: "preference", layer: "long_term", confidence: 1,
      tags: [
        `${TAG.kind}exception`, `${TAG.tenant}${v.tenantId}`, `${TAG.cls}${v.findingClass}`, `${TAG.scopeKey}${v.scopeKey}`,
        `${TAG.expires}${v.expiresAt}`, `${TAG.recorded}${recordedAt}`, `${TAG.reason}${reason}`,
        ...this.provTags(v.provenance, by),
        ...supersededIds(resolutions).map((id) => `${TAG.supersedes}${id}`),
      ],
      source: `technician:${v.provenance.kind}`,
      provenance: { origin: "user_correction", learnedAt: Date.parse(v.provenance.at), label: `exception accepted by ${by}`, ...(v.provenance.runId ? { refs: [v.provenance.runId] } : {}) },
      chatId: v.tenantId,
      supersedes: supersededIds(resolutions)[0],
    });
    const lesson = lessonOf(rec);
    if (!lesson || lesson.kind !== "exception") throw new MemoryError(`exception ${rec.id} did not round-trip through the store`);
    this.index.set(lesson.id, lesson);
    this.settle(lesson, conflicts, resolutions, by);
    if (conflicts.length) this.hmem.store.persist();
    return lesson;
  }

  /**
   * (c) A rule approved from dreaming (src/engine/dreaming.ts): one exception for a class over one or more scope keys, in place of
   * the lessons it is derived from. Those lessons must be exceptions in force on the rule's tenant and class that state the rule's
   * reason and expiry, and their scope keys must be the rule's keys exactly, so the rule decides what they decided. They are
   * superseded by it (kept on record, marked supersededBy, never recalled) and the ledger holds an update for each and a
   * dream_approved for the rule. The rule goes through the conflict gate like any lesson: a lesson outside the sources that
   * contradicts it on one of its keys refuses it, naming both, unless the technician settles that conflict by id.
   */
  recordRule(input: RuleInput): ExceptionLesson {
    this.writable("rule");
    const v = parse(RuleSchema, input, "rule");
    const recordedAt = this.nowIso();
    const reason = clean(v.reason), by = clean(v.provenance.by);
    const keys = [...new Set(v.scopeKeys)].sort();
    const sources = [...new Set(v.derivedFrom)].map((id) => this.index.get(id));
    const now = recordedAt;
    const bad = sources.findIndex((s) => !s || s.kind !== "exception" || s.derivedFrom || s.supersededBy || s.tenantId !== v.tenantId || s.findingClass !== v.findingClass
      || s.expiresAt !== v.expiresAt || s.expiresAt <= now || normQuestion(s.reason) !== normQuestion(reason) || !keys.includes(s.scopeKey));
    if (bad >= 0) throw new MemoryError(`rule refused: ${[...new Set(v.derivedFrom)][bad]} is not an exception in force for ${v.findingClass} on ${v.tenantId} that states this reason and expiry on one of the rule's scope keys`);
    const covered = new Set((sources as ExceptionLesson[]).map((s) => s.scopeKey));
    if (covered.size !== keys.length) throw new MemoryError(`rule refused: its scope keys are not exactly the keys of the lessons it is derived from (${keys.length} keys, the lessons cover ${covered.size})`);
    const ids = (sources as ExceptionLesson[]).map((s) => s.id);
    if (ids.length < 2) throw new MemoryError("rule refused: a rule is derived from at least two lessons");
    const resolutions = input.resolutions ?? [];
    const conflicts = this.gate({ kind: "exception", tenantId: v.tenantId, keys, findingClass: v.findingClass, expiresAt: v.expiresAt, text: reason }, resolutions, new Set(ids));
    const rec = this.hmem.add({
      content: `Rule for ${v.findingClass} on ${keys.length} scope key${keys.length === 1 ? "" : "s"} (${v.tenantId}) until ${v.expiresAt}: ${reason}`,
      type: "preference", layer: "long_term", confidence: 0.75,
      tags: [
        `${TAG.kind}exception`, `${TAG.tenant}${v.tenantId}`, `${TAG.cls}${v.findingClass}`, `${TAG.scopeKey}${keys[0]}`, `${TAG.scopeKeys}${keys.join(" ")}`,
        `${TAG.expires}${v.expiresAt}`, `${TAG.recorded}${recordedAt}`, `${TAG.reason}${reason}`, `${TAG.proposal}${v.proposalId}`,
        ...this.provTags(v.provenance, by),
      ],
      source: "dreaming",
      provenance: { origin: "dream", learnedAt: Date.parse(v.provenance.at), label: `rule approved by ${by} from proposal ${v.proposalId}` },
      chatId: v.tenantId,
      derivedFrom: ids,
    });
    const rule = lessonOf(rec);
    if (!rule || rule.kind !== "exception" || !rule.derivedFrom) throw new MemoryError(`rule ${rec.id} did not round-trip through the store`);
    this.index.set(rule.id, rule);
    this.hmem.ledger.log(rule.id, "dream_approved", by, { details: { proposalId: v.proposalId, derivedFrom: ids, scopeKeys: keys.length } });
    for (const s of sources as ExceptionLesson[]) {
      const old = this.hmem.store.get(s.id)!;
      const previousState = snapshot(old);
      old.supersededBy = rule.id; // kept on record, covered by the rule, never recalled
      this.hmem.ledger.log(old.id, "update", by, { previousState, newState: snapshot(old), details: { supersededBy: rule.id, proposalId: v.proposalId } });
      this.index.set(old.id, { ...s, supersededBy: rule.id });
    }
    this.settle(rule, conflicts, resolutions, by);
    this.hmem.store.persist();
    return rule;
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
      if (l.tenantId !== finding.tenant_id || l.supersededBy) continue; // a superseded lesson is on record, never recalled
      // A rule covers several keys; the Decider gets it with scopeKey set to the key this finding matched (name, then host, then address).
      const matched = l.kind === "exception"
        ? (l.findingClass === finding.class ? [...scopes.name, ...scopes.host, ...scopes.address].find((v) => (l.scopeKeys ?? [l.scopeKey]).includes(v)) : undefined)
        : scopes[l.scope.type].includes(l.scope.key) ? l.scope.key : undefined;
      if (matched === undefined) continue;
      const lapsed = l.expiresAt <= now;
      (lapsed ? expired : applicable).push(l.kind === "exception" && l.scopeKeys ? { ...l, scopeKey: matched } : l);
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
    this.writable("forget");
    const l = this.index.get(id);
    if (!l) return null;
    this.hmem.store.delete(id, clean(parse(text, reason, "forget reason")));
    this.index.delete(id);
    // A lesson this one superseded would stay silenced by a lesson that no longer exists: it stands again, and the ledger says so.
    for (const other of [...this.index.values()].filter((x) => x.supersededBy === id)) {
      const rec = this.hmem.store.get(other.id)!;
      const previousState = snapshot(rec);
      delete rec.supersededBy;
      this.hmem.ledger.log(rec.id, "update", this.actor, { previousState, newState: snapshot(rec), details: { reinstated: true, because: `${id} was withdrawn` } });
      const standing: Lesson = { ...other };
      delete standing.supersededBy;
      this.index.set(other.id, standing);
    }
    this.hmem.store.persist();
    return l;
  }

  /**
   * The trust ledger as the store holds it, oldest first, every record's entries. A store opened "read" does not load the
   * reference's ledger (it has no persistDir), so the file is read here, once, and this process's own recalls are not in it.
   */
  ledgerEntries(): LedgerEntry[] {
    if (!this.readOnly) return [...this.hmem.ledger.all()];
    this.persisted ??= readLedgerFile(path.join(this.directory!, "ledger.jsonl"));
    return this.persisted;
  }

  /** One record's entries in the trust ledger, oldest first: its creation, the conflicts it met, the sleep and dream steps that touched it. */
  history(id: string): LedgerEntry[] {
    return this.ledgerEntries().filter((e) => e.memoryId === id);
  }
}

/** The ledger file's entries, one JSON object per line; none when the file is absent; a line that does not parse is an error naming it. */
function readLedgerFile(file: string): LedgerEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l, i) => {
    try {
      return JSON.parse(l) as LedgerEntry;
    } catch {
      throw new MemoryError(`${file} line ${i + 1} is not JSON`);
    }
  });
}
