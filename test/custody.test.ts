// Custody in the receipt gate (plan addendum, item 3): is the verified receipt the one for OUR request,
// filed under the app id WE sent? Against the two real receipts (test/fixtures/receipt-*.json, untouched,
// which carry request_id, prompt_preview and app "drift-agent") and against receipts signed here with a
// throwaway Ed25519 key, so a per-client app id ("drift-agent:client-a"), a foreign request_id, a missing
// id and a replayed preview can be exercised while the signature still verifies. Identity is the
// request_id alone; the preview can refute it, never establish it. Then the call-then-gate loop: discard,
// one retry as a fresh request, fail closed on the second mismatch, and never a retry for any other failure,
// injected memory included. The real receipts carry hmem.injected 3, which the gate refuses before custody; where
// the gate must pass on them, their bodies run with hmem null, signed again here (fixtures/signed-receipt.ts isolated).
import { afterEach, describe, expect, it, vi } from "vitest";
import { Nightshift, RECEIPT_KEY, type ChatResult, type SignedReceipt } from "../src/adapters/nightshift.ts";
import { SYSTEM_PROMPT } from "../src/agents/judge.ts";
import { config } from "../src/config.ts";
import { checkCustody, gateChatResult, gateWithCustody, newNonce, tenantAppId, type CustodyAttempt } from "../src/gate.ts";
import { MemTracer } from "./fixtures/mem-tracer.ts";
import { TEST_KEY, isolated, signed, ultraReceipt } from "./fixtures/signed-receipt.ts";
import lightningJson from "./fixtures/receipt-lightning.json" with { type: "json" };
import ultraJson from "./fixtures/receipt-ultra.json" with { type: "json" };

const lightning = lightningJson as unknown as SignedReceipt;
const ultra = ultraJson as unknown as SignedReceipt;
/** The real Ultra receipt's body with hmem null, signed again: the gate can pass it. */
const ultraClean = isolated(ultra);
const ULTRA_ID = ultra.body.receipt.receipt_id as string;
const ULTRA_REQ = ultra.body.receipt.request_id as string;
const ULTRA_MODEL = ultra.body.receipt.routing.winner as string;
const ULTRA_PREVIEW = ultra.body.receipt.prompt_preview as string;
const LIGHTNING_ID = lightning.body.receipt.receipt_id as string;
const LIGHTNING_REQ = lightning.body.receipt.request_id as string;
const APP = "drift-agent";
const CLIENT_APP = "drift-agent:client-a";

/** The real receipts' key and the fixture's, both trusted. */
const store = (...rs: SignedReceipt[]) => ({ keys: [RECEIPT_KEY, TEST_KEY], find: async (id: string) => rs.find((r) => r.body.receipt.receipt_id === id) ?? null });

function chat(over: Partial<ChatResult> = {}): ChatResult {
  return { content: "{}", modelRequested: "requested", modelRouted: null, receiptId: null, requestId: null, tokensIn: 0, tokensOut: 0, latencyMs: 0, retries: 0, raw: {}, ...over };
}

