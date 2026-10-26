// npm run dream (scripts/dream.ts, src/engine/dreaming.ts, the vendored DreamingService) and its approval through
// npm run answer -- --approve-dream. The reference clusters the lessons; each cluster becomes rule proposals from what its
// lessons share (tenant, class, reason, expiry): "ADOPT <class> on these scope keys until <expiry>, derived from these
// lessons". Over the committed lessons (examples/memory) that is two rules, 20 lessons on 12 scope keys and 3 on 3. A cluster
// whose lessons share no class, reason and expiry yields no proposal and says why. Proposing writes nothing; approving
// records the rule through the conflict gate with derivedFrom lineage, supersedes its lessons and leaves every decision of the
// sample as it was; only `answer` approves. Scope keys are documentation names (RFC 2606), which the redactor passes through.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { lessonRows, ruleRows } from "../src/data/file-rows.ts";
import { ADOPTION_CHECK_SQL } from "../src/data/files.ts";
import { decisionInstantWith } from "../src/data/instant.ts";
import { objects } from "../src/data/queries.ts";
import { approveDream, dreamOver, renderDream, ruleId, rulesOf } from "../src/engine/dreaming.ts";
import { lineageOf, renderLineage } from "../src/engine/lineage.ts";
import { ConflictError, MemoryError, TechnicianMemory, type FindingScope } from "../src/engine/memory.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { runPass } from "../src/pipeline.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMMITTED = path.join(ROOT, "examples", "memory");
const AT_ISO = "2026-10-26T12:00:00.000Z";
const AT = Date.parse(AT_ISO);
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
const REASON = "origin is reached only through the tunnel";
const EXPIRES = "2026-12-31T00:00:00.000Z";
const lesson = (key: string, over: Partial<{ findingClass: "proxied_without_real_ip" | "orphan_vhost"; reason: string; expiresAt: string }> = {}) =>
  ({ tenantId: "client-a", findingClass: "proxied_without_real_ip" as const, scopeKey: key, reason: REASON, expiresAt: EXPIRES, provenance: prov, ...over });
const finding = (name: string): FindingScope => ({ tenant_id: "client-a", class: "proxied_without_real_ip", host: null, dns_name: name, refers_to_type: null, refers_to_id: null, resolves_to: null });
/** Three lessons that share class, reason and expiry, on three names. */
function threeLessons(m: TechnicianMemory) {
  return ["a", "b", "c"].map((k) => m.recordException(lesson(`${k}.example.invalid`)));
}

