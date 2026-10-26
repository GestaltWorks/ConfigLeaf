// Microsoft 365 collector: the DNS records Microsoft 365 requires for mail on each verified domain of the tenant,
// read from Microsoft Graph with client credentials, as the observation rows of one m365.dns collection run
// (src/data/rows.ts). Read only: one token request and GETs. The pass compares these rows with the records the
// Cloudflare collector stored (src/m365.ts, MAIL_RECORDS_SQL): one setting, mail routing, split across two systems.
//
// API, Microsoft Graph v1.0 in its documented shapes (test/fixtures/m365 follows them):
//   POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token   form: client_id, client_secret,
//     scope=https://graph.microsoft.com/.default, grant_type=client_credentials -> {token_type, expires_in,
//     access_token}. A refusal answers {error, error_description, error_codes}; only error and the AADSTS code
//     reach the message, never the description, the secret or the token.
//   GET /v1.0/domains                                        {value: domain[], @odata.nextLink?}
//   GET /v1.0/domains/{id}/serviceConfigurationRecords       {value: domainDnsRecord[], @odata.nextLink?}
//     a record carries label, recordType (Mx | Txt | CName | Srv | Unavailable), supportedService, isOptional, ttl and,
//     by type, mailExchange and preference (Mx), text (Txt), canonicalName (CName), or the SRV fields. Measured live 26
//     Oct 2026: every CName carries canonicalName; nameTarget belongs to Srv alone, which this surface does not keep.
//   A nextLink is followed only under the Graph base the client was given, so the token is sent nowhere else.
//
// Scope: the verified domains outside onmicrosoft.com (an initial domain's DNS is Microsoft's own, not the
// client's zone), and of each the records of supportedService Email that Cloudflare serves as MX, TXT or CNAME: the
// MX, the SPF TXT, the autodiscover CNAME, and a DKIM selector CNAME were Graph to list one: measured 26 Oct 2026 on the
// operator's tenant, it lists none (Exchange Online keeps DKIM, not Graph's domain records). Records of the other
// services (Skype for Business, Intune) and SRV records are counted and not kept. Graph asserts no total, so the
// run's expected_count is the Email records it listed for the domains in scope (the Cloudflare audit run's rule)
// and observed_count the records that normalised: one that does not (no label, no value, an Email TXT that is no
// SPF record) leaves the run partial, and the DQ gate keeps it out of the pass.
//
// Each kept record becomes four observation rows of the run (surface m365.dns, host null, source m365, authority
// live), object_id <domain>/<TYPE>/<label>: the domain's pseudonym, MX | TXT | CNAME, and the record's name
// relative to the domain ("@" for the apex, "autodiscover", "selector1._domainkey"):
//   domain   the domain's pseudonym; a domain that is a Cloudflare zone apex carries the zone's
//   type     MX | TXT | CNAME, Cloudflare's vocabulary
//   name     the record's name, refers_to dns_name: the pseudonym dns_record.name carries for it
//   content  MX: the mail exchange, CNAME: the target, both refers_to dns_name; TXT: what Microsoft 365 requires of
//            the SPF record, the mechanisms of its text other than v=spf1 and the all term
//            (include:spf.protection.outlook.com), redacted tag by tag as Cloudflare's TXT content is
// value_hash is Redactor.fingerprint of the field as Graph sent it (names lower-cased, a trailing dot dropped; a
// TXT's content the whole text). value_redacted goes through the Redactor calls the Cloudflare collector makes for
// the same field, under the same salt, so the name Microsoft 365 requires and the name Cloudflare serves carry one
// pseudonym, and a DKIM target reads the same on both sides (redactor.ts pass d).
//
// Before anything leaves, every row and every error is probed for the tenant's own names (tenantNames). One
// survivor and the run fails with no row kept; callers say how many, never which.

