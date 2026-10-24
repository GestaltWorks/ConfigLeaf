// Zetaris Lightning SQL over the REST API of the local bundle.
//
// Contract (setup guide p.11, p.24, and the hackathon channels):
//   POST {REST_URL}/sql-editor/sqls/run
//   headers: Authorization: Bearer <API key>, X-Org-ID, X-Request-ID (fresh UUID per request)
//   body: { queryId, sql, source: "SqlEditor", limit }
//   ONE statement per call, no trailing semicolon. Values come back as strings.
//   REST tables re-fetch on every query; CACHE TABLE after creating them.

import { randomUUID } from "node:crypto";
import { config, redact } from "../config.ts";
import type { Tracer } from "../trace.ts";

export interface QueryResult {
  queryId: string;
  columns: string[];
  rows: string[][];
  rowCount: number;
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

  /** Run exactly one Lightning SQL statement. A trailing semicolon is stripped; a second statement is refused. */
  async query(sql: string, opts: { limit?: number; agent?: string; tracer?: Tracer; timeoutMs?: number } = {}): Promise<QueryResult> {
    const clean = sql.trim().replace(/;+\s*$/, "");
    if (/;\s*\S/.test(clean)) throw new ZetarisError("one statement per call", 0);
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
      opts.tracer?.emit({ agent: opts.agent ?? "zetaris", action: "query", query_id: queryId, status: "failed", latency_ms: latencyMs, detail: `${r.status}: ${msg}` });
      throw new ZetarisError(`Zetaris ${r.status}: ${msg}`, r.status);
    }
    const result = Zetaris.normalise(j, queryId, latencyMs);
    opts.tracer?.emit({ agent: opts.agent ?? "zetaris", action: "query", query_id: queryId, status: "ok", latency_ms: latencyMs, output_summary: `${result.rowCount} rows`, input_summary: clean.slice(0, 160) });
    return result;
  }

  /** The bundle's response shape is not fixed in the docs; accept the shapes seen in the wild. */
  static normalise(j: any, queryId: string, latencyMs: number): QueryResult {
    const data = j?.data ?? j?.result ?? j;
    let columns: string[] = [];
    let rows: string[][] = [];
    if (Array.isArray(data) && data.length && Array.isArray(data[0])) {
      rows = data.map((r: unknown[]) => r.map(String));
      columns = (j?.columns ?? j?.schema ?? []).map((c: any) => (typeof c === "string" ? c : c?.name ?? String(c)));
    } else if (Array.isArray(data) && data.length && typeof data[0] === "object") {
      columns = Object.keys(data[0]);
      rows = data.map((r: Record<string, unknown>) => columns.map((c) => String(r[c])));
    } else if (data && Array.isArray(data.rows)) {
      columns = (data.columns ?? data.schema ?? []).map((c: any) => (typeof c === "string" ? c : c?.name ?? String(c)));
      rows = data.rows.map((r: unknown[]) => r.map(String));
    }
    return { queryId, columns, rows, rowCount: rows.length, latencyMs, raw: j };
  }
}
