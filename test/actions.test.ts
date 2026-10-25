// The Actor (src/actions/) over test/fixtures/policy-bundle.json: the pass runs into an in-memory ledger, a vault in a
// temp directory holds the fixture's runs, and the host, Cloudflare, the probes and the model are fakes
// (test/fixtures/actions/). Every write path is driven to each of its ends: the dry-run plan, rollback done, nginx -t
// refusing with the previous bytes written back, sudo asking for a password, the reload failing, a probe failing after
// the reload, the record reverted with its authoritative read back, the approved-but-missing file and record created,
// a completed write no probe verified (unverified: an empty or unreadable probe population, names resolving nowhere,
// a record with no dns probe), the retry after an unverified write, the change ticket an unverified write leaves open
// and the later pass that closes it (fake GitHub fetch), the investigation done with its receipts and not_judged on a
// refused receipt, the fix refused, and a second run over the same dispositions writing nothing. The ACTIONS_SQL read
// is asserted on sql.js; Store.actionsOf against a throwaway schema of the live Postgres, skipped without DATABASE_URL.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "../src/config.ts"; // loads .env into process.env
import { aliasFromHosts, act, actLines, kindsFor, latestRuns, probeNames, type ActResult } from "../src/actions/act.ts";
import { FIX_REFUSED } from "../src/actions/investigate.ts";
import { formatPlan, namedCommit, targetOf, type ActionOutcome, type ProbeFn } from "../src/actions/plan.ts";
import { NGINX_PATH, WriteSessionError, parseSession, shQuote, writeScript } from "../src/actions/ssh.ts";
import { dnsObservationRows, dnsRecordRow, type FetchLike } from "../src/collectors/cloudflare.ts";
import { pseudonymHost, readScript } from "../src/collectors/linux.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { DataLayer } from "../src/data/layer.ts";
import { ACTIONS_SQL, approvedMissing, driftVsApproved, objects, tenantActions } from "../src/data/queries.ts";
import { actionId, dispositionId, obsId, probeId, type Action, type ActionKind, type Disposition, type Probe } from "../src/data/rows.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { runPass, type PassResult } from "../src/pipeline.ts";
import { Store } from "../src/data/store.ts";
import { tenantAppId } from "../src/gate.ts";
import { GithubIssues } from "../src/psa/github.ts";
import { ticketId, type TicketOp } from "../src/psa/index.ts";
import { MemoryTicketRows, ticketStep } from "../src/psa/step.ts";
import { Redactor } from "../src/redactor.ts";
import { FakeModel } from "./fixtures/actions/fake-model.ts";
import { ALIAS, APP, BLOG, HOST, SHOP, TENANT, ZONE, ZONE_ID, buildBase, buildWorld, type Base, type World } from "./fixtures/actions/world.ts";
import policyBundle from "./fixtures/policy-bundle.json" with { type: "json" };

const hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const body = (run: string, object: string): string => policyBundle.observation.find((o) => o.run_id === run && o.object_id === object && o.setting_path === "file")!.value_redacted!;
const APPROVED_APP = body("run-nginx-7f1c-1020", APP);
const LIVE_APP = body("run-nginx-7f1c-1023", APP);
const APPROVED_BLOG = body("run-nginx-7f1c-1020", BLOG);
const bashOk = spawnSync("bash", ["-c", "true"]).status === 0;

const of = (w: World, verb: string, object: string, setting = "file"): Disposition => w.dispositions.find((d) => d.verb === verb && d.object_id === object && d.setting_path === setting && d.decided_at === "2026-10-23T03:00:00.000Z")!;
const run = (w: World, opts: Partial<Parameters<typeof act>[0]> = {}, over: Parameters<World["deps"]>[0] = {}): Promise<ActResult> =>
  act({ tenantId: TENANT, apply: true, ...opts }, w.deps(over));
const actions = async (w: World): Promise<Action[]> => objects(await tenantActions(w.layer, TENANT)) as unknown as Action[];
/** The outcome of one disposition's action of one kind. */
const pick = (res: ActResult, d: Disposition, kind: ActionKind): ActionOutcome => res.outcomes.find((o) => o.action.disposition_id === d.disposition_id && o.action.kind === kind)!;
const app = async (w: World): Promise<ActionOutcome> => pick(await run(w, { only: ["rollback_file"] }), of(w, "ROLLBACK", APP), "rollback_file");
/** A probe population that holds no record of the names asked for, through the live Actor's own probeNames. */
const noRecords = (w: World): ProbeFn => probeNames({ tenantId: TENANT, redactor: w.redactor, population: async () => [], sink: null });

