# drift-agent

Config-drift assurance for MSP technicians. Three questions, asked of real servers and real DNS:

1. What changed since the last backup?
2. Would a restore regress anything?
3. Where does this system drift from golden, including FOUND-BUT-DIFFERENT: a reference that is byte-identical
   while the thing it points at has changed.

Each finding ends in one verb: ADOPT, HOLD (with an expiry) or ESCALATE. The agent is read-only. It never enforces.

Entry for the GenAI Works Open Agent Hackathon 2026, Track 1 (Solving Fragmented Intelligence).

## Status

The pass runs end to end with no model over a hand-authored bundle in the collectors' shape (`sample/bundle.json`; the
Saturday collectors replace it with recorded, redacted collections); the live sponsor paths are measured spikes.

| Command | Proves |
|---|---|
| `SAMPLE_MODE=true npm run sample` | The whole pass over `sample/bundle.json`: DQ gate, World Model, hero query, precondition catalogue, disposition. No credentials, no model, every step a trace line. Measured 24 Oct: 12 collection runs, 1 gated out, 10 observations recorded, 29 SQL queries, 57 trace lines (57 carry `model_requested: none`), 1 finding (`found_but_different`, ESCALATE, 3 of 4 preconditions hold), 1.5 s warm including tsx start. |
| `npm test` | 11 files, 150 tests (26 more skipped until the live Zetaris datasource exists): data layer, parity, catalogue, selection, redactor, tracer, judge, receipt gate, World Model, the pass. |
| `npm run conformance` | Vendored Meterless World Model conformance suite, 8/8, through `src/engine/world.ts`. |
| `npm run smoke` | Spike A, Zetaris: `SELECT 1` and `SHOW LIGHTNING DATABASES` over REST with the agent's key; `npm run spike:zetaris -- --register` adds the probe that registers and drops a Lightning database to show the key's rights (the cross-source join waits on the DRIFT datasource grant, see Decisions). Spike B, Nightshift: Nemotron Lightning and Ultra by explicit id, signed receipts verified, job event stream read. Spike C, World Model conformance. |

## Run

```bash
npm install
cp .env.example .env   # fill in ZETARIS_API_KEY; the Nightshift token is read from its local file
npm run smoke
SAMPLE_MODE=true npm run sample   # the real pass over the bundled, redacted rows; no credentials
```

`npm run sample` prints the trace (one JSON line per step), one JSON object per finding and one summary line:

```
SAMPLE: 12 collection runs, 1 failed the DQ gate (run-nginx-2b9e-1023), 10 observations in the World Model,
1 finding(s): found_but_different host-7f1c /etc/nginx/conf.d/app.conf server.location./.proxy_pass -> ESCALATE
(3/4 preconditions hold, fails: dns_target_in_inventory); judge skipped (model: none)
```

Every step is appended to `logs/<run>.jsonl`; `logs/` is local and gitignored. In sample mode every line carries
`"model_requested":"none"`, the query lines included. Every free-text field of a trace line (`input_summary`,
`output_summary`, `detail`) goes through the redactor before it is written.

## The pass

`src/pipeline.ts`. One tenant's collection runs go through six steps, each traced with the agent that did it,
the model it used (`model_requested`; `none` on every line of a sample pass) and whether it worked.

