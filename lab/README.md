# The lab estate

A throwaway container, `drift-lab`, stands in for a client host: Debian bookworm, nginx with `lab.example` (plain
http, `location /` proxied to 127.0.0.1:8081) and `www.lab.test` (static) in `sites-available`, linked from
`sites-enabled`; the login `drift` with sudo for `tee`, `nginx`, `systemctl`, `rm` and `journalctl`; a server-config tarball in
`/var/backups/export`; one certbot renewal config. Its ssh alias lives in `lab/ssh_config.local`, so the write path
runs for real against it, under tenant `lab-1`, with the app Postgres and the vault of `.env`. Its nginx answers on
`127.0.0.1:18080` of this machine, so the probes reach both names.

## Up and down, from the repository root in Git Bash, through WSL, where Docker Engine runs

```bash
wsl.exe -d Ubuntu-24.04 -- bash lab/up.sh     # key pair in lab/.keys/, image and container, ssh_config.local; "lab up"
wsl.exe -d Ubuntu-24.04 -- bash lab/down.sh   # removes the container; the image and the keys stay
```

## The two lab aids

- The published port: `lab/up.sh` maps `127.0.0.1:18080` to the container's port 80, beside `127.0.0.1:2222` to 22.
  The lab takes 18080, since port 8080 of this machine was in use on 25 Oct 2026.
- `PROBE_TARGETS_OVERRIDE=<name>=<address>[:<port>],...` (`src/config.ts`, `.env.example`): set on the command line,
  it is the probe population of every probe run (`npm run probe`, the cycle's probe step, the Actor's verification
  after a write), and the Cloudflare read is skipped, one trace line saying so. Each name's http probe is `GET /` at
  the address over plain http with the name as Host, recorded `over plain http at <address>:<port> (override)`; its
  dns probe holds the override's address, `override [<address>]`; its tls probe is recorded `skipped: no TLS on this
  target`, status `skipped`. A skipped probe counts neither way: the Decider reads production from the probes that
  ran, and a rollback is done when every verification probe that ran is ok.

```bash
PROBE_TARGETS_OVERRIDE=lab.example=127.0.0.1:18080,www.lab.test=127.0.0.1:18080 npm run probe -- --tenant lab-1
PROBE_TARGETS_OVERRIDE=lab.example=127.0.0.1:18080 npm run act -- --tenant lab-1 --apply --only rollback_file
```

## The loop against the lab

Node's `loadEnvFile` leaves variables already set alone, so the prefix wins over `.env`. `MSYS_NO_PATHCONV=1` keeps
Git Bash from rewriting `=/var/backups/export` into `C:/Program Files/Git/var/backups/export` (measured). Git's own
ssh reads the key; Windows OpenSSH refuses it for the permissions `lab/.keys/` inherits on `D:`. A relative
`LINUX_SSH_CONFIG` resolves against the working directory, the repository root every npm script runs from.

```bash
export MSYS_NO_PATHCONV=1 LINUX_HOSTS=drift-lab=/var/backups/export LINUX_SSH_CONFIG=lab/ssh_config.local
npm run collect:linux -- --host drift-lab --tenant lab-1
npm run approve -- --tenant lab-1 --host drift-lab --all
npm run validate:copies -- --tenant lab-1
npm run pass -- --tenant lab-1
ssh -F lab/ssh_config.local drift-lab "sed 's#127.0.0.1:8081;#127.0.0.1:8091;#' /etc/nginx/sites-available/lab.example > /tmp/x && sudo -n tee /etc/nginx/sites-available/lab.example < /tmp/x >/dev/null && sudo -n nginx -t && sudo -n systemctl reload nginx"
npm run collect:linux -- --host drift-lab --tenant lab-1 && npm run pass -- --tenant lab-1
npm run act -- --tenant lab-1                                         # the plan
npm run act -- --tenant lab-1 --apply --only rollback_file            # the rollback, as measured
npm run document -- --tenant lab-1 --out logs/document-lab-1.md
npm run collect:linux -- --host drift-lab --tenant lab-1 && npm run pass -- --tenant lab-1
```

The apply runs with the account's own `CLOUDFLARE_API_TOKEN` from `.env`: the verification reads the account's zones
and records to find the names the file serves, the same read the collectors and the probe step make every cycle.
`--only rollback_file` keeps the apply to the host's write path.

Measured 25 Oct 2026, 05:17 to 05:28 UTC: the first collection complete, 2 of 2 files, vault commit 5dde7698; 4
approvals; nginx-t ok in 1 round with 0 gaps; 0 findings. After the break, lab.example answers 502 and the pass gives
`drift_vs_approved` ROLLBACK under rule-6c41a25a00c404c8 and `changed_since_backup` HOLD 24 h. The apply writes the
copy through `sudo -n tee` (before aef9a6791a0e, after a811a0a5d0dc, the approved bytes), `nginx -t` and the reload
pass, `nginx -T` shows 8081, lab.example answers 200, and the action row reads `failed: written and reloaded; the
probes of lab.example did not run`. The next collection and pass: 0 findings. The same break again gives `refused:
action <id> rolled this file back to commit 5dde7698 over the same live bytes and failed ...; the same write is left
to a technician`; a break with other bytes (8090) gets its own rollback. Those rows carry `failed`: the Actor that
wrote them, 05:22 to 05:28 UTC, had no `unverified` status.

Measured 25 Oct 2026, 05:46 to 05:49 UTC, with the account's token: the break to 8091
(the file 34c11a7a6a95, bytes no earlier break carried); the collection, run run-463c7c0ce537bd16, vault commit
7d229b0a; the pass gives `drift_vs_approved` ROLLBACK under rule-6c41a25a00c404c8 (vault commit 5dde7698 holds the
approved copy, validated ok with 0 gaps) and `changed_since_backup` HOLD 24 h; the plan is 1 rollback_file, refused
0. The apply, 05:47:39.599 to 05:47:41.513 UTC:

```text
rollback_file act-b5d5e77f69ab6f17 unverified: written and reloaded; no probe of lab.example ran (the account holds no record of these names)
  before 34c11a7a6a95, after a811a0a5d0dc; vault commit 5dde7698
  write: exit 0
  nginx-t: exit 0, nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
  reload: exit 0, 2026/10/25 05:47:39 [notice] 334#334: signal process started
