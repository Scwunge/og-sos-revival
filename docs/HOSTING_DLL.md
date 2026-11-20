# Hosting DLL (`mod/sos_host`)

Both shipping exes have `UWorld::Listen` compiled out, so `?listen` always fails with `LoadMap: failed to Listen` (see `docs/HOSTING.md`). `sos_host` is a `version.dll` proxy that puts a working `Listen` back. With it, one copy of the game can host a listen server that other clients join by `IP:port`.

It supports the main client (Steam app 619080) and SOS: Classic (app 802240). It patches nothing in any other exe.

## What it does

The game imports `VERSION.dll` and loads it from its own folder first, so the proxy only has to sit next to the exe. All 17 `version.dll` exports jump to the real `%SystemRoot%\System32\version.dll`.

At load (`DllMain`), before the game's own code runs:

1. **Identifies the exe.** It checks `SizeOfImage`, the PE timestamp, the `32 C0 C3` Listen stub, and that the `LoadMap` call site is `E8 <rel32 to the stub>` followed by `84 C0` (`test al,al`). If any check fails, it logs `Unknown exe` and patches nothing.
2. **Redirects the one `UWorld::Listen` call.** The `CALL` in `UEngine::LoadMap` is rewritten to call a 12-byte thunk (`mov rax, HostListen; jmp rax`) placed within 2 GB of the exe. The shared stub itself is untouched, because it is a COMDAT-folded `return false` that many unrelated functions call.
3. **Optionally disables the command-line allow-list** by replacing the single filter call in `FCommandLine::Set` with a 5-byte NOP. `-log`, `-Port=`, `-nullrhi`, `-SESSION_ID=` and so on then reach the engine.

`HostListen(UWorld*, FURL&)` is UE 4.12.5's `UWorld::Listen`, built from functions still in the exe (the same ones `UGameInstance::PlayReplay` uses for the demo driver):

```
if World->NetDriver: fail                                  (NetDriverAlreadyExists)
GEngine->CreateNamedNetDriver(World, NAME_GameNetDriver, NAME_GameNetDriver)
World->NetDriver = GEngine->FindNamedNetDriver(World, NAME_GameNetDriver)
NetDriver->SetWorld(World)
NetDriver->InitListen(World as FNetworkNotify, URL, false, Error)   (vtable +0x1F8)
on failure: GEngine->DestroyNamedNetDriver(...), World->NetDriver = null, fail
```

The stock version also copies `MaxInternetClientRate` and `ServerTravelPause`; those are tuning values and are skipped.

**Net driver choice.** `GameNetDriver` resolves to `SteamNetDriver` with `IpNetDriver` as fallback. By default, `SteamNetDriver::InitListen` opens Steam P2P sockets, which IP clients cannot reach. When the driver is the Steam one and `SteamSockets=0` (the default), the DLL does what the `?bIsLanMatch` branch of that function does: it sets `bIsPassthrough` (`+0x390`) and calls `UIpNetDriver::InitListen` directly. Joining clients already use IP passthrough when they connect to an IP address.

## Build

Needs MinGW-w64 gcc (the WinLibs build is installed on the dev machine). From `mod\sos_host`:

```powershell
.\build.ps1
```

Output: `mod\sos_host\build\version.dll` (about 22 KB, depends only on kernel32 and the UCRT that the game already uses) and a copy of `sos_host.ini`.

## Install and remove

Copy two files into the game's binaries folder:

| File | Destination |
|---|---|
| `build\version.dll` | `...\steamapps\common\SOS\SOS\Binaries\Win64\version.dll` |
| `build\sos_host.ini` | same folder (optional; defaults are built in) |

