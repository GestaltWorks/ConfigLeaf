// Dreaming over the technician's lessons (the vendored H-MEM DreamingService, vendor/hmem/src/dreaming.ts).
//
// `dreamOver` proposes: the reference clusters related records and writes each cluster up as an insight (a long-term
// fact) or an invariant (a long-term preference), and a domain relabel for a record it files under "general". It runs
// over a scratch store holding only the lessons in force, so nothing is written by proposing, an approved rule never
// feeds the next dream, and a lapsed or superseded lesson is not a belief to generalise from.
//
// `approveDream` is the one writer, and `npm run answer -- --approve-dream <id>` is the one door to it. The reference's
// approve() writes through the DreamingService's own store; the scratch store is not the live one, so the record is
// materialised here in the reference's own shape (insight: factual, invariant: preference; long_term, confidence 0.75,
// source "dreaming", origin "dream", derivedFrom the proposal's sources) and the ledger gets create and dream_approved.
// An approved rule is inert for the Decider, which recalls lessons by exact scope key, so a rule's reach decides nothing: it is
// a recorded generalisation with its lineage, which `npm run why` shows beside the lessons it derives from.
//
// The reference's model-free dreaming groups related records, and the content of its insight and invariant is the joined
// text of the cluster's records. `restates` says so in the data, from the sources themselves, so a command that prints a
// proposal presents a concatenation as a concatenation.
import { createHash } from "node:crypto";
import { HMEM, type DreamProposalType, type MemoryRecord } from "../../vendor/hmem/src/index.ts";
import { MemoryError, cleanFree, type Lesson, type TechnicianMemory } from "./memory.ts";

/** What the lessons of a proposal have in common, counted from the lessons. */
export interface Shared {
  lessons: number;
  tenants: string[];
  /** Exception classes and "answer", most frequent first. */
  kinds: [string, number][];
  scopeKeys: number;
  reasons: number;
  expiries: string[];
}

export interface DreamView {
  /** `drm-` and 12 hex over the proposal's type, sources and content: the same lessons give the same id, a changed set gives another. */
  id: string;
  /** The reference's own id in this run (dream-N); not stable across runs. */
  vendorId: string;
  type: DreamProposalType;
  content: string;
  /** The lessons the proposal derives from. */
  derivedFrom: string[];
  suggestedDomain?: string;
  shared: Shared;
  /** True when the content is only the sources' text joined under a header: the proposal groups its lessons and adds no statement of its own. */
  restates: boolean;
  /** The rule that carries this proposal, when it has been approved. */
  approvedAs: string | null;
}

/** An approved proposal: a record with `derivedFrom` lineage back to the lessons. */
export interface Rule {
  id: string;
  type: Exclude<DreamProposalType, "domain">;
  content: string;
  derivedFrom: string[];
  /** The stable proposal id (drm-...) it was approved under. */
  proposalId: string;
  approvedBy: string;
  approvedAt: string;
}

const tagOf = (r: MemoryRecord, prefix: string): string | undefined => r.tags.find((t) => t.startsWith(prefix))?.slice(prefix.length);

/** A rule from its H-MEM record, or null for a record that is not an approved dream. */
export function ruleOf(r: MemoryRecord): Rule | null {
  const type = r.provenance.origin === "dream" ? (tagOf(r, "dream:") as Rule["type"] | undefined) : undefined;
  if ((type !== "insight" && type !== "invariant") || !r.derivedFrom?.length) return null;
  return { id: r.id, type, content: r.content, derivedFrom: [...r.derivedFrom], proposalId: tagOf(r, "dream_id:") ?? "", approvedBy: tagOf(r, "approved_by:") ?? "", approvedAt: new Date(r.timestamp).toISOString() };
}

