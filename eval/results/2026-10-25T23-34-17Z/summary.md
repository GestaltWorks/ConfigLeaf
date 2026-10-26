# Eval results 2026-10-25T23-34-17Z

memory injected: 0 of 390 calls, read from each call's signed receipt (hmem). Every call went out under its own meterless-scope, dev-2026-10-25T23-34-17Z-<n>.

Recording test/fixtures/recorded-bundle.json, tenant client-1, every disposition decided at 2026-10-24T07:59:23.745Z. Contract eval/PROTOCOL.md; configurations as its table states them.
Policy policy/hackathon.json version 2: 15 rule(s) loaded into the recording before its passes (15 inserted), 15 read for client-1; C0 to C3 decide by the exception, then the rule, then the default.
Split seed eaad75c7a2dca621fbae34c92b20a1658bf9778ab8b0de03cfdfe9b8ed4e94c2 (sha256 of eval/labels.json). Set dev: 15 item(s), 15 development and 0 held out.
Runs per configuration: 3. Started 2026-10-25T23:34:17.400Z, finished 2026-10-26T00:18:13.153Z.
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
| C0 | 1 | 15 | 11 | 11 | 0 | 9 | 0 | 2 | 0 | 0 | 0 | 0 | 77 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| C0 | 2 | 15 | 11 | 11 | 0 | 9 | 0 | 2 | 0 | 0 | 0 | 0 | 77 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| C0 | 3 | 15 | 11 | 11 | 0 | 9 | 0 | 2 | 0 | 0 | 0 | 0 | 77 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| C1 | 1 | 15 | 11 | 11 | 0 | 9 | 0 | 2 | 0 | 80 | 76 | 76 | 76 | 0 | 0 | 0 | 0 | 0 | 0 | 20 | 0 | 0 | 0 | 33597 | 6345 | 1283 |
| C1 | 2 | 15 | 11 | 11 | 0 | 9 | 0 | 2 | 0 | 78 | 78 | 78 | 78 | 0 | 0 | 0 | 0 | 0 | 0 | 20 | 0 | 0 | 0 | 33594 | 5797 | 1296.5 |
| C1 | 3 | 15 | 11 | 11 | 0 | 9 | 0 | 2 | 0 | 80 | 79 | 79 | 79 | 0 | 0 | 0 | 0 | 0 | 0 | 20 | 0 | 0 | 0 | 33587 | 6356 | 1255.5 |
| C2 | 1 | 15 | 11 | 2 | 9 | 0 | 0 | 2 | 0 | 79 | 78 | 78 | 78 | 10 | 1 | 0 | 0 | 0 | 1 | 49 | 0 | 0 | 0 | 155686 | 11191 | 1236 |
| C2 | 2 | 15 | 11 | 3 | 8 | 1 | 0 | 2 | 0 | 80 | 79 | 79 | 79 | 11 | 0 | 0 | 0 | 0 | 1 | 49 | 0 | 0 | 0 | 155663 | 10735 | 1233 |
| C2 | 3 | 15 | 11 | 1 | 10 | 1 | 0 | 2 | 0 | 77 | 75 | 75 | 75 | 9 | 0 | 0 | 0 | 0 | 1 | 48 | 0 | 0 | 0 | 151410 | 10878 | 1160.5 |
| C3 | 1 | 15 | 11 | 11 | 0 | 9 | 0 | 2 | 0 | 77 | 75 | 75 | 75 | 18 | 1 | 1 | 0 | 0 | 2 | 48 | 0 | 0 | 0 | 151416 | 62547 | 8842.5 |
| C3 | 2 | 15 | 11 | 10 | 1 | 8 | 0 | 2 | 0 | 74 | 73 | 73 | 73 | 19 | 1 | 1 | 0 | 0 | 0 | 49 | 0 | 0 | 0 | 155869 | 50340 | 7503 |
| C3 | 3 | 15 | 11 | 10 | 1 | 8 | 0 | 2 | 0 | 78 | 76 | 76 | 76 | 17 | 0 | 0 | 0 | 0 | 2 | 48 | 0 | 0 | 0 | 151635 | 62385 | 6548.5 |
| C4 | 1 | 15 | 11 | 9 | 2 | 3 | 6 | 2 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 13 | 0 | 0 | 0 | 14691 | 5393 | 5951 |
| C4 | 2 | 15 | 11 | 9 | 2 | 4 | 5 | 2 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 13 | 0 | 0 | 0 | 14687 | 5717 | 5970 |
| C4 | 3 | 15 | 11 | 9 | 2 | 3 | 6 | 2 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 13 | 0 | 0 | 0 | 14688 | 5246 | 5855 |

