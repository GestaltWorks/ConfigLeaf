// npm run dream (scripts/dream.ts, src/engine/dreaming.ts, the vendored DreamingService) and its approval through
// npm run answer -- --approve-dream. Over the committed lessons (examples/memory) dreaming proposes one insight and one
// invariant, each a cluster of all 23 lessons whose content is their text joined, and the command says so. Proposing
// writes nothing; approving writes one record with derivedFrom lineage, and only `answer` approves. Scope keys are
// documentation names (RFC 2606), which the redactor passes through.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { approveDream, dreamOver, renderDream, rulesFrom, rulesOf } from "../src/engine/dreaming.ts";
import { MemoryError, TechnicianMemory } from "../src/engine/memory.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMMITTED = path.join(ROOT, "examples", "memory");
const AT = Date.parse("2026-10-26T12:00:00.000Z");
const TMP: string[] = [];
afterAll(() => TMP.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (prefix: string): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP.push(d);
  return d;
};
const digest = (dir: string): string => createHash("sha256").update(readFileSync(path.join(dir, "state.json"))).update(readFileSync(path.join(dir, "ledger.jsonl"))).digest("hex");
const cli = (script: string, dir: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, ["--import", "tsx", `scripts/${script}.ts`, ...args], { cwd: ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, DRIFT_MEMORY_DIR: dir, NO_COLOR: "1" } });
  return { status: r.status, out: r.stdout.replace(/\r\n/g, "\n"), err: r.stderr.replace(/\r\n/g, "\n") };
};
const prov = { kind: "cli", at: "2026-10-26T08:00:00.000Z", by: "technician" };
const lesson = (key: string, reason = "origin is reached only through the tunnel") =>
  ({ tenantId: "client-a", findingClass: "proxied_without_real_ip" as const, scopeKey: key, reason, expiresAt: "2026-12-31T00:00:00.000Z", provenance: prov });

describe("dreaming over the committed lessons", () => {
  const read = () => new TechnicianMemory({ storage: "read", directory: COMMITTED, clock: () => AT });

  it("proposes an insight and an invariant, each from the 23 lessons in force, says they restate their lessons, and writes nothing", () => {
    const before = digest(COMMITTED);
    const m = read();
    const views = dreamOver(m);
    expect(views.map((v) => v.type)).toEqual(["insight", "invariant"]);
    for (const v of views) {
      expect(v.id).toMatch(/^drm-[0-9a-f]{12}$/);
      expect(v.derivedFrom).toHaveLength(23);
      expect(v.derivedFrom.every((id) => m.lesson(id) !== null)).toBe(true);
      expect(v.restates).toBe(true);
      expect(v.approvedAs).toBeNull();
      expect(v.shared).toEqual({ lessons: 23, tenants: ["client-1"], kinds: [["proxied_without_real_ip", 20], ["orphan_vhost", 3]], scopeKeys: 15, reasons: 1, expiries: ["2026-11-30T00:00:00.000Z"] });
    }
    expect(views[0].content.startsWith("Across 23 related memories (work): Accepted exception for ")).toBe(true);
    expect(views[1].content.startsWith("Stable pattern in work: Accepted exception for ")).toBe(true);
    expect(dreamOver(read()).map((v) => v.id)).toEqual(views.map((v) => v.id));       // the same lessons give the same ids
    expect(m.ledgerEntries().every((e) => e.action === "create")).toBe(true);         // no dream_proposed in the store's ledger
    expect(digest(COMMITTED)).toBe(before);
    // lapsed lessons are no belief to generalise from: past the 30 Nov expiry nothing is in force and nothing is proposed
    expect(dreamOver(new TechnicianMemory({ storage: "read", directory: COMMITTED, clock: () => Date.parse("2026-12-01T00:00:00.000Z") }))).toEqual([]);
  });

  it("npm run dream prints each proposal with its sources, what they share and the reading, and the approval command; the store stays byte for byte", () => {
    const before = digest(COMMITTED);
    const r = cli("dream", COMMITTED, "--at", "2026-10-26T12:00:00Z");
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(r.out).toContain("2 proposal(s) over 23 lesson(s) in force; nothing is written by proposing");
    expect(r.out).toMatch(/drm-[0-9a-f]{12} {2}insight {2}derives from 23 lesson\(s\): mem-1 mem-2 mem-3 mem-4 mem-5 mem-6 … \+17 more/);
    expect(r.out).toMatch(/drm-[0-9a-f]{12} {2}invariant {2}derives from 23 lesson\(s\)/);
    expect(r.out).toContain("they share proxied_without_real_ip x20, orphan_vhost x3; tenant client-1; 15 scope key(s); 1 distinct reason(s); expiry 2026-11-30T00:00:00.000Z");
    expect(r.out).toContain("restates its lessons: the content is their text joined under a header, with no rule of its own");
    expect(r.out).toMatch(/npm run answer -- --approve-dream drm-[0-9a-f]{12} \[--by <role>\]/);
    expect(digest(COMMITTED)).toBe(before);
    expect(cli("dream", COMMITTED, "--at", "next week").status).toBe(2);
  }, 120_000);
});

