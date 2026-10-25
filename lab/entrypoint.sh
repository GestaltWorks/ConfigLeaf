#!/bin/sh
# drift-lab's entrypoint: the drift login's key from the mount (/run/lab/authorized_keys, lab/.keys/drift-lab.pub
# on the machine running Docker), then the upstream on 127.0.0.1:8081, nginx, and sshd in the foreground.
set -eu
install -d -m 0700 -o drift -g drift /home/drift/.ssh
install -m 0600 -o drift -g drift /run/lab/authorized_keys /home/drift/.ssh/authorized_keys
mkdir -p /run/sshd
ssh-keygen -A >/dev/null
python3 -m http.server 8081 --bind 127.0.0.1 --directory /var/www/upstream >/var/log/upstream.log 2>&1 &
nginx
exec /usr/sbin/sshd -D -e
