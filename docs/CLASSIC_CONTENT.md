# SOS: Classic content: cosmetics, hidden content, and what can be unlocked

This was derived read-only from the Classic install (Steam app 802240, `SOS Test Server/SOS/Content/Paks/SOS-WindowsClient.pak`, 24,558 entries) and its exe, and compared with the BR install (app 619080). Only names, ids and notes are here, no game assets.

Tools: `tools/pak_list.py` (list and extract), Ghidra (project `SOS-Classic`), plus scratch readers for 4.12 cooked packages. In these packages an export entry is 72 bytes, a `StructProperty` tag carries a 16-byte guid, and a `GameplayTagContainer` is a count plus FNames. `tools/uasset_dump.py` does not parse these exports.

## TL;DR

- **Classic has its own cosmetics, and plenty of them.** There are 12 playable characters with 876 selectable outfit parts and 25 gestures. Nearly everything is unlocked for everyone already. Classic has **no inventory, store or licence system**: the BR `inventory.licenses` / `data/cosmetics.json` ids mean nothing to it.
- **What is locked, and by what:**

| Lock | Items | Who can unlock it |
|---|---|---|
| App role `alpha-beta` | 2 Alpha/Beta T-shirts × 12 characters | **Backend.** Done in commit "Classic: grant the alpha-beta app role" (`CLASSIC_COSMETIC_ROLES` in `server/server.js`, test `tools/classic_cosmetics_test.js`). |
| Steam DLC (numeric `Entitlement`) | 5 Founders Pack shirts × 12 characters, 6 gestures, gold/silver name plate | Client only: hook `IsEntitlementAvailable` / `IsDLCInstalled` in the client-mod DLL. The backend cannot answer a Steam DLC check. |
| `Status` not Released | Ronin set (8 parts, MaleWanderer) and 1 MaleCynic beard | Client only: the availability filter would need patching. These are unfinished items. |

- **Classic has none of the BR cosmetics.** All 20 BR outfit folders (`Characters/Character_Outfits/*`, 794 files) are absent from the Classic pak.
- Porting them is technically possible: same engine 4.12.5, same pak v3, same skeleton paths. It is still a large tooling project. See "Porting BR cosmetics", which recommends a one-outfit proof of concept first, only with the lead's OK.

## How Classic decides what a player can wear

Each outfit part is a Blueprint subclass of native `OutfitCustomizationAsset`, named `CA_*` (892 files). Its class default object holds the fields below, inherited down the Blueprint parent chain:

| Property | Type | Meaning |
|---|---|---|
| `Status` | `EAssetStatus` (byte at +0x3C1) | Disabled (0), PlayInEditor (1), Development (2), Released (3). The byte order is inferred from the order of the enum names in the exe. The class default is Released: the constructor at VA 0x1401973D0 does `mov byte [rbx+0x3C1],3`. |
| `Entitlement` | String | Empty means free. If the string is numeric, it is a Steam DLC app id that the local Steam client must report as owned. |
| `AppRole` | String | Empty means free. Otherwise it must match one of the login roles (`IsPlayerInAppRole`: space-separated, any match). **Earlier notes called this "EntitlementRole" and misread the alpha-beta shirts as free.** `alpha-beta` is in `AppRole`, not `Entitlement`. |

- **What each character can choose.** One list Blueprint per character, `Characters/<Char>/Customization/<Char>Customizations` (a subclass of `AvailablePawnCustomizations`). Each holds `CustomizationSections[]` = {slot `ECustomizationType`, groups[] {GroupName text, Assets[]}}. The parts have no names of their own: the UI shows the group name, such as "Long", "Warrior" or "Ronin".
- **Filtering.** `Get Available Groups` runs native `CustomizationLibrary::FilterByAvailability` over those lists:
  - an item passes only if `Status` is Released (or PlayInEditor under an extra condition that a shipping client is not expected to meet);
  - and `IsEntitlementAvailable(Entitlement)` is true;
  - and `AppRole` is empty or held by the player.
  - Addresses are in `docs/CLASSIC.md`, under Cosmetics.
- **Roles reach the client from the login reply.** The backend already returns `roles` for Classic logins, so adding a role is a backend-only change.

