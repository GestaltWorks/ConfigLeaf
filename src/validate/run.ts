// What `npm run validate:copies` does, as a function: for one tenant, the latest commit of each vault
// repository (or one commit of one repository) validated, with every earlier commit whose vault copies no
// validation reached, one printed line per repository and one more for its earlier commits, and the
// copy_validation rows for the vault_copy rows of each validated commit. scripts/validate-copies.ts parses
// the arguments, builds the Store and prints; this module holds the rest, so a test drives it with a fake
// store and a fake nginx runner.
//
// Contract:
//   - Repositories: every host alias of <DRIFT_VAULT_DIR>/<tenant> (one with `host`), the Cloudflare
//     repository (one zone's records with `zone`) and the Zetaris repository (`zetaris`); each of `host`,
//     `zone` and `zetaris` selects its repository, several select several, none selects every repository.
//     `commit` needs exactly one repository selected.
//   - Commits: `commit` alone when given; else the repository's head, then, when the store lists them
//     (unvalidatedCommits), every other commit of the repository a vault copy of the tenant names with no
//     validation, so a run collected and committed without a validation after it is validated on the next call.
//     nginx-t runs once per tree: a commit whose tree an earlier commit of the call holds takes that result.
//   - nginx-t gives every linux.nginx copy of the commit one row with the tree's result; cf-schema gives the
//     cloudflare.dns copy of each record (object_id = record id) its record's result; zetaris-json gives the
//     zetaris.control copy of each object (src/validate/zetaris.ts, its recorded hash checked) its object's
//     result. A copy the vault committed with no file in the commit gets no row.
//   - One line per repository head: the result, the rounds, the gap count and the redacted gaps, the copies
//     matched, and for a fail the reason and the last [emerg] line or the first failing object. One line per
//     repository with earlier commits validated: their count, the trees, the results by commit, the copies
//     matched. A repository whose validation throws (nginx unavailable, git refusing) gets a line saying so,
//     no row from the commit that threw, and counts in `errors`.
//   - Rows are written in one call at the end unless dryRun or no store; `written` is null then. With no
//     store the copies are unknown, the inventory unread, the earlier commits unlisted, and the lines say so.
//   - Every printed string passes through the tenant's redactor; error text too.

import { redact } from "../config.ts";
import type { CopyValidation, ValidationResult, VaultCopy } from "../data/rows.ts";
import type { Store } from "../data/store.ts";
import type { Redactor } from "../redactor.ts";
import { ValidateError, type NginxRunner } from "./nginx.ts";
import {
  CLOUDFLARE_REPO, ZETARIS_REPO, commitsOf, copyValidationRows, latestCommit, repositoryDir, resolveCommit, treeOf, validateCloudflareCommit,
  validateVaultCommit, validateZetarisCommit, vaultRepositories, type VaultNginxValidation,
} from "./vault.ts";

/** The reads and the one write validate:copies needs from the Store. */
export interface CopyStore {
  vaultCopies(tenantId: string, gitCommit: string): Promise<VaultCopy[]>;
  inventoryAddresses(tenantId: string): Promise<string[]>;
  insertCopyValidations(rows: readonly CopyValidation[]): Promise<number>;
  /** The git commits of the tenant's vault copies that no copy_validation row names; absent, the heads alone are validated. */
  unvalidatedCommits?(tenantId: string): Promise<string[]>;
}

/** The Store as a CopyStore. */
export function storeCopies(store: Store): CopyStore {
  return {
    vaultCopies: (t, c) => store.rowsOf("vault_copy", { tenant_id: t, git_commit: c }),
    inventoryAddresses: async (t) => (await store.rowsOf("inventory_asset", { tenant_id: t })).map((a) => a.address),
    insertCopyValidations: (rows) => store.insertCopyValidations(rows),
    unvalidatedCommits: async (t) => {
      const validated = new Set((await store.rowsOf("copy_validation", { tenant_id: t })).map((v) => v.copy_id));
      return [...new Set((await store.rowsOf("vault_copy", { tenant_id: t })).filter((c) => !validated.has(c.copy_id)).map((c) => c.git_commit))].sort();
    },
  };
}

