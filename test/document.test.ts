// The owner's document (src/document/render.ts): every read it runs, through sql.js with asserted rows; the page over
// sample/bundle.json, whose numbers are recomputed here from the bundle's own rows and whose committed copy
// (examples/document.md) is held to the render; and the page over test/fixtures/policy-bundle.json with actions and
// tickets added, so every section has rows, and with the explain step's causes under Why; and "Where each answer comes
// from", read off the SQL, which the README carries as npm run sources prints it, and "The semantic layer"
// (src/zetaris/setup.ts uslMarkdown), which the README carries as npm run sources -- --usl prints it. Offline; nothing
// is written.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FINDING_CLASSES } from "../src/catalogue/templates.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { decisionInstant, decisionInstantWith } from "../src/data/instant.ts";
import {
  DOC_ACTIONS_SQL, DOC_COPIES_SQL, DOC_DISPOSITIONS_OF_RUN_SQL, DOC_PROBES_SQL, DOC_PROBE_FAILURES_SQL, DOC_RUN_SHAPE_SQL, DOC_TICKETS_SQL, DOC_UNAPPROVED_SQL, DOC_ZONES_SQL,
  HERO_SQL, PROXIED_WITHOUT_REAL_IP_SQL, objects,
} from "../src/data/queries.ts";
import { TABLE_NAMES } from "../src/data/schema.ts";
import { LIVE_MEASURED, fileSourceRows, renderDocument, sourceOf, sourceRows, sourcesMarkdown, tablesOf } from "../src/document/render.ts";
import { loadSamplePolicy } from "../src/document/sample.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { span } from "../src/explain/cause.ts";
import { BUNDLE_REDACTOR, MemoryCauseSink, explainPass, explainTenants } from "../src/explain/explain.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { dispositionIdOf } from "../src/loop/pass.ts";
import { runPass } from "../src/pipeline.ts";
import { Redactor } from "../src/redactor.ts";
import { DQ_RULES, REST_DB, uslMarkdown, uslRows } from "../src/zetaris/setup.ts";
import sample from "../sample/bundle.json" with { type: "json" };
import policyBundle from "./fixtures/policy-bundle.json" with { type: "json" };
import { BLOG } from "../scripts/fixtures/policy-bundle.ts";

type B = Readonly<Record<string, unknown>>;
const T = "client-1";
const A = "client-a";

/** The bundle into sql.js; the recorded sample with the shipped policy loaded before its passes, as every sample setup path loads it (src/document/sample.ts loadSamplePolicy). */
async function engineOf(b: B): Promise<{ engine: SqlJsEngine; layer: DataLayer }> {
  const engine = await SqlJsEngine.create();
  engine.loadBundle(b);
  if (b === sample) loadSamplePolicy(engine, b as Record<string, unknown>);
  return { engine, layer: new DataLayer(engine) };
}

/** The committed technician's lessons (examples/memory, opened read only): the store npm run document reads with DRIFT_MEMORY_DIR=examples/memory. */
const COMMITTED_STORE = fileURLToPath(new URL("../examples/memory", import.meta.url));
const committedLessons = (): TechnicianMemory => new TechnicianMemory({ storage: "read", directory: COMMITTED_STORE });

/**
 * The pass over the bundle into its own ledger, then the page. With a memory the pass consults its lessons and decides at
 * the bundle's instant or the latest lesson's, whichever is later. With `explain`, the explain step runs over the pass
 * before the render, as scripts/document.ts and scripts/sample.ts run it in sample mode (no vault, BUNDLE_REDACTOR).
 */
async function documentOf(b: B, tenant: string, decidedAt?: string, source?: string, memory?: TechnicianMemory, explain = false) {
  const { engine, layer } = await engineOf(b);
  const at = new Date(decidedAt ?? (memory ? decisionInstantWith(b, memory.lessons().map((l) => l.recordedAt)) : decisionInstant(b)) ?? Date.now()).toISOString();
  const pass = await runPass(layer, { world: new DriftWorld("test_document"), ledger: new MemoryLedger(engine), memory, decidedAt: at });
  const classes = new Map(pass.findings.map((f) => [f.id, f.finding.class as string]));
  const explained = explain ? await explainTenants({ decidedAt: at, findings: pass.findings }, { layer, vault: null, redactor: BUNDLE_REDACTOR, sink: new MemoryCauseSink(engine) }) : [];
  const doc = await renderDocument(layer, { tenant, classes, source });
  return { pass, doc, layer, explained };
}

const section = (md: string, title: string): string => {
  const start = md.indexOf(`## ${title}\n`);
  const end = md.indexOf("\n## ", start + 4);
  return md.slice(start, end < 0 ? undefined : end);
};

