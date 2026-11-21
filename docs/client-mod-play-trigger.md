# Starting matchmaking from the client mod (what PLAY does)

Static RE only (Ghidra read-only on the `SOS-Classic` project, `tools/kismet_dis.py` on the cooked Blueprints from the pak). Nothing here has been run in the game.
Target: SOS-Win64-Shipping.exe (Classic, UE 4.12.5, image base 0x140000000; rebase every VA by `actual_base - 0x140000000`).
Tags: **C** = confirmed by decompile or bytecode, **I** = inferred.

## 1. What the PLAY button does (Blueprint chain)

The main-menu PLAY is the `Play Button` (text `PLAY`, or `PLEASE WAIT` while disabled) inside the widget **`FrontendActionBar`** (`/Game/Blueprints/UI/Frontend/MainMenu/FrontendActionBar`, generated class `FrontendActionBar_C`), a child named `ActionBar` of `FrontendHUD`. SOLO / DUO / CUSTOM only select `Matchmaking Mode` (byte: 0 = solo, 1 = duo, 2 = custom, C from the switch below); PLAY is what queues. (The HUD's `TitleUI` buttons are unrelated: its `OnPlayButtonClicked` handler only calls `Show Leaderboards Screen`.)

Chain (offsets are in-memory bytecode offsets of the ubergraph `ExecuteUbergraph_FrontendActionBar`; every event stub is just `ExecuteUbergraph_...(entry)` and the entry is a `jump`):

| Step | Blueprint element | Disassembly (kismet_dis.py) | Conf |
|---|---|---|---|
| 1 | `BndEvt__Play Button_K2Node_ComponentBoundEvent_1007_OnClicked__DelegateSignature` (UButton OnClicked) | stub: `ExecuteUbergraph_FrontendActionBar(22116)`; `0x5664: jump 0x51db` | C |
| 2 | `0x51db: Queue for Match()` | calls the custom event `Queue for Match` (no params), stub: `ExecuteUbergraph_FrontendActionBar(21172)`; `0x52b4: jump 0x52a5` | C |
| 3 | `0x52a5: if not (this.In Queue) jump 0x5291` | guard: nothing happens when already queued | C |
| 4 | `0x5291: Set Queued(true)` then `jump 0x3ccc` | `Set Queued` sets `In Queue`, refreshes UI, `QueuedButton->Start Timer()` | C |
| 5 | `0x3ccc..0x3d45`: switch on `this.Matchmaking Mode` | mode 0 -> `0x1ecc`, mode 1 (duo) -> `0x1d8b`, mode 2 -> nothing here | C |
| 6 | `0x1ecc` (solo) | see below | C |
| 7 | `0x17e5..0x18e2` | bind `OnSuccess_ADC1...`, `OnFailure_ADC1...`, `OnAssigned_ADC1...` on the returned proxy, then `->Activate()` | C |

Step 6, the solo branch:

```
01ecc: L.CallFunc_GetOwningPlayer_ReturnValue6 = GetOwningPlayer()
01ee0: ... = obj:Default__ShooterGameUserSettings->GetShooterGameUserSettings()
01f0a: ... = ...->GetLanguageUserSettings()
01f34: (L.K2Node_MakeStruct_FindSessionOptions).GameMode = ''
01f51: (L.K2Node_MakeStruct_FindSessionOptions).Map = ''
01f6e: (L.K2Node_MakeStruct_FindSessionOptions).Language = <LanguageUserSettings>->this.MatchmakingLanguage
01fa8: L.CallFunc_MatchmakingFindSession_ReturnValue = obj:Default__MatchmakingFindSessionCallbackProxy->MatchmakingFindSession(self, <PlayerController>, L.K2Node_MakeStruct_FindSessionOptions)
01fe5: jump 0x17e5
...
018e2: L.CallFunc_MatchmakingFindSession_ReturnValue->Activate()
```

Duo uses `MatchmakingFindGroupSession` with `GameMode='duo'` and a sanitized language (0x1e8a); custom uses create-session elsewhere.

**First native UFunction: `MatchmakingFindSession`**, a static BlueprintCallable factory on class `UMatchmakingFindSessionCallbackProxy` (package `/Script/OnlineSubsystemUtils`, as registered by this game; CDO `Default__MatchmakingFindSessionCallbackProxy`). It returns the async-action proxy; `Activate()` (native UFunction on the proxy) then queues `FFindSessionOperation` in `FOutpostMatchmakingClient`, which sends the WebSocket `find-session` (see docs/MATCHMAKING.md; `opts.regions` and `opts.user-data` are filled natively, not by the Blueprint).

| Item | VA | Detail | Conf |
|---|---|---|---|
| Class StaticClass/Z_Construct | 0x140E7A170 | returns cached UClass* in `DAT_142B57D28`; registers `MatchmakingFindSession` in the class FuncMap (`class+0x108`) | C |
| Class registration | 0x1400D38D0 | `UMatchmakingFindSessionCallbackProxy` | C |
| Static UFunction construct | 0x140E91180 | UFunction cache `DAT_142B57D20`; params in order: `ReturnValue` (object prop, offset 0x40), `Options` (struct prop, offset 0x10), `PlayerController` (offset 8), `WorldContextObject` (offset 0) | C |
| Native registration | 0x140E71440 | `AddNativeFunction(pkg, "MatchmakingFindSession", 0x140E9DD80)` | C |
| **Exec thunk `execMatchmakingFindSession`** | **0x140E9DD80** | `void (UObject* Context, FFrame* Stack, void* Result)`; reads WorldContextObject, PlayerController, then the Options struct (0x30 bytes, 3 FStrings, I) from the stack, calls the impl, writes `*Result` | C |
| **Impl** | **0x140E56220** | `UMatchmakingFindSessionCallbackProxy* (UObject* WorldContext, APlayerController* PC, const FFindSessionOptions* Opts)`: `StaticConstructObject` of the proxy class, vtable slot +0x1E8 (`this, WorldContext, PC`), copies `*Opts` to `proxy+0x168` | C |
| `Activate` natives | 0x140E98BE0 / 0x140E98CA0 (registered at 0x140E71470 / 0x140E714F0, one per proxy class; the FindSession one is not pinned down) | exec thunks | I |

## 2. Candidate trigger points (ranked)

### (a) Recommended: `ProcessEvent` on `FrontendActionBar_C` instance, UFunction `Queue for Match`

This is exactly the PLAY click minus the mouse. Everything that PLAY does happens (button label, queue timer, delegates bound, cancel works from the UI, `Set Queued`), because it is the same Blueprint code.

| Need | Value |
|---|---|
| Object | the one non-CDO instance of class `FrontendActionBar_C` (exists while the main menu is up; `FrontendHUD.ActionBar`) |
| UFunction | name `Queue for Match` (FName with spaces), no parameters, no return. Found with `FindFunctionByName(cls, FName("Queue for Match"), true)` |
| Equivalent alternative | UFunction `BndEvt__Play Button_K2Node_ComponentBoundEvent_1007_OnClicked__DelegateSignature` (the literal click handler; same effect) |
| Call | `ProcessEvent(actionBar, fn, buf)` with `buf` any 16 zeroed bytes (ParmsSize is 0) |
| Thread | **game thread only.** Do not call from the D3D `Present` hook (render thread). Run it from a `ProcessEvent` detour (see below) |

Preconditions to check first (all on the ActionBar instance, properties found by name via the class `Children` chain):

| Property | Meaning | Required |
|---|---|---|
| `In Queue` (bool) | already searching | false (the event is a no-op otherwise) |
| `Matchmaking Mode` (byte) | 0 solo, 1 duo, 2 custom | 0. If not 0, `Force Solo Mode` (UFunction, no params, entry 20733 -> `0x3c84`) resets it, or the player picks SOLO |
| `Please Wait State RefCount` (int) | `Increment/Decrement Please Wait State RefCount`: PLAY is disabled ("PLEASE WAIT") while it is > 0. `FrontendHUD.OnLoginComplete` calls `ActionBar.Login Complete()` then `Decrement` | 0 |
| `MatchmakingEnabled` (bool) | set by `FrontendHUD.UpdateTestServerAvailable` (needs KV `UE_CLIENT_TEST_SERVER_ENABLED` or role `testserver`, see docs/CLASSIC.md) | true |

Note: `Queue for Match` itself only checks `In Queue`, so it would also start a search while PLAY is greyed out. Gate on the table above so it behaves like a real click.

Native facts the mod needs (all VAs for this build):

| Fact | Value | Conf |
|---|---|---|
| `UObject::ProcessEvent(UObject* this, UFunction* fn, void* parms)` | **0x1405364C0**, UObject vtable slot 53 (offset 0x1A8). Same slot value in two different class vtables (0x141FC3FF0 property class, 0x141FC5C38 delegate property class), and BP event wrappers call `(**(vtbl+0x1A8))(this, FindFunction(name), &params)` (e.g. 0x140218EE0). The body (FUNC_Native 0x400 test at `fn+0x88`, `ParmsSize` ushort at `fn+0x90`, Script TArray at `fn+0x48`, locals memcpy'd from `parms`) matches UE 4.12 ProcessEvent | C |
| `StaticFindObject(UClass* cls, UObject* outer, const TCHAR* name, bool exactClass)` | **0x14054DAD0** (thunk at 0x14054DD30); `outer == (UObject*)-1` means ANY_PACKAGE | C |
| `StaticFindObjectFast(cls, outer, FName, bool exact, bool anyPackage, EObjectFlags, EInternalObjectFlags)` | 0x14054DD40 | C |
| FName ctor `FName::FName(FName* out, const TCHAR* name, EFindName)` | **0x140472C50**; `EFindName`: 0 = Find, 1 = Add (callers pass 1). ANSI variant `(FName* out, const char*, EFindName)` at 0x140472BD0. FName = {int32 ComparisonIndex; int32 Number}, 8 bytes, passed by value in a register | C (layout, signatures), I (enum meaning) |
| `UClass::FindFunctionByName(UClass* cls, FName name, bool bIncludeSuper)` | **0x1404E97D0** (TMap lookup in `class+0x108`, recurses into `SuperStruct` at `+0x30`; returns UFunction* or 0). Wrapper `UObject::FindFunctionChecked(UObject*, FName)` at 0x1405334C0 (logs "Failed to find function %s in %s" when missing) | C |
| GUObjectArray | element array pointer at **0x142A93900**, `NumElements` int32 at **0x142A9390C**, element = `FUObjectItem` of **0x10 bytes**: `{UObjectBase* Object (+0); int32 Flags (+8); int32 (+0xC)}`; `Flags & 0x20000000` = PendingKill (ProcessEvent tests it). The `FUObjectArray` base is therefore ~0x142A938F0 (the fixed array starts at +0x10; `MaxElements` at 0x142A93908) | C (array ptr, num, element size, PendingKill bit), I (struct base) |
| UObject layout | `vtable +0x00; ObjectFlags +0x08; InternalIndex +0x0C; ClassPrivate +0x10; NamePrivate (FName) +0x18; OuterPrivate +0x20` (sizeof 0x28) | C for +0x0C and +0x10 (ProcessEvent, `FindFunction` use them), I for +0x18 and +0x20 (stock 4.12; UField::Next is at +0x28, which fits) |
| UField / UStruct / UFunction | `UField::Next +0x28`; `UStruct::SuperStruct +0x30`, `Children +0x38` (the registration code at 0x140E7A170 links functions with exactly these offsets), `PropertyLink +0x68`, Script TArray `+0x48`; `UFunction::FunctionFlags +0x88`, `ParmsSize +0x90`, `ReturnValueOffset +0x92` | C |
| UProperty | `ArrayDim +0x30`, `ElementSize +0x34`, `PropertyFlags +0x38`, `Offset_Internal +0x50` (read in ProcessEvent), `PropertyLinkNext +0x68`. `UBoolProperty` extras (`FieldSize/ByteOffset/ByteMask/FieldMask`) follow at +0x78 | C (up to +0x68), I (+0x78) |
| Game thread id | `GGameThreadId` = DWORD at 0x142A035FC (written once at startup in 0x140135D20, compared with `GetCurrentThreadId()` all over `StaticFindObject`) | I |

How to find the instance: iterate `GUObjectArray` (index 0..NumElements-1, skip null and PendingKill), take `obj->ClassPrivate`, compare its FName with `FName("FrontendActionBar_C", Find)` (Number 0), and skip the CDO (object name starts with `Default__`) and skeleton/reinstanced classes (`SKEL_`, `REINST_`). There is exactly one live widget instance on the main menu level; re-scan when it is gone (level change recreates it). Cache the UFunction pointer from the class, not the instance.
Alternative without scanning: `StaticFindObject(NULL, ANY_PACKAGE, L"FrontendActionBar_C", false)` returns the class (not the instance); instance lookup still needs the scan.

**Where to run it (game thread):** detour `ProcessEvent` (0x1405364C0) with a standard 14-byte inline detour. In the detour: if `this`'s class FName matches `FrontendActionBar_C` and not the CDO, remember it; if a "start search" flag is set and `GetCurrentThreadId() == *GGameThreadId`, clear the flag and call the original ProcessEvent for `Queue for Match` on the remembered instance (plus the preconditions above). ProcessEvent is hit hundreds of times per frame on the game thread, so the flag fires within the same frame. The mod's own button callback (Present overlay or key press) only sets the flag.

### (b) Native: replicate the Blueprint's call (more work, UI desynced)

`proxy = 0x140E56220(worldCtx, playerController, &opts)` then `ProcessEvent(proxy, FindFunction(proxy->Class, "Activate"), null)`, with `opts` = three FStrings {GameMode "", Map "", Language = `GetShooterGameUserSettings()->GetLanguageUserSettings()->MatchmakingLanguage`} (field order I). This does send `find-session`, but it skips `Set Queued(true)`, the OnSuccess/OnFailure/OnAssigned bindings and the HUD state, so the menu would not show a search and Cancel would not work from the UI. Needs a world context object (any live UObject whose world is valid, e.g. the ActionBar widget) and the owning PlayerController (`FrontendActionBar.GetOwningPlayer()`, or the first `FrontendPlayerController_C`). Not recommended except as a fallback.

### (c) Others

| Option | Verdict |
|---|---|
| Console / exec command | none found: no exec function or console command covers matchmaking (`MatchmakingFindSession` is a plain static BlueprintCallable, not `UFUNCTION(Exec)`). | 
| Synthesize a mouse click / Slate input | works but fragile (needs window focus, layout, DPI). Prefer (a). |
| Call the UButton's `OnClicked.Broadcast()` | equals the handler UFunction in (a); no advantage. |

## 3. State detection

| State | Cheap way | Conf |
|---|---|---|
| Searching / in queue | `FrontendActionBar_C` property **`In Queue`** (bool, read via the property's `Offset_Internal` and the UBoolProperty mask). Set by `Set Queued(true/false)`; cleared on success/failure/cancel (`Cancel Matchmaking` event, `OnFailure_*` handlers). Edge alternative: watch ProcessEvent for the UFunction names `Set Queued`, `Cancel Matchmaking`, `Queue for Match` on the ActionBar | C (BP logic), I (reading a BP bool needs the mask layout) |
| Search started (native signal) | hook 0x140E56220 (`MatchmakingFindSession` impl): called once per PLAY; the matching cancel is the static `CancelMatchmaking` (string refs 0x140E70BA0 / 0x140E741B0, impl not pinned down) | C (the call), I (cancel) |
| Matchmaking socket / queue | `FOutpostMatchmakingClient`: state at `+0x340` (2 = ready), pending operation count at `+0x318` (docs/CLIENT_MOD.md section 1) | I |
| Logged in | **(1)** the ActionBar's `Please Wait State RefCount == 0` (PLAY enabled; the HUD decrements it in `OnLoginComplete`); **(2)** watch ProcessEvent for UFunction `Login Complete` on `FrontendActionBar_C` or `OnLoginComplete` on `FrontendHUD_C` and latch a flag; **(3)** call the static UFunction `OnlineIdentityBlueprintLibrary::IsLoggedIn(PlayerController)` (the BP uses it in `Show Login Screen`) via ProcessEvent on its CDO; **(4)** `FrontendHUD.Login` widget collapsed (visibility 1) after login | C (BP logic) |
| Main menu is the foreground screen | `FrontendHUD.FrontendState` byte: `Show Login Screen` sets 1, `Show Title Screen` sets 2 (enum asset `FrontendState`, 11 values); the ActionBar also has its own `FrontendState` | C for the two values, I for the rest |
| Matchmaking allowed | `MatchmakingEnabled` bool on the ActionBar (see CLASSIC.md "Test-server gate") | C |

## 4. Pseudocode for the mod

```
// install: detour 0x1405364C0 -> hkProcessEvent (game-thread only)
void hkProcessEvent(UObject* self, UFunction* fn, void* parms) {
    if (!bar && classNameIs(self, "FrontendActionBar_C") && !isCDO(self)) bar = self;
    origProcessEvent(self, fn, parms);                // do the normal call first
    if (g_wantPlay && bar && GetCurrentThreadId() == *GGameThreadId) {
        if (!readBool(bar, "In Queue") && readInt(bar, "Please Wait State RefCount") == 0
            && readBool(bar, "MatchmakingEnabled") && readByte(bar, "Matchmaking Mode") == 0) {
            g_wantPlay = false;
            static UFunction* q = FindFunctionByName(bar->Class, FName(L"Queue for Match", 0), true);  // 0x1404E97D0
            char dummy[16] = {0};
            origProcessEvent(bar, q, dummy);
        }
    }
}
```

## 5. Address index

```
ProcessEvent 0x1405364C0 (vtable slot 53 / +0x1A8)   StaticFindObject 0x14054DAD0   StaticFindObjectFast 0x14054DD40
FName ctor (wide) 0x140472C50   FName ctor (ANSI) 0x140472BD0   UClass::FindFunctionByName 0x1404E97D0   FindFunctionChecked 0x1405334C0
GUObjectArray: Objects 0x142A93900, Num 0x142A9390C (item 0x10 B), GGameThreadId 0x142A035FC
MatchmakingFindSession: exec 0x140E9DD80, impl 0x140E56220, UFunction construct 0x140E91180, class construct 0x140E7A170, registration 0x140E71440
BP: FrontendActionBar.uasset (ubergraph entries: Play click 22116, Queue for Match 21172, Force Solo Mode 20733, Cancel Matchmaking 20950)
```

Reproduce: `python -I tools/pak_list.py extract <pak> "Blueprints/UI/Frontend/MainMenu/Frontend" <dir>`, then `python -I tools/kismet_dis.py <dir>/.../FrontendActionBar.uasset dis`.
