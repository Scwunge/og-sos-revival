# Client mod: in-game server browser (SOS: Classic)

`mod/sos_client` is a drop-in DLL. A **SERVERS** button appears at the top of the main menu. It opens a live list of community servers (name, region, players, state), and clicking one joins it. The DLL points the game at the backend itself, with no Engine.ini editing and no `.cmd`.

Status: built and verified in the running game (21 Nov 2026) against a local backend. See "Verified" below.

## Install (players)

1. Build or download `xinput1_3.dll` and `sos_client.ini`.
2. Copy both into the game's `SOS\Binaries\Win64` folder, next to `SOS-Win64-Shipping.exe` (Steam: right-click SOS: Classic, Manage, Browse local files, then open `SOS\Binaries\Win64`).
3. Optional: edit `sos_client.ini`. `Backend=` is the community backend (default `sos.joltora.com:7781`).
4. Start the game from Steam as usual. On the main menu press **START**, then use **SERVERS** (top centre). Click a server: the mod tells the backend you picked it and presses PLAY for you.
5. To remove the mod, delete `xinput1_3.dll` (and the ini).

It does not conflict with the host DLL (`mod/sos_host`, `version.dll`): the proxy names differ. Do not install it on a machine that runs a game host.

## Build

```powershell
cd mod\sos_client
.\build.ps1          # needs MinGW-w64 gcc on PATH; writes build\xinput1_3.dll and build\sos_client.ini
```

`mod\sos_client\test\test_proxy.c` is a small harness that loads the DLL and checks the XInput forwarding.

## What it does

| Feature | How |
|---|---|
| Loads | `xinput1_3.dll` proxy: the shipping exe imports XINPUT1_3.dll by ordinal, and the game folder is searched first. Everything forwards to the real System32 DLL. Steam's Play button runs the shipping exe directly, so BattlEye is not involved. |
| Endpoint override | Hooks `FConfigCacheIni::GetString` (0x140407720) and answers the Outpost endpoint sections with the chosen backend, in memory. Engine.ini is never touched. `OverrideEndpoints=0` turns it off. |
| Button and list | D3D11 overlay drawn from the inner `Present` hook (0x14073B930), GDI text, window subclassed for the mouse. Shown only when the loaded map is `MainMenu*` (read from the `LoadMap: %s` log line). |
| Server list | WinHTTP `GET http://<backend>/servers`, refreshed every 3 s while the panel is open. Offline lobbies and started lobbies with no late-join are greyed. |
| Token | The game's access token is taken from the argument of the matchmaking WebSocket connect (0x140E17F90). REST goes through a statically linked libcurl, so WinInet hooks never see it. |
| Join | `POST /api/servers/<id>/join-hint` with the token (backend commit `cdf5b02`, cherry-picked as `86e2739`), then the mod runs the PLAY button's Blueprint click handler (`FrontendActionBar_C` `BndEvt__Play Button_..._OnClicked`) through a `ProcessEvent` hook (0x1405364C0). The backend's pool seats the player in the picked lobby. A backend without the route answers 404 and the player gets the normal pool pick. |
| Other backend | A server that lives on a different backend writes `Backend=` into the ini and asks for a restart. |
| Vote to start | Button in the panel: `POST /api/session/<id>/vote-start` with the token. |

Notes from testing (details in `docs/client-mod-play-trigger.md`):
- Two `FrontendActionBar_C` instances exist. The older one is not usable: calling it crashes the game (null object in the Blueprint VM). The mod uses the newest.
- Press START first: the PLAY button only exists on the second menu screen. If it is missing the mod waits up to 60 s for it.
- `In Queue` and `Please Wait State RefCount` could not be read (property layout guess was wrong, logged as -1); the Blueprint's own guard applies.

## Verified

Local backend on port 7790 (two fake lobbies), game started from a hard-linked copy of the install with the DLL added, in a window:
- SERVERS button on the main menu: `docs/client-mod-servers-button.png`.
- The list shows both lobbies. A click selects one, the join-hint returns 200, PLAY runs, and the backend logs `picked hosted session ...` then `now has 1 player(s)`. The list then shows 1/16 for that lobby: `docs/client-mod-server-list.png`.
- Vote to start: `POST .../vote-start -> 200`, `voted to start ... (1/1)`.
- Endpoint override and token capture: `docs/client-mod-test-run.log`.
- Not verified: the game connecting to the lobby's UDP game host after `session-started` (no game host ran in this test), an https backend (the override writes `http://` and `StreamSSL=False`), and a real controller through the proxy.