For Classic, use `...\steamapps\common\SOS Test Server\SOS\Binaries\Win64\`.

To remove, delete `version.dll`, `sos_host.ini`, `sos_host.log` and any `sos_game_*.log` from that folder. The exe and pak are never modified. Launch the exe directly, as `launcher/launcher.js` does, not through BattlEye.

The DLL is inert for players who do not pass `?listen`. Only the command-line filter patch is active in every session, and it only lets more switches through.

## Config (`sos_host.ini`, section `[Host]`)

| Key | Default | Meaning |
|---|---|---|
| `EnableListen` | 1 | 0 keeps the stock (failing) Listen. |
| `Port` | 0 | Listen port; 0 keeps the URL port (7777 from `[URL] Port`, or `-Port=`). |
| `UnfilterCommandLine` | 1 | NOP the shipping command-line allow-list. |
| `SteamSockets` | 0 | 1 lets `SteamNetDriver` listen on Steam sockets (IP clients cannot join). |
| `LoginPendingTimeout` | 0 | Main client only. If above 0, sets `blackbird.LoginPendingTimeout` to this many seconds when Listen runs. |
| `LogFile` | `sos_host.log` | Relative to the DLL folder, or absolute; `-` disables it. |
| `GameLog` | 1 | Mirror every `UE_LOG` line to `sos_game_<pid>.log` in the DLL folder (see below). |

## Game log mirror

In these runs the shipping client wrote no `SOS.log`, even with `-log`, so the DLL copies the game's own log output. It hooks `FMsg::Logf_Internal` (main `1404a9f30`, Classic `14044a500`) with a 5-byte `jmp` to a near thunk. The hooked prologue (`40 53 55 56 57`) is moved to a trampoline, so the original still runs. The hook formats the message with `_vsnwprintf` and gets the category name with `FName::ToString` (main `1404de7a0`, Classic `14047e090`). It writes `[hh:mm:ss.ms] Category: Verbosity: text` lines to `sos_game_<pid>.log` next to the DLL. One file per process, so a host and a joiner on the same machine do not mix. Blueprint script warnings make these files large (about 30 MB for the host in 8 minutes).

To remove, also delete any `sos_game_*.log` from the folder.

## Starting a host

From `...\SOS\SOS\Binaries\Win64`, with Steam running:

```powershell
.\SOS-Win64-Shipping.exe LaCuna_BR?game=SUR?listen -log -windowed
```

Expected in `sos_host.log`:

```
sos_host loaded into SOS main (619080) ...
Patched LoadMap Listen call at +147cef4 -> thunk ...
Command-line filter disabled at +047504f
Listen(...) requested, port 7777
Listening with SteamNetDriver (IP passthrough) on port 7777
```

Expected in the game log mirror (`sos_game_<pid>.log`): `GameNetDriver IpNetDriver_0 IpNetDriver listening on port 7777`, and no `LoadMap: failed to Listen`.

Clients join through matchmaking (`session-started` with `host`/`port` pointing at the host), or with `open <ip>:7777` where a console exists.

## The host player and LoginPending (main client)

Booting straight into a map skips the Frontend, so the host's local player never logs in to the backend. `AShooterGameMode` (FUN_1401cd360, the `RestartPlayer` override) checks `IsLoggedIn` (FUN_1401b8ba0). That needs a PlayerState with a UniqueNetId (`+0x3d8`) and app data (`+0x518`) with `+0x38 >= 1`. Without them the controller is put in the `LoginPending` state. The controller tick (FUN_1401c1a40) returns it to the main menu after `blackbird.LoginPendingTimeout` seconds (cvar float at `*0x142a4b0b0`, default 120). That would take the listen server down with it.

The least invasive fix, implemented here: set `LoginPendingTimeout` in the ini (for example `LoginPendingTimeout=86400`). The host player then just waits in `LoginPending` with no pawn, which makes it a de facto spectator. The listen server keeps running and remote players log in normally. Nothing in game code is patched for this, and joining clients are unaffected because the value only matters on the machine that runs the controller tick, the host.

Other options, not implemented:
- Make `IsLoggedIn` return true for the local controller. This lets the host spawn, but code that reads the missing app data (loadout and so on) may crash.
- Host from a logged-in session: start at the Frontend and log in, then make the travel to the match address load the map with `?listen` instead (a `UEngine::Browse` FUN_141466570 hook keyed on the host's own address). The host would then be a normal, logged-in player. This is the best long-term route.

Classic has no `blackbird.LoginPendingTimeout`; its login flow is not analysed yet.

## Address tables

Image base `0x140000000`; the DLL uses RVAs and the runtime base (ASLR is on).

| Item | Main (619080) | Classic (802240) |
|---|---|---|
| `SizeOfImage` / PE timestamp | 48713728 / `5bc0f502` | 48156672 / `5b971052` |
| LoadMap `CALL Listen` site | `14147cef4` | `141417674` |
| Listen stub (`32 C0 C3`) | `140188b70` | `140b6edf0` |
| `FCommandLine::Set` filter call (`E8 0C 3A 00 00`) | `14047504f` | `14041578f` |
| `GEngine` | `142bf5818` | `142b766a0` |
| `FName::FName(const TCHAR*, EFindName)` | `1404d3280` | `140472c50` |
| `UEngine::CreateNamedNetDriver(UWorld*, FName, FName)` | `14146a1c0` | `1414048e0` |
| `UEngine::FindNamedNetDriver(UWorld*, FName)` | `141471a30` | `14140c1d0` |
| `UEngine::DestroyNamedNetDriver(UWorld*, FName)` | `14146c3b0` | `141406ad0` |
| `UNetDriver::SetWorld` | `141258c90` | `1411f3aa0` |
| `USteamNetDriver::InitListen` | `141aeafc0` | `141a7ec40` |
| `UIpNetDriver::InitListen` | `140eb75b0` | `140e542b0` |
| `FMemory::Free` | `14040d1b0` | `1403acc40` |
| `blackbird.LoginPendingTimeout` value pointer | `142a4b0b0` | none |

Shared layout (both builds): `UWorld` FNetworkNotify base `+0x28`, `UWorld::NetDriver` `+0x38`, `UWorld::DemoNetDriver` `+0xb8`. `UNetDriver::World` `+0xa0`, `Notify` `+0xe8`, `NetDriverName` `+0xe0`, `ServerConnection` `+0x70`. Vtable: `InitBase` `+0x1E8`, `InitConnect` `+0x1F0`, `InitListen` `+0x1F8`. `FURL::Port` `+0x20`, `FURL::Map` `+0x28`. `USteamNetDriver::bIsPassthrough` `+0x390`. `FWorldContext::World` `+0x298`, `ActiveNetDrivers` `+0x248`; `UEngine::WorldList` `+0xb78`.

How they were found (Ghidra, `SOS` and `SOS-Classic` projects):
- `UGameInstance::PlayReplay` (main FUN_141136db0, Classic FUN_1410d1fd0; string `PlayReplay: failed to create demo net driver!`) calls `FName(L"DemoNetDriver",1)`, `CreateNamedNetDriver(GEngine, World, ...)`, `FindNamedNetDriver`, stores to `World+0xb8`, calls `SetWorld`, then `InitConnect` through vtable `+0x1F0` with `World+0x28`.
- `CreateNamedNetDriver_Local` (FUN_14146a230, strings `CreateNamedNetDriver ...`) and `DestroyNamedNetDriver_Local` (FUN_14146c410, string `DestroyNamedNetDriver %s [%s]`) each have two thin wrappers. The one that matches `FWorldContext::World` (`+0x298`) is the `UWorld*` overload; the other matches `PendingNetGame` (`+0x1c8`).
- `USteamNetDriver::InitListen` is the function with the string `Unreal server (Steam)`. It checks `bIsLanMatch`, sets `+0x390`, and tail-calls `UIpNetDriver::InitListen` (string `%s IpNetDriver listening on port %i`).
- `UWorld::NotifyControlMessage` (main FUN_1414ca7f0) is entered with `this = World+0x28` and reads `NetDriver` at `this+0x10`, which confirms the `+0x38` offset.

## Status and open items

- Built and smoke-tested outside the game: export forwarding works, and an unknown exe is left unpatched.
- **In-game test, 20 Nov 2026, main client:** `SOS-Win64-Shipping.exe LaCuna_BR?game=SUR?listen -log -windowed` with `LoginPendingTimeout=86400`. `sos_host.log` showed both patches, then `Listen(/Game/Maps/LaCuna/LaCuna_BR) requested, port 7777`, `blackbird.LoginPendingTimeout 120.0 -> 86400` and `Listening with IpNetDriver on port 7777`. The game picked `IpNetDriver` directly, not the Steam driver. The process owned UDP `0.0.0.0:7777` and was still up 150 s after Listen, past the stock 120 s LoginPending kick. The host window stays on the loading screen, as expected for a player waiting in LoginPending with no pawn.
- The same process also holds about 26 UDP sockets on consecutive high ports (61609 to 61634). The count stayed flat over a minute, and the DLL logs a single Listen, so it is not the listen path re-creating sockets. They are opened at startup by something else in the client.
- No `SOS.log` was written during the run (only the backup of the previous log), even with `-log`. This led to the game log mirror above.
- **Join test, 20 Nov 2026, main client, both on one PC.** Host started as above. A second copy (no `?listen`) logged in to our backend, queued, and got `session-started` pointing at `127.0.0.1:7777`.
  - Joiner: `Join session: traveling to 127.0.0.1:7777`, then `Welcomed by server (Level: /Game/Maps/LaCuna/LaCuna_BR, Game: .../Gamemode_Survival_C)`; LoadMap took 6 s.
  - Host: `Server accepting post-challenge connection from: 127.0.0.1:...`, `Login request: ...?Name=Player1??AuthToken=... userId: 7656...`, `Join succeeded: Player1`, `Player1: ChangeState Spectating -> Playing` (12:45:13, right after the join), then `GetPlayerAppInventory: Creating AppInventory for AccountId 7656...`. So the server-side `IsLoggedIn` passed for the remote player with no extra work.
  - Joiner side: its own controller went `Spectating -> LoginPending` at 12:45:13 and stayed on the loading screen. It logged `OnGetAccountInfoComplete encountered an empty Steam ID for User: 7656...` and `JsonObjectStringToUStruct - Unable to parse json=[]` / `OnQueryAchievementsComplete(bWasSuccessful = FALSE)` twice (12:45:13 and 12:45:45).
  - At 12:50:33 the joiner went `LoginPending -> Playing` and `HideLoadingScreen - Map LaCuna_BR took 333.28 seconds`. It was in the map with a pawn and the in-game HUD (minimap, kill counter, Leave Match). Neither log shows what released it; nothing was logged on either side in the preceding 5 minutes.
  - The host player itself stayed in `LoginPending` (loading screen), as expected.
- Open: the 5-minute wait on the joiner. Likely suspects are the two backend errors above (both are about the joiner's own account, not the host):
  - `OnGetAccountInfoComplete` (FUN_141a66300) reads a Steam ID `FString` at `+0x90` of the parsed account-info struct and fails when it is empty. The `GET /api/account/<id>` reply has the Steam ID only inside `identities[].provider-data`. Which JSON key fills `+0x90` is not confirmed yet; `steam-id` (the key the login request uses) is the first thing to try.
  - The achievements query expects a JSON object and gets `[]`.
- With no `-SESSION_ID`, `ApproveLogin` skips the `AuthToken` check (Inferred, see `docs/HOSTING.md`). The join above confirms a connection without a session check is accepted.
- The host player could get a real login with the `-AUTH_LOGIN=` / `-AUTH_PASSWORD=` / `-AUTH_TYPE=` switches (types `OutpostUser`, `OutpostOnceCodeUser`, `Steam`, `Auto`); the host logs `Outpost: AutoLogin missing AUTH_LOGIN`. Not tried.
- The Classic table is derived the same way but has not been run.
