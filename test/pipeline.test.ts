// The pass over sample/bundle.json with no model, end to end: the gate, the World Model, the hero
// query, the default checks and the verb all come from the rows. The same pass over a bundle whose
// DNS record still points at an inventory host must produce nothing, which is what makes the first
// result a measurement and not a planted answer. The MemTracer builds events as the real Tracer writes
// them (redacted, model: none), so the exact-text assertions also show the bundle's vocabulary survives.
import { describe, expect, it } from "vitest";
import { DataLayer, DataLayerError, type Params, type RunOptions } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { runPass } from "../src/pipeline.ts";
import type { TraceEvent } from "../src/trace.ts";
import bundle from "../sample/bundle.json" with { type: "json" };
import { MemTracer } from "./fixtures/mem-tracer.ts";

type B = typeof bundle;

async function pass(b: B, layerOf: (e: SqlJsEngine) => DataLayer = (e) => new DataLayer(e)) {
  const engine = await SqlJsEngine.create();
  engine.loadBundle(b);
  const tracer = new MemTracer("test_pipeline", { model: "none" });
  const result = await runPass(layerOf(engine), { tracer, world: new DriftWorld("test_pipeline") });
  return { result, tracer };
}

/** The negative control: today's A record back on the inventory host, so the hero query has nothing to find. */
function negativeControl(): B {
  const b = structuredClone(bundle);
  const rec = b.dns_record.find((d) => d.record_id === "rec-a1" && d.run_id === "run-dns-1023");
  expect(rec).toBeDefined();
  rec!.content = "198.51.100.10";
  return b;
}

const heroQueries = (ev: TraceEvent[]) => ev.filter((e) => e.action === "query" && e.input_summary?.startsWith("SELECT o.host, o.object_id, o.setting_path, o.refers_to_id AS upstream_name"));

