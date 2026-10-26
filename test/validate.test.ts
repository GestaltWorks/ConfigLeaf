// Copy validation (src/validate/). The nginx-t half runs over test/fixtures/nginx-tree, a small redacted
// tree in the vault's layout, with a fake runner returning the nginx output measured on 24 Oct 2026 round by
// round: the dependencies the parse seeds before round 1, the rounds that catch what it missed, the
// placeholders of each kind, the results, the command line on win32 and elsewhere.
// The vault half commits fixture trees into temporary git repositories under the OS temp directory and reads
// them back through git, one of them committed by the vault module itself (Vault.commitRun over the
// collector's sites-enabled fixture), so the two sides of the layout meet in a test. cf-schema runs per type
// with its dependencies present and absent. The live half
// (VALIDATE_LIVE=true: docker and nginx:1.27, openssl on PATH) runs the real container over the fixture and
// expects the measured ok_with_gaps in 1 round with 3 gaps, and ok over the fixture without its TLS vhost;
// skipped otherwise, with one line.
import { execFileSync } from "node:child_process";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { MARK, parseStream, toRows } from "../src/collectors/linux.ts";
import { NGINX_T_DEFAULT } from "../src/config.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { copyId, validationId, type CopyValidation, type VaultCopy } from "../src/data/rows.ts";
import { Redactor } from "../src/redactor.ts";
import { validateCloudflareCopy, type CfContext } from "../src/validate/cfschema.ts";
import {
  FFDHE2048_PEM, MAX_ROUNDS, ValidateError, commandRunner, missingPaths, nginxArgv, opensslPair, placeholderKind, seededDependencies, splitCommand, toWslPath, validateNginxTree,
  type NginxRun, type NginxRunner, type RunnerOutput,
} from "../src/validate/nginx.ts";
import { validateCopies, type CopyStore } from "../src/validate/run.ts";
import { copyValidationRows, validateCloudflareCommit, validateVaultCommit } from "../src/validate/vault.ts";
import { linuxVaultFiles } from "../src/vault/hook.ts";
import { Vault } from "../src/vault/vault.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = path.join(ROOT, "test", "fixtures", "nginx-tree");
const live = process.env.VALIDATE_LIVE === "true";
if (!live) console.log("validate: live nginx -t and openssl half skipped (set VALIDATE_LIVE=true with docker and nginx:1.27 to run it)");

function readTree(dir: string, base = dir, out = new Map<string, Uint8Array>()): Map<string, Uint8Array> {
  for (const n of readdirSync(dir).sort()) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) readTree(p, base, out);
    else out.set(path.relative(base, p).split(path.sep).join("/"), new Uint8Array(readFileSync(p)));
  }
  return out;
}

function listFiles(dir: string): string[] {
  return existsSync(dir) ? [...readTree(dir).keys()] : [];
}

const FIXTURE_FILES = readTree(FIXTURE);
const TREE = new Map([...FIXTURE_FILES].filter(([k]) => !k.startsWith(".drift/")));
/** The fixture without its TLS vhost: a tree that names no dependency outside itself (nginx.conf's logs sit in /var/log/nginx, which the image holds). */
const TREE_PLAIN = new Map([...TREE].filter(([k]) => k !== "etc/nginx/conf.d/host-aaaaaa.tld.conf"));
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));

const INCLUDE = "/etc/letsencrypt/options-ssl-nginx.conf";
const CERT = "/etc/letsencrypt/live/host-aaaaaa.tld/fullchain.pem";
const KEY = "/etc/letsencrypt/live/host-aaaaaa.tld/privkey.pem";
/** What the fixture's TLS vhost names outside the tree, sorted: seeded before round 1. */
const SEEDED = [CERT, KEY, INCLUDE];
const DH = "/etc/letsencrypt/ssl-dhparams.pem";
const LOG = "/var/log/nginx/host-aaaaaa/access.log";

// The lines nginx:1.27 printed on 24 Oct 2026, verbatim but for the paths of the variants below.
const M_INCLUDE = `open() "${INCLUDE}" failed (2: No such file or directory) in /etc/nginx/conf.d/host-aaaaaa.tld.conf:13`;
const fopen = (p: string) => `(SSL: error:80000002:system library::No such file or directory:calling fopen(${p}, r) error:10000080:BIO routines::no such file)`;
const M_CERT = `cannot load certificate "${CERT}": BIO_new_file() failed ${fopen(CERT)}`;
const M_KEY = `cannot load certificate key "${KEY}": BIO_new_file() failed ${fopen(KEY)}`;
const M_DH = `BIO_new_file("${DH}") failed ${fopen(DH)}`;
const M_LOG = `open() "${LOG}" failed (2: No such file or directory)`;

const OK: RunnerOutput = { exitCode: 0, output: "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful" };
/** A failing round as the container printed it: the entrypoint's line, the error log's copy on stderr, then nginx's own lines. */
const emerg = (msg: string): RunnerOutput => ({
  exitCode: 1,
  output: `/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration\n2026/10/24 18:32:47 [emerg] 1#1: ${msg}\nnginx: [emerg] ${msg}\nnginx: configuration file /etc/nginx/nginx.conf test failed`,
});

const FAKE_PAIR = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n";

interface Seen { round: number; dir: string; files: string[]; mounts: { target: string; readOnly: boolean; content: string }[] }

/** A runner returning one canned output per round (the last one repeats), recording what each round saw on disk. */
function scripted(outputs: readonly RunnerOutput[] | ((round: number) => RunnerOutput)) {
  const seen: Seen[] = [];
  const runner: NginxRunner = async (run: NginxRun) => {
    seen.push({
      round: run.round, dir: run.dir, files: listFiles(run.dir),
      mounts: run.mounts.map((m) => ({ target: m.target, readOnly: m.readOnly, content: readFileSync(m.source, "utf8") })),
    });
    return typeof outputs === "function" ? outputs(run.round) : outputs[Math.min(run.round, outputs.length) - 1];
  };
  return { runner, seen };
}

function counted(pem = FAKE_PAIR) {
  const calls = { n: 0 };
  return { pair: async () => { calls.n++; return pem; }, calls };
}

