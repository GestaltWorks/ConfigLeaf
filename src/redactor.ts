// Redactor. Runs BEFORE anything is persisted: collected text, vendor JSON, trace detail. The
// agent stores value_hash plus value_redacted, so what leaves this class is what a judge or a
// fixture reader sees.
//
// Contract: structure survives (nginx directives, sudoers syntax, JSON keys, path shapes) and only
// what identifies a client or carries a credential is replaced. Deterministic for one salt: the
// same address or host is the same pseudonym across every fixture of a tenant, so the hero query's
// join on address still holds after redaction. A different salt gives different pseudonyms, so a
// published fixture cannot be re-identified without it. Redacting redacted text is a no-op.
//
// Passes, in order, each over the output of the one before:
//   a  secrets   -> <secret:KIND:first 8 hex of sha256(salt+match)>; the key or envelope that
//                   names the secret ("password=", "Bearer ", "ssh-ed25519 ") stays.
//   b  addresses -> ip-XXXXXX. RFC 5737/3849 documentation ranges, loopback and the unspecified
//                   address pass through so fixtures stay readable. A CIDR suffix stays.
//   c  people    -> /home/<u> and /Users/<u> become user-XXXXXX; local@domain becomes
//                   mail-XXXXXX@domain-XXXXXX, or user-XXXXXX@<host> when the host passes through.
//                   The suffix is the same hash for the same login, so a redacted fixture still
//                   says which home directory belongs to which mail address.
//   d  hostnames -> host-XXXXXX.<tld>; .invalid/.example/.test/.localhost and example.com|net|org
//                   pass through. A file extension is not a TLD; a dotted stem is still redacted.
//                   Trace lines carry the agent's own dotted vocabulary next to real names, and it
//                   is left alone: a name followed by "./" or ".word" is a dotted key path
//                   (server.location./.proxy_pass), a one- or two-character single label is a SQL
//                   alias (o.host, e2.actor; no client hostname looks like t.co), and a tail in
//                   VOCAB (collection surfaces, nginx block and directive names, the observation
//                   table) is the agent's, not a TLD a client runs under. A setting path ending in a
//                   directive outside VOCAB is over-redacted in trace text only; the stored row keeps it.
//   e  words     -> word-XXXXXX. The tenant's own labels (REDACT_WORDS: zone labels, product names)
//                   wherever they stand on their own between non-alphanumerics: a vhost file named
//                   <brand>-prod.conf, a timer unit, an export subfolder named after a zone. Measured 24
//                   Oct on the real hosts: six such labels survived passes a-d in object_id and timer
//                   paths because a bare label is not a hostname. The collectors cannot know the
//                   labels, so the list is per tenant configuration, not collected.
//
// Pseudonyms are 6 hex (24 bits): 100 addresses collide with probability 0.03%, 500 with 0.7%.
// Hex and base64 runs are secrets only next to a key-like word, so sha256 value hashes, restic ids
// and etckeeper commits stay data. JSON goes through json(): keys are kept, string values are
// redacted, and a value under a secret-naming key (token, password, X-Auth-Key, ...) is a secret
// whatever its shape. text() over serialised JSON would also see the keys.
//
// fingerprint() is the value_hash of a collected setting: HMAC-SHA256 under the same salt, printed
// as sha256:<64 hex>. Measured 24 Oct on the first exported bundle: with plain sha256(value), 138
// guesses built from the six public zone names matched 194 stored hashes and confirmed 19 plaintexts
// behind their host-XXXXXX pseudonyms; under the salt a guess confirms nothing. A `file` row keeps
// sha256 of its bytes (src/collectors/linux.ts), because it must equal the export copy's sha256sum.

import { createHash, createHmac } from "node:crypto";
import { isIPv6 } from "node:net";

const PSEUDO_LEN = 6;

