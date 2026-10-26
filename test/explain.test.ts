// The explainer (src/explain/): the window rule, the ledger match at 15 s and 90 s, every cause class over injected
// rows with its sentence byte for byte, the restore clause, the diff, and explainPass over sql.js with
// test/fixtures/policy-bundle.json and the Actor's fixture vault, written, read back and idempotent; the approval's
// own commit in the diff header when a later commit holds the same bytes; the explain step's row. Offline and deterministic: documentation names and addresses, pseudonyms only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import type { Action, AuditEvent } from "../src/data/rows.ts";
import { DriftWorld } from "../src/engine/world.ts";
import {
  AGENT_AUDIT_MS, AGENT_JOURNAL_MS, causeWindow, explainFinding, explains, journalHostOf, restoreClause, timelineLine, withRestore, type CauseInput,
} from "../src/explain/cause.ts";
import { DIFF_MAX_LINES, unifiedDiff, valueDiff } from "../src/explain/diff.ts";
import { MemoryCauseSink, approvalCopy, causeEvidence, causeSentence, causesByDisposition, explainPass } from "../src/explain/explain.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { dispositionIdOf, passStep, type PassStep } from "../src/loop/pass.ts";
import { PLAIN, Table, explainView } from "../src/loop/present.ts";
import { explainStep } from "../src/loop/steps.ts";
import { Redactor } from "../src/redactor.ts";
import { ALIAS, AT, HOST, TENANT, buildBase, type Base } from "./fixtures/actions/world.ts";
import { MemTracer } from "./fixtures/mem-tracer.ts";

const redactor = new Redactor("explain-test-salt");
const H = "host-3a4b5c";
const PATH = "/etc/nginx/conf.d/app.conf";
const REC = "rec-0001";
const DISP = "disp-0000000000000001";

const fileFinding = (over: Partial<CauseInput["finding"]["finding"]> = {}, verb: CauseInput["finding"]["verb"] = "ROLLBACK"): CauseInput["finding"] => ({
  id: "fnd-0000000000000001", verb, finding: { class: "drift_vs_approved", surface: "linux.nginx", host: H, object_id: PATH, setting_path: "file", resource_id: null, ...over },
});
const recordFinding = (verb: CauseInput["finding"]["verb"] = "ROLLBACK"): CauseInput["finding"] => ({
  id: "fnd-0000000000000002", verb, finding: { class: "drift_vs_approved", surface: "cloudflare.dns", host: null, object_id: REC, setting_path: "content", resource_id: REC },
});

const journal = (id: string, at: string, actor: string | null, action: string, o: { path?: string | null; from?: string; host?: string } = {}): AuditEvent => ({
  event_id: id, tenant_id: "t1", source: "journal", actor, action,
  resource_type: action === "ssh_login" ? "session" : o.path ? "file" : null, resource_id: o.path === undefined ? (action === "ssh_login" ? null : PATH) : o.path,
  old_value: o.from ?? null, new_value: `${action === "ssh_login" ? "publickey" : `/usr/bin/${action}${o.path === null ? "" : ` -- ${o.path ?? PATH}`}`} on ${o.host ?? H}`, occurred_at: at,
});
const cloudflare = (id: string, at: string, actor: string | null, action = "update"): AuditEvent => ({
  event_id: id, tenant_id: "t1", source: "cloudflare", actor, action, resource_type: "dns_records/", resource_id: REC, old_value: null, new_value: null, occurred_at: at,
});
const action = (id: string, kind: Action["kind"], started: string, finished: string, o: { status?: Action["status"]; target?: string } = {}): Action => ({
  action_id: id, tenant_id: "t1", kind, target: o.target ?? (kind === "revert_record" ? `cloudflare.dns ${REC} content` : `linux.nginx ${H} ${PATH} file`),
  before_hash: null, after_hash: null, vault_commit: null, verification: "", receipts: "", status: o.status ?? "done", reason: "", record: "", started_at: started, finished_at: finished, disposition_id: DISP,
});

const input = (over: Partial<CauseInput>): CauseInput => ({
  tenantId: "t1", finding: fileFinding(), dispositionId: DISP, decidedAt: "2026-10-25T16:00:00.000Z", approvedAt: "2026-10-25T09:00:00.000Z", lastMatched: null,
  events: [], actions: [], diff: null, redactor, ...over,
});

