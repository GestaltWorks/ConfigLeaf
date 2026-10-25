// npx tsx scripts/fixtures/policy-bundle.ts [--check]
//
// Writes test/fixtures/policy-bundle.json from the committed fixture: its policy_rule rows are policy/hackathon.json
// loaded for client-a through src/policy/load.ts under the fixture's salt (policy-fixture-salt), in rule_id order,
// with the rule count and the file's version in the fixture's _note; and two cases of the pipeline's build B rows,
// written by key so a second run changes nothing:
//   - approved_missing: /etc/nginx/conf.d/blog.conf on host-7f1c, approved at its 19 Oct bytes, observed in the 20
//     Oct nginx run (whose counts become 4 of 4), committed to the vault in that run with an nginx-t validation ok,
//     held by the newest backup, and absent from the 23 Oct run: the pass rolls it back from the copy.
//   - two HOLD dispositions of an earlier pass, the whole of the fixture's disposition table: the found_but_different
//     setting's (app.conf proxy_pass), decided 21 Oct 03:00 UTC under the catch-all rule and in force until 24 Oct
//     03:00 UTC, and the proxy_split record's (rec-b2 proxied), decided 22 Oct 20:00 UTC under the proxied rule and
//     expired at 23 Oct 00:00 UTC.
// Every other row stays as it stands; the tables it writes into are put in natural-key order (rows.ts KEYS), the
// order they already hold. The file is written in the bundle format (src/data/store.ts formatBundle). --check writes
// nothing and exits 1 when the committed fixture differs from what this would write. test/pipeline.test.ts holds the
// committed file to policyBundleText().

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  KEYS, approvalId, copyId, dispositionId, obsId, validationId,
  type ApprovedSetting, type BackupItem, type CollectionRun, type CopyValidation, type Disposition, type Observation, type PolicyRule, type TableName, type VaultCopy,
} from "../../src/data/rows.ts";
import { formatBundle } from "../../src/data/store.ts";
import { DriftWorld } from "../../src/engine/world.ts";
import { shortFindingId } from "../../src/pipeline.ts";
import { loadPolicyFile } from "../../src/policy/load.ts";
import { Redactor } from "../../src/redactor.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const FIXTURE = path.join(ROOT, "test", "fixtures", "policy-bundle.json");
export const POLICY = path.join(ROOT, "policy", "hackathon.json");
export const FIXTURE_TENANT = "client-a";
export const FIXTURE_SALT = "policy-fixture-salt";

const HOST = "host-7f1c";
const RUN_1020 = "run-nginx-7f1c-1020";
const COMMIT_1020 = "5a14a89d570c37c495c9f1424074a1b9839b5459";
/** The approved_missing case: a vhost file approved, copied and backed up on 20 Oct, absent from the 23 Oct run. */
export const BLOG = "/etc/nginx/conf.d/blog.conf";
export const BLOG_BODY = "server {\n  listen 443 ssl;\n  server_name blog.example.invalid;\n  location / {\n    proxy_pass http://127.0.0.1:5001;\n  }\n}\n";
export const BLOG_HASH = `sha256:${createHash("sha256").update(BLOG_BODY).digest("hex")}`;
const BLOG_APPROVED_AT = "2026-10-19T09:00:00.000Z";
const BLOG_VALIDATED_AT = "2026-10-21T04:00:00.000Z";
/** The two earlier HOLDs: one in force at the tests' decision instant (2026-10-23T03:00:00.000Z), one expired before it. */
export const HOLD_IN_FORCE = { decided_at: "2026-10-21T03:00:00.000Z", expires_at: "2026-10-24T03:00:00.000Z" };
export const HOLD_EXPIRED = { decided_at: "2026-10-22T20:00:00.000Z", expires_at: "2026-10-23T00:00:00.000Z" };

