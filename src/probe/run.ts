// The probe run: every served name of one tenant's Cloudflare account asked from outside, once per
// kind (http, dns, tls), as one collection_run of surface "probe" (host null) and one probe row per
// kind per name. What the Decider reads as "production affected": a probe row of the pass with status
// fail whose target is a name the finding's object serves.
//
// Contract:
//   - Population first: the account's A, AAAA and CNAME records read live through the Cloudflare
//     client (src/collectors/cloudflare.ts, read only), wildcard names left out (src/probe/rules.ts).
//     expected_count = kinds x names (3 x names for a full run) is asserted through the sink's beginRun
//     before any probe is sent; a population read that fails gives a failed run with no count.
//   - http: GET https://<name>/ with redirect manual and a 10 s timeout. dns: A and AAAA through each
//     of the two resolvers (RESOLVERS, node:dns Resolver.setServers). tls: a handshake on 443 with the
//     name as SNI, 10 s timeout, the peer certificate read whether or not it verifies. Four probes in
//     flight at most.
//   - Every target, expected and observed string goes through the Redactor before a row exists: the
//     stored target is the name's pseudonym under the tenant's salt, the one the Linux collector's
//     server_name rows and the Cloudflare collector's dns_record names carry. Real names travel only
//     to fetch, the resolvers and the tls connector.
//   - The sink (Store in the script, a fake in the tests; null for a dry run) takes the run, the rows
//     and the finish: observed_count is the rows the sink wrote, status complete when every name has a
//     row of every kind asked and the sink wrote them all, partial otherwise, failed when the
//     population or the write failed. probe_id is stableId("probe", run_id, kind, target).
//   - fetch, the resolver factory, the tls connector and the clock are injectable (ProbeDeps), so the
//     whole run is tested offline; latency_ms and observed_at come from the injected clock.
//
// Measured 24 Oct 2026 (PROBE_LIVE=true, test/probe.test.ts): the population read from the live API
// gave 37 names; one http probe through defaultDeps against the first of them by pseudonym answered ok
// in 359 ms. The full run over the account is the Verify step's.

import dns from "node:dns";
import tls from "node:tls";
import type { CfRecord, CfZone, FetchLike } from "../collectors/cloudflare.ts";
import { proxiedFlag } from "../collectors/cloudflare.ts";
import { probeId, runId, type CollectionRun, type Probe, type ProbeKind } from "../data/rows.ts";
import type { RunStart } from "../data/store.ts";
import { redact } from "../config.ts";
import type { Redactor } from "../redactor.ts";
import {
  PROBED_TYPES, PROBE_CONCURRENCY, PROBE_KINDS, PROBE_TIMEOUT_MS, RESOLVERS, TLS_EXPECTED,
  buildTargets, dnsExpected, dnsObserved, dnsOk, errorCode, httpExpected, httpObserved, httpOk, normAddress, tlsObserved, tlsOk,
  type HttpObservation, type PopulationRecord, type ProbeTarget, type ResolverAnswer, type TlsObservation,
} from "./rules.ts";

export interface DnsResolver {
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
}
/** A resolver that asks exactly these servers. */
export type ResolverFactory = (servers: readonly string[]) => DnsResolver;

/** What a tls handshake shows: whether the chain and the name verified, the issuer (O, else CN), notAfter as the certificate states it. */
export interface TlsPeer {
  authorized: boolean;
  issuer: string;
  valid_to: string;
}
export type TlsConnector = (name: string, timeoutMs: number) => Promise<TlsPeer>;

export interface ProbeDeps {
  fetch: FetchLike;
  resolver: ResolverFactory;
  tls: TlsConnector;
  now: () => Date;
}

/** Where a probe run lands; Store has exactly these three methods. */
export interface ProbeSink {
  beginRun(run: RunStart): Promise<void>;
  insertProbes(rows: readonly Probe[]): Promise<number>;
  finishRun(runId: string, observedCount: number, status: "complete" | "partial" | "failed", finishedAt?: string): Promise<void>;
}

/** The Cloudflare client's two reads the population needs; Cloudflare satisfies it. */
export interface PopulationSource {
  listZones(): Promise<CfZone[]>;
  listRecords(zoneId: string): Promise<CfRecord[]>;
}

export const USER_AGENT = "drift-agent-probe/0.0.1";
const NO_ANSWER = new Set(["ENODATA", "ENOTFOUND"]);

/** node:dns, one Resolver per server list: 5 s per try, 2 tries. */
export const nodeResolver: ResolverFactory = (servers) => {
  const r = new dns.promises.Resolver({ timeout: 5_000, tries: 2 });
  r.setServers([...servers]);
  return { resolve4: (n) => r.resolve4(n), resolve6: (n) => r.resolve6(n) };
};