## Inventory

### Outfits: 876 selectable parts on 12 characters

- These counts are of parts placed in each character's list, excluding `CA_Empty` (the "None" option, which is in every list).
- There are 892 `CA_*` files. The 16 not in any list are all parent or template classes of listed parts, so there are no true orphans.
- There are also 5 `SkinCustomizationSet` default skins. They cannot be selected and are not gated.

| Character | Parts | | Character | Parts |
|---|---|---|---|---|
| FemaleOutcast | 147 | | MaleWanderer | 59 |
| MaleBiker | 141 | | FemaleAnalyst | 57 |
| FemaleOracle | 69 | | MaleScoundrel | 56 |
| MaleCynic | 64 | | MaleRanger | 48 |
| FemaleAchiever, MaleReject, MaleSlacker | 63 each | | FemaleTrickster | 45 |

- **Slots used:** Hair, Head, Face, Shoulders, Harness, Torso, Arms, Hands, UpperWaist, LowerWaist, Holster, Legs, Feet, FeetAcc, ArmorTorso and ArmorHead.
- **Unused slots:** `ECustomizationType` also has Skin and Theme, but no list uses them.

### Gated outfits

| Gate | Items |
|---|---|
| DLC 784750 | Founders Pack shirt A "Advanced Scout", `CA_<Char>_FoundersPackTShirt_A` ×12 (inherits from `CA_Entitlement_FoundersPackTShirt_A`) |
| DLC 784710 | Founders shirt B "Lousy Shirt" ×12 |
| DLC 784730 | Founders shirt C "Papaya Cool" ×12 |
| DLC 784760 | Founders shirt D "Party Starter" ×12 |
| DLC 784820 | Founders shirt E "Bling Shirt" ×12 |
| AppRole `alpha-beta` | `CA_<Char>_AlphaBetaTShirt_A` and `_B` ×12 (textures `T_AlphaBeta_CCCA`, `T_AlphaBetaFrat_Logo`) |

`alpha-beta` is the only `AppRole` value on any cosmetic.

### Unreleased outfit parts

These are in a character's list but have a non-Released `Status`, so a shipping client filters them out:

- **Ronin set, MaleWanderer, group "Ronin"**, status PlayInEditor: `CA_MaleRonin_Boots_A/B/C`, `CA_MaleRonin_Harness_A`, `CA_MaleRonin_Pants_A`, `CA_MaleRonin_Jacket_A/B/C`. This is the clearest "unreleased cosmetic" in Classic.
- `CA_MaleCynic_FacialHair_A`, status Development.

### Gestures (25)

- **Definitions.** `Animations/BaseMale/GestureData` holds 23 `GestureDataAsset` files. `AvailableGestures` lists 22 shared gestures plus the TeamUp HighFive. There are also DataTables `SharedGestures` (24 rows) and `TeamUpGestures` (1 row), which `GestureComponent` uses. It was not determined which source the gesture wheel reads.
- **Per-character lists are empty.** The 11 `AvailableGestures_<Char>` Blueprints are empty overrides. MaleScoundrel has none.
- **No gesture has an `AppRole`.** DLC-gated gestures:

| DLC id | Gesture |
|---|---|
| 811670 | Bow |
| 784780 | Brush It |
| 784800 | Gotta Dance |
| 784790 | Oh Brother |
| 784770 | Slow Clap |
| 811660 | Beckon (DataTable only) |

- **Not in `AvailableGestures`.** Beckon and BatterUp (ungated) exist only in the DataTable and have no data asset.
- **Animations.** The 1p and 3p montages exist for every gesture.

### Name plates and icons

- **Name plate.** `PlayerNameWidget` picks `MAT_GoldNamePlate` or `MAT_SilverNamePlate` from `IsDLCInstalled("812320")` and `IsDLCInstalled("784810")`, which are supporter DLCs. Which id gives gold was not decoded.
- **Icons.** There is no player-icon or banner system. `UI/Icons/*` is plain UI art.

## Hidden and dev content

### Maps (71 umaps)

The cooked `DefaultGame.ini` has a `[FrontendMaps]` dev list. BR's list is empty, and BR has none of these maps. Classic's list:

