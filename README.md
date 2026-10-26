# ConfigLeaf

ConfigLeaf, package `drift-agent`, is a configuration assurance agent for an MSP. An MSP's knowledge of one setting
could live in eight different places, and whether that setting is: Correct, Documented, Backed-Up, Restorable, and
Relevant takes an awareness of many sources at once. ConfigLeaf reads the eight as one through one Zetaris layer and
decides each finding under the MSP's policy: ROLLBACK, FIX, ESCALATE, HOLD with an expiry, or ADOPT.

The eight places: the live host (over SSH), the nightly export (the backup tarball), the documentation of record
(`approved_setting`, the rows an IT Glue or Hudu adapter would write), the DNS provider (Cloudflare), the provider's
audit log and each host's journal, the asset inventory, what the site answers from outside (the probes), and the PSA
(the tickets).

The estate is the operator's own two production hosts and six zones, run as one MSP tenant named `client-1`, and the
23 adoptions are his accepted exceptions for it.

Three commands need no credentials, no model and no `.env` (Node 22 or later, after `npm install`); on 25 Oct 2026 the
first gives 27 findings, ADOPT 23, HOLD 3 and ESCALATE 1:

```bash
SAMPLE_MODE=true npm run sample                         # the whole pass over the recorded rows
npm run site                                            # the replay page in docs/, every check re-run to its recorded count
SAMPLE_MODE=true npm run document -- --tenant client-1  # the owner's document and report: examples/document.md, examples/report.html
```

| Development set, three runs of each configuration | Current: per-call scope, `eval/results/2026-10-25T23-34-17Z`, 25 Oct 2026 23:34 UTC | Shared scope, `eval/results/2026-10-25T09-25-44Z`, 25 Oct 2026 09:25 UTC |
|---|---|---|
| Nemotron 3 Ultra alone (C4) | agrees on 3, 4 and 3 of 9; reads yes on 6, 5 and 6 of the 9 labelled no | agrees on 3 of 9; reads yes on 6 of the 9 labelled no |
| The SQL checks with Ultra as the falsifier (C3) | agrees on 9 of 9, 8 of 8 and 8 of 8; reads yes on 0 of 9 | agrees on 9 of 9, 9 of 9 and 8 of 8; reads yes on 0 of 9 |
| Planted false claims the falsifier strikes (C3) | 9, 8 and 8 of 10 | 9 of 10 in each run |
| Model calls | 390, all receipted, 384 receipts published and verified offline | 389, 383 of them receipted, 380 receipts published and verified offline |
| Nightshift's own memory in the prompt (`hmem` on the published receipts) | 0 of 384 | 281 of 380 |

