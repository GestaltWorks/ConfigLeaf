// The vault: the copies the assurance layer restores from. One git repository per (tenant, host alias) at
// <DRIFT_VAULT_DIR>/<tenant>/<alias> holding the files a collection run fetched at their real paths
// without the leading slash (etc/nginx/nginx.conf, etc/nginx/conf.d/<name>.conf), and one per tenant at
// <DRIFT_VAULT_DIR>/<tenant>/cloudflare holding <zone>/<record_id>.json per record of a DNS run. Each
// repository also holds .drift/paths.json (real path -> the redacted object id the observation rows
// carry, keys sorted) and, for a host, .drift/links.json (sites-enabled symlink path -> target path,
// keys sorted). The vault holds raw bytes and real names, on the operator's machine, outside this
// repository; what leaves it is commit hashes, counts and redacted object ids.
//
// Contract:
//   commitRun   one commit per completed collection run: the work tree is cleared down to .git and
//               written again from the run, so the tree mirrors the run (a file absent from the run is
//               absent from the commit), then `git add -A` and `git commit --allow-empty`, so an unchanged
//               run has its commit too, with the parent's tree. Message "run <run_id> <surface>
//               <started_at>", author and committer drift-agent <drift-agent@localhost>, both dated the
//               run's started_at, so the same run over the same parent gives the same commit hash. A run
//               already committed (its message in the log) returns that commit after its blobs are read
//               back and match. Every blob is read back after the commit and its sha256 compared with the
//               bytes handed in. Returns the vault_copy rows: copy_id = stableId("copy", run_id,
//               object_id), blob_sha256 = sha256:<hex> of the exact bytes (for a host file, the `file`
//               observation's value_hash), taken_at = the run's started_at, source "collector". A run
//               whose status is other than complete is refused.
//   repository  created when absent with `git init -q`, local user.name, user.email, core.autocrlf=false
//               and commit.gpgsign=false (an unattended commit), and .git/info/attributes "* -text
//               -filter -ident" so git stores and returns the bytes exactly whatever the global config
//               says. Before any write, git's own top level from the repository directory must be that
//               directory: every vault call stays inside its own repository.
//   paths       a tree path is the real path without its leading slash; it is refused when a segment is
//               empty, "." or "..", holds a control character or one of <>:"|?*\, ends in a dot or a
//               space, is a reserved device name, or the path starts at .git or .drift; two paths equal
//               under case folding are refused where the file system folds case (win32, darwin).
//   root        DRIFT_VAULT_DIR, absolute, outside this repository's checkout. Vault.fromEnv() is null when
//               it is blank: the vault is off. On win32 a repository directory over MAX_WIN32_REPO_DIR (246)
//               characters is refused, and git runs with core.longpaths (git.ts, measured there).
//   readTree    every file of one commit (one `git cat-file --batch`), with paths.json and links.json
//               parsed: what a validator materialises and a restore reads. treeOf(copy) finds the
//               repository of a vault_copy row by its commit (repoOf) and reads that tree.
//   status      per repository: commits, the head commit, its date and run id, the file count (outside
//               .drift/) and the redacted object ids at the head.
//
// Measured 24 Oct 2026, git 2.52 for Windows, the sites-enabled fixture (10 files): the first commitRun of a
// repository, init and configuration included, 630 ms; the next 360 ms.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, redact } from "../config.ts";
import { copyId, type CollectionRun, type VaultCopy } from "../data/rows.ts";
import { Redactor } from "../redactor.ts";
import { MAX_WIN32_REPO_DIR, VaultError, discoverTopLevel, git, initRepo } from "./git.ts";

export { VaultError };

export const VAULT_AUTHOR = { name: "drift-agent", email: "drift-agent@localhost" } as const;
/** The repository name a tenant's Cloudflare records live under, beside its host aliases. */
export const CLOUDFLARE_REPO = "cloudflare";
export const DRIFT_DIR = ".drift";
export const PATHS_FILE = `${DRIFT_DIR}/paths.json`;
export const LINKS_FILE = `${DRIFT_DIR}/links.json`;
export const ATTRIBUTES = "* -text -filter -ident\n";

