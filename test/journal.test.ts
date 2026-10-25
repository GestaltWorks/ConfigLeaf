// The host journal as audit evidence (src/collectors/journal.ts): the filter on both sides (the grep -E patterns as
// RegExp, and the shell function itself under bash with journalctl, id and sudo stubbed), the normalisation of a kept
// line to an audit_event row, the argument stripping that keeps typed values out of new_value, the pseudonymisation of
// login names, and the rows' way through toRows, the sql.js loader and storeRows. The fixture lines are the two shapes
// measured on a host on 25 Oct 2026 with the login and host names replaced by invented ones (tvance, web7), plus the
// lab stand-in's lines (lab/journalctl). Addresses: 203.0.113.9 and 198.51.100.7 are documentation ranges the redactor
// keeps; 100.64.12.34 is not, and becomes ip-XXXXXX.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  JOURNAL_CAP, JOURNAL_MATCHES, JOURNAL_SHELL, journalActor, journalEventId, journalEventRow, journalHost, journalRows, keepJournalLine, keptArgs,
  parseJournalLine, parseJournalSection, type JournalContext,
} from "../src/collectors/journal.ts";
import { MARK, parseStream, pseudonymHost, pseudonymUser, redactText, storeRows, toRows } from "../src/collectors/linux.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { REDACT, type AuditEvent } from "../src/data/rows.ts";
import type { Store } from "../src/data/store.ts";
import { Redactor } from "../src/redactor.ts";

const r = new Redactor("fixture-salt");
const T = "lab-1";
const HOST = pseudonymHost(r, "web7-alias");
const ctx: JournalContext = { tenantId: T, host: HOST, redact: (s) => redactText(r, s) };
const H6 = "[0-9a-f]{6}";
const bashOk = spawnSync("bash", ["-c", "true"]).status === 0;

// The two measured shapes, names invented.
const TEE = "2026-10-25T15:55:12+00:00 web7 sudo[3055347]:   tvance : PWD=/home/tvance ; USER=root ; COMMAND=/usr/bin/tee -- /etc/nginx/conf.d/example.conf";
const LOGIN = "2026-10-25T16:57:21+00:00 web7 sshd[3070106]: Accepted publickey for tvance from 203.0.113.9 port 40445 ssh2: ED25519 SHA256:abc...";

const KEPT = [
  TEE,
  LOGIN,
  "2026-10-25T16:58:02+00:00 web7 sudo[3070201]:   tvance : TTY=pts/0 ; PWD=/home/tvance ; USER=root ; COMMAND=/usr/sbin/nginx -t",
  "2026-10-25T16:58:03+00:00 web7 sudo[3070210]:   tvance : TTY=pts/0 ; PWD=/home/tvance ; USER=root ; COMMAND=/usr/bin/systemctl reload nginx",
  "2026-10-25T16:58:09+00:00 web7 sudo[3070230]:   tvance : TTY=pts/0 ; PWD=/home/tvance ; USER=root ; COMMAND=/usr/bin/systemctl restart php8.2-fpm",
  "2026-10-25T16:59:40+00:00 web7 sudo[3070300]:   tvance : PWD=/etc/nginx ; USER=root ; COMMAND=/usr/bin/sed -i s#8081#8091# /etc/nginx/sites-available/shop.northwind-demo.com",
  "2026-10-25T17:00:00+00:00 web7 sudo[3070310]:   tvance : PWD=/home/tvance ; USER=root ; COMMAND=/usr/bin/htpasswd -b /etc/nginx/.htpasswd admin S3cretPass",
  "2026-10-25T17:01:00+00:00 web7 sudo[3070320]:   tvance : PWD=/home/tvance ; USER=root ; COMMAND=/usr/bin/vim /etc/letsencrypt/renewal/shop.northwind-demo.com.conf",
  "2026-10-25T17:02:00+00:00 web7 sshd-session[3070400]: Accepted publickey for root from 100.64.12.34 port 50122 ssh2: ED25519 SHA256:def...",
  "2026-10-25T03:12:04+00:00 web7 certbot[811]: Reloading nginx server after certificate renewal",
  "2026-10-25T03:20:00+00:00 web7 dpkg[901]: status installed nginx-common:all 1.24.0-2ubuntu7",
];

