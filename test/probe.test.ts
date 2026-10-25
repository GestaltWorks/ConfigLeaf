// The probe (src/probe/): the expectation per record and the ok rule per kind, offline; the whole run over
// the Cloudflare fixtures (test/fixtures/cloudflare: reserved names, documentation and private addresses,
// the redactor test's unregistered domain) with fetch, the resolvers, the tls connector and the clock
// injected, through a fake sink in Store's shape. PROBE_LIVE=true adds one http probe against one name read
// from the live API (CLOUDFLARE_API_TOKEN) and asserts the row's shape; skipped otherwise, with one line.
import { randomBytes } from "node:crypto";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { config, parseProbeOverride, type ProbeOverride } from "../src/config.ts";
import { Cloudflare, dnsRecordRow, type CfRecord, type CfZone } from "../src/collectors/cloudflare.ts";
import { probeId, runId, type Probe } from "../src/data/rows.ts";
import type { RunStart } from "../src/data/store.ts";
import {
  PROBE_CONCURRENCY, RESOLVERS, TLS_EXPECTED, TLS_SKIPPED, buildTargets, dnsExpected, dnsObserved, dnsOk, errorCode, httpExpected, httpObserved, httpOk,
  normAddress, overridePopulation, tlsDaysLeft, tlsObserved, tlsOk, type PopulationRecord, type ProbeTarget, type ResolverAnswer,
} from "../src/probe/rules.ts";
import {
  defaultDeps, nodePlainHttp, observeHttp, observeResolver, observeTls, pool, probeOne, probePopulation, readPopulation, runProbes,
  type DnsResolver, type ProbeDeps, type ProbeSink,
} from "../src/probe/run.ts";
import { Redactor } from "../src/redactor.ts";
import { TOKEN, fakeApi } from "./fixtures/cloudflare/fake-api.ts";
import zonesFile from "./fixtures/cloudflare/zones.json" with { type: "json" };
import recordsFile from "./fixtures/cloudflare/records.json" with { type: "json" };

const r = new Redactor("test-salt");
const red = (s: string): string => r.text(s);
const T = "client-a";
const NOW = new Date("2026-10-24T09:00:00.000Z");
const DAY = 86_400_000;
const ZONES = zonesFile as CfZone[];
const RECORDS = Object.fromEntries(Object.entries(recordsFile).filter(([k]) => !k.startsWith("_"))) as Record<string, CfRecord[]>;
const BLUE = "bluefin-logistics-zz9q.com";
const RAW_LEAK = /bluefin|10\.40\./;
/** A Cloudflare edge answer in a documentation range: what a proxied name resolves to. */
const EDGE4 = "198.51.100.77";
const EDGE6 = "2001:db8::77";

const rec = (name: string, type: string, content: string, proxied: number | null): PopulationRecord => ({ name, type, content, proxied });
const target = (records: PopulationRecord[], name: string): ProbeTarget => buildTargets(records).find((t) => t.name === name)!;
const fixtureCloudflare = (): Cloudflare => new Cloudflare({ token: TOKEN, fetch: fakeApi({ zones: ZONES, records: structuredClone(RECORDS), audit: [] }).fetch });

