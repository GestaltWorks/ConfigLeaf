import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalReceiptBody, verifyReceipt, type SignedReceipt } from "../src/adapters/nightshift.ts";

// The body of rcpt_req_afqg8yrc (25 Oct 2026: Lightning, app drift-agent-memtest, a fresh scope, hmem null) byte for
// byte as meterlessd signed and stored it in receipts.jsonl, prompt_preview redacted: its 30-token cost is
// 3.3000000000000006e-6 in the signer's spelling, which the receipts endpoint serves as 0.0000033000000000000006.
const TINY_COST_BODY = readFileSync(new URL("./fixtures/receipt-lightning-tiny-cost.json", import.meta.url), "utf8").trimEnd();

function signed(body: SignedReceipt["body"], tamper = false): SignedReceipt {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const sig = sign(null, Buffer.from(canonicalReceiptBody(body), "utf8"), privateKey);
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(12);
  const b = tamper ? { ...body, receipt: { ...body.receipt, routed_model: "someone-else" } } : body;
  return { body: b, pubkey_b64: raw.toString("base64"), sig_b64: sig.toString("base64") };
}

describe("Nightshift receipt verification", () => {
  const body = { llama_cpp_ref: "abc", manifest_hash: "def", receipt: { receipt_id: "rcpt_1", routed_model: "nvidia/nemotron-3-ultra-550b-a55b", z: 1, a: [3, { y: 2, x: 1 }] } };

  it("canonical form is compact with keys sorted recursively", () => {
    expect(canonicalReceiptBody({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });

  it("accepts a valid Ed25519 signature over the canonical body", () => {
    expect(verifyReceipt(signed(body))).toBe(true);
  });

  it("rejects a receipt whose body was altered after signing", () => {
    expect(verifyReceipt(signed(body, true))).toBe(false);
  });

  it("spells numbers as the runtime's Rust signer prints them: an exponent below 1e-5, integers as digits", () => {
    expect(canonicalReceiptBody({ a: 5.47e-6, b: 0.00001569, c: 0.0008864200000000001, d: 41.22974785112885, e: 1e-7, f: 1e-6, g: -5.47e-6, h: 1e21, i: 0, j: 42, k: 0.61 }))
      .toBe('{"a":5.47e-6,"b":0.00001569,"c":0.0008864200000000001,"d":41.22974785112885,"e":1e-7,"f":1e-6,"g":-5.47e-6,"h":1e21,"i":0,"j":42,"k":0.61}');
  });

  it("verifies a receipt the signer wrote with an exponent cost and the endpoint serves in decimal", () => {
    expect(TINY_COST_BODY).toContain('"actual_usd":3.3000000000000006e-6');
    expect(TINY_COST_BODY).toContain('"prompt_preview":"[redacted]"');
    const served = JSON.parse(TINY_COST_BODY) as SignedReceipt["body"]; // the value GET /v1/meterless/receipts returns
    expect(JSON.stringify(served)).toContain('"actual_usd":0.0000033000000000000006');
    expect(canonicalReceiptBody(served)).toBe(TINY_COST_BODY);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const sig = sign(null, Buffer.from(TINY_COST_BODY, "utf8"), privateKey); // over the signer's bytes, not our canonical form
    const raw = publicKey.export({ type: "spki", format: "der" }).subarray(12);
    expect(verifyReceipt({ body: served, pubkey_b64: raw.toString("base64"), sig_b64: sig.toString("base64") })).toBe(true);
  });
});