describe("checkCustody", () => {
  it("holds on the real Ultra receipt when the response id, the prompt and the app are the ones the receipt carries", () => {
    const c = checkCustody(ultra, chat({ receiptId: ULTRA_ID, requestId: ULTRA_REQ }), { appId: APP, prompt: ULTRA_PREVIEW });
    expect(c).toEqual({ ok: true, requestId: "match", promptPreview: "match", app: "match", cacheStatus: "miss", reason: `custody holds: request_id match, prompt_preview match, app match (${APP}), cache miss` });
  });

  it("identity: request_id must match; a side with no id fails closed, and no preview stands in for it", () => {
    // request_id disagrees: not ours, whatever the preview says
    const other = checkCustody(ultra, chat({ requestId: LIGHTNING_REQ }), { appId: APP, prompt: ULTRA_PREVIEW });
    expect(other).toMatchObject({ ok: false, requestId: "mismatch", promptPreview: "match", app: "match" });
    expect(other.reason).toMatch(/^custody: the receipt is not for this request; request_id mismatch \(receipt chatcmpl-[0-9a-f-]+, response chatcmpl-[0-9a-f-]+\)/);
    // the response carried no id: anomalous (the OpenAI-compatible response always has one); a matching preview does not rescue it
    const byPreview = checkCustody(ultra, chat({ requestId: null }), { appId: APP, prompt: ["You are the refuting judge.", `${ULTRA_PREVIEW}\n\nnonce 0123`] });
    expect(byPreview).toMatchObject({ ok: false, requestId: "absent", promptPreview: "match", app: "match" });
    expect(byPreview.reason).toMatch(/^custody: the receipt is not for this request; request_id absent \(the response carries none\), prompt_preview match, app match/);
    // no id and a preview of something else: not ours twice over
    const neither = checkCustody(ultra, chat({ requestId: null }), { appId: APP, prompt: "Claim: something else entirely" });
    expect(neither).toMatchObject({ ok: false, requestId: "absent", promptPreview: "mismatch", app: "match" });
    // no id and no prompt given: nothing to compare, not ours
    const nothing = checkCustody(ultra, chat({ requestId: null }), { appId: APP });
    expect(nothing).toMatchObject({ ok: false, requestId: "absent", promptPreview: "absent", app: "match" });
    expect(nothing.reason).toMatch(/^custody: the receipt is not for this request; request_id absent \(the response carries none\), prompt_preview absent, app match/);
    // the receipt itself carries no request_id: every successful receipt has one, so this is anomalous too; the preview does not decide
    const noRid = checkCustody(ultraReceipt("rcpt_norid", null, APP, { prompt_preview: "Claim: the apex" }), chat({ requestId: "chatcmpl-1" }), { appId: APP, prompt: "Claim: the apex record moved" });
    expect(noRid).toMatchObject({ ok: false, requestId: "absent", promptPreview: "match" });
    expect(noRid.reason).toMatch(/request_id absent \(the receipt carries none\)/);
    const neitherId = checkCustody(ultraReceipt("rcpt_norid2", null, APP), chat({ requestId: null }), { appId: APP });
    expect(neitherId.reason).toMatch(/request_id absent \(neither side carries an id\)/);
  });

  it("the stripped-id replay fails closed: a signed receipt of ours for an earlier request, previewing the shared system prompt, returned against a response with no id", () => {
    const TENANT_APP = "drift-agent:client-1";
    const user = "[request 0123456789abcdef]\nClaim: the apex record moved\n\nSupporting rows (1 of 1; columns: a):\n{\"a\":\"b\"}";
    const old = ultraReceipt("rcpt_old", "chatcmpl-old", TENANT_APP, { prompt_preview: `${SYSTEM_PROMPT.slice(0, 120)}...` });
    // id omitted by the proxy: identity fails on the missing id; the preview of the shared system prompt is uninformative, never a match
    const replay = checkCustody(old, chat({ receiptId: "rcpt_old", requestId: null }), { appId: TENANT_APP, prompt: [SYSTEM_PROMPT, user] });
    expect(replay).toMatchObject({ ok: false, requestId: "absent", promptPreview: "uninformative", app: "match" });
    expect(replay.reason).toBe(`custody: the receipt is not for this request; request_id absent (the response carries none), prompt_preview uninformative (previews a shared message, not the user message), app match (${TENANT_APP}), cache miss`);
    // id present: the mismatch is what fails it
    expect(checkCustody(old, chat({ receiptId: "rcpt_old", requestId: "chatcmpl-new" }), { appId: TENANT_APP, prompt: [SYSTEM_PROMPT, user] })).toMatchObject({ ok: false, requestId: "mismatch", promptPreview: "uninformative" });
    // a system-prompt preview can never establish identity even when it is the only message given
    expect(checkCustody(old, chat({ requestId: null }), { appId: TENANT_APP, prompt: SYSTEM_PROMPT })).toMatchObject({ ok: false, requestId: "absent", promptPreview: "match" });
  });

  it("the preview is secondary: compared against the user message alone, it must reach the end of the request line to match, and a prefix of nothing we sent refutes a matching id", () => {
    const TENANT_APP = "drift-agent:client-1";
    const user = "[request ffffffffffffffff]\nClaim: the apex record moved";
    const sent = [SYSTEM_PROMPT, user];
    // the runtime previewed the user message through the nonce: match
    expect(checkCustody(ultraReceipt("r1", "chatcmpl-1", TENANT_APP, { prompt_preview: "[request ffffffffffffffff]\nClaim: the..." }), chat({ requestId: "chatcmpl-1" }), { appId: TENANT_APP, prompt: sent })).toMatchObject({ ok: true, requestId: "match", promptPreview: "match" });
    // a preview that stops inside the nonce is consistent but says nothing; the id carries identity
    const short = checkCustody(ultraReceipt("r2", "chatcmpl-2", TENANT_APP, { prompt_preview: "[request ffff..." }), chat({ requestId: "chatcmpl-2" }), { appId: TENANT_APP, prompt: sent });
    expect(short).toMatchObject({ ok: true, requestId: "match", promptPreview: "uninformative" });
    expect(short.reason).toContain("prompt_preview uninformative (stops short of the request line)");
    // a replay of our own earlier receipt AND its id: the preview carries the old nonce, a prefix of nothing we sent this time, so it fails whatever the id says
    const replayed = checkCustody(ultraReceipt("r3", "chatcmpl-3", TENANT_APP, { prompt_preview: "[request 0000000000000000]\nClaim: the apex record moved" }), chat({ requestId: "chatcmpl-3" }), { appId: TENANT_APP, prompt: sent });
    expect(replayed).toMatchObject({ ok: false, requestId: "match", promptPreview: "mismatch", app: "match" });
    expect(replayed.reason).toMatch(/^custody: the receipt is not for this request; request_id match, prompt_preview mismatch \(a prefix of nothing we sent\)/);
    // the join of system and user is never a match: a preview that runs across the boundary is a prefix of nothing we sent
    expect(checkCustody(ultraReceipt("r4", "chatcmpl-4", TENANT_APP, { prompt_preview: `${SYSTEM_PROMPT}\n${user.slice(0, 10)}` }), chat({ requestId: "chatcmpl-4" }), { appId: TENANT_APP, prompt: sent })).toMatchObject({ ok: false, promptPreview: "mismatch" });
  });

  it("a preview the runtime cut short ends in an ellipsis; the prefix test runs on what precedes it, and an empty preview is absent", () => {
    const dots = checkCustody(ultraReceipt("rcpt_dots", null, APP, { prompt_preview: "Claim: the apex record..." }), chat(), { appId: APP, prompt: "Claim: the apex record moved to an address outside the inventory" });
    expect(dots.promptPreview).toBe("match");
    const ell = checkCustody(ultraReceipt("rcpt_ell", null, APP, { prompt_preview: "Claim: the apex record…" }), chat(), { appId: APP, prompt: "Claim: the apex record moved" });
    expect(ell.promptPreview).toBe("match");
    const empty = checkCustody(ultraReceipt("rcpt_empty", null, APP, { prompt_preview: "..." }), chat(), { appId: APP, prompt: "Claim: anything" });
    expect(empty).toMatchObject({ ok: false, promptPreview: "absent" });
  });

  it("attribution: the receipt's app must be the id the call went out under; the real receipts are filed under the shared id, so a per-client id fails on them", () => {
    const shared = checkCustody(ultra, chat({ requestId: ULTRA_REQ }), { appId: CLIENT_APP });
    expect(shared).toMatchObject({ ok: false, requestId: "match", app: "mismatch" });
    expect(shared.reason).toBe(`custody: the receipt is filed under another app; request_id match, prompt_preview absent, app mismatch (receipt ${APP}, sent ${CLIENT_APP}), cache miss`);
    const client = checkCustody(ultraReceipt("rcpt_c", "chatcmpl-c", CLIENT_APP), chat({ requestId: "chatcmpl-c" }), { appId: CLIENT_APP });
    expect(client).toMatchObject({ ok: true, requestId: "match", app: "match" });
    const noApp = checkCustody(signed({ receipt_id: "rcpt_noapp", request_id: "chatcmpl-c", routing: { winner: ULTRA_MODEL } }), chat({ requestId: "chatcmpl-c" }), { appId: APP });
    expect(noApp).toMatchObject({ ok: false, app: "absent", cacheStatus: null });
    const both = checkCustody(ultra, chat({ requestId: LIGHTNING_REQ }), { appId: CLIENT_APP });
    expect(both.reason).toMatch(/^custody: the receipt is not for this request and is filed under another app; /);
  });
});

