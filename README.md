# drift-agent

A configuration assurance layer above the MSP tool stack that remembers. For every setting it can reach it asks:
does a configuration exist for everything that should; is it fully configured; is it backed up; what exactly is in
the copy, against what should be there for that device class; has it changed since the copy; can the copy be
restored (it validates, its dependencies exist); would a restore regress, and of what kind; and is it
FOUND-BUT-DIFFERENT: a byte-identical setting whose referent now means something else. The agent acts under the
MSP's policy: a critical setting that drifted from its approved value, with a valid copy, is rolled back to the copy,
verified and documented; a drifted setting with no valid copy and production affected is investigated, fixed where
allowed, documented and ticketed; everything else is adopted or held with a reason and an expiry. A config lock on a
setting class means automatic rollback at the next cycle.

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

Entry for the GenAI Works Open Agent Hackathon 2026, Track 1 (Solving Fragmented Intelligence): "Demonstrate a
clever ability to discover and work across fragmented data sources."

The hackathon slice: nginx vhost files and the Cloudflare records they depend on, through the whole loop, on the
operator's two production hosts and six zones. Each finding ends in one of five verbs (ROLLBACK, FIX, ESCALATE, HOLD
with an expiry, ADOPT), recorded in the disposition ledger. The Actor carries out ROLLBACK and FIX behind `--apply`
and prints its plan as a dry run without it; the ticket step opens, comments on and closes GitHub issues; the owner's
document is rendered from SQL; `npm run cycle` runs every step once, `npm run watch` on a schedule.
[DESIGN.md](DESIGN.md) holds the design.

## What it does

1. **Collect and vault.** The Linux collector streams a fixed script of reads over one SSH session per host; the Cloudflare collector reads the zones, the records and the account audit log with a read token. Each asserts its population before its first row, redacts every row on its way into the app Postgres and commits a complete run to the vault, where `validate:copies` checks that each copy restores and `probe` asks every served name from outside.
2. **Gate.** The DQ rule `run_complete` fails a run that observed fewer objects than it asserted, finished other than complete or never asserted a population, and a failing run feeds nothing below, so a short read is never taken for a clean one.
3. **Verify through Zetaris.** The hero query (a byte-identical setting pointing at a name that now resolves outside the inventory), the estate survey and the three detectors (`drift_vs_approved`, `changed_since_backup`, `approved_missing`) run as SQL through one DataLayer over the `DRIFT` datasource, then the precondition catalogue checks each finding. In sample mode the same SQL runs on sql.js over the exported bundle.
4. **Triage and judge with Nemotron, under a receipt gate.** Each finding gets the precondition checks for its class; under investigation, Nemotron Lightning picks the checks and Nemotron Ultra judges the claim with one SELECT that returns rows only when it is false. A verdict counts only when its signed receipt verifies, names the tier requested and passes custody.
5. **Decide under the policy.** The Decider applies the technician's exception first, then the policy rule that governs the setting, then the default, and gives one of five verbs with a one-sentence reason. A HOLD carries the rule's expiry, and past it the finding is ESCALATE.
6. **Record.** One `disposition` row per finding per pass goes to the ledger, keyed on the live value, the run and the instant decided. A finding that rests on a DNS record also gets its exposure line: since when the record has been in that state, read from the audit log.
7. **Act behind `--apply`.** The Actor turns a ROLLBACK into `rollback_file` or `revert_record` and a FIX into `investigate`, then `fix`, and verifies every write with probes. Without `--apply` it prints the plan and writes nothing.
8. **Ticket and document.** The ticket step opens, comments on and closes GitHub issues by verb and by the rule's `alert`. The owner's document renders one markdown page per tenant from 14 named queries.

## Run it

Sample mode needs no credentials and no model; it runs the real pass over the redacted export, `sample/bundle.json`:

```bash
npm install && cp .env.example .env
SAMPLE_MODE=true npm run sample                         # the whole pass over the recorded rows
SAMPLE_MODE=true npm run preflight -- --proposal examples/proposals/a-unproxy-www.json   # GO, NO-GO, GO-IF or ESCALATE for one change
SAMPLE_MODE=true npm run document -- --tenant client-1  # the owner's document -> examples/document.md
npm run answer -- --finding <fnd-id> --accept --until <ISO 8601 UTC> --reason "..."   # teach one exception -> DRIFT_MEMORY_DIR; --list, --forget <id>
npm run eval -- --set dev --configs C0                  # the pre-registered eval with no model -> eval/results/<UTC stamp>/
npm run site                                            # rebuild the replay page in docs/ from examples/
npm run sources                                         # the table under "Where each answer comes from", read off the SQL
npm test
```