## Measures

### Accuracy against the labels (Wilson 95%)

Agreements over items with a verdict whose label is yes or no. At this sample size the intervals mostly overlap; the table reports them side by side.

| config | run | agree / judged | accuracy | 95% interval |
| --- | --- | --- | --- | --- |
| C0 | 1 | 9 / 9 | 1.000 | 0.701 to 1.000 |
| C0 | 2 | 9 / 9 | 1.000 | 0.701 to 1.000 |
| C0 | 3 | 9 / 9 | 1.000 | 0.701 to 1.000 |
| C1 | 1 | 9 / 9 | 1.000 | 0.701 to 1.000 |
| C1 | 2 | 9 / 9 | 1.000 | 0.701 to 1.000 |
| C1 | 3 | 9 / 9 | 1.000 | 0.701 to 1.000 |
| C2 | 1 | 0 / 0 | - | - |
| C2 | 2 | 1 / 1 | 1.000 | 0.207 to 1.000 |
| C2 | 3 | 1 / 1 | 1.000 | 0.207 to 1.000 |
| C3 | 1 | 9 / 9 | 1.000 | 0.701 to 1.000 |
| C3 | 2 | 8 / 8 | 1.000 | 0.676 to 1.000 |
| C3 | 3 | 8 / 8 | 1.000 | 0.676 to 1.000 |
| C4 | 1 | 3 / 9 | 0.333 | 0.121 to 0.646 |
| C4 | 2 | 4 / 9 | 0.444 | 0.189 to 0.733 |
| C4 | 3 | 3 / 9 | 0.333 | 0.121 to 0.646 |

### Determinism

| config | compared | differences |
| --- | --- | --- |
| C0 | the passes of runs 1 and 2 | 0 |
| C1 | runs 1 and 2, item by item | 7 |
| C2 | runs 1 and 2, item by item | 3 |
| C3 | runs 1 and 2, item by item | 7 |
| C4 | runs 1 and 2, item by item | 9 |
- C1: E03
- C1: E04
- C1: E08
- C1: E10
- C1: E16
- C1: E37
- C1: E38
- C2: E13
- C2: E37
- C2: E38
- C3: E03
- C3: E04
- C3: E10
- C3: E13
- C3: E16
- C3: E37
- C3: E38
- C4: E03
- C4: E04
- C4: E07
- C4: E08
- C4: E10
- C4: E13
- C4: E16
- C4: E17
- C4: E24

### Coverage

| config | run | items with a verdict / scored | findings with a disposition / assessed |
| --- | --- | --- | --- |
| C0 | 1 | 11 / 11 | 20 / 20 |
| C0 | 2 | 11 / 11 | 20 / 20 |
| C0 | 3 | 11 / 11 | 20 / 20 |
| C1 | 1 | 11 / 11 | 20 / 20 |
| C1 | 2 | 11 / 11 | 20 / 20 |
| C1 | 3 | 11 / 11 | 20 / 20 |
| C2 | 1 | 2 / 11 | 11 / 20 |
| C2 | 2 | 3 / 11 | 12 / 20 |
| C2 | 3 | 1 / 11 | 10 / 20 |
| C3 | 1 | 11 / 11 | 20 / 20 |
| C3 | 2 | 10 / 11 | 19 / 20 |
| C3 | 3 | 10 / 11 | 19 / 20 |
| C4 | 1 | 9 / 11 | 9 / 20 |
| C4 | 2 | 9 / 11 | 9 / 20 |
| C4 | 3 | 9 / 11 | 9 / 20 |

