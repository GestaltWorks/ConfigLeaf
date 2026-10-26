# examples

Three worked examples, each cut from `sample/bundle.json` (the recorded, redacted collections of 24 and 25 Oct 2026,
the latest at 13:53 UTC on 25 Oct) by `npm run examples` (`scripts/examples.ts`): `bundle.json` is the slice, every
row a copy of a recorded row, and `findings.json` is what the pass (`src/pipeline.ts`, no model) computed over that
slice when the script ran. Nothing is authored, and re-running the script with the same store of lessons reproduces
both files. Every slice is the operator's estate, tenant `client-1`; the bundle's lab rows (tenant `lab-1`) stay out.
Names are `host-XXXXXX.<tld>`, addresses `ip-XXXXXX`, hosts the pseudonyms of their ssh aliases, actors
`mail-XXXXXX@domain-XXXXXX`, all under the tenant's salt, so a pseudonym here is the same pseudonym in the full bundle
and in the trace.

Each slice also keeps what the Decider reads for its own rows: the 26 `policy_rule` rows (versions 1 and 2; version
2's 15 rules govern), the approvals, vault copies and
validations of its objects, the probes of its names, the tenant's 11 probe runs (24 Oct 19:59 UTC to 25 Oct 13:53
UTC) and the disposition rows of its objects and records (12, 132 and 312 of the bundle's 343). The pass over each
slice reads the technician's lessons from [memory/](memory/) (`DRIFT_MEMORY_DIR=examples/memory`), the committed
store of the operator's 23 accepted exceptions, as the full pass does. So the verbs over a slice are the ones the full
pass gives: over the nine findings below, ADOPT 4 under those exceptions, HOLD 3 and ESCALATE 2 by policy. Every
finding is decided at 2026-10-25T14:17:53.416Z, the instant the last lesson was taught, which is later than the
slice's own instant, 2026-10-25T13:54:08.785Z (the 13:54 UTC live pass); a HOLD meets the latest HOLD the slice's
disposition rows hold on its live value and keeps that expiry.

Each finding carries its short stable id (`id`, `fnd-` plus 16 hex, the one `npm run answer` takes), the rows it
rests on (`finding`), the verb and its disposition (who decided, the rule, the expiry, the reason), the default
preconditions for its class with their row counts and one-sentence explanations (`checks`), `judge: "skipped"`
because no model ran, and, when the audit log can date it, the exposure line (`exposure`: since when the record has
been in the state the finding rests on, how many whole days, whether that is exact or a lower bound, the event and
the DNS run that still shows it). A finding an exception settles carries it too (`exception`: the lesson's id in the
store, applied, the expiry 2026-11-30T00:00:00.000Z, the scope key, the operator's reason, who accepted it and when).

The directories are named for the case: the bundle pseudonymises the zone, and a folder named after the zone would
undo that for every row of the zone and every trace line that names it. `proposals/` holds the four
pre-flight proposals and the verdicts the simulator returned for them; its own README explains them.
[document.md](document.md) is the owner's document over the full bundle (`npm run sample` and `npm run document` in
sample mode write it alike, 196 lines): the estate, the copies with their gaps, the approvals, the 27 findings open (ADOPT 23, HOLD 3, ESCALATE 1),
the Why of its one cause, where each answer comes from, the work and tickets, the probes counted ok, fail and
skipped, and the 16 named queries it ran, 83 runs in all. [report.html](report.html) is the owner's report over the same bundle and lessons, one HTML
file rendered from the document's rows (`npm run sample`, `npm run document` in sample mode and `npm run examples`
write it alike): the one finding that needs a person with its cause and ticket #2, the 3 held until 27 Oct 2026 23:21
UTC, the 23 adopted under the technician's exceptions, no action, and the latest read of each source with its DQ gate
result; on 25 Oct 2026, 30,094 bytes. [memory/](memory/) is the store itself, `state.json` and `ledger.jsonl` as the
vendored H-MEM reference writes them; `npm run answer -- --list` prints its 23 lessons.

## proxy-split

One zone, two records: the apex is an A record, direct, to a collected host; `www` is a CNAME to the apex, proxied
through Cloudflare. Visitors to `www` are hidden behind Cloudflare, visitors to the apex reach the origin, so the
address the proxy hides on one name is published on the other. The audit log holds the three updates of the `www`
record on 2026-04-16: proxied off (21:11), proxied on (21:12), both by a named actor, then the content re-pointed at
the apex (21:47) by an API token, which has no email and so no actor.

