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

   `data/kv-classic/runtime-1.json` sets:
   - `UE_CLIENT_TEST_SERVER_ENABLED` and its MOTD;
   - the custom-match keys (map `LaCuna`) and the duo keys, all open to role `user`;
   - an empty `UE_CLIENT_DIRECTOR_USERS`.
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
