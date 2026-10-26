// The falsifier in the live pass: the judge step of the eval's C3 (eval/PROTOCOL.md, "C1 plus Nemotron 3 Ultra as the
// falsifier judge"; src/eval/run.ts), run on every finding of a live pass that the withdraw rule does not withhold.
//
// Contract.
//   liveJudge   the pass's judge in live mode: the Nightshift client, its receipt list and Ultra's ladder
//               (METERLESS_MODEL_JUDGE, then METERLESS_FALLBACK_JUDGE, the ladder C3 requests). null in sample mode: the
//               pass runs no model and traces each judge "model: none (sample)". Live with DRIFT_JUDGE off, a judge with
//               no client: no call, and each finding is "judge not counted: judge off"; the same with no runtime token,
//               base URL or judge model, "judge not counted: no model configured: <why>". The switch is independent of --apply.
//   evidence    when the judge's user message would pass 4,000 characters (PROMPT_LIMIT), every evidence cell over 240
//               (MAX_CELL) is cut to 240 before the call, and the judge line and the ticket say so ("cell cut to 240 of <n>
//               characters"): Nightshift passes on only the last 4,000 characters of a user message, so a long cell (a USL
//               definition) pushed the claim line out of what Ultra saw and custody refused the answer. Under the limit the
//               evidence goes as C3 hands it.
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
import { buildMessages, judgeClaim, modelInputRedactor, redactEvidence, type Evidence, type JudgeModel, type JudgeStatus, type JudgeVerdict } from "./judge.ts";

/** The rows a finding's evidence read returns at most; C3 reads them under the same limit (src/eval/run.ts evidenceOf). */
export const EVIDENCE_LIMIT = 200;

/** What the pass needs to judge: the Nightshift client, the receipt list and the ladder. */
export interface PassJudge {
  /** null when no model is configured: then no call is made and every judgement is not counted, "no model configured: <why>". */
  nightshift: JudgeModel | null;
  receipts: ReceiptFinder | null;
  /** The ladder, first id first; default ultraLadder(), the one C3 requests. */
  models?: readonly string[];
  /** Why no call can be made, when nightshift is null: "judge off: ..." or "no model configured: ...". */
  unavailable?: string;
  /**
   * Only this tenant's findings are judged. runPass reads every run of the datasource, so a live pass for one tenant also
   * decides the others' findings; src/loop/pass.ts sets its tenant here, whose findings alone it reports. Absent: every finding.
   */
  tenant?: string;
  /** The most model calls the pass makes, in finding order; JUDGE_MAX_CALLS (default 64) when absent. */
  maxCalls?: number;
}

/**
 * The pass summary's judge clause for a pass given no judge, one text per cause: sample mode, which runs no model, or a live
 * caller that wired none. A judge that is off or has no model is a judge, and its tally says so (judgeClause).
 */
export const noJudgeClause = (sampleMode: boolean = config.sampleMode): string => (sampleMode ? "model: none (sample mode)" : "model: none (no judge wired)");

/** The skipped judge line's detail for a finding past the pass's call cap: the decision stands, not judged. */
export const capReached = (max: number): string => `judge cap reached: ${max} model call(s) this pass (JUDGE_MAX_CALLS); not judged, the decision stands`;

/**
 * The trace's default model for a live command: none unless the judge has a Nightshift to call or the command writes (--apply),
 * which calls models of its own. scripts/pass.ts and src/loop/live.ts both build their tracer with it.
 */
export const traceModel = (judge: PassJudge | null | undefined, apply = false): { model?: string } => (apply || judge?.nightshift ? {} : { model: "none" });

/** The skipped judge line's detail for a finding of another tenant than the one the judge is for. */
export const otherTenant = (finding: string, judged: string): string => `not judged in this pass: the finding is tenant ${finding}'s, the pass judges tenant ${judged}'s`;

/** The reason a judgement does not count when the live pass has no Nightshift to call. */
export const NO_MODEL = "no model configured";
/** The reason a judgement does not count when DRIFT_JUDGE is off. */
export const JUDGE_OFF = "judge off";