Rows: the DNS and audit runs of 13:53 UTC on 25 Oct, the two records, the three audit events, and the Decider's rows.
Finding: `proxy_split`, ESCALATE by policy under rule 13 (`rule-8e75e1d767980665`: `proxied` on any record, critical,
lock 1, a rollback rule, 4 h): its HOLD expired at 2026-10-25T03:21:06.870Z and the finding stands, decided by the
policy alone; its ticket is issue #2. A rollback rule restores a setting to its approved value, and this finding concerns the
record's relation to another record while its own value stands, so the rule holds it, then escalates it at the
expiry. 3 of 4 preconditions hold. `run_complete` holds, `actor_attributed` holds (two events with a named actor
inside the window), `previous_value_recoverable` holds (Cloudflare logs no old values, so the state before the latest
change is the latest earlier body, the 21:12 one), `referent_unchanged` fails: the name changed inside the window,
three pieces of evidence. Exposure: proxied since the 21:12:47 body (`evt-05fa48325110cdcb`), 191 whole days to the
13:53 UTC DNS run (`run-9d48791b00433777`), exact, because the 21:11 body turned the proxy off before it; the 21:47
re-point kept it on and leaves the clock running.

## wildcard-no-real-ip

A proxied wildcard record (`*.<zone>`) lands on a host where nothing trusts a Cloudflare range: no
`set_real_ip_from` at the http level of `nginx.conf` and none in any enabled server block. Every name under the
wildcard, whatever block serves it, sees Cloudflare's addresses as its visitors in logs, allow-lists and rate
limits. A wildcard is matched by no single `server_name`, and after redaction the pseudonym of a name says nothing
about its zone, so this check is host-wide, against the `http.real_ip` row the collector writes for the entry file.

Rows: the DNS and audit runs, the wildcard record and every audit event on it (none: the record predates the
account's log, which begins 2026-03-20), the host's inventory address, the 13:53 UTC host run's `http.real_ip` row
and the `.real_ip` and `.enabled` rows of its 46 server blocks (every `real_ip` absent), and the Decider's rows. The
audit run is in the slice so that the audit checks run as they do in the full pass; a slice without it would record
them as "audit log incomplete" and escalate. Finding: `proxied_without_real_ip`, ADOPT by the operator until
2026-11-30T00:00:00.000Z under lesson `mem-19`, his accepted exception on `*.host-503b27.ai`; the exception outranks
rule 15 (`rule-b8d9962485c3ced4`, the catch-all, normal, 72 h), which governs `http.real_ip` as a setting rule 11
(`server[*].real_ip`) leaves to it. 2 of 4 hold: `run_complete` and `host_in_inventory` hold, `actor_attributed`
and `previous_value_recoverable` fail because the audit log holds no event on the wildcard record inside its
18-month reach, so the checks alone would say ESCALATE. The exposure line is absent for the same reason: no event
dates the state.

## orphans

The two directions of the same join. `orphan_record`: three A records (one direct, two proxied) land on a collected
host where no enabled server block names them, so requests for them reach nginx's default server. `orphan_vhost`:
on one host, a vhost file on disk that no `sites-enabled` link reaches carries a name with no record in any
collected zone, and an enabled vhost carries two such names; no wildcard record covers any of them (the collector's
`.zone` sibling row makes that check possible after redaction). The conf.d host lists no orphan vhost: its names
without their own record sit under the proxied wildcard's zone.

Rows: the DNS and audit runs, every A and CNAME record (a name served through a CNAME alone is no orphan, so the
aliases are in), the audit events on the records the findings name, both 13:53 UTC host runs' `server_name` rows
with their `.zone` and `.enabled` siblings, the tenant's inventory, its export snapshots and the Decider's rows.
Seven findings, ADOPT 3, HOLD 3 and ESCALATE 1:

- 3 `orphan_record`, HOLD by policy under rule 15 (72 h) until 2026-10-27T23:21:06.870Z, the expiry the first HOLD on
  each live value set at 23:21 UTC on 24 Oct, carried by the 13:54 UTC HOLDs the slice holds; the operator's 23
  exceptions name `proxied_without_real_ip` and `orphan_vhost` findings, so rule 15 decides these three. Each holds `run_complete` and `host_in_inventory`; one is attributed
  (`actor_attributed` holds on `host-c10fff.com`), and `previous_value_recoverable` fails on all three. The one on
  `host-c10fff.com` is dated by the exposure line: at least 110 days, since 2026-07-06T18:46:40.994Z, because its one
  audit body sets the content the DNS run still shows and the log holds nothing earlier on the record. The three
  names fail their http probe in the 13:53 UTC probe run, and `host-3fef97.club` its tls probe too.
- 3 `orphan_vhost`, ADOPT by the operator until 2026-11-30T00:00:00.000Z under lessons `mem-8`, `mem-4` and `mem-16`,
  the exceptions outranking rule 15. The file on disk holds 3 of 3: nothing else in the run points at the name, and
  a backup exists (10 snapshots). The enabled vhost's two names hold 2 of 3: `other_settings_reference` finds 3 rows,
  the same names in the :80 block and in the file's `.bak` copy.
- The `proxy_split` above, ESCALATE under rule 13, which the CNAMEs bring with them.

The replay page (`npm run site`, `docs/`) re-runs every check of these nine findings at build time, 33 in all, to
the recorded count and sentence, and marks each finding `same` against the full sample pass: 9 of 9 on 25 Oct 2026.
Its Document tab is [document.md](document.md) and its Sources tab the table of where each answer comes from, both
rendered to HTML at build time.
