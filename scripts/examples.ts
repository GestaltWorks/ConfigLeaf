// npm run examples [-- --out <dir>]
// Three worked examples cut from the recorded bundle (sample/bundle.json), one per real case the first
// collection surfaced, each a bundle in its own right: the rows the case needs and nothing else, so a
// reader can see every row the finding rests on. The pass (src/pipeline.ts, no model) then runs over each
// slice through sql.js and its findings are written next to it. Nothing is authored: every row is a copy
// of a recorded, redacted row, and the findings are what the pass computed over them when this ran. Every
// slice is one tenant's, the tenant of the latest DNS run (client-1, the operator's estate): the bundle's
// lab rows (tenant lab-1) stay out of all three.
//
//   examples/proxy-split/            proxy_split              the DNS run, the two records of one zone, the three audit events on the www record
//   examples/wildcard-no-real-ip/    proxied_without_real_ip  the DNS run, the proxied wildcard, the landing host run's real_ip and enabled rows
//   examples/orphans/                orphan_record, orphan_vhost  both host runs' server_name, zone and enabled rows, every A record, the inventory, the export snapshots
//
// Every slice also keeps what the Decider reads for its own rows when the recorded bundle holds it
// (sliceDeciderRows): the policy rules of the tenant and of "*", whole; the approvals, vault copies and
// disposition rows whose object_id is an object of the slice's observations or a record of its dns_record
// rows, and the validations of those copies; the probes whose target is a name of the slice (its dns_record
// names and the referents of its server_name rows), and the tenant's probe runs. The disposition rows carry
// the prior HOLDs with their expiries, and their decided_at counts toward the slice's instant as it does
// toward the full pass's. So the verbs over a slice are the ones the full pass gives, and every approval,
// copy, disposition and probe a slice holds belongs to a row it shows.
//
// Each directory gets bundle.json (the slice, in the house format) and findings.json (the pass's findings).
// Directory names say what the case is, never which zone it is: the bundle pseudonymises the zone, and a
// folder named after it would undo that for every row of the zone. Every pass reads the technician's lessons
// from the store DRIFT_MEMORY_DIR names (read only; examples/memory, the committed store, when it is blank) and
// decides at the slice's own instant, or at the instant the latest lesson was taught when that is later
// (src/data/instant.ts decisionInstantWith), as the sample pass does,
// so an exception in force decides a slice's finding as it decides the full pass's, and a re-run with the same
// store gives the same findings.json.
//
// Then the owner's report over the full bundle for the same tenant, report.html in the output directory
// (examples/report.html): src/document/sample.ts renderSample and sampleReport, as npm run document writes it in
// sample mode, through the deny-list probe; a re-run with the same store writes the same bytes. And the executive
// report for the same tenant over the last 7 days to the decision instant, executive.html (src/document/sample.ts
// sampleExecutive, as npm run report:executive writes it in sample mode), through the same probe.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { memoryDir, redact } from "../src/config.ts";
import { loadSamplePolicy, renderSample, sampleExecutive, sampleReport, textSha256 } from "../src/document/sample.ts";
import { probeExport } from "../src/document/export.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { decisionInstant, decisionInstantWith } from "../src/data/instant.ts";
import { formatBundle, TABLES, type BundleFile, type Tables } from "../src/data/store.ts";
import type { TableName } from "../src/data/rows.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { VERBS, runPass, type Finding } from "../src/pipeline.ts";
import bundle from "../sample/bundle.json" with { type: "json" };

const B = bundle as unknown as Tables;

const latest = (surface: string, host: string | null) => [...B.collection_run].filter((r) => r.surface === surface && r.host === host && r.status === "complete").sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];

const dns = latest("cloudflare.dns", null);
const audit = latest("cloudflare.audit", null);
if (!dns || !audit) throw new Error("the recorded bundle lacks a complete DNS or audit run");
// The slices are the operator's estate, the tenant of the latest DNS run: the bundle also holds the lab's rows (lab-1), which no slice keeps.
const TENANT = dns.tenant_id;
const own = <R extends { tenant_id: string }>(xs: readonly R[]): R[] => xs.filter((x) => x.tenant_id === TENANT);
const hosts = [...new Set(own(B.collection_run).filter((r) => r.surface === "linux.nginx").map((r) => r.host!))].sort();
const hostRuns = hosts.map((h) => latest("linux.nginx", h));
if (hostRuns.some((r) => !r)) throw new Error("the recorded bundle lacks a complete host run");

