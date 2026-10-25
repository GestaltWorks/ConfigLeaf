// The refuting judge with a stub Nightshift (canned replies in the shapes Ultra and Lightning really
// return) and a stub receipt store holding the two real receipt fixtures. The refuting SQL runs for
// real against sql.js on the authored fixture (test/fixtures/authored-bundle.json, the hero story), so
// stands/refuted come from rows, not from a canned verdict.
import { beforeAll, describe, expect, it } from "vitest";
import type { ChatResult, SignedReceipt } from "../src/adapters/nightshift.ts";
import { config } from "../src/config.ts";
import { DataLayer, type Params, type RunOptions } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { hero } from "../src/data/queries.ts";
import { tenantAppId } from "../src/gate.ts";
import { JUDGE_MAX_TOKENS, MAX_EVIDENCE_ROWS, SYSTEM_PROMPT, buildMessages, guardRefutation, judgeClaim, type JudgeModel } from "../src/agents/judge.ts";
import bundle from "./fixtures/authored-bundle.json" with { type: "json" };
import { MemTracer } from "./fixtures/mem-tracer.ts";
import { ultraReceipt } from "./fixtures/signed-receipt.ts";
import lightningJson from "./fixtures/receipt-lightning.json" with { type: "json" };
import ultraJson from "./fixtures/receipt-ultra.json" with { type: "json" };

const lightning = lightningJson as unknown as SignedReceipt;
const ultra = ultraJson as unknown as SignedReceipt;
const ULTRA_ID = ultra.body.receipt.receipt_id as string;
const ULTRA_MODEL = ultra.body.receipt.routing.winner as string;
const LIGHTNING_ID = lightning.body.receipt.receipt_id as string;
const LIGHTNING_MODEL = lightning.body.receipt.routing.winner as string;

const receipts = { find: async (id: string) => [lightning, ultra].find((r) => r.body.receipt.receipt_id === id) ?? null };

type ChatOpts = Parameters<JudgeModel["chatWithFallback"]>[0];

/** A Nightshift whose chatWithFallback returns `content` as if `model` answered it, remembering the request. */
function stub(content: string, over: Partial<ChatResult> = {}): JudgeModel & { opts: ChatOpts[] } {
  const opts: ChatOpts[] = [];
  return {
    opts,
    async chatWithFallback(o) {
      opts.push(o);
      return { content, modelRequested: o.models[0], modelRouted: ULTRA_MODEL, receiptId: ULTRA_ID, requestId: "chatcmpl-test", tokensIn: 900, tokensOut: 120, latencyMs: 7, retries: 0, raw: {}, hop: 0, ...over };
    },
  };
}

const reply = (sql: string, rationale = "Rows mean the claim is false.") => JSON.stringify({ refute_with_sql: sql, rationale });

/** A DataLayer that counts run() calls, so a test can prove the SQL never ran. */
class CountingLayer extends DataLayer {
  runs = 0;
  override run(sql: string, params: Params = {}, opts: RunOptions = {}) {
    this.runs++;
    return super.run(sql, params, opts);
  }
}

const HERO_CLAIM = "In run run-nginx-7f1c-1023, host-7f1c's /etc/nginx/conf.d/app.conf proxies to app.example.invalid, which DNS run run-dns-1023 resolves to 203.0.113.77, an address absent from client-a's inventory.";
const EVIDENCE = { columns: ["host", "address"], rows: [["host-7f1c", "203.0.113.77"]] };

