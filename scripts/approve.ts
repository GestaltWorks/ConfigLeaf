// npm run approve -- --tenant <id> (--host <alias> [--object <real path | redacted object id>] | --zone <zone> | --record <id> | --all)
//                    [--by <name>] [--note <text>] [--schema <name>] [--dry-run] [--help]
//
// The technician's sign-off, written as approved_setting rows (src/vault/approve.ts) from the tenant's latest
// passing run (Store.latestPassingRun, the DQ gate's definition):
//   --host <alias>             the `file` setting of every nginx object of the host's latest passing linux.nginx
//                              run; with --object, of that one object, named by its real path (redacted the way
//                              the collector redacts it before the lookup) or by its redacted object id
//   --zone <zone>              every field (type, name, content, ttl, proxied) of every record of the zone in the
//                              latest passing cloudflare.dns run; a real zone name is redacted before the lookup
//   --record <id>              every field of one record, by its Cloudflare record id
//   --all                      every record of the account in that DNS run; with --host or --zone it names the
//                              default (every object of the scope)
// approved_by is --by (default "operator") and note --note, both through the redactor; approved_at is now.
// Every row is printed (redacted) with its state against the approvals already stored: new, replaces, current
// or superseded. --dry-run prints and writes nothing; otherwise the new, replaces and superseded rows go through
// Store.insertApproved (DATABASE_URL; --schema for another search_path) and the current ones are skipped, so a
// re-run over an unchanged estate writes 0 rows and a re-approval of an earlier value is written as the latest. The
// sign-off and its lines are src/vault/approve.ts approveRun, which the console's Approve (src/console/) runs as well.
// Exit 0 on success, 1 when the Store refuses or the selection matches nothing, 2 on a usage error or, for a
// write, a blank REDACT_SALT (a real path or zone would get a pseudonym no observation carries).

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { pseudonymHost } from "../src/collectors/linux.ts";
import { config, redact } from "../src/config.ts";
import type { CollectionRun } from "../src/data/rows.ts";
import { Store } from "../src/data/store.ts";
import { Redactor } from "../src/redactor.ts";
import { ApproveError, DNS_FIELDS, DNS_SURFACE, NGINX_SURFACE, approveRun, resolveObject, resolveZone, runLine, type ApprovalSelection } from "../src/vault/approve.ts";

const USAGE = "usage: npm run approve -- --tenant <id> (--host <alias> [--object <real path | redacted object id>] | --zone <zone> | --record <id> | --all) [--by <name>] [--note <text>] [--schema <name>] [--dry-run] [--help]";
const TENANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function usage(msg: string): never {
  console.error(`approve: ${msg}\n${USAGE}`);
  process.exit(2);
}

let args: { tenant?: string; host?: string; object?: string; zone?: string; record?: string; all?: boolean; by?: string; note?: string; schema?: string; "dry-run"?: boolean; help?: boolean };
try {
  args = parseArgs({
    options: {
      tenant: { type: "string" }, host: { type: "string" }, object: { type: "string" }, zone: { type: "string" }, record: { type: "string" },
      all: { type: "boolean" }, by: { type: "string" }, note: { type: "string" }, schema: { type: "string" }, "dry-run": { type: "boolean" }, help: { type: "boolean" },
    },
  }).values;
} catch (e) {
  usage((e as Error).message);
}

if (args.help) {
  console.log(USAGE);
  console.log("Writes approved_setting rows from the tenant's latest passing run: a host's nginx files (or one), a zone's records, one record, or with --all alone the account's records. --dry-run prints the rows (redacted) and writes nothing.");
  process.exit(0);
}
if (!args.tenant || !TENANT.test(args.tenant)) usage("--tenant is required: a tenant id ([A-Za-z0-9._-], up to 64)");
const scopes = [args.host !== undefined, args.zone !== undefined, args.record !== undefined].filter(Boolean).length;
if (scopes > 1) usage("name one scope: --host, --zone or --record");
if (scopes === 0 && !args.all) usage("name a scope: --host, --zone, --record, or --all for the account's records");
if (args.object !== undefined && args.host === undefined) usage("--object needs --host");
if (args.all && (args.object !== undefined || args.record !== undefined)) usage("--all selects every object of the scope; it takes no --object or --record");
const dryRun = args["dry-run"] === true;
if (!config.redactSalt) {
  if (!dryRun) usage("REDACT_SALT is blank: a real path or zone would get a pseudonym no observation carries. Set it in .env, or run with --dry-run.");
  console.error("warning: REDACT_SALT is blank; a real path or zone in this dry run gets a per-process pseudonym and matches nothing");
}

const tenant = args.tenant;
const redactor = new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords);
const by = redactor.text(args.by?.trim() || "operator");
const note = args.note?.trim() ? redactor.text(args.note.trim()) : null;

function fail(msg: string): never {
  console.error(`approve: ${msg}`);
  process.exit(1);
}

let store: Store | undefined;
try {
  store = Store.fromEnv({ schema: args.schema });
  let selection: ApprovalSelection;
  let run: CollectionRun | null;
  if (args.host !== undefined) {
    const host = pseudonymHost(redactor, args.host);
    run = await store.latestPassingRun(tenant, NGINX_SURFACE, host);
    if (!run) fail(`no passing ${NGINX_SURFACE} run for ${tenant} on ${host}`);
    const observations = await store.observationsOf(run.run_id);
    if (args.object !== undefined) {
      const objectId = resolveObject(observations, host, args.object, redactor);
      if (!objectId) fail(`object ${redactor.text(args.object)} has no file observation in ${runLine(run)}`);
      selection = { kind: "object", host, object_id: objectId };
    } else {
      selection = { kind: "host", host };
    }
    await finish(run, observations, selection);
  } else {
    run = await store.latestPassingRun(tenant, DNS_SURFACE, null);
    if (!run) fail(`no passing ${DNS_SURFACE} run for ${tenant}`);
    const observations = await store.observationsOf(run.run_id);
    const fields = observations.filter((o) => o.surface === DNS_SURFACE && (DNS_FIELDS as readonly string[]).includes(o.setting_path));
    if (!fields.length) fail(`${runLine(run)} holds no per-field record observations (type, name, content, ttl, proxied): approvals of records need a DNS run collected with them`);
    if (args.zone !== undefined) {
      const ids = resolveZone(await store.dnsRecordsOf(run.run_id), args.zone, redactor);
      if (!ids.length) fail(`zone ${redactor.text(args.zone)} has no record in ${runLine(run)}`);
      selection = { kind: "zone", record_ids: ids };
    } else if (args.record !== undefined) {
      if (!fields.some((o) => o.object_id === args.record)) fail(`record ${redactor.text(args.record)} has no observation in ${runLine(run)}`);
      selection = { kind: "record", record_id: args.record };
    } else {
      selection = { kind: "account" };
    }
    await finish(run, observations, selection);
  }
} catch (e) {
  console.error(`approve: ${redactor.text(redact((e as Error).message ?? String(e)))}`);
  process.exitCode = 1;
} finally {
  await store?.close();
}

/** The sign-off itself (src/vault/approve.ts approveRun, which the console's Approve runs too), its lines printed. */
async function finish(run: CollectionRun, observations: Awaited<ReturnType<Store["observationsOf"]>>, selection: ApprovalSelection): Promise<void> {
  try {
    const r = await approveRun(store!, { tenant, run, observations, selection, by, note, now: new Date(), dryRun });
    for (const l of r.lines) console.log(l);
  } catch (e) {
    if (e instanceof ApproveError) fail(e.message);
    throw e;
  }
}
