# Eval results 2026-10-26T01-00-40Z/client-1-15-54-01

memory injected: 0 of 36 calls, read from each call's signed receipt (hmem). Every call went out under its own meterless-scope, supplementary-2026-10-26T01-00-40Z-g1-<n>.

Recording eval/supplementary/bundle.json sliced for client-1 at 2026-10-25T15:54:01.957Z, tenant client-1, every disposition decided at 2026-10-25T15:53:58.661Z. Contract eval/PROTOCOL.md; configurations as its table states them.
Policy policy/hackathon.json version 2: 15 rule(s) loaded into the recording before its passes (0 inserted), 26 read for client-1; C0 to C3 decide by the exception, then the rule, then the default.
Supplementary set, post hoc and not pre-registered (eval/supplementary/README.md): 2 item(s) of this cycle (S01, S02), no split; the recording sliced at the live pass's instant 2026-10-25T15:54:01.957Z (src/eval/supplementary.ts sliceAt).
Runs per configuration: 3. Started 2026-10-26T01:00:40.566Z, finished 2026-10-26T01:09:44.573Z.
Verb reading: ESCALATE, FIX read yes; ADOPT, HOLD, ROLLBACK read no.

## Configurations

| id | what runs | runs | valid runs |
| --- | --- | --- | --- |
| C0 | SQL only: the class's default precondition checks, no model (what SAMPLE_MODE runs) | 3 | 3 |
| C1 | C0 plus Nemotron 3.5 Lightning selecting and parameterising checks from the catalogue | 3 | 3 |
| C2 | C1 plus Nemotron 3.5 Lightning as the falsifier judge | 3 | 3 |
| C3 | C1 plus Nemotron 3 Ultra as the falsifier judge | 3 | 3 |
| C4 | Nemotron 3 Ultra alone: the verdict from the rows, no SQL checks, no catalogue (baseline) | 3 | 3 |

## Counts per configuration and run

| config | run | items | scored | verdict | not judged | agree | disagree | unsure | no read yes | checks selected | valid | ran unmodified | checks run | falsifier ran | struck | agreed strikes | wrong strikes | early stops | judge withheld | calls | cache hits | substitutions | memory injected | tokens in | tokens out | median ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C0 | 1 | 2 | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| C0 | 2 | 2 | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| C0 | 3 | 2 | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| C1 | 1 | 2 | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 7 | 7 | 7 | 7 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 3313 | 648 | 1663 |
| C1 | 2 | 2 | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 8 | 8 | 8 | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 3311 | 683 | 2094 |
| C1 | 3 | 2 | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 8 | 8 | 8 | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 3311 | 708 | 3933.5 |
| C2 | 1 | 2 | 2 | 1 | 1 | 1 | 0 | 0 | 0 | 8 | 8 | 8 | 8 | 1 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 12000 | 1218 | 1326 |
| C2 | 2 | 2 | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 7 | 7 | 7 | 7 | 2 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 12002 | 1299 | 2266.5 |
| C2 | 3 | 2 | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 8 | 8 | 8 | 8 | 2 | 1 | 1 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 12003 | 1339 | 2134 |
| C3 | 1 | 2 | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 8 | 8 | 8 | 8 | 2 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 11995 | 10315 | 14954.5 |
| C3 | 2 | 2 | 2 | 1 | 1 | 1 | 0 | 0 | 0 | 7 | 7 | 7 | 7 | 1 | 1 | 1 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 12003 | 12846 | 18806.5 |
| C3 | 3 | 2 | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 8 | 8 | 8 | 8 | 2 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 12002 | 11741 | 25481 |
| C4 | 1 | 2 | 2 | 2 | 0 | 0 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 1468 | 1459 | 9219 |
| C4 | 2 | 2 | 2 | 2 | 0 | 0 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 1468 | 1249 | 6580.5 |
| C4 | 3 | 2 | 2 | 2 | 0 | 1 | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 1465 | 1233 | 6697.5 |

## Measures

### Accuracy against the labels (Wilson 95%)

Agreements over items with a verdict whose label is yes or no. At this sample size the intervals mostly overlap; the table reports them side by side.

| config | run | agree / judged | accuracy | 95% interval |
| --- | --- | --- | --- | --- |
| C0 | 1 | 2 / 2 | 1.000 | 0.342 to 1.000 |
| C0 | 2 | 2 / 2 | 1.000 | 0.342 to 1.000 |
| C0 | 3 | 2 / 2 | 1.000 | 0.342 to 1.000 |
| C1 | 1 | 2 / 2 | 1.000 | 0.342 to 1.000 |
| C1 | 2 | 2 / 2 | 1.000 | 0.342 to 1.000 |
| C1 | 3 | 2 / 2 | 1.000 | 0.342 to 1.000 |
| C2 | 1 | 1 / 1 | 1.000 | 0.207 to 1.000 |
| C2 | 2 | 2 / 2 | 1.000 | 0.342 to 1.000 |
| C2 | 3 | 2 / 2 | 1.000 | 0.342 to 1.000 |
| C3 | 1 | 2 / 2 | 1.000 | 0.342 to 1.000 |
| C3 | 2 | 1 / 1 | 1.000 | 0.207 to 1.000 |
| C3 | 3 | 2 / 2 | 1.000 | 0.342 to 1.000 |
| C4 | 1 | 0 / 2 | 0.000 | 0.000 to 0.658 |
| C4 | 2 | 0 / 2 | 0.000 | 0.000 to 0.658 |
| C4 | 3 | 1 / 2 | 0.500 | 0.095 to 0.905 |

