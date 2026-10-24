// Spike B: Nemotron Lightning and Ultra by explicit id through Nightshift, receipts verified,
// the app's own job located and its event stream read. Prints PASS/FAIL lines.
import { Nightshift, verifyReceipt } from "../src/adapters/nightshift.ts";
import { config } from "../src/config.ts";
import { Tracer } from "../src/trace.ts";

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

const receipts = await ns.receipts();
const verified = receipts.filter(verifyReceipt).length;
check(receipts.length > 0 && verified === receipts.length, "every receipt signature verifies offline", `${verified}/${receipts.length}`);
const wanted = [fast?.receiptId, judge?.receiptId].filter(Boolean);
const ours = receipts.filter((r) => wanted.includes(r.body.receipt.receipt_id));
check(wanted.length > 0 && ours.length === wanted.length, "this run's receipts are in the runtime's receipt list", `${ours.length}/${wanted.length}`);

const job = await ns.ownJob();
check(!!job, `runtime tracks this app as a job`, job ? `${job.id} kind=${job.kind} turns=${job.turns} failed=${job.failed}` : "none");
if (job) {
  const events = await ns.jobEvents(job.id, 6_000);
  const turns = events.filter((e) => e.t === "turn");
  check(turns.length >= 2, "job event stream replays turn events", `${events.length} events, ${turns.length} turns, kinds=${[...new Set(events.map((e) => e.t))].join(",")}`);
}

console.log(failures ? `\nSPIKE B: ${failures} FAIL` : "\nSPIKE B: PASS");
process.exit(failures ? 1 : 0);