/** GitHub Issues in memory: the label listing and creates, issue create, comment, close and status. */
function fakeIssues() {
  const issues = new Map<number, { title: string; body: string; state: string; comments: string[] }>();
  let next = 0;
  const json = (status: number, v: unknown): Response => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    if (u.pathname.endsWith("/labels")) return method === "GET" ? json(200, []) : json(201, { name: body?.name });
    if (u.pathname.endsWith("/issues") && method === "POST") {
      const n = ++next;
      issues.set(n, { title: String(body?.title), body: String(body?.body), state: "open", comments: [] });
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
  return { fetch, issues };
}

describe("the write script", () => {
  const input = { path: "/etc/nginx/conf.d/app.conf", copy: Buffer.from(APPROVED_APP), previous: Buffer.from(LIVE_APP) };

  it("quotes the path, decodes the copy and the previous bytes from base64 heredocs through sudo -n tee, runs nginx -t and the reload, and names each hash", () => {
    const s = writeScript(input);
    expect(s).toContain("P='/etc/nginx/conf.d/app.conf'");
    expect(s).toContain(`EXPECT='${hex(LIVE_APP)}'`);
    expect(s).toContain(`COPY='${hex(APPROVED_APP)}'`);
    const b64 = (t: string): string => Buffer.from(t).toString("base64").match(/.{1,76}/g)!.join("\n");
    expect(s).toContain(`base64 -d <<'DRIFT_COPY' | sudo -n tee -- "$P" >/dev/null\n${b64(APPROVED_APP)}\nDRIFT_COPY`);
    expect(s).toContain(`base64 -d <<'DRIFT_PREVIOUS' | sudo -n tee -- "$P" >/dev/null\n${b64(LIVE_APP)}\nDRIFT_PREVIOUS`);
    expect(s.split("\n").every((l) => l.length <= 160)).toBe(true);
    expect(s).toContain("section nginx-t sudo -n nginx -t");
    expect(s).toContain("section reload sudo -n systemctl reload nginx");
    expect(s).not.toContain("proxy_pass"); // the bytes travel as base64 only
  });

  it("restores an absent previous state by removing the file the copy created", () => {
    const s = writeScript({ ...input, previous: null });
    expect(s).toContain("EXPECT='absent'");
    expect(s).toContain(`put_previous() { sudo -n rm -f -- "$P"; }`);
    expect(s).not.toContain("DRIFT_PREVIOUS");
  });

  it("takes paths under /etc/nginx/ in plain characters only; a single quote is escaped by the quoting rule", () => {
    for (const bad of ["/etc/passwd", "/etc/nginx/../shadow", "/etc/nginx/conf.d/a b.conf", "/etc/nginx/conf.d/x';rm -rf /;'.conf", "etc/nginx/x.conf", "/etc/nginx/./x.conf", "/etc/nginx/conf.d/x.conf\n"]) {
      expect(() => writeScript({ ...input, path: bad })).toThrow(WriteSessionError);
    }
    expect(NGINX_PATH.test("/etc/nginx/sites-available/host-524b42.quest")).toBe(true);
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });

  it.skipIf(!bashOk)("bash -n accepts the script, with and without previous bytes", () => {
    for (const s of [writeScript(input), writeScript({ ...input, previous: null })]) {
      const r = spawnSync("bash", ["-n"], { input: s, encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    }
  });

  describe.skipIf(!bashOk)("run under bash against a temp file, sudo stubbed (it runs tee and rm itself, and answers nginx and systemctl from env)", () => {
    const STUB = `sudo() {
  [ "$1" = "-n" ] && shift
  if [ "\${FAKE_SUDO:-ok}" = password ]; then echo "sudo: a password is required" >&2; return 1; fi
  case "$1" in
    nginx) if [ "\${FAKE_NGINX:-ok}" = ok ]; then echo "nginx: configuration file test is successful" >&2; else echo 'nginx: [emerg] unknown directive "proxy_pas"' >&2; return 1; fi ;;
    systemctl) if [ "\${FAKE_RELOAD:-ok}" != ok ]; then echo "Job for nginx.service failed" >&2; return 1; fi ;;
    *) "$@" ;;
  esac
}
`;
    let dir: string;
    beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), "drift-write-")).split(path.sep).join("/"); });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const go = (file: string, previous: string | null, env: Record<string, string> = {}) => {
      const target = `${dir}/${file}`;
      const script = writeScript({ ...input, previous: previous === null ? null : Buffer.from(previous) }).replace(/^P='[^']*'$/m, `P='${target}'`);
      const r = spawnSync("bash", ["-s"], { input: STUB + script, encoding: "utf8", env: { ...process.env, ...env } });
      return { s: parseSession(r.stdout), target };
    };
    const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null);

    it("writes the copy, passes nginx -t, reloads and reports the copy's hash after", () => {
      const p = `${dir}/a.conf`;
      writeFileSync(p, LIVE_APP);
      const { s } = go("a.conf", LIVE_APP);
      expect(s).toMatchObject({ complete: true, before: hex(LIVE_APP), written: hex(APPROVED_APP), after: hex(APPROVED_APP), restored: null, changed: false });
      expect(s.sections.map((x) => [x.name, x.rc])).toEqual([["write", 0], ["nginx-t", 0], ["reload", 0]]);
      expect(read(p)).toBe(APPROVED_APP);
    });

    it("writes the previous bytes back when nginx -t refuses or the reload fails; removes a file it created", () => {
      const p = `${dir}/b.conf`;
      writeFileSync(p, LIVE_APP);
      const refused = go("b.conf", LIVE_APP, { FAKE_NGINX: "refuse" }).s;
      expect(refused.sections.map((x) => [x.name, x.rc])).toEqual([["write", 0], ["nginx-t", 1], ["restore", 0]]);
      expect(refused.sections[1].output).toContain("[emerg]");
      expect([refused.restored, read(p)]).toEqual([hex(LIVE_APP), LIVE_APP]);
      const reload = go("b.conf", LIVE_APP, { FAKE_RELOAD: "fail" }).s;
      expect(reload.sections.map((x) => [x.name, x.rc])).toEqual([["write", 0], ["nginx-t", 0], ["reload", 1], ["restore", 0]]);
      expect([reload.restored, reload.after, read(p)]).toEqual([hex(LIVE_APP), null, LIVE_APP]);
      const created = go("c.conf", null, { FAKE_NGINX: "refuse" }).s;
      expect([created.before, created.restored, read(`${dir}/c.conf`)]).toEqual(["absent", "absent", null]);
    });

    it("stops before writing when the live file differs from the run's bytes or sudo asks for a password", () => {
      const p = `${dir}/d.conf`;
      writeFileSync(p, "server { }\n");
      expect(go("d.conf", LIVE_APP).s).toMatchObject({ complete: true, changed: true, written: null, sections: [] });
      writeFileSync(p, LIVE_APP);
      const sudo = go("d.conf", LIVE_APP, { FAKE_SUDO: "password" }).s;
      expect(sudo.sections).toEqual([{ name: "write", rc: 1, output: "sudo: a password is required" }]);
      expect([sudo.written, sudo.restored, read(p)]).toEqual([null, null, LIVE_APP]);
    });
  });

  it("the read collector's script stays free of sudo; the write script is the one place it appears", () => {
    expect(readScript("/var/backups/export")).not.toMatch(/\bsudo\b/);
    expect(writeScript(input)).toMatch(/\bsudo -n\b/);
  });

  it("parses markers and sections; DONE marks a script that ran to its end", () => {
    const s = parseSession("@@DRIFT@@ BEFORE abc\n@@DRIFT@@ BEGIN write\n\n@@DRIFT@@ END 0\n@@DRIFT@@ WRITTEN def\n@@DRIFT@@ BEGIN nginx-t\nnginx: [emerg] x\n@@DRIFT@@ END 1\n@@DRIFT@@ BEGIN restore\n\n@@DRIFT@@ END 0\n@@DRIFT@@ RESTORED abc\n@@DRIFT@@ DONE\n");
    expect(s).toMatchObject({ complete: true, before: "abc", written: "def", restored: "abc", after: null, changed: false, link: false });
    expect(s.sections.map((x) => [x.name, x.rc, x.output])).toEqual([["write", 0, ""], ["nginx-t", 1, "nginx: [emerg] x"], ["restore", 0, ""]]);
    expect(parseSession("@@DRIFT@@ BEFORE abc\n").complete).toBe(false);
  });
});

