// The exposure line (src/engine/world.ts, recorded by the decide step of src/pipeline.ts): since when the
// DNS record a finding rests on has been in its current state, dated by SQL over audit_event and the DNS
// run through the DataLayer, the days counted in TypeScript, stored in the World Model as an open
// bitemporal edge finding -> record that a later pass supersedes. The real case is the www record of the
// recorded bundle: proxied off at 21:11:15 and on at 21:12:47 on 2026-04-16 by a named actor, re-pointed at
// 21:47 by an API token, still proxied in the DNS run of 24 Oct.
import { describe, expect, it } from "vitest";
import { DataLayer, assertSelectOnly } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import {
  DriftWorld, EXPOSURE_BEFORE_SQL, EXPOSURE_RECORD_SQL, EXPOSURE_SINCE_SQL, exposureDays, exposureState, measureExposure,
} from "../src/engine/world.ts";
import { runPass, type Finding } from "../src/pipeline.ts";
import recorded from "../sample/bundle.json" with { type: "json" };
import authored from "./fixtures/authored-bundle.json" with { type: "json" };
import { MemTracer } from "./fixtures/mem-tracer.ts";
import { DNS_RUN, T, WWW_RECORD } from "./fixtures/catalogue-params.ts";

type R = typeof recorded;

/** The 21:12:47 update that turned the www record's proxy on; the body still in force. */
const WWW_ON_EVENT = "evt-05fa48325110cdcb";
const DNS_SEEN = "2026-10-24T07:58:55.125Z";
/** host-18efce.ai: proxied off on 3 July, on at 18:01 on 7 July; a proxied_without_real_ip finding on the conf.d host. */
const AI_RECORD = "82de28f7baf86a005babc11f85b45bc4";
/** host-f324df.com: one update (2 July, proxied:true) and nothing earlier, so its line is a bound. */
const F324DF_RECORD = "4c6d209470c71ee2c4668f5f435a4ae1";
/** host-c10fff.com: one update (6 July), the orphan_record whose content line is a bound. */
const C10FFF_RECORD = "25a23b5c40a3de0ea11b6054a7b54d07";

async function layerOf(b: Readonly<Record<string, unknown>>): Promise<DataLayer> {
  const engine = await SqlJsEngine.create();
  engine.loadBundle(b);
  return new DataLayer(engine);
}

async function pass(b: Readonly<Record<string, unknown>>, world = new DriftWorld("test_exposure")) {
  const tracer = new MemTracer("test_exposure", { model: "none" });
  const result = await runPass(await layerOf(b), { tracer, world });
  return { result, tracer, world };
}

const onRecord = (fs: Finding[], rid: string) => fs.filter((f) => f.finding.resource_id === rid);

describe("exposureDays", () => {
  it("counts whole days between two ISO strings, rounding down, and refuses what it cannot count", () => {
    expect(exposureDays("2026-04-16T21:12:47.270Z", DNS_SEEN)).toBe(190);
    expect(exposureDays("2026-10-23T08:00:00.000Z", "2026-10-24T07:59:59.999Z")).toBe(0);
    expect(exposureDays("2026-10-23T08:00:00.000Z", "2026-10-24T08:00:00.000Z")).toBe(1);
    expect(() => exposureDays(DNS_SEEN, "2026-04-16T21:12:47.270Z")).toThrow(RangeError);
    expect(() => exposureDays("16 April", DNS_SEEN)).toThrow(RangeError);
  });
});

