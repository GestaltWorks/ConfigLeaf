# Pre-flight proposals

Four proposed changes against `sample/bundle.json` (the recorded, redacted collection of 24 Oct 2026) and
the verdict `npm run preflight` returned for each, written by the script itself (`--out`). A proposal is
a typed JSON object (`src/preflight/proposal.ts`): what to change, where, to what. The pre-flight binds it
to one row of the latest passing run, renders the table it would touch as a derived table that applies
the change, runs the whole pass (`src/pipeline.ts`) over that world through the same `DataLayer`, and
compares the findings with the baseline pass over the rows as recorded. Nothing is written anywhere.

```
SAMPLE_MODE=true npx tsx scripts/preflight.ts --proposal examples/proposals/<name>.json [--out <name>.verdict.json] [--quiet]
```

The verdicts below are what the simulation computed; none was tuned. Where the result differs from what
was expected before running, the difference is recorded, not adjusted. Names, addresses and hosts are the
bundle's pseudonyms; `203.0.113.9` is an RFC 5737 documentation address.

| file | change | verdict | delta against the baseline (27 findings) |
|---|---|---|---|
| `a-unproxy-www.json` | `proxied` 1 -> 0 on the www CNAME `bce1ca2b...` (host-524b42.quest, zone host-4c795e.quest) | **GO** | removes 3: the `proxy_split` and the two `proxied_without_real_ip` findings on the vhost blocks that serve www; adds none |
| `b-replay-16-april-proxied.json` | `proxied` -> 1 on the same record, the `proxied` field of the real UPDATE body of 2026-04-16 21:12:47Z | **GO** (no delta) | the record is already proxied in the recorded world, so the derived table differs in no column and 27 findings stay 27. Expected NO-GO or GO-IF before running; the honest result is that this replay changes nothing today, because the body it replays is the state in force. The pre-state (proxied off) is proposal (a) run backwards. |
| `c-vhost-real-ip.json` | `real_ip` absent -> `trusted:15 header:CF-Connecting-IP scope:server` on both blocks of `/etc/nginx/sites-available/host-4c795e.quest` on host-4b4dc1 | **GO** | removes the two `proxied_without_real_ip` findings for www on that vhost; adds none |
| `d-retarget-apex-outside-inventory.json` | `content` ip-6fb86d -> 203.0.113.9 on the apex A record, bound by name and type | **NO-GO** | adds two `dns_change` hero findings (the vhost's `server_name[apex]` rows now point at a name resolving outside the inventory), which no catalogue prerequisite clears; removes the two www `proxied_without_real_ip` findings, since nothing lands on an inventory host any more |

The fourth proposal is not one of the three the brief named; it is there because none of the three reaches
NO-GO on the recorded world, and a judge should see every verdict the simulator can give. `test/preflight.test.ts`
asserts all four, plus a GO-IF that is not committed as a file: proxying the direct A record of a `.club`
name served by two enabled blocks of one conf.d vhost that trust no range adds two `proxied_without_real_ip`
findings; one `add_real_ip_block` prerequisite on that file clears both, and with it the host-wide wildcard
finding on the same host (an enabled block that trusts a range is what that check looks for). Two
simulations, one prerequisite iteration.

## What a verdict means

- **GO**: the change adds no finding. The delta says what it removes; a value already in force removes
  and adds nothing and says so.
- **GO-IF**: the change adds findings that the prerequisite catalogue (`src/preflight/prerequisites.ts`)
  clears: `add_real_ip_block` for `proxied_without_real_ip`, `proxy_record` for `proxy_split`. Each
  prerequisite is a further overlay; the pass runs again; at most three iterations. The verdict lists the
  steps in order and whether each cleared the finding it was bound from.
- **NO-GO**: the change adds a finding no prerequisite clears. `orphan_record`, `orphan_vhost`,
  `dns_change` and `found_but_different` have no entry: clearing them means adding a server block or a
  DNS record, and an overlay never adds a row.
- **ESCALATE**: the simulation cannot run (the proposal does not parse or does not bind to exactly one
  row, counted as `invalid`; the latest run failed the DQ gate), or three prerequisites did not clean it.

## What the files hold

`<name>.verdict.json`: the verdict and reason, whether the proposal was invalid, how it bound (`change`:
field, row, from -> to), the baseline (runs, gated, observations, findings), every simulation with the
findings it added and removed against the baseline, the prerequisites applied, the final `removed` and
`added` lists, the derived tables as templates (`{{t:x}}` is the base table, as `DataLayer.render` sees
them), the judge's outcome (skipped in sample mode: `model: none`), the trace id and the elapsed time
(about 300 ms for a baseline and one simulation on the recorded bundle). The trace itself is in
`logs/<trace_id>.jsonl`, every line `agent: preflight`; the pass's own lines carry the agent whose step
it was in `target_agent` and the world they ran in (`world=baseline`, `world=simulated#0`) in `detail`.

## What it does not claim

The simulation runs over the world as last collected (24 Oct): a `when` in a proposal is carried into
the verdict, not used to rewind the rows. Live, with a Zetaris datasource and a Nightshift token, the
same derived tables render as `DRIFT.<table>` subqueries and the judge's falsifier is asked in the fixed
world, where it must return rows: for a GO, the falsifier of the first finding the change removes; for a
GO-IF, of the finding the last prerequisite cleared (`judge.target` says which, and the trace names it).
The call goes out under the tenant's app id (`drift-agent:<tenant>`) and its receipt must pass custody as
well as the tier gate. That half is unit-tested against stubs and has not run live; in these files
`judge` is skipped (`model: none`) with the target already chosen.
