#!/usr/bin/env bash
# Runs the SOS: Classic listen host under Wine + Xvfb and keeps it healthy.
#   - mints the host AuthToken (HS512 JWT keyed with the session token, as server/matchmaking.js makeSessionJwt)
#     at every start, so the daily restart always has a fresh 24 h token
#   - writes the backend sections into the prefix's Engine.ini before every start
#   - watchdog: restarts the game if it exits, never logs "Listening with", or stops polling the backend
#   - daily restart at RESTART_HOUR (UTC) once the game has been up for at least 2 h
# Env (host.env): OGSOS_BACKEND=ip:port  SESSION_ID  SESSION_TOKEN  [HOST_ID=0]  [RESTART_HOUR=9]
#   [LISTEN_TIMEOUT=300]  [POLL_STALE=300]  [EXTRA_ARGS]
set -uo pipefail

: "${OGSOS_BACKEND:?}" "${SESSION_ID:?}" "${SESSION_TOKEN:?}"
HOST_ID="${HOST_ID:-0}"; RESTART_HOUR="${RESTART_HOUR:-9}"
LISTEN_TIMEOUT="${LISTEN_TIMEOUT:-300}"; POLL_STALE="${POLL_STALE:-300}"
WIN64=/game/SOS/Binaries/Win64
EXE=SOS-Win64-Shipping.exe
INI="$WINEPREFIX/drive_c/users/$(id -un)/AppData/Local/SOS/Saved/Config/WindowsClient/Engine.ini"
log() { echo "[ogsos-host $(date -u +%FT%TZ)] $*"; }

# The game does no DNS, so a compose service name (e.g. backend-test:7781) is resolved to an IPv4
# literal before every start. Use the service name: the published public IP does not hairpin from
# inside a container.
resolve_backend() {
  local name="${OGSOS_BACKEND%:*}" ip
  BPORT="${OGSOS_BACKEND##*:}"
  if [[ "$name" =~ ^[0-9.]+$ ]]; then ip="$name"; else ip=$(getent ahostsv4 "$name" | awk 'NR==1{print $1}'); fi
  [ -n "$ip" ] || { log "cannot resolve backend $name"; return 1; }
  BHOST="$ip"; BASE="http://$BHOST:$BPORT"
}
until resolve_backend; do sleep 10; done
b64u() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

mint_jwt() {
  local now exp head claims sig
  now=$(date +%s); exp=$((now + 24 * 3600))
  head=$(printf '{"typ":"JWT","alg":"HS512"}' | b64u)
  claims=$(printf '{"sub":"%s","id":"%s","user-id":"%s","account-id":"%s","roles":["user+session"],"iat":%d,"exp":%d}' \
    "$SESSION_ID" "$HOST_ID" "$HOST_ID" "$HOST_ID" "$now" "$exp" | b64u)
  sig=$(printf '%s.%s' "$head" "$claims" | openssl dgst -sha512 -hmac "$SESSION_TOKEN" -binary | b64u)
  printf '%s.%s.%s' "$head" "$claims" "$sig"
}

write_ini() {
  mkdir -p "$(dirname "$INI")"
  # Only our sections; the game adds its own ([Core.System] etc.) on first run and keeps ours.
  local tmp="$INI.ogsos"
  [ -f "$INI" ] && awk '/^\[/{skip=($0 ~ /^\[(OutpostKeyValueStore|OutpostIdentity|OutpostAppPersistence|OutpostIAP|OutpostStorefront|OutpostLeaderboards|OutpostLogReceiver|OutpostStreams|OutpostStreamClient|OutpostMatchmakingClient)\]$/)} !skip' "$INI" > "$tmp" || : > "$tmp"
  cat >> "$tmp" <<EOF

[OutpostKeyValueStore]
EndpointClient="$BASE/kv/"
EndpointClientFallback="$BASE/kv/"
EndpointServer="$BASE/kv/"

[OutpostIdentity]
Endpoint="$BASE"

[OutpostAppPersistence]
Endpoint="$BASE"

[OutpostLeaderboards]
Endpoint="$BASE"

[OutpostLogReceiver]
Endpoint="$BASE"

[OutpostStreams]
EmbedEndpoint="$BASE"

[OutpostStreamClient]
StreamEndpoint=$BHOST
StreamPort=$BPORT
StreamSSL=False
StreamPath=/ws/stream

[OutpostMatchmakingClient]
MatchmakingSSL=False
MatchmakingPort=$BPORT
MatchmakingEndpoint=$BHOST
MatchmakingApi="$BASE/api"
EOF
  mv -f "$tmp" "$INI"
}

