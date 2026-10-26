# Configuration document: client-1

What the agent holds for client-1, read through one data layer (sql.js over sample/bundle.json) when this page is rendered. Every number is a count of the rows, or a value of a row, that the queries listed at the end return.

## Estate

61 collection runs on record, 61 passing the DQ gate. 2 hosts and 6 zones in the latest passing runs.

| surface | host | latest passing run | finished | objects | settings |
|---|---|---|---|---|---|
| cloudflare.dns | - | run-9d48791b00433777 | 2026-10-25T13:53:47.612Z | 58 | 290 |
| linux.nginx | host-4b4dc1 | run-28ad36002e466ed5 | 2026-10-25T13:53:56.039Z | 24 | 301 |
| linux.nginx | host-aa516a | run-f74b40064e093f2c | 2026-10-25T13:53:52.620Z | 34 | 761 |

- inventory addresses on host-4b4dc1: 2 in the latest run, 0 older rows kept
- inventory addresses on host-aa516a: 5 in the latest run, 3 older rows kept

| zone | records | proxied | direct |
|---|---|---|---|
| host-17a03d.info | 7 | 0 | 7 |
| host-1bf78f.club | 4 | 0 | 4 |
| host-4c795e.quest | 2 | 1 | 1 |
| host-503b27.ai | 20 | 4 | 16 |
| host-525a57.com | 23 | 17 | 6 |
| host-e49c58.cloud | 2 | 2 | 0 |

## Copies

112 vault copies at the latest commit of each repository, each with its latest validation:

| repository | commit | copies | ok | ok_with_gaps | fail | not validated |
|---|---|---|---|---|---|---|
| host-4b4dc1 (linux.nginx) | 6e1d81ce | 22 | 0 | 22 | 0 | 0 |
| host-aa516a (linux.nginx) | 321fcfe4 | 32 | 0 | 32 | 0 | 0 |
| records, zone host-17a03d.info | e296d52f | 7 | 7 | 0 | 0 | 0 |
| records, zone host-1bf78f.club | e296d52f | 4 | 4 | 0 | 0 | 0 |
| records, zone host-4c795e.quest | e296d52f | 2 | 2 | 0 | 0 | 0 |
| records, zone host-503b27.ai | e296d52f | 20 | 14 | 6 | 0 | 0 |
| records, zone host-525a57.com | e296d52f | 23 | 13 | 10 | 0 | 0 |
| records, zone host-e49c58.cloud | e296d52f | 2 | 2 | 0 | 0 | 0 |

The gaps the validations name, each a dependency a restore needs from outside the vault:

- host-4b4dc1 (linux.nginx): 13 gaps: /etc/letsencrypt/live/host-17a03d.info/fullchain.pem, /etc/letsencrypt/live/host-17a03d.info/privkey.pem, /etc/letsencrypt/live/host-4c795e.quest/fullchain.pem, /etc/letsencrypt/live/host-4c795e.quest/privkey.pem, /etc/letsencrypt/live/host-525a57.com/fullchain.pem, /etc/letsencrypt/live/host-525a57.com/privkey.pem, /etc/letsencrypt/live/host-9ac4f1.com/fullchain.pem, /etc/letsencrypt/live/host-9ac4f1.com/privkey.pem, /etc/letsencrypt/live/host-f324df.com/fullchain.pem, /etc/letsencrypt/live/host-f324df.com/privkey.pem, /etc/letsencrypt/options-ssl-nginx.conf, /etc/letsencrypt/ssl-dhparams.pem, /etc/nginx/snippets/word-9af24b-api-key.conf
- host-aa516a (linux.nginx): 16 gaps: /etc/letsencrypt/live/host-18efce.ai/fullchain.pem, /etc/letsencrypt/live/host-18efce.ai/privkey.pem, /etc/letsencrypt/live/host-492568.ai/fullchain.pem, /etc/letsencrypt/live/host-492568.ai/privkey.pem, /etc/letsencrypt/live/host-503b27.ai/fullchain.pem, /etc/letsencrypt/live/host-503b27.ai/privkey.pem, /etc/letsencrypt/live/host-a00d2f.ai/fullchain.pem, /etc/letsencrypt/live/host-a00d2f.ai/privkey.pem, /etc/letsencrypt/live/host-c907ae.ai/fullchain.pem, /etc/letsencrypt/live/host-c907ae.ai/privkey.pem, /etc/letsencrypt/live/host-c9c1ae.club/fullchain.pem, /etc/letsencrypt/live/host-c9c1ae.club/privkey.pem, /etc/letsencrypt/options-ssl-nginx.conf, /etc/letsencrypt/ssl-dhparams.pem, /etc/ssl/word-8173ec/origin.crt, /etc/ssl/word-8173ec/origin.key
- records, zone host-503b27.ai: 5 gaps: host-2a9e77.net, host-61d6c2.net, host-9e9da4.net, host-9eff2c.com, host-c0f047.net
- records, zone host-525a57.com: 2 gaps: host-4111e5.com, host-4f380d.com