/** Every approved rule in the store, oldest first. */
export function rulesOf(memory: TechnicianMemory): Rule[] {
  return memory.hmem.store.all().map(ruleOf).filter((r): r is Rule => r !== null).sort((a, b) => a.approvedAt.localeCompare(b.approvedAt) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** The approved rules that derive from one lesson. */
export const rulesFrom = (memory: TechnicianMemory, lessonId: string): Rule[] => rulesOf(memory).filter((r) => r.derivedFrom.includes(lessonId));

const HEADER = /^(?:Across \d+ related memories \([^)]*\):|Stable pattern in [^:]*:)?[\s+;]*$/;

/** True when taking every source's text out of the proposal leaves only its header and separators. */
function restatesSources(content: string, sources: readonly string[]): boolean {
  return HEADER.test(sources.reduce((rest, s) => rest.replace(s, ""), content));
}

function sharedOf(lessons: readonly Lesson[]): Shared {
  const kinds = new Map<string, number>();
  for (const l of lessons) kinds.set(l.kind === "exception" ? l.findingClass : "answer", (kinds.get(l.kind === "exception" ? l.findingClass : "answer") ?? 0) + 1);
  return {
    lessons: lessons.length,
    tenants: [...new Set(lessons.map((l) => l.tenantId))].sort(),
    kinds: [...kinds].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    scopeKeys: new Set(lessons.map((l) => (l.kind === "exception" ? l.scopeKey : l.scope.key))).size,
    reasons: new Set(lessons.map((l) => (l.kind === "exception" ? l.reason : `${l.question} ${l.answer}`))).size,
    expiries: [...new Set(lessons.map((l) => l.expiresAt))].sort(),
  };
}

const proposalId = (type: string, derivedFrom: readonly string[], content: string): string =>
  `drm-${createHash("sha256").update(JSON.stringify([type, [...derivedFrom].sort(), content])).digest("hex").slice(0, 12)}`;

/** The lessons dreaming reads: in force at the memory's clock and not superseded. */
export function inForce(memory: TechnicianMemory): Lesson[] {
  const now = new Date(memory.hmem.clock()).toISOString();
  return memory.lessons().filter((l) => !l.supersededBy && l.expiresAt > now);
}

/** What the reference's dreaming proposes over the lessons in force. Writes nothing, not even to the ledger. */
export function dreamOver(memory: TechnicianMemory): DreamView[] {
  const lessons = inForce(memory);
  const byId = new Map(lessons.map((l) => [l.id, l]));
  const scratch = new HMEM({ clock: memory.hmem.clock });
  scratch.store.restoreAll(lessons.map((l) => structuredClone(memory.hmem.store.get(l.id)!)), memory.hmem.store.snapshotAll().seq);
  const approved = new Map(rulesOf(memory).map((r) => [r.proposalId, r.id]));
  return scratch.dreaming.dream().map((p): DreamView => {
    const sources = p.derivedFrom.map((id) => byId.get(id)).filter((l): l is Lesson => l !== undefined);
    const id = proposalId(p.type, p.derivedFrom, p.content);
    return {
      id, vendorId: p.id, type: p.type, content: p.content, derivedFrom: [...p.derivedFrom], ...(p.suggestedDomain ? { suggestedDomain: p.suggestedDomain } : {}),
      shared: sharedOf(sources),
      restates: p.type !== "domain" && restatesSources(p.content, p.derivedFrom.map((s) => scratch.store.get(s)?.content ?? "")),
      approvedAs: approved.get(id) ?? null,
    };
  });
}

/**
 * Approve one proposal by its stable id: dreaming is run again over the lessons as they stand, so an id from a run before a
 * lesson changed is refused, and the record is written with its lineage. Refused for a store opened read-only, for an id no
 * proposal has now, for one already approved, and for a domain relabel (the Decider does not read a lesson's domain).
 */
export function approveDream(memory: TechnicianMemory, id: string, role: string): Rule {
  if (memory.readOnly) throw new MemoryError(`approve refused: the store at ${memory.directory} is open read-only; npm run answer approves`);
  const view = dreamOver(memory).find((v) => v.id === id);
  if (!view) throw new MemoryError(`no proposal ${id} over the lessons as they stand now; run npm run dream again for the current ids`);
  if (view.approvedAs) throw new MemoryError(`proposal ${id} is already approved as ${view.approvedAs}`);
  if (view.type === "domain") throw new MemoryError(`proposal ${id} relabels lessons into the domain ${view.suggestedDomain ?? "?"}; the Decider reads no lesson's domain, so the proposal is listed and has no approval`);
  const by = cleanFree(role).trim().slice(0, 128);
  if (!by) throw new MemoryError("approve refused: --by names the role that approves, and it is empty");
  const rec = memory.hmem.add({
    content: view.content,
    type: view.type === "insight" ? "factual" : "preference",
    layer: "long_term",
    tags: [`dream:${view.type}`, `dream_id:${view.id}`, `approved_by:${by}`],
    confidence: 0.75,
    source: "dreaming",
    provenance: { origin: "dream", learnedAt: memory.hmem.clock(), label: `approved ${view.type} proposal ${view.id}` },
    derivedFrom: view.derivedFrom,
  });
  memory.hmem.ledger.log(rec.id, "dream_approved", by, { details: { proposalId: view.id, type: view.type, derivedFrom: view.derivedFrom, vendorId: view.vendorId } });
  return ruleOf(rec)!;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ids = (xs: readonly string[], n = 6): string => (xs.length <= n ? xs.join(" ") : `${xs.slice(0, n).join(" ")} … +${xs.length - n} more`);

/** The proposals as the command prints them: what each derives from, what its lessons share, what it says, and how to approve it. */
export function renderDream(views: readonly DreamView[], lessonsInForce: number): string[] {
  const out = [`${views.length} proposal(s) over ${lessonsInForce} lesson(s) in force; nothing is written by proposing`];
  for (const v of views) {
    const s = v.shared;
    out.push("");
    out.push(`${v.id}  ${v.type}${v.approvedAs ? `  (approved as ${v.approvedAs})` : ""}  derives from ${v.derivedFrom.length} lesson(s): ${ids(v.derivedFrom)}`);
    if (v.type === "domain") {
      out.push(`  relabels   ${v.suggestedDomain ?? "?"}: ${clip(v.content, 140)}`);
      out.push("  listed only: the Decider reads no lesson's domain, so the proposal has no approval");
      continue;
    }
    out.push(`  they share ${s.kinds.map(([k, n]) => `${k} x${n}`).join(", ")}; tenant ${s.tenants.join(", ")}; ${s.scopeKeys} scope key(s); ${s.reasons} distinct reason(s); expiry ${s.expiries.join(", ")}`);
    out.push(`  content    ${clip(v.content, 150)} (${v.content.length} characters)`);
    out.push(`  reading    ${v.restates ? "restates its lessons: the content is their text joined under a header, with no rule of its own" : "carries text of its own beside its lessons' text"}`);
    if (!v.approvedAs) out.push(`  approve    npm run answer -- --approve-dream ${v.id} [--by <role>]`);
  }
  return out;
}
