// Measure Lightning's empty-response rate on identical plain prompts, so the retry policy
// is based on a number rather than a guess. Also records whether Ultra fails at the same time.
import { Nightshift } from "../src/adapters/nightshift.ts";
import { config } from "../src/config.ts";

const ns = new Nightshift();
const N = Number(process.argv[2] ?? 8);
const ask = { role: "user" as const, content: 'Reply with only this JSON and nothing else: {"ok":true}' };

async function one(model: string) {
  const t0 = Date.now();
  try {
    const r = await ns.chat({ model, messages: [ask], maxTokens: 256, agent: "probe" });
    return { ok: true, ms: Date.now() - t0, routed: r.modelRouted, retries: r.retries, out: r.tokensOut };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t0, detail: e.detail ?? e.message };
  }
}

const results: Record<string, any[]> = { fast: [], judge: [] };
for (let i = 0; i < N; i++) {
  results.fast.push(await one(config.nightshift.modelFast));
  if (i % 2 === 0) results.judge.push(await one(config.nightshift.modelJudge));
  await new Promise((r) => setTimeout(r, 1500));
}
for (const [k, rs] of Object.entries(results)) {
  const ok = rs.filter((r) => r.ok).length;
  const ms = rs.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const retried = rs.filter((r) => r.ok && r.retries > 0).length;
  console.log(`${k}: ${ok}/${rs.length} ok (incl. ${retried} that needed the one retry), median ${ms[Math.floor(ms.length / 2)] ?? "-"} ms, failures: ${[...new Set(rs.filter((r) => !r.ok).map((r) => r.detail))].join("; ") || "none"}`);
}
