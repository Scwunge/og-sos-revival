# OG SOS Revival

Community servers for the original **SOS** (Outpost Games, 2018). The official servers are gone; this replaces them.

Unofficial, not affiliated with Outpost Games. **No game files are shipped here.** Players use the copy they already own on Steam. The launcher only edits the player's own config file.

## How it works
The SOS client reads every backend address from a plain config file,
`%LOCALAPPDATA%\SOS\Saved\Config\WindowsClient\Engine.ini`, and talks to it over plain HTTP with JSON. So:

| Piece | What it does |
|---|---|
| `server/server.js` | Stands in for `api.`, `assets.`, `mms.`, `lbs.` and `log-receiver.outpostgames.com`: login, saved data, inventory (everything unlocked), the store (everything free), live config, leaderboards and the matchmaking WebSocket. |
| `launcher/launcher.js` | Points a player's SOS at a revival server, backs up their original settings, and starts the game. `--restore` undoes it. |

## Run it
Needs Node.js 18 or later. There are no dependencies to install.

```powershell
node server/server.js --port 7780
```
```powershell
node launcher/launcher.js --server 127.0.0.1:7780
```
```powershell
node launcher/launcher.js --restore
```
Steam must be running. The launcher starts `SOS-Win64-Shipping.exe` directly, without BattlEye.

## Status
**Stage 1: discovery.** The server answers every call with a best guess and logs it:
- `logs/http.jsonl`: every HTTP request and our reply. `handled: false` means a route we don't know yet. Those also show as `??` in the console.
- `logs/ws.jsonl`: every matchmaking WebSocket message.

**Progress, 19 Nov 2026:** Steam login works (`LoadingOutpostLoginEnd Success:true`). After login the client calls `reconcile` (inventory), `season/.../unseen-reward`, saved data, `store/items/view` and `app-meta/.../language`, and opens the matchmaking WebSocket. It then sends nothing and waits for a "ready" message from the server, whose format is still unknown.

What we've learned:
- Login is `POST /api/access-token/steam` with `{"steam-app-id","steam-id","session-auth-token","roles","app-id"}`. The reply has to carry a JWT-shaped token, which the client sends back as `Authorization: Token <jwt>`.
- `GET /api/account` has to return the account fields at the top level of the JSON. A reply with them only under `data` makes login fail.
- The live config is `<EndpointClient>live-rev.txt` (a revision number), then `runtime-<rev>.json`.

Endpoint paths come from the client binary. Response *shapes* are guesses (`{"version", "data"}` comes from the client's own error messages) until the logs confirm them.

## Roadmap
1. **Get to the main menu.** Launch against a local server, read the logs, fix each response until login and the menu load cleanly.
2. **Unlock everything.** Learn the inventory format, list every cosmetic id, and serve the full list as `data/inventory_all.json`.
3. **Check that matches can be hosted.** The official dedicated server was never given to players. Test whether the client can host (`?listen`), or find another way. *Everything below depends on this.*
4. **Matchmaking.** Work out the WebSocket protocol (`player-join`, `session-started`, `connection`, `group-event`, ...) and send players to a hosted match.
5. **Verify Steam tickets** at login so player ids can't be faked. Then host on a VPS.
6. **Server browser UI** in the launcher. A menu inside the game comes later, if at all.
