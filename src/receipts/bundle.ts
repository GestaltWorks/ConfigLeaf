// The signed-receipt bundle published beside an eval run or a lab run, and its offline check.
//
// A results directory of the eval (eval/results/<stamp>/) holds one CallRecord per model call (src/eval/models.ts):
// the receipt id, the model and tier the receipt said served, its cache.status, how the gate settled the call. The
// bundle adds the runtime's signed receipts themselves, verbatim: receipts.json, a JSON array of {body, pubkey_b64,
// sig_b64}, one receipt per line, and receipts-withheld.json, which names the tenant, the ids asked for when the
// export was given ids, and each receipt the probe kept back with its reason categories. A signed body is never
// edited: the Ed25519 signature is over the canonical body (src/adapters/nightshift.ts canonicalReceiptBody), so a
// receipt is published whole or withheld whole.
//
//   idsFrom(dir)   every receipt_id in the calls[] of the C*-run*.json files and planted.json, with the records.
//   probe(body)    the reason categories that keep a receipt back, never the matched text: a deny-list label
//                  (countLabels over REDACT_WORDS and EXPORT_DENY_WORDS, the configured ssh aliases allowed, as
//                  test/leak.test.ts scans the tree), a private address (10/8, 172.16/12, 192.168/16, or an IPv6
//                  address outside loopback and the documentation range), a home directory path (the redactor's
//                  pass c pattern), a secret-shaped string (the CI step's pattern), and a free-text string leaf the
//                  redactor under a fresh salt would change. The redactor half skips the hash, key and id fields
//                  (manifest_hash, llama_cpp_ref, pubkey_b64, sig_b64, request_id, receipt_id, decision_id, hmem.ids),
//                  where HEX_RUN and B64_RUN would fire on every receipt.
//   select(...)    the export's split of the runtime's receipts into kept and withheld, by id and by probe.
//   verify(dir)    the offline report, with no .env and no network: every call record with a receipt_id has its
//                  receipt in receipts.json or listed as withheld; the signature verifies; servedModelOf equals
//                  served_model and its tier the requested tier; receipt.app is drift-agent-<tenant>; request_id is
//                  present; cache.status equals cache_status; signature_ok is true as recorded. The preview rule
//                  follows the gate: a counted call's prompt_preview opens with "[request ", and a call the gate
//                  discarded or refused for custody keeps the preview mismatch the gate recorded (the preview does not
//                  open with the request line), counted "custody refused, as recorded". The report also names each
//                  distinct signing key by the sha256 of its raw bytes, whether it is the key of the 23 Oct probe
//                  receipt test/fixtures/receipt-lightning.json, and the runtime's own memory injection
//                  (hmem.injected, egress.sent.context_sources) summed over the receipts.
//
// Measured 25 Oct 2026, read only: GET /v1/meterless/receipts returned the newest 100 receipts, and 200 with
// ?limit=1000 or ?limit=500 (13:41 to 18:02 UTC that day), a window holding 179 of the development run's 383; the
// runtime's own log, receipts.jsonl in its data directory, held 773 signed receipts from 24 Oct 02:12 UTC on, all 773
// verifying under one key, so scripts/receipts-export.ts reads that file with --from runtime when a run is older than
// the GET's window. The export of the development run that day: 383 of 383 found, 3 withheld (each a 180-character
// prompt_preview the runtime cut inside a pseudonymised file name, host-XXXXXX.<tld>.con, which the redactor reads as
// a new host name), 380 published and verified under the key of the 23 Oct probe receipts.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isIPv6 } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReceipt, type SignedReceipt } from "../adapters/nightshift.ts";
import type { CallRecord } from "../eval/models.ts";
import { servedModelOf, tenantAppId, tierOf } from "../gate.ts";
import { countLabels, Redactor } from "../redactor.ts";

export const RECEIPTS_FILE = "receipts.json";
export const WITHHELD_FILE = "receipts-withheld.json";
export const JOB_FILE = "nightshift-job.json";

/** The probe receipt of 23 Oct, whose key the report compares every signing key with. */
export const FIXTURE_RECEIPT = fileURLToPath(new URL("../../test/fixtures/receipt-lightning.json", import.meta.url));

