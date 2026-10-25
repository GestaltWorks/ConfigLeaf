// Planted false claims (eval/PROTOCOL.md "Planted false claims"): eval/planted.json lists claims constructed
// to be false against the rows of the recording, each with the SELECT that shows it false and the SELECT whose
// rows the judge is handed as the claim's supporting rows. Each goes to the judge of every configuration that
// has one; a strike is a refuting SELECT that ran and returned rows.
//
// Contract. Both SELECTs are literal SQL in the portable subset ({{t:}} tables, no {{p:}} parameters) and run
// through the DataLayer's guard; false_sql returns at least one row over the recording (test/eval.test.ts
// asserts it on sql.js), so each claim is false on the stored rows and a judge that strikes it is right.
//
// Measured 24 Oct 2026 on test/fixtures/recorded-bundle.json: all ten false_sql return rows.

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { DataLayer } from "../data/layer.ts";
import type { Evidence } from "../agents/judge.ts";

const Claim = z.object({
  id: z.string().regex(/^P\d{2}$/),
  kind: z.string().min(1),
  claim: z.string().min(10),
  evidence_sql: z.string().min(10),
  false_sql: z.string().min(10),
});
export type PlantedClaim = z.infer<typeof Claim>;

const PlantedFile = z.object({ recording: z.string(), claims: z.array(Claim).min(1) });

export function parsePlanted(text: string): { recording: string; claims: PlantedClaim[] } {
  const f = PlantedFile.parse(JSON.parse(text));
  if (new Set(f.claims.map((c) => c.id)).size !== f.claims.length) throw new Error("planted.json repeats a claim id");
  for (const c of f.claims) for (const sql of [c.evidence_sql, c.false_sql]) if (/\{\{p:/.test(sql)) throw new Error(`${c.id}: planted SQL carries literal values only, no {{p:}} parameters`);
  return { recording: f.recording, claims: f.claims };
}

export function loadPlanted(file = "eval/planted.json"): { recording: string; claims: PlantedClaim[] } {
  return parsePlanted(readFileSync(file, "utf8"));
}

/** The rows a planted claim's judge is handed. */
export async function plantedEvidence(layer: DataLayer, c: PlantedClaim): Promise<Evidence> {
  const r = await layer.run(c.evidence_sql, {}, { agent: "eval", limit: 200 });
  return { columns: r.columns, rows: r.rows };
}

/** The rows that show the claim false: at least one for every claim of the file. */
export async function falseRows(layer: DataLayer, c: PlantedClaim): Promise<number> {
  return (await layer.run(c.false_sql, {}, { agent: "eval", limit: 1000 })).total;
}
