// The probe's pure core: what each served name is expected to do when it is asked from outside, and
// the ok/fail rule per probe kind. Pure functions over values; src/probe/run.ts does the asking.
//
// Contract:
//   - The population is the account's A, AAAA and CNAME records as the Cloudflare API returns them,
//     real names and contents (they go on the wire). A target is one distinct name; wildcard names are
//     left out of the targets. Names are lower-cased with a trailing dot dropped, addresses normalised
//     (IPv6 to its compressed form) before any comparison.
//   - The edge a name answers from (http's cf-ray): a proxied record answers at Cloudflare's edge
//     ("present"); a direct A or AAAA record answers at its origin ("absent"); a direct CNAME takes its
//     target's flag when the target is a record of the collected zones, followed one level (a direct
//     CNAME target is a longer chain and gives "any"); a target outside the zones, a record without a
//     proxied flag, or records of one name that disagree give "any".
//   - The addresses a name must and must not resolve to (dns): a direct A or AAAA record's content is
//     in every resolver's answer; a proxied record's content is in none (the origin stays hidden); a
//     CNAME carries its target's address records one level, a proxied CNAME hiding them all. Every
//     resolver must also answer with at least one address, so a name that resolves nowhere fails
//     whatever its flags say.
//   - The ok rules: http answers with a status below 500 and its cf-ray header matches the edge
//     ("any" takes either); dns holds the address expectation on both resolvers; tls is authorized for
//     the name with more than 7 whole days left. An unreachable name fails every kind.
//   - The strings stored in probe.expected and probe.observed are built here from real values and a
//     redaction function the caller supplies (src/probe/run.ts passes Redactor.text); the caller
//     redacts the whole string once more before it is stored or printed.
//
// Measured 24 Oct 2026 on the operator's account (PROBE_LIVE=true, test/probe.test.ts): 37 targets after
// wildcards, so a full run asserts expected_count 111.

import type { ProbeKind } from "../data/rows.ts";

export const PROBE_KINDS = ["http", "dns", "tls"] as const satisfies readonly ProbeKind[];
/** The record types whose names are probed. */
export const PROBED_TYPES: ReadonlySet<string> = new Set(["A", "AAAA", "CNAME"]);
const ADDRESS: ReadonlySet<string> = new Set(["A", "AAAA"]);

/** The two public resolvers every dns probe asks, by the label the observed string carries. */
export const RESOLVERS = [
  { label: "r1", server: "1.1.1.1" },
  { label: "r2", server: "8.8.8.8" },
] as const;

/** Per http request, per tls handshake, and the outer bound on one dns probe. */
export const PROBE_TIMEOUT_MS = 10_000;
/** tls is ok with more than this many whole days left on the certificate. */
export const MIN_TLS_DAYS = 7;
export const PROBE_CONCURRENCY = 4;
/** http answers when its status is below this. */
export const HTTP_FAIL_STATUS = 500;

/** One record of the population, real values: name and content go on the wire; rows carry their pseudonyms. */
export interface PopulationRecord {
  name: string;
  type: string;
  content: string;
  proxied: number | null;
}

/** Whether a name's http answer carries cf-ray. */
export type Edge = "present" | "absent" | "any";

/** Normalised real addresses, sorted: every resolver's answer holds each of `contain` and none of `omit`. */
export interface DnsExpectation {
  contain: string[];
  omit: string[];
}

/** One distinct name to probe, with what its records say it should do. `name` is real. */
export interface ProbeTarget {
  name: string;
  edge: Edge;
  dns: DnsExpectation;
}

export const normName = (s: string): string => s.trim().toLowerCase().replace(/\.$/, "");
export const isWildcard = (name: string): boolean => name.includes("*");

/** An address as resolvers return it: IPv4 as is, IPv6 lower-cased and compressed (RFC 5952, through the URL parser). */
export function normAddress(s: string): string {
  const t = s.trim().toLowerCase();
  if (!t.includes(":")) return t;
  try {
    return new URL(`http://[${t}]/`).hostname.slice(1, -1);
  } catch {
    return t;
  }
}

const combine = (edges: readonly Edge[]): Edge => (edges.length > 0 && edges.every((e) => e === edges[0]) ? edges[0] : "any");

type ByName = ReadonlyMap<string, readonly PopulationRecord[]>;

/** The edge one record answers from. */
export function recordEdge(r: PopulationRecord, byName: ByName): Edge {
  if (r.proxied === 1) return "present";
  if (r.proxied !== 0) return "any";
  if (ADDRESS.has(r.type)) return "absent";
  const target = byName.get(normName(r.content)) ?? [];
  return combine(target.map((t) => (t.proxied === 1 ? "present" : t.proxied === 0 && ADDRESS.has(t.type) ? "absent" : "any")));
}

/** The addresses one record puts in, or keeps out of, every resolver's answer. */
export function recordAddresses(r: PopulationRecord, byName: ByName): DnsExpectation {
  if (ADDRESS.has(r.type)) {
    const a = normAddress(r.content);
    return r.proxied === 1 ? { contain: [], omit: [a] } : r.proxied === 0 ? { contain: [a], omit: [] } : { contain: [], omit: [] };
  }
  const targets = (byName.get(normName(r.content)) ?? []).filter((t) => ADDRESS.has(t.type));
  if (r.proxied === 1) return { contain: [], omit: targets.map((t) => normAddress(t.content)) };
  if (r.proxied !== 0) return { contain: [], omit: [] };
  return {
    contain: targets.filter((t) => t.proxied === 0).map((t) => normAddress(t.content)),
    omit: targets.filter((t) => t.proxied === 1).map((t) => normAddress(t.content)),
  };
}

const uniqSorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/** The population as targets: one per distinct non-wildcard name of an A, AAAA or CNAME record, in name order. */
export function buildTargets(records: readonly PopulationRecord[]): ProbeTarget[] {
  const byName = new Map<string, PopulationRecord[]>();
  for (const raw of records) {
    const type = raw.type.toUpperCase();
    if (!PROBED_TYPES.has(type)) continue;
    const r = { ...raw, type, name: normName(raw.name) };
    byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
  }
  return [...byName.keys()].filter((n) => !isWildcard(n)).sort().map((name) => {
    const own = byName.get(name)!;
    const dns = own.map((r) => recordAddresses(r, byName));
    return {
      name,
      edge: combine(own.map((r) => recordEdge(r, byName))),
      dns: { contain: uniqSorted(dns.flatMap((d) => d.contain)), omit: uniqSorted(dns.flatMap((d) => d.omit)) },
    };
  });
}

// ---- observations and the ok rule per kind ---------------------------------------------------------------

export type HttpObservation =
  | { kind: "answer"; status: number; server: string | null; cfRay: boolean }
  | { kind: "unreachable"; code: string };

/** One resolver's A and AAAA answer for a name (normalised, sorted), or the error code it gave. */
export type ResolverAnswer = { addresses: string[] } | { error: string };

export type TlsObservation =
  | { kind: "peer"; authorized: boolean; issuer: string; validTo: string }
  | { kind: "unreachable"; code: string };

export function httpOk(edge: Edge, o: HttpObservation): boolean {
  return o.kind === "answer" && o.status < HTTP_FAIL_STATUS && (edge === "any" || (edge === "present") === o.cfRay);
}

export function dnsOk(e: DnsExpectation, answers: readonly ResolverAnswer[]): boolean {
  return answers.length === RESOLVERS.length && answers.every((a) =>
    "addresses" in a && a.addresses.length > 0
    && e.contain.every((x) => a.addresses.includes(x))
    && !e.omit.some((x) => a.addresses.includes(x)));
}

/** Whole days from `now` to the certificate's notAfter; null when the date does not parse. */
export function tlsDaysLeft(validTo: string, now: Date): number | null {
  const t = Date.parse(validTo);
  return Number.isNaN(t) ? null : Math.floor((t - now.getTime()) / 86_400_000);
}

export function tlsOk(o: TlsObservation, now: Date): boolean {
  if (o.kind !== "peer" || !o.authorized) return false;
  const days = tlsDaysLeft(o.validTo, now);
  return days !== null && days > MIN_TLS_DAYS;
}

// ---- the strings a probe row stores ----------------------------------------------------------------------

type Red = (s: string) => string;
const list = (xs: readonly string[], red: Red): string => xs.map(red).sort().join(", ");

export const httpExpected = (edge: Edge): string => `answers (status below ${HTTP_FAIL_STATUS}); cf-ray ${edge}`;

export function httpObserved(o: HttpObservation, red: Red): string {
  if (o.kind === "unreachable") return `unreachable: ${o.code}`;
  return `status ${o.status} server=${o.server ? red(o.server) : "-"} cf-ray ${o.cfRay ? "present" : "absent"}`;
}

export function dnsExpected(e: DnsExpectation, red: Red): string {
  const parts = ["each resolver answers with an address"];
  if (e.contain.length) parts.push(`contains ${list(e.contain, red)}`);
  if (e.omit.length) parts.push(`omits ${list(e.omit, red)} (proxied: the origin stays hidden)`);
  return parts.join("; ");
}

export function dnsObserved(answers: readonly ResolverAnswer[], red: Red): string {
  return RESOLVERS.map((r, i) => {
    const a = answers[i];
    if (!a) return `${r.label} error unasked`;
    return "error" in a ? `${r.label} error ${a.error}` : `${r.label} [${list(a.addresses, red)}]`;
  }).join("; ");
}

export const TLS_EXPECTED = `valid for the name, more than ${MIN_TLS_DAYS} days left`;

export function tlsObserved(o: TlsObservation, now: Date, red: Red): string {
  if (o.kind === "unreachable") return `unreachable: ${o.code}`;
  const t = Date.parse(o.validTo);
  const days = tlsDaysLeft(o.validTo, now);
  return `issuer=${o.issuer ? red(o.issuer) : "-"} expires=${Number.isNaN(t) ? "unknown" : new Date(t).toISOString()} days=${days ?? "unknown"} authorized=${o.authorized ? "yes" : "no"}`;
}

const CODE = /^[A-Za-z][A-Za-z0-9_]{1,47}$/;
const GENERIC = new Set(["Error", "TypeError", "AggregateError", "RangeError", "SyntaxError", "DOMException"]);

/**
 * The short code an error carries, for "unreachable: <code>": the first string `code` on the error, its
 * cause or the errors of an AggregateError (ENOTFOUND, ECONNREFUSED, CERT_HAS_EXPIRED,
 * UND_ERR_CONNECT_TIMEOUT), else a specific error name (TimeoutError, AbortError), else "unknown". Only
 * codes and names are read; a message, which can carry a name, stays out of the row.
 */
export function errorCode(e: unknown): string {
  const queue: unknown[] = [e];
  const names: string[] = [];
  for (let i = 0; i < queue.length && i < 8; i++) {
    const x = queue[i] as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown } | null | undefined;
    if (!x || typeof x !== "object") continue;
    if (typeof x.code === "string" && CODE.test(x.code)) return x.code;
    if (typeof x.name === "string" && CODE.test(x.name) && !GENERIC.has(x.name)) names.push(x.name);
    if (x.cause !== undefined) queue.push(x.cause);
    if (Array.isArray(x.errors)) queue.push(...x.errors.slice(0, 2));
  }
  return names[0] ?? "unknown";
}
