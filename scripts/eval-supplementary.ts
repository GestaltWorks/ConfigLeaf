// npm run eval -- --set supplementary [--configs C0,C1] [--runs <n>] [--items <path>] [--labels <path>] [--bundle <path>] [--out <dir>]
//
// The supplementary set (eval/supplementary/README.md: post hoc, not pre-registered): scripts/eval.ts hands
// --set supplementary here before its own parsing, so the development and held-out runs take the path they took before.
// Items and labels from eval/supplementary/, the recording eval/supplementary/bundle.json, sliced at each cycle's instant
// (src/eval/supplementary.ts); the configurations and the run count from eval/PROTOCOL.md; no planted claims.
//
// Output, under eval/supplementary/results/<UTC timestamp>/ or --out: one directory per cycle, "<tenant>-<HH-MM-SS>",
// holding <config>-run<n>.json per configuration and run (the shape scripts/eval.ts writes, plus the slice) and
// summary.md; no planted.json, so scripts/build-site.ts, which reads the newest eval/results directory holding one, keeps
// the development run. At the top, summary.md: per configuration and run, the yes items read yes, the no items read yes,
// and the items not judged, over every cycle. Every file passes the deny-list probe before it is written; one match and
// that file is withheld and the command exits 1. Each cycle directory takes npm run receipts:export -- --results <dir>.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../src/config.ts";
import { renderSummary } from "../src/eval/report.ts";
import { runIdOf } from "../src/eval/run.ts";
import { loadSupplementary, runSupplementary, supplementaryArgs, type GroupResult } from "../src/eval/supplementary.ts";
import { LogTracer } from "../src/eval/tracer.ts";
import type { RunResult } from "../src/eval/types.ts";
import { countLabels } from "../src/redactor.ts";

/** The combined table: per configuration and run, over every cycle. */
function combined(results: readonly GroupResult[], out: string, started: string): string {
  const keys = [...new Set(results.flatMap((g) => g.result.runs.map((r) => `${r.config.id}\u001f${r.run}`)))];
  const rows = keys.map((k) => {
    const [id, run] = k.split("\u001f");
    const runs: RunResult[] = results.flatMap((g) => g.result.runs.filter((r) => r.config.id === id && String(r.run) === run));
    const items = runs.flatMap((r) => r.items);
    const yes = items.filter((i) => i.label === "yes"), no = items.filter((i) => i.label === "no");
    const calls = runs.flatMap((r) => r.calls);
    return [
      id, run, `${yes.filter((i) => i.reading === "yes").length} of ${yes.length}`, `${no.filter((i) => i.reading === "yes").length} of ${no.length}`,
      `${items.filter((i) => i.agree === true).length} of ${items.filter((i) => i.agree !== null).length}`, String(items.filter((i) => i.verdict === null).length),
      String(calls.length), String(calls.filter((c) => (c.memory_injected ?? 0) > 0).length), runs.every((r) => r.valid) ? "yes" : "no",
    ];
  });
  const calls = results.flatMap((g) => g.result.runs.flatMap((r) => r.calls));
  const injected = calls.filter((c) => (c.memory_injected ?? 0) > 0).length;
  const head = ["config", "run", "yes items read yes", "no items read yes", "agree / with a verdict", "not judged", "calls", "memory injected", "valid"];
  return [
    `# Supplementary eval results ${path.basename(out)}`,
    "",
    "Post hoc, not pre-registered (eval/supplementary/README.md). Labels are the live pass's verbs read by eval/PROTOCOL.md's verb reading: ESCALATE and FIX yes; ADOPT, HOLD and ROLLBACK no.",
    `Started ${started}. ${results.length} cycle(s), each a slice of the recording at the live pass's instant: ${results.map((g) => `${g.dir} (${g.group.items.map((i) => i.id).join(", ")}, decided at ${g.result.decided_at})`).join("; ")}.`,
    `memory injected: ${injected} of ${calls.length} calls, read from each call's signed receipt (hmem).`,
    "",
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
    "Each cycle directory holds the run files and the full summary.md of that cycle.",
    "",
  ].join("\n");
}

