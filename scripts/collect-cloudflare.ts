// collect:cloudflare. One pass over the Cloudflare DNS records and the account audit log for one tenant,
// through the redactor, then (without --dry-run) into the app Postgres through Store: beginRun with the
// population asserted, the rows, finishRun with what was observed. Nothing printed, traced or written
// is raw: zones, names, contents and actors are pseudonyms; record ids are Cloudflare object ids.
//
//   npm run collect:cloudflare -- --tenant <id> [--since YYYY-MM-DD] [--dry-run]
//
// The write path refuses a blank REDACT_SALT: a per-process salt gives this run pseudonyms no other run
// shares, so the hero query's join on name would never hold. The dry run accepts one and says so.
// The DNS run stores its dns_record rows and its observation rows (five per record: type, name, content, ttl,
// proxied), then finishes with the record count as observed.
// After the DNS run's Store writes, the vault hook (src/vault/hook.ts): a complete DNS run's records, kept raw
// as the client read them (CloudflareCollection.rawRecords), become one commit in <DRIFT_VAULT_DIR>/<tenant>/cloudflare as
// <zone>/<record_id>.json, and its vault_copy rows go through the Store; one trace line says what happened
// ("vault off" when DRIFT_VAULT_DIR is blank). A DRIFT_VAULT_DIR the vault refuses ends the script before any
// request (exit 2); a hook that fails after the run is stored ends it with exit 1.
// Exit 0 when both runs are complete, 1 when either is not, 2 on bad arguments or a blank salt.

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { config, redact } from "../src/config.ts";
import { Cloudflare, auditWindow, collectCloudflare, type CloudflareCollection } from "../src/collectors/cloudflare.ts";
import type { CollectionRun } from "../src/data/rows.ts";
import { Store } from "../src/data/store.ts";
import { Redactor } from "../src/redactor.ts";
import { Tracer } from "../src/trace.ts";
import { hookSummary, vaultCloudflareRun } from "../src/vault/hook.ts";
import { Vault } from "../src/vault/vault.ts";

const TENANT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const USAGE = "usage: npm run collect:cloudflare -- --tenant <id> [--since YYYY-MM-DD] [--dry-run]";

function die(msg: string): never {
  process.stderr.write(`${msg}\n${USAGE}\n`);
  process.exit(2);
}

const { values: args } = parseArgs({ options: { tenant: { type: "string" }, since: { type: "string" }, "dry-run": { type: "boolean", default: false } } });
const tenant = args.tenant ?? die("--tenant is required");
if (!TENANT.test(tenant)) die(`--tenant must be lowercase letters, digits and dashes, got ${tenant}`);
const dry = args["dry-run"] === true;
try {
  auditWindow(new Date(), args.since);
} catch (e) {
  die((e as Error).message);
}
if (!dry && !config.redactSalt) die("REDACT_SALT is blank: the write path needs the tenant's salt so pseudonyms join across runs (set it in .env)");

const redactor = new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords);
let vault: Vault | null = null;
if (!dry) {
  try {
    vault = Vault.fromEnv({ redactor });
  } catch (e) {
    die(`vault: ${redactor.text(redact((e as Error).message))}`);
  }
}
const tracer = new Tracer(`collect_cloudflare_${Date.now().toString(36)}`, { model: "none" });
const cf = new Cloudflare();
const c = await collectCloudflare(cf, redactor, { tenantId: tenant, since: args.since });

for (const run of [c.dnsRun, c.auditRun]) {
  tracer.emit({
    agent: "collector", action: "observe", status: run.status === "complete" ? "ok" : "failed",
    input_summary: `${run.surface} tenant ${tenant}${run.surface === "cloudflare.audit" ? ` window ${c.window.since}..${c.window.before}` : ""}`,
    output_summary: `${run.run_id}: ${run.observed_count}/${run.expected_count ?? "?"} ${run.status}`,
    detail: c.errors.filter((e) => e.startsWith(run.surface)).join("; ") || undefined,
  });
}

