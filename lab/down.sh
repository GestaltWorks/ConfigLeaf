#!/usr/bin/env bash
# Removes the lab container, in WSL where Docker Engine runs. From the repository root on Windows:
#   wsl.exe -d Ubuntu-24.04 -- bash lab/down.sh
# The image, the key pair and lab/ssh_config.local stay for the next lab/up.sh.
set -euo pipefail
docker rm -f drift-lab >/dev/null 2>&1 || true
echo "lab down"