The pass over the recording raises 38 finding(s), each with a disposition.

### False-positive rate

| config | run | labelled no, read yes / labelled no | rate |
| --- | --- | --- | --- |
| C0 | 1 | 0 / 9 | 0.000 |
| C0 | 2 | 0 / 9 | 0.000 |
| C0 | 3 | 0 / 9 | 0.000 |
| C1 | 1 | 0 / 9 | 0.000 |
| C1 | 2 | 0 / 9 | 0.000 |
| C1 | 3 | 0 / 9 | 0.000 |
| C2 | 1 | 0 / 9 | 0.000 |
| C2 | 2 | 0 / 9 | 0.000 |
| C2 | 3 | 0 / 9 | 0.000 |
| C3 | 1 | 0 / 9 | 0.000 |
| C3 | 2 | 0 / 9 | 0.000 |
| C3 | 3 | 0 / 9 | 0.000 |
| C4 | 1 | 6 / 9 | 0.667 |
| C4 | 2 | 5 / 9 | 0.556 |
| C4 | 3 | 6 / 9 | 0.667 |

### Stability over uncached answers

Per count, its value in each run over the items whose every call the receipt marks uncached, and the spread (max minus min).

| config | uncached items per run | count: values (spread) |
| --- | --- | --- |
| C0 | 15, 15, 15 | with_verdict 11/11/11 (0); not_judged 0/0/0 (0); agree 9/9/9 (0); disagree 0/0/0 (0); false_positives 0/0/0 (0); checks_selected 0/0/0 (0); checks_valid 0/0/0 (0); checks_ran_unmodified 0/0/0 (0); falsifier_ran 0/0/0 (0); falsifier_struck 0/0/0 (0); agreed_strikes 0/0/0 (0); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 0/0/0 (0) |
| C1 | 15, 15, 15 | with_verdict 11/11/11 (0); not_judged 0/0/0 (0); agree 9/9/9 (0); disagree 0/0/0 (0); false_positives 0/0/0 (0); checks_selected 80/78/80 (2); checks_valid 76/78/79 (3); checks_ran_unmodified 76/78/79 (3); falsifier_ran 0/0/0 (0); falsifier_struck 0/0/0 (0); agreed_strikes 0/0/0 (0); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 0/0/0 (0) |
| C2 | 15, 15, 15 | with_verdict 2/3/1 (2); not_judged 9/8/10 (2); agree 0/1/1 (1); disagree 0/0/0 (0); false_positives 0/0/0 (0); checks_selected 79/80/77 (3); checks_valid 78/79/75 (4); checks_ran_unmodified 78/79/75 (4); falsifier_ran 10/11/9 (2); falsifier_struck 1/0/0 (1); agreed_strikes 0/0/0 (0); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 1/1/1 (0) |
| C3 | 15, 15, 15 | with_verdict 11/10/10 (1); not_judged 0/1/1 (1); agree 9/8/8 (1); disagree 0/0/0 (0); false_positives 0/0/0 (0); checks_selected 77/74/78 (4); checks_valid 75/73/76 (3); checks_ran_unmodified 75/73/76 (3); falsifier_ran 18/19/17 (2); falsifier_struck 1/1/0 (1); agreed_strikes 1/1/0 (1); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 2/0/2 (2) |
| C4 | 15, 15, 15 | with_verdict 9/9/9 (0); not_judged 2/2/2 (0); agree 3/4/3 (1); disagree 6/5/6 (1); false_positives 6/5/6 (1); checks_selected 0/0/0 (0); checks_valid 0/0/0 (0); checks_ran_unmodified 0/0/0 (0); falsifier_ran 0/0/0 (0); falsifier_struck 0/0/0 (0); agreed_strikes 0/0/0 (0); wrong_strikes 0/0/0 (0); early_stops 0/0/0 (0); judge_withheld 0/0/0 (0) |

### Planted false claims

