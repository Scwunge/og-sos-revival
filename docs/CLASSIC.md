# SOS: Classic (Steam app 802240)

What our backend and launcher must do so **SOS: Classic** can log in, unlock everything, matchmake and host.
Everything here was read from the client: the exe, its pak configs and the cooked Blueprints. No game data is in the repo.
In this doc, "Main" means the main client (app 619080) that `server/` and `launcher/` already support.

## Verdict: Classic cannot host either (same as Main)

- **`UWorld::Listen` is compiled out in Classic too.** In `UEngine::LoadMap`, the only Listen call (`call 0x140B6EDF0; test al,al` at **0x141417674**, just before the "LoadMap: failed to Listen(%s)" log at 0x1414176CA) goes to a shared **`32 C0 C3`** stub (`xor al,al; ret`). That stub has dozens of callers, so it is a COMDAT-folded "return false".
  - This is what UE 4.12 gives `UWorld::Listen` when `WITH_SERVER_CODE=0`.
  - Like Main, Classic has no "Failed to listen: %s" string. Classic, Main and Main's stub at 0x140188B70 all match.
  - So `?listen` (command-line token, console `open`, `OpenLevel` options) always fails with "LoadMap: failed to Listen".
- **No dedicated path.** PreInit (FUN_140135d20) writes the client/server globals as constants, and `-server` is never parsed. "SOS Test Server" is **not** a server-code build; it is a client build like Main.
- **What is still compiled in:**
  - `UIpNetDriver::InitListen` ("%s IpNetDriver listening on port %i", xref RVA 0xE543F4);
  - `UNetDriver::InitListen` (RVA 0x11E5996);
  - the WebSocketNetDriver and LAN beacon listeners.

  So hosting would need a hand-written replacement for `UWorld::Listen` in a code cave. It would create the game net driver, call `InitListen`, and set it on the world. That is a substantial exe patch, not a byte flip.
- **Matchmaking subprotocol:** Classic has the same `wss,ws` literal as Main, so the same fix applies: the server must echo `Sec-WebSocket-Protocol: wss,ws` in full.

## Build

| | Classic | Main |
|---|---|---|
| Steam app id | **802240** ("SOS Test Server" folder) | 619080 |
| Exe | `SOS\Binaries\Win64\SOS-Win64-Shipping.exe` (46,144,752 bytes, built 2018-09-11) | same path |
| Engine | UE **4.12.5** shipping | 4.12.5 |
| Build tag | Jenkins `sosclassic-cook-prod`, branch `//blackbird/branches/sosclassic`, **ProjectVersion 5.57767.0** | different |
| Pak | `SOS\Content\Paks\SOS-WindowsClient.pak`, v3, 24,558 entries, mount `../../../` | same layout |
| Extras | `SOS_BE.exe` (BattlEye), bundled `gsdk` (Genvid), RedShell plugin | no RedShell |
| `HeroAppId` (the `app-id` the client sends) | **`sostest`** | `sos` |

## Config (`DefaultEngine.ini` / `DefaultGame.ini` in the pak)

| Item | Status |
|---|---|
| `[OnlineSubsystemOutpost.*]` Identity, AppPersistence, Leaderboards, KeyValueStore (EndpointClient/Fallback/Server), LogReceiver, MatchmakingClient (`MatchmakingPath=/ws`, SSL, port) | **Same as Main**: same sections and keys |
| `[OutpostIAP]`, `[OutpostStorefront]` | **Absent**. Classic has no store or inventory code (OutpostIAP.cpp, OutpostStorefront.cpp, AppInventoryManager, StoreManager and QuestManager are not compiled in). |
| `[OutpostSteam] SteamAppId` | **802240** |
| `[WebServicesConfig] HeroAppId` | **`"sostest"`** |
| `GameDefaultMap` | **`/Game/Maps/MainMenu2`** (Main: `/Game/Maps/Frontend`) |
| `ShooterGameInstance MainMenuMap` / `WelcomeScreenMap` | **`/Game/Maps/MainMenu2`** |
| `ServerDefaultMap=/Game/Maps/Sanctuary`, `GlobalDefaultGameMode=Gamemode_Survival_C`, `GameInstance_Survival`, `ConsoleClassName=OutpostConsole` | Same as Main |
| NetDriver (SteamNetDriver with IpNetDriver fallback) | Same as Main |
| Game mode aliases | `SUR` (Gamemode_Survival), `FFA`, `TDM`. Main's `MaxPlayers=32` line is absent. |
| Saved path | Project name is still `SOS`, so the config lives at **`%LOCALAPPDATA%\SOS\Saved\Config\WindowsClient\Engine.ini`. This is the same file Main uses.** The two clients share one Engine.ini (see the launcher notes below). |

Maps in the pak: `LaCuna` (with sublevels A1..E4 and Day/Night/Rain/Hupia variants), `MainMenu2`, `Sanctuary`, `Crater`, `Circle01`, `ShooterEntry`, and these whiteboxes: `CnC_Whitebox`, `Combat_Whitebox`, `GameMode_Whitebox`, `Test_GameMode_Whitebox`.
There is **no** `LaCuna_BR` and no `Frontend`.

## REST API

