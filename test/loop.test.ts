// The loop (src/loop/): the cycle's order, skips and stop rule over fake steps; the watcher over a fake clock; the
// tenant ledger; each live step with fakes in place of the hosts, Cloudflare, the probes and the Store; and the pass,
// act (dry run), tickets (dry run) and document steps over sql.js with test/fixtures/policy-bundle.json and the
// Actor's fixture vault (test/fixtures/actions/world.ts), run as one cycle with collect, probe and validate skipped.
// Offline and deterministic: no host, no Cloudflare, no Nightshift, no GitHub, no Postgres.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/config.ts"; // loads .env into process.env
import { Cloudflare, type FetchLike } from "../src/collectors/cloudflare.ts";
import type { CollectResult } from "../src/collectors/linux.ts";
import { EMPTY_ROWS } from "../src/collectors/types.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { DISPOSITIONS_SQL, objects, tenantActions } from "../src/data/queries.ts";
import type { CollectionRun, Disposition, ReferentFingerprint } from "../src/data/rows.ts";
import type { Store } from "../src/data/store.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { MemoryLedger, type Ledger } from "../src/ledger.ts";
import { SKIPPABLE, parseSkip, runCycle, stepNames, type CycleSteps, type StepReport } from "../src/loop/cycle.ts";
import { LoopError, TenantLedger, dispositionIdOf, passStep, type PassStep } from "../src/loop/pass.ts";
import { actStep, collectCloudflareStep, collectLinuxStep, documentStep, labelledRows, probeStep, ticketsStep, validateStep } from "../src/loop/steps.ts";
import { LabelTracer } from "../src/loop/trace.ts";
import { sleep, watch } from "../src/loop/watch.ts";
import { MemoryTicketRows } from "../src/psa/step.ts";
import { Redactor, countLabels } from "../src/redactor.ts";
import { AT, TENANT, buildBase, buildWorld, type Base, type World } from "./fixtures/actions/world.ts";
import { MemTracer } from "./fixtures/mem-tracer.ts";

const passOf = (tenant = "t1"): PassStep => ({
  tenant, decidedAt: "2026-10-24T00:00:00.000Z", runs: 1, kept: 0, lines: [], summary: "PASS: fake",
  pass: { runs: 1, gatedOut: [], observed: 0, findings: [], verifier: { early_stop: 0, checks_skipped: 0, checks_gated: 0, withdrawn_judge: 0 }, memory: null, verbs: { ADOPT: 0, HOLD: 0, ESCALATE: 0, ROLLBACK: 0, FIX: 0 }, locked: 0, rules: 0, ledger: null },
  findings: [],
});

/** Fake steps that record their calls; `over` replaces any of them. */
function fakeSteps(calls: string[], over: Partial<CycleSteps> = {}): CycleSteps {
  const ok = (name: string): StepReport => ({ ok: true, summary: `${name}: fine` });
  return {
    collectCloudflare: async () => { calls.push("collect:cloudflare"); return { ...ok("collect:cloudflare"), commits: [{ repo: "t1/cloudflare", commit: "c".repeat(40) }] }; },
    collectLinux: async (a) => { calls.push(`collect:linux ${a}`); return { ...ok(`collect:linux ${a}`), commits: [{ repo: `t1/${a}`, commit: a.padEnd(40, "0") }] }; },
    probe: async () => { calls.push("probe"); return ok("probe"); },
    validate: async (commits) => { calls.push(`validate ${commits.map((c) => c.repo).join(",")}`); return ok("validate"); },
    pass: async () => { calls.push("pass"); return { ...ok("PASS"), pass: passOf() }; },
    act: async (p) => { calls.push(`act ${p.tenant}`); return ok("act"); },
    tickets: async (p) => { calls.push(`tickets ${p.tenant}`); return ok("TICKETS"); },
    document: async (p) => { calls.push(`document ${p.tenant}`); return ok("document"); },
    ...over,
  };
}

const ticking = (): (() => number) => { let t = 0; return () => (t += 100); };