`npm run sample` prints a JSON trace line per step, a JSON object per finding with its short id (`fnd-` plus 16 hex,
what `npm run answer` takes), a `DISPOSITION` line per finding and a summary; the trace also lands in `logs/`,
gitignored. The technician's lessons come from the directory `DRIFT_MEMORY_DIR` names: `.env.example` sets
`examples/memory`, the committed store of the operator's 23 accepted exceptions, so a clean clone and CI decide with
them; blank, it is `.world/memory`, gitignored. On 25 Oct 2026 the sample pass prints ADOPT 23 under those
exceptions, HOLD 3 and ESCALATE 1.

Live runs read `.env`, each key described in `.env.example`: `DATABASE_URL`, `ZETARIS_API_KEY`, `ZETARIS_PG_HOST`,
`CLOUDFLARE_API_TOKEN`, `LINUX_HOSTS`, `DRIFT_VAULT_DIR`, `DRIFT_POLICY_FILE`, `DRIFT_MEMORY_DIR`, `DRIFT_TICKETS_REPO`,
`REDACT_SALT`, `REDACT_WORDS`, `EXPORT_DENY_WORDS`; the Nightshift and GitHub tokens are read at run time. In cycle
order, after the one-time setup:

```bash
npm run zetaris:setup                                   # once: the DRIFT datasource, the ten-entity USL, three DQ rules
npm run policy:load -- --tenant <id>                    # once per policy version: the policy file -> policy_rule rows
npm run collect:cloudflare -- --tenant <id>             # DNS records and the audit log -> Postgres and the vault
npm run collect:linux -- --host <alias> --tenant <id>   # one SSH session of fixed reads, per LINUX_HOSTS alias
npm run approve -- --tenant <id> --host <alias>         # once, after the first collection: sign off a host's files; --all for every record
npm run probe -- --tenant <id>                          # http, dns and tls on every served name
npm run validate:copies -- --tenant <id>                # nginx -t and cf-schema over the newest vault commits
npm run pass -- --tenant <id>                           # the pass through Zetaris; dispositions -> the ledger
npm run act -- --tenant <id>                            # the Actor's plan, a dry run; --apply carries it out
npm run tickets -- --tenant <id>                        # GitHub issues by the ticket rules; --dry-run prints the plan
npm run document -- --tenant <id>                       # the owner's document -> document.md
npm run cycle -- --tenant <id>                          # collect, probe, validate, pass, act (dry run), tickets, document, once
npm run watch -- --tenant <id> --every 60               # the cycle every 60 minutes until SIGINT
```

## What it proves

Measured on the operator's estate, tenant `client-1`, and the writes on the lab estate, tenant `lab-1`
([lab/README.md](lab/README.md)), dates in UTC; the replay page in [docs/](docs/) holds the detail.

