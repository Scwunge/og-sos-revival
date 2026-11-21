# Hosting a match with the shipped client exe

Question: can `SOS-Win64-Shipping.exe` act as the game server so other clients can join after matchmaking sends `session-started {host, port}`?

Findings come from static analysis of the 64-bit shipping exe (UE 4.12.5, no PDB) in Ghidra and from the pak contents. Nothing was launched. Each claim is marked **Confirmed** (read in code or data) or **Inferred** (reasoned, untested). Addresses are image VAs.

## Verdict

> **Update, 20 Nov 2026: the shipped client cannot host at all. Confirmed, in code and by a test run.** The call in `UEngine::LoadMap` at `14147cef4` (`CALL 0x140188b70; TEST AL,AL`) is the only `UWorld::Listen` site. `FUN_140188b70` is the 3-byte shared stub `32 C0 C3` (`xor al,al; ret`), and the real `Listen` body and its strings are absent from the exe, so `?listen` always fails with `LoadMap: failed to Listen`. `UIpNetDriver::InitListen` (FUN_140eb75b0) is compiled but unreachable from LoadMap.
>
> A test with `SOS-Win64-Shipping.exe LaCuna_BR?game=SUR?listen` loaded the map (129 s) but opened no game port. After 120 s it logged `Player Player1 stuck in LoginPending ... forcing return to MainMenu`, because booting straight into a map skips the Frontend login, so the player never gets an online id or app data. See `AShooterPlayerController` FUN_1401c1a40, `IsLoggedIn` FUN_1401b8ba0 and the console variable `blackbird.LoginPendingTimeout` (default 120).
>
> The listen-server routes below are therefore dead ends. The remaining options are a game build that has server code (check SOS: Classic, see `docs/CLASSIC.md`), injecting a working `Listen` (create the net driver and call `InitListen`) via a proxy DLL, or reimplementing the server side. The bullets below are kept for the record.

- **Dedicated server (`-server`): not possible. Confirmed.** `-server` is never parsed. The engine init (FUN_140138ca0) fixes `GIsClient=1` and never takes the dedicated path. `UNetDriver::GetNetMode` (FUN_141247d30) therefore never returns DedicatedServer.
- **Listen server: supported. Confirmed.** `UEngine::LoadMap` (FUN_14147bad0) listens when `GIsClient==0 || URL has "Listen"`. `GIsClient` is 1, so the `?listen` URL option is what triggers it. `UEngine::Browse` (FUN_141466570) and `AttemptDeriveFromURL` (FUN_1414c20a0) handle the URL.
- **Headless-ish host: `-nullrhi -nosound` are honoured. Confirmed** (nullrhi sites FUN_140467970, FUN_1404f88d0, FUN_140874a80). The host process still runs the client path, so it spawns a local player. Whether that works without a display is **Inferred**.
- **Net driver:** the config names the Steam net driver with an IpNetDriver fallback. Which one is active at runtime is **Inferred** (not tested).

## Maps and game modes

Extracted from the pak (`Content/Maps`), package paths **Confirmed**:

| Map | Package path | Notes |
|---|---|---|
| LaCuna | `/Game/Maps/LaCuna/LaCuna` | references `/Game/Blueprints/GameMode/Gamemode_Survival` |
| LaCuna_BR | `/Game/Maps/LaCuna/LaCuna_BR` | references `GameMode_LastManStanding` and `Gamemode_Survival` |
| LaCuna_BR_Lobby | `/Game/Maps/LaCuna/LaCuna_BR_Lobby` | hangar staging area, spawn points |
| Frontend | `/Game/Maps/Frontend/Frontend` | `FrontendGameMode`, menu only |
| Sanctuary | `/Game/Maps/Sanctuary` | starter-content test map |

- Launch-map override: `UShooterGameInstance::StartGameInstance` (FUN_14020f790) takes the first command-line token as the map URL. **Confirmed.**
- Game mode alias: `?game=SUR` selects Survival. **Inferred** from the alias table and the Gamemode_Survival reference in LaCuna. Which map and mode a real ranked match uses (LaCuna vs LaCuna_BR) is **Inferred**; LaCuna with Survival is the best guess.

## Session and auth code (server side, already in the client exe)

All **Confirmed** unless noted.

