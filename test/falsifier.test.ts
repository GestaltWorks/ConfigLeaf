// The falsifier in the live pass (src/agents/falsifier.ts, src/pipeline.ts): the eval's C3 judge on every finding the
// withdraw rule does not withhold, through a stubbed Nightshift whose answers are filed under receipts signed in the test
// (test/fixtures/signed-receipt.ts), so the real receipt gate verifies each Ed25519 signature, the served tier and custody.
// The refuting SELECT runs for real on sql.js. Held here: C3's mapping from a verdict to a decision, rules deciding and a
// strike never turning ESCALATE into ADOPT; every way a verdict fails to count, each keeping the decision; the pass with the
// judge against the pass without it over the fixtures; the same findings, ledger rows and trace at PASS_CONCURRENCY 1 and 4;
// the live pass against runEval's C3 over the recording; the pass row, the pass summary and the ticket.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SignedReceipt } from "../src/adapters/nightshift.ts";
import { JUDGE_MAX_TOKENS, SYSTEM_PROMPT, type JudgeModel, type JudgeStatus } from "../src/agents/judge.ts";
import {
  MAX_CELL, PROMPT_LIMIT, applyVerdict, cutEvidence, cutText, fitEvidence, userChars, judgeClause, judgeDetail, judgeFinding, liveJudge, modelName, otherTenant, outcomeOf, tallyText, ultraLadder,
  type JudgeOutcome, type LiveJudgeSettings, type PassJudge, type PassJudgement,
} from "../src/agents/falsifier.ts";
import { defaultChecks, type FindingSummary } from "../src/catalogue/select.ts";
import { config, parseJudgeSwitch } from "../src/config.ts";
import { DataLayer, type Engine } from "../src/data/layer.ts";
import { SqlJsEngine, type Bundle } from "../src/data/engines/sqljs.ts";
import { decisionInstant } from "../src/data/instant.ts";
import { objects } from "../src/data/queries.ts";
import type { Disposition } from "../src/data/rows.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { loadEvalSet } from "../src/eval/items.ts";
import { loadEvalPolicy, underPolicy } from "../src/eval/policy.ts";
import { EVIDENCE_SQL, evidenceParams } from "../src/eval/queries.ts";
import { runEval } from "../src/eval/run.ts";
import type { ReceiptFinder } from "../src/gate.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { passStep } from "../src/loop/pass.ts";
import { PLAIN, Table, passView, shortModel } from "../src/loop/present.ts";
import { runPass, type DispositionNote, type Finding, type PassOptions, type Verb } from "../src/pipeline.ts";
import { isJudged, ticketBody } from "../src/psa/body.ts";
import type { TraceEvent } from "../src/trace.ts";
import authored from "./fixtures/authored-bundle.json" with { type: "json" };
import policyBundle from "./fixtures/policy-bundle.json" with { type: "json" };
import recorded from "./fixtures/recorded-bundle.json" with { type: "json" };
import { MemTracer } from "./fixtures/mem-tracer.ts";
import { ULTRA_MODEL, signed } from "./fixtures/signed-receipt.ts";

const AT = "2026-10-23T03:00:00.000Z";
const REFUTE = "SELECT run_id FROM {{t:collection_run}}";
const STAND = "SELECT run_id FROM {{t:collection_run}} WHERE run_id = 'run-none'";
const LIGHTNING_MODEL = config.nightshift.modelFast;
const URL = "http://127.0.0.1:8088/v1";
/** liveJudge in live mode, judge on, a token, a URL and Ultra's ladder, each overridable. */
const live = (o: Partial<LiveJudgeSettings> = {}) => liveJudge({ sampleMode: false, judge: "on", token: "test-token", baseUrl: URL, models: ultraLadder(), ...o });

type ChatOpts = Parameters<JudgeModel["chatWithFallback"]>[0];

/** How the stub answers one claim: a refuting SELECT by default. */
interface Answer {
  sql?: string;
  /** The reply's whole content, in place of {refute_with_sql, rationale}. */
  content?: string;
  /** The model the receipt names; Ultra by default. */
  served?: string;
  /** The call throws this, as a ladder whose every route failed does. */
  throws?: string;
  /** The receipt's body is altered after signing. */
  tamper?: boolean;
  /** The receipt's hmem, as Nightshift's memory records an injection. */
  hmem?: unknown;
  /** No receipt is filed for the answer. */
  noReceipt?: boolean;
}

const NONCE_LINE = /^\[request [0-9a-f]+\]\n/;
const claimOf = (user: string): string => user.replace(NONCE_LINE, "").split("\n")[0].replace(/^Claim: /, "");
const short = (s: string, n = 12): string => createHash("sha256").update(s).digest("hex").slice(0, n);

/**
 * A Nightshift that answers the judge's prompt per claim and the selection prompt with the class's default checks (what C1's
 * stub in test/eval.test.ts does), filing each answer under a receipt signed here for the request and app it was sent with.
 * Receipt and request ids derive from the prompt, never from the order of calls, and each answer waits a few milliseconds
 * that also derive from it, so that at concurrency 4 the calls finish out of order.
 */
