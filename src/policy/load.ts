// The policy loader: a policy file (DRIFT_POLICY_FILE, default policy/hackathon.json) to policy_rule rows
// for one tenant, deterministic and redacted.
//
// Contract:
//   - The file passes src/policy/schema.ts PolicyFile, or nothing is returned and every issue is named.
//   - The file's tenant is "*" (rows for every tenant, stored with tenant_id "*") or the tenant the load is
//     for; a file for another tenant is refused.
//   - object_glob, setting_glob, author and note pass through the tenant's redactor before the id is
//     taken, so a real name typed in a policy is stored as the pseudonym the observations carry and the
//     rule still matches them; a glob made of paths, wildcards and the agent's own vocabulary comes back
//     unchanged (measured on every glob of policy/hackathon.json, test/policy.test.ts).
//   - rule_id is rows.ts ruleId over the stored tenant, surface, globs and the file's version, so the same
//     file gives the same rows, in file order, on every load; two rules of one file in one family share an
//     id and are refused.
//   - Each row passes PolicyRuleRow before it is returned.
//   - Error messages name rule numbers, field paths and redacted globs; a JSON fault is reported by its
//     position alone.

import { readFileSync } from "node:fs";
import { ruleId, type PolicyRule } from "../data/rows.ts";
import type { Redactor } from "../redactor.ts";
import { PolicyFile, PolicyRuleRow, issues } from "./schema.ts";

export class PolicyError extends Error {}

export interface LoadOptions {
  /** The tenant the rows are loaded for: a tenant id, or "*" for the policy every tenant shares. */
  tenant: string;
  redactor: Redactor;
}

export interface LoadedPolicy {
  file: PolicyFile;
  rows: PolicyRule[];
  /** Fields (globs, author, note) the redactor rewrote: a name typed in the policy, now its pseudonym. */
  redacted: number;
}

/** Validate a parsed policy file; refuses with one line per issue. */
export function parsePolicyFile(input: unknown): PolicyFile {
  const r = PolicyFile.safeParse(input);
  if (!r.success) throw new PolicyError(`policy file refused:\n  ${issues(r.error).join("\n  ")}`);
  return r.data;
}

/** The rows a validated file gives for the tenant, in file order. */
export function policyRows(file: PolicyFile, opts: LoadOptions): { rows: PolicyRule[]; redacted: number } {
  if (file.tenant !== "*" && file.tenant !== opts.tenant) throw new PolicyError(`the file is the policy of tenant ${file.tenant}; the load is for ${opts.tenant}`);
  let redacted = 0;
  const red = (s: string): string => {
    const out = opts.redactor.text(s);
    if (out !== s) redacted++;
    return out;
  };
  const author = red(file.author);
  const seen = new Map<string, number>();
  const rows = file.rules.map((spec, i): PolicyRule => {
    const object_glob = red(spec.object_glob);
    const setting_glob = red(spec.setting_glob);
    const rule_id = ruleId(file.tenant, spec.surface, object_glob, setting_glob, file.version);
    const before = seen.get(rule_id);
    if (before !== undefined) throw new PolicyError(`rules #${before + 1} and #${i + 1} name one family (${spec.surface} ${object_glob} ${setting_glob}) in one version`);
    seen.set(rule_id, i);
    const row: PolicyRule = {
      rule_id, tenant_id: file.tenant, surface: spec.surface, object_glob, setting_glob, criticality: spec.criticality, lock: spec.lock,
      on_drift: spec.on_drift, on_no_copy: spec.on_no_copy, hold_max_hours: spec.hold_max_hours, alert: spec.alert, psa_priority: spec.psa_priority,
      version: file.version, author, since: file.since, note: spec.note === undefined ? null : red(spec.note),
    };
    const checked = PolicyRuleRow.safeParse(row);
    if (!checked.success) throw new PolicyError(`rule #${i + 1} as a row is refused:\n  ${issues(checked.error).join("\n  ")}`);
    return row;
  });
  return { rows, redacted };
}

/** Read, parse, validate and turn into rows. */
export function loadPolicyFile(path: string, opts: LoadOptions): LoadedPolicy {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new PolicyError(`policy file ${path} is unreadable (${(e as NodeJS.ErrnoException).code ?? "read error"})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    // The parser's message quotes the text around the fault, and a policy can hold a real name: only the position is kept.
    const at = (e as Error).message.match(/position (\d+)/)?.[1];
    throw new PolicyError(`policy file ${path} holds invalid JSON${at ? ` (at position ${at})` : ""}`);
  }
  const file = parsePolicyFile(json);
  return { file, ...policyRows(file, opts) };
}