| Path | Status |
|---|---|
| `POST /api/access-token/steam` (and `/api/access-token`, `/%s`, `once-code`) | **Same as Main**: same body fields (`steam-app-id`, `steam-id`, `session-auth-token`, `roles`, `app-id`), the same JWT-shaped token and the same `Authorization: Token` header. Classic sends `app-id: "sostest"` and `steam-app-id: 802240`. |
| `/api/account/%s`, `/api/account/%s/app[/%s][/tos]`, app-meta accept-ban/language/report, identity | Same as Main. AppPersistence data is keyed by app `sostest`, so it is separate from Main's saves automatically. |
| `/api/leaderboard/...`, `/api/log`, `/api/search/account`, `/api/session/%s[/client/%s][/events]` | Same as Main |
| `/api/app/%s/inventory`, `/reconcile`, `/season`, `/season/%s/unseen-reward`, `/store/items/purchase`, `/store/items/view` | **Not used**: none of these strings are in the exe |
| Login error path | Same `no-app-entitlement` handling. LoginUI shows "You don't appear to have access to this app." |

## Login, version gate and test-server gate (Classic only)

These checks happen in Blueprints after login.

1. **Version gate.** `LoginUI.CheckVersion` reads KV `UE_CLIENT_MINIMUM_REQUIRED_BUILD`, splits it on `.` and compares it with ProjectVersion `5.57767.0`. Leave the key unset or set it to `5.57767.0` or lower.
2. **Test-server gate.** `HUDFunctionLibrary.IsTestServer` is `GetHeroAppID()=="sostest"`, which is always true for Classic. `FrontendHUD.UpdateTestServerAvailable` then does this:
   - If the player is in app role **`testserver`**, matchmaking is enabled.
   - Otherwise it calls `SetMatchmakingEnabled(KV UE_CLIENT_TEST_SERVER_ENABLED as bool, "SOS Test Server Closed")`.

   **So set `UE_CLIENT_TEST_SERVER_ENABLED=true`, give everyone the `testserver` role, or both.**
3. `UE_CLIENT_TEST_SERVER_MOTD` and `UE_CLIENT_MOTD` are shown on the frontend.

## App roles

`IsPlayerInAppRole(roles)` (FUN_140167440) reads the account attribute `AppRoles`, which the client fills from the login reply, the same as Main. It splits both `AppRoles` and the argument on **spaces**, and returns true if **any** requested role is present.

| Role string checked | Where | Effect |
|---|---|---|
| `testserver` | FrontendHUD.UpdateTestServerAvailable | Matchmaking is enabled even when the KV switch is off |
| `dev qa` | UtilityBar.GetDirectorVisibility | Shows the Director button in the utility bar |
| `BBL_player dev` | SurvivalPlayerController Director toggle | Lets the player toggle Director mode in-game |
| `UE_CLIENT_CUSTOM_MATCHES_ROLES` (string array) | Custom match UI | Who may create custom matches |
| `UE_CLIENT_DUOS_ROLES` (string array) | Duo queue | Who may queue duos |
| Gesture `AppRole` field | Gesture data | Role-gated gestures |

So `dev qa` means dev OR qa, and `BBL_player dev` means BBL_player OR dev. Giving everyone the roles `app-user user testserver` is enough for normal play. Add `dev` to the roles of anyone who should get the Director button and server browser.

`user` matters for one more check. Classic's LoginUI has a grant step that Main lacks (`OutpostAccountGrantApp`, FUN_141a201f0): after `OnNoEntitlement` it calls `AccountGrantApp` and logs in again. If the split `AppRoles` lacks `user`, this step sends a GrantApp request to the identity service. Our login never answers `no-app-entitlement`, so this path should not run. Still, include `user` in the roles so it is a no-op if it does.

## Key-value store (live config)

KV keys are fetched the same way as in Main (`<EndpointClient>/live-rev.txt` and then the revision file).
The keys themselves are different. Classic does **not** read Main's `UE_CLIENT_MM_TYPES_ENABLED` or the `*_ROLES` mode switches. It reads these instead:

