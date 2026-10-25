// rollback_file: a ROLLBACK on a linux.nginx setting carried out. The file's approved copy comes from the vault
// commit the Decider named, its real path from that commit's .drift/paths.json (the database carries the redacted
// object id only), and the previous state from the vault's commit of the run the disposition decided on. One SSH
// session (src/actions/ssh.ts) writes the copy, runs nginx -t and reloads, writing the previous bytes back on any
// refusal or failure; then the names the restored file serves are probed (http and tls through src/probe).
//
// Contract:
//   prepareRollback  everything a plan and a write need, read before anything is written: the host's ssh alias
//                    (LINUX_HOSTS, by the pseudonym the collector gives it), the copy (plan.ts resolveCopy), the
//                    copy's bytes with their sha256 equal to the copy row's blob_sha256, a real path the write
//                    script accepts, the previous bytes, which for a `file` setting must hash to the disposition's
//                    live value, and the names the copy's run records for the object. Any gap is a refusal with
//                    one sentence, and nothing is written. The real names the copy serves come from its bytes
//                    (src/collectors/nginx.ts serverNames) and go to the probe function beside the redacted ones,
//                    so a name a wildcard of its zone covers is probed under that wildcard (src/probe/rules.ts
//                    matchName, the rule the probe run's population uses). A failed rollback of the same target to the same commit
//                    over the same live bytes is refused too: that write is left to a technician. An unverified one
//                    completed its write, so the rollback goes ahead and its reason names that action.
//   planRollback     the dry-run lines (plan.ts): what would be written where, from which commit, what follows.
//   rollbackFile     the session and the probes, settleMs after the reload (RELOAD_SETTLE_MS live). The write path
//                    completes when write, nginx -t and the reload exit 0 and the file's sha256 after is the copy's. done: completed, at least one probe of the
//                    served names ran, and every probe that ran is ok; a probe recorded skipped (the tls of a
//                    PROBE_TARGETS_OVERRIDE target) did not run, counts neither way, and the reason names it;
//                    verification holds the ids of the probes that ran. unverified: completed, and no probe verified
//                    it: the copy's run records no name the object serves, the probe population is unreadable, the
//                    account holds no record of the names and no wildcard covers them, every probe was skipped, or a probe reached no address
//                    because its name resolves nowhere (no probe answering fail). refused: the live file is a symlink, is unreadable, changed since the run, or sudo
//                    refused before the write ("sudo: a password is required"). failed: the write path did not
//                    complete, with nginx's or systemd's output redacted and the write-back named, or a probe that
//                    answered fails, the failing probes named.
//
// Measured 24 Oct 2026: every end above exercised against a fake host and a fake probe (test/actions.test.ts); the
// production hosts had received 0 writes from it. Measured 25 Oct 2026 on the lab estate (lab/README.md), tenant
// lab-1: act-649588b7e1625711, under PROBE_TARGETS_OVERRIDE, wrote the copy over a break to 8094 and ended done, http
// lab.example 200 over plain http 2 s after the reload, tls skipped, verification probe-36eb2c1bba298a2a;
// act-b5d5e77f69ab6f17 wrote the copy over a break to 8091 (write, nginx -t and reload at exit 0, after_hash the
// copy's, 1.9 s) and ended unverified, "no probe of lab.example ran (the account holds no record of these names)";
// act-66ac170572034040, a retry of a failed write, was refused.

import { redactText } from "../collectors/linux.ts";
import { serverNames } from "../collectors/nginx.ts";
import type { Action, Disposition, Probe } from "../data/rows.ts";
import type { Redactor } from "../redactor.ts";
import { treePath, sha256, type Vault } from "../vault/vault.ts";
import {
  c8, gaps, h12, outcome, plural, priorUnverified, priorWrites, probeSentence, resolveCopy, sha,
  type ActionOutcome, type ActorReads, type CopyChoice, type Emitter, type ProbeFn, type Row,
} from "./plan.ts";
import { NGINX_PATH, hex256, parseSession, writeScript, type SshRunner } from "./ssh.ts";

export interface RollbackDeps {
  reads: ActorReads;
  vault: Vault | null;
  /** The ssh alias of a host pseudonym, or null when LINUX_HOSTS lists none for it. */
  aliasOf: (host: string) => string | null;
  ssh: SshRunner;
  probe: ProbeFn;
  redactor: Redactor;
  now: () => Date;
  tracer?: Emitter;
  /** Milliseconds between the reload and the verification probes (the live Actor: RELOAD_SETTLE_MS); 0 or absent, none. */
  settleMs?: number;
}

/**
 * The live Actor's wait between the reload and its verification probes. systemctl reload nginx returns once the master
 * has the signal, and the old workers answer new connections until the new ones take over. Measured 25 Oct 2026 on
 * the lab: lab.example answered from the old configuration for 0.13 s after the reload returned, and a probe made
 * straight after the session read the old configuration's 502 (act-3892888a4e7bd1e5). The wait leaves 15 times that.
 */
