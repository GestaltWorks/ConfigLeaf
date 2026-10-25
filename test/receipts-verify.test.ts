// The published receipt bundle (src/receipts/bundle.ts): the offline check over call records and signed receipts,
// the probe that withholds a receipt whole, and the reading of a results directory. Receipts are signed here with
// one throwaway Ed25519 key, as the runtime signs with one; test/fixtures/signed-receipt.ts gives a receipt under a
// fresh key; the two committed probe receipts of 23 Oct (test/fixtures/receipt-lightning.json, receipt-ultra.json)
// carry the runtime's own key and signature.
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalReceiptBody, type SignedReceipt } from "../src/adapters/nightshift.ts";
import { probe, readReceipts, receiptsText, select, verify, verifyBundle, type RecordLite, type WithheldFile } from "../src/receipts/bundle.ts";
import lightningJson from "./fixtures/receipt-lightning.json" with { type: "json" };
import ultraJson from "./fixtures/receipt-ultra.json" with { type: "json" };
import { signed, ULTRA_MODEL } from "./fixtures/signed-receipt.ts";

const LIGHTNING = lightningJson as unknown as SignedReceipt;
const ULTRA = ultraJson as unknown as SignedReceipt;
const RUNTIME_KEY = LIGHTNING.pubkey_b64;

