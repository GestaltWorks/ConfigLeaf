// npm run examples [-- --out <dir>]
// Three worked examples cut from the recorded bundle (sample/bundle.json), one per real case the first
// collection surfaced, each a bundle in its own right: the rows the case needs and nothing else, so a
// reader can see every row the finding rests on. The pass (src/pipeline.ts, no model) then runs over each
// slice through sql.js and its findings are written next to it. Nothing is authored: every row is a copy
// of a recorded, redacted row, and the findings are what the pass computed over them when this ran.
//
//   examples/proxy-split/            proxy_split              the DNS run, the two records of one zone, the three audit events on the www record
//   examples/wildcard-no-real-ip/    proxied_without_real_ip  the DNS run, the proxied wildcard, the landing host run's real_ip and enabled rows
//   examples/orphans/                orphan_record, orphan_vhost  both host runs' server_name, zone and enabled rows, every A record, the inventory, the export snapshots
//
// Each directory gets bundle.json (the slice, in the house format) and findings.json (the pass's findings).
// Directory names say what the case is, never which zone it is: the bundle pseudonymises the zone, and a
// folder named after it would undo that for every row of the zone.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { formatBundle, TABLES, type BundleFile, type Tables } from "../src/data/store.ts";
import type { TableName } from "../src/data/rows.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { runPass, type Finding } from "../src/pipeline.ts";
import bundle from "../sample/bundle.json" with { type: "json" };

const { values: args } = parseArgs({ options: { out: { type: "string", default: "examples" } } });
const B = bundle as unknown as Tables;

const runsOf = (surfaces: string[], hosts: (string | null)[] = [null]) => B.collection_run.filter((r) => surfaces.includes(r.surface) && (r.host === null || hosts.includes(r.host)));
const latest = (surface: string, host: string | null) => [...B.collection_run].filter((r) => r.surface === surface && r.host === host && r.status === "complete").sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];

const dns = latest("cloudflare.dns", null);
const audit = latest("cloudflare.audit", null);
const hosts = [...new Set(B.collection_run.filter((r) => r.surface === "linux.nginx").map((r) => r.host!))].sort();
const hostRuns = hosts.map((h) => latest("linux.nginx", h));
if (!dns || !audit || hostRuns.some((r) => !r)) throw new Error("the recorded bundle lacks a complete DNS, audit or host run");

const inventoryAddresses = new Set(B.inventory_asset.map((a) => a.address));
const records = B.dns_record.filter((d) => d.run_id === dns.run_id);
const obsOf = (run: { run_id: string }) => B.observation.filter((o) => o.run_id === run.run_id);

interface Example { dir: string; note: string; tables: Partial<Tables>; classes: string[] }

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
  const assets = B.inventory_asset.filter((a) => origins.has(a.address));
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
    collection_run: [dns, audit, ...hostRuns], dns_record: records.filter((d) => d.type === "A" || d.type === "CNAME"), observation: obs, inventory_asset: B.inventory_asset,
    backup_snapshot: B.backup_snapshot,
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
  try {
    return await runPass(new DataLayer(engine), { world: new DriftWorld("example_probe") });
  } finally {
    engine.close();
  }
}

function toBundleFile(ex: Example): BundleFile {
  const out: Record<string, unknown> = { _note: ex.note };
  for (const t of TABLES) out[t] = ex.tables[t as TableName] ?? [];
  return out as BundleFile;
}

for (const ex of [proxySplitExample(), wildcardNoRealIp(), await orphans()]) {
  const file = toBundleFile(ex);
  const engine = await SqlJsEngine.create();
  const counts = engine.loadBundle(file);
  const pass = await runPass(new DataLayer(engine), { world: new DriftWorld(`example_${ex.dir}`) });
  engine.close();
  const unexpected = pass.findings.filter((f) => !ex.classes.includes(f.finding.class));
  if (unexpected.length) throw new Error(`${ex.dir}: the slice produced ${unexpected.length} finding(s) outside ${ex.classes.join("/")}: ${unexpected.map((f) => f.finding.class).join(", ")}`);
  if (!pass.findings.length) throw new Error(`${ex.dir}: the slice produced no finding`);
  const dir = path.join(args.out, ex.dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "bundle.json"), formatBundle(file));
  writeFileSync(path.join(dir, "findings.json"), `${JSON.stringify(pass.findings satisfies Finding[], null, 2)}\n`);
  const verbs = pass.findings.map((f) => f.verb);
  console.log(`${ex.dir}: ${Object.entries(counts).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(", ")}; ${pass.runs} runs, ${pass.gatedOut.length} gated; ${pass.findings.length} finding(s): ${ex.classes.join(", ")}; ${verbs.filter((v) => v === "ADOPT").length} ADOPT, ${verbs.filter((v) => v === "ESCALATE").length} ESCALATE`);
  for (const f of pass.findings) console.log(`  ${f.verb.padEnd(8)} ${f.finding.class.padEnd(24)} ${f.finding.summary}`);
}
