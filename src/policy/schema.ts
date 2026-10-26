// The policy's two shapes, in zod: the file an MSP writes (policy/hackathon.json) and the policy_rule row
// the Store holds and the Decider reads.
//
// Contract:
//   - Every value set is closed: surface linux.nginx | cloudflare.dns | zetaris.control | *, criticality critical |
//     high | normal | low, on_drift rollback | investigate | adopt | hold | escalate, on_no_copy investigate_ticket |
//     ticket | adopt, alert always | on_fix | never, psa_priority P1..P4, lock 0 | 1. Every other value
//     is refused, and so is a key outside the shape.
//   - hold_max_hours is a whole number from 0 to 8760. A rule whose on_drift is hold or rollback needs at
//     least 1: those rules decide HOLD (rollback holds a drift it has no valid copy for), and every HOLD
//     carries an expiry after the moment it is decided.
//   - A locked rule (lock 1) acts on a drift: its on_drift is rollback, investigate, hold or escalate. lock 1 with
//     on_drift adopt is refused.
//   - The file's tenant is a tenant id or "*" (every tenant); since is ISO 8601 UTC, normalised to the
//     millisecond form the Store and the sql.js loader hold every timestamp to.

import { z } from "zod";
import type { PolicyRule } from "../data/rows.ts";

export const SURFACES = ["linux.nginx", "cloudflare.dns", "zetaris.control", "*"] as const;
export const CRITICALITIES = ["critical", "high", "normal", "low"] as const;
export const ON_DRIFT = ["rollback", "investigate", "adopt", "hold", "escalate"] as const;
export const ON_NO_COPY = ["investigate_ticket", "ticket", "adopt"] as const;
export const ALERTS = ["always", "on_fix", "never"] as const;
export const PSA_PRIORITIES = ["P1", "P2", "P3", "P4"] as const;

/**
 * A tenant id, the one pattern every script that takes --tenant holds it to: a header-safe token of letters, digits,
 * ".", "_" and "-", up to 64, starting with a letter or a digit and ending in anything but ".", so it is also a
 * directory name of the vault (src/vault/vault.ts) on every file system.
 */
export const TENANT_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/;
/** How a usage line names TENANT_ID. */
export const TENANT_ID_SHAPE = "a tenant id ([A-Za-z0-9._-], up to 64, no trailing dot)";
/** A policy file's tenant: a tenant id or "*" (every tenant). */
export const TENANT = new RegExp(`^(?:\\*|${TENANT_ID.source.slice(1, -1)})$`);
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const glob = () => z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/, "a glob is printable text on one line");

const RULE_FIELDS = {
  surface: z.enum(SURFACES),
  object_glob: glob(),
  setting_glob: glob(),
  criticality: z.enum(CRITICALITIES),
  lock: z.union([z.literal(0), z.literal(1)]),
  on_drift: z.enum(ON_DRIFT),
  on_no_copy: z.enum(ON_NO_COPY),
  hold_max_hours: z.number().int().min(0).max(8760),
  alert: z.enum(ALERTS),
  psa_priority: z.enum(PSA_PRIORITIES),
};

type Checked = { lock: number; on_drift: string; hold_max_hours: number };

function ruleChecks(r: Checked, ctx: z.RefinementCtx): void {
  if (r.lock === 1 && r.on_drift === "adopt") {
    ctx.addIssue({ code: "custom", path: ["lock"], message: "lock 1 acts on a drift: on_drift must be rollback, investigate, hold or escalate, and this rule adopts" });
  }
  if ((r.on_drift === "hold" || r.on_drift === "rollback") && r.hold_max_hours < 1) {
    ctx.addIssue({ code: "custom", path: ["hold_max_hours"], message: `on_drift ${r.on_drift} decides HOLD, and a HOLD expires at least 1 hour after it is decided` });
  }
}

/** One rule as the file states it. */
export const PolicyRuleSpec = z.strictObject({ ...RULE_FIELDS, note: z.string().min(1).max(1024).optional() }).superRefine(ruleChecks);
export type PolicyRuleSpec = z.infer<typeof PolicyRuleSpec>;

/** The policy file: one version of the MSP's rules for one tenant or for every tenant. */
export const PolicyFile = z.strictObject({
  version: z.number().int().min(1),
  author: z.string().min(1).max(128),
  since: z.iso.datetime().transform((s) => new Date(s).toISOString()),
  tenant: z.string().regex(TENANT, "a tenant id ([A-Za-z0-9._-], up to 64) or *"),
  rules: z.array(PolicyRuleSpec).min(1),
});
export type PolicyFile = z.infer<typeof PolicyFile>;

/** One policy_rule row, column for column with sql/schema.sql. */
export const PolicyRuleRow = z.strictObject({
  rule_id: z.string().regex(/^rule-[0-9a-f]{16}$/),
  tenant_id: z.string().regex(TENANT),
  ...RULE_FIELDS,
  version: z.number().int().min(1),
  author: z.string().min(1).max(128),
  since: z.string().regex(ISO_MS, "ISO 8601 UTC in the millisecond form"),
  note: z.string().min(1).max(1024).nullable(),
}).superRefine(ruleChecks);

/** Compile-time: a parsed row is a PolicyRule. */
const _rowIsPolicyRule: z.infer<typeof PolicyRuleRow> extends PolicyRule ? true : never = true;
void _rowIsPolicyRule;

/** zod's issues as one line each: path, then message. */
export function issues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.length ? i.path.join(".") : "(file)"}: ${i.message}`);
}
