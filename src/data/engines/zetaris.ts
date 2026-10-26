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
 * (Spark pushes no predicate with one into a scan) or names columns of two or more table aliases (no single scan holds
 * them); otherwise the OR may reach a scan, and the query is fenced. Literals are stripped first, so a quoted OR is data.
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
    let predicate: string;
    if (/^NOT/i.test(m[0])) {
      const [lo, hi] = enclosing(m.index + m[0].length);
      predicate = s.slice(lo, hi);
    } else {
      const [lo, hi] = enclosing(m.index);
      predicate = lo === 0 || /^\s*SELECT\b/i.test(s.slice(lo, hi)) ? clause(m.index, lo, hi) : s.slice(lo, hi);
    }
    if (/\bSELECT\b/i.test(predicate)) continue;
    const aliases = new Set([...predicate.matchAll(/\b([A-Za-z_]\w*)\s*\.\s*[A-Za-z_]/g)].map((a) => a[1].toLowerCase()));
    if (aliases.size <= 1) return true;
  }
  return false;
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
