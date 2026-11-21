# Moderation and the admin panel

SOS: Classic runs without BattlEye (its service died with the developer), so moderation is the anti-cheat:
players report, admins look at the evidence, and admins kick, ban or watch a match live.

Code: `server/admin.js` (one module), `server/web/admin/` (the panel: plain HTML/CSS/JS, no build step), a
`kickHosted` and watcher list in `server/matchmaking.js`, and a few one-line hooks in `server/server.js` (all marked
`// moderation`). RE notes behind this: `moderation-re.md` in the shared session notes.
C = confirmed in the exe or Blueprints, I = inferred.

## 1. Setup

Add these to the backend `.env` (compose `environment:`):

| Key | Meaning |
|---|---|
| `OGSOS_ADMINS` | Steam ID64s of the admins, separated by commas or spaces. Only these can sign in. Re-read on every request, but the container needs a restart to see a changed `.env`. |
| `OGSOS_ADMIN_ORIGIN` | The public origin, e.g. `https://sos.joltora.com`. Used for the Steam OpenID `realm` and `return_to`. **Set it in production**; without it the origin is built from the `Host` and `X-Forwarded-Proto` headers. |
| `OGSOS_ADMIN_DEV_LOGIN` | `1` enables `GET /admin/dev-login?steamid=<admin id>` for loopback requests without `X-Forwarded-For`. Tests only. **Never in production.** The backend warns at startup when it is on. |
| `OGSOS_ADMIN_GAME_WATCH` | `1` enables the client mod's `POST /api/servers/<id>/watch` (game JWT of an admin). **Leave off until game logins verify the Steam ticket** (section 7): today anyone can claim an admin's Steam id at game login. |
| `OGSOS_STEAM_OPENID` | OpenID endpoint override (tests). Default `https://steamcommunity.com/openid/login`. |

Nothing else to configure: no passwords are stored. The cookie key is derived from the backend's existing
`secret.key` (state dir), so rotating that file signs everyone out (and also invalidates game logins).

Reverse proxy (Caddy) for `sos.joltora.com`, when the lead sets up the HTTPS block:

```
sos.joltora.com {
    reverse_proxy 167.114.157.172:7781
}
```

Caddy sets `X-Forwarded-Proto: https`, so the cookie gets `Secure`. The game itself keeps talking plain HTTP to
`:7781`; only the panel needs HTTPS. hero.tv serves `/`, `/watch`, `/embed/*` and `/api/stream/*` from the same
backend; the panel only owns `/admin` and `/admin/*`, so both fit behind the same host name.

## 2. Signing in

1. Open `https://sos.joltora.com/admin/` and press **Sign in through Steam**.
2. Steam's own page asks you to sign in. Steam then sends your browser back to `/admin/auth`.
3. The backend checks the assertion with Steam (`check_authentication`, `is_valid:true`), that `return_to`,
   `op_endpoint` and `claimed_id` are what it expects, and that your Steam id is in `OGSOS_ADMINS`.
4. You get a signed cookie `ogsos_admin` (HMAC-SHA256, `HttpOnly`, `SameSite=Strict`, path `/admin`, 12 h).
   Removing your id from `OGSOS_ADMINS` (and restarting) ends your access even with a live cookie.

Every admin API call needs the cookie; every state-changing call is a `POST` that also needs the header
`X-OGSOS-Admin: 1` (CSRF guard). The panel sends a strict CSP (`default-src 'self'`), `X-Frame-Options: DENY`
and no-store caching. `/admin` requests are not written to `http.jsonl`, so cookies never reach the logs.

An admin also gets the `dev` role at game login (Classic). That shows the Director button and the Director server
browser in the game (docs/CLASSIC.md, "roles").

## 3. Using the panel

| Page | What it does |
|---|---|
| **Servers** | Every hosted lobby (official, and community ones once that branch is merged), its state and map, the players seated in it, and admins watching it. Per player: **Kick**, **Ban**. Per server: **Spectate**. Refreshes every 10 s. |
| **Players** | Search by name or Steam id. A player's page has their stats (from `/api/stats`), match history, reports against them and by them, ban state and ban history, and the lobby they are in now. |
| **Reports** | Queue with tabs open / actioned / dismissed / all. A report shows the reason, the player's notes, the evidence link, a snapshot of both players' stats at report time, the session, and the match record (linked automatically at match-end, or by hand from the candidate list). Actions: mark actioned, dismiss, reopen (with a note), ban the target, kick the target, spectate the session. |
| **Bans** | Steam-id bans with a reason, the code shown to the player, and an expiry (1 h, 24 h, 7 d, 30 d, permanent, custom). Lift a ban. Below: host blocks for community servers (IPv4, CIDR or community session id). |
| **Audit** | Every admin action: sign-in (and refused sign-ins), report status changes, bans, lifts, kicks, host blocks, spectate. Also appended to `<logs>/admin.jsonl`. |

### What a ban does

