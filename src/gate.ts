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

import { Nightshift, verifyReceipt, type ChatResult, type SignedReceipt } from "./adapters/nightshift.ts";
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
}

export interface ReceiptFinder {
  find(receiptId: string): Promise<SignedReceipt | null>;
}

/** The model a receipt says answered: the winning phase's model, else routing.winner, else winning_route.model. */
export function servedModelOf(r: SignedReceipt): string | null {
  const rc = r.body.receipt ?? {};
  const winner: string | undefined = rc.routing?.winner;
  const phases: { model?: string }[] = Array.isArray(rc.phases) ? rc.phases : [];
  const phase = phases.find((p) => p.model && p.model === winner) ?? phases.at(-1);
  return phase?.model ?? winner ?? rc.winning_route?.model ?? null;
}

/**
 * Gate one chat result. The served model comes from the receipt when it is found, else from the
 * response (so the trace says what the response claimed); the signature is checked when the receipt
 * is found. ok only when the receipt was found, its signature verifies and the served tier is the
 * requested tier: the response body is exactly what a substituting proxy controls, so its own
 * routed_model never passes the gate on its own. One "check" trace event, status ok or not_judged.
 */
export async function gateChatResult(
  result: ChatResult,
  requestedTier: Tier,
  receipts: ReceiptFinder,
  tracer?: Tracer,
  agent = "gate",
): Promise<GateResult> {
  const receipt = result.receiptId ? await receipts.find(result.receiptId) : null;
  const signatureOk = receipt ? verifyReceipt(receipt) : null;
  const servedModel = (receipt ? servedModelOf(receipt) : null) ?? result.modelRouted ?? null;
  const servedTier = tierOf(servedModel);
  const ok = signatureOk === true && servedTier === requestedTier;

  const source = receipt ? `receipt ${result.receiptId}` : result.receiptId ? `receipt ${result.receiptId} not in the runtime list, response says` : "no receipt_id on the response, response says";
  const reason = signatureOk === false ? `${source}: signature does not verify; body altered or not signed by the runtime`
    : servedTier !== requestedTier ? `${source} ${servedModel ?? "no model"} (${servedTier}), ${requestedTier} was requested`
    : signatureOk ? `${source} ${servedModel} (${servedTier}), signature verified`
    : `${source} ${servedModel} (${servedTier}), unreceipted, not judged`;

  tracer?.emit({
    agent, action: "check", status: ok ? "ok" : "not_judged",
    model_requested: result.modelRequested, model_routed: servedModel ?? undefined,
    receipt_id: result.receiptId ?? undefined, signature_ok: signatureOk ?? undefined,
    output_summary: `${requestedTier} requested, ${servedTier} served`, detail: reason,
  });
  return { ok, requestedTier, servedModel, servedTier, receiptId: result.receiptId ?? null, signatureOk, reason };
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
