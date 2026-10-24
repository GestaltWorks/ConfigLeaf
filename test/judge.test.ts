// The refuting judge with a stub Nightshift (canned replies in the shapes Ultra and Lightning really
// return) and a stub receipt store holding the two real receipt fixtures. The refuting SQL runs for
// real against sql.js on sample/bundle.json, so stands/refuted come from rows, not from a canned verdict.
import { beforeAll, describe, expect, it } from "vitest";
import type { ChatResult, SignedReceipt } from "../src/adapters/nightshift.ts";
import { config } from "../src/config.ts";
import { DataLayer, type Params, type RunOptions } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { hero } from "../src/data/queries.ts";
import { MAX_EVIDENCE_ROWS, SYSTEM_PROMPT, buildMessages, guardRefutation, judgeClaim, type JudgeModel } from "../src/agents/judge.ts";
import bundle from "../sample/bundle.json" with { type: "json" };
import { MemTracer } from "./fixtures/mem-tracer.ts";
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

describe("judgeClaim on sample/bundle.json", () => {
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
    expect(v).toMatchObject({ status: "stands", rowCount: 0, receiptId: ULTRA_ID, servedModel: ULTRA_MODEL, rationale: "A row means the inventory knows the address, which falsifies the claim." });
    expect(v.sql).toBe("SELECT asset_id FROM {{t:inventory_asset}} WHERE tenant_id = 'client-a' AND address = '203.0.113.77' LIMIT 50");
    expect(v.latencyMs).toBeGreaterThanOrEqual(0);
    expect(ns.opts[0]).toMatchObject({ enableThinking: true, maxTokens: 4096, temperature: 0, agent: "judge", models: [config.nightshift.modelJudge, ...config.nightshift.fallbackJudge] });
    expect(ns.opts[0].messages[1].content).toContain("Claim: " + HERO_CLAIM);
    expect(ns.opts[0].messages[1].content).toContain('"resolves_to":"203.0.113.77"');
    expect(tracer.events.map((e) => `${e.agent}:${e.action}:${e.status}`)).toEqual(["judge:hypothesise:ok", "judge:check:ok", "judge:query:ok", "judge:judge:ok"]);
    expect(tracer.events[3]).toMatchObject({ receipt_id: ULTRA_ID, signature_ok: true, model_routed: ULTRA_MODEL });
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
    expect(v.sql).toMatch(/LIMIT 50$/);
    expect(layer.runs).toBe(before);
    expect(tracer.events.map((e) => `${e.action}:${e.status}`)).toEqual(["hypothesise:ok", "check:not_judged"]);
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
    expect(tracer.events.map((e) => `${e.action}:${e.status}`)).toEqual(["hypothesise:ok", "check:not_judged"]);
    expect(tracer.events[1]).toMatchObject({ agent: "judge", receipt_id: ULTRA_ID, model_routed: ULTRA_MODEL });
  });

  it("not_judged: every judge route failed", async () => {
    const ns: JudgeModel = { chatWithFallback: async () => { throw new Error("chat nvidia/nemotron-3-ultra-550b-a55b -> 502: provider_error"); } };
    const tracer = new MemTracer("test_judge");
    const v = await judgeClaim({ claim: HERO_CLAIM, evidenceRows: EVIDENCE, layer, nightshift: ns, receipts, tracer, requestedModels: ["nvidia/nemotron-3-ultra-550b-a55b"] });
    expect(v).toMatchObject({ status: "not_judged", sql: null, receiptId: null, servedModel: null });
    expect(v.reason).toMatch(/judge model unavailable: .*502/);
    expect(tracer.events).toHaveLength(1);
    expect(tracer.events[0]).toMatchObject({ agent: "judge", action: "hypothesise", status: "not_judged", model_requested: "nvidia/nemotron-3-ultra-550b-a55b" });
  });
});