| Command | Proves | Measured |
|---|---|---|
| `npm test` | Every module against fixtures, fakes and a throwaway Postgres schema; the live halves run behind their flags. | 935 tests in 36 files: 822 pass and 113 wait on a live flag, 25 Oct 2026. |
| `PARITY_LIVE=true npx vitest run test/parity.test.ts` | Every query the agent runs returns the same columns, rows and totals on sql.js and on Zetaris over the same rows. | 107 of 107 cases equal over the export of the 13:53 UTC cycle, 17,364 observation rows read whole on both engines, 25 Oct 2026. |
| `SAMPLE_MODE=true npm run sample` | The whole pass over `sample/bundle.json`, with no credentials and no model. | 80 runs, 14,174 observations, 27 findings: ADOPT 23 under the operator's accepted exceptions, HOLD 3 and ESCALATE 1 by policy, decided at 2026-10-25T14:17:53.416Z; two runs byte-identical, 25 Oct 2026. |
| `npm run collect:cloudflare`, `npm run collect:linux` | The collectors read the live estate in full, each population asserted before the first row. | 58 of 58 records in 6 zones, 1,014 of 1,014 audit rows, 24 of 24 and 14 of 14 vhost files, at 13:53 UTC, 25 Oct 2026. |
| `npm run vault:status` | Every complete run is one commit in a per-host or per-account git repository. | 3 repositories of 11, 12 and 12 commits, 58, 32 and 22 files at the heads, 25 Oct 2026. |
| `npm run validate:copies` | Each newest vault commit restores to a tree `nginx -t` accepts and each record copy passes its schema, every missing dependency named. | both nginx trees ok_with_gaps (16 and 13 gaps), records 42 ok and 16 ok_with_gaps, 0 fail, 24 Oct 2026. |
| `npm run probe` | http, dns and tls on every served name, from outside, as one collection run. | 37 names, 111 of 111 probes complete, 20 failing, the same counts in 11 runs from 24 Oct 19:59 to 25 Oct 13:53 UTC, 25 Oct 2026. |
| `npm run approve` | The documentation of record, written from the latest passing run, idempotent. | 333 approvals, then 0 written over the next runs, 24 Oct 2026. |
| `npm run policy:load` | The MSP's policy file, validated against a closed schema, redacted and stored as versioned rules. | version 2: 15 rules written, a second load 0, 24 Oct 2026. |
| `npm run pass` | The live pass through Zetaris writes one disposition per finding to the ledger and reads each back through Zetaris. | 27 findings and 27 dispositions written and read back in each of 12 live passes, from 24 Oct 23:21 to 25 Oct 13:54 UTC; the ledger holds the 324 rows, 25 Oct 2026. |
| `npm run act -- --apply` | The Actor carries out a ROLLBACK and a FIX on a real host, verifies every write with probes and records each action. | On the lab: `rollback_file` done at 09:53 UTC, the copy written, `nginx -t` passed, nginx reloaded and the write verified by probe `probe-36eb2c1bba298a2a`; a FIX investigated inside the Actor, Lightning's selection on receipt `rcpt_req_nn4ag0yu` and Ultra's verdict on receipt `rcpt_req_iehg9gmt`, both verified, and its `fix` refused without a valid copy; a rollback at 05:47 UTC completed with no probe of the lab's names and is `unverified`, 25 Oct 2026. |
| `npm run cycle` | One cycle of the loop, every step once, the first failing step stopping it. | 9 of 9 steps ok in 101.5 s, a dry run, the 13:53 UTC cycle of 25 Oct 2026. |
| `npm run watch` | The cycle on a schedule, each cycle traced to its own file. | 7 cycles every 45 minutes from 09:23 to 13:53 UTC, a dry run: 9 of 9 steps ok in each, 75.0 to 101.5 s a cycle, 101.5 s the last, 0 failed, 25 Oct 2026. |
| `npm run tickets` | One GitHub issue per ticket row, opened, commented on and closed by the ticket rules. | the smoke opened, commented on and closed issue #1 and a cycle opened issue #2 for the `proxy_split` HOLD, 24 Oct 2026; the first cycle after that HOLD expired commented on #2, 25 Oct 2026. On the lab, issue #3 opened as the FIX's incident with the investigation under Evidence and stays open, and issue #4 opened and closed as the rollback's change with its verification probe, 25 Oct 2026. `sample/bundle.json` carries the three ticket rows, #2 on the estate and #3 and #4 on the lab, each URL redacted. |
| `npm run document` | The owner's document: one page per tenant from 14 named queries, through the deny-list probe before it is written. | 27 findings open, ADOPT 23, HOLD 3 and ESCALATE 1, decided at 2026-10-25T14:17:53.416Z; `examples/document.md` byte-identical on a second render, 25 Oct 2026. |
| `npm run eval -- --set dev --configs C0 --runs 2` | The pre-registered eval of [eval/PROTOCOL.md](eval/PROTOCOL.md). | C0 on the 15 development items under `policy/hackathon.json` version 2: 11 scored, 11 with a verdict, agreement 9 of 9 (Wilson 95% 0.701 to 1.000), 0 of 9 labelled no read yes, 0 differences between runs, 25 Oct 2026. |
| `npm run site` | The replay page, built from [examples/](examples/) and the repository's SQL: every finding with every check re-run to its recorded count before anything is published, the owner's document as its Document tab and "Where each answer comes from" as its Sources tab, both rendered to HTML at build time. | 9 findings (ADOPT 4, HOLD 3, ESCALATE 2), 33 checks re-run equal, the 181-line document decided at 2026-10-25T14:17:53.416Z, the 9 class rows; 167,554 bytes of the 300,000-byte budget, a rebuild byte-identical, 25 Oct 2026. |
| `npm run conformance`, `npm run conformance:hmem` | The vendored Meterless suites pass through the agent's own engine modules. | World Model 8 of 8, 23 Oct 2026; H-MEM 13 of 13, 24 Oct 2026. |
| `npm run zetaris:setup` | The idempotent setup of the `DRIFT` datasource, the ten-entity USL and its three DQ rules. | 42 statements, 0 failed; `run_complete` 19 of 19 runs valid, 25 Oct 2026. |
| `npm run zetaris:queries` | The hero query, the survey and the detectors run through Zetaris itself. | 0 hero rows, the 27 survey findings, 0 invalid runs, 24 Oct 2026. |

## Where each answer comes from

Each finding class answers its question by joining the tables its detector query and its default checks name, and each table holds the rows of one source. The rows are read off the SQL in `src/data/queries.ts` and `src/catalogue/templates.ts` and the default checks in `src/catalogue/select.ts`.

