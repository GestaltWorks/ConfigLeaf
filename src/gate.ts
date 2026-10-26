// The receipt gate. A judge verdict counts only when the signed receipt says the model that answered
// is in the tier that was asked for; anything else is filed not_judged and escalates, never kept.
//
// Measured on the build machine, 23 Oct 2026, 53/53 runtime receipts verified:
//   - a successful receipt names the served model three times and they agree: phases[0].model (one
//     phase, "final_synthesis", tier "A" for Lightning and "C" for Ultra), routing.winner and
//     winning_route.model. The gate reads the phase whose model is routing.winner, then routing.winner,
//     then winning_route.model;
//   - receipt.requested_mode is "meterless/auto" even when the chat named an explicit id, so the
//     requested tier comes from the caller and never from the receipt;
//   - a failed turn's receipt has no receipt_id (keys: app, cost, error, mode, request_id, schema,
//     status, usage); every successful turn carries one. So a successful chat result without a
//     receipt_id, or whose receipt the runtime list does not hold after one refresh, is anomalous: it
//     is not_judged. Its served tier is still derived from result.modelRouted so the trace says what
//     the response claimed, with signatureOk null and a reason saying "unreceipted"; it never passes.
//
// Custody (plan addendum, item 3). A verified signature says the runtime signed THIS receipt; it does
// not say the receipt is the one for OUR request, nor that the runtime filed it under our app. Every
// successful receipt also carries request_id (equal to the chat response's id), prompt_preview (the
// first characters of the prompt the runtime saw) and app (the meterless-app header the call went out
// under). When the caller says what it sent, the gate checks all three after the signature. Identity
// holds only when request_id equals the response's id: the OpenAI-compatible response always carries an
// id and every successful receipt a request_id, so a side without one is anomalous and fails closed,
// like an unreceipted response (a substituting proxy controls the response body, and dropping the id
// must not open a softer path). prompt_preview is a secondary check that can refute identity but never
// establish it: compared against the user message alone (never the shared system prompt, which is the
// same on every judge call, nor the join), it must cover the `[request <nonce>]` first line to count as
// a match; a preview of a shared message, or one too short to reach the nonce, is uninformative; a
// preview that is a prefix of nothing we sent is a mismatch and fails identity whatever the id says,
// which is what catches a replay of our own earlier receipt and id. Attribution holds when app is the
// id we sent, per client "drift-agent-<tenant>" (tenantAppId; the runtime files a meterless-app value
// with ':' as receipt.app with '-' in its place, 12 of 12 receipts on 24 Oct 2026, so the base and the
// tenant are joined with '-'; under drift-agent-client-1 custody held on 9 of 9 calls of the 23:49 UTC
// eval smoke the same day). A failure discards the answer and
// gateWithCustody makes the call once more as a fresh request (a new nonce for the prompt, so a new
// request_id and no cache hit); a second failure fails closed, not_judged, with a reason that starts
// "custody". Every custody check is one trace event; the prompt text never reaches the trace, only ids.
//
// Memory (measured 25 Oct 2026). Nightshift 1.2.7 puts up to three stored answers to similar earlier requests in front
// of a request that shares their meterless-scope, across apps, and the signed receipt records it as hmem {ids, injected,
// reason, strategy, top_score}, or hmem null when nothing was injected. An answer conditioned on earlier answers is not
// the answer to the prompt we sent, so a verified receipt whose hmem.injected is above 0 fails the gate with the reason
// "memory injected (n records)" and the verdict files not_judged, as a substituted tier does: returned at once, never
// retried. hmem null or absent passes. In the development run of 25 Oct, 281 of 380 receipts carried it, the two real
// fixtures of 23 Oct (test/fixtures/receipt-*.json) included (3 records each). The adapter now sends a fresh
// meterless-scope per request (src/adapters/nightshift.ts freshScope); the gate result records the scope sent and the
// injected count the signed receipt states.
//
// Signing key (26 Oct 2026). A receipt carries its own public key, and any key signs a receipt whose signature verifies
// under it, so the gate trusts a receipt only under a pinned key: the finder's keys (ReceiptFinder.keys), else
// RECEIPT_KEY (src/adapters/nightshift.ts), the key every committed receipt is signed with. A receipt under any other key
// gives signatureOk false and a reason that names its key.

