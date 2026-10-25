// The ticket adapter (src/psa/): the opening rules, the GitHub backend over a fake fetch (label bootstrap, create,
// comment, close, status, the token read once, the deny-list refusal before any request), the plan and its
// application (idempotency on the ticket row, the closing rules, a ticket closed in the PSA), the body, the
// ticket step over the policy fixture through sql.js, the field map, the Store's updateTicket (with DATABASE_URL)
// and, with TICKETS_LIVE=true, one smoke issue created, commented on and closed in DRIFT_TICKETS_REPO. The step's
// three queries have their parity cases in test/parity.test.ts.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FetchLike } from "../src/collectors/cloudflare.ts";
import { config } from "../src/config.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { DISPOSITIONS_SQL, objects } from "../src/data/queries.ts";
import { dispositionId, type Action, type Alert, type Disposition, type DispositionVerb, type PolicyRule, type PsaPriority, type Ticket } from "../src/data/rows.ts";
import { Store } from "../src/data/store.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { runPass } from "../src/pipeline.ts";
import { BODY_MAX, ticketBody, ticketTitle } from "../src/psa/body.ts";
import { GithubIssues, labelColor } from "../src/psa/github.ts";
import {
  FIXED_LABELS, PsaError, outgoing, planTickets, ticketCall, ticketId,
  type ActionView, type TicketFinding, type TicketInput, type TicketOp,
} from "../src/psa/index.ts";
import mapping from "../src/psa/mapping.json" with { type: "json" };
import { MemoryTicketRows, applyTickets, ticketStep } from "../src/psa/step.ts";
import { Redactor } from "../src/redactor.ts";
import policyBundle from "./fixtures/policy-bundle.json" with { type: "json" };

const T = "client-a";
const RUN = "run-nginx-7f1c-1023";
const HOST = "host-7f1c";
const APP = "/etc/nginx/conf.d/app.conf";
const H = (c: string): string => `sha256:${c.repeat(64)}`;
const DECIDED1 = "2026-10-24T20:00:00.000Z";
const NOW1 = "2026-10-24T20:05:00.000Z";
const DECIDED2 = "2026-10-24T21:00:00.000Z";
const NOW2 = "2026-10-24T21:05:00.000Z";
/** A label the deny-list carries in these tests; the redactor leaves it alone (no dot, outside its words). */
const DENIED = "zz9qdenied";
/** A label the redactor's words carry: pseudonymised before the probe reads the text. */
const WORD = "zz9qbrand";
const redactor = new Redactor("psa-test-salt", [WORD]);
const deny = [WORD, DENIED];
const quiet = (): void => undefined;

const rule = (id: string, alert: Alert, priority: PsaPriority): PolicyRule => ({
  rule_id: id, tenant_id: "*", surface: "linux.nginx", object_glob: "/etc/nginx/conf.d/*.conf", setting_glob: "file", criticality: "critical", lock: 1,
  on_drift: "rollback", on_no_copy: "investigate_ticket", hold_max_hours: 24, alert, psa_priority: priority, version: 2, author: "operator",
  since: "2026-10-25T00:00:00.000Z", note: null,
});
const ALWAYS = rule("rule-00000000000000a1", "always", "P1");
const ON_FIX = rule("rule-00000000000000b2", "on_fix", "P2");
const NEVER = rule("rule-00000000000000c3", "never", "P4");
const RULES = [ALWAYS, ON_FIX, NEVER];

function finding(id: string, cls: TicketFinding["finding"]["class"], summary = `file in ${APP} on ${HOST} drifted from its approval`): TicketFinding {
  return {
    id,
    finding: {
      class: cls, tenant_id: T, run_id: RUN, surface: "linux.nginx", host: HOST, object_id: APP, setting_path: "file", value_hash: H("d"),
      since: "2026-10-23T02:00:00.000Z", until: "2026-10-24T19:59:00.000Z", summary,
    },
    checks: [{ template: "run_complete", holds: true, rowCount: 0, explanation: `Run ${RUN} collected everything it set out to collect.` }],
    rejected: [],
  };
}

function disposition(f: TicketFinding, verb: DispositionVerb, r: PolicyRule | null, decidedAt = DECIDED1, run = RUN): Disposition {
  return {
    disposition_id: dispositionId(T, "linux.nginx", HOST, APP, "file", H("d"), f.id, run, decidedAt),
    tenant_id: T, surface: "linux.nginx", host: HOST, object_id: APP, setting_path: "file", value_hash: H("d"), verb,
    reason: `rule ${r?.rule_id ?? "none"} decides ${verb}`, expires_at: verb === "HOLD" ? "2026-10-25T20:00:00.000Z" : null,
    decided_by: r ? "policy" : "default", rule_id: r?.rule_id ?? null, finding_id: f.id, run_id: run, decided_at: decidedAt,
  };
}

function act(d: Disposition, kind: Action["kind"], status: string, over: Partial<ActionView> = {}): ActionView {
  return {
    action_id: `act-${kind}-${status}`, tenant_id: T, kind, target: APP, before_hash: H("d"), after_hash: status === "done" ? H("a") : H("d"),
    vault_commit: "5a14a89d0123456789abcdef0123456789abcdef", verification: status === "done" ? "probe-0000000000000001,probe-0000000000000002" : "",
    receipts: kind === "investigate" ? "rcpt-0001" : "", status, reason: "", record: "", started_at: "2026-10-24T20:01:00.000Z", finished_at: "2026-10-24T20:02:00.000Z",
    disposition_id: d.disposition_id, finding_id: d.finding_id, verb: d.verb, ...over,
  };
}

