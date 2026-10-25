// Receipts signed with a throwaway Ed25519 key, in the runtime's shape, so verifyReceipt passes and the
// fields under test (request_id, app, prompt_preview, cache) can be set. Shared by the custody and judge
// tests. The model id is the one the real Ultra fixture carries, so the tier gate reads it as Ultra.
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalReceiptBody, type SignedReceipt } from "../../src/adapters/nightshift.ts";
import ultraJson from "./receipt-ultra.json" with { type: "json" };

export const ULTRA_MODEL = (ultraJson as unknown as SignedReceipt).body.receipt.routing.winner as string;

/** A receipt signed here: verifyReceipt trusts the key the receipt itself carries, so a fresh key verifies. */
export function signed(receipt: Record<string, unknown>): SignedReceipt {
  const body = { llama_cpp_ref: "test", manifest_hash: "test", receipt };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const sig = sign(null, Buffer.from(canonicalReceiptBody(body), "utf8"), privateKey);
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(12);
  return { body, pubkey_b64: raw.toString("base64"), sig_b64: sig.toString("base64") };
}

/**
 * A real receipt's body with Nightshift's injected memory cleared (hmem null, as the runtime writes it when it injected
 * nothing), signed again here. The two real fixtures of 23 Oct carry hmem.injected 3, which the gate now refuses; this
 * keeps every other field of the runtime's shape (request_id, app, prompt_preview, cache, phases) for the tests whose
 * subject is the tier, the signature or custody.
 */
export function isolated(r: SignedReceipt): SignedReceipt {
  return signed({ ...structuredClone(r.body.receipt), hmem: null });
}

/** An Ultra receipt for `requestId` under `app`, with the runtime's field names. */
export function ultraReceipt(receiptId: string, requestId: string | null, app: string, extra: Record<string, unknown> = {}): SignedReceipt {
  return signed({
    receipt_id: receiptId, ...(requestId === null ? {} : { request_id: requestId }), app, app_policy: { app },
    routing: { winner: ULTRA_MODEL }, phases: [{ model: ULTRA_MODEL, phase: "final_synthesis", tier: "C" }], winning_route: { model: ULTRA_MODEL, tier: "C" },
    cache: { status: "miss" }, requested_mode: "meterless/auto", status: "ok", ...extra,
  });
}