const LOGIN = journal("evt-login-1", "2026-10-25T15:40:03.000Z", "user-3f2a1c", "ssh_login", { from: "ip-7c1d2e" });
const TEE = journal("evt-tee-1", "2026-10-25T15:52:07.000Z", "user-3f2a1c", "tee");

describe("the window", () => {
  it("runs from the current approval to the pass; with none, from the earlier of the last match and 24 h back", () => {
    const to = "2026-10-25T16:00:00.000Z";
    expect(causeWindow({ approvedAt: "2026-10-20T09:00:00.000Z", lastMatched: "2026-10-25T15:00:00.000Z", to })).toEqual({ from: "2026-10-20T09:00:00.000Z", to });
    expect(causeWindow({ approvedAt: null, lastMatched: "2026-10-25T15:00:00.000Z", to })).toEqual({ from: "2026-10-24T16:00:00.000Z", to });
    expect(causeWindow({ approvedAt: null, lastMatched: "2026-10-22T02:01:00.000Z", to })).toEqual({ from: "2026-10-22T02:01:00.000Z", to });
    expect(causeWindow({ approvedAt: null, lastMatched: null, to })).toEqual({ from: "2026-10-24T16:00:00.000Z", to });
  });

  it("leaves out rows before the window and after the pass", () => {
    const early = journal("evt-tee-0", "2026-10-25T08:59:59.000Z", "user-3f2a1c", "tee");
    const late = journal("evt-tee-9", "2026-10-25T16:00:01.000Z", "user-3f2a1c", "tee");
    const c = explainFinding(input({ events: [early, late] }));
    expect(c.row.class).toBe("unknown");
    expect(c.row.summary).toBe("No record of who changed it: the journal window of 7 h holds 0 writes to the file.");
  });
});

describe("which findings are explained", () => {
  it("every ROLLBACK, FIX and ESCALATE, and a HOLD of the four drift classes only", () => {
    const f = (verb: CauseInput["finding"]["verb"], cls: string) => ({ verb, finding: { class: cls as never } });
    expect(["ROLLBACK", "FIX", "ESCALATE"].every((v) => explains(f(v as never, "proxy_split")))).toBe(true);
    expect(["drift_vs_approved", "approved_missing", "dns_change", "found_but_different"].every((c) => explains(f("HOLD", c)))).toBe(true);
    expect(explains(f("HOLD", "changed_since_backup"))).toBe(false);
    expect(explains(f("ADOPT", "drift_vs_approved"))).toBe(false);
  });
});

