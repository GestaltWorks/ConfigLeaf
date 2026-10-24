// The Linux collector on redacted copies of the two real layouts (test/fixtures/nginx/confd: a conf.d
// host with dated .bak files; test/fixtures/nginx/sites: a sites-enabled host with symlinks, a .bak and an
// unlinked site): the parser, the stream protocol, the rows and the DQ gate over them. Fixture names are
// .invalid, addresses are documentation ranges, so the redactor leaves them alone and the assertions
// read as written; one test then substitutes synthetic real-looking names and addresses, in the shapes
// the real hosts carry, and shows nothing of them reaches a row. The ssh aliases here (vps-a, vps-b) are
// stand-ins: toRows takes any alias, and the real ones live in .env (LINUX_HOSTS).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_SHAPED, EMPTY_SHA256, MARK, SSH_ARGS, exportCopyToObjectId, fullIsoToIso, parseLs, parseStream, pseudonymHost, pseudonymUser, readScript, redactText, tarballStem, toRows, type Fetched } from "../src/collectors/linux.ts";
import { analyse, classifyTarget, isDnsName, listenPort, parse, type Malformed } from "../src/collectors/nginx.ts";
import type { ObservationRow } from "../src/collectors/types.ts";
import { parseLinuxHosts } from "../src/config.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { runComplete } from "../src/data/queries.ts";
import { assetId, obsId, runId, snapshotId } from "../src/data/rows.ts";
import { Redactor } from "../src/redactor.ts";

const FIX = fileURLToPath(new URL("./fixtures/nginx/", import.meta.url));
const H6 = "[0-9a-f]{6}";
/** Plain sha256, the hash a `file` row carries (it must equal the export copy's sha256sum); every other row carries the redactor's salted fingerprint. */
const sha = (b: Uint8Array | string): string => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const NOW = new Date("2026-10-24T15:32:01.000Z");

/** Every file under fixtures/nginx/<host>/ except stream.txt, keyed by its absolute path on the host. */
function fixtureFiles(host: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name !== "stream.txt") out.set("/" + path.relative(path.join(FIX, host), p).split(path.sep).join("/"), readFileSync(p));
    }
  };
  walk(path.join(FIX, host));
  return out;
}

const section = (kind: string, arg: string, rc: number, body: string): string => `${MARK} BEGIN ${kind} ${arg}\n${body}\n${MARK} END ${rc}\n`;
const hashLines = (hs: { sha256: string; path: string }[]): string => hs.map((h) => `${h.sha256.replace(/^sha256:/, "")}  ${h.path}`).join("\n");

interface StreamOpts { unreadable?: string[]; skipped?: string[]; extraListing?: Record<string, string>; sha256?: { sha256: string; path: string }[]; tarsha?: { path: string; hashes: { sha256: string; path: string }[] }; done?: boolean; files?: Map<string, Buffer>; /** Extra file sections (path -> bytes) appended after the fixture files. */ extraFiles?: Map<string, Buffer>; text?: string }

/** The host's hand-written stream plus file sections built from the fixture files, as the script would emit them. */
function stream(host: string, o: StreamOpts = {}): string {
  let text = o.text ?? readFileSync(path.join(FIX, host, "stream.txt"), "utf8");
  for (const [dir, line] of Object.entries(o.extraListing ?? {})) text = text.replace(`${MARK} BEGIN ls ${dir}\n`, `${MARK} BEGIN ls ${dir}\n${line}\n`);
  for (const [p, bytes] of [...(o.files ?? fixtureFiles(host)), ...(o.extraFiles ?? [])]) text += section("file", p, 0, bytes.toString("base64"));
  for (const p of o.unreadable ?? []) text += section("file", p, 1, `base64: ${p}: Permission denied`);
  for (const p of o.skipped ?? []) text += section("file", p, 3, "credential-shaped name, not read");
  if (o.sha256) text = text.replace(`${MARK} BEGIN sha256 /home/svc/backup-export\n\n`, `${MARK} BEGIN sha256 /home/svc/backup-export\n${hashLines(o.sha256)}\n`);
  if (o.tarsha) text += section("tarsha", o.tarsha.path, 0, hashLines(o.tarsha.hashes));
  return text + (o.done === false ? "" : `${MARK} DONE\n`);
}

const r = new Redactor("fixture-salt");
const rowsOf = (text: string, alias = "vps-a") => toRows(parseStream(text), { tenantId: "client-a", redactor: r, alias, now: NOW });
const find = (obs: ObservationRow[], object_id: string, setting_path: string): ObservationRow | undefined => obs.find((o) => o.object_id === object_id && o.setting_path === setting_path);

async function gate(rows: ReturnType<typeof rowsOf>["rows"]): Promise<string[][]> {
  const engine = await SqlJsEngine.create();
  engine.loadBundle(rows);
  return (await runComplete(new DataLayer(engine), rows.collection_run[0].run_id)).rows;
}

describe("nginx grammar", () => {
  it("parses directives, blocks, comments and quoted strings; braces and semicolons inside quotes are text", () => {
    const tree = parse(`# comment\nserver {\n  listen 443 ssl; # trailing\n  server_name "a.invalid" 'b.invalid';\n  location ~ "^/x{2}$" { return 200 "ok; {}"; }\n  log_format main '$remote_addr "$request" '\n                  '$status';\n}\n`, "f");
    expect(tree).toHaveLength(1);
    const srv = tree[0];
    expect(srv.name).toBe("server");
    expect(srv.block!.map((d) => [d.name, d.args])).toEqual([
      ["listen", ["443", "ssl"]],
      ["server_name", ["a.invalid", "b.invalid"]],
      ["location", ["~", "^/x{2}$"]],
      ["log_format", ["main", '$remote_addr "$request" ', "$status"]],
    ]);
    expect(srv.block![2].block).toEqual([{ name: "return", args: ["200", "ok; {}"], file: "f", line: 5 }]);
    expect(srv.block![1].line).toBe(4);
  });

  it("honours backslash escapes inside quotes and tolerates a missing final semicolon", () => {
    expect(parse(`add_header X-A "say \\"hi\\""; root /x`, "f").map((d) => d.args)).toEqual([["X-A", 'say "hi"'], ["/x"]]);
  });

  it("reports what nginx would refuse and reads past it: a stray top-level '}', a block open at EOF, a string open at EOF", () => {
    const d: Malformed[] = [];
    const tree = parse("server { listen 80; }\n}\nserver { listen 81; }\n", "f", d);
    expect(tree.map((x) => [x.name, x.block![0].args[0]])).toEqual([["server", "80"], ["server", "81"]]); // the second block is not lost
    expect(d).toEqual([{ file: "f", line: 2, why: "unbalanced '}' at the top level" }]);
    const open: Malformed[] = [];
    expect(parse("http {\n  server { listen 80;\n", "g", open).map((x) => x.name)).toEqual(["http"]);
    expect(open).toEqual([{ file: "g", line: 2, why: "EOF inside a block: '{' never closed" }, { file: "g", line: 1, why: "EOF inside a block: '{' never closed" }]);
    const quote: Malformed[] = [];
    expect(parse(`server_name "a.invalid;\nlisten 80;`, "h", quote)[0].args).toEqual(["a.invalid;\nlisten 80;"]);
    expect(quote).toEqual([{ file: "h", line: 1, why: 'EOF inside a quoted string opened with "' }]);
    expect(parse("server { listen 80; }", "ok", d)).toHaveLength(1);
    expect(d).toHaveLength(1); // a sound file adds nothing
    // through analyse: the fault is on the Analysis, and the block before it is still a server
    const a = analyse(new Map([["/etc/nginx/conf.d/x.conf", "server { listen 80; server_name x.invalid; }\n}\n"]]));
    expect(a.malformed).toEqual([{ file: "/etc/nginx/conf.d/x.conf", line: 2, why: "unbalanced '}' at the top level" }]);
    expect(a.servers.map((s) => s.server_names)).toEqual([["x.invalid"]]);
  });

  it("listenPort, isDnsName, classifyTarget; a trailing dot is the same name", () => {
    expect(["443 ssl http2", "[::]:443 ssl", "*:8080", "127.0.0.1:9000", "80 default_server", "192.0.2.1", "unix:/run/x.sock"].map(listenPort)).toEqual(["443", "443", "8080", "9000", "80", "80", "unix"]);
    expect(["app.invalid", "*.app.invalid", "www.portal.invalid.", "_", "localhost", "~^(?<s>.+)\\.x\\.invalid$", "192.0.2.1", "", "backend"].map(isDnsName)).toEqual([true, true, true, false, false, false, false, false, false]);
    expect(classifyTarget("https://api.upstream.invalid./v1/")).toEqual({ kind: "dns_name", host: "api.upstream.invalid" });
    expect(analyse(new Map([["/etc/nginx/conf.d/x.conf", "server { listen 80; server_name App.Invalid. www.app.invalid.; }"]])).servers[0].server_names).toEqual(["app.invalid", "www.app.invalid"]);
    expect(classifyTarget("http://127.0.0.1:3000")).toEqual({ kind: "loopback", host: "127.0.0.1" });
    expect(classifyTarget("http://localhost:3000/x")).toEqual({ kind: "loopback", host: "localhost" });
    expect(classifyTarget("http://[::1]:3000")).toEqual({ kind: "loopback", host: "::1" });
    expect(classifyTarget("http://192.0.2.1:9000")).toEqual({ kind: "ip", host: "192.0.2.1" });
    expect(classifyTarget("http://[2001:db8::5]:9000/")).toEqual({ kind: "ip", host: "2001:db8::5" });
    expect(classifyTarget("https://API.Upstream.invalid/v1/")).toEqual({ kind: "dns_name", host: "api.upstream.invalid" });
    expect(classifyTarget("http://backend_ws", ["backend_ws"])).toEqual({ kind: "upstream", host: "backend_ws" });
    expect(classifyTarget("http://backend")).toEqual({ kind: "upstream", host: "backend" });
    expect(classifyTarget("http://unix:/run/app.sock:/")).toEqual({ kind: "unix", host: "/run/app.sock" });
    expect(classifyTarget("http://$upstream")).toEqual({ kind: "variable", host: "$upstream" });
    // a variable glued to the port is the URI, not part of the host (measured: 14 such proxy_pass lines on one host)
    expect(classifyTarget("http://127.0.0.1:8000$request_uri")).toEqual({ kind: "loopback", host: "127.0.0.1" });
    expect(classifyTarget("http://192.0.2.9:8080$request_uri")).toEqual({ kind: "ip", host: "192.0.2.9" });
    expect(classifyTarget("https://api.upstream.invalid$request_uri")).toEqual({ kind: "dns_name", host: "api.upstream.invalid" });
    expect(classifyTarget("http://[::1]:8000$request_uri")).toEqual({ kind: "loopback", host: "::1" });
  });
});

