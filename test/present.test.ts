// The terminal view (src/loop/present.ts) over fixed step results: the width from COLUMNS and the terminal, the
// columns and the time at the width on a row's first line, a row past the width wrapped in its detail's column,
// thousands, colour on a TTY and off under NO_COLOR, the classes in plain words one a line, the finding blocks for each
// verb (the recorded pass of 26 Oct 2026 00:48 UTC with its ESCALATE in three lines), the action blocks for each status
// (an investigation's two Nemotron calls, each served model with its receipt id on a line, from the lab's record
// lines) with their parts as the owner's report joins them, the ticket lines with an opened issue's title, a failing
// row and the done lines, the Zetaris queries under the pass row and on the done line, the redactor over every text,
// the "what happened" sentences for each case with the causes the explain step found, wrapped at the width, the
// explain row, --verbose and --quiet through runCycle, and a whole cycle at 100 and 160 columns with no line past the
// width.
// Offline and deterministic: every result is built here, with fixture names only.
import { describe, expect, it } from "vitest";
import type { ActionOutcome, PlanItem } from "../src/actions/plan.ts";
import { FINDING_CLASSES } from "../src/catalogue/templates.ts";
import type { Action, ActionKind, ActionStatus, Ticket } from "../src/data/rows.ts";
import { runCycle, type CycleSteps, type StepReport } from "../src/loop/cycle.ts";
import {
  CLASS_LABEL, FINDING_LINES, MODE, PLAIN, STORY_MAX, Table, actView, classLabel, clause, cloudflareView, count, documentView, explainView, findingLine, hex8, linuxView,
  nemotronOf, passView, presentOptions, probeView, seconds, shortModel, shortUtc, thousands, ticketsView, utcMinute, validateView, whatHappened, withoutRunIds, type PresentOptions,
  type CauseFacts, type StepView, type StoryInput, type TicketFacts,
} from "../src/loop/present.ts";
import { dispositionIdOf, type AdoptionCheck, type DnsInventoryCheck, type PassStep } from "../src/loop/pass.ts";
import type { Finding, Verb } from "../src/pipeline.ts";
import type { TicketOp } from "../src/psa/index.ts";
import type { TicketOutcome } from "../src/psa/step.ts";
import type { HookResult } from "../src/vault/hook.ts";

const ESC = "\u001b";
const plain = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
/** A row's text with its time at column `width`. */
const at = (text: string, t: string, width = 90): string => `${text}${" ".repeat(Math.max(2, width - text.length - t.length))}${t}`;
/** The what-happened block's sentences: each from its line two columns in, its further lines (four in) joined back with a space. */
const sentencesOf = (block: readonly string[]): string[] =>
  block.slice(2).reduce<string[]>((xs, l) => (l.startsWith("    ") ? [...xs.slice(0, -1), `${xs.at(-1)} ${l.trim()}`] : [...xs, l.slice(2)]), []);

const committed = (commit: string): HookResult => ({ status: "committed", written: 1, commit: { repo: "t1/x", commit, reused: false, files: 1, added: 0, modified: 0, removed: 0, copies: [] } });

function finding(verb: Verb, cls: string, reason: string, over: Partial<Finding["finding"]> = {}): Finding {
  return {
    id: "fnd-0000000000000001", verb, checks: [], rejected: [], judge: "skipped",
    finding: {
      class: cls, tenant_id: "t1", run_id: "run-0000000000000001", surface: "cloudflare.dns", host: null, object_id: "rec-0001", setting_path: "proxied",
      value_hash: "sha256:00", dns_name: "www.example.invalid", since: "", until: "", summary: "", ...over,
    },
    disposition: { verb, reason, expires_at: null, decided_by: "policy", rule_id: "rule-1" },
  } as unknown as Finding;
}

const NGINX = { surface: "linux.nginx", host: "host-aaaaaa", object_id: "/etc/nginx/conf.d/word-aaaaaa.conf", setting_path: "file", dns_name: null };

function outcome(kind: ActionKind, status: ActionStatus, reason: string, o: Partial<Omit<Action, "record">> & { record?: string[]; ms?: number } = {}): ActionOutcome {
  const { record = [], ms = 0, ...fields } = o;
  const started = "2026-10-25T15:54:00.000Z";
  const action: Action = {
    action_id: "act-0000000000000001", tenant_id: "t1", kind, target: "linux.nginx host-aaaaaa /etc/nginx/conf.d/word-aaaaaa.conf file",
    before_hash: null, after_hash: null, vault_commit: null, verification: "", receipts: "", status, reason, record: record.join("\n"),
    started_at: started, finished_at: new Date(Date.parse(started) + ms).toISOString(), disposition_id: "dsp-1", ...fields,
  };
  return { action, reason, record };
}

const BEFORE = "sha256:4de292773ac4aaaabbbbccccddddeeeeffff0000111122223333444455556666";
const AFTER = "sha256:3f565467a831aaaabbbbccccddddeeeeffff0000111122223333444455556666";

// The investigation's record lines of the lab's second apply, 25 Oct 2026 09:42 UTC (lab/README.md).
const LIGHTNING_LINE = "Lightning selection (receipt rcpt_req_nn4ag0yu, openrouter/nvidia/nemotron-3.5-lightning, cache miss, route openrouter/nvidia/nemotron-3.5-lightning): 4 valid checks: setting_matches_approved, change_in_last_backup, restore_would_regress, run_complete";
const JUDGE_LINE = "judge stands (receipt rcpt_req_iehg9gmt, openrouter/nvidia/nemotron-3-ultra-550b-a55b:free, cache miss, route openrouter/nvidia/nemotron-3-ultra-550b-a55b:free): the refuting SELECT returned no rows, 0 rows";
const LAB_INVESTIGATION = {
  reason: "investigated: 4 checks ran (1 hold, 3 fail); the judge's verdict counted: stands",
  receipts: "rcpt_req_nn4ag0yu,rcpt_req_iehg9gmt",
  record: ["finding fnd-1 (drift_vs_approved): the live file drifted", LIGHTNING_LINE, "check run_complete (query q-1): holds, 1 row: the run is complete", JUDGE_LINE],
};

describe("numbers, times and hashes", () => {
  it("carries thousands separators, one decimal, 8 hex and the minute in UTC", () => {
    expect([thousands(0), thousands(999), thousands(1036), thousands(15236), thousands(1234567)]).toEqual(["0", "999", "1,036", "15,236", "1,234,567"]);
    expect([count(1, "zone"), count(6, "zone"), count(3, "copy", "copies"), count(1036, "row")]).toEqual(["1 zone", "6 zones", "3 copies", "1,036 rows"]);
    expect([seconds(5756), seconds(112711), seconds(40)]).toEqual(["5.8 s", "112.7 s", "0.0 s"]);
    expect([hex8("sha256:3f565467a831"), hex8("325fe98b6874"), hex8(null)]).toEqual(["3f565467", "325fe98b", "-"]);
    expect(utcMinute(new Date("2026-10-25T15:38:05.430Z"))).toBe("2026-10-25 15:38 UTC");
    expect(shortUtc("2026-10-25T03:21:06.870Z")).toBe("25 Oct 03:21 UTC");
    expect(clause("first part; second part")).toBe("first part");
    expect(clause("x".repeat(80), 20)).toBe(`${"x".repeat(19)}…`);
  });

  it("leaves no run id in a sentence", () => {
    expect(withoutRunIds("run run-22c36b45028d6029 of fixture-host is partial")).toBe("the run of fixture-host is partial");
    expect(withoutRunIds("probe run run-4f41e1f662be63b5 is failed")).toBe("the probe run is failed");
  });
});

describe("presentOptions", () => {
  it("colours a TTY unless NO_COLOR is set; the width is COLUMNS when set, else the terminal's columns, less one on a TTY, else 120", () => {
    expect(presentOptions({}, { isTTY: true, columns: 100 }, {})).toEqual({ color: true, width: 99, verbose: false, quiet: false });
    expect(presentOptions({}, { isTTY: true, columns: 300 }, {}).width).toBe(299);
    expect(presentOptions({ verbose: true }, { isTTY: true, columns: 100 }, { NO_COLOR: "1" })).toEqual({ color: false, width: 99, verbose: true, quiet: false });
    expect(presentOptions({}, { isTTY: true, columns: 100 }, { NO_COLOR: "" }).color).toBe(true);
    expect(presentOptions({ quiet: true }, { isTTY: false }, {})).toEqual({ color: false, width: 120, verbose: false, quiet: true });
    expect(presentOptions({}, { isTTY: false }, { COLUMNS: "100" }).width).toBe(100);
    expect(presentOptions({}, { isTTY: true, columns: 160 }, { COLUMNS: "100" }).width).toBe(99);
    for (const bad of ["", "0", "-5", "wide", "99.5"]) expect(presentOptions({}, { isTTY: false }, { COLUMNS: bad }).width).toBe(120);
  });
});

// ---- a clean dry run, step by step ----------------------------------------------------------------------------

/** The finding under another id, decided by another hand. */
const as = (f: Finding, id: string, decidedBy: Finding["disposition"]["decided_by"] = f.disposition.decided_by): Finding => ({ ...f, id, disposition: { ...f.disposition, decided_by: decidedBy } });

const escalate = finding("ESCALATE", "proxy_split", "hold under rule rule-1 expired 2026-10-25T03:21:06.870Z; the finding stands");
const cleanPass = {
  findings: [
    ...Array.from({ length: 20 }, () => as(finding("ADOPT", "proxied_without_real_ip", "accepted exception lesson-1 holds until 2026-11-01T00:00:00.000Z"), "fnd-0000000000000001", "operator")),
    ...Array.from({ length: 3 }, () => finding("HOLD", "orphan_record", "rule rule-2 (low) holds this orphan_record finding until 2026-10-26T00:00:00.000Z")),
    ...Array.from({ length: 3 }, () => finding("ADOPT", "orphan_vhost", "rule rule-3 (low) adopts this orphan_vhost finding", NGINX)),
    escalate,
  ],
} as Pick<PassStep, "findings">;

