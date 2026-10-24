# ops: collector-side access

The agent reads servers over SSH as a dedicated user, `drift-collector`. There is no "read-only SSH":
a shell is a shell, and a key that can open one can do anything its user can. The honest substitute
is this pair:

- a forced command in `authorized_keys`, so the key can only ever run `drift-collect`, which answers an
  enumerated set of read requests and refuses everything else (`refused` on stderr, exit 2);
- a sudoers fragment that lets that user perform exactly the root-only reads those requests need,
  NOPASSWD, and nothing else.

Nothing here is executed by the tests. Review it by eye.

| File | Installs to | Owner, mode |
|---|---|---|
| `ssh/authorized_keys.example` | `/home/drift-collector/.ssh/authorized_keys` | drift-collector, 0600 |
| `ssh/drift-collect` | `/usr/local/bin/drift-collect` | root, 0755 |
| `ssh/drift-restic-snapshots` | `/usr/local/bin/drift-restic-snapshots` | root, 0755 |
| `sudoers/drift-collector` | `/etc/sudoers.d/drift-collector` | root, 0440 |

## Requests the forced command answers

sshd puts the client's command line in `SSH_ORIGINAL_COMMAND`. `drift-collect` matches it as a whole
string against this table and never evaluates it as shell.

| Request | Runs | Root |
|---|---|---|
| `nginx -T` | `/usr/sbin/nginx -T` | yes |
| `cat /etc/nginx/<path>` | `/usr/bin/cat /etc/nginx/<path>`, after the path passes an allowlist (no `..`, no space, only `[A-Za-z0-9/._-]`, symlink target still under `/etc/nginx`) | yes |
| `cat /etc/hosts` | `/usr/bin/cat /etc/hosts` | no |
| `cat /etc/resolv.conf` | `/usr/bin/cat /etc/resolv.conf` | no |
| `etckeeper vcs log -n 50` | `/usr/bin/etckeeper vcs log -n 50` | yes |
| `restic snapshots --json` | `drift-restic-snapshots`, which loads `RESTIC_REPOSITORY` and `RESTIC_PASSWORD_FILE` from root-only `/etc/drift-collector/restic.env` | yes |
| anything else, including no command | `refused`, exit 2 | |

The collector's output is redacted by `src/redactor.ts` before it is stored or traced.

## Install, as root on each collected host

```sh
useradd --system --create-home --shell /bin/sh drift-collector   # a real shell: sshd runs the forced command through it
install -o root -g root -m 0755 ops/ssh/drift-collect ops/ssh/drift-restic-snapshots /usr/local/bin/
install -d -o drift-collector -g drift-collector -m 0700 /home/drift-collector/.ssh
# paste the collector's PUBLIC key into the one line of ops/ssh/authorized_keys.example, then:
install -o drift-collector -g drift-collector -m 0600 authorized_keys /home/drift-collector/.ssh/authorized_keys
visudo -c -f ops/sudoers/drift-collector && install -o root -g root -m 0440 ops/sudoers/drift-collector /etc/sudoers.d/drift-collector
install -d -o root -g root -m 0700 /etc/drift-collector
# /etc/drift-collector/restic.env, root 0600: RESTIC_REPOSITORY=... and RESTIC_PASSWORD_FILE=... (plus any backend credentials restic needs)
```

`visudo -c -f` parses the fragment without installing it; a typo in `/etc/sudoers.d` locks root out of
sudo, so it runs first. On sudo 1.9.10 or newer, tighten the `cat` line to the regex form shown in the
fragment's comment.

## Verify

```sh
ssh -i collector_key drift-collector@host 'nginx -T' | head -3        # configuration
ssh -i collector_key drift-collector@host 'cat /etc/nginx/../shadow'   # refused, exit 2
ssh -i collector_key drift-collector@host                              # refused, exit 2: no interactive login
```
