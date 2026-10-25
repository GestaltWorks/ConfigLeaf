// summary.md of one eval run: the protocol's counts per configuration and run, its measures (accuracy with
// Wilson 95% intervals, determinism, coverage, false-positive rate, stability over uncached answers, the
// planted-claim strikes), the requested-versus-served table, the items not judged, the items not raised, the
// findings no item names and the unsure items' verdicts. Plain markdown, every number read from EvalResult.

import { accuracy, coverage, falsePositiveRate, stability } from "./measures.ts";
import { isSubstitution } from "./models.ts";
import type { EvalResult } from "./run.ts";
import type { Counts, RunResult } from "./types.ts";

const pct = (x: number | null | undefined): string => (x === null || x === undefined ? "-" : x.toFixed(3));
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const row = (cells: readonly (string | number)[]): string => `| ${cells.map((c) => cell(String(c))).join(" | ")} |`;
const table = (head: readonly string[], rows: readonly (readonly (string | number)[])[]): string[] =>
  rows.length ? [row(head), row(head.map(() => "---")), ...rows.map(row)] : ["(none)"];

const COUNT_COLUMNS: [keyof Counts, string][] = [
  ["items", "items"], ["scored", "scored"], ["with_verdict", "verdict"], ["not_judged", "not judged"], ["agree", "agree"], ["disagree", "disagree"],
  ["unsure", "unsure"], ["false_positives", "no read yes"], ["checks_selected", "checks selected"], ["checks_valid", "valid"],
  ["checks_ran_unmodified", "ran unmodified"], ["checks_run", "checks run"], ["falsifier_ran", "falsifier ran"], ["falsifier_struck", "struck"],
  ["agreed_strikes", "agreed strikes"], ["wrong_strikes", "wrong strikes"], ["early_stops", "early stops"], ["judge_withheld", "judge withheld"],
  ["calls", "calls"], ["cache_hits", "cache hits"], ["substitutions", "substitutions"], ["tokens_in", "tokens in"], ["tokens_out", "tokens out"],
  ["latency_ms_median", "median ms"],
];

