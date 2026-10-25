// The eval's model calls, all through Nightshift (src/adapters/nightshift.ts) under the tenant's app id
// (gate.ts tenantAppId) with a fresh request nonce first in every user message, each answer counted only on a
// signed receipt that verifies, names the tier requested and passes custody (gate.ts gateWithCustody):
//   selectChecks  the selection prompt (src/catalogue/select.ts selectionPrompt) to the selecting tier, its
//                 reply through validateSelection, so valid and invalid choices are counted;
//   judge         src/agents/judge.ts judgeClaim at the judging tier, with that tier's model ladder and the
//                 receipt gate expecting that tier (JudgeInput.requestedTier: lightning for C2, ultra for C3);
//   directVerdict the C4 baseline: the item's facts and up to 20 evidence rows to one tier, answered with one
//                 of ADOPT, HOLD, ESCALATE and a sentence.
// Recorder wraps the Nightshift client and the receipt finder of one configuration run, so every chat attempt
// becomes one CallRecord: the model requested, the model the verified receipt says served, its tier, the
// receipt's cache.status, latency and tokens, and how the gate settled it (ok, refused, or discarded for
// custody and asked again). A call whose verified receipt names a known tier other than the one requested is a
// substitution, which invalidates the run.
//
// Memory isolation. Nightshift 1.2.7 puts up to three stored answers to similar earlier requests in front of a request
// that shares their meterless-scope (src/adapters/nightshift.ts); in the development run of 25 Oct 2026, 281 of 380
// receipts carried it (hmem.injected above 0). The Recorder pins a scope of its own on every call, from the runner's
// generator ("<set>-<run id>-<seq>", src/eval/run.ts), else a fresh "<app id>-<16 hex>", and each CallRecord keeps the
// scope it went out under and memory_injected, the receipt's hmem.injected (0 for hmem null; null when no receipt was
// found). The gate files an answer with injected memory not judged, and any call with injected memory invalidates the
// run, as a substitution does.
//
// Measured 24 Oct 2026 at 23:49 UTC, EVAL_LIVE=true over the development items E03, E07 and E13 (C1 and C3, one
// run): 9 calls, each receipt signed and verified, cache miss, custody holding on the first attempt (request_id
// match, prompt_preview match, app match under drift-agent-client-1); 6 selections served
// openrouter/nvidia/nemotron-3.5-lightning (lightning), 1,663 to 1,987 input and 3,430 to 5,588 output tokens, 21.9
// to 43.3 s, 11 checks selected and 11 valid per configuration; 3 judge calls served
// openrouter/nvidia/nemotron-3-ultra-550b-a55b:free (ultra), 3,249 to 3,629 input and 919 to 4,087 output tokens,
// 6.9 to 68.3 s, 0 strikes, under a judge max_tokens of 4,096; src/agents/judge.ts JUDGE_MAX_TOKENS is 8,192.
// The receipt's prompt_preview holds the first 180 characters of the user message, from the request line on.
// Measured 25 Oct 2026 offline (test/eval.test.ts, a stub model with receipts signed in the test, six items): C2 with
// Lightning as the falsifier judge, every judge call requested and served lightning at max_tokens 8,192 and counted by
// the gate, the stub's refuting SELECT striking all 10 claims it judged.
//
// Redaction. Every string a model is handed and every string a CallRecord keeps passes the eval's redactor first
// (evalRedactor: REDACT_SALT with every deny-list label, REDACT_WORDS and EXPORT_DENY_WORDS): the finding of a
// selection prompt, the claim and evidence cells of a judge call (src/agents/judge.ts), the class, facts and evidence
// cells of a C4 call, and each record's reason and model ids. Measured 25 Oct 2026: the eval run of 03:09 UTC withheld
// C2-run1.json (x10) and planted.json (x4) on one deny-list label, 2 matches for each call that ended on the local lane
// (5 in the run's calls, 2 of them planted claims'), in calls[].reason, "every route of the ladder failed: <the
// runtime's 503 text>", kept raw; that text names two local paths under the operator's login. One call to the local
// lane after the run, the same day, gave the same text: 2 matches raw, 0 through evalRedactor.

