# drift-agent

Config-drift assurance for MSP technicians. Three questions, asked of real servers and real DNS:

1. What changed since the last backup?
2. Would a restore regress anything?
3. Where does this system drift from golden, including FOUND-BUT-DIFFERENT: a reference that is byte-identical
   while the thing it points at has changed.

Each finding ends in one verb: ADOPT, HOLD (with an expiry) or ESCALATE. The agent is read-only. It never enforces.

Entry for the GenAI Works Open Agent Hackathon 2026, Track 1 (Solving Fragmented Intelligence).

## Status

The collectors ran against the real estate on 24 Oct 2026 (two production hosts over SSH with a fixed script of
reads, see Honesty about root; one Cloudflare account), the rows went through the redactor into the app Postgres, Zetaris reads that Postgres
as the `DRIFT` datasource, and `sample/bundle.json` is the export of those rows. The pass runs over them
with no model; the hero query and the survey queries run through Zetaris itself.

| Command | Proves |
|---|---|
| `SAMPLE_MODE=true npm run sample` | The whole pass over `sample/bundle.json`: DQ gate, World Model, hero query, estate survey, precondition catalogue, stop rule, technician memory, exposure line, disposition. No credentials, no model, every step a trace line. Measured 24 Oct on the recorded bundle (the 07:58 UTC re-collection): 4 collection runs, 0 gated out, 1,062 observations recorded, 160 SQL queries (126 for the gate, the detectors and the checks, 34 for the exposure line), 388 trace lines (every one carries `model_requested: none`), 27 findings (1 `proxy_split`, 20 `proxied_without_real_ip`, 3 `orphan_record`, 3 `orphan_vhost`; 5 ADOPT, 22 ESCALATE), 0 hero findings (every name a vhost serves lands on an inventory host), 8 findings dated by the exposure line, `early_stop 0, checks_skipped 0, checks_gated 0, withdrawn_judge 0`, `lessons 0` when no lesson has been recorded. |
| `npm test` | 22 files, 382 tests (38 more are the live Zetaris half of the parity test, skipped without `PARITY_LIVE=true`): data layer, parity, catalogue, selection, redactor, tracer, judge (with custody), receipt gate, custody, World Model, the pass over both bundles (with the technician's memory), the stop rule, the exposure line, pre-flight, technician memory with the vendored H-MEM conformance run in a child process, the replay page build, the nginx collector on redacted copies of both layouts, the Cloudflare collector on recorded shapes, the Store against a throwaway schema of the live Postgres, the Zetaris setup plan, and the deny-list probe over the tree (skipped with one line where the operator's label list is blank). |
| `SAMPLE_MODE=true npm run preflight -- --proposal examples/proposals/<name>.json` | GO, NO-GO, GO-IF or ESCALATE for one typed proposed change, simulated as a derived table over the recorded rows with the whole pass run in that world; nothing written. Measured 24 Oct on the four committed proposals: (a) un-proxy www GO, removes 3 findings; (b) replay of the 16 April `proxied: true` body GO with zero delta (already the recorded state); (c) trusted ranges on the vhost that serves www GO, removes 2; (d) retarget the apex outside the inventory NO-GO, adds 2 `dns_change` hero findings; about 300 ms each (baseline plus one simulation). GO-IF is exercised in `test/preflight.test.ts`: 29 findings, one `add_real_ip_block`, 26. |
| `npm run answer -- --finding <id> --accept --until <ISO 8601 UTC> --reason "..."` | Teaches the agent one lesson about one finding (the id the pass prints): an accepted exception, or `--question`/`--answer` an answer. Stored under `.world/memory` (gitignored) through the vendored H-MEM engine; the next `npm run sample` honours it until it expires, then re-raises the finding. `--list`, `--forget <lesson id>`. Measured 24 Oct, below under Technician memory. |
| `npm run conformance:hmem` | Vendored Meterless H-MEM conformance suite, 13/13, against the vendored reference that `src/engine/memory.ts` re-exports, plus one check through `TechnicianMemory` (record, recall by exact key, lapsed flagged). `TechnicianMemory`'s own coverage is `test/memory.test.ts`. |
| `npm run site` | The no-install replay page, `docs/`, built from `examples/` alone: every finding with the detector query that raised it, every check with the SQL that ran, re-run at build time to the recorded count and sentence, refused otherwise. Measured 24 Oct: 3 examples, 9 findings, 33 checks re-run with counts equal, 132,928 bytes in 6 files (the page 18,959), 1,454 JSON strings through the redactor unchanged, 21 deny-list labels and 2 ssh aliases found nowhere. |
| `PARITY_LIVE=true npx vitest run test/parity.test.ts` | 38 cases through sql.js and through Zetaris over the same rows: hero, gate, the pass queries, the five survey queries, every catalogue template, every table. Measured 24 Oct: 76/76, columns, rows and totals equal. |
| `npm run collect:cloudflare -- --tenant client-1`, `npm run collect:linux -- --host host-redacted --tenant client-1`, `... --host host-redacted` | The collectors, live. Measured 24 Oct, 07:58 UTC (the re-collection after the night's review): DNS 58/58 records in 6 zones and audit 728/728 rows over the 18-month window, both complete; the conf.d host 24/24 vhost files, 761 observations, 46 server blocks, 8 inventory addresses (one IPv6), 3.0 s over SSH; the sites-enabled host 14/14, 301 observations, 30 blocks, 2 addresses, 2.5 s. Nothing unreadable, nothing malformed; one credential-shaped snippet skipped by name. The tenant id is neutral (`client-1`) and the aliases are the operator's own `ssh_config` entries, configured in `LINUX_HOSTS`. |
| `npm run zetaris:setup` | The idempotent Zetaris setup: datasource, USL, DQ rule. Measured 24 Oct against the configured instance: 19 statements, 17 ok, 2 skipped, 0 failed, 3.4 s; `RUN DQ` on the USL's `collection` table: `run_complete` 4 total / 4 valid / 0 invalid. |
| `npm run zetaris:queries -- --tenant client-1` | The agent's queries through Zetaris (`DataLayer` over `ZetarisEngine`, every `{{t:x}}` as `DRIFT.x`), re-run over the re-collected rows at 08:0x UTC: hero per host (0 and 0 rows), `proxy_split` (1), `proxied_without_real_ip` (10 + 1 wildcard on the conf.d host, 9 on the sites-enabled host), `orphan_record` (1, 2), `orphan_vhost` (0, 3), then `SHOW DQ INVALID RECORD run_complete` (0 rows: every run complete); 13 queries, 206 to 532 ms each. |
| `npm run examples` | Three bundles cut from the recorded one, one per real case, and the pass's findings over each: `examples/`. |
| `npm run conformance` | Vendored Meterless World Model conformance suite, 8/8, through `src/engine/world.ts`. |
| `npm run smoke` | Spike A, Zetaris: `SELECT 1` and `SHOW LIGHTNING DATABASES` over REST with the agent's key. Spike B, Nightshift: Nemotron Lightning and Ultra by explicit id, signed receipts verified, job event stream read. Spike C, World Model conformance. |

## Run

```bash
npm install
cp .env.example .env   # ZETARIS_API_KEY, CLOUDFLARE_API_TOKEN, DATABASE_URL, REDACT_SALT, REDACT_WORDS; the Nightshift token is read from its local file
SAMPLE_MODE=true npm run sample   # the real pass over the recorded, redacted rows; no credentials
SAMPLE_MODE=true npm run preflight -- --proposal examples/proposals/a-unproxy-www.json   # GO / NO-GO / GO-IF / ESCALATE for one proposed change
npm run answer -- --finding <fnd-id> --accept --until 2026-11-30T00:00:00Z --reason "..."  # teach the agent an exception; --list, --forget <mem-id>
npm run site                      # rebuild the replay page (docs/) from examples/
npm run collect:cloudflare -- --tenant <id>            # live: Cloudflare DNS + audit log -> Postgres
npm run collect:linux -- --host <alias> --tenant <id>  # live: one SSH session running the fixed read script -> Postgres; <alias> is a LINUX_HOSTS entry
npm run zetaris:setup && npm run zetaris:queries -- --tenant <id>
npm run export:bundle                                  # Postgres -> sample/bundle.json, redacted once more
```

`npm run sample` prints the trace (one JSON line per step), one JSON object per finding and one summary line:

```
SAMPLE: 4 collection runs, 0 failed the DQ gate (none), 1062 observations in the World Model, 27 finding(s):
fnd-b4a40091cdb4f906 proxy_split cloudflare.dns bce1ca2b... proxied -> ESCALATE (3/4 preconditions hold, fails: referent_unchanged);
fnd-45d5f3f4a2eb0b2e proxied_without_real_ip host-aa516a /etc/nginx/conf.d/word-005ed8-prod.conf server[host-18efce.ai:443].real_ip
-> ADOPT (4/4 preconditions hold); ...; judge skipped (model: none); memory: 0 lesson(s), 0 exception(s) applied, 0 lapsed
```

Each finding carries a short id (`fnd-` plus 16 hex of the World Model's finding id: tenant, class, host, object,
setting, record), the same on every pass over the same rows; it is what `npm run answer` takes. Every step is
appended to `logs/<run>.jsonl`; `logs/` is local and gitignored. In sample mode every line carries
`"model_requested":"none"`, the query lines included. Every free-text field of a trace line (`input_summary`,
`output_summary`, `detail`) goes through the redactor before it is written.

## The pass

`src/pipeline.ts`. One tenant's collection runs go through seven steps, each traced with the agent that did it,
the model it used (`model_requested`; `none` on every line of a sample pass) and whether it worked.

| Step | What runs | Trace |
|---|---|---|
| gate | `run_complete` for every collection run. A run that observed fewer objects than it asserted before collecting, did not finish `complete`, never asserted a population, or (host surfaces) stored fewer observation rows than it asserted fails; the collector's own `observed_count` is not taken on trust. The audit log is gated on the checks, not the rows: `audit_event` carries no `run_id` (its key is the vendor's event id, so overlapping pulls dedupe), so when a tenant's latest `cloudflare.audit` run fails the gate, or the tenant has none, every template that reads `audit_event` (`actor_attributed`, `previous_value_recoverable`, `referent_unchanged`, `record_reverted`) is a recorded rejection, "audit log incomplete", for that tenant's findings, and they escalate; a cursor walk cut at page n is never read as "no actor, no previous state". | `check`, status `not_checked` for a failing run; its observations feed nothing below; one `not_checked` line per tenant whose audit log is withheld |
| observe | Every observation of a passing host-bound run goes into the World Model. A `dns_name` referent carries a fingerprint: what the name's A and AAAA records resolved to in the DNS run of the same pass (the passing DNS run nearest in time, within six hours). | `observe` |
| detect | The hero query over the latest run of each (tenant, surface, host) against that DNS run. A row is `found_but_different` when the setting's bytes are unchanged since the previous passing run and the World Model says the referent's fingerprint is not; `dns_change` otherwise. Each row carries the DNS record it came from, so a name with an A and an AAAA record gives two findings. When no DNS run of the pass passed the gate, the group is `not_checked` and the trace names the DNS run that failed; no older DNS run stands in. | `detect` |
| survey | The estate queries (`src/data/queries.ts`) over the same pass. Once per tenant, against its DNS run: a proxied CNAME aliasing a direct address record (`proxy_split`). Per host, against the latest passing nginx run and that DNS run: a proxied name served by an enabled block that trusts no `real_ip` range, or a proxied wildcard landing on a host where nothing does (`proxied_without_real_ip`); a record landing on the host with no enabled block naming it (`orphan_record`); a `server_name` with no record in the collected zones and no wildcard covering its zone (`orphan_vhost`). A survey finding has no previous observation, so its window is the audit log's reach up to the observation. | `detect` |
| check | The default precondition policy for the class, bound from the finding and run through the catalogue. A parameter the finding cannot supply, or a check the SQL guard or the engine refuses, is a recorded rejection, not a guess: it escalates that one finding and the pass goes on. Between checks the stop rule (`src/stoprule.ts`, below) asks whether the verb can still move; a settled verdict skips only the queued checks the operator has marked as not informing the next action, each traced with its reason. | `check` per template: id, row count, one sentence; `not_checked` for a rejection; `skipped` with the reason for a check the stop rule did not run |
| decide | The Decider first recalls the technician's lessons for the finding (`src/engine/memory.ts`, below), by exact scope key: an accepted exception in force makes the finding ADOPT until the lesson's expiry, which goes on the finding; a lapsed one re-raises it as ESCALATE ("exception lapsed"). Otherwise the policy: every check holds and none was rejected, ADOPT as a candidate; anything else, ESCALATE. HOLD needs a judge to bound it with an expiry, so a pass with no model never issues it. Then, for a finding that rests on a DNS record, the exposure line (`src/engine/world.ts`, below): since when the record has been in the state the finding rests on, stored in the World Model as an open edge. | `decide`, `model: none`, with the lesson that settled it when one did; `triage` lines for the recalled lesson and the exposure, `escalate` for a lapsed one |
| judge | Not called in sample mode. Withheld with a reason, before any call, when the verdict cannot move (a check not checked, `run_complete` failing, no check run, an exception in force or lapsed) or when a check that holds contradicts the detector's own claim, which withdraws the claim (`critique` from checker to detector, `revise` from the detector). Live, the call goes out under the tenant's app id and the receipt must pass custody as well as the tier gate (Judge and receipt gate, below). | `judge`, status `skipped`, with "verdict cannot move: ..." or "claim withdrawn by its own checks: ..." when withheld; one `triage` summary line per pass with the counters |