export interface ValidateCopiesOptions {
  vaultDir: string;
  tenant: string;
  host?: string;
  zone?: string;
  /** Select the Zetaris repository. */
  zetaris?: boolean;
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
const RESULTS: readonly ValidationResult[] = ["ok", "ok_with_gaps", "fail"];
const n = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
const gapsText = (gaps: readonly string[]): string => `${n(gaps.length, "gap")}${gaps.length ? `: ${gaps.join(", ")}` : ""}`;
const worstOf = (xs: readonly { result: ValidationResult }[]): ValidationResult => xs.reduce<ValidationResult>((w, x) => (RANK[x.result] > RANK[w] ? x.result : w), "ok");
const tally = (xs: readonly { result: ValidationResult }[]): string => RESULTS.map((res) => `${res} ${xs.filter((x) => x.result === res).length}`).join(", ");

export async function validateCopies(opts: ValidateCopiesOptions): Promise<ValidateCopiesResult> {
  const r = opts.redactor;
  const safe = (e: unknown): string => r.text(redact(e instanceof Error ? e.message : String(e)));
  const validatedAt = opts.validatedAt ?? new Date().toISOString();
  const repos = vaultRepositories(opts.vaultDir, opts.tenant);
  const lines: string[] = [];
  const rows: CopyValidation[] = [];
  let errors = 0;

  const narrowed = opts.host !== undefined || opts.zone !== undefined || opts.zetaris === true;
  const hosts = opts.host !== undefined ? repos.hosts.filter((h) => h === opts.host) : narrowed ? [] : repos.hosts;
  if (opts.host !== undefined && hosts.length === 0) {
    lines.push(`host ${r.text(opts.host)}: no vault repository for tenant ${opts.tenant}`);
    errors++;
  }
  const cloudflare = (opts.zone !== undefined || !narrowed) && repos.cloudflare;
  if (opts.zone !== undefined && !repos.cloudflare) {
    lines.push(`cloudflare: no vault repository for tenant ${opts.tenant}`);
    errors++;
  }
  const zetaris = (opts.zetaris === true || !narrowed) && repos.zetaris;
  if (opts.zetaris === true && !repos.zetaris) {
    lines.push(`zetaris: no vault repository for tenant ${opts.tenant}`);
    errors++;
  }
  const selected = hosts.length + (cloudflare ? 1 : 0) + (zetaris ? 1 : 0);
  if (opts.commit !== undefined && selected !== 1) {
    throw new ValidateError(`--commit names one commit of one repository; ${selected} repositories are selected (narrow with --host, --zone or --zetaris)`);
  }
  if (!selected && !errors) lines.push(`no vault repository for tenant ${opts.tenant}`);

  const copiesOf = async (commit: string): Promise<VaultCopy[] | null> => (opts.store ? opts.store.vaultCopies(opts.tenant, commit) : null);
  const copiesText = (copies: readonly unknown[] | null, matched: number): string =>
    copies === null ? "vault copies unknown (no store)" : `${n(matched, "vault copy", "vault copies")} of ${copies.length} matched`;
  const unvalidated = opts.commit === undefined && opts.store?.unvalidatedCommits ? await opts.store.unvalidatedCommits(opts.tenant) : [];
  /** The repository's commits to validate: the one given, else the head and the earlier commits no validation reached. */
  const commitsFor = (repo: string): { head: string | null; earlier: string[] } => {
    if (opts.commit !== undefined) return { head: resolveCommit(repo, opts.commit), earlier: [] };
    const head = latestCommit(repo);
    return { head, earlier: head === null ? [] : commitsOf(repo, unvalidated.filter((c) => c !== head)) };
  };
  /** The line of a repository's earlier commits: how many, over how many trees, the results by commit, the copies matched. */
  const earlierLine = (label: string, validator: string, results: readonly { result: ValidationResult }[], trees: number | null, copies: number, matched: number): string =>
    `${label}: ${n(results.length, "earlier commit")} whose copies no validation reached${trees === null ? "" : `, ${n(trees, "tree")}`}; ${validator} by commit: ${tally(results)}; ${n(matched, "vault copy", "vault copies")} of ${copies} matched`;

  for (const alias of hosts) {
    const label = `host ${r.text(alias)}`;
    try {
      const repo = repositoryDir(opts.vaultDir, opts.tenant, alias);
      const { head, earlier } = commitsFor(repo);
      if (head === null) {
        lines.push(`${label}: no commit yet`);
        continue;
      }
      const byTree = new Map<string, VaultNginxValidation>();
      const nginxOf = async (commit: string): Promise<VaultNginxValidation> => {
        const tree = treeOf(repo, commit);
        const known = byTree.get(tree);
        if (known) return known;
        const v = await validateVaultCommit({ vaultDir: opts.vaultDir, tenant: opts.tenant, alias, commit, redactor: r, runner: opts.runner, maxRounds: opts.maxRounds, pair: opts.pair });
        byTree.set(tree, v);
        return v;
      };
      const v = await nginxOf(head);
      const copies = await copiesOf(v.commit);
      const mine = (copies ?? []).filter((c) => c.surface === "linux.nginx");
      rows.push(...copyValidationRows(mine, v, { validator: "nginx-t", validatedAt }));
      const emerg = v.output.split("\n").filter((l) => l.includes("[emerg]")).pop();
      const why = v.result === "fail" ? ` | ${v.reason}${emerg ? `: ${emerg.replace(/^nginx: /, "")}` : ""}` : "";
      lines.push(`${label} @${v.commit.slice(0, 8)} (run ${v.run_id ?? "-"}, ${n(v.files, "file")}, ${n(v.links, "link")}): nginx-t ${v.result}, ${n(v.rounds, "round")}, ${gapsText(v.missing_dependencies)}; ${copiesText(copies, mine.length)}${why}`);
      if (!earlier.length) continue;
      const trees = new Set(earlier.map((c) => treeOf(repo, c))).size;
      const results: VaultNginxValidation[] = [];
      let all = 0;
      let matched = 0;
      for (const commit of earlier) {
        const e = await nginxOf(commit);
        const own = await copiesOf(commit);
        const theirs = (own ?? []).filter((c) => c.surface === "linux.nginx");
        all += own?.length ?? 0;
        matched += theirs.length;
        results.push(e);
        rows.push(...copyValidationRows(theirs, e, { validator: "nginx-t", validatedAt }));
      }
      lines.push(earlierLine(label, "nginx-t", results, trees, all, matched));
    } catch (e) {
      lines.push(`${label}: validation stopped: ${safe(e)}`);
      errors++;
    }
  }

  if (cloudflare) {
    const label = CLOUDFLARE_REPO;
    try {
      const repo = repositoryDir(opts.vaultDir, opts.tenant, CLOUDFLARE_REPO);
      const { head, earlier } = commitsFor(repo);
      if (head === null) {
        lines.push(`${label}: no commit yet`);
      } else {
        const inventory = opts.store ? await opts.store.inventoryAddresses(opts.tenant) : null;
        /** One commit's records validated, their copies' rows added; the records and the copies matched. */
        const recordsOf = async (commit: string) => {
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
          return { v, copies, matched };
        };
        const { v, copies, matched } = await recordsOf(head);
        const count = (res: ValidationResult) => v.records.filter((x) => x.result === res).length;
        const gaps = [...new Set(v.records.flatMap((x) => x.missing_dependencies))].sort();
        const firstFail = v.records.find((x) => x.result === "fail");
        const why = firstFail ? ` | first fail ${firstFail.record_id}: ${firstFail.output.split("\n")[0]}` : "";
        const scope = opts.zone === undefined ? n(v.zones, "zone") : `zone ${r.text(opts.zone)}`;
        const unread = inventory === null ? "; inventory unread (no store), addresses unchecked" : "";
        lines.push(`${label} @${v.commit.slice(0, 8)} (run ${v.run_id ?? "-"}, ${scope}): cf-schema ${v.records.length ? worstOf(v.records) : "no records"}, ${n(v.records.length, "record")} (ok ${count("ok")}, ok_with_gaps ${count("ok_with_gaps")}, fail ${count("fail")}), ${gapsText(gaps)}; ${copiesText(copies, matched)}${unread}${why}`);
        if (earlier.length) {
          const results: { result: ValidationResult }[] = [];
          let all = 0;
          let mine = 0;
          for (const commit of earlier) {
            const e = await recordsOf(commit);
            results.push({ result: worstOf(e.v.records) });
            all += e.copies?.length ?? 0;
            mine += e.matched;
          }
          lines.push(earlierLine(label, "cf-schema", results, null, all, mine));
        }
      }
    } catch (e) {
      lines.push(`${label}: validation stopped: ${safe(e)}`);
      errors++;
    }
  }

  if (zetaris) {
    const label = ZETARIS_REPO;
    try {
      const repo = repositoryDir(opts.vaultDir, opts.tenant, ZETARIS_REPO);
      const { head, earlier } = commitsFor(repo);
      if (head === null) {
        lines.push(`${label}: no commit yet`);
      } else {
        /** One commit's objects validated against their copies' recorded hashes, the copies' rows added. */
        const objectsOf = async (commit: string) => {
          const copies = await copiesOf(resolveCommit(repo, commit));
          const mine = (copies ?? []).filter((c) => c.surface === "zetaris.control");
          const v = validateZetarisCommit({ vaultDir: opts.vaultDir, tenant: opts.tenant, commit, redactor: r, recorded: copies === null ? null : new Map(mine.map((c) => [c.object_id, c.blob_sha256])) });
          const byObject = new Map(v.objects.map((o) => [o.object_id, o]));
          let matched = 0;
          for (const c of mine) {
            const o = byObject.get(c.object_id);
            if (!o) continue;
            matched++;
            rows.push(...copyValidationRows([c], o, { validator: "zetaris-json", validatedAt }));
          }
          return { v, copies, matched };
        };
        const { v, copies, matched } = await objectsOf(head);
        const gaps = [...new Set(v.objects.flatMap((x) => x.missing_dependencies))].sort();
        const firstFail = v.objects.find((x) => x.result === "fail");
        const why = firstFail ? ` | first fail ${firstFail.object_id}: ${firstFail.output.split("\n")[0]}` : "";
        const unread = copies === null ? "; recorded hashes unchecked (no store)" : "";
        lines.push(`${label} @${v.commit.slice(0, 8)} (run ${v.run_id ?? "-"}): zetaris-json ${v.objects.length ? worstOf(v.objects) : "no objects"}, ${n(v.objects.length, "object")} (${tally(v.objects)}), ${gapsText(gaps)}; ${copiesText(copies, matched)}${unread}${why}`);
        if (earlier.length) {
          const results: { result: ValidationResult }[] = [];
          let all = 0;
          let mine = 0;
          for (const commit of earlier) {
            const e = await objectsOf(commit);
            results.push({ result: worstOf(e.v.objects) });
            all += e.copies?.length ?? 0;
            mine += e.matched;
          }
          lines.push(earlierLine(label, "zetaris-json", results, null, all, mine));
        }
      }
    } catch (e) {
      lines.push(`${label}: validation stopped: ${safe(e)}`);
      errors++;
    }
  }

  const written = opts.dryRun || !opts.store ? null : rows.length ? await opts.store.insertCopyValidations(rows) : 0;
  return { lines, rows, written, errors };
}