const inventoryAddresses = new Set(own(B.inventory_asset).map((a) => a.address));
const records = B.dns_record.filter((d) => d.run_id === dns.run_id);
const obsOf = (run: { run_id: string }) => B.observation.filter((o) => o.run_id === run.run_id);

export interface Example { dir: string; note: string; tables: Partial<Tables>; classes: string[] }

/**
 * What the Decider reads for the rows of one slice, taken from `source` (see the header): policy rules of the
 * tenant and of "*", whole; approvals, vault copies and disposition rows of the tenant whose object_id is an
 * object of the slice's observations or a record of its dns_record rows; the validations of those copies; the
 * tenant's probes whose target is a dns_record name of the slice or the referent of one of its server_name rows;
 * the tenant's probe runs. A table the source does not hold gives nothing.
 */
export function sliceDeciderRows(source: Partial<Tables>, tenant: string, slice: Partial<Tables>): Partial<Tables> {
  const objects = new Set([...(slice.observation ?? []).map((o) => o.object_id), ...(slice.dns_record ?? []).map((d) => d.record_id)]);
  const names = new Set([
    ...(slice.dns_record ?? []).map((d) => d.name),
    ...(slice.observation ?? []).filter((o) => o.refers_to_type === "dns_name" && o.setting_path.includes(".server_name[") && o.refers_to_id).map((o) => o.refers_to_id!),
  ]);
  const copies = (source.vault_copy ?? []).filter((c) => c.tenant_id === tenant && objects.has(c.object_id));
  const copyIds = new Set(copies.map((c) => c.copy_id));
  return {
    policy_rule: (source.policy_rule ?? []).filter((r) => r.tenant_id === tenant || r.tenant_id === "*"),
    approved_setting: (source.approved_setting ?? []).filter((a) => a.tenant_id === tenant && objects.has(a.object_id)),
    vault_copy: copies,
    copy_validation: (source.copy_validation ?? []).filter((v) => v.tenant_id === tenant && copyIds.has(v.copy_id)),
    probe: (source.probe ?? []).filter((p) => p.tenant_id === tenant && names.has(p.target)),
    collection_run: (source.collection_run ?? []).filter((r) => r.tenant_id === tenant && r.surface === "probe"),
    disposition: (source.disposition ?? []).filter((d) => d.tenant_id === tenant && objects.has(d.object_id)),
  };
}

/** The slice's own tables plus the Decider's rows for them; collection_run gains the probe runs. */
function withDeciderRows(ex: Example): Example {
  const extra = sliceDeciderRows(B, TENANT, ex.tables);
  const tables: Partial<Tables> = { ...ex.tables };
  for (const [t, rows] of Object.entries(extra) as [keyof Tables, Tables[keyof Tables]][]) {
    if (!rows.length) continue;
    (tables as Record<string, unknown[]>)[t] = [...((ex.tables[t] as unknown[] | undefined) ?? []), ...rows];
  }
  return { ...ex, tables };
}

/** The proxied CNAME and the direct A record it aliases, plus the audit trail of the CNAME. */
function proxySplitExample(): Example {
  const split = records.filter((c) => c.type === "CNAME" && c.proxied === 1 && records.some((a) => a.run_id === c.run_id && a.name === c.content && ["A", "AAAA"].includes(a.type) && a.proxied === 0));
  const names = new Set(split.flatMap((c) => [c.name, c.content]));
  const zoneRecords = records.filter((d) => names.has(d.name));
  const ids = new Set(zoneRecords.map((d) => d.record_id));
  return {
    dir: "proxy-split",
    note: "proxy_split: one zone's www is a proxied CNAME to its apex, whose A record is direct, so the origin address Cloudflare hides on www is published on the apex. Rows: the DNS and audit runs, the zone's two records, and every audit event on the www record (three updates on 2026-04-16: proxied off, proxied on, content re-pointed by an API token). Cut from sample/bundle.json by scripts/examples.ts; names, addresses and the actor are pseudonyms.",
    tables: { collection_run: [dns, audit], dns_record: zoneRecords, audit_event: B.audit_event.filter((e) => e.resource_id && ids.has(e.resource_id)) },
    classes: ["proxy_split"],
  };
}

/**
 * The proxied wildcard and the host it lands on: that host's http-level real_ip and every block's real_ip and
 * enabled rows. The audit run comes along with every event on the wildcard record (none in the recorded log),
 * so the audit checks run and fail as they do in the full pass, instead of being withheld for a missing run.
 */
