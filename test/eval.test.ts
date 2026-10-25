// The eval runner (src/eval/, scripts/eval.ts) against eval/PROTOCOL.md, offline: the split is reproducible
// from the files alone; the configuration table, the run count and the verb reading are read from the
// protocol; the Wilson interval; item matching on the recording the items came from
// (test/fixtures/recorded-bundle.json); history items read from its audit log; the eval queries' rows; the
// planted claims false on sql.js; the check path reproducing the pass; and every configuration end to end
// with stubbed Nemotron replies under receipts signed with a throwaway key (test/fixtures/signed-receipt.ts),
// a substitution invalidating its run. EVAL_LIVE=true runs C1 and C3 on three development items once through
// the live Nightshift and prints each call's receipt; skipped otherwise.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { SignedReceipt } from "../src/adapters/nightshift.ts";
import { SYSTEM_PROMPT, type JudgeModel } from "../src/agents/judge.ts";
import { defaultChecks, type FindingSummary } from "../src/catalogue/select.ts";
import { config } from "../src/config.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { decisionInstant } from "../src/data/instant.ts";
import { DataLayer } from "../src/data/layer.ts";
import { objects } from "../src/data/queries.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { assessChecks } from "../src/eval/assess.ts";
import { historyFinding } from "../src/eval/history.ts";
import { itemKind, loadEvalSet, matchItem } from "../src/eval/items.ts";
import { wilson } from "../src/eval/measures.ts";
import { DIRECT_SYSTEM_PROMPT, parseDirect } from "../src/eval/models.ts";
import { falseRows, loadPlanted, plantedEvidence } from "../src/eval/planted.ts";
import { ProtocolError, readProtocol } from "../src/eval/protocol.ts";
import { AUDIT_OF_RESOURCE_SQL, DELETES_IN_WINDOW_SQL, EVAL_PARITY_CASES, EVIDENCE_SQL, evidenceParams } from "../src/eval/queries.ts";
import { renderSummary } from "../src/eval/report.ts";
import { runEval, type EvalResult } from "../src/eval/run.ts";
import { labelsSeed, seededShuffle, splitItems } from "../src/eval/split.ts";
import { LogTracer, logLine } from "../src/eval/tracer.ts";
import { runPass, type Finding } from "../src/pipeline.ts";
import recorded from "./fixtures/recorded-bundle.json" with { type: "json" };
import sampleBundle from "../sample/bundle.json" with { type: "json" };
import { signed } from "./fixtures/signed-receipt.ts";

const PROTOCOL = readFileSync("eval/PROTOCOL.md", "utf8");
const LABELS_TEXT = readFileSync("eval/labels.json", "utf8");
const evalSet = loadEvalSet();

const DEV = ["E30", "E07", "E13", "E34", "E03", "E17", "E04", "E32", "E08", "E31", "E10", "E16", "E37", "E38", "E24"];
const HELDOUT = ["E01", "E14", "E12", "E21", "E26", "E35", "E29", "E23", "E02", "E11", "E18", "E28", "E19", "E25", "E15", "E09", "E33", "E20", "E22", "E27", "E36", "E06", "E05"];

let layer: DataLayer;
let findings: Finding[];

beforeAll(async () => {
  const engine = await SqlJsEngine.create();
  engine.loadBundle(recorded);
  layer = new DataLayer(engine);
  findings = (await runPass(layer, { world: new DriftWorld("test_eval"), decidedAt: decisionInstant(recorded) })).findings;
});

