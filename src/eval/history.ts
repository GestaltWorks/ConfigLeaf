// History items as findings. A dns_change_history item names a record and a dns_bulk_delete item a day; both
// are read from the recording's audit_event rows (src/eval/queries.ts) and become one FindingSummary of class
// dns_change, so the class's checks run through the same assess path as a pass finding and C0 has an
// executable verdict for them.
//
// Contract.
//   dns_change_history: the record's audit events other than reads, in order. The finding is the last change:
//     since = the first event's occurred_at, until = the last's; setting_path = the first field of content,
//     proxied, type, name, ttl whose value differs between the last two bodies ("content" for a single event);
//     value_hash = sha256 of the last body's text; dns_name, and resolves_to for an A or AAAA body, from it.
//   dns_bulk_delete: the tenant's deletions of the day (00:00 to 24:00 UTC), in order. The finding is the
//     day's last deletion: object_id and resource_id its record, since the first deletion, until the last,
//     setting_path "record", value_hash sha256 of the deleted body's text.
//   Both: tenant the recording's, run_id and dns_run_id the tenant's latest DNS run that passes the gate,
//   surface cloudflare.dns, host null. An item whose record or day holds no event is not raised.
//
// Measured 24 Oct 2026 on test/fixtures/recorded-bundle.json (test/eval.test.ts): all 14 history items
// raise a finding; the www record's (E17) is its third update, 2026-04-16T21:11:15.232Z to 21:47:29.277Z,
// setting_path content.

import { createHash } from "node:crypto";
import type { FindingSummary } from "../catalogue/select.ts";
import type { DataLayer, RunOptions } from "../data/layer.ts";
import { objects } from "../data/queries.ts";
import type { Item } from "./items.ts";
import { AUDIT_OF_RESOURCE_SQL, DELETES_IN_WINDOW_SQL } from "./queries.ts";

type Row = Record<string, string>;

export interface HistoryContext {
  tenant_id: string;
  /** The tenant's latest DNS run that passes the gate: the finding's run and DNS run. */
  dns_run_id: string;
}

export type HistoryFinding = { kind: "finding"; finding: FindingSummary; events: number } | { kind: "not_raised"; reason: string };

const sha256 = (s: string): string => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const FIELDS = ["content", "proxied", "type", "name", "ttl"] as const;

/** A record body as the audit log stores it (JSON text); null for text that is no JSON object. */
export function recordBody(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const show = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));
const isAddress = (type: string): boolean => type === "A" || type === "AAAA";

function base(ctx: HistoryContext, resource: string): Pick<FindingSummary, "class" | "tenant_id" | "run_id" | "surface" | "host" | "object_id" | "resource_id" | "dns_run_id"> {
  return { class: "dns_change", tenant_id: ctx.tenant_id, run_id: ctx.dns_run_id, surface: "cloudflare.dns", host: null, object_id: resource, resource_id: resource, dns_run_id: ctx.dns_run_id };
}

/** The last change of a record's audit sequence as a dns_change finding. */
export function changeFinding(ctx: HistoryContext, recordId: string, events: readonly Row[]): FindingSummary {
  const last = events[events.length - 1];
  const body = recordBody(last.new_value) ?? recordBody(last.old_value) ?? {};
  const prev = events.length > 1 ? (recordBody(events[events.length - 2].new_value) ?? {}) : null;
  const field = prev ? (FIELDS.find((k) => show(prev[k]) !== show(body[k])) ?? "content") : "content";
  const type = show(body.type);
  const name = show(body.name);
  const content = show(body.content);
  const since = events[0].occurred_at;
  const until = last.occurred_at;
  return {
    ...base(ctx, recordId),
    setting_path: field, value_hash: sha256(last.new_value || last.old_value || ""), value_redacted: show(body[field]) || null,
    refers_to_type: isAddress(type) ? "ip" : type === "CNAME" ? "dns_name" : null, refers_to_id: content || null,
    dns_name: name || null, resolves_to: isAddress(type) && content ? content : null,
    since, until,
    summary: `record ${recordId} (${name} ${type}) has ${events.length} change(s) in the audit log between ${since} and ${until}; the last one, at ${until}, set it to ${type} ${content}, proxied ${show(body.proxied)}`,
  };
}

/** The last deletion of a day as a dns_change finding. */
export function deletionFinding(ctx: HistoryContext, day: string, events: readonly Row[]): FindingSummary {
  const last = events[events.length - 1];
  const body = recordBody(last.old_value) ?? recordBody(last.new_value) ?? {};
  const type = show(body.type);
  const name = show(body.name);
  const since = events[0].occurred_at;
  const until = last.occurred_at;
  return {
    ...base(ctx, last.resource_id),
    setting_path: "record", value_hash: sha256(last.old_value || last.new_value || ""), value_redacted: null,
    refers_to_type: null, refers_to_id: null, dns_name: name || null, resolves_to: isAddress(type) && show(body.content) ? show(body.content) : null,
    since, until,
    summary: `${events.length} DNS record(s) deleted on ${day} between ${since} and ${until}; the last, record ${last.resource_id} (${name} ${type}), at ${until}`,
  };
}

/** The day after an ISO date (YYYY-MM-DD), as the millisecond-form instant that ends it. */
const dayEnd = (day: string): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString();

/** One history item read from the audit log of the recording. */
export async function historyFinding(layer: DataLayer, ctx: HistoryContext, item: Item, opts: RunOptions = {}): Promise<HistoryFinding> {
  if (item.class === "dns_change_history") {
    const record = item.refs.record_id ?? "";
    if (!record) return { kind: "not_raised", reason: "the item's refs name no record_id" };
    const events = objects(await layer.run(AUDIT_OF_RESOURCE_SQL, { tenant_id: ctx.tenant_id, resource_id: record }, { ...opts, limit: 10_000 }));
    if (!events.length) return { kind: "not_raised", reason: `the recording's audit log holds no change of record ${record}` };
    return { kind: "finding", finding: changeFinding(ctx, record, events), events: events.length };
  }
  if (item.class === "dns_bulk_delete") {
    const day = item.refs.day ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { kind: "not_raised", reason: "the item's refs name no day as YYYY-MM-DD" };
    const events = objects(await layer.run(DELETES_IN_WINDOW_SQL, { tenant_id: ctx.tenant_id, since: `${day}T00:00:00.000Z`, until: dayEnd(day) }, { ...opts, limit: 10_000 }));
    if (!events.length) return { kind: "not_raised", reason: `the recording's audit log holds no deletion on ${day}` };
    return { kind: "finding", finding: deletionFinding(ctx, day, events), events: events.length };
  }
  return { kind: "not_raised", reason: `class ${item.class} has no history reading` };
}
