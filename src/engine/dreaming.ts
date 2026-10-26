// Dreaming over the technician's lessons: the vendored H-MEM DreamingService (vendor/hmem/src/dreaming.ts) clusters, and
// ConfigLeaf turns each cluster into a rule proposal.
//
// The reference clusters related records (content similarity, tag overlap, shared domain and entities) and writes each
// cluster up as an insight or an invariant whose content is the cluster's text joined. That text is no rule. `dreamOver`
// keeps the reference's clustering and reads what the lessons of each cluster share: the tenant, the class, the reason and
// the expiry. Lessons that share all four are one rule proposal: "ADOPT <class> on these scope keys, for this reason, until
// this expiry, derived from these lessons". A cluster, or part of one, with no two lessons sharing all four yields no
// proposal, and the result says why (`withheld`).
//
// Proposing writes nothing: dreaming runs over a scratch store holding the first-hand lessons in force (a rule, a lapsed
// lesson and a superseded one are no beliefs to generalise from), and the reference's proposal ledger lines stay in that
// scratch store. `approveDream` is the one writer, and `npm run answer -- --approve-dream <id>` is the one door to it. It
// records the rule through TechnicianMemory.recordRule, behind the conflict gate: one exception for the class over the
// scope keys, with `derivedFrom` lineage, superseding the lessons it replaces. The Decider recalls the rule where it
// recalled those lessons, with the same verb and expiry, because the rule states the class, reason and expiry of each source
// and covers exactly their scope keys. `npm run why` prints "covered by rule ...".
import { createHash } from "node:crypto";
import { DEFAULTS, HMEM } from "../../vendor/hmem/src/index.ts";
import type { FindingClass } from "../catalogue/templates.ts";
import { MemoryError, cleanFree, type ConflictResolution, type ExceptionLesson, type Lesson, type TechnicianMemory } from "./memory.ts";

/** A rule: an exception lesson over several scope keys with `derivedFrom` lineage. */
export type Rule = ExceptionLesson & { scopeKeys: string[]; derivedFrom: string[] };

export const isRule = (l: Lesson): l is Rule => l.kind === "exception" && Boolean(l.scopeKeys) && Boolean(l.derivedFrom?.length);

/** Every rule in the store, oldest first, those a later rule superseded included. */
export const rulesOf = (memory: TechnicianMemory): Rule[] => memory.lessons().filter(isRule);

export interface RuleProposal {
  /** `drm-` and 12 hex over the rule's fields and sources: the same lessons give the same id, a changed set gives another. */
  id: string;
  tenantId: string;
  findingClass: FindingClass;
  reason: string;
  expiresAt: string;
  /** Sorted. */
  scopeKeys: string[];
  /** The lessons the rule replaces, by id. */
  derivedFrom: string[];
  /** The reference's proposals whose clusters held these lessons, such as "dream-1 insight". */
  clusters: string[];
}

/** Lessons the reference clustered that no rule covers, and why. */
export interface Withheld {
  clusters: string[];
  lessons: string[];
  why: string;
}