function stubNightshift(answer: (claim: string) => Answer = () => ({})) {
  const receipts = new Map<string, SignedReceipt>();
  const sent: ChatOpts[] = [];
  const nightshift: JudgeModel = {
    async chatWithFallback(o) {
      sent.push(o);
      const system = o.messages[0].content;
      const user = o.messages[o.messages.length - 1].content;
      const h = short(user.replace(NONCE_LINE, ""));
      await new Promise((r) => setTimeout(r, (parseInt(h.slice(0, 2), 16) % 4) * 4));
      let content: string;
      let a: Answer = {};
      if (system === SYSTEM_PROMPT) {
        a = answer(claimOf(user));
        if (a.throws) throw new Error(a.throws);
        content = a.content ?? JSON.stringify({ refute_with_sql: a.sql ?? REFUTE, rationale: "rows show the claim false" });
      } else {
        const f = JSON.parse(user.slice(user.indexOf("{"), user.lastIndexOf("}") + 1)) as FindingSummary;
        content = JSON.stringify({ checks: defaultChecks(f).valid.map((c) => ({ template: c.template, params: c.params, why: "the class's default" })) });
        a = { served: o.models[0] };
      }
      const model = a.served ?? ULTRA_MODEL;
      const receiptId = `rcpt_${h}`;
      const requestId = `req_${h}`;
      const receipt = signed({
        receipt_id: receiptId, request_id: requestId, app: o.appId, routing: { winner: model }, phases: [{ model, phase: "final_synthesis" }], winning_route: { model },
        cache: { status: "miss" }, requested_mode: "meterless/auto", status: "ok", hmem: a.hmem ?? null,
      });
      if (!a.noReceipt) receipts.set(receiptId, a.tamper ? { ...receipt, body: { ...receipt.body, receipt: { ...receipt.body.receipt, status: "altered" } } } : receipt);
      return { content, modelRequested: o.models[0], modelRouted: model, receiptId, requestId, tokensIn: 100, tokensOut: 20, latencyMs: 5, retries: 0, raw: {}, hop: 0 };
    },
  };
  const judge: PassJudge & { nightshift: JudgeModel; receipts: ReceiptFinder } = { nightshift, receipts: { find: async (id) => receipts.get(id) ?? null }, models: ultraLadder() };
  return { judge, sent, judgeCalls: () => sent.filter((o) => o.messages[0].content === SYSTEM_PROMPT) };
}

async function layerOver(bundle: Bundle): Promise<{ engine: SqlJsEngine; layer: DataLayer }> {
  const engine = await SqlJsEngine.create();
  engine.loadBundle(bundle);
  return { engine, layer: new DataLayer(engine) };
}

/** The trace as compared: every event without its timestamp, latency and query id. */
const events = (t: MemTracer): Omit<TraceEvent, "ts" | "latency_ms" | "query_id">[] => t.events.map(({ ts: _ts, latency_ms: _ms, query_id: _id, ...rest }) => rest);

/** The pass's own judge line per finding: the skipped line, or the line judgeFinding adds after the verdict. */
const passJudgeLines = (t: MemTracer): TraceEvent[] =>
  t.events.filter((e) => e.agent === "judge" && e.action === "judge" && (e.status === "skipped" || /^(struck|held|judge not counted): /.test(e.output_summary ?? "")));

const judged = (f: Finding): PassJudgement | null => (f.judge === "skipped" ? null : f.judge);

// ------------------------------------------------------------------------------------------------ the mapping

describe("a verdict and the decision: C3's mapping, rules deciding, a strike never turning ESCALATE into ADOPT", () => {
  it("counts a verdict only when it is stands or refuted on a receipt whose signature verified", () => {
    const cases: [JudgeStatus, boolean | null | undefined, JudgeOutcome][] = [
      ["refuted", true, "struck"], ["stands", true, "held"], ["refuted", false, "not_counted"], ["stands", null, "not_counted"], ["refuted", undefined, "not_counted"],
      ["not_judged", true, "not_counted"], ["invalid_output", true, "not_counted"], ["not_judged", undefined, "not_counted"],
    ];
    for (const [status, signatureOk, out] of cases) expect(outcomeOf({ status, signatureOk }), `${status} ${signatureOk}`).toBe(out);
  });

  it("gives C3's verb, decided_by and rule on every decision a pass reaches, except a default ESCALATE whose claim is struck, which stays ESCALATE", () => {
    const R = "2 row(s) satisfy the refuting SELECT";
    const decisions: DispositionNote[] = [
      ...(["ADOPT", "HOLD", "ESCALATE", "ROLLBACK", "FIX"] as Verb[]).map((verb) => ({ verb, reason: `rule says ${verb}`, expires_at: verb === "HOLD" ? AT : null, decided_by: "policy" as const, rule_id: "rule-1" })),
      { verb: "HOLD", reason: "change window", expires_at: AT, decided_by: "policy", rule_id: "rule-2", window_id: "cw-1" },
      { verb: "ADOPT", reason: "accepted exception", expires_at: AT, decided_by: "operator", rule_id: null },
      { verb: "ESCALATE", reason: "exception lapsed", expires_at: null, decided_by: "operator", rule_id: null },
      { verb: "ADOPT", reason: "all 4 preconditions hold; candidate pending a judge", expires_at: null, decided_by: "default", rule_id: null },
      { verb: "ESCALATE", reason: "2 of 4 preconditions fail: actor_attributed, previous_value_recoverable", expires_at: null, decided_by: "default", rule_id: null },
    ];
    for (const d of decisions) {
      // the checks' own verb, which a default decision is and which C3 weighs for a governed one
      const checks = d.decided_by === "default" ? (d.verb as "ADOPT" | "ESCALATE") : "ESCALATE";
      for (const outcome of ["struck", "held", "not_counted"] as const) {
        const live = applyVerdict(d, outcome, R);
        const what = `${d.verb} by ${d.decided_by}, ${outcome}`;
        // never out of HOLD or ESCALATE into ADOPT, and the expiry, the rule and the change window stay
        if (d.verb !== "ADOPT") expect(live.disposition.verb, what).not.toBe("ADOPT");
        expect([live.disposition.decided_by, live.disposition.rule_id, live.disposition.expires_at, live.disposition.window_id], what).toEqual([d.decided_by, d.rule_id, d.expires_at, d.window_id]);
        if (outcome === "not_counted") {
          // C3 files the finding not judged; live keeps the decision it had, reason and all
          expect(live.disposition, what).toEqual(d);
          continue;
        }
        const own = outcome === "struck" ? { verb: "ADOPT" as Verb, reason: `the judge struck the claim: ${R}` } : { verb: checks as Verb, reason: `${d.reason}; the claim stands: ${R}` };
        const c3 = underPolicy(d.decided_by === "default" ? undefined : d, own);
        if (d.decided_by === "default" && d.verb === "ESCALATE" && outcome === "struck") {
          expect(c3.verb, what).toBe("ADOPT");
          expect(live.disposition.verb, what).toBe("ESCALATE");
          expect(live.disposition.reason, what).toBe(`${d.reason}; the judge struck the claim (${R}), and a strike never turns ESCALATE into ADOPT`);
          continue;
        }
        expect([live.disposition.verb, live.disposition.decided_by, live.disposition.rule_id], what).toEqual([c3.verb, c3.decided_by, c3.rule_id]);
        // a governed decision keeps the rule's own sentence; a default one takes C3's
        expect(live.disposition.reason, what).toBe(d.decided_by === "default" ? c3.reason : d.reason);
      }
    }
  });

  it("holds the invariant whoever decided: a struck claim never turns HOLD or ESCALATE into ADOPT, and the expiry, rule and decider stay", () => {
    for (const decided_by of ["policy", "operator", "default"] as const) {
      for (const verb of ["HOLD", "ESCALATE"] as const) {
        const d: DispositionNote = { verb, reason: "r", expires_at: verb === "HOLD" ? AT : null, decided_by, rule_id: decided_by === "policy" ? "rule-1" : null };
        for (const outcome of ["struck", "held", "not_counted"] as const) {
          const out = applyVerdict(d, outcome, "why");
          expect(out.disposition.verb, `${verb} by ${decided_by}, ${outcome}`).toBe(verb);
          expect([out.disposition.expires_at, out.disposition.rule_id, out.disposition.decided_by]).toEqual([d.expires_at, d.rule_id, decided_by]);
        }
      }
    }
  });

  it("names the effect in a sentence, and the tally in one line", () => {
    const d: DispositionNote = { verb: "HOLD", reason: "held", expires_at: AT, decided_by: "policy", rule_id: "rule-9" };
    expect(applyVerdict(d, "struck", "r").effect).toBe("HOLD by policy under rule-9 stands: the rule decides, the verdict is evidence");
    expect(applyVerdict(d, "not_counted", "r").effect).toBe("HOLD by policy under rule-9 stands, as decided before the judge");
    const model = config.nightshift.modelJudge;
    expect(tallyText({ model, judged: 4, struck: 1, held: 2, not_counted: 1 })).toBe(`${modelName(model)} judged 4: 1 struck, 2 held, 1 not counted`);
    expect(modelName(model)).not.toContain("/");
  });
});