export const RELOAD_SETTLE_MS = 2_000;

export interface PreparedRollback {
  alias: string;
  path: string;
  choice: CopyChoice;
  copy: Uint8Array;
  /** null when the file is absent from the run's commit (an approved setting whose object is missing). */
  previous: Uint8Array | null;
  /** The commit of the run the disposition decided on. */
  runCommit: string;
  /** The redacted names the copy's run records for the object. */
  names: string[];
  /** The real names the copy's server blocks carry (src/collectors/nginx.ts serverNames over its bytes): for the probe function only, never printed. */
  served: string[];
  /** The latest unverified rollback of the same target to the same commit over the same live bytes; null when none. */
  prior: Action | null;
}

export type RollbackPrep = PreparedRollback | { refused: string };

/** The redacted names an nginx object serves in one run's observations. */
export function servedNames(obs: readonly Row[], objectId: string): string[] {
  return [...new Set(obs.filter((o) => o.object_id === objectId && o.refers_to_type === "dns_name" && o.setting_path.includes(".server_name[")).map((o) => o.refers_to_id))].sort();
}

const safe = (r: Redactor, e: unknown): string => redactText(r, (e as Error)?.message ?? String(e));

export async function prepareRollback(d: Disposition, deps: RollbackDeps): Promise<RollbackPrep> {
  const r = deps.redactor;
  const alias = d.host ? deps.aliasOf(d.host) : null;
  if (!alias) return { refused: `no ssh alias in LINUX_HOSTS maps to host ${d.host ?? "(none)"}` };
  const choice = await resolveCopy(d, deps.reads);
  if ("refused" in choice) return choice;
  const { copy } = choice;
  if (!deps.vault) return { refused: "the vault is off (DRIFT_VAULT_DIR is blank), so the copy's bytes cannot be read" };
  let path: string | undefined;
  let bytes: Uint8Array | undefined;
  let previous: Uint8Array | null;
  let runCommit: string | null;
  try {
    const tree = deps.vault.readTree(d.tenant_id, alias, copy.git_commit);
    path = Object.entries(tree.paths).find(([, id]) => id === d.object_id)?.[0];
    if (!path) return { refused: `vault commit ${c8(copy.git_commit)} holds no file for ${d.object_id}` };
    bytes = tree.files.get(treePath(path));
    if (!bytes) return { refused: `vault commit ${c8(copy.git_commit)} lists ${d.object_id} and holds no bytes for it` };
    if (sha256(bytes) !== copy.blob_sha256) return { refused: `the bytes at vault commit ${c8(copy.git_commit)} hash to ${h12(sha256(bytes))}; the copy row says ${h12(copy.blob_sha256)}` };
    runCommit = deps.vault.commitOf(d.tenant_id, alias, d.run_id);
    if (!runCommit) return { refused: `the vault holds no commit of run ${d.run_id}, so the bytes the rollback replaces are unknown` };
    previous = deps.vault.readTree(d.tenant_id, alias, runCommit).files.get(treePath(path)) ?? null;
  } catch (e) {
    return { refused: `the vault refused the read: ${safe(r, e)}` };
  }
  if (!NGINX_PATH.test(path) || path.split("/").some((s) => s === "." || s === "..")) return { refused: `${d.object_id} sits outside the paths the write script takes (under /etc/nginx/)` };
  if (previous && d.setting_path === "file" && sha256(previous) !== d.value_hash) {
    return { refused: `the vault's commit of run ${d.run_id} holds ${h12(sha256(previous))} for the file; the disposition decided on ${h12(d.value_hash)}` };
  }
  const prior = priorWrites(deps.reads, d, "rollback_file", copy.git_commit, previous ? sha256(previous) : null);
  if (prior.failed) {
    return { refused: `action ${prior.failed.action_id} rolled this file back to commit ${c8(copy.git_commit)} over the same live bytes and failed at ${prior.failed.finished_at ?? prior.failed.started_at}; the same write is left to a technician` };
  }
  const names = servedNames(await deps.reads.observationsOf(copy.run_id), d.object_id);
  const served = serverNames(Buffer.from(bytes).toString("utf8"), path);
  return { alias, path, choice, copy: bytes, previous, runCommit, names, served, prior: prior.unverified };
}

/** A probe that reached no address: its name resolves nowhere, so it verifies nothing either way. */
const UNRESOLVED = /^unreachable: (ENOTFOUND|ENODATA|EAI_AGAIN)\b/;

