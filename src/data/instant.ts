// The instant a pass over a bundle decides at: the later of the latest finish (else start) of its collection runs and
// the latest decided_at of the disposition rows it holds, ISO 8601 UTC as the bundle stores it; undefined for a bundle
// with neither. A pass given it as PassOptions.decidedAt (src/pipeline.ts) dates every disposition at it and starts
// every HOLD expiry from it, so two passes over the same rows give the same findings, expiries included, and a pass
// over a bundle that carries a live pass's ledger rows decides at that pass's instant, as the owner's document
// (scripts/document.ts), the examples (scripts/examples.ts) and the sample pass (scripts/sample.ts) do.
// scripts/build-site.ts passes it too; recall from the technician's memory keeps its own clock (PassOptions.at).

type Stamped = { collection_run?: { started_at: string; finished_at: string | null }[]; disposition?: { decided_at: string }[] };

/** The later of the latest finished_at (else started_at) of the bundle's runs and the latest decided_at of its dispositions; undefined when it holds neither. */
export const decisionInstant = (bundle: unknown): string | undefined => {
  const b = bundle as Stamped;
  return [...(b.collection_run ?? []).map((r) => r.finished_at ?? r.started_at), ...(b.disposition ?? []).map((d) => d.decided_at)].sort().at(-1);
};
