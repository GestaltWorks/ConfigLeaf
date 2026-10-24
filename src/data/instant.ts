// The instant a pass over a bundle decides at: the latest finish (else start) of its collection runs, ISO
// 8601 UTC as the bundle stores it; undefined for a bundle with no run. A pass given it as
// PassOptions.decidedAt (src/pipeline.ts) dates every disposition at it and starts every HOLD expiry from
// it, so two passes over the same rows give the same findings, expiries included. scripts/sample.ts,
// scripts/examples.ts and scripts/build-site.ts pass it; recall from the technician's memory keeps its own
// clock (PassOptions.at).

/** The latest finished_at (else started_at) of the bundle's collection runs; undefined when it holds none. */
export const decisionInstant = (bundle: unknown): string | undefined =>
  ((bundle as { collection_run?: { started_at: string; finished_at: string | null }[] }).collection_run ?? []).map((r) => r.finished_at ?? r.started_at).sort().at(-1);