### Determinism

| config | compared | differences |
| --- | --- | --- |
| C0 | the passes of runs 1 and 2 | 0 |
| C1 | runs 1 and 2, item by item | 1 |
| C2 | runs 1 and 2, item by item | 2 |
| C3 | runs 1 and 2, item by item | 2 |
| C4 | runs 1 and 2, item by item | 2 |
- C1: S02
- C2: S01
- C2: S02
- C3: S01
- C3: S02
- C4: S01
- C4: S02

### Coverage

| config | run | items with a verdict / scored | findings with a disposition / assessed |
| --- | --- | --- | --- |
| C0 | 1 | 2 / 2 | 2 / 2 |
| C0 | 2 | 2 / 2 | 2 / 2 |
| C0 | 3 | 2 / 2 | 2 / 2 |
| C1 | 1 | 2 / 2 | 2 / 2 |
| C1 | 2 | 2 / 2 | 2 / 2 |
| C1 | 3 | 2 / 2 | 2 / 2 |
| C2 | 1 | 1 / 2 | 1 / 2 |
| C2 | 2 | 2 / 2 | 2 / 2 |
| C2 | 3 | 2 / 2 | 2 / 2 |
| C3 | 1 | 2 / 2 | 2 / 2 |
| C3 | 2 | 1 / 2 | 1 / 2 |
| C3 | 3 | 2 / 2 | 2 / 2 |
| C4 | 1 | 2 / 2 | 2 / 2 |
| C4 | 2 | 2 / 2 | 2 / 2 |
| C4 | 3 | 2 / 2 | 2 / 2 |

The pass over the recording raises 29 finding(s), each with a disposition.

### False-positive rate

| config | run | labelled no, read yes / labelled no | rate |
| --- | --- | --- | --- |
| C0 | 1 | 0 / 2 | 0.000 |
| C0 | 2 | 0 / 2 | 0.000 |
| C0 | 3 | 0 / 2 | 0.000 |
| C1 | 1 | 0 / 2 | 0.000 |
| C1 | 2 | 0 / 2 | 0.000 |
| C1 | 3 | 0 / 2 | 0.000 |
| C2 | 1 | 0 / 2 | 0.000 |
| C2 | 2 | 0 / 2 | 0.000 |
| C2 | 3 | 0 / 2 | 0.000 |
| C3 | 1 | 0 / 2 | 0.000 |
| C3 | 2 | 0 / 2 | 0.000 |
| C3 | 3 | 0 / 2 | 0.000 |
| C4 | 1 | 2 / 2 | 1.000 |
| C4 | 2 | 2 / 2 | 1.000 |
| C4 | 3 | 1 / 2 | 0.500 |

### Stability over uncached answers

Per count, its value in each run over the items whose every call the receipt marks uncached, and the spread (max minus min).

| config | uncached items per run | count: values (spread) |
| --- | --- | --- |
| C0 | 2, 2, 2 | with_verdict 2/2/2 (0); not_judged 0/0/0 (0); agree 2/2/2 (0); disagree 0/0/0 (0); false_positives 0/0/0 (0); checks_selected 0/0/0 (0); checks_valid 0/0/0 (0); checks_ran_unmodified 0/0/0 (0); falsifier_ran 0/0/0 (0); falsifier_struck 0/0/0 (0); agreed_strikes 0/0/0 (0); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 0/0/0 (0) |
| C1 | 2, 2, 2 | with_verdict 2/2/2 (0); not_judged 0/0/0 (0); agree 2/2/2 (0); disagree 0/0/0 (0); false_positives 0/0/0 (0); checks_selected 7/8/8 (1); checks_valid 7/8/8 (1); checks_ran_unmodified 7/8/8 (1); falsifier_ran 0/0/0 (0); falsifier_struck 0/0/0 (0); agreed_strikes 0/0/0 (0); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 0/0/0 (0) |
| C2 | 2, 2, 2 | with_verdict 1/2/2 (1); not_judged 1/0/0 (1); agree 1/2/2 (1); disagree 0/0/0 (0); false_positives 0/0/0 (0); checks_selected 8/7/8 (1); checks_valid 8/7/8 (1); checks_ran_unmodified 8/7/8 (1); falsifier_ran 1/2/2 (1); falsifier_struck 0/0/1 (1); agreed_strikes 0/0/1 (1); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 0/0/0 (0) |
| C3 | 2, 2, 2 | with_verdict 2/1/2 (1); not_judged 0/1/0 (1); agree 2/1/2 (1); disagree 0/0/0 (0); false_positives 0/0/0 (0); checks_selected 8/7/8 (1); checks_valid 8/7/8 (1); checks_ran_unmodified 8/7/8 (1); falsifier_ran 2/1/2 (1); falsifier_struck 0/1/0 (1); agreed_strikes 0/1/0 (1); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 0/0/0 (0) |
| C4 | 2, 2, 2 | with_verdict 2/2/2 (0); not_judged 0/0/0 (0); agree 0/0/1 (1); disagree 2/2/1 (1); false_positives 2/2/1 (1); checks_selected 0/0/0 (0); checks_valid 0/0/0 (0); checks_ran_unmodified 0/0/0 (0); falsifier_ran 0/0/0 (0); falsifier_struck 0/0/0 (0); agreed_strikes 0/0/0 (0); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 0/0/0 (0) |