describe("parseSkip", () => {
  it("takes comma lists and repeats, and refuses a name it does not know", () => {
    expect([...parseSkip(["collect,probe", "validate", " act "])].sort()).toEqual(["act", "collect", "probe", "validate"]);
    expect(parseSkip(undefined).size).toBe(0);
    expect(() => parseSkip(["pass"])).toThrow(/--skip takes collect, probe, validate, act, tickets, document; got pass/);
    expect(SKIPPABLE).not.toContain("pass");
  });
});

describe("runCycle over fake steps", () => {
  it("runs every step in order, hands the collect steps' commits to validate and the pass to act, tickets and document", async () => {
    const calls: string[] = [];
    const printed: string[] = [];
    const tracer = new MemTracer("loop_test", { model: "none" });
    const res = await runCycle({ tenant: "t1", apply: false, aliases: ["a1", "a2"], skip: new Set() }, fakeSteps(calls), { tracer, print: (l) => printed.push(l), clock: ticking() });
    expect(calls).toEqual(["collect:cloudflare", "collect:linux a1", "collect:linux a2", "probe", "validate t1/cloudflare,t1/a1,t1/a2", "pass", "act t1", "tickets t1", "document t1"]);
    expect(res.steps.map((s) => `${s.step} ${s.status}`)).toEqual(stepNames(["a1", "a2"]).map((s) => `${s} ok`));
    expect(res.stopped).toBeNull();
    expect(printed[0]).toBe("cycle: [1/9] collect:cloudflare ok in 0.1 s: collect:cloudflare: fine");
    expect(printed[5]).toBe("cycle: [6/9] pass ok in 0.1 s: PASS: fine");
    expect(printed.at(-1)).toBe(res.summary);
    expect(res.summary).toMatch(/^CYCLE: tenant t1, dry run \(act plans and writes nothing to a host or a zone; --apply performs it\): 9 step\(s\): ok 9, skipped 0, failed 0, not run 0; completed; \d+\.\d s$/);
    // one trace line per step and one for the cycle, agent cycle, the step's time as latency
    expect(tracer.events.length).toBe(10);
    expect(tracer.events.every((e) => e.agent === "cycle" && e.action === "triage" && e.model_requested === "none")).toBe(true);
    expect(tracer.events[3]).toMatchObject({ input_summary: "cycle t1 [4/9] probe", status: "ok", latency_ms: 100 });
  });

  it("skips the named groups, runs the pass in every cycle, and gives validate no commit when collect is skipped", async () => {
    const calls: string[] = [];
    const res = await runCycle({ tenant: "t1", apply: true, aliases: ["a1"], skip: parseSkip(["collect,probe", "tickets"]) }, fakeSteps(calls), { print: () => undefined, clock: ticking() });
    expect(calls).toEqual(["validate ", "pass", "act t1", "document t1"]);
    expect(res.steps.map((s) => s.status)).toEqual(["skipped", "skipped", "skipped", "ok", "ok", "ok", "skipped", "ok"]);
    expect(res.steps[0].summary).toBe("skipped (--skip collect)");
    expect(res.summary).toMatch(/^CYCLE: tenant t1, applied \(act carries out its plan\): 8 step\(s\): ok 4, skipped 4, failed 0, not run 0; completed;/);
  });

  it("stops at the first failing step with its reason; every later step is not run", async () => {
    const calls: string[] = [];
    const steps = fakeSteps(calls, { probe: async () => { calls.push("probe"); return { ok: false, summary: "probe: run r1 100/111 partial", reason: "probe run r1 is partial" }; } });
    const res = await runCycle({ tenant: "t1", apply: false, aliases: [], skip: new Set() }, steps, { print: () => undefined, clock: ticking() });
    expect(calls).toEqual(["collect:cloudflare", "probe"]);
    expect(res.stopped).toEqual({ step: "probe", reason: "probe run r1 is partial" });
    expect(res.steps.map((s) => s.status)).toEqual(["ok", "failed", "not_run", "not_run", "not_run", "not_run", "not_run"]);
    expect(res.steps[2].summary).toBe("the cycle stopped at probe");
    expect(res.summary).toContain("ok 1, skipped 0, failed 1, not run 5; stopped at probe: probe run r1 is partial;");
  });

  it("fails a step that throws with its message, scrubbed, and stops there", async () => {
    const printed: string[] = [];
    const steps = fakeSteps([], { act: async () => { throw new Error("postgres://u:hunter2@db/x refused"); } });
    const res = await runCycle({ tenant: "t1", apply: false, aliases: [], skip: new Set() }, steps, { print: (l) => printed.push(l), clock: ticking() });
    expect(res.stopped?.step).toBe("act");
    expect(res.stopped?.reason).toBe("postgres://u:<redacted>@db/x refused");
    expect(printed.join("\n")).not.toContain("hunter2");
    expect(res.steps.slice(-2).map((s) => s.status)).toEqual(["not_run", "not_run"]);
  });

  it("fails the pass step when it reports no result", async () => {
    const res = await runCycle({ tenant: "t1", apply: false, aliases: [], skip: new Set(SKIPPABLE) }, fakeSteps([], { pass: async () => ({ ok: true, summary: "PASS", pass: null }) }), { print: () => undefined });
    expect(res.stopped).toEqual({ step: "pass", reason: "the pass step returned no result" });
  });
});

