import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalReceiptBody, verifyReceipt, type SignedReceipt } from "../src/adapters/nightshift.ts";

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
});