describe("the table over a clean dry run", () => {
  const t = new Table(PLAIN, (s) => s, ["cloudflare", "fixture-host"]);
  const probes = [
    ...Array.from({ length: 27 }, () => ({ kind: "http", status: "ok" })), ...Array.from({ length: 10 }, () => ({ kind: "http", status: "fail" })),
    ...Array.from({ length: 34 }, () => ({ kind: "dns", status: "ok" })), ...Array.from({ length: 3 }, () => ({ kind: "dns", status: "fail" })),
    ...Array.from({ length: 30 }, () => ({ kind: "tls", status: "ok" })), ...Array.from({ length: 7 }, () => ({ kind: "tls", status: "fail" })),
  ];
  const validation = [
    ...Array.from({ length: 42 }, () => ({ validator: "cf-schema", result: "ok" })), ...Array.from({ length: 16 }, () => ({ validator: "cf-schema", result: "ok_with_gaps" })),
    ...Array.from({ length: 54 }, () => ({ validator: "nginx-t", result: "ok_with_gaps" })),
  ];

  it("prints the header, one row per step in its columns with its time at column 90, and the done line", () => {
    const screen = [
      t.header({ command: "cycle", tenant: "client-1", at: new Date("2026-10-25T15:38:05.430Z"), mode: MODE.dryRun }),
      ...t.row("collect", cloudflareView({ records: 58, zones: 6, audit: 1036, hook: committed("0a1b2c3d4e5f60718293a4b5c6d7e8f901234567") }), 5756),
      ...t.row("collect", linuxView("fixture-host", { files: 24, blocks: 46, settings: 761, hook: committed("1a2b3c4d5e6f") }), 3259),
      ...t.row("probe", probeView({ names: 37, rows: probes }), 9815),
      ...t.row("validate", validateView({ heads: 3, nginx: ["ok_with_gaps", "ok_with_gaps"], rows: validation, errors: 0 }), 3497),
      ...t.row("pass", passView(cleanPass), 68593),
      ...t.row("explain", explainView({ causes: [{ class: "unknown" }, { class: "agent" }, { class: "operator_edit" }, { class: "unknown" }] }), 412),
      ...t.row("act", actView({ apply: false, plan: [], outcomes: [], acted: [] }), 374),
      ...t.row("tickets", ticketsView({ ops: [{ op: "skip", finding_id: "fnd-1", reason: "HOLD" }], outcomes: [{ op: "skip", ticket_id: null, external_id: null, status: "skipped", line: "skip" }], open: 1 }, false), 1137),
      ...t.row("document", documentView({ file: "document.md", lines: 181 }), 16896),
      t.done({ ms: 112711, steps: 9, trace: "logs/cycle_test.jsonl" }),
    ];
    expect(screen).toEqual([
      "ConfigLeaf · cycle · tenant client-1 · 2026-10-25 15:38 UTC · dry run, nothing changed",
      at("  collect   cloudflare    58 records in 6 zones · audit 1,036 rows · vault 0a1b2c3d", "5.8 s"),
      at("  collect   fixture-host  24 files · 46 blocks · 761 settings · vault 1a2b3c4d", "3.3 s"),
      at("  probe     37 names      http 27 ok · dns 34 ok · tls 30 ok · 20 failing", "9.8 s"),
      at("  validate  3 copies      nginx-t ok with gaps ×2 · cf-schema 42 ok, 16 with gaps", "3.5 s"),
      at("  pass      27 findings   ADOPT 23 · HOLD 3 · ESCALATE 1", "68.6 s"),
      "            classes   20  proxied name, origin trusts no Cloudflare range",
      "                       3  DNS record with no site behind it",
      "                       3  site with no DNS record",
      "                       1  name and its www treated differently by the proxy",
      "            ESCALATE  name and its www treated differently by the proxy",
      "                      www.example.invalid",
      "                      the hold ran out at 25 Oct 03:21 UTC, a technician owns it",
      at("  explain   4 causes      operator 1 · agent 1 · unknown 2", "0.4 s"),
      at("  act       nothing to do", "0.4 s"),
      at("  tickets   nothing to send · 1 open", "1.1 s"),
      at("  document  document.md · 181 lines", "16.9 s"),
      "done · 9 steps · 112.7 s · trace logs/cycle_test.jsonl",
    ]);
    // every row ends at column 90; the columns start at 2, 12 and 26
    for (const l of screen.filter((x) => /^  \S/.test(x))) {
      expect(l).toHaveLength(90);
      expect(l.slice(2, 12).trimEnd()).toMatch(/^(collect|probe|validate|pass|explain|act|tickets|document)$/);
    }
  });

  it("the explain row: the causes by class, people and tools first, then the agent, then unknown; nothing to explain; not explained with its reason", () => {
    const all = ["token_change", "automation", "unknown", "account_change", "agent", "operator_edit", "operator_edit"].map((c) => ({ class: c }));
    // past the width the counts go on in the detail's column, the time on the first line
    expect(t.row("explain", explainView({ causes: all }), 1400)).toEqual([
      at("  explain   7 causes      operator 2 · automation 1 · account 1 · token 1 · agent 1", "1.4 s"),
      "                          unknown 1",
    ]);
    expect(t.row("explain", explainView({ causes: [{ class: "account_change" }] }), 50)[0]).toBe(at("  explain   1 cause       account 1", "0.1 s"));
    expect(t.row("explain", explainView({ causes: [] }), 0)[0]).toBe(at("  explain   0 causes      nothing to explain", "0.0 s"));
    expect(t.row("explain", explainView({ causes: [], stopped: "relation finding_cause does not exist; the step reads it back" }), 30)[0])
      .toBe(at("  explain   0 causes      not explained · relation finding_cause does not exist", "0.0 s"));
    expect(new Table({ ...PLAIN, color: true }).row("explain", explainView({ causes: [], stopped: "x" }), 0)[0]).toContain(`${ESC}[33mnot explained${ESC}[0m`);
  });

  it("widens the subject column to the longest subject it is given, and wraps a row past the width with its time on the first line", () => {
    const wide = new Table(PLAIN, (s) => s, ["cloudflare", "fixture-host-17ch"]);
    expect(wide.row("collect", linuxView("fixture-host-17ch", { files: 1, blocks: 2, settings: 3, hook: { status: "off" } }), 100)[0])
      .toBe(at("  collect   fixture-host-17ch 1 file · 2 blocks · 3 settings · vault off", "0.1 s"));
    expect(wide.row("collect", cloudflareView({ records: 1, zones: 1, audit: 0, hook: { status: "skipped", reason: "x" } }), 100)[0])
      .toBe(at("  collect   cloudflare        1 record in 1 zone · audit 0 rows · vault skipped", "0.1 s"));
    // a word longer than the room is cut; the time stays at the width on the first line
    expect(t.row("act", { parts: ["x".repeat(100)] }, 100)).toEqual([`  act       ${"x".repeat(71)}  0.1 s`, `            ${"x".repeat(29)}`]);
    // a phrase breaks at its spaces, whole phrases go to a line of their own
    expect(t.row("act", { subject: "1 action", parts: ["the first phrase", `${"word ".repeat(16).trim()}`, "the last"] }, 100)).toEqual([
      at("  act       1 action      the first phrase", "0.1 s"),
      "                          word word word word word word word word word word word word word",
      "                          word word word · the last",
    ]);
  });

  it("names the queries the pass sent through Zetaris on the first line under the pass row; without them the row is as before", () => {
    const sent = { datasource: "DRIFT", queries: 377, rows: 14_174, failed: 0 };
    const rows = t.row("pass", passView(cleanPass, sent), 68593);
    expect(rows.slice(0, 3)).toEqual([
      at("  pass      27 findings   ADOPT 23 · HOLD 3 · ESCALATE 1", "68.6 s"),
      "            Zetaris   377 queries · 14,174 rows · 0 failed",
      "            classes   20  proxied name, origin trusts no Cloudflare range",
    ]);
    // the rest of the row is the row without the line
    expect([rows[0], ...rows.slice(2)]).toEqual(t.row("pass", passView(cleanPass), 68593));
    expect(passView(cleanPass, undefined)).toEqual(passView(cleanPass));
    // failures red on a TTY
    const c = new Table({ ...PLAIN, color: true });
    expect(c.row("pass", passView(cleanPass, { datasource: "DRIFT", queries: 3, rows: 1, failed: 2 }), null)[1])
      .toBe(`            Zetaris   3 queries · 1 row · ${ESC}[31m2 failed${ESC}[0m`);
  });

  it("under the Zetaris line, the file tables' refresh and the pass's read of exception_in_force, each on a line; red when one fails, yellow when not read", () => {
    const sent = { datasource: "DRIFT", queries: 437, rows: 26_956, failed: 0 };
    const pass = (adoptions: AdoptionCheck) => ({ ...cleanPass, adoptions });
    const rows = t.row("pass", passView(pass({ rule: "exception_in_force", of: "pass", decidedAt: "2026-10-25T21:12:42.005Z", adoptions: 23, inForce: 23 }), sent), 68593);
    expect(rows.slice(1, 3)).toEqual([
      "            Zetaris   437 queries · 26,956 rows · 0 failed",
      "            DQ        exception_in_force holds for 23 of 23 adoptions",
    ]);
    // the rest of the row is the row without the read
    expect([rows[0], rows[1], ...rows.slice(3)]).toEqual(t.row("pass", passView(cleanPass, sent), 68593));
    // a pass with no ledger reads the latest recorded pass's, and says which (measured 25 Oct 2026, 22:29 UTC, client-1), wrapped at the width
    const dry = t.row("pass", passView(pass({ rule: "exception_in_force", of: "recorded", decidedAt: "2026-10-25T21:12:42.005Z", adoptions: 23, inForce: 23 }), sent), 135_800);
    expect(dry.slice(2, 4)).toEqual([
      "            DQ        exception_in_force holds for 23 of 23 adoptions of the pass recorded",
      "                      at 2026-10-25 21:12 UTC",
    ]);
    const none = t.row("pass", passView(pass({ rule: "exception_in_force", of: "recorded", decidedAt: null, adoptions: 0, inForce: 0 }), sent), null);
    expect(none[2]).toBe("            DQ        exception_in_force holds for 0 of 0 adoptions, no pass recorded one");
    // without the Zetaris facts (sql.js) no line names it
    expect(t.row("pass", passView(pass({ rule: "exception_in_force", of: "pass", decidedAt: null, adoptions: 1, inForce: 1 })), null)).toEqual(t.row("pass", passView(cleanPass), null));
    const c = new Table({ ...PLAIN, color: true, width: 200 });
    expect(c.row("pass", passView(pass({ rule: "exception_in_force", of: "pass", decidedAt: null, adoptions: 23, inForce: 21 }), sent), null)[2])
      .toBe(`            DQ        ${ESC}[31mexception_in_force holds for 21 of 23 adoptions${ESC}[0m`);
    expect(c.row("pass", passView(pass({ rule: "exception_in_force", error: "Zetaris 400: table not found" }), sent), null)[2])
      .toBe(`            DQ        ${ESC}[33mexception_in_force not read${ESC}[0m`);
    // the file tables: a line when the pass put them, yellow when the put failed, none when the copy was current
    const files = (status: "refreshed" | "failed" | "current") => t.row("pass", passView({ ...cleanPass, files: { status } as PassStep["files"] }, sent), null)[2];
    expect(files("refreshed")).toBe("            files     lessons and rules refreshed in Zetaris");
    expect(new Table({ ...PLAIN, color: true }).row("pass", passView({ ...cleanPass, files: { status: "failed" } as PassStep["files"] }, sent), null)[2])
      .toBe(`            files     ${ESC}[33mlessons and rules not refreshed in Zetaris${ESC}[0m`);
    expect(files("current")).toBe("            classes   20  proxied name, origin trusts no Cloudflare range");
  });

  it("then the pass's read of dns_inventory_current over the live records, as the live pass of 26 Oct 2026, 03:49 UTC printed it; red when the provider changed since the last complete DNS run, yellow when not read", () => {
    const sent = { datasource: "DRIFT", queries: 458, rows: 29_640, failed: 0 };
    const adoptions: AdoptionCheck = { rule: "exception_in_force", of: "recorded", decidedAt: "2026-10-26T01:14:00.000Z", adoptions: 23, inForce: 23 };
    const pass = (dns: DnsInventoryCheck) => ({ ...cleanPass, adoptions, dns });
    const rows = t.row("pass", passView(pass({ rule: "dns_inventory_current", live: 58, current: 58, runId: "run-a7ccb5c97d2c781c" }), sent), 97_800);
    expect(rows.slice(1, 5)).toEqual([
      "            Zetaris   458 queries · 29,640 rows · 0 failed",
      "            DQ        exception_in_force holds for 23 of 23 adoptions of the pass recorded",
      "                      at 2026-10-26 01:14 UTC",
      "                      dns_inventory_current holds for 58 of 58 live records",
    ]);
    // the rest of the row is the row without the read
    expect([...rows.slice(0, 4), ...rows.slice(5)]).toEqual(t.row("pass", passView({ ...cleanPass, adoptions }, sent), 97_800));
    // without the Zetaris facts (sql.js, sample mode) no line names it
    expect(t.row("pass", passView(pass({ rule: "dns_inventory_current", live: 1, current: 1, runId: null })), null)).toEqual(t.row("pass", passView(cleanPass), null));
    expect(t.row("pass", passView(pass({ rule: "dns_inventory_current", live: 1, current: 1, runId: null }), sent), null)[4]).toBe("                      dns_inventory_current holds for 1 of 1 live record");
    // with no adoption read the DNS read carries the DQ label itself
    expect(t.row("pass", passView({ ...cleanPass, dns: { rule: "dns_inventory_current", live: 58, current: 58, runId: null } }, sent), null)[2]).toBe("            DQ        dns_inventory_current holds for 58 of 58 live records");
    const c = new Table({ ...PLAIN, color: true });
    expect(c.row("pass", passView(pass({ rule: "dns_inventory_current", live: 60, current: 57, runId: "run-a7ccb5c97d2c781c" }), sent), null)[4])
      .toBe(`                      ${ESC}[31mdns_inventory_current holds for 57 of 60 live records${ESC}[0m`);
    expect(c.row("pass", passView(pass({ rule: "dns_inventory_current", error: "Zetaris 400: REST API call failed: 403" }), sent), null)[4])
      .toBe(`                      ${ESC}[33mdns_inventory_current not read${ESC}[0m`);
  });

  it("says nothing new when no vault commit came in, and names the repositories it could not validate", () => {
    expect(t.row("validate", validateView(null), 0)[0]).toBe(at("  validate  no new vault commit · nothing validated", "0.0 s"));
    expect(t.row("validate", validateView({ heads: 3, nginx: ["ok", "fail"], rows: [{ validator: "cf-schema", result: "fail" }], errors: 1 }), 0)).toEqual([
      at("  validate  3 copies      nginx-t ok, fail · cf-schema 1 fail", "0.0 s"),
      "                          1 repository not validated",
    ]);
  });
});

// ---- the classes in plain words -------------------------------------------------------------------------------

