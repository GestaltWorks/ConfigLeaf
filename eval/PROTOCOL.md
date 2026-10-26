# Evaluation protocol, pre-registered

Committed on Saturday 24 October 2026, before any prompt or template was tuned against the items and
before any model saw them. The commit that adds `labels.json` is the pre-registration; its hash is cited
in the README. After that commit this file changes only for typos, each noted in the changelog at the
bottom.

## What is compared

Whether Nemotron changes what the agent does, measured on real items from the two estates the agent
reads, with the model's outputs counted as executable artefacts first and as judgements second.

## Items

`items.json` holds the candidate items (38 at pre-registration). Each item is one real deviation or one
real negative, drawn from the first live collection on 24 October and from the 18-month Cloudflare audit
log, with pseudonyms as the redactor produced them. Classes:

| class | the question the agent answers |
|---|---|
| proxy_split | one name served direct, its www proxied |
| proxied_without_real_ip | a Cloudflare-proxied name reaches a vhost that trusts no Cloudflare range |
| orphan_record | a record points at a host where no enabled server block names it |
| orphan_vhost | a server_name on disk with no record in the collected zones |
| dns_change_history | a record's change sequence from the audit log; should it have been raised at the time |
| dns_bulk_delete | a day with many record deletions |
| drift_vs_approved | dated copies of a vhost beside the live file |
| changed_since_backup | live config against the newest nightly export (negatives) |

Labels are written by one person (the operator, 17 years of MSP operations) without seeing any model
output, and committed as `labels.json`. The label is `needs_human`: `yes`, `no` or `unsure`, with the
operator's reasoning in his own words. `unsure` items are kept and reported. A second field,
`operator_note`, keeps anything else he said about an item; it is recorded and left unscored.

## Split

A seeded shuffle of the labelled items, seed = the sha256 of `labels.json`: the first 40% are the
development set, the rest the held-out set. Prompts and templates may be tuned on the development set
only. The held-out set is run once, on Monday 26 October, after the feature freeze, and its results are
published whatever they say.

## Configurations

All run on identical items, with identical SQL, through the same DataLayer and Zetaris datasource.

| id | what runs |
|---|---|
| C0 | SQL only: the class's default precondition checks, no model (what SAMPLE_MODE runs) |
| C1 | C0 plus Nemotron 3.5 Lightning selecting and parameterising checks from the catalogue |
| C2 | C1 plus Nemotron 3.5 Lightning as the falsifier judge |
| C3 | C1 plus Nemotron 3 Ultra as the falsifier judge |
| C4 | Nemotron 3 Ultra alone: the verdict from the rows, no SQL checks, no catalogue (baseline) |

Three runs of each configuration. Every prompt in every run carries a run nonce, and the receipt's
`cache.status` is recorded; a cached answer is reported as such, and run-to-run spread is computed over
uncached answers only.

## Planted false claims

Before the run, `planted.json` lists claims constructed to be false against the stored rows (an address
that is in the inventory stated as absent, a record stated as unchanged that the audit log shows changed,
and so on). Each is handed to the judge of C2 and C3. The count of strikes is reported per judge.

## What is counted, per configuration, per item

1. Checks the model selected; of those, how many were valid (known template, parameters bind) and ran unmodified.
2. Falsifier queries that passed the guard and ran; of those, how many returned rows (struck the claim).
3. Claims struck whose label is `needs_human: no` (agreed strikes) and whose label is `yes` (wrong strikes).
4. Verdict agreement with the label. The agent's verbs are ADOPT, HOLD, ESCALATE, ROLLBACK and FIX; `yes` expects
   ESCALATE or FIX, `no` expects ADOPT, HOLD or ROLLBACK; `unsure` is reported separately. A finding the pass raises
   that has no item in `items.json` is listed with its class and verb, unscored.
5. Items filed not judged (model failure, invalid output, failed receipt gate), with the reason.
6. Served model versus requested tier from the verified receipt. Any substitution makes the run invalid; the submitted run must show zero.
7. Cache hits, latency and tokens per call, from the receipt.

Then, second: accuracy per configuration against the labels with Wilson 95% intervals, and the spread of
each count over the three runs. At this sample size the intervals mostly overlap; the README says so
rather than ranking the configurations on them.

## Measures, per configuration

- Determinism: two passes over the same stored rows give the same findings, verbs and reasons; the count of differences is reported and the submitted run shows zero for C0.
- Coverage: items with a verdict over items in the set, and findings with a disposition over findings raised.
- False-positive rate: items labelled `no` whose verdict is ESCALATE or FIX, over items labelled `no`.
- Stability: the spread of each count over the three runs, computed over uncached answers only (receipt `cache.status`).
- The planted-false-claim strikes of the section above.

## Rules

- Receipts are verified (Ed25519) and linked for every call; the requested-versus-served table is published with the results.
- A model failure or a refused output is recorded as not judged and never retried into a better number.
- Early stops by the verifier (a verdict that cannot move) are counted and reported.
- The runner (`scripts/eval.ts`) reads this file's configuration table; it does not carry its own.
- Nothing in the eval maps an item to a stored answer.

## What this cannot show

