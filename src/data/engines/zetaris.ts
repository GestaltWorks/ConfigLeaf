// Zetaris engine: the live path. Wraps the measured REST adapter; the only engine-specific part is naming: every
// catalogue table is read through the drift_usl entity built from it alone (src/zetaris/setup.ts READ_AS), so
// {{t:collection_run}} renders as lightning.metastore.drift.drift_usl.collection and {{t:observation}} as a SELECT of
// observation's columns from drift_usl.setting under observation's own names (setting names obs_id setting_id, and the
// USL DDL refuses a column named source). The entities are activated over the datasource, the file tables and the REST
// source (npm run zetaris:setup), so the semantic layer is the one model every query of the agent reads. A table READ_AS
// lacks would render as <ZETARIS_DATASOURCE>.<table>; every table the catalogue names has an entity.
// One SELECT per call, no bound parameters (layer.ts renders them).
//
// Measured live 26 Oct 2026 on 2.4.3.1 (EXPLAIN QUERY AS): a drift_usl table is a DataSource V2 scan, USLTableScan, that
// takes every filter Spark pushes into it (the optimized plan keeps no Filter above the scan) and compiles an Or without
// its parentheses, so `run_id = 'r' AND (host = 'h' OR host IS NULL)` comes back as `(run_id = 'r' AND host = 'h') OR
// host IS NULL`: 6,090 rows where DRIFT.observation gives 0, and NOT (a AND b), which Spark turns into an Or, the same.
// An IN list, a lone NOT, LIKE and every AND compile as written. So when a query holds an OR that Spark could push whole
// into one scan (fencedOr, below), every entity it reads is fenced: a SELECT of its columns with LIMIT FENCE_LIMIT, below
// which Spark pushes no filter, so Spark itself applies each predicate above the scan. A fenced read costs the scan's
// filter pushdown, not its column pruning: 0.55 s for observation's 32,786 rows against 0.31 s pushed.

import { Zetaris, type QueryResult } from "../../adapters/zetaris.ts";
import { config } from "../../config.ts";
import { uslRelation } from "../../zetaris/setup.ts";
import { stripLiterals, type Engine, type RunOptions } from "../layer.ts";