describe("the document's reads, through sql.js over test/fixtures/policy-bundle.json", () => {
  const q = async (sql: string, params: Record<string, string>, b: B = policyBundle) => objects(await (await engineOf(b)).layer.run(sql, params, { limit: 100_000 }));

  it("DOC_RUN_SHAPE_SQL: the objects and settings one run observed", async () => {
    expect(await q(DOC_RUN_SHAPE_SQL, { run_id: "run-nginx-7f1c-1023" })).toEqual([{ objects: "4", settings: "8" }]);
    expect(await q(DOC_RUN_SHAPE_SQL, { run_id: "run-dns-1023" })).toEqual([{ objects: "1", settings: "5" }]);
    expect(await q(DOC_RUN_SHAPE_SQL, { run_id: "run-probe-1023" })).toEqual([{ objects: "0", settings: "0" }]);
  });

  it("DOC_ZONES_SQL: the zones of a DNS run with their records, proxied and direct", async () => {
    expect(await q(DOC_ZONES_SQL, { tenant_id: A, dns_run_id: "run-dns-1023" })).toEqual([{ zone: "example.invalid", records: "3", proxied: "1", direct: "2" }]);
    expect(await q(DOC_ZONES_SQL, { tenant_id: "client-b", dns_run_id: "run-dns-1023" })).toEqual([]);
  });

  it("DOC_COPIES_SQL: the copies at each repository's latest commit with their latest validation, a record's zone beside it", async () => {
    const r = await q(DOC_COPIES_SQL, { tenant_id: A });
    expect(r.map((c) => [c.surface, c.host, c.zone, c.object_id, c.run_id, c.git_commit.slice(0, 8), c.result])).toEqual([
      ["linux.nginx", "host-7f1c", "", "/etc/nginx/conf.d/shop.conf", "run-nginx-7f1c-1023", "e4ad517b", ""],
      ["linux.nginx", "host-7f1c", "", "/etc/nginx/conf.d/api.conf", "run-nginx-7f1c-1023", "e4ad517b", ""],
      ["linux.nginx", "host-7f1c", "", "/etc/nginx/conf.d/app.conf.bak", "run-nginx-7f1c-1023", "e4ad517b", ""],
      ["cloudflare.dns", "", "example.invalid", "rec-c3", "run-dns-1020", "88d297bf", "ok"],
      ["linux.nginx", "host-7f1c", "", "/etc/nginx/conf.d/app.conf", "run-nginx-7f1c-1023", "e4ad517b", "ok"],
    ]);
    // a later failed validation of a head copy is its latest
    const failed = structuredClone(policyBundle);
    failed.copy_validation.push({ ...failed.copy_validation.find((v) => v.copy_id === "copy-f720cbf1389a4bca")!, validation_id: "val-later", result: "fail", missing_dependencies: "/etc/nginx/snippets/ssl.conf", validated_at: "2026-10-23T05:00:00.000Z" });
    const app = (await q(DOC_COPIES_SQL, { tenant_id: A }, failed)).find((c) => c.copy_id === "copy-f720cbf1389a4bca");
    expect([app?.validation_id, app?.result, app?.missing_dependencies]).toEqual(["val-later", "fail", "/etc/nginx/snippets/ssl.conf"]);
  });

  it("DOC_UNAPPROVED_SQL: the settings of a run with no approval of their key", async () => {
    expect((await q(DOC_UNAPPROVED_SQL, { tenant_id: A, run_id: "run-dns-1023" })).map((o) => [o.surface, o.host, o.object_id, o.setting_path])).toEqual([
      ["cloudflare.dns", "", "rec-c3", "name"], ["cloudflare.dns", "", "rec-c3", "proxied"], ["cloudflare.dns", "", "rec-c3", "ttl"], ["cloudflare.dns", "", "rec-c3", "type"],
    ]);
    // every file of the nginx run is approved; its other settings are not
    expect((await q(DOC_UNAPPROVED_SQL, { tenant_id: A, run_id: "run-nginx-7f1c-1023" })).map((o) => [o.object_id, o.setting_path])).toEqual([
      ["/etc/nginx/conf.d/api.conf", "server[api.example.invalid:443].server_name[api.example.invalid]"],
      ["/etc/nginx/conf.d/app.conf", "server.listen"],
      ["/etc/nginx/conf.d/shop.conf", "server[shop.example.invalid:443].server_name[shop.example.invalid]"],
    ]);
  });

  it("DOC_DISPOSITIONS_OF_RUN_SQL: the latest disposition of each finding on one run of the tenant, in verb, finding_id order", async () => {
    const fbd = policyBundle.disposition.find((d) => d.surface === "linux.nginx")!;
    const split = policyBundle.disposition.find((d) => d.surface === "cloudflare.dns")!;
    expect((await q(DOC_DISPOSITIONS_OF_RUN_SQL, { tenant_id: A, run_id: "run-nginx-7f1c-1020" })).map((d) => [d.disposition_id, d.verb, d.expires_at])).toEqual([[fbd.disposition_id, "HOLD", fbd.expires_at]]);
    expect((await q(DOC_DISPOSITIONS_OF_RUN_SQL, { tenant_id: A, run_id: "run-dns-1020" })).map((d) => d.disposition_id)).toEqual([split.disposition_id]);
    expect(await q(DOC_DISPOSITIONS_OF_RUN_SQL, { tenant_id: A, run_id: "run-nginx-7f1c-1023" })).toEqual([]);
    expect(await q(DOC_DISPOSITIONS_OF_RUN_SQL, { tenant_id: "client-b", run_id: "run-dns-1020" })).toEqual([]);
    // a later pass over the same run: its row stands for the finding, the earlier one is passed over
    const twice = structuredClone(policyBundle);
    twice.disposition.push({ ...fbd, disposition_id: "disp-later-pass-0001", verb: "ESCALATE", expires_at: null as never, reason: "hold expired", decided_at: "2026-10-24T04:00:00.000Z" });
    expect((await q(DOC_DISPOSITIONS_OF_RUN_SQL, { tenant_id: A, run_id: "run-nginx-7f1c-1020" }, twice)).map((d) => [d.disposition_id, d.verb])).toEqual([["disp-later-pass-0001", "ESCALATE"]]);
  });

  it("DOC_ACTIONS_SQL and DOC_TICKETS_SQL: none in the fixture; the rows added here, counted by kind and status and listed by type and status", async () => {
    expect(await q(DOC_ACTIONS_SQL, { tenant_id: A })).toEqual([]);
    expect(await q(DOC_TICKETS_SQL, { tenant_id: A })).toEqual([]);
    const b = withWork();
    expect(await q(DOC_ACTIONS_SQL, { tenant_id: A }, b)).toEqual([
      { kind: "investigate", status: "done", n: "1" }, { kind: "rollback_file", status: "done", n: "2" }, { kind: "rollback_file", status: "failed", n: "1" },
      { kind: "rollback_file", status: "unverified", n: "1" },
    ]);
    expect((await q(DOC_TICKETS_SQL, { tenant_id: A }, b)).map((t) => [t.ticket_id, t.type, t.status, t.url])).toEqual([
      ["tkt-0000000000000002", "change", "closed", "https://tickets.example.invalid/issues/2"],
      ["tkt-0000000000000001", "incident", "open", "https://tickets.example.invalid/issues/1"],
    ]);
  });

  it("DOC_PROBES_SQL and DOC_PROBE_FAILURES_SQL: the probe run counted by kind and status, and its failing probes", async () => {
    expect(await q(DOC_PROBES_SQL, { tenant_id: A, run_id: "run-probe-1023" })).toEqual([
      { kind: "dns", status: "ok", n: "2" }, { kind: "http", status: "fail", n: "1" }, { kind: "http", status: "ok", n: "1" }, { kind: "tls", status: "ok", n: "2" },
    ]);
    expect(await q(DOC_PROBE_FAILURES_SQL, { tenant_id: A, run_id: "run-probe-1023" })).toEqual([{ kind: "http", target: "shop.example.invalid", probe_id: "probe-4ca33dd4ebff4d77" }]);
    expect(await q(DOC_PROBE_FAILURES_SQL, { tenant_id: A, run_id: "run-dns-1023" })).toEqual([]);
  });
});

