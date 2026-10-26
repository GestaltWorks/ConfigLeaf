// A verdict applyVerdict refuses (src/agents/falsifier.ts: a mapping that would loosen a decision throws) fails the whole pass
// loudly and records nothing partial, and the pass command prints it as one plain line. C3's mapping never loosens a decision,
// so the refusal cannot be reached through it; judgeFinding is replaced here by one that throws the invariant's error, as
// applyVerdict would on such a mapping.
import { describe, expect, it, vi } from "vitest";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { objects } from "../src/data/queries.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { PLAIN, Table } from "../src/loop/present.ts";
import { runPass } from "../src/pipeline.ts";
import authored from "./fixtures/authored-bundle.json" with { type: "json" };
import { MemTracer } from "./fixtures/mem-tracer.ts";

const REFUSED = "judge invariant: a struck verdict would change ESCALATE by default to ADOPT by default; a verdict never loosens a decision";

vi.mock("../src/agents/falsifier.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/agents/falsifier.ts")>();
  return { ...real, judgeFinding: async () => { throw new Error(REFUSED); } };
});

describe("a verdict applyVerdict refuses", () => {
  it("fails the pass with nothing partial persisted, and the pass command prints one plain line", async () => {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(authored);
    const rows = async () => objects(await new DataLayer(engine).run("SELECT * FROM {{t:disposition}}", {}, { limit: 100_000 }));
    const before = await rows();
    const tracer = new MemTracer("test_invariant", {});
    const judge = { nightshift: { chatWithFallback: async () => { throw new Error("no call expected"); } }, receipts: { find: async () => null } };
    const error = await runPass(new DataLayer(engine), { tracer, world: new DriftWorld("test_invariant"), ledger: new MemoryLedger(engine), decidedAt: "2026-10-23T03:00:00.000Z", judge })
      .then(() => null, (e: Error) => e);
    // loudly: the pass rejects with the refusal, nothing absorbs it
    expect(error?.message).toBe(REFUSED);
    // nothing partial: the dispositions go to the ledger after every step, so none of this pass's is there, and no pass summary
    expect(await rows()).toEqual(before);
    expect(tracer.events.some((e) => e.input_summary === "policy")).toBe(false);
    engine.close();
    // what scripts/pass.ts prints for it: the failed row, one line with the message and no stack frame; --quiet, "pass: <message>"
    const failed = new Table(PLAIN).failed("pass", error!.message, 1200);
    expect(failed.split("\n")).toHaveLength(1);
    expect(failed).toContain("judge invariant: a struck verdict would change ESCALATE");
    expect(failed).not.toMatch(/\bat \S+:\d+/);
    expect(`pass: ${error!.message}`.split("\n")).toHaveLength(1);
  });
});
