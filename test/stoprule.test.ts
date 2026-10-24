// The verifier's stop rule and the withdraw rule before the judge (src/stoprule.ts): unit cases on the rule
// itself, then the pass over the recorded bundle (sample/bundle.json, the real estate redacted) with the rule
// active. Every number asserted over the bundle was measured on sql.js; the flips audit (a skipped check that
// would have changed the verb) compares a run with the rule against a run with it off, finding by finding.
import { describe, expect, it } from "vitest";
import { CATALOGUE } from "../src/catalogue/templates.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { AUDIT_TEMPLATES, runPass, type Finding } from "../src/pipeline.ts";
import {
  CLAIM_WITHDRAWN, INFORMS_NEXT_ACTION, VERDICT_CANNOT_MOVE, countersSummary, earlyStopSummary, shouldStop, shouldWithdraw, stopCounters, tablesOf,
  type StopPolicy,
} from "../src/stoprule.ts";
import recorded from "../sample/bundle.json" with { type: "json" };
import { MemTracer } from "./fixtures/mem-tracer.ts";

type R = typeof recorded;

const holds = (template: string) => ({ template, holds: true });
const fails = (template: string) => ({ template, holds: false });
/** The literal reading of "stop when the verdict can no longer move": nothing informs the next action. */
const NOTHING_INFORMS = Object.fromEntries(CATALOGUE.map((t) => [t.id, false]));

async function pass(b: Readonly<Record<string, unknown>>, stopPolicy?: Omit<StopPolicy, "gatedTables">) {
  const engine = await SqlJsEngine.create();
  engine.loadBundle(b);
  const tracer = new MemTracer("test_stoprule", { model: "none" });
  const result = await runPass(new DataLayer(engine), { tracer, world: new DriftWorld("test_stoprule"), stopPolicy });
  return { result, tracer };
}

/** What the decision depends on, per finding, in pass order: the flips audit compares these. */
const verdicts = (fs: Finding[]) => fs.map((f) => [f.finding.class, f.finding.object_id, f.finding.setting_path, f.finding.resource_id, f.verb]);
const checkQueries = (t: MemTracer) => t.events.filter((e) => e.action === "query" && e.agent === "checker" && e.status === "ok").length;