describe("the cause classes over injected rows, sentence by sentence", () => {
  it("operator_edit: a user's sudo write, the nearest earlier login within 2 h giving the source address", () => {
    const c = explainFinding(input({ events: [LOGIN, TEE] }));
    expect(c.row).toMatchObject({ class: "operator_edit", actor: "user-3f2a1c", mechanism: "sudo tee", occurred_at: "2026-10-25T15:52:07.000Z", source_host: "ip-7c1d2e" });
    expect(c.row.summary).toBe("The file was changed at 15:52 UTC by user-3f2a1c over ssh from ip-7c1d2e (sudo tee).");
    expect(JSON.parse(c.row.evidence_ids)).toEqual(["evt-login-1", "evt-tee-1"]);
    expect(c.evidence.map(timelineLine)).toEqual([
      "2026-10-25 15:40:03 UTC · journal · user-3f2a1c · ssh_login · from ip-7c1d2e",
      "2026-10-25 15:52:07 UTC · journal · user-3f2a1c · tee · /etc/nginx/conf.d/app.conf",
    ]);
    // the agent restored it two minutes later: the reader adds the clause
    const restored = [action("act-1", "rollback_file", "2026-10-25T15:54:10.000Z", "2026-10-25T15:54:12.000Z")];
    expect(causeSentence(c.row, restored)).toBe("The file was changed at 15:52 UTC by user-3f2a1c over ssh from ip-7c1d2e (sudo tee), 2 minutes before the agent restored it.");
  });

  it("operator_edit without an address: the login is over 2 h old, another user's, or to another host", () => {
    const old = journal("evt-login-0", "2026-10-25T13:52:06.000Z", "user-3f2a1c", "ssh_login", { from: "ip-111111" });
    const other = journal("evt-login-2", "2026-10-25T15:50:00.000Z", "user-999999", "ssh_login", { from: "ip-222222" });
    const elsewhere = journal("evt-login-3", "2026-10-25T15:51:00.000Z", "user-3f2a1c", "ssh_login", { from: "ip-333333", host: "host-999999" });
    const c = explainFinding(input({ events: [old, other, elsewhere, TEE] }));
    expect(c.row.summary).toBe("The file was changed at 15:52 UTC by user-3f2a1c (sudo tee).");
    expect(c.row.source_host).toBeNull();
  });

  it("a write on another host is not this file's; a row naming no host is matched by path", () => {
    const there = journal("evt-tee-2", "2026-10-25T15:52:07.000Z", "user-3f2a1c", "tee", { host: "host-999999" });
    expect(journalHostOf(there)).toBe("host-999999");
    expect(explainFinding(input({ events: [there] })).row.class).toBe("unknown");
    const nameless = { ...TEE, new_value: "/usr/bin/tee -- /etc/nginx/conf.d/app.conf" };
    expect(journalHostOf(nameless)).toBeNull();
    expect(explainFinding(input({ events: [nameless] })).row.class).toBe("operator_edit");
    // a read of the file is not a write
    expect(explainFinding(input({ events: [journal("evt-cat-1", "2026-10-25T15:52:07.000Z", "user-3f2a1c", "cat")] })).row.class).toBe("unknown");
  });

  it("agent: a journal write within 15 s of the agent's rollback_file on that host and file; 16 s is a person's", () => {
    const rollback = action("act-1", "rollback_file", "2026-10-25T15:54:00.000Z", "2026-10-25T15:54:02.000Z");
    const own = journal("evt-tee-2", new Date(Date.parse("2026-10-25T15:54:02.000Z") + AGENT_JOURNAL_MS).toISOString(), "user-aaaaaa", "tee");
    const c = explainFinding(input({ events: [LOGIN, TEE, own], actions: [rollback] }));
    expect(c.row).toMatchObject({ class: "agent", actor: "drift-agent", mechanism: "rollback_file", occurred_at: "2026-10-25T15:54:17.000Z" });
    expect(c.row.summary).toBe("The last change to the file is the agent's own rollback at 15:54 UTC.");
    expect(JSON.parse(c.row.evidence_ids)).toEqual(["evt-tee-1", "act-1", "evt-tee-2"]);
    // the agent's own change gets no restore clause
    expect(causeSentence(c.row, [rollback])).toBe(c.row.summary);
    const late = { ...own, event_id: "evt-tee-3", occurred_at: "2026-10-25T15:54:18.000Z" };
    const p = explainFinding(input({ events: [TEE, late], actions: [rollback] }));
    expect(p.row).toMatchObject({ class: "operator_edit", actor: "user-aaaaaa", occurred_at: "2026-10-25T15:54:18.000Z" });
    // a write before the action started counts the same 15 s; a refused rollback wrote nothing and matches nothing
    const before = { ...own, event_id: "evt-tee-4", occurred_at: "2026-10-25T15:53:45.000Z" };
    expect(explainFinding(input({ events: [before], actions: [rollback] })).row.class).toBe("agent");
    expect(explainFinding(input({ events: [before], actions: [{ ...rollback, status: "refused" }] })).row.class).toBe("operator_edit");
    // the rollback of the same file on another host is not this one's
    expect(explainFinding(input({ events: [before], actions: [{ ...rollback, target: `linux.nginx host-999999 ${PATH} file` }] })).row.class).toBe("operator_edit");
  });

  it("automation: certbot touching nginx while the file sits under /etc/nginx/", () => {
    const certbot: AuditEvent = { ...journal("evt-cb-1", "2026-10-25T03:12:44.000Z", null, "certbot", { path: null }), new_value: "Deploying certificate to nginx for app.example.invalid on host-3a4b5c" };
    const c = explainFinding(input({ approvedAt: "2026-10-24T09:00:00.000Z", events: [certbot] }));
    expect(c.row).toMatchObject({ class: "automation", actor: "certbot", mechanism: "renewal", occurred_at: "2026-10-25T03:12:44.000Z" });
    expect(c.row.summary).toBe("The file was changed at 03:12 UTC by certbot (renewal).");
    // a write by a user is the earlier rule
    expect(explainFinding(input({ approvedAt: "2026-10-24T09:00:00.000Z", events: [TEE, { ...certbot, occurred_at: "2026-10-25T15:58:00.000Z" }] })).row.class).toBe("operator_edit");
  });

  it("account_change: a cloudflare event on the record with an actor, the values as the redactor leaves them", () => {
    const ev = cloudflare("evt-cf-1", "2026-10-25T16:48:30.000Z", "mail-97a420@domain-503b27");
    const c = explainFinding(input({ finding: recordFinding(), decidedAt: "2026-10-25T17:00:00.000Z", events: [ev], values: { from: "ip-6b6bba", to: "203.0.113.9" } }));
    expect(c.row).toMatchObject({ class: "account_change", actor: "mail-97a420@domain-503b27", mechanism: "dashboard or API", occurred_at: "2026-10-25T16:48:30.000Z" });
    expect(c.row.summary).toBe("The record was changed at 16:48 UTC by a named account (mail-97a420@domain-503b27), from ip-6b6bba to 203.0.113.9.");
  });

  it("token_change: an event with no actor that is not the agent's; within 90 s of a revert_record it is the agent's", () => {
    const ev = cloudflare("evt-cf-2", "2026-10-25T16:50:05.000Z", null);
    const at = { finding: recordFinding(), decidedAt: "2026-10-25T17:00:00.000Z" };
    const c = explainFinding(input({ ...at, events: [ev] }));
    expect(c.row).toMatchObject({ class: "token_change", actor: null, mechanism: "API token" });
    expect(c.row.summary).toBe("The record was changed at 16:50 UTC through an API token.");
    const revert = action("act-2", "revert_record", "2026-10-25T16:49:00.000Z", "2026-10-25T16:49:01.000Z");
    const inTime = { ...ev, occurred_at: new Date(Date.parse("2026-10-25T16:49:01.000Z") + AGENT_AUDIT_MS).toISOString() };
    const a = explainFinding(input({ ...at, events: [inTime], actions: [revert] }));
    expect(a.row.class).toBe("agent");
    expect(a.row.summary).toBe("The last change to the record is the agent's own revert at 16:50 UTC.");
    const late = { ...ev, occurred_at: "2026-10-25T16:50:32.000Z" };
    expect(explainFinding(input({ ...at, events: [late], actions: [revert] })).row.class).toBe("token_change");
    // a named account is never the agent: its event is an account_change whatever the ledger holds
    expect(explainFinding(input({ ...at, events: [{ ...inTime, actor: "mail-97a420@domain-503b27" }], actions: [revert] })).row.class).toBe("account_change");
  });

  it("unknown: nothing in the window, the sentence giving the window and what it holds", () => {
    const hero = fileFinding({ class: "dns_change", setting_path: "server.location./.proxy_pass", resource_id: REC }, "HOLD");
    const c = explainFinding(input({ finding: hero, approvedAt: null, lastMatched: "2026-10-25T15:00:00.000Z" }));
    expect(c.row).toMatchObject({ class: "unknown", actor: null, mechanism: null, occurred_at: null, evidence_ids: "[]", window_from: "2026-10-24T16:00:00.000Z" });
    expect(c.row.summary).toBe("No record of who changed it: the journal window of 24 h holds 0 writes to the file and the audit log holds 0 events for the record.");
    expect(explainFinding(input({ finding: recordFinding(), approvedAt: null })).row.summary).toBe("No record of who changed it: the audit log window of 24 h holds 0 events for the record.");
    // found_but_different is byte-identical on the host: a write to the file is not its cause, the record alone is looked at
    const fbd = { ...hero, finding: { ...hero.finding, class: "found_but_different" as const } };
    expect(explainFinding(input({ finding: fbd, approvedAt: null, events: [TEE] })).row.summary).toBe("No record of who changed it: the audit log window of 24 h holds 0 events for the record.");
    expect(causeSentence(c.row, [action("act-1", "rollback_file", "2026-10-25T15:54:10.000Z", "2026-10-25T15:54:12.000Z")])).toBe(c.row.summary);
  });

  it("first match wins: a user's write on the file before a named account's event on the record it rests on", () => {
    const hero = fileFinding({ class: "dns_change", setting_path: "server.location./.proxy_pass", resource_id: REC }, "ESCALATE");
    const c = explainFinding(input({ finding: hero, events: [TEE, cloudflare("evt-cf-1", "2026-10-25T15:58:00.000Z", "mail-97a420@domain-503b27")] }));
    expect(c.row.class).toBe("operator_edit");
    expect(JSON.parse(c.row.evidence_ids)).toEqual(["evt-tee-1", "evt-cf-1"]);
  });

  it("an instant on another day than the pass names the day", () => {
    const c = explainFinding(input({ approvedAt: "2026-10-20T09:00:00.000Z", events: [{ ...TEE, occurred_at: "2026-10-24T15:52:07.000Z" }] }));
    expect(c.row.summary).toBe("The file was changed at 15:52 UTC on 24 Oct by user-3f2a1c (sudo tee).");
  });
});