| Step | What runs | Trace |
|---|---|---|
| gate | `run_complete` for every collection run. A run that observed fewer objects than it asserted before collecting, did not finish `complete`, never asserted a population, or (host surfaces) stored fewer observation rows than it asserted fails; the collector's own `observed_count` is not taken on trust. | `check`, status `not_checked` for a failing run; its observations feed nothing below |
| observe | Every observation of a passing host-bound run goes into the World Model. A `dns_name` referent carries a fingerprint: what the name's A and AAAA records resolved to in the DNS run of the same pass (the passing DNS run nearest in time, within six hours). | `observe` |
| detect | The hero query over the latest run of each (tenant, surface, host) against that DNS run. A row is `found_but_different` when the setting's bytes are unchanged since the previous passing run and the World Model says the referent's fingerprint is not; `dns_change` otherwise. Each row carries the DNS record it came from, so a name with an A and an AAAA record gives two findings. When no DNS run of the pass passed the gate, the group is `not_checked` and the trace names the DNS run that failed; no older DNS run stands in. | `detect` |
| check | The default precondition policy for the class, bound from the finding and run through the catalogue. A parameter the finding cannot supply, or a check the SQL guard or the engine refuses, is a recorded rejection, not a guess: it escalates that one finding and the pass goes on. | `check` per template: id, row count, one sentence; `not_checked` for a rejection |
| decide | Every check holds and none was rejected: ADOPT, as a candidate. Anything else: ESCALATE. HOLD needs a judge to bound it with an expiry, so a pass with no model never issues it. | `decide`, `model: none` |
| judge | Not called in sample mode. | `judge`, status `skipped` |

The hero finding is the cross-source one the whole stack exists for: an nginx vhost whose `proxy_pass` has not changed
a byte, pointing at a DNS name whose Cloudflare A or AAAA record now resolves to an address the client's inventory does
not know. It exists in no single table. On the bundle the pass finds exactly it, and `test/pipeline.test.ts` runs the
same pass over a bundle whose record still points at an inventory host and asserts nothing is found, then adds a DMARC
TXT record and a CNAME on the same name and asserts nothing is found still: the result comes from the rows, not from a
stored answer, and a TXT or CNAME is not an address.

## Data layer

`sql/schema.sql` is the one DDL, read at import by `src/data/schema.ts`; the known-table guard, the sql.js loader's
column order and the parity test's per-table SELECTs all derive from it. Eight tables (the brief said nine; the
shared DDL defines eight, and a ninth would be added to the DDL alone):

- `collection_run`: one collector pass over one surface, with the population it asserted before collecting (`expected_count`), what it observed and its status. The DQ gate's input.
- `observation`: one setting value seen in one run: object, dotted path, sha256 of the canonical value, the redacted text for display, what the value refers to (`refers_to_type`, `refers_to_id`) and the authority of the source (100 live, 40 backup, 20 approved).
- `approved_setting`: the values a technician signed off, per tenant and optionally per host.
- `backup_snapshot`: a restic or etckeeper snapshot of a host at a time.
- `backup_item`: the setting hashes that snapshot holds.
- `dns_record`: Cloudflare records as seen in one DNS run; `record_id` repeats across runs, which is what makes a change visible.
- `audit_event`: who changed what, from Cloudflare, etckeeper or the journal, with old and new value when the log has them.
- `inventory_asset`: the addresses and hosts the client says it owns.

Timestamps are ISO 8601 UTC text, so they compare and sort identically in every engine. No SERIAL, no JSON columns,
no booleans (INTEGER 0/1).

Two engines behind one interface (`src/data/layer.ts`): `SqlJsEngine` (SQLite in WebAssembly, in memory, for
SAMPLE_MODE and tests; applies the schema and loads a bundle) and `ZetarisEngine` (the measured REST adapter; tables
live in the registered datasource, `ZETARIS_DATASOURCE`). Both return every value as a string and NULL as `""`,
the shape Zetaris returns, so rows compare across engines.

Catalogue SQL names tables as `{{t:table}}` and parameters as `{{p:name}}`. `DataLayer.render` turns a table into
the engine's name for it (bare on sql.js, `DRIFT.observation` on Zetaris) and a parameter into an escaped literal:
strings single-quoted with `'` doubled, finite numbers plain, null as `NULL`, anything else refused. There are no
bound parameters because Zetaris REST takes one SQL string per call and binds nothing, so the same rendering runs
on both engines and the guard sees the final text. `assertSelectOnly` then requires a leading SELECT and, with
string literals stripped, refuses any semicolon, any double quote (identifiers are unquoted and strings single-quoted
in the portable subset; a `"x'"` token would otherwise hide a UNION, a comment and a bare table from the strip while
sql.js and Spark run them), comments, and INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/GRANT/PRAGMA/ATTACH as tokens:
`'drop'` inside a literal passes, and a parameter carrying `'; DROP TABLE observation; --` or a DMARC `v=DMARC1;
p=reject` is rendered as one escaped literal, runs as data and returns no rows (tested on both the data layer and the
catalogue). Both engines apply the same literal-stripped one-statement check before running anything.

