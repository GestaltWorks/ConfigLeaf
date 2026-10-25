// revert_record: a ROLLBACK on a cloudflare.dns record field carried out. The approved record is the JSON the vault
// commit the Decider named holds at <zone>/<record_id>.json (the zone's real name is the directory); the zone id comes
// from listZones; the write is PATCH /zones/{zone}/dns_records/{id} with type, name, content, ttl and proxied, or, for
// an approved record the zone no longer holds, POST /zones/{zone}/dns_records with the same fields.
//
// Contract:
//   prepareRevert  read before anything is written: the copy (plan.ts resolveCopy), the record JSON at its commit,
//                  whose field fingerprint (the collector's rule, cloudflare.ts dnsObservationRows) must be the
//                  approved hash, and whether the disposition's run holds the record (the plan says PATCH or POST).
//                  A failed revert of the same target to the same commit over the same live value is refused.
//   planRevert     the dry-run lines.
//   revertRecord   the live record by id first. Present: its field must still carry the disposition's live value,
//                  else refused (it changed since the run); then PATCH. Absent while the run held it: refused, for
//                  the same reason. Absent from the run and the zone (an approved record that is missing): a record
//                  of the same name, type and content in the zone is a refusal (the approval names the old id;
//                  re-approve the record), else POST. Verification is authoritative: the record read back and compared field by field with the
//                  copy (names and CNAME, NS and MX targets case-insensitive, without a trailing dot); done when
//                  every field matches, failed naming each one that differs. One dns probe of the record's name
//                  through src/probe follows and is recorded with the caveat that resolvers answer from cache until
//                  the TTL passes, so its status leaves the action's alone. after_hash is the fingerprint of the
//                  disposition's field on the record read back.
//
// Measured 24 Oct 2026: PATCH, POST, the twin refusal and the read back exercised against a fake fetch
// (test/actions.test.ts); the Cloudflare account had received 0 writes from it.

import { dnsObservationRows, dnsRecordRow, type CfRecord, type CfRecordBody, type CfZone } from "../collectors/cloudflare.ts";
import { redactText } from "../collectors/linux.ts";
import type { Disposition, Probe } from "../data/rows.ts";
import type { Redactor } from "../redactor.ts";
import { CLOUDFLARE_REPO, treePath, type Vault } from "../vault/vault.ts";
import {
  c8, gaps, h12, outcome, plural, probeSentence, resolveCopy, targetOf,
  type ActionOutcome, type ActorReads, type CopyChoice, type Emitter, type ProbeFn,
} from "./plan.ts";

/** The Cloudflare client's reads and its two writes; Cloudflare satisfies it, a test hands in one over a fake fetch. */
export interface RecordApi {
  listZones(): Promise<CfZone[]>;
  listRecords(zoneId: string): Promise<CfRecord[]>;
  patchRecord(zoneId: string, recordId: string, body: CfRecordBody): Promise<CfRecord>;
  createRecord(zoneId: string, body: CfRecordBody): Promise<CfRecord>;
}

export interface RevertDeps {
  reads: ActorReads;
  vault: Vault | null;
  records: RecordApi | null;
  probe: ProbeFn;
  redactor: Redactor;
  now: () => Date;
  tracer?: Emitter;
}

/** One record as the vault holds it (src/vault/hook.ts recordJson). */
export interface VaultRecord { id: string; name: string; type: string; content: string; ttl: number | null; proxied: boolean | null }

export interface PreparedRevert {
  choice: CopyChoice;
  record: VaultRecord;
  /** The zone's real name, the record file's directory; used for the zone lookup only. */
  zone: string;
  redactedName: string;
  redactedZone: string;
  /** The disposition's run holds the record: PATCH; absent: POST. */
  inRun: boolean;
}

export type RevertPrep = PreparedRevert | { refused: string };

const FIELDS = ["type", "name", "content", "ttl", "proxied"] as const;
const safe = (r: Redactor, e: unknown): string => redactText(r, (e as Error)?.message ?? String(e));

/** The fingerprint of one field of a record, exactly as the collector stores it. */
export function fieldHash(r: Redactor, rec: CfRecord, zone: string, field: string): string | null {
  const row = dnsRecordRow(r, rec, zone, { tenantId: "-", runId: "-", observedAt: "1970-01-01T00:00:00.000Z" });
  return row ? (dnsObservationRows(r, rec, row).find((o) => o.setting_path === field)?.value_hash ?? null) : null;
}

const asCf = (v: VaultRecord): CfRecord => ({ id: v.id, name: v.name, type: v.type, content: v.content, ...(v.ttl === null ? {} : { ttl: v.ttl }), ...(v.proxied === null ? {} : { proxied: v.proxied }) });
const bodyOf = (v: VaultRecord): CfRecordBody => ({ type: v.type, name: v.name, content: v.content, ...(v.ttl === null ? {} : { ttl: v.ttl }), ...(v.proxied === null ? {} : { proxied: v.proxied }) });
const norm = (s: string): string => s.trim().toLowerCase().replace(/\.$/, "");
const HOST_TARGETS = new Set(["CNAME", "NS", "MX"]);