describe("guardRefutation", () => {
  it("accepts one templated SELECT and appends LIMIT 50", () => {
    expect(guardRefutation("SELECT asset_id FROM {{t:inventory_asset}} WHERE address = '203.0.113.77'"))
      .toBe("SELECT asset_id FROM {{t:inventory_asset}} WHERE address = '203.0.113.77' LIMIT 50");
  });

  it("strips one trailing semicolon as formatting, keeps a LIMIT at or under 50, caps a larger one", () => {
    expect(guardRefutation("SELECT 1 FROM {{t:observation}} LIMIT 5;")).toBe("SELECT 1 FROM {{t:observation}} LIMIT 5");
    expect(guardRefutation("SELECT 1 FROM {{t:observation}} ORDER BY obs_id LIMIT 500")).toBe("SELECT 1 FROM {{t:observation}} ORDER BY obs_id LIMIT 50");
  });

  it("refuses a second statement, DML, comments and forbidden tokens", () => {
    expect(() => guardRefutation("SELECT 1 FROM {{t:observation}}; SELECT 2 FROM {{t:observation}}")).toThrow(/semicolon/);
    expect(() => guardRefutation("DELETE FROM {{t:observation}}")).toThrow(/only SELECT/);
    expect(() => guardRefutation("SELECT 1 FROM {{t:observation}} WHERE 1 = 1 UNION ALL SELECT 1 FROM {{t:observation}} DROP TABLE observation")).toThrow(/forbidden keyword: DROP/);
    expect(() => guardRefutation("SELECT 1 FROM {{t:observation}} -- x")).toThrow(/comment/);
  });

  it("refuses an unknown table, a parameter placeholder, a bare table name and a query with no table", () => {
    expect(() => guardRefutation("SELECT 1 FROM {{t:users}}")).toThrow(/unknown table: users/);
    expect(() => guardRefutation("SELECT 1 FROM {{t:observation}} WHERE host = {{p:h}}")).toThrow(/parameters are not allowed/);
    expect(() => guardRefutation("SELECT 1 FROM observation")).toThrow(/bare table reference: observation/);
    expect(() => guardRefutation("SELECT o.host FROM {{t:observation}} o JOIN dns_record d ON d.name = o.refers_to_id")).toThrow(/bare table reference: dns_record/);
    expect(() => guardRefutation("SELECT 1")).toThrow(/no \{\{t:table\}\} reference/);
    expect(() => guardRefutation("")).toThrow(/non-empty string/);
    expect(() => guardRefutation(42)).toThrow(/non-empty string/);
  });

  it("a table name inside a string literal is data, not a bare reference", () => {
    expect(() => guardRefutation("SELECT 1 FROM {{t:audit_event}} WHERE resource_type = 'from observation'")).not.toThrow();
  });

  it("refuses a double quote: a \"x'\" token would hide a UNION, a comment and a bare table from the literal strip", () => {
    expect(() => guardRefutation(`SELECT "x'" AS a FROM {{t:observation}} WHERE 1 = 0 UNION ALL SELECT note FROM approved_setting -- '`)).toThrow(/double quotes/);
    expect(() => guardRefutation('SELECT "host" FROM {{t:observation}}')).toThrow(/double quotes/);
    expect(() => guardRefutation("SELECT 1 FROM {{t:observation}} WHERE value_redacted = 'say \"hi\"'")).not.toThrow();
  });

  it("refuses a WITH clause, which the prompt tells the model to write inline", () => {
    expect(() => guardRefutation("WITH x AS (SELECT 1 AS n FROM {{t:observation}}) SELECT n FROM x")).toThrow(/only SELECT/);
    expect(SYSTEM_PROMPT).toContain("No WITH clauses");
    expect(SYSTEM_PROMPT).toContain("No double quotes");
  });
});

describe("buildMessages", () => {
  it("carries the DDL and the rules in the system prompt, the claim and at most 20 rows in the user prompt", () => {
    const rows = Array.from({ length: 25 }, (_, i) => [`host-${i}`, `198.51.100.${i}`]);
    const [system, user] = buildMessages("the claim", { columns: ["host", "address"], rows });
    expect(system.role).toBe("system");
    expect(system.content).toBe(SYSTEM_PROMPT);
    expect(system.content).toContain("CREATE TABLE IF NOT EXISTS observation");
    expect(system.content).toContain("{{t:table_name}}");
    expect(system.content).toContain('"refute_with_sql"');
    expect(user.role).toBe("user");
    expect(user.content).toContain("Claim: the claim");
    expect(user.content).toContain(`(${MAX_EVIDENCE_ROWS} of 25; columns: host, address)`);
    expect(user.content.split("\n").filter((l) => l.startsWith("{")).length).toBe(MAX_EVIDENCE_ROWS);
    expect(user.content).toContain('{"host":"host-19","address":"198.51.100.19"}');
    expect(user.content).not.toContain("host-20");
  });
});

