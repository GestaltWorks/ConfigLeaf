# drift-agent: design

## 1. What it is

drift-agent is a configuration assurance layer above the MSP tool stack that remembers. For every setting it can
reach it asks: does a configuration exist for everything that should; is it fully configured; is it backed up; what
exactly is in the copy, against what should be there for that device class; has it changed since the copy; can the
copy be restored (it validates, its dependencies exist); would a restore regress, and of what kind; and is it
FOUND-BUT-DIFFERENT: a byte-identical setting whose referent now means something else. The agent acts under the
MSP's policy: a critical setting that drifted from its approved value, with a valid copy, is rolled back to the copy,
verified and documented; a drifted setting with no valid copy and production affected is investigated, fixed where
allowed, documented and ticketed; everything else is adopted or held with a reason and an expiry. A config lock on a
setting class means automatic rollback at the next cycle. The hackathon slice takes nginx vhost files and the
Cloudflare records they depend on through the whole loop, on the operator's two production hosts and six zones.

An MSP's knowledge of one setting is fragmented across eight places: the live host (read over SSH), the nightly
export (the backup tarball), the documentation of record (`approved_setting`; IT Glue and Hudu map here), the DNS
provider (Cloudflare records), the provider's audit log, the asset inventory, what the site answers from outside (the
probes) and the PSA (the tickets). Whether a setting is right, backed up, restorable and still means what it meant
takes several of them at once. The agent reads them as one: every question it answers is a join across two or more of
those sources through one Zetaris layer (the `DRIFT` datasource, with the USL and its DQ rules over it), and
FOUND-BUT-DIFFERENT exists only in that join: unchanged bytes on the host, a changed answer from the DNS provider, an
address the inventory lacks. Within the sources it is given, the agent discovers the population of each source before
it reads a row (so a short read fails the DQ gate), every file a configuration pulls in, every regular member of the
newest backup tarball, every dependency a restore needs that the vault holds no copy of (named by the validator),
every name a zone serves, and what is absent: an approved setting with no observation (`approved_missing`). Discovery
of sources themselves (new hosts, new accounts, new tools) belongs to a discovery agent in the larger product; this
agent discovers within the sources it is configured with (`LINUX_HOSTS`, one Cloudflare account).

## 2. The questions it answers for a setting

- **Does a configuration exist for everything that should?** `orphan_record`: a record landing where no enabled
  block names it; `orphan_vhost`: a `server_name` with no record; `approved_missing`: an approved vhost file or record
  absent from the latest passing run; `run_complete`: each run collected what it asserted (live host, export,
  documentation of record, DNS, audit log, inventory).
- **Is it fully configured?** `proxied_without_real_ip`: a proxied name served by a block that trusts no `real_ip`
  range. `proxy_split`: a proxied CNAME aliasing a direct address record, which publishes the origin the proxy hides
  (live host, DNS, audit log, inventory).
- **Is it backed up?** `vault_copy`: each object's bytes per complete run, in git; `backup_item`: the nightly export
  (live host, export, DNS).
- **What exactly is in the copy, against what should be?** The vault commit holds the bytes (`blob_sha256`);
  `approved_setting` holds the value of record; the policy rule that governs the setting names its class (live host,
  documentation of record, DNS).
- **Has it changed since the copy?** `changed_since_backup`: a live file the newest backup lacks or holds with other
  bytes. `drift_vs_approved`: a live value that differs from its latest approval (live host, export, documentation of
  record, DNS, audit log).
- **Can the copy be restored?** `copy_validation`: `nginx -t` over the tree a restore would lay down, a shape and
  dependency check over each record; every missing dependency named (live host, DNS, inventory).
- **Would a restore regress, and of what kind?** `restore_would_regress`: approvals newer than the backup whose value
  the backup lacks or holds otherwise; the validation's gaps name what a restore leaves missing (live host, export,
  documentation of record).
- **Is it FOUND-BUT-DIFFERENT?** One SQL comparison over `observation` and `referent_fingerprint` for a run and its
  previous passing run: equal `value_hash`, different fingerprint; the World Model holds the same answer. In the pass
  the hero query's rows (a setting pointing at a name that resolves outside the inventory) are `found_but_different`
  where the bytes are unchanged and the fingerprint changed, and `dns_change` for every other row (live host, DNS,
  audit log, inventory).

The README's "Where each answer comes from" lists, per finding class, the tables its detector query and its default
checks name and the source of each, read off the SQL by `npm run sources`.

## 3. The data model

`sql/schema.sql` is one portable DDL for SQLite (sql.js: sample mode, tests) and Postgres (the app database, the
`DRIFT` datasource in Zetaris): ISO 8601 UTC text timestamps, INTEGER 0/1 flags, TEXT ids from `stableId` over each
row's natural parts, so a re-run inserts nothing twice; every collected-text column is redacted before it is stored.