// ------------------------------------------------------------------------------------------------ one finding

describe("judgeFinding: C3's call for one finding, through the stubbed Nightshift and the real receipt gate", () => {
  /** The authored fixture's two findings, both decided by default with a failing check, neither withheld. */
  async function authoredFindings() {
    const { engine, layer } = await layerOver(authored);
    const r = await runPass(layer, { world: new DriftWorld("test_falsifier"), decidedAt: AT });
    return { engine, layer, findings: r.findings };
  }

  it("strikes the claim with Ultra's refuting SELECT on a verified receipt; the ESCALATE stands; the trace and the judgement name SELECT, rows, receipt, signature and model", async () => {
    const { engine, layer, findings } = await authoredFindings();
    try {
      const f = findings[0];
      expect([f.verb, f.disposition.decided_by, f.judgeWithheld]).toEqual(["ESCALATE", "default", undefined]);
      const { judge, sent } = stubNightshift();
      const tracer = new MemTracer("test_falsifier");
      const { disposition, judgement } = await judgeFinding(layer, f.finding, f.disposition, judge, tracer);
      expect(judgement).toMatchObject({
        status: "refuted", outcome: "struck", sql: `${REFUTE} LIMIT 50`, verified: true, served_model: ULTRA_MODEL, route: config.nightshift.modelJudge, before: "ESCALATE",
        effect: "ESCALATE by default stands: a strike never turns ESCALATE into ADOPT, a technician decides",
      });
      expect(judgement.rows).toBeGreaterThan(0);
      expect(judgement.receipt_id).toMatch(/^rcpt_[0-9a-f]{12}$/);
      expect(judgement.evidence_rows).toBeGreaterThan(0);
      expect(disposition).toEqual({ ...f.disposition, reason: `${f.disposition.reason}; the judge struck the claim (${judgement.reason}), and a strike never turns ESCALATE into ADOPT` });
      // the call C3 makes: Ultra's ladder, the tenant's app id, a request nonce first, the judge's max_tokens
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ models: ultraLadder(), appId: `drift-agent-${f.finding.tenant_id}`, maxTokens: JUDGE_MAX_TOKENS, temperature: 0, agent: "judge" });
      expect(sent[0].messages.at(-1)!.content).toMatch(/^\[request [0-9a-f]{16}\]\nClaim: /);
      // the evidence read, the gate's custody and receipt checks, the SELECT, then the pass's judge line with every field
      expect(tracer.events.some((e) => e.agent === "judge" && e.action === "query")).toBe(true);
      expect(tracer.events.filter((e) => e.agent === "judge" && e.action === "check").map((e) => e.status)).toEqual(["ok", "ok"]);
      const line = tracer.events.at(-1)!;
      expect(line).toMatchObject({
        agent: "judge", action: "judge", status: "ok", model_requested: config.nightshift.modelJudge, model_routed: ULTRA_MODEL, receipt_id: judgement.receipt_id, signature_ok: true,
        input_summary: f.finding.summary.slice(0, 160),
      });
      expect(line.output_summary).toMatch(/^struck: \d+ row\(s\) satisfy the refuting SELECT; ESCALATE by default stands: a strike never turns ESCALATE into ADOPT/);
      expect(line.detail).toBe(judgeDetail(judgement));
      expect(line.detail).toContain(`served ${modelName(ULTRA_MODEL)}; refuting SQL: ${REFUTE} LIMIT 50; ${judgement.rows} row(s); receipt ${judgement.receipt_id} verified`);
      expect(judgement.cut).toEqual([]);
    } finally {
      engine.close();
    }
  });

  it("a claim that stands is held, and a default decision takes C3's sentence for it", async () => {
    const { engine, layer, findings } = await authoredFindings();
    try {
      const f = findings[1];
      const { judge } = stubNightshift(() => ({ sql: STAND }));
      const { disposition, judgement } = await judgeFinding(layer, f.finding, f.disposition, judge);
      expect([judgement.status, judgement.outcome, judgement.rows, judgement.verified]).toEqual(["stands", "held", 0, true]);
      expect(disposition).toEqual({ ...f.disposition, reason: `${f.disposition.reason}; the claim stands: the refuting SELECT returned no rows` });
    } finally {
      engine.close();
    }
  });

  const failures: [string, Answer, RegExp][] = [
    ["the model is unreachable", { throws: "every route failed: 503" }, /^judge model unavailable: every route failed: 503/],
    ["the receipt's body is altered after signing", { tamper: true }, /^receipt gate: .*signature does not verify/],
    ["Lightning served what Ultra was asked for", { served: LIGHTNING_MODEL }, /^receipt gate: .*\(lightning\), ultra was requested/],
    ["Nightshift's memory was injected", { hmem: { injected: 2, ids: ["m1", "m2"] } }, /^receipt gate: memory injected \(2 records\)/],
    ["no receipt is filed for the answer", { noReceipt: true }, /^receipt gate: .*unreceipted, not judged/],
    ["the reply is not one guarded SELECT", { sql: "DELETE FROM {{t:observation}}" }, /^refutation SQL refused: /],
    ["the reply holds no JSON", { content: "I cannot tell." }, /^no JSON object in the reply/],
    ["the SELECT does not run", { sql: "SELECT no_such_column FROM {{t:collection_run}}" }, /^refutation SQL failed to run: /],
  ];
  for (const [why, answer, reason] of failures) {
    it(`does not count the verdict when ${why}: the decision stands as it was, and the trace says "judge not counted"`, async () => {
      const { engine, layer, findings } = await authoredFindings();
      try {
        const f = findings[0];
        const { judge } = stubNightshift(() => answer);
        const tracer = new MemTracer("test_falsifier");
        const { disposition, judgement } = await judgeFinding(layer, f.finding, f.disposition, judge, tracer);
        expect(disposition).toEqual(f.disposition);
        expect(judgement.outcome).toBe("not_counted");
        expect(judgement.reason).toMatch(reason);
        expect(judgement.effect).toBe("ESCALATE by default stands, as decided before the judge");
        const line = tracer.events.at(-1)!;
        expect([line.agent, line.action, line.status]).toEqual(["judge", "judge", "not_judged"]);
        expect(line.output_summary).toMatch(/^judge not counted: /);
        expect(line.output_summary).toContain("ESCALATE by default stands, as decided before the judge");
      } finally {
        engine.close();
      }
    });
  }

  it("does not call the model when the evidence cannot be read: not counted, the decision as it was", async () => {
    const { engine, findings } = await authoredFindings();
    try {
      const failing: Engine = {
        name: engine.name, qualify: (t) => engine.qualify(t),
        run: async (sql, o) => (sql.includes("'backup_item' AS source") ? Promise.reject(new Error("planted: evidence read failed")) : engine.run(sql, o)),
      };
      const f = findings[0];
      const { judge, sent } = stubNightshift();
      const { disposition, judgement } = await judgeFinding(new DataLayer(failing), f.finding, f.disposition, judge);
      expect(sent).toHaveLength(0);
      expect(disposition).toEqual(f.disposition);
      expect([judgement.outcome, judgement.reason, judgement.receipt_id, judgement.verified, judgement.evidence_rows]).toEqual(["not_counted", "evidence not read: planted: evidence read failed; no call made", null, null, 0]);
    } finally {
      engine.close();
    }
  });

  it("reads the evidence C3 hands its judge: EVIDENCE_SQL through the same DataLayer", () => {
    expect(EVIDENCE_SQL).toContain("'backup_item' AS source");
  });
});

