# Traces

Three traces exactly as the tracer (`src/trace.ts`) wrote them to `logs/`: one JSON line per agent action, every
free-text field through the redactor, so each name, address, host and actor is the pseudonym the stored rows carry.
All three were recorded on 25 Oct 2026. The first two predate the `engine` field on query lines; in them a query
whose SQL names `DRIFT.<table>` went to Zetaris Lightning SQL (the datasource prefix `ZetarisEngine.qualify` adds).
The third carries `engine` on every query line.

- [act_mvnn2tja.jsonl](act_mvnn2tja.jsonl): the lab's FIX investigated with Nemotron through Nightshift
  ([lab/README.md](../../lab/README.md), "No valid copy"), `npm run act -- --tenant lab-1 --apply --only investigate`,
  09:42:27 to 09:43:53 UTC. The pass decides FIX on `www.lab.test` (host-951abf), Lightning selects the checks
  (receipt `rcpt_req_nn4ag0yu`), Ultra's verdict stands (receipt `rcpt_req_iehg9gmt`), and the fix is refused with no
  valid copy. The investigation's pass also read the production tenant's runs, so their findings appear beside the
  lab's, pseudonymised; only lab-1's FIX was acted on.
- [cycle_mvo5600q.jsonl](cycle_mvo5600q.jsonl): the act-three cycle on the production estate, tenant client-1, with
  `--apply`, 18:08:54 to 18:16:51 UTC: nine steps ok (collect Cloudflare and both Linux hosts, probe, validate, pass,
  act, tickets, document), 29 findings, verbs ADOPT 23, HOLD 4, ESCALATE 1, FIX 1; the act step investigates the FIX
  and refuses the fix, and the tickets step creates #7.
- [cycle_mvoa0l1i.jsonl](cycle_mvoa0l1i.jsonl): the lab's explain cycle, tenant lab-1, after a `sudo -n tee` break
  of `lab.example` to 8098 and its collection ([lab/README.md](../../lab/README.md), "Why it changed, on the lab"),
  `npm run cycle -- --tenant lab-1 --apply --skip collect,validate --tickets-dry-run`, 20:24:34 to 20:26:12 UTC: the
  pass gives ROLLBACK 1 and HOLD 1, the explainer names the cause, operator_edit by user-212a17 over ssh from
  ip-391349 (sudo tee) at 20:22 UTC, the act step's rollback_file is done with its probe ok, and the tickets step
  drafts the change with its Why; 495 queries through Zetaris, 0 failed.
