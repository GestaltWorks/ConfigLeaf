// Pre-flight over the recorded bundle (test/fixtures/recorded-bundle.json, the export of the 07:58 UTC collection of 24 Oct 2026: the real estate redacted), model: none. The
// verdicts here are what the simulation computed when the tests were written, not targets: a proposal
// binds or is rejected by the rows, the derived table applies the change as SQL on both engines, and the
// pass's own findings in the two worlds decide GO, NO-GO, GO-IF or ESCALATE. Nothing is written: the
// same engine runs a real pass before and after a pre-flight and the findings are byte-identical.
import { beforeAll, describe, expect, it } from "vitest";
import type { JudgeInput, JudgeVerdict } from "../src/agents/judge.ts";
import { config } from "../src/config.ts";
import { DataLayer, DataLayerError, LAYER_TABLES, assertSelectOnly, type Overlays } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { ZetarisEngine } from "../src/data/engines/zetaris.ts";
import { HERO_SQL, OBSERVATIONS_SQL, PROXIED_WITHOUT_REAL_IP_SQL, objects } from "../src/data/queries.ts";
import { TABLE_NAMES } from "../src/data/schema.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { runPass, type PassResult } from "../src/pipeline.ts";
import { dnsRecordOverlay, realIpOverlay, simulatedHash } from "../src/preflight/overlay.ts";
import { PREREQUISITES, type Prerequisite } from "../src/preflight/prerequisites.ts";
import { ProposedChange, parseProposal } from "../src/preflight/proposal.ts";
import { MAX_ITERATIONS, describeVerdict, findingKey, runPreflight, type PreflightResult } from "../src/preflight/run.ts";
import recorded from "./fixtures/recorded-bundle.json" with { type: "json" };
import sample from "../sample/bundle.json" with { type: "json" };
import a from "../examples/proposals/a-unproxy-www.json" with { type: "json" };
import b from "../examples/proposals/b-replay-16-april-proxied.json" with { type: "json" };
import c from "../examples/proposals/c-vhost-real-ip.json" with { type: "json" };
import d from "../examples/proposals/d-retarget-apex-outside-inventory.json" with { type: "json" };
import { APEX_NAME, APEX_RECORD, CONFD_HOST, DNS_RUN, SITES_HOST, SITES_RUN, QUEST_FILE, T, WWW_NAME, WWW_RECORD } from "./fixtures/catalogue-params.ts";
import { MemTracer } from "./fixtures/mem-tracer.ts";
import { USL, uslRelation } from "../src/zetaris/setup.ts";

/** Zetaris's text with each relation it names a table by put back as the table's name: what sql.js renders. */
function asTables(sql: string): string {
  let s = sql;
  for (const t of LAYER_TABLES) {
    const rel = uslRelation(t)!;
    s = rel.startsWith("(") ? s.split(`${rel} ${t}`).join(t).split(rel).join(t) : s.replace(new RegExp(`${rel.replaceAll(".", "\\.")}(?!\\w)`, "g"), t);
  }
  return s;
}

type R = typeof recorded;

/** A direct A record on the conf.d host served by two enabled blocks of one vhost file that trust no range: proxying it is the GO-IF case. */
const CLUB_NAME = "host-1bf78f.club";
const CLUB_FILE = "/etc/nginx/conf.d/word-92cb1d-prod-club.conf";
const proxyClub = { kind: "dns_record", target: { name: CLUB_NAME, type: "A" }, field: "proxied", to: 1 };

async function layerOf(bundle: Readonly<Record<string, unknown>> = recorded): Promise<DataLayer> {
  const engine = await SqlJsEngine.create();
  engine.loadBundle(bundle);
  return new DataLayer(engine);
}

const classes = (fs: { class: string }[]) => fs.map((f) => f.class).sort();
/** The judge never runs in these tests: no model, whatever the environment holds. */
const skip = { judge: "skip" as const };

describe("proposal: parse", () => {
  it("accepts the four committed proposals", () => {
    for (const p of [a, b, c, d]) expect(parseProposal(p).ok).toBe(true);
  });

  it("rejects, with a reason, a shape the simulator cannot bind: no target, a field the kind does not set, a value outside the field's range", () => {
    const bad = (raw: unknown) => { const r = parseProposal(raw); expect(r.ok).toBe(false); return r.ok ? "" : r.reason; };
    expect(bad({ kind: "dns_record", target: {}, field: "proxied", to: 1 })).toMatch(/record_id, or a name and a type/);
    expect(bad({ kind: "dns_record", target: { name: WWW_NAME }, field: "proxied", to: 1 })).toMatch(/record_id, or a name and a type/);
    expect(bad({ kind: "dns_record", target: { record_id: WWW_RECORD }, field: "real_ip", to: 1 })).toMatch(/sets proxied or content/);
    expect(bad({ kind: "dns_record", target: { record_id: WWW_RECORD }, field: "proxied", to: 2 })).toMatch(/proxied is 0 or 1/);
    expect(bad({ kind: "dns_record", target: { record_id: WWW_RECORD }, field: "content", to: "" })).toMatch(/non-empty/);
    expect(bad({ kind: "vhost_real_ip", target: { host: SITES_HOST }, field: "real_ip", to: 15 })).toMatch(/host and an object_id/);
    expect(bad({ kind: "vhost_real_ip", target: { host: SITES_HOST, object_id: QUEST_FILE }, field: "proxied", to: 1 })).toMatch(/sets real_ip/);
    expect(bad({ kind: "vhost_real_ip", target: { host: SITES_HOST, object_id: QUEST_FILE }, field: "real_ip", to: "trusted:lots" })).toMatch(/trusted:<n>/);
    expect(bad("set proxied on www")).toMatch(/proposal|kind/);
    expect(ProposedChange.safeParse({ ...c, to: 22 }).success).toBe(true);
  });
});