describe("liveJudge and DRIFT_JUDGE: none in sample mode; off, or no token, URL or model, a judge that calls nothing and counts nothing", () => {
  it("parses DRIFT_JUDGE as on or off, blank on, any case; anything else is refused", () => {
    expect([parseJudgeSwitch(""), parseJudgeSwitch(" on "), parseJudgeSwitch("OFF"), parseJudgeSwitch("Off")]).toEqual(["on", "on", "off", "off"]);
    expect(() => parseJudgeSwitch("yes")).toThrow("DRIFT_JUDGE: on or off, got \"yes\"");
  });

  it("is null in sample mode whatever the switch; has no client when off, with a blank token, URL or judge model; Ultra's ladder otherwise", () => {
    expect(live({ sampleMode: true })).toBeNull();
    expect(live({ sampleMode: true, judge: "off" })).toBeNull();
    expect(live({ judge: "off" })).toMatchObject({ nightshift: null, receipts: null, unavailable: "judge off: DRIFT_JUDGE is off" });
    expect(live({ token: "" })).toMatchObject({ nightshift: null, receipts: null, unavailable: expect.stringMatching(/^no model configured: no Nightshift runtime token/) });
    expect(live({ baseUrl: " " })).toMatchObject({ nightshift: null, receipts: null, unavailable: "no model configured: METERLESS_BASE_URL is blank" });
    expect(live({ models: [" ", ""] })).toMatchObject({ nightshift: null, unavailable: "no model configured: METERLESS_MODEL_JUDGE and METERLESS_FALLBACK_JUDGE are blank" });
    expect(ultraLadder([" ", "a/b-ultra", "", "c/d-ultra "])).toEqual(["a/b-ultra", "c/d-ultra"]);
    const j = live()!;
    expect(j.models).toEqual(ultraLadder([config.nightshift.modelJudge, ...config.nightshift.fallbackJudge]));
    expect(typeof j.nightshift?.chatWithFallback).toBe("function");
    expect(typeof j.receipts?.find).toBe("function");
  });

  for (const [name, settings, said] of [
    ["no model is configured", { token: "" }, /^judge not counted: no model configured: no Nightshift runtime token /],
    ["DRIFT_JUDGE is off", { judge: "off" as const }, /^judge not counted: judge off: DRIFT_JUDGE is off; no call made; /],
  ] as const) {
    it(`when ${name}: no read and no call, the finding keeps its decision, and the trace says why`, async () => {
      const { engine, layer } = await layerOver(authored);
      try {
        const f = (await runPass(layer, { world: new DriftWorld("test_falsifier"), decidedAt: AT })).findings[0];
        const tracer = new MemTracer("test_falsifier");
        const { disposition, judgement } = await judgeFinding(layer, f.finding, f.disposition, live(settings)!, tracer);
        expect(disposition).toEqual(f.disposition);
        expect([judgement.outcome, judgement.evidence_rows, judgement.receipt_id]).toEqual(["not_counted", 0, null]);
        expect(tracer.events).toHaveLength(1);
        expect(tracer.events[0]).toMatchObject({ agent: "judge", action: "judge", status: "not_judged" });
        expect(tracer.events[0].output_summary).toMatch(said);
      } finally {
        engine.close();
      }
    });
  }
});

