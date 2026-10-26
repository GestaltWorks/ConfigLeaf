// Approval: the documentation of record. An approved_setting row says a technician signed off one value of
// one setting; drift_vs_approved compares the live value with the latest such row per setting. An IT Glue or
// Hudu adapter maps its configuration items onto the same rows. scripts/approve.ts is the technician's side:
// it reads the latest passing run, selects, prints and writes through the Store.
//
// Contract:
//   approvalsFor(observations, selection, by, note, now)  pure. One approved_setting row per selected
//     observation, value_hash copied from it, approval_id = rows.ts approvalId (tenant, host, object,
//     setting, value, approved_at), approved_at = now in the millisecond form, approved_by = by, note = note; rows in
//     (object_id, setting_path) code-unit order. Selections:
//       host     the `file` setting of every nginx object (object id under /etc/nginx/) of that host
//       object   the `file` setting of one object of that host, by redacted object id
//       record   every field (type, name, content, ttl, proxied) of one Cloudflare record
//       zone     every field of every record listed (the script lists a zone's record ids)
//       account  every field of every record in the observations
//       surface  every setting of one surface and host in the observations: zetaris.control on the Zetaris
//                instance (src/zetaris/control.ts), each object's definition
//     by and note are stored as given: the script passes them through the redactor first, so a dry run
//     prints the rows the Store writes.
//   resolveObject   a real path (redacted the way the collector redacts it, linux.ts redactText) or a
//     redacted object id -> the object id of a `file` observation, or null; a path a Windows shell rewrote
//     to a drive path is read back from its /etc/ segment first (hostPath).
//   resolveZone     a real or redacted zone name -> the ids of its records in a DNS run, or [].
//   approvalStatus  each row against the approvals already stored: new (no approval of the setting is
//     stored), current (the setting's latest approval holds this value), replaces (the latest approval holds
//     another value, and this value has no approval stored), superseded (the latest approval holds another
//     value, and an earlier approval of this value is stored: the row re-approves it and becomes the latest).
//   approvalsToWrite  the rows whose state is new, replaces or superseded, in the rows' order: what the
//     script writes. A current row is skipped, so a re-run over an unchanged estate writes 0 rows, and a
//     re-approval of an earlier value lands as a row of its own (approvalId carries approved_at).

import { redactText } from "../collectors/linux.ts";
import { approvalId, type ApprovedSetting, type CollectionRun, type DnsRecord, type Observation } from "../data/rows.ts";
import type { Redactor } from "../redactor.ts";

export const NGINX_SURFACE = "linux.nginx";
export const DNS_SURFACE = "cloudflare.dns";
/** The settings of one Cloudflare record, one observation row each. */
export const DNS_FIELDS = ["type", "name", "content", "ttl", "proxied"] as const;
export const NGINX_PREFIX = "/etc/nginx/";

export type ApprovalSelection =
  | { kind: "host"; host: string }
  | { kind: "object"; host: string; object_id: string }
  | { kind: "record"; record_id: string }
  | { kind: "zone"; record_ids: readonly string[] }
  | { kind: "account" }
  | { kind: "surface"; surface: string; host: string };

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const codeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isField = (p: string): boolean => (DNS_FIELDS as readonly string[]).includes(p);

/** Whether one observation is in the selection. */
export function selects(sel: ApprovalSelection, o: Observation): boolean {
  switch (sel.kind) {
    case "host":
      return o.surface === NGINX_SURFACE && o.host === sel.host && o.setting_path === "file" && o.object_id.startsWith(NGINX_PREFIX);
    case "object":
      return o.surface === NGINX_SURFACE && o.host === sel.host && o.setting_path === "file" && o.object_id === sel.object_id;
    case "record":
      return o.surface === DNS_SURFACE && o.host === null && isField(o.setting_path) && o.object_id === sel.record_id;
    case "zone":
      return o.surface === DNS_SURFACE && o.host === null && isField(o.setting_path) && sel.record_ids.includes(o.object_id);
    case "account":
      return o.surface === DNS_SURFACE && o.host === null && isField(o.setting_path);
    case "surface":
      return o.surface === sel.surface && o.host === sel.host;
  }
}