describe("dreaming over the committed lessons: rule proposals", () => {
  const read = () => new TechnicianMemory({ storage: "read", directory: COMMITTED, clock: () => AT });

  it("turns the reference's cluster of 23 lessons into two rules from what the lessons share, and writes nothing", () => {
    const before = digest(COMMITTED);
    const m = read();
    const r = dreamOver(m);
    expect(r.lessons).toBe(23);
    expect(r.clusters).toBe(2);                                   // the reference's insight and invariant
    expect(r.withheld).toEqual([]);
    expect(r.relabels).toEqual([]);
    expect(r.approved).toEqual([]);
    expect(r.proposals).toHaveLength(2);
    const [proxied, orphan] = r.proposals;
    expect(proxied).toMatchObject({
      tenantId: "client-1", findingClass: "proxied_without_real_ip", expiresAt: "2026-11-30T00:00:00.000Z", clusters: ["dream-1 insight", "dream-2 invariant"],
      reason: "Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.",
    });
    expect(proxied.id).toMatch(/^drm-[0-9a-f]{12}$/);
    expect(proxied.derivedFrom).toHaveLength(20);
    expect(proxied.scopeKeys).toHaveLength(12);                   // 8 of the 20 lessons repeat a key
    expect(proxied.scopeKeys).toEqual([...proxied.scopeKeys].sort());
    expect(proxied.scopeKeys).toContain("host-f324df.com");
    expect(orphan).toMatchObject({ findingClass: "orphan_vhost", derivedFrom: ["mem-4", "mem-8", "mem-16"], scopeKeys: ["host-085e02.com", "host-89f6e7.com", "host-9ac4f1.com"] });
    // every source states the rule's class, reason and expiry, and the rule covers exactly their keys
    for (const p of r.proposals) {
      const sources = p.derivedFrom.map((id) => m.lesson(id)!);
      expect(sources.every((s) => s.kind === "exception" && s.findingClass === p.findingClass && s.reason === p.reason && s.expiresAt === p.expiresAt)).toBe(true);
      expect(new Set(sources.map((s) => (s.kind === "exception" ? s.scopeKey : "")))).toEqual(new Set(p.scopeKeys));
    }
    expect(dreamOver(read()).proposals.map((p) => p.id)).toEqual(r.proposals.map((p) => p.id));   // the same lessons give the same ids
    expect(m.ledgerEntries().every((e) => e.action === "create")).toBe(true);                      // no dream_proposed in the store's ledger
    expect(digest(COMMITTED)).toBe(before);
    // past the 30 Nov expiry no lesson is in force and nothing is proposed
    const lapsed = dreamOver(new TechnicianMemory({ storage: "read", directory: COMMITTED, clock: () => Date.parse("2026-12-01T00:00:00.000Z") }));
    expect(lapsed.proposals).toEqual([]);
    expect(renderDream(lapsed).join("\n")).toContain("no proposal: no lesson is in force");
  });

  it("npm run dream prints each rule with its derivedFrom ids, what approving changes and the approval command; the store stays byte for byte", () => {
    const before = digest(COMMITTED);
    const r = cli("dream", COMMITTED, "--at", AT_ISO);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toBe("dream: store examples/memory");      // the store as the repository names it, never an absolute path
    expect(lines[1]).toBe("2 rule proposal(s) from 2 cluster(s) of dreaming over 23 lesson(s) in force; nothing is written by proposing");
    expect(r.out).toMatch(/drm-[0-9a-f]{12} {2}ADOPT proxied_without_real_ip on 12 scope\(s\), tenant client-1, until 2026-11-30T00:00:00\.000Z, derived from 20 lesson\(s\)/);
    expect(r.out).toMatch(/drm-[0-9a-f]{12} {2}ADOPT orphan_vhost on 3 scope\(s\), tenant client-1, until 2026-11-30T00:00:00\.000Z, derived from 3 lesson\(s\)/);
    expect(r.out).toContain("reason       Personal estate, known and intentional:");
    expect(r.out).toContain("scopes       host-085e02.com host-89f6e7.com host-9ac4f1.com");
    expect(r.out).toContain("derivedFrom  mem-4 mem-8 mem-16");
    expect(r.out).toMatch(/derivedFrom {2}mem-1 mem-2 mem-3 mem-5 mem-6 mem-7 mem-9 mem-10 mem-11 mem-12 mem-13 mem-14 mem-15 mem-17 mem-18 mem-19 mem-20 mem-21 mem-22 mem-23\n/);
    expect(r.out).toContain("clustered    by the reference's dreaming as dream-1 insight, dream-2 invariant");
    expect(r.out).toContain("approving    supersedes those 20 lesson(s), which stay on record and leave recall, and records this one rule in their place");
    expect(r.out).toContain("decisions    stay the same: the rule states the class, reason and expiry of each of those lessons and covers exactly their 12 scope key(s)");
    expect(r.out).toMatch(/approve {6}npm run answer -- --approve-dream drm-[0-9a-f]{12} \[--by <role>\]/);
    expect(r.out).not.toContain("restates");
    expect(digest(COMMITTED)).toBe(before);
    expect(cli("dream", COMMITTED, "--at", "next week").status).toBe(2);
  }, 120_000);
});