describe("nginx-t over a tree (fake runner)", () => {
  it("a tree that names no dependency outside itself passes in round 1: ok, no gaps, the tree laid down under {dir}", async () => {
    const { runner, seen } = scripted([OK]);
    const v = await validateNginxTree({ tree: TREE_PLAIN, runner });
    expect(v).toMatchObject({ result: "ok", rounds: 1, missing_dependencies: [], placeholders: [], reason: "nginx -t passed on the tree as restored" });
    expect(v.output).toContain("test is successful");
    expect(seen[0].files).toEqual(["conf.d/host-bbbbbb.tld.conf", "mime.types", "nginx.conf"]);
    expect(seen[0].mounts).toEqual([]);
    expect(path.basename(seen[0].dir)).toBe("nginx");
  });

  it("the fixture tree is pre-seeded: the include, the certificate and the key are in place before round 1, which passes: ok_with_gaps, the seeded paths as gaps, one pair for certificate and key", async () => {
    const { runner, seen } = scripted([OK]);
    const { pair, calls } = counted();
    const v = await validateNginxTree({ tree: TREE, runner, pair });
    expect(v).toMatchObject({ result: "ok_with_gaps", rounds: 1, missing_dependencies: SEEDED });
    expect(v.placeholders).toEqual([{ path: CERT, kind: "pair" }, { path: KEY, kind: "pair" }, { path: INCLUDE, kind: "empty" }]);
    expect(v.reason).toBe("nginx -t passed in round 1 with 3 placeholder(s) for dependencies outside the copy (3 read from the tree before round 1, 0 named by nginx or by a dangling link)");
    expect(seen).toHaveLength(1);
    expect(seen[0].mounts).toEqual([
      { target: CERT, readOnly: true, content: FAKE_PAIR }, { target: KEY, readOnly: true, content: FAKE_PAIR }, { target: INCLUDE, readOnly: true, content: "" },
    ]);
    expect(calls.n).toBe(1);
  });

  it("seededDependencies: the unresolved named includes and the path arguments of the files nginx.conf reaches; what the tree or the image holds, globs, variables and the files it does not reach are left out", () => {
    expect(seededDependencies(TREE)).toEqual([{ path: CERT, kind: "pair" }, { path: KEY, kind: "pair" }, { path: INCLUDE, kind: "empty" }]);
    expect(seededDependencies(TREE_PLAIN)).toEqual([]); // nginx.conf's logs sit in /var/log/nginx, which the image holds
    const site = [
      "server {", "    listen 443 ssl;", "    server_name host-cccccc.tld;",
      `    ssl_certificate ${CERT};`, `    ssl_dhparam ${DH};`, `    access_log ${LOG} main buffer=32k;`, "    error_log stderr;", "    access_log off;",
      "    access_log /dev/null;", "    access_log /var/log/nginx/host-cccccc.log;", "    ssl_trusted_certificate /etc/ssl/certs/$host.pem;",
      "    include snippets/headers.conf;", "    include /etc/letsencrypt/conf.d/*.conf;", "    include /etc/nginx/mime.types;",
      "    location / { proxy_ssl_certificate /etc/nginx/client/proxy.pem; }", "}", "",
    ].join("\n");
    const tree = new Map(TREE_PLAIN)
      .set("etc/nginx/conf.d/host-cccccc.tld.conf", bytes(site))
      .set("etc/nginx/conf.d/host-cccccc.tld.conf.bak", bytes("server { ssl_certificate /etc/letsencrypt/live/old/fullchain.pem; }\n"));
    expect(seededDependencies(tree)).toEqual([
      { path: CERT, kind: "pair" }, { path: DH, kind: "dhparam" }, { path: "/etc/nginx/client/proxy.pem", kind: "pair" },
      { path: "/etc/nginx/snippets/headers.conf", kind: "empty" }, { path: LOG, kind: "log" },
    ]);
    expect(seededDependencies(new Map([["etc/nginx/mime.types", TREE.get("etc/nginx/mime.types")!]]))).toEqual([]); // no nginx.conf, nothing reached
  });

  it("a site reached through a sites-enabled link is read for its dependencies; an unlinked site is left out", () => {
    const nginxConf = Buffer.from(TREE.get("etc/nginx/nginx.conf")!).toString("utf8").replace("include /etc/nginx/conf.d/*.conf;", "include /etc/nginx/conf.d/*.conf;\n    include /etc/nginx/sites-enabled/*;");
    const tree = new Map(TREE_PLAIN)
      .set("etc/nginx/nginx.conf", bytes(nginxConf))
      .set("etc/nginx/sites-available/host-cccccc.tld", bytes(`server {\n    listen 443 ssl;\n    ssl_certificate ${CERT};\n    ssl_certificate_key ${KEY};\n}\n`))
      .set("etc/nginx/sites-available/host-dddddd.tld", bytes("server {\n    ssl_certificate /etc/letsencrypt/live/host-dddddd.tld/fullchain.pem;\n}\n"));
    const links = new Map([["/etc/nginx/sites-enabled/host-cccccc.tld", "../sites-available/host-cccccc.tld"]]);
    expect(seededDependencies(tree, links)).toEqual([{ path: CERT, kind: "pair" }, { path: KEY, kind: "pair" }]);
  });

  it("a path parsing missed is still found by a round: the seeded three, then a snippet nginx names, which sits in the tree itself with no mount", async () => {
    const { runner, seen } = scripted([emerg(`open() "/etc/nginx/snippets/ssl.conf" failed (2: No such file or directory) in /etc/nginx/nginx.conf:11`), OK]);
    const v = await validateNginxTree({ tree: TREE, runner, pair: counted().pair });
    expect(v).toMatchObject({ result: "ok_with_gaps", rounds: 2, missing_dependencies: [...SEEDED, "/etc/nginx/snippets/ssl.conf"] });
    expect(v.reason).toContain("(3 read from the tree before round 1, 1 named by nginx or by a dangling link)");
    expect(seen[0].files).not.toContain("snippets/ssl.conf");
    expect(seen[1].files).toContain("snippets/ssl.conf");
    expect(seen[1].mounts.map((m) => m.target)).toEqual([CERT, KEY, INCLUDE]);
  });

  it("ssl_dhparam gets the ffdhe2048 group, a log path in a directory the image lacks an empty writable file, both before round 1", async () => {
    const tls = Buffer.from(TREE.get("etc/nginx/conf.d/host-aaaaaa.tld.conf")!).toString("utf8")
      .replace(`include ${INCLUDE};`, `include ${INCLUDE};\n    ssl_dhparam ${DH};\n    access_log ${LOG};`);
    const tree = new Map(TREE).set("etc/nginx/conf.d/host-aaaaaa.tld.conf", bytes(tls));
    const { runner, seen } = scripted([OK]);
    const { pair, calls } = counted();
    const v = await validateNginxTree({ tree, runner, pair });
    expect(v).toMatchObject({ result: "ok_with_gaps", rounds: 1, missing_dependencies: [CERT, KEY, INCLUDE, DH, LOG] });
    expect(v.placeholders.filter((p) => p.path === DH || p.path === LOG)).toEqual([{ path: DH, kind: "dhparam" }, { path: LOG, kind: "log" }]);
    expect(seen[0].mounts.filter((m) => m.target === DH || m.target === LOG)).toEqual([{ target: DH, readOnly: true, content: FFDHE2048_PEM }, { target: LOG, readOnly: false, content: "" }]);
    expect(calls.n).toBe(1);
  });

  it("placeholderKind for a path a round names: the directive at the file and line the message points at, else on any line of the tree, else the message", () => {
    const tls = Buffer.from(TREE.get("etc/nginx/conf.d/host-aaaaaa.tld.conf")!).toString("utf8")
      .replace(`include ${INCLUDE};`, `include ${INCLUDE};\n    ssl_dhparam ${DH};\n    access_log ${LOG};`);
    const tree = new Map(TREE).set("etc/nginx/conf.d/host-aaaaaa.tld.conf", bytes(tls));
    expect(placeholderKind(INCLUDE, `nginx: [emerg] ${M_INCLUDE}`, tree)).toBe("empty");
    expect(placeholderKind(CERT, `nginx: [emerg] ${M_CERT}`, tree)).toBe("pair");
    expect(placeholderKind(KEY, `nginx: [emerg] ${M_KEY}`, tree)).toBe("pair");
    expect(placeholderKind(DH, `nginx: [emerg] ${M_DH}`, tree)).toBe("dhparam");
    expect(placeholderKind(LOG, `nginx: [emerg] ${M_LOG}`, tree)).toBe("log");
    expect(placeholderKind("/etc/ssl/other.pem", `nginx: [emerg] cannot load certificate "/etc/ssl/other.pem": BIO_new_file() failed`, tree)).toBe("pair");
    expect(placeholderKind("/etc/nginx/snippets/x.conf", `nginx: [emerg] open() "/etc/nginx/snippets/x.conf" failed (2: No such file or directory)`, tree)).toBe("empty");
  });

  it("a syntax error fails in its round, with nginx's output", async () => {
    const { runner } = scripted([emerg(`unexpected "}" in /etc/nginx/conf.d/host-bbbbbb.tld.conf:6`)]);
    const v = await validateNginxTree({ tree: TREE_PLAIN, runner });
    expect(v).toMatchObject({ result: "fail", rounds: 1, missing_dependencies: [], reason: "nginx refused the configuration" });
    expect(v.output).toBe(`nginx: [emerg] unexpected "}" in /etc/nginx/conf.d/host-bbbbbb.tld.conf:6\nnginx: configuration file /etc/nginx/nginx.conf test failed`);
  });

  it("a user the image lacks (getpwnam) fails; the seeded gaps of the tree are listed all the same", async () => {
    const { runner } = scripted([emerg(`getpwnam("deploy") failed in /etc/nginx/nginx.conf:2`)]);
    const v = await validateNginxTree({ tree: TREE_PLAIN, runner });
    expect(v).toMatchObject({ result: "fail", rounds: 1, missing_dependencies: [] });
    expect(v.output).toContain(`getpwnam("deploy") failed`);
    const seeded = await validateNginxTree({ tree: TREE, runner: scripted([emerg(`getpwnam("deploy") failed in /etc/nginx/nginx.conf:2`)]).runner, pair: counted().pair });
    expect(seeded).toMatchObject({ result: "fail", rounds: 1, missing_dependencies: SEEDED, reason: "nginx refused the configuration" });
  });

  it(`the round cap: a new missing file every round fails at round ${MAX_ROUNDS}`, async () => {
    expect(MAX_ROUNDS).toBe(12);
    const { runner, seen } = scripted((round) => emerg(`open() "/etc/nginx/snippets/r${round}.conf" failed (2: No such file or directory) in /etc/nginx/nginx.conf:11`));
    const v = await validateNginxTree({ tree: TREE_PLAIN, runner });
    expect(v.result).toBe("fail");
    expect(v.rounds).toBe(MAX_ROUNDS);
    expect(v.reason).toContain("round cap");
    const r = Array.from({ length: MAX_ROUNDS }, (_, i) => `/etc/nginx/snippets/r${i + 1}.conf`);
    expect(v.missing_dependencies).toEqual([...r].sort());
    expect(seen.at(-1)!.files.filter((f) => f.startsWith("snippets/")).sort()).toEqual(r.slice(0, MAX_ROUNDS - 1).map((p) => p.replace("/etc/nginx/", "")).sort());
  });

  it("a path named again after its placeholder is in place fails at once: one a round placed, and one placed before round 1", async () => {
    const snippet = emerg(`open() "/etc/nginx/snippets/ssl.conf" failed (2: No such file or directory) in /etc/nginx/nginx.conf:11`);
    const v = await validateNginxTree({ tree: TREE_PLAIN, runner: scripted([snippet, snippet]).runner });
    expect(v).toMatchObject({ result: "fail", rounds: 2, missing_dependencies: ["/etc/nginx/snippets/ssl.conf"] });
    expect(v.reason).toContain("again");
    const seeded = await validateNginxTree({ tree: TREE, runner: scripted([emerg(M_INCLUDE)]).runner, pair: counted().pair });
    expect(seeded).toMatchObject({ result: "fail", rounds: 1, missing_dependencies: SEEDED });
    expect(seeded.reason).toContain("again");
  });

  it("a named path outside the plain-path set gets no placeholder and fails", async () => {
    const { runner, seen } = scripted([emerg(`open() "/etc/x;touch y/a.conf" failed (2: No such file or directory) in /etc/nginx/nginx.conf:11`)]);
    const v = await validateNginxTree({ tree: TREE_PLAIN, runner });
    expect(v).toMatchObject({ result: "fail", rounds: 1 });
    expect(v.reason).toContain("plain-path");
    expect(seen).toHaveLength(1);
  });

  it("an output with no nginx line throws: nginx never read the copy", async () => {
    const runner: NginxRunner = async () => ({ exitCode: 125, output: "wsl: Failed to translate a path\ndocker: Cannot connect to the Docker daemon. Is the docker daemon running?" });
    await expect(validateNginxTree({ tree: TREE_PLAIN, runner })).rejects.toThrow(ValidateError);
    await expect(validateNginxTree({ tree: TREE, runner, pair: counted().pair })).rejects.toThrow(/stopped before nginx: docker: Cannot connect/);
  });

  it("a tree with no etc/nginx/nginx.conf fails in 0 rounds", async () => {
    const { runner, seen } = scripted([OK]);
    const v = await validateNginxTree({ tree: new Map([["etc/nginx/mime.types", TREE.get("etc/nginx/mime.types")!]]), runner });
    expect(v).toMatchObject({ result: "fail", rounds: 0 });
    expect(seen).toHaveLength(0);
  });

  it("a link becomes a copy of its target file; a link whose target the copy lacks is a gap", async () => {
    const site = bytes("server {\n    listen 80;\n    server_name host-cccccc.tld;\n}\n");
    const tree = new Map(TREE_PLAIN).set("etc/nginx/sites-available/host-cccccc.tld", site);
    const links = new Map([
      ["/etc/nginx/sites-enabled/host-cccccc.tld", "../sites-available/host-cccccc.tld"],
      ["etc/nginx/sites-enabled/host-dddddd.tld", "/etc/nginx/sites-available/host-dddddd.tld"],
    ]);
    const seenSite: string[] = [];
    const runner: NginxRunner = async (run) => {
      seenSite.push(readFileSync(path.join(run.dir, "sites-enabled", "host-cccccc.tld"), "utf8"), readFileSync(path.join(run.dir, "sites-enabled", "host-dddddd.tld"), "utf8"));
      return OK;
    };
    const v = await validateNginxTree({ tree, links, runner });
    expect(seenSite).toEqual([Buffer.from(site).toString("utf8"), ""]);
    expect(v).toMatchObject({ result: "ok_with_gaps", rounds: 1, missing_dependencies: ["/etc/nginx/sites-enabled/host-dddddd.tld"] });
  });

  it("the temp directory is removed after the validation, pass or throw", async () => {
    const { runner, seen } = scripted([OK]);
    await validateNginxTree({ tree: TREE_PLAIN, runner });
    expect(existsSync(seen[0].dir)).toBe(false);
    let dir = "";
    const throwing: NginxRunner = async (run) => { dir = run.dir; throw new Error("runner broke"); };
    await expect(validateNginxTree({ tree: TREE, runner: throwing, pair: counted().pair })).rejects.toThrow("runner broke");
    expect(dir).not.toBe("");
    expect(existsSync(dir)).toBe(false);
  });

  it("a tree path with a '..' segment is refused", async () => {
    await expect(validateNginxTree({ tree: new Map([["etc/nginx/../../x", bytes("")]]), runner: scripted([OK]).runner })).rejects.toThrow(ValidateError);
  });

  it("missingPaths reads the four measured message shapes and drops the error log's repeat", () => {
    const lines = [M_INCLUDE, M_CERT, M_KEY, M_DH, M_LOG, M_INCLUDE].map((m) => `nginx: [emerg] ${m}`);
    expect(missingPaths(lines)).toEqual([INCLUDE, CERT, KEY, DH, LOG]);
    expect(missingPaths([`nginx: [emerg] open() "${LOG}" failed (30: Read-only file system)`])).toEqual([]);
    expect(missingPaths([`nginx: [emerg] SSL_CTX_load_verify_locations("/etc/ssl/chain.pem") failed ${fopen("/etc/ssl/chain.pem")}`])).toEqual(["/etc/ssl/chain.pem"]);
  });
});

