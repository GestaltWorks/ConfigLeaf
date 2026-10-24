// The point of a tested catalogue: every template renders, passes the SELECT-only guard and runs on the
// recorded bundle (sample/bundle.json, the real estate redacted); the ones the bundle can exercise are
// asserted row for row. The two approval templates have no rows to work on there (no technician has
// signed anything off yet), so they run over the bundle plus approvals added here, in memory, against
// the real file rows and the real export snapshots. The hero finding's default checks keep running over
// the hand-authored fixture (test/fixtures/authored-bundle.json), which is the one bundle that holds it.
import { beforeAll, describe, expect, it } from "vitest";
import { DataLayer, assertSelectOnly } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { CATALOGUE, CatalogueError, FINDING_CLASSES, type FindingClass, paramNames, renderTemplate, runCheck, templateById } from "../src/catalogue/templates.ts";
import { BIND, SelectionSchema, defaultChecks, defaultSelection, selectionPrompt, validateSelection, type FindingSummary } from "../src/catalogue/select.ts";
import bundle from "../sample/bundle.json" with { type: "json" };
import authored from "./fixtures/authored-bundle.json" with { type: "json" };
import { APEX_NAME, DNS_RUN, SITES_HOST, SITES_RUN, QUEST_FILE, QUEST_HASH, SAMPLE, SAMPLE_ROWS, T, WWW_NAME, WWW_RECORD } from "./fixtures/catalogue-params.ts";

/** The hero finding of the authored fixture, as the detector would summarise it. */
const FBD: FindingSummary = {
  class: "found_but_different",
  tenant_id: "client-a",
  run_id: "run-nginx-7f1c-1023",
  surface: "linux.nginx",
  host: "host-7f1c",
  object_id: "/etc/nginx/conf.d/app.conf",
  setting_path: "server.location./.proxy_pass",
  value_hash: "sha256:53ab0295bec8f85ade87d17cd058cea1ecfbcace2956e8ff3810b33a9b48343b",
  value_redacted: "http://app.example.invalid:8080",
  refers_to_type: "dns_name",
  refers_to_id: "app.example.invalid",
  dns_name: "app.example.invalid",
  resolves_to: "203.0.113.77",
  resource_id: "rec-a1",
  dns_run_id: "run-dns-1023",
  since: "2026-10-20T02:01:01.000Z",
  until: "2026-10-23T02:01:01.000Z",
  summary: "proxy_pass unchanged; app.example.invalid now resolves to 203.0.113.77, not in inventory",
};

/** The proxy_split finding of the recorded bundle, as the survey summarises it. */
const SPLIT: FindingSummary = {
  class: "proxy_split",
  tenant_id: T,
  run_id: DNS_RUN,
  surface: "cloudflare.dns",
  host: null,
  object_id: WWW_RECORD,
  setting_path: "proxied",
  value_hash: "sha256:6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
  value_redacted: "1",
  refers_to_type: "dns_name",
  refers_to_id: APEX_NAME,
  dns_name: WWW_NAME,
  resolves_to: "ip-6fb86d",
  resource_id: WWW_RECORD,
  dns_run_id: DNS_RUN,
  since: "2026-03-20T01:29:03.000Z",
  until: "2026-10-24T07:58:55.125Z",
  summary: `${WWW_NAME} is proxied and aliases ${APEX_NAME}, whose A record is direct to ip-6fb86d`,
};

const LATEST_BACKUP_AT = "2026-10-24T03:40:03.985Z";
const FILE_ROW = bundle.observation.find((o) => o.run_id === SITES_RUN && o.object_id === QUEST_FILE && o.setting_path === "file")!;
const OTHER_FILE = bundle.observation.find((o) => o.run_id === SITES_RUN && o.setting_path === "file" && o.object_id === "/etc/nginx/sites-available/host-525a57.com")!;

async function layerOf(b: Readonly<Record<string, unknown>>): Promise<DataLayer> {
  const engine = await SqlJsEngine.create();
  engine.loadBundle(b);
  return new DataLayer(engine);
}