| table | one row is | written by |
|---|---|---|
| `collection_run` | one pass over one surface (`linux.nginx`, `cloudflare.dns`, `cloudflare.audit`, `probe`, and `probe.verify` for the Actor's probes after a write), its asserted population, its status | the collectors, the probe run and the Actor's verification |
| `observation` | one setting value in one run: object, dotted path, hash, redacted value, referent, the source's authority | the Linux collector (per file and directive), the Cloudflare collector (per record field) |
| `approved_setting` | one value of one setting a technician signed off, with who, when and a note; the detectors `drift_vs_approved` and `approved_missing` read its latest row per setting, and a latest row of value '' approves the object's absence | `npm run approve`; the Actor, for a record it re-created under a new id |
| `backup_snapshot` | one backup artefact of one host: the nightly export tarball | the Linux collector |
| `backup_item` | one file hash a snapshot holds | the Linux collector |
| `dns_record` | one Cloudflare record as seen in one DNS run | the Cloudflare collector |
| `audit_event` | one event of the Cloudflare account audit log | the Cloudflare collector |
| `inventory_asset` | one global address of a client host; membership is every address ever observed, temporary and deprecated IPv6 addresses excluded, `observed_at` the last time a run saw it | the Linux collector |
| `policy_rule` | one version of one rule of the MSP's policy | `npm run policy:load` |
| `vault_copy` | one object of one complete run, committed to the vault | the collectors' vault hook |
| `copy_validation` | one validation of one vault copy: validator, result, missing dependencies, output | `npm run validate:copies` |
| `probe` | one probe (http, dns or tls) of one served name in one probe run | `npm run probe`; the Actor's verification |
| `disposition` | the decision on one finding in one pass: verb, reason, expiry, who decided, the rule; keyed on the live value, the run and `decided_at`, so every pass writes its own row | the pass, through its ledger (`PgLedger` live, `MemoryLedger` in sample mode and tests) |
| `action` | what the Actor did about a disposition: kind, target, hashes before and after, vault commit, verifying probes, receipts, status, the Actor's sentence (`reason`) and the record of what ran (`record`, each line tied to its id) | the Actor behind `--apply` (`npm run act`, `src/actions/`), one row as each action ends |
| `ticket` | the PSA ticket a disposition or an action opened: PSA, external id, url, type, priority, status | the ticket step (`npm run tickets`, `src/psa/step.ts`) |
| `referent_fingerprint` | what one `dns_name` observation's name resolved to in one DNS run | the pass, in its observe step |

## 4. The loop

1. **Collect and vault.** `collect:linux` opens one SSH session per host through the operator's own `ssh_config`
   alias and streams a fixed script of reads; `collect:cloudflare` reads zones, records and the account audit log
   with a read token. Each asserts its population before its first row and writes through the Store into the app
   Postgres. A run that finishes complete is committed to the vault, one `vault_copy` row per object.
2. **Gate (DQ).** `run_complete` in SQL: a run fails when it observed fewer than it asserted, finished other than
   complete, asserted nothing, or (host surfaces) stored fewer rows than it asserted; a failing run feeds nothing
   below. In Zetaris it is a DQ rule on the USL's `collection` table, beside `copy_validated` on `copy` (the latest
   validation passed) and `action_verified` on `action`, scoped to the write paths: `kind NOT IN
   ('rollback_file','revert_record') OR status <> 'done' OR verification <> ''`.
3. **Verify.** The questions as SQL in the portable subset through one DataLayer: the hero query, the survey, the
   detectors (`drift_vs_approved`, `changed_since_backup`, `approved_missing`), then the precondition catalogue per
   finding. Live, the engine is Zetaris over `DRIFT`; in sample mode, sql.js over the exported bundle;
   `test/parity.test.ts` holds the two to the same columns, rows and totals.
4. **Triage and judge.** Nemotron Lightning picks catalogue templates and fills their typed parameters; Nemotron
   Ultra answers a detector's claim with one SELECT that returns rows when the claim is false, which the agent guards
   and runs. A verdict counts when its signed receipt verifies, names the tier requested and passes custody (the
   request id, the per-tenant app id `drift-agent-<tenant>`). With no model, the class's default checks run and the
   judge is skipped.
5. **Decide.** `src/policy/decide.ts`, pure: the operator's exception (an accepted H-MEM lesson in force gives ADOPT
   until its expiry; a lapsed one ESCALATE), then the policy rule that governs the setting, then the default (ADOPT
   as a candidate when every check holds and none was rejected, else ESCALATE). A HOLD the rule gives meets the
   latest HOLD the ledger holds on the same live value decided before the pass (`PRIOR_HOLDS_SQL`): in force, it keeps
   that HOLD's expiry, which every kept HOLD carries forward from the first, and the rule's sentence built with that
   expiry, the reason reading "<the rule's sentence, until <expires_at>>; held since <decided_at> under rule <id>",
   one expiry named; at or past it, ESCALATE. Each reason is one plain sentence over redacted text, hashes as 12 hex, commits as 8.
