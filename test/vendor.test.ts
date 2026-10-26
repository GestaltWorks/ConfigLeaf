// The vendored Meterless engines against their upstream (vendor/UPSTREAM.json, PREEXISTING.md): every file
// under vendor/ is one of the manifest's 33, and each one's git blob id (sha1 over "blob <length>\0" and the
// content) is the id the manifest records for its upstream path at commit 1742dec. The content is read with
// CRLF turned to LF, the form every vendored file has in the index, so a Windows checkout with
// core.autocrlf=true hashes to the same ids. `gh api repos/Meterless/Meterless/git/trees/<commit>?recursive=1`
// lists the same ids. A changed byte, a missing file or an added file fails the first check; the third check
// shows each one on a copy in a temporary directory. vendor/scout-intent holds the 8 data files of the Scout Intent
// smoke set with a manifest of its own (vendor/scout-intent/UPSTREAM.json, same commit); the walk of vendor/ leaves it
// to the last describe, which checks it the same way. Offline; vendor/ is only read.
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

export interface VendorManifest {
  repository: string;
  commit: string;
  files: { path: string; upstream: string; blob: string }[];
}

export interface VendorCheck {
  matched: number;
  mismatched: string[];
  missing: string[];
  extra: string[];
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST: VendorManifest = JSON.parse(readFileSync(path.join(ROOT, "vendor", "UPSTREAM.json"), "utf8"));

export function blobId(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

// vendor/scout-intent holds data files and a manifest of its own (vendor/scout-intent/UPSTREAM.json); the walk of
// vendor/ leaves that directory to its own check below.
const SCOUT_DIR = "vendor/scout-intent";

// Walks root/<dir> (default vendor; node_modules and the manifest itself are skipped, and so is every directory in
// `skip`, default vendor/scout-intent) and compares each file's blob id, CRLF read as LF, with the manifest's entry for
// its path relative to root. A path in `own` is a file written in this repository, present and outside the manifest.
export function verifyVendor(root: string, manifest: VendorManifest, opts: { dir?: string; skip?: readonly string[]; own?: readonly string[] } = {}): VendorCheck {
  const dir = opts.dir ?? "vendor";
  const skip = opts.skip ?? [SCOUT_DIR];
  const own = new Set(opts.own ?? []);
  const expected = new Map(manifest.files.map((f) => [f.path, f.blob]));
  const seen = new Set<string>();
  const result: VendorCheck = { matched: 0, mismatched: [], missing: [], extra: [] };
  for (const file of walk(path.join(root, dir))) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel === `${dir}/UPSTREAM.json` || own.has(rel) || skip.some((s) => rel.startsWith(`${s}/`))) continue;
    seen.add(rel);
    const want = expected.get(rel);
    if (!want) { result.extra.push(rel); continue; }
    const lf = Buffer.from(readFileSync(file).toString("latin1").replace(/\r\n/g, "\n"), "latin1");
    if (blobId(lf) === want) result.matched++;
    else result.mismatched.push(rel);
  }
  for (const f of manifest.files) if (!seen.has(f.path)) result.missing.push(f.path);
  return result;
}

describe("vendored engines against upstream blob ids", () => {
  it("all 33 files under vendor/ are the manifest's and match their upstream blob ids at 1742dec", () => {
    expect(MANIFEST.commit).toBe("1742dec56a66e58eef9dda2d2b865823758ca8cd");
    expect(MANIFEST.files).toHaveLength(33);
    const check = verifyVendor(ROOT, MANIFEST);
    expect(check).toEqual({ matched: 33, mismatched: [], missing: [], extra: [] });
  });

  it("the blob id is git's: the empty file hashes to e69de29", () => {
    expect(blobId(Buffer.alloc(0))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("a changed byte, an added file and the files left out are each reported", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "vendor-check-"));
    try {
      const changed = "vendor/hmem/src/memoryStore.ts";
      const kept = "vendor/world-model/src/store.ts";
      for (const rel of [changed, kept]) {
        mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
        cpSync(path.join(ROOT, rel), path.join(tmp, rel));
      }
      const bytes = readFileSync(path.join(tmp, changed));
      bytes[0] = bytes[0] ^ 1;
      writeFileSync(path.join(tmp, changed), bytes);
      writeFileSync(path.join(tmp, "vendor/hmem/src/added.ts"), "export const added = 1;\n");
      const check = verifyVendor(tmp, MANIFEST);
      expect(check.matched).toBe(1);
      expect(check.mismatched).toEqual([changed]);
      expect(check.extra).toEqual(["vendor/hmem/src/added.ts"]);
      expect(check.missing).toHaveLength(31);
      expect(check.missing).not.toContain(changed);
      expect(check.missing).not.toContain(kept);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("vendored Scout Intent smoke-set data against upstream blob ids", () => {
  const SCOUT: VendorManifest = JSON.parse(readFileSync(path.join(ROOT, SCOUT_DIR, "UPSTREAM.json"), "utf8"));
  const OWN = [`${SCOUT_DIR}/README.md`];

  it("the 8 data files under vendor/scout-intent are the manifest's and match their upstream blob ids at the commit the other engines name", () => {
    expect(SCOUT.commit).toBe(MANIFEST.commit);
    expect(SCOUT.files).toHaveLength(8);
    expect(verifyVendor(ROOT, SCOUT, { dir: SCOUT_DIR, skip: [], own: OWN })).toEqual({ matched: 8, mismatched: [], missing: [], extra: [] });
  });

  it("a changed byte or an added file under vendor/scout-intent is reported, and the walk of vendor/ leaves the directory alone", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "vendor-scout-"));
    try {
      const changed = `${SCOUT_DIR}/evals/regression-set/v1/intents/deal.jsonl`;
      mkdirSync(path.dirname(path.join(tmp, changed)), { recursive: true });
      cpSync(path.join(ROOT, changed), path.join(tmp, changed));
      const bytes = readFileSync(path.join(tmp, changed));
      bytes[0] = bytes[0] ^ 1;
      writeFileSync(path.join(tmp, changed), bytes);
      writeFileSync(path.join(tmp, `${SCOUT_DIR}/added.jsonl`), "{}\n");
      const check = verifyVendor(tmp, SCOUT, { dir: SCOUT_DIR, skip: [], own: OWN });
      expect(check.mismatched).toEqual([changed]);
      expect(check.extra).toEqual([`${SCOUT_DIR}/added.jsonl`]);
      expect(check.missing).toHaveLength(7);
      expect(verifyVendor(tmp, MANIFEST).extra).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
