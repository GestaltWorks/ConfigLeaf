// Policy resolution: the one rule that governs one setting, or none. Pure and deterministic: the same
// rules and the same setting give the same answer, whatever order the rules arrive in.
//
// Contract, for a setting (tenant_id, surface, object_id, setting_path):
//   1. Candidates are the rules whose tenant_id is the setting's or "*", whose surface is the setting's
//      or "*", whose object_glob matches object_id and whose setting_glob matches setting_path
//      (src/policy/glob.ts).
//   2. Of each family (tenant_id, surface, object_glob, setting_glob) only the highest version stays.
//   3. Precedence: an exact tenant over "*"; an exact surface over "*"; the object_glob with more literal
//      characters; the setting_glob with more literal characters; the higher version; rule_id ascending.
//   4. resolvePolicy returns the first rule in that order; null when there is no candidate, and the pass
//      then decides as it does without a policy.
//
// Measured 24 Oct 2026 over policy/hackathon.json version 2 and the object ids of sample/bundle.json
// (test/policy.test.ts): a live conf.d vhost file's "file" setting resolves to the critical, locked
// rollback rule; its dated and .bak copies to "dated copies beside a live file"; a block's real_ip to the
// high hold rule; nginx.conf's file to its own critical rule; a Cloudflare record's content and proxied to
// the critical record rules, its ttl to the normal adopt rule, its name and type to the catch-all hold
// rule. A live site under sites-available resolves its "file" setting to the critical sites-available
// rule ("/etc/nginx/sites-available/*", 27 literal characters), and its .bak and .pre-symlink copies to
// the low adopt rules "/etc/nginx/sites-available/*.bak*" (31) and "*.pre-symlink*" (39). Of the 54
// `file` settings of both hosts: 8 conf.d live files and 11 live sites critical, 2 nginx.conf critical,
// 8 conf.d copies, 8 .bak and 1 .pre-symlink copies under sites-available low, 16 under the catch-all.

import type { PolicyRule } from "../data/rows.ts";
import { globMatch, literalLength } from "./glob.ts";

/** The setting a rule is resolved for: the keys an observation row carries. */
export interface SettingRef {
  tenant_id: string;
  surface: string;
  object_id: string;
  setting_path: string;
}

const family = (r: PolicyRule): string => [r.tenant_id, r.surface, r.object_glob, r.setting_glob].join("\u001f");

/** Does the rule govern this setting, before versions and precedence are weighed? */
export function ruleMatches(rule: PolicyRule, setting: SettingRef): boolean {
  return (rule.tenant_id === setting.tenant_id || rule.tenant_id === "*")
    && (rule.surface === setting.surface || rule.surface === "*")
    && globMatch(rule.object_glob, setting.object_id)
    && globMatch(rule.setting_glob, setting.setting_path);
}

/** The precedence order for one setting: negative when `a` outranks `b`. */
export function comparePrecedence(setting: SettingRef): (a: PolicyRule, b: PolicyRule) => number {
  const key = (r: PolicyRule): number[] => [
    r.tenant_id === setting.tenant_id ? 0 : 1,
    r.surface === setting.surface ? 0 : 1,
    -literalLength(r.object_glob),
    -literalLength(r.setting_glob),
    -r.version,
  ];
  return (a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0;
  };
}

/** Every candidate rule, the highest version of each family, in precedence order; the first is the one that governs. */
export function rankedRules(rules: readonly PolicyRule[], setting: SettingRef): PolicyRule[] {
  const best = new Map<string, PolicyRule>();
  for (const r of rules) {
    if (!ruleMatches(r, setting)) continue;
    const f = family(r);
    const seen = best.get(f);
    if (!seen || r.version > seen.version || (r.version === seen.version && r.rule_id < seen.rule_id)) best.set(f, r);
  }
  return [...best.values()].sort(comparePrecedence(setting));
}

/** The one rule that governs the setting, or null. */
export function resolvePolicy(rules: readonly PolicyRule[], setting: SettingRef): PolicyRule | null {
  return rankedRules(rules, setting)[0] ?? null;
}