/** The bundle plus two approvals signed after the latest export: one of the live quest file (the backup holds it), one of a value the backup does not hold. */
function withApprovals(): Record<string, unknown> {
  const b = structuredClone(bundle) as unknown as Record<string, unknown[]>;
  b.approved_setting = [
    { approval_id: "appr-quest", tenant_id: T, surface: "linux.nginx", host: SITES_HOST, object_id: QUEST_FILE, setting_path: "file", value_hash: QUEST_HASH, approved_at: "2026-10-24T05:00:00.000Z", approved_by: "tech-4e", note: "Baseline" },
    { approval_id: "appr-other", tenant_id: T, surface: "linux.nginx", host: SITES_HOST, object_id: OTHER_FILE.object_id, setting_path: "file", value_hash: `sha256:${"7".repeat(64)}`, approved_at: "2026-10-24T05:00:00.000Z", approved_by: "tech-4e", note: "A value no backup holds yet" },
  ];
  return b;
}

let dl: DataLayer;
let dlAuthored: DataLayer;
beforeAll(async () => {
  dl = await layerOf(bundle);
  dlAuthored = await layerOf(authored);
});

describe("catalogue shape", () => {
  it("has 10 to 12 templates with unique ids", () => {
    expect(CATALOGUE.length).toBeGreaterThanOrEqual(10);
    expect(CATALOGUE.length).toBeLessThanOrEqual(12);
    expect(new Set(CATALOGUE.map((t) => t.id)).size).toBe(CATALOGUE.length);
  });

  it("names the required templates", () => {
    for (const id of ["host_in_inventory", "dns_target_in_inventory", "change_in_last_backup", "actor_attributed", "previous_value_recoverable", "restore_would_regress", "referent_unchanged", "run_complete", "setting_matches_approved", "other_settings_reference", "record_reverted"]) {
      expect(templateById(id), id).toBeDefined();
    }
  });

  it("every template applies to at least one known class, and every class has a template", () => {
    expect(FINDING_CLASSES).toEqual(["found_but_different", "changed_since_backup", "drift_vs_approved", "dns_change", "proxy_split", "proxied_without_real_ip", "orphan_record", "orphan_vhost"]);
    for (const t of CATALOGUE) {
      expect(t.appliesTo.length, t.id).toBeGreaterThan(0);
      for (const c of t.appliesTo) expect(FINDING_CLASSES).toContain(c);
    }
    for (const c of FINDING_CLASSES) expect(CATALOGUE.some((t) => t.appliesTo.includes(c)), c).toBe(true);
  });

  it("the parameters each SQL names are exactly the parameters its schema declares", () => {
    for (const t of CATALOGUE) {
      const inSql = [...new Set([...t.sql.matchAll(/\{\{p:(\w+)\}\}/g)].map((m) => m[1]))].sort();
      expect(inSql, t.id).toEqual([...paramNames(t)].sort());
      expect(t.sql.includes(";"), t.id).toBe(false);
    }
  });

  it("every parameter in the catalogue can be bound from a finding", () => {
    for (const t of CATALOGUE) for (const k of paramNames(t)) expect(BIND[k], `${t.id}.${k}`).toBeTypeOf("function");
  });
});

