// The pass with no model, end to end, over two bundles. The hand-authored fixture (test/fixtures/
// authored-bundle.json) tells the hero story: the gate, the World Model, the hero query, the default
// checks and the verb all come from its rows, and the same pass over a copy whose DNS record still points
// at an inventory host must produce no hero finding, which is what makes the first result a measurement
// and not a planted answer. The recorded bundle (test/fixtures/recorded-bundle.json, the export of the 07:58 UTC collection of 24 Oct 2026: the real estate redacted) exercises
// the survey: 27 findings in four classes, each one checked against a copy where the cause is removed, and
// the 11 files the hosts' newest backups lack. The policy fixture (test/fixtures/policy-bundle.json, the
// authored rows plus the hackathon policy, approvals, vault copies, validations, a probe run, an approved file
// the latest run lacks and two HOLDs of an earlier pass) exercises the Decider through the DataLayer: every verb
// the design's table reaches, its reason and expiry, approved_missing, the HOLD kept and the HOLD expired, and the
// ledger rows read back through SQL. The MemTracer builds events as the real Tracer writes them (redacted,
// model: none), so the exact-text assertions also show the bundles' vocabulary survives.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BLOG, BLOG_HASH, FIXTURE as POLICY_FIXTURE, HOLD_EXPIRED, HOLD_IN_FORCE, policyBundleText } from "../scripts/fixtures/policy-bundle.ts";
import { decisionInstant } from "../src/data/instant.ts";
import { holdUntil } from "../src/policy/decide.ts";
import { DataLayer, DataLayerError, type Params, type RunOptions } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import {
  APPROVED_COPIES_SQL, APPROVED_MISSING_SQL, DISPOSITIONS_SQL, FOUND_BUT_DIFFERENT_SQL, LATEST_APPROVALS_SQL, POLICY_RULES_SQL, PRIOR_HOLDS_SQL, PROBES_OF_RUN_SQL, objects,
} from "../src/data/queries.ts";
import { dispositionId, type PolicyRule } from "../src/data/rows.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { DEFAULT_POLICY_DETAIL, runPass, shortFindingId, type Finding, type PassOptions } from "../src/pipeline.ts";
import { loadPolicyFile } from "../src/policy/load.ts";
import { Redactor } from "../src/redactor.ts";
import type { TraceEvent } from "../src/trace.ts";
import authored from "./fixtures/authored-bundle.json" with { type: "json" };
import policyBundle from "./fixtures/policy-bundle.json" with { type: "json" };
import recorded from "./fixtures/recorded-bundle.json" with { type: "json" };
import { MemTracer } from "./fixtures/mem-tracer.ts";
import { APEX_NAME, APEX_RECORD, DNS_RUN, CONFD_HOST, CONFD_RUN, SITES_HOST, SITES_RUN, T, WWW_NAME, WWW_RECORD } from "./fixtures/catalogue-params.ts";

type A = typeof authored;
type R = typeof recorded;

async function pass(b: Readonly<Record<string, unknown>>, layerOf: (e: SqlJsEngine) => DataLayer = (e) => new DataLayer(e)) {
  const engine = await SqlJsEngine.create();
  engine.loadBundle(b);
  const tracer = new MemTracer("test_pipeline", { model: "none" });
  const result = await runPass(layerOf(engine), { tracer, world: new DriftWorld("test_pipeline") });
  return { result, tracer };
}

const hero = (fs: Finding[]) => fs.filter((f) => f.finding.class === "found_but_different" || f.finding.class === "dns_change");
const ofClass = (fs: Finding[], c: string) => fs.filter((f) => f.finding.class === c);

/** The negative control: today's A record back on the inventory host, so the hero query has nothing to find. */
function negativeControl(): A {
  const b = structuredClone(authored);
  const rec = b.dns_record.find((d) => d.record_id === "rec-a1" && d.run_id === "run-dns-1023");
  expect(rec).toBeDefined();
  rec!.content = "198.51.100.10";
  return b;
}

const heroQueries = (ev: TraceEvent[]) => ev.filter((e) => e.action === "query" && e.input_summary?.startsWith("SELECT o.host, o.object_id, o.setting_path, o.refers_to_id AS upstream_name"));
const okQueries = (ev: TraceEvent[]) => ev.filter((e) => e.action === "query" && e.status === "ok");