/** An OR, or a NOT over a parenthesised group (Spark turns NOT (a AND b) into an Or). */
const OR_TOKEN = /\bOR\b|\bNOT\s*\(/gi;
/** A word that ends a WHERE, ON or HAVING clause at its own depth. */
const CLAUSE_END = /\b(?:WHERE|ON|HAVING|GROUP|ORDER|UNION|LIMIT|JOIN|LEFT|RIGHT|INNER|FULL|CROSS)\b/gi;
const CLAUSE_START = /\b(?:WHERE|ON|HAVING)\b/gi;

/**
 * Does the SQL hold an OR that Spark could push whole into one USL scan? For each OR (or NOT over a group), the predicate
 * it belongs to: the parenthesised group around it, or, when that group is a subquery or there is none, the WHERE, ON or
 * HAVING clause around it at its own depth; for a NOT, the group after it. The predicate is safe when it holds a subquery
 * (Spark pushes no predicate with one into a scan), or when it is an OR that names columns of two or more table aliases
 * and no alias has a conjunct of its own in every disjunct (no single scan holds it, and Spark extracts no part of it for
 * one); otherwise the OR may reach a scan, and the query is fenced. A NOT over a group is fenced whatever it names.
 * Literals are stripped first, so a quoted OR is data; a comment or a backquoted name only makes it fence more, and the
 * guard refuses a comment before any SQL is sent (layer.ts assertSelectOnly).
 */
export function fencedOr(sql: string): boolean {
  const s = stripLiterals(sql);
  const depth: number[] = [];
  for (let i = 0, d = 0; i < s.length; i++) {
    if (s[i] === ")") d--;
    depth.push(d);
    if (s[i] === "(") d++;
  }
  /** The span inside the paren group that encloses index i, or the whole text. */
  const enclosing = (i: number): [number, number] => {
    let open = -1;
    for (let k = i - 1, d = 0; k >= 0; k--) {
      if (s[k] === ")") d++;
      else if (s[k] === "(") { if (d === 0) { open = k; break; } d--; }
    }
    if (open < 0) return [0, s.length];
    for (let k = open + 1, d = 0; k < s.length; k++) {
      if (s[k] === "(") d++;
      else if (s[k] === ")") { if (d === 0) return [open + 1, k]; d--; }
    }
    return [open + 1, s.length];
  };
  /** The clause around index i at its depth, inside [lo, hi). */
  const clause = (i: number, lo: number, hi: number): string => {
    let start = lo;
    for (const m of s.slice(lo, i).matchAll(CLAUSE_START)) if (depth[lo + m.index] === depth[i]) start = lo + m.index;
    let end = hi;
    for (const m of s.slice(i, hi).matchAll(CLAUSE_END)) if (depth[i + m.index] === depth[i]) { end = i + m.index; break; }
    return s.slice(start, end);
  };
  for (const m of s.matchAll(OR_TOKEN)) {
    const not = /^NOT/i.test(m[0]);
    let predicate: string;
    if (not) {
      const [lo, hi] = enclosing(m.index + m[0].length);
      predicate = s.slice(lo, hi);
    } else {
      const [lo, hi] = enclosing(m.index);
      predicate = lo === 0 || /^\s*SELECT\b/i.test(s.slice(lo, hi)) ? clause(m.index, lo, hi) : s.slice(lo, hi);
    }
    if (/\bSELECT\b/i.test(predicate)) continue;
    // A NOT over a group is fenced whatever it names; an OR when it names one alias or none, or when Spark could
    // still push part of it into one side of a join (extractable).
    if (not || aliasesOf(predicate).size <= 1 || extractable(predicate)) return true;
  }
  return false;
}

/** The table aliases a predicate names columns of (`o.host` names o), lower-cased. A backquoted or bare column names none. */
function aliasesOf(predicate: string): Set<string> {
  return new Set([...predicate.matchAll(/\b([A-Za-z_]\w*)\s*\.\s*[A-Za-z_]/g)].map((a) => a[1].toLowerCase()));
}

/** `text` cut at each match of `sep` outside parentheses. */
function splitTop(text: string, sep: RegExp): string[] {
  const out: string[] = [];
  let [d, from] = [0, 0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") d++;
    else if (text[i] === ")") d--;
    else if (d === 0) {
      sep.lastIndex = i;
      const m = sep.exec(text);
      if (m && m.index === i) { out.push(text.slice(from, i)); from = i + m[0].length; i = from - 1; }
    }
  }
  return [...out, text.slice(from)];
}

/**
 * An OR over two or more aliases that Spark (3.1 and later, PushExtraPredicateThroughJoin) can still push in part: when
 * every disjunct holds a conjunct on one alias alone, the OR of those conjuncts is pushed into that alias's scan.
 */
function extractable(predicate: string): boolean {
  const disjuncts = splitTop(predicate.replace(/^\s*(?:WHERE|ON|HAVING)\b/i, ""), /\bOR\b/iy);
  if (disjuncts.length < 2) return false;
  const single = disjuncts.map((d) => new Set(splitTop(unwrap(d.trim()), /\bAND\b/iy).map(aliasesOf).filter((a) => a.size === 1).map((a) => [...a][0])));
  return [...single[0]].some((a) => single.every((s) => s.has(a)));
}

/** `(x)` as x when its first parenthesis closes at its end, repeatedly; any other text as it is. */
function unwrap(text: string): string {
  let t = text;
  while (t.startsWith("(") && t.endsWith(")")) {
    let d = 0;
    let closes = -1;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "(") d++;
      else if (t[i] === ")" && --d === 0) { closes = i; break; }
    }
    if (closes !== t.length - 1) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

export class ZetarisEngine implements Engine {
  readonly name = "zetaris" as const;

  constructor(private readonly client: Zetaris = new Zetaris()) {}

  /** `sql`: the query the reference is rendered into (DataLayer.render passes it); one that holds a pushable OR fences the read. */
  qualify(table: string, sql = ""): string {
    return uslRelation(table, { fence: fencedOr(sql) }) ?? `${config.zetaris.datasource}.${table}`;
  }

  run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    return this.client.query(sql, opts);
  }
}