lobby_json() { curl -s -m 5 "$BASE/servers?local=1" | tr '{' '\n' | grep "\"id\":\"$SESSION_ID\""; }
# Seconds since the backend last saw this session's host poll (empty if unknown).
last_seen() { lobby_json | grep -o '"lastSeenSec":[0-9]*' | cut -d: -f2; }
# Lobby state: waiting | countdown | started | ended (empty if unknown).
lobby_state() { lobby_json | grep -o '"state":"[a-z]*"' | cut -d'"' -f4; }
# Back to an empty waiting lobby. The backend then waits for this host's next poll before seating anyone.
reset_lobby() {
  local r; r=$(curl -s -m 10 -X POST -H "Authorization: Token $SESSION_TOKEN" "$BASE/api/session/$SESSION_ID/reset")
  log "lobby reset: $r"
}

GAME_PID=
stop_game() {
  [ -n "$GAME_PID" ] && kill "$GAME_PID" 2>/dev/null
  wineserver -k 2>/dev/null; sleep 3; wineserver -k9 2>/dev/null
  GAME_PID=
}
trap 'log "stopping"; stop_game; kill "$XVFB_PID" 2>/dev/null; exit 0' TERM INT

[ -f "$WIN64/$EXE" ] || { log "no $WIN64/$EXE (game copy missing)"; sleep 60; exit 1; }
[ -f "$WIN64/version.dll" ] && [ -f "$WIN64/sos_host.ini" ] || { log "version.dll / sos_host.ini missing in Win64"; sleep 60; exit 1; }

Xvfb :99 -screen 0 1024x768x24 -nolisten tcp >/dev/null 2>&1 & XVFB_PID=$!
for d in "$WINEPREFIX" "$HOME/logs"; do
  mkdir -p "$d" 2>/dev/null; [ -w "$d" ] || { log "$d is not writable by uid $(id -u) (chown the host dir)"; sleep 60; exit 1; }
done
# The bind mount makes the prefix dir exist even when empty, so test for a real prefix.
[ -f "$WINEPREFIX/system.reg" ] || { log "creating Wine prefix"; wineboot -i >/dev/null 2>&1; wineserver -w; }

while :; do
  until resolve_backend; do sleep 10; done
  write_ini
  rm -f "$WIN64"/sos_game_*.log "$WIN64/sos_host.log"
  JWT=$(mint_jwt)
  # For the sos_host DLL's match-end event (POST $SOS_HOST_BACKEND/session/<id>/events).
  export SOS_HOST_BACKEND="$BASE/api" SOS_HOST_SESSION="$SESSION_ID" SOS_HOST_TOKEN="$SESSION_TOKEN"
  log "starting game (backend $OGSOS_BACKEND = $BHOST:$BPORT, session $SESSION_ID)"
  ( cd "$WIN64" && exec wine "$EXE" "LaCuna?game=SUR?listen?AuthToken=$JWT" "-SESSION_ID=$SESSION_ID" "-SESSION_TOKEN=$SESSION_TOKEN" \
      -nullrhi -nosound -unattended -log ${EXTRA_ARGS:-} ) >/dev/null 2>&1 &
  GAME_PID=$!; START=$(date +%s); LISTENING=0; REASON=exited

  while kill -0 "$GAME_PID" 2>/dev/null; do
    sleep 15
    UP=$(( $(date +%s) - START ))
    if [ $LISTENING = 0 ]; then
      if grep -q 'Listening with' "$WIN64/sos_host.log" 2>/dev/null; then
        LISTENING=1; log "listening after ${UP}s"
        # A fresh game has an empty map: a lobby left 'started' (crash) or 'ended' (match over) starts again.
        case "$(lobby_state)" in started|ended) reset_lobby ;; esac
      elif [ $UP -gt "$LISTEN_TIMEOUT" ]; then REASON="no 'Listening with' after ${UP}s"; break; fi
      continue
    fi
    # Match over (host event match-end, POST /end, or empty too long): recycle for a fresh map.
    if [ "$(lobby_state)" = ended ]; then REASON="match ended"; break; fi
    if [ $UP -gt 600 ]; then
      SEEN=$(last_seen)
      if [ -z "$SEEN" ] || [ "$SEEN" -gt "$POLL_STALE" ]; then
        # Unknown or stale: check once more after a minute, so a backend restart doesn't kill the game.
        sleep 60; SEEN=$(last_seen)
        if [ -n "$SEEN" ] && [ "$SEEN" -gt "$POLL_STALE" ]; then REASON="no backend poll for ${SEEN}s (hang)"; break; fi
      fi
    fi
    # Daily restart (fresh 24 h JWT), only while the lobby is empty and waiting; the JWT has slack until the
    # 24 h mark, after which an empty lobby is restarted at any hour.
    if [ $UP -gt 7200 ] && { [ "$(date -u +%-H)" = "$RESTART_HOUR" ] || [ $UP -gt 79200 ]; }; then
      J=$(lobby_json)
      if echo "$J" | grep -q '"state":"waiting"' && echo "$J" | grep -q '"players":0[,}]'; then REASON="daily restart"; break; fi
    fi
  done
  log "game stopped: $REASON"
  mkdir -p "$HOME/logs" && cp -f "$WIN64/sos_host.log" "$HOME/logs/sos_host.last.log" 2>/dev/null
  stop_game
  sleep 5
done
