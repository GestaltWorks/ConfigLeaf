// npm run smoke: the three sponsor paths, each as its own process so one failure does not hide another.
import { spawnSync } from "node:child_process";

const steps: [string, string[]][] = [
  ["C  World Model conformance (our module)", ["tsx", "scripts/conformance.ts"]],
  ["C  domain tests (FOUND-BUT-DIFFERENT, receipt verification)", ["vitest", "run", "--reporter=dot"]],
  ["B  Nightshift: Lightning + Ultra by id, receipts, job stream", ["tsx", "scripts/spike-nightshift.ts"]],
  ["A  Zetaris: SELECT 1 and a live REST table", ["tsx", "scripts/spike-zetaris.ts"]],
];

let failed = 0;
for (const [label, args] of steps) {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", args, { stdio: "inherit", shell: process.platform === "win32" });
  const ok = r.status === 0;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
console.log(failed ? `\nSMOKE: ${failed} of ${steps.length} failed` : `\nSMOKE: all ${steps.length} passed`);
process.exit(failed ? 1 : 0);
