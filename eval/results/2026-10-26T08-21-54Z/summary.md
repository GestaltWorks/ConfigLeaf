# Eval results 2026-10-26T08-21-54Z

memory injected: 0 of 413 calls, read from each call's signed receipt (hmem); 38 call(s) had no receipt to read. Every call went out under its own meterless-scope, heldout-2026-10-26T08-21-54Z-<n>.

Recording test/fixtures/recorded-bundle.json, tenant client-1, every disposition decided at 2026-10-24T07:59:23.745Z. Contract eval/PROTOCOL.md; configurations as its table states them.
Policy policy/hackathon.json version 2: 17 rule(s) loaded into the recording before its passes (17 inserted), 17 read for client-1; C0 to C3 decide by the exception, then the rule, then the default.
Split seed eaad75c7a2dca621fbae34c92b20a1658bf9778ab8b0de03cfdfe9b8ed4e94c2 (sha256 of eval/labels.json). Set heldout: 23 item(s), 0 development and 23 held out.
Runs per configuration: 3. Started 2026-10-26T08:21:54.367Z, finished 2026-10-26T22:22:26.548Z.
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
| C0 | 1 | 23 | 20 | 20 | 0 | 20 | 0 | 0 | 0 | 0 | 0 | 0 | 75 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| C0 | 2 | 23 | 20 | 20 | 0 | 20 | 0 | 0 | 0 | 0 | 0 | 0 | 75 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| C0 | 3 | 23 | 20 | 20 | 0 | 20 | 0 | 0 | 0 | 0 | 0 | 0 | 75 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| C1 | 1 | 23 | 20 | 20 | 0 | 20 | 0 | 0 | 0 | 78 | 78 | 78 | 78 | 0 | 0 | 0 | 0 | 0 | 0 | 20 | 0 | 0 | 0 | 34840 | 94639 | 65999 |
| C1 | 2 | 23 | 20 | 18 | 2 | 18 | 0 | 0 | 0 | 71 | 69 | 69 | 69 | 0 | 0 | 0 | 0 | 0 | 0 | 20 | 0 | 0 | 0 | 34850 | 102047 | 76857 |
| C1 | 3 | 23 | 20 | 20 | 0 | 20 | 0 | 0 | 0 | 77 | 77 | 77 | 77 | 0 | 0 | 0 | 0 | 0 | 0 | 20 | 0 | 0 | 0 | 34833 | 102364 | 84821 |
| C2 | 1 | 23 | 20 | 4 | 16 | 4 | 0 | 0 | 0 | 68 | 65 | 65 | 65 | 4 | 1 | 1 | 0 | 0 | 0 | 47 | 0 | 0 | 0 | 98780 | 158636 | 83223 |
| C2 | 2 | 23 | 20 | 8 | 12 | 8 | 0 | 0 | 0 | 74 | 73 | 73 | 73 | 8 | 3 | 3 | 0 | 0 | 0 | 49 | 0 | 0 | 0 | 136090 | 167042 | 75332 |
| C2 | 3 | 23 | 20 | 4 | 16 | 4 | 0 | 0 | 0 | 75 | 74 | 74 | 74 | 4 | 2 | 2 | 0 | 0 | 0 | 49 | 0 | 0 | 0 | 84827 | 165904 | 82709 |
| C3 | 1 | 23 | 20 | 17 | 3 | 17 | 0 | 0 | 0 | 71 | 69 | 69 | 69 | 17 | 1 | 1 | 0 | 0 | 0 | 48 | 0 | 0 | 0 | 165997 | 183008 | 50782.5 |
| C3 | 2 | 23 | 20 | 18 | 2 | 18 | 0 | 0 | 0 | 78 | 78 | 78 | 78 | 18 | 3 | 3 | 0 | 0 | 0 | 50 | 0 | 0 | 0 | 175359 | 203451 | 52012 |
| C3 | 3 | 23 | 20 | 20 | 0 | 20 | 0 | 0 | 0 | 78 | 78 | 78 | 78 | 20 | 1 | 1 | 0 | 0 | 0 | 50 | 0 | 0 | 0 | 175369 | 181597 | 43031 |
| C4 | 1 | 23 | 20 | 20 | 0 | 13 | 7 | 0 | 7 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 20 | 0 | 0 | 0 | 10935 | 10176 | 6515.5 |
| C4 | 2 | 23 | 20 | 20 | 0 | 13 | 7 | 0 | 7 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 20 | 0 | 0 | 0 | 10929 | 9940 | 6320 |
| C4 | 3 | 23 | 20 | 20 | 0 | 11 | 9 | 0 | 9 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 20 | 0 | 0 | 0 | 10929 | 9082 | 6910 |

