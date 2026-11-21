# SOS: Classic community host kit v1

Host your own **SOS: Classic** server. It appears in the in-game server list (the SERVERS button of the client mod) automatically,
next to the official OG SOS servers.

Download `sos-classic-host-kit-v1.zip`, unzip it, and follow `README.md` inside. The zip has a Windows path (double-click
`Start Server.cmd`) and a Linux path (Docker compose).

## What it is

- A small host DLL (`version.dll`, the same build the official servers run, SHA256 `cb7ce9e9…f396`). It restores listen-server
  hosting in the Classic client.
- A Windows script that does the rest:
  - finds your Classic install;
  - installs the DLL;
  - registers the server with `sos.joltora.com:7781`;
  - runs the game headless and keeps it healthy (restart after each match, on a hang, and daily);
  - removes everything again when you stop it.
- A Linux Docker setup (Wine + Xvfb) that runs the same thing.

## Requirements

- You must **own SOS: Classic on Steam** (app 802240) and have it installed. The kit contains **no game files**; every host uses
  their own copy. On Linux, copy your own `SOS Test Server` folder onto the server.
- Windows 10/11, or a Linux machine with Docker and Docker Compose.
- A public IPv4 address where you can forward a UDP port.

## Network

- **Forward UDP 7777** (or the port you set) on your router to the machine running the server.
- The backend sends a reachability check to that port before it lists your server. If the port is not forwarded, your server
  registers but stays hidden.
- On Windows, allow `SOS-Win64-Shipping.exe` through the firewall, or add an inbound UDP 7777 rule.

## Resources per server

Measured on the official servers during matches: about 2-4 GB RAM and 1-2 CPU cores; idle about 1 GB. **Plan for 4 GB RAM and
2 cores per server.**

## Quick start: Windows

1. Unzip anywhere, open `windows\server.cfg`, set `Name` (3-48 characters) and `Region`.
2. Double-click `Start Server.cmd`. Leave the window open; Ctrl+C stops the server and cleans up.
3. Check `http://sos.joltora.com:7781/servers` for your name with `"community": true`.

## Quick start: Linux

1. Copy your own `SOS Test Server` folder to `linux/game`.
2. `cp server.env.example server.env` and set `NAME`, `REGION`, `PUBLIC_PORT`.
3. `docker compose up -d --build`, then `docker compose logs -f`.

## No BattlEye

The kit starts `SOS-Win64-Shipping.exe` directly, not the BattlEye launcher (`SOS_BE.exe`), and never installs, changes or
removes BattlEye. Revival servers have no anti-cheat.

## Rules

- At most 3 servers per public IP.
- Names must not imitate official servers.
- Servers disappear about 10 minutes after they stop.
- Admins can remove and ban servers.
- Community servers without a community key do not save player progression or leaderboards. Ask the admins for a key to
  become verified.
