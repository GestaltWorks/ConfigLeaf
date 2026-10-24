// The receipt gate against two REAL receipts from the build machine's Nightshift runtime, pulled on
// 23 Oct 2026 through GET /v1/meterless/receipts into test/fixtures/receipt-lightning.json and
// receipt-ultra.json. Checked by eye and by grep for hostnames, paths and mail addresses: none, the
// only free text is the probe prompt and runtime labels. Body, pubkey and signature are untouched so
// the Ed25519 check still passes; a tampered body must fail the gate even when the tier then matches.
import { describe, expect, it } from "vitest";
import type { ChatResult, SignedReceipt } from "../src/adapters/nightshift.ts";
import { ReceiptStore, gateChatResult, servedModelOf, tierOf } from "../src/gate.ts";
import { MemTracer } from "./fixtures/mem-tracer.ts";
import lightningJson from "./fixtures/receipt-lightning.json" with { type: "json" };
import ultraJson from "./fixtures/receipt-ultra.json" with { type: "json" };

const lightning = lightningJson as unknown as SignedReceipt;
const ultra = ultraJson as unknown as SignedReceipt;
const LIGHTNING_ID = lightning.body.receipt.receipt_id as string;
const ULTRA_ID = ultra.body.receipt.receipt_id as string;

const store = (...rs: SignedReceipt[]) => ({ find: async (id: string) => rs.find((r) => r.body.receipt.receipt_id === id) ?? null });

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
  it("ok: real Lightning receipt, Lightning requested; the receipt, not the response, names the model", async () => {
    const g = await gateChatResult(chat({ receiptId: LIGHTNING_ID, modelRouted: "something/else" }), "lightning", store(lightning));
    expect(g).toMatchObject({ ok: true, requestedTier: "lightning", servedTier: "lightning", servedModel: lightning.body.receipt.routing.winner, receiptId: LIGHTNING_ID, signatureOk: true });
    expect(g.reason).toMatch(/signature verified/);
  });

  it("ok: real Ultra receipt, Ultra requested", async () => {
    const g = await gateChatResult(chat({ receiptId: ULTRA_ID }), "ultra", store(lightning, ultra));
    expect(g).toMatchObject({ ok: true, servedTier: "ultra", servedModel: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", signatureOk: true });
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