import { Nightshift, freshScope, verifyReceipt, type ChatMessage, type ChatResult, type SignedReceipt } from "../adapters/nightshift.ts";
import { judgeClaim, MAX_EVIDENCE_ROWS, modelInputRedactor, redactEvidence, type Evidence, type JudgeInput, type JudgeModel, type JudgeVerdict } from "../agents/judge.ts";
import { selectionPrompt, validateSelection, type FindingSummary, type ValidatedSelection } from "../catalogue/select.ts";
import { config, redact } from "../config.ts";
import type { DataLayer } from "../data/layer.ts";
import { gateWithCustody, memoryInjectedOf, servedModelOf, tenantAppId, tierOf, type GateResult, type ReceiptFinder, type Tier } from "../gate.ts";
import type { Redactor } from "../redactor.ts";
import type { Tracer } from "../trace.ts";
import type { ModelTier } from "./protocol.ts";

/** The eval's redactor, the one a judge's input passes by default (src/agents/judge.ts modelInputRedactor): REDACT_SALT with every deny-list label, so a label the probe counts becomes its pseudonym. */
export const evalRedactor = (): Redactor => modelInputRedactor();

/** Text through the secret scrub, then the redactor: what a model is handed and what a result keeps. */
export const scrubber = (r: Redactor) => (s: string | null | undefined): string => (s ? r.text(redact(s)) : "");

/** The model ladder a tier is requested through: the configured primary, then its fallbacks, every one of that tier. */
export function ladder(tier: ModelTier): string[] {
  return tier === "lightning"
    ? [config.nightshift.modelFast, ...config.nightshift.fallbackFast]
    : [config.nightshift.modelJudge, ...config.nightshift.fallbackJudge];
}

export type CallKind = "select" | "judge" | "direct";

export interface CallRecord {
  kind: CallKind;
  item: string;
  /** The finding the call was about; null for a planted claim or a C4 item-level call. */
  finding: string | null;
  attempt: number;
  requested_tier: ModelTier;
  /** The model of the ladder's hop that answered (the route); every route joined with " > " when none did. */
  model_requested: string;
  /** The answering route's place in the ladder (0 the primary) and its attempts on that route (2 after one retry); null when no route answered. */
  hop: number | null;
  route_attempts: number | null;
  served_model: string | null;
  served_tier: Tier;
  receipt_id: string | null;
  signature_ok: boolean | null;
  cache_status: string | null;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  /** ok: the answer counted; refused: the gate filed it not judged; discarded: a custody failure, asked again. */
  gate: "ok" | "refused" | "discarded";
  reason: string;
  /** The meterless-scope the call went out under, on every hop and attempt of its ladder. */
  scope: string;
  /** The records Nightshift's memory put in front of the call, from the receipt's hmem (0 for hmem null or absent); null when no receipt was found. */
  memory_injected: number | null;
}

/** A served tier other than the one requested, on a receipt whose signature verifies. */
export const isSubstitution = (c: Pick<CallRecord, "signature_ok" | "served_tier" | "requested_tier">): boolean =>
  c.signature_ok === true && c.served_tier !== "unknown" && c.served_tier !== c.requested_tier;

/** A call whose receipt says Nightshift injected stored answers in front of it. */
export const isMemoryInjected = (c: Pick<CallRecord, "memory_injected">): boolean => (c.memory_injected ?? 0) > 0;

/** The meterless-scope of one call: the caller's app id is the default's base. */
export type ScopeSource = (appId: string | undefined) => string;

/** A chat attempt that answered, or one whose every hop of the ladder failed; each with the scope it went out under. */
type Attempt = ((ChatResult & { hop?: number }) | { failed: string; modelRequested: string; latencyMs: number }) & { sentScope: string };

