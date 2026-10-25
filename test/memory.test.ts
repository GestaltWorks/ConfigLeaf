// TechnicianMemory over the vendored H-MEM reference: record, recall by exact scope key, expiry flagging,
// persistence in the store's directory and the read-only opening every pass uses, DRIFT_MEMORY_DIR (default
// .world/memory) as npm run answer reads it, redaction of the free text, input validation, and the vendored
// conformance suite run through src/engine/memory.ts in a spawned process, as npm run conformance:hmem does.
// Scope keys here are documentation names and addresses (RFC 2606 and 5737), which the redactor passes
// through, so the assertions hold under any REDACT_SALT.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_MEMORY_DIR, SAMPLE_MEMORY_DIR, config, memoryDir } from "../src/config.ts";
import { HMEM, MemoryError, TechnicianMemory, lessonOf, scopeValuesOf, type FindingScope } from "../src/engine/memory.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const T0 = Date.parse("2026-10-24T12:00:00.000Z");
const at = (iso: string): string => new Date(iso).toISOString();
const prov = { kind: "cli", at: "2026-10-24T11:59:00.000Z", by: "technician", runId: "run-nginx-7f1c-1023" };
const EXPIRES = "2026-11-30T00:00:00.000Z";

const finding: FindingScope = {
  tenant_id: "client-a", class: "proxied_without_real_ip", host: "host-7f1c",
  dns_name: "app.example.invalid", refers_to_type: "dns_name", refers_to_id: "app.example.invalid", resolves_to: "203.0.113.77",
};

const mem = (clock: () => number = () => T0) => new TechnicianMemory({ clock });

describe("scopeValuesOf", () => {
  it("offers the host, the DNS name (and a dns_name referent), and the address; nothing for a null", () => {
    expect(scopeValuesOf(finding)).toEqual({ host: ["host-7f1c"], name: ["app.example.invalid"], address: ["203.0.113.77"] });
    expect(scopeValuesOf({ ...finding, refers_to_id: "www.example.invalid" }).name).toEqual(["app.example.invalid", "www.example.invalid"]);
    expect(scopeValuesOf({ ...finding, refers_to_type: "upstream", refers_to_id: "app_backend" }).name).toEqual(["app.example.invalid"]);
    expect(scopeValuesOf({ host: null, dns_name: null, refers_to_type: null, refers_to_id: null, resolves_to: null })).toEqual({ host: [], name: [], address: [] });
  });
});

describe("TechnicianMemory: exceptions", () => {
  it("an accepted exception applies to a finding of its class on its scope until it expires, then comes back flagged, never applied", () => {
    const m = mem();
    const l = m.recordException({ tenantId: "client-a", findingClass: "proxied_without_real_ip", scopeKey: "host-7f1c", reason: "origin is reached only through the tunnel", expiresAt: EXPIRES, provenance: prov });
    expect(l).toMatchObject({ kind: "exception", tenantId: "client-a", findingClass: "proxied_without_real_ip", scopeKey: "host-7f1c", expiresAt: EXPIRES, recordedAt: at("2026-10-24T12:00:00Z"), provenance: prov });
    expect(l.id).toMatch(/^mem-\d+$/);

    const before = m.recall(finding, "2026-11-29T23:59:59.999Z");
    expect(before.applicable).toEqual([l]);
    expect(before.expired).toEqual([]);
    expect(m.exceptionFor(finding, "2026-11-29T23:59:59.999Z")).toEqual(l);

    const lapsed = m.recall(finding, EXPIRES);                 // exactly at the expiry: lapsed
    expect(lapsed.applicable).toEqual([]);
    expect(lapsed.expired).toEqual([l]);
    expect(m.exceptionFor(finding, EXPIRES)).toBeNull();
    expect(m.recall(finding, "2027-01-01T00:00:00Z").expired).toEqual([l]);
    expect(m.recall(finding).applicable).toEqual([l]);          // the clock says T0, before the expiry
  });

  it("matches by exact scope key on any of the finding's scope values, and by class and tenant; never by similarity", () => {
    const m = mem();
    const byName = m.recordException({ tenantId: "client-a", findingClass: "proxied_without_real_ip", scopeKey: "app.example.invalid", reason: "r", expiresAt: EXPIRES, provenance: prov });
    const byAddr = m.recordException({ tenantId: "client-a", findingClass: "proxied_without_real_ip", scopeKey: "203.0.113.77", reason: "r", expiresAt: EXPIRES, provenance: prov });
    m.recordException({ tenantId: "client-a", findingClass: "proxied_without_real_ip", scopeKey: "host-7f1d", reason: "near miss on the host", expiresAt: EXPIRES, provenance: prov });
    m.recordException({ tenantId: "client-a", findingClass: "orphan_record", scopeKey: "host-7f1c", reason: "other class", expiresAt: EXPIRES, provenance: prov });
    m.recordException({ tenantId: "client-b", findingClass: "proxied_without_real_ip", scopeKey: "host-7f1c", reason: "other tenant", expiresAt: EXPIRES, provenance: prov });
    const r = m.recall(finding);
    expect(r.applicable.map((l) => l.id)).toEqual([byName.id, byAddr.id]);
    expect(r.expired).toEqual([]);
    expect(m.recall({ ...finding, host: "host-7f1d", dns_name: null, refers_to_id: null, resolves_to: null }).applicable.map((l) => (l as { reason: string }).reason)).toEqual(["near miss on the host"]);
    expect(m.recall({ ...finding, class: "orphan_record" }).applicable.map((l) => (l as { reason: string }).reason)).toEqual(["other class"]);
    expect(m.lessons("client-b")).toHaveLength(1);
    expect(m.lessons()).toHaveLength(5);
  });
});