describe("evidence cells: cut to 240 characters when the user message would pass Nightshift's 4,000, said so; nothing of the recording's is cut", () => {
  it("cuts each cell over MAX_CELL to MAX_CELL characters, the last an ellipsis, and names each cut", () => {
    const e = { columns: ["a", "b"], rows: [["x".repeat(MAX_CELL), "y".repeat(5120)], ["short", "z".repeat(900)]] };
    const { evidence, cut } = cutEvidence(e);
    expect(cut).toEqual([5120, 900]);
    expect(evidence.rows.map((r) => r.map((v) => v.length))).toEqual([[MAX_CELL, MAX_CELL], [5, MAX_CELL]]);
    expect(evidence.rows[0][1].endsWith("…")).toBe(true);
    expect(cutText([5120])).toBe("cell cut to 240 of 5120 characters");
    expect(cutText([5120, 900])).toBe("2 cells cut to 240 of 5120 and 900 characters");
    expect(cutText([])).toBe("");
  });

  it("hands Ultra the cut cell, and the judge line and the ticket say \"cell cut to 240 of N characters\"", async () => {
    const { engine } = await layerOver(authored);
    try {
      const long: Engine = {
        name: engine.name, qualify: (t) => engine.qualify(t),
        run: async (sql, o) => {
          const r = await engine.run(sql, o);
          return sql.includes("'backup_item' AS source") ? { ...r, rows: r.rows.map((row, i) => (i === 0 ? row.map((v, c) => (c === 4 ? "d".repeat(5120) : v)) : row)) } : r;
        },
      };
      const layer = new DataLayer(long);
      const f = (await runPass(new DataLayer(engine), { world: new DriftWorld("test_falsifier"), decidedAt: AT })).findings[0];
      const { judge, sent } = stubNightshift();
      const tracer = new MemTracer("test_falsifier");
      const { judgement } = await judgeFinding(layer, f.finding, f.disposition, judge, tracer);
      expect(judgement.cut).toEqual([5120]);
      const user = sent[0].messages.at(-1)!.content;
      expect(user).not.toContain("d".repeat(MAX_CELL));
      expect(user).toContain(`${"d".repeat(MAX_CELL - 1)}…`);
      expect(tracer.events.at(-1)!.detail).toContain(", cell cut to 240 of 5120 characters;");
      const body = ticketBody({ finding: { ...f, judge: judgement }, disposition: { ...f.disposition, disposition_id: "d", tenant_id: "t", surface: "s", host: null, object_id: "o", setting_path: "p", value_hash: "", finding_id: f.id, run_id: "r", decided_at: AT } as Disposition, rule: null, actions: [], probes: { run_id: null, rows: [] }, ticketId: "t", type: "incident", priority: "P2" });
      expect(body).toContain("cell cut to 240 of 5120 characters");
    } finally {
      engine.close();
    }
  });

  it("over every finding of the recording the eval runs over, no judge prompt reaches the limit, so no cell is cut: the live judge's inputs there are C3's", { timeout: 60_000 }, async () => {
    const { engine, layer } = await layerOver(recorded);
    try {
      const fs = (await runPass(layer, { world: new DriftWorld("test_falsifier"), decidedAt: decisionInstant(recorded) })).findings;
      expect(fs.length).toBeGreaterThan(30);
      let longest = 0;
      let longCells = 0;
      for (const f of fs) {
        const r = await layer.run(EVIDENCE_SQL, evidenceParams(f.finding), { limit: 200 });
        const e = { columns: r.columns, rows: r.rows };
        expect(fitEvidence(f.finding.summary, e), f.id).toEqual({ evidence: e, cut: [] });
        longest = Math.max(longest, userChars(f.finding.summary, e));
        longCells += cutEvidence(e).cut.length;
      }
      // measured 26 Oct 2026: the longest judge user message 1,775 characters; 11 cells over 240 (observation values up to 698), none cut
      expect(longest).toBeLessThan(PROMPT_LIMIT / 2);
      expect(longCells).toBeGreaterThan(0);
    } finally {
      engine.close();
    }
  });

  it("cuts nothing while the user message fits, however long a cell", () => {
    const e = { columns: ["value"], rows: [["v".repeat(698)]] };
    expect(fitEvidence("a short claim", e)).toEqual({ evidence: e, cut: [] });
    const big = { columns: ["value"], rows: [["v".repeat(PROMPT_LIMIT)]] };
    expect(fitEvidence("a short claim", big).cut).toEqual([PROMPT_LIMIT]);
  });
});