The hero finding is the cross-source one the whole stack exists for: an nginx vhost whose `proxy_pass` or
`server_name` has not changed a byte, pointing at a DNS name whose Cloudflare A or AAAA record now resolves to an
address the client's inventory does not know. It exists in no single table. On the recorded estate it finds
nothing, because every address record of a name a vhost serves lands on one of the two hosts, and
`test/datalayer.test.ts` shows one record moved off the inventory is found once per block that names it. The
hand-authored fixture `test/fixtures/authored-bundle.json` keeps the full story (two runs per host, a record that
moved between them) for `test/pipeline.test.ts`, which also runs the same pass over a copy whose record still
points at an inventory host and asserts no hero finding, then adds a DMARC TXT and a CNAME on the same name and
asserts nothing still: the result comes from the rows, not from a stored answer, and a TXT or CNAME is not an
address.

The survey is what the first real collection surfaced, and none of it was planted. `examples/` holds one slice of
the recorded bundle per case and the pass's findings over it.

## Collectors

Two collectors, both writing through `src/data/store.ts` into the app Postgres (`DATABASE_URL`), both redacting
every collected-text column before a row leaves them.

**Cloudflare** (`src/collectors/cloudflare.ts`, `npm run collect:cloudflare -- --tenant <id> [--since YYYY-MM-DD]
[--dry-run]`). A read token (`CLOUDFLARE_API_TOKEN`: Zone:Read, DNS:Read, Account:Audit Logs:Read) lists the
zones, reads every zone's record count before any record row (`per_page=1`, the population the DQ gate
compares against), then the records at 500 a page, then the account audit log at 1,000 a page following the
cursor. Measured 24 Oct: 6 zones, 58 records (A 20, CNAME 19, TXT 12, MX 5, NS 2; 24 proxied), 714 then 728 audit
rows since 2025-04-25 (the earliest the API accepts is today minus 18 months plus one day; the account's log in
fact begins 2026-03-20; the second figure is the re-collection at 07:58 UTC, which saw the first pass's own
reads). The audit log has no total, so the audit run asserts the sum of the server's per-page
counts and observes the distinct rows that normalised. The log carries no old or new value fields: a DNS record
update is `product dns_records` with the request body as `new_value`, a system create or delete is `product dns,
type record` with the record as `value`, and a record's previous state is reconstructed as the latest earlier
create or update on the same record id (`previousState`, and the `previous_value_recoverable` template). A
delete's removed record goes to `old_value`. The actor is the pseudonym of the actor's email; an API token has
none, so the actor is null (the 21:47 re-point of the www record below is one). TXT contents are redacted tag by
tag, because Cloudflare quotes them and a quoted token is not a bare one to the redactor; a wildcard name is
redacted with its star set aside and restored. Each collection adds its own reads to the account log as `view`
events (187, then 201, across the two passes of the day).

**Linux** (`src/collectors/linux.ts`, `src/collectors/nginx.ts`, `npm run collect:linux -- --host <alias>
--tenant <id> [--dry-run] [--out file]`). One SSH session per host through the operator's own `ssh_config`
aliases, listed with each host's export folder in `LINUX_HOSTS` (`.env`; the collector reaches nothing else,
and the alias names are the operator's, not the agent's), `ssh -o BatchMode=yes -o ConnectTimeout=15 <alias>
bash -s`, with a fixed script of reads on stdin: `id -un`, `hostname`, `date`, `ip -4 -o addr show scope
global` and `ip -6 ...`, `ls -l --time-style=full-iso` of `conf.d`, `sites-available` and `sites-enabled`,
`base64 -w0` of `nginx.conf`, every regular vhost file and every regular file they `include` under `/etc/nginx`
(four rounds; a `sites-enabled` symlink is never read as a file of its own), `systemctl list-timers`, the backup
export folder (`ls`, `find`, `sha256sum` of plain nginx copies, and `tar -tvzf` plus `tar -xOzf | sha256sum` per
regular-file `etc/nginx` member of the newest tarball that holds any, nothing landing on disk), and certbot's
renewal configs. Nothing writes, restarts, installs or escalates. A path the login cannot read comes back as a
section with a non-zero exit and is recorded in the run summary's `not_readable` list and in the trace; the run
is partial only when a file of the asserted vhost population was not fetched, the vhost listing itself was
refused (`expected_count` null), `nginx.conf` was not read while vhost files were (nothing can then say which
blocks are served: every `.enabled` is `unknown`, `http.real_ip` is `unknown`), or the stream lacks the `DONE`
marker; a closed export folder or renewal directory leaves the run complete and simply yields no backup rows.
Files whose name, lower-cased, looks like a credential or key material (`htpasswd`, `passwd`, `api-key`,
`secret`, `token`, `credential`, `.pem .key .crt .cer .csr .p12 .pfx`) are never read and never counted (one on
the sites-enabled host, skipped). The population is asserted from the directory listings before a byte is
parsed: regular files in `conf.d` and `sites-available`, 24 on the conf.d host and 14 on the sites-enabled host,
all fetched. Both hosts' export folders and tarballs were readable without root; the only path outside
`/etc/nginx` every TLS vhost includes, certbot's `options-ssl-nginx.conf`, is recorded as an unresolved include
(20 and 9), not fetched. A grammar fault nginx itself would refuse (a stray `}`, a block or a quoted string open
at end of file) is parsed past and listed as `malformed` in the summary and the trace; none on either host.

