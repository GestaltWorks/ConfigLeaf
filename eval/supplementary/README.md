# Supplementary set: real drift, declared post hoc

Declared on Monday 26 October 2026. This set is post hoc and not pre-registered. The items were chosen and labelled
after the development and held-out sets of [eval/PROTOCOL.md](../PROTOCOL.md) were fixed, after the agent had already
met each change, and the labels come from the agent's own live verbs. It measures how the five configurations agree
on real drift. It does not measure recall against an independent judgement, and nothing here changes the pre-registered
items, labels, split, configurations or measures.

## Why it exists

The pre-registered items hold 36 labelled no, 2 unsure and 0 yes, so the development and held-out runs measure false
positives only; recall is unmeasured there. On Sunday 25 October 2026 the operator staged three real changes on the
production estate and the agent found each one, and a lab cycle on tenant `lab-1` caught a fourth. Those findings are
real drift with a known cause, the inputs a recall measure needs.

## How the items were chosen

Every finding of four live passes that concerns the staged change, and no other finding of those passes:

| cycle | what was staged | pass decided at (UTC) | trace | items |
| --- | --- | --- | --- | --- |
| client-1, 15:53 UTC | a locked vhost edited on the host | 2026-10-25T15:54:01.957Z | none committed; the rows are in the app Postgres | S01 drift_vs_approved, S02 changed_since_backup |
| client-1, 16:49 UTC | a DNS record's content changed in the Cloudflare dashboard | 2026-10-25T16:49:30.637Z | `examples/traces/cycle_mvo2bil0.jsonl` | S03 drift_vs_approved (the record), S04 and S05 found_but_different (the vhost serving the name, ports 443 and 80) |
| client-1, 18:08 UTC | a signed-off vhost broken, no valid copy in the vault | 2026-10-25T18:09:14.465Z | `examples/traces/cycle_mvo5600q.jsonl` | S06 drift_vs_approved, S07 changed_since_backup |
| lab-1, 20:24 UTC | the lab vhost edited over ssh at 20:22 UTC | 2026-10-25T20:24:34.402Z | `examples/traces/cycle_mvoa0l1i.jsonl` | S08 drift_vs_approved, S09 changed_since_backup |

Left out: the other findings of those passes (the proxy split, the real_ip findings, the orphan records and vhosts),
which the pre-registered items already cover, and the other lab passes of 25 Oct 2026, which have no committed trace:
between 09:35 and 09:52 UTC (one ESCALATE, two FIX and two ROLLBACK dispositions on the lab vhosts) and at 19:19, 19:50
and 20:02 UTC (a ROLLBACK of the same lab vhost each time).

Each item's `facts` is the finding's summary as the pass wrote it, pseudonymised by the redactor; `agent_says` is the
live verb and reason, kept for the record and never handed to a model; `cycle` names the tenant and the live pass's
instant.

## Labels and their rule

`labels.json` reads each live verb by the protocol's verb reading ("What is counted", item 4): ESCALATE and FIX read
yes; ADOPT, HOLD and ROLLBACK read no. The operator did not label these items blind; the label is the live pass's
verb, read by that rule.

| item | class | live verb | label |
| --- | --- | --- | --- |
| S01 | drift_vs_approved | ROLLBACK | no |
| S02 | changed_since_backup | HOLD | no |
| S03 | drift_vs_approved | ROLLBACK | no |
| S04 | found_but_different | HOLD | no |
| S05 | found_but_different | HOLD | no |
| S06 | drift_vs_approved | FIX | yes |
| S07 | changed_since_backup | HOLD | no |
| S08 | drift_vs_approved | ROLLBACK | no |
| S09 | changed_since_backup | HOLD | no |

The three ROLLBACK items are real drift that the agent restored from a validated copy without waking anyone. The
protocol reads ROLLBACK as no, so they count as no here. They stay in the set because they show whether each
configuration reaches the same verb on real drift. One item, S06, reads yes.

## How it runs

