// A fake Cloudflare v4 API over the hand-written fixtures, with the paging behaviour measured on 24 Oct
// 2026: zones and dns_records page by page/per_page with result_info.total_count and total_pages (a page
// past the last answers total_count 0); the audit log pages by an opaque cursor that is absent on the
// last page, requires since and before, and refuses a since outside 18 months (stricter than measured:
// the day exactly 18 months back is refused too). The server caps page sizes (recordsCap, auditCap) so a
// small fixture still takes several pages. Every request is logged, path and query only.

import type { CfAuditRow, CfRecord, CfZone, FetchLike } from "../../../src/collectors/cloudflare.ts";

export const TOKEN = "fixture-token-not-a-secret";

export interface FakeOptions {
  zones: CfZone[];
  records: Record<string, CfRecord[]>;
  audit: CfAuditRow[];
  now?: Date;
  recordsCap?: number;
  auditCap?: number;
  /** Called before a record-row page (per_page > 1) is served: lets a test move the population after it was counted. */
  onRecordsPage?: (zoneId: string, page: number, records: CfRecord[]) => void;
  /** Path prefix -> HTTP status every matching request fails with. */
  fail?: Record<string, number>;
  /** Hand back the same cursor forever. */
  repeatCursor?: boolean;
}

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const refuse = (status: number, code: number, message: string): Response =>
  reply(status, { success: false, errors: [{ code, message }], messages: [], result: null });

function paged<T>(all: readonly T[], q: URLSearchParams, cap: number): Response {
  const per = Math.max(1, Math.min(Number(q.get("per_page") ?? 20), cap));
  const page = Math.max(1, Number(q.get("page") ?? 1));
  const pages = Math.max(1, Math.ceil(all.length / per));
  const result = all.slice((page - 1) * per, page * per);
  return reply(200, {
    success: true, errors: [], messages: [], result,
    result_info: { page, per_page: per, count: result.length, total_count: page > pages ? 0 : all.length, total_pages: pages },
  });
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

export function fakeApi(o: FakeOptions): { fetch: FetchLike; log: string[] } {
  const log: string[] = [];
  const now = o.now ?? new Date("2026-10-24T05:00:00.000Z");
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/client\/v4/, "");
    log.push(path + u.search);
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${TOKEN}`) return refuse(401, 10000, "Authentication error");
    for (const [prefix, status] of Object.entries(o.fail ?? {})) if (path.startsWith(prefix)) return refuse(status, 10000, "Authentication error");
    const q = u.searchParams;

    if (path === "/zones") return paged(o.zones, q, 50);

    const rec = path.match(/^\/zones\/([^/]+)\/dns_records$/);
    if (rec) {
      const rows = o.records[rec[1]];
      if (!rows) return refuse(404, 7003, "Could not route to the zone");
      if (Number(q.get("per_page") ?? 20) > 1) o.onRecordsPage?.(rec[1], Number(q.get("page") ?? 1), rows);
      return paged(rows, q, o.recordsCap ?? 5_000);
    }

    const aud = path.match(/^\/accounts\/([^/]+)\/logs\/audit$/);
    if (aud) {
      const since = q.get("since");
      const before = q.get("before");
      if (!since || !before) return refuse(400, 0, "Bad request. Missing required field: since, before");
      const edge = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 18, now.getUTCDate())));
      if (since <= edge) return refuse(400, 0, `Bad request. Invalid format for field: before. Metadata: [Audit Logs expire after 18 months. Given: ${since}]`);
      const limit = Math.min(Number(q.get("limit") ?? 100), o.auditCap ?? 1000);
      const cursor = q.get("cursor");
      const offset = cursor ? Number(Buffer.from(cursor, "base64url").toString("utf8").replace(/^off:/, "")) : 0;
      // before is not a strict midnight bound (measured): a row on the before day is still served.
      const rows = o.audit
        .filter((r) => { const d = (r.action?.time ?? "").slice(0, 10); return d >= since && d <= before; })
        .sort((a, b) => (q.get("direction") === "desc" ? -1 : 1) * ((a.action?.time ?? "") < (b.action?.time ?? "") ? -1 : (a.action?.time ?? "") > (b.action?.time ?? "") ? 1 : 0));
      const result = rows.slice(offset, offset + limit);
      const more = offset + limit < rows.length;
      const next = o.repeatCursor ? Buffer.from("off:0").toString("base64url") : more ? Buffer.from(`off:${offset + limit}`).toString("base64url") : undefined;
      return reply(200, { success: true, errors: [], messages: [], result, result_info: next ? { count: result.length, cursor: next } : { count: result.length } });
    }

    return refuse(404, 7003, "Could not route");
  };
  return { fetch, log };
}