// pass a: secrets
const PEM = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;
const BEARER = /(\bBearer\s+)(?!<)([A-Za-z0-9._~+/=-]{16,})/g;
/** key, separator, value. The key must end in a secret-naming word; sudoers' (NO)PASSWD: tag is syntax, not a key. */
const KV = /(?<![<\w.-])(?!(?:no)?passwd:)([\w.-]*(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key|secret[_-]?key|private[_-]?key|auth[_-]?key))(["']?\s*[=:]\s*["']?|\s+["'])(?![$<])([^\s"'<>,;&}\]]+)/gi;
const CF_TOKEN = /(\bauthorization["']?\s*[:=]\s*["']?)(?!bearer)([A-Za-z0-9_-]{37,40})(?![A-Za-z0-9_-])/gi;
const AWS = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const NVAPI = /\bnvapi-[A-Za-z0-9_-]{8,}/g;
const RT = /\brt-[A-Za-z0-9_-]{8,}/g;
const HEX_RUN = /(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g;
const B64_RUN = /(?<![A-Za-z0-9+/=_-])(?!\/)[A-Za-z0-9+/=_-]{40,}(?![A-Za-z0-9+/=_-])/g;
/** A word that says "a credential follows". Tested on the 64 chars before a run, same line. */
const KEYLIKE = /(?<![<\w])(?:[\w-]*(?:key|token|secret|password|passwd|auth|credential|signature|private|cert)|ssh-(?:rsa|dss|ed25519|ecdsa))/i;
/** JSON keys whose string value is a secret whatever its shape. Suffix match: access_token, X-Auth-Key, cf_api_token. */
const SECRET_KEY = /(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key|secret[_-]?key|private[_-]?key|auth[_-]?key|authorization)$/i;

// pass b: addresses
const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b(\/\d{1,2})?/g;
const IPV6 = /(?<![\w:.])((?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4})(?![\w:])(\/\d{1,3})?/g;

// pass c: people
const HOME = /([\\/](?:home|Users)[\\/])(?!user-[0-9a-f]{6}\b)([A-Za-z0-9._-]+)/g;
const AT = /(?<![\w.+-])(?!Defaults@)([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9_-]+\.)*[A-Za-z0-9_-]+)/g;

// pass d: hostnames. The lookahead also refuses a match followed by "./" or ".word": a dotted key path, not a host.
const HOST = /(?<![\w.-])((?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?\.)+)([A-Za-z]{2,24})(?![\w-]|\.[\/\w])/g;
// A wildcard record name (*.zone.tld): HOST's lookbehind refuses a name preceded by "*.", so the name after
// the star is redacted on its own and the star kept (test/redactor.test.ts "wildcard hostnames").
const WILDCARD = /(?<![\w.-])\*\.((?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?\.)+[A-Za-z]{2,24})(?![\w-]|\.[\/\w])/g;
const PASS_TLD = new Set(["invalid", "example", "test", "localhost"]);
/** A one- or two-character single label before the tail: a SQL alias reference (o.host, d.name, e2.actor) in trace text. */
const ALIAS = /^[A-Za-z0-9_]{1,2}\.$/;
/**
 * The agent's own dotted vocabulary, as trace lines carry it: collection surfaces (linux.etc,
 * linux.nginx, cloudflare.dns, cloudflare.audit, zetaris.control), the nginx block and directive names a setting path
 * ends in (server.listen, http.upstream.app.server) and the one schema table a datasource-qualified
 * name ends in (DRIFT.observation). None is a delegated TLD except .events, and no client runs under it.
 */
const VOCAB = new Set("etc nginx dns audit control http server location upstream events stream mail listen root index include observation metastore drift collection setting referent".split(" "));
/** Dotted names ending in these are files, not hosts. A few are also ccTLDs (sh, so, md, pl, py); in collected configs the file reading wins. */
const EXT = new Set(
  "conf cfg ini env log access error json jsonl yaml yml toml txt md pem key crt cer csr pub pid sock socket service timer target mount slice sh bash py pl rb go js ts mjs cjs tf html htm css php so bak old orig dist default sample lock gz tgz tar zip xz bz2 zst deb rpm db sqlite sql csv xml types map list inc tmpl tpl j2 swp tmp save out sig asc gpg sum".split(" "),
);

/** Documentation, loopback and unspecified addresses identify nothing, so fixtures keep them. */
function ipPassesThrough(ip: string): boolean {
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
  if (v4) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    return a === 127 || ip === "0.0.0.0" || ip === "255.255.255.255"
      || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6 === "::" || /^2001:0?db8:/.test(v6);
}

/** RFC 2606/6761 names: reserved for documentation and tests, so they name no client. */
function hostPassesThrough(name: string): boolean {
  const labels = name.toLowerCase().split(".");
  const tld = labels[labels.length - 1];
  if (PASS_TLD.has(tld)) return true;
  return labels[labels.length - 2] === "example" && (tld === "com" || tld === "net" || tld === "org");
}

export class Redactor {
  private readonly words: RegExp | null;

  /** `words`: the tenant's own labels (pass e), matched case-insensitively; shorter than three characters or empty entries are ignored. */
  constructor(private readonly salt: string, words: readonly string[] = []) {
    const list = [...new Set(words.map((w) => w.trim().toLowerCase()).filter((w) => /^[a-z0-9][a-z0-9_-]{2,}$/.test(w)))].sort((a, b) => b.length - a.length);
    this.words = list.length ? new RegExp(`(?<![A-Za-z0-9])(?:${list.map((w) => w.replace(/[-]/g, "\\-")).join("|")})(?![A-Za-z0-9])`, "gi") : null;
  }

  /** Free text: a config file, a command's output, a log line. */
  text(s: string): string {
    return this.labels(this.hosts(this.people(this.addresses(this.secrets(s)))));
  }

  /**
   * One setting value. As text(), plus: a value that is nothing but a token-shaped run has no
   * key-like neighbour to trigger pass a, so the whole value is the secret.
   */
  value(s: string): string {
    const t = this.text(s);
    const bare = t.trim();
    return /^(?:[0-9a-fA-F]{32,}|[A-Za-z0-9+/=_-]{40,})$/.test(bare) ? t.replace(bare, this.secret("value", bare)) : t;
  }

  /** Parsed JSON: keys are kept, every string value goes through text(), and a string under a secret-naming key is a secret whatever its shape. */
  json<T>(v: T): T {
    return this.walk(v, undefined) as T;
  }

  /** The value_hash of a setting: sha256:<HMAC-SHA256(salt, value) hex>. Equal for equal values under one salt; a guessed plaintext confirms nothing without it. */
  fingerprint(value: string | Uint8Array): string {
    return `sha256:${createHmac("sha256", this.salt).update(value).digest("hex")}`;
  }

  private walk(v: unknown, key: string | undefined): unknown {
    if (typeof v === "string") return key !== undefined && SECRET_KEY.test(key) ? this.keyed(v) : this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x, key));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.walk(x, k)]));
    return v;
  }

  private keyed(v: string): string {
    const t = this.text(v);
    return v === "" || t.includes("<secret:") ? t : this.secret("kv", v);
  }

  private hash(s: string): string {
    return createHash("sha256").update(this.salt + s).digest("hex");
  }

  private pseudo(prefix: string, s: string): string {
    return `${prefix}-${this.hash(s).slice(0, PSEUDO_LEN)}`;
  }

  private secret(kind: string, s: string): string {
    return `<secret:${kind}:${this.hash(s).slice(0, 8)}>`;
  }

  private secrets(s: string): string {
    return s
      .replace(PEM, (m) => this.secret("pem", m))
      .replace(BEARER, (_m, pre: string, tok: string) => pre + this.secret("bearer", tok))
      .replace(KV, (_m, key: string, sep: string, val: string) => key + sep + this.secret("kv", val))
      .replace(CF_TOKEN, (_m, pre: string, tok: string) => pre + this.secret("cf_token", tok))
      .replace(AWS, (m) => this.secret("aws_key", m))
      .replace(NVAPI, (m) => this.secret("nvapi", m))
      .replace(RT, (m) => this.secret("rt", m))
      .replace(HEX_RUN, (m: string, off: number, all: string) => (nearKey(all, off) ? this.secret("hex", m) : m))
      .replace(B64_RUN, (m: string, off: number, all: string) => (nearKey(all, off) ? this.secret("b64", m) : m));
  }

  private addresses(s: string): string {
    return s
      .replace(IPV4, (m, ip: string, cidr: string | undefined) => {
        if (ip.split(".").some((o) => Number(o) > 255)) return m;
        return (ipPassesThrough(ip) ? ip : this.pseudo("ip", ip)) + (cidr ?? "");
      })
      .replace(IPV6, (m, ip: string, cidr: string | undefined) => {
        if (!isIPv6(ip)) return m;
        return (ipPassesThrough(ip) ? ip : this.pseudo("ip", ip.toLowerCase())) + (cidr ?? "");
      });
  }

  private people(s: string): string {
    return s
      .replace(HOME, (_m, dir: string, user: string) => dir + this.pseudo("user", user))
      .replace(AT, (m, local: string, domain: string) => {
        if (/^(?:user|mail)-[0-9a-f]{6}$/.test(local)) return m;
        const dotted = domain.includes(".");
        if (dotted && EXT.has(domain.slice(domain.lastIndexOf(".") + 1).toLowerCase())) return m; // getty@tty1.service: a unit, not a mailbox
        const user = this.pseudo("user", local);
        if (/^(?:localhost|ip-[0-9a-f]{6})$/i.test(domain) || (dotted && (ipPassesThrough(domain) || hostPassesThrough(domain)))) return `${user}@${domain}`;
        if (!dotted) return `${user}@${this.pseudo("host", domain.toLowerCase())}`;
        return `${this.pseudo("mail", local)}@${this.pseudo("domain", domain.toLowerCase())}`;
      });
  }

  /** Pass e: a configured label standing on its own becomes word-XXXXXX; pseudonyms and markers are never touched (they carry no label). */
  private labels(s: string): string {
    return this.words ? s.replace(this.words, (m) => this.pseudo("word", m.toLowerCase())) : s;
  }

  private hosts(s: string): string {
    s = s.replace(WILDCARD, (_m, rest: string) => `*.${this.hosts(rest)}`);
    return s.replace(HOST, (m, labels: string, tld: string) => {
      if (EXT.has(tld.toLowerCase())) {
        const stem = labels.slice(0, -1);
        return stem.includes(".") ? `${this.hosts(stem)}.${tld}` : m;
      }
      if (VOCAB.has(tld.toLowerCase()) || ALIAS.test(labels)) return m;
      if (/^host-[0-9a-f]{6}\.$/.test(labels)) return m;
      const name = m.toLowerCase();
      return hostPassesThrough(name) ? m : `${this.pseudo("host", name)}.${tld}`;
    });
  }
}

