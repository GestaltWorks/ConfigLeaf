// The nginx-t validator: whether a vault copy of one host's nginx tree can be restored. The tree is the
// files of one vault commit at their real paths without the leading slash (etc/nginx/nginx.conf,
// etc/nginx/conf.d/<name>.conf) plus the symlinks the collector listed (.drift/links.json). It is written to
// a temp directory the way a restore would lay it down, each symlink a copy of its target file, and
// `nginx -t` runs over it in a container through DRIFT_NGINX_T, {dir} standing for the temp etc/nginx
// (config.ts nginxTCommand: docker run of nginx:1.27, through wsl.exe -d Ubuntu-24.04 on Windows, where
// {dir} and every mount source take their /mnt/<drive>/ form).
//
// Contract:
//   - Pre-seeding, before round 1: the tree is parsed (src/collectors/nginx.ts analyse from
//     etc/nginx/nginx.conf, the links as the symlinks it expands; parse over every file the entry
//     reaches, every block walked). Every dependency it names that the tree does not hold gets a
//     placeholder of its kind before the first nginx -t and is listed as a missing dependency: an include
//     analyse records as unresolved (a named file, never a glob, which nginx accepts empty), and the
//     absolute path argument of ssl_certificate, ssl_certificate_key, ssl_trusted_certificate,
//     ssl_client_certificate, proxy_ssl_certificate, proxy_ssl_certificate_key,
//     proxy_ssl_trusted_certificate, ssl_dhparam, access_log and error_log. A log file in a directory the
//     image holds (IMAGE_LOG_DIRS) or under /dev, and a path outside the plain-path set (a variable, a
//     data: value), are left to nginx. The parse reads the files nginx.conf reaches, the ones nginx -t
//     loads; a .bak beside a live file and an unlinked site sit on disk outside that set.
//   - Rounds, at most MAX_ROUNDS (12), one nginx -t each, catch what parsing missed. Every path a round's
//     output names as missing (open() "<path>" failed (2: No such file or directory); cannot load
//     certificate [key] "<path>": BIO_new_file() failed; BIO_new_file("<path>") failed; any [emerg] line
//     quoting an absolute path next to "No such file") gets a placeholder of its kind, and the next round
//     runs. The kind is the directive that names the path in the tree, read at the file and line the
//     message points at, else on any line of the tree that carries the path: include -> an empty file;
//     ssl_certificate, ssl_certificate_key, ssl_trusted_certificate, ssl_client_certificate and their
//     proxy_ssl_ forms -> the self-signed pair made once per validation (openssl req -x509 -newkey rsa:2048
//     -nodes -days 1 -subj /CN=placeholder), one PEM holding the certificate and its key, which nginx reads
//     as either; ssl_dhparam -> the RFC 7919 ffdhe2048 group; access_log and error_log -> an empty file
//     mounted writable; anything else, and a path no directive of the tree names (a glob match, a dangling
//     link), -> an empty file. Pre-seeded placeholders take the same kinds.
//   - A placeholder or a tree file under /etc/nginx sits in the temp tree; one outside it is mounted into
//     the container file by file (-v <file>:<path>:ro) through {mounts} in the command, or right after
//     "docker run" / "podman run" when the command has no {mounts}.
//   - result: ok when no placeholder was needed and round 1 passes; ok_with_gaps when a round passes with
//     any placeholder in place, pre-seeded or named by a round; fail when a round refuses the configuration
//     with no new missing path (a syntax error, getpwnam, a directive the image lacks, a path named again
//     after its placeholder is in place), when a named path falls outside the plain-path character set,
//     when the tree holds no etc/nginx/nginx.conf (0 rounds), or when the last round still names a new
//     path. missing_dependencies is every pre-seeded path, every path nginx named as missing over the rounds
//     and every dangling link, sorted; output is the last round's "nginx: " lines.
//   - An output whose every line comes from the container runtime (docker absent, the image or the WSL
//     distro missing) makes validateNginxTree throw ValidateError ("the container runtime stopped before
//     nginx") and record nothing, since nginx never read the copy.
//   - Through wsl.exe, every path that reaches the command line is held to the plain-path set
//     [A-Za-z0-9._/@+=,:-], because wsl.exe -- hands the rest of its command line to bash (measured below);
//     any other command is spawned with its argv as given, no shell. A placeholder is written only for a
//     path of that set, whatever the command.
//   - The temp directory holds real bytes and is removed when the validation ends, pass or throw.
//   - Paths and output come back as nginx printed them; src/validate/vault.ts redacts them before anything
//     leaves the vault.
//
// Measured 24 Oct 2026 with the rounds alone, nginx:1.27 (Debian) in Docker Engine inside WSL
// Ubuntu-24.04, the tree mounted from /mnt/c (the image pulled beforehand): on
// test/fixtures/nginx-tree round 1 names /etc/letsencrypt/options-ssl-nginx.conf (open() failed, the
// include, at parse time), round 2 /etc/letsencrypt/live/host-aaaaaa.tld/fullchain.pem (cannot load
// certificate, at merge time), round 3 .../privkey.pem (cannot load certificate key), round 4 passes ("test
// is successful"): ok_with_gaps, 4 rounds, those 3 gaps, 2.9 s in all; nginx reads the one combined PEM as
// certificate and as key. With an ssl_dhparam line and an access_log in a directory the image lacks, the
// dhparam path fails as BIO_new_file("...") failed, the log as open() failed with no file and line (nginx -t
// opens the log files), the log mounted :ro then fails (30: Read-only file system) and mounted writable
// passes, and the ffdhe2048 PEM below loads. The image's entrypoint and the error log (a link to stderr)
// repeat each [emerg] line on the container's streams; only the "nginx: " lines count. `wsl.exe -d
// Ubuntu-24.04 -- echo '$HOME' 'a;b'` printed the home directory and ran b as a command, so `--` goes
// through bash; `-e` passes argv as given. The ffdhe2048 PEM decodes to the RFC 7919 prime with generator
// 2, and openssl dhparam -check reports it ok.
// Measured 24 Oct 2026 with pre-seeding (VALIDATE_LIVE=true npx vitest run test/validate.test.ts):
// test/fixtures/nginx-tree is ok_with_gaps in 1 round with those 3 gaps, all 3 read from the tree before
// round 1, 0.8 s; the same tree without its TLS vhost is ok in 1 round. Through the vault itself
// (src/vault Vault.commitRun, then validateVaultCommit) on the collector's sites-enabled fixture
// (test/fixtures/nginx/sites: 10 files, 4 sites-enabled links, three TLS vhosts): ok_with_gaps in 1
// round, 6 gaps (three certificate and key pairs), 1.1 s, the links read by nginx as copies. On the
// recorded bundle (sample/bundle.json) the enabled server blocks name 7 distinct ssl_certificate paths on
// the conf.d host and 5 on the sites-enabled host, and every TLS vhost there includes certbot's
// options-ssl-nginx.conf: dependencies the parse reads before round 1. Over the vault's latest commits
// (npm run validate:copies -- --dry-run, the same day): the conf.d host ok_with_gaps in 1 round with 16
// gaps, the sites-enabled host in 1 round with 13, 4.1 s with the Cloudflare repository. maxRounds
// (validate:copies --max-rounds) moves the cap.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyse, flatten, parse, type Directive } from "../collectors/nginx.ts";
import { nginxTCommand } from "../config.ts";
import type { ValidationResult } from "../data/rows.ts";

