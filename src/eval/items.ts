// The eval's items and labels (eval/items.json, eval/labels.json, both pre-registered and read as they are)
// and the match of a pass item to the findings a pass raises over the recording the item came from.
//
// Contract.
//   An item whose class is a finding class of the pass (src/catalogue/templates.ts FINDING_CLASSES) is a pass
//   item; dns_change_history and dns_bulk_delete are history items (src/eval/history.ts); any other class has
//   no assessment path and is reported with that reason.
//   matchItem: the findings of the item's class whose summary the item's facts contain (the facts were
//   written from the summaries); when none, the findings whose object_id, host and resource_id equal every
//   one of those the item's refs name (null and '' name nothing). An item that names a host and no object
//   (the changed_since_backup items, one per host) matches the class's findings on that host as a group. An
//   item no finding matches is "not raised", with the reason, and left unscored.
//
// Measured 24 Oct 2026 over test/fixtures/recorded-bundle.json (test/eval.test.ts): 17 pass items of a raised
// class, 15 matching one finding each by their facts and the two changed_since_backup items matching 6 and 5
// findings by host; the 7 drift_vs_approved items not raised (the recording holds no approval).

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { FindingSummary } from "../catalogue/select.ts";
import { FINDING_CLASSES } from "../catalogue/templates.ts";

export const HISTORY_CLASSES = ["dns_change_history", "dns_bulk_delete"] as const;
export type HistoryClass = (typeof HISTORY_CLASSES)[number];

const ItemSchema = z.object({
  id: z.string().regex(/^E\d+$/),
  class: z.string().min(1),
  source: z.string(),
  question: z.string(),
  agent_says: z.string(),
  facts: z.string(),
  refs: z.record(z.string(), z.string().nullable()),
});
export type Item = z.infer<typeof ItemSchema>;

const LabelSchema = z.object({
  id: z.string().regex(/^E\d+$/),
  needs_human: z.enum(["yes", "no", "unsure"]),
  reason: z.string(),
  operator_note: z.string().optional(),
});
export type Label = z.infer<typeof LabelSchema>;
export type LabelValue = Label["needs_human"];

const ItemsFile = z.object({ items: z.array(ItemSchema) });
const LabelsFile = z.object({ labels: z.array(LabelSchema) });

export interface EvalSet {
  items: Item[];
  labels: Label[];
  /** The labels file's text as read, for the split's seed. */
  labelsText: string;
}

/** Parse the two files; every label names an item and every id is unique. */
export function parseEvalSet(itemsText: string, labelsText: string): EvalSet {
  const items = ItemsFile.parse(JSON.parse(itemsText)).items;
  const labels = LabelsFile.parse(JSON.parse(labelsText)).labels;
  const ids = new Set(items.map((i) => i.id));
  if (ids.size !== items.length) throw new Error("items.json repeats an item id");
  if (new Set(labels.map((l) => l.id)).size !== labels.length) throw new Error("labels.json repeats an item id");
  for (const l of labels) if (!ids.has(l.id)) throw new Error(`labels.json labels ${l.id}, an id absent from items.json`);
  return { items, labels, labelsText };
}

export function loadEvalSet(itemsPath = "eval/items.json", labelsPath = "eval/labels.json"): EvalSet {
  return parseEvalSet(readFileSync(itemsPath, "utf8"), readFileSync(labelsPath, "utf8"));
}

export type ItemKind = "pass" | "history" | "other";

export function itemKind(item: Pick<Item, "class">): ItemKind {
  if ((FINDING_CLASSES as readonly string[]).includes(item.class)) return "pass";
  if ((HISTORY_CLASSES as readonly string[]).includes(item.class)) return "history";
  return "other";
}

/** A finding as the matcher sees it: the pass's short id and its summary. */
export interface RaisedFinding { id: string; finding: FindingSummary }

export type Match =
  | { kind: "findings"; via: "facts" | "refs"; findings: RaisedFinding[] }
  | { kind: "not_raised"; reason: string };

const REF_KEYS = ["object_id", "host", "resource_id"] as const;

/** The findings a pass item stands for, by its facts first and its refs second. */
export function matchItem(item: Item, raised: readonly RaisedFinding[]): Match {
  const same = raised.filter((f) => f.finding.class === item.class);
  if (!same.length) return { kind: "not_raised", reason: `the recording raises no ${item.class} finding` };
  const byFacts = same.filter((f) => item.facts.includes(f.finding.summary));
  if (byFacts.length) return { kind: "findings", via: "facts", findings: byFacts };
  const named = REF_KEYS.filter((k) => typeof item.refs[k] === "string" && item.refs[k] !== "");
  if (!named.length) return { kind: "not_raised", reason: `no ${item.class} finding's summary is in the facts, and the refs name no object, host or resource` };
  const byRefs = same.filter((f) => named.every((k) => (f.finding[k] ?? "") === item.refs[k]));
  if (!byRefs.length) return { kind: "not_raised", reason: `no ${item.class} finding's summary is in the facts or carries the refs' ${named.join(", ")}` };
  return { kind: "findings", via: "refs", findings: byRefs };
}