The portable subset: lowercase unquoted identifiers, single-quoted literals, no `::` casts, no ILIKE, no date or
time functions, no boolean literals, one statement per query, no trailing semicolon. The catalogue uses JOIN, LEFT
JOIN, correlated NOT EXISTS, IN (subquery), CASE, LIKE, ORDER BY (total, so both engines return the same row order),
UNION ALL, non-equi self-joins and one correlated COUNT(*) subquery (the DQ gate); the judge may also use COALESCE,
MAX, MIN and LIMIT (capped at 50).

`test/parity.test.ts` runs 26 cases (hero, gate, the three pass queries, every catalogue template, every table)
through sql.js always, and through Zetaris when `PARITY_LIVE=true` and the datasource holds exactly the rows of
`sample/bundle.json`; until then those 26 are skipped and one line says so. The two surprises the live run is
designed to catch: header case (compared exactly) and text collation under ORDER BY (keys are lowercase ascii with
dashes to keep it small).

## Precondition catalogue

`src/catalogue/templates.ts`. Nemotron Lightning never writes SQL: it chooses template ids from this list and fills
typed parameters (zod v4), the DataLayer renders and runs them, and each template says whether rows coming back mean
the precondition HOLDS or FAILS, so a row count becomes a verdict without a model. Every template runs on the bundle
in `test/templates.test.ts` with its row count asserted.

| id | purpose | rows mean |
|---|---|---|
| `host_in_inventory` | The address is a known asset in the client's inventory. | holds |
| `dns_target_in_inventory` | Every address (A or AAAA record) the DNS name resolves to in the given DNS run is a known inventory asset; rows are the address records that resolve outside it. | fails |
| `change_in_last_backup` | The host's most recent backup already holds the live value of this setting. | holds |
| `actor_attributed` | An audit event with a named actor touched the resource inside the window. | holds |
| `previous_value_recoverable` | The most recent audit event on the resource records the value it replaced. | holds |
| `restore_would_regress` | A restore from the host's latest backup would keep every approved setting; rows are approvals newer than that backup whose value the backup lacks or differs from. | fails |
| `referent_unchanged` | Nothing the name resolves to changed inside the window; rows are the evidence, from consecutive DNS observations and from audit events on its records. | fails |
| `run_complete` | The collection run observed the whole population it asserted and finished complete; rows are the run failing that gate. | fails |
| `setting_matches_approved` | The setting's live value in the run equals an approved value for it. | holds |
| `other_settings_reference` | Blast radius: no other setting in the same run points at the same target; rows are the ones that do. | fails |
| `record_reverted` | A later audit event put the resource back to the value an earlier event replaced. | holds |
| `backup_recent` | A backup snapshot of the host exists at or after the given time. | holds |

Timestamps validate as ISO 8601 UTC and are normalised to the millisecond form (`…00Z` becomes `…00.000Z`), and the
sql.js loader refuses any stored `*_at` value outside that form, so text comparison stays total on both sides of a
window edge; hashes must be `sha256:` plus 64 hex or bare 64 hex, which is the shape the collectors must emit. `restore_would_regress` is stricter than its one-line brief on purpose: an approval of a value the latest backup
already holds is not a regression.

Selection (`src/catalogue/select.ts`): the system prompt lists every id, purpose, class and parameter and asks for
at most four checks as one JSON object, with an `other` field for a check that fits no template. `validateSelection`
drops an unknown id, bad parameters, a duplicate or anything past six and records a reason per drop instead of
throwing, so an eval can count valid against invalid; a missing or long `why` is prose and is blanked or truncated,
not rejected. `defaultSelection(class)` is the documented fallback, four checks per class with `run_complete` first
everywhere; `defaultChecks(finding)` binds it from the finding through the same validator. It is what SAMPLE_MODE
and any pass without a model run.

