// Linux collector over read-only SSH. One session per host (ssh -o BatchMode=yes -o ConnectTimeout=15
// <alias> bash -s) with READ_SCRIPT on stdin: a fixed list of reads that prints delimited sections. The
// aliases are the operator's own ssh_config entries, configured with each host's export folder in
// LINUX_HOSTS (HOSTS); nothing else is reachable. Nothing in the script writes, restarts, installs or
// escalates: a path the login user cannot read comes back as a section with a non-zero exit status and
// is recorded as not readable. The ops/ forced command runs the same reads.
//
// Contract, in order:
//   fetchHost     streams the script, collects stdout; ssh's own stderr is redacted before it is traced.
//   parseStream   sections -> Fetched: login user, hostname, clock, global IPv4 and IPv6 addresses, the
//                 three vhost directory listings (symlink targets kept), every fetched file as bytes
//                 (base64 on the wire so sha256 of what we hold equals sha256sum on the host), systemd
//                 timers, the backup export folder (listing, mtimes and sha256 of readable nginx copies,
//                 and the sha256 of every regular-file member of the newest tarball that holds etc/nginx,
//                 read through tar -xO), certbot renewal configs. A stream without the DONE marker is
//                 incomplete: the run is partial.
//   toRows        Fetched -> rows (src/collectors/types.ts), everything through the Redactor first:
//                 collection_run with expected_count asserted BEFORE parsing (regular files the ls of
//                 conf.d and sites-available showed, minus credential-shaped names the script never
//                 reads), observed_count = those actually fetched, status complete | partial | failed:
//                 partial also when a vhost file was fetched but nginx.conf was not, because without the
//                 entry file nothing can say which blocks are served (every .enabled is "unknown" and
//                 http.real_ip is "unknown"), and the gate must hold such a run back.
//                 observation rows: one `file` row per fetched nginx file (value_hash = sha256 of the
//                 bytes, so it compares with the export copy's sha256sum; a sites-enabled symlink is not
//                 a file of its own, its target is) and, per server block,
//                 server[<first server_name>:<port>].server_name / .server_name[<name>] (refers_to
//                 dns_name) / .server_name[<name>].zone (the name's last two labels, redacted: the
//                 zone a wildcard record would cover it from, which the pseudonym of the whole name
//                 cannot say) / .listen / .ssl_certificate (refers_to cert) / .root / .real_ip
//                 ("trusted:<n> header:<h> scope:<server|http>" or "absent") / .enabled /
//                 .location[<path>].proxy_pass (refers_to dns_name for a name, ip for an address,
//                 upstream for a block name; nothing for loopback) / .alias / .root; http.real_ip on
//                 nginx.conf (the http-level list every reached block inherits, "absent", or "unknown"
//                 when nginx.conf was not read); system.hostname (the machine's own name, displayed as
//                 its pseudonym); one timer[<unit>] row per systemd timer (value: the unit it
//                 activates). Every non-file value_hash is Redactor.fingerprint (HMAC-SHA256 under the
//                 tenant's salt): measured 24 Oct, plain sha256 let 138 guesses from the public zone
//                 names confirm 19 plaintexts behind the exported pseudonyms. inventory_asset per global
//                 IPv4 and IPv6 address (kind vps), except an IPv6 address whose line carries the
//                 temporary or deprecated flag (privacy extensions: such an address rotates out within a
//                 day); the summary lists those as ip6_left_out. mngtmpaddr and stable addresses stay.
//                 backup_snapshot (kind export) per config tarball in
//                 the export folder and per folder of plain copies, taken_at = its mtime; backup_item
//                 (`file`, sha256) for every regular-file member of the newest tarball (object id: the
//                 member's path below the tarball's root, the prefix its etc/nginx members sit under,
//                 with a leading slash: /etc/nginx/nginx.conf, /etc/letsencrypt/renewal/<name>.conf;
//                 a member outside the trees the script reads live files from, LIVE_PREFIXES, is stored
//                 as member-<16 hex>, a salted id of its redacted path, see backupMemberId)
//                 and every nginx file the plain copies hold, so changed_since_backup reads every file
//                 the collector fetches against the backup; a member hashed as the empty input (a
//                 symlink, or a 0-byte file) is dropped and listed in the summary, because a backup_item
//                 that equals no live file's bytes would make change_in_last_backup say a restore undoes
//                 every enabled site.
//                 approved_setting rows come from a technician's sign-off, scripts/approve.ts.
//                 toRows also returns the raw half for the vault (src/vault/): `files`, the bytes of
//                 every file that became a `file` row keyed by its real path, and `links`, the
//                 sites-enabled symlink map; collectHost passes both on in CollectResult, and printable()
//                 is the redacted half the collect script prints and writes.
//
// Host identity is the pseudonym of the ssh alias, not of the machine's hostname: measured 24 Oct, both
// production hosts report the same hostname, so the hostname is an observation (system.hostname) and
// the alias, which is the collector's key to the host, is the identity.
//
// Measured 24 Oct 2026 (survey and first dry runs, both hosts): nginx only; one host keeps vhosts in
// conf.d with dated .bak files beside them (plus a small sites-available), the other uses
// sites-enabled -> sites-available with .bak, .pre-symlink and unlinked files; both export server
// config nightly as server-config-<date>.tar.gz into a folder readable by the operator's login (one
// under /var/backups, one under the login's home: hence LINUX_HOSTS); no etckeeper, no restic on either.
// The tarballs list the sites-enabled symlinks as members: tar -xO prints nothing for a symlink, so an
// unfiltered member list hashed every enabled site as the empty input (nine such rows in the first export).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isIPv6 } from "node:net";
import path from "node:path/posix";
import { config, redact } from "../config.ts";
import { AUTHORITY, assetId, obsId, runId as runIdOf, snapshotId } from "../data/rows.ts";
import type { Store } from "../data/store.ts";
import type { Redactor } from "../redactor.ts";
import type { Tracer } from "../trace.ts";
import { DEFAULT_ENTRY, analyse, classifyTarget, isDnsName, isVhostPath, listenPort, type Analysis, type RealIp } from "./nginx.ts";
import { EMPTY_ROWS, type CollectedRows, type CollectionRunRow } from "./types.ts";

export class CollectorError extends Error {}

