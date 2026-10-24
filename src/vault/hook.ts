// The collectors' vault hook: what scripts/collect-linux.ts and scripts/collect-cloudflare.ts run after a
// run's rows are stored. One trace line per hook call, agent "vault", redacted like every trace line:
// "vault off" when DRIFT_VAULT_DIR is blank, "nothing committed" with the reason for a run that did not
// finish complete, the commit (12 hex), file counts and the vault_copy rows written for a committed one,
// or the failure. The trace carries commit hashes, counts and redacted object ids; real paths and bytes
// stay in the vault.
//
// Contract:
//   linuxVaultFiles      the CollectResult's raw files, each matched to its `file` observation: the
//                        object id is the collector's own redaction of the real path (linux.ts
//                        redactText, the function toRows uses), and the observation's value_hash must be
//                        sha256 of the bytes. Any file without its observation, or any `file` observation
//                        without its file, throws VaultError: the copies and the rows describe one run.
//   cloudflareVaultFiles the raw records of a DNS run, each the JSON recordJson writes at
//                        <zone>/<record_id>.json; every raw record that dnsRecordRow keeps must give
//                        exactly the run's stored row for its id, and the counts must agree, or VaultError.
//   recordJson           one record as id, name, type, content, ttl, proxied, in that order, the values
//                        as the API sent them (ttl and proxied null when absent), two-space indent and a
//                        trailing newline: the same record gives the same bytes whatever key order it came in.
//   captureRecords       wraps listZones and listRecords on one Cloudflare client so the records the
//                        collector reads are kept raw, with their zone's real name, for the hook.
//   vaultLinuxRun /
//   vaultCloudflareRun   off -> {status: "off"}; a run other than complete -> {status: "skipped"};
//                        otherwise Vault.commitRun, then Store.insertVaultCopies with its rows ->
//                        {status: "committed"}; any error -> {status: "failed"} with the redacted message.

import { dnsRecordRow, type CfRecord, type Cloudflare, type CloudflareCollection } from "../collectors/cloudflare.ts";
import { redactText, sha256 as fileHash, type CollectResult } from "../collectors/linux.ts";
import { redact } from "../config.ts";
import type { CollectionRun, VaultCopy } from "../data/rows.ts";
import type { Redactor } from "../redactor.ts";
import type { TraceEvent } from "../trace.ts";
import { CLOUDFLARE_REPO, Vault, VaultError, type VaultCommit, type VaultFile } from "./vault.ts";

export interface CopyStore { insertVaultCopies(rows: readonly VaultCopy[]): Promise<number> }
export interface Emitter { emit(e: Omit<TraceEvent, "ts" | "trace_id">): unknown }

export type HookResult =
  | { status: "off" }
  | { status: "skipped"; reason: string }
  | { status: "committed"; commit: VaultCommit; written: number }
  | { status: "failed"; error: string };

export const VAULT_OFF = "vault off: DRIFT_VAULT_DIR is blank; nothing committed";

/** The raw half of a host collection as vault files, each checked against its `file` observation (see the header). */
export function linuxVaultFiles(res: Pick<CollectResult, "rows" | "files">, redactor: Redactor): VaultFile[] {
  const fileRows = new Map(res.rows.observation.filter((o) => o.setting_path === "file").map((o) => [o.object_id, o]));
  const out: VaultFile[] = [];
  for (const [real, bytes] of Object.entries(res.files)) {
    const objectId = redactText(redactor, real);
    const row = fileRows.get(objectId);
    if (!row) throw new VaultError(`no file observation for ${objectId}`);
    if (row.value_hash !== fileHash(bytes)) throw new VaultError(`the file observation of ${objectId} carries another hash than the fetched bytes`);
    fileRows.delete(objectId);
    out.push({ path: real, objectId, bytes });
  }
  if (fileRows.size) throw new VaultError(`${fileRows.size} file observation(s) without fetched bytes: ${[...fileRows.keys()].sort().slice(0, 3).join(", ")}`);
  return out;
}

/** One record as the vault stores it (see the header). */
export function recordJson(rec: CfRecord): string {
  const o = { id: rec.id, name: rec.name, type: rec.type, content: rec.content, ttl: rec.ttl ?? null, proxied: rec.proxied ?? null };
  return `${JSON.stringify(o, null, 2)}\n`;
}

/** The records of one zone as the API returned them, with the zone's real name. */
export interface RawZone { zoneId: string; zone: string; records: CfRecord[] }

/** Keep the raw records this client reads (listZones gives the zone names, listRecords the records); returns the list it fills. */
export function captureRecords(cf: Cloudflare): RawZone[] {
  const out: RawZone[] = [];
  const names = new Map<string, string>();
  const listZones = cf.listZones.bind(cf);
  const listRecords = cf.listRecords.bind(cf);
  cf.listZones = async () => {
    const zones = await listZones();
    for (const z of zones) names.set(z.id, z.name);
    return zones;
  };
  cf.listRecords = async (zoneId: string) => {
    const records = await listRecords(zoneId);
    out.push({ zoneId, zone: names.get(zoneId) ?? "", records });
    return records;
  };
  return out;
}

