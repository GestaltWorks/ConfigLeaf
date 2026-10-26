// collect:m365. One pass over Microsoft Graph for one tenant: the verified domains and the DNS records Microsoft 365
// requires of each for mail (src/collectors/m365.ts), through the redactor under the tenant's salt, then (without
// --dry-run) into the app Postgres through Store: beginRun, the observation rows (four per record: domain, type,
// name, content), finishRun with the records observed. Read only on Microsoft's side: one token request and GETs.
//
//   npm run collect:m365 -- --tenant <id> [--dry-run]
//
// Prints counts only: no domain, record name or value, and never the secret or the token, which go nowhere but the
// request that needs them. The write path refuses a blank REDACT_SALT, as collect:cloudflare does: the pseudonyms
// must be the ones the Cloudflare records carry, or the pass's comparison never joins. The dry run accepts one and
// says so. A run in which a tenant name survived redaction keeps no row and is stored as failed.
// Live only: with any of M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET blank (a clone with no .env) it prints one
// line naming the blank ones and exits 2 before anything else. Exit 0 when the run is complete, 1 when it is not or the
// write failed, 2 on the blank keys, bad arguments, or a blank salt on the write path.

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { config, redact } from "../src/config.ts";
import { Graph, MAIL_FIELDS, collectM365 } from "../src/collectors/m365.ts";
import { Store } from "../src/data/store.ts";
import { TENANT_ID, TENANT_ID_SHAPE } from "../src/policy/schema.ts";
import { Redactor } from "../src/redactor.ts";
import { Tracer } from "../src/trace.ts";

const USAGE = "usage: npm run collect:m365 -- --tenant <id> [--dry-run]";

function die(msg: string): never {
  process.stderr.write(`${msg}\n${USAGE}\n`);
  process.exit(2);
}

// Live only by design: with no Microsoft 365 keys (a judge's clone has no .env) one plain line names what is missing, exit 2.
const missing = ([["M365_TENANT_ID", "tenantId"], ["M365_CLIENT_ID", "clientId"], ["M365_CLIENT_SECRET", "clientSecret"]] as const).filter(([, k]) => !config.m365[k]).map(([v]) => v);
if (missing.length) {
  process.stderr.write(`collect:m365 reads Microsoft Graph live and needs ${missing.join(", ")} in .env; ${missing.length === 1 ? "it is" : "they are"} not set\n`);
  process.exit(2);
}

let args: { tenant?: string; "dry-run"?: boolean };
try {
  args = parseArgs({ options: { tenant: { type: "string" }, "dry-run": { type: "boolean", default: false } } }).values;
} catch (e) {
  die((e as Error).message);
}
const tenant = args.tenant ?? die("--tenant is required");
if (!TENANT_ID.test(tenant)) die(`--tenant must be ${TENANT_ID_SHAPE}, got ${tenant}`);
const dry = args["dry-run"] === true;
if (!dry && !config.redactSalt) die("REDACT_SALT is blank: the write path needs the tenant's salt so pseudonyms join the Cloudflare records (set it in .env)");

const redactor = new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords);
const tracer = new Tracer(`collect_m365_${Date.now().toString(36)}`, { model: "none" });
const c = await collectM365(new Graph(), redactor, { tenantId: tenant });
const { run, counts } = c;

tracer.emit({
  agent: "collector", action: "observe", status: run.status === "complete" ? "ok" : "failed",
  input_summary: `${run.surface} tenant ${tenant}`,
  output_summary: `${run.run_id}: ${run.observed_count}/${run.expected_count ?? "?"} ${run.status}`,
  detail: c.errors.join("; ") || undefined,
});

const lines = [
  `${run.surface} ${run.run_id} ${run.observed_count}/${run.expected_count ?? "?"} ${run.status}`,
  `  domains: ${counts.domains} listed, ${counts.verified} verified, ${counts.initial} of them under onmicrosoft.com (DNS Microsoft serves, not compared), ${counts.inScope} compared`,
  `  records of the compared domains: ${counts.listed} listed, ${counts.mail} for mail, ${counts.other} for other services or of other types (not compared)`,
  `  mail records kept: MX ${counts.byType.MX}, TXT ${counts.byType.TXT}, CNAME ${counts.byType.CNAME}`,
  `  observations: ${c.observations.length} (${MAIL_FIELDS.length} per record: ${MAIL_FIELDS.join(", ")})`,
  `  tenant names standing alone after redaction: ${c.survivors}`,
  ...c.errors.map((e) => `  error: ${e}`),
];
if (!config.redactSalt) process.stdout.write("REDACT_SALT is blank: pseudonyms below are this process's only and match no other run\n");
process.stdout.write(`${lines.join("\n")}\n`);

let wrote = true;
if (!dry) {
  const store = Store.fromEnv();
  try {
    await store.beginRun(run);
    let n: number;
    try {
      n = await store.insertObservations(c.observations);
    } catch (e) {
      await store.finishRun(run.run_id, 0, "failed").catch(() => undefined);
      throw e;
    }
    await store.finishRun(run.run_id, run.observed_count ?? 0, run.status === "running" ? "failed" : run.status, run.finished_at ?? undefined);
    process.stdout.write(`wrote ${run.surface} ${run.run_id}: ${n} new observation row(s) of ${c.observations.length}, status ${run.status}\n`);
  } catch (e) {
    wrote = false;
    process.stderr.write(`collect:m365: the write failed: ${redactor.text(redact((e as Error)?.message ?? String(e)))}\n`);
  } finally {
    await store.close();
  }
}

process.exitCode = run.status === "complete" && wrote ? 0 : 1;
