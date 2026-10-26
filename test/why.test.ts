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

function why(finding: string, dir: string, at = "2026-10-26T12:00:00Z"): { status: number | null; out: string; err: string } {
  // --at pins the recall instant, so the lessons' expiry (30 Nov 2026) does not depend on the day the test runs.
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/why.ts", "--finding", finding, "--at", at], {
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
    expect(r.out).toContain("rule        no approved rule covers this lesson");
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
    // dreaming reads the lessons in force: the 18 proxied_without_real_ip lessons of one reason and expiry become one rule, and
    // the renewed lesson, which has another expiry, is left out
    const proposal = dreamOver(m).proposals.find((p) => p.findingClass === "proxied_without_real_ip")!;
    expect(proposal.derivedFrom).toHaveLength(18);
    expect(proposal.derivedFrom).not.toContain(renewed.id);
    const rule = approveDream(m, proposal.id, "lead technician");

    const r = why(ADOPTED, dir);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(r.out).toContain(`lesson      ${renewed.id}, exception for proxied_without_real_ip on host-18efce.ai (client-1), in force until 2027-01-31T00:00:00.000Z`);
    expect(r.out).toContain(`conflict-${renewed.id}-mem-7: recorded against mem-7`);
    expect(r.out).toContain(`settled supersede (winner ${renewed.id}) by lead technician at 2026-10-26T09:00:00.`);
    expect(r.out).toContain(`conflict-${renewed.id}-mem-14: recorded against mem-14`);
    expect(r.out).toContain("rule        no approved rule covers this lesson");
    expect(r.out).toContain("conflict_resolved supersede, winner " + renewed.id);

    // a finding the rule covers: host-f324df.com, taught twice (mem-1 and mem-21), now covered by the rule
    const covered = why("fnd-de3c5e8ebdc2d209", dir);
    expect(covered.err).toBe("");
    expect(covered.status).toBe(0);
    expect(covered.out).toContain("decision    ADOPT until 2026-11-30T00:00:00.000Z, decided by operator");
    expect(covered.out).toContain(`covered by  rule ${rule.id}, derived from 18 lessons: ADOPT proxied_without_real_ip on 11 scope(s), in force until 2026-11-30T00:00:00.000Z`);
    expect(covered.out).toContain(`approved by lead technician at 2026-10-26T09:00:00.000Z from proposal ${proposal.id}; derivedFrom mem-1 mem-2 mem-3`);
    expect(covered.out).toContain("mem-1: \"Personal estate, known and intentional:");
    expect(covered.out).toContain("mem-21: \"Personal estate, known and intentional:");
    expect(covered.out).toContain("source technician:cli; superseded by " + rule.id);
    expect(covered.out).toContain(`dream_approved proposal ${proposal.id}, derived from 18 lesson(s)  by lead technician`);
    expect(covered.out).not.toContain("no approved rule covers");
  }, 240_000);

  it("shows a keep_both conflict from either lesson: the held one while it is recalled, the new one once the held ones have lapsed", () => {
    const dir = copyOfStore();
    const m = new TechnicianMemory({ storage: "local", directory: dir, clock: () => Date.parse("2026-10-26T09:00:00.000Z"), gate: true });
    // host-f324df.com was taught twice (mem-1 and mem-21, until 30 Nov 2026); the new lesson runs to 31 Jan 2027 and both stay in force
    const kept = m.recordException({
      tenantId: "client-1", findingClass: "proxied_without_real_ip", scopeKey: "host-f324df.com", reason: "Kept through the winter", expiresAt: "2027-01-31T00:00:00.000Z",
      provenance: { kind: "cli", at: "2026-10-26T09:00:00.000Z", by: "lead technician" }, resolutions: [{ with: "mem-1", strategy: "keep_both" }, { with: "mem-21", strategy: "keep_both" }],
    });

    const held = why("fnd-de3c5e8ebdc2d209", dir);                                   // mem-1, the oldest in force, is recalled
    expect(held.err).toBe("");
    expect(held.out).toContain("lesson      mem-1, exception for proxied_without_real_ip on host-f324df.com (client-1)");
    expect(held.out).toContain(`conflict-${kept.id}-mem-1: a later lesson recorded against this one, ${kept.id}, detected 2026-10-26T09:00:00.`);
    expect(held.out).toContain("settled keep_both by lead technician at 2026-10-26T09:00:00.");
    expect(held.out).toContain(`conflict_detected with ${kept.id}  by lead technician`);
    expect(held.out).toContain(`conflict_resolved keep_both with ${kept.id}  by lead technician`);

    const fresh = why("fnd-de3c5e8ebdc2d209", dir, "2026-12-01T00:00:00Z");         // mem-1 and mem-21 have lapsed: the new lesson is recalled
    expect(fresh.err).toBe("");
    expect(fresh.out).toContain(`lesson      ${kept.id}, exception for proxied_without_real_ip on host-f324df.com (client-1), in force until 2027-01-31T00:00:00.000Z`);
    for (const other of ["mem-1", "mem-21"]) {
      expect(fresh.out).toContain(`conflict-${kept.id}-${other}: recorded against ${other}, detected 2026-10-26T09:00:00.`);
    }
    expect(fresh.out).toContain("settled keep_both by lead technician at 2026-10-26T09:00:00.");
    expect(fresh.out).toContain("conflict_detected with mem-1  by lead technician");
    expect(fresh.out).toContain("conflict_resolved keep_both with mem-21  by lead technician");
  }, 240_000);
});