/**
 * The only hosts this collector reaches, by the operator's ssh_config alias, with where each exports its
 * config: LINUX_HOSTS in .env (alias=dir, comma-separated; src/config.ts parses and refuses anything the
 * script would not accept). Empty when unset: the collector then reaches nothing and says so.
 */
export const HOSTS: Readonly<Record<string, { exportDir: string }>> = config.linuxHosts;

export const SSH_ARGS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"] as const;
export const MARK = "@@DRIFT@@";

/** File names the script never reads and the population never counts: credentials and key material by name, case-insensitive on both sides. Mirrors the case pattern in the script and in ops/ssh/*, which lower-case the name first. */
export const CREDENTIAL_SHAPED = /htpasswd|passwd|api[-_]?key|secret|token|credential|\.(?:pem|key|crt|cer|csr|p12|pfx)$/i;

/** sha256 of the empty input: what tar -xO | sha256sum yields for a symlink member, and for a 0-byte file. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * The fixed read script. Each section is `@@DRIFT@@ BEGIN <kind> <arg>`, the command's stdout+stderr,
 * `@@DRIFT@@ END <exit status>`; the stream ends with `@@DRIFT@@ DONE`. File bodies are base64 (-w0) so
 * any bytes survive the line protocol. Files whose name looks like a credential or a key are never read
 * (status 3), whatever its case. Includes are followed up to four rounds, only under /etc/nginx, and a
 * symlink (sites-enabled/x) is never fetched as a file: its target is. The newest tarball in the export
 * folder that holds etc/nginx members (measured: two tarball families land 52 ms apart, so "the newest"
 * alone is not enough) has every regular-file member (`tar -tv` lines starting with '-': not the
 * symlinks, which tar -xO prints as nothing), whatever directory it sits in, hashed through `tar -xO`
 * (stdout only, nothing lands on disk); a credential-shaped member name is skipped; a tarball over 256 MB
 * is not opened.
 */
export function readScript(exportDir: string): string {
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(exportDir)) throw new CollectorError(`export dir must be an absolute path of [A-Za-z0-9._/-]: ${exportDir}`);
  return String.raw`# drift-agent Linux collector: enumerated reads only. Nothing here writes, restarts, installs or escalates.
export LC_ALL=C TZ=UTC PATH=/usr/sbin:/usr/bin:/sbin:/bin
NGX=/etc/nginx
EXP='${exportDir}'
section() { name=$1; arg=$2; shift 2; printf '@@DRIFT@@ BEGIN %s %s\n' "$name" "$arg"; "$@" 2>&1; printf '\n@@DRIFT@@ END %s\n' "$?"; }
credential_shaped() {
  case $(basename -- "$1" | tr 'A-Z' 'a-z') in
    *htpasswd*|*passwd*|*api-key*|*api_key*|*apikey*|*secret*|*token*|*credential*|*.pem|*.key|*.crt|*.cer|*.csr|*.p12|*.pfx) return 0 ;;
  esac
  return 1
}
emit_file() {
  if credential_shaped "$1"; then printf '@@DRIFT@@ BEGIN file %s\ncredential-shaped name, not read\n@@DRIFT@@ END 3\n' "$1"; return; fi
  section file "$1" base64 -w0 -- "$1"
}
emitted=' '
emit_once() { case $emitted in *" $1 "*) return ;; esac; emitted="$emitted$1 "; emit_file "$1"; }
member_hashes() {
  tar -tvzf "$1" | grep '^-' | sed -E 's/^[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +//' | grep -v '/$' | while IFS= read -r m; do
    if credential_shaped "$m"; then continue; fi
    h=$(tar -xOzf "$1" "$m" 2>/dev/null | sha256sum | cut -d' ' -f1)
    printf '%s  %s\n' "$h" "$m"
  done
}
section whoami '' id -un
section hostname '' hostname
section date '' date -u +%Y-%m-%dT%H:%M:%SZ
section ip4 '' ip -4 -o addr show scope global
section ip6 '' ip -6 -o addr show scope global
for d in $NGX/conf.d $NGX/sites-available $NGX/sites-enabled; do section ls "$d" ls -l --time-style=full-iso -- "$d"; done
emit_once $NGX/nginx.conf
for f in $NGX/conf.d/* $NGX/sites-available/*; do [ -f "$f" ] && [ ! -L "$f" ] && emit_once "$f"; done
round=0
while [ $round -lt 4 ]; do
  round=$((round+1)); added=0
  pats=$(for f in $emitted; do [ -f "$f" ] && grep -hoE '^[[:space:]]*include[[:space:]]+[^;]+' -- "$f"; done 2>/dev/null | sed -E "s/^[[:space:]]*include[[:space:]]+//; s/[\"']//g" | sort -u)
  for pat in $pats; do
    case $pat in /*) ;; *) pat=$NGX/$pat ;; esac
    case $pat in $NGX/*) ;; *) continue ;; esac
    for f in $pat; do
      [ -f "$f" ] || continue
      [ ! -L "$f" ] || continue
      case $emitted in *" $f "*) continue ;; esac
      emit_once "$f"; added=1
    done
  done
  [ $added -eq 1 ] || break
done
section timers '' systemctl list-timers --all --no-pager
section lsd "$EXP" ls -ld --time-style=full-iso -- "$EXP"
section ls "$EXP" ls -l --time-style=full-iso -- "$EXP"
section find "$EXP" find "$EXP" -maxdepth 6 -readable \( -type f -o -type d \) -path '*nginx*' -printf '%TY-%Tm-%TdT%TH:%TM:%TS%Tz\t%y\t%p\n'
section sha256 "$EXP" find "$EXP" -maxdepth 6 -type f -readable -path '*nginx*' -exec sha256sum -- {} +
newest=
for t in $(ls -1t -- "$EXP"/*.tar.gz "$EXP"/*.tgz 2>/dev/null); do
  [ -r "$t" ] || continue
  [ "$(stat -c %s -- "$t")" -le 268435456 ] || continue
  if tar -tzf "$t" 2>/dev/null | grep -qE '(^|/)etc/nginx/'; then newest=$t; break; fi
done
if [ -n "$newest" ]; then section tarsha "$newest" member_hashes "$newest"; fi
section renewals /etc/letsencrypt/renewal find /etc/letsencrypt/renewal -maxdepth 1 -name '*.conf' -readable
for f in $(find /etc/letsencrypt/renewal -maxdepth 1 -name '*.conf' -readable 2>/dev/null); do emit_once "$f"; done
printf '@@DRIFT@@ DONE\n'
`;
}