describe("a cluster with no shared class, reason or expiry", () => {
  it("yields no proposal and the result says why; a partial cluster yields the rule and names what it leaves out", () => {
    const m = new TechnicianMemory({ clock: () => AT });
    m.recordException(lesson("a.example.invalid"));
    m.recordException(lesson("b.example.invalid", { findingClass: "orphan_vhost", reason: "left over from the migration" }));
    m.recordException(lesson("c.example.invalid", { expiresAt: "2027-01-31T00:00:00.000Z" }));
    const none = dreamOver(m);
    expect(none.clusters).toBeGreaterThan(0);                     // the reference clusters them: they read alike
    expect(none.proposals).toEqual([]);
    expect(none.withheld).toHaveLength(1);
    expect(none.withheld[0]).toMatchObject({ lessons: ["mem-1", "mem-2", "mem-3"] });
    expect(none.withheld[0].why).toBe("3 exception lesson(s) share no class, reason and expiry with another lesson of the cluster (2 class(es), 2 reason(s), 2 expiry(ies) among them)");
    const text = renderDream(none).join("\n");
    expect(text).toContain("0 rule proposal(s)");
    expect(text).toContain("no rule for 3 lesson(s) of dream-1 insight");
    expect(text).toContain("why          3 exception lesson(s) share no class, reason and expiry with another lesson of the cluster");

    m.recordException(lesson("d.example.invalid"));               // a partner for a.example.invalid
    const some = dreamOver(m);
    expect(some.proposals).toHaveLength(1);
    expect(some.proposals[0]).toMatchObject({ derivedFrom: ["mem-1", "mem-4"], scopeKeys: ["a.example.invalid", "d.example.invalid"] });
    expect(some.withheld.flatMap((w) => w.lessons).sort()).toEqual(["mem-2", "mem-3"]);
    expect(some.withheld.every((w) => w.why.startsWith("2 exception lesson(s) share no class, reason and expiry"))).toBe(true);

    const answers = new TechnicianMemory({ clock: () => AT });
    answers.recordAnswer({ tenantId: "client-a", question: "Is the origin behind the tunnel?", answer: "Yes", scope: { type: "name", key: "a.example.invalid" }, expiresAt: EXPIRES, provenance: prov });
    answers.recordAnswer({ tenantId: "client-a", question: "Is the origin behind the tunnel?", answer: "Yes", scope: { type: "name", key: "b.example.invalid" }, expiresAt: EXPIRES, provenance: prov });
    const a = dreamOver(answers);
    expect(a.proposals).toEqual([]);
    expect(a.withheld[0].why).toBe("2 answer lesson(s) carry no class, so no rule covers them");
    expect(dreamOver(new TechnicianMemory({ clock: () => AT })).proposals).toEqual([]);
    expect(renderDream(dreamOver(new TechnicianMemory({ clock: () => AT }))).join("\n")).toContain("no proposal: no lesson is in force");
    expect(() => approveDream(m, "drm-000000000000", "technician")).toThrow(/no rule proposal drm-000000000000 over the lessons as they stand now/);
  });
});