## Measures

### Accuracy against the labels (Wilson 95%)

Agreements over items with a verdict whose label is yes or no. At this sample size the intervals mostly overlap; the table reports them side by side.

| config | run | agree / judged | accuracy | 95% interval |
| --- | --- | --- | --- | --- |
| C0 | 1 | 20 / 20 | 1.000 | 0.839 to 1.000 |
| C0 | 2 | 20 / 20 | 1.000 | 0.839 to 1.000 |
| C0 | 3 | 20 / 20 | 1.000 | 0.839 to 1.000 |
| C1 | 1 | 20 / 20 | 1.000 | 0.839 to 1.000 |
| C1 | 2 | 18 / 18 | 1.000 | 0.824 to 1.000 |
| C1 | 3 | 20 / 20 | 1.000 | 0.839 to 1.000 |
| C2 | 1 | 4 / 4 | 1.000 | 0.510 to 1.000 |
| C2 | 2 | 8 / 8 | 1.000 | 0.676 to 1.000 |
| C2 | 3 | 4 / 4 | 1.000 | 0.510 to 1.000 |
| C3 | 1 | 17 / 17 | 1.000 | 0.816 to 1.000 |
| C3 | 2 | 18 / 18 | 1.000 | 0.824 to 1.000 |
| C3 | 3 | 20 / 20 | 1.000 | 0.839 to 1.000 |
| C4 | 1 | 13 / 20 | 0.650 | 0.433 to 0.819 |
| C4 | 2 | 13 / 20 | 0.650 | 0.433 to 0.819 |
| C4 | 3 | 11 / 20 | 0.550 | 0.342 to 0.742 |

### Determinism

| config | compared | differences |
| --- | --- | --- |
| C0 | the passes of runs 1 and 2 | 0 |
| C1 | runs 1 and 2, item by item | 15 |
| C2 | runs 1 and 2, item by item | 6 |
| C3 | runs 1 and 2, item by item | 13 |
| C4 | runs 1 and 2, item by item | 20 |
- C1: E02
- C1: E05
- C1: E06
- C1: E09
- C1: E11
- C1: E14
- C1: E18
- C1: E19
- C1: E20
- C1: E22
- C1: E23
- C1: E25
- C1: E26
- C1: E27
- C1: E29
- C2: E01
- C2: E02
- C2: E05
- C2: E11
- C2: E12
- C2: E14
- C3: E01
- C3: E02
- C3: E05
- C3: E06
- C3: E09
- C3: E11
- C3: E18
- C3: E19
- C3: E20
- C3: E25
- C3: E26
- C3: E27
- C3: E29
- C4: E01
- C4: E02
- C4: E05
- C4: E06
- C4: E09
- C4: E11
- C4: E12
- C4: E14
- C4: E15
- C4: E18
- C4: E19
- C4: E20
- C4: E21
- C4: E22
- C4: E23
- C4: E25
- C4: E26
- C4: E27
- C4: E28
- C4: E29

### Coverage

