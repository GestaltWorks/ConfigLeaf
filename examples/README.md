# examples

Three worked examples, each cut from `sample/bundle.json` (the recorded, redacted collections of 24 Oct 2026, the
latest at 23:35 UTC) by `npm run examples` (`scripts/examples.ts`): `bundle.json` is the slice, every row a copy of a
recorded row, and `findings.json` is what the pass (`src/pipeline.ts`, no model) computed over that slice when the
script ran. Nothing is authored, and re-running the script reproduces both files. Names are `host-XXXXXX.<tld>`,
addresses `ip-XXXXXX`, hosts the pseudonyms of their ssh aliases, actors `mail-XXXXXX@domain-XXXXXX`, all under the
tenant's salt, so a pseudonym here is the same pseudonym in the full bundle and in the trace.

Each slice also keeps what the Decider reads for its own rows: the 26 policy rules, the approvals, vault copies and
validations of its objects, the probes of its names and the tenant's three probe runs (19:59, 21:21 and 23:36 UTC).
So the verbs over a slice are the ones the full pass gives: every finding below is HOLD by policy, decided at the
slice's own instant, 2026-10-24T23:36:13.770Z (the finish of the 23:36 UTC probe run). A slice holds no disposition,
so each HOLD expires from that instant.

Each finding carries its short stable id (`id`, `fnd-` plus 16 hex, the one `npm run answer` takes), the rows it
rests on (`finding`), the verb and its disposition (who decided, the rule, the expiry, the reason), the default
preconditions for its class with their row counts and one-sentence explanations (`checks`), `judge: "skipped"`
because no model ran, and, when the audit log can date it, the exposure line (`exposure`: since when the record has
been in the state the finding rests on, how many whole days, whether that is exact or a lower bound, the event and
the DNS run that still shows it). No lesson from the technician's memory was in force when these were computed.

The directories are named for the case: the bundle pseudonymises the zone, and a folder named after the zone would
undo that for every row of the zone and every trace line that names it. `proposals/` holds the four
pre-flight proposals and the verdicts the simulator returned for them; its own README explains them.
[document.md](document.md) is the owner's document over the full bundle (`npm run document` in sample mode, 150
lines): the estate, the copies with their gaps, the approvals, the 27 findings open, the work and tickets, the probes
and the 13 queries it ran.

## proxy-split

One zone, two records: the apex is an A record, direct, to a collected host; `www` is a CNAME to the apex, proxied
through Cloudflare. Visitors to `www` are hidden behind Cloudflare, visitors to the apex reach the origin, so the
address the proxy hides on one name is published on the other. The audit log holds the three updates of the `www`
record on 2026-04-16: proxied off (21:11), proxied on (21:12), both by a named actor, then the content re-pointed at
the apex (21:47) by an API token, which has no email and so no actor.

Rows: the DNS and audit runs of 23:35 UTC, the two records, the three audit events, and the Decider's rows. Finding:
`proxy_split`, HOLD by policy under rule 13 (`rule-8e75e1d767980665`: `proxied` on any record, critical, lock 1, a
rollback rule, 4 h), held until 2026-10-25T03:36:13.770Z; the rule restores a setting to its approved value, and
this finding concerns the record's relation to another record while its own value stands. 3 of 4 preconditions hold.
`run_complete` holds, `actor_attributed` holds (two events with a named actor inside the window),
`previous_value_recoverable` holds (Cloudflare logs no old values, so the state before the latest change is the
latest earlier body, the 21:12 one), `referent_unchanged` fails: the name changed inside the window, three pieces of
evidence. Exposure: proxied since the 21:12:47 body (`evt-05fa48325110cdcb`), 191 whole days to the 23:35 UTC DNS
run (`run-59ffd380cfc7cda5`), exact, because the 21:11 body turned the proxy off before it; the 21:47 re-point kept
it on and leaves the clock running.

## wildcard-no-real-ip

A proxied wildcard record (`*.<zone>`) lands on a host where nothing trusts a Cloudflare range: no
`set_real_ip_from` at the http level of `nginx.conf` and none in any enabled server block. Every name under the
wildcard, whatever block serves it, sees Cloudflare's addresses as its visitors in logs, allow-lists and rate
limits. A wildcard is matched by no single `server_name`, and after redaction the pseudonym of a name says nothing
about its zone, so this check is host-wide, against the `http.real_ip` row the collector writes for the entry file.

Rows: the DNS and audit runs, the wildcard record and every audit event on it (none: the record predates the
account's log, which begins 2026-03-20), the host's inventory address, the 23:36 UTC host run's `http.real_ip` row
and the `.real_ip` and `.enabled` rows of its 46 server blocks (every `real_ip` absent), and the Decider's rows. The
audit run is in the slice so that the audit checks run as they do in the full pass; a slice without it would record
them as "audit log incomplete" and escalate. Finding: `proxied_without_real_ip`, HOLD by policy under rule 15
(`rule-b8d9962485c3ced4`, the catch-all, normal, 72 h), held until 2026-10-27T23:36:13.770Z; `http.real_ip` is a
setting rule 11 (`server[*].real_ip`) leaves to it. 2 of 4 hold: `run_complete` and `host_in_inventory` hold,
`actor_attributed` and `previous_value_recoverable` fail because the audit log holds no event on the wildcard
record inside its 18-month reach. The exposure line is absent for the same reason: no event dates the state.

## orphans

The two directions of the same join. `orphan_record`: three A records (one direct, two proxied) land on a collected
host where no enabled server block names them, so requests for them reach nginx's default server. `orphan_vhost`:
on one host, a vhost file on disk that no `sites-enabled` link reaches carries a name with no record in any
collected zone, and an enabled vhost carries two such names; no wildcard record covers any of them (the collector's
`.zone` sibling row makes that check possible after redaction). The conf.d host lists no orphan vhost: its names
without their own record sit under the proxied wildcard's zone.

Rows: the DNS and audit runs, every A and CNAME record (a name served through a CNAME alone is no orphan, so the
aliases are in), the audit events on the records the findings name, both 23:36 UTC host runs' `server_name` rows
with their `.zone` and `.enabled` siblings, the inventory, the export snapshots and the Decider's rows. Seven
findings, every one HOLD by policy:

- 3 `orphan_record` under rule 15 (72 h, until 2026-10-27T23:36:13.770Z). Each holds `run_complete` and
  `host_in_inventory`; one is attributed (`actor_attributed` holds on `host-c10fff.com`), and none has a recoverable
  previous state. The one on `host-c10fff.com` is dated by the exposure line: at least 110 days, since
  2026-07-06T18:46:40.994Z, because its one audit body sets the content the DNS run still shows and the log holds
  nothing earlier on the record. The three names are among the failing probes of the 23:36 UTC run.
- 3 `orphan_vhost` under rule 15 (72 h). The file on disk holds 3 of 3: nothing else in the run points at the name,
  and a backup exists (9 snapshots). The enabled vhost's two names hold 2 of 3: `other_settings_reference` finds 3
  rows, the same names in the :80 block and in the file's `.bak` copy.
- The `proxy_split` above, under rule 13 (4 h, until 2026-10-25T03:36:13.770Z), which the CNAMEs bring with them.

The replay page (`npm run site`, `docs/`) re-runs every check of these nine findings at build time, 33 in all, to
the recorded count and sentence, and marks each finding `same` against the full sample pass: 9 of 9 on 24 Oct 2026.
