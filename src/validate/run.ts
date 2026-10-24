// What `npm run validate:copies` does, as a function: for one tenant, the latest commit of each vault
// repository (or one commit of one repository) validated, one printed line per repository, and the
// copy_validation rows for the vault_copy rows of each validated commit. scripts/validate-copies.ts parses
// the arguments, builds the Store and prints; this module holds the rest, so a test drives it with a fake
// store and a fake nginx runner.
//
// Contract:
//   - Repositories: every host alias of <DRIFT_VAULT_DIR>/<tenant> (one with `host`) and the Cloudflare
//     repository (one zone's records with `zone`); `host` alone selects that host, `zone` alone the
//     Cloudflare repository, both select both, neither selects every repository. `commit` needs exactly one
//     repository selected.
//   - nginx-t gives every linux.nginx copy of the commit one row with the tree's result; cf-schema gives the
//     cloudflare.dns copy of each record (object_id = record id) its record's result. A copy the vault
//     committed with no record in the commit gets no row.
//   - One line per repository: the result, the rounds, the gap count and the redacted gaps, the copies
//     matched, and for a fail the reason and the last [emerg] line. A repository whose validation throws
//     (nginx unavailable, git refusing) gets a line saying so, no row, and counts in `errors`.
//   - Rows are written in one call at the end unless dryRun or no store; `written` is null then. With no
//     store the copies are unknown, the inventory unread, and the lines say so.
//   - Every printed string passes through the tenant's redactor; error text too.

import { redact } from "../config.ts";
import type { CopyValidation, ValidationResult, VaultCopy } from "../data/rows.ts";
import type { Store } from "../data/store.ts";
import type { Redactor } from "../redactor.ts";
import { ValidateError, type NginxRunner } from "./nginx.ts";
import {
  CLOUDFLARE_REPO, copyValidationRows, latestCommit, repositoryDir, validateCloudflareCommit, validateVaultCommit, vaultRepositories,
} from "./vault.ts";

/** The reads and the one write validate:copies needs from the Store. */
export interface CopyStore {
  vaultCopies(tenantId: string, gitCommit: string): Promise<VaultCopy[]>;
  inventoryAddresses(tenantId: string): Promise<string[]>;
  insertCopyValidations(rows: readonly CopyValidation[]): Promise<number>;
}

/** The Store as a CopyStore. */
export function storeCopies(store: Store): CopyStore {
  return {
    vaultCopies: (t, c) => store.rowsOf("vault_copy", { tenant_id: t, git_commit: c }),
    inventoryAddresses: async (t) => (await store.rowsOf("inventory_asset", { tenant_id: t })).map((a) => a.address),
    insertCopyValidations: (rows) => store.insertCopyValidations(rows),
  };
}

export interface ValidateCopiesOptions {
  vaultDir: string;
  tenant: string;
  host?: string;
  zone?: string;
  commit?: string;
  dryRun: boolean;
  store: CopyStore | null;
  redactor: Redactor;
  runner?: NginxRunner;
  pair?: () => Promise<string>;
  maxRounds?: number;
  /** One timestamp for every row of the call; default now. */
  validatedAt?: string;
}

export interface ValidateCopiesResult {
  lines: string[];
  rows: CopyValidation[];
  written: number | null;
  errors: number;
}

const RANK: Record<ValidationResult, number> = { ok: 0, ok_with_gaps: 1, fail: 2 };
const n = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
const gapsText = (gaps: readonly string[]): string => `${n(gaps.length, "gap")}${gaps.length ? `: ${gaps.join(", ")}` : ""}`;