| class | question | tables | sources |
|---|---|---|---|
| `proxy_split` | Is it fully configured? | `collection_run`, `observation`, `dns_record`, `audit_event` | live state, DNS, audit log, populations |
| `proxied_without_real_ip` | Is it fully configured? | `collection_run`, `observation`, `dns_record`, `audit_event`, `inventory_asset` | live state, DNS, audit log, inventory, populations |
| `orphan_record` | Does a configuration exist for everything that should? | `collection_run`, `observation`, `dns_record`, `audit_event`, `inventory_asset` | live state, DNS, audit log, inventory, populations |
| `orphan_vhost` | Does a configuration exist for everything that should? | `collection_run`, `observation`, `backup_snapshot`, `dns_record` | live state, export, DNS, populations |
| `changed_since_backup` | Has it changed since the copy? | `collection_run`, `observation`, `approved_setting`, `backup_snapshot`, `backup_item` | live state, export, documentation of record, populations |
| `drift_vs_approved` | Has it changed since the copy? | `collection_run`, `observation`, `approved_setting`, `backup_snapshot`, `backup_item`, `audit_event` | live state, export, documentation of record, audit log, populations |
| `approved_missing` | Does a configuration exist for everything that should? | `collection_run`, `observation`, `approved_setting`, `backup_snapshot`, `backup_item`, `dns_record`, `audit_event` | live state, export, documentation of record, DNS, audit log, populations |
| `found_but_different` | Is it FOUND-BUT-DIFFERENT? | `collection_run`, `observation`, `dns_record`, `audit_event`, `inventory_asset` | live state, DNS, audit log, inventory, populations |
| `dns_change` | Is it FOUND-BUT-DIFFERENT? | `collection_run`, `observation`, `dns_record`, `audit_event`, `inventory_asset` | live state, DNS, audit log, inventory, populations |

The sources:

- live state (`observation`): each setting as the live host answers it over SSH, and each record field as the DNS provider returns it.
- export (`backup_snapshot`, `backup_item`): the nightly export tarball of each host and every regular member of the newest.
- documentation of record (`approved_setting`): the values a technician approved; IT Glue and Hudu map here.
- DNS (`dns_record`): the DNS provider's records, Cloudflare's in this slice.
- audit log (`audit_event`): the provider's audit log, who changed which resource and when.
- inventory (`inventory_asset`): the hosts' addresses.
- populations (`collection_run`): each source's own population, asserted before a row is read, and each run's status.

## Policy

The MSP's policy is data: `policy/hackathon.json`, loaded by `npm run policy:load` against a closed schema into
versioned `policy_rule` rows. A rule matches a tenant, a surface and two globs and sets criticality, `lock`,
`on_drift`, `on_no_copy`, `hold_max_hours`, `alert` and `psa_priority`; the most specific match governs.

- ROLLBACK: a drift from the approved value under a locked or rollback rule, with a valid vault copy of that value.
- FIX, ESCALATE or ADOPT: the same drift with no valid copy and production affected, as `on_no_copy` says; ESCALATE when production is unknown.
- HOLD: the same drift with production answering, `on_drift` hold, or a finding about a setting's relation to another setting; the expiry runs `hold_max_hours` from the first HOLD on that live value, and past it the finding is ESCALATE.
- ADOPT: `on_drift` adopt, or the technician's exception in force; with no rule, ADOPT when every check holds and ESCALATE otherwise.

Version 2's 15 rules are in [DESIGN.md](DESIGN.md): vhost files, `nginx.conf` and a record's `content` and `proxied`
are critical and locked; copies beside live files are adopted; the rest is held. On 25 Oct 2026 the sample pass adopts
23 findings under the operator's accepted exceptions, which outrank the rules, holds the 3 `orphan_record` findings
under the catch-all until 2026-10-27T23:21:06.870Z, and gives the `proxy_split` ESCALATE, its 4-hour hold expired.

## The vault and validation

`DRIFT_VAULT_DIR` names the vault, outside the repository: one git repository per tenant and host alias with the files
at their real paths, and one per tenant for Cloudflare with a JSON file per record. Each complete run is one commit,
an unchanged run included; a partial or failed run commits nothing. Raw bytes and real names stay in the vault; commit
hashes, counts and redacted ids leave it. `npm run validate:copies` lays a commit down as a restore would, gives every
dependency outside the tree a placeholder of its kind (an empty include, a self-signed pair, the ffdhe2048 group) and
runs `nginx -t` in an `nginx:1.27` container, up to 12 rounds: ok when round 1 passes with no placeholder,
ok_with_gaps when a round passes with some, each gap named, fail otherwise. `cf-schema` checks each record copy
offline: type, content shape, a CNAME target among the run's records, an address in the inventory. On 24 Oct 2026 the
nginx gaps were certbot's certificates, keys, `options-ssl-nginx.conf` and `ssl-dhparams.pem`, an origin certificate
and key, and one credential-shaped snippet the collector skips.

## Redaction