describe("TechnicianMemory: answers", () => {
  it("an answer applies on its own scope type (host, name or address) and is found again for the same question, spacing and case aside", () => {
    const m = mem();
    const q = "Is the origin behind the tunnel on purpose?";
    const host = m.recordAnswer({ tenantId: "client-a", question: q, answer: "Yes, since the migration.", scope: { type: "host", key: "host-7f1c" }, expiresAt: EXPIRES, provenance: prov });
    const name = m.recordAnswer({ tenantId: "client-a", question: "Who owns this name?", answer: "The client.", scope: { type: "name", key: "app.example.invalid" }, expiresAt: EXPIRES, provenance: prov });
    const addr = m.recordAnswer({ tenantId: "client-a", question: "Is this address ours?", answer: "A documentation address.", scope: { type: "address", key: "203.0.113.77" }, expiresAt: EXPIRES, provenance: prov });
    m.recordAnswer({ tenantId: "client-a", question: q, answer: "Not here.", scope: { type: "host", key: "host-7f1d" }, expiresAt: EXPIRES, provenance: prov });
    m.recordAnswer({ tenantId: "client-a", question: q, answer: "Wrong type.", scope: { type: "name", key: "host-7f1c" }, expiresAt: EXPIRES, provenance: prov });

    expect(host).toMatchObject({ kind: "answer", question: q, answer: "Yes, since the migration.", scope: { type: "host", key: "host-7f1c" } });
    expect(m.recall(finding).applicable.map((l) => l.id)).toEqual([host.id, name.id, addr.id]);
    expect(m.answered(finding, "  is the ORIGIN behind the tunnel on purpose? ")).toEqual(host);
    expect(m.answered(finding, "Who owns this name?")).toEqual(name);
    expect(m.answered(finding, "Is this address ours?")).toEqual(addr);
    expect(m.answered(finding, "A question nobody answered")).toBeNull();
    expect(m.answered(finding, q, "2027-01-01T00:00:00Z")).toBeNull();                     // lapsed: ask again
    expect(m.recall(finding, "2027-01-01T00:00:00Z").expired.map((l) => l.id)).toEqual([host.id, name.id, addr.id]);
    expect(m.recall({ ...finding, refers_to_type: "upstream", refers_to_id: "app_backend", dns_name: null }).applicable.map((l) => l.id)).toEqual([host.id, addr.id]);
  });
});