| config | run | judge tier | struck / claims | not judged or invalid |
| --- | --- | --- | --- | --- |
| C2 | 1 | lightning | 3 / 10 | 4 |
| C2 | 2 | lightning | 2 / 10 | 3 |
| C2 | 3 | lightning | 2 / 10 | 3 |
| C3 | 1 | ultra | 9 / 10 | 0 |
| C3 | 2 | ultra | 8 / 10 | 0 |
| C3 | 3 | ultra | 8 / 10 | 0 |
| config | run | claim | kind | status | rows | reason |
| --- | --- | --- | --- | --- | --- | --- |
| C2 | 1 | P01 | inventory address stated absent | invalid_output | - | refutation SQL refused: bare table reference: inventory_asset; write {{t:inventory_asset}} |
| C2 | 1 | P02 | changed record stated unchanged | invalid_output | - | refutation SQL refused: bare table reference: audit_event; write {{t:audit_event}} |
| C2 | 1 | P03 | complete run stated partial | stands | 0 | the refuting SELECT returned no rows |
| C2 | 1 | P04 | backed-up host stated unbacked | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 1 | P05 | served name stated unserved | invalid_output | - | refutation SQL failed to run: sqljs: no such column: host |
| C2 | 1 | P06 | direct record stated proxied | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 1 | P07 | missing setting stated present everywhere | stands | 0 | the refuting SELECT returned no rows |
| C2 | 1 | P08 | attributed change stated unattributed | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 1 | P09 | deletion day stated quiet | invalid_output | - | refutation SQL refused: bare table reference: dns_record; write {{t:dns_record}} |
| C2 | 1 | P10 | backed-up file stated absent from the backup | stands | 0 | the refuting SELECT returned no rows |
| C2 | 2 | P01 | inventory address stated absent | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 2 | P02 | changed record stated unchanged | invalid_output | - | refutation SQL refused: bare table reference: audit_event; write {{t:audit_event}} |
| C2 | 2 | P03 | complete run stated partial | stands | 0 | the refuting SELECT returned no rows |
| C2 | 2 | P04 | backed-up host stated unbacked | stands | 0 | the refuting SELECT returned no rows |
| C2 | 2 | P05 | served name stated unserved | invalid_output | - | refutation SQL failed to run: sqljs: no such column: host |
| C2 | 2 | P06 | direct record stated proxied | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 2 | P07 | missing setting stated present everywhere | stands | 0 | the refuting SELECT returned no rows |
| C2 | 2 | P08 | attributed change stated unattributed | stands | 0 | the refuting SELECT returned no rows |
| C2 | 2 | P09 | deletion day stated quiet | invalid_output | - | refutation SQL refused: bare table reference: dns_record; write {{t:dns_record}} |
| C2 | 2 | P10 | backed-up file stated absent from the backup | stands | 0 | the refuting SELECT returned no rows |
| C2 | 3 | P01 | inventory address stated absent | invalid_output | - | refutation SQL refused: bare table reference: inventory_asset; write {{t:inventory_asset}} |
| C2 | 3 | P02 | changed record stated unchanged | invalid_output | - | refutation SQL refused: bare table reference: audit_event; write {{t:audit_event}} |
| C2 | 3 | P03 | complete run stated partial | stands | 0 | the refuting SELECT returned no rows |
| C2 | 3 | P04 | backed-up host stated unbacked | stands | 0 | the refuting SELECT returned no rows |
| C2 | 3 | P05 | served name stated unserved | invalid_output | - | refutation SQL failed to run: sqljs: no such column: host |
| C2 | 3 | P06 | direct record stated proxied | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 3 | P07 | missing setting stated present everywhere | stands | 0 | the refuting SELECT returned no rows |
| C2 | 3 | P08 | attributed change stated unattributed | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C2 | 3 | P09 | deletion day stated quiet | stands | 0 | the refuting SELECT returned no rows |
| C2 | 3 | P10 | backed-up file stated absent from the backup | stands | 0 | the refuting SELECT returned no rows |
| C3 | 1 | P01 | inventory address stated absent | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 1 | P02 | changed record stated unchanged | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 1 | P03 | complete run stated partial | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 1 | P04 | backed-up host stated unbacked | refuted | 9 | 9 row(s) satisfy the refuting SELECT |
| C3 | 1 | P05 | served name stated unserved | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 1 | P06 | direct record stated proxied | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 1 | P07 | missing setting stated present everywhere | refuted | 16 | 16 row(s) satisfy the refuting SELECT |
| C3 | 1 | P08 | attributed change stated unattributed | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 1 | P09 | deletion day stated quiet | stands | 0 | the refuting SELECT returned no rows |
| C3 | 1 | P10 | backed-up file stated absent from the backup | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 2 | P01 | inventory address stated absent | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 2 | P02 | changed record stated unchanged | stands | 0 | the refuting SELECT returned no rows |
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
| C3 | 3 | P04 | backed-up host stated unbacked | refuted | 9 | 9 row(s) satisfy the refuting SELECT |
| C3 | 3 | P05 | served name stated unserved | refuted | 13 | 13 row(s) satisfy the refuting SELECT |
| C3 | 3 | P06 | direct record stated proxied | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 3 | P07 | missing setting stated present everywhere | stands | 0 | the refuting SELECT returned no rows |
| C3 | 3 | P08 | attributed change stated unattributed | refuted | 1 | 1 row(s) satisfy the refuting SELECT |
| C3 | 3 | P09 | deletion day stated quiet | stands | 0 | the refuting SELECT returned no rows |
| C3 | 3 | P10 | backed-up file stated absent from the backup | refuted | 1 | 1 row(s) satisfy the refuting SELECT |

