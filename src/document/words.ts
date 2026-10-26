// The words the owner's report (src/document/report.ts) and the executive report (src/document/executive.ts) both
// use for the same rows: an action's kind and status, each collection surface's name and what it holds, why a run
// fails the DQ gate, and the policy version in force. One module, so the two reports name a thing the same way and
// neither reaches into the other's internals.

import type { PolicyRule } from "../data/rows.ts";
import type { DocumentData } from "./render.ts";

/** An action's kind in plain words. */
export const KIND_WORD: Readonly<Record<string, string>> = { rollback_file: "rollback of a file", revert_record: "revert of a DNS record", investigate: "investigation", fix: "fix" };
/** An action's status in plain words. */
export const STATUS_WORD: Readonly<Record<string, string>> = { done: "done", unverified: "written, not verified", failed: "failed", refused: "refused, nothing written", not_judged: "not judged" };

/** Each collection surface in plain words: its name (with the host for a host surface), what it holds, and its place in a list. */
export const SURFACES: Readonly<Record<string, { name: (host: string) => string; holds: string; rank: number }>> = {
  "cloudflare.dns": { name: () => "DNS records", holds: "every zone's records, each field as the provider returns it", rank: 0 },
  "cloudflare.audit": { name: () => "Provider audit log", holds: "who changed which record and when", rank: 1 },
  "linux.nginx": { name: (h) => `nginx on ${h}`, holds: "each vhost file and setting, read over SSH", rank: 2 },
  "linux.etc": { name: (h) => `/etc on ${h}`, holds: "the host's other configuration files, read over SSH", rank: 3 },
  inventory: { name: () => "Asset inventory", holds: "the hosts' addresses", rank: 4 },
  probe: { name: () => "Probes from outside", holds: "the http, dns and tls answers of every served name", rank: 5 },
  "probe.verify": { name: () => "Verification probes", holds: "the agent's probes after each write", rank: 6 },
  "zetaris.control": { name: () => "Zetaris control plane", holds: "the data layer's DQ rules, entities, grants, datasources and server version", rank: 7 },
};

/** A surface and host as a reader names it: "nginx on host-4b4dc1", "DNS records"; an unknown surface by its id. */
export const surfaceName = (r: { surface: string; host: string }): string => SURFACES[r.surface]?.name(r.host) ?? `${r.surface}${r.host ? ` on ${r.host}` : ""}`;

/** Why a run fails the gate, in a few words. */
export function gateWhy(r: DocumentData["runs"][number]): string {
  if (r.status !== "complete") return `the run is ${r.status}, ${r.observed_count || "0"} of ${r.expected_count || "?"} read`;
  if (!r.expected_count || !r.observed_count) return "the run asserted no population";
  return `${r.observed_count} of ${r.expected_count} read`;
}

/** The policy version in force (the greatest) and its rules. */
export function policyOf(rules: readonly PolicyRule[]): { version: number; rules: number } | null {
  if (!rules.length) return null;
  const version = Math.max(...rules.map((r) => Number(r.version) || 0));
  return { version, rules: rules.filter((r) => Number(r.version) === version).length };
}
