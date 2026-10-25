// Zetaris Lightning SQL over the REST API of the local bundle.
//
// Contract (setup guide p.11, p.24, and the hackathon channels):
//   POST {REST_URL}/sql-editor/sqls/run
//   headers: Authorization: Bearer <API key>, X-Org-ID, X-Request-ID (fresh UUID per request)
//   body: { queryId, sql, source: "SqlEditor", limit }
//   ONE statement per call, no trailing semicolon. Values come back as strings.
//   REST tables re-fetch on every query; CACHE TABLE after creating them.
//   The one exception (measured 24 Oct on 2.4.3.1): COMPILE USL ... DDL carries every CREATE TABLE
//   block, separated by ';', in a single request. opts.allowMultiStatement lets that through and is
//   refused for any statement that does not start with COMPILE USL.
//   Error messages and trace lines go through redact(): a CREATE DATASOURCE carries password "...".

import { randomUUID } from "node:crypto";
import { config, redact } from "../config.ts";
import { stripLiterals } from "../data/layer.ts";
import type { Tracer } from "../trace.ts";

export interface QueryResult {
  queryId: string;
  columns: string[];
  rows: string[][];
  rowCount: number;
  /** Rows the server counted; larger than rowCount when the request limit bound. */
  total: number;
  /** Server-side execution time, when reported. */
  serverMs?: number;
  latencyMs: number;
  raw: unknown;
}

export class ZetarisError extends Error {
  constructor(message: string, readonly status: number) { super(redact(message)); }
}

export class Zetaris {
  private readonly url = `${config.zetaris.restUrl}/sql-editor/sqls/run`;

  private headers(): Record<string, string> {
    if (!config.zetaris.apiKey) throw new ZetarisError("ZETARIS_API_KEY is not set", 0);
    return {
      Authorization: `Bearer ${config.zetaris.apiKey}`,
      "X-Org-ID": config.zetaris.orgId,
      "X-Request-ID": randomUUID(),
      "Content-Type": "application/json",
    };
  }

  /**
   * Run exactly one Lightning SQL statement. A trailing semicolon is stripped; a second statement is refused; a ';' inside a literal is data.
   * allowMultiStatement: the COMPILE USL ... DDL request only; set on anything else, the call is refused before it is sent.
   */
  async query(sql: string, opts: { limit?: number; agent?: string; tracer?: Tracer; timeoutMs?: number; allowMultiStatement?: boolean } = {}): Promise<QueryResult> {
    const clean = sql.trim().replace(/;+\s*$/, "");
    if (opts.allowMultiStatement && !/^compile\s+usl\b/i.test(clean)) throw new ZetarisError("allowMultiStatement is honoured only for COMPILE USL ... DDL", 0);
    if (!opts.allowMultiStatement && /;\s*\S/.test(stripLiterals(clean))) throw new ZetarisError("one statement per call", 0);
    const queryId = randomUUID();
    const t0 = Date.now();
    const r = await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ queryId, sql: clean, source: "SqlEditor", limit: opts.limit ?? 1000 }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    const text = await r.text();
    let j: any = {};
    try { j = JSON.parse(text); } catch { /* fall through */ }
    const latencyMs = Date.now() - t0;
    if (!r.ok) {
      const msg = j?.message ?? j?.error ?? text.slice(0, 300);
      opts.tracer?.emit({ agent: opts.agent ?? "zetaris", action: "query", engine: "zetaris", query_id: queryId, status: "failed", latency_ms: latencyMs, detail: redact(`${r.status}: ${msg}`) });
      throw new ZetarisError(`Zetaris ${r.status}: ${msg}`, r.status);
    }
    const result = Zetaris.normalise(j, queryId, latencyMs);
    opts.tracer?.emit({ agent: opts.agent ?? "zetaris", action: "query", engine: "zetaris", query_id: queryId, status: "ok", latency_ms: latencyMs, output_summary: `${result.rowCount} rows`, input_summary: redact(clean).slice(0, 160) });
    return result;
  }

  /**
   * Response shape of the 2.4.3.1 bundle, measured 23 Oct:
   *   { headers: string[], data: string[][], total: number, timeUsed: number }
   * Every value is a string. `total` is the row count the server saw (may exceed `data` when limit binds).
   */
  static normalise(j: any, queryId: string, latencyMs: number): QueryResult {
    const columns: string[] = Array.isArray(j?.headers) ? j.headers.map(String) : [];
    const rows: string[][] = Array.isArray(j?.data) ? j.data.map((r: unknown[]) => (Array.isArray(r) ? r.map((v) => (v === null ? "" : String(v))) : [String(r)])) : [];
    return { queryId, columns, rows, rowCount: rows.length, total: typeof j?.total === "number" ? j.total : rows.length, serverMs: typeof j?.timeUsed === "number" ? j.timeUsed : undefined, latencyMs, raw: j };
  }
}