describe("split", () => {
  it("is reproducible from the labels file alone: seed = sha256 of labels.json, the first 40% development, the rest held out", () => {
    const seed = labelsSeed(LABELS_TEXT);
    expect(seed).toBe("eaad75c7a2dca621fbae34c92b20a1658bf9778ab8b0de03cfdfe9b8ed4e94c2");
    const s = splitItems(evalSet.labels.map((l) => l.id), seed);
    expect(s.dev).toEqual(DEV);
    expect(s.heldout).toEqual(HELDOUT);
    expect([...s.dev, ...s.heldout].sort()).toEqual(evalSet.labels.map((l) => l.id).sort());
    expect(splitItems(evalSet.labels.map((l) => l.id), seed)).toEqual(s);
  });

  it("a CRLF checkout of the same file gives the same seed; another file gives another order", () => {
    expect(labelsSeed(LABELS_TEXT.replace(/\n/g, "\r\n"))).toBe(labelsSeed(LABELS_TEXT));
    const ids = Array.from({ length: 38 }, (_, i) => `E${String(i + 1).padStart(2, "0")}`);
    const a = seededShuffle(ids, labelsSeed(LABELS_TEXT));
    const b = seededShuffle(ids, labelsSeed(`${LABELS_TEXT} `));
    expect([...a].sort()).toEqual(ids);
    expect(a).not.toEqual(b);
  });
});

describe("protocol", () => {
  it("reads the configuration table, the run count and the verb reading from eval/PROTOCOL.md", () => {
    const p = readProtocol(PROTOCOL);
    expect(p.configs.map((c) => [c.id, c.select, c.judge, c.direct])).toEqual([
      ["C0", { kind: "default" }, null, null],
      ["C1", { kind: "model", tier: "lightning" }, null, null],
      ["C2", { kind: "model", tier: "lightning" }, "lightning", null],
      ["C3", { kind: "model", tier: "lightning" }, "ultra", null],
      ["C4", { kind: "none" }, null, "ultra"],
    ]);
    expect(p.configs[3].text).toBe("C1 plus Nemotron 3 Ultra as the falsifier judge");
    expect(p.runs).toBe(3);
    expect(p.reads).toEqual({ yes: ["ESCALATE", "FIX"], no: ["ADOPT", "HOLD", "ROLLBACK"] });
  });

  it("refuses a row no rule reads, a base no earlier row defines and a missing reading", () => {
    expect(() => readProtocol(PROTOCOL.replace("C1 plus Nemotron 3 Ultra as the falsifier judge", "C1 plus a technician's opinion"))).toThrow(ProtocolError);
    expect(() => readProtocol(PROTOCOL.replace("| C2 | C1 plus", "| C2 | C9 plus"))).toThrow(/C9, which no earlier row defines/);
    expect(() => readProtocol(PROTOCOL.replace("`yes` expects", "yes expects"))).toThrow(/reading of the verbs/);
    expect(() => readProtocol(PROTOCOL.replace("Three runs of each configuration", "Runs of each configuration"))).toThrow(/runs of each configuration/);
  });
});

describe("wilson", () => {
  it("gives the Wilson score interval at 95%", () => {
    const ten = wilson(10, 10)!;
    expect(ten.p).toBe(1);
    expect(ten.lo).toBeCloseTo(0.7225, 4);
    expect(ten.hi).toBeCloseTo(1, 12);
    const half = wilson(5, 10)!;
    expect(half.lo).toBeCloseTo(0.2366, 4);
    expect(half.hi).toBeCloseTo(0.7634, 4);
    const none = wilson(0, 29)!;
    expect(none.lo).toBe(0);
    expect(none.hi).toBeCloseTo(0.1170, 4);
    expect(wilson(0, 0)).toBeNull();
  });
});

