// The vault (src/vault/) in a temp directory, with the Linux collector's own rows over the sites-enabled
// fixture (test/fixtures/nginx/sites: symlinks, a .bak, an unlinked site) and the Cloudflare collector over the
// fake API (test/fixtures/cloudflare). Three host runs: the fixture, then one file changed and one removed,
// then the same again; then a DNS run. Fixture names are .invalid or .example, so object ids read as the real
// paths; the synthetic real-looking zone of the Cloudflare fixture shows the vault holds the real name while
// the rows hold its pseudonym. The store is an in-memory stand-in for Store.insertVaultCopies, and the rows it
// receives load into sql.js through the same checks as the bundle loader; with DATABASE_URL set, the last block
// writes them through the real Store into a throwaway schema (skipped with one line otherwise).
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cloudflare, collectCloudflare, type CfAuditRow, type CfRecord, type CfZone } from "../src/collectors/cloudflare.ts";
import { MARK, parseStream, printable, toRows, type CollectResult, type Fetched } from "../src/collectors/linux.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { Store } from "../src/data/store.ts";
import { copyId, type VaultCopy } from "../src/data/rows.ts";
import { Redactor } from "../src/redactor.ts";
import { git } from "../src/vault/git.ts";
import { VAULT_OFF, captureRecords, cloudflareVaultFiles, linuxVaultFiles, recordJson, vaultCloudflareRun, vaultLinuxRun, type HookResult } from "../src/vault/hook.ts";
import { CLOUDFLARE_REPO, LINKS_FILE, PATHS_FILE, Vault, VaultError, sha256, stableJson, treePath, type VaultCommit } from "../src/vault/vault.ts";
import { TOKEN, fakeApi } from "./fixtures/cloudflare/fake-api.ts";
import zonesFile from "./fixtures/cloudflare/zones.json" with { type: "json" };
import recordsFile from "./fixtures/cloudflare/records.json" with { type: "json" };
import auditFile from "./fixtures/cloudflare/audit.json" with { type: "json" };
import { MemTracer } from "./fixtures/mem-tracer.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIX = fileURLToPath(new URL("./fixtures/nginx/sites/", import.meta.url));
const TENANT = "client-a";
const ALIAS = "vps-b";
const r = new Redactor("fixture-salt");
const tmp = mkdtempSync(path.join(tmpdir(), "drift-vault-"));
const vault = new Vault(tmp, r);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Every file of the sites fixture keyed by its absolute path on the host. */
function fixtureFiles(): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name !== "stream.txt") out.set(`/${path.relative(FIX, p).split(path.sep).join("/")}`, readFileSync(p));
    }
  };
  walk(FIX);
  return out;
}

const section = (kind: string, arg: string, rc: number, body: string): string => `${MARK} BEGIN ${kind} ${arg}\n${body}\n${MARK} END ${rc}\n`;
function fetched(o: { done?: boolean } = {}): Fetched {
  let text = readFileSync(path.join(FIX, "stream.txt"), "utf8");
  for (const [p, bytes] of fixtureFiles()) text += section("file", p, 0, bytes.toString("base64"));
  return parseStream(text + (o.done === false ? "" : `${MARK} DONE\n`));
}

type HostRun = Pick<CollectResult, "rows" | "files" | "links">;
const collect = (f: Fetched, at: string): HostRun => toRows(f, { tenantId: TENANT, redactor: r, alias: ALIAS, now: new Date(at) });

const PORTAL = "/etc/nginx/sites-available/portal.invalid";
const GAMES = "/etc/nginx/sites-available/games.invalid";

/** The fixture with portal.invalid edited and games.invalid gone from the listing and the fetch. */
function changed(): Fetched {
  const f = fetched();
  const portal = f.files[PORTAL];
  if (!portal.ok) throw new Error("fixture: portal.invalid is fetched");
  f.files[PORTAL] = { ok: true, bytes: new Uint8Array(Buffer.concat([Buffer.from(portal.bytes), Buffer.from("# edited after the first run\n")])) };
  delete f.files[GAMES];
  const listing = f.listings["/etc/nginx/sites-available"];
  listing.entries = listing.entries.filter((e) => e.name !== "games.invalid");
  return f;
}

