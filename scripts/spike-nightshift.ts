// Spike B: Nemotron Lightning and Ultra by explicit id through Nightshift, receipts verified,
// the app's own job located and its event stream read. Prints PASS/FAIL lines.
//
// Memory isolation (26 Oct 2026): Nightshift 1.2.7 puts up to three stored answers to similar earlier requests in
// front of a request that shares their meterless-scope, and the signed receipt says so in hmem. The adapter now sends
// a fresh scope on every request (src/adapters/nightshift.ts freshScope). Two calls under meterless-app
// drift-agent-probe check it: one under a fresh scope must show hmem null (a PASS line), and one under the scope "user",
// the one every call shared before, is reported by its injected count only (an INFO line, no ids, no content).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Nightshift, verifyReceipt, type ChatResult, type SignedReceipt } from "../src/adapters/nightshift.ts";
import { config } from "../src/config.ts";
import { hmemOf } from "../src/gate.ts";
import { Tracer } from "../src/trace.ts";

/** The app id of the two memory calls: a probe app, never a tenant's. */
export const MEMORY_PROBE_APP = "drift-agent-probe";
/** The scope every call shared before 26 Oct 2026. */
export const SHARED_SCOPE = "user";

const hmemText = (r: SignedReceipt): string => {
  const raw = r.body.receipt?.hmem;
  return raw === null ? "hmem null" : raw === undefined ? "hmem absent" : `hmem injected ${hmemOf(r)?.injected ?? 0}`;
};

/** The PASS/FAIL line of the fresh-scope call: its receipt found, signed, and showing no injected memory (hmem null or absent). */
export function freshScopeCheck(receipt: SignedReceipt | null, scope: string | undefined, error?: string): { ok: boolean; label: string; detail: string } {
  const label = "a call under a fresh meterless-scope gets no injected memory (its signed receipt shows hmem null)";
  if (!receipt) return { ok: false, label, detail: error ? `call failed: ${error}` : `scope ${scope ?? "-"}, receipt not in the runtime list` };
  const signedOk = verifyReceipt(receipt);
  const ok = signedOk && hmemOf(receipt) === null;
  return { ok, label, detail: `scope ${scope ?? "-"}, receipt ${receipt.body.receipt?.receipt_id}${signedOk ? "" : " (signature does not verify)"}, ${hmemText(receipt)}` };
}

/** The INFO line of the call under the shared scope "user": what Nightshift injected, counts only. */
export function sharedScopeLine(receipt: SignedReceipt | null, error?: string): string {
  const head = `INFO  a call under the shared meterless-scope "${SHARED_SCOPE}" (every call's scope before 26 Oct)`;
  if (!receipt) return `${head}: no receipt to read (${error ? `call failed: ${error}` : "receipt not in the runtime list"})`;
  const n = hmemOf(receipt)?.injected ?? 0;
  return `${head}: hmem injected ${n} record${n === 1 ? "" : "s"}${verifyReceipt(receipt) ? "" : " (signature does not verify)"}`;
}

