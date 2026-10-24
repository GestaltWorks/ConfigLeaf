// Copy validation over the vault: one commit of a vault repository read with git alone (ls-tree and
// cat-file over the commit, nothing checked out), validated, and turned into copy_validation rows for the
// vault_copy rows of that commit.
//
// Layout (the design's, written by src/vault/): <DRIFT_VAULT_DIR>/<tenant>/<alias> per host, the fetched
// files at their real paths without the leading slash, .drift/paths.json (real path -> redacted object id)
// and .drift/links.json (symlink path -> target path); <DRIFT_VAULT_DIR>/<tenant>/cloudflare holding
// <zone>/<record_id>.json per record. Each commit's subject is "run <run_id> <surface> <started_at>".
//
// Contract:
//   - The vault holds real bytes and real names; what leaves this module is redacted: missing
//     dependencies, output, aliases and zone names go through the tenant's redactor. Commit hashes, run
//     ids, record ids and counts are the agent's own and pass as they are. Git's own error text has the
//     repository path cut out, and every error the two commit validators raise goes through the redactor.
//   - validateVaultCommit: the commit's files outside .drift/ are the tree; .drift/links.json and any git
//     symlink entry are the links; validateNginxTree (src/validate/nginx.ts) runs over them.
//   - validateCloudflareCommit: every <zone>/<record_id>.json of the commit (one zone's with `zone`),
//     validated by validateCloudflareCopy (src/validate/cfschema.ts) against the commit's own records,
//     which are the DNS run's, its zone folders and the inventory. A copy that fails to parse as a JSON
//     record fails.
//   - copyValidationRows: one row per vault copy, every row the one result of the validation they share;
//     validation_id = stableId("val", copy_id, validator, validated_at); missing_dependencies joined by
//     newlines; output_redacted cut at 2000 characters.
//   - A commit argument is hex of 4 to 64 characters, resolved with git rev-parse; a tenant or an alias is
//     a plain id ([A-Za-z0-9._-]); nothing else reaches git's argv.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { validationId, type CopyValidation, type ValidationResult, type Validator, type VaultCopy } from "../data/rows.ts";
import type { Redactor } from "../redactor.ts";
import { validateCloudflareCopy, type CfRecord } from "./cfschema.ts";
import { ValidateError, validateNginxTree, type NginxRunner } from "./nginx.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMIT = /^[0-9a-f]{4,64}$/i;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const OUTPUT_MAX = 2000;
export const CLOUDFLARE_REPO = "cloudflare";

/** <vaultDir>/<tenant>/<name>, both ids checked. */
export function repositoryDir(vaultDir: string, tenant: string, name: string): string {
  if (!ID.test(tenant)) throw new ValidateError(`tenant must be a plain id, got ${JSON.stringify(tenant)}`);
  if (!ID.test(name)) throw new ValidateError(`repository name must be a plain id, got ${JSON.stringify(name)}`);
  return path.join(vaultDir, tenant, name);
}

/** The tenant's vault repositories: host aliases (sorted) and whether the Cloudflare repository exists. */
export function vaultRepositories(vaultDir: string, tenant: string): { hosts: string[]; cloudflare: boolean } {
  if (!ID.test(tenant)) throw new ValidateError(`tenant must be a plain id, got ${JSON.stringify(tenant)}`);
  const dir = path.join(vaultDir, tenant);
  if (!existsSync(dir)) return { hosts: [], cloudflare: false };
  const repos = readdirSync(dir).filter((n) => ID.test(n) && statSync(path.join(dir, n)).isDirectory() && existsSync(path.join(dir, n, ".git"))).sort();
  return { hosts: repos.filter((n) => n !== CLOUDFLARE_REPO), cloudflare: repos.includes(CLOUDFLARE_REPO) };
}

