// The sleep cycle's preview over the technician's lessons (the vendored H-MEM SleepCycleService, vendor/hmem/src/sleepCycle.ts).
//
// The reference's sleep cycle keeps a store healthy in three moves: consolidate (promote short-term records that earned it),
// archive (delete old, unreferenced, rarely read records) and synthesize (merge near-duplicates into one "Synthesis" record
// and delete the originals). Its rule is preview first: preview() plans and changes nothing; execute() acts on a plan.
// ConfigLeaf ships the preview only, because a lesson is the technician's exact word on one scope key. Recall reads a
// record's tags, and a synthesized record carries the union of its members' tags, so the Decider reads the first
// member's scope key from it and the others stop applying. `ifExecuted` shows that: the reference's own execute() run
// on a scratch copy held in memory, never on the store, and the scope keys that lose their coverage.
//
// A lesson's own expiry is the technician's sense of expiry: recall flags it and the Decider re-raises the finding. The
// reference's sleep cycle ignores it. `lapsed` lists those lessons, so the preview names what has expired beside what sleep
// removes. The reference has no demotion move; consolidate promotes.
import { HMEM, type MemoryRecord } from "../../vendor/hmem/src/index.ts";
import { lessonOf, type Lesson, type TechnicianMemory } from "./memory.ts";

export interface SleepItem {
  id: string;
  /** What the record is, in one line: a lesson's class and scope key, an approved rule, or another record. */
  what: string;
}

export interface SleepView {
  /** The instant the preview is taken at (the memory's clock). */
  at: string;
  records: number;
  lessons: number;
  consolidate: SleepItem[];
  archive: SleepItem[];
  synthesize: SleepItem[][];
  /** Lessons whose expiry has passed at `at`; they stay in the store and recall flags them. */
  lapsed: Lesson[];
  /** The reference's execute() on a scratch copy; null when the plan is empty. */
  ifExecuted: { lessonsBefore: number; lessonsAfter: number; scopeKeysLost: string[] } | null;
}

/** The scopes a lesson covers, one string each: tenant, class (or "answer") and key. A rule covers one per scope key. */
const coverage = (l: Lesson): string[] => l.kind === "exception"
  ? (l.scopeKeys ?? [l.scopeKey]).map((k) => `${l.tenantId} ${l.findingClass} ${k}`)
  : [`${l.tenantId} answer ${l.scope.key}`];

/** What the plan does to the store, executed on a scratch copy: the lessons readable before and after, and the coverage lost. */
function simulate(memory: TechnicianMemory): NonNullable<SleepView["ifExecuted"]> {
  const snap = memory.hmem.store.snapshotAll();
  const scratch = new HMEM({ clock: memory.hmem.clock });
  scratch.store.restoreAll(snap.records, snap.seq);
  const readable = (records: readonly MemoryRecord[]): Lesson[] => records.map(lessonOf).filter((l): l is Lesson => l !== null && !l.supersededBy);
  const before = readable(scratch.store.all());
  scratch.sleep.execute();
  const after = readable(scratch.store.all());
  const kept = new Set(after.flatMap(coverage));
  return { lessonsBefore: before.length, lessonsAfter: after.length, scopeKeysLost: [...new Set(before.flatMap(coverage))].filter((c) => !kept.has(c)).sort() };
}

/** The sleep cycle's plan for the store at the memory's clock. Reads only: a store opened "read" is never written, and the scratch copy is dropped. */
export function previewSleep(memory: TechnicianMemory): SleepView {
  const plan = memory.hmem.sleep.preview();
  const item = (id: string): SleepItem => {
    const l = memory.lesson(id);
    const what = !l ? "record that is not a lesson"
      : l.kind === "answer" ? `answer ${l.scope.type} on ${l.scope.key} (${l.tenantId})`
        : l.scopeKeys ? `rule ${l.findingClass} on ${l.scopeKeys.length} scope(s) (${l.tenantId})`
          : `exception ${l.findingClass} on ${l.scopeKey} (${l.tenantId})`;
    return { id, what };
  };
  const now = new Date(memory.hmem.clock()).toISOString();
  const empty = plan.toConsolidate.length === 0 && plan.toArchive.length === 0 && plan.toSynthesize.length === 0;
  return {
    at: now,
    records: memory.hmem.store.all().length,
    lessons: memory.lessons().length,
    consolidate: plan.toConsolidate.map(item),
    archive: plan.toArchive.map(item),
    synthesize: plan.toSynthesize.map((g) => g.map(item)),
    lapsed: memory.lessons().filter((l) => !l.supersededBy && l.expiresAt <= now),
    ifExecuted: empty ? null : simulate(memory),
  };
}

const ids = (xs: readonly SleepItem[], n = 8): string => (xs.length <= n ? xs.map((x) => x.id).join(" ") : `${xs.slice(0, n).map((x) => x.id).join(" ")} … +${xs.length - n} more`);

/** The preview as the command prints it. */
export function renderSleep(v: SleepView): string[] {
  const out = [`sleep preview at ${v.at}: ${v.records} record(s), ${v.lessons} lesson(s); nothing is changed`];
  out.push(`  consolidate ${v.consolidate.length}  (short-term records that earned long-term${v.consolidate.length ? `: ${ids(v.consolidate)}` : ""})`);
  out.push(`  archive     ${v.archive.length}  (old, unreferenced, rarely read; they leave the store${v.archive.length ? `: ${v.archive.map((x) => `${x.id} ${x.what}`).join("; ")}` : ""})`);
  out.push(`  synthesize  ${v.synthesize.length}  (near-duplicates merged into one record, the originals deleted)`);
  for (const g of v.synthesize) {
    out.push(`    ${g.length} records: ${ids(g)}`);
    const kinds = new Map<string, number>();
    for (const x of g) kinds.set(x.what.replace(/ on .*$/, ""), (kinds.get(x.what.replace(/ on .*$/, "")) ?? 0) + 1);
    out.push(`    made of ${[...kinds].map(([k, n]) => `${k} x${n}`).join(", ")}`);
  }
  out.push(`  lapsed      ${v.lapsed.length}  (expiry passed; kept, flagged by recall, the finding is re-raised; the cycle ignores it${v.lapsed.length ? `: ${v.lapsed.slice(0, 8).map((l) => l.id).join(" ")}${v.lapsed.length > 8 ? ` … +${v.lapsed.length - 8} more` : ""}` : ""})`);
  if (v.ifExecuted) {
    const x = v.ifExecuted;
    out.push(`  if executed (the reference's execute() on a scratch copy; this command never executes): ${x.lessonsBefore} lesson(s) readable before, ${x.lessonsAfter} after; ${x.scopeKeysLost.length} scope key(s) no longer covered`);
    if (x.scopeKeysLost.length) out.push(`    the Decider stops adopting findings on those scopes. Nothing runs the plan: npm run sleep takes --preview only`);
  } else {
    out.push("  the plan is empty: a sleep cycle changes nothing today");
  }
  return out;
}