import { randomBytes } from "node:crypto";
import { Nightshift, RECEIPT_KEY, receiptKeyFingerprint, verifyReceipt, type ChatResult, type SignedReceipt } from "./adapters/nightshift.ts";
import { config } from "./config.ts";
import type { Tracer } from "./trace.ts";

export type Tier = "lightning" | "ultra" | "unknown";

/** Tier by model-id substring: every Nemotron route we request carries one of the two words. */
export function tierOf(modelId: string | null | undefined): Tier {
  const id = (modelId ?? "").toLowerCase();
  if (id.includes("lightning")) return "lightning";
  if (id.includes("ultra")) return "ultra";
  return "unknown";
}

export interface GateResult {
  ok: boolean;
  requestedTier: Tier;
  servedModel: string | null;
  servedTier: Tier;
  receiptId: string | null;
  signatureOk: boolean | null;
  reason: string;
  /** The custody check, when the caller asked for one and a verified receipt was there to check. */
  custody?: CustodyCheck;
  /** The records Nightshift's memory injected, as the receipt states (hmem.injected; 0 for hmem null or absent); null when no receipt was found. */
  memoryInjected: number | null;
  /** The meterless-scope the request went out under (ChatResult.scope); null when the result does not say. */
  scope: string | null;
}

/** A receipt's hmem: the records Nightshift injected before the request, or null when it injected none (hmem null or absent). */
export function hmemOf(r: SignedReceipt): { injected: number; ids: string[]; topScore: number | null } | null {
  const h = r.body.receipt?.hmem;
  if (h === null || h === undefined || typeof h !== "object") return null;
  const ids: string[] = Array.isArray(h.ids) ? h.ids.map(String) : [];
  const injected = typeof h.injected === "number" && Number.isFinite(h.injected) ? h.injected : ids.length;
  return injected > 0 ? { injected, ids, topScore: typeof h.top_score === "number" ? h.top_score : null } : null;
}

/** hmem.injected of a receipt: 0 when hmem is null or absent. */
export const memoryInjectedOf = (r: SignedReceipt): number => hmemOf(r)?.injected ?? 0;

export interface ReceiptFinder {
  find(receiptId: string): Promise<SignedReceipt | null>;
  /** The signing keys, as fingerprints (receiptKeyFingerprint), of the receipts it finds; [RECEIPT_KEY] when absent. */
  readonly keys?: readonly string[];
}

/** The fingerprint of a receipt's signing key; null when the receipt carries no pubkey_b64 text. */
const keyOf = (r: SignedReceipt): string | null => (typeof r.pubkey_b64 === "string" ? receiptKeyFingerprint(r.pubkey_b64) : null);

/** The model a receipt says answered: the winning phase's model, else routing.winner, else winning_route.model. */
export function servedModelOf(r: SignedReceipt): string | null {
  const rc = r.body.receipt ?? {};
  const winner: string | undefined = rc.routing?.winner;
  const phases: { model?: string }[] = Array.isArray(rc.phases) ? rc.phases : [];
  const phase = phases.find((p) => p.model && p.model === winner) ?? phases.at(-1);
  return phase?.model ?? winner ?? rc.winning_route?.model ?? null;
}

// ------------------------------------------------------------------------------------ custody

export interface CustodyExpectation {
  /** The meterless-app header value the call was sent with. */
  appId: string;
  /**
   * The message text(s) we sent, in order, the user message last; the prompt_preview check compares against
   * that last message only. Omitted, the preview field reads "absent". Never traced.
   */
  prompt?: string | readonly string[];
}

export type CustodyField = "match" | "mismatch" | "absent";
/** The preview check has one more outcome: present but unable to speak to identity either way. */
export type PreviewField = CustodyField | "uninformative";

export interface CustodyCheck {
  ok: boolean;
  /** receipt.request_id against the response's id; "absent" when either side has none, which fails identity. */
  requestId: CustodyField;
  /**
   * receipt.prompt_preview against the user message we sent: "match" when it is a prefix covering the request
   * line; "uninformative" when it previews a shared message (the system prompt) or stops short of the nonce;
   * "mismatch" when it is a prefix of nothing we sent (fails identity); "absent" when the receipt has none or
   * no prompt was given.
   */
  promptPreview: PreviewField;
  /** receipt.app against the app id we sent. */
  app: CustodyField;
  /** receipt.cache.status as the receipt says it, for the trace; not gated here. */
  cacheStatus: string | null;
  reason: string;
}

