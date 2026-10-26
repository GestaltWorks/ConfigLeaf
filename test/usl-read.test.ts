// How the live engine names the catalogue's tables, with no live call: every {{t:<table>}} renders as the drift_usl
// entity built from that table (src/zetaris/setup.ts READ_AS), under the table's own column names, so the one SQL text
// runs on sql.js and through the semantic layer; a query holding an OR that Spark could push whole into one USL scan
// reads every entity fenced (fencedOr, src/data/engines/zetaris.ts), because USLTableScan compiles a pushed Or without
// its parentheses (measured live 26 Oct 2026: `run_id = 'r' AND (host = 'h' OR host IS NULL)` gave 6,090 rows for 0).
import { describe, expect, it } from "vitest";
import { DataLayer, LAYER_TABLES, assertSelectOnly, stripLiterals } from "../src/data/layer.ts";
import { ZetarisEngine, fencedOr } from "../src/data/engines/zetaris.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import * as Q from "../src/data/queries.ts";
import * as F from "../src/data/files.ts";
import { ADOPTION_CHECK_SQL, ADOPTION_SQL } from "../src/data/files.ts";
import * as TEMPLATES from "../src/catalogue/templates.ts";
import { CATALOGUE } from "../src/catalogue/templates.ts";
import * as WORLD from "../src/engine/world.ts";
import * as EXPLAIN from "../src/explain/explain.ts";
import * as EVAL from "../src/eval/queries.ts";
import * as PREREQUISITES from "../src/preflight/prerequisites.ts";
import * as PROPOSAL from "../src/preflight/proposal.ts";
import { FENCE_LIMIT, READ_AS, SetupError, USL, joinedKey, mirrorMismatches, uslRelation } from "../src/zetaris/setup.ts";
import { SCHEMA_TABLES } from "../src/data/schema.ts";

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