/**
 * Records every chat attempt and every receipt the gate looked up, for one configuration run; every string a record keeps
 * passes the redactor. Every call goes out under a meterless-scope the Recorder pins: the caller's, else `scope` (the
 * runner's "<set>-<run id>-<seq>"), else a fresh "<app id>-<16 hex>" (freshScope).
 */
export class Recorder {
  private readonly chats: Attempt[] = [];
  private readonly found = new Map<string, SignedReceipt>();
  private readonly clean: (s: string | null | undefined) => string;
  readonly calls: CallRecord[] = [];
  readonly nightshift: JudgeModel;
  readonly receipts: ReceiptFinder;

  constructor(inner: JudgeModel, finder: ReceiptFinder, redactor: Redactor = evalRedactor(), scope: ScopeSource = (appId) => freshScope(appId)) {
    this.clean = scrubber(redactor);
    this.nightshift = {
      chatWithFallback: async (opts) => {
        const t0 = Date.now();
        const sentScope = opts.scope ?? scope(opts.appId);
        try {
          const r = await inner.chatWithFallback({ ...opts, scope: sentScope });
          this.chats.push({ ...r, sentScope });
          return r;
        } catch (err) {
          this.chats.push({ failed: (err as Error).message, modelRequested: opts.models.join(" > "), latencyMs: Date.now() - t0, sentScope });
          throw err;
        }
      },
    };
    this.receipts = {
      find: async (id) => {
        const r = await finder.find(id);
        if (r) this.found.set(id, r);
        return r;
      },
    };
  }

  /** Where the next call's attempts start. */
  mark(): number {
    return this.chats.length;
  }

  /** One CallRecord per chat attempt since `mark`: the last attempt settled as the gate settled it, any earlier one discarded for custody. */
  settle(mark: number, meta: { kind: CallKind; item: string; finding: string | null; tier: ModelTier }, final: { ok: boolean; reason: string }): CallRecord[] {
    const attempts = this.chats.slice(mark);
    const out = attempts.map((chat, i): CallRecord => {
      const last = i === attempts.length - 1;
      if ("failed" in chat) {
        return {
          kind: meta.kind, item: meta.item, finding: meta.finding, attempt: i + 1, requested_tier: meta.tier, model_requested: this.clean(chat.modelRequested), hop: null, route_attempts: null,
          served_model: null, served_tier: "unknown", receipt_id: null, signature_ok: null, cache_status: null, latency_ms: chat.latencyMs, tokens_in: 0, tokens_out: 0,
          gate: "refused", reason: this.clean(`every route of the ladder failed: ${chat.failed}`), scope: this.clean(chat.sentScope), memory_injected: null,
        };
      }
      const receipt = chat.receiptId ? this.found.get(chat.receiptId) ?? null : null;
      const served = (receipt ? servedModelOf(receipt) : null) ?? chat.modelRouted ?? null;
      const cache = receipt?.body.receipt?.cache?.status;
      return {
        kind: meta.kind, item: meta.item, finding: meta.finding, attempt: i + 1, requested_tier: meta.tier,
        model_requested: this.clean(chat.modelRequested), hop: chat.hop ?? null, route_attempts: chat.retries + 1, served_model: served === null ? null : this.clean(served), served_tier: tierOf(served),
        receipt_id: chat.receiptId, signature_ok: receipt ? verifyReceipt(receipt) : null, cache_status: typeof cache === "string" ? cache : null,
        latency_ms: chat.latencyMs, tokens_in: chat.tokensIn, tokens_out: chat.tokensOut,
        gate: last ? (final.ok ? "ok" : "refused") : "discarded", reason: this.clean(last ? final.reason : "custody failed; answer discarded and the call made once more"),
        scope: this.clean(chat.scope ?? chat.sentScope), memory_injected: receipt ? memoryInjectedOf(receipt) : null,
      };
    });
    this.calls.push(...out);
    return out;
  }
}

