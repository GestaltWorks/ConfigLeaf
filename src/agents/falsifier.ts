// The falsifier in the live pass: the judge step of the eval's C3 (eval/PROTOCOL.md, "C1 plus Nemotron 3 Ultra as the
// falsifier judge"; src/eval/run.ts), run on every finding of a live pass that the withdraw rule does not withhold.
//
// Contract.
//   liveJudge   the pass's judge in live mode: the Nightshift client, its receipt list and Ultra's ladder
//               (METERLESS_MODEL_JUDGE, then METERLESS_FALLBACK_JUDGE, the ladder C3 requests). null in sample mode: the
//               pass runs no model and traces each judge "model: none (sample)". Live with no runtime token or no base
//               URL, a judge with no client: no call is made, and each finding is "judge not counted: no model configured".
//   judgeFinding  the call C3 makes for a finding (src/eval/models.ts judge): judgeClaim (src/agents/judge.ts) over the
//               finding's summary as the claim and its evidence rows (src/eval/queries.ts EVIDENCE_SQL, the rows C3 hands
//               the judge, through the same DataLayer), under the tenant's app id with custody, the receipt gate expecting
//               Ultra, every input through the model redactor. Ultra writes one refuting SELECT, the guard holds it to one
//               SELECT over known tables with LIMIT capped at 50, and the DataLayer runs it: rows strike the claim, none and
//               it holds. Then one judge line in the trace and the judgement on the finding.
//   counted     a verdict counts only when it is stands or refuted on a receipt the gate passed (signature verified,
//               Ultra served, no memory injected, custody holding). Anything else (a model error, a receipt failure, a
//               reply that is not one guarded SELECT, a SELECT that does not run, evidence that could not be read) is not
//               counted: the finding keeps the decision it had, and the trace says "judge not counted: <reason>".
//   applyVerdict  what a counted verdict does to the decision, as C3 decides a pass finding (src/eval/policy.ts
//               underPolicy): when a rule or the technician's exception decided it, that decision stands, verb, expiry,
//               rule and reason. When the default decided it, a struck claim takes C3's own verb, ADOPT ("the judge struck
//               the claim: ..."), and a claim that holds keeps the checks' verb ("...; the claim stands: ..."). One guard
//               more than C3: a strike never turns ESCALATE into ADOPT. C3 gives ADOPT to a default-decided finding whose
//               checks escalate and whose claim is struck; here the ESCALATE stands and its reason names the strike. A
//               default decides ADOPT or ESCALATE only, and every HOLD is a rule's, so a judge call never turns a HOLD or
//               an ESCALATE into ADOPT.
//
// Every string the judgement keeps passes the secret scrub and the model redactor, as C3's results do (src/eval/models.ts
// scrubber). Tested by test/falsifier.test.ts with a stubbed Nightshift and receipts signed in the test.

import { Nightshift } from "../adapters/nightshift.ts";
import type { FindingSummary } from "../catalogue/select.ts";
import { config, redact } from "../config.ts";
import type { DataLayer } from "../data/layer.ts";
import { EVIDENCE_SQL, evidenceParams } from "../eval/queries.ts";
import { ReceiptStore, type ReceiptFinder } from "../gate.ts";
import type { DispositionNote, Verb } from "../pipeline.ts";
import type { Tracer } from "../trace.ts";
import { judgeClaim, modelInputRedactor, type Evidence, type JudgeModel, type JudgeStatus, type JudgeVerdict } from "./judge.ts";

/** The rows a finding's evidence read returns at most; C3 reads them under the same limit (src/eval/run.ts evidenceOf). */
export const EVIDENCE_LIMIT = 200;

/** What the pass needs to judge: the Nightshift client, the receipt list and the ladder. */
export interface PassJudge {
  /** null when no model is configured: then no call is made and every judgement is not counted, "no model configured: <why>". */
  nightshift: JudgeModel | null;
  receipts: ReceiptFinder | null;
  /** The ladder, first id first; default ultraLadder(), the one C3 requests. */
  models?: readonly string[];
  /** Why no model is configured, when nightshift is null. */
  missing?: string;
  /**
   * Only this tenant's findings are judged. runPass reads every run of the datasource, so a live pass for one tenant also
   * decides the others' findings; src/loop/pass.ts sets its tenant here, whose findings alone it reports. Absent: every finding.
   */
  tenant?: string;
}

/** The skipped judge line's detail for a finding of another tenant than the one the judge is for. */
export const otherTenant = (finding: string, judged: string): string => `not judged in this pass: the finding is tenant ${finding}'s, the pass judges tenant ${judged}'s`;

/** The reason a judgement does not count when the live pass has no Nightshift to call. */
export const NO_MODEL = "no model configured";

/** Ultra's ladder as C3 requests it (src/eval/models.ts ladder("ultra")): the judge model, then its fallbacks. */
export const ultraLadder = (): string[] => [config.nightshift.modelJudge, ...config.nightshift.fallbackJudge];