describe("the Actor's rules", () => {
  const d = (verb: string, surface = "linux.nginx"): Disposition => ({ verb, surface } as Disposition);
  it("maps verbs to kinds: ROLLBACK by surface, FIX to investigate then fix, ESCALATE only under on_drift investigate", () => {
    expect(kindsFor(d("ROLLBACK"), "rollback")).toEqual(["rollback_file"]);
    expect(kindsFor(d("ROLLBACK", "cloudflare.dns"), "rollback")).toEqual(["revert_record"]);
    expect(kindsFor(d("ROLLBACK", "linux.etc"), "rollback")).toEqual([]);
    expect(kindsFor(d("FIX"), "rollback")).toEqual(["investigate", "fix"]);
    expect(kindsFor(d("ESCALATE"), "investigate")).toEqual(["investigate"]);
    expect(kindsFor(d("ESCALATE"), "hold")).toEqual([]);
    expect(kindsFor(d("HOLD"), "investigate")).toEqual([]);
    expect(kindsFor(d("ADOPT"), "investigate")).toEqual([]);
  });

  it("scopes to the run of each surface and host's latest decided disposition", () => {
    const row = (surface: string, host: string | null, run: string, at: string) => ({ surface, host, run_id: run, decided_at: at } as Disposition);
    expect(latestRuns([
      row("linux.nginx", "host-a", "run-1", "2026-10-23T00:00:00.000Z"), row("linux.nginx", "host-a", "run-2", "2026-10-24T00:00:00.000Z"),
      row("linux.nginx", "host-b", "run-3", "2026-10-23T00:00:00.000Z"), row("cloudflare.dns", null, "run-4", "2026-10-22T00:00:00.000Z"),
    ])).toEqual(["run-2", "run-3", "run-4"]);
  });

  it("names the vault commit a ROLLBACK's reason carries; maps a host pseudonym back to its alias the way the collector redacts it", () => {
    expect(namedCommit("live value drifted from approved 4c3598bc9929; vault commit 5a14a89d holds the approved copy, validated ok")).toBe("5a14a89d");
    expect(namedCommit("rule x holds this finding")).toBeNull();
    const r = new Redactor("alias-test-salt");
    const aliasOf = aliasFromHosts(["web-a", "web-b"], r);
    expect(aliasOf(pseudonymHost(r, "web-b"))).toBe("web-b");
    expect(aliasOf("host-000000")).toBeNull();
  });
});