`npm run eval -- --set supplementary --runs 3` (`scripts/eval-supplementary.ts`; `scripts/eval.ts` hands
`--set supplementary` there before its own parsing, so the development and held-out runs are unchanged). The recording
is `bundle.json`, every table of the app Postgres exported on 26 Oct 2026 at 00:53 UTC by `npm run export:bundle --
--out eval/supplementary/bundle.json`, redacted as `sample/bundle.json` is: 145 collection runs and 30,874
observations of both tenants, the export's second redaction pass changing 99 fields, 626 values over 2 kB nulled, and
0 of 31 deny-list labels in the file. For each cycle, `src/eval/supplementary.ts`
slices the recording to that tenant's rows as they stood when the live pass decided: runs started and finished by then,
with their observations, DNS records and probes; approvals, backups, audit events, rules, vault copies and validations
dated by then; the ledger (dispositions, actions, tickets, causes) dated strictly before, so the live pass's own
decisions, the answer, are absent. `src/eval/run.ts` then runs unchanged over each slice, under the tenant, with no
planted claims and every model call under its own `meterless-scope`. A slice decides at its own instant, the latest it
holds (`src/data/instant.ts`), between 0.2 and 3.3 seconds before the live pass. The C0 pass over each slice raises every item's
finding under the live finding id, with the live verb and the live reason, apart from the HOLD expiry those seconds
move. The eval's technician memory is empty, as on the development set, so the findings the live passes adopted under
the operator's exceptions are held by rule in the slices; none of them is an item.

## Results, `results/2026-10-26T01-00-40Z`

The run started on 26 Oct 2026 at 01:00 UTC and finished at 03:29 UTC: 60 configuration runs (3 of each of C0 to C4
over each of the four cycles), 152 call records. Each cycle directory holds the run files, its own `summary.md` and
its receipts; `results/2026-10-26T01-00-40Z/summary.md` holds the table below.

| config | run | yes items read yes | no items read yes | agree / with a verdict | not judged | calls | memory injected | valid |
|---|---|---|---|---|---|---|---|---|
| C0 | 1 | 1 of 1 | 0 of 8 | 9 of 9 | 0 | 0 | 0 | yes |
| C0 | 2 | 1 of 1 | 0 of 8 | 9 of 9 | 0 | 0 | 0 | yes |
| C0 | 3 | 1 of 1 | 0 of 8 | 9 of 9 | 0 | 0 | 0 | yes |
| C1 | 1 | 1 of 1 | 0 of 8 | 8 of 8 | 1 | 9 | 0 | yes |
| C1 | 2 | 1 of 1 | 0 of 8 | 9 of 9 | 0 | 9 | 0 | yes |
| C1 | 3 | 1 of 1 | 0 of 8 | 8 of 8 | 1 | 9 | 0 | yes |
| C2 | 1 | 0 of 1 | 0 of 8 | 3 of 3 | 6 | 15 | 0 | yes |
| C2 | 2 | 0 of 1 | 0 of 8 | 4 of 4 | 5 | 17 | 0 | yes |
| C2 | 3 | 0 of 1 | 0 of 8 | 4 of 4 | 5 | 17 | 0 | yes |
| C3 | 1 | 0 of 1 | 0 of 8 | 8 of 8 | 1 | 16 | 0 | yes |
| C3 | 2 | 1 of 1 | 0 of 8 | 6 of 6 | 3 | 16 | 0 | yes |
| C3 | 3 | 0 of 1 | 0 of 8 | 6 of 6 | 3 | 17 | 0 | yes |
| C4 | 1 | 1 of 1 | 7 of 8 | 2 of 9 | 0 | 9 | 0 | yes |
| C4 | 2 | 1 of 1 | 5 of 8 | 4 of 9 | 0 | 9 | 0 | yes |
| C4 | 3 | 1 of 1 | 5 of 8 | 4 of 9 | 0 | 9 | 0 | yes |

Per item, the verdict of each run in run order ("-" not judged):

