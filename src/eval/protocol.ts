// eval/PROTOCOL.md read as the runner's contract. The runner carries no configuration table of its own: the
// rows of the protocol's "Configurations" table (| id | what runs |) are parsed here, each row's text read
// by the phrase rules below into what the configuration runs; "Three runs of each configuration" gives the
// default run count; the sentence of "What is counted" item 4 gives which verbs read as yes and which as no.
//
// Contract. A row "<id> plus ..." starts from that configuration and adds what the rest of the row names.
// The phrase rules, matched case-sensitively on the row text:
//   "default precondition checks"          the class's default checks run (no model)
//   "<Lightning|Ultra> selecting"           that tier chooses and parameterises the checks
//   "<Lightning|Ultra> as the falsifier judge"  that tier judges the claim with one refuting SELECT
//   "<Lightning|Ultra> alone"               that tier gives the verdict from the item's facts and rows, no checks
// A row no rule reads, an unknown base, or a row that names no way to reach a verdict is refused with the
// row's text, so a protocol edit outside these rules stops the run before any model call.
//
// Measured 24 Oct 2026 on the committed protocol: C0 default checks; C1 Lightning selecting; C2 C1 with a
// Lightning judge; C3 C1 with an Ultra judge; C4 Ultra alone; 3 runs; yes ESCALATE FIX, no ADOPT HOLD ROLLBACK.

import type { Tier } from "../gate.ts";
import type { Verb } from "../pipeline.ts";

export type ModelTier = Exclude<Tier, "unknown">;

export interface ConfigSpec {
  id: string;
  /** The row's own text, as the protocol states it. */
  text: string;
  /** How the checks are chosen: the class's defaults, a model tier, or none (the direct verdict). */
  select: { kind: "default" } | { kind: "model"; tier: ModelTier } | { kind: "none" };
  /** The tier that judges the claim after the checks; null when no judge runs. */
  judge: ModelTier | null;
  /** The tier that gives the verdict from the facts and rows alone; null for a checked configuration. */
  direct: ModelTier | null;
}

export interface Protocol {
  configs: ConfigSpec[];
  /** "Three runs of each configuration": the default run count. */
  runs: number;
  /** The verbs that read as yes and as no (item 4 of "What is counted"). */
  reads: { yes: Verb[]; no: Verb[] };
}

export class ProtocolError extends Error {}

const TIERS: Record<string, ModelTier> = { Lightning: "lightning", Ultra: "ultra" };
const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const VERB_WORDS = new Set<Verb>(["ADOPT", "HOLD", "ESCALATE", "ROLLBACK", "FIX"]);

/** The markdown rows of the section's first table whose first cell is a configuration id (C0, C1, ...). */
export function configurationRows(protocol: string): { id: string; text: string }[] {
  const start = protocol.search(/^## Configurations\s*$/m);
  if (start < 0) throw new ProtocolError("the protocol has no \"## Configurations\" section");
  const rest = protocol.slice(start).split("\n").slice(1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const section = end < 0 ? rest : rest.slice(0, end);
  const rows = section
    .map((l) => l.match(/^\|\s*(C\d+)\s*\|\s*(.+?)\s*\|\s*$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ id: m[1], text: m[2] }));
  if (!rows.length) throw new ProtocolError("the Configurations section holds no row whose id is C<n>");
  return rows;
}

/** One row read by the phrase rules, over the configurations read before it. */
export function readConfiguration(row: { id: string; text: string }, earlier: ReadonlyMap<string, ConfigSpec>): ConfigSpec {
  const { id, text } = row;
  const base = text.match(/^(C\d+) plus /)?.[1];
  let spec: ConfigSpec = { id, text, select: { kind: "none" }, judge: null, direct: null };
  if (base !== undefined) {
    const from = earlier.get(base);
    if (!from) throw new ProtocolError(`configuration ${id}: "${text}" builds on ${base}, which no earlier row defines`);
    spec = { ...from, id, text };
  }
  let read = false;
  if (text.includes("default precondition checks")) { spec.select = { kind: "default" }; read = true; }
  const selecting = text.match(/\b(Lightning|Ultra) selecting\b/);
  if (selecting) { spec.select = { kind: "model", tier: TIERS[selecting[1]] }; read = true; }
  const judge = text.match(/\b(Lightning|Ultra) as the falsifier judge\b/);
  if (judge) { spec.judge = TIERS[judge[1]]; read = true; }
  const alone = text.match(/\b(Lightning|Ultra) alone\b/);
  if (alone) { spec = { ...spec, select: { kind: "none" }, judge: null, direct: TIERS[alone[1]] }; read = true; }
  if (!read) throw new ProtocolError(`configuration ${id}: no rule of src/eval/protocol.ts reads "${text}"`);
  if (spec.select.kind === "none" && spec.direct === null) throw new ProtocolError(`configuration ${id}: "${text}" names no checks and no direct verdict`);
  return spec;
}

/** The protocol's configurations, its run count and its verb readings. */
export function readProtocol(protocol: string): Protocol {
  const configs: ConfigSpec[] = [];
  const byId = new Map<string, ConfigSpec>();
  for (const row of configurationRows(protocol)) {
    if (byId.has(row.id)) throw new ProtocolError(`configuration ${row.id} appears twice`);
    const spec = readConfiguration(row, byId);
    configs.push(spec);
    byId.set(spec.id, spec);
  }
  const flat = protocol.replace(/\s+/g, " ");
  const runsWord = flat.match(/\b([A-Z][a-z]+|\d+) runs of each configuration\b/)?.[1];
  const runs = runsWord === undefined ? NaN : /^\d+$/.test(runsWord) ? Number(runsWord) : NUMBERS[runsWord.toLowerCase()] ?? NaN;
  if (!Number.isInteger(runs) || runs < 1) throw new ProtocolError("the protocol states no \"<n> runs of each configuration\"");
  const m = flat.match(/`yes` expects ([A-Z ,]+?(?: or [A-Z]+)?), `no` expects ([A-Z ,]+?(?: or [A-Z]+)?)[;.]/);
  if (!m) throw new ProtocolError("the protocol states no \"`yes` expects ..., `no` expects ...\" reading of the verbs");
  const verbs = (s: string): Verb[] => {
    const out = s.split(/,\s*|\s+or\s+/).map((w) => w.trim()).filter(Boolean);
    for (const w of out) if (!VERB_WORDS.has(w as Verb)) throw new ProtocolError(`the verb reading names ${w}, which is no verb of the Decider`);
    return out as Verb[];
  };
  const reads = { yes: verbs(m[1]), no: verbs(m[2]) };
  const both = reads.yes.filter((v) => reads.no.includes(v));
  if (both.length) throw new ProtocolError(`the verb reading puts ${both.join(", ")} under both yes and no`);
  return { configs, runs, reads };
}
