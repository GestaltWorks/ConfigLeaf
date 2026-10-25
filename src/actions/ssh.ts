// The write session: one nginx file on one host set to its approved copy, in one SSH session (ssh -o
// BatchMode=yes -o ConnectTimeout=15 [-F <LINUX_SSH_CONFIG>] <alias> bash -s, the collector's sshArgv) with the
// write script on stdin.
// The read collector's script (src/collectors/linux.ts) stays read-only; this script is the one place sudo appears.
//
// Contract:
//   writeScript   the script for one file. Its inputs are the real path (from the vault's .drift/paths.json),
//                 the bytes of the approved copy and of the previous state (both from vault commits) and their
//                 sha256; no text from the database reaches it. The path must sit under /etc/nginx/ in the
//                 characters [A-Za-z0-9._@+/-] with no "." or ".." segment, and is single-quoted with any single
//                 quote escaped. Steps, each printed as a marker line "@@DRIFT@@ <KEY> <value>" or a section
//                 "@@DRIFT@@ BEGIN <name>" ... "@@DRIFT@@ END <exit status>": LINK when the path is a symlink;
//                 BEFORE, the live file's sha256 ("absent", "unreadable"); CHANGED when it differs from the
//                 previous state the vault holds, and nothing is written; the section `write`, the copy decoded
//                 from a base64 heredoc through `sudo -n tee <path> >/dev/null`; WRITTEN, the file's sha256 after;
//                 the sections `nginx-t` (sudo -n nginx -t) and `reload` (sudo -n systemctl reload nginx); on a
//                 failed write that changed the file, a refused nginx -t, a failed reload or a written hash other
//                 than the copy's, the section `restore` writes the previous bytes back the same way (or removes
//                 the file the copy created, when the previous state is absent) and RESTORED gives the hash after;
//                 AFTER, the file's sha256 once the reload passed; DONE last.
//   parseSession  the session's stdout as those markers and sections; `complete` only with DONE.
//   runWriteSession  the session itself, through the alias only when LINUX_HOSTS lists it; 120 s timeout.
//
// Measured 24 Oct 2026: `bash -n` (GNU bash 5.2) accepts the scripts the tests generate, with and without previous
// bytes (test/actions.test.ts, when bash is on PATH); the production hosts had received 0 write sessions.
// Measured 25 Oct 2026 at 05:22 and 05:28 UTC against the lab estate (lab/README.md, Debian bookworm, sudo 1.9.13p3):
// two sessions ran write, nginx-t and reload at exit 0, each AFTER equal to the copy's sha256.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { HOSTS, MARK, sshArgv } from "../collectors/linux.ts";

export class WriteSessionError extends Error {}