describe("shouldStop", () => {
  it("stops when the verb is settled: a required check failed, and it skips only the queued checks that do not inform the next action", () => {
    const d = shouldStop({
      findingClass: "found_but_different", checksSoFar: [holds("run_complete"), fails("dns_target_in_inventory")],
      remaining: ["actor_attributed", "other_settings_reference"], policy: { informsNextAction: { ...INFORMS_NEXT_ACTION, other_settings_reference: false } },
    });
    expect(d).toEqual({ stop: true, kind: "settled", skipped: ["other_settings_reference"], reason: "verdict settled by dns_target_in_inventory; informs_next_action=false" });
  });

  it("a check that was not checked settles the verdict too: ESCALATE is absorbing whatever runs after it", () => {
    const d = shouldStop({ findingClass: "dns_change", checksSoFar: [holds("run_complete")], rejected: ["host_in_inventory"], remaining: ["actor_attributed"], policy: { informsNextAction: NOTHING_INFORMS } });
    expect(d).toMatchObject({ stop: true, kind: "settled", skipped: ["actor_attributed"], reason: "verdict settled by host_in_inventory (not checked); informs_next_action=false" });
  });

  it("with the default table the same settled verdict skips nothing: every template informs the next action until the operator marks one false", () => {
    expect(CATALOGUE.map((t) => t.id).filter((id) => !(id in INFORMS_NEXT_ACTION))).toEqual([]);
    const d = shouldStop({ findingClass: "found_but_different", checksSoFar: [holds("run_complete"), fails("dns_target_in_inventory")], remaining: ["actor_attributed", "other_settings_reference"], policy: {} });
    expect(d).toEqual({ stop: false, kind: "none", skipped: [], reason: "verdict settled by dns_target_in_inventory; every remaining check informs the next action" });
  });

  it("run_complete failing skips everything queued, informing or not: the run is not a safe basis for any other check", () => {
    const d = shouldStop({ findingClass: "proxy_split", checksSoFar: [fails("run_complete")], remaining: ["actor_attributed", "previous_value_recoverable", "referent_unchanged"], policy: {} });
    expect(d.stop).toBe(true);
    expect(d.kind).toBe("basis");
    expect(d.skipped).toEqual(["actor_attributed", "previous_value_recoverable", "referent_unchanged"]);
    expect(d.reason).toMatch(/^verdict settled by run_complete; informs_next_action=false/);
  });

  it("does not stop while a remaining check could still flip ADOPT/ESCALATE, whatever the table says", () => {
    // every check so far holds: the next one decides between ADOPT and ESCALATE
    expect(shouldStop({ findingClass: "orphan_record", checksSoFar: [holds("run_complete"), holds("host_in_inventory")], remaining: ["actor_attributed", "previous_value_recoverable"], policy: { informsNextAction: NOTHING_INFORMS } }))
      .toEqual({ stop: false, kind: "none", skipped: [], reason: "verdict open: a remaining check could still move ADOPT to ESCALATE" });
    // a failing check the policy does not require (advisory) does not settle anything
    expect(shouldStop({ findingClass: "orphan_vhost", checksSoFar: [holds("run_complete"), fails("other_settings_reference")], remaining: ["backup_recent"], policy: { required: ["run_complete", "backup_recent"], informsNextAction: NOTHING_INFORMS } }).stop).toBe(false);
    // nothing left, and the rule switched off
    expect(shouldStop({ findingClass: "orphan_vhost", checksSoFar: [fails("run_complete")], remaining: [], policy: {} }).stop).toBe(false);
    expect(shouldStop({ findingClass: "proxy_split", checksSoFar: [fails("run_complete")], remaining: ["actor_attributed"], policy: { enabled: false } }))
      .toMatchObject({ stop: false, reason: "stop rule disabled" });
  });

  it("stops when every remaining check reads a source whose run is gated out, even with the verdict still open; one that reads something else keeps it going", () => {
    expect(tablesOf("referent_unchanged").sort()).toEqual(["audit_event", "dns_record"]);
    expect(CATALOGUE.map((t) => t.id).filter((id) => tablesOf(id).includes("audit_event"))).toEqual(AUDIT_TEMPLATES);
    const gated = { gatedTables: ["audit_event"] };
    expect(shouldStop({ findingClass: "proxy_split", checksSoFar: [holds("run_complete")], remaining: ["actor_attributed", "previous_value_recoverable", "referent_unchanged"], policy: gated }))
      .toEqual({ stop: true, kind: "gated", skipped: ["actor_attributed", "previous_value_recoverable", "referent_unchanged"], reason: "every remaining check reads audit_event, whose collection run is gated out this pass" });
    expect(shouldStop({ findingClass: "proxied_without_real_ip", checksSoFar: [holds("run_complete")], remaining: ["host_in_inventory", "actor_attributed"], policy: gated }).stop).toBe(false);
  });
});

describe("shouldWithdraw (before the judge)", () => {
  it("withholds the judge when the verdict is ESCALATE whatever it answers", () => {
    const cases = [
      shouldWithdraw({ findingClass: "proxy_split", checks: [holds("run_complete")], rejected: 3 }),
      shouldWithdraw({ findingClass: "dns_change", checks: [fails("run_complete"), holds("host_in_inventory")], rejected: 0 }),
      shouldWithdraw({ findingClass: "orphan_vhost", checks: [], rejected: 0 }),
      shouldWithdraw({ findingClass: "proxy_split", checks: [holds("run_complete")], rejected: 0, proposalInvalid: true }),
    ];
    expect(cases.every((c) => c.withdraw && c.reason.startsWith(`${VERDICT_CANNOT_MOVE}: `))).toBe(true);
    expect(cases[0].reason).toBe("verdict cannot move: 3 check(s) not checked; a judge cannot supply missing evidence, so the finding escalates whatever it answers");
  });

  it("withdraws a claim its own check contradicts, for the class whose claim that check contradicts only", () => {
    expect(shouldWithdraw({ findingClass: "found_but_different", checks: [holds("run_complete"), holds("referent_unchanged")], rejected: 0 }))
      .toEqual({ withdraw: true, contradictedBy: "referent_unchanged", reason: `${CLAIM_WITHDRAWN}: referent_unchanged holds on a found_but_different` });
    expect(shouldWithdraw({ findingClass: "dns_change", checks: [holds("run_complete"), holds("record_reverted")], rejected: 0 }).contradictedBy).toBe("record_reverted");
    // proxy_split claims no change: referent_unchanged holding there contradicts nothing
    expect(shouldWithdraw({ findingClass: "proxy_split", checks: [holds("run_complete"), holds("referent_unchanged")], rejected: 0 }).withdraw).toBe(false);
  });

  it("keeps the judge when its answer can still move the verb: an ordinary failing check, or every check holding", () => {
    expect(shouldWithdraw({ findingClass: "proxied_without_real_ip", checks: [holds("run_complete"), holds("host_in_inventory"), fails("actor_attributed")], rejected: 0 }))
      .toEqual({ withdraw: false, reason: "the judge's answer can still move the verb" });
    expect(shouldWithdraw({ findingClass: "orphan_vhost", checks: [holds("run_complete"), holds("backup_recent")], rejected: 0 }).withdraw).toBe(false);
  });
});