/** The approved_setting rows for one selection (see the header). */
export function approvalsFor(observations: readonly Observation[], selection: ApprovalSelection, by: string, note: string | null, now: Date | string): ApprovedSetting[] {
  const at = typeof now === "string" ? now : now.toISOString();
  if (!ISO_MS.test(at)) throw new Error(`approvalsFor: now must be ISO 8601 UTC in the millisecond form, got ${at}`);
  if (!by.trim()) throw new Error("approvalsFor: by names who approved; it is blank");
  return observations.filter((o) => selects(selection, o))
    .sort((a, b) => codeUnit(a.object_id, b.object_id) || codeUnit(a.setting_path, b.setting_path))
    .map((o) => ({
      approval_id: approvalId(o.tenant_id, o.host, o.object_id, o.setting_path, o.value_hash, at),
      tenant_id: o.tenant_id, surface: o.surface, host: o.host, object_id: o.object_id, setting_path: o.setting_path,
      value_hash: o.value_hash, approved_at: at, approved_by: by, note,
    }));
}

/**
 * A host path as typed. Git Bash (MSYS) rewrites an argument that starts with "/" into a Windows path under its
 * install directory before node sees it (measured 24 Oct 2026: /etc/nginx/nginx.conf arrived as
 * C:/Program Files/Git/etc/nginx/nginx.conf); a host path never starts with a drive letter, so such an input
 * is read back from its /etc/ segment on.
 */
export function hostPath(input: string): string {
  if (!/^[A-Za-z]:[\\/]/.test(input)) return input;
  const p = input.replace(/\\/g, "/");
  const i = p.indexOf("/etc/");
  return i >= 0 ? p.slice(i) : input;
}

/** A real path or a redacted object id -> the object id of a `file` observation of that host, or null. */
export function resolveObject(observations: readonly Observation[], host: string, input: string, redactor: Redactor): string | null {
  const ids = new Set(observations.filter((o) => o.surface === NGINX_SURFACE && o.host === host && o.setting_path === "file").map((o) => o.object_id));
  const typed = hostPath(input);
  for (const candidate of [typed, redactText(redactor, typed)]) if (ids.has(candidate)) return candidate;
  return null;
}

/** A real or redacted zone name -> the ids of its records in a DNS run, in id order; [] when none. */
export function resolveZone(records: readonly DnsRecord[], input: string, redactor: Redactor): string[] {
  const names = new Set([input, input.toLowerCase(), redactor.text(input), redactor.text(input.toLowerCase())].map((z) => z.replace(/\.$/, "")));
  return [...new Set(records.filter((d) => names.has(d.zone)).map((d) => d.record_id))].sort(codeUnit);
}

export type ApprovalState = "new" | "replaces" | "current" | "superseded";

const settingKey = (a: Pick<ApprovedSetting, "tenant_id" | "surface" | "host" | "object_id" | "setting_path">): string =>
  [a.tenant_id, a.surface, a.host ?? "", a.object_id, a.setting_path].join("\u001f");

/** Each row against the stored approvals (see the header), in the rows' order. */
export function approvalStatus(rows: readonly ApprovedSetting[], stored: readonly ApprovedSetting[]): ApprovalState[] {
  const latest = new Map<string, ApprovedSetting>();
  for (const a of stored) {
    const k = settingKey(a);
    const cur = latest.get(k);
    if (!cur || a.approved_at > cur.approved_at || (a.approved_at === cur.approved_at && a.approval_id > cur.approval_id)) latest.set(k, a);
  }
  const values = new Set(stored.map((a) => `${settingKey(a)}\u001f${a.value_hash}`));
  return rows.map((r) => {
    const top = latest.get(settingKey(r));
    if (!top) return "new";
    if (top.value_hash === r.value_hash) return "current";
    return values.has(`${settingKey(r)}\u001f${r.value_hash}`) ? "superseded" : "replaces";
  });
}