6. **Record.** One `disposition` per finding per pass, keyed on the live value, the run and `decided_at`: a later
   change, a new run or a later pass is a new row, so an expired HOLD's ESCALATE lands with or without a new
   collection, and a second pass at the same instant over the same runs writes 0; one `referent_fingerprint` per
   `dns_name` observation of each passing host run.
7. **Act and ticket.** The Actor (`src/actions/`) reads the pass's dispositions through the DataLayer, the latest of
   each finding on the pass's runs, and acts once per disposition and kind. It is a dry run by default: the plan,
   redacted, and nothing written; `--apply` carries it out and writes each `action` row as the action ends, its
   one-sentence reason and the record of what ran included.
   - `rollback_file`, a ROLLBACK on an nginx file: the Decider's copy from the vault commit its reason names, written
     over one SSH session (`sudo -n tee`, `sudo -n nginx -t`, `sudo -n systemctl reload nginx`), the previous bytes
     written back on a refusal or any failure, then http and tls probes of the names the file serves, as a probe run
     of surface `probe.verify`; done needs every probe ok.
   - `revert_record`, a ROLLBACK on a record field: `PATCH` to the vault JSON, or `POST` for an approved record the
     zone lacks, read back and compared field by field, then one dns probe of the name (surface `probe.verify`). A
     record created again carries its approvals to its new id and its old id's absence is approved, so the next cycle
     raises nothing on either.
   - `investigate`, for a FIX and for an ESCALATE under an `on_drift` investigate rule: Lightning picks the checks,
     they run through the DataLayer, Ultra judges the claim under the tenant's app id; the record ties each sentence
     to its query, receipt or probe id. `fix` follows a FIX's investigation and is refused: a FIX names no valid
     copy.
   - Every write path refuses a live file or record that changed since the decision, and a retry of a failed write to
     the same target, commit and live value.

   The ticket step (`src/psa/`) then plans from the pass's findings, the ledger, the actions and the ticket rows:
   ESCALATE and FIX open an incident; ROLLBACK opens a change under `alert` always or on_fix, once its action is
   recorded; HOLD opens an incident under `alert` always; ADOPT opens nothing. Priority is the rule's
   `psa_priority`, P3 with no rule. A ticket is updated in place: a new action or a new verb is one comment; a change
   closes when its action is done and verified; a HOLD's ticket closes on ADOPT, or when a pass that covers the
   setting raises nothing on it; a closed row stays closed. Every string passes the tenant's redactor and the
   deny-list probe before it leaves; one label and nothing is sent.
8. **Document and repeat.** The owner's document (`src/document/render.ts`) is one markdown page per tenant from 13
   named queries: estate, copies, approvals, open findings, where each answer comes from (read off the SQL text),
   work, probes and the queries it ran. `npm run cycle`
   runs collect, probe, validate, pass, act, tickets and document once, the first failing step stopping it; `npm run
   watch` runs the cycle every N minutes until SIGINT.

| verb | decided when | what follows |
|---|---|---|
| ROLLBACK | `drift_vs_approved` under a rule with `lock` 1 or `on_drift` rollback, with a vault copy of the approved value whose latest validation is ok or ok_with_gaps | behind `--apply`, `rollback_file` (an nginx file) or `revert_record` (a record field), verified by probes, recorded as an `action`; a change ticket under `alert` always or on_fix |
| ROLLBACK (`approved_missing`) | an approved vhost file or record absent from the run, under the same terms with a valid copy of the approved value: a drift from the approved value to the live value "" | behind `--apply`, the file written back from the copy, or the record created again by `POST` (refused when a record of the same name, type and content exists), its approvals carried to the new id; the other verbs follow the rows below, ADOPT adopting the absence |
| FIX | under those terms, no valid copy and production affected with `on_no_copy` investigate_ticket; `on_drift` investigate with production affected | `investigate`, then `fix`, refused with no valid copy; an incident ticket |
| ESCALATE | under those terms, no valid copy and production affected with `on_no_copy` ticket; under those terms, no valid copy and production unknown, the reason naming why; `on_drift` investigate with production answering or unknown; a HOLD whose prior HOLD on the same live value has expired; by default, a check fails or could not run; a lapsed exception | an incident ticket; `investigate` under an `on_drift` investigate rule; a technician takes it |
| HOLD | under those terms, no valid copy and production answering; `on_drift` hold; a rollback rule over a finding of another class, which concerns the setting's relation to another setting while its own value stands | held until `decided_at + hold_max_hours`, the expiry on the row; a live value held before keeps the expiry its first HOLD set; an incident ticket under `alert` always |
| ADOPT | `on_drift` adopt; `on_no_copy` adopt with production affected; by default, every check holds; an accepted exception in force | the live value stands; no ticket, and an open HOLD ticket on the finding closes |

## 5. Policy