## Unreleased cosmetics (optional)

`UnlockUnreleasedCosmetics=1` in `sos_client.ini` (default on) hooks the game's cosmetic availability check (RVA 0x166970) and reports the Ronin set (`CA_MaleRonin_*`, 8 parts) and `CA_MaleCynic_FacialHair_A` as available by temporarily treating them as released. It matches those asset names only; everything else goes through the original check. Set it to 0 to turn it off.

- Verified: the Ronin row appears in the Harness slot of the topknot character and can be equipped: `docs/client-mod-ronin-listed.png`, `docs/client-mod-ronin-equipped.png`. These assets are unfinished (placeholder "P" icon), so the model shows no visible Ronin mesh.
- Not done on purpose: paid-DLC ownership (Founders items) is not faked.

## How Steam launches the game

- Steam's `appinfo.vdf` for app 802240 has one launch option: `SOS\Binaries\Win64\SOS-Win64-Shipping.exe`. `SOS_BE.exe` and `BattlEye\` ship in `Win64` but are never started.
- No BattlEye bypass is part of this design. If a future build routes Play through BattlEye, stop and ask.
- Steam sets `SteamAppId` itself, so no `steam_appid.txt` is needed.

## Server list API (backend)

`GET http://<backend>/servers` returns `{"servers":[...]}`. It needs no auth and sends `Access-Control-Allow-Origin: *`. Each entry looks like this:

```json
{"id":"<session uuid>","game":"classic","name":"OG SOS server","region":"EU","online":true,
 "players":1,"minPlayers":2,"maxPlayers":16,"state":"waiting","map":"",
 "address":"203.0.113.10:7777","backend":"203.0.113.10:7781","lastSeenSec":3}
```

- `backend` is what the mod switches the game to: REST at `http://<backend>`, matchmaking WS at the same host and port with path `/ws`.
- `address` is the game (UDP) address. The backend hands it to players in `session-started`, so the mod does not use it directly.
- `state` is `waiting`, `countdown` or `started`. `online` means the game host has polled within the last 20 s.
- `?local=1` returns only that backend's own servers. Without it, a backend also lists its peers from `OGSOS_DIRECTORY`.
- The mod needs one directory backend URL to start from. Ship it in the mod's ini, and let the player add more.

See docs/CLASSIC.md ("Public server list") for the server side and `POST /api/session/<id>/announce`.

## Hook points


Target: SOS-Win64-Shipping.exe, Steam app 802240, UE 4.12.5, image base 0x140000000 (RVA = VA - 0x140000000).
Method: Ghidra decompile (read-only). Names like `FUN_xxx` are Ghidra auto-names; role names are mine.
Confidence: **C** = confirmed by decompile, **I** = inferred (pattern/callers, not fully traced), **?** = unverified.
Not runtime-tested.

Conventions: `FString` = { TCHAR* Data (+0); int32 Num (+8, includes the terminating NUL; 0 when empty); int32 Max (+0xC) }. FMemory::Free = FUN_1403ACC40, FMemory::Malloc = FUN_14121B950(size) (both **I**). x64 MS ABI.

## 0. Summary

| Need | Hook | VA | Conf |
|---|---|---|---|
| Rewrite every REST URL, live, per request | `FHttpRequestWinInet::SetURL` (vtable slot 10) | **0x140AA8FE0** (slot addr 0x1421DFD28) | C |
| Rewrite WS host/port/ssl/path at each connect, live | OutpostWebSocket connect wrapper | **0x140E17F90** | C |
| Rewrite endpoints once at startup | `FConfigCacheIni::GetString` | **0x140407720** | C |
| Re-run login after switching | `FOnlineIdentityOutpost::Login` | 0x141A4F750 | C (role) / I (call details) |
| Overlay drawing (D3D11) | inner `IDXGISwapChain::Present` wrapper | 0x14073B930 (outer FD3D11Viewport::Present 0x14073B7C0) | C |

