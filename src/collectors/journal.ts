// The host journal as evidence of who changed a file: the journal section of the Linux collector's read script
// (src/collectors/linux.ts readScript) and its normalisation to audit_event rows with source "journal".
//
// On the host, in the same SSH session as the other reads: journalctl --utc -o short-iso --no-pager over the last
// JOURNAL_HOURS hours for _COMM=sudo, sshd, sshd-session, certbot and dpkg, read directly when the login's groups can
// read the system journal (adm, systemd-journal, wheel, or root), else through sudo -n once `sudo -n -l journalctl`
// says it is allowed. The lines are filtered on the host before anything is printed (JOURNAL_PATTERNS, the same
// expressions this module applies again): sudo lines that ran (every field before COMMAND= is a KEY=value pair, so
// "command not allowed" and "incorrect password attempts" lines drop) and whose COMMAND mentions nginx, certbot,
// /etc/letsencrypt/ or systemctl reload|restart; sshd lines with "Accepted"; certbot and dpkg lines mentioning nginx;
// the collector's own journalctl call is dropped (JOURNAL_DROP). The newest JOURNAL_CAP lines are printed, with a note
// when there were more. No journalctl, or a sudo that refuses, prints a note and no lines: the section never fails
// the run.
//
// One kept line is one audit_event row (journalEventRow):
//   source       "journal"
//   occurred_at  the line's ISO time, canonical UTC milliseconds
//   actor        the login, pseudonymised (journalActor: user-XXXXXX, the redactor's /home/<login> pseudonym; root
//                stays root); null on certbot and dpkg lines
//   action       sudo: the program's basename, for systemctl with its verb and units (tee, sed, cp,
//                systemctl reload nginx); sshd: ssh_login; certbot and dpkg: the tool's name
//   resource_type  "file" for a sudo line naming a path under /etc/nginx/ or /etc/letsencrypt/renewal/, "session"
//                for a login, else null
//   resource_id  that path, redacted as the collector redacts an object_id, so it equals the file's observation
//                object_id; null otherwise
//   old_value    a login's source address, redacted (ip-XXXXXX; documentation ranges stay as they are); null otherwise
//   new_value    what ran, then " on <host>": sudo: the program and only the arguments that are paths or flags
//                (keptArgs: a sed or awk script, the value after -e, and every other word are dropped, so no value
//                typed on a command line is stored); sshd: the method (publickey); certbot and dpkg: the message,
//                redacted, at most 200 characters. The host is the collector's pseudonym of the ssh alias
//                (journalHost reads it back): audit_event has no host column, and a path such as
//                /etc/nginx/nginx.conf exists on every host.
//   event_id     stableId("evt", tenant, "journal", host, occurred_at, pid, action, resource_id): the same line read
//                by two overlapping collections is one row (the Store inserts audit_event ON CONFLICT DO NOTHING).
// The line's own host name field is dropped. Every row is a fixed point of the Store's redaction pass.

import path from "node:path/posix";
import type { AuditEvent } from "../data/rows.ts";
import { stableId } from "../data/rows.ts";
import type { Redactor } from "../redactor.ts";

export const JOURNAL_SOURCE = "journal";
/** How far back each collection reads the journal. */
export const JOURNAL_HOURS = 24;
/** The most lines the host prints: the newest ones. */
export const JOURNAL_CAP = 400;
/** The journal fields matched on the host; same-field matches are ORed by journalctl. */
export const JOURNAL_MATCHES = "_COMM=sudo _COMM=sshd _COMM=sshd-session _COMM=certbot _COMM=dpkg";
/** The trees whose files the collector observes (linux.ts LIVE_PREFIXES): a sudo line naming one is about a file. */
export const FILE_PREFIXES: readonly string[] = ["/etc/nginx/", "/etc/letsencrypt/renewal/"];

/**
 * The lines kept, one extended regular expression each, applied by grep -E on the host and as RegExp here. Each
 * matches the whole short-iso line: time, host name field, identifier[pid], message.
 */
