# examples

Three worked examples, each cut from `sample/bundle.json` (the recorded, redacted collections of 24 and 25 Oct 2026)
by `npm run examples` (`scripts/examples.ts`): `bundle.json` is the slice, every row a copy of a recorded row, and
`findings.json` is what the pass (`src/pipeline.ts`, no model) computed over that slice when the script ran. Nothing
is authored, and re-running the script with the same store of lessons reproduces both files. Every slice is the
operator's estate, tenant `client-1`; the bundle's lab rows (tenant `lab-1`) stay out. Names are
`host-XXXXXX.<tld>`, addresses `ip-XXXXXX`, hosts the pseudonyms of their ssh aliases, actors
`mail-XXXXXX@domain-XXXXXX`, all under the tenant's salt, so a pseudonym here is the same pseudonym in the full bundle
and in the trace.

Every count and size on this page is in the table below, which `npm run examples` writes from the files it writes
and `test/export.test.ts` holds equal to the files on disk; the prose names none, so it cannot go stale.

<!-- npm run examples writes this table -->
| file | what the last run of npm run examples measured |
| --- | --- |
| `proxy-split/` | 176 rows in 9 tables; 1 finding: ESCALATE 1 |
| `wildcard-no-real-ip/` | 942 rows in 9 tables; 1 finding: ADOPT 1 |
| `orphans/` | 3,918 rows in 12 tables; 7 findings: ADOPT 3, HOLD 3, ESCALATE 1 |
| policy | 26 `policy_rule` rows in each slice; with the shipped `policy/hackathon.json` loaded, version 2's 16 rules govern |
| `memory/` | 23 lessons |
| `document.md` | 199 lines, 23,074 bytes |
| `report.html` | 31,328 bytes |
| `executive.html` | 32,854 bytes; 1 incident, 6 DQ rules |
<!-- end of the table npm run examples writes -->