describe("analyse: conf.d layout (conf.d layout)", () => {
  const files = new Map([...fixtureFiles("confd")].map(([p, b]) => [p, b.toString("utf8")]));
  const a = analyse(files);

  it("reaches nginx.conf, mime.types, the snippet and the two .conf vhosts; the .bak is standalone; the modules glob is unmatched, not a gap", () => {
    expect(a.entry_found).toBe(true);
    expect(a.loaded).toEqual(["/etc/nginx/conf.d/app.invalid.conf", "/etc/nginx/conf.d/astro.invalid.conf", "/etc/nginx/mime.types", "/etc/nginx/nginx.conf", "/etc/nginx/snippets/ssl-params.conf"]);
    expect(a.standalone).toEqual(["/etc/nginx/conf.d/app.invalid.conf.2026-04-01.bak"]);
    expect(a.unresolved).toEqual([]);
    expect(a.unmatched).toEqual([{ pattern: "/usr/share/nginx/modules/*.conf", file: "/etc/nginx/nginx.conf", line: 7 }]);
    expect(a.upstreams).toEqual([]);
  });

  it("describes each server block: names, listen, cert, locations with proxy_pass, real_ip absent, enabled by reach", () => {
    expect(a.servers.map((s) => [s.file, s.server_names[0], listenPort(s.listen[0]), s.enabled])).toEqual([
      ["/etc/nginx/conf.d/app.invalid.conf", "app.invalid", "80", "yes"],
      ["/etc/nginx/conf.d/app.invalid.conf", "app.invalid", "443", "yes"],
      ["/etc/nginx/conf.d/astro.invalid.conf", "astro.invalid", "443", "yes"],
      ["/etc/nginx/conf.d/app.invalid.conf.2026-04-01.bak", "app.invalid", "80", "no"],
      ["/etc/nginx/conf.d/app.invalid.conf.2026-04-01.bak", "app.invalid", "443", "no"],
    ]);
    const app = a.servers[1];
    expect(app.server_names).toEqual(["app.invalid", "*.app.invalid"]);
    expect(app.listen).toEqual(["443 ssl http2", "[::]:443 ssl http2"]);
    expect(app.ssl_certificate).toEqual(["/etc/letsencrypt/live/app.invalid/fullchain.pem"]);
    expect(app.locations.map((l) => [l.path, l.proxy_pass])).toEqual([["location[/]", ["http://127.0.0.1:3000"]], ["location[/api/]", ["http://127.0.0.1:3001/"]]]);
    expect(app.real_ip).toEqual({ ranges: [], header: null, scope: "absent", via_include: false });
    const astro = a.servers[2];
    expect(astro.root).toEqual(["/var/www/astro"]);
    expect(astro.locations[0].proxy_pass).toEqual(["https://api.upstream.invalid/v1/"]);
    expect(a.servers[4].locations.map((l) => [l.path, l.proxy_pass])).toEqual([["location[/]", ["http://127.0.0.1:3100"]]]);
  });

  it("with no readable entry file, every block is of unknown enablement", () => {
    const without = new Map(files);
    without.delete("/etc/nginx/nginx.conf");
    const b = analyse(without);
    expect(b.entry_found).toBe(false);
    expect(b.servers).toHaveLength(5);
    expect(new Set(b.servers.map((s) => s.enabled))).toEqual(new Set(["unknown"]));
  });
});