## 1. Config reads

All reads use `FConfigCacheIni` on the global config (GConfig pointer in `DAT_1429F7598`, GEngineIni FString in `DAT_142A038A0`), with UTF-16 section/key literals.

| Function | VA | Signature | Conf |
|---|---|---|---|
| GetString | **0x140407720** | `bool (FConfigCacheIni* cfg, const TCHAR* section, const TCHAR* key, FString* out, const FString* filename)` | C |
| GetInt | 0x140405050 | `bool (cfg, section, key, int32* out, const FString* filename)` | C (usage) |
| GetBool | 0x140404240 | `bool (cfg, section, key, bool* out, filename)` | C (usage) |
| GetFloat/Double | 0x140404C80 | `(cfg, section, key, double/float* out, filename)` | I |
| Endpoint normalizer | 0x140E13980 | `FString* (FString* out, const FString* in)`; token expansion from the `WebServicesConfig` object (token map at obj+0x28, e.g. `WebServicesEnv`); runs on every Endpoint value right after GetString | C (call), I (token semantics) |

### Per-key readers (all read ONCE at module/subsystem construction unless noted)

| Section / Key | Reader | Invoked from | Stored at | When | Conf |
|---|---|---|---|---|---|
| `[OutpostIdentity] Endpoint` | 0x141A111A0 | module vtable 0x142602450 slot 1 (StartupModule) | module obj `+0x8` FString (Num +0x10, Max +0x14) | module load, once | C / I |
| `[OutpostAppPersistence] Endpoint` | 0x1419DCE90 | module vtable 0x1425EDF60 slot 1 | obj `+0x8` | once | C / I |
| `[OutpostLeaderboards] Endpoint` | 0x1419EBB00 | module vtable 0x1425F4710 slot 1 | obj `+0x8` | once | C / I |
| `[OutpostLogReceiver] Endpoint` | 0x1419F47C0 | module vtable 0x1425F6F18 slot 1 | obj `+0x80` (Num +0x88) | once | C / I |
| `[OutpostKeyValueStore] EndpointServer` | 0x1419F0590 (arg = obj+8) | KV load path | arg+0x18 | every time this function runs (it is the KV "LoadingKeyValueStoreBegin" routine, also resets cached KV state) | C |
| `[OutpostKeyValueStore] EndpointClient` | same | same | arg+0x8 (FString) | same | C |
| `[OutpostKeyValueStore] EndpointClientFallback` | same (only if primary load failed) | same | overwrites EndpointClient FString | same | C |
| `[OutpostMatchmakingClient] MatchmakingEndpoint` | 0x140E1B0E0 (ctor of FOutpostMatchmakingClient) | 0x141A3F530 (matchmaking interface ctor) from FOnlineSubsystemOutpost::Init 0x141A4C580 | client `+0x348` FString | **once** | C |
| `MatchmakingPort` | same | same | client `+0x358` int32 | once | C |
| `MatchmakingSSL` | same | same | client `+0x35C` bool | once | C |
| `MatchmakingPath` | same | same | client `+0x360` FString | once | C |
| `MatchmakingApi` | 0x140E23190 | on demand | returned FString | **per call** | C |
| `MatchmakingPingInterval/MaxMissedPingCount/MaxConnectFailed/MaxConnectInterval/IssueTimeout/CancelTimeout` | 0x140E1B0E0 | | client +0x3B0/+0x39C/+0x3C0/+0x3C8/+0x3D0/+0x3D8 | once | C |
| `[OutpostIAP]`, `[OutpostStorefront]` | no strings, no code in Classic | | | | C |
| extras: `EmbedEndpoint` (0x1419E7350), `StreamEndpoint` (0x1419DD800) | | | | module load | C |
| `[WebServicesConfig] HeroAppId`, `WebServicesEnv` | 0x140E140C0 | | obj +0x8 / +0x18; token map +0x28 | once | C |

Matchmaking client fields (relative to the object that 0x140E1B0E0 receives; it is embedded in the interface at +0x330):