Each slice also keeps what the Decider reads for its own rows: the `policy_rule` rows (versions 1 and 2, the shipped
file's rules loaded beside them before the pass, as every sample setup loads them), the approvals, vault copies and
validations of its objects, the probes of its names, the tenant's probe runs and the disposition rows of its objects
and records. The pass over each slice reads the technician's lessons from [memory/](memory/)
(`DRIFT_MEMORY_DIR=examples/memory`), the committed store of the operator's accepted exceptions, as the full pass
does. So the verbs over a slice are the ones the full pass gives: ADOPT under those exceptions, HOLD and ESCALATE by
policy. Every finding is decided at the instant the last lesson was taught, which is later than the slice's own
instant (the 13:54 UTC live pass of 25 Oct); a HOLD meets the latest HOLD the slice's disposition rows hold on its
live value and keeps that expiry.

Each finding carries its short stable id (`id`, `fnd-` plus 16 hex, the one `npm run answer` takes), the rows it
rests on (`finding`), the verb and its disposition (who decided, the rule, the expiry, the reason), the default
preconditions for its class with their row counts and one-sentence explanations (`checks`), `judge: "skipped"`
because no model ran, and, when the audit log can date it, the exposure line (`exposure`: since when the record has
been in the state the finding rests on, how many whole days, whether that is exact or a lower bound, the event and
the DNS run that still shows it). A finding an exception settles carries it too (`exception`: the lesson's id in the
store, applied, the expiry, the scope key, the operator's reason, who accepted it and when).

The directories are named for the case: the bundle pseudonymises the zone, and a folder named after the zone would
undo that for every row of the zone and every trace line that names it. `proposals/` holds the pre-flight proposals
and the verdicts the simulator returned for them; its own README explains them. [document.md](document.md) is the
owner's document over the full bundle (`npm run sample` and `npm run document` in sample mode write it alike): the
estate, the copies with their gaps, the approvals, the findings open by verb, the Why of its cause, where each answer
comes from, the work and tickets, the probes counted ok, fail and skipped, and the named queries it ran.
[report.html](report.html) is the owner's report over the same bundle and lessons, one HTML file rendered from the
document's rows (`npm run sample`, `npm run document` in sample mode and `npm run examples` write it alike): the
finding that needs a person with its cause and ticket #2, the held ones with their expiry, the ones adopted under the
technician's exceptions, the actions, and the latest read of each source with its DQ gate result.
[executive.html](executive.html) is the executive report over the same bundle and lessons for client-1, the last 7
days to the decision instant (`npm run examples` and `SAMPLE_MODE=true npm run report:executive` write it alike): six
KPIs, four charts with their data beneath them, the incidents with their cause and ticket, the sources and every DQ
rule of the semantic layer, and the receipts of the newest eval results; one standalone file with no script.
[memory/](memory/) is the store itself, `state.json` and `ledger.jsonl` as the vendored H-MEM reference writes them;
`npm run answer -- --list` prints its lessons.

## proxy-split

One zone, two records: the apex is an A record, direct, to a collected host; `www` is a CNAME to the apex, proxied
through Cloudflare. Visitors to `www` are hidden behind Cloudflare, visitors to the apex reach the origin, so the
address the proxy hides on one name is published on the other. The audit log holds the updates of the `www` record
on 2026-04-16: proxied off (21:11), proxied on (21:12), both by a named actor, then the content re-pointed at the
apex (21:47) by an API token, which has no email and so no actor.

Rows: the DNS and audit runs of 13:53 UTC on 25 Oct, the two records, their audit events, and the Decider's rows.
Finding: `proxy_split`, ESCALATE by policy under `rule-8e75e1d767980665` (`proxied` on any record, critical, locked, a
rollback rule, a 4 h hold): its HOLD expired at 2026-10-25T03:21:06.870Z and the finding stands, decided by the
policy alone; its ticket is issue #2. A rollback rule restores a setting to its approved value, and this finding
concerns the record's relation to another record while its own value stands, so the rule holds it, then escalates it
at the expiry. Of its preconditions, `run_complete` holds, `actor_attributed` holds (events with a named actor inside
the window), `previous_value_recoverable` holds (Cloudflare logs no old values, so the state before the latest change
is the latest earlier body, the 21:12 one), and `referent_unchanged` fails: the name changed inside the window. The
exposure line dates it from the 21:12:47 body (`evt-05fa48325110cdcb`) to the 13:53 UTC DNS run
(`run-9d48791b00433777`), exact, because the 21:11 body turned the proxy off before it; the 21:47 re-point kept it on
and leaves the clock running.

## wildcard-no-real-ip

A proxied wildcard record (`*.<zone>`) lands on a host where nothing trusts a Cloudflare range: no
`set_real_ip_from` at the http level of `nginx.conf` and none in any enabled server block. Every name under the
wildcard, whatever block serves it, sees Cloudflare's addresses as its visitors in logs, allow-lists and rate
limits. A wildcard is matched by no single `server_name`, and after redaction the pseudonym of a name says nothing
about its zone, so this check is host-wide, against the `http.real_ip` row the collector writes for the entry file.

Rows: the DNS and audit runs, the wildcard record and every audit event on it (none: the record predates the
account's log, which begins 2026-03-20), the host's inventory address, the 13:53 UTC host run's `http.real_ip` row
and the `.real_ip` and `.enabled` rows of its server blocks (every `real_ip` absent), and the Decider's rows. The
audit run is in the slice so that the audit checks run as they do in the full pass; a slice without it would record
them as "audit log incomplete" and escalate. Finding: `proxied_without_real_ip`, ADOPT by the operator until
2026-11-30T00:00:00.000Z under lesson `mem-19`, his accepted exception on `*.host-503b27.ai`; the exception outranks
the catch-all `rule-b8d9962485c3ced4` (normal, a 72 h hold), which governs `http.real_ip` as a setting the
`server[*].real_ip` rule leaves to it. `run_complete` and `host_in_inventory` hold; `actor_attributed` and
`previous_value_recoverable` fail because the audit log holds no event on the wildcard record inside its 18-month
reach, so the checks alone would say ESCALATE. The exposure line is absent for the same reason: no event dates the
state.

## orphans

The two directions of the same join. `orphan_record`: A records (one direct, the others proxied) land on a collected
host where no enabled server block names them, so requests for them reach nginx's default server. `orphan_vhost`:
on one host, a vhost file on disk that no `sites-enabled` link reaches carries a name with no record in any
collected zone, and an enabled vhost carries two such names; no wildcard record covers any of them (the collector's
`.zone` sibling row makes that check possible after redaction). The conf.d host lists no orphan vhost: its names
without their own record sit under the proxied wildcard's zone.

Rows: the DNS and audit runs, every A and CNAME record (a name served through a CNAME alone is no orphan, so the
aliases are in), the audit events on the records the findings name, both 13:53 UTC host runs' `server_name` rows
with their `.zone` and `.enabled` siblings, the tenant's inventory, its export snapshots and the Decider's rows. The
findings, by verb in the table above:

- `orphan_record`, HOLD by policy under the catch-all `rule-b8d9962485c3ced4` until 2026-10-27T23:21:06.870Z, the
  expiry the first HOLD on each live value set at 23:21 UTC on 24 Oct, carried by the 13:54 UTC HOLDs the slice
  holds; the operator's exceptions name `proxied_without_real_ip` and `orphan_vhost` findings, so the catch-all
  decides these. Each holds `run_complete` and `host_in_inventory`; the one on `host-c10fff.com` is attributed
  (`actor_attributed` holds), and `previous_value_recoverable` fails on each. The one on `host-c10fff.com` is dated by
  the exposure line as a lower bound, since 2026-07-06T18:46:40.994Z, because its one audit body sets the content the
  DNS run still shows and the log holds nothing earlier on the record. The names fail their http probe in the 13:53
  UTC probe run, and `host-3fef97.club` its tls probe too.
- `orphan_vhost`, ADOPT by the operator until 2026-11-30T00:00:00.000Z under lessons `mem-8`, `mem-4` and `mem-16`,
  the exceptions outranking the catch-all. The file on disk holds every check: nothing else in the run points at the
  name, and a backup exists. The enabled vhost's two names hold all but `other_settings_reference`, which finds the
  same names in the :80 block and in the file's `.bak` copy.
- The `proxy_split` above, ESCALATE under `rule-8e75e1d767980665`, which the CNAMEs bring with them.

The replay page (`npm run site`, `docs/`) re-runs every check of these findings at build time, to the recorded count
and sentence, and marks each finding `same` against the full sample pass. Its Document tab is
[document.md](document.md) and its Sources tab the table of where each answer comes from, both rendered to HTML at
build time.
