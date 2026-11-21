#!/usr/bin/env bash
# Prepares pool slot <n> on the Docker host (run as root): a hard-linked copy of the game tree (no extra
# disk; the game never writes its content files), a private sos_host.ini, and the slot's prefix/logs dirs,
# all owned by uid 1000 (the container user). Re-run after updating /srv/ogsos/classic or the DLL.
#   make_pool_slot.sh <n> [source=/srv/ogsos/classic]
set -euo pipefail
n="${1:?slot number}"; src="${2:-/srv/ogsos/classic}"; slot="/srv/ogsos/pool/$n"
win="SOS/Binaries/Win64"
[ -f "$src/$win/SOS-Win64-Shipping.exe" ] || { echo "no game in $src"; exit 1; }
mkdir -p "$slot/prefix" "$slot/logs"
rm -rf "$slot/game.new"
cp -al "$src" "$slot/game.new"
# Per-slot files must be real copies, and per-run logs must not be shared inodes.
rm -f "$slot/game.new/$win"/sos_host.log "$slot/game.new/$win"/sos_game_*.log
for f in sos_host.ini version.dll; do
  [ -f "$src/$win/$f" ] && { rm -f "$slot/game.new/$win/$f"; cp "$src/$win/$f" "$slot/game.new/$win/$f"; }
done
rm -rf "$slot/game.old"; [ -d "$slot/game" ] && mv "$slot/game" "$slot/game.old"
mv "$slot/game.new" "$slot/game"; rm -rf "$slot/game.old"
chown -R 1000:1000 "$slot"
chmod 750 /srv/ogsos/pool "$slot"; chown root:1000 /srv/ogsos/pool
echo "slot $n ready: $slot"