describe("the Actor over the policy fixture", () => {
  let w: World;
  let base: Base;
  beforeAll(() => { base = buildBase(); });
  afterAll(() => base.cleanup());
  beforeEach(async () => { w = await buildWorld(base); });
  afterEach(() => w.cleanup());

  it("the pass leaves ROLLBACK on app.conf, on the missing blog.conf and on rec-c3's content, FIX on shop.conf, each ROLLBACK naming its vault commit", () => {
    expect(namedCommit(of(w, "ROLLBACK", APP).reason)).toBe(w.commits["run-nginx-7f1c-1020"].slice(0, 8));
    expect(namedCommit(of(w, "ROLLBACK", BLOG).reason)).toBe(w.commits["run-nginx-7f1c-1020"].slice(0, 8));
    expect(of(w, "ROLLBACK", BLOG).value_hash).toBe("");
    expect(namedCommit(of(w, "ROLLBACK", "rec-c3", "content").reason)).toBe(w.commits["run-dns-1020"].slice(0, 8));
    expect(of(w, "FIX", SHOP)).toBeDefined();
    expect(w.pass.verbs).toMatchObject({ ROLLBACK: 3, FIX: 1 });
  });

  it("a dry run prints the plan, redacted and without a byte, and writes nothing anywhere", async () => {
    const res = await run(w, { apply: false });
    expect(res.plan.map((p) => p.kind).sort()).toEqual(["fix", "investigate", "revert_record", "rollback_file", "rollback_file"]);
    expect(res.outcomes).toEqual([]);
    expect(res.written).toBeNull();
    const rollback = res.plan.find((p) => p.disposition_id === of(w, "ROLLBACK", APP).disposition_id)!;
    expect(rollback.action_id).toBe(actionId(TENANT, of(w, "ROLLBACK", APP).disposition_id, "rollback_file"));
    expect(rollback.lines).toEqual([
      `target ${APP} on ${HOST} (ssh alias ${ALIAS}), ROLLBACK under ${of(w, "ROLLBACK", APP).rule_id}`,
      `write ${Buffer.byteLength(APPROVED_APP)} bytes (sha256 ${hex(APPROVED_APP).slice(0, 12)}) from vault commit ${w.commits["run-nginx-7f1c-1020"].slice(0, 8)} (copy copy-b85a271d52427644 of run run-nginx-7f1c-1020, validated ok with 0 gaps) over the live file ${hex(LIVE_APP).slice(0, 12)} as run run-nginx-7f1c-1023 recorded it, through sudo -n tee`,
      "then sudo -n nginx -t, the previous bytes written back on a refusal; sudo -n systemctl reload nginx, the same on a failure; the file's sha256 after",
      "then probes http and tls of app.example.invalid",
    ]);
    const blog = res.plan.find((p) => p.disposition_id === of(w, "ROLLBACK", BLOG).disposition_id)!;
    expect(blog.lines[1]).toContain("where run run-nginx-7f1c-1023 recorded no file, so the copy creates it, through sudo -n tee");
    expect(blog.lines[2]).toContain("the previous state restored by removing the file on a refusal");
    const revert = res.plan.find((p) => p.kind === "revert_record")!;
    expect(revert.lines[1]).toMatch(new RegExp(`^PATCH the record's type, name, content, ttl and proxied to the approved copy at vault commit ${w.commits["run-dns-1020"].slice(0, 8)} .*: content from b2e7a764f9c0 to ad2e4ad71240$`));
    expect(revert.lines[2]).toContain("one dns probe of mail.example.invalid, which resolvers answer from cache until the TTL (3600 s) passes");
    expect(res.plan.find((p) => p.kind === "fix")!.refused).toBe(FIX_REFUSED);
    const text = [...formatPlan(res.plan, w.redactor), ...actLines(TENANT, res, w.redactor)].join("\n");
    expect(text).not.toMatch(/proxy_pass|server \{|client_max_body_size/);
    expect(text).not.toContain(Buffer.from(APPROVED_APP).toString("base64").slice(0, 24));
    expect(text).toContain("act: dry run: 5 actions planned (rollback_file 2, revert_record 1, investigate 1, fix 1), 1 of them refused on --apply; 0 already recorded; 0 action rows written");
    expect([w.host.scripts.length, w.cf.log.length, w.model.calls.length, w.probes.length, (await actions(w)).length]).toEqual([0, 0, 0, 0, 0]);
  });

  it("rollback_file done: the copy written, nginx -t passed, reloaded, after hash the copy's, every probe of the served names ok", async () => {
    const o = await app(w);
    expect(o.action).toMatchObject({
      kind: "rollback_file", status: "done", target: targetOf(of(w, "ROLLBACK", APP)), vault_commit: w.commits["run-nginx-7f1c-1020"],
      before_hash: `sha256:${hex(LIVE_APP)}`, after_hash: `sha256:${hex(APPROVED_APP)}`, receipts: "", disposition_id: of(w, "ROLLBACK", APP).disposition_id,
    });
    expect(o.action.verification.split(",")).toHaveLength(2);
    expect(o.reason).toBe(`restored to the approved copy at vault commit ${w.commits["run-nginx-7f1c-1020"].slice(0, 8)}; nginx -t passed, nginx reloaded, 2 probes of app.example.invalid ok`);
    expect(w.host.files.get(APP)!.toString("utf8")).toBe(APPROVED_APP);
    expect(w.host.scripts.every((s) => s.alias === ALIAS)).toBe(true);
    expect(w.probes).toContainEqual({ names: ["app.example.invalid"], kinds: ["http", "tls"] });
    expect(o.record.some((l) => l.startsWith("probe probe-") && l.includes("http app.example.invalid ok"))).toBe(true);
    expect((await actions(w)).filter((a) => a.disposition_id === of(w, "ROLLBACK", APP).disposition_id).map((a) => [a.kind, a.status])).toEqual([["rollback_file", "done"]]);
    expect(w.tracer.events.some((e) => e.agent === "actor" && e.action === "revise" && e.status === "ok")).toBe(true);
  });

  it("nginx -t refusing: the previous bytes go back and the action is failed with nginx's line", async () => {
    w.host.opts.nginxT = "refuse";
    const o = await app(w);
    expect(o.action.status).toBe("failed");
    expect(o.reason).toBe(`nginx -t refused the copy: [emerg] unknown directive "proxy_pas" in ${APP}:5; the previous bytes were written back, the file is ${hex(LIVE_APP).slice(0, 12)} again`);
    expect(w.host.files.get(APP)!.toString("utf8")).toBe(LIVE_APP);
    expect(w.host.writes.filter((x) => x.startsWith(APP))).toEqual([`${APP} ${hex(APPROVED_APP)}`, `${APP} ${hex(LIVE_APP)}`]);
    expect(o.action.after_hash).toBe(`sha256:${hex(LIVE_APP)}`);
    expect(w.probes).toEqual([]);
  });

  it("sudo asking for a password: refused with that sentence, nothing written", async () => {
    w.host.opts.sudo = "password";
    const o = await app(w);
    expect([o.action.status, o.reason]).toEqual(["refused", "sudo: a password is required"]);
    expect(w.host.files.get(APP)!.toString("utf8")).toBe(LIVE_APP);
    expect(w.host.writes).toEqual([]);
  });

  it("a symlink at the path: refused, nothing written", async () => {
    w.host.opts.link = true;
    const o = await app(w);
    expect([o.action.status, o.reason]).toEqual(["refused", "the live path is a symlink; the write path writes regular files only"]);
    expect(w.host.writes).toEqual([]);
  });

  it("the reload failing: the previous bytes go back and the action is failed with systemd's line", async () => {
    w.host.opts.reload = "fail";
    const o = await app(w);
    expect(o.action.status).toBe("failed");
    expect(o.reason).toMatch(/^systemctl reload nginx failed: Job for nginx\.service failed because the control process exited with error code\.; the previous bytes were written back/);
    expect(w.host.files.get(APP)!.toString("utf8")).toBe(LIVE_APP);
  });

  it("a probe failing after the reload: failed, the failing probes named, their ids kept as verification", async () => {
    w.failing.add("app.example.invalid");
    const o = await app(w);
    expect(o.action.status).toBe("failed");
    expect(o.reason).toBe("written and reloaded; 2 of 2 probes fail: http app.example.invalid, tls app.example.invalid");
    expect(o.action.verification.split(",")).toHaveLength(2);
    expect(w.host.files.get(APP)!.toString("utf8")).toBe(APPROVED_APP);
  });

  it("the live file changed since the run: refused, nothing written; the session dying: failed with ssh's line", async () => {
    w.host.files.set(APP, Buffer.from("server { }\n"));
    const changed = await app(w);
    expect(changed.action.status).toBe("refused");
    expect(changed.reason).toMatch(/^the live file is [0-9a-f]{12} and run run-nginx-7f1c-1023 recorded [0-9a-f]{12}: it changed since the decision, and nothing was written$/);
    expect(w.host.writes.filter((x) => x.startsWith(APP))).toEqual([]);
    const v = await buildWorld(base);
    try {
      v.host.opts.dies = 255;
      const o = await app(v);
      expect([o.action.status, o.reason]).toEqual(["failed", `the ssh session to ${ALIAS} ended before the script reported (exit 255: ssh: connect to host port 22: Connection timed out)`]);
    } finally {
      v.cleanup();
    }
  });

  it("a failed rollback is attempted once: another disposition of the same file, commit and live bytes is refused", async () => {
    w.host.opts.nginxT = "refuse";
    await app(w);
    const sessions = w.host.scripts.length;
    const first = of(w, "ROLLBACK", APP);
    const again: Disposition = { ...first, finding_id: "fnd-0000000000000001", disposition_id: dispositionId(first.tenant_id, first.surface, first.host, first.object_id, first.setting_path, first.value_hash, "fnd-0000000000000001", first.run_id, first.decided_at) };
    w.engine.insertRows("disposition", [again]);
    const o = pick(await run(w, { only: ["rollback_file"] }), again, "rollback_file");
    expect(o.action.status).toBe("refused");
    expect(o.reason).toMatch(/^action act-[0-9a-f]{16} rolled this file back to commit [0-9a-f]{8} over the same live bytes and failed at .*; the same write is left to a technician$/);
    expect(w.host.scripts).toHaveLength(sessions);
  });

  it("rollback_file unverified: written, nginx -t passed, reloaded, the after hash the copy's, and no probe read: an empty population, an unreadable one, names resolving nowhere", async () => {
    const d = of(w, "ROLLBACK", APP);
    const res = await run(w, { only: ["rollback_file"] }, { probe: noRecords(w) });
    const o = pick(res, d, "rollback_file");
    expect(o.action).toMatchObject({ status: "unverified", before_hash: `sha256:${hex(LIVE_APP)}`, after_hash: `sha256:${hex(APPROVED_APP)}`, verification: "", vault_commit: w.commits["run-nginx-7f1c-1020"] });
    expect(o.reason).toBe("written and reloaded; no probe of app.example.invalid ran (the account holds no record of these names)");
    expect(o.record).toContain(`after: ${hex(APPROVED_APP).slice(0, 12)}, the copy's bytes; nginx -t passed and nginx reloaded`);
    expect(w.host.files.get(APP)!.toString("utf8")).toBe(APPROVED_APP);
    expect((await actions(w)).filter((a) => a.disposition_id === d.disposition_id).map((a) => [a.kind, a.status, a.reason])).toEqual([["rollback_file", "unverified", o.reason]]);
    expect(w.tracer.events.some((e) => e.agent === "actor" && e.action === "revise" && e.status === "not_checked")).toBe(true);
    // app.conf and the missing blog.conf, both written with no probe read
    expect(actLines(TENANT, res, w.redactor).at(-1)).toBe("act: applied: 2 actions (rollback_file 2, revert_record 0, investigate 0, fix 0): done 0, unverified 2, failed 0, refused 0, not_judged 0; 0 already recorded; 2 action rows written");

    const unreadable = await buildWorld(base);
    try {
      const population = async (): Promise<never> => { throw new Error("Cloudflare 400 GET /zones: 6003: Invalid request headers"); };
      const u = pick(await run(unreadable, { only: ["rollback_file"] }, { probe: probeNames({ tenantId: TENANT, redactor: unreadable.redactor, population, sink: null }) }), of(unreadable, "ROLLBACK", APP), "rollback_file");
      expect([u.action.status, u.reason]).toEqual(["unverified", "written and reloaded; the probes of app.example.invalid did not run: Cloudflare 400 GET /zones: 6003: Invalid request headers"]);
    } finally {
      unreadable.cleanup();
    }
    const nowhere = await buildWorld(base);
    try {
      const probe: ProbeFn = async (names, kinds) => names.flatMap((name) => kinds.map((kind): Probe => ({
        probe_id: probeId("run-verify-x", kind, name), run_id: "run-verify-x", tenant_id: TENANT, kind, target: name, expected: "answers", observed: "unreachable: ENOTFOUND",
        status: "fail", latency_ms: 5, observed_at: "2026-10-23T03:05:00.000Z",
      })));
      const n = pick(await run(nowhere, { only: ["rollback_file"] }, { probe }), of(nowhere, "ROLLBACK", APP), "rollback_file");
      expect([n.action.status, n.reason]).toEqual(["unverified", "written and reloaded; 2 of 2 probes reached no address: app.example.invalid resolves nowhere (ENOTFOUND)"]);
      expect(n.action.verification.split(",")).toHaveLength(2);
    } finally {
      nowhere.cleanup();
    }
  });

  it("an unverified rollback completed its write: the same file, commit and live bytes again is written once more, its reason naming the unverified action", async () => {
    const first = pick(await run(w, { only: ["rollback_file"] }, { probe: noRecords(w) }), of(w, "ROLLBACK", APP), "rollback_file");
    expect(first.action.status).toBe("unverified");
    // the file is the copy now; the same live bytes come back, as a second break with the first one's bytes
    w.host.files.set(APP, Buffer.from(LIVE_APP));
    const sessions = w.host.scripts.length;
    const src = of(w, "ROLLBACK", APP);
    const again: Disposition = { ...src, finding_id: "fnd-0000000000000002", disposition_id: dispositionId(src.tenant_id, src.surface, src.host, src.object_id, src.setting_path, src.value_hash, "fnd-0000000000000002", src.run_id, src.decided_at) };
    w.engine.insertRows("disposition", [again]);
    const at = "2026-10-23T03:04:00.000Z";
    const plan = (await run(w, { only: ["rollback_file"], apply: false })).plan.find((p) => p.disposition_id === again.disposition_id)!;
    expect(plan.refused).toBeUndefined();
    expect(plan.lines.at(-1)).toBe(`action ${first.action.action_id} wrote this copy over the same live bytes at ${at} and ended unverified; the write runs again`);
    const o = pick(await run(w, { only: ["rollback_file"] }), again, "rollback_file");
    expect(o.action.status).toBe("done");
    expect(o.reason).toBe(`restored to the approved copy at vault commit ${w.commits["run-nginx-7f1c-1020"].slice(0, 8)}; nginx -t passed, nginx reloaded, 2 probes of app.example.invalid ok; action ${first.action.action_id} wrote the same copy over the same live value at ${at} and ended unverified`);
    expect(w.host.scripts).toHaveLength(sessions + 1);
    expect(w.host.files.get(APP)!.toString("utf8")).toBe(APPROVED_APP);
  });

  it("the ticket step on an unverified rollback: the change opens with a comment that the write completed and what verification is missing, stays open, and the next pass that finds the file at its approved value closes it", async () => {
    const d = of(w, "ROLLBACK", APP);
    const o = pick(await run(w, { only: ["rollback_file"] }, { probe: noRecords(w) }), d, "rollback_file");
    const gh = fakeIssues();
    const issues = new GithubIssues({ repo: "example-owner/drift-tickets", fetch: gh.fetch, redactor: w.redactor, deny: [], token: () => "test-token-for-the-fake" });
    const step = (pass: Pick<PassResult, "findings" | "gatedOut">, rows: MemoryTicketRows, now: string) =>
      ticketStep(w.layer, pass, issues, rows, { tenant: TENANT, dryRun: false, redactor: w.redactor, deny: [], now: () => now, print: () => undefined });
    const id = ticketId(TENANT, d.finding_id, o.action.action_id);
    const ledger = ["", "### Ledger", `- disposition ${d.disposition_id}`, `- finding ${d.finding_id}`, `- run ${d.run_id}`, `- ticket ${id}`];

    const rows = new MemoryTicketRows();
    const one = await step(w.pass, rows, "2026-10-23T04:00:00.000Z");
    const create = one.ops.find((x): x is Extract<TicketOp, { op: "create" }> => x.op === "create" && x.ticket.ticket_id === id)!;
    expect([create.ticket.type, create.ticket.priority, create.close]).toEqual(["change", "P1", null]);
    const created = one.outcomes.find((x) => x.ticket_id === id)!;
    expect(created.status).toBe("created");
    expect(created.line).toMatch(/^created and commented #\d+ \S+: create change P1 .*; then a comment that the write is unverified, the ticket left open \(/);
    const issue = gh.issues.get(Number(created.external_id))!;
    expect(issue.state).toBe("open");
    expect(issue.body).toContain(`- action ${o.action.action_id}: rollback_file unverified, started `);
    expect(issue.comments).toEqual([[
      `Action ${o.action.action_id} (rollback_file) completed its write: after ${hex(APPROVED_APP).slice(0, 12)}, the approved copy at vault commit ${w.commits["run-nginx-7f1c-1020"].slice(0, 8)}. It is unverified: written and reloaded; no probe of app.example.invalid ran (the account holds no record of these names).`,
      "", "The ticket stays open until a pass whose runs cover the setting raises no finding on it, which closes it with that fact.", ...ledger,
    ].join("\n")]);
    expect(rows.rows.find((t) => t.ticket_id === id)).toMatchObject({ type: "change", status: "open", action_id: o.action.action_id });

    // the next cycle: a host run with app.conf as the rollback left it (the approved bytes, run 1020's rows), the rest as run 1023
    const RUN2 = "run-nginx-7f1c-1025";
    const at = "2026-10-25T02:01:00.000Z";
    const obs = w.bundle.observation.filter((x) => (x.run_id === "run-nginx-7f1c-1023" && x.object_id !== APP) || (x.run_id === "run-nginx-7f1c-1020" && x.object_id === APP))
      .map((x) => ({ ...x, obs_id: obsId(RUN2, x.object_id, x.setting_path), run_id: RUN2, observed_at: at }));
    const prev = w.bundle.collection_run.find((r) => r.run_id === "run-nginx-7f1c-1023")!;
    w.engine.insertRows("collection_run", [{ ...prev, run_id: RUN2, started_at: at, finished_at: "2026-10-25T02:01:02.000Z", status: "complete" as const }]);
    w.engine.insertRows("observation", obs);
    w.engine.insertRows("ticket", rows.rows);
    const next = await runPass(w.layer, { world: new DriftWorld("test_actions_tickets"), ledger: new MemoryLedger(w.engine), at: "2026-10-25T03:00:00.000Z", decidedAt: "2026-10-25T03:00:00.000Z" });
    expect(next.findings.filter((f) => f.id === d.finding_id)).toEqual([]);
    const rows2 = new MemoryTicketRows(rows.rows);
    const two = await step(next, rows2, "2026-10-25T03:05:00.000Z");
    const close = two.ops.find((x): x is Extract<TicketOp, { op: "close" }> => x.op === "close" && x.ticket.ticket_id === id)!;
    expect(close.reason).toMatch(new RegExp(`^finding ${d.finding_id} is resolved in the pass over .*${RUN2}.*; action ${o.action.action_id}'s write stands, unverified$`));
    expect(two.outcomes.find((x) => x.ticket_id === id)!.status).toBe("closed");
    expect(issue.state).toBe("closed");
    expect(issue.comments).toHaveLength(2);
    expect(issue.comments[1]).toMatch(new RegExp(`^Resolved: the pass over run\\(s\\) .*${RUN2}.* raises no finding on this setting, so it holds its approved value; action ${o.action.action_id} \\(rollback_file\\) wrote it and ended unverified, and its write stands; its last disposition is ROLLBACK ${d.disposition_id}, decided ${d.decided_at}; closing\\.\\n`));
    expect(issue.comments[1]).toContain(`\n- action ${o.action.action_id}: rollback_file unverified, `);
    expect(issue.comments[1].endsWith(ledger.join("\n"))).toBe(true);
    expect(rows2.rows.find((t) => t.ticket_id === id)!.status).toBe("closed");
  });

  it("approved but missing: the deleted blog.conf is written from the copy and probed; on a refusal the file it created is removed again", async () => {
    const d = of(w, "ROLLBACK", BLOG);
    const done = pick(await run(w, { only: ["rollback_file"] }), d, "rollback_file");
    expect([done.action.status, done.action.before_hash, done.action.after_hash]).toEqual(["done", null, `sha256:${hex(APPROVED_BLOG)}`]);
    expect(w.host.files.get(BLOG)!.toString("utf8")).toBe(APPROVED_BLOG);
    expect(w.probes).toContainEqual({ names: ["blog.example.invalid"], kinds: ["http", "tls"] });
    const v = await buildWorld(base);
    try {
      v.host.opts.nginxT = "refuse";
      const o = pick(await run(v, { only: ["rollback_file"] }), of(v, "ROLLBACK", BLOG), "rollback_file");
      expect(o.action.status).toBe("failed");
      expect(o.reason).toContain("the previous state was restored (the file removed), the file is absent again");
      expect(v.host.files.has(BLOG)).toBe(false);
      expect(v.host.scripts.some((s) => s.script.includes("P='/etc/nginx/conf.d/blog.conf'") && s.script.includes(`put_previous() { sudo -n rm -f -- "$P"; }`))).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("revert_record done: PATCH with the copy's fields, the record read back equal field by field, one dns probe with the TTL caveat", async () => {
    const d = of(w, "ROLLBACK", "rec-c3", "content");
    const o = pick(await run(w, { only: ["revert_record"] }), d, "revert_record");
    expect(o.action).toMatchObject({ kind: "revert_record", status: "done", vault_commit: w.commits["run-dns-1020"], before_hash: d.value_hash, after_hash: policyBundle.approved_setting.find((a) => a.object_id === "rec-c3")!.value_hash });
    expect(w.cf.log.filter((l) => l.method !== "GET")).toEqual([{ method: "PATCH", path: `/zones/${ZONE_ID}/dns_records/rec-c3`, body: { type: "A", name: "mail.example.invalid", content: "198.51.100.12", ttl: 3600, proxied: false } }]);
    expect(w.cf.records.get(ZONE_ID)!.find((r) => r.id === "rec-c3")!.content).toBe("198.51.100.12");
    expect(w.probes).toEqual([{ names: ["mail.example.invalid"], kinds: ["dns"] }]);
    expect(o.action.verification.split(",")).toHaveLength(1);
    expect(o.record.at(-1)).toMatch(/^probe probe-[0-9a-f]{16}: dns mail\.example\.invalid ok \(status 200\); resolvers answer from cache until the TTL \(3600 s\) passes, so the API read above decides the status$/);
    expect(o.reason).toBe(`reverted to the approved copy at vault commit ${w.commits["run-dns-1020"].slice(0, 8)}; the record read back equals the copy field by field`);
  });

  it("revert_record unverified: the PATCH answered and the read back equals the copy, and no dns probe ran: an empty population, an unreadable one", async () => {
    const d = of(w, "ROLLBACK", "rec-c3", "content");
    const o = pick(await run(w, { only: ["revert_record"] }, { probe: noRecords(w) }), d, "revert_record");
    const written = `reverted to the approved copy at vault commit ${w.commits["run-dns-1020"].slice(0, 8)}; the record read back equals the copy field by field`;
    expect(o.action).toMatchObject({ status: "unverified", before_hash: d.value_hash, after_hash: policyBundle.approved_setting.find((a) => a.object_id === "rec-c3")!.value_hash, verification: "" });
    expect(o.reason).toBe(`${written}; no dns probe of mail.example.invalid ran (the account holds no A, AAAA or CNAME record of this name)`);
    expect(w.cf.records.get(ZONE_ID)!.find((r) => r.id === "rec-c3")!.content).toBe("198.51.100.12");
    const v = await buildWorld(base);
    try {
      const probe: ProbeFn = async () => { throw new Error("Cloudflare 400 GET /zones: 6003: Invalid request headers"); };
      const u = pick(await run(v, { only: ["revert_record"] }, { probe }), of(v, "ROLLBACK", "rec-c3", "content"), "revert_record");
      expect([u.action.status, u.reason]).toEqual(["unverified", `${written}; the dns probe of mail.example.invalid did not run: Cloudflare 400 GET /zones: 6003: Invalid request headers`]);
    } finally {
      v.cleanup();
    }
  });

  it("revert_record: a record changed since the run is refused; a refused write is failed with Cloudflare's status", async () => {
    const d = of(w, "ROLLBACK", "rec-c3", "content");
    w.cf.records.get(ZONE_ID)!.find((r) => r.id === "rec-c3")!.content = "198.51.100.13";
    const changed = pick(await run(w, { only: ["revert_record"] }), d, "revert_record");
    expect(changed.action.status).toBe("refused");
    expect(changed.reason).toMatch(/^the record's content is [0-9a-f]{12} now and run run-dns-1023 recorded b2e7a764f9c0: it changed since the decision, and nothing was written$/);
    const v = await buildWorld(base, { cf: { failWrites: true } });
    try {
      const o = pick(await run(v, { only: ["revert_record"] }), of(v, "ROLLBACK", "rec-c3", "content"), "revert_record");
      expect([o.action.status, o.reason]).toEqual(["failed", "PATCH of record rec-c3 failed: Cloudflare 403 PATCH /zones/zone-0001/dns_records/rec-c3: 10000: Authentication error"]);
    } finally {
      v.cleanup();
    }
  });

  it("approved but missing: a deleted record is created from the copy with POST, its approvals carried to the new id, so the next cycle raises nothing on either id", async () => {
    const v = await buildWorld(base, { drop: ["rec-c3"], cf: { nextId: "rec-c3-new" } });
    try {
      const src = of(v, "ROLLBACK", "rec-c3", "content");
      const missing: Disposition = { ...src, run_id: "run-dns-1024", value_hash: "", disposition_id: dispositionId(TENANT, src.surface, null, "rec-c3", "content", "", src.finding_id, "run-dns-1024", src.decided_at) };
      v.engine.insertRows("disposition", [missing]);
      const res = await run(v, { only: ["revert_record"], runIds: ["run-dns-1024"] });
      const o = pick(res, missing, "revert_record");
      expect([o.action.status, o.action.before_hash, o.reason]).toEqual(["done", null, `re-created to the approved copy at vault commit ${v.commits["run-dns-1020"].slice(0, 8)}; the record read back equals the copy field by field`]);
      expect(v.cf.log.filter((l) => l.method !== "GET")).toEqual([{ method: "POST", path: `/zones/${ZONE_ID}/dns_records`, body: { type: "A", name: "mail.example.invalid", content: "198.51.100.12", ttl: 3600, proxied: false } }]);
      expect(o.record).toContain("before: record rec-c3 absent from zone example.invalid; POST created record rec-c3-new");

      // the approvals carried at the action's finish: rec-c3's content approval to rec-c3-new, and rec-c3's absence approved
      const approval = policyBundle.approved_setting.find((a) => a.object_id === "rec-c3")!;
      const carried = objects(await v.layer.run("SELECT approval_id, object_id, setting_path, value_hash, approved_at, approved_by, note FROM {{t:approved_setting}} WHERE object_id IN ('rec-c3', 'rec-c3-new') AND approval_id <> {{p:old}} ORDER BY object_id, approval_id", { old: approval.approval_id }));
      expect(carried.map((r) => [r.object_id, r.setting_path, r.value_hash, r.approved_at, r.approved_by, r.note])).toEqual([
        ["rec-c3", "content", "", "2026-10-23T03:04:00.000Z", approval.approved_by, `carried to rec-c3-new by action ${o.action.action_id}`],
        ["rec-c3-new", "content", approval.value_hash, "2026-10-23T03:04:00.000Z", approval.approved_by, `carried from rec-c3 by action ${o.action.action_id}`],
      ]);
      expect(o.record).toContain("2 approvals written: 1 of record rec-c3 carried to record rec-c3-new, and the absence of rec-c3 approved");
      for (const r of carried) expect(o.record.some((l) => l.startsWith(`approval ${r.approval_id}: content `) && l.endsWith(r.note))).toBe(true);
      // the row carries the reason and the record
      const row = (await actions(v)).find((a) => a.action_id === o.action.action_id)!;
      expect([row.reason, row.record]).toEqual([o.reason, o.record.join("\n")]);

      // the next cycle: a DNS run of the zone as it stands, rec-c3-new in place of rec-c3
      const at = "2026-10-25T02:05:00.000Z";
      const live = v.cf.records.get(ZONE_ID)!;
      const records = live.map((r) => dnsRecordRow(v.redactor, r, ZONE, { tenantId: TENANT, runId: "run-dns-1025", observedAt: at })!);
      v.engine.insertRows("collection_run", [{ run_id: "run-dns-1025", tenant_id: TENANT, surface: "cloudflare.dns", host: null, started_at: at, finished_at: at, expected_count: records.length, observed_count: records.length, status: "complete" }]);
      v.engine.insertRows("dns_record", records);
      v.engine.insertRows("observation", live.flatMap((r, i) => dnsObservationRows(v.redactor, r, records[i])));
      const ids = (rows: Record<string, string>[]): string[] => rows.map((r) => r.object_id).filter((id) => id === "rec-c3" || id === "rec-c3-new");
      expect(ids(objects(await approvedMissing(v.layer, { tenant_id: TENANT, surface: "cloudflare.dns", host: "", run_id: "run-dns-1025" })))).toEqual([]);
      expect(ids(objects(await driftVsApproved(v.layer, { tenant_id: TENANT, run_id: "run-dns-1025" })))).toEqual([]);
      const next = await runPass(v.layer, { world: new DriftWorld("test_actions_next"), decidedAt: "2026-10-25T03:00:00.000Z" });
      expect(next.findings.filter((f) => f.finding.object_id === "rec-c3" || f.finding.object_id === "rec-c3-new")).toEqual([]);
    } finally {
      v.cleanup();
    }
  });

  it("approved but missing: a record whose name, type and content another record of the zone carries is refused; the record the run held, gone from the zone since, is refused as changed", async () => {
    const v = await buildWorld(base, { drop: ["rec-c3"] });
    try {
      v.cf.records.get(ZONE_ID)!.push({ id: "rec-c3-twin", name: "mail.example.invalid", type: "A", content: "198.51.100.12", ttl: 300, proxied: false });
      const src = of(v, "ROLLBACK", "rec-c3", "content");
      const missing: Disposition = { ...src, run_id: "run-dns-1024", value_hash: "", disposition_id: dispositionId(TENANT, src.surface, null, "rec-c3", "content", "", src.finding_id, "run-dns-1024", src.decided_at) };
      v.engine.insertRows("disposition", [missing]);
      const twin = pick(await run(v, { only: ["revert_record"], runIds: ["run-dns-1024"] }), missing, "revert_record");
      expect([twin.action.status, twin.reason]).toEqual(["refused", "record rec-c3 is absent and record rec-c3-twin carries the same name, type and content; the approval names rec-c3, so the record is re-approved under rec-c3-twin (npm run approve -- --record rec-c3-twin)"]);
      expect(v.cf.log.filter((l) => l.method === "POST")).toHaveLength(0);
      const gone = pick(await run(v, { only: ["revert_record"], runIds: ["run-dns-1023"] }), src, "revert_record");
      expect([gone.action.status, gone.reason]).toEqual(["refused", "record rec-c3 was in run run-dns-1023 and is absent from the zone now: it changed since the decision, and nothing was written"]);
    } finally {
      v.cleanup();
    }
  });

  it("investigate done: Lightning's gated selection runs as checks tied to query ids, Ultra's verdict counts, receipts filled; then the fix is refused", async () => {
    const d = of(w, "FIX", SHOP);
    const res = await run(w, { only: ["investigate"] });
    const inv = pick(res, d, "investigate");
    const fix = pick(res, d, "fix");
    expect(res.outcomes.map((o) => o.action.kind)).toEqual(["investigate", "fix"]);
    expect(inv.action.status).toBe("done");
    expect(inv.action.receipts).toBe("rcpt_test_1,rcpt_test_2");
    expect(inv.reason).toBe("investigated: 2 checks ran (1 hold, 1 fail); the judge's verdict counted: stands");
    expect(inv.record.filter((l) => l.startsWith("check "))).toEqual([
      expect.stringMatching(/^check run_complete \(query [0-9a-f-]{36}\): holds, /),
      expect.stringMatching(/^check setting_matches_approved \(query [0-9a-f-]{36}\): fails, /),
    ]);
    expect(inv.record).toContainEqual(expect.stringMatching(/^Lightning selection \(receipt rcpt_test_1, nvidia\/nemotron-3\.5-lightning-30b-a3b, cache miss, route \S+\): 2 valid checks, 1 rejected: run_complete, setting_matches_approved$/));
    expect(inv.record).toContainEqual(expect.stringMatching(/^judge stands \(receipt rcpt_test_2, .*ultra.*, cache miss, route \S+\): the refuting SELECT returned no rows, 0 rows$/));
    expect(inv.record).toContainEqual(expect.stringMatching(/^probe probe-[0-9a-f]{16}: http shop\.example\.invalid fail \(status 502 server=nginx cf-ray absent\)$/));
    expect(inv.action.verification.split(",")).toHaveLength(3);
    expect([fix.action.status, fix.reason, fix.action.receipts]).toEqual(["refused", FIX_REFUSED, ""]);
    expect(w.model.calls.map((c) => [c.appId, c.agent])).toEqual([[tenantAppId(TENANT), "actor"], [tenantAppId(TENANT), "judge"]]);
    expect(w.model.calls[0].messages.at(-1)!.content).toMatch(/^\[request [0-9a-f]{16}\]\nFinding \(redacted\):/);
    expect(w.host.scripts).toEqual([]);
  });

  it("investigate not_judged: a substituted judge receipt is refused by the gate, the reason kept and the receipts recorded", async () => {
    const model = new FakeModel({ ultraServedBy: "lightning" });
    const d = of(w, "FIX", SHOP);
    const res = await run(w, { only: ["investigate"] }, { model, receipts: model.receipts });
    const inv = pick(res, d, "investigate");
    expect(inv.action.status).toBe("not_judged");
    expect(inv.reason).toBe("receipt gate: receipt rcpt_test_2 nvidia/nemotron-3.5-lightning-30b-a3b (lightning), ultra was requested");
    expect(inv.action.receipts).toBe("rcpt_test_1,rcpt_test_2");
    expect(pick(res, d, "fix").action.status).toBe("refused");
  });

  it("acts once per disposition and kind: a second run over the same dispositions writes nothing, and its dry run plans nothing", async () => {
    const first = await run(w);
    expect(first.outcomes.map((o) => o.action.kind).sort()).toEqual(["fix", "investigate", "revert_record", "rollback_file", "rollback_file"]);
    expect(first.written).toBe(5);
    const sessions = w.host.scripts.length;
    const again = await run(w);
    expect([again.outcomes.length, again.acted.length, again.written]).toEqual([0, 5, 0]);
    const dry = await run(w, { apply: false });
    expect(dry.plan).toEqual([]);
    expect(actLines(TENANT, dry, w.redactor)).toContain("act: the plan is empty: no disposition in scope calls for an action (ROLLBACK, FIX, or ESCALATE under an on_drift investigate rule), beyond the 5 actions already recorded");
    expect((await actions(w)).length).toBe(5);
    expect(w.host.scripts).toHaveLength(sessions);
    expect(w.model.calls).toHaveLength(2);
  });

  it("an apply without an action table is refused before anything runs", async () => {
    await expect(run(w, {}, { sink: null })).rejects.toThrow(/needs the action table/);
    expect(w.host.scripts).toEqual([]);
  });
});

describe("ACTIONS_SQL", () => {
  it("returns the tenant's action rows, every column, in action_id order", async () => {
    const engine = await SqlJsEngine.create();
    try {
      const row = (id: string, tenant: string, kind: Action["kind"], status: Action["status"]): Action => ({
        action_id: id, tenant_id: tenant, kind, target: "linux.nginx host-7f1c /etc/nginx/conf.d/app.conf file", before_hash: kind === "fix" ? null : `sha256:${"a".repeat(64)}`,
        after_hash: null, vault_commit: null, verification: "", receipts: "", status, reason: `${kind} ${status}`, record: "", started_at: "2026-10-23T03:04:00.000Z", finished_at: "2026-10-23T03:04:01.000Z", disposition_id: "disp-0000000000000001",
      });
      engine.insertRows("action", [row("act-b", TENANT, "fix", "refused"), row("act-a", TENANT, "rollback_file", "failed"), row("act-c", "client-b", "investigate", "not_judged")]);
      const r = await new DataLayer(engine).run(ACTIONS_SQL, { tenant_id: TENANT });
      expect(r.columns).toEqual(["action_id", "tenant_id", "kind", "target", "before_hash", "after_hash", "vault_commit", "verification", "receipts", "status", "reason", "record", "started_at", "finished_at", "disposition_id"]);
      expect(r.rows.map((x) => [x[0], x[2], x[4], x[9], x[10]])).toEqual([["act-a", "rollback_file", `sha256:${"a".repeat(64)}`, "failed", "rollback_file failed"], ["act-b", "fix", "", "refused", "fix refused"]]);
    } finally {
      engine.close();
    }
  });
});

const url = process.env.DATABASE_URL;
if (!url) console.log("actions: live Postgres half skipped (set DATABASE_URL in .env to run it)");

describe.skipIf(!url)("Store.actionsOf against a throwaway schema", () => {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  let store: Store | undefined;
  const admin = async (sql: string): Promise<void> => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
  };
  afterAll(async () => {
    await store?.close();
    await admin(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });

  it("reads the actions of the given dispositions, in action_id order, and none for an empty list", async () => {
    await admin(`CREATE SCHEMA ${schema}`);
    store = Store.fromEnv({ schema });
    await store.applySchema();
    const a = (id: string, disp: string): Action => ({
      action_id: id, tenant_id: TENANT, kind: "investigate", target: "cloudflare.dns rec-c3 content", before_hash: null, after_hash: null, vault_commit: null,
      verification: "", receipts: "rcpt_test_1", status: "not_judged", reason: "no model is configured, so no verdict was asked for",
      record: "judge not called: no model is configured\nno passing probe run within six hours of run run-dns-1023; production is unknown from the probes",
      started_at: "2026-10-23T03:04:00.000Z", finished_at: "2026-10-23T03:04:02.000Z", disposition_id: disp,
    });
    expect(await store.insertActions([a("act-2", "disp-x"), a("act-1", "disp-x"), a("act-3", "disp-y")])).toBe(3);
    expect(await store.insertActions([a("act-1", "disp-x")])).toBe(0);
    expect((await store.actionsOf(["disp-x"])).map((x) => x.action_id)).toEqual(["act-1", "act-2"]);
    expect((await store.actionsOf(["disp-y", "disp-x", "disp-y"])).map((x) => x.action_id)).toEqual(["act-1", "act-2", "act-3"]);
    expect(await store.actionsOf([])).toEqual([]);
    expect((await store.actionsOf(["disp-x"]))[0]).toEqual(a("act-1", "disp-x"));
  });
});
