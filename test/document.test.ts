// The owner's document (src/document/render.ts): every read it runs, through sql.js with asserted rows; the page over
// sample/bundle.json, whose numbers are recomputed here from the bundle's own rows and whose committed copy
// (examples/document.md) is held to the render; and the page over test/fixtures/policy-bundle.json with actions and
// tickets added, so every section has rows; and "Where each answer comes from", read off the SQL, which the README
// carries as npm run sources prints it. Offline; nothing is written.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FINDING_CLASSES } from "../src/catalogue/templates.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { decisionInstant } from "../src/data/instant.ts";
import {
  DOC_ACTIONS_SQL, DOC_COPIES_SQL, DOC_DISPOSITIONS_OF_RUN_SQL, DOC_PROBES_SQL, DOC_PROBE_FAILURES_SQL, DOC_RUN_SHAPE_SQL, DOC_TICKETS_SQL, DOC_UNAPPROVED_SQL, DOC_ZONES_SQL,
  HERO_SQL, PROXIED_WITHOUT_REAL_IP_SQL, objects,
} from "../src/data/queries.ts";
import { TABLE_NAMES } from "../src/data/schema.ts";
import { renderDocument, sourceOf, sourceRows, sourcesMarkdown, tablesOf } from "../src/document/render.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { dispositionIdOf } from "../src/loop/pass.ts";
import { runPass } from "../src/pipeline.ts";
import sample from "../sample/bundle.json" with { type: "json" };
import policyBundle from "./fixtures/policy-bundle.json" with { type: "json" };
import { BLOG } from "../scripts/fixtures/policy-bundle.ts";

type B = Readonly<Record<string, unknown>>;
const T = "client-1";
const A = "client-a";

async function engineOf(b: B): Promise<{ engine: SqlJsEngine; layer: DataLayer }> {
  const engine = await SqlJsEngine.create();
  engine.loadBundle(b);
  return { engine, layer: new DataLayer(engine) };
}

/** The pass over the bundle into its own ledger, decided at the bundle's instant, then the page: what scripts/document.ts does in sample mode. */
async function documentOf(b: B, tenant: string, decidedAt = decisionInstant(b), source?: string) {
  const { engine, layer } = await engineOf(b);
  const pass = await runPass(layer, { world: new DriftWorld("test_document"), ledger: new MemoryLedger(engine), decidedAt });
  const classes = new Map(pass.findings.map((f) => [f.id, f.finding.class as string]));
  const doc = await renderDocument(layer, { tenant, classes, source });
  return { pass, doc, layer };
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

/** The policy fixture with four actions and two tickets of the tenant, and one of another tenant. */
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
  b.action = [act("act-1", "rollback_file", "done"), act("act-2", "rollback_file", "done"), act("act-3", "rollback_file", "failed"), act("act-4", "investigate", "done"), { ...act("act-5", "fix", "refused"), tenant_id: "client-b" }];
  const tkt = (id: string, type: string, status: string, n: number) => ({
    ticket_id: id, tenant_id: A, psa: "github", external_id: String(n), url: `https://tickets.example.invalid/issues/${n}`, type, priority: "P1", status,
    action_id: null, finding_id: "fnd-0000000000000001", created_at: "2026-10-23T03:07:00.000Z", updated_at: "2026-10-23T03:08:00.000Z",
  });
  b.ticket = [tkt("tkt-0000000000000001", "incident", "open", 1), tkt("tkt-0000000000000002", "change", "closed", 2)];
  return b;
}

