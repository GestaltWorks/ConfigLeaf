// npm run why -- --finding <id> (scripts/why.ts, src/engine/lineage.ts): the trust-ledger lineage of a decision that
// recalled a lesson, over sample/bundle.json with the committed lessons (examples/memory) and a copy of them that holds a
// settled conflict and an approved rule. Run through tsx as a judge runs it; the committed store is opened read only and
// stays byte for byte as committed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { approveDream, dreamOver } from "../src/engine/dreaming.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMMITTED = path.join(ROOT, "examples", "memory");
const TMP: string[] = [];
afterAll(() => TMP.forEach((d) => rmSync(d, { recursive: true, force: true })));

const copyOfStore = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "why-store-"));
  TMP.push(d);
  cpSync(COMMITTED, d, { recursive: true });
  return d;
};
const digest = (dir: string): string => createHash("sha256").update(readFileSync(path.join(dir, "state.json"))).update(readFileSync(path.join(dir, "ledger.jsonl"))).digest("hex");

function why(finding: string, dir: string): { status: number | null; out: string; err: string } {
  // --at pins the recall instant, so the lessons' expiry (30 Nov 2026) does not depend on the day the test runs.
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/why.ts", "--finding", finding, "--at", "2026-10-26T12:00:00Z"], {
    cwd: ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, SAMPLE_MODE: "true", DRIFT_MEMORY_DIR: dir, NO_COLOR: "1" },
  });
  return { status: r.status, out: r.stdout.replace(/\r\n/g, "\n"), err: r.stderr };
}

// A finding of SAMPLE_MODE=true npm run sample: ADOPT under mem-7, the exception taught for host-18efce.ai.
const ADOPTED = "fnd-45d5f3f4a2eb0b2e";
// A finding of the same pass that no lesson settled: HOLD under a policy rule.
const HELD = "fnd-d62857e241af66e2";

describe("npm run why", () => {
  it("prints the lesson behind a sample decision: the correction, who taught it and when, the exact-scope recall with its score, no conflict, the ledger entry; the store stays byte for byte", () => {
    const before = digest(COMMITTED);
    const r = why(ADOPTED, COMMITTED);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(r.out).toContain(`why ${ADOPTED}`);
    expect(r.out).toContain("decision    ADOPT until 2026-11-30T00:00:00.000Z, decided by operator");
    expect(r.out).toContain("lesson      mem-7, exception for proxied_without_real_ip on host-18efce.ai (client-1), in force until 2026-11-30T00:00:00.000Z");
    expect(r.out).toContain("correction  \"Personal estate, known and intentional:");
    expect(r.out).toContain("taught by technician at 2026-10-25T14:17:15.739Z in pass run-49fc76bf3b823051, recorded 2026-10-25T14:17:15.742Z; H-MEM origin user_correction, source technician:cli");
    expect(r.out).toContain("the finding's name host-18efce.ai is the lesson's scope key, same tenant, same class: an exact match");
    expect(r.out).toMatch(/score 0\.\d\d for "proxied_without_real_ip host-18efce\.ai" in the reference's hybrid ranking \(retrieval threshold 0\.35\)/);
    expect(r.out).toContain("conflicts   none met");
    expect(r.out).toContain("rules       none approved from this lesson");
    expect(r.out).toContain("ledger      1 entry for mem-7");
    expect(r.out).toContain("create  by technician-memory");
    expect(digest(COMMITTED)).toBe(before);
  }, 120_000);

  it("says so for a finding no lesson settled, and names the ids when the finding is unknown", () => {
    const held = why(HELD, COMMITTED);
    expect(held.status).toBe(0);
    expect(held.out).toContain("decision    HOLD until");
    expect(held.out).toContain("lesson      none recalled");
    expect(held.out).not.toContain("correction");
    const unknown = why("fnd-0000000000000000", COMMITTED);
    expect(unknown.status).toBe(1);
    expect(unknown.err).toContain("no finding fnd-0000000000000000 in the pass over sample/bundle.json (27 findings)");
    expect(unknown.err).toContain(ADOPTED);
  }, 240_000);

  it("shows a settled conflict with who settled it and when, and an approved rule with its derivedFrom lineage", () => {
    const dir = copyOfStore();
    const m = new TechnicianMemory({ storage: "local", directory: dir, clock: () => Date.parse("2026-10-26T09:00:00.000Z"), gate: true });
    const renewed = m.recordException({
      tenantId: "client-1", findingClass: "proxied_without_real_ip", scopeKey: "host-18efce.ai", reason: "Renewed through the winter, still intentional", expiresAt: "2027-01-31T00:00:00.000Z",
      provenance: { kind: "cli", at: "2026-10-26T09:00:00.000Z", by: "lead technician" }, resolutions: [{ with: "mem-7", strategy: "supersede" }, { with: "mem-14", strategy: "supersede" }],
    });
    const proposal = dreamOver(m).find((p) => p.type === "insight")!;
    const rule = approveDream(m, proposal.id, "lead technician");
    expect(rule.derivedFrom).toContain(renewed.id);

    const r = why(ADOPTED, dir);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(r.out).toContain(`lesson      ${renewed.id}, exception for proxied_without_real_ip on host-18efce.ai (client-1), in force until 2027-01-31T00:00:00.000Z`);
    expect(r.out).toContain(`conflict-${renewed.id}-mem-7: recorded against mem-7`);
    expect(r.out).toContain(`settled supersede (winner ${renewed.id}) by lead technician at 2026-10-26T09:00:00.`);
    expect(r.out).toContain(`conflict-${renewed.id}-mem-14: recorded against mem-14`);
    expect(r.out).toContain(`rule        ${rule.id} (insight, proposal ${proposal.id}) approved by lead technician at 2026-10-26T09:00:00.`);
    expect(r.out).toMatch(new RegExp(`derived from ${rule.derivedFrom.length} lesson\\(s\\): mem-\\d+`));
    expect(r.out).toContain("conflict_resolved supersede, winner " + renewed.id);
  }, 120_000);
});
