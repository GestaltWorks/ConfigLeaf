// npm run sample's screen (scripts/sample.ts) over sample/bundle.json with the committed lessons (examples/memory),
// through tsx as a judge runs it from a clean clone, the trace into a temporary LOG_DIR: the header, one row per stage
// in order with its facts, the verbs ADOPT 23 · HOLD 3 · ESCALATE 1, the memory line, the ESCALATE in its three lines,
// the "what happened" sentences after a blank line, each wrapped at the width, the done line naming the trace, no trace
// line and none of the old full lines, under 80 lines; --verbose prints the trace lines and the screen beside them, the
// same rows; --json prints the SAMPLE summary line alone, the trace's last event. Off a TTY, so no colour, at COLUMNS
// 120. Each run renders examples/document.md and examples/report.html and writes either only when its bytes differ from
// the file on disk.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLASS_LABEL } from "../src/loop/present.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOGS = mkdtempSync(path.join(tmpdir(), "sample-test-"));
afterAll(() => rmSync(LOGS, { recursive: true, force: true }));

function sample(...flags: string[]): { status: number | null; lines: string[]; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/sample.ts", ...flags], {
    cwd: ROOT, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, SAMPLE_MODE: "true", DRIFT_MEMORY_DIR: "examples/memory", LOG_DIR: LOGS, NO_COLOR: "1", COLUMNS: "120" },
  });
  return { status: r.status, lines: r.stdout.replace(/\r\n/g, "\n").split("\n").filter((l, i, all) => l !== "" || i < all.length - 1), stderr: r.stderr };
}