export const JOURNAL_PATTERNS: readonly string[] = [
  String.raw`^[^ ]+ [^ ]+ sudo\[[0-9]+\]: +[^ ]+ : ([A-Z_]+=[^;]* ; )*COMMAND=.*(nginx|certbot|/etc/letsencrypt/|systemctl .*(reload|restart)( |$))`,
  String.raw`^[^ ]+ [^ ]+ sshd(-session)?\[[0-9]+\]: Accepted `,
  String.raw`^[^ ]+ [^ ]+ (certbot|dpkg)\[[0-9]+\]: .*nginx`,
];

/** The collector's own read: its COMMAND names _COMM=certbot, so it would otherwise be kept. */
export const JOURNAL_DROP = String.raw`^[^ ]+ [^ ]+ sudo\[[0-9]+\]: .*COMMAND=[^ ]*journalctl( |$)`;

const KEEP = JOURNAL_PATTERNS.map((p) => new RegExp(p));
const DROP = new RegExp(JOURNAL_DROP);

/** The host-side filter, applied again here: a line the host should not have printed is not stored. */
export function keepJournalLine(line: string): boolean {
  return KEEP.some((k) => k.test(line)) && !DROP.test(line);
}

const JOURNAL_ARGS = "--utc -o short-iso --no-pager";

/**
 * The shell half, spliced into readScript before the DONE marker: the filter, the read, and the section. It holds
 * no "${" (readScript is a template literal) and no single quote inside a pattern.
 */
export const JOURNAL_SHELL = String.raw`journal_filter() {
  grep -E ${JOURNAL_PATTERNS.map((p) => `-e '${p}'`).join(" ")} | grep -v -E '${JOURNAL_DROP}' | awk -v cap=${JOURNAL_CAP} '{ kept[NR % cap] = $0 } END { first = NR > cap ? NR - cap + 1 : 1; for (i = first; i <= NR; i++) print kept[i % cap]; if (NR > cap) print "note: " NR " lines kept, the newest " cap " printed" }'
}
journal_read() { journalctl ${JOURNAL_ARGS} --since "$1" ${JOURNAL_MATCHES} 2>/dev/null; }
journal_lines() {
  if ! command -v journalctl >/dev/null 2>&1; then echo 'note: journalctl not found; nothing read'; return 0; fi
  case " $(id -nG 2>/dev/null) " in
    *" adm "*|*" systemd-journal "*|*" wheel "*) echo 'via: group'; journal_read "$1" | journal_filter; return 0 ;;
  esac
  if [ "$(id -u)" = 0 ]; then echo 'via: root'; journal_read "$1" | journal_filter; return 0; fi
  if ! sudo -n -l journalctl >/dev/null 2>&1; then echo 'note: sudo -n refused journalctl; nothing read'; return 0; fi
  echo 'via: sudo'
  sudo -n journalctl ${JOURNAL_ARGS} --since "$1" ${JOURNAL_MATCHES} 2>/dev/null | journal_filter
  return 0
}
since=$(date -u -d '${JOURNAL_HOURS} hours ago' '+%Y-%m-%d %H:%M:%S')
section journal "$since" journal_lines "$since"
`;

/** The journal section as parseStream reads it. */
export interface JournalSection {
  rc: number;
  /** The window's start as the host computed it, canonical ISO; null when unreadable. */
  since: string | null;
  /** How the journal was read: by the login's group, as root, through sudo -n; null when it was not. */
  via: "group" | "root" | "sudo" | null;
  /** The kept lines, raw: they carry login names and addresses until journalEventRow redacts them. */
  lines: string[];
  /** The host's own notes: no journalctl, sudo refused, lines over the cap. */
  notes: string[];
}

export function parseJournalSection(rc: number, arg: string, body: string): JournalSection {
  const m = arg.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
  const out: JournalSection = { rc, since: m ? `${m[1]}T${m[2]}.000Z` : null, via: null, lines: [], notes: [] };
  for (const raw of body.split("\n")) {
    const l = raw.replace(/\r$/, "");
    if (!l.trim()) continue;
    if (l.startsWith("note: ")) out.notes.push(l.slice(6));
    else if (/^via: (group|root|sudo)$/.test(l)) out.via = l.slice(5) as JournalSection["via"];
    else out.lines.push(l);
  }
  return out;
}