## Approvals

333 settings have an approval of record, the latest of each:

| surface | host | objects approved | settings approved |
|---|---|---|---|
| cloudflare.dns | - | 58 | 290 |
| linux.nginx | host-4b4dc1 | 17 | 17 |
| linux.nginx | host-aa516a | 26 | 26 |

Locked settings without an approved value: 0.

## Findings open

27 findings are open on the latest passing runs: ADOPT 23, HOLD 3, ESCALATE 1.

| class | ADOPT | HOLD | ESCALATE | total |
|---|---|---|---|---|
| orphan_record | 0 | 3 | 0 | 3 |
| orphan_vhost | 3 | 0 | 0 | 3 |
| proxied_without_real_ip | 20 | 0 | 0 | 20 |
| proxy_split | 0 | 0 | 1 | 1 |

Drift from the approved values: 0 settings differ from their latest approval (drift_vs_approved), 0 approved settings are absent from their run (approved_missing).

The HOLDs expire:

- 2026-10-27T23:21:06.870Z: 3 (orphan_record 3)

Each open finding, by verb and class, with the reason its disposition records:

- fnd-3661fcc541693ada ADOPT orphan_vhost: server[host-9ac4f1.com:443].server_name[host-89f6e7.com] in /etc/nginx/sites-available/host-9ac4f1.com on host-4b4dc1 (linux.nginx, run run-28ad36002e466ed5), until 2026-11-30T00:00:00.000Z. accepted exception mem-4 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ESCALATE.
- fnd-51038b9539a0174a ADOPT orphan_vhost: server[host-085e02.com:443].server_name[host-085e02.com] in /etc/nginx/sites-available/host-085e02.com on host-4b4dc1 (linux.nginx, run run-28ad36002e466ed5), until 2026-11-30T00:00:00.000Z. accepted exception mem-8 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ADOPT.
- fnd-add52203af12de8a ADOPT orphan_vhost: server[host-9ac4f1.com:443].server_name[host-9ac4f1.com] in /etc/nginx/sites-available/host-9ac4f1.com on host-4b4dc1 (linux.nginx, run run-28ad36002e466ed5), until 2026-11-30T00:00:00.000Z. accepted exception mem-16 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ESCALATE.
- fnd-028260c299ff1cb0 ADOPT proxied_without_real_ip: server[host-f324df.com:80].real_ip in /etc/nginx/sites-available/host-f324df.com on host-4b4dc1 (linux.nginx, run run-28ad36002e466ed5), until 2026-11-30T00:00:00.000Z. accepted exception mem-1 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ESCALATE.
- fnd-05b163bfda4c027f ADOPT proxied_without_real_ip: server[host-e49c58.cloud:443].real_ip in /etc/nginx/conf.d/host-e49c58.cloud.conf on host-aa516a (linux.nginx, run run-f74b40064e093f2c), until 2026-11-30T00:00:00.000Z. accepted exception mem-2 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ESCALATE.
- fnd-2f1b5857f0426b68 ADOPT proxied_without_real_ip: server[host-4c795e.quest:443].real_ip in /etc/nginx/sites-available/host-4c795e.quest on host-4b4dc1 (linux.nginx, run run-28ad36002e466ed5), until 2026-11-30T00:00:00.000Z. accepted exception mem-3 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ADOPT.
- fnd-385949946c990113 ADOPT proxied_without_real_ip: server[host-e49c58.cloud:80].real_ip in /etc/nginx/conf.d/host-e49c58.cloud.conf on host-aa516a (linux.nginx, run run-f74b40064e093f2c), until 2026-11-30T00:00:00.000Z. accepted exception mem-5 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ESCALATE.
- fnd-4503aff67c556c58 ADOPT proxied_without_real_ip: server[host-62f7a4.com:443].real_ip in /etc/nginx/sites-available/host-62f7a4.com on host-4b4dc1 (linux.nginx, run run-28ad36002e466ed5), until 2026-11-30T00:00:00.000Z. accepted exception mem-6 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ESCALATE.
- fnd-45d5f3f4a2eb0b2e ADOPT proxied_without_real_ip: server[host-18efce.ai:443].real_ip in /etc/nginx/conf.d/word-005ed8-prod.conf on host-aa516a (linux.nginx, run run-f74b40064e093f2c), until 2026-11-30T00:00:00.000Z. accepted exception mem-7 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ADOPT.
- fnd-5bd1b4c03ee72c7a ADOPT proxied_without_real_ip: server[host-503b27.ai:80].real_ip in /etc/nginx/conf.d/host-503b27.ai.conf on host-aa516a (linux.nginx, run run-f74b40064e093f2c), until 2026-11-30T00:00:00.000Z. accepted exception mem-9 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ESCALATE.
- fnd-7548fb2a2e3cdca4 ADOPT proxied_without_real_ip: server[host-5c38db.com:80].real_ip in /etc/nginx/sites-available/host-525a57.com on host-4b4dc1 (linux.nginx, run run-28ad36002e466ed5), until 2026-11-30T00:00:00.000Z. accepted exception mem-10 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ESCALATE.
- fnd-770d13f327d54d12 ADOPT proxied_without_real_ip: server[host-525a57.com:80].real_ip in /etc/nginx/sites-available/host-525a57.com on host-4b4dc1 (linux.nginx, run run-28ad36002e466ed5), until 2026-11-30T00:00:00.000Z. accepted exception mem-11 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ESCALATE.
- fnd-8a843610aeb1b709 ADOPT proxied_without_real_ip: server[host-503b27.ai:80].real_ip in /etc/nginx/conf.d/host-503b27.ai.conf on host-aa516a (linux.nginx, run run-f74b40064e093f2c), until 2026-11-30T00:00:00.000Z. accepted exception mem-12 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ESCALATE.
- fnd-8fc350e6aa5840d1 ADOPT proxied_without_real_ip: server[host-e49c58.cloud:443].real_ip in /etc/nginx/conf.d/host-e49c58.cloud.conf on host-aa516a (linux.nginx, run run-f74b40064e093f2c), until 2026-11-30T00:00:00.000Z. accepted exception mem-5 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ESCALATE.
- fnd-9bfe1da7d028260c ADOPT proxied_without_real_ip: server[host-18efce.ai:80].real_ip in /etc/nginx/conf.d/word-005ed8-prod.conf on host-aa516a (linux.nginx, run run-f74b40064e093f2c), until 2026-11-30T00:00:00.000Z. accepted exception mem-7 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ADOPT.
- fnd-a08488f45ff63140 ADOPT proxied_without_real_ip: server[host-27618a.ai:443].real_ip in /etc/nginx/conf.d/host-503b27.ai.conf on host-aa516a (linux.nginx, run run-f74b40064e093f2c), until 2026-11-30T00:00:00.000Z. accepted exception mem-9 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ESCALATE.
- fnd-b0472de6319451c4 ADOPT proxied_without_real_ip: server[host-525a57.com:80].real_ip in /etc/nginx/sites-available/host-525a57.com on host-4b4dc1 (linux.nginx, run run-28ad36002e466ed5), until 2026-11-30T00:00:00.000Z. accepted exception mem-17 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ESCALATE.
- fnd-b3ea13c119d7b589 ADOPT proxied_without_real_ip: server[host-4c795e.quest:80].real_ip in /etc/nginx/sites-available/host-4c795e.quest on host-4b4dc1 (linux.nginx, run run-28ad36002e466ed5), until 2026-11-30T00:00:00.000Z. accepted exception mem-3 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ADOPT.
- fnd-b91b1690878eaf0e ADOPT proxied_without_real_ip: http.real_ip in /etc/nginx/nginx.conf on host-aa516a (linux.nginx, run run-f74b40064e093f2c), until 2026-11-30T00:00:00.000Z. accepted exception mem-19 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ESCALATE.
- fnd-d5622dbd2bf43e3e ADOPT proxied_without_real_ip: server[host-22b64a.com:443].real_ip in /etc/nginx/sites-available/host-525a57.com on host-4b4dc1 (linux.nginx, run run-28ad36002e466ed5), until 2026-11-30T00:00:00.000Z. accepted exception mem-17 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ESCALATE.
- fnd-de3c5e8ebdc2d209 ADOPT proxied_without_real_ip: server[host-f324df.com:443].real_ip in /etc/nginx/sites-available/host-f324df.com on host-4b4dc1 (linux.nginx, run run-28ad36002e466ed5), until 2026-11-30T00:00:00.000Z. accepted exception mem-1 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ESCALATE.
- fnd-dfe22fa267b51c91 ADOPT proxied_without_real_ip: server[host-503b27.ai:443].real_ip in /etc/nginx/conf.d/host-503b27.ai.conf on host-aa516a (linux.nginx, run run-f74b40064e093f2c), until 2026-11-30T00:00:00.000Z. accepted exception mem-12 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ESCALATE.
- fnd-f3bcb9860c5a0b3d ADOPT proxied_without_real_ip: server[host-e49c58.cloud:80].real_ip in /etc/nginx/conf.d/host-e49c58.cloud.conf on host-aa516a (linux.nginx, run run-f74b40064e093f2c), until 2026-11-30T00:00:00.000Z. accepted exception mem-2 holds until 2026-11-30T00:00:00.000Z (Personal estate, known and intentional: proxied names without real_ip and the leftover records are not a production risk.); the checks alone would say ESCALATE.
- fnd-58b251b5fce8fbff HOLD orphan_record: name in b0a17a719bd2118a535a763379ab7ba9 on host-4b4dc1 (cloudflare.dns, run run-9d48791b00433777), until 2026-10-27T23:21:06.870Z. rule rule-b8d9962485c3ced4 (normal) holds this orphan_record finding until 2026-10-27T23:21:06.870Z; held since 2026-10-25T13:54:08.785Z under rule rule-b8d9962485c3ced4.
- fnd-8fc67ccb1e4eebfa HOLD orphan_record: name in 25a23b5c40a3de0ea11b6054a7b54d07 on host-4b4dc1 (cloudflare.dns, run run-9d48791b00433777), until 2026-10-27T23:21:06.870Z. rule rule-b8d9962485c3ced4 (normal) holds this orphan_record finding until 2026-10-27T23:21:06.870Z; held since 2026-10-25T13:54:08.785Z under rule rule-b8d9962485c3ced4.
- fnd-d62857e241af66e2 HOLD orphan_record: name in c8b1963847dafe3548b1a4b93f520c0a on host-aa516a (cloudflare.dns, run run-9d48791b00433777), until 2026-10-27T23:21:06.870Z. rule rule-b8d9962485c3ced4 (normal) holds this orphan_record finding until 2026-10-27T23:21:06.870Z; held since 2026-10-25T13:54:08.785Z under rule rule-b8d9962485c3ced4.
- fnd-b4a40091cdb4f906 ESCALATE proxy_split: proxied in bce1ca2bb7caa2de9b6823d5f6ecd3f2 (cloudflare.dns, run run-9d48791b00433777). hold under rule rule-8e75e1d767980665 expired 2026-10-25T03:21:06.870Z; the finding stands.