const tally = (keys: Iterable<string>): string =>
  [...[...keys].reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(", ");

function summary(c: CloudflareCollection): string[] {
  const out: string[] = [];
  const head = (r: CollectionRun) => `${r.surface} ${r.run_id} ${r.observed_count}/${r.expected_count ?? "?"} ${r.status}`;
  out.push(`${head(c.dnsRun)} (${c.zones.length} zones)`);
  const width = Math.max(0, ...c.zones.map((z) => z.zone.length));
  for (const z of c.zones) {
    const rows = c.records.filter((d) => d.zone === z.zone);
    const px = rows.filter((d) => d.proxied === 1).length;
    out.push(`  zone ${z.zone.padEnd(width)}  ${String(z.observed).padStart(3)}/${String(z.expected).padEnd(3)} proxied ${px} direct ${rows.length - px}`);
  }
  out.push(`  proxied ${c.records.filter((d) => d.proxied === 1).length}, direct ${c.records.filter((d) => d.proxied === 0).length}, flag absent ${c.records.filter((d) => d.proxied === null).length}`);
  out.push(`  by type: ${tally(c.records.map((d) => d.type))}`);
  out.push(`  observations: ${c.observations.length} (one per field of each record: ${tally(c.observations.map((o) => o.setting_path))})`);
  out.push(`${head(c.auditRun)} window ${c.window.since}..${c.window.before}${c.window.clamped ? " (since clamped to the 18-month retention)" : ""}`);
  out.push(`  by action: ${tally(c.events.map((e) => e.action))}`);
  out.push(`  by zone: ${tally(c.events.map((e) => c.eventZone.get(e.event_id) ?? "(account)"))}`);
  const updates = c.events.filter((e) => e.action === "update" && e.resource_type?.startsWith("dns_records/"));
  out.push(`  dns record events: ${tally(c.events.filter((e) => e.resource_type?.startsWith("dns")).map((e) => `${e.action} ${e.resource_type}`))}`);
  out.push(`  dns record updates by day: ${[...new Set(updates.map((e) => e.occurred_at.slice(0, 10)))].sort().map((d) => `${d} ${updates.filter((e) => e.occurred_at.startsWith(d)).length}`).join(", ")}`);
  out.push("  latest dns record updates:");
  for (const e of updates.slice(-3).reverse()) {
    out.push(`    ${e.occurred_at} ${c.eventZone.get(e.event_id) ?? "(account)"} record ${e.resource_id} by ${e.actor ?? "(no email)"}`);
    out.push(`      ${e.new_value}`);
  }
  for (const e of c.errors) out.push(`  error: ${e}`);
  return out;
}

if (!config.redactSalt) process.stdout.write("REDACT_SALT is blank: pseudonyms below are this process's only and match no other run\n");
process.stdout.write(`${summary(c).join("\n")}\n`);

let vaultFailed = false;
if (!dry) {
  const store = Store.fromEnv();
  try {
    const writes: [CollectionRun, () => Promise<string>][] = [
      [c.dnsRun, async () => {
        const n = await store.insertDnsRecords(c.records);
        const o = await store.insertObservations(c.observations);
        return `${n} new record row(s) of ${c.records.length}, ${o} new observation row(s) of ${c.observations.length}`;
      }],
      [c.auditRun, async () => `${await store.insertAuditEvents(c.events)} new row(s) of ${c.events.length}`],
    ];
    for (const [run, write] of writes) {
      await store.beginRun(run);
      let wrote: string;
      try {
        wrote = await write();
      } catch (e) {
        await store.finishRun(run.run_id, 0, "failed").catch(() => undefined);
        throw e;
      }
      await store.finishRun(run.run_id, run.observed_count ?? 0, run.status === "running" ? "failed" : run.status, run.finished_at ?? undefined);
      process.stdout.write(`wrote ${run.surface} ${run.run_id}: ${wrote}, status ${run.status}\n`);
      if (run === c.dnsRun) {
        const hook = await vaultCloudflareRun(vault, store, c, c.rawRecords, { redactor, tracer });
        vaultFailed = hook.status === "failed";
        process.stdout.write(`vault: ${JSON.stringify(hookSummary(hook))}\n`);
      }
    }
  } finally {
    await store.close();
  }
}

process.exitCode = c.dnsRun.status === "complete" && c.auditRun.status === "complete" && !vaultFailed ? 0 : 1;