/** One kept line taken apart: its time, identifier, pid and message; the host name field is not kept. */
export interface JournalLine { at: string; ident: string; pid: string; message: string }

const LINE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2}) \S+ ([A-Za-z0-9_.-]+)\[(\d+)\]: (.*)$/;

export function parseJournalLine(line: string): JournalLine | null {
  const m = line.match(LINE);
  if (!m) return null;
  const off = m[4] === "Z" ? "+00:00" : m[4].replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
  const ms = Date.parse(`${m[1]}T${m[2]}.${(m[3] ?? "").slice(0, 3).padEnd(3, "0")}${off}`);
  if (Number.isNaN(ms)) return null;
  return { at: new Date(ms).toISOString(), ident: m[5], pid: m[6], message: m[7] };
}

const FLAG = /^(?:--|-[A-Za-z]{1,3}|--[a-z][a-z0-9-]*)$/;
const PATH = /^\/\S*$/;
/** Programs whose first non-flag argument is a script, unless -e or -f gives it. */
const SCRIPT_FIRST = new Set(["sed", "awk", "gawk", "mawk", "nawk"]);
/** A flag whose next argument is an expression: never kept. */
const TAKES_EXPRESSION = (a: string): boolean => a === "--expression" || /^-[A-Za-z]*e$/.test(a);
const NAMES_SCRIPT = (a: string): boolean => TAKES_EXPRESSION(a) || a === "--file" || a.startsWith("--expression=") || a.startsWith("--file=") || /^-[A-Za-z]*f$/.test(a);

/**
 * The arguments of one command that may be stored: "--", flags (-i, -t, -sf, --force; nothing with "="), and paths
 * (an argument starting with "/"). Dropped: every other word, the argument after -e or --expression, and for sed and
 * awk the first non-flag argument when no -e or -f names the script. A relative path is dropped too, since it cannot
 * be told from a value.
 */
export function keptArgs(program: string, args: readonly string[]): string[] {
  const out: string[] = [];
  let scriptPending = SCRIPT_FIRST.has(program) && !args.some(NAMES_SCRIPT);
  let skipNext = false;
  for (const a of args) {
    if (skipNext) { skipNext = false; continue; }
    if (FLAG.test(a)) {
      out.push(a);
      if (TAKES_EXPRESSION(a)) skipNext = true;
      continue;
    }
    if (scriptPending) { scriptPending = false; continue; }
    if (PATH.test(a)) out.push(a);
  }
  return out;
}

/**
 * A login name as the rows carry it: root stays root (it names no one); a name of [A-Za-z0-9._-] is the redactor's
 * pseudonym of /home/<name>, the one the collector's summary gives the login user; any other name gets user- plus 6
 * hex of the redactor's salted fingerprint.
 */
export function journalActor(r: Redactor, login: string): string {
  const n = login.trim();
  if (n === "root") return "root";
  if (/^[A-Za-z0-9._-]+$/.test(n)) {
    const m = r.text(`/home/${n}`).match(/^\/home\/(user-[0-9a-f]{6})$/);
    if (m) return m[1];
  }
  return `user-${r.fingerprint(`login:${n}`).slice(7, 13)}`;
}

/** The host a journal row came from: the " on <host>" new_value ends with. */
export function journalHost(e: Pick<AuditEvent, "source" | "new_value">): string | null {
  if (e.source !== JOURNAL_SOURCE || !e.new_value) return null;
  return e.new_value.match(/ on (host-[0-9a-f]{6})$/)?.[1] ?? null;
}

export const journalEventId = (tenantId: string, host: string, occurredAt: string, pid: string, action: string, resourceId: string | null): string =>
  stableId("evt", tenantId, JOURNAL_SOURCE, host, occurredAt, pid, action, resourceId);

export interface JournalContext {
  tenantId: string;
  /** The collector's pseudonym of the ssh alias (linux.ts pseudonymHost). */
  host: string;
  /** The collector's redaction of a path or free text (linux.ts redactText): redactor, then its sweep. */
  redact: (s: string) => string;
}

