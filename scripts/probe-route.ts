// npm run probe:route -- <model id> [n]
//
// Probes one model id through Nightshift n times (1 to 50, default 6) with the plain JSON prompt, PAUSE_MS apart so the
// probe itself trips no rate limit, and prints how many answered, the median latency and each failure's kind.
import { Nightshift } from "../src/adapters/nightshift.ts";

const USAGE = "usage: npm run probe:route -- <model id> [n]";
/** The pause between two calls. */
const PAUSE_MS = 1000;

const [model, nArg] = process.argv.slice(2);
if (!model) {
  console.error(USAGE);
  process.exit(2);
}
const n = Number(nArg ?? 6);
if (!Number.isInteger(n) || n < 1 || n > 50) {
  console.error(`n must be a whole number from 1 to 50\n${USAGE}`);
  process.exit(2);
}
const ns = new Nightshift();
const ask = { role: "user" as const, content: 'Reply with only this JSON and nothing else: {"ok":true}' };
let ok = 0;
const ms: number[] = [];
const fails: string[] = [];
for (let i = 0; i < n; i++) {
  if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
  const t0 = Date.now();
  try {
    const r = await ns.chat({ model, messages: [ask], maxTokens: 256, agent: "probe" });
    ok++;
    ms.push(Date.now() - t0);
    if (i === 0) console.log(`routed=${r.modelRouted}`);
  } catch (e) {
    // Only the failure's kind is printed (e.g. "<route>_empty_response"), never an upstream body that could echo a header.
    const err = e as { detail?: unknown; message?: unknown };
    const kind = String(err.detail ?? err.message).match(/^[A-Za-z0-9/._:-]+_[a-z_]+/);
    fails.push(kind ? kind[0] : "failed");
  }
}
ms.sort((a, b) => a - b);
console.log(`${model}: ${ok}/${n} ok, median ${ms.length ? ms[Math.floor(ms.length / 2)] : "-"} ms${fails.length ? `, failures: ${[...new Set(fails)].join(" | ")}` : ""}`);
