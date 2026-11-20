# Inventory format: evidence and best guesses

> The "Confirmed from disassembly" section below supersedes the guesses further down ("JSON field names", "Proposed replies"). Those are kept only as history; proposals 1-3 there are all wrong.

## Confirmed from disassembly

Method: `tools/re_xrefs.py` finds UTF-16 literals and their RIP-relative `lea` references; `tools/re_dis.py` disassembles a range (capstone) and annotates literals. All RVAs are relative to image base 0x140000000 of SOS-Win64-Shipping.exe (Steam build).

### How the client parses
The storefront replies are parsed with UE4's `FJsonSerializable` machinery, not hand-written `GetStringField` calls. Each reply type has a `Serialize(Serializer, bFlat)` function that makes one virtual call per field on the reader (`FJsonSerializerReader`, vtable RVA 0x1fbf1a8). Reader slots, from the reader implementations:

| vtable slot | JSON type required (EJson) | meaning |
|---|---|---|
| +0x60 | 2 String | FString field |
| +0x68 | 4 Boolean | bool field |
| +0x70 / +0x78 | 3 Number | uint32 / int32 field |
| +0x80 (fn 0x1873f0) | 6 Object | nested serializable object |
| +0x98 (fn 0x185300) | 5 Array | array whose elements are read with `FJsonValue::AsString` (fn 0x502fa0), i.e. `TArray<FString>` |

Lenient behaviour: a field that is missing or has the wrong JSON type is silently skipped (default value kept, no error). This is why `"inventory":["id",...]` produced no error and no unlock: `inventory` must be an Object, and an Array there is just ignored.

The body is passed straight to `FJsonSerializable::FromJson` (fn 0x15d810) after the HTTP status check (fn 0xe76d00 / 0xe77000). Neither contains a `data` or `version` literal. **The fields are read from the top level of the reply; there is no `data` envelope and no `version` requirement for these endpoints.** Extra fields are ignored. A parse failure only logs `...Request failed parsing JSON response`.

### App-account reply (GetAppAccount, ReconcileAppAccount, and the PurchaseStoreItem reply)
Reconcile (handler 0x1a6a8d0, log string xref 0x1a6aa80), GetAppAccount (xref 0x1a67fd0) and Purchase (0x1a6a325) all construct the same four-part object (vtables 0x26750e0 AppAccount, 0x2675088 Inventory, 0x2674ed0 Wallet, 0x2674f18 Season):

| object (Serialize fn) | field, accessor, JSON type |
|---|---|
| AppAccount (0x1a6add0) | `inventory` +0x80 Object; `season` +0x80 Object; `gifts` +0x98 Array of String |
| Inventory (0x1a6ae60) | `wallet` +0x80 Object; `licenses` +0x98 Array of String |
| Wallet (0x1a6b1d0) | `coins_paid` int32 Number; `coins_free` int32 Number |
| Season (0x1a6b070) | `sp`, `xp`, `free-tier`, `premium-tier`, `season-id`, `level`, `xp-boost`, `current-level-xp`, `current-free-tier-sp`, `next-level-xp`, `next-free-tier-sp`: all int32 Numbers (note `season-id` is a number, not a string). `has-premium`: Boolean. `start-date`, `end-date`: String (format not determined) |

So `licenses` is a flat array of store item id strings nested inside `inventory`, next to `wallet`. There is no per-item object, count, or keyed map anywhere in this reply. (The word `coins` is not in the wallet: it is a field of the "last-level-up" struct, below.)

Working example granting two cosmetics and one license (plain ids, strings in `licenses`):
```json
{
  "inventory": {
    "wallet": { "coins_paid": 0, "coins_free": 99999 },
    "licenses": ["o_plain_a_m", "g_wave", "l_founder_1"]
  },
  "season": {
    "sp": 0, "xp": 0, "free-tier": 0, "premium-tier": 0, "season-id": 1, "level": 50,
    "xp-boost": 0, "has-premium": true,
    "start-date": "2018-01-01T00:00:00Z", "end-date": "2030-01-01T00:00:00Z",
    "current-level-xp": 0, "current-free-tier-sp": 0, "next-level-xp": 1, "next-free-tier-sp": 1
  },
  "gifts": []
}
```
Cosmetic ids and license ids go in the same `inventory.licenses` list; that list is the only id-bearing field in the account reply besides `gifts`.

### Other replies (same mechanism)
- GetAppRewards (xref 0x1a685a7): top object `{ "changes": Object, "last-level-up": Object }` (Serialize 0x1a6aff0). `changes` (0x1a6aee0) = `{ "wallet-delta": Wallet-object {coins_paid, coins_free}, "new-licenses": [String] }`. `last-level-up` (0x1a6af60) = `{ "sp": int, "level": int, "coins": int }`.
- Season/XP grant replies: `{ "points": Object {xp-base, xp-bonus : int; xp-source : String}, "metadata": Object }` (Serialize 0x1a6ac60 / 0x1a6abd0) and `{ "xp": int, "sp": int }` (0x1a6ad50, 0x1a6ace0).
- Purchase request body: `{ "store-item-id": "<id>" }` (0x1a6b240). Requests go to `%s/api/app/%s/store/items/purchase`, `.../store/items/view`, `.../season/%s`, `.../inventory/%s`, with header `Authorization: Token <token>`.
- Store view (`GET .../store/items/view`, handler xref 0x1a68bee, Serialize 0x20bd20): top-level Array under the narrow-ASCII key `store-view` (read with array lookup, type 5), each element an Object (0x20bc60) with `coin-cost` int, `store-item-id` String, `store-section` String, `start-date` String, `end-date` String, `pack-item-ids` [String]. There is no owned/licensed flag in a store-view entry: ownership comes only from `inventory.licenses` in the account reply.