`src/redactor.ts` runs in each collector and again in the Store, before anything is persisted: secrets become
`<secret:KIND:8hex>`, addresses `ip-XXXXXX`, logins `user-XXXXXX`, mailboxes `mail-XXXXXX@domain-XXXXXX`, hostnames
`host-XXXXXX.<tld>` and the tenant's labels (`REDACT_WORDS`) `word-XXXXXX`, every pseudonym salted with `REDACT_SALT`
so the same name is the same pseudonym in every table, which the cross-source joins rest on. A setting's `value_hash`
is an HMAC under that salt; `file` rows keep the plain sha256 to match the tarball copy. Labels are configuration: a
new product or brand needs an entry before the next collection. The probe is code: the bundle export, the owner's
document, the replay page, the eval's results and every ticket stop on any `REDACT_WORDS` or `EXPORT_DENY_WORDS` entry
standing alone, and `test/leak.test.ts` runs the same probe over the committed tree.

## Probes

`npm run probe` asks every A, AAAA and CNAME name from outside, one run per tenant, wildcards left out:

- http: `GET https://<name>/` answers below status 500, with `cf-ray` present for a proxied record and absent for a direct one.
- dns: a direct record's content is in the answers of two public resolvers, and a proxied record's content is in neither.
- tls: the certificate is valid for the name with more than 7 days left.

Production is affected when a probe of the pass's probe run fails on a name the finding's object serves, answering
when all of them pass, and unknown with none; after a write the Actor probes again (surface `probe.verify`). On 24 Oct
2026 the three `orphan_record` names failed (two answer status 526, one presents a certificate for other names), so
those findings read production affected.

## Actions and tickets

`npm run act` acts once per disposition and kind on the latest disposition of each finding, by default as a dry run
that prints the plan and writes nothing. With `--apply` each action records its hashes, vault commit, probes, receipts
and status in an `action` row, and every write path refuses a live value that changed since the decision. The status
is one of five: `done` (written, and every verification probe ok), `unverified` (the write completed, read back equal
to the copy, and no verification probe ran or could be read, the reason naming which), `failed` (the write path did
not complete, or its read back or a probe that answered differs), `refused` (nothing written) and `not_judged` (an
investigation with no counted verdict).

- `rollback_file` (ROLLBACK on an nginx file): one SSH session writes the vault copy through `sudo -n tee`, runs `nginx -t` and reloads, writes the previous bytes back on any failure, then probes the names the file serves.
- `revert_record` (ROLLBACK on a record field): `PATCH` to the vault JSON, or `POST` for a record the zone lacks, read back field by field, then one dns probe.
- `investigate`, then `fix` (FIX): Lightning picks the checks and Ultra judges the claim; `fix` is refused without a valid copy.

Tickets go to GitHub Issues: ESCALATE and FIX open an incident, ROLLBACK a change under `alert` always or on_fix, HOLD
an incident under `alert` always; a change closes once its action is verified, and an unverified one stays open with
a comment until a pass finds the setting at its approved value; `src/psa/mapping.json` maps the columns onto HaloPSA,
ConnectWise and Autotask. On 24 Oct 2026 the policy fixture's ROLLBACK 3 and FIX 1 gave five
actions against a fake host, probe and fetch, and a second run wrote 0.

## Pre-flight

`SAMPLE_MODE=true npm run preflight -- --proposal <file>` answers one typed proposed change before it is made: the
change becomes a derived table for one call, the whole pass runs in that world, and its findings are compared with the
baseline by key, with nothing written. The verdict is GO when the change adds no finding, GO-IF when up to three
prerequisites from a catalogue clear what it adds, NO-GO when it adds a finding no prerequisite clears, and ESCALATE
when the simulation cannot run or three prerequisites leave a finding standing. On 25 Oct 2026, over the four
proposals in [examples/proposals/](examples/proposals/) and the recording of 13:53 UTC: un-proxying www GO, removing 3
findings; the 16 April body replayed GO with zero delta, the state already in force; trusted ranges on the vhost that
serves www GO, removing 2; retargeting the apex outside the inventory NO-GO, adding 2 hero findings (`found_but_different` when the previous host run paired with an earlier DNS run, `dns_change` when both pair with the same one; `found_but_different` on this recording, the 13:08 UTC host run paired with the 13:08 UTC DNS run).

## Evaluation

