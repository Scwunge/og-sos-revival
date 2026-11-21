# HERO / hero.tv integration in SOS: Classic

Status: research notes from static analysis (exe strings, pak Blueprints, ini files, one SOS.log). Nothing here was observed on the wire. Items marked **(INFERENCE)** are best guesses.

Build: UE 4.12.5 shipping, ProjectVersion 5.57767.0, Steam app 802240, `HeroAppId="sostest"`.

## 0. Current status (2026-11-21), read this first

**Goal for whoever reads this:** rebuild hero.tv's functions under **`sos.joltora.com`**, hosted on the OVH server below. Sections 1 to 7 describe what hero.tv did and what the game expects. This section covers where everything lives today and how to deploy.

### Project
- OG SOS Revival: SOS: Classic (Steam app 802240, UE 4.12.5) with community servers. Repo github.com/Scwunge/og-sos-revival (MIT).
- A Node backend (`server/server.js` plus `server/matchmaking.js`, plain Node, no npm dependencies) replaces Outpost's dead services: login, KV config, matchmaking, `/servers`, and now `/embed` and `/ws/stream`.
- A `version.dll` proxy (`mod/sos_host`) turns a normal Classic client into a headless listen-server host.
- **The newest code is on branch `claude/sos-classic-re-d7672d`** (worktree `E:\OG-SOS-Revival\.claude\worktrees\sos-classic-re-d7672d` on the user's PC). It is not merged to main or pushed yet. Build on that branch, not on main.
- **The hero.tv work lives on branch `hero-tv`** (worktree `E:\OG-SOS-Revival\.claude\worktrees\hero-tv`), made from `claude/sos-classic-re-d7672d` at 7a3d97c. The owner's server session edits the other worktree, so the two are merged later. Deploy hero.tv changes from the `hero-tv` folder.

### Hosting: the OVH server
- **Server:** OVH VPS. Public IP `<vps-ip>`. SSH `root` through the `<vps-ssh-alias>` host alias in the user's ssh config.
- **Shared box:** it also runs the user's Minecraft servers, a Pelican panel and other joltora sites. **Touch only `ogsos-*` containers and the `sos.joltora.com` block in Caddy.** Ask the user before changing anything else.
- **DNS:** `sos.joltora.com` is an A record to `<vps-ip>`, the same IP as `play.joltora.com`. It works now.
- **SOS files on the box:**
  - `/opt/ogsos/`: a plain copy, not a git checkout, of `server/`, `tools/`, `data/` and `deploy/`.
  - `/opt/ogsos/deploy/classic-backend/compose.yaml`: Docker compose project `ogsos`.
  - `.env` and `.env.test` next to it hold secrets. Never print or commit them.
- **Containers:**

| Container | What | Port |
|---|---|---|
| `ogsos-backend-1` | **Live backend** that players use | TCP `<vps-ip>:7781` |
| `ogsos-backend-test-1` | Test backend (profile `test`, own state) | TCP `:7782` |
| `ogsos-host-1` | Game host: Classic under Wine and Xvfb, headless (profile `host`) | UDP `:7778` for now, `:7777` after cut-over |

  Backend logs, including `ws.jsonl`, are in the Docker volume `ogsos_logs` at `/logs` inside the container. Read them with `docker exec ogsos-backend-1 tail -f /logs/ws.jsonl`. The test backend uses `ogsos_logs-test`.
- **Deploy a backend change:** copy the changed files from the branch into `/opt/ogsos/` (scp), then run `cd /opt/ogsos/deploy/classic-backend && docker compose up -d --build backend`.
  - Restarting `ogsos-backend-1` cuts off players mid-login and mid-match. **Ask the user first, and do it between matches.**
  - Test on `backend-test` (port 7782) first: `docker compose --profile test up -d backend-test`.
- **Web front (Caddy):** Caddy on the host already owns ports 80 and 443 for all the joltora sites. Its config is `/etc/caddy/Caddyfile`. There is **no `sos.joltora.com` block yet**, so `http://sos.joltora.com` only gets Caddy's HTTPS redirect.
  - To add one, back up first: `cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-sos-$(date +%Y%m%d)`.
  - Add a block like this:
    ```
    sos.joltora.com {
        reverse_proxy <vps-ip>:7781
    }
    ```
  - Run `caddy validate --config /etc/caddy/Caddyfile`, then `systemctl reload caddy`. Use reload, never restart, because restart drops the other sites.
  - Caddy proxies WebSockets on its own and gets the TLS certificate automatically. Edit nothing else in that file.
  - A separate spectator site (static files) can live in its own folder, for example `root * /var/www/sos` under the same block, with `/embed/*`, `/ws/*` and `/api/*` sent to the backend.

### What the game is pointed at (client ini)
The join file (`dist/Join OG SOS Classic.cmd` on the branch) and the launcher write these into the player's `Engine.ini` today:
```
[OutpostStreams]
EmbedEndpoint=http://<vps-ip>:7781
[OutpostStreamClient]
StreamEndpoint=<vps-ip>
StreamPort=7781
StreamSSL=False
StreamPath=/ws/stream
```
Once Caddy serves `sos.joltora.com`, switch both the join file and the launcher to:
```
EmbedEndpoint=https://sos.joltora.com
StreamEndpoint=sos.joltora.com
StreamPort=443
StreamSSL=True
StreamPath=/ws/stream
```
Test that the game's CEF (an old Chromium) and its WebSocket client accept the Let's Encrypt certificate before telling players to switch. If they don't, keep the plain-HTTP `:7781` values for the game and use HTTPS only for the spectator website. The game host reads the same `[OutpostStreamClient]` keys, set in `deploy/classic-host`.

### Already done
- **Embed pages:** the live backend serves a blank page on `GET /embed/*`. The branch replaces this with real pages; see "Built on the branch" below. This stops the hero.tv parked-domain (GoDaddy) popup inside the match. The real performer and feedback panels go here; see the URL formats in section 2.
- **Stream WebSocket stub** (commit 721adfb, what live runs today; the branch replaces it with `server/stream.js`):
  - `/ws/stream` sends `{"type":"ready"}`;
  - answers `ping` with `pong`;
  - answers everything else with `{"type":"ack","data":{}}`, echoing a nonce if one is present;
  - logs every frame to `/logs/ws.jsonl` with `stream:true`.
  
  **Read those logs to learn the real message shapes before building Level 1 and Level 2.**
- **Flare voting off:** `UE_CLIENT_VOTING_ENABLED=false` in the Classic live KV config, revision 2 (commit 4ef0aaa, staged). The helicopter's normal drop happens with no audience. Turn it back on once real voting works.
- **Matchmaking and lobbies** (separate from hero.tv, do not break):
  - `/api/session/...` and `/servers`;
  - lobby lifecycle commit 0199415;
  - a multi-lobby pool is in progress in another session.

### Built on the branch (Level 1, embeds, most of Level 2), 2026-11-21
Not on the live backend yet. Shapes are still the section 5 INFERENCE: no real game stream traffic has been captured yet (local logs only hold node test clients). Everything is tolerant and logs what it does not know, so a single match against a backend running this code should show the real shapes.
- **`server/stream.js`** (new, plain Node) is the Stream service behind `/ws/stream`; `server/server.js` wires it in.
  - `ready` on connect; `ping` -> `pong`.
  - `session` creates a session (generated UUID) or updates one by `session-id`, and replies with a `session` packet: `{session-id, players:[{id}], views}`.
  - `session-view` creates or updates a view and replies with a `session-view` packet: `{session-id, view-id, players}`.
  - `session-end`, `session-delete-view`, `sub` and `unsub` reply `ack`.
  - An unknown session (or a `sub` on an unknown view) gets `nak {error:"session-not-found"}`, so the client can recover.
  - The nonce is echoed where the request put it: top level and/or inside `data`.
  - Fields are read as kebab-case, camelCase, snake_case or PascalCase. Players may be strings or `{id}` objects.
  - Unknown types get `ack` and a `stream-unknown` log line.
  - Env `OGSOS_STREAM_CREATE_REPLY=typed|ack|ack+typed` (default `typed`) switches how `session`, `session-view` and `create-vote` are answered, without a code change.
  - Env `OGSOS_STREAM_ADOPT_UNKNOWN=1` adopts unknown session ids instead of nak-ing them.
  - Sessions survive their owner's socket for 120 s, views for 30 s, so a reconnect can re-attach.
- **Viewers topic:** `{"type":"message","data":{"topic":"viewers","view-id"|"session-id"|"target":..,"message":{"count":N}}}`, pushed when the count changes.
  - Count = distinct watchers of the view's players. A watcher is either an in-game view on a live session that targets the player, or a web feedback page aimed at the player.
  - The performer's own view is excluded only when its owner is known (`viewer-id` field, or an account from an `Authorization: Token` header). Check this against real traffic.
- **Flare voting:**
  - `create-vote` replies `vote` (`vote-id`, options, title, ttl) and also sends `vote` to every socket with a view in the session and to web spectators.
  - `cast-vote` (`vote-id`, `option-id`, optional `voter-id`) replies `ack`. Errors are naks: `vote-not-found`, `vote-closed`, `invalid-option`, and `already-voted` for single-immutable votes.
  - `vote-status` (`vote-id, session-id, ttl, final, winner, total, tally`) is sent every 5 s and on every change. A final status goes out at the end. `winner` = the option with the most votes (a tie goes to the earliest option), or null with 0 votes.
  - **`UE_CLIENT_VOTING_ENABLED` is still false.** Turn it on only after a real flare vote works on test.
- **Feedback batches (Level 2):**
  - Web pages send `{"type":"feedback","data":{"target":<account>,"counts":{"applause":2}}}`, capped at 5 per second per socket and sentiment.
  - Once a second, every subscriber whose view/session/target includes that player gets `message` topic `feedback-batch`: `{player-id, feedback:[{sentiment,count}], counts, total}`.
- **Fame (Level 2):**
  - At session end, fame per player = weighted feedback (anger 0.5, the rest 1).
  - It is summed into `db.heroStats[account]` = `{anger, applause, laughter, love, shock, fame, matches}`.
  - The game host computes its own Fame rating (`FeedbackMatchRankingAlgorithm`). After a match it POSTs `[{"member":"<account>","score":N}]` to `/api/leaderboard/sostest/<board>`. Boards seen: `fame_solo`, `survival_solo`, `toxicity`, `trending_solo_<yyyy_mm_dd>`. It also POSTs the whole player blob to `/api/account/<id>/app/sostest`.
  - The real blob (from a match) has `stats.hero.total{Anger,Applause,Laughter,Love,Shock}FeedbackReceived`, `stats.social.totalFameWins` and `ratings.soloRatings.fame = {leaderboardId:"fame_solo", matchesPlayed, rating}`.
  - **`server/fame.js`** (new) stores leaderboard POSTs in `db.leaderboards` (latest score per member). `GET ...?start=&limit=` returns `[{member, score, rank, display-name}]`, sorted. The read row format is **INFERENCE** (mirrors the write shape).
  - Score POSTs need a configured host's `SESSION_TOKEN` (`HOSTS` / `OGSOS_CLASSIC_HOSTS`). Player JWTs are refused, since every player has one. A refused post gets 401 and a `leaderboard-rejected` line in `http.jsonl`. `OGSOS_LEADERBOARD_OPEN=1` accepts all posts, for a test backend whose host isn't in `HOSTS`.
  - Blob: on GET and POST of `/api/account/<id>/app/<app>`, `stats.hero.total*FeedbackReceived` is raised to at least `db.heroStats` (max, not sum, so feedback the game also counted isn't doubled). Ratings are never touched; they belong to the game.
  - The site's Fame table shows the game's `fame_solo` board when hosts have posted it, else the web-audience fame (`/api/stream/fame` returns both as `game` and `fame`).
  - Test: `node tools/fame_test.js` (no network).
- **Pages** (`server/web/`, ES5, no frameworks):
  - `/embed/{account|none}/<id>/performer`: viewer count and incoming feedback. Honors `skip-brand` and `hide-view-count`.
  - `/embed/.../feedback?viewer=1`: five same-origin iframes `meter-0..4` (`/embed/_/meter?n=N`), each with `#button`, plus the globals `mouseDownEvent`/`mouseUpEvent`. Meter mapping: 0 laughter, 1 anger, 2 applause, 3 shock, 4 love. Only 2/0/3 follow section 4.2; 1 and 4 are guesses.
  - `&site=1` adds the performer's name and the audience vote buttons (only on the website; in game the native vote UI is used).
  - `/embed/.../connect/twitch`: a "not available yet" page.
  - Any other `/embed/*` is still blank.
- **Spectator website** at `/` (and `/watch`): live matches and players with viewer counts. Clicking a player opens their feedback panel. Includes a Fame table.
- **JSON** for the site: `GET /api/stream/sessions`, `GET /api/stream/fame`.
- **Logs:**
  - Every stream frame both ways is in `ws.jsonl` with `stream:true`.
  - Web pages' own `feedback`/`message` frames are not logged frame by frame; batches are logged as `stream-feedback`.
  - Other events: `stream-nak`, `stream-unknown`, `stream-vote-create`, `stream-vote-final`, `stream-session-end`.
  - Read them with `docker exec <container> grep '"stream":true' /logs/ws.jsonl | tail -n 200`.
- **Test:** `node tools/stream_test.js http://<host>:<port> [host SESSION_TOKEN]` (Node 22, no deps). It runs 43 checks (45 with a token) across session, views, viewers, feedback, naks, the vote, the pages, session end, the blob merge and leaderboards. The token-only part posts to a throwaway board `test_<tag>`.
- **Deploy to test without touching what live would build:**
  - The live `backend` service builds from `/opt/ogsos` itself, so copy `server/` from the `hero-tv` worktree into `/opt/ogsos/stage-hero/`.
  - Build only the `ogsos-backend:test` image from there.
  - Then run `docker compose --profile test up -d backend-test`.

### Not done (your job)
- Confirm the section 5 shapes against a real game client and host. Point a client's `[OutpostStreamClient]` at `:7782`, play a match, then read `stream:true` lines. Then:
  - fix the shapes in `server/stream.js`;
  - decide `OGSOS_STREAM_CREATE_REPLY`;
  - check own-view exclusion in viewer counts;
  - learn whether in-game spectators send feedback over the socket (open question 6).
- Set KV `UE_CLIENT_FEEDBACK_TYPE=excelsior` (shows the web panels in game) only after the pages are checked in the game's CEF. The same goes for `UE_CLIENT_VOTING_ENABLED=true` after a real vote.
- Confirm the leaderboard GET row format: once a host has posted, the frontend leaderboard should show rows. If it stays empty, check the client log for the deserialize error. Also set KV `UE_CLIENT_FAME_WEIGHTINGS` if the defaults need tuning.
- **Capturing real Stream traffic** (the step that unblocks everything else):
  1. Run a test host against backend-test. Its `[OutpostStreamClient]` must point at `:7782` and its session/token must be in backend-test's `.env.test` `OGSOS_CLASSIC_HOSTS`. Then the host's `StreamSession_Survival` connects to `/ws/stream`.
  2. On one player PC, set `[OutpostStreamClient] StreamEndpoint=<vps-ip>`, `StreamPort=7782`, `StreamSSL=False`, `StreamPath=/ws/stream`. Point login/matchmaking at `:7782` too, so the player lands in that host's match.
  3. Play to a death and spectate someone (that creates a spectator view), ideally until a helicopter flare.
  4. Read `docker exec ogsos-backend-test-1 grep '"stream":true' /logs/ws.jsonl`, plus the `stream-unknown` / `stream-nak` lines.
- Twitch connect (needs a Twitch app), the video live view, and patching the hardcoded hero.tv URLs.
- The two hard-coded hero.tv links (`LeaderboardHUD` → `https://www.hero.tv/sos`, `LoginUI` password reset) can't be changed through ini. They need a DLL patch or are left as they are; they only open when a user clicks them.
- `UE_CLIENT_DIRECTOR_USERS` (director or spectator camera mode) is still `[]`.

### Rules
- Never commit game files, `.env` files or secrets.
- Commit or push only when the user says so.
- The game host needs no Steam account. Don't add Steam logins or emulators.
- Restart live containers only with the user's OK, between matches.

## 1. Summary

HERO (hero.tv) was the viewer/audience layer for SOS. The game never streamed video to hero.tv itself. Its jobs were:

1. An embedded web page (CEF `WebBrowser` widget) showing the performer's own audience panel (viewer count, feedback emotes).
2. A spectator-side web page with five emotion meters the spectator can press (Anger, Applause, Laughter, Love, Shock).
3. A WebSocket "Stream" service (`stream.outpostgames.com/ws`) carrying sessions, views, viewer counts, feedback batches and audience votes (helicopter supply-drop voting).
4. Post-game promos and Twitch account linking; "Fame" rating derived from audience feedback.
5. Optional broadcasting to Twitch/Mixer/Facebook through the bundled Genvid `gsdk.dll` (Lightstream module). This is independent of hero.tv.

hero.tv is now a GoDaddy parked page. Any CEF load of `{EmbedEndpoint}/embed/...` or any `LaunchURL` to `https://www.hero.tv/...` shows it.

Top features: performer feedback panel, spectator feedback buttons, viewer counts, flare (helicopter) audience voting, Fame ranking, Twitch connect, clip recording / broadcasting.

Both endpoints are plain ini values, so they can be repointed through Engine.ini. No DLL hook is needed.

## 2. Endpoints & config

| Purpose | Ini section / key | Default (DefaultEngine.ini in pak) | Notes |
|---|---|---|---|
| HTTP embeds | `[OutpostStreams] EmbedEndpoint` | `{WebServicesEnvHttp}://{WebServicesEnvDash}www.hero.tv` | Base for all `/embed/...` pages. Launcher already sets it to our backend (commit 1c96880). |
| Stream WS host | `[OutpostStreamClient] StreamEndpoint` | `{WebServicesEnvDash}stream.outpostgames.com` | Required; missing key logs "Missing StreamEndpoint= in [%s] of DefaultEngine.ini". |
| Stream WS path | `StreamPath` | `/ws` | |
| Stream WS port | `StreamPort` | 443 (code default) | SOS.log: `stream.outpostgames.com/ws:443 SSL=1` |
| Stream WS TLS | `StreamSSL` | true (code default) | |
| Timing | `StreamPingInterval`, `StreamMaxMissedPingCount`, `StreamMaxConnectInterval`, `StreamIssueTimeout`, `StreamCancelTimeout` | code defaults | Read by exe. |
| Unconfirmed | `StreamApi="http://{env}stream.outpostgames.com/api"`, `StreamReconnectInterval=10` | in ini | Strings present; not confirmed as read. |
| Game feed WS | `[OnlineGameFeedNetwork] Host/Port=80/Secure=False/Path=/ws/stream` | stream.outpostgames.com | `[OnlineSubsystemOutpost] GameFeedType=None` so disabled. |
| Profile URL | `Env/prodEngine.ini` `ProfileUrl="…/www.hero.tv/"` | | Stale asset path, no consumer found. Dead config. |
| KV store | `[OutpostKeyValueStore]`, `runtime-*.json` | | Feature switches, see below. |

Hardcoded external URLs (not configurable via ini):
- `https://www.hero.tv/sos` in `LeaderboardHUD` (opened with `LaunchURL`, external browser, user-click only).
- `www.hero.tv/password`, `dev-www.hero.tv/password` in `LoginUI` password reset (Hero login UI; Classic uses Steam login).
- Twitch OAuth page: built from `GetTwitchAuthenticationUrl` as `%s/embed/account/%s/connect/twitch?token=%s` (so it is under EmbedEndpoint).

Embed URL formats (UTF-16 literals in exe, builders near 0x1419e34c0..0x1419e3660):

```
%s/embed/account/%s/performer?token=%s&skip-brand=%d%s     (%s tail = "&hide-view-count=1" when HideViewCount)
%s/embed/none/%s/performer?skip-brand=%d%s                 (no token)
%s/embed/account/%s/feedback?token=%s&viewer=1
%s/embed/none/%s/feedback?viewer=1
%s/embed/account/%s/connect/twitch?token=%s
```
"account" variant is used when the token string is non-empty. **(INFERENCE)** first `%s` after `/embed/account/` is the account id, token is the Outpost JWT.

KV keys (client, `data/kv-classic/runtime-1.json`): `UE_CLIENT_FEEDBACK_TYPE` (value `excelsior` enables web feedback), `UE_CLIENT_VOTING_ENABLED`, `UE_CLIENT_VOTING_FLARE_OPTION_DISABLEDLIST`, `UE_CLIENT_CLIPPING_ENABLED`, `UE_CLIENT_GSDK_PREFERRED_ENCODER`, `UE_CLIENT_DIRECTOR_USERS`, `UE_CLIENT_FAME_WEIGHTINGS`, `UE_CLIENT_FAME_REQUIRED_DELTA`, `UE_CLIENT_INTRO_REQUIRED_RAW_FAME`, `UE_CLIENT_FEEDBACK_RADIUS_{MIN,MAX,GROWTH_RATE,SHRINK_RATE,CROUCH_MULTIPLIER}`, `UE_CLIENT_WEB_API_KEY`. Our current runtime-1.json sets only `UE_CLIENT_DIRECTOR_USERS: []` of these.

Popup triggers (which one produced the observed popup is **not determined**):
1. In match: `PerformerWebFeedback` calls `GetHeroPerformerUrl` then `Browser->LoadURL`; on load error retries every 5 s. Likely hidden unless `UE_CLIENT_FEEDBACK_TYPE=="excelsior"`, but whether it loads while hidden is unconfirmed.
2. Post game: `HeroConnectWidget` Twitch connect modal (`ExternalAuthenticationWidget`, a WebBrowser).
3. User click: `LaunchURL` buttons (LeaderboardHUD, LoginUI) open the OS browser.

Current state on the player machine: Engine.ini still has the stale `EmbedEndpoint="http://www.hero.tv"` and `StreamEndpoint=stream.outpostgames.com`. The launcher in the repo has the newer EmbedEndpoint write but does not write `[OutpostStreamClient]`.

## 3. Features

| Feature | Side | Needs hero.tv to work? | Without it |
|---|---|---|---|
| Performer web feedback panel (`PerformerWebFeedback`) | client CEF | Yes (page + stream WS) | Hidden unless KV `excelsior`; otherwise native simple UI |
| Spectator feedback buttons (`SpectatorWebFeedback`, `SpectatorSimpleEventUI`) | client | Web variant yes; simple variant partly | Simple UI shows, but delivery to performer is via stream WS **(INFERENCE)** |
| Viewer count (`SubscribeToViewerCount`, `GetViewersText`) | client, via WS | Yes | Shows 0 / hidden |
| Stream session + views (`StreamSession_Survival`, `StreamView_Survival`) | host / client | Yes (WS) | Create calls fail silently, view timers retry |
| Flare (helicopter) audience voting (`FlareVotingManager`, `FlareVoteInstance`) | host + client | Yes (WS) | Off unless KV `UE_CLIENT_VOTING_ENABLED` |
| Fame rating from feedback (`FeedbackMatchRankingAlgorithm`, `FameLeaderboard`) | host | Feedback data from WS | Fame never changes |
| Feedback stats / achievements (`TotalAngerFeedbackReceived`..., `audience-feedback`) | server blob | Feedback data | Stay 0 |
| Twitch connect (`HeroConnectWidget`) | client CEF | Yes (embed page) | Modal shows parked page |
| Post-game HeroCTA promo | client | Text only; link opens hero.tv | Harmless |
| Hero login UI | client | Yes | Unused in Classic (Steam) |
| Director mode / spectator cameras | client | Gated by KV `UE_CLIENT_DIRECTOR_USERS`; no HERO call | Works locally |
| Clip recording (`ClipGenerator`, Lightstream) | client | No (local gsdk) | Works if KV enabled |
| Broadcast to Twitch/Mixer/Facebook (Lightstream, gsdk RTMP) | client | No (needs those services) | Mixer is dead |
| In-world CCTV cameras | map props | No | AI alert props, not stream feeds |

## 4. Per-feature details

### 4.1 Performer panel
`Blueprints/UI/InGame/HUD/Feedback/Performer/PerformerWebFeedback` (WebBrowser widget). On Construct: wait for PlayerState, `GetHeroPerformerUrl(PlayerState, SkipBrand, HideViewCount = !GameState_Survival.ViewCountEnabled)`, `Browser->LoadURL`. `OnLoadError`: delay 5 s, `Loaded=false`, retry. Visibility is in `InGameHUDWidget.Get_WebFeedback_Visibility` (Hidden when `UseWebFeedback` false). The page itself (hero.tv `/embed/.../performer`) presumably rendered viewer count and incoming emotes using its own backend. **(INFERENCE)** The page was a SPA with its own connection to the same Stream service.

### 4.2 Spectator panel
`SpectatorWebFeedback` loads `GetHeroSpectatorUrl(PlayerState)` (the `/feedback?viewer=1` page). `StartGivingFeedback(ESpectateEvent)` / `StopGivingFeedback` run JS in the page:
```js
var targetButton = document.getElementById('meter-<N>').contentDocument.getElementById('button');
targetButton.dispatchEvent(mouseDownEvent);   // or mouseUpEvent
```
Event bytes 2, 3, 5 map to meter ids '2', '0', '3'; 0, 1, 4 ignored. The page must define globals `mouseDownEvent` and `mouseUpEvent`. `ESpectateEvent`: None, Anger, Applause, Laughter, Love, Shock (Blueprint byte order unconfirmed). Fallback without KV: `SpectatorSimpleEventUI` (thumbs, applause icons), `SpectatorCount` eyeball. `SpectatorHUD` texts: "AUDIENCE FEEDBACK", "NOW SPECTATING", "Give feedback to great performers!".

### 4.3 Stream session / view
- Host: `GameMode/Components/StreamSession_Survival` (parent `OutpostStreamSessionComponent`: `CreateSession`, `DestroySession`, `CreateVote`). Also referenced by GameShow segments.
- Client: `PlayerController/Components/StreamView_Survival` (`OutpostStreamViewComponent`: `CreateView`, `RecoverView`, `UpdateView`, `SubscribeToFeedback`, `SubscribeToViewerCount`, delegates `OnFeedbackReceived`, `OnViewerCountUpdated`). Reacts to `OnServerSpectateTargetChanged`, `OnPlayerStateChanged`, `OnUniqueIdChanged`; timer driven update/recover.
- GameShow: `GameShowStreamView_Interface.SetPerformersInView(GameShowPerformer_Struct[])`, `SetAllInStreamViewNode`.
- Error `session-not-found` triggers "Attempting to recover from destroyed session".

### 4.4 Feedback, radius and Fame
`UFeedbackStateComponent` (`FeedbackRadius`, per-sentiment given/total, `GetTopSentiment`). Radius tuned by KV `..._FEEDBACK_RADIUS_*`. `PlayerFeedbackReceivedEvent {Sentiment, FeedbackCount, PropagationDistance}`. Fame: `FeedbackMatchRankingAlgorithm` weights (`AngerWeight`, `ApplauseWeight`, `JoyWeight`, `LaughterWeight`, `SurpriseWeight`) from `UE_CLIENT_FAME_WEIGHTINGS`. Post-match fields `Prev/NewSolo/DuoFameRating` in the player blob; `OutpostPlayerBlobHeroStats` stores `Total{Anger,Applause,Laughter,Love,Shock}FeedbackReceived`, `TotalFameWins`. Achievements `audience-feedback` / `audience_feedback`.

### 4.5 Flare voting
Host `FlareVotingManager` on `OnHelicopterFlared`: `StreamSession->CreateVote(OutpostVoteConfig{Type=SingleMutable, TallyType=Total, Duration=VoteTimeLimit}, actors=[flare owner], options=GenerateVoteOptions(), title "Helicopter Supply", description "What should the helicopter drop?")`. `FlareVoteInstance` (`AOutpostStreamVoteInstance`): `BeginVote`, `EndVote`, `MulticastEndVote`, `ServerCastVote`; at end, if `TotalVotes>0`, `TriggerSupplyDrop(Conv_StringToInt(FinalWinningOptionId))`. Client UI `FlareVotingButton` (Vote0/1/2) calls `CastVote` through StreamView. Option ids are integer strings that index the supply-drop actors `SupplyDrop_Vote_*`. Without a Stream backend no vote is created, so the helicopter likely drops the default **(INFERENCE)**.

### 4.6 Twitch connect
`HeroConnectWidget` ("Connect with Twitch"): `GetTwitchAuthenticationUrl`, `GetTwitchIntegration`, `ExternalAuthenticationWidget`, then `SetClientAchievement`. Embedded in `LeaderboardHUD`. Page `/embed/account/<id>/connect/twitch?token=<jwt>`.

### 4.7 Lightstream / gsdk (independent of hero.tv)
Modules Lightstream, LightstreamTwitch/Mixer/Facebook components, GameLiveStreaming. Genvid `gsdk.dll`. RTMP targets `rtmp://live.twitch.tv/app`, `rtmp://ingest-sjc.mixer.com:1935/beam`, Facebook `https://graph.facebook.com/v2.10/%s/live_videos`. Console: `GameLiveStreaming.StartBroadcasting/StopBroadcasting`, `Lightstream.StartRecording/StopRecording/ClipToFile`. OAuth config keys: `twitch-api-client-id`, `twitch-api-client-secret`, `twitch-api-redirect-api`, `mixer-client-id`, `mixer-api-redirect-uri`, `facebook-app-id`, `facebook-api-app-secret`, `facebook-api-redirect-uri`. `ClipGenerator` is gated by KV `UE_CLIENT_CLIPPING_ENABLED`.

### 4.8 Audio and assets
Sound classes `UI_PlayerFeedback`, `WebStream` (+ attenuation, concurrency; ini keys `WebStreamSoundClass`, `WebStreamAttenuation`, `WebStreamSoundConcurrencyName` route CEF audio), mix `Mix_Spectator_Default`, helicopter VO `S_VOHeliPilot_0079_EN_audience_prompt_01..04` and `_cue`. Textures `t_hero_logo`, `HeroTV_Logo_Tex`, `icon_hero`, `t_twitch_icon`, `icon_fame`. Movie `L10N/*/Movies/Hero_Opening`. Post-game `HeroCTA` texts (viewer counts by placement).

## 5. Message formats

Stream WS client is a libwebsocket client of the same family as matchmaking; envelope is JSON `{"type": ..., "data": {...}}` with a `nonce` **(INFERENCE: placement of nonce)**. See `docs/MATCHMAKING.md` for the template (FIFO ops, `ready`, `ping`/`pong`, `nak {error}`, timeouts, re-issue).

Request types (from serializer literals): `ping`, `session` (create/update), `session-end`, `session-view`, `session-delete-view`, `sub`, `unsub`, `create-vote`, `cast-vote`.
Incoming types: `ack`, `nak {error, nonce}`, `pong`, `session`, `session-view`, `message`, `vote`, `vote-status`.

Field names seen: `nonce`, `session-id`, `view-id`, `topic`, `topics`, `players`, `views`, `config`, `actors`, `options`, `title`, `description`, `vote-id`, `voter-id`, `option-id`, `ttl`, `final`, `winner`, `total`, `tally`, `tally-type`, `data`, `ack`, `error`, `rel`, `option`.

Enums: `EStreamTopic` = feedback-batch, viewers, other. `EStreamError` = no-response, service-unavailable, unauthorized, concurrent-client-connection, other (plus `session-not-found` string). `EVoteType` = single-mutable, single-immutable. `EVoteTallyType` = blind, full, total. `EVoteActorRelation` = origin, nearby. `OutpostVoteOption {Id, Label, Description, Image}`, `OutpostVoteActor {id, Relation}`.

Shapes below are **(INFERENCE)**. As of 2026-11-21 no real game stream frame has been captured, so `server/stream.js` implements these shapes and logs everything with `stream:true`. Replace this block with the real frames once a match has run against it:
```json
{"type":"session","nonce":"1","data":{"players":[{"id":"<uid>"}]}}            -> {"type":"ack","nonce":"1","data":{"session-id":"S1"}}
{"type":"session-view","nonce":"2","data":{"session-id":"S1","view-id":"V1","players":[...]}} -> ack
{"type":"sub","nonce":"3","data":{"view-id":"V1","topics":["viewers","feedback-batch"]}} -> ack
{"type":"message","data":{"view-id":"V1","topic":"viewers","message":{"count":0}}}   (server push)
{"type":"create-vote","data":{"session-id":"S1","config":{...},"actors":[...],"options":[...],"title":"..","description":".."}} -> ack {"vote-id":".."}
{"type":"vote-status","data":{"vote-id":"..","session-id":"..","ttl":15,"final":false,"winner":null,"total":0,"tally":{}}}
{"type":"nak","nonce":"..","data":{"error":"session-not-found"}}
```
Auth: no header or token format was recovered. `unauthorized` and `concurrent-client-connection` errors exist, so a token or per-account connection limit is checked server side **(INFERENCE)**. Subprotocol echo and `ready` handshake as in our matchmaking server.

## 6. Replacement plan

### Level 0: Stub (stop the popup), about 30 min
1. Engine.ini via launcher: `[OutpostStreams] EmbedEndpoint="http://127.0.0.1:<backend>"` (already done in 1c96880; the player's machine Engine.ini is stale until the launcher reruns).
2. Add `[OutpostStreamClient] StreamEndpoint=127.0.0.1`, `StreamPort=<port>`, `StreamSSL=False`, `StreamPath=/ws/stream` to the launcher WANT map.
3. Leave `UE_CLIENT_FEEDBACK_TYPE` unset in `data/kv-classic/runtime-1.json` so the web widget stays hidden; leave `UE_CLIENT_VOTING_ENABLED` unset.
4. Server: keep `serveEmbedBlank` for `/embed/*`. Accept `/ws/stream` upgrades, reply with `ready`/`pong`, and `ack` every request with an empty data object. This silences reconnect loops.
Residual: user-click `LaunchURL` buttons still open hero.tv in the OS browser (hardcoded; only a pak/DLL patch changes it).

### Level 1: Minimal, about 1 to 2 days
Real session and viewer-count plumbing without audience:
- Implement `session`, `session-view`, `session-end`, `session-delete-view`, `sub`/`unsub` with generated ids, keep a session table, return `session-not-found` for unknown ids so the client recovers.
- Push `message` topic `viewers` with count 0 (or count of in-game spectators).
- Support `create-vote`/`cast-vote`/`vote-status` with in-game players as voters if desired (needs the client to reach the server; spectators in-game call `CastVote` via the WS). Sets `UE_CLIENT_VOTING_ENABLED`.
- Serve a tiny `/embed/*/performer` page that shows nothing or a viewer counter, enabled with `UE_CLIENT_FEEDBACK_TYPE=excelsior` if the panel is wanted.
- Capture real client traffic with a logging WS (the repo server already logs unknown paths) to replace every INFERENCE shape above before building further.

### Level 2: Full, about 1 to 2 weeks
- Real viewer web app: `/embed/{account|none}/{id}/performer` (viewer count, emote stream) and `/embed/.../feedback?viewer=1` (five `meter-N` iframes, each with a `#button` element, plus `mouseDownEvent`/`mouseUpEvent` globals), backed by the Stream WS.
- Feedback batching (`feedback-batch` topic) to performers with sentiment counts, radius/propagation, writing `TotalXFeedbackReceived` into the player blob and Fame ratings via the existing KV/leaderboard code.
- Twitch connect page and token handling (needs a Twitch app; dead Mixer/old Facebook paths can stay unsupported).
- Fame leaderboard (`FameLeaderboard` Solo/Duo) and KV weights.
- Video: if a real live view is wanted, use Lightstream/gsdk RTMP to an ingest we run, and embed it in the viewer page.
- Patch hardcoded `https://www.hero.tv/sos` and password URLs (pak or DLL string patch).

## 7. Open questions
1. Which trigger produced the observed popup (in-match CEF, post-game, or a click)? Needs a repro with the log.
2. Does `PerformerWebFeedback` load its URL while hidden when KV `UE_CLIENT_FEEDBACK_TYPE` is absent?
3. Exact wire shapes, nonce form, auth header/token of the Stream WS. Capture needed.
4. Is `StreamApi` (HTTP `/api`) actually used by any code path?
5. Byte order of `ESpectateEvent` in the Blueprint (affects meter-id mapping).
6. Does the simple spectator UI send feedback over the Stream WS, or is it local only?
7. What does the helicopter drop when no vote is created (default option)?
8. Does `CustomMatchHeroParams` change anything? Seen but unexplained.
9. Is the in-world CCTV a HERO feed? Current evidence says no (AI alert props only).
10. **hero-tv hooks the server session must keep (8.3).** `server/server.js`, all marked `// hero-tv`: (a) player blob GET and PUT/POST pass the blob through `fame.applyToBlob(accountId, blob)` (fills `OutpostPlayerBlobHeroStats` Total* and Prev/New Solo/Duo Fame ratings; other fields untouched); (b) the `/api/leaderboard/<app>/<board>[/<member>]` dispatcher sends boards where `fame.isFameBoard(board)` to `fame.fameLeaderboard(kind, {offset, limit})` or `?surrounding=`; (c) `createStream({ onSessionEnd: (match) => fame.recordMatch(match) })`; (d) `createFame({ db, saveDb, displayName, kvDir })` must get the same `db` object (it keeps `db.heroStats`, `db.fameMatches`). If the server session moves blob storage or the dispatcher, these four calls are all hero-tv needs.

## 8. Fame, ratings and progression: who builds what (added 2026-11-21)

The user wants a true revival: the rating system and all progression working as in the original game. The work is split between two builders so the merge stays clean.

### 8.1 Your job (hero-tv branch): Fame, the audience rating
Fame only exists because of audience feedback, so it belongs to hero.tv. Finish all of it:
- **Weights (see 8.6: not from the KV).** The plan was to read `UE_CLIENT_FAME_WEIGHTINGS` (`AngerWeight`, `ApplauseWeight`, `JoyWeight`, `LaughterWeight`, `SurpriseWeight`, read by `FeedbackMatchRankingAlgorithm`) instead of hard-coding anger 0.5 / others 1. Put the values in `data/kv-classic/runtime-1.json`, and also set `UE_CLIENT_FAME_REQUIRED_DELTA` and `UE_CLIENT_INTRO_REQUIRED_RAW_FAME` (the intro needs a minimum raw fame).
- **Turn feedback on in the client.** `UE_CLIENT_FEEDBACK_TYPE` = `excelsior` enables the web feedback panel. Tune the `UE_CLIENT_FEEDBACK_RADIUS_*` keys if needed.
- **Player blob (hero stats).** After each match, write `TotalAngerFeedbackReceived`, `TotalApplauseFeedbackReceived`, `TotalLaughterFeedbackReceived`, `TotalLoveFeedbackReceived`, `TotalShockFeedbackReceived` and `TotalFameWins` (`OutpostPlayerBlobHeroStats`).
- **Fame rating in the blob.** Write `PrevSoloFameRating` / `NewSoloFameRating` and `PrevDuoFameRating` / `NewDuoFameRating`. Classic is solo, so the duo fields can stay at the previous value.
- **Fame leaderboards.** `FameLeaderboard` (Solo/Duo) reads `/api/leaderboard/sostest/fame_*`, which returns `[]` today. Return real ranked rows. Find the exact row shape in the exe or pak first (look near the leaderboard parser) before guessing.
- **Achievements:** `audience-feedback` / `audience_feedback` if the client reports or reads them.
- **Spectator site:** show the same Fame numbers the game shows (one source of truth).

### 8.2 Not your job: the server session builds the rest
The server session (branch `claude/sos-classic-re-d7672d`) will build the non-audience progression:
- XP and account level after each match;
- match stats and history (kills, escapes, wins, placements);
- the non-fame leaderboards;
- season level, rewards and coins (today `GET season/<id>` returns a static state and the rewards call hands out nothing).

### 8.3 How the two fit together (so the merge is clean)
- **The server session owns the shared plumbing:** the player blob storage, its read and write routes, and the `/api/leaderboard/*` route dispatcher in `server/server.js`.
- **You own `server/fame.js`.** Export small functions the shared code can call, for example:
  - `fameForMatch(sessionId)` → per-account `{feedback counts, fameDelta}`;
  - `fameLeaderboard(kind, {offset, limit})` → rows;
  - `heroStats(accountId)` → the Total* fields.
  
  Keep your changes to `server/server.js` to the minimum needed to call these, and mark them with `// hero-tv` comments. If you need a blob or leaderboard hook that doesn't exist yet, write down exactly what you need in section 7 (Open questions). The lead session will relay it.
- **The hook is live (backend branch, commit 35358ff, deployed to prod 2026-11-21).** `server/server.js` now has `let fameHooks = null`. To plug Fame in, set it to your `createFame(...)` instance. The backend then:
  - on every sostest blob GET and POST, calls `fameHooks.applyToBlob(accountId, blob)`, so your Total*FeedbackReceived, FameRating and TotalFameWins fields end up in the player blob;
  - for fame leaderboard GETs (`/api/leaderboard/sostest/fame_*`), calls `fameHooks.fameLeaderboard(kind, {start, limit})` and `fameHooks.fameAround(kind, accountId, n)` for `?surrounding=N`. Rows are `{member, rank, score, uname}` with rank starting at 1. If you return `[]`, the backend falls back to the scores the game host posted itself;
  - at match end, calls `fameHooks.fameForMatch(sessionId)` and stores the result with each match record (`/api/stats/matches`).
  
  Full details are in `docs/PROGRESSION.md` section 7 on branch `claude/sos-classic-re-d7672d`. **Pull that commit into hero-tv before wiring.** Your only server.js change should then be the one line that sets `fameHooks`, marked `// hero-tv`.
- **Shared accounts:** both use the same account ids (`db.accounts`, the Steam id is the account id) and the same `db` file, so Fame, XP and stats end up on one profile.

### 8.4 Hosting changed (cut-over done 2026-11-21 04:25 UTC)
- **Live on OVH now:**
  - prod backend `ogsos-backend-1` on 7781, built from committed code only;
  - three game hosts `host1`-`host3` on UDP 7777/7778/7779;
  - the render-PC host and relay are gone.
- **The 7782 test backend is torn down.** Don't recreate it under the `ogsos-backend:test` tag. **For your own testing use the image tag `ogsos-backend:hero` and port 7783** (7784 is the progression test backend, 7786/udp its host), in its own compose profile or project.
- **Never** rebuild or restart `ogsos-backend-1` or the hosts. Live players use them. Shipping your work to prod goes through a merge into the server branch and a deploy the user approves.

### 8.5 hero-tv status (2026-11-21 05:10)
- **(Superseded by 8.6.)** The keys below were first put in `runtime-2.json`; the capture showed `UE_CLIENT_FAME_WEIGHTINGS` is read as an array, so it was dropped and the rest moved out of the served KV.
- **Keys set (value types are INFERENCE):** the key names are only in pak Blueprints, not the exe, and scanning the 8.9 GB pak over the mount restarted the room, so it was stopped. Picked from the key names and the `FeedbackMatchRankingAlgorithm` field names:
  - `UE_CLIENT_FEEDBACK_TYPE`: string `"excelsior"`;
  - `UE_CLIENT_FAME_WEIGHTINGS`: JSON object `{AngerWeight 0.5, ApplauseWeight 1, JoyWeight 1, LaughterWeight 1, SurpriseWeight 1}`;
  - `UE_CLIENT_FAME_REQUIRED_DELTA`: number `1`; `UE_CLIENT_INTRO_REQUIRED_RAW_FAME`: number `1`.
  - Check: on a client pointed at 7783, look in the client log for KV parse warnings on these keys. If the weights are read as a string, change the value to the JSON text of the same object.
- **Before prod:** `FEEDBACK_TYPE=excelsior` shows the web panels in game (section 6 said wait for a CEF check). Verify on 7783 before this merges.
- **Test backend:** `deploy/classic-backend/compose.hero.yaml`, project `ogsos-hero`, image `ogsos-backend:hero`, port 7783 -> 7781, own volumes. It cannot touch the `ogsos` project.
- **Tests:** `tools/fame_test.js` and `tools/persona_test.js` pass locally. `tools/stream_test.js` needs a network the dev shell doesn't have (loopback TCP is blocked), so it runs against 7783.

### 8.6 Real-client capture, menus only (2026-11-21 12:33-12:36 UTC, :7783) and what changed
Read from the client `SOS.log` and the backend `http.jsonl` / `ws.jsonl` of that window.
- **`LogJson:Error: Json Value of type 'Object' used as a 'Array'` x4 at the KV load.** Only on :7783, never on the progression backend (:7784), whose KV lacked the 4 keys added for hero-tv. Only one of them is an object: `UE_CLIENT_FAME_WEIGHTINGS`. So the client reads that key as an **array** (its real element format is still unknown). The related `LogScriptCore: Attempted to get an item from array Keys out of bounds [-1/0]` x5 (12:34:38-41, Blueprint, in the menus) is probably the same empty weighting data, not proven.
  - **Fix:** `UE_CLIENT_FAME_WEIGHTINGS` is no longer served. `server/fame.js` takes its weights from env `OGSOS_FAME_WEIGHTS` (JSON) or the defaults (anger 0.5, the rest 1), never from the KV. `UE_CLIENT_FEEDBACK_TYPE` / `_FAME_REQUIRED_DELTA` / `_INTRO_REQUIRED_RAW_FAME` are also not in `data/kv-classic` any more (scalars; nothing in this capture shows a problem with them, but none is needed until the web panels are checked in the game's CEF). The :7783 test deploy (`tools/step1_all.ps1`) adds `UE_CLIENT_FEEDBACK_TYPE=excelsior` to the staged copy only.
- **`FOutpostLeaderboards::GetRankingsResponse: Response failed to deserialize as a valid json array` x5.** The 7 leaderboard GETs at login all returned `200` bare JSON arrays. The 5 that failed returned the empty `[]`; the one non-empty board (`fame_solo`, two test rows) parsed fine. So this client log line is how an **empty** board looks (the client seems to treat `[]` as not a valid array); the leaderboards route is shared and the response shape is right. Not a bug in hero-tv. Untested whether any other empty-board body (for example `[ ]`) is accepted; it only matters cosmetically.
- **Stream WS:** the real client never opened `/ws/stream` in the menus (only the config line `FOutpostStreamClient: <ip>/ws/stream:7783 SSL=0`). Every `"stream":true` line in `ws.jsonl` came from our node test clients (`127.0.0.1`). **No real Stream frame and no real `/embed/*` request has been captured yet; all shapes in section 5 are still INFERENCE.** Needs a match on a host that points at the test backend.
- **Matchmaking looked right:** `ready`, `leave-all-groups` -> `ack`, `get-regions`, `get-session` -> `nak not-found` (normal with no session), `find-session` -> `ack` + `summary` + `session` + `session-started`. The join host was `127.0.0.1:7777` because the test backend had no `OGSOS_CLASSIC_PUBLIC_HOST`; set it in `.env.hero` before anyone matchmakes on :7783.
- **Fame leaderboard in the menus:** the client asks for `fame_solo` and `fame_duo` at login (`start=0&limit=100`); the rows are the stored test accounts only, so an empty board is expected until real matches feed Fame.
- **Rebase 2026-11-21:** hero-tv now sits on `claude/sos-classic-re-d7672d` (KV rev 3). Fame plugs in through `fameHooks = fame` (docs/PROGRESSION.md section 7); `server/server.js` no longer has hero's own blob or leaderboard code, only the `/embed/*`, `/`, `/watch`, `/api/stream/*` routes and the `/ws/stream` handling.