export const MAX_ROUNDS = 12;

/**
 * Directories nginx:1.27 holds, where nginx -t creates a log file itself, so a log path directly in one
 * needs no placeholder. Measured 24 Oct 2026 (ls -ld in the image): /var/log and /var/log/nginx exist,
 * and /var/log/nginx/access.log and error.log link to /dev/stdout and /dev/stderr.
 */
export const IMAGE_LOG_DIRS: readonly string[] = ["/var/log", "/var/log/nginx"];

/** The tree's nginx root, relative: the directory {dir} names and the container mounts at /etc/nginx. */
export const NGINX_ROOT = "etc/nginx";

/** RFC 7919 ffdhe2048 (prime and generator 2), the PEM an ssl_dhparam placeholder holds. */
export const FFDHE2048_PEM = `-----BEGIN DH PARAMETERS-----
MIIBCAKCAQEA//////////+t+FRYortKmq/cViAnPTzx2LnFg84tNpWp4TZBFGQz
+8yTnc4kmz75fS/jY2MMddj2gbICrsRhetPfHtXV/WVhJDP1H18GbtCFY2VVPe0a
87VXE15/V8k1mE8McODmi3fipona8+/och3xWKE2rec1MKzKT0g6eXq8CrGCsyT7
YdEIqUuyyOP7uWrat2DX9GgdT0Kj3jlN9K5W7edjcrsZCwenyO4KbXCeAvzhzffi
7MA0BM0oNC9hkXL+nOmFg/+OTxIy7vKBg8P+OxtMb61zO7X8vC7CIAXFjvGDfRaD
ssbzSibBsu/6iGtCOGEoXJf//////////wIBAg==
-----END DH PARAMETERS-----
`;