describe("stopCounters reads the trace", () => {
  it("parses exactly the lines the pass writes, and nothing else", () => {
    const ev = [
      { agent: "checker", action: "check" as const, status: "skipped" as const, output_summary: earlyStopSummary("settled", ["previous_value_recoverable"]) },
      { agent: "checker", action: "check" as const, status: "skipped" as const, detail: "verdict settled by actor_attributed; informs_next_action=false" }, // the per-check line: not a stop
      { agent: "checker", action: "check" as const, status: "skipped" as const, output_summary: earlyStopSummary("gated", ["actor_attributed", "referent_unchanged"]) },
      { agent: "decider", action: "triage" as const, status: "ok" as const, output_summary: "early_stop 9, checks_skipped 9, checks_gated 9, withdrawn_judge 9" },
      { agent: "judge", action: "judge" as const, status: "skipped" as const, detail: `${VERDICT_CANNOT_MOVE}: no precondition ran` },
      { agent: "judge", action: "judge" as const, status: "skipped" as const, detail: "model: none (sample)" },
    ];
    expect(earlyStopSummary("gated", ["actor_attributed", "referent_unchanged"])).toBe("early_stop gated: 2 check(s) not checked: actor_attributed, referent_unchanged");
    expect(stopCounters(ev)).toEqual({ early_stop: 2, checks_skipped: 1, checks_gated: 2, withdrawn_judge: 1 });
  });
});