/** A preview the runtime cut short ends in an ellipsis; the prefix test runs on what precedes it. */
const PREVIEW_TAIL = /(?:\.{3}|…)\s*$/;
/** The request line buildMessages puts first in the user message; a matching preview must reach its end. */
const REQUEST_LINE = /^\[request [0-9a-f]+\]/;

/**
 * The preview against what we sent. The user message is the last one given; the others (the system prompt)
 * are shared across calls and can neither establish nor refute identity.
 */
function previewField(preview: string | null, sent: readonly string[]): { field: PreviewField; note: string } {
  if (preview === null || sent.length === 0) return { field: "absent", note: "" };
  const user = sent[sent.length - 1];
  if (user.startsWith(preview)) {
    const line = user.match(REQUEST_LINE)?.[0];
    if (line === undefined || preview.length >= line.length) return { field: "match", note: "" };
    return { field: "uninformative", note: " (stops short of the request line)" };
  }
  if (sent.slice(0, -1).some((s) => s.startsWith(preview))) return { field: "uninformative", note: " (previews a shared message, not the user message)" };
  return { field: "mismatch", note: " (a prefix of nothing we sent)" };
}

/**
 * Is this verified receipt the one for this response, filed under the app we sent? Identity: request_id
 * equal to the response's id, nothing else establishes it; a side with no id fails closed. The preview is
 * secondary: a mismatch (a prefix of nothing we sent) refutes identity whatever the id says; a match or an
 * uninformative preview changes nothing. Attribution: app equal to the id we sent.
 */
export function checkCustody(receipt: SignedReceipt, result: ChatResult, expect: CustodyExpectation): CustodyCheck {
  const rc = receipt.body.receipt ?? {};
  const rid: string | null = typeof rc.request_id === "string" && rc.request_id ? rc.request_id : null;
  const rawPreview: string | null = typeof rc.prompt_preview === "string" ? rc.prompt_preview.replace(PREVIEW_TAIL, "") : null;
  const preview = rawPreview ? rawPreview : null;
  const app: string | null = typeof rc.app === "string" && rc.app ? rc.app : null;
  const sent = expect.prompt === undefined ? [] : typeof expect.prompt === "string" ? [expect.prompt] : [...expect.prompt];
  const cacheStatus: string | null = typeof rc.cache?.status === "string" ? rc.cache.status : null;

  const requestId: CustodyField = rid === null || !result.requestId ? "absent" : rid === result.requestId ? "match" : "mismatch";
  const { field: promptPreview, note: previewNote } = previewField(preview, sent);
  const appField: CustodyField = app === null ? "absent" : app === expect.appId ? "match" : "mismatch";
  const identity = requestId === "match" && promptPreview !== "mismatch";
  const ok = identity && appField === "match";

  const idNote = requestId === "mismatch" ? ` (receipt ${rid}, response ${result.requestId})`
    : requestId === "absent" ? ` (${rid === null && !result.requestId ? "neither side carries an id" : rid === null ? "the receipt carries none" : "the response carries none"})`
    : "";
  const fields = [
    `request_id ${requestId}${idNote}`,
    `prompt_preview ${promptPreview}${previewNote}`,
    `app ${appField}${appField === "mismatch" ? ` (receipt ${app}, sent ${expect.appId})` : appField === "match" ? ` (${app})` : ""}`,
    cacheStatus ? `cache ${cacheStatus}` : "",
  ].filter(Boolean).join(", ");
  const why = !identity && appField !== "match" ? "the receipt is not for this request and is filed under another app"
    : !identity ? "the receipt is not for this request"
    : "the receipt is filed under another app";
  const reason = ok ? `custody holds: ${fields}` : `custody: ${why}; ${fields}`;
  return { ok, requestId, promptPreview, app: appField, cacheStatus, reason };
}

/** The per-client app id a judge call goes out under, so its receipt is attributable to that client: "<base>-<tenant>", the form receipt.app carries. */
export function tenantAppId(tenantId: string, base: string = config.nightshift.appId): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tenantId)) throw new Error(`tenant id is not a header-safe token: ${JSON.stringify(tenantId)}`);
  return `${base}-${tenantId}`;
}

