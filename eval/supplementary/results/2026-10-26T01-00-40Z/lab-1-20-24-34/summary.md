# Eval results 2026-10-26T01-00-40Z/lab-1-20-24-34

memory injected: 0 of 36 calls, read from each call's signed receipt (hmem); 5 call(s) had no receipt to read. Every call went out under its own meterless-scope, supplementary-2026-10-26T01-00-40Z-g4-<n>.

Recording eval/supplementary/bundle.json sliced for lab-1 at 2026-10-25T20:24:34.402Z, tenant lab-1, every disposition decided at 2026-10-25T20:24:34.234Z. Contract eval/PROTOCOL.md; configurations as its table states them.
Policy policy/hackathon.json version 2: 15 rule(s) loaded into the recording before its passes (0 inserted), 26 read for lab-1; C0 to C3 decide by the exception, then the rule, then the default.
Supplementary set, post hoc and not pre-registered (eval/supplementary/README.md): 2 item(s) of this cycle (S08, S09), no split; the recording sliced at the live pass's instant 2026-10-25T20:24:34.402Z (src/eval/supplementary.ts sliceAt).
Runs per configuration: 3. Started 2026-10-26T02:35:44.070Z, finished 2026-10-26T03:29:51.834Z.
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
| C1 | 1 | 2 | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 7 | 7 | 7 | 7 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 3254 | 7144 | 23524 |
| C1 | 2 | 2 | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 8 | 8 | 8 | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 3252 | 8506 | 32050.5 |
| C1 | 3 | 2 | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 6 | 6 | 6 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 3251 | 8439 | 68765 |
| C2 | 1 | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 8 | 8 | 8 | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 3253 | 8011 | 154469.5 |
| C2 | 2 | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 8 | 8 | 8 | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 3255 | 10826 | 170774.5 |
| C2 | 3 | 2 | 2 | 1 | 1 | 1 | 0 | 0 | 0 | 7 | 7 | 7 | 7 | 1 | 1 | 1 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 7529 | 17671 | 65094 |
| C3 | 1 | 2 | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 8 | 8 | 8 | 8 | 2 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 11780 | 24496 | 56065 |
| C3 | 2 | 2 | 2 | 1 | 1 | 1 | 0 | 0 | 0 | 8 | 8 | 8 | 8 | 1 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 11784 | 25989 | 64311 |
| C3 | 3 | 2 | 2 | 1 | 1 | 1 | 0 | 0 | 0 | 8 | 8 | 8 | 8 | 1 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 11781 | 22451 | 60488 |
| C4 | 1 | 2 | 2 | 2 | 0 | 0 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 1306 | 1533 | 8584.5 |
| C4 | 2 | 2 | 2 | 2 | 0 | 1 | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 1309 | 1625 | 9469.5 |
| C4 | 3 | 2 | 2 | 2 | 0 | 0 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 1304 | 1282 | 16030.5 |

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
| C2 | 1 | 0 / 0 | - | - |
| C2 | 2 | 0 / 0 | - | - |
| C2 | 3 | 1 / 1 | 1.000 | 0.207 to 1.000 |
| C3 | 1 | 2 / 2 | 1.000 | 0.342 to 1.000 |
| C3 | 2 | 1 / 1 | 1.000 | 0.207 to 1.000 |
| C3 | 3 | 1 / 1 | 1.000 | 0.207 to 1.000 |
| C4 | 1 | 0 / 2 | 0.000 | 0.000 to 0.658 |
| C4 | 2 | 1 / 2 | 0.500 | 0.095 to 0.905 |
| C4 | 3 | 0 / 2 | 0.000 | 0.000 to 0.658 |

### Determinism

| config | compared | differences |
| --- | --- | --- |
| C0 | the passes of runs 1 and 2 | 0 |
| C1 | runs 1 and 2, item by item | 2 |
| C2 | runs 1 and 2, item by item | 0 |
| C3 | runs 1 and 2, item by item | 2 |
| C4 | runs 1 and 2, item by item | 2 |
- C1: S08
- C1: S09
- C3: S08
- C3: S09
- C4: S08
- C4: S09

### Coverage

| config | run | items with a verdict / scored | findings with a disposition / assessed |
| --- | --- | --- | --- |
| C0 | 1 | 2 / 2 | 2 / 2 |
| C0 | 2 | 2 / 2 | 2 / 2 |
| C0 | 3 | 2 / 2 | 2 / 2 |
| C1 | 1 | 2 / 2 | 2 / 2 |
| C1 | 2 | 2 / 2 | 2 / 2 |
| C1 | 3 | 2 / 2 | 2 / 2 |
| C2 | 1 | 0 / 2 | 0 / 2 |
| C2 | 2 | 0 / 2 | 0 / 2 |
| C2 | 3 | 1 / 2 | 1 / 2 |
| C3 | 1 | 2 / 2 | 2 / 2 |
| C3 | 2 | 1 / 2 | 1 / 2 |
| C3 | 3 | 1 / 2 | 1 / 2 |
| C4 | 1 | 2 / 2 | 2 / 2 |
| C4 | 2 | 2 / 2 | 2 / 2 |
| C4 | 3 | 2 / 2 | 2 / 2 |

The pass over the recording raises 2 finding(s), each with a disposition.

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
| C4 | 2 | 1 / 2 | 0.500 |
| C4 | 3 | 2 / 2 | 1.000 |

### Stability over uncached answers

Per count, its value in each run over the items whose every call the receipt marks uncached, and the spread (max minus min).

