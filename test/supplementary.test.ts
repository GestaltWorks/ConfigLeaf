// The supplementary set (eval/supplementary/, declared post hoc on 26 Oct 2026): its items and labels parse; every item's
// finding is in the supplementary bundle (its run, the live pass's disposition under the item's finding id at the
// cycle's instant, and the observation or DNS record of its object in that run); the slice at a cycle's instant holds the
// item's run and none of the ledger rows decided at or after it; and the new --set supplementary path leaves the
// pre-registered runner as it was: the option parser answers null for every other --set, scripts/eval.ts outside its
// marked supplementary block is byte for byte the file committed at 40751d8, and src/eval/run.ts is unchanged.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { groups, loadSupplementary, sliceAt, SUPPLEMENTARY, supplementaryArgs, type SupplementarySet } from "../src/eval/supplementary.ts";

type Row = Record<string, unknown>;
const sha256 = (s: string): string => createHash("sha256").update(s.replace(/\r\n/g, "\n"), "utf8").digest("hex");

/** sha256 of scripts/eval.ts and src/eval/run.ts as committed at 40751d8 (git show 40751d8:<path> | sha256sum). */
const EVAL_TS_40751D8 = "786f764bfa4244b9b5e4f9d666ef56292b67af8c080c684bd6d8a5f8be82481f";
const RUN_TS_40751D8 = "4e8e28c37893c84eda7b20bb6ae6414eeea57da16c37d1b1286e6971fa2f1868";

let set: SupplementarySet;
let bundle: Record<string, Row[]>;

beforeAll(() => {
  set = loadSupplementary();
  bundle = JSON.parse(readFileSync(SUPPLEMENTARY.bundle, "utf8")) as Record<string, Row[]>;
});

describe("supplementary items and labels", () => {
  it("parse, every label names an item, and every item is labelled", () => {
    expect(set.items.length).toBeGreaterThanOrEqual(4);
    expect(set.labels.map((l) => l.id).sort()).toEqual(set.items.map((i) => i.id).sort());
  });

  it("label each item by the protocol's verb reading of the live pass's verb (ESCALATE, FIX yes; ADOPT, HOLD, ROLLBACK no)", () => {
    for (const item of set.items) {
      const verb = item.agent_says.split(":")[0];
      const label = set.labels.find((l) => l.id === item.id)!;
      expect(label.needs_human, item.id).toBe(["ESCALATE", "FIX"].includes(verb) ? "yes" : "no");
      expect(label.reason, item.id).toContain(`${verb} at ${item.cycle.decided_at}`);
    }
  });
});

describe("supplementary bundle", () => {
  it("holds every item's run, the live pass's disposition and the object's rows in that run", () => {
    const runs = new Map(bundle.collection_run.map((r) => [r.run_id, r]));
    for (const item of set.items) {
      const run = runs.get(item.refs.run_id);
      expect(run, `${item.id} run`).toBeDefined();
      expect(run!.tenant_id).toBe(item.cycle.tenant_id);
      const d = bundle.disposition.find((x) => x.disposition_id === item.refs.disposition_id);
      expect(d, `${item.id} disposition`).toBeDefined();
      expect(d!.finding_id).toBe(item.refs.finding_id);
      expect(d!.decided_at).toBe(item.cycle.decided_at);
      expect(d!.verb).toBe(item.agent_says.split(":")[0]);
      const objectRows = [
        ...bundle.observation.filter((o) => o.run_id === item.refs.run_id && o.object_id === item.refs.object_id),
        ...bundle.dns_record.filter((r) => r.run_id === item.refs.run_id && r.record_id === item.refs.object_id),
      ];
      expect(objectRows.length, `${item.id} object rows`).toBeGreaterThan(0);
    }
  });

  it("slices each cycle with its runs and without the ledger rows decided at or after the instant", () => {
    for (const g of groups(set)) {
      const s = sliceAt(bundle, g.tenant, g.at) as Record<string, Row[]>;
      for (const item of g.items) expect(s.collection_run.some((r) => r.run_id === item.refs.run_id), item.id).toBe(true);
      expect(s.disposition.every((d) => (d.decided_at as string) < g.at)).toBe(true);
      expect(s.disposition.some((d) => g.items.some((i) => i.refs.disposition_id === d.disposition_id))).toBe(false);
      expect(s.collection_run.every((r) => r.tenant_id === g.tenant && (r.started_at as string) <= g.at)).toBe(true);
    }
  });
});

describe("the pre-registered runner is unchanged", () => {
  it("parses no supplementary options for --set dev, heldout, all or none", () => {
    for (const argv of [
      ["node", "scripts/eval.ts", "--set", "dev", "--runs", "3"],
      ["node", "scripts/eval.ts", "--set", "heldout", "--runs", "3"],
      ["node", "scripts/eval.ts", "--set", "all", "--items", "E01,E02"],
      ["node", "scripts/eval.ts", "--runs", "1", "--configs", "C0"],
    ]) expect(supplementaryArgs(argv)).toBeNull();
  });

  it("parses --set supplementary with the set's own files by default and refuses an id list for --items", () => {
    expect(supplementaryArgs(["--set", "supplementary", "--runs", "3"])).toEqual({
      items: SUPPLEMENTARY.items, labels: SUPPLEMENTARY.labels, bundle: SUPPLEMENTARY.bundle, out: undefined, configs: undefined, runs: 3,
    });
    expect(() => supplementaryArgs(["--set", "supplementary", "--items", "S01,S02"])).toThrow(/names a \.json file/);
  });

  it("keeps scripts/eval.ts outside its supplementary block byte for byte as committed at 40751d8", () => {
    const text = readFileSync("scripts/eval.ts", "utf8").replace(/\r\n/g, "\n");
    const block = /^\/\/ supplementary:begin[\s\S]*?^\/\/ supplementary:end\n/m;
    expect(text).toMatch(block);
    expect(sha256(text.replace(block, ""))).toBe(EVAL_TS_40751D8);
  });

  it("keeps src/eval/run.ts as committed at 40751d8", () => {
    expect(sha256(readFileSync("src/eval/run.ts", "utf8"))).toBe(RUN_TS_40751D8);
  });
});
