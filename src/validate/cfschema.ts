// The cf-schema validator: whether a vault copy of one Cloudflare DNS record can be restored, offline. The
// copy is the record as the vault holds it (<zone>/<record_id>.json: id, name, type, content, ttl,
// proxied); the context is the other records of the same DNS run (the same vault commit) and the tenant's
// inventory. Pure: no network, no store.
//
// Contract:
//   - Known type: one of Cloudflare's record types (CF_TYPES); any other type fails.
//   - Name: a hostname, optionally led by "*."; anything else fails.
//   - Content shape per type: A a dotted IPv4 (node:net isIPv4); AAAA an IPv6 (isIPv6); CNAME and NS a
//     hostname (labels of letters, digits, "-" and "_", 1 to 63 characters each, at least two labels, a
//     letter in the last, 253 characters at most, an optional trailing dot); MX a hostname, optionally led
//     by a priority (0 to 65535) and a space, or "." (RFC 7505); TXT non-empty text of at most 4096
//     characters with no control character but tab; every other known type non-empty content. A shape outside
//     its type's rule fails.
//   - Dependencies of a well-shaped record: a CNAME target that is the name of a record of the same run,
//     or that a wildcard record of the run covers, is present; otherwise it is named as a dependency, inside
//     a collected zone without a record there, or outside the collected zones. An A or AAAA content present
//     in the inventory (compared through addressKey, so a real address meets its pseudonym) is present;
//     otherwise it is named as an address outside the inventory. With the inventory unread (null) the
//     address check is skipped and the output says so.
//   - result: ok when the shape holds and every dependency is present; ok_with_gaps when the shape holds and
//     a dependency is named; fail when the type, the name or the shape fails its check. missing_dependencies
//     are the names and addresses as given (the caller redacts), sorted; output is one sentence per issue,
//     "" when there is none.
//
// Measured 24 Oct 2026 on the recorded bundle: the 5 MX records carry the mail host alone in content
// (Cloudflare returns the priority in a field of its own), the 2 NS records a hostname, every TXT content
// starts with a double quote (Cloudflare quotes TXT contents).

import { isIPv4, isIPv6 } from "node:net";
import type { ValidationResult } from "../data/rows.ts";

/** Cloudflare's DNS record types. */
export const CF_TYPES = [
  "A", "AAAA", "CAA", "CERT", "CNAME", "DNSKEY", "DS", "HTTPS", "LOC", "MX", "NAPTR", "NS", "OPENPGPKEY", "PTR", "SMIMEA", "SRV", "SSHFP", "SVCB", "TLSA", "TXT", "URI",
] as const;

export interface CfRecord {
  id?: string;
  name: string;
  type: string;
  content: string;
  ttl?: number | null;
  proxied?: boolean | number | null;
}

export interface CfContext {
  /** Every record of the same DNS run (the same vault commit), the record itself included or not. */
  recordsOfRun: readonly Pick<CfRecord, "name">[];
  /** The tenant's inventory addresses (inventory_asset.address); null when the inventory was not read. */
  inventory: Iterable<string> | null;
  /** How a record's address is keyed before the inventory lookup: the tenant's redactor for a real address against stored pseudonyms. Default: as given. */
  addressKey?: (address: string) => string;
  /** The collected zone names, to say whether a missing CNAME target falls inside one. */
  zones?: readonly string[];
}

export interface CfValidation {
  result: ValidationResult;
  missing_dependencies: string[];
  output: string;
}

const LABEL = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/;
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/** Lower case, one trailing dot dropped: how names compare. */
export const nameKey = (s: string): string => s.trim().replace(/\.$/, "").toLowerCase();

/** A hostname: two or more labels, the last with a letter in it (so a dotted address is none), 253 characters at most, an optional trailing dot. */
export function isHostname(s: string): boolean {
  const h = s.replace(/\.$/, "");
  const labels = h.split(".");
  return h.length > 0 && h.length <= 253 && labels.length >= 2 && labels.every((l) => LABEL.test(l)) && /[A-Za-z]/.test(labels[labels.length - 1]);
}

function shapeIssue(type: string, content: string): string | null {
  switch (type) {
    case "A": return isIPv4(content) ? null : `A content must be a dotted IPv4 address, got ${content}`;
    case "AAAA": return isIPv6(content) ? null : `AAAA content must be an IPv6 address, got ${content}`;
    case "CNAME": return isHostname(content) ? null : `CNAME content must be a hostname, got ${content}`;
    case "NS": return isHostname(content) ? null : `NS content must be a hostname, got ${content}`;
    case "MX": {
      const m = /^(?:(\d{1,5})\s+)?(\S+)$/.exec(content.trim());
      const ok = m !== null && (m[1] === undefined || Number(m[1]) <= 65535) && (m[2] === "." || isHostname(m[2]));
      return ok ? null : `MX content must be a host or "priority host", got ${content}`;
    }
    case "TXT":
      if (content.length === 0) return "TXT content is empty";
      if (content.length > 4096) return `TXT content is ${content.length} characters, over 4096`;
      return CONTROL.test(content) ? "TXT content holds a control character" : null;
    default:
      return content.trim() ? null : `${type} content is empty`;
  }
}

/** Validate one record copy; see the module header for the contract. */
export function validateCloudflareCopy(record: CfRecord, ctx: CfContext): CfValidation {
  const type = String(record.type ?? "").toUpperCase();
  const content = String(record.content ?? "");
  const name = String(record.name ?? "");
  const issues: string[] = [];
  if (!(CF_TYPES as readonly string[]).includes(type)) issues.push(`record type ${JSON.stringify(record.type)} is outside Cloudflare's record types`);
  if (!isHostname(name.replace(/^\*\./, ""))) issues.push(`record name must be a hostname, got ${name}`);
  if (!issues.length) {
    const shape = shapeIssue(type, content);
    if (shape) issues.push(shape);
  }
  if (issues.length) return { result: "fail", missing_dependencies: [], output: issues.join("\n") };

  const gaps: string[] = [];
  const notes: string[] = [];
  if (type === "CNAME") {
    const target = nameKey(content);
    const names = new Set(ctx.recordsOfRun.map((r) => nameKey(r.name)));
    const wildcard = `*.${target.split(".").slice(1).join(".")}`;
    if (!names.has(target) && !names.has(wildcard)) {
      const zone = (ctx.zones ?? []).map(nameKey).find((z) => target === z || target.endsWith(`.${z}`));
      gaps.push(target);
      notes.push(zone ? `CNAME target ${target} has no record in its collected zone ${zone}` : `CNAME target ${target} is outside the collected zones`);
    }
  }
  if (type === "A" || type === "AAAA") {
    if (ctx.inventory === null) {
      notes.push(`${type} content ${content}: the inventory was not read, so the address was not checked`);
    } else {
      const key = ctx.addressKey ?? ((a: string) => a);
      const inventory = new Set(ctx.inventory);
      if (!inventory.has(key(content))) {
        gaps.push(content);
        notes.push(`${type} content ${content} is an address outside the inventory`);
      }
    }
  }
  return { result: gaps.length ? "ok_with_gaps" : "ok", missing_dependencies: [...new Set(gaps)].sort(), output: notes.join("\n") };
}
