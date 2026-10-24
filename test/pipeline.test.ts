// The pass with no model, end to end, over two bundles. The hand-authored fixture (test/fixtures/
// authored-bundle.json) tells the hero story: the gate, the World Model, the hero query, the default
// checks and the verb all come from its rows, and the same pass over a copy whose DNS record still points
// at an inventory host must produce no hero finding, which is what makes the first result a measurement
// and not a planted answer. The recorded bundle (sample/bundle.json, the real estate redacted) exercises
// the survey: 27 findings in four classes, each one checked against a copy where the cause is removed.
// The MemTracer builds events as the real Tracer writes them (redacted, model: none), so the exact-text
// assertions also show the bundles' vocabulary survives.
import { describe, expect, it } from "vitest";
import { DataLayer, DataLayerError, type Params, type RunOptions } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { runPass, shortFindingId, type Finding } from "../src/pipeline.ts";
import type { TraceEvent } from "../src/trace.ts";
import authored from "./fixtures/authored-bundle.json" with { type: "json" };
import recorded from "../sample/bundle.json" with { type: "json" };
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
    expect(okQueries(ev)).toHaveLength(1 + 12 + 5 + 5 + 2 + 4 + 1 + 1 + 4 + 4 + 2 * 2);
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
    // exposure: 2 SELECTs for the proxy_split's record (rec-b2 in run-dns-1020)
    expect(okQueries(tracer.events)).toHaveLength(1 + 12 + 5 + 3 + 1 + 1 + 4 + 2);
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
  it("four complete runs, nothing gated, every observation recorded, no hero finding (every served name lands on an inventory host) and 27 survey findings", async () => {
    const { result } = await pass(recorded);
    expect(result.runs).toBe(4);
    expect(result.gatedOut).toEqual([]);
    expect(result.observed).toBe(recorded.observation.length);
    expect(hero(result.findings)).toEqual([]);
    expect(result.findings).toHaveLength(27);
    const byClass = new Map<string, number>();
    for (const f of result.findings) byClass.set(f.finding.class, (byClass.get(f.finding.class) ?? 0) + 1);
    expect(Object.fromEntries(byClass)).toEqual({ proxy_split: 1, proxied_without_real_ip: 20, orphan_record: 3, orphan_vhost: 3 });
    expect(result.findings.every((f) => f.world === undefined && f.judge === "skipped" && f.rejected.length === 0)).toBe(true);
    expect(result.findings.map((f) => f.verb).filter((v) => v === "ADOPT")).toHaveLength(5);
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
    // every class whose default policy reads the log escalates; orphan_vhost (run_complete, other_settings_reference, backup_recent) reads no audit row and keeps its verbs
    expect(result.findings.filter((f) => f.finding.class !== "orphan_vhost").every((f) => f.verb === "ESCALATE" && f.rejected.length > 0)).toBe(true);
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
    expect(ev.filter((e) => e.action === "decide")).toHaveLength(27);
    expect(ev.filter((e) => e.action === "judge" && e.status === "skipped")).toHaveLength(27);
    // 1 runs + 4 gate + 2 observations + 2 resolutions + 2 hero + 1 audit span + 1 proxy_split + 2 hosts x 4 survey queries + checks (4 x 24 + 3 x 3)
    // + exposure (test/exposure.test.ts measures it): 15 distinct (record, state) pairs -> 15 record rows + 15 first-event queries + 4 earlier-body counts
    expect(okQueries(ev)).toHaveLength(1 + 4 + 2 + 2 + 2 + 1 + 1 + 8 + 4 * 24 + 3 * 3 + 15 + 15 + 4);
  });

  it("every finding carries a short stable id (fnd- plus 16 hex of the World Model's finding id), distinct across the 27 and the same on a second pass; without a memory the result says so", async () => {
    const a = await pass(recorded);
    const b = await pass(recorded);
    const ids = a.result.findings.map((f) => f.id);
    expect(ids.every((id) => /^fnd-[0-9a-f]{16}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(27);
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