/** OpenSSL's notAfter shape ("Nov 23 09:00:00 2026 GMT"), `days` whole days after NOW. */
function notAfter(days: number): string {
  const d = new Date(NOW.getTime() + days * DAY);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${mon} ${String(d.getUTCDate()).padStart(2)} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()} GMT`;
}

type HttpWorld = { status: number; cfRay: boolean; server?: string } | { error: string };
interface World {
  http: Record<string, HttpWorld>;
  /** name -> addresses every resolver returns; dnsBy overrides per resolver server. */
  dns: Record<string, string[]>;
  dnsBy?: Record<string, Record<string, string[]>>;
  dnsError?: Record<string, string>;
  tls: Record<string, { authorized: boolean; days: number; issuer?: string }>;
  /** "<host>:<port> <name>" -> the plain-http answer at that address for that Host. */
  plain?: Record<string, HttpWorld>;
}

/** Network and clock as data. Every call is logged as "<kind> <name>"; `active` tracks probes in flight by kind and name. */
function fakeDeps(world: World, log: string[] = [], opts: { delayMs?: number; active?: Map<string, number>; peak?: { n: number } } = {}): ProbeDeps {
  const enter = async (key: string): Promise<() => void> => {
    log.push(key);
    const a = opts.active;
    if (a) {
      a.set(key, (a.get(key) ?? 0) + 1);
      if (opts.peak) opts.peak.n = Math.max(opts.peak.n, a.size);
    }
    if (opts.delayMs) await new Promise((res) => setTimeout(res, opts.delayMs));
    return () => {
      if (!a) return;
      const n = (a.get(key) ?? 1) - 1;
      if (n) a.set(key, n); else a.delete(key);
    };
  };
  const family = (server: string, name: string, v6: boolean): string[] => {
    const code = world.dnsError?.[`${server} ${name}`];
    if (code) throw Object.assign(new Error(`query ${code} ${name}`), { code });
    const all = world.dnsBy?.[server]?.[name] ?? world.dns[name];
    if (!all) throw Object.assign(new Error(`queryA ENOTFOUND ${name}`), { code: "ENOTFOUND" });
    const out = all.filter((a) => a.includes(":") === v6);
    if (!out.length) throw Object.assign(new Error(`query ENODATA ${name}`), { code: "ENODATA" });
    return out;
  };
  return {
    now: () => NOW,
    fetch: async (url) => {
      const name = new URL(url).hostname;
      const done = await enter(`http ${name}`);
      try {
        const w = world.http[name];
        if (!w || "error" in w) {
          throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`getaddrinfo ${w ? w.error : "ENOTFOUND"} ${name}`), { code: w ? w.error : "ENOTFOUND" }) });
        }
        return new Response(null, { status: w.status, headers: { ...(w.cfRay ? { "cf-ray": "8d2f0c1a2b3c4d5e-AMS" } : {}), server: w.server ?? "edge" } });
      } finally {
        done();
      }
    },
    resolver: (servers): DnsResolver => ({
      resolve4: async (name) => { const done = await enter(`dns ${name}`); try { return family(servers[0], name, false); } finally { done(); } },
      resolve6: async (name) => { const done = await enter(`dns ${name}`); try { return family(servers[0], name, true); } finally { done(); } },
    }),
    tls: async (name) => {
      const done = await enter(`tls ${name}`);
      try {
        const w = world.tls[name];
        if (!w) throw Object.assign(new Error(`connect ECONNREFUSED ${name}:443`), { code: "ECONNREFUSED" });
        return { authorized: w.authorized, issuer: w.issuer ?? "Example CA", valid_to: notAfter(w.days) };
      } finally {
        done();
      }
    },
    plainHttp: async ({ host, port, name }) => {
      const key = `${host}:${port} ${name}`;
      const done = await enter(`plain ${key}`);
      try {
        const w = world.plain?.[key];
        if (!w || "error" in w) throw Object.assign(new Error(`connect ${w ? w.error : "ECONNREFUSED"} ${host}:${port}`), { code: w ? w.error : "ECONNREFUSED" });
        return { status: w.status, server: w.server ?? "nginx", cfRay: w.cfRay };
      } finally {
        done();
      }
    },
  };
}

/** The fixture account answering exactly as its records say. */
const HEALTHY: World = {
  http: {
    "shop.example": { status: 200, cfRay: false },
    "www.shop.example": { status: 200, cfRay: true },
    "mail.shop.example": { status: 301, cfRay: false },
    [BLUE]: { status: 200, cfRay: false, server: `edge.${BLUE}` },
    [`www.${BLUE}`]: { status: 200, cfRay: true },
  },
  dns: {
    "shop.example": ["203.0.113.10"],
    "www.shop.example": [EDGE4, EDGE6],
    "mail.shop.example": ["198.51.100.25"],
    [BLUE]: ["10.40.12.7"],
    [`www.${BLUE}`]: [EDGE4, EDGE6],
  },
  tls: {
    "shop.example": { authorized: true, days: 30 },
    "www.shop.example": { authorized: true, days: 60 },
    "mail.shop.example": { authorized: true, days: 30 },
    [BLUE]: { authorized: true, days: 30, issuer: `ca.${BLUE}` },
    [`www.${BLUE}`]: { authorized: true, days: 30 },
  },
};

function fakeSink(log: string[], opts: { writeShort?: number; failWrite?: boolean } = {}) {
  const calls = { begin: [] as RunStart[], rows: [] as Probe[], finish: [] as [string, number, string, string | undefined][] };
  const sink: ProbeSink = {
    async beginRun(run) { log.push("beginRun"); calls.begin.push(run); },
    async insertProbes(rows) {
      log.push("insertProbes");
      if (opts.failWrite) throw new Error("postgres 23505: duplicate key value violates unique constraint");
      calls.rows.push(...rows);
      return rows.length - (opts.writeShort ?? 0);
    },
    async finishRun(id, n, status, at) { log.push("finishRun"); calls.finish.push([id, n, status, at]); },
  };
  return { sink, calls };
}

describe("expectations per record", () => {
  it("a direct A record expects its origin: cf-ray absent, its content on every resolver", () => {
    expect(target([rec("shop.example", "A", "203.0.113.10", 0)], "shop.example")).toEqual({ name: "shop.example", edge: "absent", dns: { contain: ["203.0.113.10"], omit: [] } });
  });

  it("a proxied A record expects the edge: cf-ray present, its content on no resolver", () => {
    expect(target([rec("shop.example", "A", "203.0.113.10", 1)], "shop.example")).toEqual({ name: "shop.example", edge: "present", dns: { contain: [], omit: ["203.0.113.10"] } });
  });

  it("a proxied CNAME answers at the edge and hides its target's origin (the www of the split zone)", () => {
    const records = [rec("shop.example", "A", "203.0.113.10", 0), rec("www.shop.example", "CNAME", "shop.example", 1)];
    expect(target(records, "www.shop.example")).toEqual({ name: "www.shop.example", edge: "present", dns: { contain: [], omit: ["203.0.113.10"] } });
  });

  it("a direct CNAME takes its target's proxied flag when the target is a record of the zones", () => {
    const records = [
      rec("edge.shop.example", "A", "203.0.113.20", 1),
      rec("origin.shop.example", "AAAA", "2001:DB8:0:0::20", 0),
      rec("to-edge.shop.example", "CNAME", "edge.shop.example", 0),
      rec("to-origin.shop.example", "CNAME", "Origin.Shop.Example.", 0),
    ];
    expect(target(records, "to-edge.shop.example")).toEqual({ name: "to-edge.shop.example", edge: "present", dns: { contain: [], omit: ["203.0.113.20"] } });
    expect(target(records, "to-origin.shop.example")).toEqual({ name: "to-origin.shop.example", edge: "absent", dns: { contain: ["2001:db8::20"], omit: [] } });
  });

  it("a direct CNAME to a name outside the zones expects any edge and an answer only; a chain of two CNAMEs is followed one level", () => {
    const records = [
      rec("shop-cdn.shop.example", "CNAME", "assets.example.net", 0),
      rec("hop.shop.example", "CNAME", "shop-cdn.shop.example", 0),
      rec("flagless.shop.example", "A", "203.0.113.30", null),
    ];
    expect(target(records, "shop-cdn.shop.example")).toEqual({ name: "shop-cdn.shop.example", edge: "any", dns: { contain: [], omit: [] } });
    expect(target(records, "hop.shop.example")).toEqual({ name: "hop.shop.example", edge: "any", dns: { contain: [], omit: [] } });
    expect(target(records, "flagless.shop.example").edge).toBe("any");
  });

  it("the population is the distinct non-wildcard names of A, AAAA and CNAME records, lower-cased; other types and wildcards are left out", () => {
    const records = [
      rec("Shop.Example.", "A", "203.0.113.10", 0), rec("shop.example", "AAAA", "2001:db8::10", 0), rec("shop.example", "MX", "10 mail.shop.example", null),
      rec("*.shop.example", "A", "203.0.113.10", 1), rec("txt.shop.example", "TXT", "v=spf1 -all", null), rec("www.shop.example", "cname", "shop.example", 1),
    ];
    const ts = buildTargets(records);
    expect(ts.map((t) => t.name)).toEqual(["shop.example", "www.shop.example"]);
    expect(ts[0].dns.contain).toEqual(["2001:db8::10", "203.0.113.10"]);
    expect(ts[1].dns.omit).toEqual(["2001:db8::10", "203.0.113.10"]);
  });

  it("addresses compare in normal form: IPv6 lower-cased and compressed, IPv4 as given", () => {
    expect([normAddress("2001:0DB8:0000:0000:0000:0000:0000:0001"), normAddress(" 203.0.113.9 "), normAddress("not-an-address:x")]).toEqual(["2001:db8::1", "203.0.113.9", "not-an-address:x"]);
  });
});

describe("the ok rule per kind", () => {
  const direct = { contain: ["203.0.113.10"], omit: [] };
  const proxied = { contain: [], omit: ["203.0.113.10"] };
  const both = (addresses: string[]): ResolverAnswer[] => [{ addresses }, { addresses }];

  it("dns: a direct A record that resolves to its content on both resolvers is ok", () => {
    expect(dnsOk(direct, both(["203.0.113.10"]))).toBe(true);
  });

  it("dns: one resolver that differs fails the probe", () => {
    expect(dnsOk(direct, [{ addresses: ["203.0.113.10"] }, { addresses: ["203.0.113.99"] }])).toBe(false);
  });

  it("dns: a proxied record whose resolution contains its own content fails (the origin is exposed)", () => {
    expect(dnsOk(proxied, both([EDGE4, "203.0.113.10"]))).toBe(false);
    expect(dnsOk(proxied, both([EDGE4, EDGE6]))).toBe(true);
  });

  it("dns: a resolver error, an empty answer or a missing resolver fails, whatever the flags", () => {
    expect(dnsOk(proxied, [{ addresses: [EDGE4] }, { error: "ETIMEOUT" }])).toBe(false);
    expect(dnsOk(proxied, both([]))).toBe(false);
    expect(dnsOk({ contain: [], omit: [] }, [{ addresses: [EDGE4] }])).toBe(false);
  });

  it("http: 200 with cf-ray on a proxied name is ok; without cf-ray it fails", () => {
    expect(httpOk("present", { kind: "answer", status: 200, server: "edge", cfRay: true })).toBe(true);
    expect(httpOk("present", { kind: "answer", status: 200, server: "edge", cfRay: false })).toBe(false);
    expect(httpOk("absent", { kind: "answer", status: 200, server: "edge", cfRay: true })).toBe(false);
  });

  it("http: 503 fails, an unreachable name fails, a redirect answers, any takes either cf-ray", () => {
    expect(httpOk("present", { kind: "answer", status: 503, server: "edge", cfRay: true })).toBe(false);
    expect(httpOk("any", { kind: "unreachable", code: "ENOTFOUND" })).toBe(false);
    expect(httpOk("absent", { kind: "answer", status: 301, server: null, cfRay: false })).toBe(true);
    expect([true, false].map((cfRay) => httpOk("any", { kind: "answer", status: 404, server: null, cfRay }))).toEqual([true, true]);
  });

  it("tls: authorized with 30 days left is ok; 3 days fails; unauthorized fails; 8 days is ok and 7 fails", () => {
    const peer = (days: number, authorized = true) => ({ kind: "peer" as const, authorized, issuer: "Example CA", validTo: notAfter(days) });
    expect(tlsDaysLeft(notAfter(30), NOW)).toBe(30);
    expect(notAfter(30)).toBe("Nov 23 09:00:00 2026 GMT");
    expect(tlsOk(peer(30), NOW)).toBe(true);
    expect(tlsOk(peer(3), NOW)).toBe(false);
    expect(tlsOk(peer(30, false), NOW)).toBe(false);
    expect([tlsOk(peer(8), NOW), tlsOk(peer(7), NOW)]).toEqual([true, false]);
    expect(tlsOk({ kind: "peer", authorized: true, issuer: "Example CA", validTo: "" }, NOW)).toBe(false);
    expect(tlsOk({ kind: "unreachable", code: "ECONNREFUSED" }, NOW)).toBe(false);
  });
});

describe("the strings a probe row stores", () => {
  it("expected and observed per kind, addresses and names through the redaction function", () => {
    expect(httpExpected("present")).toBe("answers (status below 500); cf-ray present");
    expect(httpObserved({ kind: "answer", status: 200, server: `edge.${BLUE}`, cfRay: false }, red)).toMatch(/^status 200 server=host-[0-9a-f]{6}\.com cf-ray absent$/);
    expect(httpObserved({ kind: "answer", status: 503, server: null, cfRay: true }, red)).toBe("status 503 server=- cf-ray present");
    expect(httpObserved({ kind: "unreachable", code: "ENOTFOUND" }, red)).toBe("unreachable: ENOTFOUND");
    expect(dnsExpected({ contain: ["203.0.113.10"], omit: [] }, red)).toBe("each resolver answers with an address; contains 203.0.113.10");
    expect(dnsExpected({ contain: [], omit: ["10.40.12.7"] }, red)).toMatch(/^each resolver answers with an address; omits ip-[0-9a-f]{6} \(proxied: the origin stays hidden\)$/);
    expect(dnsExpected({ contain: [], omit: [] }, red)).toBe("each resolver answers with an address");
    expect(dnsObserved([{ addresses: [EDGE6, EDGE4] }, { error: "ETIMEOUT" }], red)).toBe(`r1 [${EDGE4}, ${EDGE6}]; r2 error ETIMEOUT`);
    expect(dnsObserved([{ addresses: ["10.40.12.7"] }, { addresses: [] }], red)).toMatch(/^r1 \[ip-[0-9a-f]{6}\]; r2 \[\]$/);
    expect(TLS_EXPECTED).toBe("valid for the name, more than 7 days left");
    expect(tlsObserved({ kind: "peer", authorized: true, issuer: "Example CA", validTo: notAfter(30) }, NOW, red)).toBe("issuer=Example CA expires=2026-11-23T09:00:00.000Z days=30 authorized=yes");
    expect(tlsObserved({ kind: "peer", authorized: false, issuer: "", validTo: "garbage" }, NOW, red)).toBe("issuer=- expires=unknown days=unknown authorized=no");
    expect(RESOLVERS.map((x) => x.label)).toEqual(["r1", "r2"]);
  });

  it("errorCode reads codes and specific names; messages stay unread", () => {
    const undici = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND www.${BLUE}`), { code: "ENOTFOUND" }) });
    const eyeballs = Object.assign(new TypeError("fetch failed"), { cause: new AggregateError([Object.assign(new Error("connect ECONNREFUSED 10.40.12.7:443"), { code: "ECONNREFUSED" })]) });
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect([errorCode(undici), errorCode(eyeballs), errorCode(timeout), errorCode(new Error(`boom ${BLUE}`)), errorCode("x"), errorCode(null)])
      .toEqual(["ENOTFOUND", "ECONNREFUSED", "TimeoutError", "unknown", "unknown", "unknown"]);
  });
});