describe("proposal: bind to the latest passing run", () => {
  let layer: DataLayer;
  let baseline: PassResult;
  beforeAll(async () => {
    layer = await layerOf();
    baseline = await runPass(layer, { world: new DriftWorld("preflight_test_baseline") });
  });

  it("a record id the DNS run does not hold is rejected and counted as invalid: ESCALATE, nothing simulated, traced", async () => {
    const tracer = new MemTracer("test_preflight", { model: "none" });
    const r = await runPreflight({ ...a, target: { record_id: "0000000000000000000000000000dead" } }, layer, { tracer, baseline, ...skip });
    expect(r.verdict).toBe("ESCALATE");
    expect(r.invalid).toBe(true);
    expect(r.reason).toMatch(new RegExp(`no dns_record with record_id 0000000000000000000000000000dead in the latest passing DNS run \\(${DNS_RUN}\\)`));
    expect(r.bound).toBeNull();
    expect(r.simulations).toEqual([]);
    expect(tracer.events.filter((e) => e.input_summary === "bind_proposal").map((e) => [e.agent, e.status, e.detail])).toEqual([["preflight", "failed", "counted as invalid"]]);
    expect(tracer.events.at(-1)).toMatchObject({ agent: "preflight", action: "escalate", status: "failed" });
    expect(describeVerdict(r)).toMatch(/^\*\*ESCALATE\*\*: No dns_record .* The proposal is counted as invalid\. Nothing was simulated/);
  });

  it("a proposal that does not parse is ESCALATE and invalid, before any query", async () => {
    const tracer = new MemTracer("test_preflight", { model: "none" });
    const r = await runPreflight({ kind: "dns_record", target: {}, field: "proxied", to: 1 }, layer, { tracer, baseline, ...skip });
    expect(r).toMatchObject({ verdict: "ESCALATE", invalid: true, baseline: null, bound: null });
    expect(r.reason).toMatch(/^proposal rejected: target: a dns_record target is a record_id, or a name and a type/);
    expect(tracer.events.map((e) => [e.action, e.status])).toEqual([["triage", "failed"], ["escalate", "failed"]]);
    expect(tracer.events.filter((e) => e.action === "query")).toEqual([]);
  });

  it("binds by name and type to the one apex A record, and by host and object to the two real_ip rows of the vhost", async () => {
    const byName = await runPreflight({ kind: "dns_record", target: { name: APEX_NAME, type: "A" }, field: "content", to: "ip-6fb86d" }, layer, { baseline, ...skip });
    expect(byName.bound).toEqual({ kind: "dns_record", tenant_id: T, run_id: DNS_RUN, change: `content of dns_record ${APEX_RECORD} (${APEX_NAME}, A, zone ${APEX_NAME}) in run ${DNS_RUN}: ip-6fb86d -> ip-6fb86d` });
    const vhost = await runPreflight(c, layer, { baseline, ...skip });
    expect(vhost.bound).toEqual({ kind: "vhost_real_ip", tenant_id: T, run_id: SITES_RUN, change: `real_ip of ${QUEST_FILE} on ${SITES_HOST} in run ${SITES_RUN}: server[${APEX_NAME}:443].real_ip absent, server[${APEX_NAME}:80].real_ip absent -> trusted:15 header:CF-Connecting-IP scope:server` });
  });

  it("a name and type matching two rows is ambiguous: invalid, one row binds", async () => {
    const bundle = structuredClone(recorded) as R;
    const apex = bundle.dns_record.find((x) => x.record_id === APEX_RECORD)!;
    bundle.dns_record.push({ ...apex, record_id: "f32e72c0d010752462567852ca872d99", content: "ip-d572d2" });
    const r = await runPreflight({ kind: "dns_record", target: { name: APEX_NAME, type: "A" }, field: "proxied", to: 1 }, await layerOf(bundle), skip);
    expect(r).toMatchObject({ verdict: "ESCALATE", invalid: true });
    expect(r.reason).toBe(`2 dns_record rows match A record named ${APEX_NAME} in the latest passing DNS run; a proposal binds to one`);
  });

  it("a vhost or host the run does not hold is invalid", async () => {
    const noFile = await runPreflight({ ...c, target: { host: SITES_HOST, object_id: "/etc/nginx/sites-available/nothing.invalid" } }, layer, { baseline, ...skip });
    expect(noFile).toMatchObject({ verdict: "ESCALATE", invalid: true, reason: `no real_ip observation of /etc/nginx/sites-available/nothing.invalid on ${SITES_HOST} in run ${SITES_RUN}` });
    const noHost = await runPreflight({ ...c, target: { host: "host-000000", object_id: QUEST_FILE } }, layer, { baseline, ...skip });
    expect(noHost).toMatchObject({ verdict: "ESCALATE", invalid: true, reason: "no linux.nginx run for host host-000000" });
  });

  it("the latest DNS run failing the DQ gate is ESCALATE but not the proposal's fault: nothing to simulate against", async () => {
    const bundle = structuredClone(recorded) as R;
    const dns = bundle.collection_run.find((r) => r.run_id === DNS_RUN)!;
    dns.status = "partial";
    dns.observed_count = 57;
    const r = await runPreflight(a, await layerOf(bundle), skip);
    expect(r).toMatchObject({ verdict: "ESCALATE", invalid: false, reason: `the latest cloudflare.dns run (${DNS_RUN}) failed the DQ gate; nothing to simulate against` });
    expect(r.baseline?.gated_out).toEqual([DNS_RUN]);
  });
});