const KEY = generateKeyPairSync("ed25519");
function signWith(receipt: Record<string, unknown>): SignedReceipt {
  const body = { llama_cpp_ref: "08659901c43b51de735740f1cf61bb82fbe0c4e4", manifest_hash: "25fa6ff31f0db5e0d043148b370615205fc2f176b65874069539226a35fbf909", receipt };
  const sig = sign(null, Buffer.from(canonicalReceiptBody(body), "utf8"), KEY.privateKey);
  return { body, pubkey_b64: KEY.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64"), sig_b64: sig.toString("base64") };
}

const TENANT = "t1";
const APP = "drift-agent-t1";
const PREVIEW = "[request 0123456789abcdef]\nClaim: host-27618a.ai is proxied through Cloudflare to ip-6b6bba";

const receiptFor = (id: string, extra: Record<string, unknown> = {}): SignedReceipt => signWith({
  receipt_id: id, request_id: `chatcmpl-${id}`, decision_id: id.replace("rcpt_", ""), app: APP, routing: { winner: ULTRA_MODEL },
  phases: [{ model: ULTRA_MODEL, phase: "final_synthesis", tier: "C" }], winning_route: { model: ULTRA_MODEL, tier: "C" },
  cache: { status: "miss" }, prompt_preview: PREVIEW, hmem: { ids: ["mem_mvlt1f95_l1mk"], injected: 1 }, egress: { sent: { context_sources: ["messages", "hmem:1 records"] } }, ...extra,
});

const record = (id: string, over: Partial<RecordLite> = {}): RecordLite => ({
  kind: "judge", item: "E01", attempt: 1, requested_tier: "ultra", served_model: ULTRA_MODEL, served_tier: "ultra",
  receipt_id: id, signature_ok: true, cache_status: "miss", gate: "ok", reason: "the refuting SELECT returned no rows", file: "C3-run1.json", ...over,
});

const bundle = (records: RecordLite[], receipts: SignedReceipt[], over: Partial<Parameters<typeof verifyBundle>[0]> = {}) =>
  verifyBundle({ tenant: TENANT, records, receipts, withheld: [], fixtureKey: RUNTIME_KEY, ...over });

describe("the offline check of a receipt bundle", () => {
  it("a whole bundle under one key verifies: each record's receipt present, signed, under the tenant's app, saying what the record says", () => {
    const ids = ["rcpt_a", "rcpt_b", "rcpt_c"];
    const r = bundle(ids.map((id) => record(id)), ids.map((id) => receiptFor(id)));
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect([r.records, r.receipted, r.wanted, r.receipts, r.verified, r.previewOk]).toEqual([3, 3, 3, 3, 3, 3]);
    expect(r.app).toBe(APP);
    expect(r.keys).toHaveLength(1);
    expect(r.keys[0]).toMatchObject({ receipts: 3, fixture: false });
    expect(r.keys[0].fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.memory).toEqual({ receipts: 3, injected: 3, sources: { messages: 3, "hmem:1 records": 3 } });
  });

  it("the two committed probe receipts verify under the runtime's one key; a copy with one flipped byte fails, and only that receipt", () => {
    const flipped = structuredClone(LIGHTNING);
    flipped.body.receipt.prompt_preview = flipped.body.receipt.prompt_preview.replace('"ok":true', '"ok":trUe');
    const recs = [LIGHTNING, ULTRA].map((x) => record(x.body.receipt.receipt_id, { served_model: x.body.receipt.routing.winner, requested_tier: x === LIGHTNING ? "lightning" : "ultra", served_tier: x === LIGHTNING ? "lightning" : "ultra" }));
    const whole = bundle(recs, [LIGHTNING, ULTRA]);
    expect(whole.verified).toBe(2);
    expect(whole.failures.filter((f) => f.check === "signature" || f.check === "signature_ok")).toEqual([]);
    expect(whole.keys).toEqual([expect.objectContaining({ pubkey_b64: RUNTIME_KEY, receipts: 2, fixture: true })]);

    const one = bundle(recs, [flipped, ULTRA]);
    expect(one.verified).toBe(1);
    const sig = one.failures.filter((f) => f.check === "signature" || f.check === "signature_ok");
    expect(sig.map((f) => f.receipt_id)).toEqual([LIGHTNING.body.receipt.receipt_id, LIGHTNING.body.receipt.receipt_id]);
    expect(one.ok).toBe(false);
  });

  it("a receipt filed under another app fails on app", () => {
    const r = bundle([record("rcpt_a"), record("rcpt_b")], [receiptFor("rcpt_a"), receiptFor("rcpt_b", { app: "drift-agent-other" })]);
    expect(r.failures).toEqual([{ receipt_id: "rcpt_b", check: "app" }]);
  });

  it("the served model, tier, cache status and request_id are held to the record; a missing receipt fails, a receipt no record names fails", () => {
    const r = bundle(
      [record("rcpt_a", { served_model: "openrouter/nvidia/nemotron-3.5-lightning", served_tier: "lightning", requested_tier: "lightning" }), record("rcpt_b", { cache_status: "hit" }), record("rcpt_c"), record("rcpt_gone")],
      [receiptFor("rcpt_a"), receiptFor("rcpt_b"), receiptFor("rcpt_c", { request_id: "" }), receiptFor("rcpt_extra")],
    );
    expect(r.failures.map((f) => `${f.receipt_id} ${f.check}`).sort()).toEqual([
      "rcpt_a served_model", "rcpt_a served_tier", "rcpt_b cache_status", "rcpt_c request_id", "rcpt_extra unnamed", "rcpt_gone missing",
    ]);
  });

  it("a fresh key shows as a second key", () => {
    const fresh = signed({ receipt_id: "rcpt_fresh", request_id: "chatcmpl-fresh", app: APP, routing: { winner: ULTRA_MODEL }, cache: { status: "miss" }, prompt_preview: PREVIEW });
    const r = bundle([record("rcpt_a"), record("rcpt_fresh")], [receiptFor("rcpt_a"), fresh]);
    expect(r.ok).toBe(true);
    expect(r.keys.map((k) => k.receipts)).toEqual([1, 1]);
    expect(new Set(r.keys.map((k) => k.fingerprint)).size).toBe(2);
  });

  it("a call the gate discarded or refused for custody keeps its preview mismatch, counted as recorded; a counted call's preview opens with the request line", () => {
    const cut = { prompt_preview: 'ce":"observation","row_id":"obs-a45e67caac5fa498","object":"/etc/letsencrypt/live/host-17a03d.info/privkey.pem' };
    const discarded = record("rcpt_d", { kind: "direct", gate: "discarded", reason: "custody failed; answer discarded and the call made once more" });
    const refused = record("rcpt_r", { kind: "direct", attempt: 2, gate: "refused", reason: "receipt gate: custody: failed on both attempts, answer discarded, not judged; the receipt is not for this request; request_id match, prompt_preview mismatch (a prefix of nothing we sent), app match (drift-agent-t1), cache miss" });
    const asRecorded = bundle([discarded, refused], [receiptFor("rcpt_d", cut), receiptFor("rcpt_r", cut)]);
    expect(asRecorded.failures).toEqual([]);
    expect([asRecorded.custodyAsRecorded, asRecorded.previewOk]).toEqual([2, 0]);

    const counted = bundle([record("rcpt_d")], [receiptFor("rcpt_d", cut)]);
    expect(counted.failures).toEqual([{ receipt_id: "rcpt_d", check: "prompt_preview", file: "C3-run1.json" }]);
    const custodyButMatching = bundle([discarded], [receiptFor("rcpt_d")]);
    expect(custodyButMatching.failures).toEqual([{ receipt_id: "rcpt_d", check: "custody", file: "C3-run1.json" }]);
  });
});

describe("the probe that withholds a receipt whole", () => {
  it("a deny-listed label is withheld and counted, and the label is not printed; the bundle with it listed as withheld verifies", () => {
    const label = "acmewidgets";
    const all = [receiptFor("rcpt_a"), receiptFor("rcpt_b", { prompt_preview: `${PREVIEW} under Acmewidgets-prod.conf` }), receiptFor("rcpt_c")];
    const out = select(all, ["rcpt_a", "rcpt_b", "rcpt_c", "rcpt_gone"], { words: [label] });
    expect(out.kept.map((r) => r.body.receipt.receipt_id)).toEqual(["rcpt_a", "rcpt_c"]);
    expect(out.withheld).toEqual([{ receipt_id: "rcpt_b", reasons: ["deny-list label"] }]);
    expect(out.missing).toEqual(["rcpt_gone"]);
    expect(JSON.stringify(out.withheld).toLowerCase()).not.toContain(label);

    const r = bundle(["rcpt_a", "rcpt_b", "rcpt_c"].map((id) => record(id)), out.kept, { withheld: out.withheld });
    expect(r.ok).toBe(true);
    expect([r.receipts, r.withheld, r.verified]).toEqual([2, 1, 2]);
  });

  it("the configured ssh aliases are allowed carriers, as in the leak test", () => {
    expect(probe(receiptFor("rcpt_a", { prompt_preview: `${PREVIEW} on lab-box` }).body, { words: ["lab-box"], aliases: ["lab-box"] })).toEqual([]);
  });

  it("the hash, key and id fields do not trip the probe: both committed receipts and a signed body pass whole", () => {
    expect(probe(LIGHTNING.body, { words: [] })).toEqual([]);
    expect(probe(ULTRA.body, { words: [] })).toEqual([]);
    expect(probe(receiptFor("rcpt_a").body, { words: ["acmewidgets"] })).toEqual([]);
  });

  it("each category is found where it stands, by name only: a private address, a home directory, a secret-shaped string, a hex run beside a key-like word in free text", () => {
    const with_ = (preview: string) => probe(receiptFor("rcpt_a", { prompt_preview: `${PREVIEW} ${preview}` }).body, { words: [] });
    expect(with_("upstream 10.20.30.40:8080")).toContain("private address");
    expect(with_("upstream 172.20.0.5")).toContain("private address");
    expect(with_("listen [2a01:4f8:c0c:1234::1]:443")).toContain("private address");
    expect(with_("from /home/alice/backup")).toContain("home directory path");
    expect(with_(`token ${["nvapi", "x".repeat(24)].join("-")}`)).toContain("secret-shaped string");
    expect(with_("signing key 25fa6ff31f0db5e0d043148b370615205fc2f176b65874069539226a35fbf909")).toEqual(["redactor changes free text"]);
    expect(with_("upstream 192.0.2.10 and ::1 and 2001:db8::5")).toEqual([]);
  });
});

describe("a published directory", () => {
  it("verify reads the run files, planted.json, receipts.json and receipts-withheld.json; a directory of ids takes the tenant and ids from the manifest", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "receipts-"));
    try {
      const recs = [record("rcpt_a"), record("rcpt_b"), { ...record("rcpt_x"), receipt_id: null, signature_ok: null, cache_status: null, served_model: null, served_tier: "unknown" as const, gate: "refused" as const }];
      const strip = ({ file: _f, ...c }: RecordLite) => c;
      writeFileSync(path.join(dir, "C3-run1.json"), JSON.stringify({ tenant: TENANT, calls: recs.map(strip) }));
      writeFileSync(path.join(dir, "planted.json"), JSON.stringify({ claims: [{ calls: [strip(record("rcpt_b", { file: "planted.json" }))] }] }));
      writeFileSync(path.join(dir, "receipts.json"), receiptsText([receiptFor("rcpt_a"), receiptFor("rcpt_b")]));
      writeFileSync(path.join(dir, "receipts-withheld.json"), JSON.stringify({ tenant: TENANT, withheld: [] } satisfies WithheldFile));
      const r = verify(dir, { fixtureKey: RUNTIME_KEY });
      expect(r.failures).toEqual([]);
      expect([r.runFiles, r.records, r.receipted, r.planted, r.wanted, r.verified]).toEqual([1, 3, 2, 1, 2, 2]);
      expect(readReceipts(path.join(dir, "receipts.json"))).toHaveLength(2);

      const lab = mkdtempSync(path.join(os.tmpdir(), "receipts-lab-"));
      try {
        writeFileSync(path.join(lab, "receipts.json"), receiptsText([receiptFor("rcpt_a"), receiptFor("rcpt_b")]));
        writeFileSync(path.join(lab, "receipts-withheld.json"), JSON.stringify({ tenant: TENANT, ids: ["rcpt_a", "rcpt_b", "rcpt_c"], withheld: [] } satisfies WithheldFile));
        const l = verify(lab, { fixtureKey: null });
        expect(l.failures).toEqual([{ receipt_id: "rcpt_c", check: "missing" }]);
        expect(l.previewOk).toBe(2);
        expect(l.keys[0].fixture).toBeNull();
      } finally {
        rmSync(lab, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readReceipts takes JSON lines (the runtime's own log) and the GET's list as well as an array", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "receipts-read-"));
    try {
      const two = [receiptFor("rcpt_a"), receiptFor("rcpt_b")];
      writeFileSync(path.join(dir, "log.jsonl"), `${two.map((r) => JSON.stringify(r)).join("\n")}\n`);
      writeFileSync(path.join(dir, "list.json"), JSON.stringify({ object: "list", data: two }));
      expect(readReceipts(path.join(dir, "log.jsonl")).map((r) => r.body.receipt.receipt_id)).toEqual(["rcpt_a", "rcpt_b"]);
      expect(readReceipts(path.join(dir, "list.json"))).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