/** The dry-run lines of one rollback. */
export function planRollback(d: Disposition, p: PreparedRollback): string[] {
  const { copy } = p.choice;
  const over = p.previous
    ? `over the live file ${h12(sha256(p.previous))} as run ${d.run_id} recorded it`
    : `where run ${d.run_id} recorded no file, so the copy creates it`;
  return [
    `target ${d.object_id} on ${d.host} (ssh alias ${p.alias}), ${d.verb} under ${d.rule_id ?? "no rule"}`,
    `write ${plural(p.copy.length, "byte")} (sha256 ${h12(sha256(p.copy))}) from vault commit ${c8(copy.git_commit)} (copy ${copy.copy_id} of run ${copy.run_id}, validated ${copy.result} with ${plural(gaps(copy), "gap")}) ${over}, through sudo -n tee`,
    `then sudo -n nginx -t, the previous ${p.previous ? "bytes written back" : "state restored by removing the file"} on a refusal; sudo -n systemctl reload nginx, the same on a failure; the file's sha256 after`,
    p.names.length
      ? `then probes http and tls of ${p.names.join(", ")}`
      : `then no probe: run ${copy.run_id} records no name the object serves, so a completed write would end unverified`,
    ...(p.prior ? [`action ${p.prior.action_id} wrote this copy over the same live bytes at ${p.prior.finished_at ?? p.prior.started_at} and ended unverified; the write runs again`] : []),
  ];
}

const firstLine = (s: string): string => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
const lastEmerg = (s: string): string => s.split("\n").filter((l) => /\[(emerg|alert|crit|error)\]/.test(l)).pop()?.replace(/^nginx: /, "").trim() ?? firstLine(s);

