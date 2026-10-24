// npm run zetaris:queries [-- --tenant <id>] [--limit <n>]
// The agent's queries THROUGH Zetaris: DataLayer over ZetarisEngine, so every {{t:x}} renders as DRIFT.x
// and every statement passes assertSelectOnly before it is sent. Reads the collection runs from the
// datasource, takes the latest complete linux.nginx run per host and the latest cloudflare.dns run, and
// runs the hero query per host, then the estate survey (proxy_split, proxied_without_real_ip, the
// wildcard form, orphan_record, orphan_vhost), printing every row as the engine returned it (the
// collectors redacted them before they were stored). Last, through the raw adapter because it is not a
// SELECT, SHOW DQ INVALID RECORD run_complete on the USL's collection table: the runs the DQ gate holds
// back and why. Exit 1 when any query fails; nothing here writes.

import { parseArgs } from "node:util";
import { Zetaris } from "../src/adapters/zetaris.ts";
import { redact } from "../src/config.ts";
import { DataLayer } from "../src/data/layer.ts";
import { ZetarisEngine } from "../src/data/engines/zetaris.ts";
import {
  hero, listRuns, objects, orphanRecords, orphanVhosts, proxiedWithoutRealIp, proxySplit, wildcardWithoutRealIp,
} from "../src/data/queries.ts";
import { USL } from "../src/zetaris/setup.ts";
import { Tracer } from "../src/trace.ts";

const { values: args } = parseArgs({ options: { tenant: { type: "string" }, limit: { type: "string", default: "200" } } });
const limit = Number(args.limit);
const tracer = new Tracer(`zetaris_queries_${Date.now().toString(36)}`, { model: "none" });
const client = new Zetaris();
const dl = new DataLayer(new ZetarisEngine(client));
const opts = { tracer, agent: "zetaris-queries", limit };

function table(title: string, columns: string[], rows: string[][], ms: number): void {
  console.log(`\n== ${title}: ${rows.length} row(s), ${ms} ms`);
  if (!rows.length) return;
  console.log(`   ${columns.join(" | ")}`);
  for (const row of rows) console.log(`   ${row.map((v) => (v.length > 120 ? `${v.slice(0, 117)}...` : v)).join(" | ")}`);
}

try {
  const runsRes = await listRuns(dl, opts);
  const runs = objects(runsRes).filter((r) => !args.tenant || r.tenant_id === args.tenant);
  table("collection runs through Zetaris (DRIFT.collection_run)", runsRes.columns, runs.map((r) => runsRes.columns.map((c) => r[c])), runsRes.latencyMs);

  const complete = runs.filter((r) => r.status === "complete");
  const dnsByTenant = new Map<string, Record<string, string>>();
  for (const r of complete.filter((x) => x.surface === "cloudflare.dns")) dnsByTenant.set(r.tenant_id, r);
  const hostRuns = new Map<string, Record<string, string>>();
  for (const r of complete.filter((x) => x.surface === "linux.nginx")) hostRuns.set(`${r.tenant_id}|${r.host}`, r);
  if (!dnsByTenant.size) throw new Error("no complete cloudflare.dns run in the datasource");
  if (!hostRuns.size) throw new Error("no complete linux.nginx run in the datasource");

  for (const [tenant, dns] of dnsByTenant) {
    console.log(`\n# tenant ${tenant}: DNS run ${dns.run_id} (${dns.started_at}), hosts: ${[...hostRuns.values()].filter((h) => h.tenant_id === tenant).map((h) => `${h.host} ${h.run_id}`).join(", ")}`);
    const split = await proxySplit(dl, { tenant_id: tenant, dns_run_id: dns.run_id }, opts);
    table("proxy_split: proxied CNAME aliasing a direct address record", split.columns, split.rows, split.latencyMs);
    for (const h of [...hostRuns.values()].filter((x) => x.tenant_id === tenant)) {
      const p = { tenant_id: tenant, run_id: h.run_id, dns_run_id: dns.run_id };
      const hr = await hero(dl, p, opts);
      table(`hero on ${h.host} (${h.run_id} x ${dns.run_id}): dns_name referents resolving outside the inventory`, hr.columns, hr.rows, hr.latencyMs);
      const blocks = await proxiedWithoutRealIp(dl, p, opts);
      table(`proxied_without_real_ip on ${h.host}: proxied names served by an enabled block that trusts no real_ip range`, blocks.columns, blocks.rows, blocks.latencyMs);
      const wild = await wildcardWithoutRealIp(dl, p, opts);
      table(`proxied_without_real_ip (wildcard) on ${h.host}: proxied wildcards landing where nothing trusts a range`, wild.columns, wild.rows, wild.latencyMs);
      const orphans = await orphanRecords(dl, p, opts);
      table(`orphan_record on ${h.host}: records landing here with no enabled server block naming them`, orphans.columns, orphans.rows, orphans.latencyMs);
      const vhosts = await orphanVhosts(dl, p, opts);
      table(`orphan_vhost on ${h.host}: server_names with no record and no covering wildcard`, vhosts.columns, vhosts.rows, vhosts.latencyMs);
    }
  }

  const invalid = await client.query(`SHOW DQ INVALID RECORD run_complete TABLE ${USL}.collection`, { limit, tracer, agent: "zetaris-queries", timeoutMs: 150_000 });
  table(`SHOW DQ INVALID RECORD run_complete TABLE ${USL}.collection`, invalid.columns, invalid.rows, invalid.latencyMs);
  const partial = runs.filter((r) => r.status !== "complete");
  console.log(`\nruns not complete in DRIFT.collection_run: ${partial.length ? partial.map((r) => `${r.run_id} ${r.surface}${r.host ? ` ${r.host}` : ""} ${r.observed_count}/${r.expected_count} ${r.status}`).join("; ") : "none"}`);
} catch (e) {
  console.error(`ZETARIS QUERIES FAILED: ${redact((e as Error).message ?? String(e))}`);
  process.exitCode = 1;
}
