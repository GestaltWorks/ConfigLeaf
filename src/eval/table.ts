// The README's results table for one eval results directory (scripts/eval-table.ts prints it; npm run eval:table).
// evalTable reads every <config>-run<n>.json and planted.json the runner wrote (scripts/eval.ts) and returns a lead line
// of totals and median output tokens, then one markdown table with one row per configuration in protocol order. A cell
// holds one value when every run of the configuration gives it, and each run's value, comma-separated, when they differ.
//
// Columns, each read from the committed records and nothing else:
//   what runs                the configuration's row of eval/PROTOCOL.md, as the runner recorded it;
//   agree / judged           agreements over items with a verdict whose label is yes or no (measures.ts accuracy);
//   findings decided by      per run, the findings with a disposition by who decided them (decided_by: policy, operator,
//                            judge, default); "the model" for a configuration that gives the verdict alone (C4);
//   labelled no, read yes    items labelled no whose verdict reads yes, over items labelled no (falsePositiveRate);
//   planted claims struck    the judge's strikes over the planted false claims of that run (planted.json);
//   checks valid / selected  the selecting model's valid checks over the checks it selected;
//   items not judged         scored items with no verdict;
//   calls                    call records of the run, planted claims' calls included;
//   receipts verified        call records whose receipt signature verifies;
//   substitutions, cache hits  as the runner counted them;
//   median output tokens     tokens_out per call kind and tier over the configuration's runs, records a route answered
//                            (served_model set).
// The lead line's medians pool the same records over every configuration. Rows follow configuration order and every
// column is a count, a fraction or a median (eval/PROTOCOL.md "Then, second"). evalTable reads files and nothing else.
//
// Measured 25 Oct 2026 over eval/results/2026-10-25T09-25-44Z: 15 configuration runs, 389 call records, 383 with a
// verified receipt (the other 6 answered by no route), 0 substitutions, 0 cache hits; median output tokens 4,724 for a
// Lightning selection, 2,953 for a Lightning judge call, 615 for an Ultra judge call and 358 for Ultra alone.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { accuracy, falsePositiveRate } from "./measures.ts";
import type { CallKind, CallRecord } from "./models.ts";
import type { ModelTier } from "./protocol.ts";
import type { PlantedOutcome, RunResult } from "./types.ts";

const RUN_FILE = /^(C\d+)-run(\d+)\.json$/;

/** The run files of one results directory, in configuration then run order. */
export function readRuns(dir: string): RunResult[] {
  const names = readdirSync(dir).filter((n) => RUN_FILE.test(n));
  const key = (n: string): [number, number] => {
    const m = n.match(RUN_FILE)!;
    return [Number(m[1].slice(1)), Number(m[2])];
  };
  names.sort((a, b) => {
    const [ca, ra] = key(a);
    const [cb, rb] = key(b);
    return ca - cb || ra - rb;
  });
  return names.map((n) => JSON.parse(readFileSync(path.join(dir, n), "utf8")) as RunResult);
}