/** node:tls on 443 with SNI; the certificate is read when it does not verify too, and `authorized` says whether it did (chain and name). */
export const nodeTls: TlsConnector = (name, timeoutMs) => new Promise<TlsPeer>((resolve, reject) => {
  const socket = tls.connect({ host: name, port: 443, servername: name, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] });
  socket.setTimeout(timeoutMs, () => socket.destroy(Object.assign(new Error("tls handshake timed out"), { code: "ETIMEDOUT" })));
  socket.on("error", reject);
  socket.once("secureConnect", () => {
    const cert = socket.getPeerCertificate();
    const issuer = cert?.issuer ? (cert.issuer.O ?? cert.issuer.CN ?? "") : "";
    resolve({ authorized: socket.authorized, issuer: Array.isArray(issuer) ? issuer.join(" ") : String(issuer), valid_to: cert?.valid_to ?? "" });
    socket.setTimeout(0);
    socket.destroy();
  });
});

export const defaultDeps = (): ProbeDeps => ({ fetch: (u, i) => fetch(u, i), resolver: nodeResolver, tls: nodeTls, now: () => new Date() });

/** The account's A, AAAA and CNAME records, every zone the client sees, real values. */
export async function readPopulation(cf: PopulationSource): Promise<PopulationRecord[]> {
  const out: PopulationRecord[] = [];
  for (const z of await cf.listZones()) {
    for (const r of await cf.listRecords(z.id)) {
      if (!r?.name || typeof r.type !== "string" || typeof r.content !== "string" || !PROBED_TYPES.has(r.type.toUpperCase())) continue;
      out.push({ name: r.name, type: r.type.toUpperCase(), content: r.content, proxied: proxiedFlag(r.proxied) });
    }
  }
  return out;
}