### Confidence and open points
- High: the object/array shapes, field names and Number/String/Bool types above (read directly from the reader slots and their type checks), top-level (no `data`/`version`) parsing, silent-skip behaviour.
- Medium: that every cosmetic id (outfits `o_*`, gestures `g_*`, icons `i_*`) is unlocked by being present in `inventory.licenses`. I did not trace the consumer of the parsed list (the Blueprint `IsItemOwnedById` path); it is the only string list in the account object, so it is the only candidate.
- Unknown: exact date string format for `start-date`/`end-date`; whether the client re-requests account state after reconcile and overwrites what you serve; whether `gifts` entries are item ids (they are plain strings); the reconcile request body.


Derived from the client pak and exe (read-only). No game assets are included here, only ids and field names.

## Item ids (high confidence)
- `/Game/Blueprints/Storefront/StoreItemDefinitions` is a DataTable (row struct `StoreItemDefinition`) with 208 rows. Row names are the item ids. Fields: Cost, Licensed, Type (`EStoreItemType`), Rarity, Amount, Name, Description, ThumbnailSmall/Large, StoreItemIds, Id, StartDate, EndDate.
- Counts: outfit 126, icon 31, gesture 24, reward 8, license 7, xp_boost 5, sp_boost 3, coin 2, pack 1, pass 1.
- Evidence the row name is the key everywhere: `Season_01_Tiers` (`PremiumItemIds`/`FreeItemIds`) and the `r_day_*` Reward rows (`StoreItemIds`) refer to row names; outfit variant tables (`DT_*Variants`.StoreId, e.g. `o_ninja_a`) plus `MasterCustomizationSetList.StoreIdSuffix` (`_m`/`_f`) give exactly the `o_ninja_a_m` rows. Blueprint functions `GetStoreItemById`, `IsItemOwnedById`, `ItemId`, `ItemIds` take these strings.
- Prefixes: `o_` outfit (suffix `_m`/`_f`), `g_` gesture, `i_` icon, `l_` license, `c_` coin pack, `x_` XP boost, `p_` season-point boost, `r_` daily reward, `s01_` season pass/bundle.
- Full list: `data/cosmetics.json`.

## JSON field names (high confidence, shape unknown)
Reply fields parsed by `FOutpostStorefront` (UTF-16 literals in the exe, in order of use): `coins_paid`, `sp`, `xp`, `free-tier`, `premium-tier`, `season-id`, `level`, `xp-boost`, `has-premium`, `current-level-xp`, `current-free-tier-sp`, `next-level-xp`, `next-free-tier-sp`, `wallet`, `licenses`, `inventory`, `season`, `gifts`, `coins`, `changes`, `last-level-up`, `xp-base`, `xp-bonus`, `xp-source`, `points`. Nearby blueprint/C++ names: `NewLicenses`, `Items`, `ItemIds`, `ItemId`, `Item`, `Count`, `Amount`, `ResourceKey`, `Gifts`.
`coins` is almost certainly a key inside `wallet`; `xp-*`/`sp`/`level`/`*-tier` live inside `season`.
Not determinable from static strings: whether `inventory` is an array or an object, and the entry shape. The exe stores no literals that disambiguate.

## Proposed replies (wrap as `{"version":N,"data":{...}}`, also mirror top-level)
1. (about 40%) ids as an array, licenses separate:
```json
{"wallet":{"coins":99999},"licenses":["l_starter_1","l_early_purchase","l_alphabeta_1","l_founder_1","l_founder_2","l_founder_3","l_steam_slowclap"],"inventory":["o_ninja_a_m","g_wave","i_skull"],"season":{"season-id":"s01","has-premium":true,"level":50}}
```
2. (about 30%) object keyed by id with count: `"inventory":{"o_ninja_a_m":1,"g_wave":1}`.
3. (about 30%) array of objects: `"inventory":[{"id":"o_ninja_a_m","count":1}]` (alternate key names: `item-id`, `ItemId`, `item`, `amount`).
Test order: 1, then 2, then 3. Watch the client log for LogAppInventoryManager / LogOutpostStorefront parse errors and the Customize screen to see which works. Licenses are probably needed separately (`IsItemLicensed`, items with `Licensed=true` such as `s01_pass`, `l_*`).
Season/reward entries (`unseen-reward`, `gifts`) are item ids, probably the same shape as inventory.

## Notes
- Cosmetics a normal account owns: grant all `outfit`, `gesture`, `icon`. `reward`, `coin`, `xp_boost`, `sp_boost`, `pack` are consumables or season bundles and probably belong in wallet/season, not inventory.
- Tools: `tools/pak_list.py` (index/extract), `tools/uasset_dump.py`, `tools/dt_dump.py` (DataTable rows), `tools/build_cosmetics.py`.
