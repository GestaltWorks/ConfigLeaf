// The README's eval table (src/eval/table.ts evalTable, printed by scripts/eval-table.ts) over the committed
// development results eval/results/2026-10-25T09-25-44Z: the counts it reads off the run files and planted.json, the
// facts the README's two sentences under the table state, and each README block under "## Evaluation" whose heading
// names a results directory, which begins with the script's output for that directory byte for byte.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evalTable, HEAD, readPlanted, readRuns, thousands } from "../src/eval/table.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEV = "eval/results/2026-10-25T09-25-44Z";
const at = (p: string): string => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = (p: string): string => readFileSync(at(p), "utf8").replace(/\r\n/g, "\n");

/** The table's rows by configuration id, each cell keyed by its column heading. */
function rowsOf(out: string): Map<string, Record<string, string>> {
  const lines = out.split("\n").filter((l) => l.startsWith("| C"));
  return new Map(lines.map((l) => {
    const cells = l.slice(2, -2).split(" | ");
    return [cells[0], Object.fromEntries(HEAD.map((h, i) => [h, cells[i]]))];
  }));
}

describe("the eval table over the committed development results", () => {
  const out = evalTable(at(DEV));
  const rows = rowsOf(out);
  const col = (id: string, h: (typeof HEAD)[number]): string => rows.get(id)![h];

  it("one row per configuration, C0 to C4, and no rank column", () => {
    expect([...rows.keys()]).toEqual(["C0", "C1", "C2", "C3", "C4"]);
    expect(HEAD.join(" ")).not.toMatch(/rank|best/i);
  });

  it("C0 to C3 read none of the 9 items labelled no as yes; C4 reads 6 of 9 as yes in every run", () => {
    for (const id of ["C0", "C1", "C2", "C3"]) expect(col(id, "labelled no, read yes"), id).toBe("0/9");
    expect(col("C4", "labelled no, read yes")).toBe("6/9");
    expect(col("C0", "agree / judged")).toBe("9/9");
    expect(col("C1", "agree / judged")).toBe("8/8, 8/8, 9/9");
    expect(col("C4", "agree / judged")).toBe("3/9");
  });

  it("the planted false claims: Lightning strikes 9, 9 and 8 of 10, Ultra 9 of 10 in every run", () => {
    expect(col("C2", "planted claims struck")).toBe("9/10, 9/10, 8/10");
    expect(col("C3", "planted claims struck")).toBe("9/10");
    for (const id of ["C0", "C1", "C4"]) expect(col(id, "planted claims struck"), id).toBe("-");
  });

  it("Lightning's valid checks over checks selected, and the items not judged per run", () => {
    expect(col("C1", "checks valid / selected")).toBe("58/63, 59/63, 76/77");
    expect(col("C0", "checks valid / selected")).toBe("-");
    expect(col("C1", "items not judged")).toBe("3, 3, 0");
    expect(col("C2", "items not judged")).toBe("6, 2, 4");
    expect(col("C3", "items not judged")).toBe("1, 0, 3");
  });

  it("389 call records, 383 with a verified receipt, 0 substitutions, 0 cache hits, and the medians of tokens_out over answered records", () => {
    const lead = out.split("\n")[0];
    expect(lead).toContain("15 configuration runs (3 of each of C0, C1, C2, C3, C4): 389 call records, 383 with a verified receipt, 0 substitutions, 0 cache hits.");
    expect(lead).toContain("Median output tokens per answered call: Lightning selecting 4,724, Lightning judging 2,953, Ultra judging 615, Ultra alone 358.");
    const calls = readRuns(at(DEV)).flatMap((r) => r.calls);
    expect(calls.length).toBe(389);
    expect(calls.filter((c) => c.signature_ok === true).length).toBe(383);
    expect(calls.filter((c) => c.served_model === null).length).toBe(6);
    expect(col("C2", "calls")).toBe("49, 49, 47");
    expect(col("C2", "receipts verified")).toBe("45, 48, 46");
    expect(col("C3", "median output tokens")).toContain("Ultra judging 615");
    expect(col("C4", "median output tokens")).toBe("Ultra alone 358");
    for (const id of ["C0", "C1", "C2", "C3", "C4"]) {
      expect(col(id, "substitutions"), id).toBe("0");
      expect(col(id, "cache hits"), id).toBe("0");
    }
  });

  it("the policy file decides every C0 to C3 finding with a disposition; C4's verdict is the model's", () => {
    for (const r of readRuns(at(DEV)).filter((x) => x.config.direct === null)) {
      const decided = r.items.flatMap((i) => i.subjects).filter((s) => s.verb !== null);
      expect(decided.length, `${r.config.id} run ${r.run}`).toBeGreaterThan(0);
      expect(new Set(decided.map((s) => s.decided_by)), `${r.config.id} run ${r.run}`).toEqual(new Set(["policy"]));
    }
    expect(col("C0", "findings decided by")).toBe("policy 20");
    expect(col("C1", "findings decided by")).toBe("policy 15, 16, 20");
    expect(col("C4", "findings decided by")).toBe("the model");
  });

  it("both judges leave P09 standing in all six runs with one SELECT, which joins the day's deletes to dns_record, where a deleted record has no row", () => {
    const p09 = readPlanted(at(DEV)).filter((p) => p.id === "P09");
    expect(p09.map((p) => `${p.config}/${p.run}/${p.status}`)).toEqual(["C2/1/stands", "C2/2/stands", "C2/3/stands", "C3/1/stands", "C3/2/stands", "C3/3/stands"]);
    const sql = [...new Set(p09.map((p) => p.sql))];
    expect(sql.length).toBe(1);
    expect(sql[0]).toContain("JOIN {{t:dns_record}}");
    const bundle = JSON.parse(read("test/fixtures/recorded-bundle.json")) as {
      audit_event: { action: string; resource_id: string; occurred_at: string }[]; dns_record: { record_id: string }[];
    };
    const deleted = bundle.audit_event.filter((e) => e.action === "delete" && e.occurred_at >= "2026-10-11" && e.occurred_at < "2026-10-12").map((e) => e.resource_id);
    expect(deleted.length).toBeGreaterThan(0);
    const records = new Set(bundle.dns_record.map((r) => r.record_id));
    expect(deleted.filter((id) => records.has(id))).toEqual([]);
  });

  it("numbers carry thousands separators and a half", () => {
    expect(thousands(389)).toBe("389");
    expect(thousands(4724)).toBe("4,724");
    expect(thousands(4407.5)).toBe("4,407.5");
    expect(thousands(1234567)).toBe("1,234,567");
  });
});