- **Zetaris**: every query of a live pass runs through Lightning SQL over the `DRIFT` datasource, with the `drift_usl` semantic layer and its DQ rules over it ([Zetaris](#zetaris)).
- **Meterless**: the World Model holds the observations and the fingerprints FOUND-BUT-DIFFERENT compares, H-MEM holds the technician's lessons, and Nightshift serves Nemotron and signs a receipt for every call ([Meterless](#meterless)).
- **NVIDIA Nemotron**: 3.5 Lightning selects the checks and 3 Ultra writes the SELECT that refutes a false claim, each verdict counted through the receipt gate ([Nemotron](#nemotron)).

## What it is

A configuration assurance layer above the MSP tool stack that remembers. For every setting it can reach it asks:
does a configuration exist for everything that should; is it fully configured; is it backed up; what exactly is in
the copy, against what the policy rule that governs it says should be there; has it changed since the copy; can the
copy be restored (it validates, its dependencies exist); would a restore regress, and of what kind; and is it
FOUND-BUT-DIFFERENT: a byte-identical setting whose referent now means something else. The agent acts under the
MSP's policy: a critical setting that drifted from its approved value, with a valid copy, is rolled back to the copy,
verified and documented; a drifted setting with no valid copy and production affected is investigated, fixed where
allowed, documented and ticketed; everything else is adopted or held with a reason and an expiry. A config lock on a
setting class means automatic rollback at the next cycle.

The agent reads the eight places as one. The detector and check SQL joins the first six, with each source's asserted
population; the probes decide whether production is affected, and the PSA carries the tickets. Every question it
answers is a join across two or more of those sources through one Zetaris layer (the `DRIFT` datasource, with the USL
and its DQ rules over it), and FOUND-BUT-DIFFERENT exists only in that join: unchanged bytes on the host, a changed
answer from the DNS provider, an address the inventory lacks. Within the sources it is given, the agent discovers the
population of each source before it reads a row (so a short read fails the DQ gate), every file a configuration
pulls in, every regular member of the newest backup tarball, every dependency a restore needs that the vault holds no
copy of (named by the validator), every name a zone serves, and what is absent: an approved setting with no
observation (`approved_missing`). Its sources are configured: the hosts `LINUX_HOSTS` lists and one Cloudflare
account. This agent is the assurance layer; a management surface above it, every setting with its live, approved and
recommended state, a lock flag and a template, with unlock, change and lock as the technician's gesture, is the next
layer, and the owner's report (`report.html`) is its first read-only pane.

Entry for the GenAI Works Open Agent Hackathon 2026, Track 1 (Solving Fragmented Intelligence): "Demonstrate a
clever ability to discover and work across fragmented data sources."

The hackathon slice: nginx vhost files and the Cloudflare records they depend on, through the whole loop, on the
operator's two production hosts and six zones. Each finding ends in one of five verbs (ROLLBACK, FIX, ESCALATE, HOLD
with an expiry, ADOPT), recorded in the disposition ledger. The Actor carries out ROLLBACK and FIX behind `--apply`
and prints its plan as a dry run without it; the ticket step opens, comments on and closes GitHub issues; the owner's
document is rendered from SQL; `npm run cycle` runs every step once, `npm run watch` on a schedule.
[DESIGN.md](DESIGN.md) holds the design.

## What it does

1. **Collect and vault.** The Linux collector streams a fixed script of reads over one SSH session per host, the journal's sudo commands and ssh logins of the last 24 h among them; the Cloudflare collector reads the zones, the records and the account audit log with a read token. Each asserts its population before its first row, redacts every row on its way into the app Postgres and commits a complete run to the vault, where `validate:copies` checks that each copy restores and `probe` asks every served name from outside.
2. **Gate.** The gate, `RUN_COMPLETE_SQL` through Zetaris, fails a run that observed fewer objects than it asserted, finished other than complete or never asserted a population, or, on a host surface, stored fewer rows than it asserted; a failing run feeds nothing below. The DQ rule `run_complete` on `drift_usl.collection` registers the same self-report predicate in Zetaris, and `npm run zetaris:setup` runs it.
3. **Verify through Zetaris.** The hero query (a byte-identical setting pointing at a name that now resolves outside the inventory), the estate survey and the three detectors (`drift_vs_approved`, `changed_since_backup`, `approved_missing`) run as SQL through one DataLayer over the `DRIFT` datasource, then the precondition catalogue checks each finding. In sample mode the same SQL runs on sql.js over the exported bundle.
4. **Triage and judge with Nemotron, under a receipt gate.** Each finding gets the precondition checks for its class; under investigation, Nemotron Lightning picks the checks and Nemotron Ultra judges the claim with one SELECT that returns rows only when it is false. A verdict counts only when its signed receipt verifies, names the tier requested and passes custody.
5. **Decide under the policy.** The Decider applies the technician's exception first, then the policy rule that governs the setting, then the default, and gives one of five verbs with a one-sentence reason. A HOLD carries the rule's expiry, and past it the finding is ESCALATE.
6. **Record.** One `disposition` row per finding per pass goes to the ledger, keyed on the live value, the run and the instant decided. A finding that rests on a DNS record also gets its exposure line: since when the record has been in that state, read from the audit log.
7. **Explain.** For every ROLLBACK, FIX and ESCALATE, and every HOLD of a drifted, missing or moved setting, the explainer states who or what changed it, when and how, from rows the agent already holds and no model: the vault's approved copy against the live one, each host's journal, the Cloudflare audit log and the agent's own actions. Each cause is one `finding_cause` row with its class, its evidence, the diff and one sentence ([Why it changed](#why-it-changed)); a cause changes no disposition, and a dry run explains too.
8. **Act behind `--apply`.** The Actor turns a ROLLBACK into `rollback_file` or `revert_record` and a FIX into `investigate`, then `fix`, and verifies every write with probes. Without `--apply` it prints the plan and writes nothing.
9. **Ticket and document.** The ticket step opens, comments on and closes GitHub issues by verb and by the rule's `alert`, each with the finding's Why. The owner's document renders one markdown page per tenant from 15 named queries, 16 when it lists a cause. The owner's report, `report.html` beside it, renders the same rows as one HTML file an owner or a client opens with no install: what needs a person and who holds it, what is held and adopted, what the agent did, and the latest read of every source with its DQ gate result.

### The pipeline and the three roles that check each other

ConfigLeaf is one pipeline of named stages, and three roles inside it check each other: Nemotron 3.5 Lightning
selects the checks, Nemotron 3 Ultra writes the SELECT that refutes a false claim, and the SQL guard, the receipt gate
and the replay page's build re-run validate both. Every trace line names the stage that wrote it (`agent`,
`src/trace.ts`), and a query line names the stage that sent the query. The stages of the committed traces, of
`npm run sample` and of the eval:

| agent | what it does | module |
|---|---|---|
| `collector` | The Cloudflare collector's run line (zones, records and the audit log, each population asserted before the first row); in sample mode, the load of `sample/bundle.json` into sql.js. | `src/collectors/cloudflare.ts`, `scripts/collect-cloudflare.ts`, `scripts/sample.ts` |
| `collector.linux` | One SSH session of fixed reads per host, and the run it stored, its population asserted before the first row. | `src/collectors/linux.ts`, `scripts/collect-linux.ts` |
| `vault` | Commits each complete run to its vault repository, one line per run. | `src/vault/hook.ts` |
| `observer` | Reads the collection runs, gates each with `run_complete`, and loads every observation of a passing host run, with what its DNS names resolve to, into the World Model. | `src/pipeline.ts`, `src/engine/world.ts` |
| `detector` | Runs the hero query, the survey and the three detectors, and raises each finding with its class. | `src/pipeline.ts`, its SQL in `src/data/queries.ts` |
| `checker` | Runs the precondition checks of the finding's class from the catalogue, each a SELECT, and skips the rest under the stop rule. | `src/pipeline.ts` over `src/catalogue/` (`templates.ts`, the defaults in `select.ts`) and `src/stoprule.ts` |
| `judge` | Asks Nemotron for one SELECT that returns rows only when the claim is false, guards and runs it, and counts the verdict through the receipt gate; in a pass with no model its line reads `skipped`. | `src/agents/judge.ts` |
| `selector` | The eval's Lightning call that picks and parameterises checks from the catalogue, in C1 to C3. | `src/eval/models.ts` |
| `decider` | Reads the policy rules and the prior HOLDs, recalls the technician's lessons, gives the verb with its reason and records the exposure line. | `src/pipeline.ts`, `src/policy/decide.ts`, `src/engine/world.ts` |
| `explainer` | States who or what changed each setting the pass moves on, from the vault diff, the host journals, the Cloudflare audit log and the agent's own actions, with no model, and writes one `finding_cause` row per explained disposition. | `src/explain/` |
| `actor` | Plans and carries out `rollback_file`, `revert_record`, `investigate` and `fix`, and verifies each write by probe; Lightning's selection inside `investigate` is traced under this name. | `src/actions/` |
| `psa` | Opens, comments on and closes GitHub issues by the ticket rules. | `src/psa/` |
| `documenter` | Runs the 15 named queries of the owner's document, 16 when it lists a cause. | `src/document/render.ts` |
| `loop` | The pass's run list, its ledger read-back and its summary line. | `src/loop/pass.ts` |
| `cycle` | One line per step of a cycle with the step's time, and the cycle's summary. | `src/loop/cycle.ts` |

`npm run preflight` writes the pass's lines under the agent `preflight`, the pass's own agent in `target_agent`.

## Run it

Requirements:

- Node 22 or later and npm. `npm install` brings the four runtime libraries, `openai`, `pg`, `sql.js` and `zod`; sample mode needs nothing more.
- For live mode: Docker for `npm run validate:copies` (the `nginx:1.27` image; on Windows the Docker engine in the WSL distribution `Ubuntu-24.04`) and openssl on the PATH; PostgreSQL for the app store (`DATABASE_URL`); `ssh`, with the `LINUX_HOSTS` aliases in its ssh_config, and a Cloudflare read token; the `gh` CLI, signed in, for the GitHub Issues PSA; Zetaris, the local bundle, its REST API on `localhost:8888`, with an API key ([Zetaris](#zetaris)); and Meterless Nightshift, the installed runtime, OpenAI-compatible on `127.0.0.1:8088`, with its runtime token file ([Meterless](#meterless)). The organisers' Participant Setup Guide describes both installs.

Sample mode needs no credentials, no model and no `.env`; it runs the real pass over the redacted export,
`sample/bundle.json`:

```bash
npm install
SAMPLE_MODE=true npm run sample                         # the whole pass over the recorded rows
SAMPLE_MODE=true npm run preflight -- --proposal examples/proposals/a-unproxy-www.json   # GO, NO-GO, GO-IF or ESCALATE for one change
SAMPLE_MODE=true npm run document -- --tenant client-1  # the owner's document and report -> examples/document.md, examples/report.html
SAMPLE_MODE=true npm run console                        # the technician's console on http://127.0.0.1:8090/: every setting with its lock; Unlock, Approve, Lock
npm run answer -- --finding <fnd-id> --accept --until <ISO 8601 UTC> --reason "..."   # teach one exception -> DRIFT_MEMORY_DIR; --list, --forget <id>
npm run eval -- --set dev --configs C0                  # the pre-registered eval with no model -> eval/results/<UTC stamp>/
npm run receipts:verify -- lab                          # the lab's signed receipts, offline; eval/results/2026-10-25T23-34-17Z for the development run's, against its call records
npm run site                                            # rebuild the replay page in docs/ from examples/ and the newest eval/results/
npm run sources                                         # the table under "Where each answer comes from", read off the SQL
npm test
```

`npm run sample` prints the cycle's table: a header naming the tenant and the recorded estate, one row per stage
(load, gate, observe, detect, decide, explain, document, report, judge) with its counts, the finding classes in plain
words, the findings a person owns with the cause the explain step finds over the recorded rows
([Why it changed](#why-it-changed)), the two files it writes, then the "what happened" sentences and a done line
naming the trace. The trace, one JSON line per step, goes to `logs/sample_<id>.jsonl`, gitignored, its last line the
`SAMPLE:` summary. `--verbose` prints the trace on stdout as well, with a JSON object per finding (its short id,
`fnd-` plus 16 hex, is what `npm run answer` takes) and a `DISPOSITION` line per finding; `--quiet` prints the header
and the done line; `--json` prints the `SAMPLE:` summary line alone. The technician's lessons come from the directory
`DRIFT_MEMORY_DIR` names. Blank, it is `examples/memory`
in sample mode and for `npm run examples` and `npm run site`: the committed store of the operator's 23 accepted
exceptions, so a clone with no `.env` decides with them and `npm run site` rebuilds `docs/` byte-identical; CI sets
the same directory. Blank for the live commands, it is `.world/memory`, gitignored, and `.env.example` sets
`examples/memory`. On 26 Oct 2026 the sample pass prints ADOPT 23 under those exceptions, HOLD 3 and ESCALATE 1, and
one cause, the ESCALATE's.

The owner's report is `report.html`, one HTML file beside `document.md` that `npm run document` and every cycle write
from the document's rows, and [examples/report.html](examples/report.html) is the one over the recorded bundle, which
`npm run sample` (its report row), `npm run document` in sample mode and `npm run examples` write
byte for byte alike; `npm run sample` writes it and [examples/document.md](examples/document.md) only when their bytes
differ from the files on disk, and its rows say which.

The committed inputs and their outputs sit under [examples/](examples/), each described in
[examples/README.md](examples/README.md): the three cases `examples/<case>/` (`proxy-split`, `wildcard-no-real-ip`,
`orphans`), each a `bundle.json` in and the `findings.json` the pass computed over it out; the four proposals in
`examples/proposals/`, each a `*.json` in and its `*.verdict.json` out; and [examples/traces/](examples/traces/), four
redacted traces of 25 Oct 2026: the lab's investigation with Nemotron; the operator's rehearsal cycles on the
production estate with `--apply`, the one of 16:49 to 16:51 UTC that raised FOUND-BUT-DIFFERENT on real rows and
reverted the record through the provider, and the one of 18:08 to 18:16 UTC that investigated a FIX; and the lab's
explain cycle, 20:24 to 20:26 UTC with `--apply`.

Live mode starts with `cp .env.example .env` and its keys filled in, each described in [.env.example](.env.example):
`DATABASE_URL`, `ZETARIS_API_KEY`, `ZETARIS_PG_HOST`, `CLOUDFLARE_API_TOKEN`, `LINUX_HOSTS`, `DRIFT_VAULT_DIR`,
`DRIFT_POLICY_FILE`, `DRIFT_MEMORY_DIR`, `DRIFT_TICKETS_REPO`, `REDACT_SALT`, `REDACT_WORDS`, `EXPORT_DENY_WORDS`; the
Nightshift and GitHub tokens are read at run time. In cycle order, after the one-time setup:

```bash
npm run zetaris:setup                                   # once: the DRIFT, LESSONS and RULES datasources, the fourteen-entity USL, five DQ rules
npm run policy:load -- --tenant <id>                    # once per policy version: the policy file -> policy_rule rows
npm run collect:cloudflare -- --tenant <id>             # DNS records and the audit log -> Postgres and the vault
npm run collect:linux -- --host <alias> --tenant <id>   # one SSH session of fixed reads, per LINUX_HOSTS alias
npm run approve -- --tenant <id> --host <alias>         # once, after the first collection: sign off a host's files; --all for every record
npm run probe -- --tenant <id>                          # http, dns and tls on every served name
npm run validate:copies -- --tenant <id>                # nginx -t and cf-schema over the newest vault commits
npm run pass -- --tenant <id>                           # the pass through Zetaris; dispositions -> the ledger
npm run act -- --tenant <id>                            # the Actor's plan, a dry run; --apply carries it out
npm run tickets -- --tenant <id>                        # GitHub issues by the ticket rules; --dry-run prints the plan
npm run document -- --tenant <id>                       # the owner's document and report -> document.md, report.html
npm run cycle -- --tenant <id>                          # collect, probe, validate, pass, explain, act (dry run), tickets, document, once
npm run watch -- --tenant <id> --every 60               # the cycle every 60 minutes until SIGINT
npm run receipts:export -- --results <dir>              # after an eval run: its signed receipts -> receipts.json beside its call records; --from runtime reads the runtime's own log
```

## What it proves

Measured on the operator's estate, tenant `client-1`, and the writes on the lab estate, tenant `lab-1`
([lab/README.md](lab/README.md)), dates in UTC; the replay page in [docs/](docs/) holds the detail, and its
[Nemotron tab](docs/index.html#nemotron) holds the eval's model calls.

| Command | Proves | Measured |
|---|---|---|
| `npm test` | Every module against fixtures, fakes and a throwaway Postgres schema; the live halves run behind their flags. | 1,181 tests in 45 files on the operator's machine: 1,062 run and pass, 0 fail, and 119 wait for their live flags (113 for `PARITY_LIVE`, 3 for `VALIDATE_LIVE`, 1 each for `EVAL_LIVE`, `PROBE_LIVE` and `TICKETS_LIVE`), 26 Oct 2026 02:38 UTC. |
| `PARITY_LIVE=true npx vitest run test/parity.test.ts` | Every query the agent runs returns the same columns, rows and totals on sql.js and on Zetaris over the same rows. | The suite holds 112 cases, the `change_window` table among them. On 25 Oct 2026, at the export instant of the 13:53 UTC cycle, 107 of 107 cases equal, 17,364 observation rows read whole on both engines. The live half compares the recording's rows, and `DRIFT` holds rows written since that export, so the live half runs against a fresh export (`npm run export:bundle`). |
| `SAMPLE_MODE=true npm run sample` | The whole pass over `sample/bundle.json`, with no credentials, no model and no `.env`, deciding with the committed lessons in `examples/memory`. | 80 runs, 14,174 observations, 27 findings: ADOPT 23 under the operator's accepted exceptions, HOLD 3 and ESCALATE 1 by policy, decided at 2026-10-25T14:17:53.416Z; the explain step over the pass, 1 cause, the ESCALATE's, unknown with its 18 h window stated; 30 lines on stdout off a TTY, none of them a trace line (the header, a row per stage from load to judge, the "what happened" sentences and the done line), byte-identical over two runs outside the header's minute, the done line's time and the trace id; the decide row's DQ line reads `exception_in_force` holds for 23 of 23 ADOPT under an exception (over the ledger and the `lesson` table sql.js holds as Zetaris holds `LESSONS.lesson`), and with every `.env` value blanked the rows are the same, the deny-list probe counting 0 configured labels (49 with `.env`); the 806 trace lines (14 of them a later ask of a read the pass shares, naming who reused it) go to `logs/` only, each with its own `ts`, `latency_ms` and `trace_id`, the last one the `SAMPLE:` summary line that `--json` prints alone, 26 Oct 2026. |
| `npm run collect:cloudflare`, `npm run collect:linux` | The collectors read the live estate in full, each population asserted before the first row. | 58 of 58 records in 6 zones, 1,014 of 1,014 audit rows, 24 of 24 and 14 of 14 vhost files, at 13:53 UTC, 25 Oct 2026. |
| `npm run vault:status` | Every complete run is one commit in a per-host or per-account git repository. | 3 repositories of 11, 12 and 12 commits, 58, 32 and 22 files at the heads, 25 Oct 2026. |
| `npm run validate:copies` | Each newest vault commit restores to a tree `nginx -t` accepts and each record copy passes its schema, every missing dependency named. | both nginx trees ok_with_gaps (16 and 13 gaps), records 42 ok and 16 ok_with_gaps, 0 fail, 24 Oct 2026. |
| `npm run probe` | http, dns and tls on every served name, from outside, as one collection run. | 37 names, 111 of 111 probes complete, 20 failing, the same counts in 11 runs from 24 Oct 19:59 to 25 Oct 13:53 UTC, 25 Oct 2026. |
| `npm run approve` | The documentation of record, written from the latest passing run, idempotent. | 333 approvals, then 0 written over the next runs, 24 Oct 2026. |
| `npm run policy:load` | The MSP's policy file, validated against a closed schema, redacted and stored as versioned rules. | version 2: 15 rules written, a second load 0, 24 Oct 2026. |
| `npm run pass` | The live pass through Zetaris writes one disposition per finding to the ledger and reads each back through Zetaris. | 27 findings and 27 dispositions written and read back in each of 12 live passes, from 24 Oct 23:21 to 25 Oct 13:54 UTC; the ledger holds the 324 rows, 25 Oct 2026. |
| `npm run act -- --apply` | The Actor carries out a ROLLBACK and a FIX on a real host, verifies every write with probes and records each action. | On the lab: `rollback_file` done at 09:53 UTC, the copy written, `nginx -t` passed, nginx reloaded and the write verified by probe `probe-36eb2c1bba298a2a`; a FIX investigated inside the Actor, Lightning's selection on receipt `rcpt_req_nn4ag0yu` and Ultra's verdict on receipt `rcpt_req_iehg9gmt`, both verified, and its `fix` refused without a valid copy; a rollback at 05:47 UTC completed with no probe of the lab's names and is `unverified`, 25 Oct 2026. |
| `npm run cycle` | One cycle of the loop, every step once, the first failing step stopping it; the screen counts the queries it sends through Zetaris. | 9 of 9 steps ok in 101.5 s, a dry run, the 13:53 UTC cycle of 25 Oct 2026. On the lab at 18:28 UTC, a dry run with collect, probe and validate skipped: the pass sent 398 Lightning SQL queries over `DRIFT` (26,155 rows, 0 failed) and the cycle 434 (27,043 rows, 0 failed), each count equal to the query lines of its trace, 25 Oct 2026. |
| `npm run watch` | The cycle on a schedule, each cycle traced to its own file. | 7 cycles every 45 minutes from 09:23 to 13:53 UTC, a dry run: 9 of 9 steps ok in each, 75.0 to 101.5 s a cycle, 101.5 s the last, 0 failed, 25 Oct 2026. |
| `npm run tickets` | One GitHub issue per ticket row, opened, commented on and closed by the ticket rules. | the smoke opened, commented on and closed issue #1 and a cycle opened issue #2 for the `proxy_split` HOLD, 24 Oct 2026; the first cycle after that HOLD expired commented on #2, 25 Oct 2026. On the lab, issue #3 opened as the FIX's incident with the investigation under Evidence and stays open, and issue #4 opened and closed as the rollback's change with its verification probe, 25 Oct 2026. `sample/bundle.json` carries the three ticket rows, #2 on the estate and #3 and #4 on the lab, each URL redacted. |
| `SAMPLE_MODE=true npm run console` | The technician's console over the recorded rows with no services: every page rendered on the server with no external resource, every object with its lock from the policy, and a change window that holds a drift the locked rule would roll back. | Over `sample/bundle.json` for client-1: up in 3.1 s, 8 pages and the report answer 200 in under 40 ms; Settings lists 112 objects, 54 files on 2 hosts and 58 records in 6 zones, 79 locked by rule and 33 open. `test/console.test.ts`, 18 tests: over `test/fixtures/policy-bundle.json` app.conf's `drift_vs_approved` is ROLLBACK, HOLD with the window's reason after Unlock and a pass, and ROLLBACK again after Lock; Approve runs the approve module and closes the window; a POST without the page's token is refused, 26 Oct 2026. |
| `npm run document` | The owner's document: one page per tenant from 15 named queries, 16 when it lists a cause, through the deny-list probe before it is written. | Under `SAMPLE_MODE=true`: 27 findings open, ADOPT 23, HOLD 3 and ESCALATE 1, decided at 2026-10-25T14:17:53.416Z, the Why one line, the ESCALATE's cause; `examples/document.md` byte-identical on a second render, 25 Oct 2026. |
| `npm run eval -- --set dev --configs C0 --runs 2` | The pre-registered eval of [eval/PROTOCOL.md](eval/PROTOCOL.md). | C0 on the 15 development items under `policy/hackathon.json` version 2: 11 scored, 11 with a verdict, agreement 9 of 9 (Wilson 95% 0.701 to 1.000), 0 of 9 labelled no read yes, 0 differences between runs, 25 Oct 2026. |
| `npm run receipts:verify -- eval/results/2026-10-25T23-34-17Z`, `npm run receipts:verify -- eval/results/2026-10-25T09-25-44Z`, `npm run receipts:verify -- lab` | The runtime's signed receipt for each receipted model call, published beside the call record that names it and checked offline with no `.env` and no network: the Ed25519 signature, the served model and tier, `app` `drift-agent-<tenant>`, `request_id`, `cache.status` and the preview the gate read. | The development run of 25 Oct 2026 23:34 UTC, under per-call scope: 390 of 390 call records carry a receipt; 384 are published with 384 of 384 signatures verified and 6 are withheld by the export's probe and listed in `receipts-withheld.json`; 0 served model, tier, app or cache mismatches; 372 counted calls whose preview opens with the request line, and the 12 custody refusals of C4 as recorded; `hmem` null on all 384, 26 Oct 2026. The run of 25 Oct 2026 09:25 UTC, under the shared scope: 383 of 389 call records carry a receipt, and the other 6, C2 judge calls, carry none, every route of the failover ladder failing (the last with a 502) and the gate refusing them; of the 383 receipts, 380 are published with 380 of 380 signatures verified and 3 are withheld by the export's probe and listed in `receipts-withheld.json`; 0 served model, tier, app or cache mismatches; 368 counted calls whose preview opens with the request line, and the 12 custody refusals of C4 as recorded, 25 Oct 2026. The lab: 3 of 3 verified under `drift-agent-lab-1`. One signing key throughout, the key of the 23 Oct probe receipts, 26 Oct 2026. CI runs it over every committed `receipts.json` on every push to main and every pull request ([ci.yml](.github/workflows/ci.yml)). |
| `npm run site` | The replay page, built from [examples/](examples/), the committed lessons in `examples/memory`, the repository's SQL and the newest [eval/results/](eval/results/) (`--results` names another): every finding with every check re-run to its recorded count before anything is published, the owner's document as its Document tab, "Where each answer comes from" as its Sources tab, both rendered to HTML at build time, and the [Nemotron tab](docs/index.html#nemotron): the eval's calls, requested and served, and every judge SELECT recorded with a row count re-guarded and re-run over the recording, the build refused on any count that differs. The header counts each finding once by its finding id, and a tile above its counts sets Ultra alone beside the checks with Ultra as the falsifier, per run, from the same results. | 8 findings by finding id (ADOPT 4, HOLD 3, ESCALATE 1), 9 rows over the three slices with the one `proxy_split` in two, 33 checks re-run equal, the 196-line document decided at 2026-10-25T14:17:53.416Z, the 9 class rows; the tile over `eval/results/2026-10-25T23-34-17Z`: items labelled no read as yes 6, 5 and 6 of 9 for Ultra alone (C4) and 0 of 9 in each run for C3, planted claims struck by C3 9, 8 and 8 of 10; the Nemotron tab over the same run (dev): 390 calls, 390 receipts verified at run time (384 published and verified offline, 6 withheld), 0 substitutions, 134 judge SELECTs, 130 re-run equal and the recorded text of 4 (C3 run 1, P09 and E24; C3 run 3, E17 and E24) refused by the engine; 315,407 bytes of the 350,000-byte budget, a rebuild byte-identical, 26 Oct 2026. |
| `npm run conformance`, `npm run conformance:hmem` | The vendored Meterless suites pass: the World Model suite runs through `src/engine/world.ts`, and the H-MEM suite runs through the reference class that `src/engine/memory.ts` re-exports. | World Model 8 of 8; H-MEM 13 of 13 and the `TechnicianMemory` wrapper check, 25 Oct 2026; and in CI on every push to main and every pull request ([ci.yml](.github/workflows/ci.yml)). |
| `npm run spike:nightshift` | Nightshift serves Lightning and Ultra by explicit id, signs a receipt for each call that verifies offline, and tracks the app as a job whose event stream replays its turns. | 9 of 9 PASS: 142 model ids listed, Lightning in 3,107 ms and Ultra in 1,625 ms on their OpenRouter routes, 100 of 100 listed receipts verified, this run's 2 receipts in the list, 65 turn events replayed, 25 Oct 2026. |
| `npm run zetaris:setup` | The idempotent setup of the `DRIFT` datasource, the `LESSONS` and `RULES` file sources, the fourteen-entity USL and its five DQ rules. | 71 statements, 0 failed; `run_complete` 140 of 140 runs valid, `exception_in_force` 184 of 184 adoptions valid, 25 Oct 2026 22:57 UTC. |
| `npm run collect:zetaris -- --tenant client-1` | Zetaris's own control plane is a collected surface, `zetaris.control`: the semantic layer's entities, the DQ rules, the grants, the datasources and the server version, read only, one observation per object of its canonical JSON with the population asserted, committed to the vault; once approved, the pass holds it to the approval, and an edited rule, a dropped entity or a widened grant is `drift_vs_approved` ESCALATE with its diff (`test/zetaris-control.test.ts`). | Run 30 of 30 objects complete (16 for the USL, 6 DQ rules, 2 for the grants, 5 for the datasources, the server), 30 rows written, its vault commit changing no file since the setup's run of 04:55 UTC; `npm run approve -- --tenant client-1 --surface zetaris.control` wrote 30 approvals; the read-only pass after it raised 0 findings on the surface, 26 Oct 2026. |
| `npm run pass` (the schema guard) | Before every live pass reads a row, the columns of the fourteen `DRIFT` tables it reads and of each `CLOUDFLARE` REST table are held to sql/schema.sql and to the fields `dns_live` reads; a missing or retyped column fails the surfaces that read it closed, their findings not checked and kept from the ledger (`test/schema-guard.test.ts`). | "schema 20 tables as expected" on the pass row for client-1 at 04:55 UTC, 21 statements, 0.96 s when the guard runs alone; the pass's EXPLAIN QUERY AS of the hero join and the `dns_live` read traced once each, 26 Oct 2026. |
| `npm run zetaris:queries` | The hero query, the survey and the detectors run through Zetaris itself. | 0 hero rows, the 27 survey findings, 0 invalid runs, 24 Oct 2026. |

## Where each answer comes from

Each finding class answers its question by joining the tables its detector query and its default checks name, and each table holds the rows of one source. The rows are read off the SQL in `src/data/queries.ts` and `src/catalogue/templates.ts` and the default checks in `src/catalogue/select.ts`.

| class | question | tables | sources |
|---|---|---|---|
| `proxy_split` | Is it fully configured? | `collection_run`, `observation`, `dns_record`, `audit_event` | live state, DNS, audit log, populations |
| `proxied_without_real_ip` | Is it fully configured? | `collection_run`, `observation`, `dns_record`, `audit_event`, `inventory_asset` | live state, DNS, audit log, inventory, populations |
| `orphan_record` | Does a configuration exist for everything that should? | `collection_run`, `observation`, `dns_record`, `audit_event`, `inventory_asset` | live state, DNS, audit log, inventory, populations |
| `orphan_vhost` | Does a configuration exist for everything that should? | `collection_run`, `observation`, `backup_snapshot`, `dns_record` | live state, export, DNS, populations |
| `changed_since_backup` | Has it changed since the copy? | `collection_run`, `observation`, `approved_setting`, `backup_snapshot`, `backup_item` | live state, export, documentation of record, populations |
| `drift_vs_approved` | Has it changed since the copy? | `collection_run`, `observation`, `approved_setting`, `backup_snapshot`, `backup_item`, `audit_event` | live state, export, documentation of record, audit log, populations |
| `approved_missing` | Does a configuration exist for everything that should? | `collection_run`, `observation`, `approved_setting`, `backup_snapshot`, `backup_item`, `dns_record`, `audit_event` | live state, export, documentation of record, DNS, audit log, populations |
| `found_but_different` | Is it FOUND-BUT-DIFFERENT? | `collection_run`, `observation`, `dns_record`, `audit_event`, `inventory_asset` | live state, DNS, audit log, inventory, populations |
| `dns_change` | Is it FOUND-BUT-DIFFERENT? | `collection_run`, `observation`, `dns_record`, `audit_event`, `inventory_asset` | live state, DNS, audit log, inventory, populations |

The sources:

- live state (`observation`): each setting as the live host answers it over SSH, and each record field as the DNS provider returns it.
- export (`backup_snapshot`, `backup_item`): the nightly export tarball of each host and every regular member of the newest.
- documentation of record (`approved_setting`): the values a technician approved; IT Glue and Hudu map here.
- DNS (`dns_record`): the DNS provider's records, Cloudflare's in this slice.
- audit log (`audit_event`): the provider's audit log, who changed which resource and when; and each host's journal of the last 24 h, the sudo commands that touch nginx and the logins, every login name pseudonymised.
- inventory (`inventory_asset`): the hosts' addresses.
- populations (`collection_run`): each source's own population, asserted before a row is read, and each run's status.

Two more sources decide what happens to a finding: the technician's memory store, which the Decider recalls from, and the policy file, which `npm run policy:load` turns into the `policy_rule` rows. Zetaris reads both as files beside `DRIFT`: `npm run zetaris:setup` writes them into its filestore and registers them. The DQ rule `exception_in_force` on `drift_usl.adoption` joins every ADOPT the ledger holds under an accepted exception to its lesson, across the two datasources.

Zetaris also reads one source itself, live: the Cloudflare DNS API, which `npm run zetaris:setup` registers as the REST datasource `CLOUDFLARE`, one table per zone, fetched again at each query. The DQ rule `dns_inventory_current` on `drift_usl.dns_live` holds every record live at the provider to the last complete DNS collection run, joined on Cloudflare's record id; a record that fails means the provider changed since that run. The file sources' rows are those of the committed files, the live source's the count measured on 26 Oct 2026:

| source | Zetaris datasource | tables | rows | what it holds |
|---|---|---|---|---|
| technician memory store (`examples/memory`) | `LESSONS` | `LESSONS.lesson`, `LESSONS.ledger` | 23 lessons, 23 ledger entries | the lessons the technician taught, in the Meterless H-MEM store, each with its tenant, scope key, expiry and provenance; the Decider recalls them, and an accepted exception makes its finding ADOPT until it expires |
| policy rules (`policy/hackathon.json`) | `RULES` | `RULES.rule` | 17 rules, version 2 | the MSP's policy, one row per rule under the rule id every disposition decided by policy names |
| Cloudflare live (`api.cloudflare.com/client/v4/zones/<zone id>/dns_records`) | `CLOUDFLARE` | `CLOUDFLARE.zone_<zone id>` | 58 records in 6 zones on 26 Oct 2026 | every DNS record at the provider now, which Zetaris fetches itself under the read token at each query; drift_usl.dns_live holds each to the last complete DNS collection run by record id, type and proxied flag |

## Policy

The MSP's policy is data: `policy/hackathon.json`, loaded by `npm run policy:load` against a closed schema into
versioned `policy_rule` rows. A rule matches a tenant, a surface and two globs and sets criticality, `lock`,
`on_drift`, `on_no_copy`, `hold_max_hours`, `alert` and `psa_priority`; the most specific match governs.

- ROLLBACK: a drift from the approved value under a locked or rollback rule, with a valid vault copy of that value.
- FIX, ESCALATE or ADOPT: the same drift with no valid copy and production affected, as `on_no_copy` says; ESCALATE when production is unknown.
- HOLD: the same drift with production answering, `on_drift` hold, or a finding about a setting's relation to another setting; the expiry runs `hold_max_hours` from the first HOLD on that live value, and past it the finding is ESCALATE.
- ADOPT: `on_drift` adopt, or the technician's exception in force; with no rule, ADOPT when every check holds and ESCALATE otherwise.

Version 2's 15 rules are in [DESIGN.md](DESIGN.md): vhost files, `nginx.conf` and a record's `content` and `proxied`
are critical and locked; copies beside live files are adopted; the rest is held. On 25 Oct 2026 the sample pass adopts
23 findings under the operator's accepted exceptions, the committed lessons in `examples/memory`, which outrank the
rules, holds the 3 `orphan_record` findings under the catch-all until 2026-10-27T23:21:06.870Z, and gives the
`proxy_split` ESCALATE, its 4-hour hold expired.

## The vault and validation

`DRIFT_VAULT_DIR` names the vault, outside the repository: one git repository per tenant and host alias with the files
at their real paths, and one per tenant for Cloudflare with a JSON file per record. Each complete run is one commit,
an unchanged run included; a partial or failed run commits nothing. Raw bytes and real names stay in the vault; commit
hashes, counts and redacted ids leave it. `npm run validate:copies` lays a commit down as a restore would, gives every
dependency outside the tree a placeholder of its kind (an empty include, a self-signed pair, the ffdhe2048 group) and
runs `nginx -t` in an `nginx:1.27` container, up to 12 rounds: ok when round 1 passes with no placeholder,
ok_with_gaps when a round passes with some, each gap named, fail otherwise. `cf-schema` checks each record copy
offline: type, content shape, a CNAME target among the run's records, an address in the inventory. On 24 Oct 2026 the
nginx gaps were certbot's certificates, keys, `options-ssl-nginx.conf` and `ssl-dhparams.pem`, an origin certificate
and key, and one credential-shaped snippet the collector skips.

## Redaction

`src/redactor.ts` runs in each collector and again in the Store, before anything is persisted: secrets become
`<secret:KIND:8hex>`, addresses `ip-XXXXXX`, logins `user-XXXXXX`, mailboxes `mail-XXXXXX@domain-XXXXXX`, hostnames
`host-XXXXXX.<tld>` and the tenant's labels (`REDACT_WORDS`) `word-XXXXXX`, every pseudonym salted with `REDACT_SALT`
so the same name is the same pseudonym in every table, which the cross-source joins rest on. A setting's `value_hash`
is an HMAC under that salt; `file` rows keep the plain sha256 to match the tarball copy. Labels are configuration: a
new product or brand needs an entry before the next collection. The probe is code: the bundle export, the owner's
document, the replay page, the eval's results and every ticket stop on any `REDACT_WORDS` or `EXPORT_DENY_WORDS` entry
standing alone. `test/leak.test.ts` runs the same probe over the committed tree, the `LINUX_HOSTS` aliases added to
the list, wherever the deny list is present: on the operator's machine, where it lives in `.env`. CI carries no deny
list ([ci.yml](.github/workflows/ci.yml)), so there the file skips with one line.

## Probes

`npm run probe` asks every A, AAAA and CNAME name from outside, one run per tenant, wildcards left out:

- http: `GET https://<name>/` answers below status 500, with `cf-ray` present for a proxied record and absent for a direct one.
- dns: a direct record's content is in the answers of two public resolvers, and a proxied record's content is in neither.
- tls: the certificate is valid for the name with more than 7 days left.

A served name whose only match is a wildcard of its zone is probed under that wildcard, whose proxied flag sets the
`cf-ray` and dns expectations (`matchName` in `src/probe/rules.ts`, the rule the Actor's verification shares); on 25
Oct 2026 that added 2 of the 22 names the vault's host heads serve to the 37, the file of ticket #5 among them, all 6
probes ok. The tickets live in the PSA repository the operator configures (`DRIFT_TICKETS_REPO`), and the committed
files carry their numbers where a trace or document line names them: in [examples/traces/](examples/traces/), #2,
#5 (closed) and #6 (opened and closed) in the 16:49 UTC rehearsal trace and #2 and #7 in the 18:08 UTC one; #2 in
[examples/document.md](examples/document.md).

Production is affected when a probe of the pass's probe run fails on a name the finding's object serves, answering
when all of them pass, and unknown with none; after a write the Actor probes again (surface `probe.verify`). On 24 Oct
2026 the three `orphan_record` names failed (two answer status 526, one presents a certificate for other names), so
those findings read production affected.

## Actions and tickets

`npm run act` acts once per disposition and kind on the latest disposition of each finding, by default as a dry run
that prints the plan and writes nothing. With `--apply` each action records its hashes, vault commit, probes, receipts
and status in an `action` row, and every write path refuses a live value that changed since the decision. The status
is one of five: `done` (written, and every verification probe ok), `unverified` (the write completed, read back equal
to the copy, and no verification probe ran or could be read, the reason naming which), `failed` (the write path did
not complete, or its read back or a probe that answered differs), `refused` (nothing written) and `not_judged` (an
investigation with no counted verdict).

- `rollback_file` (ROLLBACK on an nginx file): one SSH session writes the vault copy through `sudo -n tee`, runs `nginx -t` and reloads, writes the previous bytes back on any failure, then probes the names the file serves.
- `revert_record` (ROLLBACK on a record field): `PATCH` to the vault JSON, or `POST` for a record the zone lacks, read back field by field, then one dns probe.
- `investigate`, then `fix` (FIX): Lightning picks the checks and Ultra judges the claim; `fix` is refused without a valid copy.

Tickets go to GitHub Issues: ESCALATE and FIX open an incident, ROLLBACK a change under `alert` always or on_fix, HOLD
an incident under `alert` always; a change closes once its action is verified, and an unverified one stays open with
a comment until a pass finds the setting at its approved value; `src/psa/mapping.json` maps the columns onto HaloPSA,
ConnectWise and Autotask. On 24 Oct 2026 the policy fixture's ROLLBACK 3 and FIX 1 gave five
actions against a fake host, probe and fetch, and a second run wrote 0. A ticket opened or commented on for an
explained disposition carries a Why section right after its Evidence: the cause's sentence, one timeline line per
evidence row (`2026-10-25 15:52:07 UTC · journal · user-3f2a1c · tee · /etc/nginx/conf.d/app.conf`, from
`test/explain.test.ts`) and the diff in a fenced block.

## The technician's console

`npm run console` serves the technician's console on `http://127.0.0.1:8090/` (`--port` or `CONSOLE_PORT` names
another port), every page rendered on the server from the DataLayer the agent reads, with no external script, style or
font (`src/console/`). The pages link one stylesheet and one script from `/assets/`, each path naming its content's
hash and cached for a year; every page is `no-store` and its Content-Security-Policy holds no `'unsafe-inline'`, the
report's own style and scripts carrying the response's nonce. Overview is the owner's report, rendered on load.
Settings lists every object of the latest passing runs, one line each: its name with its host or zone, its live
value, its approval, its lock, the governing rule's family, its last change and its status, the objects with a
technician, drifted, held or in an open window first; a drawer per object holds the full path, the vault diff, the
restore proof, what a restore from the newest backup would regress, its references, its decisions, its actions with
their receipts and its change windows. Findings, Actions and tickets, Traces and Sources show the current decisions
with every time in their reasons formatted, the action and ticket rows, the tenant's trace files of `logs/` and
`examples/traces/` (those whose cycle, pass or receipts name it, a ticket's URL shown as its number), and each
source's row counts and DQ results.

Three actions change a setting, each confirmed on the page and carrying the page's token:

- Unlock opens a change window on the object: who (one line, up to 200 characters), until (1 to 72 hours from now) and why (one line, up to 500), one `change_window` row. The table holds `until` after `opened_at`, a `closed_at` at or after it and a known surface. Unlock is refused while a window is open on the object, while the windows cannot be read, and when the same object was unlocked at the same millisecond.
- Approve runs the approve module (`src/vault/approve.ts`, as `npm run approve` does) on the object from the latest passing run of its host or zone, names that run's vault commit, or says the vault holds no copy of the run or that the read failed, and closes the open window.
- Lock closes the open window and approves nothing.

While a window is open, a drift on its object (`drift_vs_approved`, `changed_since_backup`, `approved_missing`) that
the governing rule would roll back, fix or hold is HOLD until the window ends, its reason naming the window, who
opened it, its end and why, and its disposition row carrying the `window_id`; ESCALATE and ADOPT stand, and outside a
window the Decider decides as before (`src/policy/decide.ts`, step 3). The prior-HOLD read skips a row with a
`window_id`, so a window neither starts nor ends a rule's expiry. A pass that cannot read the windows escalates every
such drift a rule would roll back or fix, its reason "change windows not read: <error>; a technician decides", so a
declared change is never undone on a failed read. Over Zetaris a pass reads `change_window` only when
`SHOW DATASOURCE TABLES` lists it. Record exception records an accepted exception on a finding until a date
(00:00 UTC) or an instant in the millisecond form, as `npm run answer -- --accept` does, and Run a pass runs the pass
over the store; the console never runs act.

`SAMPLE_MODE=true npm run console` needs no services: the bundle (`--bundle`, default `sample/bundle.json`) loads
into sql.js, the sample's pass decides at the bundle's instant, and Unlock, Approve, Lock and Run a pass change the
sql.js store for the life of the process; Record exception writes `examples/memory` only with `--write`.
`--bundle test/fixtures/policy-bundle.json` loads the loop's fixture world, whose drifted `app.conf` a window holds.
Live, `--tenant` or `CONSOLE_TENANT` names the tenant, the console applies `sql/schema.sql` and the Store's migrations
when it starts (`disposition.window_id`, the `change_window` constraints), its passes are dry passes that record
nothing, and it prints one line naming `npm run zetaris:setup` when Zetaris does not list `change_window` or does not
read `disposition.window_id`; the setup applies the schema and the migrations to the app Postgres, registers the
table in `DRIFT` and refreshes the columns. On the lab, 26 Oct
2026 02:22 to 02:29 UTC through Zetaris: a window opened on `lab.example`, a `sudo -n tee` break to port 8095 and its
collection, and the console's pass gave `drift_vs_approved` and `changed_since_backup` HOLD under
rule-6c41a25a00c404c8 with the window's reason, the same file the 02:20 UTC pass with no window open gave ROLLBACK;
Approve wrote the live file as the approved value and closed the window, and the next pass gave no drift and
`changed_since_backup` HOLD 24 h, the export holding the old bytes. `test/console.test.ts` covers the window step, the
failed read, the actions and the pages offline; the migration runs in `test/store.test.ts` against a throwaway
Postgres schema.

## Why it changed

The explain step runs after the pass and before act, as agent `explainer` in the trace, and reads only rows the agent
already holds (`src/explain/`). For each finding it explains it searches one window, from the setting's current
approval (with none, the earlier of its last matching observation and 24 h back) to the pass:

- the diff: the bytes of the approval's own vault copy (the latest taken at or before the sign-off) against the live copy's, its header naming both commits, at most 40 lines, each through the redactor; for a record, the approved value against the observed one;
- the host's journal (`audit_event`, source `journal`): the sudo commands that write the file (tee, sed, cp, mv, an editor), each with the same user's nearest ssh login in the two hours before it, and the certbot and dpkg runs that touch nginx;
- the Cloudflare audit log (`audit_event`, source `cloudflare`): the changes to the record, by a named account or through an API token;
- the action ledger: a journal write of the file within 15 s of the agent's `rollback_file` on that host, or a token change within 90 s of its `revert_record` on that record, is the agent's own.

The first class that matches names the cause: `agent`, `operator_edit`, `automation`, `account_change`,
`token_change`, else `unknown`, whose sentence states the window and the rows it holds. A person's or a tool's change
ends with how long before the agent restored it, once its rollback or revert wrote; the sentences below are outputs
`test/explain.test.ts` holds:

- The file was changed at 15:52 UTC by user-3f2a1c over ssh from ip-7c1d2e (sudo tee), 2 minutes before the agent restored it.
- The file was changed at 03:12 UTC by certbot (renewal).
- The record was changed at 16:50 UTC through an API token.
- No record of who changed it: the journal window of 24 h holds 0 writes to the file and the audit log holds 0 events for the record.

Each cause is one `finding_cause` row (class, actor, mechanism, time, source address, evidence ids, diff, sentence,
window) and shows in four places: the explain row of the cycle's table (`explain   4 causes   operator 1 · agent 1 ·
unknown 2`, from `test/loop.test.ts`), after its action's sentence in the "what happened" block, as the ticket's Why, and in the Why list of the
owner's document. A login name reaches the row as the redactor's `user-XXXXXX` pseudonym, a source address as
`ip-XXXXXX`, and a command keeps its program, flags and paths only. Over the policy fixture the dry-run cycle explains
8 findings (account_change 2, unknown 6) and writes 8 rows (test/loop.test.ts). On 25 Oct 2026 on the lab estate a
`sudo tee` break, collected and run through `npm run cycle -- --tenant lab-1 --apply`, read back as operator_edit at
20:22 UTC by user-212a17 over ssh from ip-391349, with 20 evidence rows and an 11-line diff from the approval's own
vault commit, the step in 1.3 s, and after the cycle's rollback its sentence ends ", 4 minutes before the agent
restored it." (lab/README.md, "Why it changed, on the lab"; the trace in examples/traces/). In sample mode
`npm run sample` and `npm run document` run the explain step over the recorded bundle with no vault: its Cloudflare
audit rows are the evidence and it holds no journal rows, so on 25 Oct 2026 the one cause, the proxy_split
ESCALATE's, reads "No record of who changed it: the audit log window of 18 h holds 0 events for the record.", the
record's three audit events dating from 16 Apr 2026, before the approval that opens the window.

## Pre-flight

`SAMPLE_MODE=true npm run preflight -- --proposal <file>` answers one typed proposed change before it is made: the
change becomes a derived table for one call, the whole pass runs in that world, and its findings are compared with the
baseline by key, with nothing written. The verdict is GO when the change adds no finding, GO-IF when up to three
prerequisites from a catalogue clear what it adds, NO-GO when it adds a finding no prerequisite clears, and ESCALATE
when the simulation cannot run or three prerequisites leave a finding standing. On 25 Oct 2026, over the four
proposals in [examples/proposals/](examples/proposals/) and the recording of 13:53 UTC: un-proxying www GO, removing 3
findings; the 16 April body replayed GO with zero delta, the state already in force; trusted ranges on the vhost that
serves www GO, removing 2; retargeting the apex outside the inventory NO-GO, adding 2 hero findings (`found_but_different` when the previous host run paired with an earlier DNS run, `dns_change` when both pair with the same one; `found_but_different` on this recording, the 13:08 UTC host run paired with the 13:08 UTC DNS run).

## Evaluation

[eval/PROTOCOL.md](eval/PROTOCOL.md) is the contract, pre-registered: the protocol and 38 candidate items in
`b8b3d41`, the operator's labels in `fede9f7` before any model run (36 no, 2 unsure, 0 yes), the counted terms in
`f9f036f`. Each item is one real deviation or negative from the live collection and the audit log. A seeded split
gives 15 development items and 23 held out; tuning uses the development set only, and the held-out set runs once,
after the feature freeze, its results published whatever they say. Yes expects ESCALATE or FIX; no expects ADOPT, HOLD
or ROLLBACK. Every model call passes the receipt gate with a fresh nonce, a substitution invalidates its run, and the
ten planted false claims of `eval/planted.json` go to every judge. Results, with Wilson 95% intervals, land in
`eval/results/<UTC stamp>/`. C0 runs the pass as SAMPLE_MODE does with the technician's memory empty, under
`policy/hackathon.json` version 2 loaded for the recording's tenant (the protocol's changelog, 25 Oct 2026).
`npm run -s eval:table -- eval/results/<UTC stamp>` prints the lead line and table of each results block below from
the run files, and `test/eval-table.test.ts` holds the README to its output. A cell holds one value when every run
gives it and each run's value, in run order, when they differ.

The labels set the limit of every measure: the 38 items hold 36 no, 2 unsure and 0 yes, both unsure items in the
development set, so the eval measures agreement on items labelled no and the false positives among them, and the 23
held-out items are all labelled no.

A supplementary set, declared on 26 Oct 2026, is post hoc and not pre-registered
([eval/supplementary/README.md](eval/supplementary/README.md)). It holds nine findings of real drift from four live
passes of 25 Oct 2026: three changes the operator staged on production and one lab edit. Each is labelled by the
protocol's verb reading of its live verb, which gives 1 yes (the 18:08 UTC FIX) and 8 no (three ROLLBACKs, five
HOLDs). In `eval/supplementary/results/2026-10-26T01-00-40Z`, the SQL checks with Ultra as the falsifier (C3) read the
yes item as yes in 1 of 3 runs and file it not judged in the other two; they read yes on 0 of the 8 no items in each
run. Ultra alone (C4) reads the yes item as yes in 3 of 3 runs and reads yes on 7, 5 and 5 of the 8 no items. Memory
injected 0 of 152 calls; all 139 receipts verify.

The development set has two committed runs, with the same items, labels, split, configurations and measures. The
current one, `eval/results/2026-10-25T23-34-17Z`, ran on 25 Oct 2026 from 23:34 UTC under per-call scope isolation:
the adapter sends every call under a fresh `meterless-scope`, memory injected 0 of 390 calls, and `hmem` is null on
all 384 published receipts. The run of 25 Oct 2026 09:25 UTC, `eval/results/2026-10-25T09-25-44Z`, went out under
Nightshift's shared memory scope, and 281 of its 380 published receipts carry injected memory (each receipt's `hmem`
field). The changelog of [eval/PROTOCOL.md](eval/PROTOCOL.md) carries the detail.

### Development set under per-call scope, `eval/results/2026-10-25T23-34-17Z`

15 configuration runs (3 of each of C0, C1, C2, C3, C4): 390 call records, 390 with a verified receipt, 0 substitutions, 0 cache hits. Median output tokens per answered call: Lightning selecting 308.5, Lightning judging 146.5, Ultra judging 1,247, Ultra alone 426.

| config | what runs | agree / judged | findings decided by | labelled no, read yes | planted claims struck | checks valid / selected | items not judged | calls | receipts verified | substitutions | cache hits | median output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C0 | SQL only: the class's default precondition checks, no model (what SAMPLE_MODE runs) | 9/9 | policy 20 | 0/9 | - | - | 0 | 0 | 0 | 0 | 0 | - |
| C1 | C0 plus Nemotron 3.5 Lightning selecting and parameterising checks from the catalogue | 9/9 | policy 20 | 0/9 | - | 76/80, 78/78, 79/80 | 0 | 20 | 20 | 0 | 0 | Lightning selecting 308.5 |
| C2 | C1 plus Nemotron 3.5 Lightning as the falsifier judge | 0/0, 1/1, 1/1 | policy 11, 12, 10 | 0/9 | 3/10, 2/10, 2/10 | 78/79, 79/80, 75/77 | 9, 8, 10 | 49, 49, 48 | 49, 49, 48 | 0 | 0 | Lightning selecting 309; Lightning judging 146.5 |
| C3 | C1 plus Nemotron 3 Ultra as the falsifier judge | 9/9, 8/8, 8/8 | policy 20, 19, 19 | 0/9 | 9/10, 8/10, 8/10 | 75/77, 73/74, 76/78 | 0, 1, 1 | 48, 49, 48 | 48, 49, 48 | 0 | 0 | Lightning selecting 305; Ultra judging 1,247 |
| C4 | Nemotron 3 Ultra alone: the verdict from the rows, no SQL checks, no catalogue (baseline) | 3/9, 4/9, 3/9 | the model | 6/9, 5/9, 6/9 | - | - | 2 | 13 | 13 | 0 | 0 | Ultra alone 426 |

Nemotron 3 Ultra alone (C4) agrees on 3, 4 and 3 of 9 items and reads yes on 6, 5 and 6 of the 9 labelled no; with
Ultra as the judge inside the system (C3) the runs agree on 9 of 9, 8 of 8 and 8 of 8 and read yes on 0 of 9. C4's
Wilson interval in runs 1 and 3, 0.121 to 0.646, lies below every C0, C1 and C3 interval (lowest bound 0.676), and
its run 2 interval, 0.189 to 0.733, overlaps them; C2 judges 0, 1 and 1 items labelled no, its two intervals (0.207 to
1.000) overlap every other, and the C0 to C3 intervals overlap one another. The recording is
`test/fixtures/recorded-bundle.json`, tenant `client-1`; its pass raises 38 findings (25 Oct 2026).

On this set the policy file decides every C0 to C3 verdict (decided_by policy on every finding with a disposition), so
Nemotron's measured work here is the checks Lightning chooses from the catalogue and the refuting SELECTs both judges
write against the ten planted false claims. Ultra (C3) strikes 9, 8 and 8 of the ten, 25 of 30 over the three runs;
Lightning as the judge (C2) strikes 3, 2 and 2, 7 of 30, and 4, 3 and 3 of its replies are invalid output, a bare
table name the guard refuses or a column the table lacks. Ultra leaves P09 (a deletion day stated quiet) standing in
all three runs, P02 in run 2 and P07 in run 3. Each of Ultra's P09 SELECTs reads `dns_record` rows observed before the
deletion day, 11 Oct 2026, and the recording's 58 DNS rows come from one collection run on 24 Oct 2026.

### Development set under the shared scope, `eval/results/2026-10-25T09-25-44Z`

15 configuration runs (3 of each of C0, C1, C2, C3, C4): 389 call records, 383 with a verified receipt, 0 substitutions, 0 cache hits. Median output tokens per answered call: Lightning selecting 4,724, Lightning judging 2,953, Ultra judging 615, Ultra alone 358.

| config | what runs | agree / judged | findings decided by | labelled no, read yes | planted claims struck | checks valid / selected | items not judged | calls | receipts verified | substitutions | cache hits | median output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C0 | SQL only: the class's default precondition checks, no model (what SAMPLE_MODE runs) | 9/9 | policy 20 | 0/9 | - | - | 0 | 0 | 0 | 0 | 0 | - |
| C1 | C0 plus Nemotron 3.5 Lightning selecting and parameterising checks from the catalogue | 8/8, 8/8, 9/9 | policy 15, 16, 20 | 0/9 | - | 58/63, 59/63, 76/77 | 3, 3, 0 | 20 | 20 | 0 | 0 | Lightning selecting 4,407.5 |
| C2 | C1 plus Nemotron 3.5 Lightning as the falsifier judge | 3/3, 8/8, 7/7 | policy 14, 18, 16 | 0/9 | 9/10, 9/10, 8/10 | 69/70, 70/71, 65/68 | 6, 2, 4 | 49, 49, 47 | 45, 48, 46 | 0 | 0 | Lightning selecting 4,805; Lightning judging 2,953 |
| C3 | C1 plus Nemotron 3 Ultra as the falsifier judge | 9/9, 9/9, 8/8 | policy 19, 20, 16 | 0/9 | 9/10 | 72/73, 76/76, 62/66 | 1, 0, 3 | 49, 50, 46 | 49, 50, 46 | 0 | 0 | Lightning selecting 4,932; Ultra judging 615 |
| C4 | Nemotron 3 Ultra alone: the verdict from the rows, no SQL checks, no catalogue (baseline) | 3/9 | the model | 6/9 | - | - | 2 | 13 | 13 | 0 | 0 | Ultra alone 358 |

Nemotron 3 Ultra alone (C4) agrees on 3 of 9 items and reads yes on 6 of the 9 labelled no; with Ultra as the judge
inside the system (C3) the runs agree on 9 of 9, 9 of 9 and 8 of 8 and read yes on 0 of 9. C4's Wilson interval,
0.121 to 0.646, lies below every C0, C1 and C3 interval and C2 run 2's (lowest bound 0.676), touches C2 run 3's
(from 0.646) and overlaps C2 run 1's (0.439 to 1.000); the C0 to C3 intervals overlap one another. The recording is
`test/fixtures/recorded-bundle.json`, tenant `client-1`; its pass raises 38 findings (25 Oct 2026).

On this set the policy file decides every C0 to C3 verdict (decided_by policy on every finding with a disposition), so
Nemotron's measured work here is the checks Lightning chooses from the catalogue and the refuting SELECTs both judges
write against the ten planted false claims. Both judges leave P09 (a deletion day stated quiet) standing in all six
runs: each writes the same SELECT, which joins the day's delete events to `dns_record`, and the recording's DNS rows
come from one collection run on 24 Oct 2026, where a deleted record has no row.

## Zetaris

Zetaris runs as the local Docker bundle the organisers' Participant Setup Guide describes, its Lightning SQL REST API
on `localhost:8888` (`ZETARIS_REST_URL`). The agent sends an API key created by an admin in the Zetaris UI
(Management > API tokens) and set as `ZETARIS_API_KEY`: `npm run zetaris:setup` needs a key of an admin role, and the
agent's own query path is SELECT-only ([.env.example](.env.example)).

Zetaris federates four datasources. `DRIFT` is the app Postgres: the collectors and the ledger write to it, and every
query of a live pass runs through Zetaris Lightning SQL over REST. `LESSONS` is the technician's memory store, the
Meterless H-MEM store the Decider recalls from: `LESSONS.lesson` holds one row per lesson and `LESSONS.ledger` the
store's H-MEM ledger, entry for entry. `RULES` is the policy file: `RULES.rule` holds one row per rule, under the rule
id every disposition decided by policy carries. `CLOUDFLARE` is the Cloudflare DNS API, a Lightning REST datasource
Zetaris reads itself: the setup reads the zones the read token sees and their record counts first (GETs only), then
registers one REST table per zone and page of 500 records, `zone_<zone id>` for the first page and
`zone_<zone id>_p<n>` after it, each sending the token in its Authorization header. The tables are uncached, so every
query fetches their endpoints again and reads the provider at that instant. `LESSONS` and `RULES` are Lightning
databases over files in the Zetaris filestore: `npm run zetaris:setup` writes the three files from `DRIFT_MEMORY_DIR` and `DRIFT_POLICY_FILE` into the
driver container with docker (through `wsl.exe -d Ubuntu-24.04` on Windows) and registers them. Each copy records the
files' sha256 in `.world/filestore-copy.json`, gitignored, and a live pass (before the Decider's DQ read) and
`npm run answer` (after it writes the store) put the files again when their hash differs, so `LESSONS.lesson` holds
the store the Decider recalls from; the setup's copy of the three files took 511 ms on 25 Oct 2026 at 23:24 UTC. The
setup then builds the `drift_usl` semantic layer of fifteen entities (`collection`, `setting`, `referent`,
`backup_copy`, `policy`, `copy`, `probe`, `disposition`, `action`, `ticket`, `cause`, `lesson`, `rule`, `adoption`,
`dns_live`) and six DQ rules: `run_complete` on `collection`, `copy_validated` on `copy` (the copy's latest validation
is ok or ok_with_gaps), `action_verified` on `action` (a done rollback or revert names the probes that verified it),
`cause_evidenced` on `cause` (a cause of any class but unknown names at least one evidence id), `exception_in_force`
on `adoption` and `dns_inventory_current` on `dns_live`. The `adoption` entity is the cross-source join: every ADOPT
decided under an accepted exception, a `DRIFT` row, joined to the `LESSONS` lesson its reason names;
`exception_in_force` holds each one to a lesson that was in force at the decision instant. After the Decider, a live
pass reads the same rule over its own adoptions with one SELECT on `drift_usl.adoption`, and the pass row's Zetaris
line prints it; the dry pass measured on 25 Oct 2026 over the recording of 21:12 UTC printed "DQ exception_in_force 23
of 23 adoptions of the pass recorded at 2026-10-25 21:12 UTC". The `dns_live` entity is the live join: each
`CLOUDFLARE` table's `result` array exploded into one row per record, LEFT JOINed to the last complete
`cloudflare.dns` run of `collection_run` (the latest run `run_complete` passes) and to that run's `dns_record` row of
the same Cloudflare record id, so the join reads Cloudflare's ids alone. `dns_inventory_current` holds every
record live at the provider to that run with the same type and proxied flag, so a record that fails means the provider
changed since the run and the pass's picture of the zone is stale until the next collection. For a tenant with a DNS
run, a live pass reads the rule with one SELECT on `drift_usl.dns_live` beside the adoption read, and the pass row's DQ
lines print both. On 26 Oct 2026 at 04:17 UTC the setup read 6 zones and 58 records in 1.9 s, then ran 90 statements,
53 ok, 37 skipped and 0 failed in 38.6 s, the fifteen entities and the six rules listed as stated; RUN DQ measured
`dns_inventory_current` valid on 58 of 58 live records in 16.1 s, its `record_id` key and its `run_id` foreign key 58
of 58, `count dns_live` 58 beside the 58 the zones report, `run_complete` 157 of 157, `copy_validated` 2,303 of 2,641,
`action_verified` 16 of 18, `cause_evidenced` 10 of 10 and `exception_in_force` 230 of 230. The `cause` entity names `finding_cause.class` as `cause_class`. `test/parity.test.ts` holds sql.js and Zetaris to the same columns, rows and
totals over 111 cases, the two file tables and the adoption join among them. Measured on Zetaris 2.4.3.1: a function
inside a top-level WHERE on a `DRIFT` table is dropped, every row coming back, and a correlated reference in a
subquery's JOIN ON is refused, so the catalogue's top-level predicates compare plain columns and every correlation
sits in a WHERE. FORMAT JSON reads a file as one JSON document, so a newline-delimited ledger gives its first entry
alone, with or without `multiLine "false"`, and every file the setup writes is one JSON array; a file table re-reads
its file on every query and keeps the columns it was created with, so the setup drops and creates a table whose columns
differ (25 Oct 2026). At 22:27 UTC on 25 Oct 2026 the setup ran 71 steps, 58 ok, 13 skipped and 0 failed in 23.2 s,
the eleven-entity USL stale, removed and compiled with fourteen; a second run gave 49 ok, 22 skipped, 0 failed in
18.9 s. RUN DQ measured `run_complete` valid on 140 of 140 runs, `copy_validated` valid on 2,079 of 2,380 copies
(every vault copy, the superseded ones included), `action_verified` valid on 16 of 18 actions, the 2 invalid each an
`unverified` `rollback_file` that names no verifying probe, `cause_evidenced` valid on 5 of 5 causes, and
`exception_in_force` valid on 184 of 184 adoptions: the 23 ADOPTs of client-1 in each of 8 recorded passes, each
joined to one of the 23 lessons of `examples/memory` (`RULES.rule` 15 rows, `LESSONS.ledger` 23).

ConfigLeaf assures the layer it stands on as a ninth source, the surface `zetaris.control`
([src/zetaris/control.ts](src/zetaris/control.ts)). `npm run collect:zetaris -- --tenant <id>`, and the setup at its
end for each tenant with a DNS or control-plane run, reads Zetaris's control plane with read-only statements: SHOW
NAMESPACES OR TABLES IN the USL (the entities the model must hold, the run's asserted population), LOAD USL (the model
as JSON), LIST DQ USL, SHOW GRANT ON ALL, SHOW DATASOURCES, SHOW LIGHTNING DATABASES and SHOW SERVER VERSION. Each
object becomes one observation on the host `zetaris`, setting `definition`: the USL's entity list, each entity as LOAD
USL reports it (its columns, keys, checks, access-control annotations and activation query), each custom DQ rule with
its table and expression, the list of principals, each principal's grants (the grant time left out), the datasource
list, each datasource and Lightning database with its id, and the server version. The value is the object's canonical
JSON (keys sorted, two-space indent), value_hash its sha256, the text redacted as every observation is (a principal's
mail address becomes its pseudonym), and the run is committed to the vault as a host's run is, at
`<DRIFT_VAULT_DIR>/<tenant>/zetaris`. SHOW GRANT needs an administrator or Access Control Read: when the key may not
run it, the grants are not_checked with the reason and the run goes on without them; any other statement that fails
leaves the run failed, so the gate refuses it. `npm run approve -- --tenant <id> --surface zetaris.control` signs off
the whole state, and the existing `drift_vs_approved` detector covers the surface unchanged: an edited DQ rule, a
dropped entity or a widened grant is a finding, its cause carrying the line diff of the canonical JSON (a dropped
entity is also `approved_missing`). The policy file's `zetaris.control` rule (critical, locked, `on_drift`
`escalate`, alert always) makes every such finding ESCALATE, a ticket for a technician, and the agent changes nothing
on the layer. On 26 Oct 2026 the setup's collection at 04:55 UTC gave run 30 of 30 objects complete (16 for the USL,
6 DQ rules, 2 for the grants, 5 for the datasources, the server), committed to the vault in 876 ms; `npm run
collect:zetaris -- --tenant client-1` at 04:55:30 UTC gave the same 30 objects with the same hashes, 30 rows written,
its vault commit changing no file; the approval at 04:55:43 UTC wrote 30 rows. `test/zetaris-control.test.ts` holds the
three drifts to ESCALATE over sql.js, the edited rule's diff its one changed expression line.

Before every live pass reads a row, the source-schema guard ([src/zetaris/schema-guard.ts](src/zetaris/schema-guard.ts))
runs DESCRIBE DATASOURCE TABLE for the fourteen `DRIFT` tables the pass's SQL reads and, after SHOW LIGHTNING TABLES
CLOUDFLARE, for each REST table, and compares the columns with sql/schema.sql (TEXT as string, INTEGER as integer) and
with the three fields `dns_live` reads from each zone table's `result` array (id and type strings, proxied a boolean).
A column the pass reads that is missing or has changed type fails the pass closed on the surfaces that read it: the
backup tables feed linux.nginx, the DNS record, audit and inventory tables linux.nginx and cloudflare.dns, and every
other table every surface. Their dispositions go to no ledger, each of their findings is one NOT CHECKED line with the
reason, and the pass row prints "schema <ds>.<table> changed: <column>" in red; a pass whose own SQL fails over the
change decides nothing and says so, the schema first. A changed REST field leaves the findings decided and the
`dns_inventory_current` read not made. When everything matches, the row prints "schema 20 tables as expected".
`change_window` stands apart: a store created before it lacks it, and the pass's window read already decides what its
absence means. Last, the pass asks Zetaris for its plan of the two cross-source queries, EXPLAIN QUERY AS of the hero
join over the tenant's latest nginx and DNS runs and of the `dns_live` read
([src/zetaris/explain.ts](src/zetaris/explain.ts)): one trace line each, agent zetaris, action explain, the plan
redacted and cut to 4,000 characters, its first line under `--verbose`; a key that may not run EXPLAIN (it is for
administrators) gives a not_checked line. The read-only pass for client-1 on 26 Oct 2026 at 04:55 UTC printed "schema
20 tables as expected" (21 statements, 0.96 s when the guard runs alone), decided 27 findings as before (ADOPT 23, HOLD 3, ESCALATE
1) and 0 on `zetaris.control` (`drift_vs_approved` 0 and `approved_missing` 0 over the 30 approved objects, no locked
setting without an approved value), sent 491 Lightning SQL queries (29,933 rows, 0 failed) in 97.9 s and traced the
hero join's plan (cut at 4,000 characters) and the `dns_live` plan (2,409 characters), each opening "== Parsed Logical
Plan ==".

### The semantic layer

`drift_usl` in `lightning.metastore.drift` is the semantic layer over four datasources: `DRIFT`, the app Postgres; `LESSONS`, the technician's memory store; `RULES`, the policy file; `CLOUDFLARE`, the Cloudflare DNS API, which Zetaris reads itself at each query. It holds 25 entities, each activated as one SELECT over the tables it is built from (`activation()` in `src/zetaris/setup.ts`), a table of `DRIFT` by its name and a file or REST table as `<datasource>.<table>`, and 6 DQ rules, each an expression RUN DQ tests on every row of its entity. Every catalogue query reads through it: on Zetaris each of the 20 tables the SQL names is read as the entity whose row lists it under "catalogue table", with each of the table's columns under the table's own name (`READ_AS` and `uslRelation()` in `src/zetaris/setup.ts`), so the detectors, the hero query and the Decider's reads run over this one model and join through its keys.

| entity | built from | catalogue table | key | DQ rule | expression |
|---|---|---|---|---|---|
| `collection` | `collection_run` | `collection_run` | `run_id` | `run_complete` | `observed_count IS NOT NULL AND expected_count IS NOT NULL AND observed_count >= expected_count AND status = 'complete'` |
| `setting` | `observation`: `obs_id` as `setting_id`, `source` as `source_kind` | `observation` | `setting_id`; `run_id` references `collection(run_id)` |  |  |
| `referent` | `observation`, `dns_record`: each `observation` whose `refers_to_type` is `dns_name`, joined to the `dns_record` rows of its tenant whose `name` is its `refers_to_id`, the join the hero query makes for FOUND-BUT-DIFFERENT |  | `ref_id`; `setting_id` references `setting(setting_id)` |  |  |
| `backup_copy` | `backup_item`, `backup_snapshot`: each `backup_item` joined to its `backup_snapshot` |  | `copy_id` |  |  |
| `policy` | `policy_rule` | `policy_rule` | `rule_id` |  |  |
| `copy` | `vault_copy`, `copy_validation`: each `vault_copy` with its latest `copy_validation` (by `validated_at`, then `validation_id`); `validated` is 1 when that result is ok or ok_with_gaps |  | `copy_id`; `run_id` references `collection(run_id)` | `copy_validated` | `validated = 1` |
| `probe` | `probe` | `probe` | `probe_id`; `run_id` references `collection(run_id)` |  |  |
| `change_window` | `change_window` | `change_window` | `window_id` |  |  |
| `disposition` | `disposition` | `disposition` | `disposition_id`; `run_id` references `collection(run_id)`; `window_id` references `change_window(window_id)` |  |  |
| `action` | `action` | `action` | `action_id`; `disposition_id` references `disposition(disposition_id)` | `action_verified` | `kind NOT IN ('rollback_file','revert_record') OR status IN ('failed','refused','not_judged') OR verification <> ''` |
| `ticket` | `ticket` | `ticket` | `ticket_id` |  |  |
| `cause` | `finding_cause`: `class` as `cause_class` | `finding_cause` | `cause_id`; `disposition_id` references `disposition(disposition_id)` | `cause_evidenced` | `cause_class = 'unknown' OR evidence_ids <> '[]'` |
| `lesson` | `LESSONS.lesson`: one row per lesson of the technician's memory store, the Meterless H-MEM store the Decider recalls from, as `lessons.json` in the Zetaris filestore | `lesson` | `lesson_id` |  |  |
| `rule` | `RULES.rule`: one row per rule of the policy file, as `rules.json` in the Zetaris filestore; `lock` as `locked`, `hold_max_hours` as `hold_hours`, `note` as `description` | `rule` | `rule_id` |  |  |
| `adoption` | `disposition`, `LESSONS.lesson`: each `disposition` decided ADOPT by the operator, under an accepted exception, LEFT JOINed across the two datasources to the `LESSONS.lesson` row its reason names, on the tenant and the lesson id |  | `disposition_id`; `lesson_id` references `lesson(lesson_id)` | `exception_in_force` | `lesson_id IS NOT NULL AND lesson_kind = 'exception' AND lesson_recorded_at <= decided_at AND decided_at < lesson_expires_at` |
| `dns_live` | `CLOUDFLARE.zone_<zone id>`, `collection_run`, `dns_record`: each record the DNS API returns at the query, the `result` array of every `CLOUDFLARE.zone_<zone id>` REST table exploded (one table per zone and page), LEFT JOINed across the datasources to the last complete `cloudflare.dns` run of `collection_run` and to that run's `dns_record` row of the same Cloudflare record id; ids are joined on, never a name or a content |  | `record_id`; `run_id` references `collection(run_id)` | `dns_inventory_current` | `held_type <> '' AND held_type = live_type AND held_proxied = live_proxied` |
| `dns_record` | `dns_record`: `dns_record_id` is `run_id` and `record_id` joined by `:` (a `:` in a value escaped), a Cloudflare record id being unique within one DNS run only | `dns_record` | `dns_record_id`; `run_id` references `collection(run_id)` |  |  |
| `inventory_asset` | `inventory_asset`: `source` as `source_kind` | `inventory_asset` | `asset_id` |  |  |
| `approved_setting` | `approved_setting` | `approved_setting` | `approval_id` |  |  |
| `backup_snapshot` | `backup_snapshot` | `backup_snapshot` | `snapshot_id` |  |  |
| `backup_item` | `backup_item`: `item_id` is `snapshot_id`, `object_id` and `setting_path` joined by `:` (a `:` in a value escaped) | `backup_item` | `item_id`; `snapshot_id` references `backup_snapshot(snapshot_id)` |  |  |
| `vault_copy` | `vault_copy`: `source` as `source_kind` | `vault_copy` | `copy_id`; `run_id` references `collection(run_id)` |  |  |
| `copy_validation` | `copy_validation` | `copy_validation` | `validation_id`; `copy_id` references `vault_copy(copy_id)` |  |  |
| `referent_fingerprint` | `referent_fingerprint`: `fingerprint_id` is `obs_id` and `dns_run_id` joined by `:` (a `:` in a value escaped) | `referent_fingerprint` | `fingerprint_id`; `obs_id` references `setting(setting_id)` |  |  |
| `audit_event` | `audit_event`: `source` as `source_kind` | `audit_event` | `event_id` |  |  |

## Meterless

Two Meterless reference engines are vendored unmodified and wrapped by `src/engine/`. The World Model (`world.ts`)
holds every observation of a passing run, the referent fingerprints FOUND-BUT-DIFFERENT compares and the exposure
line's open edges; its conformance suite passes 8 of 8 through that module. H-MEM (`memory.ts`) holds the technician's
lessons: `npm run answer` records an exception or an answer on one finding's scope with a tenant, an expiry and
provenance, and the Decider recalls it by exact scope key, an exception in force giving ADOPT until its expiry and a
lapsed one ESCALATE. Lessons live in the directory `DRIFT_MEMORY_DIR` names (when it is blank, `examples/memory` in
sample mode and for `npm run examples` and `npm run site`, and `.world/memory`, gitignored, for the live commands);
every pass opens the store read only, and `npm run answer` is the one writer. The store is committed under
`examples/memory`: on 25 Oct 2026 the operator accepted 23 exceptions, one per `proxied_without_real_ip` and
`orphan_vhost` finding of the recorded estate, in his words "Personal estate, known and intentional: proxied names
without real_ip and the leftover records are not a production risk.", each until 2026-11-30T00:00:00Z, and all 23
are in force on the recorded estate. The vendored H-MEM suite passes 13 of 13.

Nightshift, the Meterless runtime, serves Nemotron and signs a receipt for every successful call. It is installed from
meterless.ai and serves an OpenAI-compatible API on `127.0.0.1:8088` (`METERLESS_BASE_URL`). The agent reads its
bearer token from `METERLESS_RUNTIME_TOKEN`, or, when that is blank, from the file the runtime writes,
`%LOCALAPPDATA%\ai.meterless.runtime\proxy-token`; the provider keys (OpenRouter, NVIDIA) live in Nightshift alone
([.env.example](.env.example)).

Each command and the engine or endpoint it calls; the pass's calls sit in `runPass` (`src/pipeline.ts`):

| command | engine or endpoint | calls | what it decides or records |
|---|---|---|---|
| `npm run sample`, `npm run pass`, `npm run cycle` | World Model, `src/engine/world.ts` | `DriftWorld.observe` for each observation of a passing host run: the setting entity, its `value_hash` fact, its `refers_to` edge and the referent's `fingerprint` fact; `foundButDifferent` on each hero row; `exposure` for each finding on a DNS record whose state the audit log dates | a hero row is `found_but_different` when its bytes are unchanged and its referent's fingerprint changed between the two runs, and `dns_change` otherwise; the exposure line is an open edge; the sample prints "14,174 observations in the World Model" in its observe row, and the summary line in the trace keeps "N observations in the World Model" (`src/loop/pass.ts`) |
| `npm run sample`, `npm run pass`, `npm run cycle` | H-MEM, `src/engine/memory.ts` | `TechnicianMemory.recall` by exact scope key, before the Decider decides, over the store opened read only | an exception in force gives ADOPT until its expiry, and a lapsed one ESCALATE; the sample prints "memory 23 lessons · 23 exceptions applied · 0 lapsed" in its decide row, and the summary line in the trace keeps "memory: N lesson(s), N exception(s) applied, N lapsed" (`src/loop/pass.ts`) |
| `npm run answer` | H-MEM, `src/engine/memory.ts` | `HMEM.add` on layer `long_term`, provenance origin `user_correction` for an exception and `manual` for an answer; `--forget <id>` is `store.delete` with a reason | the lesson with its tenant, scope key, expiry and provenance; the H-MEM ledger records each withdrawal and its reason; this command is the store's one writer |
| `npm run preflight` | World Model, `src/engine/world.ts` | a fresh `DriftWorld` for the baseline and for each simulated world (`runPreflight` in `src/preflight/run.ts`) | each world's findings, compared by key, with nothing written |
| `npm run act -- --apply` (`investigate`), `npm run eval` | Nightshift | `POST /v1/chat/completions` under `meterless-app` `drift-agent-<tenant>`, then `GET /v1/meterless/receipts`, every Ed25519 signature verified offline | a verdict counts only through the receipt gate ([Nemotron](#nemotron)) |
| `npm run spike:nightshift` | Nightshift | `GET /v1/models`; one Lightning and one Ultra chat by explicit id; `GET /v1/meterless/receipts`; `GET /v1/jobs` and `GET /v1/jobs/{id}/events` (SSE) | a PASS or FAIL line per check: the routed model on each receipt, every listed receipt verified, this run's receipts in the list, the app's own job and its turn events |
| `npm run conformance` | World Model | the vendored runner with `WORLD_MODEL_IMPL` set to `src/engine/world.ts` | the suite's 8 checks |
| `npm run conformance:hmem` | H-MEM | the vendored runner with `HMEM_IMPL` set to `src/engine/memory.ts`, which re-exports the reference class unchanged, then one check through `TechnicianMemory.recordException` and `recall` | the suite's 13 checks and the wrapper check; `TechnicianMemory` itself is covered by `test/memory.test.ts` |

Every prompt is built from rows the redactor pseudonymised before they were stored, and the judge's claim and evidence
pass the redactor once more before the call ([Redaction](#redaction)).

## Nemotron

Nemotron runs through Nightshift, requested by explicit model id with OpenRouter as the primary route:

| role | model | runs in |
|---|---|---|
| Triage: pick and parameterise catalogue checks for a finding | Nemotron 3.5 Lightning: `METERLESS_MODEL_FAST` `nvidia/nemotron-3.5-lightning-30b-a3b` (NVIDIA's endpoint), then `METERLESS_FALLBACK_FAST` `openrouter/nvidia/nemotron-3.5-lightning`; a local lane joins when its weights are installed | the eval's C1 to C3 |
| Investigation: pick the checks for a FIX, or an ESCALATE under an investigate rule | Nemotron 3.5 Lightning, the same ids | the Actor's `investigate` |
| Refuting judge: one SELECT that returns rows when the claim is false | Nemotron 3 Ultra: `METERLESS_MODEL_JUDGE` `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`, then `METERLESS_FALLBACK_JUDGE` `nvidia/nemotron-3-ultra-550b-a55b`; Lightning in C2 | the Actor's `investigate`, the eval's C2 and C3 |
| Eval C1 | C0 plus Nemotron 3.5 Lightning selecting and parameterising checks from the catalogue | `npm run eval` |
| Eval C2 | C1 plus Nemotron 3.5 Lightning as the falsifier judge | `npm run eval` |
| Eval C3 | C1 plus Nemotron 3 Ultra as the falsifier judge | `npm run eval` |
| Eval C4 | Nemotron 3 Ultra alone: the verdict from the rows, no SQL checks, no catalogue (baseline) | `npm run eval` |

The cycle's pass runs no model: each finding gets its class's default checks and the judge is skipped. Nemotron runs
in the Actor's investigation and in the eval. Lightning returns template ids and parameters from the catalogue, and
the catalogue renders the SQL; the judge's SELECT is the one model-written SQL, guarded (SELECT only, known tables,
LIMIT capped at 50) and run through the same DataLayer. The receipt gate counts a verdict only when the Ed25519-signed
receipt verifies, the served tier is the one requested, `request_id` equals the response's id and `app` is
`drift-agent-<tenant>`; a substituted tier, a tampered body, an unreceipted response or a receipt of another request
on a fresh retry files the finding `not_judged`, and it escalates. On 24 Oct 2026 the eval smoke made 9 calls under
`drift-agent-client-1`, every receipt verified and custody holding on the first attempt. On 25 Oct 2026 Nemotron ran
inside the Actor on the lab, beside the eval: for a FIX, Lightning selected four valid checks on receipt
`rcpt_req_nn4ag0yu` and Ultra's refuting SELECT returned no rows on receipt `rcpt_req_iehg9gmt`, both receipts
verified and custody holding under `drift-agent-lab-1`. On the development run of 25 Oct 2026 23:34 UTC, under
per-call scope, the median output tokens per answered call are Lightning selecting 308.5, Lightning judging 146.5,
Ultra judging 1,247 and Ultra alone 426; on the run of 09:25 UTC, under the shared scope, they are Lightning selecting
4,724, Lightning judging 2,953, Ultra judging 615 and Ultra alone 358 (the tables under Evaluation).

The signed receipts sit beside the call records that name them. `eval/results/2026-10-25T23-34-17Z/` and
`eval/results/2026-10-25T09-25-44Z/` each hold a development run's call records (`calls[]` of each `C*-run*.json`, and
`planted.json`) and `receipts.json`, the runtime's receipts for them, each exactly as signed; `receipts-withheld.json`
names the receipts the export's probe kept back, 6 of 390 and 3 of 383, each a 180-character preview the runtime cut
inside a pseudonymised file name, which the redactor reads as a new host name; `nightshift-job.json` is the tenant
app's job entry at export time. `lab/receipts.json` holds the lab's 3. `npm run receipts:verify -- <dir>` checks a
directory offline, and CI runs it over every committed `receipts.json`. `npm run receipts:export` writes the bundle
after a run. Measured 25 Oct 2026, read only: `GET /v1/meterless/receipts` returns the newest 100 receipts, and 200
with `?limit=200`, `?limit=500` or `?limit=1000`, fewer than either development run's receipts, 383 and 390. The
export reads that GET with `?limit=200` by default, so it runs right after the run it exports, while that run's
receipts are among the newest 200; `--from runtime` reads the runtime's own log, `receipts.jsonl` in its data
directory, which starts at 24 Oct 02:12 UTC; the exports of the two development runs read it and found 383 of 383 and
390 of 390. The receipts also say what Nightshift added to each prompt (`hmem.injected`,
`egress.sent.context_sources`): under the shared scope its own H-MEM put 1 to 3 of its memory records into the context
sent for 281 of the 380 published calls of the 09:25 UTC run, 800 records in all, and for all 3 of the lab's; under
per-call scope, for 0 of the 384 published calls of the 23:34 UTC run.

The replay page's [Nemotron tab](docs/index.html#nemotron) lays out the newest results directory as static HTML: the
calls by configuration and role, tier and model requested and model served; each run's checks selected, valid and run
unmodified; every planted claim and every item judge with its status, receipt, served model and SELECT. `npm run site`
re-guards and re-runs each judge SELECT recorded with a row count over the recording, with the policy rows the runs
name, and refuses to publish on a count that differs. The results hold each SELECT as the eval's redactor left it
after the run, and the redactor reads some column operands as host names. On the development run of 23:34 UTC, built
26 Oct 2026: 130 of 134 re-run equal, and the recorded text of 4 (C3 run 1, P09 and E24; C3 run 3, E17 and E24) does
not run, a pseudonym written over operands such as `agg.cnt`. On the run of 09:25 UTC, 25 Oct 2026: 161 of 162 re-run
equal, and the recorded text of 1 (C2 run 2, P10) does not run, the alias in `bs2.host` read as a host name.

## Limits

- The write paths run behind `--apply` only, and on 25 Oct 2026 they ran for real on the lab estate (`lab/README.md`, tenant `lab-1`): `rollback_file` reached `done` at 09:53 UTC, verified by probe `probe-36eb2c1bba298a2a` with the probe population from `PROBE_TARGETS_OVERRIDE`, since the lab's names sit in no zone; a FIX ran `investigate` with Nemotron Lightning and Ultra and its `fix` was refused without a valid copy; the 05:47 UTC rollback, run without the override, found no record of the lab's names in the account and is `unverified`. On the operator's own estate the Actor ran four actions, all on 25 Oct 2026 in the operator's rehearsal: two writes, a `rollback_file` on a vhost at 15:55 UTC, `unverified` by its own probe because the name rides a wildcard record (the next pass found the approved value live and closed its ticket, #5), and a `revert_record` through the provider at 16:50 UTC, `done` with the provider confirming the value; then an `investigate` with Nemotron Lightning and Ultra followed by a refused `fix` at 18:10 to 18:16 UTC on a setting with no valid copy, which opened incident #7. The traces of the revert's cycle, 16:49 to 16:51 UTC, and of the FIX's cycle, 18:08 to 18:16 UTC, are committed redacted in [examples/traces/](examples/traces/) beside the lab's investigation; the second holds Lightning's selection on receipt `rcpt_req_9jmhddr1`, the checks, Ultra's verdict on receipt `rcpt_req_no31rwfn`, the refused `fix` and the incident.
- One tenant, two hosts, six zones, one policy file, one machine and one PSA backend, GitHub Issues (HaloPSA, ConnectWise and Autotask are a field map): `npm run watch` schedules cycles while its process lives, and a GitHub issue is the one notification.
- The held-out set, 23 items, runs once, on 26 October, after the feature freeze. The 38 labels are 36 no, 2 unsure and 0 yes, so agreement counts items labelled no that read no: the eval measures false positives, and the 23 held-out items are all labelled no.
- FOUND-BUT-DIFFERENT on real rows: at 16:49 UTC on 25 Oct 2026 a staged record change raised it on production, 2 `found_but_different` findings on the :443 and :80 `server_name` of one vhost, byte-identical since the 16:32 UTC run while their name resolved to another address, each held 72 h under rule 15; the same cycle's `revert_record` put the record back through the provider, `done`. [examples/traces/cycle_mvo2bil0.jsonl](examples/traces/cycle_mvo2bil0.jsonl) holds that cycle. `sample/bundle.json`, exported after the 13:53 UTC cycle, holds no hero finding; pre-flight raises two in simulation, and `test/fixtures/authored-bundle.json` carries the full story for the tests.
- `drift_vs_approved`, `changed_since_backup` and `approved_missing` find 0 in `sample/bundle.json` (exported after the 13:53 UTC cycle of 25 Oct 2026); in the operator's rehearsal that day the 16:49 UTC cycle raised `drift_vs_approved` 1 and the 18:08 UTC cycle raised `drift_vs_approved` 1 and `changed_since_backup` 1 on the estate (`examples/traces/cycle_mvo2bil0.jsonl`, `examples/traces/cycle_mvo5600q.jsonl`); ROLLBACK and FIX also run on the lab estate and on `test/fixtures/policy-bundle.json`.
- The 23 accepted exceptions in `examples/memory` hold until 2026-11-30T00:00:00Z, and recall runs at the clock: from that instant the sample pass, the examples and the replay page give those 23 findings ESCALATE (exception lapsed), and `npm run examples`, `npm run document` and `npm run site` regenerate the committed outputs the tests hold to the store. The 23 lessons sit on 15 names: a name served by a :443 and a :80 block raises two findings, one lesson was taught per finding, and the Decider applies the earlier lesson on a name, so withdrawing one of a pair leaves its twin in force (25 Oct 2026).
- `verifyReceipt` trusts the public key each receipt carries. The published set is signed by one key: the development runs' 384 and 380 receipts and the lab's 3 verify under `sha256:6ee50b5d11fdd693e1ee80635ea1868bb1addefb5823768192849709928ff8c1` (the sha256 of the raw Ed25519 key), the key of the 23 Oct probe receipts in `test/fixtures/`, and `npm run receipts:verify` names every distinct key it finds, 26 Oct 2026. Pinning that key in config would close a receipt forged with a fresh key.
- Probes run from one machine through two public resolvers; a name resolves through its A and AAAA records, a CNAME followed one level.
- The journal window covers the sudo commands and ssh logins of the last 24 h on the hosts the agent reaches; a change made as root in a shell the journal does not record reads `unknown`. The host's journal is evidence for a person to weigh, as trustworthy as the host that keeps it, since root can edit a log.
- The collector reads with the operator's own SSH key, so its read-only property lives in the fixed script it streams. [ops/](ops/) holds the second stage, for the operator to install: a dedicated user whose key is bound to a forced command running the same reads, and one sudoers line for the two root-only reads.
- The sources are configured, the hosts `LINUX_HOSTS` lists and the one Cloudflare account `CLOUDFLARE_API_TOKEN` reads, and this agent is the assurance layer: the next layer is a management surface above it (every setting with its live, approved and recommended state, a lock flag, a template; unlock, change and lock as the technician's gesture), and the owner's report is its first read-only pane.
- Approvals match observations on the pseudonymised object id, since redaction runs before anything is stored, so adding a word to `REDACT_WORDS` changes the pseudonyms that contain it and strands the approvals on the old ids. Measured 26 Oct 2026: a word added on the evening of 25 Oct renamed two dated `.bak` copies of one vhost (same bytes, same value hash), and the 00:48 and 01:13 UTC cycles raised `approved_missing` 2. The vhost itself kept its pseudonym: the hostname pass reads its file name whole before the word pass runs, while a name with a dotted tail reaches the word pass first. Each affected object needs re-approval under its new id, and the old id's approval keeps raising `approved_missing` until its absence is approved; a key on a salted hash of the raw path is the next step.

## Pre-existing components

The Meterless World Model and H-MEM references are vendored unmodified under Apache-2.0, declared in
[PREEXISTING.md](PREEXISTING.md); the rest was written in the build window, from 22 Oct 2026. The estate's
configuration history (audit log, nightly tarballs, dated vhost copies) predates the window and is read as input data.

`npm test` checks each of the 33 vendored files against its git blob id at upstream commit `1742dec`
([vendor/UPSTREAM.json](vendor/UPSTREAM.json), `test/vendor.test.ts`); `gh api repos/Meterless/Meterless/git/trees/1742dec56a66e58eef9dda2d2b865823758ca8cd?recursive=1`
lists the same ids.

## Decisions

The dated decisions log is section 10 of [DESIGN.md](DESIGN.md#10-decisions).
