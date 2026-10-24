// The point of a tested catalogue: every template renders, passes the SELECT-only guard and runs on
// the sample bundle; the ones the bundle can exercise are asserted row for row.
import { beforeAll, describe, expect, it } from "vitest";
import { DataLayer, assertSelectOnly } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { CATALOGUE, CatalogueError, FINDING_CLASSES, type FindingClass, paramNames, renderTemplate, runCheck, templateById } from "../src/catalogue/templates.ts";
import { BIND, SelectionSchema, defaultChecks, defaultSelection, selectionPrompt, validateSelection, type FindingSummary } from "../src/catalogue/select.ts";
import bundle from "../sample/bundle.json" with { type: "json" };
import { HASH_PW_NO, HASH_PW_YES, SAMPLE, SAMPLE_ROWS, T } from "./fixtures/catalogue-params.ts";

/** The finding the hero query produces, as the detector would summarise it. */
const FBD: FindingSummary = {
  class: "found_but_different",
  tenant_id: T,
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

let dl: DataLayer;
beforeAll(async () => {
  const engine = await SqlJsEngine.create();
  engine.loadBundle(bundle);
  dl = new DataLayer(engine);
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

describe("every template on the sample bundle", () => {
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

describe("specific assertions on the bundle", () => {
  it("dns_target_in_inventory: the changed address is not in inventory, the earlier one was", async () => {
    const now = await runCheck(dl, "dns_target_in_inventory", SAMPLE.dns_target_in_inventory);
    expect(now.result.columns).toEqual(["record_id", "name", "type", "content", "observed_at"]);
    expect(now.result.rows).toEqual([["rec-a1", "app.example.invalid", "A", "203.0.113.77", "2026-10-23T02:05:00.000Z"]]);
    expect(now.holds).toBe(false);
    expect(now.explanation).toBe("app.example.invalid resolves to 1 address the inventory does not know.");
    const before = await runCheck(dl, "dns_target_in_inventory", { ...SAMPLE.dns_target_in_inventory, dns_run_id: "run-dns-1020" });
    expect(before.result.rows).toEqual([]);
    expect(before.holds).toBe(true);
  });

  it("restore_would_regress: finds the approval newer than the latest backup, whose value the backup lacks", async () => {
    const r = await runCheck(dl, "restore_would_regress", SAMPLE.restore_would_regress);
    expect(r.result.columns).toEqual(["approval_id", "object_id", "setting_path", "approved_at", "approved_by", "latest_snapshot_id", "latest_backup_at", "backup_state"]);
    expect(r.result.rows).toEqual([["appr-0003", "/etc/ssh/sshd_config", "PasswordAuthentication", "2026-10-22T15:30:00.000Z", "tech-4e", "snap-restic-0001", "2026-10-21T01:05:00.000Z", "different"]]);
    expect(r.holds).toBe(false);
    expect((await runCheck(dl, "restore_would_regress", { tenant_id: T, host: "host-2b9e" })).holds).toBe(true);
  });

  it("run_complete: the partial run fails the gate, the complete run passes", async () => {
    const bad = await runCheck(dl, "run_complete", { run_id: "run-nginx-2b9e-1023" });
    expect(bad.result.rows).toEqual([["run-nginx-2b9e-1023", "client-a", "linux.nginx", "host-2b9e", "3", "2", "partial"]]);
    expect(bad.holds).toBe(false);
    const ok = await runCheck(dl, "run_complete", { run_id: "run-nginx-7f1c-1023" });
    expect(ok.rowCount).toBe(0);
    expect(ok.holds).toBe(true);
  });

  it("actor_attributed: the Cloudflare change is attributed inside the window and invisible before it", async () => {
    const r = await runCheck(dl, "actor_attributed", SAMPLE.actor_attributed);
    expect(r.result.rows).toEqual([["evt-cf-0001", "cloudflare", "user-3c7d", "rec_set", "198.51.100.10", "203.0.113.77", "2026-10-22T18:42:10.000Z"]]);
    expect(r.holds).toBe(true);
    const early = await runCheck(dl, "actor_attributed", { ...SAMPLE.actor_attributed, until: "2026-10-21T00:00:00.000Z" });
    expect(early.rowCount).toBe(0);
    expect(early.holds).toBe(false);
  });

  it("previous_value_recoverable: the latest event on rec-a1 carries the old address", async () => {
    const r = await runCheck(dl, "previous_value_recoverable", SAMPLE.previous_value_recoverable);
    expect(r.result.columns).toEqual(["event_id", "source", "action", "old_value", "new_value", "occurred_at"]);
    expect(r.result.rows).toEqual([["evt-cf-0001", "cloudflare", "rec_set", "198.51.100.10", "203.0.113.77", "2026-10-22T18:42:10.000Z"]]);
    expect(r.holds).toBe(true);
    expect((await runCheck(dl, "previous_value_recoverable", { tenant_id: T, resource_id: "rec-zz" })).holds).toBe(false);
  });

  it("change_in_last_backup: the live value is not in the latest backup, the previous value is", async () => {
    const live = await runCheck(dl, "change_in_last_backup", SAMPLE.change_in_last_backup);
    expect(live.rowCount).toBe(0);
    expect(live.holds).toBe(false);
    const old = await runCheck(dl, "change_in_last_backup", { ...SAMPLE.change_in_last_backup, value_hash: HASH_PW_YES });
    expect(old.result.rows).toEqual([["snap-restic-0001", "restic", "2026-10-21T01:05:00.000Z", HASH_PW_YES]]);
    expect(old.holds).toBe(true);
  });

  it("referent_unchanged: both kinds of evidence for app, none for www", async () => {
    const app = await runCheck(dl, "referent_unchanged", SAMPLE.referent_unchanged);
    expect(app.result.columns).toEqual(["evidence", "resource_id", "old_value", "new_value", "seen_at"]);
    expect(app.result.rows).toEqual([
      ["audit_event", "rec-a1", "198.51.100.10", "203.0.113.77", "2026-10-22T18:42:10.000Z"],
      ["dns_record", "rec-a1", "198.51.100.10", "203.0.113.77", "2026-10-23T02:05:00.000Z"],
    ]);
    expect(app.holds).toBe(false);
    const www = await runCheck(dl, "referent_unchanged", { ...SAMPLE.referent_unchanged, name: "www.example.invalid" });
    expect(www.rowCount).toBe(0);
    expect(www.holds).toBe(true);
  });

  it("setting_matches_approved: the new sshd value is approved, the old one was not", async () => {
    const now = await runCheck(dl, "setting_matches_approved", SAMPLE.setting_matches_approved);
    expect(now.result.rows).toEqual([["obs-0008", HASH_PW_NO, "appr-0003", "2026-10-22T15:30:00.000Z", "tech-4e"]]);
    expect(now.holds).toBe(true);
    expect((await runCheck(dl, "setting_matches_approved", { ...SAMPLE.setting_matches_approved, run_id: "run-etc-7f1c-1020" })).holds).toBe(false);
  });

  it("host_in_inventory, other_settings_reference, record_reverted, backup_recent", async () => {
    expect((await runCheck(dl, "host_in_inventory", SAMPLE.host_in_inventory)).result.rows).toEqual([["asset-7f1c", "host-7f1c", "198.51.100.10", "vps", "inventory.csv", "2026-10-23T02:10:00.000Z"]]);
    expect((await runCheck(dl, "host_in_inventory", { tenant_id: T, address: "203.0.113.77" })).holds).toBe(false);
    const blast = await runCheck(dl, "other_settings_reference", SAMPLE.other_settings_reference);
    expect(blast.rowCount).toBe(0);
    expect(blast.holds).toBe(true);
    const rev = await runCheck(dl, "record_reverted", SAMPLE.record_reverted);
    expect(rev.rowCount).toBe(0);
    expect(rev.holds).toBe(false);
    expect((await runCheck(dl, "backup_recent", SAMPLE.backup_recent)).result.rows.map((r) => r[0])).toEqual(["snap-etck-0001", "snap-restic-0001"]);
    expect((await runCheck(dl, "backup_recent", { ...SAMPLE.backup_recent, since: "2026-10-22T00:00:00.000Z" })).holds).toBe(false);
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
    const { params, sql } = renderTemplate(dl, "actor_attributed", { ...SAMPLE.actor_attributed, since: "2026-10-20T02:05:00Z", extra: "x" });
    expect(params.since).toBe("2026-10-20T02:05:00.000Z");
    expect(params).not.toHaveProperty("extra");
    expect(sql).toContain("'2026-10-20T02:05:00.000Z'");
  });

  it("a parameter carrying a second statement is one literal at run time: no rows, nothing dropped, and a DMARC-style ';' is data", async () => {
    const r = await runCheck(dl, "host_in_inventory", { tenant_id: T, address: "x'; DROP TABLE observation; --" });
    expect(r.rowCount).toBe(0);
    expect(r.holds).toBe(false);
    expect((await runCheck(dl, "host_in_inventory", { tenant_id: T, address: "v=DMARC1; p=reject" })).rowCount).toBe(0);
    expect((await runCheck(dl, "run_complete", { run_id: "run-nginx-7f1c-1023" })).holds).toBe(true);
  });
});

describe("selection", () => {
  it("validateSelection drops an unknown template and a bad param and keeps a good one, with reasons", () => {
    const v = validateSelection({
      checks: [
        { template: "drop_everything", params: {}, why: "no" },
        { template: "actor_attributed", params: { tenant_id: T, resource_id: "rec-a1", since: "last week", until: "now" }, why: "who" },
        { template: "host_in_inventory", params: { tenant_id: T, address: "203.0.113.77" }, why: "is the new address ours" },
      ],
      other: "whether the TLS certificate still covers the name",
    });
    expect(v.valid).toEqual([{ template: "host_in_inventory", params: { tenant_id: T, address: "203.0.113.77" }, why: "is the new address ours" }]);
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
    const msgs = selectionPrompt(FBD);
    expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
    for (const t of CATALOGUE) expect(msgs[0].content).toContain(`- ${t.id}: `);
    expect(msgs[0].content).toContain("at most 4 checks");
    expect(msgs[0].content).toContain('"other"');
    expect(msgs[0].content).not.toContain("/no_think");
    expect(msgs[1].content).toContain(FBD.summary);
  });

  it("defaultSelection is non-empty per class, within the limit, and names only catalogue templates", () => {
    for (const c of FINDING_CLASSES) {
      const ids = defaultSelection(c as FindingClass);
      expect(ids.length, c).toBeGreaterThan(0);
      expect(ids.length, c).toBeLessThanOrEqual(4);
      expect(ids[0]).toBe("run_complete");
      for (const id of ids) expect(templateById(id), `${c}: ${id}`).toBeDefined();
    }
  });

  it("defaultChecks binds the hero finding and every default check runs on the bundle", async () => {
    const v = defaultChecks(FBD);
    expect(v.rejected).toEqual([]);
    expect(v.valid.map((c) => c.template)).toEqual([...defaultSelection("found_but_different")]);
    const results = await Promise.all(v.valid.map((c) => runCheck(dl, c.template, c.params)));
    expect(results.map((r) => [r.template, r.holds])).toEqual([
      ["run_complete", true],
      ["dns_target_in_inventory", false],
      ["actor_attributed", true],
      ["other_settings_reference", true],
    ]);
  });

  it("defaultChecks says which check a thin finding cannot supply instead of guessing", () => {
    const v = defaultChecks({ ...FBD, dns_run_id: null, resource_id: null });
    expect(v.valid.map((c) => c.template)).toEqual(["run_complete", "other_settings_reference"]);
    expect(v.rejected.map((r) => r.reason)).toEqual([expect.stringMatching(/dns_target_in_inventory: dns_run_id/), expect.stringMatching(/actor_attributed: resource_id/)]);
  });
});