/** Ultra's ladder as C3 requests it (src/eval/models.ts ladder("ultra")): the judge model, then its fallbacks, blank ids left out. */
export const ultraLadder = (ids: readonly string[] = [config.nightshift.modelJudge, ...config.nightshift.fallbackJudge]): string[] => ids.map((m) => m.trim()).filter(Boolean);

export interface LiveJudgeSettings { sampleMode: boolean; judge: "on" | "off"; token: string; baseUrl: string; models: readonly string[] }

const settings = (): LiveJudgeSettings => ({ sampleMode: config.sampleMode, judge: config.judge, token: config.nightshift.token, baseUrl: config.nightshift.baseUrl, models: ultraLadder() });

/**
 * The live pass's judge. null in sample mode: the pass runs no model and traces each judge "model: none (sample)". Live, a
 * judge with no client when DRIFT_JUDGE is off, or with no runtime token, base URL or judge model: no call is made, every
 * finding the withdraw rule leaves open is traced "judge not counted: judge off" or "judge not counted: no model
 * configured: <why>" and keeps its decision, and nothing throws.
 */
export function liveJudge(o: LiveJudgeSettings = settings()): PassJudge | null {
  if (o.sampleMode) return null;
  const models = ultraLadder(o.models);
  const why = o.judge === "off" ? `${JUDGE_OFF}: DRIFT_JUDGE is off`
    : !o.baseUrl.trim() ? `${NO_MODEL}: METERLESS_BASE_URL is blank`
    : !o.token ? `${NO_MODEL}: no Nightshift runtime token (METERLESS_RUNTIME_TOKEN is blank and the runtime wrote no proxy-token file)`
    : !models.length ? `${NO_MODEL}: METERLESS_MODEL_JUDGE and METERLESS_FALLBACK_JUDGE are blank`
    : null;
  if (why) return { nightshift: null, receipts: null, models, unavailable: why };
  const nightshift = new Nightshift({ token: o.token });
  return { nightshift, receipts: new ReceiptStore(nightshift), models };
}

/**
 * The user message Nightshift passes on whole. Measured 26 Oct 2026 in the live pass: a judge user message over 4,000
 * characters has egress.sent.prompt_chars 4000 on its receipt and a prompt_preview that starts mid-message, so Nightshift kept
 * its last 4,000 characters, Ultra never saw the claim line and custody refused the answer. A USL definition as an evidence
 * cell makes one. Over the recording the eval runs over the longest judge user message is 1,775 characters
 * (test/falsifier.test.ts), so no cell there is cut and C3's inputs are what they were.
 */
export const PROMPT_LIMIT = 4000;
/** The length a cell is cut to when the user message would pass PROMPT_LIMIT. */
export const MAX_CELL = 240;

/** The judge's user message for `claim` and `e` as judgeClaim builds it (redacted, a 16-hex nonce line first), in characters. */
export function userChars(claim: string, e: Evidence): number {
  const r = modelInputRedactor();
  return buildMessages(r.text(claim), redactEvidence(e, r), "0".repeat(16))[1].content.length;
}

/** The evidence as C3 hands it, unless the user message would pass PROMPT_LIMIT: then every cell over MAX_CELL is cut (cutEvidence). */
export function fitEvidence(claim: string, e: Evidence): { evidence: Evidence; cut: number[] } {
  return userChars(claim, e) <= PROMPT_LIMIT ? { evidence: e, cut: [] } : cutEvidence(e);
}

/** Every cell over MAX_CELL cut to MAX_CELL characters, the last an ellipsis; the lengths of the cells cut, in row order. */
export function cutEvidence(e: Evidence): { evidence: Evidence; cut: number[] } {
  const cut: number[] = [];
  const rows = e.rows.map((row) => row.map((v) => {
    if (typeof v !== "string" || v.length <= MAX_CELL) return v;
    cut.push(v.length);
    return `${v.slice(0, MAX_CELL - 1)}…`;
  }));
  return { evidence: { columns: e.columns, rows }, cut };
}

