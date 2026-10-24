// nginx configuration parser over a fetched set of files. No nginx binary, no filesystem: the
// collector hands over the bytes it read (src/collectors/linux.ts) and the symlinks it listed, and
// this module answers, per server block, what a technician would ask of `nginx -T` without being
// allowed to run it.
//
// Contract:
//   tokenize/parse   the nginx grammar: directives `name args ;`, blocks `name args { ... }`,
//                    `#` comments, '...' and "..." strings with backslash escapes. A `{` or `}`
//                    inside a regex must be quoted in nginx too, so an unquoted one is structure.
//                    What nginx itself would refuse is not silently swallowed: a stray `}` at the
//                    top level, a block or a quoted string still open at end of file are reported as
//                    `malformed` (file, line, why) and parsing goes on past them, so a file with one
//                    stray brace still yields its other server blocks and the run says it was odd.
//   analyse          starts at the entry file (/etc/nginx/nginx.conf) and expands every include
//                    inside the fetched set. A relative pattern is resolved against the conf prefix
//                    (/etc/nginx/), as nginx does; a glob expands against the fetched paths plus the
//                    listed symlinks (sites-enabled/x -> sites-available/x), so a server block's
//                    `file` is the regular file that holds the bytes. A pattern that matches
//                    nothing in the set, or a matched file that was not fetched, is recorded in
//                    `unresolved`, never guessed at. Server blocks reached this way are enabled.
//                    Every fetched file under a vhost directory that the entry did not reach (a
//                    .bak beside the live file, a sites-available entry with no symlink) is parsed
//                    on its own and its servers are reported as not enabled: present on disk, not
//                    served. With no readable entry file, enabled is "unknown" for every block.
//   real_ip          set_real_ip_from is an array directive: a server-level list replaces the
//                    http-level one, it never merges. A block reports the list in effect, where it
//                    came from (server, http, absent), whether an include carried it, and the
//                    real_ip_header in effect (nginx's default X-Real-IP when none is set).
//   classifyTarget   a proxy_pass host is loopback, an address, a DNS name, an upstream block
//                    name, a unix socket or a variable; only a DNS name is a cross-source referent.
//
// Measured shapes this was written for (24 Oct 2026 survey, both production hosts nginx only):
// RHEL-style conf.d/*.conf with dated .bak files beside them, Debian-style sites-enabled symlinks
// into sites-available with .bak and unlinked files, set_real_ip_from's full Cloudflare list
// present in exactly one vhost, proxy_pass to loopback, to a WireGuard address and to one
// external API host.

export interface Directive {
  name: string;
  args: string[];
  /** Present for a block directive; for `include`, the directives of every matched file, in nginx order. */
  block?: Directive[];
  /** The regular file this directive was read from. */
  file: string;
  line: number;
}

export interface Unresolved { pattern: string; file: string; line: number; matched?: string }

/** Something nginx would refuse to load: where, and why. */
export interface Malformed { file: string; line: number; why: string }

export interface Location {
  /** Dotted setting-path prefix: location[/], location[/].location[/api] for a nested block. */
  path: string;
  proxy_pass: string[];
  alias: string[];
  root: string[];
  file: string;
  line: number;
}

export interface RealIp {
  ranges: string[];
  header: string | null;
  scope: "server" | "http" | "absent";
  via_include: boolean;
}

export interface ServerBlock {
  file: string;
  line: number;
  enabled: "yes" | "no" | "unknown";
  server_names: string[];
  listen: string[];
  ssl_certificate: string[];
  root: string[];
  locations: Location[];
  real_ip: RealIp;
}

export interface Analysis {
  servers: ServerBlock[];
  /** Files the entry reached, the entry included. */
  loaded: string[];
  /** Files under a vhost directory parsed on their own because nothing reached them. */
  standalone: string[];
  /** A named include not in the set, or a glob match that was not fetched: a gap in what we hold. */
  unresolved: Unresolved[];
  /** A glob that matched nothing in the set: empty for nginx too (an empty conf.d, no modules), so informational. */
  unmatched: Unresolved[];
  upstreams: string[];
  entry_found: boolean;
  /** The http-level real_ip in effect for every reached block without a list of its own; null without an entry file or an http block. */
  http_real_ip: RealIp | null;
  /** Grammar faults the parser reported and read past: a stray `}`, an unterminated block or string. */
  malformed: Malformed[];
}