describe("the classes in plain words", () => {
  it("holds one label for every class the pass raises, and keeps a class it does not know as it is", () => {
    expect(Object.keys(CLASS_LABEL).sort()).toEqual([...FINDING_CLASSES].sort());
    expect(CLASS_LABEL).toEqual({
      proxied_without_real_ip: "proxied name, origin trusts no Cloudflare range",
      orphan_record: "DNS record with no site behind it",
      orphan_vhost: "site with no DNS record",
      found_but_different: "unchanged setting, its target moved",
      drift_vs_approved: "drifted from the approved value",
      approved_missing: "approved setting missing",
      changed_since_backup: "changed since the last backup",
      proxy_split: "name and its www treated differently by the proxy",
      m365_mail_record: "mail record Microsoft 365 requires, missing or different in DNS",
      dns_change: "DNS target moved",
    });
    expect(classLabel("some_new_class")).toBe("some_new_class");
  });

  // the classes of the measured screen of 25 Oct 2026 16:49 UTC, in the tally's order: by count, then by class
  const measured = {
    findings: [
      ...Array.from({ length: 20 }, () => finding("ADOPT", "proxied_without_real_ip", "")), ...Array.from({ length: 3 }, () => finding("HOLD", "orphan_record", "")),
      ...Array.from({ length: 3 }, () => finding("ADOPT", "orphan_vhost", "", NGINX)), ...Array.from({ length: 2 }, () => finding("HOLD", "found_but_different", "")),
      finding("ROLLBACK", "drift_vs_approved", ""), escalate,
    ],
  };

  it("lists the classes one a line under the label classes, the most first, each count right-aligned in the counts' width, at any width", () => {
    const classes = (width: number): string[] => new Table({ ...PLAIN, width }).row("pass", passView(measured), null).slice(1, 7);
    const expected = [
      "            classes   20  proxied name, origin trusts no Cloudflare range",
      "                       3  DNS record with no site behind it",
      "                       3  site with no DNS record",
      "                       2  unchanged setting, its target moved",
      "                       1  drifted from the approved value",
      "                       1  name and its www treated differently by the proxy",
    ];
    for (const w of [90, 120, 300]) expect(classes(w)).toEqual(expected);
    // a count of four digits sets the column; a class past the width goes on under its line
    const many = { findings: [...Array.from({ length: 1204 }, () => finding("ADOPT", "orphan_record", "")), finding("HOLD", "proxy_split", "")] };
    expect(new Table({ ...PLAIN, width: 64 }).row("pass", passView(many), null).slice(1)).toEqual([
      "            classes   1,204  DNS record with no site behind it",
      "                          1  name and its www treated",
      "                      differently by the proxy",
    ]);
  });
});

// ---- colour ---------------------------------------------------------------------------------------------------

describe("colour", () => {
  const view = passView({ findings: [finding("ROLLBACK", "drift_vs_approved", ""), finding("FIX", "x", ""), finding("ADOPT", "x", ""), finding("HOLD", "x", ""), escalate] });

  it("paints the verbs on a TTY and keeps the time at the width", () => {
    const t = new Table({ ...PLAIN, color: true });
    const row = t.row("pass", view, 1000)[0];
    expect(row).toContain(`${ESC}[1;37mROLLBACK${ESC}[0m 1`);
    expect(row).toContain(`${ESC}[1;37mFIX${ESC}[0m 1`);
    expect(row).toContain(`${ESC}[32mADOPT${ESC}[0m 1`);
    expect(row).toContain(`${ESC}[33mHOLD${ESC}[0m 1`);
    expect(row).toContain(`${ESC}[31mESCALATE${ESC}[0m 1`);
    expect(plain(row)).toHaveLength(90);
    expect(t.done({ ms: 1000 })).toBe(`${ESC}[32mdone${ESC}[0m · 1.0 s`);
    expect(t.failed("probe", "partial", 100)).toMatch(new RegExp(`^${ESC}\\[31m  probe     failed        partial +0\\.1 s${ESC}\\[0m$`));
  });

  it("prints plain text under NO_COLOR", () => {
    const t = new Table(presentOptions({}, { isTTY: true, columns: 91 }, { NO_COLOR: "1" }));
    const lines = [...t.row("pass", view, 1000), t.done({ ms: 1000 }), t.failed("probe", "partial", 100), t.header({ command: "cycle", tenant: "t1", at: new Date(0), mode: "dry run" })];
    expect(lines.join("\n")).not.toContain(ESC);
    expect(lines[0]).toBe(at("  pass      5 findings    ROLLBACK 1 · FIX 1 · ADOPT 1 · HOLD 1 · ESCALATE 1", "1.0 s"));
  });
});

// ---- the finding lines ------------------------------------------------------------------------------------------

describe("the finding blocks under the pass row", () => {
  const t = new Table(PLAIN);
  const lines = (f: Finding): string[] => t.row("pass", { parts: [], sub: [findingLine(f)], labelWidth: 8 }, null).slice(1);
  /** A block as the screen prints it: the verb in its column, then each line in the text's column. */
  const shown = (verb: string, ...ls: string[]): string[] => ls.map((l, k) => `${k ? " ".repeat(22) : `            ${verb.padEnd(10)}`}${l}`);

  it("a ROLLBACK names, after the verb, what drifted in plain words; the object; the copy it restores", () => {
    expect(lines(finding("ROLLBACK", "drift_vs_approved", "live value drifted from approved 3f565467a831; vault commit 5dde7698 holds the approved copy, validated ok with 0 gaps, so rule rule-1 rolls it back to that copy", NGINX)))
      .toEqual(shown("ROLLBACK", "drifted from the approved value", "conf.d/word-aaaaaa.conf on host-aaaaaa", "copy 5dde7698 validated ok"));
    expect(lines(finding("ROLLBACK", "approved_missing", "approved 0123456789ab is absent from the run; vault commit 89abcdef holds the approved copy, validated ok_with_gaps with 16 gaps, so rule rule-1 restores it from that copy", NGINX)))
      .toEqual(shown("ROLLBACK", "approved setting missing", "conf.d/word-aaaaaa.conf on host-aaaaaa", "copy 89abcdef validated ok with 16 gaps"));
    expect(lines(finding("ROLLBACK", "drift_vs_approved", "live value drifted from approved ad2e4ad71240; vault commit 0a1b2c3d holds the approved copy, validated ok with 0 gaps, so rule rule-1 rolls it back to that copy", { setting_path: "content", dns_name: "mail.example.invalid" })))
      .toEqual(shown("ROLLBACK", "drifted from the approved value", "DNS record mail.example.invalid (content)", "copy 0a1b2c3d validated ok"));
    // a reason that names no copy gives the first two lines
    expect(lines(finding("ROLLBACK", "drift_vs_approved", "", NGINX))).toEqual(shown("ROLLBACK", "drifted from the approved value", "conf.d/word-aaaaaa.conf on host-aaaaaa"));
  });

  it("a FIX and an ESCALATE name the class in plain words; the object; why, in a few words", () => {
    expect(lines(finding("FIX", "drift_vs_approved", "live value drifted from approved 3f565467a831 with no valid copy (1 copy in the vault, latest validation fail) and production affected (2 failing probes in run-0000000000000002: http a.example.invalid, tls a.example.invalid), so rule rule-1 investigates, fixes where allowed, documents and opens a ticket", NGINX)))
      .toEqual(shown("FIX", "drifted from the approved value", "conf.d/word-aaaaaa.conf on host-aaaaaa", "no valid copy · production affected, 2 failing probes"));
    expect(lines(escalate)).toEqual(shown("ESCALATE", "name and its www treated differently by the proxy", "www.example.invalid", "the hold ran out at 25 Oct 03:21 UTC, a technician owns it"));
    expect(lines(finding("ESCALATE", "drift_vs_approved", "live value drifted from approved 3f565467a831 with no valid copy (none in the vault) and no probe run in this pass, so production is unknown and rule rule-1 sends it to a technician", NGINX)))
      .toEqual(shown("ESCALATE", "drifted from the approved value", "conf.d/word-aaaaaa.conf on host-aaaaaa", "no valid copy · production unknown"));
    expect(lines(finding("ESCALATE", "orphan_record", "exception lapsed: lesson-1 expired 2026-10-20T00:00:00.000Z; re-raised to the technician, the checks alone would say ADOPT")))
      .toEqual(shown("ESCALATE", "DNS record with no site behind it", "www.example.invalid", "the accepted exception ran out at 20 Oct 00:00 UTC, a technician", "owns it"));
    expect(lines(finding("ESCALATE", "orphan_record", "2 of 3 checks fail; the default policy escalates")))
      .toEqual(shown("ESCALATE", "DNS record with no site behind it", "www.example.invalid", "2 of 3 checks fail"));
    // a reason past the width goes on in its column
    expect(new Table({ ...PLAIN, width: 60 }).row("pass", { parts: [], sub: [findingLine(escalate)], labelWidth: 8 }, null).slice(1))
      .toEqual(shown("ESCALATE", "name and its www treated differently", "by the proxy", "www.example.invalid", "the hold ran out at 25 Oct 03:21 UTC,", "a technician owns it"));
  });

  it("ADOPT and HOLD stay in the counts; the blocks run ROLLBACK, FIX, ESCALATE, the labels padded alike, and past the cap one line counts the rest", () => {
    const view = passView({ findings: [escalate, finding("ADOPT", "orphan_vhost", ""), finding("HOLD", "orphan_record", ""), finding("FIX", "orphan_vhost", "rule rule-4 investigates this orphan_vhost finding with production affected (1 failing probe in run-x: http a), and fixes where allowed", NGINX), finding("ROLLBACK", "drift_vs_approved", "", NGINX)] });
    const rows = t.row("pass", view, null);
    expect(rows[0]).toBe("  pass      5 findings    ROLLBACK 1 · FIX 1 · ADOPT 1 · HOLD 1 · ESCALATE 1");
    expect(rows.filter((l) => /^ {12}\S/.test(l) && !l.includes("classes")).map((l) => l.slice(12, 22))).toEqual(["ROLLBACK  ", "FIX       ", "ESCALATE  "]);
    expect(rows.join("\n")).not.toMatch(/ADOPT  |HOLD  /);
    // the label column stays put when the longest verb is absent
    expect(t.row("pass", passView({ findings: [escalate] }), null).slice(2)).toEqual(lines(escalate));
    const many = passView({ findings: Array.from({ length: FINDING_LINES + 3 }, () => escalate) });
    expect(many.sub!.length).toBe(1 + FINDING_LINES + 1);
    expect(t.row("pass", many, null).at(-1)).toBe("            3 more in the trace");
  });

  it("the recorded pass of 26 Oct 2026 00:48 UTC: one fact a line under the row, the ESCALATE in its three lines", () => {
    const adopt = (cls: string, n: number, over: Partial<Finding["finding"]> = {}): Finding[] => Array.from({ length: n }, () => as(finding("ADOPT", cls, "accepted exception lesson-1 holds until 2026-11-01T00:00:00.000Z", over), "fnd-0000000000000001", "operator"));
    const recorded = {
      findings: [
        ...adopt("proxied_without_real_ip", 20), ...adopt("orphan_vhost", 3, NGINX), ...adopt("approved_missing", 2),
        ...Array.from({ length: 3 }, () => finding("HOLD", "orphan_record", "rule rule-2 (low) holds this orphan_record finding until 2026-10-26T00:00:00.000Z")),
        escalate,
      ],
      adoptions: { rule: "exception_in_force", of: "pass", decidedAt: "2026-10-26T00:46:00.000Z", adoptions: 23, inForce: 23 } as AdoptionCheck,
    };
    const rows = new Table({ ...PLAIN, width: 120 }).row("pass", passView(recorded, { datasource: "DRIFT", queries: 453, rows: 28_712, failed: 0 }), 97_800);
    expect(rows).toEqual([
      at("  pass      29 findings   ADOPT 25 · HOLD 3 · ESCALATE 1", "97.8 s", 120),
      "            Zetaris   453 queries · 28,712 rows · 0 failed",
      "            DQ        exception_in_force holds for 23 of 23 adoptions",
      "            classes   20  proxied name, origin trusts no Cloudflare range",
      "                       3  DNS record with no site behind it",
      "                       3  site with no DNS record",
      "                       2  approved setting missing",
      "                       1  name and its www treated differently by the proxy",
      "            ESCALATE  name and its www treated differently by the proxy",
      "                      www.example.invalid",
      "                      the hold ran out at 25 Oct 03:21 UTC, a technician owns it",
    ]);
    // the verb keeps its colour on a TTY
    expect(new Table({ ...PLAIN, color: true, width: 120 }).row("pass", passView(recorded), null).at(-3)).toBe(`            ${ESC}[31mESCALATE${ESC}[0m  name and its www treated differently by the proxy`);
  });
});

// ---- the action lines -------------------------------------------------------------------------------------------