/** The rows a run writes: every row whose state is new, replaces or superseded, in the rows' order; current rows are skipped. */
export function approvalsToWrite(rows: readonly ApprovedSetting[], states: readonly ApprovalState[]): ApprovedSetting[] {
  if (rows.length !== states.length) throw new Error(`approvalsToWrite: ${rows.length} row(s) and ${states.length} state(s)`);
  return rows.filter((_, i) => states[i] !== "current");
}

/** What a sign-off reads and writes: the Store on Postgres (scripts/approve.ts), the sql.js engine of the console in sample mode. */
export interface ApprovalStore {
  rowsOf(table: "approved_setting", where: { tenant_id: string }): Promise<ApprovedSetting[]>;
  insertApproved(rows: readonly ApprovedSetting[]): Promise<number>;
}

/** The selection matches no setting of the run: scripts/approve.ts exits 1 with the message. */
export class ApproveError extends Error {}

/** A run's counts, observed/expected, "?" for the one it lacks; null when it has neither. */
const countsOf = (r: Pick<CollectionRun, "observed_count" | "expected_count">): string | null =>
  r.observed_count === null && r.expected_count === null ? null : `${r.observed_count ?? "?"}/${r.expected_count ?? "?"}`;

/** One run as the sign-off names it: its counts, or "no counts" for a run that recorded neither. */
export const runLine = (r: CollectionRun): string => `${r.surface} run ${r.run_id}${r.host ? ` on ${r.host}` : ""}, started ${r.started_at}, ${countsOf(r) ?? "no counts,"} ${r.status}`;

export interface ApproveRun {
  tenant: string;
  run: CollectionRun;
  observations: readonly Observation[];
  selection: ApprovalSelection;
  /** approved_by and note, already through the redactor. */
  by: string;
  note: string | null;
  now: Date | string;
  dryRun: boolean;
}

export interface ApproveResult {
  /** The lines scripts/approve.ts prints, in its order. */
  lines: string[];
  rows: ApprovedSetting[];
  states: ApprovalState[];
  /** Rows written; null on a dry run. */
  written: number | null;
}

/**
 * The sign-off over one run, as scripts/approve.ts and the console's Approve run it: the selected rows (approvalsFor),
 * their states against the tenant's stored approvals, the rows to write through the store unless dryRun, and the lines
 * the CLI prints. Throws ApproveError when the selection matches no setting of the run.
 */
export async function approveRun(store: ApprovalStore, o: ApproveRun): Promise<ApproveResult> {
  const rows = approvalsFor(o.observations, o.selection, o.by, o.note, o.now);
  if (!rows.length) throw new ApproveError(`the selection matches no setting in ${runLine(o.run)}`);
  const stored = await store.rowsOf("approved_setting", { tenant_id: o.tenant });
  const states = approvalStatus(rows, stored);
  const lines = [`approve: ${runLine(o.run)}: ${rows.length} setting(s) selected (${o.selection.kind}), approved_by ${o.by}${o.note ? `, note "${o.note}"` : ""}`];
  rows.forEach((r, i) => lines.push(`  ${states[i].padEnd(10)} ${r.approval_id}  ${r.surface.padEnd(14)} ${(r.host ?? "-").padEnd(11)} ${r.object_id}  ${r.setting_path}  ${r.value_hash.slice(0, 19)}`));
  lines.push(`approve: ${(["new", "replaces", "current", "superseded"] as const).map((s) => `${s} ${states.filter((x) => x === s).length}`).join(", ")}`);
  if (states.includes("superseded")) lines.push("approve: a superseded row re-approves an earlier value; it is written as a new approval and becomes the latest");
  const toWrite = approvalsToWrite(rows, states);
  const current = rows.length - toWrite.length;
  if (o.dryRun) {
    lines.push(`approve: dry run, nothing written (${toWrite.length} row(s) for approved_setting, ${current} current)`);
    return { lines, rows, states, written: null };
  }
  const written = toWrite.length ? await store.insertApproved(toWrite) : 0;
  lines.push(`approve: approved_setting ${written} row(s) written, ${current} current and skipped`);
  return { lines, rows, states, written };
}