export type FileSet = ReadonlyMap<string, string>;
/** Symlink path -> target path, both absolute. */
export type Links = ReadonlyMap<string, string>;

export const DEFAULT_ENTRY = "/etc/nginx/nginx.conf";
export const DEFAULT_PREFIX = "/etc/nginx/";
export const VHOST_DIRS: readonly string[] = ["/etc/nginx/conf.d", "/etc/nginx/sites-available"];

type Tok = { t: "w" | "{" | "}" | ";"; v: string; line: number };

/** `malformed`, when given, collects a quoted string still open at end of file (the text to EOF is kept as the word). */
export function tokenize(src: string, file = "", malformed?: Malformed[]): Tok[] {
  const out: Tok[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  while (i < n) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "#") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "{" || c === "}" || c === ";") { out.push({ t: c, v: c, line }); i++; continue; }
    if (c === '"' || c === "'") {
      const q = c;
      const start = line;
      let v = "";
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\" && i + 1 < n) {
          const e = src[i + 1];
          v += e === q || e === "\\" ? e : "\\" + e;
          i += 2;
          continue;
        }
        if (src[i] === "\n") line++;
        v += src[i++];
      }
      if (i >= n) malformed?.push({ file, line: start, why: `EOF inside a quoted string opened with ${q}` });
      i++;
      out.push({ t: "w", v, line: start });
      continue;
    }
    let v = "";
    while (i < n && !/[\s;{}]/.test(src[i])) v += src[i++];
    out.push({ t: "w", v, line });
  }
  return out;
}

/**
 * Directives of one file. A `}` at the top level is reported and skipped (nginx: "unexpected }"), a
 * block still open at end of file is reported and closed, an unterminated string is reported by the
 * tokenizer; each goes to `malformed` when given, and parsing continues either way.
 */
export function parse(src: string, file: string, malformed?: Malformed[]): Directive[] {
  const toks = tokenize(src, file, malformed);
  let i = 0;
  const block = (depth: number, openedAt: number): Directive[] => {
    const out: Directive[] = [];
    while (i < toks.length) {
      const t = toks[i];
      if (t.t === "}") {
        i++;
        if (depth > 0) return out;
        malformed?.push({ file, line: t.line, why: "unbalanced '}' at the top level" });
        continue;
      }
      if (t.t === ";") { i++; continue; }
      if (t.t === "{") { i++; block(depth + 1, t.line); continue; }
      const { v: name, line } = t;
      i++;
      const args: string[] = [];
      while (i < toks.length && toks[i].t === "w") args.push(toks[i++].v);
      if (i < toks.length && toks[i].t === "{") { i++; out.push({ name, args, file, line, block: block(depth + 1, line) }); continue; }
      if (i < toks.length && toks[i].t === ";") i++;
      out.push({ name, args, file, line });
    }
    if (depth > 0) malformed?.push({ file, line: openedAt, why: "EOF inside a block: '{' never closed" });
    return out;
  };
  return block(0, 1);
}

/** Directives with every include expanded in place, recursively; each keeps the file it was read from. */
export function* flatten(dirs: readonly Directive[]): Generator<Directive> {
  for (const d of dirs) {
    if (d.name === "include") yield* flatten(d.block ?? []);
    else yield d;
  }
}

function globToRegExp(pattern: string): RegExp {
  const re = pattern.split("").map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c)).join("");
  return new RegExp(`^${re}$`);
}

interface Ctx {
  files: FileSet;
  links: Links;
  prefix: string;
  loaded: Set<string>;
  loading: Set<string>;
  unresolved: Unresolved[];
  unmatched: Unresolved[];
  malformed: Malformed[];
}

