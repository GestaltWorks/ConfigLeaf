// The policy glob: how a rule's object_glob and setting_glob name the settings it governs.
//
// Contract:
//   - "**" matches any run of characters, "/" included: it spans path segments.
//   - "*" matches any run of characters within one path segment: everything except "/".
//   - "?" matches exactly one character other than "/".
//   - Every other character matches itself, "[", "]" and "." included, so "server[*].real_ip" reads
//     as the literal text server[, any block key, and ].real_ip.
//   - The whole glob matches the whole text; "*" and "**" match the empty run too.
//   - literalLength is the count of literal characters, every one except "*" and "?": the resolver's
//     measure of how specific a glob is ("/etc/nginx/conf.d/*.conf" has 23, "**/*.bak*" has 5, "**" 0).
//
// Measured 24 Oct 2026 on the object ids of sample/bundle.json (test/policy.test.ts): of the conf.d
// host's 18 files, "/etc/nginx/conf.d/*.conf" matches exactly the 8 live vhost files and
// "/etc/nginx/conf.d/*.conf.*" exactly the 8 dated and .bak copies beside them
// ("<name>.conf.bak-2026-08-12", "<name>.conf.bak"); the two ".ready" files fall to the broader rules.

const cache = new Map<string, RegExp>();

/** The glob as an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let src = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      src += "[\\s\\S]*";
      i++;
    } else if (ch === "*") {
      src += "[^/]*";
    } else if (ch === "?") {
      src += "[^/]";
    } else {
      src += ch.replace(/[\\^$.|+()[\]{}*?/]/g, "\\$&");
    }
  }
  const re = new RegExp(`^${src}$`);
  cache.set(glob, re);
  return re;
}

/** Does the glob match the whole text? */
export function globMatch(glob: string, text: string): boolean {
  return globToRegExp(glob).test(text);
}

/** The glob's literal characters: every one except "*" and "?". */
export function literalLength(glob: string): number {
  return glob.replace(/\*+|\?/g, "").length;
}