describe("items on the recording", () => {
  it("every pass item of a raised class matches; the single-object items one finding each by their facts, the changed_since_backup items the host's findings by refs; the drift_vs_approved items are not raised", () => {
    const raised = findings.map((f) => ({ id: f.id, finding: f.finding }));
    const pass = evalSet.items.filter((i) => itemKind(i) === "pass");
    const raisedClasses = new Set(findings.map((f) => f.finding.class));
    const ofRaised = pass.filter((i) => raisedClasses.has(i.class as Finding["finding"]["class"]));
    expect(ofRaised).toHaveLength(17);
    const matches = new Map(ofRaised.map((i) => [i.id, matchItem(i, raised)]));
    for (const [id, m] of matches) {
      expect(m.kind, id).toBe("findings");
      if (m.kind !== "findings") continue;
      if (id === "E37" || id === "E38") {
        expect(m.via).toBe("refs");
        expect(m.findings.every((f) => f.finding.class === "changed_since_backup" && f.finding.host === evalSet.items.find((i) => i.id === id)!.refs.host)).toBe(true);
      } else {
        expect([id, m.via, m.findings.length]).toEqual([id, "facts", 1]);
      }
    }
    expect([matches.get("E37"), matches.get("E38")].map((m) => (m?.kind === "findings" ? m.findings.length : 0))).toEqual([6, 5]);
    // each single-object item names its own finding
    const single = [...matches.values()].flatMap((m) => (m.kind === "findings" && m.via === "facts" ? m.findings.map((f) => f.id) : []));
    expect(new Set(single).size).toBe(15);
    const unraisable = pass.filter((i) => !raisedClasses.has(i.class as Finding["finding"]["class"]));
    expect(unraisable.map((i) => [i.id, i.class])).toEqual(["E30", "E31", "E32", "E33", "E34", "E35", "E36"].map((id) => [id, "drift_vs_approved"]));
    for (const i of unraisable) expect(matchItem(i, raised)).toEqual({ kind: "not_raised", reason: "the recording raises no drift_vs_approved finding" });
  });

  it("history items become dns_change findings from the audit log: the www record's last change and the last deletion of each day", async () => {
    const ctx = { tenant_id: "client-1", dns_run_id: "run-f9470e2f5f175899" };
    const history = evalSet.items.filter((i) => itemKind(i) === "history");
    expect(history).toHaveLength(14);
    const out = await Promise.all(history.map((i) => historyFinding(layer, ctx, i)));
    expect(out.every((h) => h.kind === "finding")).toBe(true);
    const e17 = out[history.findIndex((i) => i.id === "E17")];
    expect(e17.kind === "finding" && e17.finding).toMatchObject({
      class: "dns_change", run_id: "run-f9470e2f5f175899", surface: "cloudflare.dns", host: null, object_id: "bce1ca2bb7caa2de9b6823d5f6ecd3f2", resource_id: "bce1ca2bb7caa2de9b6823d5f6ecd3f2",
      setting_path: "content", dns_name: "host-524b42.quest", resolves_to: null, refers_to_type: "dns_name", refers_to_id: "host-4c795e.quest",
      since: "2026-04-16T21:11:15.232Z", until: "2026-04-16T21:47:29.277Z",
    });
    expect(e17.kind === "finding" && e17.events).toBe(3);
    const e27 = out[history.findIndex((i) => i.id === "E27")];
    expect(e27.kind === "finding" && [e27.events, e27.finding.since, e27.finding.until, e27.finding.setting_path]).toEqual([8, "2026-10-11T00:17:11.206Z", "2026-10-11T12:21:57.973Z", "record"]);
    expect(await historyFinding(layer, ctx, { ...history[0], refs: { record_id: "0".repeat(32) } })).toEqual({ kind: "not_raised", reason: `the recording's audit log holds no change of record ${"0".repeat(32)}` });
  });

  it("the eval check path with the default selection gives the pass's verb and reason on every finding of the recording", async () => {
    expect(findings).toHaveLength(38);
    for (const f of findings) {
      const a = await assessChecks(layer, f.finding, defaultChecks(f.finding));
      expect([f.id, a.verb, a.why]).toEqual([f.id, f.verb, f.disposition.reason]);
      expect(a.checks).toEqual(f.checks);
    }
  });
});