| Key | Type / meaning | Suggested value |
|---|---|---|
| `UE_CLIENT_TEST_SERVER_ENABLED` | bool; if false (and the player lacks role `testserver`), matchmaking is disabled with "SOS Test Server Closed" | **`true`** |
| `UE_CLIENT_MINIMUM_REQUIRED_BUILD` | version string, compared with 5.57767.0 | `5.57767.0` or unset |
| `UE_CLIENT_CUSTOM_MATCHES_ENABLED` | bool | `true` |
| `UE_CLIENT_CUSTOM_MATCHES_ROLES` | string array | `["app-user"]`, or whatever role everyone has |
| `UE_CLIENT_CUSTOM_MATCHES_MAPS` | string array of map names for CustomMatchCreateUI (default `LaCuna`) | `["LaCuna"]` |
| `UE_CLIENT_DUOS_ENABLED`, `UE_CLIENT_DUOS_ROLES`, `UE_CLIENT_DUOS_QUEUE_WARNING_TIME_SEC` | bool, string array, number | `true`, `["app-user"]`, `60` |
| `UE_CLIENT_DIRECTOR_USERS` | string array of **nicknames**; FrontendHUD.CheckDirectorUsers calls `SetDirecting()` when `GetPlayerNickname` is in the list | the host's name |
| `UE_CLIENT_TEST_SERVER_MOTD`, `UE_CLIENT_MOTD`, `UE_CLIENT_INACTIVE_SERVER_TEXT` | text | |
| `UE_CLIENT_MM_LANGUAGES`, `UE_CLIENT_MM_LANGUAGES_DUOS_BLACKLIST`, `UE_CLIENT_MM_PLATFORM_LANGUAGE_MAPPING` | matchmaking language buckets | |
| `UE_CLIENT_TUTORIAL_URL_STANDARD/_CHINESE`, `UE_CLIENT_SHOW_TUTORIAL_BUTTON`, `UE_CLIENT_FEEDBACK_TYPE`, `UE_CLIENT_FRONTEND_LEADERBOARDS`, `UE_CLIENT_NEW_POST_GAME_SHOW`, `UE_CLIENT_SHOW_LOADING_NAMES`, `UE_CLIENT_GSDK_PREFERRED_ENCODER` | frontend options | |
| `UE_CLIENT_VOTING_ENABLED`, `UE_CLIENT_VOTING_FLARE_OPTION_DISABLEDLIST`, `UE_CLIENT_STORM_CHANCE`, `UE_CLIENT_NIGHT_CHANCE`, `UE_CLIENT_ALLOW_NIGHT_RAIN` | match options (server side) | |
| `UE_CLIENT_FAME_WEIGHTINGS`, `UE_CLIENT_FAME_REQUIRED_DELTA`, `UE_CLIENT_RATING_REQUIRED_MATCHES`, `UE_CLIENT_MAX_RANK_TO_DISPLAY`, `UE_CLIENT_INTRO_REQUIRED_RAW_FAME` | fame and ranking | |
| `UE_CLIENT_HEARTBEAT_LENGTH`, `UE_CLIENT_ENABLE_STUCK_TELEPORT`, `UE_CLIENT_EXTRACTION_DISABLEDLIST`, `UE_CLIENT_EXTRACTION_MAX_ATTRACTED_HUPIA`, `UE_CLIENT_DEBUG_LEVEL_INFO`, `UE_CLIENT_CLIPPING_ENABLED`, `UE_CLIENT_ACTOR_SPAWN_TUNING` | gameplay tuning | |

## Matchmaking WebSocket

The protocol is **the same as Main** (`docs/MATCHMAKING.md`). The settings strings are the same. `"GroupsFromMatchmaker"` is absent; `MatchmakingWaitForSession` and the "Leave all matchmaking groups" path are present.
What Classic sends differs:

| UI | Message | game-mode | map |
|---|---|---|---|
| Solo PLAY | `find-session` | `""` | `""` |
| Duo PLAY | `group-find-session`, after creating a group of type `duo` | `"duo"` | `""` |
| Custom match | `create-session`, then `start-session`; others `join-session`, host can kick | `"solo"` | from `UE_CLIENT_CUSTOM_MATCHES_MAPS`, default `"LaCuna"` |

So the server must treat empty game-mode and map as solo on `LaCuna`, not reject them. It must not send a BR map name: Classic has no `LaCuna_BR`.

## Cosmetics ("unlock everything")

Classic has **no inventory backend**, so there is nothing to serve.
Outfit and gesture availability is decided in C++ by `CustomizationLibrary::FilterByAvailability` (asset status plus `IsEntitlementAvailable` / `ValidateEntitlements`), using:

- **Steam DLC ownership** (`IsDLCInstalled`, checked by the client against Steam):
  - Founders Pack shirts: 784710, 784730, 784750, 784760, 784820.
  - Gestures: Bow 811670, BrushItOff 784780, Dance02 784800, HandToFace 784790, SlowClap 784770.
  - The name plate (PlayerNameWidget) checks DLC 812320 and 784810.
- **Entitlement string `alpha-beta`** on the alpha/beta shirts.
- **App roles** for role-gated gestures.

How the check works (Confirmed, Ghidra):

- The per-item check FUN_140166970 needs all three of these:
  - asset status byte (+0x3C1) is 3, or 1 under an extra condition;
  - `IsEntitlementAvailable(Entitlement)`;
  - `Entitlement` role empty or `IsPlayerInAppRole`.
- `IsEntitlementAvailable` (FUN_140166d90) returns **true when the string is empty or not numeric** (FUN_140386590 is `FString::IsNumeric`). Otherwise it calls `_wtoi64` and asks the Steam subsystem whether that DLC is installed.
- So the **`alpha-beta` shirts are already available to everyone** because the string is not numeric.
- Only the numeric Steam DLC ids are locked.
- `IsDLCInstalled` (FUN_140166cd0, used by PlayerNameWidget) works the same way, except that an empty or non-numeric string gives false.

The backend cannot change DLC ownership: it is answered by the local Steam client.
To unlock the DLC items for everyone, patch **a private copy** of the exe (never the install). Both functions take the string by reference, so returning early is safe:

| Function | VA | File offset | Original | Patch |
|---|---|---|---|---|
| `IsEntitlementAvailable` | 0x140166D90 | **0x166390** | `40 53 48 83 EC 40` | `B0 01 C3` (mov al,1; ret) |
| `IsDLCInstalled` | 0x140166CD0 | **0x1662D0** | `40 53 48 83 EC 40` | `B0 01 C3` |

These are cosmetic only. Do not patch them on a copy that joins other people's matches unless everyone agrees.

## Command line

