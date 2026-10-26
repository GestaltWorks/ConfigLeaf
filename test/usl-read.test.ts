// How the live engine names the catalogue's tables, with no live call: every {{t:<table>}} renders as the drift_usl
// entity built from that table (src/zetaris/setup.ts READ_AS), under the table's own column names, so the one SQL text
// runs on sql.js and through the semantic layer; a query holding an OR that Spark could push whole into one USL scan
// reads every entity fenced (fencedOr, src/data/engines/zetaris.ts), because USLTableScan compiles a pushed Or without
// its parentheses (measured live 26 Oct 2026: `run_id = 'r' AND (host = 'h' OR host IS NULL)` gave 6,090 rows for 0).
import { describe, expect, it } from "vitest";
import { DataLayer, LAYER_TABLES, assertSelectOnly } from "../src/data/layer.ts";
import { ZetarisEngine, fencedOr } from "../src/data/engines/zetaris.ts";
import * as Q from "../src/data/queries.ts";
import { ADOPTION_CHECK_SQL, ADOPTION_SQL } from "../src/data/files.ts";
import { CATALOGUE } from "../src/catalogue/templates.ts";
import { READ_AS, USL, uslRelation } from "../src/zetaris/setup.ts";

const zetaris = new DataLayer(new ZetarisEngine());
const sqljs = new DataLayer({ name: "sqljs", qualify: (t) => t, run: async () => { throw new Error("not run"); } });

/** Every SQL text of the catalogue: the queries, the file tables' cross-source read and the judge's templates. */
const CATALOGUE_SQL: [string, string][] = [
  ...Object.entries(Q).filter(([, v]) => typeof v === "string" && v.includes("{{t:")).map(([k, v]) => [k, v as string] as [string, string]),
  ["ADOPTION_SQL", ADOPTION_SQL], ["ADOPTION_CHECK_SQL", ADOPTION_CHECK_SQL],
  ...CATALOGUE.map((t) => [`template ${t.id}`, t.sql] as [string, string]),
];
/** Each {{p:name}} of a text bound to a plain literal, so render() runs. */
const bound = (sql: string): Record<string, string> => Object.fromEntries([...sql.matchAll(/\{\{p:(\w+)\}\}/g)].map((m) => [m[1], "x"]));

describe("the catalogue through the semantic layer", () => {
  it("every table the layer knows is read through an entity, and no catalogue text names DRIFT, LESSONS or RULES on Zetaris", () => {
    for (const t of LAYER_TABLES) expect(uslRelation(t), t).toBeDefined();
    expect(Object.keys(READ_AS).sort()).toEqual([...LAYER_TABLES].sort());
    for (const [name, sql] of CATALOGUE_SQL) {
      const z = zetaris.render(sql, bound(sql));
      expect(z, name).not.toMatch(/\b(?:DRIFT|LESSONS|RULES)\.\w/);
      expect(z, name).toContain(`${USL}.`);
      expect(() => assertSelectOnly(z), name).not.toThrow();
    }
  });

  it("the derived relation takes the query's alias, or the table name when there is none; the bare entity takes none", () => {
    expect(zetaris.render("SELECT o.obs_id FROM {{t:observation}} o WHERE o.run_id = {{p:r}}", { r: "x" })).toBe(`SELECT o.obs_id FROM ${uslRelation("observation")} o WHERE o.run_id = 'x'`);
    expect(zetaris.render("SELECT obs_id FROM {{t:observation}} WHERE run_id = {{p:r}}", { r: "x" })).toBe(`SELECT obs_id FROM ${uslRelation("observation")} observation WHERE run_id = 'x'`);
    expect(zetaris.render("SELECT COUNT(*) FROM {{t:observation}} AS o", {})).toBe(`SELECT COUNT(*) FROM ${uslRelation("observation")} AS o`);
    expect(zetaris.render("SELECT run_id FROM {{t:collection_run}} WHERE run_id = {{p:r}}", { r: "x" })).toBe(`SELECT run_id FROM ${USL}.collection WHERE run_id = 'x'`);
    // an overlay's base table renders the same way inside the derived table the overlay is
    const over = zetaris.withOverlays({ observation: "SELECT obs_id, run_id FROM {{t:observation}} WHERE run_id = 'r'" });
    expect(over.render("SELECT obs_id FROM {{t:observation}} o", {})).toBe(`SELECT obs_id FROM (SELECT obs_id, run_id FROM ${uslRelation("observation")} observation WHERE run_id = 'r') o`);
  });

  it("sql.js renders every catalogue text as it did: the bare table names", () => {
    for (const [name, sql] of CATALOGUE_SQL) expect(sqljs.render(sql, bound(sql)), name).not.toContain("drift_usl");
    expect(sqljs.render("SELECT obs_id FROM {{t:observation}} o", {})).toBe("SELECT obs_id FROM observation o");
  });
});