- **Login:** `POST /api/access-token/steam` answers `403` with the body the game's login error handler parses (C):
  `{"error":"forbidden","metadata":{"cause":"app-banned","ban":{"created","exp","reason","duration","type"}}}`.
  The game shows its own **Banned** dialog; **Accept** posts `.../accept-ban` and quits the game (C).
  - `ban.reason` is the code you pick (cheating, harassment, spam, bad-username, toxicity, stream-sniping,
    ban-evasion, other). The game names the first seven; anything else reads "Other".
  - The game words only two lengths: 24 h reads "1 day", 7 d reads "7 days". Every other length (including 1 h or
    30 d) reads "permanently banned". The ban itself still expires when you set it to.
- **Matchmaking:** the player's matchmaking socket is closed, and a new one is refused (`403`), even with a
  30-day game token issued before the ban.
- **Live match:** the player loses their seat in every hosted lobby. The game host polls `GET /api/session/<id>`
  every 5 s and kicks every connection that is not in `player-map` ("Kicking player %s not registered in MMS
  session %s", C). Banned ids are also filtered out of that `player-map` on every poll.
- **Kick** (without a ban) is the same seat removal. The player can queue again; ban them if they should not.

### Reports from the game (native UI, C)

In a match: **Escape → Contestants → Report** on a player's row. The dialog has a reason (Hate Speech, Bad User
Name, Harassment, Cheating, Spam), a free-text box, and SEND. The game allows one report per target per session.
It posts `POST /api/account/<target>/app-meta/sostest/report` with the reporter's token and
`{"reason","game-session-id","notes","evidence-video-format"}`. `game-session-id` is the game's own match GUID, not
our session id; it is stored as `gameGuid`, and the backend finds our session from where the reporter or target is
seated.

Limits per reporter: 10 reports an hour, 3 per target an hour.