const DROPPED = [
  "2026-10-25T15:50:00+00:00 web7 sudo[3055000]:   tvance : PWD=/home/tvance ; USER=root ; COMMAND=/usr/bin/tee /etc/other/app.env",
  "2026-10-25T15:51:00+00:00 web7 sudo[3055010]:   tvance : PWD=/home/tvance ; USER=root ; COMMAND=/usr/bin/apt install -y jq",
  "2026-10-25T15:52:00+00:00 web7 sudo[3055020]:   tvance : PWD=/home/tvance ; USER=root ; COMMAND=/usr/bin/cat /etc/hosts",
  // sudo refused these: the field before COMMAND is not a KEY=value pair
  "2026-10-25T15:53:00+00:00 web7 sudo[3055030]:   tvance : command not allowed ; PWD=/home/tvance ; USER=root ; COMMAND=/usr/bin/tee /etc/nginx/nginx.conf",
  "2026-10-25T15:53:30+00:00 web7 sudo[3055031]:   tvance : 3 incorrect password attempts ; TTY=pts/0 ; PWD=/home/tvance ; USER=root ; COMMAND=/usr/sbin/nginx -t",
  "2026-10-25T15:54:00+00:00 web7 sudo[3055040]: pam_unix(sudo:session): session opened for user root(uid=0) by tvance(uid=1000)",
  "2026-10-25T15:54:10+00:00 web7 sshd[3055050]: Failed password for invalid user admin from 100.64.99.1 port 4022 ssh2",
  "2026-10-25T15:54:20+00:00 web7 sshd[3055051]: Connection closed by 100.64.99.1 port 4022 [preauth]",
  "2026-10-25T03:12:00+00:00 web7 certbot[811]: Renewing an existing certificate for shop.northwind-demo.com",
  // the collector's own read names _COMM=certbot in its COMMAND
  `2026-10-25T17:05:00+00:00 web7 sudo[3070500]:   drift : PWD=/home/drift ; USER=root ; COMMAND=/usr/bin/journalctl --utc -o short-iso --no-pager --since 2026-10-24 17:05:00 ${JOURNAL_MATCHES}`,
  "-- No entries --",
];

const rowOf = (line: string): AuditEvent => {
  const e = journalEventRow(r, line, ctx);
  if (!e) throw new Error(`no row for ${line}`);
  return e;
};