describe("watch", () => {
  it("starts a cycle every interval from the start of the last, at once after an overrun, goes on after a throw, and stops on the signal", async () => {
    let t = Date.parse("2026-10-24T00:00:00.000Z");
    const now = () => new Date(t);
    const ac = new AbortController();
    const printed: string[] = [];
    const waits: number[] = [];
    const durations = [60_000, 700_000, 30_000, 10_000];
    const res = await watch({
      everyMs: 600_000, signal: ac.signal, now, print: (l) => printed.push(l),
      sleep: async (ms) => { waits.push(ms); t += ms; },
      cycle: async (n) => {
        t += durations[n - 1];
        if (n === 3) throw new Error("token Bearer abc.def leaked");
        if (n === 4) ac.abort();
        return { summary: `CYCLE ${n}`, stopped: n === 2 ? { step: "probe", reason: "partial" } : null };
      },
    });
    expect(res).toEqual({ cycles: 4, stopped: 1, threw: 1 });
    expect(waits).toEqual([540_000, 0, 570_000]);
    expect(printed).toEqual([
      "WATCH 1 2026-10-24T00:00:00.000Z: CYCLE 1; next cycle at 2026-10-24T00:10:00.000Z",
      "WATCH 2 2026-10-24T00:10:00.000Z: CYCLE 2; next cycle at 2026-10-24T00:21:40.000Z",
      "WATCH 3 2026-10-24T00:21:40.000Z: the cycle threw: token Bearer <redacted> leaked; next cycle at 2026-10-24T00:31:40.000Z",
      "WATCH 4 2026-10-24T00:31:40.000Z: CYCLE 4; stopping",
    ]);
  });

  it("runs no cycle when the signal has aborted, and sleep returns at once on an aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await watch({ everyMs: 1000, signal: ac.signal, cycle: async () => { throw new Error("never"); }, print: () => undefined })).toEqual({ cycles: 0, stopped: 0, threw: 0 });
    const t0 = Date.now();
    await sleep(60_000, ac.signal);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("TenantLedger", () => {
  it("passes on the tenant's dispositions and the fingerprints of its DNS runs", async () => {
    const got: { d: Disposition[]; f: ReferentFingerprint[] } = { d: [], f: [] };
    const inner: Ledger = { record: async (rows) => { got.d.push(...rows); return rows.length; }, recordFingerprints: async (rows) => { got.f.push(...rows); return rows.length; } };
    const ledger = new TenantLedger(inner, "t1", new Set(["dns-1"]));
    const d = (tenant: string) => ({ tenant_id: tenant }) as Disposition;
    const f = (run: string) => ({ obs_id: `o-${run}`, dns_run_id: run, fingerprint: "", resolved_at: "2026-10-24T00:00:00.000Z" });
    expect(await ledger.record([d("t1"), d("t2"), d("t1")])).toBe(2);
    expect(await ledger.recordFingerprints([f("dns-1"), f("dns-2")])).toBe(1);
    expect(got.d.map((x) => x.tenant_id)).toEqual(["t1", "t1"]);
    expect(got.f.map((x) => x.dns_run_id)).toEqual(["dns-1"]);
  });
});

// ---- the live steps with fakes ----------------------------------------------------------------------------

const redactor = new Redactor("loop-test-salt");

/** A Cloudflare v4 API with one zone of one A record and an audit log of `audit` rows; `auditStatus` answers the audit read. */
function cloudflareFetch(opts: { auditStatus?: number } = {}): FetchLike {
  const ok = (result: unknown, info: Record<string, unknown>) => new Response(JSON.stringify({ success: true, errors: [], messages: [], result, result_info: info }), { status: 200 });
  const rec = { id: "rec-0001", name: "www.example.invalid", type: "A", content: "192.0.2.10", ttl: 1, proxied: true };
  return async (url) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/client\/v4/, "");
    if (p === "/zones") return ok([{ id: "zone-0001", name: "example.invalid", account: { id: "acct-0001" } }], { page: 1, total_pages: 1, total_count: 1 });
    if (p === "/zones/zone-0001/dns_records") return ok(u.searchParams.get("per_page") === "1" ? [rec] : [rec], { page: 1, total_pages: 1, total_count: 1 });
    if (p === "/accounts/acct-0001/logs/audit") {
      if (opts.auditStatus && opts.auditStatus !== 200) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: opts.auditStatus });
      return ok([], { count: 0, cursor: "" });
    }
    return new Response("{}", { status: 404 });
  };
}