describe("gateChatResult with custody", () => {
  it("passes on the real Ultra receipt's body (hmem null) with its own request id and app, and traces the custody check before the gate", async () => {
    const tracer = new MemTracer("test_custody");
    const g = await gateChatResult(chat({ receiptId: ULTRA_ID, requestId: ULTRA_REQ, modelRequested: "req/ultra" }), "ultra", store(ultraClean), tracer, "judge", { appId: APP, prompt: ULTRA_PREVIEW });
    expect(g).toMatchObject({ ok: true, servedTier: "ultra", signatureOk: true, receiptId: ULTRA_ID, custody: { ok: true, requestId: "match", promptPreview: "match", app: "match" } });
    expect(g.reason).toBe(`receipt ${ULTRA_ID} ${ULTRA_MODEL} (ultra), signature verified, no memory injected, custody holds`);
    expect(tracer.events.map((e) => `${e.agent}:${e.action}:${e.status}`)).toEqual(["judge:check:ok", "judge:check:ok"]);
    expect(tracer.events[0]).toMatchObject({ receipt_id: ULTRA_ID, signature_ok: true, model_requested: "req/ultra", model_routed: ULTRA_MODEL, input_summary: `custody ${ULTRA_ID} under app ${APP}`, output_summary: "request_id match, prompt_preview match, app match" });
    expect(tracer.events[0].detail).toMatch(/^custody holds/);
    expect(tracer.events[1].output_summary).toBe("ultra requested, ultra served");
  });

  it("fails closed on a custody mismatch: not_judged, reason starts with custody, the prompt text is in no trace line", async () => {
    const tracer = new MemTracer("test_custody");
    const secret = "Claim: host-7f1c proxies to app.example.invalid";
    const g = await gateChatResult(chat({ receiptId: ULTRA_ID, requestId: "chatcmpl-not-this-one" }), "ultra", store(ultraClean), tracer, undefined, { appId: CLIENT_APP, prompt: secret });
    expect(g).toMatchObject({ ok: false, servedTier: "ultra", signatureOk: true, custody: { ok: false, requestId: "mismatch", promptPreview: "mismatch", app: "mismatch" } });
    expect(g.reason).toMatch(/^custody: the receipt is not for this request and is filed under another app; request_id mismatch/);
    expect(tracer.events.map((e) => `${e.agent}:${e.action}:${e.status}`)).toEqual(["gate:check:not_judged", "gate:check:not_judged"]);
    expect(tracer.events[1].detail).toBe(g.reason);
    for (const e of tracer.events) expect(JSON.stringify(e)).not.toContain(secret);
  });

  it("custody is evaluated only on a found, verified receipt: unreceipted and tampered results keep their own reasons and carry no custody field", async () => {
    const none = await gateChatResult(chat({ modelRouted: ULTRA_MODEL }), "ultra", store(), undefined, undefined, { appId: APP });
    expect(none.custody).toBeUndefined();
    expect(none.reason).toMatch(/unreceipted, not judged/);
    const missing = await gateChatResult(chat({ receiptId: "rcpt_req_missing" }), "ultra", store(ultra), undefined, undefined, { appId: APP });
    expect(missing.custody).toBeUndefined();
    const tampered = structuredClone(ultra);
    tampered.body.receipt.app = CLIENT_APP;                       // claim our client app; the signature no longer covers the body
    const t = await gateChatResult(chat({ receiptId: ULTRA_ID, requestId: ULTRA_REQ }), "ultra", store(tampered), undefined, undefined, { appId: CLIENT_APP });
    expect(t).toMatchObject({ ok: false, signatureOk: false });
    expect(t.custody).toBeUndefined();
    expect(t.reason).toMatch(/signature does not verify/);
  });

  it("a substitution outranks custody in the reason: Lightning answered an Ultra request, custody recorded but the gate says what was served", async () => {
    const g = await gateChatResult(chat({ receiptId: LIGHTNING_ID, requestId: "chatcmpl-other" }), "ultra", store(lightning), undefined, undefined, { appId: CLIENT_APP });
    expect(g).toMatchObject({ ok: false, servedTier: "lightning", custody: { ok: false } });
    expect(g.reason).toMatch(/\(lightning\), ultra was requested$/);
  });

  it("without a custody expectation the gate checks signature, tier and memory: no custody field, one check event", async () => {
    const tracer = new MemTracer("test_custody");
    const g = await gateChatResult(chat({ receiptId: ULTRA_ID }), "ultra", store(ultraClean), tracer);
    expect(g.ok).toBe(true);
    expect(g.custody).toBeUndefined();
    expect(g.reason).toBe(`receipt ${ULTRA_ID} ${ULTRA_MODEL} (ultra), signature verified, no memory injected`);
    expect(tracer.events).toHaveLength(1);
  });

  it("injected memory fails the gate before custody is read: the real Ultra receipt, its own request id and app, still refused for its 3 records", async () => {
    const g = await gateChatResult(chat({ receiptId: ULTRA_ID, requestId: ULTRA_REQ, scope: "user" }), "ultra", store(ultra), undefined, "judge", { appId: APP, prompt: ULTRA_PREVIEW });
    expect(g).toMatchObject({ ok: false, signatureOk: true, servedTier: "ultra", memoryInjected: 3, scope: "user", custody: { ok: true } });
    expect(g.reason).toMatch(/^memory injected \(3 records\): receipt /);
  });
});

