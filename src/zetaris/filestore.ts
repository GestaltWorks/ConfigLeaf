// The Zetaris filestore: where npm run zetaris:setup puts the files the LESSONS and RULES sources read, inside the
// driver container, through docker. On Windows docker runs in the WSL distribution (wsl.exe -d <distro> -e docker ...,
// as lab/up.sh and the nginx validator reach it; -e passes argv as given, where -- would hand it to bash); elsewhere
// docker is on the PATH. Each file goes in on stdin: `docker exec -i <container> sh -c 'mkdir -p <dir> && cat >
// <dir>/<name>.tmp && mv ... && wc -c < ...'`, so no host path crosses into WSL and a reader never sees half a file;
// the byte count the container reports must equal the bytes sent.
//
// Measured 25 Oct 2026 on 2.4.3.1: the driver container (zetaris-driver-1) mounts the customer-data volume at
// /home/zetaris/customer-data, ZETARIS_LOCAL_FILE_SYTEM_ROOT_PATH is its shared/ directory, and CREATE LIGHTNING
// FILESTORE TABLE takes the absolute path inside the container. FORMAT JSON reads a file as one JSON document: a
// newline-delimited ledger gave 1 row (its first entry) with and without multiLine "false"; the same entries as one
// JSON array gave 23 rows, one per element. FORMAT TEXT gives one row per file (type, format, path, modifiedat,
// sizeinbytes, preview). So every file written here is one JSON array of flat objects.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Inside the driver container: the shared root of the local file system, then the agent's own directory. */
export const FILESTORE_DIR = "/home/zetaris/customer-data/shared/drift-agent";
const NAME = /^[a-z][a-z0-9_-]*\.json$/;

export interface FilestoreTarget {
  /** The Zetaris driver container (ZETARIS_DRIVER_CONTAINER, default zetaris-driver-1). */
  container: string;
  /** The WSL distribution docker runs in on Windows (ZETARIS_WSL_DISTRO, default Ubuntu-24.04). */
  distro: string;
}

export function targetFromProcess(): FilestoreTarget {
  return { container: process.env.ZETARIS_DRIVER_CONTAINER?.trim() || "zetaris-driver-1", distro: process.env.ZETARIS_WSL_DISTRO?.trim() || "Ubuntu-24.04" };
}

/** The command line that runs docker with these arguments on this platform. */
export function dockerArgv(args: readonly string[], t: FilestoreTarget, platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? ["wsl.exe", "-d", t.distro, "-e", "docker", ...args] : ["docker", ...args];
}

export interface PutResult { path: string; bytes: number }