describe("pass over the authored fixture, model: none", () => {
  it("gates the partial run out, records the rest, finds the one FOUND-BUT-DIFFERENT and escalates it", async () => {
    const { result } = await pass(authored);
    expect(result.runs).toBe(12);
    expect(result.gatedOut).toEqual(["run-nginx-2b9e-1023"]);
    expect(result.observed).toBe(10);
    expect(hero(result.findings)).toHaveLength(1);
    const f = hero(result.findings)[0];
    expect(f.finding).toMatchObject({
      class: "found_but_different", tenant_id: "client-a", run_id: "run-nginx-7f1c-1023", surface: "linux.nginx", host: "host-7f1c",
      object_id: "/etc/nginx/conf.d/app.conf", setting_path: "server.location./.proxy_pass",
      value_hash: "sha256:53ab0295bec8f85ade87d17cd058cea1ecfbcace2956e8ff3810b33a9b48343b", value_redacted: "http://app.example.invalid:8080",
      refers_to_type: "dns_name", refers_to_id: "app.example.invalid", dns_name: "app.example.invalid", resolves_to: "203.0.113.77",
      resource_id: "rec-a1", dns_run_id: "run-dns-1023", since: "2026-10-20T02:01:01.000Z", until: "2026-10-23T02:05:00.000Z",
    });
    expect(f.finding.summary).toContain("198.51.100.10 then and to 203.0.113.77 now");
    expect(f.world).toEqual({ before: "198.51.100.10", after: "203.0.113.77", changed: true, bytes_unchanged: true });
    expect(f.checks.map((c) => [c.template, c.holds, c.rowCount])).toEqual([
      ["run_complete", true, 0],
      ["dns_target_in_inventory", false, 1],
      ["actor_attributed", true, 1],
      ["other_settings_reference", true, 0],
    ]);
    expect(f.checks[1].explanation).toBe("app.example.invalid resolves to 1 address the inventory does not know.");
    expect(f.rejected).toEqual([]);
    expect(f.verb).toBe("ESCALATE");
    expect(f.judge).toBe("skipped");
  });

  it("the survey reads the fixture too: its www CNAME is proxied while the apex A record it aliases is direct, a proxy_split with no audit trail, escalated", async () => {
    const { result } = await pass(authored);
    expect(result.findings.map((f) => f.finding.class)).toEqual(["found_but_different", "proxy_split"]);
    const s = ofClass(result.findings, "proxy_split")[0];
    expect(s.finding).toMatchObject({ run_id: "run-dns-1023", surface: "cloudflare.dns", host: null, object_id: "rec-b2", setting_path: "proxied", dns_name: "www.example.invalid", refers_to_id: "app.example.invalid", resolves_to: "203.0.113.77", resource_id: "rec-b2", since: "2026-10-22T15:28:00.000Z", until: "2026-10-23T02:05:00.000Z" });
    expect(s.world).toBeUndefined();
    expect(s.checks.map((c) => [c.template, c.holds])).toEqual([["run_complete", true], ["actor_attributed", false], ["previous_value_recoverable", false], ["referent_unchanged", true]]);
    expect(s.verb).toBe("ESCALATE");
    // un-proxy the www record and the split is gone
    const b = structuredClone(authored);
    for (const d of b.dns_record) if (d.record_id === "rec-b2") d.proxied = 0;
    expect((await pass(b)).result.findings.map((f) => f.finding.class)).toEqual(["found_but_different"]);
  });

  it("traces every step with model: none on every line, not_checked for the gated run, one check per precondition, decide, judge skipped", async () => {
    const { tracer } = await pass(authored);
    const ev = tracer.events;
    expect(ev.filter((e) => e.action === "check" && e.status === "not_checked").map((e) => e.input_summary)).toEqual(["run_complete run-nginx-2b9e-1023"]);
    expect(ev.filter((e) => e.action === "detect" && e.status === "not_checked").map((e) => e.input_summary)).toEqual(["linux.nginx host-2b9e"]);
    expect(ev.filter((e) => e.action === "observe")).toHaveLength(5);
    expect(ev.filter((e) => e.agent === "checker" && e.action === "check").map((e) => e.status)).toEqual(["ok", "failed", "ok", "ok", "ok", "failed", "failed", "ok"]);
    const decide = ev.filter((e) => e.action === "decide");
    expect(decide.map((e) => e.output_summary)).toEqual([
      "ESCALATE: 1 of 4 preconditions fail: dns_target_in_inventory",
      "ESCALATE: 2 of 4 preconditions fail: actor_attributed, previous_value_recoverable",
    ]);
    expect(decide[0].detail).toMatch(/^model: none/);
    expect(ev.filter((e) => e.action === "judge")).toEqual([expect.objectContaining({ status: "skipped", detail: "model: none (sample)" }), expect.objectContaining({ status: "skipped" })]);
    expect(ev.every((e) => e.model_requested === "none")).toBe(true);
    expect(ev.some((e) => e.model_routed !== undefined || e.receipt_id !== undefined)).toBe(false);
    // the redactor leaves the bundle's vocabulary alone: surfaces, the setting path, the SQL text
    expect(ev.find((e) => e.action === "detect" && e.status === "ok" && e.input_summary?.startsWith("server."))?.input_summary).toBe("server.location./.proxy_pass in /etc/nginx/conf.d/app.conf on host-7f1c");
    expect(heroQueries(ev)).toHaveLength(2);
    // 1 runs + 12 gate + 5 observations + 5 resolutions + 2 hero (two host groups pass the gate) + 4 hero checks
    // + survey: 1 audit span + 1 proxy_split + 4 per nginx host group whose latest run passed (host-7f1c) + 4 proxy_split checks
    // + exposure: 2 SELECTs for each of the two findings that rest on a record (rec-a1, rec-b2): the record's row in the DNS run and
    //   the first event of its state; the authored log carries plain old and new values, so no earlier-body count is needed
    // + the Decider's policy read (one tenant) + drift_vs_approved over the three latest passing runs (linux.etc and linux.nginx on
    //   host-7f1c, the DNS run) + changed_since_backup over the nginx one: 0 rows each (the approvals hold the live values, no `file` row)
    // + approved_missing over the same three runs: 0 rows each (every approved object is in its run); no prior-HOLD read (no rule)
    expect(okQueries(ev)).toHaveLength(1 + 12 + 5 + 5 + 2 + 4 + 1 + 1 + 4 + 4 + 2 * 2 + 1 + 3 + 1 + 3);
    expect(ev.filter((e) => e.action === "query" && e.status === "failed")).toEqual([]);
  });

  it("finds no hero finding when the record still points at an inventory host: the result comes from the rows", async () => {
    const { result, tracer } = await pass(negativeControl());
    expect(hero(result.findings)).toEqual([]);
    // the survey still reads the fixture: the split, and now two records (the A, and the CNAME through it) land on host-7f1c, whose
    // authored vhost rows carry no server_name[<name>] referent, so no enabled block names them
    expect(result.findings.map((f) => [f.finding.class, f.finding.dns_name])).toEqual([["proxy_split", "www.example.invalid"], ["orphan_record", "app.example.invalid"], ["orphan_record", "www.example.invalid"]]);
    expect(result.gatedOut).toEqual(["run-nginx-2b9e-1023"]);
    expect(result.observed).toBe(10);
    expect(tracer.events.filter((e) => e.action === "decide").map((e) => e.input_summary)[0]).toBe("proxy_split proxied in rec-b2");
  });

  it("a TXT record on the name is not an address: the negative control plus a DMARC TXT (';' and all) in both DNS runs still finds no hero finding", async () => {
    const b = negativeControl();
    for (const run of ["run-dns-1020", "run-dns-1023"]) {
      b.dns_record.push({ record_id: "rec-txt", run_id: run, tenant_id: "client-a", zone: "example.invalid", name: "app.example.invalid", type: "TXT", content: "v=DMARC1; p=reject", ttl: 3600, proxied: 0, observed_at: run === "run-dns-1020" ? "2026-10-20T02:05:00.000Z" : "2026-10-23T02:05:00.000Z" });
    }
    const { result, tracer } = await pass(b);
    expect(hero(result.findings)).toEqual([]);
    expect(result.observed).toBe(10);
    expect(tracer.events.filter((e) => e.action === "query" && e.status === "failed")).toEqual([]);
  });

  it("a CNAME on the vhost's name is not an address either: the chain is not followed, so no hero finding", async () => {
    const b = structuredClone(authored);
    for (const o of b.observation) if (o.refers_to_id === "app.example.invalid") o.refers_to_id = "www.example.invalid";
    const { result } = await pass(b);
    expect(hero(result.findings)).toEqual([]);
  });

  it("classes a hero row as dns_change when the setting has no previous passing run, and still escalates", async () => {
    const b = structuredClone(authored);
    b.collection_run = b.collection_run.filter((r) => r.run_id !== "run-nginx-7f1c-1020");
    b.observation = b.observation.filter((o) => o.run_id !== "run-nginx-7f1c-1020");
    const { result } = await pass(b);
    expect(hero(result.findings).map((f) => f.finding.class)).toEqual(["dns_change"]);
    const f = hero(result.findings)[0];
    expect(f.world).toEqual({ before: null, after: "203.0.113.77", changed: false, bytes_unchanged: false });
    expect(f.finding.since).toBe("2026-10-23T02:01:00.000Z");
    expect(f.checks.map((c) => c.template)).toEqual(["run_complete", "host_in_inventory", "actor_attributed", "previous_value_recoverable"]);
    expect(f.checks.find((c) => c.template === "host_in_inventory")?.holds).toBe(false);
    expect(f.verb).toBe("ESCALATE");
  });

  it("today's DNS run failing the gate pairs with nothing: no stale DNS run stands in, both host groups are not_checked, zero hero queries, no host survey", async () => {
    const b = structuredClone(authored);
    const dns = b.collection_run.find((r) => r.run_id === "run-dns-1023")!;
    dns.status = "partial";
    dns.observed_count = 2;
    const { result, tracer } = await pass(b);
    expect(result.gatedOut).toEqual(["run-nginx-2b9e-1023", "run-dns-1023"]);
    expect(hero(result.findings)).toEqual([]);
    expect(result.observed).toBe(10);
    const detect = tracer.events.filter((e) => e.action === "detect" && e.status === "not_checked");
    expect(detect.map((e) => e.input_summary)).toEqual(["linux.etc host-7f1c", "linux.nginx host-7f1c", "linux.nginx host-2b9e"]);
    expect(detect.filter((e) => /no DNS run of this pass passed the gate \(run-dns-1023 failed\)/.test(e.output_summary ?? "")).map((e) => e.input_summary))
      .toEqual(["linux.etc host-7f1c", "linux.nginx host-7f1c"]);
    expect(heroQueries(tracer.events)).toEqual([]);
    // the survey falls back to the 20 Oct DNS run, which passed: the same proxy_split, three days older
    expect(result.findings.map((f) => [f.finding.class, f.finding.dns_run_id])).toEqual([["proxy_split", "run-dns-1020"]]);
    // 1 runs + 12 gate + 5 observations + 3 resolutions (the 20 Oct host runs still pair with run-dns-1020); no hero, no hero checks;
    // survey: 1 audit span + 1 proxy_split + 4 checks, and no host survey (no host run pairs with a passing DNS run);
    // exposure: 2 SELECTs for the proxy_split's record (rec-b2 in run-dns-1020);
    // the policy read, drift_vs_approved over host-7f1c's two latest runs and run-dns-1020, changed_since_backup over its nginx run,
    // approved_missing over the same three runs
    expect(okQueries(tracer.events)).toHaveLength(1 + 12 + 5 + 3 + 1 + 1 + 4 + 2 + 1 + 3 + 1 + 3);
  });

  it("a name with an A and an AAAA record gives two findings, each carrying its own record and checked against it", async () => {
    const b = structuredClone(authored);
    b.dns_record.push({ record_id: "rec-a9", run_id: "run-dns-1023", tenant_id: "client-a", zone: "example.invalid", name: "app.example.invalid", type: "AAAA", content: "2001:db8::77", ttl: 300, proxied: 0, observed_at: "2026-10-23T02:05:00.000Z" });
    b.audit_event.push({ event_id: "evt-cf-0002", tenant_id: "client-a", source: "cloudflare", actor: "user-3c7d", action: "rec_add", resource_type: "dns_record", resource_id: "rec-a9", old_value: "", new_value: "2001:db8::77", occurred_at: "2026-10-22T18:50:00.000Z" });
    const { result, tracer } = await pass(b);
    expect(hero(result.findings).map((f) => [f.finding.resolves_to, f.finding.resource_id, f.finding.class])).toEqual([
      ["203.0.113.77", "rec-a1", "found_but_different"],
      ["2001:db8::77", "rec-a9", "found_but_different"],
    ]);
    expect(hero(result.findings)[1].world).toEqual({ before: "198.51.100.10", after: "2001:db8::77,203.0.113.77", changed: true, bytes_unchanged: true });
    const aaaa = hero(result.findings)[1].checks.find((c) => c.template === "actor_attributed")!;
    expect(aaaa.holds).toBe(true);
    expect(aaaa.explanation).toContain("touched rec-a9 between");
    expect(tracer.events.filter((e) => e.agent === "checker" && e.input_summary?.startsWith("actor_attributed")).map((e) => e.input_summary).slice(0, 2)).toEqual([
      expect.stringContaining('"resource_id":"rec-a1"'),
      expect.stringContaining('"resource_id":"rec-a9"'),
    ]);
  });

  it("a check the data layer refuses is one recorded rejection: that finding escalates and the pass goes on", async () => {
    class RefusingLayer extends DataLayer {
      override async run(sql: string, params: Params = {}, opts: RunOptions = {}) {
        if (opts.agent === "checker" && sql.includes("{{t:inventory_asset}}")) throw new DataLayerError("engine refused this check");
        return super.run(sql, params, opts);
      }
    }
    const { result, tracer } = await pass(authored, (e) => new RefusingLayer(e));
    expect(hero(result.findings)).toHaveLength(1);
    const f = hero(result.findings)[0];
    expect(f.checks.map((c) => c.template)).toEqual(["run_complete", "actor_attributed", "other_settings_reference"]);
    expect(f.rejected).toEqual([{ check: expect.objectContaining({ template: "dns_target_in_inventory" }), reason: "dns_target_in_inventory: engine refused this check" }]);
    expect(f.verb).toBe("ESCALATE");
    expect(tracer.events.filter((e) => e.action === "decide").map((e) => e.output_summary)[0]).toBe("ESCALATE: 1 check(s) could not be bound from the finding or were refused by the guard");
    expect(tracer.events.filter((e) => e.agent === "checker" && e.status === "not_checked").map((e) => [e.input_summary, e.detail]))
      .toEqual([["dns_target_in_inventory", "dns_target_in_inventory: engine refused this check"]]);
  });
});