describe("every template on the recorded bundle", () => {
  for (const t of CATALOGUE) {
    it(`${t.id}: renders, passes the guard, runs, explains`, async () => {
      const params = SAMPLE[t.id];
      expect(params, `no sample params for ${t.id}`).toBeDefined();
      const { sql } = renderTemplate(dl, t.id, params);
      expect(sql).not.toMatch(/\{\{/);
      expect(() => assertSelectOnly(sql)).not.toThrow();
      const r = await runCheck(dl, t.id, params);
      expect(r.result.columns.length).toBeGreaterThan(0);
      expect(r.result.rows.every((row) => row.length === r.result.columns.length && row.every((v) => typeof v === "string"))).toBe(true);
      expect(r.rowCount).toBe(r.result.total);
      expect(r.rowCount, `${t.id} rows on the bundle`).toBe(SAMPLE_ROWS[t.id]);
      expect(r.holds).toBe(t.rowsMean === "holds" ? r.rowCount > 0 : r.rowCount === 0);
      expect(r.explanation).toMatch(/^[^\n]+\.$/);
      expect(t.explain(params, 0)).not.toBe(t.explain(params, 1));
    });
  }
});

describe("specific assertions on the recorded bundle", () => {
  it("dns_target_in_inventory: every address record of the apex lands on an inventory host; move it and the record is the row", async () => {
    const now = await runCheck(dl, "dns_target_in_inventory", SAMPLE.dns_target_in_inventory);
    expect(now.result.columns).toEqual(["record_id", "name", "type", "content", "observed_at"]);
    expect(now.result.rows).toEqual([]);
    expect(now.holds).toBe(true);
    expect(now.explanation).toBe(`No record of ${APEX_NAME} in run ${DNS_RUN} resolves outside the inventory.`);
    const b = structuredClone(bundle);
    b.dns_record.find((d) => d.name === APEX_NAME && d.type === "A")!.content = "203.0.113.9";
    const moved = await runCheck(await layerOf(b), "dns_target_in_inventory", SAMPLE.dns_target_in_inventory);
    expect(moved.result.rows).toEqual([["f32e72c0d010752462567852ca872d12", APEX_NAME, "A", "203.0.113.9", "2026-10-24T07:58:55.125Z"]]);
    expect(moved.holds).toBe(false);
    expect(moved.explanation).toBe(`${APEX_NAME} resolves to 1 address the inventory does not know.`);
  });

  it("change_in_last_backup: the live vhost file is byte-identical to its copy in the newest export tarball; a changed file would not be", async () => {
    const live = await runCheck(dl, "change_in_last_backup", SAMPLE.change_in_last_backup);
    expect(live.result.columns).toEqual(["snapshot_id", "kind", "taken_at", "value_hash"]);
    expect(live.result.rows).toEqual([[expect.stringMatching(/^snap-[0-9a-f]{16}$/), "export", LATEST_BACKUP_AT, QUEST_HASH]]);
    expect(live.holds).toBe(true);
    const changed = await runCheck(dl, "change_in_last_backup", { ...SAMPLE.change_in_last_backup, value_hash: `sha256:${"7".repeat(64)}` });
    expect(changed.rowCount).toBe(0);
    expect(changed.holds).toBe(false);
    // nine nightly tarballs, one snapshot each, and only the newest counts
    expect(bundle.backup_snapshot.filter((s) => s.host === SITES_HOST).map((s) => s.kind)).toEqual(Array(9).fill("export"));
  });

  it("actor_attributed: the two flips of the www record on 16 April carry the actor's email pseudonym; the API token's later change does not", async () => {
    const r = await runCheck(dl, "actor_attributed", SAMPLE.actor_attributed);
    expect(r.result.columns).toEqual(["event_id", "source", "actor", "action", "old_value", "new_value", "occurred_at"]);
    expect(r.result.rows.map((x) => [x[1], x[2], x[3], x[4], x[6]])).toEqual([
      ["cloudflare", "mail-97a420@domain-503b27", "update", "", "2026-04-16T21:11:15.232Z"],
      ["cloudflare", "mail-97a420@domain-503b27", "update", "", "2026-04-16T21:12:47.270Z"],
    ]);
    expect(r.result.rows.map((x) => JSON.parse(x[5]).proxied)).toEqual([false, true]);
    expect(r.holds).toBe(true);
    const all = bundle.audit_event.filter((e) => e.resource_id === WWW_RECORD).sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1));
    expect(all.map((e) => [e.action, e.actor, e.occurred_at])).toEqual([
      ["update", "mail-97a420@domain-503b27", "2026-04-16T21:11:15.232Z"],
      ["update", "mail-97a420@domain-503b27", "2026-04-16T21:12:47.270Z"],
      ["update", null, "2026-04-16T21:47:29.277Z"],
    ]);
    const early = await runCheck(dl, "actor_attributed", { ...SAMPLE.actor_attributed, until: "2026-04-16T00:00:00.000Z", since: "2026-04-01T00:00:00.000Z" });
    expect(early.rowCount).toBe(0);
    expect(early.holds).toBe(false);
  });

  it("previous_value_recoverable: Cloudflare logs no old values, so the state before the latest change is the latest earlier body (21:12, proxied true); with no earlier body nothing is recoverable", async () => {
    const r = await runCheck(dl, "previous_value_recoverable", SAMPLE.previous_value_recoverable);
    expect(r.result.columns).toEqual(["event_id", "source", "action", "previous_value", "recorded_at", "evidence"]);
    expect(r.result.rows.map((x) => [x[1], x[2], x[4], x[5]])).toEqual([["cloudflare", "update", "2026-04-16T21:12:47.270Z", "earlier_event"]]);
    expect(JSON.parse(r.result.rows[0][3])).toMatchObject({ name: WWW_NAME, proxied: true });
    expect(r.holds).toBe(true);
    // the created record of the apex has no earlier body on record
    expect((await runCheck(dl, "previous_value_recoverable", { tenant_id: T, resource_id: "f32e72c0d010752462567852ca872d12" })).holds).toBe(false);
    // a log that carries old values is read by the first rule, and the row says so
    const old = await runCheck(dlAuthored, "previous_value_recoverable", { tenant_id: "client-a", resource_id: "rec-a1" });
    expect(old.result.rows).toEqual([["evt-cf-0001", "cloudflare", "rec_set", "198.51.100.10", "2026-10-22T18:42:10.000Z", "old_value"]]);
  });

  it("referent_unchanged: the three April events on the www record are the evidence; the apex, untouched, shows none", async () => {
    const www = await runCheck(dl, "referent_unchanged", SAMPLE.referent_unchanged);
    expect(www.result.columns).toEqual(["evidence", "resource_id", "old_value", "new_value", "seen_at"]);
    expect(www.result.rows.map((x) => [x[0], x[1], x[4]])).toEqual([
      ["audit_event", WWW_RECORD, "2026-04-16T21:11:15.232Z"],
      ["audit_event", WWW_RECORD, "2026-04-16T21:12:47.270Z"],
      ["audit_event", WWW_RECORD, "2026-04-16T21:47:29.277Z"],
    ]);
    expect(www.holds).toBe(false);
    const apex = await runCheck(dl, "referent_unchanged", { ...SAMPLE.referent_unchanged, name: APEX_NAME });
    expect(apex.rowCount).toBe(0);
    expect(apex.holds).toBe(true);
  });

  it("record_reverted: the www record was flipped and then re-pointed, never put back; a third event restoring the first body would be", async () => {
    const r = await runCheck(dl, "record_reverted", SAMPLE.record_reverted);
    expect(r.result.columns).toEqual(["change_event_id", "changed_at", "previous_value", "changed_value", "revert_event_id", "reverted_by", "reverted_at"]);
    expect(r.rowCount).toBe(0);
    expect(r.holds).toBe(false);
    const b = structuredClone(bundle);
    const first = b.audit_event.find((e) => e.resource_id === WWW_RECORD && e.occurred_at === "2026-04-16T21:11:15.232Z")!;
    b.audit_event.push({ ...first, event_id: "evt-revert", actor: "mail-97a420@domain-503b27", occurred_at: "2026-04-17T09:00:00.000Z" } as never);
    const reverted = await runCheck(await layerOf(b), "record_reverted", SAMPLE.record_reverted);
    // the 17 April event restores the 21:11 body, which the 21:12 change replaced: that change is reverted. The 21:47
    // change replaced the 21:12 body, which nothing restored, so it is not.
    expect(reverted.result.rows.map((x) => [x[1], x[4], x[5], x[6]])).toEqual([
      ["2026-04-16T21:12:47.270Z", "evt-revert", "mail-97a420@domain-503b27", "2026-04-17T09:00:00.000Z"],
    ]);
    expect(JSON.parse(reverted.result.rows[0][2]).proxied).toBe(false);
    expect(JSON.parse(reverted.result.rows[0][3]).proxied).toBe(true);
    expect(reverted.holds).toBe(true);
    // a log with old values: the authored fixture's change has not been put back
    expect((await runCheck(dlAuthored, "record_reverted", { tenant_id: "client-a", resource_id: "rec-a1", since: "2026-10-20T00:00:00.000Z" })).holds).toBe(false);
  });

  it("restore_would_regress and setting_matches_approved, over approvals added to the recorded rows", async () => {
    const l = await layerOf(withApprovals());
    const regress = await runCheck(l, "restore_would_regress", SAMPLE.restore_would_regress);
    expect(regress.result.columns).toEqual(["approval_id", "object_id", "setting_path", "approved_at", "approved_by", "latest_snapshot_id", "latest_backup_at", "backup_state"]);
    // the approval of the live quest file is not a regression (the newest tarball holds that very hash); the other one is
    expect(regress.result.rows).toEqual([["appr-other", OTHER_FILE.object_id, "file", "2026-10-24T05:00:00.000Z", "tech-4e", expect.stringMatching(/^snap-[0-9a-f]{16}$/), LATEST_BACKUP_AT, "different"]]);
    expect(regress.holds).toBe(false);
    expect((await runCheck(l, "restore_would_regress", { tenant_id: T, host: "host-aa516a" })).holds).toBe(true);
    const match = await runCheck(l, "setting_matches_approved", SAMPLE.setting_matches_approved);
    expect(match.result.rows).toEqual([[FILE_ROW.obs_id, QUEST_HASH, "appr-quest", "2026-10-24T05:00:00.000Z", "tech-4e"]]);
    expect(match.holds).toBe(true);
    expect((await runCheck(l, "setting_matches_approved", { ...SAMPLE.setting_matches_approved, object_id: OTHER_FILE.object_id })).holds).toBe(false);
    // without approvals both say so
    expect((await runCheck(dl, "restore_would_regress", SAMPLE.restore_would_regress)).holds).toBe(true);
    expect((await runCheck(dl, "setting_matches_approved", SAMPLE.setting_matches_approved)).holds).toBe(false);
  });

  it("run_complete: every recorded run passes; a run cut short fails", async () => {
    for (const r of bundle.collection_run) expect((await runCheck(dl, "run_complete", { run_id: r.run_id })).holds, r.run_id).toBe(true);
    const b = structuredClone(bundle);
    const run = b.collection_run.find((r) => r.run_id === SITES_RUN)!;
    run.observed_count = 13;
    run.status = "partial";
    const bad = await runCheck(await layerOf(b), "run_complete", { run_id: SITES_RUN });
    expect(bad.result.rows).toEqual([[SITES_RUN, T, "linux.nginx", SITES_HOST, "14", "13", "partial"]]);
    expect(bad.holds).toBe(false);
  });

  it("host_in_inventory, other_settings_reference, backup_recent", async () => {
    expect((await runCheck(dl, "host_in_inventory", SAMPLE.host_in_inventory)).result.rows).toEqual([[expect.stringMatching(/^asset-[0-9a-f]{16}$/), SITES_HOST, "ip-6fb86d", "vps", "ssh", "2026-10-24T07:59:23.713Z"]]);
    expect((await runCheck(dl, "host_in_inventory", { tenant_id: T, address: "203.0.113.77" })).holds).toBe(false);
    // the www name is also the :80 block's server_name in the same file: one other setting points at it
    const blast = await runCheck(dl, "other_settings_reference", SAMPLE.other_settings_reference);
    expect(blast.result.rows).toEqual([[SITES_HOST, "linux.nginx", QUEST_FILE, `server[${APEX_NAME}:80].server_name[${WWW_NAME}]`, "dns_name", "2026-10-24T07:59:23.713Z"]]);
    expect(blast.holds).toBe(false);
    const recent = await runCheck(dl, "backup_recent", SAMPLE.backup_recent);
    expect(recent.result.rows.map((r) => r[2])).toEqual(["2026-10-20T03:40:02.111Z", "2026-10-21T03:40:06.065Z", "2026-10-22T03:40:06.083Z", "2026-10-23T03:40:06.039Z", LATEST_BACKUP_AT]);
    expect((await runCheck(dl, "backup_recent", { ...SAMPLE.backup_recent, since: "2026-10-25T00:00:00.000Z" })).holds).toBe(false);
  });
});