/** A fresh request nonce, 16 hex. Put into the prompt so a retried call is a new request to the runtime: new request_id, no cache hit. */
export function newNonce(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Gate one chat result. The served model comes from the receipt when it is found, else from the
 * response (so the trace says what the response claimed); the signature is checked when the receipt
 * is found, under the finder's keys (ReceiptFinder.keys, [RECEIPT_KEY] when absent). ok only when the
 * receipt was found, its signing key is one of those keys, its signature verifies, the served tier is the
 * requested tier, the receipt says no memory was injected (hmem null, absent or injected 0) and, when
 * `custody` is given, the receipt is ours (checkCustody): the response body is exactly what a
 * substituting proxy controls, so its own routed_model (or its copy of hmem) never passes the gate on
 * its own. One "check" trace event for the custody check when it ran, then one for the gate, status ok
 * or not_judged, carrying the scope sent and the injected count.
 */
export async function gateChatResult(
  result: ChatResult,
  requestedTier: Tier,
  receipts: ReceiptFinder,
  tracer?: Tracer,
  agent = "gate",
  custody?: CustodyExpectation,
): Promise<GateResult> {
  const receipt = result.receiptId ? await receipts.find(result.receiptId) : null;
  const trusted = receipts.keys ?? [RECEIPT_KEY];
  const signatureOk = receipt ? verifyReceipt(receipt, trusted) : null;
  const key = receipt ? keyOf(receipt) : null;
  const servedModel = (receipt ? servedModelOf(receipt) : null) ?? result.modelRouted ?? null;
  const servedTier = tierOf(servedModel);
  const custodyCheck = custody && receipt && signatureOk === true ? checkCustody(receipt, result, custody) : undefined;
  const hmem = receipt ? hmemOf(receipt) : null;
  const memoryInjected = receipt ? hmem?.injected ?? 0 : null;
  const scope = result.scope ?? null;
  const ok = signatureOk === true && servedTier === requestedTier && memoryInjected === 0 && (custodyCheck === undefined || custodyCheck.ok);

  if (custodyCheck) {
    tracer?.emit({
      agent, action: "check", status: custodyCheck.ok ? "ok" : "not_judged",
      model_requested: result.modelRequested, model_routed: servedModel ?? undefined,
      receipt_id: result.receiptId ?? undefined, signature_ok: true,
      input_summary: `custody ${result.receiptId} under app ${custody!.appId}`,
      output_summary: `request_id ${custodyCheck.requestId}, prompt_preview ${custodyCheck.promptPreview}, app ${custodyCheck.app}`,
      detail: custodyCheck.reason,
    });
  }

  const source = receipt ? `receipt ${result.receiptId}` : result.receiptId ? `receipt ${result.receiptId} not in the runtime list, response says` : "no receipt_id on the response, response says";
  const records = (n: number): string => `${n} record${n === 1 ? "" : "s"}`;
  // Worded with no key-like word before a fingerprint, so the trace's redactor (src/redactor.ts nearKey) keeps the fingerprints whole.
  const reason = signatureOk === false && (key === null || !trusted.includes(key)) ? `${source}: signed by an untrusted signer, fingerprint ${key ?? "unreadable"}; the gate trusts ${trusted.join(", ")}`
    : signatureOk === false ? `${source}: signature does not verify; body altered or not signed by the runtime`
    : servedTier !== requestedTier ? `${source} ${servedModel ?? "no model"} (${servedTier}), ${requestedTier} was requested`
    : hmem && signatureOk ? `memory injected (${records(hmem.injected)}): ${source} ${servedModel} (${servedTier}), hmem ids ${hmem.ids.join(", ") || "none listed"}${hmem.topScore !== null ? `, top_score ${hmem.topScore}` : ""}${scope ? `, scope ${scope}` : ""}; the answer was conditioned on earlier stored answers, not judged`
    : custodyCheck && !custodyCheck.ok ? custodyCheck.reason
    : signatureOk ? `${source} ${servedModel} (${servedTier}), signature verified, no memory injected${custodyCheck ? ", custody holds" : ""}`
    : `${source} ${servedModel} (${servedTier}), unreceipted, not judged`;

  tracer?.emit({
    agent, action: "check", status: ok ? "ok" : "not_judged",
    model_requested: result.modelRequested, model_routed: servedModel ?? undefined,
    receipt_id: result.receiptId ?? undefined, signature_ok: signatureOk ?? undefined,
    ...(scope ? { scope } : {}), memory_injected: memoryInjected,
    output_summary: `${requestedTier} requested, ${servedTier} served${memoryInjected ? `, ${records(memoryInjected)} of memory injected` : ""}`, detail: reason,
  });
  return { ok, requestedTier, servedModel, servedTier, receiptId: result.receiptId ?? null, signatureOk, reason, ...(custodyCheck ? { custody: custodyCheck } : {}), memoryInjected, scope };
}

export interface CustodyAttempt {
  chat: ChatResult;
  /** The message text(s) this attempt sent, for the prompt_preview check. */
  prompt?: string | readonly string[];
}

export interface CustodyOutcome {
  /** The result that passed, or the last one that did not. */
  chat: ChatResult;
  gate: GateResult;
  attempts: number;
  /** Answers thrown out for custody, in order. */
  discarded: { chat: ChatResult; gate: GateResult }[];
}

/**
 * The call-then-gate loop with the custody rule. `attempt` makes the model call; it receives a fresh
 * nonce each time and must put it into the prompt it sends under `appId`, and returns the result with
 * the message text(s) it sent, the user message last. A result that fails the gate for custody alone (signature verified,
 * tier right, no memory injected, receipt not ours) is discarded and traced as a retry, and the call is made once more;
 * a second custody failure fails closed with a reason that starts "custody". Any other failure
 * (substitution, injected memory, a tampered body, an unreceipted response) is returned at once and never retried,
 * as before. A thrown model error propagates: the caller files it not_judged as it does today.
 */
export async function gateWithCustody(
  attempt: (ctx: { nonce: string; attempt: number }) => Promise<CustodyAttempt>,
  requestedTier: Tier,
  receipts: ReceiptFinder,
  appId: string,
  tracer?: Tracer,
  agent = "gate",
): Promise<CustodyOutcome> {
  const discarded: CustodyOutcome["discarded"] = [];
  for (let n = 1; n <= 2; n++) {
    const a = await attempt({ nonce: newNonce(), attempt: n });
    const gate = await gateChatResult(a.chat, requestedTier, receipts, tracer, agent, { appId, prompt: a.prompt });
    if (gate.ok) return { chat: a.chat, gate, attempts: n, discarded };
    // Injected memory is refused like a substitution: returned at once, never asked again into a cleaner answer.
    const custodyOnly = gate.custody !== undefined && !gate.custody.ok && gate.signatureOk === true && gate.servedTier === requestedTier && gate.memoryInjected === 0;
    if (!custodyOnly) return { chat: a.chat, gate, attempts: n, discarded };
    discarded.push({ chat: a.chat, gate });
    if (n === 1) {
      tracer?.emit({
        agent, action: "retry", status: "ok", retry_count: 1,
        model_requested: a.chat.modelRequested, receipt_id: a.chat.receiptId ?? undefined,
        input_summary: `custody under app ${appId}`, output_summary: "answer discarded; one retry as a fresh request with a new nonce", detail: gate.custody!.reason,
      });
      continue;
    }
    const reason = `custody: failed on both attempts, answer discarded, not judged; ${gate.custody!.reason.replace(/^custody: /, "")}`;
    tracer?.emit({
      agent, action: "check", status: "not_judged", retry_count: 1,
      model_requested: a.chat.modelRequested, receipt_id: a.chat.receiptId ?? undefined, signature_ok: true,
      input_summary: `custody under app ${appId}`, output_summary: "custody failed on 2 of 2 attempts; fail closed", detail: reason,
    });
    return { chat: a.chat, gate: { ...gate, ok: false, reason }, attempts: 2, discarded };
  }
  throw new Error("unreachable: gateWithCustody makes at most two attempts");
}

/**
 * GET /v1/meterless/receipts once per pass, found by receipt_id. A receipt may land a moment after
 * the chat response, so one miss refreshes the list once (after `refreshDelayMs`) before giving up.
 */
export class ReceiptStore implements ReceiptFinder {
  private cache: SignedReceipt[] | null = null;

  constructor(private readonly ns: Pick<Nightshift, "receipts"> = new Nightshift(), private readonly refreshDelayMs = 250) {}

  async find(receiptId: string): Promise<SignedReceipt | null> {
    this.cache ??= await this.ns.receipts();
    let hit = this.cache.find((r) => r.body.receipt?.receipt_id === receiptId);
    if (!hit) {
      if (this.refreshDelayMs > 0) await new Promise((r) => setTimeout(r, this.refreshDelayMs));
      this.cache = await this.ns.receipts();
      hit = this.cache.find((r) => r.body.receipt?.receipt_id === receiptId);
    }
    return hit ?? null;
  }

  /** Start a new pass: the next find() fetches the list again. */
  reset(): void {
    this.cache = null;
  }
}