describe("TechnicianMemory: the store", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "drift-memory-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("persists in the store's own directory (state.json, ledger.jsonl) and a new instance over the same directory recalls the same lessons", () => {
    const a = new TechnicianMemory({ storage: "local", directory: dir, clock: () => T0 });
    expect(a.directory).toBe(path.resolve(dir));
    expect(a.readOnly).toBe(false);
    const e = a.recordException({ tenantId: "client-a", findingClass: "proxied_without_real_ip", scopeKey: "host-7f1c", reason: "accepted", expiresAt: EXPIRES, provenance: prov });
    const q = a.recordAnswer({ tenantId: "client-a", question: "Q?", answer: "A.", scope: { type: "address", key: "203.0.113.77" }, expiresAt: EXPIRES, provenance: { kind: "cli", at: "2026-10-24T11:59:00Z", by: "technician" } });
    expect(existsSync(path.join(a.directory!, "state.json"))).toBe(true);
    expect(existsSync(path.join(a.directory!, "ledger.jsonl"))).toBe(true);

    const b = new TechnicianMemory({ storage: "local", directory: dir, clock: () => T0 + 1000 });
    expect(b.lessons()).toEqual([e, q]);
    expect(b.recall(finding).applicable).toEqual([e, q]);
    expect(b.hmem.ledger.history(e.id).map((h) => h.action)).toEqual(["create", "read"]);
    const read = b.hmem.ledger.history(e.id).at(-1)!;
    expect(read.actor).toBe("technician-memory");
    expect(read.details).toMatchObject({ finding_class: "proxied_without_real_ip", tenant_id: "client-a", expired: false });
    expect(JSON.parse(readFileSync(path.join(a.directory!, "state.json"), "utf8")).records.map(lessonOf)).toEqual([e, q]);
  });

  it("opened read only, it loads the store as it stands and recalls from it, refuses to record or withdraw, and leaves both files byte for byte; a directory with no store opens empty and is not created", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "drift-memory-read-"));
    try {
      const w = new TechnicianMemory({ storage: "local", directory: d, clock: () => T0 });
      const e = w.recordException({ tenantId: "client-a", findingClass: "proxied_without_real_ip", scopeKey: "host-7f1c", reason: "accepted", expiresAt: EXPIRES, provenance: prov });
      const files = [path.join(d, "state.json"), path.join(d, "ledger.jsonl")];
      const before = files.map((f) => readFileSync(f, "utf8"));
      const r = new TechnicianMemory({ storage: "read", directory: d, clock: () => T0 + 1000 });
      expect([r.directory, r.readOnly]).toEqual([path.resolve(d), true]);
      expect(r.lessons()).toEqual([e]);
      expect(r.exceptionFor(finding)).toEqual(e);
      // the recall is logged in this process's ledger, which starts empty: the store's own ledger.jsonl is not read or written
      expect(r.hmem.ledger.history(e.id).map((h) => h.action)).toEqual(["read"]);
      const base = { tenantId: "client-a", findingClass: "orphan_vhost" as const, scopeKey: "host-7f1c", reason: "r", expiresAt: EXPIRES, provenance: prov };
      expect(() => r.recordException(base)).toThrow(MemoryError);
      expect(() => r.recordException(base)).toThrow(/exception refused: the store at .* is open read-only/);
      expect(() => r.recordAnswer({ tenantId: "client-a", question: "q", answer: "a", scope: { type: "host", key: "host-7f1c" }, expiresAt: EXPIRES, provenance: prov })).toThrow(/answer refused: .*open read-only/);
      expect(() => r.forget(e.id, "withdrawn")).toThrow(/forget refused: .*open read-only/);
      expect(r.lessons()).toEqual([e]);
      expect(files.map((f) => readFileSync(f, "utf8"))).toEqual(before);
      const none = path.join(d, "absent");
      expect(new TechnicianMemory({ storage: "read", directory: none }).lessons()).toEqual([]);
      expect(existsSync(none)).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("the lesson is a long_term H-MEM record of the technician with confidence 1, per-tenant chatId and the reference's own provenance shape", () => {
    const m = mem();
    const l = m.recordException({ tenantId: "client-a", findingClass: "orphan_vhost", scopeKey: "host-7f1c", reason: "kept for the migration", expiresAt: EXPIRES, provenance: prov });
    const rec = m.hmem.store.get(l.id)!;
    expect(rec).toMatchObject({ layer: "long_term", type: "preference", confidence: 1, source: "technician:cli", chatId: "client-a", provenance: { origin: "user_correction", learnedAt: Date.parse(prov.at), refs: [prov.runId] } });
    expect(rec.content).toBe(`Accepted exception for orphan_vhost on host-7f1c (client-a) until ${EXPIRES}: kept for the migration`);
    expect(m.hmem.query("orphan_vhost host-7f1c", { threshold: 0 }).memories[0].memory.id).toBe(l.id);
  });
});