describe("renderTemplate", () => {
  it("throws a typed error on an unknown id", () => {
    expect(() => renderTemplate(dl, "drop_everything", {})).toThrow(CatalogueError);
    try { renderTemplate(dl, "drop_everything", {}); } catch (e) { expect((e as CatalogueError).code).toBe("unknown_template"); }
  });

  it("throws a typed error on bad params and names the parameter", () => {
    expect(() => renderTemplate(dl, "host_in_inventory", { tenant_id: T })).toThrow(/address/);
    expect(() => renderTemplate(dl, "actor_attributed", { ...SAMPLE.actor_attributed, since: "yesterday" })).toThrow(/since/);
    expect(() => renderTemplate(dl, "change_in_last_backup", { ...SAMPLE.change_in_last_backup, value_hash: "not-a-hash" })).toThrow(/value_hash/);
    try { renderTemplate(dl, "host_in_inventory", {}); } catch (e) { expect((e as CatalogueError).code).toBe("bad_params"); }
  });

  it("normalises timestamps to the millisecond form the collectors write, and strips unknown params", () => {
    const { params, sql } = renderTemplate(dl, "actor_attributed", { ...SAMPLE.actor_attributed, since: "2026-04-16T00:00:00Z", extra: "x" });
    expect(params.since).toBe("2026-04-16T00:00:00.000Z");
    expect(params).not.toHaveProperty("extra");
    expect(sql).toContain("'2026-04-16T00:00:00.000Z'");
  });

  it("a parameter carrying a second statement is one literal at run time: no rows, nothing dropped, and a DMARC-style ';' is data", async () => {
    const r = await runCheck(dl, "host_in_inventory", { tenant_id: T, address: "x'; DROP TABLE observation; --" });
    expect(r.rowCount).toBe(0);
    expect(r.holds).toBe(false);
    expect((await runCheck(dl, "host_in_inventory", { tenant_id: T, address: "v=DMARC1; p=reject" })).rowCount).toBe(0);
    expect((await runCheck(dl, "run_complete", { run_id: SITES_RUN })).holds).toBe(true);
  });
});