const NOTE = "blog.conf on host-7f1c is approved at its 19 Oct bytes, observed in the 20 Oct run with a vault copy validated ok and held by the newest backup, and absent from the 23 Oct run (approved_missing). The ledger holds two HOLDs of an earlier pass: the found_but_different setting's, decided 21 Oct 03:00 UTC under the catch-all rule and in force until 24 Oct 03:00 UTC, and the proxy_split record's, decided 22 Oct 20:00 UTC under the proxied rule and expired at 23 Oct 00:00 UTC.";

type Bundle = Record<string, unknown> & { _note: string };
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const keyOf = (table: TableName, r: object): string => (KEYS[table] as readonly string[]).map((k) => String((r as Record<string, unknown>)[k] ?? "")).join("\u001f");

/** The table's rows with `add` written by key (a row of the same key replaced), in natural-key order. */
function upsert<T extends object>(bundle: Bundle, table: TableName, add: readonly T[]): T[] {
  const rows = new Map(((bundle[table] as T[] | undefined) ?? []).map((r) => [keyOf(table, r), r]));
  for (const r of add) rows.set(keyOf(table, r), r);
  return [...rows.entries()].sort(([a], [b]) => cmp(a, b)).map(([, r]) => r);
}

/** The build B rows of the fixture, from the rules the policy file gives. */
function buildB(bundle: Bundle, rules: readonly PolicyRule[]): Partial<Record<TableName, object[]>> {
  const ruleFor = (surface: string, objectGlob: string, settingGlob: string): string => {
    const r = rules.find((x) => x.surface === surface && x.object_glob === objectGlob && x.setting_glob === settingGlob);
    if (!r) throw new Error(`policy-bundle: no rule ${surface} ${objectGlob} ${settingGlob} in policy/hackathon.json`);
    return r.rule_id;
  };
  const catchAll = ruleFor("*", "**", "**");
  const proxied = ruleFor("cloudflare.dns", "*", "proxied");

  const runs = (bundle.collection_run as CollectionRun[]).map((r) => (r.run_id === RUN_1020 ? { ...r, expected_count: 4, observed_count: 4 } : r));
  const observation: Observation = {
    obs_id: obsId(RUN_1020, BLOG, "file"), run_id: RUN_1020, tenant_id: FIXTURE_TENANT, surface: "linux.nginx", host: HOST, object_id: BLOG, setting_path: "file",
    value_hash: BLOG_HASH, value_redacted: BLOG_BODY, refers_to_type: null, refers_to_id: null, observed_at: "2026-10-20T02:01:01.000Z", source: "ssh", authority: 100,
  };
  const approval: ApprovedSetting = {
    approval_id: approvalId(FIXTURE_TENANT, HOST, BLOG, "file", BLOG_HASH, BLOG_APPROVED_AT), tenant_id: FIXTURE_TENANT, surface: "linux.nginx", host: HOST,
    object_id: BLOG, setting_path: "file", value_hash: BLOG_HASH, approved_at: BLOG_APPROVED_AT, approved_by: "tech-4e", note: "Baseline after the October review",
  };
  const copy: VaultCopy = {
    copy_id: copyId(RUN_1020, BLOG), tenant_id: FIXTURE_TENANT, surface: "linux.nginx", host: HOST, object_id: BLOG, run_id: RUN_1020,
    git_commit: COMMIT_1020, blob_sha256: BLOG_HASH, taken_at: "2026-10-20T02:01:00.000Z", source: "collector",
  };
  const validation: CopyValidation = {
    validation_id: validationId(copy.copy_id, "nginx-t", BLOG_VALIDATED_AT), copy_id: copy.copy_id, tenant_id: FIXTURE_TENANT, validator: "nginx-t", result: "ok",
    missing_dependencies: "", output_redacted: "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok", validated_at: BLOG_VALIDATED_AT,
  };
  const backup: BackupItem = { snapshot_id: "snap-restic-0001", object_id: BLOG, setting_path: "file", value_hash: BLOG_HASH };

  // The two HOLDs, on the live values the tests' pass decides on: the hero finding's proxy_pass setting and the proxy_split's proxied field.
  const world = new DriftWorld("policy-fixture");
  const fbd = { tenant_id: FIXTURE_TENANT, class: "found_but_different" as const, host: HOST, object_id: "/etc/nginx/conf.d/app.conf", setting_path: "server.location./.proxy_pass", resource_id: "rec-a1" };
  const split = { tenant_id: FIXTURE_TENANT, class: "proxy_split" as const, host: null, object_id: "rec-b2", setting_path: "proxied", resource_id: "rec-b2" };
  const proxyPassHash = (bundle.observation as Observation[]).find((o) => o.run_id === "run-nginx-7f1c-1023" && o.object_id === fbd.object_id && o.setting_path === fbd.setting_path)!.value_hash;
  const hold = (f: typeof fbd | typeof split, surface: string, valueHash: string, runId: string, ruleId: string, criticality: string, at: { decided_at: string; expires_at: string }): Disposition => {
    const findingId = shortFindingId(world.findingId(f));
    return {
      disposition_id: dispositionId(FIXTURE_TENANT, surface, f.host, f.object_id, f.setting_path, valueHash, findingId, runId, at.decided_at), tenant_id: FIXTURE_TENANT, surface,
      host: f.host, object_id: f.object_id, setting_path: f.setting_path, value_hash: valueHash, verb: "HOLD",
      reason: `rule ${ruleId} (${criticality}) holds this ${f.class} finding until ${at.expires_at}`, expires_at: at.expires_at, decided_by: "policy", rule_id: ruleId,
      finding_id: findingId, run_id: runId, decided_at: at.decided_at,
    };
  };
  const holds = [
    hold(fbd, "linux.nginx", proxyPassHash, RUN_1020, catchAll, "normal", HOLD_IN_FORCE),
    hold(split, "cloudflare.dns", `sha256:${createHash("sha256").update("1").digest("hex")}`, "run-dns-1020", proxied, "critical", HOLD_EXPIRED),
  ];

  return {
    collection_run: upsert(bundle, "collection_run", runs),
    observation: upsert(bundle, "observation", [observation]),
    approved_setting: upsert(bundle, "approved_setting", [approval]),
    backup_item: upsert(bundle, "backup_item", [backup]),
    vault_copy: upsert(bundle, "vault_copy", [copy]),
    copy_validation: upsert(bundle, "copy_validation", [validation]),
    disposition: upsert({ ...bundle, disposition: [] }, "disposition", holds),
  };
}

