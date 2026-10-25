// The example slices (scripts/examples.ts): what each slice keeps of the Decider's tables. Over synthetic rows,
// sliceDeciderRows keeps exactly the approvals, vault copies and disposition rows of the slice's objects and
// records, the validations of those copies, the probes of the slice's names and the tenant's probe runs, and every
// policy rule of the tenant and of "*". Over sample/bundle.json, each of the three slices holds exactly the
// approvals, copies, validations, probes and disposition rows of its own rows, recomputed here from the slice, and
// decides at the full bundle's instant. Offline; nothing is written.
import { describe, expect, it } from "vitest";
import { decisionInstant } from "../src/data/instant.ts";
import type { Tables } from "../src/data/store.ts";
import bundle from "../sample/bundle.json" with { type: "json" };
import { buildExamples, sliceDeciderRows } from "../scripts/examples.ts";

const T = "client-t";
const rows = <K extends keyof Tables>(xs: Record<string, unknown>[]): Tables[K] => xs as unknown as Tables[K];

describe("sliceDeciderRows over synthetic rows", () => {
  const slice: Partial<Tables> = {
    observation: rows<"observation">([
      { object_id: "/etc/nginx/conf.d/a.conf", setting_path: "server[a.example.invalid:443].server_name[a.example.invalid]", refers_to_type: "dns_name", refers_to_id: "a.example.invalid" },
      { object_id: "/etc/nginx/conf.d/a.conf", setting_path: "server[a.example.invalid:443].enabled", refers_to_type: null, refers_to_id: null },
      { object_id: "/etc/nginx/conf.d/a.conf", setting_path: "server[a.example.invalid:443].location[/].proxy_pass", refers_to_type: "dns_name", refers_to_id: "upstream.example.invalid" },
    ]),
    dns_record: rows<"dns_record">([{ record_id: "rec-1", name: "www.example.invalid" }]),
  };
  const source: Partial<Tables> = {
    policy_rule: rows<"policy_rule">([{ rule_id: "rule-1", tenant_id: T }, { rule_id: "rule-2", tenant_id: "*" }, { rule_id: "rule-3", tenant_id: "client-other" }]),
    approved_setting: rows<"approved_setting">([
      { approval_id: "appr-file", tenant_id: T, object_id: "/etc/nginx/conf.d/a.conf" },
      { approval_id: "appr-record", tenant_id: T, object_id: "rec-1" },
      { approval_id: "appr-outside", tenant_id: T, object_id: "/etc/nginx/conf.d/b.conf" },
      { approval_id: "appr-other-tenant", tenant_id: "client-other", object_id: "/etc/nginx/conf.d/a.conf" },
    ]),
    vault_copy: rows<"vault_copy">([
      { copy_id: "copy-file", tenant_id: T, object_id: "/etc/nginx/conf.d/a.conf" },
      { copy_id: "copy-record", tenant_id: T, object_id: "rec-1" },
      { copy_id: "copy-outside", tenant_id: T, object_id: "rec-2" },
      { copy_id: "copy-other-tenant", tenant_id: "client-other", object_id: "rec-1" },
    ]),
    copy_validation: rows<"copy_validation">([
      { validation_id: "val-1", tenant_id: T, copy_id: "copy-file" },
      { validation_id: "val-2", tenant_id: T, copy_id: "copy-file" },
      { validation_id: "val-3", tenant_id: T, copy_id: "copy-record" },
      { validation_id: "val-4", tenant_id: T, copy_id: "copy-outside" },
    ]),
    probe: rows<"probe">([
      { probe_id: "probe-record", tenant_id: T, target: "www.example.invalid" },
      { probe_id: "probe-served", tenant_id: T, target: "a.example.invalid" },
      { probe_id: "probe-upstream", tenant_id: T, target: "upstream.example.invalid" },
      { probe_id: "probe-outside", tenant_id: T, target: "b.example.invalid" },
      { probe_id: "probe-other-tenant", tenant_id: "client-other", target: "a.example.invalid" },
    ]),
    collection_run: rows<"collection_run">([
      { run_id: "run-probe", tenant_id: T, surface: "probe" },
      { run_id: "run-probe-other", tenant_id: "client-other", surface: "probe" },
      { run_id: "run-dns", tenant_id: T, surface: "cloudflare.dns" },
    ]),
    disposition: rows<"disposition">([
      { disposition_id: "disp-file", tenant_id: T, object_id: "/etc/nginx/conf.d/a.conf", verb: "HOLD" },
      { disposition_id: "disp-record", tenant_id: T, object_id: "rec-1", verb: "HOLD" },
      { disposition_id: "disp-record-escalate", tenant_id: T, object_id: "rec-1", verb: "ESCALATE" },
      { disposition_id: "disp-outside", tenant_id: T, object_id: "rec-2", verb: "HOLD" },
      { disposition_id: "disp-other-tenant", tenant_id: "client-other", object_id: "rec-1", verb: "HOLD" },
    ]),
  };

  it("keeps exactly the slice's rows: its objects' and records' approvals, copies and dispositions, those copies' validations, its names' probes, the tenant's probe runs, every rule of the tenant and of *", () => {
    const kept = sliceDeciderRows(source, T, slice);
    const ids = (xs: readonly object[] | undefined, k: string) => (xs ?? []).map((x) => (x as Record<string, string>)[k]);
    expect(ids(kept.policy_rule, "rule_id")).toEqual(["rule-1", "rule-2"]);
    expect(ids(kept.approved_setting, "approval_id")).toEqual(["appr-file", "appr-record"]);
    expect(ids(kept.vault_copy, "copy_id")).toEqual(["copy-file", "copy-record"]);
    expect(ids(kept.copy_validation, "validation_id")).toEqual(["val-1", "val-2", "val-3"]);
    // a proxy_pass referent is no name the slice serves: only dns_record names and server_name referents count
    expect(ids(kept.probe, "probe_id")).toEqual(["probe-record", "probe-served"]);
    expect(ids(kept.collection_run, "run_id")).toEqual(["run-probe"]);
    // every disposition row of the slice's objects and records, whatever its verb
    expect(ids(kept.disposition, "disposition_id")).toEqual(["disp-file", "disp-record", "disp-record-escalate"]);
  });

  it("a slice with no rows keeps the rules and the probe runs and nothing else; a source without the tables gives empty lists", () => {
    const kept = sliceDeciderRows(source, T, {});
    expect([kept.approved_setting, kept.vault_copy, kept.copy_validation, kept.probe, kept.disposition].map((x) => x?.length)).toEqual([0, 0, 0, 0, 0]);
    expect(kept.policy_rule).toHaveLength(2);
    expect(kept.collection_run).toHaveLength(1);
    expect(Object.values(sliceDeciderRows({}, T, slice)).every((x) => Array.isArray(x) && x.length === 0)).toBe(true);
  });
});