export async function main(argv: readonly string[]): Promise<number> {
  const a = supplementaryArgs(argv);
  if (!a) throw new Error("scripts/eval-supplementary.ts runs --set supplementary only");
  const started = new Date().toISOString();
  const stamp = runIdOf(started);
  const out = a.out ?? path.join("eval", "supplementary", "results", stamp);
  const tracer = new LogTracer(`eval_supplementary_${stamp}`);
  const set = loadSupplementary(a.items, a.labels);
  const results = await runSupplementary({
    protocolText: readFileSync("eval/PROTOCOL.md", "utf8"),
    set,
    bundle: JSON.parse(readFileSync(a.bundle, "utf8")),
    configs: a.configs,
    runs: a.runs,
    tracer,
    scopePrefix: `supplementary-${stamp}`,
    onGroup: (g) => console.log(`EVAL supplementary: cycle ${g.tenant} at ${g.at}: ${g.items.map((i) => i.id).join(", ")}`),
    onRun: (r) => {
      const c = r.counts;
      console.log(`EVAL ${r.config.id} run ${r.run}${r.valid ? "" : ` INVALID (${r.invalid_reason})`}: ${c.scored} scored of ${c.items}, ${c.with_verdict} with a verdict, ${c.not_judged} not judged, agree ${c.agree}, disagree ${c.disagree}; ${r.items.map((i) => `${i.id} ${i.verdict ?? "-"}`).join(", ")}; ${c.calls} call(s), memory injected ${c.memory_injected}, substitutions ${c.substitutions}`);
    },
  });

  const words = [...new Set([...config.redactWords, ...config.exportDenyWords])];
  const files: [string, string][] = [];
  for (const g of results) {
    const r = g.result;
    const recording = `${a.bundle} sliced for ${g.group.tenant} at ${g.group.at}`;
    for (const x of r.runs) {
      files.push([path.join(g.dir, `${x.config.id}-run${x.run}.json`), JSON.stringify({
        config: x.config, run: x.run, valid: x.valid, invalid_reason: x.invalid_reason, started_at: x.started_at, finished_at: x.finished_at,
        recording: a.bundle, slice: { tenant: g.group.tenant, at: g.group.at, rows: g.slice }, tenant: r.tenant, decided_at: r.decided_at, policy: r.policy,
        split_seed: null, set: "supplementary", counts: x.counts, items: x.items, calls: x.calls, pass: x.pass,
      }, null, 1) + "\n"]);
    }
    const summary = renderSummary(r, { recording, out: `${path.basename(out)}/${g.dir}` }).split("\n").map((line) =>
      line.startsWith("Split seed ") ? `Supplementary set, post hoc and not pre-registered (eval/supplementary/README.md): ${r.itemIds.length} item(s) of this cycle (${r.itemIds.join(", ")}), no split; the recording sliced at the live pass's instant ${g.group.at} (src/eval/supplementary.ts sliceAt).` : line,
    ).join("\n");
    files.push([path.join(g.dir, "summary.md"), summary]);
  }
  files.push(["summary.md", combined(results, out, started)]);

  let withheld = 0;
  for (const [name, text] of files) {
    const hits = Object.entries(countLabels(text, words));
    if (hits.length) {
      withheld += 1;
      console.error(`EVAL ${name} withheld: the deny-list probe matched ${hits.map(([w, n]) => `label #${words.indexOf(w) + 1} x${n}`).join(", ")}`);
      continue;
    }
    mkdirSync(path.dirname(path.join(out, name)), { recursive: true });
    writeFileSync(path.join(out, name), text);
  }
  const runs = results.reduce((n, g) => n + g.result.runs.length, 0);
  console.log(`EVAL supplementary: ${results.length} cycle(s), ${runs} configuration run(s) over ${set.items.length} item(s); ${files.length - withheld} file(s) written to ${out}${withheld ? `, ${withheld} withheld` : ""}; deny-list probe ${withheld ? `matched in ${withheld} file(s)` : `0 matches over ${files.length} file(s)`}; trace logs/${tracer.traceId}.jsonl`);
  return withheld ? 1 : 0;
}
