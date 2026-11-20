#!/usr/bin/env bash
# OG SOS Revival: turn a Linux VPS into a port relay for a SOS: Classic playtest.
#
# Friends connect to the VPS's public IP. The VPS forwards TCP 7781 (backend) and UDP 7777 (game)
# over Tailscale to the host PC, which runs tools/host_classic.js as usual. The host needs no
# router port forward, and CGNAT does not matter.
#
#   sudo bash vps_relay.sh <host-tailscale-ip>            add the forwarding rules
#   sudo bash vps_relay.sh <host-tailscale-ip> --remove   take them out again
#   sudo bash vps_relay.sh --status                       show the rules this script added
#
# Env (optional): BACKEND_PORT (7781; "none" = relay only the game port, for when the backend runs
# on the VPS itself, see deploy/classic-backend), GAME_PORT (7777), WAN_IF (default: the interface
# of the default route), TS_IF (tailscale0). Use the same env for --remove as for adding.
#
# Needs: root, iptables, Tailscale installed and logged in on the VPS and on the host PC, both in
# the same tailnet. The rules are not saved across a reboot: run the script again after one.
# Installs nothing. Every rule it adds carries the comment "ogsos-relay".
set -euo pipefail

BACKEND_PORT="${BACKEND_PORT:-7781}"
GAME_PORT="${GAME_PORT:-7777}"
TS_IF="${TS_IF:-tailscale0}"
TAG="ogsos-relay"

die() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (sudo)"
command -v iptables >/dev/null || die "iptables not found"

if [ "${1:-}" = "--status" ]; then
  { iptables -S; iptables -t nat -S; } | grep -- "$TAG" || echo "No ogsos-relay rules."
  exit 0
fi

HOST="${1:-}"
MODE="${2:-add}"
[ -n "$HOST" ] || die "usage: sudo bash vps_relay.sh <host-tailscale-ip> [--remove] | --status"
[[ "$HOST" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "'$HOST' is not an IPv4 address (use the host PC's Tailscale IPv4, 100.x.y.z)"
case "$MODE" in add|--remove) ;; *) die "unknown option '$MODE'" ;; esac

WAN_IF="${WAN_IF:-$(ip route show default | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}')}"
[ -n "$WAN_IF" ] || die "could not find the public interface; set WAN_IF"
ip link show "$TS_IF" >/dev/null 2>&1 || die "no $TS_IF interface: install Tailscale on the VPS and run 'tailscale up' first"

# rule <table> <chain> <spec...>: add (if missing) or delete (if present), so reruns are safe.
rule() {
  local table="$1" chain="$2"; shift 2
  local spec=("$@" -m comment --comment "$TAG")
  if [ "$MODE" = add ]; then
    iptables -t "$table" -C "$chain" "${spec[@]}" 2>/dev/null || iptables -t "$table" -I "$chain" 1 "${spec[@]}"
  else
    while iptables -t "$table" -C "$chain" "${spec[@]}" 2>/dev/null; do iptables -t "$table" -D "$chain" "${spec[@]}"; done
  fi
}

PORTS=("udp $GAME_PORT")
[ "$BACKEND_PORT" = none ] || PORTS=("tcp $BACKEND_PORT" "${PORTS[@]}")
for p in "${PORTS[@]}"; do
  set -- $p
  # Public port on the VPS -> same port on the host PC, over Tailscale.
  rule nat PREROUTING -i "$WAN_IF" -p "$1" --dport "$2" -j DNAT --to-destination "$HOST:$2"
  rule filter FORWARD -i "$WAN_IF" -o "$TS_IF" -d "$HOST" -p "$1" --dport "$2" -j ACCEPT
done
# Replies come back through the VPS: the host sees the VPS's Tailscale address as the sender.
rule nat POSTROUTING -o "$TS_IF" -d "$HOST" -j MASQUERADE
rule filter FORWARD -i "$TS_IF" -o "$WAN_IF" -s "$HOST" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

if [ "$MODE" = add ]; then
  sysctl -q -w net.ipv4.ip_forward=1
  PUB="$(ip -4 addr show "$WAN_IF" | awk '/inet /{sub(/\/.*/, "", $2); print $2; exit}')"
  cat <<EOF
Relay on: $WAN_IF ${PORTS[*]} -> $HOST (via $TS_IF).
Also allow TCP $BACKEND_PORT and UDP $GAME_PORT in the VPS provider's firewall / security group.
The VPS's address on $WAN_IF is ${PUB:-unknown}. If your provider uses 1:1 NAT that is a private
address: use the public IPv4 from the provider's dashboard instead.
On the host PC:   node tools/host_classic.js --public-host <VPS public IPv4> --min-players 2
Friends run:      node launcher/launcher.js --classic --server <VPS public IPv4>:$BACKEND_PORT
Undo:             sudo bash vps_relay.sh $HOST --remove
EOF
else
  echo "ogsos-relay rules for $HOST removed. (net.ipv4.ip_forward was left as it is.)"
fi
