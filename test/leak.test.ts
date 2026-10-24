// The leak probe over the committed tree, with the operator's own deny-list (REDACT_WORDS and
// EXPORT_DENY_WORDS from .env: the tenant's zone and product labels, the operator's company and host
// nicknames, the mailbox local part, real addresses). The list is configuration, never committed, so a
// clean clone skips this file with one line; on the operator's machine every file a judge will read
// (sample/, examples/, README.md, ops/, scripts/, src/, test/, sql/, .env.example, package.json) must hold
// none of the labels standing alone (src/redactor.ts countLabels: pass e's boundaries, case-insensitive).
// The configured ssh aliases (LINUX_HOSTS keys) are the one exception: the brief mandates them, the
// README names them, and they are the operator's own. A failure names the file, the label's position in
// the list and the count, never the label.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { countLabels } from "../src/redactor.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORDS = [...new Set([...config.redactWords, ...config.exportDenyWords])];
const ALIASES = Object.keys(config.linuxHosts);
const SURFACES = ["sample", "examples", "eval", "README.md", "ops", "scripts", "src", "test", "sql", ".env.example", "package.json"];
const TEXT = /\.(?:ts|mts|json|md|sql|example|txt|conf|types|bak|sh)$|^[^.]+$/;

if (!WORDS.length) console.log("leak: skipped (REDACT_WORDS and EXPORT_DENY_WORDS are blank; the deny-list is the operator's configuration)");

function* files(p: string): Generator<string> {
  const st = statSync(p);
  if (st.isDirectory()) { for (const n of readdirSync(p).sort()) if (n !== "node_modules") yield* files(path.join(p, n)); }
  else if (TEXT.test(path.basename(p))) yield p;
}

describe.skipIf(!WORDS.length)("deny-list probe over the tree", () => {
  it("no configured label stands alone in any file a judge will read; the configured ssh aliases are the only allowed carriers", () => {
    const hits: string[] = [];
    let scanned = 0;
    for (const surface of SURFACES) {
      for (const f of files(path.join(ROOT, surface))) {
        scanned++;
        let text = readFileSync(f, "utf8");
        for (const alias of ALIASES) text = text.split(alias).join("alias");
        for (const [w, n] of Object.entries(countLabels(text, WORDS))) hits.push(`${path.relative(ROOT, f).split(path.sep).join("/")}: label #${WORDS.indexOf(w) + 1} x${n}`);
      }
    }
    expect(scanned).toBeGreaterThan(20);
    expect(hits).toEqual([]);
  });

  it("the probe itself would catch a label: a sample line with the first configured label is a hit", () => {
    expect(Object.values(countLabels(`x ${WORDS[0]} y`, WORDS)).reduce((a, b) => a + b, 0)).toBe(1);
  });
});