What becomes rows: one `file` observation per fetched nginx file (value_hash = sha256 of the bytes, so it
compares with the export copy's `sha256sum`; 26 of 26 conf.d-host and 17 of 17 sites-enabled-host nginx files
present in the newest tarball were byte-identical to its member, and the six enabled sites that read as changed
in the first export were the tarball's symlinks hashed as the empty input, now left out); per server block
`server[<first server_name>:<port>].server_name`, one `.server_name[<name>]` row per DNS-shaped name (refers_to
`dns_name`) with a `.server_name[<name>].zone` sibling (the name's last two labels, redacted: the zone a wildcard
record would cover it from, which the pseudonym of the whole name cannot say), `.listen`, `.ssl_certificate`
(refers_to `cert`), `.root`, `.real_ip` (`trusted:<n> header:<h> scope:<server|http>` or `absent`), `.enabled`
(reached from `nginx.conf` or not: a `.bak` beside the live file and an unlinked site are on disk, not served),
`.location[<path>].proxy_pass` (refers_to `dns_name`, `ip` or `upstream`; nothing for loopback), `.alias`,
`.root`; `http.real_ip` on `nginx.conf`; `system.hostname` (displayed as its pseudonym: both machines report the
same hostname, so the host's identity is the pseudonym of its ssh alias); one `timer[<unit>]` row per systemd
timer. Every one of these carries `value_hash` = `Redactor.fingerprint` (HMAC-SHA256 under `REDACT_SALT`, printed
`sha256:<64 hex>`), not the plain sha256 of the value: measured on the first export, 138 guesses built from the
six public zone names (the zone, `www`/`dev`/`api` under it, the pair `<zone> www.<zone>`) matched 194 plain
hashes and confirmed 19 plaintexts behind their pseudonyms; under the salt a guess confirms nothing, and the
`file` rows alone keep the plain hash, because theirs must equal the tarball copy's. `inventory_asset` per
global IPv4 and IPv6 address (kind `vps`; the hero query's "does the client own this address" is answered from
here, so an AAAA record can land on an inventory host). `backup_snapshot` (kind `export`) per nightly
`server-config-<date>.tar.gz` of the family that holds `etc/nginx` (nine on each host; an application dump
written 52 ms earlier in the same run is not it) and `backup_item` for every regular-file member of the newest.

**Redaction.** Every row goes through `src/redactor.ts` in the collector and once more in the Store (which
reports, by count only, anything the second pass changed: 0 on every pass of the day). Hosts are
`host-XXXXXX.<tld>`, addresses `ip-XXXXXX`, logins `user-XXXXXX`, mailboxes `mail-XXXXXX@domain-XXXXXX`, the
tenant's own labels (`REDACT_WORDS`) `word-XXXXXX`, all salted with `REDACT_SALT` so the same name is the same
pseudonym in every table and every collector, which is what the cross-source joins rest on. Labels are
configuration, not collected: the list holds the zone labels, the product names, the operator's company and
host nicknames, anything that turns up in file names, timer units, `/var/www/<label>` paths and comments, and a
new product or brand needs an entry before the next collection. The first probe of the day searched the stored
rows for the zone labels, both public addresses, the WireGuard range and the operator's mailbox and found 0; it
did not search for product and company labels, and the review found 53 of one and 20 vhost rows of another in
the exported bundle, in `/var/www/<product>/` paths, a timer unit and two file comments. The list now carries
them, the hosts were re-collected, and the probe is code: `npm run export:bundle` refuses to write a bundle in
which any `REDACT_WORDS` or `EXPORT_DENY_WORDS` entry still stands alone (it prints positions in the list and
counts, never the labels: `leak probe: 0 of 21 deny-list label(s) in the file` on the current export), and
`test/leak.test.ts` runs the same probe over `sample/`, `examples/`, `README.md`, `ops/`, `scripts/`, `src/`,
`test/`, `sql/`, `.env.example` and `package.json` with the operator's list (skipped, with one line, where the
list is blank; the configured ssh aliases are the one allowed carrier, because the brief mandates them). The
reviewer's substring grep for the three labels over the bundle and the examples now returns one hit, the
letters inside Cloudflare's own `registrar/domains` resource type.

**Honesty about root.** There is no "read-only SSH": the key is the operator's, so the read-only property is the
script's, not the host's. `ops/` holds the designed, not installed, second stage: a `drift-collector` user whose
key is bound to a forced command (`ops/ssh/drift-collect`) that runs these same reads and refuses any other
request with exit 2, a root-only helper (`ops/ssh/drift-root-reads`) for the two reads a non-root user would
lose (`/etc/letsencrypt/renewal`, a root-gathered export folder), and one sudoers line granting exactly that.
`ops/` is the only place `sudo` is invoked in this repository (the collector test asserts the streamed script
never names it); nothing the agent runs today calls it. Neither host
runs etckeeper or restic; the nightly tarball is the backup artefact. See `ops/README.md`.

## Zetaris setup

`npm run zetaris:setup` (`src/zetaris/setup.ts`), idempotent, 19 statements in the order they first ran live,
one per REST call: `SHOW DATASOURCES`; `CREATE DATASOURCE DRIFT` only when absent, built from `DATABASE_URL`'s
user, password and database and `ZETARIS_PG_HOST` (`drift-pg`, the container name on the `zetaris_default`
network; `host.docker.internal` does not resolve in the driver, and the Windows-side `127.0.0.1:15432` is not
reachable from it), then `REGISTER DATASOURCE TABLES FROM DRIFT`, or `REFRESH DATASOURCE TABLES FROM DRIFT` when
it existed; `CREATE NAMESPACE IF NOT EXISTS lightning.metastore` and `lightning.metastore.drift`; `COMPILE USL IF
NOT EXISTS drift_usl ... DDL` with four `CREATE TABLE` blocks in ONE request (the one statement that carries
several, separated by `;`; the adapter allows it for `COMPILE USL` only); `ACTIVATE USL TABLE` for each of
`collection`, `setting`, `referent` and `backup_copy`, each a SELECT over `DRIFT.*` returning exactly the
declared columns with NOT NULL varchars in `COALESCE` and ints `CAST`; `LIST DQ USL`, then `REGISTER DQ
run_complete TABLE ...collection AS observed_count >= expected_count AND status = 'complete'` only when it is not
listed; `RUN DQ TABLE ...collection`; `SHOW NAMESPACES OR TABLES IN lightning.metastore.drift`; `COUNT(*)` per
USL table. The CREATE DATASOURCE statement is built in memory when sent; the printed plan and its trace line
carry `password "<redacted>"`.

The USL tables: `collection` (the runs), `setting` (observations; the column is `source_kind`, because the DDL
validator rejects a column named `source`), `referent` (every dns_name observation joined to the records of its
name: `ref_id`, `target_name`, `resolves_to`, `proxied`, `dns_run_id`; the table is `referent` because
`reference` is rejected too; both refusals are the one generic message `Invalid DDL statement`), `backup_copy`
(backup items joined to their snapshots). `RUN DQ TABLE` returns `name | table | type | total_record |
valid_record | invalid_record`, the custom rule and the key constraints as rows; `SHOW DQ INVALID RECORD
run_complete TABLE ...` returns the failing runs (0 on 24 Oct). Measured counts through the USL after the first
real collection: collection 4, setting 1,068, referent 185, backup_copy 85, equal to the Postgres counts; the
re-collection of 07:58 UTC left the same tables holding 4 runs, 1,062 observations and 76 backup items, which
is what the USL now selects from (`npm run zetaris:queries` over them is in the Status table).

## Data layer

`sql/schema.sql` is the one DDL, read at import by `src/data/schema.ts`; the known-table guard, the sql.js loader's
column order and the parity test's per-table SELECTs all derive from it. Eight tables (the brief said nine; the
shared DDL defines eight, and a ninth would be added to the DDL alone):

- `collection_run`: one collector pass over one surface, with the population it asserted before collecting (`expected_count`), what it observed and its status (`running` between `Store.beginRun` and `finishRun`, then `complete`, `partial` or `failed`). The DQ gate's input.
- `observation`: one setting value seen in one run: object, dotted path, sha256 of the canonical value, the redacted text for display, what the value refers to (`refers_to_type`, `refers_to_id`) and the authority of the source (100 live, 40 backup, 20 approved).
- `approved_setting`: the values a technician signed off, per tenant and optionally per host. Empty on the recorded estate; no sign-off has happened yet.
- `backup_snapshot`: a config export tarball, restic or etckeeper snapshot of a host at a time.
- `backup_item`: the setting hashes that snapshot holds.
- `dns_record`: Cloudflare records as seen in one DNS run; `record_id` repeats across runs, which is what makes a change visible.
- `audit_event`: who changed what, from Cloudflare, etckeeper or the journal, with old and new value when the log has them.
- `inventory_asset`: the addresses and hosts the client owns; filled by the Linux collector with each host's global addresses.

Timestamps are ISO 8601 UTC text, so they compare and sort identically in every engine. No SERIAL, no JSON columns,
no booleans (INTEGER 0/1).

`src/data/rows.ts` is one interface per table, column for column with the DDL (checked at compile time and in the
tests), the natural key per table, the list of collected-text columns and how the redactor reads each, and the
deterministic ids (`stableId`: 16 hex of sha256 over the parts), so the same collection yields the same ids and a
re-insert is a no-op. `src/data/store.ts` is the Postgres store the collectors write through: one transaction per
call, parameterised multi-row inserts, `ON CONFLICT DO NOTHING` on keyed tables and a read-then-skip on the two
tables without a key, `beginRun`/`finishRun` as the run lifecycle, every `*_at` checked for the canonical
millisecond form, every collected-text column through the redactor once more, error text scrubbed of connection
strings. `npm run export:bundle -- [--out p] [--schema s] [--note t]` reads every table in one REPEATABLE READ
snapshot, redacts once more, nulls `value_redacted` over 2 kB (30 file bodies in the recorded bundle), checks
that sql.js loads the result and writes the bundle shape, rows in natural-key order.

Two engines behind one interface (`src/data/layer.ts`): `SqlJsEngine` (SQLite in WebAssembly, in memory, for
SAMPLE_MODE and tests; applies the schema and loads a bundle) and `ZetarisEngine` (the measured REST adapter; tables
live in the registered datasource, `ZETARIS_DATASOURCE`). Both return every value as a string and NULL as `""`,
the shape Zetaris returns, so rows compare across engines.

Catalogue SQL names tables as `{{t:table}}` and parameters as `{{p:name}}`. `DataLayer.render` turns a table into
the engine's name for it (bare on sql.js, `DRIFT.observation` on Zetaris) and a parameter into an escaped literal:
strings single-quoted with `'` doubled, finite numbers plain, null as `NULL`, anything else refused. There are no
bound parameters because Zetaris REST takes one SQL string per call and binds nothing, so the same rendering runs
on both engines and the guard sees the final text. `assertSelectOnly` then requires a leading SELECT and, with
string literals stripped, refuses any semicolon, any double quote (identifiers are unquoted and strings single-quoted
in the portable subset; a `"x'"` token would otherwise hide a UNION, a comment and a bare table from the strip while
sql.js and Spark run them), comments, and INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/GRANT/PRAGMA/ATTACH as tokens:
`'drop'` inside a literal passes, and a parameter carrying `'; DROP TABLE observation; --` or a DMARC `v=DMARC1;
p=reject` is rendered as one escaped literal, runs as data and returns no rows (tested on both the data layer and the
catalogue). Both engines apply the same literal-stripped one-statement check before running anything.

The portable subset: lowercase unquoted identifiers, single-quoted literals, no `::` casts, no ILIKE, no date or
time functions, no boolean literals, one statement per query, no trailing semicolon. The catalogue uses JOIN, LEFT
JOIN, correlated NOT EXISTS, IN (subquery), CASE, LIKE, ORDER BY (total, so both engines return the same row order),
UNION ALL, non-equi self-joins and one correlated COUNT(*) subquery (the DQ gate); the judge may also use COALESCE,
MAX, MIN and LIMIT (capped at 50). The survey queries add `substr`, `instr` and `length` to read a block's key out
of a setting path (`server[<name>:<port>]` is everything before `.server_name[`, `.enabled` and `.real_ip` are
eight-character tails) and `COALESCE` to follow a CNAME one level; they sit in JOIN ON and in correlated
subqueries, never in a top-level WHERE, for the reason under Limitations.

`test/parity.test.ts` runs 38 cases (hero per host, gate, the pass queries, the five survey queries, the audit
span, every catalogue template, every table) through sql.js always, and through Zetaris when `PARITY_LIVE=true`
and the datasource holds exactly the rows of `sample/bundle.json`, which it does after `npm run export:bundle`.
Measured 24 Oct: 76/76 equal. The two surprises it was designed to catch, header case and text collation under
ORDER BY, did not appear; the one it did catch is under Limitations.

## Precondition catalogue

`src/catalogue/templates.ts`. Nemotron Lightning never writes SQL: it chooses template ids from this list and fills
typed parameters (zod v4), the DataLayer renders and runs them, and each template says whether rows coming back mean
the precondition HOLDS or FAILS, so a row count becomes a verdict without a model. Every template runs on the
recorded bundle in `test/templates.test.ts` with its rows asserted (the two approval templates over approvals
added in memory, since no technician has signed anything off yet).