## Judge and receipt gate

`src/agents/judge.ts`. The judge refutes; it never confirms by assertion. A detector's claim goes to Nemotron Ultra
with up to 20 supporting rows and the schema, and Ultra answers with ONE SELECT that returns rows if and only if the
claim is false. We guard it (no `{{p:}}`, no bare table name, at least one known `{{t:}}`, `assertSelectOnly`,
LIMIT appended or capped at 50) and run it ourselves through the same data layer as the catalogue. Rows refute the
claim; no rows and it stands. Every verdict carries the SQL as run, the row count, the rationale, the receipt id, the
served model and the latency.

`src/gate.ts`. A verdict counts only when the signed receipt says an Ultra answered. The served model is the
receipt's winning phase (`phases[].model` equal to `routing.winner`), else `routing.winner`, else
`winning_route.model`; the tier is read from the model id, because `requested_mode` in the receipt is always
`meterless/auto` even for explicit-id calls. The gate passes only when the receipt was found, its signature verifies
and the served tier is the requested tier. Substitution (Lightning answered an Ultra request), a tampered body, an
unreachable model, or a receipt list that cannot be fetched after the model answered all file the finding
`not_judged`, which escalates and is never retried silently. A reply that is not one guarded SELECT, or whose SELECT
fails to run, is `invalid_output`, and the eval counts it. A response with no `receipt_id`, or whose receipt is not in
the runtime list after one refresh, is `not_judged` and escalates: the response body is what a substituting proxy
controls, so its own `routed_model` is reported in the trace (served tier, `signature_ok` null, reason "unreceipted")
but never trusted. `ReceiptStore` fetches `GET /v1/meterless/receipts` once per pass; the orchestrator constructs one
per pass, hands it to every `judgeClaim` and calls `reset()` between passes.

## Redaction

`src/redactor.ts` runs before anything is persisted: collected text, vendor JSON, trace detail. The agent stores
`value_hash` plus `value_redacted`; raw values are never stored. Four passes in order: secrets (PEM blocks, Bearer
tokens, `key=value` with a secret-naming key, Cloudflare and AWS and `nvapi-`/`rt-` tokens, and long hex or base64
runs only when a key-like word is within 64 characters before them on the same line, so value hashes, restic ids and
etckeeper commits stay data) become `<secret:KIND:8hex>`; addresses become `ip-XXXXXX` with CIDR suffix kept;
`/home/<u>`, `/Users/<u>` and mail addresses become `user-XXXXXX` and `mail-XXXXXX@domain-XXXXXX` with the same
hash for the same login; FQDNs become `host-XXXXXX.<tld>`, with a file-extension blacklist so `nginx.conf` is not a
host. RFC 5737 and 3849 documentation ranges, loopback, the unspecified address and `.invalid`/`.example`/`.test`/
`.localhost`/`example.com|net|org` pass through, so fixtures stay readable and the bundle is unchanged by it. The
agent's own dotted vocabulary, which trace lines carry next to real names, is left alone too: a dotted key path
(`server.location./.proxy_pass`), a SQL alias reference (`o.host`, `e2.actor`) and a tail that is a collection
surface, an nginx block or directive name or the `observation` table (`linux.nginx`, `server.listen`,
`DRIFT.observation`); none of those tails is a TLD a client runs under.

Pseudonyms are 6 hex: 100 addresses collide with probability 0.03%, 500 with 0.7%; at 4 hex 100 addresses collide
about 7%, which the hero query's join on address cannot tolerate. The salt is `REDACT_SALT`: one salt per tenant
makes every fixture of that tenant linkable, a different salt makes a published fixture unlinkable without it. Blank,
each process draws a random one. Redacting redacted text is a no-op. Parsed JSON goes through `json()`, which keeps
keys and treats any string under a secret-naming key as a secret whatever its shape; `text()` over serialised JSON
would also see the keys. Trace `input_summary`, `output_summary` and `detail` go through the same redactor, so a
trace line carries the pseudonyms the observations carry (`test/trace.test.ts` asserts all three on the real
`Tracer` against a temp `LOG_DIR`).