/** "cell cut to 240 of 5120 characters", "2 cells cut to 240 of 5120 and 900 characters"; "" when none was cut. */
export function cutText(cut: readonly number[]): string {
  if (!cut.length) return "";
  const of = cut.length === 1 ? String(cut[0]) : `${cut.slice(0, -1).join(", ")} and ${cut.at(-1)}`;
  return `${cut.length === 1 ? "cell" : `${cut.length} cells`} cut to ${MAX_CELL} of ${of} characters`;
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
  /** The lengths of the evidence cells cut to MAX_CELL characters before the call, in row order; empty when none was. */
  cut: number[];
  /** The verb before the verdict, and what the verdict did to the decision. */
  before: Verb;
  effect: string;
}

/** A pass's judge calls: the ladder's first id, the findings judged and how their verdicts came out; `unavailable` when no call could be made. */
export interface JudgeTally { model: string; judged: number; struck: number; held: number; not_counted: number; unavailable?: string }

export const zeroTally = (judge: PassJudge): JudgeTally => ({
  model: (judge.models ?? ultraLadder())[0] ?? "none", judged: 0, struck: 0, held: 0, not_counted: 0,
  ...(judge.nightshift && judge.receipts ? {} : { unavailable: judge.unavailable ?? `${NO_MODEL}: no Nightshift client` }),
});

export function addToTally(t: JudgeTally, j: Pick<PassJudgement, "outcome">): void {
  t.judged += 1;
  if (j.outcome === "struck") t.struck += 1;
  else if (j.outcome === "held") t.held += 1;
  else t.not_counted += 1;
}

/** A model id's last path segment, ":free" dropped: what the trace's text and the ticket name. */
export const modelName = (m: string): string => (m.split("/").at(-1) ?? m).replace(/:free$/, "");

/** "nemotron-3-ultra-550b-a55b judged 4: 1 struck, 2 held, 1 not counted". */
export function tallyText(t: JudgeTally): string {
  return `${modelName(t.model)} judged ${t.judged}: ${t.struck} struck, ${t.held} held, ${t.not_counted} not counted`;
}

/** The label of an unavailable judge: "judge off" or "no model configured". */
export const unavailableLabel = (why: string): string => why.split(":")[0];

/** The pass summary's judge clause: "judge: <tally>", or "judge not counted: <why>, <n> finding(s)" when no call could be made. */
export function judgeClause(t: JudgeTally): string {
  return t.unavailable ? `judge not counted: ${t.unavailable}, ${t.not_counted} finding(s)` : `judge: ${tallyText(t)}`;
}

/** Counted only when the verdict is stands or refuted and the gate verified the receipt's signature. */
export function outcomeOf(v: Pick<JudgeVerdict, "status" | "signatureOk">): JudgeOutcome {
  if (v.signatureOk !== true) return "not_counted";
  return v.status === "refuted" ? "struck" : v.status === "stands" ? "held" : "not_counted";
}

const decidedText = (d: Pick<DispositionNote, "verb" | "decided_by" | "rule_id">): string => `${d.verb} by ${d.decided_by}${d.rule_id ? ` under ${d.rule_id}` : ""}`;

/** C3's mapping (see the header), before the invariant. */
function mapVerdict(d: DispositionNote, outcome: JudgeOutcome, reason: string): { disposition: DispositionNote; effect: string } {
  if (outcome === "not_counted") return { disposition: d, effect: `${decidedText(d)} stands, as decided before the judge` };
  if (d.decided_by !== "default") return { disposition: d, effect: `${decidedText(d)} stands: the ${d.decided_by === "policy" ? "rule" : "exception"} decides, the verdict is evidence` };
  if (outcome === "held") return { disposition: { ...d, reason: `${d.reason}; the claim stands: ${reason}` }, effect: `${decidedText(d)} stands: the claim stands` };
  // a default decides ADOPT or ESCALATE; any verb but ADOPT stands on a strike, so no model loosens a decision
  if (d.verb !== "ADOPT") {
    return {
      disposition: { ...d, reason: `${d.reason}; the judge struck the claim (${reason}), and a strike never turns ${d.verb} into ADOPT` },
      effect: `${d.verb} by default stands: a strike never turns ${d.verb} into ADOPT, a technician decides`,
    };
  }
  return { disposition: { ...d, verb: "ADOPT", reason: `the judge struck the claim: ${reason}` }, effect: "ADOPT by default: the judge struck the claim" };
}

