// What does the Zetaris REST endpoint actually return? Print raw shapes so the adapter's
// normaliser is written against reality. Read-only statements only.
import { Zetaris } from "../src/adapters/zetaris.ts";

const z = new Zetaris();
const statements = [
  "SELECT 1 AS one",
  "SHOW LIGHTNING DATABASES",
  "SHOW DATABASES",
  "SHOW SCHEMASTORE CONTAINERS",
];
for (const sql of statements) {
  try {
    const r = await z.query(sql, { limit: 20 });
    const raw = JSON.stringify(r.raw);
    console.log(`\n== ${sql}\n   normalised: ${r.rowCount} rows, columns=${JSON.stringify(r.columns)}\n   raw keys: ${Object.keys((r.raw as any) ?? {}).join(", ")}\n   raw: ${raw.slice(0, 700)}`);
  } catch (e: any) {
    console.log(`\n== ${sql}\n   ERROR ${e.status}: ${String(e.message).slice(0, 300)}`);
  }
}