/** The fixture's text with its policy_rule rows, its build B rows and its note regenerated. */
export function policyBundleText(current: string = readFileSync(FIXTURE, "utf8")): string {
  const bundle = JSON.parse(current) as Bundle;
  const { file, rows } = loadPolicyFile(POLICY, { tenant: FIXTURE_TENANT, redactor: new Redactor(FIXTURE_SALT) });
  const sorted = [...rows].sort((a, b) => cmp(a.rule_id, b.rule_id));
  const note = `${bundle._note
    .replace(/the \d+ rules of policy\/hackathon\.json(?: \(version \d+\))?/, `the ${sorted.length} rules of policy/hackathon.json (version ${file.version})`)
    .replace(/ blog\.conf on host-7f1c[\s\S]*$/, "")} ${NOTE}`;
  return formatBundle({ ...bundle, _note: note, policy_rule: sorted, ...buildB(bundle, sorted) });
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() : "";
if (invoked === import.meta.url.toLowerCase()) {
  const current = readFileSync(FIXTURE, "utf8").replace(/\r\n/g, "\n");
  const next = policyBundleText(current);
  if (process.argv.includes("--check")) {
    console.log(next === current ? "policy-bundle: test/fixtures/policy-bundle.json is current" : "policy-bundle: test/fixtures/policy-bundle.json differs from what this script writes; run npx tsx scripts/fixtures/policy-bundle.ts");
    process.exitCode = next === current ? 0 : 1;
  } else {
    writeFileSync(FIXTURE, next);
    console.log(`policy-bundle: test/fixtures/policy-bundle.json written (${next === current ? "unchanged" : "regenerated"})`);
  }
}