const input = (over: Partial<TicketInput>): TicketInput => ({
  tenant: T, psa: "github", now: NOW1, findings: [], dispositions: [], actions: [], tickets: [], rules: RULES, probes: new Map(), zones: new Map(),
  covered: () => true, passRuns: [RUN], ...over,
});

interface Call { method: string; path: string; body: Record<string, unknown> | null; auth: string | null }

/** A GitHub that answers the six routes the backend uses, in memory. */
function fakeGithub(opts: { labels?: string[]; alreadyExists?: string[]; failIssues?: boolean } = {}) {
  const calls: Call[] = [];
  const issues = new Map<number, { title: string; body: string; labels: string[]; state: string; comments: string[] }>();
  let next = 40;
  const json = (status: number, v: unknown): Response => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const path = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "") + u.search;
    calls.push({ method, path, body, auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null });
    if (u.pathname.endsWith("/labels")) {
      if (method === "GET") return json(200, (opts.labels ?? []).map((name) => ({ name })));
      return (opts.alreadyExists ?? []).includes(String(body?.name)) ? json(422, { message: "Validation Failed", errors: [{ code: "already_exists" }] }) : json(201, { name: body?.name });
    }
    if (u.pathname.endsWith("/issues") && method === "POST") {
      if (opts.failIssues) return json(403, { message: "Resource not accessible by integration" });
      const n = ++next;
      issues.set(n, { title: String(body?.title), body: String(body?.body), labels: body?.labels as string[], state: "open", comments: [] });
      return json(201, { number: n, html_url: `https://github.example/owner/tickets/issues/${n}` });
    }
    const m = u.pathname.match(/\/issues\/(\d+)(\/comments)?$/);
    const issue = m ? issues.get(Number(m[1])) : undefined;
    if (m && issue) {
      if (m[2] && method === "POST") { issue.comments.push(String(body?.body)); return json(201, { id: issue.comments.length }); }
      if (method === "PATCH") { issue.state = String(body?.state); return json(200, { state: issue.state }); }
      if (method === "GET") return json(200, { state: issue.state });
    }
    return json(404, { message: "Not Found" });
  };
  return { fetch, calls, issues };
}

function github(fake: ReturnType<typeof fakeGithub>, token = () => "test-token-for-the-fake") {
  let reads = 0;
  const gh = new GithubIssues({ repo: "example-owner/drift-tickets", fetch: fake.fetch, redactor, deny, token: () => { reads++; return token(); } });
  return { gh, reads: () => reads };
}

const apply = (ops: TicketOp[], gh: GithubIssues | null, rows: MemoryTicketRows | null, now = NOW1, dryRun = false) =>
  applyTickets(ops, gh, rows, { dryRun, redactor, deny, now: () => now, print: quiet });

describe("ticketCall: when a disposition opens a ticket, per verb and the rule's alert", () => {
  it("ESCALATE and FIX open an incident always; ROLLBACK a change on always or on_fix; HOLD an incident on always; ADOPT nothing", () => {
    const table = (["ESCALATE", "FIX", "ROLLBACK", "HOLD", "ADOPT"] as const).map((v) => [v, ...[ALWAYS, ON_FIX, NEVER, null].map((r) => {
      const c = ticketCall(v, r);
      return c.open ? `${c.type} ${c.priority}` : "-";
    })]);
    expect(table).toEqual([
      ["ESCALATE", "incident P1", "incident P2", "incident P4", "incident P3"],
      ["FIX", "incident P1", "incident P2", "incident P4", "incident P3"],
      ["ROLLBACK", "change P1", "change P2", "-", "-"],
      ["HOLD", "incident P1", "-", "-", "-"],
      ["ADOPT", "-", "-", "-", "-"],
    ]);
    expect(ticketCall("HOLD", NEVER).why).toBe(`HOLD opens an incident on alert always; rule ${NEVER.rule_id} alerts never`);
  });

  it("ticket_id is stableId over tenant, finding and action, the action \"\" when there is none", () => {
    expect(ticketId(T, "fnd-1", null)).toMatch(/^tkt-[0-9a-f]{16}$/);
    expect(ticketId(T, "fnd-1", null)).toBe(ticketId(T, "fnd-1", null));
    expect(ticketId(T, "fnd-1", "act-1")).not.toBe(ticketId(T, "fnd-1", null));
    expect(ticketId("client-b", "fnd-1", null)).not.toBe(ticketId(T, "fnd-1", null));
  });
});

describe("outgoing: the redactor, then the deny-list probe", () => {
  it("a hostname, an address and a redactor word leave as pseudonyms; a deny-list label left standing refuses the text, naming its position and count", () => {
    const sent = outgoing(redactor, deny, `app.bluefin-logistics-zz9q.com on 10.40.12.7 serves ${WORD}`, "body");
    expect(sent).toMatch(/^host-[0-9a-f]{6}\.com on ip-[0-9a-f]{6} serves word-[0-9a-f]{6}$/);
    expect(() => outgoing(redactor, deny, `the ${DENIED} vhost and ${DENIED} again`, "body")).toThrow(new PsaError("deny-list probe: 1 of 2 label(s) appear in the body (#2 x2); nothing sent"));
  });
});