describe("the filter", () => {
  it("keeps sudo lines that ran and touch nginx, certbot, /etc/letsencrypt/ or a reload or restart; logins that were accepted; certbot and dpkg lines naming nginx", () => {
    for (const l of KEPT) expect(keepJournalLine(l), l).toBe(true);
  });

  it("drops everything else: other files, other commands, refused sudo, sessions, failed logins, the collector's own read", () => {
    for (const l of DROPPED) expect(keepJournalLine(l), l).toBe(false);
  });

  const filterFn = JOURNAL_SHELL.match(/^journal_filter\(\) \{\n[\s\S]*?\n\}\n/m)?.[0] ?? "";
  const shDir = mkdtempSync(path.join(tmpdir(), "journal-test-"));
  afterAll(() => rmSync(shDir, { recursive: true, force: true }));
  const bash = (script: string, input = "", env: Record<string, string> = {}) =>
    spawnSync("bash", ["-c", script], { input, encoding: "utf8", env: { ...process.env, ...env } });

  it.skipIf(!bashOk)("the host-side filter (grep -E, grep -v, awk) prints exactly the lines the RegExp side keeps, in order", () => {
    expect(filterFn).not.toBe("");
    const mixed = [...DROPPED.slice(0, 5), ...KEPT.slice(0, 6), ...DROPPED.slice(5), ...KEPT.slice(6)];
    const out = bash(`${filterFn}journal_filter`, `${mixed.join("\n")}\n`);
    expect(out.status).toBe(0);
    expect(out.stdout.split("\n").filter(Boolean)).toEqual(mixed.filter(keepJournalLine));
  });

  it.skipIf(!bashOk)(`prints the newest ${JOURNAL_CAP} kept lines and a note when there were more`, () => {
    const many = Array.from({ length: JOURNAL_CAP + 50 }, (_, i) => `2026-10-25T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}+00:00 web7 sudo[${1000 + i}]:   tvance : PWD=/root ; USER=root ; COMMAND=/usr/sbin/nginx -t`);
    const out = bash(`${filterFn}journal_filter`, `${many.join("\n")}\n`).stdout.split("\n").filter(Boolean);
    expect(out).toHaveLength(JOURNAL_CAP + 1);
    expect(out.slice(0, JOURNAL_CAP)).toEqual(many.slice(50));
    expect(out.at(-1)).toBe(`note: ${JOURNAL_CAP + 50} lines kept, the newest ${JOURNAL_CAP} printed`);
  });

  /** The section as the read script runs it, with journalctl, id and sudo replaced by shell functions. */
  const runSection = (o: { groups: string; uid?: string; sudo?: "ok" | "refused"; journalctl?: boolean }) => {
    const fixture = path.join(shDir, "journal.txt");
    const args = path.join(shDir, "args.txt");
    writeFileSync(fixture, `${[...DROPPED, ...KEPT].join("\n")}\n`);
    writeFileSync(args, "");
    const stubs = [
      String.raw`section() { name=$1; arg=$2; shift 2; printf '@@DRIFT@@ BEGIN %s %s\n' "$name" "$arg"; "$@" 2>&1; printf '\n@@DRIFT@@ END %s\n' "$?"; }`,
      `id() { case $1 in -nG) echo "$GROUPS_STUB" ;; -u) echo "$UID_STUB" ;; esac; }`,
      `sudo() { [ "$1" = -n ] || return 1; shift; if [ "$1" = -l ]; then [ "$SUDO_STUB" = ok ]; return; fi; [ "$SUDO_STUB" = ok ] || return 1; "$@"; }`,
      o.journalctl === false ? "command() { return 1; }" : `journalctl() { printf '%s\\n' "$*" >> "$ARGS_FILE"; cat "$FIXTURE_FILE"; }`,
    ].join("\n");
    const out = bash(`${stubs}\n${JOURNAL_SHELL}printf '@@DRIFT@@ DONE\\n'\n`, "", { GROUPS_STUB: o.groups, UID_STUB: o.uid ?? "1000", SUDO_STUB: o.sudo ?? "ok", FIXTURE_FILE: fixture, ARGS_FILE: args });
    return { out, f: parseStream(out.stdout), args: readFileSync(args, "utf8").split("\n").filter(Boolean) };
  };

  it.skipIf(!bashOk)("through sudo -n when the login's groups cannot read the journal: the fixed arguments, a 24-hour window, the kept lines", () => {
    const { out, f, args } = runSection({ groups: "drift" });
    expect(out.status).toBe(0);
    expect(f.complete).toBe(true);
    expect(f.journal).toMatchObject({ rc: 0, via: "sudo", notes: [] });
    expect(f.journal!.lines).toEqual([...DROPPED, ...KEPT].filter(keepJournalLine));
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(new RegExp(`^--utc -o short-iso --no-pager --since \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} ${JOURNAL_MATCHES}$`));
    const since = Date.parse(f.journal!.since!);
    expect(Math.abs(Date.now() - 24 * 3600_000 - since)).toBeLessThan(120_000);
  });

  it.skipIf(!bashOk)("directly, without sudo, for a member of adm, systemd-journal or wheel, and for root", () => {
    for (const groups of ["tvance adm", "systemd-journal tvance", "wheel"]) {
      const { f } = runSection({ groups, sudo: "refused" });
      expect(f.journal).toMatchObject({ rc: 0, via: "group" });
      expect(f.journal!.lines).toHaveLength(KEPT.length);
    }
    expect(runSection({ groups: "root", uid: "0", sudo: "refused" }).f.journal).toMatchObject({ via: "root" });
  });

  it.skipIf(!bashOk)("a refused sudo or a missing journalctl is an empty section with a note, exit 0, and the stream still ends DONE", () => {
    const refused = runSection({ groups: "drift", sudo: "refused" });
    expect(refused.f.complete).toBe(true);
    expect(refused.f.journal).toEqual({ rc: 0, since: refused.f.journal!.since, via: null, lines: [], notes: ["sudo -n refused journalctl; nothing read"] });
    expect(refused.args).toEqual([]);
    const missing = runSection({ groups: "drift", journalctl: false });
    expect(missing.f.complete).toBe(true);
    expect(missing.f.journal).toMatchObject({ rc: 0, via: null, lines: [], notes: ["journalctl not found; nothing read"] });
  });
});

