// The instant a pass over a bundle decides at: the later of the latest finish (else start) of its collection runs and
// the latest decided_at of the disposition rows it holds, ISO 8601 UTC as the bundle stores it; undefined for a bundle
// with neither. A pass given it as PassOptions.decidedAt (src/pipeline.ts) dates every disposition at it and starts
// every HOLD expiry from it, so two passes over the same rows give the same findings, expiries included, and a pass
// over a bundle that carries a live pass's ledger rows decides at that pass's instant, as the owner's document
// (scripts/document.ts), the examples (scripts/examples.ts) and the sample pass (scripts/sample.ts) do.
// scripts/build-site.ts passes it too; recall from the technician's memory keeps its own clock (PassOptions.at). Those
// four replays consult the technician's lessons and decide at decisionInstantWith: a lesson taught after the bundle's
// instant moves the decision to the instant it was taught.

type Stamped = { collection_run?: { started_at: string; finished_at: string | null }[]; disposition?: { decided_at: string }[] };

/** The later of the latest finished_at (else started_at) of the bundle's runs and the latest decided_at of its dispositions; undefined when it holds neither. */
export const decisionInstant = (bundle: unknown): string | undefined => {
  const b = bundle as Stamped;
  return [...(b.collection_run ?? []).map((r) => r.finished_at ?? r.started_at), ...(b.disposition ?? []).map((d) => d.decided_at)].sort().at(-1);
};

/**
 * The instant a replay that consults the technician's lessons decides at: the bundle's own instant, or the latest
 * instant a lesson was taught (ISO 8601 UTC, millisecond form, as TechnicianMemory records it) when that is later. A
 * lesson taught after the recorded pass makes a decision of its own: decided at the bundle's instant, the replay would
 * meet the recorded pass's ledger rows under the same disposition ids and print them, the verbs before the lesson.
 * With the lessons in a committed store the instant is the same on every run.
 */
export const decisionInstantWith = (bundle: unknown, taughtAt: readonly string[]): string | undefined =>
  [decisionInstant(bundle), ...taughtAt].filter((x): x is string => typeof x === "string" && x.length > 0).sort().at(-1);