describe("the judge line's detail: each field scrubbed on its own, no credential word, so field order cannot mangle it", () => {
  it("survives the trace's redactor unchanged when the reason and the SQL carry credential words beside the model", () => {
    const j: PassJudgement = {
      status: "refuted", outcome: "struck", reason: "auth token signature secret: 2 row(s) satisfy the refuting SELECT", rows: 2,
      sql: "SELECT author FROM {{t:policy_rule}} WHERE note = 'private key credential' LIMIT 50", receipt_id: "rcpt_req_abc", verified: true,
      served_model: config.nightshift.modelJudge, route: config.nightshift.modelJudge, evidence_rows: 1, cut: [5120], before: "HOLD", effect: "e",
    };
    const tracer = new MemTracer("test_falsifier");
    const detail = judgeDetail(j);
    expect(tracer.emit({ agent: "judge", action: "judge", status: "ok", detail }).detail).toBe(detail);
    expect(detail).toContain(`served ${modelName(config.nightshift.modelJudge)}; `);
    expect(detail).toContain("receipt rcpt_req_abc verified");
    expect(detail).not.toMatch(/signature|<secret:/);
  });
});


// ------------------------------------------------------------------------------------------------ the pass

/** One pass over `bundle`: its result, its trace, the ledger's rows in the order written. */
async function passOver(bundle: Bundle, o: PassOptions & { policyFile?: string; tenant?: string } = {}) {
  const { engine, layer } = await layerOver(bundle);
  try {
    if (o.policyFile) await loadEvalPolicy(engine, layer, o.policyFile, o.tenant ?? "client-1");
    const tracer = new MemTracer("test_falsifier", o.judge ? {} : { model: "none" });
    const result = await runPass(layer, { tracer, world: new DriftWorld("test_falsifier"), ledger: new MemoryLedger(engine), decidedAt: AT, ...o });
    const read = new DataLayer(engine);
    const dispositions = objects(await read.run("SELECT * FROM {{t:disposition}}", {}, { limit: 100_000 })) as unknown as Disposition[];
    return { result, tracer, trace: events(tracer), dispositions };
  } finally {
    engine.close();
  }
}

const decisionOf = (f: Finding) => [f.id, f.verb, f.disposition.decided_by, f.disposition.rule_id, f.disposition.expires_at];