describe("the action blocks under the act row", () => {
  const t = new Table(PLAIN);
  const probe = (id: string, kind: string, name: string, ray = true): string => `probe ${id}: ${kind} ${name} ok (status 200 server=cloudflare cf-ray ${ray ? "present" : "absent"})`;
  /** A block as the screen prints it: the kind in its column, then each line in the text's column. */
  const shown = (kind: string, ...ls: string[]): string[] => ls.map((l, k) => `${k ? " ".repeat(27) : `            ${kind.padEnd(15)}`}${l}`);
  /** The act row's blocks with their parts on one line each, as the owner's report joins them (src/document/report.ts didLines). */
  const joined = (view: StepView): string[] => view.sub!.map((s) => new Table({ ...PLAIN, width: 1000 }).row("act", { parts: [], sub: [{ label: s.label, parts: s.parts }], labelWidth: 13 }, null)[1]);

  it("an applied rollback, each way it ends", () => {
    const done = outcome("rollback_file", "done", "restored to the approved copy at vault commit 3f565467; nginx -t passed, nginx reloaded, 3 probes of www.example.invalid ok", {
      before_hash: BEFORE, after_hash: AFTER, verification: "probe-1,probe-2,probe-3", ms: 2300,
      record: ["vault commit 3f565467 holds the copy", probe("probe-1", "http", "www.example.invalid"), probe("probe-2", "tls", "www.example.invalid", false), probe("probe-3", "http", "api.example.invalid")],
    });
    const unverified = outcome("rollback_file", "unverified", "written and reloaded; no probe of www.example.invalid ran (the account holds no record of these names)", { before_hash: BEFORE, after_hash: AFTER, ms: 1900 });
    const failed = outcome("rollback_file", "failed", "nginx -t refused the copy: [emerg] unknown directive in /etc/nginx/conf.d/word-aaaaaa.conf:3; the previous bytes were written back, the file is 4de292773ac4 again", { before_hash: BEFORE, after_hash: BEFORE });
    const probesFail = outcome("rollback_file", "failed", "written and reloaded; 1 of 2 probes fail: http www.example.invalid", { before_hash: BEFORE, after_hash: AFTER });
    const refused = outcome("rollback_file", "refused", "the live file is 9999aaaabbbb and run run-0000000000000001 recorded 4de292773ac4: it changed since the decision, and nothing was written");
    const view = actView({ apply: true, plan: [], outcomes: [done, unverified, failed, probesFail, refused], acted: [] });
    const FILE = "conf.d/word-aaaaaa.conf on host-aaaaaa";
    expect(t.row("act", view, 9000)).toEqual([
      at("  act       5 actions", "9.0 s"),
      ...shown("rollback_file", FILE, "done 2.3 s", "4de29277 → 3f565467 · nginx -t ok · reloaded", "3 probes ok, cf-ray present"),
      ...shown("rollback_file", FILE, "unverified", "4de29277 → 3f565467 · nginx -t ok · reloaded", "no probe knew its names"),
      ...shown("rollback_file", FILE, "failed", "nginx -t refused the copy"),
      ...shown("rollback_file", FILE, "failed", "1 of 2 probes fail"),
      ...shown("rollback_file", FILE, "refused", "changed since the decision"),
    ]);
    // the parts, joined on one line, are the owner's report's as before
    expect(joined(view)).toEqual([
      "            rollback_file  conf.d/word-aaaaaa.conf on host-aaaaaa · 4de29277 → 3f565467 · nginx -t ok · reloaded · 3 probes ok, cf-ray present · done 2.3 s",
      "            rollback_file  conf.d/word-aaaaaa.conf on host-aaaaaa · 4de29277 → 3f565467 · nginx -t ok · reloaded · unverified · no probe knew its names",
      "            rollback_file  conf.d/word-aaaaaa.conf on host-aaaaaa · failed · nginx -t refused the copy",
      "            rollback_file  conf.d/word-aaaaaa.conf on host-aaaaaa · failed · 1 of 2 probes fail",
      "            rollback_file  conf.d/word-aaaaaa.conf on host-aaaaaa · refused · changed since the decision",
    ]);
  });

  it("a record revert names its record from the pass (its target without one), the provider's confirmation; an investigation its verb, and the fix it refuses", () => {
    const RECORD = "cloudflare.dns rec-0001 content";
    const pass = { findings: [finding("ROLLBACK", "drift_vs_approved", "", { setting_path: "content", dns_name: "mail.example.invalid" })] };
    const revert = outcome("revert_record", "done", "reverted to the approved copy at vault commit 0a1b2c3d; the record read back equals the copy field by field", {
      target: RECORD, before_hash: "sha256:b2e7a764f9c0", after_hash: "sha256:ad2e4ad71240", verification: "probe-4", ms: 1200,
      record: ["probe probe-4: dns mail.example.invalid ok (status 200); resolvers answer from cache until the TTL (3600 s) passes"],
    });
    const revertUnverified = outcome("revert_record", "unverified", "reverted to the approved copy at vault commit 0a1b2c3d; the record read back equals the copy field by field; no dns probe of mail.example.invalid ran (the account holds no A, AAAA or CNAME record of this name)", { target: RECORD, before_hash: "sha256:b2e7a764f9c0", after_hash: "sha256:ad2e4ad71240" });
    const recreated = outcome("revert_record", "done", "re-created to the approved copy at vault commit 0a1b2c3d; the record read back equals the copy field by field", { target: RECORD, after_hash: "sha256:ad2e4ad71240", verification: "probe-5", ms: 900 });
    const inv = outcome("investigate", "done", "investigated: 4 checks ran (3 hold, 1 fail); the judge's verdict counted: stands", { receipts: "rcpt_a,rcpt_b", ms: 87_000 });
    const fix = outcome("fix", "refused", "no fix is allowed without a valid copy; investigated and ticketed");
    const lone = outcome("investigate", "not_judged", "no model is configured, so no verdict was asked for", { disposition_id: "dsp-2" });
    const view = actView({ apply: true, plan: [], outcomes: [revert, revertUnverified, recreated, inv, fix, lone], acted: [] }, pass);
    const MAIL = "DNS record mail.example.invalid";
    const FILE = "conf.d/word-aaaaaa.conf on host-aaaaaa";
    expect(t.row("act", view, null).slice(1)).toEqual([
      ...shown("revert_record", MAIL, "done 1.2 s", "b2e7a764 → ad2e4ad7 · provider confirms", "1 probe ok"),
      ...shown("revert_record", MAIL, "unverified", "b2e7a764 → ad2e4ad7 · provider confirms", "no probe knew its name"),
      ...shown("revert_record", MAIL, "done 0.9 s", "absent → ad2e4ad7 · re-created, provider confirms", "1 probe ok"),
      ...shown("investigate", `FIX · ${FILE}`, "done 87.0 s", "4 checks, judge stands", "2 receipts"),
      ...shown("fix", FILE, "refused", "no fix is allowed without a valid copy"),
      ...shown("investigate", `ESCALATE · ${FILE}`, "not judged", "no model is configured, so no verdict was asked for"),
    ]);
    // the parts, joined on one line, are the owner's report's as before: an investigation's and a fix's without the object
    expect(joined(view)).toEqual([
      "            revert_record  DNS record mail.example.invalid · b2e7a764 → ad2e4ad7 · provider confirms · 1 probe ok · done 1.2 s",
      "            revert_record  DNS record mail.example.invalid · b2e7a764 → ad2e4ad7 · provider confirms · unverified · no probe knew its name",
      "            revert_record  DNS record mail.example.invalid · absent → ad2e4ad7 · re-created, provider confirms · 1 probe ok · done 0.9 s",
      "            investigate    FIX · 4 checks, judge stands · 2 receipts · done 87.0 s",
      "            fix            refused · no fix is allowed without a valid copy",
      "            investigate    ESCALATE · not judged · no model is configured, so no verdict was asked for",
    ]);
    expect(t.row("act", actView({ apply: true, plan: [], outcomes: [revert], acted: [] }), null)[1]).toBe("            revert_record  DNS record rec-0001");
  });

  it("reads both Nemotron calls off an investigation's record: receipt, short served model, checks, verdict and rows", () => {
    expect(shortModel("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free")).toBe("nemotron-3-ultra-550b-a55b");
    expect(shortModel("nemotron-3.5-lightning")).toBe("nemotron-3.5-lightning");
    expect(nemotronOf(LAB_INVESTIGATION.record)).toEqual({
      lightning: { receipt: "rcpt_req_nn4ag0yu", model: "nemotron-3.5-lightning", checks: 4 },
      judge: { status: "stands", receipt: "rcpt_req_iehg9gmt", model: "nemotron-3-ultra-550b-a55b", rows: 0 },
    });
    expect(nemotronOf(["judge refuted (receipt rcpt_b, nvidia/nemotron-3-ultra-550b-a55b, cache hit, route x): 2 row(s) satisfy the refuting SELECT, 2 rows"]).judge)
      .toEqual({ status: "refuted", receipt: "rcpt_b", model: "nemotron-3-ultra-550b-a55b", rows: 2 });
    expect(nemotronOf(["judge invalid_output (receipt rcpt_c, nvidia/nemotron-3-ultra-550b-a55b): refutation SQL failed to run: syntax error"]).judge)
      .toEqual({ status: "invalid_output", receipt: "rcpt_c", model: "nemotron-3-ultra-550b-a55b", rows: null });
    expect(nemotronOf(["judge not_judged (receipt none, no model): receipt gate: no receipt", "judge not called: no model is configured"])).toEqual({ lightning: null, judge: null });
  });

  it("an investigation names Lightning's checks and Ultra's verdict, each served model with its receipt id on a line of its own, at any width", () => {
    const inv = outcome("investigate", "done", LAB_INVESTIGATION.reason, { receipts: LAB_INVESTIGATION.receipts, record: LAB_INVESTIGATION.record, ms: 87_000 });
    const fix = outcome("fix", "refused", "no fix is allowed without a valid copy; investigated and ticketed");
    const res = { apply: true, plan: [], outcomes: [inv, fix], acted: [] };
    const rows = t.row("act", actView(res), 87_000);
    const FILE = "conf.d/word-aaaaaa.conf on host-aaaaaa";
    expect(rows).toEqual([
      at("  act       2 actions", "87.0 s"),
      ...shown("investigate", `FIX · ${FILE}`, "done 87.0 s", "Lightning picked 4 checks", "nemotron-3.5-lightning on rcpt_req_nn4ag0yu",
        "Ultra's refuting SELECT: 0 rows, stands", "nemotron-3-ultra-550b-a55b on rcpt_req_iehg9gmt", "both receipts verified"),
      ...shown("fix", FILE, "refused", "no fix is allowed without a valid copy"),
    ]);
    for (const s of ["rcpt_req_nn4ag0yu", "rcpt_req_iehg9gmt", "nemotron-3.5-lightning", "nemotron-3-ultra-550b-a55b"]) expect(rows.join("\n")).toContain(s);
    // one fact a line on a wider terminal too
    expect(new Table({ ...PLAIN, width: 160 }).row("act", actView(res), null).slice(1)).toEqual(rows.slice(1));
    // the owner's report joins the parts as before
    expect(joined(actView(res))[0]).toBe("            investigate    FIX · Lightning picked 4 checks · nemotron-3.5-lightning on rcpt_req_nn4ag0yu · Ultra's refuting SELECT: 0 rows, stands · nemotron-3-ultra-550b-a55b on rcpt_req_iehg9gmt · both receipts verified · done 87.0 s");
  });

  it("an investigation whose Lightning call gave no valid check names the default checks and Ultra's call", () => {
    const judge = "judge stands (receipt rcpt_req_88ch3rxi, openrouter/nvidia/nemotron-3-ultra-550b-a55b:free, cache miss, route openrouter/nvidia/nemotron-3-ultra-550b-a55b:free): the refuting SELECT returned no rows, 0 rows";
    const reason = "investigated: 3 checks ran (1 hold, 2 fail); the judge's verdict counted: stands";
    const expected = shown("investigate", "ESCALATE · conf.d/word-aaaaaa.conf on host-aaaaaa", "done 40.0 s", "default checks: 3", "Ultra's refuting SELECT: 0 rows, stands",
      "nemotron-3-ultra-550b-a55b on rcpt_req_88ch3rxi", "receipt verified");
    const silent = outcome("investigate", "done", reason, { receipts: "rcpt_req_88ch3rxi", ms: 40_000, record: [
      "Lightning did not answer: every route answered empty_response; the drift_vs_approved default checks ran: setting_matches_approved, change_in_last_backup, run_complete", judge,
    ] });
    expect(t.row("act", actView({ apply: true, plan: [], outcomes: [silent], acted: [] }), null).slice(1)).toEqual(expected);
    const empty = outcome("investigate", "done", reason, { receipts: "rcpt_x,rcpt_req_88ch3rxi", ms: 40_000, record: [
      "Lightning selection (receipt rcpt_x, openrouter/nvidia/nemotron-3.5-lightning, cache miss, route openrouter/nvidia/nemotron-3.5-lightning): 0 valid checks, 2 rejected",
      "Lightning's gated selection holds no valid check; the drift_vs_approved default checks ran: setting_matches_approved, change_in_last_backup, run_complete", judge,
    ] });
    expect(t.row("act", actView({ apply: true, plan: [], outcomes: [empty], acted: [] }), null).slice(1)).toEqual(expected);
  });

  it("colours each status: done green, failed red, unverified and not judged yellow, refused dim", () => {
    const c = new Table({ ...PLAIN, color: true });
    const text = c.row("act", actView({ apply: true, plan: [], acted: [], outcomes: [
      outcome("rollback_file", "done", "restored", { verification: "probe-1" }), outcome("rollback_file", "failed", "the write failed: exit 1"),
      outcome("rollback_file", "unverified", "written and reloaded; run run-x records no name the object serves, so no probe ran"), outcome("fix", "refused", "no fix"),
      outcome("investigate", "not_judged", "no model"),
    ] }), null).join("\n");
    for (const s of [`${ESC}[32mdone${ESC}[0m`, `${ESC}[31mfailed${ESC}[0m`, `${ESC}[33munverified${ESC}[0m`, `${ESC}[2mrefused${ESC}[0m`, `${ESC}[33mnot judged${ESC}[0m`]) expect(text).toContain(s);
  });

  it("a dry run plans: what each action would touch, from which commit, and what follows", () => {
    const plan: PlanItem[] = [
      { action_id: "act-1", kind: "rollback_file", disposition_id: "dsp-1", lines: [
        "target /etc/nginx/conf.d/word-aaaaaa.conf on host-aaaaaa (ssh alias fixture-host), ROLLBACK under rule-1",
        "write 2,807 bytes (sha256 3f565467a831) from vault commit 5dde7698 (copy cpy-1 of run run-0000000000000001, validated ok with 0 gaps) over the live file 4de292773ac4 as run run-0000000000000002 recorded it, through sudo -n tee",
        "then sudo -n nginx -t ...", "then probes http and tls of www.example.invalid, api.example.invalid",
      ] },
      { action_id: "act-2", kind: "revert_record", disposition_id: "dsp-2", lines: ["target record rec-0001 (mail.example.invalid, A) in zone example.invalid, ROLLBACK under rule-1", "PATCH the record's type, name, content, ttl and proxied to the approved copy at vault commit 0a1b2c3d (copy cpy-2): content from b2e7a764f9c0 to ad2e4ad71240"] },
      { action_id: "act-3", kind: "rollback_file", disposition_id: "dsp-3", lines: ["target linux.nginx host-aaaaaa /etc/nginx/conf.d/word-bbbbbb.conf file, ROLLBACK under rule-1"], refused: "the setting has no approval on record now; the Decider named commit 5dde7698 against one" },
      { action_id: "act-4", kind: "investigate", disposition_id: "dsp-4", lines: ["finding fnd-1: file in /etc/nginx/conf.d/word-cccccc.conf on host-aaaaaa, FIX under rule-1"] },
      { action_id: "act-5", kind: "fix", disposition_id: "dsp-4", lines: ["after the investigation: no fix is allowed without a valid copy; investigated and ticketed; the ticket stays open"], refused: "no fix is allowed without a valid copy; investigated and ticketed" },
    ];
    expect(t.row("act", actView({ apply: false, plan, outcomes: [], acted: [] }), 400)).toEqual([
      at("  act       5 actions planned", "0.4 s"),
      ...shown("rollback_file", "conf.d/word-aaaaaa.conf on host-aaaaaa", "from vault 5dde7698", "then nginx -t, reload, 2 probes"),
      ...shown("revert_record", "mail.example.invalid A", "from vault 0a1b2c3d", "then read back, dns probe"),
      ...shown("rollback_file", "conf.d/word-bbbbbb.conf on host-aaaaaa", "refused on --apply", "the setting has no approval on record now"),
      ...shown("investigate", "FIX · conf.d/word-cccccc.conf on host-aaaaaa", "checks, then the judge"),
      // a fix names its investigation's object
      ...shown("fix", "conf.d/word-cccccc.conf on host-aaaaaa", "refused on --apply", "no fix is allowed without a valid copy"),
    ]);
    expect(t.row("act", actView({ apply: false, plan: [], outcomes: [], acted: [{ action_id: "act-1", kind: "rollback_file", status: "done" }] }), null)[0])
      .toBe("  act       nothing to do · 1 action already recorded");
  });
});