1. `Whiteboxes/CnC_Whitebox`
2. `Whiteboxes/Combat_Whitebox`
3. `Whiteboxes/GameMode_Whitebox`
4. `LaCuna/LaCuna`
5. `Test_Will/Test_GameMode_Whitebox`
6. `Test_Will/Crater`
7. `Test_Mike/Layouts/Circle01`

The exe has native `GetFrontendMaps`, but no Blueprint calls it, so this is an unwired dev map picker. There is also a hidden `DebugLoadWhitebox` button on FrontendHUD, already noted in CLASSIC.md.

| Map | What it is | Game mode |
|---|---|---|
| `Test_Will/Crater` | A full second island: 21 `Crater_*` sublevels (Env, Game_Loot, Game_Hupia, Game_Spawns, Game_Compounds…) plus the `Ben_Layout_02` pre-game and post-game levels. **The best candidate for a second playable map.** | default `Gamemode_Survival` |
| `Test_Will/Test_GameMode_Whitebox`, `Test_Mike/Layouts/Circle01`, `Whiteboxes/GameMode_Whitebox` | Persistent whiteboxes that stream the Ben_Layout_02 pre-game and post-game levels | default / `Gamemode_Survival` / `GameMode_Day` |
| `Whiteboxes/Combat_Whitebox` | Single level | **`Gamemode_Survival_Respawns`**, a respawn mode not used elsewhere |
| `Whiteboxes/CnC_Whitebox` | Single level | default |
| `Sanctuary` | Near-empty StarterContent room; it is `ServerDefaultMap` (also in BR) | default |
| `Crater_Depreciated`, `Test_Ben/*`, `MainMenu2_*`, `LaCuna_*` | Sublevels, not standalone | |

- **Dangling references.** These are referenced but are not in the pak: `Whiteboxes/Social_Whitebox`, `Maps/MainMenu`, `Test_Ben/Ben_Layout_02`, `Highrise`.
- **Runtime map list.** The only one is KV `UE_CLIENT_CUSTOM_MATCHES_MAPS`. Adding `Crater` there is the cheapest test of whether it plays.
- **Untested.** Whether any of these maps loads or plays has not been tested.

### Cheats and debug

- **Exec commands.** These are registered in the exe:
  - `Cheat`, `GiveItem`, `GiveAmmo`, `GiveTreasure`, `ListItems`;
  - `Revive`, `Hupia`, `Infection`, `Purgatory`, `ChangeTeam`, `Run`, `ForceMatchStart`, `ToggleMatchTimer`;
  - `ToggleInfiniteAmmo`, `ToggleInfiniteClip`, `ToggleTakeDamageDontDie`;
  - `GameMode`/`GM`, `GameChoiceActivate/Help/List/Random` (`GCA`/`GCL`).
  - BR adds `SpawnPawn(s)`, `SetShield`, `IsBRDrop` and `ListPawns`.
- **How they are gated.** Each does its work when it has authority and otherwise sends `ServerCheat`. There is no role or KV check. On a client they depend on `ServerCheat`, which stock 4.12 compiles out of Shipping. This was not verified here (about 70% likely dead).
- **Key bindings.** `DefaultInput.ini` `DebugExecBindings`: `I` infinite ammo, `Ctrl+I` infinite clip, `T` match timer, `Ctrl+T` force match start. Whether Shipping dispatches them was not verified.
- **Console variables.** `blackbird.debugItemActions`, `blackbird.debugDisplayAIPaths` and others are in the exe. The console class is `UOutpostConsole`, opened with Tilde.
- **Director (spectator) gates:**
  - the in-game toggle (Insert) needs role `BBL_player` or `dev`;
  - the frontend utility-bar button needs `dev` or `qa`;
  - the frontend Director screen needs the player's name in KV `UE_CLIENT_DIRECTOR_USERS`.
  - The backend already grants `dev` to `classic.DEV_ACCOUNTS`.

### KV switches we do not set

Classic reads about 45 `UE_CLIENT_*` keys and no `UE_SERVER_*` keys. These are not set in `data/kv-classic/runtime-1.json`:

