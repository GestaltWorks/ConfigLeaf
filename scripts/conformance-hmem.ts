// Run the official Meterless H-MEM conformance suite through src/engine/memory.ts (HMEM_IMPL).
//
// What it exercises: the vendored reference class, which src/engine/memory.ts re-exports unchanged as
// HMEM. It does not exercise TechnicianMemory, the wrapper the agent uses; that module's own coverage is
// test/memory.test.ts (record, recall by exact scope key, expiry flagging, redaction, persistence). One
// check below goes through TechnicianMemory.recordException and recall, so this command touches the
// wrapper as well and fails if the wrapper no longer round-trips a lesson over the reference store.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TechnicianMemory, type FindingScope } from "../src/engine/memory.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const impl = path.resolve(root, "src", "engine", "memory.ts");
const runner = path.resolve(root, "vendor", "hmem", "conformance", "runner.ts");

console.log("H-MEM conformance: the vendored suite runs against the vendored reference, re-exported by src/engine/memory.ts");
const r = spawnSync(process.execPath, ["--import", "tsx", runner], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, HMEM_IMPL: impl.replace(/\\/g, "/") },
});
if (r.status !== 0) process.exit(r.status ?? 1);

// The wrapper: one lesson recorded through TechnicianMemory, recalled by exact scope key, flagged once lapsed.
const T0 = "2026-10-24T12:00:00.000Z";
const m = new TechnicianMemory({ clock: () => Date.parse(T0) });
const finding: FindingScope = { tenant_id: "client-a", class: "proxied_without_real_ip", host: "host-000000", dns_name: null, refers_to_type: null, refers_to_id: null, resolves_to: null };
const lesson = m.recordException({
  tenantId: "client-a", findingClass: "proxied_without_real_ip", scopeKey: "host-000000", reason: "conformance wrapper check",
  expiresAt: "2026-12-01T00:00:00.000Z", provenance: { kind: "conformance", at: "2026-10-24T11:59:00.000Z", by: "runner" },
});
const inForce = m.recall(finding);
const lapsed = m.recall(finding, "2027-01-01T00:00:00.000Z");
const otherHost = m.recall({ ...finding, host: "host-000001" });
const ok = inForce.applicable.length === 1 && inForce.applicable[0].id === lesson.id && inForce.expired.length === 0
  && lapsed.applicable.length === 0 && lapsed.expired.length === 1
  && otherHost.applicable.length === 0 && otherHost.expired.length === 0
  && m.hmem.ledger.history(lesson.id).map((h) => h.action).join(",") === "create,read,read";
console.log(`TechnicianMemory wrapper check (recordException, recall by exact scope key, lapsed flagged, ledger create+2 reads): ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