The policy is data: `policy/hackathon.json` (or the file `DRIFT_POLICY_FILE` names), loaded by `npm run policy:load`
into `policy_rule` rows. The file passes a closed schema; its globs and notes pass through the tenant's redactor, so
a real name typed in a rule is stored as the pseudonym the observations carry and still matches them.

- `tenant_id`: one tenant, or `*` for every tenant. `surface`: `linux.nginx`, `cloudflare.dns` or `*`.
- `object_glob`, `setting_glob`: the objects and setting paths governed. `*` matches any run within one path
  segment, `**` any run across segments, `?` one character, and every other character itself.
- `criticality`: critical, high, normal or low, named in the reason.
- `lock`: 1 sends a drift from the approved value to the rollback terms at the next cycle, whatever `on_drift` says.
  A locked setting with no approved value on record is counted once per pass, with no finding.
- `on_drift`: rollback, investigate, adopt or hold. `on_no_copy`: what a drift under the rollback terms with no valid
  copy and production affected becomes: investigate_ticket (FIX), ticket (ESCALATE) or adopt (ADOPT).
- `hold_max_hours`: a HOLD under the rule expires this many hours after it is decided; a live value held before
  keeps the expiry its first HOLD set, and once that passes the finding is ESCALATE.
- `alert` (always, on_fix, never): when the ticket step opens a ticket for a ROLLBACK (always or on_fix) or a HOLD
  (always); ESCALATE and FIX open one whatever it says. `psa_priority` (P1 to P4): the ticket's priority.
- `version`, `author`, `since`, `note`: provenance; of each family (tenant, surface, object_glob, setting_glob) the
  highest version stands. `rule_id`: `stableId("rule", tenant, surface, globs, version)`; a re-load writes nothing.

A setting gets exactly one rule or none. Candidates are the rules whose tenant, surface and both globs match; each
family keeps its highest version; an exact tenant outranks `*`, then an exact surface outranks `*`, then the
object_glob with more literal characters, then the setting_glob with more, then the higher version, then the lower
rule_id. With no rule the default decides, exactly as in a pass over a bundle with no policy.

The hackathon file (tenant `*`, version 2, since 2026-10-25T00:00:00.000Z), rule by rule. Version 2 adds rules 7
to 10; the other eleven carry version 1's families and terms, under new rule ids because the version is part of
the id. `policy_rule` keeps both versions (26 rows on 24 Oct 2026), and version 2 is the highest of every family.

| # | surface | object_glob | setting_glob | terms | rule_id |
|---|---|---|---|---|---|
| 1 | linux.nginx | `/etc/nginx/conf.d/*.conf` | `file` | critical, lock 1, rollback, on_no_copy investigate_ticket, hold 24 h, alert on_fix, P1 | `rule-e186e9d5790a7e6b` |
| 2 | linux.nginx | `/etc/nginx/sites-available/*` | `file` | as rule 1 | `rule-6c41a25a00c404c8` |
| 3 | linux.nginx | `/etc/nginx/nginx.conf` | `file` | as rule 1, alert always | `rule-d0e0d34c8ae191b4` |
| 4 | linux.nginx | `/etc/nginx/conf.d/*.conf.*` | `**` | low, lock 0, adopt, alert never, P4 | `rule-42827f90778592ff` |
| 5 | linux.nginx | `**/*.bak*` | `**` | as rule 4 | `rule-44429a425c681bfd` |
| 6 | linux.nginx | `**/*.pre-symlink*` | `**` | as rule 4 | `rule-90f1bcb36548ea39` |
| 7 | linux.nginx | `/etc/nginx/sites-available/*.bak*` | `**` | as rule 4 | `rule-be0bf7afde964803` |
| 8 | linux.nginx | `/etc/nginx/sites-available/*.pre-symlink*` | `**` | as rule 4 | `rule-504a8801607b9f1c` |
| 9 | linux.nginx | `/etc/nginx/sites-available/*.orig` | `**` | as rule 4 | `rule-01eb3d1f7585323c` |
| 10 | linux.nginx | `/etc/nginx/conf.d/*.bak*` | `**` | as rule 4 | `rule-c6c3c71938210651` |
| 11 | linux.nginx | `**` | `server[*].real_ip` | high, lock 0, hold 72 h, on_no_copy ticket, alert never, P3 | `rule-66810b66396a3b15` |
| 12 | cloudflare.dns | `*` | `content` | critical, lock 1, rollback, on_no_copy investigate_ticket, hold 4 h, alert always, P1 | `rule-a3f26f34efab2ebb` |
| 13 | cloudflare.dns | `*` | `proxied` | as rule 12 | `rule-8e75e1d767980665` |
| 14 | cloudflare.dns | `*` | `ttl` | normal, lock 0, adopt, alert never, P4 | `rule-a8722e4f568e681e` |
| 15 | `*` | `**` | `**` | normal, lock 0, hold 72 h, on_no_copy ticket, alert never, P3 | `rule-b8d9962485c3ced4` |