describe("selection", () => {
  it("validateSelection drops an unknown template and a bad param and keeps a good one, with reasons", () => {
    const v = validateSelection({
      checks: [
        { template: "drop_everything", params: {}, why: "no" },
        { template: "actor_attributed", params: { tenant_id: T, resource_id: WWW_RECORD, since: "last week", until: "now" }, why: "who" },
        { template: "host_in_inventory", params: { tenant_id: T, address: "ip-6fb86d" }, why: "is the origin ours" },
      ],
      other: "whether the TLS certificate still covers the name",
    });
    expect(v.valid).toEqual([{ template: "host_in_inventory", params: { tenant_id: T, address: "ip-6fb86d" }, why: "is the origin ours" }]);
    expect(v.rejected.map((r) => r.reason)).toEqual([expect.stringMatching(/unknown template: drop_everything/), expect.stringMatching(/actor_attributed: since/)]);
    expect(v.other).toBe("whether the TLS certificate still covers the name");
  });

  it("validateSelection reads the model's raw text, tolerates a missing why, drops duplicates and the seventh check", () => {
    const check = { template: "host_in_inventory", params: { tenant_id: T, address: "198.51.100.10" } };
    const text = "```json\n" + JSON.stringify({ checks: [check, check, ...Array.from({ length: 5 }, (_, i) => ({ ...check, params: { ...check.params, address: `198.51.100.${20 + i}` }, why: "x" }))] }) + "\n```";
    const v = validateSelection(text);
    expect(v.valid).toHaveLength(5);
    expect(v.valid[0].why).toBe("");
    expect(v.rejected.map((r) => r.reason)).toEqual([expect.stringMatching(/duplicate/), expect.stringMatching(/more than 6/)]);
    expect(validateSelection("no json here").rejected).toHaveLength(1);
    expect(validateSelection({ checks: "nope" }).valid).toEqual([]);
  });

  it("the exported schema accepts what the prompt asks for", () => {
    expect(SelectionSchema.safeParse({ checks: [{ template: "run_complete", params: { run_id: "r" }, why: "gate" }] }).success).toBe(true);
    expect(SelectionSchema.safeParse({ checks: Array.from({ length: 7 }, () => ({ template: "run_complete", params: {}, why: "" })) }).success).toBe(false);
  });

  it("selectionPrompt lists every template and the escape hatch", () => {
    const msgs = selectionPrompt(SPLIT);
    expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
    for (const t of CATALOGUE) expect(msgs[0].content).toContain(`- ${t.id}: `);
    expect(msgs[0].content).toContain("at most 4 checks");
    expect(msgs[0].content).toContain('"other"');
    expect(msgs[0].content).not.toContain("/no_think");
    expect(msgs[1].content).toContain(SPLIT.summary);
  });

  it("defaultSelection is non-empty per class, within the limit, and names only catalogue templates that apply to the class", () => {
    for (const c of FINDING_CLASSES) {
      const ids = defaultSelection(c as FindingClass);
      expect(ids.length, c).toBeGreaterThan(0);
      expect(ids.length, c).toBeLessThanOrEqual(4);
      expect(ids[0]).toBe("run_complete");
      for (const id of ids) expect(templateById(id)?.appliesTo, `${c}: ${id}`).toContain(c);
    }
  });

  it("defaultChecks binds the hero finding and every default check runs on the authored fixture", async () => {
    const v = defaultChecks(FBD);
    expect(v.rejected).toEqual([]);
    expect(v.valid.map((c) => c.template)).toEqual([...defaultSelection("found_but_different")]);
    const results = await Promise.all(v.valid.map((c) => runCheck(dlAuthored, c.template, c.params)));
    expect(results.map((r) => [r.template, r.holds])).toEqual([
      ["run_complete", true],
      ["dns_target_in_inventory", false],
      ["actor_attributed", true],
      ["other_settings_reference", true],
    ]);
  });

  it("defaultChecks binds the recorded proxy_split finding: attributed and recoverable, but the name changed inside the window", async () => {
    const v = defaultChecks(SPLIT);
    expect(v.rejected).toEqual([]);
    expect(v.valid.map((c) => c.template)).toEqual(["run_complete", "actor_attributed", "previous_value_recoverable", "referent_unchanged"]);
    const results = await Promise.all(v.valid.map((c) => runCheck(dl, c.template, c.params)));
    expect(results.map((r) => [r.template, r.holds, r.rowCount])).toEqual([
      ["run_complete", true, 0],
      ["actor_attributed", true, 2],
      ["previous_value_recoverable", true, 1],
      ["referent_unchanged", false, 3],
    ]);
  });

  it("defaultChecks says which check a thin finding cannot supply instead of guessing", () => {
    const v = defaultChecks({ ...FBD, dns_run_id: null, resource_id: null });
    expect(v.valid.map((c) => c.template)).toEqual(["run_complete", "other_settings_reference"]);
    expect(v.rejected.map((r) => r.reason)).toEqual([expect.stringMatching(/dns_target_in_inventory: dns_run_id/), expect.stringMatching(/actor_attributed: resource_id/)]);
    const o = defaultChecks({ ...SPLIT, resource_id: null });
    expect(o.valid.map((c) => c.template)).toEqual(["run_complete", "referent_unchanged"]);
    expect(o.rejected).toHaveLength(2);
  });
});