describe("the README carries the table as npm run eval:table prints it", () => {
  /** The README's "### ..." blocks under "## Evaluation" whose heading names eval/results/<stamp>, each with its body. */
  const blocks = (): { stamp: string; body: string }[] => {
    const md = read("README.md");
    const start = md.indexOf("\n## Evaluation\n");
    expect(start, "## Evaluation is missing").toBeGreaterThanOrEqual(0);
    const rest = md.slice(start + 1);
    const end = rest.indexOf("\n## ");
    const parts = (end < 0 ? rest : rest.slice(0, end)).split(/\n(?=### )/).slice(1);
    return parts.flatMap((p) => {
      const [heading, ...body] = p.split("\n");
      const stamp = heading.match(/eval\/results\/([0-9TZ-]+)/)?.[1];
      return stamp ? [{ stamp, body: body.join("\n").trim() }] : [];
    });
  };

  it("every block names a committed results directory and begins with the script's output for it, byte for byte", { timeout: 60_000 }, () => {
    const found = blocks();
    expect(found.map((b) => b.stamp)).toContain("2026-10-25T09-25-44Z");
    for (const { stamp, body } of found) {
      const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/eval-table.ts", `eval/results/${stamp}`], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
      expect(r.status, r.stderr).toBe(0);
      const printed = r.stdout.replace(/\r\n/g, "\n").trimEnd();
      expect(printed).toBe(evalTable(at(`eval/results/${stamp}`)).trimEnd());
      expect(body.slice(0, printed.length), `README.md is stale for ${stamp}: paste the output of npm run -s eval:table -- eval/results/${stamp}`).toBe(printed);
      expect(["", "\n"], stamp).toContain(body.slice(printed.length, printed.length + 1));
    }
  });

  it("the Nemotron section gives the development set's four token medians as the lead line states them", () => {
    const md = read("README.md");
    const start = md.indexOf("\n## Nemotron\n");
    expect(start, "## Nemotron is missing").toBeGreaterThanOrEqual(0);
    const rest = md.slice(start + 1);
    const section = rest.slice(0, rest.indexOf("\n## ")).replace(/\s+/g, " ");
    const lead = evalTable(at(DEV)).split("\n")[0];
    const medians = lead.slice(lead.indexOf("answered call: ") + "answered call: ".length, -1).split(", ");
    expect(medians).toEqual(["Lightning selecting 4,724", "Lightning judging 2,953", "Ultra judging 615", "Ultra alone 358"]);
    for (const m of medians) expect(section, m).toContain(m);
  });
});