describe("judgeClaim on the authored fixture", () => {
  let layer: CountingLayer;

  beforeAll(async () => {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(bundle);
    layer = new CountingLayer(engine);
  });

  it("stands: the hero finding survives an Ultra-style reply (reasoning, </think>, then JSON) whose SELECT finds no rows", async () => {
    const evidence = await hero(layer, { tenant_id: "client-a", run_id: "run-nginx-7f1c-1023", dns_run_id: "run-dns-1023" });
    expect(evidence.rowCount).toBe(1);
    const ns = stub(`The claim is false only if the inventory does know 203.0.113.77, so select that row.</think>${reply("SELECT asset_id FROM {{t:inventory_asset}} WHERE tenant_id = 'client-a' AND address = '203.0.113.77'", "A row means the inventory knows the address, which falsifies the claim.")}`);
    const tracer = new MemTracer("test_judge");
    const v = await judgeClaim({ claim: HERO_CLAIM, evidenceRows: evidence, layer, nightshift: ns, receipts, tracer });
    expect(v).toMatchObject({ status: "stands", rowCount: 0, receiptId: ULTRA_ID, servedModel: ULTRA_MODEL, signatureOk: true, rationale: "A row means the inventory knows the address, which falsifies the claim." });
    expect(v.sql).toBe("SELECT asset_id FROM {{t:inventory_asset}} WHERE tenant_id = 'client-a' AND address = '203.0.113.77' LIMIT 50");
    expect(v.latencyMs).toBeGreaterThanOrEqual(0);
    // no tenant named: no custody, no nonce, the configured app id
    expect(v.custody).toBeUndefined();
    expect(v.attempts).toBeUndefined();
    expect(ns.opts[0]).toMatchObject({ enableThinking: true, maxTokens: JUDGE_MAX_TOKENS, temperature: 0, agent: "judge", models: [config.nightshift.modelJudge, ...config.nightshift.fallbackJudge] });
    expect(JUDGE_MAX_TOKENS).toBe(8192);
    expect(ns.opts[0].appId).toBeUndefined();
    expect(ns.opts[0].messages[1].content).toMatch(/^Claim: /);
    expect(ns.opts[0].messages[1].content).toContain("Claim: " + HERO_CLAIM);
    expect(ns.opts[0].messages[1].content).toContain('"resolves_to":"203.0.113.77"');
    // the gate runs before the reply is read: a discarded answer is never parsed as a hypothesis
    expect(tracer.events.map((e) => `${e.agent}:${e.action}:${e.status}`)).toEqual(["judge:check:ok", "judge:hypothesise:ok", "judge:query:ok", "judge:judge:ok"]);
    expect(tracer.events[3]).toMatchObject({ receipt_id: ULTRA_ID, signature_ok: true, model_routed: ULTRA_MODEL });
  });

  it("requestedTier and model: a Lightning judge counts on a Lightning receipt when the tier asked is lightning, and the same receipt is refused under the default tier", async () => {
    const sql = reply("SELECT asset_id FROM {{t:inventory_asset}} WHERE tenant_id = 'client-a' AND address = '203.0.113.77'");
    const lightningServed = { modelRouted: LIGHTNING_MODEL, receiptId: LIGHTNING_ID };
    const ns = stub(sql, lightningServed);
    const v = await judgeClaim({ claim: HERO_CLAIM, evidenceRows: EVIDENCE, layer, nightshift: ns, receipts, requestedTier: "lightning", model: config.nightshift.modelFast });
    expect(v).toMatchObject({ status: "stands", receiptId: LIGHTNING_ID, servedModel: LIGHTNING_MODEL, signatureOk: true });
    expect(ns.opts[0].models).toEqual([config.nightshift.modelFast]);
    const ultraAsked = await judgeClaim({ claim: HERO_CLAIM, evidenceRows: EVIDENCE, layer, nightshift: stub(sql, lightningServed), receipts });
    expect(ultraAsked.status).toBe("not_judged");
    expect(ultraAsked.reason).toMatch(/ultra was requested/);
  });

  it("refuted: a false claim falls to a fenced reply whose SELECT returns the row that breaks it", async () => {
    const ns = stub("```json\n" + reply("SELECT d.name, d.content FROM {{t:dns_record}} d LEFT JOIN {{t:inventory_asset}} i ON i.tenant_id = d.tenant_id AND i.address = d.content WHERE d.run_id = 'run-dns-1023' AND d.type = 'A' AND i.asset_id IS NULL") + "\n```");
    const v = await judgeClaim({ claim: "Every A record observed in run-dns-1023 points at an address in client-a's inventory.", evidenceRows: EVIDENCE, layer, nightshift: ns, receipts });
    expect(v).toMatchObject({ status: "refuted", rowCount: 1, receiptId: ULTRA_ID, servedModel: ULTRA_MODEL });
    expect(v.reason).toMatch(/1 row/);
  });

  it("invalid_output: a second statement, DML, an unknown table, a placeholder and a bare table are refused before anything runs", async () => {
    const cases: [string, RegExp][] = [
      ["SELECT 1 FROM {{t:observation}}; SELECT 2 FROM {{t:observation}}", /semicolon/],
      ["DELETE FROM {{t:observation}}", /only SELECT/],
      ["SELECT 1 FROM {{t:users}}", /unknown table: users/],
      ["SELECT 1 FROM {{t:observation}} WHERE host = {{p:h}}", /parameters are not allowed/],
      ["SELECT 1 FROM observation", /bare table reference/],
    ];
    const before = layer.runs;
    for (const [sql, re] of cases) {
      const v = await judgeClaim({ claim: HERO_CLAIM, evidenceRows: EVIDENCE, layer, nightshift: stub(reply(sql)), receipts });
      expect(v.status).toBe("invalid_output");
      expect(v.reason).toMatch(/refutation SQL refused/);
      expect(v.reason).toMatch(re);
      expect(v.sql).toBe(sql);
      expect(v).toMatchObject({ rowCount: null, receiptId: ULTRA_ID, servedModel: ULTRA_MODEL });
    }
    expect(layer.runs).toBe(before);
  });

  it("invalid_output: no JSON, the wrong shape, and SQL the engine cannot run", async () => {
    const none = await judgeClaim({ claim: HERO_CLAIM, evidenceRows: EVIDENCE, layer, nightshift: stub("I cannot write that query."), receipts });
    expect(none).toMatchObject({ status: "invalid_output", reason: "no JSON object in the reply", sql: null, rationale: null });
    const shape = await judgeClaim({ claim: HERO_CLAIM, evidenceRows: EVIDENCE, layer, nightshift: stub('Thinking.</think>{"sql": "SELECT 1 FROM {{t:observation}}"}'), receipts });
    expect(shape.status).toBe("invalid_output");
    expect(shape.reason).toMatch(/refute_with_sql/);
    const broken = await judgeClaim({ claim: HERO_CLAIM, evidenceRows: EVIDENCE, layer, nightshift: stub(reply("SELECT no_such_column FROM {{t:observation}}")), receipts });
    expect(broken.status).toBe("invalid_output");
    expect(broken.reason).toMatch(/failed to run/);
    expect(broken.sql).toBe("SELECT no_such_column FROM {{t:observation}} LIMIT 50");
  });

  it("not_judged: a Lightning receipt where Ultra was requested; the SQL never runs", async () => {
    const before = layer.runs;
    const ns = stub(reply("SELECT asset_id FROM {{t:inventory_asset}} WHERE address = '203.0.113.77'"), { modelRouted: LIGHTNING_MODEL, receiptId: LIGHTNING_ID });
    const tracer = new MemTracer("test_judge");
    const v = await judgeClaim({ claim: HERO_CLAIM, evidenceRows: EVIDENCE, layer, nightshift: ns, receipts, tracer });
    expect(v).toMatchObject({ status: "not_judged", rowCount: null, receiptId: LIGHTNING_ID, servedModel: LIGHTNING_MODEL });
    expect(v.reason).toMatch(/receipt gate: .*ultra was requested/);
    expect(v.sql).toMatch(/LIMIT 50$/); // parsed for the record, never run
    expect(v.signatureOk).toBe(true);
    expect(layer.runs).toBe(before);
    expect(tracer.events.map((e) => `${e.action}:${e.status}`)).toEqual(["check:not_judged"]);
  });

  it("not_judged: a response whose receipt claims Ultra but whose body was altered fails the signature", async () => {
    const tampered = structuredClone(ultra);
    tampered.body.receipt.prompt_preview = "something else";
    const ns = stub(reply("SELECT asset_id FROM {{t:inventory_asset}} WHERE address = '203.0.113.77'"));
    const v = await judgeClaim({ claim: HERO_CLAIM, evidenceRows: EVIDENCE, layer, nightshift: ns, receipts: { find: async () => tampered } });
    expect(v.status).toBe("not_judged");
    expect(v.reason).toMatch(/signature does not verify/);
  });

  it("not_judged: the receipt lookup fails after the model answered; no verdict, no query, no throw", async () => {
    const before = layer.runs;
    const ns = stub(reply("SELECT asset_id FROM {{t:inventory_asset}} WHERE address = '203.0.113.77'"));
    const tracer = new MemTracer("test_judge");
    const unreachable = { find: async () => { throw new Error("GET /v1/meterless/receipts -> ECONNREFUSED"); } };
    const v = await judgeClaim({ claim: HERO_CLAIM, evidenceRows: EVIDENCE, layer, nightshift: ns, receipts: unreachable, tracer });
    expect(v).toMatchObject({ status: "not_judged", rowCount: null, receiptId: ULTRA_ID, servedModel: ULTRA_MODEL });
    expect(v.reason).toMatch(/^receipt lookup failed: .*ECONNREFUSED/);
    expect(v.sql).toMatch(/LIMIT 50$/);
    expect(layer.runs).toBe(before);
    expect(tracer.events.map((e) => `${e.action}:${e.status}`)).toEqual(["check:not_judged"]);
    expect(tracer.events[0]).toMatchObject({ agent: "judge", receipt_id: ULTRA_ID, model_routed: ULTRA_MODEL });
  });

  it("not_judged: every judge route failed", async () => {
    const ns: JudgeModel = { chatWithFallback: async () => { throw new Error("chat nvidia/nemotron-3-ultra-550b-a55b -> 502: provider_error"); } };
    const tracer = new MemTracer("test_judge");
    const v = await judgeClaim({ claim: HERO_CLAIM, evidenceRows: EVIDENCE, layer, nightshift: ns, receipts, tracer, requestedModels: ["nvidia/nemotron-3-ultra-550b-a55b"] });
    expect(v).toMatchObject({ status: "not_judged", sql: null, receiptId: null, servedModel: null });
    expect(v.signatureOk).toBeUndefined();
    expect(v.reason).toMatch(/judge model unavailable: .*502/);
    expect(tracer.events).toHaveLength(1);
    expect(tracer.events[0]).toMatchObject({ agent: "judge", action: "hypothesise", status: "not_judged", model_requested: "nvidia/nemotron-3-ultra-550b-a55b" });
  });
});