// ---- the ticket lines -------------------------------------------------------------------------------------------

describe("the ticket lines", () => {
  const t = new Table(PLAIN);
  const ticket = (type: Ticket["type"], ext: string | null): Ticket => ({
    ticket_id: "tkt-1", tenant_id: "t1", psa: "github", external_id: ext, url: null, type, priority: "P1", status: "open", action_id: null, finding_id: "fnd-1", created_at: "", updated_at: "",
  });
  const TITLE = { change: "ROLLBACK drift_vs_approved: /etc/nginx/conf.d/app.conf on host-aaaaaa", incident: "FIX drift_vs_approved: /etc/nginx/conf.d/shop.conf on host-aaaaaa" } as const;
  const create = (type: Ticket["type"]): TicketOp => ({ op: "create", ticket: ticket(type, null), draft: { title: TITLE[type], labels: [], body: "" }, existing: false, close: null, note: null, reason: "r" } as unknown as TicketOp);
  const out = (status: TicketOutcome["status"], ext: string | null, line: string): TicketOutcome => ({ op: "create", ticket_id: "tkt-1", external_id: ext, status, line });

  it("one operation in the row, several under it, one a line with an opened issue's title under it, a failure in red words, and a dry run's plan", () => {
    expect(t.row("tickets", ticketsView({ ops: [create("change")], outcomes: [out("closed", "5", "created and closed #5 https://host-000000.com/x: create change")], open: 0 }, false), 3600)).toEqual([
      at("  tickets   #5 change · opened and closed", "3.6 s"),
      `              ${TITLE.change}`,
    ]);
    expect(t.row("tickets", ticketsView({ ops: [create("incident")], outcomes: [out("created", "3", "created #3 https://host-000000.com/x: create incident")], open: 0 }, false), null))
      .toEqual(["  tickets   #3 incident · opened", `              ${TITLE.incident}`]);
    expect(t.row("tickets", ticketsView({
      ops: [create("change"), { op: "close", ticket: ticket("incident", "2"), body: "", reason: "r" }, { op: "skip", finding_id: "fnd-2", reason: "HOLD" }, create("incident")],
      outcomes: [out("created", "6", "created and commented #6 https://host-000000.com/x: create change"), { op: "close", ticket_id: "tkt-1", external_id: "2", status: "closed", line: "closed #2" }, { op: "skip", ticket_id: null, external_id: null, status: "skipped", line: "skip" }, out("failed", null, "failed: create incident P1 tkt-1 (new row) for fnd-1: x (r): GitHub 502 Bad Gateway")],
      open: 1,
    }, false), null)).toEqual([
      "  tickets   3 tickets",
      "            #6 change · opened · left open, write unverified",
      `              ${TITLE.change}`,
      "            #2 incident · closed",
      "            new incident · failed · GitHub 502 Bad Gateway",
      `              ${TITLE.incident}`,
    ]);
    const close: TicketOp = { op: "close", ticket: ticket("change", "5"), body: "", reason: "finding fnd-1 is resolved in the pass over run-0b0dc83717dd3728, run-35ba6c1a2a987888; action act-1's write stands, unverified" };
    expect(t.row("tickets", ticketsView({
      ops: [create("change"), close, { op: "skip", finding_id: "fnd-2", reason: "HOLD" }],
      outcomes: [out("planned", null, "would create"), { op: "close", ticket_id: "tkt-1", external_id: "5", status: "planned", line: "would close" }, { op: "skip", ticket_id: null, external_id: null, status: "skipped", line: "skip" }],
      open: 2,
    }, true), null)).toEqual([
      "  tickets   would open 1 · would close 1",
      "            new change P1 · would open · fnd-1 r",
      `              ${TITLE.change}`,
      "            #5 change P1 · would close · fnd-1 resolved",
    ]);
    // a title past the width goes on in its own column
    expect(new Table({ ...PLAIN, width: 60 }).row("tickets", ticketsView({ ops: [create("change")], outcomes: [out("created", "7", "created #7")], open: 0 }, false), null)).toEqual([
      "  tickets   #7 change · opened",
      "              ROLLBACK drift_vs_approved:",
      "              /etc/nginx/conf.d/app.conf on host-aaaaaa",
    ]);
  });
});

// ---- a failing step, the done lines, the redactor ---------------------------------------------------------------

describe("a failing step and the done lines", () => {
  const t = new Table(PLAIN, (s) => s.replace(/fixture-secret-host/g, "host-000000"));

  it("a failing step is one row with its reason on one line, cut to the width; the done line says where the cycle stopped", () => {
    expect(t.failed("probe", "probe run run-4f41e1f662be63b5 is partial:\n  3 names unreadable", 2400)).toBe(at("  probe     failed        the probe run is partial: 3 names unreadable", "2.4 s"));
    const long = t.failed("collect", `a Cloudflare run finished other than complete: ${"x".repeat(200)}`, 100);
    expect(long).toHaveLength(90);
    expect(long).toMatch(/…  0\.1 s$/);
    expect(t.done({ ms: 41_600, steps: 9, skipped: 3, trace: "logs/cycle_test.jsonl" })).toBe("done · 9 steps · 3 skipped · 41.6 s · trace logs/cycle_test.jsonl");
    expect(t.done({ ms: 12_300, steps: 9, trace: "logs/cycle_test.jsonl", stopped: { step: "probe", at: 4, of: 9 } })).toBe("stopped at probe · 4 of 9 · 12.3 s · trace logs/cycle_test.jsonl");
    expect(t.done({ ms: 34_900, trace: "logs/pass_test.jsonl" })).toBe("done · 34.9 s · trace logs/pass_test.jsonl");
    // past the width the done line's phrases go on to a further line, two columns in, the words the same
    expect(new Table({ ...PLAIN, width: 60 }).done({ ms: 119_400, steps: 9, trace: "logs/cycle_test.jsonl", queries: { queries: 502, failed: 0 } }).split("\n"))
      .toEqual(["done · 9 steps · 119.4 s · 502 Zetaris queries, 0 failed", "  trace logs/cycle_test.jsonl"]);
    // the cycle's Zetaris queries before the trace, when given; failures red on a TTY
    expect(t.done({ ms: 119_400, steps: 9, trace: "logs/cycle_test.jsonl", queries: { queries: 502, failed: 0 } })).toBe("done · 9 steps · 119.4 s · 502 Zetaris queries, 0 failed · trace logs/cycle_test.jsonl");
    expect(t.done({ ms: 1_000, queries: { queries: 1, failed: 0 } })).toBe("done · 1.0 s · 1 Zetaris query, 0 failed");
    expect(new Table({ ...PLAIN, color: true }).done({ ms: 1_000, queries: { queries: 1_204, failed: 2 } })).toBe(`${ESC}[32mdone${ESC}[0m · 1.0 s · 1,204 Zetaris queries, ${ESC}[31m2 failed${ESC}[0m`);
  });

  it("passes every text through the redactor: header, subject, detail, reasons", () => {
    const lines = [
      t.header({ command: "cycle", tenant: "t1", at: new Date(0), mode: "dry run" }),
      ...t.row("probe", { subject: "fixture-secret-host", parts: ["fixture-secret-host"] }, 0),
      ...t.row("pass", { subject: "1 finding", parts: ["fixture-secret-host"], sub: [{ label: "ESCALATE", parts: ["on fixture-secret-host"] }] }, 0),
      t.failed("probe", "fixture-secret-host refused", 0),
    ].join("\n");
    expect(lines).not.toContain("fixture-secret-host");
    expect(lines).toContain("host-000000");
  });

  it("shows a collect row's ssh alias as configured (a LINUX_HOSTS key); its detail and every other subject pass the redactor", () => {
    const words = new Table(PLAIN, (s) => s.replace(/fixture-alias/g, "word-aaaaaa"), ["cloudflare", "fixture-alias"]);
    expect(words.row("collect", linuxView("fixture-alias", { files: 24, blocks: 46, settings: 761, hook: committed("1a2b3c4d5e6f") }), 3259)[0])
      .toBe(at("  collect   fixture-alias 24 files · 46 blocks · 761 settings · vault 1a2b3c4d", "3.3 s"));
    expect(words.row("collect", { ...linuxView("fixture-alias", { files: 1, blocks: 1, settings: 1, hook: { status: "off" } }), parts: ["read by fixture-alias"] }, null)[0])
      .toBe("  collect   fixture-alias read by word-aaaaaa");
    expect(words.skipped("collect", "fixture-alias", true)).toBe("  collect   fixture-alias skipped");
    expect(words.skipped("probe", "fixture-alias")).toBe("  probe     word-aaaaaa   skipped");
    expect(words.row("pass", { subject: "fixture-alias", parts: [] }, null)[0]).toBe("  pass      word-aaaaaa");
  });
});

// ---- what happened --------------------------------------------------------------------------------------------------

