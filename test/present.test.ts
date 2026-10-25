// The terminal view (src/loop/present.ts) over fixed step results: the columns and the time at the width, thousands,
// colour on a TTY and off under NO_COLOR, the finding lines for each verb, the action lines for each status, the
// ticket lines, a failing row and the done lines, the redactor over every text, and --verbose through runCycle.
// Offline and deterministic: every result is built here, with fixture names only.
import { describe, expect, it } from "vitest";
import type { ActionOutcome, PlanItem } from "../src/actions/plan.ts";
import type { Action, ActionKind, ActionStatus, Ticket } from "../src/data/rows.ts";
import { runCycle, type CycleSteps, type StepReport } from "../src/loop/cycle.ts";
import {
  FINDING_LINES, PLAIN, Table, actView, clause, cloudflareView, count, documentView, findingLine, hex8, linuxView, passView, presentOptions, probeView,
  seconds, shortUtc, thousands, ticketsView, utcMinute, validateView, withoutRunIds, type PresentOptions,
} from "../src/loop/present.ts";
import type { PassStep } from "../src/loop/pass.ts";
import type { Finding, Verb } from "../src/pipeline.ts";
import type { TicketOp } from "../src/psa/index.ts";
import type { TicketOutcome } from "../src/psa/step.ts";
import type { HookResult } from "../src/vault/hook.ts";

const ESC = "\u001b";
const plain = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
/** A row's text with its time at column `width`. */
const at = (text: string, t: string, width = 90): string => `${text}${" ".repeat(Math.max(2, width - text.length - t.length))}${t}`;

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
  it("colours a TTY unless NO_COLOR is set, aligns to its columns less one up to 120, and to 90 off a TTY", () => {
    expect(presentOptions({}, { isTTY: true, columns: 100 }, {})).toEqual({ color: true, width: 99, verbose: false, quiet: false });
    expect(presentOptions({}, { isTTY: true, columns: 300 }, {}).width).toBe(120);
    expect(presentOptions({ verbose: true }, { isTTY: true, columns: 100 }, { NO_COLOR: "1" })).toEqual({ color: false, width: 99, verbose: true, quiet: false });
    expect(presentOptions({}, { isTTY: true, columns: 100 }, { NO_COLOR: "" }).color).toBe(true);
    expect(presentOptions({ quiet: true }, { isTTY: false }, {})).toEqual({ color: false, width: 90, verbose: false, quiet: true });
  });
});

// ---- a clean dry run, step by step ----------------------------------------------------------------------------