describe("the command line", () => {
  const run: NginxRun = {
    round: 2,
    dir: "C:\\Users\\tech\\AppData\\Local\\Temp\\drift-nginx-t-AbC123\\etc\\nginx",
    mounts: [
      { source: "C:\\Users\\tech\\AppData\\Local\\Temp\\drift-nginx-t-AbC123\\etc\\letsencrypt\\options-ssl-nginx.conf", target: INCLUDE, readOnly: true },
      { source: "C:\\Users\\tech\\AppData\\Local\\Temp\\drift-nginx-t-AbC123\\var\\log\\nginx\\host-aaaaaa\\access.log", target: LOG, readOnly: false },
    ],
  };

  it("toWslPath gives the /mnt/<drive>/ form", () => {
    expect(toWslPath("C:\\Users\\tech\\AppData\\Local\\Temp\\d\\etc\\nginx")).toBe("/mnt/c/Users/tech/AppData/Local/Temp/d/etc/nginx");
    expect(toWslPath("D:/vault/x")).toBe("/mnt/d/vault/x");
    expect(toWslPath("/tmp/drift-nginx-t-x/etc/nginx")).toBe("/tmp/drift-nginx-t-x/etc/nginx");
    expect(() => toWslPath("\\\\server\\share\\x")).toThrow(ValidateError);
  });

  it("win32 default: wsl.exe, every host path in its /mnt form, the mounts right after docker run", () => {
    expect(nginxArgv(NGINX_T_DEFAULT.win32, run, "win32")).toEqual([
      "wsl.exe", "-d", "Ubuntu-24.04", "--", "docker", "run",
      "-v", `/mnt/c/Users/tech/AppData/Local/Temp/drift-nginx-t-AbC123/etc/letsencrypt/options-ssl-nginx.conf:${INCLUDE}:ro`,
      "-v", `/mnt/c/Users/tech/AppData/Local/Temp/drift-nginx-t-AbC123/var/log/nginx/host-aaaaaa/access.log:${LOG}`,
      "--rm", "-v", "/mnt/c/Users/tech/AppData/Local/Temp/drift-nginx-t-AbC123/etc/nginx:/etc/nginx:ro",
      "nginx:1.27", "nginx", "-t", "-c", "/etc/nginx/nginx.conf",
    ]);
  });

  it("elsewhere: the default docker run with paths as given; {mounts} places the mounts; no mounts, nothing added", () => {
    const posix: NginxRun = { round: 1, dir: "/tmp/d/etc/nginx", mounts: [{ source: "/tmp/d/etc/letsencrypt/options-ssl-nginx.conf", target: INCLUDE, readOnly: true }] };
    expect(nginxArgv(NGINX_T_DEFAULT.other, posix, "linux")).toEqual([
      "docker", "run", "-v", `/tmp/d/etc/letsencrypt/options-ssl-nginx.conf:${INCLUDE}:ro`, "--rm", "-v", "/tmp/d/etc/nginx:/etc/nginx:ro", "nginx:1.27", "nginx", "-t", "-c", "/etc/nginx/nginx.conf",
    ]);
    expect(nginxArgv("podman run --rm {mounts} -v {dir}:/etc/nginx:ro nginx:1.27 nginx -t", posix, "linux")).toEqual([
      "podman", "run", "--rm", "-v", `/tmp/d/etc/letsencrypt/options-ssl-nginx.conf:${INCLUDE}:ro`, "-v", "/tmp/d/etc/nginx:/etc/nginx:ro", "nginx:1.27", "nginx", "-t",
    ]);
    expect(nginxArgv("podman run --rm {mounts} -v {dir}:/etc/nginx:ro nginx:1.27 nginx -t", { ...posix, mounts: [] }, "linux")).toEqual([
      "podman", "run", "--rm", "-v", "/tmp/d/etc/nginx:/etc/nginx:ro", "nginx:1.27", "nginx", "-t",
    ]);
    // win32 with a program other than wsl: paths as given, no conversion.
    expect(nginxArgv("docker.exe run -v {dir}:/etc/nginx:ro nginx:1.27 nginx -t", { ...run, mounts: [] }, "win32")[3]).toBe(`${run.dir}:/etc/nginx:ro`);
  });

  it("refuses a command with no {dir}, mounts with no place to go, and a non-plain path through wsl.exe", () => {
    expect(() => nginxArgv("docker run nginx:1.27 nginx -t", run, "linux")).toThrow(/\{dir\}/);
    expect(() => nginxArgv("ssh builder nginx-check {dir}", run, "linux")).toThrow(/\{mounts\}/);
    expect(() => nginxArgv(NGINX_T_DEFAULT.win32, { ...run, dir: "C:\\Users\\Two Words\\Temp\\d\\etc\\nginx", mounts: [] }, "win32")).toThrow(/plain-path/);
  });

  it("splitCommand keeps a quoted program path whole", () => {
    expect(splitCommand(`"C:\\Program Files\\x\\node.exe" check.mjs {dir}`)).toEqual(["C:\\Program Files\\x\\node.exe", "check.mjs", "{dir}"]);
  });

  it("commandRunner spawns the command with {dir} filled in and collects both streams", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "drift-validate-cmd-"));
    try {
      const script = path.join(scratch, "fake-nginx.mjs");
      writeFileSync(script, [
        "import { readdirSync } from 'node:fs';",
        "const dir = process.argv[2];",
        "console.error('nginx: the configuration file ' + dir + ' holds ' + readdirSync(dir).sort().join(','));",
        "console.error('nginx: configuration file /etc/nginx/nginx.conf test is successful');",
        "console.log('stdout line');",
      ].join("\n"));
      const runner = commandRunner(`"${process.execPath}" "${script}" {dir}`, process.platform);
      const v = await validateNginxTree({ tree: TREE_PLAIN, runner });
      expect(v.result).toBe("ok");
      expect(v.output).toMatch(/holds conf\.d,mime\.types,nginx\.conf/);
      const missing = commandRunner("drift-no-such-program-zz9q run {dir}", "linux");
      await expect(validateNginxTree({ tree: TREE_PLAIN, runner: missing })).rejects.toThrow(/could not start/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("placeholders", () => {
  it("FFDHE2048_PEM is the RFC 7919 ffdhe2048 group: its prime, generator 2", () => {
    const der = Buffer.from(FFDHE2048_PEM.replace(/-----[^-]+-----|\s/g, ""), "base64");
    const RFC7919_FFDHE2048 = [
      "FFFFFFFFFFFFFFFFADF85458A2BB4A9AAFDC5620273D3CF1D8B9C583CE2D3695A9E13641146433FBCC939DCE249B3EF97D2FE363630C75D8",
      "F681B202AEC4617AD3DF1ED5D5FD65612433F51F5F066ED0856365553DED1AF3B557135E7F57C935984F0C70E0E68B77E2A689DAF3EFE872",
      "1DF158A136ADE73530ACCA4F483A797ABC0AB182B324FB61D108A94BB2C8E3FBB96ADAB760D7F4681D4F42A3DE394DF4AE56EDE76372BB19",
      "0B07A7C8EE0A6D709E02FCE1CDF7E2ECC03404CD28342F619172FE9CE98583FF8E4F1232EEF28183C3FE3B1B4C6FAD733BB5FCBC2EC22005",
      "C58EF1837D1683B2C6F34A26C1B2EFFA886B423861285C97FFFFFFFFFFFFFFFF",
    ].join("");
    expect(der.subarray(0, 9).toString("hex")).toBe("308201080282010100");
    expect(der.subarray(9, 265).toString("hex").toUpperCase()).toBe(RFC7919_FFDHE2048);
    expect(der.subarray(265).toString("hex")).toBe("020102");
  });

  it.skipIf(!live)("opensslPair: one PEM, a self-signed certificate for CN=placeholder and the key that matches it", { timeout: 60_000 }, async () => {
    const pem = await opensslPair();
    const cert = new X509Certificate(pem);
    const key = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/.exec(pem)?.[0] ?? "";
    expect(cert.subject).toBe("CN=placeholder");
    expect(cert.checkPrivateKey(createPrivateKey(key))).toBe(true);
  });
});

describe("cf-schema", () => {
  const run = [
    { name: "host-aaaaaa.tld", type: "A", content: "192.0.2.10" },
    { name: "www.host-aaaaaa.tld", type: "CNAME", content: "host-aaaaaa.tld" },
    { name: "*.host-bbbbbb.tld", type: "A", content: "192.0.2.11" },
  ];
  const ctx: CfContext = { recordsOfRun: run, inventory: ["192.0.2.10", "2001:db8::10"], zones: ["host-aaaaaa.tld", "host-bbbbbb.tld"] };
  const check = (type: string, content: string, c: Partial<CfContext> = {}, name = "x.host-aaaaaa.tld") => validateCloudflareCopy({ name, type, content }, { ...ctx, ...c });

  it("A: in the inventory ok, outside it a gap, a non-IPv4 content fails", () => {
    expect(check("A", "192.0.2.10")).toEqual({ result: "ok", missing_dependencies: [], output: "" });
    expect(check("A", "198.51.100.7")).toEqual({ result: "ok_with_gaps", missing_dependencies: ["198.51.100.7"], output: "A content 198.51.100.7 is an address outside the inventory" });
    expect(check("A", "192.0.2.256").result).toBe("fail");
    expect(check("A", "2001:db8::10").result).toBe("fail");
  });

  it("AAAA: in the inventory ok, outside it a gap, a non-IPv6 content fails", () => {
    expect(check("AAAA", "2001:db8::10").result).toBe("ok");
    expect(check("AAAA", "2001:db8::99")).toMatchObject({ result: "ok_with_gaps", missing_dependencies: ["2001:db8::99"] });
    expect(check("AAAA", "192.0.2.10").result).toBe("fail");
  });

  it("CNAME: a target recorded in the run or covered by its wildcard ok; inside a collected zone without a record, or outside the zones, a gap; a non-hostname fails", () => {
    expect(check("CNAME", "host-aaaaaa.tld").result).toBe("ok");
    expect(check("CNAME", "HOST-AAAAAA.tld.").result).toBe("ok");
    expect(check("CNAME", "app.host-bbbbbb.tld").result).toBe("ok");
    expect(check("CNAME", "api.host-aaaaaa.tld")).toEqual({ result: "ok_with_gaps", missing_dependencies: ["api.host-aaaaaa.tld"], output: "CNAME target api.host-aaaaaa.tld has no record in its collected zone host-aaaaaa.tld" });
    expect(check("CNAME", "edge.host-cccccc.tld")).toEqual({ result: "ok_with_gaps", missing_dependencies: ["edge.host-cccccc.tld"], output: "CNAME target edge.host-cccccc.tld is outside the collected zones" });
    expect(check("CNAME", "not a host").result).toBe("fail");
    expect(check("CNAME", "single").result).toBe("fail");
  });

  it("MX: a host, or a priority and a host, or the null MX; anything else fails", () => {
    expect(check("MX", "mx.host-aaaaaa.tld").result).toBe("ok");
    expect(check("MX", "10 mx.host-aaaaaa.tld").result).toBe("ok");
    expect(check("MX", "0 .").result).toBe("ok");
    expect(check("MX", "70000 mx.host-aaaaaa.tld").result).toBe("fail");
    expect(check("MX", "10").result).toBe("fail");
  });

  it("TXT: quoted text ok; empty, over 4096 characters or holding a control character fails", () => {
    expect(check("TXT", '"v=spf1 -all"').result).toBe("ok");
    expect(check("TXT", "").result).toBe("fail");
    expect(check("TXT", "x".repeat(4097)).result).toBe("fail");
    expect(check("TXT", "a\u0001b").result).toBe("fail");
  });

  it("NS: a hostname ok, anything else fails", () => {
    expect(check("NS", "ns1.host-dddddd.tld").result).toBe("ok");
    expect(check("NS", "192.0.2.1").result).toBe("fail");
  });

  it("an unknown type or a bad name fails; another known type needs content", () => {
    expect(check("SPF", "v=spf1 -all")).toMatchObject({ result: "fail", output: `record type "SPF" is outside Cloudflare's record types` });
    expect(check("A", "192.0.2.10", {}, "bad name").result).toBe("fail");
    expect(check("A", "192.0.2.10", {}, "*.host-aaaaaa.tld").result).toBe("ok");
    expect(check("SRV", "10 5 443 sip.host-aaaaaa.tld").result).toBe("ok");
    expect(check("SRV", " ").result).toBe("fail");
  });

  it("the inventory compares through addressKey (a real address meets its pseudonym); unread, the address check is skipped and said", () => {
    const red = new Redactor("validate-test-salt");
    const pseudonym = red.text("8.8.4.4");
    expect(pseudonym).toMatch(/^ip-[0-9a-f]{6}$/);
    expect(check("A", "8.8.4.4", { inventory: [pseudonym], addressKey: (a) => red.text(a) }).result).toBe("ok");
    expect(check("A", "8.8.4.4", { inventory: [pseudonym] }).result).toBe("ok_with_gaps");
    expect(check("A", "198.51.100.7", { inventory: null })).toEqual({ result: "ok", missing_dependencies: [], output: "A content 198.51.100.7: the inventory was not read, so the address was not checked" });
  });
});

// ---- the vault: temporary git repositories --------------------------------------------------------------

const scratchDirs: string[] = [];
afterAll(() => { for (const d of scratchDirs) rmSync(d, { recursive: true, force: true }); });

function scratch(): string {
  const d = mkdtempSync(path.join(tmpdir(), "drift-validate-vault-"));
  scratchDirs.push(d);
  return d;
}

/** One commit of `files` in a repository at `repo` (created when absent), the vault's commit subject. */
function commit(repo: string, files: ReadonlyMap<string, Uint8Array | string>, subject: string): string {
  mkdirSync(repo, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  if (!existsSync(path.join(repo, ".git"))) {
    g("init", "-q");
    for (const [k, v] of [["user.name", "drift-agent"], ["user.email", "drift-agent@localhost"], ["core.autocrlf", "false"], ["commit.gpgsign", "false"]]) g("config", k, v);
  }
  for (const [k, v] of files) {
    const f = path.join(repo, ...k.split("/"));
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, v);
  }
  g("add", "-A");
  g("commit", "-q", "--allow-empty", "-m", subject);
  return g("rev-parse", "HEAD");
}

const RED = new Redactor("validate-test-salt");
const T = "client-t";
const SYNTH = "web.kestrel-foods-zz9q.com";

describe("the vault (git)", () => {
  it("validateVaultCommit reads the commit through git: the tree outside .drift/, the links, the run id; what it returns is redacted", async () => {
    const vault = scratch();
    const site = "server {\n    listen 80;\n    server_name host-cccccc.tld;\n}\n";
    const files = new Map<string, Uint8Array | string>([...FIXTURE_FILES])
      .set("etc/nginx/sites-available/host-cccccc.tld", site)
      .set(".drift/links.json", JSON.stringify({ "/etc/nginx/sites-enabled/host-cccccc.tld": "/etc/nginx/sites-available/host-cccccc.tld" }));
    const sha = commit(path.join(vault, T, "web-01"), files, "run run-validate-1 linux.nginx 2026-10-24T08:00:00.000Z");
    const missing = `/etc/letsencrypt/live/${SYNTH}/fullchain.pem`;
    const { runner, seen } = scripted([emerg(`cannot load certificate "${missing}": BIO_new_file() failed ${fopen(missing)}`), OK]);
    const v = await validateVaultCommit({ vaultDir: vault, tenant: T, alias: "web-01", commit: sha.slice(0, 10), redactor: RED, runner, pair: counted().pair });
    expect(seen[0].files).toEqual(["conf.d/host-aaaaaa.tld.conf", "conf.d/host-bbbbbb.tld.conf", "mime.types", "nginx.conf", "sites-available/host-cccccc.tld", "sites-enabled/host-cccccc.tld"]);
    expect(v).toMatchObject({ repository: `${T}/web-01`, commit: sha, run_id: "run-validate-1", files: 5, links: 1, result: "ok_with_gaps", rounds: 2 });
    // the three the tree names, seeded before round 1, and the one round 1 named
    expect(v.missing_dependencies).toEqual([...SEEDED, RED.text(missing)].sort());
    expect(v.missing_dependencies.filter((p) => !SEEDED.includes(p))[0]).toMatch(/^\/etc\/letsencrypt\/live\/host-[0-9a-f]{6}\.com\/fullchain\.pem$/);
    expect(JSON.stringify(v)).not.toContain("kestrel");
  });

  it("refuses a commit argument that is not hex, and one the repository lacks", async () => {
    const vault = scratch();
    commit(path.join(vault, T, "web-01"), new Map([...FIXTURE_FILES]), "run run-validate-2 linux.nginx 2026-10-24T08:00:00.000Z");
    const base = { vaultDir: vault, tenant: T, alias: "web-01", redactor: RED, runner: scripted([OK]).runner };
    await expect(validateVaultCommit({ ...base, commit: "HEAD~1" })).rejects.toThrow(/hex/);
    await expect(validateVaultCommit({ ...base, commit: "deadbeef" })).rejects.toThrow(/no commit deadbeef/);
    await expect(validateVaultCommit({ ...base, alias: "../x", commit: "deadbeef" })).rejects.toThrow(/plain id/);
  });

  it("validateCloudflareCommit validates every record copy against the commit's records and the inventory; one zone by name or pseudonym", () => {
    const vault = scratch();
    const rec = (id: string, name: string, type: string, content: string, proxied = false) => JSON.stringify({ id, name, type, content, ttl: 1, proxied });
    const files = new Map<string, string>([
      ["host-aaaaaa.tld/a1.json", rec("a1", "host-aaaaaa.tld", "A", "192.0.2.10")],
      ["host-aaaaaa.tld/c1.json", rec("c1", "www.host-aaaaaa.tld", "CNAME", "host-aaaaaa.tld", true)],
      ["host-aaaaaa.tld/c2.json", rec("c2", "shop.host-aaaaaa.tld", "CNAME", SYNTH)],
      ["kestrel-foods-zz9q.com/a2.json", rec("a2", SYNTH, "A", "198.51.100.7")],
      ["kestrel-foods-zz9q.com/x1.json", "{ not json"],
    ]);
    const sha = commit(path.join(vault, T, "cloudflare"), files, "run run-dns-1 cloudflare.dns 2026-10-24T08:00:00.000Z");
    const all = validateCloudflareCommit({ vaultDir: vault, tenant: T, commit: sha, redactor: RED, inventory: ["192.0.2.10"] });
    expect(all).toMatchObject({ repository: `${T}/cloudflare`, commit: sha, run_id: "run-dns-1", zones: 2 });
    const zoneB = RED.text("kestrel-foods-zz9q.com");
    expect(all.records.map((r) => [r.record_id, r.zone, r.type, r.result])).toEqual([
      ["a1", "host-aaaaaa.tld", "A", "ok"],
      ["c1", "host-aaaaaa.tld", "CNAME", "ok"],
      ["c2", "host-aaaaaa.tld", "CNAME", "ok"],
      ["a2", zoneB, "A", "ok_with_gaps"],
      ["x1", zoneB, "", "fail"],
    ]);
    expect(all.records[3].missing_dependencies).toEqual(["198.51.100.7"]);
    expect(JSON.stringify(all)).not.toContain("kestrel");
    const one = validateCloudflareCommit({ vaultDir: vault, tenant: T, commit: sha, redactor: RED, inventory: null, zone: zoneB });
    expect(one.records.map((r) => r.record_id)).toEqual(["a2", "x1"]);
    expect(validateCloudflareCommit({ vaultDir: vault, tenant: T, commit: sha, redactor: RED, inventory: null, zone: "host-aaaaaa.tld" }).records).toHaveLength(3);
    expect(() => validateCloudflareCommit({ vaultDir: vault, tenant: T, commit: sha, redactor: RED, inventory: null, zone: "host-ffffff.tld" })).toThrow(/no zone/);
  });
});

const copy = (run: string, objectId: string, sha: string, surface = "linux.nginx", host: string | null = "web-01"): VaultCopy => ({
  copy_id: copyId(run, objectId), tenant_id: T, surface, host, object_id: objectId, run_id: run, git_commit: sha,
  blob_sha256: `sha256:${"0".repeat(64)}`, taken_at: "2026-10-24T08:00:00.000Z", source: "collector",
});

describe("copy_validation rows", () => {
  it("one row per copy, one shared result; the id from copy, validator and time; gaps by newline; output cut at 2000", async () => {
    const copies = [copy("run-1", "/etc/nginx/nginx.conf", "a".repeat(40)), copy("run-1", "/etc/nginx/mime.types", "a".repeat(40))];
    const at = "2026-10-24T09:00:00.000Z";
    const rows = copyValidationRows(copies, { result: "ok_with_gaps", missing_dependencies: [CERT, INCLUDE], output: "y".repeat(2500) }, { validator: "nginx-t", validatedAt: at });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      validation_id: validationId(copies[0].copy_id, "nginx-t", at), copy_id: copies[0].copy_id, tenant_id: T, validator: "nginx-t", result: "ok_with_gaps",
      missing_dependencies: `${CERT}\n${INCLUDE}`, output_redacted: "y".repeat(2000), validated_at: at,
    });
    expect(rows[1].result).toBe("ok_with_gaps");
    expect(() => copyValidationRows(copies, { result: "ok", missing_dependencies: [], output: "" }, { validator: "nginx-t", validatedAt: "2026-10-24T09:00:00Z" })).toThrow(ValidateError);
    const engine = await SqlJsEngine.create();
    try {
      expect(engine.insertRows("copy_validation", rows)).toBe(2);
      expect(engine.insertRows("copy_validation", rows)).toBe(0);
    } finally {
      engine.close();
    }
  });
});

describe("validateCopies (what npm run validate:copies runs)", () => {
  function fakeStore(copies: VaultCopy[], inventory: string[]) {
    const written: CopyValidation[][] = [];
    const store: CopyStore = {
      vaultCopies: async (t, c) => copies.filter((x) => x.tenant_id === t && x.git_commit === c),
      inventoryAddresses: async () => inventory,
      insertCopyValidations: async (rows) => { written.push([...rows]); return rows.length; },
    };
    return { store, written };
  }

  function estate() {
    const vault = scratch();
    const hostSha = commit(path.join(vault, T, "web-01"), new Map([...FIXTURE_FILES]), "run run-nginx-1 linux.nginx 2026-10-24T08:00:00.000Z");
    const rec = (id: string, name: string, type: string, content: string) => JSON.stringify({ id, name, type, content, ttl: 1, proxied: false });
    const cfSha = commit(path.join(vault, T, "cloudflare"), new Map([
      ["host-aaaaaa.tld/a1.json", rec("a1", "host-aaaaaa.tld", "A", "192.0.2.10")],
      ["host-aaaaaa.tld/c2.json", rec("c2", "shop.host-aaaaaa.tld", "CNAME", "host-cccccc.tld")],
    ]), "run run-dns-1 cloudflare.dns 2026-10-24T08:00:00.000Z");
    const copies = [
      ...["/etc/nginx/conf.d/host-aaaaaa.tld.conf", "/etc/nginx/conf.d/host-bbbbbb.tld.conf", "/etc/nginx/mime.types", "/etc/nginx/nginx.conf"].map((o) => copy("run-nginx-1", o, hostSha)),
      copy("run-dns-1", "a1", cfSha, "cloudflare.dns", null),
      copy("run-dns-1", "c2", cfSha, "cloudflare.dns", null),
    ];
    return { vault, hostSha, cfSha, copies };
  }
  const at = "2026-10-24T09:30:00.000Z";

  it("every repository's latest commit: one line each, one row per vault copy, written in one call", async () => {
    const { vault, hostSha, cfSha, copies } = estate();
    const { store, written } = fakeStore(copies, ["192.0.2.10"]);
    const { runner } = scripted([OK]);
    const res = await validateCopies({ vaultDir: vault, tenant: T, dryRun: false, store, redactor: RED, runner, pair: counted().pair, validatedAt: at });
    expect(res.errors).toBe(0);
    expect(res.lines).toEqual([
      `host web-01 @${hostSha.slice(0, 8)} (run run-nginx-1, 4 files, 0 links): nginx-t ok_with_gaps, 1 round, 3 gaps: ${CERT}, ${KEY}, ${INCLUDE}; 4 vault copies of 4 matched`,
      `cloudflare @${cfSha.slice(0, 8)} (run run-dns-1, 1 zone): cf-schema ok_with_gaps, 2 records (ok 1, ok_with_gaps 1, fail 0), 1 gap: host-cccccc.tld; 2 vault copies of 2 matched`,
    ]);
    expect(res.rows).toHaveLength(6);
    expect(res.written).toBe(6);
    expect(written).toHaveLength(1);
    expect(res.rows.filter((r) => r.validator === "nginx-t").every((r) => r.result === "ok_with_gaps" && r.missing_dependencies === `${CERT}\n${KEY}\n${INCLUDE}`)).toBe(true);
    expect(res.rows.filter((r) => r.validator === "cf-schema").map((r) => r.result)).toEqual(["ok", "ok_with_gaps"]);
  });

  it("--host alone, a dry run: one line, rows built and nothing written; no store: copies unknown", async () => {
    const { vault, copies } = estate();
    const { store, written } = fakeStore(copies, []);
    const dry = await validateCopies({ vaultDir: vault, tenant: T, host: "web-01", dryRun: true, store, redactor: RED, runner: scripted([OK]).runner, pair: counted().pair, validatedAt: at });
    expect(dry.lines).toHaveLength(1);
    expect(dry.lines[0]).toContain(`nginx-t ok_with_gaps, 1 round, 3 gaps: ${CERT}, ${KEY}, ${INCLUDE}; 4 vault copies of 4 matched`);
    expect(dry.rows).toHaveLength(4);
    expect(dry.written).toBeNull();
    expect(written).toHaveLength(0);
    const bare = await validateCopies({ vaultDir: vault, tenant: T, zone: "host-aaaaaa.tld", dryRun: true, store: null, redactor: RED, validatedAt: at });
    expect(bare.lines).toHaveLength(1);
    expect(bare.lines[0]).toContain("cf-schema ok_with_gaps, 2 records (ok 1, ok_with_gaps 1, fail 0)");
    expect(bare.lines[0]).toContain("vault copies unknown (no store); inventory unread (no store), addresses unchecked");
    expect(bare.rows).toEqual([]);
  });

  it("a failing tree prints its reason and last [emerg] line; nginx unavailable is an error line and no row", async () => {
    const { vault, copies } = estate();
    const fail = await validateCopies({ vaultDir: vault, tenant: T, host: "web-01", dryRun: false, store: fakeStore(copies, []).store, redactor: RED, runner: scripted([emerg(`getpwnam("deploy") failed in /etc/nginx/nginx.conf:2`)]).runner, pair: counted().pair, validatedAt: at });
    expect(fail.lines[0]).toContain(`nginx-t fail, 1 round, 3 gaps: ${CERT}, ${KEY}, ${INCLUDE}; 4 vault copies of 4 matched | nginx refused the configuration: [emerg] getpwnam("deploy") failed in /etc/nginx/nginx.conf:2`);
    expect(fail.rows.map((r) => r.result)).toEqual(["fail", "fail", "fail", "fail"]);
    const down: NginxRunner = async () => ({ exitCode: 1, output: "docker: Cannot connect to the Docker daemon" });
    const res = await validateCopies({ vaultDir: vault, tenant: T, host: "web-01", dryRun: false, store: fakeStore(copies, []).store, redactor: RED, runner: down, pair: counted().pair, validatedAt: at });
    expect(res.errors).toBe(1);
    expect(res.lines[0]).toMatch(/^host web-01: validation stopped: the container runtime stopped before nginx: docker: Cannot connect/);
    expect(res.rows).toEqual([]);
    expect(res.written).toBe(0);
  });

  it("--commit needs one repository; an unknown host is an error line", async () => {
    const { vault, hostSha } = estate();
    await expect(validateCopies({ vaultDir: vault, tenant: T, commit: hostSha, dryRun: true, store: null, redactor: RED })).rejects.toThrow(/one commit of one repository/);
    const one = await validateCopies({ vaultDir: vault, tenant: T, host: "web-01", commit: hostSha.slice(0, 7), dryRun: true, store: null, redactor: RED, runner: scripted([OK]).runner, pair: counted().pair });
    expect(one.lines[0]).toContain(`@${hostSha.slice(0, 8)}`);
    const none = await validateCopies({ vaultDir: vault, tenant: T, host: "web-02", dryRun: true, store: null, redactor: RED });
    expect(none).toMatchObject({ errors: 1, lines: [`host web-02: no vault repository for tenant ${T}`] });
    const empty = await validateCopies({ vaultDir: vault, tenant: "client-none", dryRun: true, store: null, redactor: RED });
    expect(empty.lines).toEqual(["no vault repository for tenant client-none"]);
  });

  it("an earlier commit no validation reached is validated beside the head, nginx-t once per tree; a validated one is left alone", async () => {
    const { vault, hostSha, cfSha, copies } = estate();
    // two later runs of the host: the first adds a file, the second (the head) changes nothing, so both hold one tree
    const repo = path.join(vault, T, "web-01");
    const added = commit(repo, new Map([["etc/nginx/conf.d/host-dddddd.tld.conf", "server {\n    listen 80;\n    server_name host-dddddd.tld;\n}\n"]]), "run run-nginx-2 linux.nginx 2026-10-24T08:10:00.000Z");
    const head = commit(repo, new Map(), "run run-nginx-3 linux.nginx 2026-10-24T08:20:00.000Z");
    const objects = [...copies.filter((c) => c.surface === "linux.nginx").map((c) => c.object_id), "/etc/nginx/conf.d/host-dddddd.tld.conf"];
    const later = [...objects.map((o) => copy("run-nginx-2", o, added)), ...objects.map((o) => copy("run-nginx-3", o, head))];
    const { store, written } = fakeStore([...copies, ...later], ["192.0.2.10"]);
    // the first host commit and the DNS commit carry a validation already; the two later commits none
    const withEarlier: CopyStore = { ...store, unvalidatedCommits: async () => [added, head].sort() };
    const { runner, seen } = scripted([OK]);
    const res = await validateCopies({ vaultDir: vault, tenant: T, host: "web-01", dryRun: false, store: withEarlier, redactor: RED, runner, pair: counted().pair, validatedAt: at });
    expect(res.errors).toBe(0);
    // one tree, one nginx-t call of one round; its result goes to both commits' copies
    expect(seen.map((s) => s.round)).toEqual([1]);
    expect(res.lines).toHaveLength(2);
    expect(res.lines[0]).toMatch(new RegExp(`^host web-01 @${head.slice(0, 8)} \\(run run-nginx-3, 5 files, 0 links\\): nginx-t ok_with_gaps, 1 round, .*; 5 vault copies of 5 matched$`));
    expect(res.lines[1]).toBe("host web-01: 1 earlier commit whose copies no validation reached, 1 tree; nginx-t by commit: ok 0, ok_with_gaps 1, fail 0; 5 vault copies of 5 matched");
    expect(res.rows.map((r) => r.copy_id).sort()).toEqual(later.map((c) => c.copy_id).sort());
    expect(res.rows.every((r) => r.validator === "nginx-t" && r.result === "ok_with_gaps")).toBe(true);
    expect(written).toHaveLength(1);
    expect(res.lines.join("\n")).not.toContain(hostSha.slice(0, 8));
    // a commit given: that commit alone, no earlier one
    const one = await validateCopies({ vaultDir: vault, tenant: T, host: "web-01", commit: added, dryRun: true, store: withEarlier, redactor: RED, runner: scripted([OK]).runner, pair: counted().pair, validatedAt: at });
    expect(one.lines).toHaveLength(1);
    expect(one.rows.map((r) => r.copy_id).sort()).toEqual(later.filter((c) => c.git_commit === added).map((c) => c.copy_id).sort());
    // the Cloudflare head's copies stand validated: a store that lists no earlier commit leaves its line as before
    const dns = await validateCopies({ vaultDir: vault, tenant: T, zone: "host-aaaaaa.tld", dryRun: true, store: withEarlier, redactor: RED, validatedAt: at });
    expect(dns.lines).toHaveLength(1);
    expect(dns.lines[0]).toContain(`cloudflare @${cfSha.slice(0, 8)}`);
  });
});

/** The sites-enabled fixture's three enabled TLS vhosts: a certificate and a key each, outside the tree. */
const SITES_SEEDED = [
  "/etc/letsencrypt/live/portal.invalid/fullchain.pem", "/etc/letsencrypt/live/portal.invalid/privkey.pem",
  "/etc/letsencrypt/live/shop.invalid/fullchain.pem", "/etc/letsencrypt/live/shop.invalid/privkey.pem",
  "/etc/ssl/cdn-origin/origin.invalid.key", "/etc/ssl/cdn-origin/origin.invalid.pem",
];

describe("with the vault module (src/vault): its commit is the tree nginx sees", () => {
  it("the collector's sites-enabled fixture committed by Vault.commitRun: every file, each link a copy of its target, the run id, one row per copy", async () => {
    const fix = path.join(ROOT, "test", "fixtures", "nginx", "sites");
    const onHost = new Map<string, Buffer>();
    for (const [k, v] of readTree(fix)) if (k !== "stream.txt") onHost.set(`/${k}`, Buffer.from(v));
    const section = (p: string, body: string): string => `${MARK} BEGIN file ${p}\n${body}\n${MARK} END 0\n`;
    let stream = readFileSync(path.join(fix, "stream.txt"), "utf8");
    for (const [p, b] of onHost) stream += section(p, b.toString("base64"));
    const res = toRows(parseStream(`${stream}${MARK} DONE\n`), { tenantId: T, redactor: RED, alias: "vps-b", now: new Date("2026-10-24T15:32:01.000Z") });
    const run = res.rows.collection_run[0];
    const vaultDir = scratch();
    const c = new Vault(vaultDir, RED).commitRun({ tenantId: T, repo: "vps-b", run, files: linuxVaultFiles(res, RED), links: { ...res.links } });
    const links = Object.entries(res.links);
    expect(links.length).toBeGreaterThan(0);
    const seenLinks: [string, boolean][] = [];
    const runner: NginxRunner = async (r) => {
      for (const [link, target] of links) {
        const copyBytes = readFileSync(path.join(r.dir, ...link.replace(/^\/etc\/nginx\//, "").split("/")));
        seenLinks.push([link, copyBytes.equals(onHost.get(target)!)]);
      }
      return OK;
    };
    const v = await validateVaultCommit({ vaultDir, tenant: T, alias: "vps-b", commit: c.commit, redactor: RED, runner, pair: counted().pair });
    // the three TLS vhosts the links enable name their certificates and keys outside the tree: seeded, so round 1 passes with them as gaps
    expect(v).toMatchObject({ commit: c.commit, run_id: run.run_id, files: c.files, links: links.length, result: "ok_with_gaps", rounds: 1 });
    expect(v.missing_dependencies).toEqual(SITES_SEEDED);
    expect(seenLinks).toEqual(links.map(([l]) => [l, true]));
    const rows = copyValidationRows(c.copies, v, { validator: "nginx-t", validatedAt: "2026-10-24T16:00:00.000Z" });
    expect(rows.map((x) => x.copy_id)).toEqual(c.copies.map((x) => x.copy_id));
  });
});

describe.skipIf(!live)("live nginx -t on the fixture (VALIDATE_LIVE)", () => {
  it("nginx:1.27 over test/fixtures/nginx-tree: ok_with_gaps in 1 round, the include, the certificate and the key seeded before it", { timeout: 900_000 }, async () => {
    const t0 = Date.now();
    const v = await validateNginxTree({ tree: TREE });
    console.log(`validate live: ${v.result}, ${v.rounds} round(s), ${v.missing_dependencies.length} gaps: ${v.missing_dependencies.join(", ")}; ${Date.now() - t0} ms`);
    expect(v.result).toBe("ok_with_gaps");
    expect(v.rounds).toBe(1);
    expect(v.missing_dependencies).toEqual(SEEDED);
    expect(v.placeholders.map((p) => p.kind)).toEqual(["pair", "pair", "empty"]);
    expect(v.output).toContain("test is successful");
  });

  it("nginx:1.27 over the tree with its TLS vhost left out: ok in 1 round, no gaps", { timeout: 900_000 }, async () => {
    const v = await validateNginxTree({ tree: TREE_PLAIN });
    console.log(`validate live (plain): ${v.result}, ${v.rounds} round(s), ${v.missing_dependencies.length} gaps`);
    expect(v).toMatchObject({ result: "ok", rounds: 1, missing_dependencies: [] });
  });
});