/** The user message opened by the request line, the shape the custody check reads. */
const withNonce = (messages: ChatMessage[], nonce: string): ChatMessage[] =>
  messages.map((m, i) => (i === messages.length - 1 ? { ...m, content: `[request ${nonce}]\n${m.content}` } : m));

export interface ModelCallContext {
  recorder: Recorder;
  tenantId: string;
  item: string;
  tracer?: Tracer;
  /** What every string handed to the model passes first. */
  redactor: Redactor;
}

export type GatedOutcome<T> = { ok: true; value: T; calls: CallRecord[] } | { ok: false; reason: string; calls: CallRecord[] };

/** One gated call: the tier's ladder under the tenant's app id, a nonce per attempt, the gate's custody rule. */
async function gatedCall(
  ctx: ModelCallContext, kind: CallKind, finding: string | null, tier: ModelTier, messages: ChatMessage[], maxTokens: number, enableThinking: boolean | undefined,
): Promise<{ chat: ChatResult | null; gate: GateResult | null; reason: string; calls: CallRecord[] }> {
  const mark = ctx.recorder.mark();
  let appId: string;
  try {
    appId = tenantAppId(ctx.tenantId);
  } catch (err) {
    return { chat: null, gate: null, reason: `${(err as Error).message}; no call made`, calls: [] };
  }
  try {
    const out = await gateWithCustody(async ({ nonce }) => {
      const sent = withNonce(messages, nonce);
      const chat = await ctx.recorder.nightshift.chatWithFallback({ models: ladder(tier), messages: sent, maxTokens, temperature: 0, ...(enableThinking === undefined ? {} : { enableThinking }), appId, agent: kind === "select" ? "selector" : "judge", tracer: ctx.tracer });
      return { chat, prompt: sent.map((m) => m.content) };
    }, tier, ctx.recorder.receipts, appId, ctx.tracer, kind === "select" ? "selector" : "judge");
    const reason = out.gate.ok ? out.gate.reason : `receipt gate: ${out.gate.reason}`;
    const calls = ctx.recorder.settle(mark, { kind, item: ctx.item, finding, tier }, { ok: out.gate.ok, reason });
    return { chat: out.chat, gate: out.gate, reason, calls };
  } catch (err) {
    const reason = `model unavailable or receipts unreadable: ${(err as Error).message}`;
    const calls = ctx.recorder.settle(mark, { kind, item: ctx.item, finding, tier }, { ok: false, reason });
    return { chat: null, gate: null, reason, calls };
  }
}

/**
 * max_tokens of a selection call. Measured 24 Oct 2026 on one orphan_vhost finding's selection prompt (6,049 characters):
 * openrouter Lightning answered 502 empty_response at 2,048 (twice, 8.5 s each) and, at 8,192, a valid selection of 3
 * checks with 5,750 output tokens in 23.7 s; the reasoning is billed and absent from the content. The cap leaves headroom.
 */
export const SELECT_MAX_TOKENS = 16_384;
/** max_tokens of a C4 call: Ultra reasons in its content before the JSON, as it does for the judge. */
export const DIRECT_MAX_TOKENS = 8_192;

/** The selecting tier chooses and parameterises checks for one finding; the reply goes through validateSelection. */
export async function selectChecks(ctx: ModelCallContext, finding: FindingSummary, findingId: string, tier: ModelTier): Promise<GatedOutcome<ValidatedSelection>> {
  const r = await gatedCall(ctx, "select", findingId, tier, selectionPrompt(ctx.redactor.json(finding)), SELECT_MAX_TOKENS, undefined);
  if (!r.gate?.ok || !r.chat) return { ok: false, reason: r.reason, calls: r.calls };
  return { ok: true, value: validateSelection(r.chat.content), calls: r.calls };
}

