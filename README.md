# drift-agent

Config-drift assurance for MSP technicians. Three questions, asked of real servers and real DNS:

1. What changed since the last backup?
2. Would a restore regress anything?
3. Where does this system drift from golden, including FOUND-BUT-DIFFERENT: a reference that is byte-identical
   while the thing it points at has changed.

Each finding ends in one verb: ADOPT, HOLD (with an expiry) or ESCALATE. The agent is read-only. It never enforces.

Entry for the GenAI Works Open Agent Hackathon 2026, Track 1 (Solving Fragmented Intelligence).

## Status

The collectors ran against the real estate on 24 Oct 2026 (two production hosts over read-only SSH, one
Cloudflare account), the rows went through the redactor into the app Postgres, Zetaris reads that Postgres
as the `DRIFT` datasource, and `sample/bundle.json` is the export of those rows. The pass runs over them
with no model; the hero query and the survey queries run through Zetaris itself.

| Command | Proves |
|---|---|
| `SAMPLE_MODE=true npm run sample` | The whole pass over `sample/bundle.json`: DQ gate, World Model, hero query, estate survey, precondition catalogue, disposition. No credentials, no model, every step a trace line. Measured 24 Oct on the recorded bundle (the 07:58 UTC re-collection): 4 collection runs, 0 gated out, 1,062 observations recorded, 126 SQL queries, 328 trace lines (328 carry `model_requested: none`), 27 findings (1 `proxy_split`, 20 `proxied_without_real_ip`, 3 `orphan_record`, 3 `orphan_vhost`; 5 ADOPT, 22 ESCALATE), 0 hero findings (every name a vhost serves lands on an inventory host), 1.5 s warm including tsx start. |
| `npm test` | 16 files, 275 tests (38 more are the live Zetaris half of the parity test, skipped without `PARITY_LIVE=true`): data layer, parity, catalogue, selection, redactor, tracer, judge, receipt gate, World Model, the pass over both bundles, the nginx collector on redacted copies of both layouts, the Cloudflare collector on recorded shapes, the Store against a throwaway schema of the live Postgres, the Zetaris setup plan, and the deny-list probe over the tree (skipped with one line where the operator's label list is blank). |
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
npm run collect:cloudflare -- --tenant <id>            # live: Cloudflare DNS + audit log -> Postgres
npm run collect:linux -- --host <alias> --tenant <id>  # live: one read-only SSH session -> Postgres; <alias> is a LINUX_HOSTS entry
npm run zetaris:setup && npm run zetaris:queries -- --tenant <id>
npm run export:bundle                                  # Postgres -> sample/bundle.json, redacted once more
```

`npm run sample` prints the trace (one JSON line per step), one JSON object per finding and one summary line:

```
SAMPLE: 4 collection runs, 0 failed the DQ gate (none), 1062 observations in the World Model, 27 finding(s):
proxy_split cloudflare.dns bce1ca2b... proxied -> ESCALATE (3/4 preconditions hold, fails: referent_unchanged);
proxied_without_real_ip host-aa516a /etc/nginx/nginx.conf http.real_ip -> ESCALATE (2/4 preconditions hold, fails:
actor_attributed, previous_value_recoverable); ...; judge skipped (model: none)
```

Every step is appended to `logs/<run>.jsonl`; `logs/` is local and gitignored. In sample mode every line carries
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
| check | The default precondition policy for the class, bound from the finding and run through the catalogue. A parameter the finding cannot supply, or a check the SQL guard or the engine refuses, is a recorded rejection, not a guess: it escalates that one finding and the pass goes on. | `check` per template: id, row count, one sentence; `not_checked` for a rejection |
| decide | Every check holds and none was rejected: ADOPT, as a candidate. Anything else: ESCALATE. HOLD needs a judge to bound it with an expiry, so a pass with no model never issues it. | `decide`, `model: none` |
| judge | Not called in sample mode. | `judge`, status `skipped` |

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
- The pass runs no model: Lightning does not choose checks (the default policy per class does), Ultra does not judge, and HOLD is never issued. `judgeClaim` and the receipt gate are tested against stubs and two real receipts, not against a live pass.
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
- 2026-10-23: Zetaris access is denied by default per object. The first API key authenticated for org 1 and ran `SELECT 1` but saw zero Lightning databases over both the direct REST and UI-proxy routes, so the agent's key needs either an administrator's key or a General-role user with explicit SELECT grants on the registered sources. Spike A was blocked on that grant, not on the client; an admin-role key was issued on 24 Oct.
- 2026-10-23: Schema and portability. One DDL (`sql/schema.sql`, eight tables) portable across SQLite and the Postgres registered in Zetaris: ISO 8601 UTC text timestamps, INTEGER 0/1 for flags, no SERIAL, no JSON columns. Catalogue SQL stays in the portable subset (lowercase unquoted identifiers, `'` doubled, no casts, no ILIKE, no date functions, no booleans, one statement, no semicolon) and names tables `{{t:x}}` and parameters `{{p:x}}`; the DataLayer renders both per engine and parameters become escaped literals, because Zetaris REST takes one SQL string and binds nothing. Both engines normalise to Zetaris's shape (strings, NULL as `""`) so `test/parity.test.ts` compares rows. The DQ gate fails a run with NULL `expected_count` or `observed_count`, not only a short or partial one: a run that never asserted its population cannot show it collected everything.
- 2026-10-23: sql.js for SAMPLE_MODE. SQLite in WebAssembly, in memory, initialised once per process, the schema applied and `sample/bundle.json` loaded by column order from the DDL. Chosen over a Postgres container because a judge's clean clone and CI must run the real pass with nothing installed; the parity test is what keeps it honest against Zetaris.
- 2026-10-23: A catalogue instead of model-written SQL. Lightning picks template ids and fills typed parameters; nothing it says becomes SQL. The one model that writes SQL is the judge, and its SELECT goes through `guardRefutation` and `assertSelectOnly` and is run by us; a reply that is not one guarded SELECT is `invalid_output` and counted. `defaultSelection(class)` is the fallback policy and what the pass runs with no model. HOLD is never issued without a judge.
- 2026-10-23: The receipt is a gate, not decoration. `GET /v1/meterless/receipts` on the local Nightshift returned 53 receipts, 53/53 verify offline; 35 are successful turns with `receipt_id`, `routing`, `phases` and `winning_route`, 18 are failed turns with no `receipt_id`. On every successful receipt the served model appears in `phases[0].model` (one phase, `final_synthesis`), `routing.winner` and `winning_route.model`, and all three agree; the tier field is the letter `A` for Lightning routes and `C` for Ultra routes, so the gate derives the tier from the model id. `receipt.requested_mode` is `meterless/auto` and `app_policy.requested_mode` is `auto` on every receipt, explicit-id calls included, so the requested tier comes from the caller. A judge verdict counts only when the gate says an Ultra answered; substitution is `not_judged` and escalates. Fixtures `test/fixtures/receipt-lightning.json` (`rcpt_req_szybz3wr`, 942 ms phase) and `receipt-ultra.json` (`rcpt_req_iger5raz`, 880 ms phase) are real, untouched and verify.
- 2026-10-23: `chat_template_kwargs.enable_thinking` is sent by the adapter when a caller sets it but has no observable effect through the OpenRouter routes. `probe:thinking`, one run, 12/12 calls ok with 0 adapter retries: Lightning `tokens_out` 11 on all 6 calls (false 669/693/375 ms, true 310/633/401 ms); Ultra `tokens_out` 71/70/71 with false and 71/75/71 with true (false 1723/1807/1610 ms, true 1274/1554/2125 ms); `</think>` present in 0/12 replies; `extractJson` returned the correct `{ok:true,sum:42}` on 12/12. VERDICT: NO, Nightshift does not observably forward the flag on either OpenRouter route. One follow-up call (`scripts/probe-ultra-shape.ts`) on the OpenRouter Ultra route: message keys `[role, content]`, `finish_reason` stop, 101 tokens out for the 35-character JSON answer, no reasoning field, no `</think>`; the reasoning is billed but not returned there, unlike the `nvidia/` direct route measured earlier (reasoning in `content` before `</think>`). `extractJson` handles both. The judge requests `enable_thinking` true regardless: harmless here, honoured wherever the flag is forwarded, and its `max_tokens` (4096) is sized for a route that honours it, so the JSON after the reasoning is not cut off.
- 2026-10-23: No read-only SSH; `ops/` is the honest substitute. A forced command bound to a dedicated user's key and one sudoers line, reviewed by eye and `sh -n`, not installed; `.gitattributes` pins `ops/ssh/*` and `ops/sudoers/*` to LF so a Windows checkout cannot break `#!/bin/sh`. Rewritten on 24 Oct to the measured hosts (below).
- 2026-10-23: Redaction before persistence, 6-hex pseudonyms, salt in `REDACT_SALT`. Trace `detail` goes through the same redactor as collected data, so trace lines and stored observations share pseudonyms within a run.
- 2026-10-23: `sample/observations.json` (the earlier hand-written probes) is removed; SAMPLE_MODE runs the pass over `sample/bundle.json` through the data layer and the World Model. The Zetaris shape probe no longer names the vendor's demo datasets.
- 2026-10-23: Spike A needs registration rights (`CREATE`/`DROP LIGHTNING DATABASE`) that the agent's General-role key should not hold, so `npm run smoke` runs the read-only half (`SELECT 1`, `SHOW LIGHTNING DATABASES`) and the registration probe sits behind `--register`. The spike's DDL goes through the raw adapter; the agent's own query path is SELECT-only through `DataLayer.run` and `assertSelectOnly`, and nothing the agent runs can reach a DDL statement.
- 2026-10-24: Two adversarial reviews applied. The hero, resolution and `dns_target_in_inventory` queries join A and AAAA records only (a TXT or CNAME on the name is not an address and was a finding on every pass); the receipt gate needs a found, verified receipt, so an unreceipted response is `not_judged`, and a receipt lookup that fails is `not_judged` instead of a throw; a host run pairs with a DNS run only within six hours, so a gated DNS run is named in the trace instead of a stale one standing in; the SQL guards strip literals before the semicolon check (a DMARC `;` in a parameter no longer aborts the pass) and refuse double quotes; a refused check is one recorded rejection, not a dead pass; each hero row carries its own DNS record; the DQ gate counts stored rows for host surfaces; every query has a total ORDER BY; the tracer redacts every free-text field and stamps `model_requested: none` on a sample pass; the sql.js loader refuses non-canonical timestamps.
- 2026-10-24: The app Postgres (`drift-pg`) lives on the Zetaris Docker network, not behind `host.docker.internal`, which does not resolve in the driver container. `DATABASE_URL` is how this machine reaches it (`127.0.0.1:15432`); `ZETARIS_PG_HOST` (`drift-pg`, port 5432) is how Zetaris does. The datasource is `CREATE DATASOURCE DRIFT ... OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://drift-pg:5432/drift", ...)` then `REGISTER DATASOURCE TABLES FROM DRIFT`; tables are `DRIFT.<table>`.
- 2026-10-24: USL DDL reserved words. The validator rejects a column named `source` and a table named `reference` with one generic message, so the USL has `source_kind` and `referent`. `COMPILE USL ... DDL` is the one request that carries several `CREATE TABLE` blocks separated by `;`; the adapter's `allowMultiStatement` is honoured for it alone and refused before anything is sent otherwise. `RUN DQ TABLE` returns `name | table | type | total_record | valid_record | invalid_record` with the custom rule and the key constraints as rows (`run_complete` 4/4/0 on the recorded runs); `SHOW DQ INVALID RECORD <rule> TABLE <t>` lists the failing rows.
- 2026-10-24: Cloudflare audit log shape. `GET /accounts/{id}/logs/audit?since&before&limit=1000&direction=asc[&cursor]`, both dates required and inside the last 18 months, `result_info` is `{count, cursor}` with no total and the cursor absent on the last page. A record update is `resource.product dns_records`, `type null`, `resource.id` the record id, `resource.request` the body; a system create or delete is `product dns`, `type record`, `resource.value` the record, whose `value.id` is the record id (`resource.id` equals it in 59 of 113 creates, a uuid or null in the rest). No event carries old and new values; the previous state of a record is the latest earlier create or update on its id, which is the reconstruction rule `previousState` and the `previous_value_recoverable` template now implement, and `record_reverted` reads a log without old values the same way. A delete's `resource.value` goes to `old_value`. `action.time` comes with 0 to 3 fractional digits and is normalised to milliseconds. `event_id` is `rows.ts eventId(tenant, 'cloudflare', id)` so overlapping pulls dedupe in the Store.
- 2026-10-24: The first real collection. Postgres truncated of the hand-authored rows (kept as `test/fixtures/authored-bundle.json` for the hero tests), then `collect:cloudflare`, `collect:linux` for each of the two hosts, all four runs complete: `collection_run` 4, `observation` 1,068, `backup_snapshot` 18, `backup_item` 85, `dns_record` 58, `audit_event` 714, `inventory_asset` 9, `approved_setting` 0. The survey over them, through Zetaris and sql.js alike: `www.<zone>` (`host-524b42.quest`) is a proxied CNAME to a direct apex, flipped proxied off then on by a named actor and re-pointed by an API token on 2026-04-16; the proxied wildcard `*.host-503b27.ai` lands on the conf.d host, where no block and not the http level trusts a Cloudflare range (19 more proxied names sit on blocks without a list across both hosts; the one block with `set_real_ip_from`, 22 ranges, is the .com apex on the sites-enabled host); three records land on a host with no enabled block naming them (`host-3fef97.club` on the conf.d host, `host-50b116.com` and `host-c10fff.com` on the sites-enabled host); one vhost file on disk (`host-085e02.com`) and one enabled vhost with two names have no record in the collected zones. 0 hero findings, as expected of a first run. The tenant's zone and product labels survived passes a-d of the redactor in file, timer and folder names, so the redactor gained a label pass (`REDACT_WORDS`) and the hosts were re-collected; a probe of every stored table for the zone labels, both public addresses and the WireGuard range found 0 matches (the company and product labels were not in that probe; see the next entry).
- 2026-10-24: Two adversarial reviews of the collectors and the exported bundle, applied, and the estate re-collected at 07:58 UTC under a neutral tenant id. Fatal: every non-file `value_hash` was the plain sha256 of the value, so 138 guesses built from the six public zone names matched 194 stored hashes and confirmed 19 plaintexts behind their pseudonyms; it is now `Redactor.fingerprint`, HMAC-SHA256 under `REDACT_SALT` (`file` rows keep the plain hash, because theirs must equal the tarball copy's). The company and product labels (53 and 20 rows, in `/var/www/<product>` paths, a timer unit and two comments) survived into the bundle because they were not in `REDACT_WORDS`; the list now carries them, labels are documented as configuration, `export:bundle` refuses a file in which any configured label still stands alone, and `test/leak.test.ts` probes the tree with the operator's list. One example directory was named after the zone it pseudonymised (`proxy-split` now); a test used a production WireGuard address and brand-derived names as inputs (synthetic now); the collector source named a production login's home path (`LINUX_HOSTS` in `.env` now, alias=export dir, and the aliases themselves are read from there). Major: the tarball's symlink members hashed as the empty input, so every enabled site on the sites-enabled host read as changed since backup (regular-file members only now; a member hashed as the empty input is dropped and listed); an unreadable `nginx.conf` left a run complete with every `.enabled` unknown (partial now, with `http.real_ip` = `unknown`); the DQ gate withheld nothing from the audit log, whose rows carry no `run_id` (the audit templates are now rejected per tenant when the latest audit run fails the gate); the README claimed any unreadable path made a run partial (it does not, and the README now says exactly when a run is partial). Minor: the include round fetched `sites-enabled` symlinks as a second `file` row per enabled vhost (307 rows on that host, 301 now); a trailing-dot `server_name` or `proxy_pass` host never joined its record; a failed insert left a run `running`; an `inventory_asset` upsert never moved an address to its new host; the inventory was IPv4-only (10 addresses now, one IPv6); `credential_shaped` was case-sensitive in the shell; a stray `}` or an unterminated string silently truncated a file's parse (`malformed` now). Re-collected: `observation` 1,062, `backup_item` 76, `audit_event` 728 (the first pass's own reads), `inventory_asset` 10, `collection_run` 4, the same 27 survey findings, `npm run zetaris:queries` over the new rows: hero 0 and 0, `proxy_split` 1, `proxied_without_real_ip` 10 + 1 wildcard and 9, `orphan_record` 1 and 2, `orphan_vhost` 0 and 3, `SHOW DQ INVALID RECORD run_complete` 0 rows.
- 2026-10-24: Two Zetaris pushdown facts, measured on 2.4.3.1 over the `DRIFT` datasource and recorded under Limitations: a function in a top-level WHERE drops the whole predicate, and a correlated reference in a subquery's JOIN ON is refused. The survey SQL was written around both and `PARITY_LIVE` shows 76/76 cases equal.
- 2026-10-24: The USL names (`lightning.metastore.drift`, `collection`, `setting`, `referent`) joined the redactor's dotted vocabulary so trace lines keep them; none is a TLD a client runs under.