describe("analyse: sites-enabled layout (sites-enabled layout)", () => {
  const files = new Map([...fixtureFiles("sites")].map(([p, b]) => [p, b.toString("utf8")]));
  const links = new Map<string, string>();
  for (const e of parseLs(parseStream(stream("sites")).sections.find((s) => s.kind === "ls" && s.arg === "/etc/nginx/sites-enabled")!.body)) {
    links.set(`/etc/nginx/sites-enabled/${e.name}`, path.posix.resolve("/etc/nginx/sites-enabled", e.target!));
  }
  const a = analyse(files, { links });

  it("follows the symlinks, a relative one included, to the regular files; the unlinked file and the .bak are standalone", () => {
    expect(links.get("/etc/nginx/sites-enabled/shop.invalid")).toBe("/etc/nginx/sites-available/shop.invalid");
    expect(a.loaded).toEqual([
      "/etc/nginx/mime.types", "/etc/nginx/nginx.conf", "/etc/nginx/sites-available/default", "/etc/nginx/sites-available/origin.invalid",
      "/etc/nginx/sites-available/portal.invalid", "/etc/nginx/sites-available/shop.invalid", "/etc/nginx/snippets/cf-realip.conf",
    ]);
    expect(a.standalone).toEqual(["/etc/nginx/sites-available/games.invalid", "/etc/nginx/sites-available/portal.invalid.bak"]);
    expect(a.unmatched.map((u) => u.pattern)).toEqual(["/etc/nginx/modules-enabled/*.conf", "/etc/nginx/conf.d/*.conf"]);
    expect(a.unresolved).toEqual([]);
    expect(a.upstreams).toEqual(["backend_ws"]);
  });

  it("real_ip: the list in the block wins and says where it came from; an included list is marked; nothing at http level means absent", () => {
    const by = (name: string, port: string) => a.servers.find((s) => s.server_names[0] === name && listenPort(s.listen[0]) === port)!;
    expect(by("portal.invalid", "443").real_ip).toMatchObject({ scope: "server", header: "CF-Connecting-IP", via_include: false });
    expect(by("portal.invalid", "443").real_ip.ranges).toHaveLength(12);
    expect(by("portal.invalid", "80").real_ip.scope).toBe("absent");
    expect(by("shop.invalid", "443").real_ip).toEqual({ ranges: ["192.0.2.0/27", "198.51.100.0/27", "2001:db8:1::/48"], header: "CF-Connecting-IP", scope: "server", via_include: true });
    expect(by("_", "80").real_ip.scope).toBe("absent");
    expect(by("games.invalid", "80").enabled).toBe("no");
    expect(by("origin.invalid", "443").ssl_certificate).toEqual(["/etc/ssl/cdn-origin/origin.invalid.pem"]);
    expect(by("origin.invalid", "443").locations.map((l) => [l.path, l.proxy_pass])).toEqual([["location[/]", ["http://127.0.0.1:4000"]], ["location[/ws/]", ["http://backend_ws"]]]);
    expect(by("shop.invalid", "443").locations.map((l) => [l.path, l.proxy_pass, l.alias])).toEqual([["location[/]", ["http://192.0.2.1:9000"], []], ["location[/static/]", [], ["/srv/shop/static/"]]]);
  });

  it("an http-level list applies to every reached block that has none of its own, and a block's own list replaces it", () => {
    const withHttp = new Map(files);
    withHttp.set("/etc/nginx/nginx.conf", files.get("/etc/nginx/nginx.conf")!.replace("gzip on;", "gzip on;\n    set_real_ip_from 192.0.2.0/24;\n    real_ip_header X-Forwarded-For;"));
    const b = analyse(withHttp, { links });
    const by = (name: string, port: string) => b.servers.find((s) => s.server_names[0] === name && listenPort(s.listen[0]) === port)!;
    expect(by("_", "80").real_ip).toEqual({ ranges: ["192.0.2.0/24"], header: "X-Forwarded-For", scope: "http", via_include: false });
    expect(by("portal.invalid", "443").real_ip).toMatchObject({ scope: "server", header: "CF-Connecting-IP" });
    expect(by("portal.invalid", "443").real_ip.ranges).toHaveLength(12);
    expect(by("games.invalid", "80").real_ip.scope).toBe("absent"); // not reached from nginx.conf, so the http level does not apply
    // the http level itself is reported once, for the http.real_ip row
    expect(b.http_real_ip).toEqual({ ranges: ["192.0.2.0/24"], header: "X-Forwarded-For", scope: "http", via_include: false });
    expect(a.http_real_ip).toEqual({ ranges: [], header: null, scope: "absent", via_include: false });
    expect(analyse(new Map([["/etc/nginx/conf.d/x.conf", "server { listen 80; }"]])).http_real_ip).toBeNull();
  });
});

describe("stream protocol", () => {
  it("parses the sections, decodes file bodies byte for byte, keeps failed reads as errors, and notices a missing DONE", () => {
    const f = parseStream(stream("confd", { unreadable: ["/etc/nginx/conf.d/private.conf"], skipped: ["/etc/nginx/conf.d/htpasswd"] }));
    expect(f.complete).toBe(true);
    expect(f.login_user).toBe("root");
    expect(f.hostname).toBe("web-1");
    expect(f.server_time).toBe("2026-10-24T15:32:01.000Z");
    expect(f.ip4).toEqual(["198.51.100.23", "192.0.2.3"]);
    expect(f.ip6).toEqual(["2001:db8:10::23"]);
    // link-local is never an inventory address, whatever scope flag the host printed; junk is not an address
    expect(parseStream(`${MARK} BEGIN ip6 \n2: eth0 inet6 fe80::1/64 scope link\n3: eth0 inet6 2001:DB8::5/64 scope global\n4: x inet6 zz::/64 scope global\n${MARK} END 0\n`).ip6).toEqual(["2001:db8::5"]);
    expect(f.listings["/etc/nginx/conf.d"].rc).toBe(0);
    expect(f.listings["/etc/nginx/conf.d"].entries.map((e) => [e.type, e.name, e.mtime])).toEqual([
      ["-", "app.invalid.conf", "2026-04-16T21:30:12.000Z"], ["-", "app.invalid.conf.2026-04-01.bak", "2026-04-01T09:12:44.000Z"], ["-", "astro.invalid.conf", "2026-03-02T17:05:01.000Z"],
    ]);
    expect(f.listings["/etc/nginx/sites-available"]).toEqual({ rc: 2, entries: [], error: "ls: cannot access '/etc/nginx/sites-available': No such file or directory" });
    const app = f.files["/etc/nginx/conf.d/app.invalid.conf"];
    expect(app.ok && Buffer.from(app.bytes).equals(fixtureFiles("confd").get("/etc/nginx/conf.d/app.invalid.conf")!)).toBe(true);
    expect(f.files["/etc/nginx/conf.d/private.conf"]).toEqual({ ok: false, rc: 1, error: "base64: /etc/nginx/conf.d/private.conf: Permission denied" });
    expect(f.files["/etc/nginx/conf.d/htpasswd"]).toEqual({ ok: false, rc: 3, error: "credential-shaped name, not read" });
    expect(f.timers?.entries).toEqual([{ unit: "backup-export.timer", activates: "backup-export.service" }, { unit: "certbot-renew.timer", activates: "certbot-renew.service" }, { unit: "fstrim.timer", activates: "fstrim.service" }]);
    expect(f.export_dir).toMatchObject({ dir: "/var/backups/export", rc: 2, mtime: null, found: [], hashes: [], tar: null, error: "ls: cannot access '/var/backups/export': Permission denied" });
    expect(f.renewals).toEqual({ rc: 1, paths: [], error: "find: '/etc/letsencrypt/renewal': Permission denied" });
    expect(parseStream(stream("confd", { done: false })).complete).toBe(false);
  });

  it("ls lines: symlink targets, SELinux and ACL mode suffixes, full-iso times; find times with ten fractional digits", () => {
    expect(parseLs("lrwxrwxrwx 1 root root 29 2026-06-01 09:00:10.000000000 +0000 shop.invalid -> ../sites-available/shop.invalid")).toEqual([
      { type: "l", mode: "lrwxrwxrwx", size: 29, mtime: "2026-06-01T09:00:10.000Z", name: "shop.invalid", target: "../sites-available/shop.invalid" },
    ]);
    expect(parseLs("-rw-r--r--. 1 root root 981 2026-04-16 21:30:12.123456789 +0200 a b.conf\ntotal 4\n-rw-rw-r--+ 1 u g 1 2026-01-01 00:00:00.000000000 +0000 x").map((e) => [e.name, e.mtime, e.mode])).toEqual([
      ["a b.conf", "2026-04-16T19:30:12.123Z", "-rw-r--r--."], ["x", "2026-01-01T00:00:00.000Z", "-rw-rw-r--+"],
    ]);
    expect(fullIsoToIso("2026-10-24T03:40:02.1234567890+0000")).toBe("2026-10-24T03:40:02.123Z");
    expect(fullIsoToIso("2026-10-24 03:40:02 +0000")).toBe("2026-10-24T03:40:02.000Z");
    expect(fullIsoToIso("yesterday")).toBeNull();
  });
});