export class ValidateError extends Error {}

export type PlaceholderKind = "empty" | "pair" | "dhparam" | "log";

export interface Placeholder { path: string; kind: PlaceholderKind }

/** One file bound into the container: a host path and the absolute path nginx reads it at. */
export interface Mount { source: string; target: string; readOnly: boolean }

/** What a runner gets for one round: the temp etc/nginx ({dir}) and the files mounted beside it, as host paths. */
export interface NginxRun { round: number; dir: string; mounts: readonly Mount[] }

export interface RunnerOutput { exitCode: number; output: string }

export type NginxRunner = (run: NginxRun) => Promise<RunnerOutput>;

export interface NginxValidation {
  result: ValidationResult;
  /** Every path nginx named as missing, plus every dangling link, sorted; [] when none. */
  missing_dependencies: string[];
  /** The last round's "nginx: " lines. */
  output: string;
  rounds: number;
  /** One plain sentence: why the result is what it is. */
  reason: string;
  /** The placeholders the passing (or last) round ran with, sorted by path. */
  placeholders: Placeholder[];
}

export interface ValidateNginxOptions {
  /** Relative paths (a leading slash is dropped) to bytes. */
  tree: ReadonlyMap<string, Uint8Array>;
  /** Symlink path -> target path (absolute, or relative to the link's directory). */
  links?: ReadonlyMap<string, string>;
  runner?: NginxRunner;
  maxRounds?: number;
  /** The self-signed pair as one PEM (certificate then key); default opensslPair. Called at most once. */
  pair?: () => Promise<string>;
  /** Where the temp directory goes; default os.tmpdir(). */
  tmpRoot?: string;
}

const PLAIN = /^[A-Za-z0-9._/@+=,:-]+$/;
const PLAIN_ABSOLUTE = /^\/[A-Za-z0-9._/@+=,-]+$/;

/** A tree key: forward slashes, no leading slash, no empty, "." or ".." segment. Throws on anything else. */
export function treeKey(p: string): string {
  const k = p.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = k.split("/");
  if (!k || parts.some((s) => s === "" || s === "." || s === "..")) throw new ValidateError(`tree path must be a plain relative path, got ${JSON.stringify(p)}`);
  return k;
}

/** A dependency path nginx named that a placeholder may be written for: absolute, plain characters, no "." or ".." segment. */
export function isPlainAbsolute(p: string): boolean {
  return PLAIN_ABSOLUTE.test(p) && !p.split("/").slice(1).some((s) => s === "" || s === "." || s === "..");
}