function wildcardNoRealIp(): Example {
  const wild = records.filter((d) => d.name.startsWith("*.") && d.proxied === 1 && ["A", "AAAA"].includes(d.type) && inventoryAddresses.has(d.content));
  const origins = new Set(wild.map((d) => d.content));
  const assets = own(B.inventory_asset).filter((a) => origins.has(a.address));
  const hostSet = new Set(assets.map((a) => a.host));
  const runs = hostRuns.filter((r) => hostSet.has(r.host));
  const obs = runs.flatMap((r) => obsOf(r).filter((o) => o.setting_path === "http.real_ip" || o.setting_path.endsWith(".real_ip") || o.setting_path.endsWith(".enabled")));
  const ids = new Set(wild.map((d) => d.record_id));
  return {
    dir: "wildcard-no-real-ip",
    note: "proxied_without_real_ip (wildcard form): a proxied wildcard record lands on a host where no server block and not the http level trusts a Cloudflare range, so every name under the wildcard sees Cloudflare's addresses as its visitors. Rows: the DNS and audit runs, the wildcard record, every audit event on it (none: the record predates the log), the host's inventory addresses, and the host run's http.real_ip, server[...].real_ip and server[...].enabled rows (every real_ip absent). Cut from sample/bundle.json by scripts/examples.ts.",
    tables: { collection_run: [dns, audit, ...runs], dns_record: wild, inventory_asset: assets, observation: obs, audit_event: B.audit_event.filter((e) => e.resource_id && ids.has(e.resource_id)) },
    classes: ["proxied_without_real_ip"],
  };
}

/**
 * Every address and alias record (a vhost whose name has only a CNAME is served, so the CNAMEs must be in),
 * every server_name of both hosts with its zone and enabled siblings, the inventory and the export snapshots.
 * The one proxied CNAME to a direct apex comes along with the CNAMEs, so this slice also yields the proxy_split.
 */
async function orphans(): Promise<Example> {
  const obs = hostRuns.flatMap((r) => obsOf(r).filter((o) => o.setting_path.includes(".server_name[") || o.setting_path.endsWith(".enabled")));
  const tables: Partial<Tables> = {
    collection_run: [dns, audit, ...hostRuns], dns_record: records.filter((d) => d.type === "A" || d.type === "CNAME"), observation: obs, inventory_asset: own(B.inventory_asset),
    backup_snapshot: own(B.backup_snapshot),
  };
  // The audit events of the records the pass names, so the checks read what the full bundle's checks read: a first pass finds the records.
  const first = await passOver({ _note: "", ...tables });
  const ids = new Set(first.findings.map((f) => f.finding.resource_id).filter((x): x is string => !!x));
  tables.audit_event = B.audit_event.filter((e) => e.resource_id && ids.has(e.resource_id));
  return {
    dir: "orphans",
    note: "orphan_record and orphan_vhost: A records land on a collected host where no enabled server block names them (requests reach the default server), and one host carries a vhost file on disk and one enabled vhost with two names that have no record in any collected zone and no wildcard covering their zone. Rows: the DNS and audit runs, every A and CNAME record (a name served through a CNAME alone is not an orphan, so the aliases are needed), the audit events on the records the findings name, both host runs' server_name rows with their .zone and .enabled siblings, the inventory (each host's global addresses) and the export tarballs backup_recent reads. The CNAMEs bring the one proxied alias of a direct apex with them, so the pass also reports that proxy_split here. Cut from sample/bundle.json by scripts/examples.ts.",
    tables,
    classes: ["orphan_record", "orphan_vhost", "proxy_split"],
  };
}

async function passOver(file: Record<string, unknown>) {
  const engine = await SqlJsEngine.create();
  engine.loadBundle(file);
  loadSamplePolicy(engine, file);
  try {
    return await runPass(new DataLayer(engine), { world: new DriftWorld("example_probe"), decidedAt: decisionInstant(file) });
  } finally {
    engine.close();
  }
}

/** The three slices, each with the Decider's rows for it. */
export async function buildExamples(): Promise<Example[]> {
  return [proxySplitExample(), wildcardNoRealIp(), await orphans()].map(withDeciderRows);
}

function toBundleFile(ex: Example): BundleFile {
  const out: Record<string, unknown> = { _note: ex.note };
  for (const t of TABLES) out[t] = ex.tables[t as TableName] ?? [];
  return out as BundleFile;
}