describe("overlay: derived tables the guard accepts, identical on both engines, composable, never written", () => {
  const sqljsBare = new DataLayer({ name: "sqljs", qualify: (t) => t, run: async () => { throw new Error("not run"); } });
  const zetaris = new DataLayer(new ZetarisEngine());
  const ds = config.zetaris.datasource;
  const www = dnsRecordOverlay({ run_id: DNS_RUN, record_ids: [WWW_RECORD], field: "proxied", to: 0 });
  const quest = realIpOverlay({ run_id: SITES_RUN, object_id: QUEST_FILE, setting_paths: [`server[${APEX_NAME}:443].real_ip`, `server[${APEX_NAME}:80].real_ip`], to: "trusted:15 header:CF-Connecting-IP scope:server" });
  const both: Overlays = { ...www, ...quest };

  it("each overlay body is one SELECT over its base table, every column in DDL order, the changed column a CASE on the bound rows", () => {
    expect(www.dns_record).toBe(`SELECT record_id, run_id, tenant_id, zone, name, type, content, ttl, CASE WHEN record_id IN ('${WWW_RECORD}') AND run_id = '${DNS_RUN}' THEN 0 ELSE proxied END AS proxied, observed_at FROM {{t:dns_record}}`);
    expect(quest.observation).toContain(`THEN 'trusted:15 header:CF-Connecting-IP scope:server' ELSE value_redacted END AS value_redacted`);
    expect(quest.observation).toContain(`THEN '${simulatedHash("trusted:15 header:CF-Connecting-IP scope:server")}' ELSE value_hash END AS value_hash`);
    for (const body of Object.values(both)) expect(() => assertSelectOnly(sqljsBare.render(body))).not.toThrow();
    // a value with a quote is one escaped literal
    const quoted = dnsRecordOverlay({ run_id: DNS_RUN, record_ids: [WWW_RECORD], field: "content", to: "o'neil.invalid'; DROP TABLE dns_record; --" });
    expect(() => assertSelectOnly(sqljsBare.render(quoted.dns_record))).not.toThrow();
    expect(quoted.dns_record).toContain(`THEN 'o''neil.invalid''; DROP TABLE dns_record; --' ELSE content END`);
  });

  it("renders identically on sql.js and on Zetaris except the relation each table is read as, for the hero, the survey and a bare-table query", () => {
    const s = sqljsBare.withOverlays(both);
    const z = zetaris.withOverlays(both);
    const params = { tenant_id: T, run_id: SITES_RUN, dns_run_id: DNS_RUN };
    for (const sql of [HERO_SQL, PROXIED_WITHOUT_REAL_IP_SQL, OBSERVATIONS_SQL]) {
      const a1 = s.render(sql, params);
      const b1 = z.render(sql, params);
      expect(b1).not.toBe(a1);
      expect(b1).not.toContain(`${ds}.`);
      expect(asTables(b1)).toBe(a1);
      expect(() => assertSelectOnly(a1)).not.toThrow();
      expect(() => assertSelectOnly(b1)).not.toThrow();
      expect(a1).not.toContain("{{");
    }
    // the derived table keeps the query's alias, and gets the table name as alias where the query gives none
    expect(s.render(HERO_SQL, params)).toMatch(/JOIN \(SELECT record_id, .* FROM dns_record\) d\n/);
    expect(s.render(OBSERVATIONS_SQL, { run_id: SITES_RUN })).toMatch(/FROM \(SELECT obs_id, .* FROM observation\) observation\nWHERE run_id = /);
    expect(s.render("SELECT COUNT(*) FROM {{t:observation}} x WHERE x.run_id = {{p:r}}", { r: SITES_RUN })).toMatch(/FROM \(SELECT .* FROM observation\) x WHERE/);
    // an AS alias is the query's alias too: one alias, never `) observation AS o`
    expect(s.render("SELECT COUNT(*) FROM {{t:observation}} AS o WHERE o.run_id = {{p:r}}", { r: SITES_RUN })).toMatch(/FROM \(SELECT .* FROM observation\) AS o WHERE/);
    expect(s.render("SELECT COUNT(*) FROM {{t:observation}} AS o WHERE o.run_id = {{p:r}}", { r: SITES_RUN })).not.toMatch(/\) observation AS o/);
    expect(s.render("SELECT COUNT(*) FROM {{t:observation}}\n  as o WHERE o.run_id = {{p:r}}", { r: SITES_RUN })).toMatch(/FROM \(SELECT .* FROM observation\)\n {2}as o WHERE/);
    expect(z.render("SELECT COUNT(*) FROM {{t:dns_record}} AS d WHERE d.run_id = {{p:r}}", { r: DNS_RUN })).toMatch(new RegExp(`FROM \\(SELECT .* FROM \\(SELECT .* FROM ${USL.replaceAll(".", "\\.")}\\.dns_record\\) dns_record\\) AS d WHERE`));
    expect(s.render("SELECT 1 FROM {{t:dns_record}} WHERE 1 = 1 AND EXISTS (SELECT 1 FROM {{t:dns_record}})")).toMatch(/\) dns_record WHERE 1 = 1 AND EXISTS \(SELECT 1 FROM \(SELECT .*\) dns_record\)$/);
  });

  it("the layer refuses an overlay that is not a SELECT, names an unknown table, does not read its base table, or carries a parameter", () => {
    const over = (overlays: Record<string, string>) => () => new DataLayer(sqljsBare.engine, TABLE_NAMES, { overlays });
    expect(over({ dns_record: "DELETE FROM {{t:dns_record}}" })).toThrow(DataLayerError);
    expect(over({ dns_record: "DELETE FROM {{t:dns_record}}" })).toThrow(/only SELECT/);
    expect(over({ users: "SELECT 1 FROM {{t:users}}" })).toThrow(/overlay on unknown table: users/);
    expect(over({ dns_record: "SELECT 1 FROM {{t:observation}}" })).toThrow(/must read its base table as \{\{t:dns_record\}\}/);
    expect(over({ dns_record: "SELECT * FROM {{t:dns_record}} WHERE proxied = {{p:x}}" })).toThrow(/missing parameter: x/);
    expect(over({ dns_record: "SELECT * FROM {{t:dns_record}}; SELECT 1 FROM {{t:dns_record}}" })).toThrow(/semicolon/);
  });

  it("two changes on one table compose: the second reads the first's SELECT as its base, and sql.js returns both", async () => {
    const layer = await layerOf();
    const composed = dnsRecordOverlay({ run_id: DNS_RUN, record_ids: [APEX_RECORD], field: "proxied", to: 1 }, www);
    expect(composed.dns_record).toMatch(/^SELECT .* FROM \(SELECT .* FROM \{\{t:dns_record\}\}\) base$/);
    const rows = objects(await layer.withOverlays(composed).run(`SELECT record_id, proxied FROM {{t:dns_record}} WHERE run_id = {{p:r}} AND record_id IN ({{p:a}}, {{p:b}}) ORDER BY record_id`, { r: DNS_RUN, a: WWW_RECORD, b: APEX_RECORD }));
    expect(rows).toEqual([{ record_id: WWW_RECORD, proxied: "0" }, { record_id: APEX_RECORD, proxied: "1" }]);
    // the base layer still holds the recorded values
    const base = objects(await layer.run(`SELECT record_id, proxied FROM {{t:dns_record}} WHERE run_id = {{p:r}} AND record_id IN ({{p:a}}, {{p:b}}) ORDER BY record_id`, { r: DNS_RUN, a: WWW_RECORD, b: APEX_RECORD }));
    expect(base).toEqual([{ record_id: WWW_RECORD, proxied: "1" }, { record_id: APEX_RECORD, proxied: "0" }]);
  });

  it("a real pass on the same engine is identical before and after pre-flights: no row exists to leak", async () => {
    const layer = await layerOf();
    const before = await runPass(layer, { world: new DriftWorld("leak_before") });
    for (const p of [a, c, d, proxyClub]) await runPreflight(p, layer, skip);
    const after = await runPass(layer, { world: new DriftWorld("leak_after") });
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after.findings).toHaveLength(38);
    expect(objects(await layer.run(`SELECT proxied FROM {{t:dns_record}} WHERE run_id = {{p:r}} AND record_id = {{p:id}}`, { r: DNS_RUN, id: WWW_RECORD }))).toEqual([{ proxied: "1" }]);
    expect(objects(await layer.run(`SELECT value_redacted FROM {{t:observation}} WHERE run_id = {{p:r}} AND object_id = {{p:o}} AND setting_path LIKE '%.real_ip' ORDER BY setting_path`, { r: SITES_RUN, o: QUEST_FILE }))).toEqual([{ value_redacted: "absent" }, { value_redacted: "absent" }]);
  });
});