| config | run | items with a verdict / scored | findings with a disposition / assessed |
| --- | --- | --- | --- |
| C0 | 1 | 20 / 20 | 20 / 20 |
| C0 | 2 | 20 / 20 | 20 / 20 |
| C0 | 3 | 20 / 20 | 20 / 20 |
| C1 | 1 | 20 / 20 | 20 / 20 |
| C1 | 2 | 18 / 20 | 18 / 20 |
| C1 | 3 | 20 / 20 | 20 / 20 |
| C2 | 1 | 4 / 20 | 4 / 20 |
| C2 | 2 | 8 / 20 | 8 / 20 |
| C2 | 3 | 4 / 20 | 4 / 20 |
| C3 | 1 | 17 / 20 | 17 / 20 |
| C3 | 2 | 18 / 20 | 18 / 20 |
| C3 | 3 | 20 / 20 | 20 / 20 |
| C4 | 1 | 20 / 20 | 20 / 20 |
| C4 | 2 | 20 / 20 | 20 / 20 |
| C4 | 3 | 20 / 20 | 20 / 20 |

The pass over the recording raises 38 finding(s), each with a disposition.

### False-positive rate

| config | run | labelled no, read yes / labelled no | rate |
| --- | --- | --- | --- |
| C0 | 1 | 0 / 20 | 0.000 |
| C0 | 2 | 0 / 20 | 0.000 |
| C0 | 3 | 0 / 20 | 0.000 |
| C1 | 1 | 0 / 20 | 0.000 |
| C1 | 2 | 0 / 20 | 0.000 |
| C1 | 3 | 0 / 20 | 0.000 |
| C2 | 1 | 0 / 20 | 0.000 |
| C2 | 2 | 0 / 20 | 0.000 |
| C2 | 3 | 0 / 20 | 0.000 |
| C3 | 1 | 0 / 20 | 0.000 |
| C3 | 2 | 0 / 20 | 0.000 |
| C3 | 3 | 0 / 20 | 0.000 |
| C4 | 1 | 7 / 20 | 0.350 |
| C4 | 2 | 7 / 20 | 0.350 |
| C4 | 3 | 9 / 20 | 0.450 |

### Stability over uncached answers

Per count, its value in each run over the items whose every call the receipt marks uncached, and the spread (max minus min).

| config | uncached items per run | count: values (spread) |
| --- | --- | --- |
| C0 | 23, 23, 23 | with_verdict 20/20/20 (0); not_judged 0/0/0 (0); agree 20/20/20 (0); disagree 0/0/0 (0); false_positives 0/0/0 (0); checks_selected 0/0/0 (0); checks_valid 0/0/0 (0); checks_ran_unmodified 0/0/0 (0); falsifier_ran 0/0/0 (0); falsifier_struck 0/0/0 (0); agreed_strikes 0/0/0 (0); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 0/0/0 (0) |
| C1 | 23, 23, 23 | with_verdict 20/18/20 (2); not_judged 0/2/0 (2); agree 20/18/20 (2); disagree 0/0/0 (0); false_positives 0/0/0 (0); checks_selected 78/71/77 (7); checks_valid 78/69/77 (9); checks_ran_unmodified 78/69/77 (9); falsifier_ran 0/0/0 (0); falsifier_struck 0/0/0 (0); agreed_strikes 0/0/0 (0); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 0/0/0 (0) |
| C2 | 23, 23, 23 | with_verdict 4/8/4 (4); not_judged 16/12/16 (4); agree 4/8/4 (4); disagree 0/0/0 (0); false_positives 0/0/0 (0); checks_selected 68/74/75 (7); checks_valid 65/73/74 (9); checks_ran_unmodified 65/73/74 (9); falsifier_ran 4/8/4 (4); falsifier_struck 1/3/2 (2); agreed_strikes 1/3/2 (2); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 0/0/0 (0) |
| C3 | 23, 23, 23 | with_verdict 17/18/20 (3); not_judged 3/2/0 (3); agree 17/18/20 (3); disagree 0/0/0 (0); false_positives 0/0/0 (0); checks_selected 71/78/78 (7); checks_valid 69/78/78 (9); checks_ran_unmodified 69/78/78 (9); falsifier_ran 17/18/20 (3); falsifier_struck 1/3/1 (2); agreed_strikes 1/3/1 (2); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 0/0/0 (0) |
| C4 | 23, 23, 23 | with_verdict 20/20/20 (0); not_judged 0/0/0 (0); agree 13/13/11 (2); disagree 7/7/9 (2); false_positives 7/7/9 (2); checks_selected 0/0/0 (0); checks_valid 0/0/0 (0); checks_ran_unmodified 0/0/0 (0); falsifier_ran 0/0/0 (0); falsifier_struck 0/0/0 (0); agreed_strikes 0/0/0 (0); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 0/0/0 (0) |

