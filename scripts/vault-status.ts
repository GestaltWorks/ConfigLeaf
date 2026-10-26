// npm run vault:status -- [--tenant <id>] [--objects] [--schema <name>] [--dry-run] [--help]
//
// What the vault (DRIFT_VAULT_DIR, src/vault/) holds, per repository: the commit count, the head commit's hash
// and date and the run it holds, the file count at the head, and the vault_copy rows the app Postgres holds for
// that repository (all of them, and those at the head commit). --objects lists the redacted object ids at the
// head. The repository is named <tenant>/<host pseudonym> for a host (the alias directory's host, as the
// collector pseudonymises it) and <tenant>/cloudflare for a tenant's records. Everything printed goes through
// the redactor: commit hashes, counts, dates and redacted object ids. The script reads only;
// --dry-run is accepted and changes nothing. With DATABASE_URL blank the vault_copy counts read "n/a".
// Exit 0, 1 when the vault or the Store refuses, 2 on a usage error or when the vault is off.

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { pseudonymHost } from "../src/collectors/linux.ts";
import { config, redact } from "../src/config.ts";
import type { VaultCopy } from "../src/data/rows.ts";
import { Store } from "../src/data/store.ts";
import { Redactor } from "../src/redactor.ts";
import { CLOUDFLARE_REPO, Vault, ZETARIS_REPO } from "../src/vault/vault.ts";
import { CONTROL_SURFACE } from "../src/zetaris/control.ts";

const USAGE = "usage: npm run vault:status -- [--tenant <id>] [--objects] [--schema <name>] [--dry-run] [--help]";

let args: { tenant?: string; objects?: boolean; schema?: string; "dry-run"?: boolean; help?: boolean };
try {
  args = parseArgs({ options: { tenant: { type: "string" }, objects: { type: "boolean" }, schema: { type: "string" }, "dry-run": { type: "boolean" }, help: { type: "boolean" } } }).values;
} catch (e) {
  console.error(`${(e as Error).message}\n${USAGE}`);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  console.log("Prints, per vault repository, the commit count, the head commit and its date, the file count and the vault_copy rows in Postgres; redacted object ids only.");
  process.exit(0);
}

const redactor = new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords);
const say = (s: string): void => console.log(redactor.text(redact(s)));
if (!config.redactSalt) console.error("warning: REDACT_SALT is blank; host pseudonyms here are per-process and match no stored vault_copy row");

let vault: Vault | null;
try {
  vault = Vault.fromEnv({ redactor });
} catch (e) {
  console.error(`vault:status: ${redactor.text(redact((e as Error).message))}`);
  process.exit(1);
}
if (!vault) {
  console.error("vault:status: the vault is off (DRIFT_VAULT_DIR is blank)");
  process.exit(2);
}

let store: Store | undefined;
try {
  const repos = vault.status().filter((r) => args.tenant === undefined || r.tenant === args.tenant);
  store = process.env.DATABASE_URL ? Store.fromEnv({ schema: args.schema }) : undefined;
  say(`vault:status: ${repos.length} repositor${repos.length === 1 ? "y" : "ies"}${args.tenant ? ` for ${args.tenant}` : ""}${store ? "" : "; vault_copy n/a (DATABASE_URL is blank)"}`);
  for (const r of repos) {
    // The Cloudflare and the Zetaris repositories go by their own names and their surface; a host's by its pseudonym.
    const surface = r.repo === CLOUDFLARE_REPO ? "cloudflare.dns" : r.repo === ZETARIS_REPO ? CONTROL_SURFACE : null;
    const name = surface ? `${r.tenant}/${r.repo}` : `${r.tenant}/${pseudonymHost(redactor, r.repo)}`;
    let copies = "vault_copy n/a";
    if (store) {
      const rows: VaultCopy[] = await store.rowsOf("vault_copy", surface ? { tenant_id: r.tenant, surface } : { tenant_id: r.tenant, host: pseudonymHost(redactor, r.repo) });
      copies = `vault_copy ${rows.length} row(s), ${r.head ? rows.filter((c) => c.git_commit === r.head).length : 0} at the head`;
    }
    say(`  ${name.padEnd(24)} ${String(r.commits).padStart(4)} commit(s)  head ${r.head ? r.head.slice(0, 12) : "-".padEnd(12)}  ${r.headDate ?? "-"}  run ${r.headRun ?? "-"}  ${String(r.files).padStart(4)} file(s)  ${copies}`);
    if (args.objects) for (const id of r.objectIds) say(`      ${id}`);
  }
} catch (e) {
  console.error(`vault:status: ${redactor.text(redact((e as Error).message ?? String(e)))}`);
  process.exitCode = 1;
} finally {
  await store?.close();
}