const ZONE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The raw records of a DNS run as vault files, each checked against the run's stored row (see the header). */
export function cloudflareVaultFiles(c: Pick<CloudflareCollection, "dnsRun" | "records">, raw: readonly RawZone[], redactor: Redactor): VaultFile[] {
  const ctx = { tenantId: c.dnsRun.tenant_id, runId: c.dnsRun.run_id, observedAt: c.dnsRun.started_at };
  const stored = new Map(c.records.map((d) => [d.record_id, JSON.stringify(d)]));
  const out: VaultFile[] = [];
  for (const z of raw) {
    for (const rec of z.records) {
      const row = dnsRecordRow(redactor, rec, z.zone, ctx);
      if (!row) continue;
      if (!ZONE.test(z.zone) || !RECORD_ID.test(rec.id)) throw new VaultError(`record ${RECORD_ID.test(rec.id) ? rec.id : "(id of another shape)"}: a zone or record id the vault cannot hold as a path`);
      if (stored.get(rec.id) !== JSON.stringify(row)) throw new VaultError(`record ${rec.id}: the raw record does not give the run's stored row`);
      out.push({ path: `${z.zone}/${rec.id}.json`, objectId: rec.id, bytes: Buffer.from(recordJson(rec), "utf8") });
    }
  }
  if (out.length !== c.records.length) throw new VaultError(`${out.length} raw record(s) for ${c.records.length} stored row(s) of run ${c.dnsRun.run_id}`);
  return out;
}

/** A hook result as the collect scripts print it: status, commit, counts; no path and no byte. */
export function hookSummary(h: HookResult): Record<string, string | number | boolean> {
  if (h.status === "committed") {
    const c = h.commit;
    return { status: h.status, repo: c.repo, commit: c.commit, reused: c.reused, files: c.files, added: c.added, modified: c.modified, removed: c.removed, vault_copy_written: h.written };
  }
  if (h.status === "skipped") return { status: h.status, reason: h.reason };
  if (h.status === "failed") return { status: h.status, error: h.error };
  return { status: h.status };
}

const scrubbed = (redactor: Redactor, e: unknown): string => redactor.text(redact((e as Error)?.message ?? String(e)));

async function commitAndStore(
  vault: Vault | null, store: CopyStore, run: CollectionRun, label: string, files: () => { tenantId: string; repo: string; files: VaultFile[]; links?: Record<string, string> },
  redactor: Redactor, tracer?: Emitter,
): Promise<HookResult> {
  const line = (status: "ok" | "skipped" | "failed", output_summary: string, detail?: string): void => {
    tracer?.emit({ agent: "vault", action: "observe", status, input_summary: `${run.surface} run ${run.run_id}`, output_summary, ...(detail ? { detail } : {}) });
  };
  if (!vault) {
    line("skipped", VAULT_OFF);
    return { status: "off" };
  }
  if (run.status !== "complete") {
    const reason = `run ${run.run_id} is ${run.status}; nothing committed`;
    line("skipped", `vault: ${reason}`);
    return { status: "skipped", reason };
  }
  try {
    const input = files();
    const commit = vault.commitRun({ ...input, run });
    const written = await store.insertVaultCopies(commit.copies);
    line("ok", `vault: run ${run.run_id} ${commit.reused ? "was committed before" : "committed"} to ${label} at ${commit.commit.slice(0, 12)}: ${commit.files} file(s), ${commit.added} added, ${commit.modified} modified, ${commit.removed} removed; vault_copy ${written} row(s) written of ${commit.copies.length}`);
    return { status: "committed", commit, written };
  } catch (e) {
    const error = scrubbed(redactor, e);
    line("failed", `vault: run ${run.run_id} not committed`, error);
    return { status: "failed", error };
  }
}

/** After a host run's Store writes: commit the run's files (when complete) and store its vault_copy rows. */
export function vaultLinuxRun(
  vault: Vault | null, store: CopyStore, res: Pick<CollectResult, "rows" | "files" | "links">,
  opts: { tenantId: string; alias: string; redactor: Redactor; tracer?: Emitter },
): Promise<HookResult> {
  const run = res.rows.collection_run[0];
  if (!run) return Promise.resolve({ status: "failed", error: "no collection_run row" });
  return commitAndStore(vault, store, run, `${opts.tenantId}/${run.host ?? "?"}`, () => ({
    tenantId: opts.tenantId, repo: opts.alias, files: linuxVaultFiles(res, opts.redactor), links: { ...res.links },
  }), opts.redactor, opts.tracer);
}

/** After a DNS run's Store writes: commit the run's records (when complete) and store its vault_copy rows. */
export function vaultCloudflareRun(
  vault: Vault | null, store: CopyStore, c: Pick<CloudflareCollection, "dnsRun" | "records">, raw: readonly RawZone[],
  opts: { redactor: Redactor; tracer?: Emitter },
): Promise<HookResult> {
  return commitAndStore(vault, store, c.dnsRun, `${c.dnsRun.tenant_id}/${CLOUDFLARE_REPO}`, () => ({
    tenantId: c.dnsRun.tenant_id, repo: CLOUDFLARE_REPO, files: cloudflareVaultFiles(c, raw, opts.redactor),
  }), opts.redactor, opts.tracer);
}