describe("TechnicianMemory: redaction and validation", () => {
  it("free text is redacted before it is stored: a hostname, an address and a mailbox typed into a reason or an answer become pseudonyms; a pseudonymous scope key is stored as given", () => {
    const m = mem();
    const l = m.recordException({ tenantId: "client-a", findingClass: "proxy_split", scopeKey: "host-7f1c", reason: "origin sits behind app.corp-example.net at 198.18.0.9", expiresAt: EXPIRES, provenance: { ...prov, by: "ops@corp-example.net" } });
    expect(l.reason).toMatch(/^origin sits behind host-[0-9a-f]{6}\.net at ip-[0-9a-f]{6}$/);
    expect(l.provenance.by).toMatch(/^mail-[0-9a-f]{6}@domain-[0-9a-f]{6}$/);
    expect(l.scopeKey).toBe("host-7f1c");
    const state = JSON.stringify(m.hmem.store.all()) + JSON.stringify(m.hmem.ledger.all());
    expect(state).not.toContain("corp-example");
    expect(state).not.toContain("198.18.0.9");
    const a = m.recordAnswer({ tenantId: "client-a", question: "Where does 198.18.0.9 live?", answer: "In the office on 203.0.113.9", scope: { type: "host", key: "host-7f1c" }, expiresAt: EXPIRES, provenance: prov });
    expect(a.question).toMatch(/^Where does ip-[0-9a-f]{6} live\?$/);
    expect(a.answer).toBe("In the office on 203.0.113.9");          // a documentation address passes through
  });

  it("a scope key the redactor would replace (a real hostname, address or mailbox) is refused before anything is stored, and the refusal never echoes it; pseudonyms and documentation names pass", () => {
    const m = mem();
    const base = { tenantId: "client-a", findingClass: "proxy_split" as const, reason: "r", expiresAt: EXPIRES, provenance: prov };
    for (const real of ["app.corp-example.net", "198.18.0.9", "ops@corp-example.net"]) {
      expect(() => m.recordException({ ...base, scopeKey: real })).toThrow(MemoryError);
      expect(() => m.recordException({ ...base, scopeKey: real })).toThrow(/scopeKey a scope key must be a pseudonym/);
      try { m.recordException({ ...base, scopeKey: real }); } catch (err) { expect((err as Error).message).not.toContain(real); }
      expect(() => m.recordAnswer({ tenantId: "client-a", question: "q", answer: "a", scope: { type: "name", key: real }, expiresAt: EXPIRES, provenance: prov })).toThrow(/scope\.key a scope key must be a pseudonym/);
    }
    expect(m.hmem.store.all()).toEqual([]);
    expect(m.lessons()).toEqual([]);
    // what the findings carry: a host pseudonym, a pseudonymised name, a documentation name, a documentation address
    for (const fine of ["host-7f1c", "host-524b42.quest", "app.example.invalid", "203.0.113.77"]) {
      expect(m.recordException({ ...base, scopeKey: fine }).scopeKey).toBe(fine);
    }
    expect(m.lessons()).toHaveLength(4);
  });

  it("refuses a malformed lesson before anything is stored: non-ISO or non-UTC expiry, an expiry before it was taught, a scope key with whitespace, an unknown class, an empty reason", () => {
    const m = mem();
    const base = { tenantId: "client-a", findingClass: "proxy_split" as const, scopeKey: "host-7f1c", reason: "r", expiresAt: EXPIRES, provenance: prov };
    expect(() => m.recordException({ ...base, expiresAt: "2026-11-30" })).toThrow(MemoryError);
    expect(() => m.recordException({ ...base, expiresAt: "2026-11-30T00:00:00+02:00" })).toThrow(/expiresAt/);
    expect(() => m.recordException({ ...base, expiresAt: "2026-10-24T11:58:00Z" })).toThrow(/cannot expire before it was taught/);
    expect(() => m.recordException({ ...base, scopeKey: "host 7f1c" })).toThrow(/scopeKey/);
    expect(() => m.recordException({ ...base, findingClass: "made_up" as never })).toThrow(/findingClass/);
    expect(() => m.recordException({ ...base, reason: "   " })).toThrow(/reason/);
    expect(() => m.recordAnswer({ tenantId: "client-a", question: "q", answer: "a", scope: { type: "zone" as never, key: "x" }, expiresAt: EXPIRES, provenance: prov })).toThrow(/scope\.type/);
    expect(() => m.recordAnswer({ tenantId: "client-a", question: "q", answer: "a", scope: { type: "host", key: "host-7f1c" }, expiresAt: EXPIRES, provenance: { ...prov, by: "" } })).toThrow(/provenance\.by/);
    expect(() => m.recall(finding, "yesterday")).toThrow(/recall at/);
    expect(m.hmem.store.all()).toEqual([]);
    expect(m.lessons()).toEqual([]);
  });

  it("the re-exported HMEM is the reference: a record with no source is rejected by construction", () => {
    const h = new HMEM({ clock: () => T0 });
    expect(() => h.add({ content: "no source", source: "" })).toThrow(/source/);
    expect(h.add({ content: "with a source", source: "test" }).id).toBe("mem-1");
  });
});