/** The policy fixture with five actions (one unverified) and two tickets of the tenant, and one of another tenant. */
function withWork(): Record<string, unknown> {
  const b: Record<string, unknown> = structuredClone(policyBundle);
  const act = (id: string, kind: string, status: string) => ({
    action_id: id, tenant_id: A, kind, target: "/etc/nginx/conf.d/app.conf", before_hash: null, after_hash: null, vault_commit: null, verification: "", receipts: "",
    status, reason: `${kind} ${status}`, record: "", started_at: "2026-10-23T03:05:00.000Z", finished_at: "2026-10-23T03:06:00.000Z", disposition_id: "disp-0000000000000001",
  });
  // one verification probe run of the Actor's, after the pass's probe run: counted apart, never read as the pass's
  const verify = { run_id: "run-probe-verify-0001", tenant_id: A, surface: "probe.verify", host: null, started_at: "2026-10-23T03:05:30.000Z", finished_at: "2026-10-23T03:05:31.000Z", expected_count: 1, observed_count: 1, status: "complete" };
  b.collection_run = [...(b.collection_run as object[]), verify];
  b.probe = [...(b.probe as object[]), {
    probe_id: "probe-verify-0000001", run_id: verify.run_id, tenant_id: A, kind: "http", target: "app.example.invalid", expected: "answers (status below 500); cf-ray any",
    observed: "status 200 server=nginx cf-ray absent", status: "ok", latency_ms: 12, observed_at: "2026-10-23T03:05:31.000Z",
  }];
  b.action = [act("act-1", "rollback_file", "done"), act("act-2", "rollback_file", "done"), act("act-3", "rollback_file", "failed"), act("act-4", "investigate", "done"), act("act-6", "rollback_file", "unverified"), { ...act("act-5", "fix", "refused"), tenant_id: "client-b" }];
  const tkt = (id: string, type: string, status: string, n: number) => ({
    ticket_id: id, tenant_id: A, psa: "github", external_id: String(n), url: `https://tickets.example.invalid/issues/${n}`, type, priority: "P1", status,
    action_id: null, finding_id: "fnd-0000000000000001", created_at: "2026-10-23T03:07:00.000Z", updated_at: "2026-10-23T03:08:00.000Z",
  });
  b.ticket = [tkt("tkt-0000000000000001", "incident", "open", 1), tkt("tkt-0000000000000002", "change", "closed", 2)];
  return b;
}

