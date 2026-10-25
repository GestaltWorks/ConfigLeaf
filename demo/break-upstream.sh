#!/usr/bin/env bash
# The operator's on-camera break for act one: point one vhost's proxy_pass at another port on a host the
# agent watches, the same way a careless edit would, then let the next cycle find it and roll it back.
#
#   demo/break-upstream.sh <ssh alias> <vhost file> <old port> <new port>
#   demo/break-upstream.sh host-redacted /etc/nginx/conf.d/example.conf 3000 3009
#
# What it does on the host, over one ssh session with the operator's own key: reads the file, replaces
# ":<old port>" with ":<new port>" on its proxy_pass lines, writes the result back through sudo -n tee,
# runs nginx -t and reloads nginx, then prints the file's sha256 before and after. Nothing else changes.
# nginx -t failing leaves the file as written and stops; the agent's rollback restores the approved copy
# on the next cycle either way. Undo by hand: run it again with the ports swapped.
set -euo pipefail
alias_="${1:?ssh alias}"; file="${2:?vhost file}"; old="${3:?old port}"; new="${4:?new port}"
[[ "$old" =~ ^[0-9]+$ && "$new" =~ ^[0-9]+$ ]] || { echo "ports must be numbers" >&2; exit 2; }
[[ "$file" == /etc/nginx/* ]] || { echo "the file must live under /etc/nginx" >&2; exit 2; }
q=$(printf '%q' "$file")
ssh -o BatchMode=yes -o ConnectTimeout=15 "$alias_" bash -s -- "$q" "$old" "$new" <<'EOF'
set -euo pipefail
f=$(eval "printf '%s' $1"); old=$2; new=$3
printf 'before  %s\n' "$(sha256sum "$f" | cut -c1-12)"
n=$(grep -cE "proxy_pass[[:space:]]+https?://[^;]*:${old}(/|;|[[:space:]])" "$f" || true)
[ "$n" -gt 0 ] || { echo "no proxy_pass to port ${old} in ${f}" >&2; exit 3; }
tmp=$(mktemp)
sed -E "s#(proxy_pass[[:space:]]+https?://[^;]*):${old}(/|;|[[:space:]])#\1:${new}\2#g" "$f" > "$tmp"
sudo -n tee "$f" < "$tmp" > /dev/null
rm -f "$tmp"
sudo -n nginx -t
sudo -n systemctl reload nginx
printf 'after   %s  (%s proxy_pass line(s) now :%s)\n' "$(sha256sum "$f" | cut -c1-12)" "$n" "$new"
EOF
