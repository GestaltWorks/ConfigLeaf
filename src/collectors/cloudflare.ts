// Cloudflare collector: the DNS records of every zone the token sees and the account audit log,
// normalised to dns_record, audit_event and collection_run rows (src/data/rows.ts). Every collected-text
// column (rows.ts REDACT) has been through the Redactor before a row leaves: zones, names and contents
// pseudonymised, the actor's email reduced to its pseudonym (the email is never kept), request bodies
// through Redactor.json and then text() over the serialisation, so the Store's second pass changes
// nothing. Ids, record types and audit enums are Cloudflare's vocabulary and stay as sent.
//
// API, measured 24 Oct 2026 with the read token (one account, six zones, 58 records):
//   GET /zones?per_page=50&page=N
//   GET /zones/{id}/dns_records?per_page=1           the population: result_info.total_count, read for
//                                                     every zone before any record row is fetched
//   GET /zones/{id}/dns_records?per_page=500&page=N  pages 1..total_pages of page 1; a page past the last
//                                                     answers total_count 0, so only page 1 is believed
//   GET /accounts/{id}/logs/audit?since=D&before=D&limit=1000&direction=asc[&cursor=C]
//     result_info is {count, cursor}: no total, and the cursor is absent on the last page. Both dates
//     are required. since = today - 18 months + 1 day was accepted, two days earlier refused ("Audit
//     Logs expire after 18 months"); before two days ahead was accepted; before is not a strict UTC
//     midnight bound (before=2026-04-17 returned a row timed 2026-04-17). action.time carries 0 to 3
//     fractional digits; occurred_at is normalised to the millisecond form the loader requires.
//   PATCH /zones/{id}/dns_records/{record}           patchRecord, and POST /zones/{id}/dns_records, createRecord:
//     the two record writes, made by the Actor behind --apply (src/actions/revert.ts) with a token that holds DNS
//     Edit; the collector reads only. Exercised through a fake fetch (test/cloudflare.test.ts); the account had
//     received 0 writes from this code on 24 Oct 2026.
//   Event shapes: a record UPDATE is product dns_records, type null, resource.id = the record id,
//     request = the body (name, type, content, proxied, ...). A CREATE through the API or dash is
//     product dns_records with resource.id null. System create/delete is product dns, type record,
//     value = the record, whose value.id is the record id (resource.id equals it in 59 of 113 creates;
//     a uuid or null in the rest). No event carries old and new values: a record's previous state is
//     the latest earlier create or update on its id (previousState).
//
// The audit log has no total to assert, so the audit run's expected_count is the sum of the server's
// per-page counts and observed_count the distinct rows that normalised: a row without id, type or a
// parseable time is dropped and fails the DQ gate instead of vanishing.
//
// Each dns_record row also becomes five observation rows of the DNS run, one per RECORD_FIELDS entry
// (type, name, content, ttl, proxied): surface cloudflare.dns, host null, object_id the record id,
// value_hash Redactor.fingerprint of the field's value as the API sent it (ttl and proxied as the row's
// integer text, "" when absent), value_redacted the row's own redacted column, content refers to an ip
// (A, AAAA) or a dns_name (CNAME). approved_setting rows for a record and DRIFT_VS_APPROVED_SQL read
// these rows, the same way they read a vhost's settings. The DNS run's expected_count and
// observed_count count records. rawRecords keeps every zone's records as the API returned them, with the
// zone's real name, for the vault (src/vault/hook.ts cloudflareVaultFiles); it carries real names and
// raw contents, and the vault is its one reader.

import { config, redact } from "../config.ts";
import { AUTHORITY, eventId, obsId, runId, type AuditEvent, type CollectionRun, type DnsRecord, type Observation } from "../data/rows.ts";
import type { Redactor } from "../redactor.ts";

export const API = "https://api.cloudflare.com/client/v4";
export const RECORDS_PER_PAGE = 500;
export const AUDIT_LIMIT = 1000;
export const AUDIT_RETENTION_MONTHS = 18;
const ZONES_PER_PAGE = 50;
const MAX_PAGES = 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CfZone { id: string; name: string; account?: { id?: string; name?: string } }
export interface CfRecord { id: string; name: string; type: string; content: string; ttl?: number; proxied?: boolean }
export interface CfAuditRow {
  id?: string;
  action?: { type?: string; result?: string; time?: string; description?: string };
  actor?: { id?: string; email?: string; ip_address?: string; type?: string; context?: string };
  resource?: { id?: string | null; product?: string | null; type?: string | null; scope?: string | null; request?: unknown; value?: unknown };
  zone?: { id?: string; name?: string } | null;
}
interface ResultInfo { page?: number; per_page?: number; count?: number; total_count?: number; total_pages?: number; cursor?: string }
interface Envelope<T> { success: boolean; errors?: { code?: number; message?: string }[]; result: T; result_info?: ResultInfo }