/** A real path the write script accepts: absolute, under /etc/nginx/, plain characters, no "." or ".." segment. */
export const NGINX_PATH = /^\/etc\/nginx\/(?:[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*\/)*[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*$/;

export const hex256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** One shell word, single-quoted, any single quote closed, escaped and reopened. */
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** base64 at 76 characters a line: a heredoc body whose alphabet never holds a quote or the delimiter. */
function base64Lines(b: Uint8Array): string {
  const s = Buffer.from(b).toString("base64");
  const out: string[] = [];
  for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
  return out.join("\n");
}

export interface WriteInput {
  /** The real path, from the vault's paths.json. */
  path: string;
  /** The approved copy's bytes, from the vault commit the Decider named. */
  copy: Uint8Array;
  /** The previous state, from the vault commit of the run the disposition decided on; null when the file is absent there. */
  previous: Uint8Array | null;
}

/** The write script for one file (see the header). Throws WriteSessionError on a path outside the accepted shape. */
export function writeScript(input: WriteInput): string {
  if (!NGINX_PATH.test(input.path) || input.path.split("/").some((s) => s === "." || s === "..")) {
    throw new WriteSessionError("the write script takes a path under /etc/nginx/ in [A-Za-z0-9._@+/-] only");
  }
  const expect = input.previous === null ? "absent" : hex256(input.previous);
  const putPrevious = input.previous === null
    ? `put_previous() { sudo -n rm -f -- "$P"; }`
    : `put_previous() {\nbase64 -d <<'DRIFT_PREVIOUS' | sudo -n tee -- "$P" >/dev/null\n${base64Lines(input.previous)}\nDRIFT_PREVIOUS\n}`;
  return `# drift-agent write session: one file set to its approved copy, nginx -t, reload; the previous bytes go back on any failure.
set -u -o pipefail
export LC_ALL=C TZ=UTC PATH=/usr/sbin:/usr/bin:/sbin:/bin
P=${shQuote(input.path)}
EXPECT='${expect}'
COPY='${hex256(input.copy)}'
mark() { printf '${MARK} %s\\n' "$*"; }
hash_of() { if [ ! -e "$P" ]; then printf 'absent\\n'; elif [ ! -r "$P" ]; then printf 'unreadable\\n'; else sha256sum -- "$P" | cut -d' ' -f1; fi; }
section() { name=$1; shift; mark BEGIN "$name"; out=$("$@" 2>&1); rc=$?; printf '%s\\n' "$out"; mark END "$rc"; return "$rc"; }
put_copy() {
base64 -d <<'DRIFT_COPY' | sudo -n tee -- "$P" >/dev/null
${base64Lines(input.copy)}
DRIFT_COPY
}
${putPrevious}
restore() { section restore put_previous; mark RESTORED "$(hash_of)"; }
if [ -L "$P" ]; then mark LINK; mark DONE; exit 0; fi
before=$(hash_of)
mark BEFORE "$before"
if [ "$before" != "$EXPECT" ]; then mark CHANGED; mark DONE; exit 0; fi
if ! section write put_copy; then
  if [ "$(hash_of)" != "$before" ]; then restore; fi
  mark DONE; exit 0
fi
written=$(hash_of)
mark WRITTEN "$written"
if [ "$written" != "$COPY" ]; then restore; mark DONE; exit 0; fi
if ! section nginx-t sudo -n nginx -t; then restore; mark DONE; exit 0; fi
if ! section reload sudo -n systemctl reload nginx; then restore; mark DONE; exit 0; fi
mark AFTER "$(hash_of)"
mark DONE
`;
}

export interface SessionSection { name: string; rc: number; output: string }

export interface ParsedSession {
  /** The DONE marker arrived: the script ran to its end. */
  complete: boolean;
  link: boolean;
  changed: boolean;
  before: string | null;
  written: string | null;
  restored: string | null;
  after: string | null;
  sections: SessionSection[];
}

/** The session's stdout as markers and sections (see the header). */
export function parseSession(stdout: string): ParsedSession {
  const out: ParsedSession = { complete: false, link: false, changed: false, before: null, written: null, restored: null, after: null, sections: [] };
  let open: { name: string; lines: string[] } | null = null;
  for (const line of stdout.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.startsWith(`${MARK} `)) {
      open?.lines.push(line);
      continue;
    }
    const [key, ...rest] = line.slice(MARK.length + 1).split(" ");
    const value = rest.join(" ").trim();
    if (key === "BEGIN") open = { name: value, lines: [] };
    else if (key === "END" && open) {
      out.sections.push({ name: open.name, rc: Number(value), output: open.lines.join("\n").trim() });
      open = null;
    } else if (key === "BEFORE") out.before = value;
    else if (key === "WRITTEN") out.written = value;
    else if (key === "RESTORED") out.restored = value;
    else if (key === "AFTER") out.after = value;
    else if (key === "CHANGED") out.changed = true;
    else if (key === "LINK") out.link = true;
    else if (key === "DONE") out.complete = true;
  }
  return out;
}

export interface SessionResult { stdout: string; stderr: string; code: number | null }

/** Runs one script over one alias; the tests hand in a fake host. */
export type SshRunner = (alias: string, script: string) => Promise<SessionResult>;

/** The session over the operator's ssh alias, which LINUX_HOSTS must list; the script goes in on stdin. */
export const runWriteSession: SshRunner = (alias, script) => {
  if (!HOSTS[alias]) return Promise.reject(new WriteSessionError(`unknown host alias: ${alias}; allowed: ${Object.keys(HOSTS).join(", ")}`));
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", sshArgv(alias), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), code });
    });
    child.stdin.on("error", () => { /* the close event carries the outcome */ });
    child.stdin.end(script);
  });
};