export interface DreamResult {
  /** First-hand lessons in force: what dreaming read. */
  lessons: number;
  /** The reference's insight and invariant proposals: the clusters. */
  clusters: number;
  proposals: RuleProposal[];
  withheld: Withheld[];
  /** The reference's relabel proposals, listed and not approvable. */
  relabels: { id: string; content: string; domain: string }[];
  /** Rules in force. */
  approved: Rule[];
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
const byId = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/** The lessons dreaming reads: first-hand lessons in force at the memory's clock, not superseded and not rules. */
export function inForce(memory: TechnicianMemory): Lesson[] {
  const now = new Date(memory.hmem.clock()).toISOString();
  return memory.lessons().filter((l) => !l.supersededBy && l.expiresAt > now && !isRule(l));
}

const ruleId = (p: Omit<RuleProposal, "id" | "clusters">): string =>
  `drm-${createHash("sha256").update(JSON.stringify([p.tenantId, p.findingClass, p.reason, p.expiresAt, p.scopeKeys, p.derivedFrom])).digest("hex").slice(0, 12)}`;

/** Why the lessons of a cluster are in no rule, from the lessons themselves. */
function whyWithheld(left: readonly Lesson[]): string {
  const parts: string[] = [];
  const answers = left.filter((l) => l.kind === "answer");
  const exceptions = left.filter((l): l is ExceptionLesson => l.kind === "exception");
  if (answers.length) parts.push(`${answers.length} answer lesson(s) carry no class, so no rule covers them`);
  if (exceptions.length) {
    const n = (f: (l: ExceptionLesson) => string): number => new Set(exceptions.map(f)).size;
    parts.push(`${exceptions.length} exception lesson(s) share no class, reason and expiry with another lesson of the cluster (${n((l) => l.findingClass)} class(es), ${n((l) => norm(l.reason))} reason(s), ${n((l) => l.expiresAt)} expiry(ies) among them)`);
  }
  return parts.join("; ");
}

/** What dreaming proposes over the lessons in force. Writes nothing, not even to the ledger. */
export function dreamOver(memory: TechnicianMemory): DreamResult {
  const lessons = inForce(memory);
  const held = new Map(lessons.map((l) => [l.id, l]));
  const scratch = new HMEM({ clock: memory.hmem.clock });
  scratch.store.restoreAll(lessons.map((l) => structuredClone(memory.hmem.store.get(l.id)!)), memory.hmem.store.snapshotAll().seq);
  const vendor = scratch.dreaming.dream();
  const clusters = vendor.filter((p) => p.type !== "domain");

  // Lessons that share tenant, class, reason and expiry, across the reference's clusters.
  const groups = new Map<string, { sample: ExceptionLesson; ids: Set<string>; from: Set<string> }>();
  for (const p of clusters) {
    for (const id of p.derivedFrom) {
      const l = held.get(id);
      if (l?.kind !== "exception") continue;
      const key = JSON.stringify([l.tenantId, l.findingClass, norm(l.reason), l.expiresAt]);
      const g = groups.get(key) ?? { sample: l, ids: new Set<string>(), from: new Set<string>() };
      g.ids.add(id);
      g.from.add(`${p.id} ${p.type}`);
      groups.set(key, g);
    }
  }
  const proposals: RuleProposal[] = [];
  for (const g of groups.values()) {
    if (g.ids.size < DEFAULTS.dreamClusterMinSize) continue;
    const derivedFrom = [...g.ids].sort(byId);
    const scopeKeys = [...new Set(derivedFrom.map((id) => (held.get(id) as ExceptionLesson).scopeKey))].sort();
    const fields = { tenantId: g.sample.tenantId, findingClass: g.sample.findingClass, reason: g.sample.reason, expiresAt: g.sample.expiresAt, scopeKeys, derivedFrom };
    proposals.push({ id: ruleId(fields), ...fields, clusters: [...g.from].sort(byId) });
  }
  proposals.sort((a, b) => b.derivedFrom.length - a.derivedFrom.length || a.findingClass.localeCompare(b.findingClass) || a.id.localeCompare(b.id));

  // What no rule covers, per cluster, once; clusters that leave the same lessons for the same reason are one line.
  const covered = new Set(proposals.flatMap((p) => p.derivedFrom));
  const withheld = new Map<string, Withheld>();
  for (const p of clusters) {
    const left = p.derivedFrom.filter((id) => !covered.has(id)).map((id) => held.get(id)).filter((l): l is Lesson => l !== undefined);
    if (!left.length) continue;
    const ids = left.map((l) => l.id).sort(byId);
    const why = whyWithheld(left);
    const w = withheld.get(JSON.stringify([ids, why])) ?? { clusters: [], lessons: ids, why };
    w.clusters.push(`${p.id} ${p.type}`);
    withheld.set(JSON.stringify([ids, why]), w);
  }
  return {
    lessons: lessons.length,
    clusters: clusters.length,
    proposals,
    withheld: [...withheld.values()],
    relabels: vendor.filter((p) => p.type === "domain").map((p) => ({ id: p.id, content: p.content, domain: p.suggestedDomain ?? "?" })),
    approved: rulesOf(memory).filter((r) => !r.supersededBy && r.expiresAt > new Date(memory.hmem.clock()).toISOString()),
  };
}

/**
 * Approve one rule proposal by its stable id. Dreaming runs again over the lessons as they stand, so an id from before a lesson
 * changed is refused. The rule is recorded through the conflict gate (`resolutions` settle a conflict with a lesson outside the
 * proposal's sources, as for any lesson) and supersedes the lessons it is derived from. Refused for a store opened read-only,
 * for an id no proposal has now, for one already approved, and for an empty role.
 */
export function approveDream(memory: TechnicianMemory, id: string, role: string, resolutions: ConflictResolution[] = []): Rule {
  if (memory.readOnly) throw new MemoryError(`approve refused: the store at ${memory.directory} is open read-only; npm run answer approves`);
  const done = rulesOf(memory).find((r) => r.proposalId === id);
  if (done) throw new MemoryError(`proposal ${id} is already approved as ${done.id}`);
  const proposal = dreamOver(memory).proposals.find((p) => p.id === id);
  if (!proposal) throw new MemoryError(`no rule proposal ${id} over the lessons as they stand now; run npm run dream again for the current ids`);
  const by = cleanFree(role).trim().slice(0, 128);
  if (!by) throw new MemoryError("approve refused: --by names the role that approves, and it is empty");
  const rule = memory.recordRule({
    tenantId: proposal.tenantId, findingClass: proposal.findingClass, scopeKeys: proposal.scopeKeys, reason: proposal.reason, expiresAt: proposal.expiresAt,
    provenance: { kind: "dream", at: new Date(memory.hmem.clock()).toISOString(), by }, derivedFrom: proposal.derivedFrom, proposalId: proposal.id, resolutions,
  });
  return rule as Rule;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ids = (xs: readonly string[], n = 8): string => (xs.length <= n ? xs.join(" ") : `${xs.slice(0, n).join(" ")} … +${xs.length - n} more`);

/** The result as the command prints it. */
export function renderDream(r: DreamResult): string[] {
  const out = [`${r.proposals.length} rule proposal(s) from ${r.clusters} cluster(s) of dreaming over ${r.lessons} lesson(s) in force; nothing is written by proposing`];
  for (const p of r.proposals) {
    out.push("");
    out.push(`${p.id}  ADOPT ${p.findingClass} on ${p.scopeKeys.length} scope(s), tenant ${p.tenantId}, until ${p.expiresAt}, derived from ${p.derivedFrom.length} lesson(s)`);
    out.push(`  reason       ${clip(p.reason, 150)}`);
    out.push(`  scopes       ${ids(p.scopeKeys, 12)}`);
    out.push(`  derivedFrom  ${ids(p.derivedFrom, 40)}`);
    out.push(`  clustered    by the reference's dreaming as ${p.clusters.join(", ")}`);
    out.push(`  approving    supersedes those ${p.derivedFrom.length} lesson(s), which stay on record and leave recall, and records this one rule in their place`);
    out.push(`  decisions    stay the same: the rule states the class, reason and expiry of each of those lessons and covers exactly their ${p.scopeKeys.length} scope key(s)`);
    out.push(`  approve      npm run answer -- --approve-dream ${p.id} [--by <role>]`);
  }
  if (!r.clusters) {
    out.push("", r.lessons ? `no proposal: dreaming found no cluster, since no lesson is related enough to another (relatedness ${DEFAULTS.dreamRelatedness})` : "no proposal: no lesson is in force");
  }
  for (const w of r.withheld) {
    out.push("", `no rule for ${w.lessons.length} lesson(s) of ${w.clusters.join(", ")}: ${ids(w.lessons)}`);
    out.push(`  why          ${w.why}`);
  }
  for (const l of r.relabels) out.push("", `relabel ${l.id} to the domain ${l.domain}: listed only, since the Decider reads no lesson's domain (${clip(l.content, 100)})`);
  if (r.approved.length) {
    out.push("", `${r.approved.length} rule(s) approved and in force:`);
    for (const a of r.approved) out.push(`  ${a.id}  ADOPT ${a.findingClass} on ${a.scopeKeys.length} scope(s), until ${a.expiresAt}, derived from ${a.derivedFrom.length} lesson(s), approved by ${a.provenance.by} at ${a.recordedAt}`);
  }
  return out;
}
