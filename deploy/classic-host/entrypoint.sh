#!/usr/bin/env bash
# Runs the SOS: Classic listen host under Wine + Xvfb and keeps it healthy.
#   - mints the host AuthToken (HS512 JWT keyed with the session token, as server/matchmaking.js makeSessionJwt)
#     at every start, so the daily restart always has a fresh 24 h token
#   - writes the backend sections into the prefix's Engine.ini before every start
#   - watchdog: restarts the game if it exits, never logs "Listening with", or stops polling the backend
#   - daily restart at RESTART_HOUR (UTC) once the game has been up for at least 2 h
# Env (host.env): OGSOS_BACKEND=ip:port  SESSION_ID  SESSION_TOKEN  [HOST_ID=0]  [RESTART_HOUR=9]
#   [LISTEN_TIMEOUT=300]  [POLL_STALE=300]  [EXTRA_ARGS]
#   [LOBBY_STATUS=community]  read the lobby from GET /api/community/status/<id> (community-registered hosts)
#                             instead of /servers?local=1 (default)
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

lobby_json() {
  if [ "${LOBBY_STATUS:-}" = community ]; then
    # Flat object {"id":...}: after tr it is a single line that still contains "id":"<SESSION_ID>".
    curl -s -m 5 "$BASE/api/community/status/$SESSION_ID" | tr '{' '\n' | grep "\"id\":\"$SESSION_ID\""
  else
    curl -s -m 5 "$BASE/servers?local=1" | tr '{' '\n' | grep "\"id\":\"$SESSION_ID\""
  fi
}
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

# A restarted container (docker restart / compose restart) keeps /tmp, so the old display lock is still there,
# Xvfb refuses to start, and the game then dies about 10 s after the world comes up (crash loop). Clear it first.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1024x768x24 -nolisten tcp >/dev/null 2>&1 & XVFB_PID=$!
sleep 1
kill -0 "$XVFB_PID" 2>/dev/null || { log "Xvfb did not start"; sleep 60; exit 1; }
for d in "$WINEPREFIX" "$HOME/logs"; do
  mkdir -p "$d" 2>/dev/null; [ -w "$d" ] || { log "$d is not writable by uid $(id -u) (chown the host dir)"; sleep 60; exit 1; }
done
# The bind mount makes the prefix dir exist even when empty, so test for a real prefix.
[ -f "$WINEPREFIX/system.reg" ] || { log "creating Wine prefix"; wineboot -i >/dev/null 2>&1; wineserver -w; }