/** Settles with `p`, or rejects with code ETIMEDOUT after `ms`; the timer is unref'd, so it holds no process open. */
function deadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("probe deadline"), { code: "ETIMEDOUT" })), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export async function observeHttp(fetchFn: FetchLike, name: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<HttpObservation> {
  try {
    const res = await fetchFn(`https://${name}/`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": USER_AGENT } });
    await res.body?.cancel().catch(() => undefined);
    return { kind: "answer", status: res.status, server: res.headers.get("server"), cfRay: res.headers.has("cf-ray") };
  } catch (e) {
    return { kind: "unreachable", code: errorCode(e) };
  }
}

/** One resolver's answer: A and AAAA together; ENODATA and ENOTFOUND are an empty family, any other error is the resolver's answer. */
export async function observeResolver(r: DnsResolver, name: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ResolverAnswer> {
  const family = async (ask: () => Promise<string[]>): Promise<{ ok: string[] } | { err: string }> => {
    try {
      return { ok: await deadline(ask(), timeoutMs) };
    } catch (e) {
      const code = errorCode(e);
      return NO_ANSWER.has(code) ? { ok: [] } : { err: code };
    }
  };
  const [a, aaaa] = await Promise.all([family(() => r.resolve4(name)), family(() => r.resolve6(name))]);
  if ("err" in a) return { error: a.err };
  if ("err" in aaaa) return { error: aaaa.err };
  return { addresses: [...new Set([...a.ok, ...aaaa.ok].map(normAddress))].sort() };
}

export async function observeTls(connect: TlsConnector, name: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<TlsObservation> {
  try {
    const p = await deadline(connect(name, timeoutMs), timeoutMs + 1_000);
    return { kind: "peer", authorized: p?.authorized === true, issuer: String(p?.issuer ?? ""), validTo: String(p?.valid_to ?? "") };
  } catch (e) {
    return { kind: "unreachable", code: errorCode(e) };
  }
}

export interface ProbeContext {
  runId: string;
  tenantId: string;
  redactor: Redactor;
  deps: ProbeDeps;
  /** One per RESOLVERS entry, in its order. */
  resolvers: readonly DnsResolver[];
  timeoutMs?: number;
}

/** One probe of one kind against one target, as the row it stores: every string redacted, clock from deps. */
export async function probeOne(ctx: ProbeContext, t: ProbeTarget, kind: ProbeKind): Promise<Probe> {
  const red = (s: string): string => ctx.redactor.text(s);
  const timeout = ctx.timeoutMs ?? PROBE_TIMEOUT_MS;
  const t0 = ctx.deps.now();
  let expected: string;
  let observed: string;
  let ok: boolean;
  if (kind === "http") {
    const o = await observeHttp(ctx.deps.fetch, t.name, timeout);
    expected = httpExpected(t.edge);
    observed = httpObserved(o, red);
    ok = httpOk(t.edge, o);
  } else if (kind === "dns") {
    const answers = await Promise.all(ctx.resolvers.map((r) => observeResolver(r, t.name, timeout)));
    expected = dnsExpected(t.dns, red);
    observed = dnsObserved(answers, red);
    ok = dnsOk(t.dns, answers);
  } else {
    const o = await observeTls(ctx.deps.tls, t.name, timeout);
    const at = ctx.deps.now();
    expected = TLS_EXPECTED;
    observed = tlsObserved(o, at, red);
    ok = tlsOk(o, at);
  }
  const t1 = ctx.deps.now();
  const target = red(t.name);
  return {
    probe_id: probeId(ctx.runId, kind, target), run_id: ctx.runId, tenant_id: ctx.tenantId, kind, target,
    expected: red(expected), observed: red(observed), status: ok ? "ok" : "fail",
    latency_ms: Math.max(0, Math.round(t1.getTime() - t0.getTime())), observed_at: t1.toISOString(),
  };
}

/** `fn` over `items` with at most `n` in flight; results in input order. */
export async function pool<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

export interface ProbeRunOptions {
  tenantId: string;
  /** The population read: readPopulation over the live client in the script, fixtures in the tests. */
  population: () => Promise<readonly PopulationRecord[]>;
  redactor: Redactor;
  deps?: Partial<ProbeDeps>;
  /** Default every kind; --only narrows it, and expected_count with it. */
  kinds?: readonly ProbeKind[];
  /** null or absent: a dry run, nothing written. */
  sink?: ProbeSink | null;
  concurrency?: number;
  timeoutMs?: number;
}

export interface ProbeRunResult {
  /** The run as finished: counts, status, finished_at. */
  run: CollectionRun;
  /** Every row the probes produced, in target then kind order. */
  rows: Probe[];
  /** Rows the sink wrote; 0 in a dry run. */
  written: number;
  /** Distinct names probed (the population after wildcards). */
  names: number;
  /** Redacted, one per failure of the population read, a probe or the write. */
  errors: string[];
}

const KIND_ORDER: Record<ProbeKind, number> = { http: 0, dns: 1, tls: 2 };
const byTargetKind = (a: Probe, b: Probe): number => (a.target < b.target ? -1 : a.target > b.target ? 1 : KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

const runStart = (r: CollectionRun): RunStart => ({ run_id: r.run_id, tenant_id: r.tenant_id, surface: r.surface, host: r.host, started_at: r.started_at, expected_count: r.expected_count });

/** One probe run for one tenant: population, beginRun with the count, the probes, the rows, finishRun. */
export async function runProbes(opts: ProbeRunOptions): Promise<ProbeRunResult> {
  const deps: ProbeDeps = { ...defaultDeps(), ...opts.deps };
  const kinds = [...new Set(opts.kinds ?? PROBE_KINDS)].sort((a, b) => KIND_ORDER[a] - KIND_ORDER[b]);
  const sink = opts.sink ?? null;
  const red = (s: string): string => opts.redactor.text(redact(s));
  const errors: string[] = [];
  const startedAt = deps.now().toISOString();
  const run: CollectionRun = {
    run_id: runId(opts.tenantId, "probe", null, startedAt), tenant_id: opts.tenantId, surface: "probe", host: null,
    started_at: startedAt, finished_at: null, expected_count: null, observed_count: null, status: "running",
  };

  let targets: ProbeTarget[];
  try {
    targets = buildTargets(await opts.population());
  } catch (e) {
    errors.push(red(`population: ${(e as Error)?.message ?? String(e)}`));
    run.observed_count = 0;
    run.status = "failed";
    run.finished_at = deps.now().toISOString();
    if (sink) {
      await sink.beginRun(runStart(run));
      await sink.finishRun(run.run_id, 0, "failed", run.finished_at);
    }
    return { run, rows: [], written: 0, names: 0, errors };
  }

  run.expected_count = kinds.length * targets.length;
  await sink?.beginRun(runStart(run));

  const ctx: ProbeContext = {
    runId: run.run_id, tenantId: opts.tenantId, redactor: opts.redactor, deps, timeoutMs: opts.timeoutMs,
    resolvers: kinds.includes("dns") ? RESOLVERS.map((r) => deps.resolver([r.server])) : [],
  };
  const tasks = targets.flatMap((t) => kinds.map((k) => [t, k] as const));
  const produced = await pool(tasks, opts.concurrency ?? PROBE_CONCURRENCY, async ([t, k]) => {
    try {
      return await probeOne(ctx, t, k);
    } catch (e) {
      errors.push(red(`${k} ${t.name}: ${errorCode(e)}`));
      return null;
    }
  });
  const rows = produced.filter((r): r is Probe => r !== null).sort(byTargetKind);

  let written = 0;
  if (sink) {
    try {
      written = await sink.insertProbes(rows);
    } catch (e) {
      errors.push(red(`write: ${(e as Error)?.message ?? String(e)}`));
      run.observed_count = 0;
      run.status = "failed";
      run.finished_at = deps.now().toISOString();
      await sink.finishRun(run.run_id, 0, "failed", run.finished_at).catch(() => undefined);
      return { run, rows, written: 0, names: targets.length, errors };
    }
  }
  const counted = sink ? written : rows.length;
  const covered = new Set(rows.map((r) => `${r.kind}\u001f${r.target}`));
  const everyRow = targets.every((t) => kinds.every((k) => covered.has(`${k}\u001f${opts.redactor.text(t.name)}`)));
  run.observed_count = counted;
  run.status = everyRow && errors.length === 0 && counted === rows.length ? "complete" : "partial";
  run.finished_at = deps.now().toISOString();
  await sink?.finishRun(run.run_id, counted, run.status, run.finished_at);
  return { run, rows, written, names: targets.length, errors };
}