describe("one kept line, one audit_event row", () => {
  const actor = journalActor(r, "tvance");

  it("a sudo tee: actor pseudonymised, the program's basename, the file as resource, the command with its path arguments, the host after it", () => {
    const at = "2026-10-25T15:55:12.000Z";
    expect(rowOf(TEE)).toEqual({
      event_id: journalEventId(T, HOST, at, "3055347", "tee", "/etc/nginx/conf.d/example.conf"),
      tenant_id: T, source: "journal", actor, action: "tee", resource_type: "file", resource_id: "/etc/nginx/conf.d/example.conf",
      old_value: null, new_value: `/usr/bin/tee -- /etc/nginx/conf.d/example.conf on ${HOST}`, occurred_at: at,
    });
  });

  it("an accepted login: ssh_login, a session, the source address as old_value, the method and host as new_value", () => {
    expect(rowOf(LOGIN)).toMatchObject({ actor, action: "ssh_login", resource_type: "session", resource_id: null, old_value: "203.0.113.9", new_value: `publickey on ${HOST}`, occurred_at: "2026-10-25T16:57:21.000Z" });
    const root = rowOf(KEPT[8]);
    expect(root).toMatchObject({ actor: "root", action: "ssh_login", resource_type: "session" });
    expect(root.old_value).toMatch(new RegExp(`^ip-${H6}$`));
  });

  it("systemctl keeps its verb and unit in action; nginx -t is nginx; neither names a file", () => {
    expect(rowOf(KEPT[2])).toMatchObject({ action: "nginx", resource_type: null, resource_id: null, new_value: `/usr/sbin/nginx -t on ${HOST}` });
    expect(rowOf(KEPT[3])).toMatchObject({ action: "systemctl reload nginx", resource_type: null, resource_id: null, new_value: `/usr/bin/systemctl on ${HOST}` });
    expect(rowOf(KEPT[4]).action).toBe("systemctl restart php8.2-fpm");
  });

  it("a file's resource_id is the object_id the collector gives that path: a real-looking name is pseudonymised the same way", () => {
    const sed = rowOf(KEPT[5]);
    expect(sed).toMatchObject({ action: "sed", resource_type: "file", resource_id: redactText(r, "/etc/nginx/sites-available/shop.northwind-demo.com") });
    expect(sed.resource_id).toMatch(new RegExp(`^/etc/nginx/sites-available/host-${H6}\\.com$`));
    expect(sed.new_value).toBe(`/usr/bin/sed -i ${sed.resource_id} on ${HOST}`);
    expect(rowOf(KEPT[7])).toMatchObject({ action: "vim", resource_type: "file", resource_id: redactText(r, "/etc/letsencrypt/renewal/shop.northwind-demo.com.conf") });
  });

  it("certbot and dpkg: no actor, the tool's name, the message redacted", () => {
    expect(rowOf(KEPT[9])).toMatchObject({ actor: null, action: "certbot", resource_type: null, resource_id: null, old_value: null, new_value: `Reloading nginx server after certificate renewal on ${HOST}`, occurred_at: "2026-10-25T03:12:04.000Z" });
    expect(rowOf(KEPT[10])).toMatchObject({ actor: null, action: "dpkg" });
  });

  it("the line's host name field is dropped; journalHost reads the collector's host back off new_value", () => {
    const rows = KEPT.map(rowOf);
    expect(JSON.stringify(rows)).not.toMatch(/\bweb7\b/);
    for (const e of rows) expect(journalHost(e)).toBe(HOST);
    expect(journalHost({ source: "cloudflare", new_value: `x on ${HOST}` })).toBeNull();
  });

  it("event_id: the same line twice is one id, across collections; another tenant, host, pid or time is another", () => {
    expect(rowOf(TEE).event_id).toBe(rowOf(TEE).event_id);
    const other = (c: Partial<JournalContext>) => journalEventRow(r, TEE, { ...ctx, ...c })!.event_id;
    expect(new Set([rowOf(TEE).event_id, other({ tenantId: "lab-2" }), other({ host: pseudonymHost(r, "other") }), rowOf(TEE.replace("[3055347]", "[3055348]")).event_id, rowOf(TEE.replace("15:55:12", "15:55:13")).event_id]).size).toBe(5);
  });

  it("times: short-iso with or without the colon in the offset, Z, fractions, another offset; all to canonical UTC ms", () => {
    expect(parseJournalLine("2026-10-25T15:55:12+00:00 h sudo[1]: x")?.at).toBe("2026-10-25T15:55:12.000Z");
    expect(parseJournalLine("2026-10-25T15:55:12+0000 h sudo[1]: x")?.at).toBe("2026-10-25T15:55:12.000Z");
    expect(parseJournalLine("2026-10-25T17:55:12.123456+02:00 h sudo[1]: x")?.at).toBe("2026-10-25T15:55:12.123Z");
    expect(parseJournalLine("2026-10-25T15:55:12Z h sshd[2]: x")).toMatchObject({ ident: "sshd", pid: "2", message: "x" });
    expect(parseJournalLine("Oct 25 15:55:12 h sudo[1]: x")).toBeNull();
  });

  it("a line the host should not have printed is not stored, and counts as dropped", () => {
    for (const l of DROPPED) expect(journalEventRow(r, l, ctx), l).toBeUndefined();
    const j = parseJournalSection(0, "2026-10-24 17:05:00", [...KEPT, ...DROPPED].join("\n"));
    const { rows, summary } = journalRows(r, j, ctx);
    expect(rows).toHaveLength(KEPT.length);
    expect(summary).toMatchObject({ since: "2026-10-24T17:05:00.000Z", lines: KEPT.length + DROPPED.length, rows: KEPT.length, dropped: DROPPED.length });
    expect(rows.map((e) => e.occurred_at)).toEqual([...rows.map((e) => e.occurred_at)].sort());
  });
});