act: applied: 1 action (rollback_file 1, revert_record 0, investigate 0, fix 0): done 0, unverified 1, failed 0, refused 0, not_judged 0; 0 already recorded; 1 action rows written
```

The action row holds status `unverified`, that reason, verification `''`, after_hash the copy's sha256. Over ssh at
05:48:17 UTC the live file hashes to a811a0a5d0dc, the copy's bytes, and `nginx -T` shows `proxy_pass
http://127.0.0.1:8081;`. The next collection, run run-f97423f25dc75884 (vault commit 090b6d61), and pass: 0 findings.

## No valid copy: a FIX, investigated with Nemotron through Nightshift

A change signed off before the validator has seen it, then broken.

```bash
ssh -F lab/ssh_config.local drift-lab "sed 's#root /var/www/lab-test;#root /var/www/lab;#' /etc/nginx/sites-available/www.lab.test > /tmp/x && sudo -n tee /etc/nginx/sites-available/www.lab.test < /tmp/x >/dev/null && sudo -n nginx -t && sudo -n systemctl reload nginx"
npm run collect:linux -- --host drift-lab --tenant lab-1
npm run approve -- --tenant lab-1 --host drift-lab --object /etc/nginx/sites-available/www.lab.test --note "lab: signed off before validation"
ssh -F lab/ssh_config.local drift-lab "sed 's#    index index.html;#    index index.html;\n    return 503;#' /etc/nginx/sites-available/www.lab.test > /tmp/x && sudo -n tee /etc/nginx/sites-available/www.lab.test < /tmp/x >/dev/null && sudo -n nginx -t && sudo -n systemctl reload nginx"
npm run collect:linux -- --host drift-lab --tenant lab-1
PROBE_TARGETS_OVERRIDE=lab.example=127.0.0.1:18080,www.lab.test=127.0.0.1:18080 npm run probe -- --tenant lab-1
npm run pass -- --tenant lab-1
npm run act -- --tenant lab-1 --apply --only investigate
npm run tickets -- --tenant lab-1
```

