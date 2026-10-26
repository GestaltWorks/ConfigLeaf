// This repository's runner over the Meterless Scout Intent v1 smoke set (vendor/scout-intent): the 32 examples the
// spec's eval harness ships, run through the Scout guard (src/guard/scout.ts) and counted.
//
// Contract:
//   - The set is read from vendor/scout-intent/evals/regression-set/v1/**/*.jsonl, files in name order. An example is an
//     injection when its expected.injection is true (7 of the 32); every other example is benign (25: the 3 clean
//     controls of the injection file, 15 intent-labeled prompts, 3 multi-intent and 4 edge cases).
//   - An example is blocked when decide({ prompt }) answers level block, the spec runner's own rule (detected means
//     risk.level is block). Review counts as not blocked and is reported on its own.
//   - The result is two counts, each as "N of M": injection examples blocked, and benign examples blocked (false
//     blocks). They describe these 32 examples. The spec's thresholds are release targets for a corpus of larger scale;
//     this runner computes no precision or recall against them and prints none.
//   - Nothing here runs Meterless code: the files are data, and the guard is ConfigLeaf's.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "./scout.ts";

export const SMOKE_DIR = path.join(fileURLToPath(new URL("../..", import.meta.url)), "vendor", "scout-intent");

export interface SmokeExample {
  id: string;
  /** The jsonl file the example came from, relative to the set's v1 directory. */
  file: string;
  prompt: string;
  injection: boolean;
}

export interface SmokeResult {
  commit: string;
  examples: number;
  injections: { total: number; blocked: number; missed: string[] };
  benign: { total: number; blocked: number; falseBlocks: string[]; review: number };
}

function* jsonlFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (name.endsWith(".jsonl")) yield p;
    else if (!name.includes(".")) yield* jsonlFiles(p);
  }
}

export function loadSmokeSet(root: string = SMOKE_DIR): SmokeExample[] {
  const v1 = path.join(root, "evals", "regression-set", "v1");
  const out: SmokeExample[] = [];
  for (const file of jsonlFiles(v1)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const ex = JSON.parse(line) as { id: string; prompt: string; expected?: { injection?: boolean } };
      out.push({ id: ex.id, file: path.relative(v1, file).split(path.sep).join("/"), prompt: ex.prompt, injection: ex.expected?.injection === true });
    }
  }
  return out;
}

export function runSmoke(examples: readonly SmokeExample[], root: string = SMOKE_DIR): SmokeResult {
  const commit = (JSON.parse(readFileSync(path.join(root, "UPSTREAM.json"), "utf8")) as { commit: string }).commit;
  const inj = { total: 0, blocked: 0, missed: [] as string[] };
  const ben = { total: 0, blocked: 0, falseBlocks: [] as string[], review: 0 };
  for (const ex of examples) {
    const level = decide({ prompt: ex.prompt }).level;
    if (ex.injection) {
      inj.total++;
      if (level === "block") inj.blocked++;
      else inj.missed.push(ex.id);
    } else {
      ben.total++;
      if (level === "block") { ben.blocked++; ben.falseBlocks.push(ex.id); }
      else if (level === "review") ben.review++;
    }
  }
  return { commit, examples: examples.length, injections: inj, benign: ben };
}

/** The result as printed. */
export function smokeLines(r: SmokeResult): string[] {
  return [
    `Scout guard on the Meterless smoke set: corpus v1, ${r.examples} examples, upstream commit ${r.commit.slice(0, 7)}`,
    `injection examples blocked: ${r.injections.blocked} of ${r.injections.total} on the Meterless smoke set${r.injections.missed.length ? ` (missed: ${r.injections.missed.join(", ")})` : ""}`,
    `benign examples blocked, the false blocks: ${r.benign.blocked} of ${r.benign.total} on the Meterless smoke set${r.benign.falseBlocks.length ? ` (${r.benign.falseBlocks.join(", ")})` : ""}; flagged for review: ${r.benign.review}`,
  ];
}
