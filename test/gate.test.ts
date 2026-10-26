// The receipt gate against two REAL receipts from the build machine's Nightshift runtime, pulled on
// 23 Oct 2026 through GET /v1/meterless/receipts into test/fixtures/receipt-lightning.json and
// receipt-ultra.json. Checked by eye and by grep for hostnames, paths and mail addresses: none, the
// only free text is the probe prompt and runtime labels. Body, pubkey and signature are untouched so
// the Ed25519 check still passes; a tampered body must fail the gate even when the tier then matches.
// Both real receipts carry Nightshift's injected memory (hmem.injected 3, the scope "user" every call shared
// then), which the gate refuses; the tests whose subject is the tier or the signature also run on their bodies
// with hmem null, signed again here (test/fixtures/signed-receipt.ts isolated). The test finder trusts both keys:
// RECEIPT_KEY, which signs the real receipts, and TEST_KEY, which signs the fixture's.
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RECEIPT_KEY, canonicalReceiptBody, receiptKeyFingerprint, type ChatResult, type SignedReceipt } from "../src/adapters/nightshift.ts";
import { ReceiptStore, gateChatResult, hmemOf, memoryInjectedOf, servedModelOf, tierOf } from "../src/gate.ts";
import { MemTracer } from "./fixtures/mem-tracer.ts";
import { TEST_KEY, isolated, signed, ultraReceipt } from "./fixtures/signed-receipt.ts";
import lightningJson from "./fixtures/receipt-lightning.json" with { type: "json" };
import ultraJson from "./fixtures/receipt-ultra.json" with { type: "json" };

const realLightning = lightningJson as unknown as SignedReceipt;
const realUltra = ultraJson as unknown as SignedReceipt;
const lightning = isolated(realLightning);
const ultra = isolated(realUltra);
const LIGHTNING_ID = lightning.body.receipt.receipt_id as string;
const ULTRA_ID = ultra.body.receipt.receipt_id as string;

const store = (...rs: SignedReceipt[]) => ({ keys: [RECEIPT_KEY, TEST_KEY], find: async (id: string) => rs.find((r) => r.body.receipt.receipt_id === id) ?? null });

function chat(over: Partial<ChatResult> = {}): ChatResult {
  return { content: "{}", modelRequested: "requested", modelRouted: null, receiptId: null, requestId: null, tokensIn: 0, tokensOut: 0, latencyMs: 0, retries: 0, raw: {}, ...over };
}

describe("tierOf", () => {
  it("names the tier from the model id substring", () => {
    expect(tierOf("openrouter/nvidia/nemotron-3.5-lightning")).toBe("lightning");
    expect(tierOf("nvidia/nemotron-3.5-lightning-30b-a3b")).toBe("lightning");
    expect(tierOf("local-runtime/nemotron-3.5-lightning-30b-a3b")).toBe("lightning");
    expect(tierOf("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free")).toBe("ultra");
    expect(tierOf("nvidia/nemotron-3-ultra-550b-a55b")).toBe("ultra");
    expect(tierOf("NVIDIA/Nemotron-3-ULTRA")).toBe("ultra");
  });

  it("is unknown for anything else, null and undefined included", () => {
    expect(tierOf("meterless/auto")).toBe("unknown");
    expect(tierOf("")).toBe("unknown");
    expect(tierOf(null)).toBe("unknown");
    expect(tierOf(undefined)).toBe("unknown");
  });
});

describe("servedModelOf", () => {
  it("reads the winning phase, which agrees with routing.winner and winning_route.model on both fixtures", () => {
    for (const r of [lightning, ultra]) {
      const rc = r.body.receipt;
      expect(servedModelOf(r)).toBe(rc.phases[0].model);
      expect(servedModelOf(r)).toBe(rc.routing.winner);
      expect(servedModelOf(r)).toBe(rc.winning_route.model);
    }
    expect(tierOf(servedModelOf(lightning))).toBe("lightning");
    expect(tierOf(servedModelOf(ultra))).toBe("ultra");
  });

  it("falls back to routing.winner, then winning_route.model, then null", () => {
    const base = { pubkey_b64: "", sig_b64: "" };
    expect(servedModelOf({ ...base, body: { receipt: { routing: { winner: "a/ultra" } } } })).toBe("a/ultra");
    expect(servedModelOf({ ...base, body: { receipt: { winning_route: { model: "b/lightning" } } } })).toBe("b/lightning");
    expect(servedModelOf({ ...base, body: { receipt: {} } })).toBeNull();
  });
});