describe("the page over sample/bundle.json", () => {
  it("is examples/document.md, byte for byte, and two renders give the same page", { timeout: 30_000 }, async () => {
    const { doc } = await documentOf(sample, T, undefined, "sql.js over sample/bundle.json");
    const committed = readFileSync(new URL("../examples/document.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(doc.markdown, "examples/document.md is stale: run npm run document -- --tenant client-1").toBe(committed);
    expect((await documentOf(sample, T, undefined, "sql.js over sample/bundle.json")).doc.markdown).toBe(doc.markdown);
  });

  it("every number on it is the bundle's: runs, the latest runs' shapes, zones, copies, approvals, findings, probes and the decision instant", async () => {
    const { doc, pass } = await documentOf(sample, T);
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
    // the head copies: the copies of each repository's latest taken_at
    const repoKey = (c: { surface: string; host: string | null }) => `${c.surface}|${c.host ?? ""}`;
    const heads = sample.vault_copy.filter((c) => !sample.vault_copy.some((x) => repoKey(x) === repoKey(c) && x.taken_at > c.taken_at));
    expect(md).toContain(`${heads.length} vault copies at the latest commit of each repository`);
    expect(md).toContain(`${sample.approved_setting.length} settings have an approval of record`);
    expect(md).toContain(`${pass.findings.length} findings are open on the latest passing runs: HOLD ${pass.verbs.HOLD}.`);
    expect(md).toContain(`| proxied_without_real_ip | ${pass.findings.filter((f) => f.finding.class === "proxied_without_real_ip").length} | ${pass.findings.filter((f) => f.finding.class === "proxied_without_real_ip").length} |`);
    for (const f of pass.findings) expect(md).toContain(`- ${f.id} ${f.verb} ${f.finding.class}: `);
    const probeRun = runs.filter((r) => r.surface === "probe").sort((a, b) => (a.started_at < b.started_at ? -1 : 1)).at(-1)!;
    const probes = sample.probe.filter((p) => p.run_id === probeRun.run_id);
    expect(md).toContain(`Probe runs passing the DQ gate: ${runs.filter((r) => r.surface === "probe").length} of surface probe, every served name probed for the pass, and ${runs.filter((r) => r.surface === "probe.verify").length} of surface probe.verify, the Actor's probes after a write.`);
    expect(md).toContain(`Probe run ${probeRun.run_id} (surface probe), finished ${probeRun.finished_at}: ${probes.filter((p) => p.status === "fail").length} probes fail.`);
    for (const kind of ["dns", "http", "tls"]) expect(md).toContain(`| ${kind} | ${probes.filter((p) => p.kind === kind && p.status === "ok").length} | ${probes.filter((p) => p.kind === kind && p.status === "fail").length} |`);
    // the latest decision on the pass's runs: the sample pass's own, at the bundle's instant, which is the latest decided_at the bundle holds
    const at = decisionInstant(sample)!;
    expect(at).toBe(sample.disposition.map((d) => d.decided_at).sort().at(-1));
    expect(pass.findings.every((f) => dispositionIdOf(f, at).startsWith("disp-"))).toBe(true);
    expect(md.trimEnd().split("\n").at(-1)).toBe(`Decided at ${at}.`);
    expect([doc.decidedAt, doc.open]).toEqual([at, pass.findings.length]);
    // the Queries section is the queries it ran, and every one of them is in the portable subset the parity test covers
    expect(doc.queries.map((c) => c.name)).toEqual([
      "RUNS_SQL", "RUN_COMPLETE_SQL", "DOC_ZONES_SQL", "DOC_RUN_SHAPE_SQL", "DOC_COPIES_SQL", "LATEST_APPROVALS_SQL", "POLICY_RULES_SQL", "DOC_UNAPPROVED_SQL",
      "DOC_DISPOSITIONS_OF_RUN_SQL", "DOC_ACTIONS_SQL", "DOC_TICKETS_SQL", "DOC_PROBES_SQL", "DOC_PROBE_FAILURES_SQL",
    ]);
    for (const c of doc.queries) expect(md).toContain(`- ${c.name}: ${c.runs} run${c.runs === 1 ? "" : "s"}, ${c.rows} row${c.rows === 1 ? "" : "s"}`);
  });

  it("the sample pass raises no approved_missing finding: every approved object of the 19:56 UTC runs is in the 21:21 UTC runs", async () => {
    const { pass, doc } = await documentOf(sample, T);
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
  /** The block between a heading and the next heading of the same level, trimmed. */
  const block = (md: string, heading: string): string => {
    const start = md.indexOf(`\n${heading}\n`);
    expect(start, `${heading} is missing`).toBeGreaterThanOrEqual(0);
    const body = md.slice(start + heading.length + 2);
    const end = body.indexOf("\n## ");
    return (end < 0 ? body : body.slice(0, end)).trim();
  };

  it("one row per class the pass raises; each joins two or more sources; every table it names is in sql/schema.sql and has a source", () => {
    const rows = sourceRows();
    expect(rows.map((r) => r.cls).sort()).toEqual([...FINDING_CLASSES].sort());
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

  it("the owner's document carries the same section, for a tenant with rows and for one with none", async () => {
    const { layer } = await engineOf(policyBundle);
    for (const tenant of [A, "client-z"]) {
      const doc = await renderDocument(layer, { tenant });
      expect(block(doc.markdown, "## Where each answer comes from"), tenant).toBe(sourcesMarkdown().trim());
    }
  });
});
