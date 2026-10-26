// npm run sleep -- --preview (scripts/sleep.ts, src/engine/sleep-preview.ts, the vendored SleepCycleService): the plan a sleep
// cycle makes over the technician's lessons, and nothing changed. Over the committed store (examples/memory) it plans one
// synthesis of all 23 lessons, which the reference's own execute() on a scratch copy turns into one readable lesson;
// over a small store it plans the archive of an old, unread, unreferenced lesson and lists the lapsed. Scope keys are
// documentation names (RFC 2606), which the redactor passes through.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DAY_MS, TechnicianMemory } from "../src/engine/memory.ts";
import { previewSleep, renderSleep } from "../src/engine/sleep-preview.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMMITTED = path.join(ROOT, "examples", "memory");
const digest = (dir: string): string => createHash("sha256").update(readFileSync(path.join(dir, "state.json"))).update(readFileSync(path.join(dir, "ledger.jsonl"))).digest("hex");
const T0 = Date.parse("2026-10-24T12:00:00.000Z");
const prov = { kind: "cli", at: "2026-10-24T11:59:00.000Z", by: "technician", runId: "run-nginx-7f1c-1023" };

function sleep(...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/sleep.ts", ...args], { cwd: ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, DRIFT_MEMORY_DIR: COMMITTED, NO_COLOR: "1" } });
  return { status: r.status, out: r.stdout.replace(/\r\n/g, "\n"), err: r.stderr.replace(/\r\n/g, "\n") };
}

describe("npm run sleep -- --preview", () => {
  it("lists what a cycle would do to the committed lessons and what that does to the Decider's coverage, and changes nothing; without --preview it refuses", () => {
    const before = digest(COMMITTED);
    const r = sleep("--preview", "--at", "2026-10-26T12:00:00Z");
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(r.out.split("\n")[0]).toBe("sleep: store examples/memory");      // the store as the repository names it, never an absolute path
    expect(r.out).toContain("sleep preview at 2026-10-26T12:00:00.000Z: 23 record(s), 23 lesson(s); nothing is changed");
    expect(r.out).toContain("consolidate 0");
    expect(r.out).toContain("archive     0");
    expect(r.out).toContain("synthesize  1");
    expect(r.out).toContain("23 records: mem-1 mem-10 mem-11");
    expect(r.out).toContain("made of exception proxied_without_real_ip x20, exception orphan_vhost x3");
    expect(r.out).toContain("lapsed      0");
    expect(r.out).toContain("23 lesson(s) readable before, 1 after; 14 scope key(s) no longer covered");
    expect(digest(COMMITTED)).toBe(before);

    // looking ahead past the 30 Nov expiry lists the lessons as lapsed; the plan is the same and the store is still untouched
    const ahead = sleep("--preview", "--at", "2026-12-31T00:00:00Z");
    expect(ahead.out).toContain("lapsed      23");
    expect(digest(COMMITTED)).toBe(before);

    const bare = sleep();
    expect(bare.status).toBe(2);
    expect(bare.err).toContain("previews and changes nothing; --preview is required");
    expect(sleep("--preview", "--at", "yesterday").status).toBe(2);
  }, 240_000);

  it("plans the archive of an old, unread, unreferenced lesson at the clock it is asked at, lists the lapsed, and changes nothing on the store", () => {
    let now = T0;
    const m = new TechnicianMemory({ clock: () => now });
    const lone = m.recordException({ tenantId: "client-a", findingClass: "orphan_vhost", scopeKey: "old.example.invalid", reason: "left over from the migration", expiresAt: "2026-11-15T00:00:00.000Z", provenance: prov });
    const fresh = previewSleep(m);
    expect(fresh.archive).toEqual([]);                       // a day old; the reference archives from 30 days
    expect(fresh.ifExecuted).toBeNull();                     // an empty plan has no effect to show
    expect(renderSleep(fresh).join("\n")).toContain("the plan is empty: a sleep cycle changes nothing today");

    now = T0 + 40 * DAY_MS;
    const records = m.hmem.store.snapshotAll();
    const entries = m.ledgerEntries().length;
    const later = previewSleep(m);
    expect(later.archive).toEqual([{ id: lone.id, what: "exception orphan_vhost on old.example.invalid (client-a)" }]);
    expect(later.lapsed.map((l) => l.id)).toEqual([lone.id]);                   // expired 15 Nov
    expect(later.ifExecuted).toEqual({ lessonsBefore: 1, lessonsAfter: 0, scopeKeysLost: ["client-a orphan_vhost old.example.invalid"] });
    const text = renderSleep(later).join("\n");
    expect(text).toContain(`archive     1`);
    expect(text).toContain(`${lone.id} exception orphan_vhost on old.example.invalid (client-a)`);
    expect(text).toContain(`lapsed      1`);
    expect(m.hmem.store.snapshotAll()).toEqual(records);       // the store is as it was, and so is the ledger
    expect(m.ledgerEntries()).toHaveLength(entries);
    expect(m.lessons()).toHaveLength(1);
  });
});
