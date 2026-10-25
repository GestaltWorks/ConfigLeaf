#!/usr/bin/env bash
# Brings the lab estate up, in WSL where Docker Engine runs. From the repository root on Windows:
#   wsl.exe -d Ubuntu-24.04 -- bash lab/up.sh
# The client key pair goes to lab/.keys/ once; the image drift-lab is built; the container drift-lab starts with
# 127.0.0.1:2222 -> 22, 127.0.0.1:18080 -> 80 (nginx, the address the probes ask under PROBE_TARGETS_OVERRIDE) and the
# public key mounted; once sshd answers, lab/.keys/known_hosts holds the container's host key under the alias drift-lab
# and lab/ssh_config.local is the template with this machine's lab/ path in it.
set -euo pipefail
cd "$(dirname "$0")"
LAB=$(pwd)
KEYS=$LAB/.keys
mkdir -p "$KEYS"
[ -f "$KEYS/drift-lab" ] || ssh-keygen -q -t ed25519 -N '' -C drift-lab -f "$KEYS/drift-lab"

docker build -q -t drift-lab "$LAB" >/dev/null
docker rm -f drift-lab >/dev/null 2>&1 || true
docker run -d --init --name drift-lab --hostname drift-lab -p 127.0.0.1:2222:22 -p 127.0.0.1:18080:80 \
  -v "$KEYS/drift-lab.pub:/run/lab/authorized_keys:ro" drift-lab >/dev/null

for _ in $(seq 1 30); do
  if docker exec drift-lab pgrep -x sshd >/dev/null 2>&1 && timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/2222 && head -c 4 <&3' 2>/dev/null | grep -q SSH-; then
    break
  fi
  sleep 1
done
docker exec drift-lab pgrep -x sshd >/dev/null || { echo "lab: sshd is down after 30 s; docker logs drift-lab says why" >&2; exit 1; }

printf 'drift-lab %s\n' "$(docker exec drift-lab cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)" > "$KEYS/known_hosts"
if command -v wslpath >/dev/null 2>&1; then DIR=$(wslpath -m "$LAB"); else DIR=$LAB; fi
{
  echo "# Written by lab/up.sh from lab/ssh_config: the file LINUX_SSH_CONFIG names for the lab."
  sed -e '/^#/d' -e "s#@LAB_DIR@#$DIR#g" "$LAB/ssh_config"
} > "$LAB/ssh_config.local"
echo "lab up: ssh -F $DIR/ssh_config.local drift-lab; nginx on http://127.0.0.1:18080/"
