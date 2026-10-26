// Zetaris's control plane as the surface zetaris.control (src/zetaris/control.ts) over fake statement answers in the
// shapes Zetaris 2.4.3.1 returned on 26 Oct 2026: the objects and the population one read asserts, SHOW GRANT refused
// as not_checked, a failed or short read refused by the gate, the rows and vault files with their hashes and
// redaction. zetaris-json (src/validate/zetaris.ts) over the vault's copies of a run: the shapes the collector writes,
// the recorded hashes, the gaps an index names. Then the whole pass over sql.js with policy/hackathon.json: the approved state passes with no finding on
// the surface, and an edited DQ rule, a dropped entity and a widened grant are each drift_vs_approved (a dropped
// entity also approved_missing), every one ESCALATE under the zetaris.control rule, the edited rule's cause carrying
// the line diff of its canonical JSON. Offline: nothing here reaches Zetaris.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { QueryResult } from "../src/adapters/zetaris.ts";
import type { CopyValidation } from "../src/data/rows.ts";
import { validateCopies, type CopyStore } from "../src/validate/run.ts";
import { ZETARIS_REPO } from "../src/validate/vault.ts";
import { sha256 as validatorSha, shapeIssue, validateControlCopy } from "../src/validate/zetaris.ts";
import { Vault } from "../src/vault/vault.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { MemoryCauseSink, explainTenants } from "../src/explain/explain.ts";
import { runPass } from "../src/pipeline.ts";
import { loadPolicyFile } from "../src/policy/load.ts";
import { resolvePolicy } from "../src/policy/resolve.ts";
import { Redactor } from "../src/redactor.ts";
import { approvalsFor } from "../src/vault/approve.ts";
import {
  CONTROL_HOST, CONTROL_STATEMENTS, CONTROL_SURFACE, absentBecause, canonical, collectControl, controlObjects, controlRows, controlText, notCheckedIn, notCheckedWarnings, readControl, sha256, storeControl,
  type ControlRead, type ControlStore,
} from "../src/zetaris/control.ts";
import { MemTracer } from "./fixtures/mem-tracer.ts";

const T = "client-c";
const POLICY = fileURLToPath(new URL("../policy/hackathon.json", import.meta.url));
const redactor = new Redactor("control-test-salt");
const PRINCIPAL = "AUDITOR@ACME-MSP.NET";

const result = (columns: string[], rows: string[][], total = rows.length): QueryResult => ({ queryId: "q", columns, rows, rowCount: rows.length, total, latencyMs: 1, raw: {} });

const entity = (name: string, columns: string[], activateQuery: string) => ({
  name, columnSpecs: columns.map((c, i) => ({ name: c, dataType: "\"varchar(64)\"", ...(i === 0 ? { primaryKey: { columns: [] } } : {}), notNull: { columns: [] }, dqAnnotations: [], acAnnotations: [] })),
  unique: [], foreignKeys: [], checks: [], ifNotExit: false, namespace: ["lightning", "metastore", "drift", "drift_usl"],
  dqAnnotations: [{ name: `${name}_rule`, expression: "1 = 1", cte: {} }], acAnnotations: [], activateQuery,
});

interface State { entities: string[]; runComplete: string; grants: [string, string][] }
const BASE: State = { entities: ["collection", "copy"], runComplete: "status = 'complete'", grants: [["`DRIFT`.`COLLECTION_RUN`", "SELECT"], ["`DRIFT`.`OBSERVATION`", "SELECT"]] };