describe("verdicts on the recorded bundle (what the simulation computed; not targets)", () => {
  let layer: DataLayer;
  let baseline: PassResult;
  beforeAll(async () => {
    layer = await layerOf();
    baseline = await runPass(layer, { world: new DriftWorld("preflight_verdicts_baseline") });
    expect(baseline.findings).toHaveLength(38);
  });

  it("(a) un-proxy the www record: GO, removes the proxy_split and the two proxied_without_real_ip findings on its vhost, adds none", async () => {
    const r = await runPreflight(a, layer, { baseline, ...skip });
    expect(r.verdict).toBe("GO");
    expect(r.invalid).toBe(false);
    expect(r.bound?.change).toBe(`proxied of dns_record ${WWW_RECORD} (${WWW_NAME}, CNAME, zone ${APEX_NAME}) in run ${DNS_RUN}: 1 -> 0`);
    expect(r.baseline).toEqual({ runs: 4, gated_out: [], observed: recorded.observation.length, findings: 38 });
    expect(r.simulations.map((s) => [s.iteration, s.findings, s.added.length, s.removed.length])).toEqual([[0, 35, 0, 3]]);
    expect(classes(r.removed)).toEqual(["proxied_without_real_ip", "proxied_without_real_ip", "proxy_split"]);
    expect(r.removed.map((f) => f.key)).toEqual([
      `proxy_split|${T}||${WWW_RECORD}|proxied|${WWW_NAME}|${WWW_RECORD}`,
      `proxied_without_real_ip|${T}|${SITES_HOST}|${QUEST_FILE}|server[${APEX_NAME}:443].real_ip|${WWW_NAME}|${WWW_RECORD}`,
      `proxied_without_real_ip|${T}|${SITES_HOST}|${QUEST_FILE}|server[${APEX_NAME}:80].real_ip|${WWW_NAME}|${WWW_RECORD}`,
    ]);
    expect(r.added).toEqual([]);
    expect(r.iterations).toBe(0);
    expect(r.prerequisites).toEqual([]);
    expect(Object.keys(r.overlays)).toEqual(["dns_record"]);
    expect(r.judge.status).toBe("skipped");
    expect(r.judge.target).toBe("removed_by_change");
    expect(r.judge.claim).toBe(r.removed[0].summary);
    expect(describeVerdict(r)).toMatch(/^\*\*GO\*\*: proxied of dns_record .* the change removes 3 findings \(`proxy_split`, `proxied_without_real_ip` x2\) and adds none\. Judge skipped .* Nothing was written; the recorded rows are unchanged\.$/);
  });

  it("(b) replay of the 16 April body, proxied true: the record is already proxied in the recorded world, so GO with nothing removed and nothing added", async () => {
    const r = await runPreflight(b, layer, { baseline, ...skip });
    expect(r.verdict).toBe("GO");
    expect(r.bound?.change).toMatch(/: 1 -> 1$/);
    expect(r.simulations).toEqual([{ iteration: 0, steps: [], findings: 38, added: [], removed: [] }]);
    expect(r.reason).toBe("the proposed value is already the recorded one; the change alters no finding (38 before and after)");
    expect(r.judge).toMatchObject({ status: "skipped", target: null, claim: null, reason: "the change removes no finding; there is no claim whose falsifier could fire" });
    expect(describeVerdict(r)).toContain("The proposed value is already the recorded one");
  });

  it("(c) trusted ranges on the vhost that serves www: GO, removes the two proxied_without_real_ip findings on its blocks, adds none", async () => {
    const r = await runPreflight(c, layer, { baseline, ...skip });
    expect(r.verdict).toBe("GO");
    expect(r.simulations.map((s) => [s.findings, s.added.length, s.removed.length])).toEqual([[36, 0, 2]]);
    expect(r.removed.map((f) => [f.class, f.verb])).toEqual([["proxied_without_real_ip", "ADOPT"], ["proxied_without_real_ip", "ADOPT"]]);
    expect(Object.keys(r.overlays)).toEqual(["observation"]);
    expect(r.overlays.observation).toContain(`setting_path IN ('server[${APEX_NAME}:443].real_ip', 'server[${APEX_NAME}:80].real_ip') THEN 'trusted:15 header:CF-Connecting-IP scope:server'`);
  });

  it("(d) retarget the apex to an address outside the inventory: NO-GO, two dns_change hero findings no prerequisite clears (and the www findings go, since nothing lands on the inventory any more)", async () => {
    const r = await runPreflight(d, layer, { baseline, ...skip });
    expect(r.verdict).toBe("NO-GO");
    expect(r.bound?.change).toBe(`content of dns_record ${APEX_RECORD} (${APEX_NAME}, A, zone ${APEX_NAME}) in run ${DNS_RUN}: ip-6fb86d -> 203.0.113.9`);
    expect(r.simulations.map((s) => [s.findings, s.added.length, s.removed.length])).toEqual([[38, 2, 2]]);
    expect(r.added.map((f) => [f.class, f.verb])).toEqual([["dns_change", "ESCALATE"], ["dns_change", "ESCALATE"]]);
    expect(r.added[0].summary).toBe(`server[${APEX_NAME}:443].server_name[${APEX_NAME}] in ${QUEST_FILE} on ${SITES_HOST} points at ${APEX_NAME}, which resolves to 203.0.113.9, an address not in the inventory`);
    expect(classes(r.removed)).toEqual(["proxied_without_real_ip", "proxied_without_real_ip"]);
    expect(r.reason).toMatch(/^the change adds 2 finding\(s\); dns_change \(.*\) stays: no catalogue prerequisite clears this class$/);
    expect(r.iterations).toBe(0);
    expect(r.judge).toMatchObject({ status: "skipped", reason: "verdict NO-GO: nothing cleared to falsify" });
    expect(describeVerdict(r)).toMatch(/^\*\*NO-GO\*\*: .* leaves 2 findings added \(`dns_change` x2\)\. The change adds 2 finding\(s\); dns_change .* stays: no catalogue prerequisite clears this class\./);
  });

  it("GO-IF: proxying a direct record served by two blocks without a trusted range adds two findings; one add_real_ip_block on that file clears them (and the host-wide wildcard finding with them)", async () => {
    const tracer = new MemTracer("test_preflight", { model: "none" });
    const r = await runPreflight(proxyClub, layer, { tracer, baseline, ...skip });
    expect(r.verdict).toBe("GO-IF");
    expect(r.bound?.change).toBe(`proxied of dns_record c3ab0f5df42a331a48ba064687931ce7 (${CLUB_NAME}, A, zone ${CLUB_NAME}) in run ${DNS_RUN}: 0 -> 1`);
    expect(r.simulations.map((s) => [s.iteration, s.steps, s.findings, s.added.length, s.removed.length])).toEqual([[0, [], 40, 2, 0], [1, ["add_real_ip_block"], 37, 0, 1]]);
    expect(r.simulations[0].added.map((f) => f.key)).toEqual([
      `proxied_without_real_ip|${T}|${CONFD_HOST}|${CLUB_FILE}|server[host-c9c1ae.club:443].real_ip|${CLUB_NAME}|c3ab0f5df42a331a48ba064687931ce7`,
      `proxied_without_real_ip|${T}|${CONFD_HOST}|${CLUB_FILE}|server[host-c9c1ae.club:80].real_ip|${CLUB_NAME}|c3ab0f5df42a331a48ba064687931ce7`,
    ]);
    expect(r.iterations).toBe(1);
    expect(r.prerequisites).toEqual([{
      iteration: 1, id: "add_real_ip_block", cleared: true, from_finding: r.simulations[0].added[0].key,
      params: { host: CONFD_HOST, object_id: CLUB_FILE, run_id: "run-67f4d6923cb4838d", scope: "server", setting_paths: "server[host-c9c1ae.club:443].real_ip server[host-c9c1ae.club:80].real_ip" },
      description: `add set_real_ip_from for Cloudflare's 15 ranges and real_ip_header CF-Connecting-IP to ${CLUB_FILE} on ${CONFD_HOST} (server scope: server[host-c9c1ae.club:443].real_ip, server[host-c9c1ae.club:80].real_ip)`,
    }]);
    expect(r.added).toEqual([]);
    // the one block that now trusts a range is enabled on the conf.d host, so the wildcard's host-wide check no longer fires
    expect(r.removed.map((f) => [f.class, f.key.split("|")[4], f.key.split("|")[5]])).toEqual([["proxied_without_real_ip", "http.real_ip", "*.host-503b27.ai"]]);
    expect(Object.keys(r.overlays).sort()).toEqual(["dns_record", "observation"]);
    expect(r.reason).toBe(`the change adds 2 finding(s) that 1 prerequisite(s) clear: 1. ${r.prerequisites[0].description}`);
    // skipped here (no model), but the target is already the cleared finding, and the trace says so
    expect(r.judge).toMatchObject({ status: "skipped", target: "cleared_by_prerequisite", claim: r.simulations[0].added[0].summary });
    expect(tracer.events.filter((e) => e.action === "judge" && e.target_agent === undefined).map((e) => [e.status, e.output_summary])).toEqual([["skipped", "target: the finding prerequisite 1 (add_real_ip_block) was bound from and cleared"]]);
    expect(describeVerdict(r)).toMatch(/^\*\*GO-IF\*\*: .*\(2 simulations, 1 prerequisite iteration\): the change removes 1 finding \(`proxied_without_real_ip`\) and adds 2 findings \(`proxied_without_real_ip` x2\) that the prerequisites clear\. Prerequisites, in order: \(1\) add set_real_ip_from/);
    const hyp = tracer.events.filter((e) => e.action === "hypothesise");
    expect(hyp).toHaveLength(1);
    expect(hyp[0]).toMatchObject({ agent: "preflight", status: "ok", input_summary: "prerequisite 1: add_real_ip_block" });
    expect(hyp[0].output_summary).toMatch(/^from_failed: proxied_without_real_ip server\[host-c9c1ae.club:443\].real_ip in \/etc\/nginx\/conf.d\/word-92cb1d-prod-club.conf; adds: add set_real_ip_from/);
  });

  it("the loop is bounded: a prerequisite that never clears is applied at most MAX_ITERATIONS times, then ESCALATE", async () => {
    let n = 0;
    const useless: Prerequisite = {
      id: "useless", clears: "proxied_without_real_ip", purpose: "changes nothing, with a fresh key every time",
      bind: async () => ({ id: "useless", params: { n: ++n }, description: `useless step ${n}`, key: `useless|${n}`, apply: (current) => current }),
    };
    const tracer = new MemTracer("test_preflight", { model: "none" });
    const r = await runPreflight(proxyClub, layer, { tracer, baseline, prerequisites: [useless], ...skip });
    expect(MAX_ITERATIONS).toBe(3);
    expect(r.verdict).toBe("ESCALATE");
    expect(r.invalid).toBe(false);
    expect(r.iterations).toBe(3);
    expect(r.simulations).toHaveLength(4);
    expect(r.prerequisites.map((p) => [p.iteration, p.id, p.cleared])).toEqual([[1, "useless", false], [2, "useless", false], [3, "useless", false]]);
    expect(r.added).toHaveLength(2);
    expect(r.reason).toBe("2 finding(s) remain after 3 prerequisite iteration(s); the loop bound is reached");
    expect(tracer.events.filter((e) => e.action === "hypothesise")).toHaveLength(3);
    expect(tracer.events.filter((e) => e.action === "detect" && e.input_summary?.startsWith("simulate iteration"))).toHaveLength(4);
    expect(tracer.events.at(-1)).toMatchObject({ action: "decide", status: "failed" });
    // the same catalogue entry already applied is not applied twice: with a fixed key the loop stops at NO-GO after one try
    const once: Prerequisite = { ...useless, id: "once", bind: async () => ({ id: "once", params: {}, description: "once", key: "once", apply: (cur) => cur }) };
    const r2 = await runPreflight(proxyClub, layer, { baseline, prerequisites: [once], ...skip });
    expect(r2.verdict).toBe("NO-GO");
    expect(r2.iterations).toBe(1);
    expect(r2.reason).toMatch(/stays: once already applied or cannot be bound from this finding$/);
    // and a class with no entry at all is NO-GO before any iteration
    const r3 = await runPreflight(proxyClub, layer, { baseline, prerequisites: [], ...skip });
    expect(r3).toMatchObject({ verdict: "NO-GO", iterations: 0 });
    expect(r3.reason).toMatch(/no catalogue prerequisite clears this class$/);
  });

  it("negative control: a proposal that sets a value to what it already is yields the baseline's findings, key for key", async () => {
    const r = await runPreflight({ kind: "dns_record", target: { record_id: APEX_RECORD }, field: "content", to: "ip-6fb86d" }, layer, { baseline, ...skip });
    expect(r.verdict).toBe("GO");
    expect(r.simulations).toEqual([{ iteration: 0, steps: [], findings: 38, added: [], removed: [] }]);
    expect(r.removed).toEqual([]);
    expect(r.added).toEqual([]);
    const sim = await runPass(layer.withOverlays(r.overlays), { world: new DriftWorld("negative_control") });
    expect(sim.findings.map(findingKey)).toEqual(baseline.findings.map(findingKey));
    expect(sim.findings.map((f) => [f.verb, f.checks.map((c) => [c.template, c.holds, c.rowCount])])).toEqual(baseline.findings.map((f) => [f.verb, f.checks.map((c) => [c.template, c.holds, c.rowCount])]));
  });

  it("the catalogue has one entry per clearable class and nothing for a class the simulator cannot fix", () => {
    expect(PREREQUISITES.map((p) => [p.id, p.clears])).toEqual([["add_real_ip_block", "proxied_without_real_ip"], ["proxy_record", "proxy_split"]]);
  });
});