/** A tenant id or a host alias as a directory name: the config's alias shape, without a trailing dot. */
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/;
const BAD_CHAR = /[\u0000-\u001f\u007f<>:"|?*\\]/;
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const FOLDS_CASE = process.platform === "win32" || process.platform === "darwin";
/** This checkout, which the vault root must lie outside of. */
const CHECKOUT = fileURLToPath(new URL("../..", import.meta.url));

/** One file of a run: its real path (absolute on a host; <zone>/<record_id>.json for a record), the redacted object id its rows carry, its bytes. */
export interface VaultFile { path: string; objectId: string; bytes: Uint8Array }

export interface CommitInput {
  tenantId: string;
  /** The host alias, or CLOUDFLARE_REPO. */
  repo: string;
  run: Pick<CollectionRun, "run_id" | "surface" | "host" | "started_at" | "status">;
  files: readonly VaultFile[];
  /** The sites-enabled symlink map, written as .drift/links.json; absent for a Cloudflare run. */
  links?: Readonly<Record<string, string>>;
}

export interface VaultCommit {
  /** <tenant>/<repo>. */
  repo: string;
  /** The full commit hash. */
  commit: string;
  /** The run was committed before: this is its commit, and nothing was written. */
  reused: boolean;
  files: number;
  added: number;
  modified: number;
  removed: number;
  copies: VaultCopy[];
}

export interface VaultTree {
  commit: string;
  /** Tree path -> bytes, every file outside .drift/. */
  files: Map<string, Buffer>;
  /** Real path -> redacted object id. */
  paths: Record<string, string>;
  /** Symlink path -> target path, both real; {} when the repository records none. */
  links: Record<string, string>;
}

export interface RepoStatus {
  tenant: string;
  repo: string;
  commits: number;
  head: string | null;
  /** The head commit's date, ISO 8601 UTC (the run's started_at to the second). */
  headDate: string | null;
  /** The run id the head commit's message names. */
  headRun: string | null;
  files: number;
  objectIds: string[];
}

export const sha256 = (b: Uint8Array): string => `sha256:${createHash("sha256").update(b).digest("hex")}`;

/** JSON with every object's keys in code-unit order, two-space indent, trailing newline. */
export function stableJson(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort(codeUnit).map((k) => [k, sort((x as Record<string, unknown>)[k])]));
    return x;
  };
  return `${JSON.stringify(sort(v), null, 2)}\n`;
}

const codeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The commit message of one run; the vault finds a run's commit by it. */
export const commitMessage = (run: Pick<CollectionRun, "run_id" | "surface" | "started_at">): string => `run ${run.run_id} ${run.surface} ${run.started_at}`;

/** A real path as a tree path: the leading slashes dropped, every segment checked (see the header). */
export function treePath(real: string): string {
  const rel = real.replace(/^\/+/, "");
  const segs = rel.split("/");
  const bad = !rel || segs.some((s) => s === "" || s === "." || s === ".." || BAD_CHAR.test(s) || /[. ]$/.test(s) || DEVICE.test(s));
  if (bad || segs[0] === ".git" || segs[0] === DRIFT_DIR || segs.some((s) => s.toLowerCase() === ".git")) throw new VaultError(`a path the vault cannot hold (${segs.length} segment(s))`);
  return rel;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const r = path.resolve(p);
    const real = existsSync(r) ? realpathSync.native(r) : r;
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  return norm(a) === norm(b);
}