/**
 * The live pass's judge. null in sample mode: the pass runs no model and traces each judge "model: none (sample)". Live
 * with no runtime token or no base URL, a judge with no client: every finding the withdraw rule leaves open is traced
 * "judge not counted: no model configured: <why>" and keeps its decision, and nothing throws.
 */
export function liveJudge(
  o: { sampleMode: boolean; token: string; baseUrl: string } = { sampleMode: config.sampleMode, token: config.nightshift.token, baseUrl: config.nightshift.baseUrl },
): PassJudge | null {
  if (o.sampleMode) return null;
  const missing = !o.baseUrl.trim() ? "METERLESS_BASE_URL is blank" : !o.token ? "no Nightshift runtime token (METERLESS_RUNTIME_TOKEN is blank and the runtime wrote no proxy-token file)" : null;
  if (missing) return { nightshift: null, receipts: null, models: ultraLadder(), missing };
  const nightshift = new Nightshift({ token: o.token });
  return { nightshift, receipts: new ReceiptStore(nightshift), models: ultraLadder() };
}

/** struck: refuted and counted; held: the claim stood, counted; not_counted: anything else. */
export type JudgeOutcome = "struck" | "held" | "not_counted";

/** The judge's verdict on one finding as the pass keeps it, on the finding, the trace line and the ticket. */
export interface PassJudgement {
  status: JudgeStatus;
  outcome: JudgeOutcome;
  /** The verdict's reason, or why it did not count. */
  reason: string;
  /** The refuting SELECT as run (LIMIT applied), or the model's text when the guard refused it; null when there was none. */
  sql: string | null;
  /** The rows the refuting SELECT returned; null when it did not run. */
  rows: number | null;
  receipt_id: string | null;
  /** The receipt's Ed25519 signature: true verified, false altered, null when no receipt was found or no model answered. */
  verified: boolean | null;
  /** The model the receipt says served, or the response's claim when no receipt was found. */
  served_model: string | null;
  /** The ladder's route that answered; null when none did. */
  route: string | null;
  /** The evidence rows the claim went out with (the judge's prompt shows at most 20). */
  evidence_rows: number;
  /** The verb before the verdict, and what the verdict did to the decision. */
  before: Verb;
  effect: string;
}

/** A pass's judge calls: the ladder's first id, the findings judged and how their verdicts came out; `missing` when no model is configured. */
export interface JudgeTally { model: string; judged: number; struck: number; held: number; not_counted: number; missing?: string }

export const zeroTally = (judge: PassJudge): JudgeTally => ({
  model: (judge.models ?? ultraLadder())[0], judged: 0, struck: 0, held: 0, not_counted: 0, ...(judge.nightshift ? {} : { missing: judge.missing ?? "no Nightshift client" }),
});

export function addToTally(t: JudgeTally, j: Pick<PassJudgement, "outcome">): void {
  t.judged += 1;
  if (j.outcome === "struck") t.struck += 1;
  else if (j.outcome === "held") t.held += 1;
  else t.not_counted += 1;
}

/** "Ultra judged 4: 1 struck, 2 held, 1 not counted", the ladder's first id cut to its last segment. */
export function tallyText(t: JudgeTally): string {
  const model = (t.model.split("/").at(-1) ?? t.model).replace(/:free$/, "");
  return `${model} judged ${t.judged}: ${t.struck} struck, ${t.held} held, ${t.not_counted} not counted`;
}

/** The pass summary's judge clause: "judge: <tally>", or "judge not counted: no model configured (<why>), <n> finding(s)". */
export function judgeClause(t: JudgeTally): string {
  return t.missing ? `judge not counted: ${NO_MODEL} (${t.missing}), ${t.not_counted} finding(s)` : `judge: ${tallyText(t)}`;
}

/** Counted only when the verdict is stands or refuted and the gate verified the receipt's signature. */
export function outcomeOf(v: Pick<JudgeVerdict, "status" | "signatureOk">): JudgeOutcome {
  if (v.signatureOk !== true) return "not_counted";
  return v.status === "refuted" ? "struck" : v.status === "stands" ? "held" : "not_counted";
}

const decidedText = (d: Pick<DispositionNote, "verb" | "decided_by" | "rule_id">): string => `${d.verb} by ${d.decided_by}${d.rule_id ? ` under ${d.rule_id}` : ""}`;