/** C:\Users\x\Temp\d -> /mnt/c/Users/x/Temp/d; a POSIX path is returned as is. */
export function toWslPath(p: string): string {
  const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(p);
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`.replace(/\/+$/, "");
  if (p.startsWith("/")) return p;
  throw new ValidateError(`path has no WSL form: ${JSON.stringify(p)}`);
}

/** Split a command line on whitespace; single or double quotes group a token. */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(command); m; m = re.exec(command)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * The argv of one round: the command's tokens with {dir} replaced, the mounts spliced in at {mounts} or
 * after "docker run" / "podman run". On win32 a command whose program is wsl or wsl.exe gets every host
 * path in its /mnt/<drive>/ form. Throws when the command has no {dir}, when mounts are needed and the
 * command has no place for them, or when a substituted token leaves the plain-path set.
 */
export function nginxArgv(command: string, run: NginxRun, platform: NodeJS.Platform = process.platform): string[] {
  const tokens = splitCommand(command);
  if (!tokens.some((t) => t.includes("{dir}"))) throw new ValidateError("the nginx -t command has no {dir} placeholder (DRIFT_NGINX_T)");
  const wsl = platform === "win32" && /^wsl(?:\.exe)?$/i.test(path.win32.basename(tokens[0] ?? ""));
  const host = (p: string): string => (wsl ? toWslPath(p) : p);
  const plain = (t: string): string => {
    if (wsl && !PLAIN.test(t)) throw new ValidateError(`a path on the wsl.exe command line leaves the plain-path set: ${JSON.stringify(t)}`);
    return t;
  };
  const dir = plain(host(run.dir));
  const mountTokens = run.mounts.flatMap((m) => ["-v", plain(`${host(m.source)}:${m.target}${m.readOnly ? ":ro" : ""}`)]);
  const argv = tokens.filter((t) => t !== "{mounts}" || mountTokens.length > 0).flatMap((t) => (t === "{mounts}" ? mountTokens : [t.replaceAll("{dir}", dir)]));
  if (tokens.includes("{mounts}") || mountTokens.length === 0) return argv;
  const i = argv.findIndex((t, k) => /^(?:docker|podman)(?:\.exe)?$/i.test(path.basename(t)) && argv[k + 1] === "run");
  if (i < 0) throw new ValidateError("a dependency outside /etc/nginx needs a mount, and the nginx -t command has neither {mounts} nor docker run (DRIFT_NGINX_T)");
  argv.splice(i + 2, 0, ...mountTokens);
  return argv;
}

/** A runner over a command line (default DRIFT_NGINX_T or the platform's): spawns it, stdout and stderr collected, 180 s per round. */
export function commandRunner(command: string = nginxTCommand(), platform: NodeJS.Platform = process.platform, timeoutMs = 180_000): NginxRunner {
  return (run) => {
    const [program, ...args] = nginxArgv(command, run, platform);
    return new Promise((resolve, reject) => {
      const child = spawn(program, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.on("data", (b: Buffer) => out.push(b));
      child.stderr.on("data", (b: Buffer) => err.push(b));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new ValidateError(`could not start ${path.basename(program)}: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const text = (bs: Buffer[]) => Buffer.concat(bs).toString("utf8").replace(/\0/g, "");
        resolve({ exitCode: code ?? 1, output: [text(err), text(out)].filter((s) => s.trim()).join("\n") });
      });
    });
  };
}

/** The lines nginx itself printed ("nginx: ..."); the runtime's own lines (wsl:, docker:, the entrypoint) are left out. */
export function nginxLines(output: string): string[] {
  return output.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.startsWith("nginx: "));
}

const MISSING: readonly RegExp[] = [
  /open\(\) "([^"]+)" failed \(2: No such file or directory\)/,
  /cannot load certificate(?: key)? "([^"]+)": BIO_new_file\(\) failed.*no such file/i,
  /BIO_new_file\("([^"]+)"\) failed.*no such file/i,
  /\[emerg\].*?"(\/[^"]+)".*no such file or directory/i,
];