describe("the pass over the recorded bundle with the stop rule active", () => {
  it("still yields 27 findings in the same four classes; with the default table it skips nothing, and the trace says so", async () => {
    const { result, tracer } = await pass(recorded);
    expect(result.findings).toHaveLength(27);
    const byClass: Record<string, number> = {};
    for (const f of result.findings) byClass[f.finding.class] = (byClass[f.finding.class] ?? 0) + 1;
    expect(byClass).toEqual({ proxy_split: 1, proxied_without_real_ip: 20, orphan_record: 3, orphan_vhost: 3 });
    expect(result.findings.filter((f) => f.verb === "ADOPT")).toHaveLength(5);
    expect(result.verifier).toEqual({ early_stop: 0, checks_skipped: 0, checks_gated: 0, withdrawn_judge: 0 });
    const summary = tracer.events.filter((e) => e.agent === "decider" && e.action === "triage" && e.input_summary === "stop rule");
    expect(summary.map((e) => e.output_summary)).toEqual([countersSummary(result.verifier)]);
    expect(summary[0].output_summary).toBe("early_stop 0, checks_skipped 0, checks_gated 0, withdrawn_judge 0");
    expect(stopCounters(tracer.events)).toEqual(result.verifier);
    expect(tracer.events.filter((e) => e.status === "skipped" && e.action === "check")).toEqual([]);
    expect(tracer.events.filter((e) => e.action === "judge").map((e) => e.detail)).toEqual(Array(27).fill("model: none (sample)"));
    expect(result.findings.every((f) => f.earlyStop === undefined && f.judgeWithheld === undefined)).toBe(true);
    expect(checkQueries(tracer)).toBe(4 * 24 + 3 * 3);
  });

  it("the literal rule (no check informs the next action once the verdict is settled) skips 18 checks over 18 findings and flips no verb", async () => {
    const off = await pass(recorded, { enabled: false });
    const on = await pass(recorded, { informsNextAction: NOTHING_INFORMS });
    expect(verdicts(on.result.findings)).toEqual(verdicts(off.result.findings)); // the flips audit: zero
    expect(on.result.findings.map((f) => f.exposure)).toEqual(off.result.findings.map((f) => f.exposure));
    expect(on.result.verifier).toEqual({ early_stop: 18, checks_skipped: 18, checks_gated: 0, withdrawn_judge: 0 });
    expect(stopCounters(on.tracer.events)).toEqual(on.result.verifier);
    expect(off.result.verifier).toEqual({ early_stop: 0, checks_skipped: 0, checks_gated: 0, withdrawn_judge: 0 });
    // every skip is a traced line with its reason, and its SQL never ran
    const lines = on.tracer.events.filter((e) => e.agent === "checker" && e.action === "check" && e.status === "skipped");
    const skipped = lines.filter((e) => !e.output_summary?.startsWith("early_stop"));
    expect(skipped).toHaveLength(18);
    expect(lines.filter((e) => e.output_summary?.startsWith("early_stop settled: 1 check(s) skipped: "))).toHaveLength(18);
    const tally: Record<string, number> = {};
    for (const e of skipped) tally[e.input_summary!.split(" ")[0]] = (tally[e.input_summary!.split(" ")[0]] ?? 0) + 1;
    expect(tally).toEqual({ previous_value_recoverable: 16, backup_recent: 2 });
    expect(skipped.every((e) => /^verdict settled by (actor_attributed|other_settings_reference); informs_next_action=false$/.test(e.detail ?? ""))).toBe(true);
    expect(checkQueries(off.tracer) - checkQueries(on.tracer)).toBe(18);
    // the decide step receives { earlyStop: true, reason }, and the finding carries what was skipped
    const stopped = on.result.findings.filter((f) => f.earlyStop);
    expect(stopped).toHaveLength(18);
    const wild = stopped.find((f) => f.finding.setting_path === "http.real_ip")!;
    expect(wild.earlyStop).toEqual({ reason: "verdict settled by actor_attributed; informs_next_action=false", skipped: ["previous_value_recoverable"] });
    expect(wild.checks.map((c) => c.template)).toEqual(["run_complete", "host_in_inventory", "actor_attributed"]);
    expect(on.tracer.events.filter((e) => e.action === "decide" && e.detail?.includes("; earlyStop: true (verdict settled by"))).toHaveLength(18);
  });

  it("a gated audit run: every check that reads the log is recorded at once as not checked, the verbs and rejections are those of the rule switched off, and no judge call is spent on the 24 findings that cannot move", async () => {
    const b = structuredClone(recorded) as R;
    const audit = b.collection_run.find((r) => r.surface === "cloudflare.audit")!;
    audit.status = "partial";
    audit.observed_count = (audit.expected_count ?? 1) - 1;
    const off = await pass(b, { enabled: false });
    const on = await pass(b);
    expect(verdicts(on.result.findings)).toEqual(verdicts(off.result.findings));
    expect(on.result.findings.map((f) => f.rejected)).toEqual(off.result.findings.map((f) => f.rejected));
    // proxy_split 3 after run_complete, proxied_without_real_ip 2 x 20 and orphan_record 2 x 3 after host_in_inventory
    expect(on.result.verifier).toEqual({ early_stop: 24, checks_skipped: 0, checks_gated: 3 + 2 * 20 + 2 * 3, withdrawn_judge: 24 });
    expect(stopCounters(on.tracer.events)).toEqual(on.result.verifier);
    // the withdraw rule does not need the stop rule: the switched-off run withholds the same 24 judge calls
    expect(off.result.verifier.withdrawn_judge).toBe(24);
    const split = on.result.findings.find((f) => f.finding.class === "proxy_split")!;
    expect(split.earlyStop).toEqual({ reason: "every remaining check reads audit_event, whose collection run is gated out this pass", skipped: ["actor_attributed", "previous_value_recoverable", "referent_unchanged"] });
    expect(split.judgeWithheld).toBe("verdict cannot move: 3 check(s) not checked; a judge cannot supply missing evidence, so the finding escalates whatever it answers");
    const judge = on.tracer.events.filter((e) => e.action === "judge");
    expect(judge).toHaveLength(27);
    expect(judge.filter((e) => e.detail?.startsWith(VERDICT_CANNOT_MOVE))).toHaveLength(24);
    // orphan_vhost reads no audit row: it runs every check and keeps its judge
    expect(on.result.findings.filter((f) => f.finding.class === "orphan_vhost").every((f) => f.earlyStop === undefined && f.judgeWithheld === undefined)).toBe(true);
    const stops = on.tracer.events.filter((e) => e.agent === "checker" && e.status === "skipped" && e.output_summary?.startsWith("early_stop"));
    expect(stops).toHaveLength(24);
    // the trace names no agent the pass did not already have
    expect([...new Set(on.tracer.events.map((e) => e.agent))].sort()).toEqual(["checker", "decider", "detector", "judge", "observer"]);
    expect(stops[0].output_summary).toBe("early_stop gated: 3 check(s) not checked: actor_attributed, previous_value_recoverable, referent_unchanged");
  });
});
