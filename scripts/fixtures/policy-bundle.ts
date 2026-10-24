// npx tsx scripts/fixtures/policy-bundle.ts [--check]
//
// Writes the policy_rule rows of test/fixtures/policy-bundle.json: policy/hackathon.json loaded for client-a
// through src/policy/load.ts under the fixture's salt (policy-fixture-salt), in rule_id order, with the rule
// count and the file's version in the fixture's _note. Every other table of the fixture stays as it stands;
// the file is written in the bundle format (src/data/store.ts formatBundle). --check writes nothing and exits 1
// when the committed fixture differs from what this would write. test/pipeline.test.ts holds the committed
// file to policyBundleText().

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatBundle } from "../../src/data/store.ts";
import { loadPolicyFile } from "../../src/policy/load.ts";
import { Redactor } from "../../src/redactor.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const FIXTURE = path.join(ROOT, "test", "fixtures", "policy-bundle.json");
export const POLICY = path.join(ROOT, "policy", "hackathon.json");
export const FIXTURE_TENANT = "client-a";
export const FIXTURE_SALT = "policy-fixture-salt";

/** The fixture's text with its policy_rule rows and note regenerated from the committed policy file. */
export function policyBundleText(current: string = readFileSync(FIXTURE, "utf8")): string {
  const bundle = JSON.parse(current) as Record<string, unknown> & { _note: string };
  const { file, rows } = loadPolicyFile(POLICY, { tenant: FIXTURE_TENANT, redactor: new Redactor(FIXTURE_SALT) });
  const sorted = [...rows].sort((a, b) => (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0));
  const note = bundle._note.replace(/the \d+ rules of policy\/hackathon\.json(?: \(version \d+\))?/, `the ${sorted.length} rules of policy/hackathon.json (version ${file.version})`);
  return formatBundle({ ...bundle, _note: note, policy_rule: sorted });
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() : "";
if (invoked === import.meta.url.toLowerCase()) {
  const current = readFileSync(FIXTURE, "utf8");
  const next = policyBundleText(current);
  if (process.argv.includes("--check")) {
    console.log(next === current ? "policy-bundle: test/fixtures/policy-bundle.json is current" : "policy-bundle: test/fixtures/policy-bundle.json differs from policy/hackathon.json; run npx tsx scripts/fixtures/policy-bundle.ts");
    process.exitCode = next === current ? 0 : 1;
  } else {
    writeFileSync(FIXTURE, next);
    console.log(`policy-bundle: test/fixtures/policy-bundle.json written (${next === current ? "unchanged" : "policy_rule rows regenerated"})`);
  }
}