/** Every path the nginx lines name as missing, in the order named. */
export function missingPaths(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    for (const re of MISSING) {
      const m = re.exec(l);
      if (m && !out.includes(m[1])) out.push(m[1]);
      if (m) break;
    }
  }
  return out;
}

const PAIR_DIRECTIVES = new Set([
  "ssl_certificate", "ssl_certificate_key", "ssl_trusted_certificate", "ssl_client_certificate",
  "proxy_ssl_certificate", "proxy_ssl_certificate_key", "proxy_ssl_trusted_certificate",
]);

/** The directive that carries `p` on one config line: the first word of the statement the path sits in. */
function directiveOn(line: string, p: string): string | null {
  const at = line.indexOf(p);
  if (at < 0) return null;
  const statement = line.slice(0, at).split(/[;{}]/).pop() ?? "";
  return statement.trim().split(/\s+/)[0]?.toLowerCase() || null;
}

/** The placeholder kind for a missing path: the directive naming it (at the line the message points at, else anywhere in the tree), else the message. */
export function placeholderKind(p: string, line: string, tree: ReadonlyMap<string, Uint8Array>): PlaceholderKind {
  const texts = new Map<string, string[]>();
  const linesOf = (k: string): string[] => {
    let v = texts.get(k);
    if (!v) texts.set(k, (v = Buffer.from(tree.get(k) ?? new Uint8Array()).toString("utf8").split(/\r?\n/)));
    return v;
  };
  let directive: string | null = null;
  const at = / in (\/\S+):(\d+)\s*$/.exec(line);
  if (at && tree.has(treeKey(at[1]))) directive = directiveOn(linesOf(treeKey(at[1]))[Number(at[2]) - 1] ?? "", p);
  for (const k of [...tree.keys()].sort()) {
    if (directive) break;
    for (const l of linesOf(k)) if ((directive = directiveOn(l, p))) break;
  }
  if (directive === "ssl_dhparam") return "dhparam";
  if (directive && PAIR_DIRECTIVES.has(directive)) return "pair";
  if (directive === "access_log" || directive === "error_log") return "log";
  if (directive === "include") return "empty";
  return /cannot load certificate/.test(line) ? "pair" : "empty";
}

/**
 * One self-signed pair as one PEM (certificate, then key): openssl req -x509 -newkey rsa:2048 -nodes
 * -days 1 -subj /CN=placeholder, openssl from PATH (Git for Windows, WSL, Ubuntu CI) or, on win32, Git for
 * Windows' own copies. The key never leaves the temp directory it is written to, which is removed.
 */
