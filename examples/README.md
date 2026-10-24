# examples

Three worked examples, each cut from `sample/bundle.json` (the recorded, redacted collection of 24 Oct
2026) by `npm run examples` (`scripts/examples.ts`): `bundle.json` is the slice, every row a copy of a
recorded row, and `findings.json` is what the pass (`src/pipeline.ts`, no model) computed over that slice
when the script ran. Nothing is authored, and re-running the script reproduces both files. Names are
`host-XXXXXX.<tld>`, addresses `ip-XXXXXX`, hosts the pseudonyms of their ssh aliases, actors
`mail-XXXXXX@domain-XXXXXX`, all under the tenant's salt, so a pseudonym here is the same pseudonym in the
full bundle and in the trace.

Each finding carries the rows it rests on (`finding`), the verb (`ADOPT` as a candidate pending a judge,
or `ESCALATE`), the default preconditions for its class with their row counts and one-sentence
explanations (`checks`), and `judge: "skipped"` because no model ran.

The directories are named for the case, never for the zone: the bundle pseudonymises the zone, and a folder
named after it would undo that for every row of the zone and every trace line that names it.

## proxy-split

One zone, two records: the apex is an A record, direct, to a collected host; `www` is a CNAME to the apex,
proxied through Cloudflare. Visitors to `www` are hidden behind Cloudflare, visitors to the apex reach the
origin, so the address the proxy hides on one name is published on the other. The audit log holds the
three updates of the `www` record on 2026-04-16: proxied off (21:11), proxied on (21:12), both by a named
actor, then the content re-pointed at the apex (21:47) by an API token, which has no email and so no actor.

Rows: the DNS and audit runs, the two records, the three audit events. Finding: `proxy_split`,
ESCALATE, 3 of 4 preconditions hold. `run_complete` holds, `actor_attributed` holds (two events with a
named actor inside the window), `previous_value_recoverable` holds (Cloudflare logs no old values, so the
state before the latest change is the latest earlier body, the 21:12 one), `referent_unchanged` fails: the
name changed inside the window, three pieces of evidence.

## wildcard-no-real-ip

A proxied wildcard record (`*.<zone>`) lands on a host where nothing trusts a Cloudflare range: no
`set_real_ip_from` at the http level of `nginx.conf` and none in any enabled server block. Every name under
the wildcard, whatever block serves it, sees Cloudflare's addresses as its visitors in logs, allow-lists
and rate limits. A wildcard is matched by no single `server_name`, and after redaction the pseudonym of a
name says nothing about its zone, so this check is host-wide, against the `http.real_ip` row the collector
writes for the entry file.

Rows: the DNS run, the wildcard record, the host's inventory addresses, the host run's `http.real_ip` row
and the `.real_ip` and `.enabled` rows of its 46 server blocks (every `real_ip` absent).
Finding: `proxied_without_real_ip`, ESCALATE, 2 of 4 hold: `run_complete` and `host_in_inventory` hold,
`actor_attributed` and `previous_value_recoverable` fail because the audit log holds no event on the
wildcard record inside its 18-month reach.

## orphans

The two directions of the same join. `orphan_record`: three A records (one direct, two proxied) land on a
collected host where no enabled server block names them, so requests for them reach nginx's default server.
`orphan_vhost`: on one host, a vhost file on disk but not enabled carries a name with no record in any
collected zone, and an enabled vhost carries two such names; none is covered by a wildcard record over its
zone (the collector's `.zone` sibling row makes that check possible after redaction). The conf.d host lists no
orphan vhost: its names without their own record sit under the proxied wildcard's zone.

Rows: the DNS and audit runs, every A and CNAME record (a name served through a CNAME alone is not an
orphan, so the aliases must be in), the audit events on the records the findings name, both host runs'
`server_name` rows with their `.zone` and `.enabled` siblings, the inventory and the export snapshots.
Findings: 3 `orphan_record` (ESCALATE; one of them attributed, none with a recoverable previous state),
3 `orphan_vhost` (the file on disk ADOPT, 3 of 3 hold: nothing else in the run points at the name and a
backup exists; the enabled vhost's two names ESCALATE because `other_settings_reference` finds the same
names in the :80 block and the file's `.bak` copy), and the `proxy_split` above, which the CNAMEs bring
with them.
