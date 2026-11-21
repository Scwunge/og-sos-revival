#!/usr/bin/env bash
# Writes deploy/classic-backend/pool/host<n>.env for slots 1..N (new session id + token each, unless the
# file exists) and prints the matching OGSOS_CLASSIC_HOSTS value for the backend's env file.
#   make_pool_env.sh <slots> <backend service:port> <public ipv4> <first udp port> [name prefix]
#   e.g. make_pool_env.sh 2 backend-test:7781 203.0.113.10 7778 "OVH test"
set -euo pipefail
n="${1:?slots}"; backend="${2:?backend}"; pub="${3:?public ipv4}"; port="${4:?first port}"; label="${5:-OG SOS}"
dir="$(cd "$(dirname "$0")/../classic-backend" && pwd)/pool"; mkdir -p "$dir"
hosts=""
for i in $(seq 1 "$n"); do
  f="$dir/host$i.env"
  if [ ! -f "$f" ]; then
    umask 077
    printf 'OGSOS_BACKEND=%s\nSESSION_ID=%s\nSESSION_TOKEN=%s\nHOST_ID=0\nRESTART_HOUR=9\n' \
      "$backend" "$(cat /proc/sys/kernel/random/uuid)" "$(openssl rand -hex 24)" > "$f"
  else
    sed -i "s/^OGSOS_BACKEND=.*/OGSOS_BACKEND=$backend/" "$f"
  fi
  id=$(grep '^SESSION_ID=' "$f" | cut -d= -f2); tok=$(grep '^SESSION_TOKEN=' "$f" | cut -d= -f2)
  hosts="$hosts${hosts:+,}{\"host\":\"$pub\",\"port\":$((port + i - 1)),\"sessionId\":\"$id\",\"sessionToken\":\"$tok\",\"name\":\"$label $i\",\"hostIds\":[\"0\"]}"
done
echo "OGSOS_CLASSIC_HOSTS=[$hosts]"
echo "compose ports: $(for i in $(seq 1 "$n"); do printf 'OGSOS_POOL%d_PORT=%d ' "$i" $((port + i - 1)); done)" >&2
