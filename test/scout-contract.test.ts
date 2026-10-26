// The execution contract (src/guard/contract.ts) and the Actor behind it (src/actions/act.ts). The contract is the
// Nightshift receipt's envelope signed with the deployment's Ed25519 key, so the unit tests check it with the receipt
// code (verifyReceipt) and with node:crypto on its own. The Actor tests run the lab-fixture world of test/actions.test.ts:
// a valid contract passes, and an unsigned, altered, foreign-key, expired, wrong-object, wrong-action or capability-
// widened one is refused before a byte reaches the fake host, the fake Cloudflare or the stubbed model, with a refused
// action row and a trace line that says why.
import { spawnSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "../src/config.ts";
import { act, type ActResult } from "../src/actions/act.ts";
import { FIX_REFUSED } from "../src/actions/investigate.ts";
import { liveActorDeps } from "../src/actions/live.ts";
import { targetOf, type ActionOutcome } from "../src/actions/plan.ts";
import { canonicalReceiptBody, receiptKeyFingerprint, verifyReceipt, type SignedReceipt } from "../src/adapters/nightshift.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { DataLayer } from "../src/data/layer.ts";
import { objects, tenantActions } from "../src/data/queries.ts";
import { actionId, type Action, type ActionKind, type Disposition } from "../src/data/rows.ts";
import {
  CAPABILITIES, CONTRACT_KIND, CONTRACT_TTL_MS, ContractKey, DEFAULT_KEY_FILE, LocalContractAuthority, contractLine, type GatedKind,
  type ContractScope, type SignedContract,
} from "../src/guard/contract.ts";
import { GUARD_VERSION } from "../src/guard/scout.ts";
import { Redactor } from "../src/redactor.ts";
import { APP, BLOG, TENANT, buildBase, buildWorld, type Base, type World } from "./fixtures/actions/world.ts";
/** verifyReceipt under the key the contract carries: the deployment's own key, not the pinned Nightshift key. */const selfVerify = (r: SignedReceipt): boolean => verifyReceipt(r, [receiptKeyFingerprint(r.pubkey_b64)]);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NOW = new Date("2026-10-23T03:04:00.000Z");
const minutes = (n: number): Date => new Date(NOW.getTime() + n * 60_000);
const SCOPE: ContractScope = {
  tenant_id: "client-a", action: "rollback_file", action_id: "act-0000000000000001", disposition_id: "disp-0000000000000001",
  object: "linux.nginx host-7f1c /etc/nginx/conf.d/app.conf file",
};

/** A contract with fields changed and the signature made again under `key`: valid for the key, wrong in content. */
function forge(key: ContractKey, c: SignedContract, patch: Record<string, unknown>): SignedContract {
  const body = { receipt: { ...c.body.receipt, ...patch } } as SignedContract["body"];
  return { body, pubkey_b64: key.publicB64, sig_b64: key.sign(body) };
}
const refusalOf = (r: ReturnType<LocalContractAuthority["verify"]>): [string, string] => (r.ok ? ["ok", ""] : [r.refusal, r.reason]);

describe("the execution contract", () => {
  const key = ContractKey.generate();
  const auth = new LocalContractAuthority(() => key);
  const good = auth.issue(SCOPE, NOW);

  it("holds the action, the object, the exact capability set, five minutes and an Ed25519 signature", () => {
    expect(good.body.receipt).toEqual({
      kind: CONTRACT_KIND, contract_id: expect.stringMatching(/^ctr-[0-9a-f]{16}$/), ...SCOPE,
      capabilities: ["host:write", "nginx:reload", "probe:run", "vault:read"],
      issued_at: "2026-10-23T03:04:00.000Z", expires_at: "2026-10-23T03:09:00.000Z", signed_by: "scout", policy: GUARD_VERSION,
    });
    expect(CONTRACT_TTL_MS).toBe(5 * 60_000);
    expect(Buffer.from(good.pubkey_b64, "base64")).toHaveLength(32);
    expect(Buffer.from(good.sig_b64, "base64")).toHaveLength(64);
    expect(good.pubkey_b64).toBe(key.publicB64);
    for (const [kind, caps] of Object.entries(CAPABILITIES)) expect([...caps], kind).toEqual([...caps].sort());
    expect(auth.issue({ ...SCOPE, action: "investigate" }, NOW).body.receipt.capabilities).toEqual(["data:read", "model:call", "probe:read"]);
  });

  it("is signed and checked by the receipt code: Nightshift's canonical body, verifyReceipt, and Ed25519 from node:crypto alone", () => {
    expect(selfVerify(good as unknown as SignedReceipt)).toBe(true);
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(good.pubkey_b64, "base64")]);
    const pub = createPublicKey({ key: spki, format: "der", type: "spki" });
    expect(verify(null, Buffer.from(canonicalReceiptBody(good.body), "utf8"), pub, Buffer.from(good.sig_b64, "base64"))).toBe(true);
    expect(selfVerify({ ...good, body: { receipt: { ...good.body.receipt, object: "other" } } } as unknown as SignedReceipt)).toBe(false);
  });

  it("is deterministic for one scope and instant, and differs by instant", () => {
    expect(auth.issue(SCOPE, NOW).body.receipt.contract_id).toBe(good.body.receipt.contract_id);
    expect(auth.issue(SCOPE, minutes(1)).body.receipt.contract_id).not.toBe(good.body.receipt.contract_id);
  });

  it("passes while it is valid: from its issue to the last millisecond before it expires", () => {
    for (const at of [NOW, minutes(1), new Date(NOW.getTime() + CONTRACT_TTL_MS - 1)]) {
      const r = auth.verify(good, SCOPE, at);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.contract).toEqual(good.body.receipt);
    }
    expect(contractLine(good.body.receipt)).toBe(
      `execution contract ${good.body.receipt.contract_id} verified: rollback_file on ${SCOPE.object}, capabilities host:write, nginx:reload, probe:run, vault:read, issued 2026-10-23T03:04:00.000Z, expires 2026-10-23T03:09:00.000Z, signed by scout (Ed25519, ${GUARD_VERSION})`,
    );
  });

  it("refuses an unsigned contract: nothing presented, no envelope, no signature, no key", () => {
    for (const presented of [undefined, null, "contract", {}, { body: {} }, { ...good, sig_b64: "" }, { ...good, pubkey_b64: "" }, { ...good, sig_b64: undefined }]) {
      expect(refusalOf(auth.verify(presented, SCOPE, NOW))[0], JSON.stringify(presented)?.slice(0, 40)).toBe("unsigned");
    }
    expect(refusalOf(auth.verify(undefined, SCOPE, NOW))).toEqual(["unsigned", "no signed contract was presented"]);
    expect(refusalOf(auth.verify({ ...good, sig_b64: "" }, SCOPE, NOW))).toEqual(["unsigned", "the contract carries no signature"]);
  });

  it("refuses a contract altered after it was signed, and one signed by a key this deployment does not hold", () => {
    const widened = structuredClone(good);
    widened.body.receipt.capabilities.push("shell:exec");
    expect(refusalOf(auth.verify(widened, SCOPE, NOW))).toEqual(["bad-signature", "the signature does not match the contract's bytes"]);
    const longer = structuredClone(good);
    longer.body.receipt.expires_at = "2026-10-24T03:04:00.000Z";
    expect(refusalOf(auth.verify(longer, SCOPE, NOW))[0]).toBe("bad-signature");
    const foreign = LocalContractAuthority.ephemeral().issue(SCOPE, NOW);
    expect(selfVerify(foreign as unknown as SignedReceipt)).toBe(true);
    expect(refusalOf(auth.verify(foreign, SCOPE, NOW))).toEqual(["bad-signature", "the contract is signed by a key this deployment does not hold"]);
  });

  it("refuses an expired contract at the instant it expires and after, a contract dated ahead, and a lifetime past five minutes", () => {
    expect(refusalOf(auth.verify(good, SCOPE, minutes(5)))).toEqual(["expired", "the contract expired at 2026-10-23T03:09:00.000Z; it was checked at 2026-10-23T03:09:00.000Z"]);
    expect(refusalOf(auth.verify(good, SCOPE, minutes(60)))[0]).toBe("expired");
    expect(refusalOf(auth.verify(auth.issue(SCOPE, minutes(10)), SCOPE, NOW))[0]).toBe("not-yet-valid");
    expect(refusalOf(auth.verify(forge(key, good, { expires_at: minutes(15).toISOString() }), SCOPE, NOW))).toEqual(["ttl-too-long", "the contract lives 900 s; the limit is 300 s"]);
  });

  it("checks in the order the file header documents, so a contract that fails two ways reports the earlier one, and every reason is reached", () => {
    const header = readFileSync(path.join(ROOT, "src", "guard", "contract.ts"), "utf8");
    const order = ["unsigned", "bad-signature", "malformed", "expired", "not-yet-valid", "ttl-too-long", "scope-mismatch"];
    const at = header.indexOf("Checks, in the spec's order");
    const named = order.map((r) => header.indexOf(r, at));
    expect(named.every((i) => i > at)).toBe(true);
    expect([...named].sort((a, b) => a - b)).toEqual(named);
    const other = { ...SCOPE, object: "linux.nginx host-7f1c /etc/nginx/conf.d/blog.conf file" };
    const stale = { issued_at: minutes(-30).toISOString(), expires_at: minutes(-1).toISOString() };
    const ahead = { issued_at: minutes(5).toISOString(), expires_at: minutes(25).toISOString() };
    const cases: [string, unknown, ContractScope, string][] = [
      ["unsigned and expired", { ...auth.issue(SCOPE, minutes(-10)), sig_b64: "" }, SCOPE, "unsigned"],
      ["foreign key and expired", LocalContractAuthority.ephemeral().issue(SCOPE, minutes(-10)), SCOPE, "bad-signature"],
      ["malformed and expired", forge(key, good, { kind: "receipt", ...stale }), SCOPE, "malformed"],
      ["expired and over five minutes", forge(key, good, stale), SCOPE, "expired"],
      ["expired and out of scope", auth.issue(SCOPE, minutes(-10)), other, "expired"],
      ["dated ahead and over five minutes", forge(key, good, ahead), SCOPE, "not-yet-valid"],
      ["over five minutes and out of scope", forge(key, good, { expires_at: minutes(15).toISOString() }), other, "ttl-too-long"],
      ["out of scope alone", good, other, "scope-mismatch"],
    ];
    for (const [name, presented, expect_, refusal] of cases) expect(refusalOf(auth.verify(presented, expect_, NOW))[0], name).toBe(refusal);
    // every reason of ContractRefusal is covered above or by the tests before this one
    expect(new Set(cases.map((c) => c[3]))).toEqual(new Set(order));
  });

  it("issues a lifetime of exactly five minutes whatever the instant, and rejects an action no contract grants", () => {
    for (const at of [NOW, minutes(-90), new Date("2027-01-01T00:00:00.000Z")]) {
      const c = auth.issue(SCOPE, at).body.receipt;
      expect(Date.parse(c.expires_at) - Date.parse(c.issued_at)).toBe(CONTRACT_TTL_MS);
    }
    expect(Object.keys(CAPABILITIES).sort()).toEqual(["investigate", "revert_record", "rollback_file"]);
    const fix = forge(key, good, { action: "fix", capabilities: ["action:record"] });
    expect(refusalOf(auth.verify(fix, { ...SCOPE, action: "fix" as GatedKind }, NOW))).toEqual(["scope-mismatch", "fix is not an action a contract grants"]);
  });

  it("refuses a body that is not an execution contract", () => {
    for (const patch of [{ kind: "receipt" }, { signed_by: "someone" }, { object: 7 }, { capabilities: "host:write" }, { capabilities: [1] }, { expires_at: "soon" }, { issued_at: "2026-10-23T03:09:00.000Z" }]) {
      expect(refusalOf(auth.verify(forge(key, good, patch), SCOPE, NOW))[0], JSON.stringify(patch)).toBe("malformed");
    }
  });

  it("refuses a contract for another tenant, action, action id, disposition or object, naming the field", () => {
    const other: Record<string, ContractScope> = {
      tenant_id: { ...SCOPE, tenant_id: "client-b" },
      action: { ...SCOPE, action: "revert_record" },
      action_id: { ...SCOPE, action_id: "act-0000000000000002" },
      disposition_id: { ...SCOPE, disposition_id: "disp-0000000000000002" },
      object: { ...SCOPE, object: "linux.nginx host-7f1c /etc/nginx/conf.d/blog.conf file" },
    };
    for (const [field, expect_] of Object.entries(other)) {
      const [refusal, reason] = refusalOf(auth.verify(good, expect_, NOW));
      expect([field, refusal]).toEqual([field, "scope-mismatch"]);
      expect(reason).toBe(`the contract is for ${field} ${good.body.receipt[field as keyof typeof good.body.receipt]}; this action has ${field} ${expect_[field as keyof ContractScope]}`);
    }
  });

  it("refuses a capability set that is not exactly the action's, wider or narrower, though the signature is valid", () => {
    const wide = forge(key, good, { capabilities: [...CAPABILITIES.rollback_file, "shell:exec"] });
    expect(selfVerify(wide as unknown as SignedReceipt)).toBe(true);
    expect(refusalOf(auth.verify(wide, SCOPE, NOW))).toEqual(["scope-mismatch", "the contract grants capabilities host:write, nginx:reload, probe:run, vault:read, shell:exec; rollback_file takes exactly host:write, nginx:reload, probe:run, vault:read"]);
    expect(refusalOf(auth.verify(forge(key, good, { capabilities: ["host:write"] }), SCOPE, NOW))[0]).toBe("scope-mismatch");
    expect(refusalOf(auth.verify(forge(key, good, { capabilities: [] }), SCOPE, NOW))[1]).toContain("grants capabilities none");
  });
});

