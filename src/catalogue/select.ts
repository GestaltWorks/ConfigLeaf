// Selection: what Lightning answers with, and what we accept. The model sees the catalogue (id,
// purpose, finding classes, parameter names), one redacted finding and the JSON shape; it chooses at
// most four template ids and fills their parameters. Nothing it says becomes SQL. validateSelection
// drops what does not fit (unknown id, bad params, duplicates, more than six) and records a reason per
// drop instead of throwing, so an eval can count valid against invalid selections; a missing or long
// "why" is tolerated (blank or truncated), because it is prose, not a query input. defaultSelection is
// the documented fallback policy: the checks every finding of a class gets in SAMPLE_MODE and whenever
// no model answered; defaultChecks binds them from the finding through the same validator.

import { z } from "zod";
import { Nightshift, type ChatMessage } from "../adapters/nightshift.ts";
import type { Param, Params } from "../data/layer.ts";
import { CATALOGUE, FINDING_CLASSES, type FindingClass, type Template, paramNames, validateParams } from "./templates.ts";

/** Checks the prompt asks for at most; the schema tolerates up to MAX_CHECKS before dropping the rest. */
export const ASK_CHECKS = 4;
export const MAX_CHECKS = 6;
const WHY_MAX = 200;

const ParamValue = z.union([z.string(), z.number(), z.null()]);

export const SelectionSchema = z.object({
  checks: z.array(z.object({
    template: z.string(),
    params: z.record(z.string(), ParamValue),
    why: z.string().max(WHY_MAX),
  })).max(MAX_CHECKS),
  other: z.string().optional(),
});
export type Selection = z.infer<typeof SelectionSchema>;

export interface SelectedCheck { template: string; params: Params; why: string }
export interface RejectedCheck { check: unknown; reason: string }
export interface ValidatedSelection { valid: SelectedCheck[]; rejected: RejectedCheck[]; other?: string }

/**
 * One finding, redacted, as the detector hands it over and as the model sees it. Fields past the
 * setting itself are what the referent and the audit trail are known as: the DNS name in play
 * (the referent of a found_but_different, or the record's own name for a dns_change), what it now
 * resolves to, the id the audit log uses for it, the DNS run to compare against, and the window
 * between the previous observation (or backup) and this one. An approved_missing finding has no live
 * value: its value_hash is "" and approved_hash carries the approved value the run lacks.
 */
export interface FindingSummary {
  class: FindingClass;
  tenant_id: string;
  run_id: string;
  surface: string;
  host: string | null;
  object_id: string;
  setting_path: string;
  value_hash: string;
  /** approved_missing only: the hash of the latest approval of the setting, the value the run holds no observation of. */
  approved_hash?: string | null;
  value_redacted?: string | null;
  refers_to_type?: string | null;
  refers_to_id?: string | null;
  dns_name?: string | null;
  resolves_to?: string | null;
  resource_id?: string | null;
  dns_run_id?: string | null;
  since: string;
  until: string;
  /** One redacted line for the prompt and the trace. */
  summary: string;
}