### Planted false claims

| config | run | judge tier | struck / claims | not judged or invalid |
| --- | --- | --- | --- | --- |
| C2 | 1 | lightning | 6 / 10 | 1 |
| C2 | 2 | lightning | 7 / 10 | 1 |
| C2 | 3 | lightning | 6 / 10 | 3 |
| C3 | 1 | ultra | 8 / 10 | 1 |
| C3 | 2 | ultra | 9 / 10 | 0 |
| C3 | 3 | ultra | 9 / 10 | 0 |
| config | run | claim | kind | status | rows | reason |
| --- | --- | --- | --- | --- | --- | --- |
| C2 | 1 | P01 | inventory address stated absent | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 1 | P02 | changed record stated unchanged | refuted | 3 | 3 row(s) satisfy the refuting SELECT |
| C2 | 1 | P03 | complete run stated partial | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 1 | P04 | backed-up host stated unbacked | refuted | 9 | 9 row(s) satisfy the refuting SELECT |
| C2 | 1 | P05 | served name stated unserved | stands | 0 | the refuting SELECT returned no rows |
| C2 | 1 | P06 | direct record stated proxied | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 1 | P07 | missing setting stated present everywhere | not_judged | - | judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 1 | P08 | attributed change stated unattributed | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 1 | P09 | deletion day stated quiet | stands | 0 | the refuting SELECT returned no rows |
| C2 | 1 | P10 | backed-up file stated absent from the backup | stands | 0 | the refuting SELECT returned no rows |
| C2 | 2 | P01 | inventory address stated absent | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 2 | P02 | changed record stated unchanged | refuted | 3 | 3 row(s) satisfy the refuting SELECT |
| C2 | 2 | P03 | complete run stated partial | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 2 | P04 | backed-up host stated unbacked | refuted | 9 | 9 row(s) satisfy the refuting SELECT |
| C2 | 2 | P05 | served name stated unserved | stands | 0 | the refuting SELECT returned no rows |
| C2 | 2 | P06 | direct record stated proxied | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 2 | P07 | missing setting stated present everywhere | not_judged | - | judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 2 | P08 | attributed change stated unattributed | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 2 | P09 | deletion day stated quiet | stands | 0 | the refuting SELECT returned no rows |
| C2 | 2 | P10 | backed-up file stated absent from the backup | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 3 | P01 | inventory address stated absent | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 3 | P02 | changed record stated unchanged | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 3 | P03 | complete run stated partial | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 3 | P04 | backed-up host stated unbacked | refuted | 9 | 9 row(s) satisfy the refuting SELECT |
| C2 | 3 | P05 | served name stated unserved | not_judged | - | judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning: timeout after 180 s |
| C2 | 3 | P06 | direct record stated proxied | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 3 | P07 | missing setting stated present everywhere | not_judged | - | judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning: timeout after 180 s |
| C2 | 3 | P08 | attributed change stated unattributed | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 3 | P09 | deletion day stated quiet | not_judged | - | judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 3 | P10 | backed-up file stated absent from the backup | stands | 0 | the refuting SELECT returned no rows |
| C3 | 1 | P01 | inventory address stated absent | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 1 | P02 | changed record stated unchanged | refuted | 3 | 3 row(s) satisfy the refuting SELECT |
| C3 | 1 | P03 | complete run stated partial | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 1 | P04 | backed-up host stated unbacked | refuted | 9 | 9 row(s) satisfy the refuting SELECT |
| C3 | 1 | P05 | served name stated unserved | refuted | 13 | 13 row(s) satisfy the refuting SELECT |
| C3 | 1 | P06 | direct record stated proxied | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 1 | P07 | missing setting stated present everywhere | invalid_output | - | no JSON object in the reply |
| C3 | 1 | P08 | attributed change stated unattributed | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 1 | P09 | deletion day stated quiet | stands | 0 | the refuting SELECT returned no rows |
| C3 | 1 | P10 | backed-up file stated absent from the backup | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 2 | P01 | inventory address stated absent | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 2 | P02 | changed record stated unchanged | refuted | 3 | 3 row(s) satisfy the refuting SELECT |
| C3 | 2 | P03 | complete run stated partial | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 2 | P04 | backed-up host stated unbacked | refuted | 9 | 9 row(s) satisfy the refuting SELECT |
| C3 | 2 | P05 | served name stated unserved | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 2 | P06 | direct record stated proxied | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 2 | P07 | missing setting stated present everywhere | refuted | 16 | 16 row(s) satisfy the refuting SELECT |
| C3 | 2 | P08 | attributed change stated unattributed | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 2 | P09 | deletion day stated quiet | stands | 0 | the refuting SELECT returned no rows |
| C3 | 2 | P10 | backed-up file stated absent from the backup | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 3 | P01 | inventory address stated absent | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 3 | P02 | changed record stated unchanged | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 3 | P03 | complete run stated partial | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 3 | P04 | backed-up host stated unbacked | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 3 | P05 | served name stated unserved | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 3 | P06 | direct record stated proxied | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 3 | P07 | missing setting stated present everywhere | refuted | 16 | 16 row(s) satisfy the refuting SELECT |
| C3 | 3 | P08 | attributed change stated unattributed | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 3 | P09 | deletion day stated quiet | stands | 0 | the refuting SELECT returned no rows |
| C3 | 3 | P10 | backed-up file stated absent from the backup | refuted | 1 | 1 row(s) satisfy the refuting SELECT |