describe("the pass with the judge", () => {
  it("over the policy fixture, every verb a rule's: each finding judged, every decision the same as without the judge, the tally on the result", { timeout: 60_000 }, async () => {
    const without = await passOver(policyBundle);
    const { judge, judgeCalls } = stubNightshift();
    const withJudge = await passOver(policyBundle, { judge });
    const fs = withJudge.result.findings;
    expect(fs.map(decisionOf)).toEqual(without.result.findings.map(decisionOf));
    expect(fs.map((f) => f.disposition)).toEqual(without.result.findings.map((f) => f.disposition));
    expect(withJudge.result.verbs).toEqual(without.result.verbs);
    expect(new Set(fs.map((f) => f.verb))).toEqual(new Set(["ADOPT", "HOLD", "ESCALATE", "ROLLBACK", "FIX"]));
    // every finding the withdraw rule does not withhold, judged once; each struck, the rule's decision standing
    const open = fs.filter((f) => !f.judgeWithheld);
    expect(judgeCalls()).toHaveLength(open.length);
    for (const f of open) expect(judged(f), f.id).toMatchObject({ outcome: "struck", verified: true, served_model: ULTRA_MODEL, before: f.verb, effect: expect.stringMatching(/ stands: the rule decides, the verdict is evidence$/) });
    for (const f of fs.filter((x) => x.judgeWithheld)) expect(f.judge).toBe("skipped");
    expect(withJudge.result.judge).toEqual({ model: config.nightshift.modelJudge, judged: open.length, struck: open.length, held: 0, not_counted: 0 });
    // one judge line per finding where the pass without the judge has its skipped line
    expect(passJudgeLines(withJudge.tracer).map((e) => e.input_summary)).toEqual(passJudgeLines(without.tracer).map((e) => e.input_summary));
    expect(passJudgeLines(without.tracer).every((e) => e.status === "skipped")).toBe(true);
    // the ledger rows the same, bar nothing: a rule's reason is kept
    expect(withJudge.dispositions).toEqual(without.dispositions);
  });

  it("over the authored fixture, every finding decided by default with a failing check: struck, and still ESCALATE", async () => {
    const { judge } = stubNightshift();
    const r = await passOver(authored, { judge });
    expect(r.result.findings.map((f) => [f.verb, f.disposition.decided_by, judged(f)?.outcome])).toEqual([["ESCALATE", "default", "struck"], ["ESCALATE", "default", "struck"]]);
    expect(r.result.findings.every((f) => f.disposition.reason.endsWith("and a strike never turns ESCALATE into ADOPT"))).toBe(true);
    expect(r.result.verbs.ADOPT).toBe(0);
  });

  it("over the recorded fixture with no rule loaded: a default ADOPT struck stays ADOPT with C3's sentence; a claim that stands keeps the checks' verb with its clause", { timeout: 60_000 }, async () => {
    const without = await passOver(recorded);
    const struck = await passOver(recorded, { judge: stubNightshift().judge });
    const held = await passOver(recorded, { judge: stubNightshift(() => ({ sql: STAND })).judge });
    expect(struck.result.findings.map((f) => f.verb)).toEqual(without.result.findings.map((f) => f.verb));
    expect(held.result.findings.map((f) => f.verb)).toEqual(without.result.findings.map((f) => f.verb));
    const adopt = struck.result.findings.filter((f) => f.verb === "ADOPT");
    expect(adopt.length).toBeGreaterThan(0);
    for (const f of adopt) expect(f.disposition.reason).toMatch(/^the judge struck the claim: \d+ row\(s\) satisfy the refuting SELECT$/);
    for (const f of held.result.findings) expect(f.disposition.reason).toMatch(/; the claim stands: the refuting SELECT returned no rows$/);
    expect(held.result.judge).toMatchObject({ struck: 0, not_counted: 0 });
  });

  it("a verdict that does not count keeps the decision and is traced, never skipped silently; the tally counts it", async () => {
    const without = await passOver(policyBundle);
    const target = without.result.findings[3].finding.summary;
    const { judge } = stubNightshift((claim) => (claim === target ? { throws: "every route failed: 503" } : {}));
    const r = await passOver(policyBundle, { judge });
    expect(r.result.findings.map((f) => f.disposition)).toEqual(without.result.findings.map((f) => f.disposition));
    const f = r.result.findings[3];
    expect(judged(f)).toMatchObject({ outcome: "not_counted", reason: expect.stringMatching(/^judge model unavailable: /) });
    const line = passJudgeLines(r.tracer)[3];
    expect([line.status, line.input_summary]).toEqual(["not_judged", target.slice(0, 160)]);
    expect(line.output_summary).toMatch(/^judge not counted: judge model unavailable: /);
    expect(r.result.judge).toMatchObject({ not_counted: 1 });
  });

  it("live with no model configured: every open finding \"judge not counted: no model configured\", every decision as without the judge, no throw", async () => {
    const without = await passOver(policyBundle);
    const r = await passOver(policyBundle, { judge: live({ baseUrl: "" })! });
    expect(r.result.findings.map((f) => f.disposition)).toEqual(without.result.findings.map((f) => f.disposition));
    const open = r.result.findings.filter((f) => !f.judgeWithheld);
    expect(r.result.judge).toEqual({ model: config.nightshift.modelJudge, judged: open.length, struck: 0, held: 0, not_counted: open.length, unavailable: "no model configured: METERLESS_BASE_URL is blank" });
    expect(passJudgeLines(r.tracer).filter((e) => e.status === "not_judged").every((e) => /^judge not counted: no model configured: METERLESS_BASE_URL is blank/.test(e.output_summary ?? ""))).toBe(true);
    expect(r.dispositions).toEqual(without.dispositions);
  });

  it("judges only the tenant the judge is for: another tenant's findings are traced skipped and cost no call", async () => {
    const without = await passOver(policyBundle);
    const { judge, judgeCalls } = stubNightshift();
    const r = await passOver(policyBundle, { judge: { ...judge, tenant: "client-z" } });
    expect(judgeCalls()).toHaveLength(0);
    expect(r.result.findings.map((f) => f.disposition)).toEqual(without.result.findings.map((f) => f.disposition));
    expect(r.result.findings.every((f) => f.judge === "skipped")).toBe(true);
    expect(r.result.judge).toMatchObject({ judged: 0 });
    expect(passJudgeLines(r.tracer).filter((e) => !e.detail?.startsWith("verdict cannot move")).every((e) => e.status === "skipped" && e.detail === otherTenant("client-a", "client-z"))).toBe(true);
  });

  it("without a judge, the pass is model-free as before: every judge skipped, model: none, no tally", async () => {
    const r = await passOver(policyBundle);
    expect(r.result.findings.every((f) => f.judge === "skipped")).toBe(true);
    expect(r.result.judge).toBeUndefined();
    expect(passJudgeLines(r.tracer).every((e) => e.status === "skipped" && e.model_requested === "none")).toBe(true);
    expect(JSON.stringify(r.result.findings)).not.toContain("outcome");
  });

  for (const [name, bundle] of [["the policy fixture", policyBundle], ["the recorded fixture", recorded], ["the authored fixture", authored]] as const) {
    it(`at PASS_CONCURRENCY 1 and 4 over ${name}: the same findings, verdicts, ledger rows and trace, line for line`, { timeout: 120_000 }, async () => {
      const one = await passOver(bundle, { judge: stubNightshift().judge, concurrency: 1 });
      const four = await passOver(bundle, { judge: stubNightshift().judge, concurrency: 4 });
      expect(one.result.judge?.judged).toBeGreaterThan(0);
      expect(four.result).toEqual(one.result);
      expect(four.dispositions).toEqual(one.dispositions);
      expect(four.trace).toEqual(one.trace);
    });
  }
});