describe("GithubIssues over a fake fetch", () => {
  const draft = { title: "FIX drift_vs_approved: /etc/nginx/conf.d/app.conf on host-7f1c", body: "### What\napp.bluefin-logistics-zz9q.com drifted", labels: ["drift-agent", "type:incident", "P1", "class:drift_vs_approved", "verb:FIX"] };

  it("bootstraps the labels once: lists them, creates the missing fixed and draft labels, tolerates already_exists; a second draft creates only its new labels", async () => {
    const fake = fakeGithub({ labels: ["drift-agent", "P1"], alreadyExists: ["P2"] });
    const { gh } = github(fake);
    await gh.create(draft);
    await gh.create({ ...draft, labels: ["drift-agent", "type:change", "P1", "class:proxy_split", "verb:ROLLBACK"] });
    expect(gh.requests).toEqual([
      "GET /labels?per_page=100&page=1",
      "POST /labels", "POST /labels", "POST /labels", "POST /labels", "POST /labels", "POST /labels", "POST /labels",
      "POST /issues",
      "POST /labels", "POST /labels",
      "POST /issues",
    ]);
    const created = fake.calls.filter((c) => c.method === "POST" && c.path === "/labels").map((c) => c.body?.name);
    expect(created).toEqual(["type:change", "type:incident", "P2", "P3", "P4", "class:drift_vs_approved", "verb:FIX", "class:proxy_split", "verb:ROLLBACK"]);
    expect(fake.calls.find((c) => c.body?.name === "P4")?.body).toEqual({ name: "P4", color: labelColor("P4"), description: "Priority P4 from the policy rule that governs the setting" });
    expect(FIXED_LABELS).toEqual(["drift-agent", "type:change", "type:incident", "P1", "P2", "P3", "P4"]);
  });

  it("create posts the title, the redacted body and the labels and returns the number and url; comment, close and status hit their routes; the token is read once and sent as a bearer", async () => {
    const fake = fakeGithub({ labels: [...FIXED_LABELS, "class:drift_vs_approved", "verb:FIX"] });
    const { gh, reads } = github(fake);
    const ref = await gh.create(draft);
    expect(ref).toEqual({ external_id: "41", url: "https://github.example/owner/tickets/issues/41" });
    const post = fake.calls.find((c) => c.method === "POST" && c.path === "/issues")!;
    expect(Object.keys(post.body!)).toEqual(["title", "body", "labels"]);
    expect(post.body!.title).toBe(draft.title);
    expect(post.body!.body).toMatch(/^### What\nhost-[0-9a-f]{6}\.com drifted$/);
    expect(post.body!.labels).toEqual(draft.labels);
    await gh.comment("41", `rolled back on ${WORD}`);
    await gh.close("41");
    expect(await gh.status("41")).toBe("closed");
    expect(fake.issues.get(41)!.comments).toEqual([expect.stringMatching(/^rolled back on word-[0-9a-f]{6}$/)]);
    expect(fake.calls.slice(-3).map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/issues/41/comments", { body: expect.stringMatching(/^rolled back on word-/) }],
      ["PATCH", "/issues/41", { state: "closed", state_reason: "completed" }],
      ["GET", "/issues/41", null],
    ]);
    expect(new Set(fake.calls.map((c) => c.auth))).toEqual(new Set(["Bearer test-token-for-the-fake"]));
    expect(reads()).toBe(1);
  });

  it("refuses before any request: a deny-list label in a title, body, label or comment; a blank token; a malformed repository; an issue number that is not digits", async () => {
    const fake = fakeGithub();
    const { gh, reads } = github(fake);
    await expect(gh.create({ ...draft, body: `served by ${DENIED}` })).rejects.toThrow(/deny-list probe: 1 of 2 label\(s\) appear in the body \(#2 x1\); nothing sent/);
    await expect(gh.create({ ...draft, title: `${DENIED} drift` })).rejects.toThrow(/appear in the title/);
    await expect(gh.create({ ...draft, labels: [`class:${DENIED}`] })).rejects.toThrow(/appear in the labels/);
    await expect(gh.comment("41", `about ${DENIED}`)).rejects.toThrow(/appear in the comment/);
    expect(fake.calls).toEqual([]);
    expect(reads()).toBe(0);
    const blank = github(fake, () => "  ");
    await expect(blank.gh.create(draft)).rejects.toThrow("the GitHub token is blank: `gh auth token` printed nothing; sign in with `gh auth login` and run again");
    expect(fake.calls).toEqual([]);
    expect(() => new GithubIssues({ repo: "no-slash", fetch: fake.fetch, redactor, deny })).toThrow(/DRIFT_TICKETS_REPO must name the tickets repository as <owner>\/<name>; it is blank or malformed/);
    await expect(gh.close("41; DROP")).rejects.toThrow(/an issue number is digits/);
    expect(fake.calls).toEqual([]);
  });

  it("a failing response throws with the status, the route and GitHub's message; the repository and the token stay out of it", async () => {
    const fake = fakeGithub({ labels: [...FIXED_LABELS, "class:drift_vs_approved", "verb:FIX"], failIssues: true });
    const { gh } = github(fake);
    const err = await gh.create(draft).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PsaError);
    expect((err as Error).message).toBe("GitHub 403 POST /issues: Resource not accessible by integration");
  });
});

describe("planTickets and applyTickets", () => {
  it("a FIX opens an incident: the row, then the issue, then its number and redacted url on the row; the next pass finds it current and sends nothing", async () => {
    const f = finding("fnd-fix", "drift_vs_approved", "file in /etc/nginx/conf.d/app.conf on app.bluefin-logistics-zz9q.com drifted");
    const d = disposition(f, "FIX", ON_FIX);
    const ops = planTickets(input({ findings: [f], dispositions: [d] }));
    expect(ops.map((o) => o.op)).toEqual(["create"]);
    expect(planTickets(input({ findings: [f, f], dispositions: [d, { ...d, disposition_id: `${d.disposition_id}-b` }] })).map((o) => o.op)).toEqual(["create"]);
    const op = ops[0] as Extract<TicketOp, { op: "create" }>;
    expect(op.ticket).toMatchObject({ ticket_id: ticketId(T, f.id, null), type: "incident", priority: "P2", status: "open", external_id: null, action_id: null, created_at: NOW1 });
    expect(op.draft.title).toBe(`FIX drift_vs_approved: ${APP} on ${HOST}`);
    expect(op.draft.labels).toEqual(["drift-agent", "type:incident", "P2", "class:drift_vs_approved", "verb:FIX"]);
    const fake = fakeGithub({ labels: [...FIXED_LABELS] });
    const { gh } = github(fake);
    const rows = new MemoryTicketRows();
    const out = await apply(ops, gh, rows);
    expect(out.map((o) => [o.status, o.external_id])).toEqual([["created", "41"]]);
    expect(rows.rows).toEqual([{ ...op.ticket, external_id: "41", url: "https://github.example/owner/tickets/issues/41", updated_at: NOW1 }]);
    expect(fake.issues.get(41)!.body).toMatch(/on host-[0-9a-f]{6}\.com drifted/);
    const again = planTickets(input({ findings: [f], dispositions: [d], tickets: rows.rows, now: NOW2 }));
    expect(again.map((o) => o.op)).toEqual(["skip"]);
    expect((again[0] as Extract<TicketOp, { op: "skip" }>).reason).toBe(`ticket ${op.ticket.ticket_id} (#41) is current: FIX, no new action`);
    expect(fake.calls.filter((c) => c.path === "/issues")).toHaveLength(1);
  });

  it("a row already holding an external_id is updated in place: a new action is one comment and the row takes the action id; a row with none gets its issue created", async () => {
    const f = finding("fnd-fix", "drift_vs_approved");
    const d = disposition(f, "FIX", ON_FIX);
    const fake = fakeGithub({ labels: [...FIXED_LABELS] });
    const { gh } = github(fake);
    const rows = new MemoryTicketRows();
    await apply(planTickets(input({ findings: [f], dispositions: [d] })), gh, rows);
    const inv = act(d, "investigate", "done", { verification: "" });
    const ops = planTickets(input({ findings: [f], dispositions: [d], actions: [inv], tickets: rows.rows, now: NOW2 }));
    expect(ops.map((o) => [o.op, o.op === "comment" ? o.reason : ""])).toEqual([["comment", `new action ${inv.action_id}`]]);
    const out = await apply(ops, gh, rows, NOW2);
    expect(out.map((o) => o.status)).toEqual(["commented"]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ ticket_id: ticketId(T, f.id, null), external_id: "41", action_id: inv.action_id, status: "open", updated_at: NOW2 });
    expect(fake.issues.get(41)!.comments[0]).toContain(`- action ${inv.action_id}: investigate done`);
    expect(fake.issues.get(41)!.comments[0]).toContain("### Receipts\n- rcpt-0001");
    expect(fake.calls.filter((c) => c.path === "/issues")).toHaveLength(1);

    const recorded: Ticket = { ...rows.rows[0], ticket_id: "tkt-0000000000000009", external_id: null, url: null, action_id: inv.action_id };
    const retry = planTickets(input({ findings: [f], dispositions: [d], actions: [inv], tickets: [recorded] }));
    expect(retry.map((o) => [o.op, o.op === "create" && o.existing])).toEqual([["create", true]]);
    const rows2 = new MemoryTicketRows([recorded]);
    await apply(retry, gh, rows2);
    expect(rows2.rows).toEqual([{ ...recorded, external_id: "42", url: "https://github.example/owner/tickets/issues/42", updated_at: NOW1 }]);
  });

  it("a ROLLBACK opens its change once the action is recorded: done and verified, created and closed with a comment; failed, created and left open with the failure", async () => {
    const f = finding("fnd-rb", "drift_vs_approved");
    const d = disposition(f, "ROLLBACK", ON_FIX);
    expect(planTickets(input({ findings: [f], dispositions: [d] })).map((o) => o.op === "skip" && o.reason)).toEqual([
      `ROLLBACK drift_vs_approved: the change ticket opens once the Actor records its rollback; the ledger holds no action for ${d.disposition_id}`,
    ]);
    const fake = fakeGithub({ labels: [...FIXED_LABELS] });
    const { gh } = github(fake);

    const ok = act(d, "rollback_file", "done");
    const rows = new MemoryTicketRows();
    const ops = planTickets(input({ findings: [f], dispositions: [d], actions: [ok] }));
    expect(ops.map((o) => [o.op, o.op === "create" ? o.ticket.ticket_id : "", o.op === "create" ? o.ticket.type : ""])).toEqual([["create", ticketId(T, f.id, ok.action_id), "change"]]);
    expect((await apply(ops, gh, rows)).map((o) => o.status)).toEqual(["closed"]);
    expect(rows.rows[0]).toMatchObject({ action_id: ok.action_id, status: "closed", external_id: "41" });
    expect(fake.issues.get(41)!.state).toBe("closed");
    expect(fake.issues.get(41)!.comments[0]).toMatch(/^The rollback is done and verified by probes probe-0000000000000001,probe-0000000000000002; closing\./);

    const bad = act(d, "rollback_file", "failed");
    const rows2 = new MemoryTicketRows();
    await apply(planTickets(input({ findings: [f], dispositions: [d], actions: [bad] })), gh, rows2);
    expect(rows2.rows[0]).toMatchObject({ action_id: bad.action_id, status: "open", external_id: "42" });
    expect(fake.issues.get(42)!.state).toBe("open");
    expect(fake.issues.get(42)!.body).toContain(`- action ${bad.action_id}: rollback_file failed, started 2026-10-24T20:01:00.000Z, finished 2026-10-24T20:02:00.000Z; before dddddddddddd, after dddddddddddd; vault commit 5a14a89d; verification none`);
    expect(planTickets(input({ findings: [f], dispositions: [d], actions: [bad], tickets: rows2.rows })).map((o) => o.op)).toEqual(["skip"]);
  });

  it("a HOLD under alert always opens an incident; ADOPT later closes it; a pass covering the setting with no finding closes it; one whose runs failed the gate leaves it open", async () => {
    const f = finding("fnd-hold", "proxied_without_real_ip");
    const hold = disposition(f, "HOLD", ALWAYS);
    const fake = fakeGithub({ labels: [...FIXED_LABELS] });
    const { gh } = github(fake);
    const opened = async () => {
      const rows = new MemoryTicketRows();
      await apply(planTickets(input({ findings: [f], dispositions: [hold] })), gh, rows);
      return rows;
    };

    const a = await opened();
    const adopt = disposition(f, "ADOPT", ALWAYS, DECIDED2);
    const ops = planTickets(input({ findings: [f], dispositions: [hold, adopt], tickets: a.rows, now: NOW2 }));
    expect(ops.map((o) => [o.op, o.op === "close" ? o.reason : ""])).toEqual([["close", `the hold is adopted by ${adopt.disposition_id}`]]);
    await apply(ops, gh, a, NOW2);
    expect(a.rows[0].status).toBe("closed");
    expect(fake.issues.get(41)!.comments[0]).toMatch(/^The hold is adopted: rule rule-00000000000000a1 decides ADOPT; closing\./);

    const b = await opened();
    const resolved = planTickets(input({ findings: [], dispositions: [hold], tickets: b.rows, now: NOW2, passRuns: ["run-nginx-7f1c-1024"] }));
    expect(resolved.map((o) => o.op)).toEqual(["close"]);
    await apply(resolved, gh, b, NOW2);
    expect(fake.issues.get(42)!.comments[0]).toBe([
      `Resolved: the pass over run(s) run-nginx-7f1c-1024 raises no finding on this setting; its last disposition is HOLD ${hold.disposition_id}, decided ${DECIDED1}; closing.`,
      "", "### Ledger", `- disposition ${hold.disposition_id}`, `- finding ${f.id}`, `- run ${RUN}`, `- ticket ${b.rows[0].ticket_id}`,
    ].join("\n"));

    const c = await opened();
    const gated = planTickets(input({ findings: [], dispositions: [hold], tickets: c.rows, now: NOW2, covered: () => false }));
    expect(gated.map((o) => o.op === "skip" && o.reason)).toEqual([`ticket ${c.rows[0].ticket_id}: finding ${f.id} is absent from this pass, whose runs for its setting failed the gate; the ticket stays open`]);
  });

  it("a verb other than the one in force at the last update is one comment; an incident closed in the PSA is marked closed and sent nothing", async () => {
    const f = finding("fnd-hold", "proxied_without_real_ip");
    const hold = disposition(f, "HOLD", ALWAYS);
    const fake = fakeGithub({ labels: [...FIXED_LABELS] });
    const { gh } = github(fake);
    const rows = new MemoryTicketRows();
    await apply(planTickets(input({ findings: [f], dispositions: [hold] })), gh, rows);
    const esc = { ...disposition(f, "ESCALATE", ALWAYS, DECIDED2), reason: `hold under rule ${ALWAYS.rule_id} expired 2026-10-24T20:30:00.000Z; the finding stands` };
    const ops = planTickets(input({ findings: [f], dispositions: [hold, esc], tickets: rows.rows, now: NOW2 }));
    expect(ops.map((o) => [o.op, o.op === "comment" ? o.reason : ""])).toEqual([["comment", "verb HOLD to ESCALATE"]]);
    await apply(ops, gh, rows, NOW2);
    expect(fake.issues.get(41)!.comments[0]).toContain("The decision moved from HOLD to ESCALATE.");
    expect(fake.issues.get(41)!.comments[0]).toContain(`- reason: ${esc.reason}`);
    expect(planTickets(input({ findings: [f], dispositions: [hold, esc], tickets: rows.rows, now: NOW2 })).map((o) => o.op)).toEqual(["skip"]);

    fake.issues.get(41)!.state = "closed";
    const adopt = disposition(f, "ADOPT", ALWAYS, "2026-10-24T22:00:00.000Z");
    const later = planTickets(input({ findings: [f], dispositions: [hold, esc, adopt], tickets: rows.rows, now: "2026-10-24T22:05:00.000Z" }));
    expect(later.map((o) => o.op)).toEqual(["close"]);
    const before = fake.calls.length;
    const out = await apply(later, gh, rows, "2026-10-24T22:05:00.000Z");
    expect(out.map((o) => o.status)).toEqual(["synced"]);
    expect(fake.calls.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual(["GET /issues/41"]);
    expect(rows.rows[0].status).toBe("closed");
    expect(planTickets(input({ findings: [f], dispositions: [hold, esc, adopt], tickets: rows.rows })).map((o) => o.op === "skip" && o.reason)).toEqual([
      `ticket ${rows.rows[0].ticket_id} for finding ${f.id} is closed; it stays closed (ADOPT opens no ticket)`,
    ]);
  });

  it("a body carrying a deny-list label is refused before any row or request; a dry run prints the plan and sends and writes nothing", async () => {
    const f = finding("fnd-esc", "orphan_vhost", `the ${DENIED} vhost has no record`);
    const d = disposition(f, "ESCALATE", null);
    const ops = planTickets(input({ findings: [f], dispositions: [d], rules: [] }));
    expect(ops.map((o) => o.op === "create" && [o.ticket.type, o.ticket.priority])).toEqual([["incident", "P3"]]);
    const fake = fakeGithub();
    const { gh } = github(fake);
    const rows = new MemoryTicketRows();
    const out = await apply(ops, gh, rows);
    expect(out.map((o) => o.status)).toEqual(["refused"]);
    expect(out[0].line).toMatch(/deny-list probe: 1 of 2 label\(s\) appear in the body \(#2 x1\); nothing sent$/);
    expect(rows.rows).toEqual([]);
    expect(fake.calls).toEqual([]);

    const lines: string[] = [];
    const ok = finding("fnd-esc", "orphan_vhost", "app.bluefin-logistics-zz9q.com has no record");
    const dry = await applyTickets(planTickets(input({ findings: [ok], dispositions: [disposition(ok, "ESCALATE", null)], rules: [] })), gh, rows, { dryRun: true, redactor, deny, print: (l) => lines.push(l) });
    expect(dry.map((o) => o.status)).toEqual(["planned"]);
    expect(lines[0]).toMatch(/^would create incident P3 tkt-[0-9a-f]{16} \(new row\) for fnd-esc: ESCALATE orphan_vhost: \/etc\/nginx\/conf\.d\/app\.conf on host-7f1c \(ESCALATE opens an incident; no rule governs the setting\)$/);
    expect(lines[1]).toContain("host-");
    expect(lines.join("\n")).not.toContain("bluefin");
    expect(rows.rows).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});

describe("the body", () => {
  it("six sections in order, each check with its template, verdict and rows, the probes by id, hashes as 12 hex, commits as 8; the title names verb, class, object and host", () => {
    const f = { ...finding("fnd-fix", "drift_vs_approved"), rejected: [{ reason: "backup_recent: audit log incomplete (no cloudflare.audit run for this tenant)" }], exposure: undefined };
    const d = disposition(f, "FIX", ON_FIX);
    const probes = { run_id: "run-probe-1023", rows: [{ probe_id: "probe-00000000000000aa", kind: "http", target: "host-1a2b3c.com", expected: "answers (status below 500); cf-ray present", observed: "status 526", status: "fail" }] };
    const body = ticketBody({ finding: f, disposition: d, rule: ON_FIX, actions: [act(d, "investigate", "done", { verification: "" })], probes, ticketId: "tkt-0000000000000001", type: "incident", priority: "P2" });
    expect(body.split("\n").filter((l) => l.startsWith("### "))).toEqual(["### What", "### Evidence", "### Decision", "### Work done", "### Receipts", "### Ledger"]);
    expect(body).toContain(`- check run_complete: holds, 0 row(s). Run ${RUN} collected everything it set out to collect.`);
    expect(body).toContain("- check not run: backup_recent: audit log incomplete (no cloudflare.audit run for this tenant)");
    expect(body).toContain("- exposure: the pass dated none for this finding");
    expect(body).toContain("- probe probe-00000000000000aa http host-1a2b3c.com: fail; observed status 526; expected answers (status below 500); cf-ray present");
    expect(body).toContain(`- FIX by policy, decided ${DECIDED1}, under rule ${ON_FIX.rule_id} (linux.nginx /etc/nginx/conf.d/*.conf file v2: critical, lock 1, on_drift rollback, alert on_fix, P2)`);
    expect(body).toContain("before dddddddddddd, after aaaaaaaaaaaa; vault commit 5a14a89d; verification none");
    expect(body).toContain(`### Ledger\n- disposition ${d.disposition_id}\n- finding fnd-fix\n- run ${RUN}\n- ticket tkt-0000000000000001`);
    expect(ticketTitle("FIX", "drift_vs_approved", APP, HOST)).toBe(`FIX drift_vs_approved: ${APP} on ${HOST}`);
    const long = ticketBody({ finding: { ...f, finding: { ...f.finding, summary: "x".repeat(BODY_MAX + 10) } }, disposition: d, rule: ON_FIX, actions: [], probes, ticketId: "t", type: "incident", priority: "P2" });
    expect(long.length).toBeLessThanOrEqual(BODY_MAX + 60);
    expect(long.endsWith(`(body cut at ${BODY_MAX} characters)`)).toBe(true);
  });
});

describe("ticketStep over the policy fixture (sql.js, a MemoryLedger, fake GitHub)", () => {
  const AT = "2026-10-23T03:00:00.000Z";
  async function stepOver(extra: { actions?: Action[]; tickets?: Ticket[] }, fake: ReturnType<typeof fakeGithub>, now: string) {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(policyBundle);
    const layer = new DataLayer(engine);
    const pass = await runPass(layer, { world: new DriftWorld("test_psa"), ledger: new MemoryLedger(engine), at: AT, decidedAt: AT });
    if (extra.actions) engine.insertRows("action", extra.actions);
    if (extra.tickets) engine.insertRows("ticket", extra.tickets);
    const rows = new MemoryTicketRows(extra.tickets ?? []);
    const { gh } = github(fake);
    const result = await ticketStep(layer, pass, gh, rows, { tenant: "client-a", dryRun: false, redactor, deny, now: () => now, print: quiet });
    const dispositions = objects(await layer.run(DISPOSITIONS_SQL, {}, { limit: 10_000 }));
    engine.close();
    return { result, rows, dispositions, pass };
  }

  it("every ESCALATE, every FIX and every HOLD under an alert-always rule opens an incident; the ROLLBACKs open changes once their actions are recorded, the verified one closed; a third step sends nothing", async () => {
    const fake = fakeGithub();
    const one = await stepOver({}, fake, "2026-10-23T04:00:00.000Z");
    const created = one.result.ops.filter((o): o is Extract<TicketOp, { op: "create" }> => o.op === "create");
    // what the ledger says should open, from the dispositions the pass recorded and the fixture's rules
    const alertOf = new Map((policyBundle.policy_rule as PolicyRule[]).map((r) => [r.rule_id, r.alert]));
    const opening = one.dispositions.filter((d) => d.verb === "ESCALATE" || d.verb === "FIX" || (d.verb === "HOLD" && alertOf.get(d.rule_id) === "always"));
    expect(created.map((o) => o.ticket.finding_id).sort()).toEqual([...new Set(opening.map((d) => d.finding_id))].sort());
    expect(created.every((o) => o.ticket.type === "incident" && o.ticket.priority === "P1")).toBe(true);
    expect(created.map((o) => o.draft.title)).toContain("FIX drift_vs_approved: /etc/nginx/conf.d/shop.conf on host-7f1c");
    expect(created.some((o) => / proxy_split: www\.example\.invalid on example\.invalid$/.test(o.draft.title))).toBe(true);
    const n = created.length;
    const findings = one.pass.findings.length;
    expect(one.result.summary).toBe(`TICKETS: tenant client-a, ${findings} finding(s), ${one.dispositions.length} disposition(s) and 0 action(s) in the ledger, 0 ticket row(s) before; plan: create ${n}, comment 0, close 0, skip ${findings - n}; created ${n}, commented 0, closed 0, synced 0, refused 0, failed 0`);
    expect(one.rows.rows.map((t) => [t.type, t.status, t.external_id])).toEqual(created.map((_, i) => ["incident", "open", String(41 + i)]));
    expect(fake.issues.get(41)!.body.split("\n").filter((l) => l.startsWith("### "))).toEqual(["### What", "### Evidence", "### Decision", "### Work done", "### Receipts", "### Ledger"]);

    const rollbackOf = (object: string) => one.dispositions.find((d) => d.verb === "ROLLBACK" && d.object_id === object && d.setting_path !== "proxied");
    const file = rollbackOf(APP)!;
    const rec = rollbackOf("rec-c3")!;
    expect([file?.surface, rec?.surface]).toEqual(["linux.nginx", "cloudflare.dns"]);
    const actions: Action[] = [
      { action_id: "act-file-done", tenant_id: "client-a", kind: "rollback_file", target: file.object_id, before_hash: file.value_hash, after_hash: H("a"), vault_commit: "0123abcd4567", verification: "probe-0000000000000001", receipts: "", status: "done", reason: "restored to the approved copy at vault commit 0123abcd", record: "after: the copy's bytes; nginx -t passed and nginx reloaded\nprobe probe-0000000000000001: http app.example.invalid ok (status 200)", started_at: "2026-10-23T03:30:00.000Z", finished_at: "2026-10-23T03:31:00.000Z", disposition_id: file.disposition_id },
      { action_id: "act-rec-failed", tenant_id: "client-a", kind: "revert_record", target: rec.object_id, before_hash: rec.value_hash, after_hash: rec.value_hash, vault_commit: "89abcdef0123", verification: "", receipts: "", status: "failed", reason: "PATCH of record rec-c3 failed: Cloudflare 403", record: "", started_at: "2026-10-23T03:32:00.000Z", finished_at: "2026-10-23T03:33:00.000Z", disposition_id: rec.disposition_id },
    ];
    const two = await stepOver({ actions, tickets: one.rows.rows }, fake, "2026-10-23T05:00:00.000Z");
    expect(two.result.ops.filter((o) => o.op !== "skip").map((o) => [o.op, (o as Extract<TicketOp, { op: "create" }>).ticket.ticket_id, (o as Extract<TicketOp, { op: "create" }>).ticket.type])).toEqual([
      ["create", ticketId("client-a", file.finding_id, "act-file-done"), "change"],
      ["create", ticketId("client-a", rec.finding_id, "act-rec-failed"), "change"],
    ]);
    const [closedNo, openNo] = [41 + n, 42 + n];
    expect(two.result.outcomes.filter((o) => o.op === "create").map((o) => [o.status, o.external_id])).toEqual([["closed", String(closedNo)], ["created", String(openNo)]]);
    expect([fake.issues.get(closedNo)!.state, fake.issues.get(openNo)!.state]).toEqual(["closed", "open"]);
    expect(fake.issues.get(closedNo)!.title).toBe(`ROLLBACK drift_vs_approved: ${APP} on host-7f1c`);
    expect(fake.issues.get(openNo)!.title).toMatch(/^ROLLBACK drift_vs_approved: .+ on .+$/);
    expect(fake.issues.get(openNo)!.body).toContain("- action act-rec-failed: revert_record failed");
    // Work done carries the Actor's sentence under each action, Evidence each line of its record under its id
    const closedBody = fake.issues.get(closedNo)!.body;
    expect(closedBody).toContain("\n  - restored to the approved copy at vault commit 0123abcd\n");
    const evidence = closedBody.slice(closedBody.indexOf("### Evidence"), closedBody.indexOf("### Decision"));
    expect(evidence).toContain("- action act-file-done (rollback_file): after: the copy's bytes; nginx -t passed and nginx reloaded\n- action act-file-done (rollback_file): probe probe-0000000000000001: http app.example.invalid ok (status 200)");
    expect(fake.issues.get(openNo)!.body).toContain("\n  - PATCH of record rec-c3 failed: Cloudflare 403");

    const before = fake.calls.length;
    const three = await stepOver({ actions, tickets: two.rows.rows }, fake, "2026-10-23T06:00:00.000Z");
    expect(three.result.ops.map((o) => o.op)).toEqual(Array(three.pass.findings.length).fill("skip"));
    expect(fake.calls.length).toBe(before);
  });
});

describe("src/psa/mapping.json, the field map of the absent adapters", () => {
  it("names, for HaloPSA, ConnectWise and Autotask, the field of every ticket column and a value for each of the agent's types, priorities and statuses", () => {
    const m = mapping as unknown as Record<string, Record<string, { field?: string; values?: Record<string, unknown> }>> & { columns: string[] };
    expect(m.columns).toEqual(["type", "priority", "status", "summary", "details", "configuration_item"]);
    for (const psa of ["halo", "connectwise", "autotask", "github"]) {
      for (const c of m.columns) expect(typeof m[psa][c]?.field, `${psa}.${c}`).toBe("string");
      expect(Object.keys(m[psa].type.values!)).toEqual(["change", "incident"]);
      expect(Object.keys(m[psa].priority.values!)).toEqual(["P1", "P2", "P3", "P4"]);
      expect(Object.keys(m[psa].status.values!)).toEqual(["open", "closed"]);
    }
  });
});

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("Store.updateTicket and ticketsOf, live drift-pg (throwaway schema)", () => {
  const schema = `test_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let store: Store;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    store = Store.fromEnv({ schema });
    await store.applySchema();
  });
  afterAll(async () => {
    await store?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("sets external_id, a redacted url, status and action_id with updated_at; 0 for an unknown id; refuses another column and a non-canonical instant", async () => {
    const t: Ticket = { ticket_id: "tkt-0000000000000001", tenant_id: T, psa: "github", external_id: null, url: null, type: "incident", priority: "P1", status: "open", action_id: null, finding_id: "fnd-1", created_at: NOW1, updated_at: NOW1 };
    expect(await store.insertTickets([t])).toBe(1);
    expect(await store.updateTicket(t.ticket_id, { external_id: "41", url: "https://app.bluefin-logistics-zz9q.com/owner/tickets/issues/41", updated_at: NOW2 })).toBe(1);
    expect(await store.updateTicket(t.ticket_id, { status: "closed", action_id: "act-1", updated_at: NOW2 })).toBe(1);
    expect(await store.updateTicket("tkt-ffffffffffffffff", { status: "closed", updated_at: NOW2 })).toBe(0);
    await expect(store.updateTicket(t.ticket_id, { finding_id: "fnd-2", updated_at: NOW2 } as never)).rejects.toThrow(/ticket: column finding_id is not updatable/);
    await expect(store.updateTicket(t.ticket_id, { status: "open", updated_at: "2026-10-24T21:05:00Z" })).rejects.toThrow(/ticket\.updated_at: timestamps must be/);
    const [row] = await store.ticketsOf(T);
    expect(row).toMatchObject({ external_id: "41", status: "closed", action_id: "act-1", updated_at: NOW2, created_at: NOW1 });
    expect(row.url).toMatch(/^https:\/\/host-[0-9a-f]{6}\.com\/owner\/tickets\/issues\/41$/);
    expect(await store.ticketsOf("client-b")).toEqual([]);
  });
});

const TICKETS_LIVE = process.env.TICKETS_LIVE === "true";
if (!TICKETS_LIVE) console.log("psa: live GitHub smoke skipped (set TICKETS_LIVE=true; it uses DRIFT_TICKETS_REPO and the token gh auth token prints)");
describe.skipIf(!TICKETS_LIVE)("GitHub Issues, live (DRIFT_TICKETS_REPO)", () => {
  it("creates one smoke issue with a two-line redacted body, comments once and closes it", { timeout: 120_000 }, async () => {
    const live = new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords);
    const gh = new GithubIssues({ redactor: live, deny: [...new Set([...config.redactWords, ...config.exportDenyWords])] });
    const at = new Date().toISOString();
    const t0 = Date.now();
    const ref = await gh.create({
      title: `drift-agent smoke: ${at}`,
      body: `Smoke test of the drift-agent ticket adapter at ${at}.\nCreated, commented on once and closed by test/psa.test.ts.`,
      labels: ["drift-agent"],
    });
    await gh.comment(ref.external_id, `The smoke test comments once at ${new Date().toISOString()} and closes the issue.`);
    await gh.close(ref.external_id);
    expect(await gh.status(ref.external_id)).toBe("closed");
    expect(ref.external_id).toMatch(/^\d+$/);
    console.log(`psa: smoke issue #${ref.external_id} ${live.text(ref.url)}: created, commented once, closed in ${Date.now() - t0} ms; ${gh.requests.length} request(s): ${gh.requests.join(", ")}`);
  });
});