Measured: a synthetic 200-vhost `nginx -T` dump (101,974 chars, 2,800 lines) redacts in 9.9 ms with exactly the
expected 600 host and 400 address replacements.

## Collector access

`ops/`. There is no "read-only SSH": a shell is a shell. The honest substitute is a forced command in
`authorized_keys` that answers an enumerated set of read requests (`nginx -T`, `cat /etc/nginx/<allowlisted path>`,
`/etc/hosts`, `/etc/resolv.conf`, `etckeeper vcs log -n 50`, `restic snapshots --json` through a root-only wrapper)
and refuses everything else with exit 2, plus a sudoers fragment that grants exactly the root reads those requests
need, NOPASSWD, nothing else. Eight hostile request strings (`id`, empty, `cat /etc/nginx/../shadow`, a second
argument, `;id`, `$(id)`, `nginx -T; id`, restic with `--repo`) were each refused. `visudo -c -f` must run on a Linux
host before install; the fragment's comment carries the regex form for sudo 1.9.10 and newer. See `ops/README.md`.

## Limitations

Today's facts, to be updated as the collectors and the eval land:

- `sample/bundle.json` is hand-authored in the collectors' shape (documentation address ranges, `.invalid` names, sha256 of the redacted text). No live collector exists yet; `ops/` is the access design for one.
- The pass runs no model: Lightning does not choose checks (the default policy per class does), Ultra does not judge, and HOLD is never issued. `judgeClaim` and the receipt gate are tested against stubs and two real receipts, not against a live pass.
- `changed_since_backup` and `drift_vs_approved` have templates and default policies but no detector; only the DNS-referent classes (`found_but_different`, `dns_change`) are detected.
- A `dns_name` resolves through its A and AAAA records only. A CNAME chain is not followed, so a vhost pointing at a CNAME whose target drifted is not found.
- Zetaris is blocked on a SELECT grant for the `DRIFT` datasource, so the live half of the parity test (26 cases) is skipped; the portable-subset claims rest on sql.js plus the measured REST shape, not on a live run.
- Actor attribution comes from audit logs and is reported unattributed when the log has none; the agent does not infer who changed something.
- A trace line's setting path ending in an nginx directive outside the redactor's skip set is over-redacted in the trace text only; the stored observation keeps it.
- Nothing here is production-ready: one tenant, one pass, in-memory World Model, no scheduler, no notification.

## Decisions

Appended as spikes settle. Newest last.