/** What the verdict does to the decision (see the header): C3's mapping, with a strike never turning ESCALATE into ADOPT. */
export function applyVerdict(d: DispositionNote, outcome: JudgeOutcome, reason: string): { disposition: DispositionNote; effect: string } {
  if (outcome === "not_counted") return { disposition: d, effect: `${decidedText(d)} stands, as decided before the judge` };
  if (d.decided_by !== "default") return { disposition: d, effect: `${decidedText(d)} stands: the ${d.decided_by === "policy" ? "rule" : "exception"} decides, the verdict is evidence` };
  if (outcome === "held") return { disposition: { ...d, reason: `${d.reason}; the claim stands: ${reason}` }, effect: `${decidedText(d)} stands: the claim stands` };
  if (d.verb === "ESCALATE") {
    return {
      disposition: { ...d, reason: `${d.reason}; the judge struck the claim (${reason}), and a strike never turns ESCALATE into ADOPT` },
      effect: "ESCALATE by default stands: a strike never turns ESCALATE into ADOPT, a technician decides",
    };
  }
  return { disposition: { ...d, verb: "ADOPT", reason: `the judge struck the claim: ${reason}` }, effect: "ADOPT by default: the judge struck the claim" };
}

const scrub = (s: string | null | undefined): string | null => (s ? modelInputRedactor().text(redact(s)) : null);

/**
 * Judge one finding as C3 does and apply the verdict to its decision. Every line goes to `tracer`: the evidence read, the
 * model call, the gate, the refuting SELECT, then the judge line. Never throws on a model, receipt or evidence failure: the
 * finding keeps its decision and the judgement is not counted.
 */
export async function judgeFinding(
  layer: DataLayer, finding: FindingSummary, decision: DispositionNote, judge: PassJudge, tracer?: Tracer,
): Promise<{ disposition: DispositionNote; judgement: PassJudgement }> {
  const models = [...(judge.models ?? ultraLadder())];
  const { nightshift, receipts } = judge;
  const evidence = nightshift && receipts ? await readEvidence(layer, finding, tracer) : `${NO_MODEL}: ${judge.missing ?? "no Nightshift client"}; no call made`;
  const v: JudgeVerdict = typeof evidence === "string" || !nightshift || !receipts
    ? { status: "not_judged", reason: typeof evidence === "string" ? evidence : NO_MODEL, sql: null, rowCount: null, rationale: null, receiptId: null, servedModel: null, latencyMs: 0 }
    : await judgeClaim({
      claim: finding.summary, evidenceRows: evidence, layer, nightshift, receipts, tracer,
      requestedModels: models, requestedTier: "ultra", model: models[0], tenantId: finding.tenant_id,
    });
  const outcome = outcomeOf(v);
  const reason = scrub(v.reason) ?? "";
  const { disposition, effect } = applyVerdict(decision, outcome, reason);
  const judgement: PassJudgement = {
    status: v.status, outcome, reason, sql: scrub(v.sql), rows: v.rowCount, receipt_id: v.receiptId, verified: v.signatureOk ?? null,
    served_model: scrub(v.servedModel), route: scrub(v.route), evidence_rows: typeof evidence === "string" ? 0 : evidence.rows.length, before: decision.verb, effect,
  };
  tracer?.emit({
    agent: "judge", action: "judge", status: outcome === "not_counted" ? "not_judged" : "ok",
    model_requested: models[0], ...(judgement.served_model ? { model_routed: judgement.served_model } : {}),
    ...(judgement.receipt_id ? { receipt_id: judgement.receipt_id } : {}), ...(judgement.verified === null ? {} : { signature_ok: judgement.verified }),
    input_summary: finding.summary.slice(0, 160),
    output_summary: `${outcome === "not_counted" ? "judge not counted" : outcome}: ${reason}; ${effect}`,
    detail: judgeDetail(judgement),
  });
  return { disposition, judgement };
}

/** The finding's evidence rows as C3 reads them, or why they could not be read (then no call is made). */
async function readEvidence(layer: DataLayer, finding: FindingSummary, tracer?: Tracer): Promise<Evidence | string> {
  try {
    const r = await layer.run(EVIDENCE_SQL, evidenceParams(finding), { agent: "judge", tracer, limit: EVIDENCE_LIMIT });
    return { columns: r.columns, rows: r.rows };
  } catch (err) {
    return `evidence not read: ${(((err as Error)?.message ?? String(err)).split("\n")[0] || "the read failed").slice(0, 200)}; no call made`;
  }
}

/** "signature verified", "signature does not verify" or "no signed receipt read". */
export const signatureText = (verified: boolean | null): string => (verified === true ? "signature verified" : verified === false ? "signature does not verify" : "no signed receipt read");

/**
 * The judge line's detail and the ticket's: the verdict, the model, the SELECT and its rows, the receipt and its signature.
 * The model id comes before the word "signature": the redactor reads a long run after a credential word as a key (src/redactor.ts).
 */
export function judgeDetail(j: PassJudgement): string {
  return [
    `verdict ${j.status}${j.outcome === "not_counted" ? ", not counted" : ""}`,
    `served ${j.served_model ?? "none"}`,
    j.sql ? `refuting SQL: ${j.sql}` : "no refuting SQL",
    j.rows === null ? "not run" : `${j.rows} row(s)`,
    `receipt ${j.receipt_id ?? "none"}, ${signatureText(j.verified)}`,
    `${j.evidence_rows} evidence row(s)`,
    `${j.before} before the judge`,
  ].join("; ");
}