function expand(dirs: Directive[], ctx: Ctx): void {
  for (const d of dirs) {
    if (d.name !== "include" || d.args.length !== 1) {
      if (d.block) expand(d.block, ctx);
      continue;
    }
    const pattern = d.args[0].startsWith("/") ? d.args[0] : ctx.prefix + d.args[0];
    const rx = globToRegExp(pattern);
    const matches = [...new Set([...ctx.files.keys(), ...ctx.links.keys()])].filter((p) => rx.test(p)).sort();
    if (matches.length === 0) (/[*?]/.test(pattern) ? ctx.unmatched : ctx.unresolved).push({ pattern, file: d.file, line: d.line });
    const block: Directive[] = [];
    for (const m of matches) {
      const real = ctx.links.get(m) ?? m;
      const text = ctx.files.get(real);
      if (text === undefined) { ctx.unresolved.push({ pattern, file: d.file, line: d.line, matched: real }); continue; }
      if (ctx.loading.has(real)) continue;
      ctx.loaded.add(real);
      const parsed = parse(text, real, ctx.malformed);
      ctx.loading.add(real);
      expand(parsed, ctx);
      ctx.loading.delete(real);
      block.push(...parsed);
    }
    d.block = block;
  }
}

const joinArgs = (d: Directive): string => d.args.join(" ");
const named = (dirs: readonly Directive[], name: string): Directive[] => dirs.filter((d) => d.name === name);

function* locations(dirs: readonly Directive[], prefix: string): Generator<Location> {
  for (const d of dirs) {
    if (d.name !== "location") continue;
    const path = `${prefix}location[${joinArgs(d)}]`;
    const inner = [...flatten(d.block ?? [])];
    yield { path, proxy_pass: named(inner, "proxy_pass").map(joinArgs), alias: named(inner, "alias").map(joinArgs), root: named(inner, "root").map(joinArgs), file: d.file, line: d.line };
    yield* locations(inner, `${path}.`);
  }
}

function analyseServer(s: Directive, http: readonly Directive[] | null, enabled: ServerBlock["enabled"], ownerFile: string): ServerBlock {
  const own = [...flatten(s.block ?? [])];
  const header = (dirs: readonly Directive[] | null): string | null => (dirs ? named(dirs, "real_ip_header").at(-1)?.args[0] ?? null : null);
  const srv = named(own, "set_real_ip_from");
  const top = http ? named(http, "set_real_ip_from") : [];
  let real_ip: RealIp;
  if (srv.length) real_ip = { ranges: srv.map((d) => d.args[0]), header: header(own) ?? header(http) ?? "X-Real-IP", scope: "server", via_include: srv.some((d) => d.file !== s.file) };
  else if (top.length) real_ip = { ranges: top.map((d) => d.args[0]), header: header(own) ?? header(http) ?? "X-Real-IP", scope: "http", via_include: top.some((d) => d.file !== ownerFile) };
  else real_ip = { ranges: [], header: null, scope: "absent", via_include: false };
  return {
    file: s.file,
    line: s.line,
    enabled,
    // lower-cased and without a trailing dot, the form a Cloudflare record name takes, so the join on name holds
    server_names: named(own, "server_name").flatMap((d) => d.args).map((n) => n.toLowerCase().replace(/\.$/, "")).filter(Boolean),
    listen: named(own, "listen").map(joinArgs),
    ssl_certificate: named(own, "ssl_certificate").map(joinArgs),
    root: named(own, "root").map(joinArgs),
    locations: [...locations(own, "")],
    real_ip,
  };
}

export interface AnalyseOptions { entry?: string; links?: Links; prefix?: string; vhostDirs?: readonly string[] }

export function isVhostPath(path: string, dirs: readonly string[] = VHOST_DIRS): boolean {
  return dirs.some((d) => path.startsWith(`${d}/`) && !path.slice(d.length + 1).includes("/"));
}