Command line:
- `-SESSION_ID=<guid>` and `-SESSION_TOKEN=<secret>` are read by the session setup (FUN_141ab85e0) and the `ShooterGameSession` constructor (FUN_140199c80, SESSION_TOKEN at +0xfd). If no token is given, no auth and no MMS callbacks happen. **Inferred** from the branch structure.
- `-Port=<n>` is parsed by the FURL constructor (FUN_140468150).

Login (`ApproveLogin`, FUN_1401a0800, options parsed in FUN_1401ac190):
- Requires `AuthToken=` in the join URL, else logs "Missing required AuthToken". Also `SpectatorOnly=1`, `DirectorOnly=1` options.
- The token is an HS512 JWT validated by FUN_141a6d6c0. Header serializer FUN_141a6d650 (`alg`, `typ`). Claims serializer FUN_1401c6d90: `id`, `roles`, `aud`, `iat`, `exp`, `sub`.
- Secret is SESSION_TOKEN. `sub` is the session id. `roles` must contain `user+session`. The backend must issue this token as `access-token` in the `session` packet (see docs/MATCHMAKING.md). The role and sub requirements are **Inferred** from string and field use.

MMS HTTP callbacks (only when SESSION_ID and SESSION_TOKEN are set):
- `GET <api>/session/<id>` with `Authorization: Token <secret>`, from `UpdateStatus` (FUN_1401d1e10, callback FUN_1401d2250). Used to refresh the player map; players not in the session are kicked (FUN_1401bfe70, log "not registered in MMS session"). The response schema is **Inferred** to match the WebSocket session object.
- `POST <api>/session/<id>/events` from `StartSession` (FUN_141ac7700, callback FUN_141abda70). Event confirmed: `{"type":"match-start"}`. Success response parsed as `{"result":true}` (serializer FUN_141ac51f0). Failure logs "Failed to notify matchmaking server of match-start". Other event types: not found.
- `<api>` is the `MatchmakingApi` value in `Engine.ini`, same as the client uses (see `launcher/launcher.js`).

Custom and LAN matches: the custom-match settings handler is FUN_141ac6960 and the join path is FUN_141aba080. `bIsLanMatch` and `CustomMatch*` exist in the OSS session code but their startup flow was not traced in full (**Inferred** that they reduce to `?listen` plus the session options).

## Ranked command lines

> **Superseded by "Starting a host" below.** In testing, every one of these lines was dropped by the shipping command-line allow-list: a map token starting with `/` and all `-switches` (`-nullrhi`, `-nosound`, `-log`, `-Port`, `-SESSION_ID`, `-SESSION_TOKEN`) are removed before the engine sees them. The `-nullrhi` claim in the verdict is therefore moot unless the exe is patched.

All untested. Run from the game install directory. Use hyphenated GUIDs for `SESSION_ID`.

1. **Listen host, no backend callbacks (simplest, try first).**
   ```
   SOS-Win64-Shipping.exe /Game/Maps/LaCuna/LaCuna?game=SUR?listen -nullrhi -nosound -log -Port=7777
   ```
   No SESSION_TOKEN, so no JWT auth and no GET or POST to the backend. Clients join by IP and port with whatever `AuthToken` handling the join path requires (**Inferred** it is skipped without a token).

2. **Listen host integrated with our backend.**
   ```
   SOS-Win64-Shipping.exe /Game/Maps/LaCuna/LaCuna?game=SUR?listen -nullrhi -nosound -log -Port=7777 -SESSION_ID=<guid> -SESSION_TOKEN=<secret>
   ```
   Backend must: accept `POST /session/<id>/events` and answer `{"result":true}`; answer `GET /session/<id>` with the session JSON; sign `access-token` JWTs (HS512) with `<secret>`, `sub` = session id, `roles` including `user+session`; report `host` as IPv4 in `session-started` (port from `-Port`).

3. **Battle royale variant.** Same as 2 with `/Game/Maps/LaCuna/LaCuna_BR?listen` (drop or change `?game=`). Use if the match type needs LastManStanding.

If a window is acceptable, drop `-nullrhi` to rule out headless problems.

## Log lines to watch (`-log`, `Saved/Logs`)

Success:
- `IpNetDriver listening on port <n>` (or the Steam driver equivalent)
- LoadMap lines for the target map, no "LoadMap: failed to Listen"
- client login lines from ApproveLogin and no kick messages

Failure:
- `Missing required AuthToken`
- `Failed to notify matchmaking server of match-start`
- `not registered in MMS session` (player kicked)