export async function validateCopies(opts: ValidateCopiesOptions): Promise<ValidateCopiesResult> {
  const r = opts.redactor;
  const safe = (e: unknown): string => r.text(redact(e instanceof Error ? e.message : String(e)));
  const validatedAt = opts.validatedAt ?? new Date().toISOString();
  const repos = vaultRepositories(opts.vaultDir, opts.tenant);
  const lines: string[] = [];
  const rows: CopyValidation[] = [];
  let errors = 0;

  const hostSel = opts.host !== undefined || opts.zone === undefined;
  const cfSel = opts.zone !== undefined || opts.host === undefined;
  const hosts = !hostSel ? [] : opts.host === undefined ? repos.hosts : repos.hosts.filter((h) => h === opts.host);
  if (opts.host !== undefined && hosts.length === 0) {
    lines.push(`host ${r.text(opts.host)}: no vault repository for tenant ${opts.tenant}`);
    errors++;
  }
  const cloudflare = cfSel && repos.cloudflare;
  if (opts.zone !== undefined && !repos.cloudflare) {
    lines.push(`cloudflare: no vault repository for tenant ${opts.tenant}`);
    errors++;
  }
  if (opts.commit !== undefined && hosts.length + (cloudflare ? 1 : 0) !== 1) {
    throw new ValidateError(`--commit names one commit of one repository; ${hosts.length + (cloudflare ? 1 : 0)} repositories are selected (narrow with --host or --zone)`);
  }
  if (!hosts.length && !cloudflare && !errors) lines.push(`no vault repository for tenant ${opts.tenant}`);

  const copiesOf = async (commit: string): Promise<VaultCopy[] | null> => (opts.store ? opts.store.vaultCopies(opts.tenant, commit) : null);
  const copiesText = (copies: readonly unknown[] | null, matched: number): string =>
    copies === null ? "vault copies unknown (no store)" : `${n(matched, "vault copy", "vault copies")} of ${copies.length} matched`;

  for (const alias of hosts) {
    const label = `host ${r.text(alias)}`;
    try {
      const repo = repositoryDir(opts.vaultDir, opts.tenant, alias);
      const commit = opts.commit ?? latestCommit(repo);
      if (commit === null) {
        lines.push(`${label}: no commit yet`);
        continue;
      }
      const v = await validateVaultCommit({ vaultDir: opts.vaultDir, tenant: opts.tenant, alias, commit, redactor: r, runner: opts.runner, maxRounds: opts.maxRounds, pair: opts.pair });
      const copies = await copiesOf(v.commit);
      const mine = (copies ?? []).filter((c) => c.surface === "linux.nginx");
      rows.push(...copyValidationRows(mine, v, { validator: "nginx-t", validatedAt }));
      const emerg = v.output.split("\n").filter((l) => l.includes("[emerg]")).pop();
      const why = v.result === "fail" ? ` | ${v.reason}${emerg ? `: ${emerg.replace(/^nginx: /, "")}` : ""}` : "";
      lines.push(`${label} @${v.commit.slice(0, 8)} (run ${v.run_id ?? "-"}, ${n(v.files, "file")}, ${n(v.links, "link")}): nginx-t ${v.result}, ${n(v.rounds, "round")}, ${gapsText(v.missing_dependencies)}; ${copiesText(copies, mine.length)}${why}`);
    } catch (e) {
      lines.push(`${label}: validation stopped: ${safe(e)}`);
      errors++;
    }
  }

  if (cloudflare) {
    const label = CLOUDFLARE_REPO;
    try {
      const repo = repositoryDir(opts.vaultDir, opts.tenant, CLOUDFLARE_REPO);
      const commit = opts.commit ?? latestCommit(repo);
      if (commit === null) {
        lines.push(`${label}: no commit yet`);
      } else {
        const inventory = opts.store ? await opts.store.inventoryAddresses(opts.tenant) : null;
        const v = validateCloudflareCommit({ vaultDir: opts.vaultDir, tenant: opts.tenant, commit, redactor: r, inventory, zone: opts.zone });
        const copies = await copiesOf(v.commit);
        const byRecord = new Map<string, VaultCopy[]>();
        for (const c of copies ?? []) if (c.surface === "cloudflare.dns") byRecord.set(c.object_id, [...(byRecord.get(c.object_id) ?? []), c]);
        let matched = 0;
        for (const rec of v.records) {
          const mine = byRecord.get(rec.record_id) ?? [];
          matched += mine.length;
          rows.push(...copyValidationRows(mine, rec, { validator: "cf-schema", validatedAt }));
        }
        const count = (res: ValidationResult) => v.records.filter((x) => x.result === res).length;
        const worst = v.records.reduce<ValidationResult>((w, x) => (RANK[x.result] > RANK[w] ? x.result : w), "ok");
        const gaps = [...new Set(v.records.flatMap((x) => x.missing_dependencies))].sort();
        const firstFail = v.records.find((x) => x.result === "fail");
        const why = firstFail ? ` | first fail ${firstFail.record_id}: ${firstFail.output.split("\n")[0]}` : "";
        const scope = opts.zone === undefined ? n(v.zones, "zone") : `zone ${r.text(opts.zone)}`;
        const unread = inventory === null ? "; inventory unread (no store), addresses unchecked" : "";
        lines.push(`${label} @${v.commit.slice(0, 8)} (run ${v.run_id ?? "-"}, ${scope}): cf-schema ${v.records.length ? worst : "no records"}, ${n(v.records.length, "record")} (ok ${count("ok")}, ok_with_gaps ${count("ok_with_gaps")}, fail ${count("fail")}), ${gapsText(gaps)}; ${copiesText(copies, matched)}${unread}${why}`);
      }
    } catch (e) {
      lines.push(`${label}: validation stopped: ${safe(e)}`);
      errors++;
    }
  }

  const written = opts.dryRun || !opts.store ? null : rows.length ? await opts.store.insertCopyValidations(rows) : 0;
  return { lines, rows, written, errors };
}