describe("trace: every step with agent preflight, the pass's own lines labelled with their world", () => {
  it("parse, baseline, bind, overlay_delta, simulate, judge skipped, decide; model: none on every line", async () => {
    const layer = await layerOf();
    const tracer = new MemTracer("test_preflight", { model: "none" });
    const r = await runPreflight(a, layer, { tracer, ...skip });
    expect(r.verdict).toBe("GO");
    const ev = tracer.events;
    expect(ev.every((e) => e.agent === "preflight")).toBe(true);
    expect(ev.every((e) => e.model_requested === "none")).toBe(true);
    expect(ev.filter((e) => e.action === "query" && e.status === "failed")).toEqual([]);
    const own = ev.filter((e) => e.target_agent === undefined && e.action !== "query");
    expect(own.map((e) => [e.action, e.status, e.input_summary])).toEqual([
      ["triage", "ok", "parse_proposal"],
      ["detect", "ok", "simulate baseline"],
      ["triage", "ok", "bind_proposal"],
      ["observe", "ok", "overlay_delta"],
      ["detect", "ok", "simulate iteration 0"],
      ["judge", "skipped", r.removed[0].summary.slice(0, 160)],
      ["decide", "ok", r.bound!.change],
    ]);
    expect(own[0].output_summary).toBe(`dns_record: set proxied to 0 on {"record_id":"${WWW_RECORD}"}`);
    expect(own[1].output_summary).toBe("baseline: 38 finding(s) over 4 run(s), 0 gated out, 1062 observations");
    expect(own[3].output_summary).toBe("1 row(s) of dns_record differ from the recorded world");
    expect(own[3].detail).toContain("CASE WHEN record_id IN (");
    expect(own[4].output_summary).toBe("simulated#0: 35 finding(s); 0 added, 3 removed against the baseline");
    expect(own[6].output_summary).toBe("GO: the change removes 3 finding(s) and adds none");
    expect(own[6].detail).toBe("iterations 0; simulations 1; judge skipped; nothing written");
    // the two passes' own lines: re-labelled, the world named, the original agent kept
    const inner = ev.filter((e) => e.target_agent !== undefined);
    expect(new Set(inner.map((e) => e.target_agent))).toEqual(new Set(["observer", "detector", "checker", "decider", "judge"]));
    const worlds = new Set(inner.map((e) => e.detail?.match(/^world=([^;]+)/)?.[1]));
    expect(worlds).toEqual(new Set(["baseline", "simulated#0"]));
    expect(inner.filter((e) => e.action === "decide" && e.detail?.startsWith("world=baseline"))).toHaveLength(38);
    expect(inner.filter((e) => e.action === "decide" && e.detail?.startsWith("world=simulated#0"))).toHaveLength(35);
    // the simulated world's queries ran over the derived table, the baseline's over the base table
    // (input_summary is the first 160 characters of the SQL, so only queries that reach the table early show the derived table)
    const derived = (e: { input_summary?: string }) => e.input_summary?.includes("JOIN (SELECT record_id, run_id, tenant_id, zone") ?? false;
    const simQueries = inner.filter((e) => e.action === "query" && e.detail?.startsWith("world=simulated#0"));
    expect(simQueries.filter(derived).length).toBeGreaterThan(0);
    expect(simQueries.some((e) => e.input_summary?.includes("JOIN dns_record d"))).toBe(false);
    const baseQueries = inner.filter((e) => e.action === "query" && e.detail?.startsWith("world=baseline"));
    expect(baseQueries.some(derived)).toBe(false);
    expect(baseQueries.some((e) => e.input_summary?.includes("JOIN dns_record d"))).toBe(true);
  });
});

