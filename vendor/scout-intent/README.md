# Meterless Scout Intent: smoke-set data

These files are data copied byte for byte from https://github.com/Meterless/Meterless, directory
`engines/scout-intent`, at commit `1742dec56a66e58eef9dda2d2b865823758ca8cd`. The licence is Apache-2.0, copyright
2026 Meterless; the full text is in `LICENSE` here, and upstream ships no NOTICE file at that commit.

| File here | Upstream path under `engines/scout-intent/` |
|---|---|
| `LICENSE` | `LICENSE` |
| `evals/fixtures/intents.json` | `evals/fixtures/intents.json` |
| `evals/regression-set/v1/intents/*.jsonl` | the same paths: deal 6, email 4, research-and-plan 5 examples |
| `evals/regression-set/v1/injection/adversarial.jsonl` | the same path: 10 examples, 7 injections and 3 clean controls |
| `evals/regression-set/v1/multi-intent/composed.jsonl` | the same path: 3 examples |
| `evals/regression-set/v1/edge-cases/clarification.jsonl` | the same path: 4 examples |

The corpus is the 32-example v1 smoke set that upstream's eval harness ships.

Nothing else from the Meterless repository is here. No upstream code is copied, installed, built or run: the spec has
no reference implementation, and its eval runner is not used. `src/guard/smoke.ts` is this repository's own runner over
these files, and `npm run scout:smoke` prints its result.

`UPSTREAM.json` lists each copied file with its git blob id at the commit above. `test/vendor.test.ts` hashes every file
here (CRLF read as LF) against that id, so a changed byte, a missing file or an added file fails the test. This README
and `UPSTREAM.json` are written in this repository and are not upstream files.

The upstream thresholds are release targets for a corpus of larger scale. This repository quotes counts on the 32
examples only, in the form "N of M on the Meterless smoke set".