async function main(): Promise<void> {
  const ns = new Nightshift();
  const tracer = new Tracer(`spike_nightshift_${Date.now().toString(36)}`);
  let failures = 0;
  const check = (ok: boolean, label: string, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
    if (!ok) failures++;
  };

  const models = await ns.models();
  check(models.some((m) => m.startsWith("meterless/")), "GET /v1/models lists meterless routes", `${models.length} ids`);

  const ask = { role: "user" as const, content: 'Reply with only this JSON and nothing else: {"ok":true,"who":"<your model family in two words>"}' };

  // Lightning on the free tier returns an empty response on roughly a quarter of raw calls
  // (measured 2 of 8 on 23 Oct); the adapter's single retry recovered both. Up to 3 attempts here
  // so a double failure is reported as a number, not a crash.
  async function tryChat(model: string, maxTokens: number, attempts = 3) {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try { return { result: await ns.chat({ model, messages: [ask], maxTokens, agent: "spike", tracer }), outerRetries: i }; }
      catch (e) { last = e; }
    }
    return { result: null, outerRetries: attempts, error: (last as Error)?.message };
  }

  const fastTry = await tryChat(config.nightshift.modelFast, 512);
  const fast = fastTry.result;
  const fastJson = fast ? Nightshift.extractJson<{ ok: boolean }>(fast.content) : null;
  check(!!fastJson?.ok, `Lightning answered by explicit id`, fast ? `routed=${fast.modelRouted} ${fast.latencyMs} ms, ${fast.tokensOut} out, inner retries=${fast.retries}, outer=${fastTry.outerRetries}` : `failed after ${fastTry.outerRetries} attempts: ${fastTry.error}`);
  check((fast?.modelRouted ?? "").includes("nemotron"), "Lightning receipt names a Nemotron model", fast?.modelRouted ?? "none");

  const judgeTry = await tryChat(config.nightshift.modelJudge, 1024);
  const judge = judgeTry.result;
  const judgeJson = judge ? Nightshift.extractJson<{ ok: boolean }>(judge.content) : null;
  check(!!judgeJson?.ok, `Ultra answered by explicit id (JSON extracted past any reasoning preamble)`, judge ? `routed=${judge.modelRouted} ${judge.latencyMs} ms, ${judge.tokensOut} out` : `failed: ${judgeTry.error}`);
  check((judge?.modelRouted ?? "").includes("ultra"), "Ultra receipt names Ultra", judge?.modelRouted ?? "none");

  // Memory: the same prompt under a fresh scope (the adapter's default) and under the shared scope "user", the judge ladder, the probe app.
  const memoryCall = async (scope?: string): Promise<{ result: ChatResult | null; error?: string }> => {
    try {
      return { result: await ns.chatWithFallback({ models: [config.nightshift.modelJudge, ...config.nightshift.fallbackJudge], messages: [ask], maxTokens: 1024, appId: MEMORY_PROBE_APP, ...(scope ? { scope } : {}), agent: "spike", tracer }) };
    } catch (e) {
      return { result: null, error: (e as Error).message };
    }
  };
  const fresh = await memoryCall();
  const shared = await memoryCall(SHARED_SCOPE);

  const receipts = await ns.receipts();
  const verified = receipts.filter(verifyReceipt).length;
  check(receipts.length > 0 && verified === receipts.length, "every receipt signature verifies offline", `${verified}/${receipts.length}`);
  const wanted = [fast?.receiptId, judge?.receiptId].filter(Boolean);
  const ours = receipts.filter((r) => wanted.includes(r.body.receipt.receipt_id));
  check(wanted.length > 0 && ours.length === wanted.length, "this run's receipts are in the runtime's receipt list", `${ours.length}/${wanted.length}`);

  const receiptOf = (r: ChatResult | null): SignedReceipt | null => (r?.receiptId ? receipts.find((x) => x.body.receipt?.receipt_id === r.receiptId) ?? null : null);
  const isolation = freshScopeCheck(receiptOf(fresh.result), fresh.result?.scope, fresh.error);
  check(isolation.ok, isolation.label, isolation.detail);
  console.log(sharedScopeLine(receiptOf(shared.result), shared.error));

  const job = await ns.ownJob();
  check(!!job, `runtime tracks this app as a job`, job ? `${job.id} kind=${job.kind} turns=${job.turns} failed=${job.failed}` : "none");
  if (job) {
    const events = await ns.jobEvents(job.id, 6_000);
    const turns = events.filter((e) => e.t === "turn");
    check(turns.length >= 2, "job event stream replays turn events", `${events.length} events, ${turns.length} turns, kinds=${[...new Set(events.map((e) => e.t))].join(",")}`);
  }

  console.log(failures ? `\nSPIKE B: ${failures} FAIL` : "\nSPIKE B: PASS");
  process.exit(failures ? 1 : 0);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() : "";
if (invoked === import.meta.url.toLowerCase()) await main();