describe("the restore clause", () => {
  it("counts minutes under two hours, then hours; it follows a write only, and only after the change", () => {
    expect(restoreClause("2026-10-25T15:52:07.000Z", "2026-10-25T15:52:40.000Z")).toBe(", under a minute before the agent restored it");
    expect(restoreClause("2026-10-25T15:52:07.000Z", "2026-10-25T15:53:07.000Z")).toBe(", 1 minute before the agent restored it");
    expect(restoreClause("2026-10-25T13:00:00.000Z", "2026-10-25T16:10:00.000Z")).toBe(", 3 hours before the agent restored it");
    const c = { class: "token_change" as const, summary: "The record was changed at 16:50 UTC through an API token.", disposition_id: DISP, occurred_at: "2026-10-25T16:50:05.000Z" };
    const revert = action("act-2", "revert_record", "2026-10-25T16:53:00.000Z", "2026-10-25T16:53:01.000Z");
    expect(withRestore(c, [revert])).toBe("The record was changed at 16:50 UTC through an API token, 3 minutes before the agent restored it.");
    expect(withRestore(c, [{ ...revert, status: "failed" }])).toBe(c.summary);
    expect(withRestore(c, [{ ...revert, disposition_id: "disp-other" }])).toBe(c.summary);
    expect(withRestore(c, [{ ...revert, started_at: "2026-10-25T16:40:00.000Z" }])).toBe(c.summary);
  });
});