### Why

Who or what changed each setting, from the hosts' journal, the provider's audit log and the agent's own actions (1 finding):

- fnd-b4a40091cdb4f906 ESCALATE proxy_split: No record of who changed it: the audit log window of 18 h holds 0 events for the record.

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
- audit log (`audit_event`): the provider's audit log, who changed which resource and when; and each host's journal of the last 24 h, the sudo commands that touch nginx and the logins, every login name pseudonymised.
- inventory (`inventory_asset`): the hosts' addresses.
- populations (`collection_run`): each source's own population, asserted before a row is read, and each run's status.

Two more sources decide what happens to a finding: the technician's memory store, which the Decider recalls from, and the policy file, which `npm run policy:load` turns into the `policy_rule` rows. Zetaris reads both as files beside `DRIFT`: `npm run zetaris:setup` writes them into its filestore and registers them. The DQ rule `exception_in_force` on `drift_usl.adoption` joins every ADOPT the ledger holds under an accepted exception to its lesson, across the two datasources.

Zetaris also reads one source itself, live: the Cloudflare DNS API, which `npm run zetaris:setup` registers as the REST datasource `CLOUDFLARE`, one table per zone, fetched again at each query. The DQ rule `dns_inventory_current` on `drift_usl.dns_live` holds every record live at the provider to the last complete DNS collection run, joined on Cloudflare's record id; a record that fails means the provider changed since that run. The file sources' rows are those of the committed files, the live source's the count measured on 26 Oct 2026:

| source | Zetaris datasource | tables | rows | what it holds |
|---|---|---|---|---|
| technician memory store (`examples/memory`) | `LESSONS` | `LESSONS.lesson`, `LESSONS.ledger` | 23 lessons, 23 ledger entries | the lessons the technician taught, in the Meterless H-MEM store, each with its tenant, scope key, expiry and provenance; the Decider recalls them, and an accepted exception makes its finding ADOPT until it expires |
| policy rules (`policy/hackathon.json`) | `RULES` | `RULES.rule` | 17 rules, version 2 | the MSP's policy, one row per rule under the rule id every disposition decided by policy names |
| Cloudflare live (`api.cloudflare.com/client/v4/zones/<zone id>/dns_records`) | `CLOUDFLARE` | `CLOUDFLARE.zone_<zone id>` | 58 records in 6 zones on 26 Oct 2026 | every DNS record at the provider now, which Zetaris fetches itself under the read token at each query; drift_usl.dns_live holds each to the last complete DNS collection run by record id, type and proxied flag |

## Work

No action is recorded for client-1.

Tickets by type and status:

| type | status | tickets |
|---|---|---|
| incident | open | 1 |

- incident P1 open: https://host-28ea31.com/word-861e90/drift-tickets/issues/2 (github #2, finding fnd-b4a40091cdb4f906)