| id | purpose | rows mean |
|---|---|---|
| `host_in_inventory` | The address is a known asset in the client's inventory. | holds |
| `dns_target_in_inventory` | Every address (A or AAAA record) the DNS name resolves to in the given DNS run is a known inventory asset; rows are the address records that resolve outside it. | fails |
| `change_in_last_backup` | The host's most recent backup already holds the live value of this setting. | holds |
| `actor_attributed` | An audit event with a named actor touched the resource inside the window. | holds |
| `previous_value_recoverable` | The state the resource had before its latest audit event is on record: the event carries `old_value`, or (a log without old values, Cloudflare's) an earlier create or update carries the body that was in force. Rows say which. | holds |
| `restore_would_regress` | A restore from the host's latest backup would keep every approved setting; rows are approvals newer than that backup whose value the backup lacks or differs from. | fails |
| `referent_unchanged` | Nothing the name resolves to changed inside the window; rows are the evidence, from consecutive DNS observations and from audit events on its records. | fails |
| `run_complete` | The collection run observed the whole population it asserted and finished complete; rows are the run failing that gate. | fails |
| `setting_matches_approved` | The setting's live value in the run equals an approved value for it. | holds |
| `other_settings_reference` | Blast radius: no other setting in the same run points at the same target; rows are the ones that do. | fails |
| `record_reverted` | A later audit event put the resource back to the state an earlier event replaced: its `old_value` reappears as a later `new_value`, or a later body equals the body in force before the change. | holds |
| `backup_recent` | A backup snapshot of the host exists at or after the given time. | holds |

Timestamps validate as ISO 8601 UTC and are normalised to the millisecond form (`…00Z` becomes `…00.000Z`), and the
sql.js loader refuses any stored `*_at` value outside that form, so text comparison stays total on both sides of a
window edge; hashes must be `sha256:` plus 64 hex or bare 64 hex, which is the shape the collectors emit.
`restore_would_regress` is stricter than its one-line brief on purpose: an approval of a value the latest backup
already holds is not a regression.

Finding classes: `found_but_different` and `dns_change` from the hero query; `proxy_split`,
`proxied_without_real_ip`, `orphan_record` and `orphan_vhost` from the survey; `changed_since_backup` and
`drift_vs_approved` with templates and default policies but no detector yet.

Selection (`src/catalogue/select.ts`): the system prompt lists every id, purpose, class and parameter and asks for
at most four checks as one JSON object, with an `other` field for a check that fits no template. `validateSelection`
drops an unknown id, bad parameters, a duplicate or anything past six and records a reason per drop instead of
throwing, so an eval can count valid against invalid; a missing or long `why` is prose and is blanked or truncated,
not rejected. `defaultSelection(class)` is the documented fallback, three or four checks per class with
`run_complete` first everywhere; `defaultChecks(finding)` binds it from the finding through the same validator. It
is what SAMPLE_MODE and any pass without a model run.

## Judge and receipt gate

`src/agents/judge.ts`. The judge refutes; it never confirms by assertion. A detector's claim goes to Nemotron Ultra
with up to 20 supporting rows and the schema, and Ultra answers with ONE SELECT that returns rows if and only if the
claim is false. We guard it (no `{{p:}}`, no bare table name, at least one known `{{t:}}`, `assertSelectOnly`,
LIMIT appended or capped at 50) and run it ourselves through the same data layer as the catalogue. Rows refute the
claim; no rows and it stands. Every verdict carries the SQL as run, the row count, the rationale, the receipt id, the
served model and the latency.

`src/gate.ts`. A verdict counts only when the signed receipt says an Ultra answered. The served model is the
receipt's winning phase (`phases[].model` equal to `routing.winner`), else `routing.winner`, else
`winning_route.model`; the tier is read from the model id, because `requested_mode` in the receipt is always
`meterless/auto` even for explicit-id calls. The gate passes only when the receipt was found, its signature verifies
and the served tier is the requested tier. Substitution (Lightning answered an Ultra request), a tampered body, an
unreachable model, or a receipt list that cannot be fetched after the model answered all file the finding
`not_judged`, which escalates and is never retried silently. A reply that is not one guarded SELECT, or whose SELECT
fails to run, is `invalid_output`, and the eval counts it. A response with no `receipt_id`, or whose receipt is not in
the runtime list after one refresh, is `not_judged` and escalates: the response body is what a substituting proxy
controls, so its own `routed_model` is reported in the trace (served tier, `signature_ok` null, reason "unreceipted")
but never trusted. `ReceiptStore` fetches `GET /v1/meterless/receipts` once per pass; the orchestrator constructs one
per pass, hands it to every `judgeClaim` and calls `reset()` between passes.

**Receipt custody.** A verified signature says the runtime signed this receipt; it does not say the receipt is the
one for our request, nor that the runtime filed it under our app. Every successful receipt also carries
`request_id` (equal to the chat response's `id`), `prompt_preview` (the first characters of the prompt the runtime
saw, ellipsis-trimmed when cut) and `app` (the `meterless-app` header the call went out under). When the judge is
given the tenant the claim belongs to, the call goes out under `drift-agent:<tenant>` (`tenantAppId`; a tenant id
that is not a header-safe token makes the claim `not_judged` with that reason before any call, never a throw) with a
16-hex request nonce first in the user message, and `checkCustody` runs after the signature check. Identity holds
only when `request_id` equals the response's `id`: a response without an id, or a receipt without a `request_id`,
is anomalous (the OpenAI-compatible response always carries one, every successful receipt the other) and fails
closed like an unreceipted response, so a proxy that strips the id gets no softer path. `prompt_preview` is a
secondary check that can refute identity and never establish it: it is compared against the user message alone
(never the system prompt, which is the same on every judge call, nor the join of the two), it counts as a `match`
only when it is a prefix of that message reaching the end of the `[request <nonce>]` line, a preview of the shared
system prompt or one that stops inside the nonce is `uninformative`, and a preview that is a prefix of nothing we
sent is a `mismatch` that fails identity whatever the id says, which is what catches a replay of our own earlier
receipt together with its id when the runtime previews the user message. Attribution holds when `app` is the id we
sent. The gate runs before the reply is read, because a receipt that is not ours means the answer is discarded and
the call made once more as a fresh request (a new nonce, so a new `request_id` and no cache hit); a second custody
failure fails closed, `not_judged`, with a gate reason that starts `custody` (the judge's verdict prefixes it:
`receipt gate: custody: ...`; the verdict also carries `custody.ok === false`, the field to count on rather than
the prefix). Any other failure (substitution, a tampered body, an unreceipted response) is returned at once and
never retried, as before. Every custody check is one `check` trace event carrying ids, never the prompt text; the
verdict carries `signatureOk`, the custody fields (`request_id` and `app` each match/mismatch/absent,
`prompt_preview` match/mismatch/uninformative/absent, and the receipt's `cache.status` for the eval to count) and
the number of attempts. Without a tenant the gate is exactly what it was.
The two real receipts of 23 Oct are filed under the shared app id with their own request ids, so under a tenant they
fail custody on both attempts (tested); receipts signed in the tests with a throwaway key verify, because
`verifyReceipt` trusts the key each receipt carries (see Limitations). Not gated, by scope: `egress.sent.context_sources`,
`hmem.injected`, `autopilot.ctx_dropped`, `privacy.redaction.spans` and a cache hit; both real receipts show
`hmem.injected 3`, so a gate on injected context would fail every receipt until the switch that stops the
runtime's injection is found. That injected `hmem` is the runtime's context and has nothing to do with the agent's
own technician memory below.

## Pre-flight

`src/preflight/`, `npm run preflight -- --proposal <file> [--bundle sample/bundle.json] [--out <file>] [--quiet]
[--live]`. GO, NO-GO, GO-IF or ESCALATE before a change is made. A technician proposes one typed change
(`ProposedChange`, zod, `src/preflight/proposal.ts`): a `dns_record` change of `proxied` or `content`, by record id or
by name and type, or a `vhost_real_ip` change of one vhost file's `real_ip` on one host. The pre-flight binds it to
exactly one row of the latest passing run (none or several: invalid, counted, ESCALATE; the latest run gated out:
ESCALATE, not the proposal's fault), renders the table the change would touch as a derived table in place of
`{{t:table}}` for the duration of one call (`src/preflight/overlay.ts`: a SELECT over the base table with a CASE on
the bound rows, every column in DDL order, literals only; guarded at construction: one SELECT, a known table, it
must read its own base table, no `{{p:}}`), runs the whole pass (`src/pipeline.ts`) over that world through the
same `DataLayer`, and compares the findings with the baseline pass by key (class, anchor, name, record; never the
verb or the checks). `DataLayer.render` keeps the query's alias (`{{t:x}} o` or `{{t:x}} AS o`, one alias either
way) or adds the table name as one (Spark wants one), and
renders the same text on sql.js and Zetaris except the `DRIFT.` qualifier (tested by string equality). Nothing is
written anywhere; a real pass on the same engine is byte-identical before and after pre-flights (tested). Two
changes on one table compose: the second reads the first's SELECT as its base.

- **GO**: the change adds no finding; the verdict says what it removes. A value already in force removes and adds nothing and says so.
- **GO-IF**: the change adds findings that the prerequisite catalogue (`src/preflight/prerequisites.ts`) clears: `add_real_ip_block` for `proxied_without_real_ip` (every absent `real_ip` row of the object, server or http scope), `proxy_record` for `proxy_split` (proxy the direct target). Each prerequisite is a further overlay, the pass runs again, at most three iterations; the verdict lists the steps in order and whether each cleared the finding it was bound from. The catalogue order picks the next step in both modes (the first entry that binds from the first added finding); a model-chosen prerequisite is not built.
- **NO-GO**: the change adds a finding no entry clears. `orphan_record`, `orphan_vhost`, `dns_change` and `found_but_different` have no entry: clearing them means adding a server block or a DNS record, and an overlay never adds a row. The addendum's `restore_backup` and `revert_record` are not built: `backup_item` holds `file` hashes only, so a restore overlay changes no survey finding, and a revert is the negation of the proposal.
- **ESCALATE**: the simulation cannot run, or three prerequisites did not clean it.

Measured 24 Oct on `sample/bundle.json` (`examples/proposals/`, the verdict files written by the script; none tuned):

| proposal | change | verdict | delta against the 27 baseline findings |
|---|---|---|---|
| `a-unproxy-www.json` | `proxied` 1 -> 0 on the www CNAME of the split zone | GO | removes 3: the `proxy_split` and the two `proxied_without_real_ip` on the vhost blocks that serve www; adds none |
| `b-replay-16-april-proxied.json` | `proxied` -> 1 on the same record, the `proxied` field of the real UPDATE body of 2026-04-16 21:12:47Z | GO, zero delta | the record is already proxied in the recorded world, so the derived table differs in no column and 27 stay 27. NO-GO or GO-IF was expected before running; the honest result is that the body replays the state in force. Staging the "as of 21:11" act needs a pre-state the single-field proposal cannot express (see Limitations). |
| `c-vhost-real-ip.json` | `real_ip` absent -> `trusted:15 header:CF-Connecting-IP scope:server` on both blocks of the vhost that serves apex and www | GO | removes the two www `proxied_without_real_ip` findings; adds none |
| `d-retarget-apex-outside-inventory.json` | apex A record `content` -> `203.0.113.9` (RFC 5737), bound by name and type | NO-GO | adds two `dns_change` hero findings (the vhost's `server_name[apex]` rows point at a name resolving outside the inventory), which no prerequisite clears; removes the two www findings, since nothing lands on an inventory host any more |

GO-IF is exercised in `test/preflight.test.ts` (26 tests): proxying the direct A record of a `.club` name served by two
enabled blocks of one conf.d vhost that trust no range adds two `proxied_without_real_ip` findings; one
`add_real_ip_block` on that file clears both and, with them, the host-wide wildcard finding on the same host (an
enabled block that trusts a range is what that check looks for): 29 findings, then 26, one iteration. The loop bound
is tested (three useless iterations, then ESCALATE; a fixed key, NO-GO after one; an empty catalogue, NO-GO at zero).
Each pre-flight runs the baseline and one simulation in about 300 ms on the bundle. Every line is traced with agent
`preflight`; the two passes' own lines are re-labelled with the original agent in `target_agent` and the world
(`world=baseline`, `world=simulated#n`) in `detail`. Live, with `--live`, a Zetaris datasource and a Nightshift
token, the judge's falsifier is asked in the fixed world (the last simulation), where the detector's claim is false:
it must return rows there (`fires`), or it was vacuous (`falsifier_vacuous`); it is then run in the world where the
claim is true, where a sound falsifier returns nothing (`refutes_baseline` otherwise). The target, named in the
verdict (`judge.target`) and in a `judge` trace line: for a GO, the first finding the change removes, whose claim is
true in the recorded world; for a GO-IF, the finding the last prerequisite was bound from and cleared, whose claim is
true in the simulation it was bound in and does not exist in the recorded world (a GO-IF never judges a baseline
finding the change happened to remove, which the prerequisite did not touch). The call goes out under the tenant's
app id with custody checked. This half is unit-tested against stubs only.

## The stop rule and the exposure line

**Stop rule** (`src/stoprule.ts`, code only). Checks run in order, `run_complete` first. Between checks
`shouldStop` asks whether the verb can still move under the decision policy: once a required check fails or a
check could not be run, ESCALATE is absorbing, so a settled verdict skips the queued checks whose
`informs_next_action` is false, each traced `check`/`skipped` with "verdict settled by X; informs_next_action=false",
and the decide line's detail gains `earlyStop: true (reason)`. `INFORMS_NEXT_ACTION` is a per-template table the
operator sets by hand; it ships with every one of the 12 templates `true` (a skipped check that would have informed
the ticket is a cost the rule must not impose on its own say-so), so on the recorded bundle the rule skips nothing.
Two cases skip more: `run_complete` failing skips every queued check (the run is not a safe basis for any other), and
when every queued check reads a table whose run is gated out (`audit_event`, when the tenant's latest audit run failed
the DQ gate) they are recorded at once as `not_checked` with the same reasons and the same ESCALATE as one by one. A
check that could still flip ADOPT/ESCALATE is never skipped. Measured on the bundle (`test/stoprule.test.ts`): with
the default table 0 skips; with every template `false`, the literal "stop as soon as the verb is settled", 18 checks
skipped over 18 findings (16 `previous_value_recoverable`, 2 `backup_recent`) and 0 verbs flipped against the rule
switched off; with the audit run gated, 24 stops, 49 checks gated, and the same verbs and rejections as with the rule
off. `shouldWithdraw` runs before the judge: it withholds the call with "verdict cannot move" when a check was not
checked, `run_complete` failed, no check ran or a proposal is invalid, and with "claim withdrawn by its own checks"
when a check that holds contradicts the finding's own claim (`referent_unchanged` or `record_reverted` on a
`found_but_different`, `record_reverted` on a `dns_change`), emitting `critique` and `revise`. It never changes the
verb. The counters `early_stop`, `checks_skipped`, `checks_gated` and `withdrawn_judge` are in the trace (one
checker line per stop, one judge line per withheld call, one decider summary line per pass) and on
`PassResult.verifier`; `stopCounters(events)` reads them back from any trace.

**Exposure line** (`src/engine/world.ts`, recorded by the decide step). For a finding whose referent is a DNS record,
since when has the record been in the state the finding rests on (`proxied` for `proxy_split` and
`proxied_without_real_ip`, `content` for `orphan_record` and the hero classes), and for how many whole days up to the
DNS run that still shows it. Three plain SELECTs through the DataLayer: the record's row in the finding's DNS run
(its `observed_at` is `until`); the first event of the current state, the earliest audit event on the record up to
`until` whose body sets that state (`LIKE` with a parameter such as `%"proxied":true%`, or equality for a log that
stores plain values) with `NOT EXISTS` for any later delete or different body; and, only when needed, a count of
earlier events that set another state of the same field, which decides whether `since` is exact or a lower bound
(`at_least`). The bound rule: `exact` when the record was created in the state, when the event's `old_value` names
another state, or when an earlier body names the field (`"proxied":` or `"content":"`, the pattern a parameter) with
a different value or deletes the record; `at_least`, never upgraded, when the event's `old_value` already carries
the same state (the state predates it) or when no earlier body speaks to the field at all. A prior TTL, comment or
content edit on a `proxied` line therefore never makes the onset "exact" (a reviewer's probe showed the earlier
count did exactly that; `test/exposure.test.ts` pins both directions on the `host-f324df.com` and `host-c10fff.com`
records). No date function, no function
call in a top-level WHERE, no correlation in a JOIN ON; the days are counted in TypeScript from ISO 8601 UTC text
only. The finding gains `exposure: {since, days, bound, source: "audit:<event>", still_open_in: "<dns run>"}` and
the World Model an open edge finding -> record (`validFrom` = since, attrs `since`, `exposure_days`, `until`,
`record`, `event_id`, `dns_run_id`, `bound`) that a later DNS observation or a moved audit event supersedes (the old
edge closes, `supersededBy` the new). Measured on the bundle: the 16 April record since 2026-04-16T21:12:47.270Z
(event `evt-05fa48325110cdcb`, the `proxied: true` body; the 21:47 re-point kept the proxy on and does not restart
the clock) to 2026-10-24T07:58:55.125Z, 190 days, exact, on the three findings that rest on it; `host-18efce.ai` x2
since 2026-07-07T18:01:30.530Z, 108 days, exact; `host-f324df.com` x2 at least 113 days; `host-c10fff.com` at least
109 days; 8 of the 24 findings that rest on a record dated, the other 16 traced `not_checked` with the reason (no
audit event on the record); 34 SELECTs (15 record rows, 15 first-event queries, 4 earlier-body counts). A later DNS
observation two days on gives 192 days and closes the old edge; moving the 7 July event to 1 August gives 84. The
line says requests reached the host from Cloudflare addresses while the vhost had no rule to recover the visitor's
address; it says nothing about log contents, which the agent never reads.

## Technician memory (H-MEM)

`src/engine/memory.ts` over `vendor/hmem/`, the Meterless H-MEM reference vendored under its Apache-2.0 licence the
way the World Model is (`PREEXISTING.md`; same upstream commit); `npm run conformance:hmem` runs the vendored 13-check
runner with `HMEM_IMPL=src/engine/memory.ts`, 13/13. What that suite exercises is the vendored reference class, which
the module re-exports unchanged as `HMEM`; the runner then makes one check through `TechnicianMemory` (record, recall
by exact key, lapsed flagged, ledger), and `TechnicianMemory`'s own coverage is `test/memory.test.ts` (record, recall,
expiry, redaction, persistence). The module re-exports the reference unchanged and adds
`TechnicianMemory`, the second engine the agent rests on: the lessons a technician teaches it. Two kinds. An
**answer** to a question the agent asked, on one scope of the tenant's estate (`host`, `name` or `address`), so the
Decider does not ask it again. An **accepted exception** for one finding class on one scope key, so the Decider treats
the finding as ADOPT with the lesson's expiry. Every lesson carries a tenant, a scope key (one token), an expiry
(ISO 8601 UTC, after the time it was taught) and provenance (kind, at, by, run); the free text goes through the same
redactor as collected data before storage; a scope key is matched exactly and so cannot be rewritten, so it must
already be a pseudonym the findings carry (or a documentation name or address), which the redactor leaves unchanged:
one the redactor would replace (a real hostname, address or mailbox) is refused with `MemoryError` before anything is
stored, and the refusal never echoes it. Lessons are `long_term` H-MEM records (confidence 1, `chatId` = tenant, origin `manual` or
`user_correction`) whose structured fields ride as prefixed tags, so a reload from `state.json` rebuilds them
exactly; every recall hit is a `read` in the H-MEM ledger and `forget` a `delete` with the reason.

Recall is by **exact scope key**, never by similarity: an exception applies to a finding of its class on any of the
finding's host, name or address values, an answer to its own scope type, same tenant, and a lesson about one host
never applies to another because the two embed alike. An expiry is a lapse at that instant: a lapsed lesson comes
back flagged and is never applied. In the pass the Decider recalls before deciding: an exception in force gives
ADOPT, its expiry on the finding (`exception: {lesson, status: "applied", expires_at, scope_key, reason, accepted_by,
accepted_at}`), a `triage` trace line naming the lesson, and no judge call ("verdict cannot move: accepted exception
... holds until ..."); a lapsed exception, with none in force, re-raises the finding as ESCALATE whatever the checks
say (`status: "lapsed"`, an `escalate` trace line "exception <id> lapsed <expiry>: re-raised as ESCALATE"). The checks
still run and are recorded either way, and the pass's summary line says `lessons N, exceptions applied A, lapsed L`.
`answered(finding, question)` is the helper for the question step the pass does not yet have.

`npm run answer` is the technician's side. `--finding <id>` names the finding by the id the pass prints; the script
runs the pass over the bundle to find it, so the lesson is scoped to what the finding names (its DNS name by default,
`--scope host|name|address` otherwise), never to a typed string. `--accept --until <ISO 8601 UTC> --reason "..."`
records an exception (an expiry is required: an exception without one is a permanent silence, which the agent does
not record); `--question "..." --answer "..."` records an answer (expiry default 30 days). `--list` and `--forget
<lesson id>`. The store is `.world/memory/` (`state.json`, `ledger.jsonl`) under the working directory, gitignored
with the rest of `.world/`, so nothing recorded reaches the repository; tests and the examples use an in-memory
store, and the committed bundle, examples and page were built with no lesson in force. Measured 24 Oct, sample mode:
an exception on `proxy_split` for the www name until 30 Nov turned finding `fnd-b4a40091cdb4f906` from ESCALATE
(3 of 4 checks hold) to ADOPT on the next pass, with `judgeWithheld` "verdict cannot move: accepted exception mem-1
holds until 2026-11-30T00:00:00.000Z"; a 28-second exception on `proxied_without_real_ip` for `host-18efce.ai`
applied to both blocks that serve it (ADOPT already, now under the lesson), and the pass run after it lapsed re-raised
both as ESCALATE with "exception lapsed: mem-2 expired ...; the checks alone would say ADOPT" (ADOPT count 5, then 4,
then 5 again after `--forget`); the summary line read `lessons 2, exceptions applied 3, lapsed 0`, then `lessons 2,
exceptions applied 1, lapsed 2`; after `--forget` of both, `state.json` holds 0 records and the ledger
`create, create, read x6, delete, delete`.

The agent's memory is not the Nightshift runtime's injected `hmem` context: that is a custody question for the
receipt gate (above), and the two share nothing but a name.

## Replay page

`npm run site` (`scripts/build-site.ts`) writes `docs/index.html`, `docs/.nojekyll` and `docs/data/{index,
proxy-split, wildcard-no-real-ip, orphans}.json` from `examples/*/bundle.json` and `examples/*/findings.json` alone:
one HTML file with inline CSS and a short inline script that fetches `data/*.json`, no framework, no CDN, no external
font, light and dark mode, no horizontal scroll at 375 px with every finding open. Each finding opens to the claim,
the verb and class, the host and object pseudonyms, the finding id, the exposure line when the record has one, the
detector query that raised it (rendered, with the row it returned), every check with the template's purpose, HOLDS or
FAILS, the rendered SQL, its parameters, the rows (at most 20 shown, cells cut at 240 characters; the count and the
row hash cover every row), the recorded and re-run row counts, the sentence, and sha256 of the SQL and of the rows;
then the rejected checks, the decision and the judge step (`skipped, model: none` in these runs; a live record would
show the falsifier re-guarded and re-run, its receipt id, signature status, served model and the custody fields as
recorded). The findings do not store SQL, so the build binds each check's parameters from its finding with the pass's
own `bindParams`, renders the template through `DataLayer.render` on a sql.js engine loaded with that slice, and runs
it again. It refuses to publish (throws, writes nothing) unless the re-run row count, the verdict and
`template.explain()`'s sentence equal the record (the sentence names the window, resource and run, so the parameters
bound are the ones that ran), the detector returns the finding's own row, no output file holds a deny-list label
(`REDACT_WORDS` plus `EXPORT_DENY_WORDS`, the leak test's scan) or a configured ssh alias, no string in the data files
changes under the redactor with a fresh salt (which catches a real name or address with the deny-list blank, as in
CI), and the whole stays under 300 kB. It also re-runs the pass over each slice (all three reproduce `findings.json`
byte for byte) and the full sample pass, and marks each example finding `same` or `differs` against it: 9 of 9 same.
The build is deterministic over LF text, so `test/site.test.ts` and the CI step `npm run site && git diff
--exit-code -- docs` hold the committed `docs/` to the build. The footer says what the page is: a replay of recorded,
redacted real collections of 24 Oct 2026 from two production Linux hosts and six Cloudflare zones with their audit
log, pseudonymised under the tenant's salt, which is withheld; nothing on it is authored.

GitHub Pages is not configured, because the repository is private. Once it is public: Settings, Pages, Source "Deploy
from a branch", branch `main`, folder `/docs`, save; `docs/.nojekyll` is already there so the data files are served
as committed. Until then, serve the folder locally (`python -m http.server -d docs`, then `http://localhost:8000/`):
opened from `file://` the browser will not load `data/*.json`, and the page says so.

## Redaction

`src/redactor.ts` runs before anything is persisted: collected text, vendor JSON, trace detail. The agent stores
`value_hash` plus `value_redacted`; raw values are never stored. Five passes in order: secrets (PEM blocks, Bearer
tokens, `key=value` with a secret-naming key, Cloudflare and AWS and `nvapi-`/`rt-` tokens, and long hex or base64
runs only when a key-like word is within 64 characters before them on the same line, so value hashes, restic ids and
etckeeper commits stay data) become `<secret:KIND:8hex>`; addresses become `ip-XXXXXX` with CIDR suffix kept;
`/home/<u>`, `/Users/<u>` and mail addresses become `user-XXXXXX` and `mail-XXXXXX@domain-XXXXXX` with the same
hash for the same login; FQDNs become `host-XXXXXX.<tld>`, with a file-extension blacklist so `nginx.conf` is not a
host; the tenant's own labels (`REDACT_WORDS`, per tenant, because the collectors cannot know them) become
`word-XXXXXX` wherever they stand alone. RFC 5737 and 3849 documentation ranges, loopback, the unspecified address
and `.invalid`/`.example`/`.test`/`.localhost`/`example.com|net|org` pass through, so fixtures stay readable. The
agent's own dotted vocabulary, which trace lines carry next to real names, is left alone too: a dotted key path
(`server.location./.proxy_pass`), a SQL alias reference (`o.host`, `e2.actor`) and a tail that is a collection
surface, an nginx block or directive name, the `observation` table or a USL name (`linux.nginx`, `server.listen`,
`DRIFT.observation`, `lightning.metastore.drift`); none of those tails is a TLD a client runs under.

Two shapes the host pass misses were measured on the real estate and are closed in the collectors: a wildcard
(`*.name.tld`; the pass refuses a name that follows a dot), and a name glued to a suffix or a dotted tail
(`name.com_ecc` from acme.sh, `name.com-0001` from certbot, `name.com.conf.<date>.bak`); the Linux collector's
sweep and the Cloudflare collector's star shim give both the same pseudonym the bare name gets.

Pseudonyms are 6 hex: 100 addresses collide with probability 0.03%, 500 with 0.7%; at 4 hex 100 addresses collide
about 7%, which the hero query's join on address cannot tolerate. The salt is `REDACT_SALT`: one salt per tenant
makes every fixture of that tenant linkable, a different salt makes a published fixture unlinkable without it. Blank,
each process draws a random one, and both collectors refuse to write with a blank salt, because rows no other run can
join are worthless to the cross-source queries. Redacting redacted text is a no-op. Parsed JSON goes through
`json()`, which keeps keys and treats any string under a secret-naming key as a secret whatever its shape. Trace
`input_summary`, `output_summary` and `detail` go through the same redactor, so a trace line carries the
pseudonyms the observations carry.

Measured: a synthetic 200-vhost `nginx -T` dump (101,974 chars, 2,800 lines) redacts in 9.9 ms with exactly the
expected 600 host and 400 address replacements.

## Limitations

Today's facts, to be updated as the eval lands:

- One collection, one pass. The recorded bundle holds one run per surface and host, so the hero classes (`found_but_different`, `dns_change`) have no previous run to compare against on the real estate and did not fire; the authored fixture carries that story for the tests. The next collection gives the real one.
- The pass runs no model: Lightning does not choose checks (the default policy per class does), Ultra does not judge, and HOLD is never issued. `judgeClaim`, the receipt gate and the custody rule are tested against stubs, two real receipts and receipts signed with a throwaway key, not against a live pass. Unverified live: whether the runtime accepts a `meterless-app` value with a colon (`drift-agent:<tenant>`) and echoes it in `receipt.app`, and whether `prompt_preview` previews the system message or the last user message (both real receipts were single-message calls). Custody rests on `request_id` alone, which the preview can refute but never establish: a preview of the system message is `uninformative` and changes nothing, so a replay of our own earlier receipt and id is caught only when the runtime previews the user message (the nonce line); a preview in a shape we have not seen (neither message) is a `mismatch` and fails every call closed until measured.
- `verifyReceipt` trusts the public key embedded in each receipt (`pubkey_b64`), so a receipt forged with a fresh key passes the signature check; the custody tests build their fixtures exactly that way. Both real receipts carry the same runtime key; pinning it (an expected key in config, compared in the gate) would close this. Custody does not.
- Pre-flight simulates over the world as last collected: a `when` in a proposal is carried into the verdict, not used to rewind the rows, which is why the replay of the 16 April body is GO with zero delta. Staging the "as of 21:11" act needs a pre-state (an overlay setting `proxied` 0 before the proposal) or a two-field replay (content plus proxied, the full 21:12 body), and the single-field `ProposedChange` expresses neither. Live parity of overlaid queries on Zetaris (the derived table as a FROM/JOIN subquery with an alias) is unmeasured: the shape avoids the two pushdown faults below, and `test/parity.test.ts` has no overlaid case yet.
- The stop rule ships with every template marked as informing the next action, so on the recorded bundle it skips nothing; marking templates `false` is the operator's decision, and `test/pipeline.test.ts` pins the check lists the default table yields.
- The exposure SQL lives in `src/engine/world.ts` beside the edge it writes, not in `src/data/queries.ts`, and has not run on Zetaris; it uses only constructs the parity test already covers plus `NOT LIKE` and `action <> 'view'`. `LIKE` is case-insensitive on sql.js and case-sensitive on Spark; the bodies are lowercase JSON and lowercase pseudonyms, so the two agree on this bundle. The exposure edge's target is the record as observed over one span (`<record>@<since>..<until>`, whose attrs name the plain record), not the plain record entity the addendum names: the vendored reference closes an open edge only when a new edge of the same (from, type, context) points at a different target. Re-running an older measurement after a newer one into the same persistent world does not reopen it; pass worlds are in memory today.
- Technician memory holds nothing committed: the pass asks no question yet, so `answered()` is exercised by tests only, and an exception applies by exact scope key, so one on a host silences every finding of that class on that host until it expires. The H-MEM ledger grows by one `read` per recall hit per pass; the reference's sleep cycle is the maintenance path and is not wired.
- `changed_since_backup` and `drift_vs_approved` have templates and default policies but no detector, and `approved_setting` is empty: no technician has signed anything off, and `scripts/approve.ts` does not exist yet.
- A `dns_name` resolves through its A and AAAA records only; the survey follows a CNAME one level. A longer chain is not followed.
- After redaction the pseudonym of a name says nothing about its zone, so a wildcard record is matched to a vhost only through the collector's `.zone` sibling (the name's last two labels), which is right for every zone of this estate and wrong for a public-suffix zone such as `co.uk`. A proxied wildcard's `real_ip` check is therefore host-wide, not per block.
- `orphan_vhost` reports a name with no record in the collected zones; a name whose DNS lives outside the collected Cloudflare account is reported too (two of the three on the sites-enabled host are one such domain).
- Zetaris pushdown: a function inside a top-level WHERE on a `DRIFT` table is dropped and every row comes back (measured: `WHERE length(value_redacted) > 2048` counted all 1,068 rows, as did `WHERE setting_path = 'file' AND length(...) > 2048`). The catalogue's top-level predicates are plain column comparisons; its `substr`/`instr` sit in JOIN ON and correlated subqueries, which Spark evaluates itself, and the parity test is the guard. A correlated reference inside a subquery's JOIN ON is refused outright (`UNSUPPORTED_SUBQUERY_EXPRESSION_CATEGORY.CORRELATED_REFERENCE`), so every correlation sits in the subquery's WHERE.
- The Zetaris setup is idempotent in its end state, not a strict no-op: on an already configured instance one of `REFRESH DATASOURCE TABLES`, `COMPILE USL IF NOT EXISTS` or a re-`ACTIVATE` drops the custom DQ rule, which step 13 registers again (measured on both runs of the day: `LIST DQ USL` lists 6 rules mid-run and 7 after). Not bisected; each bisection is a live run.
- Actor attribution comes from audit logs and is reported unattributed when the log has none; the agent does not infer who changed something. API-token actors have no email and are unattributed by design. The Cloudflare account's audit log begins 2026-03-20, so records created before that have no history and fail `actor_attributed` and `previous_value_recoverable`.
- Each Cloudflare collection adds its own reads to the audit log as `view` events, so `audit_event` grows by about a hundred rows per pass.
- Every TLS vhost on both hosts includes certbot's `/etc/letsencrypt/options-ssl-nginx.conf`, outside `/etc/nginx`, which the collector records as unresolved rather than fetching.
- One zone's Cloudflare Origin certificate, valid only while the zone is proxied, is a real case the collectors do not surface: nothing reads certificate contents yet.
- A trace line's setting path ending in an nginx directive outside the redactor's skip set is over-redacted in the trace text only; the stored observation keeps it.
- Nothing here is production-ready: one tenant, one pass, in-memory World Model, no scheduler, no notification.

## Decisions

Appended as spikes settle. Newest last.

- 2026-10-23: TypeScript on Node 22+ ESM, run with tsx, tested with vitest. The dev machine runs Node 26; `engines` says `>=22`.
- 2026-10-23: `.env` loads through `process.loadEnvFile` (built into Node), so no dotenv dependency.
- 2026-10-23: Nightshift measured live. Explicit `nvidia/*` ids are honoured and named in the receipt; `meterless/fast|deep|judge` all route to the race lane first, so the app requests models by id. Lightning on the free tier returns `empty_response` (502) on about 1 in 4 raw calls (2 of 8 measured); one retry recovered every case, so the adapter retries once and the agent falls back deterministically after that. Ultra answers in 2 to 4 s and puts its reasoning in `content` terminated by `</think>`, with the JSON after it; `extractJson` strips through the last `</think>` first. All 30 runtime receipts verified offline (Ed25519 over the compact key-sorted body). `GET /v1/jobs/{id}/events` is a live SSE stream; failed turns appear there with `ok:false` and no receipt.
- 2026-10-23: World Model reference writes `assertFact` values onto `entity.attrs` only in live state; snapshots replay facts but not attrs. Our `fingerprintAt` therefore reads the latest `fingerprint` fact at or before the time, not attrs. Vendor untouched; conformance 8/8 through `src/engine/world.ts`.
- 2026-10-23: Zetaris REST shape is `{headers, data, total, timeUsed}`, every value a string. The normaliser is written to that. Nemotron is also served through Nightshift via OpenRouter: measured 12/12 at 1 to 2 s median against NVIDIA's free endpoint at 4/6 and 7.5 s, so the primary routes are `openrouter/nvidia/nemotron-*` and the adapter walks a failover ladder (cloud paid, cloud free, local) with every hop receipted and traced as `fallback`.
- 2026-10-23: Zetaris access is denied by default per object. The first API key authenticated for org 1 and ran `SELECT 1` but saw zero Lightning databases over both the direct REST and UI-proxy routes, so the agent's key needs either an administrator's key or a General-role user with explicit SELECT grants on the registered sources. Spike A was blocked on that grant, not on the client; an admin-role key was issued on 24 Oct. (The General-role alternative is withdrawn by the 24 Oct entry on keys below: only an admin can generate a key, and a key is the tenant's, not a user's.)
- 2026-10-23: Schema and portability. One DDL (`sql/schema.sql`, eight tables) portable across SQLite and the Postgres registered in Zetaris: ISO 8601 UTC text timestamps, INTEGER 0/1 for flags, no SERIAL, no JSON columns. Catalogue SQL stays in the portable subset (lowercase unquoted identifiers, `'` doubled, no casts, no ILIKE, no date functions, no booleans, one statement, no semicolon) and names tables `{{t:x}}` and parameters `{{p:x}}`; the DataLayer renders both per engine and parameters become escaped literals, because Zetaris REST takes one SQL string and binds nothing. Both engines normalise to Zetaris's shape (strings, NULL as `""`) so `test/parity.test.ts` compares rows. The DQ gate fails a run with NULL `expected_count` or `observed_count`, not only a short or partial one: a run that never asserted its population cannot show it collected everything.
- 2026-10-23: sql.js for SAMPLE_MODE. SQLite in WebAssembly, in memory, initialised once per process, the schema applied and `sample/bundle.json` loaded by column order from the DDL. Chosen over a Postgres container because a judge's clean clone and CI must run the real pass with nothing installed; the parity test is what keeps it honest against Zetaris.
- 2026-10-23: A catalogue instead of model-written SQL. Lightning picks template ids and fills typed parameters; nothing it says becomes SQL. The one model that writes SQL is the judge, and its SELECT goes through `guardRefutation` and `assertSelectOnly` and is run by us; a reply that is not one guarded SELECT is `invalid_output` and counted. `defaultSelection(class)` is the fallback policy and what the pass runs with no model. HOLD is never issued without a judge.
- 2026-10-23: The receipt is a gate, not decoration. `GET /v1/meterless/receipts` on the local Nightshift returned 53 receipts, 53/53 verify offline; 35 are successful turns with `receipt_id`, `routing`, `phases` and `winning_route`, 18 are failed turns with no `receipt_id`. On every successful receipt the served model appears in `phases[0].model` (one phase, `final_synthesis`), `routing.winner` and `winning_route.model`, and all three agree; the tier field is the letter `A` for Lightning routes and `C` for Ultra routes, so the gate derives the tier from the model id. `receipt.requested_mode` is `meterless/auto` and `app_policy.requested_mode` is `auto` on every receipt, explicit-id calls included, so the requested tier comes from the caller. A judge verdict counts only when the gate says an Ultra answered; substitution is `not_judged` and escalates. Fixtures `test/fixtures/receipt-lightning.json` (`rcpt_req_szybz3wr`, 942 ms phase) and `receipt-ultra.json` (`rcpt_req_iger5raz`, 880 ms phase) are real, untouched and verify.
- 2026-10-23: `chat_template_kwargs.enable_thinking` is sent by the adapter when a caller sets it but has no observable effect through the OpenRouter routes. `probe:thinking`, one run, 12/12 calls ok with 0 adapter retries: Lightning `tokens_out` 11 on all 6 calls (false 669/693/375 ms, true 310/633/401 ms); Ultra `tokens_out` 71/70/71 with false and 71/75/71 with true (false 1723/1807/1610 ms, true 1274/1554/2125 ms); `</think>` present in 0/12 replies; `extractJson` returned the correct `{ok:true,sum:42}` on 12/12. VERDICT: NO, Nightshift does not observably forward the flag on either OpenRouter route. One follow-up call (`scripts/probe-ultra-shape.ts`) on the OpenRouter Ultra route: message keys `[role, content]`, `finish_reason` stop, 101 tokens out for the 35-character JSON answer, no reasoning field, no `</think>`; the reasoning is billed but not returned there, unlike the `nvidia/` direct route measured earlier (reasoning in `content` before `</think>`). `extractJson` handles both. The judge requests `enable_thinking` true regardless: harmless here, honoured wherever the flag is forwarded, and its `max_tokens` (4096) is sized for a route that honours it, so the JSON after the reasoning is not cut off.
- 2026-10-23: No read-only SSH; `ops/` is the honest substitute. A forced command bound to a dedicated user's key and one sudoers line, reviewed by eye and `sh -n`, not installed; `.gitattributes` pins `ops/ssh/*` and `ops/sudoers/*` to LF so a Windows checkout cannot break `#!/bin/sh`. Rewritten on 24 Oct to the measured hosts (below).
- 2026-10-23: Redaction before persistence, 6-hex pseudonyms, salt in `REDACT_SALT`. Trace `detail` goes through the same redactor as collected data, so trace lines and stored observations share pseudonyms within a run.
- 2026-10-23: `sample/observations.json` (the earlier hand-written probes) is removed; SAMPLE_MODE runs the pass over `sample/bundle.json` through the data layer and the World Model. The Zetaris shape probe no longer names the vendor's demo datasets.
- 2026-10-23: Spike A needs registration rights (`CREATE`/`DROP LIGHTNING DATABASE`) that the agent's General-role key should not hold, so `npm run smoke` runs the read-only half (`SELECT 1`, `SHOW LIGHTNING DATABASES`) and the registration probe sits behind `--register`. The spike's DDL goes through the raw adapter; the agent's own query path is SELECT-only through `DataLayer.run` and `assertSelectOnly`, and nothing the agent runs can reach a DDL statement. (The General-role key is withdrawn by the 24 Oct entry on keys: the key is the tenant's admin-generated key; only an admin can generate one, and it is tenant-scoped, not a user's. The read-only default and the `--register` gate stand.)
- 2026-10-24: Two adversarial reviews applied. The hero, resolution and `dns_target_in_inventory` queries join A and AAAA records only (a TXT or CNAME on the name is not an address and was a finding on every pass); the receipt gate needs a found, verified receipt, so an unreceipted response is `not_judged`, and a receipt lookup that fails is `not_judged` instead of a throw; a host run pairs with a DNS run only within six hours, so a gated DNS run is named in the trace instead of a stale one standing in; the SQL guards strip literals before the semicolon check (a DMARC `;` in a parameter no longer aborts the pass) and refuse double quotes; a refused check is one recorded rejection, not a dead pass; each hero row carries its own DNS record; the DQ gate counts stored rows for host surfaces; every query has a total ORDER BY; the tracer redacts every free-text field and stamps `model_requested: none` on a sample pass; the sql.js loader refuses non-canonical timestamps.
- 2026-10-24: The app Postgres (`drift-pg`) lives on the Zetaris Docker network, not behind `host.docker.internal`, which does not resolve in the driver container. `DATABASE_URL` is how this machine reaches it (`127.0.0.1:15432`); `ZETARIS_PG_HOST` (`drift-pg`, port 5432) is how Zetaris does. The datasource is `CREATE DATASOURCE DRIFT ... OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://drift-pg:5432/drift", ...)` then `REGISTER DATASOURCE TABLES FROM DRIFT`; tables are `DRIFT.<table>`.
- 2026-10-24: USL DDL reserved words. The validator rejects a column named `source` and a table named `reference` with one generic message, so the USL has `source_kind` and `referent`. `COMPILE USL ... DDL` is the one request that carries several `CREATE TABLE` blocks separated by `;`; the adapter's `allowMultiStatement` is honoured for it alone and refused before anything is sent otherwise. `RUN DQ TABLE` returns `name | table | type | total_record | valid_record | invalid_record` with the custom rule and the key constraints as rows (`run_complete` 4/4/0 on the recorded runs); `SHOW DQ INVALID RECORD <rule> TABLE <t>` lists the failing rows.
- 2026-10-24: Cloudflare audit log shape. `GET /accounts/{id}/logs/audit?since&before&limit=1000&direction=asc[&cursor]`, both dates required and inside the last 18 months, `result_info` is `{count, cursor}` with no total and the cursor absent on the last page. A record update is `resource.product dns_records`, `type null`, `resource.id` the record id, `resource.request` the body; a system create or delete is `product dns`, `type record`, `resource.value` the record, whose `value.id` is the record id (`resource.id` equals it in 59 of 113 creates, a uuid or null in the rest). No event carries old and new values; the previous state of a record is the latest earlier create or update on its id, which is the reconstruction rule `previousState` and the `previous_value_recoverable` template now implement, and `record_reverted` reads a log without old values the same way. A delete's `resource.value` goes to `old_value`. `action.time` comes with 0 to 3 fractional digits and is normalised to milliseconds. `event_id` is `rows.ts eventId(tenant, 'cloudflare', id)` so overlapping pulls dedupe in the Store.
- 2026-10-24: The first real collection. Postgres truncated of the hand-authored rows (kept as `test/fixtures/authored-bundle.json` for the hero tests), then `collect:cloudflare`, `collect:linux` for each of the two hosts, all four runs complete: `collection_run` 4, `observation` 1,068, `backup_snapshot` 18, `backup_item` 85, `dns_record` 58, `audit_event` 714, `inventory_asset` 9, `approved_setting` 0. The survey over them, through Zetaris and sql.js alike: `www.<zone>` (`host-524b42.quest`) is a proxied CNAME to a direct apex, flipped proxied off then on by a named actor and re-pointed by an API token on 2026-04-16; the proxied wildcard `*.host-503b27.ai` lands on the conf.d host, where no block and not the http level trusts a Cloudflare range (19 more proxied names sit on blocks without a list across both hosts; the one block with `set_real_ip_from`, 22 ranges, is the .com apex on the sites-enabled host); three records land on a host with no enabled block naming them (`host-3fef97.club` on the conf.d host, `host-50b116.com` and `host-c10fff.com` on the sites-enabled host); one vhost file on disk (`host-085e02.com`) and one enabled vhost with two names have no record in the collected zones. 0 hero findings, as expected of a first run. The tenant's zone and product labels survived passes a-d of the redactor in file, timer and folder names, so the redactor gained a label pass (`REDACT_WORDS`) and the hosts were re-collected; a probe of every stored table for the zone labels, both public addresses and the WireGuard range found 0 matches (the company and product labels were not in that probe; see the next entry).
- 2026-10-24: Two adversarial reviews of the collectors and the exported bundle, applied, and the estate re-collected at 07:58 UTC under a neutral tenant id. Fatal: every non-file `value_hash` was the plain sha256 of the value, so 138 guesses built from the six public zone names matched 194 stored hashes and confirmed 19 plaintexts behind their pseudonyms; it is now `Redactor.fingerprint`, HMAC-SHA256 under `REDACT_SALT` (`file` rows keep the plain hash, because theirs must equal the tarball copy's). The company and product labels (53 and 20 rows, in `/var/www/<product>` paths, a timer unit and two comments) survived into the bundle because they were not in `REDACT_WORDS`; the list now carries them, labels are documented as configuration, `export:bundle` refuses a file in which any configured label still stands alone, and `test/leak.test.ts` probes the tree with the operator's list. One example directory was named after the zone it pseudonymised (`proxy-split` now); a test used a production WireGuard address and brand-derived names as inputs (synthetic now); the collector source named a production login's home path (`LINUX_HOSTS` in `.env` now, alias=export dir, and the aliases themselves are read from there). Major: the tarball's symlink members hashed as the empty input, so every enabled site on the sites-enabled host read as changed since backup (regular-file members only now; a member hashed as the empty input is dropped and listed); an unreadable `nginx.conf` left a run complete with every `.enabled` unknown (partial now, with `http.real_ip` = `unknown`); the DQ gate withheld nothing from the audit log, whose rows carry no `run_id` (the audit templates are now rejected per tenant when the latest audit run fails the gate); the README claimed any unreadable path made a run partial (it does not, and the README now says exactly when a run is partial). Minor: the include round fetched `sites-enabled` symlinks as a second `file` row per enabled vhost (307 rows on that host, 301 now); a trailing-dot `server_name` or `proxy_pass` host never joined its record; a failed insert left a run `running`; an `inventory_asset` upsert never moved an address to its new host; the inventory was IPv4-only (10 addresses now, one IPv6); `credential_shaped` was case-sensitive in the shell; a stray `}` or an unterminated string silently truncated a file's parse (`malformed` now). Re-collected: `observation` 1,062, `backup_item` 76, `audit_event` 728 (the first pass's own reads), `inventory_asset` 10, `collection_run` 4, the same 27 survey findings, `npm run zetaris:queries` over the new rows: hero 0 and 0, `proxy_split` 1, `proxied_without_real_ip` 10 + 1 wildcard and 9, `orphan_record` 1 and 2, `orphan_vhost` 0 and 3, `SHOW DQ INVALID RECORD run_complete` 0 rows.
- 2026-10-24: Two Zetaris pushdown facts, measured on 2.4.3.1 over the `DRIFT` datasource and recorded under Limitations: a function in a top-level WHERE drops the whole predicate, and a correlated reference in a subquery's JOIN ON is refused. The survey SQL was written around both and `PARITY_LIVE` shows 76/76 cases equal.
- 2026-10-24: The USL names (`lightning.metastore.drift`, `collection`, `setting`, `referent`) joined the redactor's dotted vocabulary so trace lines keep them; none is a TLD a client runs under.
- 2026-10-24: Zetaris API keys are generated by admin users only and are tenant-scoped, not user-scoped: one key per tenant, the one `ZETARIS_API_KEY` holds. The agent does not get a less-privileged key of its own; what limits it is its own query path (SELECT-only through `DataLayer.run` and `assertSelectOnly`), and `npm run zetaris:setup` is the one place DDL goes through the raw adapter.
- 2026-10-24: Pre-flight (design addendum item 1) as a derived table, not a scenario row. `{{t:table}}` renders as `(SELECT ... CASE ... END AS <column> ... FROM table) alias` for one call; the DataLayer gained one additive option (`overlays`, `withOverlays`) and guards every body at construction. The whole existing pass runs in the simulated world through the same layer, so the verdict is the pass's own findings compared by key, and a real pass before and after is byte-identical. Four committed proposals: GO (removes 3), GO with zero delta (the 16 April body is the state in force; recorded honestly, not adjusted), GO (removes 2), NO-GO (adds two `dns_change`); GO-IF in the tests (29 -> 26 in one `add_real_ip_block`, which also clears the host-wide wildcard finding). Trace actions are mapped onto the existing union (`triage` for parse and bind, `observe` for the overlay delta, `detect` for a simulation, `hypothesise` for a prerequisite, `critique` for the falsifier) with the step name in `input_summary`; the loop bound is three.
- 2026-10-24: The stop rule and the withdraw rule (addendum item 2), code only. `INFORMS_NEXT_ACTION` ships all `true`, so the settled-verdict skip changes nothing on the bundle by design; the literal rule would skip 18 checks there and flip 0 verbs (measured, `test/stoprule.test.ts`). A gated audit run records every queued audit check at once as not checked (24 stops, 49 gated) with the verbs of the rule switched off. The judge is withheld, never retargeted: "verdict cannot move" or "claim withdrawn by its own checks", with `critique` and `revise` lines on a withdrawal. Counters live in the trace on the agents the pass already had (checker, decider, judge), so a reader keyed on agent names sees nothing new.
- 2026-10-24: The exposure line (addendum item 4) is three SELECTs in the portable subset plus TypeScript arithmetic, never a SQL date function. 190 days on the 16 April record, exact; 8 of 24 record findings dated. The World Model edge's target is the record as observed over one span, a deviation from the addendum's plain record forced by the vendored fold rule; recorded under Limitations.
- 2026-10-24: H-MEM vendored as the second load-bearing Meterless engine (`vendor/hmem/`, same commit as the World Model, Apache-2.0, declared in `PREEXISTING.md`), 13/13 through `src/engine/memory.ts`, and `TechnicianMemory` built on it: answers and accepted exceptions with tenant, scope key, expiry and provenance, recalled by exact key, lapsed lessons returned flagged and never applied, free text redacted before storage. The design addendum deferred H-MEM for fear of confusing it with the runtime's injected `hmem` context; the task overrode the deferral, and the README says in two places which is which. The Decider now recalls before deciding: exception in force -> ADOPT with the expiry on the finding and no judge call; lapsed -> ESCALATE "exception lapsed". `npm run answer` records and withdraws lessons under `.world/memory` (gitignored), so the committed state holds none; measured on 24 Oct as the Technician memory section records.
- 2026-10-24: Receipt custody (addendum item 3, scoped to identity and attribution). `checkCustody` after the signature: `request_id` equals the response id, or, only when one side has no id, `prompt_preview` is a prefix of a message we sent (this fallback was withdrawn the same night: see the review entry below); `app` equals the per-tenant id `drift-agent:<tenant>`. `gateWithCustody` discards an answer whose receipt is not ours, retries once with a fresh nonce, fails closed on the second. The judge now gates before it reads the reply (a discarded answer is never a hypothesis); without a tenant it behaves as before. Not gated: injected context, cache hits, redaction spans; `cache.status` is carried for the eval. The Saturday 10-minute live probe was not run; no Nightshift call was made on 24 Oct.
- 2026-10-24: The replay page is built from the committed examples only and refuses to publish anything it cannot re-run to the recorded numbers; the committed `docs/` is held to the build by a test and a CI step. Pages stays unconfigured until the repository is public. Every finding now carries a short stable id (`fnd-` plus 16 hex of the World Model's finding id), printed by the sample pass and shown on the page, so a technician can name one to `npm run answer`.
- 2026-10-24: Integration of the four parallel builds. `test/pipeline.test.ts` counts 43, 29 and 160 traced queries where it counted 39, 27 and 126: the exposure line's SQL is traced like every other step. The wildcard example's slice now carries the audit run and its (zero) events on the wildcard record, so its two audit checks run and fail as they do in the full pass instead of being withheld for a missing run, and all 9 example findings match the full sample pass. `examples/` and `docs/` were regenerated with the exposure line and the finding ids. CI runs `conformance:hmem` and `site` with `git diff --exit-code -- docs`.
- 2026-10-24: Two adversarial reviews of the night's work, applied. Major: the exposure bound upgraded `at_least` to `exact` on any earlier audit body, one that never named the field included (a reviewer's probe: one content-only edit on `host-f324df.com` flipped its line to "exact" with the onset still unknown); the earlier-body count is now field-aware (a body must name the field and set another value, or delete the record), an `old_value` already in the state keeps the bound, and the recorded bundle's eight lines are unchanged (the www and `host-18efce.ai` "exact" rest on real `proxied:false` bodies). Custody failed open when the response carried no id: a replayed receipt of ours passed on a preview of the shared system prompt; identity now rests on `request_id` alone, a side with no id fails closed, and the preview is secondary (user message only, through the nonce line; a system-prompt preview is `uninformative`; a prefix of nothing we sent is a `mismatch` that refutes a matching id). Minor: the GO-IF judge targets the finding the last prerequisite cleared (true in the simulation it was bound in), not a removed baseline finding, and the trace names the target; `judge.target` is on the verdict and the four verdict files were regenerated; a tenant id that is not header-safe is `not_judged`, not a throw; `{{t:x}} AS o` renders one alias under an overlay; `npm run site` refuses a stale example by name unless `--allow-stale`; a scope key the redactor would replace is refused; `conformance:hmem` says it exercises the vendored reference and adds one check through `TechnicianMemory`; "live, Lightning would pick" is withdrawn (catalogue order in both modes); the General-role key wording and the "read-only SSH" status row carry the same qualifications as the body. Open: `test/leak.test.ts` does not scan `docs/` (on the do-not-touch list tonight).
