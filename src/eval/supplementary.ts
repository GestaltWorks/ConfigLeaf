// The supplementary set of eval/supplementary/ (README.md there declares it): real drift the agent met on 25 Oct 2026,
// chosen and labelled on 26 Oct 2026 after the pre-registered sets were fixed, so it is post hoc and not pre-registered.
// It measures agreement on real drift, where the development and held-out sets (36 labelled no, 2 unsure, 0 yes)
// measure false positives only. Nothing here changes how the pre-registered sets run: src/eval/run.ts runs as it is,
// once per cycle, over a slice of the supplementary recording.
//
// Contract.
//   parseSupplementary: the set's items.json and labels.json, in the shapes of eval/items.json and eval/labels.json,
//     ids S<n>, each item with one more field, `cycle`: the tenant, the instant the live pass decided at (ISO 8601 UTC,
//     millisecond form) and the committed trace that recorded it (null when none was committed). Every label names an
//     item; ids are unique.
//   sliceAt: the recording as it stood when that pass decided, one tenant's rows (and every "*" policy rule): the
//     collection runs started and finished at or before the instant, with the observations, DNS records and probes of
//     those runs; approvals, backup snapshots (with their items), audit events, policy rules, vault copies and their
//     validations dated at or before it; the ledger (dispositions, actions, tickets, causes, referent fingerprints)
//     dated strictly before it, so the pass's own decisions, the answer, are absent from the slice; the tenant's
//     inventory_asset rows whole (the Store moves observed_at forward on each sighting, so the date does not say when an
//     address was first seen). The slice decides at its own decisionInstant (src/data/instant.ts): the latest finish of
//     its runs or the latest of its dispositions, at most seconds before the live pass's instant.
//   groups: the items by (tenant, instant), in the order each group first appears in items.json.
//   groupDir: a group's directory name under the results directory: "<tenant>-<HH-MM-SS>" of the instant.
//   runSupplementary: one runEval per group over the group's slice, under the group's tenant, set "all" restricted to
//     the group's items, no planted claims, each model call under its own meterless-scope "<prefix>-g<n>-<seq>"
//     (prefix "supplementary-<run id>"); returns each group's EvalResult with every item's set read "supplementary".

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Bundle } from "../data/engines/sqljs.ts";
import type { EvalSet, Item, Label } from "./items.ts";
import { runEval, runIdOf, type EvalOptions, type EvalResult } from "./run.ts";

export const SUPPLEMENTARY = {
  items: "eval/supplementary/items.json",
  labels: "eval/supplementary/labels.json",
  bundle: "eval/supplementary/bundle.json",
  results: "eval/supplementary/results",
} as const;

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const CycleSchema = z.object({
  tenant_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  decided_at: z.string().regex(ISO_MS),
  trace: z.string().nullable(),
});

const ItemSchema = z.object({
  id: z.string().regex(/^S\d+$/),
  class: z.string().min(1),
  source: z.string(),
  question: z.string(),
  agent_says: z.string(),
  facts: z.string(),
  refs: z.record(z.string(), z.string().nullable()),
  cycle: CycleSchema,
});
export type SupplementaryItem = z.infer<typeof ItemSchema>;

const LabelSchema = z.object({
  id: z.string().regex(/^S\d+$/),
  needs_human: z.enum(["yes", "no", "unsure"]),
  reason: z.string(),
  operator_note: z.string().optional(),
});

export interface SupplementarySet extends EvalSet {
  items: SupplementaryItem[];
}

export function parseSupplementary(itemsText: string, labelsText: string): SupplementarySet {
  const items = z.object({ items: z.array(ItemSchema) }).parse(JSON.parse(itemsText)).items;
  const labels: Label[] = z.object({ labels: z.array(LabelSchema) }).parse(JSON.parse(labelsText)).labels;
  const ids = new Set(items.map((i) => i.id));
  if (ids.size !== items.length) throw new Error("the supplementary items repeat an id");
  if (new Set(labels.map((l) => l.id)).size !== labels.length) throw new Error("the supplementary labels repeat an id");
  for (const l of labels) if (!ids.has(l.id)) throw new Error(`the supplementary labels name ${l.id}, an id absent from the items`);
  return { items, labels, labelsText };
}