// ---- call records ---------------------------------------------------------------------------------------------

/** The fields of a CallRecord the check reads, and where the record came from. */
export type RecordLite = Pick<CallRecord, "kind" | "item" | "attempt" | "requested_tier" | "served_model" | "served_tier" | "receipt_id" | "signature_ok" | "cache_status" | "gate" | "reason"> & { file: string };

export interface CallIds {
  /** The tenant the run files name; null when the directory holds none. */
  tenant: string | null;
  /** The configuration run files read (C*-run*.json). */
  runFiles: number;
  /** Every call record of the run files, then planted.json's. */
  records: RecordLite[];
  /** The planted.json records among them, counted on their own because they repeat run-file calls. */
  planted: number;
  /** Every distinct receipt_id, in the order the records name them. */
  ids: string[];
}

const RUN_FILE = /^C\d+-run\d+\.json$/;

/** Every receipt_id in the calls[] of the C*-run*.json files plus planted.json's claims[].calls[]. Throws when two run files name different tenants. */
export function idsFrom(dir: string): CallIds {
  const records: RecordLite[] = [];
  const tenants = new Set<string>();
  const runs = existsSync(dir) ? readdirSync(dir).filter((n) => RUN_FILE.test(n)).sort() : [];
  for (const f of runs) {
    const j = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { tenant?: string; calls?: CallRecord[] };
    if (typeof j.tenant === "string") tenants.add(j.tenant);
    for (const c of j.calls ?? []) records.push({ ...c, file: f });
  }
  let planted = 0;
  const plantedFile = path.join(dir, "planted.json");
  if (existsSync(plantedFile)) {
    const j = JSON.parse(readFileSync(plantedFile, "utf8")) as { claims?: { calls?: CallRecord[] }[] };
    for (const claim of j.claims ?? []) for (const c of claim.calls ?? []) { records.push({ ...c, file: "planted.json" }); planted++; }
  }
  if (tenants.size > 1) throw new Error(`${dir}: the run files name ${tenants.size} tenants`);
  const ids = [...new Set(records.map((r) => r.receipt_id).filter((id): id is string => typeof id === "string" && id.length > 0))];
  return { tenant: [...tenants][0] ?? null, runFiles: runs.length, records, planted, ids };
}

// ---- the probe ------------------------------------------------------------------------------------------------

export type WithholdReason = "deny-list label" | "private address" | "home directory path" | "secret-shaped string" | "redactor changes free text";

export interface ProbeOptions {
  /** The deny-list labels: REDACT_WORDS and EXPORT_DENY_WORDS. */
  words: readonly string[];
  /** The configured ssh aliases (LINUX_HOSTS keys), the one allowed carriers, as in test/leak.test.ts. */
  aliases?: readonly string[];
  /** REDACT_WORDS, for the redactor's pass e in the invariance half. */
  redactWords?: readonly string[];
  /** The fresh salt of the invariance half; random when absent. */
  salt?: string;
}

/** The hash, key and id fields, where the redactor's HEX_RUN and B64_RUN fire on every receipt. */
const ID_FIELDS = new Set(["manifest_hash", "llama_cpp_ref", "pubkey_b64", "sig_b64", "request_id", "receipt_id", "decision_id"]);
/** src/redactor.ts pass c: a login under /home or /Users. */
const HOME = /[\\/](?:home|Users)[\\/](?!user-[0-9a-f]{6}\b)[A-Za-z0-9._-]+/;
/** The CI step "No secrets committed". */
const SECRET = /nvapi-[A-Za-z0-9_-]{20,}|sk-or-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|rt-[A-Za-z0-9]{24,}/;
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.]*\d)/g;
/** src/redactor.ts pass b. */
const IPV6 = /(?<![\w:.])((?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4})(?![\w:])/g;

function privateV4(s: string): boolean {
  for (const m of s.matchAll(IPV4)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if ([m[1], m[2], m[3], m[4]].some((o) => Number(o) > 255)) continue;
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return true;
  }
  return false;
}