describe("eval queries and planted claims", () => {
  it("AUDIT_OF_RESOURCE_SQL, DELETES_IN_WINDOW_SQL and EVIDENCE_SQL return the recording's rows", async () => {
    const www = objects(await layer.run(AUDIT_OF_RESOURCE_SQL, { tenant_id: "client-1", resource_id: "bce1ca2bb7caa2de9b6823d5f6ecd3f2" }));
    expect(www.map((e) => [e.action, e.occurred_at])).toEqual([["update", "2026-04-16T21:11:15.232Z"], ["update", "2026-04-16T21:12:47.270Z"], ["update", "2026-04-16T21:47:29.277Z"]]);
    const del = objects(await layer.run(DELETES_IN_WINDOW_SQL, { tenant_id: "client-1", since: "2026-10-11T00:00:00.000Z", until: "2026-10-12T00:00:00.000Z" }));
    expect(del).toHaveLength(8);
    expect(del.every((e) => e.action === "delete" && e.occurred_at.startsWith("2026-10-11"))).toBe(true);
    const split = findings.find((f) => f.finding.class === "proxy_split")!;
    const ev = objects(await layer.run(EVIDENCE_SQL, evidenceParams(split.finding)));
    expect(ev.map((r) => [r.source, r.field])).toEqual([
      ["audit_event", "update"], ["audit_event", "update"], ["audit_event", "update"], ["dns_record", "CNAME"],
    ]);
    expect(ev.find((r) => r.source === "dns_record")).toMatchObject({ row_id: "bce1ca2bb7caa2de9b6823d5f6ecd3f2", object: "host-524b42.quest", value: "host-4c795e.quest", detail: "proxied" });
    const file = findings.find((f) => f.finding.class === "changed_since_backup")!;
    const fev = objects(await layer.run(EVIDENCE_SQL, evidenceParams(file.finding)));
    expect(fev.map((r) => r.source)).toEqual(["observation"]);
  });

  it("each parity case runs on sql.js over sample/bundle.json, with rows", async () => {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(sampleBundle);
    const sample = new DataLayer(engine);
    for (const c of EVAL_PARITY_CASES) expect((await sample.run(c.sql, c.params, { limit: 10_000 })).rowCount, c.name).toBeGreaterThan(0);
  });

  it("eval/planted.json: ten claims, each false on the recording (its false_sql returns rows) and each with supporting rows", async () => {
    const p = loadPlanted();
    expect(p.recording).toBe("test/fixtures/recorded-bundle.json");
    expect(p.claims.map((c) => c.id)).toEqual(["P01", "P02", "P03", "P04", "P05", "P06", "P07", "P08", "P09", "P10"]);
    const counts = [];
    for (const c of p.claims) {
      counts.push(await falseRows(layer, c));
      expect((await plantedEvidence(layer, c)).rows.length, c.id).toBeGreaterThan(0);
    }
    expect(counts).toEqual([1, 3, 1, 9, 6, 1, 47, 1, 8, 1]);
  });
});

// ---------------------------------------------------------------- end to end, stubbed models

const ITEMS = ["E01", "E02", "E13", "E16", "E30", "E37"];
const STANDS = JSON.stringify({ refute_with_sql: "SELECT run_id FROM {{t:collection_run}} WHERE run_id = 'run-none'", rationale: "rows would show the claim false" });
const REFUTES = JSON.stringify({ refute_with_sql: "SELECT run_id FROM {{t:collection_run}} WHERE tenant_id = 'client-1'", rationale: "rows show the claim false" });

/** A Nightshift that answers each prompt kind, filing every answer under a receipt signed here for the request and app it was sent with. */
function stubModels(o: { serve?: (requested: string) => string; cache?: string; judge?: string; direct?: string; extra?: unknown } = {}) {
  const receipts = new Map<string, SignedReceipt>();
  const sent: Parameters<JudgeModel["chatWithFallback"]>[0][] = [];
  const nightshift: JudgeModel = {
    async chatWithFallback(opts) {
      sent.push(opts);
      const n = sent.length;
      const model = o.serve ? o.serve(opts.models[0]) : opts.models[0];
      const system = opts.messages[0].content;
      const user = opts.messages[opts.messages.length - 1].content;
      let content: string;
      if (system.startsWith("You select safety checks")) {
        const f = JSON.parse(user.slice(user.indexOf("{"), user.lastIndexOf("}") + 1)) as FindingSummary;
        content = JSON.stringify({ checks: [...defaultChecks(f).valid.map((c) => ({ template: c.template, params: c.params, why: "the class's default" })), ...(o.extra ? [o.extra] : [])] });
      } else if (system === SYSTEM_PROMPT) content = o.judge ?? STANDS;
      else content = o.direct ?? JSON.stringify({ verb: "HOLD", reason: "held for a later pass" });
      const receiptId = `rcpt_${n}`;
      const requestId = `req_${n}`;
      receipts.set(receiptId, signed({
        receipt_id: receiptId, request_id: requestId, app: opts.appId, routing: { winner: model }, phases: [{ model, phase: "final_synthesis" }], winning_route: { model },
        cache: { status: o.cache ?? "miss" }, requested_mode: "meterless/auto", status: "ok",
      }));
      return { content, modelRequested: opts.models[0], modelRouted: model, receiptId, requestId, tokensIn: 100, tokensOut: 20, latencyMs: 5, retries: 0, raw: {}, hop: 0 };
    },
  };
  return { models: { nightshift, receipts: () => ({ find: async (id: string) => receipts.get(id) ?? null }) }, sent };
}