Rule 1 restores a served vhost file to its approved copy when it drifts; rules 2 and 3 do the same for the
sites-enabled host's vhost files and `nginx.conf`; rules 4 to 10 adopt the dated, `.bak`, `.pre-symlink` and
`.orig` copies beside live files, rules 7 to 10 by more literal characters than the critical file rules carry
(31, 39 and 32 against the 27 of `/etc/nginx/sites-available/*`; 22 for the conf.d copies whose name holds no
`.conf.`); rule 11 holds a block's missing `real_ip` for three days; rules 12 and 13 lock where a name points and
whether it is proxied; rule 14 adopts TTLs; rule 15 holds everything else with an expiry. Measured 24 Oct 2026 on
the 54 distinct `file` settings of both hosts in `sample/bundle.json` (`test/policy.test.ts`): rule 1 takes the 8
live vhost files of the conf.d host's 18 `conf.d` files and rule 4 the 8 dated and `.bak` copies beside them; rule
2 the 11 live sites, rule 7 the 8 `.bak` copies and rule 8 the one `.pre-symlink` copy under `sites-available`;
rule 3 both `nginx.conf` files; rule 15 the other 16 (the certbot renewal configs, `mime.types`, two `.ready`
markers, `sites-enabled/default`). Measured 25 Oct 2026 by the sample pass over the bundle that carries the ledger
rows of five live passes (24 Oct 23:21 and 23:36 UTC, 25 Oct 01:16, 01:45 and 03:25 UTC): 27 findings by policy,
HOLD 26 and ESCALATE 1, decided at 2026-10-25T03:25:35.412Z (the bundle's instant: the latest `decided_at` of its
ledger rows, the 03:25 UTC live pass, later than the 03:25 UTC probe run's finish): 19 `proxied_without_real_ip` HOLD
under rule 11 (72 h), the `proxy_split` ESCALATE under rule 13 (4 h), 7 HOLD under rule 15 (72 h: the wildcard's
`http.real_ip`, 3 `orphan_record`, 3 `orphan_vhost`). The prior-HOLD read returns 23 rows, the 01:45 UTC live pass's
HOLD (2026-10-25T01:45:33.962Z) of each live value the 27 findings rest on, the latest before that instant. The 26
HOLDs keep the expiry carried from the 23:21 UTC pass, 2026-10-27T23:21:06.870Z, and the Decider's reason is the
rule's own sentence built with that expiry, then "held since 2026-10-25T01:45:33.962Z under rule <id>". The
`proxy_split`'s prior HOLD expires 2026-10-25T03:21:06.870Z, before the instant, so its verb is ESCALATE with the
reason "hold under rule <id> expired 2026-10-25T03:21:06.870Z; the finding stands". The pass writes 0 dispositions:
the bundle holds the 03:25 UTC pass's 27 rows under the same ids.

## 6. The vault and validation

`DRIFT_VAULT_DIR` names the vault, on the operator's machine, outside the repository; blank turns it off, and each
collector says so in one trace line. One git repository per tenant and host alias at
`<DRIFT_VAULT_DIR>/<tenant>/<alias>` holds the fetched files at their real paths without the leading slash
(`etc/nginx/nginx.conf`, `etc/nginx/conf.d/<name>.conf`), with `.drift/paths.json` (real path to redacted object id)
and `.drift/links.json` (each `sites-enabled` symlink to its target). One per tenant at
`<DRIFT_VAULT_DIR>/<tenant>/cloudflare` holds `<zone>/<record_id>.json` per record (id, name, type, content, ttl,
proxied). The tree mirrors the run, so a file absent from the run is absent from the commit. Each complete run is one
commit, "run <run_id> <surface> <started_at>", authored by drift-agent, an unchanged run included; a partial or
failed run commits nothing and the trace says so. The vault holds raw bytes and real names; what leaves it is commit
hashes, counts and redacted object ids. A `vault_copy` row's `blob_sha256` is the sha256 of the exact bytes, for a
file equal to its `file` observation's `value_hash`. Measured 24 Oct 2026 after the 23:35 UTC collection: three
repositories of three commits each, from the 19:56, 21:21 and 23:35 UTC runs, the last two changing no file: 58
record files, 32 files of the conf.d host (26 under `/etc/nginx`, 6 certbot renewal configs) and 22 of the
sites-enabled host (17 and 5) with its 6 `sites-enabled` links; 336 `vault_copy` rows, 112 of them at the heads
(`ff0750c9`, `2300af0a`, `c1a414f8`). `rollback_file` and `revert_record` read the copy's bytes from the commit the
Decider's reason names and the previous state from the commit of the disposition's run.

Approval is the documentation of record. `npm run approve` writes `approved_setting` rows from the latest passing
run: the `file` setting of every nginx object of a host (or one object, by real path or redacted id), or every
field of every record of a zone, of one record, or of the account. Measured 24 Oct 2026 over the 19:56 UTC runs: 26
approvals on the conf.d host, 17 on the sites-enabled host, 290 for the account's 58 records; 333 in all. Over the
21:21 UTC runs each of the 333 was current, and the approval wrote 0 rows.

**nginx-t** proves a vault commit restores to a tree nginx accepts. The commit is laid down in a temp directory the
way a restore would lay it down, each symlink a copy of its target. Before the first `nginx -t` the files
`nginx.conf` reaches are parsed (`src/collectors/nginx.ts`), and every dependency they name outside the tree gets a
placeholder of its kind: an empty file for an unresolved named include, one self-signed certificate and key for
`ssl_certificate` and its siblings, the RFC 7919 ffdhe2048 group for `ssl_dhparam`, an empty writable file for an
`access_log` or `error_log` in a directory the image lacks. Then `nginx -t` runs in an `nginx:1.27` container
through `DRIFT_NGINX_T` (on Windows by default through `wsl.exe -d Ubuntu-24.04`), and each round gives every
further path the output names as missing its placeholder. The result is ok when round 1 passes with no placeholder,
ok_with_gaps when a round passes with any, fail otherwise, in at most 12 rounds by default (`--max-rounds`);
`missing_dependencies` names every path seeded or reported missing, redacted.
**cf-schema** proves a record copy restores, offline: a known type, a name, content of the type's shape (A a dotted
IPv4, AAAA an IPv6, CNAME and NS a hostname, MX a mail host, TXT text), and its dependencies: a CNAME target present
as a record of the same run, an A or AAAA address present in the inventory; each absent one is named.