/** The fields of `got` that differ from the copy; ttl and proxied only where the copy holds them. */
export function differences(want: VaultRecord, got: CfRecord): string[] {
  const out: string[] = [];
  if (String(got.type).toUpperCase() !== want.type.toUpperCase()) out.push("type");
  if (norm(String(got.name)) !== norm(want.name)) out.push("name");
  const content = HOST_TARGETS.has(want.type.toUpperCase()) ? norm(String(got.content)) === norm(want.content) : String(got.content) === want.content;
  if (!content) out.push("content");
  if (want.ttl !== null && got.ttl !== want.ttl) out.push("ttl");
  if (want.proxied !== null && got.proxied !== want.proxied) out.push("proxied");
  return out;
}

function parseVaultRecord(bytes: Uint8Array): VaultRecord | null {
  try {
    const j = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
    if (typeof j.id !== "string" || typeof j.name !== "string" || typeof j.type !== "string" || typeof j.content !== "string") return null;
    const ttl = typeof j.ttl === "number" && Number.isInteger(j.ttl) ? j.ttl : null;
    const proxied = typeof j.proxied === "boolean" ? j.proxied : null;
    return { id: j.id, name: j.name, type: j.type, content: j.content, ttl, proxied };
  } catch {
    return null;
  }
}

export async function prepareRevert(d: Disposition, deps: RevertDeps): Promise<RevertPrep> {
  const r = deps.redactor;
  if (!(FIELDS as readonly string[]).includes(d.setting_path)) return { refused: `${d.setting_path} is a record field the revert path does not write (it writes ${FIELDS.join(", ")})` };
  const choice = await resolveCopy(d, deps.reads);
  if ("refused" in choice) return choice;
  const { copy, approval } = choice;
  if (!deps.vault) return { refused: "the vault is off (DRIFT_VAULT_DIR is blank), so the approved record cannot be read" };
  let record: VaultRecord | null;
  let zone: string;
  try {
    const tree = deps.vault.readTree(d.tenant_id, CLOUDFLARE_REPO, copy.git_commit);
    const path = Object.entries(tree.paths).find(([, id]) => id === d.object_id)?.[0];
    if (!path) return { refused: `vault commit ${c8(copy.git_commit)} holds no record ${d.object_id}` };
    zone = path.split("/")[0];
    const bytes = tree.files.get(treePath(path));
    record = bytes ? parseVaultRecord(bytes) : null;
  } catch (e) {
    return { refused: `the vault refused the read: ${safe(r, e)}` };
  }
  if (!record || record.id !== d.object_id) return { refused: `the record file of ${d.object_id} at vault commit ${c8(copy.git_commit)} is not a record of that id` };
  const approvedField = fieldHash(r, asCf(record), zone, d.setting_path);
  if (approvedField !== approval.value_hash) {
    return { refused: `the record at vault commit ${c8(copy.git_commit)} carries ${h12(approvedField)} for ${d.setting_path}; the approval is ${h12(approval.value_hash)}` };
  }
  const failedBefore = deps.reads.actionsOn(targetOf(d)).filter((a) => a.kind === "revert_record" && a.status === "failed" && a.vault_commit === copy.git_commit && a.before_hash === d.value_hash).at(-1);
  if (failedBefore) {
    return { refused: `action ${failedBefore.action_id} reverted this record to commit ${c8(copy.git_commit)} over the same live value and failed at ${failedBefore.finished_at ?? failedBefore.started_at}; the same write is left to a technician` };
  }
  const row = dnsRecordRow(r, asCf(record), zone, { tenantId: d.tenant_id, runId: "-", observedAt: "1970-01-01T00:00:00.000Z" })!;
  const inRun = (await deps.reads.observationsOf(d.run_id)).some((o) => o.object_id === d.object_id);
  return { choice, record, zone, redactedName: row.name, redactedZone: row.zone, inRun };
}

/** The dry-run lines of one revert. */
export function planRevert(d: Disposition, p: PreparedRevert): string[] {
  const { copy, approval } = p.choice;
  const from = `vault commit ${c8(copy.git_commit)} (copy ${copy.copy_id} of run ${copy.run_id}, validated ${copy.result} with ${plural(gaps(copy), "gap")})`;
  return [
    `target record ${d.object_id} (${p.redactedName}, ${p.record.type}) in zone ${p.redactedZone}, ${d.verb} under ${d.rule_id ?? "no rule"}`,
    p.inRun
      ? `PATCH the record's type, name, content, ttl and proxied to the approved copy at ${from}: ${d.setting_path} from ${h12(d.value_hash)} to ${h12(approval.value_hash)}`
      : `POST a record with the approved copy's type, name, content, ttl and proxied from ${from}: run ${d.run_id} holds no record ${d.object_id}; a record of the same name, type and content in the zone is a refusal`,
    `then the record read back from the API and compared field by field with the copy; then one dns probe of ${p.redactedName}, which resolvers answer from cache until the TTL (${p.record.ttl ?? "auto"} s) passes`,
  ];
}