/** Every SQL text over {{t:}} that the modules the live pass reads through export: strings, and the sql of each element of an exported list. */
function sqlTexts(mods: Readonly<Record<string, Readonly<Record<string, unknown>>>>): [string, string][] {
  return Object.entries(mods).flatMap(([m, ns]) => Object.entries(ns).flatMap(([k, v]): [string, string][] => {
    if (typeof v === "string") return v.includes("{{t:") ? [[`${m}.${k}`, v]] : [];
    if (!Array.isArray(v)) return [];
    return v.flatMap((x, i): [string, string][] => {
      const sql = (x as { sql?: unknown } | null)?.sql;
      return typeof sql === "string" && sql.includes("{{t:") ? [[`${m}.${k}[${(x as { id?: string }).id ?? i}]`, sql]] : [];
    });
  }));
}
const ALL_SQL = sqlTexts({ queries: Q, files: F, templates: TEMPLATES, world: WORLD, explain: EXPLAIN, eval: EVAL, prerequisites: PREREQUISITES, proposal: PROPOSAL });
const holdsOr = (sql: string): boolean => /\bOR\b|\bNOT\s*\(/i.test(stripLiterals(sql));

/**
 * The texts that hold an OR and are read unfenced, each reviewed by hand: every OR in it names two tables with no table
 * holding a conjunct of its own in every disjunct, or holds a subquery, so Spark pushes no part of it into one scan.
 */
const REVIEWED_UNFENCED: Readonly<Record<string, string>> = {
  "queries.CHANGED_SINCE_BACKUP_SQL": "b.value_hash against o.value_hash; the tie-break compares x with s",
  "queries.DOC_COPIES_SQL": "the tie-breaks compare x with v and y with c",
  "queries.DOC_DISPOSITIONS_OF_RUN_SQL": "the tie-break compares n with d",
  "queries.DRIFT_VS_APPROVED_SQL": "the tie-break compares n with a",
  "queries.FOUND_BUT_DIFFERENT_SQL": "the tie-breaks compare x with f and y with pf",
  "queries.LATEST_APPROVALS_SQL": "the tie-break compares n with a",
  "queries.ORPHAN_VHOST_SQL": "the OR holds a NOT EXISTS subquery",
  "queries.PRIOR_HOLDS_SQL": "the tie-break compares n with d",
  "queries.FAILING_RUNS_SQL": "the OR group holds a scalar subquery, as in RUN_COMPLETE_SQL",
  "queries.RUN_COMPLETE_SQL": "the OR group holds a scalar subquery",
  "templates.CATALOGUE[restore_would_regress]": "b.value_hash against a.value_hash",
  "templates.CATALOGUE[run_complete]": "RUN_COMPLETE_SQL",
  "templates.CATALOGUE[setting_matches_approved]": "a.host against o.host in the JOIN ON",
};

describe("every OR the live pass can send is fenced, or reviewed as one Spark cannot push into one scan", () => {
  it("walks the catalogue, the file tables' read, the judge's templates, the World Model's audit reads, the explainer, the eval and the preflight", () => {
    expect(ALL_SQL.length).toBeGreaterThan(60);
    const unreviewed = ALL_SQL.filter(([name, sql]) => holdsOr(sql) && !fencedOr(sql) && !Object.hasOwn(REVIEWED_UNFENCED, name)).map(([name]) => name);
    expect(unreviewed, "an OR read unfenced that nobody reviewed: fence it or add it to REVIEWED_UNFENCED with the reason").toEqual([]);
    // the list stays exact: each reviewed text exists, holds an OR and is read unfenced
    for (const name of Object.keys(REVIEWED_UNFENCED)) {
      const sql = ALL_SQL.find(([n]) => n === name)?.[1];
      expect(sql, name).toBeDefined();
      expect([holdsOr(sql!), fencedOr(sql!)], name).toEqual([true, false]);
    }
    // the World Model's audit reads and the explainer's evidence read are fenced: their ORs name the audit_event row alone
    for (const name of ["world.EXPOSURE_SINCE_SQL", "world.EXPOSURE_BEFORE_SQL", "explain.CAUSE_EVENTS_SQL"]) expect(fencedOr(ALL_SQL.find(([n]) => n === name)![1]), name).toBe(true);
  });

  it("each fenced text renders every entity it reads with the fence, and an unfenced one none", () => {
    for (const [name, sql] of ALL_SQL) {
      const z = zetaris.render(sql, bound(sql));
      const reads = z.split(`FROM ${USL}.`).length - 1;
      const fenced = z.split(` LIMIT ${FENCE_LIMIT})`).length - 1;
      expect(fenced, name).toBe(fencedOr(sql) ? reads : 0);
    }
  });
});

describe("fencedOr: an OR Spark could push whole into one USL scan", () => {
  it("edge cases: CASE, a comment, a backquoted name, an escaped quote, lower case, an OR with no space around it, HAVING, extraction through a join", () => {
    const fence: [string, string][] = [
      ["an OR inside a CASE in the WHERE (Spark folds CASE ... = 1 into the OR)", "SELECT 1 FROM {{t:observation}} o WHERE o.run_id = 'r' AND CASE WHEN o.host = 'h' OR o.host IS NULL THEN 1 ELSE 0 END = 1"],
      ["an OR in a comment fences (and the guard refuses the comment)", "SELECT 1 FROM {{t:observation}} o WHERE o.run_id = 'r' -- or not"],
      ["an OR in a block comment", "SELECT 1 FROM {{t:observation}} o WHERE o.run_id = 'r' /* a OR b */"],
      ["backquoted columns name no alias", "SELECT 1 FROM {{t:observation}} o WHERE `o`.`run_id` = 'r' AND (`o`.`host` = 'h' OR `o`.`host` IS NULL)"],
      ["a literal with an escaped quote and a paren", "SELECT 1 FROM {{t:disposition}} d WHERE d.reason = 'it''s (OR not' AND (d.verb = 'HOLD' OR d.verb = 'ADOPT')"],
      ["no space around the OR", "SELECT 1 FROM {{t:observation}} o WHERE o.run_id = 'r' AND (o.host='h')OR(o.host IS NULL)"],
      ["HAVING over a grouping column, which Spark pushes below the aggregate", "SELECT o.run_id, COUNT(*) FROM {{t:observation}} o GROUP BY o.run_id HAVING o.run_id = 'a' OR o.run_id = 'b'"],
      ["a NOT over a group that names two tables", "SELECT 1 FROM {{t:observation}} o JOIN {{t:dns_record}} d ON d.name = o.refers_to_id WHERE NOT (o.host = 'h' AND d.type = 'A')"],
      ["an OR across two tables whose every disjunct holds a conjunct on o alone", "SELECT 1 FROM {{t:observation}} o JOIN {{t:dns_record}} d ON d.name = o.refers_to_id WHERE (o.host = 'a' AND d.type = 'A') OR (o.host = 'b' AND d.type = 'AAAA')"],
      ["an OR in a window function's derived table, read by one alias", "SELECT 1 FROM (SELECT obs_id, ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY obs_id) AS n FROM {{t:observation}}) x WHERE x.n = 1 OR x.n = 2"],
    ];
    for (const [why, sql] of fence) expect(fencedOr(sql), why).toBe(true);
    const leave: [string, string][] = [
      ["an OR in a CASE of the SELECT list is no filter", "SELECT CASE WHEN o.host = 'h' OR o.host IS NULL THEN 1 ELSE 0 END AS f FROM {{t:observation}} o WHERE o.run_id = 'r'"],
      ["an OR across two tables with a disjunct on d alone", "SELECT 1 FROM {{t:observation}} o JOIN {{t:dns_record}} d ON d.name = o.refers_to_id WHERE o.host = 'a' OR d.type = 'A'"],
      ["the words OR and NOT ( in literals", "SELECT 1 FROM {{t:disposition}} d WHERE d.reason = 'x OR y' AND d.verb = 'NOT (z)'"],
      ["ORDER BY, ORIGIN and NOT EXISTS are no OR", "SELECT d.origin FROM {{t:dns_record}} d WHERE NOT EXISTS (SELECT 1 FROM {{t:observation}} o WHERE o.refers_to_id = d.name) ORDER BY d.record_id"],
    ];
    for (const [why, sql] of leave) expect(fencedOr(sql), why).toBe(false);
    // a comment never reaches Zetaris: the guard refuses it whatever fencedOr said
    expect(() => assertSelectOnly(zetaris.render("SELECT 1 FROM {{t:observation}} o WHERE o.run_id = 'r' -- or not"))).toThrow(/comments/);
  });

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
    expect(fenced).toEqual(["APPROVED_COPIES_SQL", "APPROVED_MISSING_SQL", "MAIL_RECORDS_SQL", "POLICY_RULES_SQL", "template other_settings_reference"]);
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

  it("FENCE_LIMIT is the largest INT, the LIMIT Spark takes, so it bounds no table; the fence is that LIMIT and nothing else", () => {
    expect(FENCE_LIMIT).toBe(2 ** 31 - 1);
    const fenced = uslRelation("collection_run", { fence: true })!;
    expect(fenced.endsWith(` LIMIT ${FENCE_LIMIT})`)).toBe(true);
    expect(fenced.replace(` LIMIT ${FENCE_LIMIT}`, "")).toBe(`(SELECT run_id, tenant_id, surface, host, started_at, finished_at, expected_count, observed_count, status FROM ${USL}.collection)`);
    for (const t of LAYER_TABLES) {
      expect(uslRelation(t, { fence: true })!.endsWith(` LIMIT ${FENCE_LIMIT})`), t).toBe(true);
      expect(uslRelation(t), t).not.toContain("LIMIT");
    }
  });
});

describe("READ_AS against the DDL and sql/schema.sql", () => {
  it("uslRelation() refuses an entry whose renames or entity disagree with the table and the DDL", () => {
    const bad = (r: (typeof READ_AS)[string]) => () => uslRelation("observation", {}, { observation: r });
    expect(bad({ entity: "setting", renames: { obs_id: "setting_id", source: "source_kind", nope: "x" } })).toThrow(/renames nope of observation, which observation lacks/);
    expect(bad({ entity: "setting", renames: { obs_id: "setting_id" } })).toThrow(/setting lacks source, which reading observation needs/);
    expect(bad({ entity: "collection" })).toThrow(/collection lacks obs_id, .*which reading observation needs/);
    expect(bad({ entity: "nope" as never })).toThrow(SetupError);
    // the mapping as it stands reads every table
    for (const t of LAYER_TABLES) expect(() => uslRelation(t)).not.toThrow();
  });

  it("mirrorMismatches(): the columns, the added keys and NOT NULL agree across USL_DDL, READ_AS and sql/schema.sql, and a breach of each is named", () => {
    expect(mirrorMismatches()).toEqual([]);
    const schema = SCHEMA_TABLES.map((t) => (t.name === "approved_setting" ? { ...t, notNull: (t.notNull ?? []).filter((c) => c !== "value_hash") } : t));
    expect(mirrorMismatches(undefined, schema)).toEqual(["approved_setting.value_hash is NOT NULL in USL_DDL, nullable in sql/schema.sql"]);
    const extra = SCHEMA_TABLES.map((t) => (t.name === "probe" ? { ...t, columns: [...t.columns, "added"] } : t));
    expect(mirrorMismatches(undefined, extra)).toEqual(["probe lacks added of probe"]);
    const ddl = { dns_record: ["dns_record_id varchar(1024)", "record_id varchar(64) NOT NULL", "run_id varchar(128) NOT NULL", "tenant_id varchar(64) NOT NULL", "zone varchar(255) NOT NULL", "name varchar(255) NOT NULL", "type varchar(16) NOT NULL", "content varchar(65535) NOT NULL", "ttl int", "proxied int", "observed_at varchar(40) NOT NULL", "spare int"] };
    expect(mirrorMismatches(ddl).filter((m) => m.startsWith("dns_record"))).toEqual(["dns_record.spare is no column of dns_record", "dns_record.dns_record_id is not NOT NULL PRIMARY KEY"]);
  });
});

describe("joinedKey(): a key of several columns cannot collide on its separator", () => {
  it("escapes % and : in each value before joining by ':', on sql.js as on Spark", async () => {
    expect(joinedKey(["a", "b"])).toBe("CONCAT(REPLACE(REPLACE(a, '%', '%25'), ':', '%3A'), ':', REPLACE(REPLACE(b, '%', '%25'), ':', '%3A'))");
    const lite = await SqlJsEngine.create();
    const pairs = [["x:y", "z"], ["x", "y:z"], ["x%3Ay", "z"], ["run-1", "rec-2"]];
    const values = pairs.map(([a, b]) => `SELECT '${a}' AS a, '${b}' AS b`).join(" UNION ALL ");
    const r = await lite.run(`SELECT ${joinedKey(["a", "b"])} AS k FROM (${values}) t`);
    const keys = r.rows.map((row) => row[0]);
    expect(new Set(keys).size).toBe(pairs.length);
    expect(keys).toEqual(["x%3Ay:z", "x:y%3Az", "x%253Ay:z", "run-1:rec-2"]);
    lite.close();
  });
});