Measured 25 Oct 2026, 09:34 to 09:48 UTC. The changed file (root `/var/www/lab`) hashes to 0df3950bca45; its
collection, run run-d1fcc061e5c34158, commits it at vault commit 4f208c94; `approve` prints `replaces` and writes 1
row. The break (`return 503;`, file 2ea1f9b2bd14) answers 503; its collection is run run-2c3fc585f404b90f (vault
commit be6c0996). A pass before any probe run decides ESCALATE: `live value drifted from approved 0df3950bca45 with no
valid copy (1 copy in the vault, latest validation unvalidated) and no probe run in this pass, so production is
unknown and rule rule-6c41a25a00c404c8 sends it to a technician`. The probe run under the override, run
run-396c20fb165306ed, is complete at 6 of 6: http 1 ok (lab.example 200), 1 fail (www.lab.test 503), dns 2 ok, tls 2
skipped. The next pass decides FIX: `... and production affected (1 failing probe in run-396c20fb165306ed: http
www.lab.test), so rule rule-6c41a25a00c404c8 investigates, fixes where allowed, documents and opens a ticket`.

The first apply, 09:37:40 to 09:39:43 UTC, sent Lightning's selection with max_tokens 1,024: four route attempts
(openrouter/nvidia/nemotron-3.5-lightning twice, nvidia/nemotron-3.5-lightning-30b-a3b twice) each answered
`empty_response`, the default checks ran, Ultra stood on receipt rcpt_req_88ch3rxi, and the rows are
act-8e962ee34398e0e1 (investigate done) and act-190d06845d8ee1be (fix refused). For the second apply the selection call
takes the eval's cap, SELECT_MAX_TOKENS (16,384), after a new pass gave a new FIX disposition. The second apply, 09:42:26
to 09:43:53 UTC:

```text
investigate act-45f088e61ed545f1 done: investigated: 4 checks ran (1 hold, 3 fail); the judge's verdict counted: stands
  verification probe-2f2d50204c69ccbe,probe-5fb5e859aa7b4b32,probe-a20c634f2e8312dd; receipts rcpt_req_nn4ag0yu,rcpt_req_iehg9gmt
  Lightning selection (receipt rcpt_req_nn4ag0yu, openrouter/nvidia/nemotron-3.5-lightning, cache miss, route openrouter/nvidia/nemotron-3.5-lightning): 4 valid checks: setting_matches_approved, change_in_last_backup, restore_would_regress, run_complete
  judge stands (receipt rcpt_req_iehg9gmt, openrouter/nvidia/nemotron-3-ultra-550b-a55b:free, cache miss, route openrouter/nvidia/nemotron-3-ultra-550b-a55b:free): the refuting SELECT returned no rows, 0 rows
  probe probe-2f2d50204c69ccbe: http www.lab.test fail (status 503 server=nginx/1.22.1 cf-ray absent; over plain http at 127.0.0.1:18080 (override))
fix act-e201f12320296992 refused: no fix is allowed without a valid copy; investigated and ticketed
act: applied: 2 actions (rollback_file 0, revert_record 0, investigate 1, fix 1): done 1, unverified 0, failed 0, refused 1, not_judged 0; 0 already recorded; 2 action rows written
```

Lightning answered on its first route attempt, 4,094 tokens out in 27.5 s; Ultra on its first, 1,001 tokens out in
14.9 s; both receipts verify, custody holds under app drift-agent-lab-1. The ticket step opens issue #3 in the tickets
repository, `FIX drift_vs_approved: /etc/nginx/sites-available/www.lab.test on host-951abf`, labels `type:incident`,
`P1`, `verb:FIX`, the selection, the checks, the verdict and the probes under Evidence, both actions under Work done,
both receipts under Receipts. Restored by hand to 0df3950bca45, the next collection (run run-0f5afdbf81b5b05a) and
pass give 1 finding, `changed_since_backup` HOLD 24 h, since the export holds the image's bytes. With the image's bytes
back (e646212adb59) and approved again (`superseded`), the pass at 09:48:18 UTC gives 0 findings. Issue #3 stays open
for the technician.

## Verification to done