## Requested versus served

From the verified receipt of every call; a served tier other than the requested one invalidates the run, as injected memory does.

| config | call | tier requested | model requested | model served | tier served | calls | cache hits | substitutions | receipt unverified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | select | lightning | openrouter/nvidia/nemotron-3.5-lightning | openrouter/nvidia/nemotron-3.5-lightning | lightning | 60 | 0 | 0 | 0 |
| C2 | select | lightning | openrouter/nvidia/nemotron-3.5-lightning | openrouter/nvidia/nemotron-3.5-lightning | lightning | 60 | 0 | 0 | 0 |
| C2 | judge | lightning | openrouter/nvidia/nemotron-3.5-lightning | openrouter/nvidia/nemotron-3.5-lightning | lightning | 86 | 0 | 0 | 0 |
| C3 | select | lightning | openrouter/nvidia/nemotron-3.5-lightning | openrouter/nvidia/nemotron-3.5-lightning | lightning | 60 | 0 | 0 | 0 |
| C3 | judge | ultra | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | ultra | 85 | 0 | 0 | 0 |
| C4 | direct | ultra | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | ultra | 39 | 0 | 0 | 0 |

## Items not judged

| config | run | item | reason |
| --- | --- | --- | --- |
| C2 | 1 | E03 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: d.object_id |
| C2 | 1 | E04 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: d.object |
| C2 | 1 | E07 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: d.object |
| C2 | 1 | E08 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: a.object |
| C2 | 1 | E10 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: a.value |
| C2 | 1 | E13 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: o.object |
| C2 | 1 | E16 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: row_id |
| C2 | 1 | E17 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: object |
| C2 | 1 | E24 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: object |
| C2 | 2 | E03 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: d.object |
| C2 | 2 | E04 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: d.object |
| C2 | 2 | E07 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: d.object_id |
| C2 | 2 | E08 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: a.object |
| C2 | 2 | E10 | judge invalid_output: no JSON object in the reply |
| C2 | 2 | E16 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: object_id |
| C2 | 2 | E17 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: object |
| C2 | 2 | E24 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: object |
| C2 | 3 | E03 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: d.object_id |
| C2 | 3 | E04 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: d.object_id |
| C2 | 3 | E07 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: d.object |
| C2 | 3 | E08 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: a.object_id |
| C2 | 3 | E10 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: o.value |
| C2 | 3 | E13 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: o.value |
| C2 | 3 | E17 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: object |
| C2 | 3 | E24 | judge invalid_output: refutation SQL failed to run: sqljs: no such column: object |
| C2 | 3 | E37 | 1 of 6 findings not judged: invalid output: the selection holds no valid check (checks is not an array) |
| C2 | 3 | E38 | 1 of 5 findings not judged: judge invalid_output: refutation SQL failed to run: sqljs: no such column: row_id |
| C3 | 2 | E13 | invalid output: the selection holds no valid check (checks is not an array) |
| C3 | 3 | E08 | judge invalid_output: no JSON object in the reply |
| C4 | 1 | E37 | 6 of 6 findings not judged: direct: receipt gate: custody: failed on both attempts, answer discarded, not judged; the receipt is not for this request; request_id match, prompt_preview mismatch (a prefix of nothing we sent), app match (drift-agent-client-1), cache miss |
| C4 | 1 | E38 | 5 of 5 findings not judged: direct: receipt gate: custody: failed on both attempts, answer discarded, not judged; the receipt is not for this request; request_id match, prompt_preview mismatch (a prefix of nothing we sent), app match (drift-agent-client-1), cache miss |
| C4 | 2 | E37 | 6 of 6 findings not judged: direct: receipt gate: custody: failed on both attempts, answer discarded, not judged; the receipt is not for this request; request_id match, prompt_preview mismatch (a prefix of nothing we sent), app match (drift-agent-client-1), cache miss |
| C4 | 2 | E38 | 5 of 5 findings not judged: direct: receipt gate: custody: failed on both attempts, answer discarded, not judged; the receipt is not for this request; request_id match, prompt_preview mismatch (a prefix of nothing we sent), app match (drift-agent-client-1), cache miss |
| C4 | 3 | E37 | 6 of 6 findings not judged: direct: receipt gate: custody: failed on both attempts, answer discarded, not judged; the receipt is not for this request; request_id match, prompt_preview mismatch (a prefix of nothing we sent), app match (drift-agent-client-1), cache miss |
| C4 | 3 | E38 | 5 of 5 findings not judged: direct: receipt gate: custody: failed on both attempts, answer discarded, not judged; the receipt is not for this request; request_id match, prompt_preview mismatch (a prefix of nothing we sent), app match (drift-agent-client-1), cache miss |

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