class MemStore {
  rows: VaultCopy[] = [];
  async insertVaultCopies(rows: readonly VaultCopy[]): Promise<number> {
    const fresh = rows.filter((x) => !this.rows.some((y) => y.copy_id === x.copy_id));
    this.rows.push(...fresh);
    return fresh.length;
  }
}

const repoDir = vault.repoDir(TENANT, ALIAS);
const hostStatus = () => vault.status().find((s) => s.repo === ALIAS)!;
const tree = (commit: string): string => git(repoDir, ["rev-parse", `${commit}^{tree}`]).stdout.toString("utf8").trim();
const committed = (h: HookResult): VaultCommit => {
  if (h.status !== "committed") throw new Error(`expected a commit, got ${JSON.stringify(h)}`);
  return h.commit;
};

const store = new MemStore();
const run1 = collect(fetched(), "2026-10-24T15:32:01.000Z");
const run2 = collect(changed(), "2026-10-25T15:32:01.000Z");
const run3 = collect(changed(), "2026-10-26T15:32:01.000Z");
const commits: VaultCommit[] = [];

describe("vault, host runs", () => {
  it("the fixture runs are complete and carry the raw half: files keyed by real path, the sites-enabled links", () => {
    for (const run of [run1, run2, run3]) expect(run.rows.collection_run[0].status).toBe("complete");
    expect(Object.keys(run1.files)).toContain(PORTAL);
    expect(Object.keys(run2.files)).not.toContain(GAMES);
    expect(Object.keys(run1.files)).not.toContain("/etc/nginx/sites-enabled/portal.invalid");
    expect(run1.links).toEqual({
      "/etc/nginx/sites-enabled/default": "/etc/nginx/sites-available/default",
      "/etc/nginx/sites-enabled/origin.invalid": "/etc/nginx/sites-available/origin.invalid",
      "/etc/nginx/sites-enabled/portal.invalid": "/etc/nginx/sites-available/portal.invalid",
      "/etc/nginx/sites-enabled/shop.invalid": "/etc/nginx/sites-available/shop.invalid",
    });
    expect(Object.keys(run1.files)).toEqual([...Object.keys(run1.files)].sort());
  });

  it("two runs give two commits; the second holds the changed file and mirrors the removed one", { timeout: 20_000 }, async () => {
    commits.push(committed(await vaultLinuxRun(vault, store, run1, { tenantId: TENANT, alias: ALIAS, redactor: r })));
    commits.push(committed(await vaultLinuxRun(vault, store, run2, { tenantId: TENANT, alias: ALIAS, redactor: r })));
    const [c1, c2] = commits;
    expect(c1.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(c2.commit).not.toBe(c1.commit);
    expect(c1).toMatchObject({ repo: `${TENANT}/${ALIAS}`, reused: false, files: Object.keys(run1.files).length, added: Object.keys(run1.files).length, modified: 0, removed: 0 });
    expect(c2).toMatchObject({ reused: false, files: Object.keys(run1.files).length - 1, added: 0, modified: 1, removed: 1 });
    const t1 = vault.readTree(TENANT, ALIAS, c1.commit);
    const t2 = vault.readTree(TENANT, ALIAS, c2.commit);
    expect(t1.files.has(treePath(GAMES))).toBe(true);
    expect(t2.files.has(treePath(GAMES))).toBe(false);
    expect(t2.paths[GAMES]).toBeUndefined();
    expect(t2.files.get(treePath(PORTAL))!.equals(Buffer.from(run2.files[PORTAL]))).toBe(true);
    expect(t2.files.get(treePath(PORTAL))!.equals(t1.files.get(treePath(PORTAL))!)).toBe(false);
    expect(git(repoDir, ["log", "--format=%s%x09%an <%ae>"]).stdout.toString("utf8").trim().split("\n")).toEqual([
      `run ${run2.rows.collection_run[0].run_id} linux.nginx 2026-10-25T15:32:01.000Z\tdrift-agent <drift-agent@localhost>`,
      `run ${run1.rows.collection_run[0].run_id} linux.nginx 2026-10-24T15:32:01.000Z\tdrift-agent <drift-agent@localhost>`,
    ]);
    expect(git(repoDir, ["config", "--local", "core.autocrlf"]).stdout.toString("utf8").trim()).toBe("false");
  });

  it("every blob's sha256 equals its file observation's value_hash, and the vault_copy rows carry it and load into sql.js", async () => {
    for (const [i, run] of [run1, run2].entries()) {
      const c = commits[i];
      const t = vault.readTree(TENANT, ALIAS, c.commit);
      const fileRows = run.rows.observation.filter((o) => o.setting_path === "file");
      expect(Object.keys(t.paths)).toHaveLength(fileRows.length);
      expect(c.copies).toHaveLength(fileRows.length);
      for (const o of fileRows) {
        const real = Object.keys(t.paths).find((p) => t.paths[p] === o.object_id)!;
        expect(sha256(t.files.get(treePath(real))!)).toBe(o.value_hash);
        expect(c.copies.find((x) => x.object_id === o.object_id)).toEqual({
          copy_id: copyId(o.run_id, o.object_id), tenant_id: TENANT, surface: "linux.nginx", host: o.host, object_id: o.object_id,
          run_id: o.run_id, git_commit: c.commit, blob_sha256: o.value_hash, taken_at: run.rows.collection_run[0].started_at, source: "collector",
        });
      }
    }
    expect(store.rows).toHaveLength(commits[0].copies.length + commits[1].copies.length);
    const engine = await SqlJsEngine.create();
    expect(engine.insertRows("vault_copy", store.rows)).toBe(store.rows.length);
    expect(engine.insertRows("vault_copy", store.rows)).toBe(0);
    engine.close();
  });

  it("an unchanged run gives a new commit with the same tree", async () => {
    const c3 = committed(await vaultLinuxRun(vault, store, run3, { tenantId: TENANT, alias: ALIAS, redactor: r }));
    commits.push(c3);
    expect(c3.commit).not.toBe(commits[1].commit);
    expect(tree(c3.commit)).toBe(tree(commits[1].commit));
    expect(c3).toMatchObject({ added: 0, modified: 0, removed: 0, files: commits[1].files });
    expect(git(repoDir, ["rev-parse", `${c3.commit}^`]).stdout.toString("utf8").trim()).toBe(commits[1].commit);
    const status = hostStatus();
    expect(status).toMatchObject({ tenant: TENANT, repo: ALIAS, commits: 3, head: c3.commit, headRun: run3.rows.collection_run[0].run_id, headDate: "2026-10-26T15:32:01.000Z", files: c3.files });
    expect(status.objectIds).toEqual(Object.values(vault.readTree(TENANT, ALIAS).paths).sort());
  });

  it("a run committed again returns its commit after its blobs read back equal, and writes nothing", async () => {
    const again = committed(await vaultLinuxRun(vault, store, run2, { tenantId: TENANT, alias: ALIAS, redactor: r }));
    expect(again).toMatchObject({ reused: true, commit: commits[1].commit });
    expect(hostStatus().commits).toBe(3);
    expect(vault.commitOf(TENANT, ALIAS, run2.rows.collection_run[0].run_id)).toBe(commits[1].commit);
    const before = store.rows.length;
    expect((await vaultLinuxRun(vault, store, run2, { tenantId: TENANT, alias: ALIAS, redactor: r })).status).toBe("committed");
    expect(store.rows).toHaveLength(before);
  });

  it("paths.json and links.json are sorted, in the stable JSON form, and byte-identical across unchanged runs", () => {
    const blob = (c: string, p: string): string => git(repoDir, ["show", `${c}:${p}`]).stdout.toString("utf8");
    for (const c of commits) {
      for (const f of [PATHS_FILE, LINKS_FILE]) {
        const text = blob(c.commit, f);
        const parsed = JSON.parse(text) as Record<string, string>;
        expect(Object.keys(parsed)).toEqual(Object.keys(parsed).sort());
        expect(text).toBe(stableJson(parsed));
      }
    }
    expect(blob(commits[1].commit, PATHS_FILE)).toBe(blob(commits[2].commit, PATHS_FILE));
    expect(JSON.parse(blob(commits[0].commit, LINKS_FILE))).toEqual(run1.links);
    expect(JSON.parse(blob(commits[0].commit, PATHS_FILE))[PORTAL]).toBe(PORTAL);
    const t = vault.readTree(TENANT, ALIAS, commits[0].commit);
    expect(t.links).toEqual(run1.links);
    expect([...t.files.keys()].every((p) => !p.startsWith(".drift/"))).toBe(true);
    expect(vault.treeOf(commits[0].copies[0])).toEqual({ ...t, repo: ALIAS });
    expect(vault.repoOf(TENANT, "0".repeat(40))).toBeNull();
    expect(vault.repoOf("client-z", commits[0].commit)).toBeNull();
  });
});

describe("vault hook outcomes", () => {
  it("a vault that is off says so in one trace line; a partial run commits nothing and the trace says so", async () => {
    const tracer = new MemTracer("vault-test", { model: "none" });
    expect(await vaultLinuxRun(null, store, run1, { tenantId: TENANT, alias: ALIAS, redactor: r, tracer })).toEqual({ status: "off" });
    expect(tracer.events).toHaveLength(1);
    expect(tracer.events[0]).toMatchObject({ agent: "vault", status: "skipped", output_summary: VAULT_OFF });
    const partial = collect(fetched({ done: false }), "2026-10-27T15:32:01.000Z");
    expect(partial.rows.collection_run[0].status).toBe("partial");
    const h = await vaultLinuxRun(vault, store, partial, { tenantId: TENANT, alias: ALIAS, redactor: r, tracer });
    expect(h).toEqual({ status: "skipped", reason: `run ${partial.rows.collection_run[0].run_id} is partial; nothing committed` });
    expect(tracer.events[1].output_summary).toMatch(/is partial; nothing committed$/);
    expect(hostStatus().commits).toBe(3);
    expect(() => vault.commitRun({ tenantId: TENANT, repo: ALIAS, run: partial.rows.collection_run[0], files: [] })).toThrow(/commits complete runs only/);
  });

  it("bytes that differ from their file observation are refused before anything is written", async () => {
    const run = collect(fetched(), "2026-10-28T15:32:01.000Z");
    const tampered = { ...run, files: { ...run.files, [PORTAL]: new Uint8Array(Buffer.from("server { }\n")) } };
    expect(() => linuxVaultFiles(tampered, r)).toThrow(/another hash/);
    const missing = { ...run, files: Object.fromEntries(Object.entries(run.files).filter(([p]) => p !== PORTAL)) };
    expect(() => linuxVaultFiles(missing, r)).toThrow(/without fetched bytes/);
    const tracer = new MemTracer("vault-test", { model: "none" });
    const h = await vaultLinuxRun(vault, store, tampered, { tenantId: TENANT, alias: ALIAS, redactor: r, tracer });
    expect(h.status).toBe("failed");
    expect(tracer.events[0]).toMatchObject({ agent: "vault", status: "failed" });
    expect(hostStatus().commits).toBe(3);
  });

  it("the dry run and --out print the redacted half: a token in a fetched file reaches the vault and stays out of the printed JSON", async () => {
    const f = fetched();
    const token = "fixture0vault0probe0abcdef0123456789";
    const portal = f.files[PORTAL];
    if (!portal.ok) throw new Error("fixture: portal.invalid is fetched");
    const bytes = Buffer.concat([Buffer.from(portal.bytes), Buffer.from(`# Authorization: Bearer ${token}\n`)]);
    f.files[PORTAL] = { ok: true, bytes: new Uint8Array(bytes) };
    const full = toRows(f, { tenantId: TENANT, redactor: r, alias: ALIAS, now: new Date("2026-10-29T15:32:01.000Z") });
    const res: CollectResult = { rows: full.rows, summary: full.summary, files: full.files, links: full.links, ssh: { code: 0, latencyMs: 1, stderr: "", bytes: 1 } };
    const out = printable(res);
    expect(Object.keys(out)).toEqual(["summary", "rows"]);
    const text = JSON.stringify(out);
    expect(text).not.toContain(token);
    expect(text).not.toContain(bytes.toString("base64"));
    expect(text).toContain("<secret:bearer:");
    const c = committed(await vaultLinuxRun(vault, store, res, { tenantId: TENANT, alias: ALIAS, redactor: r }));
    expect(vault.readTree(TENANT, ALIAS, c.commit).files.get(treePath(PORTAL))!.toString("utf8")).toContain(`Bearer ${token}`);
  });

  it("the vault root must be absolute and outside this checkout; a path the vault cannot hold is refused", () => {
    expect(Vault.fromEnv({ dir: "" })).toBeNull();
    expect(Vault.fromEnv({ dir: "  " })).toBeNull();
    expect(() => new Vault("relative/vault", r)).toThrow(/absolute/);
    expect(() => new Vault(path.join(ROOT, "vault"), r)).toThrow(/inside this checkout/);
    expect(treePath("/etc/nginx/conf.d/a.conf")).toBe("etc/nginx/conf.d/a.conf");
    for (const bad of ["/etc/../x", "/etc//x", "/etc/nginx/a:b", "/.git/config", "/.drift/paths.json", "/etc/nginx/x.", "/etc/nul", "/etc/a\\b", "/"]) {
      expect(() => treePath(bad)).toThrow(VaultError);
    }
    expect(() => vault.repoDir("../x", ALIAS)).toThrow(VaultError);
    expect(() => vault.repoDir(TENANT, "a/b")).toThrow(VaultError);
  });

  it.skipIf(process.platform !== "win32")("on win32 a repository directory over 246 characters is refused before git runs", () => {
    const deep = new Vault(path.join(tmpdir(), "x".repeat(240)), r);
    expect(() => deep.repoDir(TENANT, ALIAS)).toThrow(/at most 246/);
  });
});

describe("vault, Cloudflare runs", () => {
  const ZONES = zonesFile as CfZone[];
  const RECORDS = Object.fromEntries(Object.entries(recordsFile).filter(([k]) => !k.startsWith("_"))) as Record<string, CfRecord[]>;

  it("recordJson writes id, name, type, content, ttl, proxied in that order, whatever order the record came in", () => {
    const rec = RECORDS[ZONES[0].id][1];
    const shuffled = Object.fromEntries(Object.entries(rec).reverse()) as unknown as CfRecord;
    expect(recordJson(shuffled)).toBe(recordJson(rec));
    expect(Object.keys(JSON.parse(recordJson(rec)))).toEqual(["id", "name", "type", "content", "ttl", "proxied"]);
    expect(recordJson({ id: "x1", name: "a.example", type: "TXT", content: "v=spf1 -all" })).toBe('{\n  "id": "x1",\n  "name": "a.example",\n  "type": "TXT",\n  "content": "v=spf1 -all",\n  "ttl": null,\n  "proxied": null\n}\n');
  });

  it("one repository per tenant holds <zone>/<record_id>.json per record of the run, real names in the vault and pseudonyms in the rows", async () => {
    const fake = fakeApi({ zones: ZONES, records: structuredClone(RECORDS), audit: auditFile as unknown as CfAuditRow[], now: new Date("2026-10-24T05:00:00.000Z") });
    const cf = new Cloudflare({ token: TOKEN, fetch: fake.fetch });
    const raw = captureRecords(cf);
    const c = await collectCloudflare(cf, r, { tenantId: TENANT, now: () => new Date("2026-10-24T05:00:00.000Z") });
    expect(c.dnsRun.status).toBe("complete");
    expect(raw.map((z) => z.zone)).toEqual(ZONES.map((z) => z.name));
    const files = cloudflareVaultFiles(c, raw, r);
    expect(files).toHaveLength(c.records.length);
    const tracer = new MemTracer("vault-test", { model: "none" });
    const commit = committed(await vaultCloudflareRun(vault, store, c, raw, { redactor: r, tracer }));
    expect(commit).toMatchObject({ repo: `${TENANT}/${CLOUDFLARE_REPO}`, files: c.records.length, added: c.records.length });
    expect(tracer.events[0].output_summary).toMatch(new RegExp(`committed to ${TENANT}/${CLOUDFLARE_REPO} at [0-9a-f]{12}: ${c.records.length} file\\(s\\)`));
    const t = vault.readTree(TENANT, CLOUDFLARE_REPO, commit.commit);
    for (const z of raw) {
      for (const rec of z.records) {
        const file = t.files.get(`${z.zone}/${rec.id}.json`)!;
        expect(file.toString("utf8")).toBe(recordJson(rec));
        expect(t.paths[`${z.zone}/${rec.id}.json`]).toBe(rec.id);
        const copy = commit.copies.find((x) => x.object_id === rec.id)!;
        expect(copy).toMatchObject({ surface: "cloudflare.dns", host: null, run_id: c.dnsRun.run_id, git_commit: commit.commit, blob_sha256: sha256(file), taken_at: c.dnsRun.started_at });
      }
    }
    const realZone = ZONES[1].name;
    expect([...t.files.keys()].some((p) => p.startsWith(`${realZone}/`))).toBe(true);
    expect(JSON.stringify(c.records)).not.toContain(realZone);
    expect(JSON.stringify(commit.copies)).not.toContain(realZone);
    expect(() => cloudflareVaultFiles({ ...c, records: c.records.slice(1) }, raw, r)).toThrow(VaultError);
    const edited = raw.map((z) => ({ ...z, records: z.records.map((x, i) => (i === 0 ? { ...x, content: "203.0.113.99" } : x)) }));
    expect(() => cloudflareVaultFiles(c, edited, r)).toThrow(/does not give the run's stored row/);
  });
});

const url = process.env.DATABASE_URL;
if (!url) console.log("vault: live Postgres half skipped (set DATABASE_URL in .env to run it)");

describe.skipIf(!url)("vault_copy through the Store, live drift-pg (throwaway schema)", () => {
  const schema = `test_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let pgStore: Store;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pgStore = Store.fromEnv({ schema });
    await pgStore.applySchema();
  });

  afterAll(async () => {
    await pgStore?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("the hook's rows go in once: a re-run of the hook writes 0, and the stored rows equal the commit's", async () => {
    const h = await vaultLinuxRun(vault, pgStore, run1, { tenantId: TENANT, alias: ALIAS, redactor: r });
    const c = committed(h);
    expect(c).toMatchObject({ reused: true, commit: commits[0].commit });
    expect(h.status === "committed" && h.written).toBe(c.copies.length);
    expect(committed(await vaultLinuxRun(vault, pgStore, run1, { tenantId: TENANT, alias: ALIAS, redactor: r })).copies).toHaveLength(c.copies.length);
    expect(await pgStore.insertVaultCopies(c.copies)).toBe(0);
    expect(await pgStore.rowsOf("vault_copy", { run_id: run1.rows.collection_run[0].run_id })).toEqual(c.copies);
  });
});