describe("gateWithCustody: discard, retry once as a fresh request, fail closed", () => {
  /** An attempt that returns the receipt and request id the runtime "filed" for each call, remembering every nonce it was handed. */
  function attempts(...plan: { receipt: SignedReceipt; requestId: string | null }[]) {
    const nonces: string[] = [];
    const prompts: string[] = [];
    const fn = async ({ nonce, attempt }: { nonce: string; attempt: number }): Promise<CustodyAttempt> => {
      nonces.push(nonce);
      const p = plan[attempt - 1];
      const prompt = `Claim: the record moved\n\nnonce ${nonce}`;
      prompts.push(prompt);
      return { chat: chat({ receiptId: p.receipt.body.receipt.receipt_id, requestId: p.requestId, modelRequested: "req/ultra", modelRouted: ULTRA_MODEL }), prompt };
    };
    return { fn, nonces, prompts };
  }

  it("first attempt clean: one call, no retry", async () => {
    const r1 = ultraReceipt("rcpt_1", "chatcmpl-1", CLIENT_APP);
    const a = attempts({ receipt: r1, requestId: "chatcmpl-1" });
    const tracer = new MemTracer("test_custody");
    const out = await gateWithCustody(a.fn, "ultra", store(r1), CLIENT_APP, tracer, "judge");
    expect(out).toMatchObject({ attempts: 1, discarded: [], gate: { ok: true, custody: { ok: true, app: "match" } } });
    expect(a.nonces).toHaveLength(1);
    expect(a.nonces[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(tracer.events.map((e) => `${e.action}:${e.status}`)).toEqual(["check:ok", "check:ok"]);
  });

  it("a receipt for another request is discarded and the call made once more with a new nonce; the second one passes", async () => {
    const foreign = ultraReceipt("rcpt_foreign", "chatcmpl-someone-else", CLIENT_APP);
    const ours = ultraReceipt("rcpt_ours", "chatcmpl-2", CLIENT_APP);
    const a = attempts({ receipt: foreign, requestId: "chatcmpl-1" }, { receipt: ours, requestId: "chatcmpl-2" });
    const tracer = new MemTracer("test_custody");
    const out = await gateWithCustody(a.fn, "ultra", store(foreign, ours), CLIENT_APP, tracer, "judge");
    expect(out.attempts).toBe(2);
    expect(out.gate).toMatchObject({ ok: true, receiptId: "rcpt_ours", custody: { ok: true, requestId: "match" } });
    expect(out.chat.receiptId).toBe("rcpt_ours");
    expect(out.discarded).toHaveLength(1);
    expect(out.discarded[0].gate).toMatchObject({ ok: false, receiptId: "rcpt_foreign", custody: { ok: false, requestId: "mismatch" } });
    expect(out.discarded[0].gate.reason).toMatch(/^custody: /);
    expect(a.nonces).toHaveLength(2);
    expect(a.nonces[0]).not.toBe(a.nonces[1]);
    expect(a.prompts[1]).toContain(a.nonces[1]);
    expect(tracer.events.map((e) => `${e.agent}:${e.action}:${e.status}`)).toEqual([
      "judge:check:not_judged", "judge:check:not_judged",    // attempt 1: custody, gate
      "judge:retry:ok",                                      // discarded, retrying
      "judge:check:ok", "judge:check:ok",                    // attempt 2: custody, gate
    ]);
    expect(tracer.events[2]).toMatchObject({ retry_count: 1, receipt_id: "rcpt_foreign", output_summary: "answer discarded; one retry as a fresh request with a new nonce" });
    expect(tracer.events[2].detail).toMatch(/^custody: the receipt is not for this request/);
  });

  it("two mismatches fail closed: not ok, reason starts with custody, both answers discarded, no third call", async () => {
    const r1 = ultraReceipt("rcpt_a", "chatcmpl-x", APP);          // filed under the shared app, not the client's
    const r2 = ultraReceipt("rcpt_b", "chatcmpl-y", APP);
    const a = attempts({ receipt: r1, requestId: "chatcmpl-x" }, { receipt: r2, requestId: "chatcmpl-y" }, { receipt: r2, requestId: "chatcmpl-y" });
    const tracer = new MemTracer("test_custody");
    const out = await gateWithCustody(a.fn, "ultra", store(r1, r2), CLIENT_APP, tracer);
    expect(out.attempts).toBe(2);
    expect(a.nonces).toHaveLength(2);
    expect(out.gate.ok).toBe(false);
    expect(out.gate.reason).toMatch(/^custody: failed on both attempts, answer discarded, not judged; the receipt is filed under another app; request_id match, prompt_preview absent, app mismatch \(receipt drift-agent, sent drift-agent:client-a\)/);
    expect(out.gate).toMatchObject({ servedTier: "ultra", signatureOk: true, receiptId: "rcpt_b", custody: { ok: false, app: "mismatch" } });
    expect(out.discarded.map((d) => d.gate.receiptId)).toEqual(["rcpt_a", "rcpt_b"]);
    expect(tracer.events.map((e) => `${e.action}:${e.status}`)).toEqual(["check:not_judged", "check:not_judged", "retry:ok", "check:not_judged", "check:not_judged", "check:not_judged"]);
    expect(tracer.events.at(-1)).toMatchObject({ agent: "gate", retry_count: 1, output_summary: "custody failed on 2 of 2 attempts; fail closed" });
  });

  it("any other failure is returned at once and never retried: a Lightning receipt where Ultra was requested, an unreceipted response", async () => {
    const sub = attempts({ receipt: lightning, requestId: LIGHTNING_REQ }, { receipt: ultra, requestId: ULTRA_REQ });
    const s = await gateWithCustody(sub.fn, "ultra", store(lightning, ultra), APP);
    expect(s.attempts).toBe(1);
    expect(sub.nonces).toHaveLength(1);
    expect(s.gate.ok).toBe(false);
    expect(s.gate.reason).toMatch(/ultra was requested$/);
    expect(s.discarded).toEqual([]);

    const un = { fn: async () => ({ chat: chat({ modelRouted: ULTRA_MODEL }) }) };
    const u = await gateWithCustody(un.fn, "ultra", store(), APP);
    expect(u).toMatchObject({ attempts: 1, discarded: [], gate: { ok: false, signatureOk: null } });
    expect(u.gate.reason).toMatch(/unreceipted, not judged/);
  });

  it("injected memory is refused like a substitution, never retried: one call, even when custody fails too", async () => {
    const memory = { hmem: { ids: ["mem_a", "mem_b"], injected: 2, reason: "retrieved 2 memories", strategy: "comprehensive", top_score: 0.52 } };
    const ours = ultraReceipt("rcpt_mem", "chatcmpl-mem", CLIENT_APP, memory);
    const a = attempts({ receipt: ours, requestId: "chatcmpl-mem" }, { receipt: ultraReceipt("rcpt_clean", "chatcmpl-clean", CLIENT_APP), requestId: "chatcmpl-clean" });
    const tracer = new MemTracer("test_custody");
    const out = await gateWithCustody(a.fn, "ultra", store(ours), CLIENT_APP, tracer, "judge");
    expect(out).toMatchObject({ attempts: 1, discarded: [], gate: { ok: false, memoryInjected: 2, custody: { ok: true } } });
    expect(out.gate.reason).toMatch(/^memory injected \(2 records\): receipt rcpt_mem /);
    expect(a.nonces).toHaveLength(1);
    expect(tracer.events.map((e) => `${e.action}:${e.status}`)).toEqual(["check:ok", "check:not_judged"]);
    // filed under another app as well: still one call, memory named first
    const foreign = ultraReceipt("rcpt_mem2", "chatcmpl-mem2", APP, memory);
    const b = attempts({ receipt: foreign, requestId: "chatcmpl-mem2" }, { receipt: foreign, requestId: "chatcmpl-mem2" });
    const both = await gateWithCustody(b.fn, "ultra", store(foreign), CLIENT_APP);
    expect(both).toMatchObject({ attempts: 1, discarded: [], gate: { ok: false, memoryInjected: 2, custody: { ok: false, app: "mismatch" } } });
    expect(both.gate.reason).toMatch(/^memory injected \(2 records\)/);
  });

  it("a thrown model error propagates to the caller, which files it not_judged as it does today", async () => {
    await expect(gateWithCustody(async () => { throw new Error("chat -> 502: provider_error"); }, "ultra", store(), APP)).rejects.toThrow(/502/);
  });
});

describe("tenantAppId and newNonce", () => {
  it("builds the per-client app id from the configured base and refuses a tenant that is not a header-safe token", () => {
    expect(tenantAppId("client-a")).toBe(`${config.nightshift.appId}-client-a`);
    expect(tenantAppId("client-1", "drift-agent")).toBe("drift-agent-client-1");
    expect(() => tenantAppId("client a")).toThrow(/header-safe/);
    expect(() => tenantAppId("")).toThrow(/header-safe/);
    expect(() => tenantAppId("x\ny")).toThrow(/header-safe/);
  });

  it("nonces are 16 hex and distinct", () => {
    const a = newNonce(), b = newNonce();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});

describe("Nightshift.chat appId option", () => {
  afterEach(() => vi.unstubAllGlobals());

  // headers() refuses to build without a runtime token, so this needs the local Nightshift's token file; a clean clone skips it.
  it.skipIf(!config.nightshift.token)("sends meterless-app as the per-call appId, or the configured id when none is given; the token is never asserted on", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers["meterless-app"]);
      return new Response(JSON.stringify({ id: "chatcmpl-stub", choices: [{ message: { content: "{}" } }], meterless: { receipt_id: "rcpt_stub", routed_model: ULTRA_MODEL } }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const ns = new Nightshift();
    const a = await ns.chat({ model: "m", messages: [{ role: "user", content: "x" }], agent: "test", appId: CLIENT_APP });
    const b = await ns.chat({ model: "m", messages: [{ role: "user", content: "x" }], agent: "test" });
    const c = await ns.chatWithFallback({ models: ["m"], messages: [{ role: "user", content: "x" }], agent: "test", appId: "drift-agent:client-b" });
    expect(seen).toEqual([CLIENT_APP, config.nightshift.appId, "drift-agent:client-b"]);
    expect(a.requestId).toBe("chatcmpl-stub");
    expect(b.receiptId).toBe("rcpt_stub");
    expect(c.hop).toBe(0);
  });
});