function realV6(s: string): boolean {
  for (const m of s.matchAll(IPV6)) {
    const ip = m[1].toLowerCase();
    if (!isIPv6(ip) || ip === "::1" || ip === "::" || /^2001:0?db8:/.test(ip)) continue;
    return true;
  }
  return false;
}

/** Every string leaf of `v` with the key path that leads to it. */
function* leaves(v: unknown, at: string[] = []): Generator<{ at: string[]; s: string }> {
  if (typeof v === "string") yield { at, s: v };
  else if (Array.isArray(v)) for (const x of v) yield* leaves(x, at);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) yield* leaves(x, [...at, k]);
}

const isIdField = (at: string[]): boolean => ID_FIELDS.has(at.at(-1) ?? "") || (at.at(-1) === "ids" && at.at(-2) === "hmem");

/** The reason categories that keep `value` (a receipt body, or a job entry) out of a published file; [] when it may be published. Never the matched text. */
export function probe(value: unknown, opts: ProbeOptions): WithholdReason[] {
  const out = new Set<WithholdReason>();
  let text = JSON.stringify(value);
  for (const a of opts.aliases ?? []) if (a) text = text.split(a).join("alias");
  if (Object.keys(countLabels(text, opts.words)).length) out.add("deny-list label");
  if (SECRET.test(text)) out.add("secret-shaped string");
  const redactor = new Redactor(opts.salt ?? randomBytes(16).toString("hex"), opts.redactWords ?? []);
  for (const { at, s } of leaves(value)) {
    if (privateV4(s) || realV6(s)) out.add("private address");
    if (HOME.test(s)) out.add("home directory path");
    if (!isIdField(at) && redactor.text(s) !== s) out.add("redactor changes free text");
  }
  return [...out];
}

export interface Withheld { receipt_id: string; reasons: WithholdReason[] }

/** The export's split: of `all`, the receipts whose receipt_id is wanted, in the order wanted, kept when the probe finds nothing; the rest of the wanted ids missing. */
export function select(all: readonly SignedReceipt[], wanted: readonly string[], opts: ProbeOptions): { kept: SignedReceipt[]; withheld: Withheld[]; missing: string[] } {
  const byId = new Map<string, SignedReceipt>();
  for (const r of all) {
    const id = r.body?.receipt?.receipt_id;
    if (typeof id === "string" && !byId.has(id)) byId.set(id, r);
  }
  const kept: SignedReceipt[] = [];
  const withheld: Withheld[] = [];
  const missing: string[] = [];
  for (const id of wanted) {
    const r = byId.get(id);
    if (!r) { missing.push(id); continue; }
    const reasons = probe(r.body, opts);
    if (reasons.length) withheld.push({ receipt_id: id, reasons });
    else kept.push(r);
  }
  return { kept, withheld, missing };
}

/** receipts.json as written: a JSON array, one receipt per line, each exactly as the runtime signed it. */
export const receiptsText = (receipts: readonly SignedReceipt[]): string => `[\n${receipts.map((r) => JSON.stringify(r)).join(",\n")}\n]\n`;

/** Signed receipts from a file: a JSON array (receipts.json), the GET's {data: [...]} list, or JSON lines (the runtime's receipts.jsonl). */
export function readReceipts(file: string): SignedReceipt[] {
  const text = readFileSync(file, "utf8");
  let whole: unknown;
  try {
    whole = JSON.parse(text);
  } catch {
    return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as SignedReceipt);
  }
  if (Array.isArray(whole)) return whole as SignedReceipt[];
  const list = whole as { data?: SignedReceipt[]; body?: unknown };
  return Array.isArray(list.data) ? list.data : list.body ? [whole as SignedReceipt] : [];
}

// ---- the offline check ----------------------------------------------------------------------------------------

/** receipts-withheld.json: the tenant, the ids asked for when the export was given ids, each receipt kept back. */
export interface WithheldFile { tenant: string; ids?: string[]; withheld: Withheld[] }

export type Check = "missing" | "signature" | "served_model" | "served_tier" | "app" | "request_id" | "cache_status" | "signature_ok" | "prompt_preview" | "unnamed" | "custody";

export interface Failure { receipt_id: string; check: Check; file?: string }

