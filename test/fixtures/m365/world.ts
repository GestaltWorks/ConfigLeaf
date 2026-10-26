// The Microsoft 365 fixture world: the fake tenant collected through the fake Graph (test/fixtures/m365) and the
// Cloudflare records of its two zones under the same salt, as one bundle a pass reads. What Cloudflare serves: contoso's
// MX and an SPF carrying the include among others; fabrikam's MX stale, its SPF without the include, its autodiscover
// proxied. So the pass finds contoso's autodiscover missing and fabrikam's three records different.
import { dnsRecordRow, type CfRecord } from "../../../src/collectors/cloudflare.ts";
import { Graph, collectM365, type M365Collection } from "../../../src/collectors/m365.ts";
import type { CollectionRun, DnsRecord } from "../../../src/data/rows.ts";
import { loadPolicyFile } from "../../../src/policy/load.ts";
import { Redactor } from "../../../src/redactor.ts";
import { CLIENT_ID, CLIENT_SECRET, GRAPH_URL, LOGIN_URL, TENANT_ID, fakeGraph } from "./fake-graph.ts";

export const MAIL_SALT = "m365-test-salt";
export const MAIL_TENANT = "client-a";
export const MAIL_NOW = new Date("2026-10-26T06:00:00.000Z");
export const MAIL_DNS_RUN = "run-dns-m365-test";
export const MAIL_AUDIT_RUN = "run-audit-m365-test";

export const SERVED: Record<string, CfRecord[]> = {
  "contoso.com": [
    { id: "c1", name: "contoso.com", type: "A", content: "203.0.113.10", proxied: false },
    { id: "c2", name: "contoso.com", type: "MX", content: "contoso-com.mail.protection.outlook.com", proxied: false },
    { id: "c3", name: "contoso.com", type: "TXT", content: '"v=spf1 include:spf.protection.outlook.com include:_spf.mailer.example ~all"' },
    { id: "c4", name: "contoso.com", type: "TXT", content: '"MS=ms12345678"' },
  ],
  "fabrikam.com": [
    { id: "f1", name: "fabrikam.com", type: "MX", content: "fabrikam-com.mail.eo.outlook.com", proxied: false },
    { id: "f2", name: "fabrikam.com", type: "TXT", content: '"v=spf1 include:_spf.mailer.example ~all"' },
    { id: "f3", name: "autodiscover.fabrikam.com", type: "CNAME", content: "autodiscover.outlook.com", proxied: true },
  ],
};

const at = MAIL_NOW.toISOString();
export const mailRun = (run_id: string, surface: string, n: number): CollectionRun => ({
  run_id, tenant_id: MAIL_TENANT, surface, host: null, started_at: at, finished_at: at, expected_count: n, observed_count: n, status: "complete",
});

export interface MailWorld { bundle: Record<string, unknown[]>; c: M365Collection; dns: DnsRecord[]; redactor: Redactor }

/** The bundle: the Microsoft 365 run and its rows, a DNS run of the given zones (both by default), a complete audit run, and with `policy` the committed rules. */
export async function mailWorld(opts: { zones?: string[]; policy?: boolean } = {}): Promise<MailWorld> {
  const redactor = new Redactor(MAIL_SALT);
  const g = new Graph({ tenantId: TENANT_ID, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: fakeGraph().fetch, loginUrl: LOGIN_URL, graphUrl: GRAPH_URL });
  const c = await collectM365(g, redactor, { tenantId: MAIL_TENANT, now: () => MAIL_NOW, graphTenant: TENANT_ID, graphClient: CLIENT_ID });
  const ctx = { tenantId: MAIL_TENANT, runId: MAIL_DNS_RUN, observedAt: at };
  const dns = (opts.zones ?? Object.keys(SERVED)).flatMap((z) => SERVED[z].map((rec) => dnsRecordRow(redactor, rec, z, ctx)!));
  const bundle: Record<string, unknown[]> = {
    collection_run: [c.run, mailRun(MAIL_DNS_RUN, "cloudflare.dns", dns.length), mailRun(MAIL_AUDIT_RUN, "cloudflare.audit", 0)],
    observation: c.observations, dns_record: dns,
    ...(opts.policy ? { policy_rule: loadPolicyFile("policy/hackathon.json", { tenant: MAIL_TENANT, redactor }).rows } : {}),
  };
  return { bundle, c, dns, redactor };
}