# Map rotation: GAME_MAPS="LaCuna,/Game/Maps/Test_Mike/Layouts/Circle01" plays each map in turn, one per game start;
# ROTATE_OFFSET picks where this host starts (so hosts sharing a list play different maps). Without GAME_MAPS, GAME_MAP
# (default LaCuna) is used every time.
ROT_I=${ROTATE_OFFSET:-0}
next_map() {
  if [ -n "${GAME_MAPS:-}" ]; then
    local -a maps; IFS=',' read -r -a maps <<< "$GAME_MAPS"
    GAME_MAP=${maps[$(( ROT_I % ${#maps[@]} ))]}; ROT_I=$(( ROT_I + 1 ))
  fi
}

while :; do
  until resolve_backend; do sleep 10; done
  next_map
  write_ini
  rm -f "$WIN64"/sos_game_*.log "$WIN64/sos_host.log"
  JWT=$(mint_jwt)
  # For the sos_host DLL's match-end event (POST $SOS_HOST_BACKEND/session/<id>/events).
  export SOS_HOST_BACKEND="$BASE/api" SOS_HOST_SESSION="$SESSION_ID" SOS_HOST_TOKEN="$SESSION_TOKEN"
  # Host frame cap (the DLL sleeps each frame once hosting; a listen host ticks and acks moves once per frame). 60 halves the
  # move-ack latency of the old 30 and costs about one extra core per host; SOS_HOST_MAX_FPS=30 goes back.
  export SOS_HOST_MAX_FPS="${SOS_HOST_MAX_FPS:-60}"
  log "starting game ${GAME_MAP:-LaCuna} (backend $OGSOS_BACKEND = $BHOST:$BPORT, session $SESSION_ID)"
  ( cd "$WIN64" && exec wine "$EXE" "${GAME_MAP:-LaCuna}?game=SUR?listen?AuthToken=$JWT" "-SESSION_ID=$SESSION_ID" "-SESSION_TOKEN=$SESSION_TOKEN" \
      -nullrhi -nosound -unattended -log ${EXTRA_ARGS:-} ) >/dev/null 2>&1 &
  GAME_PID=$!; START=$(date +%s); LISTENING=0; REASON=exited; ENDED_AT=; BAD_SINCE=; GAME_BHOST=$BHOST

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
    # The backend container got a new IP (it was recreated): the game still talks to the old one and the poll
    # check below can no longer see it. Recycle once the lobby is idle (empty and waiting, or ended).
    if resolve_backend >/dev/null 2>&1 && [ "$BHOST" != "$GAME_BHOST" ]; then
      J=$(lobby_json)
      if echo "$J" | grep -q '"state":"ended"' || { echo "$J" | grep -q '"state":"waiting"' && echo "$J" | grep -q '"players":0[,}]'; }; then
        REASON="backend address changed ($GAME_BHOST -> $BHOST)"; break
      fi
    fi
    # Match over (host event match-end, POST /end, or empty too long): recycle for a fresh map.
    # The post-game show (results, podium, Exit button) needs the host alive: wait until nobody is connected any more
    # (last "Players alive=A connected=C" line in sos_host.log), min 20 s, cap POSTGAME_MAX (default 300 s).
    if [ "$(lobby_state)" = ended ]; then
      [ -z "$ENDED_AT" ] && ENDED_AT=$(date +%s)
      G=$(( $(date +%s) - ENDED_AT ))
      LAST=$(grep 'Players alive=' "$WIN64/sos_host.log" 2>/dev/null | tail -1)
      if [ $G -ge "${POSTGAME_MAX:-300}" ] || { [ $G -ge 20 ] && echo "$LAST" | grep -q 'connected=0'; }; then REASON="match ended (${G}s after the end)"; break; fi
    fi
    # Backend not seeing this host: the lobby is gone from /servers, or its poll is unknown (null lastSeenSec after a backend
    # redeploy dropped the state) or stale. Once listening, recycle after BAD_GRACE seconds of that (default 120, so a backend
    # restart does not kill the game), unless players are connected (let them finish). An ended match drains above.
    if [ "$LISTENING" = 1 ] && [ "$(lobby_state)" != ended ]; then
      SEEN=$(last_seen)
      if [ -z "$SEEN" ] || [ "$SEEN" -gt "$POLL_STALE" ]; then
        [ -z "$BAD_SINCE" ] && BAD_SINCE=$(date +%s)
        LAST=$(grep 'Players alive=' "$WIN64/sos_host.log" 2>/dev/null | tail -1)
        if [ $(( $(date +%s) - BAD_SINCE )) -ge "${BAD_GRACE:-120}" ] && ! echo "$LAST" | grep -qE 'connected=[1-9]'; then
          REASON="backend does not see this host (poll ${SEEN:-unknown}, lobby $([ -z "$(lobby_json)" ] && echo gone || echo listed)) for $(( $(date +%s) - BAD_SINCE ))s"; break
        fi
      else BAD_SINCE=; fi
    fi
    # Daily restart (fresh 24 h JWT), only while the lobby is empty and waiting; the JWT has slack until the
    # 24 h mark, after which an empty lobby is restarted at any hour.
    if [ $UP -gt 7200 ] && { [ "$(date -u +%-H)" = "$RESTART_HOUR" ] || [ $UP -gt 79200 ]; }; then
      J=$(lobby_json)
      if echo "$J" | grep -q '"state":"waiting"' && echo "$J" | grep -q '"players":0[,}]'; then REASON="daily restart"; break; fi
    fi
  done
  log "game stopped: $REASON"
  mkdir -p "$HOME/logs" && cp -f "$WIN64/sos_host.log" "$HOME/logs/sos_host.last.log" 2>/dev/null; cp -f "$WIN64"/sos_game_*.log "$HOME/logs/" 2>/dev/null
  stop_game
  # Crash loop guard: a game that dies within 90 s of starting backs off (up to 5 min). While it is down the backend
  # sees no polls and lists the lobby as offline, so players are not sent to a dead host.
  if [ $(( $(date +%s) - START )) -lt 90 ] && [ "$REASON" = exited ]; then
    FAILS=$(( ${FAILS:-0} + 1 )); BACKOFF=$(( 90 + FAILS * 30 )); [ $BACKOFF -gt 300 ] && BACKOFF=300
    [ $FAILS -ge 3 ] && { log "game died within 90s ${FAILS} times in a row, waiting ${BACKOFF}s (lobby shows offline)"; sleep "$BACKOFF"; }
  else FAILS=0; fi
  sleep 5
done
