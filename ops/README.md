# ops: collector-side access

There is no "read-only SSH": a shell is a shell, and a key that can open one can do anything its user
can. What the agent has instead, in two stages:

1. **Today (the measured runs, 24 Oct 2026).** `src/collectors/linux.ts` opens one session per host
   through the operator's own `ssh_config` aliases, `ssh -o BatchMode=yes -o ConnectTimeout=15 <alias>
   bash -s`, and streams a fixed script of reads on stdin (`readScript()`; `test/nginx.test.ts` asserts it
   calls only `id -un`, `hostname`, `date`, `ip`, `ls`, `base64`, `systemctl list-timers`, `find`, a
   `tar -tz`/`tar -xO` + `sha256sum` function and the journal read, never anything that writes, and that every
   `tar` extraction goes to stdout). Whatever the login user cannot read comes back as a section with a
   non-zero exit status and is recorded as not readable. The one escalation is the journal read
   (`src/collectors/journal.ts`): `journalctl --utc -o short-iso --no-pager` over the last 24 h, run directly
   when the login is in `adm`, `systemd-journal` or `wheel`, else as `sudo -n journalctl` once `sudo -n -l
   journalctl` allows it, its lines filtered on the host; a refusal is a note and no lines. The honesty cost: the key
   is the operator's, so the read-only property is the script's, not the host's. The run records which
   login it used (`login_user` in the summary, pseudonymised unless it is root).
2. **Designed, not installed.** A dedicated user `drift-collector` whose key is bound to a forced
   command, `drift-collect`, which runs those same reads itself and refuses any other request (exit 2),
   plus a sudoers fragment that grants exactly one root-only helper for the reads a non-root user would
   lose. With this in place the host, not the client, decides what the key can read.

Neither host runs etckeeper or restic (survey, 24 Oct 2026). The backup artefact is a `systemd` timer,
`backup-export.timer`, that writes `server-config-<date>.tar.gz` nightly into a folder:
`/var/backups/export` on one host and `/home/<login>/backup-export` on the other (the login's own home,
so the path is configuration, `LINUX_HOSTS` in `.env`, not source; nine days of tarballs on each at the
time of the runs, beside application dumps written the same minute). The collector hashes every
regular-file member of the newest tarball that holds `etc/nginx`, on the host, through `tar -xO`
into `sha256sum`, so nothing is extracted to disk, and the hashes compare with the live files' `file`
rows, the certbot renewal configs among them; symlink members (the `sites-enabled` links) are left out, because `tar -xO` prints nothing for a
symlink and the empty input's hash would read as "every enabled site changed since the backup". Only
that tarball's family (`server-config-*`) becomes backup snapshots, so an application dump 52 ms younger
is never "the latest backup". The earlier etckeeper and restic requests are gone from this directory for
that reason.

Nothing here is executed by the tests. Review it by eye; `sh -n` both scripts and `visudo -c -f` the
fragment on a Linux host before installing. The forced command does not read the journal yet; the streamed
script's journal section is the one read it lacks. `test/nginx.test.ts` asserts the streamed script runs `sudo`
twice, both for `journalctl`; the write session (`src/actions/ssh.ts`) runs `sudo -n tee`, `nginx -t` and the
reload.

| File | Installs to | Owner, mode |
|---|---|---|
| `ssh/authorized_keys.example` | `/home/drift-collector/.ssh/authorized_keys` | drift-collector, 0600 |
| `ssh/drift-collect` | `/usr/local/bin/drift-collect` | root, 0755 |
| `ssh/drift-root-reads` | `/usr/local/bin/drift-root-reads` | root, 0755 |
| `sudoers/drift-collector` | `/etc/sudoers.d/drift-collector` | root, 0440 |
| (one line) | `/etc/drift-collector/export-dir` | root, 0644 |

## The reads

The stream is the one `src/collectors/linux.ts` parses: `@@DRIFT@@ BEGIN <kind> <arg>`, the command's
output, `@@DRIFT@@ END <exit status>`, then `@@DRIFT@@ DONE`. File bodies are base64 so sha256 of what
the agent holds equals `sha256sum` on the host. A file or tar member whose name, lower-cased, contains
`htpasswd`, `passwd`, `api-key`/`api_key`/`apikey`, `secret`, `token` or `credential`, or ends `.pem .key
.crt .cer .csr .p12 .pfx`, is never read (status 3) and is not counted in the population.

| Read | Command | Needed root in the measured runs |
|---|---|---|
| login user | `id -un` | no |
| host name | `hostname` (stored as `system.hostname`, displayed as its pseudonym; both hosts report the same name, so the ssh alias is the host identity) | no |
| clock | `date -u` | no |
| global addresses | `ip -4 -o addr show scope global`, `ip -6 -o addr show scope global` (link-local left out) | no |
| vhost directories | `ls -l --time-style=full-iso` of `/etc/nginx/conf.d`, `sites-available`, `sites-enabled` (symlink targets shown) | no |
| nginx files | `base64 -w0` of `/etc/nginx/nginx.conf`, every regular file in `conf.d` and `sites-available`, and every regular file they `include` under `/etc/nginx` (four rounds; a `sites-enabled` symlink is not read as a file, its target is); an include outside `/etc/nginx` (certbot's `options-ssl-nginx.conf`) is recorded as unresolved, not fetched | no, except one 0600 snippet on the sites-enabled host whose name is credential-shaped and is now skipped by name |
| timers | `systemctl list-timers --all --no-pager` | no |
| backup export | `ls -ld`, `ls -l`, `find -maxdepth 6 -readable -path '*nginx*'` with mtimes, `find ... -exec sha256sum` for plain copies, and `tar -tvzf` (regular-file lines only) + `tar -xOzf ... | sha256sum` per regular-file member of the newest `*.tar.gz`/`*.tgz` that holds `etc/nginx`, at most 256 MB | no on either host (both folders and tarballs are world-readable) |
| certbot renewals | `find /etc/letsencrypt/renewal -name '*.conf' -readable`, `base64 -w0` of each | no on either host (six and five configs read) |

`drift-collect` runs the first seven as `drift-collector` and hands the last two to
`sudo -n /usr/local/bin/drift-root-reads`, which emits those sections as root and nothing else: a
dedicated non-root user would not read `/etc/letsencrypt/renewal` (0700 root by default), and on a host
where the export folder is root-gathered it would not read that either. Today's collector (stage 1) has
no sudo at all; what it could not read is in the run's `not_readable` list.

The collector's output is redacted by `src/redactor.ts` (plus the collector's sweep for the
`name.com_ecc`, `name.com-0001`, `name.com.<tail>` and `*.name.com` shapes measured on these hosts)
before it is stored or traced.

## Requests the forced command answers

sshd puts the client's command line in `SSH_ORIGINAL_COMMAND`. `drift-collect` accepts an empty one
(`ssh drift-collector@host`) or the word `collect`, and nothing else.

| Request | Does |
|---|---|
| (none) or `collect` | streams the reads above |
| anything else, including `bash -s` with a script on stdin | `refused`, exit 2 |

The client's text never reaches a shell: there is no argument to pass, so there is nothing to allowlist.

## Install, as root on each collected host

```sh
useradd --system --create-home --shell /bin/sh drift-collector   # a real shell: sshd runs the forced command through it
install -o root -g root -m 0755 ops/ssh/drift-collect ops/ssh/drift-root-reads /usr/local/bin/
install -d -o root -g root -m 0755 /etc/drift-collector
printf '%s\n' /var/backups/export > /etc/drift-collector/export-dir        # or /home/<login>/backup-export: the LINUX_HOSTS value for the host
install -d -o drift-collector -g drift-collector -m 0700 /home/drift-collector/.ssh
# paste the collector's PUBLIC key into the one line of ops/ssh/authorized_keys.example, then:
install -o drift-collector -g drift-collector -m 0600 authorized_keys /home/drift-collector/.ssh/authorized_keys
visudo -c -f ops/sudoers/drift-collector && install -o root -g root -m 0440 ops/sudoers/drift-collector /etc/sudoers.d/drift-collector
```

`visudo -c -f` parses the fragment without installing it; a typo in `/etc/sudoers.d` locks root out of
sudo, so it runs first.

## Verify

```sh
ssh -i collector_key drift-collector@host | head -3                  # @@DRIFT@@ BEGIN whoami ...
ssh -i collector_key drift-collector@host collect | grep -c '^@@DRIFT@@ BEGIN file'   # one per nginx file
ssh -i collector_key drift-collector@host id                         # refused, exit 2
ssh -i collector_key drift-collector@host 'bash -s' < anything       # refused, exit 2
```

Then point `src/collectors/linux.ts` at the new user: the script it streams becomes redundant and the
client sends `collect` instead. Until then stage 1 is what runs, and its limits are in the run rows.