## Requested versus served

From the verified receipt of every call; a served tier other than the requested one invalidates the run, as injected memory does.

| config | call | tier requested | model requested | model served | tier served | calls | cache hits | substitutions | receipt unverified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | select | lightning | nvidia/nemotron-3.5-lightning-30b-a3b | nvidia/nemotron-3.5-lightning-30b-a3b | lightning | 60 | 0 | 0 | 0 |
| C2 | select | lightning | nvidia/nemotron-3.5-lightning-30b-a3b | nvidia/nemotron-3.5-lightning-30b-a3b | lightning | 60 | 0 | 0 | 0 |
| C2 | judge | lightning | openrouter/nvidia/nemotron-3.5-lightning | openrouter/nvidia/nemotron-3.5-lightning | lightning | 12 | 0 | 0 | 0 |
| C2 | judge | lightning | nvidia/nemotron-3.5-lightning-30b-a3b > openrouter/nvidia/nemotron-3.5-lightning | - | unknown | 38 | 0 | 0 | 38 |
| C2 | judge | lightning | nvidia/nemotron-3.5-lightning-30b-a3b | nvidia/nemotron-3.5-lightning-30b-a3b | lightning | 35 | 0 | 0 | 0 |
| C3 | select | lightning | nvidia/nemotron-3.5-lightning-30b-a3b | nvidia/nemotron-3.5-lightning-30b-a3b | lightning | 60 | 0 | 0 | 0 |
| C3 | judge | ultra | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | ultra | 88 | 0 | 0 | 0 |
| C4 | direct | ultra | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | ultra | 60 | 0 | 0 | 0 |

## Items not judged