describe("pass over the recorded bundle (the real estate, redacted), model: none", () => {
  it("four complete runs, nothing gated, every observation recorded, no hero finding (every served name lands on an inventory host), 27 survey findings and 11 files the newest backups lack", async () => {
    const { result } = await pass(recorded);
    expect(result.runs).toBe(4);
    expect(result.gatedOut).toEqual([]);
    expect(result.observed).toBe(recorded.observation.length);
    expect(hero(result.findings)).toEqual([]);
    expect(result.findings).toHaveLength(38);
    const byClass = new Map<string, number>();
    for (const f of result.findings) byClass.set(f.finding.class, (byClass.get(f.finding.class) ?? 0) + 1);
    expect(Object.fromEntries(byClass)).toEqual({ proxy_split: 1, proxied_without_real_ip: 20, orphan_record: 3, orphan_vhost: 3, changed_since_backup: 11 });
    expect(result.findings.every((f) => f.world === undefined && f.judge === "skipped" && f.rejected.length === 0)).toBe(true);
    expect(result.findings.map((f) => f.verb).filter((v) => v === "ADOPT")).toHaveLength(5);
    // no policy_rule row in the bundle: every disposition is the default's, and nothing a locked rule governs
    expect(result.findings.every((f) => f.disposition.decided_by === "default" && f.disposition.rule_id === null && f.disposition.expires_at === null && f.disposition.verb === f.verb)).toBe(true);
    expect(result.verbs).toEqual({ ADOPT: 5, HOLD: 0, ESCALATE: 33, ROLLBACK: 0, FIX: 0 });
    expect([result.rules, result.locked, result.ledger]).toEqual([0, 0, null]);
  });

  it("changed_since_backup: the certbot renewal configs, which each host's newest export tarball lacks; every nginx file equals its copy there", async () => {
    const { result } = await pass(recorded);
    const fs = ofClass(result.findings, "changed_since_backup");
    expect(fs.map((f) => f.finding.host)).toEqual([...Array(6).fill(CONFD_HOST), ...Array(5).fill(SITES_HOST)]);
    expect(fs.every((f) => f.finding.object_id.startsWith("/etc/letsencrypt/renewal/") && f.finding.setting_path === "file" && f.finding.value_redacted === null)).toBe(true);
    expect(fs[0].finding.summary).toMatch(new RegExp(`^/etc/letsencrypt/renewal/\\S+\\.conf on ${CONFD_HOST} is absent from the host's newest backup \\(snap-[0-9a-f]{16}, taken \\S+\\): a restore from that backup holds no copy of this file$`));
    expect(fs.every((f) => f.finding.since <= f.finding.until && f.finding.run_id === (f.finding.host === CONFD_HOST ? CONFD_RUN : SITES_RUN) && f.finding.dns_run_id === DNS_RUN)).toBe(true);
    // the backup is there (taken at the window's start), it lacks the file, and no approval names the file: ESCALATE by the default
    expect(new Set(fs.map((f) => JSON.stringify(f.checks.map((c) => [c.template, c.holds]))))).toEqual(new Set([JSON.stringify([["run_complete", true], ["backup_recent", true], ["change_in_last_backup", false], ["setting_matches_approved", false]])]));
    expect(fs.every((f) => f.verb === "ESCALATE" && f.disposition.reason === "2 of 4 preconditions fail: change_in_last_backup, setting_matches_approved")).toBe(true);
  });

  it("proxy_split: www proxied, the apex it aliases direct; attributed and recoverable from the April audit events, escalated because the name changed inside the window", async () => {
    const { result } = await pass(recorded);
    const [s] = ofClass(result.findings, "proxy_split");
    expect(s.finding).toMatchObject({
      tenant_id: T, run_id: DNS_RUN, surface: "cloudflare.dns", host: null, object_id: WWW_RECORD, setting_path: "proxied", value_redacted: "1",
      refers_to_type: "dns_name", refers_to_id: APEX_NAME, dns_name: WWW_NAME, resolves_to: "ip-6fb86d", resource_id: WWW_RECORD, dns_run_id: DNS_RUN,
      since: "2026-03-20T01:29:03.000Z", until: "2026-10-24T07:58:55.125Z",
    });
    expect(s.finding.summary).toBe(`${WWW_NAME} is proxied and aliases ${APEX_NAME}, whose A record is direct to ip-6fb86d: the origin the proxy hides is published on the name it points at`);
    expect(s.checks.map((c) => [c.template, c.holds, c.rowCount])).toEqual([
      ["run_complete", true, 0], ["actor_attributed", true, 2], ["previous_value_recoverable", true, 1], ["referent_unchanged", false, 3],
    ]);
    expect(s.verb).toBe("ESCALATE");
    const b = structuredClone(recorded) as R;
    b.dns_record.find((d) => d.record_id === APEX_RECORD)!.proxied = 1;
    expect(ofClass((await pass(b)).result.findings, "proxy_split")).toEqual([]);
  });

  it("proxied_without_real_ip: one finding per proxied record and enabled block without a list, plus the wildcard against the host's http level", async () => {
    const { result } = await pass(recorded);
    const fs = ofClass(result.findings, "proxied_without_real_ip");
    expect(fs.filter((f) => f.finding.host === CONFD_HOST)).toHaveLength(11);
    expect(fs.filter((f) => f.finding.host === SITES_HOST)).toHaveLength(9);
    const wild = fs.find((f) => f.finding.setting_path === "http.real_ip")!;
    expect(wild.finding).toMatchObject({ run_id: CONFD_RUN, surface: "linux.nginx", host: CONFD_HOST, object_id: "/etc/nginx/nginx.conf", value_redacted: "absent", dns_name: "*.host-503b27.ai", resolves_to: "ip-6b6bba", resource_id: "c922e6966d55b15bd96b5e8ea932b715" });
    expect(wild.finding.summary).toContain("no server block on host-aa516a trusts a Cloudflare range");
    expect(wild.checks.map((c) => [c.template, c.holds])).toEqual([["run_complete", true], ["host_in_inventory", true], ["actor_attributed", false], ["previous_value_recoverable", false]]);
    expect(wild.verb).toBe("ESCALATE");
    const www = fs.filter((f) => f.finding.dns_name === WWW_NAME);
    expect(www.map((f) => [f.finding.object_id, f.finding.setting_path, f.verb])).toEqual([
      ["/etc/nginx/sites-available/host-4c795e.quest", `server[${APEX_NAME}:443].real_ip`, "ADOPT"],
      ["/etc/nginx/sites-available/host-4c795e.quest", `server[${APEX_NAME}:80].real_ip`, "ADOPT"],
    ]);
    expect(www[0].finding.summary).toBe(`${WWW_NAME} is proxied through Cloudflare to ip-6fb86d, and server[${APEX_NAME}:443].real_ip in /etc/nginx/sites-available/host-4c795e.quest on ${SITES_HOST} is absent: the block that serves it sees Cloudflare's addresses as its visitors`);
    // a list at the http level of the confd host clears the wildcard finding and nothing else
    const b = structuredClone(recorded) as R;
    for (const o of b.observation) if (o.run_id === CONFD_RUN && o.setting_path === "http.real_ip") o.value_redacted = "trusted:22 header:CF-Connecting-IP scope:http";
    const again = ofClass((await pass(b)).result.findings, "proxied_without_real_ip");
    expect(again).toHaveLength(19);
    expect(again.some((f) => f.finding.setting_path === "http.real_ip")).toBe(false);
  });

  it("orphan_record: the three records that land on a host with no enabled block naming them, anchored on the record", async () => {
    const { result } = await pass(recorded);
    const fs = ofClass(result.findings, "orphan_record");
    expect(fs.map((f) => [f.finding.host, f.finding.dns_name, f.finding.resolves_to, f.finding.run_id, f.finding.surface, f.finding.setting_path, f.verb])).toEqual([
      [CONFD_HOST, "host-3fef97.club", "ip-6b6bba", DNS_RUN, "cloudflare.dns", "name", "ESCALATE"],
      [SITES_HOST, "host-50b116.com", "ip-6fb86d", DNS_RUN, "cloudflare.dns", "name", "ESCALATE"],
      [SITES_HOST, "host-c10fff.com", "ip-6fb86d", DNS_RUN, "cloudflare.dns", "name", "ESCALATE"],
    ]);
    expect(fs[0].finding.summary).toBe(`host-3fef97.club (A, direct) lands on ip-6b6bba, ${CONFD_HOST}, where no enabled server block names it: requests for it reach the default server`);
    expect(fs[0].finding.object_id).toBe(fs[0].finding.resource_id);
    expect(fs[2].checks.map((c) => [c.template, c.holds])).toEqual([["run_complete", true], ["host_in_inventory", true], ["actor_attributed", true], ["previous_value_recoverable", false]]);
  });

  it("orphan_vhost: a vhost file on disk and an enabled vhost with two names, none with a record or a covering wildcard; the one on disk alone is adoptable", async () => {
    const { result } = await pass(recorded);
    const fs = ofClass(result.findings, "orphan_vhost");
    expect(fs.map((f) => [f.finding.object_id, f.finding.dns_name, f.verb])).toEqual([
      ["/etc/nginx/sites-available/host-085e02.com", "host-085e02.com", "ADOPT"],
      ["/etc/nginx/sites-available/host-9ac4f1.com", "host-89f6e7.com", "ESCALATE"],
      ["/etc/nginx/sites-available/host-9ac4f1.com", "host-9ac4f1.com", "ESCALATE"],
    ]);
    expect(fs[0].finding.summary).toBe(`host-085e02.com is a server_name in /etc/nginx/sites-available/host-085e02.com on ${SITES_HOST} (on disk, not enabled) with no record of that name in the collected zones and no wildcard covering its zone`);
    expect(fs[0].checks.map((c) => [c.template, c.holds, c.rowCount])).toEqual([["run_complete", true, 0], ["other_settings_reference", true, 0], ["backup_recent", true, 9]]);
    // the enabled vhost's names recur in its .bak copy and the :80 block: that is the blast radius other_settings_reference reports
    expect(fs[1].checks.find((c) => c.template === "other_settings_reference")).toMatchObject({ holds: false, rowCount: 3 });
    expect(fs[1].finding.resolves_to).toBeNull();
    expect(fs[1].finding.resource_id).toBeNull();
  });

  it("a gated audit run withholds the audit log: every template that reads audit_event is a recorded rejection ('audit log incomplete') for that tenant, nothing that leaned on the log adopts, and a tenant with no audit run is treated the same", async () => {
    const b = structuredClone(recorded) as R;
    const audit = b.collection_run.find((r) => r.surface === "cloudflare.audit")!;
    audit.status = "partial";
    audit.observed_count = (audit.expected_count ?? 1) - 1;
    const full = await pass(recorded);
    const { result, tracer } = await pass(b);
    expect(result.gatedOut).toEqual([audit.run_id]);
    expect(result.findings.map((f) => [f.finding.class, f.finding.object_id, f.finding.setting_path])).toEqual(full.result.findings.map((f) => [f.finding.class, f.finding.object_id, f.finding.setting_path])); // detection is unchanged: the gate withholds checks
    const split = ofClass(result.findings, "proxy_split")[0];
    expect(split.checks.map((c) => c.template)).toEqual(["run_complete"]);
    expect(split.rejected.map((r) => [(r.check as { template: string }).template, r.reason])).toEqual([
      ["actor_attributed", `actor_attributed: audit log incomplete (latest audit run ${audit.run_id} failed the DQ gate)`],
      ["previous_value_recoverable", `previous_value_recoverable: audit log incomplete (latest audit run ${audit.run_id} failed the DQ gate)`],
      ["referent_unchanged", `referent_unchanged: audit log incomplete (latest audit run ${audit.run_id} failed the DQ gate)`],
    ]);
    expect(split.verb).toBe("ESCALATE");
    // every class whose default policy reads the log escalates; orphan_vhost (run_complete, other_settings_reference, backup_recent) and
    // changed_since_backup (run_complete, backup_recent, change_in_last_backup, setting_matches_approved) read no audit row and keep their verbs
    expect(result.findings.filter((f) => !["orphan_vhost", "changed_since_backup"].includes(f.finding.class)).every((f) => f.verb === "ESCALATE" && f.rejected.length > 0)).toBe(true);
    expect(ofClass(result.findings, "changed_since_backup").every((f) => f.rejected.length === 0)).toBe(true);
    expect(ofClass(result.findings, "orphan_vhost").map((f) => f.verb)).toEqual(ofClass(full.result.findings, "orphan_vhost").map((f) => f.verb));
    expect(result.findings.every((f) => f.checks.every((c) => !["actor_attributed", "previous_value_recoverable", "referent_unchanged", "record_reverted"].includes(c.template)))).toBe(true);
    const withheld = tracer.events.filter((e) => e.action === "check" && e.status === "not_checked" && e.input_summary === `audit_event ${T}`);
    expect(withheld).toHaveLength(1);
    expect(withheld[0].output_summary).toBe(`audit log withheld for ${T}: latest audit run ${audit.run_id} failed the DQ gate`);
    expect(tracer.events.filter((e) => e.agent === "checker" && e.status === "not_checked").map((e) => e.detail)).toContain(`referent_unchanged: audit log incomplete (latest audit run ${audit.run_id} failed the DQ gate)`);
    // with the run passing, the full bundle's checks read the log: the recorded pass above has no rejections
    expect(full.result.findings.every((f) => f.rejected.length === 0)).toBe(true);
    // no audit run at all for the tenant: the rows have no provenance, so the same withholding
    const none = structuredClone(recorded) as R;
    none.collection_run = none.collection_run.filter((r) => r.surface !== "cloudflare.audit");
    const r2 = await pass(none);
    expect(ofClass(r2.result.findings, "proxy_split")[0].rejected.map((r) => r.reason)).toEqual([
      "actor_attributed: audit log incomplete (no cloudflare.audit run for this tenant)",
      "previous_value_recoverable: audit log incomplete (no cloudflare.audit run for this tenant)",
      "referent_unchanged: audit log incomplete (no cloudflare.audit run for this tenant)",
    ]);
  });

  it("every line of the trace carries model: none; the survey queries and their checks are all traced ok", async () => {
    const { tracer } = await pass(recorded);
    const ev = tracer.events;
    expect(ev.every((e) => e.model_requested === "none")).toBe(true);
    expect(ev.filter((e) => e.action === "query" && e.status === "failed")).toEqual([]);
    expect(heroQueries(ev)).toHaveLength(2);
    expect(ev.filter((e) => e.action === "detect" && e.status === "not_checked")).toEqual([]);
    expect(ev.filter((e) => e.action === "decide")).toHaveLength(38);
    expect(ev.filter((e) => e.action === "judge" && e.status === "skipped")).toHaveLength(38);
    // 1 runs + 4 gate + 2 observations + 2 resolutions + 2 hero + 1 audit span + 1 proxy_split + 2 hosts x 4 survey queries + checks (4 x 24 + 3 x 3)
    // + exposure (test/exposure.test.ts measures it): 15 distinct (record, state) pairs -> 15 record rows + 15 first-event queries + 4 earlier-body counts
    // + the policy read + drift_vs_approved over both host runs and the DNS run + changed_since_backup over both host runs + 4 checks x 11 backup findings
    // + approved_missing over both host runs and the DNS run (0 rows: the recording holds no approval)
    expect(okQueries(ev)).toHaveLength(1 + 4 + 2 + 2 + 2 + 1 + 1 + 8 + 4 * 24 + 3 * 3 + 15 + 15 + 4 + 1 + 3 + 2 + 4 * 11 + 3);
    // the decide lines the default settled carry the default policy, and one decider line counts what the locked rules lack
    expect(ev.filter((e) => e.action === "decide").every((e) => e.detail === DEFAULT_POLICY_DETAIL)).toBe(true);
    expect(ev.filter((e) => e.input_summary === "policy").map((e) => [e.agent, e.action, e.output_summary, e.detail])).toEqual([[
      "decider", "triage", "locked settings without an approved value: 0",
      "0 policy rule(s) read; verbs ADOPT 5, ESCALATE 33; decided by policy 0, operator 0, default 38; no probe run in this pass; no ledger; model: none",
    ]]);
  });

  it("decided at the bundle's own instant (decidedAt), two passes give the same findings and ledger rows, every HOLD expiry included; the memory's instant (at) leaves decided_at to the clock", async () => {
    // the recorded rows with the hackathon policy loaded, so the held findings carry expiries
    const rules = loadPolicyFile(fileURLToPath(new URL("../policy/hackathon.json", import.meta.url)), { tenant: T, redactor: new Redactor("policy-fixture-salt") }).rows;
    const b = { ...structuredClone(recorded), policy_rule: rules };
    const at = decisionInstant(b)!;
    expect(at).toBe([...recorded.collection_run].map((r) => r.finished_at ?? r.started_at).sort().at(-1));
    const once = async (world: string, opts: Partial<PassOptions>) => {
      const engine = await SqlJsEngine.create();
      engine.loadBundle(b);
      const layer = new DataLayer(engine);
      const result = await runPass(layer, { world: new DriftWorld(world), ledger: new MemoryLedger(engine), ...opts });
      const ledger = objects(await layer.run(DISPOSITIONS_SQL, {}, { limit: 100_000 }));
      engine.close();
      return { result, ledger };
    };
    const first = await once("determinism_1", { decidedAt: at });
    await new Promise((r) => setTimeout(r, 15));
    const second = await once("determinism_2", { decidedAt: at });
    expect(second.result.findings).toEqual(first.result.findings);
    expect(second.ledger).toEqual(first.ledger);
    expect(first.ledger).toHaveLength(38);
    expect(first.ledger.every((d) => d.decided_at === at)).toBe(true);
    const held = first.result.findings.filter((f) => f.verb === "HOLD");
    expect(held).toHaveLength(38);
    for (const f of held) expect(f.disposition.expires_at, f.id).toBe(holdUntil(at, rules.find((r) => r.rule_id === f.disposition.rule_id)!.hold_max_hours));
    // at is the instant lessons are recalled at, and nothing more: without decidedAt the system clock dates the dispositions
    const far = "2030-01-01T00:00:00.000Z";
    const clocked = await once("determinism_clock", { at: far });
    expect(clocked.ledger.every((d) => d.decided_at !== far && d.decided_at !== at)).toBe(true);
    expect(clocked.result.findings.map((f) => f.id)).toEqual(first.result.findings.map((f) => f.id));
  });

  it("every finding carries a short stable id (fnd- plus 16 hex of the World Model's finding id), distinct across the 38 and the same on a second pass; without a memory the result says so", async () => {
    const a = await pass(recorded);
    const b = await pass(recorded);
    const ids = a.result.findings.map((f) => f.id);
    expect(ids.every((id) => /^fnd-[0-9a-f]{16}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(38);
    expect(b.result.findings.map((f) => f.id)).toEqual(ids);
    const world = new DriftWorld("ids");
    expect(ids).toEqual(a.result.findings.map((f) => shortFindingId(world.findingId(f.finding))));
    expect(a.result.memory).toBeNull();
    expect(a.result.findings.every((f) => f.exception === undefined)).toBe(true);
  });
});

describe("the Decider consults the technician's memory (src/engine/memory.ts) before deciding", () => {
  const T0 = Date.parse("2026-10-24T12:00:00.000Z");
  const prov = { kind: "cli", at: "2026-10-24T11:59:00.000Z", by: "technician", runId: DNS_RUN };
  const EXPIRES = "2026-11-30T00:00:00.000Z";

  async function passWithMemory(memory: TechnicianMemory, at?: string) {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(recorded);
    const tracer = new MemTracer("test_pipeline_memory", { model: "none" });
    const result = await runPass(new DataLayer(engine), { tracer, world: new DriftWorld("test_pipeline_memory"), memory, at });
    return { result, tracer };
  }
  const verbsOf = (fs: Finding[]) => fs.map((f) => [f.id, f.verb]);

  it("an accepted exception in force adopts the finding it scopes, with the lesson's expiry on the finding and in the trace, and withholds the judge; every other finding keeps its verb", async () => {
    const plain = await pass(recorded);
    const memory = new TechnicianMemory({ clock: () => T0 });
    const lesson = memory.recordException({ tenantId: T, findingClass: "proxy_split", scopeKey: WWW_NAME, reason: "the apex stays direct until the origin certificate lands", expiresAt: EXPIRES, provenance: prov });
    const { result, tracer } = await passWithMemory(memory);
    const split = ofClass(result.findings, "proxy_split")[0];
    const was = ofClass(plain.result.findings, "proxy_split")[0];
    expect(was.verb).toBe("ESCALATE");
    expect(split.verb).toBe("ADOPT");
    expect(split.exception).toEqual({ lesson: lesson.id, status: "applied", expires_at: EXPIRES, scope_key: WWW_NAME, reason: lesson.reason, accepted_by: "technician", accepted_at: "2026-10-24T12:00:00.000Z" });
    // the checks still ran and are recorded as they were; only the verb and the judge call changed
    expect(split.checks).toEqual(was.checks);
    expect(split.exposure).toEqual(was.exposure);
    expect(split.judgeWithheld).toBe(`verdict cannot move: accepted exception ${lesson.id} holds until ${EXPIRES}; the technician's acceptance, not a judge, settles it`);
    expect(verbsOf(result.findings.filter((f) => f.id !== split.id))).toEqual(verbsOf(plain.result.findings.filter((f) => f.id !== split.id)));
    expect(result.memory).toEqual({ lessons: 1, applied: 1, lapsed: 0 });
    expect(result.verifier.withdrawn_judge).toBe(1);
    const mem = tracer.events.filter((e) => e.input_summary?.startsWith("memory "));
    expect(mem.map((e) => [e.agent, e.action, e.status, e.output_summary])).toEqual([
      ["decider", "triage", "ok", `exception ${lesson.id} accepted by technician until ${EXPIRES}: ADOPT`],
    ]);
    expect(mem[0].input_summary).toBe(`memory proxy_split proxied in ${WWW_RECORD}`);
    expect(mem[0].detail).toContain(`lesson ${lesson.id} on ${WWW_NAME} (proxy_split)`);
    const decide = tracer.events.find((e) => e.action === "decide" && e.input_summary === `proxy_split proxied in ${WWW_RECORD}`)!;
    expect(decide.output_summary).toBe(`ADOPT: accepted exception ${lesson.id} holds until ${EXPIRES} (${lesson.reason}); the checks alone would say ESCALATE`);
    expect(decide.detail).toContain(`; exception: ${lesson.id} applied`);
    expect(tracer.events.find((e) => e.action === "judge" && e.input_summary === split.finding.summary.slice(0, 160))?.detail).toMatch(/^verdict cannot move: accepted exception/);
    expect(tracer.events.filter((e) => e.action === "triage" && e.input_summary === "memory").map((e) => e.output_summary)).toEqual(["lessons 1, exceptions applied 1, lapsed 0"]);
    // the H-MEM ledger saw the recall
    expect(memory.hmem.ledger.history(lesson.id).map((h) => h.action)).toEqual(["create", "read"]);
  });

  it("the same exception recalled after its expiry re-raises the finding as ESCALATE ('exception lapsed'), flagged on the finding and traced; nothing is applied", async () => {
    const memory = new TechnicianMemory({ clock: () => T0 });
    const lesson = memory.recordException({ tenantId: T, findingClass: "proxy_split", scopeKey: WWW_NAME, reason: "temporary", expiresAt: EXPIRES, provenance: prov });
    const { result, tracer } = await passWithMemory(memory, "2026-12-01T00:00:00.000Z");
    const split = ofClass(result.findings, "proxy_split")[0];
    expect(split.verb).toBe("ESCALATE");
    expect(split.exception).toMatchObject({ lesson: lesson.id, status: "lapsed", expires_at: EXPIRES, scope_key: WWW_NAME });
    expect(split.judgeWithheld).toBe(`verdict cannot move: exception ${lesson.id} lapsed ${EXPIRES}; the finding goes back to the technician whatever a judge answers`);
    expect(result.memory).toEqual({ lessons: 1, applied: 0, lapsed: 1 });
    const esc = tracer.events.filter((e) => e.action === "escalate");
    expect(esc.map((e) => [e.agent, e.status, e.input_summary, e.output_summary])).toEqual([["decider", "ok", `memory proxy_split proxied in ${WWW_RECORD}`, `exception ${lesson.id} lapsed ${EXPIRES}: re-raised as ESCALATE`]]);
    expect(tracer.events.find((e) => e.action === "decide" && e.input_summary === `proxy_split proxied in ${WWW_RECORD}`)!.output_summary)
      .toBe(`ESCALATE: exception lapsed: ${lesson.id} expired ${EXPIRES}; re-raised to the technician, the checks alone would say ESCALATE`);
  });

  it("a lapsed exception re-raises even a finding every check of which holds: the two host-18efce.ai blocks go from ADOPT to ESCALATE", async () => {
    const memory = new TechnicianMemory({ clock: () => T0 });
    const lesson = memory.recordException({ tenantId: T, findingClass: "proxied_without_real_ip", scopeKey: "host-18efce.ai", reason: "accepted for the September migration", expiresAt: "2026-10-01T00:00:00.000Z", provenance: { ...prov, at: "2026-09-01T00:00:00.000Z" } });
    const plain = await pass(recorded);
    const { result } = await passWithMemory(memory);
    const ai = result.findings.filter((f) => f.finding.dns_name === "host-18efce.ai");
    expect(ai).toHaveLength(2);
    expect(plain.result.findings.filter((f) => f.finding.dns_name === "host-18efce.ai").map((f) => f.verb)).toEqual(["ADOPT", "ADOPT"]);
    expect(ai.map((f) => [f.verb, f.exception?.status, f.exception?.lesson])).toEqual([["ESCALATE", "lapsed", lesson.id], ["ESCALATE", "lapsed", lesson.id]]);
    expect(ai.every((f) => f.checks.every((c) => c.holds))).toBe(true);
    expect(result.findings.filter((f) => f.verb === "ADOPT")).toHaveLength(3);
    expect(result.memory).toEqual({ lessons: 1, applied: 0, lapsed: 2 });
  });

  it("recall is by exact scope key, class and tenant: a near-miss name, another class on the right name and another tenant change nothing", async () => {
    const plain = await pass(recorded);
    const memory = new TechnicianMemory({ clock: () => T0 });
    memory.recordException({ tenantId: T, findingClass: "proxy_split", scopeKey: "host-524b43.quest", reason: "one character off", expiresAt: EXPIRES, provenance: prov });
    memory.recordException({ tenantId: T, findingClass: "orphan_record", scopeKey: WWW_NAME, reason: "other class", expiresAt: EXPIRES, provenance: prov });
    memory.recordException({ tenantId: "client-2", findingClass: "proxy_split", scopeKey: WWW_NAME, reason: "other tenant", expiresAt: EXPIRES, provenance: prov });
    memory.recordAnswer({ tenantId: T, question: "Is the apex meant to be direct?", answer: "Yes.", scope: { type: "name", key: WWW_NAME }, expiresAt: EXPIRES, provenance: prov });
    const { result, tracer } = await passWithMemory(memory);
    expect(verbsOf(result.findings)).toEqual(verbsOf(plain.result.findings));
    expect(result.findings.every((f) => f.exception === undefined)).toBe(true);
    expect(result.memory).toEqual({ lessons: 4, applied: 0, lapsed: 0 });
    expect(tracer.events.filter((e) => e.input_summary?.startsWith("memory "))).toEqual([]);
    expect(tracer.events.filter((e) => e.action === "escalate")).toEqual([]);
    // the answer is in force on the www name: the Decider's helper finds it, so the question would not be asked again
    const split = ofClass(result.findings, "proxy_split")[0];
    expect(memory.answered(split.finding, "is the apex meant to be direct?")?.answer).toBe("Yes.");
    expect(memory.exceptionFor(split.finding)).toBeNull();
  });
});

describe("the authored fixture's pass is the one it was: the default decides every finding and a ledger changes nothing", () => {
  it("the same findings, verbs, checks and decide lines with or without a ledger; every disposition the default's", async () => {
    const plain = await pass(authored);
    const engine = await SqlJsEngine.create();
    engine.loadBundle(authored);
    const tracer = new MemTracer("test_pipeline_ledger", { model: "none" });
    const led = await runPass(new DataLayer(engine), { tracer, world: new DriftWorld("test_pipeline_ledger"), ledger: new MemoryLedger(engine) });
    expect(led.findings).toEqual(plain.result.findings);
    expect(plain.result.findings.map((f) => [f.finding.class, f.verb, f.disposition])).toEqual([
      ["found_but_different", "ESCALATE", { verb: "ESCALATE", reason: "1 of 4 preconditions fail: dns_target_in_inventory", expires_at: null, decided_by: "default", rule_id: null }],
      ["proxy_split", "ESCALATE", { verb: "ESCALATE", reason: "2 of 4 preconditions fail: actor_attributed, previous_value_recoverable", expires_at: null, decided_by: "default", rule_id: null }],
    ]);
    const decide = (ev: TraceEvent[]) => ev.filter((e) => e.action === "decide").map((e) => [e.input_summary, e.output_summary, e.detail]);
    expect(decide(tracer.events)).toEqual(decide(plain.tracer.events));
    expect(decide(tracer.events).every(([, , d]) => d === DEFAULT_POLICY_DETAIL)).toBe(true);
    // the ledger holds the two dispositions and the two dns_name fingerprints of the passing host runs (obs-0001 against run-dns-1020, obs-0003 against run-dns-1023)
    expect(led.ledger).toEqual({ dispositions: 2, fingerprints: 2 });
    expect(tracer.events.find((e) => e.input_summary === "policy")?.detail).toContain("ledger: 2 disposition(s) and 2 referent fingerprint(s) written");
  });
});

describe("the Decider under the MSP's policy (test/fixtures/policy-bundle.json)", () => {
  type PB = typeof policyBundle;
  const AT = "2026-10-23T03:00:00.000Z";
  const APP = "/etc/nginx/conf.d/app.conf";
  const SHOP = "/etc/nginx/conf.d/shop.conf";
  const API = "/etc/nginx/conf.d/api.conf";
  const BAK = "/etc/nginx/conf.d/app.conf.bak";
  const PROBE_RUN = "run-probe-1023";
  const rules = policyBundle.policy_rule as PolicyRule[];
  const ruleFor = (surface: string, objectGlob: string, settingGlob: string): string => rules.find((r) => r.surface === surface && r.object_glob === objectGlob && r.setting_glob === settingGlob)!.rule_id;
  const CONFD = ruleFor("linux.nginx", "/etc/nginx/conf.d/*.conf", "file");
  const COPIES = ruleFor("linux.nginx", "/etc/nginx/conf.d/*.conf.*", "**");
  const CONTENT = ruleFor("cloudflare.dns", "*", "content");
  const PROXIED = ruleFor("cloudflare.dns", "*", "proxied");
  const CATCH_ALL = ruleFor("*", "**", "**");
  const approvedOf = (object: string, setting = "file") => policyBundle.approved_setting.find((a) => a.object_id === object && a.setting_path === setting)!.value_hash;
  const commitOf = (run: string, object: string) => policyBundle.vault_copy.find((c) => c.run_id === run && c.object_id === object)!.git_commit;
  const h12 = (h: string) => h.replace(/^sha256:/, "").slice(0, 12);

  async function policyPass(b: Readonly<Record<string, unknown>> = policyBundle, extra: Partial<PassOptions> = {}) {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(b);
    const layer = new DataLayer(engine);
    const tracer = new MemTracer("test_pipeline_policy", { model: "none" });
    const ledger = new MemoryLedger(engine);
    const result = await runPass(layer, { tracer, world: new DriftWorld("test_pipeline_policy"), ledger, at: AT, decidedAt: AT, ...extra });
    return { result, tracer, engine, layer, ledger };
  }
  const without = (mutate: (b: PB) => void): PB => {
    const b = structuredClone(policyBundle);
    mutate(b);
    return b;
  };
  const of = (fs: Finding[], cls: string, object: string, setting = "file") => fs.find((f) => f.finding.class === cls && f.finding.object_id === object && f.finding.setting_path === setting)!;

  it("its policy rows are policy/hackathon.json loaded for client-a under the fixture's salt, every one under tenant *; scripts/fixtures/policy-bundle.ts writes exactly the committed file", () => {
    const loaded = loadPolicyFile(fileURLToPath(new URL("../policy/hackathon.json", import.meta.url)), { tenant: "client-a", redactor: new Redactor("policy-fixture-salt") });
    expect(rules).toEqual([...loaded.rows].sort((a, b) => (a.rule_id < b.rule_id ? -1 : 1)));
    expect(new Set(rules.map((r) => r.tenant_id))).toEqual(new Set(["*"]));
    expect(rules).toHaveLength(15);
    expect(new Set(rules.map((r) => r.version))).toEqual(new Set([2]));
    const committed = readFileSync(POLICY_FIXTURE, "utf8").replace(/\r\n/g, "\n");
    expect(policyBundleText(committed)).toBe(committed);
    expect(policyBundle._note).toContain("the 15 rules of policy/hackathon.json (version 2)");
  });

  it("eleven findings, one disposition each: ROLLBACK the file and the record with a valid copy and the approved file the run lacks, FIX the file whose copy failed while its name fails a probe, HOLD the uncopied file whose names answer, ADOPT the .bak; the prior HOLD in force kept, the expired one ESCALATE", async () => {
    const { result } = await policyPass();
    expect(result.findings.map((f) => [f.finding.class, f.finding.object_id, f.finding.setting_path, f.verb, f.disposition.decided_by, f.disposition.rule_id, f.disposition.expires_at])).toEqual([
      ["found_but_different", APP, "server.location./.proxy_pass", "HOLD", "policy", CATCH_ALL, HOLD_IN_FORCE.expires_at],
      ["proxy_split", "rec-b2", "proxied", "ESCALATE", "policy", PROXIED, null],
      ["drift_vs_approved", API, "file", "HOLD", "policy", CONFD, "2026-10-24T03:00:00.000Z"],
      ["drift_vs_approved", APP, "file", "ROLLBACK", "policy", CONFD, null],
      ["drift_vs_approved", BAK, "file", "ADOPT", "policy", COPIES, null],
      ["drift_vs_approved", SHOP, "file", "FIX", "policy", CONFD, null],
      ["approved_missing", BLOG, "file", "ROLLBACK", "policy", CONFD, null],
      ["changed_since_backup", API, "file", "HOLD", "policy", CONFD, "2026-10-24T03:00:00.000Z"],
      ["changed_since_backup", APP, "file", "HOLD", "policy", CONFD, "2026-10-24T03:00:00.000Z"],
      ["changed_since_backup", BAK, "file", "ADOPT", "policy", COPIES, null],
      ["drift_vs_approved", "rec-c3", "content", "ROLLBACK", "policy", CONTENT, null],
    ]);
    expect(result.verbs).toEqual({ ADOPT: 2, HOLD: 4, ESCALATE: 1, ROLLBACK: 3, FIX: 1 });
    expect([result.rules, result.locked, result.ledger]).toEqual([15, 1, { dispositions: 11, fingerprints: 6 }]);
    // every default check bound: the record's drift gets its record list, the files theirs, the absent file its own
    expect(result.findings.every((f) => f.rejected.length === 0 && f.verb === f.disposition.verb)).toBe(true);
    expect(of(result.findings, "drift_vs_approved", "rec-c3", "content").checks.map((c) => c.template)).toEqual(["run_complete", "actor_attributed", "previous_value_recoverable"]);
    expect(of(result.findings, "drift_vs_approved", APP).checks.map((c) => c.template)).toEqual(["run_complete", "setting_matches_approved", "restore_would_regress", "change_in_last_backup"]);
    expect(of(result.findings, "changed_since_backup", APP).checks.map((c) => [c.template, c.holds])).toEqual([["run_complete", true], ["backup_recent", true], ["change_in_last_backup", false], ["setting_matches_approved", false]]);
    expect(of(result.findings, "approved_missing", BLOG).checks.map((c) => [c.template, c.holds])).toEqual([["run_complete", true], ["backup_recent", true], ["change_in_last_backup", true]]);
  });

  it("approved_missing: blog.conf, approved and copied on 20 Oct and absent from the 23 Oct run, is one finding with no live value, its checks read the approved value, and the rule restores it from the vault copy", async () => {
    const { result, tracer } = await policyPass();
    const blog = of(result.findings, "approved_missing", BLOG);
    expect(blog.finding).toEqual({
      class: "approved_missing", tenant_id: "client-a", run_id: "run-nginx-7f1c-1023", surface: "linux.nginx", host: "host-7f1c", object_id: BLOG, setting_path: "file",
      value_hash: "", approved_hash: BLOG_HASH, value_redacted: null, refers_to_type: null, refers_to_id: null, dns_name: null, resolves_to: null, resource_id: null,
      dns_run_id: "run-dns-1023", since: "2026-10-19T09:00:00.000Z", until: "2026-10-23T02:01:02.000Z",
      summary: `file in ${BLOG} on host-7f1c is approved as ${h12(BLOG_HASH)} and absent from run run-nginx-7f1c-1023`,
    });
    expect(blog.checks.find((c) => c.template === "change_in_last_backup")?.explanation).toBe(`The latest backup of host-7f1c holds ${BLOG} file at ${h12(BLOG_HASH)}.`);
    expect(blog.disposition.reason).toBe(`approved ${h12(BLOG_HASH)} is absent from the run; vault commit ${commitOf("run-nginx-7f1c-1020", BLOG).slice(0, 8)} holds the approved copy, validated ok with 0 gaps, so rule ${CONFD} restores it from that copy`);
    expect(tracer.events.filter((e) => e.action === "detect" && e.input_summary?.startsWith("approved_missing ")).map((e) => [e.input_summary, e.output_summary])).toEqual([
      ["approved_missing run-etc-7f1c-1023", "linux.etc host-7f1c: 0 approved setting(s) whose object the run lacks"],
      ["approved_missing run-nginx-7f1c-1023", "linux.nginx host-7f1c: 1 approved setting(s) whose object the run lacks"],
      ["approved_missing run-dns-1023", "cloudflare.dns: 0 approved setting(s) whose object the run lacks"],
    ]);
    expect(tracer.events.find((e) => e.action === "decide" && e.input_summary === `approved_missing file in ${BLOG} on host-7f1c`)?.detail)
      .toContain(`the checks alone say ADOPT; no probe in ${PROBE_RUN} targets a name it serves; approved ${h12(BLOG_HASH)}, 1 copy row(s), valid copy`);
    // the gated 23 Oct run of host-2b9e is not read for absent objects: its group is not checked
    expect(tracer.events.some((e) => e.input_summary === "approved_missing run-nginx-2b9e-1023")).toBe(false);
  });

  it("approved_missing with no valid copy: the copy's latest validation fails and a probe of the name the file served in the 20 Oct run fails, so the rule investigates (FIX)", async () => {
    const b = without((x) => {
      x.observation.push({ ...x.observation.find((o) => o.run_id === "run-nginx-7f1c-1020" && o.object_id === BLOG)!, obs_id: "obs-blog-name", setting_path: "server[blog.example.invalid:443].server_name[blog.example.invalid]", value_hash: `sha256:${"b".repeat(64)}`, value_redacted: "blog.example.invalid", refers_to_type: "dns_name", refers_to_id: "blog.example.invalid" });
      x.probe.push({ ...x.probe.find((p) => p.status === "fail")!, probe_id: "probe-blog-http", target: "blog.example.invalid" });
      x.copy_validation.push({ ...x.copy_validation.find((v) => v.copy_id === x.vault_copy.find((c) => c.object_id === BLOG)!.copy_id)!, validation_id: "val-blog-fail", result: "fail", validated_at: "2026-10-22T04:00:00.000Z" });
    });
    const blog = of((await policyPass(b)).result.findings, "approved_missing", BLOG);
    expect([blog.verb, blog.disposition.expires_at]).toEqual(["FIX", null]);
    expect(blog.disposition.reason).toBe(`approved ${h12(BLOG_HASH)} is absent from the run with no valid copy (1 copy in the vault, latest validation fail) and production affected (1 failing probe in ${PROBE_RUN}: http blog.example.invalid), so rule ${CONFD} investigates, fixes where allowed, documents and opens a ticket`);
  });

  it("approved_missing on a deleted record: rec-c3 gone from the 23 Oct DNS run is one finding on its approved content, named from the 20 Oct run, checked through the record's audit trail and restored from its cf-schema copy", async () => {
    const b = without((x) => {
      x.dns_record = x.dns_record.filter((d) => !(d.run_id === "run-dns-1023" && d.record_id === "rec-c3"));
      x.observation = x.observation.filter((o) => !(o.run_id === "run-dns-1023" && o.object_id === "rec-c3"));
      const dns = x.collection_run.find((r) => r.run_id === "run-dns-1023")!;
      dns.expected_count = 2;
      dns.observed_count = 2;
    });
    const { result } = await policyPass(b);
    expect(ofClass(result.findings, "drift_vs_approved").map((f) => f.finding.object_id)).toEqual([API, APP, BAK, SHOP]);
    const rec = of(result.findings, "approved_missing", "rec-c3", "content");
    expect(rec.finding).toMatchObject({
      surface: "cloudflare.dns", host: null, run_id: "run-dns-1023", value_hash: "", approved_hash: approvedOf("rec-c3", "content"), dns_name: "mail.example.invalid", resource_id: "rec-c3",
      dns_run_id: "run-dns-1023", since: "2026-10-19T09:00:00.000Z", until: "2026-10-23T02:05:01.000Z",
      summary: `content in rec-c3 is approved as ${h12(approvedOf("rec-c3", "content"))} and absent from run run-dns-1023`,
    });
    expect(rec.checks.map((c) => c.template)).toEqual(["run_complete", "actor_attributed", "previous_value_recoverable"]);
    expect([rec.verb, rec.disposition.rule_id]).toEqual(["ROLLBACK", CONTENT]);
    expect(rec.disposition.reason).toBe(`approved ${h12(approvedOf("rec-c3", "content"))} is absent from the run; vault commit ${commitOf("run-dns-1020", "rec-c3").slice(0, 8)} holds the approved copy, validated ok with 0 gaps, so rule ${CONTENT} restores it from that copy`);
    // the locked proxied field without an approval went with the record
    expect(result.locked).toBe(0);
  });

  it("the prior HOLD: the found_but_different setting held on 21 Oct until 24 Oct 03:00 UTC keeps that expiry; the proxy_split held until 23 Oct 00:00 UTC is ESCALATE; each decide line names the HOLD it read", async () => {
    const { result, tracer } = await policyPass();
    const fbd = ofClass(result.findings, "found_but_different")[0];
    const split = ofClass(result.findings, "proxy_split")[0];
    expect(fbd.disposition).toEqual({ verb: "HOLD", decided_by: "policy", rule_id: CATCH_ALL, expires_at: HOLD_IN_FORCE.expires_at, reason: `held since ${HOLD_IN_FORCE.decided_at} until ${HOLD_IN_FORCE.expires_at} under rule ${CATCH_ALL}` });
    expect(split.disposition).toEqual({ verb: "ESCALATE", decided_by: "policy", rule_id: PROXIED, expires_at: null, reason: `hold under rule ${PROXIED} expired ${HOLD_EXPIRED.expires_at}; the finding stands` });
    // the prior rows are the ledger's own: the fixture's two HOLDs, on the live values this pass decides on
    const prior = policyBundle.disposition;
    expect(prior.map((d) => [d.finding_id, d.value_hash])).toEqual([[fbd.id, fbd.finding.value_hash], [split.id, split.finding.value_hash]]);
    const line = (cls: string) => tracer.events.find((e) => e.action === "decide" && e.input_summary?.startsWith(`${cls} `))?.detail;
    expect(line("found_but_different")).toMatch(new RegExp(`; prior HOLD since ${HOLD_IN_FORCE.decided_at} until ${HOLD_IN_FORCE.expires_at}$`));
    expect(line("proxy_split")).toMatch(new RegExp(`; prior HOLD since ${HOLD_EXPIRED.decided_at} until ${HOLD_EXPIRED.expires_at}$`));
    // decided at the first HOLD's own instant, the ledger holds no HOLD decided before it: each finding gets the rule's own HOLD and expiry
    const early = (await policyPass(policyBundle, { decidedAt: HOLD_IN_FORCE.decided_at })).result;
    expect(ofClass(early.findings, "found_but_different")[0].disposition).toMatchObject({ verb: "HOLD", expires_at: "2026-10-24T03:00:00.000Z", reason: `rule ${CATCH_ALL} (normal) holds this found_but_different finding until 2026-10-24T03:00:00.000Z` });
    expect(ofClass(early.findings, "proxy_split")[0].disposition).toMatchObject({ verb: "HOLD", expires_at: "2026-10-21T07:00:00.000Z" });
    // with the ledger's prior rows taken out, both are held from this pass's instant
    const fresh = (await policyPass(without((x) => { x.disposition = []; }))).result;
    expect(ofClass(fresh.findings, "found_but_different")[0].disposition.expires_at).toBe("2026-10-26T03:00:00.000Z");
    expect(ofClass(fresh.findings, "proxy_split")[0].disposition).toMatchObject({ verb: "HOLD", expires_at: "2026-10-23T07:00:00.000Z" });
  });

  it("each reason is one plain sentence naming what decided it: the approved hash, the vault commit and the validation; the copy and the probes; the expiry", async () => {
    const { result } = await policyPass();
    const reason = (cls: string, object: string, setting?: string) => of(result.findings, cls, object, setting).disposition.reason;
    expect(reason("drift_vs_approved", APP)).toBe(`live value drifted from approved ${h12(approvedOf(APP))}; vault commit ${commitOf("run-nginx-7f1c-1020", APP).slice(0, 8)} holds the approved copy, validated ok with 0 gaps, so rule ${CONFD} rolls it back to that copy`);
    expect(reason("drift_vs_approved", "rec-c3", "content")).toBe(`live value drifted from approved ${h12(approvedOf("rec-c3", "content"))}; vault commit ${commitOf("run-dns-1020", "rec-c3").slice(0, 8)} holds the approved copy, validated ok with 0 gaps, so rule ${CONTENT} rolls it back to that copy`);
    expect(reason("drift_vs_approved", SHOP)).toBe(`live value drifted from approved ${h12(approvedOf(SHOP))} with no valid copy (1 copy in the vault, latest validation fail) and production affected (1 failing probe in ${PROBE_RUN}: http shop.example.invalid), so rule ${CONFD} investigates, fixes where allowed, documents and opens a ticket`);
    expect(reason("drift_vs_approved", API)).toBe(`live value drifted from approved ${h12(approvedOf(API))} with no valid copy (none in the vault) and production answering (3 probes of its names ok in ${PROBE_RUN}), so rule ${CONFD} holds it until 2026-10-24T03:00:00.000Z`);
    expect(reason("drift_vs_approved", BAK)).toBe(`live value drifted from approved ${h12(approvedOf(BAK))}; rule ${COPIES} (low) adopts the live value`);
    expect(reason("changed_since_backup", API)).toBe(`rule ${CONFD} restores a setting to its approved value; this changed_since_backup finding concerns the setting's relation to another setting while its own value stands, so it is held until 2026-10-24T03:00:00.000Z`);
    expect(reason("found_but_different", APP, "server.location./.proxy_pass")).toBe(`held since ${HOLD_IN_FORCE.decided_at} until ${HOLD_IN_FORCE.expires_at} under rule ${CATCH_ALL}`);
    expect(reason("proxy_split", "rec-b2", "proxied")).toBe(`hold under rule ${PROXIED} expired ${HOLD_EXPIRED.expires_at}; the finding stands`);
    expect(reason("approved_missing", BLOG)).toBe(`approved ${h12(BLOG_HASH)} is absent from the run; vault commit ${commitOf("run-nginx-7f1c-1020", BLOG).slice(0, 8)} holds the approved copy, validated ok with 0 gaps, so rule ${CONFD} restores it from that copy`);
    // the detector's own sentence for the drift and for the backup difference
    expect(of(result.findings, "drift_vs_approved", "rec-c3", "content").finding).toMatchObject({
      host: null, dns_name: "mail.example.invalid", resolves_to: "198.51.100.11", resource_id: "rec-c3", dns_run_id: "run-dns-1023", since: "2026-10-19T09:00:00.000Z", until: "2026-10-23T02:05:00.000Z",
      summary: `content of record rec-c3 (mail.example.invalid) is 198.51.100.11 (${h12(of(result.findings, "drift_vs_approved", "rec-c3", "content").finding.value_hash)}), and its latest approval, 2026-10-19T09:00:00.000Z by tech-4e, is ${h12(approvedOf("rec-c3", "content"))}: the live value drifted from the approved one`,
    });
    expect(of(result.findings, "changed_since_backup", APP).finding.summary).toMatch(/^\/etc\/nginx\/conf\.d\/app\.conf on host-7f1c is [0-9a-f]{12} and its copy in the host's newest backup \(snap-restic-0001, taken 2026-10-21T01:05:00\.000Z\) is [0-9a-f]{12}: the live file and the backup copy differ$/);
  });

  it("the decide line is '<verb>: <reason>' and names the rule; one decider line per pass counts the locked settings without an approved value (rec-c3's proxied field)", async () => {
    const { result, tracer } = await policyPass();
    const decide = tracer.events.filter((e) => e.action === "decide");
    expect(decide.map((e) => e.output_summary)).toEqual(result.findings.map((f) => `${f.verb}: ${f.disposition.reason}`));
    expect(decide.every((e, i) => e.detail?.startsWith(`model: none; policy: ${result.findings[i].disposition.rule_id} (`))).toBe(true);
    expect(decide[3].detail).toContain(`the checks alone say ESCALATE; no probe in ${PROBE_RUN} targets a name it serves; approved ${h12(approvedOf(APP))}, 1 copy row(s), valid copy`);
    expect(decide[5].detail).toContain(`production affected (1 failing probe in ${PROBE_RUN}: http shop.example.invalid); approved ${h12(approvedOf(SHOP))}, 1 copy row(s), no valid copy`);
    expect(tracer.events.filter((e) => e.input_summary === "policy").map((e) => [e.output_summary, e.detail])).toEqual([[
      "locked settings without an approved value: 1",
      `15 policy rule(s) read; verbs ADOPT 2, HOLD 4, ESCALATE 1, ROLLBACK 3, FIX 1; decided by policy 11, operator 0, default 0; probe run(s) ${PROBE_RUN}; ledger: 11 disposition(s) and 6 referent fingerprint(s) written; model: none`,
    ]]);
    expect(tracer.events.every((e) => e.model_requested === "none") && tracer.events.every((e) => !(e.action === "query" && e.status === "failed"))).toBe(true);
  });

  it("the ledger rows read back through SQL are the dispositions, column for column, beside the fixture's two prior HOLDs; a second pass into the same ledger writes none", async () => {
    const { result, layer, ledger, engine } = await policyPass();
    const rows = objects(await layer.run(DISPOSITIONS_SQL));
    expect(rows).toHaveLength(11 + 2);
    const expected = result.findings.map((f) => ({
      disposition_id: dispositionId(f.finding.tenant_id, f.finding.surface, f.finding.host, f.finding.object_id, f.finding.setting_path, f.finding.value_hash, f.id, f.finding.run_id),
      tenant_id: "client-a", surface: f.finding.surface, host: f.finding.host ?? "", object_id: f.finding.object_id, setting_path: f.finding.setting_path, value_hash: f.finding.value_hash,
      verb: f.verb, reason: f.disposition.reason, expires_at: f.disposition.expires_at ?? "", decided_by: "policy", rule_id: f.disposition.rule_id ?? "", finding_id: f.id, run_id: f.finding.run_id, decided_at: AT,
    }));
    const prior = policyBundle.disposition.map((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === null ? "" : String(v)])));
    expect(rows).toEqual([...expected, ...prior].sort((a, b) => (a.disposition_id < b.disposition_id ? -1 : 1)));
    // the approved_missing row carries no live value
    expect(rows.find((r) => r.object_id === BLOG)).toMatchObject({ verb: "ROLLBACK", value_hash: "", run_id: "run-nginx-7f1c-1023" });
    // a drift ROLLBACK is about the live value of the run: it joins the observation it decides on; the absent file's has none to join
    const live = objects(await layer.run(`SELECT d.object_id, d.setting_path, o.obs_id FROM {{t:disposition}} d JOIN {{t:observation}} o ON o.run_id = d.run_id AND o.object_id = d.object_id
  AND o.setting_path = d.setting_path AND o.value_hash = d.value_hash WHERE d.verb = 'ROLLBACK' ORDER BY d.object_id, d.disposition_id`));
    expect(live.map((r) => [r.object_id, r.setting_path])).toEqual([[APP, "file"], ["rec-c3", "content"]]);
    const again = await runPass(layer, { world: new DriftWorld("again"), ledger, at: AT, decidedAt: AT });
    expect(again.ledger).toEqual({ dispositions: 0, fingerprints: 0 });
    expect(again.findings.map((f) => f.disposition)).toEqual(result.findings.map((f) => f.disposition));
    expect(objects(await layer.run(DISPOSITIONS_SQL))).toHaveLength(13);
    engine.close();
  });

  it("the pass writes referent_fingerprint rows, and FOUND-BUT-DIFFERENT as one SQL comparison over them finds what the World Model found", async () => {
    const { result, layer } = await policyPass();
    const fp = objects(await layer.run("SELECT obs_id, dns_run_id, fingerprint, resolved_at FROM {{t:referent_fingerprint}} ORDER BY obs_id, dns_run_id"));
    expect(fp).toHaveLength(6);
    expect(fp.filter((r) => r.fingerprint !== "").map((r) => [r.obs_id, r.dns_run_id, r.fingerprint, r.resolved_at])).toEqual([
      ["obs-0001", "run-dns-1020", "198.51.100.10", "2026-10-20T02:05:00.000Z"],
      ["obs-0003", "run-dns-1023", "203.0.113.77", "2026-10-23T02:05:00.000Z"],
    ]);
    const sql = objects(await layer.run(FOUND_BUT_DIFFERENT_SQL, { tenant_id: "client-a", run_id: "run-nginx-7f1c-1023", prev_run_id: "run-nginx-7f1c-1020" }));
    const fbd = ofClass(result.findings, "found_but_different")[0];
    expect(sql.map((r) => [r.object_id, r.setting_path, r.before_fingerprint, r.after_fingerprint])).toEqual([[fbd.finding.object_id, fbd.finding.setting_path, fbd.world!.before, fbd.world!.after]]);
  });

  it("the operator's exception outranks the rule: the proxy_split held under the rollback rule becomes ADOPT until the lesson's expiry, decided_by operator", async () => {
    const memory = new TechnicianMemory({ clock: () => Date.parse("2026-10-22T00:00:00.000Z") });
    const lesson = memory.recordException({ tenantId: "client-a", findingClass: "proxy_split", scopeKey: "www.example.invalid", reason: "the apex stays direct during the move", expiresAt: "2026-11-30T00:00:00.000Z", provenance: { kind: "cli", at: "2026-10-22T00:00:00.000Z", by: "technician", runId: "run-dns-1023" } });
    const { result, tracer } = await policyPass(policyBundle, { memory });
    const split = ofClass(result.findings, "proxy_split")[0];
    expect([split.verb, split.disposition.decided_by, split.disposition.rule_id, split.disposition.expires_at]).toEqual(["ADOPT", "operator", null, "2026-11-30T00:00:00.000Z"]);
    expect(split.disposition.reason).toBe(`accepted exception ${lesson.id} holds until 2026-11-30T00:00:00.000Z (the apex stays direct during the move); the checks alone would say ESCALATE`);
    expect(tracer.events.find((e) => e.action === "decide" && e.input_summary === "proxy_split proxied in rec-b2")?.detail)
      .toBe(`${DEFAULT_POLICY_DETAIL}; exception: ${lesson.id} applied; policy: ${PROXIED} governs the setting, the exception decides`);
    // the expired prior HOLD of the proxy_split changes nothing under the exception
    expect(result.verbs).toEqual({ ADOPT: 3, HOLD: 4, ESCALATE: 0, ROLLBACK: 3, FIX: 1 });
  });

  it("with no probe run in the pass production is unknown: the two files with no valid copy escalate, and the reasons say there was no probe run", async () => {
    const b = without((x) => {
      x.collection_run = x.collection_run.filter((r) => r.surface !== "probe");
      x.probe = [];
    });
    const { result, tracer } = await policyPass(b);
    expect([of(result.findings, "drift_vs_approved", SHOP).verb, of(result.findings, "drift_vs_approved", API).verb]).toEqual(["ESCALATE", "ESCALATE"]);
    expect(of(result.findings, "drift_vs_approved", SHOP).disposition).toMatchObject({
      expires_at: null, decided_by: "policy", rule_id: CONFD,
      reason: `live value drifted from approved ${h12(approvedOf(SHOP))} with no valid copy (1 copy in the vault, latest validation fail) and no probe run in this pass, so production is unknown and rule ${CONFD} sends it to a technician`,
    });
    expect(of(result.findings, "drift_vs_approved", API).disposition.reason).toBe(`live value drifted from approved ${h12(approvedOf(API))} with no valid copy (none in the vault) and no probe run in this pass, so production is unknown and rule ${CONFD} sends it to a technician`);
    // the file with a valid copy still rolls back; the rollback rule's other classes are held as before
    expect(of(result.findings, "drift_vs_approved", APP).verb).toBe("ROLLBACK");
    expect(result.verbs).toEqual({ ADOPT: 2, HOLD: 3, ESCALATE: 3, ROLLBACK: 3, FIX: 0 });
    expect(tracer.events.find((e) => e.input_summary === "policy")?.detail).toContain("; no probe run in this pass; ");
  });

  it("a probe run that fails the DQ gate is no probe run of the pass; a copy whose latest validation fails is no valid copy, and with no probe of its names production is unknown", async () => {
    const partial = without((x) => {
      const r = x.collection_run.find((c) => c.run_id === PROBE_RUN)!;
      r.status = "partial";
      r.observed_count = 5;
    });
    const shop = of((await policyPass(partial)).result.findings, "drift_vs_approved", SHOP);
    expect([shop.verb, shop.disposition.expires_at]).toEqual(["ESCALATE", null]);
    expect(shop.disposition.reason).toContain("and no probe run in this pass, so production is unknown");
    const failed = without((x) => {
      x.copy_validation.push({ ...x.copy_validation.find((v) => v.validator === "nginx-t" && v.result === "ok" && v.validated_at === "2026-10-21T04:00:00.000Z")!, validation_id: "val-0000000000000099", result: "fail", validated_at: "2026-10-22T04:00:00.000Z" });
    });
    const app = of((await policyPass(failed)).result.findings, "drift_vs_approved", APP);
    expect([app.verb, app.disposition.expires_at]).toEqual(["ESCALATE", null]);
    expect(app.disposition.reason).toBe(`live value drifted from approved ${h12(approvedOf(APP))} with no valid copy (1 copy in the vault, latest validation fail) and no probe in run-probe-1023 targets a name it serves, so production is unknown and rule ${CONFD} sends it to a technician`);
    // production answering keeps HOLD: api.conf, whose names every probe of the run answers
    const api = of((await policyPass(failed)).result.findings, "drift_vs_approved", API);
    expect([api.verb, api.disposition.expires_at]).toEqual(["HOLD", "2026-10-24T03:00:00.000Z"]);
  });

  it("without policy rows the same findings are decided by the default: ADOPT and ESCALATE only, the default policy on every decide line, nothing counted as locked", async () => {
    const withRules = (await policyPass()).result;
    const { result, tracer } = await policyPass(without((x) => { x.policy_rule = []; }));
    expect(result.findings.map((f) => f.id)).toEqual(withRules.findings.map((f) => f.id));
    expect(result.findings.every((f) => f.disposition.decided_by === "default" && f.disposition.rule_id === null && ["ADOPT", "ESCALATE"].includes(f.verb))).toBe(true);
    // the absent blog.conf adopts as a candidate: its three checks hold
    expect(result.verbs).toEqual({ ADOPT: 1, HOLD: 0, ESCALATE: 10, ROLLBACK: 0, FIX: 0 });
    expect(tracer.events.filter((e) => e.action === "decide").every((e) => e.detail === DEFAULT_POLICY_DETAIL)).toBe(true);
    expect([result.rules, result.locked]).toEqual([0, 0]);
  });

  describe("the Decider's reads, over the fixture through sql.js", () => {
    async function layer(b: Readonly<Record<string, unknown>> = policyBundle): Promise<DataLayer> {
      const engine = await SqlJsEngine.create();
      engine.loadBundle(b);
      return new DataLayer(engine);
    }

    it("POLICY_RULES_SQL: the tenant's rules and every * rule, in rule_id order, as strings", async () => {
      const r = await (await layer()).run(POLICY_RULES_SQL, { tenant_id: "client-a" });
      expect(r.columns).toEqual(["rule_id", "tenant_id", "surface", "object_glob", "setting_glob", "criticality", "lock", "on_drift", "on_no_copy", "hold_max_hours", "alert", "psa_priority", "version", "author", "since", "note"]);
      expect(r.rows.map((x) => x[0])).toEqual(rules.map((x) => x.rule_id));
      expect(objects(r).find((x) => x.rule_id === CONFD)).toMatchObject({ lock: "1", on_drift: "rollback", hold_max_hours: "24", version: "2", note: "a served vhost file is restored to its approved copy when it drifts" });
      expect(objects(r).find((x) => x.rule_id === CATCH_ALL)?.surface).toBe("*");
      const other = without((x) => { x.policy_rule = [...x.policy_rule, { ...x.policy_rule[0], rule_id: "rule-00000000000000ff", tenant_id: "client-b" }]; });
      expect((await (await layer(other)).run(POLICY_RULES_SQL, { tenant_id: "client-a" })).rowCount).toBe(15);
      expect((await (await layer(other)).run(POLICY_RULES_SQL, { tenant_id: "client-b" })).rowCount).toBe(16);
    });

    it("LATEST_APPROVALS_SQL: one row per setting key, the latest approval; an older approval of the same key is left out", async () => {
      const r = objects(await (await layer()).run(LATEST_APPROVALS_SQL, { tenant_id: "client-a" }));
      expect(r).toHaveLength(9);
      expect(r.find((x) => x.object_id === "rec-c3")).toMatchObject({ surface: "cloudflare.dns", host: "", setting_path: "content", value_hash: approvedOf("rec-c3", "content") });
      const older = without((x) => { x.approved_setting.push({ ...x.approved_setting.find((a) => a.object_id === APP && a.setting_path === "file")!, approval_id: "appr-0000000000000001", value_hash: `sha256:${"0".repeat(64)}`, approved_at: "2026-10-01T09:00:00.000Z" }); });
      const r2 = objects(await (await layer(older)).run(LATEST_APPROVALS_SQL, { tenant_id: "client-a" }));
      expect(r2).toHaveLength(9);
      expect(r2.find((x) => x.object_id === APP && x.setting_path === "file")?.value_hash).toBe(approvedOf(APP));
    });

    it("APPROVED_COPIES_SQL: the copies of the approved value with their latest validation; another run's bytes, another host and a missing copy give nothing", async () => {
      const dl = await layer();
      const q = (object: string, setting: string, host: string, surface = "linux.nginx") => dl.run(APPROVED_COPIES_SQL, { tenant_id: "client-a", surface, host, object_id: object, setting_path: setting, approved_hash: approvedOf(object, setting) }).then(objects);
      const app = await q(APP, "file", "host-7f1c");
      expect(app.map((c) => [c.run_id, c.git_commit, c.blob_sha256 === approvedOf(APP), c.value_hash === approvedOf(APP), c.validator, c.result, c.validated_at])).toEqual([
        ["run-nginx-7f1c-1020", commitOf("run-nginx-7f1c-1020", APP), true, true, "nginx-t", "ok", "2026-10-21T04:00:00.000Z"],
      ]);
      expect((await q(SHOP, "file", "host-7f1c")).map((c) => [c.run_id, c.result])).toEqual([["run-nginx-7f1c-1020", "fail"]]);
      expect(await q(API, "file", "host-7f1c")).toEqual([]);
      expect(await q(APP, "file", "")).toEqual([]);
      const rec = await q("rec-c3", "content", "", "cloudflare.dns");
      expect(rec.map((c) => [c.run_id, c.blob_sha256 === approvedOf("rec-c3", "content"), c.value_hash === approvedOf("rec-c3", "content"), c.validator, c.result])).toEqual([["run-dns-1020", false, true, "cf-schema", "ok"]]);
    });

    it("PROBES_OF_RUN_SQL: the probe run's six rows in probe_id order; another run gives none", async () => {
      const dl = await layer();
      const r = objects(await dl.run(PROBES_OF_RUN_SQL, { tenant_id: "client-a", run_id: PROBE_RUN }));
      expect(r.map((p) => p.probe_id)).toEqual([...policyBundle.probe].map((p) => p.probe_id).sort());
      expect(r.filter((p) => p.status === "fail").map((p) => [p.kind, p.target, p.observed])).toEqual([["http", "shop.example.invalid", "status 502 server=nginx cf-ray absent"]]);
      expect((await dl.run(PROBES_OF_RUN_SQL, { tenant_id: "client-a", run_id: "run-dns-1023" })).rowCount).toBe(0);
    });

    it("APPROVED_MISSING_SQL: the latest approvals of a surface and host whose object the run lacks; the DNS run read with host ''", async () => {
      const dl = await layer();
      const q = (surface: string, host: string, run: string) => dl.run(APPROVED_MISSING_SQL, { tenant_id: "client-a", surface, host, run_id: run }).then(objects);
      const r = await q("linux.nginx", "host-7f1c", "run-nginx-7f1c-1023");
      expect(r.map((x) => [x.surface, x.host, x.object_id, x.setting_path, x.approved_hash, x.approved_at, x.approved_by])).toEqual([
        ["linux.nginx", "host-7f1c", BLOG, "file", BLOG_HASH, "2026-10-19T09:00:00.000Z", "tech-4e"],
      ]);
      // the 20 Oct run holds blog.conf and lacks app.conf.bak, which only the 23 Oct run holds
      expect((await q("linux.nginx", "host-7f1c", "run-nginx-7f1c-1020")).map((x) => x.object_id)).toEqual(["/etc/nginx/conf.d/app.conf.bak"]);
      expect(await q("linux.etc", "host-7f1c", "run-etc-7f1c-1023")).toEqual([]);
      expect(await q("cloudflare.dns", "", "run-dns-1023")).toEqual([]);
      // another host and another run's surface give nothing
      expect(await q("linux.nginx", "host-2b9e", "run-nginx-7f1c-1023")).toEqual([]);
      // an approval newer than the latest one at another value is the one returned
      const later = without((x) => {
        x.approved_setting.push({ ...x.approved_setting.find((a) => a.object_id === BLOG)!, approval_id: "appr-blog-later", value_hash: `sha256:${"c".repeat(64)}`, approved_at: "2026-10-22T09:00:00.000Z" });
      });
      expect(objects(await (await layer(later)).run(APPROVED_MISSING_SQL, { tenant_id: "client-a", surface: "linux.nginx", host: "host-7f1c", run_id: "run-nginx-7f1c-1023" })).map((x) => [x.approval_id, x.approved_hash]))
        .toEqual([["appr-blog-later", `sha256:${"c".repeat(64)}`]]);
      // a record is present by its record row or its field observations: with the observations gone it stands, with both gone it is absent
      const dns = (b: PB) => layer(b).then((l) => l.run(APPROVED_MISSING_SQL, { tenant_id: "client-a", surface: "cloudflare.dns", host: "", run_id: "run-dns-1023" })).then(objects);
      const noFields = without((x) => { x.observation = x.observation.filter((o) => !(o.run_id === "run-dns-1023" && o.object_id === "rec-c3")); });
      expect(await dns(noFields)).toEqual([]);
      const gone = without((x) => {
        x.observation = x.observation.filter((o) => !(o.run_id === "run-dns-1023" && o.object_id === "rec-c3"));
        x.dns_record = x.dns_record.filter((d) => !(d.run_id === "run-dns-1023" && d.record_id === "rec-c3"));
      });
      expect((await dns(gone)).map((x) => [x.host, x.object_id, x.setting_path])).toEqual([["", "rec-c3", "content"]]);
    });

    it("PRIOR_HOLDS_SQL: the earliest HOLD of each live value decided before the instant; a later HOLD of the same value and another verb are passed over", async () => {
      const q = async (b: Readonly<Record<string, unknown>>, at: string) => objects(await (await layer(b)).run(PRIOR_HOLDS_SQL, { tenant_id: "client-a", decided_at: at }));
      const [fbd, split] = policyBundle.disposition;
      expect((await q(policyBundle, "2026-10-23T03:00:00.000Z")).map((r) => [r.disposition_id, r.surface, r.host, r.object_id, r.setting_path, r.rule_id, r.expires_at, r.decided_at])).toEqual([
        [split.disposition_id, "cloudflare.dns", "", "rec-b2", "proxied", split.rule_id, HOLD_EXPIRED.expires_at, HOLD_EXPIRED.decided_at],
        [fbd.disposition_id, "linux.nginx", "host-7f1c", fbd.object_id, fbd.setting_path, fbd.rule_id, HOLD_IN_FORCE.expires_at, HOLD_IN_FORCE.decided_at],
      ]);
      // before the proxy_split's HOLD only the found_but_different one stands; at its own instant neither
      expect((await q(policyBundle, "2026-10-22T00:00:00.000Z")).map((r) => r.disposition_id)).toEqual([fbd.disposition_id]);
      expect(await q(policyBundle, HOLD_IN_FORCE.decided_at)).toEqual([]);
      const more = without((x) => {
        x.disposition.push({ ...x.disposition[0], disposition_id: "disp-later-hold", run_id: "run-nginx-7f1c-1023", decided_at: "2026-10-22T03:00:00.000Z" });
        x.disposition.push({ ...x.disposition[0], disposition_id: "disp-0000-escalate", verb: "ESCALATE", expires_at: null as unknown as string, decided_at: "2026-10-20T03:00:00.000Z" });
        x.disposition.push({ ...x.disposition[0], disposition_id: "disp-other-tenant", tenant_id: "client-b", decided_at: "2026-10-20T03:00:00.000Z" });
      });
      expect((await q(more, "2026-10-23T03:00:00.000Z")).map((r) => r.disposition_id)).toEqual([split.disposition_id, fbd.disposition_id]);
    });
  });
});