- 2026-10-23: TypeScript on Node 22+ ESM, run with tsx, tested with vitest. The dev machine runs Node 26; `engines` says `>=22`.
- 2026-10-23: `.env` loads through `process.loadEnvFile` (built into Node), so no dotenv dependency.
- 2026-10-23: Nightshift measured live. Explicit `nvidia/*` ids are honoured and named in the receipt; `meterless/fast|deep|judge` all route to the race lane first, so the app requests models by id. Lightning on the free tier returns `empty_response` (502) on about 1 in 4 raw calls (2 of 8 measured); one retry recovered every case, so the adapter retries once and the agent falls back deterministically after that. Ultra answers in 2 to 4 s and puts its reasoning in `content` terminated by `</think>`, with the JSON after it; `extractJson` strips through the last `</think>` first. All 30 runtime receipts verified offline (Ed25519 over the compact key-sorted body). `GET /v1/jobs/{id}/events` is a live SSE stream; failed turns appear there with `ok:false` and no receipt.
- 2026-10-23: World Model reference writes `assertFact` values onto `entity.attrs` only in live state; snapshots replay facts but not attrs. Our `fingerprintAt` therefore reads the latest `fingerprint` fact at or before the time, not attrs. Vendor untouched; conformance 8/8 through `src/engine/world.ts`.
- 2026-10-23: Zetaris REST shape is `{headers, data, total, timeUsed}`, every value a string. The normaliser is written to that. Nemotron is also served through Nightshift via OpenRouter: measured 12/12 at 1 to 2 s median against NVIDIA's free endpoint at 4/6 and 7.5 s, so the primary routes are `openrouter/nvidia/nemotron-*` and the adapter walks a failover ladder (cloud paid, cloud free, local) with every hop receipted and traced as `fallback`.
- 2026-10-23: Zetaris access is denied by default per object. The first API key authenticated for org 1 and ran `SELECT 1` but saw zero Lightning databases over both the direct REST and UI-proxy routes, so the agent's key needs either an administrator's key or a General-role user with explicit SELECT grants on the registered sources. Spike A is blocked on that grant, not on the client.
- 2026-10-23: Schema and portability. One DDL (`sql/schema.sql`, eight tables) portable across SQLite and the Postgres registered in Zetaris: ISO 8601 UTC text timestamps, INTEGER 0/1 for flags, no SERIAL, no JSON columns. Catalogue SQL stays in the portable subset (lowercase unquoted identifiers, `'` doubled, no casts, no ILIKE, no date functions, no booleans, one statement, no semicolon) and names tables `{{t:x}}` and parameters `{{p:x}}`; the DataLayer renders both per engine and parameters become escaped literals, because Zetaris REST takes one SQL string and binds nothing. Both engines normalise to Zetaris's shape (strings, NULL as `""`) so `test/parity.test.ts` compares rows; the live half (26 cases) waits for the `DRIFT` datasource to hold the bundle's rows. The DQ gate fails a run with NULL `expected_count` or `observed_count`, not only a short or partial one: a run that never asserted its population cannot show it collected everything.
- 2026-10-23: sql.js for SAMPLE_MODE. SQLite in WebAssembly, in memory, initialised once per process, the schema applied and `sample/bundle.json` loaded by column order from the DDL. Chosen over a Postgres container because a judge's clean clone and CI must run the real pass with nothing installed; the parity test is what keeps it honest against Zetaris. Measured: wasm init, schema, bundle load and the 19 data-layer tests in 322 ms; the whole pass in 1.7 s warm (`npm run sample`, 29 queries).
- 2026-10-23: A catalogue instead of model-written SQL. Lightning picks template ids and fills typed parameters; nothing it says becomes SQL. The one model that writes SQL is the judge, and its SELECT goes through `guardRefutation` and `assertSelectOnly` and is run by us; a reply that is not one guarded SELECT is `invalid_output` and counted. `defaultSelection(class)` is the fallback policy and what the pass runs with no model: on the hero finding 4 valid, 0 rejected, verdicts `run_complete` holds, `dns_target_in_inventory` fails, `actor_attributed` holds, `other_settings_reference` holds, so the finding escalates. HOLD is never issued without a judge.
- 2026-10-23: The receipt is a gate, not decoration. `GET /v1/meterless/receipts` on the local Nightshift returned 53 receipts, 53/53 verify offline; 35 are successful turns with `receipt_id`, `routing`, `phases` and `winning_route`, 18 are failed turns with no `receipt_id`. On every successful receipt the served model appears in `phases[0].model` (one phase, `final_synthesis`), `routing.winner` and `winning_route.model`, and all three agree; the tier field is the letter `A` for Lightning routes and `C` for Ultra routes, so the gate derives the tier from the model id. `receipt.requested_mode` is `meterless/auto` and `app_policy.requested_mode` is `auto` on every receipt, explicit-id calls included, so the requested tier comes from the caller. A judge verdict counts only when the gate says an Ultra answered; substitution is `not_judged` and escalates. Fixtures `test/fixtures/receipt-lightning.json` (`rcpt_req_szybz3wr`, 942 ms phase) and `receipt-ultra.json` (`rcpt_req_iger5raz`, 880 ms phase) are real, untouched and verify.
- 2026-10-23: `chat_template_kwargs.enable_thinking` is sent by the adapter when a caller sets it but has no observable effect through the OpenRouter routes. `probe:thinking`, one run, 12/12 calls ok with 0 adapter retries: Lightning `tokens_out` 11 on all 6 calls (false 669/693/375 ms, true 310/633/401 ms); Ultra `tokens_out` 71/70/71 with false and 71/75/71 with true (false 1723/1807/1610 ms, true 1274/1554/2125 ms); `</think>` present in 0/12 replies; `extractJson` returned the correct `{ok:true,sum:42}` on 12/12. VERDICT: NO, Nightshift does not observably forward the flag on either OpenRouter route. One follow-up call (`scripts/probe-ultra-shape.ts`) on the OpenRouter Ultra route: message keys `[role, content]`, `finish_reason` stop, 101 tokens out for the 35-character JSON answer, no reasoning field, no `</think>`; the reasoning is billed but not returned there, unlike the `nvidia/` direct route measured earlier (reasoning in `content` before `</think>`). `extractJson` handles both. The judge requests `enable_thinking` true regardless: harmless here, honoured wherever the flag is forwarded, and its `max_tokens` (4096) is sized for a route that honours it, so the JSON after the reasoning is not cut off.
- 2026-10-23: No read-only SSH; `ops/` is the honest substitute. A forced command (`ops/ssh/drift-collect`) matches `SSH_ORIGINAL_COMMAND` whole against five read requests and refuses the rest with exit 2; a sudoers fragment grants exactly the four root reads NOPASSWD; a root-only wrapper runs `restic snapshots --json --no-lock` from `/etc/drift-collector/restic.env` because sudoers cannot cleanly allow `sh -c '. env && restic ...'`. Both scripts pass `sh -n`; `.gitattributes` pins `ops/ssh/*` and `ops/sudoers/*` to LF so a Windows checkout cannot break `#!/bin/sh`. Nothing in `ops/` is run by the tests; `visudo -c -f` runs on the Linux host first.
- 2026-10-23: Redaction before persistence, 6-hex pseudonyms, salt in `REDACT_SALT`. Trace `detail` goes through the same redactor as collected data (per-process random salt when blank), so trace lines and stored observations share pseudonyms within a run and a blank-salt trace cannot be linked across runs. The sample bundle is already redacted (documentation ranges, `.invalid` names), so the redactor leaves it unchanged by construction.
- 2026-10-23: `sample/observations.json` (the earlier hand-written probes) is removed; SAMPLE_MODE now runs the pass over `sample/bundle.json` through the data layer and the World Model, and `test/pipeline.test.ts` runs the same pass over a bundle whose DNS record still points at an inventory host and asserts zero findings. The Zetaris shape probe no longer names the vendor's demo datasets.
- 2026-10-23: Spike A needs registration rights (`CREATE`/`DROP LIGHTNING DATABASE`) that the agent's General-role key should not hold, so `npm run smoke` runs the read-only half (`SELECT 1`, `SHOW LIGHTNING DATABASES`) and the registration probe sits behind `--register`. The spike's DDL goes through the raw adapter; the agent's own query path is SELECT-only through `DataLayer.run` and `assertSelectOnly`, and nothing the agent runs can reach a DDL statement.
- 2026-10-24: Two adversarial reviews applied. The hero, resolution and `dns_target_in_inventory` queries join A and AAAA records only (a TXT or CNAME on the name is not an address and was a finding on every pass); the receipt gate needs a found, verified receipt, so an unreceipted response is `not_judged`, and a receipt lookup that fails is `not_judged` instead of a throw; a host run pairs with a DNS run only within six hours, so a gated DNS run is named in the trace instead of a stale one standing in; the SQL guards strip literals before the semicolon check (a DMARC `;` in a parameter no longer aborts the pass) and refuse double quotes; a refused check is one recorded rejection, not a dead pass; each hero row carries its own DNS record; the DQ gate counts stored rows for host surfaces; every query has a total ORDER BY; the tracer redacts every free-text field and stamps `model_requested: none` on a sample pass; the sql.js loader refuses non-canonical timestamps.
