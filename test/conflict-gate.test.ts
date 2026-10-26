// The conflict gate (src/engine/memory.ts, the vendored ConflictDetectionService): a lesson that contradicts a lesson in
// force on the same tenant and scope key is refused, naming both, and nothing is stored; the technician settles each
// conflict by id (supersede or keep_both) and the ledger records who. Then npm run answer through tsx over a store that
// holds one exception, as `--supersede` and `--keep-both` reach it. Scope keys are documentation names (RFC 2606), which
// the redactor passes through, so the assertions hold under any REDACT_SALT.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ConflictError, MemoryError, TechnicianMemory, type FindingScope } from "../src/engine/memory.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const T0 = Date.parse("2026-10-24T12:00:00.000Z");
const prov = { kind: "cli", at: "2026-10-24T11:59:00.000Z", by: "technician", runId: "run-nginx-7f1c-1023" };
const EXPIRES = "2026-11-30T00:00:00.000Z";
const LATER = "2027-01-31T00:00:00.000Z";
const CLASS = "proxied_without_real_ip" as const;
const finding: FindingScope = { tenant_id: "client-a", class: CLASS, host: "host-7f1c", dns_name: "app.example.invalid", refers_to_type: "dns_name", refers_to_id: "app.example.invalid", resolves_to: null };

const exception = (over: Partial<Parameters<TechnicianMemory["recordException"]>[0]> = {}): Parameters<TechnicianMemory["recordException"]>[0] =>
  ({ tenantId: "client-a", findingClass: CLASS, scopeKey: "app.example.invalid", reason: "origin is reached only through the tunnel", expiresAt: EXPIRES, provenance: prov, ...over });
const answer = (a: string, q = "Is the origin reached only through the tunnel?", over: Partial<Parameters<TechnicianMemory["recordAnswer"]>[0]> = {}): Parameters<TechnicianMemory["recordAnswer"]>[0] =>
  ({ tenantId: "client-a", question: q, answer: a, scope: { type: "name", key: "app.example.invalid" }, expiresAt: EXPIRES, provenance: prov, ...over });
const refusal = (fn: () => unknown): ConflictError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConflictError);
    return e as ConflictError;
  }
  throw new Error("expected the gate to refuse");
};
const mem = () => new TechnicianMemory({ clock: () => T0, gate: true });

