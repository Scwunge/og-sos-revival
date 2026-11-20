# Playtest guide: SOS: Classic with friends

How to host a SOS: Classic test on your own PC, and how friends join it. Windows only.

> **Status, 20 Nov 2026: this is a test of the setup, not a playable match yet.**
>
> Joining works: login, matchmaking, travel to the host, and the joiner gets a pawn.
> But joiners stay on the loading screen and cannot move. The shipping client lacks server-side movement correction. The fix lives in the host DLL and is in progress.
> The host has also hung or exited once during a joined match.
>
> Update this box when that changes.

## What everyone needs

- Windows.
- Steam, running and signed in.
- **SOS: Classic** installed from Steam. It is free (Steam app 802240, install folder `SOS Test Server`).
- Classic started **once** through Steam, so its config file exists. Then close it.

## Friends: join a host

1. Install **Node.js LTS** from [nodejs.org](https://nodejs.org). Accept the defaults.
2. Get the OG SOS Revival folder. The host sends you the folder or a link.
3. Make sure Steam is running.
4. Open PowerShell in that folder and run the command the host gave you. It looks like this:

```powershell
node launcher/launcher.js --classic --server 203.0.113.5:7781
```

Replace `203.0.113.5` with the address the host sent you.

5. SOS: Classic opens. Press **PLAY** (solo).
6. The match starts when enough players have joined. The host decides how many. You see a countdown, or the host starts it by hand.

What the launcher does: it backs up your `Engine.ini` (`%LOCALAPPDATA%\SOS\Saved\Config\WindowsClient\Engine.ini`), points it at the host, and starts Classic directly, without BattlEye. It does not touch the game files.

### Undo it

```powershell
node launcher/launcher.js --restore
```

The config file is shared with the main SOS game. Until you run `--restore`, the main game points at the host too.

## Host: run the test

You need Node.js, Steam, SOS: Classic (started once) and the `sos_host` DLL built.

**Build the DLL.** The code is in `mod/sos_host`, on the `host-dll` branch. Build it with:

```powershell
mod\sos_host\build.ps1
```

Until that branch is merged here, pass `--sos-host-dir <path to mod\sos_host>` to the host script (below).

**Find your public address.** It must be an IPv4 address like `203.0.113.5`. The game does no DNS lookups, so a name will not work.

- On the internet: search "what is my IP" and use the IPv4 shown.
- With Tailscale or ZeroTier: use the IPv4 of that virtual network (see [No port forwarding](#no-port-forwarding)).

**Start hosting.** One command:

```powershell
node tools/host_classic.js --public-host 203.0.113.5 --min-players 2 --countdown 10
```

| Option | Meaning | Default |
|---|---|---|
| `--public-host <IPv4>` | The address friends are told to connect to. | none (set it) |
| `--port <n>` | Backend TCP port. | 7781 |
| `--game-port <n>` | Game UDP port. | 7777 |
| `--min-players <N>` | Players needed before the countdown starts. | 1 |
| `--countdown <S>` | Seconds from reaching the minimum to match start (0 = at once). | 10 |
| `--steam-id <id64>` | Your SteamID64. Normally read from Steam. | auto |
| `--sos-host-dir <dir>` | Folder with the built DLL (`mod\sos_host`). | `mod\sos_host` in this repo |
| `--game "<folder>"` | Classic install folder. Normally found from Steam. | auto |
| `--no-game-log` | Do not keep the game log. | off |
| `--dry-run` | Show the plan. Starts and writes nothing. | off |
| `--cleanup` | Remove leftovers after a crash (see below). | off |

What it does, in order:

1. Starts the backend (`server/server.js`) on TCP 7781.
2. Points Classic's `Engine.ini` at it.
3. Installs the DLL (`version.dll`) and `sos_host.ini` next to the game.
4. Launches the host game window. **You play in that window.**
5. Prints the command your friends must run.

When you press Ctrl+C or close the game, it removes everything it installed and restores `Engine.ini`.

**Force a start.** Type `start` and press Enter in the same console.

**Something left behind** (power cut, crash)? Close the game, then:

```powershell
node tools/host_classic.js --cleanup
```

**Preview first** (changes nothing):

```powershell
node tools/host_classic.js --dry-run --public-host 203.0.113.5
```

## Ports the host must open

| Port | Protocol | Used for |
|---|---|---|
| 7781 | TCP | Backend: login, config, matchmaking WebSocket |
| 7777 | UDP | The game itself |

If you changed `--port` or `--game-port`, open those instead.

### 1. Router port forward

1. Find your PC's LAN address:

```powershell
ipconfig
```

Look for "IPv4 Address" on your active adapter, for example `192.168.1.50`. Giving this PC a fixed address in the router stops it changing later.

2. Open your router's admin page (often `192.168.1.1`) and find "Port forwarding".
3. Add two rules, both pointing at your PC's LAN address:
   - TCP 7781 to 7781
   - UDP 7777 to 7777

**Check for CGNAT.** Compare the "WAN" or "Internet" IP on your router's status page with the IP a "what is my IP" site shows. If they differ, your provider shares one address between many homes. Port forwarding will not work. Use a tunnel instead (next section).

### 2. Windows Defender Firewall

Run PowerShell **as administrator** and paste:

```powershell
New-NetFirewallRule -DisplayName "SOS Revival backend (TCP 7781)" -Direction Inbound -Protocol TCP -LocalPort 7781 -Action Allow
New-NetFirewallRule -DisplayName "SOS Revival game (UDP 7777)" -Direction Inbound -Protocol UDP -LocalPort 7777 -Action Allow
```

To remove them later:

```powershell
Remove-NetFirewallRule -DisplayName "SOS Revival backend (TCP 7781)"
Remove-NetFirewallRule -DisplayName "SOS Revival game (UDP 7777)"
```

## No port forwarding

| Option | Works? | Notes |
|---|---|---|
| **Tailscale** | Yes. Preferred. | Everyone installs it and joins the same network. The host passes its Tailscale IPv4 as `--public-host`. Friends use that IP in the launcher command. No router changes. Firewall rules may still be needed. |
| **ZeroTier** | Yes. Preferred. | Same idea: everyone joins the same ZeroTier network, and the host's ZeroTier IPv4 is the address. |
| **playit.gg** | Only in one case. | The game is told one host IP and one UDP port. A playit tunnel gives a different external port and a hostname. It works only if the external UDP port equals the game port (7777) and you use the resolved IPv4. We do not support a separate public game port yet, so prefer Tailscale or ZeroTier. |

Nothing here is installed by the scripts. Each person installs the tool themselves.

## Troubleshooting

| What you see | Likely cause | What to do |
|---|---|---|
| "Connectivity issues detected", or no PLAY button | Backend unreachable. | Check the address and `:7781` in the command. Host: check TCP 7781 is forwarded and allowed in the firewall, and that `host_classic.js` is still running. |
| Stuck at login | Steam not running, or Classic never started. | Start Steam and sign in. Start Classic once through Steam, close it, run the launcher again. |
| Session found, but you never get into the match | UDP 7777 is blocked. | Host: forward UDP 7777 and allow it in the firewall. |
| In the match but stuck on the loading screen | Known issue, see the status box. | Nothing to fix on your side yet. |
| Main SOS game no longer connects to the official or another server | The shared config still points at the host. | `node launcher/launcher.js --restore` |
| `Config not found` | Classic never made its config. | Start Classic once through Steam. |

## What the host shares with friends

- [ ] The OG SOS Revival folder (or the link to get it).
- [ ] Your public IPv4 address and the port, as `address:7781`.
- [ ] The exact launcher command: `node launcher/launcher.js --classic --server <address>:7781`
- [ ] The setup list: Windows, Steam signed in, SOS: Classic installed and started once, Node.js LTS.
- [ ] When the test starts, and how many players it waits for.
- [ ] How to undo it: `node launcher/launcher.js --restore`
- [ ] A warning that this is a setup test: joiners will sit on the loading screen for now.