/** The seven answers for one state of the control plane. */
function answers(s: State): ControlRead {
  const model = {
    namespace: ["metastore", "drift"], name: "drift_usl",
    tables: s.entities.map((e) => entity(e, [`${e}_id`, "tenant_id"], `SELECT ${e}_id, tenant_id FROM DRIFT.${e}_run`)),
  };
  return {
    entities: result(["name", "type", "usl_id", "count", "activated"], s.entities.map((e) => [e, "table", "", "0", "true"])),
    usl: result(["json"], [[JSON.stringify(model)]]),
    dq: result(["name", "table", "type", "expression"], [
      ["run_id", "collection", "Primary key constraints", ""],
      ["run_complete", "collection", "Custom Data Quality", s.runComplete],
      ...(s.entities.includes("copy") ? [["copy_validated", "copy", "Custom Data Quality", "validated = 1"]] : []),
    ]),
    grants: result(["identifier", "principal_name", "principal_type", "privilege", "grant_option", "grant_at", "grant_by", "canonical_identifier"],
      s.grants.map(([id, priv], i) => [id.replace(/`/g, ""), PRINCIPAL, "USER", priv, "false", `2026-10-24 15:44:38.${100 + i}`, "ADMIN@ACME-MSP.NET", id])),
    datasources: result(["name", "description", "id"], [["DRIFT", "drift-agent app Postgres on the zetaris network", "840"]]),
    lightning: result(["name", "description", "id"], [["CLOUDFLARE", "Cloudflare DNS API", "5683"], ["LESSONS", "memory store", "3966"], ["rules", "policy file", "4010"]]),
    version: result(["version", "build_target", "build_time", "build_tag", "build_hash"], [["2.4.3.1", "production", "10/2/26, 4:30 AM", "2.4.3.1", "cb88df0b"]]),
  };
}

const IDS = ["usl/drift_usl", "usl/drift_usl/collection", "usl/drift_usl/copy", "dq/run_complete", "dq/copy_validated", "grants", `grant/${PRINCIPAL}`, "datasources", "datasource/CLOUDFLARE", "datasource/DRIFT", "datasource/LESSONS", "datasource/rules", "server/version"];

describe("the objects of one read of the control plane", () => {
  it("one object per entity, custom DQ rule, principal, datasource and the server, each listing's count asserted: 13 of 13", () => {
    const s = controlObjects(answers(BASE));
    expect(s.objects.map((o) => o.id)).toEqual(IDS);
    expect(s).toMatchObject({ expected: 13, notChecked: [], failed: [] });
    // an entity is LOAD USL's table without its own DQ annotations; the rule is dq/<rule>
    const collection = s.objects.find((o) => o.id === "usl/drift_usl/collection")!.value as Record<string, unknown>;
    expect(Object.keys(collection).sort()).toEqual(["acAnnotations", "activateQuery", "checks", "columnSpecs", "foreignKeys", "name", "namespace", "unique"]);
    expect(s.objects.find((o) => o.id === "dq/run_complete")!.value).toEqual({ name: "run_complete", table: "collection", type: "Custom Data Quality", expression: "status = 'complete'" });
    // the grant time is left out: a re-grant of the same privilege is the same object
    const regranted = answers(BASE);
    (regranted.grants as QueryResult).rows.forEach((r) => (r[5] = "2026-10-26 01:00:00.000"));
    expect(canonical(controlObjects(regranted).objects.find((o) => o.id === `grant/${PRINCIPAL}`)!.value)).toBe(canonical(s.objects.find((o) => o.id === `grant/${PRINCIPAL}`)!.value));
  });

  it("SHOW GRANT refused: the grants are not_checked with the reason and out of the population; the run is complete", () => {
    const read = { ...answers(BASE), grants: { error: "Zetaris 403: Access Control Read is required" } };
    const s = controlObjects(read);
    expect(s.objects.map((o) => o.id)).toEqual(IDS.filter((i) => !i.startsWith("grant")));
    expect(s.expected).toBe(11);
    expect(s.notChecked).toEqual([{ statement: "grants", reason: "Zetaris 403: Access Control Read is required" }]);
    const c = controlRows(s, redactor, { tenantId: T, startedAt: "2026-10-26T05:00:00.000Z", finishedAt: "2026-10-26T05:00:01.000Z" });
    expect(c.run).toMatchObject({ status: "complete", expected_count: 11, observed_count: 11 });
    expect(controlText(c)).toContain("; grants not_checked: Zetaris 403: Access Control Read is required");
  });

  it("a required statement that fails asserts no population and the run is failed; a listed entity the model lacks, or a listing cut short, leaves it partial", () => {
    const failed = controlRows(controlObjects({ ...answers(BASE), usl: { error: "Zetaris 400: USL not found" } }), redactor, { tenantId: T, startedAt: "2026-10-26T05:00:00.000Z", finishedAt: "2026-10-26T05:00:01.000Z" });
    expect(failed.run).toMatchObject({ status: "failed", expected_count: null });
    const short = answers(BASE);
    short.entities = result(["name", "type"], [["collection", "table"], ["copy", "table"], ["probe", "table"]]);
    expect(controlRows(controlObjects(short), redactor, { tenantId: T, startedAt: "2026-10-26T05:00:00.000Z", finishedAt: "2026-10-26T05:00:01.000Z" }).run).toMatchObject({ status: "partial", expected_count: 14, observed_count: 13 });
    const cut = answers(BASE);
    cut.dq = result((cut.dq as QueryResult).columns, (cut.dq as QueryResult).rows, 5);
    expect(controlObjects(cut).expected).toBe(15);
  });

  it("rows: host zetaris, one definition per object, value_hash sha256 of the raw canonical JSON (the vault file's bytes), the id and the value redacted as the Store redacts them", () => {
    const c = controlRows(controlObjects(answers(BASE)), redactor, { tenantId: T, startedAt: "2026-10-26T05:00:00.000Z", finishedAt: "2026-10-26T05:00:01.000Z" });
    expect(c.run).toMatchObject({ tenant_id: T, surface: CONTROL_SURFACE, host: CONTROL_HOST, status: "complete", expected_count: 13, observed_count: 13 });
    expect(c.observations).toHaveLength(13);
    for (const [i, o] of c.observations.entries()) {
      const f = c.files[i];
      expect(o).toMatchObject({ run_id: c.run.run_id, host: CONTROL_HOST, setting_path: "definition", source: "zetaris", value_hash: sha256(f.bytes), object_id: f.objectId });
      expect(Buffer.from(f.bytes).toString("utf8").endsWith("}\n")).toBe(true);
      // the Store's own redaction changes nothing: the collector redacted first
      expect([redactor.text(o.object_id), redactor.value(o.value_redacted!)]).toEqual([o.object_id, o.value_redacted]);
    }
    const grant = c.observations.find((o) => o.object_id.startsWith("grant/"))!;
    expect(grant.object_id).toMatch(/^grant\/mail-[0-9a-f]{6}@domain-[0-9a-f]{6}$/);
    expect(grant.value_redacted).not.toContain("ACME-MSP");
    expect(c.files.find((f) => f.objectId === grant.object_id)!.path).toBe(`grant/${PRINCIPAL}.json`);
  });

  it("readControl sends the seven statements in order, one each; collectControl redacts a refusal and traces the run once", async () => {
    const sent: string[] = [];
    const a = answers(BASE);
    const client = { query: async (sql: string) => {
      sent.push(sql);
      const k = (Object.keys(CONTROL_STATEMENTS) as (keyof typeof CONTROL_STATEMENTS)[]).find((x) => CONTROL_STATEMENTS[x] === sql)!;
      if (k === "grants") throw new Error("Zetaris 403: denied for owner@acme-msp.net");
      return a[k] as QueryResult;
    } };
    expect(Object.keys(await readControl(client))).toHaveLength(7);
    expect(sent.slice(0, 7)).toEqual([
      "SHOW NAMESPACES OR TABLES IN lightning.metastore.drift.drift_usl", "LOAD USL drift_usl NAMESPACE lightning.metastore.drift", "LIST DQ USL lightning.metastore.drift.drift_usl",
      "SHOW GRANT ON ALL", "SHOW DATASOURCES", "SHOW LIGHTNING DATABASES", "SHOW SERVER VERSION",
    ]);
    const tracer = new MemTracer("control_test", { model: "none" });
    const c = await collectControl(client, redactor, { tenantId: T, tracer, now: () => new Date("2026-10-26T05:00:00.000Z") });
    expect(c.snapshot.notChecked[0].reason).toMatch(/^Zetaris 403: denied for mail-[0-9a-f]{6}@domain-[0-9a-f]{6}$/);
    const lines = tracer.events.filter((e) => e.input_summary === `${CONTROL_SURFACE} tenant ${T}`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ agent: "collector", action: "observe", status: "ok" });
  });

  it("storeControl stores the run as a host's (begin, rows, finish) and calls the vault hook, which is off without a vault", async () => {
    const calls: string[] = [];
    const store: ControlStore = {
      beginRun: async (r) => { calls.push(`begin ${r.run_id} ${r.expected_count}`); },
      insertObservations: async (rows) => (calls.push(`observations ${rows.length}`), rows.length),
      finishRun: async (id, n, status) => { calls.push(`finish ${id} ${n} ${status}`); },
      insertVaultCopies: async () => 0,
    };
    const c = controlRows(controlObjects(answers(BASE)), redactor, { tenantId: T, startedAt: "2026-10-26T05:00:00.000Z", finishedAt: "2026-10-26T05:00:01.000Z" });
    const r = await storeControl(c, store, null, { redactor });
    expect(calls).toEqual([`begin ${c.run.run_id} 13`, "observations 13", `finish ${c.run.run_id} 13 complete`]);
    expect(r).toEqual({ written: 13, hook: { status: "off" } });
  });
});

describe("zetaris-json: the vault's copies of the control plane validated", () => {
  const scratch: string[] = [];
  afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });
  const run = (read: ControlRead = answers(BASE)) => controlRows(controlObjects(read), redactor, { tenantId: T, startedAt: "2026-10-26T05:00:00.000Z", finishedAt: "2026-10-26T05:00:01.000Z" });
  const bytesOf = (v: unknown): Uint8Array => new Uint8Array(Buffer.from(canonical(v), "utf8"));
  const context = (ids: string[], recorded: string | null = null) => ({ ids: new Set(ids), recorded });

  /** One complete run committed by the vault module into a fresh vault outside the checkout; its copies as the hook stores them. */
  function committed(read: ControlRead = answers(BASE)) {
    const dir = mkdtempSync(path.join(tmpdir(), "drift-zetaris-json-"));
    scratch.push(dir);
    const c = run(read);
    const commit = new Vault(dir, redactor).commitRun({ tenantId: T, repo: ZETARIS_REPO, run: c.run, files: c.files });
    const written: CopyValidation[] = [];
    const store: CopyStore = {
      vaultCopies: async (t, sha) => commit.copies.filter((x) => x.tenant_id === t && x.git_commit === sha),
      inventoryAddresses: async () => [],
      insertCopyValidations: async (rows) => (written.push(...rows), rows.length),
    };
    return { dir, c, commit, store, written };
  }

  it("every object the collector writes holds its shape: the writer and the validator agree on all 13", () => {
    const c = run();
    const ids = c.snapshot.objects.map((o) => o.id);
    for (const o of c.snapshot.objects) {
      expect(shapeIssue(o.id, o.value as Record<string, unknown>), o.id).toBeNull();
      expect(validateControlCopy(o.id, bytesOf(o.value), context(ids, validatorSha(bytesOf(o.value)))), o.id).toEqual({ result: "ok", missing_dependencies: [], output: "" });
    }
  });

  it("validate:copies over the Zetaris repository: one zetaris-json row per copy, every one ok, its recorded hash checked", async () => {
    const { dir, commit, store, written } = committed();
    const res = await validateCopies({ vaultDir: dir, tenant: T, zetaris: true, dryRun: false, store, redactor, validatedAt: "2026-10-26T05:10:00.000Z" });
    expect(res.errors).toBe(0);
    expect(res.lines).toEqual([`zetaris @${commit.commit.slice(0, 8)} (run ${commit.copies[0].run_id}): zetaris-json ok, 13 objects (ok 13, ok_with_gaps 0, fail 0), 0 gaps; 13 vault copies of 13 matched`]);
    expect(written.map((r) => [r.copy_id, r.validator, r.result])).toEqual(commit.copies.map((x) => [x.copy_id, "zetaris-json", "ok"]));
    // every repository: the Zetaris one is among them
    expect((await validateCopies({ vaultDir: dir, tenant: T, dryRun: true, store, redactor })).lines.map((l) => l.split(" ")[0])).toEqual(["zetaris"]);
    // a copy row whose recorded hash differs from the commit's bytes fails, that copy alone
    const grant = commit.copies.find((x) => x.object_id.startsWith("grant/"))!;
    const tampered: CopyStore = { ...store, vaultCopies: async (t, sha) => (await store.vaultCopies(t, sha)).map((x) => (x === grant ? { ...x, blob_sha256: `sha256:${"0".repeat(64)}` } : x)) };
    const bad = await validateCopies({ vaultDir: dir, tenant: T, zetaris: true, dryRun: true, store: tampered, redactor, validatedAt: "2026-10-26T05:11:00.000Z" });
    expect(bad.rows.filter((r) => r.result === "fail").map((r) => r.copy_id)).toEqual([grant.copy_id]);
    expect(bad.lines[0]).toContain(`zetaris-json fail, 13 objects (ok 12, ok_with_gaps 0, fail 1)`);
    expect(bad.lines[0]).toContain(`| first fail ${grant.object_id}: the copy's bytes hash to sha256:`);
    expect(bad.lines.join("\n")).not.toContain("ACME-MSP");
    // no store: the shapes are checked and the recorded hashes say they were not
    const bare = await validateCopies({ vaultDir: dir, tenant: T, zetaris: true, dryRun: true, store: null, redactor });
    expect(bare.lines[0]).toContain("zetaris-json ok, 13 objects (ok 13, ok_with_gaps 0, fail 0), 0 gaps; vault copies unknown (no store); recorded hashes unchecked (no store)");
  });

  it("a run with SHOW GRANT refused commits no grant object and validates whole; an index naming an object the commit lacks is a gap", async () => {
    const { dir, store } = committed({ ...answers(BASE), grants: { error: "Zetaris 403: Access Control Read is required" } });
    const res = await validateCopies({ vaultDir: dir, tenant: T, zetaris: true, dryRun: true, store, redactor });
    expect(res.lines[0]).toContain("zetaris-json ok, 11 objects (ok 11, ok_with_gaps 0, fail 0), 0 gaps; 11 vault copies of 11 matched");
    const ids = run().snapshot.objects.map((o) => o.id).filter((i) => i !== "datasource/LESSONS");
    const index = run().snapshot.objects.find((o) => o.id === "datasources")!.value;
    expect(validateControlCopy("datasources", bytesOf(index), context(ids))).toEqual({
      result: "ok_with_gaps", missing_dependencies: ["datasource/LESSONS"],
      output: "datasources names datasource/LESSONS, which the commit does not hold\nno vault_copy row was read (no store), so the recorded hash was not checked",
    });
  });

  it("fails bytes that do not parse, bytes outside the canonical form, a shape the collector does not write and an id it does not use", () => {
    const rule = { name: "run_complete", table: "collection", type: "Custom Data Quality", expression: "status = 'complete'" };
    expect(validateControlCopy("dq/run_complete", new Uint8Array(Buffer.from("{ not json")), context([])).output).toBe("dq/run_complete fails to parse as JSON");
    expect(validateControlCopy("dq/run_complete", new Uint8Array(Buffer.from(JSON.stringify(rule))), context([])).output).toMatch(/^dq\/run_complete is not in the collector's canonical form/);
    expect(validateControlCopy("dq/run_complete", bytesOf({ ...rule, extra: "x" }), context([])).output).toBe("dq/run_complete must hold exactly the strings name run_complete, table, type and expression");
    expect(validateControlCopy("dq/other_rule", bytesOf(rule), context([])).result).toBe("fail");
    expect(validateControlCopy("dq/collection.run_complete", bytesOf(rule), context([])).result).toBe("ok");
    expect(validateControlCopy("datasource/DRIFT", bytesOf({ kind: "odbc", name: "DRIFT", description: "", id: "840" }), context([])).result).toBe("fail");
    expect(validateControlCopy("usl/drift_usl/collection", bytesOf({ name: "collection", columnSpecs: [], dqAnnotations: [] }), context([])).result).toBe("fail");
    expect(validateControlCopy("notes/readme", bytesOf({ a: 1 }), context([])).output).toBe("notes/readme is an object id the zetaris.control collector does not write");
    expect(validateControlCopy("grants", bytesOf(["USER X"]), context([])).output).toBe("grants is JSON of another kind than an object");
  });
});

describe("the pass over the control plane, policy/hackathon.json", () => {
  const rules = loadPolicyFile(POLICY, { tenant: T, redactor }).rows;
  const rule = rules.find((r) => r.surface === CONTROL_SURFACE)!;
  const at = (h: number): string => `2026-10-26T0${h}:00:00.000Z`;
  const rowsOf = (read: ControlRead, h: number) => controlRows(controlObjects(read), redactor, { tenantId: T, startedAt: at(h), finishedAt: at(h).replace(":00.000Z", ":01.000Z") });

  /** One approval of the first state, then a pass over both runs, decided after the second; the surface's findings and their causes. */
  async function passOver(next: ControlRead) {
    const first = rowsOf(answers(BASE), 5);
    const second = rowsOf(next, 7);
    const approvals = approvalsFor(first.observations, { kind: "surface", surface: CONTROL_SURFACE, host: CONTROL_HOST }, "operator", null, at(6));
    const engine = await SqlJsEngine.create();
    engine.loadBundle({ collection_run: [first.run, second.run], observation: [...first.observations, ...second.observations], approved_setting: approvals, policy_rule: rules });
    const layer = new DataLayer(engine);
    const decidedAt = "2026-10-26T07:10:00.000Z";
    const pass = await runPass(layer, { decidedAt, world: new DriftWorld("control_test") });
    const findings = pass.findings.filter((f) => f.finding.surface === CONTROL_SURFACE);
    const causes = (await explainTenants({ decidedAt, findings }, { layer, vault: null, redactor, sink: new MemoryCauseSink(engine) })).flatMap((r) => r.causes);
    engine.close();
    return { approvals, findings, causes, second };
  }

  it("the policy file's zetaris.control rule governs every object of the surface: critical, locked, on drift escalate, alert always", () => {
    expect(rule).toMatchObject({ surface: CONTROL_SURFACE, object_glob: "**", setting_glob: "**", criticality: "critical", lock: 1, on_drift: "escalate", alert: "always" });
    for (const id of IDS) expect(resolvePolicy(rules, { tenant_id: T, surface: CONTROL_SURFACE, object_id: redactor.text(id), setting_path: "definition" })?.rule_id).toBe(rule.rule_id);
  });

  it("the approved state: 13 approvals, and a later run of the same state raises no finding on the surface", async () => {
    const r = await passOver(answers(BASE));
    expect(r.approvals).toHaveLength(13);
    expect(r.findings).toEqual([]);
  });

  it("an edited DQ rule: drift_vs_approved on dq/run_complete, ESCALATE under the zetaris.control rule, the cause's diff the changed expression line", async () => {
    const r = await passOver(answers({ ...BASE, runComplete: "status = 'complete' OR 1 = 1" }));
    expect(r.findings.map((f) => [f.finding.class, f.finding.object_id, f.verb, f.disposition.decided_by, f.disposition.rule_id])).toEqual([
      ["drift_vs_approved", "dq/run_complete", "ESCALATE", "policy", rule.rule_id],
    ]);
    expect(r.findings[0].disposition.reason).toMatch(/^this drift_vs_approved finding stands on dq\/run_complete: live value drifted from approved [0-9a-f]{12}; rule rule-[0-9a-f]{16} \(critical\) sends it to a technician and the agent changes nothing$/);
    const diff = r.causes[0].cause.diff!.split("\n");
    expect(diff.slice(0, 2)).toEqual(["--- approved definition", "+++ live definition"]);
    expect(diff.filter((l) => /^[-+] /.test(l))).toEqual([`-  "expression": "status = 'complete'",`, `+  "expression": "status = 'complete' OR 1 = 1",`]);
  });

  it("a dropped entity: the USL's entity list drifts and the entity is approved_missing, both ESCALATE; a widened grant: the principal's grants drift, ESCALATE", async () => {
    const dropped = await passOver(answers({ ...BASE, entities: ["collection"] }));
    expect(dropped.findings.map((f) => [f.finding.class, f.finding.object_id, f.verb]).sort()).toEqual([
      ["approved_missing", "dq/copy_validated", "ESCALATE"],
      ["approved_missing", "usl/drift_usl/copy", "ESCALATE"],
      ["drift_vs_approved", "usl/drift_usl", "ESCALATE"],
    ]);
    // an entity the run read and found gone names no statement: its reason is the absence alone
    expect(dropped.findings.find((f) => f.finding.object_id === "usl/drift_usl/copy")!.disposition.reason)
      .toMatch(/^this approved_missing finding stands on usl\/drift_usl\/copy: approved [0-9a-f]{12} is absent from the run; rule /);
    const list = dropped.findings.find((f) => f.finding.object_id === "usl/drift_usl")!;
    expect(dropped.causes.find((c) => c.finding_id === list.id)?.cause.diff).toContain(`-    "copy"`);
    const widened = await passOver(answers({ ...BASE, grants: [...BASE.grants, ["`DRIFT`.`APPROVED_SETTING`", "INSERT"]] }));
    expect(widened.findings.map((f) => [f.finding.class, f.finding.object_id, f.verb])).toEqual([["drift_vs_approved", redactor.text(`grant/${PRINCIPAL}`), "ESCALATE"]]);
    expect(widened.causes[0].cause.diff).toContain(`+      "privilege": "INSERT"`);
  });

  it("SHOW GRANT refused after a baseline with grants: both approved grant objects come back approved_missing, ESCALATE, the reason naming the object and the refusal", async () => {
    const refused = await passOver({ ...answers(BASE), grants: { error: "Zetaris 403: Access Control Read is required" } });
    // the baseline approved the grants listing and the one principal's grants
    const grantIds = ["grants", redactor.text(`grant/${PRINCIPAL}`)].sort();
    expect(refused.approvals.map((a) => a.object_id).filter((i) => i.startsWith("grant")).sort()).toEqual(grantIds);
    expect(refused.findings.map((f) => [f.finding.class, f.finding.object_id, f.verb, f.disposition.rule_id]).sort()).toEqual(grantIds.map((i) => ["approved_missing", i, "ESCALATE", rule.rule_id]));
    for (const f of refused.findings) {
      const on = f.finding.object_id.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      expect(f.disposition.reason).toMatch(new RegExp(`^this approved_missing finding stands on ${on}: approved [0-9a-f]{12} is absent from the run \\(SHOW GRANT refused\\); rule rule-[0-9a-f]{16} \\(critical\\) sends it to a technician and the agent changes nothing$`));
    }
    // absentBecause: a grant object of a run that lacks the grants listing, and nothing else
    expect(absentBecause(CONTROL_SURFACE, "grants", refused.second.observations.map((o) => o.object_id))).toBe("SHOW GRANT refused");
    expect(absentBecause(CONTROL_SURFACE, "usl/drift_usl/copy", refused.second.observations.map((o) => o.object_id))).toBeNull();
    expect(absentBecause(CONTROL_SURFACE, redactor.text(`grant/${PRINCIPAL}`), rowsOf(answers(BASE), 5).observations.map((o) => o.object_id))).toBeNull();
    expect(absentBecause("linux.nginx", "grants", [])).toBeNull();
    // what the Store keeps of the refusal: the run lacks the grants listing, so notCheckedIn names the statement and approve warns
    const ids = refused.second.observations.map((o) => o.object_id);
    expect(notCheckedIn(ids, redactor)).toEqual(["grants"]);
    expect(notCheckedIn(rowsOf(answers(BASE), 5).observations.map((o) => o.object_id), redactor)).toEqual([]);
    expect(notCheckedWarnings(refused.second.run.run_id, notCheckedIn(ids, redactor))).toEqual([
      `approve: warning: ${refused.second.run.run_id} did not check SHOW GRANT ON ALL (refused or not run): this sign-off approves no grants, the grants approved before stay the latest approvals, and the pass escalates each of them as approved_missing`,
    ]);
  });
});
