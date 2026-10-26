// This repository's runner over the Meterless Scout Intent v1 smoke set (vendor/scout-intent): the 32 examples the
// spec's eval harness ships, run through the Scout guard (src/guard/scout.ts) and counted.
//
// Contract:
//   - The set is read from vendor/scout-intent/evals/regression-set/v1/**/*.jsonl, files in name order. An example is an
//     injection when its expected.injection is true (7 of the 32); every other example is benign (25: the 3 clean
//     controls of the injection file, 15 intent-labeled prompts, 3 multi-intent and 4 edge cases).
//   - An example is blocked when decide() answers level block, the spec runner's own rule (detected means risk.level is
//     block). Review counts as not blocked and is reported on its own.
//   - Both passes are run over every example: its text as the raw input (decide({ prompt })), and its text as a
//     retrieved snippet (decide({ snippets })), the pass that classes a hit context_poisoning or indirect_injection.
//   - The result is two counts for each pass, each as "N of M": injection examples blocked, and benign examples blocked
//     (false blocks). They describe these 32 examples. The spec's thresholds are release targets for a corpus of larger
//     scale; this runner computes no precision or recall against them and prints none.
//   - Nothing here runs Meterless code: the files are data, and the guard is ConfigLeaf's.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide, type Level } from "./scout.ts";

export const SMOKE_DIR = path.join(fileURLToPath(new URL("../..", import.meta.url)), "vendor", "scout-intent");

export interface SmokeExample {
  id: string;
  /** The jsonl file the example came from, relative to the set's v1 directory. */
  file: string;
  prompt: string;
  injection: boolean;
}

/** The counts of one pass over the examples. */
export interface PassCounts {
  injections: { total: number; blocked: number; missed: string[] };
  benign: { total: number; blocked: number; falseBlocks: string[]; review: number };
}

export interface SmokeResult {
  commit: string;
  examples: number;
  /** Each example's text as the raw input of decide(). */
  input: PassCounts;
  /** Each example's text as one retrieved snippet of decide(): the second pass, which classes a hit context_poisoning or indirect_injection. */
  snippet: PassCounts;
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

/** The upstream commit the copied files come from, as the manifest states it. */
export function smokeCommit(root: string = SMOKE_DIR): string {
  return (JSON.parse(readFileSync(path.join(root, "UPSTREAM.json"), "utf8")) as { commit: string }).commit;
}

/** The examples counted through one pass: `level` is the guard's answer for an example's text. */
function count(examples: readonly SmokeExample[], level: (ex: SmokeExample) => Level): PassCounts {
  const inj = { total: 0, blocked: 0, missed: [] as string[] };
  const ben = { total: 0, blocked: 0, falseBlocks: [] as string[], review: 0 };
  for (const ex of examples) {
    const l = level(ex);
    if (ex.injection) {
      inj.total++;
      if (l === "block") inj.blocked++;
      else inj.missed.push(ex.id);
    } else {
      ben.total++;
      if (l === "block") { ben.blocked++; ben.falseBlocks.push(ex.id); }
      else if (l === "review") ben.review++;
    }
  }
  return { injections: inj, benign: ben };
}

export function runSmoke(examples: readonly SmokeExample[], root: string = SMOKE_DIR): SmokeResult {
  return {
    commit: smokeCommit(root),
    examples: examples.length,
    input: count(examples, (ex) => decide({ prompt: ex.prompt }).level),
    snippet: count(examples, (ex) => decide({ snippets: [{ source: `example ${ex.id}`, text: ex.prompt }] }).level),
  };
}

/** The result as printed: the raw-input pass, then the snippet pass. */
export function smokeLines(r: SmokeResult): string[] {
  const pass = (name: string, c: PassCounts): string[] => [
    `${name}, injection examples blocked: ${c.injections.blocked} of ${c.injections.total} on the Meterless smoke set${c.injections.missed.length ? ` (missed: ${c.injections.missed.join(", ")})` : ""}`,
    `${name}, benign examples blocked, the false blocks: ${c.benign.blocked} of ${c.benign.total} on the Meterless smoke set${c.benign.falseBlocks.length ? ` (${c.benign.falseBlocks.join(", ")})` : ""}; flagged for review: ${c.benign.review}`,
  ];
  return [
    `Scout guard on the Meterless smoke set: corpus v1, ${r.examples} examples, upstream commit ${r.commit.slice(0, 7)}`,
    ...pass("raw-input pass", r.input),
    ...pass("snippet pass", r.snippet),
  ];
}