## Probes

Probe runs passing the DQ gate: 11 of surface probe, every served name probed for the pass, and 0 of surface probe.verify, the Actor's probes after a write.

Probe run run-7a3ff25f0476b93f (surface probe), finished 2026-10-25T13:54:05.436Z: 20 probes fail.

| kind | ok | fail | skipped |
|---|---|---|---|
| dns | 34 | 3 | 0 |
| http | 27 | 10 | 0 |
| tls | 30 | 7 | 0 |

The failing names:

- dns: host-375750.ai, host-4c2c20.ai, host-f85201.ai
- http: host-375750.ai, host-3f9d65.ai, host-3fef97.club, host-4c2c20.ai, host-50b116.com, host-922448.ai, host-c10fff.com, host-d07e8a.com, host-d8dbd3.ai, host-f85201.ai
- tls: host-375750.ai, host-3f9d65.ai, host-3fef97.club, host-4c2c20.ai, host-922448.ai, host-d8dbd3.ai, host-f85201.ai

## Queries

- RUNS_SQL: 1 run, 80 rows
- RUN_COMPLETE_SQL: 61 runs, 0 rows
- DOC_ZONES_SQL: 1 run, 6 rows
- DOC_RUN_SHAPE_SQL: 3 runs, 3 rows
- DOC_INVENTORY_SQL: 2 runs, 2 rows
- DOC_COPIES_SQL: 1 run, 112 rows
- LATEST_APPROVALS_SQL: 1 run, 333 rows
- POLICY_RULES_SQL: 1 run, 28 rows
- DOC_UNAPPROVED_SQL: 3 runs, 1019 rows
- DOC_DISPOSITIONS_OF_RUN_SQL: 3 runs, 27 rows
- CAUSES_SQL: 1 run, 1 row
- ACTIONS_SQL: 1 run, 0 rows
- DOC_ACTIONS_SQL: 1 run, 0 rows
- DOC_TICKETS_SQL: 1 run, 1 row
- DOC_PROBES_SQL: 1 run, 6 rows
- DOC_PROBE_FAILURES_SQL: 1 run, 20 rows

Decided at 2026-10-25T14:17:53.416Z.