/** A Store that records the calls a collect or probe step makes. */
function fakeStore(log: string[]) {
  return {
    beginRun: async (r: { run_id: string; surface: string }) => { log.push(`begin ${r.surface}`); },
    finishRun: async (_id: string, n: number, status: string) => { log.push(`finish ${n} ${status}`); },
    insertDnsRecords: async (rows: readonly unknown[]) => { log.push(`dns_record ${rows.length}`); return rows.length; },
    insertObservations: async (rows: readonly unknown[]) => { log.push(`observation ${rows.length}`); return rows.length; },
    insertAuditEvents: async (rows: readonly unknown[]) => { log.push(`audit_event ${rows.length}`); return rows.length; },
    insertVaultCopies: async (rows: readonly unknown[]) => { log.push(`vault_copy ${rows.length}`); return rows.length; },
    insertProbes: async (rows: readonly unknown[]) => { log.push(`probe ${rows.length}`); return rows.length; },
  };
}

describe("the tickets step's stored urls", () => {
  it("go to the row with a deny-listed label pseudonymised, on insert and on update; other fields are untouched", async () => {
    const rows = new MemoryTicketRows();
    const labels = new Redactor("loop-test-salt", ["fixtureowner"]);
    const url = "https://github.com/fixtureowner/tickets/issues/7";
    const wrapped = labelledRows(rows, labels);
    const t = { ticket_id: "tkt-1", tenant_id: "t1", psa: "github" as const, external_id: null, url: null, type: "incident" as const, priority: "P1" as const, status: "open", action_id: null, finding_id: "fnd-1", created_at: "2026-10-24T00:00:00.000Z", updated_at: "2026-10-24T00:00:00.000Z" };
    await wrapped.insert([t, { ...t, ticket_id: "tkt-2", url }]);
    await wrapped.update("tkt-1", { external_id: "7", url, updated_at: "2026-10-24T00:00:01.000Z" });
    const pseudo = labels.text("fixtureowner");
    expect(pseudo).toMatch(/^word-[0-9a-f]{6}$/);
    expect(rows.rows.map((r) => r.url)).toEqual([`https://${labels.text("github.com")}/${pseudo}/tickets/issues/7`, `https://${labels.text("github.com")}/${pseudo}/tickets/issues/7`]);
    expect(rows.rows[0].external_id).toBe("7");
    expect(Object.keys(countLabels(JSON.stringify(rows.rows), ["fixtureowner"]))).toEqual([]);
  });

  it("and the step's trace lines pass the same redactor", () => {
    const inner = new MemTracer("loop_test", {});
    new LabelTracer(inner, new Redactor("loop-test-salt", ["fixtureowner"])).emit({ agent: "psa", action: "triage", status: "ok", output_summary: "created #7 https://github.com/fixtureowner/tickets/issues/7" });
    expect(inner.events[0].output_summary).toMatch(/^created #7 https:\/\/host-[0-9a-f]{6}\.com\/word-[0-9a-f]{6}\/tickets\/issues\/7$/);
  });
});

describe("the collect, probe and validate steps", () => {
  const now = () => new Date("2026-10-24T12:00:00.000Z");

  it("collect:cloudflare writes the DNS run, then the audit run, in the collector's order; the vault off gives no commit", async () => {
    const log: string[] = [];
    const r = await collectCloudflareStep({ tenant: "t1", cf: new Cloudflare({ token: "fixture-token-not-a-secret", fetch: cloudflareFetch() }), redactor, store: fakeStore(log), vault: null, now });
    expect(log).toEqual(["begin cloudflare.dns", "dns_record 1", "observation 5", "finish 1 complete", "begin cloudflare.audit", "audit_event 0", "finish 0 complete"]);
    expect(r.ok).toBe(true);
    expect(r.commits).toEqual([]);
    expect(r.summary).toMatch(/^collect:cloudflare: dns run-[0-9a-f]{16} 1\/1 complete \(1 zones, 1 records\), audit run-[0-9a-f]{16} 0\/0 complete; vault off \(DRIFT_VAULT_DIR is blank\)$/);
    expect(r.summary).not.toContain("example.invalid");
  });

  it("collect:cloudflare fails when a run finishes other than complete, with the run's error", async () => {
    const r = await collectCloudflareStep({ tenant: "t1", cf: new Cloudflare({ token: "fixture-token-not-a-secret", fetch: cloudflareFetch({ auditStatus: 403 }) }), redactor, store: fakeStore([]), vault: null, now });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^a Cloudflare run finished other than complete \(dns complete, audit failed\): cloudflare\.audit: Cloudflare 403 GET \/accounts\/acct-0001\/logs\/audit: 10000: Authentication error$/);
  });

  const linuxResult = (status: CollectionRun["status"]): CollectResult => {
    const run: CollectionRun = { run_id: "run-l1", tenant_id: "t1", surface: "linux.nginx", host: "host-aaaaaa", started_at: "2026-10-24T12:00:00.000Z", finished_at: "2026-10-24T12:00:03.000Z", expected_count: 3, observed_count: status === "complete" ? 3 : 2, status };
    const summary = { host: "host-aaaaaa", run, servers: [{}, {}], not_readable: status === "complete" ? [] : ["/etc/nginx/conf.d/word-aaaaaa.conf"] } as unknown as CollectResult["summary"];
    return { rows: { ...EMPTY_ROWS(), collection_run: [run] }, summary, ssh: { code: 0, latencyMs: 3, stderr: "", bytes: 10 }, files: {}, links: {} };
  };

  it("collect:linux stores the host's rows and is ok on a complete run; a partial run fails the step with what was not read", async () => {
    const stored: string[] = [];
    const storeRows = async (_s: Store, rows: CollectResult["rows"]) => { stored.push(rows.collection_run[0].run_id); return { collection_run: 1, observation: 0 }; };
    const ok = await collectLinuxStep("fixture-host", { tenant: "t1", redactor, store: {} as Store, vault: null, collect: async () => linuxResult("complete"), storeRows });
    expect(ok).toMatchObject({ ok: true, commits: [], summary: "collect:linux fixture-host: host-aaaaaa run run-l1 3/3 complete, 0 observation(s) written of 0, 2 server blocks, 0 backup items; vault off (DRIFT_VAULT_DIR is blank)" });
    const partial = await collectLinuxStep("fixture-host", { tenant: "t1", redactor, store: {} as Store, vault: null, collect: async () => linuxResult("partial"), storeRows });
    expect(partial.ok).toBe(false);
    expect(partial.reason).toBe("run run-l1 of fixture-host is partial (not readable: /etc/nginx/conf.d/word-aaaaaa.conf)");
    expect(stored).toEqual(["run-l1", "run-l1"]);
  });

  it("probe is ok on a complete run and fails when the population cannot be read", async () => {
    const log: string[] = [];
    const empty = await probeStep({ tenant: "t1", redactor, sink: fakeStore(log), population: async () => [], deps: { now } });
    expect(empty.ok).toBe(true);
    expect(empty.summary).toMatch(/^probe: run run-[0-9a-f]{16} 0\/0 complete, 0 name\(s\); http 0 ok, 0 fail; dns 0 ok, 0 fail; tls 0 ok, 0 fail; 0 probe row\(s\) written$/);
    const failed = await probeStep({ tenant: "t1", redactor, sink: fakeStore(log), population: async () => { throw new Error("Cloudflare 403 GET /zones"); }, deps: { now } });
    expect(failed.ok).toBe(false);
    expect(failed.reason).toMatch(/is failed: population: Cloudflare 403 GET \/zones$/);
    expect(log).toEqual(["begin probe", "probe 0", "finish 0 complete", "begin probe", "finish 0 failed"]);
  });

  it("validate validates nothing when the cycle made no new vault commit", async () => {
    expect(await validateStep([], { tenant: "t1", vaultDir: "", store: null, redactor })).toEqual({ ok: true, summary: "validate:copies: no new vault commit this cycle; nothing validated" });
  });
});