export function loadSupplementary(itemsPath: string = SUPPLEMENTARY.items, labelsPath: string = SUPPLEMENTARY.labels): SupplementarySet {
  return parseSupplementary(readFileSync(itemsPath, "utf8"), readFileSync(labelsPath, "utf8"));
}

type Row = Record<string, unknown>;
const rowsOf = (b: Bundle, t: string): Row[] => ((b as Record<string, unknown>)[t] as Row[] | undefined) ?? [];
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The recording as it stood when the tenant's pass decided at `at`; see the contract. */
export function sliceAt(bundle: Bundle, tenant: string, at: string): Record<string, unknown> {
  if (!ISO_MS.test(at)) throw new Error(`slice instant is not ISO 8601 UTC with milliseconds: ${at}`);
  const mine = (r: Row): boolean => r.tenant_id === tenant;
  const upTo = (col: string) => (r: Row): boolean => str(r[col]) !== "" && str(r[col]) <= at;
  const before = (col: string) => (r: Row): boolean => str(r[col]) !== "" && str(r[col]) < at;

  const runs = rowsOf(bundle, "collection_run").filter((r) => mine(r) && upTo("started_at")(r) && (r.finished_at === null || r.finished_at === undefined || str(r.finished_at) <= at));
  const runIds = new Set(runs.map((r) => str(r.run_id)));
  const ofRun = (r: Row): boolean => mine(r) && runIds.has(str(r.run_id));
  const observation = rowsOf(bundle, "observation").filter(ofRun);
  const obsIds = new Set(observation.map((r) => str(r.obs_id)));
  const snapshots = rowsOf(bundle, "backup_snapshot").filter((r) => mine(r) && upTo("taken_at")(r));
  const snapIds = new Set(snapshots.map((r) => str(r.snapshot_id)));
  const copies = rowsOf(bundle, "vault_copy").filter((r) => mine(r) && upTo("taken_at")(r));
  const copyIds = new Set(copies.map((r) => str(r.copy_id)));

  const out: Record<string, unknown> = {
    _note: `slice of ${tenant} at ${at} (src/eval/supplementary.ts sliceAt)`,
    collection_run: runs,
    observation,
    approved_setting: rowsOf(bundle, "approved_setting").filter((r) => mine(r) && upTo("approved_at")(r)),
    backup_snapshot: snapshots,
    backup_item: rowsOf(bundle, "backup_item").filter((r) => snapIds.has(str(r.snapshot_id))),
    dns_record: rowsOf(bundle, "dns_record").filter(ofRun),
    audit_event: rowsOf(bundle, "audit_event").filter((r) => mine(r) && upTo("occurred_at")(r)),
    inventory_asset: rowsOf(bundle, "inventory_asset").filter(mine),
    policy_rule: rowsOf(bundle, "policy_rule").filter((r) => (r.tenant_id === tenant || r.tenant_id === "*") && upTo("since")(r)),
    vault_copy: copies,
    copy_validation: rowsOf(bundle, "copy_validation").filter((r) => mine(r) && copyIds.has(str(r.copy_id)) && upTo("validated_at")(r)),
    probe: rowsOf(bundle, "probe").filter(ofRun),
    disposition: rowsOf(bundle, "disposition").filter((r) => mine(r) && before("decided_at")(r)),
    action: rowsOf(bundle, "action").filter((r) => mine(r) && before("started_at")(r)),
    ticket: rowsOf(bundle, "ticket").filter((r) => mine(r) && before("created_at")(r)),
    referent_fingerprint: rowsOf(bundle, "referent_fingerprint").filter((r) => obsIds.has(str(r.obs_id)) && runIds.has(str(r.dns_run_id)) && before("resolved_at")(r)),
    finding_cause: rowsOf(bundle, "finding_cause").filter((r) => mine(r) && before("decided_at")(r)),
  };
  return out;
}

