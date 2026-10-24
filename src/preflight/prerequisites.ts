// The prerequisite catalogue: for a finding class the simulation can clear, the one overlay that
// negates the detector's condition. A pre-flight that adds a finding of a class listed here tries the
// entry, simulates again and records whether the finding cleared; a class with no entry is a NO-GO,
// because the agent has no step it can simulate (adding a server block or a DNS record would mean
// inventing a row, and an overlay never adds rows). Each step is a work item a technician can read.
//
//   add_real_ip_block   proxied_without_real_ip: the object whose block (or http level) trusts no
//                       range gets set_real_ip_from for Cloudflare's published ranges; every real_ip
//                       row of that object in the run reads trusted:<n> header:CF-Connecting-IP
//   proxy_record        proxy_split: the direct address record the proxied CNAME aliases is proxied
//                       too, so the origin is hidden on both names
//
// The catalogue order picks the next step in both modes (the first entry that binds from the first added
// finding); a model-chosen prerequisite is not built. The simulation grades the step either way. The
// catalogue is typed; nothing a model says becomes SQL.

import type { FindingSummary } from "../catalogue/select.ts";
import type { FindingClass } from "../catalogue/templates.ts";
import type { DataLayer, Overlays, Params, RunOptions } from "../data/layer.ts";
import { objects } from "../data/queries.ts";
import { CLOUDFLARE_IPV4_RANGES, dnsRecordOverlay, realIpOverlay, realIpRows, realIpValue } from "./overlay.ts";

export interface PrerequisiteStep {
  id: string;
  params: Params;
  /** One sentence for the technician: the work item. */
  description: string;
  /** Dedupe key: the same step is never applied twice. */
  key: string;
  /** The overlays with this step applied on top. */
  apply(current: Overlays): Overlays;
}

export interface Prerequisite {
  id: string;
  clears: FindingClass;
  purpose: string;
  /** Bind from a finding of the simulated world; null when the finding cannot supply what the overlay needs. Reads through the simulated layer. */
  bind(finding: FindingSummary, layer: DataLayer, opts?: RunOptions): Promise<PrerequisiteStep | null>;
}

const DIRECT_TARGETS_SQL = `SELECT record_id, name, type, content, proxied
FROM {{t:dns_record}}
WHERE run_id = {{p:run_id}} AND name = {{p:name}} AND type IN ('A', 'AAAA') AND proxied = 0
ORDER BY record_id`;

export const addRealIpBlock: Prerequisite = {
  id: "add_real_ip_block",
  clears: "proxied_without_real_ip",
  purpose: "The vhost (or the http level of nginx.conf) trusts Cloudflare's published ranges and reads the visitor's address from CF-Connecting-IP.",
  async bind(f, layer, opts) {
    if (!f.host) return null;
    const rows = await realIpRows(layer, { run_id: f.run_id, host: f.host, object_id: f.object_id }, opts);
    const absent = rows.filter((r) => r.value_redacted === "absent" || r.value_redacted === "");
    if (!absent.length) return null;
    const scope: "server" | "http" = absent.every((r) => r.setting_path === "http.real_ip") ? "http" : "server";
    const to = realIpValue(CLOUDFLARE_IPV4_RANGES, scope);
    const setting_paths = absent.map((r) => r.setting_path);
    const params: Params = { host: f.host, object_id: f.object_id, run_id: f.run_id, scope, setting_paths: setting_paths.join(" ") };
    return {
      id: "add_real_ip_block", params,
      description: `add set_real_ip_from for Cloudflare's ${CLOUDFLARE_IPV4_RANGES} ranges and real_ip_header ${"CF-Connecting-IP"} to ${f.object_id} on ${f.host} (${scope} scope: ${setting_paths.join(", ")})`,
      key: `add_real_ip_block|${f.run_id}|${f.object_id}`,
      apply: (current) => realIpOverlay({ run_id: f.run_id, object_id: f.object_id, setting_paths, to }, current),
    };
  },
};

export const proxyRecord: Prerequisite = {
  id: "proxy_record",
  clears: "proxy_split",
  purpose: "The direct address record the proxied CNAME aliases is proxied as well, so the origin the proxy hides is not published next door.",
  async bind(f, layer, opts) {
    const name = f.refers_to_id;
    if (!name || !f.dns_run_id) return null;
    const targets = objects(await layer.run(DIRECT_TARGETS_SQL, { run_id: f.dns_run_id, name }, opts));
    if (!targets.length) return null;
    const record_ids = targets.map((t) => t.record_id);
    return {
      id: "proxy_record", params: { tenant_id: f.tenant_id, dns_run_id: f.dns_run_id, name, record_ids: record_ids.join(" ") },
      description: `proxy the ${targets.map((t) => t.type).join(" and ")} record${targets.length === 1 ? "" : "s"} of ${name} (${record_ids.join(", ")}) through Cloudflare as well`,
      key: `proxy_record|${f.dns_run_id}|${record_ids.join(",")}`,
      apply: (current) => dnsRecordOverlay({ run_id: f.dns_run_id!, record_ids, field: "proxied", to: 1 }, current),
    };
  },
};

export const PREREQUISITES: readonly Prerequisite[] = [addRealIpBlock, proxyRecord];

export function prerequisitesFor(cls: FindingClass, catalogue: readonly Prerequisite[] = PREREQUISITES): Prerequisite[] {
  return catalogue.filter((p) => p.clears === cls);
}