export function renderSummary(r: EvalResult, meta: { recording: string; out: string }): string {
  const byConfig = (id: string): RunResult[] => r.runs.filter((x) => x.config.id === id);
  const dev = r.itemIds.filter((id) => r.split.dev.includes(id)).length;
  const lines: string[] = [
    `# Eval results ${meta.out}`,
    "",
    `Recording ${meta.recording}, tenant ${r.tenant}, every disposition decided at ${r.decided_at}. Contract eval/PROTOCOL.md; configurations as its table states them.`,
    `Split seed ${r.split.seed} (sha256 of eval/labels.json). Set ${r.set}: ${r.itemIds.length} item(s), ${dev} development and ${r.itemIds.length - dev} held out.`,
    `Runs per configuration: ${Math.max(0, ...r.configs.map((c) => byConfig(c.id).length))}. Started ${r.started_at}, finished ${r.finished_at}.`,
    `Verb reading: ${r.protocol.reads.yes.join(", ")} read yes; ${r.protocol.reads.no.join(", ")} read no.`,
    "",
    "## Configurations",
    "",
    ...table(["id", "what runs", "runs", "valid runs"], r.configs.map((c) => [c.id, c.text, byConfig(c.id).length, byConfig(c.id).filter((x) => x.valid).length])),
    ...r.runs.filter((x) => !x.valid).map((x) => `- ${x.config.id} run ${x.run} is invalid: ${x.invalid_reason}`),
    "",
    "## Counts per configuration and run",
    "",
    ...table(["config", "run", ...COUNT_COLUMNS.map(([, h]) => h)], r.runs.map((x) => [x.config.id, x.run, ...COUNT_COLUMNS.map(([k]) => String(x.counts[k] ?? "-"))])),
    "",
    "## Measures",
    "",
    "### Accuracy against the labels (Wilson 95%)",
    "",
    "Agreements over items with a verdict whose label is yes or no. At this sample size the intervals mostly overlap; the table reports them side by side.",
    "",
    ...table(["config", "run", "agree / judged", "accuracy", "95% interval"], r.runs.map((x) => {
      const a = accuracy(x.counts);
      return [x.config.id, x.run, `${a.k} / ${a.n}`, pct(a.interval?.p), a.interval ? `${pct(a.interval.lo)} to ${pct(a.interval.hi)}` : "-"];
    })),
    "",
    "### Determinism",
    "",
    ...table(["config", "compared", "differences"], r.configs.map((c) => {
      const d = r.determinism[c.id];
      return [c.id, d ? d.compared : "one run", d ? String(d.differences.length) : "-"];
    })),
    ...r.configs.flatMap((c) => (r.determinism[c.id]?.differences ?? []).slice(0, 20).map((d) => `- ${c.id}: ${d}`)),
    "",
    "### Coverage",
    "",
    ...table(["config", "run", "items with a verdict / scored", "findings with a disposition / assessed"], r.runs.map((x) => {
      const cv = coverage(x.counts);
      return [x.config.id, x.run, `${cv.items.with_verdict} / ${cv.items.scored}`, `${cv.findings.with_disposition} / ${cv.findings.assessed}`];
    })),
    "",
    `The pass over the recording raises ${r.baseline.findings.length} finding(s), each with a disposition.`,
    "",
    "### False-positive rate",
    "",
    ...table(["config", "run", "labelled no, read yes / labelled no", "rate"], r.runs.map((x) => {
      const f = falsePositiveRate(x.counts);
      return [x.config.id, x.run, `${f.k} / ${f.n}`, pct(f.rate)];
    })),
    "",
    "### Stability over uncached answers",
    "",
    "Per count, its value in each run over the items whose every call the receipt marks uncached, and the spread (max minus min).",
    "",
    ...table(["config", "uncached items per run", "count: values (spread)"], r.configs.map((c) => {
      const s = stability(byConfig(c.id), isSubstitution);
      return [c.id, s.uncached.join(", "), Object.entries(s.counts).map(([k, v]) => `${k} ${v.values.join("/")} (${v.spread})`).join("; ")];
    })),
    "",
    "### Planted false claims",
    "",
    ...table(["config", "run", "judge tier", "struck / claims", "not judged or invalid"], r.configs.flatMap((c) => byConfig(c.id).flatMap((x) => {
      const p = r.planted.filter((q) => q.config === c.id && q.run === x.run);
      return p.length ? [[c.id, x.run, p[0].judge_tier, `${p.filter((q) => q.struck).length} / ${p.length}`, String(p.filter((q) => q.status === "not_judged" || q.status === "invalid_output").length)]] : [];
    }))),
    ...table(["config", "run", "claim", "kind", "status", "rows", "reason"], r.planted.map((q) => [q.config, q.run, q.id, q.kind, q.status, q.rows ?? "-", q.reason])),
    "",
    "## Requested versus served",
    "",
    "From the verified receipt of every call; a served tier other than the requested one invalidates the run.",
    "",
  ];
  const served = new Map<string, { config: string; kind: string; req: string; model: string; served: string; tier: string; n: number; hits: number; subs: number; unverified: number }>();
  for (const x of r.runs) for (const c of x.calls) {
    const k = [x.config.id, c.kind, c.requested_tier, c.model_requested, c.served_model ?? "-", c.served_tier].join("\u001f");
    const e = served.get(k) ?? { config: x.config.id, kind: c.kind, req: c.requested_tier, model: c.model_requested, served: c.served_model ?? "-", tier: c.served_tier, n: 0, hits: 0, subs: 0, unverified: 0 };
    e.n += 1;
    if (c.cache_status === "hit") e.hits += 1;
    if (isSubstitution(c)) e.subs += 1;
    if (c.signature_ok !== true) e.unverified += 1;
    served.set(k, e);
  }
  lines.push(...table(["config", "call", "tier requested", "model requested", "model served", "tier served", "calls", "cache hits", "substitutions", "receipt unverified"],
    [...served.values()].map((e) => [e.config, e.kind, e.req, e.model, e.served, e.tier, e.n, e.hits, e.subs, e.unverified])));
  lines.push("", "## Items not judged", "");
  lines.push(...table(["config", "run", "item", "reason"], r.runs.flatMap((x) => x.items.filter((i) => i.not_raised === null && i.verdict === null).map((i) => [x.config.id, x.run, i.id, i.not_judged ?? "-"]))));
  lines.push("", "## Items not raised", "", "Left unscored, in every configuration.", "");
  const first = r.runs[0];
  lines.push(...table(["item", "class", "set", "reason"], (first?.items ?? []).filter((i) => i.not_raised !== null).map((i) => [i.id, i.class, i.set, i.not_raised!])));
  lines.push("", "## Findings with no item", "", "Raised by the pass over the recording, named by no item of eval/items.json; listed with the pass's verb, unscored.", "");
  lines.push(...table(["finding", "class", "verb"], r.baseline.unmatched.map((f) => [f.id, f.class, f.verb])));
  lines.push("", "## Unsure items", "", "Reported apart from the agreement counts.", "");
  lines.push(...table(["config", "run", "item", "verdict", "reading"], r.runs.flatMap((x) => x.items.filter((i) => i.label === "unsure" && i.not_raised === null).map((i) => [x.config.id, x.run, i.id, i.verdict ?? "not judged", i.reading ?? "-"]))));
  lines.push("");
  return lines.join("\n");
}