describe("observing", () => {
  it("http asks GET https://<name>/ with redirect manual, a timeout signal and its user agent; a thrown fetch is unreachable with its code", async () => {
    const seen: [string, RequestInit | undefined][] = [];
    const ok = await observeHttp(async (u, i) => { seen.push([u, i]); return new Response("body", { status: 302, headers: { location: "https://elsewhere.example/", server: "edge" } }); }, "shop.example");
    expect(ok).toEqual({ kind: "answer", status: 302, server: "edge", cfRay: false });
    expect(seen[0][0]).toBe("https://shop.example/");
    expect(seen[0][1]).toMatchObject({ method: "GET", redirect: "manual", headers: { "user-agent": "drift-agent-probe/0.0.1" } });
    expect(seen[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(await observeHttp(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } }); }, "shop.example")).toEqual({ kind: "unreachable", code: "CERT_HAS_EXPIRED" });
  });

  it("a resolver's answer is A and AAAA together; ENODATA and ENOTFOUND are an empty family, any other error is the answer", async () => {
    const resolver = (v4: () => Promise<string[]>, v6: () => Promise<string[]>): DnsResolver => ({ resolve4: v4, resolve6: v6 });
    const nodata = () => Promise.reject(Object.assign(new Error("ENODATA"), { code: "ENODATA" }));
    expect(await observeResolver(resolver(async () => ["203.0.113.10"], async () => ["2001:DB8::0:1"]), "shop.example")).toEqual({ addresses: ["2001:db8::1", "203.0.113.10"] });
    expect(await observeResolver(resolver(async () => ["203.0.113.10"], nodata), "shop.example")).toEqual({ addresses: ["203.0.113.10"] });
    expect(await observeResolver(resolver(nodata, () => Promise.reject(Object.assign(new Error("x"), { code: "ENOTFOUND" }))), "shop.example")).toEqual({ addresses: [] });
    expect(await observeResolver(resolver(() => Promise.reject(Object.assign(new Error("x"), { code: "ESERVFAIL" })), async () => []), "shop.example")).toEqual({ error: "ESERVFAIL" });
    expect(await observeResolver(resolver(() => new Promise(() => undefined), async () => []), "shop.example", 20)).toEqual({ error: "ETIMEDOUT" });
  });

  it("tls reads the connector's peer; a refusal or a hang is unreachable with its code", async () => {
    expect(await observeTls(async () => ({ authorized: true, issuer: "Example CA", valid_to: notAfter(30) }), "shop.example")).toEqual({ kind: "peer", authorized: true, issuer: "Example CA", validTo: notAfter(30) });
    expect(await observeTls(async () => { throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); }, "shop.example")).toEqual({ kind: "unreachable", code: "ECONNREFUSED" });
    expect(await observeTls(() => new Promise(() => undefined), "shop.example", 10)).toEqual({ kind: "unreachable", code: "ETIMEDOUT" });
  });

  it("pool keeps at most n in flight and returns results in input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await pool([5, 1, 4, 2, 3, 1, 2, 5, 1, 3], 4, async (ms) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((res) => setTimeout(res, ms));
      inFlight--;
      return ms * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 10, 20, 50, 10, 30]);
    expect(peak).toBe(4);
    expect(await pool([], 4, async () => 1)).toEqual([]);
  });
});