| Off | Field | Conf |
|---|---|---|
| +0x318 | pending operations count | I |
| +0x340 | state: 0 connecting, 1 connected/waiting ready, 2 ready, 3 failed/closed, 4 backoff-wait | I |
| +0x348/+0x350/+0x354 | Endpoint FString | C |
| +0x358 | Port int32 | C |
| +0x35C | SSL bool | C |
| +0x360/+0x368/+0x36C | Path FString | C |
| +0x378 | next retry time | C |
| +0x380 | consecutive fail count | C |
| +0x440 | WS wrapper pointer (0 = none) | C |

Takeaways: hooking GetString changes every service before first use without editing Engine.ini, but it is not live. Writing the stored FStrings live needs FMemory-allocated buffers (owners free them); prefer the URL/WS hooks.

## 2. HTTP path (stock UE 4.12 WinInet, `HttpWinInet.cpp`)

| Item | VA | Detail | Conf |
|---|---|---|---|
| `FHttpModule::CreateRequest(this, TSharedRef* out)` | **0x140A9DC30** | default branch (`DAT_142986f60 == 0`, module byte `this+0x35 == 0`): allocs 0x220 bytes and runs the FHttpRequestWinInet ctor. Other branches: `this+0x35 != 0` -> 0x130-byte object, vtable 0x1421DFC20 (likely disabled/null stub); `DAT_142986f60 != 0` -> 0x160-byte object, vtable 0x1421DFAE0 via 0x140A9C130 (unknown alternate backend) | C / ? |
| FHttpRequestWinInet ctor | 0x140A9C3C0 | writes vtable 0x1421DFCD8 | C |
| Vtable | **0x1421DFCD8** | 0 GetURL 0x140187F90, 1 0x140AA2B80 (GetURLParameter, I), 2-7 0x140AA21A0 / 0x140AA0D20 / 0x140AA1D40 / 0x140AA1C20 / 0x140AA19E0 / 0x140A9CE30 (I), 8 GetVerb 0x140AA2E40, 9 SetVerb 0x140AA9250, **10 SetURL 0x140AA8FE0**, 11 0x140AA8870, 12 0x140AA8B40, 13 0x140AA8F80, 14 0x140A9D320, **15 ProcessRequest 0x140AA5F70** | C for 0, 8, 9, 10, 15; I others |
| **SetURL** | **0x140AA8FE0** | `void (FHttpRequestWinInet* this, const FString* URL)`. Copies the FString into `this+0x18` (Data +0x18, Num +0x20, Max +0x24), then calls 0x140A9D820 which clears the cracked URL_COMPONENTS (`this+0x30..`) so the next send re-cracks. The arg is only read (copy), so a hook can pass its own FString on stack/own buffer. | C |
| ProcessRequest | 0x140AA5F70 | fails if URL empty; cracks (0x140A9D8C0) if `this+0x28 == 0`; scheme check; queues then calls StartRequest | C |
| StartRequest | **0x140AAA300** | `bool (this)`. Closes old handles (`+0x1F8`, `+0x200`), then InternetConnectW (host from cracked URL, port WORD at `this+0x54`) then HttpOpenRequestW + HttpSendRequestW. **New InternetConnect per request, no pooling**. | C |
| URL cracker | 0x140A9D8C0 | `InternetCrackUrlW`, lazy | C |
| URL_COMPONENTS in request | base `this+0x30`, nScheme `+0x44`, port `+0x54` | | I |
| SSL flag | open flags `0x84400100`, `|0x00800000` (INTERNET_FLAG_SECURE) when `*(int*)(this+0x44) == 4` | | C (flag) / I (4 = https here) |
| Import IAT slots | InternetConnectW 0x141F21DD0 (only caller 0x140AAA300), HttpOpenRequestW 0x141F21DA0 (0x140AAA300), InternetCrackUrlW 0x141F21DE8 (0x140A9D8C0), InternetOpenW 0x141F21DE0 (0x140AA3280) | | C |

Outpost REST calls format `"%s/api/..."` from the module's stored Endpoint on every call (e.g. identity 0x141A0E360, 0x141A0E9C0, 0x141A0EB50), create the request via helper 0x140E15030 and SetURL. No URL is cached across requests.

