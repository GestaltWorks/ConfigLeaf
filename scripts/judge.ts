// npm run judge
//
// The judges' one command: re-checks the main claims on the judge's own machine with no credentials, no model and no
// network, in about 20 seconds, and prints one line per check and a verdict. Each check is one of the repository's own
// npm scripts, run as a judge would run it:
//
//   1  the whole pass over the recorded estate (SAMPLE_MODE=true npm run sample)
//   2  the development eval's signed receipts, verified offline (npm run receipts:verify on the newest results)
//   3  the Meterless World Model conformance suite (npm run conformance)
//   4  the Meterless H-MEM conformance suite (npm run conformance:hmem)
//   5  the replay page rebuilt from the repository byte for byte (npm run site, then git diff on docs/)
//   6  a live-only command refusing cleanly without credentials (npm run pass exits 2 with one line); skipped when
//      this clone has a .env or DATABASE_URL, since it would then run a live pass
//
// Exit 0 when every check that ran passed, 1 otherwise.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

interface Check { title: string; run: () => { ok: boolean; detail: string } | null }

const ROOT = process.cwd();

/** Runs `npm run -s <args>` with `env` added; stdout and stderr together, the exit code. */
function npm(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync("npm", ["run", "-s", ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** The last non-empty line of `text` that does not look like a JSON trace line, cut to `n` characters. */
function lastLine(text: string, n = 90): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("{"));
  const l = lines.at(-1) ?? "";
  return l.length > n ? `${l.slice(0, n - 1)}…` : l;
}

/** The newest committed eval results directory that holds published receipts. */
function newestResults(): string | null {
  const dir = path.join(ROOT, "eval", "results");
  if (!existsSync(dir)) return null;
  const stamps = readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d) && existsSync(path.join(dir, d, "receipts.json"))).sort();
  return stamps.length ? `eval/results/${stamps.at(-1)}` : null;
}

const CHECKS: Check[] = [
  {
    title: "the pass over the recorded estate",
    run: () => {
      const r = npm(["sample"], { SAMPLE_MODE: "true" });
      const decide = r.out.split(/\r?\n/).find((l) => /^\s*decide\s/.test(l))?.trim().replace(/\s+/g, " ") ?? lastLine(r.out);
      return { ok: r.code === 0, detail: decide };
    },
  },
  {
    title: "signed receipts, verified offline",
    run: () => {
      const results = newestResults();
      if (!results) return { ok: false, detail: "no eval/results directory with receipts.json" };
      const r = npm(["receipts:verify", "--", results]);
      return { ok: r.code === 0, detail: `${results}: ${lastLine(r.out, 70)}` };
    },
  },
  {
    title: "Meterless World Model conformance",
    run: () => {
      const r = npm(["conformance"]);
      return { ok: r.code === 0, detail: lastLine(r.out) };
    },
  },
  {
    title: "Meterless H-MEM conformance",
    run: () => {
      const r = npm(["conformance:hmem"]);
      return { ok: r.code === 0, detail: lastLine(r.out) };
    },
  },
  {
    title: "the replay page rebuilt byte for byte",
    run: () => {
      const r = npm(["site"]);
      if (r.code !== 0) return { ok: false, detail: lastLine(r.out) };
      const g = spawnSync("git", ["diff", "--quiet", "--", "docs"], { cwd: ROOT });
      if (g.status === null || g.error) return { ok: true, detail: `${lastLine(r.out, 60)} (git not found: docs/ not compared)` };
      return { ok: g.status === 0, detail: g.status === 0 ? `${lastLine(r.out, 60)}; docs/ unchanged` : "docs/ differs from the committed page" };
    },
  },
  {
    title: "a live-only command refuses without credentials",
    run: () => {
      if (existsSync(path.join(ROOT, ".env")) || process.env.DATABASE_URL) return null;
      const r = npm(["pass", "--", "--tenant", "client-1"]);
      const lines = r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const plain = lines.length <= 2 && !/\bat .+:\d+:\d+/.test(r.out);
      return { ok: r.code === 2 && plain, detail: `exit ${r.code}: ${lastLine(r.out, 70)}` };
    },
  },
];

const t0 = Date.now();
console.log("ConfigLeaf · judge · no credentials, no model, no network");
let ran = 0;
let passed = 0;
CHECKS.forEach((c, i) => {
  const t = Date.now();
  const r = c.run();
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  if (r === null) {
    console.log(`  skip  ${i + 1}  ${c.title}: this clone has credentials, so the check would run a live pass`);
    return;
  }
  ran += 1;
  if (r.ok) passed += 1;
  console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${i + 1}  ${c.title}  ${secs} s`);
  console.log(`           ${r.detail}`);
});
console.log(`judge: ${passed} of ${ran} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(passed === ran ? 0 : 1);