describe("gateChatResult", () => {
  it("ok: the real Lightning receipt's body with hmem null, Lightning requested; the receipt, not the response, names the model", async () => {
    const g = await gateChatResult(chat({ receiptId: LIGHTNING_ID, modelRouted: "something/else" }), "lightning", store(lightning));
    expect(g).toMatchObject({ ok: true, requestedTier: "lightning", servedTier: "lightning", servedModel: lightning.body.receipt.routing.winner, receiptId: LIGHTNING_ID, signatureOk: true, memoryInjected: 0 });
    expect(g.reason).toMatch(/signature verified, no memory injected$/);
  });

  it("ok: the real Ultra receipt's body with hmem null, Ultra requested", async () => {
    const g = await gateChatResult(chat({ receiptId: ULTRA_ID }), "ultra", store(lightning, ultra));
    expect(g).toMatchObject({ ok: true, servedTier: "ultra", servedModel: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", signatureOk: true, memoryInjected: 0 });
  });

  it("not ok: the real receipts as the runtime signed them carry 3 injected records, so the gate refuses them with memory injected (3 records), never on the response's word", async () => {
    for (const [r, tier] of [[realLightning, "lightning"], [realUltra, "ultra"]] as const) {
      const id = r.body.receipt.receipt_id as string;
      const g = await gateChatResult(chat({ receiptId: id, scope: "user", memoryInjected: 0 }), tier, store(r));
      expect(g).toMatchObject({ ok: false, servedTier: tier, signatureOk: true, memoryInjected: 3, scope: "user" });
      expect(g.reason).toBe(`memory injected (3 records): receipt ${id} ${r.body.receipt.routing.winner} (${tier}), hmem ids ${(r.body.receipt.hmem.ids as string[]).join(", ")}, top_score ${r.body.receipt.hmem.top_score}, scope user; the answer was conditioned on earlier stored answers, not judged`);
    }
  });

  it("hmem null or absent passes; injected 0 passes; one record reads singular; the scope sent and the count land on the result and on the check event", async () => {
    const make = (id: string, extra: Record<string, unknown>) => ultraReceipt(id, `chatcmpl-${id}`, "drift-agent-client-a", extra);
    const nul = make("rcpt_null", { hmem: null });
    const absent = make("rcpt_absent", {});
    const zero = make("rcpt_zero", { hmem: { ids: [], injected: 0, reason: "no memories above threshold", strategy: "comprehensive", top_score: 0.1 } });
    const one = make("rcpt_one", { hmem: { ids: ["mem_a"], injected: 1, reason: "retrieved 1 memories", strategy: "comprehensive", top_score: 0.61 } });
    const tracer = new MemTracer("test_gate_memory");
    const finder = store(nul, absent, zero, one);
    for (const id of ["rcpt_null", "rcpt_absent", "rcpt_zero"]) {
      const g = await gateChatResult(chat({ receiptId: id, scope: "drift-agent-client-a-0123456789abcdef" }), "ultra", finder, tracer);
      expect(g, id).toMatchObject({ ok: true, memoryInjected: 0, scope: "drift-agent-client-a-0123456789abcdef" });
    }
    const g1 = await gateChatResult(chat({ receiptId: "rcpt_one" }), "ultra", finder, tracer);
    expect(g1).toMatchObject({ ok: false, memoryInjected: 1, scope: null });
    expect(g1.reason).toMatch(/^memory injected \(1 record\): receipt rcpt_one .*hmem ids mem_a, top_score 0\.61; /);
    expect(tracer.events.map((e) => [e.status, e.scope, e.memory_injected])).toEqual([
      ["ok", "drift-agent-client-a-0123456789abcdef", 0], ["ok", "drift-agent-client-a-0123456789abcdef", 0], ["ok", "drift-agent-client-a-0123456789abcdef", 0], ["not_judged", undefined, 1],
    ]);
    expect(tracer.events[3].output_summary).toBe("ultra requested, ultra served, 1 record of memory injected");
    // no receipt found: no count, the gate refuses as unreceipted
    const none = await gateChatResult(chat({ receiptId: "rcpt_missing" }), "ultra", finder);
    expect(none).toMatchObject({ ok: false, memoryInjected: null, signatureOk: null });
  });

  it("hmemOf and memoryInjectedOf read the receipt's hmem: null for none, the count from injected or else the ids", () => {
    expect(hmemOf(realUltra)).toEqual({ injected: 3, ids: realUltra.body.receipt.hmem.ids, topScore: realUltra.body.receipt.hmem.top_score });
    expect(hmemOf(ultra)).toBeNull();
    expect(memoryInjectedOf(ultra)).toBe(0);
    expect(memoryInjectedOf(realLightning)).toBe(3);
    expect(memoryInjectedOf(signed({ receipt_id: "r", hmem: { ids: ["a", "b"] } }))).toBe(2);
    expect(memoryInjectedOf(signed({ receipt_id: "r" }))).toBe(0);
  });

  it("a substitution outranks injected memory in the reason; a tampered body is still a signature failure first", async () => {
    const sub = await gateChatResult(chat({ receiptId: LIGHTNING_ID }), "ultra", store(realLightning));
    expect(sub).toMatchObject({ ok: false, servedTier: "lightning", memoryInjected: 3 });
    expect(sub.reason).toMatch(/\(lightning\), ultra was requested$/);
    const tampered = structuredClone(realUltra);
    tampered.body.receipt.hmem = null;                            // claim no memory; the signature no longer covers the body
    const t = await gateChatResult(chat({ receiptId: ULTRA_ID }), "ultra", store(tampered));
    expect(t).toMatchObject({ ok: false, signatureOk: false });
    expect(t.reason).toMatch(/signature does not verify/);
  });

  it("not ok: Ultra requested, the receipt says Lightning answered", async () => {
    const g = await gateChatResult(chat({ receiptId: LIGHTNING_ID, modelRouted: ultra.body.receipt.routing.winner }), "ultra", store(lightning));
    expect(g).toMatchObject({ ok: false, requestedTier: "ultra", servedTier: "lightning", signatureOk: true });
    expect(g.reason).toMatch(/ultra was requested/);
  });

  it("not ok: a body altered to claim the requested tier fails the signature", async () => {
    const tampered = structuredClone(ultra);
    tampered.body.receipt.routing.winner = "openrouter/nvidia/nemotron-3.5-lightning";
    tampered.body.receipt.phases[0].model = "openrouter/nvidia/nemotron-3.5-lightning";
    const g = await gateChatResult(chat({ receiptId: ULTRA_ID }), "lightning", store(tampered));
    expect(g).toMatchObject({ ok: false, servedTier: "lightning", signatureOk: false });
    expect(g.reason).toMatch(/signature does not verify/);
  });

  it("not ok: a receipt signed correctly by a key the finder does not name gives signature_ok false, and the trace names its fingerprint", async () => {
    const other = generateKeyPairSync("ed25519");
    const body = structuredClone(ultra.body);
    const forged: SignedReceipt = {
      body,
      pubkey_b64: other.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64"),
      sig_b64: sign(null, Buffer.from(canonicalReceiptBody(body), "utf8"), other.privateKey).toString("base64"),
    };
    const otherKey = receiptKeyFingerprint(forged.pubkey_b64);
    const tracer = new MemTracer("test_gate_key");
    const g = await gateChatResult(chat({ receiptId: ULTRA_ID }), "ultra", store(forged), tracer);
    expect(g).toMatchObject({ ok: false, servedTier: "ultra", signatureOk: false, memoryInjected: 0 });
    expect(g.reason).toBe(`receipt ${ULTRA_ID}: signed by an untrusted signer, fingerprint ${otherKey}; the gate trusts ${RECEIPT_KEY}, ${TEST_KEY}`);
    expect(tracer.events).toEqual([expect.objectContaining({ action: "check", status: "not_judged", signature_ok: false, detail: g.reason })]);
    // the same receipt passes under a finder that names its key
    expect(await gateChatResult(chat({ receiptId: ULTRA_ID }), "ultra", { keys: [otherKey], find: async () => forged })).toMatchObject({ ok: true, signatureOk: true });
    // a finder that names no keys trusts RECEIPT_KEY alone: the committed receipt verifies, the fresh-key and test-key receipts do not
    const pinned = (r: SignedReceipt) => gateChatResult(chat({ receiptId: ULTRA_ID }), "ultra", { find: async () => r });
    expect((await pinned(realUltra)).signatureOk).toBe(true);
    expect(await pinned(forged)).toMatchObject({ ok: false, signatureOk: false });
    expect(await pinned(ultra)).toMatchObject({ ok: false, signatureOk: false });
    expect((await pinned(ultra)).reason).toContain(`fingerprint ${TEST_KEY}; the gate trusts ${RECEIPT_KEY}`);
  });

  it("no receipt_id on the response: not judged whatever the response claims; the served tier still says what it claimed", async () => {
    const claims = await gateChatResult(chat({ modelRouted: "nvidia/nemotron-3-ultra-550b-a55b" }), "ultra", store());
    expect(claims).toMatchObject({ ok: false, signatureOk: null, receiptId: null, servedModel: "nvidia/nemotron-3-ultra-550b-a55b", servedTier: "ultra" });
    expect(claims.reason).toMatch(/no receipt_id/);
    expect(claims.reason).toMatch(/unreceipted, not judged/);
    const no = await gateChatResult(chat({ modelRouted: null }), "ultra", store());
    expect(no).toMatchObject({ ok: false, servedTier: "unknown", signatureOk: null });
  });

  it("receipt_id not in the runtime list: not judged; the response's routed model is reported, not trusted", async () => {
    const g = await gateChatResult(chat({ receiptId: "rcpt_req_missing", modelRouted: "openrouter/nvidia/nemotron-3.5-lightning" }), "lightning", store(ultra));
    expect(g).toMatchObject({ ok: false, signatureOk: null, receiptId: "rcpt_req_missing", servedTier: "lightning" });
    expect(g.reason).toMatch(/not in the runtime list/);
    expect(g.reason).toMatch(/unreceipted, not judged/);
  });

  it("the trace event for an unreceipted response is not_judged", async () => {
    const tracer = new MemTracer("test_gate");
    await gateChatResult(chat({ modelRouted: "nvidia/nemotron-3-ultra-550b-a55b" }), "ultra", store(), tracer);
    expect(tracer.events).toEqual([expect.objectContaining({ action: "check", status: "not_judged", model_routed: "nvidia/nemotron-3-ultra-550b-a55b" })]);
    expect(tracer.events[0].signature_ok).toBeUndefined();
  });

  it("emits one check event: status ok, or not_judged when the gate refuses", async () => {
    const tracer = new MemTracer("test_gate");
    await gateChatResult(chat({ receiptId: ULTRA_ID, modelRequested: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free" }), "ultra", store(ultra), tracer, "judge");
    await gateChatResult(chat({ receiptId: ULTRA_ID }), "lightning", store(ultra), tracer);
    expect(tracer.events).toHaveLength(2);
    expect(tracer.events[0]).toMatchObject({ agent: "judge", action: "check", status: "ok", model_requested: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", model_routed: ultra.body.receipt.routing.winner, receipt_id: ULTRA_ID, signature_ok: true });
    expect(tracer.events[1]).toMatchObject({ agent: "gate", action: "check", status: "not_judged", signature_ok: true });
  });
});

describe("ReceiptStore", () => {
  it("fetches the list once per pass and refreshes once on a miss", async () => {
    let calls = 0;
    const lists: SignedReceipt[][] = [[], [lightning], [lightning], [lightning, ultra]];
    const ns = { receipts: async () => lists[Math.min(calls++, lists.length - 1)] };
    const s = new ReceiptStore(ns, 0);
    expect(await s.find(LIGHTNING_ID)).toBe(lightning);      // miss on the first list, hit after the one refresh
    expect(calls).toBe(2);
    expect(await s.find(LIGHTNING_ID)).toBe(lightning);      // cached
    expect(calls).toBe(2);
    expect(await s.find("rcpt_req_nope")).toBeNull();        // one refresh, then null; never loops
    expect(calls).toBe(3);
    s.reset();
    expect(await s.find(ULTRA_ID)).toBe(ultra);              // new pass fetches again
    expect(calls).toBe(4);
  });
});