function git(repo: string, args: readonly string[], input?: Buffer): { status: number; stdout: Buffer } {
  const r = spawnSync("git", ["-C", repo, ...args], { input, maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (r.error) throw new ValidateError(`git could not start: ${(r.error as NodeJS.ErrnoException).code ?? r.error.message}`);
  return { status: r.status ?? 1, stdout: r.stdout };
}

function gitOk(repo: string, args: readonly string[], input?: Buffer): Buffer {
  const r = spawnSync("git", ["-C", repo, ...args], { input, maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (r.error) throw new ValidateError(`git could not start: ${(r.error as NodeJS.ErrnoException).code ?? r.error.message}`);
  if (r.status !== 0) {
    const forms = [repo, repo.replace(/\\/g, "/")];
    let msg = r.stderr.toString("utf8").trim().split(/\r?\n/)[0] ?? "";
    for (const f of forms) msg = msg.split(f).join("<repository>");
    throw new ValidateError(`git ${args[0]} failed (exit ${r.status}): ${msg}`);
  }
  return r.stdout;
}

/** The repository's HEAD commit, or null when it has none. */
export function latestCommit(repo: string): string | null {
  const r = git(repo, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  return r.status === 0 ? r.stdout.toString("utf8").trim() : null;
}

/** A hex commit argument, full or abbreviated, to the full hash. Throws on anything but hex, and on a hash that names no commit. */
export function resolveCommit(repo: string, commit: string): string {
  if (!COMMIT.test(commit)) throw new ValidateError(`commit must be 4 to 64 hex characters: ${JSON.stringify(commit)}`);
  const r = git(repo, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
  if (r.status !== 0) throw new ValidateError(`no commit ${commit} in the repository`);
  return r.stdout.toString("utf8").trim();
}

/** The run id from a commit subject "run <run_id> <surface> <started_at>", or null. */
export function runOfCommit(repo: string, commit: string): string | null {
  const subject = gitOk(repo, ["log", "-1", "--format=%s", commit]).toString("utf8").trim();
  return /^run (\S+) \S+ \S+$/.exec(subject)?.[1] ?? null;
}

export interface CommitTree {
  /** Every regular file of the commit, path -> bytes. */
  files: Map<string, Uint8Array>;
  /** Every git symlink entry of the commit, path -> target. */
  symlinks: Map<string, string>;
}

/** Every blob of one commit, read with ls-tree and cat-file --batch. */
export function readCommit(repo: string, commit: string): CommitTree {
  const listing = gitOk(repo, ["ls-tree", "-r", "-z", "--full-tree", commit]).toString("utf8");
  const entries = listing.split("\0").filter(Boolean).map((e) => {
    const tab = e.indexOf("\t");
    const [mode, type, oid] = e.slice(0, tab).split(" ");
    return { mode, type, oid, path: e.slice(tab + 1) };
  }).filter((e) => e.type === "blob");
  const files = new Map<string, Uint8Array>();
  const symlinks = new Map<string, string>();
  if (!entries.length) return { files, symlinks };
  const out = gitOk(repo, ["cat-file", "--batch"], Buffer.from(entries.map((e) => `${e.oid}\n`).join("")));
  let at = 0;
  for (const e of entries) {
    const nl = out.indexOf(0x0a, at);
    const header = out.subarray(at, nl).toString("utf8").split(" ");
    if (header[1] !== "blob") throw new ValidateError(`git cat-file: object ${e.oid} is ${header[1] ?? "unreadable"}`);
    const size = Number(header[2]);
    const bytes = out.subarray(nl + 1, nl + 1 + size);
    at = nl + 1 + size + 1;
    if (e.mode === "120000") symlinks.set(e.path, bytes.toString("utf8"));
    else files.set(e.path, new Uint8Array(bytes));
  }
  return { files, symlinks };
}

/** .drift/links.json as a map; an object of path -> target, or an array of [path, target] pairs. */
function parseLinks(bytes: Uint8Array | undefined): Map<string, string> {
  if (!bytes) return new Map();
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new ValidateError(".drift/links.json fails to parse as JSON");
  }
  const pairs = Array.isArray(v) ? v : Object.entries((v ?? {}) as Record<string, unknown>);
  const out = new Map<string, string>();
  for (const p of pairs) {
    if (!Array.isArray(p) || typeof p[0] !== "string" || typeof p[1] !== "string") throw new ValidateError(".drift/links.json holds an entry outside the path -> target shape");
    out.set(p[0], p[1]);
  }
  return out;
}

/** What validateVaultCommit returns: redacted, ready to print and to store. */
export interface VaultNginxValidation {
  repository: string;
  commit: string;
  run_id: string | null;
  files: number;
  links: number;
  result: ValidationResult;
  missing_dependencies: string[];
  output: string;
  rounds: number;
  reason: string;
}

export interface ValidateVaultCommitOptions {
  vaultDir: string;
  tenant: string;
  alias: string;
  commit: string;
  redactor: Redactor;
  runner?: NginxRunner;
  maxRounds?: number;
  pair?: () => Promise<string>;
  tmpRoot?: string;
}

/** nginx-t over one commit of a host repository; every string that names the estate comes back redacted. */
export async function validateVaultCommit(opts: ValidateVaultCommitOptions): Promise<VaultNginxValidation> {
  try {
    return await nginxCommit(opts);
  } catch (e) {
    throw redactedError(e, opts.redactor);
  }
}

/** An error whose text went through the tenant's redactor: what a caller may print. */
function redactedError(e: unknown, r: Redactor): ValidateError {
  return new ValidateError(r.text(e instanceof Error ? e.message : String(e)));
}

async function nginxCommit(opts: ValidateVaultCommitOptions): Promise<VaultNginxValidation> {
  const repo = repositoryDir(opts.vaultDir, opts.tenant, opts.alias);
  if (!existsSync(path.join(repo, ".git"))) throw new ValidateError(`no vault repository for ${opts.tenant}/${opts.redactor.text(opts.alias)}`);
  const commit = resolveCommit(repo, opts.commit);
  const { files, symlinks } = readCommit(repo, commit);
  const links = parseLinks(files.get(".drift/links.json"));
  for (const [k, v] of symlinks) if (!k.startsWith(".drift/")) links.set(k, v);
  const tree = new Map([...files].filter(([k]) => !k.startsWith(".drift/")));
  const v = await validateNginxTree({ tree, links, runner: opts.runner, maxRounds: opts.maxRounds, pair: opts.pair, tmpRoot: opts.tmpRoot });
  const r = opts.redactor;
  return {
    repository: `${opts.tenant}/${r.text(opts.alias)}`,
    commit,
    run_id: runOfCommit(repo, commit),
    files: tree.size,
    links: links.size,
    result: v.result,
    missing_dependencies: [...new Set(v.missing_dependencies.map((p) => r.text(p)))].sort(),
    output: r.text(v.output),
    rounds: v.rounds,
    reason: r.text(v.reason),
  };
}

export interface CfCopyValidation {
  record_id: string;
  /** The zone folder, redacted. */
  zone: string;
  type: string;
  result: ValidationResult;
  missing_dependencies: string[];
  output: string;
}

export interface ValidateCloudflareCommitOptions {
  vaultDir: string;
  tenant: string;
  commit: string;
  redactor: Redactor;
  /** The tenant's inventory addresses as stored (redacted); null when the inventory was not read. */
  inventory: Iterable<string> | null;
  /** One zone: its folder name, or that name's pseudonym. */
  zone?: string;
}

/** cf-schema over every record copy of one commit of the tenant's Cloudflare repository; redacted. */
export interface CloudflareCommitValidation { repository: string; commit: string; run_id: string | null; zones: number; records: CfCopyValidation[] }

export function validateCloudflareCommit(opts: ValidateCloudflareCommitOptions): CloudflareCommitValidation {
  try {
    return cloudflareCommit(opts);
  } catch (e) {
    throw redactedError(e, opts.redactor);
  }
}

function cloudflareCommit(opts: ValidateCloudflareCommitOptions): CloudflareCommitValidation {
  const repo = repositoryDir(opts.vaultDir, opts.tenant, CLOUDFLARE_REPO);
  if (!existsSync(path.join(repo, ".git"))) throw new ValidateError(`no Cloudflare vault repository for ${opts.tenant}`);
  const commit = resolveCommit(repo, opts.commit);
  const { files } = readCommit(repo, commit);
  const r = opts.redactor;
  const copies: { zone: string; id: string; record: CfRecord | null }[] = [];
  for (const [k, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const m = /^([^/]+)\/([^/]+)\.json$/.exec(k);
    if (!m || m[1] === ".drift") continue;
    let record: CfRecord | null = null;
    try {
      const v = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
      if (v && typeof v === "object" && typeof v.name === "string" && typeof v.type === "string" && typeof v.content === "string") record = v as unknown as CfRecord;
    } catch {
      record = null;
    }
    copies.push({ zone: m[1], id: m[2], record });
  }
  const zones = [...new Set(copies.map((c) => c.zone))];
  const wanted = opts.zone === undefined ? null : zones.find((z) => z === opts.zone || r.text(z) === opts.zone) ?? "";
  if (wanted === "") throw new ValidateError(`no zone ${r.text(opts.zone ?? "")} in the Cloudflare repository at ${commit.slice(0, 8)}`);
  const recordsOfRun = copies.flatMap((c) => (c.record ? [c.record] : []));
  const inventory = opts.inventory === null ? null : [...opts.inventory];
  const records = copies.filter((c) => wanted === null || c.zone === wanted).map((c): CfCopyValidation => {
    const v = c.record
      ? validateCloudflareCopy(c.record, { recordsOfRun, inventory, addressKey: (a) => r.text(a), zones })
      : { result: "fail" as const, missing_dependencies: [], output: "the copy fails to parse as a JSON record with name, type and content" };
    return {
      record_id: c.id,
      zone: r.text(c.zone),
      type: c.record ? String(c.record.type).toUpperCase() : "",
      result: v.result,
      missing_dependencies: [...new Set(v.missing_dependencies.map((d) => r.text(d)))].sort(),
      output: r.text(v.output),
    };
  });
  return { repository: `${opts.tenant}/${CLOUDFLARE_REPO}`, commit, run_id: runOfCommit(repo, commit), zones: wanted === null ? zones.length : 1, records };
}

/** One copy_validation row per vault copy, all carrying one validation's (already redacted) result. */
export function copyValidationRows(
  copies: readonly VaultCopy[],
  v: { result: ValidationResult; missing_dependencies: readonly string[]; output: string },
  opts: { validator: Validator; validatedAt: string },
): CopyValidation[] {
  if (!ISO_MS.test(opts.validatedAt)) throw new ValidateError(`validatedAt must be YYYY-MM-DDTHH:MM:SS.mmmZ, got ${opts.validatedAt}`);
  return copies.map((c) => ({
    validation_id: validationId(c.copy_id, opts.validator, opts.validatedAt),
    copy_id: c.copy_id,
    tenant_id: c.tenant_id,
    validator: opts.validator,
    result: v.result,
    missing_dependencies: v.missing_dependencies.join("\n"),
    output_redacted: v.output.slice(0, OUTPUT_MAX),
    validated_at: opts.validatedAt,
  }));
}