export interface Group { n: number; tenant: string; at: string; items: SupplementaryItem[] }

export function groups(set: SupplementarySet): Group[] {
  const out: Group[] = [];
  for (const item of set.items) {
    const g = out.find((x) => x.tenant === item.cycle.tenant_id && x.at === item.cycle.decided_at);
    if (g) g.items.push(item);
    else out.push({ n: out.length + 1, tenant: item.cycle.tenant_id, at: item.cycle.decided_at, items: [item] });
  }
  return out;
}

export const groupDir = (g: Pick<Group, "tenant" | "at">): string => `${g.tenant}-${g.at.slice(11, 19).replace(/:/g, "-")}`;

/** The group's own evaluation set: its items and their labels, the labels text that of the whole set. */
const groupSet = (set: SupplementarySet, g: Group): EvalSet => {
  const ids = new Set(g.items.map((i) => i.id));
  return { items: g.items as Item[], labels: set.labels.filter((l) => ids.has(l.id)), labelsText: set.labelsText };
};

export interface SupplementaryOptions extends Pick<EvalOptions, "protocolText" | "configs" | "runs" | "models" | "tracer" | "onRun" | "policyFile" | "redactor"> {
  set: SupplementarySet;
  bundle: Bundle;
  /** Called before each group's runEval. */
  onGroup?: (g: Group) => void;
  /** The meterless-scope prefix; default "supplementary-<run id>", the run id the start stamp. */
  scopePrefix?: string;
}

export interface GroupResult { group: Group; dir: string; result: EvalResult; slice: Record<string, number> }

export async function runSupplementary(opts: SupplementaryOptions): Promise<GroupResult[]> {
  const prefix = opts.scopePrefix ?? `supplementary-${runIdOf(new Date().toISOString())}`;
  const out: GroupResult[] = [];
  for (const g of groups(opts.set)) {
    opts.onGroup?.(g);
    const slice = sliceAt(opts.bundle, g.tenant, g.at);
    const result = await runEval({
      protocolText: opts.protocolText, evalSet: groupSet(opts.set, g), bundle: slice, configs: opts.configs, runs: opts.runs, set: "all",
      items: g.items.map((i) => i.id), planted: [], models: opts.models, tenant: g.tenant, tracer: opts.tracer, onRun: opts.onRun,
      policyFile: opts.policyFile, redactor: opts.redactor, scopePrefix: `${prefix}-g${g.n}`,
    });
    for (const r of result.runs) for (const i of r.items) (i as { set: string }).set = "supplementary";
    const counts = Object.fromEntries(Object.entries(slice).filter(([k]) => !k.startsWith("_")).map(([k, v]) => [k, (v as unknown[]).length]));
    out.push({ group: g, dir: groupDir(g), result, slice: counts });
  }
  return out;
}

export interface SupplementaryArgs { items: string; labels: string; bundle: string; out: string | undefined; configs: string[] | undefined; runs: number | undefined }

/**
 * The command line of `npm run eval -- --set supplementary [--items <path>] [--labels <path>] [--bundle <path>] [--out <dir>]
 * [--configs C0,C1] [--runs <n>]`: null for any other --set (the pre-registered path of scripts/eval.ts then runs as it
 * did). Under --set supplementary, --items and --labels name files (default the set's own), never item ids.
 */
export function supplementaryArgs(argv: readonly string[]): SupplementaryArgs | null {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (arg("set") !== "supplementary") return null;
  const file = (name: string, fallback: string): string => {
    const v = arg(name) ?? fallback;
    if (!v.endsWith(".json")) throw new Error(`--${name} under --set supplementary names a .json file, got ${v}`);
    return v;
  };
  const runs = arg("runs");
  return {
    items: file("items", SUPPLEMENTARY.items),
    labels: file("labels", SUPPLEMENTARY.labels),
    bundle: file("bundle", SUPPLEMENTARY.bundle),
    out: arg("out"),
    configs: arg("configs")?.split(",").map((x) => x.trim()).filter(Boolean),
    runs: runs ? Number(runs) : undefined,
  };
}