## Open risks

- Host process runs as a player; behaviour with `-nullrhi` unverified.
- Which net driver binds and whether the port from `-Port` is honoured by it.
- Whether `-saveddirsuffix` isolates `Engine.ini` when running host and client on one machine.
- Exact GET session JSON schema.

## Starting a host

Why the first two tests failed, and every route found for getting a listen server started. Static analysis only (Ghidra on the app 619080 exe, pak contents); nothing here was run. Addresses are image VAs. **Confirmed** = read in code or data, **Inferred** = reasoned.

### Why the command line failed (Confirmed)

- The shipping build filters the command line inside `FCommandLine::Set` (FUN_140474fc0, which calls the filter FUN_140478a60 unconditionally; log line `Filtering command line`). All four buffers are filtered: the live line **and** the "original" copy, so there is no `GetOriginal` bypass.
- Allow-list (UTF-16 at 0x14209f0f0): `-fullscreen -windowed -forcelogflush -AUTH_LOGIN -AUTH_PASSWORD -AUTH_TYPE -fullcrashdumpalways -fullcrashdump`. The `-AUTH_*` switches feed the OSS AutoLogin readers (FUN_141a9c090, FUN_141aae400, FUN_141abbc70; types seen in code: `OutpostUser`, `OutpostOnceCodeUser`, `Steam`, `Auto`). They are a login convenience, not a way to a match.
- The filter (FUN_140461750) only examines tokens whose first character is `-` or `/`. A token matching none of the allow-list names is removed. **Tokens that start with any other character pass through untouched.** The test line started with `/Game/...`, so the map was removed along with every switch.
- Consequence for the older notes above: `-nullrhi`, `-nosound`, `-log`, `-Port`, `-SESSION_ID`, `-SESSION_TOKEN` can never reach the engine on an unpatched exe.

### Why the Engine.ini override failed (Confirmed)

- `GameDefaultMap` and `LocalMapOptions` (`[/Script/EngineSettings.GameMapsSettings]`) are only read by the stock `UGameInstance::StartGameInstance`. SOS overrides it with `UShooterGameInstance::StartGameInstance` (FUN_14020f790, copied from the ShooterGame sample), which never reads them. If the first command-line token is absent or starts with `-`, it goes straight to the main-menu state (FUN_1401e5100, via `GotoState` FUN_14023e820 with state DAT_142a4b6d8).
- The main-menu state loads its map with `LoadFrontEndMap` (FUN_1401ff650) from the config property **`MainMenuMap`** (FString at +0xF8 of `UShooterGameInstance`, `UPROPERTY(Config)`, so it lives in **Game.ini**, section `[/Script/ShooterGame.ShooterGameInstance]`). Its default `/Game/Maps/Frontend/Frontend` is baked into the exe (FUN_1404a3270 seeds `MainMenuMap` and `WelcomeScreenMap`) and is also in the pak's `DefaultGame.ini`. The log line `Browse: Frontend` is this call.
- The pak's `DefaultEngine.ini` has `GameDefaultMap=/Game/Maps/Frontend/Frontend`, `ServerDefaultMap=/Game/Maps/Sanctuary`, `GlobalDefaultGameMode=Gamemode_Survival_C`, `GameInstanceClass=GameInstance_Survival_C`. Its `[URL]` section is only `GameName=SOS` (`BaseEngine.ini` adds `Port=7777`).
- `LoadFrontEndMap` builds the URL with `FURL(const TCHAR*)` (FUN_141491410). That constructor reduces the string to a base filename (no path, no extension; hence `Browse: Frontend`) and parses **no** `?options`. So `MainMenuMap=...?listen` becomes a map literally named `LaCuna_BR?listen` and fails to load. The Game.ini key can change the map, but never add `?listen` (route 4).

### Routes, ranked

| # | Route | Effort | Likelihood | Needs |
|---|---|---|---|---|
| 1 | Map token on the command line that does not start with `-` or `/` | seconds | decent | nothing |
| 2 | Console `open` from the menu | seconds to test | unknown | console compiled in |
| 3 | Byte patch on a private exe copy (disables the filter) | 10 min | high | private exe copy |
| 4 | `MainMenuMap` in Game.ini | seconds | cannot start a listen server | diagnostic use only |
| 5 | Custom Match UI via live config and roles | minutes | lobby UI only, not a host | server work for the host |

#### Route 1: map token that survives the filter (try first)