describe("judgeClaim under a tenant: the call goes out under the tenant's app id and the receipt must pass custody", () => {
  const CLIENT = "client-a";
  const CLIENT_APP = tenantAppId(CLIENT);
  const REFUTE = reply("SELECT asset_id FROM {{t:inventory_asset}} WHERE tenant_id = 'client-a' AND address = '203.0.113.77'");
  let layer: CountingLayer;

  beforeAll(async () => {
    const engine = await SqlJsEngine.create();
    engine.loadBundle(bundle);
    layer = new CountingLayer(engine);
  });

  /** A Nightshift whose n-th answer is filed by the runtime under the n-th receipt and request id of `plan`. */
  function planned(plan: { receipt: SignedReceipt; requestId: string }[]): JudgeModel & { opts: ChatOpts[] } {
    const opts: ChatOpts[] = [];
    return {
      opts,
      async chatWithFallback(o) {
        const p = plan[opts.length];
        opts.push(o);
        return { content: REFUTE, modelRequested: o.models[0], modelRouted: ULTRA_MODEL, receiptId: p.receipt.body.receipt.receipt_id as string, requestId: p.requestId, tokensIn: 900, tokensOut: 120, latencyMs: 7, retries: 0, raw: {}, hop: 0 };
      },
    };
  }
  const find = (...rs: SignedReceipt[]) => ({ find: async (id: string) => rs.find((r) => r.body.receipt.receipt_id === id) ?? null });
  const nonceOf = (o: ChatOpts): string => o.messages[1].content.match(/^\[request ([0-9a-f]{16})\]\n/)![1];

  it("custody holds on the first call: the request went out under drift-agent-<tenant> with a nonce first in the user message, the receipt is ours, the verdict carries the custody check", async () => {
    const ours = ultraReceipt("rcpt_ours", "chatcmpl-ours", CLIENT_APP);
    const ns = planned([{ receipt: ours, requestId: "chatcmpl-ours" }]);
    const tracer = new MemTracer("test_judge");
    const v = await judgeClaim({ claim: HERO_CLAIM, evidenceRows: EVIDENCE, layer, nightshift: ns, receipts: find(ours), tracer, tenantId: CLIENT });
    expect(v).toMatchObject({ status: "stands", rowCount: 0, receiptId: "rcpt_ours", servedModel: ULTRA_MODEL, signatureOk: true, attempts: 1, custody: { ok: true, requestId: "match", app: "match", cacheStatus: "miss" } });
    expect(ns.opts).toHaveLength(1);
    expect(ns.opts[0].appId).toBe(CLIENT_APP);
    expect(ns.opts[0].messages[1].content).toMatch(/^\[request [0-9a-f]{16}\]\nClaim: /);
    expect(ns.opts[0].messages[0].content).toBe(SYSTEM_PROMPT);
    expect(tracer.events.map((e) => `${e.agent}:${e.action}:${e.status}`)).toEqual(["judge:check:ok", "judge:check:ok", "judge:hypothesise:ok", "judge:query:ok", "judge:judge:ok"]);
    expect(tracer.events[0]).toMatchObject({ input_summary: `custody rcpt_ours under app ${CLIENT_APP}`, output_summary: "request_id match, prompt_preview absent, app match" });
    for (const e of tracer.events) expect(JSON.stringify(e)).not.toContain("Supporting rows");
  });

  it("a receipt for someone else's request is discarded and the claim asked once more as a fresh request: a new nonce, the second receipt ours, two attempts, the verdict from the second answer", async () => {
    const foreign = ultraReceipt("rcpt_foreign", "chatcmpl-someone-else", CLIENT_APP);
    const ours = ultraReceipt("rcpt_ours2", "chatcmpl-2", CLIENT_APP);
    const ns = planned([{ receipt: foreign, requestId: "chatcmpl-1" }, { receipt: ours, requestId: "chatcmpl-2" }]);
    const tracer = new MemTracer("test_judge");
    const before = layer.runs;
    const v = await judgeClaim({ claim: HERO_CLAIM, evidenceRows: EVIDENCE, layer, nightshift: ns, receipts: find(foreign, ours), tracer, tenantId: CLIENT });
    expect(v).toMatchObject({ status: "stands", receiptId: "rcpt_ours2", attempts: 2, custody: { ok: true } });
    expect(ns.opts).toHaveLength(2);
    expect(nonceOf(ns.opts[0])).not.toBe(nonceOf(ns.opts[1]));
    expect(ns.opts.every((o) => o.appId === CLIENT_APP)).toBe(true);
    expect(layer.runs).toBe(before + 1); // the discarded answer's SQL never ran
    expect(tracer.events.map((e) => `${e.action}:${e.status}`)).toEqual(["check:not_judged", "check:not_judged", "retry:ok", "check:ok", "check:ok", "hypothesise:ok", "query:ok", "judge:ok"]);
    expect(tracer.events[2]).toMatchObject({ agent: "judge", retry_count: 1, receipt_id: "rcpt_foreign" });
  });

  it("the real Ultra receipt is filed under the shared app with another request id, so under a tenant it fails custody twice and the finding is not_judged with a reason that starts custody; the SQL is recorded and never run", async () => {
    const ns = planned([{ receipt: ultra, requestId: "chatcmpl-test" }, { receipt: ultra, requestId: "chatcmpl-test" }]);
    const tracer = new MemTracer("test_judge");
    const before = layer.runs;
    const v = await judgeClaim({ claim: HERO_CLAIM, evidenceRows: EVIDENCE, layer, nightshift: ns, receipts, tracer, tenantId: CLIENT });
    expect(v).toMatchObject({ status: "not_judged", rowCount: null, receiptId: ULTRA_ID, servedModel: ULTRA_MODEL, signatureOk: true, attempts: 2, custody: { ok: false, requestId: "mismatch", app: "mismatch" } });
    expect(v.reason).toMatch(/^receipt gate: custody: failed on both attempts, answer discarded, not judged; /);
    expect(v.sql).toMatch(/LIMIT 50$/);
    expect(ns.opts).toHaveLength(2);
    expect(layer.runs).toBe(before);
    expect(tracer.events.map((e) => `${e.action}:${e.status}`)).toEqual(["check:not_judged", "check:not_judged", "retry:ok", "check:not_judged", "check:not_judged", "check:not_judged"]);
    expect(tracer.events.at(-1)).toMatchObject({ agent: "judge", output_summary: "custody failed on 2 of 2 attempts; fail closed" });
  });

  it("a tenant id that is not a header-safe token is not_judged with the reason, traced, and no call is made; nothing throws out of the pass", async () => {
    const ours = ultraReceipt("rcpt_unused", "chatcmpl-unused", CLIENT_APP);
    const ns = planned([{ receipt: ours, requestId: "chatcmpl-unused" }]);
    const tracer = new MemTracer("test_judge");
    const before = layer.runs;
    const v = await judgeClaim({ claim: HERO_CLAIM, evidenceRows: EVIDENCE, layer, nightshift: ns, receipts: find(ours), tracer, tenantId: "client a" });
    expect(v).toMatchObject({ status: "not_judged", sql: null, rowCount: null, receiptId: null, servedModel: null });
    expect(v.reason).toMatch(/^tenant id is not a header-safe token: "client a"; no call made$/);
    expect(v.custody).toBeUndefined();
    expect(ns.opts).toEqual([]);
    expect(layer.runs).toBe(before);
    expect(tracer.events.map((e) => `${e.agent}:${e.action}:${e.status}`)).toEqual(["judge:check:not_judged"]);
    expect(tracer.events[0]).toMatchObject({ output_summary: "tenant id is not a header-safe token; not judged" });
  });

  it("a substitution under a tenant is never retried: one call, not_judged for the tier, custody recorded", async () => {
    const ns = planned([{ receipt: lightning, requestId: "chatcmpl-x" }, { receipt: ultra, requestId: "chatcmpl-y" }]);
    const v = await judgeClaim({ claim: HERO_CLAIM, evidenceRows: EVIDENCE, layer, nightshift: ns, receipts, tenantId: CLIENT });
    expect(v).toMatchObject({ status: "not_judged", receiptId: LIGHTNING_ID, servedModel: LIGHTNING_MODEL, attempts: 1 });
    expect(v.reason).toMatch(/receipt gate: .*ultra was requested$/);
    expect(ns.opts).toHaveLength(1);
  });

  it("a tenant id that is not a header-safe token is refused before any call, as a verdict and never a throw", async () => {
    const ns = planned([]);
    const v = await judgeClaim({ claim: HERO_CLAIM, evidenceRows: EVIDENCE, layer, nightshift: ns, receipts, tenantId: "client a" });
    expect(v.status).toBe("not_judged");
    expect(v.reason).toMatch(/header-safe/);
    expect(ns.opts).toHaveLength(0);
  });
});
