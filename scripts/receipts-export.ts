// npm run receipts:export -- --results eval/results/<stamp> [--from <file> | --from runtime]
// npm run receipts:export -- --ids rcpt_a,rcpt_b --tenant <id> --out <dir>/receipts.json [--from <file> | --from runtime]
//
// Publishes the runtime's signed receipts beside the call records that name them (src/receipts/bundle.ts), read
// only. The receipts come from one GET /v1/meterless/receipts?limit=200, the runtime's widest window, or with
// --from from a file: a receipts.json array, a saved GET list, or JSON lines; `--from runtime` reads the runtime's
// own log, receipts.jsonl in its data directory (%LOCALAPPDATA%\ai.meterless.runtime), which keeps every receipt.
// With --results the wanted ids are every receipt_id in that directory's C*-run*.json calls[] and planted.json,
// and the tenant is the one the run files name; with --ids they are the ids given, under --tenant.
//
// Each wanted receipt passes the probe (bundle.ts probe: the deny-list labels of REDACT_WORDS and EXPORT_DENY_WORDS,
// private addresses, home directory paths, secret-shaped strings, the redactor's invariance on free text) and is
// written verbatim to receipts.json, one receipt per line, or withheld whole and listed with its reason categories in
// receipts-withheld.json, which also names the tenant (and the ids given). A signed body is never edited. With
// --results, nightshift-job.json holds the tenant app's GET /v1/jobs entry at export time (id, kind, app, turns,
// failed, created_at, last_turn_at). Prints "found N of M receipt ids, missing K, withheld W"; exits 1 when any id is
// missing, when the deny-list is blank, or on any error. Next: npm run receipts:verify -- <dir>.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { SignedReceipt } from "../src/adapters/nightshift.ts";
import { config, redact } from "../src/config.ts";
import { tenantAppId } from "../src/gate.ts";
import { idsFrom, JOB_FILE, probe, readReceipts, RECEIPTS_FILE, receiptsText, select, WITHHELD_FILE, type WithheldFile } from "../src/receipts/bundle.ts";

/** The widest window the GET serves: measured 25 Oct 2026, ?limit=1000 and ?limit=500 each returned 200 receipts, no limit 100. */
const GET_LIMIT = 200;

const { values: args } = parseArgs({
  options: { results: { type: "string" }, ids: { type: "string" }, tenant: { type: "string" }, out: { type: "string" }, from: { type: "string" } },
});

const root = config.nightshift.baseUrl.replace(/\/v1$/, "");
const headers = (): Record<string, string> => {
  if (!config.nightshift.token) throw new Error("no Nightshift runtime token (METERLESS_RUNTIME_TOKEN, or the runtime's token file)");
  return { Authorization: `Bearer ${config.nightshift.token}`, "meterless-app": config.nightshift.appId };
};

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`GET ${url.slice(root.length)} -> ${r.status}`);
  return r.json();
}

/** The receipts to choose from, and a line naming where they came from (no local path printed: it would name the login). */
async function source(): Promise<{ receipts: SignedReceipt[]; from: string }> {
  if (args.from === "runtime") {
    const dir = process.env.LOCALAPPDATA;
    if (!dir) throw new Error("--from runtime: LOCALAPPDATA is not set; give the receipt log's path");
    const file = path.join(dir, "ai.meterless.runtime", "receipts.jsonl");
    if (!existsSync(file)) throw new Error("--from runtime: the runtime's receipts.jsonl is not in its data directory");
    return { receipts: readReceipts(file), from: "the runtime's receipt log (receipts.jsonl)" };
  }
  if (args.from) return { receipts: readReceipts(args.from), from: `the file ${path.basename(args.from)}` };
  const j = (await getJson(`${root}/v1/meterless/receipts?limit=${GET_LIMIT}`)) as { data?: SignedReceipt[] };
  return { receipts: j.data ?? [], from: `GET /v1/meterless/receipts?limit=${GET_LIMIT}` };
}

