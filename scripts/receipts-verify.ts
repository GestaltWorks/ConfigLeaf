// npm run receipts:verify -- <dir> [--tenant <id>]
//
// The offline check of a published receipt bundle (src/receipts/bundle.ts verify), with no .env and no network: the
// directory's call records (C*-run*.json calls[] and planted.json), receipts.json and receipts-withheld.json. Every
// call record with a receipt_id has its receipt present or listed as withheld; each present receipt's Ed25519
// signature verifies; the served model and tier, receipt.app (drift-agent-<tenant>), request_id and cache.status say
// what the record says; a counted call's prompt_preview opens with the request line, and a call the gate discarded or
// refused for custody keeps the preview mismatch it recorded. A directory without call records (an export given
// --ids) is checked receipt by receipt against the tenant and ids its receipts-withheld.json names. Prints the
// counts, each distinct signing key as the sha256 of its raw bytes with whether it is the key of the 23 Oct probe
// receipt (test/fixtures/receipt-lightning.json), and the runtime's memory injection summed over the receipts; one
// line per mismatch, receipt ids and check names only. Exits 1 on any mismatch.

import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { RECEIPTS_FILE, verify } from "../src/receipts/bundle.ts";

const { values: args, positionals } = parseArgs({ options: { tenant: { type: "string" } }, allowPositionals: true });
const dir = positionals[0];
const n = (x: number): string => x.toLocaleString("en-US");

try {
  if (!dir) throw new Error("give the directory: npm run receipts:verify -- <dir>");
  if (!existsSync(path.join(dir, RECEIPTS_FILE))) throw new Error(`${dir}: no ${RECEIPTS_FILE}`);
  const r = verify(dir, { tenant: args.tenant });
  const dirName = dir.split(path.sep).join("/");
  console.log(`receipts: ${dirName}, tenant ${r.tenant ?? "(none named)"}, app ${r.app ?? "(none)"}`);
  if (r.records) console.log(`receipts: ${n(r.records)} call records in ${r.runFiles} run files, ${n(r.receipted)} on a receipt; planted.json ${n(r.planted)} records`);
  else console.log("receipts: no call records; the ids receipts-withheld.json names");
  console.log(`receipts: ${n(r.wanted)} receipt ids, ${n(r.receipts)} in ${RECEIPTS_FILE}, ${n(r.withheld)} withheld; ${n(r.verified)} of ${n(r.receipts)} signatures verified`);
  const count = (c: string): number => r.failures.filter((f) => f.check === c).length;
  console.log(`receipts: served model mismatches ${count("served_model")}, tier mismatches ${count("served_tier")}, app mismatches ${count("app")}, request_id absent ${count("request_id")}, cache.status mismatches ${count("cache_status")}, missing ${count("missing")}`);
  console.log(`receipts: served tiers ${Object.entries(r.servedTiers).map(([t, k]) => `${t} ${n(k)}`).join(", ") || "none"}`);
  console.log(`receipts: prompt_preview opens with the request line on ${n(r.previewOk)} counted calls; ${n(r.custodyAsRecorded)} custody refused, as recorded`);
  console.log(`receipts: ${r.keys.length} signing key${r.keys.length === 1 ? "" : "s"}`);
  for (const k of r.keys) console.log(`receipts:   ${k.fingerprint} (pubkey ${k.pubkey_b64}), ${n(k.receipts)} receipts, the 23 Oct fixture key: ${k.fixture === null ? "fixture absent" : k.fixture ? "yes" : "no"}`);
  console.log(`receipts: the runtime's memory: hmem.injected on ${n(r.memory.receipts)} of ${n(r.receipts)} receipts, ${n(r.memory.injected)} records in all; egress.sent.context_sources ${Object.entries(r.memory.sources).map(([s, k]) => `"${s}" ${n(k)}`).join(", ") || "none"}`);
  for (const f of r.failures.slice(0, 40)) console.log(`receipts: FAIL ${f.receipt_id}: ${f.check}${f.file ? ` (${f.file})` : ""}`);
  if (r.failures.length > 40) console.log(`receipts: FAIL and ${r.failures.length - 40} more`);
  console.log(r.ok ? `receipts: OK, ${n(r.verified)} signatures verified, 0 mismatches` : `receipts: FAIL, ${r.failures.length} mismatch${r.failures.length === 1 ? "" : "es"}`);
  process.exit(r.ok ? 0 : 1);
} catch (err) {
  console.error(`receipts: ${(err as Error).message}`);
  process.exit(1);
}
