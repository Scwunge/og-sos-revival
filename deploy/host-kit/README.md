# SOS: Classic community host kit

## What this is

Run your own SOS: Classic server and have it show up in the in-game server list. The kit registers your server with the lobby
backend, starts the game as a listen host with a small host DLL, keeps the registration alive and restarts the game when a match
ends or it hangs. It works on Windows 10/11 (PowerShell script) or on a Linux box with Docker (compose file).

## Requirements

- You must own SOS: Classic on Steam (app 802240) and have it installed. The kit contains no game files; every host uses their
  own copy.
- Windows 10/11, or a Linux machine with Docker and Docker Compose.
- A public IPv4 address you can forward a UDP port on (see Network).

No BattlEye: the kit starts `SOS-Win64-Shipping.exe` directly, not the BattlEye launcher (`SOS_BE.exe`), and never installs,
changes or removes anything of BattlEye. There is no anti-cheat on revival servers; abusive servers are removed by the admins.

## Resources per server

Measured on our live hosts during matches: about 2 to 4 GB RAM and 1 to 2 CPU cores. Idle it is about 1 GB and little CPU.
Plan for 4 GB and 2 cores per server.

## Network

- Forward UDP `<Port>` (default 7777) on your router to the machine running the server. The backend checks that the port is
  reachable before it lists your server.
- Windows Firewall: allow `SOS-Win64-Shipping.exe` when asked, or run once in an admin PowerShell:

      New-NetFirewallRule -DisplayName "SOS Classic server" -Direction Inbound -Protocol UDP -LocalPort 7777 -Action Allow

## Windows quick start

1. Unzip the kit anywhere (not into the game folder).
2. Edit `windows\server.cfg`: at least `Name=`. Leave `GameFolder=` empty unless the script cannot find your game.
3. Double-click `windows\Start Server.cmd` and leave the window open. Press Ctrl+C to stop.

Your normal game still works while the server runs: the host DLL is removed from the game folder and your `Engine.ini` is restored
when the server stops. If the PC crashed or lost power, run `Start Server.cmd -Cleanup` once to remove leftovers (the next start
also does this automatically). `Start Server.cmd -DryRun` checks your settings and shows what would happen without changing
anything.

`windows\state.json` is created on first start. It holds your server's secret token: do not share it. Keeping it lets a restart
take over the same registration at once.

## Linux quick start

In the `linux` folder:

    mkdir -p game prefix logs state
    cp -r "/path/to/SOS Test Server/." game/        # your own copy of the game
    cp server.env.example server.env                # then edit NAME, REGION, PUBLIC_PORT
    sudo chown -R 1000:1000 game prefix logs state  # the container runs as uid 1000
    docker compose up -d --build
    docker compose logs -f

`PUBLIC_PORT` is the UDP port you forward on your router; compose publishes the container's port 7777 on it. The game files stay
in `./game` on your disk and are never part of the image. `state/session.env` holds your server's secret token: do not share it.

## Check it is listed

- Open `http://sos.joltora.com:7781/servers` in a browser and look for your server name with `"community": true`.
- Or open the SERVERS button in the client mod.
- Or open `http://sos.joltora.com:7781/api/community/status/<id>` (the id is printed at start, first 8 characters; the full id is
  in `state.json` / `state/session.env`).

A new server first shows `probe` pending, then listed once the backend has reached your UDP port.

## How players join

Players open the SERVERS button in the client mod and pick your server.

## Rules and limits

- At most 3 servers per IP address.
- Names must not impersonate official servers or other people.
- A server is removed from the list about 10 minutes after it stops.
- Admins can ban servers or addresses.
- Progression: unverified community servers do not save player progression or leaderboards. Ask for a community key to become a
  verified server, then put it in `CommunityKey=` (Windows) or `COMMUNITY_KEY=` (Linux).

## Troubleshooting

- "SOS: Classic not found": install the game from Steam, or set `GameFolder=` in `server.cfg` to your "SOS Test Server" folder.
- Not listed, probe failed: the backend cannot reach your UDP port. Check the port forward, the Windows Firewall rule and that
  you are not behind carrier-grade NAT (your router's WAN address must be your public address).
- "already registered": a previous registration of your server is still alive. Wait about 10 minutes, or restore the old
  `state.json` / `state/session.env`.
- "address-not-public": the backend saw a private address; your connection is behind another NAT.
- The game restarts every few minutes: send us the last lines of `sos_host.log` (Windows: in the game's `SOS\Binaries\Win64`
  folder while running; Linux: `logs/sos_host.last.log`).
- Linux: "cannot write" errors mean a folder is not owned by uid 1000; re-run the `chown` above.

## Privacy

The backend sees your public IP address. It is shown to players in the server list because they connect to it directly. The
token in `state.json` / `state/session.env` is the secret for your server: do not post it or screenshots that show it.
If your Steam account is found on Windows, its id is only used as the host id sent to the lobby backend, and the script never
prints it.