describe("the page over sample/bundle.json", () => {
  it("is examples/document.md, byte for byte, under the committed lessons, and two renders give the same page", { timeout: 60_000 }, async () => {
    const { doc } = await documentOf(sample, T, undefined, "sql.js over sample/bundle.json", committedLessons(), true);
    const committed = readFileSync(new URL("../examples/document.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(doc.markdown, "examples/document.md is stale: run SAMPLE_MODE=true npm run document -- --tenant client-1 with DRIFT_MEMORY_DIR=examples/memory").toBe(committed);
    expect((await documentOf(sample, T, undefined, "sql.js over sample/bundle.json", committedLessons(), true)).doc.markdown).toBe(doc.markdown);
  });

  it("every number on it is the bundle's: runs, the latest runs' shapes, zones, copies, approvals, findings, probes and the decision instant", { timeout: 60_000 }, async () => {
    const memory = committedLessons();
    const { doc, pass, explained } = await documentOf(sample, T, undefined, undefined, memory, true);
    const md = doc.markdown;
    const runs = sample.collection_run.filter((r) => r.tenant_id === T);
    expect(md).toContain(`${runs.length} collection runs on record, ${runs.length} passing the DQ gate.`);
    // the latest passing run of each host surface and the DNS run, with what it observed
    for (const [surface, host] of [["linux.nginx", "host-aa516a"], ["linux.nginx", "host-4b4dc1"], ["cloudflare.dns", null]] as const) {
      const run = runs.filter((r) => r.surface === surface && r.host === host).sort((a, b) => (a.started_at < b.started_at ? -1 : 1)).at(-1)!;
      const obs = sample.observation.filter((o) => o.run_id === run.run_id);
      expect(md).toContain(`| ${surface} | ${host ?? "-"} | ${run.run_id} | ${run.finished_at} | ${new Set(obs.map((o) => o.object_id)).size} | ${obs.length} |`);
    }
    const dns = runs.filter((r) => r.surface === "cloudflare.dns").sort((a, b) => (a.started_at < b.started_at ? -1 : 1)).at(-1)!;
    const records = sample.dns_record.filter((d) => d.run_id === dns.run_id);
    for (const zone of new Set(records.map((d) => d.zone))) {
      const z = records.filter((d) => d.zone === zone);
      expect(md).toContain(`| ${zone} | ${z.length} | ${z.filter((d) => d.proxied === 1).length} | ${z.filter((d) => d.proxied !== 1).length} |`);
    }
    // the head copies: the tenant's copies of each repository's latest taken_at (the bundle also holds the lab's, tenant lab-1)
    const copies = sample.vault_copy.filter((c) => c.tenant_id === T);
    const repoKey = (c: { surface: string; host: string | null }) => `${c.surface}|${c.host ?? ""}`;
    const heads = copies.filter((c) => !copies.some((x) => repoKey(x) === repoKey(c) && x.taken_at > c.taken_at));
    expect(md).toContain(`${heads.length} vault copies at the latest commit of each repository`);
    expect(md).toContain(`${sample.approved_setting.filter((a) => a.tenant_id === T).length} settings have an approval of record`);
    // an exception in force gives ADOPT until its expiry: the 23 findings the operator's lessons scope are ADOPT, decided by the
    // operator; the three orphan_record findings (no lesson) stay HOLD and the proxy_split ESCALATE, by policy
    expect(pass.memory).toEqual({ lessons: 23, applied: 23, lapsed: 0 });
    expect(pass.verbs).toMatchObject({ ADOPT: 23, HOLD: 3, ESCALATE: 1 });
    for (const f of pass.findings) {
      if (f.exception) expect([f.verb, f.disposition.decided_by, f.exception.status, f.disposition.expires_at], f.id).toEqual(["ADOPT", "operator", "applied", f.exception.expires_at]);
      else expect([f.finding.class, f.disposition.decided_by], f.id).toEqual([f.verb === "HOLD" ? "orphan_record" : "proxy_split", "policy"]);
    }
    // the verbs the pass decided, in the page's order, and one column per verb in the by-class table
    const seen = Object.entries(pass.verbs).filter(([, n]) => n > 0).map(([v]) => v);
    expect(md).toContain(`${pass.findings.length} findings are open on the latest passing runs: ${seen.map((v) => `${v} ${pass.verbs[v as keyof typeof pass.verbs]}`).join(", ")}.`);
    const pwri = pass.findings.filter((f) => f.finding.class === "proxied_without_real_ip");
    expect(md).toContain(`| proxied_without_real_ip | ${seen.map((v) => pwri.filter((f) => f.verb === v).length).join(" | ")} | ${pwri.length} |`);
    for (const f of pass.findings) expect(md).toContain(`- ${f.id} ${f.verb} ${f.finding.class}: `);
    const probeRun = runs.filter((r) => r.surface === "probe").sort((a, b) => (a.started_at < b.started_at ? -1 : 1)).at(-1)!;
    const probes = sample.probe.filter((p) => p.run_id === probeRun.run_id);
    expect(md).toContain(`Probe runs passing the DQ gate: ${runs.filter((r) => r.surface === "probe").length} of surface probe, every served name probed for the pass, and ${runs.filter((r) => r.surface === "probe.verify").length} of surface probe.verify, the Actor's probes after a write.`);
    expect(md).toContain(`Probe run ${probeRun.run_id} (surface probe), finished ${probeRun.finished_at}: ${probes.filter((p) => p.status === "fail").length} probes fail.`);
    expect(md).toContain("| kind | ok | fail | skipped |");
    for (const kind of ["dns", "http", "tls"]) {
      const n = (status: string) => probes.filter((p) => p.kind === kind && p.status === status).length;
      expect(md).toContain(`| ${kind} | ${n("ok")} | ${n("fail")} | ${n("skipped")} |`);
    }
    // the latest decision on the pass's runs: the sample pass's own, at the instant the latest lesson was taught, which is
    // later than the bundle's instant (the latest decided_at the bundle holds): a lesson taught after the recorded pass dates the decision
    const bundleAt = decisionInstant(sample)!;
    expect(bundleAt).toBe(sample.disposition.map((d) => d.decided_at).sort().at(-1));
    const at = memory.lessons().map((l) => l.recordedAt).sort().at(-1)!;
    expect(at > bundleAt).toBe(true);
    expect(decisionInstantWith(sample, memory.lessons().map((l) => l.recordedAt))).toBe(at);
    expect(pass.findings.every((f) => dispositionIdOf(f, at).startsWith("disp-"))).toBe(true);
    expect(md.trimEnd().split("\n").at(-1)).toBe(`Decided at ${at}.`);
    expect([doc.decidedAt, doc.open]).toEqual([at, pass.findings.length]);
    // one inventory line per host: the rows its latest passing run saw, and the older rows the Store keeps
    for (const host of ["host-4b4dc1", "host-aa516a"]) {
      const started = runs.filter((r) => r.surface === "linux.nginx" && r.host === host).map((r) => r.started_at).sort().at(-1)!;
      const assets = sample.inventory_asset.filter((a) => a.tenant_id === T && a.host === host);
      const older = assets.filter((a) => a.observed_at < started).length;
      expect(md).toContain(`- inventory addresses on ${host}: ${assets.length - older} in the latest run, ${older} older row${older === 1 ? "" : "s"} kept`);
    }
    // the explain step over the pass: one cause per finding it explains, the ESCALATE, from the bundle's own rows. The
    // window opens at the record's approval, and every audit_event row on the record is older, so the cause is unknown
    // with the window stated
    const causes = explained.flatMap((r) => r.causes).filter((c) => c.cause.tenant_id === T);
    expect(causes.map((c) => [c.verb, c.finding_class, c.cause.class])).toEqual([["ESCALATE", "proxy_split", "unknown"]]);
    const esc = pass.findings.find((f) => f.verb === "ESCALATE")!;
    const approvedAt = sample.approved_setting.filter((a) => a.tenant_id === T && a.object_id === esc.finding.object_id && a.setting_path === esc.finding.setting_path).map((a) => a.approved_at).sort().at(-1)!;
    expect([causes[0].finding_id, causes[0].cause.window_from, causes[0].cause.window_to]).toEqual([esc.id, approvedAt, at]);
    expect(sample.audit_event.filter((e) => e.resource_id === esc.finding.object_id).every((e) => e.occurred_at < approvedAt)).toBe(true);
    expect(causes[0].cause.summary).toBe(`No record of who changed it: the audit log window of ${span({ from: approvedAt, to: at })} holds 0 events for the record.`);
    expect(section(md, "Findings open")).toContain(`### Why\n\nWho or what changed each setting, from the hosts' journal, the provider's audit log and the agent's own actions (1 finding):\n\n- ${esc.id} ESCALATE proxy_split: ${causes[0].cause.summary}\n`);
    // the Queries section is the queries it ran; a cause is listed, so the Why reads the actions too
    expect(doc.queries.map((c) => c.name)).toEqual([
      "RUNS_SQL", "RUN_COMPLETE_SQL", "DOC_ZONES_SQL", "DOC_RUN_SHAPE_SQL", "DOC_INVENTORY_SQL", "DOC_COPIES_SQL", "LATEST_APPROVALS_SQL", "POLICY_RULES_SQL", "DOC_UNAPPROVED_SQL",
      "DOC_DISPOSITIONS_OF_RUN_SQL", "CAUSES_SQL", "ACTIONS_SQL", "DOC_ACTIONS_SQL", "DOC_TICKETS_SQL", "DOC_PROBES_SQL", "DOC_PROBE_FAILURES_SQL",
    ]);
    for (const c of doc.queries) expect(md).toContain(`- ${c.name}: ${c.runs} run${c.runs === 1 ? "" : "s"}, ${c.rows} row${c.rows === 1 ? "" : "s"}`);
  });

  it("without the explain step the page's Why says no open finding carries a cause", { timeout: 60_000 }, async () => {
    const { doc } = await documentOf(sample, T, undefined, undefined, committedLessons());
    expect(section(doc.markdown, "Findings open")).toContain("### Why\n\nNo open finding carries a cause: the explain step of a cycle records one for each finding it explains.\n");
    expect(doc.queries.map((c) => c.name)).not.toContain("ACTIONS_SQL");
  });

  it("the sample pass raises no approved_missing finding: every approved object of the 19:56 UTC runs is in the latest runs", { timeout: 60_000 }, async () => {
    const { pass, doc } = await documentOf(sample, T, undefined, undefined, committedLessons());
    expect(pass.findings.filter((f) => f.finding.class === "approved_missing")).toEqual([]);
    expect(doc.markdown).toContain("Drift from the approved values: 0 settings differ from their latest approval (drift_vs_approved), 0 approved settings are absent from their run (approved_missing).");
  });
});

describe("the page over test/fixtures/policy-bundle.json with work recorded", () => {
  const AT = "2026-10-23T03:00:00.000Z";

  it("lists the findings open by class and verb, the drift and the absent file, the HOLD expiries, the locked field, the work and the failing probe", async () => {
    const { doc, pass } = await documentOf(withWork(), A, AT);
    const md = doc.markdown;
    expect(doc.open).toBe(pass.findings.length);
    expect(section(md, "Findings open")).toContain("11 findings are open on the latest passing runs: ADOPT 2, HOLD 4, ESCALATE 1, ROLLBACK 3, FIX 1.");
    expect(md).toContain("| approved_missing | 0 | 0 | 0 | 1 | 0 | 1 |");
    expect(md).toContain("| drift_vs_approved | 1 | 1 | 0 | 2 | 1 | 5 |");
    expect(md).toContain("Drift from the approved values: 5 settings differ from their latest approval (drift_vs_approved), 1 approved setting is absent from its run (approved_missing).");
    expect(md).toContain("- 2026-10-24T03:00:00.000Z: 4 (changed_since_backup 2, drift_vs_approved 1, found_but_different 1)");
    expect(md).toContain(`ROLLBACK approved_missing: file in ${BLOG} on host-7f1c (linux.nginx, run run-nginx-7f1c-1023). approved `);
    // the fixture's two earlier HOLDs sit on the 20 Oct runs, which are not the latest
    for (const d of policyBundle.disposition) expect(md).not.toContain(d.disposition_id);
    expect(md).toContain("Locked settings without an approved value: 1.");
    expect(md).toContain("- proxied in rec-c3 (cloudflare.dns), locked by rule-8e75e1d767980665");
    expect(section(md, "Work")).toContain("| rollback_file | failed | 1 |");
    expect(section(md, "Work")).toContain("| rollback_file | unverified | 1 |");
    expect(section(md, "Work")).toContain("Unverified writes: 1, each completed with no verification probe run or read; the change ticket of such a write stays open until a pass finds its setting at the approved value.");
    expect(section(md, "Work")).toContain("| incident | open | 1 |");
    expect(section(md, "Work")).toContain("- incident P1 open: https://tickets.example.invalid/issues/1 (github #1, finding fnd-0000000000000001)");
    expect(section(md, "Probes")).toContain("- http: shop.example.invalid");
    expect(section(md, "Probes")).toContain("Probe runs passing the DQ gate: 1 of surface probe, every served name probed for the pass, and 1 of surface probe.verify, the Actor's probes after a write.");
    expect(section(md, "Probes")).toContain("Probe run run-probe-1023 (surface probe), finished ");
    expect(section(md, "Estate")).not.toContain("probe.verify");
    expect(section(md, "Copies")).toContain("| records, zone example.invalid | 88d297bf | 1 | 1 | 0 | 0 | 0 |");
    expect(section(md, "Copies")).toContain("| host-7f1c (linux.nginx) | e4ad517b | 4 | 1 | 0 | 0 | 3 |");
    expect(md.trimEnd().split("\n").at(-1)).toBe(`Decided at ${AT}.`);
  });

  it("lists under Why each open finding's cause, the explain step's sentence, with the time to the restore once the agent's rollback wrote", async () => {
    const { engine, layer } = await engineOf(policyBundle);
    const pass = await runPass(layer, { world: new DriftWorld("test_document_why"), ledger: new MemoryLedger(engine), decidedAt: AT });
    const app = pass.findings.find((f) => f.verb === "ROLLBACK" && f.finding.object_id === "/etc/nginx/conf.d/app.conf")!;
    // the host's journal: a login, then a sudo tee of the file eight minutes before the pass
    engine.insertRows("audit_event", [
      { event_id: "evt-login-0000001", tenant_id: A, source: "journal", actor: "user-3f2a1c", action: "ssh_login", resource_type: "session", resource_id: null, old_value: "ip-7c1d2e", new_value: "publickey on host-7f1c", occurred_at: "2026-10-23T02:40:00.000Z" },
      { event_id: "evt-tee-00000001", tenant_id: A, source: "journal", actor: "user-3f2a1c", action: "tee", resource_type: "file", resource_id: app.finding.object_id, old_value: null, new_value: `/usr/bin/tee -- ${app.finding.object_id} on host-7f1c`, occurred_at: "2026-10-23T02:52:07.000Z" },
    ]);
    const explained = await explainPass({ tenant: A, decidedAt: AT, findings: pass.findings }, { layer, vault: null, redactor: new Redactor("document-test-salt", []), sink: new MemoryCauseSink(engine) });
    const own = dispositionIdOf(app, AT);
    expect(explained.causes.find((c) => c.disposition_id === own)?.cause.class).toBe("operator_edit");
    engine.insertRows("action", [{
      action_id: "act-why-0000000001", tenant_id: A, kind: "rollback_file", target: `linux.nginx host-7f1c ${app.finding.object_id} file`, before_hash: null, after_hash: null, vault_commit: null,
      verification: "probe-1", receipts: "", status: "done", reason: "restored", record: "", started_at: "2026-10-23T03:05:00.000Z", finished_at: "2026-10-23T03:05:04.000Z", disposition_id: own,
    }]);
    const doc = await renderDocument(layer, { tenant: A, classes: new Map(pass.findings.map((f) => [f.id, f.finding.class])) });
    const why = section(doc.markdown, "Findings open").split("### Why\n")[1];
    expect(why).toContain(`Who or what changed each setting, from the hosts' journal, the provider's audit log and the agent's own actions (${explained.causes.length} findings):`);
    expect(why).toContain(`- ${app.id} ROLLBACK drift_vs_approved: The file was changed at 02:52 UTC by user-3f2a1c over ssh from ip-7c1d2e (sudo tee), 13 minutes before the agent restored it.\n`);
    for (const c of explained.causes.filter((x) => x.disposition_id !== own)) expect(why).toContain(`- ${c.finding_id} ${c.verb} ${c.finding_class}: ${c.cause.summary}\n`);
    expect(doc.queries.map((q) => q.name)).toEqual(expect.arrayContaining(["CAUSES_SQL", "ACTIONS_SQL"]));
    expect(doc.markdown).toContain(`- CAUSES_SQL: 1 run, ${explained.causes.length} rows`);
    engine.close();
  });

  it("counts the skipped probes of the probe run beside ok and fail, and a skipped probe is no failing name", async () => {
    const b = withWork();
    // the tls probe of an override target: recorded skipped (src/probe/rules.ts TLS_SKIPPED)
    b.probe = [...(b.probe as object[]), {
      probe_id: "probe-skipped-000001", run_id: "run-probe-1023", tenant_id: A, kind: "tls", target: "lab.example.invalid", expected: "valid for the name, more than 7 days left",
      observed: "skipped: no TLS on this target", status: "skipped", latency_ms: 0, observed_at: "2026-10-23T02:20:05.000Z",
    }];
    const probes = section((await documentOf(b, A, AT)).doc.markdown, "Probes");
    expect(probes).toContain("| kind | ok | fail | skipped |");
    expect(probes).toContain("| dns | 2 | 0 | 0 |");
    expect(probes).toContain("| http | 1 | 1 | 0 |");
    expect(probes).toContain("| tls | 2 | 0 | 1 |");
    expect(probes).toContain(": 1 probe fails.");
    expect(probes).not.toContain("lab.example.invalid");
  });

  it("with no classes the open findings carry no class, and a disposition whose finding the pass leaves unraised is counted apart", async () => {
    const { engine, layer } = await engineOf(policyBundle);
    await runPass(layer, { world: new DriftWorld("test_document_plain"), ledger: new MemoryLedger(engine), decidedAt: AT });
    const plain = (await renderDocument(layer, { tenant: A })).markdown;
    expect(plain).toContain("| - | 2 | 4 | 1 | 3 | 1 | 11 |");
    const partial = (await renderDocument(layer, { tenant: A, classes: new Map([["fnd-9a617e96adfb2ce4", "approved_missing"]]) })).markdown;
    expect(partial).toContain("1 finding is open on the latest passing runs: ROLLBACK 1.");
    expect(partial).toContain("10 dispositions on these runs concern a finding the pass leaves unraised at render time.");
  });

  it("a tenant with no rows gets a page that says so in every section", async () => {
    const { layer } = await engineOf(policyBundle);
    const md = (await renderDocument(layer, { tenant: "client-z" })).markdown;
    expect(md).toContain("0 collection runs on record, 0 passing the DQ gate. 0 hosts and 0 zones in the latest passing runs.");
    expect(md).toContain("The vault holds no copy for client-z.");
    expect(md).toContain("No setting of client-z has an approval of record.");
    expect(md).toContain("The latest passing runs carry no open finding for client-z.");
    expect(md).toContain("No action is recorded for client-z.");
    expect(md).toContain("No probe run of client-z passes the DQ gate.");
    expect(md.trimEnd().split("\n").at(-1)).toBe("No decision of client-z is on the latest passing runs.");
  });
});

describe("where each answer comes from", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  /** The block between a heading and the next ## heading, trimmed. */
  const block = (md: string, heading: string): string => {
    const start = md.indexOf(`\n${heading}\n`);
    expect(start, `${heading} is missing`).toBeGreaterThanOrEqual(0);
    const body = md.slice(start + heading.length + 2);
    const end = body.indexOf("\n## ");
    return (end < 0 ? body : body.slice(0, end)).trim();
  };

  it("one row per class the pass raises; each joins two or more sources; every table it names is in sql/schema.sql and has a source", () => {
    const rows = sourceRows();
    // m365_mail_record (Microsoft 365's mail records against the zones) joins this table with the README rewrite, which owns
    // src/document; the class's two sources are the m365.dns observation rows and Cloudflare's dns_record.
    const notYet = new Set(["m365_mail_record"]);
    expect(rows.map((r) => r.cls).sort()).toEqual(FINDING_CLASSES.filter((c) => !notYet.has(c)).sort());
    for (const r of rows) {
      expect(r.sources.length, r.cls).toBeGreaterThanOrEqual(2);
      expect(r.checks[0], r.cls).toBe("run_complete");
      for (const t of r.tables) {
        expect(TABLE_NAMES, `${r.cls} names ${t}`).toContain(t);
        expect(sourceOf(t), `${r.cls} names ${t}, which no source holds`).toBeDefined();
      }
    }
  });

  it("the tables are read off the SQL text: the hero query, the survey's two real_ip queries, the record lists' audit checks", () => {
    expect(tablesOf(HERO_SQL)).toEqual(["observation", "dns_record", "inventory_asset"]);
    expect(tablesOf(PROXIED_WITHOUT_REAL_IP_SQL)).toEqual(["dns_record", "inventory_asset", "observation"]);
    const row = (cls: string) => sourceRows().find((r) => r.cls === cls)!;
    expect(row("found_but_different").sources).toEqual(["live state", "DNS", "audit log", "inventory", "populations"]);
    expect(row("changed_since_backup").tables).toEqual(["collection_run", "observation", "approved_setting", "backup_snapshot", "backup_item"]);
    // drift_vs_approved and approved_missing on a record take the record's audit checks (src/catalogue/select.ts)
    expect(row("drift_vs_approved").checks).toContain("actor_attributed");
    expect(row("approved_missing").sources).toContain("audit log");
  });

  it("each question is one DESIGN.md section 2 asks", () => {
    const design = read("DESIGN.md");
    const s2 = design.slice(design.indexOf("## 2. "), design.indexOf("## 3. "));
    for (const r of sourceRows()) expect(s2, r.cls).toContain(`**${r.question}**`);
  });

  it("the README carries the section exactly as npm run sources prints it", { timeout: 60_000 }, () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/sources-table.ts"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.replace(/\r\n/g, "\n")).toBe(sourcesMarkdown());
    expect(block(read("README.md"), "## Where each answer comes from"), "README.md is stale: paste the output of npm run sources").toBe(sourcesMarkdown().trim());
  });

  it("the README carries the semantic layer, the last block of section Zetaris, exactly as npm run sources -- --usl prints it", { timeout: 60_000 }, () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/sources-table.ts", "--usl"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.replace(/\r\n/g, "\n")).toBe(uslMarkdown());
    const readme = read("README.md");
    const zetaris = readme.slice(readme.indexOf("\n## Zetaris\n"), readme.indexOf("\n## Meterless\n"));
    expect(zetaris, "### The semantic layer sits in section Zetaris").toContain("\n### The semantic layer\n");
    expect(block(readme, "### The semantic layer"), "README.md is stale: paste the output of npm run sources -- --usl").toBe(uslMarkdown().trim());
  });

  it("the sources Zetaris reads beside DRIFT: the two files, then Cloudflare live through the REST datasource, its tables the ones dns_live is built from, its count as measured on 26 Oct 2026", () => {
    const rows = fileSourceRows();
    expect(rows.map((r) => [r.name, r.datasource])).toEqual([["technician memory store", "LESSONS"], ["policy rules", "RULES"], ["Cloudflare live", REST_DB]]);
    const cf = rows[2];
    expect(cf).toMatchObject({ file: "api.cloudflare.com/client/v4/zones/<zone id>/dns_records", tables: ["CLOUDFLARE.zone_<zone id>"], rows: "58 records in 6 zones on 26 Oct 2026" });
    // the table the row names is the one the semantic layer's dns_live entity reads, and the rule is the registered one
    expect(uslRows().find((r) => r.entity === "dns_live")!.builtFrom).toContain(cf.tables[0]);
    expect(DQ_RULES.some((r) => r.name === "dns_inventory_current" && r.table === "dns_live")).toBe(true);
    // the live run of npm run zetaris:setup of 26 Oct 2026, 03:47 UTC: count dns_live = 58, the zones report 58
    expect(LIVE_MEASURED).toEqual({ at: "26 Oct 2026", zones: 6, records: 58 });
    const md = sourcesMarkdown();
    expect(md).toContain("Zetaris also reads one source itself, live: the Cloudflare DNS API, which `npm run zetaris:setup` registers as the REST datasource `CLOUDFLARE`, one table per zone, fetched again at each query. The DQ rule `dns_inventory_current` on `drift_usl.dns_live` holds every record live at the provider to the last complete DNS collection run, joined on Cloudflare's record id;");
    expect(md).toContain("| Cloudflare live (`api.cloudflare.com/client/v4/zones/<zone id>/dns_records`) | `CLOUDFLARE` | `CLOUDFLARE.zone_<zone id>` | 58 records in 6 zones on 26 Oct 2026 | ");
  });

  it("the owner's document carries the same section, for a tenant with rows and for one with none", async () => {
    const { layer } = await engineOf(policyBundle);
    for (const tenant of [A, "client-z"]) {
      const doc = await renderDocument(layer, { tenant });
      expect(block(doc.markdown, "## Where each answer comes from"), tenant).toBe(sourcesMarkdown().trim());
    }
  });
});