describe("the diff", () => {
  it("is a unified diff with three lines of context, null for equal texts, every line through the redaction", () => {
    const a = "server {\n  listen 80;\n  server_name app.example.invalid;\n  location / {\n    proxy_pass http://127.0.0.1:8081;\n  }\n}\n";
    const b = a.replace("8081", "8091");
    expect(unifiedDiff(a, b, { from: "approved 5dde7698", to: "live 7d229b0a" })).toBe([
      "--- approved 5dde7698", "+++ live 7d229b0a", "@@ -2,6 +2,6 @@",
      "   listen 80;", "   server_name app.example.invalid;", "   location / {", "-    proxy_pass http://127.0.0.1:8081;", "+    proxy_pass http://127.0.0.1:8091;", "   }", " }",
    ].join("\n"));
    expect(unifiedDiff(a, a.replace(/\n/g, "\r\n"), { from: "a", to: "b" })).toBeNull();
    const leak = unifiedDiff("upstream app { server 127.0.0.1:8081; }\n", "upstream app { server 10.20.30.40:8081; }\n", { from: "a", to: "b", line: (s) => redactor.text(s) })!;
    expect(leak).not.toContain("10.20.30.40");
    expect(leak.split("\n")[4]).toMatch(/^\+upstream app \{ server ip-[0-9a-f]{6}:8081; \}$/);
    expect(unifiedDiff("", "one\ntwo\n", { from: "a", to: "b" })).toBe("--- a\n+++ b\n@@ -0,0 +1,2 @@\n+one\n+two");
  });

  it("holds at most 40 lines, the last saying how many were left out; two changes far apart are two hunks", () => {
    const a = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const b = a.replace(/line (\d+)/g, (m, n: string) => (Number(n) % 2 ? `edited ${n}` : m));
    const d = unifiedDiff(a, b, { from: "a", to: "b" })!.split("\n");
    expect(d).toHaveLength(DIFF_MAX_LINES);
    expect(d.at(-1)).toMatch(/^… \d+ more lines of the diff left out$/);
    const far = unifiedDiff(a, a.replace("line 10\n", "line ten\n").replace("line 80\n", "line eighty\n"), { from: "a", to: "b" })!;
    expect(far.split("\n").filter((l) => l.startsWith("@@"))).toEqual(["@@ -8,7 +8,7 @@", "@@ -78,7 +78,7 @@"]);
  });

  it("an approved value against the observed one is two lines under the headers; equal values give none", () => {
    expect(valueDiff("content", "ip-6b6bba", "203.0.113.9", { from: "approved", to: "live" })).toBe("--- approved\n+++ live\n-content ip-6b6bba\n+content 203.0.113.9");
    expect(valueDiff("content", "ip-6b6bba", null, { from: "approved", to: "live" })).toBe("--- approved\n+++ live\n-content ip-6b6bba\n+content (absent)");
    expect(valueDiff("content", "x", "x", { from: "approved", to: "live" })).toBeNull();
  });
});