describe("approving a rule proposal", () => {
  it("records one exception over the scope keys with derivedFrom lineage, supersedes its lessons, and the Decider recalls the rule where it recalled them", () => {
    const m = new TechnicianMemory({ clock: () => AT, gate: true });
    const [a, b, c] = threeLessons(m);
    const before = [a, b, c].map((l) => m.recall(finding(l.scopeKey)).applicable[0]);
    const proposal = dreamOver(m).proposals[0];
    expect(proposal.derivedFrom).toEqual([a.id, b.id, c.id]);
    const rule = approveDream(m, proposal.id, "lead technician");
    expect(rule).toMatchObject({
      kind: "exception", findingClass: "proxied_without_real_ip", tenantId: "client-a", reason: REASON, expiresAt: EXPIRES, scopeKey: "a.example.invalid",
      scopeKeys: ["a.example.invalid", "b.example.invalid", "c.example.invalid"], derivedFrom: [a.id, b.id, c.id], proposalId: proposal.id,
      provenance: { kind: "dream", by: "lead technician", at: AT_ISO }, recordedAt: AT_ISO,
    });
    const record = m.hmem.store.get(rule.id)!;
    expect(record).toMatchObject({ type: "preference", layer: "long_term", confidence: 0.75, source: "dreaming", provenance: { origin: "dream" }, derivedFrom: [a.id, b.id, c.id] });
    expect(m.history(rule.id).map((e) => e.action)).toEqual(["create", "dream_approved"]);
    expect(m.history(rule.id)[1]).toMatchObject({ actor: "lead technician", details: { proposalId: proposal.id, derivedFrom: [a.id, b.id, c.id] } });
    // the lessons are kept and covered; the ledger says so for each
    for (const s of [a, b, c]) {
      expect(m.lesson(s.id)?.supersededBy).toBe(rule.id);
      const written = m.history(s.id).filter((e) => e.action !== "read");           // recall logs its reads in the same ledger
      expect(written.map((e) => e.action)).toEqual(["create", "update"]);
      expect(written[1]).toMatchObject({ actor: "lead technician", details: { supersededBy: rule.id, proposalId: proposal.id }, newState: { supersededBy: rule.id } });
    }
    // recall: the rule, with the key the finding matched, the same class, reason and expiry as the lesson it replaces
    for (const [i, l] of [a, b, c].entries()) {
      const hit = m.recall(finding(l.scopeKey)).applicable;
      expect(hit).toHaveLength(1);
      expect(hit[0]).toMatchObject({ id: rule.id, scopeKey: l.scopeKey, findingClass: before[i].kind === "exception" ? before[i].findingClass : "", expiresAt: l.expiresAt, reason: l.reason });
      expect(m.recall(finding(l.scopeKey), "2027-01-01T00:00:00.000Z").expired.map((x) => x.id)).toEqual([rule.id]);   // and it lapses with them
    }
    expect(m.recall({ ...finding("a.example.invalid"), class: "orphan_vhost" }).applicable).toEqual([]);
    expect(m.recall(finding("d.example.invalid")).applicable).toEqual([]);
    // a rule is no belief to dream from: the proposals are gone and the rule is listed as approved
    const after = dreamOver(m);
    expect(after.proposals).toEqual([]);
    expect(after.approved.map((r) => r.id)).toEqual([rule.id]);
    expect(renderDream(after).join("\n")).toContain(`1 rule(s) approved and in force:\n  ${rule.id}  ADOPT proxied_without_real_ip on 3 scope(s), until ${EXPIRES}, derived from 3 lesson(s)`);
    expect(rulesOf(m).map((r) => r.id)).toEqual([rule.id]);
    expect(() => approveDream(m, proposal.id, "technician")).toThrow(`proposal ${proposal.id} is already approved as ${rule.id}`);
    // withdrawing the rule stands its lessons up again
    m.forget(rule.id, "approved by mistake");
    expect(m.recall(finding("b.example.invalid")).applicable.map((l) => l.id)).toEqual([b.id]);
    expect(dreamOver(m).proposals).toHaveLength(1);
  });

  it("goes through the conflict gate: a lesson outside the sources that contradicts the rule refuses it, naming both, until the technician settles it", () => {
    const clash = new TechnicianMemory({ clock: () => AT, gate: true });
    threeLessons(clash);
    // a lesson on the first source's key with another expiry, recorded with keep_both beside that source: it is no source of the rule
    const late = clash.recordException({ ...lesson("a.example.invalid", { expiresAt: "2027-01-31T00:00:00.000Z", reason: "extended through the winter" }), resolutions: [{ with: "mem-1", strategy: "keep_both" }] });
    const proposal = dreamOver(clash).proposals[0];
    expect(proposal.derivedFrom).toEqual(["mem-1", "mem-2", "mem-3"]);            // the late lesson shares no expiry with them
    let refusal: unknown;
    try {
      approveDream(clash, proposal.id, "technician");
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toBeInstanceOf(ConflictError);
    expect((refusal as ConflictError).conflicts.map((c) => c.with.id)).toEqual([late.id]);
    expect((refusal as ConflictError).message).toContain("rule for proxied_without_real_ip on a.example.invalid b.example.invalid c.example.invalid");
    expect(clash.lessons().every((l) => !l.supersededBy)).toBe(true);             // nothing was written
    expect(rulesOf(clash)).toEqual([]);
    const rule = approveDream(clash, proposal.id, "technician", [{ with: late.id, strategy: "supersede" }]);
    expect(clash.lesson(late.id)?.supersededBy).toBe(rule.id);
    expect(clash.lessons().filter((l) => l.supersededBy === rule.id).map((l) => l.id)).toEqual(["mem-1", "mem-2", "mem-3", late.id]);
    expect(clash.ledgerEntries().some((e) => e.action === "conflict_resolved" && e.memoryId === late.id)).toBe(true);
  });

  it("refuses a stale id, an approved one, a read-only store, an empty role, and a rule its lessons do not state", () => {
    const m = new TechnicianMemory({ clock: () => AT, gate: true });
    m.recordException(lesson("a.example.invalid"));
    m.recordException(lesson("b.example.invalid"));
    const proposal = dreamOver(m).proposals[0];
    expect(() => approveDream(m, proposal.id, "   ")).toThrow(MemoryError);
    m.recordException(lesson("c.example.invalid"));                               // a lesson arrives: the proposal, and its id, change
    expect(() => approveDream(m, proposal.id, "technician")).toThrow(/run npm run dream again/);
    const current = dreamOver(m).proposals[0];
    expect(current.id).not.toBe(proposal.id);
    expect(() => approveDream(new TechnicianMemory({ clock: () => AT }), current.id, "technician")).toThrow(/no rule proposal/);
    const base = { tenantId: "client-a", findingClass: "proxied_without_real_ip" as const, reason: REASON, expiresAt: EXPIRES, provenance: { kind: "dream", at: AT_ISO, by: "technician" }, proposalId: current.id };
    expect(() => m.recordRule({ ...base, scopeKeys: ["a.example.invalid", "b.example.invalid", "c.example.invalid"], derivedFrom: ["mem-1", "mem-2", "mem-3"], expiresAt: "2027-01-31T00:00:00.000Z" })).toThrow(/mem-1 is not an exception in force/);
    expect(() => m.recordRule({ ...base, scopeKeys: ["a.example.invalid", "b.example.invalid"], derivedFrom: ["mem-1", "mem-2", "mem-3"] })).toThrow(/mem-3 is not an exception in force/);
    expect(() => m.recordRule({ ...base, scopeKeys: ["a.example.invalid", "b.example.invalid", "x.example.invalid"], derivedFrom: ["mem-1", "mem-2"] })).toThrow(/not exactly the keys/);
    expect(() => m.recordRule({ ...base, scopeKeys: ["a.example.invalid"], derivedFrom: ["mem-1", "mem-1"] })).toThrow(/at least two lessons/);
    expect(() => m.recordRule({ ...base, scopeKeys: ["a.example.invalid", "b.example.invalid"], derivedFrom: ["mem-1", "mem-2"], proposalId: "dream-1" })).toThrow(/proposalId/);
    // the lesson table packs a rule's keys into one space-separated column: a key with whitespace never reaches it
    expect(() => m.recordRule({ ...base, scopeKeys: ["a.example.invalid", "b example"], derivedFrom: ["mem-1", "mem-2"] })).toThrow(/one token with no whitespace/);
    expect(m.lessons().every((l) => !l.supersededBy)).toBe(true);
    expect(rulesOf(m)).toEqual([]);
  });
});

describe("approval through npm run answer, and why on the findings the rule covers", () => {
  it("npm run answer is the writer: it approves by id, refuses a repeat, lists the rule and the superseded lessons; dream then lists the rule as approved", () => {
    // lessons that expire in 2099, so the commands, which read the clock, answer the same on any day the test runs
    const dir = tmp("dream-store-");
    const disk = new TechnicianMemory({ storage: "local", directory: dir, clock: () => AT });
    for (const k of ["a", "b", "c"]) disk.recordException(lesson(`${k}.example.invalid`, { expiresAt: "2099-12-31T00:00:00.000Z" }));
    const seeded = digest(dir);
    const id = /(drm-[0-9a-f]{12}) {2}ADOPT proxied_without_real_ip on 3 scope\(s\)/.exec(cli("dream", dir).out)![1];
    expect(digest(dir)).toBe(seeded);                                              // dream wrote nothing
    expect(() => approveDream(new TechnicianMemory({ storage: "read", directory: dir, clock: () => AT }), id, "technician")).toThrow(/open read-only/);

    const approved = cli("answer", dir, "--approve-dream", id, "--by", "lead technician");
    expect(approved.err).toBe("");
    expect(approved.status).toBe(0);
    expect(approved.out).toContain(`approved ${id} as mem-4: ADOPT proxied_without_real_ip on 3 scope(s), tenant client-a, until 2099-12-31T00:00:00.000Z, derived from 3 lesson(s): mem-1 mem-2 mem-3`);
    expect(approved.out).toContain("superseded 3 lesson(s): kept on record and no longer recalled; the rule decides the same findings the same way");
    expect(digest(dir)).not.toBe(seeded);
    const again = cli("answer", dir, "--approve-dream", id);
    expect(again.status).toBe(1);
    expect(again.err).toContain(`already approved as mem-4`);

    const list = cli("answer", dir, "--list").out;
    expect(list).toContain("mem-4  rule       proxied_without_real_ip on 3 scope key(s) (client-a)  until 2099-12-31T00:00:00.000Z  by lead technician");
    expect(list).toContain("derived from 3 lesson(s)");
    expect(list).toMatch(/mem-1 {2}exception .*superseded by mem-4/);
    const after = cli("dream", dir).out;
    expect(after).toContain("0 rule proposal(s) from 0 cluster(s) of dreaming over 0 lesson(s) in force");
    expect(after).toMatch(/1 rule\(s\) approved and in force:\n {2}mem-4 {2}ADOPT proxied_without_real_ip on 3 scope\(s\), until 2099-12-31T00:00:00.000Z, derived from 3 lesson\(s\), approved by lead technician/);
    expect(after).not.toContain("npm run answer -- --approve-dream");
  }, 240_000);

  it("leaves every decision of the sample as it was: the same verbs, the same expiries, the rule recalled where the lessons were, exception_in_force still holding; why says covered by rule", async () => {
    const bundle = JSON.parse(readFileSync(path.join(ROOT, "sample", "bundle.json"), "utf8"));
    async function decide(memory: TechnicianMemory) {
      const engine = await SqlJsEngine.create();
      engine.loadBundle(bundle);
      engine.loadFileTables({ lesson: lessonRows(memory), rule: ruleRows() });
      const decidedAt = new Date(decisionInstantWith(bundle, memory.lessons().map((l) => l.recordedAt))!).toISOString();
      const layer = new DataLayer(engine);
      const pass = await runPass(layer, { world: new DriftWorld("dream-test"), memory, at: AT_ISO, ledger: new MemoryLedger(engine), decidedAt });
      const adoption = objects(await layer.run(ADOPTION_CHECK_SQL, { decided_at: decidedAt }, { limit: 10 }))[0];
      engine.close();
      return { pass, adoption };
    }
    const dir = tmp("dream-sample-");
    cpSync(COMMITTED, dir, { recursive: true });
    const untouched = digest(COMMITTED);
    const first = await decide(new TechnicianMemory({ storage: "read", directory: COMMITTED, clock: () => AT }));
    expect(first.pass.verbs).toMatchObject({ ADOPT: 23, HOLD: 3, ESCALATE: 1 });

    const writer = new TechnicianMemory({ storage: "local", directory: dir, clock: () => AT, gate: true });
    const rules = dreamOver(writer).proposals.map((p) => approveDream(writer, p.id, "technician"));
    expect(rules.map((r) => [r.scopeKeys.length, r.derivedFrom.length])).toEqual([[12, 20], [3, 3]]);
    expect(writer.lessons().filter((l) => l.supersededBy)).toHaveLength(23);

    const read = new TechnicianMemory({ storage: "read", directory: dir, clock: () => AT });
    const second = await decide(read);
    expect(second.pass.findings.map((f) => f.id)).toEqual(first.pass.findings.map((f) => f.id));
    expect(second.pass.findings.map((f) => f.verb)).toEqual(first.pass.findings.map((f) => f.verb));
    expect(second.pass.verbs).toEqual(first.pass.verbs);
    const adopted = (p: typeof first.pass) => p.findings.filter((f) => f.verb === "ADOPT");
    expect(adopted(second.pass).map((f) => f.disposition.expires_at)).toEqual(adopted(first.pass).map((f) => f.disposition.expires_at));
    expect(adopted(second.pass).every((f) => f.disposition.decided_by === "operator" && rules.some((r) => r.id === f.exception?.lesson))).toBe(true);
    expect(second.pass.memory).toMatchObject({ applied: 23, lapsed: 0 });
    expect(Number(second.adoption.adoptions)).toBe(23);
    expect(Number(second.adoption.in_force)).toBe(23);                              // the rule rows keep the DQ rule exception_in_force true

    const found = second.pass.findings.find((f) => f.id === "fnd-de3c5e8ebdc2d209")!;   // host-f324df.com, taught twice (mem-1 and mem-21)
    const proxiedRule = rules.find((r) => r.findingClass === "proxied_without_real_ip")!;
    const lineage = lineageOf(read, found);
    expect(lineage.lesson?.rule).toMatchObject({ id: proxiedRule.id, derivedFrom: proxiedRule.derivedFrom });
    expect(lineage.lesson?.taught.map((t) => t.lesson.id)).toEqual(["mem-1", "mem-21"]);
    const text = renderLineage(lineage).join("\n");
    expect(text).toContain(`covered by  rule ${proxiedRule.id}, derived from 20 lessons: ADOPT proxied_without_real_ip on 12 scope(s), in force until 2026-11-30T00:00:00.000Z`);
    expect(text).toContain("mem-1: \"Personal estate, known and intentional:");
    expect(text).toContain("mem-21: \"Personal estate, known and intentional:");
    expect(text).toContain("superseded by " + proxiedRule.id);
    expect(text).toContain(`dream_approved proposal ${proxiedRule.proposalId}, derived from 20 lesson(s)  by technician`);
    expect(digest(COMMITTED)).toBe(untouched);
  }, 240_000);

  it("a proposal id does not depend on the order its keys and sources arrive in", () => {
    const m = new TechnicianMemory({ clock: () => AT });
    threeLessons(m);
    const { id, clusters: _clusters, ...fields } = dreamOver(m).proposals[0];
    expect(ruleId({ ...fields, scopeKeys: [...fields.scopeKeys].reverse(), derivedFrom: [...fields.derivedFrom].reverse() })).toBe(id);
    expect(ruleId({ ...fields, reason: "another reason" })).not.toBe(id);
  });

  it("an id from before another writer's lesson is refused by the command and leaves the store untouched; the id dream prints next is approved", () => {
    const dir = tmp("dream-race-");
    const first = new TechnicianMemory({ storage: "local", directory: dir, clock: () => AT });
    for (const k of ["a", "b", "c"]) first.recordException(lesson(`${k}.example.invalid`, { expiresAt: "2099-12-31T00:00:00.000Z" }));
    const stale = /(drm-[0-9a-f]{12}) {2}ADOPT/.exec(cli("dream", dir).out);
    expect(stale, "dream prints a proposal id").not.toBeNull();
    // another command teaches a fourth lesson that shares the rule's class, reason and expiry, between `dream` and `--approve-dream`
    new TechnicianMemory({ storage: "local", directory: dir, clock: () => AT }).recordException(lesson("d.example.invalid", { expiresAt: "2099-12-31T00:00:00.000Z" }));
    const written = digest(dir);
    const refused = cli("answer", dir, "--approve-dream", stale![1]);
    expect(refused.status).toBe(1);
    expect(refused.err.trim().split("\n")).toHaveLength(1);
    expect(refused.err).toContain(`no rule proposal ${stale![1]} over the lessons as they stand now; run npm run dream again`);
    expect(digest(dir)).toBe(written);
    const current = /(drm-[0-9a-f]{12}) {2}ADOPT proxied_without_real_ip on 4 scope\(s\)/.exec(cli("dream", dir).out);
    expect(current, "dream prints the proposal over four lessons").not.toBeNull();
    expect(current![1]).not.toBe(stale![1]);
    const approved = cli("answer", dir, "--approve-dream", current![1]);
    expect([approved.status, approved.err]).toEqual([0, ""]);
    expect(approved.out).toContain("derived from 4 lesson(s): mem-1 mem-2 mem-3 mem-4");
  }, 240_000);
});