export interface SshResult { stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; latencyMs: number }

/** One SSH session: the alias must be in HOSTS; the script goes in on stdin; stdout is the stream. */
export function fetchHost(alias: string, opts: { timeoutMs?: number } = {}): Promise<SshResult> {
  const spec = HOSTS[alias];
  if (!spec) throw new CollectorError(`unknown host alias: ${alias}; allowed: ${Object.keys(HOSTS).join(", ")}`);
  const script = readScript(spec.exportDir);
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn("ssh", [...SSH_ARGS, alias, "bash", "-s"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), code, signal, latencyMs: Date.now() - t0 });
    });
    child.stdin.on("error", () => { /* the close event carries the outcome */ });
    child.stdin.end(script);
  });
}

// ---- the stream -------------------------------------------------------------------------------------

export interface Section { kind: string; arg: string; rc: number; body: string }
export interface LsEntry { type: string; mode: string; size: number; mtime: string | null; name: string; target: string | null }
export interface FindEntry { mtime: string | null; type: string; path: string }
export interface TimerEntry { unit: string; activates: string }
export interface HashEntry { sha256: string; path: string }
export type FetchedFile = { ok: true; bytes: Uint8Array } | { ok: false; rc: number; error: string };
export interface Listing { rc: number; entries: LsEntry[]; error: string | null }

export interface Fetched {
  complete: boolean;
  login_user: string | null;
  hostname: string | null;
  server_time: string | null;
  ip4: string[];
  /** Global IPv6 addresses, link-local (fe80::/10) left out whatever the scope flag says, temporary and deprecated ones left out too (ip6_left_out). */
  ip6: string[];
  /** The global IPv6 addresses whose line carries the temporary or deprecated flag, each with the flags of its line. */
  ip6_left_out: Ipv6Line[];
  listings: Record<string, Listing>;
  files: Record<string, FetchedFile>;
  timers: { rc: number; entries: TimerEntry[]; error: string | null } | null;
  export_dir: {
    dir: string;
    rc: number;
    mtime: string | null;
    listing: Listing | null;
    found: FindEntry[];
    hashes: HashEntry[];
    /** The regular-file members of the newest config tarball that holds etc/nginx, hashed on the host; null when there was none to read. */
    tar: { path: string; rc: number; hashes: HashEntry[]; error: string | null } | null;
    error: string | null;
  } | null;
  renewals: { rc: number; paths: string[]; error: string | null } | null;
  sections: Section[];
}