| config | run | item | reason |
| --- | --- | --- | --- |
| C1 | 2 | E02 | invalid output: the selection holds no valid check (checks is not an array) |
| C1 | 2 | E11 | invalid output: the selection holds no valid check (checks is not an array) |
| C2 | 1 | E02 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 1 | E05 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: dns_record.row_id |
| C2 | 1 | E09 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 1 | E11 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 1 | E12 | invalid output: the selection holds no valid check (checks is not an array) |
| C2 | 1 | E18 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 1 | E19 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 1 | E20 | invalid output: the selection holds no valid check (checks is not an array) |
| C2 | 1 | E21 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 1 | E22 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 1 | E23 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 1 | E25 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 1 | E26 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: fetch failed |
| C2 | 1 | E27 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 1 | E28 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 1 | E29 | invalid output: the selection holds no valid check (checks is not an array) |
| C2 | 2 | E09 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: d.object |
| C2 | 2 | E18 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: object_id |
| C2 | 2 | E19 | invalid output: the selection holds no valid check (checks is not an array) |
| C2 | 2 | E20 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: object |
| C2 | 2 | E21 | judge invalid_output: no JSON object in the reply |
| C2 | 2 | E22 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: object_id |
| C2 | 2 | E23 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 2 | E25 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 2 | E26 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 2 | E27 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 2 | E28 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 2 | E29 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 3 | E01 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 3 | E02 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 3 | E06 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 3 | E09 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 3 | E11 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 3 | E18 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 3 | E19 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 3 | E20 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 3 | E21 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 3 | E22 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 3 | E23 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 3 | E25 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 3 | E26 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 3 | E27 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C2 | 3 | E28 | invalid output: the selection holds no valid check (checks is not an array) |
| C2 | 3 | E29 | judge not_judged: judge model unavailable: chat openrouter/nvidia/nemotron-3.5-lightning -> 502: openrouter/nvidia/nemotron-3.5-lightning_empty_response |
| C3 | 1 | E14 | invalid output: the selection holds no valid check (checks is not an array) |
| C3 | 1 | E26 | invalid output: the selection holds no valid check (checks is not an array) |
| C3 | 1 | E29 | judge invalid_output: no JSON object in the reply |
| C3 | 2 | E02 | judge invalid_output: refutation SQL failed to run: sqljs: near "check": syntax error |
| C3 | 2 | E14 | judge invalid_output: no JSON object in the reply |

## Items not raised

Left unscored, in every configuration.

| item | class | set | reason |
| --- | --- | --- | --- |
| E33 | drift_vs_approved | heldout | the recording raises no drift_vs_approved finding |
| E35 | drift_vs_approved | heldout | the recording raises no drift_vs_approved finding |
| E36 | drift_vs_approved | heldout | the recording raises no drift_vs_approved finding |

## Findings with no item

Raised by the pass over the recording, named by no item of eval/items.json; listed with the pass's verb, unscored.

| finding | class | verb |
| --- | --- | --- |
| fnd-9bfe1da7d028260c | proxied_without_real_ip | HOLD |
| fnd-5bd1b4c03ee72c7a | proxied_without_real_ip | HOLD |
| fnd-dfe22fa267b51c91 | proxied_without_real_ip | HOLD |
| fnd-8a843610aeb1b709 | proxied_without_real_ip | HOLD |
| fnd-f3bcb9860c5a0b3d | proxied_without_real_ip | HOLD |
| fnd-8fc350e6aa5840d1 | proxied_without_real_ip | HOLD |
| fnd-385949946c990113 | proxied_without_real_ip | HOLD |
| fnd-b0472de6319451c4 | proxied_without_real_ip | HOLD |
| fnd-b3ea13c119d7b589 | proxied_without_real_ip | HOLD |
| fnd-770d13f327d54d12 | proxied_without_real_ip | HOLD |
| fnd-7548fb2a2e3cdca4 | proxied_without_real_ip | HOLD |
| fnd-028260c299ff1cb0 | proxied_without_real_ip | HOLD |

## Unsure items

Reported apart from the agreement counts.

(none)