| config | uncached items per run | count: values (spread) |
| --- | --- | --- |
| C0 | 2, 2, 2 | with_verdict 2/2/2 (0); not_judged 0/0/0 (0); agree 2/2/2 (0); disagree 0/0/0 (0); false_positives 0/0/0 (0); checks_selected 0/0/0 (0); checks_valid 0/0/0 (0); checks_ran_unmodified 0/0/0 (0); falsifier_ran 0/0/0 (0); falsifier_struck 0/0/0 (0); agreed_strikes 0/0/0 (0); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 0/0/0 (0) |
| C1 | 2, 2, 2 | with_verdict 2/2/2 (0); not_judged 0/0/0 (0); agree 2/2/2 (0); disagree 0/0/0 (0); false_positives 0/0/0 (0); checks_selected 7/8/6 (2); checks_valid 7/8/6 (2); checks_ran_unmodified 7/8/6 (2); falsifier_ran 0/0/0 (0); falsifier_struck 0/0/0 (0); agreed_strikes 0/0/0 (0); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 0/0/0 (0) |
| C2 | 2, 2, 2 | with_verdict 0/0/1 (1); not_judged 2/2/1 (1); agree 0/0/1 (1); disagree 0/0/0 (0); false_positives 0/0/0 (0); checks_selected 8/8/7 (1); checks_valid 8/8/7 (1); checks_ran_unmodified 8/8/7 (1); falsifier_ran 0/0/1 (1); falsifier_struck 0/0/1 (1); agreed_strikes 0/0/1 (1); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 0/0/0 (0) |
| C3 | 2, 2, 2 | with_verdict 2/1/1 (1); not_judged 0/1/1 (1); agree 2/1/1 (1); disagree 0/0/0 (0); false_positives 0/0/0 (0); checks_selected 8/8/8 (0); checks_valid 8/8/8 (0); checks_ran_unmodified 8/8/8 (0); falsifier_ran 2/1/1 (1); falsifier_struck 0/0/0 (0); agreed_strikes 0/0/0 (0); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 0/0/0 (0) |
| C4 | 2, 2, 2 | with_verdict 2/2/2 (0); not_judged 0/0/0 (0); agree 0/1/0 (1); disagree 2/1/2 (1); false_positives 2/1/2 (1); checks_selected 0/0/0 (0); checks_valid 0/0/0 (0); checks_ran_unmodified 0/0/0 (0); falsifier_ran 0/0/0 (0); falsifier_struck 0/0/0 (0); agreed_strikes 0/0/0 (0); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 0/0/0 (0) |

### Planted false claims

(none)
(none)

## Requested versus served

From the verified receipt of every call; a served tier other than the requested one invalidates the run, as injected memory does.

| config | call | tier requested | model requested | model served | tier served | calls | cache hits | substitutions | receipt unverified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | select | lightning | openrouter/nvidia/nemotron-3.5-lightning | openrouter/nvidia/nemotron-3.5-lightning | lightning | 6 | 0 | 0 | 0 |
| C2 | select | lightning | openrouter/nvidia/nemotron-3.5-lightning | openrouter/nvidia/nemotron-3.5-lightning | lightning | 6 | 0 | 0 | 0 |
| C2 | judge | lightning | openrouter/nvidia/nemotron-3.5-lightning > nvidia/nemotron-3.5-lightning-30b-a3b | - | unknown | 5 | 0 | 0 | 5 |
| C2 | judge | lightning | nvidia/nemotron-3.5-lightning-30b-a3b | nvidia/nemotron-3.5-lightning-30b-a3b | lightning | 1 | 0 | 0 | 0 |
| C3 | select | lightning | openrouter/nvidia/nemotron-3.5-lightning | openrouter/nvidia/nemotron-3.5-lightning | lightning | 6 | 0 | 0 | 0 |
| C3 | judge | ultra | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | ultra | 6 | 0 | 0 | 0 |
| C4 | direct | ultra | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | ultra | 6 | 0 | 0 | 0 |

## Items not judged

| config | run | item | reason |
| --- | --- | --- | --- |
| C2 | 1 | S08 | judge not_judged: judge model unavailable: chat nvidia/nemotron-3.5-lightning-30b-a3b -> 502: nvidia/nemotron-3.5-lightning-30b-a3b_empty_response |
| C2 | 1 | S09 | judge not_judged: judge model unavailable: chat nvidia/nemotron-3.5-lightning-30b-a3b -> 502: nvidia/nemotron-3.5-lightning-30b-a3b_empty_response |
| C2 | 2 | S08 | judge not_judged: judge model unavailable: chat nvidia/nemotron-3.5-lightning-30b-a3b -> 502: nvidia/nemotron-3.5-lightning-30b-a3b_empty_response |
| C2 | 2 | S09 | judge not_judged: judge model unavailable: chat nvidia/nemotron-3.5-lightning-30b-a3b -> 502: nvidia/nemotron-3.5-lightning-30b-a3b_empty_response |
| C2 | 3 | S08 | judge not_judged: judge model unavailable: chat nvidia/nemotron-3.5-lightning-30b-a3b -> 502: nvidia/nemotron-3.5-lightning-30b-a3b_empty_response |
| C3 | 2 | S09 | judge invalid_output: no JSON object in the reply |
| C3 | 3 | S08 | judge invalid_output: no JSON object in the reply |

## Items not raised

Left unscored, in every configuration.

(none)

## Findings with no item

Raised by the pass over the recording, named by no item of eval/items.json; listed with the pass's verb, unscored.

(none)

## Unsure items

Reported apart from the agreement counts.

(none)
