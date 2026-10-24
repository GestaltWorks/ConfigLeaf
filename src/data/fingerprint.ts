// referent_fingerprint rows: what each dns_name observation of one run resolved to in the DNS run the pass
// paired the run with. The fingerprint is the value src/pipeline.ts stores on the referent in the World
// Model (the observe step): the contents of the name's A and AAAA records in that DNS run, as
// RESOLUTIONS_SQL returns them, sorted in code-unit order and joined by ",". A name with no address record
// in the DNS run has the fingerprint "" here and null in the World Model; each equals itself, so
// FOUND_BUT_DIFFERENT_SQL and DriftWorld.foundButDifferent agree on such a name.
//
// Contract: pure. One row per observation whose refers_to_type is dns_name, in obs_id order; dns_run_id
// and resolved_at are the DNS run's run_id and started_at (with the tenant, started_at names the DNS run:
// rows.ts runId). A resolution row of any other observation throws, because resolutions and observations
// of two different runs would give every name the fingerprint "".
//
// Measured 24 Oct 2026 on test/fixtures/authored-bundle.json (test/datalayer.test.ts): every row's
// fingerprint equals DriftWorld.fingerprintAt for its setting at its observation time after runPass, and
// FOUND_BUT_DIFFERENT_SQL over the rows returns the one setting DriftWorld.foundButDifferent flags.

import type { CollectionRun, ReferentFingerprint } from "./rows.ts";

/** A DataLayer row: every value a string, NULL as "" (queries.ts objects). */
type LayerRow = Readonly<Record<string, string>>;
/** The observation columns the fingerprint reads; a typed Observation and a DataLayer row both carry them. */
export type FingerprintObservation = { readonly obs_id: string; readonly refers_to_type: string | null } | LayerRow;
/** The RESOLUTIONS_SQL columns the fingerprint reads. */
export type FingerprintResolution = { readonly obs_id: string; readonly content: string } | LayerRow;
/** The DNS run the observations were paired with. */
export type FingerprintRun = Pick<CollectionRun, "run_id" | "started_at"> | LayerRow;

/** The contents of a name's address records as one fingerprint: sorted in code-unit order, joined by ",". */
export const referentFingerprint = (contents: readonly string[]): string => [...contents].sort().join(",");

export function fingerprintRows(
  observations: readonly FingerprintObservation[],
  resolutions: readonly FingerprintResolution[],
  dnsRun: FingerprintRun,
): ReferentFingerprint[] {
  const contents = new Map<string, string[]>();
  for (const o of observations) if (o.refers_to_type === "dns_name") contents.set(o.obs_id, []);
  for (const r of resolutions) {
    const list = contents.get(r.obs_id);
    if (!list) throw new Error(`fingerprintRows: resolution for ${r.obs_id}, which is no dns_name observation of the run`);
    list.push(r.content);
  }
  return [...contents.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([obs_id, list]) => ({ obs_id, dns_run_id: dnsRun.run_id, fingerprint: referentFingerprint(list), resolved_at: dnsRun.started_at }));
}