/**
 * What the verdict does to the decision: C3's mapping, then the invariant, whoever decided: a verdict never turns a HOLD or
 * an ESCALATE into ADOPT, and never changes the expiry, the rule, the decider or the change window. A mapping that would is a
 * bug, and it throws rather than loosen a decision.
 */
export function applyVerdict(d: DispositionNote, outcome: JudgeOutcome, reason: string): { disposition: DispositionNote; effect: string } {
  const out = mapVerdict(d, outcome, reason);
  const n = out.disposition;
  const loosened = (d.verb === "HOLD" || d.verb === "ESCALATE") && n.verb === "ADOPT";
  if (loosened || n.expires_at !== d.expires_at || n.rule_id !== d.rule_id || n.decided_by !== d.decided_by || n.window_id !== d.window_id) {
    throw new Error(`judge invariant: a ${outcome} verdict would change ${decidedText(d)} to ${decidedText(n)}; a verdict never loosens a decision`);
  }
  return out;
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
  const read = nightshift && receipts ? await readEvidence(layer, finding, tracer) : `${judge.unavailable ?? `${NO_MODEL}: no Nightshift client`}; no call made`;
  const { evidence, cut } = typeof read === "string" ? { evidence: null, cut: [] } : fitEvidence(finding.summary, read);
  const v: JudgeVerdict = typeof read === "string" || !evidence || !nightshift || !receipts
    ? { status: "not_judged", reason: typeof read === "string" ? read : NO_MODEL, sql: null, rowCount: null, rationale: null, receiptId: null, servedModel: null, latencyMs: 0 }
    : await judgeClaim({
      claim: finding.summary, evidenceRows: evidence, layer, nightshift, receipts, tracer,
      requestedModels: models, requestedTier: "ultra", model: models[0], tenantId: finding.tenant_id,
    });
  const outcome = outcomeOf(v);
  const reason = scrub(v.reason) ?? "";
  const { disposition, effect } = applyVerdict(decision, outcome, reason);
  const judgement: PassJudgement = {
    status: v.status, outcome, reason, sql: scrub(v.sql), rows: v.rowCount, receipt_id: v.receiptId, verified: v.signatureOk ?? null,
    served_model: scrub(v.servedModel), route: scrub(v.route), evidence_rows: evidence?.rows.length ?? 0, cut, before: decision.verb, effect,
  };
  tracer?.emit({
    agent: "judge", action: "judge", status: outcome === "not_counted" ? "not_judged" : "ok",
    model_requested: models[0], ...(judgement.served_model ? { model_routed: judgement.served_model } : {}),
    ...(judgement.receipt_id ? { receipt_id: judgement.receipt_id } : {}), ...(judgement.verified === null ? {} : { signature_ok: judgement.verified }),
    input_summary: (scrub(finding.summary) ?? "").slice(0, 160),
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

/** "receipt rcpt_x verified", "receipt rcpt_x does not verify", "no receipt read": no credential word (src/redactor.ts KEYLIKE). */
export const receiptText = (id: string | null, verified: boolean | null): string =>
  verified === true ? `receipt ${id} verified` : verified === false ? `receipt ${id} does not verify` : `no receipt read${id ? ` for ${id}` : ""}`;

/**
 * The judge line's detail and the ticket's: the verdict, the model, the SELECT and its rows, the receipt, the evidence. Each
 * field passes the secret scrub and the model redactor on its own, no field names a credential word, and the model is named by
 * its last path segment, so the redactor's key heuristic (a long run within 64 characters after a credential word) fires on
 * no field whatever the order; the full id is the trace line's model_routed.
 */
export function judgeDetail(j: PassJudgement): string {
  const fields = [
    `verdict ${j.status}${j.outcome === "not_counted" ? ", not counted" : ""}`,
    `served ${j.served_model ? modelName(j.served_model) : "none"}`,
    j.sql ? `refuting SQL: ${j.sql}` : "no refuting SQL",
    j.rows === null ? "not run" : `${j.rows} row(s)`,
    receiptText(j.receipt_id, j.verified),
    `${j.evidence_rows} evidence row(s)${j.cut.length ? `, ${cutText(j.cut)}` : ""}`,
    `${j.before} before the judge`,
  ];
  return fields.map((f) => scrub(f) ?? "").join("; ");
}