function inside(child: string, parent: string): boolean {
  const fold = (p: string): string => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(fold(parent), fold(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export class Vault {
  readonly root: string;

  constructor(root: string, private readonly redactor: Redactor) {
    if (!path.isAbsolute(root)) throw new VaultError("DRIFT_VAULT_DIR must be an absolute path");
    if (inside(root, CHECKOUT)) throw new VaultError("DRIFT_VAULT_DIR lies inside this checkout; the vault holds raw bytes and real names and lives outside the repository");
    this.root = path.resolve(root);
  }

  /** The vault at DRIFT_VAULT_DIR (or `dir`), or null when it is blank: the vault is off. */
  static fromEnv(opts: { redactor?: Redactor; dir?: string } = {}): Vault | null {
    const dir = (opts.dir ?? config.vaultDir).trim();
    if (!dir) return null;
    return new Vault(dir, opts.redactor ?? new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords));
  }

  repoDir(tenantId: string, repo: string): string {
    if (!NAME.test(tenantId)) throw new VaultError("tenant id must be [A-Za-z0-9._-], up to 64, as a directory name");
    if (!NAME.test(repo)) throw new VaultError("repository name must be an ssh alias shape ([A-Za-z0-9._-], up to 64)");
    const dir = path.join(this.root, tenantId, repo);
    if (process.platform === "win32" && dir.length > MAX_WIN32_REPO_DIR) throw new VaultError(`the repository directory is ${dir.length} characters; git for Windows enters at most ${MAX_WIN32_REPO_DIR}, so DRIFT_VAULT_DIR needs a shorter path`);
    return dir;
  }

  /** git's stderr through the redactor before it reaches a message. */
  private readonly scrub = (s: string): string => this.redactor.text(redact(s));

  private git(dir: string, args: readonly string[], opts: Parameters<typeof git>[2] = {}) {
    return git(dir, args, { scrub: this.scrub, ...opts });
  }

  /** The repository directory, created and configured when absent, and checked to be its own top level. */
  private open(tenantId: string, repo: string, create: boolean): string {
    const dir = this.repoDir(tenantId, repo);
    if (!existsSync(path.join(dir, ".git"))) {
      if (!create) throw new VaultError(`no vault repository ${tenantId}/${repo}`);
      mkdirSync(path.dirname(dir), { recursive: true });
      initRepo(dir, { scrub: this.scrub });
      for (const [k, v] of [["user.name", VAULT_AUTHOR.name], ["user.email", VAULT_AUTHOR.email], ["core.autocrlf", "false"], ["commit.gpgsign", "false"]]) {
        this.git(dir, ["config", "--local", k, v]);
      }
      mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
      writeFileSync(path.join(dir, ".git", "info", "attributes"), ATTRIBUTES);
    }
    const top = discoverTopLevel(dir);
    if (top === null || !samePath(top, dir)) throw new VaultError(`vault repository ${tenantId}/${repo} is not its own top level`);
    return dir;
  }

  private head(dir: string): string | null {
    const r = this.git(dir, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true });
    return r.status === 0 ? r.stdout.toString("utf8").trim() : null;
  }

  /** Commits from the head back, newest first: [hash, subject]. */
  private log(dir: string): [string, string][] {
    if (!this.head(dir)) return [];
    return this.git(dir, ["log", "--format=%H%x09%s", "HEAD"]).stdout.toString("utf8").split("\n").filter(Boolean).map((l) => {
      const i = l.indexOf("\t");
      return [l.slice(0, i), l.slice(i + 1)];
    });
  }

  /** Blobs of one commit by tree path, through one `git cat-file --batch`. */
  private blobs(dir: string, commit: string, paths: readonly string[]): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    if (!paths.length) return out;
    const buf = this.git(dir, ["cat-file", "--batch"], { input: paths.map((p) => `${commit}:${p}\n`).join("") }).stdout;
    let off = 0;
    for (const p of paths) {
      const nl = buf.indexOf(0x0a, off);
      const header = buf.subarray(off, nl).toString("utf8");
      const m = header.match(/^[0-9a-f]{40,64} blob (\d+)$/);
      if (!m) throw new VaultError(`commit ${commit.slice(0, 12)} holds no blob at one of its ${paths.length} path(s)`);
      const size = Number(m[1]);
      out.set(p, buf.subarray(nl + 1, nl + 1 + size));
      off = nl + 1 + size + 1;
    }
    return out;
  }

  private treePaths(dir: string, commit: string): string[] {
    return this.git(dir, ["ls-tree", "-r", "-z", "--name-only", commit]).stdout.toString("utf8").split("\0").filter(Boolean);
  }

  /** Added, modified and removed paths of one commit against its parent, .drift/ left out. */
  private changes(dir: string, commit: string): { added: number; modified: number; removed: number } {
    const parts = this.git(dir, ["diff-tree", "-r", "--root", "--no-commit-id", "--no-renames", "--name-status", "-z", commit]).stdout.toString("utf8").split("\0").filter(Boolean);
    const out = { added: 0, modified: 0, removed: 0 };
    for (let i = 0; i + 1 < parts.length; i += 2) {
      if (parts[i + 1].startsWith(`${DRIFT_DIR}/`)) continue;
      if (parts[i] === "A") out.added++;
      else if (parts[i] === "D") out.removed++;
      else out.modified++;
    }
    return out;
  }

  /** One commit per completed run (see the header). */
  commitRun(input: CommitInput): VaultCommit {
    const { run } = input;
    if (run.status !== "complete") throw new VaultError(`run ${run.run_id} is ${run.status}; the vault commits complete runs only`);
    const entries = input.files.map((f) => ({ ...f, tree: treePath(f.path) }));
    const seen = new Set<string>();
    const objects = new Set<string>();
    for (const e of entries) {
      const key = FOLDS_CASE ? e.tree.toLowerCase() : e.tree;
      if (seen.has(key)) throw new VaultError(`run ${run.run_id}: two files share one tree path${FOLDS_CASE ? " under case folding" : ""} (${e.objectId})`);
      if (objects.has(e.objectId)) throw new VaultError(`run ${run.run_id}: two files share the object id ${e.objectId}`);
      seen.add(key);
      objects.add(e.objectId);
    }
    const dir = this.open(input.tenantId, input.repo, true);
    const label = `${input.tenantId}/${input.repo}`;
    const existing = this.log(dir).find(([, s]) => s.startsWith(`run ${run.run_id} `))?.[0];

    let commit: string;
    if (existing) {
      commit = existing;
    } else {
      for (const name of readdirSync(dir)) if (name !== ".git") rmSync(path.join(dir, name), { recursive: true, force: true });
      for (const e of entries) {
        const target = path.join(dir, ...e.tree.split("/"));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, e.bytes);
      }
      mkdirSync(path.join(dir, DRIFT_DIR), { recursive: true });
      writeFileSync(path.join(dir, ...PATHS_FILE.split("/")), stableJson(Object.fromEntries(entries.map((e) => [e.path, e.objectId]))));
      if (input.links) writeFileSync(path.join(dir, ...LINKS_FILE.split("/")), stableJson(input.links));
      const when = `@${Math.floor(Date.parse(run.started_at) / 1000)} +0000`;
      const who = { GIT_AUTHOR_NAME: VAULT_AUTHOR.name, GIT_AUTHOR_EMAIL: VAULT_AUTHOR.email, GIT_COMMITTER_NAME: VAULT_AUTHOR.name, GIT_COMMITTER_EMAIL: VAULT_AUTHOR.email, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
      this.git(dir, ["add", "-A"]);
      this.git(dir, ["commit", "-q", "--allow-empty", "-m", commitMessage(run)], { env: who });
      commit = this.head(dir)!;
    }

    const blobs = this.blobs(dir, commit, entries.map((e) => e.tree));
    for (const e of entries) {
      if (sha256(blobs.get(e.tree)!) !== sha256(e.bytes)) throw new VaultError(`${label}: commit ${commit.slice(0, 12)} holds other bytes for ${e.objectId}${existing ? ` (run ${run.run_id} was committed before)` : ""}`);
    }
    const copies: VaultCopy[] = entries.map((e) => ({
      copy_id: copyId(run.run_id, e.objectId), tenant_id: input.tenantId, surface: run.surface, host: run.host, object_id: e.objectId,
      run_id: run.run_id, git_commit: commit, blob_sha256: sha256(e.bytes), taken_at: run.started_at, source: "collector",
    })).sort((a, b) => codeUnit(a.copy_id, b.copy_id));
    return { repo: label, commit, reused: existing !== undefined, files: entries.length, ...this.changes(dir, commit), copies };
  }

  /** Every file of one commit (default the head) with paths.json and links.json parsed. */
  readTree(tenantId: string, repo: string, commit = "HEAD"): VaultTree {
    const dir = this.open(tenantId, repo, false);
    const hash = this.git(dir, ["rev-parse", "--verify", "-q", `${commit}^{commit}`]).stdout.toString("utf8").trim();
    const all = this.treePaths(dir, hash);
    const blobs = this.blobs(dir, hash, all);
    const json = (p: string): Record<string, string> => (blobs.has(p) ? JSON.parse(blobs.get(p)!.toString("utf8")) as Record<string, string> : {});
    const files = new Map([...blobs].filter(([p]) => !p.startsWith(`${DRIFT_DIR}/`)));
    return { commit: hash, files, paths: json(PATHS_FILE), links: json(LINKS_FILE) };
  }

  /** The tenant's repository that holds this commit, or null: how a vault_copy row (tenant_id, git_commit) finds its repository. */
  repoOf(tenantId: string, commit: string): string | null {
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new VaultError("a commit is 40 or 64 lowercase hex");
    const base = path.join(this.root, tenantId);
    if (!NAME.test(tenantId) || !existsSync(base)) return null;
    for (const repo of readdirSync(base).filter((n) => NAME.test(n)).sort(codeUnit)) {
      if (!existsSync(path.join(base, repo, ".git"))) continue;
      const dir = this.open(tenantId, repo, false);
      if (this.git(dir, ["cat-file", "-e", `${commit}^{commit}`], { allowFail: true }).status === 0) return repo;
    }
    return null;
  }

  /** The tree a vault_copy row points at: its repository found by commit, then readTree. */
  treeOf(copy: Pick<VaultCopy, "tenant_id" | "git_commit">): VaultTree & { repo: string } {
    const repo = this.repoOf(copy.tenant_id, copy.git_commit);
    if (!repo) throw new VaultError(`no repository of ${copy.tenant_id} holds commit ${copy.git_commit.slice(0, 12)}`);
    return { ...this.readTree(copy.tenant_id, repo, copy.git_commit), repo };
  }

  /** The commit that holds one run, or null. */
  commitOf(tenantId: string, repo: string, runId: string): string | null {
    const dir = this.open(tenantId, repo, false);
    return this.log(dir).find(([, s]) => s.startsWith(`run ${runId} `))?.[0] ?? null;
  }

  /** Every repository under the root, tenant then repository name. */
  status(): RepoStatus[] {
    if (!existsSync(this.root)) return [];
    const dirs = (p: string): string[] => readdirSync(p).filter((n) => NAME.test(n) && statSync(path.join(p, n)).isDirectory()).sort(codeUnit);
    const out: RepoStatus[] = [];
    for (const tenant of dirs(this.root)) {
      for (const repo of dirs(path.join(this.root, tenant))) {
        if (!existsSync(path.join(this.root, tenant, repo, ".git"))) continue;
        const dir = this.open(tenant, repo, false);
        const log = this.log(dir);
        const head = log[0]?.[0] ?? null;
        let headDate: string | null = null;
        let files = 0;
        let objectIds: string[] = [];
        if (head) {
          headDate = new Date(this.git(dir, ["log", "-1", "--format=%cI", head]).stdout.toString("utf8").trim()).toISOString();
          const paths = this.treePaths(dir, head);
          files = paths.filter((p) => !p.startsWith(`${DRIFT_DIR}/`)).length;
          if (paths.includes(PATHS_FILE)) objectIds = [...new Set(Object.values(JSON.parse(this.blobs(dir, head, [PATHS_FILE]).get(PATHS_FILE)!.toString("utf8")) as Record<string, string>))].sort(codeUnit);
        }
        const headRun = log[0]?.[1].match(/^run (\S+) /)?.[1] ?? null;
        out.push({ tenant, repo, commits: log.length, head, headDate, headRun, files, objectIds });
      }
    }
    return out;
  }
}