const SUDO = /^\s*(\S+) : (?:[A-Z_]+=[^;]* ; )*COMMAND=(.*)$/;
const ACCEPTED = /^Accepted (\S+) for (\S+) from (\S+) port \d+/;
const MESSAGE_MAX = 200;
const NEW_VALUE_MAX = 600;

/** One kept journal line as one audit_event row; undefined for a line that does not parse or that the filter drops. */
export function journalEventRow(r: Redactor, line: string, ctx: JournalContext): AuditEvent | undefined {
  if (!keepJournalLine(line)) return undefined;
  const l = parseJournalLine(line);
  if (!l) return undefined;
  const on = (s: string): string => `${ctx.redact(s).slice(0, NEW_VALUE_MAX)} on ${ctx.host}`;
  const row = (actor: string | null, action: string, resourceType: string | null, resourceId: string | null, oldValue: string | null, newValue: string): AuditEvent => ({
    event_id: journalEventId(ctx.tenantId, ctx.host, l.at, l.pid, action, resourceId),
    tenant_id: ctx.tenantId, source: JOURNAL_SOURCE, actor, action, resource_type: resourceType, resource_id: resourceId,
    old_value: oldValue, new_value: newValue, occurred_at: l.at,
  });

  if (l.ident === "sudo") {
    const m = l.message.match(SUDO);
    if (!m) return undefined;
    const [program, ...args] = m[2].trim().split(/\s+/);
    if (!program) return undefined;
    const base = path.basename(program);
    if (!/^[A-Za-z0-9._+-]+$/.test(base) || base === "journalctl") return undefined;
    const kept = keptArgs(base, args);
    const words = args.filter((a) => !a.startsWith("-"));
    // action is not one of the columns the Store redacts, so it leaves here redacted: a unit or program name can carry a label
    const action = ctx.redact(base === "systemctl" && words.length ? `systemctl ${words.slice(0, 4).join(" ")}` : base);
    const file = kept.find((a) => FILE_PREFIXES.some((p) => a.startsWith(p) && a.length > p.length));
    const shown = PATH.test(program) ? program : base;
    return row(journalActor(r, m[1]), action, file ? "file" : null, file ? ctx.redact(file) : null, null, on([shown, ...kept].join(" ")));
  }
  if (l.ident === "sshd" || l.ident === "sshd-session") {
    const m = l.message.match(ACCEPTED);
    if (!m) return undefined;
    return row(journalActor(r, m[2]), "ssh_login", "session", null, ctx.redact(m[3]), on(m[1]));
  }
  if (l.ident === "certbot" || l.ident === "dpkg") {
    return row(null, l.ident, null, null, null, on(ctx.redact(l.message.trim()).slice(0, MESSAGE_MAX)));
  }
  return undefined;
}

export interface JournalSummary {
  since: string | null;
  via: JournalSection["via"];
  /** Lines the host printed. */
  lines: number;
  /** audit_event rows made of them, distinct by event_id. */
  rows: number;
  /** Lines printed but not stored: the filter applied here dropped them, or they did not parse. */
  dropped: number;
  /** Rows per action, redacted. */
  actions: Record<string, number>;
  /** The host's notes, redacted. */
  notes: string[];
}

/** Every kept line of the section as rows, distinct by event_id, oldest first; and what the summary prints of them. */
export function journalRows(r: Redactor, j: JournalSection | null, ctx: JournalContext): { rows: AuditEvent[]; summary: JournalSummary | null } {
  if (!j) return { rows: [], summary: null };
  const byId = new Map<string, AuditEvent>();
  let dropped = 0;
  for (const line of j.lines) {
    const e = journalEventRow(r, line, ctx);
    if (!e) { dropped++; continue; }
    if (!byId.has(e.event_id)) byId.set(e.event_id, e);
  }
  const rows = [...byId.values()].sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.event_id < b.event_id ? -1 : 1));
  const actions: Record<string, number> = {};
  for (const e of rows) actions[e.action] = (actions[e.action] ?? 0) + 1;
  return { rows, summary: { since: j.since, via: j.via, lines: j.lines.length, rows: rows.length, dropped, actions, notes: j.notes.map(ctx.redact) } };
}