[eval/PROTOCOL.md](eval/PROTOCOL.md) is the contract, pre-registered: the protocol and 38 candidate items in
`b8b3d41`, the operator's labels in `fede9f7` before any model run (36 no, 2 unsure, 0 yes), the counted terms in
`f9f036f`. Each item is one real deviation or negative from the live collection and the audit log. A seeded split
gives 15 development items and 23 held out; tuning uses the development set only, and the held-out set runs once,
after the feature freeze, its results published whatever they say. Yes expects ESCALATE or FIX; no expects ADOPT, HOLD
or ROLLBACK. Every model call passes the receipt gate with a fresh nonce, a substitution invalidates its run, and the
ten planted false claims of `eval/planted.json` go to every judge. Results, with Wilson 95% intervals, land in
`eval/results/<UTC stamp>/`. C0 runs the pass as SAMPLE_MODE does with the technician's memory empty, under
`policy/hackathon.json` version 2 loaded for the recording's tenant (the protocol's changelog, 25 Oct 2026): on the
development set every finding is HOLD by policy and C0 agrees with 9 of the 9 items labelled yes or no.

## Zetaris

The app Postgres is registered in Zetaris as the `DRIFT` datasource; the collectors and the ledger write to Postgres,
and every query of a live pass runs through Zetaris Lightning SQL over REST. `npm run zetaris:setup` builds the
`drift_usl` semantic layer of ten entities (`collection`, `setting`, `referent`, `backup_copy`, `policy`, `copy`,
`probe`, `disposition`, `action`, `ticket`) and three DQ rules: `run_complete` on `collection`, `copy_validated` on
`copy` (the copy's latest validation is ok or ok_with_gaps) and `action_verified` on `action` (a done rollback or
revert names the probes that verified it). `test/parity.test.ts` holds sql.js and Zetaris to the same columns, rows
and totals over 107 cases. Measured on Zetaris 2.4.3.1: a function inside a top-level WHERE on a `DRIFT` table is
dropped, every row coming back, and a correlated reference in a subquery's JOIN ON is refused, so the catalogue's
top-level predicates compare plain columns and every correlation sits in a WHERE.

## Meterless

Two Meterless reference engines are vendored unmodified and wrapped by `src/engine/`. The World Model (`world.ts`)
holds every observation of a passing run, the referent fingerprints FOUND-BUT-DIFFERENT compares and the exposure
line's open edges; its conformance suite passes 8 of 8 through that module. H-MEM (`memory.ts`) holds the technician's
lessons: `npm run answer` records an exception or an answer on one finding's scope with a tenant, an expiry and
provenance, and the Decider recalls it by exact scope key, an exception in force giving ADOPT until its expiry and a
lapsed one ESCALATE. Lessons live in the directory `DRIFT_MEMORY_DIR` names (`.world/memory`, gitignored, when it is
blank); every pass opens the store read only, and `npm run answer` is the one writer. The store is committed under
`examples/memory`: on 25 Oct 2026 the operator accepted 23 exceptions, one per `proxied_without_real_ip` and
`orphan_vhost` finding of the recorded estate, in his words "Personal estate, known and intentional: proxied names
without real_ip and the leftover records are not a production risk.", each until 2026-11-30T00:00:00Z, and all 23
are in force on the recorded estate. The vendored H-MEM suite passes 13 of 13.
Nightshift, the Meterless runtime, serves Nemotron and signs a receipt for every successful call.

## Nemotron

Nemotron runs through Nightshift, requested by explicit model id with OpenRouter as the primary route:

| role | model | runs in |
|---|---|---|
| Triage: pick and parameterise catalogue checks for a finding | Nemotron 3.5 Lightning: `METERLESS_MODEL_FAST` `openrouter/nvidia/nemotron-3.5-lightning`, then `METERLESS_FALLBACK_FAST` `nvidia/nemotron-3.5-lightning-30b-a3b`; a local lane joins when its weights are installed | the eval's C1 to C3 |
| Investigation: pick the checks for a FIX, or an ESCALATE under an investigate rule | Nemotron 3.5 Lightning, the same ids | the Actor's `investigate` |
| Refuting judge: one SELECT that returns rows when the claim is false | Nemotron 3 Ultra: `METERLESS_MODEL_JUDGE` `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`, then `METERLESS_FALLBACK_JUDGE` `nvidia/nemotron-3-ultra-550b-a55b`; Lightning in C2 | the Actor's `investigate`, the eval's C2 and C3 |
| Eval C1 | C0 plus Nemotron 3.5 Lightning selecting and parameterising checks from the catalogue | `npm run eval` |
| Eval C2 | C1 plus Nemotron 3.5 Lightning as the falsifier judge | `npm run eval` |
| Eval C3 | C1 plus Nemotron 3 Ultra as the falsifier judge | `npm run eval` |
| Eval C4 | Nemotron 3 Ultra alone: the verdict from the rows, no SQL checks, no catalogue (baseline) | `npm run eval` |