describe("judge in the fixed world (live only; stubbed here)", () => {
  /** A judge that answers with `sql` and, like judgeClaim, runs it on the layer it was given to count rows. */
  const stub = (sql: string, over: Partial<JudgeVerdict> = {}) => async (input: JudgeInput): Promise<JudgeVerdict> => {
    const r = await input.layer.run(sql, {}, { agent: "judge", tracer: input.tracer, limit: 50 });
    return { status: r.rowCount > 0 ? "refuted" : "stands", reason: `${r.rowCount} row(s)`, sql, rowCount: r.rowCount, rationale: "rows mean the claim is false", receiptId: "rcpt_test", servedModel: "openrouter/nvidia/nemotron-3-ultra-test", latencyMs: 1, ...over };
  };
  const calls: JudgeInput[] = [];
  const remember = (j: (i: JudgeInput) => Promise<JudgeVerdict>) => async (i: JudgeInput) => { calls.push(i); return j(i); };

  it("a sound falsifier fires in the fixed world and not in the recorded one; the claim is the removed finding's summary, the layer the overlaid one", async () => {
    const layer = await layerOf();
    const tracer = new MemTracer("test_preflight");
    const sql = `SELECT d.record_id FROM {{t:dns_record}} d WHERE d.record_id = '${WWW_RECORD}' AND d.run_id = '${DNS_RUN}' AND d.proxied = 0`;
    const r = await runPreflight(a, layer, { tracer, judge: remember(stub(sql)) });
    expect(r.verdict).toBe("GO");
    expect(r.judge).toEqual({ status: "fires", reason: "the falsifier returns 1 row(s) in the fixed world and none in the recorded one", target: "removed_by_change", claim: r.removed[0].summary, sql, rows_fixed: 1, rows_baseline: 0, receipt_id: "rcpt_test", served_model: "openrouter/nvidia/nemotron-3-ultra-test" });
    expect(calls).toHaveLength(1);
    expect(calls[0].claim).toBe(r.removed[0].summary);
    expect(calls[0].layer.overlays).toEqual(r.overlays);
    expect(calls[0].evidenceRows.columns).toContain("resource_id");
    expect(calls[0].evidenceRows.rows[0][calls[0].evidenceRows.columns.indexOf("resource_id")]).toBe(WWW_RECORD);
    const critique = tracer.events.filter((e) => e.action === "critique");
    expect(critique).toHaveLength(1);
    expect(critique[0]).toMatchObject({ agent: "preflight", status: "ok", output_summary: "falsifier_fires: true", receipt_id: "rcpt_test" });
    expect(critique[0].detail).toMatch(/^target: the first finding the change removes; the falsifier returns 1 row\(s\)/);
    const chosen = tracer.events.filter((e) => e.action === "judge" && e.target_agent === undefined);
    expect(chosen.map((e) => [e.status, e.output_summary])).toEqual([["ok", "target: the first finding the change removes"]]);
    expect(describeVerdict(r)).toContain("The judge's falsifier fired in the fixed world (1 rows) and not in the recorded one; receipt rcpt_test");
  });

  it("GO-IF: the target is the finding the last prerequisite cleared, not a baseline finding the change removed; its claim is true in the simulation it was bound in, and the falsifier is re-run there", async () => {
    const layer = await layerOf();
    const tracer = new MemTracer("test_preflight");
    const localCalls: JudgeInput[] = [];
    // Rows where the :443 block of the club file has a trusted range (true only in the fixed world), OR any row at all
    // while the club A record is still direct (true in the recorded world, false in every simulation of this pre-flight):
    // fires only if the re-run is in the simulation the cleared finding was bound in; judged against the recorded world it would refute.
    const sql = `SELECT o.obs_id FROM {{t:observation}} o WHERE (o.object_id = '${CLUB_FILE}' AND o.setting_path = 'server[host-c9c1ae.club:443].real_ip' AND o.value_redacted <> 'absent') OR EXISTS (SELECT 1 FROM {{t:dns_record}} d WHERE d.record_id = 'c3ab0f5df42a331a48ba064687931ce7' AND d.run_id = '${DNS_RUN}' AND d.proxied = 0)`;
    const r = await runPreflight(proxyClub, layer, { tracer, judge: async (i) => { localCalls.push(i); return stub(sql)(i); } });
    expect(r.verdict).toBe("GO-IF");
    expect(r.removed).toHaveLength(1);                                   // the wildcard finding the change also removes is NOT the target
    expect(r.judge).toMatchObject({ status: "fires", target: "cleared_by_prerequisite", claim: r.simulations[0].added[0].summary, rows_fixed: 1, rows_baseline: 0 });
    expect(r.judge.claim).toBe(r.prerequisites[0].from_finding === r.simulations[0].added[0].key ? r.simulations[0].added[0].summary : "");
    expect(r.judge.claim).not.toBe(r.removed[0].summary);
    expect(r.judge.reason).toBe("the falsifier returns 1 row(s) in the fixed world and none in simulated#0, the simulation it was bound in");
    expect(localCalls).toHaveLength(1);
    expect(localCalls[0].layer.overlays).toEqual(r.overlays);              // asked in the fixed world: both overlays in place
    expect(localCalls[0].evidenceRows.rows[0][localCalls[0].evidenceRows.columns.indexOf("object_id")]).toBe(CLUB_FILE);
    const chosen = tracer.events.filter((e) => e.action === "judge" && e.target_agent === undefined);
    expect(chosen.map((e) => e.output_summary)).toEqual(["target: the finding prerequisite 1 (add_real_ip_block) was bound from and cleared"]);
    expect(chosen[0].detail).toMatch(/^claim false in the fixed world \(the last simulation\), true in simulated#0/);
    expect(describeVerdict(r)).toContain("fired in the fixed world (1 rows) and not in the simulation the cleared finding was bound in");
    // the same SQL run in the recorded world returns rows (the club record is direct there): the old target world would have called this refutes_baseline
    expect((await layer.run(sql, {}, { limit: 50 })).rowCount).toBeGreaterThan(0);
  });

  it("a falsifier that returns nothing where the claim is false is vacuous, and one that fires in both worlds refutes the recorded claim", async () => {
    const layer = await layerOf();
    const tracer = new MemTracer("test_preflight");
    const vacuous = await runPreflight(a, layer, { tracer, judge: stub(`SELECT d.record_id FROM {{t:dns_record}} d WHERE d.record_id = '${WWW_RECORD}' AND d.proxied = 2`) });
    expect(vacuous.verdict).toBe("GO");
    expect(vacuous.judge).toMatchObject({ status: "falsifier_vacuous", target: "removed_by_change", rows_fixed: 0, rows_baseline: 0 });
    expect(tracer.events.filter((e) => e.action === "critique").map((e) => [e.status, e.output_summary])).toEqual([["failed", "falsifier_fires: false"]]);
    const both = await runPreflight(a, layer, { judge: stub(`SELECT d.record_id FROM {{t:dns_record}} d WHERE d.record_id = '${WWW_RECORD}' AND d.run_id = '${DNS_RUN}'`) });
    expect(both.judge).toMatchObject({ status: "refutes_baseline", rows_fixed: 1, rows_baseline: 1 });
    const notJudged = await runPreflight(a, layer, { judge: async () => ({ status: "not_judged", reason: "receipt gate: lightning served", sql: null, rowCount: null, rationale: null, receiptId: "rcpt_x", servedModel: "lightning", latencyMs: 1 }) });
    expect(notJudged.judge).toMatchObject({ status: "not_judged", reason: "receipt gate: lightning served", rows_fixed: null, receipt_id: "rcpt_x" });
    expect(notJudged.verdict).toBe("GO");
  });

  it("is never called for a verdict that clears nothing", async () => {
    const layer = await layerOf();
    let called = 0;
    const spy = async (i: JudgeInput) => { called++; return stub("SELECT 1 FROM {{t:dns_record}}")(i); };
    expect((await runPreflight(b, layer, { judge: spy })).judge.status).toBe("skipped");
    expect((await runPreflight(d, layer, { judge: spy })).judge.status).toBe("skipped");
    expect(called).toBe(0);
  });
});

describe("the recorded verdict files match the simulation", () => {
  it("examples/proposals/*.verdict.json carry the verdicts the tests above assert", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (name: string) => JSON.parse(readFileSync(new URL(`../examples/proposals/${name}.verdict.json`, import.meta.url), "utf8")) as PreflightResult;
    expect([read("a-unproxy-www").verdict, read("b-replay-16-april-proxied").verdict, read("c-vhost-real-ip").verdict, read("d-retarget-apex-outside-inventory").verdict]).toEqual(["GO", "GO", "GO", "NO-GO"]);
    expect(read("a-unproxy-www").removed).toHaveLength(3);
    // The verdict files are written over sample/bundle.json. Verdict (d) moves the apex outside the inventory, and the two vhost
    // name settings that point at it become hero findings whose class follows how the previous passing host run pairs with a DNS
    // run: found_but_different when it paired with an earlier DNS run and the apex's fingerprint moved, dns_change when both host
    // runs pair with the same DNS run. Measured 25 Oct 2026 over the bundle of the 03:25 UTC cycle (26 runs): dns_change x2.
    const recordedD = read("d-retarget-apex-outside-inventory").added.map((f) => f.class);
    expect(recordedD).toHaveLength(2);
    for (const cls of recordedD) expect(["found_but_different", "dns_change"]).toContain(cls);
    const overSample = await runPreflight(d, await layerOf(sample), skip);
    expect(recordedD, "the (d) verdict file is stale: rerun npm run preflight -- --proposal examples/proposals/d-retarget-apex-outside-inventory.json --out examples/proposals/d-retarget-apex-outside-inventory.verdict.json").toEqual(overSample.added.map((f) => f.class));
  }, 60_000);
});
