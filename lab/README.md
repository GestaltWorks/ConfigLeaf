# The lab estate

A throwaway container, `drift-lab`, stands in for a client host: Debian bookworm, nginx with `lab.example` (plain
http, `location /` proxied to 127.0.0.1:8081) and `www.lab.test` (static) in `sites-available`, linked from
`sites-enabled`; the login `drift` with sudo for `tee`, `nginx`, `systemctl` and `rm`; a server-config tarball in
`/var/backups/export`; one certbot renewal config. Its ssh alias lives in `lab/ssh_config.local`, so the write path
runs for real against it, under tenant `lab-1`, with the app Postgres and the vault of `.env`.

## Up and down, from the repository root in Git Bash, through WSL, where Docker Engine runs

```bash
wsl.exe -d Ubuntu-24.04 -- bash lab/up.sh     # key pair in lab/.keys/, image and container, ssh_config.local; "lab up"
wsl.exe -d Ubuntu-24.04 -- bash lab/down.sh   # removes the container; the image and the keys stay
```

## The loop against the lab

Node's `loadEnvFile` leaves variables already set alone, so the prefix wins over `.env`. `MSYS_NO_PATHCONV=1` keeps
Git Bash from rewriting `=/var/backups/export` into `C:/Program Files/Git/var/backups/export` (measured). Git's own
ssh reads the key; Windows OpenSSH refuses it for the permissions `lab/.keys/` inherits on `D:`.

```bash
export MSYS_NO_PATHCONV=1 LINUX_HOSTS=drift-lab=/var/backups/export LINUX_SSH_CONFIG=D:/Projects/drift-agent/lab/ssh_config.local
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
to a technician`; a break with other bytes (8090) gets its own rollback. Those rows carry `failed`, the status the
code gave a completed write with no probe read before `unverified` existed.

Measured 25 Oct 2026, 05:46 to 05:49 UTC, with the unverified status and the account's token: the break to 8091
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

## How it differs from a real host

- `systemctl` is `lab/systemctl`, a stand-in for systemd: `reload nginx` runs `nginx -s reload`, `status nginx` asks
  pgrep, `list-timers --all --no-pager` prints a fixed two-line table.
- The sudo drop-in covers `tee`, so the break goes in through `sudo -n tee`; the operator's login runs `sudo sed -i`.
- The lab has no DNS provider: `lab-1` holds no `cloudflare.dns` run, and the classes that pair a host run with one
  (`orphan_vhost`, `orphan_record`, `proxied_without_real_ip`) stay silent.
- Verification: the Actor probes http and tls of the names the file serves, read from the Cloudflare account's
  records (src/actions/act.ts probeNames). The lab names resolve nowhere and sit in no zone, so every completed
  rollback on the lab ends `unverified`: the lab proves the write path, and verification is measured on hosts whose
  names resolve. Verification against a lab needs a resolvable name with a certificate the probe trusts, or a probe
  override that supplies the lab's names, address and certificate authority.