The cycle's pass runs no model: each finding gets its class's default checks and the judge is skipped. Nemotron runs
in the Actor's investigation and in the eval. Nothing Lightning says becomes SQL; Ultra's SELECT is guarded (SELECT
only, known tables, LIMIT capped at 50) and run through the same DataLayer. The receipt gate counts a verdict only
when the Ed25519-signed receipt verifies, the served tier is the one requested, `request_id` equals the response's id
and `app` is `drift-agent-<tenant>`; a substituted tier, a tampered body, an unreceipted response or a receipt of
another request on a fresh retry files the finding `not_judged`, and it escalates. On 24 Oct 2026 the eval smoke made
9 calls under `drift-agent-client-1`, every receipt verified and custody holding on the first attempt; the per-call
record is `logs/eval_live_2026-10-24T23-49-31Z.log`, kept locally. On 25 Oct 2026 Nemotron ran inside the Actor on
the lab, beside the eval: for a FIX, Lightning selected four valid checks on receipt `rcpt_req_nn4ag0yu` and Ultra's
refuting SELECT returned no rows on receipt `rcpt_req_iehg9gmt`, both receipts verified and custody holding under
`drift-agent-lab-1`.

## Limits

- The write paths run behind `--apply` only, and on 25 Oct 2026 they ran for real on the lab estate (`lab/README.md`, tenant `lab-1`): `rollback_file` reached `done` at 09:53 UTC, verified by probe `probe-36eb2c1bba298a2a` with the probe population from `PROBE_TARGETS_OVERRIDE`, since the lab's names sit in no zone; a FIX ran `investigate` with Nemotron Lightning and Ultra and its `fix` was refused without a valid copy; the 05:47 UTC rollback, run without the override, found no record of the lab's names in the account and is `unverified`. `revert_record` has run against a fake fetch only. The operator's hosts and zones hold 0 writes from the Actor; the first is the operator's rehearsal.
- One tenant, two hosts, six zones, one policy file, one machine and one PSA backend, GitHub Issues (HaloPSA, ConnectWise and Autotask are a field map): `npm run watch` schedules cycles while its process lives, and a GitHub issue is the one notification.
- The receipted model calls before the eval's three-run development pass are the 9 of the eval smoke and the 3 of the lab's two investigations, 25 Oct 2026; the held-out set runs once, on 26 October, after the feature freeze.
- The hero classes find nothing on the recorded estate, where every name a vhost serves lands on an inventory host; pre-flight raises two hero findings in simulation, and `test/fixtures/authored-bundle.json` carries the full story for the tests.
- `drift_vs_approved`, `changed_since_backup` and `approved_missing` find 0 on the operator's estate; ROLLBACK and FIX run on the lab estate and on `test/fixtures/policy-bundle.json`.
- The 23 accepted exceptions in `examples/memory` hold until 2026-11-30T00:00:00Z, and recall runs at the clock: from that instant the sample pass, the examples and the replay page give those 23 findings ESCALATE (exception lapsed), and `npm run examples`, `npm run document` and `npm run site` regenerate the committed outputs the tests hold to the store. The 23 lessons sit on 15 names: a name served by a :443 and a :80 block raises two findings, one lesson was taught per finding, and the Decider applies the earlier lesson on a name, so withdrawing one of a pair leaves its twin in force (25 Oct 2026).
- `verifyReceipt` trusts the public key each receipt carries; pinning the runtime's key in config would close a receipt forged with a fresh key.
- Probes run from one machine through two public resolvers; a name resolves through its A and AAAA records, a CNAME followed one level.
- The collector reads with the operator's own SSH key, so its read-only property lives in the fixed script it streams. [ops/](ops/) holds the designed second stage, not yet installed: a dedicated user whose key is bound to a forced command running the same reads, and one sudoers line for the two root-only reads.
- Source discovery (new hosts, new accounts, new tools) is the discovery agent's, in the larger product; this agent discovers within the hosts `LINUX_HOSTS` lists and one Cloudflare account.

## Pre-existing components

The Meterless World Model and H-MEM references are vendored unmodified under Apache-2.0, declared in
[PREEXISTING.md](PREEXISTING.md); the rest was written in the build window, from 22 Oct 2026. The estate's
configuration history (audit log, nightly tarballs, dated vhost copies) predates the window and is read as input data.

## Decisions