export interface KeyLine { fingerprint: string; pubkey_b64: string; receipts: number; fixture: boolean | null }

export interface VerifyReport {
  tenant: string | null;
  app: string | null;
  runFiles: number;
  /** Call records of the run files, and those of them on a receipt. */
  records: number;
  receipted: number;
  /** planted.json records, all of them repeats of run-file calls when the run is whole. */
  planted: number;
  /** Receipt ids the bundle must account for: the records' ids, or the ids the export was given. */
  wanted: number;
  receipts: number;
  withheld: number;
  verified: number;
  /** Counted calls whose preview opens with the request line. */
  previewOk: number;
  /** Calls the gate discarded or refused for custody whose preview keeps the mismatch the gate recorded. */
  custodyAsRecorded: number;
  failures: Failure[];
  keys: KeyLine[];
  servedTiers: Record<string, number>;
  memory: { receipts: number; injected: number; sources: Record<string, number> };
  ok: boolean;
}

export interface BundleInput {
  tenant: string | null;
  records: RecordLite[];
  runFiles?: number;
  planted?: number;
  /** The ids to account for when there are no call records (an export given --ids). */
  ids?: string[];
  receipts: SignedReceipt[];
  withheld: Withheld[];
  /** The 23 Oct fixture key; null when the fixture is not there to compare with. */
  fixtureKey: string | null;
}