describe("the contract key", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "scout-key-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is generated on first use under the given path, reused after, and signs what the first instance verifies", () => {
    const file = path.join(dir, ".scout", "contract-key.pem");
    expect(existsSync(file)).toBe(false);
    const a = ContractKey.loadOrCreate(file);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const b = ContractKey.loadOrCreate(file);
    expect(b.publicB64).toBe(a.publicB64);
    const signed = new LocalContractAuthority(() => b).issue(SCOPE, NOW);
    expect(new LocalContractAuthority(() => a).verify(signed, SCOPE, NOW).ok).toBe(true);
  });

  it.skipIf(process.platform === "win32")("creates the key's directory with mode 0700", () => {
    const file = path.join(dir, "a", "b", "key.pem");
    ContractKey.loadOrCreate(file);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("writes no file until a contract is issued or checked, and never prints the key", () => {
    const file = path.join(dir, "key.pem");
    const lazy = LocalContractAuthority.local(file);
    expect(existsSync(file)).toBe(false);
    lazy.issue(SCOPE, NOW);
    expect(existsSync(file)).toBe(true);
    const pem = readFileSync(file, "utf8");
    const key = ContractKey.loadOrCreate(file);
    expect(JSON.stringify(key)).toBe(JSON.stringify({ publicB64: key.publicB64 }));
    const body = pem.split("\n").filter((l) => l && !l.startsWith("-----")).join("");
    expect(JSON.stringify(lazy.issue(SCOPE, NOW))).not.toContain(body.slice(0, 20));
    expect(`${key}`).not.toContain(body.slice(0, 20));
  });

  it("lives under .scout/ at the repository root, a gitignored path", () => {
    expect(path.relative(ROOT, DEFAULT_KEY_FILE).split(path.sep).join("/")).toBe(".scout/contract-key.pem");
    const ignored = spawnSync("git", ["check-ignore", "-q", ".scout/contract-key.pem"], { cwd: ROOT });
    if (ignored.error) return; // no git on the PATH
    expect(ignored.status).toBe(0);
    expect(readFileSync(path.join(ROOT, ".gitignore"), "utf8")).toMatch(/^\.scout\/$/m);
  });
});