- 2026-10-23: TypeScript on Node 22+ ESM, run with tsx and tested with vitest; `.env` loads through Node's built-in `process.loadEnvFile`.
- 2026-10-23: Nemotron is requested by explicit model id, since `meterless/fast`, `deep` and `judge` all route to the race lane first, and the receipt gate reads the served tier from that id, `requested_mode` being `meterless/auto` on every receipt; an empty Lightning response is retried once, then the agent falls back deterministically.
- 2026-10-23: `fingerprintAt` reads the latest `fingerprint` fact at or before the time, because the World Model reference replays facts from a snapshot and keeps attrs in live state only; the vendored code is untouched.
- 2026-10-23: Zetaris REST returns `{headers, data, total, timeUsed}` with every value a string, and both engines normalise to it; Nemotron's primary routes run through OpenRouter (12 of 12 at a 1 to 2 s median, against 4 of 6 at 7.5 s on NVIDIA's free endpoint) behind a receipted failover ladder.
- 2026-10-23: One portable DDL for SQLite and Postgres, and catalogue SQL in a portable subset whose parameters render as escaped literals, because Zetaris REST takes one SQL string and binds nothing; sql.js runs SAMPLE_MODE over `sample/bundle.json`, so a clean clone and CI run the real pass with nothing installed, and the parity test holds it to Zetaris.
- 2026-10-23: Zetaris denies access per object by default; `npm run smoke` runs the read-only half of Spike A (`SELECT 1`, `SHOW LIGHTNING DATABASES`), the registration probe sits behind `--register`, and the agent's own query path is SELECT-only.
- 2026-10-23: A catalogue of typed templates for Lightning to choose from; the one model that writes SQL is the judge, and the agent guards and runs its SELECT.
- 2026-10-23: `chat_template_kwargs.enable_thinking` has no observable effect through the OpenRouter routes (12 of 12 calls); the judge sends it anyway and sizes its token budget for a route that honours it.
- 2026-10-23: The collector's read-only property lives in its fixed script; `ops/` holds the forced-command user and one sudoers line, reviewed and not installed, its scripts pinned to LF.
- 2026-10-23: Redaction before persistence, 6-hex pseudonyms, the salt in `REDACT_SALT`, the trace's free text through the same redactor.
- 2026-10-24: Address joins take A and AAAA records only; a host run pairs with a DNS run within six hours; the SQL guards strip literals before the semicolon check and refuse double quotes; every query has a total ORDER BY.
- 2026-10-24: The app Postgres sits on the Zetaris Docker network (`DATABASE_URL` is how this machine reaches it, `ZETARIS_PG_HOST` how Zetaris does); Zetaris API keys are admin-generated and tenant-scoped, so what limits the agent is its SELECT-only query path, and `npm run zetaris:setup` is the one place DDL goes through the raw adapter.
- 2026-10-24: The USL has a `source_kind` column and a `referent` table, because the DDL validator rejects `source` and `reference`; `COMPILE USL` is the one request that carries several statements, and the USL names join the redactor's dotted vocabulary so trace lines keep them.
- 2026-10-24: A Cloudflare record's previous state is the latest earlier create or update on its id, because the audit log carries the request body and no old or new value.
- 2026-10-24: A setting's `value_hash` is an HMAC-SHA256 under `REDACT_SALT`, so a guess built from a public zone name confirms nothing; `file` rows keep the plain sha256, which must equal the tarball copy's.
- 2026-10-24: Top-level WHERE predicates on `DRIFT` tables are plain column comparisons and every correlation sits in a subquery's WHERE, after the two pushdown facts under Zetaris.
- 2026-10-24: Pre-flight is a derived table in place of `{{t:table}}` for one call, the whole pass run in the simulated world through the same DataLayer, the loop bound three; the stop rule ships with every template marked as informing the next action, and a judge call whose verdict cannot move is withheld with its reason.
- 2026-10-24: The exposure line is three SELECTs in the portable subset plus arithmetic in TypeScript, with no SQL date function; its earlier-body count is field-aware, a body counting when it names the field with another value or deletes the record.
- 2026-10-24: H-MEM is vendored as the second Meterless engine, and the Decider recalls the technician's lessons before it decides.
- 2026-10-24: Receipt custody: identity rests on `request_id`, with `prompt_preview` able to refute it, and `app` must equal the per-tenant id; an answer whose receipt belongs to another request is discarded, asked once more with a fresh nonce, then failed closed.
- 2026-10-24: The replay page is built from the committed examples only and refuses to publish anything it cannot re-run to the recorded numbers; every finding carries a short stable id.
- 2026-10-24: Each loop step is a module with its own command, and a cycle runs them in one process; dry run is the Actor's default and `--apply` its one switch; the write script is separate from the read collector's.
- 2026-10-24: `approved_missing` counts an object absent only when the run holds neither an observation nor a `dns_record` row of it; every HOLD on a live value shares the first HOLD's expiry.
- 2026-10-24: `tenantAppId` joins base and tenant with `-`, the form the runtime files under `receipt.app` (12 of 12 receipts).
- 2026-10-25: Every pass writes its own ledger rows (`disposition_id` carries `decided_at`); a bundle's decision instant is the later of its runs' latest finish and its latest ledger row; the `action` row carries the Actor's `reason` and `record`; the judge takes the tier the gate expects.
- 2026-10-25: The technician's lessons live where `DRIFT_MEMORY_DIR` says, committed under `examples/memory`; every pass opens the store read only, so a run leaves it as committed; a replay over a bundle decides at the later of the bundle's instant and the latest lesson's, so a lesson taught after the recorded pass writes rows of its own.