```bash
ssh -F lab/ssh_config.local drift-lab "sed 's#127.0.0.1:8081;#127.0.0.1:8094;#' /etc/nginx/sites-available/lab.example > /tmp/x && sudo -n tee /etc/nginx/sites-available/lab.example < /tmp/x >/dev/null && sudo -n nginx -t && sudo -n systemctl reload nginx"
npm run collect:linux -- --host drift-lab --tenant lab-1 && npm run pass -- --tenant lab-1
PROBE_TARGETS_OVERRIDE=lab.example=127.0.0.1:18080 npm run act -- --tenant lab-1 --apply --only rollback_file
npm run tickets -- --tenant lab-1
npm run collect:linux -- --host drift-lab --tenant lab-1 && npm run pass -- --tenant lab-1
```

Measured 25 Oct 2026, 09:49 to 09:55 UTC. A first break to 8093 (file b8f9896dcb0f) gives ROLLBACK under
rule-6c41a25a00c404c8 from vault commit 5dde7698, validated ok with 0 gaps; its apply, act-3892888a4e7bd1e5, writes the
copy and reloads, the whole action runs in 0.31 s, and its http probe reads 502: `failed: written and reloaded; 1 of 1
probe fail: http lab.example; 1 skipped (tls lab.example: no TLS on this target)`. Inside the container lab.example
answers from the old configuration for 0.13 s after `systemctl reload nginx` returns (measured with a 20 ms poll), so
the live Actor waits RELOAD_SETTLE_MS (2 s) before its verification probes. The break to 8094 (file 463997de96ba), its
collection (run run-b78229c438b759eb, vault commit 15b60353) and pass give the same ROLLBACK; the apply, 09:53:34 to
09:53:39 UTC:

```text
rollback_file act-649588b7e1625711 done: restored to the approved copy at vault commit 5dde7698; nginx -t passed, nginx reloaded, 1 probe of lab.example ok; 1 skipped (tls lab.example: no TLS on this target)
  before 463997de96ba, after a811a0a5d0dc; vault commit 5dde7698; verification probe-36eb2c1bba298a2a
  write: exit 0
  nginx-t: exit 0, nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
  reload: exit 0, 2026/10/25 09:53:37 [notice] 1735#1735: signal process started
  live file before: 463997de96ba
  after: a811a0a5d0dc, the copy's bytes; nginx -t passed and nginx reloaded
  probes asked 2000 ms after the reload returned, once the new workers answer
  probe probe-36eb2c1bba298a2a: http lab.example ok (status 200 server=nginx/1.22.1 cf-ray absent; over plain http at 127.0.0.1:18080 (override))
  probe probe-e9a352d65b4dd8a0: tls lab.example skipped (skipped: no TLS on this target)
act: applied: 1 action (rollback_file 1, revert_record 0, investigate 0, fix 0): done 1, unverified 0, failed 0, refused 0, not_judged 0; 0 already recorded; 1 action rows written
```

The action row holds status `done`, verification `probe-36eb2c1bba298a2a`. The ticket step creates and closes issue
#4, `ROLLBACK drift_vs_approved: /etc/nginx/sites-available/lab.example on host-951abf`, labels `type:change`, `P1`,
`verb:ROLLBACK`, closing comment `The rollback is done and verified by probes probe-36eb2c1bba298a2a; closing.` The
next collection (run run-71776a91583187d1, vault commit 5d780b42) and pass: 0 findings.

## Why it changed, on the lab

The journal stand-in (`lab/journalctl`, below) gives every collection a login and a `sudo tee` of `lab.example`, so a
break collected through it reads back with its cause: who changed the file, over which login, from which address.

```bash
export MSYS_NO_PATHCONV=1 LINUX_HOSTS=drift-lab=/var/backups/export LINUX_SSH_CONFIG=lab/ssh_config.local
export PROBE_TARGETS_OVERRIDE=lab.example=127.0.0.1:18080,www.lab.test=127.0.0.1:18080
ssh -F lab/ssh_config.local drift-lab "sed 's#127.0.0.1:8081;#127.0.0.1:8098;#' /etc/nginx/sites-available/lab.example > /tmp/x && sudo -n tee /etc/nginx/sites-available/lab.example < /tmp/x >/dev/null && sudo -n nginx -t && sudo -n systemctl reload nginx"
npm run collect:linux -- --host drift-lab --tenant lab-1
npm run cycle -- --tenant lab-1 --apply --skip collect,validate --tickets-dry-run
npm run tickets -- --tenant lab-1 --dry-run --verbose
```