/** Is there a key-like word in the 64 characters before `off`, on the same line? */
function nearKey(all: string, off: number): boolean {
  const lineStart = all.lastIndexOf("\n", off - 1) + 1;
  return KEYLIKE.test(all.slice(Math.max(lineStart, off - 64), off));
}

/**
 * The leak probe: how often each label of `words` stands on its own in `text` (pass e's rule, case-
 * insensitive), keyed by the label as given. The export refuses a bundle with any count above zero
 * (store.ts writeBundle) and test/leak.test.ts scans the tree with the same list; callers print
 * counts and positions in the list, never the labels, so a log line cannot leak what the list holds.
 */
export function countLabels(text: string, words: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of words) {
    const label = w.trim();
    if (!label) continue;
    const rx = new RegExp(`(?<![A-Za-z0-9])${label.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?![A-Za-z0-9])`, "gi");
    const n = text.match(rx)?.length ?? 0;
    if (n) out[label] = n;
  }
  return out;
}

const MARKS = /<secret:([a-z_]+):[0-9a-f]{8}>|\b(ip|user|mail|domain|host|word)-[0-9a-f]{6}\b/g;

/** Placeholders present in `after` but not in `before`, counted per kind, for the trace line. */
export function describeRedactions(before: string, after: string): Record<string, number> {
  const tally = (s: string): Record<string, number> => {
    const c: Record<string, number> = {};
    for (const m of s.matchAll(MARKS)) {
      const k = m[1] ?? m[2];
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  };
  const was = tally(before);
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(tally(after))) {
    const added = n - (was[k] ?? 0);
    if (added > 0) out[k] = added;
  }
  return out;
}
