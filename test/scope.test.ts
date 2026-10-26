// Memory isolation, measured 25 Oct 2026: Nightshift 1.2.7 puts up to three stored answers to similar earlier requests
// in front of any request that shares their meterless-scope, and the signed receipt records it as hmem. The adapter
// (src/adapters/nightshift.ts) sends a fresh scope on every request unless the caller pins one, over a fake fetch here:
// the header each request carried, the scope the result and each model_call trace line name, and the injected count
// the response's own receipt copy states. Then the spike's two memory lines (scripts/spike-nightshift.ts) over receipts
// signed here. No live call; the token is a test value the fake fetch never checks.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Nightshift, freshScope } from "../src/adapters/nightshift.ts";
import { config } from "../src/config.ts";
import { tenantAppId } from "../src/gate.ts";
import { MEMORY_PROBE_APP, SHARED_SCOPE, freshScopeCheck, sharedScopeLine } from "../scripts/spike-nightshift.ts";
import { MemTracer } from "./fixtures/mem-tracer.ts";
import { TEST_KEY, ULTRA_MODEL, signed, ultraReceipt } from "./fixtures/signed-receipt.ts";

const HEX16 = "[0-9a-f]{16}";
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Seen = { scope: string; app: string; model: string };
type Answer = { status: number; body: string };

const ok = (id: string, receiptCopy?: Record<string, unknown>): Answer => ({
  status: 200,
  body: JSON.stringify({ id: `chatcmpl-${id}`, choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, meterless: { receipt_id: `rcpt_${id}`, routed_model: ULTRA_MODEL, ...(receiptCopy ? { receipt: receiptCopy } : {}) } }),
});
const down = (status: number): Answer => ({ status, body: JSON.stringify({ error: { meterless_detail: "provider_error" } }) });

/** A fetch that answers from a script in order and records the meterless headers and the model of every request. */
function fakeFetch(script: Answer[]): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    seen.push({ scope: init.headers["meterless-scope"], app: init.headers["meterless-app"], model: (JSON.parse(init.body) as { model: string }).model });
    const next = script.shift();
    if (!next) throw new Error("no scripted answer");
    return new Response(next.body, { status: next.status });
  });
  return seen;
}

const ns = (): Nightshift => new Nightshift({ token: "test-token", retryDelayMs: 1 });
const ask = [{ role: "user" as const, content: "x" }];

describe("Nightshift chat: a fresh meterless-scope per request", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("each call goes out under its own scope, drift-agent-<tenant>-<16 hex> under a tenant's app id; meterless-app is unchanged; the result names the scope", async () => {
    const app = tenantAppId("client-a");
    const seen = fakeFetch([ok("a"), ok("b"), ok("c")]);
    const a = await ns().chat({ model: "m", messages: ask, agent: "test", appId: app });
    const b = await ns().chat({ model: "m", messages: ask, agent: "test", appId: app });
    const c = await ns().chat({ model: "m", messages: ask, agent: "test" });
    expect(seen.map((s) => s.app)).toEqual([app, app, config.nightshift.appId]);
    expect(seen[0].scope).toMatch(new RegExp(`^${esc(config.nightshift.appId)}-client-a-${HEX16}$`));
    expect(seen[1].scope).toMatch(new RegExp(`^${esc(app)}-${HEX16}$`));
    expect(seen[2].scope).toMatch(new RegExp(`^${esc(config.nightshift.appId)}-${HEX16}$`));
    expect(new Set(seen.map((s) => s.scope)).size).toBe(3);
    expect(seen.some((s) => s.scope === "user")).toBe(false);
    expect([a.scope, b.scope, c.scope]).toEqual(seen.map((s) => s.scope));
  });

  it("a retry on the same route and the next hop each draw a fresh scope; every model_call line names the scope its request used", async () => {
    const seen = fakeFetch([down(502), down(503), ok("b")]);
    const tracer = new MemTracer("test_scope");
    const r = await ns().chatWithFallback({ models: ["route-a", "route-b"], messages: ask, agent: "test", tracer, appId: "drift-agent-probe" });
    expect(seen.map((s) => s.model)).toEqual(["route-a", "route-a", "route-b"]);
    expect(new Set(seen.map((s) => s.scope)).size).toBe(3);
    expect(r.scope).toBe(seen[2].scope);
    expect(tracer.events.filter((e) => e.action === "model_call").map((e) => [e.status, e.scope])).toEqual(seen.map((s, i) => [i < 2 ? "failed" : "ok", s.scope]));
  });

  it("a pinned scope goes out on every attempt and every hop, and comes back on the result", async () => {
    const seen = fakeFetch([down(502), down(502), ok("b"), ok("c")]);
    const r = await ns().chatWithFallback({ models: ["route-a", "route-b"], messages: ask, agent: "test", scope: "heldout-2026-10-26T20-00-00Z-7" });
    expect(seen.map((s) => [s.model, s.scope])).toEqual([["route-a", "heldout-2026-10-26T20-00-00Z-7"], ["route-a", "heldout-2026-10-26T20-00-00Z-7"], ["route-b", "heldout-2026-10-26T20-00-00Z-7"]]);
    expect(r.scope).toBe("heldout-2026-10-26T20-00-00Z-7");
    const pinned = await ns().chat({ model: "m", messages: ask, agent: "test", scope: SHARED_SCOPE });
    expect(seen.at(-1)!.scope).toBe("user");
    expect(pinned.scope).toBe("user");
  });

  it("the model_call line carries memory_injected as the response's own receipt copy says: 3, 0 for hmem null, null with no copy", async () => {
    fakeFetch([ok("a", { hmem: { ids: ["m1", "m2", "m3"], injected: 3, reason: "retrieved 3 memories", strategy: "comprehensive", top_score: 0.53 } }), ok("b", { hmem: null }), ok("c")]);
    const tracer = new MemTracer("test_scope_memory");
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await ns().chat({ model: "m", messages: ask, agent: "test", tracer }));
    expect(results.map((r) => r.memoryInjected)).toEqual([3, 0, null]);
    expect(tracer.events.map((e) => [e.action, e.memory_injected, typeof e.scope])).toEqual([["model_call", 3, "string"], ["model_call", 0, "string"], ["model_call", null, "string"]]);
  });

  it("freshScope is the app id and 16 hex, a new one each time", () => {
    expect(freshScope("drift-agent-client-1")).toMatch(new RegExp(`^drift-agent-client-1-${HEX16}$`));
    expect(freshScope()).toMatch(new RegExp(`^${esc(config.nightshift.appId)}-${HEX16}$`));
    expect(freshScope("a")).not.toBe(freshScope("a"));
  });
});