/** planted.json's claims; none when the directory holds no planted.json. */
export function readPlanted(dir: string): PlantedOutcome[] {
  try {
    return (JSON.parse(readFileSync(path.join(dir, "planted.json"), "utf8")) as { claims: PlantedOutcome[] }).claims;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

const median = (xs: readonly number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 4724 as "4,724"; a half kept as ".5". */
export const thousands = (n: number): string => {
  const [whole, frac] = String(n).split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? `.${frac}` : "");
};

const TIER_NAME: Record<ModelTier, string> = { lightning: "Lightning", ultra: "Ultra" };
const KIND_WORD: Record<CallKind, string> = { select: "selecting", judge: "judging", direct: "alone" };
const KIND_ORDER: CallKind[] = ["select", "judge", "direct"];
const TIER_ORDER: ModelTier[] = ["lightning", "ultra"];

/** Median tokens_out per call kind and tier over the records a route answered, in a fixed order. */
export function tokenMedians(calls: readonly CallRecord[]): { kind: CallKind; tier: ModelTier; label: string; median: number; n: number }[] {
  const answered = calls.filter((c) => c.served_model !== null);
  return KIND_ORDER.flatMap((kind) => TIER_ORDER.flatMap((tier) => {
    const xs = answered.filter((c) => c.kind === kind && c.requested_tier === tier).map((c) => c.tokens_out);
    const m = median(xs);
    return m === null ? [] : [{ kind, tier, label: `${TIER_NAME[tier]} ${KIND_WORD[kind]}`, median: m, n: xs.length }];
  }));
}

/** One value when every run gives it, else each run's value, comma-separated. */
const perRun = (values: readonly string[]): string => (values.every((v) => v === values[0]) ? values[0] ?? "-" : values.join(", "));

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const row = (cells: readonly string[]): string => `| ${cells.map(cell).join(" | ")} |`;

const DECIDERS = ["policy", "operator", "judge", "default"] as const;

/** Who decided the findings with a disposition, per run: each decider any run names, with its count in every run. */
function decidedBy(runs: readonly RunResult[]): string {
  if (runs[0]?.config.direct) return "the model";
  const perRunCounts = runs.map((r) => {
    const n = new Map<string, number>();
    for (const i of r.items) for (const s of i.subjects) if (s.decided_by !== null && s.verb !== null) n.set(s.decided_by, (n.get(s.decided_by) ?? 0) + 1);
    return n;
  });
  const named = DECIDERS.filter((d) => perRunCounts.some((n) => n.has(d)));
  return named.length ? named.map((d) => `${d} ${perRun(perRunCounts.map((n) => String(n.get(d) ?? 0)))}`).join("; ") : "-";
}

export const HEAD = [
  "config", "what runs", "agree / judged", "findings decided by", "labelled no, read yes", "planted claims struck", "checks valid / selected",
  "items not judged", "calls", "receipts verified", "substitutions", "cache hits", "median output tokens",
] as const;

/** The lead line and the table for one results directory. */
export function evalTable(dir: string): string {
  const runs = readRuns(dir);
  if (!runs.length) throw new Error(`${dir} holds no <config>-run<n>.json`);
  const planted = readPlanted(dir);
  const ids = [...new Set(runs.map((r) => r.config.id))];
  const calls = runs.flatMap((r) => r.calls);
  const verified = (cs: readonly CallRecord[]): number => cs.filter((c) => c.signature_ok === true).length;
  const sum = (f: (r: RunResult) => number): number => runs.reduce((a, r) => a + f(r), 0);
  const runsPer = [...new Set(ids.map((id) => runs.filter((r) => r.config.id === id).length))];
  const medians = tokenMedians(calls).map((m) => `${m.label} ${thousands(m.median)}`);
  const lead =
    `${runs.length} configuration runs (${runsPer.join(" or ")} of each of ${ids.join(", ")}): ${thousands(calls.length)} call records, ` +
    `${thousands(verified(calls))} with a verified receipt, ${sum((r) => r.counts.substitutions)} substitutions, ${sum((r) => r.counts.cache_hits)} cache hits. ` +
    `Median output tokens per answered call: ${medians.length ? medians.join(", ") : "no call answered"}.`;

  const rows = ids.map((id) => {
    const rs = runs.filter((r) => r.config.id === id);
    const spec = rs[0].config;
    const struck = spec.judge === null ? "-" : perRun(rs.map((r) => {
      const p = planted.filter((q) => q.config === id && q.run === r.run);
      return p.length ? `${p.filter((q) => q.struck).length}/${p.length}` : "-";
    }));
    return [
      id,
      spec.text,
      perRun(rs.map((r) => { const a = accuracy(r.counts); return `${a.k}/${a.n}`; })),
      decidedBy(rs),
      perRun(rs.map((r) => { const f = falsePositiveRate(r.counts); return `${f.k}/${f.n}`; })),
      struck,
      spec.select.kind === "model" ? perRun(rs.map((r) => `${r.counts.checks_valid}/${r.counts.checks_selected}`)) : "-",
      perRun(rs.map((r) => String(r.counts.not_judged))),
      perRun(rs.map((r) => String(r.calls.length))),
      perRun(rs.map((r) => String(verified(r.calls)))),
      perRun(rs.map((r) => String(r.counts.substitutions))),
      perRun(rs.map((r) => String(r.counts.cache_hits))),
      tokenMedians(rs.flatMap((r) => r.calls)).map((m) => `${m.label} ${thousands(m.median)}`).join("; ") || "-",
    ];
  });
  return [lead, "", row([...HEAD]), row(HEAD.map(() => "---")), ...rows.map(row), ""].join("\n");
}