export class CloudflareError extends Error {
  constructor(message: string, readonly status: number) { super(redact(message)); }
}

/** What a record write sends: the fields the vault's record JSON holds (src/vault/hook.ts recordJson). */
export interface CfRecordBody { type: string; name: string; content: string; ttl?: number; proxied?: boolean }

/** The body checked and in the field order Cloudflare documents; refused before any request when a field has another shape. */
function recordBody(b: CfRecordBody): CfRecordBody {
  for (const k of ["type", "name", "content"] as const) {
    if (typeof b?.[k] !== "string" || !b[k]) throw new CloudflareError(`record body: ${k} must be a non-empty string`, 0);
  }
  if (b.ttl !== undefined && (!Number.isInteger(b.ttl) || b.ttl < 1)) throw new CloudflareError("record body: ttl must be a positive integer", 0);
  if (b.proxied !== undefined && typeof b.proxied !== "boolean") throw new CloudflareError("record body: proxied must be true or false", 0);
  return { type: b.type, name: b.name, content: b.content, ...(b.ttl === undefined ? {} : { ttl: b.ttl }), ...(b.proxied === undefined ? {} : { proxied: b.proxied }) };
}

export class Cloudflare {
  private readonly token: string;
  private readonly fetchFn: FetchLike;
  private readonly base: string;
  /** Every request made, path and query only, in order. */
  readonly requests: string[] = [];

  constructor(opts: { token?: string; fetch?: FetchLike; baseUrl?: string } = {}) {
    this.token = opts.token ?? config.cloudflare.token;
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    this.base = (opts.baseUrl ?? API).replace(/\/+$/, "");
  }

  private get<T>(path: string): Promise<Envelope<T>> {
    return this.call<T>("GET", path);
  }