| Group | Keys |
|---|---|
| Interesting for a revival | `ALLOW_NIGHT_RAIN`, `NIGHT_CHANCE`, `STORM_CHANCE`; `ENABLE_STUCK_TELEPORT` (Shift+Ctrl+P); `FRONTEND_LEADERBOARDS`, `MAX_RANK_TO_DISPLAY`, `RATING_REQUIRED_MATCHES`, and the per-leaderboard `UE_CLIENT_<board>_ELO_K_FACTOR` / `_RATING_GOLD_START` / `_REQUIRED_GAMES` family; `FAME_WEIGHTINGS`, `FAME_REQUIRED_DELTA`, `INTRO_REQUIRED_RAW_FAME`; `NEW_POST_GAME_SHOW`; `SHOW_LOADING_NAMES`; `SHOW_TUTORIAL_BUTTON`, `TUTORIAL_URL_*`; `DIRECTOR_USERS` |
| Other | `MINIMUM_REQUIRED_BUILD`, `VOTING_FLARE_OPTION_DISABLEDLIST`, `DEBUG_LEVEL_INFO`, `FEEDBACK_TYPE`, `MM_LANGUAGES`, `MM_PLATFORM_LANGUAGE_MAPPING`, `ACTOR_SPAWN_TUNING`, `CLIPPING_ENABLED`, `EXTRACTION_DISABLEDLIST`, `EXTRACTION_MAX_ATTRACTED_HUPIA`, `GSDK_PREFERRED_ENCODER`, `HEARTBEAT_LENGTH` |
| In the exe with no Blueprint reader | `BATTLEYE_KICK_ENABLED`, `FEEDBACK_RADIUS_*`, `WEB_API_KEY` |

Unset keys fall back to Blueprint defaults, which were not extracted.

### Roles the client checks

| Role | Effect |
|---|---|
| `testserver` | matchmaking |
| `dev`, `qa` | Director button |
| `BBL_player`, `dev` | Director toggle |
| `alpha-beta` | cosmetics |
| `app-user` | in the exe |
| KV `*_ROLES` | custom matches and duos |

No `admin`, `director` or `alpha` checks exist.

### Other unused or dev content

- **Dev folders:** `Test_Will`, `Test_Ben`, `Test_Mike`, `Whiteboxes`, `Blueprints/Test`, `Developers`, `Outsource/Mindwalk`, `Outsource/Lakshya`, `Environment/Objects/Blockout` (254 files), `EpicAssetStore`, `Materials_Master/Debug`.
- **Classic-only gameplay assets, not in BR:**
  - 18 `SupplyDrop_Vote_*` actors and 14 loot tables, reached only through the flare-vote system (KV `UE_CLIENT_VOTING_ENABLED`);
  - a **Branch** melee weapon, referenced only by two whitebox maps;
  - Jeep props and `Cofino_Prototype`;
  - test actors `ShootingTarget`, `TargetPracticeDummy`, `MeasuringStick` and `ItemSpawner`.

## Comparison with BR

| | BR (main branch) | Classic |
|---|---|---|
| Cosmetic model | Store items (`StoreItemDefinitions`, 208 rows: `o_*`, `g_*`, `i_*`, `l_*`…), whole-body outfit sets (`MasterCustomizationSetList`) | Per-character part lists of `CA_*` assets |
| Ownership | `inventory.licenses` in the app-account reply (`data/cosmetics.json`, `appAccount()`) | `Status` + Steam DLC + app role, all client-side. No `/api/app/*/inventory`, store or season strings in the exe |
| Outfit assets | 20 folders under `Characters/Character_Outfits/*` (Aloha, Astronaut, Bear, Biker, Bowler, Cowboy, Dinosaur, Fighterjock, Fox, Lumberjack, Ninja, PayayaSuperHero, PirateCaptain, Ranger, Rocker, SeaCaptain, Spy, Survivalist, Trucker, TShirts) | **None of them** |
| Engine | 4.12.5, built 2018-10-12, `//blackbird/branches/prod` 5.57771 | 4.12.5, built 2018-09-11, `//blackbird/branches/sosclassic` 5.57767 |

So Classic does not read the BR inventory format, and no BR item id exists in Classic. Granting BR ids to Classic accounts would do nothing.

## Porting BR cosmetics to Classic: feasibility