try {
  if (!!args.results === !!args.ids) throw new Error("give --results <dir>, or --ids <a,b> with --tenant and --out");
  const words = [...new Set([...config.redactWords, ...config.exportDenyWords])];
  if (!words.length) throw new Error("refusing to export: REDACT_WORDS and EXPORT_DENY_WORDS are blank, so the deny-list probe has nothing to look for");

  let outDir: string;
  let tenant: string;
  let wanted: string[];
  let given: string[] | undefined;
  if (args.results) {
    const calls = idsFrom(args.results);
    if (!calls.tenant) throw new Error(`${args.results}: no C*-run*.json names a tenant`);
    outDir = args.results;
    tenant = calls.tenant;
    wanted = calls.ids;
    console.log(`receipts: ${args.results}: ${calls.records.length - calls.planted} call records in ${calls.runFiles} run files and ${calls.planted} in planted.json, ${wanted.length} receipt ids, tenant ${tenant}`);
  } else {
    if (!args.tenant || !args.out) throw new Error("--ids needs --tenant <id> and --out <dir>/receipts.json");
    if (args.out.endsWith(".json") && path.basename(args.out) !== RECEIPTS_FILE) throw new Error(`--out names a directory or a file called ${RECEIPTS_FILE}`);
    outDir = args.out.endsWith(".json") ? path.dirname(args.out) : args.out;
    tenant = args.tenant;
    given = [...new Set(args.ids!.split(",").map((s) => s.trim()).filter(Boolean))];
    wanted = given;
  }
  const app = tenantAppId(tenant);

  const { receipts, from } = await source();
  console.log(`receipts: ${receipts.length} signed receipts read from ${from}`);
  const opts = { words, aliases: Object.keys(config.linuxHosts), redactWords: config.redactWords };
  const { kept, withheld, missing } = select(receipts, wanted, opts);

  mkdirSync(outDir, { recursive: true });
  const text = receiptsText(kept);
  writeFileSync(path.join(outDir, RECEIPTS_FILE), text);
  const manifest: WithheldFile = { tenant, ...(given ? { ids: given } : {}), withheld };
  writeFileSync(path.join(outDir, WITHHELD_FILE), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`receipts: found ${wanted.length - missing.length} of ${wanted.length} receipt ids, missing ${missing.length}, withheld ${withheld.length}`);
  for (const w of withheld) console.log(`receipts: withheld ${w.receipt_id}: ${w.reasons.join(", ")}`);
  if (missing.length) console.log(`receipts: missing ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? `, and ${missing.length - 10} more` : ""}; the runtime's own log keeps every receipt: --from runtime`);
  console.log(`receipts: wrote ${path.join(outDir, RECEIPTS_FILE)} (${kept.length} receipts, ${Buffer.byteLength(text).toLocaleString("en-US")} bytes) and ${path.join(outDir, WITHHELD_FILE)}`);

  if (args.results) {
    try {
      const jobs = ((await getJson(`${root}/v1/jobs`)) as { data?: any[] }).data ?? [];
      const job = jobs.find((j) => j.app === app);
      if (!job) console.log(`receipts: GET /v1/jobs holds no job for ${app}; ${JOB_FILE} not written`);
      else {
        const entry = { exported_at: new Date().toISOString(), id: job.id, kind: job.kind, app: job.app, turns: job.turns, failed: job.failed, created_at: job.created_at, last_turn_at: job.last_turn_at };
        const reasons = probe(entry, opts);
        if (reasons.length) console.log(`receipts: the job entry trips the probe (${reasons.join(", ")}); ${JOB_FILE} not written`);
        else {
          writeFileSync(path.join(outDir, JOB_FILE), `${JSON.stringify(entry, null, 1)}\n`);
          console.log(`receipts: wrote ${path.join(outDir, JOB_FILE)}: ${job.id} ${job.kind}, ${job.turns} turns, ${job.failed} failed`);
        }
      }
    } catch (err) {
      console.log(`receipts: ${JOB_FILE} not written: ${redact((err as Error).message)}`);
    }
  }
  console.log(`receipts: next, offline: npm run receipts:verify -- ${outDir}`);
  process.exit(missing.length ? 1 : 0);
} catch (err) {
  console.error(`receipts: ${redact((err as Error).message)}`);
  process.exit(1);
}