That the verdicts are accurate against incident outcomes (that needs production tenants over time);
that two estates represent an MSP's clients; that Lightning's template choices generalise beyond this
catalogue; anything about enforcement.

## Changelog

- 2026-10-24: created, before labels.
- 2026-10-24, evening, before any model run and before the runner exists: items 3 and 4 of "What is counted" now name the `needs_human` scale the committed labels carry (the earlier text named a `matters` / `does not` scale no label uses) and the five verbs of the policy Decider; a "Measures" section defines determinism, coverage, false-positive rate and stability as the runner computes them. Items, labels, split and configurations unchanged.
- 2026-10-25, before the held-out run: the runner loads the shipped policy file (`DRIFT_POLICY_FILE`, `policy/hackathon.json` version 2) for the recording's tenant before its passes, because C0 is defined as what SAMPLE_MODE runs and SAMPLE_MODE decides under the policy. Items, labels, split, configurations and measures unchanged.
- 2026-10-25, before the held-out run: the Nightshift adapter gives each route of a failover ladder one retry after a 5xx, a 429, a timeout, a network error or an empty body that carried no content, and the eval records every attempt (`route_attempts`) and the route that answered. A reply with content that is invalid output is counted as such and never retried; a model failure is still never retried into a better number.
- 2026-10-25, before the held-out run: the runner reads the recording on sql.js through the same DataLayer and SQL that run on Zetaris live; `test/parity.test.ts` holds the two to the same rows over 107 cases. Items, labels, split, configurations and measures unchanged.
- 2026-10-26, before the held-out run: Nightshift 1.2.7 stores answers it judges verified and puts up to three similar earlier answers as a system message in front of later requests that share a meterless-scope, across apps; its signed receipts record this as hmem (injected, ids, top_score). In the development run of 25 October, 281 of 380 receipts carried it: 112 of the 151 records injected had been stored earlier in that run and 39 in earlier runs; the run nonce does not prevent it, because matching is on shared words. The runtime offers no request field or per-app setting that turns this off, and the scope is the only wall, so the adapter now sends a fresh meterless-scope on every call in place of user; the gate files a verdict whose receipt shows injected memory as not_judged; the runner records the scope and the injected count beside each receipt and marks a run with any injection invalid. Measured on 25 October, the same call injected 3 records under scope user and 0 under each of two fresh scopes; request fields that claim to switch memory off were ignored. The development-set results recorded on 25 October stand as measured under the shared scope and are re-run under isolation before the held-out run. Items, labels, split, configurations and measures unchanged.
- 2026-10-26, before the held-out run: the development set ran again under per-call scope isolation, started 25 October 2026 23:34 UTC, every call under its own meterless-scope: memory injected 0 of 390 calls, hmem null on all 384 published receipts; results in `eval/results/2026-10-25T23-34-17Z`. Items, labels, split, configurations and measures unchanged.
- 2026-10-26: a supplementary set, not pre-registered; measures agreement on real drift; items and labels under eval/supplementary/. Nine findings of four live passes of 25 Oct 2026 (three changes the operator staged on the production estate at 15:53, 16:49 and 18:08 UTC, and one lab cycle at 20:24 UTC), labelled after the fact by this protocol's verb reading of each live verb (1 yes, 8 no) and run by `npm run eval -- --set supplementary` over the recording sliced at each pass's instant; eval/supplementary/README.md declares it. The pre-registered items, labels, split, configurations and measures are unchanged.
- 2026-10-26, before the held-out run: Nemotron 3.5 Lightning's route order changes, the model unchanged: NVIDIA's own endpoint (`nvidia/nemotron-3.5-lightning-30b-a3b`) first and the OpenRouter route (`openrouter/nvidia/nemotron-3.5-lightning`) as its fallback, both through Nightshift. Measured 26 Oct 2026 04:05 UTC, six identical probes each: the OpenRouter route answered 1 of 6 (the rest empty responses, as since 25 Oct 18:10 UTC), NVIDIA's endpoint 5 of 6. Nemotron 3 Ultra's routes are unchanged. Items, labels, split, configurations and measures unchanged.
- 2026-10-26, before the held-out run, at the feature freeze (main `42c3ca7`), what changed since the development run of 25 Oct 2026 23:34 UTC in the code the eval runs: the Scout guard reads each claim and evidence cell before a judge prompt is built, withholds a cell it blocks behind a marker and asks no model a claim it blocks, and blocks a text over 64 KiB unread (PR #18); over the 38 recorded items it blocks nothing (`test/scout-guard.test.ts`). `verifyReceipt` trusts only the pinned receipt key, `sha256:6ee50b5d11fdd693e1ee80635ea1868bb1addefb5823768192849709928ff8c1`, the key of every published receipt (PR #13). The pass reads its runs and observations as sets, one query per tenant for the DQ gate (PRs #22, #23); the eval reads on sql.js, where the same SQL reads the same rows. The Decider's reason under an escalate rule names the object (PR #13). The live pass's own judge (PR #20) cuts evidence cells to 240 characters when a prompt would pass Nightshift's 4,000-character limit; the eval's prompts are not cut. Items, labels, split, configurations and measures unchanged.
