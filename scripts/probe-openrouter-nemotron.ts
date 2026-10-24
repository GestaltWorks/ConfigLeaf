// Is Nemotron via OpenRouter (inside Nightshift) steadier than NVIDIA's free endpoint?
// Same prompt, N calls each, measured. Receipts must still name a Nemotron model.
import { Nightshift } from "../src/adapters/nightshift.ts";

const ns = new Nightshift();
const N = Number(process.argv[2] ?? 6);
const ask = { role: "user" as const, content: 'Reply with only this JSON and nothing else: {"ok":true}' };
const routes = [
  "openrouter/nvidia/nemotron-3.5-lightning",
  "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
];

for (const model of routes) {
  const rs: { ok: boolean; ms: number; routed?: string | null; retries?: number; detail?: string }[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    try {
      const r = await ns.chat({ model, messages: [ask], maxTokens: 256, agent: "probe" });
      const json = Nightshift.extractJson<{ ok: boolean }>(r.content);
      rs.push({ ok: !!json?.ok, ms: Date.now() - t0, routed: r.modelRouted, retries: r.retries });
    } catch (e: any) {
      rs.push({ ok: false, ms: Date.now() - t0, detail: e.detail ?? e.message });
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  const ok = rs.filter((r) => r.ok);
  const ms = ok.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`${model}\n  ${ok.length}/${N} ok, ${ok.filter((r) => r.retries).length} needed the retry, median ${ms[Math.floor(ms.length / 2)] ?? "-"} ms, routed=${[...new Set(ok.map((r) => r.routed))].join("|") || "-"}, failures=${[...new Set(rs.filter((r) => !r.ok).map((r) => r.detail))].join("; ") || "none"}`);
}