describe("the live pass against runEval's C3 over the recording", () => {
  const POLICY = "policy/hackathon.json";

  /** The shipped policy, or its rules on proxied records alone, so that some findings fall to the default. */
  function policies(dir: string): [string, string][] {
    const whole = JSON.parse(readFileSync(POLICY, "utf8")) as { rules: { surface: string; setting_glob: string }[] };
    const partial = path.join(dir, "proxied-only.json");
    writeFileSync(partial, JSON.stringify({ ...whole, rules: whole.rules.filter((x) => x.surface === "cloudflare.dns" && x.setting_glob === "proxied") }));
    return [["the shipped policy", POLICY], ["the rules on proxied records only", partial]];
  }

  it("gives each finding C3 judged the verb, decided_by and rule C3 gives it, except a default ESCALATE struck, which C3 adopts", { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "falsifier-policy-"));
    try {
      for (const [name, file] of policies(dir)) {
        // one stub for both ports: its receipts live with the instance that filed them
        const stub = stubNightshift();
        const eval3 = await runEval({ protocolText: readFileSync("eval/PROTOCOL.md", "utf8"), evalSet: loadEvalSet(), bundle: recorded, configs: ["C3"], runs: 1, policyFile: file, models: { nightshift: stub.judge.nightshift, receipts: () => stub.judge.receipts } });
        const subjects = eval3.runs[0].items.filter((i) => i.kind === "pass").flatMap((i) => i.subjects).filter((s) => s.judge !== null && "status" in s.judge);
        expect(subjects.length, name).toBeGreaterThan(0);
        const live = await passOver(recorded, { judge: stubNightshift().judge, policyFile: file, decidedAt: decisionInstant(recorded) });
        const byId = new Map(live.result.findings.map((f) => [f.id, f]));
        let clamped = 0;
        for (const s of subjects) {
          const f = byId.get(s.finding_id)!;
          expect(f, `${name} ${s.finding_id}`).toBeDefined();
          expect(judged(f)?.outcome, `${name} ${s.finding_id}`).toBe("struck");
          const c3verb = s.verb;
          if (s.decided_by === "default" && judged(f)?.before === "ESCALATE") {
            expect([c3verb, f.verb], `${name} ${s.finding_id}`).toEqual(["ADOPT", "ESCALATE"]);
            clamped += 1;
            continue;
          }
          expect([f.verb, f.disposition.decided_by, f.disposition.rule_id], `${name} ${s.finding_id}`).toEqual([c3verb, s.decided_by, s.rule_id]);
        }
        // under the shipped policy a rule decides every finding, so a strike moves no verb in C3 either
        if (file === POLICY) expect(clamped, name).toBe(0);
        else expect(clamped, name).toBeGreaterThan(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the pass step, its row and the ticket", () => {
  it("the summary and the pass row report the findings judged, struck, held and not counted; without a judge, as before", { timeout: 60_000 }, async () => {
    const run = async (judge?: PassJudge) => {
      const { engine, layer } = await layerOver(policyBundle);
      try {
        return await passStep(layer, { tenant: "client-a", ledger: null, decidedAt: AT, world: new DriftWorld("test_falsifier"), ...(judge ? { judge } : {}) });
      } finally {
        engine.close();
      }
    };
    const plain = await run();
    expect(plain.summary).toContain("; judge skipped (model: none); ");
    const r = await run(stubNightshift().judge);
    const t = r.pass.judge!;
    expect(r.summary).toContain(`; ${judgeClause(t)}; `);
    expect(judgeClause(t)).toBe(`judge: ${tallyText(t)}`);
    const rows = new Table({ ...PLAIN, width: 200 }).row("pass", passView(r), null);
    const line = rows.find((l) => /^ +judge +\S/.test(l));
    expect(line?.trim().replace(/^judge +/, "")).toBe(`${shortModel(config.nightshift.modelJudge)} · ${t.judged} judged · ${t.struck} struck · ${t.held} held · ${t.not_counted} not counted`);
    expect(t.judged).toBeGreaterThan(0);
    expect(new Table({ ...PLAIN, width: 200 }).row("pass", passView(plain), null).some((l) => /^ +judge +\S/.test(l))).toBe(false);
    // live with no runtime token: the pass runs, each open finding not counted, said so on the summary and the row
    const none = await run(live({ token: "" })!);
    expect(none.pass.findings.map((f) => f.disposition)).toEqual(plain.pass.findings.map((f) => f.disposition));
    expect(none.summary).toMatch(/; judge not counted: no model configured: no Nightshift runtime token .*, \d+ finding\(s\); /);
    // DRIFT_JUDGE off: the same, said as "judge off"
    const off = await run(live({ judge: "off" })!);
    expect(off.pass.findings.map((f) => f.disposition)).toEqual(plain.pass.findings.map((f) => f.disposition));
    expect(off.summary).toMatch(/; judge not counted: judge off: DRIFT_JUDGE is off, \d+ finding\(s\); /);
    expect(new Table({ ...PLAIN, width: 200 }).row("pass", passView(off), null).find((l) => /^ +judge +\S/.test(l))?.trim()).toMatch(/^judge +not counted: judge off · \d+ findings?$/);
    const noneRow = new Table({ ...PLAIN, width: 200 }).row("pass", passView(none), null).find((l) => /^ +judge +\S/.test(l));
    expect(noneRow?.trim()).toMatch(/^judge +not counted: no model configured · \d+ findings?$/);
  });

  it("the ticket's Evidence names the verdict, the SELECT and its rows, the receipt and its signature, the model; its Receipts the judge's receipt", async () => {
    const { judge } = stubNightshift();
    const r = await passOver(policyBundle, { judge });
    const f = r.result.findings.find((x) => x.verb === "ESCALATE")!;
    const d = r.dispositions.find((x) => x.finding_id === f.id)!;
    const body = ticketBody({ finding: f, disposition: d, rule: null, actions: [], probes: { run_id: null, rows: [] }, ticketId: "tkt-1", type: "incident", priority: "P2" });
    const j = judged(f)!;
    expect(body).toContain(`- judge: Nemotron 3 Ultra struck the claim: ${j.reason}; ${j.effect}`);
    expect(body).toContain(`  - ${judgeDetail(j)}`);
    // no action receipt: the Receipts section is the judge's line alone, no "- none"
    expect(body).toContain(`### Receipts\n- judge receipt ${j.receipt_id} verified, served ${modelName(ULTRA_MODEL)}\n`);
    const withAction = ticketBody({ finding: f, disposition: d, rule: null, actions: [{ action_id: "act-1", kind: "investigate", status: "done", started_at: AT, finished_at: AT, before_hash: null, after_hash: null, vault_commit: null, verification: "", target: "t", reason: "", record: "", receipts: "rcpt_act_1", disposition_id: d.disposition_id } as never], probes: { run_id: null, rows: [] }, ticketId: "tkt-1", type: "incident", priority: "P2" });
    expect(withAction).toContain(`### Receipts\n- rcpt_act_1\n- judge receipt ${j.receipt_id} verified`);
    expect(isJudged(f)).toBe(true);
    expect(isJudged({ judge: "skipped" })).toBe(false);
    expect(isJudged({})).toBe(false);
    const plain = ticketBody({ finding: { ...f, judge: "skipped" }, disposition: d, rule: null, actions: [], probes: { run_id: null, rows: [] }, ticketId: "tkt-1", type: "incident", priority: "P2" });
    expect(plain).not.toContain("- judge");
  });
});