/** judgeClaim at `tier`: that tier's ladder, the tenant's app id, the receipt gate expecting that tier. */
export async function judge(
  ctx: ModelCallContext, layer: DataLayer, claim: string, evidence: Evidence, findingId: string | null, tier: ModelTier,
): Promise<{ verdict: JudgeVerdict; calls: CallRecord[] }> {
  const mark = ctx.recorder.mark();
  // requestedTier: the tier the receipt gate inside judgeClaim expects, so C2's Lightning judge counts on a Lightning receipt.
  const models = ladder(tier);
  const input: JudgeInput = {
    claim, evidenceRows: evidence, layer, nightshift: ctx.recorder.nightshift, receipts: ctx.recorder.receipts, tracer: ctx.tracer,
    requestedModels: models, requestedTier: tier, model: models[0], tenantId: ctx.tenantId, redactor: ctx.redactor,
  };
  const verdict = await judgeClaim(input);
  const counted = verdict.status === "stands" || verdict.status === "refuted" || verdict.status === "invalid_output";
  const calls = ctx.recorder.settle(mark, { kind: "judge", item: ctx.item, finding: findingId, tier }, { ok: counted && verdict.signatureOk === true, reason: verdict.reason });
  return { verdict, calls };
}

export const DIRECT_VERBS = ["ADOPT", "HOLD", "ESCALATE"] as const;
export type DirectVerb = (typeof DIRECT_VERBS)[number];

export const DIRECT_SYSTEM_PROMPT = `You decide one finding of a config-drift agent at an MSP from the facts a detector stated and the rows recorded about it. You run no query and use no catalogue of checks.

Choose exactly one verb:
- ADOPT: the live value stands.
- HOLD: the finding is held until an expiry, then decided again.
- ESCALATE: a technician takes it.

Answer ONLY with this JSON object and nothing else:
{"verb": "ADOPT" | "HOLD" | "ESCALATE", "reason": "<one sentence>"}`;

/** The C4 prompt: the class, the item's facts and at most MAX_EVIDENCE_ROWS rows, one JSON object per row. */
export function directMessages(cls: string, facts: string, evidence: Evidence): ChatMessage[] {
  const shown = evidence.rows.slice(0, MAX_EVIDENCE_ROWS);
  const lines = shown.map((row) => JSON.stringify(Object.fromEntries(evidence.columns.map((c, i) => [c, row[i] ?? ""]))));
  const user = `Class: ${cls}\nFacts: ${facts}\n\nRows (${shown.length} of ${evidence.rows.length}; columns: ${evidence.columns.join(", ")}):\n${lines.join("\n") || "(none)"}`;
  return [{ role: "system", content: DIRECT_SYSTEM_PROMPT }, { role: "user", content: user }];
}

/** A direct reply's verb and sentence; null when the reply holds no object with one of the three verbs. */
export function parseDirect(content: string): { verb: DirectVerb; reason: string } | null {
  const o = Nightshift.extractJson<Record<string, unknown>>(content);
  if (!o || typeof o !== "object") return null;
  const verb = typeof o.verb === "string" ? o.verb.trim().toUpperCase() : "";
  if (!(DIRECT_VERBS as readonly string[]).includes(verb)) return null;
  return { verb: verb as DirectVerb, reason: typeof o.reason === "string" ? o.reason.trim().slice(0, 300) : "" };
}

/** The C4 baseline: one prompt, one verb, gated as every other call. */
export async function directVerdict(ctx: ModelCallContext, cls: string, facts: string, evidence: Evidence, tier: ModelTier): Promise<GatedOutcome<{ verb: DirectVerb; reason: string }>> {
  const clean = scrubber(ctx.redactor);
  const r = await gatedCall(ctx, "direct", null, tier, directMessages(clean(cls), clean(facts), redactEvidence(evidence, ctx.redactor)), DIRECT_MAX_TOKENS, true);
  if (!r.gate?.ok || !r.chat) return { ok: false, reason: r.reason, calls: r.calls };
  const parsed = parseDirect(r.chat.content);
  if (!parsed) return { ok: false, reason: "invalid output: the reply holds no {verb, reason} object with ADOPT, HOLD or ESCALATE", calls: r.calls };
  return { ok: true, value: parsed, calls: r.calls };
}
