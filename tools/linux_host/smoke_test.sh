#!/usr/bin/env bash
# Linux feasibility smoke test for a headless SOS: Classic listen host under Wine + Xvfb.
# Question it answers: does the Classic client load LaCuna and start listening with -nullrhi -nosound
# under Wine, with the sos_host version.dll? Steam is NOT set up here, so Steam auth failing is expected.
#
#   bash smoke_test.sh <classic-root> <sos_host-dir> [seconds=240] [extra game args...]
#     <classic-root>   copy of the "SOS Test Server" folder (contains SOS/Binaries/Win64)
#     <sos_host-dir>   folder with version.dll and sos_host.ini (mod/sos_host build)
#
# Env: WINEPREFIX (default ~/ogsos-test/prefix), GAME_PORT (7777), RES ("1024x768x24", Xvfb screen).
# Writes results to ~/ogsos-test/runs/<timestamp>/: summary.txt, resources.csv, logs. Installs nothing.
set -uo pipefail

ROOT="${1:?usage: smoke_test.sh <classic-root> <sos_host-dir> [seconds] [args...]}"
HOSTDIR="${2:?usage: smoke_test.sh <classic-root> <sos_host-dir> [seconds] [args...]}"
SECS="${3:-240}"; shift 3 2>/dev/null || shift $#
EXTRA=("$@")
export WINEPREFIX="${WINEPREFIX:-$HOME/ogsos-test/prefix}" WINEARCH=win64 WINEDEBUG="${WINEDEBUG:--all}"
export WINEDLLOVERRIDES="version=n,b" SteamAppId=802240 SteamGameId=802240
WIN64="$ROOT/SOS/Binaries/Win64"
EXE="$WIN64/SOS-Win64-Shipping.exe"
RUN="$HOME/ogsos-test/runs/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN"

for c in wine xvfb-run; do command -v "$c" >/dev/null || { echo "missing $c" >&2; exit 2; }; done
[ -f "$EXE" ] || { echo "no $EXE" >&2; exit 2; }
[ -f "$HOSTDIR/version.dll" ] && [ -f "$HOSTDIR/sos_host.ini" ] || { echo "need version.dll + sos_host.ini in $HOSTDIR" >&2; exit 2; }

# The DLL and its ini go next to the exe (this is our own copy of the game, not a Steam install).
cp -f "$HOSTDIR/version.dll" "$HOSTDIR/sos_host.ini" "$WIN64/"
rm -f "$WIN64"/sos_game_*.log "$WIN64/sos_host.log"
[ -d "$WINEPREFIX" ] || { echo "creating Wine prefix $WINEPREFIX"; wineboot -i >/dev/null 2>&1; }

ARGS=("LaCuna?game=SUR?listen" -nullrhi -nosound -log -unattended "${EXTRA[@]}")
echo "wine $EXE ${ARGS[*]}" | tee "$RUN/command.txt"
echo "t_sec,rss_mb,cpu_pct" > "$RUN/resources.csv"

cd "$WIN64"
timeout --signal=INT --kill-after=20 "$SECS" \
  xvfb-run -a -s "-screen 0 ${RES:-1024x768x24}" wine "$EXE" "${ARGS[@]}" > "$RUN/wine.out" 2>&1 &
RUNNER=$!
T0=$(date +%s)
while kill -0 "$RUNNER" 2>/dev/null; do
  sleep 5
  P=$(pgrep -f 'SOS-Win64-Shipping.exe' | head -1)
  [ -n "$P" ] && ps -o rss=,pcpu= -p "$P" | awk -v t=$(( $(date +%s) - T0 )) '{printf "%d,%d,%s\n", t, $1/1024, $2}' >> "$RUN/resources.csv"
done
wait "$RUNNER"; CODE=$?
wineserver -k 2>/dev/null

cp -f "$WIN64"/sos_host.log "$WIN64"/sos_game_*.log "$RUN/" 2>/dev/null
find "$WINEPREFIX/drive_c/users" -path '*SOS/Saved/Logs/*.log' -newer "$RUN/command.txt" -exec cp -f {} "$RUN/" \; 2>/dev/null

{
  echo "exit code: $CODE (124 = still running at the time limit, which is what a healthy host does)"
  echo "peak RSS MB: $(tail -n +2 "$RUN/resources.csv" | cut -d, -f2 | sort -n | tail -1)"
  echo "avg CPU %:  $(tail -n +2 "$RUN/resources.csv" | awk -F, '{s+=$3;n++} END {if (n) printf "%.0f", s/n}')"
  echo "--- sos_host.log markers"
  grep -hE 'Listening with|InitListen|Listen\(|refusing|failed' "$RUN"/sos_host.log 2>/dev/null | tail -8
  echo "--- game log markers"
  grep -hiE 'LoadMap|Browse|nullrhi|NullDrv|RHI|SteamAPI|Steam|Fatal|Critical|Assertion|exception' "$RUN"/*.log 2>/dev/null | grep -v '^$' | tail -25
  echo "--- wine stderr (last 15)"
  tail -15 "$RUN/wine.out"
} > "$RUN/summary.txt"
cat "$RUN/summary.txt"
echo "results: $RUN"