const REQUEST_LINE = /^\[request /;
const fingerprint = (pubkeyB64: string): string => `sha256:${createHash("sha256").update(Buffer.from(pubkeyB64, "base64")).digest("hex")}`;
const isCustodyFailure = (r: RecordLite): boolean => r.gate === "discarded" || (r.gate === "refused" && /custody/.test(r.reason ?? ""));

/** The check over data already read: pure, for the tests and for verify(). */
export function verifyBundle(input: BundleInput): VerifyReport {
  const failures: Failure[] = [];
  const fail = (receipt_id: string, check: Check, file?: string): void => { failures.push({ receipt_id, check, ...(file ? { file } : {}) }); };
  const app = input.tenant === null ? null : tenantAppId(input.tenant);
  const byId = new Map<string, SignedReceipt>();
  for (const r of input.receipts) byId.set(String(r.body?.receipt?.receipt_id ?? ""), r);
  const withheld = new Set(input.withheld.map((w) => w.receipt_id));
  const sigOk = new Map<string, boolean>();
  for (const [id, r] of byId) sigOk.set(id, verifyReceipt(r));

  const runRecords = input.records.filter((r) => r.file !== "planted.json");
  const receiptedRecords = input.records.filter((r) => typeof r.receipt_id === "string" && r.receipt_id);
  const wanted = new Set<string>([...receiptedRecords.map((r) => r.receipt_id as string), ...(input.ids ?? [])]);
  let previewOk = 0;
  let custodyAsRecorded = 0;
  const previewSeen = new Set<string>();

  // Per receipt: present or withheld, signed, filed under the tenant's app, carrying a request_id.
  for (const id of wanted) {
    if (withheld.has(id)) continue;
    const r = byId.get(id);
    if (!r) { fail(id, "missing"); continue; }
    if (!sigOk.get(id)) fail(id, "signature");
    const rc = r.body.receipt ?? {};
    if (app === null || rc.app !== app) fail(id, "app");
    if (typeof rc.request_id !== "string" || !rc.request_id) fail(id, "request_id");
  }
  for (const id of byId.keys()) if (!wanted.has(id)) fail(id, "unnamed");

  // Per call record: the receipt says what the record says.
  for (const rec of receiptedRecords) {
    const id = rec.receipt_id as string;
    const r = byId.get(id);
    if (!r) continue;
    const rc = r.body.receipt ?? {};
    const served = servedModelOf(r);
    if (served !== rec.served_model) fail(id, "served_model", rec.file);
    if (tierOf(served) !== rec.requested_tier || tierOf(served) !== rec.served_tier) fail(id, "served_tier", rec.file);
    const cache = typeof rc.cache?.status === "string" ? rc.cache.status : null;
    if (cache !== rec.cache_status) fail(id, "cache_status", rec.file);
    if (rec.signature_ok !== true || sigOk.get(id) !== true) fail(id, "signature_ok", rec.file);
    const opens = typeof rc.prompt_preview === "string" && REQUEST_LINE.test(rc.prompt_preview);
    const custody = isCustodyFailure(rec);
    if (custody ? opens : !opens) fail(id, custody ? "custody" : "prompt_preview", rec.file);
    else if (!previewSeen.has(id)) { previewSeen.add(id); custody ? custodyAsRecorded++ : previewOk++; }
  }
  // Without call records (an export given --ids), every receipt is a counted call: its preview opens with the request line.
  if (!receiptedRecords.length) {
    for (const id of wanted) {
      const r = byId.get(id);
      if (!r) continue;
      if (typeof r.body.receipt?.prompt_preview === "string" && REQUEST_LINE.test(r.body.receipt.prompt_preview)) previewOk++;
      else fail(id, "prompt_preview");
    }
  }

  const keys = new Map<string, number>();
  const servedTiers: Record<string, number> = {};
  const memory = { receipts: 0, injected: 0, sources: {} as Record<string, number> };
  for (const r of byId.values()) {
    keys.set(r.pubkey_b64, (keys.get(r.pubkey_b64) ?? 0) + 1);
    const tier = tierOf(servedModelOf(r));
    servedTiers[tier] = (servedTiers[tier] ?? 0) + 1;
    const rc = r.body.receipt ?? {};
    const injected = Number(rc.hmem?.injected ?? 0);
    if (injected > 0) { memory.receipts++; memory.injected += injected; }
    for (const s of Array.isArray(rc.egress?.sent?.context_sources) ? rc.egress.sent.context_sources : []) memory.sources[String(s)] = (memory.sources[String(s)] ?? 0) + 1;
  }

  return {
    tenant: input.tenant, app, runFiles: input.runFiles ?? new Set(runRecords.map((r) => r.file)).size,
    records: runRecords.length, receipted: runRecords.filter((r) => r.receipt_id).length, planted: input.planted ?? input.records.length - runRecords.length,
    wanted: wanted.size, receipts: byId.size, withheld: [...wanted].filter((id) => withheld.has(id)).length,
    verified: [...sigOk.values()].filter(Boolean).length, previewOk, custodyAsRecorded, failures,
    keys: [...keys].map(([k, n]) => ({ fingerprint: fingerprint(k), pubkey_b64: k, receipts: n, fixture: input.fixtureKey === null ? null : k === input.fixtureKey })),
    servedTiers, memory, ok: failures.length === 0,
  };
}

/** The 23 Oct fixture receipt's key, or null when the file is not there. */
export function fixtureKey(file: string = FIXTURE_RECEIPT): string | null {
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as SignedReceipt).pubkey_b64 ?? null;
  } catch {
    return null;
  }
}

/** The offline report over a published directory: its call records, receipts.json and receipts-withheld.json. */
export function verify(dir: string, opts: { tenant?: string; fixtureKey?: string | null } = {}): VerifyReport {
  const calls = idsFrom(dir);
  const receiptsPath = path.join(dir, RECEIPTS_FILE);
  const receipts = existsSync(receiptsPath) ? readReceipts(receiptsPath) : [];
  const withheldPath = path.join(dir, WITHHELD_FILE);
  const manifest: WithheldFile | null = existsSync(withheldPath) ? (JSON.parse(readFileSync(withheldPath, "utf8")) as WithheldFile) : null;
  const tenant = opts.tenant ?? calls.tenant ?? manifest?.tenant ?? null;
  if (calls.tenant && manifest?.tenant && calls.tenant !== manifest.tenant) throw new Error(`${dir}: the run files name tenant ${calls.tenant} and ${WITHHELD_FILE} names ${manifest.tenant}`);
  return verifyBundle({
    tenant, records: calls.records, runFiles: calls.runFiles, planted: calls.planted, ids: manifest?.ids,
    receipts, withheld: manifest?.withheld ?? [], fixtureKey: opts.fixtureKey === undefined ? fixtureKey() : opts.fixtureKey,
  });
}