// ---- pass, act, tickets and document over sql.js -----------------------------------------------------------

describe("the pass, act, tickets and document steps over the policy fixture", () => {
  let base: Base;
  let world: World;
  let engine: SqlJsEngine;
  let layer: DataLayer;
  let dir: string;
  beforeAll(async () => {
    base = buildBase();
    world = await buildWorld(base);
    engine = await SqlJsEngine.create();
    engine.loadBundle(structuredClone(base.bundle));
    layer = new DataLayer(engine);
    dir = mkdtempSync(path.join(tmpdir(), "drift-loop-"));
  });
  afterAll(() => {
    world.cleanup();
    engine.close();
    base.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a tenant with no collection run", async () => {
    await expect(passStep(layer, { tenant: "nobody", ledger: null })).rejects.toThrow(LoopError);
  });

  it("without a ledger, prints the pass's own decisions and records nothing", async () => {
    const r = await passStep(layer, { tenant: TENANT, ledger: null, decidedAt: AT, world: new DriftWorld("loop_test") });
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.lines.length).toBe(2 * r.findings.length);
    expect(r.lines.slice(r.findings.length).every((l) => l.startsWith("DISPOSITION ") && l.endsWith("(not recorded: no ledger)"))).toBe(true);
    expect(r.summary).toContain("ledger: none, nothing recorded");
  });

  it("runs as one cycle with collect, probe and validate skipped: the pass records, act plans, tickets plan, the document is written", async () => {
    const out = path.join(dir, "document.md");
    const tracer = new MemTracer("loop_test", { model: "none" });
    const printed: string[] = [];
    const never = async (): Promise<never> => { throw new Error("a skipped step ran"); };
    const deps = world.deps({ layer, sink: null, tracer });
    const steps: CycleSteps = {
      collectCloudflare: never, collectLinux: never, probe: never, validate: never,
      pass: async () => {
        const r = await passStep(layer, { tenant: TENANT, ledger: new MemoryLedger(engine), decidedAt: AT, world: new DriftWorld("loop_test"), tracer });
        return { ok: true, summary: r.summary, pass: r };
      },
      act: (p) => actStep(p, { apply: false, redactor: base.redactor, deps: { ...deps, findingOf: async (d) => p.findings.find((f) => f.id === d.finding_id) ?? null } }),
      tickets: (p) => ticketsStep(layer, p, { adapter: () => { throw new Error("a dry run builds no adapter"); }, rows: null, dryRun: true, redactor: base.redactor, labels: base.redactor, deny: [], tracer, now: () => AT }),
      document: (p) => documentStep(layer, p, { out, root: dir, deny: ["zz-label-absent"], source: "sql.js over test/fixtures/policy-bundle.json", tracer }),
    };
    const res = await runCycle({ tenant: TENANT, apply: false, aliases: ["fixture-host"], skip: parseSkip(["collect,probe,validate"]) }, steps, { tracer, print: (l) => printed.push(l) });
    expect(res.stopped).toBeNull();
    expect(res.steps.map((s) => `${s.step} ${s.status}`)).toEqual([
      "collect:cloudflare skipped", "collect:linux fixture-host skipped", "probe skipped", "validate skipped", "pass ok", "act ok", "tickets ok", "document ok",
    ]);
    const pass = res.pass!;
    // every finding of the pass is in the ledger under the id the pass gave it, decided at the given instant
    const ledger = new Map(objects(await layer.run(DISPOSITIONS_SQL)).map((d) => [d.disposition_id, d]));
    for (const f of pass.findings) expect(ledger.get(dispositionIdOf(f))?.decided_at).toBe(AT);
    expect(pass.kept).toBe(0);
    expect(pass.summary).toContain(`PASS: tenant ${TENANT}, decided at ${AT}: `);
    // the fixture world's bundle: the policy fixture plus the server_name rows of app.conf and blog.conf
    expect(pass.summary).toContain(`${pass.findings.length} finding(s) (approved_missing 1, changed_since_backup 3, drift_vs_approved 5, found_but_different 2, proxy_split 1); verbs: ADOPT 2, HOLD 5, ESCALATE 1, ROLLBACK 3, FIX 1; decided by policy 12;`);
    // the dry run plans the fixture's five actions and writes no action row
    expect(res.steps[5].summary).toMatch(/^act: dry run: 5 actions planned \(rollback_file 2, revert_record 1, investigate 1, fix 1\), 1 of them refused on --apply; 0 already recorded; 0 action rows written; scope \d+ disposition\(s\) of \d+ run\(s\)/);
    expect(objects(await tenantActions(layer, TENANT)).length).toBe(0);
    expect(res.steps[6].summary).toMatch(new RegExp(`^TICKETS: tenant client-a, ${pass.findings.length} finding\\(s\\), .*; dry run, nothing sent or written$`));
    expect(res.steps[7].summary).toMatch(/^document: document\.md written for client-a, \d+ lines, \d+ finding\(s\) open, \d+ queries; deny-list probe 0 of 1 label\(s\); decided at 2026-10-23T03:00:00\.000Z$/);
    expect(readFileSync(out, "utf8")).toContain(TENANT);
    expect(printed.at(-1)).toMatch(/^CYCLE: tenant client-a, dry run .*: 8 step\(s\): ok 4, skipped 4, failed 0, not run 0; completed;/);
  });

  it("a second pass over the same runs keeps the ledger's rows and says so on each line", async () => {
    const later = "2026-10-23T05:00:00.000Z";
    const r = await passStep(layer, { tenant: TENANT, ledger: new MemoryLedger(engine), decidedAt: later, world: new DriftWorld("loop_test") });
    expect(r.pass.ledger?.dispositions).toBe(0);
    expect(r.kept).toBe(r.findings.length);
    const lines = r.lines.slice(r.findings.length);
    expect(lines.every((l) => / \[recorded 2026-10-23T03:00:00\.000Z by an earlier pass over run [^\]]+\]$/.test(l))).toBe(true);
    expect(r.summary).toContain(`ledger: 0 disposition(s) and 0 referent fingerprint(s) written, ${r.findings.length} finding(s) on rows an earlier pass wrote`);
  });

  it("the document step writes nothing when the deny-list probe matches", async () => {
    const out = path.join(dir, "denied.md");
    const r = await documentStep(layer, passOf(TENANT), { out, root: dir, deny: [TENANT], source: "sql.js", tracer: undefined });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/^document: deny-list probe: 1 of 1 configured label\(s\) appear in the page; nothing written$/);
    expect(existsSync(out)).toBe(false);
  });
});