describe("a probe run over the fixture account, offline", () => {
  const RUN = runId(T, "probe", null, NOW.toISOString());

  it("reads the population before the run: 5 names of A, AAAA and CNAME records, wildcards left out", async () => {
    const records = await readPopulation(fixtureCloudflare());
    expect(records.map((x) => x.type).sort()).toEqual(["A", "A", "A", "A", "A", "CNAME", "CNAME"]);
    expect(buildTargets(records).map((t) => t.name)).toEqual(["bluefin-logistics-zz9q.com", "mail.shop.example", "shop.example", `www.${BLUE}`, "www.shop.example"]);
  });

  it("asserts expected_count = 3 x names through beginRun before any probe, writes one row per kind per name, and finishes complete with the rows written", async () => {
    const log: string[] = [];
    const { sink, calls } = fakeSink(log);
    const res = await runProbes({ tenantId: T, population: () => readPopulation(fixtureCloudflare()), redactor: r, deps: fakeDeps(HEALTHY, log), sink });
    expect(log[0]).toBe("beginRun");
    expect(log.slice(-2)).toEqual(["insertProbes", "finishRun"]);
    expect(log.filter((l) => /^(http|dns|tls) /.test(l)).length).toBe(5 + 5 * 4 + 5);
    expect(calls.begin).toEqual([{ run_id: RUN, tenant_id: T, surface: "probe", host: null, started_at: NOW.toISOString(), expected_count: 15 }]);
    expect(calls.finish).toEqual([[RUN, 15, "complete", NOW.toISOString()]]);
    expect(res.run).toMatchObject({ run_id: RUN, surface: "probe", host: null, expected_count: 15, observed_count: 15, status: "complete" });
    expect([res.names, res.written, res.errors]).toEqual([5, 15, []]);
    expect(calls.rows).toEqual(res.rows);
    expect(res.rows.every((p) => p.status === "ok")).toBe(true);
    expect(res.rows.map((p) => p.probe_id)).toEqual(res.rows.map((p) => probeId(RUN, p.kind, p.target)));
    expect(new Set(res.rows.map((p) => p.probe_id)).size).toBe(15);
    expect(res.rows.every((p) => p.latency_ms === 0 && p.observed_at === NOW.toISOString() && p.run_id === RUN && p.tenant_id === T)).toBe(true);
  });

  it("stores the strings of each kind as the rules build them", async () => {
    const res = await runProbes({ tenantId: T, population: () => readPopulation(fixtureCloudflare()), redactor: r, deps: fakeDeps(HEALTHY) });
    const row = (target: string, kind: string) => res.rows.find((p) => p.target === target && p.kind === kind)!;
    expect(row("shop.example", "http")).toMatchObject({ expected: "answers (status below 500); cf-ray absent", observed: "status 200 server=edge cf-ray absent", status: "ok" });
    expect(row("www.shop.example", "http")).toMatchObject({ expected: "answers (status below 500); cf-ray present", observed: "status 200 server=edge cf-ray present", status: "ok" });
    expect(row("shop.example", "dns")).toMatchObject({ expected: "each resolver answers with an address; contains 203.0.113.10", observed: "r1 [203.0.113.10]; r2 [203.0.113.10]", status: "ok" });
    expect(row("www.shop.example", "dns")).toMatchObject({
      expected: "each resolver answers with an address; omits 203.0.113.10 (proxied: the origin stays hidden)",
      observed: `r1 [${EDGE4}, ${EDGE6}]; r2 [${EDGE4}, ${EDGE6}]`, status: "ok",
    });
    expect(row("mail.shop.example", "tls")).toMatchObject({ expected: TLS_EXPECTED, observed: "issuer=Example CA expires=2026-11-23T09:00:00.000Z days=30 authorized=yes", status: "ok" });
  });

  it("redacts every target, expected and observed string: the target is the pseudonym the Cloudflare collector stores for the name", async () => {
    const res = await runProbes({ tenantId: T, population: () => readPopulation(fixtureCloudflare()), redactor: r, deps: fakeDeps(HEALTHY) });
    expect(RAW_LEAK.test(JSON.stringify(res.rows))).toBe(false);
    const apex = RECORDS[ZONES[1].id].find((x) => x.name === BLUE)!;
    const stored = dnsRecordRow(r, apex, ZONES[1].name, { tenantId: T, runId: "run-dns", observedAt: NOW.toISOString() })!;
    expect(stored.name).toMatch(/^host-[0-9a-f]{6}\.com$/);
    const rows = res.rows.filter((p) => p.target === stored.name);
    expect(rows.map((p) => p.kind)).toEqual(["http", "dns", "tls"]);
    expect(rows[0].observed).toMatch(/^status 200 server=host-[0-9a-f]{6}\.com cf-ray absent$/);
    expect(rows[1].expected).toBe(`each resolver answers with an address; contains ${stored.content}`);
    expect(rows[2].observed).toMatch(/^issuer=host-[0-9a-f]{6}\.com expires=/);
    for (const p of res.rows) for (const k of ["target", "expected", "observed"] as const) expect(r.text(p[k])).toBe(p[k]);
  });

  it("records what production does: an unreachable name, a 503, an exposed origin, a lapsing certificate and a disagreeing resolver are fail rows of a complete run", async () => {
    const world: World = {
      ...HEALTHY,
      http: { ...HEALTHY.http, "mail.shop.example": { error: "ECONNREFUSED" }, "www.shop.example": { status: 503, cfRay: true } },
      dns: { ...HEALTHY.dns, [`www.${BLUE}`]: [EDGE4, "10.40.12.7"] },
      dnsBy: { [RESOLVERS[1].server]: { "shop.example": ["203.0.113.99"] } },
      tls: { ...HEALTHY.tls, "shop.example": { authorized: true, days: 3 }, [BLUE]: { authorized: false, days: 30 } },
    };
    const log: string[] = [];
    const { sink, calls } = fakeSink(log);
    const res = await runProbes({ tenantId: T, population: () => readPopulation(fixtureCloudflare()), redactor: r, deps: fakeDeps(world), sink });
    const failed = res.rows.filter((p) => p.status === "fail").map((p) => `${p.kind} ${p.target}`);
    const blue = r.text(BLUE);
    const wwwBlue = r.text(`www.${BLUE}`);
    expect(failed.sort()).toEqual([
      "dns shop.example", `dns ${wwwBlue}`, "http mail.shop.example", "http www.shop.example", `tls ${blue}`, "tls shop.example",
    ].sort());
    expect(res.rows.find((p) => p.kind === "http" && p.target === "mail.shop.example")!.observed).toBe("unreachable: ECONNREFUSED");
    expect(res.rows.find((p) => p.kind === "dns" && p.target === "shop.example")!.observed).toBe("r1 [203.0.113.10]; r2 [203.0.113.99]");
    expect(calls.finish).toEqual([[RUN, 15, "complete", NOW.toISOString()]]);
  });

  it("--only narrows the kinds and expected_count with them", async () => {
    const log: string[] = [];
    const { sink, calls } = fakeSink(log);
    const res = await runProbes({ tenantId: T, population: () => readPopulation(fixtureCloudflare()), redactor: r, deps: fakeDeps(HEALTHY, log), sink, kinds: ["tls"] });
    expect(calls.begin[0].expected_count).toBe(5);
    expect(res.rows.map((p) => p.kind)).toEqual(["tls", "tls", "tls", "tls", "tls"]);
    expect(log.filter((l) => /^(http|dns) /.test(l))).toEqual([]);
    expect(calls.finish).toEqual([[RUN, 5, "complete", NOW.toISOString()]]);
  });

  it("the surface is an option, probe by default: the Actor's verification runs as surface probe.verify, under a run id of that surface", async () => {
    const { sink, calls } = fakeSink([]);
    const res = await runProbes({ tenantId: T, population: () => readPopulation(fixtureCloudflare()), redactor: r, deps: fakeDeps(HEALTHY), sink, kinds: ["dns"], surface: "probe.verify" });
    const verify = runId(T, "probe.verify", null, NOW.toISOString());
    expect(verify).not.toBe(RUN);
    expect(calls.begin).toEqual([{ run_id: verify, tenant_id: T, surface: "probe.verify", host: null, started_at: NOW.toISOString(), expected_count: 5 }]);
    expect(res.run).toMatchObject({ run_id: verify, surface: "probe.verify", status: "complete" });
    expect(res.rows.every((p) => p.run_id === verify)).toBe(true);
  });

  it("a dry run (no sink) writes nothing and counts the rows it produced", async () => {
    const res = await runProbes({ tenantId: T, population: () => readPopulation(fixtureCloudflare()), redactor: r, deps: fakeDeps(HEALTHY), sink: null });
    expect(res.written).toBe(0);
    expect(res.run).toMatchObject({ expected_count: 15, observed_count: 15, status: "complete" });
  });

  it("keeps four probes in flight at most", async () => {
    const active = new Map<string, number>();
    const peak = { n: 0 };
    const population = async () => Array.from({ length: 12 }, (_, i) => rec(`n${i}.shop.example`, "A", `203.0.113.${i + 1}`, 0));
    const res = await runProbes({ tenantId: T, population, redactor: r, deps: fakeDeps({ http: {}, dns: {}, tls: {} }, [], { delayMs: 3, active, peak }) });
    expect(res.rows.length).toBe(36);
    expect(PROBE_CONCURRENCY).toBe(4);
    expect(peak.n).toBe(4);
  });

  it("a population read that fails is a failed run with a null count and zero probes sent", async () => {
    const log: string[] = [];
    const { sink, calls } = fakeSink(log);
    const res = await runProbes({ tenantId: T, population: async () => { throw new Error(`Cloudflare 403 GET /zones: 10000: Authentication error for ${BLUE}`); }, redactor: r, deps: fakeDeps(HEALTHY, log), sink });
    expect(log).toEqual(["beginRun", "finishRun"]);
    expect(calls.begin[0].expected_count).toBeNull();
    expect(calls.finish).toEqual([[RUN, 0, "failed", NOW.toISOString()]]);
    expect(res.run.status).toBe("failed");
    expect(res.errors).toHaveLength(1);
    expect(RAW_LEAK.test(res.errors[0])).toBe(false);
  });

  it("a write the sink refuses fails the run; a sink that stores fewer rows than produced leaves it partial", async () => {
    const refused = fakeSink([], { failWrite: true });
    const a = await runProbes({ tenantId: T, population: () => readPopulation(fixtureCloudflare()), redactor: r, deps: fakeDeps(HEALTHY), sink: refused.sink });
    expect(refused.calls.finish).toEqual([[RUN, 0, "failed", NOW.toISOString()]]);
    expect(a.run.status).toBe("failed");
    const short = fakeSink([], { writeShort: 1 });
    const b = await runProbes({ tenantId: T, population: () => readPopulation(fixtureCloudflare()), redactor: r, deps: fakeDeps(HEALTHY), sink: short.sink });
    expect(short.calls.finish).toEqual([[RUN, 14, "partial", NOW.toISOString()]]);
    expect(b.run).toMatchObject({ observed_count: 14, status: "partial" });
  });

  it("probeOne takes its latency and observed_at from the injected clock", async () => {
    let t = NOW.getTime();
    const deps = { ...fakeDeps(HEALTHY), now: () => new Date((t += 7)) };
    const row = await probeOne({ runId: RUN, tenantId: T, redactor: r, deps, resolvers: [] }, target([rec("shop.example", "A", "203.0.113.10", 0)], "shop.example"), "http");
    expect(row).toMatchObject({ kind: "http", target: "shop.example", status: "ok", latency_ms: 7, observed_at: new Date(NOW.getTime() + 14).toISOString() });
  });
});

