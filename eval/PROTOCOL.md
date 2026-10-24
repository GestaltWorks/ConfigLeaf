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

Labels are written by one person (the operator, an MSP technician by trade) without seeing any model
output, as `matters`, `does not` or `unsure`, each with one line of reasoning, and committed as
`labels.json`. `unsure` items are kept and reported, never silently dropped.

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
3. Claims struck whose label is `does not` (agreed strikes) and whose label is `matters` (wrong strikes).
4. Verdict agreement with the label: `matters` expects ESCALATE or HOLD, `does not` expects ADOPT; `unsure` is reported separately.
5. Items filed not judged (model failure, invalid output, failed receipt gate), with the reason.
6. Served model versus requested tier from the verified receipt. Any substitution makes the run invalid; the submitted run must show zero.
7. Cache hits, latency and tokens per call, from the receipt.

Then, second: accuracy per configuration against the labels with Wilson 95% intervals, and the spread of
each count over the three runs. At this sample size the intervals mostly overlap; the README says so
rather than ranking the configurations on them.

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