/** "2026-10-23 03:40:02.123456789 +0000" (ls full-iso) or "2026-10-23T03:40:02.1234567890+0000" (find %T) -> canonical ISO ms, else null. */
export function fullIsoToIso(s: string): string | null {
  const m = s.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s?([+-])(\d{2}):?(\d{2})$/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}.${(m[3] ?? "").slice(0, 3).padEnd(3, "0")}${m[4]}${m[5]}:${m[6]}`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const LS_LINE = /^([-dlcbps])([rwxsStT-]{9}[.+@]?)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? [+-]\d{4})\s+(.*)$/;

export function parseLs(body: string): LsEntry[] {
  const out: LsEntry[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(LS_LINE);
    if (!m) continue;
    let name = m[5];
    let target: string | null = null;
    if (m[1] === "l") {
      const i = name.indexOf(" -> ");
      if (i >= 0) { target = name.slice(i + 4); name = name.slice(0, i); }
    }
    out.push({ type: m[1], mode: m[1] + m[2], size: Number(m[3]), mtime: fullIsoToIso(m[4]), name, target });
  }
  return out;
}

function parseTimers(body: string): TimerEntry[] {
  return body.split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^NEXT\s/.test(l) && !/timers? listed\.?$/.test(l) && !/^Pass --all/.test(l))
    .map((l) => { const p = l.split(/\s+/); return { unit: p.at(-2) ?? "", activates: p.at(-1) ?? "" }; })
    .filter((t) => t.unit.endsWith(".timer"));
}

const parseHashes = (body: string): HashEntry[] => [...body.matchAll(/^([0-9a-f]{64}) [ *](.+)$/gm)].map((m) => ({ sha256: m[1], path: m[2] }));
const trimNl = (s: string): string => s.replace(/\n+$/, "");
const listingOf = (s: Section): Listing => ({ rc: s.rc, entries: s.rc === 0 ? parseLs(s.body) : [], error: s.rc === 0 ? null : trimNl(s.body) });

export interface Ipv6Line { address: string; flags: string[] }

/**
 * One line of `ip -6 -o addr show scope global`: the address, lower-cased, and the words between the scope and
 * the lifetimes ("2: eth0    inet6 2001:db8::5/64 scope global temporary dynamic \       valid_lft 86123sec
 * preferred_lft 14123sec" -> ["temporary", "dynamic"]). Null for a line with no global address on it: no inet6,
 * link-local (fe80::/10) whatever scope the host printed, or text that is not an IPv6 address.
 */
export function ipv6Line(line: string): Ipv6Line | null {
  const m = line.match(/\binet6 ([0-9A-Fa-f:]+)\/\d+(.*)$/);
  if (!m) return null;
  const address = m[1].toLowerCase();
  if (!isIPv6(address) || /^fe[89ab][0-9a-f]:/i.test(address)) return null;
  const words = m[2].split(/\\|\bvalid_lft\b/)[0].trim().split(/\s+/).filter(Boolean);
  return { address, flags: words.filter((w, i) => w !== "scope" && words[i - 1] !== "scope") };
}

/** Privacy-extension addresses: the host rotates a temporary address out within a day and stops preferring a deprecated one. */
const TRANSIENT_IPV6 = new Set(["temporary", "deprecated"]);

export function parseStream(text: string): Fetched {
  const sections: Section[] = [];
  let cur: { kind: string; arg: string; body: string[] } | null = null;
  let complete = false;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith(`${MARK} `)) {
      const rest = line.slice(MARK.length + 1);
      if (rest.startsWith("BEGIN ")) {
        const [kind, ...arg] = rest.slice(6).split(" ");
        cur = { kind, arg: arg.join(" ").trim(), body: [] };
        continue;
      }
      if (rest.startsWith("END ") && cur) {
        const body = cur.body.join("\n").replace(/\n$/, "");
        sections.push({ kind: cur.kind, arg: cur.arg, rc: Number(rest.slice(4).trim()), body });
        cur = null;
        continue;
      }
      if (rest.trim() === "DONE") { complete = true; continue; }
    }
    if (cur) cur.body.push(line);
  }
  const one = (kind: string, arg?: string): Section | undefined => sections.find((s) => s.kind === kind && (arg === undefined || s.arg === arg));
  const firstLine = (s: Section | undefined): string | null => (s && s.rc === 0 && s.body.trim() ? s.body.trim().split("\n")[0].trim() : null);
  const f: Fetched = { complete, login_user: firstLine(one("whoami")), hostname: firstLine(one("hostname")), server_time: null, ip4: [], ip6: [], ip6_left_out: [], listings: {}, files: {}, timers: null, export_dir: null, renewals: null, sections };
  const date = one("date");
  if (date && date.rc === 0) f.server_time = fullIsoToIso(date.body.trim().replace(/Z$/, "+0000"));
  const ip = one("ip4");
  if (ip && ip.rc === 0) f.ip4 = [...new Set([...ip.body.matchAll(/\binet (\d{1,3}(?:\.\d{1,3}){3})\/\d+/g)].map((m) => m[1]))];
  const ip6 = one("ip6");
  if (ip6 && ip6.rc === 0) {
    const lines = ip6.body.split("\n").map(ipv6Line).filter((l): l is Ipv6Line => l !== null);
    const transient = (l: Ipv6Line): boolean => l.flags.some((w) => TRANSIENT_IPV6.has(w));
    f.ip6 = [...new Set(lines.filter((l) => !transient(l)).map((l) => l.address))];
    f.ip6_left_out = lines.filter(transient);
  }
  const lsd = one("lsd");
  const expDir = lsd?.arg ?? null;
  for (const s of sections.filter((x) => x.kind === "ls" && x.arg !== expDir)) f.listings[s.arg] = listingOf(s);
  for (const s of sections.filter((x) => x.kind === "file")) {
    f.files[s.arg] = s.rc === 0 ? { ok: true, bytes: new Uint8Array(Buffer.from(s.body.replace(/\s+/g, ""), "base64")) } : { ok: false, rc: s.rc, error: trimNl(s.body) };
  }
  const timers = one("timers");
  if (timers) f.timers = { rc: timers.rc, entries: timers.rc === 0 ? parseTimers(timers.body) : [], error: timers.rc === 0 ? null : trimNl(timers.body) };
  if (lsd && expDir) {
    const listing = one("ls", expDir);
    const found = one("find", expDir);
    const sha = one("sha256", expDir);
    const tar = one("tarsha");
    f.export_dir = {
      dir: expDir,
      rc: lsd.rc,
      mtime: lsd.rc === 0 ? parseLs(lsd.body)[0]?.mtime ?? null : null,
      listing: listing ? listingOf(listing) : null,
      found: found ? [...found.body.matchAll(/^(\S+)\t([a-z])\t(.+)$/gm)].map((m) => ({ mtime: fullIsoToIso(m[1]), type: m[2], path: m[3] })) : [],
      hashes: sha ? parseHashes(sha.body) : [],
      tar: tar ? { path: tar.arg, rc: tar.rc, hashes: parseHashes(tar.body), error: tar.rc === 0 ? null : trimNl(tar.body) } : null,
      error: lsd.rc === 0 ? null : trimNl(lsd.body),
    };
  }
  const renewals = one("renewals");
  if (renewals) f.renewals = { rc: renewals.rc, paths: renewals.rc === 0 ? renewals.body.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/")) : [], error: renewals.rc === 0 ? null : trimNl(renewals.body) };
  return f;
}

// ---- redaction, then rows ------------------------------------------------------------------------------

export const SURFACE = "linux.nginx";
const SOURCE = "ssh";
const KIND_EXPORT = "export";
const TARBALL = /\.(?:tar\.gz|tgz|tar|tar\.(?:xz|zst|bz2))$/i;

export const sha256 = (data: string | Uint8Array): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;

/**
 * A sweep after the redactor for the dotted shapes its hosts pass leaves alone, measured on the real
 * hosts' files (24 Oct): a name glued to a suffix (`name.com_ecc` from acme.sh, `name.com-0001` from
 * certbot), a name followed by a dotted tail (`name.com.pre-symlink.<ts>`, `name.com.conf.<ts>.bak`),
 * and a wildcard (`*.name.com`; the pass refuses a name preceded by '.'). Each candidate is the longest
 * dotted run ending in a letters-only label whose next character is not alphanumeric and not '-' before
 * a letter (so `bluefin-logistics.com` is one label run and `com-0001` is a suffix); it is redacted on
 * its own with the public API, so the redactor's own rules decide (file extensions, reserved names, the
 * agent's vocabulary pass through) and the pseudonym equals the one the same name gets anywhere else.
 * When the redactor leaves the whole candidate alone because a date-like label sits inside it
 * (`name.com.conf.2026-04-01.bak`: an extension at the end, a tail it cannot read past), the candidate
 * is shortened a label at a time from the right, past the date-like labels only, and the tail is kept;
 * a reserved name (`www.portal.invalid`) has no such label and is never cut into. Redacting the output
 * again is a no-op.
 */
const DOTTED = /(?<![A-Za-z0-9._*-])(\*\.)?((?:[A-Za-z0-9_-]+\.)+[A-Za-z]{2,24})(?![A-Za-z0-9])(?!-[A-Za-z])/g;
const DATE_LABEL = /\.[0-9][0-9-]*(?:\.|$)/;

function sweep(r: Redactor, s: string): string {
  return s.replace(DOTTED, (m, star: string | undefined, name: string) => {
    let head = name;
    for (;;) {
      const red = r.text(head);
      if (red !== head) return `${star ?? ""}${red}${name.slice(head.length)}`;
      const i = DATE_LABEL.test(head) ? head.lastIndexOf(".") : -1;
      if (i < 0) return m;
      head = head.slice(0, i);
    }
  });
}

/** Free text (a file, a path, a listing line): the redactor, then the sweep. */
export function redactText(r: Redactor, s: string): string {
  return sweep(r, r.text(s));
}

/** One setting value: the redactor's value rule (a lone token-shaped value is a secret), then the sweep. */
export function redactValue(r: Redactor, s: string): string {
  return sweep(r, r.value(s));
}

/**
 * host-XXXXXX for a name, the same pseudonym the redactor gives it elsewhere: a dotted name redacts to
 * host-XXXXXX.<tld> and the first label is taken; a bare name is not a FQDN to the redactor, so it is
 * read back from the `user@host` form it does redact. A name the redactor passes through (.invalid,
 * .test: fixtures) gets an unsalted 6-hex id, since it identifies no one.
 */
export function pseudonymHost(r: Redactor, name: string): string {
  const n = name.trim().toLowerCase();
  if (/^host-[0-9a-f]{6}$/.test(n)) return n;
  const out = n.includes(".") ? r.text(n).split(".")[0] : r.text(`x@${n}`).split("@")[1] ?? "";
  return /^host-[0-9a-f]{6}$/.test(out) ? out : `host-${createHash("sha256").update(n).digest("hex").slice(0, 6)}`;
}

/** A login name: root stays root (it names no one); anything else is the pseudonym the redactor gives its home directory. */
export function pseudonymUser(r: Redactor, login: string): string {
  const n = login.trim();
  if (n === "root") return "root";
  const m = r.text(`/home/${n}`).match(/^\/home\/(user-[0-9a-f]{6})$/);
  return m ? m[1] : `user-${createHash("sha256").update(n).digest("hex").slice(0, 6)}`;
}

export interface ToRowsOptions { tenantId: string; redactor: Redactor; alias: string; now?: Date; runId?: string }

export interface ServerSummary { object_id: string; key: string; enabled: string; server_names: string[]; listen: string[]; proxy_pass: string[]; real_ip: string }

export interface Summary {
  alias: string;
  host: string;
  hostname: string | null;
  login_user: string | null;
  clock_skew_ms: number | null;
  run: CollectionRunRow;
  counts: Record<string, number>;
  population: string[];
  servers: ServerSummary[];
  server_names: string[];
  dns_referents: string[];
  not_readable: string[];
  skipped: string[];
  unresolved_includes: string[];
  standalone: string[];
  /** Grammar faults the parser read past: `<file>:<line>: <why>`. */
  malformed: string[];
  timers: string[];
  /** The IPv6 addresses the inventory leaves out, redacted, each with the flags of its line: "ip-1a2b3c temporary dynamic". */
  ip6_left_out: string[];
  export: { dir: string; readable: boolean; mtime: string | null; top_level: string[]; tarballs: number; newest_tarball: string | null; /** backup_item rows: every regular-file member of the newest tarball and every plain nginx copy. */ backup_items: number; snapshots: number; /** tarball members hashed as the empty input (symlinks, 0-byte files), dropped from backup_item. */ empty_members: string[] } | null;
  renewals: { readable: boolean; count: number } | null;
}

const realIpValue = (r: RealIp): string =>
  r.scope === "absent" ? "absent" : `trusted:${r.ranges.length} header:${r.header ?? "X-Real-IP"} scope:${r.scope}${r.via_include ? " via:include" : ""}`;

/** The zone a name sits in, taken as its last two labels (every zone of the measured estate is two labels deep); a wildcard's own star is dropped first. */
export const zoneOf = (name: string): string => name.replace(/^\*\./, "").replace(/\.$/, "").split(".").slice(-2).join(".");

/** A tarball's family: its name up to the first date or timestamp-looking run and without the extension (server-config-2026-10-24.tar.gz -> server-config). */
export function tarballStem(name: string): string {
  return name.replace(TARBALL, "").replace(/[-_.]?\d{4}[-_]?\d{2}[-_]?\d{2}.*$/, "").replace(/[-_.]?\d{8,}.*$/, "") || name;
}

/** Where a copy came from: the path from /etc/nginx/ on, or /etc + the path from /nginx/ on; a tar member `etc/nginx/x` has no leading slash and takes the second rule. */
export function exportCopyToObjectId(p: string): string | null {
  let i = p.indexOf("/etc/nginx/");
  if (i >= 0) return p.slice(i);
  i = p.indexOf("/nginx/");
  return i >= 0 ? `/etc${p.slice(i)}` : null;
}

/** A tarball's root: the prefix its first etc/nginx member sits under ("" for `etc/nginx/x`, "./" for `./etc/nginx/x`); "" when no member names etc/nginx. */
export function tarRoot(members: readonly string[]): string {
  for (const m of members) {
    const i = m.indexOf("etc/nginx/");
    if (i === 0 || (i > 0 && m[i - 1] === "/")) return m.slice(0, i);
  }
  return "";
}

/**
 * The object id of one tarball member: its path below the tarball's root with a leading slash, the id the
 * live file carries (`etc/letsencrypt/renewal/x.conf` -> /etc/letsencrypt/renewal/x.conf); a member outside
 * the root keeps its own path, a leading "./" dropped. Null for a name with nothing left.
 */
export function tarMemberToObjectId(member: string, root: string): string | null {
  const rest = (root && member.startsWith(root) ? member.slice(root.length) : member.replace(/^(?:\.\/)+/, "")).replace(/^\/+/, "");
  return rest ? `/${rest}` : null;
}

/** The trees the script reads live files from: the nginx tree and certbot's renewal configs. */
export const LIVE_PREFIXES: readonly string[] = ["/etc/nginx/", "/etc/letsencrypt/renewal/"];

/**
 * The object id a backup item is stored under. A member under LIVE_PREFIXES keeps its redacted path, the id
 * its live file's `file` row carries, so changed_since_backup and change_in_last_backup join the two. Every
 * other member (a unit file, a cron entry, an application's config) is stored as `member-` plus 16 hex of
 * the redactor's fingerprint of its redacted path: salted, stable for the tenant, one per path, so the row,
 * its hash and the count stay while the file name, which names the services and organisations the host
 * runs, stays on the host. Measured 24 Oct 2026: the newest tarballs of the two hosts hold 82 and 72 regular
 * members, 67 of them outside LIVE_PREFIXES (systemd units, cron entries, an application's env backups),
 * and six of those paths (three runner units and their drop-ins) carry an organisation's name in clear.
 */
export function backupMemberId(r: Redactor, objectId: string): string {
  const id = redactText(r, objectId);
  return LIVE_PREFIXES.some((p) => objectId.startsWith(p)) ? id : `member-${r.fingerprint(id).slice(7, 23)}`;
}

/**
 * Ids are the deterministic ones of src/data/rows.ts (16 hex of sha256 over the parts), so the same
 * collection yields the same ids and a re-insert is a no-op in the Store: run from (tenant, surface,
 * host, started_at); observation from (run, redacted object, setting path), which the collector keeps
 * unique within an object; asset from (tenant, redacted address); snapshot from (tenant, host, kind,
 * redacted source path).
 */
export function toRows(f: Fetched, opts: ToRowsOptions): { rows: CollectedRows; summary: Summary; analysis: Analysis; files: RawFiles; links: RawLinks } {
  const r = opts.redactor;
  const rtext = (s: string): string => redactText(r, s);
  const now = opts.now ?? new Date();
  const observedAt = now.toISOString();
  const host = pseudonymHost(r, opts.alias);
  const runId = opts.runId ?? runIdOf(opts.tenantId, SURFACE, host, observedAt);
  const rows = EMPTY_ROWS();

  // Population, asserted before any parsing: regular files the listings showed in the vhost directories.
  const vhostListings = ["/etc/nginx/conf.d", "/etc/nginx/sites-available"].map((d) => [d, f.listings[d]] as const);
  const anyListed = vhostListings.some(([, l]) => l?.rc === 0);
  const population = vhostListings.flatMap(([d, l]) => (l?.rc === 0 ? l.entries : []).filter((e) => e.type === "-" && !CREDENTIAL_SHAPED.test(e.name)).map((e) => `${d}/${e.name}`)).sort();
  const expected = anyListed ? population.length : null;

  // Files and symlinks as the parser wants them. A fetched path that the sites-enabled listing shows as a
  // symlink is not a file of its own (its target holds the bytes and is fetched too), so it gets no row.
  const links = new Map<string, string>();
  const enabledDir = "/etc/nginx/sites-enabled";
  for (const e of f.listings[enabledDir]?.entries ?? []) if (e.type === "l" && e.target) links.set(`${enabledDir}/${e.name}`, path.resolve(enabledDir, e.target));
  const files = new Map<string, string>();
  const bytesOf = new Map<string, Uint8Array>();
  for (const [p, v] of Object.entries(f.files)) if (v.ok && !links.has(p)) { files.set(p, new TextDecoder().decode(v.bytes)); bytesOf.set(p, v.bytes); }
  const analysis = analyse(files, { links });
  /** Vhost files were read but nginx.conf was not: nothing can say what is served. */
  const entryMissing = bytesOf.size > 0 && !analysis.entry_found;

  const obs = (object_id: string, setting_path: string, value: string, refers: { type: "dns_name" | "ip" | "upstream" | "cert"; id: string } | null = null, display?: string): void => {
    const objectId = rtext(object_id);
    rows.observation.push({
      obs_id: obsId(runId, objectId, setting_path), run_id: runId, tenant_id: opts.tenantId, surface: SURFACE, host,
      object_id: objectId, setting_path, value_hash: r.fingerprint(value), value_redacted: display ?? redactValue(r, value),
      refers_to_type: refers?.type ?? null, refers_to_id: refers ? rtext(refers.id) : null,
      observed_at: observedAt, source: SOURCE, authority: AUTHORITY.live,
    });
  };

  if (f.hostname) obs("system", "hostname", f.hostname, null, pseudonymHost(r, f.hostname));
  if (analysis.http_real_ip) obs(DEFAULT_ENTRY, "http.real_ip", realIpValue(analysis.http_real_ip));
  else if (entryMissing) obs(DEFAULT_ENTRY, "http.real_ip", "unknown"); // the SQL then tells "no list" from "could not read nginx.conf"

  for (const p of [...bytesOf.keys()].sort()) {
    const bytes = bytesOf.get(p)!;
    const objectId = rtext(p);
    rows.observation.push({
      obs_id: obsId(runId, objectId, "file"), run_id: runId, tenant_id: opts.tenantId, surface: SURFACE, host,
      object_id: objectId, setting_path: "file", value_hash: sha256(bytes), value_redacted: rtext(files.get(p)!),
      refers_to_type: null, refers_to_id: null, observed_at: observedAt, source: SOURCE, authority: AUTHORITY.live,
    });
  }

  const keysUsed = new Map<string, number>();
  const servers: ServerSummary[] = [];
  const dnsReferents = new Set<string>();
  for (const s of analysis.servers) {
    const first = s.server_names[0] ?? "_";
    const port = listenPort(s.listen[0] ?? "80");
    let key = `server[${rtext(first)}:${port}]`;
    const seen = (keysUsed.get(`${s.file}|${key}`) ?? 0) + 1;
    keysUsed.set(`${s.file}|${key}`, seen);
    if (seen > 1) key = `${key}#${seen}`;
    const dnsNames = s.server_names.filter(isDnsName);
    obs(s.file, `${key}.server_name`, s.server_names.join(" "));
    for (const name of dnsNames) {
      obs(s.file, `${key}.server_name[${rtext(name)}]`, name, { type: "dns_name", id: name });
      obs(s.file, `${key}.server_name[${rtext(name)}].zone`, zoneOf(name));
      dnsReferents.add(rtext(name));
    }
    if (s.listen.length) obs(s.file, `${key}.listen`, s.listen.join("; "));
    if (s.ssl_certificate.length) obs(s.file, `${key}.ssl_certificate`, s.ssl_certificate.join("; "), { type: "cert", id: s.ssl_certificate[0] });
    if (s.root.length) obs(s.file, `${key}.root`, s.root.join("; "));
    obs(s.file, `${key}.real_ip`, realIpValue(s.real_ip));
    obs(s.file, `${key}.enabled`, s.enabled === "yes" ? "1" : s.enabled === "no" ? "0" : "unknown");
    const proxies: string[] = [];
    for (const loc of s.locations) {
      for (const target of loc.proxy_pass) {
        const t = classifyTarget(target, analysis.upstreams);
        const refers = t.kind === "dns_name" || t.kind === "ip" || t.kind === "upstream" ? { type: t.kind, id: t.host } : null;
        obs(s.file, `${key}.${loc.path}.proxy_pass`, target, refers);
        if (t.kind === "dns_name") dnsReferents.add(rtext(t.host));
        proxies.push(rtext(target));
      }
      if (loc.alias.length) obs(s.file, `${key}.${loc.path}.alias`, loc.alias.join("; "));
      if (loc.root.length) obs(s.file, `${key}.${loc.path}.root`, loc.root.join("; "));
    }
    servers.push({ object_id: rtext(s.file), key, enabled: s.enabled, server_names: s.server_names.map(rtext), listen: s.listen, proxy_pass: proxies, real_ip: realIpValue(s.real_ip) });
  }

  // The unit name goes through the redactor too: a timer named after a zone or a product (<brand>-ingest.timer, measured on
  // host-redacted) would otherwise carry the label into setting_path, which the Store leaves as written.
  for (const t of f.timers?.entries ?? []) obs("systemd", `timer[${rtext(t.unit)}]`, t.activates);

  for (const ip of [...f.ip4, ...f.ip6]) {
    const address = rtext(ip);
    rows.inventory_asset.push({ asset_id: assetId(opts.tenantId, address), tenant_id: opts.tenantId, host, address, kind: "vps", source: SOURCE, observed_at: observedAt });
  }

  // Backups: one snapshot per config tarball in the export folder (items for the newest, every regular-file
  // member hashed on the host), one per folder of plain nginx copies, and the folder itself only when it holds neither. When
  // the host found the tarball that holds etc/nginx, only its family counts (names sharing its stem
  // before the date: server-config-<date>.tar.gz), so an application dump written the same minute is not
  // "the latest backup" the restore templates compare against.
  let snapshots = 0;
  let copies = 0;
  let tarballs = 0;
  const emptyMembers: string[] = [];
  const exp = f.export_dir;
  const snapshot = (root: string, mtime: string, items: { object_id: string; sha256: string }[]): void => {
    const sourceRef = rtext(root);
    const id = snapshotId(opts.tenantId, host, KIND_EXPORT, sourceRef);
    rows.backup_snapshot.push({ snapshot_id: id, tenant_id: opts.tenantId, host, kind: KIND_EXPORT, taken_at: mtime, source_ref: sourceRef });
    snapshots++;
    for (const it of items) {
      if (it.sha256 === EMPTY_SHA256) { emptyMembers.push(backupMemberId(r, it.object_id)); continue; }
      rows.backup_item.push({ snapshot_id: id, object_id: backupMemberId(r, it.object_id), setting_path: "file", value_hash: `sha256:${it.sha256}` });
      copies++;
    }
  };
  if (exp && exp.rc === 0) {
    const family = exp.tar && exp.tar.rc === 0 ? tarballStem(path.basename(exp.tar.path)) : null;
    const tarEntries = (exp.listing?.entries ?? []).filter((e) => e.type === "-" && TARBALL.test(e.name) && e.mtime && (family === null || tarballStem(e.name) === family)).sort((a, b) => a.name.localeCompare(b.name));
    tarballs = tarEntries.length;
    const root = exp.tar ? tarRoot(exp.tar.hashes.map((h) => h.path)) : "";
    for (const e of tarEntries) {
      const p = `${exp.dir}/${e.name}`;
      const items = exp.tar && exp.tar.rc === 0 && exp.tar.path === p ? exp.tar.hashes.flatMap((h) => { const id = tarMemberToObjectId(h.path, root); return id ? [{ object_id: id, sha256: h.sha256 }] : []; }) : [];
      snapshot(p, e.mtime!, items);
    }
    const roots = new Map<string, { object_id: string; sha256: string }[]>();
    for (const h of exp.hashes) {
      const object_id = exportCopyToObjectId(h.path);
      if (!object_id) continue;
      const root = h.path.slice(0, h.path.length - object_id.length) || exp.dir;
      if (!roots.has(root)) roots.set(root, []);
      roots.get(root)!.push({ object_id, sha256: h.sha256 });
    }
    for (const [root, items] of [...roots].sort()) {
      let mtime = root === exp.dir ? exp.mtime : null;
      if (!mtime) {
        const rel = root.startsWith(`${exp.dir}/`) ? root.slice(exp.dir.length + 1).split("/")[0] : null;
        mtime = (rel && exp.listing?.entries.find((e) => e.name === rel)?.mtime) ?? exp.found.find((e) => e.type === "d" && e.path === root)?.mtime ?? exp.mtime;
      }
      if (mtime) snapshot(root, mtime, items);
    }
    if (tarEntries.length === 0 && roots.size === 0 && exp.mtime) snapshot(exp.dir, exp.mtime, []);
  }

  const observed = anyListed ? population.filter((p) => f.files[p]?.ok).length : null;
  const status: CollectionRunRow["status"] = f.hostname === null ? "failed" : expected !== null && observed === expected && f.complete && !entryMissing ? "complete" : "partial";
  const run: CollectionRunRow = { run_id: runId, tenant_id: opts.tenantId, surface: SURFACE, host, started_at: observedAt, finished_at: new Date().toISOString(), expected_count: expected, observed_count: observed, status };
  rows.collection_run.push(run);

  const notReadable = [...new Set([
    ...Object.entries(f.files).filter(([, v]) => !v.ok && v.rc !== 3).map(([p]) => p),
    ...(entryMissing ? [DEFAULT_ENTRY] : []),
    ...Object.entries(f.listings).filter(([, l]) => l.rc !== 0).map(([d]) => d),
    ...(exp && exp.rc !== 0 ? [exp.dir] : []),
    ...(exp?.tar && exp.tar.rc !== 0 ? [exp.tar.path] : []),
    ...(f.renewals && f.renewals.rc !== 0 ? ["/etc/letsencrypt/renewal"] : []),
    ...(f.timers && f.timers.rc !== 0 ? ["systemctl list-timers"] : []),
  ])].map(rtext);
  const summary: Summary = {
    alias: opts.alias,
    host,
    hostname: f.hostname ? pseudonymHost(r, f.hostname) : null,
    login_user: f.login_user ? pseudonymUser(r, f.login_user) : null,
    clock_skew_ms: f.server_time ? Date.parse(f.server_time) - now.getTime() : null,
    run,
    counts: Object.fromEntries(Object.entries(rows).map(([t, v]) => [t, v.length])),
    population: population.map(rtext),
    servers,
    server_names: [...new Set(servers.flatMap((s) => s.server_names))].sort(),
    dns_referents: [...dnsReferents].sort(),
    not_readable: notReadable,
    skipped: Object.entries(f.files).filter(([, v]) => !v.ok && v.rc === 3).map(([p]) => rtext(p)),
    unresolved_includes: analysis.unresolved.map((u) => rtext(`${u.pattern}${u.matched ? ` (${u.matched} not fetched)` : ""} from ${u.file}:${u.line}`)),
    standalone: analysis.standalone.map(rtext),
    malformed: analysis.malformed.map((m) => rtext(`${m.file}:${m.line}: ${m.why}`)),
    timers: (f.timers?.entries ?? []).map((t) => rtext(`${t.unit} -> ${t.activates}`)),
    ip6_left_out: f.ip6_left_out.map((l) => `${rtext(l.address)} ${l.flags.join(" ")}`),
    export: exp ? {
      dir: rtext(exp.dir), readable: exp.rc === 0, mtime: exp.mtime,
      top_level: (exp.listing?.entries ?? []).map((e) => rtext(`${e.mode} ${e.size} ${e.mtime ?? "?"} ${e.name}${e.target ? ` -> ${e.target}` : ""}`)),
      tarballs, newest_tarball: exp.tar ? rtext(exp.tar.path) : null, backup_items: copies, snapshots, empty_members: emptyMembers,
    } : null,
    renewals: f.renewals ? { readable: f.renewals.rc === 0, count: f.renewals.paths.length } : null,
  };
  const byPath = <T>(m: Map<string, T>): Record<string, T> => Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { rows, summary, analysis, files: byPath(bytesOf), links: byPath(links) };
}