The filter keeps the first token if it does not start with `-` or `/`. `StartGameInstance` takes that token as the map URL and parses `?options` with the full URL parser, so `?listen` works.

```
SOS-Win64-Shipping.exe LaCuna_BR?game=SUR?listen
```

Variants to try in order if the map fails to load (watch `Saved\Logs` for `Failed to load package`):
1. `LaCuna_BR?game=SUR?listen` (short name; the engine already loads `Frontend` by short name, so name resolution works in this build).
2. `../../../SOS/Content/Maps/LaCuna/LaCuna_BR?game=SUR?listen` (filename form, starts with `.`).
3. `LaCuna?game=SUR?listen` (the map from the first analysis; may be ambiguous as a short name).

Notes:
- Run from `...\SOS\SOS\Binaries\Win64`, Steam running, no BattlEye (as the launcher does).
- `-windowed` and `-fullscreen` still pass. `-log`, `-nullrhi`, `-nosound`, `-Port` are dropped. The port is the default 7777 (`[URL] Port=7777` in `BaseEngine.ini`).
- With no `-SESSION_ID`, `ApproveLogin` (FUN_1401a0800) skips the `AuthToken` check: the check only runs when the session id string is non-empty. **Inferred** from the branch shape, so joiners should need no JWT.
- The host skips the Frontend, so it never logs in to our backend. The success path ends in the Playing state (DAT_142a4b6e8). Whether Gamemode_Survival waits on MMS state before starting is unknown.
- Real matches queue on map `LaCuna/LaCuna_BR` with game type `solo` or `duo` (string constants in `NewFrontendMainMenu`'s bytecode), so `LaCuna_BR` is the map joiners will expect. **Confirmed** as client-side strings.
- Success lines: `Browse:` and `LoadMap:` for the map, then `IpNetDriver listening on port 7777` (or the Steam driver equivalent).
- Failure line `Console commands were used which are disallowed in netplay. You must restart the game to create a match.` appears if the cheat flag (DAT_142bdba54) is set when `listen` is requested (FUN_141466570). Do not use console cheats before hosting.

#### Route 2: console (test it, do not rely on it)

- Engine config names a custom console class (`DefaultEngine.ini`: `ConsoleClassName=/Script/ShooterGame.OutpostConsole`) and `DefaultInput.ini` has `ConsoleKeys=Tilde`.
- Whether the shipping viewport creates the console could not be settled statically. Test: press the tilde key in the main menu or in a match. If a prompt appears, run `open LaCuna_BR?game=SUR?listen`. This route keeps the host logged in.
- `-ExecCmds` is filtered. `ConsoleVariables.ini` (loaded at FUN_14046a270) only sets cvars. No ini-driven exec path was found.

#### Route 3: private patched exe (also restores `-log -nullrhi -Port -SESSION_*`)

Patch the single call to the filter. It has exactly one caller (FUN_140474fc0, `FCommandLine::Set`).

| Item | Value |
|---|---|
| Exe | `SOS-Win64-Shipping.exe`, 46,694,640 bytes (identical to the Ghidra input) |
| VA / RVA | `0x14047504F` / `0x47504F` |
| File offset | `0x47464F` |
| Original bytes | `E8 0C 3A 00 00` (`call FUN_140478a60`) |
| New bytes | `90 90 90 90 90` (or the 5-byte NOP `0F 1F 44 00 00`) |

Why it is safe: the call only filters the four command-line buffers and logs a line. Nothing reads its result; the next instruction stores `1` to a flag (DAT_142a5663c) and execution continues. The lazy allow-list initialisation inside the function is skipped, and the only other reader of that list (FUN_141f5f250) then sees an empty list.

Do not patch the install in place. Copy the exe to a differently named file in the same folder (it needs the install's relative paths), patch the copy, and launch the copy directly (no BattlEye). Steam file verification may delete the copy. Any Authenticode signature becomes invalid; nothing here enforces it.

With the patch the original command lines work again:
```
SOS-Win64-Shipping-host.exe LaCuna_BR?game=SUR?listen -log -nullrhi -nosound -Port=7777 -SESSION_ID=<guid> -SESSION_TOKEN=<secret>
```

#### Route 4: `MainMenuMap` in Game.ini (does not host)

```
; %LOCALAPPDATA%\SOS\Saved\Config\WindowsClient\Game.ini
[/Script/ShooterGame.ShooterGameInstance]
MainMenuMap=/Game/Maps/LaCuna/LaCuna_BR
```
Boots straight into the map as a standalone game: no `?listen`, no Frontend, no login. Useful only to prove that config reaches the map load. Remove it afterwards; the game returns to this map whenever it goes to the main menu.

#### Route 5: custom match through live config and roles (UI only)

Custom match is an MMS lobby, not local hosting. `CustomMatchUI` calls `MatchmakingCreateSession`, `MatchmakingJoinSession` and `StartSession`, and the lobby has a host-only START MATCH button (`IsMatchHost`). Starting it is an MMS event, so our server must still answer with `session-started {host, port}` pointing at a running listen server (route 1 or 3). It is the cleanest way to give testers a host lobby.

The menu gate is in `NewFrontendMainMenu` (variables `CustomMatchesEnabledGlobal`, `CustomMatchesEnabledRoleOverride`, `CustomMatchButton`; function `IsPlayerInAppRole`). It subscribes to these OutpostKeyValueStore keys, served from `data/kv/runtime-<rev>.json` (a flat JSON object, key to value). Value types are **Inferred** from the Blueprint accessor nodes (`AsStringArray`, `AsString`, `AsBool`).

| Key | Type | Effect |
|---|---|---|
| `UE_CLIENT_MM_TYPES_ENABLED` | string array | which queue types are on (compared against `solo`, `duo`; a `custom` entry is Inferred) |
| `UE_CLIENT_MM_TYPE_CUSTOM_ROLES` | string array | app roles that see the Custom button even if the type is not globally on |
| `UE_CLIENT_MM_TYPE_SOLO_ROLES`, `UE_CLIENT_MM_TYPE_DUO_ROLES` | string array | same for Solo and Duo |
| `UE_CLIENT_CUSTOM_MATCHES_MAPS` | string array | map list in the Custom Match create screen |
| `UE_CLIENT_INACTIVE_SERVER_TEXT` | string | text of the "SERVERS NOT ACTIVE" dialog |
| `UE_CLIENT_TEST_SERVER_ENABLED` | bool | test-server banner in `NewFrontendHUD` |

Suggested `runtime-1.json`:
```json
{
  "UE_CLIENT_MM_TYPES_ENABLED": ["solo", "duo", "custom"],
  "UE_CLIENT_MM_TYPE_CUSTOM_ROLES": ["app-user"],
  "UE_CLIENT_CUSTOM_MATCHES_MAPS": ["LaCuna/LaCuna_BR"]
}
```
`IsPlayerInAppRole` checks the roles from the login reply (`AppRoles`); our `/login` returns `app-user` by default, so listing `app-user` opens the button for everyone. The exact map-list entry format and whether `custom` is the right enable token need one test. No hard-coded `admin`, `dev` or `streamer` role exists in the exe or the Blueprints.

Other keys that matter for a host match: `UE_CLIENT_STAGING_COUNTDOWN_TIME`, `UE_CLIENT_STAGING_MIN_WAIT_PLAYER_COUNT`, `UE_CLIENT_STAGING_MAX_WAIT_PLAYER_COUNT`, `UE_CLIENT_STAGING_MIN_WAIT_TIMEOUT`, `UE_CLIENT_STAGING_MAX_WAIT_TIMEOUT` (staging area before the drop; defaults unknown, set low for solo tests).

### Other findings

- No tutorial, practice or LAN mode builds a `?listen` URL. `?listen` is never composed in game code; the only `listen` literals are the engine's URL checks in `Browse` / `LoadMap`. No Blueprint calls `OpenLevel`, `ServerTravel` or `ClientTravel`; the `ExecuteConsoleCommand` nodes only run `quit` and `exit`.
- `ServerDefaultMap=/Game/Maps/Sanctuary` only matters for a dedicated-server start, which this exe never takes.
- A second install exists: Steam app 802240 "SOS: Classic" in `steamapps\common\SOS Test Server` (different exe and pak, same allow-list string). Not analysed.

### Test order

1. Route 1, variant 1. In `Saved\Logs`, `Command line:` should now show `LaCuna_BR?game=SUR?listen` after `Filtering command line`, followed by `Browse:` / `LoadMap:` for the map and the listening line.
2. If the map does not load, try variant 2. If it loads but does not listen, look for the cheat-flag line above.
3. If the process cannot be made to work this way, use route 3.