| item | label | C0 | C1 | C2 | C3 | C4 |
| --- | --- | --- | --- | --- | --- | --- |
| S01 | no | ROLLBACK x3 | ROLLBACK x3 | -, ROLLBACK, ROLLBACK | ROLLBACK, -, ROLLBACK | ESCALATE x3 |
| S02 | no | HOLD x3 | HOLD x3 | HOLD x3 | HOLD x3 | ESCALATE, ESCALATE, HOLD |
| S03 | no | ROLLBACK x3 | -, ROLLBACK, - | ROLLBACK x3 | ROLLBACK x3 | ESCALATE x3 |
| S04 | no | HOLD x3 | HOLD x3 | - x3 | HOLD x3 | ESCALATE, ADOPT, HOLD |
| S05 | no | HOLD x3 | HOLD x3 | -, HOLD, - | HOLD, -, - | ESCALATE x3 |
| S06 | yes | FIX x3 | FIX x3 | - x3 | -, FIX, - | ESCALATE x3 |
| S07 | no | HOLD x3 | HOLD x3 | HOLD, -, - | HOLD x3 | HOLD x3 |
| S08 | no | ROLLBACK x3 | ROLLBACK x3 | - x3 | ROLLBACK, ROLLBACK, - | ESCALATE, HOLD, ESCALATE |
| S09 | no | HOLD x3 | HOLD x3 | -, -, HOLD | HOLD, -, HOLD | ESCALATE x3 |

The SQL checks alone (C0) and with Lightning choosing them (C1) read the one yes item as yes in every run and read
yes on none of the 8 no items. With Ultra as the falsifier judge (C3), the yes item reads yes in 1 of 3 runs (run 2,
FIX); run 1 files it not judged because Lightning's selection held no valid check, and run 3 because Ultra's judge
reply held no JSON object. C3 reads yes on 0 of the 8 no items in each run, with 8, 5 and 6 of them given a verdict.
Ultra alone (C4) reads the yes item as yes (ESCALATE) in all 3 runs and reads yes on 7, 5 and 5 of the 8 no items: it
escalates S01 and S03, two of the three rolled-back items, in every run. C2, Lightning as the judge, gives no verdict on
the yes item in any run; 13 of its 16 items not judged are Lightning judge calls that answered empty on every route of
the failover ladder (`judge model unavailable ... empty_response`).

Not judged, by reason: C1 2 (the selection held no valid check); C2 16 (13 judge model unavailable, 2 selection
invalid, 1 refuting SQL that named a missing column); C3 7 (4 judge replies with no JSON object, 2 selection invalid,
1 refuting SQL with LIMIT before UNION ALL). On every finding with a verdict in C0 to C3 the policy rule decided the
verb, as on the development set. With one yes item, the recall figures are counts, not rates.

## Receipts

`npm run receipts:export -- --results <cycle dir> --from runtime`, then `npm run receipts:verify -- <cycle dir>`, on
each of the four cycle directories, 26 Oct 2026 03:30 UTC:

| cycle directory | receipts | signatures verified | withheld | mismatches | hmem injected |
| --- | --- | --- | --- | --- | --- |
| `client-1-15-54-01` | 36 | 36 | 0 | 0 | 0 |
| `client-1-16-49-30` | 42 | 42 | 0 | 0 | 0 |
| `client-1-18-09-14` | 30 | 30 | 0 | 0 | 0 |
| `lab-1-20-24-34` | 31 | 31 | 0 | 0 | 0 |

139 receipts in all, one signing key (the 23 Oct fixture key), 0 substitutions, 0 cache hits. Of the 152 call records,
139 carry a receipt; the 13 without one are the Lightning judge calls that failed on every route. Memory injected: 0 of
152 calls by the runner's count, and `hmem.injected` 0 on all 139 receipts. Every call went out under its own
`meterless-scope`, `supplementary-2026-10-26T01-00-40Z-g<cycle>-<n>`.

## What this cannot show

Recall against an independent judgement: the labels are the agent's own live verbs, so C0 agrees with them by
construction (its pass is the live pass, replayed), and a yes item count of one gives no rate. That the four cycles
represent drift in general: they are three changes one operator staged on purpose and one lab edit. What the
configurations would do without the policy file: every C0 to C3 verdict here is the rule's.
