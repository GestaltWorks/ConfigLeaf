// A judge clones the repository and runs it with no .env and no credentials. Every command this PR adds works that way over the
// committed data: with every DRIFT_*, ZETARIS_*, METERLESS_* and M365_* variable removed from the environment and SAMPLE_MODE=true,
// DRIFT_MEMORY_DIR is unset and the store is examples/memory. Each command exits 0 with nothing on stderr, or exits 2 with one
// plain line, never a stack trace. (The tree has no .env on a clean clone; a .env on the machine running this test still loads,
// so the variables are removed from the environment here and the clean-clone run is the one without the file.)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMMITTED = path.join(ROOT, "examples", "memory");
const STRIP = /^(DRIFT_|ZETARIS_|METERLESS_|M365_)/;
const digest = (dir: string): string => createHash("sha256").update(readFileSync(path.join(dir, "state.json"))).update(readFileSync(path.join(dir, "ledger.jsonl"))).digest("hex");
const copies: string[] = [];
afterAll(() => copies.forEach((d) => rmSync(d, { recursive: true, force: true })));

function run(script: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIP.test(k) && k !== "SAMPLE_MODE" && k !== "LOG_DIR"));
  const r = spawnSync(process.execPath, ["--import", "tsx", `scripts/${script}.ts`, ...args], { cwd: ROOT, encoding: "utf8", timeout: 120_000, env: { ...env, SAMPLE_MODE: "true", NO_COLOR: "1" } });
  return { status: r.status, out: r.stdout.replace(/\r\n/g, "\n"), err: r.stderr.replace(/\r\n/g, "\n") };
}
const noTrace = (err: string): void => expect(err).not.toMatch(/\n\s+at |node:internal|TypeError|ReferenceError|Unhandled/);

describe("every command this PR adds runs on a clean clone", () => {
  it("why, dream and sleep --preview read examples/memory by default and exit 0 with nothing on stderr; sleep without --preview exits 2 with a plain line", () => {
    const before = digest(COMMITTED);
    const why = run("why", "--finding", "fnd-45d5f3f4a2eb0b2e");
    expect([why.status, why.err]).toEqual([0, ""]);
    expect(why.out).toContain("lesson      mem-7, exception for proxied_without_real_ip on host-18efce.ai (client-1)");
    const dream = run("dream");
    expect([dream.status, dream.err]).toEqual([0, ""]);
    expect(dream.out.split("\n")[0]).toBe("dream: store examples/memory");
    expect(dream.out).toContain("2 rule proposal(s) from 2 cluster(s) of dreaming over 23 lesson(s) in force");
    const sleep = run("sleep", "--preview");
    expect([sleep.status, sleep.err]).toEqual([0, ""]);
    expect(sleep.out.split("\n")[0]).toBe("sleep: store examples/memory");
    expect(sleep.out).toContain("23 record(s), 23 lesson(s); nothing is changed");
    const bare = run("sleep");
    expect(bare.status).toBe(2);
    expect(bare.err.split("\n")[0]).toBe("npm run sleep previews and changes nothing; --preview is required");
    noTrace(bare.err);
    expect(digest(COMMITTED)).toBe(before);
  }, 240_000);

  it("the approval path and the conflict gate work on a copy of the committed store with the same environment, and a stale id exits 1 with one plain line", () => {
    const copy = mkdtempSync(path.join(os.tmpdir(), "clean-clone-"));
    copies.push(copy);
    cpSync(COMMITTED, copy, { recursive: true });
    const id = /(drm-[0-9a-f]{12}) {2}ADOPT proxied_without_real_ip/.exec(run("dream").out)![1];
    const approved = run("answer", "--approve-dream", id, "--memory-dir", copy);
    expect([approved.status, approved.err]).toEqual([0, ""]);
    expect(approved.out).toContain(`approved ${id} as mem-24: ADOPT proxied_without_real_ip on 12 scope(s)`);
    const stale = run("answer", "--approve-dream", id, "--memory-dir", copy);
    expect(stale.status).toBe(1);
    expect(stale.err.trim().split("\n")).toHaveLength(1);
    noTrace(stale.err);
    const covered = run("why", "--finding", "fnd-de3c5e8ebdc2d209", "--memory-dir", copy);
    expect([covered.status, covered.err]).toEqual([0, ""]);
    expect(covered.out).toMatch(/covered by {2}rule mem-24, derived from 20 lessons/);
    const refused = run("answer", "--finding", "fnd-b3ea13c119d7b589", "--accept", "--until", "2027-02-01T00:00:00Z", "--reason", "Renewed", "--memory-dir", copy);
    expect(refused.status).toBe(1);
    expect(refused.err).toContain("nothing is stored");
    noTrace(refused.err);
  }, 240_000);
});