const evalWith = (over: Partial<Parameters<typeof runEval>[0]>) => runEval({ protocolText: PROTOCOL, evalSet, bundle: recorded, items: ITEMS, runs: 1, ...over });
const verdicts = (r: EvalResult, config: string) => r.runs.filter((x) => x.config.id === config)[0].items.map((i) => [i.id, i.verdict]);

describe("runEval", () => {
  it("C0: two passes over the same rows give the same findings, verbs and reasons; the items' verdicts are the pass's", async () => {
    const r = await evalWith({ configs: ["C0"], runs: 2, items: undefined });
    expect(r.determinism.C0).toEqual({ compared: "the passes of runs 1 and 2", differences: [] });
    const c = r.runs[0].counts;
    expect([c.items, c.scored, c.not_raised, c.with_verdict, c.not_judged, c.agree, c.disagree, c.unsure, c.false_positives, c.labelled_no]).toEqual([38, 31, 7, 31, 0, 7, 22, 2, 22, 29]);
    expect([c.findings_assessed, c.findings_with_disposition, c.calls]).toEqual([40, 40, 0]);
    expect(r.baseline.findings).toHaveLength(38);
    expect(r.baseline.unmatched.map((f) => f.class)).toEqual(Array(12).fill("proxied_without_real_ip"));
    const e01 = r.runs[0].items.find((i) => i.id === "E01")!;
    expect([e01.verdict, e01.reading, e01.agree, e01.matched?.via]).toEqual(["ESCALATE", "yes", false, "facts"]);
    expect(renderSummary(r, { recording: "test/fixtures/recorded-bundle.json", out: "test" })).toContain("| C0 | the passes of runs 1 and 2 | 0 |");
  });

  it("C1: Lightning's selection, gated on its receipt, through the same checks; a selection of the defaults gives C0's verdicts", async () => {
    const { models, sent } = stubModels();
    const r = await evalWith({ configs: ["C0", "C1"], models });
    expect(verdicts(r, "C1")).toEqual(verdicts(r, "C0"));
    const run = r.runs.find((x) => x.config.id === "C1")!;
    expect(run.valid).toBe(true);
    expect([run.counts.checks_selected, run.counts.checks_valid, run.counts.checks_ran_unmodified, run.counts.calls, run.counts.cache_hits, run.counts.substitutions]).toEqual([38, 38, 38, 10, 0, 0]);
    expect(sent.every((o) => o.appId === "drift-agent-client-1" && /^\[request [0-9a-f]{16}\]\n/.test(o.messages[o.messages.length - 1].content) && o.models[0] === config.nightshift.modelFast)).toBe(true);
    expect(run.calls.every((c) => c.kind === "select" && c.gate === "ok" && c.served_tier === "lightning" && c.signature_ok === true && c.cache_status === "miss")).toBe(true);
  });

  it("C3: Ultra judges each claim whose verb can move; a strike makes the finding ADOPT and counts as agreed on a no label; the planted claims are struck", async () => {
    const { models } = stubModels({ judge: REFUTES });
    const r = await evalWith({ configs: ["C3"], models, planted: loadPlanted().claims });
    const run = r.runs[0];
    expect(run.valid).toBe(true);
    expect(run.items.map((i) => [i.id, i.verdict, i.strikes])).toEqual([["E01", "ADOPT", 1], ["E02", "ADOPT", 1], ["E13", "ADOPT", 1], ["E16", "ADOPT", 1], ["E30", null, 0], ["E37", "ADOPT", 6]]);
    expect([run.counts.falsifier_ran, run.counts.falsifier_struck, run.counts.agreed_strikes, run.counts.wrong_strikes, run.counts.judge_withheld]).toEqual([10, 10, 4, 0, 0]);
    expect(run.calls.filter((c) => c.kind === "judge" && c.served_tier === "ultra")).toHaveLength(20);
    expect(r.planted.map((p) => [p.id, p.status])).toEqual(loadPlanted().claims.map((c) => [c.id, "refuted"]));
    const md = renderSummary(r, { recording: "test/fixtures/recorded-bundle.json", out: "test" });
    expect(md).toContain("| C3 | 1 | ultra | 10 / 10 | 0 |");
    expect(md).toContain(`| C3 | judge | ultra | ${config.nightshift.modelJudge} | ${config.nightshift.modelJudge} | ultra | 20 | 0 | 0 | 0 |`);
    const stands = await evalWith({ configs: ["C3"], models: stubModels({ judge: STANDS }).models });
    expect(verdicts(stands, "C3")).toEqual([["E01", "ESCALATE"], ["E02", "ADOPT"], ["E13", "ADOPT"], ["E16", "ESCALATE"], ["E30", null], ["E37", "ESCALATE"]]);
    expect(stands.runs[0].counts.falsifier_struck).toBe(0);
    // an invented template is counted invalid, recorded as a rejection, escalates the finding and withholds the judge
    const invented = await evalWith({ configs: ["C3"], items: ["E02"], models: stubModels({ judge: REFUTES, extra: { template: "no_such_check", params: {}, why: "invented" } }).models });
    const e02 = invented.runs[0].items[0];
    expect([e02.verdict, e02.subjects[0].selection?.invalid, e02.subjects[0].judge]).toEqual(["ESCALATE", ["unknown template: no_such_check"], { withheld: "verdict cannot move: 1 check(s) not checked; a judge cannot supply missing evidence, so the finding escalates whatever it answers" }]);
    expect([invented.runs[0].counts.checks_selected, invented.runs[0].counts.checks_valid, invented.runs[0].counts.checks_invalid, invented.runs[0].counts.judge_withheld]).toEqual([5, 4, 1, 1]);
  });

  it("C4: Ultra alone answers one verb per item from its facts and rows; a reply with no verb files the item not judged", async () => {
    const r = await evalWith({ configs: ["C4"], models: stubModels().models });
    expect(verdicts(r, "C4")).toEqual([["E01", "HOLD"], ["E02", "HOLD"], ["E13", "HOLD"], ["E16", "HOLD"], ["E30", null], ["E37", "HOLD"]]);
    expect(r.runs[0].calls.map((c) => [c.kind, c.requested_tier, c.served_tier])).toEqual(Array(5).fill(["direct", "ultra", "ultra"]));
    const bad = await evalWith({ configs: ["C4"], models: stubModels({ direct: "I would hold it." }).models });
    expect(bad.runs[0].items.filter((i) => i.not_raised === null).every((i) => i.verdict === null && /invalid output/.test(i.not_judged ?? ""))).toBe(true);
    expect(parseDirect('thinking... {"verb": "escalate", "reason": "a technician takes it"}')).toEqual({ verb: "ESCALATE", reason: "a technician takes it" });
    expect(DIRECT_SYSTEM_PROMPT).toContain('"verb": "ADOPT" | "HOLD" | "ESCALATE"');
  });

  it("a substitution (Ultra served for a Lightning request) files the findings not judged and invalidates the run; cache hits are counted", async () => {
    const r = await evalWith({ configs: ["C1"], models: stubModels({ serve: () => config.nightshift.modelJudge }).models });
    const run = r.runs[0];
    expect(run.valid).toBe(false);
    expect(run.invalid_reason).toMatch(/^substitution: 10 call\(s\) served .*\(ultra\) for lightning$/);
    expect(run.items.filter((i) => i.not_raised === null).every((i) => i.verdict === null && /selection: receipt gate: receipt rcpt_\d+ \S+ \(ultra\), lightning was requested/.test(i.not_judged ?? ""))).toBe(true);
    expect(run.items.find((i) => i.id === "E37")!.not_judged).toMatch(/^6 of 6 findings not judged: /);
    const cached = await evalWith({ configs: ["C1"], models: stubModels({ cache: "hit" }).models });
    expect(cached.runs[0].counts.cache_hits).toBe(10);
  });

  it("refuses an unknown configuration and an item outside the chosen set", async () => {
    await expect(evalWith({ configs: ["C9"] })).rejects.toThrow(/C9 is absent from the protocol's table/);
    await expect(evalWith({ configs: ["C0"], set: "dev", items: ["E01"] })).rejects.toThrow(/E01 is outside the dev set/);
  });

  // C2 asks judgeClaim for the Lightning tier; it runs once src/agents/judge.ts takes JudgeInput.requestedTier.
  const judgeTakesTier = readFileSync("src/agents/judge.ts", "utf8").includes("requestedTier");
  it.skipIf(!judgeTakesTier)("C2: Lightning as the judge, the gate expecting Lightning", async () => {
    const r = await evalWith({ configs: ["C2"], models: stubModels({ judge: REFUTES }).models });
    expect(r.runs[0].valid).toBe(true);
    expect(r.runs[0].calls.filter((c) => c.kind === "judge").every((c) => c.requested_tier === "lightning" && c.served_tier === "lightning" && c.gate === "ok")).toBe(true);
    expect(r.runs[0].counts.falsifier_struck).toBe(10);
  });
});

// ---------------------------------------------------------------- live smoke

const live = process.env.EVAL_LIVE === "true";
if (!live) console.log("eval: live smoke skipped (set EVAL_LIVE=true to run C1 and C3 on three development items through Nightshift)");

describe.skipIf(!live)("EVAL_LIVE: C1 and C3 on three development items, one run", () => {
  it("every call is receipted; the served model and cache status of each are printed", { timeout: 900_000 }, async () => {
    const offline = await runEval({ protocolText: PROTOCOL, evalSet, bundle: recorded, configs: ["C0"], runs: 1, set: "dev" });
    const three = offline.split.dev.filter((id) => offline.runs[0].items.find((i) => i.id === id)?.matched?.findings.length === 1).slice(0, 3);
    expect(three).toHaveLength(3);
    const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
    const tracer = new LogTracer(`eval_live_${stamp}`);
    const r = await runEval({ protocolText: PROTOCOL, evalSet, bundle: recorded, configs: ["C1", "C3"], runs: 1, set: "dev", items: three, tracer });
    // One line per item and per call, to stdout and to logs/eval_live_<stamp>.log (the reporter may fold a passing test's output).
    const say = (line: string): void => { console.log(line); logLine(`eval_live_${stamp}`, line); };
    for (const run of r.runs) {
      for (const i of run.items) say(`EVAL_LIVE ${run.config.id} ${i.id} label ${i.label} verdict ${i.verdict ?? "not judged"}${i.not_judged ? ` (${i.not_judged})` : ""}`);
      for (const c of run.calls) {
        say(`EVAL_LIVE ${run.config.id} ${c.kind} ${c.item} attempt ${c.attempt}: requested ${c.requested_tier} ${c.model_requested}, served ${c.served_model ?? "-"} (${c.served_tier}), receipt ${c.receipt_id ?? "-"}, signature ${c.signature_ok}, cache ${c.cache_status ?? "-"}, gate ${c.gate}, ${c.latency_ms} ms, tokens ${c.tokens_in}/${c.tokens_out}${c.gate === "ok" ? "" : `: ${c.reason}`}`);
      }
      say(`EVAL_LIVE ${run.config.id} counts ${JSON.stringify(run.counts)}`);
    }
    say(`EVAL_LIVE trace ${tracer.logFile}`);
    const calls = r.runs.flatMap((x) => x.calls);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.receipt_id !== null || c.gate !== "ok")).toBe(true);
  });
});