**For it:**

- Both games run the same engine (4.12.5) and use pak v3 with unversioned cooked packages. A BR asset is a format Classic's loader can read. This is not a cross-engine port.
- A UE4 client mounts every `*.pak` in `Content/Paks` (a `_P` suffix wins on conflicts), so a mod pak with BR's `Characters/Character_Outfits/<X>` folders would mount.
- BR outfit meshes import `/Game/Characters/BaseMale/Base_Skeleton` and `/Game/Characters/FirstPerson/Base_FirstPerson_Skeleton`, and Classic's characters use the same paths.
  - The two `Base_Skeleton` files differ only in animation slot names. All the bone names match.
  - Bone order and transforms were not compared.

**Against it:**

1. **Classic's UI cannot see them.** Classic only lists `CA_*` parts named in its 12 `<Char>Customizations` Blueprints. Showing a BR outfit means authoring new `OutfitCustomizationAsset` Blueprints and **replacing those 12 list Blueprints** in an override pak.
   - That needs a UE 4.12.5 editor project with stub C++ classes whose reflected layout matches Classic's natives (`OutfitCustomizationAsset`, `AvailablePawnCustomizations`, the customization component and its enums), then cooking.
   - This is the bulk of the work.
2. **Body mismatch.** BR outfits are whole-body sets built for BR's base male and female bodies. Classic's 12 characters are distinct bodies assembled from per-slot parts with restriction tags and skin regions. Expect clipping and hidden-skin problems. It would need per-character fitting or "outfit replaces all slots" logic that Classic does not have.
3. **Dependencies.** Every BR master material, texture and physics asset the outfits reference must come along, and must not collide with Classic assets of the same path but different content. This is unchecked; the skeleton itself is one such collision.
4. **Everyone needs the mod pak.** That includes the headless hosts, because the host loads the pawn's parts. A player without it sees missing meshes or fails to join. BR assets would also be redistributed inside the mod pak.

**Recommendation:**

- **Now:**
  - ship the backend `alpha-beta` role (done);
  - add a DLC-check hook (`IsEntitlementAvailable` → true, `IsDLCInstalled` → true) to the **client-mod DLL**. That unlocks the 5 Founders shirts, 6 DLC gestures and the name plate. It is cosmetic only and needs no Steam emulation.
  - Optionally let the same hook pass `Status` PlayInEditor so the Ronin set appears.
- **BR outfits: do not start a full port.** If the lead wants it, timebox a proof of concept:
  - a UE 4.12.5 stub project;
  - one BR outfit (for example Ninja) as `CA_*` parts on one Classic character;
  - an override `MaleBikerCustomizations`;
  - test it in a local match with the mod pak on client and host.
  - Only continue if it renders without clipping and the stub classes cook compatibly.

## On-screen texts: the "sostest" label and the boot shutdown notice

Both come from the pak and the exe config, not from the backend. Nothing the backend or KV serves changes either of them today. Derived with `tools/kismet_dis.py` on `FrontendHUD.uasset` and `HUDFunctionLibrary.uasset` (extracted read-only) and the cooked `DefaultEngine.ini`. Not yet tested in a running client.

### 1. The text at the bottom of the screen ("SOSTEST v.…")

- **Widget.** `BuildVersionText`, a TextBlock in `Blueprints/UI/Frontend/MainMenu/FrontendHUD`. `FrontendHUD.UpdateBuildInfoText` sets it with `HUDFunctionLibrary.GetProjectVersionText`. The in-game `InGameHUDWidget` calls the same function.
- **How the string is built** (`GetProjectVersionText`, Blueprint bytecode):
  - `WebServicesEnv == "prod"` → `"{HERO_APP_ID} v.{PROJECT_VERSION}"`.
  - Any other env → `"{HERO_APP_ID} v.{PROJECT_VERSION} {WEB_ENV} {PROJECT_BRANCH} "`.
  - `HERO_APP_ID` is `ToUpper(OutpostOnlineLibrary.GetHeroAppID())`, so the text is upper-case: `SOSTEST v.<project version>`. The version and branch come from `HelperLibrary.GetProjectVersion/GetProjectBranch` (native; the project version is 5.57767.0 for Classic).
