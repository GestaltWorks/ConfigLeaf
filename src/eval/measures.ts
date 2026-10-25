// The counts and measures of eval/PROTOCOL.md, computed from the runner's records and nothing else.
//
// Contract.
//   countRun: the protocol's "What is counted" per configuration run, over the scored items (raised or
//     history) of the set: checks selected, valid and run unmodified; falsifier queries run and the ones that
//     struck; strikes on items labelled no (agreed) and yes (wrong); verdict agreement with the label, unsure
//     apart; items not judged; calls, cache hits, substitutions, tokens and the median latency per call.
//   wilson: the Wilson score interval at 95% (z = 1.959964) for k agreements in n; null for n = 0.
//   determinism: C0 compares two passes' findings, verbs and reasons; a model configuration compares its
//     runs 1 and 2 item by item (verdict and every finding's reason); the count of differences.
//   coverage: items with a verdict over scored items, and findings with a disposition over findings assessed.
//   falsePositiveRate: items labelled no whose verdict reads yes, over scored items labelled no.
//   stability: per count, the spread (max - min) over the runs, each run counted over the items every one of
//     whose calls the receipt marks uncached (cache.status other than "hit").

import type { CallRecord } from "./models.ts";
import type { Counts, ItemOutcome, RunResult } from "./types.ts";

export const Z95 = 1.959963984540054;

export function wilson(k: number, n: number, z = Z95): { p: number; lo: number; hi: number } | null {
  if (n <= 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

const median = (xs: readonly number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** The protocol's counts over a run's items and calls. */
export function countRun(items: readonly ItemOutcome[], calls: readonly CallRecord[], isSubstitution: (c: CallRecord) => boolean): Counts {
  const scored = items.filter((i) => i.not_raised === null);
  const subjects = scored.flatMap((i) => i.subjects);
  const judged = subjects.flatMap((s) => (s.judge && "status" in s.judge ? [s.judge] : []));
  const ran = judged.filter((j) => j.rows !== null);
  const struckOn = (label: string): number => scored.filter((i) => i.label === label).reduce((a, i) => a + i.strikes, 0);
  return {
    items: items.length,
    scored: scored.length,
    not_raised: items.length - scored.length,
    with_verdict: scored.filter((i) => i.verdict !== null).length,
    not_judged: scored.filter((i) => i.verdict === null).length,
    agree: scored.filter((i) => i.agree === true).length,
    disagree: scored.filter((i) => i.agree === false).length,
    unsure: scored.filter((i) => i.label === "unsure").length,
    false_positives: scored.filter((i) => i.label === "no" && i.reading === "yes").length,
    labelled_no: scored.filter((i) => i.label === "no").length,
    checks_selected: sum(subjects.map((s) => s.selection?.selected ?? 0)),
    checks_valid: sum(subjects.map((s) => s.selection?.valid ?? 0)),
    checks_invalid: sum(subjects.map((s) => s.selection?.invalid.length ?? 0)),
    checks_ran_unmodified: sum(subjects.map((s) => (s.selection ? s.ran_unmodified : 0))),
    checks_run: sum(subjects.map((s) => s.checks.length)),
    falsifier_ran: ran.length,
    falsifier_struck: ran.filter((j) => j.status === "refuted").length,
    agreed_strikes: struckOn("no"),
    wrong_strikes: struckOn("yes"),
    early_stops: sum(subjects.map((s) => s.early_stops)),
    judge_withheld: subjects.filter((s) => s.judge !== null && "withheld" in s.judge).length,
    findings_assessed: subjects.length,
    findings_with_disposition: subjects.filter((s) => s.verb !== null).length,
    calls: calls.length,
    cache_hits: calls.filter((c) => c.cache_status === "hit").length,
    substitutions: calls.filter(isSubstitution).length,
    tokens_in: sum(calls.map((c) => c.tokens_in)),
    tokens_out: sum(calls.map((c) => c.tokens_out)),
    latency_ms_median: median(calls.map((c) => c.latency_ms)),
  };
}

export interface Coverage { items: { with_verdict: number; scored: number }; findings: { with_disposition: number; assessed: number } }

export const coverage = (c: Counts): Coverage => ({
  items: { with_verdict: c.with_verdict, scored: c.scored },
  findings: { with_disposition: c.findings_with_disposition, assessed: c.findings_assessed },
});

export const falsePositiveRate = (c: Counts): { k: number; n: number; rate: number | null } =>
  ({ k: c.false_positives, n: c.labelled_no, rate: c.labelled_no ? c.false_positives / c.labelled_no : null });

/** Accuracy against the labels: agreements over items with a verdict whose label is yes or no. */
export const accuracy = (c: Counts): { k: number; n: number; interval: ReturnType<typeof wilson> } =>
  ({ k: c.agree, n: c.agree + c.disagree, interval: wilson(c.agree, c.agree + c.disagree) });

/** The differences between two passes' findings, verbs and reasons, keyed by finding id. */
export function passDifferences(a: readonly { id: string; class: string; verb: string; reason: string }[], b: readonly { id: string; class: string; verb: string; reason: string }[]): string[] {
  const key = (f: { id: string; class: string; verb: string; reason: string }): string => `${f.id} ${f.class} ${f.verb}: ${f.reason}`;
  const as = new Set(a.map(key));
  const bs = new Set(b.map(key));
  return [...[...as].filter((k) => !bs.has(k)).map((k) => `first only: ${k}`), ...[...bs].filter((k) => !as.has(k)).map((k) => `second only: ${k}`)].sort();
}

/** The items whose verdict or any finding's reason differs between two runs of one configuration. */
export function runDifferences(a: RunResult, b: RunResult): string[] {
  const sig = (i: ItemOutcome): string => `${i.verdict ?? "not judged"} | ${i.subjects.map((s) => `${s.finding_id} ${s.verb ?? "-"}: ${s.reason}`).join(" | ")}${i.direct ? ` | direct ${i.direct.verb}` : ""}`;
  const bm = new Map(b.items.map((i) => [i.id, sig(i)]));
  return a.items.filter((i) => bm.get(i.id) !== sig(i)).map((i) => i.id);
}

/** The items every one of whose calls the receipt marks uncached. */
export function uncachedItems(r: RunResult): ItemOutcome[] {
  const cached = new Set(r.calls.filter((c) => c.cache_status === "hit").map((c) => c.item));
  return r.items.filter((i) => !cached.has(i.id));
}

export const STABLE_COUNTS = [
  "with_verdict", "not_judged", "agree", "disagree", "false_positives", "checks_selected", "checks_valid", "checks_ran_unmodified",
  "falsifier_ran", "falsifier_struck", "agreed_strikes", "wrong_strikes", "early_stops", "judge_withheld",
] as const satisfies readonly (keyof Counts)[];

/** Per count, its value in each run over that run's uncached items, and the spread. */
export function stability(runs: readonly RunResult[], isSubstitution: (c: CallRecord) => boolean): { uncached: number[]; counts: Record<string, { values: number[]; spread: number }> } {
  const per = runs.map((r) => {
    const items = uncachedItems(r);
    const ids = new Set(items.map((i) => i.id));
    return { n: items.length, c: countRun(items, r.calls.filter((c) => ids.has(c.item)), isSubstitution) };
  });
  const counts: Record<string, { values: number[]; spread: number }> = {};
  for (const k of STABLE_COUNTS) {
    const values = per.map((p) => p.c[k] as number);
    counts[k] = { values, spread: values.length ? Math.max(...values) - Math.min(...values) : 0 };
  }
  return { uncached: per.map((p) => p.n), counts };
}
