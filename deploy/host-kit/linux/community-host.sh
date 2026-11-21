#!/usr/bin/env bash
# Container entrypoint for community hosting: registers this server with the backend, keeps the
# registration alive, then hands over to /usr/local/bin/ogsos-host (the game watchdog).
# Env: BACKEND (host:port)  NAME  REGION  MAX_PLAYERS  PUBLIC_PORT  [COMMUNITY_KEY]
set -uo pipefail

BACKEND="${BACKEND:-sos.joltora.com:7781}"
NAME="${NAME:-}"; REGION="${REGION:-EU}"
MAX_PLAYERS="${MAX_PLAYERS:-16}"; PUBLIC_PORT="${PUBLIC_PORT:-7777}"
COMMUNITY_KEY="${COMMUNITY_KEY:-}"
STATE=/state/session.env
WIN64=/game/SOS/Binaries/Win64
log() { echo "[community-host $(date -u +%FT%TZ)] $*"; }
die() { log "$*"; sleep 60; exit 1; }

# Minimal JSON string escaping: drop control characters, escape backslash and double quote.
jesc() { printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\/\\/g' -e 's/"/\\"/g'; }

[ ${#NAME} -ge 3 ] && [ ${#NAME} -le 48 ] || die "NAME must be 3 to 48 characters (edit server.env)"
case "$PUBLIC_PORT" in ''|*[!0-9]*) die "PUBLIC_PORT must be a number" ;; esac
[ "$PUBLIC_PORT" -ge 1024 ] && [ "$PUBLIC_PORT" -le 65535 ] || die "PUBLIC_PORT must be 1024..65535"
case "$MAX_PLAYERS" in ''|*[!0-9]*) die "MAX_PLAYERS must be a number" ;; esac
[ "$MAX_PLAYERS" -ge 2 ] && [ "$MAX_PLAYERS" -le 16 ] || die "MAX_PLAYERS must be 2..16"

# The game folder is the user's own copy (bind mount); put the host DLL and its ini next to the game exe.
[ -f "$WIN64/SOS-Win64-Shipping.exe" ] || die "no $WIN64/SOS-Win64-Shipping.exe: copy your 'SOS Test Server' folder to ./game"
cp -f /kit/sos_host/version.dll "$WIN64/version.dll" || die "cannot write to $WIN64 (chown -R 1000:1000 ./game)"
cp -f /kit/sos_host/sos_host.ini "$WIN64/sos_host.ini" || die "cannot write sos_host.ini"

mkdir -p /state 2>/dev/null; [ -w /state ] || die "/state is not writable by uid $(id -u) (chown 1000:1000 ./state)"
SESSION_ID=; SESSION_TOKEN=
[ -f "$STATE" ] && . "$STATE"

# register: POST the registration (renewal when SESSION_ID/TOKEN are set). Sets HTTP_CODE and BODY.
register() {
  local json="{\"name\":\"$(jesc "$NAME")\",\"region\":\"$(jesc "$REGION")\",\"port\":$PUBLIC_PORT,\"maxPlayers\":$MAX_PLAYERS,\"hostIds\":[\"0\"]"
  [ -n "$COMMUNITY_KEY" ] && json="$json,\"key\":\"$(jesc "$COMMUNITY_KEY")\""
  [ -n "$SESSION_ID" ] && [ -n "$SESSION_TOKEN" ] && json="$json,\"sessionId\":\"$SESSION_ID\",\"sessionToken\":\"$SESSION_TOKEN\""
  json="$json}"
  local out; out=$(curl -s -m 20 -w '\n%{http_code}' -H 'Content-Type: application/json' -d "$json" "http://$BACKEND/api/community/register")
  HTTP_CODE=$(printf '%s' "$out" | tail -n1); BODY=$(printf '%s' "$out" | sed '$d')
}
jget() { printf '%s' "$BODY" | grep -o "\"$1\":\"[^\"]*\"" | head -n1 | cut -d'"' -f4; }

register
if { [ "$HTTP_CODE" = 401 ] || { [ "$HTTP_CODE" = 403 ] && [[ "$BODY" == *ip-mismatch* ]]; }; } && [ -n "$SESSION_ID" ]; then
  log "saved registration was rejected ($HTTP_CODE); registering fresh"
  rm -f "$STATE"; SESSION_ID=; SESSION_TOKEN=; register
fi
case "$HTTP_CODE" in
  200) ;;
  409) die "already registered: a previous registration is still alive. Wait about 10 minutes, or restore ./state/session.env" ;;
  429) die "rate limited by the backend; retrying in a minute" ;;
  *)   die "registration failed (HTTP $HTTP_CODE): $BODY" ;;
esac
SESSION_ID=$(jget sessionId); SESSION_TOKEN=$(jget sessionToken)
[ -n "$SESSION_ID" ] && [ -n "$SESSION_TOKEN" ] || die "backend reply had no session: $BODY"
( umask 077; printf 'SESSION_ID=%s\nSESSION_TOKEN=%s\n' "$SESSION_ID" "$SESSION_TOKEN" > "$STATE" ); chmod 600 "$STATE" 2>/dev/null
log "registered, session ${SESSION_ID:0:8}"

# Heartbeat: renew every 4 minutes. The backend drops hosts about 10 minutes after the last renew/poll.
( while :; do
    sleep 240
    register
    [ "$HTTP_CODE" = 200 ] && log "renewed" || log "renew failed (HTTP $HTTP_CODE)"
  done ) &
HB_PID=$!

# Unregister is best-effort only (not done here): the backend expires the host about 10 minutes after the last renew.
export OGSOS_BACKEND="$BACKEND" SESSION_ID SESSION_TOKEN HOST_ID=0 LOBBY_STATUS=community
exec /usr/local/bin/ogsos-host
