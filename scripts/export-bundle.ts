// npm run export:bundle [-- --out <path>] [--schema <name>] [--note <text>]
// How the recorded, redacted real collections become the sample bundle. Reads every table of the app
// Postgres (DATABASE_URL; --schema for another search_path), passes every row through the Redactor once
// more (belt and braces: the collectors and the Store already did), nulls any value_redacted over 2 kB,
// checks that the sql.js loader accepts the result, probes the text for every label in REDACT_WORDS and
// EXPORT_DENY_WORDS (exit 1 and nothing written when one still appears; the message gives positions in
// the list and counts, never the labels), and writes the bundle shape sample mode loads: "_note", then
// one array per table in DDL order, one row per line. Default out: sample/bundle.json. The note is
// --note, else the target file's own "_note", else sample/bundle.json's. Prints row counts.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { config, redact } from "../src/config.ts";
import { Redactor } from "../src/redactor.ts";
import { Store, TABLES, writeBundle } from "../src/data/store.ts";

const SAMPLE = "sample/bundle.json";

function noteOf(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const n = (JSON.parse(readFileSync(file, "utf8")) as { _note?: unknown })._note;
    return typeof n === "string" ? n : undefined;
  } catch {
    return undefined;
  }
}

const { values: args } = parseArgs({ options: { out: { type: "string", default: SAMPLE }, schema: { type: "string" }, note: { type: "string" } } });
const out = args.out;
const note = args.note ?? noteOf(out) ?? noteOf(SAMPLE) ?? "Recorded, redacted collections exported from the app Postgres by scripts/export-bundle.ts.";

let store: Store | undefined;
try {
  store = Store.fromEnv({ schema: args.schema });
  const deny = [...new Set([...config.redactWords, ...config.exportDenyWords])];
  const stats = await writeBundle(store, out, { redactor: new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords), note, deny });
  console.log(`export: ${TABLES.map((t) => `${t} ${stats.counts[t]}`).join(", ")} -> ${out}`);
  console.log(`export: second redaction pass changed ${stats.changed} field(s); ${stats.dropped} value_redacted over 2 kB nulled; leak probe: 0 of ${deny.length} deny-list label(s) in the file`);
  if (stats.changed) {
    console.error(`export: ${stats.changed} field(s) reached the store unredacted and were redacted on export${config.redactSalt ? "" : " with a per-process salt (REDACT_SALT is blank), so they no longer join to the collectors' pseudonyms"}`);
  }
} catch (e) {
  console.error(`export failed: ${redact((e as Error).message)}`);
  process.exitCode = 1;
} finally {
  await store?.close();
}