describe("PROBE_TARGETS_OVERRIDE, the lab aid", () => {
  const LAB = "127.0.0.1";
  const OVERRIDE: ProbeOverride[] = [{ name: "lab.example", host: LAB, port: 8080 }, { name: "www.lab.test", host: LAB, port: 8080 }];
  const RUN = runId(T, "probe", null, NOW.toISOString());
  const LAB_WORLD: World = {
    http: {}, dns: {}, tls: {},
    plain: { [`${LAB}:8080 lab.example`]: { status: 200, cfRay: false, server: "nginx/1.22.1" }, [`${LAB}:8080 www.lab.test`]: { status: 503, cfRay: false } },
  };

  it("parses <name>=<address>[:<port>], comma-separated: port 80 when absent, names lower-cased, IPv6 in brackets; any other shape throws", () => {
    expect(parseProbeOverride("")).toEqual([]);
    expect(parseProbeOverride(" lab.example=127.0.0.1:8080, WWW.Lab.Test.=127.0.0.1 ,v6.lab.test=[::1]:8443")).toEqual([
      { name: "lab.example", host: "127.0.0.1", port: 8080 }, { name: "www.lab.test", host: "127.0.0.1", port: 80 }, { name: "v6.lab.test", host: "::1", port: 8443 },
    ]);
    for (const bad of ["lab.example", "lab.example=", "=127.0.0.1", "*.lab.example=127.0.0.1", "lab.example=127.0.0.1:0", "lab.example=127.0.0.1:99999", "lab.example=127.0.0.1:80:1", "lab example=127.0.0.1", "a.test=127.0.0.1,A.test=127.0.0.2"]) {
      expect(() => parseProbeOverride(bad), bad).toThrow(/^PROBE_TARGETS_OVERRIDE: /);
    }
  });

  it("an entry is a direct A record of its address with via set: cf-ray absent, the address expected, plain http at the address", () => {
    const pop = overridePopulation(OVERRIDE);
    expect(pop[0]).toEqual({ name: "lab.example", type: "A", content: LAB, proxied: 0, via: { host: LAB, port: 8080 } });
    expect(overridePopulation([{ name: "v6.lab.test", host: "::1", port: 80 }])[0].type).toBe("AAAA");
    expect(buildTargets(pop)).toEqual([
      { name: "lab.example", edge: "absent", dns: { contain: [LAB], omit: [] }, via: { host: LAB, port: 8080 } },
      { name: "www.lab.test", edge: "absent", dns: { contain: [LAB], omit: [] }, via: { host: LAB, port: 8080 } },
    ]);
    expect(buildTargets([rec("shop.example", "A", "203.0.113.10", 0)])[0]).not.toHaveProperty("via");
  });

  it("http asks the address over plain http with the name as Host, under the same ok rule; dns asks no resolver and holds the override; tls is recorded skipped", async () => {
    const log: string[] = [];
    const { sink, calls } = fakeSink(log);
    const res = await runProbes({ tenantId: T, population: async () => overridePopulation(OVERRIDE), redactor: r, deps: fakeDeps(LAB_WORLD, log), sink });
    expect(log.filter((l) => /^(http|dns|tls|plain) /.test(l)).sort()).toEqual([`plain ${LAB}:8080 lab.example`, `plain ${LAB}:8080 www.lab.test`]);
    expect(calls.begin[0].expected_count).toBe(6);
    expect(res.run).toMatchObject({ run_id: RUN, expected_count: 6, observed_count: 6, status: "complete" });
    const row = (kind: string, name: string): Probe => res.rows.find((p) => p.kind === kind && p.target === red(name))!;
    const at = `plain http at ${red(LAB)}:8080 (override)`;
    expect(row("http", "lab.example")).toMatchObject({ status: "ok", expected: `answers (status below 500) over ${at}; cf-ray absent`, observed: `status 200 server=nginx/1.22.1 cf-ray absent; over ${at}` });
    expect(row("http", "www.lab.test")).toMatchObject({ status: "fail", observed: `status 503 server=nginx cf-ray absent; over ${at}` });
    expect(row("dns", "lab.example")).toMatchObject({ status: "ok", expected: `resolves to ${red(LAB)} through the override (PROBE_TARGETS_OVERRIDE); no resolver asked`, observed: `override [${red(LAB)}]` });
    expect(row("tls", "lab.example")).toMatchObject({ status: "skipped", expected: TLS_EXPECTED, observed: TLS_SKIPPED });
    expect(TLS_SKIPPED).toBe("skipped: no TLS on this target");
    expect(res.rows.map((p) => p.status).sort()).toEqual(["fail", "ok", "ok", "ok", "skipped", "skipped"]);
  });

  it("an address that refuses the connection is an unreachable http fail, the override named", async () => {
    const res = await runProbes({ tenantId: T, population: async () => overridePopulation([{ name: "lab.example", host: LAB, port: 8099 }]), redactor: r, deps: fakeDeps(LAB_WORLD), kinds: ["http"] });
    expect(res.rows[0]).toMatchObject({ status: "fail", observed: `unreachable: ECONNREFUSED; over plain http at ${red(LAB)}:8099 (override)` });
  });

  it("probePopulation: the override's entries when set, the Cloudflare read skipped and one trace line saying so; the account's records otherwise", async () => {
    const events: { output_summary?: string; status: string; agent: string }[] = [];
    const tracer = { emit: (e: { output_summary?: string; status: string; agent: string }) => events.push(e) };
    let reads = 0;
    const source = () => { reads++; return fixtureCloudflare(); };
    expect(await probePopulation({ source, override: OVERRIDE, tracer, agent: "actor" })()).toEqual(overridePopulation(OVERRIDE));
    expect(reads).toBe(0);
    expect(events).toEqual([expect.objectContaining({ agent: "actor", status: "skipped", output_summary: "PROBE_TARGETS_OVERRIDE names 2 target(s); the Cloudflare read is skipped" })]);
    expect((await probePopulation({ source, override: [], tracer, agent: "probe" })()).length).toBe(7);
    expect([reads, events.length]).toEqual([1, 1]);
  });

  it("nodePlainHttp sends GET / to the address with the name as Host and reads the status and the server header", async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => { seen.push(`${req.method} ${req.url} ${req.headers.host}`); res.writeHead(req.headers.host === "lab.example" ? 200 : 404, { server: "lab-nginx" }).end("x"); });
    await new Promise<void>((ok) => server.listen(0, LAB, ok));
    try {
      const port = (server.address() as { port: number }).port;
      expect(await nodePlainHttp({ host: LAB, port, name: "lab.example", timeoutMs: 5_000 })).toEqual({ status: 200, server: "lab-nginx", cfRay: false });
      expect((await nodePlainHttp({ host: LAB, port, name: "other.test", timeoutMs: 5_000 })).status).toBe(404);
      expect(seen).toEqual(["GET / lab.example", "GET / other.test"]);
    } finally {
      await new Promise((ok) => server.close(ok));
    }
  });
});