Measured 25 Oct 2026, 20:24 to 20:29 UTC, after `lab/up.sh` rebuilt the image. The break to 8098 (file a5b94717c6fe);
its collection, run run-ea6025e231e361d0, complete at 2 of 2 files, vault commit 46c5ef5e, the journal read through
sudo -n: 5 lines kept, 5 `audit_event` rows written. The cycle, 20:24:34 to 20:26:12 UTC, its trace committed as
[examples/traces/cycle_mvoa0l1i.jsonl](../examples/traces/cycle_mvoa0l1i.jsonl):

```text
  pass      2 findings    ROLLBACK 1 · HOLD 1                                       82.9 s
            Zetaris Lightning SQL over DRIFT · 427 queries · 26,352 rows · 0 failed
            changed since the last backup 1 · drifted from the approved value 1
            ROLLBACK  drifted from the approved value · sites-available/lab.example on host-951abf · copy 5dde7698 validated ok
  explain   1 cause       operator 1                                                 1.3 s
  act       1 action                                                                 3.7 s
            rollback_file  sites-available/lab.example on host-951abf · a5b94717 → a811a0a5 · nginx -t ok · reloaded · 1 probe ok, 1 skipped · done 2.3 s
what happened
  A vhost file drifted from its approved copy; the agent restored it, nginx reloaded, 1 probe passed, and a new ticket is drafted (tickets dry run). The file was changed at 20:22 UTC by user-212a17 over ssh from ip-391349 (sudo tee), 4 minutes before the agent restored it.
  1 finding is held with an expiry.
```

The cause is operator_edit: the stand-in's `sudo tee` of the file at 20:22:11 UTC, its login `labtech` as
`user-212a17`, and the same login's ssh session at 20:21:17 UTC from `ip-391349`, the pseudonym of 10.77.0.23. The
ticket's Why holds that sentence, 20 timeline lines (the ledger's rollbacks of the file, certbot's reloads, each
`tee` of the file and the login) and the 11-line diff from `--- approved 5dde7698`, the approval's own vault commit,
to `+++ live 46c5ef5e`. The owner's document (`npm run document -- --tenant lab-1 --out logs/document-lab-1.md`,
20:29 UTC) lists the same sentence under Why.

## The lab's stand-ins

- `systemctl` is `lab/systemctl`, a stand-in for systemd: `reload nginx` runs `nginx -s reload`, `status nginx` asks
  pgrep, `list-timers --all --no-pager` prints a fixed two-line table.
- `journalctl` is `lab/journalctl`, a stand-in for journald, which the sudo drop-in allows: the read session's call
  prints eight lines in a host journal's shape, timed back from the call. The collector's host-side filter keeps five
  (certbot's reload after a renewal at T-9 h; the login `labtech` from 10.77.0.23 at T-3 min; `labtech`'s sudo
  `tee` of `/etc/nginx/sites-available/lab.example`, `nginx -t` and `systemctl reload nginx` at T-2 min) and drops
  three (a `tee` to `/etc/other/app.env`, an `apt install`, a `cat` of `/etc/hosts`). Every collection adds five new
  `audit_event` rows, since the times move with the call. Each row carries `user-212a17` for `labtech` and none for
  certbot; the login's old_value is `ip-391349`, the redactor's pseudonym of the private address 10.77.0.23
  (measured 20:24 UTC, run run-ea6025e231e361d0).
- The sudo drop-in covers `tee`, so the break goes in through `sudo -n tee`; the operator's login runs `sudo sed -i`.
- The lab has no DNS provider: `lab-1` holds no `cloudflare.dns` run, and the classes that pair a host run with one
  (`orphan_vhost`, `orphan_record`, `proxied_without_real_ip`) stay silent.
- Verification: the Actor probes http and tls of the names the file serves, read from the Cloudflare account's
  records (src/actions/act.ts probeNames). The lab names sit in no zone, so on the lab the population comes from
  `PROBE_TARGETS_OVERRIDE`: http over plain http at 127.0.0.1:18080 with the name as Host, dns through the override,
  tls skipped. A completed rollback without the override ends `unverified` (05:47 above); with it, `done` (09:53).