describe("pass over the sample bundle, model: none", () => {
  it("gates the partial run out, records the rest, finds the one FOUND-BUT-DIFFERENT and escalates it", async () => {
    const { result } = await pass(bundle);
    expect(result.runs).toBe(12);
    expect(result.gatedOut).toEqual(["run-nginx-2b9e-1023"]);
    expect(result.observed).toBe(10);
    expect(result.findings).toHaveLength(1);
    const f = result.findings[0];
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

  it("traces every step with model: none on every line, not_checked for the gated run, one check per precondition, decide, judge skipped", async () => {
    const { tracer } = await pass(bundle);
    const ev = tracer.events;
    expect(ev.filter((e) => e.action === "check" && e.status === "not_checked").map((e) => e.input_summary)).toEqual(["run_complete run-nginx-2b9e-1023"]);
    expect(ev.filter((e) => e.action === "detect" && e.status === "not_checked").map((e) => e.input_summary)).toEqual(["linux.nginx host-2b9e"]);
    expect(ev.filter((e) => e.action === "observe")).toHaveLength(5);
    expect(ev.filter((e) => e.agent === "checker" && e.action === "check").map((e) => e.status)).toEqual(["ok", "failed", "ok", "ok"]);
    const decide = ev.filter((e) => e.action === "decide");
    expect(decide).toHaveLength(1);
    expect(decide[0].output_summary).toBe("ESCALATE: 1 of 4 preconditions fail: dns_target_in_inventory");
    expect(decide[0].detail).toMatch(/^model: none/);
    expect(ev.filter((e) => e.action === "judge")).toEqual([expect.objectContaining({ status: "skipped", detail: "model: none (sample)" })]);
    expect(ev.every((e) => e.model_requested === "none")).toBe(true);
    expect(ev.some((e) => e.model_routed !== undefined || e.receipt_id !== undefined)).toBe(false);
    // the redactor leaves the bundle's vocabulary alone: surfaces, the setting path, the SQL text
    expect(ev.find((e) => e.action === "detect" && e.status === "ok" && e.input_summary?.startsWith("server."))?.input_summary).toBe("server.location./.proxy_pass in /etc/nginx/conf.d/app.conf on host-7f1c");
    expect(heroQueries(ev)).toHaveLength(2);
    // 1 runs + 12 gate + 5 observations + 5 resolutions + 2 hero (two host groups pass the gate) + 4 checks
    expect(ev.filter((e) => e.action === "query" && e.status === "ok")).toHaveLength(1 + 12 + 5 + 5 + 2 + 4);
    expect(ev.filter((e) => e.action === "query" && e.status === "failed")).toEqual([]);
  });

  it("finds nothing when the record still points at an inventory host: the result comes from the rows", async () => {
    const { result, tracer } = await pass(negativeControl());
    expect(result.findings).toEqual([]);
    expect(result.gatedOut).toEqual(["run-nginx-2b9e-1023"]);
    expect(result.observed).toBe(10);
    expect(tracer.events.filter((e) => e.action === "decide")).toEqual([]);
  });

  it("a TXT record on the name is not an address: the negative control plus a DMARC TXT (';' and all) in both DNS runs still finds nothing", async () => {
    const b = negativeControl();
    for (const run of ["run-dns-1020", "run-dns-1023"]) {
      b.dns_record.push({ record_id: "rec-txt", run_id: run, tenant_id: "client-a", zone: "example.invalid", name: "app.example.invalid", type: "TXT", content: "v=DMARC1; p=reject", ttl: 3600, proxied: 0, observed_at: run === "run-dns-1020" ? "2026-10-20T02:05:00.000Z" : "2026-10-23T02:05:00.000Z" });
    }
    const { result, tracer } = await pass(b);
    expect(result.findings).toEqual([]);
    expect(result.observed).toBe(10);
    expect(tracer.events.filter((e) => e.action === "decide")).toEqual([]);
    expect(tracer.events.filter((e) => e.action === "query" && e.status === "failed")).toEqual([]);
  });

  it("a CNAME on the vhost's name is not an address either: the chain is not followed, so nothing is found", async () => {
    const b = structuredClone(bundle);
    for (const o of b.observation) if (o.refers_to_id === "app.example.invalid") o.refers_to_id = "www.example.invalid";
    const { result } = await pass(b);
    expect(result.findings).toEqual([]);
  });

  it("classes a hero row as dns_change when the setting has no previous passing run, and still escalates", async () => {
    const b = structuredClone(bundle);
    b.collection_run = b.collection_run.filter((r) => r.run_id !== "run-nginx-7f1c-1020");
    b.observation = b.observation.filter((o) => o.run_id !== "run-nginx-7f1c-1020");
    const { result } = await pass(b);
    expect(result.findings.map((f) => f.finding.class)).toEqual(["dns_change"]);
    const f = result.findings[0];
    expect(f.world).toEqual({ before: null, after: "203.0.113.77", changed: false, bytes_unchanged: false });
    expect(f.finding.since).toBe("2026-10-23T02:01:00.000Z");
    expect(f.checks.map((c) => c.template)).toEqual(["run_complete", "host_in_inventory", "actor_attributed", "previous_value_recoverable"]);
    expect(f.checks.find((c) => c.template === "host_in_inventory")?.holds).toBe(false);
    expect(f.verb).toBe("ESCALATE");
  });

  it("today's DNS run failing the gate pairs with nothing: no stale DNS run stands in, both host groups are not_checked, zero hero queries", async () => {
    const b = structuredClone(bundle);
    const dns = b.collection_run.find((r) => r.run_id === "run-dns-1023")!;
    dns.status = "partial";
    dns.observed_count = 2;
    const { result, tracer } = await pass(b);
    expect(result.gatedOut).toEqual(["run-nginx-2b9e-1023", "run-dns-1023"]);
    expect(result.findings).toEqual([]);
    expect(result.observed).toBe(10);
    const detect = tracer.events.filter((e) => e.action === "detect");
    expect(detect.map((e) => e.status)).toEqual(["not_checked", "not_checked", "not_checked"]);
    expect(detect.filter((e) => /no DNS run of this pass passed the gate \(run-dns-1023 failed\)/.test(e.output_summary ?? "")).map((e) => e.input_summary))
      .toEqual(["linux.etc host-7f1c", "linux.nginx host-7f1c"]);
    expect(heroQueries(tracer.events)).toEqual([]);
    // 1 runs + 12 gate + 5 observations + 3 resolutions (the 20 Oct host runs still pair with run-dns-1020); no hero, no checks
    expect(tracer.events.filter((e) => e.action === "query" && e.status === "ok")).toHaveLength(1 + 12 + 5 + 3);
  });

  it("a name with an A and an AAAA record gives two findings, each carrying its own record and checked against it", async () => {
    const b = structuredClone(bundle);
    b.dns_record.push({ record_id: "rec-a9", run_id: "run-dns-1023", tenant_id: "client-a", zone: "example.invalid", name: "app.example.invalid", type: "AAAA", content: "2001:db8::77", ttl: 300, proxied: 0, observed_at: "2026-10-23T02:05:00.000Z" });
    b.audit_event.push({ event_id: "evt-cf-0002", tenant_id: "client-a", source: "cloudflare", actor: "user-3c7d", action: "rec_add", resource_type: "dns_record", resource_id: "rec-a9", old_value: "", new_value: "2001:db8::77", occurred_at: "2026-10-22T18:50:00.000Z" });
    const { result, tracer } = await pass(b);
    expect(result.findings.map((f) => [f.finding.resolves_to, f.finding.resource_id, f.finding.class])).toEqual([
      ["203.0.113.77", "rec-a1", "found_but_different"],
      ["2001:db8::77", "rec-a9", "found_but_different"],
    ]);
    expect(result.findings[1].world).toEqual({ before: "198.51.100.10", after: "2001:db8::77,203.0.113.77", changed: true, bytes_unchanged: true });
    const aaaa = result.findings[1].checks.find((c) => c.template === "actor_attributed")!;
    expect(aaaa.holds).toBe(true);
    expect(aaaa.explanation).toContain("touched rec-a9 between");
    expect(tracer.events.filter((e) => e.agent === "checker" && e.input_summary?.startsWith("actor_attributed")).map((e) => e.input_summary)).toEqual([
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
    const { result, tracer } = await pass(bundle, (e) => new RefusingLayer(e));
    expect(result.findings).toHaveLength(1);
    const f = result.findings[0];
    expect(f.checks.map((c) => c.template)).toEqual(["run_complete", "actor_attributed", "other_settings_reference"]);
    expect(f.rejected).toEqual([{ check: expect.objectContaining({ template: "dns_target_in_inventory" }), reason: "dns_target_in_inventory: engine refused this check" }]);
    expect(f.verb).toBe("ESCALATE");
    expect(tracer.events.filter((e) => e.action === "decide").map((e) => e.output_summary)).toEqual(["ESCALATE: 1 check(s) could not be bound from the finding or were refused by the guard"]);
    expect(tracer.events.filter((e) => e.agent === "checker" && e.status === "not_checked").map((e) => [e.input_summary, e.detail]))
      .toEqual([["dns_target_in_inventory", "dns_target_in_inventory: engine refused this check"]]);
  });
});