### Recommended single hook: SetURL (0x140AA8FE0)
- `void __fastcall SetURL(void* this, const FString* url)`; FString = `{ wchar_t* Data; int32 Num; int32 Max; }`, Num counts the NUL.
- If `url->Data` starts with the old backend prefix (`scheme://host[:port]`), build a new FString on the hook's own buffer with the new scheme/host/port plus the unchanged path, call the original with it.
- Sees all REST traffic (Identity, AppPersistence, Leaderboards, LogReceiver, KeyValueStore, Embed, Streams), per request, so live switching works; no allocator needed.
- Install by patching the vtable slot at 0x1421DFD28 (.rdata, VirtualProtect) or inline detour (normal cookie prologue, any 14-byte detour is fine).
- Caveat: covers only the WinInet request class. Verify at runtime that a request object's vtable == 0x1421DFCD8 (+ base delta).
- Fallback: IAT-hook `InternetConnectW` (host arg 2, port arg 3) plus `HttpOpenRequestW` (flags arg 7 for INTERNET_FLAG_SECURE if scheme changes).
- After a switch, cached access tokens are for the old backend: re-login (section 4).

## 3. Matchmaking WebSocket path (libwebsockets 1.4 statically linked, wrapper `OutpostWebSocket.cpp`, FOutpostWebSocket size 0x160)

| Item | VA | Detail | Conf |
|---|---|---|---|
| Subprotocol literal `"wss,ws"` | string 0x1422BB9F4 | used as the lws protocol name in the protocols array, in 0x140E181A0 | C |
| `lws_create_context` | 0x141AB03F0 | `longlong (lws_context_creation_info*)` | C |
| WS ctx init | 0x140E181A0 | `void (FOutpostWebSocket* this)`; lazy-creates context (`this+0x140`), protocols at `this+0x150`, protocol callback 0x140E19020 | C |
| WS ctor / dtor | 0x140E17C10 / 0x140E17D50 | | C |
| **WS connect wrapper** | **0x140E17F90** | `bool (FOutpostWebSocket* this, const char* host, uint16 port, const char* path, const char* arg5, int32 ssl)`; copies host to `this+0x10`, path `+0x30`, arg5 `+0x50` (std::string), then calls lws client connect (below) with address=host, port, ssl, path, Host=host, Origin=host, protocol="wss,ws", ietf=-1, user=this; result handle stored at `this+0x148` | C |
| lws client connect | 0x141AB1E30 | 10-arg call shape matches `libwebsocket_client_connect(context, address, port, ssl, path, host, origin, protocol, ietf, userdata)`; Ghidra shows a bad signature for it | C (shape) / I (name) |
| lws write (used by FUN_140E182B0) | 0x141AB0D30 | | I |
| lws client handshake | 0x141AB5BB0 / 0x141AB5890 | | C |
| Matchmaking connect | **0x140E1F0E0** | `void (FOutpostMatchmakingClient* this)`. Returns if `this+0x440` exists. Else allocs wrapper (0x140E17C10), sets callbacks (message 0x140E290B0, open 0x140E1F860, error 0x140E22450) and calls 0x140E17F90 with host `this+0x348`, port `this+0x358`, ssl `this+0x35C`, path `this+0x360` (converted TCHAR to UTF-8). On immediate failure calls 0x140E1F6B0 and sets state 3. | C |
| State machine tick | 0x140E2E3A0 | state 3 -> 0x140E21F70 (deletes wrapper, `+0x440 = 0`, state 4). State 4 and time >= `+0x378` and (`+0x318 > 0` or `+0x3E0 > 0`) -> 0x140E1F0E0 again | C |
| Fail/backoff | 0x140E1F6B0 | `+0x380++`, delay = random * 2^(n-1); at `>= MaxConnectFailed (+0x3C0)` with pending ops, cancels them | C |