/** The system message lists the catalogue; the user message carries the finding. Plain prompts only: Lightning returns empty on a /no_think system message. */
export function selectionPrompt(finding: FindingSummary, catalogue: readonly Template[] = CATALOGUE): ChatMessage[] {
  const lines = catalogue.map((t) =>
    `- ${t.id}: ${t.purpose} Applies to: ${t.appliesTo.join(", ")}. Params: ${paramNames(t).join(", ")}. Rows mean the precondition ${t.rowsMean}.`);
  const system = [
    "You select safety checks for one config-drift finding at an MSP. You never write SQL. You choose template ids from the catalogue below and fill their parameters from the finding; an engine renders and runs them.",
    "",
    `Finding classes: ${FINDING_CLASSES.join(", ")}.`,
    "",
    "Catalogue:",
    ...lines,
    "",
    "Rules:",
    "1. Answer ONLY with one JSON object, no prose and no markdown, in this shape:",
    '   {"checks":[{"template":"<id from the catalogue>","params":{"<param name>":"<value>"},"why":"<one short reason, under 200 characters>"}],"other":"<optional: a check you want that fits no template>"}',
    `2. Choose at most ${ASK_CHECKS} checks. Prefer templates whose "Applies to" includes the finding's class.`,
    "3. Fill every param the template names. Values are strings, numbers or null copied from the finding; never invent an id, host, address or timestamp. Keep timestamps exactly as the finding gives them.",
    '4. If a check you want fits no template, describe it in "other" instead of inventing a template id or a param.',
    "5. Use a template id exactly as listed.",
  ].join("\n");
  const user = `Finding (redacted):\n${JSON.stringify(finding)}\n\nSelect the checks.`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/** Drop what does not fit and say why; keep the rest. Accepts the parsed object or the model's raw reply text. */
export function validateSelection(raw: unknown, catalogue: readonly Template[] = CATALOGUE): ValidatedSelection {
  const obj = typeof raw === "string" ? Nightshift.extractJson(raw) : raw;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { valid: [], rejected: [{ check: raw, reason: "not a JSON object" }] };
  const o = obj as Record<string, unknown>;
  const other = typeof o.other === "string" && o.other.trim() ? o.other.trim().slice(0, 1000) : undefined;
  if (!Array.isArray(o.checks)) return { valid: [], rejected: [{ check: obj, reason: "checks is not an array" }], other };

  const valid: SelectedCheck[] = [];
  const rejected: RejectedCheck[] = [];
  const seen = new Set<string>();
  o.checks.forEach((c: unknown, i: number) => {
    if (i >= MAX_CHECKS) { rejected.push({ check: c, reason: `more than ${MAX_CHECKS} checks` }); return; }
    if (!c || typeof c !== "object" || Array.isArray(c)) { rejected.push({ check: c, reason: "check is not an object" }); return; }
    const ch = c as Record<string, unknown>;
    if (typeof ch.template !== "string") { rejected.push({ check: c, reason: "template is not a string" }); return; }
    const t = catalogue.find((x) => x.id === ch.template);
    if (!t) { rejected.push({ check: c, reason: `unknown template: ${ch.template}` }); return; }
    if (ch.params !== undefined && (typeof ch.params !== "object" || ch.params === null || Array.isArray(ch.params))) {
      rejected.push({ check: c, reason: `${t.id}: params is not an object` });
      return;
    }
    const p = validateParams(t, ch.params ?? {});
    if (!p.ok) { rejected.push({ check: c, reason: `${t.id}: ${p.reason}` }); return; }
    const key = t.id + JSON.stringify(Object.keys(p.params).sort().map((k) => [k, p.params[k]]));
    if (seen.has(key)) { rejected.push({ check: c, reason: `duplicate of an earlier ${t.id} check` }); return; }
    seen.add(key);
    const why = typeof ch.why === "string" ? ch.why.trim().slice(0, WHY_MAX) : "";
    valid.push({ template: t.id, params: p.params, why });
  });
  return { valid, rejected, other };
}

/**
 * The fallback policy, one list per finding class, at most ASK_CHECKS long. run_complete is first
 * everywhere: a finding from a partial run is not a safe basis for anything else.
 */
const DEFAULT_CHECKS: Record<FindingClass, readonly string[]> = {
  found_but_different: ["run_complete", "dns_target_in_inventory", "actor_attributed", "other_settings_reference"],
  changed_since_backup: ["run_complete", "backup_recent", "change_in_last_backup", "setting_matches_approved"],
  drift_vs_approved: ["run_complete", "setting_matches_approved", "restore_would_regress", "change_in_last_backup"],
  dns_change: ["run_complete", "host_in_inventory", "actor_attributed", "previous_value_recoverable"],
  // Survey classes: the DNS record is the resource the audit log knows; its window is the log's reach.
  proxy_split: ["run_complete", "actor_attributed", "previous_value_recoverable", "referent_unchanged"],
  proxied_without_real_ip: ["run_complete", "host_in_inventory", "actor_attributed", "previous_value_recoverable"],
  orphan_record: ["run_complete", "host_in_inventory", "actor_attributed", "previous_value_recoverable"],
  orphan_vhost: ["run_complete", "other_settings_reference", "backup_recent"],
  // An approved object absent from the run: the run is whole, a backup since the approval exists, and the newest backup holds the approved value.
  approved_missing: ["run_complete", "backup_recent", "change_in_last_backup"],
};

/**
 * The list a finding on a DNS record (host null) gets where its class's list reads the host: drift_vs_approved
 * on a record field binds no host for setting_matches_approved, restore_would_regress or
 * change_in_last_backup, so it gets the record's audit checks over the window from its approval to the run:
 * who touched the record and whether the state before the change is on record. approved_missing on a record
 * (a deleted record) gets the same two: who deleted it, and whether the log holds the record as it was.
 */
const DEFAULT_CHECKS_RECORD: Partial<Record<FindingClass, readonly string[]>> = {
  drift_vs_approved: ["run_complete", "actor_attributed", "previous_value_recoverable"],
  approved_missing: ["run_complete", "actor_attributed", "previous_value_recoverable"],
};

/** Deterministic: the template ids every finding of this class gets when no model answered. */
export function defaultSelection(findingClass: FindingClass): readonly string[] {
  return DEFAULT_CHECKS[findingClass];
}

/** The class's list, or for a finding with no host the record list of its class when there is one. */
export function defaultSelectionFor(finding: Pick<FindingSummary, "class" | "host">): readonly string[] {
  return (finding.host === null ? DEFAULT_CHECKS_RECORD[finding.class] : undefined) ?? DEFAULT_CHECKS[finding.class];
}

/** How each catalogue parameter is read off a finding. A test asserts every parameter in the catalogue has an entry. */
export const BIND: Readonly<Record<string, (f: FindingSummary) => Param | undefined>> = {
  tenant_id: (f) => f.tenant_id,
  run_id: (f) => f.run_id,
  dns_run_id: (f) => f.dns_run_id ?? undefined,
  host: (f) => f.host ?? undefined,
  object_id: (f) => f.object_id,
  setting_path: (f) => f.setting_path,
  // approved_missing has no live value: its value_hash is the approved one the run lacks
  value_hash: (f) => (f.class === "approved_missing" ? (f.approved_hash ?? undefined) : f.value_hash),
  address: (f) => f.resolves_to ?? undefined,
  name: (f) => f.dns_name ?? f.refers_to_id ?? undefined,
  refers_to_id: (f) => f.refers_to_id ?? undefined,
  resource_id: (f) => f.resource_id ?? undefined,
  since: (f) => f.since,
  until: (f) => f.until,
};

/** Bind one template's parameters from the finding; a parameter the finding cannot supply is left out, and validation says so. */
export function bindParams(t: Template, finding: FindingSummary): Params {
  const out: Record<string, Param> = {};
  for (const k of paramNames(t)) {
    const v = BIND[k]?.(finding);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** The default policy applied to one finding, through the same validator the model's answer goes through. */
export function defaultChecks(finding: FindingSummary, catalogue: readonly Template[] = CATALOGUE): ValidatedSelection {
  const checks = defaultSelectionFor(finding).map((id) => {
    const t = catalogue.find((x) => x.id === id);
    return { template: id, params: t ? bindParams(t, finding) : {}, why: `default policy for ${finding.class}` };
  });
  return validateSelection({ checks }, catalogue);
}