describe("argument stripping: only the program, flags and paths", () => {
  it.each([
    ["tee", ["--", "/etc/nginx/conf.d/x.conf"], ["--", "/etc/nginx/conf.d/x.conf"]],
    ["sed", ["-i", "s#8081#8091#", "/etc/nginx/x"], ["-i", "/etc/nginx/x"]],
    ["sed", ["-i", "/^#/d", "/etc/nginx/x"], ["-i", "/etc/nginx/x"]], // the script, though path-shaped, is the script
    ["sed", ["-i", "-e", "s/a/b/", "-e", "/^#/d", "/etc/nginx/x"], ["-i", "-e", "-e", "/etc/nginx/x"]],
    ["sed", ["-ne", "s/a/b/p", "/etc/nginx/x"], ["-ne", "/etc/nginx/x"]],
    ["awk", ["-f", "/usr/local/lib/fix.awk", "/etc/nginx/x"], ["-f", "/usr/local/lib/fix.awk", "/etc/nginx/x"]],
    ["awk", ["{print}", "/etc/nginx/x"], ["/etc/nginx/x"]],
    ["cp", ["-p", "/home/tvance/lab.conf", "/etc/nginx/conf.d/lab.conf"], ["-p", "/home/tvance/lab.conf", "/etc/nginx/conf.d/lab.conf"]],
    ["htpasswd", ["-b", "/etc/nginx/.htpasswd", "admin", "S3cretPass"], ["-b", "/etc/nginx/.htpasswd"]],
    ["sed", ["--in-place", "--suffix=.orig", "s/a/b/", "/etc/nginx/x"], ["--in-place", "/etc/nginx/x"]],
    ["tee", ["lab.example"], []], // a relative path cannot be told from a value
    ["nginx", ["-t"], ["-t"]],
  ] as [string, string[], string[]][])("%s %j -> %j", (program, args, kept) => {
    expect(keptArgs(program, args)).toEqual(kept);
  });

  it("no value typed on the command line reaches a row, and a home directory in a path is the user's pseudonym", () => {
    const rows = KEPT.map(rowOf);
    const all = JSON.stringify(rows);
    for (const typed of ["S3cretPass", "admin", "s#8081#8091#", "northwind", "tvance"]) expect(all).not.toContain(typed);
    const cp = rowOf("2026-10-25T17:10:00+00:00 web7 sudo[3070600]:   tvance : PWD=/home/tvance ; USER=root ; COMMAND=/usr/bin/cp -p /home/tvance/lab.conf /etc/nginx/conf.d/lab.conf");
    expect(cp).toMatchObject({ action: "cp", resource_id: "/etc/nginx/conf.d/lab.conf", new_value: `/usr/bin/cp -p /home/${journalActor(r, "tvance")}/lab.conf /etc/nginx/conf.d/lab.conf on ${HOST}` });
  });
});