describe("the live Actor's contract authority", () => {
  it("is absent from a dry run, present under --apply, and writes no key file until a contract is issued or checked", async () => {
    const layer = new DataLayer(await SqlJsEngine.create());
    const existed = existsSync(DEFAULT_KEY_FILE);
    const dry = liveActorDeps({ tenantId: "client-a", apply: false, layer, store: null, vault: null, redactor: new Redactor("live-test") });
    const wet = liveActorDeps({ tenantId: "client-a", apply: true, layer, store: null, vault: null, redactor: new Redactor("live-test") });
    expect(dry.contracts).toBeNull();
    expect(wet.contracts).toBeInstanceOf(LocalContractAuthority);
    expect(existsSync(DEFAULT_KEY_FILE)).toBe(existed);
  });
});

describe("the Actor behind the execution contract", () => {
  let base: Base;
  let w: World;
  beforeAll(() => { base = buildBase(); }, 120_000);
  afterAll(() => base.cleanup());
  beforeEach(async () => { w = await buildWorld(base); });
  afterEach(() => w.cleanup());

  const of = (verb: string, object: string, setting = "file"): Disposition => w.dispositions.find((d) => d.verb === verb && d.object_id === object && d.setting_path === setting && d.decided_at === "2026-10-23T03:00:00.000Z")!;
  const scopeOf = (d: Disposition, kind: GatedKind): ContractScope => ({
    tenant_id: d.tenant_id, action: kind, action_id: actionId(d.tenant_id, d.disposition_id, kind), disposition_id: d.disposition_id, object: targetOf(d),
  });
  const issue = (d: Disposition, kind: GatedKind, at = NOW): SignedContract => w.contracts.issue(scopeOf(d, kind), at);
  const presented = (...cs: [Disposition, GatedKind, unknown][]): Map<string, unknown> => new Map(cs.map(([d, k, c]) => [scopeOf(d, k).action_id, c]));
  const apply = (opts: Partial<Parameters<typeof act>[0]>, over: Parameters<World["deps"]>[0] = {}): Promise<ActResult> => act({ tenantId: TENANT, apply: true, ...opts }, w.deps(over));
  const pick = (res: ActResult, d: Disposition, kind: ActionKind): ActionOutcome => res.outcomes.find((o) => o.action.disposition_id === d.disposition_id && o.action.kind === kind)!;
  const rows = async (): Promise<Action[]> => objects(await tenantActions(w.layer, TENANT)) as unknown as Action[];
  const contractLines = () => w.tracer.events.filter((e) => e.action === "guard" && e.input_summary?.startsWith("contract "));

  it("issues a contract at the plan step, checks it before the write, and makes it the first line of the record", async () => {
    const res = await apply({ only: ["rollback_file"] });
    const app = pick(res, of("ROLLBACK", APP), "rollback_file");
    expect(res.outcomes.map((o) => o.action.status)).toEqual(["done", "done"]);
    expect(app.record[0]).toMatch(new RegExp(`^execution contract ctr-[0-9a-f]{16} verified: rollback_file on ${targetOf(of("ROLLBACK", APP)).replace(/[./]/g, "\\$&")}, capabilities host:write, nginx:reload, probe:run, vault:read, issued 2026-10-23T03:04:00\\.000Z, expires 2026-10-23T03:09:00\\.000Z, signed by scout \\(Ed25519, ${GUARD_VERSION}\\)$`));
    expect(app.action.record.split("\n")[0]).toBe(app.record[0]);
    // per action: the plan step issues, the Actor verifies, and both name the same contract
    expect(contractLines().map((e) => [e.agent, e.status, e.output_summary?.replace(/ctr-\w+/, "ctr-")])).toEqual([
      ["actor", "ok", "contract issued ctr-"], ["actor", "ok", "contract verified ctr-"], ["actor", "ok", "contract issued ctr-"], ["actor", "ok", "contract verified ctr-"],
    ]);
    expect(contractLines()[0].output_summary?.replace("issued", "verified")).toBe(contractLines()[1].output_summary);
    expect(contractLines()[0].detail).toBe("plan step; expires 2026-10-23T03:09:00.000Z");
    expect(contractLines()[1].detail).toBe("capabilities host:write, nginx:reload, probe:run, vault:read; expires 2026-10-23T03:09:00.000Z");
    expect(w.host.scripts).toHaveLength(2);
  });

  it("runs a presented contract that is valid", async () => {
    const [a, b] = [of("ROLLBACK", APP), of("ROLLBACK", BLOG)];
    const ca = issue(a, "rollback_file");
    const res = await apply({ only: ["rollback_file"], contracts: presented([a, "rollback_file", ca], [b, "rollback_file", issue(b, "rollback_file")]) });
    expect(pick(res, a, "rollback_file").action.status).toBe("done");
    expect(pick(res, a, "rollback_file").record[0]).toContain(ca.body.receipt.contract_id);
    expect(pick(res, b, "rollback_file").action.status).toBe("done");
    expect(w.host.scripts).toHaveLength(2);
  });

  describe("refuses, writes nothing to the host, and traces the refusal", () => {
    const cases: [string, (a: Disposition, b: Disposition) => unknown, string, RegExp][] = [
      ["unsigned", (a) => ({ ...issue(a, "rollback_file"), sig_b64: "" }), "unsigned", /^the contract carries no signature$/],
      ["not presented", () => undefined, "unsigned", /^no signed contract was presented$/],
      ["expired", (a) => issue(a, "rollback_file", minutes(-6)), "expired", /^the contract expired at 2026-10-23T03:03:00\.000Z; it was checked at 2026-10-23T03:04:00\.000Z$/],
      ["wrong object", (a, b) => w.contracts.issue({ ...scopeOf(a, "rollback_file"), object: targetOf(b) }, NOW), "scope-mismatch", /^the contract is for object linux\.nginx \S+ \/etc\/nginx\/conf\.d\/blog\.conf file; this action has object linux\.nginx \S+ \/etc\/nginx\/conf\.d\/app\.conf file$/],
      ["another disposition's contract", (_a, b) => issue(b, "rollback_file"), "scope-mismatch", /^the contract is for action_id act-\w+; this action has action_id act-\w+$/],
      ["another action", (a) => issue(a, "investigate"), "scope-mismatch", /^the contract is for action investigate; this action has action rollback_file$/],
      ["foreign key", (a) => LocalContractAuthority.ephemeral().issue(scopeOf(a, "rollback_file"), NOW), "bad-signature", /^the contract is signed by a key this deployment does not hold$/],
      ["altered after signing", (a) => { const c = structuredClone(issue(a, "rollback_file")); c.body.receipt.capabilities.push("shell:exec"); return c; }, "bad-signature", /^the signature does not match the contract's bytes$/],
    ];
    it.each(cases)("%s", async (_name, make, refusal, why) => {
      const [a, b] = [of("ROLLBACK", APP), of("ROLLBACK", BLOG)];
      const before = w.host.files.get(APP)!.toString("utf8");
      const res = await apply({ only: ["rollback_file"], contracts: presented([a, "rollback_file", make(a, b)], [b, "rollback_file", issue(b, "rollback_file")]) });
      const refused = pick(res, a, "rollback_file");
      expect(refused.action.status).toBe("refused");
      expect(refused.reason.startsWith(`execution contract refused (${refusal}): `)).toBe(true);
      expect(refused.reason.slice(`execution contract refused (${refusal}): `.length)).toMatch(why);
      expect(refused.record).toEqual([]);
      expect([refused.action.before_hash, refused.action.after_hash, refused.action.vault_commit, refused.action.verification]).toEqual([null, null, null, ""]);
      // nothing reached the host for it; the other disposition's valid contract ran
      expect(w.host.files.get(APP)!.toString("utf8")).toBe(before);
      expect(w.host.scripts).toHaveLength(1);
      expect(pick(res, b, "rollback_file").action.status).toBe("done");
      // the row is written, and the trace says so
      expect((await rows()).find((r) => r.action_id === refused.action.action_id)).toMatchObject({ status: "refused", kind: "rollback_file" });
      const line = contractLines().find((e) => e.status === "failed")!;
      expect(line).toMatchObject({ agent: "actor", action: "guard", output_summary: `contract refused ${refusal}` });
      expect(line.input_summary).toContain("/etc/nginx/conf.d/app.conf");
      expect(w.tracer.events.some((e) => e.agent === "actor" && e.status === "skipped" && e.output_summary?.startsWith("refused: execution contract refused"))).toBe(true);
    });
  });

  it("refuses a contract whose capability set is wider than the action's, though its signature is valid", async () => {
    const key = ContractKey.generate();
    const [a, b] = [of("ROLLBACK", APP), of("ROLLBACK", BLOG)];
    const auth = new LocalContractAuthority(() => key);
    const wide = forge(key, auth.issue(scopeOf(a, "rollback_file"), NOW), { capabilities: [...CAPABILITIES.rollback_file, "shell:exec"] });
    const res = await apply({ only: ["rollback_file"], contracts: presented([a, "rollback_file", wide], [b, "rollback_file", auth.issue(scopeOf(b, "rollback_file"), NOW)]) }, { contracts: auth });
    expect(pick(res, a, "rollback_file").reason).toMatch(/^execution contract refused \(scope-mismatch\): the contract grants capabilities .*shell:exec; rollback_file takes exactly host:write, nginx:reload, probe:run, vault:read$/);
    expect(w.host.scripts).toHaveLength(1);
  });

  it("gates the Cloudflare record revert the same way: an expired contract, and no PATCH is made", async () => {
    const d = of("ROLLBACK", "rec-c3", "content");
    const writes = w.cf.log.length;
    const res = await apply({ only: ["revert_record"], contracts: presented([d, "revert_record", issue(d, "revert_record", minutes(-10))]) });
    expect(pick(res, d, "revert_record")).toMatchObject({ action: { status: "refused" }, reason: expect.stringMatching(/^execution contract refused \(expired\): /) });
    expect(w.cf.log).toHaveLength(writes);
    // the refused row is the action recorded for this disposition and kind, so a second run with a valid contract acts on nothing
    const again = await apply({ only: ["revert_record"], contracts: presented([d, "revert_record", issue(d, "revert_record")]) });
    expect(again.outcomes).toEqual([]);
    expect(again.acted).toEqual([{ action_id: scopeOf(d, "revert_record").action_id, kind: "revert_record", status: "refused" }]);
  });

  it("gates a FIX: the investigation runs only on a valid contract, and a refused one asks no model", async () => {
    const d = of("FIX", "/etc/nginx/conf.d/shop.conf");
    const refused = await apply({ only: ["investigate"], contracts: presented([d, "investigate", issue(d, "investigate", minutes(-6))]) });
    expect(pick(refused, d, "investigate")).toMatchObject({ action: { status: "refused", receipts: "" }, reason: expect.stringMatching(/^execution contract refused \(expired\): /) });
    expect(w.model.calls).toEqual([]);
    expect(pick(refused, d, "fix")).toMatchObject({ action: { status: "refused" }, reason: FIX_REFUSED });
    const w2 = await buildWorld(base);
    try {
      const d2 = w2.dispositions.find((x) => x.verb === "FIX" && x.decided_at === "2026-10-23T03:00:00.000Z")!;
      const ok = await act({ tenantId: TENANT, apply: true, only: ["investigate"], contracts: new Map([[scopeOf(d2, "investigate").action_id, w2.contracts.issue(scopeOf(d2, "investigate"), NOW)]]) }, w2.deps());
      expect(ok.outcomes.find((o) => o.action.kind === "investigate")!.action.status).toBe("done");
      expect(w2.model.calls).toHaveLength(2);
    } finally {
      w2.cleanup();
    }
  });

  it("refuses every ROLLBACK and FIX when the Actor holds no contract authority", async () => {
    const res = await apply({}, { contracts: null });
    const gated = res.outcomes.filter((o) => o.action.kind !== "fix");
    expect(gated).toHaveLength(4);
    for (const o of gated) expect([o.action.status, o.reason]).toEqual(["refused", "execution contract refused (unsigned): the Actor holds no contract authority, so no contract can be issued or checked"]);
    expect([w.host.scripts.length, w.cf.log.length, w.model.calls.length, w.probes.length]).toEqual([0, 0, 0, 0]);
  });

  it("refuses an empty contracts map with a clear error before anything runs, and ignores it in a dry run", async () => {
    await expect(apply({ only: ["rollback_file"], contracts: new Map() })).rejects.toThrow(/ActOptions\.contracts is an empty map: present a contract for each action, or leave it out/);
    expect([w.host.scripts.length, w.cf.log.length, w.model.calls.length, (await rows()).length]).toEqual([0, 0, 0, 0]);
    expect((await apply({ apply: false, contracts: new Map() })).plan).toHaveLength(5);
  });

  it("records a failed action, and carries on with the rest, when an action throws after its contract passed", async () => {
    const d = of("FIX", "/etc/nginx/conf.d/shop.conf");
    const res = await apply({ only: ["investigate"] }, { findingOf: async () => { throw new Error("the finding read failed: boom"); } });
    const inv = pick(res, d, "investigate");
    expect(inv.action.status).toBe("failed");
    expect(inv.reason).toBe("the action stopped with an error: the finding read failed: boom");
    expect(inv.record).toHaveLength(1);
    expect(inv.record[0]).toMatch(/^execution contract ctr-[0-9a-f]{16} verified: investigate on /);
    expect((await rows()).find((r) => r.action_id === inv.action.action_id)).toMatchObject({ status: "failed", kind: "investigate" });
    expect(pick(res, d, "fix")).toMatchObject({ action: { status: "refused" }, reason: FIX_REFUSED });
    expect(w.model.calls).toEqual([]);
  });

  it("needs no contract for a dry run, and the plan reads as it did", async () => {
    const res = await apply({ apply: false }, { contracts: null });
    expect(res.plan.map((p) => p.kind).sort()).toEqual(["fix", "investigate", "revert_record", "rollback_file", "rollback_file"]);
    expect(res.plan.every((p) => p.lines.every((l) => !l.includes("contract")))).toBe(true);
    expect(contractLines()).toEqual([]);
    expect(res.outcomes).toEqual([]);
  });
});