import { config, redact } from "../config.ts";
import { AUTHORITY, obsId, runId, type CollectionRun, type Observation } from "../data/rows.ts";
import { countLabels, type Redactor } from "../redactor.ts";
import { txtValue } from "./cloudflare.ts";

export const LOGIN = "https://login.microsoftonline.com";
export const GRAPH = "https://graph.microsoft.com/v1.0";
export const SCOPE = "https://graph.microsoft.com/.default";
/** The collection surface the rows and the run carry. */
export const M365_SURFACE = "m365.dns";
/** The four rows of one kept record, in this order. */
export const MAIL_FIELDS = ["domain", "type", "name", "content"] as const;
const MAX_PAGES = 100;
/** The shortest client id or secret the client sends (a GUID is 36 characters, a secret about 40): shorter is a cut paste, and too short to scrub. */
export const MIN_CREDENTIAL = 8;
/** A tenant as the token endpoint takes it: a GUID or a domain name. */
const TENANT_REF = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GraphDomain { id: string; isVerified?: boolean; isInitial?: boolean; isDefault?: boolean; supportedServices?: string[] }
export interface GraphDnsRecord {
  "@odata.type"?: string; id?: string; isOptional?: boolean; label?: string; recordType?: string; supportedService?: string; ttl?: number;
  mailExchange?: string; preference?: number; text?: string; canonicalName?: string;
}
interface Page<T> { value?: T[]; "@odata.nextLink"?: unknown }

export class M365Error extends Error {
  constructor(message: string, readonly status: number) { super(redact(message)); }
}

export interface GraphOptions { tenantId?: string; clientId?: string; clientSecret?: string; fetch?: FetchLike; loginUrl?: string; graphUrl?: string; now?: () => number }

/** Microsoft Graph, read only, client credentials. The secret and the token live in private fields and leave only in the request that needs them. */
export class Graph {
  readonly #tenant: string;
  readonly #client: string;
  readonly #secret: string;
  readonly #fetch: FetchLike;
  readonly #login: string;
  readonly #base: string;
  readonly #now: () => number;
  #token: { value: string; until: number } | null = null;
  /** Every request made, as method and path template: never a domain name, a tenant id, a form body or a token. */
  readonly requests: string[] = [];

  constructor(opts: GraphOptions = {}) {
    this.#tenant = (opts.tenantId ?? config.m365.tenantId).trim();
    this.#client = (opts.clientId ?? config.m365.clientId).trim();
    this.#secret = opts.clientSecret ?? config.m365.clientSecret;
    this.#fetch = opts.fetch ?? ((u, i) => fetch(u, i));
    this.#login = (opts.loginUrl ?? LOGIN).replace(/\/+$/, "");
    this.#base = (opts.graphUrl ?? GRAPH).replace(/\/+$/, "");
    this.#now = opts.now ?? Date.now;
  }