The allow-list and the filter are **the same as Main**: only `-fullscreen -windowed -forcelogflush -AUTH_LOGIN -AUTH_PASSWORD -AUTH_TYPE -fullcrashdumpalways -fullcrashdump` survive "Filtering command line".
`SESSION_ID=`, `SESSION_TOKEN=`, `AuthToken` and `user+session` are present, as in Main.

Filter patch site (same code, same bytes as Main's 0x47464F):

- file offset **0x414D8F**, RVA 0x41578F, VA **0x14041578F**
- bytes `E8 0C 3A 00 00`, `call FUN_1404191a0` (the filter: lazy allow-list init, the "Filtering command line" log at CoreMisc.cpp:0x2AF, then it filters the 4 command-line buffers)
- **Confirmed** in Ghidra: the filter is called only from `FCommandLine::Set` (FUN_140415700, at 0x14041578F). The next instruction stores `1` to a flag, as in Main.
- Patch to `90 90 90 90 90` on a private copy. Do the same as for Main (HOSTING.md route 3).

Join options `SpectatorOnly=1` and `DirectorOnly=1` (and `bDirectorOnly`, `MaxSpectators`) exist in both exes.

## Dedicated server

**None. Same as Main.**

- `FEngineLoop::PreInit` (FUN_140135d20, the caller of `FCommandLine::Set`) writes the client/server globals as constants. On the non-commandlet path it sets `DAT_142a035b8=1` and `DAT_142a035b9=0`, with no `-server` branch. This is the same shape as Main's FUN_140138ca0.
- A listen server is not possible either: `UWorld::Listen` is a `return false` stub (see the verdict at the top).
  - The hidden FrontendHUD button `DebugLoadWhitebox` runs `CreateSession(32 players, LAN)` and then `OpenLevel('/Game/Maps/'+DebugLevel, '?listen?bIsLanMatch')`. This only shows that the Blueprint was written for a server build.
  - In this build that call would log "LoadMap: failed to Listen". (Its default level `Whiteboxes/Social_Whitebox` is also missing from the pak.)
- `ApproveLogin` (FUN_140150950, ShooterGameSession.cpp) is **the same as Main**. It checks the `AuthToken=` URL option only when the session has a session id, so joiners of a host started without `SESSION_ID` need no token.

## Hosting options, ranked

**None of the routes below can host as-is**, because `UWorld::Listen` returns false (see the verdict). They are kept for what they still do.

| # | Route | Status | Notes |
|---|---|---|---|
| 0 | **Code-cave replacement for `UWorld::Listen`** in a private exe copy | the only real route; large effort | Point the call at 0x141417674 to new code that creates the game net driver, calls `UIpNetDriver::InitListen` (still compiled in) and assigns it to the world. Untested; needs the CreateNamedNetDriver/InitListen addresses mapped first. |
| 1 | **Map token**: `SOS-Win64-Shipping.exe LaCuna?game=SUR?listen` | loads the map; **listen fails** | The first token survives the filter (same as Main), but LoadMap logs "failed to Listen". It is still the way to start a host once route 0 exists. Classic's map is **`LaCuna`**. |
| 2 | **Patched private exe** (NOP at file **0x414D8F**) | works, but does not host by itself | Brings back `-log -nullrhi -nosound -Port= -SESSION_ID= -SESSION_TOKEN=`. |
| 3 | **Director server browser** to join a host (Classic only) | joiners' side; untested | Shown to players whose nickname is in KV `UE_CLIENT_DIRECTOR_USERS` (frontend "Show Director Screen"). The in-game Director toggle needs role `BBL_player` or `dev`; the utility-bar Director button needs `dev` or `qa`. ServerListUI offers HOSTED (Internet), LOCAL (LAN), REFRESH, and **Join IP** (`FindSessionByIp(player, hostname)`, then `JoinSession`), with "Join As" Player/Spectator/Director. LAN search finds a host started with `?bIsLanMatch` on the same subnet. How Join IP resolves over the Steam net driver is **Inferred** (not tested). |
| 4 | **Custom match through MMS** | lobby UI only | KV `UE_CLIENT_CUSTOM_MATCHES_ENABLED=true` and `_ROLES` let players `create-session` (game-mode `solo`, map from `UE_CLIENT_CUSTOM_MATCHES_MAPS`). Our server must still send `session-started {host, port}` pointing at a host that can listen (route 0). |
| 5 | Console `open LaCuna?game=SUR?listen` | unknown | `ConsoleClassName=OutpostConsole`. Not settled statically, as in Main. |
| 6 | `MainMenuMap=/Game/Maps/LaCuna/LaCuna` in Game.ini | does not host | Diagnostic only. **Note** that Game.ini is shared with Main (same Saved folder). |

Matchmaking joiners connect to whatever `session-started` names, so the same `server/` MMS flow would work once a host can listen (route 0).

## Classic support in `server/` and `launcher/` (implemented)

Tested with `node tools/mm_test.js <port>` (main client, unchanged behaviour) and `node tools/classic_test.js <port>` against a temporary server. It was **not** tested with the real Classic client.

Server (`server/server.js`):

1. **App id.** Login keeps the `app-id` the client sends (Classic: `sostest`) in the JWT. AppPersistence is keyed by app already. Classic never calls the inventory, store or season routes, so they stay as they are for the main client.
2. **Roles.** A `sostest` login gets `app-user user testserver`, plus any `classic.EXTRA_ROLES`, plus `dev` for accounts or Steam ids in `classic.DEV_ACCOUNTS` (`data/config.json`).
   - The roles are in the JWT `roles` claim and also in the top-level `roles` of the login reply. Main-client logins are unchanged.
3. **Live config.** Both clients share one Engine.ini, so they share one KV endpoint. The server picks the folder by the request's `app-id` header:
   - `sostest` gets `data/kv-classic/`;
   - everything else gets `data/kv/`.

   `data/kv-classic/live-rev.txt` names the current file, `runtime-2.json`. Bump the revision with every change so running clients and hosts refetch. It sets:
   - `UE_CLIENT_TEST_SERVER_ENABLED` and its MOTD;
   - the custom-match keys (map `LaCuna`) and the duo keys, all open to role `user`;
   - an empty `UE_CLIENT_DIRECTOR_USERS`;
   - `UE_CLIENT_VOTING_ENABLED: false`. The host's FlareVotingManager reads it. When unset, a flare starts a HERO audience vote that needs the dead Stream service (docs/HERO_TV.md).
4. **Matchmaking.** Classic connections (JWT `app-id` `sostest`) go to a **second matchmaker instance**. `server/matchmaking.js` is unchanged. The two builds never share a queue or session.
   - Its settings default to the main ones. Any key can be overridden in the `classic` object of `data/config.json`, or with env `OGSOS_CLASSIC_<KEY>`; for example `GAME_SERVER_PORT` for a Classic host.
   - Empty game-mode or map (solo), `duo` groups and custom `create-session`/`start-session` work as-is.
5. **WebSocket subprotocol.** The 101 reply echoes the whole `Sec-WebSocket-Protocol` value (`wss,ws`), for both clients.
6. **Cosmetics.** No `data/cosmetics-classic.json`: Classic has no inventory service. Its locks are Steam DLC checks (see Cosmetics above), which the server cannot answer.

Launcher (`launcher/launcher.js`):

7. `--classic` (or a `--game` path containing `SOS Test Server`) finds the install from Steam's `libraryfolders.vdf` and `appmanifest_802240.acf`. On this machine that is `C:\Program Files (x86)\Steam\steamapps\common\SOS Test Server`.
8. **Saved path.** It is `%LOCALAPPDATA%\SOS\Saved\Config\WindowsClient\Engine.ini`, **the same file as the main client**, because both builds are project `SOS`. This is Inferred from the shared engine code; Classic has never been run on this PC, so there is no Classic log to confirm it.
   - `--ini <path>` overrides it.
   - The launcher writes the same sections for both clients. The extra IAP and Storefront sections are harmless to Classic.
   - Pointing one client at a server points both, and `--restore` restores both.
9. **Hosting** is still blocked on `UWorld::Listen`. Later, a host mode would pass `LaCuna?game=SUR?listen` and run a patched private copy of the exe.

### MMS session routes for a hosted server

A listen server is started with `-SESSION_ID=<hyphenated guid> -SESSION_TOKEN=<secret>` and uses the client's MatchmakingApi (`http://<ip>:<port>/api`). It sends `Authorization: Token <SESSION_TOKEN>` on:

- `GET /api/session/<id>`: once at startup and then every 5 s. The server answers 200 with the **bare** session object (same as `sessionObj(s, true)`, no `{version,data}` wrapper). Every GET kicks any connected player missing from `player-map`, so `player-map` always also lists the configured `hostIds` (the host's own player, possibly the same Steam id as a joiner).
- `POST /api/session/<id>/events` with `{"type":"match-start"}`: 200 `{"result":true}` (the type is logged).

Unknown id gives 404, a wrong or missing token gives 401. Both matchmakers are searched (Classic first).

**Public server list.** Every `HOSTS` entry (Classic and main) is listed by `GET /servers`, for a future in-game server browser.

- `GET /servers` (no auth, `Access-Control-Allow-Origin: *`) returns `{"servers":[{id, game, name, region, online, players, minPlayers, maxPlayers, state, map, address, backend, lastSeenSec}]}`. `game` is `classic` or `main`; `state` is `waiting` (below the minimum), `countdown` or `started`; `players` counts seated players without the `hostIds`; `address` is `<PUBLIC_HOST or the entry's host>:<game port>`; `backend` is `OGSOS_PUBLIC_BACKEND` (IPv4:port) if set, else `<PUBLIC_HOST>:<listening port>`, else `null`. `online` is true when the game host's last authenticated `GET /api/session/<id>` poll (it polls every 5 s) was within 20 s; `lastSeenSec` is the age of that poll, `null` before the first one. No token is ever included.
- `POST /api/session/<id>/announce` with `{"name":"...","region":"..."}` (both optional; same `Authorization: Token <sessionToken>` as `/start`) overrides the entry's `name` (max 48 chars, default "OG SOS server") and `region` (max 16) in memory and answers `{"result":true}`. Control characters are stripped; an empty name is ignored, an explicit empty region clears it. `tools/host_classic.js --name "..." --region EU` calls it at startup and every 60 s (so a backend restart gets the name back); failures are only warnings.
- Federation (optional): `OGSOS_DIRECTORY='["203.0.113.5:7781"]'` (or `DIRECTORY` in `data/config.json`) makes `GET /servers` also fetch `http://<peer>/servers?local=1` (2 s timeout, cached 15 s, failures ignored) and append the peers' servers, skipping any whose `backend` equals ours. `?local=1` returns only this backend's own servers, so lists never recurse.
- Tests: `tools/servers_test.js` (env in its header).

With `HOSTS` configured, matchmade solo/duo players are **added to the host's fixed session** (id = `sessionId`, owner `system`, host/port from the entry) instead of a new session. Everyone who calls `find-session` at any time lands in that one session, and `GET /api/session/<id>` lists all of them plus `hostIds`. Custom matches (`create-session`) are unchanged. Only the first host is used for now.

**Start gate (hosted sessions only).** A hosted session starts un-started (`session-started` is not sent yet):

- A player seated before the start gets `session` (host/port, own `access-token`) at once but not `session-started`. The seated players also get the existing `summary` message (`players.waiting` = seated count) when the count changes.
- When the seated count reaches `START_MIN_PLAYERS`, a countdown of `START_COUNTDOWN_SECONDS` begins (0 = start at once). When it ends, every seated player gets `session-started` and the session is marked started. If the count falls below the minimum during the countdown (leave, cancel, grace expiry) the countdown is cancelled.
- Players seated after the start (while under `MAX_PLAYERS`) get `session` and `session-started` immediately (join in progress).
- `opts.min-players` in the session object is `START_MIN_PLAYERS`.
- **Force start:** `POST /api/session/<id>/start` starts at once whatever the count and returns `{"result":true,"players":n}`. Typing `start` + Enter in the server console force-starts all hosted sessions (ignored when stdin is closed or not a terminal).
- **Reset** (the host restarted, new match): `POST /api/session/<id>/reset` clears the player-map and the started flag and sends `session-closed` to the players still connected. Returns `{"result":true,"cleared":n}`.
- `start` and `reset` require `Authorization: Token <sessionToken>`. There is no loopback bypass, because behind a tunnel (playit and similar) remote callers arrive as loopback. The host can also type `start` in the server console.
- `POST .../events` with `{"type":"match-start"}` is logged ("host reported match-start") and answered `{"result":true}`; it does not change the session state.

**Lobby and match lifecycle.** The backend start gate is the lobby: players wait in the game menu (the matchmaking WebSocket) and only travel to the host on `session-started`; the host then runs its own pregame show.

- States (`state` in `GET /servers`, with `players`, `minPlayers`, `maxPlayers`, `countdownEndsAt` (ms epoch or null), `votes`, `lateJoinOpen`): `waiting` -> `countdown` -> `started` -> `ended`; `reset` returns any state to `waiting`.
- Auto-start: `START_MIN_PLAYERS` seated players begin a `START_COUNTDOWN_SECONDS` countdown (cancelled if the count drops below the minimum). When the session fills to `MAX_PLAYERS` the running countdown is cut to at most `START_FULL_COUNTDOWN_SECONDS` (default 10). Players joining during the countdown are seated in the same match.
- Vote-start: `VOTE_START_MIN_PLAYERS` (default 2) seated players are needed and a strict majority of seated players must vote; the countdown then becomes `VOTE_START_COUNTDOWN_SECONDS` (default 10, never lengthens a shorter one). Votes are cleared when the voter leaves and on reset. The WebSocket message `{"type":"vote-start"}` does the same (reply `ack`, or `nak`).
- Late join: `LATE_JOIN_SECONDS` (default 300; 0 = never after the start, -1 = always) is how long after the start new players are still seated (they get `session` + `session-started` at once). After that they stay queued with the normal waiting summary and are seated into the next lobby after a reset. A player already seated who reconnects within the travel grace keeps the seat. (For non-hosted matchmade sessions the same key keeps its old meaning, now with the new default.)
- Match end: `POST /api/session/<id>/end` (host token) or a host event `{"type":"match-end"}` / `{"type":"session-end"}` marks the session `ended`, removes all seats (players get `session-closed`) and refuses new seats until `reset`. A started session with no seated players for `EMPTY_END_SECONDS` (default 120, 0 = off) ends by itself. `POST /api/session/<id>/reset` returns to `waiting` (no players, votes, timers) and seats everyone still queued.
- Online gating (pool): a host is `online` (the same flag `GET /servers` shows) while its last authenticated `GET /api/session/<id>` poll is within `HOST_ONLINE_SECONDS` (default 90; hosts poll every ~30-45 s). Only online lobbies are picked: with several `HOSTS`, a new player goes to the fullest open online lobby (waiting/countdown), else an idle online one, else a started one inside its late-join window; a started or full lobby is skipped, so players flow to the next one. If no online lobby has room the player stays queued (normal waiting summary) and is seated as soon as a lobby comes online (offline -> online poll) or is reset. `POST /reset` also marks the lobby offline (the poll time is forgotten) until the restarted host polls again. A countdown that ends while its host is offline is held (state stays `countdown`) and, when the host polls again, restarts as a short `START_FULL_COUNTDOWN_SECONDS` countdown; players already seated stay seated while the host is offline. `GET /servers` lists every lobby in `HOSTS` order, offline ones included.
- Config keys (env `OGSOS_CLASSIC_<KEY>`): `START_MIN_PLAYERS`, `START_COUNTDOWN_SECONDS`, `START_FULL_COUNTDOWN_SECONDS`=10, `VOTE_START_MIN_PLAYERS`=2, `VOTE_START_COUNTDOWN_SECONDS`=10, `LATE_JOIN_SECONDS`=300, `EMPTY_END_SECONDS`=120, `HOST_ONLINE_SECONDS`=90, `TRAVEL_GRACE_SECONDS`.
- Routes:
  - `POST /api/session/<id>/vote-start` with the player's `Authorization: Bearer <jwt>` (or `Token <jwt>`): the per-player session access token from `session`/`session-started`, or the account JWT. Response `{"result":true,"votes":1,"needed":2,"players":3,"state":"waiting"}`. Errors: 401 bad token, 403 `not-seated`, 409 `closed` (already started or ended), 404 unknown session.
  - `POST /api/session/<id>/end` with `Authorization: Token <sessionToken>`: `{"result":true,"released":n}`.
- Test: `node tools/lobby_test.js` (standalone).

**Travel grace.** A player whose WebSocket closes while seated in a hosted session keeps the seat (stays in `player-map`) for `TRAVEL_GRACE_SECONDS` (default 300), because the client drops the matchmaking socket while it travels to the host. If the same account reconnects within the grace, it is reattached silently (no `session`, no `session-started`; `get-session` returns its session with host/port and token). After the grace the player is removed (others get `player-leave`). `leave-session`, a new `find-session` and `cancel-find-session` remove immediately. Non-hosted sessions keep the old behaviour (removed as soon as the socket closes).

**Public address.** The game client does no DNS, so for friends on the internet set `PUBLIC_HOST` to the IPv4 literal they should connect to (your public IP, with the game's UDP port forwarded). It replaces the host sent in `session`, `session-started` and the region `beacon-url` (unless `BEACON_URL` is set explicitly) for hosted and normal sessions. The host's own `GET /api/session/<id>` still shows the entry's `host`. Precedence: `--public-host <ipv4>` on `server.js` (applies to both builds) > env `OGSOS_PUBLIC_HOST` (main) / `OGSOS_CLASSIC_PUBLIC_HOST` (Classic) > `PUBLIC_HOST` / `classic.PUBLIC_HOST` in `data/config.json`; Classic inherits the main value if it has none. A value that is not an IPv4 literal is warned about and ignored. The effective address is printed at startup. The server already listens on `0.0.0.0`; forward the HTTP/WS port (default 7780) and the game's UDP port.

Settings (each also as env `OGSOS_<KEY>`, `OGSOS_CLASSIC_<KEY>` for Classic, or in `data/config.json` / its `classic` object): `PUBLIC_HOST` (default none), `START_MIN_PLAYERS` (1), `START_COUNTDOWN_SECONDS` (10), `TRAVEL_GRACE_SECONDS` (300). Note Classic starts from the main values, so `OGSOS_START_MIN_PLAYERS=3` also applies to Classic unless `OGSOS_CLASSIC_START_MIN_PLAYERS` is set.

The `access-token` in each player's `session` packet is a per-player JWT: header `{"typ":"JWT","alg":"HS512"}`, signed with HMAC-SHA512 using the `sessionToken` as key, claims `sub` = session id, `roles` = `["user+session"]`, the player's `id`, `iat`, `exp`. Sessions without a host keep the old random token.

Config (`classic.HOSTS` in `data/config.json`, or env `OGSOS_CLASSIC_HOSTS` as a JSON string; the main matchmaker reads `HOSTS` / `OGSOS_HOSTS`; the main list is not inherited by Classic):

```json
"HOSTS": [{ "host": "127.0.0.1", "port": 7777, "sessionId": "00000000-0000-0000-0000-000000000000",
            "sessionToken": "CHANGE-ME-placeholder", "hostIds": ["76561190000000000"] }]
```

`host` must be an IPv4 literal, `sessionId` must contain `-`, `sessionToken` longer than 1 character; bad entries are warned about and skipped. Start the game host with the same values: `-SESSION_ID=<sessionId> -SESSION_TOKEN=<sessionToken>`. Tests: the env each run needs is in the header comment of `tools/classic_test.js` (hosted checks, short countdown/grace) and `tools/mm_test.js` (the 3-client hosted scenario needs `OGSOS_HOSTS`, `OGSOS_START_MIN_PLAYERS=3`, a 1 s countdown; run it against a separate server from the non-hosted checks).

## Live test, 2026-11-20 (branch server on 7781, hosting session's listen host on 7777)

- **Steam auth.** It fails (`LoadingSteamClientAuth` Success=false) when the exe is launched directly, because the Classic install ships no `steam_appid.txt`. The launcher now sets `SteamAppId`/`SteamGameId` = 802240 in the child environment. With that set: `LoadingSteamClientAuth` true, then `POST /api/access-token/steam` 200, then `LoadingOutpostLoginEnd` Success=true, user 7656119xxxxxxxxxx.
- **After login.** `GET /api/account`, `GET /api/account/<id>/app/sostest` and `PUT .../app-meta/sostest/language` all return 200.
- **Matchmaking WS.** It stays open on `wss,ws`, with this sequence:
  - `ready`;
  - `leave-all-groups`, answered with `ack`;
  - `get-regions`;
  - `get-session`, answered with `nak not-found` (normal before a match);
  - ping/pong every 30 s.
- **PLAY (solo).** The client sends `find-session` with `game-mode ""` and `map ""`. The server answers `ack`, then `summary`, then `session` (UUID id, host 127.0.0.1, port 7777), then `session-started`.
- **Travel.** The client logs "Join session: traveling to 127.0.0.1:7777" and "Welcomed by server (Level: /Game/Maps/LaCuna/LaCuna, Game: Gamemode_Survival_C)". The host logs "Join succeeded: player-xxxx". The joiner then sits in `LoginPending`, which is the known join-state issue and still open.
- **Leaderboards.** `GET /api/leaderboard/sostest/...` returning `[]` logs "Response failed to deserialize as a valid json array". This is harmless, because the frontend leaderboards are just empty.
- **Cosmetics and coins.** Classic has no inventory or wallet backend (see Cosmetics), so there are no coins. DLC-gated outfits and gestures need the private-copy DLC patch.

## Addresses for a `UWorld::Listen` replacement (Classic exe, image base 0x140000000)

| What | Address / offset | Evidence |
|---|---|---|
| `UEngine::LoadMap` | FUN_141416250 | "LoadMap: failed to Listen(%s)" (UnrealEngine.cpp:0x2639) |
| Listen call site in LoadMap | **0x141417674**: `mov rcx,[r14+0x298]; mov rdx,r13; call 0x140B6EDF0; test al,al` | rcx = `WorldContext.ThisCurrentWorld`, rdx = `FURL&` |
| `UWorld::Listen` (stub) | **0x140B6EDF0** = `32 C0 C3`, a shared return-false stub: patch the **call site**, not the stub | |
| `GIsClient` | DAT_142A035B8 (constant 1) | LoadMap tests `GIsClient==0 \|\| URL.HasOption("Listen")` |
| `GWorld` | DAT_142B79370 | set in LoadMap |
| **`GEngine`** | **DAT_142B766A0** (UEngine*) | loaded before both `CreateNamedNetDriver` wrapper calls |
| `UEngine::WorldList` | engine **+0xB78** (FWorldContext** data), count +0xB80 | wrapper loops |
| `FWorldContext.ThisCurrentWorld` | **+0x298** | |
| `FWorldContext.PendingNetGame` | +0x1C8 | |
| `FWorldContext.ActiveNetDrivers` | +0x248 (data), +0x250 (count); 16-byte `FNamedNetDriver {UNetDriver*, def*}` | `CreateNamedNetDriver_Local` |
| **`UEngine::CreateNamedNetDriver(UWorld*, FName name, FName def)`** | **FUN_1414048E0** (bool) | walks WorldList for ThisCurrentWorld==world |
| `UEngine::CreateNamedNetDriver(UPendingNetGame*, ...)` | FUN_141404870 | |
| `CreateNamedNetDriver_Local(UEngine*, FWorldContext&, FName, FName)` | FUN_141404950 | "CreateNamedNetDriver %s already exists as %s" |
| `UNetDriver.NetDriverName` | driver **+0xE0** (FName) | |
| `FName::FName(const TCHAR*, EFindName)` | FUN_140472C50 (`(FName* out, L"GameNetDriver", 1)`) | used everywhere for names |
| **`UWorld::NetDriver`** | world **+0x38** (DemoNetDriver +0xB8; PersistentLevel +0x30) | UWorld reflection (UObjectProperty offsets) |
| `FNetworkNotify*` for the world | world **+0x28** (second base after UObject's 0x28 bytes): **Inferred** from the layout | |
| `UNetDriver` vtable | 0x142410EB0: `InitBase` +0x1E8, `InitConnect` +0x1F0, **`InitListen` +0x1F8**, `InitConnectionlessHandler` +0x200 | pure-virtual stub FUN_1411E5990 "UNetDriver::InitListen" sits in slot +0x1F8 |
| **`UIpNetDriver::InitListen(this, FNetworkNotify*, FURL&, bool bReuseAddressAndPort, FString& Error)`** | **FUN_140E542B0** (vtable 0x1422F0830, slot +0x1F8) | "Failed to init net driver ListenURL" / "IpNetDriver listening on port %i" (IpNetDriver.cpp); stores the bound port to URL+0x20 |

The UE 4.12 body to recreate:

```
if (World->NetDriver) return false;
if (CreateNamedNetDriver(GEngine, World, NAME_GameNetDriver, NAME_GameNetDriver))
    World->NetDriver = <ActiveNetDrivers entry whose driver+0xE0 == NAME_GameNetDriver>;
// then driver->SetWorld(World): its vtable slot was not identified here
if (!World->NetDriver) return false;
return World->NetDriver->InitListen((FNetworkNotify*)((char*)World + 0x28), URL, false, Error);
```

The config names the Steam net driver with an IpNetDriver fallback, so the driver created from `GameNetDriver` may be `SteamNetDriver`, which also overrides `InitListen`. Still to find: `SetWorld` and `DestroyNamedNetDriver`.

## Helper scripts added

- `tools/exe_strings.py`: dump, diff or grep the UTF-16 and ASCII strings of one or two exes. `diff` writes `only_a/only_b/common.txt`.
- `tools/kismet_dis.py`: a minimal UE 4.12 Blueprint bytecode disassembler for cooked `.uasset` files (`list`, `dis [Func]`, `strings`). It prints in-memory offsets, so jump targets line up.
- `tools/ghidra/run-classic.ps1`: like `run.ps1`, but for the `SOS-Classic` Ghidra project (setup steps are in the header).
- `tools/classic_test.js`: Classic checks against a running server (login roles, per-app KV, separate queues, custom match).