- **Where `sostest` comes from.** The cooked `DefaultEngine.ini` section `[WebServicesConfig]`: `HeroAppId="sostest"` (`WebServicesEnv="prod"`).
- **Do not change `HeroAppId` to change this text.** The same value is the `app-id` the client sends in the login and in every request header, which the backend uses to pick Classic (`isClassic`, per-app KV, matchmaker). `HUDFunctionLibrary.IsTestServer` is `GetHeroAppID()=="sostest"` and drives the matchmaking gate in `UpdateTestServerAvailable` (see CLASSIC.md). A user-side `Engine.ini` override of `[WebServicesConfig] HeroAppId` probably works as a mechanism, but it would need the backend to accept a second app id and would change the gate. It is not recommended.

**Options, best first:**

1. **Backend/KV: none exists.** No KV key or reply field feeds this text.
2. **Client-mod hook (recommended).** After a `FrontendHUD_C` (and `InGameHUDWidget_C`) widget is constructed, find its `BuildVersionText` TextBlock and call its `SetText` with `FText("OG SOS Revival")` (reflection / `ProcessEvent`, no byte patching). Re-apply after `UpdateBuildInfoText` runs again, or hook that function so the original call is skipped.
3. **Override pak.** A `_P` patch pak with `HUDFunctionLibrary.uasset` whose two Format literals are replaced by `"OG SOS Revival"` padded to the same length. Needs same-length edits (package and export sizes stay valid), and the override order of paks in a 4.12.5 client has not been verified. It is a modified game file, so it is not committed anywhere.

### 2. The boot message ("SOS servers will permanently shut down on Monday, November 12, 2018…")

- **Widget.** `ShutdownOverlay` in `Blueprints/UI/Frontend/MainMenu/FrontendHUD`: an overlay with a title, a body and a button, `ShutdownConfirmation`.
- **Text.** Literal strings in the asset, not localized (there is no entry in `Game.locres`, which has only the alpha-tester thank-you strings):
  - title: `Thank you for playing SOS!`
  - body: `SOS servers will permanently shut down on Monday, November 12, 2018. We want to thank you for being a part of the SOS community and giving our game a chance.`
  - In the same asset: `Version 1.0000.0`, a design-time placeholder for `BuildVersionText`.
- **How it is chosen.** Nothing in code shows it: the bytecode only has the dismiss handler. `ShutdownConfirmation.OnClicked` runs `ExecuteUbergraph_FrontendHUD(50)`, which sets `ShutdownOverlay` visibility to Collapsed. So the overlay is shown by the widget's design-time default on every frontend load, with no KV, role or date check. It is unrelated to the KV MOTD (`FrontEndDailyMessage` widget) and to `UE_CLIENT_INACTIVE_SERVER_TEXT` (`FormatInactiveServerText`, used for the server-inactive text).
- **Backend/KV: none exists.** Neither `UE_CLIENT_MOTD` nor any other key touches it.

**Options, best first:**

1. **Client-mod hook (recommended).** When a `FrontendHUD_C` instance exists, call its generated handler `BndEvt__ShutdownConfirmation_K2Node_ComponentBoundEvent_725_OnClicked__DelegateSignature` through `ProcessEvent`. That is exactly the click, so the overlay collapses and the player never sees it. If the welcome text should show instead, find the two TextBlock children of `ShutdownOverlay` (the text blocks are anonymous in the tree, so walk the overlay's children) and `SetText` them to our title and welcome before the dismiss, or leave the overlay open and only replace the text.
2. **Override pak.** Patch `FrontendHUD.uasset`: replace the body literal (158 characters) by our welcome text padded with spaces to the same length (and likewise the title), or flip the overlay's default visibility byte. Same caveats as above.
3. **Backend: not possible.** There is nothing to serve.

### Who should make the change

- **Client-mod session** (`client-mod`): the hook for both texts. It is the only route that needs no game file edits, and it has to find the `FrontendHUD_C` and `InGameHUDWidget_C` instances at menu load. It would also be a good place to put the DLC and Status hook from "Porting BR cosmetics".
- **Backend sessions: nothing to do.** In particular, do not change the `sostest` app id.