export async function opensslPair(tmpRoot: string = os.tmpdir()): Promise<string> {
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const candidates = ["openssl", ...(process.platform === "win32" ? [path.join(pf, "Git", "mingw64", "bin", "openssl.exe"), path.join(pf, "Git", "usr", "bin", "openssl.exe")] : [])];
  const dir = mkdtempSync(path.join(tmpRoot, "drift-pair-"));
  try {
    const key = path.join(dir, "key.pem");
    const cert = path.join(dir, "cert.pem");
    for (const bin of candidates) {
      if (bin !== "openssl" && !existsSync(bin)) continue;
      const r = spawnSync(bin, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=placeholder", "-keyout", key, "-out", cert], { windowsHide: true, encoding: "utf8" });
      if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (r.status === 0 && existsSync(cert) && existsSync(key)) return `${readFileSync(cert, "utf8").trimEnd()}\n${readFileSync(key, "utf8").trimEnd()}\n`;
      throw new ValidateError(`openssl req failed (exit ${r.status}): ${(r.stderr ?? "").trim().split(/\r?\n/).slice(-1)[0] ?? ""}`);
    }
    throw new ValidateError("openssl was found neither on PATH nor in Git for Windows; the certificate placeholder needs it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isNginx = (k: string): boolean => k === NGINX_ROOT || k.startsWith(`${NGINX_ROOT}/`);

/** Resolve a link target against the link's directory; an absolute target is taken as given. */
function linkTarget(link: string, target: string): string {
  const t = target.replace(/\\/g, "/");
  return treeKey(t.startsWith("/") ? t : path.posix.join(path.posix.dirname(link), t));
}

/** The directives whose first argument names a file nginx -t opens, by the placeholder kind it gets. */
const DEPENDENCY_KIND: ReadonlyMap<string, PlaceholderKind> = new Map<string, PlaceholderKind>([
  ...[...PAIR_DIRECTIVES].map((d) => [d, "pair"] as [string, PlaceholderKind]),
  ["ssl_dhparam", "dhparam"], ["access_log", "log"], ["error_log", "log"],
]);

/** Every directive of a parsed file, every block walked, in file order. */
function* walk(dirs: readonly Directive[]): Generator<Directive> {
  for (const d of flatten(dirs)) {
    yield d;
    if (d.block) yield* walk(d.block);
  }
}

/** A log path nginx -t creates itself: a device, or a file directly in a directory the image holds. */
const imageHoldsLog = (p: string): boolean => p.startsWith("/dev/") || IMAGE_LOG_DIRS.includes(path.posix.dirname(p));

/**
 * The dependencies the tree names and does not hold, read before round 1 (see the header): the unresolved
 * named includes of the files nginx.conf reaches, and the path argument of every DEPENDENCY_KIND directive
 * in those files. Sorted by path; the first directive to name a path sets its kind.
 */
export function seededDependencies(tree: ReadonlyMap<string, Uint8Array>, links: ReadonlyMap<string, string> = new Map()): Placeholder[] {
  const files = new Map<string, string>();
  for (const [k, v] of tree) files.set(`/${treeKey(k)}`, Buffer.from(v).toString("utf8"));
  const absLinks = new Map<string, string>();
  for (const [l, t] of links) {
    const k = treeKey(l);
    absLinks.set(`/${k}`, `/${linkTarget(k, t)}`);
  }
  const analysis = analyse(files, { links: absLinks });
  if (!analysis.entry_found) return [];
  const reached = new Set(analysis.loaded);
  const out = new Map<string, PlaceholderKind>();
  const need = (p: string, kind: PlaceholderKind): void => {
    if (out.has(p) || !isPlainAbsolute(p) || tree.has(treeKey(p))) return;
    if (kind === "log" && imageHoldsLog(p)) return;
    out.set(p, kind);
  };
  for (const u of analysis.unresolved) if (u.matched === undefined && reached.has(u.file) && !/[*?[]/.test(u.pattern)) need(u.pattern, "empty");
  for (const file of [...reached].sort()) {
    for (const d of walk(parse(files.get(file) ?? "", file))) {
      const kind = DEPENDENCY_KIND.get(d.name);
      const arg = d.args[0];
      if (kind && arg && arg.startsWith("/")) need(arg, kind);
    }
  }
  return [...out].map(([p, kind]) => ({ path: p, kind })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Validate one nginx tree; see the module header for the contract. */
export async function validateNginxTree(opts: ValidateNginxOptions): Promise<NginxValidation> {
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new ValidateError(`maxRounds must be a positive integer, got ${maxRounds}`);
  const tree = new Map<string, Uint8Array>();
  for (const [k, v] of opts.tree) tree.set(treeKey(k), v);
  const done = (result: ValidationResult, rounds: number, reason: string, missing: Iterable<string>, output: string, placeholders: Iterable<Placeholder>): NginxValidation => ({
    result, rounds, reason, output,
    missing_dependencies: [...new Set(missing)].sort(),
    placeholders: [...placeholders].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  });
  if (!tree.has(`${NGINX_ROOT}/nginx.conf`)) return done("fail", 0, "the tree holds no etc/nginx/nginx.conf", [], "", []);

  const runner = opts.runner ?? commandRunner();
  const tmp = mkdtempSync(path.join(opts.tmpRoot ?? os.tmpdir(), "drift-nginx-t-"));
  try {
    const dir = path.join(tmp, ...NGINX_ROOT.split("/"));
    mkdirSync(dir, { recursive: true });
    const mounts: Mount[] = [];
    const write = (k: string, bytes: Uint8Array | string, readOnly = true): void => {
      const file = path.join(tmp, ...k.split("/"));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      if (!isNginx(k)) mounts.push({ source: file, target: `/${k}`, readOnly });
    };
    for (const [k, v] of [...tree].sort(([a], [b]) => (a < b ? -1 : 1))) write(k, v);

    const placed = new Map<string, Placeholder>();
    const missing = new Set<string>();
    for (const [link, target] of [...(opts.links ?? new Map<string, string>())].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const k = treeKey(link);
      if (tree.has(k)) continue;
      const t = linkTarget(k, target);
      const bytes = tree.get(t);
      if (bytes) {
        write(k, bytes);
      } else {
        write(k, "");
        placed.set(`/${k}`, { path: `/${k}`, kind: "empty" });
        missing.add(`/${k}`);
      }
    }

    let pem: Promise<string> | undefined;
    const pair = (): Promise<string> => (pem ??= (opts.pair ?? (() => opensslPair(opts.tmpRoot)))());
    const content = async (kind: PlaceholderKind): Promise<string> => (kind === "pair" ? await pair() : kind === "dhparam" ? FFDHE2048_PEM : "");
    // pre-seeding: what the tree names and does not hold, in place before the first nginx -t
    let seeded = 0;
    for (const s of seededDependencies(tree, new Map([...(opts.links ?? new Map<string, string>())].map(([l, t]) => [treeKey(l), t] as [string, string])))) {
      if (placed.has(s.path)) continue;
      write(treeKey(s.path), await content(s.kind), s.kind !== "log");
      placed.set(s.path, s);
      missing.add(s.path);
      seeded++;
    }
    let output = "";
    for (let round = 1; round <= maxRounds; round++) {
      const r = await runner({ round, dir, mounts: [...mounts] });
      const lines = nginxLines(r.output);
      if (!lines.length) throw new ValidateError(`the container runtime stopped before nginx: ${r.output.trim().split(/\r?\n/).filter((l) => !l.startsWith("wsl: ")).slice(0, 3).join(" | ").slice(0, 400) || `exit ${r.exitCode}, no output`}`);
      output = lines.join("\n");
      if (r.exitCode === 0 && lines.some((l) => l.includes("test is successful"))) {
        return placed.size === 0
          ? done("ok", round, "nginx -t passed on the tree as restored", missing, output, placed.values())
          : done("ok_with_gaps", round, `nginx -t passed in round ${round} with ${placed.size} placeholder(s) for dependencies outside the copy (${seeded} read from the tree before round 1, ${placed.size - seeded} named by nginx or by a dangling link)`, missing, output, placed.values());
      }
      const named = missingPaths(lines);
      for (const p of named) missing.add(p);
      const fresh = named.filter((p) => !placed.has(p) && !tree.has(treeKey(p)));
      if (fresh.length === 0) {
        const again = named.length > 0;
        return done("fail", round, again ? "nginx named a dependency again after its placeholder was in place" : "nginx refused the configuration", missing, output, placed.values());
      }
      const unsafe = fresh.find((p) => !isPlainAbsolute(p));
      if (unsafe !== undefined) return done("fail", round, "nginx named a dependency whose path leaves the plain-path set; no placeholder was written", missing, output, placed.values());
      if (round === maxRounds) return done("fail", round, `the round cap (${maxRounds}) was reached with dependencies still missing`, missing, output, placed.values());
      for (const p of fresh) {
        const line = lines.find((l) => l.includes(`"${p}"`)) ?? "";
        const kind = placeholderKind(p, line, tree);
        write(treeKey(p), await content(kind), kind !== "log");
        placed.set(p, { path: p, kind });
      }
    }
    return done("fail", maxRounds, `the round cap (${maxRounds}) was reached`, missing, output, placed.values());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
