// git for the vault: every call is spawnSync("git", ["-C", <repo>, ...args]) with the arguments as an
// array (a path is one argument whatever it holds) and the repository pinned by GIT_DIR and
// GIT_WORK_TREE in the child's environment, so a call reaches the repository it names and that one only.
// Variables that point git at another repository, index or object store (STRIPPED) are removed from the
// child's environment first.
//
// Contract: git() returns stdout as bytes and throws VaultError on a non-zero exit unless allowFail; the
// message carries git's stderr only through the caller's scrub function (the vault passes its redactor,
// because git names the real paths it fails on). initRepo() is `git init -q -- <dir>` with the pinning
// variables absent, so git lays out <dir>/.git itself. discoverTopLevel() asks git, with nothing pinned,
// which work tree a directory belongs to: the vault's guard that a repository directory is its own.

import { spawnSync } from "node:child_process";
import path from "node:path";

export class VaultError extends Error {}

export interface GitResult { stdout: Buffer; stderr: string; status: number }

export interface GitOptions {
  input?: string | Buffer;
  /** Extra environment for this call (author, committer, dates). */
  env?: Readonly<Record<string, string>>;
  /** Return a non-zero exit as a result. */
  allowFail?: boolean;
  /** What git's stderr becomes in a thrown message; without one the message names the command and the exit status. */
  scrub?: (s: string) => string;
}

/** Environment variables that redirect git to another repository, index or object store. */
export const STRIPPED = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR",
  "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_PREFIX",
] as const;

function childEnv(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of STRIPPED) delete env[k];
  return { ...env, GIT_TERMINAL_PROMPT: "0", ...extra };
}

function run(label: string, args: readonly string[], env: NodeJS.ProcessEnv, opts: GitOptions): GitResult {
  const r = spawnSync("git", [...args], { env, input: opts.input, maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (r.error) throw new VaultError(`git ${label}: ${r.error.message}`);
  const out: GitResult = { stdout: r.stdout, stderr: r.stderr.toString("utf8"), status: r.status ?? -1 };
  if (out.status !== 0 && !opts.allowFail) {
    const why = opts.scrub && out.stderr.trim() ? `: ${opts.scrub(out.stderr.trim()).slice(0, 400)}` : "";
    throw new VaultError(`git ${label} exited ${out.status}${why}`);
  }
  return out;
}

/**
 * On win32 every call carries `-c core.longpaths=true`. Measured 24 Oct 2026, git 2.52 for Windows: without it
 * `git add` of a file whose full path passed 260 characters (a 220-character repository directory, a 54-character
 * file name) exited 128 "Filename too long"; with it the same add and commit succeeded. The repository directory
 * itself is bounded either way: 246 characters worked, 248 failed at `git init` (MAX_WIN32_REPO_DIR).
 */
export const PLATFORM_CONFIG: readonly string[] = process.platform === "win32" ? ["-c", "core.longpaths=true"] : [];

/** The longest repository directory git for Windows entered in the measurement above. */
export const MAX_WIN32_REPO_DIR = 246;

/** One git call inside the repository at `dir` (its work tree; the repository is `<dir>/.git`). */
export function git(dir: string, args: readonly string[], opts: GitOptions = {}): GitResult {
  const abs = path.resolve(dir);
  return run(args[0] ?? "", ["-C", abs, ...PLATFORM_CONFIG, ...args], childEnv({ GIT_DIR: path.join(abs, ".git"), GIT_WORK_TREE: abs, ...opts.env }), opts);
}

/** `git init -q -- <dir>`, with no variable pinning a repository. */
export function initRepo(dir: string, opts: GitOptions = {}): void {
  run("init", [...PLATFORM_CONFIG, "init", "-q", "--", path.resolve(dir)], childEnv(opts.env ?? {}), opts);
}

/** The work tree git itself finds from `dir` (`rev-parse --show-toplevel`, no variable pinning a repository), or null when `dir` is in none. */
export function discoverTopLevel(dir: string): string | null {
  const r = run("rev-parse", ["-C", path.resolve(dir), ...PLATFORM_CONFIG, "rev-parse", "--show-toplevel"], childEnv({}), { allowFail: true });
  return r.status === 0 ? r.stdout.toString("utf8").trim() : null;
}