export async function revertRecord(d: Disposition, p: PreparedRevert, deps: RevertDeps): Promise<ActionOutcome> {
  const r = deps.redactor;
  const red = (s: string): string => redactText(r, s);
  const started = deps.now().toISOString();
  const { copy } = p.choice;
  const record: string[] = [`vault commit ${c8(copy.git_commit)} holds record ${d.object_id} (${p.redactedName}, ${p.record.type}, ttl ${p.record.ttl ?? "auto"}, proxied ${p.record.proxied ?? "unset"})`];
  const end = (status: "done" | "failed" | "refused", reason: string, extra: { before?: string | null; after?: string | null; verification?: string[] } = {}): ActionOutcome =>
    outcome(d, "revert_record", {
      status, reason: red(reason), record: record.map(red), vault_commit: copy.git_commit, started_at: started, finished_at: deps.now().toISOString(),
      before_hash: extra.before ?? null, after_hash: extra.after ?? null, verification: extra.verification,
    });
  const api = deps.records;
  if (!api) return end("refused", "no Cloudflare client (CLOUDFLARE_API_TOKEN is blank)");

  let zoneId: string;
  let live: CfRecord[];
  try {
    const z = (await api.listZones()).find((x) => x.name === p.zone);
    if (!z) return end("refused", `the token sees no zone ${p.redactedZone}`);
    zoneId = z.id;
    live = await api.listRecords(zoneId);
  } catch (e) {
    return end("failed", `the zone read failed: ${safe(r, e)}`);
  }
  const current = live.find((x) => x.id === p.record.id);
  let id: string;
  let before: string | null = null;
  if (current) {
    before = fieldHash(r, current, p.zone, d.setting_path);
    record.push(`before: ${d.setting_path} ${h12(before)} on record ${current.id}`);
    if (before !== d.value_hash) {
      return end("refused", `the record's ${d.setting_path} is ${h12(before)} now and run ${d.run_id} recorded ${h12(d.value_hash)}: it changed since the decision, and nothing was written`, { before });
    }
    try {
      await api.patchRecord(zoneId, current.id, bodyOf(p.record));
    } catch (e) {
      return end("failed", `PATCH of record ${current.id} failed: ${safe(r, e)}`, { before });
    }
    id = current.id;
    record.push(`PATCH record ${id} in zone ${p.redactedZone}: answered`);
  } else if (p.inRun) {
    return end("refused", `record ${p.record.id} was in run ${d.run_id} and is absent from the zone now: it changed since the decision, and nothing was written`);
  } else {
    const twin = live.find((x) => norm(String(x.name)) === norm(p.record.name) && String(x.type).toUpperCase() === p.record.type.toUpperCase() && differences({ ...p.record, ttl: null, proxied: null }, x).length === 0);
    if (twin) {
      return end("refused", `record ${p.record.id} is absent and record ${twin.id} carries the same name, type and content; the approval names ${p.record.id}, so the record is re-approved under ${twin.id} (npm run approve -- --record ${twin.id})`);
    }
    try {
      id = (await api.createRecord(zoneId, bodyOf(p.record))).id;
    } catch (e) {
      return end("failed", `POST of the approved record failed: ${safe(r, e)}`);
    }
    record.push(`before: record ${p.record.id} absent from zone ${p.redactedZone}; POST created record ${id}`);
  }

  let back: CfRecord | undefined;
  try {
    back = (await api.listRecords(zoneId)).find((x) => x.id === id);
  } catch (e) {
    return end("failed", `written; the read back failed: ${safe(r, e)}`, { before });
  }
  if (!back) return end("failed", `written; record ${id} is absent from the zone on the read back`, { before });
  const diff = differences(p.record, back);
  const after = fieldHash(r, back, p.zone, d.setting_path);
  record.push(diff.length ? `read back: ${diff.join(", ")} differ from the copy` : `read back: type, name, content${p.record.ttl === null ? "" : ", ttl"}${p.record.proxied === null ? "" : ", proxied"} equal the copy; ${d.setting_path} ${h12(after)}`);

  let probes: Probe[] = [];
  try {
    probes = await deps.probe([p.redactedName], ["dns"]);
  } catch (e) {
    record.push(`the dns probe of ${p.redactedName} did not run: ${safe(r, e)}`);
  }
  for (const x of probes) record.push(`${probeSentence(x)}; resolvers answer from cache until the TTL (${p.record.ttl ?? "auto"} s) passes, so the API read above decides the status`);
  const verification = probes.map((x) => x.probe_id);
  if (diff.length) return end("failed", `written; the record read back differs from the copy in ${diff.join(", ")}`, { before, after, verification });
  return end("done", `${current ? "reverted" : "re-created"} to the approved copy at vault commit ${c8(copy.git_commit)}; the record read back equals the copy field by field`, { before, after, verification });
}