// ---- over sql.js: the policy fixture with the Actor's vault ------------------------------------------------------

// the Actor's fixture vault is git repositories built on disk, and each case reads them through git: 1 to 3 s alone
describe("explainPass over the policy fixture", { timeout: 20_000 }, () => {
  let base: Base;
  let engine: SqlJsEngine;
  let layer: DataLayer;
  let pass: PassStep;
  beforeAll(async () => {
    base = buildBase();
    engine = await SqlJsEngine.create();
    engine.loadBundle(structuredClone(base.bundle));
    layer = new DataLayer(engine);
    pass = await passStep(layer, { tenant: TENANT, ledger: new MemoryLedger(engine), decidedAt: AT, world: new DriftWorld("explain_test") });
  }, 30_000);
  afterAll(() => {
    engine.close();
    base.cleanup();
  });

  it("explains the eight findings the pass moves on or holds, writes one row each, and a second run writes none", async () => {
    const tracer = new MemTracer("explain_test", { model: "none" });
    const r = await explainPass(pass, { layer, vault: base.vault, redactor: base.redactor, sink: new MemoryCauseSink(engine), tracer });
    expect(r.causes.map((c) => `${c.verb} ${c.finding_class} ${c.cause.class}`).sort()).toEqual([
      "ESCALATE proxy_split unknown", "FIX drift_vs_approved unknown", "HOLD drift_vs_approved unknown", "HOLD found_but_different account_change", "HOLD found_but_different account_change",
      "ROLLBACK approved_missing unknown", "ROLLBACK drift_vs_approved unknown", "ROLLBACK drift_vs_approved unknown",
    ]);
    expect(r.counts).toEqual({ agent: 0, operator_edit: 0, automation: 0, account_change: 2, token_change: 0, unknown: 6 });
    expect(r.searched).toEqual({ journal: 0, cloudflare: 1, actions: 0 });
    expect(r.written).toBe(8);
    expect(r.errors).toEqual([]);
    for (const c of r.causes) expect(c.disposition_id).toBe(dispositionIdOf(pass.findings.find((f) => f.id === c.finding_id)!, AT));
    // the record the found_but_different findings rest on was changed by a named account: the fixture's audit row
    const fbd = r.causes.find((c) => c.finding_class === "found_but_different")!;
    expect(fbd.cause.summary).toBe("The record was changed at 18:42 UTC on 22 Oct by a named account (user-3c7d), from 198.51.100.10 to 203.0.113.77.");
    expect(fbd.cause.diff).toBe("--- before\n+++ now\n-app.example.invalid 198.51.100.10\n+app.example.invalid 203.0.113.77");
    // app.conf: the approved copy against the live one, from the vault
    const app = r.causes.find((c) => c.verb === "ROLLBACK" && c.cause.diff?.includes("client_max_body_size"))!;
    expect(app.cause.summary).toBe("No record of who changed it: the journal window of 90 h holds 0 writes to the file.");
    expect(app.cause.diff).toBe([
      `--- approved ${base.commits["run-nginx-7f1c-1020"].slice(0, 8)}`, `+++ live ${base.commits["run-nginx-7f1c-1023"].slice(0, 8)}`, "@@ -4,4 +4,5 @@",
      "   location / {", "     proxy_pass http://app.example.invalid:8080;", "   }", "+  client_max_body_size 64m;", " }",
    ].join("\n"));
    // blog.conf went missing: every approved line removed
    expect(r.causes.find((c) => c.finding_class === "approved_missing")!.cause.diff).toMatch(/^--- approved [0-9a-f]{8}\n\+\+\+ live \(absent\)\n@@ -1,7 \+0,0 @@\n-server \{\n/);
    // the record's content: the approved value against the observed one
    const rec = r.causes.find((c) => c.cause.diff?.startsWith("--- approved\n"))!;
    expect(rec.cause.summary).toBe("No record of who changed it: the audit log window of 90 h holds 0 events for the record.");
    expect(rec.cause.diff).toBe("--- approved\n+++ live\n-content 198.51.100.12\n+content 198.51.100.11");
    // one trace line per cause and one summary, and its queries, all agent explainer, no model
    expect(tracer.events.every((e) => e.agent === "explainer" && e.model_requested === "none")).toBe(true);
    const lines = tracer.events.filter((e) => e.action === "explain");
    expect(lines).toHaveLength(9);
    expect(lines.filter((e) => e.status === "not_checked")).toHaveLength(6);
    expect(lines.at(-1)?.output_summary).toBe("explain: 8 cause(s) (account_change 2, unknown 6); finding_cause 8 written");
    expect(tracer.events.filter((e) => e.action === "query").every((e) => e.status === "ok")).toBe(true);
    // read back by disposition, the evidence from audit_event; a second run over the same pass writes none
    const stored = await causesByDisposition(layer, TENANT);
    expect([...stored.keys()].sort()).toEqual(r.causes.map((c) => c.disposition_id).sort());
    expect(stored.get(fbd.disposition_id)).toEqual(fbd.cause);
    expect((await causesByDisposition(layer, TENANT, [fbd.disposition_id])).size).toBe(1);
    const ev = await causeEvidence(layer, TENANT, [fbd.cause, app.cause]);
    expect(ev.get(fbd.cause.cause_id)?.map(timelineLine)).toEqual(["2026-10-22 18:42:10 UTC · cloudflare · user-3c7d · rec_set · rec-a1"]);
    expect(ev.get(app.cause.cause_id)).toEqual([]);
    expect((await explainPass(pass, { layer, vault: base.vault, redactor: base.redactor, sink: new MemoryCauseSink(engine) })).written).toBe(0);
  });

  it("a journal write on the file with the user's login names the operator; without a sink nothing is written", async () => {
    const tee: AuditEvent = {
      event_id: "evt-journal-tee-1", tenant_id: TENANT, source: "journal", actor: "user-3f2a1c", action: "tee", resource_type: "file", resource_id: "/etc/nginx/conf.d/app.conf",
      old_value: null, new_value: `/usr/bin/tee -- /etc/nginx/conf.d/app.conf on ${HOST}`, occurred_at: "2026-10-22T23:52:07.000Z",
    };
    const login: AuditEvent = { ...tee, event_id: "evt-journal-login-1", action: "ssh_login", resource_type: "session", resource_id: null, old_value: "203.0.113.5", new_value: `publickey on ${HOST}`, occurred_at: "2026-10-22T23:40:00.000Z" };
    engine.insertRows("audit_event", [tee, login]);
    const r = await explainPass(pass, { layer, vault: base.vault, redactor: base.redactor, sink: null });
    expect(r.written).toBeNull();
    expect(r.searched).toEqual({ journal: 2, cloudflare: 1, actions: 0 });
    const app = r.causes.find((c) => c.verb === "ROLLBACK" && c.cause.diff?.includes("client_max_body_size"))!;
    expect(app.cause).toMatchObject({ class: "operator_edit", actor: "user-3f2a1c", source_host: "203.0.113.5", evidence_ids: JSON.stringify(["evt-journal-login-1", "evt-journal-tee-1"]) });
    expect(app.cause.summary).toBe("The file was changed at 23:52 UTC on 22 Oct by user-3f2a1c over ssh from 203.0.113.5 (sudo tee).");
  });

  it("the explain step: its row, its summary, and a failure read as not explained, never a failed step", async () => {
    const step = await explainStep(layer, pass, { sink: null, vault: base.vault, redactor: base.redactor });
    expect(step.ok).toBe(true);
    expect(step.summary).toBe("explain: tenant client-a, 8 cause(s) (operator_edit 1, account_change 2, unknown 5); searched 2 journal and 1 cloudflare row(s) and 0 ledger action(s); no sink, nothing written");
    expect(new Table(PLAIN).row("explain", step.view!, 400)).toEqual([`${"  explain   8 causes      operator 1 · account 2 · unknown 5".padEnd(85)}0.4 s`]);
    expect(step.explain?.causes).toHaveLength(8);
    const broken = new DataLayer({ name: "sqljs", qualify: (t) => t, run: async () => { throw new Error("datasource unreachable"); } });
    const failed = await explainStep(broken, pass, { sink: null, vault: null, redactor: base.redactor });
    expect(failed.ok).toBe(true);
    expect(failed.summary).toBe("explain: tenant client-a, not explained (datasource unreachable); act runs as before");
    expect(new Table(PLAIN).row("explain", failed.view!, null)).toEqual(["  explain   0 causes      not explained · datasource unreachable"]);
  });
});

// the second case builds the fixture vault with git and commits a later run into it
describe("the approval's own copy in the diff header", { timeout: 20_000 }, () => {
  it("is the latest copy taken at or before the approval, the earliest when every copy is later", () => {
    const copies = [{ taken_at: "2026-10-20T02:01:00.000Z", c: "a" }, { taken_at: "2026-10-21T02:01:00.000Z", c: "b" }, { taken_at: "2026-10-23T02:30:00.000Z", c: "c" }];
    expect(approvalCopy(copies, "2026-10-22T09:00:00.000Z")?.c).toBe("b");
    expect(approvalCopy(copies, "2026-10-21T02:01:00.000Z")?.c).toBe("b");
    expect(approvalCopy(copies, "2026-10-19T09:00:00.000Z")?.c).toBe("a");
    expect(approvalCopy([], "2026-10-19T09:00:00.000Z")).toBeUndefined();
  });

  it("names the commit the approval was signed off from, not a later vault commit that holds the same bytes", async () => {
    const base = buildBase();
    try {
      // a later collection (the one after a restore) commits the approved files again under a new commit
      const later = { ...base.bundle.collection_run.find((r) => r.run_id === "run-nginx-7f1c-1020")!, run_id: "run-nginx-7f1c-1023b", started_at: "2026-10-23T02:30:00.000Z", finished_at: "2026-10-23T02:31:00.000Z" };
      const files = base.bundle.observation.filter((o) => o.run_id === "run-nginx-7f1c-1020" && o.setting_path === "file").map((o) => ({ path: o.object_id, objectId: o.object_id, bytes: Buffer.from(o.value_redacted!, "utf8") }));
      const again = base.vault.commitRun({ tenantId: TENANT, repo: ALIAS, run: later as Parameters<Base["vault"]["commitRun"]>[0]["run"], files });
      expect(again.commit).not.toBe(base.commits["run-nginx-7f1c-1020"]);
      const engine = await SqlJsEngine.create();
      try {
        engine.loadBundle(structuredClone(base.bundle));
        engine.insertRows("vault_copy", again.copies);
        const layer = new DataLayer(engine);
        const pass = await passStep(layer, { tenant: TENANT, ledger: new MemoryLedger(engine), decidedAt: AT, world: new DriftWorld("explain_test") });
        const r = await explainPass(pass, { layer, vault: base.vault, redactor: base.redactor, sink: null });
        const app = r.causes.find((c) => c.verb === "ROLLBACK" && c.cause.diff?.includes("client_max_body_size"))!;
        expect(app.cause.diff!.split("\n").slice(0, 2)).toEqual([`--- approved ${base.commits["run-nginx-7f1c-1020"].slice(0, 8)}`, `+++ live ${base.commits["run-nginx-7f1c-1023"].slice(0, 8)}`]);
      } finally {
        engine.close();
      }
    } finally {
      base.cleanup();
    }
  });
});

describe("the explain row", () => {
  it("counts the causes by class: people and tools, then the agent, then unknown", () => {
    const causes = ["unknown", "agent", "operator_edit", "unknown"].map((c) => ({ class: c }));
    expect(new Table(PLAIN).row("explain", explainView({ causes }), 400)).toEqual([`${"  explain   4 causes      operator 1 · agent 1 · unknown 2".padEnd(85)}0.4 s`]);
    expect(new Table(PLAIN).row("explain", explainView({ causes: [] }), 100)[0]).toMatch(/^  explain   0 causes      nothing to explain +0\.1 s$/);
  });
});
