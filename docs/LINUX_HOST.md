# Classic host on Linux (the Linux VPS): plan

Status: plan only. Nothing is installed on prod. Every install or change on prod needs the user's OK, which goes through the lead session.

## What is already proven (render PC test, 21 Nov 2026)

The Windows render PC the Windows test PC ran the game headless with these flags: `LaCuna?game=SUR?listen -nullrhi -nosound -unattended -log`. It also had the sos_host `version.dll`.
- Steam init worked:
  - `Steam User is subscribed 1`
  - `[AppId: 802240] Client API initialized 1`
- LaCuna loaded in 15 s.
- `Listening with IpNetDriver on port 7777` came 23 s after start.
- Peak RAM was 2.5 GB.
- CPU was about 1.4 cores (23 % of an i5-9400F) with no players.
- Two attempts to cap the frame rate changed nothing; CPU stayed at 23 %:
  - `-ExecCmds="t.MaxFPS 30"` on the command line;
  - `bUseFixedFrameRate=True` / `FixedFrameRate=30` in Engine.ini. This setting fixes the frame delta; it doesn't throttle.
- A real cap probably has to come from sos_host, for example by setting the `t.MaxFPS` cvar or hooking the engine's max-tick-rate function. Until then, budget 1.5 cores per host.

So the game does not need a GPU or a window to host. What is left to prove on Linux:
1. Does Wine/Proton run it the same way?
2. Can the game reach a logged-in Steam client in a headless box?

## Layout on prod

```
/srv/ogsos/classic/          copy of "SOS Test Server" (9 GB; game files, never committed)
/srv/ogsos/steam/            the container's home: Steam client, login token, Wine/Proton prefix
deploy/classic-host/         Dockerfile + compose.yaml (to write)
```

There is one container, `ogsos-host`, beside the existing `ogsos-backend`. It has these limits:
- `cpus: 2`, `mem_limit: 4g`, `pids_limit: 512`;
- restart `unless-stopped`.

It publishes `0.0.0.0:7777/udp` and nothing else. VNC binds to the Tailscale IP only, and only while someone is logging in.

## Image

The base image is Ubuntu 24.04 with i386 multiarch enabled. Packages:
- `xvfb`, `x11vnc` and `xdotool`. xdotool is for diagnostics only, never for clicking.
- The native Linux `steam` package. Valve's Debian repo; the image downloads it at build time.
- Proton. Install it through Steam: a "Proton 9.0" tool download inside the client, after login. Plain Wine 9 from WineHQ is the fallback if Proton is a problem.
- `nodejs`, to run `tools/host_classic.js` (the launcher).

## Steam login (one time, no password handling by us)

1. Start the container with `Xvfb :99` and Steam running, and turn on `x11vnc -localhost no -listen <tailscale-ip>`.
2. The Steam login window shows a QR code, the same flow already used on the render PC. The user opens it over VNC, or we send a screenshot to the lead. The user scans it with the Steam app on their phone and approves.
3. Steam keeps a refresh token in `/srv/ogsos/steam`, so later starts log in by themselves. Then turn VNC off again.

The host account must own Classic. 802240 is delisted, so the account cannot be bought or added now. Only an account that already owns it will do.

**The account must not be one the user plays on.** Steam lets an account run one game at a time. If the host is up and the user launches Classic on the same account, Steam offers to close the other session and kick the host.
- the user's main Steam account owns Classic, but it is the user's main account. It is fine for tests. For a 24/7 server, a second owning account is needed.

## Launching the game

Run the game through Proton without the Steam runtime container (pressure-vessel needs user namespaces, which Docker blocks by default):

```
STEAM_COMPAT_CLIENT_INSTALL_PATH=~/.steam/steam STEAM_COMPAT_DATA_PATH=/srv/ogsos/steam/pfx \
SteamAppId=802240 SteamGameId=802240 WINEDLLOVERRIDES="version=n,b" \
  ~/.steam/steam/steamapps/common/Proton\ 9.0/proton run SOS-Win64-Shipping.exe \
  LaCuna?game=SUR?listen -nullrhi -nosound -unattended -log <session args>
```

Proton's `lsteamclient` passes the game's Steam calls on to the Linux Steam client running in the same container. That is the supported path.

**Fallback: the Windows Steam client under the same Wine prefix.** It is fragile: steamwebhelper/CEF under Wine is the usual breaking point.

`tools/host_classic.js` needs one change: a `--runner <cmd>` option, so it starts `proton run <exe>` instead of the exe itself. Remote mode already does the rest:
- asks the backend for a session;
- mints the 24 h AuthToken JWT;
- passes `-AuthToken`, `-SessionId` and the session token;
- announces the host to `/servers`.

## Keeping it up

- **Restart:** Docker `restart: unless-stopped` handles the container.
- **Watchdog:** the launcher restarts the game if any of these happens:
  - the game exits;
  - `Listening with` is missing from `sos_host.log` 120 s after start;
  - the game log stops changing for 10 minutes (the known map-load hang).
- **Daily restart:** 04:00 server time. The AuthToken JWT expires after 24 h, so the restart gets a fresh one.
- **Updates:** none. Classic is delisted, so the game files won't change.

## Networking

At the moment, `vps_relay.sh` on prod DNATs public UDP 7777 to the user's PC over Tailscale.
- Remove those rules before the container publishes 7777: `vps_relay.sh <ip> --remove`.
- The backend's `OGSOS_CLASSIC_HOSTS` entry becomes:
  - address `203.0.113.10:7777`;
  - `hostIds` = the host account's SteamID64.

## Resources

Measured on Windows: 2.5 GB RAM and about 1.4 cores idle, uncapped. Expected per host on prod:
- RAM: about 3 GB, including the Steam client.
- CPU: 1 to 2 cores.
- The 4 GB / 2 CPU container limit leaves headroom. Prod has about 20 GB RAM and 16 threads free.

## Test order (each step needs the lead's OK)

1. Copy the game files to `/srv/ogsos/classic`. rsync from the user's PC, about 9 GB.
2. Run `tools/linux_host/smoke_test.sh` under Wine with no Steam. The question is whether LaCuna loads and listens under Wine.
3. Build the image and log Steam in by QR over VNC.
4. Proton launch with Steam. Check `Client API initialized 1` and `Listening with`.
5. Join test from the user's PC through the backend. This needs a host account different from the joiner's.
6. Hand over to the backend: compose service, watchdog and daily restart.