/**
 * Write one pass through the Store's run lifecycle: the run opens with the population it asserted
 * (beginRun, status running), then observations, inventory, snapshots and items go in, then the run
 * closes with what it observed and its status. A run the Store already holds is refused by the Store,
 * never reopened. An observed_count the collector could not establish (no listing at all) is written as
 * 0: the gate fails that run on its NULL expected_count anyway. An insert that fails closes the run as
 * failed before the error goes up, so no run is left running (as collect-cloudflare.ts does). Returns
 * rows written per table.
 */
export async function storeRows(store: Store, rows: CollectedRows): Promise<Record<string, number>> {
  const [run] = rows.collection_run;
  if (!run) throw new CollectorError("storeRows: no collection_run row");
  await store.beginRun(run);
  const written: Record<string, number> = { collection_run: 1 };
  try {
    written.observation = await store.insertObservations(rows.observation);
    written.inventory_asset = await store.upsertInventory(rows.inventory_asset);
    written.backup_snapshot = 0;
    for (const s of rows.backup_snapshot) written.backup_snapshot += await store.insertBackupSnapshot(s);
    written.backup_item = await store.insertBackupItems(rows.backup_item);
  } catch (e) {
    await store.finishRun(run.run_id, 0, "failed").catch(() => undefined);
    throw e;
  }
  await store.finishRun(run.run_id, run.observed_count ?? 0, run.status === "running" ? "failed" : run.status, run.finished_at ?? new Date().toISOString());
  return written;
}

