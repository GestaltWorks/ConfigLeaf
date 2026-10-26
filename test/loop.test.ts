// The loop (src/loop/): the cycle's order, skips and stop rule over fake steps; the watcher over a fake clock; the
// tenant ledger; each live step with fakes in place of the hosts, Cloudflare, the probes and the Store; and the pass,
// act (dry run), tickets (dry run) and document steps over sql.js with test/fixtures/policy-bundle.json and the
// Actor's fixture vault (test/fixtures/actions/world.ts), run as one cycle with collect, probe and validate skipped;
// and the CountingEngine the live cycle reads its Zetaris queries from, its tally against the pass's trace lines; and
// the live pass's refresh of the Zetaris copy of the lessons and the rules, over a fake putFiles.
// Offline and deterministic: no host, no Cloudflare, no Nightshift, no GitHub, no Postgres.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/config.ts"; // loads .env into process.env
import { Cloudflare, type FetchLike } from "../src/collectors/cloudflare.ts";
import type { CollectResult } from "../src/collectors/linux.ts";
import { EMPTY_ROWS } from "../src/collectors/types.ts";
import { DataLayer, DataLayerError } from "../src/data/layer.ts";
import { CountingEngine, tallySince } from "../src/data/engines/counting.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { DISPOSITIONS_SQL, objects, tenantActions } from "../src/data/queries.ts";
import type { ActionOutcome } from "../src/actions/plan.ts";
import type { CauseClass, CollectionRun, Disposition, FindingCause, ReferentFingerprint } from "../src/data/rows.ts";
import type { Store } from "../src/data/store.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { MemoryLedger, type Ledger } from "../src/ledger.ts";
import { SKIPPABLE, parseSkip, runCycle, stepNames, type CycleSteps, type StepReport } from "../src/loop/cycle.ts";
import { ADOPTION_ENTITY, LoopError, TenantLedger, adoptionCheckSql, dispositionIdOf, passStep, type PassStep } from "../src/loop/pass.ts";
import { EXCEPTION_IN_FORCE } from "../src/data/files.ts";
import { actStep, collectCloudflareStep, collectLinuxStep, documentStep, explainStep, labelledRows, probeStep, ticketsStep, validateStep } from "../src/loop/steps.ts";
import { CAUSE_CLASSES } from "../src/explain/cause.ts";
import { MemoryCauseSink, causesByDisposition, type ExplainResult } from "../src/explain/explain.ts";
import { PLAIN, Table, explainView, passView, thousands } from "../src/loop/present.ts";
import { LabelTracer } from "../src/loop/trace.ts";
import { sleep, watch } from "../src/loop/watch.ts";
import { MemoryTicketRows } from "../src/psa/step.ts";
import { Redactor, countLabels } from "../src/redactor.ts";
import { AT, TENANT, buildBase, buildWorld, type Base, type World } from "./fixtures/actions/world.ts";
import { readCopyState, refreshFiles } from "../src/zetaris/filestore.ts";
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
    explain: async (p) => { calls.push(`explain ${p.tenant}`); return ok("explain"); },
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
  it("runs every step in order, hands the collect steps' commits to validate and the pass to explain, act, tickets and document", async () => {
    const calls: string[] = [];
    const printed: string[] = [];
    const tracer = new MemTracer("loop_test", { model: "none" });
    const res = await runCycle({ tenant: "t1", apply: false, aliases: ["a1", "a2"], skip: new Set() }, fakeSteps(calls), { tracer, print: (l) => printed.push(l), clock: ticking() });
    expect(calls).toEqual(["collect:cloudflare", "collect:linux a1", "collect:linux a2", "probe", "validate t1/cloudflare,t1/a1,t1/a2", "pass", "explain t1", "act t1", "tickets t1", "document t1"]);
    expect(res.steps.map((s) => `${s.step} ${s.status}`)).toEqual(stepNames(["a1", "a2"]).map((s) => `${s} ok`));
    expect(stepNames([]).slice(-5)).toEqual(["pass", "explain", "act", "tickets", "document"]);
    expect(res.stopped).toBeNull();
    // the table: the header, one row per step from its summary (the pass's from its result), each time at column 90
    expect(printed[0]).toBe("ConfigLeaf · cycle · tenant t1 · 1970-01-01 00:00 UTC · dry run, nothing changed");
    expect(printed[1]).toBe(`${"  collect   cloudflare    fine".padEnd(85)}0.1 s`);
    expect(printed[2]).toBe(`${"  collect   a1            fine".padEnd(85)}0.1 s`);
    expect(printed[6]).toBe(`${"  pass      0 findings".padEnd(85)}0.1 s`);
    expect(printed[7]).toBe(`${"  explain   fine".padEnd(85)}0.1 s`);
    expect(printed[10]).toBe(`${"  document  fine".padEnd(85)}0.1 s`);
    expect(printed.slice(1, 11).every((l) => l.length === 90)).toBe(true);
    // the what-happened block between the last row and the done line, after a blank line
    expect(printed.slice(11, -1)).toEqual(["", "what happened", "  Nothing changed on the estate; the pass found every setting in order."]);
    expect(printed.at(-1)).toMatch(/^done · 10 steps · \d+\.\d s$/);
    expect(printed.join("\n")).not.toMatch(/cycle: \[|CYCLE:/);
    expect(res.summary).toMatch(/^CYCLE: tenant t1, dry run \(act plans and writes nothing to a host or a zone; --apply performs it\): 10 step\(s\): ok 10, skipped 0, failed 0, not run 0; completed; \d+\.\d s$/);
    // one trace line per step and one for the cycle, agent cycle, the step's time as latency
    expect(tracer.events.length).toBe(11);
    expect(tracer.events.every((e) => e.agent === "cycle" && e.action === "triage" && e.model_requested === "none")).toBe(true);
    expect(tracer.events[3]).toMatchObject({ input_summary: "cycle t1 [4/10] probe", status: "ok", latency_ms: 100 });
  });

  it("names the cycle's Zetaris queries on the done line and at the end of the CYCLE summary when the hook gives them; without it, neither does", async () => {
    const printed: string[] = [];
    const tracer = new MemTracer("loop_test", { model: "none" });
    const tally = { queries: 502, rows: 27_765, failed: 0, ms: 86_400 };
    const res = await runCycle({ tenant: "t1", apply: false, aliases: [], skip: new Set() }, fakeSteps([]), { tracer, print: (l) => printed.push(l), clock: ticking(), trace: "logs/cycle_test.jsonl", queries: () => tally });
    expect(printed.at(-1)).toMatch(/^done · 8 steps · \d+\.\d s · 502 Zetaris queries, 0 failed · trace logs\/cycle_test\.jsonl$/);
    expect(res.summary).toMatch(/; completed; \d+\.\d s; zetaris: 502 queries, 27,765 rows, 0 failed$/);
    expect(tracer.events.at(-1)?.output_summary).toBe(res.summary);
    const without: string[] = [];
    const bare = await runCycle({ tenant: "t1", apply: false, aliases: [], skip: new Set() }, fakeSteps([]), { print: (l) => without.push(l), clock: ticking(), trace: "logs/cycle_test.jsonl" });
    expect(without.at(-1)).toMatch(/^done · 8 steps · \d+\.\d s · trace logs\/cycle_test\.jsonl$/);
    expect(bare.summary).toMatch(/; completed; \d+\.\d s$/);
    expect(without.join("\n")).not.toMatch(/zetaris/i);
  });

  it("skips the named groups, runs the pass in every cycle, and gives validate no commit when collect is skipped", async () => {
    const calls: string[] = [];
    const printed: string[] = [];
    const res = await runCycle({ tenant: "t1", apply: true, aliases: ["a1"], skip: parseSkip(["collect,probe", "tickets"]) }, fakeSteps(calls), { print: (l) => printed.push(l), clock: ticking() });
    expect(calls).toEqual(["validate ", "pass", "explain t1", "act t1", "document t1"]);
    expect(res.steps.map((s) => s.status)).toEqual(["skipped", "skipped", "skipped", "ok", "ok", "ok", "ok", "skipped", "ok"]);
    expect(res.steps[0].summary).toBe("skipped (--skip collect)");
    expect(res.summary).toMatch(/^CYCLE: tenant t1, applied \(act carries out its plan\): 9 step\(s\): ok 5, skipped 4, failed 0, not run 0; completed;/);
    expect(printed[0]).toMatch(/ · applying changes$/);
    expect(printed.slice(1, 4)).toEqual(["  collect   cloudflare    skipped", "  collect   a1            skipped", "  probe     skipped"]);
    expect(printed[8]).toBe("  tickets   skipped");
    expect(printed.at(-1)).toMatch(/^done · 9 steps · 4 skipped · \d+\.\d s$/);
  });

  it("stops at the first failing step with its reason; every later step is not run", async () => {
    const calls: string[] = [];
    const printed: string[] = [];
    const steps = fakeSteps(calls, { probe: async () => { calls.push("probe"); return { ok: false, summary: "probe: run r1 100/111 partial", reason: "probe run r1 is partial" }; } });
    const res = await runCycle({ tenant: "t1", apply: false, aliases: [], skip: new Set() }, steps, { print: (l) => printed.push(l), clock: ticking(), trace: "logs/cycle_test.jsonl" });
    expect(calls).toEqual(["collect:cloudflare", "probe"]);
    expect(res.stopped).toEqual({ step: "probe", reason: "probe run r1 is partial" });
    expect(res.steps.map((s) => s.status)).toEqual(["ok", "failed", "not_run", "not_run", "not_run", "not_run", "not_run", "not_run"]);
    expect(res.steps[2].summary).toBe("the cycle stopped at probe");
    expect(res.summary).toContain("ok 1, skipped 0, failed 1, not run 6; stopped at probe: probe run r1 is partial;");
    // the failing step's row carries its reason; a step not run has no row
    expect(printed).toHaveLength(4);
    expect(printed[2]).toBe(`${"  probe     failed        probe run r1 is partial".padEnd(85)}0.1 s`);
    expect(printed[3]).toMatch(/^stopped at probe · 2 of 8 · \d+\.\d s · trace logs\/cycle_test\.jsonl$/);
  });

  it("the explain row counts the causes by class, and each cause reaches the what-happened block on its action's line", async () => {
    const at = "2026-10-24T00:00:00.000Z";
    const cause = (n: string, cls: CauseClass, summary: string, occurredAt: string | null): FindingCause => ({
      cause_id: `cause-${n}`, tenant_id: "t1", finding_id: `fnd-${n}`, disposition_id: `dsp-${n}`, class: cls, actor: null, mechanism: null, occurred_at: occurredAt, source_host: null,
      evidence_ids: "[]", diff: null, summary, window_from: "2026-10-23T00:00:00.000Z", window_to: at, decided_at: at,
    });
    const EDIT = "The file was changed at 23:52 UTC on 23 Oct by user-3f2a1c over ssh from ip-7c1d2e (sudo tee).";
    const UNKNOWN = "No record of who changed it: the journal window of 24 h holds 0 writes to the file.";
    const causes = [
      cause("1", "operator_edit", EDIT, "2026-10-23T23:52:00.000Z"), cause("2", "agent", "The last change to the file is the agent's own rollback at 23:30 UTC on 23 Oct.", "2026-10-23T23:30:00.000Z"),
      cause("3", "unknown", UNKNOWN, null), cause("4", "unknown", UNKNOWN, null),
    ];
    const explain: ExplainResult = {
      tenant: "t1", decidedAt: at, causes: causes.map((c) => ({ finding_id: c.finding_id, disposition_id: c.disposition_id, verb: "ROLLBACK", finding_class: "drift_vs_approved", cause: c, evidence: [] })),
      counts: Object.fromEntries(CAUSE_CLASSES.map((k) => [k, causes.filter((c) => c.class === k).length])) as ExplainResult["counts"],
      searched: { journal: 10, cloudflare: 1, actions: 2 }, written: 4, errors: [],
    };
    const restored: ActionOutcome = {
      action: {
        action_id: "act-1", tenant_id: "t1", kind: "rollback_file", target: "linux.nginx host-aaaaaa /etc/nginx/conf.d/app.conf file", before_hash: "sha256:aa", after_hash: "sha256:bb", vault_commit: "5dde7698",
        verification: "probe-1", receipts: "", status: "done", reason: "restored", record: "", started_at: "2026-10-24T00:01:00.000Z", finished_at: "2026-10-24T00:01:04.000Z", disposition_id: "dsp-1",
      },
      reason: "restored", record: [],
    };
    const printed: string[] = [];
    const steps = fakeSteps([], {
      explain: async () => ({ ok: true, summary: "explain: tenant t1, 4 cause(s)", view: explainView({ causes }), explain }),
      act: async () => ({ ok: true, summary: "act: applied", act: { apply: true, plan: [], outcomes: [restored] } }),
    });
    const res = await runCycle({ tenant: "t1", apply: true, aliases: [], skip: parseSkip(["collect,probe,validate"]) }, steps, { print: (l) => printed.push(l), clock: ticking() });
    expect(res.explain).toBe(explain);
    // the explain row counts the causes; under it a block per cause, its sentence on lines of its own
    const row = printed.indexOf(`${"  explain   4 causes      operator 1 · agent 1 · unknown 2".padEnd(85)}0.1 s`);
    expect(row).toBeGreaterThan(0);
    expect(printed.slice(row + 1, row + 5)).toEqual([
      "            ROLLBACK  drifted from the approved value · operator",
      "                      The file was changed at 23:52 UTC on 23 Oct by user-3f2a1c over ssh",
      "                      from ip-7c1d2e (sudo tee).",
      "            ROLLBACK  drifted from the approved value · agent",
    ]);
    // the block: the action's sentence and its cause, wrapped at the width, its further lines four columns in
    const block = printed.slice(printed.indexOf("what happened") + 1, -1);
    expect(block.every((l) => l.length <= 90 && /^ {2}\S| {4}\S/.test(l))).toBe(true);
    expect(block.map((l) => l.trim()).join(" ")).toBe(`A vhost file drifted from its approved copy; the agent restored it, nginx reloaded, 1 probe passed. ${EDIT.slice(0, -1)}, 9 minutes before the agent restored it.`);
  });

  it("the explain step never stops the cycle: a read that fails reads not explained on its row, with the reason, and traces the failure", async () => {
    const broken = { run: async () => { throw new Error("relation finding_cause does not exist; the setup registers it"); } } as unknown as DataLayer;
    const rollback = { id: "fnd-1", verb: "ROLLBACK", finding: { tenant_id: "t1", class: "drift_vs_approved" } } as unknown as PassStep["findings"][number];
    const tracer = new MemTracer("loop_test", { model: "none" });
    const r = await explainStep(broken, { ...passOf(), findings: [rollback] }, { sink: null, vault: null, redactor: new Redactor("loop-test-salt", []), tracer });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("explain: tenant t1, not explained (relation finding_cause does not exist; the setup registers it); act runs as before");
    expect(r.explain).toBeUndefined();
    expect(new Table(PLAIN).row("explain", r.view!, 120)[0]).toBe(`${"  explain   0 causes      not explained · relation finding_cause does not exist".padEnd(85)}0.1 s`);
    expect(tracer.events.filter((e) => e.agent === "explainer").map((e) => e.status)).toEqual(["failed"]);
    // a pass that moves on nothing has nothing to explain and reads nothing
    const none = await explainStep(broken, passOf(), { sink: null, vault: null, redactor: new Redactor("loop-test-salt", []) });
    expect(new Table(PLAIN).row("explain", none.view!, 0)[0]).toBe(`${"  explain   0 causes      nothing to explain".padEnd(85)}0.0 s`);
  });

  it("shows each collect:linux row's alias as the cycle was given it; the row's detail passes the redactor", async () => {
    const printed: string[] = [];
    const scrub = (s: string): string => s.replace(/fixture-alias/g, "word-aaaaaa");
    const steps = fakeSteps([], { collectLinux: async (a) => ({ ok: true, summary: `collect:linux ${a}: read ${a}`, commits: [] }) });
    await runCycle({ tenant: "t1", apply: false, aliases: ["fixture-alias"], skip: new Set() }, steps, { print: (l) => printed.push(l), clock: ticking(), scrub });
    expect(printed[2]).toBe(`${"  collect   fixture-alias read word-aaaaaa".padEnd(85)}0.1 s`);
    const skipped: string[] = [];
    await runCycle({ tenant: "t1", apply: false, aliases: ["fixture-alias"], skip: parseSkip(["collect"]) }, fakeSteps([]), { print: (l) => skipped.push(l), clock: ticking(), scrub });
    expect(skipped.slice(1, 3)).toEqual(["  collect   cloudflare    skipped", "  collect   fixture-alias skipped"]);
  });

  it("prints the header and the done line only under quiet, and each step's full line after its row under verbose", async () => {
    const quiet: string[] = [];
    await runCycle({ tenant: "t1", apply: false, aliases: [], skip: new Set() }, fakeSteps([]), { print: (l) => quiet.push(l), clock: ticking(), present: { ...PLAIN, quiet: true } });
    expect(quiet).toHaveLength(2);
    expect(quiet[0]).toMatch(/^ConfigLeaf · cycle · tenant t1 · /);
    expect(quiet[1]).toMatch(/^done · 8 steps · /);
    const verbose: string[] = [];
    const res = await runCycle({ tenant: "t1", apply: false, aliases: [], skip: new Set() }, fakeSteps([]), { print: (l) => verbose.push(l), clock: ticking(), present: { ...PLAIN, verbose: true } });
    expect(verbose[1]).toMatch(/^  collect   cloudflare    fine +0\.1 s$/);
    expect(verbose[2]).toBe("cycle: [1/8] collect:cloudflare ok in 0.1 s: collect:cloudflare: fine");
    expect(verbose[3]).toMatch(/^  probe     fine +0\.1 s$/);
    expect(verbose[4]).toBe("cycle: [2/8] probe ok in 0.1 s: probe: fine");
    expect(verbose.at(-2)).toMatch(/^done · 8 steps · /);
    expect(verbose.at(-1)).toBe(res.summary);
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
    // each cycle prints its own table; the watcher the time of the next one, a throw as a failed row, a blank line between cycles
    expect(printed).toEqual([
      "next cycle 2 at 2026-10-24 00:10 UTC",
      "",
      "next cycle 3 at 2026-10-24 00:21 UTC",
      "",
      "  cycle     failed        the cycle threw: token Bearer <redacted> leaked",
      "next cycle 4 at 2026-10-24 00:31 UTC",
      "",
      "stopping after cycle 4",
    ]);
  });

  it("adds the full WATCH line after its short one under verbose", async () => {
    let t = Date.parse("2026-10-24T00:00:00.000Z");
    const ac = new AbortController();
    const printed: string[] = [];
    await watch({
      everyMs: 600_000, signal: ac.signal, now: () => new Date(t), print: (l) => printed.push(l), present: { ...PLAIN, verbose: true },
      sleep: async (ms) => { t += ms; },
      cycle: async (n) => { t += 60_000; if (n === 2) ac.abort(); return { summary: `CYCLE ${n}`, stopped: null }; },
    });
    expect(printed).toEqual([
      "next cycle 2 at 2026-10-24 00:10 UTC",
      "WATCH 1 2026-10-24T00:00:00.000Z: CYCLE 1; next cycle at 2026-10-24T00:10:00.000Z",
      "",
      "stopping after cycle 2",
      "WATCH 2 2026-10-24T00:10:00.000Z: CYCLE 2; stopping",
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
    // the row's subject is the alias as LINUX_HOSTS names it, while the summary carries the tenant's pseudonym for it
    const words = new Redactor("loop-test-salt", ["fixture"]);
    const named = await collectLinuxStep("fixture-host", { tenant: "t1", redactor: words, store: {} as Store, vault: null, collect: async () => linuxResult("complete"), storeRows });
    expect(named.summary).toMatch(/^collect:linux word-[0-9a-f]{6}-host: /);
    expect(named.view).toEqual({ subject: "fixture-host", alias: true, parts: ["3 files", "2 blocks", "0 settings", [{ text: "vault off", tone: "dim" }]] });
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
    expect(await validateStep([], { tenant: "t1", vaultDir: "", store: null, redactor })).toEqual({
      ok: true, summary: "validate:copies: no new vault commit this cycle; nothing validated", view: { parts: ["no new vault commit", "nothing validated"] },
    });
  });
});

// ---- pass, act, tickets and document over sql.js -----------------------------------------------------------

describe("the pass, act, tickets and document steps over the policy fixture", () => {
  let base: Base;
  let world: World;
  let engine: SqlJsEngine;
  let layer: DataLayer;
  let dir: string;
  // buildBase and buildWorld write the fixture vault's git repositories on disk: seconds in the full parallel run
  beforeAll(async () => {
    base = buildBase();
    world = await buildWorld(base);
    engine = await SqlJsEngine.create();
    engine.loadBundle(structuredClone(base.bundle));
    layer = new DataLayer(engine);
    dir = mkdtempSync(path.join(tmpdir(), "drift-loop-"));
  }, 30_000);
  afterAll(() => {
    world.cleanup();
    engine.close();
    base.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a tenant with no collection run", async () => {
    await expect(passStep(layer, { tenant: "nobody", ledger: null })).rejects.toThrow(LoopError);
  });

  it("a CountingEngine counts each query the pass sends, its rows and none failed, equal to the pass's query lines in the trace; the pass row names them", async () => {
    const counting = new CountingEngine(engine);
    expect([counting.name, counting.qualify("observation")]).toEqual([engine.name, engine.qualify("observation")]);
    const tracer = new MemTracer("loop_test", { model: "none" });
    const before = counting.tally();
    const r = await passStep(new DataLayer(counting), { tenant: TENANT, ledger: null, decidedAt: AT, world: new DriftWorld("loop_test"), tracer });
    const sent = tallySince(before, counting.tally());
    const queries = tracer.events.filter((e) => e.action === "query");
    expect(sent.queries).toBeGreaterThan(10);
    expect(sent.queries).toBe(queries.length);
    expect(sent.rows).toBe(queries.reduce((n, e) => n + Number(/^(\d+) rows$/.exec(e.output_summary ?? "")?.[1]), 0));
    expect(sent.failed).toBe(0);
    const line = new Table(PLAIN).row("pass", passView(r, { datasource: "DRIFT", ...sent }), null)[1];
    expect(line).toBe(`            Zetaris   ${sent.queries} queries · ${thousands(sent.rows)} rows · 0 failed`);
  });

  it("on Zetaris the pass reads exception_in_force once, after the Decider, over drift_usl.adoption: this pass's instant with a ledger, the latest recorded pass without; a failed read is carried, never thrown; sql.js reads nothing", async () => {
    const own = await SqlJsEngine.create();
    own.loadBundle(structuredClone(base.bundle));
    const reads: string[] = [];
    let answer: () => Promise<{ queryId: string; columns: string[]; rows: string[][]; rowCount: number; total: number; latencyMs: number; raw: unknown }> = async () => ({ queryId: "q", columns: ["decided_at", "adoptions", "in_force"], rows: [["2026-10-25T21:12:42.005Z", "23", "22"]], rowCount: 1, total: 1, latencyMs: 1, raw: {} });
    // sql.js answering under Zetaris's name, the USL read answered as Zetaris would
    const live = { name: "zetaris" as const, qualify: (t: string) => own.qualify(t), run: async (sql: string, o?: Parameters<SqlJsEngine["run"]>[1]) => (sql.includes(ADOPTION_ENTITY) ? (reads.push(sql), answer()) : own.run(sql, o)) };
    const dry = await passStep(new DataLayer(live), { tenant: TENANT, ledger: null, decidedAt: AT, world: new DriftWorld("loop_test") });
    expect(reads).toEqual([adoptionCheckSql(TENANT, null)]);
    expect(reads[0]).toBe(`SELECT decided_at, COUNT(*) AS adoptions, SUM(CASE WHEN ${EXCEPTION_IN_FORCE} THEN 1 ELSE 0 END) AS in_force FROM lightning.metastore.drift.drift_usl.adoption WHERE tenant_id = '${TENANT}' GROUP BY decided_at ORDER BY decided_at DESC LIMIT 1`);
    expect(dry.adoptions).toEqual({ rule: "exception_in_force", of: "recorded", decidedAt: "2026-10-25T21:12:42.005Z", adoptions: 23, inForce: 22 });
    expect(dry.summary.endsWith("; DQ exception_in_force 22 of 23 adoptions of the pass recorded at 2026-10-25T21:12:42.005Z")).toBe(true);
    // with a ledger: the instant of this pass, after the ledger write
    answer = async () => ({ queryId: "q", columns: ["decided_at", "adoptions", "in_force"], rows: [], rowCount: 0, total: 0, latencyMs: 1, raw: {} });
    const recorded = await passStep(new DataLayer(live), { tenant: TENANT, ledger: new MemoryLedger(own), decidedAt: AT, world: new DriftWorld("loop_test") });
    expect(reads[1]).toBe(adoptionCheckSql(TENANT, AT));
    expect(reads[1]).toContain(` AND decided_at = '${AT}' GROUP BY`);
    expect(recorded.adoptions).toEqual({ rule: "exception_in_force", of: "pass", decidedAt: AT, adoptions: 0, inForce: 0 });
    // a failed read: the pass returns, the error on the check and in the summary
    answer = async () => { throw new Error("Zetaris 400: Table or view not found: drift_usl.adoption"); };
    const failed = await passStep(new DataLayer(live), { tenant: TENANT, ledger: null, decidedAt: AT, world: new DriftWorld("loop_test") });
    expect(failed.adoptions).toEqual({ rule: "exception_in_force", error: "Zetaris 400: Table or view not found: drift_usl.adoption" });
    expect(failed.findings.map((f) => f.verb)).toEqual(dry.findings.map((f) => f.verb));
    expect(failed.summary).toContain("; DQ exception_in_force not read: Zetaris 400");
    // on sql.js nothing is read and the summary is as before
    const lite = await passStep(new DataLayer(own), { tenant: TENANT, ledger: null, decidedAt: AT, world: new DriftWorld("loop_test") });
    expect(lite.adoptions).toBeUndefined();
    expect(lite.summary).not.toContain("exception_in_force");
    expect(reads).toHaveLength(3);
    own.close();
  });

  it("live, the file tables' copy is refreshed first, before any query and the DQ read, through a fake putFiles: put when the store changed, nothing when current, a failed put carried", async () => {
    const own = await SqlJsEngine.create();
    own.loadBundle(structuredClone(base.bundle));
    const order: string[] = [];
    const dqRow = { queryId: "q", columns: ["decided_at", "adoptions", "in_force"], rows: [[AT, "1", "1"]], rowCount: 1, total: 1, latencyMs: 1, raw: {} };
    const live = {
      name: "zetaris" as const, qualify: (t: string) => own.qualify(t),
      run: async (sql: string, o?: Parameters<SqlJsEngine["run"]>[1]) => (sql.includes(ADOPTION_ENTITY) ? (order.push("dq"), dqRow) : (order.push("query"), own.run(sql, o))),
    };
    const stateFile = path.join(dir, "filestore-copy.json");
    const puts: Readonly<Record<string, string>>[] = [];
    let lessons = '[{"lesson_id":"mem-1"}]';
    let fail = false;
    const put = (files: Readonly<Record<string, string>>) => {
      order.push("put");
      if (fail) throw new Error("docker could not start for /fs/lessons.json: spawn wsl.exe ENOENT");
      puts.push(files);
      return Object.entries(files).map(([n, t]) => ({ path: `/fs/${n}`, bytes: Buffer.byteLength(t) }));
    };
    const refresh = () => refreshFiles({ files: () => ({ "lessons.json": lessons, "rules.json": "[]" }), put, stateFile, target: { container: "zetaris-driver-1", distro: "Ubuntu-24.04" } });
    const passOnce = async (tracer?: MemTracer) => {
      order.length = 0;
      return passStep(new DataLayer(live), { tenant: TENANT, ledger: null, decidedAt: AT, world: new DriftWorld("loop_test"), tracer, refreshFiles: refresh });
    };
    /** The Zetaris facts under the pass row, one a line. */
    const zlines = (r: PassStep) => new Table({ ...PLAIN, width: 200 }).row("pass", passView(r, { datasource: "DRIFT", queries: 2, rows: 3, failed: 0 }), null).filter((l) => /^ {12}(Zetaris|files|DQ) /.test(l));
    const recordedAt = `${AT.slice(0, 16).replace("T", " ")} UTC`;
    const zetaris = "            Zetaris   2 queries · 3 rows · 0 failed";
    const dq = `            DQ        exception_in_force holds for 1 of 1 adoption of the pass recorded at ${recordedAt}`;

    // the first pass after setup's copy of another store: the files go in, first, and the DQ read comes last
    const tracer = new MemTracer("loop_test", { model: "none" });
    const first = await passOnce(tracer);
    expect(order[0]).toBe("put");
    expect(order.filter((x) => x === "put")).toHaveLength(1);
    expect(order.at(-1)).toBe("dq");
    expect(first.files).toMatchObject({ status: "refreshed", previous: null });
    expect(first.summary).toContain(`; file tables refreshed: lessons.json ${Buffer.byteLength(lessons)} bytes, rules.json 2 bytes; DQ exception_in_force 1 of 1 adoption`);
    expect(tracer.events[0]).toMatchObject({ agent: "loop", action: "observe", status: "ok", input_summary: `file tables ${TENANT}` });
    expect(tracer.events[0].engine).toBeUndefined();
    expect(zlines(first)).toEqual([zetaris, "            files     lessons and rules refreshed in Zetaris", dq]);

    // the same store: current, nothing put, the line as before
    const second = await passOnce();
    expect(second.files?.status).toBe("current");
    expect(order).not.toContain("put");
    expect(second.summary).toContain("; file tables current; DQ exception_in_force");
    expect(zlines(second)).toEqual([zetaris, dq]);

    // npm run answer recorded a lesson: the next pass puts the new store before its DQ read
    lessons = '[{"lesson_id":"mem-1"},{"lesson_id":"mem-2"}]';
    const third = await passOnce();
    expect(third.files).toMatchObject({ status: "refreshed", previous: first.files!.status === "refreshed" ? first.files!.hash : "" });
    expect(puts.map((p) => p["lessons.json"])).toEqual(['[{"lesson_id":"mem-1"}]', lessons]);
    expect(order.indexOf("put")).toBeLessThan(order.indexOf("dq"));

    // a failed put: the pass completes with the same verbs, the failure in its summary and its line, the hash kept, so the next pass puts again
    lessons = '[{"lesson_id":"mem-1"},{"lesson_id":"mem-2"},{"lesson_id":"mem-3"}]';
    fail = true;
    const failed = await passOnce();
    expect(failed.files).toMatchObject({ status: "failed", error: "docker could not start for /fs/lessons.json: spawn wsl.exe ENOENT" });
    expect(failed.findings.map((f) => f.verb)).toEqual(first.findings.map((f) => f.verb));
    expect(failed.summary).toContain("; file tables not refreshed: docker could not start");
    expect(zlines(failed)).toEqual([zetaris, "            files     lessons and rules not refreshed in Zetaris", dq]);
    expect(readCopyState(stateFile)?.hash).toBe(third.files!.status === "refreshed" ? third.files!.hash : "");
    fail = false;
    expect((await passOnce()).files?.status).toBe("refreshed");
    own.close();
  });

  it("a CountingEngine counts a run that throws as a failure and rethrows the same error", async () => {
    const boom = new DataLayerError("planted");
    const failing = new CountingEngine({ name: "zetaris", qualify: (t) => `DRIFT.${t}`, run: async () => { throw boom; } });
    expect(failing.qualify("dns_record")).toBe("DRIFT.dns_record");
    await expect(failing.run("SELECT 1")).rejects.toBe(boom);
    await expect(new DataLayer(failing).run("SELECT x FROM {{t:dns_record}}")).rejects.toBe(boom);
    expect(failing.tally()).toMatchObject({ queries: 2, rows: 0, failed: 2 });
    const counting = new CountingEngine(engine);
    await counting.run("SELECT 1 AS a UNION ALL SELECT 2");
    await expect(counting.run("SELECT nope FROM no_such_table")).rejects.toThrow(DataLayerError);
    expect(counting.tally()).toMatchObject({ queries: 2, rows: 2, failed: 1 });
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
      explain: (p) => explainStep(layer, p, { sink: new MemoryCauseSink(engine), vault: base.vault, redactor: base.redactor, tracer }),
      act: (p) => actStep(p, { apply: false, redactor: base.redactor, deps: { ...deps, findingOf: async (d) => p.findings.find((f) => f.id === d.finding_id) ?? null } }),
      tickets: (p) => ticketsStep(layer, p, { adapter: () => { throw new Error("a dry run builds no adapter"); }, rows: null, dryRun: true, redactor: base.redactor, labels: base.redactor, deny: [], tracer, now: () => AT }),
      document: (p, facts) => documentStep(layer, p, { out, root: dir, deny: ["zz-label-absent"], source: "sql.js over test/fixtures/policy-bundle.json", tracer }, facts),
    };
    const res = await runCycle({ tenant: TENANT, apply: false, aliases: ["fixture-host"], skip: parseSkip(["collect,probe,validate"]) }, steps, { tracer, print: (l) => printed.push(l) });
    expect(res.stopped).toBeNull();
    expect(res.steps.map((s) => `${s.step} ${s.status}`)).toEqual([
      "collect:cloudflare skipped", "collect:linux fixture-host skipped", "probe skipped", "validate skipped", "pass ok", "explain ok", "act ok", "tickets ok", "document ok",
    ]);
    const pass = res.pass!;
    // explain: one cause per ROLLBACK, FIX, ESCALATE and explained HOLD, stored where act and the tickets read them, by disposition
    expect(res.steps[5].summary).toBe("explain: tenant client-a, 8 cause(s) (account_change 2, unknown 6); searched 0 journal and 1 cloudflare row(s) and 0 ledger action(s); finding_cause 8 row(s) written");
    expect(res.explain?.causes).toHaveLength(8);
    const causes = await causesByDisposition(layer, TENANT);
    expect([...causes.keys()].sort()).toEqual(pass.findings.filter((f) => f.verb !== "ADOPT" && f.finding.class !== "changed_since_backup").map((f) => dispositionIdOf(f, AT)).sort());
    expect(tracer.events.filter((e) => e.agent === "explainer" && e.action === "explain")).toHaveLength(9);
    // every finding of the pass is in the ledger under the id the pass gave it, decided at the given instant
    const ledger = new Map(objects(await layer.run(DISPOSITIONS_SQL)).map((d) => [d.disposition_id, d]));
    for (const f of pass.findings) expect(ledger.get(dispositionIdOf(f, AT))?.decided_at).toBe(AT);
    expect(pass.kept).toBe(0);
    expect(pass.summary).toContain(`PASS: tenant ${TENANT}, decided at ${AT}: `);
    // the fixture world's bundle: the policy fixture plus the server_name rows of app.conf and blog.conf
    expect(pass.summary).toContain(`${pass.findings.length} finding(s) (approved_missing 1, changed_since_backup 3, drift_vs_approved 5, found_but_different 2, proxy_split 1); verbs: ADOPT 2, HOLD 5, ESCALATE 1, ROLLBACK 3, FIX 1; decided by policy 12;`);
    // the dry run plans the fixture's five actions and writes no action row
    expect(res.steps[6].summary).toMatch(/^act: dry run: 5 actions planned \(rollback_file 2, revert_record 1, investigate 1, fix 1\), 1 of them refused on --apply; 0 already recorded; 0 action rows written; scope \d+ disposition\(s\) of \d+ run\(s\)/);
    expect(objects(await tenantActions(layer, TENANT)).length).toBe(0);
    expect(res.steps[7].summary).toMatch(new RegExp(`^TICKETS: tenant client-a, ${pass.findings.length} finding\\(s\\), .*; dry run, nothing sent or written$`));
    expect(res.steps[8].summary).toMatch(/^document: document\.md and report\.html written for client-a, \d+ lines, \d+ finding\(s\) open, \d+ queries; deny-list probe 0 of 1 label\(s\); decided at 2026-10-23T03:00:00\.000Z$/);
    expect(readFileSync(out, "utf8")).toContain(TENANT);
    expect(res.summary).toMatch(/^CYCLE: tenant client-a, dry run .*: 9 step\(s\): ok 5, skipped 4, failed 0, not run 0; completed;/);
    // the screen: the pass row with its verbs, the classes in plain words one a line and a block per ROLLBACK, FIX and
    // ESCALATE; the explain row with a block per cause; act's five planned actions, a block each
    const screen = printed.map((l) => l.replace(/ +\d+\.\d s$/, ""));
    expect(printed.every((l) => l.length <= 90)).toBe(true);
    const at = screen.findIndex((l) => l.startsWith("  pass "));
    const COPY = "copy [0-9a-f]{8} validated ok";
    expect(screen.slice(at, at + 21)).toEqual([
      "  pass      12 findings   ROLLBACK 3 · FIX 1 · ADOPT 2 · HOLD 5 · ESCALATE 1",
      "            classes   5  drifted from the approved value",
      "                      3  changed since the last backup",
      "                      2  unchanged setting, its target moved",
      "                      1  approved setting missing",
      "                      1  name and its www treated differently by the proxy",
      "            ROLLBACK  drifted from the approved value",
      "                      conf.d/app.conf on host-7f1c",
      expect.stringMatching(new RegExp(`^ {22}${COPY}$`)),
      "            ROLLBACK  approved setting missing",
      "                      conf.d/blog.conf on host-7f1c",
      expect.stringMatching(new RegExp(`^ {22}${COPY}$`)),
      "            ROLLBACK  drifted from the approved value",
      "                      DNS record mail.example.invalid (content)",
      expect.stringMatching(new RegExp(`^ {22}${COPY}$`)),
      "            FIX       drifted from the approved value",
      "                      conf.d/shop.conf on host-7f1c",
      "                      no valid copy · production affected, 1 failing probe",
      "            ESCALATE  name and its www treated differently by the proxy",
      "                      www.example.invalid",
      "                      the hold ran out at 23 Oct 00:00 UTC, a technician owns it",
    ]);
    const explained = at + 21;
    expect(screen[explained]).toBe("  explain   8 causes      account 2 · unknown 6");
    const act = screen.indexOf("  act       5 actions planned");
    // one block per cause: the verb, the object and the cause's class, then its sentence from a line of its own
    const blocks = screen.slice(explained + 1, act);
    expect(blocks.filter((l) => /^ {12}\S/.test(l)).map((l) => l.slice(12).replace(/ {2,}/, " | "))).toEqual([
      "HOLD | conf.d/app.conf on host-7f1c · account", "HOLD | conf.d/app.conf on host-7f1c · account", "ESCALATE | DNS record www.example.invalid · unknown",
      "HOLD | conf.d/api.conf on host-7f1c · unknown", "ROLLBACK | conf.d/app.conf on host-7f1c · unknown", "FIX | conf.d/shop.conf on host-7f1c · unknown",
      "ROLLBACK | conf.d/blog.conf on host-7f1c · unknown", "ROLLBACK | DNS record mail.example.invalid · unknown",
    ]);
    expect(blocks.filter((l) => !/^ {12}\S/.test(l)).every((l) => /^ {22}\S/.test(l))).toBe(true);
    expect(blocks.join(" ").replace(/ +/g, " ")).toContain(" No record of who changed it: the journal window of 90 h holds 0 writes to the file. ");
    expect(screen.slice(act, act + 15)).toEqual([
      "  act       5 actions planned",
      "            rollback_file  conf.d/app.conf on host-7f1c",
      expect.stringMatching(/^ {27}from vault [0-9a-f]{8}$/),
      "                           then nginx -t, reload, 1 probe",
      "            rollback_file  conf.d/blog.conf on host-7f1c",
      expect.stringMatching(/^ {27}from vault [0-9a-f]{8}$/),
      "                           then nginx -t, reload, 1 probe",
      "            revert_record  mail.example.invalid A",
      expect.stringMatching(/^ {27}from vault [0-9a-f]{8}$/),
      "                           then read back, dns probe",
      "            investigate    FIX · conf.d/shop.conf on host-7f1c",
      "                           checks, then the judge",
      "            fix            conf.d/shop.conf on host-7f1c",
      "                           refused on --apply",
      "                           no fix is allowed without a valid copy",
    ]);
    // the tickets a dry run would open, each with its issue's title under it
    expect(screen.slice(act + 15, act + 20)).toEqual([
      "  tickets   would open 2",
      expect.stringMatching(/^ {12}new incident P1 · would open · fnd-[0-9a-f]{16} ESCALATE opens an incident$/),
      "              ESCALATE proxy_split: www.example.invalid on example.invalid",
      expect.stringMatching(/^ {12}new incident P1 · would open · fnd-[0-9a-f]{16} FIX opens an incident$/),
      "              FIX drift_vs_approved: /etc/nginx/conf.d/shop.conf on host-7f1c",
    ]);
    // the what-happened block after the document row and a blank line: what --apply does for the planned actions, each
    // with its cause, the escalation with its own, at most five sentences, each wrapped at the width
    const doc = screen.findIndex((l) => /^  document  document\.md · \d+ lines · report\.html$/.test(l));
    expect(doc).toBeGreaterThan(0);
    expect(screen.slice(doc + 1, doc + 3)).toEqual(["", "what happened"]);
    const sentences = screen.slice(doc + 3, -1).reduce<string[]>((xs, l) => (l.startsWith("    ") ? [...xs.slice(0, -1), `${xs.at(-1)} ${l.trim()}`] : [...xs, l.slice(2)]), []);
    const noWrite = "No record of who changed it: the journal window of 90 h holds 0 writes to the file.";
    expect(sentences).toEqual([
      expect.stringMatching(new RegExp(`^A vhost file drifted from its approved copy; a run with --apply restores it from vault copy [0-9a-f]{8} and reloads nginx\\. ${noWrite.replace(/\./g, "\\.")}$`)),
      expect.stringMatching(new RegExp(`^An approved vhost file went missing; a run with --apply restores it from vault copy [0-9a-f]{8} and reloads nginx\\. ${noWrite.replace(/\./g, "\\.")}$`)),
      "2 more actions are listed under act.",
      "1 finding is with a technician: name and its www treated differently by the proxy at www.example.invalid. No record of who changed it: the audit log window of 24 h holds 0 events for the record.",
      "2 findings are adopted under policy rules; 5 are held with an expiry.",
    ]);
    // the document's Why: one line per explained finding, in the order the page lists them, its cause's sentence
    const page = readFileSync(out, "utf8");
    const why = page.slice(page.indexOf("### Why\n"), page.indexOf("\n## ", page.indexOf("### Why\n")));
    expect(why).toContain("Who or what changed each setting, from the hosts' journal, the provider's audit log and the agent's own actions (8 findings):");
    expect(why.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(8);
    for (const c of res.explain!.causes) expect(why).toContain(`- ${c.finding_id} ${c.verb} ${c.finding_class}: ${c.cause.summary}\n`);
    // the owner's report beside the page: its What happened is the block the screen prints, sentence for sentence
    const report = readFileSync(path.join(dir, "report.html"), "utf8");
    const story = [...report.matchAll(/<p class="story">(.*?)<\/p>/g)].map((m) => m[1].replace(/&#39;/g, "'").replace(/&amp;/g, "&"));
    expect(story).toEqual(sentences);
    expect(report).toContain(`<h1>${TENANT} · configuration assurance</h1>`);
    expect(report).toContain("<span>dry run, nothing changed</span>");
    expect(Object.keys(countLabels(report, ["zz-label-absent"]))).toEqual([]);
    expect(printed.at(-1)).toMatch(/^done · 9 steps · 4 skipped · \d+\.\d s$/);
  });

  it("a second pass over the same runs at a later instant writes a row per finding of its own; one more at that instant writes none and counts them kept", async () => {
    const later = "2026-10-23T05:00:00.000Z";
    const r = await passStep(layer, { tenant: TENANT, ledger: new MemoryLedger(engine), decidedAt: later, world: new DriftWorld("loop_test") });
    expect(r.pass.ledger?.dispositions).toBe(r.findings.length);
    expect(r.kept).toBe(0);
    const ledger = new Map(objects(await layer.run(DISPOSITIONS_SQL)).map((d) => [d.disposition_id, d]));
    for (const f of r.findings) expect([ledger.get(dispositionIdOf(f, AT))?.decided_at, ledger.get(dispositionIdOf(f, later))?.decided_at]).toEqual([AT, later]);
    expect(r.lines.slice(r.findings.length).every((l) => l.startsWith("DISPOSITION fnd-"))).toBe(true);
    const again = await passStep(layer, { tenant: TENANT, ledger: new MemoryLedger(engine), decidedAt: later, world: new DriftWorld("loop_test") });
    expect(again.pass.ledger?.dispositions).toBe(0);
    expect(again.kept).toBe(again.findings.length);
    expect(again.summary).toContain(`ledger: 0 disposition(s) and 0 referent fingerprint(s) written, ${again.findings.length} finding(s) on rows an earlier pass wrote`);
  });

  it("the document step writes nothing when the deny-list probe matches", async () => {
    const out = path.join(dir, "denied.md");
    const r = await documentStep(layer, passOf(TENANT), { out, root: dir, deny: [TENANT], source: "sql.js", tracer: undefined });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/^document: deny-list probe: 1 of 1 configured label\(s\) appear in the page; nothing written$/);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(path.join(dir, "denied.html"))).toBe(false);
  });
});