  /** One request. A GET is logged as its path and query; a write as "<METHOD> <path>". The body, when given, is JSON. */
  private async call<T>(method: "GET" | "PATCH" | "POST", path: string, body?: unknown): Promise<Envelope<T>> {
    if (!this.token) throw new CloudflareError("CLOUDFLARE_API_TOKEN is not set", 0);
    this.requests.push(method === "GET" ? path : `${method} ${path}`);
    const r = await this.fetchFn(this.base + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    let j: Envelope<T> | undefined;
    try { j = JSON.parse(text) as Envelope<T>; } catch { /* not JSON; reported below */ }
    if (!r.ok || !j?.success) {
      const why = j?.errors?.map((e) => `${e.code ?? "?"}: ${e.message ?? ""}`).join("; ") || text.slice(0, 200);
      throw new CloudflareError(`Cloudflare ${r.status} ${method} ${path.split("?")[0]}: ${why}`, r.status);
    }
    return j;
  }

  /**
   * PATCH /zones/{zone}/dns_records/{id}: the record's type, name, content, ttl and proxied set to the body's (ttl and
   * proxied sent when the body carries them). Returns the record as the API answers it. A write: the token needs DNS
   * Edit, and the Actor (src/actions/revert.ts) calls it behind --apply only.
   */
  async patchRecord(zoneId: string, recordId: string, body: CfRecordBody): Promise<CfRecord> {
    return (await this.call<CfRecord>("PATCH", `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, recordBody(body))).result;
  }

  /** POST /zones/{zone}/dns_records: a new record with the body's fields; returns it with the id Cloudflare gave it. A write, as patchRecord. */
  async createRecord(zoneId: string, body: CfRecordBody): Promise<CfRecord> {
    return (await this.call<CfRecord>("POST", `/zones/${encodeURIComponent(zoneId)}/dns_records`, recordBody(body))).result;
  }

  /** Page 1, then pages 2..total_pages as page 1 reported them; an empty page ends the walk early. */
  private async paged<T>(path: string, perPage: number): Promise<T[]> {
    const sep = path.includes("?") ? "&" : "?";
    const first = await this.get<T[]>(`${path}${sep}per_page=${perPage}&page=1`);
    const out = [...first.result];
    const pages = Math.min(first.result_info?.total_pages ?? 1, MAX_PAGES);
    for (let p = 2; p <= pages; p++) {
      const next = await this.get<T[]>(`${path}${sep}per_page=${perPage}&page=${p}`);
      if (next.result.length === 0) break;
      out.push(...next.result);
    }
    return out;
  }

  listZones(): Promise<CfZone[]> {
    return this.paged<CfZone>("/zones", ZONES_PER_PAGE);
  }

  /** The zone's record population as the API reports it, read before any record row. */
  async countRecords(zoneId: string): Promise<number> {
    const r = await this.get<CfRecord[]>(`/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=1&page=1`);
    const n = r.result_info?.total_count;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new CloudflareError(`no total_count for zone ${zoneId}`, 0);
    return n;
  }

  listRecords(zoneId: string): Promise<CfRecord[]> {
    return this.paged<CfRecord>(`/zones/${encodeURIComponent(zoneId)}/dns_records`, RECORDS_PER_PAGE);
  }

  /** Every audit row of the window, oldest first, following the cursor. `reported` sums the server's per-page counts. */
  async listAuditLog(accountId: string, since: string, before: string): Promise<{ rows: CfAuditRow[]; reported: number }> {
    if (!DAY.test(since) || !DAY.test(before)) throw new CloudflareError(`since and before must be YYYY-MM-DD, got ${since} and ${before}`, 0);
    const rows: CfAuditRow[] = [];
    const seen = new Set<string>();
    let reported = 0;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = `/accounts/${encodeURIComponent(accountId)}/logs/audit?since=${since}&before=${before}&limit=${AUDIT_LIMIT}&direction=asc`
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const r = await this.get<CfAuditRow[]>(q);
      rows.push(...r.result);
      reported += r.result_info?.count ?? r.result.length;
      cursor = r.result_info?.cursor || undefined;
      if (!cursor || r.result.length === 0) return { rows, reported };
      if (seen.has(cursor)) throw new CloudflareError(`audit cursor repeated after ${rows.length} rows`, 0);
      seen.add(cursor);
    }
    throw new CloudflareError(`audit log longer than ${MAX_PAGES} pages`, 0);
  }
}

export interface AuditWindow { since: string; before: string; clamped: boolean }

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

function isDay(s: string): boolean {
  if (!DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && ymd(d) === s;
}

/**
 * The audit query window. before is tomorrow (UTC) so today's events are in. since defaults to, and is
 * clamped up to, the earliest day inside the retention: 18 months back plus one day, the edge the API
 * was measured to accept. A since on or after before is refused.
 */
export function auditWindow(now: Date, since?: string): AuditWindow {
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  const earliest = ymd(new Date(Date.UTC(y, m - AUDIT_RETENTION_MONTHS, d + 1)));
  const before = ymd(new Date(Date.UTC(y, m, d + 1)));
  if (since === undefined) return { since: earliest, before, clamped: false };
  if (!isDay(since)) throw new CloudflareError(`since must be a YYYY-MM-DD date, got ${since}`, 0);
  if (since >= before) throw new CloudflareError(`since ${since} is not before ${before}`, 0);
  return since < earliest ? { since: earliest, before, clamped: true } : { since, before, clamped: false };
}

/** ISO 8601 with 0 to 3 fractional digits -> the canonical millisecond form; undefined when unparseable. */
export function isoMs(t: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(t)) return undefined;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export const proxiedFlag = (p: unknown): number | null => (p === true ? 1 : p === false ? 0 : null);

// Measured on the fixtures: the redactor's host pass skips a name that follows a "." (it reads it as a
// dotted key path), so a wildcard's "*.client.com" passes whole. Until redactor.ts handles it, the "."
// after "*" is swapped for a separator the pass accepts and restored after. The result is a fixed point
// of the Store's own pass, which sees "*.host-XXXXXX.com" and leaves it.
const unwild = (s: string): string => s.replace(/\*\./g, "*\u0001");
const rewild = (s: string): string => s.replace(/\*\u0001/g, "*.");
function strings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => strings(x, f));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strings(x, f)]));
  return v;
}
const redText = (r: Redactor, s: string): string => rewild(r.text(unwild(s)));
const redValue = (r: Redactor, s: string): string => rewild(r.value(unwild(s)));

/**
 * TXT content as Cloudflare returns it: quoted, a long record split into several quoted strings, tags
 * separated by ";". The quotes hide a bare token from value() (measured live: a 218-character DKIM p=
 * key, a 68-character verification token and 43-character tokens passed whole), so after the
 * whole-string pass every tag value and bare token goes through value() on its own. SPF, DMARC and
 * their hosts and mailboxes read as before.
 */
export function txtValue(r: Redactor, s: string): string {
  return redValue(r, s).replace(/[^\s";]+/g, (tok) => {
    const m = tok.match(/^([A-Za-z][\w-]{0,30}=)(.+)$/);
    return m && !/^=+$/.test(m[2]) ? m[1] + redValue(r, m[2]) : redValue(r, tok);
  });
}

const isTxt = (t: unknown): boolean => typeof t === "string" && t.toUpperCase() === "TXT";

/** A record body in an audit event: the TXT rule on its content, wherever the body nests it. */
function txtBodies(r: Redactor, v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => txtBodies(r, x));
  if (!v || typeof v !== "object") return v;
  const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, txtBodies(r, x)])) as Record<string, unknown>;
  if (isTxt(o.type) && typeof o.content === "string") o.content = txtValue(r, o.content);
  return o;
}

/** json() keeps keys and treats a value under a secret-naming key as a secret; text() over the serialisation is what the Store's value() pass sees. */
const redJson = (r: Redactor, v: object): string => r.text(JSON.stringify(txtBodies(r, strings(r.json(strings(v, unwild)), rewild))));

export interface RecordContext { tenantId: string; runId: string; observedAt: string }

/**
 * One record as one dns_record row; undefined when the record lacks an id, name, type or content. The
 * columns rows.ts REDACT names go through the redactor as the Store reads them (zone and name as text,
 * content as a value, a TXT's per tag); the record id and type are Cloudflare's own vocabulary and stay.
 */
export function dnsRecordRow(r: Redactor, rec: CfRecord, zone: string, ctx: RecordContext): DnsRecord | undefined {
  if (!rec?.id || !rec.name || !rec.type || typeof rec.content !== "string") return undefined;
  return {
    record_id: rec.id,
    run_id: ctx.runId,
    tenant_id: ctx.tenantId,
    zone: redText(r, zone),
    name: redText(r, rec.name),
    type: rec.type,
    content: isTxt(rec.type) ? txtValue(r, rec.content) : redValue(r, rec.content),
    ttl: typeof rec.ttl === "number" && Number.isInteger(rec.ttl) ? rec.ttl : null,
    proxied: proxiedFlag(rec.proxied),
    observed_at: ctx.observedAt,
  };
}

/** The fields of a record that become observation rows, in this order. */
export const RECORD_FIELDS = ["type", "name", "content", "ttl", "proxied"] as const;
export type RecordField = (typeof RECORD_FIELDS)[number];

const intText = (n: number | null): string | null => (n === null ? null : String(n));

/**
 * One record as five observation rows of its DNS run, in RECORD_FIELDS order, from the raw record and
 * the row dnsRecordRow made of it. value_hash is the fingerprint of the value as the API sent it (the
 * Linux collector's rule for a non-file setting); value_redacted is the row's redacted column, so a TXT
 * is redacted tag by tag; ttl and proxied are the row's integers as text, null when absent.
 */
export function dnsObservationRows(r: Redactor, rec: CfRecord, row: DnsRecord): Observation[] {
  const sent: Record<RecordField, string> = { type: rec.type, name: rec.name, content: rec.content, ttl: intText(row.ttl) ?? "", proxied: intText(row.proxied) ?? "" };
  const shown: Record<RecordField, string | null> = { type: row.type, name: row.name, content: row.content, ttl: intText(row.ttl), proxied: intText(row.proxied) };
  const refers = row.type === "A" || row.type === "AAAA" ? "ip" : row.type === "CNAME" ? "dns_name" : null;
  return RECORD_FIELDS.map((field) => ({
    obs_id: obsId(row.run_id, row.record_id, field), run_id: row.run_id, tenant_id: row.tenant_id, surface: "cloudflare.dns", host: null,
    object_id: row.record_id, setting_path: field, value_hash: r.fingerprint(sent[field]), value_redacted: shown[field],
    refers_to_type: field === "content" ? refers : null, refers_to_id: field === "content" && refers ? row.content : null,
    observed_at: row.observed_at, source: "cloudflare", authority: AUTHORITY.live,
  }));
}

const nonEmpty = (v: unknown): object | undefined =>
  v && typeof v === "object" && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0) ? v : undefined;

/** The record an event is about: value.id on a product dns / type record event, resource.id otherwise. */
export function resourceIdOf(res: CfAuditRow["resource"]): string | null {
  const v = res?.value as { id?: unknown } | undefined;
  if (res?.product === "dns" && res.type === "record" && typeof v?.id === "string" && v.id) return v.id;
  return typeof res?.id === "string" && res.id ? res.id : null;
}

/**
 * One audit row as one audit_event row; undefined when it lacks an id, an action type or a parseable
 * time. actor is the pseudonym of actor.email, null when the row names no email (system rows, API
 * tokens). A delete's resource.value is the record that was removed, so it goes to old_value; on every
 * other action the request body, else resource.value, is new_value. Bodies go through json() (a value
 * under a secret-naming key is a secret) and then text() over the serialisation, which is what the
 * Store's value() pass sees, so it changes nothing. action and resource_type are Cloudflare's enums
 * and stay: text() would read logs/explorer.datasets as a host.
 */
export function auditEventRow(r: Redactor, ev: CfAuditRow, tenantId: string): AuditEvent | undefined {
  const time = typeof ev?.action?.time === "string" ? isoMs(ev.action.time) : undefined;
  if (!ev?.id || !ev.action?.type || !time) return undefined;
  const res = ev.resource ?? {};
  const json = (v: object | undefined): string | null => (v === undefined ? null : redJson(r, v));
  const isDelete = ev.action.type === "delete";
  const kind = `${res.product ?? ""}/${res.type ?? ""}`;
  const rid = resourceIdOf(res);
  return {
    event_id: eventId(tenantId, "cloudflare", ev.id),
    tenant_id: tenantId,
    source: "cloudflare",
    actor: ev.actor?.email ? redText(r, ev.actor.email) : null,
    action: ev.action.type,
    resource_type: kind === "/" ? null : kind,
    resource_id: rid === null ? null : redText(r, rid),
    old_value: isDelete ? json(nonEmpty(res.value)) : null,
    new_value: isDelete ? null : json(nonEmpty(res.request) ?? nonEmpty(res.value)),
    occurred_at: time,
  };
}

/** Redacted zone of an audit row: zone.name, else the record's zone_name; null for account-level rows. */
export function auditZoneOf(r: Redactor, ev: CfAuditRow): string | null {
  const z = ev.zone?.name || (ev.resource?.value as { zone_name?: unknown } | undefined)?.zone_name;
  return typeof z === "string" && z ? redText(r, z) : null;
}

const STATEFUL = new Set(["create", "update"]);

/**
 * The reconstruction rule: a record's state just before `before` is the body of the latest earlier
 * create or update event on its id. Events at or after `before`, deletes, views and other ids are
 * ignored; ties on time go to the larger event_id so the answer is total. The returned event's
 * new_value is null when that event carried no body: the previous state is then unknown, not older.
 */
export function previousState(events: readonly AuditEvent[], resourceId: string, before: string): AuditEvent | undefined {
  const cut = isoMs(before) ?? before;
  let best: AuditEvent | undefined;
  for (const e of events) {
    if (e.resource_id !== resourceId || !STATEFUL.has(e.action) || !(e.occurred_at < cut)) continue;
    if (!best || e.occurred_at > best.occurred_at || (e.occurred_at === best.occurred_at && e.event_id > best.event_id)) best = e;
  }
  return best;
}

export interface ZoneTally { zone: string; expected: number; observed: number }

/** One zone's records as the API returned them, with the zone's real name (src/vault/hook.ts RawZone has this shape). */
export interface CfRawZone { zoneId: string; zone: string; records: CfRecord[] }

export interface CloudflareCollection {
  dnsRun: CollectionRun;
  auditRun: CollectionRun;
  records: DnsRecord[];
  /** Five per record (dnsObservationRows), in record order, all of the DNS run. */
  observations: Observation[];
  /** Raw: real zone names, names and contents, read by the vault alone (scripts/collect-cloudflare.ts hands it to the hook). */
  rawRecords: CfRawZone[];
  events: AuditEvent[];
  /** Per zone, redacted: records the API reported before collecting, and rows that normalised. */
  zones: ZoneTally[];
  /** Redacted zone per event_id; the schema has no column for it, the dry run tallies by it. */
  eventZone: Map<string, string | null>;
  window: AuditWindow;
  /** Redacted, one per failure; a run with any is partial or failed. */
  errors: string[];
}

export interface CollectOptions { tenantId: string; since?: string; now?: () => Date }

function newRun(tenantId: string, surface: string, startedAt: string): CollectionRun {
  return {
    run_id: runId(tenantId, surface, null, startedAt), tenant_id: tenantId, surface, host: null,
    started_at: startedAt, finished_at: null, expected_count: null, observed_count: null, status: "failed",
  };
}

const settle = (run: CollectionRun, observed: number, failed: boolean, at: string): void => {
  run.observed_count = observed;
  run.finished_at = at;
  run.status = failed ? (observed > 0 ? "partial" : "failed") : observed === run.expected_count ? "complete" : "partial";
};

/**
 * One pass over both surfaces. DNS: zones, then every zone's count, then every zone's rows, so the
 * population is asserted before any row arrives. Audit: every account the zones belong to, over the
 * clamped window. A failure is recorded on its run and the pass goes on; nothing here writes.
 */
export async function collectCloudflare(cf: Cloudflare, r: Redactor, opts: CollectOptions): Promise<CloudflareCollection> {
  const now = opts.now ?? (() => new Date());
  const errors: string[] = [];
  const fail = (where: string, e: unknown) => errors.push(redText(r, redact(`${where}: ${(e as Error).message}`)));
  const t0 = now();
  const window = auditWindow(t0, opts.since);

  const dnsRun = newRun(opts.tenantId, "cloudflare.dns", t0.toISOString());
  const records: DnsRecord[] = [];
  const observations: Observation[] = [];
  const rawRecords: CfRawZone[] = [];
  const zones: ZoneTally[] = [];
  let cfZones: CfZone[] = [];
  let dnsFailed = false;
  try {
    cfZones = await cf.listZones();
    const counts: number[] = [];
    for (const z of cfZones) counts.push(await cf.countRecords(z.id));
    dnsRun.expected_count = counts.reduce((a, b) => a + b, 0);
    const ctx = { tenantId: opts.tenantId, runId: dnsRun.run_id, observedAt: dnsRun.started_at };
    for (const [i, z] of cfZones.entries()) {
      const tally: ZoneTally = { zone: redText(r, z.name), expected: counts[i], observed: 0 };
      zones.push(tally);
      const listed = await cf.listRecords(z.id);
      rawRecords.push({ zoneId: z.id, zone: z.name, records: listed });
      for (const rec of listed) {
        const row = dnsRecordRow(r, rec, z.name, ctx);
        if (row) { records.push(row); observations.push(...dnsObservationRows(r, rec, row)); tally.observed++; }
      }
    }
  } catch (e) {
    dnsFailed = true;
    fail("cloudflare.dns", e);
  }
  settle(dnsRun, records.length, dnsFailed, now().toISOString());

  const auditRun = newRun(opts.tenantId, "cloudflare.audit", now().toISOString());
  const byId = new Map<string, AuditEvent>();
  const eventZone = new Map<string, string | null>();
  let auditFailed = false;
  const accounts = [...new Set(cfZones.map((z) => z.account?.id).filter((a): a is string => !!a))].sort();
  if (!accounts.length) {
    auditFailed = true;
    errors.push("cloudflare.audit: no account visible through the zones");
  }
  for (const acct of accounts) {
    try {
      const { rows, reported } = await cf.listAuditLog(acct, window.since, window.before);
      auditRun.expected_count = (auditRun.expected_count ?? 0) + reported;
      for (const ev of rows) {
        const row = auditEventRow(r, ev, opts.tenantId);
        if (!row || byId.has(row.event_id)) continue;
        byId.set(row.event_id, row);
        eventZone.set(row.event_id, auditZoneOf(r, ev));
      }
    } catch (e) {
      auditFailed = true;
      fail("cloudflare.audit", e);
    }
  }
  const events = [...byId.values()].sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.event_id < b.event_id ? -1 : 1));
  settle(auditRun, events.length, auditFailed, now().toISOString());

  return { dnsRun, auditRun, records, observations, rawRecords, events, zones, eventZone, window, errors };
}