/** The trace file the done line names, as JSON events. */
function traceOf(lines: readonly string[]): { ts: string; agent: string; output_summary?: string }[] {
  const file = lines.at(-1)?.match(/ · trace (.+\.jsonl)$/)?.[1];
  expect(file, "the done line names the trace").toBeDefined();
  return readFileSync(file!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const STAGES = ["load", "gate", "observe", "detect", "decide", "explain", "document", "report", "judge"];
const OLD_LINES = /^(\{"ts"|\{"id":"fnd-|DISPOSITION |CAUSE |ADOPTIONS: |DNS INVENTORY: |SAMPLE: |REPORT: )/;
/** The screen with the header's minute, the done line's time and the trace id taken out. */
const screen = (lines: readonly string[]): string[] =>
  lines.map((l) => l.replace(/ · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · /, " · <minute> · ").replace(/^done · \d+\.\d s · trace .+$/, "done · <time> · trace <file>"));

describe("npm run sample", () => {
  let run: ReturnType<typeof sample>;
  beforeAll(() => {
    run = sample();
  }, 120_000);

  it("prints the header, one row per stage in order, what happened and the done line, under 80 lines and no trace line", () => {
    expect(run.status, run.stderr).toBe(0);
    const { lines } = run;
    expect(lines.length).toBeLessThan(80);
    expect(lines[0]).toMatch(/^ConfigLeaf · sample · tenant client-1 · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · recorded estate, no credentials$/);
    expect(lines.filter((l) => OLD_LINES.test(l))).toEqual([]);
    expect(lines.filter((l) => l.startsWith('{"ts"'))).toEqual([]);
    const at = STAGES.map((s) => lines.findIndex((l) => l.startsWith(`  ${s.padEnd(9)} `)));
    expect(at.every((i) => i > 0), `every stage has its row: ${STAGES.filter((_, k) => at[k] < 0).join(", ")}`).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const story = lines.indexOf("what happened");
    expect(story).toBeGreaterThan(at.at(-1)!);
    expect(lines.at(-1)).toMatch(/^done · \d+\.\d s · trace .+[\\/]sample_[0-9a-z]+\.jsonl$/);
  });

  it("gives each row its facts: the bundle, the gate, the observations, the classes in plain words, the verbs and the memory, the cause, the two files, the judge", () => {
    const row = (s: string): string => run.lines.find((l) => l.startsWith(`  ${s.padEnd(9)} `)) ?? "";
    expect(row("load")).toMatch(/sample\/bundle\.json · 80 runs of 2 tenants · [\d,]+ rows in \d+ tables$/);
    expect(row("gate")).toBe("  gate      80 of 80 runs pass the DQ gate");
    expect(row("observe")).toBe("  observe   14,174 observations in the World Model");
    expect(row("detect")).toBe("  detect    27 findings in 4 classes");
    for (const [n, c] of [[20, "proxied_without_real_ip"], [3, "orphan_record"], [3, "orphan_vhost"], [1, "proxy_split"]] as const) {
      expect(run.lines).toContainEqual(expect.stringMatching(new RegExp(`^ {12} *${n}  ${CLASS_LABEL[c].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)));
    }
    expect(row("decide")).toBe("  decide    ADOPT 23 · HOLD 3 · ESCALATE 1 · decided at 2026-10-25 14:17 UTC");
    expect(run.lines).toContain("            memory    23 lessons · 23 exceptions applied · 0 lapsed");
    expect(run.lines).toContain("            DQ        exception_in_force holds for 23 of 23 ADOPT under an exception");
    expect(run.lines).toContain("            ledger    27 dispositions written · 27 of 27 read back");
    // the recorded pass's ESCALATE in its three lines: the verb and the class, the object, why
    const esc = run.lines.indexOf("            ESCALATE  name and its www treated differently by the proxy");
    expect(esc).toBeGreaterThan(0);
    expect(run.lines.slice(esc + 1, esc + 3)).toEqual([expect.stringMatching(/^ {22}host-[0-9a-f]{6}\.\S+$/), "                      the hold ran out at 25 Oct 03:21 UTC, a technician owns it"]);
    expect(row("explain")).toBe("  explain   1 cause · unknown 1");
    expect(run.lines).toContainEqual(expect.stringMatching(/^ {22}No record of who changed it: the audit log window of 18 h holds 0 events for the record\.$/));
    expect(row("document")).toMatch(/^ {2}document  examples\/document\.md · [\d,]+ bytes · [\d,]+ lines · (written|same bytes as on disk)$/);
    expect(row("report")).toMatch(/^ {2}report    examples\/report\.html · [\d,]+ bytes · 27 findings open · (written|same bytes as on disk)$/);
    expect(run.lines).toContainEqual(expect.stringMatching(/^ {12}both files pass the deny-list probe: 0 of \d+ configured labels?$/));
    expect(row("judge")).toBe("  judge     skipped, no model in sample mode");
  });

  it("prints the what-happened sentences the cycle prints, after a blank line, each wrapped at the width", () => {
    const heading = run.lines.indexOf("what happened");
    expect(run.lines[heading - 1]).toBe("");
    const story = run.lines.slice(heading + 1, -1);
    expect(story.every((l) => l.length <= 120 && /^( {2}| {4})\S/.test(l))).toBe(true);
    // each sentence from its line two columns in, its further lines four in
    const sentences = story.reduce<string[]>((xs, l) => (l.startsWith("    ") ? [...xs.slice(0, -1), `${xs.at(-1)} ${l.trim()}`] : [...xs, l.slice(2)]), []);
    expect(sentences).toHaveLength(3);
    expect(sentences[0]).toBe("Nothing changed on the estate; every finding stands as before.");
    expect(sentences[1]).toMatch(/^1 finding is with a technician: name and its www treated differently by the proxy at \S+\. No record of who changed it: /);
    expect(sentences[2]).toBe("23 findings are adopted under the technician's exceptions; 3 are held with an expiry.");
  });

  it("keeps the SAMPLE summary line in the trace file as its last event", () => {
    const events = traceOf(run.lines);
    expect(events.length).toBeGreaterThan(100);
    expect(events.at(-1)?.agent).toBe("sample");
    expect(events.at(-1)?.output_summary).toMatch(/^SAMPLE: 80 collection runs, 0 failed the DQ gate \(none\), 14174 observations in the World Model, 27 finding\(s\): /);
  });

  it("--verbose prints the trace lines and the same rows beside them", () => {
    const v = sample("--verbose");
    expect(v.status, v.stderr).toBe(0);
    const events = traceOf(v.lines);
    expect(v.lines.filter((l) => l.startsWith('{"ts"'))).toHaveLength(events.length);
    expect(v.lines.filter((l) => l.startsWith('{"id":"fnd-'))).toHaveLength(27);
    expect(v.lines.filter((l) => l.startsWith("DISPOSITION "))).toHaveLength(27);
    expect(screen(v.lines.filter((l) => !OLD_LINES.test(l)))).toEqual(screen(run.lines));
  }, 120_000);

  it("--json prints the one SAMPLE summary line, its key names as before, the trace's last event", () => {
    const before = new Set(readdirSync(LOGS));
    const j = sample("--json");
    expect(j.status, j.stderr).toBe(0);
    expect(j.lines).toHaveLength(1);
    const [line] = j.lines;
    for (const key of ["SAMPLE: 80 collection runs", "failed the DQ gate", "observations in the World Model", "finding(s): fnd-", "judge skipped (model: none)", "; memory: 23 lesson(s), 23 exception(s) applied, 0 lapsed", "; verbs: ", "; policy rules ", "locked settings without an approved value", "; ledger: 27 disposition(s)", "; explain: 1 cause(s) (unknown 1)"]) {
      expect(line).toContain(key);
    }
    const fresh = readdirSync(LOGS).filter((f) => !before.has(f));
    expect(fresh).toHaveLength(1);
    const last = readFileSync(path.join(LOGS, fresh[0]), "utf8").trimEnd().split("\n").at(-1)!;
    expect(JSON.parse(last).output_summary).toBe(line);
  }, 120_000);
});