Measured 24 Oct 2026 at 21:22 UTC by `npm run validate:copies -- --tenant client-1` over the heads (cap 12, 4.0 s,
112 rows): the conf.d host ok_with_gaps in 1 round with 16 gaps, the sites-enabled host in 1 round with 13, every
one seeded from the parse before round 1: certbot's live certificates and keys (12 and 10),
`options-ssl-nginx.conf` and `ssl-dhparams.pem` on both, an origin certificate and key on the conf.d host, and on
the sites-enabled host the one snippet the collector leaves unread because its name is credential-shaped.
Cloudflare: 58 records, 42 ok and 16 ok_with_gaps, whose 7 distinct gaps are CNAME targets outside the collected
zones. Every vault copy matched its `vault_copy` row (32, 22 and 58). Measured again at 23:36 UTC as the validate
step of `npm run cycle` over the three commits of its collect steps (3.4 s, 112 rows): nginx-t ok_with_gaps on all
54 copies with 16 and 13 gaps, cf-schema 42 ok and 16 ok_with_gaps with 7 distinct gaps. The first commits' 54
nginx copies keep their fail rows of 19:59 UTC, validated at a 6-round cap with no pre-seeding, 6 gaps named on each
tree.

## 7. Probes and "production affected"

`npm run probe` asks every served name from outside, as one collection run of surface `probe` per tenant. The
population is read live from the Cloudflare API before any probe: the distinct names of the account's A, AAAA and
CNAME records, wildcards left out; `expected_count` is three per name. Four probes run at once, and every target,
expected and observed string is redacted before it is stored or printed.

- **http**: `GET https://<name>/`, `redirect: manual`, 10 s timeout. Expected: an answer below status 500, with the
  `cf-ray` header present for a proxied record and absent for a direct one.
- **dns**: A and AAAA through each of two public resolvers (`RESOLVERS` in `src/probe/rules.ts`). Expected: a direct
  record's content in both answers; a proxied record's content in neither, the origin staying hidden.
- **tls**: a handshake on 443 with the name as SNI. Expected: valid for the name, more than 7 days left.