describe("measureExposure over the recorded bundle", () => {
  it("the 16 April record: since the proxied=true body of 21:12:47, the first event of the state the DNS run still shows, 190 days, exact", async () => {
    const tracer = new MemTracer("test_exposure", { model: "none" });
    const m = await measureExposure(await layerOf(recorded), { class: "proxy_split", tenant_id: T, resource_id: WWW_RECORD, dns_run_id: DNS_RUN }, { tracer, agent: "decider" });
    expect(m).toEqual({
      dated: true, record_id: WWW_RECORD, field: "proxied", dns_run_id: DNS_RUN, state: "proxied=true",
      since: "2026-04-16T21:12:47.270Z", until: DNS_SEEN, days: 190, bound: "exact", event_id: WWW_ON_EVENT, action: "update",
    });
    // three SELECTs, all traced: the record in the DNS run, the first event of its state, and whether a change into it is on record
    const q = tracer.events.filter((e) => e.action === "query");
    expect(q.map((e) => [e.agent, e.status, e.output_summary])).toEqual([["decider", "ok", "1 rows"], ["decider", "ok", "2 rows"], ["decider", "ok", "1 rows"]]);
  });

  it("re-pointing at 21:47 kept the proxy on, so it does not restart the clock; a body that turns the proxy off later than the DNS run shows it on is a disagreement, not a date", async () => {
    // 21:12 and 21:47 both say proxied=true: the first of the trailing run is 21:12
    const layer = await layerOf(recorded);
    const f = { class: "proxy_split" as const, tenant_id: T, resource_id: WWW_RECORD, dns_run_id: DNS_RUN };
    expect((await measureExposure(layer, f))?.dated).toBe(true);
    const b = structuredClone(recorded) as R;
    const off = b.audit_event.find((e) => e.resource_id === WWW_RECORD && e.occurred_at === "2026-04-16T21:11:15.232Z")!;
    off.occurred_at = "2026-05-01T00:00:00.000Z";
    expect(await measureExposure(await layerOf(b), f)).toEqual({
      dated: false, record_id: WWW_RECORD, field: "proxied", dns_run_id: DNS_RUN,
      reason: `the audit log holds no event on ${WWW_RECORD} that sets proxied=true with no later different body up to ${DNS_SEEN}`,
    });
  });

  it("a class with no exposure line, or a finding that names no record, runs no SQL", async () => {
    const tracer = new MemTracer("test_exposure", { model: "none" });
    const layer = await layerOf(recorded);
    expect(await measureExposure(layer, { class: "orphan_vhost", tenant_id: T, resource_id: null, dns_run_id: DNS_RUN }, { tracer })).toBeNull();
    expect(await measureExposure(layer, { class: "proxy_split", tenant_id: T, resource_id: null, dns_run_id: DNS_RUN }, { tracer })).toBeNull();
    expect(tracer.events).toEqual([]);
  });

  it("the SQL is the portable subset: one guarded SELECT each, no date function, no cast, no function call in a top-level WHERE, the LIKE pattern a parameter", async () => {
    const layer = await layerOf(recorded);
    const params = { tenant_id: T, dns_run_id: DNS_RUN, record_id: WWW_RECORD, until: DNS_SEEN, since: DNS_SEEN, state_exact: '%"proxied":true%', state_like: '%"proxied":true%', field_like: '%"proxied":%' };
    for (const sql of [EXPOSURE_RECORD_SQL, EXPOSURE_SINCE_SQL, EXPOSURE_BEFORE_SQL]) {
      expect(() => assertSelectOnly(layer.render(sql, params))).not.toThrow();
      expect(sql).not.toMatch(/::|\b(date|datetime|julianday|strftime|now|current_date|current_timestamp|datediff|date_add|date_sub|to_date|unix_timestamp|cast)\s*\(/i);
      expect(sql).not.toMatch(/["%]/);
      // the top-level WHERE, the correlated subquery cut out, calls no function
      const where = sql.slice(sql.indexOf("WHERE")).replace(/NOT EXISTS \(SELECT[\s\S]*\)\)\)/, "").replace(/ORDER BY[\s\S]*$/, "");
      expect(where).not.toMatch(/\b(?!in\b|exists\b|and\b|or\b|not\b)[a-z_]+\s*\(/i);
    }
    expect(layer.render(EXPOSURE_SINCE_SQL, params)).toContain(`LIKE '%"proxied":true%'`);
    expect(exposureState("content", { content: "_acme.example.invalid", proxied: "0" })).toEqual({ refused: 'content "_acme.example.invalid" cannot be matched exactly with LIKE' });
    expect(exposureState("content", { content: "ip-6fb86d", proxied: "1" })).toEqual({ label: "content=ip-6fb86d", exact: "ip-6fb86d", like: '%"content":"ip-6fb86d"%', field_like: '%"content":"%' });
    expect(exposureState("proxied", { content: "ip-6fb86d", proxied: "0" })).toMatchObject({ label: "proxied=false", field_like: '%"proxied":%' });
  });

  it("the earlier-body count is field-aware: a prior body that says nothing about the field never makes since exact; one that sets another state of it does; an old_value already in the state keeps the bound", async () => {
    // host-f324df.com: one update, proxied:true, nothing earlier: at least 113 days (the bound the recorded bundle gives)
    const f = { class: "proxied_without_real_ip" as const, tenant_id: T, resource_id: F324DF_RECORD, dns_run_id: DNS_RUN };
    type Event = R["audit_event"][number];
    const template = recorded.audit_event.find((e) => e.resource_id === F324DF_RECORD)!;
    /** The template event with some fields replaced; the JSON import's literal union is widened to one event row. */
    const event = (base: Event, over: { event_id: string; occurred_at: string; new_value: string }): Event => ({ ...base, ...over }) as unknown as Event;
    expect(template.occurred_at).toBe("2026-07-02T21:48:52.906Z");
    expect(await measureExposure(await layerOf(recorded), f)).toMatchObject({ dated: true, since: "2026-07-02T21:48:52.906Z", bound: "at_least" });

    // a content-only edit on 1 June: the field is not named, so the onset is still unknown and the bound stays
    const contentOnly = structuredClone(recorded) as R;
    contentOnly.audit_event.push(event(template, { event_id: "evt-test-content-only", occurred_at: "2026-06-01T00:00:00.000Z", new_value: '{"content":"ip-000000"}' }));
    const tracer = new MemTracer("test_exposure", { model: "none" });
    expect(await measureExposure(await layerOf(contentOnly), f, { tracer })).toMatchObject({ dated: true, since: "2026-07-02T21:48:52.906Z", days: 113, bound: "at_least" });
    expect(tracer.events.filter((e) => e.action === "query")).toHaveLength(3);          // the count ran and found nothing to count

    // a proxied:false body on 1 June: a change into the state is on record, so since is exact
    const wasOff = structuredClone(recorded) as R;
    wasOff.audit_event.push(event(template, { event_id: "evt-test-was-off", occurred_at: "2026-06-01T00:00:00.000Z", new_value: '{"content":"ip-6fb86d","proxied":false}' }));
    expect(await measureExposure(await layerOf(wasOff), f)).toMatchObject({ dated: true, since: "2026-07-02T21:48:52.906Z", days: 113, bound: "exact" });

    // the event's own old_value already carries proxied:true: the state predates the event; at_least, and no count is run
    const sameBefore = structuredClone(recorded) as R;
    const evt = sameBefore.audit_event.find((e) => e.event_id === template.event_id)!;
    evt.old_value = '{"content":"ip-6fb86d","proxied":true}';
    sameBefore.audit_event.push(event(template, { event_id: "evt-test-earlier-off", occurred_at: "2026-06-01T00:00:00.000Z", new_value: '{"proxied":false}' }));
    const t2 = new MemTracer("test_exposure", { model: "none" });
    expect(await measureExposure(await layerOf(sameBefore), f, { tracer: t2 })).toMatchObject({ dated: true, since: "2026-07-02T21:48:52.906Z", bound: "at_least" });
    expect(t2.events.filter((e) => e.action === "query")).toHaveLength(2);

    // the same rule on a content line: an earlier body naming another content is a transition; one naming only proxied is not
    const orphan = { class: "orphan_record" as const, tenant_id: T, resource_id: C10FFF_RECORD, dns_run_id: DNS_RUN };
    const cTemplate = recorded.audit_event.find((e) => e.resource_id === C10FFF_RECORD)!;
    const proxiedOnly = structuredClone(recorded) as R;
    proxiedOnly.audit_event.push(event(cTemplate, { event_id: "evt-test-proxied-only", occurred_at: "2026-06-01T00:00:00.000Z", new_value: '{"proxied":false}' }));
    expect(await measureExposure(await layerOf(proxiedOnly), orphan)).toMatchObject({ dated: true, since: "2026-07-06T18:46:40.994Z", bound: "at_least" });
    const otherContent = structuredClone(recorded) as R;
    otherContent.audit_event.push(event(cTemplate, { event_id: "evt-test-other-content", occurred_at: "2026-06-01T00:00:00.000Z", new_value: '{"content":"ip-000000","proxied":true}' }));
    expect(await measureExposure(await layerOf(otherContent), orphan)).toMatchObject({ dated: true, since: "2026-07-06T18:46:40.994Z", bound: "exact" });
  });
});

describe("the pass records the exposure line", () => {
  it("the finding JSON carries exposure { since, days } for the 16 April record on every finding that rests on it", async () => {
    const { result } = await pass(recorded);
    const line = { since: "2026-04-16T21:12:47.270Z", days: 190, bound: "exact", source: `audit:${WWW_ON_EVENT}`, still_open_in: DNS_RUN };
    const www = onRecord(result.findings, WWW_RECORD);
    expect(www.map((f) => [f.finding.class, f.finding.setting_path, f.exposure])).toEqual([
      ["proxy_split", "proxied", line],
      ["proxied_without_real_ip", expect.stringMatching(/:443\]\.real_ip$/), line],
      ["proxied_without_real_ip", expect.stringMatching(/:80\]\.real_ip$/), line],
    ]);
    expect(JSON.parse(JSON.stringify(www[0])).exposure).toMatchObject({ since: "2026-04-16T21:12:47.270Z", days: 190 });
  });

  it("dates 8 of the 24 findings that rest on a record, says why for the other 16, and spends 34 SELECTs doing it", async () => {
    const { result, tracer } = await pass(recorded);
    const onRecords = result.findings.filter((f) => f.finding.class !== "orphan_vhost");
    expect(onRecords).toHaveLength(24);
    const dated = onRecords.filter((f) => f.exposure);
    expect(dated.map((f) => [f.finding.class, f.finding.dns_name, f.exposure!.since, f.exposure!.days, f.exposure!.bound])).toEqual([
      ["proxy_split", "host-524b42.quest", "2026-04-16T21:12:47.270Z", 190, "exact"],
      ["proxied_without_real_ip", "host-18efce.ai", "2026-07-07T18:01:30.530Z", 108, "exact"],
      ["proxied_without_real_ip", "host-18efce.ai", "2026-07-07T18:01:30.530Z", 108, "exact"],
      ["proxied_without_real_ip", "host-524b42.quest", "2026-04-16T21:12:47.270Z", 190, "exact"],
      ["proxied_without_real_ip", "host-524b42.quest", "2026-04-16T21:12:47.270Z", 190, "exact"],
      // one update with the proxy on and nothing earlier on record: the state may predate the log
      ["proxied_without_real_ip", "host-f324df.com", "2026-07-02T21:48:52.906Z", 113, "at_least"],
      ["proxied_without_real_ip", "host-f324df.com", "2026-07-02T21:48:52.906Z", 113, "at_least"],
      ["orphan_record", "host-c10fff.com", "2026-07-06T18:46:40.994Z", 109, "at_least"],
    ]);
    expect(result.findings.filter((f) => f.finding.class === "orphan_vhost").every((f) => f.exposure === undefined)).toBe(true);
    const triage = tracer.events.filter((e) => e.action === "triage" && e.input_summary?.startsWith("exposure "));
    expect(triage.filter((e) => e.status === "ok")).toHaveLength(8);
    expect(triage.filter((e) => e.status === "not_checked")).toHaveLength(16);
    expect(triage.every((e) => e.agent === "decider" && e.model_requested === "none")).toBe(true);
    expect(triage.find((e) => e.status === "ok")!.output_summary).toBe(`proxied=true since 2026-04-16T21:12:47.270Z: 190 day(s) to ${DNS_SEEN}, still so in DNS run ${DNS_RUN}`);
    // 15 distinct (record, state) pairs: 15 record rows, 15 first-event queries, 4 earlier-body counts
    expect(tracer.events.filter((e) => e.action === "query" && e.agent === "decider" && e.status === "ok")).toHaveLength(15 + 15 + 4);
    // detection, checks and verbs are untouched by the exposure line
    expect(result.findings).toHaveLength(27);
    expect(result.findings.filter((f) => f.verb === "ADOPT")).toHaveLength(5);
  });

  it("the World Model holds it as an open bitemporal edge finding -> record with attrs { since, exposure_days }", async () => {
    const { result, world } = await pass(recorded);
    const split = result.findings.find((f) => f.finding.class === "proxy_split")!;
    const fid = world.findingId(split.finding);
    expect(fid).toBe(`finding:drift:${T}|proxy_split||${WWW_RECORD}|proxied|${WWW_RECORD}`);
    const edge = world.exposureNow(fid)!;
    expect(edge).toMatchObject({
      from: fid, type: "exposure", to: `dns_record:drift:${T}|${WWW_RECORD}@2026-04-16T21:12:47.270Z..${DNS_SEEN}`, validFrom: "2026-04-16T21:12:47.270Z",
      attrs: { since: "2026-04-16T21:12:47.270Z", exposure_days: 190, until: DNS_SEEN, record: world.recordId(T, WWW_RECORD), event_id: WWW_ON_EVENT, dns_run_id: DNS_RUN, bound: "exact" },
    });
    expect(edge.validTo).toBeUndefined();
    // the graph view answers "what exposes this finding now" and "as of a day in May"
    const target = world.world.view("graph").neighborsOf(fid, { via: "exposure" });
    expect(target.map((e) => e.attrs.record)).toEqual([world.recordId(T, WWW_RECORD)]);
    expect(world.world.view("graph").neighborsOf(fid, { via: "exposure", at: "2026-05-01T00:00:00.000Z" })).toHaveLength(1);
    expect(world.world.view("graph").neighborsOf(fid, { via: "exposure", at: "2026-04-16T21:12:00.000Z" })).toEqual([]);
  });

  it("re-running the pass is idempotent on the same rows and supersedes the edge on newer ones: a later DNS observation, then a moved audit event", async () => {
    const world = new DriftWorld("test_exposure_rerun");
    const first = await pass(recorded, world);
    const split = first.result.findings.find((f) => f.finding.class === "proxy_split")!;
    const fid = world.findingId(split.finding);
    const ai = onRecord(first.result.findings, AI_RECORD)[0];
    const aid = world.findingId(ai.finding);
    expect(world.exposureEdges(fid)).toHaveLength(1);

    // the same rows again: the same edge, nothing new, still open
    await pass(recorded, world);
    expect(world.exposureEdges(fid).map((e) => [e.id, e.validTo])).toEqual([[world.exposureNow(fid)!.id, undefined]]);

    // the record observed two days later, still proxied: a new open edge with 192 days, the old one closed and pointing at it
    const later = structuredClone(recorded) as R;
    later.dns_record.find((d) => d.record_id === WWW_RECORD && d.run_id === DNS_RUN)!.observed_at = "2026-10-26T07:58:55.125Z";
    const second = await pass(later, world);
    expect(second.result.findings.find((f) => f.finding.class === "proxy_split")!.exposure).toMatchObject({ since: "2026-04-16T21:12:47.270Z", days: 192 });
    const edges = world.exposureEdges(fid);
    expect(edges).toHaveLength(2);
    const [old, now] = edges;
    expect(now.validTo).toBeUndefined();
    expect(now.attrs).toMatchObject({ since: "2026-04-16T21:12:47.270Z", exposure_days: 192, until: "2026-10-26T07:58:55.125Z" });
    expect(old.supersededBy).toBe(now.id);
    expect(old.validTo).toBe("2026-04-16T21:12:47.270Z"); // same since: the newer reading replaces it over the whole span
    expect(old.attrs).toMatchObject({ exposure_days: 190 });
    expect(world.exposureNow(fid)!.id).toBe(now.id);

    // moving the audit event moves the number: the 7 July proxy-on of host-18efce.ai put at 1 August
    expect(world.exposureNow(aid)!.attrs).toMatchObject({ since: "2026-07-07T18:01:30.530Z", exposure_days: 108 });
    const moved = structuredClone(recorded) as R;
    moved.audit_event.find((e) => e.resource_id === AI_RECORD && e.occurred_at === "2026-07-07T18:01:30.530Z")!.occurred_at = "2026-08-01T00:00:00.000Z";
    const third = await pass(moved, world);
    expect(onRecord(third.result.findings, AI_RECORD).map((f) => f.exposure)).toEqual([
      { since: "2026-08-01T00:00:00.000Z", days: 84, bound: "exact", source: expect.stringMatching(/^audit:evt-/), still_open_in: DNS_RUN },
      { since: "2026-08-01T00:00:00.000Z", days: 84, bound: "exact", source: expect.stringMatching(/^audit:evt-/), still_open_in: DNS_RUN },
    ]);
    const aiEdges = world.exposureEdges(aid);
    expect(aiEdges.map((e) => [e.attrs?.since, e.attrs?.exposure_days, e.validFrom, e.validTo ?? null])).toEqual([
      ["2026-07-07T18:01:30.530Z", 108, "2026-07-07T18:01:30.530Z", "2026-08-01T00:00:00.000Z"],
      ["2026-08-01T00:00:00.000Z", 84, "2026-08-01T00:00:00.000Z", null],
    ]);
  });

  it("a log that carries the plain old and new value dates a content change exactly from one event: the authored fixture's re-pointed record", async () => {
    const { result } = await pass(authored);
    const fbd = result.findings.find((f) => f.finding.class === "found_but_different")!;
    expect(fbd.exposure).toEqual({ since: "2026-10-22T18:42:10.000Z", days: 0, bound: "exact", source: "audit:evt-cf-0001", still_open_in: "run-dns-1023" });
    // the authored www CNAME has no audit event at all: no line, and the trace says why
    expect(result.findings.find((f) => f.finding.class === "proxy_split")!.exposure).toBeUndefined();
  });
});