describe("DRIFT_MEMORY_DIR: the store every script opens", () => {
  it("blank is .world/memory, which .gitignore keeps out, and examples/memory in sample mode; a value is that directory, trimmed; TechnicianMemory opens it when given no directory", () => {
    expect(DEFAULT_MEMORY_DIR).toBe(".world/memory");
    expect(memoryDir("", false)).toBe(".world/memory");
    expect(memoryDir("   ", false)).toBe(".world/memory");
    expect(memoryDir(" examples/memory ", false)).toBe("examples/memory");
    // sample mode: blank is the committed store under the repository root, wherever the command runs; a value still wins
    expect(SAMPLE_MEMORY_DIR).toBe(path.join(ROOT, "examples", "memory"));
    expect(memoryDir("", true)).toBe(SAMPLE_MEMORY_DIR);
    expect(memoryDir("  ", true)).toBe(SAMPLE_MEMORY_DIR);
    expect(memoryDir(" .world/memory ", true)).toBe(".world/memory");
    expect(readFileSync(path.join(ROOT, ".gitignore"), "utf8").split(/\r?\n/)).toContain(".world/");
    expect(new TechnicianMemory({ storage: "read" }).directory).toBe(path.resolve(config.memoryDir));
    expect(new TechnicianMemory().directory).toBeNull();
  });

  it("npm run answer -- --list reads the directory DRIFT_MEMORY_DIR names, and .world/memory under the working directory when it is blank", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "drift-memory-env-"));
    try {
      new TechnicianMemory({ storage: "local", directory: d, clock: () => T0 })
        .recordException({ tenantId: "client-a", findingClass: "proxied_without_real_ip", scopeKey: "host-7f1c", reason: "accepted", expiresAt: EXPIRES, provenance: prov });
      const list = (value: string) => spawnSync(process.execPath, ["--import", "tsx", "scripts/answer.ts", "--list"], {
        cwd: ROOT, encoding: "utf8", timeout: 60_000, env: { ...process.env, DRIFT_MEMORY_DIR: value },
      });
      const set = list(d);
      expect(set.status).toBe(0);
      expect(set.stdout.split("\n")[0]).toBe(`1 lesson(s) in ${path.resolve(d)}`);
      expect(set.stdout).toContain("exception  proxied_without_real_ip on host-7f1c (client-a)  until 2026-11-30T00:00:00.000Z");
      // a value already in the environment wins over .env (process.loadEnvFile sets only what is unset), so blank means blank
      const blank = list("");
      expect(blank.status).toBe(0);
      expect(blank.stdout.split("\n")[0].endsWith(` lesson(s) in ${path.join(ROOT, ".world", "memory")}`)).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("H-MEM conformance through src/engine/memory.ts", () => {
  it("the vendored runner passes 13/13 against our module in a spawned process", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "vendor/hmem/conformance/runner.ts"], {
      cwd: ROOT, encoding: "utf8", timeout: 120_000,
      env: { ...process.env, HMEM_IMPL: path.join(ROOT, "src", "engine", "memory.ts").replace(/\\/g, "/") },
    });
    expect(r.stdout).toContain("H-MEM conformance: implementation = ");
    expect(r.stdout).toContain("src/engine/memory.ts");
    expect(r.stdout).toContain("13/13 checks passed");
    expect(r.stdout).not.toContain("FAIL");
    expect(r.status).toBe(0);
  }, 120_000);
});