describe("the what-happened block", () => {
  const story = (o: Pick<StoryInput, "pass"> & Partial<StoryInput>): string[] => whatHappened({ act: null, actSettled: true, tickets: null, ...o });
  const applied = (...outcomes: ActionOutcome[]): StoryInput["act"] => ({ apply: true, plan: [], outcomes });
  const ticket = (type: Ticket["type"], ext: string | null, over: Partial<Ticket> = {}): Ticket => ({
    ticket_id: "tkt-1", tenant_id: "t1", psa: "github", external_id: ext, url: null, type, priority: "P1", status: "open", action_id: null, finding_id: "fnd-x", created_at: "", updated_at: "", ...over,
  });
  const create = (t: Ticket): TicketOp => ({ op: "create", ticket: t, draft: { title: "x", labels: [], body: "" }, existing: false, close: null, note: null, reason: "r" });
  const close = (t: Ticket, reason: string): TicketOp => ({ op: "close", ticket: t, body: "", reason });
  const out = (op: TicketOp["op"], status: TicketOutcome["status"], ext: string | null): TicketOutcome => ({ op, ticket_id: "tkt-1", external_id: ext, status, line: "" });
  const skip: [TicketOp, TicketOutcome] = [{ op: "skip", finding_id: "fnd-1", reason: "ADOPT opens no ticket" }, out("skip", "skipped", null)];
  const tickets = (...pairs: [TicketOp, TicketOutcome][]): TicketFacts => ({ ops: pairs.map(([op]) => op), outcomes: pairs.map(([, o]) => o) });
  const resolved = (ext: string, type: Ticket["type"] = "change"): TicketOp => close(ticket(type, ext, { ticket_id: `tkt-${ext}`, finding_id: `fnd-old-${ext}` }), `finding fnd-old-${ext} is resolved in the pass over run-a, run-b`);
  const okProbe = (n: number): string => `probe probe-${n}: http www.example.invalid ok (status 200 server=cloudflare cf-ray present)`;

  const RECORD = "cloudflare.dns rec-0001 content";
  const recordDrift = as(finding("ROLLBACK", "drift_vs_approved", "live value drifted from approved 9291bd74aaaa; vault commit 5ef406fc holds the approved copy, validated ok with 0 gaps, so rule rule-1 rolls it back to that copy", { setting_path: "content", dns_name: "mail.example.invalid" }), "fnd-0000000000000002");
  const fileDrift = as(finding("ROLLBACK", "drift_vs_approved", "live value drifted from approved 3f565467a831; vault commit 5dde7698 holds the approved copy, validated ok with 0 gaps, so rule rule-1 rolls it back to that copy", NGINX), "fnd-0000000000000004");
  const revertDone = outcome("revert_record", "done", "reverted to the approved copy at vault commit 5ef406fc; the record read back equals the copy field by field", {
    action_id: "act-revert", target: RECORD, before_hash: "sha256:8faef4a3", after_hash: "sha256:9291bd74", verification: "probe-1", ms: 2600,
  });

  it("the measured cycle of 25 Oct 2026 16:49 UTC: a revert done and closed, a ticket resolved, an escalation, the findings that stand", () => {
    const pass = {
      findings: [
        ...Array.from({ length: 20 }, () => as(finding("ADOPT", "proxied_without_real_ip", ""), "fnd-1", "operator")),
        ...Array.from({ length: 3 }, () => as(finding("ADOPT", "orphan_vhost", "", NGINX), "fnd-1", "operator")),
        ...Array.from({ length: 3 }, () => finding("HOLD", "orphan_record", "")), ...Array.from({ length: 2 }, () => finding("HOLD", "found_but_different", "")),
        recordDrift, as(escalate, "fnd-0000000000000003"),
      ],
    };
    const sentences = story({
      pass, act: applied(revertDone),
      tickets: tickets([create(ticket("change", null, { action_id: "act-revert", finding_id: recordDrift.id })), out("create", "closed", "6")], [resolved("5"), out("close", "closed", "5")], skip),
    });
    expect(sentences).toEqual([
      "A DNS record drifted from its approved value; the agent restored it from the vault copy, the provider confirmed it, and ticket #6 is closed.",
      "Ticket #5 from an earlier rollback is closed: the setting holds its approved value.",
      "1 finding is with a technician: name and its www treated differently by the proxy at www.example.invalid.",
      "23 findings are adopted under the technician's exceptions; 5 are held with an expiry.",
    ]);
    // the block: a blank line, the heading, each sentence wrapped at the width, two columns in and four after its first
    // line, every text through the redactor
    const t = new Table(PLAIN, (s) => s.replace(/www\.example\.invalid/g, "host-000000.invalid"));
    const block = t.story(sentences);
    expect(block.slice(0, 4)).toEqual([
      "",
      "what happened",
      "  A DNS record drifted from its approved value; the agent restored it from the vault copy,",
      "    the provider confirmed it, and ticket #6 is closed.",
    ]);
    expect(block.every((l) => l.length <= 90)).toBe(true);
    expect(sentencesOf(block)).toEqual(sentences.map((s) => s.replace("www.example.invalid", "host-000000.invalid")));
    expect(block.join("\n")).not.toContain("www.example.invalid");
    expect(t.story([])).toEqual([]);
    expect(new Table({ ...PLAIN, color: true }).story(["x"])[1]).toBe(`${ESC}[1mwhat happened${ESC}[0m`);
  });

  it("a rollback done, unverified, failed and refused; a file that went missing; a revert unverified", () => {
    const pass = { findings: [fileDrift] };
    const done = outcome("rollback_file", "done", "restored to the approved copy at vault commit 5dde7698; nginx -t passed, nginx reloaded, 3 probes ok", {
      action_id: "act-file", before_hash: BEFORE, after_hash: AFTER, verification: "probe-1,probe-2,probe-3", record: [okProbe(1), okProbe(2), okProbe(3)],
    });
    const closed = tickets([create(ticket("change", null, { action_id: "act-file" })), out("create", "closed", "7")]);
    expect(story({ pass, act: applied(done), tickets: closed })).toEqual([
      "A vhost file drifted from its approved copy; the agent restored it, nginx reloaded, 3 probes passed, and ticket #7 is closed.",
    ]);
    const unverified = outcome("rollback_file", "unverified", "written and reloaded; no probe of www.example.invalid ran (the account holds no record of these names)", { action_id: "act-file", before_hash: BEFORE, after_hash: AFTER });
    expect(story({ pass, act: applied(unverified), tickets: tickets([create(ticket("change", null, { action_id: "act-file" })), out("create", "created", "8")]) })).toEqual([
      "A vhost file drifted from its approved copy; the agent restored it, nginx reloaded, and the change could not be verified from outside; ticket #8 stays open until a pass finds it at its approved value.",
    ]);
    const failed = outcome("rollback_file", "failed", "nginx -t refused the copy: [emerg] unknown directive; the previous bytes were written back", { action_id: "act-file" });
    expect(story({ pass, act: applied(failed), tickets: tickets([create(ticket("change", null, { action_id: "act-file" })), out("create", "created", "10")]) })).toEqual([
      "A vhost file drifted from its approved copy; the restore failed (nginx -t refused the copy), and ticket #10 is open for a technician.",
    ]);
    const refused = outcome("rollback_file", "refused", "the live file is 9999aaaabbbb and the run recorded 4de292773ac4: it changed since the decision, and nothing was written");
    expect(story({ pass, act: applied(refused) })).toEqual(["A vhost file drifted from its approved copy; the agent left it as it is (changed since the decision)."]);
    const missing = { findings: [as(finding("ROLLBACK", "approved_missing", "", NGINX), "fnd-0000000000000006")] };
    expect(story({ pass: missing, act: applied({ ...done, record: [okProbe(1)] }) })).toEqual(["An approved vhost file went missing; the agent restored it, nginx reloaded, 1 probe passed."]);
    const revertUnverified = outcome("revert_record", "unverified", "reverted to the approved copy at vault commit 5ef406fc; the record read back equals the copy field by field; no dns probe ran", { target: RECORD });
    expect(story({ pass: { findings: [recordDrift] }, act: applied(revertUnverified) })).toEqual([
      "A DNS record drifted from its approved value; the agent restored it from the vault copy, the provider confirmed it, and the change could not be verified from outside.",
    ]);
  });

  it("an investigation and the fix it refuses are one sentence; an investigation alone goes to a technician", () => {
    const fixFinding = as(finding("FIX", "drift_vs_approved", "live value drifted from approved 3f565467a831 with no valid copy (1 copy in the vault, latest validation fail) and production affected (2 failing probes in run-x: http a, tls a), so rule rule-1 investigates, fixes where allowed, documents and opens a ticket", NGINX), "fnd-0000000000000005");
    const inv = outcome("investigate", "done", "investigated: 4 checks ran (3 hold, 1 fail); the judge's verdict counted: stands", { action_id: "act-inv", disposition_id: "dsp-5", receipts: "rcpt_a,rcpt_b" });
    const fix = outcome("fix", "refused", "no fix is allowed without a valid copy; investigated and ticketed", { action_id: "act-fix", disposition_id: "dsp-5" });
    const incident = tickets([create(ticket("incident", null, { action_id: "act-fix", finding_id: fixFinding.id })), out("create", "created", "9")]);
    expect(story({ pass: { findings: [fixFinding] }, act: applied(inv, fix), tickets: incident })).toEqual([
      "An approved setting with no valid copy affected production; the agent investigated with Nemotron and opened ticket #9 for a technician.",
    ]);
    const vhost = as(finding("ESCALATE", "orphan_vhost", "rule rule-4 investigates this orphan_vhost finding with production answering (2 probes of its names ok in run-x), so it goes to a technician", NGINX), "fnd-0000000000000007");
    const lone = outcome("investigate", "not_judged", "no model is configured, so no verdict was asked for", { disposition_id: "dsp-7" });
    expect(story({ pass: { findings: [vhost] }, act: applied(lone) })).toEqual([
      "A finding (site with no DNS record) needs a technician; the agent ran its checks (no model is configured, so no verdict was asked for).",
      "1 finding is with a technician: site with no DNS record at conf.d/word-aaaaaa.conf on host-aaaaaa.",
    ]);
  });

  it("an investigation whose record holds both Nemotron calls names Lightning and Ultra, each on a verified receipt", () => {
    const fixFinding = as(finding("FIX", "drift_vs_approved", "live value drifted from approved 0df3950bca45 with no valid copy (1 copy in the vault, latest validation unvalidated) and production affected (1 failing probe in run-x: http a), so rule rule-1 investigates, fixes where allowed, documents and opens a ticket", NGINX), "fnd-0000000000000005");
    const inv = outcome("investigate", "done", LAB_INVESTIGATION.reason, { action_id: "act-inv", disposition_id: "dsp-5", receipts: LAB_INVESTIGATION.receipts, record: LAB_INVESTIGATION.record });
    const fix = outcome("fix", "refused", "no fix is allowed without a valid copy; investigated and ticketed", { action_id: "act-fix", disposition_id: "dsp-5" });
    const incident = tickets([create(ticket("incident", null, { action_id: "act-fix", finding_id: fixFinding.id })), out("create", "created", "3")]);
    const sentences = story({ pass: { findings: [fixFinding] }, act: applied(inv, fix), tickets: incident });
    expect(sentences).toEqual([
      "An approved setting with no valid copy affected production; Nemotron Lightning picked the checks and Nemotron Ultra's refuting SELECT left the claim standing, each on a verified receipt; the agent opened ticket #3 for a technician.",
    ]);
    expect(sentences[0]).toMatch(/Lightning.*Ultra.*verified receipt/);
    const refuted = { ...inv, record: [LIGHTNING_LINE, JUDGE_LINE.replace("judge stands", "judge refuted").replace("the refuting SELECT returned no rows, 0 rows", "2 row(s) satisfy the refuting SELECT, 2 rows")] };
    expect(story({ pass: { findings: [fixFinding] }, act: applied(refuted, fix) })).toEqual([
      "An approved setting with no valid copy affected production; Nemotron Lightning picked the checks and Nemotron Ultra's refuting SELECT refuted the claim, each on a verified receipt.",
    ]);
    // the default checks ran: the sentence keeps its short form, the act line names Ultra's call
    expect(story({ pass: { findings: [fixFinding] }, act: applied({ ...inv, record: [JUDGE_LINE] }, fix), tickets: incident })).toEqual([
      "An approved setting with no valid copy affected production; the agent investigated with Nemotron and opened ticket #3 for a technician.",
    ]);
  });

  it("nothing to do: nothing changed, with what stands; nothing said when act gave no result", () => {
    expect(story({ pass: cleanPass, act: applied(), tickets: tickets(skip) })).toEqual([
      "Nothing changed on the estate; every finding stands as before.",
      "1 finding is with a technician: name and its www treated differently by the proxy at www.example.invalid.",
      "23 findings are adopted, 20 under the technician's exceptions and 3 under policy rules; 3 are held with an expiry.",
    ]);
    expect(story({ pass: { findings: [] }, act: applied() })).toEqual(["Nothing changed on the estate; the pass found every setting in order."]);
    // act skipped: settled, and nothing it could have changed
    expect(story({ pass: { findings: [] } })).toEqual(["Nothing changed on the estate; the pass found every setting in order."]);
    // act failed or stopped short: the block keeps to the findings
    expect(story({ pass: { findings: [] }, actSettled: false })).toEqual([]);
    expect(story({ pass: { findings: [finding("HOLD", "orphan_record", "")] }, actSettled: false })).toEqual(["1 finding is held with an expiry."]);
  });

  it("the escalations by class, and the tickets resolved, closed or due to close", () => {
    const esc = { findings: [as(escalate, "fnd-a"), as(escalate, "fnd-b"), finding("ESCALATE", "orphan_record", "2 of 3 checks fail")] };
    expect(story({ pass: esc, actSettled: false })).toEqual([
      "3 findings are with a technician: name and its www treated differently by the proxy (2); DNS record with no site behind it (1).",
    ]);
    const none = { findings: [] };
    expect(story({ pass: none, act: applied(), tickets: tickets([resolved("5"), out("close", "closed", "5")], [resolved("3", "incident"), out("close", "closed", "3")]) })).toEqual([
      "Tickets #5 and #3 from earlier rollbacks and holds are closed: their settings hold their approved values.",
    ]);
    expect(story({ pass: none, act: { apply: false, plan: [], outcomes: [] }, tickets: tickets([resolved("5"), out("close", "planned", null)]) })).toEqual([
      "Ticket #5 from an earlier rollback is due to close: the setting holds its approved value (tickets dry run).",
    ]);
  });

  it("a dry run says what --apply does for each planned action, naming the finding the pass gave it", () => {
    const decidedAt = "2026-10-25T16:49:00.000Z";
    const fixFinding = as(finding("FIX", "drift_vs_approved", "live value drifted from approved 3f565467a831 with no valid copy (none in the vault) and production affected (1 failing probe in run-x: http a), so rule rule-1 investigates, fixes where allowed, documents and opens a ticket", NGINX), "fnd-0000000000000008");
    const plan: PlanItem[] = [
      { action_id: "act-1", kind: "rollback_file", disposition_id: "dsp-1", lines: ["target /etc/nginx/conf.d/word-aaaaaa.conf on host-aaaaaa (ssh alias fixture-host), ROLLBACK under rule-1", "write 2,807 bytes (sha256 3f565467a831) from vault commit 5dde7698 (copy cpy-1) over the live file"] },
      { action_id: "act-2", kind: "revert_record", disposition_id: "dsp-2", lines: ["target record rec-0001 (mail.example.invalid, A) in zone example.invalid, ROLLBACK under rule-1", "PATCH the record to the approved copy at vault commit 0a1b2c3d (copy cpy-2)"] },
      { action_id: "act-3", kind: "rollback_file", disposition_id: "dsp-3", lines: ["target linux.nginx host-aaaaaa /etc/nginx/conf.d/word-bbbbbb.conf file, ROLLBACK under rule-1"], refused: "the setting has no approval on record now; the Decider named commit 5dde7698 against one" },
      { action_id: "act-4", kind: "investigate", disposition_id: dispositionIdOf(fixFinding, decidedAt), lines: ["finding fnd-1: file in /etc/nginx/conf.d/word-aaaaaa.conf on host-aaaaaa, FIX under rule-1"] },
      { action_id: "act-5", kind: "fix", disposition_id: dispositionIdOf(fixFinding, decidedAt), lines: ["after the investigation: no fix is allowed without a valid copy"], refused: "no fix is allowed without a valid copy; investigated and ticketed" },
    ];
    expect(story({ pass: { findings: [fixFinding], decidedAt }, act: { apply: false, plan, outcomes: [] } })).toEqual([
      "A vhost file drifted from its approved copy; a run with --apply restores it from vault copy 5dde7698 and reloads nginx.",
      "A DNS record drifted from its approved value; a run with --apply restores it from vault copy 0a1b2c3d.",
      "A vhost file drifted from its approved copy; a run with --apply leaves it as it is (the setting has no approval on record now).",
      "An approved setting with no valid copy affected production; a run with --apply investigates it with Nemotron and opens a ticket for a technician.",
    ]);
  });

  it("holds at most five sentences: past them the last action sentence counts the rest", () => {
    const refused = (i: number): ActionOutcome => outcome("rollback_file", "refused", "it changed since the decision", { action_id: `act-${i}`, disposition_id: `dsp-${i}` });
    const sentences = story({ pass: { findings: [finding("ADOPT", "orphan_vhost", "", NGINX)] }, act: applied(...Array.from({ length: 6 }, (_, i) => refused(i))) });
    expect(sentences).toHaveLength(STORY_MAX);
    expect(sentences.slice(3)).toEqual(["3 more actions are listed under act.", "1 finding is adopted under policy rules."]);
  });
});

