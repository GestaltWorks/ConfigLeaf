// Probe one model id through Nightshift N times with the plain JSON prompt and report how many answered.
// Usage: npx tsx scripts/probe-route.ts <model id> [n]
import { Nightshift } from "../src/adapters/nightshift.ts";

const [model, nArg] = process.argv.slice(2);
if (!model) {
  console.error("usage: npx tsx scripts/probe-route.ts <model id> [n]");
  process.exit(2);
}
const n = Number(nArg ?? 6);
const ns = new Nightshift();
const ask = { role: "user" as const, content: 'Reply with only this JSON and nothing else: {"ok":true}' };
let ok = 0;
const ms: number[] = [];
const fails: string[] = [];
for (let i = 0; i < n; i++) {
  const t0 = Date.now();
  try {
    const r = await ns.chat({ model, messages: [ask], maxTokens: 256, agent: "probe" });
    ok++;
    ms.push(Date.now() - t0);
    if (i === 0) console.log(`routed=${r.modelRouted}`);
  } catch (e: any) {
    fails.push(String(e.detail ?? e.message).slice(0, 80));
  }
}
ms.sort((a, b) => a - b);
console.log(`${model}: ${ok}/${n} ok, median ${ms.length ? ms[Math.floor(ms.length / 2)] : "-"} ms${fails.length ? `, failures: ${[...new Set(fails)].join(" | ")}` : ""}`);