| config | run | item | verdict | reading |
| --- | --- | --- | --- | --- |
| C0 | 1 | E37 | HOLD | no |
| C0 | 1 | E38 | HOLD | no |
| C0 | 2 | E37 | HOLD | no |
| C0 | 2 | E38 | HOLD | no |
| C0 | 3 | E37 | HOLD | no |
| C0 | 3 | E38 | HOLD | no |
| C1 | 1 | E37 | HOLD | no |
| C1 | 1 | E38 | HOLD | no |
| C1 | 2 | E37 | HOLD | no |
| C1 | 2 | E38 | HOLD | no |
| C1 | 3 | E37 | HOLD | no |
| C1 | 3 | E38 | HOLD | no |
| C2 | 1 | E37 | HOLD | no |
| C2 | 1 | E38 | HOLD | no |
| C2 | 2 | E37 | HOLD | no |
| C2 | 2 | E38 | HOLD | no |
| C2 | 3 | E37 | not judged | - |
| C2 | 3 | E38 | not judged | - |
| C3 | 1 | E37 | HOLD | no |
| C3 | 1 | E38 | HOLD | no |
| C3 | 2 | E37 | HOLD | no |
| C3 | 2 | E38 | HOLD | no |
| C3 | 3 | E37 | HOLD | no |
| C3 | 3 | E38 | HOLD | no |
| C4 | 1 | E37 | not judged | - |
| C4 | 1 | E38 | not judged | - |
| C4 | 2 | E37 | not judged | - |
| C4 | 2 | E38 | not judged | - |
| C4 | 3 | E37 | not judged | - |
| C4 | 3 | E38 | not judged | - |