describe("the causes in the what-happened block", () => {
  const story = (o: Pick<StoryInput, "pass"> & Partial<StoryInput>): string[] => whatHappened({ act: null, actSettled: true, tickets: null, ...o });
  const applied = (...outcomes: ActionOutcome[]): StoryInput["act"] => ({ apply: true, plan: [], outcomes });
  const decidedAt = "2026-10-25T15:53:30.000Z";
  const file = as(finding("ROLLBACK", "drift_vs_approved", "live value drifted from approved 3f565467a831; vault commit 5dde7698 holds the approved copy, validated ok with 0 gaps, so rule rule-1 rolls it back to that copy", NGINX), "fnd-0000000000000004");
  const record = as(finding("ROLLBACK", "drift_vs_approved", "live value drifted from approved 9291bd74aaaa; vault commit 5ef406fc holds the approved copy, validated ok with 0 gaps, so rule rule-1 rolls it back to that copy", { setting_path: "content", dns_name: "mail.example.invalid" }), "fnd-0000000000000002");
  const esc = as(escalate, "fnd-0000000000000003");
  const pass = { findings: [file, record, esc], decidedAt };
  const cause = (f: Finding, cls: CauseFacts["class"], summary: string, occurredAt: string | null, dispositionId = dispositionIdOf(f, decidedAt)): CauseFacts =>
    ({ disposition_id: dispositionId, finding_id: f.id, class: cls, summary, occurred_at: occurredAt });
  const EDIT = "The file was changed at 15:52 UTC by user-3f2a1c over ssh from ip-7c1d2e (sudo tee).";
  const ACCOUNT = "The record was changed at 16:48 UTC by a named account (mail-97a420@domain-503b27), from ip-6b6bba to 203.0.113.9.";
  const TOKEN = "The record was changed at 16:50 UTC through an API token.";
  const AGENT = "The last change to the file is the agent's own rollback at 15:54 UTC.";
  const UNKNOWN = "No record of who changed it: the journal window of 24 h holds 0 writes to the file and the audit log holds 0 events for the record.";
  const rollback = (status: ActionStatus, reason: string): ActionOutcome =>
    outcome("rollback_file", status, reason, { action_id: "act-file", disposition_id: dispositionIdOf(file, decidedAt), verification: status === "done" ? "probe-1,probe-2,probe-3" : "" });
  const revert = outcome("revert_record", "done", "reverted to the approved copy at vault commit 5ef406fc; the record read back equals the copy field by field", {
    action_id: "act-revert", target: "cloudflare.dns rec-0001 content", disposition_id: dispositionIdOf(record, decidedAt), verification: "probe-4", started_at: "2026-10-25T16:49:02.000Z",
  });
  const DONE = "A vhost file drifted from its approved copy; the agent restored it, nginx reloaded, 3 probes passed.";

  it("an applied restore carries who changed the setting on the same line, with the time from the change to the restore", () => {
    expect(story({ pass, act: applied(rollback("done", "restored")), causes: [cause(file, "operator_edit", EDIT, "2026-10-25T15:52:07.000Z")] })).toEqual([
      `${DONE} The file was changed at 15:52 UTC by user-3f2a1c over ssh from ip-7c1d2e (sudo tee), 2 minutes before the agent restored it.`,
      "1 finding is with a technician: name and its www treated differently by the proxy at www.example.invalid.",
    ]);
    expect(story({ pass: { findings: [record], decidedAt }, act: applied(revert), causes: [cause(record, "account_change", ACCOUNT, "2026-10-25T16:48:10.000Z")] })).toEqual([
      "A DNS record drifted from its approved value; the agent restored it from the vault copy, the provider confirmed it. The record was changed at 16:48 UTC by a named account (mail-97a420@domain-503b27), from ip-6b6bba to 203.0.113.9, under a minute before the agent restored it.",
    ]);
    // a restore that wrote nothing gives no restore clause; the agent's own change and an unknown one never carry one
    expect(story({ pass: { findings: [file], decidedAt }, act: applied(rollback("refused", "the live file changed since the decision")), causes: [cause(file, "operator_edit", EDIT, "2026-10-25T15:52:07.000Z")] })).toEqual([
      `A vhost file drifted from its approved copy; the agent left it as it is (changed since the decision). ${EDIT}`,
    ]);
    expect(story({ pass: { findings: [file], decidedAt }, act: applied(rollback("done", "restored")), causes: [cause(file, "agent", AGENT, "2026-10-25T15:54:03.000Z")] })).toEqual([`${DONE} ${AGENT}`]);
    expect(story({ pass: { findings: [file], decidedAt }, act: applied(rollback("done", "restored")), causes: [cause(file, "unknown", UNKNOWN, null)] })).toEqual([`${DONE} ${UNKNOWN}`]);
    // the block prints the action and its cause as one sentence, wrapped at the width
    const block = new Table(PLAIN).story([`${DONE} ${UNKNOWN}`]);
    expect(sentencesOf(block)).toEqual([`${DONE} ${UNKNOWN}`]);
    expect(block.length).toBeGreaterThan(3);
    expect(block.every((l) => l.length <= 90)).toBe(true);
  });

  it("a dry run's planned actions carry their causes and no restore clause", () => {
    const plan: PlanItem[] = [
      { action_id: "act-1", kind: "rollback_file", disposition_id: dispositionIdOf(file, decidedAt), lines: ["target /etc/nginx/conf.d/word-aaaaaa.conf on host-aaaaaa (ssh alias fixture-host), ROLLBACK under rule-1", "write 2,807 bytes (sha256 3f565467a831) from vault commit 5dde7698 (copy cpy-1) over the live file"] },
      { action_id: "act-2", kind: "revert_record", disposition_id: dispositionIdOf(record, decidedAt), lines: ["target record rec-0001 (mail.example.invalid, A) in zone example.invalid, ROLLBACK under rule-1", "PATCH the record to the approved copy at vault commit 0a1b2c3d (copy cpy-2)"] },
    ];
    const causes = [cause(file, "operator_edit", EDIT, "2026-10-25T15:52:07.000Z"), cause(record, "token_change", TOKEN, "2026-10-25T16:50:00.000Z")];
    expect(story({ pass: { findings: [file, record], decidedAt }, act: { apply: false, plan, outcomes: [] }, causes })).toEqual([
      `A vhost file drifted from its approved copy; a run with --apply restores it from vault copy 5dde7698 and reloads nginx. ${EDIT}`,
      `A DNS record drifted from its approved value; a run with --apply restores it from vault copy 0a1b2c3d. ${TOKEN}`,
    ]);
  });

  it("an escalation no action names carries its cause on the technician's line; one an investigation names carries it there, told once", () => {
    const token = cause(esc, "token_change", TOKEN, "2026-10-25T16:50:00.000Z");
    expect(story({ pass, causes: [token], actSettled: false })).toEqual([`1 finding is with a technician: name and its www treated differently by the proxy at www.example.invalid. ${TOKEN}`]);
    const inv = outcome("investigate", "not_judged", "no model is configured, so no verdict was asked for", { disposition_id: dispositionIdOf(esc, decidedAt) });
    expect(story({ pass: { findings: [esc], decidedAt }, act: applied(inv), causes: [token] })).toEqual([
      `A finding (name and its www treated differently by the proxy) needs a technician; the agent ran its checks (no model is configured, so no verdict was asked for). ${TOKEN}`,
      "1 finding is with a technician: name and its www treated differently by the proxy at www.example.invalid.",
    ]);
    // two escalations with the same sentence: it is said once
    const twin = as(escalate, "fnd-0000000000000009");
    expect(story({ pass: { findings: [esc, twin], decidedAt }, causes: [cause(esc, "unknown", UNKNOWN, null), cause(twin, "unknown", UNKNOWN, null)], actSettled: false })).toEqual([
      `2 findings are with a technician: name and its www treated differently by the proxy (2). ${UNKNOWN}`,
    ]);
  });

  it("a cause counts as part of its action's sentence: the cap stays at five and the last action sentence counts the rest", () => {
    const refused = (i: number): ActionOutcome => outcome("rollback_file", "refused", "it changed since the decision", { action_id: `act-${i}`, disposition_id: `dsp-${i}` });
    const causes = Array.from({ length: 6 }, (_, i) => cause(file, "operator_edit", EDIT, "2026-10-25T15:52:07.000Z", `dsp-${i}`));
    const sentences = story({ pass: { findings: [finding("ADOPT", "orphan_vhost", "", NGINX)] }, act: applied(...Array.from({ length: 6 }, (_, i) => refused(i))), causes });
    expect(sentences).toHaveLength(STORY_MAX);
    expect(sentences.slice(0, 3)).toEqual(Array(3).fill(`A vhost file drifted from its approved copy; the agent left it as it is (changed since the decision). ${EDIT}`));
    expect(sentences.slice(3)).toEqual(["3 more actions are listed under act.", "1 finding is adopted under policy rules."]);
  });
});