Production is **affected** when a probe of the pass's probe run (surface `probe`) fails on a name the finding's object serves: an
nginx object's `server_name` values in the run, or a record's own name. It is **answering** when probes of those
names ran and every one passed, and **unknown** when the pass holds no probe run or no probe of those names. A drift
under the rollback terms with no valid copy escalates when production is unknown and is held when it answers; the
reason says which. Measured 24 Oct 2026 in three probe runs, at 19:59 UTC (12.0 s), at 21:21 UTC
(`run-b247c87d34f38d71`, 10.1 s) and at 23:36 UTC (`run-30f5647b8b9c5dff`, 8.9 s, the cycle's probe step): 37 names
and 111 of 111 probes each, http 27 ok and 10 fail, dns 34 ok and 3 fail, tls 30 ok and 7 fail; every probe of the
first two runs has the same outcome in both. A pass reads the passing probe run nearest in time to the finding's run,
within six hours: the 23:36 UTC one for the sample pass. `rollback_file` and `revert_record` probe again after a
write, and their probes go into the Store as one probe run of surface `probe.verify` per action (`runProbes` takes the
surface as an option, `probe` by default), which the pass leaves out of its probe run and `npm run document` counts
apart. The three `orphan_record` names
are among the failures (two answer status 526, one presents a certificate for other names), so their findings read
production affected, and the catch-all rule holds them for 72 h.

## 8. Adapters

Present:
- **Linux over SSH**: the operator's `ssh_config` aliases, one session per host, a fixed script of reads; behind
  `--apply`, one write session per `rollback_file` through the same alias (`src/actions/ssh.ts`).
- **Cloudflare**: a read token over zones, records and the account audit log; one observation per record field;
  behind `--apply`, `PATCH` and `POST` of a record for `revert_record`, with a token that holds DNS Edit.
- **Zetaris**: Lightning SQL over the app Postgres as the `DRIFT` datasource, and the `drift_usl` semantic layer of
  ten tables (`collection`, `setting`, `referent`, `backup_copy`, `policy`, `copy`, `probe`, `disposition`,
  `action`, `ticket`) with its three DQ rules.
- **Nightshift with Nemotron**: Lightning to choose checks, Ultra to judge under the tenant's app id, each verdict
  counted on a verified, custody-checked receipt.
- **GitHub Issues**: the ticket step's PSA backend (`src/psa/github.ts`) on the private repository
  `DRIFT_TICKETS_REPO` names; one issue per `ticket` row, `psa` github, `external_id` the issue number, `url` the
  issue, redacted; the token read once from `gh auth token` into memory. Labels carry the type, priority, class and
  verb.

Absent, with the one line each maps:
- **Liongard and CIPP sensors**: collectors; each reading becomes `observation` rows of a `collection_run` that
  asserts its population first.
- **StackJack**: a broker in front of those collectors; one adapter reads every sensor behind it.
- **IT Glue and Hudu**: the documentation of record; each configuration item maps onto `approved_setting` rows.
- **HaloPSA, ConnectWise, Autotask**: the PSA side of the ticket adapter; `src/psa/mapping.json` maps a `ticket`
  row's type, priority, status, summary, details and configuration item onto each PSA's ticket API (`POST
  /api/Tickets`, `POST /service/tickets`, `POST /Tickets`), with `psa` halo, connectwise or autotask.

## 9. Limits

- The write paths run behind `--apply` only, and on 24 Oct 2026 every Actor run was a dry run: the two live cycles
  planned 0 actions over 27 HOLD dispositions, and `rollback_file` and `revert_record` ran against a fake host, a
  fake probe and a fake fetch (`test/actions.test.ts`). The `action` table holds 0 rows. The first write to a host
  or a zone is the operator's rehearsal; `revert_record` needs a token that holds DNS Edit.
- One PSA backend: GitHub Issues. HaloPSA, ConnectWise and Autotask are the field map in `src/psa/mapping.json`. The
  `ticket` table holds 1 row on 25 Oct 2026: issue #2, the incident P1 for the `proxy_split` under rule 13, open.
  The HOLD expires 2026-10-25T03:21:06.870Z; the 03:25 UTC cycle of 25 Oct 2026, the first pass after it, records
  ESCALATE with the expired-hold reason, and its ticket step comments on issue #2 (the row's `updated_at`
  2026-10-25T03:26:31.652Z).
- The eval runner has run C0 on the development set (two runs, 0 calls) and the `EVAL_LIVE` smoke: C1 and C3 on
  three development items, 9 calls, custody holding on all 9 under `drift-agent-client-1`. The held-out set runs
  once, on 26 October, after the feature freeze. C2 runs with Lightning as the judge and the gate expecting
  Lightning (`JudgeInput.requestedTier`), offline with a stub model on 25 Oct 2026; the judge asks for 8,192 tokens.
- The pass runs with no model: the default checks, the judge skipped, `decided_by` policy, operator or default.
  Through Zetaris the same SQL runs query by query; measured 25 Oct 2026 over the export that carries the 01:16 UTC
  cycle's rows, the 104 parity cases, the detectors, the Decider's reads with the prior HOLDs, the ledger, the actions,
  the owner's document, the ticket step's and the eval's queries among them, are equal on both (209 of 209 tests). The
  eval's evidence of a file blanks the body's value on both sides: the export nulls `value_redacted` over 2 kB.
- Every pass writes its own disposition rows, so the ledger grows by one row per finding per pass, and a second pass
  over the same runs gives a ROLLBACK or a FIX a disposition the Actor acts on once more (a restored file or record
  is then refused as changed since the decision). A kept HOLD's reason is the rule's own sentence built with the
  expiry in force, then "held since <decided_at> under rule <id>", naming the latest prior HOLD's `decided_at`. The
  27 rows of the 01:16 UTC live pass of 25 Oct 2026 carry the earlier form, which named the expiry twice; the 01:45 UTC
  pass's rows and the 03:25 UTC pass's 26 HOLD rows carry the one form, and the bundle holds both as recorded.
- `copy_validated` on the USL counts every vault copy, the superseded ones included: 336 total, 282 valid, 54
  invalid on 24 Oct 2026. The 54 are the first commits' nginx copies, validated at 19:59 UTC at a 6-round cap with
  no pre-seeding; every copy of the 21:21 and 23:35 UTC commits (54 nginx, 58 record each) validates ok or
  ok_with_gaps, and the Decider reads a copy's latest validation.