/** The fetched files that became `file` rows, as raw bytes keyed by their real path on the host, in path order: what the vault commits (src/vault/). */
export type RawFiles = Readonly<Record<string, Uint8Array>>;
/** The sites-enabled symlinks the listing showed: real link path -> real target path, in path order. */
export type RawLinks = Readonly<Record<string, string>>;

/**
 * One host's collection. `rows` and `summary` are redacted; `files` and `links` carry real paths and raw
 * bytes for the vault alone. printable() is what --dry-run prints and --out writes.
 */
export interface CollectResult { rows: CollectedRows; summary: Summary; ssh: { code: number | null; latencyMs: number; stderr: string; bytes: number }; files: RawFiles; links: RawLinks }

/** The redacted half of a collection, what scripts/collect-linux.ts prints (--dry-run) and writes (--out): the summary with the ssh outcome, and the rows. */
export function printable(res: CollectResult): { summary: Summary & { ssh: CollectResult["ssh"] }; rows: CollectedRows } {
  return { summary: { ...res.summary, ssh: res.ssh }, rows: res.rows };
}

/** Fetch, parse and build rows for one host; every logged string is redacted first. */
export async function collectHost(alias: string, opts: { tenantId: string; redactor: Redactor; tracer?: Tracer; timeoutMs?: number }): Promise<CollectResult> {
  const t = opts.tracer;
  const res = await fetchHost(alias, { timeoutMs: opts.timeoutMs });
  const stderr = redactText(opts.redactor, redact(res.stderr.trim()));
  t?.emit({ agent: "collector.linux", action: "observe", status: res.code === 0 ? "ok" : "failed", latency_ms: res.latencyMs, input_summary: `ssh ${SSH_ARGS.join(" ")} ${alias} bash -s`, output_summary: `${res.stdout.length} bytes, exit ${res.code ?? res.signal}`, detail: stderr || undefined });
  if (res.code !== 0 && res.stdout.length === 0) throw new CollectorError(`ssh ${alias} exited ${res.code ?? res.signal}: ${stderr}`);
  const fetched = parseStream(res.stdout);
  const { rows, summary, files, links } = toRows(fetched, { tenantId: opts.tenantId, redactor: opts.redactor, alias });
  const notes = [
    summary.not_readable.length ? `not readable: ${summary.not_readable.join(", ")}` : "",
    summary.malformed.length ? `malformed: ${summary.malformed.join("; ")}` : "",
    summary.export?.empty_members.length ? `empty tarball members dropped: ${summary.export.empty_members.join(", ")}` : "",
    summary.ip6_left_out.length ? `IPv6 left out of the inventory: ${summary.ip6_left_out.join(", ")}` : "",
  ].filter(Boolean);
  t?.emit({
    agent: "collector.linux", action: "observe", status: summary.run.status === "complete" ? "ok" : "failed",
    output_summary: `${alias} -> ${summary.host}: ${summary.run.status}, expected ${summary.run.expected_count ?? "null"} observed ${summary.run.observed_count ?? "null"}, ${rows.observation.length} observations, ${summary.servers.length} server blocks, ${rows.inventory_asset.length} assets, ${rows.backup_snapshot.length} snapshots, ${rows.backup_item.length} backup items`,
    detail: notes.length ? notes.join(" | ") : undefined,
  });
  return { rows, summary, ssh: { code: res.code, latencyMs: res.latencyMs, stderr, bytes: res.stdout.length }, files, links };
}

export { isVhostPath };