describe("pseudonymised actors", () => {
  it("a login is the redactor's /home/<login> pseudonym: the summary's login_user, stable under one salt, another under another", () => {
    const a = journalActor(r, "tvance");
    expect(a).toMatch(new RegExp(`^user-${H6}$`));
    expect(a).toBe(pseudonymUser(r, "tvance"));
    expect(r.text("/home/tvance")).toBe(`/home/${a}`);
    expect(journalActor(new Redactor("fixture-salt"), "tvance")).toBe(a);
    expect(journalActor(new Redactor("other-salt"), "tvance")).not.toBe(a);
    expect(journalActor(r, "labtech")).not.toBe(a);
  });

  it("root stays root; a name outside [A-Za-z0-9._-] gets a salted pseudonym, never the name", () => {
    expect(journalActor(r, "root")).toBe("root");
    const odd = journalActor(r, "CORP\\tvance");
    expect(odd).toMatch(new RegExp(`^user-${H6}$`));
    expect(odd).not.toBe(journalActor(new Redactor("other-salt"), "CORP\\tvance"));
  });
});

describe("the rows through the collector and the stores", () => {
  const base = (journal: string | null): string => [
    `${MARK} BEGIN whoami \ndrift\n${MARK} END 0`,
    `${MARK} BEGIN hostname \nweb7\n${MARK} END 0`,
    `${MARK} BEGIN date \n2026-10-25T17:06:00Z\n${MARK} END 0`,
    ...(journal === null ? [] : [`${MARK} BEGIN journal 2026-10-24 17:06:00\nvia: sudo\n${journal}\n${MARK} END 0`]),
    `${MARK} DONE`, "",
  ].join("\n");
  const NOW = new Date("2026-10-25T17:06:01.000Z");

  it("toRows emits one audit_event row per kept line; the journal changes nothing else about the run", () => {
    const withJ = toRows(parseStream(base(KEPT.join("\n"))), { tenantId: T, redactor: r, alias: "web7-alias", now: NOW });
    const without = toRows(parseStream(base(null)), { tenantId: T, redactor: r, alias: "web7-alias", now: NOW });
    expect(withJ.rows.audit_event).toHaveLength(KEPT.length);
    expect(withJ.rows.audit_event.every((e) => e.source === "journal" && e.tenant_id === T && journalHost(e) === HOST)).toBe(true);
    expect(withJ.summary.journal).toMatchObject({ via: "sudo", lines: KEPT.length, rows: KEPT.length, dropped: 0, notes: [] });
    expect(withJ.summary.counts.audit_event).toBe(KEPT.length);
    expect({ ...withJ.rows, audit_event: [] }).toEqual({ ...without.rows, collection_run: [{ ...without.rows.collection_run[0], finished_at: withJ.rows.collection_run[0].finished_at }] });
    expect(without.rows.audit_event).toEqual([]);
    expect(without.summary.journal).toBeNull();
  });

  it("every row is a fixed point of the Store's redaction pass", () => {
    for (const e of KEPT.map(rowOf)) {
      for (const [c, how] of Object.entries(REDACT.audit_event) as [keyof AuditEvent, "text" | "value"][]) {
        const v = e[c];
        if (typeof v === "string") expect(how === "value" ? r.value(v) : r.text(v), `${e.action}.${c}`).toBe(v);
      }
    }
  });

  it("the rows load into sql.js (schema columns, canonical times) and a second insert of the same lines writes none", async () => {
    const rows = KEPT.map(rowOf);
    const engine = await SqlJsEngine.create();
    expect(engine.insertRows("audit_event", rows)).toBe(rows.length);
    expect(engine.insertRows("audit_event", KEPT.map(rowOf))).toBe(0);
  });

  it("storeRows writes them through insertAuditEvents, inside the run", async () => {
    const calls: string[] = [];
    const store = {
      beginRun: async () => { calls.push("begin"); },
      insertObservations: async (x: unknown[]) => x.length,
      upsertInventory: async (x: unknown[]) => x.length,
      insertBackupSnapshot: async () => 1,
      insertBackupItems: async (x: unknown[]) => x.length,
      insertAuditEvents: async (x: AuditEvent[]) => { calls.push(`audit_event ${x.length} ${[...new Set(x.map((e) => e.source))].join(",")}`); return x.length; },
      finishRun: async () => { calls.push("finish"); },
    } as unknown as Store;
    const { rows } = toRows(parseStream(base(KEPT.join("\n"))), { tenantId: T, redactor: r, alias: "web7-alias", now: NOW });
    const written = await storeRows(store, rows);
    expect(written.audit_event).toBe(KEPT.length);
    expect(calls).toEqual(["begin", `audit_event ${KEPT.length} journal`, "finish"]);
  });
});