describe("the conflict gate", () => {
  it("refuses an exception that expires at another instant than one in force on the same class and key, names both, and stores nothing", () => {
    const m = mem();
    const held = m.recordException(exception());
    const entries = m.ledgerEntries().length;
    const e = refusal(() => m.recordException(exception({ expiresAt: LATER, reason: "renewed" })));
    expect(e).toBeInstanceOf(MemoryError);
    expect(e.conflicts).toHaveLength(1);
    expect(e.conflicts[0].with.id).toBe(held.id);
    expect(e.conflicts[0].reason).toContain(`and expire at different instants (${EXPIRES} and ${LATER})`);
    expect(e.message).toContain(held.id);                                  // the lesson in force
    expect(e.message).toContain(`until ${LATER}: renewed`);               // the lesson refused
    expect(m.lessons()).toEqual([held]);
    expect(m.ledgerEntries()).toHaveLength(entries);                        // not even a ledger line
    expect(m.recall(finding).applicable).toEqual([held]);
  });

  it("is on for a store opened with gate: true; a store opened without it records as before and refuses a resolution, which has nothing to settle", () => {
    const open = new TechnicianMemory({ clock: () => T0 });
    const first = open.recordException(exception());
    expect(() => open.recordException(exception({ expiresAt: LATER }))).not.toThrow();
    expect(open.lessons()).toHaveLength(2);
    expect(() => open.recordException(exception({ expiresAt: LATER, resolutions: [{ with: first.id, strategy: "supersede" }] }))).toThrow(/without the conflict gate/);
    expect(open.lessons()).toHaveLength(2);
  });

  it("compares an answer on its scope type and key: the same question and key under another type is another scope", () => {
    const m = mem();
    m.recordAnswer(answer("Yes", "Is the origin reached only through the tunnel?", { scope: { type: "host", key: "host-7f1c" } }));
    expect(() => m.recordAnswer(answer("No", "Is the origin reached only through the tunnel?", { scope: { type: "name", key: "host-7f1c" } }))).not.toThrow();
    expect(() => m.recordAnswer(answer("No", "Is the origin reached only through the tunnel?", { scope: { type: "host", key: "host-7f1c" } }))).toThrow(ConflictError);
  });

  it("lets through what does not contradict: another key, another class, another tenant, the same expiry, a lapsed or a superseded lesson", () => {
    const m = mem();
    m.recordException(exception());
    expect(() => m.recordException(exception({ scopeKey: "www.example.invalid", expiresAt: LATER }))).not.toThrow();
    expect(() => m.recordException(exception({ findingClass: "orphan_vhost", expiresAt: LATER }))).not.toThrow();
    expect(() => m.recordException(exception({ tenantId: "client-b", expiresAt: LATER }))).not.toThrow();
    expect(() => m.recordException(exception({ reason: "recorded again, same expiry" }))).not.toThrow();   // the committed store holds such pairs
    const late = new TechnicianMemory({ clock: () => Date.parse("2026-12-15T00:00:00.000Z"), gate: true });
    late.recordException(exception({ provenance: { ...prov, at: "2026-10-24T11:59:00.000Z" } }));
    expect(() => late.recordException(exception({ expiresAt: LATER, provenance: { ...prov, at: "2026-12-15T00:00:00.000Z" } }))).not.toThrow(); // the first lapsed on 30 Nov
  });

  it("refuses two answers to one question on one scope, however the question is spaced or cased, and an answer pair the reference detector reads as opposing", () => {
    const m = mem();
    m.recordAnswer(answer("Yes"));
    const e = refusal(() => m.recordAnswer(answer("No", "  IS the origin reached only   through the tunnel? ")));
    expect(e.conflicts[0].reason).toContain("the answers differ");
    expect(() => m.recordAnswer(answer("Yes", "is the origin reached only through the tunnel?"))).not.toThrow();  // the same answer again
    // opposing phrases on similar text, with the fields in agreement: the reference's own detector speaks
    const t = mem();
    t.recordException(exception({ reason: "Always keep this proxied name; the origin is reachable only through the tunnel" }));
    const text = refusal(() => t.recordException(exception({ reason: "Never keep this proxied name; the origin is reachable only through the tunnel" })));
    expect(text.conflicts[0].reason).toMatch(/the reference detector reads opposing phrase pair on similar content \(confidence 0\.\d\d\)/);
    expect(text.conflicts[0].confidence).toBeGreaterThan(0.5);
  });

  it("supersede stores the new lesson and keeps the old one marked superseded and never recalled; the ledger holds conflict_detected and conflict_resolved with the technician as actor", () => {
    const m = mem();
    const old = m.recordException(exception());
    const fresh = m.recordException(exception({ expiresAt: LATER, reason: "renewed", provenance: { ...prov, by: "lead technician" }, resolutions: [{ with: old.id, strategy: "supersede" }] }));
    expect(m.lesson(old.id)).toMatchObject({ id: old.id, supersededBy: fresh.id });   // kept on record
    expect(m.hmem.store.get(old.id)?.supersededBy).toBe(fresh.id);                    // the reference's field
    expect(m.hmem.store.get(fresh.id)?.supersedes).toBe(old.id);
    expect(m.recall(finding).applicable).toEqual([fresh]);
    expect(m.recall(finding, "2026-12-15T00:00:00.000Z").expired).toEqual([]);        // the old one is not even reported as lapsed
    const ledger = m.ledgerEntries();
    const detected = ledger.find((x) => x.action === "conflict_detected")!;
    expect(detected).toMatchObject({ memoryId: fresh.id, actor: "lead technician", details: { with: old.id, confidence: 1 } });
    const resolved = ledger.find((x) => x.action === "conflict_resolved")!;
    expect(resolved).toMatchObject({ memoryId: old.id, actor: "lead technician", details: { strategy: "supersede", winner: fresh.id } });
    expect(resolved.previousState?.supersededBy).toBeUndefined();
    expect(resolved.newState?.supersededBy).toBe(fresh.id);
    expect(resolved.timestamp).toBe(T0);
    // a superseded lesson is no conflict for the next one, and withdrawing the winner stands the old one up again
    expect(() => m.recordException(exception({ expiresAt: LATER, reason: "again" }))).not.toThrow();
    const lone = mem();
    const a = lone.recordException(exception());
    const b = lone.recordException(exception({ expiresAt: LATER, resolutions: [{ with: a.id, strategy: "supersede" }] }));
    lone.forget(b.id, "entered on the wrong name");
    expect(lone.recall(finding).applicable.map((l) => l.id)).toEqual([a.id]);
    expect(lone.lesson(a.id)?.supersededBy).toBeUndefined();
  });

  it("keep_both stores the new lesson beside the old one, both in force, and says so in the ledger; an open or a mistaken resolution is refused", () => {
    const m = mem();
    const a = m.recordException(exception());
    const b = m.recordException(exception({ expiresAt: LATER, resolutions: [{ with: a.id, strategy: "keep_both" }] }));
    expect(m.recall(finding).applicable.map((l) => l.id)).toEqual([a.id, b.id]);
    expect(m.ledgerEntries().find((x) => x.action === "conflict_resolved")).toMatchObject({ memoryId: b.id, details: { strategy: "keep_both", with: a.id } });

    // two held lessons conflict; settling one leaves the other named
    const two = mem();
    const x = two.recordException(exception());
    const y = two.recordException(exception({ reason: "recorded again" }));
    const open = refusal(() => two.recordException(exception({ expiresAt: LATER, resolutions: [{ with: x.id, strategy: "supersede" }] })));
    expect(open.conflicts.map((c) => c.with.id)).toEqual([y.id]);
    expect(two.lessons()).toHaveLength(2);
    // a resolution for a lesson that is not in conflict
    const stray = two.recordException(exception({ scopeKey: "www.example.invalid" }));
    expect(() => two.recordException(exception({ expiresAt: LATER, resolutions: [{ with: x.id, strategy: "supersede" }, { with: y.id, strategy: "supersede" }, { with: stray.id, strategy: "supersede" }] })))
      .toThrow(new RegExp(`${stray.id} does not conflict with this lesson \\(it conflicts with ${x.id}, ${y.id}\\)`));
    expect(two.lessons()).toHaveLength(3);
  });

  it("survives the store's directory: a superseded lesson reloads superseded and stays unrecalled", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "gate-store-"));
    try {
      const m = new TechnicianMemory({ storage: "local", directory: d, clock: () => T0, gate: true });
      const a = m.recordException(exception());
      const b = m.recordException(exception({ expiresAt: LATER, resolutions: [{ with: a.id, strategy: "supersede" }] }));
      const read = new TechnicianMemory({ storage: "read", directory: d, clock: () => T0 });
      expect(read.lesson(a.id)?.supersededBy).toBe(b.id);
      expect(read.recall(finding).applicable.map((l) => l.id)).toEqual([b.id]);
      expect(read.history(a.id).map((e) => e.action)).toEqual(["create", "conflict_resolved"]);
      expect(read.history(b.id).map((e) => e.action)).toEqual(["create", "conflict_detected"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("npm run answer settles a conflict by id", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const digest = (dir: string): string => createHash("sha256").update(readFileSync(path.join(dir, "state.json"))).update(readFileSync(path.join(dir, "ledger.jsonl"))).digest("hex");
  const answerCli = (dir: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/answer.ts", ...args, "--memory-dir", dir], { cwd: ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, NO_COLOR: "1" } });
    return { status: r.status, out: r.stdout.replace(/\r\n/g, "\n"), err: r.stderr.replace(/\r\n/g, "\n") };
  };

  it("refuses with exit 1 naming both lessons and leaves the store byte for byte; --supersede then records it and --list shows the old one superseded", () => {
    // sample/bundle.json: fnd-de3c5e8ebdc2d209 is a proxied_without_real_ip finding of client-1 on host-f324df.com. A far expiry keeps the test clear of the day it runs.
    const d = mkdtempSync(path.join(os.tmpdir(), "gate-cli-"));
    dirs.push(d);
    const seed = new TechnicianMemory({ storage: "local", directory: d, clock: () => T0 });
    const held = seed.recordException({ tenantId: "client-1", findingClass: CLASS, scopeKey: "host-f324df.com", reason: "Personal estate, known and intentional", expiresAt: "2099-01-01T00:00:00.000Z", provenance: prov });
    const before = digest(d);

    const refused = answerCli(d, "--finding", "fnd-de3c5e8ebdc2d209", "--accept", "--until", "2099-06-01T00:00:00Z", "--reason", "Renewed");
    expect(refused.status).toBe(1);
    expect(refused.err).toContain("refused: this lesson contradicts 1 lesson(s) in force on host-f324df.com (client-1); nothing is stored");
    expect(refused.err).toContain(`held  ${held.id}  exception  ${CLASS} on host-f324df.com (client-1)  until 2099-01-01T00:00:00.000Z`);
    expect(refused.err).toContain("new   exception for proxied_without_real_ip on host-f324df.com (client-1) until 2099-06-01T00:00:00.000Z: Renewed");
    expect(refused.err).toContain(`--supersede ${held.id}`);
    expect(digest(d)).toBe(before);

    const settled = answerCli(d, "--finding", "fnd-de3c5e8ebdc2d209", "--accept", "--until", "2099-06-01T00:00:00Z", "--reason", "Renewed", "--supersede", held.id, "--by", "lead technician");
    expect(settled.status).toBe(0);
    expect(settled.out).toContain(`settled ${held.id}: superseded by mem-2, kept on record and no longer recalled; the ledger holds conflict_detected and conflict_resolved by lead technician`);

    const list = answerCli(d, "--list");
    expect(list.out).toContain("2 lesson(s)");
    expect(list.out).toContain(`${held.id}  exception  ${CLASS} on host-f324df.com (client-1)  until 2099-01-01T00:00:00.000Z`);
    expect(list.out).toContain("  superseded by mem-2");

    const wrong = answerCli(d, "--finding", "fnd-de3c5e8ebdc2d209", "--accept", "--until", "2099-09-01T00:00:00Z", "--reason", "Again", "--supersede", "mem-99");
    expect(wrong.status).toBe(1);
    expect(wrong.err).toContain("mem-99 does not conflict with this lesson");
  }, 240_000);
});
