// npm run zetaris:queries [-- --tenant <id>] [--limit <n>]
// The agent's queries THROUGH Zetaris: DataLayer over ZetarisEngine, so every {{t:x}} renders as DRIFT.x
// and every statement passes assertSelectOnly before it is sent. Reads the collection runs from the
// datasource, takes the latest complete linux.nginx run per host and the latest cloudflare.dns run, and
// runs the hero query per host, then the estate survey (proxy_split, proxied_without_real_ip, the
// wildcard form, orphan_record, orphan_vhost), then the three detectors the pass runs (src/pipeline.ts):
// drift_vs_approved over each host's latest run and over the DNS run, changed_since_backup per host, and
// found_but_different per host whose linux.nginx runs hold two that pass the DQ gate (run_complete returns
// no row for them), the latest against the one before it. Every table prints its row count and every row
// as the engine returned it (the collectors redacted them before they were stored), and one line per
// tenant gives the detectors' counts. Last, through the raw adapter because it is not a SELECT, SHOW DQ
// INVALID RECORD run_complete on the USL's collection table: the runs the DQ gate holds back and why.
// Exit 1 when any query fails; nothing here writes.

import { parseArgs } from "node:util";
import { Zetaris } from "../src/adapters/zetaris.ts";
import { redact } from "../src/config.ts";
import { DataLayer } from "../src/data/layer.ts";
import { ZetarisEngine } from "../src/data/engines/zetaris.ts";
import {
  changedSinceBackup, driftVsApproved, foundButDifferentSql, hero, listRuns, objects, orphanRecords, orphanVhosts, proxiedWithoutRealIp, proxySplit, runComplete,
  wildcardWithoutRealIp,
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

    // the detectors, as the pass runs them
    const counts: string[] = [];
    for (const h of [...hostRuns.values()].filter((x) => x.tenant_id === tenant)) {
      const drift = await driftVsApproved(dl, { tenant_id: tenant, run_id: h.run_id }, opts);
      table(`drift_vs_approved on ${h.host} (${h.run_id}): settings whose live value differs from their latest approval`, drift.columns, drift.rows, drift.latencyMs);
      const backup = await changedSinceBackup(dl, { tenant_id: tenant, run_id: h.run_id, host: h.host }, opts);
      table(`changed_since_backup on ${h.host} (${h.run_id}): files the host's newest backup lacks or holds with other bytes`, backup.columns, backup.rows, backup.latencyMs);
      counts.push(`drift_vs_approved ${h.host} ${drift.rows.length}`, `changed_since_backup ${h.host} ${backup.rows.length}`);
      // found_but_different needs the previous passing run of the same host: the latest two that pass the DQ gate
      const group = runs.filter((r) => r.tenant_id === tenant && r.surface === "linux.nginx" && r.host === h.host);
      const passing: Record<string, string>[] = [];
      for (const r of group) if ((await runComplete(dl, r.run_id, opts)).rows.length === 0) passing.push(r);
      if (passing.length >= 2) {
        const [prev, last] = passing.slice(-2);
        const fbd = await foundButDifferentSql(dl, { tenant_id: tenant, run_id: last.run_id, prev_run_id: prev.run_id }, opts);
        table(`found_but_different on ${h.host} (${last.run_id} against ${prev.run_id}): byte-identical dns_name settings whose referent's fingerprint changed`, fbd.columns, fbd.rows, fbd.latencyMs);
        counts.push(`found_but_different ${h.host} ${fbd.rows.length}`);
      } else {
        console.log(`\n== found_but_different on ${h.host}: ${passing.length} passing linux.nginx run(s); the comparison takes two`);
      }
    }
    const dnsDrift = await driftVsApproved(dl, { tenant_id: tenant, run_id: dns.run_id }, opts);
    table(`drift_vs_approved on the DNS run (${dns.run_id}): record fields whose live value differs from their latest approval`, dnsDrift.columns, dnsDrift.rows, dnsDrift.latencyMs);
    counts.push(`drift_vs_approved ${dns.run_id} ${dnsDrift.rows.length}`);
    console.log(`\ndetectors for ${tenant} (rows): ${counts.join(", ")}`);
  }

  const invalid = await client.query(`SHOW DQ INVALID RECORD run_complete TABLE ${USL}.collection`, { limit, tracer, agent: "zetaris-queries", timeoutMs: 150_000 });
  table(`SHOW DQ INVALID RECORD run_complete TABLE ${USL}.collection`, invalid.columns, invalid.rows, invalid.latencyMs);
  const partial = runs.filter((r) => r.status !== "complete");
  console.log(`\nruns not complete in DRIFT.collection_run: ${partial.length ? partial.map((r) => `${r.run_id} ${r.surface}${r.host ? ` ${r.host}` : ""} ${r.observed_count}/${r.expected_count} ${r.status}`).join("; ") : "none"}`);
} catch (e) {
  console.error(`ZETARIS QUERIES FAILED: ${redact((e as Error).message ?? String(e))}`);
  process.exitCode = 1;
}