- ok_with_gaps is nginx accepting the restored tree with placeholders in place: 16 and 13 of them on 24 Oct 2026,
  the certbot certificates and keys, its `options-ssl-nginx.conf` and `ssl-dhparams.pem`, an origin pair and the
  credential-shaped snippet. A file the collector leaves unread because its name is credential-shaped is absent from
  the vault, and the restored tree names it as a gap; a restore needs every gap from the host or from certbot, and
  `rollback_file` writes the one file and leaves the rest of the tree as it is.
- `drift_vs_approved`, `changed_since_backup` and `approved_missing` find 0 on the bundle, and locked settings without
  an approved value are 0: the approvals come from the 19:56 UTC runs, every approved setting of the 23:35 UTC runs
  holds its approved value and every approved object is present, and every `file` row of the 23:35 UTC runs (32 and
  22) equals its member of the newest tarball. ROLLBACK and FIX are exercised on `test/fixtures/policy-bundle.json`
  (11 findings: ADOPT 2, HOLD 4, ESCALATE 1, ROLLBACK 3, FIX 1, the missing `blog.conf` among the ROLLBACKs).
- `backup_item` holds every regular-file member of the newest export tarball, 82 and 72 on 24 Oct 2026. A member
  outside `/etc/nginx/` and `/etc/letsencrypt/renewal/` (28 and 39: unit files, cron entries, an application's env
  backups) is stored under a salted `member-<16 hex>` id of its redacted path: its hash and its count reach the
  bundle, its name stays on the host, and the two live trees are the ones `changed_since_backup` joins.
- The resolver weighs tenant, surface, globs, version and `rule_id`; `since` is provenance only. Both versions carry
  since 2026-10-25T00:00:00.000Z, and version 2 decided all 27 dispositions of the sample pass decided at
  2026-10-25T03:25:35.412Z (measured 25 Oct 2026).
- A finding of a class other than `drift_vs_approved` and `approved_missing` under a rollback rule is held: the rule
  restores a setting to its approved value, and the finding concerns the setting's relation to another setting while
  its own value stands, the `proxy_split` included, whose record's `proxied` field has an approval equal to its live
  value.
- In sample mode every disposition is decided at the bundle's own instant (the later of the latest finish of its runs
  and the latest `decided_at` of its ledger rows, `src/data/instant.ts`; 2026-10-25T03:25:35.412Z for
  `sample/bundle.json`, the 03:25 UTC live pass), and a HOLD with no earlier HOLD on its live value expires from it.
  The bundle holds 26 runs, 135 ledger rows from five live passes (24 Oct 23:21 and 23:36 UTC, 25 Oct 01:16, 01:45
  and 03:25 UTC), 630 referent fingerprints and 1 ticket, so the sample pass's findings meet the 01:45 UTC HOLDs: the
  26 HOLDs keep the expiry carried from the 23:21 UTC pass, and the `proxy_split`, whose HOLD expired at
  2026-10-25T03:21:06.870Z, is ESCALATE. The sample pass, the examples and `examples/document.md` decide at one instant
  with the ledger rows the bundle carries. Measured 25 Oct 2026: two runs print byte-identical finding, disposition and
  summary lines (the 55 lines outside the trace hash the same); the 484 trace lines carry their own `ts`, `latency_ms`
  and `trace_id`, so the whole stdout differs run to run; the bundle holds the 03:25 UTC rows under the ids the sample
  pass computes, so the pass writes 0 dispositions and its `DISPOSITION` lines print those rows. The examples and the
  replay page decide at their slice's instant the same way; each slice holds the disposition rows of its own objects
  and records (5, 55 and 130 of the 135), so its instant is the bundle's and its verbs are the full pass's: HOLD 7 and
  ESCALATE 2 over the 9 example findings, the `proxy_split` ESCALATE in both slices that show it.
- Probes run from one machine through two public resolvers.
- Source discovery (new hosts, new accounts, new tools) is the discovery agent's, in the larger product. This agent's
  sources are configured: the hosts `LINUX_HOSTS` lists and one Cloudflare account, and it discovers within them.
- One tenant, two hosts, six zones, one policy file, one machine: `npm run watch` schedules cycles while its process
  lives. The hero and FOUND-BUT-DIFFERENT classes find nothing on the recorded estate, where every name a vhost
  serves lands on an inventory host in each of the five collections. Pre-flight (d) raises two hero findings in
  simulation, their class set by how the previous passing host run pairs with a DNS run: `found_but_different` over
  the 21:21 and 23:35 UTC runs of 24 Oct, fingerprinted against two DNS runs, and `dns_change` over the 03:24 and
  03:25 UTC host runs of 25 Oct, both fingerprinted against the 03:25 UTC DNS run (measured 25 Oct 2026). The
  authored fixture carries the full story.