describe("approving a proposal", () => {
  it("writes one record with derivedFrom lineage in the reference's shape and a dream_approved ledger entry; the Decider's recall is as before; the rule is not dreamed on again", () => {
    const m = new TechnicianMemory({ clock: () => AT });
    const a = m.recordException(lesson("a.example.invalid"));
    const b = m.recordException(lesson("b.example.invalid"));
    const c = m.recordException(lesson("c.example.invalid"));
    const finding = { tenant_id: "client-a", class: "proxied_without_real_ip" as const, host: null, dns_name: "a.example.invalid", refers_to_type: null, refers_to_id: null, resolves_to: null };
    const recallBefore = m.recall(finding).applicable;

    const proposal = dreamOver(m).find((v) => v.type === "invariant")!;
    expect(proposal.derivedFrom.sort()).toEqual([a.id, b.id, c.id]);
    const rule = approveDream(m, proposal.id, "lead technician");
    expect(rule).toMatchObject({ type: "invariant", derivedFrom: expect.arrayContaining([a.id, b.id, c.id]), proposalId: proposal.id, approvedBy: "lead technician", approvedAt: "2026-10-26T12:00:00.000Z" });

    const record = m.hmem.store.get(rule.id)!;
    expect(record).toMatchObject({ type: "preference", layer: "long_term", confidence: 0.75, source: "dreaming", provenance: { origin: "dream" }, derivedFrom: rule.derivedFrom });
    expect(record.tags).toEqual(["dream:invariant", `dream_id:${proposal.id}`, "approved_by:lead technician"]);
    expect(m.history(rule.id).map((e) => e.action)).toEqual(["create", "dream_approved"]);
    expect(m.history(rule.id)[1]).toMatchObject({ actor: "lead technician", details: { proposalId: proposal.id, type: "invariant" } });
    expect(rulesOf(m).map((r) => r.id)).toEqual([rule.id]);
    expect(rulesFrom(m, a.id).map((r) => r.id)).toEqual([rule.id]);
    expect(rulesFrom(m, rule.id)).toEqual([]);

    expect(m.lessons().map((l) => l.id)).toEqual([a.id, b.id, c.id]);               // a rule is no lesson
    expect(m.recall(finding).applicable).toEqual(recallBefore);                       // and decides nothing
    const again = dreamOver(m);
    expect(again.map((v) => v.id)).toEqual(dreamOver(m).map((v) => v.id));
    expect(again.find((v) => v.type === "invariant")).toMatchObject({ id: proposal.id, approvedAs: rule.id, derivedFrom: proposal.derivedFrom });
    expect(renderDream(again, 3).join("\n")).toContain(`(approved as ${rule.id})`);
  });

  it("refuses a stale id, an approved one, a read-only store and an empty role; npm run answer is the writer and the lineage reaches why", () => {
    const m = new TechnicianMemory({ clock: () => AT });
    m.recordException(lesson("a.example.invalid"));
    m.recordException(lesson("b.example.invalid"));
    const proposal = dreamOver(m).find((v) => v.type === "insight")!;
    expect(() => approveDream(m, "drm-000000000000", "technician")).toThrow(/no proposal drm-000000000000 over the lessons as they stand now/);
    expect(() => approveDream(m, proposal.id, "   ")).toThrow(MemoryError);
    m.recordException(lesson("c.example.invalid"));                                    // a lesson arrives: the cluster, and its id, change
    expect(() => approveDream(m, proposal.id, "technician")).toThrow(/run npm run dream again/);
    const current = dreamOver(m).find((v) => v.type === "insight")!;
    approveDream(m, current.id, "technician");
    expect(() => approveDream(m, current.id, "technician")).toThrow(/already approved as mem-\d+/);

    // a store on disk, through the CLI: dream proposes and writes nothing, answer approves, and only answer writes. The lessons
    // expire in 2099 so the commands, which read the clock, give the same answers on any day the test runs.
    const dir = tmp("dream-store-");
    const disk = new TechnicianMemory({ storage: "local", directory: dir, clock: () => AT });
    for (const key of ["a", "b", "c"]) disk.recordException({ ...lesson(`${key}.example.invalid`), expiresAt: "2099-12-31T00:00:00.000Z" });
    const seeded = digest(dir);
    const id = /(drm-[0-9a-f]{12}) {2}insight/.exec(cli("dream", dir).out)![1];
    expect(digest(dir)).toBe(seeded);                                                 // dream wrote nothing
    expect(() => approveDream(new TechnicianMemory({ storage: "read", directory: dir, clock: () => AT }), id, "technician")).toThrow(/open read-only/);
    const approved = cli("answer", dir, "--approve-dream", id, "--by", "lead technician");
    expect(approved.err).toBe("");
    expect(approved.status).toBe(0);
    expect(approved.out).toContain(`approved ${id} as mem-4: insight derived from 3 lesson(s): mem-1 mem-2 mem-3`);
    expect(digest(dir)).not.toBe(seeded);
    const rule = rulesOf(new TechnicianMemory({ storage: "read", directory: dir, clock: () => AT }))[0];
    expect(rule).toMatchObject({ id: "mem-4", type: "insight", proposalId: id, approvedBy: "lead technician" });
    expect(rule.derivedFrom).toEqual(["mem-1", "mem-2", "mem-3"]);
    expect(cli("answer", dir, "--approve-dream", id).err).toContain("already approved as mem-4");
  }, 240_000);
});