const escalate = finding("ESCALATE", "proxy_split", "hold under rule rule-1 expired 2026-10-25T03:21:06.870Z; the finding stands");
const cleanPass = {
  findings: [
    ...Array.from({ length: 20 }, () => finding("ADOPT", "proxied_without_real_ip", "accepted exception lesson-1 holds until 2026-11-01T00:00:00.000Z")),
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
      t.header({ command: "cycle", tenant: "client-1", at: new Date("2026-10-25T15:38:05.430Z"), mode: "dry run" }),
      ...t.row("collect", cloudflareView({ records: 58, zones: 6, audit: 1036, hook: committed("0a1b2c3d4e5f60718293a4b5c6d7e8f901234567") }), 5756),
      ...t.row("collect", linuxView("fixture-host", { files: 24, blocks: 46, settings: 761, hook: committed("1a2b3c4d5e6f") }), 3259),
      ...t.row("probe", probeView({ names: 37, rows: probes }), 9815),
      ...t.row("validate", validateView({ heads: 3, nginx: ["ok_with_gaps", "ok_with_gaps"], rows: validation, errors: 0 }), 3497),
      ...t.row("pass", passView(cleanPass), 68593),
      ...t.row("act", actView({ apply: false, plan: [], outcomes: [], acted: [] }), 374),
      ...t.row("tickets", ticketsView({ ops: [{ op: "skip", finding_id: "fnd-1", reason: "HOLD" }], outcomes: [{ op: "skip", ticket_id: null, external_id: null, status: "skipped", line: "skip" }], open: 1 }, false), 1137),
      ...t.row("document", documentView({ file: "document.md", lines: 181 }), 16896),
      t.done({ ms: 112711, steps: 9, trace: "logs/cycle_test.jsonl" }),
    ];
    expect(screen).toEqual([
      "drift-agent · cycle · tenant client-1 · 2026-10-25 15:38 UTC · dry run",
      at("  collect   cloudflare    58 records in 6 zones · audit 1,036 rows · vault 0a1b2c3d", "5.8 s"),
      at("  collect   fixture-host  24 files · 46 blocks · 761 settings · vault 1a2b3c4d", "3.3 s"),
      at("  probe     37 names      http 27 ok · dns 34 ok · tls 30 ok · 20 failing", "9.8 s"),
      at("  validate  3 copies      nginx-t ok with gaps ×2 · cf-schema 42 ok, 16 with gaps", "3.5 s"),
      at("  pass      27 findings   ADOPT 23 · HOLD 3 · ESCALATE 1", "68.6 s"),
      "            proxied_without_real_ip 20 · orphan_record 3 · orphan_vhost 3 · proxy_split 1",
      "            ESCALATE  proxy_split www.example.invalid · hold expired 25 Oct 03:21 UTC",
      at("  act       nothing to do", "0.4 s"),
      at("  tickets   nothing to send · 1 open", "1.1 s"),
      at("  document  document.md · 181 lines", "16.9 s"),
      "done · 9 steps · 112.7 s · trace logs/cycle_test.jsonl",
    ]);
    // every row ends at column 90; the columns start at 2, 12 and 26
    for (const l of screen.filter((x) => /^  \S/.test(x))) {
      expect(l).toHaveLength(90);
      expect(l.slice(2, 12).trimEnd()).toMatch(/^(collect|probe|validate|pass|act|tickets|document)$/);
    }
  });

  it("widens the subject column to the longest subject it is given, and puts the time right after a row past the width", () => {
    const wide = new Table(PLAIN, (s) => s, ["cloudflare", "fixture-host-17ch"]);
    expect(wide.row("collect", linuxView("fixture-host-17ch", { files: 1, blocks: 2, settings: 3, hook: { status: "off" } }), 100)[0])
      .toBe(at("  collect   fixture-host-17ch 1 file · 2 blocks · 3 settings · vault off", "0.1 s"));
    expect(wide.row("collect", cloudflareView({ records: 1, zones: 1, audit: 0, hook: { status: "skipped", reason: "x" } }), 100)[0])
      .toBe(at("  collect   cloudflare        1 record in 1 zone · audit 0 rows · vault skipped", "0.1 s"));
    const long = t.row("act", { parts: ["x".repeat(100)] }, 100)[0];
    expect(long).toBe(`  act       ${"x".repeat(100)}  0.1 s`);
  });

  it("says nothing new when no vault commit came in, and names the repositories it could not validate", () => {
    expect(t.row("validate", validateView(null), 0)[0]).toBe(at("  validate  no new vault commit · nothing validated", "0.0 s"));
    expect(t.row("validate", validateView({ heads: 3, nginx: ["ok", "fail"], rows: [{ validator: "cf-schema", result: "fail" }], errors: 1 }), 0)[0])
      .toBe(at("  validate  3 copies      nginx-t ok, fail · cf-schema 1 fail · 1 repository not validated", "0.0 s"));
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

describe("the finding lines under the pass row", () => {
  const t = new Table(PLAIN);
  const line = (f: Finding): string => t.row("pass", { parts: [], sub: [findingLine(f)], labelWidth: 8 }, null)[1];

  it("a ROLLBACK names the object, what drifted and the copy it restores", () => {
    expect(line(finding("ROLLBACK", "drift_vs_approved", "live value drifted from approved 3f565467a831; vault commit 5dde7698 holds the approved copy, validated ok with 0 gaps, so rule rule-1 rolls it back to that copy", NGINX)))
      .toBe("            ROLLBACK  conf.d/word-aaaaaa.conf on host-aaaaaa · drifted from approved 3f565467 · copy 5dde7698 validated ok");
    expect(line(finding("ROLLBACK", "approved_missing", "approved 0123456789ab is absent from the run; vault commit 89abcdef holds the approved copy, validated ok_with_gaps with 16 gaps, so rule rule-1 restores it from that copy", NGINX)))
      .toBe("            ROLLBACK  conf.d/word-aaaaaa.conf on host-aaaaaa · approved 01234567 absent · copy 89abcdef validated ok with 16 gaps");
    expect(line(finding("ROLLBACK", "drift_vs_approved", "live value drifted from approved ad2e4ad71240; vault commit 0a1b2c3d holds the approved copy, validated ok with 0 gaps, so rule rule-1 rolls it back to that copy", { setting_path: "content", dns_name: "mail.example.invalid" })))
      .toBe("            ROLLBACK  mail.example.invalid content · drifted from approved ad2e4ad7 · copy 0a1b2c3d validated ok");
  });

  it("a FIX and an ESCALATE name the class, the object and why in a few words", () => {
    expect(line(finding("FIX", "drift_vs_approved", "live value drifted from approved 3f565467a831 with no valid copy (1 copy in the vault, latest validation fail) and production affected (2 failing probes in run-0000000000000002: http a.example.invalid, tls a.example.invalid), so rule rule-1 investigates, fixes where allowed, documents and opens a ticket", NGINX)))
      .toBe("            FIX       drift_vs_approved conf.d/word-aaaaaa.conf on host-aaaaaa · no valid copy · production affected, 2 failing probes");
    expect(line(escalate)).toBe("            ESCALATE  proxy_split www.example.invalid · hold expired 25 Oct 03:21 UTC");
    expect(line(finding("ESCALATE", "drift_vs_approved", "live value drifted from approved 3f565467a831 with no valid copy (none in the vault) and no probe run in this pass, so production is unknown and rule rule-1 sends it to a technician", NGINX)))
      .toBe("            ESCALATE  drift_vs_approved conf.d/word-aaaaaa.conf on host-aaaaaa · no valid copy · production unknown");
    expect(line(finding("ESCALATE", "orphan_record", "exception lapsed: lesson-1 expired 2026-10-20T00:00:00.000Z; re-raised to the technician, the checks alone would say ADOPT")))
      .toBe("            ESCALATE  orphan_record www.example.invalid · exception lapsed 20 Oct 00:00 UTC");
    expect(line(finding("ESCALATE", "orphan_record", "2 of 3 checks fail; the default policy escalates")))
      .toBe("            ESCALATE  orphan_record www.example.invalid · 2 of 3 checks fail");
  });

  it("ADOPT and HOLD stay in the counts; the lines run ROLLBACK, FIX, ESCALATE, the labels padded alike, and past the cap one line counts the rest", () => {
    const view = passView({ findings: [escalate, finding("ADOPT", "orphan_vhost", ""), finding("HOLD", "orphan_record", ""), finding("FIX", "orphan_vhost", "rule rule-4 investigates this orphan_vhost finding with production affected (1 failing probe in run-x: http a), and fixes where allowed", NGINX), finding("ROLLBACK", "drift_vs_approved", "", NGINX)] });
    const rows = t.row("pass", view, null);
    expect(rows[0]).toBe("  pass      5 findings    ROLLBACK 1 · FIX 1 · ADOPT 1 · HOLD 1 · ESCALATE 1");
    expect(rows.slice(2).map((l) => l.slice(12, 22))).toEqual(["ROLLBACK  ", "FIX       ", "ESCALATE  "]);
    expect(rows.join("\n")).not.toMatch(/ADOPT  |HOLD  /);
    // the label column stays put when the longest verb is absent
    expect(t.row("pass", passView({ findings: [escalate] }), null)[2]).toBe("            ESCALATE  proxy_split www.example.invalid · hold expired 25 Oct 03:21 UTC");
    expect(t.row("act", actView({ apply: true, plan: [], acted: [], outcomes: [outcome("fix", "refused", "no fix is allowed without a valid copy")] }), null)[1])
      .toBe("            fix            refused · no fix is allowed without a valid copy");
    const many = passView({ findings: Array.from({ length: FINDING_LINES + 3 }, () => escalate) });
    expect(many.sub!.length).toBe(1 + FINDING_LINES + 1);
    expect(t.row("pass", many, null).at(-1)).toBe("            3 more in the trace");
  });
});

// ---- the action lines -------------------------------------------------------------------------------------------

describe("the action lines under the act row", () => {
  const t = new Table(PLAIN);
  const probe = (id: string, kind: string, name: string, ray = true): string => `probe ${id}: ${kind} ${name} ok (status 200 server=cloudflare cf-ray ${ray ? "present" : "absent"})`;

  it("an applied rollback, each way it ends", () => {
    const done = outcome("rollback_file", "done", "restored to the approved copy at vault commit 3f565467; nginx -t passed, nginx reloaded, 3 probes of www.example.invalid ok", {
      before_hash: BEFORE, after_hash: AFTER, verification: "probe-1,probe-2,probe-3", ms: 2300,
      record: ["vault commit 3f565467 holds the copy", probe("probe-1", "http", "www.example.invalid"), probe("probe-2", "tls", "www.example.invalid", false), probe("probe-3", "http", "api.example.invalid")],
    });
    const unverified = outcome("rollback_file", "unverified", "written and reloaded; no probe of www.example.invalid ran (the account holds no record of these names)", { before_hash: BEFORE, after_hash: AFTER, ms: 1900 });
    const failed = outcome("rollback_file", "failed", "nginx -t refused the copy: [emerg] unknown directive in /etc/nginx/conf.d/word-aaaaaa.conf:3; the previous bytes were written back, the file is 4de292773ac4 again", { before_hash: BEFORE, after_hash: BEFORE });
    const probesFail = outcome("rollback_file", "failed", "written and reloaded; 1 of 2 probes fail: http www.example.invalid", { before_hash: BEFORE, after_hash: AFTER });
    const refused = outcome("rollback_file", "refused", "the live file is 9999aaaabbbb and run run-0000000000000001 recorded 4de292773ac4: it changed since the decision, and nothing was written");
    const rows = t.row("act", actView({ apply: true, plan: [], outcomes: [done, unverified, failed, probesFail, refused], acted: [] }), 9000);
    expect(rows).toEqual([
      at("  act       5 actions", "9.0 s"),
      "            rollback_file  4de29277 → 3f565467 · nginx -t ok · reloaded · 3 probes ok, cf-ray present · done 2.3 s",
      "            rollback_file  4de29277 → 3f565467 · nginx -t ok · reloaded · unverified · no probe knew its names",
      "            rollback_file  failed · nginx -t refused the copy",
      "            rollback_file  failed · 1 of 2 probes fail",
      "            rollback_file  refused · changed since the decision",
    ]);
  });

  it("a record revert, an investigation with its verb, and the fix it refuses", () => {
    const revert = outcome("revert_record", "done", "reverted to the approved copy at vault commit 0a1b2c3d; the record read back equals the copy field by field", {
      before_hash: "sha256:b2e7a764f9c0", after_hash: "sha256:ad2e4ad71240", verification: "probe-4", ms: 1200,
      record: ["probe probe-4: dns mail.example.invalid ok (status 200); resolvers answer from cache until the TTL (3600 s) passes"],
    });
    const revertUnverified = outcome("revert_record", "unverified", "reverted to the approved copy at vault commit 0a1b2c3d; the record read back equals the copy field by field; no dns probe of mail.example.invalid ran (the account holds no A, AAAA or CNAME record of this name)", { before_hash: "sha256:b2e7a764f9c0", after_hash: "sha256:ad2e4ad71240" });
    const inv = outcome("investigate", "done", "investigated: 4 checks ran (3 hold, 1 fail); the judge's verdict counted: stands", { receipts: "rcpt_a,rcpt_b", ms: 87_000 });
    const fix = outcome("fix", "refused", "no fix is allowed without a valid copy; investigated and ticketed");
    const lone = outcome("investigate", "not_judged", "no model is configured, so no verdict was asked for", { disposition_id: "dsp-2" });
    const rows = t.row("act", actView({ apply: true, plan: [], outcomes: [revert, revertUnverified, inv, fix, lone], acted: [] }), null);
    expect(rows.slice(1)).toEqual([
      "            revert_record  b2e7a764 → ad2e4ad7 · read back equal · 1 probe ok · done 1.2 s",
      "            revert_record  b2e7a764 → ad2e4ad7 · read back equal · unverified · no probe knew its name",
      "            investigate    FIX · 4 checks, judge stands · 2 receipts · done 87.0 s",
      "            fix            refused · no fix is allowed without a valid copy",
      "            investigate    ESCALATE · not judged · no model is configured, so no verdict was asked for",
    ]);
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
      "            rollback_file  conf.d/word-aaaaaa.conf on host-aaaaaa · from vault 5dde7698 · then nginx -t, reload, 2 probes",
      "            revert_record  mail.example.invalid A · from vault 0a1b2c3d · then read back, dns probe",
      "            rollback_file  conf.d/word-bbbbbb.conf on host-aaaaaa · refused on --apply · the setting has no approval on record now",
      "            investigate    FIX · conf.d/word-cccccc.conf on host-aaaaaa · checks, then the judge",
      "            fix            refused on --apply · no fix is allowed without a valid copy",
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
  const create = (type: Ticket["type"]): TicketOp => ({ op: "create", ticket: ticket(type, null), draft: { title: "x", labels: [], body: "" }, existing: false, close: null, note: null, reason: "r" } as unknown as TicketOp);
  const out = (status: TicketOutcome["status"], ext: string | null, line: string): TicketOutcome => ({ op: "create", ticket_id: "tkt-1", external_id: ext, status, line });

  it("one ticket in the row, several under it, a failure in red words, and a dry run's plan", () => {
    expect(t.row("tickets", ticketsView({ ops: [create("change")], outcomes: [out("closed", "5", "created and closed #5 https://host-000000.com/x: create change")], open: 0 }, false), 3600)[0])
      .toBe(at("  tickets   #5 change · opened and closed", "3.6 s"));
    expect(t.row("tickets", ticketsView({ ops: [create("incident")], outcomes: [out("created", "3", "created #3 https://host-000000.com/x: create incident")], open: 0 }, false), null)[0])
      .toBe("  tickets   #3 incident · opened");
    expect(t.row("tickets", ticketsView({
      ops: [create("change"), { op: "close", ticket: ticket("incident", "2"), body: "", reason: "r" }, { op: "skip", finding_id: "fnd-2", reason: "HOLD" }, create("incident")],
      outcomes: [out("created", "6", "created and commented #6 https://host-000000.com/x: create change"), { op: "close", ticket_id: "tkt-1", external_id: "2", status: "closed", line: "closed #2" }, { op: "skip", ticket_id: null, external_id: null, status: "skipped", line: "skip" }, out("failed", null, "failed: create incident P1 tkt-1 (new row) for fnd-1: x (r): GitHub 502 Bad Gateway")],
      open: 1,
    }, false), null)).toEqual([
      "  tickets   3 tickets",
      "            #6 change · opened · left open, write unverified",
      "            #2 incident · closed",
      "            new incident · failed · GitHub 502 Bad Gateway",
    ]);
    const close: TicketOp = { op: "close", ticket: ticket("change", "5"), body: "", reason: "finding fnd-1 is resolved in the pass over run-0b0dc83717dd3728, run-35ba6c1a2a987888; action act-1's write stands, unverified" };
    expect(t.row("tickets", ticketsView({
      ops: [create("change"), close, { op: "skip", finding_id: "fnd-2", reason: "HOLD" }],
      outcomes: [out("planned", null, "would create"), { op: "close", ticket_id: "tkt-1", external_id: "5", status: "planned", line: "would close" }, { op: "skip", ticket_id: null, external_id: null, status: "skipped", line: "skip" }],
      open: 2,
    }, true), null)).toEqual(["  tickets   would open 1 · would close 1", "            new change P1 · would open · fnd-1 r", "            #5 change P1 · would close · fnd-1 resolved"]);
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

// ---- --verbose through the cycle ----------------------------------------------------------------------------------

describe("--verbose through runCycle", () => {
  it("appends each step's full line after its short one, and the CYCLE line after the done line", async () => {
    const ok = (summary: string, view?: StepReport["view"]): StepReport => ({ ok: true, summary, view });
    const steps: CycleSteps = {
      collectCloudflare: async () => ({ ...ok("collect:cloudflare: dns 58/58 complete", cloudflareView({ records: 1036, zones: 6, audit: 12, hook: committed("abcdef0123456789") })), commits: [] }),
      collectLinux: async () => ({ ...ok("x"), commits: [] }),
      probe: async () => ok("probe: fine"),
      validate: async () => ok("validate: fine"),
      pass: async () => ({ ...ok("PASS: tenant t1"), pass: { ...cleanPass, tenant: "t1" } as PassStep }),
      act: async () => ok("act: dry run: 0 actions planned"),
      tickets: async () => ok("TICKETS: fine"),
      document: async () => ok("document: fine"),
    };
    let ms = 0;
    const printed: string[] = [];
    const present: PresentOptions = { ...PLAIN, verbose: true };
    const res = await runCycle({ tenant: "t1", apply: false, aliases: [], skip: new Set(["probe", "validate", "act", "tickets", "document"] as const) }, steps, { print: (l) => printed.push(l), clock: () => (ms += 500), present });
    expect(printed.slice(0, 4)).toEqual([
      "drift-agent · cycle · tenant t1 · 1970-01-01 00:00 UTC · dry run",
      at("  collect   cloudflare    1,036 records in 6 zones · audit 12 rows · vault abcdef01", "0.5 s"),
      "cycle: [1/7] collect:cloudflare ok in 0.5 s: collect:cloudflare: dns 58/58 complete",
      "  probe     skipped",
    ]);
    expect(printed[4]).toBe("cycle: [2/7] probe skipped in 0.0 s: skipped (--skip probe)");
    const pass = printed.findIndex((l) => l.startsWith("  pass "));
    expect(printed.slice(pass, pass + 4)).toEqual([
      at("  pass      27 findings   ADOPT 23 · HOLD 3 · ESCALATE 1", "0.5 s"),
      "            proxied_without_real_ip 20 · orphan_record 3 · orphan_vhost 3 · proxy_split 1",
      "            ESCALATE  proxy_split www.example.invalid · hold expired 25 Oct 03:21 UTC",
      "cycle: [4/7] pass ok in 0.5 s: PASS: tenant t1",
    ]);
    expect(printed.at(-2)).toMatch(/^done · 7 steps · 5 skipped · \d+\.\d s$/);
    expect(printed.at(-1)).toBe(res.summary);
  });
});