describe("the spike's memory lines (scripts/spike-nightshift.ts), over receipts signed here", () => {
  /** The keys the spike's checks trust here: the fixture's, which signs every receipt of this block. */
  const KEYS = [TEST_KEY];
  const injected = (n: number) => ({ hmem: { ids: Array.from({ length: n }, (_, i) => `mem_${i}`), injected: n, reason: `retrieved ${n} memories`, strategy: "comprehensive", top_score: 0.55 } });

  it("PASS for a fresh-scope call whose signed receipt shows hmem null or absent; FAIL when it shows injected memory, a bad signature or no receipt", () => {
    const pass = freshScopeCheck(ultraReceipt("rcpt_fresh", "chatcmpl-1", MEMORY_PROBE_APP, { hmem: null }), "drift-agent-probe-0123456789abcdef", undefined, KEYS);
    expect(pass).toEqual({ ok: true, label: "a call under a fresh meterless-scope gets no injected memory (its signed receipt shows hmem null)", detail: "scope drift-agent-probe-0123456789abcdef, receipt rcpt_fresh, hmem null" });
    expect(freshScopeCheck(ultraReceipt("rcpt_abs", "chatcmpl-2", MEMORY_PROBE_APP), "s", undefined, KEYS).ok).toBe(true);
    expect(freshScopeCheck(ultraReceipt("rcpt_abs", "chatcmpl-2", MEMORY_PROBE_APP), "s", undefined, KEYS).detail).toBe("scope s, receipt rcpt_abs, hmem absent");
    const fail = freshScopeCheck(ultraReceipt("rcpt_mem", "chatcmpl-3", MEMORY_PROBE_APP, injected(2)), "s", undefined, KEYS);
    expect(fail).toMatchObject({ ok: false, detail: "scope s, receipt rcpt_mem, hmem injected 2" });
    const tampered = ultraReceipt("rcpt_t", "chatcmpl-4", MEMORY_PROBE_APP, { hmem: null });
    tampered.body.receipt.app = "drift-agent-other";
    expect(freshScopeCheck(tampered, "s", undefined, KEYS)).toMatchObject({ ok: false, detail: "scope s, receipt rcpt_t (signature does not verify), hmem null" });
    expect(freshScopeCheck(null, "s")).toMatchObject({ ok: false, detail: "scope s, receipt not in the runtime list" });
    expect(freshScopeCheck(null, undefined, "chat m -> 502: provider_error")).toMatchObject({ ok: false, detail: "call failed: chat m -> 502: provider_error" });
  });

  it("the shared-scope line reports the injected count only: no ids, no reason, no content", () => {
    const line = sharedScopeLine(ultraReceipt("rcpt_user", "chatcmpl-5", MEMORY_PROBE_APP, injected(3)), undefined, KEYS);
    expect(line).toBe('INFO  a call under the shared meterless-scope "user" (every call\'s scope before 26 Oct): hmem injected 3 records');
    expect(line).not.toMatch(/mem_|retrieved|0\.55/);
    expect(sharedScopeLine(ultraReceipt("rcpt_u1", "chatcmpl-6", MEMORY_PROBE_APP, injected(1)), undefined, KEYS)).toMatch(/: hmem injected 1 record$/);
    expect(sharedScopeLine(signed({ receipt_id: "rcpt_u0", hmem: null }), undefined, KEYS)).toMatch(/: hmem injected 0 records$/);
    expect(sharedScopeLine(null, "chat m -> 502: lightning_empty_response")).toMatch(/: no receipt to read \(call failed: chat m -> 502: lightning_empty_response\)$/);
  });
});