export function analyse(files: FileSet, opts: AnalyseOptions = {}): Analysis {
  const entry = opts.entry ?? DEFAULT_ENTRY;
  const ctx: Ctx = { files, links: opts.links ?? new Map(), prefix: opts.prefix ?? DEFAULT_PREFIX, loaded: new Set(), loading: new Set(), unresolved: [], unmatched: [], malformed: [] };
  const servers: ServerBlock[] = [];
  const upstreams: string[] = [];
  let httpRealIp: RealIp | null = null;
  const main = files.get(entry);
  const entryFound = main !== undefined;
  if (main !== undefined) {
    ctx.loaded.add(entry);
    ctx.loading.add(entry);
    const tree = parse(main, entry, ctx.malformed);
    expand(tree, ctx);
    for (const http of named([...flatten(tree)], "http")) {
      const inside = [...flatten(http.block ?? [])];
      upstreams.push(...named(inside, "upstream").map((d) => d.args[0]).filter(Boolean));
      if (httpRealIp === null) {
        const top = named(inside, "set_real_ip_from");
        httpRealIp = top.length
          ? { ranges: top.map((d) => d.args[0]), header: named(inside, "real_ip_header").at(-1)?.args[0] ?? "X-Real-IP", scope: "http", via_include: top.some((d) => d.file !== entry) }
          : { ranges: [], header: null, scope: "absent", via_include: false };
      }
      for (const s of named(inside, "server")) servers.push(analyseServer(s, inside, "yes", entry));
    }
  }
  const standalone: string[] = [];
  const enabled: ServerBlock["enabled"] = entryFound ? "no" : "unknown";
  for (const path of [...files.keys()].sort()) {
    if (ctx.loaded.has(path) || !isVhostPath(path, opts.vhostDirs)) continue;
    standalone.push(path);
    const local: Ctx = { ...ctx, loaded: new Set(), loading: new Set([path]) };
    const tree = parse(files.get(path)!, path, ctx.malformed);
    expand(tree, local);
    const top = [...flatten(tree)];
    for (const s of named(top, "server")) servers.push(analyseServer(s, null, enabled, path));
    for (const http of named(top, "http")) {
      const inside = [...flatten(http.block ?? [])];
      for (const s of named(inside, "server")) servers.push(analyseServer(s, inside, enabled, path));
    }
  }
  return { servers, loaded: [...ctx.loaded].sort(), standalone, unresolved: ctx.unresolved, unmatched: ctx.unmatched, upstreams, entry_found: entryFound, http_real_ip: httpRealIp, malformed: ctx.malformed };
}

/** The port a listen directive binds: `443 ssl http2` -> 443, `[::]:443` -> 443, `*:80` -> 80, a bare address -> 80, `unix:/run/x.sock` -> unix. */
export function listenPort(listen: string): string {
  const first = listen.split(/\s+/)[0] ?? "";
  if (first.startsWith("unix:")) return "unix";
  if (/^\d+$/.test(first)) return first;
  const m = first.match(/:(\d+)$/);
  return m ? m[1] : "80";
}

export type TargetKind = "loopback" | "ip" | "dns_name" | "upstream" | "unix" | "variable";

const IPV4_LIT = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** True for a name DNS could answer: dotted labels, optional leading wildcard, not a regex, not an address, not nginx's `_`. */
export function isDnsName(name: string): boolean {
  const n = name.replace(/\.$/, "");
  if (!n || n.startsWith("~") || n === "_" || IPV4_LIT.test(n) || n.includes(":")) return false;
  return /^(?:\*\.)?(?:[a-z0-9_-]+\.)+[a-z][a-z0-9-]*$/i.test(n.replace(/^\./, "")) ;
}

/**
 * What a proxy_pass points at. `http://127.0.0.1:3000` is loopback (the host itself), `http://10.0.0.5:8080`
 * an address, `https://api.vendor.invalid/v1/` a DNS name (the cross-source referent the hero query joins
 * on), a bare word that names an upstream block, or any bare word, an upstream.
 */
export function classifyTarget(target: string, upstreams: readonly string[] = []): { kind: TargetKind; host: string } {
  let rest = target.trim();
  const scheme = rest.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  if (scheme) rest = rest.slice(scheme[0].length);
  if (rest.startsWith("unix:")) return { kind: "unix", host: rest.split(":")[1] ?? "" };
  let host = rest.split(/[/?#]/)[0];
  // a variable glued to the authority (http://127.0.0.1:8000$request_uri, measured on the conf.d host) is the URI, not the host
  if (!host.startsWith("$")) host = host.split("$")[0];
  if (host.startsWith("[")) host = host.slice(1, host.indexOf("]"));
  else host = host.replace(/:\d+$/, "");
  host = host.toLowerCase().replace(/\.$/, ""); // `api.vendor.invalid.` is the same name as its Cloudflare record
  if (host.startsWith("$")) return { kind: "variable", host };
  if (upstreams.includes(host)) return { kind: "upstream", host };
  if (host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return { kind: "loopback", host };
  if (IPV4_LIT.test(host) || host.includes(":")) return { kind: "ip", host };
  if (isDnsName(host)) return { kind: "dns_name", host };
  return { kind: "upstream", host };
}