  /**
   * The configured tenant id, client id and secret replaced in a message before it is built into an error, case aside
   * and URL-encoded forms included: the token URL carries the tenant id, and a failed request's message may carry the URL.
   */
  scrub(s: string): string {
    return scrubIds(s, [[this.#secret, "<secret>"], [this.#client, "<client>"], [this.#tenant, "<tenant>"]]);
  }

  /** One request; a request that throws (network, timeout) becomes an M365Error with the ids scrubbed from its message. */
  private async send(url: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await this.#fetch(url, init);
    } catch (e) {
      const cause = (e as { cause?: { message?: unknown } })?.cause?.message;
      throw new M365Error(this.scrub(`${what} failed: ${(e as Error)?.message ?? String(e)}${typeof cause === "string" ? ` (${cause})` : ""}`), 0);
    }
  }

  private async token(): Promise<string> {
    if (this.#token && this.#token.until > this.#now() + 60_000) return this.#token.value;
    if (!this.#tenant || !this.#client || !this.#secret) throw new M365Error("M365_TENANT_ID, M365_CLIENT_ID and M365_CLIENT_SECRET must all be set", 0);
    if (!TENANT_REF.test(this.#tenant)) throw new M365Error("M365_TENANT_ID must be the tenant's id or one of its domain names", 0);
    if (this.#tenant.length < 4 || [this.#client, this.#secret].some((v) => v.length < MIN_CREDENTIAL)) {
      throw new M365Error(`M365_CLIENT_ID and M365_CLIENT_SECRET are each ${MIN_CREDENTIAL} characters or more and M365_TENANT_ID 4 or more; one is shorter, so it looks cut`, 0);
    }
    this.requests.push("POST /{tenant}/oauth2/v2.0/token");
    const form = new URLSearchParams({ client_id: this.#client, client_secret: this.#secret, scope: SCOPE, grant_type: "client_credentials" });
    const r = await this.send(`${this.#login}/${encodeURIComponent(this.#tenant)}/oauth2/v2.0/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form.toString(), signal: AbortSignal.timeout(30_000),
    }, "M365 token request");
    let j: { access_token?: unknown; expires_in?: unknown; error?: unknown; error_codes?: unknown } | undefined;
    try { j = JSON.parse(await r.text()); } catch { /* not JSON; reported below */ }
    if (!r.ok || typeof j?.access_token !== "string" || !j.access_token) {
      const err = typeof j?.error === "string" && /^[a-z_]{1,64}$/.test(j.error) ? j.error : "no token in the answer";
      const code = Array.isArray(j?.error_codes) && Number.isInteger(j.error_codes[0]) ? ` (AADSTS${j.error_codes[0]})` : "";
      throw new M365Error(`M365 token ${r.status}: ${err}${code}`, r.status);
    }
    const seconds = Number(j.expires_in);
    this.#token = { value: j.access_token, until: this.#now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000 };
    return this.#token.value;
  }

  private async get<T>(url: string, shown: string): Promise<T> {
    const token = await this.token();
    this.requests.push(`GET ${shown}`);
    const r = await this.send(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) }, `Graph GET ${shown}`);
    let j: unknown;
    try { j = JSON.parse(await r.text()); } catch { /* not JSON; reported below */ }
    if (!r.ok) {
      const e = (j as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
      const why = [typeof e?.code === "string" ? e.code.slice(0, 80) : "", typeof e?.message === "string" ? e.message.slice(0, 200) : ""].filter(Boolean).join(": ");
      throw new M365Error(this.scrub(`Graph ${r.status} GET ${shown}: ${why || "no error body"}`), r.status);
    }
    if (!j || typeof j !== "object") throw new M365Error(`Graph ${r.status} GET ${shown}: the answer is not a JSON object`, r.status);
    return j as T;
  }

  /** Every item of a collection, following @odata.nextLink under the Graph base only. */
  private async list<T>(path: string, shown: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | undefined = this.#base + path;
    for (let page = 1; url; page++) {
      if (page > MAX_PAGES) throw new M365Error(`Graph GET ${shown}: longer than ${MAX_PAGES} pages`, 0);
      const j: Page<T> = await this.get<Page<T>>(url, page === 1 ? shown : `${shown} (page ${page})`);
      if (!Array.isArray(j.value)) throw new M365Error(`Graph GET ${shown}: the answer holds no value array`, 0);
      out.push(...j.value);
      const next = j["@odata.nextLink"];
      if (next !== undefined && next !== null && (typeof next !== "string" || !next.startsWith(`${this.#base}/`))) {
        throw new M365Error(`Graph GET ${shown}: a nextLink outside ${this.#base} is not followed`, 0);
      }
      url = typeof next === "string" ? next : undefined;
    }
    return out;
  }

  listDomains(): Promise<GraphDomain[]> {
    return this.list<GraphDomain>("/domains", "/domains");
  }

  serviceRecords(domainId: string): Promise<GraphDnsRecord[]> {
    return this.list<GraphDnsRecord>(`/domains/${encodeURIComponent(domainId)}/serviceConfigurationRecords`, "/domains/{id}/serviceConfigurationRecords");
  }
}

/**
 * Each value of `pairs` that is 4 characters or longer replaced by its mark in `s`, case aside, raw and URL-encoded, the
 * longest first, so a value inside another (a client id within a tenant string) leaves no fragment of the longer. A
 * shorter value would mangle the text it is scrubbed from; the client refuses credentials that short (MIN_CREDENTIAL).
 */
export function scrubIds(s: string, pairs: readonly (readonly [string, string])[]): string {
  let out = s;
  for (const [v, mark] of [...pairs].sort((a, b) => b[0].length - a[0].length)) {
    if (v.length < 4) continue;
    for (const form of new Set([v, encodeURIComponent(v)])) out = out.replace(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), mark);
  }
  return out;
}

export type MailType = "MX" | "TXT" | "CNAME";
const TYPES: Readonly<Record<string, MailType>> = { mx: "MX", txt: "TXT", cname: "CNAME" };

/** A DNS name as Graph and Cloudflare both mean it: trimmed, lower-cased, without a trailing dot. */
export const dnsName = (s: string): string => s.trim().toLowerCase().replace(/\.$/, "");

/** One record Microsoft 365 requires, raw: the domain, its type, its name, the value as Graph sent it, and what the served record must carry. */
export interface ExpectedRecord { domain: string; type: MailType; label: string; relative: string; value: string; requirement: string }

/** What an SPF record must carry for Microsoft 365: the mechanisms of its text other than v=spf1 and the all term, in order. */
export function spfRequirement(text: string): string {
  return text.split(/\s+/).filter((t) => t !== "" && !/^v=spf1$/i.test(t) && !/^[-~+?]?all$/i.test(t)).join(" ");
}

/** Whether Graph's record is one this surface keeps: a mail record of a type Cloudflare serves as MX, TXT or CNAME. */
export function isMailRecord(rec: GraphDnsRecord): boolean {
  return rec?.supportedService === "Email" && TYPES[String(rec.recordType ?? "").toLowerCase()] !== undefined;
}

/** One mail record as the record Cloudflare must serve; a string saying why when it does not normalise. */
export function expectedRecord(domain: string, rec: GraphDnsRecord): ExpectedRecord | string {
  const type = TYPES[String(rec?.recordType ?? "").toLowerCase()];
  const label = typeof rec?.label === "string" ? dnsName(rec.label) : "";
  if (!type) return "a record of a type this surface does not keep";
  if (!label) return `a ${type} record without a label`;
  const sent = type === "MX" ? rec.mailExchange : type === "CNAME" ? rec.canonicalName : rec.text;
  if (typeof sent !== "string" || !sent.trim()) return `a ${type} record without its value`;
  const value = type === "TXT" ? sent.trim() : dnsName(sent);
  if (type === "TXT" && !/^v=spf1(?:\s|$)/i.test(value)) return "a mail TXT record that is no SPF record (this surface keeps the SPF record alone)";
  const requirement = type === "TXT" ? spfRequirement(value) : value;
  if (!requirement) return "an SPF record that names no mechanism";
  const relative = label === domain ? "@" : label.endsWith(`.${domain}`) ? label.slice(0, -(domain.length + 1)) : label;
  return { domain, type, label, relative, value, requirement };
}

export interface RowContext { tenantId: string; runId: string; observedAt: string }

/** The object id of an expected record: <domain>/<TYPE>/<label>, redacted. */
export const mailObjectId = (r: Redactor, e: ExpectedRecord): string => `${r.text(e.domain)}/${e.type}/${r.text(e.relative)}`;

/** One expected record as its four observation rows, in MAIL_FIELDS order; `objectId` overrides the key when two records share one. */
export function mailObservationRows(r: Redactor, e: ExpectedRecord, ctx: RowContext, objectId = mailObjectId(r, e)): Observation[] {
  const name = r.text(e.label);
  const content = e.type === "TXT" ? txtValue(r, e.requirement) : r.value(e.requirement);
  const refers = e.type === "TXT" ? null : "dns_name";
  const rows: [string, string, string, string | null, string | null][] = [
    ["domain", e.domain, r.text(e.domain), null, null],
    ["type", e.type, e.type, null, null],
    ["name", e.label, name, "dns_name", name],
    ["content", e.value, content, refers, refers ? content : null],
  ];
  return rows.map(([setting, sent, shown, refersType, refersId]) => ({
    obs_id: obsId(ctx.runId, objectId, setting), run_id: ctx.runId, tenant_id: ctx.tenantId, surface: M365_SURFACE, host: null,
    object_id: objectId, setting_path: setting, value_hash: r.fingerprint(sent), value_redacted: shown,
    refers_to_type: refersType, refers_to_id: refersId, observed_at: ctx.observedAt, source: "m365", authority: AUTHORITY.live,
  }));
}

/** Labels of Microsoft's own names: a registrable label equal to one is no tenant name the probe could tell from them. */
const MICROSOFT_WORDS = new Set(["mail", "dkim", "microsoft", "onmicrosoft", "outlook", "protection", "spf", "autodiscover", "domainkey"]);
const SECOND_LEVEL = /^(?:co|com|net|org|gov|edu|ac|or|ne|go|ltd|plc)$/;

/**
 * The tenant's own names, as the leak probe looks for them: every domain Graph listed, its dashed form (the form a
 * DKIM selector and an MX host carry), its registrable label, every label of an onmicrosoft.com domain before the
 * suffix, and the configured tenant id. Lower-cased, three characters or more, sorted.
 */
export function tenantNames(domains: readonly string[], tenantId = ""): string[] {
  const out = new Set<string>();
  for (const raw of domains) {
    const d = dnsName(raw);
    const labels = d.split(".");
    if (labels.length < 2) continue;
    out.add(d);
    out.add(d.replace(/\./g, "-"));
    if (d.endsWith(".onmicrosoft.com")) for (const l of labels.slice(0, -2)) out.add(l);
    else out.add(labels.length >= 3 && SECOND_LEVEL.test(labels.at(-2)!) ? labels.at(-3)! : labels.at(-2)!);
  }
  if (tenantId.trim()) out.add(tenantId.trim().toLowerCase());
  return [...out].filter((w) => w.length >= 3 && !MICROSOFT_WORDS.has(w)).sort();
}

/** How many times the names stand alone (redactor.ts countLabels) in the rows' text columns and the extra text. */
export function survivingNames(rows: readonly Observation[], names: readonly string[], extra: readonly string[] = []): number {
  const text = [...rows.flatMap((o) => [o.object_id, o.setting_path, o.value_redacted ?? "", o.refers_to_id ?? "", o.host ?? ""]), ...extra].join("\n");
  return Object.values(countLabels(text, names)).reduce((a, b) => a + b, 0);
}

export interface M365Counts {
  /** Domains Graph listed, verified, verified under onmicrosoft.com, and compared (verified, not onmicrosoft.com). */
  domains: number; verified: number; initial: number; inScope: number;
  /** Records Graph listed for the domains in scope; of them mail records kept (the population) and the others. */
  listed: number; mail: number; other: number;
  /** Kept records per type. */
  byType: Record<MailType, number>;
}

export interface M365Collection {
  run: CollectionRun;
  /** Four per kept record (mailObservationRows), in domain order and Graph's record order. */
  observations: Observation[];
  counts: M365Counts;
  /** How many times a tenant name stood alone in the redacted rows or errors; above 0 the run keeps no row. */
  survivors: number;
  /** Redacted, one per failure; a run with any is partial or failed. */
  errors: string[];
}

export interface CollectM365Options {
  tenantId: string;
  now?: () => Date;
  /** The Graph tenant id and the app's client id: scrubbed from every error and probed for in every row; config.m365's when absent. */
  graphTenant?: string;
  graphClient?: string;
}

/**
 * One pass: the domains, then each domain in scope's records, normalised and redacted, then the leak probe. A
 * failure is recorded on the run and the pass goes on to the next domain; nothing here writes.
 */
export async function collectM365(g: Graph, r: Redactor, opts: CollectM365Options): Promise<M365Collection> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const run: CollectionRun = {
    run_id: runId(opts.tenantId, M365_SURFACE, null, startedAt), tenant_id: opts.tenantId, surface: M365_SURFACE, host: null,
    started_at: startedAt, finished_at: null, expected_count: null, observed_count: null, status: "failed",
  };
  const errors: string[] = [];
  const graphTenant = (opts.graphTenant ?? config.m365.tenantId).trim();
  const graphClient = (opts.graphClient ?? config.m365.clientId).trim();
  const ids = [[graphTenant, "<tenant>"], [graphClient, "<client>"]] as const;
  const fail = (where: string, e: unknown): void => { errors.push(r.text(redact(scrubIds(`${where}: ${(e as Error)?.message ?? String(e)}`, ids)))); };
  const counts: M365Counts = { domains: 0, verified: 0, initial: 0, inScope: 0, listed: 0, mail: 0, other: 0, byType: { MX: 0, TXT: 0, CNAME: 0 } };
  let observations: Observation[] = [];
  const client = graphClient.length >= 3 ? [graphClient.toLowerCase()] : [];
  let names: string[] = [...tenantNames([], graphTenant), ...client];
  let failed = false;
  try {
    const domains = (await g.listDomains()).filter((d) => typeof d?.id === "string" && d.id.trim() !== "");
    names = [...tenantNames(domains.map((d) => d.id), graphTenant), ...client];
    const verified = domains.filter((d) => d.isVerified === true);
    const scope = verified.filter((d) => !dnsName(d.id).endsWith(".onmicrosoft.com"));
    Object.assign(counts, { domains: domains.length, verified: verified.length, initial: verified.length - scope.length, inScope: scope.length });
    run.expected_count = 0;
    const ctx = { tenantId: opts.tenantId, runId: run.run_id, observedAt: startedAt };
    const keys = new Map<string, number>();
    for (const d of scope) {
      const domain = dnsName(d.id);
      let records: GraphDnsRecord[];
      try {
        records = await g.serviceRecords(d.id);
      } catch (e) {
        failed = true;
        fail(M365_SURFACE, e);
        continue;
      }
      counts.listed += records.length;
      for (const rec of records) {
        if (!isMailRecord(rec)) { counts.other++; continue; }
        counts.mail++;
        run.expected_count++;
        const e = expectedRecord(domain, rec);
        if (typeof e === "string") { errors.push(`${M365_SURFACE}: ${e}`); continue; }
        const key = mailObjectId(r, e);
        const seen = (keys.get(key) ?? 0) + 1;
        keys.set(key, seen);
        observations.push(...mailObservationRows(r, e, ctx, seen === 1 ? key : `${key}#${seen}`));
        counts.byType[e.type]++;
      }
    }
  } catch (e) {
    failed = true;
    fail(M365_SURFACE, e);
  }
  const survivors = survivingNames(observations, names, errors);
  if (survivors > 0) {
    observations = [];
    errors.splice(0, errors.length, `${M365_SURFACE}: ${survivors} tenant name(s) stood alone after redaction; no row is kept`);
    failed = true;
  }
  const observed = observations.length / MAIL_FIELDS.length;
  run.observed_count = observed;
  run.finished_at = now().toISOString();
  run.status = failed ? (observed > 0 ? "partial" : "failed") : observed === run.expected_count ? "complete" : "partial";
  return { run, observations, counts, survivors, errors };
}