const live = process.env.PROBE_LIVE === "true" && config.cloudflare.token !== "";
if (!live) console.log("probe: live half skipped (set PROBE_LIVE=true and CLOUDFLARE_API_TOKEN to run it)");

describe("live", () => {
  it.skipIf(!live)("one http probe against a name read from the live API gives a row of the probe shape", { timeout: 60_000 }, async () => {
    const targets = buildTargets(await readPopulation(new Cloudflare()));
    expect(targets.length).toBeGreaterThan(0);
    const t = targets[0];
    const redactor = new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords);
    const at = new Date().toISOString();
    const run = runId("client-1", "probe", null, at);
    const row = await probeOne({ runId: run, tenantId: "client-1", redactor, deps: defaultDeps(), resolvers: [] }, t, "http");
    expect(row.kind).toBe("http");
    expect(row.probe_id).toBe(probeId(run, "http", row.target));
    expect(row.target === t.name).toBe(false);
    expect(row.target).toBe(redactor.text(t.name));
    expect(row.expected).toMatch(/^answers \(status below 500\); cf-ray (present|absent|any)$/);
    expect(row.observed).toMatch(/^(status \d{3} server=.+ cf-ray (present|absent)|unreachable: \S+)$/);
    expect(["ok", "fail"]).toContain(row.status);
    expect(Number.isInteger(row.latency_ms)).toBe(true);
    expect(row.observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    for (const k of ["target", "expected", "observed"] as const) expect(redactor.text(row[k])).toBe(row[k]);
    console.log(`probe live: ${targets.length} name(s) in the population (expected_count ${3 * targets.length}); one http probe ${row.status} in ${row.latency_ms} ms`);
  });
});
