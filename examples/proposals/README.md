# Pre-flight proposals

Four proposed changes against `sample/bundle.json` (the recorded, redacted collections of 24 and 25 Oct 2026, the
latest at 13:53 UTC on 25 Oct) and the verdict `npm run preflight` returned for each, written by the script itself (`--out`). A proposal
is a typed JSON object (`src/preflight/proposal.ts`): what to change, where, to what. The pre-flight binds it to one
row of the latest passing run, renders the table it would touch as a derived table that applies the change, runs the
whole pass (`src/pipeline.ts`) over that world through the same `DataLayer`, and compares the findings with the
baseline pass over the rows as recorded. Nothing is written anywhere.

```
SAMPLE_MODE=true npx tsx scripts/preflight.ts --proposal examples/proposals/<name>.json [--out <name>.verdict.json] [--quiet]
```

The verdicts below are what the simulation computed; none was tuned. Where a result departs from what was expected
before running, the file records the result as computed. Names, addresses and hosts are the bundle's pseudonyms;
`203.0.113.9` is an RFC 5737 documentation address. Measured 25 Oct 2026: the baseline is 80 runs, 0 gated out,
14,174 observations and 27 findings, and each verdict took 4,588 to 4,748 ms (the baseline and one simulation). The
simulation compares findings by key, and its passes decide by the policy alone, so the verbs in a verdict are the
policy's (HOLD where the sample pass, under the operator's exceptions, gives ADOPT).

| file | change | verdict | delta against the baseline (27 findings) |
|---|---|---|---|
| `a-unproxy-www.json` | `proxied` 1 -> 0 on the www CNAME `bce1ca2b...` (host-524b42.quest, zone host-4c795e.quest) | **GO** | removes 3: the `proxy_split` and the two `proxied_without_real_ip` findings on the vhost blocks that serve www; adds none |
| `b-replay-16-april-proxied.json` | `proxied` -> 1 on the same record, the `proxied` field of the real UPDATE body of 2026-04-16 21:12:47Z | **GO** (no delta) | the record is already proxied in the recorded world, so the derived table equals the base table in every column and 27 findings stay 27. NO-GO or GO-IF was the expectation before running; the body it replays is the state in force today. The pre-state (proxied off) is proposal (a). |
| `c-vhost-real-ip.json` | `real_ip` absent -> `trusted:15 header:CF-Connecting-IP scope:server` on both blocks of `/etc/nginx/sites-available/host-4c795e.quest` on host-4b4dc1 | **GO** | removes the two `proxied_without_real_ip` findings for www on that vhost; adds none |
| `d-retarget-apex-outside-inventory.json` | `content` ip-6fb86d -> 203.0.113.9 on the apex A record, bound by name and type | **NO-GO** | adds two `found_but_different` hero findings, which no catalogue prerequisite clears: the vhost's `server_name[apex]` rows are byte-identical since the 13:08 UTC run of host-4b4dc1 on 25 Oct while the name now resolves outside the inventory; removes the two www `proxied_without_real_ip` findings, since nothing lands on an inventory host any more |

The fourth proposal is one the brief's three leave out; it is there because the three reach GO on the recorded world,
and a judge should see every verdict the simulator can give. `test/preflight.test.ts` asserts all four, plus a GO-IF
held in the test alone: proxying the direct A record of a `.club` name served by two enabled blocks of one conf.d
vhost that trust no range adds two `proxied_without_real_ip` findings; one `add_real_ip_block` prerequisite on that
file clears both, and with it the host-wide wildcard finding on the same host (an enabled block that trusts a range
is what that check looks for). Two simulations, one prerequisite iteration, over the 07:58 UTC export
(`test/fixtures/recorded-bundle.json`): 40 findings, then 37.

## What a verdict means

- **GO**: the change adds no finding. The delta says what it removes; a value already in force removes and adds
  nothing and says so.
- **GO-IF**: the change adds findings that the prerequisite catalogue (`src/preflight/prerequisites.ts`) clears:
  `add_real_ip_block` for `proxied_without_real_ip`, `proxy_record` for `proxy_split`. Each prerequisite is a further
  overlay; the pass runs again; at most three iterations. The verdict lists the steps in order and whether each
  cleared the finding it was bound from.
- **NO-GO**: the change adds a finding no prerequisite clears. `orphan_record`, `orphan_vhost`, `dns_change` and
  `found_but_different` have no entry: clearing them means adding a server block or a DNS record, and an overlay
  changes rows and adds none.
- **ESCALATE**: the simulation cannot run (the proposal fails to parse or binds to other than exactly one row,
  counted as `invalid`; the latest run failed the DQ gate), or three prerequisites left findings standing.

## What the files hold

`<name>.verdict.json`: the verdict and reason, whether the proposal was invalid, how it bound (field, row, from ->
to), the baseline (runs, gated, observations, findings), every simulation with the findings it added and removed
against the baseline, the prerequisites applied, the final `removed` and `added` lists, the derived tables as
templates (`{{t:x}}` is the base table, as `DataLayer.render` sees them), the judge's outcome (skipped in sample
mode: `model: none`), the trace id and the elapsed time (`elapsed_ms`, 993 to 1,009). The trace itself is in
`logs/<trace_id>.jsonl`, every line `agent: preflight`; the pass's own lines carry the agent whose step it was in
`target_agent` and the world they ran in (`world=baseline`, `world=simulated#0`) in `detail`.

## Scope of the simulation

The simulation runs over the world as last collected (25 Oct 2026, 13:53 UTC): a `when` in a proposal is carried
into the verdict and leaves the rows as recorded. Live, with a Zetaris datasource and a Nightshift token, the same
derived tables render as `DRIFT.<table>` subqueries and the judge's falsifier is asked in the fixed world, where it
must return rows: for a GO, the falsifier of the first finding the change removes; for a GO-IF, of the finding the
last prerequisite cleared (`judge.target` says which, and the trace names it). The call goes out under the tenant's
app id (`drift-agent-<tenant>`) and its receipt must pass custody as well as the tier gate. That half is unit-tested
against stubs; in these files `judge` is skipped (`model: none`) with the target already chosen.