describe("the three slices of sample/bundle.json", () => {
  const B = bundle as unknown as Tables;

  it("each holds exactly the approvals, copies, validations, probes and disposition rows of its own rows, recomputed from the slice, and decides at the bundle's instant", async () => {
    const examples = await buildExamples();
    expect(examples.map((e) => e.dir)).toEqual(["proxy-split", "wildcard-no-real-ip", "orphans"]);
    // the proxy split shows two records: their ten approved fields, out of the account's and both hosts' 333 approvals
    const [split] = examples;
    expect([(split.tables.dns_record ?? []).length, (split.tables.approved_setting ?? []).length]).toEqual([2, 10]);
    for (const ex of examples) {
      const t = ex.tables;
      const objects = new Set([...(t.observation ?? []).map((o) => o.object_id), ...(t.dns_record ?? []).map((d) => d.record_id)]);
      const names = new Set([...(t.dns_record ?? []).map((d) => d.name), ...(t.observation ?? []).filter((o) => o.refers_to_type === "dns_name" && o.setting_path.includes(".server_name[")).map((o) => o.refers_to_id)]);
      const approvals = B.approved_setting.filter((a) => objects.has(a.object_id));
      const copies = B.vault_copy.filter((c) => objects.has(c.object_id));
      const copyIds = new Set(copies.map((c) => c.copy_id));
      expect(t.approved_setting ?? [], ex.dir).toEqual(approvals);
      expect(t.vault_copy ?? [], ex.dir).toEqual(copies);
      expect(t.copy_validation ?? [], ex.dir).toEqual(B.copy_validation.filter((v) => copyIds.has(v.copy_id)));
      expect(t.probe ?? [], ex.dir).toEqual(B.probe.filter((p) => names.has(p.target)));
      expect(t.disposition ?? [], ex.dir).toEqual(B.disposition.filter((d) => objects.has(d.object_id)));
      expect(t.policy_rule, ex.dir).toEqual(B.policy_rule);
      // the slice's dispositions carry the latest pass's rows, so the slice decides at the full bundle's instant
      expect(decisionInstant(t), ex.dir).toBe(decisionInstant(bundle));
      console.log(`examples: ${ex.dir}: approved_setting ${(t.approved_setting ?? []).length}/${B.approved_setting.length}, vault_copy ${(t.vault_copy ?? []).length}/${B.vault_copy.length}, copy_validation ${(t.copy_validation ?? []).length}/${B.copy_validation.length}, probe ${(t.probe ?? []).length}/${B.probe.length}, disposition ${(t.disposition ?? []).length}/${B.disposition.length}`);
    }
  }, 60_000);
});