Answers:
- Combination: host/port/ssl/path are **not** merged into a URL; they are separate args to lws (host also becomes Host/Origin header).
- Reconnect: **yes**, automatic with exponential backoff, and each reconnect **re-reads host/port/ssl/path from the client object (+0x348/+0x358/+0x35C/+0x360), not from config** (config only at construction).
- Best hook: **0x140E17F90**: replace `host` (UTF-8 char*), `port`, `ssl`, optionally `path`; the original copies the strings. It is also called from 0x1419DFA70 (Embed WS) and 0x141A43130 (another Outpost WS client), so filter by current host/caller if only matchmaking should change.
- Live switch for matchmaking: capture `this` by hooking 0x140E2E3A0 or 0x140E1F0E0, set state `+0x340` to 3 (or call 0x140E21F70) to drop the socket; reconnect then happens by itself only if there are pending ops. Otherwise reset state to 4 with `+0x378` in the past and call 0x140E1F0E0 directly (I).
- ssl: the bool at +0x35C is passed as the lws `ssl_connection` int unchanged (C). TLS verification behaviour of the bundled lws: not examined.

## 4. Online subsystem / identity

| Item | VA | Detail | Conf |
|---|---|---|---|
| `FOnlineSubsystemOutpost::Init` | 0x141A4C580 | creates Identity (ctor 0x141A3F1E0, ptr at subsystem+0x218), Matchmaking interface (0x141A3F530, +0x288) and others, once at OSS creation | C (calls) / I (role name) |
| `FOnlineIdentityOutpost::Login` | **0x141A4F750** | `bool (FOnlineIdentityOutpost* this, int32 LocalUserNum, const FOnlineAccountCredentials* creds)` (vtable data ref 0x14261F5D8). Logs "Registration already pending for user %d"; dispatches on credential type `Auto`, `OutpostUser`, `OutpostOnceCodeUser`, Steam; module object at `this+0x3A0` (`param_1[0x74]`), Steam module at `+0x3A8` | C / I |
| Steam token callback | 0x141A53EC0 | `OnGetSteamSessionAuthToken(this, bool ok, ...)`, then `LoginWithProvider("steam")` | C |
| LoginWithProvider | 0x141A0E9C0 | POST `<Endpoint>/api/access-token/<provider>` | C |
| OutpostUser login | 0x141A0E360 / 0x141A0EB50 (`%s/api/access-token`) | | C |
| once-code | 0x141A0E690 | | C |
| GrantApp | 0x141A201F0 | | C |
| Account JSON | 0x141A107C0 (id, created, updated, display-name, access-token) | | C |

- Login is **not** one-shot at module load: it is an async request started when the Blueprint login flow calls the identity interface, and it can be started again whenever no registration is pending for that LocalUserNum.
- Re-running login: call `Login(identity, 0, creds)` (identity pointer from subsystem+0x218), or send the player back through the Blueprint login level (`/Game/Maps/MainMenu2` flow) so LoginUI re-executes. Creds layout/type not traced (needs runtime test).
- The Identity module endpoint (`module+0x8`) is read once; with the SetURL hook the new host applies on the next request.

## 5. Main menu UI / Present

| Item | VA / name | Conf |
|---|---|---|
| Native game instance | `UShooterGameInstance` (`/Script/ShooterGame.ShooterGameInstance`, `SOS\Source\ShooterGame\Private\ShooterGameInstance.cpp`); UFunction names `RequestMainMenu` (0x141F96690), `K2_ReturnToMainMenu` (0x141F94328), `GetFrontendMaps`; main menu map `/Game/Maps/MainMenu2` (0x14201E160), key `MainMenuMap` | C |
| FrontendHUD | **no native symbol or string** in the exe: it and its widgets are cooked Blueprint. No native main-menu function to patch; use `ProcessEvent`/UFunction hooks or a separate overlay | C (absence) |
| `FD3D11Viewport::Present` | **0x14073B7C0** `uint64 (FD3D11Viewport*, bool bLockToVsync)`: fullscreen/DWM handling, then calls inner present | C |
| Inner present | **0x14073B930** `char (FD3D11Viewport*, uint syncInterval)`: calls `IDXGISwapChain::Present` via `*(this+0x60)` vtable +0x40 (slot 8), flags 0; on device-removed codes sets flag at device+0x24F8 | C |
| DWM-timing path | 0x14073B9E0 | C |
| Caller | 0x140742FB0 (EndDrawingViewport) | I |
| Viewport fields | swapchain `+0x60`, HWND `+0x40`, bFullscreen `+0x54` | C |
| RHI | D3D11RHI source files and Vulkan/D3D12 strings both present; assume D3D11 default | I |