### Planted false claims

(none)
(none)

## Requested versus served

From the verified receipt of every call; a served tier other than the requested one invalidates the run, as injected memory does.

| config | call | tier requested | model requested | model served | tier served | calls | cache hits | substitutions | receipt unverified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | select | lightning | openrouter/nvidia/nemotron-3.5-lightning | openrouter/nvidia/nemotron-3.5-lightning | lightning | 6 | 0 | 0 | 0 |
| C2 | select | lightning | openrouter/nvidia/nemotron-3.5-lightning | openrouter/nvidia/nemotron-3.5-lightning | lightning | 6 | 0 | 0 | 0 |
| C2 | judge | lightning | openrouter/nvidia/nemotron-3.5-lightning | openrouter/nvidia/nemotron-3.5-lightning | lightning | 6 | 0 | 0 | 0 |
| C3 | select | lightning | openrouter/nvidia/nemotron-3.5-lightning | openrouter/nvidia/nemotron-3.5-lightning | lightning | 6 | 0 | 0 | 0 |
| C3 | judge | ultra | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | ultra | 6 | 0 | 0 | 0 |
| C4 | direct | ultra | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | ultra | 6 | 0 | 0 | 0 |

## Items not judged

| config | run | item | reason |
| --- | --- | --- | --- |
| C2 | 1 | S01 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: ap.criticality |
| C3 | 2 | S01 | judge invalid_output: no JSON object in the reply |

## Items not raised

Left unscored, in every configuration.

(none)

## Findings with no item

Raised by the pass over the recording, named by no item of eval/items.json; listed with the pass's verb, unscored.

| finding | class | verb |
| --- | --- | --- |
| fnd-b4a40091cdb4f906 | proxy_split | ESCALATE |
| fnd-45d5f3f4a2eb0b2e | proxied_without_real_ip | HOLD |
| fnd-9bfe1da7d028260c | proxied_without_real_ip | HOLD |
| fnd-a08488f45ff63140 | proxied_without_real_ip | HOLD |
| fnd-5bd1b4c03ee72c7a | proxied_without_real_ip | HOLD |
| fnd-dfe22fa267b51c91 | proxied_without_real_ip | HOLD |
| fnd-8a843610aeb1b709 | proxied_without_real_ip | HOLD |
| fnd-05b163bfda4c027f | proxied_without_real_ip | HOLD |
| fnd-f3bcb9860c5a0b3d | proxied_without_real_ip | HOLD |
| fnd-8fc350e6aa5840d1 | proxied_without_real_ip | HOLD |
| fnd-385949946c990113 | proxied_without_real_ip | HOLD |
| fnd-b91b1690878eaf0e | proxied_without_real_ip | HOLD |
| fnd-d62857e241af66e2 | orphan_record | HOLD |
| fnd-d5622dbd2bf43e3e | proxied_without_real_ip | HOLD |
| fnd-b0472de6319451c4 | proxied_without_real_ip | HOLD |
| fnd-2f1b5857f0426b68 | proxied_without_real_ip | HOLD |
| fnd-b3ea13c119d7b589 | proxied_without_real_ip | HOLD |
| fnd-770d13f327d54d12 | proxied_without_real_ip | HOLD |
| fnd-7548fb2a2e3cdca4 | proxied_without_real_ip | HOLD |
| fnd-4503aff67c556c58 | proxied_without_real_ip | HOLD |
| fnd-de3c5e8ebdc2d209 | proxied_without_real_ip | HOLD |
| fnd-028260c299ff1cb0 | proxied_without_real_ip | HOLD |
| fnd-58b251b5fce8fbff | orphan_record | HOLD |
| fnd-8fc67ccb1e4eebfa | orphan_record | HOLD |
| fnd-51038b9539a0174a | orphan_vhost | HOLD |
| fnd-3661fcc541693ada | orphan_vhost | HOLD |
| fnd-add52203af12de8a | orphan_vhost | HOLD |

## Unsure items

Reported apart from the agreement counts.

(none)
