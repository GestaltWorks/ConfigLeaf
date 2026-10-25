# Eval results 2026-10-24T23-54-56Z

Recording test/fixtures/recorded-bundle.json, tenant client-1, every disposition decided at 2026-10-24T07:59:23.745Z. Contract eval/PROTOCOL.md; configurations as its table states them.
Split seed eaad75c7a2dca621fbae34c92b20a1658bf9778ab8b0de03cfdfe9b8ed4e94c2 (sha256 of eval/labels.json). Set dev: 15 item(s), 15 development and 0 held out.
Runs per configuration: 2. Started 2026-10-24T23:54:56.119Z, finished 2026-10-24T23:54:56.866Z.
Verb reading: ESCALATE, FIX read yes; ADOPT, HOLD, ROLLBACK read no.

## Configurations

| id | what runs | runs | valid runs |
| --- | --- | --- | --- |
| C0 | SQL only: the class's default precondition checks, no model (what SAMPLE_MODE runs) | 2 | 2 |

## Counts per configuration and run

| config | run | items | scored | verdict | not judged | agree | disagree | unsure | no read yes | checks selected | valid | ran unmodified | checks run | falsifier ran | struck | agreed strikes | wrong strikes | early stops | judge withheld | calls | cache hits | substitutions | tokens in | tokens out | median ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C0 | 1 | 15 | 11 | 11 | 0 | 3 | 6 | 2 | 6 | 0 | 0 | 0 | 77 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| C0 | 2 | 15 | 11 | 11 | 0 | 3 | 6 | 2 | 6 | 0 | 0 | 0 | 77 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |

## Measures

### Accuracy against the labels (Wilson 95%)

Agreements over items with a verdict whose label is yes or no. At this sample size the intervals mostly overlap; the table reports them side by side.

| config | run | agree / judged | accuracy | 95% interval |
| --- | --- | --- | --- | --- |
| C0 | 1 | 3 / 9 | 0.333 | 0.121 to 0.646 |
| C0 | 2 | 3 / 9 | 0.333 | 0.121 to 0.646 |

### Determinism

| config | compared | differences |
| --- | --- | --- |
| C0 | the passes of runs 1 and 2 | 0 |

### Coverage

| config | run | items with a verdict / scored | findings with a disposition / assessed |
| --- | --- | --- | --- |
| C0 | 1 | 11 / 11 | 20 / 20 |
| C0 | 2 | 11 / 11 | 20 / 20 |

The pass over the recording raises 38 finding(s), each with a disposition.

### False-positive rate

| config | run | labelled no, read yes / labelled no | rate |
| --- | --- | --- | --- |
| C0 | 1 | 6 / 9 | 0.667 |
| C0 | 2 | 6 / 9 | 0.667 |

### Stability over uncached answers

Per count, its value in each run over the items whose every call the receipt marks uncached, and the spread (max minus min).

| config | uncached items per run | count: values (spread) |
| --- | --- | --- |
| C0 | 15, 15 | with_verdict 11/11 (0); not_judged 0/0 (0); agree 3/3 (0); disagree 6/6 (0); false_positives 6/6 (0); checks_selected 0/0 (0); checks_valid 0/0 (0); checks_ran_unmodified 0/0 (0); falsifier_ran 0/0 (0); falsifier_struck 0/0 (0); agreed_strikes 0/0 (0); wrong_strikes 0/0 (0); early_stops 0/0 (0); judge_withheld 0/0 (0) |

### Planted false claims

(none)
(none)

## Requested versus served

From the verified receipt of every call; a served tier other than the requested one invalidates the run.

(none)

## Items not judged

(none)

## Items not raised

Left unscored, in every configuration.

| item | class | set | reason |
| --- | --- | --- | --- |
| E30 | drift_vs_approved | dev | the recording raises no drift_vs_approved finding |
| E31 | drift_vs_approved | dev | the recording raises no drift_vs_approved finding |
| E32 | drift_vs_approved | dev | the recording raises no drift_vs_approved finding |
| E34 | drift_vs_approved | dev | the recording raises no drift_vs_approved finding |

## Findings with no item

Raised by the pass over the recording, named by no item of eval/items.json; listed with the pass's verb, unscored.

| finding | class | verb |
| --- | --- | --- |
| fnd-9bfe1da7d028260c | proxied_without_real_ip | ADOPT |
| fnd-5bd1b4c03ee72c7a | proxied_without_real_ip | ESCALATE |
| fnd-dfe22fa267b51c91 | proxied_without_real_ip | ESCALATE |
| fnd-8a843610aeb1b709 | proxied_without_real_ip | ESCALATE |
| fnd-f3bcb9860c5a0b3d | proxied_without_real_ip | ESCALATE |
| fnd-8fc350e6aa5840d1 | proxied_without_real_ip | ESCALATE |
| fnd-385949946c990113 | proxied_without_real_ip | ESCALATE |
| fnd-b0472de6319451c4 | proxied_without_real_ip | ESCALATE |
| fnd-b3ea13c119d7b589 | proxied_without_real_ip | ADOPT |
| fnd-770d13f327d54d12 | proxied_without_real_ip | ESCALATE |
| fnd-7548fb2a2e3cdca4 | proxied_without_real_ip | ESCALATE |
| fnd-028260c299ff1cb0 | proxied_without_real_ip | ESCALATE |

## Unsure items

Reported apart from the agreement counts.

| config | run | item | verdict | reading |
| --- | --- | --- | --- | --- |
| C0 | 1 | E37 | ESCALATE | yes |
| C0 | 1 | E38 | ESCALATE | yes |
| C0 | 2 | E37 | ESCALATE | yes |
| C0 | 2 | E38 | ESCALATE | yes |
