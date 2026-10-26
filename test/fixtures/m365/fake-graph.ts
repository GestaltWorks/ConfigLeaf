// A fake of the two Microsoft endpoints the collector calls, over test/fixtures/m365/graph.json: the token endpoint
// (client credentials, the fixture's tenant, client and secret only) and Graph v1.0's domains and
// serviceConfigurationRecords, the domains in the fixture's pages joined by @odata.nextLink. Every GET must carry
// the token the endpoint issued. Credentials here are fixture strings, not real ones.
import type { FetchLike, GraphDnsRecord, GraphDomain } from "../../../src/collectors/m365.ts";
import graph from "./graph.json" with { type: "json" };

export const LOGIN_URL = "https://login.test";
export const GRAPH_URL = "https://graph.test/v1.0";
export const TENANT_ID = "00000000-0000-4000-8000-0000000000aa";
export const CLIENT_ID = "00000000-0000-4000-8000-0000000000bb";
export const CLIENT_SECRET = "fixture-client-secret-0123456789";
export const ACCESS_TOKEN = "fixture-access-token-abcdefghijklmnop";

export const DOMAINS = graph.domains as GraphDomain[][];
export const RECORDS = graph.records as Record<string, GraphDnsRecord[]>;

export interface FakeGraphOptions {
  domains?: GraphDomain[][];
  records?: Record<string, GraphDnsRecord[]>;
  /** The token endpoint's answer in place of a token. */
  tokenAnswer?: { status: number; body: unknown };
  /** Domains whose records answer this Graph error. */
  failing?: Record<string, { status: number; body: unknown }>;
  /** A nextLink in place of the fixture's on the first domains page. */
  nextLink?: string;
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function fakeGraph(opts: FakeGraphOptions = {}): { fetch: FetchLike; log: string[]; bodies: string[] } {
  const domains = opts.domains ?? DOMAINS;
  const records = opts.records ?? RECORDS;
  const log: string[] = [];
  const bodies: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    log.push(`${method} ${url}`);
    if (method === "POST" && url === `${LOGIN_URL}/${TENANT_ID}/oauth2/v2.0/token`) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      bodies.push(String(init?.body ?? ""));
      if (opts.tokenAnswer) return json(opts.tokenAnswer.status, opts.tokenAnswer.body);
      const ok = form.get("client_id") === CLIENT_ID && form.get("client_secret") === CLIENT_SECRET
        && form.get("grant_type") === "client_credentials" && form.get("scope") === "https://graph.microsoft.com/.default";
      return ok
        ? json(200, { token_type: "Bearer", expires_in: 3599, ext_expires_in: 3599, access_token: ACCESS_TOKEN })
        : json(401, { error: "invalid_client", error_description: `AADSTS7000215: Invalid client secret provided for app '${CLIENT_ID}'.`, error_codes: [7000215] });
    }
    if ((init?.headers as Record<string, string> | undefined)?.Authorization !== `Bearer ${ACCESS_TOKEN}`) {
      return json(401, { error: { code: "InvalidAuthenticationToken", message: "Access token is empty." } });
    }
    const u = new URL(url);
    const base = new URL(GRAPH_URL);
    if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname)) return json(404, { error: { code: "Request_ResourceNotFound", message: "not here" } });
    const path = u.pathname.slice(base.pathname.length);
    if (path === "/domains") {
      const page = Number(u.searchParams.get("$skiptoken") ?? "0");
      const next = page + 1 < domains.length ? (page === 0 && opts.nextLink !== undefined ? opts.nextLink : `${GRAPH_URL}/domains?$skiptoken=${page + 1}`) : undefined;
      return json(200, { "@odata.context": `${GRAPH_URL}/$metadata#domains`, value: domains[page] ?? [], ...(next ? { "@odata.nextLink": next } : {}) });
    }
    const m = /^\/domains\/([^/]+)\/serviceConfigurationRecords$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (opts.failing?.[id]) return json(opts.failing[id].status, opts.failing[id].body);
      if (!records[id]) return json(404, { error: { code: "Request_ResourceNotFound", message: `Resource '${id}' does not exist.` } });
      return json(200, { "@odata.context": `${GRAPH_URL}/$metadata#domains('${id}')/serviceConfigurationRecords`, value: records[id] });
    }
    return json(404, { error: { code: "Request_ResourceNotFound", message: "unknown path" } });
  };
  return { fetch, log, bodies };
}