For an overlay, detour 0x14073B930 (gets the swap chain at `this+0x60`, avoids the fullscreen/DWM branches) or hook the swap chain vtable Present.

## 6. Recommended hook plan

Install from the version.dll proxy once the main module is mapped; rebase all VAs by (actual base - 0x140000000).

1. **Startup pick:** detour `GetString` (0x140407720). For sections `OutpostIdentity|OutpostAppPersistence|OutpostLeaderboards|OutpostLogReceiver|OutpostKeyValueStore|OutpostMatchmakingClient` return the selected server's values (Endpoint, EndpointClient, EndpointServer, MatchmakingEndpoint/Port/SSL/Path). Must be known before module start.
2. **Live switch (in-game list):**
   - REST: SetURL (0x140AA8FE0) rewrite of scheme/host/port, effective on the next request.
   - WS: detour 0x140E17F90 for host/port/ssl/path; capture the matchmaking client `this` via 0x140E2E3A0 and drop the socket (state 3 / 0x140E21F70) to force a reconnect.
   - Re-login: `FOnlineIdentityOutpost::Login` 0x141A4F750 or the Blueprint login flow.
3. **UI:** overlay through 0x14073B930; no native main-menu code to hook.

## 7. Risks and open points

- Two alternate HTTP request classes exist behind `CreateRequest` (vtables 0x1421DFC20, 0x1421DFAE0); not identified. If requests bypass SetURL 0x140AA8FE0, hook CreateRequest (0x140A9DC30) and patch the returned object's slot 10.
- Endpoints are baked in at module/OSS construction; only the URL/WS hooks make switching live.
- Endpoint strings pass through the WebServicesConfig token expander (0x140E13980); SetURL sees expanded strings, GetString sees raw ones.
- Matchmaking reconnect only fires with pending ops; otherwise it stays disconnected until something requests matchmaking.
- TLS: WinInet uses system trust (a self-hosted https backend needs a trusted cert or WinInet security-flag hooks); bundled lws TLS behaviour not examined.
- CFG (`_guard_check_icall`) is compiled in: trampolines/inline detours are fine; a vtable-slot patch pointing to a function inside the loaded mod DLL is normally OK.
- All VAs are for this Steam build (jenkins job `sosclassic-cook-prod`). Pattern-scan anchors: `HttpWinInet.cpp` log strings in 0x140AAA300; `"wss,ws"` (xref 0x140E181A0); `"Missing MatchmakingEndpoint= in [%s] of DefaultEngine.ini"` (xref 0x140E1B0E0); `"Registration already pending for user %d"` (xref 0x141A4F750).

## 8. Address index

```
GetString 0x140407720  GetInt 0x140405050  GetBool 0x140404240  GetDouble 0x140404C80
Endpoint normalizer 0x140E13980  WebServicesConfig init 0x140E140C0
GConfig 0x1429F7598  GEngineIni FString 0x142A038A0
CreateRequest 0x140A9DC30  FHttpRequestWinInet ctor 0x140A9C3C0  vtable 0x1421DFCD8
  SetURL 0x140AA8FE0 (slot addr 0x1421DFD28)  ProcessRequest 0x140AA5F70  StartRequest 0x140AAA300
  crack 0x140A9D8C0  crack-reset 0x140A9D820
  IAT InternetConnectW 0x141F21DD0  HttpOpenRequestW 0x141F21DA0  InternetCrackUrlW 0x141F21DE8  InternetOpenW 0x141F21DE0
Identity endpoint reader 0x141A111A0  Login 0x141A4F750  LoginWithProvider 0x141A0E9C0  Steam cb 0x141A53EC0  OSS Init 0x141A4C580
Matchmaking ctor/config 0x140E1B0E0  Connect 0x140E1F0E0  tick 0x140E2E3A0  drop socket 0x140E21F70  backoff 0x140E1F6B0
WS wrapper connect 0x140E17F90  ctx init 0x140E181A0  lws_create_context 0x141AB03F0  lws connect 0x141AB1E30  "wss,ws" 0x1422BB9F4
D3D11 Viewport::Present 0x14073B7C0  inner Present 0x14073B930 (swapchain at viewport+0x60)
```