describe("fencedOr: an OR Spark could push whole into one USL scan", () => {
  it("fences an OR over one table's columns, at the top or in a group, a NOT over a group, and one inside an uncorrelated subquery", () => {
    for (const sql of [
      "SELECT 1 FROM {{t:observation}} o WHERE o.run_id = 'r' AND (o.host = 'h' OR o.host IS NULL)",
      "SELECT rule_id FROM {{t:policy_rule}} WHERE tenant_id = {{p:t}} OR tenant_id = '*'",
      "SELECT 1 FROM {{t:observation}} o WHERE o.run_id = 'r' AND NOT (o.object_id = 'a' AND o.setting_path = 'b')",
      "SELECT 1 FROM {{t:observation}} o WHERE NOT EXISTS (SELECT 1 FROM {{t:dns_record}} x WHERE x.run_id = 'r' OR x.run_id = 's')",
      "SELECT 1 FROM {{t:dns_record}} d LEFT JOIN {{t:inventory_asset}} i ON i.address = d.content AND (i.kind = 'vps' OR i.kind IS NULL)",
      "select 1 from {{t:audit_event}} e where e.tenant_id = 't' and (e.new_value = 'a' or e.new_value like '%a%')",
    ]) expect(fencedOr(sql), sql).toBe(true);
  });

  it("leaves an OR that spans two tables, one that holds a subquery, one in a literal, and a query with none", () => {
    for (const sql of [
      Q.DRIFT_VS_APPROVED_SQL, Q.RUN_COMPLETE_SQL, Q.ORPHAN_VHOST_SQL, Q.CHANGED_SINCE_BACKUP_SQL, Q.HERO_SQL, Q.OBSERVATIONS_SQL,
      "SELECT 1 FROM {{t:observation}} o WHERE NOT EXISTS (SELECT 1 FROM {{t:dns_record}} x WHERE x.a = o.a AND (x.k > o.k OR x.j = o.j))",
      "SELECT 1 FROM {{t:disposition}} d WHERE d.reason = 'this OR that' AND d.verb = 'NOT (x)'",
      "SELECT 1 FROM {{t:observation}} o WHERE o.run_id = 'r' AND NOT EXISTS (SELECT 1 FROM {{t:dns_record}} d WHERE d.name = o.refers_to_id)",
      "SELECT 1 FROM {{t:observation}} o ORDER BY o.obs_id",
    ]) expect(fencedOr(sql), sql.slice(0, 80)).toBe(false);
  });

  it("the catalogue's own: the reads whose OR names one table are fenced, and only those", () => {
    const fenced = CATALOGUE_SQL.filter(([, sql]) => fencedOr(sql)).map(([name]) => name).sort();
    expect(fenced).toEqual(["APPROVED_COPIES_SQL", "APPROVED_MISSING_SQL", "POLICY_RULES_SQL", "template other_settings_reference"]);
  });

  it("a fenced query reads every entity through a SELECT with LIMIT, an OR in an overlay body included; sql.js is untouched", () => {
    const z = zetaris.render(Q.POLICY_RULES_SQL, { tenant_id: "t" });
    expect(z).toBe(Q.POLICY_RULES_SQL.replace("{{t:policy_rule}}", `${uslRelation("policy_rule", { fence: true })} policy_rule`).replace("{{p:tenant_id}}", "'t'"));
    expect(z).toContain("LIMIT 2147483647) policy_rule\nWHERE tenant_id = 't' OR tenant_id = '*'");
    const over = zetaris.withOverlays({ dns_record: "SELECT record_id, run_id, tenant_id, zone, name, type, content, ttl, proxied, observed_at FROM {{t:dns_record}} WHERE type = 'A' OR type = 'AAAA'" });
    expect(over.render(Q.TICKET_ZONES_SQL, { tenant_id: "t", dns_run_id: "d" })).toContain(`FROM ${uslRelation("dns_record", { fence: true })} dns_record WHERE type = 'A' OR type = 'AAAA'`);
    expect(zetaris.render(Q.TICKET_ZONES_SQL, { tenant_id: "t", dns_run_id: "d" })).not.toContain("LIMIT");
    expect(sqljs.render(Q.POLICY_RULES_SQL, { tenant_id: "t" })).toContain("FROM policy_rule\nWHERE");
  });
});
