// A fake Cloudflare v4 API that holds records and takes writes: GET /zones and GET /zones/{id}/dns_records in the
// paged envelope the client walks (src/collectors/cloudflare.ts), PATCH /zones/{id}/dns_records/{record} and POST
// /zones/{id}/dns_records answering the record as stored. Every request is logged as "<METHOD> <path>" with the JSON
// body, so a test asserts on exactly what a write would have sent. `failWrites` answers every write with a 403.
import type { CfRecord, CfZone, FetchLike } from "../../../src/collectors/cloudflare.ts";

export const CF_TOKEN = "fixture-token-not-a-secret";

const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status: number, code: number, message: string): Response => reply(status, { success: false, errors: [{ code, message }], messages: [], result: null });

export interface FakeCloudflare {
  fetch: FetchLike;
  log: { method: string; path: string; body: unknown }[];
  records: Map<string, CfRecord[]>;
}

export function fakeCloudflare(zones: CfZone[], records: Record<string, CfRecord[]>, opts: { failWrites?: boolean; nextId?: string } = {}): FakeCloudflare {
  const state = new Map(Object.entries(structuredClone(records)));
  const log: FakeCloudflare["log"] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/client\/v4/, "");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    log.push({ method, path: path + u.search, body });
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${CF_TOKEN}`) return refuse(401, 10000, "Authentication error");
    if (path === "/zones" && method === "GET") {
      return reply(200, { success: true, errors: [], messages: [], result: zones, result_info: { page: 1, per_page: 50, count: zones.length, total_count: zones.length, total_pages: 1 } });
    }
    const list = path.match(/^\/zones\/([^/]+)\/dns_records$/);
    const one = path.match(/^\/zones\/([^/]+)\/dns_records\/([^/]+)$/);
    const zoneId = list?.[1] ?? one?.[1];
    if (!zoneId || !state.has(zoneId)) return refuse(404, 7003, "Could not route to the zone");
    const rows = state.get(zoneId)!;
    if (list && method === "GET") return reply(200, { success: true, errors: [], messages: [], result: rows, result_info: { page: 1, per_page: 500, count: rows.length, total_count: rows.length, total_pages: 1 } });
    if (opts.failWrites) return refuse(403, 10000, "Authentication error");
    if (list && method === "POST") {
      const rec: CfRecord = { id: opts.nextId ?? "rec-new-0001", ...body };
      rows.push(rec);
      return reply(200, { success: true, errors: [], messages: [], result: rec });
    }
    if (one && method === "PATCH") {
      const i = rows.findIndex((r) => r.id === one[2]);
      if (i < 0) return refuse(404, 81044, "Record does not exist.");
      rows[i] = { ...rows[i], ...body };
      return reply(200, { success: true, errors: [], messages: [], result: rows[i] });
    }
    return refuse(405, 10000, "Method not allowed");
  };
  return { fetch, log, records: state };
}