// ---- --verbose through the cycle ----------------------------------------------------------------------------------

describe("--verbose and --quiet through runCycle", () => {
  it("appends each step's full line after its short one, the what-happened block before the done line, and the CYCLE line after it", async () => {
    const ok = (summary: string, view?: StepReport["view"]): StepReport => ({ ok: true, summary, view });
    const steps: CycleSteps = {
      collectCloudflare: async () => ({ ...ok("collect:cloudflare: dns 58/58 complete", cloudflareView({ records: 1036, zones: 6, audit: 12, hook: committed("abcdef0123456789") })), commits: [] }),
      collectLinux: async () => ({ ...ok("x"), commits: [] }),
      probe: async () => ok("probe: fine"),
      validate: async () => ok("validate: fine"),
      pass: async () => ({ ...ok("PASS: tenant t1"), pass: { ...cleanPass, tenant: "t1" } as PassStep }),
      explain: async () => ok("explain: tenant t1, 1 cause(s) (unknown 1)", explainView({ causes: [{ class: "unknown" }] })),
      act: async () => ok("act: dry run: 0 actions planned"),
      tickets: async () => ok("TICKETS: fine"),
      document: async () => ok("document: fine"),
    };
    let ms = 0;
    const printed: string[] = [];
    const present: PresentOptions = { ...PLAIN, verbose: true };
    const res = await runCycle({ tenant: "t1", apply: false, aliases: [], skip: new Set(["probe", "validate", "act", "tickets", "document"] as const) }, steps, { print: (l) => printed.push(l), clock: () => (ms += 500), present });
    expect(printed.slice(0, 4)).toEqual([
      "ConfigLeaf · cycle · tenant t1 · 1970-01-01 00:00 UTC · dry run, nothing changed",
      at("  collect   cloudflare    1,036 records in 6 zones · audit 12 rows · vault abcdef01", "0.5 s"),
      "cycle: [1/8] collect:cloudflare ok in 0.5 s: collect:cloudflare: dns 58/58 complete",
      "  probe     skipped",
    ]);
    expect(printed[4]).toBe("cycle: [2/8] probe skipped in 0.0 s: skipped (--skip probe)");
    const pass = printed.findIndex((l) => l.startsWith("  pass "));
    expect(printed.slice(pass, pass + 11)).toEqual([
      at("  pass      27 findings   ADOPT 23 · HOLD 3 · ESCALATE 1", "0.5 s"),
      "            classes   20  proxied name, origin trusts no Cloudflare range",
      "                       3  DNS record with no site behind it",
      "                       3  site with no DNS record",
      "                       1  name and its www treated differently by the proxy",
      "            ESCALATE  name and its www treated differently by the proxy",
      "                      www.example.invalid",
      "                      the hold ran out at 25 Oct 03:21 UTC, a technician owns it",
      "cycle: [4/8] pass ok in 0.5 s: PASS: tenant t1",
      at("  explain   1 cause       unknown 1", "0.5 s"),
      "cycle: [5/8] explain ok in 0.5 s: explain: tenant t1, 1 cause(s) (unknown 1)",
    ]);
    // act skipped: nothing changed; the block sits between the last row and the done line, after a blank line
    const story = printed.indexOf("what happened");
    expect(printed.slice(story - 2, story)).toEqual(["cycle: [8/8] document skipped in 0.0 s: skipped (--skip document)", ""]);
    expect(sentencesOf(printed.slice(story - 1, -2))).toEqual([
      "Nothing changed on the estate; every finding stands as before.",
      "1 finding is with a technician: name and its www treated differently by the proxy at www.example.invalid.",
      "23 findings are adopted, 20 under the technician's exceptions and 3 under policy rules; 3 are held with an expiry.",
    ]);
    expect(printed.at(-2)).toMatch(/^done · 8 steps · 5 skipped · \d+\.\d s$/);
    expect(printed.at(-1)).toBe(res.summary);
    // --quiet: the header and the done line only
    const quiet: string[] = [];
    await runCycle({ tenant: "t1", apply: true, aliases: [], skip: new Set(["probe", "validate", "act", "tickets", "document"] as const) }, steps, { print: (l) => quiet.push(l), clock: () => (ms += 500), present: { ...PLAIN, quiet: true } });
    expect(quiet).toHaveLength(2);
    expect(quiet[0]).toBe("ConfigLeaf · cycle · tenant t1 · 1970-01-01 00:00 UTC · applying changes");
    expect(quiet[1]).toMatch(/^done · 8 steps · 5 skipped · /);
  });
});

// ---- a whole cycle at a terminal's width ----------------------------------------------------------------------------

describe("a whole cycle at 100 and 160 columns", () => {
  const ROWS = /^ {2}(collect|probe|validate|pass|explain|act|tickets|document) /;
  const UNKNOWN = "No record of who changed it: the audit log window of 18 h holds 0 events for the record, and the journal window of 24 h holds 0 writes to the file.";
  const pass = { ...cleanPass, tenant: "t1", decidedAt: "2026-10-26T00:46:00.000Z", adoptions: { rule: "exception_in_force", of: "pass", decidedAt: null, adoptions: 23, inForce: 23 } } as unknown as PassStep;
  const inv = outcome("investigate", "done", LAB_INVESTIGATION.reason, { action_id: "act-inv", disposition_id: dispositionIdOf(escalate, pass.decidedAt), receipts: LAB_INVESTIGATION.receipts, record: LAB_INVESTIGATION.record, ms: 87_000 });
  const rollback = outcome("rollback_file", "done", "restored to the approved copy at vault commit 5dde7698; nginx -t passed, nginx reloaded", {
    action_id: "act-file", before_hash: BEFORE, after_hash: AFTER, verification: "probe-1", ms: 2300, record: ["probe probe-1: http www.example.invalid ok (status 200 server=nginx cf-ray absent)"],
  });
  const ticket: Ticket = { ticket_id: "tkt-1", tenant_id: "t1", psa: "github", external_id: null, url: null, type: "incident", priority: "P1", status: "open", action_id: "act-inv", finding_id: escalate.id, created_at: "", updated_at: "" };
  const ops: TicketOp[] = [{ op: "create", ticket, draft: { title: "ESCALATE proxy_split: www.example.invalid and its www name, treated differently by the proxy since the hold ran out", labels: [], body: "" }, existing: false, close: null, note: null, reason: "r" }];
  const outcomes: TicketOutcome[] = [{ op: "create", ticket_id: "tkt-1", external_id: "7", status: "created", line: "created #7" }];
  const cause = { disposition_id: dispositionIdOf(escalate, pass.decidedAt), finding_id: escalate.id, class: "unknown", summary: UNKNOWN, occurred_at: null };
  const explain = { causes: [{ finding_id: escalate.id, disposition_id: cause.disposition_id, verb: "ESCALATE", finding_class: "proxy_split", cause, evidence: [] }], errors: [] } as unknown as NonNullable<StepReport["explain"]>;
  const ok = (summary: string, view?: StepReport["view"]): StepReport => ({ ok: true, summary, view });
  const steps: CycleSteps = {
    collectCloudflare: async () => ({ ...ok("collect:cloudflare: fine", cloudflareView({ records: 58, zones: 6, audit: 1036, hook: committed("0a1b2c3d4e5f") })), commits: [] }),
    collectLinux: async (a) => ({ ...ok("x", linuxView(a, { files: 24, blocks: 46, settings: 761, hook: committed("1a2b3c4d5e6f") })), commits: [] }),
    // a step with no view: its summary wraps in the detail's column
    probe: async () => ok(`probe: run complete, 12 names; ${Array.from({ length: 12 }, (_, i) => `http name-${i}.example.invalid ok`).join(", ")}`),
    validate: async () => ok("validate: fine", validateView({ heads: 3, nginx: ["ok", "fail"], rows: [{ validator: "cf-schema", result: "fail" }], errors: 1 })),
    pass: async () => ({ ...ok("PASS: tenant t1", passView(pass, { datasource: "DRIFT", queries: 453, rows: 28_712, failed: 0 })), pass }),
    explain: async () => ({ ...ok("explain: tenant t1, 1 cause(s) (unknown 1)", explainView({ causes: [cause] })), explain }),
    act: async () => {
      const res = { apply: true, plan: [], outcomes: [inv, rollback], acted: [] };
      return { ...ok("act: applied", actView(res, pass)), act: res };
    },
    tickets: async () => ({ ...ok("TICKETS: fine", ticketsView({ ops, outcomes, open: 1 }, false)), tickets: { ops, outcomes } }),
    document: async () => ok("document: fine", documentView({ file: "document.md", lines: 181, report: "report.html" })),
  };

  for (const width of [100, 160]) {
    it(`at ${width} columns no line passes the width, and each row's time sits at the width on its first line only`, async () => {
      const printed: string[] = [];
      let ms = 0;
      await runCycle({ tenant: "t1", apply: true, aliases: ["fixture-host"], skip: new Set() }, steps, {
        print: (l) => printed.push(l), clock: () => (ms += 1_700), present: { ...PLAIN, width }, trace: "logs/cycle_mvq1abcd.jsonl", queries: () => ({ queries: 495, rows: 30_000, failed: 0 }) as never,
      });
      const lines = printed.flatMap((l) => l.split("\n"));
      expect(lines.filter((l) => l.length > width)).toEqual([]);
      const rows = lines.filter((l) => ROWS.test(l));
      expect(rows.map((l) => l.slice(2, 11).trim())).toEqual(["collect", "collect", "probe", "validate", "pass", "explain", "act", "tickets", "document"]);
      for (const r of rows) expect(r).toMatch(new RegExp(`^.{${width - 5}}\\d\\.\\d s$`));
      // the lines that end in a time at the width are the rows' first lines and no others
      expect(lines.filter((l) => l.length === width && /\d\.\d s$/.test(l))).toEqual(rows);
      // the probe row's detail goes on in its column
      const probe = lines.findIndex((l) => l.startsWith("  probe "));
      expect(lines[probe + 1]).toMatch(/^ {12}\S/);
      // the pass, explain, act and tickets blocks, one fact a line
      for (const l of [
        "            Zetaris   453 queries · 28,712 rows · 0 failed",
        "            DQ        exception_in_force holds for 23 of 23 adoptions",
        "            ESCALATE  name and its www treated differently by the proxy",
        "                      www.example.invalid",
        "                      the hold ran out at 25 Oct 03:21 UTC, a technician owns it",
        "            ESCALATE  DNS record www.example.invalid · unknown",
        "            investigate    ESCALATE · DNS record www.example.invalid",
        "                           nemotron-3.5-lightning on rcpt_req_nn4ag0yu",
        "                           nemotron-3-ultra-550b-a55b on rcpt_req_iehg9gmt",
        "            rollback_file  conf.d/word-aaaaaa.conf on host-aaaaaa",
        "                           4de29277 → 3f565467 · nginx -t ok · reloaded",
      ]) expect(lines).toContain(l);
      const tickets = lines.findIndex((l) => l.startsWith("  tickets   #7 incident · opened "));
      expect(lines[tickets + 1]).toMatch(/^ {14}ESCALATE proxy_split: www\.example\.invalid and its www name,/);
      // the cause's sentence under the explain row from its own line, two columns past the verb's
      const explained = lines.indexOf("            ESCALATE  DNS record www.example.invalid · unknown");
      expect(lines[explained + 1]).toMatch(/^ {22}No record of who changed it: /);
      // the block after a blank line, each sentence two columns in and its further lines four
      const story = lines.indexOf("what happened");
      expect(lines[story - 1]).toBe("");
      expect(lines.slice(story + 1, -1).every((l) => /^ {2}\S/.test(l) || /^ {4}\S/.test(l))).toBe(true);
      expect(lines.at(-1)).toMatch(/trace logs\/cycle_mvq1abcd\.jsonl$/);
    });
  }
});