Other report routes:
- `POST /api/reports` (game JWT): `{target, reason, text, sessionId, matchId, evidenceUrl}`, for the client mod.
- `POST /api/reports/<id>/evidence` (the reporter's JWT): `{evidenceUrl}` to attach a clip link later.

### Evidence: no server-side video

The VPS has no GPU and the game hosts run headless, so there is no server-side recording and there will not be.
The game's own clip upload went to Lightstream, which is gone. Ask players to record with their own tools
(Steam's game recording or clips, OBS replay buffer, NVIDIA/AMD instant replay), upload the clip (YouTube unlisted,
Medal, Streamable…) and attach the link (`evidenceUrl`). Evidence links open with `rel="noopener noreferrer
nofollow"`; only http(s) links are kept.

What the backend does keep for each report: both players' stat totals at report time, the lobby and who was in it,
and the match record the host DLL posts at match-end (kills, deaths, damage, survival time, escape… per player).

## 4. Watching a match ("watch the proof")

**Spectate** on a server card (or on a report) asks for **Spectator** or **Director**:

1. The backend adds your Steam id to that lobby's watchers for 3 hours. A watcher is put into the host's
   `player-map` (so the host's 5 s poll does not kick you) but is **not seated**: you take no slot and no team, and
   you are not counted in the lobby's player numbers.
2. It returns a join URL with an `AuthToken` the host accepts (HS512, signed with the lobby's session token,
   `sub` = session id, role `user+session`, C):
   `<ip>:<port>?SpectatorOnly=1&AuthToken=<jwt>` (Director adds `&DirectorOnly=1`).
3. Join with it: in the game console, `open <join URL>` (if the console is reachable in your build, I), or from the
   client mod's **Spectate** button (spec below). **Stop watching** removes you from the list.

What you get (C): a spectator joins with a spectator pawn (free camera, next/previous player). Director mode is the
game's caster view (player overview, status boxes, camera controls).

Limits:
- **Not proven invisible.** A spectator has no body in the world, but still has a PlayerState, so it may show in
  player lists or the contestant tab. The game's Blueprints filter `bIsSpectator` in places, not everywhere (I).
  Needs a live test with two clients.
- **Security hole in the game (C):** the host does not check who may spectate. Anyone who has a valid AuthToken for
  a lobby (every player seated in it) can rejoin with `SpectatorOnly=1` and see every player (ghosting, stream
  sniping). The backend cannot stop this alone; the host DLL fix below closes it.
- The session GET carries a top-level `"ogsos-watchers": [ids]` list (the game ignores unknown keys) for the DLL.

## 5. Host DLL work (spec for the hosting-DLL session, branch `claude/host-dll-aa88f1`)

Kick needs **no DLL change**: removing the seat is enough (the game's own MMS poll kicks). These are the
improvements that need the DLL:

1. **Spectator allow-list (closes the hole above).** Hook `AShooterGameMode::Login` (FUN_14016ad20) or its caller
   FUN_1410fb490. If the URL options contain `SpectatorOnly=1` or `DirectorOnly=1`, and the joiner's UniqueNetId is
   not in the last session GET's `ogsos-watchers` array, reject the login ("not allowed to spectate") or force a
   normal player join. The DLL already parses the session GET for `player-map`; read the extra key from the same
   body.
2. **Moderation counters in match-end.** Per player, count host log events and send them in the existing
   `match-end` POST as `players[i].moderation = { timeStampExpired, movementDiscrepancy, duplicateLogin }`:
   - `TimeStamp expired. %f, CurrentTimeStamp: %f` (server-move rejections),
   - `Movement Time Discrepancy detected ... on character %s` (only if `bMovementTimeDiscrepancyDetection` is on;
     it is off by default, so consider turning it on in `DefaultGame.ini`/`Game.ini` on our hosts),
   - `AShooterGameMode::Login: Warning: closing connection to controller with the same unique id`.
   The panel shows any extra numeric fields of a match player entry automatically.
   Note: Classic's host never corrects client positions (`SendClientAdjustment` is compiled out,
   host-dll-classic-moves.md), so there are no "position correction" counts to collect, and speed or teleport
   detection would have to be the DLL's own (position delta per tick vs. max walk/sprint speed).
3. **Report context (optional).** The report dialog also calls the `ServerReportPlayer` RPC on the host (C). The
   DLL could hook it and POST `{reporter, target, gameGuid, positions, health}` to
   `<backend>/session/<id>/events` as `{"type":"report-context", ...}` (Token auth); the backend would attach it to
   the open report for that pair. Not implemented on the backend yet.
4. **Kick reason text (optional).** If the DLL can call `GameSession->KickPlayer(PC, Reason)` itself, a
   `POST /session/<id>/kick` poll or field in the session GET could show "Kicked by an admin" instead of the
   generic MMS text. Not needed for kicks to work.

## 6. Client mod (spec only; branch `claude/client-mod-4cbb2a`, `sos_client` DLL)

The native report UI exists and works with the backend, so the mod does not need its own report flow. Useful
additions:

1. **Report with a clip link.** The native dialog has no link field. The mod adds a "Report with clip link" entry
   (for example in its own overlay, with target from the contestant list) that posts
   `POST /api/reports {target, reason, text, evidenceUrl}` with the player's game token. The reply carries the
   report id (`data.id`); `POST /api/reports/<id>/evidence {evidenceUrl}` adds or replaces the link later.
2. **Spectate from the server list (admins only).** The mod has no admin cookie, so it uses the game token:
   `POST /api/servers/<sessionId>/watch {mode: "spectator"|"director"}` (`{stop:true}` to stop; allowed only when the
   token's Steam id is in `OGSOS_ADMINS`, and only with `OGSOS_ADMIN_GAME_WATCH=1`, 404 otherwise) returns the same `{joinUrl, expiresAt}` as the panel. A non-admin gets 403, so the mod can
   hide the button after the first 403. Then travel with
   `open <joinUrl>` (`ExecuteConsoleCommand` or `ClientTravel`). Without the mod, an admin copies the URL from the
   panel.

## 7. Limits (read before relying on it)

- **Logins are not Steam-verified yet** (`server.js` TODO: ISteamUserAuth). Someone can claim another Steam id at
  game login, so a banned cheater can come back under a made-up id, and a report's reporter is only as real as
  their claimed id. The admin panel is not affected (it uses Steam OpenID). Verifying the login ticket closes this.
  Because of this, the client mod's watch route is off by default (`OGSOS_ADMIN_GAME_WATCH`), and the `dev` role an
  admin gets at game login can be claimed by a spoofer too. That role only unlocks client-side UI (Director screen);
  joining as a spectator still needs a watch link from the panel or a seat in the lobby.
- Bans are by Steam id only, no hardware or IP bans for players.
- Kick removes the seat; the game host does the disconnect on its next poll (up to ~5 s).
- Spectator invisibility and the in-game `open` command are untested (no second game client in these tests).
- Community hosts: blocks are stored and exposed (`isHostBlocked(ip)`, `onHostBlocksChanged`) but only take effect
  once `claude/community-hosts` is merged and wired (two lines: feed the active block values into
  `community._cfg.bans`). Community lobbies then show on the Servers page like official ones.
- Reports, bans and the audit log live in the backend's `db.json` (`db.moderation`), capped at 5000 reports and
  5000 audit entries.

## 8. Tests

- `node tools/moderation_test.js` (offline): report routes and limits, bans, kicks, host blocks, cookie tampering
  and expiry, CSRF, dev-login gates, static-file safety, OpenID against a fake Steam endpoint.
- `node tools/moderation_live_test.js http://127.0.0.1:<port>` against a running backend (dev-login on).
- `node tools/moderation_kick_test.js <port>` (end to end through a hosted Classic lobby): seat two players over
  `/ws`, report while seated, admin kick drops the player from the host's `player-map`, match-end links the
  report, ban closes the socket and refuses `/ws` and login, lift restores login. The file header shows the env.