describe("rows: conf.d layout (conf.d layout)", () => {
  const { rows, summary } = rowsOf(stream("confd"));
  const obs = rows.observation;
  const files = fixtureFiles("confd");

  it("asserts the population from the listing before parsing, observes all of it, and passes the DQ gate", async () => {
    expect(summary.population).toEqual(["/etc/nginx/conf.d/app.invalid.conf", "/etc/nginx/conf.d/app.invalid.conf.2026-04-01.bak", "/etc/nginx/conf.d/astro.invalid.conf"]);
    expect(rows.collection_run).toHaveLength(1);
    const run = rows.collection_run[0];
    expect(run).toMatchObject({ tenant_id: "client-a", surface: "linux.nginx", expected_count: 3, observed_count: 3, status: "complete", started_at: "2026-10-24T15:32:01.000Z" });
    expect(run.run_id).toBe(runId("client-a", "linux.nginx", run.host, "2026-10-24T15:32:01.000Z"));
    expect(run.run_id).toMatch(/^run-[0-9a-f]{16}$/);
    expect(await gate(rows)).toEqual([]);
  });

  it("the host is the alias's pseudonym; the machine's hostname is an observation displayed as its own pseudonym; the login user and clock skew are in the summary", () => {
    const run = rows.collection_run[0];
    expect(run.host).toMatch(new RegExp(`^host-${H6}$`));
    expect(run.host).toBe(pseudonymHost(r, "vps-a"));
    expect(run.host).not.toBe(pseudonymHost(r, "web-1"));
    expect(find(obs, "system", "hostname")).toMatchObject({ value_hash: r.fingerprint("web-1"), value_redacted: pseudonymHost(r, "web-1"), refers_to_type: null });
    expect(find(obs, "system", "hostname")!.value_hash).not.toBe(sha("web-1")); // a guessed hostname confirms nothing against the stored hash
    expect(summary.hostname).toBe(pseudonymHost(r, "web-1"));
    expect(summary.login_user).toBe("root");
    expect(summary.clock_skew_ms).toBe(0);
  });

  it("one file row per fetched nginx file, hashed over the bytes, displayed redacted", () => {
    const fileRows = obs.filter((o) => o.setting_path === "file");
    expect(fileRows.map((o) => o.object_id)).toEqual([...files.keys()].sort());
    for (const o of fileRows) {
      expect(o.value_hash).toBe(sha(files.get(o.object_id)!));
      expect(o.value_redacted).toBe(files.get(o.object_id)!.toString("utf8"));
    }
  });

  it("server rows: keyed by first server_name and port, with referents for names, external proxy targets and certificates; value_hash is the salted fingerprint", () => {
    const app = "/etc/nginx/conf.d/app.invalid.conf";
    expect(find(obs, app, "server[app.invalid:443].server_name")).toMatchObject({ value_hash: r.fingerprint("app.invalid *.app.invalid"), value_redacted: "app.invalid *.app.invalid", refers_to_type: null, refers_to_id: null });
    expect(find(obs, app, "server[app.invalid:443].server_name[*.app.invalid]")).toMatchObject({ value_redacted: "*.app.invalid", refers_to_type: "dns_name", refers_to_id: "*.app.invalid" });
    expect(find(obs, app, "server[app.invalid:443].server_name[app.invalid]")).toMatchObject({ refers_to_type: "dns_name", refers_to_id: "app.invalid" });
    // the .zone sibling: the name's last two labels, the wildcard's star dropped, so a '*.<zone>' record can be matched to it after redaction
    expect(find(obs, app, "server[app.invalid:443].server_name[app.invalid].zone")).toMatchObject({ value_redacted: "app.invalid", value_hash: r.fingerprint("app.invalid"), refers_to_type: null, refers_to_id: null });
    expect(find(obs, app, "server[app.invalid:443].server_name[*.app.invalid].zone")).toMatchObject({ value_redacted: "app.invalid" });
    expect(find(obs, "/etc/nginx/nginx.conf", "http.real_ip")).toMatchObject({ value_redacted: "absent", value_hash: r.fingerprint("absent"), refers_to_type: null });
    expect(find(obs, app, "server[app.invalid:443].listen")).toMatchObject({ value_redacted: "443 ssl http2; [::]:443 ssl http2" });
    expect(find(obs, app, "server[app.invalid:443].ssl_certificate")).toMatchObject({ value_redacted: "/etc/letsencrypt/live/app.invalid/fullchain.pem", refers_to_type: "cert", refers_to_id: "/etc/letsencrypt/live/app.invalid/fullchain.pem" });
    expect(find(obs, app, "server[app.invalid:443].real_ip")).toMatchObject({ value_redacted: "absent", value_hash: r.fingerprint("absent") });
    // the same value under another salt is another hash, and the plain sha256 of the value is never stored
    expect(r.fingerprint("absent")).not.toBe(new Redactor("other-salt").fingerprint("absent"));
    expect(obs.filter((o) => o.setting_path !== "file").some((o) => o.value_hash === sha("absent") || o.value_hash === sha("app.invalid"))).toBe(false);
    expect(find(obs, app, "server[app.invalid:443].enabled")).toMatchObject({ value_redacted: "1" });
    expect(find(obs, app, "server[app.invalid:443].location[/].proxy_pass")).toMatchObject({ value_redacted: "http://127.0.0.1:3000", refers_to_type: null, refers_to_id: null });
    expect(find(obs, app, "server[app.invalid:443].location[/api/].proxy_pass")).toMatchObject({ value_redacted: "http://127.0.0.1:3001/", refers_to_type: null });
    expect(find(obs, app, "server[app.invalid:80].listen")).toMatchObject({ value_redacted: "80; [::]:80" });
    const astro = "/etc/nginx/conf.d/astro.invalid.conf";
    expect(find(obs, astro, "server[astro.invalid:443].location[/api/].proxy_pass")).toMatchObject({ value_redacted: "https://api.upstream.invalid/v1/", refers_to_type: "dns_name", refers_to_id: "api.upstream.invalid" });
    expect(find(obs, astro, "server[astro.invalid:443].root")).toMatchObject({ value_redacted: "/var/www/astro" });
    const bak = "/etc/nginx/conf.d/app.invalid.conf.2026-04-01.bak";
    expect(find(obs, bak, "server[app.invalid:443].enabled")).toMatchObject({ value_redacted: "0" });
    expect(find(obs, bak, "server[app.invalid:443].location[/].proxy_pass")).toMatchObject({ value_redacted: "http://127.0.0.1:3100" });
    expect(find(obs, bak, "server[app.invalid:443].location[/api/].proxy_pass")).toBeUndefined();
    expect(summary.server_names).toEqual(["*.app.invalid", "app.invalid", "astro.invalid"]);
    expect(summary.dns_referents).toEqual(["*.app.invalid", "api.upstream.invalid", "app.invalid", "astro.invalid"]);
  });

  it("timers, inventory assets, and what was not readable; no backup rows when the export folder is closed", () => {
    expect(obs.filter((o) => o.object_id === "systemd").map((o) => [o.setting_path, o.value_redacted])).toEqual([
      ["timer[backup-export.timer]", "backup-export.service"], ["timer[certbot-renew.timer]", "certbot-renew.service"], ["timer[fstrim.timer]", "fstrim.service"],
    ]);
    const host = rows.collection_run[0].host;
    expect(rows.inventory_asset.map((a) => [a.address, a.kind, a.host, a.source])).toEqual([["198.51.100.23", "vps", host, "ssh"], ["192.0.2.3", "vps", host, "ssh"], ["2001:db8:10::23", "vps", host, "ssh"]]);
    expect(rows.backup_snapshot).toEqual([]);
    expect(rows.backup_item).toEqual([]);
    expect(summary.not_readable).toEqual(["/etc/nginx/sites-available", "/etc/nginx/sites-enabled", "/var/backups/export", "/etc/letsencrypt/renewal"]);
    expect(summary.export).toMatchObject({ dir: "/var/backups/export", readable: false, nginx_copies: 0, snapshots: 0, tarballs: 0, newest_tarball: null, empty_members: [] });
    expect(summary.renewals).toEqual({ readable: false, count: 0 });
    expect(summary.unresolved_includes).toEqual([]);
    expect(summary.malformed).toEqual([]);
    expect(summary.standalone).toEqual(["/etc/nginx/conf.d/app.invalid.conf.2026-04-01.bak"]);
    expect(summary.counts).toEqual({ collection_run: 1, observation: obs.length, inventory_asset: 3, backup_snapshot: 0, backup_item: 0 });
  });

  it("an unreadable nginx.conf makes the run partial: nothing can say what is served, http.real_ip is 'unknown', the entry is not readable, the gate holds it", async () => {
    const files = new Map([...fixtureFiles("confd")].filter(([p]) => p !== "/etc/nginx/nginx.conf"));
    const { rows, summary } = rowsOf(stream("confd", { files, unreadable: ["/etc/nginx/nginx.conf"] }));
    expect(rows.collection_run[0]).toMatchObject({ expected_count: 3, observed_count: 3, status: "partial" });
    expect(find(rows.observation, "/etc/nginx/nginx.conf", "http.real_ip")).toMatchObject({ value_redacted: "unknown", value_hash: r.fingerprint("unknown") });
    expect(new Set(rows.observation.filter((o) => o.setting_path.endsWith(".enabled")).map((o) => o.value_redacted))).toEqual(new Set(["unknown"]));
    expect(summary.not_readable).toContain("/etc/nginx/nginx.conf");
    expect(await gate(rows)).toHaveLength(1);
    // the entry absent from the stream altogether (no section at all) is the same: it was not read
    const silent = rowsOf(stream("confd", { files }));
    expect(silent.rows.collection_run[0].status).toBe("partial");
    expect(silent.summary.not_readable).toContain("/etc/nginx/nginx.conf");
    expect(find(silent.rows.observation, "/etc/nginx/nginx.conf", "http.real_ip")?.value_redacted).toBe("unknown");
  });

  it("every row's columns are schema columns and every timestamp is canonical (the sql.js loader is the referee)", async () => {
    const engine = await SqlJsEngine.create();
    expect(engine.loadBundle(rows)).toEqual(summary.counts);
    for (const o of obs) {
      expect(o.obs_id).toBe(obsId(o.run_id, o.object_id, o.setting_path));
      expect(o.value_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(o.source).toBe("ssh");
      expect(o.authority).toBe(100);
    }
    expect(new Set(obs.map((o) => o.obs_id)).size).toBe(obs.length);
    expect(new Set(obs.map((o) => `${o.object_id}\u001f${o.setting_path}`)).size).toBe(obs.length);
    for (const a of rows.inventory_asset) expect(a.asset_id).toBe(assetId("client-a", a.address));
  });

  it("a file the listing shows but the login cannot read makes the run partial, and the gate fails it", async () => {
    const { rows, summary } = rowsOf(stream("confd", { extraListing: { "/etc/nginx/conf.d": "-rw-------. 1 root root 61 2026-01-10 08:00:00.000000000 +0000 private.conf" }, unreadable: ["/etc/nginx/conf.d/private.conf"] }));
    expect(rows.collection_run[0]).toMatchObject({ expected_count: 4, observed_count: 3, status: "partial" });
    expect(summary.not_readable).toContain("/etc/nginx/conf.d/private.conf");
    expect(await gate(rows)).toHaveLength(1);
  });

  it("a credential-shaped name, whatever its case, is neither population nor observation; a cut stream is partial; no listing at all asserts nothing", async () => {
    const skipped = rowsOf(stream("confd", { extraListing: { "/etc/nginx/conf.d": "-rw-r--r--. 1 root root 61 2026-01-10 08:00:00.000000000 +0000 vendor-api-key.conf\n-rw-r--r--. 1 root root 61 2026-01-10 08:00:00.000000000 +0000 Secrets.conf" }, skipped: ["/etc/nginx/conf.d/vendor-api-key.conf", "/etc/nginx/conf.d/Secrets.conf"] }));
    expect(skipped.rows.collection_run[0]).toMatchObject({ expected_count: 3, observed_count: 3, status: "complete" });
    expect(skipped.summary.skipped).toEqual(["/etc/nginx/conf.d/vendor-api-key.conf", "/etc/nginx/conf.d/Secrets.conf"]);
    expect(skipped.summary.not_readable).not.toContain("/etc/nginx/conf.d/vendor-api-key.conf");
    expect(skipped.rows.observation.some((o) => /Secrets|api-key/.test(o.object_id))).toBe(false);
    for (const name of ["htpasswd", ".htpasswd-admin", "passwd", "zephyr-api-key.conf", "api_key.inc", "apikey.conf", "client-secret.conf", "oauth-token.conf", "credentials.conf", "x.pem", "x.key", "x.crt", "x.p12", "Secrets.conf", "Token.inc", "API_KEY.conf", "X.PEM"]) expect(CREDENTIAL_SHAPED.test(name), name).toBe(true);
    for (const name of ["app.invalid.conf", "default", "keycloak.conf", "x.conf.bak"]) expect(CREDENTIAL_SHAPED.test(name), name).toBe(false);
    const cut = rowsOf(stream("confd", { done: false }));
    expect(cut.rows.collection_run[0].status).toBe("partial");
    const blind = rowsOf(stream("confd", { text: readFileSync(path.join(FIX, "confd", "stream.txt"), "utf8").replace(`${MARK} BEGIN ls /etc/nginx/conf.d\n`, `${MARK} BEGIN ls /etc/nginx/conf.d\nls: cannot open directory '/etc/nginx/conf.d': Permission denied\n${MARK} END 2\n${MARK} BEGIN ls /etc/nginx/none\n`) }));
    expect(blind.rows.collection_run[0]).toMatchObject({ expected_count: null, observed_count: null, status: "partial" });
    expect(await gate(blind.rows)).toHaveLength(1);
  });
});

describe("rows: sites-enabled layout (sites-enabled layout)", () => {
  const files = fixtureFiles("sites");
  const live = (p: string) => files.get(p)!;
  const EXPORT = "/home/svc/backup-export";
  const newest = `${EXPORT}/server-config-2026-10-24.tar.gz`;
  const members = [
    { sha256: sha(live("/etc/nginx/nginx.conf")), path: "etc/nginx/nginx.conf" },
    { sha256: sha(live("/etc/nginx/sites-available/portal.invalid")), path: "etc/nginx/sites-available/portal.invalid" },
    { sha256: sha(live("/etc/nginx/sites-available/shop.invalid").toString("utf8").replace("9000", "9001")), path: "etc/nginx/sites-available/shop.invalid" },
  ];
  const { rows, summary } = rowsOf(stream("sites", { tarsha: { path: newest, hashes: members } }), "vps-b");
  const obs = rows.observation;
  const sa = (name: string) => `/etc/nginx/sites-available/${name}`;

  it("asserts six vhost files, observes six, passes the gate; the login user is pseudonymised; both address families are inventory", async () => {
    expect(rows.collection_run[0]).toMatchObject({ expected_count: 6, observed_count: 6, status: "complete", host: pseudonymHost(r, "vps-b") });
    expect(await gate(rows)).toEqual([]);
    expect(summary.standalone).toEqual([sa("games.invalid"), sa("portal.invalid.bak")]);
    expect(summary.unresolved_includes).toEqual([]);
    expect(summary.login_user).toMatch(new RegExp(`^user-${H6}$`));
    expect(summary.login_user).toBe(pseudonymUser(r, "svc"));
    expect(pseudonymUser(r, "root")).toBe("root");
    expect(rows.inventory_asset.map((a) => a.address)).toEqual(["203.0.113.40", "192.0.2.1", "2001:db8:20::40"]);
  });

  it("a sites-enabled symlink fetched as a file (the old include round did that) is no `file` row of its own: its target holds the bytes", () => {
    const linkPath = "/etc/nginx/sites-enabled/portal.invalid";
    const dup = rowsOf(stream("sites", { tarsha: { path: newest, hashes: members }, extraFiles: new Map([[linkPath, live(sa("portal.invalid"))]]) }), "vps-b");
    expect(dup.rows.observation.filter((o) => o.object_id.startsWith("/etc/nginx/sites-enabled/"))).toEqual([]);
    expect(dup.rows.observation.filter((o) => o.setting_path === "file").map((o) => o.object_id)).toEqual(obs.filter((o) => o.setting_path === "file").map((o) => o.object_id));
    expect(dup.rows.observation).toHaveLength(obs.length);
    expect(dup.rows.collection_run[0].status).toBe("complete");
  });

  it("real_ip in effect, the unlinked vhost, the default server, an upstream and an address target, an alias", () => {
    expect(find(obs, sa("portal.invalid"), "server[portal.invalid:443].real_ip")).toMatchObject({ value_redacted: "trusted:12 header:CF-Connecting-IP scope:server" });
    expect(find(obs, sa("portal.invalid"), "server[portal.invalid:80].real_ip")).toMatchObject({ value_redacted: "absent" });
    expect(find(obs, sa("shop.invalid"), "server[shop.invalid:443].real_ip")).toMatchObject({ value_redacted: "trusted:3 header:CF-Connecting-IP scope:server via:include" });
    expect(find(obs, sa("portal.invalid.bak"), "server[portal.invalid:443].real_ip")).toMatchObject({ value_redacted: "absent" });
    expect(find(obs, sa("portal.invalid.bak"), "server[portal.invalid:443].enabled")).toMatchObject({ value_redacted: "0" });
    expect(find(obs, sa("games.invalid"), "server[games.invalid:80].enabled")).toMatchObject({ value_redacted: "0" });
    expect(find(obs, sa("games.invalid"), "server[games.invalid:80].server_name[games.invalid]")).toMatchObject({ refers_to_type: "dns_name", refers_to_id: "games.invalid" });
    expect(find(obs, sa("default"), "server[_:80].server_name")).toMatchObject({ value_redacted: "_", refers_to_type: null });
    expect(obs.filter((o) => o.object_id === sa("default") && o.setting_path.startsWith("server[_:80].server_name["))).toEqual([]);
    expect(find(obs, sa("default"), "server[_:80].root")).toMatchObject({ value_redacted: "/var/www/html" });
    expect(find(obs, sa("origin.invalid"), "server[origin.invalid:443].location[/ws/].proxy_pass")).toMatchObject({ value_redacted: "http://backend_ws", refers_to_type: "upstream", refers_to_id: "backend_ws" });
    expect(find(obs, sa("origin.invalid"), "server[origin.invalid:443].ssl_certificate")).toMatchObject({ refers_to_type: "cert", refers_to_id: "/etc/ssl/cdn-origin/origin.invalid.pem" });
    expect(find(obs, sa("shop.invalid"), "server[shop.invalid:443].location[/].proxy_pass")).toMatchObject({ value_redacted: "http://192.0.2.1:9000", refers_to_type: "ip", refers_to_id: "192.0.2.1" });
    expect(find(obs, sa("shop.invalid"), "server[shop.invalid:443].location[/static/].alias")).toMatchObject({ value_redacted: "/srv/shop/static/" });
    expect(summary.server_names).toEqual(["_", "games.invalid", "origin.invalid", "portal.invalid", "shop.invalid", "www.origin.invalid", "www.portal.invalid"]);
    expect(summary.servers.find((s) => s.key === "server[portal.invalid:443]" && s.object_id === sa("portal.invalid"))).toMatchObject({ enabled: "yes", proxy_pass: ["http://127.0.0.1:8080/"] });
  });

  it("backup export as tarballs: one snapshot per tarball of the family that holds etc/nginx (the app dumps written 52 ms later are not it), items for the newest from its members, hashes comparable with the live file rows; the home path is pseudonymised", () => {
    expect(["server-config-2026-10-24.tar.gz", "server_config.20261024T034002.tgz", "operator-admin-2026-10-16.tar.gz", "backup.tar"].map(tarballStem)).toEqual(["server-config", "server_config", "operator-admin", "backup"]);
    expect(rows.backup_snapshot).toHaveLength(2);
    const [older, latest] = rows.backup_snapshot;
    expect(older).toMatchObject({ tenant_id: "client-a", host: rows.collection_run[0].host, kind: "export", taken_at: "2026-10-23T03:40:06.039Z" });
    expect(latest).toMatchObject({ kind: "export", taken_at: "2026-10-24T03:40:02.000Z" });
    expect(latest.snapshot_id).toBe(snapshotId("client-a", latest.host, "export", latest.source_ref!));
    expect(latest.snapshot_id).toMatch(/^snap-[0-9a-f]{16}$/);
    expect(older.source_ref).toMatch(new RegExp(`^/home/user-${H6}/backup-export/server-config-2026-10-23\\.tar\\.gz$`));
    expect(latest.source_ref).toMatch(new RegExp(`^/home/user-${H6}/backup-export/server-config-2026-10-24\\.tar\\.gz$`));
    expect(rows.backup_item.map((i) => [i.snapshot_id, i.object_id, i.setting_path])).toEqual([
      [latest.snapshot_id, "/etc/nginx/nginx.conf", "file"], [latest.snapshot_id, sa("portal.invalid"), "file"], [latest.snapshot_id, sa("shop.invalid"), "file"],
    ]);
    const liveHash = (p: string) => find(obs, p, "file")!.value_hash;
    expect(rows.backup_item[1].value_hash).toBe(liveHash(sa("portal.invalid")));
    expect(rows.backup_item[2].value_hash).not.toBe(liveHash(sa("shop.invalid")));
    expect(summary.export).toMatchObject({ readable: true, mtime: "2026-10-24T03:40:02.000Z", tarballs: 2, nginx_copies: 3, snapshots: 2, empty_members: [] });
    expect(summary.export!.dir).toMatch(new RegExp(`^/home/user-${H6}/backup-export$`));
    expect(summary.export!.newest_tarball).toMatch(new RegExp(`^/home/user-${H6}/backup-export/server-config-2026-10-24\\.tar\\.gz$`));
    expect(summary.export!.top_level[2]).toMatch(new RegExp(`^-rw-r--r-- 611204 2026-10-23T03:40:06\\.039Z server-config-2026-10-23\\.tar\\.gz$`));
    expect(summary.export!.top_level).toHaveLength(5);
    expect(summary.renewals).toEqual({ readable: true, count: 1 });
    expect(find(obs, "/etc/letsencrypt/renewal/portal.invalid.conf", "file")).toMatchObject({ value_hash: sha(live("/etc/letsencrypt/renewal/portal.invalid.conf")) });
    expect(summary.timers).toEqual(["backup-export.timer -> backup-export.service", "certbot.timer -> certbot.service", "apt-daily.timer -> apt-daily.service"]);
  });

  it("a tarball member hashed as the empty input (a symlink: tar -xO prints nothing for it) is no backup item, and the summary says which", () => {
    const withLinks = [
      ...members,
      { sha256: EMPTY_SHA256, path: "etc/nginx/sites-enabled/portal.invalid" },
      { sha256: EMPTY_SHA256, path: "etc/nginx/sites-enabled/shop.invalid" },
      { sha256: EMPTY_SHA256, path: "etc/nginx/modules-enabled/50-mod-http-geoip.conf" },
    ];
    const { rows: w, summary: s } = rowsOf(stream("sites", { tarsha: { path: newest, hashes: withLinks } }), "vps-b");
    expect(w.backup_item.map((i) => i.object_id)).toEqual(["/etc/nginx/nginx.conf", sa("portal.invalid"), sa("shop.invalid")]);
    expect(w.backup_item.some((i) => i.value_hash === `sha256:${EMPTY_SHA256}`)).toBe(false);
    expect(s.export!.empty_members).toEqual(["/etc/nginx/sites-enabled/portal.invalid", "/etc/nginx/sites-enabled/shop.invalid", "/etc/nginx/modules-enabled/50-mod-http-geoip.conf"]);
    expect(s.export!.nginx_copies).toBe(3);
    // the live enabled sites still compare with their own backup copy, not with the empty digest
    const liveHash = (p: string) => find(w.observation, p, "file")!.value_hash;
    expect(w.backup_item.find((i) => i.object_id === sa("portal.invalid"))!.value_hash).toBe(liveHash(sa("portal.invalid")));
  });

  it("plain copies in the export folder are a snapshot of their own; with neither copies nor tarballs the folder itself is one", () => {
    const copies = [{ sha256: sha(live("/etc/nginx/nginx.conf")), path: `${EXPORT}/etc/nginx/nginx.conf` }, { sha256: sha(live("/etc/nginx/sites-available/portal.invalid")), path: `${EXPORT}/etc/nginx/sites-available/portal.invalid` }];
    const both = rowsOf(stream("sites", { sha256: copies, tarsha: { path: newest, hashes: members } }), "vps-b");
    expect(both.rows.backup_snapshot.map((s) => [s.taken_at, s.source_ref!.replace(/user-[0-9a-f]{6}/, "user-X")])).toEqual([
      ["2026-10-23T03:40:06.039Z", "/home/user-X/backup-export/server-config-2026-10-23.tar.gz"],
      ["2026-10-24T03:40:02.000Z", "/home/user-X/backup-export/server-config-2026-10-24.tar.gz"],
      ["2026-10-24T03:40:02.000Z", "/home/user-X/backup-export"],
    ]);
    expect(both.rows.backup_item).toHaveLength(5);
    expect(new Set(both.rows.backup_snapshot.map((s) => s.snapshot_id)).size).toBe(3);
    // no tarsha section: the host found no tarball holding etc/nginx, so every tarball is a snapshot without items
    const noNginx = rowsOf(stream("sites"), "vps-b");
    expect(noNginx.rows.backup_snapshot.map((s) => s.source_ref!.replace(/^.*\//, ""))).toEqual(["app-dump-2026-10-23.tar.gz", "app-dump-2026-10-24.tar.gz", "server-config-2026-10-23.tar.gz", "server-config-2026-10-24.tar.gz"]);
    expect(noNginx.rows.backup_item).toEqual([]);
    const bare = rowsOf(stream("sites", { text: readFileSync(path.join(FIX, "sites", "stream.txt"), "utf8").replace(/^-rw-r--r-- .*\.tar\.gz\n/gm, "") }), "vps-b");
    expect(bare.rows.backup_snapshot.map((s) => [s.taken_at, s.source_ref!.replace(/user-[0-9a-f]{6}/, "user-X")])).toEqual([["2026-10-24T03:40:02.000Z", "/home/user-X/backup-export"]]);
    expect(bare.rows.backup_item).toEqual([]);
    expect(exportCopyToObjectId("/var/backups/export/2026-10-23/etc/nginx/conf.d/a.conf")).toBe("/etc/nginx/conf.d/a.conf");
    expect(exportCopyToObjectId("etc/nginx/conf.d/a.conf")).toBe("/etc/nginx/conf.d/a.conf");
    expect(exportCopyToObjectId("./etc/nginx/nginx.conf")).toBe("/etc/nginx/nginx.conf");
    expect(exportCopyToObjectId("/var/backups/export/server-config.tar.gz")).toBeNull();
  });
});

describe("redaction before persistence", () => {
  // Synthetic names and addresses in the shape of real ones: the domain was checked unregistered (see test/redactor.test.ts),
  // the addresses are CGNAT, a private /8 and a made-up RIPE prefix, none of them any host's.
  const real = { host: "web-01.bluefin-logistics-zz9q.com", app: "app.bluefin-logistics-zz9q.com", astro: "astro.bluefin-logistics-zz9q.com", api: "api.vendor-zz9q.net", pub: "100.72.5.19", wg: "10.200.7.3", v6: "2a0e:7d44:9c01::23" };
  const swap = (s: string): string => s
    .replace(/\bweb-1\b/g, real.host).replace(/app\.invalid/g, real.app).replace(/astro\.invalid/g, real.astro).replace(/api\.upstream\.invalid/g, real.api)
    .replace(/198\.51\.100\.23/g, real.pub).replace(/192\.0\.2\.3\b/g, real.wg).replace(/2001:db8:10::23/g, real.v6)
    .replace(/fstrim\.timer/g, `sync.${real.app}.timer`).replace(/fstrim\.service/g, `sync.${real.app}.service`);
  const files = new Map([...fixtureFiles("confd")].map(([p, b]) => [swap(p), Buffer.from(swap(b.toString("utf8")))]));
  const text = stream("confd", { text: swap(readFileSync(path.join(FIX, "confd", "stream.txt"), "utf8")), files });
  const { rows, summary } = rowsOf(text);

  it("no real name or address reaches a row or the summary; pseudonyms carry the shapes the hero query joins on", () => {
    const all = JSON.stringify({ rows, summary });
    expect(all).not.toMatch(/bluefin|vendor-zz9q|100\.72\.5|10\.200\.7|2a0e:7d44|web-01/);
    // the .zone sibling carries the zone's pseudonym, the one a Cloudflare '*.<zone>' record gets under the same salt
    expect(rows.observation.find((o) => o.setting_path === `server[${r.text(real.app)}:443].server_name[${r.text(real.app)}].zone`)?.value_redacted).toBe(r.text("bluefin-logistics-zz9q.com"));
    // the redactor handles a leading "*." itself since 24 Oct (it was a gap the collector's sweep covered); both paths agree
    expect(r.text("*.bluefin-logistics-zz9q.com")).toBe(`*.${r.text("bluefin-logistics-zz9q.com")}`);
    expect(redactText(r, "*.bluefin-logistics-zz9q.com")).toBe(`*.${r.text("bluefin-logistics-zz9q.com")}`);
    // a timer unit named after a host (or, with REDACT_WORDS, a label) is redacted in the setting path and in the summary, not only in the value
    const unit = r.text(`sync.${real.app}`); // the whole dotted stem is one host to the redactor
    expect(unit).toMatch(new RegExp(`^host-${H6}\\.com$`));
    expect(rows.observation.find((o) => o.object_id === "systemd" && o.setting_path === `timer[${unit}.timer]`)).toMatchObject({ value_redacted: `${unit}.service` });
    expect(rows.observation.some((o) => o.object_id === "systemd" && /sync|bluefin/.test(o.setting_path))).toBe(false);
    expect(summary.timers).toContain(`${unit}.timer -> ${unit}.service`);
    expect(rows.collection_run[0].host).toBe(pseudonymHost(r, "vps-a"));
    expect(find(rows.observation, "system", "hostname")!.value_redacted).toBe(r.text(real.host).split(".")[0]);
    expect(rows.inventory_asset.map((a) => a.address)).toEqual([r.text(real.pub), r.text(real.wg), r.text(real.v6)]);
    for (const a of rows.inventory_asset) expect(a.address).toMatch(new RegExp(`^ip-${H6}$`));
    const appFile = rows.observation.find((o) => o.setting_path === "file" && o.object_id === `/etc/nginx/conf.d/${r.text(real.app)}.conf`)!;
    expect(appFile).toBeDefined();
    const names = rows.observation.filter((o) => o.refers_to_type === "dns_name").map((o) => o.refers_to_id!);
    expect(names).toContain(r.text(real.app));
    expect(names).toContain(`*.${r.text(real.app)}`);
    expect(names).toContain(r.text(real.api));
    for (const n of names) expect(n).toMatch(new RegExp(`^(\\*\\.)?host-${H6}\\.(com|net)$`));
    const key = `server[${r.text(real.app)}:443]`;
    expect(rows.observation.some((o) => o.setting_path === `${key}.real_ip`)).toBe(true);
    expect(rows.observation.some((o) => o.object_id === `/etc/nginx/conf.d/${r.text(real.app)}.conf.2026-04-01.bak`)).toBe(true);
    expect(rows.observation.find((o) => o.setting_path === `${key}.server_name[*.${r.text(real.app)}]`)).toMatchObject({ value_redacted: `*.${r.text(real.app)}`, refers_to_id: `*.${r.text(real.app)}` });
    expect(appFile.value_redacted).toContain(`server_name ${r.text(real.app)} *.${r.text(real.app)};`);
    // the hash is the salted fingerprint of the canonical value, the display is the pseudonym: a reader sees the shape, a join
    // sees the fingerprint, and a dictionary of guessed names (the published zones, www/dev/api under them) matches nothing
    const sn = rows.observation.find((o) => o.setting_path === `${key}.server_name`)!;
    expect(sn.value_hash).toBe(r.fingerprint(`${real.app} *.${real.app}`));
    expect(sn.value_hash).not.toBe(sha(`${real.app} *.${real.app}`));
    expect(sn.value_redacted).toBe(`${r.text(real.app)} *.${r.text(real.app)}`);
    const guesses = ["bluefin-logistics-zz9q.com", real.app, real.astro, `www.${real.app}`, `${real.app} *.${real.app}`, "web-01"].map(sha);
    expect(rows.observation.filter((o) => o.setting_path !== "file" && guesses.includes(o.value_hash))).toEqual([]);
  });

  it("the sweep after the redactor: the suffixed, dotted-tail and wildcard shapes measured on the real hosts, with the same pseudonym the bare name gets", () => {
    const h = r.text("kestrel-foods-zz9q.com"); // pseudonym of the bare (synthetic) name
    expect(h).toMatch(new RegExp(`^host-${H6}\\.com$`));
    const cases: Record<string, string> = {
      "ssl_certificate /home/svc/.acme.sh/kestrel-foods-zz9q.com_ecc/fullchain.cer;": `ssl_certificate /home/${pseudonymUser(r, "svc")}/.acme.sh/${h}_ecc/fullchain.cer;`,
      "/etc/letsencrypt/live/kestrel-foods-zz9q.com-0001/fullchain.pem": `/etc/letsencrypt/live/${h}-0001/fullchain.pem`,
      "# kept as sites-available/kestrel-foods-zz9q.com.pre-symlink.20250101-000000.": `# kept as sites-available/${h}.pre-symlink.20250101-000000.`,
      "/etc/nginx/conf.d/kestrel-foods-zz9q.com.conf.bak.20250102030405": `/etc/nginx/conf.d/${h}.conf.bak.20250102030405`,
      "/etc/nginx/conf.d/kestrel-foods-zz9q.com.conf.bak-2025-01-03": `/etc/nginx/conf.d/${h}.conf.bak-2025-01-03`,
      "/etc/nginx/conf.d/kestrel-foods-zz9q.com.conf.2025-01-04.bak": `/etc/nginx/conf.d/${h}.conf.2025-01-04.bak`,
      "acme,kestrel-foods-zz9q.com.conf.bak": `acme,${h}.conf.bak`,
      "server_name kestrel-foods-zz9q.com *.kestrel-foods-zz9q.com;": `server_name ${h} *.${h};`,
      "server_name *.kestrel-foods-zz9q.com;": `server_name *.${h};`,
    };
    for (const [input, want] of Object.entries(cases)) expect(redactText(r, input), input).toBe(want);
    // what the redactor's own rules keep, the sweep keeps: extensions, reserved names, the agent's vocabulary, versions, addresses it passes
    for (const s of ["include /etc/nginx/mime.types;", "index index.html index.htm;", "app.invalid.conf.2026-04-01.bak", "www.portal.invalid.2026-04-01.bak", "server_name www.portal.invalid;", "nginx/1.24.0", "server.location./.proxy_pass", "linux.nginx host-7f1c", "allow 203.0.113.0/24;", "o.host, e2.actor", "root@web-01.example.com"]) {
      expect(redactText(r, s), s).toBe(r.text(s));
    }
    for (const [input] of Object.entries(cases)) expect(redactText(r, redactText(r, input))).toBe(redactText(r, input));
  });

  it("pseudonymHost is the redactor's pseudonym for the name, stable per salt, 6 hex", () => {
    expect(pseudonymHost(r, real.host)).toBe(r.text(real.host).split(".")[0]);
    expect(pseudonymHost(r, "web-01")).toBe(r.text("x@web-01").split("@")[1]);
    expect(pseudonymHost(r, "web-01")).toMatch(new RegExp(`^host-${H6}$`));
    expect(pseudonymHost(r, "web-01")).toBe(pseudonymHost(new Redactor("fixture-salt"), "WEB-01"));
    expect(pseudonymHost(r, "web-01")).not.toBe(pseudonymHost(new Redactor("other"), "web-01"));
    expect(pseudonymHost(r, "vps-a")).not.toBe(pseudonymHost(r, "vps-b"));
    expect(pseudonymHost(r, "web-1")).toMatch(new RegExp(`^host-${H6}$`));
    expect(pseudonymHost(r, "host-7f1c00")).toBe("host-7f1c00");
  });
});

describe("the read script and the SSH contract", () => {
  const script = readScript("/var/backups/export");

  it("the hosts come from LINUX_HOSTS (alias=export dir), nothing else is reachable, and the brief's ssh options are fixed", () => {
    expect(parseLinuxHosts("vps-a=/var/backups/export, vps-b=/home/svc/backup-export")).toEqual({ "vps-a": { exportDir: "/var/backups/export" }, "vps-b": { exportDir: "/home/svc/backup-export" } });
    expect(parseLinuxHosts("")).toEqual({});
    expect(() => parseLinuxHosts("vps-a=relative/dir")).toThrow(/absolute path/);
    expect(() => parseLinuxHosts("vps-a=/var/backups/export; id")).toThrow(/absolute path/);
    expect(() => parseLinuxHosts("vps-a")).toThrow(/alias|export dir/);
    expect(() => parseLinuxHosts("bad alias=/x")).toThrow(/alias/);
    expect([...SSH_ARGS]).toEqual(["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"]);
  });

  it("runs only the enumerated read commands, never sudo, never anything that writes", () => {
    const commands = [...script.matchAll(/\bsection \S+ (?:'[^']*'|"[^"]*"|\S+) (\S+)/g)].map((m) => m[1]);
    expect(new Set(commands)).toEqual(new Set(["id", "hostname", "date", "ip", "ls", "base64", "systemctl", "find", "nginx_member_hashes"]));
    expect(script).toMatch(/section timers '' systemctl list-timers --all --no-pager$/m);
    expect(script).toMatch(/ip -4 -o addr show scope global$/m);
    expect(script).toMatch(/ip -6 -o addr show scope global$/m);
    expect(script).toMatch(/section whoami '' id -un$/m);
    expect(script).not.toMatch(/\bsudo\b|\bsu\b|\bdoas\b/);
    expect(script).not.toMatch(/\b(rm|mv|cp|tee|dd|chmod|chown|chgrp|touch|mkdir|ln|truncate|sed -i|apt|apt-get|dnf|yum|pip|npm|curl|wget|nginx -s|certbot|reboot|shutdown|kill)\b/);
    expect(script).not.toMatch(/systemctl (?!list-timers)/);
    expect(script).not.toMatch(/tar -[a-z]*x(?![a-z]*O)/); // every tar extraction is to stdout, never to disk
    expect(script).toMatch(/tar -xOzf/);
    expect(script).toMatch(/tar -tvzf "\$1" \| grep '\^-'/); // regular-file members only: a symlink member would hash as the empty input
    expect(script).toContain("EXP='/var/backups/export'");
    expect(script).toContain("case $(basename -- \"$1\" | tr 'A-Z' 'a-z') in"); // Secrets.conf is as credential-shaped as secrets.conf
    expect(script).toContain("*htpasswd*|*passwd*|*api-key*|*api_key*|*apikey*|*secret*|*token*|*credential*|*.pem|*.key|*.crt|*.cer|*.csr|*.p12|*.pfx");
    expect(script).toContain('[ ! -L "$f" ] || continue'); // the include round never fetches a symlink as a file
    expect(script.trimEnd().endsWith("printf '@@DRIFT@@ DONE\\n'")).toBe(true);
    expect(() => readScript("/var/backups/export; id")).toThrow(/absolute path/);
    expect(() => readScript("relative")).toThrow(/absolute path/);
  });

  it("a Fetched with nothing in it is a failed run that the gate refuses", async () => {
    const empty: Fetched = { complete: false, login_user: null, hostname: null, server_time: null, ip4: [], ip6: [], listings: {}, files: {}, timers: null, export_dir: null, renewals: null, sections: [] };
    const { rows } = toRows(empty, { tenantId: "client-a", redactor: r, alias: "vps-a", now: NOW });
    expect(rows.collection_run[0]).toMatchObject({ expected_count: null, observed_count: null, status: "failed" });
    expect(rows.observation).toEqual([]);
    expect(await gate(rows)).toHaveLength(1);
  });
});