/** The session, then the probes (see the header). */
export async function rollbackFile(d: Disposition, p: PreparedRollback, deps: RollbackDeps): Promise<ActionOutcome> {
  const r = deps.redactor;
  const red = (s: string): string => redactText(r, s);
  const started = deps.now().toISOString();
  const { copy } = p.choice;
  const copyHex = hex256(p.copy);
  const expect = p.previous ? hex256(p.previous) : "absent";
  const record: string[] = [
    `vault commit ${c8(copy.git_commit)} holds the copy (${plural(p.copy.length, "byte")}, sha256 ${h12(copyHex)}); the commit of run ${d.run_id}, ${c8(p.runCommit)}, holds ${p.previous ? `the previous bytes, ${h12(expect)}` : "no file at this path"}`,
  ];
  const base = { vault_commit: copy.git_commit, started_at: started };
  const end = (status: "done" | "unverified" | "failed" | "refused", reason: string, extra: { before?: string | null; after?: string | null; verification?: string[] } = {}): ActionOutcome =>
    outcome(d, "rollback_file", {
      ...base, status, reason: red(`${reason}${priorUnverified(p.prior)}`), record: record.map(red), finished_at: deps.now().toISOString(),
      before_hash: extra.before === undefined || extra.before === null || extra.before === "absent" || extra.before === "unreadable" ? null : sha(extra.before),
      after_hash: extra.after ? sha(extra.after) : null, verification: extra.verification,
    });

  let script: string;
  try {
    script = writeScript({ path: p.path, copy: p.copy, previous: p.previous });
  } catch (e) {
    return end("refused", (e as Error).message);
  }
  let res;
  try {
    res = await deps.ssh(p.alias, script);
  } catch (e) {
    return end("failed", `the ssh session to ${p.alias} did not start: ${safe(r, e)}`);
  }
  const s = parseSession(res.stdout);
  const section = (name: string) => s.sections.find((x) => x.name === name);
  for (const x of s.sections) record.push(`${x.name}: exit ${x.rc}${x.output ? `, ${firstLine(x.output)}` : ""}`);
  const restoredNote = (): string => {
    if (s.restored === null) return "";
    return s.restored === expect
      ? `; the previous ${p.previous ? "bytes were written back" : "state was restored (the file removed)"}, the file is ${s.restored === "absent" ? "absent" : h12(s.restored)} again`
      : `; writing the previous state back left the file at ${s.restored === "absent" ? "absent" : h12(s.restored)}, the previous state is ${expect === "absent" ? "absent" : h12(expect)}: the host needs a technician`;
  };
  if (s.complete && s.link) return end("refused", "the live path is a symlink; the write path writes regular files only");
  if (s.before === null) {
    const why = firstLine(res.stderr);
    return end("failed", `the ssh session to ${p.alias} ended before the script reported (exit ${res.code ?? "?"}${why ? `: ${why}` : ""})`);
  }
  if (!s.complete) {
    return end("failed", `the session ended after step ${s.sections.at(-1)?.name ?? "before"} (exit ${res.code ?? "?"}); the host state after it is unknown`, { before: s.before, after: s.written });
  }
  record.push(`live file before: ${s.before === "absent" ? "absent" : s.before === "unreadable" ? "unreadable by the login" : h12(s.before)}`);
  if (s.before === "unreadable") return end("refused", "the login cannot read the live file, so its bytes cannot be compared with the run's", { before: s.before });
  if (s.changed) {
    return end("refused", `the live file is ${s.before === "absent" ? "absent" : h12(s.before)} and run ${d.run_id} recorded ${expect === "absent" ? "no file" : h12(expect)}: it changed since the decision, and nothing was written`, { before: s.before });
  }
  const write = section("write");
  if (write && write.rc !== 0) {
    if (/a password is required/.test(write.output)) return end("refused", `sudo: a password is required${restoredNote()}`, { before: s.before, after: s.restored });
    return end("failed", `the write failed: ${firstLine(write.output) || `exit ${write.rc}`}${restoredNote()}`, { before: s.before, after: s.restored ?? s.before });
  }
  if (s.written !== copyHex) {
    return end("failed", `the written file hashes to ${h12(s.written)}, the copy to ${h12(copyHex)}${restoredNote()}`, { before: s.before, after: s.restored });
  }
  const nginxT = section("nginx-t");
  if (nginxT && nginxT.rc !== 0) {
    return end("failed", `nginx -t refused the copy: ${lastEmerg(nginxT.output) || `exit ${nginxT.rc}`}${restoredNote()}`, { before: s.before, after: s.restored });
  }
  const reload = section("reload");
  if (reload && reload.rc !== 0) {
    return end("failed", `systemctl reload nginx failed: ${firstLine(reload.output) || `exit ${reload.rc}`}${restoredNote()}`, { before: s.before, after: s.restored });
  }
  if (s.after !== copyHex) {
    return end("failed", `the file hashes to ${h12(s.after)} after the reload, the copy to ${h12(copyHex)}`, { before: s.before, after: s.after });
  }
  record.push(`after: ${h12(s.after)}, the copy's bytes; nginx -t passed and nginx reloaded`);
  const after = { before: s.before, after: s.after };
  if (!p.names.length) {
    return end("unverified", `written and reloaded; run ${copy.run_id} records no name the object serves, so no probe ran`, after);
  }
  if (deps.settleMs) {
    await new Promise((resolve) => setTimeout(resolve, deps.settleMs));
    record.push(`probes asked ${deps.settleMs} ms after the reload returned, once the new workers answer`);
  }
  let rows: Probe[];
  try {
    rows = await deps.probe(p.names, ["http", "tls"], p.served);
  } catch (e) {
    return end("unverified", `written and reloaded; the probes of ${p.names.join(", ")} did not run: ${safe(r, e)}`, after);
  }
  for (const x of rows) record.push(probeSentence(x));
  if (!rows.length) return end("unverified", `written and reloaded; no probe of ${p.names.join(", ")} ran (the account holds no record of these names)`, after);
  // A skipped probe did not run (the tls of a PROBE_TARGETS_OVERRIDE target): it is recorded and counts neither way.
  const ran = rows.filter((x) => x.status !== "skipped");
  const skipped = rows.filter((x) => x.status === "skipped");
  const skipList = `${skipped.map((x) => `${x.kind} ${x.target}`).join(", ")}: ${[...new Set(skipped.map((x) => x.observed.replace(/^skipped: /, "")))].join(", ")}`;
  const skipText = skipped.length ? `; ${skipped.length} skipped (${skipList})` : "";
  const ids = ran.map((x) => x.probe_id);
  if (!ran.length) return end("unverified", `written and reloaded; no probe of ${p.names.join(", ")} ran (${skipped.length} skipped: ${skipList})`, after);
  const notOk = ran.filter((x) => x.status !== "ok");
  const unread = notOk.filter((x) => UNRESOLVED.test(x.observed));
  const failing = notOk.filter((x) => !UNRESOLVED.test(x.observed));
  if (failing.length) {
    return end("failed", `written and reloaded; ${failing.length} of ${plural(ran.length, "probe")} fail: ${failing.map((x) => `${x.kind} ${x.target}`).join(", ")}${skipText}`, { ...after, verification: ids });
  }
  if (unread.length) {
    const nowhere = [...new Set(unread.map((x) => x.target))].sort();
    return end("unverified", `written and reloaded; ${unread.length} of ${plural(ran.length, "probe")} reached no address: ${nowhere.join(", ")} ${nowhere.length === 1 ? "resolves" : "resolve"} nowhere (${[...new Set(unread.map((x) => x.observed.replace(/^unreachable: /, "")))].join(", ")})${skipText}`, { ...after, verification: ids });
  }
  return end("done", `restored to the approved copy at vault commit ${c8(copy.git_commit)}; nginx -t passed, nginx reloaded, ${plural(ran.length, "probe")} of ${p.names.join(", ")} ok${skipText}`, { ...after, verification: ids });
}