/** Put the files into FILESTORE_DIR, each whole or not at all. Throws with docker's own stderr when a copy fails or the byte count differs. */
export function putFiles(files: Readonly<Record<string, string>>, t: FilestoreTarget = targetFromProcess()): PutResult[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(t.container)) throw new Error(`ZETARIS_DRIVER_CONTAINER must be a container name, got ${JSON.stringify(t.container)}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(t.distro)) throw new Error(`ZETARIS_WSL_DISTRO must be a distribution name, got ${JSON.stringify(t.distro)}`);
  return Object.entries(files).map(([name, text]) => {
    if (!NAME.test(name)) throw new Error(`a filestore file name is [a-z0-9_-].json, got ${JSON.stringify(name)}`);
    const dest = `${FILESTORE_DIR}/${name}`;
    const body = Buffer.from(text, "utf8");
    const [cmd, ...argv] = dockerArgv(["exec", "-i", t.container, "sh", "-c", `mkdir -p ${FILESTORE_DIR} && cat > ${dest}.tmp && mv ${dest}.tmp ${dest} && wc -c < ${dest}`], t);
    const r = spawnSync(cmd, argv, { input: body, encoding: "utf8", windowsHide: true, timeout: 60_000 });
    if (r.error) throw new Error(`docker could not start for ${dest}: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`docker exec ${t.container} failed for ${dest} (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    const bytes = Number(r.stdout.trim().split(/\s+/).at(-1));
    if (bytes !== body.length) throw new Error(`${dest} holds ${r.stdout.trim()} bytes after the copy, ${body.length} were sent`);
    return { path: dest, bytes };
  });
}

// ---- freshness: the copy the file tables read, against the store and the policy file it was made from -------------
//
// The LESSONS and RULES file tables read the copies above, so a lesson `npm run answer` records reaches Zetaris only
// when the files go in again. Each copy records the sha256 of what it put (the container, the directory, each file's
// name and text) in COPY_STATE_FILE; refreshFiles builds the files again, and when their hash differs from the one
// recorded it puts them and records the new hash, which the live pass does before the Decider's DQ read over
// drift_usl.adoption and npm run answer does after it writes the store. Measured 25 Oct 2026 23:24 UTC: the setup's
// copy of the three files, 27,987, 9,994 and 4,554 bytes, in 511 ms.

/** The hash of the last copy into the filestore, under .world/, which .gitignore keeps out of the repository. */
export const COPY_STATE_FILE = fileURLToPath(new URL("../../.world/filestore-copy.json", import.meta.url));

/** The sha256 of a copy: the container, FILESTORE_DIR, then each file's name and text in name order. */
export function filesHash(files: Readonly<Record<string, string>>, t: FilestoreTarget = targetFromProcess()): string {
  const h = createHash("sha256").update(`${t.container}\0${FILESTORE_DIR}\0`);
  for (const name of Object.keys(files).sort()) h.update(`${name}\0${files[name]}\0`);
  return `sha256:${h.digest("hex")}`;
}

/** What a copy recorded: its hash, its instant and each file's path and byte count. */
export interface CopyState { hash: string; at: string; files: PutResult[] }

/** The state the last copy recorded; null when there is none or it does not parse. */
export function readCopyState(file: string = COPY_STATE_FILE): CopyState | null {
  if (!existsSync(file)) return null;
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Partial<CopyState>;
    return typeof s.hash === "string" ? { hash: s.hash, at: String(s.at ?? ""), files: Array.isArray(s.files) ? s.files : [] } : null;
  } catch {
    return null;
  }
}

/** Record a whole copy, written to a temporary file and renamed, so a reader sees the old state or the new. */
export function recordCopy(state: CopyState, file: string = COPY_STATE_FILE): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** current: the hash equals the last copy's, nothing put; refreshed: the files went in and the hash is recorded; failed: the reason, nothing recorded. */
export type Refresh =
  | { status: "current"; hash: string; ms: number }
  | { status: "refreshed"; hash: string; previous: string | null; put: PutResult[]; ms: number }
  | { status: "failed"; error: string; ms: number };

export interface RefreshDeps {
  /** The files, by name, as JSON text (src/zetaris/setup.ts filestoreFiles over DRIFT_MEMORY_DIR and DRIFT_POLICY_FILE). */
  files: () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  /** Default: putFiles to the target. */
  put?: (files: Readonly<Record<string, string>>) => PutResult[];
  /** Default: COPY_STATE_FILE. */
  stateFile?: string;
  target?: FilestoreTarget;
  now?: () => Date;
}

/** Put the files when their hash differs from the last copy's, then record it. Returns a failure, never throws: the Decider recalls from the store itself. */
export async function refreshFiles(deps: RefreshDeps): Promise<Refresh> {
  const t0 = Date.now();
  try {
    const target = deps.target ?? targetFromProcess();
    const stateFile = deps.stateFile ?? COPY_STATE_FILE;
    const files = await deps.files();
    const hash = filesHash(files, target);
    const previous = readCopyState(stateFile)?.hash ?? null;
    if (previous === hash) return { status: "current", hash, ms: Date.now() - t0 };
    const put = (deps.put ?? ((f) => putFiles(f, target)))(files);
    recordCopy({ hash, at: (deps.now?.() ?? new Date()).toISOString(), files: put }, stateFile);
    return { status: "refreshed", hash, previous, put, ms: Date.now() - t0 };
  } catch (e) {
    return { status: "failed", error: ((e as Error).message ?? String(e)).replace(/\s+/g, " ").trim().slice(0, 300), ms: Date.now() - t0 };
  }
}

/** "file tables current", "file tables refreshed: lessons.json 9,876 bytes, ...", or "file tables not refreshed: <why>". */
export function refreshText(r: Refresh): string {
  if (r.status === "current") return "file tables current";
  if (r.status === "failed") return `file tables not refreshed: ${r.error}`;
  return `file tables refreshed: ${r.put.map((p) => `${p.path.slice(p.path.lastIndexOf("/") + 1)} ${p.bytes} bytes`).join(", ")}`;
}