/** The markers around the table examples/README.md carries; the script writes what is between them. */
export const FACTS_START = "<!-- npm run examples writes this table -->";
export const FACTS_END = "<!-- end of the table npm run examples writes -->";

/**
 * The table of every count and size examples/README.md names, read off the files under `dir` as they are on disk:
 * each slice's rows, tables and findings by verb, the policy rows and the rules the shipped file makes govern, the
 * lessons, and the three files the sample renders. npm run examples writes it into the README, and
 * test/export.test.ts holds the README's table equal to it, so no number on that page is kept by hand.
 */
export function examplesFacts(dir: string): string {
  const n = (x: number): string => x.toLocaleString("en-US");
  const read = (f: string): string => readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");
  const bytes = (f: string): number => Buffer.byteLength(read(f));
  const rows: string[] = [];
  const slices = ["proxy-split", "wildcard-no-real-ip", "orphans"];
  const policyRows = new Set<number>();
  for (const d of slices) {
    const bundle = JSON.parse(read(`${d}/bundle.json`)) as Record<string, unknown>;
    const tables = Object.entries(bundle).filter(([k, v]) => k !== "_note" && Array.isArray(v) && v.length) as [string, unknown[]][];
    policyRows.add(((bundle.policy_rule ?? []) as unknown[]).length);
    const findings = JSON.parse(read(`${d}/findings.json`)) as { verb: string }[];
    const verbs = VERBS.map((v) => [v, findings.filter((f) => f.verb === v).length] as const).filter(([, c]) => c).map(([v, c]) => `${v} ${c}`).join(", ");
    rows.push(`| \`${d}/\` | ${n(tables.reduce((a, [, v]) => a + v.length, 0))} rows in ${tables.length} tables; ${findings.length} finding${findings.length === 1 ? "" : "s"}: ${verbs} |`);
  }
  const policy = JSON.parse(readFileSync(fileURLToPath(new URL("../policy/hackathon.json", import.meta.url)), "utf8")) as { version: number; rules: unknown[] };
  const lessons = new TechnicianMemory({ storage: "read", directory: path.join(dir, "memory") }).lessons().length;
  const doc = read("document.md");
  const exec = read("executive.html");
  const incidents = /<h2>Incidents of the period<span class="cnt">([\d,]+)<\/span><\/h2>/.exec(exec)?.[1];
  if (incidents === undefined) throw new Error("examples/executive.html names no incident count: its markup changed, so the README table cannot be written");
  const dq = (exec.match(/<li><span class="dq [a-z]+">/g) ?? []).length;
  rows.push(
    `| policy | ${[...policyRows].map(n).join(", ")} \`policy_rule\` rows in each slice; with the shipped \`policy/hackathon.json\` loaded, version ${policy.version}'s ${policy.rules.length} rules govern |`,
    `| \`memory/\` | ${lessons} lessons |`,
    `| \`document.md\` | ${n(doc.split("\n").length - 1)} lines, ${n(Buffer.byteLength(doc))} bytes |`,
    `| \`report.html\` | ${n(bytes("report.html"))} bytes |`,
    `| \`executive.html\` | ${n(Buffer.byteLength(exec))} bytes; ${incidents} incident${incidents === "1" ? "" : "s"}, ${dq} DQ rules |`,
  );
  return ["| file | what the last run of npm run examples measured |", "| --- | --- |", ...rows].join("\n");
}

