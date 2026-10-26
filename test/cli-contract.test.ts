// The contract of the commands this PR adds when they are run wrongly: one plain line, a non-zero code, never a stack trace.
// The shared --at parser is strict ISO 8601 UTC and the shared path rendering never shows an absolute path; `why` fails loudly
// on a bad bundle and on a corrupt ledger entry.
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parseAt, shownStore } from "../src/engine/cli.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMMITTED = path.join(ROOT, "examples", "memory");
const TMP: string[] = [];
afterAll(() => TMP.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "cli-contract-"));
  TMP.push(d);
  return d;
};
function run(script: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", `scripts/${script}.ts`, ...args], { cwd: ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, SAMPLE_MODE: "true", DRIFT_MEMORY_DIR: COMMITTED, NO_COLOR: "1" } });
  return { status: r.status, out: r.stdout.replace(/\r\n/g, "\n"), err: r.stderr.replace(/\r\n/g, "\n").trimEnd() };
}
/** One plain line: no newline inside, no stack frame, no Node internals. */
const plainLine = (err: string): void => {
  expect(err.length).toBeGreaterThan(0);
  expect(err).not.toContain("\n");
  expect(err).not.toMatch(/node:internal|^\w*Error:/);
};

describe("the shared --at parser and path rendering", () => {
  it("--at is strict ISO 8601 UTC: a date, T, a time and Z, milliseconds optional; the clock when absent", () => {
    expect(parseAt("2026-12-01T00:00:00Z")).toBe(Date.parse("2026-12-01T00:00:00Z"));
    expect(parseAt("2026-12-01T00:00:00.250Z")).toBe(Date.parse("2026-12-01T00:00:00.250Z"));
    expect(parseAt(undefined, 42)).toBe(42);
    for (const bad of ["", "yesterday", "2026-12-01", "2026-12-01T00:00:00", "2026-12-01 00:00:00Z", "2026-12-01T00:00:00+01:00", "2026-12-01T00:00:00+00:00",
      "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-12-01T25:00:00Z", "Mon, 01 Dec 2026 00:00:00 GMT", "1792937821545", "2026-12-01T00:00:00Z junk"]) {
      expect(parseAt(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("a store prints relative to the working directory with forward slashes, and by its last segment elsewhere", () => {
    expect(shownStore(path.join(ROOT, "examples", "memory"), ROOT)).toBe("examples/memory");
    expect(shownStore(path.join(ROOT, ".world", "memory"), ROOT)).toBe(".world/memory");
    expect(shownStore(path.join(os.tmpdir(), "store-x"), ROOT)).toBe("store-x");
  });

  it("why, sleep and dream refuse a malformed --at with exit 2 and one plain line", () => {
    for (const [script, args] of [["why", ["--finding", "fnd-45d5f3f4a2eb0b2e"]], ["sleep", ["--preview"]], ["dream", []]] as const) {
      const r = run(script, ...args, "--at", "2026-02-30T00:00:00Z");
      expect([script, r.status]).toEqual([script, 2]);
      plainLine(r.err);
      expect(r.err).toBe('--at is an ISO 8601 UTC instant such as 2026-12-01T00:00:00Z, got "2026-02-30T00:00:00Z"');
    }
  }, 120_000);
});

describe("npm run why on bad input", () => {
  it("a missing bundle, a bundle that is not JSON and a bundle that does not load exit 2 with one plain line", () => {
    const dir = tmp();
    const notJson = path.join(dir, "not-json.json");
    const notBundle = path.join(dir, "not-a-bundle.json");
    writeFileSync(notJson, "{ this is not json");
    writeFileSync(notBundle, "[1, 2, 3]");
    const missing = run("why", "--finding", "fnd-45d5f3f4a2eb0b2e", "--bundle", path.join(dir, "absent.json"));
    expect(missing.status).toBe(2);
    plainLine(missing.err);
    expect(missing.err).toContain("cannot read the bundle");
    const bad = run("why", "--finding", "fnd-45d5f3f4a2eb0b2e", "--bundle", notJson);
    expect(bad.status).toBe(2);
    plainLine(bad.err);
    expect(bad.err).toContain("cannot read the bundle");
    const odd = run("why", "--finding", "fnd-45d5f3f4a2eb0b2e", "--bundle", notBundle);
    expect(odd.status).toBe(2);
    plainLine(odd.err);
    expect(odd.err).toContain("does not load");
  }, 240_000);

  it("a ledger entry with malformed details fails loudly, naming the entry, with exit 1 and one plain line", () => {
    const dir = tmp();
    cpSync(COMMITTED, dir, { recursive: true });
    appendFileSync(path.join(dir, "ledger.jsonl"), `${JSON.stringify({ memoryId: "mem-7", action: "conflict_detected", actor: "technician", timestamp: 1792937821545, details: { conflictId: 5, with: "mem-1" } })}\n`);
    const r = run("why", "--finding", "fnd-45d5f3f4a2eb0b2e", "--memory-dir", dir, "--at", "2026-10-26T12:00:00Z");
    expect(r.status).toBe(1);
    plainLine(r.err);
    expect(r.err).toContain("the ledger entry conflict_detected for mem-7 at 2026-10-25T");
    expect(r.err).toContain("has malformed details: conflictId");
    expect(r.out).toBe("");
  }, 120_000);
});
