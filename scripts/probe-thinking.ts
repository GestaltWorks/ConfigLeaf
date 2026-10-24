// Does Nightshift forward chat_template_kwargs.enable_thinking, Nemotron's documented reasoning
// switch, to the model? Measured, not assumed: one fixed small-JSON prompt, N calls per model per
// setting (default 3), on config.nightshift.modelFast and modelJudge. Forwarding is observable as a
// change in </think> presence or tokens_out between false and true. Prints a table and one verdict.
// The token is read by config and never printed. Unreachable runtime: say so once, exit 2, no loop.
import { Nightshift, type NightshiftError } from "../src/adapters/nightshift.ts";
import { config } from "../src/config.ts";

const ns = new Nightshift();
const N = Number(process.argv[2] ?? 3);
const ask = { role: "user" as const, content: 'Reply with only this JSON and nothing else: {"ok":true,"sum":<17 plus 25, as a number>}' };

interface Row { model: string; thinking: boolean; i: number; status: string; ms: number; tokensOut: number | null; think: boolean | null; json: string }

if (!config.nightshift.token) {
  console.log("no Nightshift runtime token (METERLESS_RUNTIME_TOKEN or the runtime's proxy-token file); nothing measured");
  process.exit(2);
}
try {
  await ns.models();
} catch (e) {
  console.log(`Nightshift unreachable at ${config.nightshift.baseUrl}: ${(e as Error).message}; nothing measured`);
  process.exit(2);
}

const rows: Row[] = [];
for (const model of [config.nightshift.modelFast, config.nightshift.modelJudge]) {
  for (const thinking of [false, true]) {
    for (let i = 1; i <= N; i++) {
      const t0 = Date.now();
      try {
        const r = await ns.chat({ model, messages: [ask], maxTokens: 1024, agent: "probe", enableThinking: thinking });
        const j = Nightshift.extractJson<{ ok?: boolean; sum?: number }>(r.content);
        rows.push({ model, thinking, i, status: `ok${r.retries ? "+retry" : ""}`, ms: r.latencyMs, tokensOut: r.tokensOut, think: r.content.includes("</think>"), json: j === null ? "none" : j.ok === true && j.sum === 42 ? "ok" : "obj" });
        console.log(`${model} thinking=${thinking} #${i}: ${r.latencyMs} ms, ${r.tokensOut} out, think=${r.content.includes("</think>")}, receipt=${r.receiptId ?? "-"}`);
      } catch (e) {
        const err = e as NightshiftError;
        rows.push({ model, thinking, i, status: `failed ${err.status ?? 0}`, ms: Date.now() - t0, tokensOut: null, think: null, json: "-" });
        console.log(`${model} thinking=${thinking} #${i}: FAILED ${err.status ?? 0} ${err.detail ?? err.message}`);
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

const pad = (s: unknown, n: number) => String(s).padEnd(n);
console.log(`\n${pad("model", 54)}${pad("thinking", 9)}${pad("#", 3)}${pad("status", 10)}${pad("ms", 7)}${pad("tok_out", 8)}${pad("</think>", 9)}json`);
for (const r of rows) console.log(`${pad(r.model, 54)}${pad(r.thinking, 9)}${pad(r.i, 3)}${pad(r.status, 10)}${pad(r.ms, 7)}${pad(r.tokensOut ?? "-", 8)}${pad(r.think ?? "-", 9)}${r.json}`);

const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : NaN);
let forwarded = 0, inconclusive = 0;
for (const model of [config.nightshift.modelFast, config.nightshift.modelJudge]) {
  const arm = (thinking: boolean) => rows.filter((r) => r.model === model && r.thinking === thinking && r.tokensOut !== null);
  const [off, on] = [arm(false), arm(true)];
  if (off.length < 2 || on.length < 2) { inconclusive++; console.log(`${model}: inconclusive, ${off.length} ok calls with false and ${on.length} with true`); continue; }
  const thinkOff = off.filter((r) => r.think).length, thinkOn = on.filter((r) => r.think).length;
  const tokOff = mean(off.map((r) => r.tokensOut!)), tokOn = mean(on.map((r) => r.tokensOut!));
  const thinkDiffers = (thinkOff === 0) !== (thinkOn === 0) || Math.abs(thinkOff / off.length - thinkOn / on.length) >= 0.5;
  const tokDiffers = Math.abs(tokOn - tokOff) > Math.max(20, 0.5 * Math.min(tokOff, tokOn));
  if (thinkDiffers || tokDiffers) forwarded++;
  console.log(`${model}: </think> in ${thinkOff}/${off.length} (false) vs ${thinkOn}/${on.length} (true); tokens_out mean ${tokOff} vs ${tokOn}; latency mean ${mean(off.map((r) => r.ms))} vs ${mean(on.map((r) => r.ms))} ms -> ${thinkDiffers || tokDiffers ? "DIFFERS" : "no difference"}`);
}
const verdict = forwarded > 0 ? "YES" : inconclusive === 2 ? "INCONCLUSIVE" : "NO";
console.log(`\nVERDICT: Nightshift forwards chat_template_kwargs.enable_thinking: ${verdict} (${forwarded} of ${2 - inconclusive} measurable models changed </think> presence or tokens_out between false and true)`);