/** The README with its table replaced by `facts`. */
export function withFacts(readme: string, facts: string): string {
  const a = readme.indexOf(FACTS_START);
  const b = readme.indexOf(FACTS_END);
  if (a < 0 || b < a) throw new Error(`examples/README.md lacks the markers ${FACTS_START} and ${FACTS_END}`);
  return `${readme.slice(0, a + FACTS_START.length)}\n${facts}\n${readme.slice(b)}`;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() : "";
/** The slices, the owner's report and the executive report, written under --out (default examples/). */
async function main(): Promise<void> {
  const { values: args } = parseArgs({ options: { out: { type: "string", default: "examples" } } });
  // A sample build over the recorded bundle: DRIFT_MEMORY_DIR blank reads the committed store (examples/memory), as SAMPLE_MODE does.
  const memory = new TechnicianMemory({ storage: "read", directory: memoryDir(undefined, true) });
  const taught = memory.lessons().map((l) => l.recordedAt);
  for (const ex of await buildExamples()) {
    const file = toBundleFile(ex);
    const engine = await SqlJsEngine.create();
    const counts = engine.loadBundle(file);
    // the shipped policy before the pass, as every sample setup loads it (src/document/sample.ts loadSamplePolicy)
    loadSamplePolicy(engine, file as unknown as Record<string, unknown>);
    const pass = await runPass(new DataLayer(engine), { world: new DriftWorld(`example_${ex.dir}`), memory, decidedAt: decisionInstantWith(file, taught) });
    engine.close();
    const unexpected = pass.findings.filter((f) => !ex.classes.includes(f.finding.class));
    if (unexpected.length) throw new Error(`${ex.dir}: the slice produced ${unexpected.length} finding(s) outside ${ex.classes.join("/")}: ${unexpected.map((f) => f.finding.class).join(", ")}`);
    if (!pass.findings.length) throw new Error(`${ex.dir}: the slice produced no finding`);
    const dir = path.join(args.out!, ex.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "bundle.json"), formatBundle(file));
    writeFileSync(path.join(dir, "findings.json"), `${JSON.stringify(pass.findings satisfies Finding[], null, 2)}\n`);
    const verbs = VERBS.filter((v) => pass.verbs[v] > 0).map((v) => `${pass.verbs[v]} ${v}`).join(", ");
    const mem = pass.memory ? `; lessons ${pass.memory.lessons}, exceptions applied ${pass.memory.applied}, lapsed ${pass.memory.lapsed}` : "";
    console.log(`${ex.dir}: ${Object.entries(counts).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(", ")}; ${pass.runs} runs, ${pass.gatedOut.length} gated; ${pass.findings.length} finding(s): ${ex.classes.join(", ")}; ${verbs}${mem}`);
    for (const f of pass.findings) console.log(`  ${f.verb.padEnd(8)} ${f.finding.class.padEnd(24)} ${f.finding.summary}${f.exception ? ` [exception ${f.exception.lesson} ${f.exception.status}]` : ""}`);
  }
  // the owner's report over the full bundle, for the slices' tenant
  const text = readFileSync(fileURLToPath(new URL("../sample/bundle.json", import.meta.url)), "utf8");
  const r = await renderSample(JSON.parse(text) as Record<string, unknown>, { tenant: TENANT, memory, source: "sql.js over sample/bundle.json" });
  const html = sampleReport(r.doc, r.pass.findings, { path: "sample/bundle.json", sha256: textSha256(text) });
  // the executive report over the same bundle and tenant, the last 7 days to the decision instant (npm run report:executive in sample mode)
  const ex = await sampleExecutive(JSON.parse(text) as Record<string, unknown>, { tenant: TENANT, memory, source: "sql.js over sample/bundle.json", period: "7d", file: { path: "sample/bundle.json", sha256: textSha256(text) } });
  // both through the one deny-list probe before either is written (src/document/export.ts)
  const labelCount: number = probeExport([["report", html], ["executive report", ex.html]]);
  writeFileSync(path.join(args.out!, "report.html"), html);
  console.log(`report: ${path.join(args.out!, "report.html").replace(/\\/g, "/")} for ${TENANT}, ${Buffer.byteLength(html)} bytes, ${r.doc.open} finding(s) open, decided at ${r.doc.decidedAt ?? "none"}; deny-list probe 0 of ${labelCount} label(s)`);
  writeFileSync(path.join(args.out!, "executive.html"), ex.html);
  // the README's table, read off the files as written; the README itself lives beside them, in examples/
  const readmePath = fileURLToPath(new URL("../examples/README.md", import.meta.url));
  if (path.resolve(args.out!) === path.dirname(readmePath)) writeFileSync(readmePath, withFacts(readFileSync(readmePath, "utf8").replace(/\r\n/g, "\n"), examplesFacts(args.out!)));
  console.log(`executive: ${path.join(args.out!, "executive.html").replace(/\\/g, "/")} for ${TENANT}, ${Buffer.byteLength(ex.html)} bytes, the last 7 days to ${ex.executive.at}, ${ex.executive.incidentCount} incident(s); deny-list probe 0 of ${labelCount} label(s)`);
}

if (invoked === import.meta.url.toLowerCase()) {
  // one failure behaviour with the other exports: the refusal or the error on one line, exit 1, nothing more written
  await main().catch((e: Error) => { console.error(`examples: ${redact(e?.message ?? String(e))}`); process.exitCode = 1; });
}
